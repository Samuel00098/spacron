/**
 * Parsing of a Reviewer agent's verdict out of its terminal transcript.
 *
 * Kept as a pure module so the matching rules can be tested directly: an earlier
 * version lived inline in the orchestrator store with unanchored,
 * case-insensitive regexes (`/APPROVED\s+(\S+)/i`, `/BOUNCE\s+BACK\s*:\s*(.+)/i`)
 * run over the whole transcript. Because the transcript is the raw terminal
 * buffer it echoes the charter — and the Reviewer charter literally contains
 * `say "APPROVED <branch>"` and `say "BOUNCE BACK: <specific fixes required>"`.
 * Every review therefore matched BOTH verdicts off its own instructions, so each
 * one auto-merged the builder's branch and told the builder to redo the work,
 * whatever the reviewer actually decided.
 *
 * The rules that prevent that recurrence:
 *   1. Anchor to a whole line (`^…$` with the `m` flag), not a substring.
 *   2. Match case-sensitively — the charter's prose is prescriptive, the
 *      verdict is a literal token the agent must emit exactly.
 *   3. Only look at the tail of the transcript; a verdict is the agent's last
 *      word, so an echoed prompt earlier in the scrollback can never register.
 */

/** A bounce-back line: `BOUNCE BACK: <feedback>` on its own line. */
const BOUNCE_BACK_RE = /^[\s>$#]*BOUNCE BACK:[ \t]*(\S.*)$/m;

/** An approval line: `APPROVED <branch>` alone on its own line. */
const APPROVED_RE = /^[\s>$#]*APPROVED[ \t]+(\S+)[ \t]*$/m;

/**
 * How much of the tail of the transcript a verdict may appear in. Large enough
 * for a closing summary, far too small to reach a charter pasted at turn start.
 */
export const VERDICT_TAIL_CHARS = 2000;

export type ReviewerVerdict =
  | { kind: 'bounce'; feedback: string }
  | { kind: 'approved'; branch: string };

/**
 * Parse the reviewer's verdict from a transcript, or null when there isn't one.
 *
 * Bounce-back takes precedence: the two outcomes are mutually exclusive, and if
 * a transcript somehow shows both, the conservative one (which touches no git
 * state) must win.
 */
export function parseReviewerVerdict(transcript: string): ReviewerVerdict | null {
  const tail = (transcript ?? '').slice(-VERDICT_TAIL_CHARS);
  if (!tail) return null;

  const bounce = BOUNCE_BACK_RE.exec(tail);
  if (bounce) {
    const feedback = bounce[1].trim();
    if (feedback) return { kind: 'bounce', feedback };
  }

  const approved = APPROVED_RE.exec(tail);
  if (approved) {
    // Agents commonly quote, backtick, or end-punctuate the branch:
    // `APPROVED "my-branch".` — the branch must match the worktree exactly
    // downstream, so normalise those wrappers away here.
    const branch = approved[1]
      .trim()
      .replace(/^[`'"(\[]+/, '')
      .replace(/[`'")\].,;:]+$/, '');
    if (branch) return { kind: 'approved', branch };
  }

  return null;
}
