import { describe, expect, it } from 'vitest';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type { StructuredChatState } from './provider';
import { StructuredEventJournal, diffStructuredState, type StructuredEvent } from './event-journal';

function state(patch: Partial<StructuredChatState> = {}): StructuredChatState {
  return {
    status: 'ready',
    error: null,
    items: [],
    models: [],
    model: null,
    effort: null,
    access: 'ask',
    threadId: null,
    approvals: [],
    subagents: [],
    contextUsed: null,
    contextWindow: null,
    ...patch,
  };
}

const user = (id: string, text: string): TerminalChatItem => ({ id, kind: 'user', text });
const assistant = (id: string, text: string): TerminalChatItem => ({ id, kind: 'assistant', text });

describe('diffStructuredState', () => {
  it('reports new items, text growth, turns and native ids', () => {
    const a = state({ items: [user('u1', 'hi')] });
    const b = state({ status: 'working', items: [user('u1', 'hi'), assistant('a1', 'He')], threadId: 't-1' });
    const c = state({ status: 'ready', items: [user('u1', 'hi'), assistant('a1', 'Hello')], threadId: 't-1' });
    expect(diffStructuredState(null, a).map((e) => e.type)).toEqual(['user.message']);
    expect(diffStructuredState(a, b).map((e) => e.type)).toEqual(['turn.started', 'assistant.text', 'native.session']);
    expect(diffStructuredState(b, c).map((e) => e.type)).toEqual(['assistant.text', 'turn.completed']);
    expect(diffStructuredState(c, c)).toEqual([]);
  });

  it('classifies tools, edits, approvals, config and failures', () => {
    const tool: TerminalChatItem = { id: 'x', kind: 'tool', toolName: 'Edit', text: 'a.ts', toolStatus: 'running' };
    const prev = state({ status: 'working' });
    const next = state({
      status: 'failed',
      error: 'boom',
      items: [tool],
      model: 'm2',
      approvals: [{ requestId: 7, kind: 'command', title: 'run ls', detail: null }],
    });
    const types = diffStructuredState(prev, next).map((e) => e.type);
    expect(types).toEqual(['file.edit', 'turn.interrupted', 'error', 'config.updated', 'approval.requested']);
    const resolved = diffStructuredState(next, state({ status: 'failed', error: 'boom', items: [tool], model: 'm2' }));
    expect(resolved.map((e) => e.type)).toEqual(['approval.resolved']);
  });

  it('emits turn.interrupted when stoppedTurn is set even without an error', () => {
    const prev = state({ status: 'working' });
    const next = state({
      status: 'ready',
      error: null,
      stoppedTurn: { reason: 'interrupted', detail: null, at: 1000 },
    });
    const events = diffStructuredState(prev, next);
    expect(events).toEqual([
      { type: 'turn.interrupted', payload: { status: 'ready', reason: 'interrupted' } },
    ]);
  });

  it('strips image bytes from journaled items', () => {
    const next = state({ items: [{ id: 'u', kind: 'user', text: 'look', images: ['data:image/png;base64,AAAA'] }] });
    const item = diffStructuredState(null, next)[0].payload.item as TerminalChatItem;
    expect(item.images).toBeUndefined();
    expect(item.text).toContain('[1 image attachment]');
  });
});

describe('StructuredEventJournal', () => {
  it('assigns monotonic sequence numbers and turn ids, and folds a snapshot', () => {
    const journal = new StructuredEventJournal('s1', 'codex');
    journal.record([{ type: 'user.message', payload: { item: user('u1', 'hi') } }]);
    journal.record([
      { type: 'turn.started', payload: {}, turn: 'next' },
      { type: 'assistant.text', payload: { item: assistant('a1', 'He') } },
    ]);
    journal.record([{ type: 'assistant.text', payload: { item: assistant('a1', 'Hello') } }]);
    expect(journal.lastSeq).toBe(4);
    expect(journal.currentTurnId).toBe('s1:t1');
    expect(journal.snapshot().items.map((i) => i.text)).toEqual(['hi', 'Hello']);
    expect(journal.since(2).map((e) => e.seq)).toEqual([3, 4]);
  });

  it('preserves when a reply first appeared across streamed updates', () => {
    const journal = new StructuredEventJournal('s1', 'codex');
    const [first] = journal.record([
      { type: 'assistant.text', payload: { item: assistant('a1', 'He') } },
    ]);
    journal.record([{ type: 'assistant.text', payload: { item: assistant('a1', 'Hello') } }], first.at + 5000);
    expect(journal.snapshot().items[0]).toMatchObject({
      text: 'Hello',
      time: new Date(first.at).toISOString(),
    });
  });

  it('rejects duplicate and out-of-order events', () => {
    const journal = new StructuredEventJournal('s1', 'codex');
    const [event] = journal.record([{ type: 'user.message', payload: { item: user('u1', 'hi') } }]);
    expect(journal.ingest(event)).toBe(false);
    const stale: StructuredEvent = { ...event, id: 'other', seq: 1 };
    expect(journal.ingest(stale)).toBe(false);
    const foreign: StructuredEvent = { ...event, id: 'x', seq: 9, sessionId: 's2' };
    expect(journal.ingest(foreign)).toBe(false);
    expect(journal.ingest({ ...event, id: 'next', seq: 2 })).toBe(true);
  });

  it('survives a persist/load round trip and compaction', () => {
    const journal = new StructuredEventJournal('s1', 'codex');
    for (let i = 0; i < 450; i += 1) {
      journal.record([{ type: 'assistant.text', payload: { item: assistant(`a${i % 50}`, `text ${i}`) } }]);
    }
    expect(journal.replayableFrom).toBeGreaterThan(0);
    const restored = new StructuredEventJournal('s1', 'codex', JSON.parse(JSON.stringify(journal.toJSON())));
    expect(restored.lastSeq).toBe(450);
    expect(restored.snapshot().items).toEqual(journal.snapshot().items);
    expect(restored.snapshot().items).toHaveLength(50);
    const page = restored.history(20);
    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(restored.history(20, page.start).items[19].id).toBe(restored.snapshot().items[29].id);
  });

  it('a clear empties the projection', () => {
    const journal = new StructuredEventJournal('s1', 'codex');
    journal.record([{ type: 'user.message', payload: { item: user('u1', 'hi') } }, { type: 'session.cleared', payload: {} }]);
    expect(journal.snapshot().items).toEqual([]);
  });
});
