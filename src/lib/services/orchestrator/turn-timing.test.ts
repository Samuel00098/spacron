import { describe, expect, it } from 'vitest';
import { createTurnTiming, formatDuration, formatTurnTiming, recordModelCall, recordToolCall } from './turn-timing';

describe('turn timing', () => {
  it('breaks a turn down into model time, operations, and waiting', () => {
    const timing = createTurnTiming(0);
    recordModelCall(timing, 30_000);
    recordModelCall(timing, 82_000);
    recordToolCall(timing, 4_000);
    recordToolCall(timing, 6_000);

    expect(formatTurnTiming(timing, 180_000)).toBe([
      'Worked for 3m 00s',
      '',
      '2 model calls: 1m 52s (slowest 1m 22s)',
      '2 operations: 10s',
      'waiting on you or other work: 58s',
    ].join('\n'));
  });

  it('says nothing for a turn that never called a model', () => {
    expect(formatTurnTiming(createTurnTiming(0), 5_000)).toBeNull();
  });

  it('formats durations compactly', () => {
    expect(formatDuration(400)).toBe('0s');
    expect(formatDuration(59_400)).toBe('59s');
    expect(formatDuration(61_000)).toBe('1m 01s');
  });
});
