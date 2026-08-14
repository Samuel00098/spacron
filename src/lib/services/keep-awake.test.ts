import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() =>
  vi.fn(async (_command: string, args: any): Promise<any> => ({
    active: !!args?.active,
    mechanism: 'test-inhibitor',
    supported: true,
  })),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/utils/tauri', () => ({ isTauriRuntime: () => true }));

import { get } from '$lib/stores/storeCompat';
import { keepSystemAwake } from '$lib/stores/settings';
import {
  agentSessionClosed,
  agentTurnEnded,
  agentTurnStarted,
  keepAwakeState,
  resetKeepAwake,
  workingAgentCount,
} from './keep-awake';

/** The last `keep_awake_set` call's `active` argument, or null if never called. */
function lastRequestedHold(): boolean | null {
  const calls = invoke.mock.calls.filter(([command]) => command === 'keep_awake_set');
  const last = calls[calls.length - 1];
  return last ? !!(last[1] as any).active : null;
}

function holdCallCount(): number {
  return invoke.mock.calls.filter(([command]) => command === 'keep_awake_set').length;
}

beforeEach(async () => {
  keepSystemAwake.set(false);
  await resetKeepAwake();
  invoke.mockClear();
});

describe('keep-awake', () => {
  it('takes the hold only once the setting is on and an agent is working', async () => {
    agentTurnStarted(1);
    await resetKeepAwake();
    // Setting off: a working agent must not override the user's choice.
    expect(lastRequestedHold()).toBe(null);

    keepSystemAwake.set(true);
    agentTurnStarted(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastRequestedHold()).toBe(true);
    expect(get(keepAwakeState).holding).toBe(true);
  });

  it('releases when the last turn ends, not the first', async () => {
    keepSystemAwake.set(true);
    agentTurnStarted(1);
    agentTurnStarted(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastRequestedHold()).toBe(true);

    agentTurnEnded(1);
    await new Promise((r) => setTimeout(r, 0));
    // One agent still working — the hold must stay.
    expect(lastRequestedHold()).toBe(true);
    expect(workingAgentCount()).toBe(1);

    agentTurnEnded(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastRequestedHold()).toBe(false);
    expect(get(keepAwakeState).holding).toBe(false);
  });

  it('absorbs a re-armed watcher reporting the same session twice', async () => {
    keepSystemAwake.set(true);
    agentTurnStarted(7);
    agentTurnStarted(7);
    await new Promise((r) => setTimeout(r, 0));
    expect(workingAgentCount()).toBe(1);
    // A counter would need two ends here; the set needs one.
    agentTurnEnded(7);
    await new Promise((r) => setTimeout(r, 0));
    expect(workingAgentCount()).toBe(0);
    expect(lastRequestedHold()).toBe(false);
  });

  it('does not re-invoke for a state it is already in', async () => {
    keepSystemAwake.set(true);
    agentTurnStarted(1);
    await new Promise((r) => setTimeout(r, 0));
    const afterAcquire = holdCallCount();

    agentTurnStarted(2);
    agentTurnEnded(2);
    await new Promise((r) => setTimeout(r, 0));
    // Still held throughout, so nothing new should have been sent.
    expect(holdCallCount()).toBe(afterAcquire);
  });

  it('drops the hold immediately when the setting is turned off mid-run', async () => {
    keepSystemAwake.set(true);
    agentTurnStarted(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastRequestedHold()).toBe(true);

    keepSystemAwake.set(false);
    await new Promise((r) => setTimeout(r, 0));
    // The user asked for their machine back now, not at the end of the turn.
    expect(lastRequestedHold()).toBe(false);
    // The turn is still tracked, so turning it back on re-takes the hold.
    expect(workingAgentCount()).toBe(1);
  });

  it('releases a hold left behind by a session that died mid-turn', async () => {
    keepSystemAwake.set(true);
    agentTurnStarted(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastRequestedHold()).toBe(true);

    agentSessionClosed(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastRequestedHold()).toBe(false);
    expect(workingAgentCount()).toBe(0);
  });

  it('surfaces a failure instead of claiming a hold it does not have', async () => {
    keepSystemAwake.set(true);
    await new Promise((r) => setTimeout(r, 0));

    invoke.mockRejectedValueOnce(new Error('no inhibitor here'));
    agentTurnStarted(1);
    await new Promise((r) => setTimeout(r, 0));

    const state = get(keepAwakeState);
    expect(state.holding).toBe(false);
    expect(state.error).toContain('no inhibitor here');

    // The failure must not latch: the next turn boundary retries, because the
    // applied state was left untouched by the error.
    agentTurnStarted(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(get(keepAwakeState).holding).toBe(true);
    expect(get(keepAwakeState).error).toBe(null);
  });
});
