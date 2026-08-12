/**
 * End-to-end wiring test for the agent inbox.
 *
 * `inbox.test.ts` covers the pure functions (merge, read-state, persistence);
 * this file proves the *wiring* the UI depends on: that the two persisted
 * sources — chat completion cards (appended by `completeLeasedTask` in
 * `stores/orchestrator`) and actionable mailbox cards (posted by
 * `postMailboxMessage`) — actually land as unread entries in the exact view
 * `InboxPanel` and `InboxBell` render, and that reading/acknowledging clears
 * them. If either source stops feeding the inbox, these fail.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  inboxState,
  mergeInboxEntries,
  countUnread,
  getReadIds,
  getClearedIds,
  markRead,
  acknowledge,
  clearInbox,
  loadProjectInbox,
} from './inbox';
import {
  mailbox,
  getMailboxCards,
  postMailboxMessage,
  dismissMailboxCard,
} from './mailbox';
import { chatMessages, type ChatMessage } from '$lib/stores/orchestrator';

const PROJECT = 'wiring-proj';

/** The exact call the panel and bell make (InboxPanel.tsx / InboxBell.tsx).
 * Keep in sync with the `MAX_ENTRIES` window in both components. */
const MAX_ENTRIES = 40;
function inboxView() {
  const cards = getMailboxCards(PROJECT, { limit: MAX_ENTRIES, actionableOnly: true, includeSeen: true });
  const completions = (get(chatMessages)[PROJECT] ?? []).filter((m) => m.completion);
  return mergeInboxEntries(cards, completions, getReadIds(PROJECT), getClearedIds(PROJECT)).slice(0, MAX_ENTRIES);
}

/** What `completeLeasedTask` appends (orchestrator.ts `appendChat`). */
function appendCompletion(id: string, ts: number, over: Partial<ChatMessage['completion']> = {}) {
  const msg: ChatMessage = {
    id,
    role: 'assistant',
    text: '',
    ts,
    completion: {
      status: 'done',
      agentName: 'Trinity',
      taskTitle: 'Add the tests',
      elapsedSec: 42,
      reason: null,
      summary: 'Wired everything up.',
      summaryPending: false,
      ...over,
    },
  };
  chatMessages.update((all) => ({ ...all, [PROJECT]: [...(all[PROJECT] ?? []), msg] }));
}

beforeEach(() => {
  inboxState.set({});
  mailbox.set({});
  chatMessages.set({});
});

describe('e2e: notifications land in the inbox', () => {
  it('a completed turn lands unread, and reading it clears the badge', async () => {
    await loadProjectInbox(PROJECT, '/repo', () => []);
    appendCompletion('m_1', 1000);

    const view = inboxView();
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ id: 'm_1', kind: 'completion', status: 'done', read: false });
    expect(countUnread(view)).toBe(1);

    // The user reads it the way the panel does (clicking the row).
    markRead(PROJECT, ['m_1']);
    expect(countUnread(inboxView())).toBe(0);
  });

  it('a handoff card and a completion both land, merged newest-first', async () => {
    await loadProjectInbox(PROJECT, '/repo', () => []);
    appendCompletion('m_1', 1000);
    await postMailboxMessage(PROJECT, null, {
      from: 'Builder',
      to: 'Reviewer',
      kind: 'handoff',
      taskId: 't-1',
      text: 'Ready for review',
    });

    const view = inboxView();
    expect(view).toHaveLength(2);
    // Handoff posted later → newest.
    expect(view[0]).toMatchObject({ kind: 'mail', status: 'handoff', actionable: true, read: false });
    expect(view[1]).toMatchObject({ kind: 'completion', status: 'done', read: false });
    expect(countUnread(view)).toBe(2);

    // Acting on the card (approve/reply → acknowledge) clears its unread bit.
    acknowledge(PROJECT, view[0].id);
    expect(countUnread(inboxView())).toBe(1);
  });

  it('a failed/blocked turn lands as an actionable entry', async () => {
    await loadProjectInbox(PROJECT, '/repo', () => []);
    // No AI summary yet (summaryPending or generation failed) → reason fallback.
    appendCompletion('m_blocked', 1000, {
      status: 'blocked',
      reason: 'needs your input',
      summary: null,
    });

    const view = inboxView();
    expect(view[0]).toMatchObject({ status: 'blocked', actionable: true, read: false });
    expect(view[0].body).toBe('needs your input');
    expect(countUnread(view)).toBe(1);
  });

  it('cold start seeds pre-existing history as read so the badge starts at zero', async () => {
    // A project that already has completion history when the inbox first loads
    // must not greet the user with a badge of forty — only work landing AFTER
    // the inbox exists can be unread. This is the contract `loadProjectInbox`'s
    // seed callback exists for, exercised end-to-end.
    appendCompletion('m_old', 1000);
    await loadProjectInbox(PROJECT, '/repo', () => ['m_old']);
    expect(countUnread(inboxView())).toBe(0);

    // New work landing after the seed is unread.
    appendCompletion('m_new', 2000);
    expect(countUnread(inboxView())).toBe(1);
  });

  it('session dismissal alone must not mark a card read — acknowledge is required', async () => {
    // Guards the AgentMailboxCards fix: the inbox reads with includeSeen, so
    // `dismissMailboxCard` (session-only, mailboxSeen) does not hide a card from
    // the panel. Only `acknowledge` (read + dismissed) clears its unread bit.
    await loadProjectInbox(PROJECT, '/repo', () => []);
    const posted = await postMailboxMessage(PROJECT, null, {
      from: 'Builder',
      kind: 'ask',
      text: 'Which approach?',
    });
    expect(countUnread(inboxView())).toBe(1);

    dismissMailboxCard(posted.id); // the old AgentMailboxCards behaviour
    const view = inboxView();
    expect(view.some((e) => e.id === posted.id)).toBe(true); // still listed…
    expect(countUnread(view)).toBe(1); // …and still unread.

    acknowledge(PROJECT, posted.id); // the fixed behaviour
    expect(countUnread(inboxView())).toBe(0);
  });

  it('clearing inbox entries removes them from the inbox view and resets unread count to zero', async () => {
    await loadProjectInbox(PROJECT, '/repo', () => []);
    appendCompletion('m_1', 1000);
    appendCompletion('m_2', 2000);
    expect(inboxView()).toHaveLength(2);
    expect(countUnread(inboxView())).toBe(2);

    // User clicks "Clear"
    clearInbox(PROJECT, ['m_1', 'm_2']);
    expect(inboxView()).toHaveLength(0);
    expect(countUnread(inboxView())).toBe(0);
  });
});
