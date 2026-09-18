import { beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: unknown) => cmd === 'ai_agent_capabilities' ? Promise.resolve({}) : invoke(cmd, args) }));
import { AgentTransport, DEFAULT_AGENT_BUDGETS, filePage, nativeTools, validateToolCall } from './agent-transport';
import { brainToolProfile } from './brain-tools';

describe('native agent transport', () => {
  beforeEach(() => invoke.mockReset());
  it('uses the larger default output budget while respecting provider limits', async () => {
    expect(DEFAULT_AGENT_BUDGETS.outputTokens).toBe(32_768);
    const transport = new AgentTransport('openai', 'm', undefined, undefined, undefined, { outputTokens: undefined });
    invoke.mockResolvedValue({ text: 'done', calls: [], assistant: {} });

    await transport.request('system', 'task');

    expect(invoke).toHaveBeenCalledWith('ai_agent_turn', expect.objectContaining({
      request: expect.objectContaining({ maxOutputTokens: 32_768 }),
    }));
  });

  it('exposes valid schemas for all tools and rejects malformed mutations', () => {
    for (const tool of nativeTools()) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.properties).toBeDefined();
    }
    expect(validateToolCall({ id: '1', name: 'write_file', args: { path: 'a' } })).toContain('content');
    expect(validateToolCall({ id: '1', name: 'read_file', args: { path: 'a', start_line: -1 } })).toContain('start_line');
  });
  it('reads past the former 4000-character ceiling and pages long single lines without losing text', () => {
    expect(filePage('header\n' + 'a'.repeat(5000) + '\nTARGET', 3)).toContain('3: TARGET');
    const text = 'x'.repeat(13000) + 'TAIL';
    expect(filePage(text)).toContain('start_char=12000');
    expect(filePage(text, 1, 200, 12000)).toContain('TAIL');
  });
  it('retains opaque provider metadata and matched results through more than eight rounds', async () => {
    const save = vi.fn();
    const transport = new AgentTransport('google', 'model', undefined, save);
    for (let round = 0; round < 10; round++) {
      const call = { id: `c${round}`, name: 'read_file' as const, args: { path: `f${round}` } };
      invoke.mockResolvedValueOnce({ text: '', calls: [call], assistant: { role: 'model', parts: [{ functionCall: call, thoughtSignature: 'opaque' }] } });
      await transport.request('system', 'task');
      await transport.record([{ id: call.id, name: call.name, ok: true, output: 'file' }]);
    }
    expect(transport.state.exchanges).toHaveLength(10);
    expect(transport.state.exchanges[0].assistant).toMatchObject({ parts: [{ thoughtSignature: 'opaque' }] });
    expect(invoke).toHaveBeenCalledTimes(10);
    expect(save).toHaveBeenCalled();
  });
  it('does not replay a mutation interrupted by reload', () => {
    const transport = new AgentTransport('openai', 'm', { provider: 'openai', model: 'm', exchanges: [], results: [], summary: '',
      pending: [{ id: '1', name: 'write_file', args: { path: 'a', content: 'b' } }], pendingAssistant: { role: 'assistant', tool_calls: [] } });
    expect(transport.state.exchanges[0].results[0].ok).toBe(false);
    expect(transport.state.exchanges[0].results[0].output).toContain('unknown');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('compacts complete exchanges and keeps the full archived result', async () => {
    const transport = new AgentTransport('openai', 'm', { provider: 'openai', model: 'm', summary: '',
      results: [{ id: 'old', name: 'read_file', ok: true, output: 'x'.repeat(5000) }],
      exchanges: [0, 1, 2].map(i => ({ assistant: { role: 'assistant' }, results: [{ id: String(i), name: 'read_file', ok: true, output: 'x'.repeat(5000) }] })) }, undefined, undefined, { contextChars: 7000 });
    invoke.mockResolvedValue({ text: 'done', calls: [], assistant: {} });
    await transport.request('system', 'task');
    expect(transport.state.exchanges).toHaveLength(1);
    expect(transport.state.summary).toContain('read_tool_result');
    expect(transport.state.results[0].output).toHaveLength(5000);
  });
  it('sends cancellation to the backend and never accepts the late response', async () => {
    const controller = new AbortController();
    let finish!: (v: unknown) => void;
    invoke.mockImplementation((cmd) => cmd === 'ai_agent_turn' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const transport = new AgentTransport('openai', 'm', undefined, undefined, controller.signal);
    const promise = transport.request('s', 'u');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort();
    finish({ text: 'done', calls: [], assistant: {} });
    await expect(promise).rejects.toThrow();
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'ai_agent_cancel')).toBe(true);
  });

  it('offers only profile-allowed tools and strips mutating calls in ask mode', async () => {
    const readOnly = nativeTools(brainToolProfile('ask').allowed);
    const names = readOnly.map((t) => t.name);
    expect(names).toContain('update_todos');
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('run_command');

    invoke.mockResolvedValue({
      text: '',
      // The provider emitted a write anyway; the transport must strip it.
      calls: [
        { id: '1', name: 'write_file', args: { path: 'a', content: 'x' } },
        { id: '2', name: 'read_file', args: { path: 'a' } },
      ],
      assistant: {},
    });
    const transport = new AgentTransport('openai', 'm', undefined, undefined, undefined, { toolProfile: 'ask' });
    const returned = await transport.request('system', 'task');
    const parsed = JSON.parse(returned) as { tool_calls: Array<{ name: string }> };
    expect(parsed.tool_calls.map((c) => c.name)).toEqual(['read_file']);
  });

  it('keeps the full toolkit and update_todos schema in full mode', () => {
    const names = nativeTools(brainToolProfile('full').allowed).map((t) => t.name);
    expect(names).toContain('write_file');
    expect(names).toContain('run_command');
    expect(names).toContain('update_todos');
    expect(validateToolCall({ id: '1', name: 'update_todos', args: { todos: ['[ ] a'] } })).toBeNull();
    expect(validateToolCall({ id: '1', name: 'update_todos', args: {} })).toContain('todos');
  });
});
