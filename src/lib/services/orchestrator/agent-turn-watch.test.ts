import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionOutputBuffer = vi.hoisted(() => vi.fn(() => ''));
const getSessionOutputLength = vi.hoisted(() => vi.fn(() => 0));
vi.mock('$lib/stores/terminal', () => ({ getSessionOutputBuffer, getSessionOutputLength }));

import { watchLeasedAgentTurn, QUIET_TURN_IDLE_MS } from './agent-turn-watch';

describe('watchLeasedAgentTurn', () => {
  let buf = '';
  beforeEach(() => {
    vi.useFakeTimers();
    buf = '';
    getSessionOutputBuffer.mockReset();
    getSessionOutputBuffer.mockImplementation(() => buf);
    getSessionOutputLength.mockReset();
    getSessionOutputLength.mockImplementation(() => buf.length);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('finishes when the agent rings the bell after working', async () => {
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000, minWorkChars: 20 });
    buf = 'working on the change...';
    await vi.advanceTimersByTimeAsync(10); // sees activity
    buf += ' done\x07';
    await vi.advanceTimersByTimeAsync(10); // sees new bell
    await expect(p).resolves.toEqual({ kind: 'finished' });
  });

  it('does not finish on a bell before the agent has done real work', async () => {
    // Startup TUI noise: a few chars of banner + a bell must not look like a
    // completed turn. The bell path requires grownTotal >= minWorkChars.
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000, minWorkChars: 200 });
    buf = 'Welcome to Agent v1.0\x07'; // well under minWorkChars
    await vi.advanceTimersByTimeAsync(10);
    const settled = await Promise.race([p, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  it('finishes on a bell once the agent has produced enough output', async () => {
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 10_000 });
    buf = 'streamed some real work '.repeat(25); // > default minWorkChars (500)
    await vi.advanceTimersByTimeAsync(10); // sees activity
    buf += ' all done\x07';
    await vi.advanceTimersByTimeAsync(10); // sees new bell
    await expect(p).resolves.toEqual({ kind: 'finished' });
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

  it('finishes via quiescence when output stops growing', async () => {
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => true, pollMs: 10, idleMs: 50, minWorkChars: 200 });
    buf = 'streamed some real work '.repeat(20); // well past minWorkChars
    await vi.advanceTimersByTimeAsync(10); // activity, resets idle timer
    await vi.advanceTimersByTimeAsync(80); // no further growth past idleMs
    await expect(p).resolves.toEqual({ kind: 'finished' });
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
    await expect(p).resolves.toEqual({ kind: 'finished' });
  });

  it('aborts when shouldContinue turns false', async () => {
    let cont = true;
    const p = watchLeasedAgentTurn(1, { shouldContinue: () => cont, pollMs: 10, idleMs: 10_000 });
    cont = false;
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toEqual({ kind: 'aborted' });
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
});
