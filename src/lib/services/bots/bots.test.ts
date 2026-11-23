import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  tauri: true,
  local: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({ runId: 'local-run' })),
  box: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({ runId: 'box-run' })),
}));

vi.mock('$lib/stores/remoteWorkspace', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return { remoteTarget: writable<object | null>(null), activeRemoteId: writable<string | null>(null) };
});
vi.mock('$lib/stores/settings', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return { mcpServers: writable<unknown[]>([]) };
});
vi.mock('$lib/stores/runs', () => ({
  getAgentRoster: () => [{ command: 'claude', name: 'Claude Code' }, { command: 'aider', name: 'Aider' }, { command: '/opt/bin/codex.exe', name: 'Codex' }],
}));
vi.mock('$lib/stores/mcpBridge', () => ({
  getMcpUrl: async () => 'http://127.0.0.1:7777/sse',
  getMcpHttpUrl: async () => 'http://127.0.0.1:7777',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.local }));
vi.mock('$lib/services/backend', () => ({ backendInvoke: mock.box }));
vi.mock('$lib/utils/tauri', () => ({ isTauriRuntime: () => mock.tauri }));

beforeEach(() => {
  vi.resetModules();
  mock.local.mockClear();
  mock.box.mockClear();
  mock.tauri = true;
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
});

type Settable<T> = { set: (v: T) => void };
async function setup(box: string | null = null) {
  const remote = await import('$lib/stores/remoteWorkspace');
  (remote.remoteTarget as unknown as Settable<object | null>).set(box ? { url: 'ws://box', token: 't' } : null);
  (remote.activeRemoteId as unknown as Settable<string | null>).set(box);
  const settings = await import('$lib/stores/settings');
  const api = await import('./bots');
  const { get } = await import('$lib/stores/storeCompat');
  return { api, remote, settings, get };
}

const input = {
  name: 'Digest', instructions: 'Summarise the news.', agent: 'claude', model: null, schedule: 'daily' as const,
  time: '08:00', day: 1, enabled: true, boxId: 'local', access: 'folder' as const, connectors: true,
};
const lastSync = (fn: typeof mock.local, name: string) =>
  fn.mock.calls.filter((c) => c[0] === name).at(-1)?.[1] as { args?: Record<string, unknown> } & Record<string, unknown>;

it('only offers agents that can run unattended', async () => {
  const { api } = await setup();
  expect(api.botAgents().map((a) => a.command)).toEqual(['claude', '/opt/bin/codex.exe']);
});

it('runs on this PC without any box', async () => {
  const { api } = await setup(null);
  expect(api.reachableHosts()).toEqual(['local']);
  const bot = api.saveBot(input);
  await vi.waitFor(() => expect(lastSync(mock.local, 'local_bots_sync')).toBeTruthy());
  const { args } = lastSync(mock.local, 'local_bots_sync');
  const sent = (args!.bots as { id: string; access: string; occurrences: number[] }[])[0];
  expect(sent).toMatchObject({ id: bot.id, access: 'folder' });
  expect(sent.occurrences.length).toBeGreaterThanOrEqual(13);
  expect(args).toMatchObject({ enabled: true, catchUpMinutes: 15, maxRunMinutes: 60 });
  expect(mock.box).not.toHaveBeenCalled();
  await expect(api.runBotNow(bot.id)).resolves.toBe('local-run');
  expect(mock.local.mock.calls.at(-1)).toEqual(['local_bot_run_now', { args: { id: bot.id } }]);
});

it('local bots go straight to this app even while a box is connected', async () => {
  const { api } = await setup('box-1');
  expect(api.reachableHosts()).toEqual(['local', 'box-1']);
  const bot = api.saveBot(input);
  await api.syncHost('local');
  await api.stopBotRun(bot, 'r9');
  expect(mock.local.mock.calls.at(-1)).toEqual(['local_bot_stop', { args: { runId: 'r9' } }]);
  expect(mock.box.mock.calls.some((c) => String(c[0]).startsWith('box_bot'))).toBe(false);
});

it('box bots go over the socket and stop there', async () => {
  const { api } = await setup('box-1');
  const bot = api.saveBot({ ...input, boxId: 'box-1' });
  await api.syncHost('box-1');
  expect(lastSync(mock.box, 'box_bots_sync')).toMatchObject({ bots: [expect.objectContaining({ id: bot.id })] });
  await api.stopBotRun(bot, 'r1');
  expect(mock.box.mock.calls.at(-1)).toEqual(['box_bot_stop', { runId: 'r1' }]);
});

it('a box bot is hidden and locked when its box is not connected', async () => {
  const { api, remote, get } = await setup('box-1');
  const bot = api.saveBot({ ...input, boxId: 'box-1' });
  (remote.activeRemoteId as unknown as Settable<string | null>).set('box-2');
  expect(api.visibleBots(get(api.bots))).toEqual([]);
  await expect(api.runBotNow(bot.id)).rejects.toThrow('Connect to this bot');
  expect(() => api.saveBot({ ...input, id: bot.id, boxId: 'box-1', name: 'Renamed' })).toThrow('another box');
});

it('without the desktop app or a box there is nowhere to run', async () => {
  mock.tauri = false;
  const { api } = await setup(null);
  expect(api.reachableHosts()).toEqual([]);
  expect(() => api.saveBot(input)).toThrow('desktop app');
});

it('rejects agents without a headless mode, empty jobs and unknown access', async () => {
  const { api } = await setup();
  expect(() => api.saveBot({ ...input, agent: 'aider' })).toThrow('unattended');
  expect(() => api.saveBot({ ...input, instructions: '   ' })).toThrow('name and a job');
  expect(() => api.saveBot({ ...input, access: 'root' as never })).toThrow('may do');
});

it('gives local bots connectors through the sign-in proxy plus Spacron tools', async () => {
  const { api, settings } = await setup('box-1');
  (settings.mcpServers as unknown as Settable<unknown[]>).set([
    { id: '1', name: 'linear', transport: 'http', url: 'https://mcp.linear.app/sse', enabled: true },
    { id: '2', name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true, oauth: true },
    { id: '3', name: 'off', transport: 'http', url: 'https://x', enabled: false },
  ]);
  const local = JSON.parse((await api.botMcpConfig('local'))!).mcpServers;
  expect(Object.keys(local).sort()).toEqual(['spacron-linear', 'spacron-mcp', 'spacron-notion']);
  expect(local['spacron-mcp']).toEqual({ type: 'sse', url: 'http://127.0.0.1:7777/sse' });
  expect(local['spacron-notion'].url).toContain('127.0.0.1:7777');
  // A box can't reach this app: no signed-in connectors, no Spacron tools.
  const box = JSON.parse((await api.botMcpConfig('box-1'))!).mcpServers;
  expect(Object.keys(box)).toEqual(['spacron-linear']);
  api.updateBotSettings({ spacronTools: false });
  expect(Object.keys(JSON.parse((await api.botMcpConfig('local'))!).mcpServers)).not.toContain('spacron-mcp');
});

it('sends no MCP config when no bot wants connectors', async () => {
  const { api } = await setup();
  api.saveBot({ ...input, connectors: false });
  await api.syncHost('local');
  expect(lastSync(mock.local, 'local_bots_sync').args!.mcpConfig).toBeNull();
});

it('settings reach the host and pause next runs', async () => {
  const { api } = await setup();
  api.saveBot(input);
  api.updateBotSettings({ enabled: false, maxRunMinutes: 10 });
  await api.syncHost('local');
  expect(lastSync(mock.local, 'local_bots_sync').args).toMatchObject({ enabled: false, maxRunMinutes: 10 });
  expect(api.nextBotRun({ schedule: 'daily', time: '08:00', day: 1, enabled: true })).toBeNull();
});

it('removing a bot drops it from the next sync', async () => {
  const { api } = await setup();
  const bot = api.saveBot(input);
  api.removeBot(bot.id);
  await api.syncHost('local');
  expect(lastSync(mock.local, 'local_bots_sync').args!.bots).toEqual([]);
});

it('announces finished scheduled runs once, and not on the first look', async () => {
  const { api } = await setup();
  const run = (status: string, trigger = 'schedule') => ({ local: { homeRoot: '', runs: [{ id: 'r1', botId: 'b', name: 'Digest', startedAt: 1, status, trigger }] } }) as never;
  expect(api.noticesFor(run('running'), false)).toEqual([]);
  expect(api.noticesFor(run('running'), true)).toEqual([]);
  expect(api.noticesFor(run('completed'), true)).toEqual([expect.objectContaining({ tone: 'success' })]);
  expect(api.noticesFor(run('completed'), true)).toEqual([]);
});

it('ignores corrupt saved data and upgrades old bots', async () => {
  localStorage.setItem('spacron_bots_v1', JSON.stringify({ bots: [{ ...input, id: 'old', access: undefined, connectors: undefined, createdAt: 1 }] }));
  const { api, get } = await setup();
  expect(get(api.bots)[0]).toMatchObject({ access: 'research', connectors: true });
  localStorage.setItem('spacron_bots_v1', '{not json');
  vi.resetModules();
  const again = await setup();
  expect(again.get(again.api.bots)).toEqual([]);
});
