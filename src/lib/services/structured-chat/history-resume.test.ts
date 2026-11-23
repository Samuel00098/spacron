import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  open: vi.fn(), create: vi.fn(), accountEnv: vi.fn(),
}));
vi.mock('$lib/services/acp-transport', () => ({
  ACP_NO_CLIENT_TOOLS: {},
  openAgentSession: transport.open,
  createAcpNativeSession: transport.create,
  initializeAcp: vi.fn(async () => ({ authMethods: [] })),
  authenticateAcp: vi.fn(), promptAcpNativeSession: vi.fn(),
  setAcpSessionMode: vi.fn(), setAcpSessionModel: vi.fn(),
  stderrTail: () => ({ text: () => '' }),
  withTimeout: (promise: Promise<unknown>) => promise,
}));
vi.mock('$lib/stores/agentAccounts', () => ({ accountEnvFor: transport.accountEnv }));
vi.mock('./visuals', () => ({ prepareStructuredVisuals: async () => ({}) }));
vi.mock('$lib/stores/settings', () => ({ chatAutoAnswerInline: { subscribe: (fn: (v: boolean) => void) => { fn(false); return () => {}; } } }));

import { createAcpProvider } from './acp-session';
import type { AcpServerRequest } from '$lib/services/acp-transport';
import { piProvider } from './pi-session';

function session() {
  let raw: (line: string) => void = () => {};
  return {
    request: vi.fn(async (_method: string, _params: unknown) => ({ sessionId: 'saved-session' })),
    onNotification: vi.fn(async (_listener: (notification: Record<string, unknown>) => void) => {}),
    onRequest: vi.fn(async (_listener: (request: AcpServerRequest) => void) => {}),
    onExit: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    onRawLine: vi.fn(async (listener: (line: string) => void) => { raw = listener; }),
    writeRaw: vi.fn(async (line: string) => {
      const frame = JSON.parse(line);
      queueMicrotask(() => raw(JSON.stringify({ type: 'response', id: frame.id, success: true,
        data: frame.type === 'get_state' ? { sessionId: 'saved-session' } : { models: [] } })));
    }),
    close: vi.fn(async () => {}),
  };
}

describe('history resumes the native conversation under its owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.accountEnv.mockResolvedValue({ ACCOUNT_HOME: '/accounts/original' });
  });

  it.each(['opencode', 'grok', 'antigravity', 'cursor', 'copilot', 'omp'])('%s loads the saved ACP id and explicit account', async (agent) => {
    const rpc = session();
    transport.open.mockResolvedValue(rpc);
    const provider = createAcpProvider(agent);
    await provider.start(1, '/repo', { resumeId: 'saved-session', accountId: 'original' });
    expect(transport.accountEnv).toHaveBeenCalledWith(agent, 'original');
    expect(transport.open.mock.calls[0][3]).toMatchObject({ ACCOUNT_HOME: '/accounts/original' });
    expect(rpc.request).toHaveBeenCalledWith('session/load', { sessionId: 'saved-session', cwd: '/repo', mcpServers: [] });
    expect(transport.create).not.toHaveBeenCalled();
    expect(provider.get(1)).toMatchObject({ status: 'ready', threadId: 'saved-session' });
    await provider.close(1);
  });

  it('reports a failed ACP resume without creating a replacement session', async () => {
    const rpc = session();
    rpc.request.mockRejectedValue(new Error('Session not found'));
    transport.open.mockResolvedValue(rpc);
    const provider = createAcpProvider('cursor');
    await provider.start(2, '/repo', { resumeId: 'missing-session', accountId: 'original' });
    expect(provider.get(2)).toMatchObject({ status: 'failed', error: expect.stringContaining('Could not resume Cursor') });
    expect(transport.create).not.toHaveBeenCalled();
    await provider.close(2);
  });

  it.each(['antigravity', 'opencode', 'grok', 'cursor', 'copilot', 'omp'])('%s keeps the final reply after its tools, even with reused stream ids', async (agent) => {
    const rpc = session();
    transport.open.mockResolvedValue(rpc);
    const provider = createAcpProvider(agent);
    await provider.start(9, '/repo');
    const notify = rpc.onNotification.mock.calls[0][0];
    const update = (sessionUpdate: string, text: string) => notify({ params: { update: { sessionUpdate,
      id: 'reused-provider-message-id', content: { type: 'text', text } } } });
    update('agent_message_chunk', 'Checking ');
    update('agent_message_chunk', 'the files.');
    notify({ params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file', rawInput: {} } } });
    notify({ params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: { type: 'text', text: 'File read' } } } });
    update('agent_message_chunk', 'The work ');
    update('agent_message_chunk', 'is complete.');
    const items = provider.get(9)!.items;
    expect(items.map((item) => item.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(items[0].text).toBe('Checking the files.');
    expect(items[2].text).toBe('The work is complete.');
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    await provider.close(9);
  });

  it('keeps replayed conversation replies beside their own user turns', async () => {
    const rpc = session();
    transport.open.mockResolvedValue(rpc);
    const provider = createAcpProvider('antigravity');
    await provider.start(10, '/repo', { resumeId: 'saved-session' });
    const notify = rpc.onNotification.mock.calls[0][0];
    for (const [sessionUpdate, text] of [
      ['user_message_chunk', 'First question'], ['agent_message_chunk', 'First answer'],
      ['user_message_chunk', 'Second question'], ['agent_message_chunk', 'Second answer'],
    ]) notify({ params: { update: { sessionUpdate, content: { type: 'text', text } } } });
    expect(provider.get(10)!.items.map((item) => [item.kind, item.text])).toEqual([
      ['user', 'First question'], ['assistant', 'First answer'], ['user', 'Second question'], ['assistant', 'Second answer'],
    ]);
    await provider.close(10);
  });

  it('asks in Antigravity Auto and keeps fixed choices explicit in Full access', async () => {
    const rpc = session();
    transport.open.mockResolvedValue(rpc);
    const provider = createAcpProvider('antigravity');
    await provider.start(11, '/repo', { access: 'auto' });
    const request = rpc.onRequest.mock.calls[0][0];
    const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }];
    request({ requestId: 1, method: 'session/request_permission', params: { toolCall: { kind: 'edit' }, options } });
    expect(rpc.respond).not.toHaveBeenCalled();
    expect(provider.get(11)?.approvals[0]?.requestId).toBe(1);
    await provider.answerApproval(11, 1, 'accept', 'once');
    expect(rpc.respond).toHaveBeenCalledWith(1, { outcome: { outcome: 'selected', optionId: 'once' } });

    provider.setAccess(11, 'full-access');
    request({ requestId: 2, method: 'session/request_permission', params: { toolCall: { kind: 'execute' }, options } });
    expect(rpc.respond).toHaveBeenCalledWith(2, { outcome: { outcome: 'selected', optionId: 'once' } });
    request({ requestId: 3, method: 'session/request_permission', params: { toolCall: { toolCallId: 'interaction_3' }, options } });
    expect(rpc.respond).toHaveBeenCalledTimes(2);
    expect(provider.get(11)?.approvals[0]?.requestId).toBe(3);
    await provider.close(11);
  });

  it('Pi opens the requested session at launch and keeps its native identity', async () => {
    const rpc = session();
    transport.open.mockResolvedValue(rpc);
    await piProvider.start(3, '/repo', { resumeId: 'saved-session', accountId: 'default' });
    expect(transport.accountEnv).toHaveBeenCalledWith('pi', 'default');
    expect(transport.open).toHaveBeenCalledWith('pi', ['--mode', 'rpc', '--session', 'saved-session'], '/repo', expect.any(Object));
    expect(piProvider.get(3)).toMatchObject({ status: 'ready', threadId: 'saved-session' });
    expect(piProvider.conversationId?.(3)).toBe('saved-session');
    await piProvider.close(3);
  });
});
