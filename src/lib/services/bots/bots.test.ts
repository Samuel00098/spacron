import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  tauri: true,
  shared: {} as Record<string, string[]>,
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
  getAgentRoster: () => [
    ...['claude', '/opt/bin/codex.exe', 'agy', 'pi', 'cursor-agent', 'grok', 'dsh', 'kilo']
      .map((command) => ({ command, name: command })),
    { command: 'freebuff', name: 'Freebuff' },
  ],
}));
vi.mock('$lib/stores/mcpBridge', () => ({
  getMcpUrl: async () => 'http://127.0.0.1:7777/sse',
  getMcpHttpUrl: async () => 'http://127.0.0.1:7777',
  botBrowserEntry: async (pc: boolean) => ({ command: pc ? 'node' : 'npx', args: ['--headless'] }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.local }));
vi.mock('$lib/services/backend', () => ({ backendInvoke: mock.box }));
vi.mock('$lib/utils/tauri', () => ({ isTauriRuntime: () => mock.tauri }));
vi.mock('$lib/services/box-signins', () => ({ sharedWith: (id: string) => mock.shared[id] ?? [] }));

beforeEach(() => {
  vi.resetModules();
  mock.local.mockClear();
  mock.box.mockClear();
  mock.tauri = true;
  mock.shared = {};
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
  browser: false, canCreateBots: false, computerUse: false, avatar: 'robot',
};
const lastSync = (fn: typeof mock.local, name: string) =>
  fn.mock.calls.filter((c) => c[0] === name).at(-1)?.[1] as { args?: Record<string, unknown> } & Record<string, unknown>;

it('only offers agents that can run unattended', async () => {
  const { api } = await setup();
  expect(api.botAgents().map((a) => a.command)).toEqual([
    'claude', '/opt/bin/codex.exe', 'agy', 'pi', 'cursor-agent', 'grok', 'dsh', 'kilo',
  ]);
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
  // A box can't reach this app: no signed-in connectors and no spacron-mcp,
  // but it gets the box's own Spacron tools.
  const box = JSON.parse((await api.botMcpConfig('box-1'))!).mcpServers;
  expect(Object.keys(box).sort()).toEqual(['spacron-box', 'spacron-linear']);
  expect(box['spacron-mcp']).toBeUndefined();
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

it('announces observed scheduled runs once when they finish', async () => {
  const { api } = await setup();
  const run = (status: string, trigger = 'schedule') => ({ local: { homeRoot: '', runs: [{ id: 'r1', botId: 'b', name: 'Digest', startedAt: 1, status, trigger }] } }) as never;
  expect(api.noticesFor(run('running'), 10)).toEqual([]);
  expect(api.noticesFor(run('running'), 10)).toEqual([]);
  expect(api.noticesFor(run('completed'), 10)).toEqual([expect.objectContaining({ tone: 'success' })]);
  expect(api.noticesFor(run('completed'), 10)).toEqual([]);
});

it('announces manual and chat runs that finish between polls without replaying old runs', async () => {
  const { api } = await setup();
  const state = {
    local: {
      homeRoot: '',
      runs: [
        { id: 'old', botId: 'b', name: 'Digest', startedAt: 1, finishedAt: 9, status: 'completed', trigger: 'chat' },
        { id: 'chat', botId: 'b', name: 'Digest', startedAt: 11, finishedAt: 12, status: 'completed', trigger: 'chat' },
        { id: 'manual', botId: 'b', name: 'Digest', startedAt: 13, finishedAt: 14, status: 'failed', trigger: 'manual', detail: 'Raw diagnostic' },
      ],
    },
  } as const;
  const snapshot = { local: { ...state.local, runs: [...state.local.runs] } };
  expect(api.noticesFor(snapshot, 10)).toEqual([
    expect.objectContaining({ tone: 'success', spoken: 'Bot "Digest" finished.' }),
    expect.objectContaining({ tone: 'error', spoken: 'Bot "Digest" could not finish.' }),
  ]);
  expect(api.noticesFor(snapshot, 10)).toEqual([]);
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

it('persists authored starter prompts and gives older bots job-specific defaults', async () => {
  const { api } = await setup();
  const bot = api.saveBot({ ...input, starterPrompts: ['  Find today’s top stories.  ', '', 'Find today’s top stories.', 'Focus on AI news.'] });
  expect(bot.starterPrompts).toEqual(['Find today’s top stories.', 'Focus on AI news.']);
  await vi.waitFor(() => expect(lastSync(mock.local, 'local_bots_sync')).toBeTruthy());
  expect(lastSync(mock.local, 'local_bots_sync').args!.bots).not.toContainEqual(expect.objectContaining({ starterPrompts: expect.anything() }));
  const saved = JSON.parse(localStorage.getItem('spacron_bots_v1')!);
  expect(saved.bots[0].starterPrompts).toEqual(bot.starterPrompts);
  expect(api.botStarterPrompts({ name: 'Inbox triage', instructions: 'Sort my unread mail by urgency.' })[0]).toBe('Sort my unread mail by urgency.');
  for (const template of api.BOT_TEMPLATES) {
    expect(api.botStarterPrompts({ name: template.name, instructions: template.instructions })).toEqual(template.starterPrompts);
    expect(new Set(template.starterPrompts).size).toBe(3);
  }
  vi.resetModules();
  const reloaded = await import('./bots');
  const { get } = await import('$lib/stores/storeCompat');
  expect(reloaded.botStarterPrompts(get(reloaded.bots)[0])).toEqual(bot.starterPrompts);
});

const servers = [
  { id: '1', name: 'linear', transport: 'http', url: 'https://mcp.linear.app/sse', enabled: true },
  { id: '2', name: 'Gmail', transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', enabled: true, oauth: true, catalogId: 'gmail' },
];

it('each bot sends only its own connectors, plus the browser when it wants one', async () => {
  const { api, settings } = await setup();
  (settings.mcpServers as unknown as Settable<unknown[]>).set(servers);
  api.saveBot({ ...input, mcpKeys: ['spacron-gmail'], browser: true });
  await api.syncHost('local');
  const { args } = lastSync(mock.local, 'local_bots_sync');
  const sent = (args!.bots as { mcpKeys: string[]; connectors: boolean }[])[0];
  expect(sent.mcpKeys).toEqual(['spacron-gmail', 'spacron-playwright']);
  expect(sent.connectors).toBe(true);
  const cfg = JSON.parse(args!.mcpConfig as string).mcpServers;
  expect(cfg['spacron-playwright']).toEqual({ command: 'node', args: ['--headless'] });
});

it('a box gets signed-in connectors only when shared, through its own proxy', async () => {
  const { api, settings } = await setup('box-1');
  (settings.mcpServers as unknown as Settable<unknown[]>).set(servers);
  expect(api.connectorChoices('box-1').find((c) => c.key === 'spacron-gmail')).toMatchObject({ usable: false });
  expect(Object.keys(JSON.parse((await api.botMcpConfig('box-1'))!).mcpServers).sort()).toEqual(['spacron-box', 'spacron-linear']);
  mock.shared['box-1'] = ['spacron-gmail'];
  expect(api.connectorChoices('box-1').find((c) => c.key === 'spacron-gmail')).toMatchObject({ usable: true });
  const cfg = JSON.parse((await api.botMcpConfig('box-1', true))!).mcpServers;
  expect(cfg['spacron-gmail']).toEqual({ type: 'http', url: 'spacron-box-proxy://spacron-gmail' });
  expect(cfg['spacron-playwright'].command).toBe('npx');
  expect(cfg['spacron-mcp']).toBeUndefined();
});

it('chat messages go to the host with the run', async () => {
  const { api } = await setup();
  const bot = api.saveBot(input);
  await expect(api.sendBotMessage(bot.id, '  ')).rejects.toThrow('Type a message');
  await api.sendBotMessage(bot.id, ' hello there ');
  expect(mock.local.mock.calls.at(-1)).toEqual(['local_bot_run_now', { args: { id: bot.id, message: 'hello there' } }]);
});

it('only built-in avatars or small uploaded pictures are accepted', async () => {
  const { api } = await setup();
  expect(api.saveBot({ ...input, avatar: 'owl' }).avatar).toBe('owl');
  expect(api.saveBot({ ...input, avatar: 'data:image/webp;base64,AAAA' }).avatar).toContain('data:image/webp');
  expect(() => api.saveBot({ ...input, avatar: 'https://evil.example/x.png' })).toThrow('picture');
  expect(() => api.saveBot({ ...input, avatar: `data:image/png;base64,${'A'.repeat(200_000)}` })).toThrow('picture');
});

it('a builder bot is told what it can choose from', async () => {
  const { api, settings } = await setup();
  (settings.mcpServers as unknown as Settable<unknown[]>).set(servers);
  api.saveBot({ ...input, canCreateBots: true });
  await api.syncHost('local');
  const sent = (lastSync(mock.local, 'local_bots_sync').args!.bots as { extraContext: string; canCreateBots: boolean }[])[0];
  expect(sent.canCreateBots).toBe(true);
  expect(sent.extraContext).toContain('Gmail');
  expect(sent.extraContext).toContain('owl');
});

it('bots a builder proposes are capped, paused and never builders themselves', async () => {
  const { api, settings } = await setup();
  (settings.mcpServers as unknown as Settable<unknown[]>).set(servers);
  const builder = api.saveBot({ ...input, name: 'Bot Builder', access: 'folder', canCreateBots: true });
  const made = api.botFromProposal('local', {
    id: 'p1', createdBy: builder.id, createdByName: 'Bot Builder', creatorAccess: 'full', createdAt: 1,
    spec: { name: 'Inbox bot', instructions: 'Triage mail', starterPrompts: ['Flag urgent emails.'], schedule: 'daily', time: '07:30', access: 'full', connectors: ['gmail'], browser: true, avatar: 'mail', canCreateBots: true },
  });
  expect(made).toMatchObject({ name: 'Inbox bot', access: 'folder', enabled: false, canCreateBots: false, browser: true, avatar: 'mail', schedule: 'daily', time: '07:30', createdBy: 'Bot Builder' });
  expect((made as { mcpKeys: string[] }).mcpKeys).toEqual(['spacron-gmail']);
  expect(made).toMatchObject({ starterPrompts: ['Flag urgent emails.'] });
  expect(api.botFromProposal('local', { id: 'p2', createdBy: 'x', createdByName: '', creatorAccess: 'research', createdAt: 1, spec: { name: '' } })).toBe('it had no name or job');
  const odd = api.botFromProposal('local', { id: 'p3', createdBy: 'gone', createdByName: 'Old', creatorAccess: 'research', createdAt: 1, spec: { name: 'X', instructions: 'Y', schedule: 'every minute', avatar: 'nope', access: 'folder' } });
  expect(odd).toMatchObject({ schedule: 'manual', avatar: 'brain', access: 'research' });
});

it('adopts proposals from the host, then acks them', async () => {
  const { api, get } = await setup();
  api.saveBot({ ...input, name: 'Bot Builder', canCreateBots: true });
  mock.local.mockImplementation(async (cmd: string) => cmd === 'local_bots_state'
    ? { runs: [], homeRoot: '/h', proposals: [{ id: 'p9', createdBy: 'b', createdByName: 'Bot Builder', creatorAccess: 'folder', createdAt: 1, spec: { name: 'Digest', instructions: 'News' } }] }
    : { runId: 'r' });
  await api.refreshBotState();
  await vi.waitFor(() => expect(mock.local.mock.calls.some((c) => c[0] === 'local_bot_proposals_ack')).toBe(true));
  expect(get(api.bots).map((b) => b.name).sort()).toEqual(['Bot Builder', 'Digest']);
  expect(mock.local.mock.calls.find((c) => c[0] === 'local_bot_proposals_ack')![1]).toEqual({ args: { ids: ['p9'] } });
  mock.local.mockImplementation(async () => ({ runId: 'local-run' }));
});

it('a stalled host call gives up with a clear error instead of hanging', async () => {
  vi.useFakeTimers();
  try {
    const { api } = await setup();
    const bot = api.saveBot(input);
    await vi.runAllTimersAsync();
    mock.local.mockImplementation(() => new Promise(() => {}));
    const pending = api.stopBotRun(bot, 'r1');
    const caught = pending.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await caught).toContain('did not answer in time');
  } finally {
    mock.local.mockImplementation(async () => ({ runId: 'local-run' }));
    vi.useRealTimers();
  }
});

it('computer use adds the desktop tools of the host: Spacron tools on this PC, the box tools on a box', async () => {
  const { api } = await setup('box-1');
  api.updateBotSettings({ spacronTools: false });
  api.saveBot({ ...input, mcpKeys: [], computerUse: true });
  await api.syncHost('local');
  const local = lastSync(mock.local, 'local_bots_sync').args!;
  expect((local.bots as { mcpKeys: string[]; computerUse: boolean }[])[0]).toMatchObject({ mcpKeys: ['spacron-mcp'], computerUse: true });
  expect(JSON.parse(local.mcpConfig as string).mcpServers['spacron-mcp']).toEqual({ type: 'sse', url: 'http://127.0.0.1:7777/sse' });
  api.saveBot({ ...input, boxId: 'box-1', mcpKeys: [], computerUse: true });
  await api.syncHost('box-1');
  const box = lastSync(mock.box, 'box_bots_sync');
  expect((box.bots as { mcpKeys: string[] }[])[0].mcpKeys).toEqual(['spacron-box']);
  expect(JSON.parse(box.mcpConfig as string).mcpServers['spacron-box']).toEqual({ type: 'http', url: 'spacron-box-mcp://' });
});

it('a builder can only hand out computer use if it has it', async () => {
  const { api } = await setup();
  const spec = { name: 'Clicker', instructions: 'Click things', computerUse: true };
  const plain = api.saveBot({ ...input, name: 'Builder', canCreateBots: true });
  expect(api.botFromProposal('local', { id: 'a', createdBy: plain.id, createdByName: 'Builder', creatorAccess: 'folder', createdAt: 1, spec })).toMatchObject({ computerUse: false });
  const able = api.saveBot({ ...input, name: 'Builder 2', canCreateBots: true, computerUse: true });
  expect(api.botFromProposal('local', { id: 'b', createdBy: able.id, createdByName: 'Builder 2', creatorAccess: 'folder', createdAt: 1, spec })).toMatchObject({ computerUse: true });
});

it('uploads attachments into the bot folder on its host, then sends their paths with the message', async () => {
  const { api } = await setup('box-1');
  const bot = api.saveBot(input);
  mock.local.mockImplementation(async (cmd: string) => (cmd === 'local_bot_attach' ? { path: 'attachments/abcd1234-photo.png' } : { runId: 'r' }));
  const file = new File([new Uint8Array([1, 2, 3, 250])], 'photo.png', { type: 'image/png' });
  expect(await api.attachToBot(bot, file)).toBe('attachments/abcd1234-photo.png');
  const [cmd, payload] = mock.local.mock.calls.find((c) => c[0] === 'local_bot_attach')!;
  expect(cmd).toBe('local_bot_attach');
  expect(payload).toEqual({ args: { botId: bot.id, name: 'photo.png', data: btoa(String.fromCharCode(1, 2, 3, 250)) } });
  await api.sendBotMessage(bot.id, '', ['attachments/abcd1234-photo.png']);
  expect(mock.local.mock.calls.at(-1)).toEqual(['local_bot_run_now', { args: { id: bot.id, attachments: ['attachments/abcd1234-photo.png'] } }]);
  const box = api.saveBot({ ...input, boxId: 'box-1' });
  mock.box.mockImplementation(async () => ({ path: 'attachments/ffff0000-notes.txt' }));
  await api.attachToBot(box, new File(['hi'], 'notes.txt'));
  expect(mock.box.mock.calls.at(-1)![0]).toBe('box_bot_attach');
  mock.local.mockImplementation(async () => ({ runId: 'local-run' }));
  mock.box.mockImplementation(async () => ({ runId: 'box-run' }));
});

it('refuses oversized attachments before uploading, and previews images only', async () => {
  const { api } = await setup();
  const bot = api.saveBot(input);
  const big = { name: 'big.zip', size: api.MAX_ATTACHMENT_BYTES + 1 } as File;
  await expect(api.attachToBot(bot, big)).rejects.toThrow('over 8 MB');
  expect(mock.local.mock.calls.some((c) => c[0] === 'local_bot_attach')).toBe(false);
  expect(await api.attachmentPreview(bot, 'attachments/aaaa1111-report.pdf')).toBeNull();
  mock.local.mockImplementation(async () => ({ mime: 'image/png', data: 'AAAA' }));
  expect(await api.attachmentPreview(bot, 'attachments/aaaa1111-shot.png')).toBe('data:image/png;base64,AAAA');
  mock.local.mockImplementation(async () => ({ runId: 'local-run' }));
});
