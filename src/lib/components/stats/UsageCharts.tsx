import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  calendarDailyPoints,
  formatUsd,
  RANGE_1D,
  RANGE_7D,
  RANGE_30D,
  RANGE_90D,
  type DailyPoint,
  type StatsSummary,
} from '$lib/stores/usageStats';

/**
 * The building blocks of the Usage Analytics layout: a segmented switch, the
 * daily line chart, the totals row, the tokens-by-type bar and the ranked
 * breakdown table. They take plain numbers so the Overview and a single
 * provider's pane can both feed them.
 */

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Three significant figures: 593M, 12.7M, 1.94M, 234K. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [div, unit] of units) {
    if (n >= div) return `${sigFig(n / div)}${unit}`;
  }
  return String(Math.round(n));
}

function sigFig(v: number): string {
  const s = v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function compactUsd(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 1000) return `$${sigFig(v / 1000)}K`;
  return `$${sigFig(v)}`;
}

/** 0.889 → "88.9%", anything visible but under a tenth → "<0.1%". */
export function sharePercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  if (fraction < 0.001) return '<0.1%';
  return `${(fraction * 100).toFixed(1)}%`;
}

/** "2026-11-13" → "NOV 13". */
function axisDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

export function dayTotal(d: DailyPoint): number {
  return d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens;
}

// ---------------------------------------------------------------------------
// Series colours
// ---------------------------------------------------------------------------

/**
 * One fixed colour per agent, so an agent reads the same in the list, the
 * chart and the breakdown, and never trades colours with another agent when
 * the ranking changes. Close to T3 Code's choices. Codex is the theme's text
 * colour — white on dark, black on light — rather than a literal white that
 * would vanish in the light theme.
 */
const AGENT_COLORS: Record<string, string> = {
  claude: '#D97757',
  antigravity: '#8B7CF6',
  opencode: '#4FA3C7',
  grok: '#9CA3AF',
  codex: 'var(--text-primary)',
  pi: '#F59E0B',
  omp: '#EC4899',
  'command-code': '#22C55E',
  kilo: '#EAB308',
  aider: '#14B8A6',
  cursor: '#60A5FA',
  gemini: '#4285F4',
};

/** For agents and models without a fixed colour. None repeats an agent's. */
const SERIES_PALETTE = ['#F472B6', '#34D399', '#FB923C', '#38BDF8', '#C084FC', '#A3E635', '#FACC15', '#F87171'];

/** An agent's fixed colour, if it has one. */
export function agentColor(agentId: string): string | undefined {
  return AGENT_COLORS[agentId.toLowerCase()];
}

/** A model wears its maker's agent colour: Claude models Claude's orange,
 *  Gemini models Antigravity's purple (the agent that serves them here). */
export function modelColor(model: string): string | undefined {
  const m = model.toLowerCase().split('/').pop() ?? '';
  if (m.startsWith('claude')) return AGENT_COLORS.claude;
  if (m.startsWith('gemini')) return AGENT_COLORS.antigravity;
  if (m.startsWith('grok')) return AGENT_COLORS.grok;
  if (/^(gpt|o\d|codex)/.test(m)) return AGENT_COLORS.codex;
  return undefined;
}

/**
 * Colours for one chart's worth of series: each takes its preferred colour
 * unless an earlier series already has it, then the first unused palette
 * entry. Two lines never share a colour.
 */
export function distinctColors(preferred: (string | undefined)[]): string[] {
  const used = new Set<string>();
  const pick = (want: string | undefined) => {
    if (want && !used.has(want)) return want;
    return SERIES_PALETTE.find((c) => !used.has(c)) ?? SERIES_PALETTE[used.size % SERIES_PALETTE.length];
  };
  return preferred.map((want) => {
    const color = pick(want);
    used.add(color);
    return color;
  });
}

// ---------------------------------------------------------------------------
// Segmented switch
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="stats-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`stats-seg-btn${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily chart
// ---------------------------------------------------------------------------

export type ChartMetric = 'tokens' | 'cost';

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  daily: DailyPoint[];
};

/**
 * The calendar days the chart spans for a range. Fixed ranges are calendar
 * windows (quiet days included, so lines fall to zero instead of skipping);
 * all-time runs from the first recorded day to today.
 */
export function chartDays(range: string, series: ChartSeries[], now = new Date()): string[] {
  const window = (n: number) => calendarDailyPoints([], n, now).map((p) => p.day);
  if (range === RANGE_1D) return window(1);
  if (range === RANGE_7D) return window(7);
  if (range === RANGE_30D) return window(30);
  if (range === RANGE_90D) return window(90);
  let first: string | null = null;
  for (const s of series) {
    for (const p of s.daily) if (first == null || p.day < first) first = p.day;
  }
  if (first == null) return window(7);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const span = Math.floor((today - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
  return window(Math.max(2, span));
}

/** Round axis steps (100M, 200M, 250K…) and the top they reach over the peak. */
function niceScale(peak: number): { max: number; step: number } {
  if (!(peak > 0)) return { max: 1, step: 0.25 };
  const raw = peak / 4;
  const e = 10 ** Math.floor(Math.log10(raw));
  const f = raw / e;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  return { max: Math.ceil(peak / step - 1e-9) * step, step };
}

/** Monotone cubic (Fritsch–Carlson): smooth, and never dips below a zero day. */
function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const t: number[] = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = dx[i] / 3;
    d += ` C${x0 + h},${y0 + t[i] * h} ${x1 - h},${y1 - t[i + 1] * h} ${x1},${y1}`;
  }
  return d;
}

const VB_W = 1000;
const VB_H = 300;

export function DailyChart({
  title,
  days,
  series,
  metric,
}: {
  title: string;
  days: string[];
  series: ChartSeries[];
  metric: ChartMetric;
}) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const lines = useMemo(() => {
    const value = (p: DailyPoint | undefined) =>
      !p ? 0 : metric === 'cost' ? (p.estimatedCostUsd ?? 0) : dayTotal(p);
    return series
      .map((s) => {
        const byDay = new Map(s.daily.map((p) => [p.day, p]));
        const values = days.map((d) => value(byDay.get(d)));
        return { ...s, values, sum: values.reduce((a, b) => a + b, 0) };
      })
      // Largest first, so its fill sits behind the smaller lines.
      .sort((a, b) => b.sum - a.sum);
  }, [series, days, metric]);

  const peak = Math.max(0, ...lines.flatMap((l) => l.values));
  const { max, step } = niceScale(peak);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, k) => max - k * step);
  const fmt = metric === 'cost' ? compactUsd : compactTokens;
  const n = days.length;
  const xAt = (i: number) => (n <= 1 ? VB_W / 2 : (i / (n - 1)) * VB_W);
  const yAt = (v: number) => VB_H - (v / max) * VB_H;
  const xLabels = n <= 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];

  const onMove = (e: React.PointerEvent) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || n === 0) return;
    const rel = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    setHover(n <= 1 ? 0 : Math.round(rel * (n - 1)));
  };

  const hoverLeft = hover == null ? 0 : n <= 1 ? 50 : (hover / (n - 1)) * 100;

  return (
    <div className="stats-chart2">
      <h4 className="stats-chart2-title">{title}</h4>
      <div className="stats-chart2-grid">
        <div className="stats-chart2-yaxis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ top: `${(1 - t / max) * 100}%` }}>
              {fmt(t)}
            </span>
          ))}
        </div>
        <div
          className="stats-chart2-plot"
          ref={plotRef}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`${title}, ${lines.map((l) => l.label).join(', ')}`}
        >
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((t) => (
              <line
                key={t}
                className={t === 0 ? 'stats-chart2-base' : 'stats-chart2-gridline'}
                x1={0}
                x2={VB_W}
                y1={yAt(t)}
                y2={yAt(t)}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {n > 1 &&
              lines.map((l) => {
                const pts = l.values.map((v, i) => [xAt(i), yAt(v)] as [number, number]);
                const d = monotonePath(pts);
                return (
                  <g key={l.key}>
                    <path
                      d={`${d} L${VB_W},${VB_H} L0,${VB_H} Z`}
                      style={{ fill: l.color }}
                      className="stats-chart2-area"
                    />
                    <path
                      d={d}
                      style={{ stroke: l.color }}
                      className="stats-chart2-line"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })}
          </svg>
          {/* One day has no line to draw — mark each series' value instead. */}
          {n === 1 &&
            lines.map((l) => (
              <span
                key={l.key}
                className="stats-chart2-dot"
                style={{ left: '50%', top: `${(1 - l.values[0] / max) * 100}%`, background: l.color }}
              />
            ))}
          {hover != null && (
            <>
              <span className="stats-chart2-cursor" style={{ left: `${hoverLeft}%` }} />
              <div
                className={`stats-chart2-tip${hoverLeft > 60 ? ' flip' : ''}`}
                style={{ left: `${hoverLeft}%` }}
              >
                <div className="stats-chart2-tip-day">{axisDay(days[hover])}</div>
                {lines
                  .filter((l) => l.values[hover] > 0)
                  .map((l) => (
                    <div className="stats-chart2-tip-row" key={l.key}>
                      <i style={{ background: l.color }} />
                      <span>{l.label}</span>
                      <b>{metric === 'cost' ? formatUsd(l.values[hover]) : compactTokens(l.values[hover])}</b>
                    </div>
                  ))}
                {lines.every((l) => !(l.values[hover] > 0)) && (
                  <div className="stats-chart2-tip-row muted">No usage</div>
                )}
              </div>
            </>
          )}
        </div>
        <span />
        <div className="stats-chart2-xaxis" aria-hidden="true">
          {xLabels.map((i) => (
            <span
              key={i}
              style={{ left: `${n <= 1 ? 50 : (i / (n - 1)) * 100}%` }}
              className={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : ''}
            >
              {axisDay(days[i] ?? '')}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Totals and token types
// ---------------------------------------------------------------------------

export function TotalsRow({ summary, total }: { summary: StatsSummary; total: number }) {
  const cells: { label: string; value: string; title?: string }[] = [
    { label: 'Processed tokens', value: compactTokens(total) },
    { label: 'Cached input', value: compactTokens(summary.cacheReadTokens), title: 'Input read back from the prompt cache' },
    { label: 'Uncached input', value: compactTokens(summary.inputTokens), title: 'Input billed at the full rate' },
    { label: 'Output', value: compactTokens(summary.outputTokens) },
    {
      label: 'Cache savings',
      value:
        summary.cacheSavingsUsd == null
          ? 'n/a'
          : `$${summary.cacheSavingsUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      title: 'What cache reads saved against paying full input price, on priced models',
    },
  ];
  return (
    <section className="stats-block">
      <h4 className="stats-block-title">Totals</h4>
      <div className="stats-totals">
        {cells.map((c) => (
          <div className="stats-total" key={c.label} title={c.title}>
            <span className="stats-total-label">{c.label}</span>
            <span className="stats-total-value">{c.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TokensByType({ summary }: { summary: StatsSummary }) {
  const parts = [
    { key: 'input', label: 'Input', value: summary.inputTokens },
    { key: 'cache-read', label: 'Cache read', value: summary.cacheReadTokens },
    { key: 'cache-write', label: 'Cache write', value: summary.cacheWriteTokens },
    { key: 'output', label: 'Output', value: summary.outputTokens },
  ];
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <section className="stats-block">
      <h4 className="stats-block-title">Tokens by type</h4>
      <div className="stats-typebar" aria-hidden="true">
        {total > 0 &&
          parts.map((p) =>
            p.value > 0 ? (
              <span
                key={p.key}
                className={`stats-typebar-seg type-${p.key}`}
                style={{ flexGrow: p.value / total }}
              />
            ) : null,
          )}
      </div>
      <ul className="stats-typelegend">
        {parts.map((p) => (
          <li key={p.key}>
            <i className={`type-${p.key}`} />
            {p.label} <b>{compactTokens(p.value)}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ranked list (left column) and breakdown table
// ---------------------------------------------------------------------------

export type RankedRow = {
  key: string;
  label: string;
  mark?: ReactNode;
  color: string;
  /** Small text right of the name, e.g. "25 sessions". */
  aside?: string;
  tokens: number;
  share: number;
  cost: number | null;
  partialCost?: boolean;
};

export function SeriesList({ rows }: { rows: RankedRow[] }) {
  return (
    <ul className="stats-series">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="stats-series-top">
            <i className="stats-series-dot" style={{ background: r.color }} />
            {r.mark && <span className="stats-series-mark">{r.mark}</span>}
            <span className="stats-series-name" title={r.label}>
              {r.label}
            </span>
            {r.aside && <span className="stats-series-aside">{r.aside}</span>}
            <span className="stats-series-tokens">{compactTokens(r.tokens)}</span>
          </div>
          <div className="stats-series-sub">
            {sharePercent(r.share)} of tokens · {formatUsd(r.cost)}
            {r.partialCost && r.cost != null ? '+' : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BreakdownTable({
  rows,
  nameHeader,
  emptyHint,
}: {
  rows: RankedRow[];
  nameHeader: string;
  emptyHint: string;
}) {
  if (rows.length === 0) return <p className="shell-hint stats-empty-hint">{emptyHint}</p>;
  const top = Math.max(...rows.map((r) => r.share), 0) || 1;
  return (
    <div className="stats-btable-scroll">
      <table className="stats-btable">
        <thead>
          <tr>
            <th className="stats-btable-rank">#</th>
            <th>{nameHeader}</th>
            <th className="stats-num">Cost</th>
            <th className="stats-num">Share</th>
            <th className="stats-num">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key}>
              <td className="stats-btable-rank">{i + 1}</td>
              <td className="stats-btable-name">
                <span className="stats-btable-label">
                  {r.mark && <span className="stats-series-mark">{r.mark}</span>}
                  <span title={r.label}>{r.label}</span>
                </span>
                <span
                  className="stats-btable-bar"
                  // Every row scales against the same track (220px, or the cell
                  // when narrower), so bar lengths compare across rows.
                  style={{
                    width: `max(4px, calc(min(220px, 100%) * ${(r.share / top).toFixed(4)}))`,
                    background: r.color,
                  }}
                />
              </td>
              <td className={`stats-num${r.cost == null ? ' muted' : ' strong'}`}>
                {r.cost == null ? 'Unpriced' : formatUsd(r.cost)}
              </td>
              <td className="stats-num muted">{sharePercent(r.share)}</td>
              <td className="stats-num">{compactTokens(r.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
