import { describe, expect, it } from 'vitest';
import { countBell, containsAttentionRequest, attentionReason } from './agent-signals';

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
