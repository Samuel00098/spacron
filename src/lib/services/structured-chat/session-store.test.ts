import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatAutoNames } from '$lib/stores/chatViewSettings';

const env = vi.hoisted(() => {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage, addEventListener: () => {} };
  return { data };
});

const fake = vi.hoisted(() => {
  type Listener = () => void;
  const states = new Map<number, any>();
  const listeners = new Set<Listener>();
  const providerFor = (agent: string, label: string) => ({
    agent,
    label,
    get: (id: number) => states.get(id) ?? null,
    subscribe: (listener: Listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    start: vi.fn(async (id: number) => {
      states.set(id, { status: 'ready', error: null, items: [], models: [], model: null, effort: null, access: 'ask', threadId: agent === 'codex' ? 'thread-9' : `${agent}-thread-9`, approvals: [], contextUsed: null, contextWindow: null });
      listeners.forEach((l) => l());
    }),
    close: vi.fn(async (id: number) => { states.delete(id); listeners.forEach((l) => l()); }),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    answerApproval: vi.fn(async (id: number, requestId: string | number) => {
      const s = states.get(id);
      states.set(id, { ...s, approvals: s.approvals.filter((a: { requestId: string | number }) => a.requestId !== requestId) });
      listeners.forEach((l) => l());
    }),
    conversationId: (id: number) => states.get(id)?.threadId ?? null,
  });
  const provider = providerFor('codex', 'Codex');
  const claudeProvider = providerFor('claude', 'Claude Code');
  const set = (id: number, patch: Record<string, unknown>) => {
    states.set(id, { ...(states.get(id) ?? {}), ...patch });
    listeners.forEach((l) => l());
  };
  return { provider, claudeProvider, states, set };
});

const terminal = vi.hoisted(() => ({ sessions: [] as { id: number; isRunning: boolean; agentPreset?: string | null; title?: string }[], nextPane: 50 }));

vi.mock('$lib/stores/workspace', () => ({}));
vi.mock('$lib/react/useStore', () => ({ useStore: () => ({}) }));
vi.mock('$lib/stores/agentAccounts', () => ({
  accountsState: { subscribe: (fn: (v: unknown) => void) => { fn({ accounts: [{ provider: 'codex', id: 'work', active: true }] }); return () => {}; } },
  activeAccount: (state: { accounts: { provider: string; id: string; active: boolean }[] }, provider: string) =>
    state.accounts.find((a) => a.provider === provider && a.active) ?? null,
}));
vi.mock('$lib/stores/terminal', () => {
  return {
    sessions: { subscribe: (fn: (v: unknown) => void) => { fn(terminal.sessions); return () => {}; } },
    allProjectSessions: { subscribe: (fn: (v: unknown[]) => void) => { fn([]); return () => {}; } },
    getSessionRoot: () => '/repo',
    getActiveTerminalProjectId: () => 'proj',
    createTerminalSession: vi.fn(async () => terminal.nextPane++),
    updateSessionTitle: vi.fn(),
    getAgentDisplayName: (preset: string) => preset,
    activeSessionId: { subscribe: (fn: (v: unknown) => void) => { fn(null); return () => {}; } },
    setActiveSession: vi.fn(),
  };
});
vi.mock('./panes', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  const structuredChatPanes = writable<Record<number, string>>({});
  const structuredChatHistory = writable<Record<number, unknown[]>>({});
  const newChats = new Set<number>();
  return {
    structuredChatPanes,
    structuredChatHistory,
    isNewStructuredChatPane: (id: number) => newChats.has(id),
    markStructuredChatPane: (id: number, agent: string, _preset?: string, origin?: 'chat') => {
      if (origin === 'chat') newChats.add(id);
      else newChats.delete(id);
      structuredChatPanes.update((p) => ({ ...p, [id]: agent }));
    },
    forgetStructuredChatPane: (id: number) => structuredChatPanes.update((p) => { const n = { ...p }; delete n[id]; return n; }),
    setStructuredChatHistory: (id: number, items: unknown[]) => structuredChatHistory.update((h) => ({ ...h, [id]: items })),
    structuredChatPreset: () => 'codex',
    commandForStructuredAgent: (agent: string) => (agent === 'antigravity' ? 'agy' : agent === 'cursor' ? 'cursor-agent' : agent),
    markStructuredChatUnread: vi.fn(),
  };
});
vi.mock('./registry', () => ({
  structuredChatProvider: (agent: string) => (agent === 'codex' ? fake.provider : agent === 'claude' ? fake.claudeProvider : null),
}));
// The store rebuilds a pane's subagent panel from the record; its engine pulls
// in the terminal and MCP bridges, which this test does not stand up.
vi.mock('./mcp-subagents', () => ({ restoreMcpSubagents: vi.fn() }));
const titles = vi.hoisted(() => ({ provider: vi.fn(async () => 'From provider'), agent: vi.fn(async (_command: string, _args?: unknown) => '') }));
vi.mock('$lib/stores/chatThreads', () => ({ generateAiThreadTitle: titles.provider, cleanGeneratedTitle: (raw: string) => raw.trim() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: titles.agent }));

import { get } from '$lib/stores/storeCompat';
import * as panes from './panes';
import { clearPaneContext, paneWireText } from '$lib/services/side-chat-context';
import {
  __resetSessionStoreForTests,
  adoptConvertedPane,
  answerStructuredApproval,
  claimClosedChat,
  claimConvertedSession,
  clearStructuredConversation,
  flushSessionStore,
  forkStructuredSession,
  approvalReceipts,
  archiveStructuredRecord,
  archiveStructuredSession,
  clearStructuredGoal,
  setStructuredGoal,
  hydrateStructuredHistory,
  listArchivedSessions,
  listStructuredSessions,
  replayStructuredEvents,
  restoreStructuredInChat,
  resumeStructuredSessionInPane,
  rewindStructuredSession,
  recordForPane,
  reconnectStructuredSession,
  bindStructuredAccount,
  restoreStructuredSessions,
  startSessionStore,
  structuredSessionHistory,
  structuredSessions,
  attachStandaloneRecordToPane,
  createStandaloneStructuredRecord,
  listStandaloneStructuredRecords,
  updateStandaloneStructuredRecord,
  deleteStandaloneStructuredRecord,
  migrateLegacyStandaloneRecords,
  recordItemsSnapshot,
  switchStructuredAgent,
} from './session-store';

const tick = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('structured session store', () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    panes.structuredChatPanes.set({});
    fake.states.clear();
    env.data.clear();
    terminal.sessions = [];
    startSessionStore();
  });

  it('creates a record for a new structured pane and journals its conversation', async () => {
    terminal.sessions = [{ id: 1, isRunning: true }];
    fake.set(1, { status: 'ready', error: null, items: [], models: [], model: 'gpt', effort: null, access: 'ask', threadId: null, approvals: [], contextUsed: null, contextWindow: null });
    panes.markStructuredChatPane(1, 'codex');
    const record = recordForPane(1)!;
    expect(record.origin).toBe('chat');
    expect(record.projectId).toBe('proj');

    fake.set(1, { status: 'working', items: [{ id: 'u', kind: 'user', text: 'hello' }], threadId: 'thread-1' });
    await tick();
    fake.set(1, { status: 'ready', items: [{ id: 'u', kind: 'user', text: 'hello' }, { id: 'a', kind: 'assistant', text: 'hi there' }] });
    await tick();

    const updated = get(structuredSessions)[record.id];
    expect(updated.nativeSessionId).toBe('thread-1');
    expect(updated.turnId).toBe(`${record.id}:t1`);
    expect(updated.lastSeq).toBeGreaterThan(0);
    expect(structuredSessionHistory(record.id).items.map((i) => i.text)).toEqual(['hello', 'hi there']);

    flushSessionStore();
    expect(env.data.get('spacron_structured_journal:' + record.id)).toContain('hi there');
  });

  it('marks a record closed when the pane is closed, and keeps it open across shutdown', async () => {
    fake.set(2, { status: 'ready', error: null, items: [], models: [], model: null, effort: null, access: 'ask', threadId: 't', approvals: [], contextUsed: null, contextWindow: null });
    panes.markStructuredChatPane(2, 'codex');
    const id = recordForPane(2)!.id;
    panes.forgetStructuredChatPane(2);
    expect(get(structuredSessions)[id].lifecycle).toBe('closed');
  });

  it('reclaims a closed launcher chat once for the same worktree and account', () => {
    terminal.sessions = [{ id: 42, isRunning: true, agentPreset: 'codex' }];
    fake.set(42, { status: 'ready', items: [{ id: 'u', kind: 'user', text: 'hello' }], threadId: 'thread-42', approvals: [], models: [], model: null, effort: null, access: 'ask', contextUsed: null, contextWindow: null });
    panes.markStructuredChatPane(42, 'codex', 'codex', 'chat');
    const record = recordForPane(42)!;
    expect(record.origin).toBe('chat');
    terminal.sessions = [];
    panes.forgetStructuredChatPane(42);
    expect(claimClosedChat('proj', 'codex', 'codex', record.cwd, 'other')).toBeNull();
    expect(claimClosedChat('proj', 'codex', 'codex', '/another/worktree')).toBeNull();
    expect(claimClosedChat('proj', 'codex', 'codex', record.cwd)?.id).toBe(record.id);
    expect(claimClosedChat('proj', 'codex', 'codex', record.cwd)).toBeNull();
  });

  it('restores an open chat record into a new pane with its history, resuming the native id', async () => {
    fake.set(3, { status: 'ready', error: null, items: [{ id: 'u', kind: 'user', text: 'remember me' }], models: [], model: 'gpt', effort: 'high', access: 'ask', threadId: 'thread-3', approvals: [], contextUsed: null, contextWindow: null });
    panes.markStructuredChatPane(3, 'codex');
    await tick();
    const id = recordForPane(3)!.id;
    flushSessionStore();

    // Simulate an app restart: memory is gone, storage remains.
    const saved = new Map(env.data);
    __resetSessionStoreForTests();
    panes.structuredChatPanes.set({});
    fake.states.clear();
    for (const [key, value] of saved) env.data.set(key, value);
    const { structuredSessions: fresh } = await import('./session-store');
    const records = JSON.parse(env.data.get('spacron_structured_sessions')!);
    const olderId = 'older-chat';
    records[olderId] = {
      ...records[id],
      id: olderId,
      nativeSessionId: 'older-thread',
      updatedAt: records[id].updatedAt - 1,
    };
    fresh.set(records);

    expect(await restoreStructuredSessions('proj')).toBe(1);
    const pane = Number(Object.keys(get(panes.structuredChatPanes))[0]);
    expect(recordForPane(pane)?.id).toBe(id);
    expect(fake.provider.start).toHaveBeenLastCalledWith(pane, '/repo', { resumeId: 'thread-3', access: 'ask', accountId: 'work' });
    expect((get(panes.structuredChatHistory)[pane] as { text: string }[]).map((i) => i.text)).toEqual(['remember me']);
    expect(get(fresh)[olderId].lifecycle).toBe('closed');
    // Not restored twice.
    expect(await restoreStructuredSessions('proj')).toBe(0);
  });

  const ready = (patch: Record<string, unknown> = {}) => ({ status: 'ready', error: null, items: [], models: [], model: null, effort: null, access: 'ask', threadId: 't', approvals: [], contextUsed: null, contextWindow: null, ...patch });

  it.each([false, true])('only replaces a missing Codex rollout when the journal is empty (has message: %s)', async (hasMessage) => {
    const pane = 43;
    const threadId = 'thread-missing';
    fake.set(pane, ready({ threadId, items: hasMessage ? [{ id: 'u', kind: 'user', text: 'Keep this message' }] : [] }));
    panes.markStructuredChatPane(pane, 'codex');
    fake.provider.start.mockImplementationOnce(async (id) => {
      fake.set(id, ready({ status: 'failed', threadId: null, error: 'no rollout found for thread id thread-missing' }));
    });

    expect(await reconnectStructuredSession(pane)).toBe(!hasMessage);
    if (hasMessage) {
      expect(fake.provider.start).toHaveBeenLastCalledWith(pane, '/repo', { access: 'ask', accountId: 'work', resumeId: threadId });
      expect(recordForPane(pane)?.nativeSessionId).toBe(threadId);
      expect(get(panes.structuredChatHistory)[pane]).toEqual([expect.objectContaining({ text: 'Keep this message' })]);
    } else {
      expect(fake.provider.start).toHaveBeenLastCalledWith(pane, '/repo', { access: 'ask', accountId: 'work', resumeId: null });
      expect(recordForPane(pane)?.restoredMode).toBe('fresh');
    }
  });

  it('records the active account and journals an approval decision exactly once', async () => {
    fake.set(4, ready({ approvals: [{ requestId: 11, kind: 'command', title: 'Run?', detail: 'ls' }] }));
    panes.markStructuredChatPane(4, 'codex');
    const record = recordForPane(4)!;
    expect(record.accountId).toBe('work');
    await answerStructuredApproval(4, 11, 'decline');
    await tick();
    const events = replayStructuredEvents(record.id, 0).events.filter((e) => e.type.startsWith('approval.'));
    expect(events.map((e) => [e.type, e.payload.decision ?? null])).toEqual([
      ['approval.requested', null],
      ['approval.resolved', 'decline'],
    ]);
  });

  it('persists explicit resume ownership instead of the globally selected account', async () => {
    fake.set(41, ready({ threadId: 'owned-thread' }));
    panes.markStructuredChatPane(41, 'codex');
    bindStructuredAccount(41, 'original', 'original@example.com');
    await tick();
    expect(recordForPane(41)).toMatchObject({ accountId: 'original', accountLabel: 'original@example.com' });
    flushSessionStore();
    expect(env.data.get('spacron_structured_sessions')).toContain('original@example.com');
  });

  it('clears into a new conversation and resumes an earlier record in the same pane', async () => {
    fake.set(5, ready({ items: [{ id: 'u', kind: 'user', text: 'first chat' }], threadId: 'thread-old' }));
    panes.markStructuredChatPane(5, 'codex');
    await tick();
    const first = recordForPane(5)!.id;

    expect(await clearStructuredConversation(5)).toBe(true);
    await tick();
    expect(get(structuredSessions)[first].nativeSessionId).toBe('thread-9');
    expect(structuredSessionHistory(first).items).toEqual([]);

    // Make a second, detached record of the same provider to resume.
    fake.set(6, ready({ items: [{ id: 'v', kind: 'user', text: 'second chat' }], threadId: 'thread-6' }));
    panes.markStructuredChatPane(6, 'codex');
    await tick();
    const second = recordForPane(6)!.id;
    terminal.sessions = [{ id: 6, isRunning: true }];
    panes.forgetStructuredChatPane(6);
    expect(get(structuredSessions)[second].lifecycle).toBe('detached');

    expect(await resumeStructuredSessionInPane(5, second)).toBe(true);
    expect(recordForPane(5)?.id).toBe(second);
    expect(fake.provider.start).toHaveBeenLastCalledWith(5, '/repo', { resumeId: 'thread-6', access: 'ask', accountId: 'work' });
    expect((get(panes.structuredChatHistory)[5] as { text: string }[]).map((i) => i.text)).toEqual(['second chat']);
    expect(get(structuredSessions)[first].lifecycle).toBe('detached');
  });

  it('restores a converted CLI pane as chat, or adopts it when it came back as the CLI', async () => {
    terminal.sessions = [{ id: 7, isRunning: true, agentPreset: 'codex' }];
    fake.set(7, ready({ threadId: 'thread-7', items: [{ id: 'w', kind: 'assistant', text: 'converted' }] }));
    panes.markStructuredChatPane(7, 'codex');
    await tick();
    const record = recordForPane(7)!;
    expect(record.origin).toBe('converted');

    // Restart: the pane is gone from memory, the record says it was in chat.
    __resetSessionStoreForTests();
    panes.structuredChatPanes.set({});
    structuredSessions.set({ [record.id]: { ...record, lifecycle: 'ready', view: 'chat' } });
    startSessionStore();
    expect(claimConvertedSession('proj', 'codex', '/repo/')).toMatchObject({ id: record.id });
    expect(claimConvertedSession('proj', 'codex', '/repo')).toBeNull(); // already claimed
    expect(await restoreStructuredInChat(70, get(structuredSessions)[record.id])).toBe(true);
    expect(recordForPane(70)?.id).toBe(record.id);

    // The other path: the CLI was relaunched instead.
    __resetSessionStoreForTests();
    panes.structuredChatPanes.set({});
    structuredSessions.set({ [record.id]: { ...record, lifecycle: 'detached', view: 'terminal' } });
    startSessionStore();
    const claimed = claimConvertedSession('proj', 'codex', '/repo')!;
    adoptConvertedPane(71, claimed.id);
    fake.set(71, ready({ threadId: 'thread-7' }));
    terminal.sessions = [{ id: 71, isRunning: true, agentPreset: 'codex' }];
    panes.markStructuredChatPane(71, 'codex');
    expect(recordForPane(71)?.id).toBe(record.id);
  });

  it('hydrates a mounted view from the journal without duplicating live items', async () => {
    fake.set(8, ready({ items: [{ id: 'a', kind: 'user', text: 'old' }, { id: 'b', kind: 'assistant', text: 'live' }] }));
    panes.markStructuredChatPane(8, 'codex');
    await tick();
    panes.setStructuredChatHistory(8, []);
    fake.set(8, ready({ items: [{ id: 'b', kind: 'assistant', text: 'live' }] }));
    expect(hydrateStructuredHistory(8)).toBe(true);
    expect((get(panes.structuredChatHistory)[8] as { id: string }[]).map((i) => i.id)).toEqual(['a']);
  });

  it('forks a session with journal history and links lineage', async () => {
    terminal.sessions = [{ id: 9, isRunning: true }];
    fake.set(9, ready({ threadId: 'thread-9', items: [{ id: 'u1', kind: 'user', text: 'base message' }] }));
    panes.markStructuredChatPane(9, 'codex');
    await tick();
    const current = recordForPane(9)!;
    const forked = await forkStructuredSession(9, { title: 'Branch 1' });
    expect(forked).not.toBeNull();
    expect(forked?.forkedFrom).toBe(current.id);
    expect(forked?.title).toBe('Branch 1');
    expect(get(structuredSessions)[forked!.id]).toBeDefined();
  });

  it('sends a fork its history, or forks the provider session, on first open', async () => {
    terminal.sessions = [{ id: 21, isRunning: true }];
    fake.set(21, ready({ threadId: 'thread-21', items: [{ id: 'u1', kind: 'user', text: 'codeword PELICAN' }] }));
    panes.markStructuredChatPane(21, 'codex');
    await tick();

    // No native fork: the history rides on the first prompt.
    const copy = (await forkStructuredSession(21))!;
    expect(copy.seedContext).toBe(true);
    await resumeStructuredSessionInPane(21, copy.id);
    expect(paneWireText(21, 'which word?').text).toContain('codeword PELICAN');
    clearPaneContext(21);

    // A provider that forks at start is given the source id and no transcript.
    terminal.sessions = [{ id: 21, isRunning: true }, { id: 22, isRunning: true }];
    fake.set(22, ready({ threadId: 'thread-22' }));
    panes.markStructuredChatPane(22, 'codex');
    await tick();
    Object.assign(fake.provider, { capabilities: { fork: true }, fork: async () => ({ nativeSessionId: null, forkSourceId: 'source-21' }) });
    try {
      fake.set(22, ready({ items: [{ id: 'u1', kind: 'user', text: 'codeword PELICAN' }] }));
      await tick();
      const native = (await forkStructuredSession(22))!;
      expect(native).toMatchObject({ forkSourceId: 'source-21', seedContext: false });
      fake.provider.start.mockClear();
      await resumeStructuredSessionInPane(22, native.id);
      expect(fake.provider.start).toHaveBeenCalledWith(22, expect.anything(), expect.objectContaining({ resumeId: 'source-21', forkSession: true }));
      expect(paneWireText(22, 'which word?').text).toBe('which word?');
    } finally {
      delete (fake.provider as Record<string, unknown>).capabilities;
      delete (fake.provider as Record<string, unknown>).fork;
    }
  });

  it('rewinds a session by rolling back journal to previous user turn', async () => {
    terminal.sessions = [{ id: 10, isRunning: true }];
    fake.set(10, ready({
      threadId: 'thread-10',
      items: [
        { id: 'u1', kind: 'user', text: 'first user turn' },
        { id: 'a1', kind: 'assistant', text: 'first reply' },
        { id: 'u2', kind: 'user', text: 'second user turn' },
        { id: 'a2', kind: 'assistant', text: 'second reply' },
      ],
    }));
    panes.markStructuredChatPane(10, 'codex');
    await tick();
    const ok = await rewindStructuredSession(10);
    expect(ok).toBe(true);
    expect((get(panes.structuredChatHistory)[10] as { id: string }[]).map((i) => i.id)).toEqual(['u1', 'a1']);
  });

  it('leaves a chat unnamed when automatic chat names are turned off', async () => {
    chatAutoNames.set(false);
    try {
      terminal.sessions = [{ id: 15, isRunning: true }];
      fake.set(15, ready());
      panes.markStructuredChatPane(15, 'codex');
      await tick();
      const record = recordForPane(15)!;

      fake.set(15, ready({ items: [{ id: 'u', kind: 'user', text: 'Fix the flaky test' }] }));
      await tick();
      expect(get(structuredSessions)[record.id].title).not.toBe('Fix the flaky test');
      expect(get(structuredSessions)[record.id].titleAuto).toBe(true);
    } finally {
      chatAutoNames.set(true);
    }
  });

  it.each([
    [-90, 'TITLE: Flaky test repair', 'Flaky test repair'],
    [-91, 'You have hit your usage limit.', 'Please fix the flaky test in CI'],
  ])('titles a standalone chat with its own agent (pane %i)', async (pane, reply, expected) => {
    titles.agent.mockImplementation(async (command: string) => (command === 'agent_cli_generate_commit_message' ? reply : ''));
    const created = createStandaloneStructuredRecord({ provider: 'codex' });
    fake.set(pane, ready());
    await attachStandaloneRecordToPane(pane, created.id, { startProvider: true });
    await tick();
    fake.set(pane, ready({ items: [{ id: 'u', kind: 'user', text: 'Please fix the flaky test in CI' }] }));
    await tick();
    expect(titles.agent).toHaveBeenCalledWith('agent_cli_generate_commit_message', expect.objectContaining({ agent: 'codex' }));
    expect(titles.provider).not.toHaveBeenCalled();
    expect(get(structuredSessions)[created.id].title).toBe(expected);
  });

  it('does not reload the journal beside a running standalone agent', async () => {
    const created = createStandaloneStructuredRecord({ provider: 'codex' });
    fake.set(-92, ready());
    await attachStandaloneRecordToPane(-92, created.id, { startProvider: true });
    await tick();
    fake.set(-92, ready({ items: [{ id: 'u', kind: 'user', text: 'once only' }] }));
    await tick();
    await attachStandaloneRecordToPane(-92, created.id, { startProvider: false });
    await attachStandaloneRecordToPane(-92, created.id, { startProvider: true });
    expect(get(panes.structuredChatHistory)[-92] ?? []).toEqual([]);
  });

  it('names a chat from its first prompt but never renames a CLI conversation switched into chat', async () => {
    terminal.sessions = [{ id: 11, isRunning: true }];
    fake.set(11, ready());
    panes.markStructuredChatPane(11, 'codex');
    await tick();
    const chat = recordForPane(11)!;
    expect(chat.origin).toBe('chat');
    expect(get(structuredSessions)[chat.id].titleAuto).toBe(true);

    fake.set(11, ready({ items: [{ id: 'u', kind: 'user', text: 'Fix the flaky test\nand rerun it' }] }));
    await tick();
    expect(get(structuredSessions)[chat.id].title).toBe('Fix the flaky test');
    expect(get(structuredSessions)[chat.id].titleAuto).toBe(false);

    // A CLI pane switched into chat keeps the title the terminal gave it.
    terminal.sessions = [{ id: 12, isRunning: true, agentPreset: 'codex', title: 'my cli run' }];
    fake.set(12, ready());
    panes.markStructuredChatPane(12, 'codex');
    await tick();
    const converted = recordForPane(12)!;
    expect(converted.origin).toBe('converted');
    expect(get(structuredSessions)[converted.id].titleAuto).toBe(false);

    fake.set(12, ready({ items: [{ id: 'u2', kind: 'user', text: 'a new prompt that must not become the title' }] }));
    await tick();
    expect(get(structuredSessions)[converted.id].title).toBe('my cli run');
  });

  it('mirrors a goal and keeps an answered card as a receipt', async () => {
    terminal.sessions = [{ id: 14, isRunning: true }];
    fake.set(14, ready({ approvals: [{ requestId: 21, kind: 'other', title: 'Allow this agent action?', detail: 'ls', options: [{ id: 'proceed_once', label: 'Once', kind: 'allow_once' }] }] }));
    panes.markStructuredChatPane(14, 'codex');
    await tick();
    const record = recordForPane(14)!;

    expect(setStructuredGoal(14, 'Ship the fix')).toBe(true);
    expect(get(structuredSessions)[record.id].goal).toMatchObject({ text: 'Ship the fix', state: 'active' });
    expect(clearStructuredGoal(14)).toBe(true);
    expect(get(structuredSessions)[record.id].goal).toBeNull();

    await answerStructuredApproval(14, 21, 'accept', 'proceed_once', 'Once');
    await tick();
    expect(approvalReceipts(record.id)).toEqual([
      expect.objectContaining({ requestId: '21', decision: 'accept', optionId: 'proceed_once', optionLabel: 'Once', title: 'Allow this agent action?' }),
    ]);
  });

  it('archives a chat out of the tabs and restore, and keeps it for /unarchive', async () => {
    terminal.sessions = [{ id: 13, isRunning: true }];
    fake.set(13, ready({ items: [{ id: 'u', kind: 'user', text: 'archive me' }] }));
    panes.markStructuredChatPane(13, 'codex');
    await tick();
    const record = recordForPane(13)!;

    expect(archiveStructuredSession(13)).toBe(true);
    expect(get(structuredSessions)[record.id]).toMatchObject({ archived: true });
    expect(get(structuredSessions)[record.id].archivedAt).toBeTypeOf('number');
    expect(listStructuredSessions({ projectId: 'proj' }).map((r) => r.id)).not.toContain(record.id);
    expect(listArchivedSessions({ projectId: 'proj' }).map((r) => r.id)).toContain(record.id);

    expect(archiveStructuredRecord(record.id, false)).toBe(true);
    expect(get(structuredSessions)[record.id].archived).toBe(false);
    expect(listStructuredSessions({ projectId: 'proj' }).map((r) => r.id)).toContain(record.id);
    expect(listArchivedSessions({ projectId: 'proj' })).toHaveLength(0);
  });

  it('switches agents mid-conversation while preserving record ID, adding divider, and seeding history', async () => {
    terminal.sessions = [{ id: 15, isRunning: true }];
    const seededItems = [
      { id: 'u1', kind: 'user', text: 'Plan the feature' },
      { id: 'a1', kind: 'assistant', text: 'Here is a 3-step plan.' },
    ];
    fake.set(15, ready({ items: seededItems }));
    panes.markStructuredChatPane(15, 'codex', 'codex', 'chat');
    await tick();
    const record = recordForPane(15)!;

    // Refuses to switch while a turn is working
    fake.set(15, ready({ status: 'working', items: seededItems }));
    expect(await switchStructuredAgent(15, 'claude')).toBe(false);

    fake.set(15, ready({ items: seededItems }));
    expect(await switchStructuredAgent(15, 'claude', { model: 'sonnet', effort: 'high' })).toBe(true);

    expect(fake.provider.close).toHaveBeenCalledWith(15);
    expect(fake.claudeProvider.start).toHaveBeenCalled();
    const updated = recordForPane(15)!;
    expect(updated.id).toBe(record.id);
    expect(updated.provider).toBe('claude');
    expect(updated.nativeSessionId).toBeNull();
    expect(updated.seedContext).toBe(true);
    const items = recordItemsSnapshot(record.id);
    expect(items.some((item) => item.kind === 'notice' && item.text.includes('Switched to Claude Code'))).toBe(true);
    expect(paneWireText(15, 'Continue from step 2').text).toContain('Plan the feature');
  });

  it('manages standalone records and migrates legacy standalone threads once idempotently', async () => {
    env.data.clear();
    const created = createStandaloneStructuredRecord({ provider: 'codex', title: 'Draft idea' });
    expect(listStandaloneStructuredRecords().map((r) => r.id)).toContain(created.id);
    expect(updateStandaloneStructuredRecord(created.id, { pinned: true, model: 'gpt-5' })).toBe(true);
    expect(listStandaloneStructuredRecords()[0]).toMatchObject({ id: created.id, pinned: true, model: 'gpt-5' });

    const migratedCount = migrateLegacyStandaloneRecords(
      [{ id: 'legacy-1', title: 'Old standalone chat', pinned: false, standaloneWorkspaceId: 'ws-1', createdAt: 10, lastActivityAt: 20 }],
      { 'legacy-1': [{ id: 'm1', role: 'user', text: 'Hello', ts: 10 }, { id: 'm2', role: 'assistant', text: 'Hi!', ts: 11 }] },
      'claude',
    );
    expect(migratedCount).toBe(1);
    expect(migrateLegacyStandaloneRecords([], {}, 'claude')).toBe(0);
    const items = recordItemsSnapshot('ss_legacy_legacy-1');
    expect(items.map((i) => i.text)).toEqual(['Hello', 'Hi!']);

    await deleteStandaloneStructuredRecord(created.id);
    expect(listStandaloneStructuredRecords().map((r) => r.id)).not.toContain(created.id);
  });
});
