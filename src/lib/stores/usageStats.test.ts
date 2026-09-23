import { describe, it, expect } from 'vitest';
import {
  breakdownShare,
  breakdownTokens,
  busiestDay,
  currentScanState,
  formatPercent,
  formatTokens,
  formatUsd,
  heatmapRows,
  lastDailyPoints,
  sessionTokens,
  shortDayLabel,
  tokenMix,
  totalTokens,
  zeroCacheReadShare,
  DEFAULT_RANGE,
  PROVIDER_ALL,
  PROVIDER_CLAUDE,
  RANGE_ALL,
  type BreakdownEntry,
  type DailyPoint,
  type HeatmapDay,
  type ScanState,
  type StatsSummary,
  type UsageStatsState,
} from './usageStats';

function summary(partial: Partial<StatsSummary> = {}): StatsSummary {
  return {
    sessions: 0,
    turns: 0,
    zeroCacheReadTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheReuseRate: null,
    estimatedCostUsd: null,
    hasPartialCost: false,
    topModel: null,
    topProject: null,
    ...partial,
  };
}

function day(partial: Partial<DailyPoint> & { day: string }): DailyPoint {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  };
}

function entry(partial: Partial<BreakdownEntry> = {}): BreakdownEntry {
  return {
    key: 'k',
    label: 'k',
    sessions: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: null,
    ...partial,
  };
}

describe('formatTokens', () => {
  it('formats plain counts and K/M magnitudes', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(412)).toBe('412');
    expect(formatTokens(12_300)).toBe('12.3K');
    expect(formatTokens(123_400)).toBe('123K');
    expect(formatTokens(1_240_000)).toBe('1.24M');
  });

  it('never emits NaN for nonsense input', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
  });
});

describe('formatUsd', () => {
  it('always shows two decimals for money', () => {
    expect(formatUsd(1.8)).toBe('$1.80');
    expect(formatUsd(0.076)).toBe('$0.08');
    expect(formatUsd(0.074)).toBe('$0.07');
  });

  it('dashes an unpriced total rather than lying with $0.00', () => {
    expect(formatUsd(null)).toBe('n/a');
  });
});

describe('totalTokens / sessionTokens / breakdownTokens', () => {
  it('sums the four buckets on the summary', () => {
    expect(
      totalTokens(
        summary({
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheWriteTokens: 50,
        })
      )
    ).toBe(1750);
  });

  it('sums the four buckets on a session row', () => {
    expect(
      sessionTokens({
        sessionId: 's1',
        provider: 'claude',
        providerLabel: 'Claude',
        lastActiveAt: 0,
        durationMinutes: 5,
        projectLabel: 'p',
        managed: false,
        branch: null,
        model: null,
        turns: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
      })
    ).toBe(100);
  });

  it('ranks breakdown rows by input + output only (Orca sorts by this)', () => {
    expect(breakdownTokens(entry({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 }))).toBe(15);
  });
});

describe('breakdownShare', () => {
  it('is the entry share of input+output across the list', () => {
    const entries = [
      entry({ key: 'a', inputTokens: 300, outputTokens: 0 }),
      entry({ key: 'b', inputTokens: 100, outputTokens: 0 }),
    ];
    expect(breakdownShare(entries[0], entries)).toBeCloseTo(0.75);
    expect(breakdownShare(entries[1], entries)).toBeCloseTo(0.25);
  });

  it('is null when there is nothing to divide', () => {
    expect(breakdownShare(entry(), [entry(), entry()])).toBeNull();
  });
});

describe('zeroCacheReadShare', () => {
  it('is the fraction of turns with no cache reads', () => {
    expect(zeroCacheReadShare(summary({ turns: 4, zeroCacheReadTurns: 1 }))).toBeCloseTo(0.25);
  });

  it('is null when there are no turns', () => {
    expect(zeroCacheReadShare(summary())).toBeNull();
  });
});

describe('shortDayLabel', () => {
  it('renders a UTC date without inventing a timezone', () => {
    expect(shortDayLabel('2026-08-10')).toBe('Aug 10');
    expect(shortDayLabel('2026-12-01')).toBe('Dec 1');
  });

  it('passes through malformed input untouched', () => {
    expect(shortDayLabel('soon')).toBe('soon');
  });
});

describe('lastDailyPoints', () => {
  it('takes the trailing slice, oldest first, and pads short series by returning all', () => {
    const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'].map((d) => day({ day: d }));
    expect(lastDailyPoints(days, 10).map((d) => d.day)).toEqual(days.map((d) => d.day));
    expect(lastDailyPoints(days, 2).map((d) => d.day)).toEqual(['2026-08-03', '2026-08-04']);
  });
});

// ---------------------------------------------------------------------------
// Multi-provider helpers
// ---------------------------------------------------------------------------

function heat(day: string, totalTokens: number, level: number): HeatmapDay {
  return { day, totalTokens, level };
}

function scanState(partial: Partial<ScanState> = {}): ScanState {
  return {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    lastScanError: null,
    hasAnyClaudeData: true,
    ...partial,
  };
}

function state(partial: Partial<UsageStatsState> = {}): UsageStatsState {
  return {
    snapshot: null,
    overview: null,
    provider: PROVIDER_ALL,
    scope: 'all',
    range: RANGE_ALL,
    loading: false,
    error: null,
    lastFetchedAt: 0,
    ...partial,
  };
}

describe('the default range', () => {
  it('is all time, so history is not hidden behind an untouched filter', () => {
    expect(DEFAULT_RANGE).toBe(RANGE_ALL);
  });
});

describe('heatmapRows', () => {
  it('splits 42 days into two equal rows', () => {
    const days = Array.from({ length: 42 }, (_, i) => heat(`d${i}`, i, 1));
    const rows = heatmapRows(days);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(21);
    expect(rows[1]).toHaveLength(21);
  });

  it('keeps the newest day last so the grid reads left-to-right', () => {
    const days = Array.from({ length: 42 }, (_, i) => heat(`d${i}`, i, 1));
    const rows = heatmapRows(days);
    expect(rows[1][rows[1].length - 1].day).toBe('d41');
  });

  it('does not drop the remainder when the count is uneven', () => {
    const days = Array.from({ length: 5 }, (_, i) => heat(`d${i}`, i, 1));
    expect(heatmapRows(days).flat()).toHaveLength(5);
  });
});

describe('busiestDay', () => {
  it('picks the day with the most tokens', () => {
    const days = [heat('2026-08-01', 10, 1), heat('2026-08-02', 900, 4), heat('2026-08-03', 5, 1)];
    expect(busiestDay(days)?.day).toBe('2026-08-02');
  });

  it('returns null when every day is empty, rather than naming an idle day', () => {
    expect(busiestDay([heat('2026-08-01', 0, 0), heat('2026-08-02', 0, 0)])).toBeNull();
  });
});

describe('tokenMix', () => {
  it('splits the bar into shares that sum to one', () => {
    const mix = tokenMix(
      summary({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0 })
    );
    expect(mix).not.toBeNull();
    expect(mix!.input).toBeCloseTo(0.25);
    expect(mix!.output).toBeCloseTo(0.25);
    expect(mix!.cache).toBeCloseTo(0.5);
    expect(mix!.input + mix!.output + mix!.cache).toBeCloseTo(1);
  });

  it('is null with no tokens, so the bar is omitted instead of drawn empty', () => {
    expect(tokenMix(summary())).toBeNull();
  });
});

describe('formatPercent', () => {
  it('rounds to whole percent', () => {
    expect(formatPercent(0.426)).toBe('43%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('renders null as a dash rather than 0%', () => {
    expect(formatPercent(null)).toBe('n/a');
  });
});

describe('currentScanState', () => {
  it('reads the overview when the Overview tab is selected', () => {
    const s = state({
      provider: PROVIDER_ALL,
      overview: { scanState: scanState({ enabled: false }) } as never,
    });
    expect(currentScanState(s)?.enabled).toBe(false);
  });

  it('reads the snapshot on a provider tab', () => {
    const s = state({
      provider: PROVIDER_CLAUDE,
      snapshot: { scanState: scanState({ enabled: true }) } as never,
      overview: { scanState: scanState({ enabled: false }) } as never,
    });
    expect(currentScanState(s)?.enabled).toBe(true);
  });

  it('is null before either payload arrives', () => {
    expect(currentScanState(state())).toBeNull();
  });
});
