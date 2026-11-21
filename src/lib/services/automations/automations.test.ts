import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ project: { id: 'p', root_path: '/repo' }, remote: null as object | null, listener: () => {}, chat: { status: 'ready', error: null as string | null, approvals: [] as object[] }, spawn: vi.fn(async () => 42) }));
vi.mock('$lib/stores/storeCompat', () => ({ get: (store: string) => store === 'project' ? mock.project : mock.remote }));
vi.mock('$lib/stores/workspace', () => ({ activeProject: 'project' }));
vi.mock('$lib/stores/remoteWorkspace', () => ({ remoteTarget: 'remote' }));
vi.mock('$lib/stores/terminal', () => ({ createTerminalSession: mock.spawn, updateSessionTitle: vi.fn(), spawnAgentPreset: mock.spawn, waitForAgentReady: vi.fn(async () => 'ready'), sendPromptToSession: vi.fn(), onSessionExit: vi.fn(() => () => {}) }));
vi.mock('$lib/stores/runs', () => ({ getAgentRoster: () => [{ command: 'codex' }, { command: 'gemini' }, { command: 'muse' }, { command: 'custom-agent --local' }] }));
vi.mock('$lib/stores/agentTurnState', () => ({ agentTurnStates: { subscribe: () => () => {} } }));
vi.mock('$lib/services/orchestrator/agent-turn-watch', () => ({ watchLeasedAgentTurn: vi.fn(async () => ({ kind: 'finished', via: 'declared' })) }));
vi.mock('$lib/services/structured-chat/panes', () => ({ markStructuredChatPane: vi.fn(), structuredChatAgentFor: (agent: string) => agent === 'codex' ? 'codex' : null }));
vi.mock('$lib/services/structured-chat/registry', () => ({
  getStructuredChat: () => mock.chat,
  startStructuredChat: vi.fn(async () => {}),
  sendStructuredChat: vi.fn(async () => { mock.chat.status = 'working'; mock.listener(); }),
  subscribeStructuredChat: (_: string, listener: () => void) => { mock.listener = listener; return () => {}; },
}));
beforeEach(() => {
  vi.resetModules();
  mock.spawn.mockClear(); mock.project = { id: 'p', root_path: '/repo' }; mock.remote = null;
  mock.chat = { status: 'ready', error: null, approvals: [] };
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});
async function setup() {
  const api = await import('./automations');
  api.loadAutomations();
  api.saveAutomation({ name: 'Review', prompt: 'Review changes', projectId: 'p', root: '/repo', agent: 'codex', schedule: 'daily', time: '09:00', day: 1, enabled: true });
  return { api, id: api.automationSnapshot().automations[0].id };
}
it('refuses a different project or remote host', async () => {
  const { api, id } = await setup();
  mock.project = { id: 'other', root_path: '/other' };
  await expect(api.runAutomation(id)).rejects.toThrow('local project');
  mock.project = { id: 'p', root_path: '/repo' }; mock.remote = {};
  await expect(api.runAutomation(id)).rejects.toThrow('local project');
  expect(mock.spawn).not.toHaveBeenCalled();
});
it('records protocol completion and prevents overlapping runs', async () => {
  const { api, id } = await setup();
  await api.runAutomation(id);
  await expect(api.runAutomation(id)).rejects.toThrow('active run');
  mock.chat.status = 'ready'; mock.listener();
  expect(api.automationSnapshot().runs[0].status).toBe('completed');
  expect(mock.spawn).toHaveBeenCalledTimes(1);
});
it('does not launch when saving the run fails', async () => {
  const { api, id } = await setup();
  localStorage.setItem = () => { throw new Error('Storage full'); };
  await expect(api.runAutomation(id)).rejects.toThrow('Storage full');
  expect(mock.spawn).not.toHaveBeenCalled();
});
it('shows approval waits and records a failed protocol result', async () => {
  const { api, id } = await setup();
  await api.runAutomation(id);
  mock.chat.approvals = [{}]; mock.listener();
  expect(api.automationSnapshot().runs[0].status).toBe('needs_input');
  mock.chat.approvals = []; mock.chat.status = 'ready'; mock.chat.error = 'Agent could not finish'; mock.listener();
  expect(api.automationSnapshot().runs[0]).toMatchObject({ status: 'failed', detail: 'Agent could not finish' });
});
it('launches an installed terminal-only agent and delivers its prompt', async () => {
  const { api } = await setup();
  api.saveAutomation({ name: 'Gemini review', prompt: 'Review changes', projectId: 'p', root: '/repo', agent: 'gemini', schedule: 'daily', time: '09:00', day: 1, enabled: true });
  await api.runAutomation(api.automationSnapshot().automations.find(a => a.agent === 'gemini')!.id);
  const terminal = await import('$lib/stores/terminal');
  expect(terminal.spawnAgentPreset).toHaveBeenCalledWith('gemini', '/repo', expect.objectContaining({ projectId: 'p', activate: false }));
  expect(terminal.sendPromptToSession).toHaveBeenCalledWith(42, 'Review changes', 'gemini');
});
it('persists custom agent commands and reloads them', async () => {
  const { api } = await setup();
  api.saveAutomation({ name: 'Custom', prompt: 'Review', projectId: 'p', root: '/repo', agent: 'custom-agent --local', schedule: 'daily', time: '09:00', day: 1, enabled: true });
  vi.resetModules();
  const restored = await import('./automations'); restored.loadAutomations();
  expect(restored.automationSnapshot().automations.some(a => a.agent === 'custom-agent --local')).toBe(true);
});
it('does not label inferred terminal silence as confirmed completion', async () => {
  const { watchLeasedAgentTurn } = await import('$lib/services/orchestrator/agent-turn-watch');
  vi.mocked(watchLeasedAgentTurn).mockResolvedValueOnce({ kind: 'finished', via: 'inferred' });
  const { api } = await setup();
  api.saveAutomation({ name: 'Terminal', prompt: 'Review', projectId: 'p', root: '/repo', agent: 'gemini', schedule: 'daily', time: '09:00', day: 1, enabled: true });
  await api.runAutomation(api.automationSnapshot().automations.find(a => a.agent === 'gemini')!.id);
  expect(api.automationSnapshot().runs[0].status).toBe('quiet');
});
it('refuses an agent outside the installed and custom roster', async () => {
  const { api } = await setup();
  expect(() => api.saveAutomation({ name: 'Unknown', prompt: 'Review', projectId: 'p', root: '/repo', agent: 'missing-agent', schedule: 'daily', time: '09:00', day: 1, enabled: true })).toThrow('installed agent');
});
it('passes the saved model and reasoning to a structured chat run', async () => {
  const { api } = await setup();
  api.saveAutomation({ name: 'Model review', prompt: 'Review', projectId: 'p', root: '/repo', agent: 'codex', model: 'chosen-model', reasoningEffort: 'high', schedule: 'daily', time: '09:00', day: 1, enabled: true });
  const id = api.automationSnapshot().automations.find(a => a.name === 'Model review')!.id;
  await api.runAutomation(id);
  const { startStructuredChat } = await import('$lib/services/structured-chat/registry');
  expect(startStructuredChat).toHaveBeenCalledWith('codex', 42, '/repo', { access: 'ask', model: 'chosen-model', effort: 'high' });
});
it('builds native model flags for terminal launches and preserves selections on reload', async () => {
  const { api } = await setup();
  api.saveAutomation({ name: 'Muse model', prompt: 'Review', projectId: 'p', root: '/repo', agent: 'muse', model: 'muse-chosen', reasoningEffort: 'default', schedule: 'daily', time: '09:00', day: 1, enabled: true });
  const id = api.automationSnapshot().automations.find(a => a.name === 'Muse model')!.id;
  await api.runAutomation(id);
  const { spawnAgentPreset } = await import('$lib/stores/terminal');
  expect(spawnAgentPreset).toHaveBeenCalledWith('muse', '/repo', expect.objectContaining({ runtimeArgs: '--model muse-chosen' }));
  vi.resetModules();
  const restored = await import('./automations'); restored.loadAutomations();
  expect(restored.automationSnapshot().automations.find(a => a.id === id)?.model).toBe('muse-chosen');
});
it('recovers a running row as interrupted without a stale pane id', async () => {
  const { api, id } = await setup();
  await api.runAutomation(id);
  vi.resetModules();
  const restored = await import('./automations'); restored.loadAutomations();
  expect(restored.automationSnapshot().runs[0]).toMatchObject({ status: 'interrupted' });
  expect(restored.automationSnapshot().runs[0].sessionId).toBeUndefined();
});
it('records an overdue schedule as missed without launching an agent', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 10, 20, 8));
    const { api } = await setup();
    vi.setSystemTime(new Date(2026, 10, 20, 10));
    const stop = api.startAutomationScheduler(() => {});
    expect(api.automationSnapshot().runs[0].status).toBe('missed');
    expect(api.automationSnapshot().automations[0].nextRunAt).toBe(new Date(2026, 10, 21, 9).getTime());
    expect(mock.spawn).not.toHaveBeenCalled();
    stop();
  } finally { vi.useRealTimers(); }
});
it('catches up once within grace and advances the schedule before launching', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 10, 20, 8));
    const { api } = await setup();
    vi.setSystemTime(new Date(2026, 10, 20, 9, 5));
    const stop = api.startAutomationScheduler(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(api.automationSnapshot().automations[0].nextRunAt).toBe(new Date(2026, 10, 21, 9).getTime());
    stop();
  } finally { vi.useRealTimers(); }
});

