import { writable, get } from '$lib/stores/storeCompat';
import { agentWorktrees } from './settings';

/**
 * Where a freshly spawned agent should run.
 *  - `worktree`: its own isolated git worktree (own branch off HEAD)
 *  - `main`: directly in the project root, on the checked-out branch
 */
export type AgentPlacement = 'worktree' | 'main';

export interface AgentPlacementRequest {
  id: number;
  /**
   * One label per agent ABOUT to start — not per preset. Three agents means
   * three entries, because each one is placed independently: you can run one in
   * the main repo and the other two in their own worktrees.
   */
  agents: string[];
  /** Who asked — tunes the dialog copy. */
  source: 'manual' | 'orchestrator';
  /** Pre-selected option for every agent (the global default, unless the caller knows better). */
  suggested: AgentPlacement;
  /** Why `suggested` isn't just the global default; shown as a hint. */
  suggestionReason: string | null;
  /** When present, the request is rendered in this Chat composer. */
  projectId?: string;
  threadId?: string;
  resolve: (choices: AgentPlacement[] | null) => void;
}

/**
 * The placement question is asked as a real, blocking dialog rather than a
 * settings toggle: an agent quietly working inside a worktree is invisible in
 * the main checkout, and people who spawn on autopilot only find out much
 * later. Making the choice explicit at spawn time is the reminder.
 *
 * Requests queue (head = what the dialog shows) so two spawn paths racing each
 * other can't drop one silently.
 */
export const agentPlacementRequest = writable<AgentPlacementRequest | null>(null);

let nextRequestId = 1;
const queue: AgentPlacementRequest[] = [];

/** The option the dialog starts on, from the "isolate agents" setting. */
export function defaultAgentPlacement(): AgentPlacement {
  return get(agentWorktrees) === false ? 'main' : 'worktree';
}

/**
 * Ask the user where to run the agent(s). Resolves with ONE placement per entry
 * in `agents`, index-aligned — a mixed answer (one in the main repo, two
 * isolated) is the normal case, not a special one. Resolves `null` if the dialog
 * was dismissed, in which case the caller must NOT spawn anything.
 */
export function requestAgentPlacement(args: {
  agents: string[];
  source: 'manual' | 'orchestrator';
  suggested?: AgentPlacement;
  suggestionReason?: string | null;
  projectId?: string;
  threadId?: string;
}): Promise<AgentPlacement[] | null> {
  return new Promise((resolve) => {
    const request: AgentPlacementRequest = {
      id: nextRequestId++,
      agents: args.agents,
      source: args.source,
      suggested: args.suggested ?? defaultAgentPlacement(),
      suggestionReason: args.suggestionReason ?? null,
      projectId: args.projectId,
      threadId: args.threadId,
      resolve,
    };
    queue.push(request);
    if (queue.length === 1) agentPlacementRequest.set(request);
  });
}

/**
 * Settle a pending request with one placement per agent, index-aligned with the
 * request's `agents`. `null` = dismissed, so nothing should be spawned.
 */
export function resolveAgentPlacement(id: number, choices: AgentPlacement[] | null): void {
  const index = queue.findIndex((request) => request.id === id);
  if (index === -1) return;
  const [request] = queue.splice(index, 1);
  request.resolve(choices);
  agentPlacementRequest.set(queue[0] ?? null);
}

/** Dismiss everything still queued (e.g. the project was closed). */
export function cancelAllAgentPlacements(): void {
  const pending = queue.splice(0, queue.length);
  agentPlacementRequest.set(null);
  for (const request of pending) request.resolve(null);
}

/**
 * Flatten a "2 × Claude Code, 1 × Codex" pick into ONE label per agent, numbered
 * where a preset repeats ("Claude Code 1", "Claude Code 2", "Codex"). The dialog
 * places each of these independently, so the list must be per-instance.
 */
export function expandSpawnPlan<T>(entries: Array<{ key: T; label: string; count: number }>): Array<{
  key: T;
  label: string;
}> {
  return entries
    .filter((entry) => entry.count > 0)
    .flatMap((entry) =>
      Array.from({ length: entry.count }, (_unused, index) => ({
        key: entry.key,
        label: entry.count > 1 ? `${entry.label} ${index + 1}` : entry.label,
      }))
    );
}
