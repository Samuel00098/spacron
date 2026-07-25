import { useEffect, useMemo, useState } from 'react';
import { orchestratorTasks } from '$lib/stores/orchestrator';
import { allProjectSessions, devSessions, sessions } from '$lib/stores/terminal';
import { getWorktreeStatus, type WorktreeStatus } from '$lib/services/orchestrator/worktree-manager';
import { useStore } from '$lib/react/useStore';
import './AgentWorktreeBadge.css';

interface Props {
  /** The agent's terminal session id; matched to its owning orchestrator task. */
  sessionId: number;
}

/**
 * A compact, live badge shown above an agent's terminal. When the agent runs in
 * an isolated worktree, shows the branch name and changed-file count. When the
 * agent runs directly in the project root (skipWorktree or non-git project),
 * shows a "Main repo" indicator instead. Renders nothing when the session
 * can't be resolved.
 */
export default function AgentWorktreeBadge({ sessionId }: Props) {
  const tasks = useStore(orchestratorTasks);
  // Resolve the session from every store it can live in, not just the active
  // project's: `sessions` holds the active project only, but the stage keeps a
  // background project's agent pane mounted (and this badge with it), and agents
  // spawned in the Development ambient live in `devSessions` — which never
  // reaches `allProjectSessions`. Looking in one store alone made the badge
  // vanish on a project switch even though the agent was still in its worktree.
  const activeSessions = useStore(sessions);
  const crossProjectSessions = useStore(allProjectSessions);
  const devProjectSessions = useStore(devSessions);
  // The worktree lives on the session for floating-bar agents and on the task for
  // orchestrator-dispatched ones — surface whichever this agent has.
  const resolvedTask = useMemo(
    () => tasks.find((task) => task.assignedSessionId === sessionId) ?? null,
    [tasks, sessionId],
  );
  const worktree = useMemo(
    () =>
      activeSessions.find((s) => s.id === sessionId)?.worktree ??
      crossProjectSessions.find((s) => s.id === sessionId)?.worktree ??
      devProjectSessions.find((s) => s.id === sessionId)?.worktree ??
      resolvedTask?.worktree ??
      null,
    [activeSessions, crossProjectSessions, devProjectSessions, resolvedTask, sessionId],
  );
  const isSkipWorktree = resolvedTask?.skipWorktree === true;

  const [status, setStatus] = useState<WorktreeStatus | null>(null);

  useEffect(() => {
    if (!worktree) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const next = await getWorktreeStatus(worktree);
      if (!cancelled) setStatus(next);
    };
    void tick();
    const timer = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [worktree]);

  // If running with skipWorktree (admin/release task), show "Main repo" badge.
  if (isSkipWorktree) {
    return (
      <div className="wt-badge main-repo" title="Running directly in the project root — no worktree isolation">
        <span className="wt-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </span>
        <span className="wt-label">Main repo</span>
      </div>
    );
  }

  // If there's a worktree, show the existing worktree badge.
  if (worktree) {
    const changed = status?.changedFiles ?? 0;
    return (
      <div
        className="wt-badge"
        title={`Isolated worktree\nBranch: ${worktree.branch}\nForked from: ${worktree.baseBranch}\nPath: ${worktree.path}`}
      >
        <span className="wt-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.6" />
            <circle cx="6" cy="18" r="2.6" />
            <circle cx="18" cy="9" r="2.6" />
            <path d="M6 8.6v6.8" />
            <path d="M18 11.4c0 4-4 3.4-6.6 4.4" />
          </svg>
        </span>
        <span className="wt-branch">{worktree.branch}</span>
        <span className="wt-sep" aria-hidden="true">·</span>
        <span className={`wt-changes${changed > 0 ? ' dirty' : ''}`}>
          {changed === 0 ? 'no changes' : `${changed} changed`}
        </span>
      </div>
    );
  }

  // No worktree and no skipWorktree — running in the project root (non-git or
  // spawned without worktree). Show "Main repo" badge.
  return (
    <div className="wt-badge main-repo" title="Running in the project root — no worktree isolation">
      <span className="wt-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </span>
      <span className="wt-label">Main repo</span>
    </div>
  );
}
