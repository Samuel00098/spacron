import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/services/ai-keychain', () => ({ providerApiKeyExists: async () => false }));
vi.mock('$lib/stores/settings', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return { aiProvider: writable('chatgpt'), currentAiModel: writable('test-model'),
    isLocalProvider: () => false, getProviderBaseUrl: () => '', getProviderDef: () => ({ label: 'ChatGPT' }) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('standalone persistence', () => {
  it('restores chats and drafts, recovers interrupted replies, and leaves project execution unchanged', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) };
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('localStorage', storage);
    const { get } = await import('$lib/stores/storeCompat');
    const first = await import('./chatThreads');
    const chat = first.createChatThread(first.STANDALONE_CHAT_SCOPE, { title: 'Saved idea', provider: 'chatgpt', model: 'saved-model' });
    first.setThreadDraft(chat.id, 'A saved draft');
    first.appendThreadMessage({ id: 'reply', threadId: chat.id, role: 'assistant', type: 'agent', text: 'Partial answer', ts: 100, pending: true });
    first.updateChatThread(chat.id, { status: 'working', pinned: true });
    const project = first.createChatThread('real-project', { title: 'Project execution' });
    first.appendThreadMessage({ id: 'project-reply', threadId: project.id, role: 'assistant', type: 'agent', text: '', ts: 101, pending: true });
    first.updateChatThread(project.id, { status: 'working' });
    expect(data.get(first.CHAT_THREADS_STORAGE_KEY)).toContain('A saved draft');

    vi.resetModules();
    const restored = await import('./chatThreads');
    expect(restored.getChatThread(chat.id)).toMatchObject({ title: 'Saved idea', draft: 'A saved draft', provider: 'chatgpt', model: 'saved-model', pinned: true, status: 'idle' });
    expect(get(restored.chatThreadState).activeThreadByProject[restored.STANDALONE_CHAT_SCOPE]).toBe(chat.id);
    expect(get(restored.chatThreadState).messagesByThread[chat.id][0]).toMatchObject({ text: 'Partial answer', pending: false });
    expect(restored.getChatThread(project.id)?.status).toBe('working');
    expect(get(restored.chatThreadState).messagesByThread[project.id][0].pending).toBe(true);
    expect(restored.moveStandaloneChatToProject(chat.id, 'real-project')).toBe(true);

    vi.resetModules();
    const moved = await import('./chatThreads');
    expect(moved.getChatThread(chat.id)?.projectId).toBe('real-project');
    expect(get(moved.chatThreadState).messagesByThread[chat.id][0].text).toBe('Partial answer');
    expect(get(moved.chatThreadState).threadsByProject[moved.STANDALONE_CHAT_SCOPE]).toBeUndefined();
  });
});
