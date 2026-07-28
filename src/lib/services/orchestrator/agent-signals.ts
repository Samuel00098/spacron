// Shared signals for reasoning about a CLI agent's state from its terminal
// output. Used by the orchestrator's turn watcher and by TerminalPane's
// attention toast so the two stay in sync.

/** ASCII BEL — CLI agents commonly ring it when a turn finishes or they want input. */
export const BELL = '\x07';

/**
 * Phrases that indicate an agent has paused waiting for a human decision
 * (confirmation prompts, "waiting for your response", etc.).
 */
export const AGENT_ATTENTION_PATTERN =
  /\[y\/n\]|\[Y\/n\]|\[n\/Y\]|\(y\/n\)|\(Y\/n\)|\(yes\/no\)|\[yes\/no\]|do you want to|would you like to|shall i\b|please (confirm|review|choose|select)|press enter to continue|awaiting (your )?input|waiting for (your )?response|needs? your (input|attention|review)/i;

/**
 * Escape-sequence position carried between calls to `countBellStream`.
 *
 * `inOsc` — we are inside an OSC string, so the next BEL terminates it.
 * `escPending` — the chunk ended on a bare ESC; whether it opens an OSC is
 * decided by the first character of the next chunk.
 */
export type BellScanState = { inOsc: boolean; escPending: boolean };

export function createBellScanState(): BellScanState {
  return { inOsc: false, escPending: false };
}

/** Count BEL characters that are NOT part of OSC escape sequences.
 *
 * CLI agents commonly use \x07 as the string terminator for OSC (Operating
 * System Command) sequences such as `\x1b]0;My Title\x07` (set window title).
 * Counting every \x07 indiscriminately causes the bell heuristic in the turn
 * watcher to treat these embedded terminators as turn-completion signals,
 * producing false `finished` outcomes while the agent is still working.
 *
 * An OSC sequence begins with ESC ] (\x1b\x5d) and ends with either BEL (\x07)
 * or ESC \ (\x1b\x5c). We track whether we are inside an OSC sequence and
 * ignore BEL characters that serve as its terminator.
 */
export function countBell(text: string): number {
  return countBellStream(text, createBellScanState());
}

/**
 * `countBell` over a stream of chunks, carrying escape state in `state`.
 *
 * The watcher used to re-count the whole session buffer on every poll and
 * compare totals. That buffer is capped and slides, so each poll scanned from a
 * *different* start offset — and an offset landing inside an OSC string turns
 * that string's terminating BEL into a standalone one, inventing a bell that
 * was never rung. Scanning only newly appended text removes the moving start
 * offset (and the repeated 250k-char scan), but an OSC string can straddle a
 * chunk boundary, which is why the state is threaded rather than reset.
 */
export function countBellStream(text: string, state: BellScanState): number {
  let count = 0;
  let i = 0;

  if (state.escPending) {
    if (text.length === 0) return 0;
    state.escPending = false;
    if (text.charCodeAt(0) === 0x5d) {
      state.inOsc = true;
      i = 1;
    } else {
      // Not an OSC introducer — the character stands on its own, so fall
      // through and scan it normally.
      state.inOsc = false;
    }
  }

  for (; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x1b) {
      if (i + 1 < text.length) {
        if (text.charCodeAt(i + 1) === 0x5d) {
          state.inOsc = true;
          i += 1;
        } else {
          state.inOsc = false;
        }
      } else {
        state.escPending = true;
      }
      continue;
    }
    if (ch === 7) {
      if (!state.inOsc) count += 1;
      state.inOsc = false;
    }
  }
  return count;
}

/** True when the output shows the agent waiting on the user. */
export function containsAttentionRequest(text: string): boolean {
  return AGENT_ATTENTION_PATTERN.test(text);
}

/** A short, human-facing reason for a blocked task derived from agent output. */
export function attentionReason(text: string): string {
  const match = text.match(AGENT_ATTENTION_PATTERN);
  if (match) {
    // Surface a little surrounding context so the blocked card is actionable.
    const idx = match.index ?? 0;
    const snippet = text.slice(Math.max(0, idx - 40), idx + match[0].length + 40).replace(/\s+/g, ' ').trim();
    if (snippet) return snippet.length > 140 ? `${snippet.slice(0, 137)}…` : snippet;
  }
  return 'Agent is waiting for your input.';
}
