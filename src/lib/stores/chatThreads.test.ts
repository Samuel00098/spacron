import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  appendLegacyChatMessage,
  appendThreadMessage,
  chatThreadState,
  clearChatThreadMessages,
  clearProjectThreadMessages,
  createChatThread,
  deleteChatThread,
  editChatMessage,
  patchThreadMessage,
  migrateLegacyChat,
  removeThreadMessage,
  removeThreadMessagesFrom,
  renameChatThread,
  repairThreadSummaries,
  resetChatThreadsForTests,
  selectChatThread,
  setThreadDraft,
  toggleChatThreadPinned,
} from './chatThreads';

const invoke = vi.hoisted(() => vi.fn(async (_command: string): Promise<unknown> => undefined));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => {
  resetChatThreadsForTests();
  invoke.mockReset();
});

describe('migrateLegacyChat', () => {
  it('moves each project into its own default thread and preserves message data', () => {
    const migrated = migrateLegacyChat(
      {
        'project-a': [
          {
            id: 'user-a',
            role: 'user',
            text: 'Plan the change',
            ts: 100,
            extra: 'keep me',
          },
          {
            id: 'completion-a',
            role: 'assistant',
            text: 'Done',
            ts: 120,
            completion: {
              status: 'done',
              agentName: 'Iris',
              taskTitle: 'Plan the change',
              elapsedSec: 4,
              taskId: 'task-a',
            },
          },
        ],
        'project-b': [
          { id: 'user-b', role: 'user', text: 'Review B', ts: 200 },
        ],
      },
      999,
    );

    const threadA = migrated.threadsByProject['project-a'][0];
    const threadB = migrated.threadsByProject['project-b'][0];
    expect(threadA.id).not.toBe(threadB.id);
    expect(threadA.status).toBe('complete');
    expect(threadA).toMatchObject({ accessMode: 'inherit', reasoningEffort: 'default' });
    expect(migrated.activeThreadByProject).toEqual({
      'project-a': threadA.id,
      'project-b': threadB.id,
    });

    const messagesA = migrated.messagesByThread[threadA.id];
    expect(messagesA).toHaveLength(2);
    expect(messagesA.every((message) => message.threadId === threadA.id)).toBe(true);
    expect(messagesA[0]).toMatchObject({
      id: 'user-a',
      type: 'user',
      role: 'user',
      text: 'Plan the change',
      legacy: { extra: 'keep me' },
    });
    expect(messagesA[1]).toMatchObject({
      id: 'completion-a',
      type: 'completion',
      completion: { taskId: 'task-a', agentName: 'Iris' },
    });
    expect(migrated.messagesByThread[threadB.id][0].threadId).toBe(threadB.id);
  });

  it('returns an empty versioned state for malformed legacy data', () => {
    expect(migrateLegacyChat(null, 123)).toEqual({
      version: 1,
      threadsByProject: {},
      messagesByThread: {},
      activeThreadByProject: {},
    });
  });
});

describe('chat thread state', () => {
  it('drops a single message without touching the rest of the thread', () => {
    const thread = createChatThread('project-a', { title: 'Voice' }, 100);
    appendThreadMessage({ id: 'echo-user', threadId: thread.id, type: 'user', role: 'user', text: 'spoken line', ts: 101 });
    appendThreadMessage({ id: 'real-user', threadId: thread.id, type: 'user', role: 'user', text: 'the real one', ts: 102 });

    expect(removeThreadMessage(thread.id, 'echo-user')).toBe(true);
    const state = get(chatThreadState);
    expect(state.messagesByThread[thread.id].map((m) => m.id)).toEqual(['real-user']);
    expect(removeThreadMessage(thread.id, 'missing')).toBe(false);
    expect(state.messagesByThread[thread.id]).toHaveLength(1);
  });

  it('truncates a thread from an edited message onwards for resend', () => {
    const thread = createChatThread('project-a', { title: 'Resend' }, 100);
    appendThreadMessage({ id: 'u1', threadId: thread.id, type: 'user', role: 'user', text: 'first', ts: 101 });
    appendThreadMessage({ id: 'a1', threadId: thread.id, type: 'agent', role: 'assistant', text: 'reply one', ts: 102 });
    appendThreadMessage({ id: 'u2', threadId: thread.id, type: 'user', role: 'user', text: 'second', ts: 103 });
    appendThreadMessage({ id: 'a2', threadId: thread.id, type: 'agent', role: 'assistant', text: 'reply two', ts: 104 });

    const result = removeThreadMessagesFrom(thread.id, 'u1');
    expect(result).toEqual({ removedIds: ['u1', 'a1', 'u2', 'a2'], removedLaterCount: 3 });
    expect(get(chatThreadState).messagesByThread[thread.id]).toEqual([]);
    expect(removeThreadMessagesFrom(thread.id, 'missing')).toBeNull();
  });

  it('keeps multiple conversations in one project independent', () => {
    const first = createChatThread('project-a', { title: 'Architecture', provider: 'openai', model: 'gpt-4.1' }, 100);
    appendThreadMessage({ id: 'm1', threadId: first.id, type: 'user', role: 'user', text: 'Plan it', ts: 101 });
    const second = createChatThread('project-a', { title: 'Release', provider: 'deepseek', model: 'deepseek-chat' }, 200);
    appendThreadMessage({ id: 'm2', threadId: second.id, type: 'user', role: 'user', text: 'Ship it', ts: 201 });

    expect(clearChatThreadMessages(first.id)).toBe(true);
    const state = get(chatThreadState);
    expect(state.threadsByProject['project-a']).toHaveLength(2);
    expect(state.messagesByThread[first.id]).toEqual([]);
    expect(state.messagesByThread[second.id]).toHaveLength(1);
    expect(state.threadsByProject['project-a'][1]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('keeps active thread and drafts isolated by project', () => {
    const first = createChatThread('project-a', { title: 'First' }, 100);
    const second = createChatThread('project-b', { title: 'Second' }, 200);

    expect(setThreadDraft(first.id, 'draft for A')).toBe(true);
    expect(selectChatThread('project-b', second.id)).toBe(true);
    expect(setThreadDraft(second.id, 'draft for B')).toBe(true);

    const state = get(chatThreadState);
    expect(state.activeThreadByProject).toEqual({ 'project-a': first.id, 'project-b': second.id });
    expect(state.threadsByProject['project-a'][0].draft).toBe('draft for A');
    expect(state.threadsByProject['project-b'][0].draft).toBe('draft for B');
    expect(selectChatThread('project-a', second.id)).toBe(false);
  });

  it('persists independent provider runtime choices per thread', () => {
    const first = createChatThread('project-a', {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      accessMode: 'auto-edits',
      reasoningEffort: 'high',
    }, 100);
    const second = createChatThread('project-a', { provider: 'claude' }, 200);

    expect(first).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      accessMode: 'auto-edits',
      reasoningEffort: 'high',
    });
    expect(second).toMatchObject({ accessMode: 'inherit', reasoningEffort: 'default' });
  });

  it('rejects messages for unknown threads and updates the owning thread status', () => {
    const thread = createChatThread('project-a', {}, 100);
    expect(
      appendThreadMessage({
        id: 'message-a',
        threadId: thread.id,
        type: 'user',
        role: 'user',
        text: 'Start',
        ts: 110,
      }),
    ).toBe(true);
    expect(
      appendThreadMessage({
        id: 'message-unknown',
        threadId: 'missing',
        type: 'user',
        role: 'user',
        text: 'Do not attach',
        ts: 120,
      }),
    ).toBe(false);

    const state = get(chatThreadState);
    expect(state.messagesByThread[thread.id]).toHaveLength(1);
    expect(state.threadsByProject['project-a'][0]).toMatchObject({ status: 'working', lastActivityAt: 110 });
  });

  it('mirrors legacy updates into the explicitly selected thread', () => {
    const first = createChatThread('project-a', { title: 'First' }, 100);
    const second = createChatThread('project-a', { title: 'Second' }, 200);

    expect(appendLegacyChatMessage('project-a', {
      id: 'message-a',
      role: 'assistant',
      text: 'Working',
      ts: 210,
      pending: true,
    }, first.id)).toBe(first.id);
    expect(patchThreadMessage(first.id, 'message-a', { text: 'Done', pending: false })).toBe(true);

    const state = get(chatThreadState);
    expect(state.messagesByThread[first.id]).toHaveLength(1);
    expect(state.messagesByThread[first.id][0]).toMatchObject({ text: 'Done', pending: false });
    expect(state.messagesByThread[second.id]).toHaveLength(0);
    expect(state.threadsByProject['project-a'].find((thread) => thread.id === first.id)?.status).toBe('idle');

    clearProjectThreadMessages('project-a');
    expect(get(chatThreadState).messagesByThread[first.id]).toHaveLength(0);
    expect(get(chatThreadState).messagesByThread[second.id]).toHaveLength(0);
  });

  it('promotes an unanswered inline request to needs-input and clears it when answered', () => {
    const thread = createChatThread('project-a', {}, 100);
    appendLegacyChatMessage('project-a', {
      id: 'request-message',
      role: 'assistant',
      text: '',
      ts: 110,
      inlineRequest: {
        id: 'request-a',
        type: 'text',
        prompt: 'Which environment should I use?',
        taskId: 'task-a',
        sessionId: 7,
      },
    }, thread.id);

    expect(get(chatThreadState).threadsByProject['project-a'][0].status).toBe('needs-input');
    expect(get(chatThreadState).messagesByThread[thread.id][0]).toMatchObject({
      type: 'input',
      inlineRequest: { id: 'request-a', prompt: 'Which environment should I use?' },
    });

    patchThreadMessage(thread.id, 'request-message', {
      inlineRequest: {
        id: 'request-a',
        type: 'text',
        prompt: 'Which environment should I use?',
        taskId: 'task-a',
        sessionId: 7,
        answer: 'staging',
        answeredAt: 120,
      },
    });

    expect(get(chatThreadState).threadsByProject['project-a'][0].status).toBe('working');
    expect(get(chatThreadState).messagesByThread[thread.id][0].inlineRequest?.answer).toBe('staging');
  });

  it('supports lifecycle actions without recreating a deleted last thread', () => {
    const first = createChatThread('project-a', { title: 'First' }, 100);
    expect(renameChatThread(first.id, '  Renamed   thread  ')).toBe(true);
    expect(toggleChatThreadPinned(first.id)).toBe(true);
    expect(get(chatThreadState).threadsByProject['project-a'][0]).toMatchObject({
      title: 'Renamed thread',
      pinned: true,
    });

    expect(deleteChatThread(first.id)).toBe(true);
    const state = get(chatThreadState);
    expect(state.threadsByProject['project-a']).toEqual([]);
    expect(state.activeThreadByProject['project-a']).toBeNull();
    expect(Object.keys(state.messagesByThread)).toEqual([]);
  });

  it('keeps the nearest thread active when deleting one from a project', () => {
    const first = createChatThread('project-a', { title: 'First' }, 100);
    const second = createChatThread('project-a', { title: 'Second' }, 200);
    const third = createChatThread('project-a', { title: 'Third' }, 300);
    selectChatThread('project-a', second.id);

    expect(deleteChatThread(second.id)).toBe(true);
    expect(get(chatThreadState).activeThreadByProject['project-a']).toBe(third.id);
    expect(get(chatThreadState).threadsByProject['project-a'].map((thread) => thread.id)).toEqual([first.id, third.id]);
  });

  it('keeps file attachments on the user message in the selected thread', () => {
    const thread = createChatThread('project-a', {}, 100);
    appendThreadMessage({
      id: 'attachment-message',
      threadId: thread.id,
      type: 'user',
      role: 'user',
      text: 'Review this',
      ts: 110,
      attachments: [{ id: 'file-a', name: 'notes.md', type: 'text/markdown', size: 42, text: '# Notes' }],
    });

    expect(get(chatThreadState).messagesByThread[thread.id][0].attachments).toEqual([
      { id: 'file-a', name: 'notes.md', type: 'text/markdown', size: 42, text: '# Notes' },
    ]);
  });

  it('routes legacy task updates to the matching thread instead of the first thread', () => {
    const first = createChatThread('project-a', { title: 'First' }, 100);
    const second = createChatThread('project-a', { title: 'Second', taskId: 'task-b' }, 200);
    selectChatThread('project-a', first.id);

    expect(appendLegacyChatMessage('project-a', {
      id: 'task-b-update',
      role: 'assistant',
      text: 'Task B finished',
      ts: 210,
      completion: {
        status: 'done',
        agentName: 'Agent B',
        taskTitle: 'Task B',
        elapsedSec: 2,
        taskId: 'task-b',
      },
    })).toBe(second.id);

    expect(get(chatThreadState).messagesByThread[first.id]).toHaveLength(0);
    expect(get(chatThreadState).messagesByThread[second.id]).toHaveLength(1);
  });

  it('summarizes a new thread with AI instead of its first line', async () => {
    invoke.mockResolvedValue('Auth review plan');
    const thread = createChatThread('project-a', { provider: 'ollama' }, 100);
    appendThreadMessage({
      id: 'message-a',
      threadId: thread.id,
      type: 'user',
      role: 'user',
      text: '  Review the authentication flow\nwith extra detail',
      ts: 110,
    });

    await vi.waitFor(() => {
      expect(get(chatThreadState).threadsByProject['project-a'][0].title).toBe('Auth review plan');
    });
    expect(get(chatThreadState).threadsByProject['project-a'][0].title).not.toBe('Review the authentication flow');
  });

  it('keeps the AI summary when a message is edited', async () => {
    invoke.mockResolvedValue('Auth flow review');
    const thread = createChatThread('project-a', { provider: 'ollama' }, 100);
    appendThreadMessage({
      id: 'message-a',
      threadId: thread.id,
      type: 'user',
      role: 'user',
      text: '# Review **the** authentication flow',
      ts: 110,
    });

    await vi.waitFor(() => {
      expect(get(chatThreadState).threadsByProject['project-a'][0].title).toBe('Auth flow review');
    });

    expect(editChatMessage(thread.id, 'message-a', 'Plan the database migration')).toBe(true);
    expect(get(chatThreadState).messagesByThread[thread.id][0].text).toBe('Plan the database migration');
    expect(get(chatThreadState).threadsByProject['project-a'][0].title).toBe('Auth flow review');
  });

  it('back-fills AI summaries for placeholder and first-line titles only', async () => {
    const placeholder = createChatThread('project-a', { provider: 'ollama' }, 100);
    appendThreadMessage({ id: 'u1', threadId: placeholder.id, type: 'user', role: 'user', text: 'Plan the change', ts: 110 });
    const firstLine = createChatThread('project-a', { title: 'Review auth', provider: 'ollama' }, 200);
    appendThreadMessage({ id: 'u2', threadId: firstLine.id, type: 'user', role: 'user', text: '  Review auth\nin depth', ts: 210 });
    const manual = createChatThread('project-a', { title: 'Release day prep', provider: 'ollama' }, 300);
    appendThreadMessage({ id: 'u3', threadId: manual.id, type: 'user', role: 'user', text: 'Release day prep detail', ts: 310 });

    expect(get(chatThreadState).threadsByProject['project-a'].map((thread) => thread.title)).toEqual([
      'New thread',
      'Review auth',
      'Release day prep',
    ]);

    invoke.mockResolvedValue('Migrated chat summary');
    await repairThreadSummaries();

    const threads = get(chatThreadState).threadsByProject['project-a'];
    expect(threads.find((thread) => thread.id === placeholder.id)?.title).toBe('Migrated chat summary');
    expect(threads.find((thread) => thread.id === firstLine.id)?.title).toBe('Migrated chat summary');
    expect(threads.find((thread) => thread.id === manual.id)?.title).toBe('Release day prep');
  });

  it('does not recreate a thread when late output targets a deleted thread', () => {
    const thread = createChatThread('project-a', {}, 100);
    expect(deleteChatThread(thread.id)).toBe(true);
    expect(appendLegacyChatMessage('project-a', {
      id: 'late-message',
      role: 'assistant',
      text: 'The old agent finished.',
      ts: 120,
    }, thread.id)).toBeNull();
    expect(get(chatThreadState).threadsByProject['project-a']).toEqual([]);
  });
});
