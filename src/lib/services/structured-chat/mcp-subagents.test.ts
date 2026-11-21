import { beforeEach, describe, expect, it, vi } from 'vitest';

// The parent chat's record and the pane/session plumbing this engine talks to.
const terminalMock = vi.hoisted(() => ({
  list: [] as { id: number; isRunning: boolean; lastExitCode?: number | null }[],
  listeners: [] as ((list: { id: number; isRunning: boolean; lastExitCode?: number | null }[]) => void)[],
}));

const parentMock = vi.hoisted(() => ({
  record: { id: 'ss_parent', projectId: 'proj-parent', cwd: '/parent/cwd' } as { id: string; projectId: string; cwd: string } | null,
  snapshot: vi.fn(),
}));

vi.mock('$lib/stores/terminal', () => {
  return {
    getActiveTerminalProjectId: vi.fn(() => 'test-project'),
    killSession: vi.fn(async () => {}),
    sessions: {
      subscribe: (cb: (list: typeof terminalMock.list) => void) => {
        terminalMock.listeners.push(cb);
        cb(terminalMock.list);
        return () => {};
      },
    },
    setSessionWorktree: vi.fn(),
    spawnAgentPreset: vi.fn(async (preset, cwd, opts) => {
      opts?.onSessionCreated?.(99);
      return 99;
    }),
  };
});

vi.mock('$lib/stores/mcpBridge', () => {
  return {
    registerAgent: vi.fn(async () => {}),
    unregisterAgent: vi.fn(async () => {}),
  };
});

vi.mock('$lib/services/orchestrator/worktree-manager', () => {
  return {
    createTaskWorktree: vi.fn(async () => ({
      path: '/mock/worktree/path',
      branch: 'worktree/mcp_test_branch',
      baseCommit: 'abc1234',
    })),
  };
});

vi.mock('$lib/services/orchestrator/terminal-lease', () => {
  return {
    sendOrchestratorFollowUpWhenReady: vi.fn(async () => true),
  };
});

vi.mock('$lib/stores/layoutControl', () => {
  return {
    requestRoomControl: vi.fn(),
  };
});

// Reached lazily by the engine: the parent's record, and the place its children
// are persisted.
vi.mock('./session-store', () => {
  return {
    recordForPane: vi.fn(() => parentMock.record),
    recordSubagentSnapshot: (...args: unknown[]) => parentMock.snapshot(...args),
  };
});

import {
  answerMcpSubagent,
  cancelMcpSubagent,
  clearMcpSubagents,
  handleSubagentReport,
  listMcpSubagents,
  openMcpSubagentPane,
  restoreMcpSubagents,
  spawnMcpSubagent,
  subscribeMcpSubagents,
} from './mcp-subagents';
import { getStructuredSubagents, openStructuredSubagent, spawnStructuredSubagent } from './registry';

/** Wait for the fire-and-forget persistence write (a lazy import + microtask). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Make the terminal store report this session list, as the app does on every change. */
function emitSessions(list: typeof terminalMock.list) {
  terminalMock.list = list;
  for (const listener of terminalMock.listeners) listener(list);
}

describe('Spacron MCP subagents engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpSubagents();
    parentMock.record = { id: 'ss_parent', projectId: 'proj-parent', cwd: '/parent/cwd' };
    terminalMock.list = [];
  });

  it('spawns a child subagent using Spacron MCP and worktree isolation', async () => {
    const parentSessionId = 42;
    let fired = false;
    const unsub = subscribeMcpSubagents(parentSessionId, () => {
      fired = true;
    });

    const sub = await spawnMcpSubagent(parentSessionId, 'Review security in auth flow', { preset: 'claude' });

    expect(sub).toBeDefined();
    expect(sub.agent).toBe('claude');
    expect(sub.childSessionId).toBe(99);
    expect(sub.branch).toBe('worktree/mcp_test_branch');
    expect(sub.status).toBe('running');
    expect(sub.assignment).toBe('Review security in auth flow');
    expect(sub.origin).toBe('spacron');
    expect(sub.parentRecordId).toBe('ss_parent');
    expect(fired).toBe(true);

    const list = listMcpSubagents(parentSessionId);
    expect(list.some((s) => s.id === sub.id)).toBe(true);
    unsub();
  });

  it('derives the project and folder from the parent record, not the active project', async () => {
    const { createTaskWorktree } = await import('$lib/services/orchestrator/worktree-manager');
    const { spawnAgentPreset } = await import('$lib/stores/terminal');
    vi.mocked(createTaskWorktree).mockRejectedValueOnce(new Error('not a git repo'));

    await spawnMcpSubagent(43, 'Work in the parent folder', { preset: 'codex' });

    expect(createTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-parent' }));
    expect(spawnAgentPreset).toHaveBeenCalledWith(
      'codex',
      '/parent/cwd',
      expect.objectContaining({ projectId: 'proj-parent', activate: false }),
    );
  });

  it('falls back to the active project when the pane has no record yet', async () => {
    const { createTaskWorktree } = await import('$lib/services/orchestrator/worktree-manager');
    parentMock.record = null;

    const sub = await spawnMcpSubagent(44, 'No record yet', { preset: 'pi' });

    expect(createTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'test-project' }));
    expect(sub.parentRecordId).toBeNull();
  });

  it('persists child state on the parent record', async () => {
    const parentSessionId = 45;
    const sub = await spawnMcpSubagent(parentSessionId, 'Lint files', { preset: 'claude' });
    await settle();
    expect(parentMock.snapshot).toHaveBeenCalledWith('ss_parent', [expect.objectContaining({ id: sub.id })]);

    handleSubagentReport(99, 'done', 'All 40 files pass ESLint.');
    await settle();
    expect(parentMock.snapshot).toHaveBeenLastCalledWith(
      'ss_parent',
      [expect.objectContaining({ id: sub.id, status: 'completed', output: 'All 40 files pass ESLint.' })],
    );
  });

  it('never treats an exit without a final report as a completion', async () => {
    const parentSessionId = 46;
    const sub = await spawnMcpSubagent(parentSessionId, 'Long task', { preset: 'claude' });

    emitSessions([{ id: 99, isRunning: false, lastExitCode: 1 }]);

    const ended = listMcpSubagents(parentSessionId).find((s) => s.id === sub.id);
    expect(ended?.status).toBe('exited');
    expect(ended?.exit).toMatchObject({ clean: false, code: 1 });
    expect(ended?.output).toBeUndefined();
    expect(ended?.log?.some((entry) => entry.kind === 'exit')).toBe(true);
  });

  it('rebuilds the panel from the record and marks a vanished child as lost', async () => {
    const child = {
      id: 'mcp_sub_1_99',
      parentSessionId: 1,
      parentRecordId: 'ss_parent',
      origin: 'spacron' as const,
      childSessionId: 99,
      agent: 'claude',
      assignment: 'Old task',
      status: 'running' as const,
      startedAt: Date.now() - 60_000,
    };

    restoreMcpSubagents(47, 'ss_parent', [child]);
    const lost = listMcpSubagents(47)[0];
    expect(lost.id).toBe('mcp_sub_1_99');
    expect(lost.status).toBe('lost');
    expect(lost.exit?.clean).toBe(false);

    // A child whose session is still running is reattached instead.
    emitSessions([{ id: 99, isRunning: true }]);
    restoreMcpSubagents(48, 'ss_parent', [child]);
    expect(listMcpSubagents(48)[0].status).toBe('running');
  });

  it('opens the subagent pane in the workspace using requestRoomControl', async () => {
    const { requestRoomControl } = await import('$lib/stores/layoutControl');
    const parentSessionId = 49;
    const sub = await spawnMcpSubagent(parentSessionId, 'Run build', { preset: 'codex' });

    openMcpSubagentPane(sub.id);
    expect(requestRoomControl).toHaveBeenCalledWith('focus', 'agent:99');

    // Also through registry
    openStructuredSubagent(sub.id);
    expect(requestRoomControl).toHaveBeenCalledTimes(2);
  });

  it('handles answering a subagent that needs input', async () => {
    const parentSessionId = 50;
    const sub = await spawnMcpSubagent(parentSessionId, 'Migrate DB', { preset: 'pi' });

    // Simulate agent asking for input
    handleSubagentReport(99, 'needs_input', 'Which migration target?');
    const updated = listMcpSubagents(parentSessionId).find((s) => s.id === sub.id);
    expect(updated?.status).toBe('needs-input');
    expect(updated?.question).toBe('Which migration target?');

    // Submit answer
    await answerMcpSubagent(sub.id, 'Target: v2_user_accounts');
    const answered = listMcpSubagents(parentSessionId).find((s) => s.id === sub.id);
    expect(answered?.status).toBe('running');
    expect(answered?.answer).toBe('Target: v2_user_accounts');
    expect(answered?.question).toBeUndefined();
  });

  it('cancels/kills a subagent and cleans up MCP registration', async () => {
    const { killSession } = await import('$lib/stores/terminal');
    const { unregisterAgent } = await import('$lib/stores/mcpBridge');
    const parentSessionId = 51;
    const sub = await spawnMcpSubagent(parentSessionId, 'Long task', { preset: 'antigravity' });

    await cancelMcpSubagent(sub.id);
    expect(killSession).toHaveBeenCalledWith(99);
    expect(unregisterAgent).toHaveBeenCalledWith(99);

    const cancelled = listMcpSubagents(parentSessionId).find((s) => s.id === sub.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.completedAt).toBeDefined();

    // The kill is not read back as an unexpected exit.
    emitSessions([{ id: 99, isRunning: false, lastExitCode: 1 }]);
    expect(listMcpSubagents(parentSessionId).find((s) => s.id === sub.id)?.status).toBe('cancelled');
  });

  it('updates subagent status on completion report', async () => {
    const parentSessionId = 52;
    const sub = await spawnMcpSubagent(parentSessionId, 'Lint files', { preset: 'claude' });

    handleSubagentReport(99, 'done', 'All 40 files pass ESLint.');
    const completed = listMcpSubagents(parentSessionId).find((s) => s.id === sub.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.output).toBe('All 40 files pass ESLint.');
    expect(completed?.completedAt).toBeDefined();
  });

  it('integrates seamlessly with getStructuredSubagents and spawnStructuredSubagent in registry', async () => {
    const parentSessionId = 53;
    const sub = await spawnStructuredSubagent('claude', parentSessionId, 'Test via registry');
    expect(sub).toBeDefined();

    const list = getStructuredSubagents('claude', parentSessionId);
    expect(list.some((s) => s.id === sub?.id)).toBe(true);
    // Claude has no native subagent spawn here, so the child is Spacron-managed.
    expect(list.find((s) => s.id === sub?.id)?.origin).toBe('spacron');
  });
});
