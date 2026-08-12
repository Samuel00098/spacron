import { beforeEach, describe, expect, it } from 'vitest';
import {
  inboxState,
  addTrackedIds,
  mailEntry,
  completionEntry,
  mergeInboxEntries,
  countUnread,
  markRead,
  markDismissed,
  acknowledge,
  markAllRead,
  clearInbox,
  getReadIds,
  getDismissedIds,
  getClearedIds,
  parseInboxState,
  loadProjectInbox,
  MAX_TRACKED_IDS,
  type CompletionLike,
} from './inbox';
import type { MailboxCard } from './mailbox';

const PROJECT = 'proj-1';

function card(over: Partial<MailboxCard> = {}): MailboxCard {
  return {
    id: over.id ?? 'mb_1',
    from: over.from ?? 'Neo',
    to: over.to ?? null,
    kind: over.kind ?? 'report',
    taskId: over.taskId ?? null,
    files: over.files ?? [],
    worktreeBranch: over.worktreeBranch,
    text: over.text ?? 'Wired the parser up.',
    createdAt: over.createdAt ?? 1000,
    actionable: over.actionable ?? true,
  };
}

function completion(over: Partial<CompletionLike> & { status?: 'done' | 'failed' | 'blocked' } = {}): CompletionLike {
  return {
    id: over.id ?? 'chat_1',
    ts: over.ts ?? 2000,
    completion: over.completion !== undefined
      ? over.completion
      : {
          status: over.status ?? 'done',
          agentName: 'Trinity',
          taskTitle: 'Add the inbox',
          elapsedSec: 42,
          summary: 'Added a persisted read-state layer.',
        },
  };
}

beforeEach(() => {
  inboxState.set({});
});

describe('addTrackedIds', () => {
  it('appends new ids and dedupes existing ones', () => {
    expect(addTrackedIds(['a'], ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns the same array reference when nothing is new', () => {
    const list = ['a', 'b'];
    expect(addTrackedIds(list, ['a'])).toBe(list);
  });

  it('drops the oldest ids past the cap', () => {
    const full = Array.from({ length: MAX_TRACKED_IDS }, (_, i) => `id-${i}`);
    const next = addTrackedIds(full, ['fresh']);
    expect(next).toHaveLength(MAX_TRACKED_IDS);
    expect(next[0]).toBe('id-1');
    expect(next.at(-1)).toBe('fresh');
  });
});

describe('mailEntry', () => {
  it('titles a handoff with its recipient', () => {
    expect(mailEntry(card({ kind: 'handoff', to: 'Morpheus' }), false).title).toBe('Handed off to Morpheus');
  });

  it('falls back to the team when a handoff has no recipient', () => {
    expect(mailEntry(card({ kind: 'handoff', to: null }), false).title).toBe('Handed off to the team');
  });

  it('carries the sender, body and read flag through', () => {
    const entry = mailEntry(card({ from: 'Neo', text: 'Done.' }), true);
    expect(entry).toMatchObject({ agentName: 'Neo', body: 'Done.', read: true, kind: 'mail' });
  });
});

describe('completionEntry', () => {
  it('returns null for a chat message that is not a completion', () => {
    expect(completionEntry({ id: 'x', ts: 1, completion: null }, false)).toBeNull();
  });

  it('prefers the AI summary for the body', () => {
    expect(completionEntry(completion(), false)?.body).toBe('Added a persisted read-state layer.');
  });

  it('falls back to the failure reason when there is no summary', () => {
    const entry = completionEntry(
      completion({ completion: { status: 'failed', agentName: 'Neo', taskTitle: 'T', elapsedSec: null, reason: 'exit 1' } }),
      false,
    );
    expect(entry?.body).toBe('exit 1');
  });

  it('renders an empty body rather than "undefined" while the summary is pending', () => {
    const entry = completionEntry(
      completion({ completion: { status: 'done', agentName: 'Neo', taskTitle: 'T', elapsedSec: null, summaryPending: true } }),
      false,
    );
    expect(entry?.body).toBe('');
  });

  it('treats a clean finish as information and a stall as actionable', () => {
    expect(completionEntry(completion({ status: 'done' }), false)?.actionable).toBe(false);
    expect(completionEntry(completion({ status: 'blocked' }), false)?.actionable).toBe(true);
    expect(completionEntry(completion({ status: 'failed' }), false)?.actionable).toBe(true);
  });
});

describe('mergeInboxEntries', () => {
  it('interleaves both sources newest-first', () => {
    const entries = mergeInboxEntries(
      [card({ id: 'a', createdAt: 100 }), card({ id: 'c', createdAt: 300 })],
      [completion({ id: 'b', ts: 200 })],
      new Set(),
    );
    expect(entries.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('stamps read state from the id set', () => {
    const entries = mergeInboxEntries([card({ id: 'a' })], [completion({ id: 'b' })], new Set(['a']));
    expect(entries.find((e) => e.id === 'a')?.read).toBe(true);
    expect(entries.find((e) => e.id === 'b')?.read).toBe(false);
  });

  it('skips chat messages with no completion card', () => {
    const entries = mergeInboxEntries([], [completion({ id: 'b', completion: null })], new Set());
    expect(entries).toEqual([]);
  });
});

describe('countUnread', () => {
  it('counts only unread entries', () => {
    const entries = mergeInboxEntries(
      [card({ id: 'a' }), card({ id: 'b' })],
      [completion({ id: 'c' })],
      new Set(['a']),
    );
    expect(countUnread(entries)).toBe(2);
  });
});

describe('read and dismissed state', () => {
  it('keeps read and dismissed independent', () => {
    markDismissed(PROJECT, ['auto-cleared']);
    expect(getDismissedIds(PROJECT).has('auto-cleared')).toBe(true);
    // The whole point: a card that timed out is gone from the corner but is
    // still waiting in the inbox.
    expect(getReadIds(PROJECT).has('auto-cleared')).toBe(false);
  });

  it('acknowledge sets both bits', () => {
    acknowledge(PROJECT, 'closed-by-hand');
    expect(getReadIds(PROJECT).has('closed-by-hand')).toBe(true);
    expect(getDismissedIds(PROJECT).has('closed-by-hand')).toBe(true);
  });

  it('scopes state per project', () => {
    markRead(PROJECT, ['a']);
    expect(getReadIds('other-project').has('a')).toBe(false);
  });

  it('ignores empty projects and empty id lists', () => {
    markRead('', ['a']);
    markRead(PROJECT, []);
    expect(getReadIds(PROJECT).size).toBe(0);
  });

  it('markAllRead marks every unread entry and leaves read ones alone', () => {
    const entries = mergeInboxEntries(
      [card({ id: 'a' }), card({ id: 'b' })],
      [completion({ id: 'c' })],
      new Set(['a']),
    );
    markAllRead(PROJECT, entries);
    const read = getReadIds(PROJECT);
    expect(read.has('b')).toBe(true);
    expect(read.has('c')).toBe(true);
    // 'a' was already read, so it was not re-recorded.
    expect(read.has('a')).toBe(false);
  });

  it('clearInbox marks entries cleared, read, and dismissed', () => {
    clearInbox(PROJECT, ['item-1', 'item-2']);
    expect(getClearedIds(PROJECT).has('item-1')).toBe(true);
    expect(getClearedIds(PROJECT).has('item-2')).toBe(true);
    expect(getReadIds(PROJECT).has('item-1')).toBe(true);
    expect(getDismissedIds(PROJECT).has('item-1')).toBe(true);
  });

  it('mergeInboxEntries filters out cleared entries', () => {
    const entries = mergeInboxEntries(
      [card({ id: 'a' }), card({ id: 'b' })],
      [completion({ id: 'c' })],
      new Set(),
      new Set(['a', 'c']),
    );
    expect(entries.map((e) => e.id)).toEqual(['b']);
  });
});

describe('loadProjectInbox cold start', () => {
  // There is no project-state backend in the test env, so `readProjectState`
  // resolves null — exactly the first-run path this seeding exists for.
  it('marks pre-existing work as read on first run so the badge starts at zero', async () => {
    await loadProjectInbox(PROJECT, '/repo', () => ['old-a', 'old-b']);
    const read = getReadIds(PROJECT);
    expect(read.has('old-a')).toBe(true);
    expect(read.has('old-b')).toBe(true);
    // Seeding read must not also mark them dismissed — that is a separate bit.
    expect(getDismissedIds(PROJECT).size).toBe(0);
  });

  it('leaves state empty when no seed is supplied', async () => {
    await loadProjectInbox(PROJECT, '/repo');
    expect(getReadIds(PROJECT).size).toBe(0);
  });

  it('does not resurrect state from a previous project', async () => {
    await loadProjectInbox(PROJECT, '/repo', () => ['old-a']);
    await loadProjectInbox('proj-2', '/repo2', () => ['other']);
    expect(getReadIds('proj-2').has('old-a')).toBe(false);
    expect(getReadIds(PROJECT).has('old-a')).toBe(true);
  });
});

describe('parseInboxState', () => {
  it('returns empty state for null, junk and non-objects', () => {
    expect(parseInboxState(null)).toEqual({ read: [], dismissed: [], cleared: [] });
    expect(parseInboxState('not json')).toEqual({ read: [], dismissed: [], cleared: [] });
    expect(parseInboxState('[1,2]')).toEqual({ read: [], dismissed: [], cleared: [] });
  });

  it('keeps well-formed arrays and drops malformed ones', () => {
    expect(parseInboxState('{"read":["a"],"dismissed":[1,2],"cleared":["c"]}')).toEqual({ read: ['a'], dismissed: [], cleared: ['c'] });
  });

  it('caps an oversized file on read', () => {
    const read = Array.from({ length: MAX_TRACKED_IDS + 50 }, (_, i) => `id-${i}`);
    expect(parseInboxState(JSON.stringify({ read, dismissed: [], cleared: [] })).read).toHaveLength(MAX_TRACKED_IDS);
  });
});
