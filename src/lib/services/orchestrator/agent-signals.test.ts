import { describe, expect, it } from 'vitest';
import {
  countBell,
  countBellStream,
  createBellScanState,
  containsAttentionRequest,
  containsLimitNotice,
  attentionReason,
  limitReason,
} from './agent-signals';
import { agentLimitPhrases } from './agent-rules-file';

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

  it('broadens coverage with the universal structural cues', () => {
    // Bare (y/N) the original bracket set missed, plus the approval/paused cues.
    expect(containsAttentionRequest('Apply this change? (y/N)')).toBe(true);
    expect(containsAttentionRequest('Tool call awaiting approval…')).toBe(true);
    expect(containsAttentionRequest('Paused — is this ok?')).toBe(true);
  });

  it('layers per-CLI phrases onto the universal pattern', () => {
    // Codex prints "Send? (y/N)" at its approval gate — covered by the generic
    // (y/N) cue now, but a phrase like its bare "send?" is CLI-specific.
    expect(containsAttentionRequest('Send?', ['send?', 'proceed?'])).toBe(true);
    // Gemini's "awaiting approval" only fires with the per-CLI phrase present.
    expect(containsAttentionRequest('exec tool awaiting approval', ['awaiting approval'])).toBe(true);
    // Without the extra phrase, a CLI-specific cue alone must NOT match.
    expect(containsAttentionRequest('Send?')).toBe(false);
  });

  it('does not false-match ordinary prose containing a phrase fragment', () => {
    // "allow" is a Codex/OpenCode phrase; ensure it doesn't trip on narration.
    expect(containsAttentionRequest('I will allow the tests to run automatically.')).toBe(false);
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

  // A TUI agent's tail is mostly escape codes; the blocked card used to print
  // them verbatim (`[38;2;200;200;200;48;2;20;20;20m ...`).
  it('strips ANSI/CSI noise out of the snippet', () => {
    const raw =
      '\x1b[10;64H\x1b[38;2;200;200;200;48;2;20;20;20m\u2502 ' +
      'I updated the renderer. Do you want to run the tests now?' +
      '\x1b[39m\x1b[49m\u2502\x1b[0m';
    const reason = attentionReason(raw);
    expect(reason.toLowerCase()).toContain('do you want to run the tests');
    expect(reason).not.toMatch(/\x1b|\[\d+;\d+[Hm]/);
    expect(reason).not.toContain('\u2502');
  });

  // OSC window-title strings carry the same phrases and are pure noise on a card.
  it('drops OSC window-title sequences', () => {
    const raw = '\x1b]0;grok - Waiting for response... - Fix Rendering\x07';
    expect(attentionReason(raw)).toBe('Agent is waiting for your input.');
  });
});

describe('containsLimitNotice', () => {
  // The whole point of this matcher is that it is *narrower* than the attention
  // one. A false attention match misreports a working agent as blocked; a false
  // limit match throws a half-built feature at another agent for nothing.

  it('recognises the refusals these CLIs actually print', () => {
    expect(containsLimitNotice('You have reached your usage limit.')).toBe(true);
    expect(containsLimitNotice('Usage limit reached. Your limit will reset at 5pm.')).toBe(true);
    expect(containsLimitNotice("You've hit your weekly usage limit")).toBe(true);
    expect(containsLimitNotice('You are out of credits.')).toBe(true);
    expect(containsLimitNotice('Quota exceeded for this project', ['quota exceeded'])).toBe(true);
  });

  it('ignores an agent merely writing about rate limits', () => {
    // This is the false positive that matters: agents write retry logic, read
    // vendor docs, and name variables `rateLimit` all day.
    expect(containsLimitNotice('Added a rateLimit guard to the fetch helper.')).toBe(false);
    expect(containsLimitNotice('The API returns 429 when you send too fast.')).toBe(false);
    expect(containsLimitNotice('function handleQuota(limit: number) {')).toBe(false);
    expect(containsLimitNotice('I will now run the tests.')).toBe(false);
  });

  it('reads through the terminal escape codes a real tail is dense with', () => {
    const raw =
      '\x1b[10;64H\x1b[38;2;200;200;200m│ ' +
      'You have reached your usage limit. Try again later.' +
      '\x1b[39m│\x1b[0m';
    expect(containsLimitNotice(raw)).toBe(true);
    expect(limitReason(raw).toLowerCase()).toContain('usage limit');
  });

  it('quotes the CLI rather than inventing a sentence, when it can', () => {
    const reason = limitReason('Usage limit reached. Your limit will reset at 5pm.');
    expect(reason.toLowerCase()).toContain('usage limit reached');
    expect(reason).not.toMatch(/\x1b/);
  });

  it('falls back to a plain statement when nothing quotable matched', () => {
    expect(limitReason('')).toBe('The agent stopped on its usage limit.');
  });
});

describe('agentLimitPhrases', () => {
  it('resolves by executable, so a launcher prefix or a path does not lose them', () => {
    expect(agentLimitPhrases('npx opencode --foo')).toEqual(agentLimitPhrases('opencode'));
    expect(agentLimitPhrases('/usr/local/bin/claude')).toEqual(agentLimitPhrases('claude'));
    expect(agentLimitPhrases('claude.cmd')).toEqual(agentLimitPhrases('claude'));
  });

  it('is empty for a CLI whose refusal text nobody has verified', () => {
    // Deliberately absent rather than half-supported: a guessed phrase either
    // never fires or fires on ordinary output, and the second is much worse.
    expect(agentLimitPhrases('crush')).toEqual([]);
    expect(agentLimitPhrases(null)).toEqual([]);
  });
});
