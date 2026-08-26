import { describe, it, expect } from 'vitest';
import { completionVerb, completionHeadline } from './AgentNotifications';

/**
 * The card is only ever allowed to claim what actually happened. These are the
 * five things it may say, and the three different ways a `done` turn can end —
 * the agent reported it, the process exited, or we assumed it from a quiet
 * screen — must never collapse into one word.
 */
describe('completion copy', () => {
  it('says "finished" only when the agent reported it', () => {
    expect(completionVerb({ status: 'done', endedBy: 'declared' })).toBe('finished');
    expect(completionHeadline({ status: 'done', endedBy: 'declared' })).toBe('Agent finished');
  });

  it('says "exited" for a process that merely ended', () => {
    // `/exit`, Ctrl-D and a finished session all exit cleanly. Calling that
    // "finished" is a claim about work that nothing here observed.
    expect(completionVerb({ status: 'done', endedBy: 'exit' })).toBe('exited');
    expect(completionHeadline({ status: 'done', endedBy: 'exit' })).toBe('Agent exited');
  });

  it('says "went quiet" for a finish nobody reported', () => {
    expect(completionVerb({ status: 'done', endedBy: 'inferred' })).toBe('went quiet');
    expect(completionHeadline({ status: 'done', endedBy: 'inferred' })).toBe('Agent went quiet');
  });

  it('keeps needs-input and failure on their own words', () => {
    expect(completionVerb({ status: 'blocked' })).toBe('needs input');
    expect(completionVerb({ status: 'failed' })).toBe('failed');
    expect(completionHeadline({ status: 'blocked' })).toBe('Agent needs input');
    expect(completionHeadline({ status: 'failed' })).toBe('Agent failed');
  });

  it('treats a card saved before this field existed as declared', () => {
    // Old cards were already worded "finished"; they must not silently become
    // "went quiet" after an upgrade.
    expect(completionVerb({ status: 'done' })).toBe('finished');
  });

  it('never lets the corner and the lock screen disagree', () => {
    for (const endedBy of ['declared', 'exit', 'inferred', undefined] as const) {
      const verb = completionVerb({ status: 'done', endedBy });
      expect(completionHeadline({ status: 'done', endedBy })).toBe(
        `Agent ${verb}`,
      );
    }
  });
});

describe('what an exit is allowed to claim', () => {
  // Both the leased and the adopted process-exit paths now stamp `exit`. The
  // guard is that neither of them can reach the word "finished", and that an
  // exit still interrupts — only a guess is silenced.
  const silentFor = (endedBy: 'declared' | 'exit' | 'inferred') => endedBy === 'inferred';

  it('never calls a bare exit "finished"', () => {
    expect(completionVerb({ status: 'done', endedBy: 'exit' })).not.toContain('finished');
  });

  it('still interrupts for an exit, and only stays quiet for a guess', () => {
    expect(silentFor('declared')).toBe(false);
    expect(silentFor('exit')).toBe(false);
    expect(silentFor('inferred')).toBe(true);
  });
});
