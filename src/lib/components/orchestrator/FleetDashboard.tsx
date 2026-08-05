/**
 * Agent Fleet Dashboard — one view of what every agent in the fleet produced.
 *
 * Spacron can already *create* a fleet of agents in isolated worktrees; until
 * this existed there was no way to *judge* what they made. Reviewing four
 * agents meant switching to each room, reading its terminal, then going to
 * Source Control — which is scoped to the open project, not to that agent's
 * worktree — and repeating. The hard part (worktree isolation and
 * reconciliation) was done; the part a person actually touches was missing.
 *
 * One card per agent, showing live turn status, where it is working, `+N/−M`,
 * and its changed files expanding into the §7 diff viewer **pointed at that
 * agent's repo** rather than at whatever project happens to be open.
 *
 * ## Both placements appear here
 *
 * Placement is a per-agent choice (see [[agent-placement-gate]]), so a fleet is
 * routinely mixed: some agents isolated in their own worktree, some running
 * directly in the main checkout. This panel used to key rows off
 * `session.worktree` and therefore rendered *only* the isolated ones — a
 * main-repo agent was working, visibly, in a pane, and the one screen that
 * claims to show the fleet said there was nothing there. The two placements
 * differ in what you can *do*, not in whether they exist:
 *
 * - **Isolated worktree** — its own branch, so Bring in / Merge / Discard all
 *   mean something. Numbers are measured against the commit it forked from.
 * - **Main repo** — no branch of its own; its edits are already sitting in your
 *   working tree. There is nothing to merge and nothing safe to discard, so the
 *   card is review-only: status, `+N/−M` against HEAD, and the file diffs.
 *   Those numbers are the *checkout's* uncommitted work, which is shared with
 *   you and with any other main-repo agent — the card says so rather than
 *   implying the agent authored all of it.
 *
 * Merge and discard act on real git state, so both demand a confirmation that
 * names the branch, and discard refuses outright while the agent's session is
 * still alive — killing an agent mid-write and deleting its checkout is
 * unrecoverable. Discard goes through `reclaimWorktree`, which stages anything
 * outstanding and re-asks git before removing anything.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { setActiveSession } from '$lib/stores/terminal';
import { stageAgentWorktree } from '$lib/stores/orchestrator';
import { mergeTaskWorktree, reclaimWorktree } from '$lib/services/orchestrator/worktree-manager';
import {
  useFleetRows,
  useFleetStats,
  statKey,
  FLEET_POLL_MS,
  FLEET_STATUS_LABEL,
  type FleetRow,
} from './useFleetRows';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import HunkDiffView from '$lib/components/review/HunkDiffView.tsx';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import './FleetDashboard.css';

export default function FleetDashboard() {
  const project = useStore(activeProject);
  const projectId = project?.id ?? null;
  // Rows and their diff stats are derived in `useFleetRows` so this panel and
  // the stream shell can never disagree about who is in the fleet.
  const rows = useFleetRows();
  const { stats, refresh: refreshStats } = useFleetStats(rows);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [openFileKey, setOpenFileKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** Pending destructive action awaiting explicit confirmation. */
  const [confirming, setConfirming] = useState<{ key: string; action: 'merge' | 'discard' } | null>(null);
  /** The checkout's own branch, for labelling main-repo cards. */
  const [mainBranch, setMainBranch] = useState<string | null>(null);


  // Main-repo cards name the branch the agent is actually sitting on, which is
  // the checkout's — and it moves under them if you check something else out.
  const hasMainRepoRow = rows.some((row) => row.placement === 'main');
  useEffect(() => {
    if (!projectId || !hasMainRepoRow) {
      setMainBranch(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const status = await invoke<{ branch: string }>('workspace_git_status', { projectId });
        if (!cancelled) setMainBranch(status.branch?.trim() || null);
      } catch {
        // Not a git repo, or git unavailable — the card falls back to saying
        // "main repo" without a branch, which is still true.
        if (!cancelled) setMainBranch(null);
      }
    };
    void read();
    const timer = setInterval(read, FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, hasMainRepoRow]);

  function withBusy(key: string, fn: () => Promise<void>) {
    setBusy((current) => new Set(current).add(key));
    void fn().finally(() => {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    });
  }

  function doMerge(row: FleetRow) {
    setConfirming(null);
    const worktree = row.worktree;
    if (!worktree) return;
    withBusy(row.key, async () => {
      try {
        const result = await mergeTaskWorktree(row.projectId, worktree, false);
        if (result.conflicted) {
          showToast(
            `${row.agentName}: merge hit conflicts — resolve them in Source Control.`,
            'warning',
            14000,
            true,
          );
        } else if (result.success) {
          showToast(
            `Merged ${worktree.branch} into ${worktree.baseBranch}.`,
            'success',
            8000,
          );
        } else {
          showToast(result.message || 'Merge failed.', 'error', 10000);
        }
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refreshStats(rows);
    });
  }

  function doDiscard(row: FleetRow) {
    setConfirming(null);
    const worktree = row.worktree;
    if (!worktree) return;
    withBusy(row.key, async () => {
      try {
        // `reclaimWorktree`, never a bare remove: it stages anything outstanding
        // and re-reads git before deleting, so a write that lands mid-operation
        // isn't destroyed unseen. It reports back instead of removing when work
        // can't be moved.
        const outcome = await reclaimWorktree(row.projectId, worktree, {
          deleteBranch: true,
        });
        if (outcome.removed) {
          showToast(
            outcome.staged > 0
              ? `Discarded ${worktree.branch} — ${outcome.staged} file change${outcome.staged === 1 ? '' : 's'} were staged into Source Control first.`
              : `Discarded ${worktree.branch}.`,
            'success',
            8000,
          );
          setExpanded((current) => (current === row.key ? null : current));
        } else if (outcome.reason === 'conflict') {
          showToast(
            `${row.agentName}: can't discard — staging its work conflicts with your edits. Resolve in Source Control, then try again.`,
            'warning',
            14000,
            true,
          );
        } else if (outcome.reason === 'pending') {
          showToast(
            `${row.agentName}: kept the worktree — ${outcome.pendingFiles} file change${outcome.pendingFiles === 1 ? '' : 's'} still hadn't reached your working tree.`,
            'warning',
            12000,
          );
        } else {
          showToast(outcome.message || 'Could not discard the worktree.', 'error', 10000);
        }
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refreshStats(rows);
    });
  }

  function doStage(row: FleetRow) {
    const worktree = row.worktree;
    if (!worktree) return;
    withBusy(row.key, async () => {
      try {
        await stageAgentWorktree(row.projectId, worktree);
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refreshStats(rows);
    });
  }

  if (!project) {
    return <div className="fleet-empty">Open a project to see what its agents changed.</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="fleet-empty">
        <strong>No agents running in this project.</strong>
        <span>
          Spawn agents and they show up here whether they take their own branch
          and checkout or work directly in the main repo — isolated ones ready to
          review, merge, or throw away; main-repo ones ready to read.
        </span>
      </div>
    );
  }

  const isolatedCount = rows.filter((row) => row.placement === 'worktree').length;

  return (
    <div className="fleet-root">
      <header className="fleet-head">
        <span className="fleet-title">AGENT CHANGES</span>
        <span className="fleet-count">
          {rows.length} agent{rows.length === 1 ? '' : 's'}
          {isolatedCount > 0 && isolatedCount < rows.length && ` · ${isolatedCount} isolated`}
        </span>
      </header>

      <div className="fleet-grid">
        {rows.map((row) => {
          const stat = stats[statKey(row)];
          const isBusy = busy.has(row.key);
          const isExpanded = expanded === row.key;
          const pendingConfirm = confirming?.key === row.key ? confirming.action : null;
          const worktree = row.worktree;
          const hasFiles = Boolean(stat && stat.files.length > 0);

          return (
            <article
              className={`fleet-card status-${row.status} placement-${row.placement}`}
              key={row.key}
            >
              {/* Identity and state in one two-line grid: the mark spans both
                  rows, name/status on top, branch/diffstat beneath. The mark
                  sits in a fixed tile because AgentBrandMark draws at 100% of
                  whatever contains it — an unsized parent lets a fetched
                  favicon render at its own intrinsic size. */}
              <header className="fc-head">
                <span className="fc-brand-tile">
                  <AgentBrandMark
                    command={row.agentPreset}
                    name={row.agentName}
                    className="fc-brand"
                  />
                </span>
                <span className="fc-name" title={row.task?.goal ?? row.agentName}>
                  {row.agentName}
                </span>
                <span className={`fc-status fc-status-${row.status}`}>
                  <i className="fc-status-dot" aria-hidden="true" />
                  {FLEET_STATUS_LABEL[row.status]}
                </span>
                {worktree ? (
                  <span
                    className="fc-branch"
                    title={`Isolated worktree\n${worktree.branch}\nForked from ${worktree.baseBranch}\n${worktree.path}`}
                  >
                    {worktree.branch}
                  </span>
                ) : (
                  /* Named for what it is. Without this the card would show a
                     branch name identical to the user's own and read as if the
                     agent had somewhere of its own to merge back from. */
                  <span
                    className="fc-branch"
                    title={`Running in the project root — no worktree isolation.\nIts edits go straight into your checkout${mainBranch ? ` on ${mainBranch}` : ''}.`}
                  >
                    <span className="fc-placement">main repo</span>
                    {mainBranch && <span className="fc-branch-name">{mainBranch}</span>}
                  </span>
                )}
                {stat ? (
                  <span className="fc-stat">
                    <span className="fc-add">+{stat.total_additions}</span>
                    <span className="fc-del">&minus;{stat.total_deletions}</span>
                  </span>
                ) : (
                  <span className="fc-stat fc-stat-loading">…</span>
                )}
              </header>

              {worktree?.stageConflict && (
                <div className="fc-warning">
                  Staging is paused — this worktree conflicts with edits already in
                  your working tree. Resolve them in Source Control, then stage again.
                </div>
              )}

              <button
                className="fc-files-toggle"
                onClick={() => {
                  setExpanded((current) => (current === row.key ? null : row.key));
                  setOpenFileKey(null);
                }}
                aria-expanded={isExpanded}
                disabled={!hasFiles}
              >
                <svg
                  className={`fc-caret${isExpanded ? ' expanded' : ''}`}
                  width="9" height="9" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {!stat
                  ? 'Reading changes…'
                  : stat.files.length === 0
                    ? 'No changes yet'
                    : `${stat.files.length} changed file${stat.files.length === 1 ? '' : 's'}`}
              </button>

              {isExpanded && stat && row.placement === 'main' && (
                /* Stated plainly, because the numbers above are the checkout's,
                   not this agent's: it works in the same tree you do, so its
                   edits are indistinguishable from yours and from any other
                   main-repo agent's. Isolated cards need no such note — there
                   the diff really is that one agent's. */
                <div className="fc-note">
                  Everything uncommitted in your checkout — this agent shares it
                  with you and with any other agent running in the main repo.
                </div>
              )}

              {isExpanded && stat && (
                <div className="fc-files">
                  {stat.files.map((file) => {
                    const fileKey = `${row.key}::${file.path}`;
                    const fileOpen = openFileKey === fileKey;
                    return (
                      <div className="fc-file" key={file.path}>
                        <button
                          className="fc-file-row"
                          onClick={() => setOpenFileKey(fileOpen ? null : fileKey)}
                          title={`${fileOpen ? 'Hide' : 'Show'} diff for ${file.path}`}
                        >
                          <FileIcon name={file.path.split('/').pop() || ''} isDir={false} />
                          <span className="fc-file-path">{file.path}</span>
                          <span className={`fc-file-badge ${file.status}`}>
                            {file.status.charAt(0).toUpperCase()}
                          </span>
                          <span className="fc-file-stat">
                            <span className="fc-add">+{file.additions}</span>
                            <span className="fc-del">&minus;{file.deletions}</span>
                          </span>
                        </button>
                        {fileOpen && (
                          <div className="fc-file-diff">
                            {/* Pointed at the agent's own repo, measured against
                                the base the stat above used — `stat.base_commit`
                                rather than `row.baseCommit`, because a main-repo
                                row asks for HEAD without knowing its sha and the
                                two views must agree. This is the §7 dependency:
                                the diff viewer takes a repo path instead of
                                assuming the active project. Read-only — merge and
                                discard are the actions here, not partial staging
                                of finished work belonging to someone else. */}
                            <HunkDiffView
                              projectId={row.projectId}
                              repoPath={row.repoPath}
                              filePath={file.path}
                              side="unstaged"
                              baseRef={stat.base_commit}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {pendingConfirm && worktree ? (
                <div className="fc-confirm">
                  <span className="fc-confirm-text">
                    {pendingConfirm === 'merge' ? (
                      <>
                        Merge <strong>{worktree.branch}</strong> into{' '}
                        <strong>{worktree.baseBranch}</strong>?
                      </>
                    ) : (
                      <>
                        Delete the worktree and branch <strong>{worktree.branch}</strong>?
                        Anything not yet in your working tree is staged first.
                      </>
                    )}
                  </span>
                  <div className="fc-confirm-actions">
                    <button
                      className={`fc-btn ${pendingConfirm === 'discard' ? 'danger' : 'primary'}`}
                      onClick={() =>
                        pendingConfirm === 'merge' ? doMerge(row) : doDiscard(row)
                      }
                      disabled={isBusy}
                    >
                      {pendingConfirm === 'merge' ? 'Merge' : 'Discard'}
                    </button>
                    <button className="fc-btn" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* Split into two groups so the row can't wrap into an
                   undifferentiated block of four equal buttons: the actions
                   that move work lead, navigation and destruction sit apart
                   and quiet.

                   A main-repo card carries only the right-hand group. Bring in,
                   Merge and Discard all name a branch this agent does not have:
                   its edits are already in your tree, so there is nothing to
                   copy across and nothing that could be thrown away without
                   throwing away your own work with it. Showing them greyed out
                   would just be four dead controls on every such card. */
                <div className="fc-actions">
                  {worktree && (
                    <div className="fc-actions-main">
                      <button
                        className="fc-btn"
                        onClick={() => doStage(row)}
                        disabled={isBusy}
                        title="Copy this agent's changes into your working tree so you can run and review them. This is not `git add` — nothing is committed, and this worktree is kept."
                      >
                        Bring in
                      </button>
                      <button
                        className="fc-btn primary"
                        onClick={() => setConfirming({ key: row.key, action: 'merge' })}
                        disabled={isBusy}
                        title={`Merge ${worktree.branch} into ${worktree.baseBranch}`}
                      >
                        Merge into{' '}
                        {/* The base branch is arbitrary-length; clamp it here so a
                            long name can't blow the button out of the row. */}
                        <span className="fc-btn-branch">{worktree.baseBranch}</span>
                      </button>
                    </div>
                  )}
                  <div className="fc-actions-aside">
                    {/* Reading the work is the one thing every card can offer,
                        whatever the placement. It drives the same disclosure as
                        the file-count row above so there is one expanded state,
                        not two that can disagree. */}
                    <button
                      className="fc-btn quiet"
                      onClick={() => {
                        setExpanded((current) => (current === row.key ? null : row.key));
                        setOpenFileKey(null);
                      }}
                      aria-expanded={isExpanded}
                      disabled={!hasFiles}
                      title={
                        hasFiles
                          ? `${isExpanded ? 'Hide' : 'Show'} the files this agent changed`
                          : 'Nothing has changed yet'
                      }
                    >
                      {isExpanded ? 'Hide changes' : 'See changes'}
                    </button>
                    {row.sessionId !== null && (
                      <button
                        className="fc-btn quiet"
                        onClick={() => setActiveSession(row.sessionId!)}
                        title="Focus this agent's terminal"
                      >
                        Terminal
                      </button>
                    )}
                    {worktree && (
                      <button
                        className="fc-btn quiet danger"
                        onClick={() => setConfirming({ key: row.key, action: 'discard' })}
                        // Refusing while the pane is live is the safety rule, not a
                        // convenience: killing an agent mid-write and deleting its
                        // checkout cannot be undone.
                        disabled={isBusy || row.live}
                        title={
                          row.live
                            ? 'Close this agent first — discarding a worktree while it is still writing is unrecoverable'
                            : `Delete the worktree and branch ${worktree.branch}`
                        }
                      >
                        Discard
                      </button>
                    )}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
