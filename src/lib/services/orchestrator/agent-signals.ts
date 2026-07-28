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
  let count = 0;
  let inOsc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x1b) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x5d) {
        inOsc = true;
        i += 1;
      } else {
        inOsc = false;
      }
      continue;
    }
    if (ch === 7) {
      if (!inOsc) count += 1;
      inOsc = false;
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
