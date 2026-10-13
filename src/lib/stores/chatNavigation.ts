import { get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';
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

export function showProjectChat(): void {
  if (get(chatScope) !== 'project') chatScope.set('project');
}
