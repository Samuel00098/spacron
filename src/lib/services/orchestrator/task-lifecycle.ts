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
import type { ChatReasoningEffort } from '$lib/types/chat';

/**
 * One hop of a task's work from one agent to another.
 *
 * Recorded from evidence, not from the agent that just stopped: `filesChanged`
 * comes from git, `headroomPercent` from the meter, `stoppedBy` from what
 * actually happened when the agent was asked to wrap up. The outgoing agent is
 * never asked to summarise its own unfinished work, because by definition it
 * cannot.
 */
export interface TaskMigration {
  at: number;
  /** Launch command of the agent that handed the work over. */
  fromPreset: string | null;
  fromAccountId: string | null;
  /** Human label for that account — an email, usually. Never a token. */
  fromAccountLabel: string | null;
  /** Headroom left on that account at the moment of the switch, in percent. */
  fromHeadroomPercent: number | null;
  /** When that account's limit comes back, unix ms, when the meter said. */
  fromResetAtMs: number | null;
  toPreset: string;
  toAccountId: string | null;
  toAccountLabel: string | null;
  toHeadroomPercent: number | null;
  /** Files the outgoing agent left on the branch, per `getWorktreeDelta`. */
  filesChanged: number | null;
  /**
   * How the outgoing agent stopped.
   *
   * - `pre-emptive` — it had not started a turn; nothing needed interrupting.
   * - `wrap-up` — it was asked to finish the edit in hand and complied.
   * - `interrupt` — it did not stop in the grace window and was interrupted.
   * - `already-idle` — it had already stopped when the switch was decided.
   *
   * This is the difference between "it put its tools down" and "we took them
   * away", and the completion card is not allowed to blur the two.
   */
  stoppedBy: 'pre-emptive' | 'wrap-up' | 'interrupt' | 'already-idle';
  /** One sentence, for the activity log and the completion card. */
  reason: string;
}

export interface OrchestratorTask {
  id: string;
  projectId: string;
  goal: string;
  title: string;
  /** User-assigned handle for a running agent (e.g. "Backend"); null until named. */
  name?: string | null;
  status: OrchestratorTaskStatus;
  agentPreset?: string | null;
  /** Provider-native worker model selected at launch; retained for relaunches. */
  agentModel?: string | null;
  /** Provider-native worker reasoning selected at launch; retained for relaunches. */
  agentReasoningEffort?: ChatReasoningEffort;
  /**
   * Team role assigned by the planner (Coordinator/Builder/Scout/Reviewer). Adds
   * a compact role charter to the agent's brief so a fleet can divide a goal and
   * coordinate through the mailbox. Null ⇒ a plain, un-roled agent.
   */
  role?: AgentRole | null;
  /**
   * The signed-in account this agent is running under, for the CLIs that hold
   * more than one. Null means "whichever the user selected" — which is what
   * every task carried before failover existed, and what a CLI with a single
   * login always carries.
   *
   * Recorded rather than re-derived because the user's selection can move while
   * an agent is working: the account a running agent is *on* was fixed at
   * spawn, and reading the picker later would answer a different question.
   */
  agentAccountId?: string | null;
  assignedSessionId?: number | null;
  /**
   * The session the agent last ran in. Unlike `assignedSessionId` (cleared on
   * completion when the lease is released), this survives completion so the
   * orchestrator can still read late terminal output from an agent that kept
   * printing after its turn was marked done (the CLI process stays alive).
   */
  lastSessionId?: number | null;
  /** Evidence for the latest completed run. */
  turnEndedBy?: 'declared' | 'exit' | 'inferred';
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
  /**
   * The task-panel card this agent was launched from ("Run with agent"). Set
   * only for panel-dispatched runs; when such an agent finishes cleanly, the
   * linked card is moved to Done with it.
   */
  panelTaskId?: string | null;
  /**
   * Every hand-off this work has been through, oldest first.
   *
   * A list, not a field, for two reasons the feature depends on. Work may pass
   * through three or more agents, and the thread has to be able to show the
   * *chain* — "Claude built the schema, Codex finished the handlers" — rather
   * than only the last hop. And a correction the user types has to reach the
   * agent **currently** holding the work, not the one that ran out; the last
   * entry here is who that is.
   */
  migrations?: TaskMigration[];
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
