import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backendInvoke } = vi.hoisted(() => ({ backendInvoke: vi.fn() }));
vi.mock('$lib/services/backend', () => ({ backendInvoke }));

import { reclaimWorktree, stageBaseline, deriveTaskBranch, type WorktreeInfo } from './worktree-manager';

const BASE = 'aaaaaaa1';
const TIP = 'bbbbbbb2';

function worktree(over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: '/proj/.spacron/worktrees/spacron-alex-1',
    branch: 'spacron/alex-1',
    baseBranch: 'main',
    baseCommit: BASE,
    createdAt: 0,
    ...over,
  };
}

/** Route each backend command to a canned reply. */
function backend(handlers: Record<string, unknown | (() => unknown)>) {
  backendInvoke.mockImplementation(async (cmd: string) => {
    if (!(cmd in handlers)) throw new Error(`unexpected command: ${cmd}`);
    const h = handlers[cmd];
    return typeof h === 'function' ? (h as () => unknown)() : h;
  });
}

const CLEAN = { head: TIP, dirty_files: 0, committed_files: 0, up_to_date: true };
const DIRTY = { head: TIP, dirty_files: 2, committed_files: 4, up_to_date: false };

// Block body on purpose: `mockReset()` returns the mock, and vitest treats a value
// returned from `beforeEach` as a teardown callback — so the concise form ends up
// invoking the mock with no arguments once the test finishes.
beforeEach(() => {
  backendInvoke.mockReset();
});

describe('stageBaseline', () => {
  it('uses the fork point until something has been staged', () => {
    expect(stageBaseline(worktree())).toBe(BASE);
  });

  it('uses the last staged tip afterwards, so a delta is never staged twice', () => {
    expect(stageBaseline(worktree({ lastStagedCommit: TIP }))).toBe(TIP);
  });

  it('ignores a blank marker rather than sending git an empty revision', () => {
    expect(stageBaseline(worktree({ lastStagedCommit: '   ' }))).toBe(BASE);
    expect(stageBaseline(worktree({ lastStagedCommit: null }))).toBe(BASE);
  });
});

describe('reclaimWorktree', () => {
  it('removes a worktree that git confirms holds nothing outstanding', async () => {
    backend({
      workspace_git_worktree_delta: CLEAN,
      workspace_git_remove_worktree: undefined,
    });

    const outcome = await reclaimWorktree('p1', worktree());

    expect(outcome).toEqual({ removed: true, staged: 0 });
    expect(backendInvoke).toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('stages outstanding work first, then removes', async () => {
    let staged = false;
    backend({
      // Clean only after the stage has run — mirrors real git.
      workspace_git_worktree_delta: () => (staged ? CLEAN : DIRTY),
      workspace_git_stage_worktree: () => {
        staged = true;
        return {
          success: true, message: 'ok', conflicted: false, conflicted_files: [],
          staged_commit: TIP, staged_files: 4, up_to_date: false,
        };
      },
      workspace_git_remove_worktree: undefined,
    });

    const outcome = await reclaimWorktree('p1', worktree());

    expect(outcome).toEqual({ removed: true, staged: 4 });
  });

  it('KEEPS the worktree when staging conflicts', async () => {
    backend({
      workspace_git_worktree_delta: DIRTY,
      workspace_git_stage_worktree: {
        success: false, message: 'overlaps your edits', conflicted: true,
        conflicted_files: ['src/app.ts'], staged_commit: TIP, staged_files: 1, up_to_date: false,
      },
    });

    const outcome = await reclaimWorktree('p1', worktree());

    expect(outcome).toMatchObject({ removed: false, reason: 'conflict' });
    expect(backendInvoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('KEEPS the worktree when the agent wrote more while we were staging', async () => {
    // The last check before an irreversible delete has to be a fresh read, not the
    // stage result — otherwise a write landing mid-stage is deleted unseen.
    backend({
      workspace_git_worktree_delta: DIRTY,
      workspace_git_stage_worktree: {
        success: true, message: 'ok', conflicted: false, conflicted_files: [],
        staged_commit: TIP, staged_files: 4, up_to_date: false,
      },
    });

    const outcome = await reclaimWorktree('p1', worktree());

    expect(outcome).toMatchObject({ removed: false, reason: 'pending' });
    expect(backendInvoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('KEEPS the worktree when git errors, rather than assuming it is empty', async () => {
    backend({
      workspace_git_worktree_delta: DIRTY,
      workspace_git_stage_worktree: () => {
        throw new Error('git not found');
      },
    });

    const outcome = await reclaimWorktree('p1', worktree());

    expect(outcome).toMatchObject({ removed: false });
    expect(backendInvoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('re-checks against the newly staged tip, not the stale baseline', async () => {
    // Regression guard: comparing the post-stage state against the ORIGINAL
    // baseline reports the just-staged work as still pending, so a fully staged
    // worktree would never be reclaimed and disk use would grow forever.
    const sinceCommits: string[] = [];
    backendInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'workspace_git_worktree_delta') {
        sinceCommits.push(args.sinceCommit as string);
        return sinceCommits.length === 1 ? DIRTY : CLEAN;
      }
      if (cmd === 'workspace_git_stage_worktree') {
        return {
          success: true, message: 'ok', conflicted: false, conflicted_files: [],
          staged_commit: TIP, staged_files: 4, up_to_date: false,
        };
      }
      return undefined;
    });

    const outcome = await reclaimWorktree('p1', worktree());

    expect(outcome).toEqual({ removed: true, staged: 4 });
    expect(sinceCommits).toEqual([BASE, TIP]);
  });
});

describe('deriveTaskBranch', () => {
  it('keeps the branch readable and unique per task', () => {
    const a = deriveTaskBranch('ot_1700000000_abc123', 'Backend work');
    expect(a).toBe('spacron/backend-work-abc123');
    expect(deriveTaskBranch('ot_1700000000_zzz999', 'Backend work')).not.toBe(a);
  });
});
