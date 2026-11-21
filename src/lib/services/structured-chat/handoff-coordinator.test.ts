import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  spawn: vi.fn(),
  ready: vi.fn(),
  send: vi.fn(),
  kill: vi.fn(),
  createChat: vi.fn(),
  sendChat: vi.fn(),
  getChat: vi.fn(),
}));

vi.mock('$lib/stores/notification', () => ({ showToast: vi.fn() }));
vi.mock('$lib/stores/workspace', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return { activeProject: writable({ id: 'p', name: 'demo', root_path: '/repo' }) };
});
vi.mock('$lib/stores/terminal', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return {
    sessions: writable([]),
    getSessionRoot: () => '/repo',
    getAgentDisplayName: (preset: string) => (preset === 'claude' ? 'Claude Code' : null),
    createTerminalSession: state.createChat,
    killSession: state.kill,
    sendAgentPromptDirect: state.send,
    spawnAgentPreset: state.spawn,
    updateSessionTitle: vi.fn(),
    waitForAgentReady: state.ready,
  };
});
vi.mock('$lib/services/terminal-chat', () => ({
  applyLaunchView: vi.fn(),
  readTerminalTranscript: vi.fn(async () => ({
    messages: [{ id: '1', kind: 'user', text: 'fix the bug' }, { id: '2', kind: 'assistant', text: 'working' }],
    busy: false, model: 'm', effort: null, permission: null,
  })),
  transcriptAgentFor: () => 'claude',
  getBoundTranscript: () => null,
}));
vi.mock('$lib/services/terminal-screen', () => ({ readTerminalScreen: () => null }));
vi.mock('./panes', () => ({
  markStructuredChatPane: vi.fn(),
  forgetStructuredChatPane: vi.fn(),
  structuredChatAgentFor: (command: string) => command === 'cursor-agent' ? 'cursor' : null,
}));
vi.mock('./session-store', () => ({ linkHandoffLineage: vi.fn() }));
vi.mock('./registry', () => ({
  closeStructuredChat: vi.fn(async () => {}),
  getStructuredChat: () => null,
  sendStructuredChat: state.sendChat,
  structuredChatProvider: (agent: string) => agent === 'cursor'
    ? { label: 'Cursor', start: vi.fn(), get: state.getChat }
    : null,
}));

import { buildHistoryHandoffPrompt, getPaneHandoff, handOffFromHistory, initiateHandoff, isHandoffInProgress, readHistoryHandoffSource, retryHandoff } from './handoff-coordinator';

const request = {
  sourceSessionId: 1,
  sourceAgentName: 'Claude',
  sourcePreset: 'claude',
  targetCommand: 'gemini',
  targetName: 'Gemini',
  mode: 'terminal' as const,
};

describe('initiateHandoff', () => {
  beforeEach(() => {
    state.spawn.mockReset();
    state.ready.mockReset();
    state.send.mockReset();
    state.kill.mockReset();
    state.kill.mockResolvedValue(undefined);
  });

  it('delivers the context to a terminal target and records it', async () => {
    state.spawn.mockResolvedValue(9);
    state.ready.mockResolvedValue('ready');
    state.send.mockResolvedValue(true);
    expect(await initiateHandoff(request)).toBe(true);
    expect(state.send.mock.calls[0][1]).toContain('fix the bug');
    // The pane's nickname alone doesn't say which agent it was.
    expect(state.send.mock.calls[0][1]).toContain('Previous agent: Claude (Claude Code)');
    expect(getPaneHandoff(1)?.status).toBe('delivered');
    expect(isHandoffInProgress(1)).toBe(false);
  });

  it('fails, closes the target and can retry when the prompt is not accepted', async () => {
    state.spawn.mockResolvedValue(9);
    state.ready.mockResolvedValue('ready');
    state.send.mockResolvedValue(false);
    expect(await initiateHandoff(request)).toBe(false);
    expect(getPaneHandoff(1)?.status).toBe('failed');
    expect(state.kill).toHaveBeenCalledWith(9);
    state.send.mockResolvedValue(true);
    expect(await retryHandoff(1)).toBe(true);
    expect(getPaneHandoff(1)?.status).toBe('delivered');
  });

  it('fails when the target never becomes ready', async () => {
    state.spawn.mockResolvedValue(9);
    state.ready.mockResolvedValue('launch-failed');
    expect(await initiateHandoff(request)).toBe(false);
    expect(getPaneHandoff(1)?.error).toMatch(/did not start/);
    expect(state.send).not.toHaveBeenCalled();
  });

  it('signals chat dispatch while the response is pending and preserves a send error for retry', async () => {
    state.createChat.mockResolvedValueOnce(12);
    state.getChat.mockReturnValueOnce({ status: 'ready' });
    let finishSend!: () => void;
    state.sendChat.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishSend = resolve;
    }));
    const handoff = initiateHandoff({
      ...request,
      targetCommand: 'cursor-agent',
      targetName: 'Cursor',
      mode: 'chat',
    });
    await vi.waitFor(() => expect(getPaneHandoff(1)?.status).toBe('delivering'));
    expect(state.sendChat).toHaveBeenCalledWith('cursor', 12, expect.any(String));

    state.getChat.mockReturnValueOnce({ status: 'ready', error: 'Prompt rejected' });
    finishSend();
    await expect(handoff).resolves.toBe(false);
    expect(getPaneHandoff(1)).toMatchObject({ status: 'failed', error: 'Prompt rejected' });
  });
});

describe('handing over a past session from Agent History', () => {
  const source = { command: 'claude', agentName: 'Claude', sessionId: 'abc-123', cwd: '/repo' };
  const target = { command: 'gemini', name: 'Gemini' };

  beforeEach(() => {
    state.spawn.mockReset();
    state.ready.mockReset();
    state.send.mockReset();
    state.kill.mockReset();
    state.kill.mockResolvedValue(undefined);
  });

  it('reads the conversation back and previews the context for the chosen agent', async () => {
    const snapshot = await readHistoryHandoffSource(source);
    expect(snapshot.items.map((i) => i.text)).toEqual(['fix the bug', 'working']);
    const prompt = buildHistoryHandoffPrompt(source, snapshot, target, 'terminal');
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('Previous agent: Claude (Claude Code)');
  });

  it('sends the text the person approved, not a rebuilt one', async () => {
    state.spawn.mockResolvedValue(9);
    state.ready.mockResolvedValue('ready');
    state.send.mockResolvedValue(true);
    expect(await handOffFromHistory(source, target, 'terminal', 'EDITED CONTEXT')).toBe(true);
    expect(state.send.mock.calls[0][1]).toBe('EDITED CONTEXT');
  });

  it('builds the context itself when none is supplied, and leaves no pane record', async () => {
    state.spawn.mockResolvedValue(9);
    state.ready.mockResolvedValue('ready');
    state.send.mockResolvedValue(true);
    expect(await handOffFromHistory(source, target, 'terminal')).toBe(true);
    expect(state.send.mock.calls[0][1]).toContain('fix the bug');
    expect(getPaneHandoff(-1)).toBeNull();
  });

  it('reports failure when the target never starts', async () => {
    state.spawn.mockResolvedValue(9);
    state.ready.mockResolvedValue('timeout');
    expect(await handOffFromHistory(source, target, 'terminal', 'ctx')).toBe(false);
    expect(state.kill).toHaveBeenCalled();
  });
});
