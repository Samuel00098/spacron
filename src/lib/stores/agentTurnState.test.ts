import { beforeEach, describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  agentTurnStates,
  forgetAgentTurnState,
  noteAgentLaunched,
  noteAgentPrompted,
  noteAgentTurnEnded,
} from './agentTurnState';

const phase = (id: number) => get(agentTurnStates)[id]?.phase;

describe('agent turn state', () => {
  beforeEach(() => agentTurnStates.set({}));

  it('starts a turn on a prompt and ends it the way the watcher reports', () => {
    noteAgentLaunched(1);
    expect(phase(1)).toBe('idle');
    noteAgentPrompted(1);
    expect(phase(1)).toBe('working');
    noteAgentTurnEnded(1, 'finished');
    expect(phase(1)).toBe('finished');
  });

  it('never marks an agent nobody prompted as finished', () => {
    noteAgentLaunched(2);
    noteAgentTurnEnded(2, 'finished');
    expect(phase(2)).toBe('idle');
    noteAgentTurnEnded(3, 'finished');
    expect(phase(3)).toBeUndefined();
  });

  it('maps blocked, limited and aborted turn ends', () => {
    noteAgentPrompted(4);
    noteAgentTurnEnded(4, 'blocked');
    expect(phase(4)).toBe('blocked');
    noteAgentPrompted(4);
    noteAgentTurnEnded(4, 'limited');
    expect(phase(4)).toBe('failed');
    noteAgentPrompted(4);
    noteAgentTurnEnded(4, 'aborted');
    expect(phase(4)).toBe('idle');
  });

  it('keeps the turn start time while the phase holds', () => {
    noteAgentPrompted(5);
    const since = get(agentTurnStates)[5].since;
    noteAgentPrompted(5);
    expect(get(agentTurnStates)[5].since).toBe(since);
  });

  it('forgets a closed session', () => {
    noteAgentPrompted(6);
    forgetAgentTurnState(6);
    expect(phase(6)).toBeUndefined();
  });
});
