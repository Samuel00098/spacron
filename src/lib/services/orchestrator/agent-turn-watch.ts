import { getSessionOutputBuffer } from '$lib/stores/terminal';
import {
  attentionReason,
  containsAttentionRequest,
  countBellStream,
  createBellScanState,
} from './agent-signals';
import { hasTurnSignalChannel, onTurnSignal } from './agent-hook-signals';
import { markTurnStart, recordTurnEnd } from '$lib/stores/activityStats';

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
  /**
   * Bytes of *this turn's* output to keep for attention-prompt scanning. Only
   * output produced after the watch armed is ever scanned — see `recent` below.
   */
  tailChars?: number;
  /**
   * Minimum total new output (chars) before the idle fallback may finish a turn
   * at the normal `idleMs` window. Guards against an agent that never actually
   * started: the prompt's own echo or a lone cursor-blink redraw would otherwise
   * look like a tiny burst of "activity" that then goes idle and false-completes
   * a turn nothing ran. A sub-floor turn is still resolved by the idle fallback
   * after the much longer [`QUIET_TURN_IDLE_MS`] window.
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
 * How long a sub-`minWorkChars` turn must sit quiet before the idle fallback
 * may call it done. The work floor exists to stop a prompt echo or a
 * cursor-blink redraw from false-completing a turn nothing ran — but a terse
 * agent that answers in a few lines and goes quiet must not hang its task
 * `in-progress` forever either. Ten minutes of silence is longer than any real
 * turn keeps working without producing output, so a quiet-but-real turn
 * resolves and an echo-only ghost eventually does too (which is still better
 * than an eternal in-progress with no card). A turn that produced *nothing at
 * all (`sawActivity` never set — not even a prompt echo) is deliberately left
 * unresolved: with zero output there is no signal to classify, and an
 * in-progress task the user can see is safer than a guaranteed-wrong card.
 */
export const QUIET_TURN_IDLE_MS = 10 * 60 * 1000;

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
 *   3. as a fallback, output that stops growing for `idleMs` → finished; a turn
 *      under `minWorkChars` (a terse agent) needs the longer
 *      `QUIET_TURN_IDLE_MS` window instead of hanging in-progress forever.
 *
 * 1–3 remain for CLIs that cannot emit hooks, which is most of them.
 */
export async function watchLeasedAgentTurn(
  sessionId: number,
  opts: WatchLeasedAgentOptions
): Promise<AgentTurnOutcome> {
  // Activity stats. This wrapper is the only place a turn's start and end are
  // both known, and it covers every armed watcher — leased, adopted and
  // adapter-driven — because they all funnel through this one call.
  //
  // An `aborted` turn is deliberately not recorded: the watch was torn down
  // (task unlinked, session killed), so the elapsed time is how long the watch
  // lived, not how long the agent worked.
  markTurnStart(sessionId);
  const outcome = await watchTurnUntilDone(sessionId, opts);
  if (outcome.kind !== 'aborted') recordTurnEnd(sessionId, outcome.kind);
  return outcome;
}

async function watchTurnUntilDone(
  sessionId: number,
  opts: WatchLeasedAgentOptions
): Promise<AgentTurnOutcome> {
  const pollMs = opts.pollMs ?? 400;
  // Quiet-agent fallback only. Coding agents routinely go silent for many
  // seconds while thinking, running a tool, or compiling, so a short window
  // false-completes turns mid-work — and because the lease is then released and
  // the task severed from its session, the agent's real answer (printed a beat
  // later) is never read back. Discrete bell/attention signals still finish a
  // turn immediately; this only governs agents that never signal. A turn that
  // produced less than minWorkChars needs the longer quiet window below before
  // it counts as done.
  const signalled = hasTurnSignalChannel(sessionId);
  const idleMs = opts.idleMs ?? (signalled ? SIGNALLED_IDLE_MS : 90000);
  const tailChars = opts.tailChars ?? 2000;
  const minWorkChars = opts.minWorkChars ?? 500;

  let lastLen = getSessionOutputBuffer(sessionId).length;
  let lastGrowthAt = Date.now();
  let sawActivity = false;
  let grownTotal = 0;

  // Escape state for the incremental bell scanner, threaded across polls.
  const bellState = createBellScanState();
  /**
   * The tail of the output produced *since this watch armed* — never the tail of
   * the whole session buffer.
   *
   * That distinction is the whole point. Agents habitually close a turn with a
   * question ("Would you like me to also run the tests?"), and that text sits in
   * the buffer tail long after the turn it belongs to ended. Scanning the shared
   * buffer meant the next watch matched it again on the very first byte of new
   * output — reporting `blocked` for a prompt the agent was not showing, over
   * and over on the re-arming adopted-agent watcher.
   */
  let recent = '';

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
      let rangNewBell = false;

      if (len > lastLen) {
        const added = buf.slice(lastLen);
        sawActivity = true;
        grownTotal += added.length;
        lastGrowthAt = Date.now();
        rangNewBell = countBellStream(added, bellState) > 0;
        recent = (recent + added).slice(-tailChars);
      } else if (len < lastLen) {
        // Buffer was capped/sliced — treat as fresh activity so we don't stall.
        // There is no trustworthy delta to scan for bells here (the window slid
        // by an unknown amount), and guessing one manufactures rings, so this
        // poll counts none and the escape scanner restarts from a clean state.
        grownTotal += len;
        lastGrowthAt = Date.now();
        bellState.inOsc = false;
        bellState.escPending = false;
        recent = buf.slice(-tailChars);
      }
      lastLen = len;

      // With a sentinel channel open the screen heuristics are not a second
      // opinion — they are the thing being replaced, and running them in
      // parallel reintroduces exactly what they get wrong. Claude Code rings the
      // bell both when it finishes and when it wants input, so a bell racing an
      // in-flight `Notification` sentinel would report a blocked agent as
      // finished. Only the long idle backstop below stays armed.
      if (!signalled) {
        if (sawActivity && grownTotal >= minWorkChars && rangNewBell) {
          return containsAttentionRequest(recent)
            ? { kind: 'blocked', reason: attentionReason(recent) }
            : { kind: 'finished' };
        }

        if (sawActivity && containsAttentionRequest(recent)) {
          return { kind: 'blocked', reason: attentionReason(recent) };
        }
      }

      // The idle fallback normally requires the work floor — a tiny burst that
      // never became real work must not false-complete a turn. But a genuine
      // quiet turn (a terse agent that answers and stops) needs a much longer
      // quiet window so it still resolves instead of hanging the task
      // in-progress forever with no card. The quiet window never beats the
      // normal backstop (a signalled session's 15 min), so the less-certain
      // sub-floor turn is always the more conservative one.
      const idleWindow = grownTotal >= minWorkChars ? idleMs : Math.max(QUIET_TURN_IDLE_MS, idleMs);
      if (sawActivity && Date.now() - lastGrowthAt >= idleWindow) {
        return { kind: 'finished' };
      }
    }
  }
}
