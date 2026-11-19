import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { get } from '$lib/stores/storeCompat';
import {
  usageStatsState,
  refreshStatsSnapshot,
  scanAndRefresh,
  setStatsTracking,
  selectStatsScope,
  selectStatsRange,
  selectStatsProvider,
  currentScanState,
  SCOPE_ALL,
  SCOPE_SPACRON,
  RANGE_1D,
  RANGE_7D,
  RANGE_30D,
  RANGE_90D,
  RANGE_ALL,
  PROVIDER_ALL,
  PROVIDER_TABS,
  formatTokens,
  formatUsd,
  formatPercent,
  totalTokens,
  sessionTokens,
  shortDayLabel,
  type BreakdownEntry,
  type DailyPoint,
  type ProviderCard,
  type SessionRow,
  type StatsOverview,
  type StatsSnapshot,
  type StatsSummary,
} from '$lib/stores/usageStats';
import {
  activityState,
  refreshActivity,
  hasActivity,
  formatWorkedTime,
  formatTrackingSince,
  averageTurnMs,
  type ActivitySummary,
} from '$lib/stores/activityStats';
import { isTauriRuntime } from '$lib/utils/tauri';
import Dropdown, {
  type DropdownOption,
} from '$lib/components/shared/Dropdown.tsx';
import ShareUsageButton from './ShareUsageButton';
import {
  buildShareCard,
  type ShareCardData,
} from '$lib/services/share-usage-card';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { lookupAgentBrand } from '$lib/components/shared/agentBrands';
import {
  BreakdownTable,
  chartDays,
  compactTokens,
  DailyChart,
  dayTotal,
  Segmented,
  SeriesList,
  seriesColor,
  TokensByType,
  TotalsRow,
  type ChartMetric,
  type ChartSeries,
  type RankedRow,
} from './UsageCharts';
import { getAgentDisplayName } from '$lib/stores/terminal';
import LiveTicker from '$lib/components/shared/LiveTicker';
import './UsageStatsPane.css';

/**
 * These are the app's own `Dropdown`, not a native `<select>`. A native select
 * paints its menu with OS chrome — a white system-font list on Windows — which
 * is the one part of a styled control the page cannot theme. Every other picker
 * in Spacron is this component, so the stats pane uses it too.
 *
 * The pane renders inside the settings modal, so the menu is bounded to
 * `.settings-modal` to stop it spilling past the modal's edges.
 */
const SETTINGS_BOUNDARY = '.settings-modal';

/**
 * How often the pane re-scans transcripts while it is open. Transcript files
 * only appear once a session ends, so a minute is responsive without walking a
 * whole ledger on a timer — the backend re-parses only files whose fingerprint
 * changed.
 */
const AUTO_RESCAN_INTERVAL_MS = 60 * 1000;

const SCOPE_OPTIONS: DropdownOption[] = [
  { value: SCOPE_ALL, label: 'All projects' },
  { value: SCOPE_SPACRON, label: 'Managed worktrees only' },
];

/** Long labels — the share card reads these. */
const RANGE_OPTIONS: DropdownOption[] = [
  { value: RANGE_ALL, label: 'All time' },
  { value: RANGE_1D, label: 'Today' },
  { value: RANGE_90D, label: 'Last 90 days' },
  { value: RANGE_30D, label: 'Last 30 days' },
  { value: RANGE_7D, label: 'Last 7 days' },
];

/** The range switch in the toolbar. The ledger is kept per UTC day, so the
 *  shortest window is the current day rather than a rolling 24 hours. */
const RANGE_CHIPS: { value: string; label: string; title?: string }[] = [
  { value: RANGE_1D, label: 'Today', title: 'Since midnight UTC' },
  { value: RANGE_7D, label: '7 days' },
  { value: RANGE_30D, label: '30 days' },
  { value: RANGE_90D, label: '90 days' },
  { value: RANGE_ALL, label: 'All time' },
];

const METRIC_CHIPS: { value: ChartMetric; label: string }[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
];

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Icon({ path, size = 15 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const ICON_PULSE = 'M22 12h-4l-3 9L9 3l-3 9H2';

/** A labelled figure with an icon tile — the Overview's four headline cards. */
function StatTile({
  icon,
  value,
  label,
  hint,
}: {
  icon: string;
  value: string;
  label: string;
  hint?: string;
}) {
  return (
    <div className="stats-tile" title={hint}>
      <span className="stats-tile-icon">
        <Icon path={icon} />
      </span>
      <span className="stats-tile-body">
        <span className="stats-tile-value">{value}</span>
        <span className="stats-tile-label">{label}</span>
      </span>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle${checked ? ' active' : ''}`}
      onClick={() => onChange(!checked)}
      aria-label={label}
      aria-pressed={checked}
    >
      <span />
    </button>
  );
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'n/a';
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function formatRelative(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return shortDayLabel(new Date(ms).toISOString().slice(0, 10));
}

const ICON_AGENTS =
  'M12 2a5 5 0 0 1 5 5v1h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1a6 6 0 0 1-10 0H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5z M9.5 11h.01 M14.5 11h.01';
const ICON_CLOCK = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2';
const ICON_TURNS =
  'M3 12a9 9 0 0 1 9-9 9 9 0 0 1 8 5 M21 12a9 9 0 0 1-9 9 9 9 0 0 1-8-5 M20 3v5h-5 M4 21v-5h5';
const ICON_SINCE = 'M12 8v4l3 3 M3.05 11a9 9 0 1 1 .5 4 M3 21v-6h6';

/**
 * Orca's activity StatCards, on Spacron's own data.
 *
 * Orca's fourth card is "PRs created"; Spacron opens no pull requests
 * anywhere, so that card could only ever read 0 — turns completed takes its
 * place, and is the figure Spacron actually measures (see the module note in
 * `activity_stats.rs`).
 *
 * The whole section is gated on having recorded something. These totals only
 * start accumulating once this build has run an agent, so on first launch the
 * honest render is a one-line explanation, not four zeroes that look like a
 * verdict on the user's month.
 */
function ActivitySection({ summary }: { summary: ActivitySummary | null }) {
  if (!hasActivity(summary) || !summary) {
    return (
      <>
        <div className="stats-section-head">
          <div>
            <h4>Agent activity</h4>
            <p className="stats-panel-sub">Recorded by Spacron as agents run</p>
          </div>
        </div>
        <p className="shell-hint stats-empty-hint">
          Nothing recorded yet. Spawn an agent and its turns will be counted
          here. Unlike the token figures below, this is measured live rather
          than read back from CLI logs.
        </p>
      </>
    );
  }

  const since = formatTrackingSince(summary.trackingSinceMs);
  const average = averageTurnMs(summary);
  const totalTurns = summary.turnsCompleted + summary.turnsBlocked;

  return (
    <>
      <div className="stats-section-head">
        <div>
          <h4>Agent activity</h4>
          <p className="stats-panel-sub">Recorded by Spacron as agents run</p>
        </div>
        {summary.turnsBlocked > 0 && (
          <span className="stats-badge">
            <Icon path={ICON_PULSE} size={12} />
            {summary.turnsBlocked} blocked
          </span>
        )}
      </div>
      <div className="stats-tiles">
        <StatTile
          icon={ICON_AGENTS}
          value={String(summary.agentsSpawned)}
          label="Agents spawned"
          hint="Counted once per agent session, however it started"
        />
        <StatTile
          icon={ICON_CLOCK}
          value={formatWorkedTime(summary.workedMs)}
          label="Time agents worked"
          hint={
            average != null
              ? `Averaging ${formatWorkedTime(average)} per turn`
              : 'Summed across completed turns'
          }
        />
        <StatTile
          icon={ICON_TURNS}
          value={String(totalTurns)}
          label="Turns completed"
          hint={
            summary.turnsBlocked > 0
              ? `${summary.turnsCompleted} finished · ${summary.turnsBlocked} blocked on a question`
              : undefined
          }
        />
        <StatTile
          icon={ICON_SINCE}
          value={since ?? 'n/a'}
          label="Tracking since"
          hint="When the first agent event was recorded"
        />
      </div>

      {summary.providers.length > 0 && (
        <div className="stats-activity-rows">
          {summary.providers.map((row) => (
            <div className="stats-activity-row" key={row.provider}>
              <span className="stats-activity-mark">
                <AgentBrandMark
                  command={row.provider}
                  name={getAgentDisplayName(row.provider) ?? row.provider}
                />
              </span>
              <span className="stats-activity-name">
                {getAgentDisplayName(row.provider) ?? row.provider}
              </span>
              <span className="stats-activity-figure">
                {formatWorkedTime(row.workedMs)}
              </span>
              <span className="stats-activity-sub">
                {row.agentsSpawned} spawned ·{' '}
                {row.turnsCompleted + row.turnsBlocked} turns
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Analytics layout (Overview and per-provider)
// ---------------------------------------------------------------------------

type BreakdownMode = 'model' | 'project' | 'day';

const BREAKDOWN_MODES: { value: BreakdownMode; label: string }[] = [
  { value: 'model', label: 'Model' },
  { value: 'project', label: 'Project' },
  { value: 'day', label: 'Day' },
];

function entryTokens(e: BreakdownEntry): number {
  return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
}

/** A model's brand, from the bundled table only — a model name must never be
 *  sent off to the logo fetcher. */
function modelRows(entries: BreakdownEntry[], total: number): RankedRow[] {
  return entries.map((e, i) => {
    const brand = lookupAgentBrand(e.label, e.label);
    return {
      key: e.key,
      label: e.label,
      mark: brand ? (
        <span
          className="agent-brand-mark"
          style={{ color: brand.color === 'mono' ? 'var(--text-primary)' : brand.color }}
          aria-hidden="true"
        >
          {brand.mark}
        </span>
      ) : undefined,
      color: seriesColor(brand?.color, i),
      tokens: entryTokens(e),
      share: total > 0 ? entryTokens(e) / total : 0,
      cost: e.estimatedCostUsd,
    };
  });
}

function projectRows(entries: BreakdownEntry[], total: number): RankedRow[] {
  return entries.map((e, i) => ({
    key: e.key,
    label: e.label,
    color: seriesColor(null, i),
    tokens: entryTokens(e),
    share: total > 0 ? entryTokens(e) / total : 0,
    cost: e.estimatedCostUsd,
  }));
}

function dayRows(daily: DailyPoint[], total: number): RankedRow[] {
  return [...daily]
    .filter((d) => dayTotal(d) > 0)
    .sort((a, b) => b.day.localeCompare(a.day))
    .map((d) => ({
      key: d.day,
      label: shortDayLabel(d.day),
      color: 'var(--text-secondary)',
      tokens: dayTotal(d),
      share: total > 0 ? dayTotal(d) / total : 0,
      cost: d.estimatedCostUsd ?? null,
    }));
}

/** The hero, chart, totals, token types and breakdown — shared by both panes. */
function AnalyticsLayout({
  total,
  sessions,
  summary,
  series,
  seriesRows,
  range,
  metric,
  modelBreakdown,
  projectBreakdown,
  daily,
}: {
  total: number;
  sessions: number;
  summary: StatsSummary;
  series: ChartSeries[];
  seriesRows: RankedRow[];
  range: string;
  metric: ChartMetric;
  modelBreakdown: BreakdownEntry[];
  projectBreakdown: BreakdownEntry[];
  daily: DailyPoint[];
}) {
  const [mode, setMode] = useState<BreakdownMode>('model');
  const days = chartDays(range, series);
  const rows =
    mode === 'model'
      ? modelRows(modelBreakdown, total)
      : mode === 'project'
        ? projectRows(projectBreakdown, total)
        : dayRows(daily, total);

  return (
    <>
      <div className="stats-hero">
        <div className="stats-hero-left">
          <div className="stats-hero-total">{compactTokens(total)}</div>
          <div className="stats-hero-sub">
            {sessions} {sessions === 1 ? 'session' : 'sessions'}
          </div>
          <SeriesList rows={seriesRows} />
        </div>
        <DailyChart
          title={metric === 'cost' ? 'Daily estimated cost' : 'Daily processed tokens'}
          days={days}
          series={series}
          metric={metric}
        />
      </div>

      <TotalsRow summary={summary} total={total} />
      <TokensByType summary={summary} />

      <section className="stats-block">
        <div className="stats-block-head">
          <h4 className="stats-block-title">Breakdown</h4>
          <Segmented options={BREAKDOWN_MODES} value={mode} onChange={setMode} ariaLabel="Break down by" />
        </div>
        <BreakdownTable
          rows={rows}
          nameHeader={mode === 'model' ? 'Model' : mode === 'project' ? 'Project' : 'Day'}
          emptyHint="Nothing recorded in this range."
        />
        {mode !== 'day' && rows.length > 0 && (
          <p className="stats-panel-sub stats-btable-note">Top {rows.length} shown.</p>
        )}
      </section>
    </>
  );
}

function OverviewPane({
  overview,
  range,
  metric,
}: {
  overview: StatsOverview;
  range: string;
  metric: ChartMetric;
}) {
  const activity = useStore(activityState);
  const withData = overview.providers
    .filter((p) => p.hasData)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const sessions = overview.providers.reduce((n, p) => n + p.sessions, 0);
  const colorOf = (card: ProviderCard, i: number) =>
    seriesColor(lookupAgentBrand(card.id, card.label)?.color, i);

  const series: ChartSeries[] = withData.map((card, i) => ({
    key: card.id,
    label: card.label,
    color: colorOf(card, i),
    daily: card.daily ?? [],
  }));
  const seriesRows: RankedRow[] = withData.map((card, i) => ({
    key: card.id,
    label: card.label,
    mark: <AgentBrandMark command={card.id} name={card.label} />,
    color: colorOf(card, i),
    aside: `${card.sessions} ${card.sessions === 1 ? 'session' : 'sessions'}`,
    tokens: card.totalTokens,
    share: card.share,
    cost: card.estimatedCostUsd,
    partialCost: card.hasPartialCost,
  }));

  return (
    <>
      {withData.length === 0 ? (
        <p className="shell-hint stats-empty-hint">
          No usage found in this range. Widen the range, or come back after
          running a session. This pane re-scans by itself.
        </p>
      ) : (
        <AnalyticsLayout
          total={overview.totalTokens}
          sessions={sessions}
          summary={overview.summary}
          series={series}
          seriesRows={seriesRows}
          range={range}
          metric={metric}
          modelBreakdown={overview.modelBreakdown}
          projectBreakdown={overview.projectBreakdown}
          daily={overview.daily ?? []}
        />
      )}
      {/* Otherwise an agent you use daily is simply missing from this page and
          there is nothing on screen to say why. These CLIs write no usable
          token counts to disk at all — it is a property of their logs, not a
          setting — so their capacity is only ever a live reading. */}
      <p className="stats-panel-sub stats-provider-note">
        Gemini, Copilot, Cursor and Droid aren't listed: their logs record no
        token counts, so nothing here can be tallied for them. Their remaining capacity shows in the usage meter in the corner of
        the workspace instead.
      </p>

      <ActivitySection summary={activity.summary} />
    </>
  );
}

function ProviderPane({
  snapshot,
  label,
  metric,
}: {
  snapshot: StatsSnapshot;
  label: string;
  metric: ChartMetric;
}) {
  const { summary } = snapshot;
  const total = totalTokens(summary);
  if (total <= 0) {
    return (
      <p className="shell-hint stats-empty-hint">
        No usage found for this provider in this range. Widen the range, or
        come back after running a session. This pane re-scans by itself.
      </p>
    );
  }
  const color = seriesColor(lookupAgentBrand(snapshot.provider, label)?.color, 0);
  const series: ChartSeries[] = [{ key: snapshot.provider, label, color, daily: snapshot.daily }];
  // The left column lists this provider's models: the chart already is the
  // provider, so repeating it as the only row would say nothing.
  const seriesRows = modelRows(snapshot.modelBreakdown, total);

  return (
    <>
      <AnalyticsLayout
        total={total}
        sessions={summary.sessions}
        summary={summary}
        series={series}
        seriesRows={seriesRows}
        range={snapshot.range}
        metric={metric}
        modelBreakdown={snapshot.modelBreakdown}
        projectBreakdown={snapshot.projectBreakdown}
        daily={snapshot.daily}
      />
      <section className="stats-block">
        <h4 className="stats-block-title">Recent sessions</h4>
        <SessionsTable rows={snapshot.recentSessions} emptyHint="No sessions in this range." />
      </section>
    </>
  );
}

function SessionsTable({
  rows,
  emptyHint,
}: {
  rows: SessionRow[];
  emptyHint: string;
}) {
  if (rows.length === 0) {
    return <p className="shell-hint stats-empty-hint">{emptyHint}</p>;
  }
  return (
    <div className="stats-sessions-scroll">
      <table className="stats-sessions">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Project</th>
            <th>Model</th>
            <th>Branch</th>
            <th className="stats-num">Turns</th>
            <th className="stats-num">Tokens</th>
            <th className="stats-num">Duration</th>
            <th className="stats-num">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.sessionId}-${i}`} title={row.sessionId}>
              {/* Which CLI ran it. On the Overview the table folds every
                  provider together, and two agents in the same project on the
                  same day are otherwise indistinguishable. */}
              <td className="stats-agent">
                <span className="stats-agent-mark" aria-hidden="true">
                  <AgentBrandMark
                    command={row.provider}
                    name={row.providerLabel}
                  />
                </span>
                {row.providerLabel}
              </td>
              <td className="stats-project">
                {row.projectLabel}
                {/* The label already reads `repo (branch)` for a managed tree,
                    but only if a branch was recorded — the flag is what makes
                    "was this a worktree?" answerable either way. */}
                {row.managed && (
                  <span
                    className="stats-worktree"
                    title="Ran in a Spacron-managed worktree"
                  >
                    worktree
                  </span>
                )}
              </td>
              <td>{row.model ?? 'n/a'}</td>
              <td className="stats-branch">{row.branch ?? 'n/a'}</td>
              <td className="stats-num">{row.turns}</td>
              <td className="stats-num">{formatTokens(sessionTokens(row))}</td>
              <td className="stats-num">
                {formatDuration(row.durationMinutes)}
              </td>
              <td className="stats-num stats-when">
                {formatRelative(row.lastActiveAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/** Resolve the loaded pane's figures and picker labels into card input. */
function shareCardFor(
  loaded: StatsOverview | StatsSnapshot,
  isOverview: boolean,
  stats: { provider: string; scope: string; range: string },
  activity: ActivitySummary | null,
  providerLabel: string
): ShareCardData {
  const summary = loaded.summary;
  const overview = isOverview ? (loaded as StatsOverview) : null;
  const tokens = overview ? overview.totalTokens : totalTokens(summary);

  return buildShareCard({
    providerLabel,
    rangeLabel:
      RANGE_OPTIONS.find((o) => o.value === stats.range)?.label ?? 'All time',
    scopeNote: stats.scope === SCOPE_SPACRON ? 'managed worktrees only' : null,
    hasPartialCost: summary.hasPartialCost,
    figures: [
      { label: 'Total tokens', value: formatTokens(tokens) },
      { label: 'Est. cost', value: formatUsd(summary.estimatedCostUsd) },
      overview
        ? { label: 'Active days', value: String(overview.activeDays) }
        : { label: 'Sessions', value: String(summary.sessions) },
      {
        label: 'Cache share',
        value: formatPercent(
          overview ? overview.cacheShare : summary.cacheReuseRate
        ),
      },
    ],
    activity:
      activity && hasActivity(activity)
        ? {
            agentsSpawned: activity.agentsSpawned,
            turns: activity.turnsCompleted + activity.turnsBlocked,
            workedLabel: formatWorkedTime(activity.workedMs),
          }
        : null,
  });
}

export default function UsageStatsPane() {
  const $stats = useStore(usageStatsState);
  const activity = useStore(activityState);
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<ChartMetric>('tokens');

  // The pane refreshes itself — no Rescan button. One pass re-scans the
  // transcripts (only files whose fingerprint changed are re-parsed), reloads
  // the view, and refreshes the activity totals. A pass already in flight
  // makes this a no-op, as does tracking being off.
  const busyRef = useRef(false);
  const runScan = useCallback(() => {
    if (busyRef.current || get(usageStatsState).loading) return;
    if (!currentScanState(get(usageStatsState))?.enabled) return;
    busyRef.current = true;
    setBusy(true);
    void scanAndRefresh()
      .catch(() => {})
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
    void refreshActivity();
  }, []);

  useEffect(() => {
    // Activity totals are cheap (one file read) and independent of the token
    // scan's opt-in, so they load unconditionally alongside it.
    void refreshActivity();
    // The cached view first, so there is something on screen immediately, then
    // a scan straight away rather than sitting on figures up to a minute stale
    // until the first tick. The scan state only arrives with that first load,
    // which is why the scan is chained onto it rather than fired alongside.
    void refreshStatsSnapshot().then(runScan);
  }, [runScan]);

  // Ticks are skipped while the window is hidden; the schedule itself is
  // fixed, so the next one still follows on the minute.
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      runScan();
    }, AUTO_RESCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runScan]);

  if (!isTauriRuntime()) {
    return (
      <p className="shell-hint" style={{ marginTop: 0 }}>
        Usage stats are available in the desktop app.
      </p>
    );
  }

  const scan = currentScanState($stats);
  const isOverview = $stats.provider === PROVIDER_ALL;
  const providerOptions: DropdownOption[] = [
    { value: PROVIDER_ALL, label: 'Overview' },
    ...($stats.overview?.providers ?? []).map((card) => ({ value: card.id, label: card.label })),
  ];
  if (!providerOptions.some((option) => option.value === $stats.provider)) {
    const known = PROVIDER_TABS.find((tab) => tab.id === $stats.provider);
    providerOptions.push({ value: $stats.provider, label: known?.label ?? $stats.provider });
  }

  // Tracking off: one clear switch, with the "why" spelled out.
  if (scan && !scan.enabled) {
    return (
      <section className="settings-card">
        <h3>Usage stats</h3>
        <div className="settings-card-body">
          <p className="shell-hint" style={{ marginTop: 0 }}>
            Spacron can tally tokens and cost across supported agent sessions
            by scanning the transcript files those CLIs write
            to disk. Stats are estimates. No API key is used, and nothing is
            sent anywhere.
          </p>
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Track usage</span>
              <small>
                Scan local transcripts and show cumulative stats here
              </small>
            </div>
            <div className="settings-control">
              <Toggle
                label="Toggle usage tracking"
                checked={false}
                onChange={(on) => {
                  setBusy(true);
                  void setStatsTracking(on).finally(() => setBusy(false));
                }}
              />
            </div>
          </div>
          {busy && (
            <p className="stats-busy-note">Turning tracking on and scanning…</p>
          )}
          {$stats.error && (
            <p className="stats-error-note">
              Could not change tracking: {$stats.error}
            </p>
          )}
        </div>
      </section>
    );
  }

  const loaded = isOverview ? $stats.overview : $stats.snapshot;
  const shareData = loaded
    ? shareCardFor(loaded, isOverview, $stats, activity.summary,
        providerOptions.find((option) => option.value === $stats.provider)?.label ?? 'Usage')
    : null;

  return (
    <div className="usage-stats">
      <div className="stats-head">
        <div>
          <h3 className="stats-title">Usage Analytics</h3>
          <p className="stats-panel-sub">
            Token and cost analytics across the agents.
          </p>
        </div>
        <div className="stats-tab-select">
          <Dropdown
            options={providerOptions}
            value={$stats.provider}
            onChange={selectStatsProvider}
            ariaLabel="Provider"
            boundarySelector={SETTINGS_BOUNDARY}
          />
        </div>
      </div>

      <section className="settings-card">
        <div className="stats-toolbar">
          <div className="stats-controls">
            <div className="stats-control-group">
              <span className="stats-control-label">Scope</span>
              <Dropdown
                options={SCOPE_OPTIONS}
                value={$stats.scope}
                onChange={selectStatsScope}
                ariaLabel="Scope"
                boundarySelector={SETTINGS_BOUNDARY}
              />
            </div>
          </div>
          <div className="stats-switches">
            <Segmented
              options={RANGE_CHIPS}
              value={$stats.range}
              onChange={selectStatsRange}
              ariaLabel="Range"
            />
            <Segmented options={METRIC_CHIPS} value={metric} onChange={setMetric} ariaLabel="Chart shows" />
          </div>
          <div className="stats-actions">
            <div className="stats-refresh-meta">
              <LiveTicker
                intervalMs={AUTO_RESCAN_INTERVAL_MS}
                lastFetchedAt={$stats.lastFetchedAt}
                refreshing={busy || $stats.loading}
              />
              {scan?.lastScanCompletedAt != null && (
                <span className="stats-updated">
                  Updated {formatRelative(scan.lastScanCompletedAt)}
                </span>
              )}
            </div>
            {shareData && <ShareUsageButton data={shareData} />}
          </div>
        </div>

        <div className="settings-card-body">
          {scan?.lastScanError && (
            <p className="stats-cost-note">Last scan: {scan.lastScanError}</p>
          )}
          {$stats.error && (
            <p className="stats-error-note">
              Could not refresh: {$stats.error}
            </p>
          )}
          {loaded?.summary.hasPartialCost && (
            <p className="stats-cost-note">
              Some models have no price in the table, so cost is a partial
              estimate. Token counts are unaffected.
            </p>
          )}

          {!loaded ? (
            $stats.error ? (
              <button
                type="button"
                className="stats-action-btn"
                onClick={() => void refreshStatsSnapshot()}
                disabled={$stats.loading}
              >
                Try again
              </button>
            ) : (
              <p className="shell-hint stats-loading" style={{ marginTop: 0 }}>
                {busy ? 'Scanning transcripts…' : 'Loading usage…'}
              </p>
            )
          ) : isOverview ? (
            <OverviewPane overview={loaded as StatsOverview} range={$stats.range} metric={metric} />
          ) : (
            <ProviderPane
              snapshot={loaded as StatsSnapshot}
              label={providerOptions.find((option) => option.value === $stats.provider)?.label ?? $stats.provider}
              metric={metric}
            />
          )}
        </div>
      </section>
    </div>
  );
}
