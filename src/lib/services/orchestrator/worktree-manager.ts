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
  /**
   * True once the branch has been renamed from the agent's first real work
   * (Orca-style). Persisted so the rename happens exactly once per worktree,
   * not once per reconcile pass or per restart.
   */
  renamedFromWork?: boolean;
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
 * Derive a branch name from the agent's first real work, Orca-style: name the
 * work from what it actually did rather than the spawn-time label. The commit
 * subject is the best source ("fix: login redirect" → `fix-login-redirect`);
 * when the agent never commits, the first changed file's name stands in. The
 * trailing short id is kept from the current branch so a rename never collides
 * with another agent's branch.
 *
 * Returns null when there's nothing nameable yet, or when the derived name is
 * identical to the current branch (the work already matches the label).
 */
export function deriveFirstWorkBranch(
  worktree: WorktreeInfo,
  first: { file?: string | null; subject?: string | null },
): string | null {
  // The trailing segment of `spacron/<slug>-<short>` is the uniqueness suffix
  // (`deriveTaskBranch` appends one). Keeping it through the rename is what
  // lets two agents doing the same kind of work stay on distinct branches.
  const short = worktree.branch.split('-').pop() ?? '';
  if (!short) return null;

  // Prefer the oldest commit subject — that's the agent's own summary of what
  // the branch does. Strip conventional-commit prefixes (feat:, fix:, chore:)
  // so the slug reads as the work, not the ceremony around it. Our own snapshot
  // commit ("spacron: snapshot uncommitted agent work") says nothing about the
  // work, so it is skipped like any other empty subject.
  const subject = first.subject?.trim() ?? '';
  const fromSubject =
    subject && !/^spacron\s*:/i.test(subject)
      ? slugify(subject.replace(/^(feat|fix|chore|docs|refactor|style|test|perf|build|ci|revert)(\([^)]*\))?:\s*/i, ''))
      : '';

  // No commit subject (an agent that never commits) — fall back to the first
  // changed file's name, without its extension. CamelCase is split into words
  // first (`LoginForm` → `login-form`), which `slugify` alone would mangle into
  // `loginform` — file names are where agents reveal the work when they don't
  // commit.
  const file = first.file?.trim() ?? '';
  const fileName = file.replace(/\\/g, '/').split('/').pop() ?? file;
  const splitWords = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const fromFile = splitWords ? slugify(splitWords) : '';

  // `slugify` falls back to "agent" on empty input, but an empty slug here
  // means "nothing nameable yet" — keep the spawn-time label instead.
  const slug = (fromSubject || fromFile).slice(0, 24);
  if (!slug || slug === 'agent') return null;
  const branch = `spacron/${slug}-${short}`;
  return branch === worktree.branch ? null : branch;
}

/**
 * Rename an agent worktree's branch in place (Orca-style first-work naming).
 * Only the branch moves — the checkout folder stays put, because a running
 * agent's terminal has its cwd inside it. Returns the new branch name, or null
 * when the rename was refused.
 */
export async function renameTaskWorktree(
  projectId: string,
  worktree: WorktreeInfo,
  newBranch: string,
): Promise<string | null> {
  try {
    const renamed = await backendInvoke<string>('workspace_git_rename_worktree', {
      projectId,
      worktreePath: worktree.path,
      branch: worktree.branch,
      newBranch,
    });
    return typeof renamed === 'string' && renamed ? renamed : null;
  } catch {
    return null;
  }
}

/**
 * Whether an isolated worktree can be made for this project. A worktree
 * branches from HEAD, so the repo needs at least one commit, not just a
 * `.git` folder: `workspace_git_log` is an empty list for a repo with no
 * commits and an error for a folder that is not a repo. Lets a spawn surface
 * offer the main folder up front instead of failing at `createTaskWorktree`.
 */
export async function worktreeUnavailableReason(projectId: string): Promise<string | null> {
  try {
    const log = await backendInvoke<unknown[]>('workspace_git_log', { projectId });
    return Array.isArray(log) && log.length > 0 ? null : 'the repository has no commits yet';
  } catch {
    return 'this project is not a Git repository';
  }
}

/** Create the requested isolated checkout; failure must never change placement. */
export async function createTaskWorktree(args: {
  projectId: string;
  taskId: string;
  label?: string | null;
}): Promise<WorktreeInfo> {
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
    throw new Error(`Could not create isolated worktree: ${msg}`);
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
): Promise<boolean> {
  try {
    await backendInvoke('workspace_git_remove_worktree', {
      projectId,
      worktreePath: worktree.path,
      deleteBranch,
      branch: worktree.branch,
    });
    return true;
  } catch (err) {
    console.warn('Worktree removal failed:', err);
    return false;
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
  opts?: { deleteBranch?: boolean; stagePending?: boolean }
): Promise<ReclaimOutcome> {
  let staged = 0;
  // Advances as we stage, so the final check compares against what the main
  // checkout has actually been given — not the baseline we started from.
  let baseline = worktree;
  try {
    const delta = await getWorktreeDelta(projectId, worktree);
    if (!delta) throw new Error('Could not verify the agent worktree; it was kept.');
    if (!delta.upToDate) {
      if (opts?.stagePending === false) return { removed: false, reason: 'pending', pendingFiles: delta.pendingFiles };
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
    if (!after) throw new Error('Could not verify the agent worktree after bringing in changes; it was kept.');
    if (!after.upToDate) {
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

  if (!await removeTaskWorktree(projectId, worktree, opts?.deleteBranch ?? false)) {
    return { removed: false, reason: 'error', pendingFiles: 0, message: 'Git could not remove the worktree; cleanup will be retried.' };
  }
  return { removed: true, staged };
}

export interface MergeWorktreeResult {
  success: boolean;
  message: string;
  conflicted: boolean;
  /**
   * The branch held nothing the checkout didn't already have, so nothing moved.
   * `success` is still true — git did what it was asked — which is why this has
   * to be separate: reporting it as "Merged X into Y" announces work that never
   * happened.
   */
  alreadyUpToDate: boolean;
  /**
   * Branch tip that was merged. Persist as `lastStagedCommit` so the reconciler
   * stops counting just-merged work as outstanding and re-staging it.
   */
  mergedCommit: string;
}

/**
 * Fully merge a worktree branch into the main checkout (creates a merge commit)
 * and optionally clean up. Returns the merge result with success/conflict info.
 *
 * The backend snapshots the worktree's uncommitted edits onto its branch first,
 * for the same reason staging does: `git merge` sees only commits.
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
    already_up_to_date?: boolean;
    merged_commit?: string;
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
    alreadyUpToDate: raw.already_up_to_date === true,
    mergedCommit: raw.merged_commit ?? '',
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
  /** First changed path on the branch — for naming the branch from the work. */
  firstFile?: string | null;
  /** Oldest commit subject on the branch — the best name source when present. */
  firstSubject?: string | null;
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
      first_file?: string | null;
      first_subject?: string | null;
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
      firstFile: raw.first_file ?? null,
      firstSubject: raw.first_subject ?? null,
    };
  } catch {
    return null;
  }
}

export interface SnapshotWorktreeResult {
  /** True when there was uncommitted work and it has now been committed. */
  committed: boolean;
  /** The branch tip after the snapshot — what a successor inherits. */
  head: string;
}

/**
 * Commit whatever an agent left uncommitted on its own branch, and stop there.
 *
 * The freeze step of a handover. An agent that is about to be stopped
 * mid-feature must not leave edits floating in a checkout its successor is then
 * told to continue from — `getWorktreeDelta` and every later commit-range
 * operation only see commits, so uncommitted work is work the brief cannot
 * describe and the successor may quietly clobber.
 *
 * Deliberately **not** `stageWorktreeChanges`: that one goes on to apply the
 * delta into the user's main checkout, which is the auto-staging behaviour and
 * is off by default. Freezing work is not a reason to push it past the review
 * wall, so this touches the branch and nothing else.
 *
 * Returns null on failure rather than throwing — a handover must still happen
 * if the snapshot fails (the work is in the checkout either way), and the
 * caller records that it could not freeze rather than abandoning the hop.
 */
export async function snapshotWorktree(
  projectId: string,
  worktree: WorktreeInfo
): Promise<SnapshotWorktreeResult | null> {
  try {
    const raw = await backendInvoke<{ committed: boolean; head: string }>(
      'workspace_git_snapshot_worktree',
      { projectId, worktreePath: worktree.path }
    );
    return { committed: raw.committed, head: raw.head };
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

/** List worktree directories currently on disk in the project's managed area. */
export async function listWorktreesOnDisk(projectId: string): Promise<string[]> {
  try {
    const dirs = await backendInvoke<string[]>('workspace_git_list_worktrees', { projectId });
    // The backend returns Vec<String>, but an unregistered command (or a
    // remote backend that hasn't caught up) resolves to undefined — guard so
    // callers can always treat this as an array.
    return Array.isArray(dirs) ? dirs : [];
  } catch {
    return [];
  }
}

/** An agent branch the sweep kept, and why it is worth a second look. */
export interface RetainedAgentBranch {
  branch: string;
  /** Commits this branch has that the base does not. */
  uniqueCommits: number;
  /** ISO date of the tip commit, or '' when detail was skipped. */
  lastCommit: string;
  /**
   * `git cherry` says every unique commit is already in the base by patch id —
   * i.e. the work landed through staging, which applies patches rather than
   * merging, so the branch never becomes an ancestor. Strong evidence it is
   * droppable, but not proof; the sweep reports it and deletes nothing.
   */
  patchEquivalent: boolean;
}

export interface AgentBranchSweep {
  /** Branches deleted, or — with `dryRun` — the ones that would be. */
  deleted: string[];
  /** Branches kept because they hold unique commits. */
  retained: RetainedAgentBranch[];
  /** Eligible branches git refused to delete. */
  failed: string[];
  /** Branch containment was measured against. */
  base: string;
}

const EMPTY_SWEEP: AgentBranchSweep = { deleted: [], retained: [], failed: [], base: '' };

/**
 * Delete agent branches that hold nothing the base branch doesn't already have.
 *
 * Removing a worktree keeps its branch on purpose — until the user commits, the
 * branch is the only durable copy of the agent's work. Nothing came back for
 * them afterwards, so they piled up: an agent that never commits leaves a branch
 * pointing at the fork commit forever. Those are what this clears, and clearing
 * them cannot lose information: a tip already reachable from the base contains
 * nothing the base is missing.
 *
 * `skip` is every branch a live session or task still claims — the caller knows
 * that, the backend doesn't. Best-effort by design: a remote backend without the
 * command, or any git failure, yields an empty sweep rather than throwing into a
 * background timer.
 */
export async function sweepAgentBranches(
  projectId: string,
  opts?: { skip?: string[]; dryRun?: boolean }
): Promise<AgentBranchSweep> {
  try {
    const raw = await backendInvoke<{
      deleted: string[];
      retained: { branch: string; unique_commits: number; last_commit: string; patch_equivalent: boolean }[];
      failed: string[];
      base: string;
    }>('workspace_git_sweep_agent_branches', {
      projectId,
      skip: opts?.skip ?? [],
      dryRun: opts?.dryRun ?? false,
    });
    // An unregistered command on a remote backend resolves to undefined rather
    // than rejecting — same guard as `listWorktreesOnDisk`.
    if (!raw || !Array.isArray(raw.deleted)) return EMPTY_SWEEP;
    return {
      deleted: raw.deleted,
      retained: (raw.retained ?? []).map((r) => ({
        branch: r.branch,
        uniqueCommits: r.unique_commits,
        lastCommit: r.last_commit,
        patchEquivalent: r.patch_equivalent,
      })),
      failed: raw.failed ?? [],
      base: raw.base ?? '',
    };
  } catch {
    return EMPTY_SWEEP;
  }
}

/** Run `git worktree prune` to clean stale metadata. */
export async function pruneWorktrees(projectId: string): Promise<void> {
  try {
    await backendInvoke('workspace_git_prune_worktrees', { projectId });
  } catch {
    // best-effort
  }
}
