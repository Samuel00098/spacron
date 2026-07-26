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
 * One card per agent, keyed by worktree path, showing live turn status, the
 * branch, `+N/−M` against the commit it forked from, and its changed files
 * expanding into the §7 diff viewer **pointed at the worktree** rather than the
 * open project.
 *
 * Merge and discard act on real git state, so both demand a confirmation that
 * names the branch, and discard refuses outright while the agent's session is
 * still alive — killing an agent mid-write and deleting its checkout is
 * unrecoverable. Discard goes through `reclaimWorktree`, which stages anything
 * outstanding and re-asks git before removing anything.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import {
  sessions,
  devSessions,
  allProjectSessions,
  setActiveSession,
  getAgentDisplayName,
} from '$lib/stores/terminal';
import { orchestratorTasks, stageAgentWorktree } from '$lib/stores/orchestrator';
import {
  mergeTaskWorktree,
  reclaimWorktree,
  type WorktreeInfo,
} from '$lib/services/orchestrator/worktree-manager';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';
import HunkDiffView from '$lib/components/review/HunkDiffView.tsx';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import './FleetDashboard.css';

/** How often the per-card diff stat is refreshed. Three cheap git reads each. */
const POLL_MS = 5000;

type FleetStatus = 'working' | 'awaiting' | 'finished' | 'failed' | 'exited';

interface FleetRow {
  /** Worktree path — the natural identity of a fleet member. */
  key: string;
  projectId: string;
  agentName: string;
  agentPreset: string | null;
  worktree: WorktreeInfo;
  /** True while the owning agent's pane is still alive. */
  live: boolean;
  sessionId: number | null;
  task: OrchestratorTask | null;
  status: FleetStatus;
}

interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

interface DiffStat {
  files: FileStat[];
  total_additions: number;
  total_deletions: number;
}

const STATUS_LABEL: Record<FleetStatus, string> = {
  working: 'Working',
  awaiting: 'Awaiting input',
  finished: 'Finished',
  failed: 'Failed',
  exited: 'Exited',
};

/**
 * Derive a card's status.
 *
 * Reads the orchestrator task where there is one — its `blocked`/`complete`
 * states come from the turn watcher, which since §0b is driven by a sentinel
 * the agent emits rather than a guess about its screen. A dashboard fed by
 * screen-scraped turn state would be presenting a guess as a fact, which is
 * why this item was sequenced after that one.
 */
function statusFor(task: OrchestratorTask | null, live: boolean): FleetStatus {
  if (task) {
    if (task.status === 'blocked') return 'awaiting';
    if (task.status === 'complete') return 'finished';
    if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
    if (task.status === 'in-progress') return live ? 'working' : 'exited';
  }
  return live ? 'working' : 'exited';
}

export default function FleetDashboard() {
  const project = useStore(activeProject);
  const projectId = project?.id ?? null;
  const tasks = useStore(orchestratorTasks);
  // All three session stores, per the lookup gotcha in
  // `.spacron/memory/agent-worktrees.md`: `sessions` is the active project's
  // non-dev panes only, `devSessions` never reaches `allProjectSessions`, and
  // an agent spawned into the Development ambient lives solely in the latter.
  // Reading one store alone silently drops whole agents from the fleet.
  const activeSessions = useStore(sessions);
  const devProjectSessions = useStore(devSessions);
  const crossProjectSessions = useStore(allProjectSessions);

  const [stats, setStats] = useState<Record<string, DiffStat>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openFileKey, setOpenFileKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** Pending destructive action awaiting explicit confirmation. */
  const [confirming, setConfirming] = useState<{ key: string; action: 'merge' | 'discard' } | null>(null);

  const rows = useMemo<FleetRow[]>(() => {
    if (!projectId) return [];
    const byPath = new Map<string, FleetRow>();

    const allSessions = [...activeSessions, ...devProjectSessions, ...crossProjectSessions];
    for (const session of allSessions) {
      if (!session.worktree || session.projectId !== projectId) continue;
      // A session already recorded is the same pane seen through another store.
      // Keep the first, but never let a later copy downgrade `live`.
      const existing = byPath.get(session.worktree.path);
      if (existing) {
        existing.live = existing.live || session.isRunning === true;
        continue;
      }
      const task = tasks.find(
        (t) => t.assignedSessionId === session.id || t.lastSessionId === session.id,
      ) ?? null;
      byPath.set(session.worktree.path, {
        key: session.worktree.path,
        projectId,
        agentName:
          session.agentName?.trim() || getAgentDisplayName(session.agentPreset) || 'Agent',
        agentPreset: session.agentPreset ?? null,
        worktree: session.worktree,
        live: session.isRunning === true,
        sessionId: session.id,
        task,
        status: statusFor(task, session.isRunning === true),
      });
    }

    // Task-owned worktrees (orchestrator-dispatched agents). A session-owned
    // entry already carries live status, so don't overwrite it.
    for (const task of tasks) {
      if (!task.worktree || task.projectId !== projectId) continue;
      if (byPath.has(task.worktree.path)) continue;
      const sessionId = task.assignedSessionId ?? task.lastSessionId ?? null;
      const live =
        sessionId !== null && allSessions.some((s) => s.id === sessionId && s.isRunning);
      byPath.set(task.worktree.path, {
        key: task.worktree.path,
        projectId,
        agentName: task.name?.trim() || getAgentDisplayName(task.agentPreset) || 'Agent',
        agentPreset: task.agentPreset ?? null,
        worktree: task.worktree,
        live,
        sessionId,
        task,
        status: statusFor(task, live),
      });
    }

    return [...byPath.values()].sort((a, b) => a.agentName.localeCompare(b.agentName));
  }, [projectId, tasks, activeSessions, devProjectSessions, crossProjectSessions]);

  const refreshStats = useCallback(
    async (list: FleetRow[]) => {
      const next: Record<string, DiffStat> = {};
      await Promise.all(
        list.map(async (row) => {
          try {
            next[row.key] = await invoke<DiffStat>('workspace_git_worktree_diff_stat', {
              projectId: row.projectId,
              worktreePath: row.worktree.path,
              baseCommit: row.worktree.baseCommit,
            });
          } catch {
            // A worktree removed underneath us, or git unavailable. Leave it out
            // rather than blanking every other card's numbers.
          }
        }),
      );
      setStats((current) => ({ ...current, ...next }));
    },
    [],
  );

  // Poll while the panel is open. `rows` is stable between renders unless the
  // fleet actually changes, so this restarts only when it does.
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refreshStats(rows);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rows, refreshStats]);

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
    withBusy(row.key, async () => {
      try {
        const result = await mergeTaskWorktree(row.projectId, row.worktree, false);
        if (result.conflicted) {
          showToast(
            `${row.agentName}: merge hit conflicts — resolve them in Source Control.`,
            'warning',
            14000,
            true,
          );
        } else if (result.success) {
          showToast(
            `Merged ${row.worktree.branch} into ${row.worktree.baseBranch}.`,
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
    withBusy(row.key, async () => {
      try {
        // `reclaimWorktree`, never a bare remove: it stages anything outstanding
        // and re-reads git before deleting, so a write that lands mid-operation
        // isn't destroyed unseen. It reports back instead of removing when work
        // can't be moved.
        const outcome = await reclaimWorktree(row.projectId, row.worktree, {
          deleteBranch: true,
        });
        if (outcome.removed) {
          showToast(
            outcome.staged > 0
              ? `Discarded ${row.worktree.branch} — ${outcome.staged} file change${outcome.staged === 1 ? '' : 's'} were staged into Source Control first.`
              : `Discarded ${row.worktree.branch}.`,
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
    withBusy(row.key, async () => {
      try {
        await stageAgentWorktree(row.projectId, row.worktree);
      } catch (err) {
        showToast(String(err), 'error', 10000);
      }
      await refreshStats(rows);
    });
  }

  if (!project) {
    return <div className="fleet-empty">Open a project to see its agent fleet.</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="fleet-empty">
        <strong>No agents with isolated worktrees.</strong>
        <span>
          Spawn agents and each one gets its own branch and checkout. What they
          produce shows up here, ready to review, merge, or throw away.
        </span>
      </div>
    );
  }

  return (
    <div className="fleet-root">
      <header className="fleet-head">
        <span className="fleet-title">AGENT FLEET</span>
        <span className="fleet-count">
          {rows.length} worktree{rows.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="fleet-grid">
        {rows.map((row) => {
          const stat = stats[row.key];
          const isBusy = busy.has(row.key);
          const isExpanded = expanded === row.key;
          const pendingConfirm = confirming?.key === row.key ? confirming.action : null;

          return (
            <article className={`fleet-card status-${row.status}`} key={row.key}>
              <header className="fc-head">
                <AgentBrandMark
                  command={row.agentPreset}
                  name={row.agentName}
                  className="fc-brand"
                />
                <span className="fc-name" title={row.task?.goal ?? row.agentName}>
                  {row.agentName}
                </span>
                <span className={`fc-status fc-status-${row.status}`}>
                  {STATUS_LABEL[row.status]}
                </span>
              </header>

              <div className="fc-meta">
                <span className="fc-branch" title={`${row.worktree.branch}\nForked from ${row.worktree.baseBranch}\n${row.worktree.path}`}>
                  {row.worktree.branch}
                </span>
                {stat ? (
                  <span className="fc-stat">
                    <span className="fc-add">+{stat.total_additions}</span>
                    <span className="fc-del">&minus;{stat.total_deletions}</span>
                  </span>
                ) : (
                  <span className="fc-stat fc-stat-loading">…</span>
                )}
              </div>

              {row.worktree.stageConflict && (
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
                disabled={!stat || stat.files.length === 0}
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
                            {/* Pointed at the worktree, measured against the commit
                                it forked from. This is the §7 dependency: the diff
                                viewer takes a repo path instead of assuming the
                                active project. Read-only — merge and discard are
                                the actions here, not partial staging of finished
                                work belonging to someone else. */}
                            <HunkDiffView
                              projectId={row.projectId}
                              repoPath={row.worktree.path}
                              filePath={file.path}
                              side="unstaged"
                              baseRef={row.worktree.baseCommit}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {pendingConfirm ? (
                <div className="fc-confirm">
                  <span className="fc-confirm-text">
                    {pendingConfirm === 'merge' ? (
                      <>
                        Merge <strong>{row.worktree.branch}</strong> into{' '}
                        <strong>{row.worktree.baseBranch}</strong>?
                      </>
                    ) : (
                      <>
                        Delete the worktree and branch <strong>{row.worktree.branch}</strong>?
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
                <div className="fc-actions">
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
                    title={`Merge ${row.worktree.branch} into ${row.worktree.baseBranch}`}
                  >
                    Merge into {row.worktree.baseBranch}
                  </button>
                  <button
                    className="fc-btn danger"
                    onClick={() => setConfirming({ key: row.key, action: 'discard' })}
                    // Refusing while the pane is live is the safety rule, not a
                    // convenience: killing an agent mid-write and deleting its
                    // checkout cannot be undone.
                    disabled={isBusy || row.live}
                    title={
                      row.live
                        ? 'Close this agent first — discarding a worktree while it is still writing is unrecoverable'
                        : `Delete the worktree and branch ${row.worktree.branch}`
                    }
                  >
                    Discard
                  </button>
                  {row.sessionId !== null && (
                    <button
                      className="fc-btn"
                      onClick={() => setActiveSession(row.sessionId!)}
                      title="Focus this agent's terminal"
                    >
                      Terminal
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
