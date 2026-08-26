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
 * With auto-staging off (the default — Orca's review-wall model) this is the
 * standing list of everything waiting to be reviewed and brought in; with it on
 * the list is normally empty, filling only for the case that genuinely needs a
 * person: a conflict with edits already in the working tree. Renders nothing
 * when there's nothing outstanding.
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
        {/* This section lives inside Source Control, directly above file rows
            whose +/- buttons mean `git add`. Calling this button "Stage" too
            made two different operations share one word in one panel. It
            copies a worktree into your working tree; it is not `git add`. */}
        <span className="ac-sub">
          {autoStage === false
            ? 'Quarantined until you review it. Bring the work in to run and test it.'
            : 'Not in your working tree yet'}
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
                    {'. Resolve the conflicts below, then try again.'}
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
                    : "Copy this agent's changes into your working tree so you can run and review them. This is not `git add`. Nothing is committed, and the agent's branch is kept."
                }
              >
                {isBusy ? 'Bringing in…' : row.conflicted ? 'Retry' : 'Bring in'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
