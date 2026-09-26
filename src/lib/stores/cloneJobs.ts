import { writable } from '$lib/stores/storeCompat';
import type { Project } from '$lib/types/workspace';

/** One background clone, as the bottom-right progress card shows it. */
export type CloneJob = {
  id: string;
  /** `owner/repo`, for the card's headline. */
  label: string;
  status: 'running' | 'failed';
  /** git's current phase ("Receiving objects", …), or a placeholder before git reports one. */
  phase: string;
  /** Overall 0–100, or null while git hasn't reported a percentage yet. */
  percent: number | null;
  error?: string;
  /** Re-run the same clone after a failure. */
  retry: () => void;
};

export const cloneJobs = writable<CloneJob[]>([]);

type CloneRunner = (url: string, parentDir: string, cloneId: string) => Promise<Project>;

type ProgressEvent = { cloneId: string; phase: string; percent: number | null };

// Resolvers for "the backend has validated and git is running", keyed by job id.
const startWaiters = new Map<string, () => void>();
let listening: Promise<unknown> | null = null;

function ensureListener() {
  if (!listening) {
    listening = import('@tauri-apps/api/event').then(({ listen }) =>
      listen<ProgressEvent>('clone-progress', ({ payload }) => {
        startWaiters.get(payload.cloneId)?.();
        startWaiters.delete(payload.cloneId);
        patch(payload.cloneId, (j) => ({
          ...j,
          phase: payload.phase,
          // Never let the bar step backwards on a late or out-of-order event.
          percent: payload.percent == null ? j.percent : Math.max(j.percent ?? 0, payload.percent),
        }));
      }),
    );
  }
  return listening;
}

function patch(id: string, fn: (j: CloneJob) => CloneJob) {
  cloneJobs.update((list) => list.map((j) => (j.id === id ? fn(j) : j)));
}

export function dismissCloneJob(id: string) {
  cloneJobs.update((list) => list.filter((j) => j.id !== id));
}

/**
 * Start a clone in the background. `started` settles once the backend has
 * validated the request and git is actually running — or rejects if it was
 * refused up front (bad URL, folder already exists), so the dialog can show
 * that error and stay open. After that, progress and failure live on the job
 * card, and the card clears itself once `run` has opened the project.
 */
export function startCloneJob(
  url: string,
  parentDir: string,
  label: string,
  run: CloneRunner,
): { started: Promise<void> } {
  const id = `clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let started = false;

  const startedPromise = new Promise<void>((resolve, reject) => {
    void ensureListener().then(() => {
      startWaiters.set(id, () => {
        started = true;
        cloneJobs.update((list) => [
          ...list,
          {
            id,
            label,
            status: 'running',
            phase: 'Starting',
            percent: null,
            retry: () => {
              dismissCloneJob(id);
              retryInBackground(url, parentDir, label, run);
            },
          },
        ]);
        resolve();
      });

      run(url, parentDir, id).then(
        () => dismissCloneJob(id),
        (e) => {
          startWaiters.delete(id);
          if (!started) {
            reject(e);
            return;
          }
          patch(id, (j) => ({ ...j, status: 'failed', error: errorMessage(e) }));
        },
      );
    });
  });

  return { started: startedPromise };
}

/** Re-run a clone from its card. There is no dialog to show an up-front
 *  refusal in any more, so that lands on a failed card of its own. */
function retryInBackground(url: string, parentDir: string, label: string, run: CloneRunner) {
  startCloneJob(url, parentDir, label, run).started.catch((e) => {
    const id = `clone-failed-${Date.now()}`;
    cloneJobs.update((list) => [
      ...list,
      {
        id,
        label,
        status: 'failed',
        phase: '',
        percent: null,
        error: errorMessage(e),
        retry: () => {
          dismissCloneJob(id);
          retryInBackground(url, parentDir, label, run);
        },
      },
    ]);
  });
}

function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'The clone failed.';
}
