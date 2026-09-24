import { beforeEach, describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  agentTurnStates,
  forgetAgentTurnState,
  noteAgentLaunched,
  noteAgentLineSubmitted,
  noteAgentPrompted,
  noteAgentTurnEnded,
  turnEndWasCounted,
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

  it('remembers the task it was sent, through the end of the turn', () => {
    noteAgentPrompted(7, 'Fix the login redirect\nand add a test');
    expect(get(agentTurnStates)[7].task).toBe('Fix the login redirect');
    noteAgentTurnEnded(7, 'finished');
    expect(get(agentTurnStates)[7].task).toBe('Fix the login redirect');
    noteAgentLaunched(7);
    expect(get(agentTurnStates)[7].task).toBeUndefined();
  });

  it('counts a typed line as a task, but not a slash command or a menu key', () => {
    noteAgentLineSubmitted(8, '/model');
    expect(phase(8)).toBeUndefined();
    noteAgentLineSubmitted(8, '1');
    expect(phase(8)).toBeUndefined();
    noteAgentLineSubmitted(8, 'write a test for the parser');
    expect(phase(8)).toBe('working');
    expect(get(agentTurnStates)[8].task).toBe('write a test for the parser');
  });

  it('lets a one-key answer resume a turn that was waiting on it', () => {
    noteAgentPrompted(9, 'Delete the old migrations');
    noteAgentTurnEnded(9, 'blocked');
    noteAgentLineSubmitted(9, 'y');
    expect(phase(9)).toBe('working');
    expect(get(agentTurnStates)[9].task).toBe('Delete the old migrations');
  });

  it('counts a turn end only when it closed work the agent was given', () => {
    noteAgentLaunched(10);
    noteAgentTurnEnded(10, 'finished');
    expect(turnEndWasCounted(10)).toBe(false); // idle: nothing to report

    noteAgentPrompted(10, 'Fix the login redirect');
    noteAgentTurnEnded(10, 'finished');
    expect(turnEndWasCounted(10)).toBe(true);

    // The idle reminder after a finish, read as "needs input": not a new turn.
    noteAgentTurnEnded(10, 'blocked');
    expect(turnEndWasCounted(10)).toBe(false);
    expect(phase(10)).toBe('finished');
  });
});
