import { describe, expect, it } from 'vitest';
import {
  countBell,
  countBellStream,
  createBellScanState,
  containsAttentionRequest,
  attentionReason,
} from './agent-signals';

/** Feed `text` through the streaming scanner in fixed-size chunks. */
function countChunked(text: string, size: number): number {
  const state = createBellScanState();
  let total = 0;
  for (let i = 0; i < text.length; i += size) {
    total += countBellStream(text.slice(i, i + size), state);
  }
  return total;
}

describe('countBell', () => {
  it('counts BEL characters', () => {
    expect(countBell('no bells here')).toBe(0);
    expect(countBell('done\x07')).toBe(1);
    expect(countBell('\x07a\x07b\x07')).toBe(3);
  });

  it('ignores BEL used as OSC string terminator', () => {
    // OSC sequences: ESC ] number ; string BEL — common for setting titles etc.
    expect(countBell('\x1b]0;My Title\x07')).toBe(0);
    expect(countBell('\x1b]10;?\x07')).toBe(0);
    // Multiple OSC sequences
    expect(countBell('\x1b]0;first\x07\x1b]0;second\x07')).toBe(0);
    // Normal BEL mixed with OSC-terminated BEL
    expect(countBell('done\x07\x1b]0;idle\x07')).toBe(1);
    // OSC terminated by ESC \ instead of BEL
    expect(countBell('\x1b]0;title\x1b\\')).toBe(0);
    // Real BEL after an OSC sequence
    expect(countBell('\x1b]0;title\x07payload\x07')).toBe(1);
  });
});

describe('countBellStream', () => {
  // The watcher scans newly appended output, so an OSC sequence can be split
  // across two calls. Splitting must not change the count — a boundary that
  // hides the `ESC ]` introducer would promote the sequence's terminator to a
  // standalone bell and false-complete a turn the agent is still working on.
  const samples = [
    '\x1b]0;My Title\x07',
    'work\x1b]0;title\x07more\x07',
    '\x1b]0;first\x07\x1b]0;second\x07',
    '\x1b]0;title\x1b\\payload\x07',
    'plain output with no escapes at all',
    '\x07\x07\x07',
  ];

  it('matches whole-string counting at every chunk boundary', () => {
    for (const sample of samples) {
      const whole = countBell(sample);
      for (let size = 1; size <= sample.length; size += 1) {
        expect(countChunked(sample, size)).toBe(whole);
      }
    }
  });

  it('carries a trailing ESC into the next chunk', () => {
    const state = createBellScanState();
    // The chunk ends mid-introducer: whether the BEL that follows is a real
    // ring is not yet decidable, so nothing may be counted until it is.
    expect(countBellStream('title\x1b', state)).toBe(0);
    expect(state.escPending).toBe(true);
    expect(countBellStream(']0;window\x07', state)).toBe(0);
  });

  it('counts a real bell that follows an unrelated escape', () => {
    const state = createBellScanState();
    expect(countBellStream('\x1b', state)).toBe(0);
    expect(countBellStream('[0m done\x07', state)).toBe(1);
  });
});

describe('containsAttentionRequest', () => {
  it('matches common confirmation prompts', () => {
    expect(containsAttentionRequest('Proceed? [y/n]')).toBe(true);
    expect(containsAttentionRequest('Do you want to continue?')).toBe(true);
    expect(containsAttentionRequest('Waiting for your response…')).toBe(true);
  });

  it('ignores ordinary output', () => {
    expect(containsAttentionRequest('Refactored 3 files and ran the tests.')).toBe(false);
  });
});

describe('attentionReason', () => {
  it('returns a contextual snippet around the prompt', () => {
    const reason = attentionReason('I changed auth.ts. Do you want to run the tests now?');
    expect(reason.toLowerCase()).toContain('do you want to');
  });

  it('falls back to a generic message', () => {
    expect(attentionReason('[y/n]')).toMatch(/\[y\/n\]|waiting for your input/i);
  });
});
