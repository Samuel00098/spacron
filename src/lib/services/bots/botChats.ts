import { get } from '$lib/stores/storeCompat';
import { persisted } from '$lib/stores/chatViewSettings';
import type { BotRun } from './bots';

/**
 * A bot's chats. The runner only knows runs, so a chat is a span of time: it
 * starts at a recorded timestamp and holds every run from then until the next
 * chat starts. The first chat starts at 0. Archiving only hides a chat from the
 * list; nothing is deleted.
 */
export interface BotChatState { starts: number[]; archived: number[] }
type ChatMap = Record<string, BotChatState>;

function normalize(raw: unknown): ChatMap {
  const out: ChatMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, Partial<BotChatState>>)) {
    const nums = (list: unknown) => (Array.isArray(list) ? list.filter((n): n is number => Number.isFinite(n) && n > 0) : []);
    out[id] = { starts: [...new Set(nums(value?.starts))].sort((a, b) => a - b), archived: nums(value?.archived) };
  }
  return out;
}

export const botChats = persisted<ChatMap>('spacron_bot_chats_v1', {}, normalize);

export interface BotChat {
  /** When the chat started (0 for the first); also its id. */
  id: number;
  runs: BotRun[];
  /** The first thing said in it, for the picker. */
  title: string;
  archived: boolean;
  /** The newest chat: the only one that takes new messages. */
  current: boolean;
}

/** Split a bot's runs (newest first) into chats, newest first. The current chat is always listed, even when empty. */
export function splitChats(state: BotChatState | undefined, runs: BotRun[]): BotChat[] {
  const starts = [0, ...(state?.starts ?? [])];
  const chats: BotChat[] = starts.map((id) => ({ id, runs: [], title: '', archived: state?.archived.includes(id) ?? false, current: false }));
  for (const run of runs) {
    let i = starts.length - 1;
    while (i > 0 && run.startedAt < starts[i]) i--;
    chats[i].runs.push(run);
  }
  for (const chat of chats) {
    const first = [...chat.runs].reverse().find((r) => r.message && r.message.trim());
    chat.title = (first?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
  }
  chats[chats.length - 1].current = true;
  return chats.filter((c) => c.current || c.runs.length > 0).reverse();
}

function update(botId: string, change: (s: BotChatState) => BotChatState) {
  botChats.update((all) => ({ ...all, [botId]: change(all[botId] ?? { starts: [], archived: [] }) }));
}

/** Begin a fresh chat with this bot; returns its id. A current chat with nothing in it is reused. */
export function newBotChat(botId: string, runs: BotRun[], now = Date.now()): number {
  const current = splitChats(get(botChats)[botId], runs).find((c) => c.current)!;
  if (!current.runs.length && !current.archived) return current.id;
  const id = Math.max(now, Math.max(0, ...(get(botChats)[botId]?.starts ?? [])) + 1);
  update(botId, (s) => ({ ...s, starts: [...s.starts, id] }));
  return id;
}

export function setBotChatArchived(botId: string, chatId: number, archived: boolean) {
  update(botId, (s) => ({ ...s, archived: archived ? [...new Set([...s.archived, chatId])] : s.archived.filter((id) => id !== chatId) }));
}
