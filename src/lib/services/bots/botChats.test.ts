import { describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { botChats, botTimeline, removeBotChat, splitChats, type BotChat } from './botChats';
import type { BotRun } from './bots';

const run = (id: string, startedAt: number, message: string): BotRun =>
  ({ id, botId: 'b', name: 'b', startedAt, status: 'completed', trigger: 'chat', message });

it('splits runs into chats at each start, newest first', () => {
  const runs = [run('c', 300, 'third'), run('b', 150, 'second'), run('a', 50, 'first')];
  const chats = splitChats({ starts: [100, 200], archived: [0] }, runs);
  expect(chats.map((c) => [c.id, c.runs.map((r) => r.id), c.title, c.current, c.archived]))
    .toEqual([[200, ['c'], 'third', true, false], [100, ['b'], 'second', false, false], [0, ['a'], 'first', false, true]]);
});

it('always lists the current chat, even when empty', () => {
  const chats = splitChats({ starts: [100], archived: [] }, [run('a', 50, 'hi')]);
  expect(chats.map((c) => [c.id, c.title, c.current])).toEqual([[100, 'New chat', true], [0, 'hi', false]]);
});

it('a deleted chat thread leaves the list, and the chats around it keep their runs', () => {
  botChats.set({ b: { starts: [100, 200], archived: [100] } });
  removeBotChat('b', 100);
  expect(get(botChats).b).toEqual({ starts: [200], archived: [] });
  // Its runs are gone (the runner deleted them); the rest split as before.
  const chats = splitChats(get(botChats).b, [run('c', 300, 'third'), run('a', 50, 'first')]);
  expect(chats.map((c) => [c.id, c.runs.map((r) => r.id), c.current])).toEqual([[200, ['c'], true], [0, ['a'], false]]);
});

describe('botTimeline', () => {
  const chat = (id: number, count: number, extra: Partial<BotChat> = {}): BotChat => ({
    id, title: String(id), archived: false, current: false,
    // Newest first, as splitChats gives them.
    runs: Array.from({ length: count }, (_, i) => ({ id: `${id}-${count - i}` }) as BotRun),
    ...extra,
  });
  const chats = [chat(3, 0, { current: true }), chat(2, 2, { archived: true }), chat(1, 3)];
  const ids = (t: ReturnType<typeof botTimeline>) => t.sections.map((s) => s.runs.map((r) => r.id));

  it('reads oldest first, keeps the empty current chat and leaves archived ones out', () => {
    const timeline = botTimeline(chats, false, 30);
    expect(ids(timeline)).toEqual([['1-1', '1-2', '1-3'], []]);
    expect(timeline.hidden).toBe(0);
  });

  it('includes archived chats in their place when asked', () => {
    expect(ids(botTimeline(chats, true, 30))).toEqual([['1-1', '1-2', '1-3'], ['2-1', '2-2'], []]);
  });

  it('draws only the newest runs and counts the rest', () => {
    const timeline = botTimeline(chats, true, 3);
    expect(ids(timeline)).toEqual([['1-3'], ['2-1', '2-2'], []]);
    expect(timeline.hidden).toBe(2);
  });
});
