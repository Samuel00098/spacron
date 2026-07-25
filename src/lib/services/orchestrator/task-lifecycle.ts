export type OrchestratorTaskStatus =
  | 'todo'
  | 'in-progress'
  | 'complete'
  | 'blocked'
  | 'failed'
  | 'cancelled';

import type { ActivityEvent } from './activity-log';
export type { ActivityEvent } from './activity-log';
import type { WorktreeInfo } from './worktree-manager';
import type { AgentRole } from './agent-charter';

export interface OrchestratorTask {
  id: string;
  projectId: string;
  goal: string;
  title: string;
  /** User-assigned handle for a running agent (e.g. "Backend"); null until named. */
  name?: string | null;
  status: OrchestratorTaskStatus;
  agentPreset?: string | null;
  /**
   * Team role assigned by the planner (Coordinator/Builder/Scout/Reviewer). Adds
   * a compact role charter to the agent's brief so a fleet can divide a goal and
   * coordinate through the mailbox. Null ⇒ a plain, un-roled agent.
   */
  role?: AgentRole | null;
  assignedSessionId?: number | null;
  /**
   * The session the agent last ran in. Unlike `assignedSessionId` (cleared on
   * completion when the lease is released), this survives completion so the
   * orchestrator can still read late terminal output from an agent that kept
   * printing after its turn was marked done (the CLI process stays alive).
   */
  lastSessionId?: number | null;
  blockedReason?: string | null;
  failureReason?: string | null;
  /** Most recent prompt delivery for the current run; null until the agent has work. */
  promptSentAt?: number | null;
  /** Structured timeline of what the agent/orchestrator did (most recent last). */
  activity?: ActivityEvent[];
  /** Verbatim, ANSI-stripped snapshot of the agent's terminal output. */
  transcript?: string | null;
  /**
   * True when the orchestrator adopted an agent the user launched by hand
   * (typed `claude`/`codex`/… into a terminal) rather than spawning it itself.
   * Adopted tasks are ephemeral: never persisted, never claim the brief lease
   * (the terminal's own auto-brief still runs), but ARE addressable for
   * follow-ups / close so agent mode can drive them like any other.
   */
  adopted?: boolean;
  /**
   * Isolated git worktree this agent works in (own branch, forked from HEAD), so
   * multiple agents can edit the same repo concurrently. Null/absent when the
   * task runs directly in the project root (non-git project, or isolation off).
   */
  worktree?: WorktreeInfo | null;
  // NOTE: how much of the worktree the main checkout has seen lives on
  // `worktree.lastStagedCommit`, not on a `worktreeStaged` boolean here. The
  // boolean could only say "staged at least once", so it stayed true while the
  // agent kept working, and the post-commit sweep then force-deleted branches
  // holding work nobody had reviewed. See `reclaimWorktree`.
  /**
   * When true, the agent runs directly in the project root instead of an
   * isolated worktree. Useful for admin/release tasks (tagging, pushing,
   * changelogs) where the agent needs direct access to the main branch.
   * Only meaningful when the project is a git repo, otherwise there is no
   * isolation to skip.
   */
  skipWorktree?: boolean;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

const ALLOWED_TRANSITIONS: Record<OrchestratorTaskStatus, readonly OrchestratorTaskStatus[]> = {
  todo: ['in-progress', 'blocked', 'failed', 'cancelled'],
  'in-progress': ['todo', 'complete', 'blocked', 'failed', 'cancelled'],
  complete: [],
  blocked: ['todo', 'in-progress', 'cancelled', 'failed'],
  failed: [],
  cancelled: [],
};

export function createTaskRecord(
  projectId: string,
  goal: string,
  agentPreset?: string | null,
  name?: string | null,
  role?: AgentRole | null
): OrchestratorTask {
  const now = Date.now();
  const trimmedGoal = goal.trim();

  return {
    id: `ot_${now}_${Math.random().toString(36).slice(2, 7)}`,
    projectId,
    goal: trimmedGoal,
    title: !trimmedGoal ? 'Untitled task' : trimmedGoal.length > 72 ? `${trimmedGoal.slice(0, 69)}...` : trimmedGoal,
    name: name?.trim() ? name.trim() : null,
    status: 'todo',
    agentPreset: agentPreset ?? null,
    role: role ?? null,
    assignedSessionId: null,
    blockedReason: null,
    failureReason: null,
    promptSentAt: null,
    activity: [],
    transcript: null,
    worktree: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
  };
}

export function transitionTask(task: OrchestratorTask, next: OrchestratorTaskStatus): OrchestratorTask {
  if (!ALLOWED_TRANSITIONS[task.status].includes(next)) {
    throw new Error(`Invalid orchestrator transition: ${task.status} -> ${next}`);
  }

  const now = Date.now();

  return {
    ...task,
    status: next,
    startedAt: next === 'in-progress' ? task.startedAt ?? now : task.startedAt ?? null,
    completedAt: next === 'complete' ? now : task.completedAt ?? null,
    promptSentAt: next === 'in-progress' ? (task.promptSentAt ?? null) : null,
  };
}

export function cancelTask(task: OrchestratorTask, note?: string): OrchestratorTask {
  if (task.status === 'cancelled') return task;

  const now = Date.now();
  void note;

  return {
    ...task,
    status: 'cancelled',
    completedAt: task.completedAt ?? now,
  };
}
