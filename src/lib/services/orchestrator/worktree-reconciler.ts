import { writable, get } from '$lib/stores/storeCompat';
import {
  getWorktreeDelta,
  stageWorktreeChanges,
  stageBaseline,
  type WorktreeInfo,
  type WorktreeDelta,
} from './worktree-manager';

/**
 * Watches every live agent worktree and keeps the main checkout in step with it.
 *
 * With auto-staging on it stages work in as it lands. With it off (the default —
 * Orca's review-wall model) it instead keeps the "Agent changes" list populated
 * with everything waiting to be reviewed, and fires the first-work hook so each
 * branch gets named from what the agent actually did.
 *
 * ## Why this exists
 *
 * Staging used to be triggered by an *event* — "an agent's turn finished" — and
 * that made real work invisible in ordinary situations:
 *
 * - More messages in the same thread: the task had already reached `complete`,
 *   a terminal state, so no later turn could ever raise the prompt again.
 * - A cleared or brand-new thread in the same worktree: no task was bound to the
 *   worktree at all, so nothing was watching it.
 * - A missed 12-second toast, a restart, or an agent that kept writing after its
 *   turn was marked done: same result — changes on disk, nobody looking.
 *
 * The changes always lived in git; only the *knowledge that they existed* lived in
 * ephemeral thread state. So this reconciler ignores thread and task state
 * entirely and asks git one question on a timer: does this worktree hold anything
 * the main checkout hasn't been given? That question is always answerable, which
 * is why every case above is covered by construction rather than by special-casing.
 *
 * Turn-completion events still fire `reconcileNow` so staging feels instant — but
 * they are an optimisation, never the guarantee.
 */

/** One worktree the reconciler is watching, and who it belongs to. */
export interface TrackedWorktree {
  projectId: string;
  /** Display name for the owning agent, e.g. "Alex". */
  agentName: string;
  worktree: WorktreeInfo;
  /** True while the owning agent's pane is still alive. */
  live: boolean;
}

/** Outstanding work in one worktree, as surfaced to the UI. */
export interface PendingWork {
  projectId: string;
  agentName: string;
  worktree: WorktreeInfo;
  branch: string;
  /** Files waiting to reach the main checkout. */
  pendingFiles: number;
  /** True when a previous stage left conflict markers for the user to resolve. */
  conflicted: boolean;
  conflictedFiles: string[];
  live: boolean;
}

/**
 * Everything currently waiting to be staged, keyed by worktree path. Drives the
 * "Agent changes" list. Empty when the main checkout has caught up with every
 * agent, which is the steady state when auto-staging is on.
 */
export const pendingWorktreeWork = writable<Record<string, PendingWork>>({});

/** How often to ask git. Matches the worktree badge's existing poll cadence. */
const POLL_MS = 4000;

/**
 * How long a worktree must be free of new writes before we snapshot it. Prevents
 * capturing a file the agent is in the middle of writing — the reason auto-staging
 * is per-quiet-period rather than truly continuous.
 */
const QUIET_MS = 2500;

/**
 * Backoff after a stage that failed *without* conflicting. A conflict sets
 * `stageConflict` and stops retrying outright, but a plain failure had no brake at
 * all: the most common cause is the user holding an uncommitted edit to a file the
 * agent also touched, which makes `git apply --index` refuse the whole patch and
 * does not clear until the user acts. Without a brake that patch was retried on
 * every 4s poll, indefinitely and silently.
 */
const FAILURE_BACKOFF_MS = [POLL_MS * 2, 15_000, 60_000, 300_000];

type Providers = {
  /** Every worktree worth watching, from both the session- and task-owned paths. */
  list: () => TrackedWorktree[];
  /** Persist a new baseline (and conflict state) back onto whoever owns it. */
  persist: (projectId: string, worktreePath: string, patch: Partial<WorktreeInfo>) => void;
  /** Whether auto-staging is switched on. */
  autoStage: () => boolean;
  /**
   * The agent's first real work has landed in this worktree. Fired once per
   * worktree; the owner typically names the branch from that work, Orca-style,
   * and is expected to persist `renamedFromWork` so it never fires again. May
   * be async — the pass waits for it so a rename lands before this pass stages
   * or surfaces the work under the old name.
   */
  onFirstWork?: (entry: TrackedWorktree, delta: WorktreeDelta) => void | Promise<void>;
  onStaged?: (work: PendingWork, stagedFiles: number) => void;
  onConflict?: (work: PendingWork, message: string) => void;
  /**
   * A stage failed for a reason that isn't a conflict. Reported once per run of
   * failures, not per retry — otherwise a blocked worktree would toast forever.
   */
  onError?: (work: PendingWork, message: string) => void;
};

let providers: Providers | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Last observed head per worktree, with when it changed — drives the quiet check. */
const lastSeen = new Map<string, { head: string; dirty: number; at: number }>();
/** Worktrees currently being staged, so a slow stage can't overlap the next tick. */
const inFlight = new Set<string>();
/** Non-conflict stage failures per worktree: how many in a row, and when to retry. */
const failures = new Map<string, { count: number; retryAt: number }>();
/** Worktrees whose first-work hook has fired — the rename guard's in-memory half. */
const firstWorkFired = new Set<string>();

export function initWorktreeReconciler(p: Providers): void {
  providers = p;
  if (timer) return;
  timer = setInterval(() => void reconcileNow(), POLL_MS);
}

export function stopWorktreeReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  providers = null;
  lastSeen.clear();
  inFlight.clear();
  failures.clear();
  firstWorkFired.clear();
  pendingWorktreeWork.set({});
}

/**
 * Forget a worktree we're no longer tracking (removed, or its agent is gone), so
 * its row disappears from the pending list and its quiet-period state is dropped.
 */
export function forgetWorktree(worktreePath: string): void {
  lastSeen.delete(worktreePath);
  inFlight.delete(worktreePath);
  failures.delete(worktreePath);
  pendingWorktreeWork.update((all) => {
    if (!(worktreePath in all)) return all;
    const next = { ...all };
    delete next[worktreePath];
    return next;
  });
}

/**
 * Run one reconcile pass immediately. Safe to call from turn-completion events and
 * from the poll timer — overlapping calls are collapsed.
 */
export async function reconcileNow(): Promise<void> {
  if (!providers || running) return;
  running = true;
  try {
    const tracked = providers.list();
    const seenPaths = new Set(tracked.map((t) => t.worktree.path));

    // Drop rows for worktrees that no longer exist.
    for (const path of Object.keys(get(pendingWorktreeWork))) {
      if (!seenPaths.has(path)) forgetWorktree(path);
    }

    for (const entry of tracked) {
      await reconcileOne(entry);
    }
  } finally {
    running = false;
  }
}

async function reconcileOne(entry: TrackedWorktree): Promise<void> {
  const p = providers;
  if (!p) return;
  let { projectId, worktree, agentName, live } = entry;
  const path = worktree.path;
  if (inFlight.has(path)) return;

  const delta = await getWorktreeDelta(projectId, worktree);
  if (!delta) return; // worktree gone or git unavailable — leave state untouched

  if (delta.upToDate) {
    forgetWorktree(path);
    return;
  }

  // First real work in this worktree — hand it to the owner once, so it can
  // name the branch from what the agent actually did (Orca-style) before the
  // work is surfaced or staged. The in-memory set plus the persisted
  // `renamedFromWork` flag (which the owner sets) make this exactly once per
  // worktree, not once per poll.
  if (!worktree.renamedFromWork && p.onFirstWork && !firstWorkFired.has(path)) {
    firstWorkFired.add(path);
    try {
      await p.onFirstWork(entry, delta);
      // The hook may have renamed the branch (same path, new branch). Re-read
      // so this pass surfaces and stages under the NEW name, not the old one.
      const fresh = p.list().find((e) => e.worktree.path === path);
      if (fresh) {
        entry = fresh;
        projectId = fresh.projectId;
        worktree = fresh.worktree;
        agentName = fresh.agentName;
        live = fresh.live;
      }
    } catch (err) {
      console.warn('First-work rename hook failed:', err);
    }
  }

  const work: PendingWork = {
    projectId,
    agentName,
    worktree,
    branch: worktree.branch,
    pendingFiles: delta.pendingFiles,
    conflicted: worktree.stageConflict === true,
    conflictedFiles: [],
    live,
  };
  // Keep any conflicted-file list a previous stage recorded. A plain poll has no
  // way to recompute it, and blindly spreading `work` over the row wiped the very
  // detail the user needs to go and resolve.
  pendingWorktreeWork.update((all) => ({
    ...all,
    [path]: { ...all[path], ...work, conflictedFiles: all[path]?.conflictedFiles ?? [] },
  }));

  // A worktree whose last stage conflicted waits for the user — re-applying the
  // same patch would just recreate the same conflict every few seconds.
  if (worktree.stageConflict) return;
  if (!p.autoStage()) return;

  // Only stage once the worktree has stopped changing, so a snapshot never
  // captures a half-written file.
  const now = Date.now();

  // A previous stage failed without conflicting. Hold off until the backoff
  // elapses — but do retry, because some causes (a lost index.lock race) clear on
  // their own, unlike a conflict.
  const failed = failures.get(path);
  if (failed && now < failed.retryAt) return;
  const prev = lastSeen.get(path);
  const changed = !prev || prev.head !== delta.head || prev.dirty !== delta.dirtyFiles;
  if (changed) {
    lastSeen.set(path, { head: delta.head, dirty: delta.dirtyFiles, at: now });
    return;
  }
  if (now - prev.at < QUIET_MS) return;

  inFlight.add(path);
  try {
    const result = await stageWorktreeChanges(projectId, worktree);
    if (result.upToDate) {
      p.persist(projectId, path, { lastStagedCommit: result.stagedCommit });
      forgetWorktree(path);
      return;
    }
    if (result.success) {
      // Record the new baseline before anything else: if this is lost, the same
      // delta is staged twice.
      p.persist(projectId, path, { lastStagedCommit: result.stagedCommit, stageConflict: false });
      lastSeen.delete(path);
      forgetWorktree(path);
      p.onStaged?.(work, result.stagedFiles);
      return;
    }

    // Failed. Leave the baseline alone — the delta is not represented in the main
    // checkout, so it must stay outstanding.
    if (result.conflicted) {
      p.persist(projectId, path, { stageConflict: true });
      pendingWorktreeWork.update((all) => ({
        ...all,
        [path]: { ...all[path], ...work, conflicted: true, conflictedFiles: result.conflictedFiles },
      }));
      p.onConflict?.(work, result.message);
      return;
    }

    // Failed for some other reason. Back off so the same patch isn't re-applied on
    // every poll, and tell the user once — the commonest cause is their own
    // uncommitted edit to a file the agent touched, which blocks the whole patch
    // and needs them to act. Silence here left the work stuck with no signal.
    recordFailure(path);
    if (failures.get(path)?.count === 1) p.onError?.(work, result.message);
  } catch (err) {
    recordFailure(path);
    console.warn('Worktree reconcile failed:', err);
  } finally {
    inFlight.delete(path);
  }
}

/** Note a non-conflict failure and schedule the next attempt further out. */
function recordFailure(path: string): void {
  const count = (failures.get(path)?.count ?? 0) + 1;
  const step = FAILURE_BACKOFF_MS[Math.min(count - 1, FAILURE_BACKOFF_MS.length - 1)];
  failures.set(path, { count, retryAt: Date.now() + step });
}

/**
 * Stage one worktree on demand (the "Stage" button, and the manual path when
 * auto-staging is off). Clears a previous conflict flag so resolving conflicts and
 * pressing Stage again resumes normal operation.
 */
export async function stageWorktreeNow(
  projectId: string,
  worktree: WorktreeInfo,
): Promise<{ ok: boolean; message: string; conflicted: boolean; upToDate: boolean }> {
  const p = providers;
  const path = worktree.path;
  if (inFlight.has(path)) {
    return { ok: false, message: 'Already bringing it in…', conflicted: false, upToDate: false };
  }
  // An explicit press means "try now" — drop any auto-stage backoff so the user
  // isn't waiting out a timer they can't see, and so a fixed blocker takes effect
  // immediately.
  failures.delete(path);
  inFlight.add(path);
  try {
    const result = await stageWorktreeChanges(projectId, worktree);
    if (result.success) {
      p?.persist(projectId, path, { lastStagedCommit: result.stagedCommit, stageConflict: false });
      lastSeen.delete(path);
      forgetWorktree(path);
      // `upToDate` is carried through rather than folded into success: git did
      // what it was asked, but nothing moved, and the caller must not announce
      // files arriving in Source Control that were already there.
      return { ok: true, message: result.message, conflicted: false, upToDate: result.upToDate };
    }
    if (result.conflicted) p?.persist(projectId, path, { stageConflict: true });
    return {
      ok: false,
      message: result.message,
      conflicted: result.conflicted,
      upToDate: false,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      conflicted: false,
      upToDate: false,
    };
  } finally {
    inFlight.delete(path);
  }
}

/** Exposed for tests: what baseline a stage would use. */
export const __stageBaseline = stageBaseline;
