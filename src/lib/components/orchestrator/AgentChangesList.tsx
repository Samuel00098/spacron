import { useMemo, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { autoStageAgentChanges } from '$lib/stores/settings';
import { pendingWorktreeWork } from '$lib/services/orchestrator/worktree-reconciler';
import { stageAgentWorktree } from '$lib/stores/orchestrator';
import './AgentChangesList.css';

/**
 * Standing list of agent work that hasn't reached the main checkout yet.
 *
 * Populated by the worktree reconciler, which polls git rather than reacting to
 * turn-completion events — so a row appears whether the agent just finished, is
 * mid-conversation on a later message, had its thread cleared, or the app was
 * restarted. That is the point of it: there is no state in which an agent's
 * changes exist but nothing is showing them.
 *
 * With auto-staging on this is normally empty, and only fills for the case that
 * genuinely needs a person: a conflict with edits already in the working tree.
 * Renders nothing when there's nothing outstanding.
 */
export default function AgentChangesList() {
  const project = useStore(activeProject);
  const projectId = project?.id ?? '';
  const pending = useStore(pendingWorktreeWork);
  const autoStage = useStore(autoStageAgentChanges);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () =>
      Object.values(pending)
        .filter((w) => w.projectId === projectId)
        .sort((a, b) => a.agentName.localeCompare(b.agentName)),
    [pending, projectId],
  );

  if (!projectId || rows.length === 0) return null;

  async function stage(path: string, row: (typeof rows)[number]) {
    setBusy((prev) => new Set(prev).add(path));
    try {
      await stageAgentWorktree(row.projectId, row.worktree);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  return (
    <section className="agent-changes" aria-label="Agent changes">
      <header className="ac-head">
        <span className="ac-title">Agent changes</span>
        <span className="ac-sub">
          {autoStage === false
            ? 'Auto-staging is off — stage to review and test'
            : 'Waiting to reach your working tree'}
        </span>
      </header>

      <ul className="ac-rows">
        {rows.map((row) => {
          const path = row.worktree.path;
          const isBusy = busy.has(path);
          return (
            <li key={path} className={`ac-row${row.conflicted ? ' conflicted' : ''}`}>
              <div className="ac-row-main">
                <span className="ac-agent">{row.agentName}</span>
                <span className="ac-branch" title={row.branch}>{row.branch}</span>
                {!row.live && <span className="ac-tag">closed</span>}
              </div>

              <div className="ac-row-meta">
                {row.conflicted ? (
                  <span className="ac-conflict">
                    Conflicts with your edits
                    {row.conflictedFiles.length > 0 && ` · ${row.conflictedFiles.length} file${row.conflictedFiles.length === 1 ? '' : 's'}`}
                    {' — resolve in Source Control, then stage again'}
                  </span>
                ) : (
                  <span className="ac-count">
                    {row.pendingFiles} file{row.pendingFiles === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              <button
                className="ac-stage-btn"
                onClick={() => void stage(path, row)}
                disabled={isBusy}
                title={
                  row.conflicted
                    ? 'Retry after resolving the conflicting files'
                    : "Copy this agent's changes into your working tree so you can run and review them"
                }
              >
                {isBusy ? 'Staging…' : row.conflicted ? 'Retry' : 'Stage'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
