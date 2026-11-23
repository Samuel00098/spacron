import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  remote: { url: 'ws://box', token: 't' } as object | null,
  boxId: 'box-1' as string | null,
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({ runId: 'r1' })),
}));

vi.mock('$lib/stores/remoteWorkspace', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  const remoteTarget = writable<object | null>(null);
  const activeRemoteId = writable<string | null>(null);
  return { remoteTarget, activeRemoteId };
});
vi.mock('$lib/stores/runs', () => ({
  getAgentRoster: () => [{ command: 'claude', name: 'Claude Code' }, { command: 'aider', name: 'Aider' }, { command: '/opt/bin/codex.exe', name: 'Codex' }],
}));
vi.mock('$lib/services/backend', () => ({ backendInvoke: mock.invoke }));

beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockClear();
  mock.remote = { url: 'ws://box', token: 't' };
  mock.boxId = 'box-1';
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
});

async function setup() {
  const remote = await import('$lib/stores/remoteWorkspace');
  (remote.remoteTarget as unknown as { set: (v: object | null) => void }).set(mock.remote);
  (remote.activeRemoteId as unknown as { set: (v: string | null) => void }).set(mock.boxId);
  const api = await import('./bots');
  const { get } = await import('$lib/stores/storeCompat');
  return { api, remote, get };
}

const input = { name: 'Digest', instructions: 'Summarise the news.', agent: 'claude', model: null, schedule: 'daily' as const, time: '08:00', day: 1, enabled: true };

it('only offers agents that can run unattended', async () => {
  const { api } = await setup();
  expect(api.botAgents().map((a) => a.command)).toEqual(['claude', '/opt/bin/codex.exe']);
});

it('needs a box to create a bot', async () => {
  const { api, remote } = await setup();
  (remote.remoteTarget as unknown as { set: (v: object | null) => void }).set(null);
  expect(() => api.saveBot(input)).toThrow('Connect to a box');
});

it('saves a bot on the active box and syncs its run times', async () => {
  const { api, get } = await setup();
  const bot = api.saveBot({ ...input, name: '  Digest  ' });
  expect(bot).toMatchObject({ name: 'Digest', boxId: 'box-1' });
  expect(get(api.bots)).toHaveLength(1);
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('box_bots_sync', expect.anything()));
  const args = mock.invoke.mock.calls.find((c) => c[0] === 'box_bots_sync')![1] as { bots: { id: string; occurrences: number[]; instructions: string }[] };
  expect(args.bots[0].id).toBe(bot.id);
  expect(args.bots[0].instructions).toBe('Summarise the news.');
  // Two weeks of daily runs.
  expect(args.bots[0].occurrences.length).toBeGreaterThanOrEqual(13);
  expect(args.bots[0].occurrences.length).toBeLessThanOrEqual(15);
});

it('rejects agents without a headless mode and empty jobs', async () => {
  const { api } = await setup();
  expect(() => api.saveBot({ ...input, agent: 'aider' })).toThrow('unattended');
  expect(() => api.saveBot({ ...input, instructions: '   ' })).toThrow('name and a job');
});

it('a manual bot sends no run times', async () => {
  const { api } = await setup();
  api.saveBot({ ...input, schedule: 'manual' });
  await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalled());
  const args = mock.invoke.mock.calls.at(-1)![1] as { bots: { occurrences: number[] }[] };
  expect(args.bots[0].occurrences).toEqual([]);
  expect(api.nextBotRun({ schedule: 'manual', time: '08:00', day: 1, enabled: true })).toBeNull();
});

it('only syncs and runs bots that live on the connected box', async () => {
  const { api, remote, get } = await setup();
  const bot = api.saveBot(input);
  (remote.activeRemoteId as unknown as { set: (v: string | null) => void }).set('box-2');
  expect(api.botsOnActiveBox(get(api.bots))).toEqual([]);
  await expect(api.runBotNow(bot.id)).rejects.toThrow('Connect to this bot');
  expect(() => api.saveBot({ ...input, id: bot.id, name: 'Renamed' })).toThrow('another box');
});

it('run now syncs first, then starts the run on the box', async () => {
  const { api } = await setup();
  const bot = api.saveBot(input);
  await api.syncBots(); // let the save's own sync land first
  mock.invoke.mockClear();
  await expect(api.runBotNow(bot.id)).resolves.toBe('r1');
  expect(mock.invoke.mock.calls.map((c) => c[0])).toEqual(['box_bots_sync', 'box_bot_run_now']);
});

it('removing a bot drops it from the next sync', async () => {
  const { api } = await setup();
  const bot = api.saveBot(input);
  api.removeBot(bot.id);
  await vi.waitFor(() => {
    const last = mock.invoke.mock.calls.filter((c) => c[0] === 'box_bots_sync').at(-1)![1] as { bots: unknown[] };
    expect(last.bots).toEqual([]);
  });
});

it('ignores corrupt saved data instead of crashing the app', async () => {
  localStorage.setItem('spacron_bots_v1', '{not json');
  const { api, get } = await setup();
  expect(get(api.bots)).toEqual([]);
});
