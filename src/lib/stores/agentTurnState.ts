/**
 * What each agent session is doing, by the same events the agent
 * notifications fire on: a prompt handed over starts a turn, and the turn
 * watcher's end (the moment the done / needs-input card lands) closes it.
 *
 * It exists because "the pane is printing" is not "the agent is working". A
 * freshly opened agent draws its own screen, and an adopted agent's watcher
 * re-arms the instant a turn ends, so neither the terminal's output flag nor
 * the watcher being armed can tell an idle agent from a busy one. A prompt can.
 *
 * - `idle`     launched, never prompted (or its turn ended in an abort)
 * - `working`  a prompt was typed into it or delivered by Spacron
 * - `finished` / `blocked` / `failed`  how its last turn ended
 */
import { writable } from '$lib/stores/storeCompat';

export type AgentTurnPhase = 'idle' | 'working' | 'finished' | 'blocked' | 'failed';

export interface AgentTurnState {
  phase: AgentTurnPhase;
  /** When the current phase began (epoch ms). */
  since: number;
}

export const agentTurnStates = writable<Record<number, AgentTurnState>>({});

function set(sessionId: number, phase: AgentTurnPhase): void {
  agentTurnStates.update((all) =>
    all[sessionId]?.phase === phase ? all : { ...all, [sessionId]: { phase, since: Date.now() } },
  );
}

/** A prompt reached the agent, typed or delivered: it is working now. */
export function noteAgentPrompted(sessionId: number): void {
  set(sessionId, 'working');
}

/** A fresh agent launched in this session: nothing handed to it yet. */
export function noteAgentLaunched(sessionId: number): void {
  set(sessionId, 'idle');
}

/**
 * The turn watcher reported an end. Only a working agent can finish: an
 * adopted watcher re-arms straight away and can "end" an idle agent's quiet
 * spell, which must not turn an agent nobody prompted into "Finished".
 */
export function noteAgentTurnEnded(
  sessionId: number,
  kind: 'finished' | 'blocked' | 'failed' | 'limited' | 'aborted',
): void {
  agentTurnStates.update((all) => {
    if (all[sessionId]?.phase !== 'working') return all;
    const phase: AgentTurnPhase =
      kind === 'finished' ? 'finished'
        : kind === 'blocked' ? 'blocked'
          : kind === 'aborted' ? 'idle'
            : 'failed';
    return { ...all, [sessionId]: { phase, since: Date.now() } };
  });
}

/** The session is gone. */
export function forgetAgentTurnState(sessionId: number): void {
  agentTurnStates.update((all) => {
    if (!(sessionId in all)) return all;
    const next = { ...all };
    delete next[sessionId];
    return next;
  });
}
