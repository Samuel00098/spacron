import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// vi.mock factories are hoisted above the module body, so the fns they close over
// have to be hoisted too.
const { getWorktreeDelta, stageWorktreeChanges } = vi.hoisted(() => ({
  getWorktreeDelta: vi.fn(),
  stageWorktreeChanges: vi.fn(),
}));

vi.mock('./worktree-manager', () => ({
  getWorktreeDelta,
  stageWorktreeChanges,
  stageBaseline: (w: { lastStagedCommit?: string | null; baseCommit: string }) =>
    w.lastStagedCommit?.trim() || w.baseCommit,
}));

import { get } from '$lib/stores/storeCompat';
import {
  initWorktreeReconciler,
  stopWorktreeReconciler,
  reconcileNow,
  pendingWorktreeWork,
  stageWorktreeNow,
  type TrackedWorktree,
} from './worktree-reconciler';
import type { WorktreeInfo } from './worktree-manager';

const BASE = 'aaaaaaa1';
const TIP = 'bbbbbbb2';

function worktree(over: Record<string, unknown> = {}) {
  return {
    path: '/proj/.spacron/worktrees/spacron-alex-1',
    branch: 'spacron/alex-1',
    baseBranch: 'main',
    baseCommit: BASE,
    createdAt: 0,
    ...over,
  } as TrackedWorktree['worktree'];
}

function tracked(over: Partial<TrackedWorktree> = {}): TrackedWorktree {
  return { projectId: 'p1', agentName: 'Alex', worktree: worktree(), live: true, ...over };
}

function delta(over: Record<string, unknown> = {}) {
  return { head: TIP, dirtyFiles: 0, committedFiles: 3, upToDate: false, pendingFiles: 3, ...over };
}

type PersistFn = (projectId: string, worktreePath: string, patch: Partial<WorktreeInfo>) => void;

let persist: Mock<PersistFn>;
let list: TrackedWorktree[];

function start(opts?: { autoStage?: boolean }) {
  persist = vi.fn<PersistFn>();
  initWorktreeReconciler({
    list: () => list,
    persist,
    autoStage: () => opts?.autoStage ?? true,
  });
}

/**
 * Move wall-clock time forward WITHOUT firing pending timers. `advanceTimersByTime`
 * would also run the reconciler's own poll interval, giving extra passes that make
 * quiet-period assertions read backwards.
 */
function elapse(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** Two passes with the clock past the quiet period, which is how the reconciler
 *  confirms the worktree has stopped changing before it snapshots. */
async function settleAndReconcile() {
  await reconcileNow();
  elapse(5000);
  await reconcileNow();
}

beforeEach(() => {
  vi.useFakeTimers();
  list = [tracked()];
  getWorktreeDelta.mockReset();
  stageWorktreeChanges.mockReset();
});

afterEach(() => {
  stopWorktreeReconciler();
  vi.useRealTimers();
});

describe('the scenarios that used to lose work', () => {
  it('stages a worktree whose task already finished, with no completion event', async () => {
    // The regression this whole mechanism exists for: a `complete` task is a
    // terminal state, so no later turn could ever re-raise the old prompt.
    // The reconciler never consults task status at all.
    getWorktreeDelta.mockResolvedValue(delta());
    stageWorktreeChanges.mockResolvedValue({
      success: true, message: 'ok', conflicted: false, conflictedFiles: [],
      stagedCommit: TIP, stagedFiles: 3, upToDate: false,
    });
    start();

    await settleAndReconcile();

    expect(stageWorktreeChanges).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('p1', worktree().path, {
      lastStagedCommit: TIP,
      stageConflict: false,
    });
  });

  it('stages a worktree that no thread or task is bound to', async () => {
    // Cleared thread / brand-new thread in the same worktree. The entry is tracked
    // purely because the worktree exists, so nothing is thread-dependent.
    list = [tracked({ agentName: 'Iris', live: false })];
    getWorktreeDelta.mockResolvedValue(delta({ committedFiles: 1, pendingFiles: 1 }));
    stageWorktreeChanges.mockResolvedValue({
      success: true, message: 'ok', conflicted: false, conflictedFiles: [],
      stagedCommit: TIP, stagedFiles: 1, upToDate: false,
    });
    start();

    await settleAndReconcile();

    expect(stageWorktreeChanges).toHaveBeenCalledTimes(1);
  });

  it('surfaces outstanding work even when auto-staging is off', async () => {
    getWorktreeDelta.mockResolvedValue(delta());
    start({ autoStage: false });

    await settleAndReconcile();

    const rows = get(pendingWorktreeWork);
    expect(Object.keys(rows)).toHaveLength(1);
    expect(rows[worktree().path].pendingFiles).toBe(3);
    expect(rows[worktree().path].agentName).toBe('Alex');
    // Visible, but never staged behind the user's back.
    expect(stageWorktreeChanges).not.toHaveBeenCalled();
  });
});

describe('not staging a half-written file', () => {
  it('waits for the worktree to stop changing before staging', async () => {
    getWorktreeDelta.mockResolvedValue(delta({ dirtyFiles: 2 }));
    start();

    // First sighting establishes the quiet window — nothing staged yet.
    await reconcileNow();
    expect(stageWorktreeChanges).not.toHaveBeenCalled();

    // Still inside the window.
    elapse(1000);
    await reconcileNow();
    expect(stageWorktreeChanges).not.toHaveBeenCalled();
  });

  it('restarts the wait when the agent writes again', async () => {
    getWorktreeDelta.mockResolvedValue(delta({ dirtyFiles: 2 }));
    start();
    await reconcileNow();

    // The agent keeps working: a different dirty count resets the timer.
    elapse(5000);
    getWorktreeDelta.mockResolvedValue(delta({ dirtyFiles: 5 }));
    await reconcileNow();
    expect(stageWorktreeChanges).not.toHaveBeenCalled();
  });
});

describe('the staged baseline', () => {
  it('does not advance the baseline when a stage fails, so work stays outstanding', async () => {
    getWorktreeDelta.mockResolvedValue(delta());
    stageWorktreeChanges.mockResolvedValue({
      success: false, message: 'git exploded', conflicted: false, conflictedFiles: [],
      stagedCommit: TIP, stagedFiles: 0, upToDate: false,
    });
    start();

    await settleAndReconcile();

    expect(persist).not.toHaveBeenCalled();
    expect(get(pendingWorktreeWork)[worktree().path]).toBeTruthy();
  });

  it('pauses auto-staging after a conflict instead of re-applying the same patch', async () => {
    getWorktreeDelta.mockResolvedValue(delta());
    stageWorktreeChanges.mockResolvedValue({
      success: false, message: 'overlaps your edits', conflicted: true,
      conflictedFiles: ['src/app.ts'], stagedCommit: TIP, stagedFiles: 2, upToDate: false,
    });
    const onConflict = vi.fn();
    persist = vi.fn<PersistFn>();
    initWorktreeReconciler({ list: () => list, persist, autoStage: () => true, onConflict });

    await settleAndReconcile();
    expect(stageWorktreeChanges).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('p1', worktree().path, { stageConflict: true });
    expect(onConflict).toHaveBeenCalledTimes(1);

    // The owner now carries the conflict flag. Further passes must not retry.
    list = [tracked({ worktree: worktree({ stageConflict: true }) })];
    elapse(30000);
    await reconcileNow();
    await reconcileNow();
    expect(stageWorktreeChanges).toHaveBeenCalledTimes(1);

    const row = get(pendingWorktreeWork)[worktree().path];
    expect(row.conflicted).toBe(true);
    expect(row.conflictedFiles).toEqual(['src/app.ts']);
  });

  it('backs off after a non-conflict failure instead of retrying every poll', async () => {
    // `git apply --index` refuses the whole patch when the user holds an
    // uncommitted edit to a file the agent also touched — no markers, no `U`
    // entries, so it arrives as conflicted:false and the conflict pause never
    // engaged. It was retried on every 4s poll, forever and silently.
    getWorktreeDelta.mockResolvedValue(delta());
    stageWorktreeChanges.mockResolvedValue({
      success: false,
      message: 'Your own uncommitted changes to src/app.css block bringing in ...',
      conflicted: false, conflictedFiles: [], stagedCommit: TIP, stagedFiles: 0, upToDate: false,
    });
    const onError = vi.fn();
    persist = vi.fn<PersistFn>();
    initWorktreeReconciler({ list: () => list, persist, autoStage: () => true, onError });

    await settleAndReconcile();
    expect(stageWorktreeChanges).toHaveBeenCalledTimes(1);
    // Reported to the user — the old behaviour said nothing at all.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toContain('src/app.css');

    // Immediately after, and one poll later, the same patch must not be re-applied.
    await reconcileNow();
    elapse(4000); // one poll interval
    await reconcileNow();
    expect(stageWorktreeChanges).toHaveBeenCalledTimes(1);

    // Past the backoff it tries again — some causes do clear on their own — but
    // without re-toasting, so a blocked worktree can't spam.
    elapse(30_000);
    await reconcileNow();
    expect(stageWorktreeChanges).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);

    // Work is still outstanding and the baseline never moved.
    expect(persist).not.toHaveBeenCalled();
    expect(get(pendingWorktreeWork)[worktree().path]).toBeTruthy();
  });

  it('lets an explicit Bring in bypass the backoff', async () => {
    getWorktreeDelta.mockResolvedValue(delta());
    stageWorktreeChanges.mockResolvedValue({
      success: false, message: 'blocked', conflicted: false, conflictedFiles: [],
      stagedCommit: TIP, stagedFiles: 0, upToDate: false,
    });
    start();

    await settleAndReconcile();
    expect(stageWorktreeChanges).toHaveBeenCalledTimes(1);

    // The user fixes the blocker and presses the button — no invisible timer.
    stageWorktreeChanges.mockResolvedValue({
      success: true, message: 'Staged 2 file(s)', conflicted: false, conflictedFiles: [],
      stagedCommit: TIP, stagedFiles: 2, upToDate: false,
    });
    const result = await stageWorktreeNow('p1', worktree());
    expect(result.ok).toBe(true);
    expect(stageWorktreeChanges).toHaveBeenCalledTimes(2);
  });

  it('clears a row and records the tip when git reports nothing outstanding', async () => {
    getWorktreeDelta.mockResolvedValue(delta({ upToDate: true, committedFiles: 0, pendingFiles: 0 }));
    start();

    await settleAndReconcile();

    expect(get(pendingWorktreeWork)).toEqual({});
    expect(stageWorktreeChanges).not.toHaveBeenCalled();
  });
});

describe('stageWorktreeNow', () => {
  it('records the new baseline and clears the conflict flag on success', async () => {
    getWorktreeDelta.mockResolvedValue(delta());
    stageWorktreeChanges.mockResolvedValue({
      success: true, message: 'Staged 3 file(s)', conflicted: false, conflictedFiles: [],
      stagedCommit: TIP, stagedFiles: 3, upToDate: false,
    });
    start();

    const result = await stageWorktreeNow('p1', worktree({ stageConflict: true }));

    expect(result.ok).toBe(true);
    expect(persist).toHaveBeenCalledWith('p1', worktree().path, {
      lastStagedCommit: TIP,
      stageConflict: false,
    });
  });

  it('says nothing moved when there was nothing to bring in', async () => {
    // A press with nothing outstanding still succeeds, and the caller used to
    // show it as a green "changes are in Source Control" — announcing an arrival
    // that never happened. `upToDate` is what lets it say so honestly.
    stageWorktreeChanges.mockResolvedValue({
      success: true, message: 'Already up to date — nothing new to stage.',
      conflicted: false, conflictedFiles: [], stagedCommit: TIP, stagedFiles: 0, upToDate: true,
    });
    start();

    const result = await stageWorktreeNow('p1', worktree());

    expect(result).toMatchObject({ ok: true, upToDate: true });
  });

  it('does not mark a real stage as up to date', async () => {
    stageWorktreeChanges.mockResolvedValue({
      success: true, message: 'Staged 3 file(s)', conflicted: false, conflictedFiles: [],
      stagedCommit: TIP, stagedFiles: 3, upToDate: false,
    });
    start();

    const result = await stageWorktreeNow('p1', worktree());

    expect(result).toMatchObject({ ok: true, upToDate: false });
  });

  it('reports a conflict without advancing the baseline', async () => {
    stageWorktreeChanges.mockResolvedValue({
      success: false, message: 'overlaps your edits', conflicted: true,
      conflictedFiles: ['a.ts'], stagedCommit: TIP, stagedFiles: 1, upToDate: false,
    });
    start();

    const result = await stageWorktreeNow('p1', worktree());

    expect(result).toMatchObject({ ok: false, conflicted: true });
    expect(persist).toHaveBeenCalledWith('p1', worktree().path, { stageConflict: true });
    expect(persist).not.toHaveBeenCalledWith(
      'p1', worktree().path, expect.objectContaining({ lastStagedCommit: expect.anything() }),
    );
  });
});
