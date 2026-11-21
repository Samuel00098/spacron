/**
 * Follow-up messages waiting in a terminal chat until the agent's turn ends
 * (Settings > Chat > Queue follow-ups). Module state, keyed by pane, so the
 * queue survives the view unmounting when its tab is hidden.
 */

import { useStore } from '$lib/react/useStore';
import { writable } from '$lib/stores/storeCompat';

export interface QueuedMessage {
  id: number;
  text: string;
  /** Saved image paths to paste before the text, with their previews. */
  images: { path: string; preview: string | null }[];
}

const queues = new Map<number, QueuedMessage[]>();
const tick = writable(0);
let nextId = 0;

function set(sessionId: number, list: QueuedMessage[]): void {
  if (list.length) queues.set(sessionId, list);
  else queues.delete(sessionId);
  tick.update((n) => n + 1);
}

export function getQueue(sessionId: number): QueuedMessage[] {
  return queues.get(sessionId) ?? [];
}

export function useQueue(sessionId: number): QueuedMessage[] {
  useStore(tick);
  return getQueue(sessionId);
}

export function enqueue(sessionId: number, text: string, images: QueuedMessage['images'] = []): void {
  set(sessionId, [...getQueue(sessionId), { id: ++nextId, text, images }]);
}

export function updateQueued(sessionId: number, id: number, text: string): void {
  set(sessionId, getQueue(sessionId).map((m) => (m.id === id ? { ...m, text } : m)));
}

export function removeQueued(sessionId: number, id: number): QueuedMessage | null {
  const list = getQueue(sessionId);
  const found = list.find((m) => m.id === id) ?? null;
  set(sessionId, list.filter((m) => m.id !== id));
  return found;
}

export function moveQueued(sessionId: number, id: number, delta: -1 | 1): void {
  const list = [...getQueue(sessionId)];
  const from = list.findIndex((m) => m.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
  set(sessionId, list);
}

/** Take the first waiting message off the queue. */
export function shiftQueue(sessionId: number): QueuedMessage | null {
  const [first, ...rest] = getQueue(sessionId);
  if (!first) return null;
  set(sessionId, rest);
  return first;
}

export function clearQueue(sessionId: number): void {
  if (queues.has(sessionId)) set(sessionId, []);
}
