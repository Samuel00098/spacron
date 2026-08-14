/**
 * Resource monitor — machine CPU/RAM plus per-session CPU/RAM.
 *
 * The Traycer-style surface: a small always-visible reading in the titlebar
 * (CPU + RAM, changing only its digits) that opens a dropdown with the full
 * breakdown — system gauges and one row per running terminal session, each
 * with its own CPU/RAM and a kill action.
 *
 * The numbers come from Rust (`src-tauri/src/commands/resource.rs`), which
 * owns a persistent sysinfo sampler so CPU deltas are measured *between*
 * polls. This module owns the schedule, exactly like `usage.ts`: the webview
 * knows when it is hidden, and a machine nobody is looking at shouldn't be
 * sampled on a timer.
 */

import { writable, get } from '$lib/stores/storeCompat';
import { isTauriRuntime } from '$lib/utils/tauri';

/**
 * Poll cadence *while the panel is open*. CPU% is a live number, so this is fast
 * — not the usage meters' 15 minutes, which is right for quota windows but would
 * make a CPU reading a lagging indicator of nothing.
 */
export const POLL_INTERVAL_MS = 2000;

/**
 * Poll cadence while the panel is **closed**, i.e. when the only consumers are
 * the titlebar chip and the background heavy-load watchdog in `ResourcePanel`.
 *
 * A sample is not cheap: `resource_snapshot` walks the whole process table, and
 * that measured ~100 ms on Windows at 347 processes. At the 2 s cadence that is
 * ~5% of a core burning continuously, all day, to drive a chip nobody is
 * staring at — and it competes with the agents for the machine.
 *
 * Nothing on screen while the panel is closed changes fast enough to notice the
 * difference. The one behaviour this does affect is the watchdog: it needs two
 * consecutive hot samples before it warns, so "project under heavy load" now
 * arrives ~12 s after load starts instead of ~4 s. That is a deliberate trade —
 * the toast is an ambient nudge, not an alarm.
 */
export const IDLE_POLL_INTERVAL_MS = 6000;

/**
 * How often the panel re-requests per-project disk footprints while it is
 * open. The backend walks the project roots and caches for 60s, so this
 * cadence means at most one real walk per minute per project while the panel
 * is on screen, and nothing at all while it is closed.
 */
export const DISK_POLL_INTERVAL_MS = 60 * 1000;

/** Re-poll this soon after refocus if the last reading is older. */
const REFOCUS_STALE_MS = 5000;

/** CPU% at which the chip turns amber, then red. */
export const WARN_CPU_PERCENT = 70;
export const CRITICAL_CPU_PERCENT = 90;

/** Share of machine RAM (%) at which a project's watchdog turns amber, then
 *  red. One project's agents eating 30% of the whole machine is worth a look;
 *  half the machine is a real problem. */
export const WARN_RAM_SHARE_PERCENT = 30;
export const CRITICAL_RAM_SHARE_PERCENT = 50;

/**
 * How full the MACHINE's RAM is before the system gauge warns. A different
 * question from the two above, and it needs its own numbers.
 *
 * These used to be the CPU thresholds (70/90), which is why an ordinary Windows
 * desktop sitting at 82% — a perfectly healthy machine, since an OS that leaves
 * RAM unused is wasting it — painted its gauge critical red all day and taught
 * you to ignore the one colour that was supposed to mean something. Pressure
 * starts when what is *left* runs out: at 85% of 16 GB there is ~2.4 GB free,
 * which is where an agent spawning a toolchain starts to hurt, and 95% is
 * genuinely into swapping.
 */
export const WARN_SYSTEM_RAM_PERCENT = 85;
export const CRITICAL_SYSTEM_RAM_PERCENT = 95;

export interface SystemResources {
  /** Machine-wide CPU load, 0–100. */
  cpuPercent: number | null;
  /** Logical CPUs, for turning a session's share back into core-equivalents. */
  cpuCount: number;
  memUsedBytes: number;
  memTotalBytes: number;
}

export interface SessionResources {
  /** Backend pty session id — join key to the terminal store's session list. */
  sessionId: number;
  pid: number | null;
  /**
   * The session tree's CPU as a share of the WHOLE machine, 0–100 — the same
   * scale as `SystemResources.cpuPercent`, normalized in Rust. sysinfo's raw
   * per-process number is per-core (0–100×cores) and must never reach here:
   * these values share the chip's bars and warn/critical thresholds.
   */
  cpuPercent: number | null;
  /** RAM held by the tree — private commit on Windows, RSS elsewhere. */
  memBytes: number;
  /** Live processes in the session's tree (shell + descendants). */
  processCount: number;
  alive: boolean;
}

export interface ResourceSnapshot {
  system: SystemResources;
  sessions: SessionResources[];
}

export interface ProjectDiskUsage {
  /** Project root that was scanned — matches the input `root` key. */
  root: string;
  bytes: number;
}

/**
 * A snapshot row joined to its frontend session metadata. Produced by the
 * panel; grouped by project via [`groupSessionRowsByProject`].
 */
export interface JoinedSessionRow extends SessionResources {
  displayName: string;
  brandCommand: string | null;
  brandName: string | null;
  /** Project this session belongs to (null for detached terminals). */
  projectId: string | null;
}

export interface ProjectResourceGroup {
  projectId: string | null;
  name: string;
  /** Project root — the key the disk-usage cache is indexed by. */
  root: string | null;
  rows: JoinedSessionRow[];
  /** Summed over live rows only, so a dead shell doesn't pad the totals. */
  cpuPercent: number | null;
  memBytes: number;
  processCount: number;
}

/**
 * Group joined snapshot rows by project. Open projects come first in tab
 * order, then projects that only appear via running sessions (alphabetical),
 * and sessions with no known project land in a trailing "Other" section.
 */
export function groupSessionRowsByProject(
  rows: JoinedSessionRow[],
  projectsById: Map<string, { name: string; root_path: string }>,
  openIds: string[]
): ProjectResourceGroup[] {
  const byProject = new Map<string, ProjectResourceGroup>();
  const other: ProjectResourceGroup = {
    projectId: null,
    name: 'Other',
    root: null,
    rows: [],
    cpuPercent: null,
    memBytes: 0,
    processCount: 0,
  };

  const push = (group: ProjectResourceGroup, row: JoinedSessionRow) => {
    group.rows.push(row);
    if (row.alive) {
      if (row.cpuPercent != null) group.cpuPercent = (group.cpuPercent ?? 0) + row.cpuPercent;
      group.memBytes += row.memBytes;
      group.processCount += row.processCount;
    }
  };

  for (const row of rows) {
    if (row.projectId && projectsById.has(row.projectId)) {
      let group = byProject.get(row.projectId);
      if (!group) {
        const project = projectsById.get(row.projectId)!;
        group = {
          projectId: row.projectId,
          name: project.name,
          root: project.root_path,
          rows: [],
          cpuPercent: null,
          memBytes: 0,
          processCount: 0,
        };
        byProject.set(row.projectId, group);
      }
      push(group, row);
    } else {
      push(other, row);
    }
  }

  const ordered = openIds
    .map((id) => byProject.get(id))
    .filter((g): g is ProjectResourceGroup => Boolean(g && g.rows.length > 0));
  const seen = new Set(ordered.map((g) => g.projectId));
  const rest = [...byProject.values()]
    .filter((g) => !seen.has(g.projectId) && g.rows.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...ordered, ...rest, ...(other.rows.length > 0 ? [other] : [])];
}

export interface ResourceState {
  system: SystemResources | null;
  sessions: SessionResources[];
  loading: boolean;
  /** Unix ms of the last completed snapshot, or 0 if none has finished. */
  lastFetchedAt: number;
}

export const resourceState = writable<ResourceState>({
  system: null,
  sessions: [],
  loading: false,
  lastFetchedAt: 0,
});

export const isResourcePanelOpen = writable(false);

/** Project root → on-disk bytes, from `project_disk_usage` (cached backend-side). */
export const projectDiskState = writable<{
  sizes: Record<string, number>;
  loading: boolean;
}>({ sizes: {}, loading: false });

export function toggleResourcePanel() {
  isResourcePanelOpen.update((open) => !open);
  // Opening the dropdown is a deliberate "tell me now" — top up a stale reading.
  if (get(isResourcePanelOpen)) void refreshResource();
}

export function closeResourcePanel() {
  isResourcePanelOpen.set(false);
}

/**
 * The worst live signal for the chip's severity colour: machine CPU if known,
 * else null (first poll, before the sysinfo baseline settles).
 */
export function peakCpuPercent(state: ResourceState): number | null {
  return state.system?.cpuPercent ?? null;
}

export function severityOfCpu(percent: number | null): 'normal' | 'warn' | 'critical' {
  if (percent == null) return 'normal';
  if (percent >= CRITICAL_CPU_PERCENT) return 'critical';
  if (percent >= WARN_CPU_PERCENT) return 'warn';
  return 'normal';
}

/**
 * Severity of one project's *share* of machine RAM. Not the same question as
 * [`severityOfSystemRam`] — 40% of the machine is a lot for a single project
 * and unremarkable as a total.
 */
export function severityOfRamShare(percent: number | null): 'normal' | 'warn' | 'critical' {
  if (percent == null) return 'normal';
  if (percent >= CRITICAL_RAM_SHARE_PERCENT) return 'critical';
  if (percent >= WARN_RAM_SHARE_PERCENT) return 'warn';
  return 'normal';
}

/** Severity of how full the machine's RAM is overall (0–100%). */
export function severityOfSystemRam(percent: number | null): 'normal' | 'warn' | 'critical' {
  if (percent == null) return 'normal';
  if (percent >= CRITICAL_SYSTEM_RAM_PERCENT) return 'critical';
  if (percent >= WARN_SYSTEM_RAM_PERCENT) return 'warn';
  return 'normal';
}

/** RAM as a 0–100 percentage. Null when there is no system reading yet. */
export function memPercent(state: ResourceState): number | null {
  const system = state.system;
  if (!system || system.memTotalBytes === 0) return null;
  return (system.memUsedBytes / system.memTotalBytes) * 100;
}

/**
 * Tooltip text for a session's or project's CPU share.
 *
 * The visible label is a share of the whole machine, which is the right default
 * — it is comparable with the titlebar chip and with every other row. But "8%"
 * hides whether that is one core pinned or eight cores idling, and for an agent
 * that is the interesting part, so the tooltip converts it back.
 */
export function describeCpuShare(percent: number | null, cpuCount: number | null): string {
  if (percent == null) return 'CPU unknown';
  const share = `CPU ${Math.round(percent)}% of machine`;
  if (!cpuCount || cpuCount <= 0) return share;
  return `${share} · ${((percent / 100) * cpuCount).toFixed(1)} of ${cpuCount} cores`;
}

/**
 * Tooltip for the machine CPU gauge.
 *
 * It says what the number measures because it will not match Task Manager and
 * that looks like a bug until you know why. This is `100 − % Idle Time`: the
 * share of time a processor had something to do. Task Manager shows
 * `% Processor Utility`, which weights that by how fast the clock was actually
 * running, so on a laptop that downclocks it reads materially lower — measured
 * 66% against 41% on the same machine at the same moment. Both are true; this
 * one is what psutil, htop and every other cross-platform monitor report, which
 * is the better default for a number sitting next to per-process rows measured
 * the same way.
 */
export function describeSystemCpu(percent: number | null, cpuCount: number | null): string {
  if (percent == null) return 'CPU — warming up';
  const across = cpuCount && cpuCount > 0 ? ` across ${cpuCount} logical processors` : '';
  return (
    `CPU ${Math.round(percent)}% — share of time not idle${across}. ` +
    `Task Manager weights this by clock speed and usually reads lower.`
  );
}

/** Human RAM string: `3.4 GB` / `842 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

let inFlight: Promise<void> | null = null;

/** Snapshot machine + session resources. Concurrent callers share one request. */
export async function refreshResource(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    resourceState.update((s) => ({ ...s, loading: true }));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const snapshot = await invoke<ResourceSnapshot>('resource_snapshot');
      resourceState.set({
        system: snapshot.system,
        sessions: snapshot.sessions,
        loading: false,
        lastFetchedAt: Date.now(),
      });
    } catch (err) {
      // A failed snapshot must not wipe the numbers already on screen — the
      // chip keeps its last good reading and simply doesn't advance.
      console.error('[resource] snapshot failed', err);
      resourceState.update((s) => ({ ...s, loading: false }));
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

let diskInFlight: Promise<void> | null = null;

/**
 * Refresh per-project disk usage for the given project roots. Dedupes requests
 * in flight; results merge into `projectDiskState`. Cheap to call — the Rust
 * side serves fresh hits from its 60s TTL cache.
 */
export async function refreshProjectDiskUsage(roots: string[]): Promise<void> {
  const unique = [...new Set(roots.filter(Boolean))];
  if (unique.length === 0) return;
  if (!isTauriRuntime()) return;
  if (diskInFlight) return diskInFlight;

  diskInFlight = (async () => {
    projectDiskState.update((s) => ({ ...s, loading: true }));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const usage = await invoke<ProjectDiskUsage[]>('project_disk_usage', {
        roots: unique,
      });
      projectDiskState.update((s) => {
        const sizes = { ...s.sizes };
        for (const entry of usage) sizes[entry.root] = entry.bytes;
        return { sizes, loading: false };
      });
    } catch (err) {
      console.error('[resource] project disk usage failed', err);
      projectDiskState.update((s) => ({ ...s, loading: false }));
    } finally {
      diskInFlight = null;
    }
  })();

  return diskInFlight;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;
let panelSubscription: (() => void) | null = null;

/**
 * A self-rescheduling timeout rather than `setInterval`, because the cadence is
 * not fixed — it depends on whether the panel is open (see
 * [`IDLE_POLL_INTERVAL_MS`]). Reading it fresh each hop means a cadence change
 * takes effect on the next tick without having to tear the timer down.
 */
function scheduleNextPoll(): void {
  const delay = get(isResourcePanelOpen) ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
  pollTimer = setTimeout(() => {
    // Not `return` — that would end the chain and stop polling forever once the
    // window was hidden even for one tick. Skip the sample, keep the schedule.
    if (!(typeof document !== 'undefined' && document.hidden)) {
      void refreshResource();
    }
    scheduleNextPoll();
  }, delay);
}

/**
 * Begin background polling. Idempotent — safe to call from any mount.
 *
 * Skips a tick while the window is hidden and catches up on focus instead, so
 * a backgrounded Spacron isn't sampling on a timer nobody can see.
 */
export function startResourcePolling(): void {
  if (!isTauriRuntime() || pollTimer) return;

  void refreshResource();
  scheduleNextPoll();

  // Re-arm on every open/close so the new cadence takes effect immediately
  // rather than after the pending tick — otherwise closing the panel still
  // spends one more sample at the fast rate, and opening it leaves the user
  // staring at a reading up to IDLE_POLL_INTERVAL_MS stale while the slow timer
  // runs down.
  if (!panelSubscription) {
    let wasOpen = get(isResourcePanelOpen);
    panelSubscription = isResourcePanelOpen.subscribe((open) => {
      if (open === wasOpen) return;
      wasOpen = open;
      // No live chain (polling stopped, or not started yet) — nothing to re-arm,
      // and starting one here would resurrect a stopped poller.
      if (!pollTimer) return;
      clearTimeout(pollTimer);
      pollTimer = null;
      // Opening is a deliberate "tell me now"; closing only needs the schedule.
      if (open) void refreshResource();
      scheduleNextPoll();
    });
  }

  if (!listenersBound && typeof document !== 'undefined') {
    listenersBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const { lastFetchedAt } = get(resourceState);
      if (Date.now() - lastFetchedAt > REFOCUS_STALE_MS) void refreshResource();
    });
  }
}

export function stopResourcePolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  panelSubscription?.();
  panelSubscription = null;
}
