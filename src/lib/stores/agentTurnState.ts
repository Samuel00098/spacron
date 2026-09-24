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
 * - `working`  a prompt was typed into it or sent by Spacron
 * - `finished` / `blocked` / `failed`  how its last turn ended
 *
 * `task` is the text of the last prompt it was given, which is what the Agent
 * Fleet shows under the agent's name.
 */
import { writable } from '$lib/stores/storeCompat';

export type AgentTurnPhase = 'idle' | 'working' | 'finished' | 'blocked' | 'failed';

export interface AgentTurnState {
  phase: AgentTurnPhase;
  /** When the current phase began (epoch ms). */
  since: number;
  /** The last prompt handed to the agent, one line. */
  task?: string;
}

export const agentTurnStates = writable<Record<number, AgentTurnState>>({});

/** One readable line from a prompt: first non-empty line, capped. */
function taskLine(text: string | null | undefined): string | undefined {
  const line = (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * A prompt reached the agent: it is working now. With no text (an answer to
 * the agent's own question) the turn resumes on the task it already had.
 */
export function noteAgentPrompted(sessionId: number, text?: string | null): void {
  agentTurnStates.update((all) => {
    const prev = all[sessionId];
    const task = taskLine(text) ?? prev?.task;
    if (prev?.phase === 'working' && prev.task === task) return all;
    return {
      ...all,
      [sessionId]: { phase: 'working', since: prev?.phase === 'working' ? prev.since : Date.now(), task },
    };
  });
}

/**
 * A line the user typed into an agent and submitted. Most are prompts; a
 * slash command is a command to the CLI, not a task, and a one- or two-key
 * line ("1", "y") is a menu or permission answer — it resumes a turn that was
 * waiting on it, but never starts one.
 */
export function noteAgentLineSubmitted(sessionId: number, line: string): void {
  const text = line.trim();
  if (!text || text.startsWith('/')) return;
  if (text.length <= 2) {
    let waiting = false;
    agentTurnStates.subscribe((all) => { waiting = all[sessionId]?.phase === 'blocked'; })();
    if (waiting) noteAgentPrompted(sessionId);
    return;
  }
  noteAgentPrompted(sessionId, text);
}

/** A fresh agent launched in this session: nothing handed to it yet. */
export function noteAgentLaunched(sessionId: number): void {
  agentTurnStates.update((all) =>
    all[sessionId]?.phase === 'idle' && !all[sessionId]?.task
      ? all
      : { ...all, [sessionId]: { phase: 'idle', since: Date.now() } },
  );
}

/** Whether each session's most recent watcher end closed a working turn. */
const lastEndCounted = new Map<number, boolean>();

/**
 * Whether the watcher's latest end for this session closed a turn the agent
 * was working on. False for an end that arrived while it was idle or already
 * finished: nothing was asked, so there is nothing to tell the user.
 */
export function turnEndWasCounted(sessionId: number): boolean {
  return lastEndCounted.get(sessionId) === true;
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
  lastEndCounted.set(sessionId, false);
  agentTurnStates.update((all) => {
    const prev = all[sessionId];
    if (prev?.phase !== 'working') return all;
    lastEndCounted.set(sessionId, true);
    const phase: AgentTurnPhase =
      kind === 'finished' ? 'finished'
        : kind === 'blocked' ? 'blocked'
          : kind === 'aborted' ? 'idle'
            : 'failed';
    return { ...all, [sessionId]: { phase, since: Date.now(), task: prev.task } };
  });
}

/** The session is gone. */
export function forgetAgentTurnState(sessionId: number): void {
  lastEndCounted.delete(sessionId);
  agentTurnStates.update((all) => {
    if (!(sessionId in all)) return all;
    const next = { ...all };
    delete next[sessionId];
    return next;
  });
}
