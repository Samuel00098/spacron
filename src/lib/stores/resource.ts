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
 * Poll cadence. CPU% is a live number, so this is fast — not the usage
 * meters' 15 minutes, which is right for quota windows but would make a CPU
 * reading a lagging indicator of nothing.
 */
export const POLL_INTERVAL_MS = 2000;

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

export interface SystemResources {
  cpuPercent: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
}

export interface SessionResources {
  /** Backend pty session id — join key to the terminal store's session list. */
  sessionId: number;
  pid: number | null;
  cpuPercent: number | null;
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

/** Severity of a *share of machine RAM* (0–100%, where 100 = all of it). */
export function severityOfRamShare(percent: number | null): 'normal' | 'warn' | 'critical' {
  if (percent == null) return 'normal';
  if (percent >= CRITICAL_RAM_SHARE_PERCENT) return 'critical';
  if (percent >= WARN_RAM_SHARE_PERCENT) return 'warn';
  return 'normal';
}

/** RAM as a 0–100 percentage. Null when there is no system reading yet. */
export function memPercent(state: ResourceState): number | null {
  const system = state.system;
  if (!system || system.memTotalBytes === 0) return null;
  return (system.memUsedBytes / system.memTotalBytes) * 100;
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

let pollTimer: ReturnType<typeof setInterval> | null = null;
let listenersBound = false;

/**
 * Begin background polling. Idempotent — safe to call from any mount.
 *
 * Skips a tick while the window is hidden and catches up on focus instead, so
 * a backgrounded Spacron isn't sampling on a timer nobody can see.
 */
export function startResourcePolling(): void {
  if (!isTauriRuntime() || pollTimer) return;

  void refreshResource();

  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void refreshResource();
  }, POLL_INTERVAL_MS);

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
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
