import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { appendThreadMessage, bindStandaloneChatWorkspace, chatThreadState, createChatThread, deleteChatThread, editAssistantChatMessage, getChatThread, getStandaloneChats, moveStandaloneChatToProject, resetChatThreadsForTests, setThreadDraft, STANDALONE_CHAT_SCOPE, updateChatThread } from '$lib/stores/chatThreads';
import { chatScope, selectedStandaloneChatId, showProjectChat, showStandaloneChat, startStandaloneChat } from '$lib/stores/chatNavigation';
import { beginProjectFromChat, createProjectFromChat, openStandaloneWorkspace, prepareStandaloneChat, projectBriefFromChat, projectFromChat, sendStandaloneChat, stopStandaloneChat } from './standalone-chat';
import { createProjectFolder, newFolderPromptOpen } from '$lib/stores/workspace';
import { setInteractionMode } from '$lib/stores/interactionMode';
import { enqueueChatMessage, loadProjectOrchestratorTasks, stopChatTurn } from '$lib/stores/orchestrator';
import type { ChatMessage } from '$lib/types/chat';
import type { Project } from '$lib/types/workspace';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/stores/interactionMode', () => ({ setInteractionMode: vi.fn() }));
vi.mock('$lib/stores/orchestrator', () => ({ enqueueChatMessage: vi.fn(), loadProjectOrchestratorTasks: vi.fn(), stopChatTurn: vi.fn() }));
vi.mock('$lib/stores/workspace', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return { createProjectFolder: vi.fn(), newFolderPromptOpen: writable(false) };
});
vi.mock('./ai-keychain', () => ({ providerApiKeyExists: async () => false }));
function project(id: string, root: string): Project { return { id, name: 'Chat', root_path: root, state: { open_files: [], active_file: null, last_modified: '' } }; }
beforeEach(() => {
  resetChatThreadsForTests(); vi.clearAllMocks();
  invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === 'chat_workspace_open') return project(`chat-${args.workspaceId}`, `C:/ChatFiles/${args.workspaceId}`);
    if (command === 'chat_workspace_export') return ['notes/idea.md'];
    if (command === 'fs_read_file') throw new Error('Not found');
    return undefined;
  });
  chatScope.set('project'); selectedStandaloneChatId.set(null); projectFromChat.set(null); newFolderPromptOpen.set(false);
});
function newChat() { return createChatThread(STANDALONE_CHAT_SCOPE, { title: 'A planning chat', provider: 'chatgpt', model: 'gpt-5', reasoningEffort: 'high', standalone: true }); }
function message(threadId: string, role: 'user' | 'assistant', text: string): ChatMessage { return { id: `${role}-${text}`, threadId, role, type: role === 'user' ? 'user' : 'agent', text, ts: 100 }; }

describe('standalone scope and workspaces', () => {
  it('starts a standalone chat without opening a project', () => {
    const id = startStandaloneChat();
    expect(getChatThread(id)?.projectId).toBe(STANDALONE_CHAT_SCOPE); expect(get(chatScope)).toBe('standalone');
    expect(createProjectFolder).not.toHaveBeenCalled(); expect(setInteractionMode).toHaveBeenCalledWith('chat');
    showProjectChat(); expect(get(chatScope)).toBe('project'); showStandaloneChat(id); expect(get(selectedStandaloneChatId)).toBe(id);
  });
  it('keeps deletion of the last chat empty', () => {
    const id = startStandaloneChat(); deleteChatThread(id);
    expect(getStandaloneChats(get(chatThreadState))).toEqual([]);
    expect(get(chatThreadState).activeThreadByProject[STANDALONE_CHAT_SCOPE]).toBeNull();
  });
  it('gives each conversation a separate file area, retains history, and loads its orchestrator once', async () => {
    const first = newChat(); const second = newChat();
    appendThreadMessage(message(first.id, 'assistant', 'A decision')); setThreadDraft(first.id, 'Next step');
    const a = await prepareStandaloneChat(first.id); const b = await prepareStandaloneChat(second.id);
    expect(a.root_path).not.toBe(b.root_path);
    expect(getChatThread(first.id)).toMatchObject({ projectId: a.id, standalone: true, standaloneWorkspaceId: first.id, draft: 'Next step' });
    expect(get(chatThreadState).messagesByThread[first.id][0].text).toBe('A decision');
    expect(getStandaloneChats(get(chatThreadState))).toHaveLength(2);
    await prepareStandaloneChat(first.id);
    expect(loadProjectOrchestratorTasks).toHaveBeenCalledTimes(2);
    expect(createProjectFolder).not.toHaveBeenCalled();
  });
  it('does not lose an older rootless chat when native workspace creation fails and can retry', async () => {
    const chat = newChat(); invoke.mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(prepareStandaloneChat(chat.id)).rejects.toThrow('Disk unavailable');
    expect(getChatThread(chat.id)?.projectId).toBe(STANDALONE_CHAT_SCOPE);
    await prepareStandaloneChat(chat.id); expect(getChatThread(chat.id)?.standaloneWorkspaceId).toBe(chat.id);
  });
  it('moves the same chat, draft and settings without touching other conversations', async () => {
    const chat = newChat(); await prepareStandaloneChat(chat.id);
    const other = createChatThread('project-b', { title: 'Existing' });
    setThreadDraft(chat.id, 'Next step');
    expect(moveStandaloneChatToProject(chat.id, 'project-a')).toBe(true);
    expect(getChatThread(chat.id)).toMatchObject({ projectId: 'project-a', standalone: false, provider: 'chatgpt', model: 'gpt-5', draft: 'Next step' });
    expect(getStandaloneChats(get(chatThreadState))).toEqual([]);
    expect(get(chatThreadState).threadsByProject['project-b'][0].id).toBe(other.id);
    expect(moveStandaloneChatToProject(chat.id, 'project-c')).toBe(false);
  });
  it('keeps the existing working state/checkpoint when rebinding a managed workspace', () => {
    const chat = newChat(); updateChatThread(chat.id, { status: 'working' });
    bindStandaloneChatWorkspace(chat.id, 'chat-workspace', 'workspace');
    expect(getChatThread(chat.id)?.status).toBe('working');
    expect(moveStandaloneChatToProject(chat.id, 'project-a')).toBe(false);
  });
});

describe('shared orchestrator', () => {
  it('saves an edited response and retains later conversation without another inference', async () => {
    const chat = newChat();
    const reply = message(chat.id, 'assistant', 'Original response');
    appendThreadMessage(reply);
    appendThreadMessage(message(chat.id, 'assistant', 'Later response'));
    expect(await editAssistantChatMessage(chat.id, reply.id, 'Corrected response')).toBe(true);
    expect(get(chatThreadState).messagesByThread[chat.id].map((entry) => entry.text)).toEqual(['Corrected response', 'Later response']);
    expect(enqueueChatMessage).not.toHaveBeenCalled();
  });
  it('does not edit pending responses or execution awaiting approval', async () => {
    const chat = newChat();
    const reply = { ...message(chat.id, 'assistant', 'Original'), pending: true };
    appendThreadMessage(reply);
    expect(await editAssistantChatMessage(chat.id, reply.id, 'Changed')).toBe(false);
    updateChatThread(chat.id, { status: 'needs-input' });
    expect(await editAssistantChatMessage(chat.id, reply.id, 'Changed')).toBe(false);
  });
  it('uses the same project message pipeline with the selected connection and chat file root', async () => {
    const chat = newChat(); const area = await prepareStandaloneChat(chat.id);
    await sendStandaloneChat(chat.id, 'Create notes.md');
    expect(enqueueChatMessage).toHaveBeenCalledWith(area.id, area.root_path, 'Create notes.md', expect.objectContaining({ threadId: chat.id, projectName: 'Chat', chatMode: true, conversationalMode: true, orchestratorProvider: 'chatgpt', orchestratorModel: 'gpt-5', accessMode: 'full-access' }));
    expect(invoke.mock.calls.some(([command]) => command === 'ai_agent_turn')).toBe(false);
  });
  it('uses the shared cancellation path', () => { const chat = newChat(); stopStandaloneChat(chat.id); expect(stopChatTurn).toHaveBeenCalledWith(chat.id); });
  it('shares pending workspace initialization', async () => {
    const key = `draft-${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([openStandaloneWorkspace(key), openStandaloneWorkspace(key)]);
    expect(first).toBe(second); expect(loadProjectOrchestratorTasks).toHaveBeenCalledTimes(1);
  });
});

describe('create project from chat', () => {
  it('exports chat files, writes the planning brief, preserves the thread and stays in Chat', async () => {
    const chat = newChat(); appendThreadMessage(message(chat.id, 'user', 'Build a reading list')); appendThreadMessage(message(chat.id, 'assistant', 'Keep it offline.')); updateChatThread(chat.id, { status: 'idle' });
    vi.mocked(createProjectFolder).mockResolvedValue(project('project-new', 'C:/Projects/Reading'));
    beginProjectFromChat(chat.id); expect(get(newFolderPromptOpen)).toBe(true);
    await createProjectFromChat(chat.id, 'C:/Projects', 'Reading');
    expect(invoke).toHaveBeenCalledWith('chat_workspace_export', { workspaceId: chat.id, projectId: 'project-new' });
    expect(invoke).toHaveBeenCalledWith('fs_write_file_checked', { path: 'C:/Projects/Reading/PROJECT_BRIEF.md', content: expect.stringContaining('Keep it offline.') });
    expect(getChatThread(chat.id)?.projectId).toBe('project-new'); expect(get(projectFromChat)).toBeNull();
    expect(setInteractionMode).toHaveBeenCalledWith('chat'); expect(setInteractionMode).not.toHaveBeenCalledWith('cli');
  });
  it('keeps source data after export failure and retries the same created folder', async () => {
    const chat = newChat(); await prepareStandaloneChat(chat.id);
    vi.mocked(createProjectFolder).mockResolvedValue(project('retry-project', 'C:/Projects/Idea'));
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementationOnce(async () => { throw new Error('Disk unavailable'); });
    await expect(createProjectFromChat(chat.id, 'C:/Projects', 'Idea')).rejects.toThrow('Disk unavailable');
    expect(getChatThread(chat.id)?.standalone).toBe(true);
    invoke.mockImplementation(normal); await createProjectFromChat(chat.id, 'C:/Projects', 'Idea');
    expect(createProjectFolder).toHaveBeenCalledTimes(1); expect(getChatThread(chat.id)?.projectId).toBe('retry-project');
  });
  it('preserves a user-created PROJECT_BRIEF.md with a distinct planning filename', async () => {
    const chat = newChat(); await prepareStandaloneChat(chat.id);
    vi.mocked(createProjectFolder).mockResolvedValue(project('collision-project', 'C:/Projects/Idea'));
    invoke.mockResolvedValueOnce(['PROJECT_BRIEF.md']);
    await createProjectFromChat(chat.id, 'C:/Projects', 'Idea');
    expect(invoke).toHaveBeenCalledWith('fs_write_file_checked', expect.objectContaining({ path: 'C:/Projects/Idea/PROJECT_BRIEF_FROM_CHAT_1.md' }));
  });
  it('refuses to create a project while a response is running', async () => {
    const chat = newChat(); updateChatThread(chat.id, { status: 'working' }); beginProjectFromChat(chat.id);
    expect(get(newFolderPromptOpen)).toBe(false);
    await expect(createProjectFromChat(chat.id, 'C:/Projects', 'Idea')).rejects.toThrow('finish'); expect(createProjectFolder).not.toHaveBeenCalled();
  });
  it('keeps tool activity and failed responses out of the planning brief', () => {
    const brief = projectBriefFromChat('Idea', [message('chat', 'user', 'The idea'), message('chat', 'assistant', 'Decision'), { ...message('chat', 'assistant', 'Tool internals'), type: 'activity' }, { ...message('chat', 'assistant', 'Connection failed'), type: 'failure' }]);
    expect(brief).toContain('Decision'); expect(brief).not.toContain('Tool internals'); expect(brief).not.toContain('Connection failed');
  });
});
