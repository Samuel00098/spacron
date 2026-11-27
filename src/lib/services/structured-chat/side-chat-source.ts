/** Which chat the sidebar's "Side chat" button would branch from, if any. */
import { useCallback, useSyncExternalStore } from 'react';
import { get } from '$lib/stores/storeCompat';
import { chatScope, selectedStandaloneChatId } from '$lib/stores/chatNavigation';
import { structuredChatHistory, structuredChatPanes } from './panes';
import { structuredChatProvider } from './registry';
import { findPaneForRecord, recordForPane, structuredSessions } from './session-store';

/**
 * The structured chat to branch:
 * - In standalone scope (or when `projectId === null`), picks the active
 *   standalone structured chat pane once it has a user message.
 * - In project scope, picks the focused project chat if it has a message, else
 *   the project chat that spoke most recently.
 */
export function sideChatSource(projectId: string | null, focusedPaneId: number | null): number | null {
  const said = (items: readonly { kind: string }[] | undefined) => items?.some((item) => item.kind === 'user') ?? false;
  const panes = get(structuredChatPanes);
  const scope = get(chatScope);

  if (!projectId || scope === 'standalone') {
    const selectedId = get(selectedStandaloneChatId);
    if (selectedId) {
      const selectedPane = findPaneForRecord(selectedId);
      if (selectedPane !== null && panes[selectedPane]) {
        const record = recordForPane(selectedPane);
        if (record?.standalone && !record.side) {
          const agent = panes[selectedPane];
          if (said(structuredChatProvider(agent)?.get(selectedPane)?.items) || said(get(structuredChatHistory)[selectedPane])) {
            return selectedPane;
          }
        }
      }
    }
    let bestStandalone: { paneId: number; updatedAt: number } | null = null;
    for (const [key, agent] of Object.entries(panes)) {
      const paneId = Number(key);
      const record = recordForPane(paneId);
      if (!record || record.side || !record.standalone) continue;
      if (!said(structuredChatProvider(agent)?.get(paneId)?.items) && !said(get(structuredChatHistory)[paneId])) continue;
      if (!bestStandalone || record.updatedAt > bestStandalone.updatedAt) {
        bestStandalone = { paneId, updatedAt: record.updatedAt };
      }
    }
    return bestStandalone?.paneId ?? null;
  }

  let best: { paneId: number; updatedAt: number } | null = null;
  for (const [key, agent] of Object.entries(panes)) {
    const paneId = Number(key);
    const record = recordForPane(paneId);
    if (!record || record.side || record.standalone || record.projectId !== projectId) continue;
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
    const stops = [
      structuredSessions.subscribe(onChange),
      structuredChatPanes.subscribe(onChange),
      structuredChatHistory.subscribe(onChange),
      chatScope.subscribe(onChange),
      selectedStandaloneChatId.subscribe(onChange),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);
  const read = () => sideChatSource(projectId, focusedPaneId);
  return useSyncExternalStore(subscribe, read, read);
}
