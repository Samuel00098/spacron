import { describe, expect, it } from 'vitest';
import { nextOccurrence } from './schedule';

describe('automation calendar', () => {
  it('runs at the next hourly minute, strictly after the current time', () => {
    expect(nextOccurrence('hourly', '09:15', 1, new Date(2026, 10, 20, 10, 15).getTime())).toBe(new Date(2026, 10, 20, 11, 15).getTime());
  });
  it('skips the weekend after Friday’s run', () => {
    expect(nextOccurrence('weekdays', '09:00', 1, new Date(2026, 10, 20, 9).getTime())).toBe(new Date(2026, 10, 23, 9).getTime());
  });
  it('moves to next week when this week’s time passed', () => {
    expect(nextOccurrence('weekly', '09:00', 5, new Date(2026, 10, 20, 10).getTime())).toBe(new Date(2026, 10, 27, 9).getTime());
  });
  it('rejects malformed times rather than normalizing them', () => {
    expect(() => nextOccurrence('daily', '25:90', 1, Date.now())).toThrow();
  });
});
