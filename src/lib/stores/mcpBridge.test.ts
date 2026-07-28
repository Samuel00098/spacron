import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
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
