import { describe, it, expect } from 'vitest';
import {
  averageTurnMs,
  formatTrackingSince,
  formatWorkedTime,
  hasActivity,
  type ActivitySummary,
} from './activityStats';

function summary(partial: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    trackingSinceMs: 1_754_000_000_000,
    agentsSpawned: 0,
    turnsCompleted: 0,
    turnsBlocked: 0,
    workedMs: 0,
    providers: [],
    ...partial,
  };
}

describe('formatWorkedTime', () => {
  it('shows at most two units', () => {
    // "3d 4h 12m 9s" claims a precision a bell character does not have.
    expect(formatWorkedTime(3 * 86400_000 + 4 * 3600_000 + 12 * 60_000)).toBe('3d 4h');
    expect(formatWorkedTime(2 * 3600_000 + 15 * 60_000)).toBe('2h 15m');
    expect(formatWorkedTime(45 * 60_000)).toBe('45m');
  });

  it('drops an empty trailing unit rather than printing a zero', () => {
    expect(formatWorkedTime(3 * 86400_000)).toBe('3d');
    expect(formatWorkedTime(2 * 3600_000)).toBe('2h');
  });

  it('falls back to seconds so a short turn is not rendered as 0m', () => {
    expect(formatWorkedTime(30_000)).toBe('30s');
  });

  it('treats nothing and nonsense as zero', () => {
    expect(formatWorkedTime(0)).toBe('0m');
    expect(formatWorkedTime(-5)).toBe('0m');
    expect(formatWorkedTime(Number.NaN)).toBe('0m');
  });
});

describe('hasActivity', () => {
  it('gates on a tracking start, not on the totals', () => {
    // A recorded event with zero elapsed time is still something to show;
    // no recorded event at all is not.
    expect(hasActivity(summary({ trackingSinceMs: null }))).toBe(false);
    expect(hasActivity(null)).toBe(false);
    expect(hasActivity(summary())).toBe(true);
  });
});

describe('averageTurnMs', () => {
  it('divides time worked across every turn, blocked ones included', () => {
    expect(
      averageTurnMs(summary({ workedMs: 60_000, turnsCompleted: 3, turnsBlocked: 1 }))
    ).toBe(15_000);
  });

  it('is null when nothing timed has completed', () => {
    // Guards the display against 0/0 rendering as NaN.
    expect(averageTurnMs(summary({ workedMs: 0, turnsCompleted: 5 }))).toBeNull();
    expect(averageTurnMs(summary({ workedMs: 5_000, turnsCompleted: 0 }))).toBeNull();
    expect(averageTurnMs(null)).toBeNull();
  });
});

describe('formatTrackingSince', () => {
  it('renders an absolute date', () => {
    const formatted = formatTrackingSince(Date.UTC(2026, 7, 4, 12));
    expect(formatted).toBeTruthy();
    expect(formatted).toContain('2026');
  });

  it('is null when nothing has been tracked', () => {
    expect(formatTrackingSince(null)).toBeNull();
    expect(formatTrackingSince(0)).toBeNull();
  });
});
