import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { addSideChatToDraft, autoSettleStaleThreads, AUTO_SETTLE_IDLE_MS, forkChatThreadFrom, getChatThread, resetChatThreadsForTests, chatThreadState } from './chatThreads';
import type { ChatThread } from './chatThreads';
import type { ChatMessage } from '$lib/types/chat';

vi.mock('$lib/services/claude-agent-sdk', () => ({
  forkClaudeSession: vi.fn().mockResolvedValue({ sessionId: 'forked_sdk_session' }),
}));

import { forkClaudeSession } from '$lib/services/claude-agent-sdk';

const mockForkClaudeSession = forkClaudeSession as ReturnType<typeof vi.fn>;

const baseThread = (overrides: Partial<ChatThread> = {}): ChatThread => ({
  id: 't1',
  projectId: 'p1',
  title: 'Test',
  agentName: null,
  agentPreset: null,
  provider: null,
  model: null,
  accessMode: 'inherit',
  workMode: 'build',
  standalone: false,
  pinned: false,
  archived: false,
  order: undefined,
  forkOfThreadId: null,
  snoozedUntil: undefined,
  settledAt: undefined,
  unreadCount: 0,
  draft: '',
  contextUsage: undefined,
  turnPlan: undefined,
  handoffs: [],
  nativeAcpSessionId: null,
  nativeAcpCommand: null,
  nativeAcpModel: null,
  nativeAcpCapabilities: null,
  claudeSdkSessionId: null,
  agentCheckpoint: undefined,
  agentBudgets: undefined,
  worktree: null,
  pullRequest: null,
  parentThreadId: null,
  subagentTaskId: null,
  subagentRole: null,
  status: 'idle',
  createdAt: Date.now() - 100000,
  updatedAt: Date.now() - 100000,
  lastActivityAt: Date.now() - 100000,
  turnEndedAt: undefined,
  taskId: null,
  sessionId: null,
  reasoningEffort: 'default',
  ...overrides,
});

describe('autoSettleStaleThreads', () => {
  it('does not settle pinned threads', () => {
    const now = Date.now();
    const t = baseThread({ pinned: true, status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });

  it('does not settle working threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'working', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });

  it('does not settle recently active threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS / 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0);
    expect(remaining).toHaveLength(1);
  });

  it('settles stale idle threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(1);
    expect(remaining[0].settledAt).toBe(now);
    expect(remaining[0].snoozedUntil).toBeUndefined();
  });

  it('preserves already settled threads', () => {
    const now = Date.now();
    const t = baseThread({ status: 'idle', lastActivityAt: now - AUTO_SETTLE_IDLE_MS * 2, settledAt: now - 1000 });
    const { settled, remaining } = autoSettleStaleThreads([t], now);
    expect(settled).toHaveLength(0); // already settled
    expect(remaining[0].settledAt).toBe(now - 1000);
  });
});

beforeEach(() => {
  resetChatThreadsForTests();
  vi.clearAllMocks();
});

describe('forkChatThreadFrom', () => {
  it('forks a thread without a Claude SDK session', async () => {
    const source = baseThread({ id: 'source-1', claudeSdkSessionId: null });
    chatThreadState.set({
      version: 1,
      threadsByProject: { p1: [source] },
      messagesByThread: { 'source-1': [{ id: 'm1', threadId: 'source-1', role: 'user', type: 'user', text: 'hi', ts: Date.now() }] },
      activeThreadByProject: {},
    });
    const fork = await forkChatThreadFrom('source-1');
    expect(fork).not.toBeNull();
    expect(fork!.forkOfThreadId).toBe('source-1');
    expect(fork!.claudeSdkSessionId).toBeNull();
    expect(mockForkClaudeSession).not.toHaveBeenCalled();
  });

  it('natively forks the Claude SDK session when present', async () => {
    const source = baseThread({ id: 'source-2', claudeSdkSessionId: 'sdk_sess_1' });
    chatThreadState.set({
      version: 1,
      threadsByProject: { p1: [source] },
      messagesByThread: { 'source-2': [{ id: 'm1', threadId: 'source-2', role: 'user', type: 'user', text: 'hi', ts: Date.now() }] },
      activeThreadByProject: {},
    });
    const fork = await forkChatThreadFrom('source-2');
    expect(fork).not.toBeNull();
    expect(mockForkClaudeSession).toHaveBeenCalledWith('sdk_sess_1', { dir: 'p1', title: expect.any(String) });
    expect(fork!.claudeSdkSessionId).toBe('forked_sdk_session');
    const stored = getChatThread(fork!.id);
    expect(stored?.claudeSdkSessionId).toBe('forked_sdk_session');
  });

  it('includes the selected message and makes the fork active', async () => {
    const source = baseThread({ id: 'source-3', claudeSdkSessionId: null });
    chatThreadState.set({
      version: 1,
      threadsByProject: { p1: [source] },
      messagesByThread: { 'source-3': [
        { id: 'm1', threadId: 'source-3', role: 'user', type: 'user', text: 'first', ts: 1 },
        { id: 'm2', threadId: 'source-3', role: 'assistant', type: 'assistant', text: 'second', ts: 2 },
      ] },
      activeThreadByProject: { p1: 'source-3' },
    });
    const fork = await forkChatThreadFrom('source-3', 'm2');
    expect(fork).not.toBeNull();
    expect(get(chatThreadState).messagesByThread[fork!.id].map((message) => message.text)).toEqual(['first', 'second']);
    expect(get(chatThreadState).activeThreadByProject.p1).toBe(fork!.id);
  });
});

describe('addSideChatToDraft', () => {
  it('quotes the latest answer into the parent composer and leaves both transcripts alone', () => {
    const message = (id: string, role: 'user' | 'assistant', text: string) => ({ id, threadId: 'side', role, type: role, text, ts: 1 }) as ChatMessage;
    chatThreadState.set({
      version: 1,
      threadsByProject: { p1: [
        baseThread({ id: 'main', status: 'working', draft: 'Also:' }),
        baseThread({ id: 'side', parentThreadId: 'main' }),
      ] },
      messagesByThread: { main: [], side: [message('m1-sidecopy-x', 'assistant', 'from the parent')] },
      activeThreadByProject: { p1: 'side' },
    });
    expect(addSideChatToDraft('side')).toBe(false);

    chatThreadState.update((state) => ({
      ...state,
      messagesByThread: { ...state.messagesByThread, side: [...state.messagesByThread.side, message('q', 'user', 'which port?'), message('a', 'assistant', 'Port 1420.\nSee vite.')] },
    }));
    expect(addSideChatToDraft('side')).toBe(true);
    expect(getChatThread('main')).toMatchObject({ status: 'working', draft: 'Also:\n\nSide chat answer to “which port?”:\n> Port 1420.\n> See vite.\n\n' });
    expect(get(chatThreadState).messagesByThread.main).toEqual([]);
    expect(getChatThread('side')).toBeTruthy();
    expect(get(chatThreadState).activeThreadByProject.p1).toBe('main');
  });
});
