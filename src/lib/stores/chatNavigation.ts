import { get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';
import { pickDefaultStructuredAgent } from '$lib/services/structured-chat/agent-catalog';
import { createStandaloneStructuredRecord, listStandaloneStructuredRecords } from '$lib/services/structured-chat/session-store';
import type { StructuredChatAgent } from '$lib/services/structured-chat/panes';
import { chatThreadState, createChatThread, getChatThread, isStandaloneChat, selectChatThread, STANDALONE_CHAT_SCOPE } from './chatThreads';
import { setInteractionMode } from './interactionMode';

const KEY = 'spacron_chat_scope';
const SELECTED_KEY = 'spacron_selected_standalone_chat';
export const selectedStandaloneChatId = writable<string | null>(loadJson<string | null>(SELECTED_KEY, null)
  ?? get(chatThreadState).activeThreadByProject[STANDALONE_CHAT_SCOPE] ?? null);
selectedStandaloneChatId.subscribe((id) => {
  try { window.localStorage.setItem(SELECTED_KEY, JSON.stringify(id)); } catch { /* Live navigation still works. */ }
});
export const chatScope = writable<'standalone' | 'project'>(loadJson<string>(KEY, 'project') === 'standalone' ? 'standalone' : 'project');
chatScope.subscribe((scope) => {
  try { window.localStorage.setItem(KEY, JSON.stringify(scope)); } catch { /* Live navigation still works. */ }
});
export const standaloneChatOpen = writable<boolean>(false);

export function closeStandaloneChat(): void {
  standaloneChatOpen.set(false);
  if (get(chatScope) !== 'project') chatScope.set('project');
}

export function showStandaloneChat(threadId: string): void {
  const thread = getChatThread(threadId);
  if (!thread || !isStandaloneChat(thread) || !selectChatThread(thread.projectId, threadId)) return;
  selectedStandaloneChatId.set(threadId);
  chatScope.set('standalone');
  setInteractionMode('chat');
}

export function startStandaloneChat(): string {
  const thread = createChatThread(STANDALONE_CHAT_SCOPE, { standalone: true });
  showStandaloneChat(thread.id);
  return thread.id;
}

export function showStandaloneStructuredChat(recordId: string): void {
  selectedStandaloneChatId.set(recordId);
  chatScope.set('standalone');
  standaloneChatOpen.set(true);
  setInteractionMode('chat');
}

export function startStandaloneStructuredChat(opts?: {
  provider?: StructuredChatAgent;
  model?: string | null;
  effort?: string | null;
}): string {
  // An untouched chat is already the "new chat": show it instead of piling up
  // empty rows with each click.
  const draft = opts ? null : listStandaloneStructuredRecords().find((entry) =>
    entry.titleAuto && !entry.title && !entry.pinned && entry.lastSeq === 0 && entry.lifecycle === 'detached');
  const record = draft ?? createStandaloneStructuredRecord({
    provider: opts?.provider ?? pickDefaultStructuredAgent(),
    model: opts?.model ?? null,
    effort: opts?.effort ?? null,
  });
  showStandaloneStructuredChat(record.id);
  return record.id;
}

export function showProjectChat(): void {
  standaloneChatOpen.set(false);
  if (get(chatScope) !== 'project') chatScope.set('project');
}
