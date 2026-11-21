import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    },
  };
  return { data };
});

import { chatDraftKey, clearChatDraft, normalizeDraft, readChatDraft, writeChatDraft } from './drafts';

describe('chat drafts', () => {
  beforeEach(() => store.data.clear());

  it('keeps text and attachment paths, and drops an empty draft', () => {
    expect(normalizeDraft({ text: '   ', attachments: [] })).toBeNull();
    expect(normalizeDraft({ text: 'hi', attachments: [{ path: 'C:/tmp/a.png', name: 'a.png' }] }))
      .toEqual({ text: 'hi', attachments: [{ path: 'C:/tmp/a.png', name: 'a.png' }] });
  });

  it('round-trips a draft and removes the key once it is empty', () => {
    writeChatDraft(7, { text: 'half a thought', attachments: [{ path: '/tmp/pasted.png', name: 'pasted.png' }] });
    expect(store.data.get(chatDraftKey(7))).toContain('pasted.png');
    expect(readChatDraft(7)).toEqual({ text: 'half a thought', attachments: [{ path: '/tmp/pasted.png', name: 'pasted.png' }] });

    writeChatDraft(7, { text: '', attachments: [] });
    expect(store.data.has(chatDraftKey(7))).toBe(false);
    expect(readChatDraft(7)).toBeNull();

    clearChatDraft(7);
    expect(readChatDraft(7)).toBeNull();
  });

  it('ignores damaged storage instead of throwing', () => {
    store.data.set(chatDraftKey(9), '{not json');
    expect(readChatDraft(9)).toBeNull();
    store.data.set(chatDraftKey(10), JSON.stringify({ text: 5 }));
    expect(readChatDraft(10)).toBeNull();
  });

  it('caps what it keeps', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `/tmp/${i}.png`, name: `${i}.png` }));
    expect(normalizeDraft({ text: '', attachments: many })?.attachments).toHaveLength(12);
    expect(normalizeDraft({ text: 'x'.repeat(70_000), attachments: [] })?.text).toHaveLength(60_000);
  });
});
