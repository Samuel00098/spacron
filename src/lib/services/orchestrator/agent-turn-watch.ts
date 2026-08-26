import { getSessionOutputBuffer, getSessionOutputLength } from '$lib/stores/terminal';
import {
  attentionReason,
  containsAttentionRequest,
  countBellStream,
  createBellScanState,
} from './agent-signals';
import { agentAttentionPhrases } from './agent-rules-file';
import { hasTurnSignalChannel, onTurnSignal } from './agent-hook-signals';
import { markTurnStart, recordTurnEnd } from '$lib/stores/activityStats';
import { agentTurnEnded, agentTurnStarted } from '$lib/services/keep-awake';

/**
 * How we came to believe a turn ended. Three genuinely different kinds of
 * evidence, and the card is only allowed to claim what each one supports.
 *
 * - `declared` — the agent said so, through a channel it cannot fake: a hook
 *   sentinel carrying this launch's nonce, or a `report_status` MCP call
 *   attributed by its per-launch token. Only this licenses the word
 *   **finished**.
 * - `exit` — the agent's process ended. A fact we observed, but not evidence
 *   the work is done: `/exit`, Ctrl-D and a completed session all exit 0. The
 *   card says **exited**, and still interrupts, because a process ending is
 *   something the user should know about.
 * - `inferred` — we worked it out from the screen: an attention phrase, a bell
 *   followed by quiet, or output that simply stopped growing. A guess, so the
 *   card says **went quiet** and does not interrupt at all.
 *
 * This is not bookkeeping. Announcing a guess (or a bare exit) as "finished" is
 * exactly how a user ends up being told an agent completed work it never did.
 */
export type TurnEndSource = 'declared' | 'exit' | 'inferred';

/** Outcome of watching one agent turn on a leased terminal. */
export type AgentTurnOutcome =
  | { kind: 'finished'; via: TurnEndSource; detail?: string }
  | { kind: 'blocked'; reason: string; via: TurnEndSource }
  | { kind: 'failed'; reason: string; via: TurnEndSource }
  | { kind: 'aborted' };

/** How one turn end should be presented to the user. */
export interface TurnEndPresentation {
  /** The three states a card, a chime and an OS notification distinguish. */
  status: 'done' | 'blocked' | 'failed';
  /** The agent's own words, when it gave any. */
  reason: string | null;
  /**
   * Whether the agent said this itself. `false` means we inferred it from the
   * screen, and the copy must not claim more than that.
   */
  declared: boolean;
  /** The value a completion card should carry as `endedBy`. */
  endedBy: TurnEndSource;
}

/**
 * Map a turn outcome to what the user should be told.
 *
 * One function so the leased and adopted paths cannot drift apart: they used to
 * carry their own `outcome.kind === 'blocked' ? … : …` ternaries, which is how
 * a crash ended up announced as "needs your input" on one path and as
 * "finished" on the other. Returns null for `aborted` — a torn-down watch is
 * not an event the user did anything to cause, and has nothing to report.
 */
/** The two provenance fields, always set together and never contradicting. */
function src(via: TurnEndSource): Pick<TurnEndPresentation, 'declared' | 'endedBy'> {
  return { declared: via === 'declared', endedBy: via };
}

export function describeTurnEnd(outcome: AgentTurnOutcome): TurnEndPresentation | null {
  switch (outcome.kind) {
    case 'aborted':
      return null;
    case 'blocked':
      return { status: 'blocked', ...src(outcome.via), reason: outcome.reason };
    case 'failed':
      return { status: 'failed', ...src(outcome.via), reason: outcome.reason };
    case 'finished':
      // An agent that said what it did gets that sentence carried through to
      // the card and the inbox row. Dropping it (which this used to do) is why
      // a finished turn showed up as a name and a title with no message.
      return {
        status: 'done',
        ...src(outcome.via),
        reason: outcome.detail?.trim() || null,
      };
  }
}

export interface WatchLeasedAgentOptions {
  /** Return false to stop watching (task unlinked, session died, etc.). */
  shouldContinue: () => boolean;
  /**
   * The agent's launch command (e.g. "codex", "npx opencode"). Used to resolve
   * per-CLI attention phrases so each CLI's distinctive "needs input" prompts
   * are recognised instead of being misreported as "finished". Optional — when
   * absent the universal pattern is used.
   */
  agentCommand?: string;
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
 * When the output first goes quiet, non-hook agents (Codex, Gemini, …) may have
 * parked at an attention prompt that already scrolled out of the 2 KB `recent`
 * tail the per-poll loop scans. The idle freeze is the right moment to re-scan a
 * wider slice: the buffer is now stable, so a prompt caught here is unambiguous
 * and cannot be a transient redraw. It deliberately stays *off* while a sentinel
 * channel is open — hook agents report needs-input via the hook, and a wider
 * rescan would only add latency with no accuracy gain there. 8 KB covers a
 * parked prompt plus its surrounding context on even very verbose turns.
 */
const IDLE_ATTENTION_SCAN_CHARS = 8 * 1024;

/**
 * A terminal bell alone no longer ends a turn. BEL is ambiguous — it can mean
 * "turn finished", "I want input", or just be TUI noise (a progress bar, a
 * window-title OSC terminator) — and a mid-turn ring used to false-complete the
 * turn instantly, severing the lease before the agent's real answer arrived.
 * A bell now only corroborates an end: after a ring, the output must stay quiet
 * for this grace period before we call it done. A genuine turn-end bell is
 * followed by silence (or a stable REPL prompt); a mid-turn bell is followed by
 * more output, so it never reaches this quiet state and is correctly ignored.
 * The 90s idle fallback still finishes bell-less ends. Only non-hook agents use
 * this path — hook agents keep their sentinel channel and skip bells entirely.
 */
const BELL_FINISH_GRACE_MS = 2500;

/**
 * Watch a leased agent terminal and resolve once the current turn ends.
 *
 * CLI agents don't exit when they finish a task — they sit in a REPL — and many
 * redraw their TUI constantly, so plain output-quiescence is unreliable. In
 * preference order:
 *   0. a hook sentinel from the agent itself (see `agent-hook-signals.ts`) —
 *      exact, immediate, and the only signal here that isn't a guess;
 *   1. a terminal bell (`\x07`) that is followed by quiescence corroborates a
 *      finished end (see `BELL_FINISH_GRACE_MS`); an attention prompt in the tail → blocked;
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
  // Keep-awake shares this funnel for the same reason, but counts an `aborted`
  // turn as ended: a torn-down watch has nothing left to keep the machine awake
  // for. The release is in a `finally` so a throw here cannot strand the hold.
  agentTurnStarted(sessionId);
  try {
    const outcome = await watchTurnUntilDone(sessionId, opts);
    if (outcome.kind !== 'aborted') recordTurnEnd(sessionId, outcome.kind);
    return outcome;
  } finally {
    agentTurnEnded(sessionId);
  }
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
  // Per-CLI attention phrases (resolved once; empty for unknown CLIs, which
  // then rely on the universal pattern). Layered onto the generic matcher so
  // each agent's distinctive "needs input" prompts are recognised.
  const attentionPhrases = agentAttentionPhrases(opts.agentCommand);

  let lastLen = getSessionOutputLength(sessionId);
  let lastGrowthAt = Date.now();
  let sawActivity = false;
  let grownTotal = 0;
  /** When the most recent terminal bell in this turn's output was seen, or null. */
  let lastBellAt: number | null = null;

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

  // Everything arriving on this channel came from the agent itself — a hook
  // sentinel carrying this launch's nonce, or a `report_status` call the MCP
  // server attributed by token — so it is stamped `declared` here rather than
  // at each source. The screen-derived paths below stamp `inferred`.
  const unsubscribe = onTurnSignal(sessionId, (signal) => {
    sentinel = { ...signal, via: 'declared' };
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

      if (len > lastLen) {
        const added = buf.slice(lastLen);
        sawActivity = true;
        grownTotal += added.length;
        lastGrowthAt = Date.now();
        const newBells = countBellStream(added, bellState);
        if (newBells > 0) lastBellAt = Date.now();
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

      // An unambiguous attention PROMPT in this turn's tail is independent
      // evidence of "needs input" that must be honoured for every agent,
      // signalled or not. It runs before any finish path, so a parked prompt is
      // never mislabeled "finished".
      //
      // The hook is still the authority for signalled agents: a hook sentinel is
      // returned earlier in the loop (see `if (sentinel) return sentinel`),
      // before any buffer scan, so a genuine finished/blocked hook always wins.
      // And because this check fires on the per-poll `recent` tail, a prompt
      // that scrolls past it is still caught by the wider idle rescan below.
      if (sawActivity && containsAttentionRequest(recent, attentionPhrases)) {
        return { kind: 'blocked', reason: attentionReason(recent, attentionPhrases), via: 'inferred' };
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
        return finishQuietTurn();
      }

      // Bell-corroborated fast finish, non-hook agents only. A bell is never
      // enough on its own — that was the false-finish bug: a mid-turn ring
      // (progress TUI, "press enter", a stray OSC terminator) ended the turn
      // instantly and severed the lease before the agent's real answer landed.
      // Now a bell only counts once the output has been quiet for
      // `BELL_FINISH_GRACE_MS` since the ring; a genuine turn-end bell is
      // followed by silence, whereas a mid-turn bell is followed by more output
      // and never reaches this quiet state. Hook agents keep their sentinel
      // path and skip this entirely (the `!signalled` guard below).
      const bellQuiet =
        !signalled &&
        lastBellAt !== null &&
        Date.now() - lastBellAt >= BELL_FINISH_GRACE_MS &&
        Date.now() - lastGrowthAt >= BELL_FINISH_GRACE_MS;
      if (sawActivity && bellQuiet) {
        return finishQuietTurn();
      }

      // Shared tail of both quiet paths: a parked attention prompt that scrolled
      // past the per-poll 2 KB `recent` tail must still flip the turn to
      // "blocked", and hook agents skip the rescan (they report via sentinel).
      function finishQuietTurn(): AgentTurnOutcome {
        if (!signalled) {
          const tail = getSessionOutputBuffer(sessionId).slice(-IDLE_ATTENTION_SCAN_CHARS);
          if (containsAttentionRequest(tail, attentionPhrases)) {
            return { kind: 'blocked', reason: attentionReason(tail, attentionPhrases), via: 'inferred' };
          }
        }
        return { kind: 'finished', via: 'inferred' };
      }
    }
  }
}
