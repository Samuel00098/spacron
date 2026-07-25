import { backendInvoke } from '$lib/services/backend';

/**
 * Per-agent git worktree isolation.
 *
 * Each orchestrator agent runs in its own git worktree on a dedicated branch
 * (forked from the project's current HEAD), so several agents can edit the same
 * repository at once without colliding. Worktrees live *inside* the project at
 * `.spacron/worktrees/<branch>`, managed by the Rust backend — they have to be
 * inside the root because terminals are confined to the open project roots, so a
 * worktree elsewhere gets created but can never host a shell. This module owns
 * deriving branch names and driving the backend create / remove / status commands.
 */

export interface WorktreeInfo {
  /** Absolute path to the agent's isolated checkout. */
  path: string;
  /** The task branch created for the agent (e.g. `spacron/backend-a1b2c3`). */
  branch: string;
  /** Branch the worktree was forked from. */
  baseBranch: string;
  /** Commit the worktree was forked from. */
  baseCommit: string;
  /** When the worktree was created (epoch ms). */
  createdAt: number;
  /**
   * Branch tip as of the last successful stage into the main checkout, or absent
   * if never staged. This is the single source of truth for "what has the user
   * already seen?" — everything after it is outstanding work.
   *
   * It replaced a boolean `worktreeStaged` flag, which could only ever say
   * "staged at least once" and so was wrong the moment an agent kept working. A
   * commit marker stays accurate across any number of turns, and lets cleanup
   * distinguish "fully staged, safe to delete" from "still holds unstaged work"
   * instead of guessing.
   */
  lastStagedCommit?: string | null;
  /**
   * Set when a stage left conflict markers in the main checkout. Auto-staging
   * pauses for this worktree until the user resolves them, so the reconciler
   * can't re-apply the same conflicting patch on a loop.
   */
  stageConflict?: boolean;
}

/** Where a stage should resume from: the last staged tip, else the fork point. */
export function stageBaseline(worktree: WorktreeInfo): string {
  return worktree.lastStagedCommit?.trim() || worktree.baseCommit;
}

export interface WorktreeStatus {
  /** Count of changed files (staged + unstaged + untracked). */
  changedFiles: number;
  branch: string;
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent'
  );
}

/**
 * Derive a stable, human-readable branch name for a task: `spacron/<slug>-<short>`.
 * The trailing short id keeps it unique even when two agents share a label.
 */
export function deriveTaskBranch(taskId: string, label?: string | null): string {
  const short = taskId.replace(/[^a-z0-9]/gi, '').slice(-6) || Math.random().toString(36).slice(2, 8);
  const slug = label && label.trim() ? slugify(label) : 'agent';
  return `spacron/${slug}-${short}`;
}

/**
 * Create an isolated worktree for an agent. Returns null when isolation isn't
 * possible (not a git repo, no commits yet, backend failure) — the caller then
 * falls back to running the agent in the project root.
 */
export async function createTaskWorktree(args: {
  projectId: string;
  taskId: string;
  label?: string | null;
}): Promise<WorktreeInfo | null> {
  const branch = deriveTaskBranch(args.taskId, args.label);
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
    return {
      path: raw.path,
      branch: raw.branch,
      baseBranch: raw.base_branch,
      baseCommit: raw.base_commit,
      createdAt: Date.now(),
    };
  } catch (err) {
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    // Not a git repo / empty repo — isolation is skipped, not fatal.
    if (msg.includes('not a Git repository') || msg.includes('no commits yet') || msg.includes('Not a git worktree')) {
      console.warn('Worktree isolation skipped; running agent in project root:', msg);
    } else {
      // Git unavailable, permission denied, or other unexpected failure.
      // Log at error level so it's visible in devtools even during production
      // builds — helps diagnose "worktree badge not showing" reports.
      console.error('Worktree isolation failed (unexpected); running agent in project root:', msg);
    }
    return null;
  }
}

/**
 * Remove an agent worktree (best-effort). Optionally also delete its branch.
 *
 * Prefer `reclaimWorktree` — this is the unconditional form and will happily
 * delete work that was never staged.
 */
export async function removeTaskWorktree(
  projectId: string,
  worktree: WorktreeInfo,
  deleteBranch = false
): Promise<void> {
  try {
    await backendInvoke('workspace_git_remove_worktree', {
      projectId,
      worktreePath: worktree.path,
      deleteBranch,
      branch: worktree.branch,
    });
  } catch (err) {
    console.warn('Worktree removal failed:', err);
  }
}

export type ReclaimOutcome =
  | { removed: true; staged: number }
  | { removed: false; reason: 'pending' | 'conflict' | 'error'; pendingFiles: number; message?: string };

/**
 * Reclaim a worktree's disk space, but never at the cost of the agent's work.
 *
 * Stages anything outstanding first (which snapshots uncommitted edits onto the
 * branch), and only removes the checkout once git confirms nothing is left
 * unstaged. If work can't be moved — a conflict needing a human, or a git failure
 * — the worktree is kept and the reason reported.
 *
 * This exists because both previous cleanup paths could destroy work: the
 * post-commit sweep force-deleted the branch based on a sticky "was staged once"
 * flag, and closing an agent pane removed its checkout with uncommitted edits
 * still in it.
 */
export async function reclaimWorktree(
  projectId: string,
  worktree: WorktreeInfo,
  opts?: { deleteBranch?: boolean }
): Promise<ReclaimOutcome> {
  let staged = 0;
  // Advances as we stage, so the final check compares against what the main
  // checkout has actually been given — not the baseline we started from.
  let baseline = worktree;
  try {
    const delta = await getWorktreeDelta(projectId, worktree);
    if (delta && !delta.upToDate) {
      const result = await stageWorktreeChanges(projectId, worktree);
      if (!result.success) {
        return {
          removed: false,
          reason: result.conflicted ? 'conflict' : 'error',
          pendingFiles: delta.pendingFiles,
          message: result.message,
        };
      }
      staged = result.stagedFiles;
      baseline = { ...worktree, lastStagedCommit: result.stagedCommit };
    }

    // Re-ask git rather than trusting the stage result: this is the last check
    // before an irreversible delete. Catches anything the agent wrote while we
    // were staging.
    const after = await getWorktreeDelta(projectId, baseline);
    if (after && !after.upToDate) {
      return { removed: false, reason: 'pending', pendingFiles: after.pendingFiles };
    }
  } catch (err) {
    return {
      removed: false,
      reason: 'error',
      pendingFiles: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  await removeTaskWorktree(projectId, worktree, opts?.deleteBranch ?? false);
  return { removed: true, staged };
}

export interface MergeWorktreeResult {
  success: boolean;
  message: string;
  conflicted: boolean;
}

/**
 * Fully merge a worktree branch into the main checkout (creates a merge commit)
 * and optionally clean up. Returns the merge result with success/conflict info.
 */
export async function mergeTaskWorktree(
  projectId: string,
  worktree: WorktreeInfo,
  deleteAfter = true
): Promise<MergeWorktreeResult> {
  const raw = await backendInvoke<{
    success: boolean;
    message: string;
    conflicted: boolean;
  }>('workspace_git_merge_worktree', {
    projectId,
    worktreePath: worktree.path,
    branch: worktree.branch,
    deleteAfter,
    noCommit: false,
  });
  return {
    success: raw.success,
    message: raw.message,
    conflicted: raw.conflicted,
  };
}

export interface WorktreeDelta {
  /** Current tip of the worktree branch. */
  head: string;
  /** Uncommitted files sitting in the worktree. */
  dirtyFiles: number;
  /** Files changed by commits the main checkout hasn't been shown yet. */
  committedFiles: number;
  /** True when the main checkout already has everything this worktree holds. */
  upToDate: boolean;
  /** Total outstanding files — what the UI counts. */
  pendingFiles: number;
}

/**
 * Ask git what this worktree is holding beyond its last staged point.
 *
 * Deliberately asks git rather than reading app state: it stays correct after a
 * turn is marked complete, after the thread is cleared, across restarts, and for
 * an agent that keeps working past the end of its turn. That property is the
 * whole reason the reconciler can guarantee nothing goes unnoticed.
 */
export async function getWorktreeDelta(
  projectId: string,
  worktree: WorktreeInfo
): Promise<WorktreeDelta | null> {
  try {
    const raw = await backendInvoke<{
      head: string;
      dirty_files: number;
      committed_files: number;
      up_to_date: boolean;
    }>('workspace_git_worktree_delta', {
      projectId,
      worktreePath: worktree.path,
      branch: worktree.branch,
      sinceCommit: stageBaseline(worktree),
    });
    return {
      head: raw.head,
      dirtyFiles: raw.dirty_files,
      committedFiles: raw.committed_files,
      upToDate: raw.up_to_date,
      pendingFiles: Math.max(raw.dirty_files, raw.committed_files),
    };
  } catch {
    return null;
  }
}

export interface StageWorktreeResult {
  success: boolean;
  message: string;
  conflicted: boolean;
  conflictedFiles: string[];
  /** Branch tip this stage covered — persist as the worktree's `lastStagedCommit`. */
  stagedCommit: string;
  stagedFiles: number;
  upToDate: boolean;
}

/**
 * Stage everything this worktree holds beyond its baseline into the main checkout,
 * so the changes can be run, tested, reviewed in Source Control, and committed.
 *
 * Snapshots the agent's uncommitted edits onto its own branch first, then applies
 * the delta as a patch. Both matter: see `workspace_git_stage_worktree` in
 * `commands/workspace.rs` for why merging can't be used here (it leaves MERGE_HEAD
 * and blocks every later stage until the user commits).
 *
 * The worktree and branch are always KEPT. Staged-but-uncommitted changes can
 * still be discarded in Source Control, so until the user commits, the branch is
 * the only durable copy of the agent's work.
 */
export async function stageWorktreeChanges(
  projectId: string,
  worktree: WorktreeInfo
): Promise<StageWorktreeResult> {
  const raw = await backendInvoke<{
    success: boolean;
    message: string;
    conflicted: boolean;
    conflicted_files: string[];
    staged_commit: string;
    staged_files: number;
    up_to_date: boolean;
  }>('workspace_git_stage_worktree', {
    projectId,
    worktreePath: worktree.path,
    branch: worktree.branch,
    sinceCommit: stageBaseline(worktree),
    snapshot: true,
  });
  return {
    success: raw.success,
    message: raw.message,
    conflicted: raw.conflicted,
    conflictedFiles: raw.conflicted_files ?? [],
    stagedCommit: raw.staged_commit,
    stagedFiles: raw.staged_files,
    upToDate: raw.up_to_date,
  };
}

/**
 * Check whether a worktree has any changes relative to its base commit.
 * Returns false when there are no uncommitted changes AND no new commits
 * beyond the base — meaning there's nothing to merge.
 * On error, returns true (safe default) to avoid hiding a potential merge.
 */
export async function getWorktreeHasChanges(
  projectId: string,
  worktree: WorktreeInfo
): Promise<boolean> {
  try {
    return await backendInvoke<boolean>('workspace_git_worktree_has_changes', {
      projectId,
      worktreePath: worktree.path,
      baseCommit: worktree.baseCommit,
      branch: worktree.branch,
    });
  } catch {
    return true; // safe default — assume there might be changes
  }
}

/** Live changed-files / branch status for a worktree, or null if unavailable. */
export async function getWorktreeStatus(worktree: WorktreeInfo): Promise<WorktreeStatus | null> {
  try {
    const raw = await backendInvoke<{ changed_files: number; branch: string }>('workspace_git_worktree_status', {
      worktreePath: worktree.path,
    });
    return { changedFiles: raw.changed_files, branch: raw.branch };
  } catch {
    return null;
  }
}
