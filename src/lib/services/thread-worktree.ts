import { invoke } from '@tauri-apps/api/core';
import { backendInvoke } from '$lib/services/backend';
import { deriveTaskBranch } from '$lib/services/orchestrator/worktree-manager';
import type { ChatThreadPullRequest, ChatThreadWorktree } from '$lib/types/chat';

/**
 * Per-thread isolated checkouts.
 *
 * Chat threads on the same project used to share one working tree, so two
 * threads editing files at once overwrote each other's work and neither branch
 * meant anything. A thread with a worktree gets its own checkout on its own
 * branch, and the agent's cwd follows it — parallel work stops colliding.
 *
 * Creation and removal go through `backendInvoke` because that work belongs to
 * the workspace and moves with it when a remote workspace is active. The ship
 * action deliberately does not: it reads the GitHub token from the *local*
 * keychain, so it is app-local by definition and always runs on this machine.
 */

/** Result of the one-action commit → push → pull request command. */
export interface ThreadShipResult {
  branch: string;
  base: string;
  committed: boolean;
  commitSubject: string | null;
  headSha: string;
  pushed: boolean;
  prUrl: string | null;
  prNumber: number | null;
  prCreated: boolean;
  prError: string | null;
  compareUrl: string;
}

/**
 * The checkout one thread's turn must use: its own when it has one, the project
 * root otherwise.
 *
 * Shared by both chat paths (the ACP session's cwd and the brain's file tools)
 * so they can never disagree about where the work is happening.
 */
export function threadWorkingRoot(
  thread: { worktree?: { path: string } | null } | null | undefined,
  projectRoot: string,
): string {
  const worktree = thread?.worktree?.path?.trim();
  return worktree ? worktree : projectRoot;
}

/** Branch name for a thread: `spacron/<title-slug>-<short>`, stable per thread. */
export function deriveThreadBranch(threadId: string, title?: string | null): string {
  return deriveTaskBranch(threadId, title);
}

/** Create this thread's checkout. Throws with the git reason when it can't. */
export async function createThreadWorktree(args: {
  projectId: string;
  threadId: string;
  title?: string | null;
}): Promise<ChatThreadWorktree> {
  const branch = deriveThreadBranch(args.threadId, args.title);
  try {
    const raw = await backendInvoke<{
      path: string;
      branch: string;
      base_branch: string;
      base_commit: string;
    }>('workspace_git_create_worktree', {
      projectId: args.projectId,
      branch,
    });
    if (!raw?.path) throw new Error('the checkout has no path');
    return {
      path: raw.path,
      branch: raw.branch || branch,
      baseBranch: raw.base_branch || 'main',
      baseCommit: raw.base_commit || '',
      createdAt: Date.now(),
    };
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
    throw new Error(`Could not isolate this thread in a worktree: ${message}`);
  }
}

/**
 * Remove a thread's checkout. Best-effort: the branch is kept, because it may
 * hold work the user has not shipped yet.
 */
export async function removeThreadWorktree(
  projectId: string,
  worktree: ChatThreadWorktree,
): Promise<boolean> {
  try {
    await backendInvoke('workspace_git_remove_worktree', {
      projectId,
      worktreePath: worktree.path,
      deleteBranch: false,
      branch: worktree.branch,
    });
    return true;
  } catch (error) {
    console.warn('Thread worktree removal failed:', error);
    return false;
  }
}

/**
 * Commit everything in the thread's checkout, push the branch and open a pull
 * request — the whole "I'm done" step in one call.
 *
 * Runs locally with the stored GitHub token, so it is a plain `invoke`: routing
 * this to a remote workspace would look for the token on the wrong machine.
 */
export async function commitAndOpenPullRequest(args: {
  projectId: string;
  threadId: string;
  repoPath?: string | null;
  title: string;
  body?: string | null;
  base?: string | null;
}): Promise<ThreadShipResult> {
  const raw = await invoke<ThreadShipResult>('workspace_git_commit_and_open_pr', {
    projectId: args.projectId,
    repoPath: args.repoPath ?? null,
    title: args.title,
    body: args.body ?? null,
    base: args.base ?? null,
  });
  return {
    branch: raw.branch ?? '',
    base: raw.base ?? '',
    committed: raw.committed === true,
    commitSubject: raw.commitSubject ?? null,
    headSha: raw.headSha ?? '',
    pushed: raw.pushed === true,
    prUrl: raw.prUrl ?? null,
    prNumber: raw.prNumber ?? null,
    prCreated: raw.prCreated === true,
    prError: raw.prError ?? null,
    compareUrl: raw.compareUrl ?? '',
  };
}

/** Store the ship outcome on the thread in the shape the thread type persists. */
export function toThreadPullRequest(result: ThreadShipResult, at = Date.now()): ChatThreadPullRequest {
  return {
    url: result.prUrl,
    number: result.prNumber,
    compareUrl: result.compareUrl,
    branch: result.branch,
    base: result.base,
    openedAt: at,
  };
}

/**
 * One line describing what actually happened.
 *
 * The awkward cases are the point: a push that succeeded without a pull request
 * is a success, not a failure, and saying "opened" twice for a reused PR would
 * be a lie the user could check by clicking the link.
 */
export function shipSummary(result: ThreadShipResult): { headline: string; detail: string } {
  const pushed = result.committed
    ? `Committed${result.commitSubject ? ` “${result.commitSubject}”` : ''}`
    : 'Nothing new to commit';
  if (result.prUrl && result.prNumber) {
    return result.prCreated
      ? { headline: `Opened pull request #${result.prNumber}`, detail: `${pushed} and pushed ${result.branch}.` }
      : {
        headline: `Pull request #${result.prNumber} was already open`,
        detail: `${pushed}; ${result.branch} is up to date on GitHub.`,
      };
  }
  if (result.pushed) {
    return {
      headline: 'Branch pushed — open the pull request by hand',
      detail: result.prError
        ? `${pushed}. ${result.prError}`
        : `${pushed}; GitHub did not return a pull request.`,
    };
  }
  return {
    headline: 'Nothing to ship yet',
    detail: result.prError ?? `${pushed}; no branch was pushed.`,
  };
}
