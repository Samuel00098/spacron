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
const deliverTurnSignalMock = vi.hoisted(() => vi.fn((_id: number, _s: unknown) => false));
const showToastMock = vi.hoisted(() => vi.fn());
/** Mirrors the report-filing result used by the bridge. */
const recordReportMock = vi.hoisted(() =>
  vi.fn((_id: number | null, _s: unknown, _name: string): { kind: 'filed'; projectId: string } | { kind: 'duplicate' } | null => null),
);
// Spread the real modules: `terminal.ts` imports both of these too, and a
// partial mock would leave its other imports undefined at module init.
vi.mock('$lib/services/orchestrator/agent-hook-signals', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  deliverTurnSignal: deliverTurnSignalMock,
}));
vi.mock('./notification', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  showToast: showToastMock,
}));
// `mcpBridge` reaches the orchestrator store only through a dynamic import (the
// static one would close a cycle through `terminal.ts`), so a bare factory is
// enough — nothing else in this module's graph imports it.
vi.mock('./orchestrator', () => ({ recordUnwatchedAgentReport: recordReportMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => 'C:/Users/test') }));

const URL = 'http://127.0.0.1:51234/sse?token=abc123';
const HTTP_URL = 'http://127.0.0.1:51234/mcp?token=abc123';
// The launch config now lives in the app config dir, not in the project — it
// has no project-specific content and used to put the server token in the tree.
const LAUNCH_CONFIG_PATH = 'C:/Users/dev/AppData/Roaming/spacron/mcp/claude.json';

/**
 * Mirrors the real command surface: only `mcp_server_url` and the file write.
 * Returns a freshly-imported module because `mcpBridge` caches the server URL
 * for the life of the module, so a stale import would leak between cases.
 */
async function mockBackend(opts: { url?: string | undefined; writeFails?: boolean } = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'mcp_server_url') return 'url' in opts ? opts.url : URL;
    if (cmd === 'mcp_server_http_url') return HTTP_URL;
    if (cmd === 'mcp_write_launch_config') {
      if (opts.writeFails) throw new Error('Could not write config');
      return LAUNCH_CONFIG_PATH;
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
async function mockModule(
  existingFiles: Record<string, string> = {},
  opts: {
    browserTools?: boolean;
    servers?: unknown[];
    /** What `browser_tools_status` answers; omitted = not installed. */
    browserStatus?: { cliPath: string | null; outputDir: string };
    /** Project roots that have a saved sign-in, and its file. */
    signIns?: Record<string, string>;
  } = {},
) {
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, string>) => {
    if (cmd === 'mcp_server_url') return URL;
    if (cmd === 'browser_tools_status') {
      return opts.browserStatus ? { version: '0.0.82', installedVersion: null, ...opts.browserStatus } : undefined;
    }
    if (cmd === 'browser_sign_in_state') {
      const path = opts.signIns?.[args?.projectRoot ?? ''];
      return { path: path ?? 'unused', exists: path !== undefined };
    }
    if (cmd === 'mcp_server_http_url') return HTTP_URL;
    if (cmd === 'fs_read_file') {
      const found = existingFiles[args?.path ?? ''];
      if (found === undefined) throw new Error('ENOENT');
      return found;
    }
    if (cmd === 'mcp_read_global_agent_config') {
      return existingFiles[args?.agent ?? ''] ?? '';
    }
    if (cmd === 'mcp_write_launch_config') return LAUNCH_CONFIG_PATH;
    return undefined;
  });
  vi.resetModules();
  // Imported after the reset so it is the same module instance `mcpBridge` will
  // read. Under `environment: 'node'` there is no window, so `persistentWritable`
  // hands back a plain in-memory store — no zustand or app-flag round trip.
  const { agentBrowserTools, mcpServers } = await import('./settings');
  agentBrowserTools.set(opts.browserTools === true);
  mcpServers.set((opts.servers ?? []) as never);
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

    expect(flags).toBe(` --mcp-config "${LAUNCH_CONFIG_PATH}"`);

    const write = invokeMock.mock.calls.find(([cmd]) => cmd === 'mcp_write_launch_config');
    expect(write).toBeDefined();
    // `type: 'sse'` is load-bearing — a bare url is read as streamable HTTP,
    // which the Rust server does not serve.
    expect(JSON.parse(write![1].content)).toEqual({
      mcpServers: { 'spacron-mcp': { type: 'sse', url: URL } },
    });
  });

  it('writes the token-bearing config outside the project', async () => {
    const mcpLaunchFlags = await mockBackend();
    await mcpLaunchFlags('claude', 'C:/work/repo');
    // Regression guard: this file carries `?token=`, which grants process
    // spawning and PTY-write access. It must never be written into the user's
    // working tree, where an agent committing as it goes could publish it.
    const projectWrites = invokeMock.mock.calls.filter(
      ([cmd, args]) => cmd === 'fs_write_file' && String(args?.path ?? '').includes('C:/work/repo'),
    );
    expect(projectWrites).toEqual([]);
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
    expect(invokeMock).not.toHaveBeenCalledWith('mcp_write_launch_config', expect.anything());
  });

  it('adds nothing when there is no project root to write into', async () => {
    const mcpLaunchFlags = await mockBackend();
    expect(await mcpLaunchFlags('claude', undefined)).toBe('');
  });

  it('adds nothing when the MCP server has no URL', async () => {
    const mcpLaunchFlags = await mockBackend({ url: undefined });
    expect(await mcpLaunchFlags('claude', 'C:/work/repo')).toBe('');
    expect(invokeMock).not.toHaveBeenCalledWith('mcp_write_launch_config', expect.anything());
  });

  it('falls back to a plain launch when the config cannot be written', async () => {
    const mcpLaunchFlags = await mockBackend({ writeFails: true });
    // An agent without cross-agent tools beats an agent that fails to start.
    expect(await mcpLaunchFlags('claude', 'C:/work/repo')).toBe('');
  });

  it('returns the same config path however the project root is spelled', async () => {
    const mcpLaunchFlags = await mockBackend();
    expect(await mcpLaunchFlags('claude', 'C:/work/repo/')).toBe(
      ` --mcp-config "${LAUNCH_CONFIG_PATH}"`,
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

    // `tool_timeout_sec`: Codex's 60s default is shorter than a generate_video call.
    expect(writtenGlobal('codex')).toBe(
      `[mcp_servers.spacron-mcp]\nurl = "${HTTP_URL}"\ntool_timeout_sec = 900\n`,
    );
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

  it('gives Qwen Code `httpUrl` — the key its Gemini fork kept', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('qwen', 'C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.qwen/settings.json')!)).toEqual({
      mcpServers: { 'spacron-mcp': { httpUrl: HTTP_URL } },
    });
  });

  it('gives Kiro and Amp a bare url, Amp under its dotted section key', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('kiro-cli', 'C:/work/repo');
    await injectMcpConfigForAgent('amp', 'C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.kiro/settings/mcp.json')!)).toEqual({
      mcpServers: { 'spacron-mcp': { url: HTTP_URL } },
    });
    expect(JSON.parse(written('C:/work/repo/.amp/settings.json')!)).toEqual({
      'amp.mcpServers': { 'spacron-mcp': { url: HTTP_URL } },
    });
  });

  it('gives Devin its uncommitted local file with a `transport` key', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    await injectMcpConfigForAgent('devin', 'C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.devin/config.local.json')!)).toEqual({
      mcpServers: { 'spacron-mcp': { url: HTTP_URL, transport: 'http' } },
    });
  });

  it('gives Antigravity a global `serverUrl` entry and keeps its other servers', async () => {
    const { injectMcpConfigForAgent } = await mockModule({
      agy: '{"mcpServers":{"firebase":{"command":"npx","args":["-y","firebase-tools"]}}}',
    });
    await injectMcpConfigForAgent('agy', 'C:/work/repo');

    const config = JSON.parse(writtenGlobal('agy')!);
    expect(config.mcpServers['spacron-mcp']).toEqual({ serverUrl: HTTP_URL, disabled: false });
    expect(config.mcpServers.firebase).toEqual({ command: 'npx', args: ['-y', 'firebase-tools'] });
  });

  it('never overwrites an Antigravity config it cannot parse', async () => {
    const { injectMcpConfigForAgent } = await mockModule({ agy: '{ not json' });
    await injectMcpConfigForAgent('agy', 'C:/work/repo');

    expect(writtenGlobal('agy')).toBeUndefined();
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
 * The Playwright MCP server is what gives an agent a browser to check its own
 * work in. It is opt-in because switching it on edits the user's *global* Codex
 * and droid configs and pulls a browser download on first run.
 */
describe('agent browser tools (Playwright MCP)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('adds nothing anywhere while the setting is off', async () => {
    const { injectMcpConfigForAgent } = await mockModule();
    for (const preset of ['claude', 'codex', 'gemini', 'opencode', 'droid', 'cursor']) {
      await injectMcpConfigForAgent(preset, 'C:/work/repo');
    }

    const everythingWritten = invokeMock.mock.calls
      .filter(([cmd]) => cmd === 'fs_write_file' || cmd === 'mcp_write_global_agent_config')
      .map(([, args]) => args.content as string)
      .join('\n');
    expect(everythingWritten).not.toContain('playwright');
  });

  it('gives Claude Code the stdio entry when switched on', async () => {
    const { injectMcpConfigForAgent } = await mockModule({}, { browserTools: true });
    await injectMcpConfigForAgent('claude', 'C:/work/repo');

    const config = JSON.parse(written('C:/work/repo/.mcp.json')!);
    expect(config.mcpServers['spacron-playwright']).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.82', '--isolated'],
    });
    // The Spacron server is still there — this is an addition, not a swap.
    expect(config.mcpServers['spacron-mcp']).toEqual({ type: 'sse', url: URL });
  });

  it("passes npx -y, or the server hangs on a prompt nobody can answer", async () => {
    const { injectMcpConfigForAgent } = await mockModule({}, { browserTools: true });
    await injectMcpConfigForAgent('claude', 'C:/work/repo');

    const { args } = JSON.parse(written('C:/work/repo/.mcp.json')!).mcpServers[
      'spacron-playwright'
    ];
    expect(args[0]).toBe('-y');
  });

  it('gives opencode its flat command array, not command + args', async () => {
    const { injectMcpConfigForAgent } = await mockModule({}, { browserTools: true });
    await injectMcpConfigForAgent('opencode', 'C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/opencode.json')!).mcp['spacron-playwright']).toEqual({
      type: 'local',
      command: ['npx', '-y', '@playwright/mcp@0.0.82', '--isolated'],
      enabled: true,
    });
  });

  it('gives Codex a TOML table with command and args split apart', async () => {
    const { injectMcpConfigForAgent } = await mockModule({}, { browserTools: true });
    await injectMcpConfigForAgent('codex', 'C:/work/repo');

    const toml = writtenGlobal('codex')!;
    expect(toml).toContain('[mcp_servers.spacron-playwright]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "@playwright/mcp@0.0.82", "--isolated"]');
    expect(toml).toContain('[mcp_servers.spacron-mcp]');
  });

  it('gives the Codex browser entry a startup timeout npx can actually meet', async () => {
    // The regression this guards is invisible from the outside: without an
    // explicit timeout Codex applies its 10s default, `npx -y @playwright/mcp`
    // needs more than that even on a warm cache, and the server times out on
    // every launch. The agent then runs with no browser tools and nothing
    // anywhere says why — so assert the key is present, not merely the block.
    const { injectMcpConfigForAgent } = await mockModule({}, { browserTools: true });
    await injectMcpConfigForAgent('codex', 'C:/work/repo');

    const toml = writtenGlobal('codex')!;
    const timeout = /^startup_timeout_sec = (\d+)$/m.exec(toml);
    expect(timeout).not.toBeNull();
    expect(Number(timeout![1])).toBeGreaterThan(10);
  });

  it('sizes the startup budget above every CLI default npx overruns', async () => {
    // The measured cost of `npx -y @playwright/mcp@latest` on a *warm* cache is
    // ~28s on Windows, because the `@latest` tag re-resolves against the
    // registry every launch. That overruns Codex's 10s default and Claude
    // Code's 30s one, and a cold run that downloads the package and a browser
    // is far slower again. Both CLIs take this same budget — Codex through
    // `startup_timeout_sec`, Claude Code through `MCP_TIMEOUT` in the agent's
    // PTY env — so the floor is asserted once, here, on the shared constant.
    const { BROWSER_STARTUP_TIMEOUT_SEC, BROWSER_STARTUP_TIMEOUT_MS, BROWSER_TOOL_TIMEOUT_MS } =
      await mockModule({}, { browserTools: true });

    expect(BROWSER_STARTUP_TIMEOUT_SEC).toBeGreaterThanOrEqual(60);
    expect(BROWSER_STARTUP_TIMEOUT_MS).toBe(BROWSER_STARTUP_TIMEOUT_SEC * 1000);
    // A tool call navigates a real page, so it must outlast merely starting up.
    expect(BROWSER_TOOL_TIMEOUT_MS).toBeGreaterThan(BROWSER_STARTUP_TIMEOUT_MS);
  });

  it('removes the entry again when the setting is turned back off', async () => {
    // The regression that matters: a toggle that only ever adds would leave a
    // dead server in every config the user ever opened a project with.
    const stale = JSON.stringify({
      mcpServers: {
        'spacron-mcp': { type: 'sse', url: URL },
        'spacron-playwright': { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
    });
    const { injectMcpConfigForAgent } = await mockModule({ 'C:/work/repo/.mcp.json': stale });
    await injectMcpConfigForAgent('claude', 'C:/work/repo');

    const config = JSON.parse(written('C:/work/repo/.mcp.json')!);
    expect(config.mcpServers['spacron-playwright']).toBeUndefined();
    expect(config.mcpServers['spacron-mcp']).toBeDefined();
  });

  it('runs the pinned install with node, and keeps its output out of the project', async () => {
    const { injectMcpConfigForAgent } = await mockModule({}, {
      browserTools: true,
      browserStatus: { cliPath: 'C:\\Users\\dev\\AppData\\Roaming\\spacron\\tools\\playwright-mcp\\node_modules\\@playwright\\mcp\\cli.js', outputDir: 'C:\\Temp\\spacron-playwright\\agents' },
    });
    await injectMcpConfigForAgent('claude', 'C:/work/repo');

    const entry = JSON.parse(written('C:/work/repo/.mcp.json')!).mcpServers['spacron-playwright'];
    expect(entry.command).toBe('node');
    expect(entry.args[0]).toMatch(/cli\.js$/);
    expect(entry.args).toContain('--isolated');
    expect(entry.args.slice(entry.args.indexOf('--output-dir'))).toEqual(['--output-dir', 'C:\\Temp\\spacron-playwright\\agents']);
  });

  it('escapes Windows paths in the Codex TOML', async () => {
    const { injectMcpConfigForAgent } = await mockModule({}, {
      browserTools: true,
      browserStatus: { cliPath: 'C:\\tools\\cli.js', outputDir: 'C:\\Temp\\out' },
    });
    await injectMcpConfigForAgent('codex', 'C:/work/repo');

    const toml = writtenGlobal('codex')!;
    // A bare backslash is an escape in a TOML basic string; `\t` would have
    // become a tab and the path would point nowhere.
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["C:\\\\tools\\\\cli.js", "--isolated", "--output-dir", "C:\\\\Temp\\\\out"]');
  });

  it("starts a project's agents from its saved sign-in, but never writes one into a global config", async () => {
    const signIns = { 'C:/work/repo': 'C:\\Users\\dev\\AppData\\Roaming\\spacron\\browser-state\\abc.json' };
    const { injectMcpConfigForAgent } = await mockModule({}, { browserTools: true, signIns });
    await injectMcpConfigForAgent('opencode', 'C:/work/repo');
    await injectMcpConfigForAgent('codex', 'C:/work/repo');

    const opencode = JSON.parse(written('C:/work/repo/opencode.json')!).mcp['spacron-playwright'].command as string[];
    expect(opencode.slice(opencode.indexOf('--storage-state'))).toEqual(['--storage-state', signIns['C:/work/repo']]);
    expect(opencode).toContain('--isolated');
    // Codex's config serves every project: one project's cookies must not leak
    // into another project's agents.
    expect(writtenGlobal('codex')).not.toContain('--storage-state');
  });

  it('pins the same Playwright MCP version as the Rust side', async () => {
    const { PLAYWRIGHT_MCP_VERSION } = await mockModule();
    const { readFileSync } = await import('node:fs');
    const rust = readFileSync('src-tauri/src/commands/browser_tools.rs', 'utf8');
    const pinned = rust.match(/pub const PLAYWRIGHT_MCP_VERSION: &str = "([^"]+)";/)?.[1];
    expect(pinned).toBe(PLAYWRIGHT_MCP_VERSION);
  });

  it("leaves a playwright server the user configured themselves alone", async () => {
    // Why the key is `spacron-playwright` and not the bare `playwright` upstream
    // documents: the off-switch deletes by key, and it must never delete theirs.
    const theirs = JSON.stringify({
      mcpServers: { playwright: { command: 'node', args: ['./my-own-playwright.js'] } },
    });
    const { injectMcpConfigForAgent } = await mockModule({ 'C:/work/repo/.mcp.json': theirs });
    await injectMcpConfigForAgent('claude', 'C:/work/repo');

    const config = JSON.parse(written('C:/work/repo/.mcp.json')!);
    expect(config.mcpServers.playwright).toEqual({
      command: 'node',
      args: ['./my-own-playwright.js'],
    });
  });

  it('removes a stale Codex table without disturbing the rest of the file', async () => {
    const { injectMcpConfigForAgent } = await mockModule({
      codex:
        'model = "o3"\n\n[mcp_servers.spacron-playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@latest"]\n\n[projects.foo]\ntrust_level = "trusted"\n',
    });
    await injectMcpConfigForAgent('codex', 'C:/work/repo');

    const toml = writtenGlobal('codex')!;
    expect(toml).not.toContain('spacron-playwright');
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('[projects.foo]');
    // Regression: the strip must consume the args line too — the `[` inside the
    // array used to end the removal early, orphaning `["-y", …]` at top level
    // where TOML reads it as an unclosed table and Codex refuses to start.
    expect(toml).not.toContain('"-y"');
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
    for (const path of ['.mcp.json', '.gemini/settings.json', '.cursor/mcp.json', 'opencode.json']) {
      expect(content).toContain(path);
    }
  });

  /**
   * Regression: this list used to carry a bare `.spacron/`, and it silently broke
   * staging. Git never descends into an excluded DIRECTORY, so the
   * `!/.spacron/memory/` exception below it was never evaluated and the whole
   * tree went dark. `git add .spacron/memory/INDEX.md` — a TRACKED file — then
   * failed with “paths are ignored by one of your .gitignore files”, which the
   * Source Control pane showed as “Failed to stage the selected files”.
   *
   * `workspace.rs` migrates the bare form away on worktree creation, so a bare
   * form re-added here does not just sit there: it undoes that repair on every
   * project open, and the bug comes back seconds after anyone hand-fixes it.
   */
  it('excludes the .spacron contents, never the directory, so the memory exception is reachable', async () => {
    const { ensureMcpConfigsIgnored } = await mockModule();
    await ensureMcpConfigsIgnored('C:/work/repo');

    const content = written(EXCLUDE)!;
    const rules = content.split('\n').map((l) => l.trim());

    expect(rules).toContain('/.spacron/*');
    expect(rules).toContain('!/.spacron/memory/');
    expect(rules.some((l) => l === '.spacron/' || l === '/.spacron/')).toBe(false);

    // The exception is only honoured when it follows the rule it exempts.
    expect(rules.indexOf('!/.spacron/memory/')).toBeGreaterThan(rules.indexOf('/.spacron/*'));
  });

  it('leaves an exclude file that already carries the rule pair alone', async () => {
    // Project open calls this every time. Re-appending the pair would grow the
    // file without bound, and the unslashed spelling is the same rule.
    const { ensureMcpConfigsIgnored } = await mockModule({
      [EXCLUDE]:
        '.mcp.json\n.gemini/settings.json\n.cursor/mcp.json\nopencode.json\n.qwen/settings.json\n' +
        '.kiro/settings/mcp.json\n.amp/settings.json\n.devin/config.local.json\n.spacron/*\n!.spacron/memory/\n',
    });
    await ensureMcpConfigsIgnored('C:/work/repo');

    expect(written(EXCLUDE)).toBeUndefined();
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

  it('deletes the legacy in-project Claude config on project open', async () => {
    // Moving the config to the app config dir only stops NEW copies appearing.
    // Every project that ever launched a Claude agent still holds the old file,
    // and it carries a live `?token=` granting process spawning and PTY-write —
    // so opening the project has to clean it up, or the exposure never ends.
    const { ensureMcpConfigs } = await mockModule();
    await ensureMcpConfigs('C:/work/repo');

    expect(invokeMock).toHaveBeenCalledWith('fs_delete', {
      path: 'C:/work/repo/.spacron/mcp/claude.json',
    });
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
      [EXCLUDE]:
        '.mcp.json\n.gemini/settings.json\n.cursor/mcp.json\nopencode.json\n.qwen/settings.json\n' +
        '.kiro/settings/mcp.json\n.amp/settings.json\n.devin/config.local.json\n/.spacron/*\n!/.spacron/memory/\n',
    });
    await ensureMcpConfigsIgnored('C:/work/repo');

    expect(written(EXCLUDE)).toBeUndefined();
  });

  it('repairs a legacy bare `.spacron/` by appending the rule and its exception', async () => {
    // Older installs wrote the bare directory form. Leaving it in place keeps
    // the shared memory unstageable, so the corrected pair has to be appended
    // AFTER it, where it wins.
    const { ensureMcpConfigsIgnored } = await mockModule({
      [EXCLUDE]: '.mcp.json\n.spacron/\n',
    });
    await ensureMcpConfigsIgnored('C:/work/repo');

    const rules = written(EXCLUDE)!.split('\n').map((l) => l.trim());
    expect(rules.indexOf('/.spacron/*')).toBeGreaterThan(rules.indexOf('.spacron/'));
    expect(rules.indexOf('!/.spacron/memory/')).toBeGreaterThan(rules.indexOf('/.spacron/*'));
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

// ---------------------------------------------------------------------------
// report_status — an agent telling Spacron about its own turn
// ---------------------------------------------------------------------------

describe('handleAgentReport', () => {
  beforeEach(() => {
    deliverTurnSignalMock.mockReset().mockReturnValue(false);
    showToastMock.mockReset();
    recordReportMock.mockReset().mockReturnValue(null);
  });

  it('ends the turn of the session the token identified', async () => {
    deliverTurnSignalMock.mockReturnValue(true);
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: 4, state: 'done', detail: 'Tests pass.' });

    // The agent's own sentence rides along, so the card and the inbox row have
    // something to say beyond the agent's name.
    expect(deliverTurnSignalMock).toHaveBeenCalledWith(4, {
      kind: 'finished',
      detail: 'Tests pass.',
    });
    // The orchestrator's completion card is the single visual surface for a
    // turn that ended; a toast here would double-notify.
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('carries the agent\'s own words as the blocked reason', async () => {
    deliverTurnSignalMock.mockReturnValue(true);
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({
      sessionId: 4,
      state: 'needs_input',
      detail: 'Which database should I migrate?',
    });

    expect(deliverTurnSignalMock).toHaveBeenCalledWith(4, {
      kind: 'blocked',
      reason: 'Which database should I migrate?',
    });
  });

  it('falls back to a generic reason when the agent said nothing', async () => {
    deliverTurnSignalMock.mockReturnValue(true);
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: 4, state: 'needs_input', detail: '' });

    expect(deliverTurnSignalMock).toHaveBeenCalledWith(4, {
      kind: 'blocked',
      reason: 'The agent is waiting for your input.',
    });
  });

  it('notifies instead when no watcher is armed for that session', async () => {
    deliverTurnSignalMock.mockReturnValue(false);
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: 4, state: 'needs_input', detail: 'Need a key.' });

    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock.mock.calls[0][0]).toContain('Need a key.');
    expect(showToastMock.mock.calls[0][1]).toBe('warning');
  });

  it('shows an unattributed report without pretending to know who sent it', async () => {
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: null, state: 'failed', detail: 'Build broke.' });

    // No session means no turn to end — the report is still worth showing.
    expect(deliverTurnSignalMock).not.toHaveBeenCalled();
    expect(showToastMock.mock.calls[0][0]).toBe('An agent failed: Build broke.');
    expect(showToastMock.mock.calls[0][1]).toBe('error');
  });

  it('ignores progress pings', async () => {
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: 4, state: 'working', detail: 'Still going.' });

    // An agent that says "still going" every few minutes must not notify.
    expect(deliverTurnSignalMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
    expect(recordReportMock).not.toHaveBeenCalled();
  });

  it('files a report no watcher took into the inbox', async () => {
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: 4, state: 'needs_input', detail: 'Need a key.' });

    // A toast is gone in eight seconds. The durable card is what survives the
    // user looking away, which is the whole reason the inbox exists.
    expect(recordReportMock).toHaveBeenCalledWith(
      4,
      { kind: 'blocked', reason: 'Need a key.' },
      expect.any(String),
    );
  });

  it('files an unattributed report too', async () => {
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: null, state: 'failed', detail: 'Build broke.' });

    expect(recordReportMock).toHaveBeenCalledWith(
      null,
      { kind: 'failed', reason: 'Build broke.' },
      'An agent',
    );
  });

  it('does not also toast when the card is on screen', async () => {
    // The card and a toast for one event is the double-notification the inbox
    // work removed — so the toast is only for a card the user cannot see.
    const { handleAgentReport } = await mockModule();
    // Imported after the module reset, so this is the same instance the bridge
    // reads the active project from.
    const { setActiveTerminalProject } = await import('./terminal');
    setActiveTerminalProject('proj-1');
    recordReportMock.mockReturnValue({ kind: 'filed', projectId: 'proj-1' });

    await handleAgentReport({ sessionId: 4, state: 'done', detail: 'Shipped.' });

    expect(showToastMock).not.toHaveBeenCalled();
    setActiveTerminalProject(null);
  });

  it('still toasts a report filed under a project the user is not looking at', async () => {
    const { handleAgentReport } = await mockModule();
    recordReportMock.mockReturnValue({ kind: 'filed', projectId: 'some-other-project' });

    await handleAgentReport({ sessionId: 4, state: 'needs_input', detail: 'Need a key.' });

    // A missed "needs input" strands the user waiting on an agent that is
    // waiting on them, so a card they cannot see is not enough on its own.
    expect(showToastMock).toHaveBeenCalledTimes(1);
  });

  it('does not toast an anonymous report already filed as a duplicate', async () => {
    const { handleAgentReport } = await mockModule();
    recordReportMock.mockReturnValue({ kind: 'duplicate' });

    await handleAgentReport({ sessionId: null, state: 'done', detail: 'Tests pass.' });

    expect(showToastMock).not.toHaveBeenCalled();
  });
});

describe('per-agent MCP identity', () => {
  /** Backend where minting works; records what was bound. */
  async function mockWithChannels(opts: { mintFails?: boolean; bound?: boolean } = {}) {
    const binds: { token: string; sessionId: number }[] = [];
    // Reset the call log too: `launchConfig()` reads it back, and a previous
    // case's write would otherwise be the one it found.
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'mcp_server_url') return URL;
      if (cmd === 'mcp_server_http_url') return HTTP_URL;
      if (cmd === 'mcp_write_launch_config') return LAUNCH_CONFIG_PATH;
      if (cmd === 'mcp_open_agent_channel') {
        if (opts.mintFails) throw new Error('server not running');
        return {
          url: 'http://127.0.0.1:51234/sse?token=per-launch-token',
          httpUrl: 'http://127.0.0.1:51234/mcp?token=per-launch-token',
          token: 'per-launch-token',
        };
      }
      if (cmd === 'mcp_bind_agent_channel') {
        binds.push({
          token: args?.token as string,
          sessionId: args?.sessionId as number,
        });
        return opts.bound !== false;
      }
      return undefined;
    });
    vi.resetModules();
    const mod = await import('./mcpBridge');
    return { mod, binds };
  }

  /** The config JSON `mcpLaunchFlags` handed to `mcp_write_launch_config`. */
  function launchConfig(): { mcpServers: Record<string, { url?: string }> } {
    const writes = invokeMock.mock.calls.filter(
      (call: unknown[]) => call[0] === 'mcp_write_launch_config',
    );
    const call = writes[writes.length - 1];
    return JSON.parse((call?.[1] as { content: string }).content);
  }

  it('writes the per-launch token into the agent config and binds it', async () => {
    const { mod, binds } = await mockWithChannels();

    await mod.mcpLaunchFlags('claude', 'C:/work/repo', 77);

    expect(launchConfig().mcpServers['spacron-mcp'].url).toContain('per-launch-token');
    expect(binds).toEqual([{ token: 'per-launch-token', sessionId: 77 }]);
  });

  it('falls back to the shared token when the session is unknown', async () => {
    const { mod, binds } = await mockWithChannels();

    await mod.mcpLaunchFlags('claude', 'C:/work/repo');

    expect(launchConfig().mcpServers['spacron-mcp'].url).toBe(URL);
    expect(binds).toEqual([]);
  });

  it('still launches the agent when minting fails', async () => {
    // Losing attribution is a downgrade; failing to launch is not acceptable.
    const { mod } = await mockWithChannels({ mintFails: true });

    const flags = await mod.mcpLaunchFlags('claude', 'C:/work/repo', 77);

    expect(flags).toContain('--mcp-config');
    expect(launchConfig().mcpServers['spacron-mcp'].url).toBe(URL);
  });

  it('uses the token even if the server declines to bind it', async () => {
    // A refused bind means reports arrive unattributed, which the report
    // handler already covers — it is not a reason to hand out no config.
    const { mod } = await mockWithChannels({ bound: false });

    const flags = await mod.mcpLaunchFlags('claude', 'C:/work/repo', 77);

    expect(flags).toContain('--mcp-config');
    expect(launchConfig().mcpServers['spacron-mcp'].url).toContain('per-launch-token');
  });
});

describe('each reported state maps to its own outcome', () => {
  beforeEach(() => {
    deliverTurnSignalMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
  });

  it('reports a failure as a failure, not as needs-input', async () => {
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: 2, state: 'failed', detail: 'Migration conflict.' });

    expect(deliverTurnSignalMock).toHaveBeenCalledWith(2, {
      kind: 'failed',
      reason: 'Migration conflict.',
    });
  });

  it('gives a bare failure its own wording', async () => {
    const { handleAgentReport } = await mockModule();

    await handleAgentReport({ sessionId: 2, state: 'failed', detail: '' });

    expect(deliverTurnSignalMock).toHaveBeenCalledWith(2, {
      kind: 'failed',
      reason: 'The agent reported that it could not finish.',
    });
  });

  it('keeps the three states on three different outcome kinds', async () => {
    const { handleAgentReport } = await mockModule();
    for (const state of ['done', 'needs_input', 'failed'] as const) {
      await handleAgentReport({ sessionId: 2, state, detail: '' });
    }
    const kinds = deliverTurnSignalMock.mock.calls.map(
      ([, signal]) => (signal as { kind: string }).kind,
    );
    expect(kinds).toEqual(['finished', 'blocked', 'failed']);
  });
});

/**
 * User-managed MCP servers. Everything here is about the two invariants in
 * `services/mcp-servers.ts`: we only ever write inside our own `spacron-`
 * namespace, and every write reconciles that namespace against the list rather
 * than blindly adding to it.
 */
describe('user MCP servers', () => {
  const linear = {
    id: 'a',
    name: 'Linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: { Authorization: 'Bearer tok' },
    enabled: true,
  };
  const localTool = {
    id: 'b',
    name: 'My Tool',
    transport: 'stdio',
    command: 'node',
    args: ['./tool.js'],
    enabled: true,
  };

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('gives every CLI the server in its own dialect', async () => {
    const { ensureMcpConfigs } = await mockModule({}, { servers: [linear] });
    await ensureMcpConfigs('C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.mcp.json')!).mcpServers['spacron-linear']).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer tok' },
    });
    expect(JSON.parse(written('C:/work/repo/.cursor/mcp.json')!).mcpServers['spacron-linear'])
      .toMatchObject({ type: 'http' });
    expect(JSON.parse(written('C:/work/repo/.gemini/settings.json')!).mcpServers['spacron-linear'])
      .toMatchObject({ type: 'http' });
    // opencode renames the transport and demands an explicit `enabled`.
    expect(JSON.parse(written('C:/work/repo/opencode.json')!).mcp['spacron-linear']).toEqual({
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer tok' },
    });
    expect(JSON.parse(writtenGlobal('droid')!).mcpServers['spacron-linear'])
      .toMatchObject({ disabled: false });
    expect(writtenGlobal('codex')).toContain('[mcp_servers.spacron-linear]');
    const auth = { Authorization: 'Bearer tok' };
    const url = 'https://mcp.linear.app/mcp';
    expect(JSON.parse(written('C:/work/repo/.qwen/settings.json')!).mcpServers['spacron-linear'])
      .toEqual({ httpUrl: url, headers: auth });
    expect(JSON.parse(written('C:/work/repo/.kiro/settings/mcp.json')!).mcpServers['spacron-linear'])
      .toEqual({ url, headers: auth });
    expect(JSON.parse(written('C:/work/repo/.amp/settings.json')!)['amp.mcpServers']['spacron-linear'])
      .toEqual({ url, headers: auth });
    expect(JSON.parse(written('C:/work/repo/.devin/config.local.json')!).mcpServers['spacron-linear'])
      .toEqual({ url, transport: 'http', headers: auth });
    expect(JSON.parse(writtenGlobal('agy')!).mcpServers['spacron-linear'])
      .toEqual({ serverUrl: url, disabled: false, headers: auth });
  });

  it('writes a local server as a command, not a URL', async () => {
    const { ensureMcpConfigs } = await mockModule({}, { servers: [localTool] });
    await ensureMcpConfigs('C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.mcp.json')!).mcpServers['spacron-my-tool']).toEqual({
      command: 'node',
      args: ['./tool.js'],
    });
    expect(JSON.parse(written('C:/work/repo/opencode.json')!).mcp['spacron-my-tool']).toEqual({
      type: 'local',
      command: ['node', './tool.js'],
      enabled: true,
    });
    expect(writtenGlobal('codex')).toContain('command = "node"');
  });

  it('removes a server the user deleted from every config', async () => {
    const stale = {
      'C:/work/repo/.mcp.json': JSON.stringify({
        mcpServers: { 'spacron-linear': { type: 'http', url: 'https://old' } },
      }),
      'C:/work/repo/opencode.json': JSON.stringify({
        mcp: { 'spacron-linear': { type: 'remote', url: 'https://old', enabled: true } },
      }),
      codex: '[mcp_servers.spacron-linear]\nurl = "https://old"\n',
    };
    const { ensureMcpConfigs } = await mockModule(stale, { servers: [] });
    await ensureMcpConfigs('C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.mcp.json')!).mcpServers['spacron-linear']).toBeUndefined();
    expect(JSON.parse(written('C:/work/repo/opencode.json')!).mcp['spacron-linear']).toBeUndefined();
    expect(writtenGlobal('codex')).not.toContain('spacron-linear');
  });

  it("leaves a server the user configured by hand alone", async () => {
    const existing = {
      'C:/work/repo/.mcp.json': JSON.stringify({
        mcpServers: { linear: { type: 'http', url: 'https://mine' } },
      }),
      codex: '[mcp_servers.linear]\nurl = "https://mine"\n',
    };
    const { ensureMcpConfigs } = await mockModule(existing, { servers: [] });
    await ensureMcpConfigs('C:/work/repo');

    expect(JSON.parse(written('C:/work/repo/.mcp.json')!).mcpServers.linear).toEqual({
      type: 'http',
      url: 'https://mine',
    });
    expect(writtenGlobal('codex')).toContain('[mcp_servers.linear]');
  });

  it("keeps Spacron's own entries while pruning the namespace", async () => {
    const stale = {
      'C:/work/repo/.mcp.json': JSON.stringify({
        mcpServers: { 'spacron-mcp': { type: 'sse', url: 'http://old' }, 'spacron-gone': {} },
      }),
    };
    const { ensureMcpConfigs } = await mockModule(stale, { servers: [] });
    await ensureMcpConfigs('C:/work/repo');

    const config = JSON.parse(written('C:/work/repo/.mcp.json')!);
    expect(config.mcpServers['spacron-mcp']).toEqual({ type: 'sse', url: URL });
    expect(config.mcpServers['spacron-gone']).toBeUndefined();
  });

  it('gives a Claude launch config the user servers too', async () => {
    const { mcpLaunchFlags } = await mockModule({}, { servers: [linear] });
    await mcpLaunchFlags('claude', 'C:/work/repo');

    const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'mcp_write_launch_config');
    expect(JSON.parse(call![1].content).mcpServers['spacron-linear']).toMatchObject({ type: 'http' });
  });

  it('writes nothing for a row that is disabled or invalid', async () => {
    const { ensureMcpConfigs } = await mockModule({}, {
      servers: [
        { ...linear, enabled: false },
        { id: 'c', name: 'Bad', transport: 'http', url: 'nonsense', enabled: true },
      ],
    });
    await ensureMcpConfigs('C:/work/repo');

    const config = JSON.parse(written('C:/work/repo/.mcp.json')!);
    expect(Object.keys(config.mcpServers)).toEqual(['spacron-mcp']);
  });
});

describe('Codex on a box gets its servers on the command line', () => {
  it('turns servers into single-quoted -c overrides and skips what it cannot carry', async () => {
    const { codexServerFlags } = await import('./mcpBridge');
    const flags = codexServerFlags([
      { key: 'spacron-gmail', server: { id: '1', name: 'gmail', transport: 'http', url: 'http://127.0.0.1:4000/proxy/spacron-gmail?token=abc', enabled: true } },
      { key: 'spacron-fs', server: { id: '2', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@x/fs', ' '], env: { ROOT: '/data' }, enabled: true } },
      { key: 'spacron-keyed', server: { id: '3', name: 'keyed', transport: 'http', url: 'https://k', headers: { 'X-Api-Key': 's' }, enabled: true } },
      { key: 'spacron-quote', server: { id: '4', name: 'quote', transport: 'http', url: "https://q/it's", enabled: true } },
    ], 'http://127.0.0.1:7000/mcp?token=t');
    expect(flags).toContain(`-c 'mcp_servers.spacron-mcp.url="http://127.0.0.1:7000/mcp?token=t"'`);
    expect(flags).toContain(`-c 'mcp_servers.spacron-gmail.url="http://127.0.0.1:4000/proxy/spacron-gmail?token=abc"'`);
    expect(flags).toContain(`-c 'mcp_servers.spacron-fs.command="npx"'`);
    expect(flags).toContain(`-c 'mcp_servers.spacron-fs.args=["-y", "@x/fs"]'`);
    expect(flags).toContain(`-c 'mcp_servers.spacron-fs.env={ "ROOT" = "/data" }'`);
    expect(flags).not.toContain('spacron-keyed');
    expect(flags).not.toContain('spacron-quote');
    expect(codexServerFlags([], null)).toBe('');
  });
});
