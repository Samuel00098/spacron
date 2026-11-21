import { invoke } from '@tauri-apps/api/core';

export interface RemoteRepoInfo {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'other';
  owner: string;
  repo: string;
  currentBranch: string;
  defaultBranch: string;
  remoteUrl: string;
  hasToken: boolean;
}

export interface IssueAuthor {
  login: string;
  avatarUrl: string;
}

export interface IssueLabel {
  name: string;
  color: string;
  description?: string;
}

export interface WorkItemIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: IssueAuthor;
  labels: IssueLabel[];
  assignees: IssueAuthor[];
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  htmlUrl: string;
}

export interface WorkItemComment {
  id: number;
  author: IssueAuthor;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface WorkItemPR {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: IssueAuthor;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  mergeable?: boolean;
  mergeableState?: string;
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  mergedAt?: string;
  htmlUrl: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface WorkItemFile {
  filename: string;
  status: 'modified' | 'added' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface WorkItemCheck {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out';
  startedAt?: string;
  completedAt?: string;
  htmlUrl?: string;
}

export interface PRChecksSummary {
  total: number;
  passed: number;
  failed: number;
  running: number;
  checks: WorkItemCheck[];
}

export interface MergePRResult {
  success: boolean;
  sha?: string;
  message: string;
}

export async function getRepoInfo(projectId: string, repoPath?: string): Promise<RemoteRepoInfo> {
  return await invoke<RemoteRepoInfo>('source_control_repo_info', {
    projectId,
    repoPath,
  });
}

export async function listIssues(
  projectId: string,
  stateFilter: 'open' | 'closed' | 'all' = 'open',
  page = 1,
  repoPath?: string
): Promise<WorkItemIssue[]> {
  return await invoke<WorkItemIssue[]>('source_control_list_issues', {
    projectId,
    repoPath,
    stateFilter,
    page,
    perPage: 30,
  });
}

export async function getIssueDetails(
  projectId: string,
  issueNumber: number,
  repoPath?: string
): Promise<{ issue: WorkItemIssue; comments: WorkItemComment[] }> {
  const [issue, comments] = await invoke<[WorkItemIssue, WorkItemComment[]]>(
    'source_control_get_issue_details',
    {
      projectId,
      repoPath,
      issueNumber,
    }
  );
  return { issue, comments };
}

export async function createIssue(
  projectId: string,
  title: string,
  body: string,
  labels?: string[],
  assignees?: string[],
  repoPath?: string
): Promise<WorkItemIssue> {
  return await invoke<WorkItemIssue>('source_control_create_issue', {
    projectId,
    repoPath,
    title,
    body,
    labels,
    assignees,
  });
}

export async function updateIssueState(
  projectId: string,
  issueNumber: number,
  newState: 'open' | 'closed',
  repoPath?: string
): Promise<void> {
  await invoke('source_control_update_issue_state', {
    projectId,
    repoPath,
    issueNumber,
    newState,
  });
}

export async function addIssueComment(
  projectId: string,
  issueNumber: number,
  body: string,
  repoPath?: string
): Promise<WorkItemComment> {
  return await invoke<WorkItemComment>('source_control_add_issue_comment', {
    projectId,
    repoPath,
    issueNumber,
    body,
  });
}

export async function listPullRequests(
  projectId: string,
  stateFilter: 'open' | 'closed' | 'all' = 'open',
  page = 1,
  repoPath?: string
): Promise<WorkItemPR[]> {
  return await invoke<WorkItemPR[]>('source_control_list_pull_requests', {
    projectId,
    repoPath,
    stateFilter,
    page,
    perPage: 30,
  });
}

export async function createPullRequest(
  projectId: string,
  options: {
    title: string;
    body: string;
    base: string;
    head?: string;
    draft?: boolean;
    repoPath?: string;
  }
): Promise<WorkItemPR> {
  return await invoke<WorkItemPR>('source_control_create_pull_request', {
    projectId,
    repoPath: options.repoPath,
    title: options.title,
    body: options.body,
    base: options.base,
    head: options.head,
    draft: options.draft,
  });
}

export async function getPullRequestDetails(
  projectId: string,
  prNumber: number,
  repoPath?: string
): Promise<{ pr: WorkItemPR; comments: WorkItemComment[] }> {
  const [pr, comments] = await invoke<[WorkItemPR, WorkItemComment[]]>(
    'source_control_get_pr_details',
    {
      projectId,
      repoPath,
      prNumber,
    }
  );
  return { pr, comments };
}

export async function getPullRequestFiles(
  projectId: string,
  prNumber: number,
  repoPath?: string
): Promise<WorkItemFile[]> {
  return await invoke<WorkItemFile[]>('source_control_get_pr_files', {
    projectId,
    repoPath,
    prNumber,
  });
}

export async function getPullRequestChecks(
  projectId: string,
  headSha: string,
  repoPath?: string
): Promise<PRChecksSummary> {
  return await invoke<PRChecksSummary>('source_control_get_pr_checks', {
    projectId,
    repoPath,
    headSha,
  });
}

export async function mergePullRequest(
  projectId: string,
  prNumber: number,
  options: {
    method?: 'squash' | 'merge' | 'rebase';
    commitTitle?: string;
    commitMessage?: string;
    expectedHeadSha?: string;
    repoPath?: string;
  }
): Promise<MergePRResult> {
  return await invoke<MergePRResult>('source_control_merge_pr', {
    projectId,
    repoPath: options.repoPath,
    prNumber,
    method: options.method || 'squash',
    commitTitle: options.commitTitle,
    commitMessage: options.commitMessage,
    expectedHeadSha: options.expectedHeadSha,
  });
}

export async function addPullRequestComment(
  projectId: string,
  prNumber: number,
  body: string,
  repoPath?: string
): Promise<WorkItemComment> {
  return await invoke<WorkItemComment>('source_control_add_pr_comment', {
    projectId,
    repoPath,
    prNumber,
    body,
  });
}
