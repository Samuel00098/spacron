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
  breakdownTokens,
  breakdownShare,
  sessionTokens,
  zeroCacheReadShare,
  shortDayLabel,
  lastDailyPoints,
  heatmapRows,
  busiestDay,
  tokenMix,
  type BreakdownEntry,
  type DailyPoint,
  type HeatmapDay,
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

const RANGE_OPTIONS: DropdownOption[] = [
  { value: RANGE_ALL, label: 'All time' },
  { value: RANGE_90D, label: 'Last 90 days' },
  { value: RANGE_30D, label: 'Last 30 days' },
  { value: RANGE_7D, label: 'Last 7 days' },
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

const ICON_TOKENS =
  'M12 3l1.9 4.7L18.6 9l-4.7 1.9L12 15.6l-1.9-4.7L5.4 9l4.7-1.3z M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z';
const ICON_COST = 'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6';
const ICON_DAYS =
  'M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
const ICON_CACHE =
  'M21 5c0 1.7-4 3-9 3S3 6.7 3 5s4-3 9-3 9 1.3 9 3z M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5 M3 12c0 1.7 4 3 9 3s9-1.3 9-3';
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

function dayTokens(d: DailyPoint): number {
  return (
    d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens
  );
}

/** Trailing active days for the selected range. `snapshot.daily` is already
 *  range-filtered by the backend, so the fixed windows want only their own
 *  tail and `all` wants every recorded day. */
function rangePoints(daily: DailyPoint[], range: string): DailyPoint[] {
  if (range === RANGE_7D) return lastDailyPoints(daily, 7);
  if (range === RANGE_30D) return lastDailyPoints(daily, 30);
  if (range === RANGE_90D) return lastDailyPoints(daily, 90);
  return daily;
}

/** Merge a long daily series down to at most `maxCols` columns by summing
 *  consecutive points, so an all-time view traces the whole lifetime as a
 *  density strip instead of overflowing the pane. A merged column keeps its
 *  first day as its label anchor. */
function dailyColumns(daily: DailyPoint[], maxCols: number): DailyPoint[] {
  if (daily.length <= maxCols) return daily;
  const stride = Math.ceil(daily.length / maxCols);
  const out: DailyPoint[] = [];
  for (let i = 0; i < daily.length; i += stride) {
    const slice = daily.slice(i, i + stride);
    const acc: DailyPoint = {
      day: slice[0].day,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    for (const p of slice) {
      acc.inputTokens += p.inputTokens;
      acc.outputTokens += p.outputTokens;
      acc.cacheReadTokens += p.cacheReadTokens;
      acc.cacheWriteTokens += p.cacheWriteTokens;
    }
    out.push(acc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** GitHub-style 42-day intensity grid. Levels come from the backend so the
 *  cells and the Less/More legend cannot drift apart. */
function IntensityGrid({ days }: { days: HeatmapDay[] }) {
  const rows = heatmapRows(days);
  const best = busiestDay(days);
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <div className="stats-panel">
      <div className="stats-panel-head">
        <div>
          <h4>Daily intensity</h4>
          <p className="stats-panel-sub">
            Recent combined token activity across every provider.
          </p>
        </div>
        {best && (
          <span className="stats-badge">Best: {shortDayLabel(best.day)}</span>
        )}
      </div>
      <div
        className="stats-heatmap"
        role="img"
        aria-label="Token activity over the last 42 days"
      >
        {rows.map((row, i) => (
          <div className="stats-heatmap-row" key={i}>
            {row.map((d) => (
              <span
                key={d.day}
                className={`stats-heat-cell level-${d.level}`}
                title={`${shortDayLabel(d.day)}: ${formatTokens(d.totalTokens)} tokens`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="stats-heatmap-legend">
        <span>{first ? shortDayLabel(first.day) : ''}</span>
        <span className="stats-legend-scale">
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className={`stats-heat-cell level-${l}`} />
          ))}
          More
        </span>
        <span>{last ? shortDayLabel(last.day) : ''}</span>
      </div>
    </div>
  );
}

function TokenMixPanel({ summary }: { summary: StatsSummary }) {
  const mix = tokenMix(summary);
  return (
    <div className="stats-panel">
      <div className="stats-panel-head">
        <div>
          <h4>Token mix</h4>
          <p className="stats-panel-sub">
            Combined input, output and cache tokens across enabled providers.
          </p>
        </div>
      </div>
      {mix == null ? (
        <p className="shell-hint stats-empty-hint">
          Nothing recorded in this range.
        </p>
      ) : (
        <>
          <div className="stats-mixbar" aria-hidden="true">
            <span
              className="stats-mix-seg seg-input"
              style={{ width: `${mix.input * 100}%` }}
            />
            <span
              className="stats-mix-seg seg-output"
              style={{ width: `${mix.output * 100}%` }}
            />
            <span
              className="stats-mix-seg seg-cache"
              style={{ width: `${mix.cache * 100}%` }}
            />
          </div>
          <ul className="stats-mix-legend">
            <li>
              <i className="stats-dot seg-input" />
              New input: {formatTokens(summary.inputTokens)}
            </li>
            <li>
              <i className="stats-dot seg-output" />
              Output: {formatTokens(summary.outputTokens)}
            </li>
            <li>
              <i className="stats-dot seg-cache" />
              Cache:{' '}
              {formatTokens(summary.cacheReadTokens + summary.cacheWriteTokens)}
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

function ProviderCardView({ card }: { card: ProviderCard }) {
  return (
    <div className={`stats-provider-card${card.hasData ? '' : ' is-empty'}`}>
      <div className="stats-provider-head">
        <span className="stats-provider-name">{card.label}</span>
        <span className={`stats-pill${card.hasData ? ' is-on' : ''}`}>
          {card.hasData ? 'Tracked' : 'No data'}
        </span>
      </div>
      <p className="stats-provider-sub">
        {card.hasData
          ? `${card.topModel ?? 'unknown model'} · ${card.topProject ?? 'unknown project'}`
          : 'No usage found in this range.'}
      </p>
      <div className="stats-provider-figures">
        <span>{formatTokens(card.totalTokens)} tokens</span>
        <span>
          {card.sessions} sessions · {card.turns} turns
        </span>
        <span
          title={
            card.hasPartialCost
              ? 'Some models have no price in the table'
              : undefined
          }
        >
          {formatUsd(card.estimatedCostUsd)}
          {card.hasPartialCost && card.estimatedCostUsd != null ? '+' : ''}
        </span>
      </div>
      <div className="stats-provider-track" aria-hidden="true">
        <div
          className="stats-provider-fill"
          style={{ width: `${Math.round(card.share * 100)}%` }}
        />
      </div>
    </div>
  );
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

function OverviewPane({ overview }: { overview: StatsOverview }) {
  const { summary } = overview;
  const activity = useStore(activityState);
  const withData = overview.providers.filter((p) => p.hasData).length;
  const sessions = overview.providers.reduce((n, p) => n + p.sessions, 0);

  return (
    <>
      <ActivitySection summary={activity.summary} />

      <div className="stats-section-head">
        <div>
          <h4>Token usage</h4>
          <p className="stats-panel-sub">Read back from each CLI's own logs</p>
        </div>
      </div>
      <div className="stats-tiles">
        <StatTile
          icon={ICON_TOKENS}
          value={formatTokens(overview.totalTokens)}
          label="Total tokens"
        />
        <StatTile
          icon={ICON_COST}
          value={formatUsd(summary.estimatedCostUsd)}
          label="Est. cost"
          hint={
            summary.hasPartialCost
              ? 'Some models have no price in the table'
              : undefined
          }
        />
        <StatTile
          icon={ICON_DAYS}
          value={String(overview.activeDays)}
          label="Active days"
        />
        <StatTile
          icon={ICON_CACHE}
          value={formatPercent(overview.cacheShare)}
          label="Cache share"
        />
      </div>

      <div className="stats-panels">
        <IntensityGrid days={overview.heatmap} />
        <TokenMixPanel summary={summary} />
      </div>

      <div className="stats-section-head">
        <div>
          <h4>Providers</h4>
          <p className="stats-panel-sub">
            {overview.providers.length} scanned · {withData} with data
          </p>
        </div>
        <span className="stats-badge">
          <Icon path={ICON_PULSE} size={12} />
          {sessions} sessions
        </span>
      </div>
      <div className="stats-provider-grid">
        {overview.providers.map((card) => (
          <ProviderCardView key={card.id} card={card} />
        ))}
      </div>
      {/* Otherwise an agent you use daily is simply missing from this page and
          there is nothing on screen to say why. These CLIs write no usable
          token counts to disk at all — it is a property of their logs, not a
          setting — so their capacity is only ever a live reading. */}
      <p className="stats-panel-sub stats-provider-note">
        Grok, Gemini, Copilot, Cursor, Antigravity and Droid aren't listed:
        their logs record no token counts, so nothing here can be tallied for
        them. Their remaining capacity shows in the usage meter in the corner of
        the workspace instead.
      </p>

      <div className="stats-breakdowns">
        <div className="stats-breakdown-col">
          <h4>By model</h4>
          <BreakdownList
            entries={overview.modelBreakdown}
            emptyHint="No model data in this range."
          />
        </div>
        <div className="stats-breakdown-col">
          <h4>By project</h4>
          <BreakdownList
            entries={overview.projectBreakdown}
            emptyHint="No project data in this range."
          />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-provider pane
// ---------------------------------------------------------------------------

function BreakdownList({
  entries,
  emptyHint,
}: {
  entries: BreakdownEntry[];
  emptyHint: string;
}) {
  if (entries.length === 0) {
    return <p className="shell-hint stats-empty-hint">{emptyHint}</p>;
  }
  return (
    <ul className="stats-breakdown">
      {entries.map((entry) => (
        <li key={entry.key}>
          <div className="stats-breakdown-row">
            <span className="stats-breakdown-label" title={entry.label}>
              {entry.label}
            </span>
            <span className="stats-breakdown-turns">{entry.turns} turns</span>
            <span className="stats-breakdown-tokens">
              {formatTokens(breakdownTokens(entry))}
            </span>
            <span className="stats-breakdown-cost">
              {formatUsd(entry.estimatedCostUsd)}
            </span>
          </div>
          <div className="stats-breakdown-track" aria-hidden="true">
            <div
              className="stats-breakdown-fill"
              style={{
                width: `${Math.round((breakdownShare(entry, entries) ?? 0) * 100)}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
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

function ProviderPane({ snapshot }: { snapshot: StatsSnapshot }) {
  const { summary } = snapshot;
  // The chart honours the Range picker: fixed windows draw their trailing
  // active days, all-time draws the whole lifetime (bucketed to fit).
  const points = dailyColumns(rangePoints(snapshot.daily, snapshot.range), 90);
  const maxDay = Math.max(1, ...points.map(dayTokens));
  const zeroCache = zeroCacheReadShare(summary);

  if (totalTokens(summary) <= 0) {
    return (
      <p className="shell-hint stats-empty-hint">
        No usage found for this provider in this range. Widen the range, or
        come back after running a session. This pane re-scans by itself.
      </p>
    );
  }

  return (
    <>
      <div className="stats-tiles">
        <StatTile
          icon={ICON_TOKENS}
          value={formatTokens(totalTokens(summary))}
          label="Total tokens"
        />
        <StatTile
          icon={ICON_COST}
          value={formatUsd(summary.estimatedCostUsd)}
          label="Est. cost"
        />
        <StatTile
          icon={ICON_CACHE}
          value={formatPercent(summary.cacheReuseRate)}
          label="Cache reuse"
          hint={
            zeroCache == null
              ? undefined
              : `${formatPercent(zeroCache)} of turns read no cache`
          }
        />
        <StatTile
          icon={ICON_DAYS}
          value={String(summary.sessions)}
          label="Sessions"
        />
      </div>

      <div className="stats-figure-row">
        <span>{formatTokens(summary.inputTokens)} new input</span>
        <span>{formatTokens(summary.outputTokens)} output</span>
        <span>{formatTokens(summary.cacheReadTokens)} cache read</span>
        <span>{formatTokens(summary.cacheWriteTokens)} cache write</span>
        <span>{summary.turns} turns</span>
      </div>

      {points.length > 0 && (
        <div className="stats-chart-wrap">
          <div
            className="stats-chart"
            role="img"
            aria-label="Tokens per day, split into input, output and cache"
          >
            {points.map((d) => {
              const total = dayTokens(d);
              const inputH = total > 0 ? (d.inputTokens / maxDay) * 100 : 0;
              const cacheH =
                total > 0
                  ? ((d.cacheReadTokens + d.cacheWriteTokens) / maxDay) * 100
                  : 0;
              const outputH = total > 0 ? (d.outputTokens / maxDay) * 100 : 0;
              return (
                <div className="stats-chart-col" key={d.day}>
                  <div
                    className="stats-chart-bar"
                    title={`${shortDayLabel(d.day)}: in ${formatTokens(d.inputTokens)}, out ${formatTokens(d.outputTokens)}, cache ${formatTokens(d.cacheReadTokens + d.cacheWriteTokens)}`}
                  >
                    <div
                      className="stats-chart-seg stats-chart-input"
                      style={{ height: `${inputH}%` }}
                    />
                    <div
                      className="stats-chart-seg stats-chart-cache"
                      style={{ height: `${cacheH}%` }}
                    />
                    <div
                      className="stats-chart-seg stats-chart-output"
                      style={{ height: `${outputH}%` }}
                    />
                  </div>
                  {points.length <= 12 && (
                    <span className="stats-chart-label">
                      {shortDayLabel(d.day)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="stats-chart-legend">
            <span>
              <i className="stats-dot seg-input" />
              Input
            </span>
            <span>
              <i className="stats-dot seg-cache" />
              Cache
            </span>
            <span>
              <i className="stats-dot seg-output" />
              Output
            </span>
          </div>
        </div>
      )}

      <div className="stats-breakdowns">
        <div className="stats-breakdown-col">
          <h4>By model</h4>
          <BreakdownList
            entries={snapshot.modelBreakdown}
            emptyHint="No model data in this range."
          />
        </div>
        <div className="stats-breakdown-col">
          <h4>By project</h4>
          <BreakdownList
            entries={snapshot.projectBreakdown}
            emptyHint="No project data in this range."
          />
        </div>
      </div>

      <div className="stats-recent">
        <h4>Recent sessions</h4>
        <SessionsTable
          rows={snapshot.recentSessions}
          emptyHint="No sessions in this range."
        />
      </div>
    </>
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
            <div className="stats-control-group">
              <span className="stats-control-label">Range</span>
              <Dropdown
                options={RANGE_OPTIONS}
                value={$stats.range}
                onChange={selectStatsRange}
                ariaLabel="Range"
                boundarySelector={SETTINGS_BOUNDARY}
              />
            </div>
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
            <OverviewPane overview={loaded as StatsOverview} />
          ) : (
            <ProviderPane snapshot={loaded as StatsSnapshot} />
          )}
        </div>
      </section>
    </div>
  );
}
