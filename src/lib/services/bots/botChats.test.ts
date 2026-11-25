import { expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { botChats, removeBotChat, splitChats } from './botChats';
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
