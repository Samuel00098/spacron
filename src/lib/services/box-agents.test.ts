import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  list: [] as { id: number; name: string; preset: string; cwd: string; startedAt: number; state: string }[],
  attach: vi.fn(async (id: number) => id),
}));
vi.mock('$lib/stores/storeCompat', async (orig) => orig());
vi.mock('$lib/stores/workspace', async () => { const { writable } = await import('$lib/stores/storeCompat'); return { activeProject: writable({ id: 'p1', root_path: '/w' }) }; });
vi.mock('$lib/stores/remoteWorkspace', async () => { const { writable } = await import('$lib/stores/storeCompat'); return { remoteTarget: writable({ url: 'ws://box', token: 't' }) }; });
vi.mock('$lib/services/backend', () => ({ backendInvoke: vi.fn(async () => mock.list) }));
vi.mock('$lib/stores/terminal', () => ({ attachTerminalSession: mock.attach }));

beforeEach(() => { vi.resetModules(); mock.attach.mockClear(); });

it('shows each agent the box started as a pane, once, with its name and agent', async () => {
  mock.list = [
    { id: 7, name: 'codex-1', preset: 'codex', cwd: '/w/.spacron/worktrees/codex-1', startedAt: 1, state: 'working' },
    { id: 8, name: 'reviewer', preset: 'claude', cwd: '/w', startedAt: 2, state: 'done' },
  ];
  const api = await import('./box-agents');
  expect(await api.adoptBoxAgents()).toBe(2);
  expect(mock.attach).toHaveBeenCalledWith(7, '/w/.spacron/worktrees/codex-1', undefined, 'p1', expect.objectContaining({ title: 'codex-1', agentPreset: 'codex' }));
  expect(await api.adoptBoxAgents()).toBe(0);
  expect(mock.attach).toHaveBeenCalledTimes(2);
});
