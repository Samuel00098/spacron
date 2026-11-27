/** Which chat the sidebar's "Side chat" button would branch from, if any. */
import { useCallback, useSyncExternalStore } from 'react';
import { get } from '$lib/stores/storeCompat';
import { structuredChatHistory, structuredChatPanes } from './panes';
import { structuredChatProvider } from './registry';
import { recordForPane, structuredSessions } from './session-store';

/**
 * The structured chat to branch: the focused one if it has a message, else the
 * one that spoke most recently. Null until some chat in the project has one.
 */
export function sideChatSource(projectId: string | null, focusedPaneId: number | null): number | null {
  if (!projectId) return null;
  let best: { paneId: number; updatedAt: number } | null = null;
  for (const [key, agent] of Object.entries(get(structuredChatPanes))) {
    const paneId = Number(key);
    const record = recordForPane(paneId);
    if (!record || record.side || record.projectId !== projectId) continue;
    const said = (items: readonly { kind: string }[] | undefined) => items?.some((item) => item.kind === 'user') ?? false;
    // Live items first, then what a restored chat shows from its history.
    if (!said(structuredChatProvider(agent)?.get(paneId)?.items) && !said(get(structuredChatHistory)[paneId])) continue;
    if (paneId === focusedPaneId) return paneId;
    if (!best || record.updatedAt > best.updatedAt) best = { paneId, updatedAt: record.updatedAt };
  }
  return best?.paneId ?? null;
}

/** Re-renders only when the answer changes, not on every streamed token. */
export function useSideChatSource(projectId: string | null, focusedPaneId: number | null): number | null {
  const subscribe = useCallback((onChange: () => void) => {
    const stops = [structuredSessions.subscribe(onChange), structuredChatPanes.subscribe(onChange), structuredChatHistory.subscribe(onChange)];
    return () => stops.forEach((stop) => stop());
  }, []);
  const read = () => sideChatSource(projectId, focusedPaneId);
  return useSyncExternalStore(subscribe, read, read);
}
