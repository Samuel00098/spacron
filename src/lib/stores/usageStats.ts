import { writable, get } from '$lib/stores/storeCompat';
import { isTauriRuntime } from '$lib/utils/tauri';

/**
 * Stats tab store: aggregated token / cost / session usage for the Settings →
 * Stats pane.
 *
 * The backend owns the aggregation (see usage_stats.rs, which mirrors Orca's
 * `claude-usage` scanner and its shared wire types) and returns one snapshot
 * per scope+range. This store caches the latest snapshot, remembers the
 * selected scope and range, and guards the handful of mutations the pane can
 * trigger (enable tracking, rescan, refresh).
 */

export const SCOPE_SPACRON = 'spacron';
export const SCOPE_ALL = 'all';

/** The current UTC day — the ledger is per day, so this is its finest window. */
export const RANGE_1D = '1d';
export const RANGE_7D = '7d';
export const RANGE_30D = '30d';
export const RANGE_90D = '90d';
export const RANGE_ALL = 'all';

/** Initial picker labels until the backend returns its scanned provider list. */
export const PROVIDER_ALL = 'all';
export const PROVIDER_CLAUDE = 'claude';
export const PROVIDER_CODEX = 'codex';
export const PROVIDER_OPENCODE = 'opencode';
export const PROVIDER_PI = 'pi';
export const PROVIDER_OMP = 'omp';
export const PROVIDER_COMMAND_CODE = 'command-code';
export const PROVIDER_ANTIGRAVITY = 'antigravity';

export const PROVIDER_TABS: { id: string; label: string }[] = [
  { id: PROVIDER_ALL, label: 'Overview' },
  { id: PROVIDER_CLAUDE, label: 'Claude' },
  { id: PROVIDER_CODEX, label: 'Codex' },
  { id: PROVIDER_OPENCODE, label: 'OpenCode' },
  { id: PROVIDER_PI, label: 'Pi' },
  { id: PROVIDER_OMP, label: 'OMP' },
  { id: PROVIDER_COMMAND_CODE, label: 'Command Code' },
  { id: PROVIDER_ANTIGRAVITY, label: 'Antigravity' },
];

export const DEFAULT_SCOPE = SCOPE_ALL;
/**
 * All time, not 30 days. The pane is a "what have I spent" readout, and a
 * trailing window silently hid months of history behind a filter nobody had
 * touched.
 */
export const DEFAULT_RANGE = RANGE_ALL;
export const DEFAULT_PROVIDER = PROVIDER_ALL;
const SNAPSHOT_LIMIT = 10;

/** Persisted toggle + scan bookkeeping. Mirrors Orca's `ScanState`. */
export type ScanState = {
  enabled: boolean;
  isScanning: boolean;
  /** Unix ms. `null` until the first scan actually starts. */
  lastScanStartedAt: number | null;
  lastScanCompletedAt: number | null;
  /** A non-fatal scan problem worth surfacing ("read 3 files, skipped 1"). */
  lastScanError: string | null;
  /** Whether *any* usage has ever been found, independent of scope/range. */
  hasAnyClaudeData: boolean;
};

/** The top-line numbers. Mirrors Orca's `ClaudeUsageSummary`. */
export type StatsSummary = {
  sessions: number;
  turns: number;
  /** Turns whose final reading had zero cache reads — the cache-miss share. */
  zeroCacheReadTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cacheRead / (input + cacheRead), 0..1. `null` when nothing billable. */
  cacheReuseRate: number | null;
  /** `null` when nothing was found or no model could be priced. */
  estimatedCostUsd: number | null;
  /** At least one model had no price — cost is a partial estimate. */
  hasPartialCost: boolean;
  /** Saved by cache reads against full input price, over priced models. */
  cacheSavingsUsd?: number | null;
  topModel: string | null;
  topProject: string | null;
};

/** One column of the daily chart. */
export type DailyPoint = {
  /** UTC calendar day, `2026-08-10`. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** That day's priced cost; `null` when no model that day had a price.
   *  Absent from points filled in for quiet days. */
  estimatedCostUsd?: number | null;
};

/** A top-N row in a by-model / by-project breakdown. */
export type BreakdownEntry = {
  key: string;
  label: string;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `null` when the model has no price in the table. */
  estimatedCostUsd: number | null;
};

/** One row of the recent-sessions table. */
export type SessionRow = {
  sessionId: string;
  /** Launch command of the CLI that ran it — also its brand-mark key. */
  provider: string;
  providerLabel: string;
  /** Unix ms of the last assistant turn in the session. */
  lastActiveAt: number;
  durationMinutes: number;
  projectLabel: string;
  /** Ran inside a Spacron-managed worktree rather than the main checkout. */
  managed: boolean;
  branch: string | null;
  model: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Everything one provider's pane needs in one call. */
export type StatsSnapshot = {
  scanState: ScanState;
  provider: string;
  scope: string;
  range: string;
  summary: StatsSummary;
  daily: DailyPoint[];
  modelBreakdown: BreakdownEntry[];
  projectBreakdown: BreakdownEntry[];
  recentSessions: SessionRow[];
};

/** One provider's card on the Overview. */
export type ProviderCard = {
  id: string;
  label: string;
  /** False when the CLI left no readable logs — the card says so rather than
   *  rendering a confident zero. */
  hasData: boolean;
  sessions: number;
  turns: number;
  totalTokens: number;
  /** Share of all providers' tokens, 0..1. */
  share: number;
  estimatedCostUsd: number | null;
  hasPartialCost: boolean;
  topModel: string | null;
  topProject: string | null;
  /** This provider's tokens per day over the range (one chart line). */
  daily?: DailyPoint[];
};

/** One cell of the 42-day intensity grid. `level` is 0..4, computed backend-side
 *  so the grid and its legend cannot disagree. */
export type HeatmapDay = {
  day: string;
  totalTokens: number;
  level: number;
};

/** The combined cross-provider view. */
export type StatsOverview = {
  scanState: ScanState;
  scope: string;
  range: string;
  summary: StatsSummary;
  totalTokens: number;
  activeDays: number;
  cacheShare: number | null;
  heatmap: HeatmapDay[];
  /** Every provider folded together, per day. */
  daily?: DailyPoint[];
  providers: ProviderCard[];
  modelBreakdown: BreakdownEntry[];
  projectBreakdown: BreakdownEntry[];
};

export type UsageStatsState = {
  snapshot: StatsSnapshot | null;
  overview: StatsOverview | null;
  provider: string;
  scope: string;
  range: string;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number;
};

export const usageStatsState = writable<UsageStatsState>({
  snapshot: null,
  overview: null,
  provider: DEFAULT_PROVIDER,
  scope: DEFAULT_SCOPE,
  range: DEFAULT_RANGE,
  loading: false,
  error: null,
  lastFetchedAt: 0,
});

let selectionVersion = 0;

/** Tauri rejects with plain strings as often as with `Error`s. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reload whichever view is selected, for the current scope and range.
 *
 * The Overview and a provider pane are different backend calls, so the tab
 * decides which one runs — mounting only the visible pane is also what keeps
 * the two from fighting over `loading`. Concurrent callers share one request.
 */
export async function refreshStatsSnapshot(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { provider, scope, range } = get(usageStatsState);
  const version = ++selectionVersion;
  const selected = () => version === selectionVersion;
  const request = (async () => {
    usageStatsState.update((s) => ({ ...s, loading: true, error: null }));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (provider === PROVIDER_ALL) {
        const overview = await invoke<StatsOverview>('stats_get_overview', { scope, range });
        if (!selected()) return;
        usageStatsState.update((s) => ({
          ...s,
          overview,
          loading: false,
          lastFetchedAt: Date.now(),
        }));
      } else {
        if (!get(usageStatsState).overview || get(usageStatsState).overview?.scope !== scope || get(usageStatsState).overview?.range !== range) {
          void invoke<StatsOverview>('stats_get_overview', { scope, range }).then((overview) => {
            usageStatsState.update((s) => s.scope === scope && s.range === range ? { ...s, overview } : s);
          }).catch((error) => console.error('[usageStats] provider list refresh failed', error));
        }
        const snapshot = await invoke<StatsSnapshot>('stats_get_snapshot', {
          provider,
          scope,
          range,
          limit: SNAPSHOT_LIMIT,
        });
        if (!selected()) return;
        usageStatsState.update((s) => ({
          ...s,
          snapshot,
          loading: false,
          lastFetchedAt: Date.now(),
        }));
      }
    } catch (err) {
      if (!selected()) return;
      console.error('[usageStats] refresh failed', err);
      usageStatsState.update((s) => ({ ...s, loading: false, error: errorText(err) }));
    }
  })();
  return request;
}

export function selectStatsProvider(provider: string): void {
  usageStatsState.update((s) => ({ ...s, provider, snapshot: s.provider === provider ? s.snapshot : null }));
  void refreshStatsSnapshot();
}

/**
 * Ask the backend to re-scan the transcript files, then reload the snapshot.
 * The scan never runs during a live session (transcripts only exist once the
 * agent tab is closed), so the pane calls this when the user enables tracking
 * and on its one-minute auto-rescan tick — there is no manual Rescan button.
 */
export async function scanAndRefresh(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    await invoke('stats_refresh');
    usageStatsState.update((s) => ({ ...s, overview: null }));
  } catch (err) {
    console.error('[usageStats] scan failed', err);
    usageStatsState.update((s) => ({ ...s, error: errorText(err) }));
  }
  await refreshStatsSnapshot();
}

/**
 * Flip transcript scanning on or off.
 *
 * The failure path matters more than it looks: this is the only control on the
 * pane while tracking is off, so a rejected invoke that nobody catches leaves
 * the toggle staring back unchanged with no reason given. Park the message in
 * the store instead — the pane renders it.
 */
export async function setStatsTracking(enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    await invoke('stats_set_enabled', { enabled });
  } catch (err) {
    console.error('[usageStats] could not change tracking', err);
    usageStatsState.update((s) => ({ ...s, error: errorText(err) }));
    return;
  }
  if (enabled) await scanAndRefresh();
  else await refreshStatsSnapshot();
}

export function selectStatsScope(scope: string): void {
  usageStatsState.update((s) => ({ ...s, scope }));
  void refreshStatsSnapshot();
}

export function selectStatsRange(range: string): void {
  usageStatsState.update((s) => ({ ...s, range }));
  void refreshStatsSnapshot();
}

// ---------------------------------------------------------------------------
// Pure presentation helpers (unit-tested; the pane stays dumb).
// ---------------------------------------------------------------------------

/** 0 → "0", 12_300 → "12.3K", 1_240_000 → "1.24M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}K`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** $1.8 → "$1.80". Null renders as a dash: the total is only partial. */
export function formatUsd(usd: number | null): string {
  if (usd == null) return 'n/a';
  return `$${usd.toFixed(2)}`;
}

export function totalTokens(summary: StatsSummary): number {
  return (
    summary.inputTokens +
    summary.outputTokens +
    summary.cacheReadTokens +
    summary.cacheWriteTokens
  );
}

/** Input + output for one breakdown row — what Orca ranks rows by. */
export function breakdownTokens(entry: BreakdownEntry): number {
  return entry.inputTokens + entry.outputTokens;
}

/** All four token buckets for one session row. */
export function sessionTokens(row: SessionRow): number {
  return (
    row.inputTokens +
    row.outputTokens +
    row.cacheReadTokens +
    row.cacheWriteTokens
  );
}

/**
 * What share of a set of breakdown rows a single entry owns, 0..1 — drives
 * the bar widths. `null` when there is nothing to divide.
 */
export function breakdownShare(entry: BreakdownEntry, entries: BreakdownEntry[]): number | null {
  const total = entries.reduce((sum, e) => sum + breakdownTokens(e), 0);
  if (total <= 0) return null;
  return breakdownTokens(entry) / total;
}

/**
 * Fraction of turns whose final reading had zero cache reads, 0..1. `null`
 * when there are no turns.
 */
export function zeroCacheReadShare(summary: StatsSummary): number | null {
  if (summary.turns <= 0) return null;
  return summary.zeroCacheReadTurns / summary.turns;
}

/** "2026-08-10" → "Aug 10" (UTC — the chart renders days, not instants). */
export function shortDayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(match[2]) - 1] ?? match[2];
  return `${month} ${Number(match[3])}`;
}

/** The trailing `n` daily points, oldest first — what the chart draws. */
export function lastDailyPoints(daily: DailyPoint[], n = 10): DailyPoint[] {
  return daily.slice(-n);
}

/** Calendar windows include quiet days, so every provider gets the same number
 * of columns even when its transcript contains only a few active days. */
export function calendarDailyPoints(daily: DailyPoint[], days: number, now = new Date()): DailyPoint[] {
  const byDay = new Map(daily.map((point) => [point.day, point]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today - (days - index - 1) * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  });
}

/**
 * The scan state of whichever view is loaded. Both payloads carry one, and the
 * pane gates on it before either has arrived, so it must not assume the tab.
 */
export function currentScanState(state: UsageStatsState): ScanState | null {
  return state.provider === PROVIDER_ALL
    ? (state.overview?.scanState ?? null)
    : (state.snapshot?.scanState ?? null);
}

/** 0.42 → "42%". `null` renders as a dash. */
export function formatPercent(fraction: number | null): string {
  if (fraction == null || !Number.isFinite(fraction)) return 'n/a';
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Chunk the flat 42-day grid into fixed-length columns for the calendar.
 * Orca draws two rows; the grid is generated oldest-first so the newest cell
 * lands bottom-right.
 */
export function heatmapRows(days: HeatmapDay[], rows = 2): HeatmapDay[][] {
  if (rows <= 0) return [days];
  const perRow = Math.ceil(days.length / rows);
  const out: HeatmapDay[][] = [];
  for (let i = 0; i < days.length; i += perRow) out.push(days.slice(i, i + perRow));
  return out;
}

/** The busiest day in the grid — the "Best: 26 Jul" badge. */
export function busiestDay(days: HeatmapDay[]): HeatmapDay | null {
  let best: HeatmapDay | null = null;
  for (const d of days) {
    if (d.totalTokens > 0 && (best == null || d.totalTokens > best.totalTokens)) best = d;
  }
  return best;
}

/** The three segments of the token-mix bar, as 0..1 shares. */
export function tokenMix(
  summary: StatsSummary
): { input: number; output: number; cache: number } | null {
  const total = totalTokens(summary);
  if (total <= 0) return null;
  return {
    input: summary.inputTokens / total,
    output: summary.outputTokens / total,
    cache: (summary.cacheReadTokens + summary.cacheWriteTokens) / total,
  };
}
