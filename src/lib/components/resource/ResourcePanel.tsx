import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  resourceState,
  isResourcePanelOpen,
  closeResourcePanel,
  refreshProjectDiskUsage,
  POLL_INTERVAL_MS,
  DISK_POLL_INTERVAL_MS,
  projectDiskState,
  severityOfCpu,
  severityOfRamShare,
  WARN_CPU_PERCENT,
  WARN_RAM_SHARE_PERCENT,
  formatBytes,
  groupSessionRowsByProject,
  type JoinedSessionRow,
  type ProjectResourceGroup,
} from '$lib/stores/resource';
import {
  allProjectSessions,
  killSession,
  getAgentDisplayName,
} from '$lib/stores/terminal';
import { projects, openProjectIds } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { isTauriRuntime } from '$lib/utils/tauri';
import LiveTicker from '$lib/components/shared/LiveTicker';
import './ResourcePanel.css';

function relativeAge(fetchedAt: number, now: number): string {
  const secs = Math.max(0, now - fetchedAt) / 1000;
  if (secs < 1) return 'just now';
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

/**
 * The resource breakdown, anchored under the titlebar chip.
 *
 * Three halves: the machine's CPU/RAM gauges, then one section per project —
 * its disk footprint (backend `project_disk_usage`, cached for a minute) plus
 * aggregate terminals/processes/CPU/RAM — and the running terminal sessions
 * under their project, each named by its agent or "Terminal N", with its own
 * CPU/RAM and kill action. An agent running *inside* a shell reports the
 * whole tree under it (see `resource.rs`), so a busy Claude/Codex shows real
 * numbers, not the ~0% idle shell.
 *
 * Popover, not modal — same contract as the inbox panel: must not trap Tab or
 * swallow app shortcuts.
 */
export default function ResourcePanel() {
  const open = useStore(isResourcePanelOpen);
  const { system, sessions, lastFetchedAt } = useStore(resourceState);
  const panelRef = useRef<HTMLDivElement>(null);
  const allTerminalSessions = useStore(allProjectSessions);
  const openProjects = useStore(projects);
  const openIds = useStore(openProjectIds);
  const disk = useStore(projectDiskState);
  // Orca-style bulk actions (see its Resource Manager): per-project "close
  // all" needs an explicit confirm — their history (issue #8459) is exactly
  // what happens when cleanup force-kills live agent sessions. The inline
  // two-step confirm keeps the kill deliberate without a jarring native dialog.
  const [confirmCloseAll, setConfirmCloseAll] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armCloseAll = useCallback((projectId: string | null) => {
    setConfirmCloseAll(projectId);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmCloseAll(null), 4000);
  }, []);

  const doCloseAll = useCallback((sessionIds: number[]) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmCloseAll(null);
    for (const id of sessionIds) void killSession(id);
  }, []);


  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, []);

  const now = Date.now();
  const mem =
    system && system.memTotalBytes > 0
      ? (system.memUsedBytes / system.memTotalBytes) * 100
      : null;

  // Join snapshot rows to frontend session metadata (agent, project, brand) by
  // pty id. Naming is deliberately bare: an agent row is named by its agent
  // (the orchestrator's name for it, else the CLI's display name); everything
  // else — user terminals and sessions with no frontend metadata — is simply
  // "Terminal N", numbered per project section. `paneTitle`/`taskSummary` are
  // NOT used: they describe what the CLI is doing inside the terminal, which
  // is exactly what this panel is not for.
  const rows = useMemo(() => {
    const meta = new Map(allTerminalSessions.map((s) => [s.id, s]));
    const plainByProject = new Map<string | null, number>();
    return sessions.map((r) => {
      const session = meta.get(r.sessionId);
      const agentPreset = session?.agentPreset ?? null;
      const agentLabel =
        agentPreset &&
        (session?.agentName?.trim() || getAgentDisplayName(agentPreset) || agentPreset);
      let displayName: string;
      let brandCommand: string | null;
      if (agentLabel) {
        displayName = agentLabel;
        brandCommand = agentPreset;
      } else {
        const projectKey = session?.projectId ?? null;
        const n = (plainByProject.get(projectKey) ?? 0) + 1;
        plainByProject.set(projectKey, n);
        displayName = `Terminal ${n}`;
        brandCommand = null;
      }
      const brandName = brandCommand ? getAgentDisplayName(brandCommand) : null;
      const joined: JoinedSessionRow = {
        ...r,
        displayName,
        brandCommand,
        brandName,
        projectId: session?.projectId ?? null,
      };
      return joined;
    });
  }, [sessions, allTerminalSessions]);


  // Orca's orphan sweep: rows whose OS process is gone (alive = false) are
  // stale bookkeeping — the frontend session lingers until the exit callback
  // lands. One "clear N exited" action closes them all instead of making the
  // user click each greyed row's kill button (which is hidden at low opacity).
  const deadRows = useMemo(() => rows.filter((r) => !r.alive), [rows]);

  // Group rows by project, ordered like the project tabs (open order first,
  // then projects that only appear via running sessions, "Other" last).
  const groups = useMemo<ProjectResourceGroup[]>(() => {
    return groupSessionRowsByProject(rows, openProjects, openIds);
  }, [rows, openProjects, openIds]);

  // Watchdog: surface a toast when a project's agents cross the CPU/RAM
  // thresholds — one alert per episode, never a toast every 2s poll. Runs
  // whether or not the dropdown is open, so an agent silently pegging the
  // machine still gets flagged.
  //
  // Debounced to two consecutive hot polls before firing: the tree-sum's first
  // reading for a freshly spawned process reads as total-CPU-since-spawn (see
  // resource.rs), a one-poll spike that must not raise a false alarm.
  const warnedProjectsRef = useRef<Set<string>>(new Set());
  const hotStreakRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const group of groups) {
      const key = group.projectId ?? 'other';
      const ramShare =
        system && system.memTotalBytes > 0 ? (group.memBytes / system.memTotalBytes) * 100 : 0;
      const hot =
        severityOfCpu(group.cpuPercent) !== 'normal' ||
        severityOfRamShare(ramShare) !== 'normal';
      if (hot) {
        const streak = (hotStreakRef.current.get(key) ?? 0) + 1;
        hotStreakRef.current.set(key, streak);
        if (streak < 2) continue;
        if (warnedProjectsRef.current.has(key)) continue;
        warnedProjectsRef.current.add(key);
        const bits: string[] = [];
        if (group.cpuPercent != null && group.cpuPercent >= WARN_CPU_PERCENT) {
          bits.push(`${Math.round(group.cpuPercent)}% CPU`);
        }
        if (ramShare >= WARN_RAM_SHARE_PERCENT) {
          bits.push(`${Math.round(ramShare)}% of machine RAM (${formatBytes(group.memBytes)})`);
        }
        showToast(
          `${group.name} is under heavy load — ${bits.join(', ') || 'high resource use'}. Check the resource panel.`,
          'warning',
          7000,
        );
      } else {
        hotStreakRef.current.delete(key);
        warnedProjectsRef.current.delete(key);
      }
    }
  }, [groups, system]);

  // Disk usage is expensive to walk; ask for it only while the panel is open.
  // The backend's 60s cache keeps repeated requests cheap, so the panel
  // re-requests once a minute and footprints stay live without a Refresh
  // button. The roots live in a ref because the memoized `groups` change every
  // 2s snapshot — depending on them would restart the interval each poll and
  // it would never fire.
  const diskRootsRef = useRef<string[]>([]);
  diskRootsRef.current = groups
    .map((g) => g.root)
    .filter((r): r is string => Boolean(r));
  useEffect(() => {
    if (!open) return;
    void refreshProjectDiskUsage(diskRootsRef.current);
    const id = setInterval(
      () => void refreshProjectDiskUsage(diskRootsRef.current),
      DISK_POLL_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [open]);

  // Popover, not modal — same outside-click + Escape contract as the inbox.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeResourcePanel();
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target ?? null)) return;
      // The chip toggles on its own click; ignoring it here stops the two
      // handlers cancelling each other into a no-op.
      if (target instanceof Element && target.closest('[data-resource-toggle]')) return;
      closeResourcePanel();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  if (!open) return null;

  const cpu = system?.cpuPercent ?? null;
  const cpuSeverity = severityOfCpu(cpu);

  return (
    <div className="resource-panel" ref={panelRef} role="dialog" aria-label="Machine and project resources">
      <header className="resource-head">
        <span className="resource-title">
          Resources
          {lastFetchedAt > 0 && (
            <span className="resource-head-age">updated {relativeAge(lastFetchedAt, now)}</span>
          )}
        </span>
        <div className="resource-head-actions">
          <LiveTicker
            intervalMs={POLL_INTERVAL_MS}
            lastFetchedAt={lastFetchedAt}
            countdown={false}
            liveLabel="Live"
          />
          <button
            className="resource-close"
            onClick={closeResourcePanel}
            aria-label="Close resources"
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* Machine gauges — always shown once the first snapshot lands. */}
      {system ? (
        <section className="resource-system">
          <div className="resource-gauge">
            <span className="resource-gauge-label">CPU</span>
            <span className="resource-gauge-track">
              <span
                className="resource-gauge-fill"
                data-severity={cpuSeverity}
                style={{ width: `${Math.min(100, cpu ?? 0)}%` }}
              />
            </span>
            <span className="resource-gauge-value">
              {cpu != null ? `${Math.round(cpu)}%` : '…'}
            </span>
          </div>
          <div className="resource-gauge">
            <span className="resource-gauge-label">RAM</span>
            <span className="resource-gauge-track">
              <span
                className="resource-gauge-fill"
                data-severity={mem != null ? severityOfCpu(mem) : 'normal'}
                style={{ width: `${Math.min(100, mem ?? 0)}%` }}
              />
            </span>
            <span className="resource-gauge-value">
              {system.memTotalBytes > 0
                ? `${formatBytes(system.memUsedBytes)} / ${formatBytes(system.memTotalBytes)}`
                : '…'}
            </span>
          </div>
        </section>
      ) : (
        <p className="resource-empty">Warming up — first reading takes a moment.</p>
      )}

      {/* Per-project sections */}
      {groups.length === 0 ? (
        <p className="resource-empty">
          No running terminals. Projects appear here with their disk footprint and sessions.
        </p>
      ) : (
        <div className="resource-groups">
          {groups.map((group) => {
            const diskBytes = group.root ? disk.sizes[group.root] : undefined;
            const ramShare =
              system && system.memTotalBytes > 0
                ? (group.memBytes / system.memTotalBytes) * 100
                : null;
            return (
              <section key={group.projectId ?? 'other'} className="resource-project">
                <header className="resource-project-head">
                  <div className="resource-project-title-row">
                    <span className="resource-project-name" title={group.root ?? undefined}>
                      {group.name}
                    </span>
                    {group.rows.some((r) => r.alive) && (
                      <button
                        className="resource-project-close-all"
                        data-confirming={confirmCloseAll === (group.projectId ?? 'other') ? 'true' : 'false'}
                        onClick={() => {
                          const key = group.projectId ?? 'other';
                          if (confirmCloseAll === key) {
                            doCloseAll(group.rows.map((r) => r.sessionId));
                          } else {
                            armCloseAll(key);
                          }
                        }}
                        title={confirmCloseAll === (group.projectId ?? 'other') ? 'Click again to confirm' : 'Close every terminal in this project'}
                      >
                        {confirmCloseAll === (group.projectId ?? 'other') ? 'Confirm?' : 'Close all'}
                      </button>
                    )}
                  </div>
                  <span className="resource-project-meta">
                    {diskBytes != null && (
                      <span className="resource-project-stat resource-project-disk">
                        {formatBytes(diskBytes)}
                      </span>
                    )}
                    <span className="resource-project-stat">
                      {group.rows.length} terminal{group.rows.length === 1 ? '' : 's'}
                    </span>
                    {group.processCount > 0 && (
                      <span className="resource-project-stat">
                        {group.processCount} proc{group.processCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {group.cpuPercent != null && (
                      <span
                        className="resource-project-stat"
                        data-severity={severityOfCpu(group.cpuPercent)}
                      >
                        {Math.round(group.cpuPercent)}% CPU
                      </span>
                    )}
                    {group.memBytes > 0 && (
                      <span
                        className="resource-project-stat"
                        data-severity={ramShare != null ? severityOfRamShare(ramShare) : 'normal'}
                        title={ramShare != null ? `${Math.round(ramShare)}% of machine RAM` : undefined}
                      >
                        {formatBytes(group.memBytes)} RAM
                        {ramShare != null ? ` · ${Math.round(ramShare)}%` : ''}
                      </span>
                    )}
                  </span>
                </header>
                <ul className="resource-list">
                  {group.rows.map((row) => (
                    <li key={row.sessionId} className="resource-row" data-alive={row.alive ? 'true' : 'false'}>
                      <span className="resource-row-mark" aria-hidden="true">
                        {row.brandCommand ? (
                          <AgentBrandMark command={row.brandCommand} name={row.brandName} />
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <path d="M3 9h18M9 21V9" />
                          </svg>
                        )}
                      </span>
                      <span className="resource-row-title" title={row.displayName}>
                        {row.displayName}
                      </span>
                      <span className="resource-row-stats">
                        <span
                          className="resource-mini-stat"
                          title={`CPU ${row.cpuPercent != null ? `${Math.round(row.cpuPercent)}%` : 'unknown'}`}
                        >
                          <span className="resource-mini-track" aria-hidden="true">
                            <span
                              className="resource-mini-fill"
                              data-severity={severityOfCpu(row.cpuPercent)}
                              style={{ width: `${Math.min(100, row.cpuPercent ?? 0)}%` }}
                            />
                          </span>
                          <span className="resource-mini-value">
                            {row.cpuPercent != null ? `${Math.round(row.cpuPercent)}%` : '–'}
                          </span>
                        </span>
                        <span className="resource-mini-stat" title={`RAM ${formatBytes(row.memBytes)}`}>
                          <span className="resource-mini-track" aria-hidden="true">
                            <span
                              className="resource-mini-fill resource-mini-fill-mem"
                              style={{
                                // Share of the machine's total RAM — a 1.5 GB
                                // agent on a 32 GB box fills 4.7% of the track,
                                // the same bar the machine gauge uses. The floor
                                // keeps a nonzero sliver visible; the label
                                // beside the bar always shows the true bytes.
                                width: `${row.memBytes > 0 && system && system.memTotalBytes > 0 ? Math.max(2, (row.memBytes / system.memTotalBytes) * 100) : 0}%`,
                              }}
                            />
                          </span>
                          <span className="resource-mini-value">{formatBytes(row.memBytes)}</span>
                        </span>
                      </span>
                      <button
                        className="resource-row-kill"
                        onClick={() => void killSession(row.sessionId)}
                        aria-label={`Close ${row.displayName}`}
                        title="Close this terminal"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {deadRows.length > 0 && (
        <footer className="resource-sweep">
          <span className="resource-sweep-label">
            {deadRows.length} exited session{deadRows.length === 1 ? '' : 's'}
          </span>
          <button
            className="resource-sweep-button"
            onClick={() => doCloseAll(deadRows.map((r) => r.sessionId))}
            title="Remove exited sessions from this list"
          >
            Clear exited
          </button>
        </footer>
      )}

      {!isTauriRuntime() && (
        <p className="resource-note">Resource readings are available in the desktop app.</p>
      )}
    </div>
  );
}
