import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backendInvoke } = vi.hoisted(() => ({ backendInvoke: vi.fn() }));
vi.mock('$lib/services/backend', () => ({ backendInvoke }));

import {
  createTaskWorktree,
  worktreeUnavailableReason,
  reclaimWorktree,
  stageBaseline,
  deriveThreadBranch,
  deriveFirstWorkBranch,
  renameTaskWorktree,
  mergeTaskWorktree,
  sweepAgentBranches,
  type WorktreeInfo,
} from './worktree-manager';

const BASE = 'aaaaaaa1';
const TIP = 'bbbbbbb2';

function worktree(over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: '/proj/.spacron/worktrees/spacron-alex-1',
    branch: 'thread/alex-1',
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

  it.each([1, 2])('keeps the checkout if verification read %s fails', async (failingRead) => {
    let reads = 0;
    backend({
      workspace_git_worktree_delta: () => {
        if (++reads === failingRead) throw new Error('Git unavailable');
        return CLEAN;
      },
      workspace_git_remove_worktree: undefined,
    });
    await expect(reclaimWorktree('p1', worktree())).resolves.toMatchObject({ removed: false, reason: 'error' });
    expect(backendInvoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('automatic cleanup does not bring in outstanding work', async () => {
    backend({ workspace_git_worktree_delta: DIRTY });
    await expect(reclaimWorktree('p1', worktree(), { stagePending: false })).resolves.toMatchObject({ removed: false, reason: 'pending' });
    expect(backendInvoke).not.toHaveBeenCalledWith('workspace_git_stage_worktree', expect.anything());
    expect(backendInvoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('reports failed disk removal instead of forgetting the checkout', async () => {
    backend({ workspace_git_worktree_delta: CLEAN, workspace_git_remove_worktree: () => { throw new Error('locked'); } });
    await expect(reclaimWorktree('p1', worktree())).resolves.toMatchObject({ removed: false, reason: 'error' });
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

describe('mergeTaskWorktree', () => {
  it('separates "nothing moved" from a real merge', async () => {
    // `success` alone can't carry this: git succeeds either way. Callers used to
    // read success as "merged" and announced a merge on the one press that did
    // nothing at all.
    backend({
      workspace_git_merge_worktree: {
        success: true,
        message: "Nothing to merge — 'thread/alex-1' holds nothing your checkout doesn't already have.",
        conflicted: false,
        already_up_to_date: true,
        merged_commit: TIP,
      },
    });

    const result = await mergeTaskWorktree('p1', worktree(), false);

    expect(result).toMatchObject({ success: true, alreadyUpToDate: true, mergedCommit: TIP });
  });

  it('returns the merged tip so the reconciler stops calling merged work outstanding', async () => {
    backend({
      workspace_git_merge_worktree: {
        success: true,
        message: "Branch 'thread/alex-1' merged successfully.",
        conflicted: false,
        already_up_to_date: false,
        merged_commit: TIP,
      },
    });

    const result = await mergeTaskWorktree('p1', worktree(), false);

    expect(result.alreadyUpToDate).toBe(false);
    expect(result.mergedCommit).toBe(TIP);
  });

  it('treats an older backend that omits the new fields as a real merge', async () => {
    // The remote backend can be a version behind. Absent fields must not make a
    // genuine merge look like a no-op.
    backend({
      workspace_git_merge_worktree: { success: true, message: 'merged', conflicted: false },
    });

    const result = await mergeTaskWorktree('p1', worktree(), false);

    expect(result.alreadyUpToDate).toBe(false);
    expect(result.mergedCommit).toBe('');
  });
});

describe('deriveThreadBranch', () => {
  it('keeps the branch readable and unique per thread', () => {
    const a = deriveThreadBranch('ot_1700000000_abc123', 'Backend work');
    expect(a).toBe('thread/backend-work-abc123');
    expect(deriveThreadBranch('ot_1700000000_zzz999', 'Backend work')).not.toBe(a);
  });
});

describe('deriveFirstWorkBranch', () => {
  it('names the branch from the first commit subject, stripping the conventional prefix', () => {
    const result = deriveFirstWorkBranch(worktree(), {
      subject: 'fix: login redirect',
      file: 'src/login.tsx',
    });
    expect(result).toBe('thread/login-redirect-1');
  });

  it('falls back to the first changed file when the agent never commits', () => {
    const result = deriveFirstWorkBranch(worktree(), { file: 'src/components/LoginForm.tsx' });
    expect(result).toBe('thread/login-form-1');
  });

  it('ignores our own snapshot commit as a name source', () => {
    const result = deriveFirstWorkBranch(worktree(), {
      subject: 'spacron: snapshot uncommitted agent work',
      file: 'src/api.ts',
    });
    expect(result).toBe('thread/api-1');
  });

  it('returns null when there is nothing nameable yet', () => {
    expect(deriveFirstWorkBranch(worktree(), {})).toBeNull();
  });

  it('returns null when the derived name matches the current branch', () => {
    const result = deriveFirstWorkBranch(
      worktree({ branch: 'thread/login-1' }),
      { subject: 'fix: login' },
    );
    expect(result).toBeNull();
  });

  it('keeps the trailing short id so two agents naming the same work stay unique', () => {
    const a = deriveFirstWorkBranch(worktree({ branch: 'thread/agent-abc123' }), { file: 'login.tsx' });
    const b = deriveFirstWorkBranch(worktree({ branch: 'thread/agent-zzz999' }), { file: 'login.tsx' });
    expect(a).toBe('thread/login-abc123');
    expect(b).toBe('thread/login-zzz999');
  });
});

describe('renameTaskWorktree', () => {
  it('passes the worktree path and both branch names to the backend', async () => {
    let args: Record<string, unknown> = {};
    backendInvoke.mockImplementation(async (_cmd: string, a: Record<string, unknown>) => {
      args = a;
      return 'thread/login-abc123';
    });

    const branch = await renameTaskWorktree('p1', worktree(), 'thread/login-abc123');

    expect(args).toEqual({
      projectId: 'p1',
      worktreePath: worktree().path,
      branch: 'thread/alex-1',
      newBranch: 'thread/login-abc123',
    });
    expect(branch).toBe('thread/login-abc123');
  });

  it('returns null when the backend refuses the rename', async () => {
    backendInvoke.mockRejectedValue(new Error('Worktree is on another branch'));
    const branch = await renameTaskWorktree('p1', worktree(), 'thread/login-abc123');
    expect(branch).toBeNull();
  });
});

describe('sweepAgentBranches', () => {
  it('passes the in-use branches through as skip and reports what went', async () => {
    let args: Record<string, unknown> = {};
    backendInvoke.mockImplementation(async (_cmd: string, a: Record<string, unknown>) => {
      args = a;
      return {
        deleted: ['thread/ada-1', 'thread/bane-2'],
        retained: [],
        failed: [],
        base: 'main',
      };
    });

    const sweep = await sweepAgentBranches('p1', { skip: ['thread/live-9'] });

    expect(args.skip).toEqual(['thread/live-9']);
    expect(args.dryRun).toBe(false);
    expect(sweep.deleted).toEqual(['thread/ada-1', 'thread/bane-2']);
    expect(sweep.base).toBe('main');
  });

  it('maps the retained branch detail out of the backend snake_case', async () => {
    backend({
      workspace_git_sweep_agent_branches: {
        deleted: [],
        retained: [
          {
            branch: 'thread/niobe-4',
            unique_commits: 2,
            last_commit: '2026-07-26T21:59:36+01:00',
            patch_equivalent: true,
          },
        ],
        failed: ['thread/locked-1'],
        base: 'main',
      },
    });

    const sweep = await sweepAgentBranches('p1');

    expect(sweep.retained).toEqual([
      {
        branch: 'thread/niobe-4',
        uniqueCommits: 2,
        lastCommit: '2026-07-26T21:59:36+01:00',
        patchEquivalent: true,
      },
    ]);
    expect(sweep.failed).toEqual(['thread/locked-1']);
  });

  it('forwards a dry run so nothing is deleted', async () => {
    let args: Record<string, unknown> = {};
    backendInvoke.mockImplementation(async (_cmd: string, a: Record<string, unknown>) => {
      args = a;
      return { deleted: ['thread/would-go'], retained: [], failed: [], base: 'main' };
    });

    const sweep = await sweepAgentBranches('p1', { dryRun: true });

    expect(args.dryRun).toBe(true);
    expect(sweep.deleted).toEqual(['thread/would-go']);
  });

  it('yields an empty sweep rather than throwing into a background timer', async () => {
    backendInvoke.mockRejectedValueOnce(new Error('git exploded'));
    await expect(sweepAgentBranches('p1')).resolves.toEqual({
      deleted: [],
      retained: [],
      failed: [],
      base: '',
    });
  });

  it('survives a backend that does not implement the command', async () => {
    // A remote backend resolves an unregistered command to undefined instead of
    // rejecting — same guard as listWorktreesOnDisk.
    backend({ workspace_git_sweep_agent_branches: undefined });
    const sweep = await sweepAgentBranches('p1');
    expect(sweep.deleted).toEqual([]);
    expect(sweep.retained).toEqual([]);
  });
});


describe('createTaskWorktree', () => {
  it('returns the isolated checkout supplied by Git', async () => {
    backendInvoke.mockResolvedValue({ path: '/repo/.spacron/worktrees/agent', branch: 'thread/agent', base_branch: 'main', base_commit: BASE });
    await expect(createTaskWorktree({ projectId: 'p', taskId: 't' })).resolves.toMatchObject({ path: '/repo/.spacron/worktrees/agent', baseCommit: BASE });
  });

  it.each(['This project is not a Git repository.', 'The repository has no commits yet.', 'Permission denied'])('surfaces %s instead of allowing a main-repo fallback', async (reason) => {
    backendInvoke.mockRejectedValue(reason);
    await expect(createTaskWorktree({ projectId: 'p', taskId: 't' })).rejects.toThrow(reason);
  });
});

describe('worktreeUnavailableReason', () => {
  it('allows a worktree once the repository has a commit', async () => {
    backendInvoke.mockResolvedValue([{ graph: '*', hash: 'abc1234' }]);
    await expect(worktreeUnavailableReason('p')).resolves.toBeNull();
  });

  it('refuses a repository with no commits, which has no HEAD to branch from', async () => {
    backendInvoke.mockResolvedValue([]);
    await expect(worktreeUnavailableReason('p')).resolves.toMatch(/no commits/);
  });

  it('refuses a folder that is not a repository', async () => {
    backendInvoke.mockRejectedValue('This project is not a Git repository.');
    await expect(worktreeUnavailableReason('p')).resolves.toMatch(/not a Git repository/);
  });
});
