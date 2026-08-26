import { transitionTask, type OrchestratorTask } from './task-lifecycle';

/** What the orchestrator could observe about a finished agent run. */
export interface ExecutionOutcome {
  /** Process exit code, or null when it can't be determined. */
  exitCode: number | null;
  /** The agent stopped because it needs a human decision (key, approval, …). */
  needsHumanInput?: boolean;
  /**
   * The agent said it could not finish, while its process is still alive and
   * will exit 0 whenever it does exit.
   *
   * Exit code alone cannot see this: a CLI agent sits in a REPL, so an agent
   * that hits an error it cannot get past reports the error and goes back to
   * its prompt — a clean exit, later, that used to be classified `complete`.
   * That is the "it told me the agent finished when it actually broke" case.
   */
  failed?: boolean;
  /** Free-text context for the resulting blocked/failed state. */
  note?: string;
}

/**
 * Decide a task's next state once its agent run ends.
 *
 * - non-zero exit             → `failed`
 * - agent declared a failure  → `failed`
 * - clean exit, needs input   → `blocked`
 * - clean exit                → `complete`
 *
 * A declared failure outranks `needsHumanInput` because they are different
 * questions ("did it work" vs "is it waiting"), and an agent that reports a
 * failure has already stopped asking.
 */
export function classifyTaskAfterExecution(
  task: OrchestratorTask,
  outcome: ExecutionOutcome
): OrchestratorTask {
  if (outcome.failed) {
    return {
      ...task,
      status: 'failed',
      failureReason: outcome.note ?? 'The agent reported that it could not finish.',
      blockedReason: null,
      assignedSessionId: null,
      promptSentAt: null,
    };
  }

  if (outcome.exitCode !== 0) {
    return {
      ...task,
      status: 'failed',
      failureReason: outcome.note ?? `Agent exited with code ${outcome.exitCode ?? 'unknown'}`,
      blockedReason: null,
      assignedSessionId: null,
      promptSentAt: null,
    };
  }

  if (outcome.needsHumanInput) {
    return {
      ...task,
      status: 'blocked',
      blockedReason: outcome.note ?? 'Human input required',
      failureReason: null,
      assignedSessionId: null,
      promptSentAt: null,
    };
  }

  return {
    ...transitionTask(task, 'complete'),
    assignedSessionId: null,
    blockedReason: null,
    failureReason: null,
  };
}
