/**
 * MCP configs when the workspace is a remote box: global configs (Droid,
 * Antigravity, Codex) are written on the box too, shared sign-ins go through
 * the box's own proxy, and the box learns which agents and servers agents it
 * starts on its own should get.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const boxInvoke = vi.hoisted(() => vi.fn());
const boxFiles = vi.hoisted(() => new Map<string, string>());

vi.mock('./orchestrator', () => ({ recordUnwatchedAgentReport: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => '/home/me') }));
vi.mock('./runs', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getAgentRoster: () => [{ command: 'claude', name: 'Claude Code' }, { command: 'codex', name: 'Codex' }] }));
vi.mock('$lib/services/backend', () => ({ backendInvoke: boxInvoke }));
vi.mock('./remoteWorkspace', async () => {
  const { writable, derived } = await import('./storeCompat');
  const remoteTarget = writable<object | null>({ url: 'ws://box:9000/pty', token: 't' });
  return {
    remoteTarget, activeRemoteId: writable('box-1'), activeConnection: derived(remoteTarget, (t) => (t ? { id: 'box-1', name: 'my-vps' } : null)),
    getRemoteToken: async () => 't',
  };
});

const SERVERS = [
  { id: '1', name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer k' }, enabled: true },
  { id: '2', name: 'Gmail', transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', enabled: true, oauth: true, catalogId: 'gmail' },
  { id: '3', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], enabled: true },
];

beforeEach(() => {
  vi.resetModules();
  boxFiles.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'mcp_server_url') return 'http://127.0.0.1:51234/sse?token=desk';
    if (cmd === 'mcp_server_http_url') return 'http://127.0.0.1:51234/mcp?token=desk';
    if (cmd === 'mcp_read_global_agent_config') return '';
    return undefined;
  });
  boxInvoke.mockReset();
  boxInvoke.mockImplementation(async (cmd: string, args?: Record<string, string>) => {
    if (cmd === 'box_global_agent_config_read') return boxFiles.get(args!.agent) ?? '';
    if (cmd === 'box_global_agent_config_write') { boxFiles.set(args!.agent, args!.content); return { ok: true }; }
    if (cmd === 'fs_read_file') throw new Error('ENOENT');
    return { ok: true };
  });
});

async function setup() {
  const { mcpServers } = await import('./settings');
  mcpServers.set(SERVERS as never);
  const signins = await import('$lib/services/box-signins');
  signins.boxMcpInfo.set({ proxyBase: 'http://127.0.0.1:4100/proxy', token: 'boxsecret', shared: ['spacron-gmail'], mcpUrl: 'http://127.0.0.1:4100/mcp?token=boxsecret', os: 'linux', desktop: 'virtual' });
  return import('./mcpBridge');
}

it('writes Droid, Antigravity and Codex configs on the box, with box URLs for shared sign-ins', async () => {
  const mod = await setup();
  await mod.ensureMcpConfigs('/home/me/work/app');
  for (const agent of ['droid', 'agy', 'codex']) expect(boxFiles.has(agent), agent).toBe(true);
  const droid = JSON.parse(boxFiles.get('droid')!).mcpServers;
  expect(droid['spacron-gmail'].url).toBe('http://127.0.0.1:4100/proxy/spacron-gmail?token=boxsecret');
  expect(droid['spacron-box'].url).toBe('http://127.0.0.1:4100/mcp?token=boxsecret');
  expect(droid['spacron-linear'].url).toBe('https://mcp.linear.app/mcp');
  const agy = JSON.parse(boxFiles.get('agy')!).mcpServers;
  expect(JSON.stringify(agy['spacron-gmail'])).toContain('127.0.0.1:4100/proxy/spacron-gmail');
  expect(boxFiles.get('codex')).toContain('[mcp_servers.spacron-box]');
  expect(boxFiles.get('codex')).toContain('127.0.0.1:4100/proxy/spacron-gmail');
  // The box's browser runs there through npx, not this PC's Playwright path.
  // And this computer's own global files keep this computer's URLs.
  const localDroid = invokeMock.mock.calls.find((c) => c[0] === 'mcp_write_global_agent_config' && c[1].agent === 'droid');
  expect(localDroid).toBeDefined();
  expect(localDroid![1].content).not.toContain('4100');
});

it('tells the box which agents exist and what servers agents it starts get', async () => {
  const mod = await setup();
  await mod.ensureMcpConfigs('/home/me/work/app');
  const sync = boxInvoke.mock.calls.find((c) => c[0] === 'box_agents_config_sync')![1] as { presets: unknown[]; mcpServers: Record<string, { url?: string }>; codexFlags: string };
  expect(sync.presets).toEqual([{ command: 'claude', name: 'Claude Code' }, { command: 'codex', name: 'Codex' }]);
  expect(sync.mcpServers['spacron-gmail'].url).toBe('http://127.0.0.1:4100/proxy/spacron-gmail?token=boxsecret');
  expect(sync.mcpServers['spacron-box']).toBeUndefined(); // the box adds its own, per agent
  expect(sync.mcpServers['spacron-mcp'].url).toBe('http://127.0.0.1:51234/sse?token=desk');
  expect(sync.codexFlags).toContain(`mcp_servers.spacron-gmail.url="http://127.0.0.1:4100/proxy/spacron-gmail?token=boxsecret"`);
  expect(sync.codexFlags).toContain(`mcp_servers.spacron-fs.command="npx"`);
  expect(sync.codexFlags).not.toContain('spacron-linear'); // Codex cannot carry its auth header
});
