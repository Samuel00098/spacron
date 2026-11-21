import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ spawn: vi.fn(), ready: vi.fn(), send: vi.fn(), kill: vi.fn() }));

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
    createTerminalSession: vi.fn(),
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
  structuredChatAgentFor: () => null,
}));
vi.mock('./session-store', () => ({ linkHandoffLineage: vi.fn() }));
vi.mock('./registry', () => ({
  closeStructuredChat: vi.fn(),
  getStructuredChat: () => null,
  sendStructuredChat: vi.fn(),
  structuredChatProvider: () => null,
}));

import { getPaneHandoff, initiateHandoff, isHandoffInProgress, retryHandoff } from './handoff-coordinator';

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
});
