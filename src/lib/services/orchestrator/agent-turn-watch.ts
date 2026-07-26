import { getSessionOutputBuffer } from '$lib/stores/terminal';
import { attentionReason, containsAttentionRequest, countBell } from './agent-signals';
import { hasTurnSignalChannel, onTurnSignal } from './agent-hook-signals';

/** Outcome of watching one agent turn on a leased terminal. */
export type AgentTurnOutcome =
  | { kind: 'finished' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'aborted' };

export interface WatchLeasedAgentOptions {
  /** Return false to stop watching (task unlinked, session died, etc.). */
  shouldContinue: () => boolean;
  /** How often to sample the output buffer. */
  pollMs?: number;
  /**
   * How long the output must stop growing — after the agent has produced
   * something — before we treat the turn as finished. Only used as a fallback
   * for agents that go quiet; bell/attention signals fire immediately.
   */
  idleMs?: number;
  /** Bytes of the buffer tail to scan for attention prompts. */
  tailChars?: number;
  /**
   * Minimum total new output (chars) before the idle fallback may finish a turn.
   * Guards against an agent that never actually started: the prompt's own echo
   * or a lone cursor-blink redraw would otherwise look like a tiny burst of
   * "activity" that then goes idle and false-completes a turn nothing ran.
   */
  minWorkChars?: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * With a sentinel channel open, the idle fallback is demoted from a routine
 * path to a last resort.
 *
 * It cannot be removed outright — if a hook silently fails to fire, nothing else
 * would ever end the turn — but at 90 seconds it fires during ordinary long
 * tool calls and *false-completes*, which releases the lease and throws away the
 * answer the agent was about to give. Fifteen minutes is longer than any healthy
 * turn and still bounds a stuck one.
 */
const SIGNALLED_IDLE_MS = 15 * 60 * 1000;

/**
 * Watch a leased agent terminal and resolve once the current turn ends.
 *
 * CLI agents don't exit when they finish a task — they sit in a REPL — and many
 * redraw their TUI constantly, so plain output-quiescence is unreliable. In
 * preference order:
 *   0. a hook sentinel from the agent itself (see `agent-hook-signals.ts`) —
 *      exact, immediate, and the only signal here that isn't a guess;
 *   1. a terminal bell (`\x07`) after the agent has done some work → finished,
 *      unless the recent output is an attention prompt → blocked;
 *   2. an attention prompt on its own → blocked;
 *   3. as a fallback, output that stops growing for `idleMs` → finished.
 *
 * 1–3 remain for CLIs that cannot emit hooks, which is most of them.
 */
export async function watchLeasedAgentTurn(
  sessionId: number,
  opts: WatchLeasedAgentOptions
): Promise<AgentTurnOutcome> {
  const pollMs = opts.pollMs ?? 400;
  // Quiet-agent fallback only. Coding agents routinely go silent for many
  // seconds while thinking, running a tool, or compiling, so a short window
  // false-completes turns mid-work — and because the lease is then released and
  // the task severed from its session, the agent's real answer (printed a beat
  // later) is never read back. Discrete bell/attention signals still finish a
  // turn immediately; this only governs agents that never signal.
  const signalled = hasTurnSignalChannel(sessionId);
  const idleMs = opts.idleMs ?? (signalled ? SIGNALLED_IDLE_MS : 90000);
  const tailChars = opts.tailChars ?? 2000;
  const minWorkChars = opts.minWorkChars ?? 500;

  let lastLen = getSessionOutputBuffer(sessionId).length;
  let lastBell = countBell(getSessionOutputBuffer(sessionId));
  let lastGrowthAt = Date.now();
  let sawActivity = false;
  let grownTotal = 0;

  // A sentinel arriving mid-sleep wakes the loop immediately rather than waiting
  // out the remaining poll interval — the signal is exact, so there is nothing
  // to gain by sampling the screen again first.
  let sentinel: AgentTurnOutcome | null = null;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const unsubscribe = onTurnSignal(sessionId, (signal) => {
    sentinel = signal;
    wake?.();
  });

  try {
    return await runWatchLoop();
  } finally {
    unsubscribe();
  }

  async function runWatchLoop(): Promise<AgentTurnOutcome> {
    for (;;) {
      if (!opts.shouldContinue()) return { kind: 'aborted' };
      await sleep(pollMs);
      if (sentinel) return sentinel;
      if (!opts.shouldContinue()) return { kind: 'aborted' };

      const buf = getSessionOutputBuffer(sessionId);
      const len = buf.length;
      const bell = countBell(buf);

      if (len > lastLen) {
        sawActivity = true;
        grownTotal += len - lastLen;
        lastGrowthAt = Date.now();
      } else if (len < lastLen) {
        // Buffer was capped/sliced — treat as fresh activity so we don't stall.
        grownTotal += len;
        lastGrowthAt = Date.now();
      }
      lastLen = len;

      const tail = buf.slice(-tailChars);
      const rangNewBell = bell > lastBell;
      lastBell = bell;

      // With a sentinel channel open the screen heuristics are not a second
      // opinion — they are the thing being replaced, and running them in
      // parallel reintroduces exactly what they get wrong. Claude Code rings the
      // bell both when it finishes and when it wants input, so a bell racing an
      // in-flight `Notification` sentinel would report a blocked agent as
      // finished. Only the long idle backstop below stays armed.
      if (!signalled) {
        if (sawActivity && rangNewBell) {
          return containsAttentionRequest(tail)
            ? { kind: 'blocked', reason: attentionReason(tail) }
            : { kind: 'finished' };
        }

        if (sawActivity && containsAttentionRequest(tail)) {
          return { kind: 'blocked', reason: attentionReason(tail) };
        }
      }

      if (sawActivity && grownTotal >= minWorkChars && Date.now() - lastGrowthAt >= idleMs) {
        return { kind: 'finished' };
      }
    }
  }
}
