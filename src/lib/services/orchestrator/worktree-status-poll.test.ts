import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  subscribeWorktreeStatus,
  __resetWorktreeStatusPollForTest,
  __runWorktreeStatusPassForTest,
  BASE_POLL_MS,
  IDLE_POLL_MS,
} from './worktree-status-poll';
import type { WorktreeInfo, WorktreeStatus } from './worktree-manager';

function worktree(path: string): WorktreeInfo {
  return {
    path,
    branch: 'spacron/neo-1',
    baseBranch: 'main',
    baseCommit: 'aaaaaaa1',
    createdAt: 0,
  } as WorktreeInfo;
}

/** One reader shared by the tests: counts calls and returns a settable status. */
function reader() {
  const calls: string[] = [];
  let next: WorktreeStatus | null = { changedFiles: 0, branch: 'spacron/neo-1' };
  const fn = vi.fn(async (w: WorktreeInfo) => {
    calls.push(w.path);
    return next;
  });
  return {
    fn,
    calls,
    set(status: WorktreeStatus | null) { next = status; },
  };
}

describe('shared worktree status poller', () => {
  let git: ReturnType<typeof reader>;

  beforeEach(() => {
    vi.useFakeTimers();
    git = reader();
    __resetWorktreeStatusPollForTest(git.fn);
  });

  afterEach(() => {
    __resetWorktreeStatusPollForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('asks git once for a worktree several badges are watching', async () => {
    // The case this module exists for: the same worktree rendered in more than
    // one place must not multiply the git calls.
    const seenA: Array<WorktreeStatus | null> = [];
    const seenB: Array<WorktreeStatus | null> = [];
    subscribeWorktreeStatus(worktree('/wt/a'), () => 0, (s) => seenA.push(s));
    subscribeWorktreeStatus(worktree('/wt/a'), () => 0, (s) => seenB.push(s));

    await __runWorktreeStatusPassForTest();

    expect(git.fn).toHaveBeenCalledTimes(1);
    expect(seenA).toEqual([{ changedFiles: 0, branch: 'spacron/neo-1' }]);
    expect(seenB).toEqual([{ changedFiles: 0, branch: 'spacron/neo-1' }]);
  });

  it('keeps the fast cadence while the agent is producing output', async () => {
    let produced = 0;
    subscribeWorktreeStatus(worktree('/wt/a'), () => produced, () => {});
    await __runWorktreeStatusPassForTest();
    expect(git.fn).toHaveBeenCalledTimes(1);

    // The agent keeps working: every base interval earns another read.
    for (let i = 1; i <= 3; i += 1) {
      produced += 500;
      vi.advanceTimersByTime(BASE_POLL_MS);
      await __runWorktreeStatusPassForTest();
      expect(git.fn).toHaveBeenCalledTimes(i + 1);
    }
  });

  it('backs off to the idle cadence for an agent that has gone quiet', async () => {
    // A silent agent cannot be changing its worktree, so re-reading it every 4s
    // is pure cost. The interval doubles until it reaches the idle ceiling.
    subscribeWorktreeStatus(worktree('/wt/a'), () => 0, () => {});
    await __runWorktreeStatusPassForTest();
    expect(git.fn).toHaveBeenCalledTimes(1);

    // A fresh subscribe stays at the base cadence for its second read (the first
    // reading is always "new"), and only then starts backing off.
    vi.advanceTimersByTime(BASE_POLL_MS);
    await __runWorktreeStatusPassForTest();
    expect(git.fn).toHaveBeenCalledTimes(2);

    // Nothing changed and the agent said nothing, so the interval is now 8s —
    // another 4s must NOT earn a read.
    vi.advanceTimersByTime(BASE_POLL_MS);
    await __runWorktreeStatusPassForTest();
    expect(git.fn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(BASE_POLL_MS);
    await __runWorktreeStatusPassForTest();
    expect(git.fn).toHaveBeenCalledTimes(3);

    // Keep it quiet for a long stretch and count the reads: at the idle ceiling
    // this is a handful, where the old per-badge timer would have made ~75.
    const before = git.fn.mock.calls.length;
    for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += BASE_POLL_MS) {
      vi.advanceTimersByTime(BASE_POLL_MS);
      await __runWorktreeStatusPassForTest();
    }
    const reads = git.fn.mock.calls.length - before;
    expect(reads).toBeLessThanOrEqual(Math.ceil((5 * 60_000) / IDLE_POLL_MS) + 1);
  });

  it('returns to the fast cadence as soon as the agent produces output again', async () => {
    let produced = 0;
    subscribeWorktreeStatus(worktree('/wt/a'), () => produced, () => {});
    await __runWorktreeStatusPassForTest();

    // Go quiet long enough to reach a long interval.
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(IDLE_POLL_MS);
      await __runWorktreeStatusPassForTest();
    }
    const afterIdle = git.fn.mock.calls.length;

    // The agent speaks again: the very next due poll resets the interval, so a
    // base interval later there is another read.
    produced += 1000;
    vi.advanceTimersByTime(IDLE_POLL_MS);
    await __runWorktreeStatusPassForTest();
    expect(git.fn.mock.calls.length).toBe(afterIdle + 1);

    produced += 1000;
    vi.advanceTimersByTime(BASE_POLL_MS);
    await __runWorktreeStatusPassForTest();
    expect(git.fn.mock.calls.length).toBe(afterIdle + 2);
  });

  it('notifies only when the status actually changes', async () => {
    const seen: Array<WorktreeStatus | null> = [];
    let produced = 0;
    subscribeWorktreeStatus(worktree('/wt/a'), () => produced, (s) => seen.push(s));
    await __runWorktreeStatusPassForTest();
    expect(seen).toHaveLength(1);

    produced += 100;
    vi.advanceTimersByTime(BASE_POLL_MS);
    await __runWorktreeStatusPassForTest();
    expect(seen).toHaveLength(1); // same numbers — no re-render

    git.set({ changedFiles: 3, branch: 'spacron/neo-1' });
    produced += 100;
    vi.advanceTimersByTime(BASE_POLL_MS);
    await __runWorktreeStatusPassForTest();
    expect(seen).toEqual([
      { changedFiles: 0, branch: 'spacron/neo-1' },
      { changedFiles: 3, branch: 'spacron/neo-1' },
    ]);
  });

  it('stops reading a worktree once its last watcher is gone', async () => {
    const stop = subscribeWorktreeStatus(worktree('/wt/a'), () => 0, () => {});
    await __runWorktreeStatusPassForTest();
    const before = git.fn.mock.calls.length;

    stop();
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(IDLE_POLL_MS);
      await __runWorktreeStatusPassForTest();
    }
    expect(git.fn.mock.calls.length).toBe(before);
  });

  it('serves a remounted watcher from cache instead of re-reading git', async () => {
    // A pane remount (stage retile, project switch) must not cost a git call —
    // that churn is exactly what made the old per-badge effect expensive.
    const stop = subscribeWorktreeStatus(worktree('/wt/a'), () => 0, () => {});
    await __runWorktreeStatusPassForTest();
    expect(git.fn).toHaveBeenCalledTimes(1);
    stop();

    const seen: Array<WorktreeStatus | null> = [];
    subscribeWorktreeStatus(worktree('/wt/a'), () => 0, (s) => seen.push(s));
    await __runWorktreeStatusPassForTest();

    expect(seen).toEqual([{ changedFiles: 0, branch: 'spacron/neo-1' }]);
    expect(git.fn).toHaveBeenCalledTimes(1);
  });

  it('reads each distinct worktree once per due pass', async () => {
    subscribeWorktreeStatus(worktree('/wt/a'), () => 0, () => {});
    subscribeWorktreeStatus(worktree('/wt/b'), () => 0, () => {});
    subscribeWorktreeStatus(worktree('/wt/c'), () => 0, () => {});
    await __runWorktreeStatusPassForTest();
    expect(git.calls.slice().sort()).toEqual(['/wt/a', '/wt/b', '/wt/c']);
  });
});
