import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
const caps = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: unknown) => cmd === 'ai_agent_capabilities' ? Promise.resolve(caps.value) : invoke(cmd, args) }));
const listeners = vi.hoisted(() => ({ handler: null as null | ((event: { payload: { requestId: string; delta: string } }) => void), unlisten: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (_name: string, handler: typeof listeners.handler) => { listeners.handler = handler; return Promise.resolve(listeners.unlisten); } }));
import { AgentTransport, DEFAULT_AGENT_BUDGETS, alignToolResults, filePage, nativeTools, validateToolCall } from './agent-transport';
import {
  BRAIN_BROWSER_ACT_TOOLS,
  BRAIN_BROWSER_LOOK_TOOLS,
  BRAIN_DESKTOP_ACT_TOOLS,
  BRAIN_DESKTOP_SEE_TOOLS,
  BRAIN_READONLY_TOOLS,
  BRAIN_WRITE_TOOLS,
  brainToolProfile,
  buildBrainToolsPrompt,
  setBrowserToolsAvailable,
  setDesktopToolsAvailable,
} from './brain-tools';

describe('native agent transport', () => {
  beforeEach(() => { invoke.mockReset(); caps.value = {}; });

  it('streams only the text of its own request, restarts it per attempt, and stops listening', async () => {
    const transport = new AgentTransport('kilocode', 'm');
    const seen: string[] = [];
    transport.stream = { start: () => seen.push('<start>'), delta: (text) => seen.push(text) };
    invoke.mockImplementation((_cmd: string, args: { request: { requestId: string; stream: boolean } }) => {
      expect(args.request.stream).toBe(true);
      listeners.handler?.({ payload: { requestId: 'someone-else', delta: 'x' } });
      listeners.handler?.({ payload: { requestId: args.request.requestId, delta: 'Hel' } });
      listeners.handler?.({ payload: { requestId: args.request.requestId, delta: 'lo' } });
      return Promise.resolve({ text: 'Hello', calls: [], assistant: {} });
    });
    await expect(transport.request('system', 'task')).resolves.toBe('Hello');
    expect(seen).toEqual(['<start>', 'Hel', 'lo']);
    expect(listeners.unlisten).toHaveBeenCalledTimes(1);
  });

  it('sends unstreamed requests when nothing listens', async () => {
    invoke.mockResolvedValue({ text: 'ok', calls: [], assistant: {} });
    await new AgentTransport('kilocode', 'm').request('system', 'task');
    expect(invoke.mock.calls[0][1].request.stream).toBe(false);
  });

  it('falls back to the text tool protocol when the catalogue reports no native tools', async () => {
    caps.value = { nativeTools: false };
    const transport = new AgentTransport('openrouter', 'tool-less');
    invoke.mockResolvedValue({ text: '{"tool_calls":[{"id":"r1","name":"read_file","args":{"path":"a.ts"}}]}', calls: [], assistant: { role: 'assistant' } });
    const raw = await transport.request('system', 'task');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1].request).toMatchObject({ textMode: true, tools: [] });
    expect(JSON.parse(raw).tool_calls[0]).toMatchObject({ name: 'read_file' });
    expect(transport.state.textFallback).toBe(true);
  });

  it('retries once in text mode when the provider rejects native tools on the first round', async () => {
    const transport = new AgentTransport('openrouter', 'tool-less');
    invoke.mockRejectedValueOnce('unsupported_tools: openrouter / tool-less (404): No endpoints found that support tool use')
      .mockResolvedValueOnce({ text: 'Plain answer.', calls: [], assistant: {} });
    await expect(transport.request('system', 'task')).resolves.toBe('Plain answer.');
    expect(invoke.mock.calls[0][1].request).toMatchObject({ textMode: false });
    expect(invoke.mock.calls[1][1].request).toMatchObject({ textMode: true, tools: [] });
  });

  it('does not switch protocols once native tool history exists', async () => {
    const result = { id: 'r1', name: 'read_file' as const, ok: true, output: 'x' };
    const checkpoint = { provider: 'openrouter', model: 'm', summary: '', results: [result],
      exchanges: [{ assistant: { role: 'assistant', tool_calls: [{ id: 'r1' }] }, results: [result] }] };
    invoke.mockRejectedValue('unsupported_tools: no tools');
    await expect(new AgentTransport('openrouter', 'm', checkpoint).request('system', 'task')).rejects.toBe('unsupported_tools: no tools');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('retries an empty inference once with the same model, budget, and completed tool evidence', async () => {
    const save = vi.fn();
    const model = 'deepseek/deepseek-v4-flash-0731:free';
    const result = { id: 'write-1', name: 'write_file' as const, ok: true, output: 'Saved a.ts' };
    const checkpoint = { provider: 'openrouter', model, summary: '', results: [result],
      exchanges: [{ assistant: { role: 'assistant', tool_calls: [{ id: 'write-1' }] }, results: [result] }] };
    const transport = new AgentTransport('openrouter', model, checkpoint, save);
    invoke.mockRejectedValueOnce('empty_response: model returned neither text nor tools')
      .mockResolvedValueOnce({ text: 'The file was saved.', calls: [], assistant: {} });
    await expect(transport.request('system', 'task')).resolves.toBe('The file was saved.');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
    expect(invoke.mock.calls[1][1].request).toMatchObject({ provider: 'openrouter', model, exchanges: checkpoint.exchanges });
    expect(transport.state).toEqual(checkpoint);
    expect(save).not.toHaveBeenCalled();
  });

  it('stops after two empty responses with actionable guidance', async () => {
    invoke.mockRejectedValue(new Error('empty_response: model returned neither text nor tools'));
    const transport = new AgentTransport('openrouter', 'model');
    await expect(transport.request('system', 'task')).rejects.toThrow('on two attempts');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(transport.state.pending).toBeUndefined();
  });

  it.each(['authentication: bad key', 'output_limit: truncated', 'protocol: invalid tool arguments', 'rate_limit: slow down'])(
    'does not add inference retries for %s', async (error) => {
      invoke.mockRejectedValue(error);
      await expect(new AgentTransport('openrouter', 'model').request('system', 'task')).rejects.toBe(error);
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry an empty response after cancellation', async () => {
    const controller = new AbortController();
    invoke.mockImplementation(async (command) => {
      if (command === 'ai_agent_cancel') return;
      controller.abort();
      throw 'empty_response: model returned neither text nor tools';
    });
    await expect(new AgentTransport('openrouter', 'model', undefined, undefined, controller.signal).request('system', 'task')).rejects.toThrow();
    expect(invoke.mock.calls.filter(([command]) => command === 'ai_agent_turn')).toHaveLength(1);
  });

  it('uses the larger default output budget while respecting provider limits', async () => {
    expect(DEFAULT_AGENT_BUDGETS.outputTokens).toBe(32_768);
    const transport = new AgentTransport('openai', 'm', undefined, undefined, undefined, { outputTokens: undefined });
    invoke.mockResolvedValue({ text: 'done', calls: [], assistant: {} });

    await transport.request('system', 'task');

    expect(invoke).toHaveBeenCalledWith('ai_agent_turn', expect.objectContaining({
      request: expect.objectContaining({ maxOutputTokens: 32_768 }),
    }));
  });

  it('raises the output budget for the recovery pass and clamps it to the model cap', async () => {
    const transport = new AgentTransport('openai', 'm', undefined, undefined, undefined, { outputTokens: undefined });
    invoke.mockResolvedValue({ text: 'done', calls: [], assistant: {} });

    await transport.request('system', 'task', undefined, undefined, false, 131_072);

    expect(invoke).toHaveBeenCalledWith('ai_agent_turn', expect.objectContaining({
      request: expect.objectContaining({ maxOutputTokens: 131_072 }),
    }));

    // A model whose catalogue reports a smaller output cap wins over the raise.
    invoke.mockClear();
    const capped = new AgentTransport('openai', 'small', undefined, undefined, undefined, { outputTokens: undefined });
    (capped as unknown as { capabilities: { outputTokens?: number } }).capabilities = { outputTokens: 65_536 };
    await capped.request('system', 'task', undefined, undefined, false, 131_072);
    expect(invoke).toHaveBeenCalledWith('ai_agent_turn', expect.objectContaining({
      request: expect.objectContaining({ maxOutputTokens: 65_536 }),
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

  it('accepts fractional tap coordinates, which the integer type would reject', () => {
    const call = { id: '1', name: 'emulator_tap' as const, args: { target: 'emulator-5554', x: 0.5, y: 0.25 } };
    expect(validateToolCall(call)).toBeNull();
    expect(call.args).toEqual({ target: 'emulator-5554', x: 0.5, y: 0.25 });
  });

  it('coerces a stringified coordinate instead of failing the round', () => {
    const call = { id: '1', name: 'emulator_swipe' as const, args: { target: 'e', x1: '0.5', y1: '0.8', x2: 0.5, y2: 0.2 } };
    expect(validateToolCall(call)).toBeNull();
    expect(call.args.x1).toBe(0.5);
    expect(call.args.y1).toBe(0.8);
  });

  it('refuses a tap with no coordinates rather than tapping the corner', () => {
    expect(validateToolCall({ id: '1', name: 'emulator_tap', args: { target: 'e' } })).toContain('x');
    expect(validateToolCall({ id: '1', name: 'emulator_tap', args: { target: 'e', x: 'middle', y: 0.5 } })).toContain('x');
  });

  it('exposes the device tools to the model in full mode only', () => {
    const full = nativeTools(brainToolProfile('full').allowed).map((t) => t.name);
    expect(full).toContain('emulator_tap');
    expect(full).toContain('emulator_logcat');
    const ask = nativeTools(brainToolProfile('ask').allowed).map((t) => t.name);
    expect(ask).toContain('emulator_logcat');
    expect(ask).not.toContain('emulator_tap');
  });
});

describe('generate_image schema', () => {
  it('is offered natively with an array of reference paths', () => {
    const tool = nativeTools(brainToolProfile('full').allowed).find((t) => t.name === 'generate_image');
    expect(tool?.parameters).toMatchObject({ required: ['prompt'], properties: { reference_images: { type: 'array' } } });
    expect(validateToolCall({ id: '1', name: 'generate_image', args: { prompt: 'x', reference_images: ['a.png'] } })).toBeNull();
  });
});

describe('computer-use tools (docs/computer-use.md)', () => {
  afterEach(() => setDesktopToolsAvailable(false));

  it('are not offered at all while computer use is off', () => {
    setDesktopToolsAvailable(false);
    const full = nativeTools(brainToolProfile('full').allowed).map((t) => t.name);
    expect(full.some((n) => n.startsWith('desktop_'))).toBe(false);
    expect(buildBrainToolsPrompt()).not.toContain('desktop_');
  });

  it('let ask/plan mode read a window and only full mode act in one', () => {
    setDesktopToolsAvailable(true);
    const full = nativeTools(brainToolProfile('full').allowed).map((t) => t.name);
    for (const t of [...BRAIN_DESKTOP_SEE_TOOLS, ...BRAIN_DESKTOP_ACT_TOOLS]) expect(full).toContain(t);
    for (const mode of ['ask', 'plan'] as const) {
      const names = nativeTools(brainToolProfile(mode).allowed).map((t) => t.name);
      expect(names).toContain('desktop_ui_tree');
      expect(names).not.toContain('desktop_click');
      expect(names).not.toContain('desktop_type');
    }
    expect(buildBrainToolsPrompt()).toContain('DESKTOP LOOP');
  });

  it('has a schema for every desktop tool, including signed scroll steps', () => {
    setDesktopToolsAvailable(true);
    for (const name of [...BRAIN_DESKTOP_SEE_TOOLS, ...BRAIN_DESKTOP_ACT_TOOLS]) {
      expect(validateToolCall({ id: '1', name, args: { window: '1', reason: 'r', text: 't', keys: 'enter' } }) ?? '').not.toContain('Unknown tool');
    }
    const scroll = { id: '1', name: 'desktop_scroll' as const, args: { window: '1', dy: '-3' } as Record<string, unknown> };
    expect(validateToolCall(scroll)).toBeNull();
    expect(scroll.args.dy).toBe(-3);
    const click = { id: '1', name: 'desktop_click' as const, args: { window: '1', x: '0.25', y: 0.5 } as Record<string, unknown> };
    expect(validateToolCall(click)).toBeNull();
    expect(click.args.x).toBe(0.25);
  });

  it('runs acts one at a time and reads concurrently', () => {
    for (const t of BRAIN_DESKTOP_ACT_TOOLS) expect(BRAIN_WRITE_TOOLS.has(t)).toBe(true);
    for (const t of BRAIN_DESKTOP_SEE_TOOLS) expect(BRAIN_READONLY_TOOLS.has(t)).toBe(true);
  });
});

describe('chat browser tools (docs/agent-browser.md)', () => {
  afterEach(() => setBrowserToolsAvailable(false));

  it('are offered only while the browser switch is on, and act only in full mode', () => {
    setBrowserToolsAvailable(false);
    expect(nativeTools(brainToolProfile('full').allowed).some((t) => t.name.startsWith('browser_'))).toBe(false);
    setBrowserToolsAvailable(true);
    const full = nativeTools(brainToolProfile('full').allowed).map((t) => t.name);
    for (const t of [...BRAIN_BROWSER_LOOK_TOOLS, ...BRAIN_BROWSER_ACT_TOOLS]) expect(full).toContain(t);
    const ask = nativeTools(brainToolProfile('ask').allowed).map((t) => t.name);
    expect(ask).toContain('browser_snapshot');
    expect(ask).not.toContain('browser_click');
    expect(ask).not.toContain('browser_evaluate');
    expect(buildBrainToolsPrompt()).toContain('BROWSER LOOP');
  });

  it('never offers the tools that reach outside the page', () => {
    setBrowserToolsAvailable(true);
    const names = nativeTools(brainToolProfile('full').allowed).map((t) => t.name);
    for (const banned of ['browser_file_upload', 'browser_drop', 'browser_run_code_unsafe']) expect(names).not.toContain(banned);
  });

  it('matches Playwright MCP 0.0.82 argument names (target, not ref)', () => {
    setBrowserToolsAvailable(true);
    expect(validateToolCall({ id: '1', name: 'browser_click', args: { target: 'e6', element: 'Save' } })).toBeNull();
    expect(validateToolCall({ id: '1', name: 'browser_click', args: { ref: 'e6' } })).toContain('target');
    expect(validateToolCall({ id: '1', name: 'browser_take_screenshot', args: { scale: 'css' } })).toBeNull();
    expect(validateToolCall({ id: '1', name: 'browser_console_messages', args: {} })).toContain('level');
  });

  it('runs every browser tool in order', () => {
    for (const t of [...BRAIN_BROWSER_LOOK_TOOLS, ...BRAIN_BROWSER_ACT_TOOLS]) {
      expect(BRAIN_READONLY_TOOLS.has(t)).toBe(false);
      expect(BRAIN_WRITE_TOOLS.has(t)).toBe(true);
    }
  });
});

describe('images for vision models (agent_turn/vision.rs decides who gets them)', () => {
  it('keeps a result\'s screenshot files when aligning results to calls', () => {
    const aligned = alignToolResults(
      [{ id: 'a', name: 'desktop_screenshot', args: {} }],
      [{ id: 'a', name: 'desktop_screenshot', ok: true, output: 'saved', images: ['C:/tmp/shot.png'] }],
      () => 'missing',
    );
    expect(aligned[0].images).toEqual(['C:/tmp/shot.png']);
    const plain = alignToolResults([{ id: 'b', name: 'read_file', args: {} }], [{ id: 'b', name: 'read_file', ok: true, output: 'x' }], () => '');
    expect('images' in plain[0]).toBe(false);
  });
});

describe('images on the wire to Rust', () => {
  beforeEach(() => { invoke.mockReset(); caps.value = {}; });

  it('sends the user\'s attached images and the round\'s screenshots along with the text', async () => {
    const message = 'Fix the layout\n--- Attached file: shot.png (image/png) ---\nThe binary attachment was saved at C:/Temp/spacron/pasted/shot.png. Inspect it when relevant.\n--- End attached file ---';
    const transport = new AgentTransport('anthropic', 'claude-sonnet-4-5');
    invoke.mockResolvedValueOnce({ text: '', calls: [{ id: 'a', name: 'emulator_screenshot', args: { target: 'emulator-5554' } }], assistant: { role: 'assistant' } });
    await transport.request('system', message);
    expect(invoke.mock.calls[0][1].request.userImages).toEqual(['C:/Temp/spacron/pasted/shot.png']);

    await transport.record([{ id: 'a', name: 'emulator_screenshot', ok: true, output: 'saved', images: ['C:/Temp/spacron-screenshots/emulator-1.jpg'] }]);
    invoke.mockResolvedValueOnce({ text: 'Done.', calls: [], assistant: {} });
    await transport.request('system', message);
    const second = invoke.mock.calls[1][1].request;
    expect(second.exchanges[0].results[0].images).toEqual(['C:/Temp/spacron-screenshots/emulator-1.jpg']);
  });

  it('sends no image paths when the message has none', async () => {
    invoke.mockResolvedValueOnce({ text: 'ok', calls: [], assistant: {} });
    await new AgentTransport('deepseek', 'deepseek-chat').request('system', 'plain task');
    expect(invoke.mock.calls[0][1].request.userImages).toEqual([]);
  });
});
