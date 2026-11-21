import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getRepoInfo,
  listIssues,
  getIssueDetails,
  createIssue,
  updateIssueState,
  addIssueComment,
  listPullRequests,
  createPullRequest,
  getPullRequestDetails,
  getPullRequestFiles,
  getPullRequestChecks,
  mergePullRequest,
  addPullRequestComment,
} from './work-items';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('work-items service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getRepoInfo with correct command and args', async () => {
    mockInvoke.mockResolvedValueOnce({
      provider: 'github',
      owner: 'acme',
      repo: 'spacron',
      currentBranch: 'main',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/acme/spacron.git',
      hasToken: true,
    });

    const info = await getRepoInfo('proj-1', '/path/to/repo');
    expect(mockInvoke).toHaveBeenCalledWith('source_control_repo_info', {
      projectId: 'proj-1',
      repoPath: '/path/to/repo',
    });
    expect(info.provider).toBe('github');
    expect(info.repo).toBe('spacron');
  });

  it('lists issues with filters and pagination', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: 101,
        number: 42,
        title: 'Fix issue with tabs',
        body: 'Details here',
        state: 'open',
        author: { login: 'octocat', avatarUrl: '' },
        labels: [{ name: 'bug', color: 'ff0000' }],
        assignees: [],
        commentsCount: 2,
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T12:00:00Z',
        htmlUrl: 'https://github.com/acme/spacron/issues/42',
      },
    ]);

    const issues = await listIssues('proj-1', 'open', 1, '/repo');
    expect(mockInvoke).toHaveBeenCalledWith('source_control_list_issues', {
      projectId: 'proj-1',
      repoPath: '/repo',
      stateFilter: 'open',
      page: 1,
      perPage: 30,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(42);
  });

  it('retrieves issue details and comments tuple', async () => {
    const mockIssue = {
      id: 1,
      number: 10,
      title: 'Issue 10',
      body: 'Body 10',
      state: 'open',
      author: { login: 'dev', avatarUrl: '' },
      labels: [],
      assignees: [],
      commentsCount: 1,
      createdAt: '2026-11-20T10:00:00Z',
      updatedAt: '2026-11-20T10:00:00Z',
      htmlUrl: 'https://github.com/acme/spacron/issues/10',
    };
    const mockComments = [
      {
        id: 50,
        author: { login: 'reviewer', avatarUrl: '' },
        body: 'Looks good',
        createdAt: '2026-11-20T11:00:00Z',
        updatedAt: '2026-11-20T11:00:00Z',
        htmlUrl: 'https://github.com/acme/spacron/issues/10#issuecomment-50',
      },
    ];

    mockInvoke.mockResolvedValueOnce([mockIssue, mockComments]);

    const res = await getIssueDetails('proj-1', 10, '/repo');
    expect(mockInvoke).toHaveBeenCalledWith('source_control_get_issue_details', {
      projectId: 'proj-1',
      repoPath: '/repo',
      issueNumber: 10,
    });
    expect(res.issue.title).toBe('Issue 10');
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].author.login).toBe('reviewer');
  });

  it('creates an issue with title and body', async () => {
    mockInvoke.mockResolvedValueOnce({
      id: 2,
      number: 11,
      title: 'New bug',
      body: 'Bug desc',
      state: 'open',
      author: { login: 'me', avatarUrl: '' },
      labels: [],
      assignees: [],
      commentsCount: 0,
      createdAt: '2026-11-20T10:00:00Z',
      updatedAt: '2026-11-20T10:00:00Z',
      htmlUrl: 'https://github.com/acme/spacron/issues/11',
    });

    const created = await createIssue('proj-1', 'New bug', 'Bug desc', ['bug'], ['me'], '/repo');
    expect(mockInvoke).toHaveBeenCalledWith('source_control_create_issue', {
      projectId: 'proj-1',
      repoPath: '/repo',
      title: 'New bug',
      body: 'Bug desc',
      labels: ['bug'],
      assignees: ['me'],
    });
    expect(created.number).toBe(11);
  });

  it('updates issue state and adds issue comments', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await updateIssueState('proj-1', 11, 'closed', '/repo');
    expect(mockInvoke).toHaveBeenCalledWith('source_control_update_issue_state', {
      projectId: 'proj-1',
      repoPath: '/repo',
      issueNumber: 11,
      newState: 'closed',
    });

    mockInvoke.mockResolvedValueOnce({
      id: 70,
      author: { login: 'me', avatarUrl: '' },
      body: 'Closing this',
      createdAt: '2026-11-20T12:00:00Z',
      updatedAt: '2026-11-20T12:00:00Z',
      htmlUrl: 'https://github.com/acme/spacron/issues/11#issuecomment-70',
    });
    const comment = await addIssueComment('proj-1', 11, 'Closing this', '/repo');
    expect(mockInvoke).toHaveBeenCalledWith('source_control_add_issue_comment', {
      projectId: 'proj-1',
      repoPath: '/repo',
      issueNumber: 11,
      body: 'Closing this',
    });
    expect(comment.id).toBe(70);
  });

  it('lists pull requests with branches and draft status', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: 201,
        number: 8,
        title: 'Feature PR',
        body: 'Implements feature',
        state: 'open',
        draft: false,
        author: { login: 'contributor', avatarUrl: '' },
        headBranch: 'feat/new-tasks',
        baseBranch: 'main',
        headSha: 'c0ffee1',
        commentsCount: 3,
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T12:00:00Z',
        htmlUrl: 'https://github.com/acme/spacron/pull/8',
      },
    ]);

    const prs = await listPullRequests('proj-1', 'open', 1, '/repo');
    expect(prs).toHaveLength(1);
    expect(prs[0].headBranch).toBe('feat/new-tasks');
    expect(prs[0].baseBranch).toBe('main');
  });

  it('fetches PR details, files diff, and checks summary', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: 201,
        number: 8,
        title: 'Feature PR',
        body: 'Implements feature',
        state: 'open',
        draft: false,
        author: { login: 'contributor', avatarUrl: '' },
        headBranch: 'feat/new-tasks',
        baseBranch: 'main',
        headSha: 'c0ffee1',
        commentsCount: 0,
        createdAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-20T12:00:00Z',
        htmlUrl: 'https://github.com/acme/spacron/pull/8',
      },
      [],
    ]);

    const prDetails = await getPullRequestDetails('proj-1', 8, '/repo');
    expect(prDetails.pr.headSha).toBe('c0ffee1');

    mockInvoke.mockResolvedValueOnce([
      {
        filename: 'src/main.rs',
        status: 'modified',
        additions: 10,
        deletions: 2,
        changes: 12,
        patch: '@@ -1,2 +1,10 @@',
      },
    ]);

    const files = await getPullRequestFiles('proj-1', 8, '/repo');
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('src/main.rs');

    mockInvoke.mockResolvedValueOnce({
      total: 2,
      passed: 2,
      failed: 0,
      running: 0,
      checks: [
        {
          id: 301,
          name: 'CI / Test',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    });

    const checks = await getPullRequestChecks('proj-1', 'c0ffee1', '/repo');
    expect(checks.total).toBe(2);
    expect(checks.passed).toBe(2);
  });

  it('merges PR with squash method and expected head SHA safety', async () => {
    mockInvoke.mockResolvedValueOnce({
      success: true,
      sha: 'deadbeef123',
      message: 'Pull request successfully merged',
    });

    const result = await mergePullRequest('proj-1', 8, {
      method: 'squash',
      commitTitle: 'feat: add task panel tabs',
      commitMessage: 'squash commit body',
      expectedHeadSha: 'c0ffee1',
      repoPath: '/repo',
    });

    expect(mockInvoke).toHaveBeenCalledWith('source_control_merge_pr', {
      projectId: 'proj-1',
      repoPath: '/repo',
      prNumber: 8,
      method: 'squash',
      commitTitle: 'feat: add task panel tabs',
      commitMessage: 'squash commit body',
      expectedHeadSha: 'c0ffee1',
    });
    expect(result.success).toBe(true);
    expect(result.sha).toBe('deadbeef123');
  });

  it('adds PR comments', async () => {
    mockInvoke.mockResolvedValueOnce({
      id: 88,
      author: { login: 'reviewer', avatarUrl: '' },
      body: 'Nice PR!',
      createdAt: '2026-11-20T12:00:00Z',
      updatedAt: '2026-11-20T12:00:00Z',
      htmlUrl: 'https://github.com/acme/spacron/pull/8#issuecomment-88',
    });

    const comment = await addPullRequestComment('proj-1', 8, 'Nice PR!', '/repo');
    expect(mockInvoke).toHaveBeenCalledWith('source_control_add_pr_comment', {
      projectId: 'proj-1',
      repoPath: '/repo',
      prNumber: 8,
      body: 'Nice PR!',
    });
    expect(comment.id).toBe(88);
  });

  it('creates pull request', async () => {
    mockInvoke.mockResolvedValueOnce({
      id: 99,
      number: 12,
      title: 'feat: add compact pr button',
      body: 'fixes wrapping',
      state: 'open',
      headBranch: 'feat/compact-button',
      baseBranch: 'main',
      headSha: 'abc1234',
      isDraft: false,
      author: { login: 'octocat', avatarUrl: '' },
      labels: [],
      assignees: [],
      commentsCount: 0,
      createdAt: '2026-11-21T06:00:00Z',
      updatedAt: '2026-11-21T06:00:00Z',
      htmlUrl: 'https://github.com/acme/spacron/pull/12',
    });

    const pr = await createPullRequest('proj-1', {
      title: 'feat: add compact pr button',
      body: 'fixes wrapping',
      base: 'main',
      draft: false,
      repoPath: '/repo',
    });

    expect(mockInvoke).toHaveBeenCalledWith('source_control_create_pull_request', {
      projectId: 'proj-1',
      repoPath: '/repo',
      title: 'feat: add compact pr button',
      body: 'fixes wrapping',
      base: 'main',
      draft: false,
    });
    expect(pr.number).toBe(12);
    expect(pr.title).toBe('feat: add compact pr button');
  });
});
