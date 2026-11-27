import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  panes: {} as Record<number, string>,
  history: {} as Record<number, { kind: string }[]>,
  items: {} as Record<number, { kind: string }[]>,
  records: {} as Record<number, { id?: string; projectId: string | null; updatedAt: number; side?: boolean; standalone?: boolean }>,
  chatScope: 'project' as 'project' | 'standalone',
  selectedStandaloneId: null as string | null,
}));
const { store } = vi.hoisted(() => ({ store: (value: () => unknown) => ({ subscribe: (fn: (v: unknown) => void) => { fn(value()); return () => {}; } }) }));

vi.mock('./panes', () => ({ structuredChatPanes: store(() => h.panes), structuredChatHistory: store(() => h.history) }));
vi.mock('./registry', () => ({ structuredChatProvider: () => ({ get: (id: number) => ({ items: h.items[id] ?? [] }) }) }));
vi.mock('./session-store', () => ({
  recordForPane: (id: number) => h.records[id] ?? null,
  findPaneForRecord: (recordId: string) => {
    const found = Object.entries(h.records).find(([, r]) => r.id === recordId);
    return found ? Number(found[0]) : null;
  },
  structuredSessions: store(() => ({})),
}));
vi.mock('$lib/stores/chatNavigation', () => ({
  chatScope: store(() => h.chatScope),
  selectedStandaloneChatId: store(() => h.selectedStandaloneId),
}));

import { sideChatSource } from './side-chat-source';

describe('sideChatSource', () => {
  it('waits for a message, prefers the focused chat, and never picks a side chat', () => {
    h.chatScope = 'project';
    h.selectedStandaloneId = null;
    h.panes = { 1: 'claude', 2: 'codex', 3: 'claude', 4: 'claude' };
    h.records = {
      1: { projectId: 'p', updatedAt: 10 },
      2: { projectId: 'p', updatedAt: 20 },
      3: { projectId: 'p', updatedAt: 99, side: true },
      4: { projectId: 'other', updatedAt: 99 },
    };
    h.items = { 3: [{ kind: 'user' }], 4: [{ kind: 'user' }] };
    expect(sideChatSource('p', 1)).toBeNull();

    h.items[1] = [{ kind: 'user' }];
    expect(sideChatSource('p', null)).toBe(1);
    // A restored chat has its messages in history only.
    h.history = { 2: [{ kind: 'user' }] };
    expect(sideChatSource('p', null)).toBe(2);
    expect(sideChatSource('p', 1)).toBe(1);
    expect(sideChatSource(null, 1)).toBeNull();
  });

  it('picks the active standalone structured pane in standalone scope', () => {
    h.chatScope = 'standalone';
    h.selectedStandaloneId = 's-active';
    h.panes = { [-1001]: 'claude', [-1002]: 'codex' };
    h.records = {
      [-1001]: { id: 's-active', projectId: null, standalone: true, updatedAt: 50 },
      [-1002]: { id: 's-other', projectId: null, standalone: true, updatedAt: 99 },
    };
    h.items = {
      [-1001]: [{ kind: 'user' }],
      [-1002]: [{ kind: 'user' }],
    };
    expect(sideChatSource('p', 1)).toBe(-1001);
    expect(sideChatSource(null, null)).toBe(-1001);
  });
});
