import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    status: 'ready',
    models: [{ id: 'gpt-a', label: 'A', description: null, efforts: ['low', 'high'], defaultEffort: null, isDefault: true }],
    model: 'gpt-a',
    effort: 'low',
    access: 'ask',
  };
  const provider = {
    agent: 'codex',
    label: 'Codex',
    capabilities: {
      rewind: true,
      fork: true,
      compact: 'native' as const,
      steering: 'inject' as const,
      contextUsage: true,
      mcp: true,
      subagents: { supported: true, spawn: false, inspectTranscript: true },
      nativeCommands: true,
      supportedAccessModes: ['ask', 'auto', 'full-access'] as any[],
    },
    get: vi.fn(() => state),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setAccess: vi.fn(),
    interrupt: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
  };
  const store = {
    clearStructuredConversation: vi.fn(async () => true),
    compactStructuredSession: vi.fn(() => true),
    forkStructuredSession: vi.fn(async (_id, opts) => ({ id: 'fork-1', title: opts?.title ?? 'Chat (fork)', forkMode: 'native' })),
    rewindStructuredSession: vi.fn(async () => true),
    renameStructuredSession: vi.fn(() => true),
    // A chat opened and never used (id `empty`) holds nothing worth resuming.
    recordHasConversation: vi.fn((record: { id: string }) => record.id !== 'empty'),
    resumeStructuredSessionInPane: vi.fn(async () => true),
    openStructuredRecordBeside: vi.fn(async () => 2),
    recordForPane: vi.fn(() => ({
      id: 'cur',
      projectId: 'p',
      provider: 'codex',
      restoredMode: 'native',
      goal: null as { text: string; state: 'active' | 'paused'; at: number } | null,
    })),
    setStructuredGoal: vi.fn(() => true),
    clearStructuredGoal: vi.fn(() => true),
    archiveStructuredSession: vi.fn(() => true),
    archiveStructuredRecord: vi.fn(() => true),
    listArchivedSessions: vi.fn(() => [
      { id: 'old', title: 'Old chat', archivedAt: Date.now() - 3_600_000 },
    ]),
    listStructuredSessions: vi.fn(() => [
      { id: 'cur', title: 'Now', lifecycle: 'ready', updatedAt: Date.now() },
      { id: 'old', title: 'Old chat', lifecycle: 'closed', updatedAt: Date.now() - 3_600_000 },
      { id: 'empty', title: 'Claude Chat', lifecycle: 'closed', updatedAt: Date.now() - 1000 },
    ]),
  };
  const beside = vi.fn();
  return { state, provider, store, beside };
});

vi.mock('./registry', () => ({ structuredChatProvider: () => h.provider }));
vi.mock('./session-store', () => h.store);
vi.mock('./side-chats', () => ({ addSideChat: h.beside }));

import { runStructuredCommand } from './commands';

describe('structured slash commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.status = 'ready';
  });

  it('changes model and effort through the provider, validating against the live catalog', async () => {
    expect(await runStructuredCommand('codex', 1, '/model gpt-a')).toMatchObject({ handled: true });
    expect(h.provider.setModel).toHaveBeenCalledWith(1, 'gpt-a');
    expect((await runStructuredCommand('codex', 1, '/model nope')).error).toContain('nope');
    expect((await runStructuredCommand('codex', 1, '/effort ultra')).error).toContain('low, high');
    await runStructuredCommand('codex', 1, '/effort high');
    expect(h.provider.setEffort).toHaveBeenCalledWith(1, 'high');
    await runStructuredCommand('codex', 1, '/permissions yolo');
    expect(h.provider.setAccess).toHaveBeenCalledWith(1, 'full-access');
  });

  it('runs session operations and leaves unknown commands to the agent', async () => {
    await runStructuredCommand('codex', 1, '/clear');
    expect(h.store.clearStructuredConversation).toHaveBeenCalledWith(1);
    await runStructuredCommand('codex', 1, '/rename Bug hunt');
    expect(h.store.renameStructuredSession).toHaveBeenCalledWith(1, 'Bug hunt');
    const history = (await runStructuredCommand('codex', 1, '/history')).output;
    expect(history).toContain('1. Old chat');
    expect(history).not.toContain('Claude Chat');
    await runStructuredCommand('codex', 1, '/resume 1');
    expect(h.store.resumeStructuredSessionInPane).toHaveBeenCalledWith(1, 'old');
    await runStructuredCommand('codex', 1, '/retry', { lastUserMessage: 'do it' });
    expect(h.provider.send).toHaveBeenCalledWith(1, 'do it');
    expect(await runStructuredCommand('codex', 1, '/terminal')).toEqual({ handled: true, action: 'continue-in-terminal' });
    expect(await runStructuredCommand('codex', 1, '/review main')).toEqual({ handled: false });
  });

  it('refuses to clear or interrupt in the wrong state', async () => {
    h.state.status = 'working';
    expect((await runStructuredCommand('codex', 1, '/clear')).error).toBeTruthy();
    await runStructuredCommand('codex', 1, '/stop');
    expect(h.provider.interrupt).toHaveBeenCalled();
    h.state.status = 'ready';
    expect((await runStructuredCommand('codex', 1, '/stop')).output).toBe('Nothing is running.');
  });

  it('handles /compact, /context, and /account', async () => {
    const compactRes = await runStructuredCommand('codex', 1, '/compact');
    expect(compactRes.handled).toBe(true);
    expect(h.store.compactStructuredSession).toHaveBeenCalledWith(1);
    expect(h.provider.compact).toHaveBeenCalledWith(1);

    const contextRes = await runStructuredCommand('codex', 1, '/context');
    expect(contextRes.handled).toBe(true);
    expect(contextRes.output).toContain('not reported');
    expect(contextRes.output).toContain('Continuity: native Codex session');

    const accountRes = await runStructuredCommand('codex', 1, '/account');
    expect(accountRes.handled).toBe(true);
    expect(accountRes.output).toContain('Account');
  });

  it('queues /compact behind a running turn instead of refusing it', async () => {
    h.state.status = 'working';
    const result = await runStructuredCommand('codex', 1, '/compact');
    expect(result.handled).toBe(true);
    expect(result.defer).toBe('compact');
    expect(result.output).toContain('as soon as it ends');
    expect(h.store.compactStructuredSession).not.toHaveBeenCalled();
  });

  it('leaves agent-owned commands to the agent', async () => {
    for (const command of ['/goal ship it', '/plan', '/mcp', '/init', '/help']) {
      expect(await runStructuredCommand('codex', 1, command)).toEqual({ handled: false });
    }
  });

  it('handles /rewind, /fork, and /steer according to provider capabilities', async () => {
    const rewindRes = await runStructuredCommand('codex', 1, '/rewind');
    expect(rewindRes.handled).toBe(true);
    expect(h.store.rewindStructuredSession).toHaveBeenCalledWith(1);
    expect(rewindRes.output).toContain('Rewound conversation');

    const forkRes = await runStructuredCommand('codex', 1, '/fork Feature-x');
    expect(forkRes.handled).toBe(true);
    expect(h.store.forkStructuredSession).toHaveBeenCalledWith(1, { title: 'Feature-x' });
    expect(forkRes.output).toContain('Forked conversation');

    // Steer while working
    h.state.status = 'working';
    const steerRes = await runStructuredCommand('codex', 1, '/steer use typescript');
    expect(steerRes.handled).toBe(true);
    expect(h.provider.steer).toHaveBeenCalledWith(1, 'use typescript');
    expect(steerRes.output).toContain('Injected steering');
  });

  it('validates access mode against supported capabilities', async () => {
    (h.provider.capabilities as any).supportedAccessModes = ['ask', 'auto'];
    const res = await runStructuredCommand('codex', 1, '/permissions full-access');
    expect(res.handled).toBe(true);
    expect(res.error).toContain('only supports [ask, auto]');
  });

  it('queues steering follow-ups when provider specifies queue steering', async () => {
    (h.provider.capabilities as any).steering = 'queue';
    h.state.status = 'working';
    const res = await runStructuredCommand('codex', 1, '/steer check edge cases');
    expect(res.handled).toBe(true);
    expect(res.output).toContain('Added follow-up to message queue');
    (h.provider.capabilities as any).steering = 'inject';
  });

  it('mirrors a goal while still sending the command to the agent', async () => {
    expect(await runStructuredCommand('codex', 1, '/goal ship the fix')).toEqual({ handled: false });
    expect(h.store.setStructuredGoal).toHaveBeenCalledWith(1, 'ship the fix', 'active');

    h.store.recordForPane.mockReturnValueOnce({
      id: 'cur',
      projectId: 'p',
      provider: 'codex',
      restoredMode: 'native',
      goal: { text: 'ship the fix', state: 'active', at: 1 },
    });
    expect(await runStructuredCommand('codex', 1, '/goal pause')).toEqual({ handled: false });
    expect(h.store.setStructuredGoal).toHaveBeenCalledWith(1, 'ship the fix', 'paused');

    expect(await runStructuredCommand('codex', 1, '/goal clear')).toEqual({ handled: false });
    expect(h.store.clearStructuredGoal).toHaveBeenCalledWith(1);
  });

  it('archives, lists and restores chats, and opens a side chat in the sidebar', async () => {
    (h.provider.capabilities as any).steering = 'inject';
    expect(await runStructuredCommand('codex', 1, '/archive')).toMatchObject({ handled: true });
    expect(h.store.archiveStructuredSession).toHaveBeenCalledWith(1);

    expect((await runStructuredCommand('codex', 1, '/archived')).output).toContain('Old chat');
    expect(await runStructuredCommand('codex', 1, '/unarchive 1')).toMatchObject({ handled: true });
    expect(h.store.archiveStructuredRecord).toHaveBeenCalledWith('old', false);

    // A running turn does not block it, and this pane is not touched.
    h.state.status = 'working';
    h.provider.get.mockImplementation(((id: number) => (id === 2 ? { ...h.state, status: 'ready' } : h.state)) as () => typeof h.state);
    h.store.resumeStructuredSessionInPane.mockClear();
    expect((await runStructuredCommand('codex', 1, '/side check the logs')).output).toContain('right sidebar');
    expect((await runStructuredCommand('codex', 1, '/sidebar look here')).output).toContain('right sidebar');
    expect(h.store.openStructuredRecordBeside).toHaveBeenCalledWith(1, 'fork-1');
    expect(h.store.resumeStructuredSessionInPane).not.toHaveBeenCalled();
    expect(h.provider.send).toHaveBeenCalledWith(2, 'check the logs');
    expect(h.provider.send).toHaveBeenCalledWith(2, 'look here');
    expect(h.beside).toHaveBeenCalledWith({ paneId: 2, parentPaneId: 1, projectId: 'p' });
    h.state.status = 'ready';
  });

  it('switches agents via /agent only where the host allows it, and rejects /terminal in standalone mode', async () => {
    const refused = await runStructuredCommand('codex', 1, '/agent claude');
    expect(refused.error).toContain('This chat stays on');

    const onSwitchAgent = vi.fn(async () => {});
    const listed = await runStructuredCommand('codex', 1, '/agent', { onSwitchAgent });
    expect(listed.handled).toBe(true);
    expect(listed.output).toContain('Claude Code');

    const switched = await runStructuredCommand('codex', 1, '/agent claude', { onSwitchAgent });
    expect(switched.handled).toBe(true);
    expect(onSwitchAgent).toHaveBeenCalledWith('claude', null, null);

    h.store.recordForPane.mockReturnValueOnce({ id: 's1', projectId: null as any, standalone: true, provider: 'codex', restoredMode: 'fresh', goal: null } as any);
    const termRes = await runStructuredCommand('codex', 1, '/terminal');
    expect(termRes.handled).toBe(true);
    expect(termRes.error).toContain('Create project from chat');
  });
});
