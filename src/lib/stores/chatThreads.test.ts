import { beforeEach, describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  appendLegacyChatMessage,
  appendThreadMessage,
  chatThreadState,
  clearProjectThreadMessages,
  createChatThread,
  deleteChatThread,
  patchThreadMessage,
  migrateLegacyChat,
  renameChatThread,
  resetChatThreadsForTests,
  selectChatThread,
  setThreadDraft,
  toggleChatThreadPinned,
} from './chatThreads';

beforeEach(() => {
  resetChatThreadsForTests();
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

  it('supports lifecycle actions and selects a fresh thread after deleting the last one', () => {
    const first = createChatThread('project-a', { title: 'First' }, 100);
    expect(renameChatThread(first.id, '  Renamed   thread  ')).toBe(true);
    expect(toggleChatThreadPinned(first.id)).toBe(true);
    expect(get(chatThreadState).threadsByProject['project-a'][0]).toMatchObject({
      title: 'Renamed thread',
      pinned: true,
    });

    expect(deleteChatThread(first.id)).toBe(true);
    const state = get(chatThreadState);
    const replacement = state.threadsByProject['project-a'][0];
    expect(replacement.title).toBe('General');
    expect(state.activeThreadByProject['project-a']).toBe(replacement.id);
    expect(state.messagesByThread[replacement.id]).toEqual([]);
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
});
