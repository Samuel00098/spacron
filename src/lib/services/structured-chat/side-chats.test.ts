import { describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { addSideChat, removeSideChat, showSideChat, sideChats } from './side-chats';

describe('side chats', () => {
  it('brings a new one into view, shows it again on request, and forgets a closed one', () => {
    addSideChat({ paneId: 5, parentPaneId: 1, projectId: 'p' });
    const first = get(sideChats).show!;
    expect(first.paneId).toBe(5);

    // A notification for the same pane is a new request, so the tab is reselected.
    expect(showSideChat(5)).toBe(true);
    expect(get(sideChats).show!.nonce).toBeGreaterThan(first.nonce);
    expect(showSideChat(99)).toBe(false);

    removeSideChat(5);
    expect(get(sideChats)).toEqual({ list: [], show: null });
  });
});
