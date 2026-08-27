import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionOutputBuffer = vi.hoisted(() => vi.fn(() => ''));
const getSessionOutputLength = vi.hoisted(() => vi.fn(() => 0));
const getSessionOutputTail = vi.hoisted(() => vi.fn((_id: number, _chars: number) => ''));
const getSessionOutputProduced = vi.hoisted(() => vi.fn(() => 0));
vi.mock('$lib/stores/terminal', () => ({
  getSessionOutputBuffer,
  getSessionOutputLength,
  getSessionOutputTail,
  getSessionOutputProduced,
}));

import { describeTurnEnd, watchLeasedAgentTurn, QUIET_TURN_IDLE_MS } from './agent-turn-watch';
import { __registerChannelForTest, __resetTurnSignalsForTest } from './agent-hook-signals';

beforeEach(() => {
  __resetTurnSignalsForTest();
});
afterEach(() => {
  __resetTurnSignalsForTest();
});

describe('watchLeasedAgentTurn', () => {
  let buf = '';
  // The real store's produced-chars counter is MONOTONIC: it counts everything
  // the session ever emitted and does not fall when the retained window slides.
  // Modelling that is what makes the "buffer slid" test meaningful — a slide is
  // zero growth, not negative growth.
  let produced = 0;
  let lastBufLen = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    buf = '';
    produced = 0;
    lastBufLen = 0;
    getSessionOutputBuffer.mockReset();
    getSessionOutputBuffer.mockImplementation(() => buf);
    getSessionOutputLength.mockReset();
    getSessionOutputLength.mockImplementation(() => buf.length);
    getSessionOutputTail.mockReset();
    getSessionOutputTail.mockImplementation((_id: number, chars: number) =>
      chars <= 0 ? '' : buf.slice(-chars),
    );
    getSessionOutputProduced.mockReset();
    getSessionOutputProduced.mockImplementation(() => {
      if (buf.length > lastBufLen) produced += buf.length - lastBufLen;
      lastBufLen = buf.length;
      return produced;
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not finish on a lone bell — it must be corroborated by quiescence', async () => {
    // Regression: a terminal bell used to finish the turn instantly. A mid-turn
    // ring (progress TUI, "press enter", a stray OSC terminator) then
    // false-completed the turn and severed the lease before the agent's real
    // answer arrived. Now a bell only ends the turn after the output stays quiet
    // for the grace period; a lone bell with more work to come is ignored.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000, minWorkChars: 20 });
    buf = 'working on the change...';
    await vi.advanceTimersByTimeAsync(10); // sees activity
    buf += ' intermediate chime\x07';
    await vi.advanceTimersByTimeAsync(10); // sees new bell, but more output is coming
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('does not finish on a bell before the agent has done real work', async () => {
    // Startup TUI noise: a few chars of banner + a bell must not look like a
    // completed turn. The bell path requires grownTotal >= minWorkChars, and a
    // bell alone (without quiescence) never ends the turn anyway.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000, minWorkChars: 200 });
    buf = 'Welcome to Agent v1.0\x07'; // well under minWorkChars
    await vi.advanceTimersByTimeAsync(10);
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('finishes when a bell is followed by quiescence after real work', async () => {
    // A genuine turn-end bell is followed by silence (or a stable REPL prompt).
    // After the bell-grace quiet window, the turn resolves as finished.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000, minWorkChars: 200 });
    buf = 'streamed some real work '.repeat(25); // > default minWorkChars (500)
    await vi.advanceTimersByTimeAsync(10); // sees activity
    buf += ' all done\x07';
    await vi.advanceTimersByTimeAsync(10); // sees new bell
    // Quiescence after the bell — long past the grace window — corroborates end.
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ kind: 'finished', via: 'inferred' });
  });

  it('does not finish on a bell that only appeared because the buffer slid', async () => {
    // The session buffer is capped and drops output from the front. Re-counting
    // bells from that moving cut point used to invent one whenever the cut
    // landed inside an OSC sequence, promoting its terminator to a real ring.
    const head = 'boot\x1b]0;agent title\x07'; // OSC terminator at index 20
    buf = head + 'streamed some real work '.repeat(40);
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000 });
    buf += 'more work '.repeat(60);
    await vi.advanceTimersByTimeAsync(10); // plenty of growth, no bell
    // The cap slices the head off mid-OSC, so the buffer now *starts* with the
    // sequence's tail and its terminator reads as a standalone BEL.
    buf = buf.slice(10);
    expect(buf.indexOf('\x07')).toBeGreaterThanOrEqual(0);
    expect(buf.slice(0, buf.indexOf('\x07'))).not.toContain('\x1b');
    await vi.advanceTimersByTimeAsync(30);
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('keeps a turn alive once the output window has filled and stopped growing', async () => {
    // Regression: growth used to be measured against the length of the RETAINED
    // window, which is capped. A verbose agent hits that cap after a couple of
    // minutes, its length stops rising, and the watcher then saw a permanently
    // idle session — refreshing `lastGrowthAt` never again — so it reported
    // `finished` `idleMs` later while the agent was still streaming, releasing
    // the lease and throwing away the answer. Growth is now read from the
    // monotonic produced-chars counter, which a full window does not affect.
    const CAP = 400;
    const emitCapped = (text: string) => {
      produced += text.length;
      buf = (buf + text).slice(-CAP);
      lastBufLen = buf.length;
    };
    const p = watchLeasedAgentTurn(1, {
      shouldContinue: () => true,
      pollMs: 10,
      idleMs: 100,
      minWorkChars: 50,
    });
    // Real work first, while the window is still filling — so the turn has
    // activity and is past its work floor, and the idle fallback is live.
    emitCapped('a'.repeat(200));
    await vi.advanceTimersByTimeAsync(10);
    emitCapped('b'.repeat(300)); // window is full from here on
    await vi.advanceTimersByTimeAsync(10);
    expect(buf.length).toBe(CAP);
    // Keep streaming for many times `idleMs`. Every chunk leaves `buf.length`
    // pinned at CAP, so a length-based watcher sees a session that went silent.
    for (let i = 0; i < 40; i += 1) {
      emitCapped(`still working ${i} `);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(buf.length).toBe(CAP);
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('blocks when the agent prints an attention prompt', async () => {
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000 });
    buf = 'I need to delete the table. Do you want to continue? [y/n]';
    await vi.advanceTimersByTimeAsync(10);
    const outcome = await p;
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason.toLowerCase()).toContain('do you want to');
  });

  it('ignores an attention prompt that was already on screen when it armed', async () => {
    // Agents habitually close a turn with a question ("Would you like me to…"),
    // and it stays in the buffer afterwards. The next watch must not re-report
    // that as a fresh block — on the re-arming adopted-agent watcher this fired
    // a chime every poll interval for a prompt nobody was being shown.
    buf = 'All set. Would you like me to run the tests?';
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000 });
    buf += ' '; // a cursor redraw: activity, but no new prompt
    await vi.advanceTimersByTimeAsync(50);
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('blocks on an attention prompt printed during this turn', async () => {
    // The other half of the rule above: a prompt the agent prints *after* the
    // watch armed still blocks immediately.
    buf = 'previous turn output';
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000 });
    buf += ' Deleting the table. Do you want to continue? [y/n]';
    await vi.advanceTimersByTimeAsync(10);
    const outcome = await p;
    expect(outcome.kind).toBe('blocked');
  });

  it('finishes via quiescence when output stops growing', async () => {
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    buf = 'streamed some real work '.repeat(20); // well past minWorkChars
    await vi.advanceTimersByTimeAsync(10); // activity, resets idle timer
    await vi.advanceTimersByTimeAsync(80); // no further growth past idleMs
    await expect(p).resolves.toEqual({ kind: 'finished', via: 'inferred' });
  });

  it('does not idle-finish a tiny burst at the normal idle window', async () => {
    // The prompt echo / a cursor-blink redraw nudges the buffer a few chars but
    // the agent never actually started — the NORMAL idle window must not
    // complete the turn (only the much longer QUIET_TURN_IDLE_MS may).
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    buf = '> hi'; // below minWorkChars (default 200)
    await vi.advanceTimersByTimeAsync(10); // tiny "activity"
    await vi.advanceTimersByTimeAsync(120); // long past idleMs, but under the work floor
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('resolves a quiet turn below minWorkChars after the longer quiet window', async () => {
    // A terse agent answers in a few lines and goes silent — under the work
    // floor, so the normal idle window must not complete it, but the longer
    // quiet window must, or the task hangs in-progress forever with no card.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    buf = 'Done.'; // below minWorkChars
    await vi.advanceTimersByTimeAsync(10); // activity
    await vi.advanceTimersByTimeAsync(120); // long past the normal idleMs
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');

    await vi.advanceTimersByTimeAsync(QUIET_TURN_IDLE_MS);
    await expect(p).resolves.toEqual({ kind: 'finished', via: 'inferred' });
  });

  it('aborts when shouldContinue turns false', async () => {
    let cont = true;
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => cont, pollMs: 10, idleMs: 10_000 });
    cont = false;
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toEqual({ kind: 'aborted' });
  });

  it('blocks on a per-CLI prompt when the agent command is supplied', async () => {
    // A CLI phrasing its "needs input" gate outside the generic English list
    // (e.g. Codex's "Send?" approval) used to be misreported "finished". With
    // the agent command threaded through, the per-CLI phrase set catches it.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000, agentCommand: 'codex' });
    buf = 'I can make that change. Send? (y/N)';
    await vi.advanceTimersByTimeAsync(10);
    const outcome = await p;
    expect(outcome.kind).toBe('blocked');
  });

  it('does NOT catch a per-CLI-only prompt when no agent command is known', async () => {
    // Without the command, the watcher only has the universal pattern. A
    // CLI-specific cue that is NOT in the universal set (Codex's bare "Send?"
    // with no y/n bracket) must not block — the turn resolves via quiescence
    // as finished. This pins the behaviour the per-CLI table is meant to
    // improve: absent the table, that prompt would be missed.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    buf = 'working '.repeat(200) + 'Send?';
    await vi.advanceTimersByTimeAsync(10); // activity
    await vi.advanceTimersByTimeAsync(80); // idle freeze; no per-CLI phrase registered
    const outcome = await p;
    // No CLI-specific match → resolves via quiescence as finished, not blocked.
    expect(outcome.kind).toBe('finished');
  });

  it('still blocks a signalled session parked at an attention prompt when the hook never fires', async () => {
    // Regression: when a sentinel channel is open, the old code disabled every
    // screen heuristic. If Claude Code is parked at a prompt whose
    // `Notification` hook never emits (or failed to install), the only remaining
    // path was the 15-minute idle backstop — which reported "finished" and
    // severed the agent from its still-waiting terminal. The attention-prompt
    // check must run even when signalled, so a blocked agent is never mislabeled.
    __registerChannelForTest(1, 'deadbeef'); // session 1 now has a hook channel, but no signal ever arrives
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000 });
    buf = 'Deleting the table. Do you want to continue? [y/n]';
    await vi.advanceTimersByTimeAsync(10); // never receives a sentinel
    const outcome = await p;
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason.toLowerCase()).toContain('do you want to');
  });

  it('a signalled finished hook still overrides a coincidental prompt in the tail', async () => {
    // The prompt check must not override a genuine hook signal. A `Notification`
    // sentinel is returned earlier in the loop (before any buffer scan), so a
    // real "needs input" hook wins over an old prompt still sitting in the tail.
    const channelId = 'deadbeef';
    __registerChannelForTest(1, channelId);
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000 });
    // Seed a stale prompt in the buffer before the hook fires.
    buf = 'All set? Do you want to continue? [y/n]';
    // No advanceTimers here: deliver the hook sentinel via the channel listener.
    // Simulate the backend emitting the blocked signal.
    const { __deliverLineForTest } = await import('./agent-hook-signals');
    __deliverLineForTest(channelId, `SPACRON-NEEDS-INPUT:${channelId}`);
    const outcome = await p;
    expect(outcome.kind).toBe('blocked');
  });

  it('does not finish while output keeps growing (still working)', async () => {
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 40, minWorkChars: 200 });
    for (let i = 0; i < 6; i += 1) {
      buf += ` chunk ${i}`; // continuous growth — never idle, no bell
      await vi.advanceTimersByTimeAsync(10);
    }
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('catches a parked attention prompt that scrolled past the 2KB tail on a non-hook agent', async () => {
    // Non-hook agents (Codex, Gemini, …) have no sentinel and no bell. The
    // per-poll loop only scans the last 2 KB (`recent`), so a prompt pushed
    // beyond that by a verbose turn would be missed and misreported "finished".
    // At the idle freeze the wider 8 KB rescan must catch it.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    // > 2 KB of filler so the prompt sits outside the per-poll tail window.
    buf = 'working '.repeat(700);
    buf += 'Deleting the table. Do you want to continue? [y/n]';
    await vi.advanceTimersByTimeAsync(10); // sees activity
    await vi.advanceTimersByTimeAsync(80); // idle freeze at idleMs=50
    const outcome = await p;
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason.toLowerCase()).toContain('do you want to');
  });

  it('a signalled agent does not idle-rescan and finishes when no prompt is present', async () => {
    // Hook agents report needs-input via the sentinel; the idle rescan stays
    // off for them. With no attention prompt anywhere in the buffer, the idle
    // backstop resolves the turn as finished (no hook signal here → not blocked,
    // and nothing for the skipped rescan to find).
    __registerChannelForTest(1, 'deadbeef');
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    buf = 'working '.repeat(700) + 'all tasks complete';
    await vi.advanceTimersByTimeAsync(10); // activity
    await vi.advanceTimersByTimeAsync(80); // idle freeze; rescan is skipped because signalled
    const outcome = await p;
    expect(outcome.kind).toBe('finished');
  });

  it('a non-hook agent that rings a bell then keeps working is not false-completed', async () => {
    // End-to-end: Codex-style mid-turn bell. The watcher must ignore the ring
    // (more output follows within the grace window) and stay alive; only once
    // the work actually stops does quiescence finish it.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    buf = 'streamed some real work '.repeat(25); // > minWorkChars
    await vi.advanceTimersByTimeAsync(10); // activity
    buf += ' progress\x07'; // a mid-turn chime
    await vi.advanceTimersByTimeAsync(10); // bell seen; lastBellAt set
    buf += ' and then the real continuation'; // more output AFTER the bell
    await vi.advanceTimersByTimeAsync(10); // growth resets lastGrowthAt past the bell
    // The bell is now older than the latest growth, so the bell-quiet path is
    // blocked, and we are still inside the 50 ms idle window — the turn must be
    // alive. This is the exact mid-turn-bell case the old code false-completed.
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
    // Now let it go quiet; quiescence finishes it (not the earlier bell).
    await vi.advanceTimersByTimeAsync(80);
    await expect(p).resolves.toEqual({ kind: 'finished', via: 'inferred' });
  });
});

describe('describeTurnEnd', () => {
  it('keeps the three states distinct', () => {
    expect(describeTurnEnd({ kind: 'finished', via: 'declared' })).toEqual({
      status: 'done',
      reason: null,
      declared: true,
      endedBy: 'declared',
    });
    expect(describeTurnEnd({ kind: 'blocked', reason: 'which db?', via: 'declared' })).toEqual({
      status: 'blocked',
      reason: 'which db?',
      declared: true,
      endedBy: 'declared',
    });
    // The regression this exists for: a failure must not arrive as "needs
    // input", which sends the user looking for a question nobody asked.
    expect(describeTurnEnd({ kind: 'failed', reason: 'build broke', via: 'declared' })).toEqual({
      status: 'failed',
      reason: 'build broke',
      declared: true,
      endedBy: 'declared',
    });
  });

  it('marks a guessed finish as not declared', () => {
    expect(describeTurnEnd({ kind: 'finished', via: 'inferred' })?.declared).toBe(false);
    // The two provenance fields are set together and must never disagree.
    expect(describeTurnEnd({ kind: 'finished', via: 'inferred' })?.endedBy).toBe('inferred');
  });

  it('has nothing to say about an aborted watch', () => {
    // The watch was torn down (task unlinked, session killed) — no event
    // happened that the user should be told about.
    expect(describeTurnEnd({ kind: 'aborted' })).toBeNull();
  });
});

describe('what is allowed to interrupt', () => {
  // The rule the notification path enforces: only a turn end the agent itself
  // declared may raise a card, a chime or an OS notification. Everything else
  // is inbox-only. `silent` is computed from exactly this pair in both
  // `completeLeasedTask` and `notifyAdoptedTurnEnd`.
  const silent = (o: Parameters<typeof describeTurnEnd>[0]) => {
    const told = describeTurnEnd(o);
    return told ? told.status === 'done' && !told.declared : null;
  };

  it('stays quiet for a finish nobody declared', () => {
    // "Output stopped growing for 90 seconds" is equally a long compile, a slow
    // tool call, or an agent parked at an untouched prompt.
    expect(silent({ kind: 'finished', via: 'inferred' })).toBe(true);
  });

  it('speaks up when the agent said it finished', () => {
    expect(silent({ kind: 'finished', via: 'declared' })).toBe(false);
  });

  it('always speaks up for needs-input and failures', () => {
    // A missed "needs input" strands the user waiting on an agent that is
    // waiting on them, so these interrupt even when inferred from the screen.
    expect(silent({ kind: 'blocked', reason: 'which db?', via: 'inferred' })).toBe(false);
    expect(silent({ kind: 'failed', reason: 'exit 1', via: 'inferred' })).toBe(false);
  });
});
