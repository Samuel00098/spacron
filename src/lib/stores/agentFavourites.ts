import { get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

const STORAGE_KEY = 'spacron_favourite_agents';

/**
 * Agents the user pinned in the Chat picker.
 *
 * T3 keeps a short, ordered list of agents you reach for; Chat's roster can be
 * long (every preset plus every ACP agent added from the registry), so pinned
 * agents sort to the top and carry a star. Purely presentational: it never
 * changes which agents exist or which one a thread is bound to.
 */
export const favouriteAgentCommands = writable<string[]>(
  (() => {
    const stored = loadJson<string[]>(STORAGE_KEY, []);
    return Array.isArray(stored)
      ? stored.filter((command) => typeof command === 'string' && command.trim()).map((command) => command.trim().toLowerCase())
      : [];
  })(),
);

favouriteAgentCommands.subscribe((commands) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(commands));
  } catch {}
});

export function isFavouriteAgent(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return Boolean(normalized) && get(favouriteAgentCommands).includes(normalized);
}

/** Pin or unpin an agent; returns the new state. */
export function toggleFavouriteAgent(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  const current = get(favouriteAgentCommands);
  const next = current.includes(normalized)
    ? current.filter((entry) => entry !== normalized)
    : [...current, normalized];
  favouriteAgentCommands.set(next);
  return next.includes(normalized);
}

/**
 * Pinned agents first, in pin order, then everything else in its existing
 * order. Stable, so the roster never reshuffles between renders.
 */
export function sortAgentsByFavourite<T extends { command: string }>(agents: readonly T[]): T[] {
  const pinned = get(favouriteAgentCommands);
  if (pinned.length === 0) return [...agents];
  const rank = (command: string): number => {
    const index = pinned.indexOf(command.trim().toLowerCase());
    return index === -1 ? pinned.length : index;
  };
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => rank(a.agent.command) - rank(b.agent.command) || a.index - b.index)
    .map((entry) => entry.agent);
}
