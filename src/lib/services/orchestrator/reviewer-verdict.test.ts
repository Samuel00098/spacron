import { describe, it, expect } from 'vitest';
import { parseReviewerVerdict } from './reviewer-verdict';
import { ROLE_BRIEFS } from './agent-charter';

describe('parseReviewerVerdict', () => {
  it('reads an approval on its own line', () => {
    expect(parseReviewerVerdict('running tests...\nall green\nAPPROVED spacron/kid-6z92ac\n'))
      .toEqual({ kind: 'approved', branch: 'spacron/kid-6z92ac' });
  });

  it('reads a bounce-back with its feedback', () => {
    expect(parseReviewerVerdict('diff looks off\nBOUNCE BACK: null check missing in parseDate\n'))
      .toEqual({ kind: 'bounce', feedback: 'null check missing in parseDate' });
  });

  it('tolerates a shell prompt prefix and trailing punctuation', () => {
    expect(parseReviewerVerdict('$ APPROVED feature-x.'))
      .toEqual({ kind: 'approved', branch: 'feature-x' });
  });

  it.each(['APPROVED "feature-x"', 'APPROVED `feature-x`', "APPROVED 'feature-x'."])(
    'unwraps a quoted branch: %s',
    (line) => {
      expect(parseReviewerVerdict(line)).toEqual({ kind: 'approved', branch: 'feature-x' });
    },
  );

  // ── The regression this module exists for ────────────────────────────────
  // The Reviewer charter tells the agent to emit these tokens, so its text
  // contains them. Echoed into the terminal buffer, the original unanchored
  // regexes matched the INSTRUCTIONS and fired a verdict on every single turn.
  it('does not treat the reviewer charter itself as a verdict', () => {
    expect(parseReviewerVerdict(ROLE_BRIEFS.reviewer)).toBeNull();
  });

  it('does not fire on a charter echoed at the start of a turn', () => {
    const transcript = `${ROLE_BRIEFS.reviewer}\n\nLet me look at the diff.\n${'.'.repeat(300)}\nStill reviewing, no verdict yet.\n`;
    expect(parseReviewerVerdict(transcript)).toBeNull();
  });

  it('ignores the tokens when they appear mid-sentence', () => {
    // A verdict has to start its own line, so prose that merely mentions the
    // token — the exact shape of the charter echo — never counts.
    expect(parseReviewerVerdict('I would have APPROVED this but the tests fail.')).toBeNull();
    expect(parseReviewerVerdict('Next time I will BOUNCE BACK: sooner.')).toBeNull();
  });

  it('is case-sensitive — lowercase prose is not a verdict', () => {
    expect(parseReviewerVerdict('the change is approved main by me')).toBeNull();
  });

  it('only reads the tail, so an early verdict in a long log is ignored', () => {
    const transcript = `APPROVED old-branch\n${'x'.repeat(5000)}`;
    expect(parseReviewerVerdict(transcript)).toBeNull();
  });

  it('prefers bounce-back when a transcript somehow shows both', () => {
    const transcript = 'APPROVED some-branch\nBOUNCE BACK: actually the tests fail\n';
    expect(parseReviewerVerdict(transcript)).toEqual({
      kind: 'bounce',
      feedback: 'actually the tests fail',
    });
  });

  it('returns null for an empty or verdict-free transcript', () => {
    expect(parseReviewerVerdict('')).toBeNull();
    expect(parseReviewerVerdict('just some ordinary output\n')).toBeNull();
  });
});
