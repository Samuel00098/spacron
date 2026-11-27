/**
 * Which structured side chats are open in the right sidebar. Each one is an
 * ordinary structured pane on a hidden terminal session, so it has no room on
 * the stage; the sidebar gives it a tab. Not persisted: after a restart the
 * conversation is still in /history.
 */
import { writable } from '$lib/stores/storeCompat';

export interface SideChat {
  paneId: number;
  parentPaneId: number;
  projectId: string | null;
}

export const sideChats = writable<{
  list: SideChat[];
  /** The last request to bring one into view. */
  show: { paneId: number; nonce: number } | null;
}>({ list: [], show: null });

let nonce = 0;

export function showSideChat(paneId: number): boolean {
  let found = false;
  sideChats.update((state) => {
    found = state.list.some((chat) => chat.paneId === paneId);
    return found ? { ...state, show: { paneId, nonce: ++nonce } } : state;
  });
  return found;
}

export function addSideChat(chat: SideChat): void {
  sideChats.update((state) => ({ ...state, list: [...state.list.filter((c) => c.paneId !== chat.paneId), chat] }));
  showSideChat(chat.paneId);
}

export function removeSideChat(paneId: number): void {
  sideChats.update((state) => state.list.some((chat) => chat.paneId === paneId)
    ? { list: state.list.filter((chat) => chat.paneId !== paneId), show: state.show?.paneId === paneId ? null : state.show }
    : state);
}
