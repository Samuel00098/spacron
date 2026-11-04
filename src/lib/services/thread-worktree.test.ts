import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const backendMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('$lib/services/backend', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  backendInvoke: backendMock,
}));

const {
  commitAndOpenPullRequest,
  createThreadWorktree,
  deriveThreadBranch,
  removeThreadWorktree,
  shipSummary,
  threadWorkingRoot,
  toThreadPullRequest,
} = await import('./thread-worktree');

const shipResult = {
  branch: 'thread/fix-login-a1b2c3',
  base: 'main',
  committed: true,
  commitSubject: 'Fix login redirect',
  headSha: 'abc123',
  pushed: true,
  prUrl: 'https://github.com/o/r/pull/7',
  prNumber: 7,
  prCreated: true,
  prError: null,
  compareUrl: 'https://github.com/o/r/compare/main...thread/fix-login-a1b2c3?expand=1',
};

beforeEach(() => {
  invokeMock.mockReset();
  backendMock.mockReset();
});

describe('which checkout a thread turn uses', () => {
  it('follows the thread into its own worktree', () => {
    expect(threadWorkingRoot({ worktree: { path: '/repo/.spacron/worktrees/b' } }, '/repo'))
      .toBe('/repo/.spacron/worktrees/b');
  });

  it('stays on the project root without one', () => {
    expect(threadWorkingRoot(null, '/repo')).toBe('/repo');
    expect(threadWorkingRoot({ worktree: null }, '/repo')).toBe('/repo');
    // A blank path must never win over the real root: cwd '' would resolve to
    // the process directory instead of the project.
    expect(threadWorkingRoot({ worktree: { path: '   ' } }, '/repo')).toBe('/repo');
  });
});

describe('thread worktrees', () => {
  it('derives a stable branch from the thread, not from the clock', () => {
    const first = deriveThreadBranch('thread-42', 'Fix login redirect');
    expect(first).toBe(deriveThreadBranch('thread-42', 'Fix login redirect'));
    expect(first).toMatch(/^thread\/fix-login-redirect-[a-z0-9]+$/);
    // Two threads with the same title still land on different branches.
    expect(deriveThreadBranch('thread-43', 'Fix login redirect')).not.toBe(first);
  });

  it('creates the checkout through the workspace backend and maps git field names', async () => {
    backendMock.mockResolvedValue({
      path: '/repo/.spacron/worktrees/thread/fix-login-42',
      branch: 'thread/fix-login-42',
      base_branch: 'develop',
      base_commit: 'deadbeef',
    });
    const worktree = await createThreadWorktree({
      projectId: 'proj',
      threadId: 'thread-42',
      title: 'Fix login',
    });
    expect(backendMock).toHaveBeenCalledWith('workspace_git_create_worktree', {
      projectId: 'proj',
      branch: deriveThreadBranch('thread-42', 'Fix login'),
    });
    expect(worktree).toMatchObject({
      path: '/repo/.spacron/worktrees/thread/fix-login-42',
      branch: 'thread/fix-login-42',
      baseBranch: 'develop',
      baseCommit: 'deadbeef',
    });
  });

  it('surfaces the git reason when a project cannot be isolated', async () => {
    backendMock.mockRejectedValue('this project is not a Git repository');
    await expect(createThreadWorktree({ projectId: 'proj', threadId: 't1' }))
      .rejects.toThrow('Could not isolate this thread in a worktree: this project is not a Git repository');
  });

  it('removes the checkout but keeps the branch that may still hold work', async () => {
    backendMock.mockResolvedValue(null);
    const removed = await removeThreadWorktree('proj', {
      path: '/repo/.spacron/worktrees/b',
      branch: 'thread/b-1',
      baseBranch: 'main',
      baseCommit: 'abc',
      createdAt: 1,
    });
    expect(removed).toBe(true);
    expect(backendMock).toHaveBeenCalledWith('workspace_git_remove_worktree', {
      projectId: 'proj',
      worktreePath: '/repo/.spacron/worktrees/b',
      deleteBranch: false,
      branch: 'thread/b-1',
    });
  });

  it('reports a failed removal instead of throwing at the caller', async () => {
    backendMock.mockRejectedValue('worktree is dirty');
    const removed = await removeThreadWorktree('proj', {
      path: '/repo/.spacron/worktrees/b',
      branch: 'thread/b-1',
      baseBranch: 'main',
      baseCommit: 'abc',
      createdAt: 1,
    });
    expect(removed).toBe(false);
  });

  it('ships locally, because the GitHub token lives on this machine', async () => {
    invokeMock.mockResolvedValue(shipResult);
    const result = await commitAndOpenPullRequest({
      projectId: 'proj',
      threadId: 'thread-42',
      title: 'Fix login redirect',
    });
    expect(invokeMock).toHaveBeenCalledWith('workspace_git_commit_and_open_pr', {
      projectId: 'proj',
      repoPath: null,
      title: 'Fix login redirect',
      body: null,
      base: null,
    });
    // The workspace router must not see it: it would look for the token remotely.
    expect(backendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ prNumber: 7, prCreated: true, branch: 'thread/fix-login-a1b2c3' });
  });

  it('forwards an explicit repo path, body and base when given', async () => {
    invokeMock.mockResolvedValue(shipResult);
    await commitAndOpenPullRequest({
      projectId: 'proj',
      threadId: 'thread-42',
      repoPath: '/repo/.spacron/worktrees/b',
      title: 'Fix login',
      body: 'Why',
      base: 'develop',
    });
    expect(invokeMock).toHaveBeenCalledWith('workspace_git_commit_and_open_pr', {
      projectId: 'proj',
      repoPath: '/repo/.spacron/worktrees/b',
      title: 'Fix login',
      body: 'Why',
      base: 'develop',
    });
  });

  it('persists the ship outcome in the thread shape', () => {
    expect(toThreadPullRequest(shipResult, 1234)).toEqual({
      url: 'https://github.com/o/r/pull/7',
      number: 7,
      compareUrl: shipResult.compareUrl,
      branch: 'thread/fix-login-a1b2c3',
      base: 'main',
      openedAt: 1234,
    });
  });
});

describe('ship summary wording', () => {
  it('says opened only when this run opened it', () => {
    expect(shipSummary(shipResult).headline).toBe('Opened pull request #7');
    const reused = shipSummary({ ...shipResult, prCreated: false });
    expect(reused.headline).toBe('Pull request #7 was already open');
    expect(reused.detail).toContain('up to date');
  });

  it('treats a successful push without a pull request as a success', () => {
    const pushed = shipSummary({
      ...shipResult,
      prUrl: null,
      prNumber: null,
      prCreated: false,
      prError: 'Sign in to GitHub in Settings to open the pull request from here.',
    });
    expect(pushed.headline).toBe('Branch pushed — open the pull request by hand');
    expect(pushed.detail).toContain('Committed “Fix login redirect”');
    expect(pushed.detail).toContain('Sign in to GitHub');
  });

  it('names the commit subject and handles a clean tree', () => {
    expect(shipSummary(shipResult).detail).toContain('Committed “Fix login redirect”');
    const clean = shipSummary({ ...shipResult, committed: false, commitSubject: null });
    expect(clean.detail).toContain('Nothing new to commit');
  });
});
