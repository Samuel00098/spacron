import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
// Typed with the real `listen` signature so a test can capture the handler and
// fire an event at it, not just assert that something subscribed.
const listenMock = vi.hoisted(() =>
  vi.fn(
    async (_event: string, _handler: (e: { payload: unknown }) => void): Promise<() => void> =>
      () => {},
  ),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => 'C:/Users/test') }));

const URL = 'http://127.0.0.1:51234/sse?token=abc123';
const HTTP_URL = 'http://127.0.0.1:51234/mcp?token=abc123';

/**
 * Mirrors the real command surface: only `mcp_server_url` and the file write.
 * Returns a freshly-imported module because `mcpBridge` caches the server URL
 * for the life of the module, so a stale import would leak between cases.
 */
async function mockBackend(opts: { url?: string | undefined; writeFails?: boolean } = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'mcp_server_url') return 'url' in opts ? opts.url : URL;
    if (cmd === 'mcp_server_http_url') return HTTP_URL;
    if (cmd === 'fs_write_file') {
      if (opts.writeFails) throw new Error('Access denied: path is outside any open project');
      return undefined;
    }
    return undefined;
  });
  vi.resetModules();
  return (await import('./mcpBridge')).mcpLaunchFlags;
}

/**
 * Same backend mock, but hands back the whole module.
 *
 * `existingFiles` is keyed by project-relative path for the `fs_*` commands and
 * by agent name (`codex`, `droid`) for the global-config commands — mirroring
 * the real split, where global configs cannot go through `fs_write_file`
 * because it rejects any path outside an open project.
 */
async function mockModule(existingFiles: Record<string, string> = {}) {
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, string>) => {
    if (cmd === 'mcp_server_url') return URL;
    if (cmd === 'mcp_server_http_url') return HTTP_URL;
    if (cmd === 'fs_read_file') {
      const found = existingFiles[args?.path ?? ''];
      if (found === undefined) throw new Error('ENOENT');
      return found;
    }
    if (cmd === 'mcp_read_global_agent_config') {
      return existingFiles[args?.agent ?? ''] ?? '';
    }
    return undefined;
  });
  vi.resetModules();
  return await import('./mcpBridge');
}

/** The content written to `path`, or undefined if it was never written. */
function written(path: string): string | undefined {
  const call = invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'fs_write_file')
    .find(([, args]) => args.path === path);
  return call?.[1].content;
}

/** The content written for a global-config agent, or undefined. */
function writtenGlobal(agent: string): string | undefined {
  const call = invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'mcp_write_global_agent_config')
    .find(([, args]) => args.agent === agent);
  return call?.[1].content;
}

describe('mcpLaunchFlags', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('points Claude Code at a written config file rather than an env var', async () => {
    const mcpLaunchFlags = await mockBackend();
    const flags = await mcpLaunchFlags('claude', 'C:/work/repo');

    expect(flags).toBe(' --mcp-config "C:/work/repo/.spacron/mcp/claude.json"');

    const write = invokeMock.mock.calls.find(([cmd]) => cmd === 'fs_write_file');
    expect(write).toBeDefined();
    expect(write![1].path).toBe('C:/work/repo/.spacron/mcp/claude.json');
    // `type: 'sse'` is load-bearing — a bare url is read as streamable HTTP,
    // which the Rust server does not serve.
    expect(JSON.parse(write![1].content)).toEqual({
      mcpServers: { 'spacron-mcp': { type: 'sse', url: URL } },
    });
  });

  it('keeps the token out of the command line', async () => {
    const mcpLaunchFlags = await mockBackend();
    expect(await mcpLaunchFlags('claude', 'C:/work/repo')).not.toContain('token=');
  });

  it('resolves the executable through launchers and paths', async () => {
    const mcpLaunchFlags = await mockBackend();
    for (const preset of ['npx claude', 'claude --resume', '/usr/local/bin/claude', 'claude.cmd']) {
      expect(await mcpLaunchFlags(preset, 'C:/work/repo')).toContain('--mcp-config');
    }
  });

  it('adds nothing for agents that discover MCP another way', async () => {
    const mcpLaunchFlags = await mockBackend();
    for (const preset of ['codex', 'cursor', 'opencode', 'grok', '']) {
      expect(await mcpLaunchFlags(preset, 'C:/work/repo')).toBe('');
    }
    expect(invokeMock).not.toHaveBeenCalledWith('fs_write_file', expect.anything());
  });

  it('adds nothing when there is no project root to write into', async () => {
    const mcpLaunchFlags = await mockBackend();
    expect(await mcpLaunchFlags('claude', undefined)).toBe('');
  });

  it('adds nothing when the MCP server has no URL', async () => {
    const mcpLaunchFlags = await mockBackend({ url: undefined });
    expect(await mcpLaunchFlags('claude', 'C:/work/repo')).toBe('');
    expect(invokeMock).not.toHaveBeenCalledWith('fs_write_file', expect.anything());
  });

  it('falls back to a plain launch when the config cannot be written', async () => {
    const mcpLaunchFlags = await mockBackend({ writeFails: true });
    // An agent without cross-agent tools beats an agent that fails to start.
    expect(await mcpLaunchFlags('claude', 'C:/work/repo')).toBe('');
  });

  it('strips a trailing slash so the path has no double separator', async () => {
    const mcpLaunchFlags = await mockBackend();
    expect(await mcpLaunchFlags('claude', 'C:/work/repo/')).toBe(
      ' --mcp-config "C:/work/repo/.spacron/mcp/claude.json"',
    );
  });
});

/**
 * Every shape below was read back off disk after running the real CLI's own
 * `mcp add`, not taken from documentation. They differ in section name, key
 * name and transport, and getting any of them wrong fails as a connection error
 * the CLI reports as an auth problem — so they are asserted exactly.
 */
describe('injectMcpConfigForAgent', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('gives Codex a TOML table with the streamable HTTP url — it has no SSE support', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('codex', 'C:/work/repo');

    expect(writtenGlobal('codex')).toBe(`[mcp_servers.spacron-mcp]\nurl = "${HTTP_URL}"\n`);
  });

  it('writes global configs off the project-scoped file commands', async () => {
    // `fs_write_file` rejects any path outside an open project, so routing the
    // Codex and droid configs through it failed silently and left both agents
    // with no tools. They must use the dedicated commands instead.
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('codex', 'C:/work/repo');
    await injectMcpConfigForAgent('droid', 'C:/work/repo');

    const fsWrites = invokeMock.mock.calls
      .filter(([cmd]) => cmd === 'fs_write_file')
      .map(([, args]) => args.path as string);
    expect(fsWrites.some((p) => p.includes('.codex') || p.includes('.factory'))).toBe(false);
    expect(writtenGlobal('codex')).toBeDefined();
    expect(writtenGlobal('droid')).toBeDefined();
  });

  it('replaces a stale Codex entry instead of appending a second one', async () => {
    const { injectMcpConfigForAgent } = await mockModule({
      codex:
        'model = "o3"\n\n[mcp_servers.spacron-mcp]\nurl = "http://127.0.0.1:99999/mcp?token=old"\n\n[projects.foo]\ntrust_level = "trusted"\n',
    });
    await injectMcpConfigForAgent('codex', 'C:/work/repo');

    const toml = writtenGlobal('codex')!;
    expect(toml.match(/\[mcp_servers\.spacron-mcp\]/g)).toHaveLength(1);
    expect(toml).not.toContain('token=old');
    expect(toml).toContain(`url = "${HTTP_URL}"`);
    // Unrelated tables the user hand-wrote must survive.
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('[projects.foo]');
  });

  it('gives Gemini `type: http` with `url` — not the `httpUrl` key from the docs', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('gemini', 'C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.gemini/settings.json')!)).toEqual({
      mcpServers: { 'spacron-mcp': { type: 'http', url: HTTP_URL } },
    });
  });

  it('gives opencode its `mcp` section and `remote` transport', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('opencode', 'C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/opencode.json')!)).toEqual({
      mcp: { 'spacron-mcp': { type: 'remote', url: HTTP_URL, enabled: true } },
    });
  });

  it('gives droid a global config — it has no project scope', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('droid', 'C:/work/repo');

    expect(JSON.parse(writtenGlobal('droid')!)).toEqual({
      mcpServers: { 'spacron-mcp': { type: 'http', url: HTTP_URL, disabled: false } },
    });
  });

  it('keeps droid servers the user added by hand', async () => {
    const { injectMcpConfigForAgent } = await mockModule({
      droid: '{"mcpServers":{"other":{"type":"stdio","command":"foo"}}}',
    });
    await injectMcpConfigForAgent('droid', 'C:/work/repo');

    const config = JSON.parse(writtenGlobal('droid')!);
    expect(config.mcpServers.other).toEqual({ type: 'stdio', command: 'foo' });
    expect(config.mcpServers['spacron-mcp'].url).toBe(HTTP_URL);
  });

  it('keeps other servers already in a config file', async () => {
    const { injectMcpConfigForAgent } = await mockModule({
      'C:/work/repo/opencode.json':
        '{"mcp":{"firecrawl":{"type":"local","command":["npx","-y","@firecrawl/mcp"]}},"tools":{"firecrawl_*":false}}',
    });
    await injectMcpConfigForAgent('opencode', 'C:/work/repo');

    const config = JSON.parse(written('C:/work/repo/opencode.json')!);
    expect(config.mcp.firecrawl).toBeDefined();
    expect(config.mcp['spacron-mcp'].url).toBe(HTTP_URL);
    expect(config.tools).toEqual({ 'firecrawl_*': false });
  });

  it('resolves the CLI through launchers so `npx opencode` is still opencode', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('npx opencode --foo', 'C:/work/repo');

    expect(written('C:/work/repo/opencode.json')).toBeDefined();
  });

  it('keeps Claude Code on SSE, which is the transport its config declares', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('claude', 'C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.mcp.json')!)).toEqual({
      mcpServers: { 'spacron-mcp': { type: 'sse', url: URL } },
    });
  });

  it('never throws when a config file cannot be written', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'mcp_server_url') return URL;
      if (cmd === 'mcp_server_http_url') return HTTP_URL;
      throw new Error('Access denied');
    });

    // A missing config costs the agent its tools; it must not stop the launch.
    await expect(injectMcpConfigForAgent('codex', 'C:/work/repo')).resolves.toBeUndefined();
  });
});

/**
 * Every file these writers touch inside the project carries `?token=`, and the
 * token is persistent on a fixed port — so one that reaches a commit stays a
 * working credential for process spawning and PTY writes. The standing brief
 * tells agents to commit as they go, so this is the guard that stops it.
 */
describe('ensureMcpConfigsIgnored', () => {
  const EXCLUDE = 'C:/work/repo/.git/info/exclude';

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('excludes every config that carries the token', async () => {
    const { ensureMcpConfigsIgnored } = await mockModule();
    await ensureMcpConfigsIgnored('C:/work/repo');

    const content = written(EXCLUDE)!;
    for (const path of ['.mcp.json', '.gemini/settings.json', '.cursor/mcp.json', 'opencode.json', '.spacron/']) {
      expect(content).toContain(path);
    }
  });

  it('runs before any config is written, so nothing is ever briefly trackable', async () => {
    const { ensureMcpConfigs } = await mockModule();
    await ensureMcpConfigs('C:/work/repo');

    const paths = invokeMock.mock.calls
      .filter(([cmd]) => cmd === 'fs_write_file')
      .map(([, args]) => args.path as string);
    expect(paths[0]).toBe(EXCLUDE);
    expect(paths).toContain('C:/work/repo/.mcp.json');
  });

  it('keeps entries the user already had', async () => {
    const { ensureMcpConfigsIgnored } = await mockModule({
      [EXCLUDE]: '# my own rules\nbuild/\n*.local\n',
    });
    await ensureMcpConfigsIgnored('C:/work/repo');

    const content = written(EXCLUDE)!;
    expect(content).toContain('build/');
    expect(content).toContain('*.local');
    expect(content).toContain('.mcp.json');
  });

  it('adds a missing separator when the file has no trailing newline', async () => {
    const { ensureMcpConfigsIgnored } = await mockModule({ [EXCLUDE]: 'build/' });
    await ensureMcpConfigsIgnored('C:/work/repo');

    expect(written(EXCLUDE)).toMatch(/^build\/\n/);
  });

  it('writes nothing when every entry is already present', async () => {
    // Project open calls this every time; it must not churn the file.
    const { ensureMcpConfigsIgnored } = await mockModule({
      [EXCLUDE]: '.mcp.json\n.gemini/settings.json\n.cursor/mcp.json\nopencode.json\n.spacron/\n',
    });
    await ensureMcpConfigsIgnored('C:/work/repo');

    expect(written(EXCLUDE)).toBeUndefined();
  });

  it('never throws when there is no git directory to write into', async () => {
    const { ensureMcpConfigsIgnored } = await mockModule();
    invokeMock.mockImplementation(async () => {
      throw new Error('Access denied: path is outside any open project');
    });

    await expect(ensureMcpConfigsIgnored('C:/work/repo')).resolves.toBeUndefined();
  });
});

/**
 * The roster is what makes delegation open-ended: the MCP tool schemas name
 * these agents, so anything missing here is invisible to a delegating agent no
 * matter how well the user configured it.
 */
describe('agent roster', () => {
  /**
   * One module epoch for the whole graph, so `runs`, `customAgents` and
   * `mcpBridge` share the same store instances — importing them across separate
   * `resetModules()` calls would hand back stores that don't see each other.
   */
  async function loadRoster() {
    vi.resetModules();
    invokeMock.mockImplementation(async () => undefined);
    const customAgents = await import('./customAgents');
    const runs = await import('./runs');
    const bridge = await import('./mcpBridge');
    // No localStorage under the node environment, so state persists in-module;
    // reset it explicitly rather than relying on a fresh backing store.
    customAgents.customAgents.set([]);
    customAgents.removedPresetAgents.set([]);
    return { ...customAgents, ...runs, ...bridge };
  }

  beforeEach(() => {
    invokeMock.mockReset();
  });

  /** The preset list from the last `mcp_set_agent_presets` call. */
  function lastRoster(): { command: string; name: string }[] | undefined {
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'mcp_set_agent_presets');
    if (calls.length === 0) return undefined;
    return calls[calls.length - 1][1].presets;
  }

  it('includes every built-in agent preset, not a hand-written subset', async () => {
    const { getAgentRoster } = await loadRoster();
    const commands = getAgentRoster().map((a) => a.command);

    // `pi` is the one that started this: it ships in the app but the MCP tool
    // description used to list a different, stale set, so a delegating agent
    // had no way to know it was there.
    expect(commands).toContain('pi');
    expect(commands).toContain('claude');
    expect(commands).toContain('codex');
    expect(commands).toContain('opencode');
    expect(commands).toContain('cursor-agent');
    // Non-agent presets are runs, not agents, and must not be delegatable.
    expect(commands).not.toContain('npm run dev');
  });

  it('carries display names so a caller can pass either form', async () => {
    const { getAgentRoster } = await loadRoster();
    expect(getAgentRoster()).toContainEqual({ command: 'pi', name: 'Pi AI Agent' });
  });

  it('includes custom agents the user added', async () => {
    const { addCustomAgent, getAgentRoster } = await loadRoster();

    addCustomAgent({ name: 'Aider', command: 'aider --no-auto-commits' });
    expect(getAgentRoster()).toContainEqual({
      command: 'aider --no-auto-commits',
      name: 'Aider',
    });
  });

  it('drops built-ins the user removed', async () => {
    const { removePresetAgent, getAgentRoster } = await loadRoster();

    removePresetAgent('grok');
    expect(getAgentRoster().map((a) => a.command)).not.toContain('grok');
  });

  it('publishes the roster to the server and republishes when it changes', async () => {
    const { initMcpBridge, addCustomAgent } = await loadRoster();

    initMcpBridge();
    // Subscribing pushes immediately, so the server is never left guessing.
    expect(lastRoster()?.map((a) => a.command)).toContain('pi');

    addCustomAgent({ name: 'Aider', command: 'aider' });
    expect(lastRoster()).toContainEqual({ command: 'aider', name: 'Aider' });
  });

  it('swallows a failed publish — an empty roster is permissive, not fatal', async () => {
    const { setMcpAgentPresets } = await mockModule();
    invokeMock.mockImplementation(async () => {
      throw new Error('no such command');
    });
    await expect(setMcpAgentPresets([{ command: 'claude', name: 'Claude Code' }])).resolves
      .toBeUndefined();
  });

  /**
   * A delegated worker is named by the server, before the spawn reaches the
   * frontend — the name is the handle `delegate_task` returns and the file the
   * worker reports to, so it cannot be assigned afterwards. Without this push the
   * server has no pool and falls back to `worker-a1b2c3`, which is the generic
   * naming this exists to stop.
   */
  it('publishes the app\'s assistant names so delegated workers get real ones', async () => {
    const { initMcpBridge } = await loadRoster();
    const { ASSISTANT_NAMES } = await import('$lib/services/orchestrator/agent-names');

    initMcpBridge();

    const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'mcp_set_assistant_names');
    expect(call).toBeDefined();
    expect(call![1].names).toEqual(ASSISTANT_NAMES);
    expect(call![1].names).toContain('Trinity');
  });

  it('swallows a failed name publish — the server has a fallback', async () => {
    const { setMcpAssistantNames } = await mockModule();
    invokeMock.mockImplementation(async () => {
      throw new Error('no such command');
    });
    await expect(setMcpAssistantNames(['Trinity'])).resolves.toBeUndefined();
  });
});

/**
 * `send_to_agent` and `bounce_task` used to write the message straight to the
 * PTY: no Enter, so it sat in the composer, and no bracketed paste, so every
 * newline submitted a fragment. The server now asks the frontend to type it and
 * blocks on the answer — which makes answering, correctly and always, this
 * handler's whole job.
 */
describe('MCP prompt delivery', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  afterEach(() => {
    vi.doUnmock('$lib/services/orchestrator/terminal-lease');
  });

  /** Boot the bridge with a stubbed sender and hand back the event handler. */
  async function loadDelivery(send: (id: number, message: string) => Promise<boolean>) {
    vi.resetModules();
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    listenMock.mockImplementation(async (name: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(name, cb);
      return () => {};
    });
    invokeMock.mockImplementation(async () => undefined);

    const sendSpy = vi.fn(send);
    vi.doMock('$lib/services/orchestrator/terminal-lease', () => ({
      applyOrchestratorAgentName: vi.fn(),
      sendOrchestratorGoalWhenReady: vi.fn(async () => true),
      sendOrchestratorFollowUpWhenReady: sendSpy,
    }));

    const bridge = await import('./mcpBridge');
    bridge.initMcpBridge();
    await vi.waitFor(() => expect(handlers.has('mcp:deliver-prompt')).toBe(true));
    return { fire: handlers.get('mcp:deliver-prompt')!, sendSpy };
  }

  /** The arguments of the last `mcp_deliver_respond` call. */
  function lastVerdict(): { requestId: string; success: boolean; error: string | null } | undefined {
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'mcp_deliver_respond');
    return calls.length ? calls[calls.length - 1][1] : undefined;
  }

  it('types the message through the same path that fixed the floating bar', async () => {
    const { fire, sendSpy } = await loadDelivery(async () => true);

    fire({ payload: { request_id: 'r1', session_id: 7, message: 'line one\nline two' } });
    await vi.waitFor(() => expect(lastVerdict()).toBeDefined());

    // Handed over whole — the delivery path brackets and submits it. Splitting
    // it here, or appending a bare newline, is what scattered these messages.
    expect(sendSpy).toHaveBeenCalledWith(7, 'line one\nline two');
    expect(lastVerdict()).toEqual({ requestId: 'r1', success: true, error: null });
  });

  it('reports a refused send as a failure instead of claiming it landed', async () => {
    const { fire } = await loadDelivery(async () => false);

    fire({ payload: { request_id: 'r2', session_id: 7, message: 'status?' } });
    await vi.waitFor(() => expect(lastVerdict()).toBeDefined());

    const verdict = lastVerdict()!;
    expect(verdict.success).toBe(false);
    expect(verdict.error).toBeTruthy();
  });

  it('always answers, even when the send throws', async () => {
    // The server blocks on this reply. Letting an exception escape would strand
    // the caller for the full delivery timeout with no explanation.
    const { fire } = await loadDelivery(async () => {
      throw new Error('pty exploded');
    });

    fire({ payload: { request_id: 'r3', session_id: 7, message: 'status?' } });
    await vi.waitFor(() => expect(lastVerdict()).toBeDefined());

    const verdict = lastVerdict()!;
    expect(verdict.success).toBe(false);
    expect(verdict.error).toContain('pty exploded');
  });
});
