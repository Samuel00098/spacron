/**
 * Agent activity stats — the recorder half.
 *
 * Backend and counting rules live in
 * `src-tauri/src/commands/activity_stats.rs`. This module is the reporting
 * side: it owns **dedupe** and **timing**, because both depend on webview state
 * the backend cannot see.
 *
 * Recording is fire-and-forget by design. These are decorative totals on a
 * settings pane; a failed write must never surface as an error in the middle of
 * an agent's turn, and must never delay it. Reads (`refreshActivity`) do report
 * failure, because a pane that cannot load its numbers has to say so rather
 * than render zeroes — the same lesson as the Stats tab's `enabled` bug.
 */

import { writable, get } from '$lib/stores/storeCompat';
import { isTauriRuntime } from '$lib/utils/tauri';

export interface ProviderActivity {
  /** Agent preset command — the join key for brand marks. */
  provider: string;
  agentsSpawned: number;
  turnsCompleted: number;
  turnsBlocked: number;
  workedMs: number;
}

export interface ActivitySummary {
  /** null until the first event is recorded — the pane's render gate. */
  trackingSinceMs: number | null;
  agentsSpawned: number;
  turnsCompleted: number;
  turnsBlocked: number;
  workedMs: number;
  providers: ProviderActivity[];
}

export interface ActivityState {
  summary: ActivitySummary | null;
  loading: boolean;
  error: string | null;
}

export const activityState = writable<ActivityState>({
  summary: null,
  loading: false,
  error: null,
});

/**
 * Sessions already counted as a spawn, for this app run.
 *
 * `markSessionAgentPreset` fires more than once for one session — a re-brief, a
 * re-detect, or a preset correction all call it again — so counting every call
 * would inflate "agents spawned" without bound. Session ids come from Rust and
 * are unique per run, and the store is only ever incremented, so remembering
 * them here (rather than persisting a set) is enough: a restart cannot
 * double-count a session that no longer exists.
 */
const countedSpawns = new Set<number>();

/**
 * Which agent each session is running, learned at spawn.
 *
 * The turn watcher knows only a session id, and nothing in `terminal.ts`
 * exposes "the preset for session N". Remembering it here keeps the watcher
 * free of a store lookup — and of a second import cycle into `terminal.ts`,
 * which already imports this module.
 */
const sessionProviders = new Map<number, string>();

/** Turn start instants, keyed by session. Set when a watch arms. */
const turnStarts = new Map<number, number>();

async function fireAndForget(command: string, args: Record<string, unknown>) {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(command, args);
  } catch {
    // Deliberately silent — see the module note.
  }
}

/** Count one agent session. Safe to call repeatedly for the same session. */
export function recordAgentSpawn(sessionId: number, provider: string | null | undefined) {
  if (!provider) return;
  sessionProviders.set(sessionId, provider);
  if (countedSpawns.has(sessionId)) return;
  countedSpawns.add(sessionId);
  void fireAndForget('activity_record_spawn', { provider });
}

/** A session that stops being an agent can be counted again if it becomes one. */
export function forgetAgentSpawn(sessionId: number) {
  countedSpawns.delete(sessionId);
  sessionProviders.delete(sessionId);
  turnStarts.delete(sessionId);
}

/** Mark the start of a turn. Called as the turn watcher arms. */
export function markTurnStart(sessionId: number) {
  turnStarts.set(sessionId, Date.now());
}

/**
 * Record a finished turn, using the start instant from `markTurnStart`.
 *
 * A turn on a session we never saw spawn is dropped rather than filed under
 * `unknown`: without a provider it cannot appear in any per-agent row, and a
 * total that exceeds the sum of its rows is worse than a slightly low one.
 *
 * A turn with no recorded *start* still counts — the agent did work — but
 * contributes no time, which is honest about what was measured. That split is
 * why turns and time worked are two separate cards.
 */
export function recordTurnEnd(sessionId: number, outcome: string | null | undefined) {
  const startedAt = turnStarts.get(sessionId);
  turnStarts.delete(sessionId);
  const provider = sessionProviders.get(sessionId);
  if (!provider) return;
  void fireAndForget('activity_record_turn', {
    provider,
    durationMs: startedAt ? Date.now() - startedAt : 0,
    outcome: outcome ?? null,
  });
}

export async function refreshActivity(): Promise<void> {
  if (!isTauriRuntime()) return;
  activityState.update((s) => ({ ...s, loading: true, error: null }));
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const summary = await invoke<ActivitySummary>('activity_get_summary');
    activityState.set({ summary, loading: false, error: null });
  } catch (e) {
    activityState.update((s) => ({
      ...s,
      loading: false,
      error: e instanceof Error ? e.message : String(e),
    }));
  }
}

export async function resetActivity(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const summary = await invoke<ActivitySummary>('activity_reset');
    activityState.set({ summary, loading: false, error: null });
    countedSpawns.clear();
    turnStarts.clear();
    // sessionProviders deliberately survives: those sessions are still running,
    // and forgetting them would silently stop counting their remaining turns.
  } catch (e) {
    activityState.update((s) => ({
      ...s,
      error: e instanceof Error ? e.message : String(e),
    }));
  }
}

/** True once there is anything worth rendering. */
export function hasActivity(summary: ActivitySummary | null): boolean {
  return !!summary && summary.trackingSinceMs !== null;
}

/**
 * Compact duration: `3d 4h`, `2h 15m`, `45m`, `30s`.
 *
 * Two units at most. "Time agents worked" is a scale figure, not a stopwatch,
 * and `3d 4h 12m 9s` reads as precision the underlying measurement (a bell
 * character, or an idle timeout) does not have.
 */
export function formatWorkedTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** "Tracking since 4 Aug 2026". Absolute, because a relative age of months is unreadable. */
export function formatTrackingSince(ms: number | null): string | null {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return null;
  }
}

/** Average turn length, or null when nothing timed has completed. */
export function averageTurnMs(summary: ActivitySummary | null): number | null {
  if (!summary) return null;
  const turns = summary.turnsCompleted + summary.turnsBlocked;
  if (turns === 0 || summary.workedMs <= 0) return null;
  return Math.round(summary.workedMs / turns);
}

/** Current in-memory state, for callers that cannot subscribe. */
export function currentActivity(): ActivityState {
  return get(activityState);
}
