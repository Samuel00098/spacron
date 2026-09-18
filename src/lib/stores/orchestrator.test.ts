import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';

const invoke = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => undefined));
const routeOrchestratorRequest = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const showTerminal = vi.hoisted(() => vi.fn());
const spawnAgentPreset = vi.hoisted(() => vi.fn(async (): Promise<number | null> => 42));
const setSessionOwnerTask = vi.hoisted(() => vi.fn());
const setSessionTaskSummary = vi.hoisted(() => vi.fn());
const setSessionAgentName = vi.hoisted(() => vi.fn());
const setSessionWorktree = vi.hoisted(() => vi.fn());
const setSessionRole = vi.hoisted(() => vi.fn());
const setActiveSession = vi.hoisted(() => vi.fn());
const sendAgentPromptDirect = vi.hoisted(() => vi.fn());
const getSessionOutputBuffer = vi.hoisted(() => vi.fn(() => ''));
// Delegates to the buffer mock so the `mockReturnValueOnce` sequences the launch
// tests set up stay call-for-call identical to when callers read `.length` off
// the buffer themselves.
const getSessionOutputLength = vi.hoisted(() => vi.fn());
const getSessionOutputSince = vi.hoisted(() => vi.fn(() => ''));
const getSessionOutputTail = vi.hoisted(() => vi.fn());
const getSessionOutputProduced = vi.hoisted(() => vi.fn());
const killSession = vi.hoisted(() => vi.fn(async () => undefined));
const getAgentDisplayName = vi.hoisted(() => vi.fn((id: string) => id));
const promptBarInput = vi.hoisted(() => ({ set: vi.fn() }));
const focusPromptBar = vi.hoisted(() => vi.fn());
const summarizeTerminalTask = vi.hoisted(() => vi.fn((text: string) => text));
const waitForAgentReady = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));
const getPresetRuns = vi.hoisted(() => vi.fn(() => []));
// Every dispatch that spawns now waits on the placement dialog ("isolated
// worktree or main repo?"), which answers ONE placement per agent. Tests answer
// it synchronously; a test that wants other answers overrides the impl.
type MockPlacementArgs = { agents: string[] };
const requestAgentPlacement = vi.hoisted(() =>
  vi.fn(
    async (args: MockPlacementArgs): Promise<Array<'worktree' | 'main'> | null> =>
      args.agents.map(() => 'worktree' as const)
  )
);
const answerPlacementWith = (...answers: Array<'worktree' | 'main'>) =>
  requestAgentPlacement.mockImplementation(async (args: MockPlacementArgs) =>
    args.agents.map((_agent, i) => answers[i] ?? answers[answers.length - 1])
  );
const detectAgentAccess = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ ready: boolean; via: string; providerId: string | null; message: string }> => ({
      ready: true,
      via: 'api-key',
      providerId: 'openrouter',
      message: 'OpenRouter is ready.',
    })
  )
);
type MockLiveSession = { id: number; isRunning: boolean; ownerTaskId: string | null; lastExitCode?: number | null; agentName?: string | null; agentPreset?: string | null; isExecuting?: boolean; role?: string | null; worktree?: Record<string, unknown> | null };
// Takes the real signature (projectId, isDev) so tests can return different
// sessions per ambient — the Development ambient keeps its own state map.
const getTerminalProjectState = vi.hoisted(() =>
  vi.fn((_projectId?: string, _isDev?: boolean): { sessions: MockLiveSession[] } => ({ sessions: [] }))
);
const sessionSubscribers = vi.hoisted(() => [] as Array<(value: MockLiveSession[]) => void>);
/** Every session in every project — the reverse lookup from session to project. */
const allSessionsValue = vi.hoisted(
  () => [] as Array<{ id: number; projectId: string; agentName?: string | null; taskSummary?: string | null; paneTitle?: string | null }>,
);
const allProjectSessions = vi.hoisted(() => ({
  subscribe: (cb: (value: unknown[]) => void) => {
    cb(allSessionsValue);
    return () => {};
  },
}));
const getActiveTerminalProjectId = vi.hoisted(() => vi.fn((): string | null => null));
const sessions = vi.hoisted(() => ({
  subscribe: vi.fn((cb: (value: MockLiveSession[]) => void) => {
    sessionSubscribers.push(cb);
    return () => {
      const idx = sessionSubscribers.indexOf(cb);
      if (idx >= 0) sessionSubscribers.splice(idx, 1);
    };
  }),
}));
type MockSessionExitInfo = { sessionId: number; projectId: string; code: number };
const sessionExitListeners = vi.hoisted(() => [] as Array<(info: MockSessionExitInfo) => void>);
const onSessionExit = vi.hoisted(() =>
  vi.fn((cb: (info: MockSessionExitInfo) => void) => {
    sessionExitListeners.push(cb);
    return () => {
      const idx = sessionExitListeners.indexOf(cb);
      if (idx >= 0) sessionExitListeners.splice(idx, 1);
    };
  })
);
type MockAgentDetectedInfo = { sessionId: number; projectId: string; preset: string };
const agentDetectedListeners = vi.hoisted(() => [] as Array<(info: MockAgentDetectedInfo) => void>);
const onAgentDetected = vi.hoisted(() =>
  vi.fn((cb: (info: MockAgentDetectedInfo) => void) => {
    agentDetectedListeners.push(cb);
    return () => {
      const idx = agentDetectedListeners.indexOf(cb);
      if (idx >= 0) agentDetectedListeners.splice(idx, 1);
    };
  })
);

const setActiveView = vi.hoisted(() => vi.fn());
const openSettings = vi.hoisted(() => vi.fn());
const sanitiseActiveView = vi.hoisted(() => vi.fn((v: string) => v));
const createTerminalSession = vi.hoisted(() => vi.fn(async (): Promise<number | null> => 99));
const sendPromptToSession = vi.hoisted(() => vi.fn());
const setSessionExecuting = vi.hoisted(() => vi.fn());
const openFile = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));
const closeFile = vi.hoisted(() => vi.fn());
const jumpToLine = vi.hoisted(() => ({ set: vi.fn() }));
const navigatePreviewTab = vi.hoisted(() => vi.fn());
const ensureProxyRunning = vi.hoisted(() => vi.fn(async () => {}));
const getAppContextSnapshot = vi.hoisted(() => vi.fn(() => ({})));
const sessionHasRunningProcess = vi.hoisted(() => vi.fn((s: MockLiveSession) => {
  const role = (s as { role?: string | null }).role?.toLowerCase();
  return !!role && (role === 'server' || role === 'build');
}));
const NAVIGABLE_VIEWS = vi.hoisted(() => ['editor', 'terminal', 'preview', 'review', 'http', 'tasks', 'db', 'containers', 'toolbox', 'settings']);

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
// `sendChatMessage` also reads ADMIN_KEYWORD_RE from this module to decide
// whether a heuristic-route spawn should skip worktree isolation, so the mock
// has to provide it too. A bare `{ routeOrchestratorRequest }` mock made every
// spawn-executing test throw on the missing export.
vi.mock('$lib/services/orchestrator-brain', () => ({
  routeOrchestratorRequest,
  ADMIN_KEYWORD_RE: /\bgit\s+tag\b|\bcut(ting)?\s+(a\s+)?release\b/i,
  detectStatedPlacement: (text: string) => {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return null;
    if (/^all[:\s]+isolated(\s+worktree)?s?$/i.test(trimmed)) return 'worktree';
    if (/^all[:\s]+main(\s+repo(sitory)?)?$/i.test(trimmed)) return 'main';
    if (/^isolated worktree$/i.test(trimmed)) return 'worktree';
    if (/^main repo$/i.test(trimmed)) return 'main';
    if (/^\s*(in\s+)?(an?\s+|the\s+)?(new\s+|separate\s+|isolated\s+)?(work[\s-]?trees?|isolation|isolated)\b[\s.!]*$/i.test(trimmed)) {
      return 'worktree';
    }
    if (/^\s*(in\s+)?(the\s+)?(main|primary)\s*(repo(sitory)?|branch|checkout)?\b[\s.!]*$/i.test(trimmed)) {
      return 'main';
    }
    return null;
  },
}));
vi.mock('$lib/services/agent-access', () => ({
  detectAgentAccess,
  getAgentAccessBlockedMessage: () => 'To access the agent, add an API key or load a local model into the application.',
}));
vi.mock('$lib/stores/notification', () => ({ showToast }));
vi.mock('$lib/stores/layout', () => ({ showTerminal, setActiveView, openSettings, sanitiseActiveView }));
vi.mock('$lib/stores/editor', () => ({ openFile, closeFile, jumpToLine }));
// `executeAppAction` awaits ensureProxyRunning() before navigating the preview,
// so the mock must expose it alongside navigatePreviewTab.
vi.mock('$lib/stores/preview', () => ({ navigatePreviewTab, ensureProxyRunning }));
vi.mock('$lib/services/orchestrator/app-context', () => ({ getAppContextSnapshot, NAVIGABLE_VIEWS }));
vi.mock('$lib/stores/runs', () => ({ getPresetRuns }));
vi.mock('$lib/stores/agentPlacement', () => ({
  requestAgentPlacement,
  defaultAgentPlacement: () => 'worktree' as const,
}));
vi.mock('$lib/stores/terminal', () => ({
  sessions,
  onSessionExit,
  onAgentDetected,
  spawnAgentPreset,
  setSessionOwnerTask,
  setSessionTaskSummary,
  setSessionAgentName,
  setSessionRole,
  setSessionWorktree,
  setActiveSession,
  sendAgentPromptDirect,
  getSessionOutputBuffer,
  getSessionOutputLength,
  getSessionOutputSince,
  getSessionOutputTail,
  getSessionOutputProduced,
  killSession,
  getAgentDisplayName,
  promptBarInput,
  focusPromptBar,
  summarizeTerminalTask,
  getTerminalProjectState,
  waitForAgentReady,
  createTerminalSession,
  sendPromptToSession,
  sessionHasRunningProcess,
  setSessionExecuting,
  markOrchestratorTrackedSession: vi.fn(),
  unmarkOrchestratorTrackedSession: vi.fn(),
  allProjectSessions,
  getActiveTerminalProjectId,
}));

import { cleanupStaleWorktrees, trackedWorktrees, reclaimProjectWorktrees, orchestratorTasks, chatMessages, createOrchestratorTask, deleteOrchestratorTask, loadProjectOrchestratorTasks, launchOrchestratorTask, unlinkOrchestratorTask, resendOrchestratorGoal, resumeBlockedOrchestratorTask, renameOrchestratorAgent, sendChatMessage, recordUnwatchedAgentReport, runBrainCommand, formatBrainRunResult, resetOrchestratorCachesForTests } from './orchestrator';
import { makeActivityEvent } from '$lib/services/orchestrator/activity-log';
import { buildAgentCharter, buildAgentTaskMessage } from '$lib/services/orchestrator/agent-charter';
import { tasks, addTask } from '$lib/stores/tasks';
import { chatThreadState, createChatThread, resetChatThreadsForTests } from '$lib/stores/chatThreads';
import { appendLegacyChatMessage } from '$lib/stores/chatThreads';
import { deliverTurnSignal } from '$lib/services/orchestrator/agent-hook-signals';

function resetMocks() {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === 'workspace_git_create_worktree') return { path: '/repo/isolated', branch: 'spacron/test', base_branch: 'main', base_commit: 'abc' };
  });
  routeOrchestratorRequest.mockReset();
  showToast.mockReset();
  showTerminal.mockReset();
  spawnAgentPreset.mockReset();
  spawnAgentPreset.mockResolvedValue(42);
  setSessionOwnerTask.mockReset();
  setSessionTaskSummary.mockReset();
  setSessionAgentName.mockReset();
  setSessionRole.mockReset();
  setSessionWorktree.mockReset();
  setActiveSession.mockReset();
  sendAgentPromptDirect.mockReset();
  sendAgentPromptDirect.mockResolvedValue(true);
  getSessionOutputBuffer.mockReset();
  getSessionOutputBuffer.mockReturnValue('');
  getSessionOutputLength.mockReset();
  getSessionOutputLength.mockImplementation(() => getSessionOutputBuffer().length);
  getSessionOutputSince.mockReset();
  getSessionOutputSince.mockReturnValue('');
  // The turn watcher reads growth from the monotonic produced counter and pulls
  // only the new tail; both are derived from the same fake buffer these tests
  // already drive, so they stay in step with `getSessionOutputBuffer`.
  getSessionOutputTail.mockReset();
  getSessionOutputTail.mockImplementation((_id: number, chars: number) =>
    chars <= 0 ? '' : String(getSessionOutputBuffer()).slice(-chars));
  getSessionOutputProduced.mockReset();
  getSessionOutputProduced.mockImplementation(() => getSessionOutputBuffer().length);
  killSession.mockReset();
  getAgentDisplayName.mockReset();
  getAgentDisplayName.mockImplementation((id: string) => id);
  promptBarInput.set.mockReset();
  focusPromptBar.mockReset();
  summarizeTerminalTask.mockReset();
  summarizeTerminalTask.mockImplementation((text: string) => text);
  waitForAgentReady.mockReset();
  waitForAgentReady.mockResolvedValue(undefined);
  getPresetRuns.mockReset();
  getPresetRuns.mockReturnValue([]);
  requestAgentPlacement.mockReset();
  answerPlacementWith('worktree');
  detectAgentAccess.mockReset();
  detectAgentAccess.mockResolvedValue({
    ready: true,
    via: 'api-key',
    providerId: 'openrouter',
    message: 'OpenRouter is ready.',
  });
  getTerminalProjectState.mockReset();
  getTerminalProjectState.mockReturnValue({ sessions: [] });
  setActiveView.mockReset();
  openSettings.mockReset();
  openFile.mockReset();
  openFile.mockResolvedValue(undefined);
  closeFile.mockReset();
  jumpToLine.set.mockReset();
  navigatePreviewTab.mockReset();
  createTerminalSession.mockReset();
  createTerminalSession.mockResolvedValue(99);
  sendPromptToSession.mockReset();
  getAppContextSnapshot.mockReset();
  getAppContextSnapshot.mockReturnValue({});
  chatMessages.set({});
  tasks.set([]);
  sessions.subscribe.mockReset();
  sessions.subscribe.mockImplementation((cb: (value: MockLiveSession[]) => void) => {
    sessionSubscribers.push(cb);
    return () => {
      const idx = sessionSubscribers.indexOf(cb);
      if (idx >= 0) sessionSubscribers.splice(idx, 1);
    };
  });
  sessionSubscribers.length = 0;
  allSessionsValue.length = 0;
  getActiveTerminalProjectId.mockReset();
  getActiveTerminalProjectId.mockReturnValue(null);
}

describe('orchestrator terminal leasing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    orchestratorTasks.set([]);
    chatMessages.set({});
    resetMocks();
  });

  afterEach(() => {
    orchestratorTasks.set([]);
    chatMessages.set({});
    resetChatThreadsForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not launch in the main repo when isolation fails', async () => {
    const task = createOrchestratorTask('project-1', 'Isolated task', 'claude');
    invoke.mockImplementation(async (command: string) => {
      if (command === 'workspace_git_create_worktree') throw new Error('Git permission denied');
    });
    await expect(launchOrchestratorTask(task.id, 'claude', '/repo', false)).resolves.toBeNull();
    expect(spawnAgentPreset).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Git permission denied'), 'error');
  });

  it('keeps an existing worktree and never retries in main after terminal failure', async () => {
    const task = createOrchestratorTask('project-1', 'Isolated task', 'claude');
    const worktree = { path: '/repo/isolated', branch: 'spacron/test', baseBranch: 'main', baseCommit: 'abc', createdAt: 0 };
    orchestratorTasks.update((tasks) => tasks.map((t) => t.id === task.id ? { ...t, worktree } : t));
    spawnAgentPreset.mockResolvedValue(null);
    await expect(launchOrchestratorTask(task.id, 'claude', '/repo', false)).resolves.toBeNull();
    expect(spawnAgentPreset).toHaveBeenCalledTimes(1);
    expect(spawnAgentPreset).toHaveBeenCalledWith('claude', worktree.path, expect.anything());
    expect(get(orchestratorTasks)[0].worktree).toEqual(worktree);
    expect(invoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('leases and activates a direct launch while recording owner and summary', async () => {
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: 'pending' }] });
    const task = createOrchestratorTask('project-1', 'Explain how the lease boundary works', 'claude');
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: task.id }] });

    await launchOrchestratorTask(task.id, 'claude', '/repo', false);

    expect(spawnAgentPreset).toHaveBeenCalledWith('claude', '/repo/isolated', { activate: true, skipAutoBrief: true });
    expect(setSessionOwnerTask).toHaveBeenCalledWith(42, task.id);
    expect(setSessionTaskSummary).toHaveBeenCalledWith(42, task.title);
    // Launching focuses the new agent's pane but must NOT switch the aux view to
    // the terminal — the Agents panel stays open beside the always-visible terminal.
    expect(showTerminal).not.toHaveBeenCalled();
    expect(setActiveSession).toHaveBeenCalledWith(42);
    expect(promptBarInput.set).toHaveBeenCalledWith(task.goal);
    expect(focusPromptBar).toHaveBeenCalledTimes(1);
    expect(get(orchestratorTasks)[0].status).toBe('in-progress');
    expect(get(orchestratorTasks)[0].assignedSessionId).toBe(42);

    // claude reads a rules file, so its standing brief is written to CLAUDE.md /
    // AGENTS.md when the CLI boots — it is never pasted into the REPL. A manual
    // (no-goal) launch therefore sends nothing live; the goal just goes to the
    // prompt bar for the user to send.
    getSessionOutputBuffer.mockReturnValue('booted output................................');
    await vi.advanceTimersByTimeAsync(9300);
    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
  });

  it('passes Chat runtime choices through the lease without changing ordinary launches', async () => {
    const task = createOrchestratorTask('project-1', 'Use the selected Chat runtime', 'claude');
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: task.id }] });

    await launchOrchestratorTask(task.id, 'claude', '/repo', {
      autoRun: false,
      model: 'claude-opus-4',
      accessMode: 'auto-edits',
      reasoningEffort: 'high',
    });

    expect(spawnAgentPreset).toHaveBeenCalledWith('claude', '/repo/isolated', {
      activate: true,
      skipAutoBrief: true,
      permissionArgsOverride: '--permission-mode acceptEdits',
      runtimeArgs: '--model claude-opus-4 --effort high',
    });
  });

  it('marks a launched task as starting until its goal is sent', async () => {
    const task = createOrchestratorTask('project-1', 'Fix the terminal lease flow', 'claude');
    getSessionOutputBuffer.mockReturnValueOnce('').mockReturnValue('booted output................................');
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: task.id }] });

    await launchOrchestratorTask(task.id, 'claude', '/repo', true);
    expect(get(orchestratorTasks)[0].promptSentAt).toBeNull();

    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    // claude reads a rules file, so it already holds the standing brief — only the
    // task goes live (no charter wrap pasted into the REPL).
    expect(sendAgentPromptDirect).toHaveBeenCalledWith(42, buildAgentTaskMessage(task.goal, { name: null }));
    expect(get(orchestratorTasks)[0].promptSentAt).toBeTypeOf('number');
    expect(showToast).toHaveBeenCalledWith('Sent goal to claude', 'info', 3000);
  });

  it('pastes the full charter for agents that do NOT read a rules file', async () => {
    // `traecli` reads no rules file at all (verified 2026-08-12 — the open-source
    // trae-agent CLI has no AGENTS.md/CLAUDE.md/.trae-rules loader), so the only
    // way it gets the standing brief is the legacy REPL paste — the charter
    // wrapped around the goal.
    const task = createOrchestratorTask('project-1', 'Fix the terminal lease flow', 'traecli');
    getSessionOutputBuffer.mockReturnValueOnce('').mockReturnValue('booted output................................');
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: task.id }] });

    await launchOrchestratorTask(task.id, 'traecli', '/repo', true);
    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    expect(sendAgentPromptDirect).toHaveBeenCalledWith(42, buildAgentCharter(task.goal, { name: null }));
  });

  it('sends only the task message to a rules-file agent like pi', async () => {
    // pi loads AGENTS.md/CLAUDE.md as context files at startup (verified
    // 2026-08-12), so re-pasting the charter is redundant — only the goal goes
    // over the wire, matching the rules-file channel.
    const task = createOrchestratorTask('project-1', 'Fix the terminal lease flow', 'pi');
    getSessionOutputBuffer.mockReturnValueOnce('').mockReturnValue('booted output................................');
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: task.id }] });

    await launchOrchestratorTask(task.id, 'pi', '/repo', true);
    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    expect(sendAgentPromptDirect).toHaveBeenCalledWith(42, buildAgentTaskMessage(task.goal, { name: null }));
  });

  it('clears stale persisted lease fields for non-in-progress tasks on load', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'project_state_read') {
        return JSON.stringify([
          {
            id: 'task-1',
            projectId: 'project-1',
            goal: 'Review the lease cleanup',
            title: 'Review the lease cleanup',
            status: 'todo',
            assignedSessionId: 42,
            startedAt: 111,
            completedAt: 222,
            createdAt: 100,
          },
        ]);
      }
      return undefined;
    });

    await loadProjectOrchestratorTasks({ id: 'project-1', root_path: '/repo' });

    expect(get(orchestratorTasks)).toEqual([
      expect.objectContaining({
        id: 'task-1',
        projectId: 'project-1',
        status: 'todo',
        assignedSessionId: null,
        startedAt: null,
        completedAt: null,
      }),
    ]);

    const writeCall = invoke.mock.calls.find(([command]) => command === 'project_state_write');
    expect(writeCall).toBeDefined();
    const [, writeArgs] = writeCall as [string, { projectId: string; key: string; content: string }];
    expect(writeArgs.projectId).toBe('project-1');
    expect(writeArgs.key).toBe('orchestrator.json');
    expect(JSON.parse(writeArgs.content)[0]).toMatchObject({
      id: 'task-1',
      projectId: 'project-1',
      status: 'todo',
      assignedSessionId: null,
      startedAt: null,
      completedAt: null,
    });
  });

  it('flushes normalized persisted fields on load', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'project_state_read') {
        return JSON.stringify([
          {
            id: 'task-2',
            projectId: 'project-1',
            goal: '  Trim this goal  ',
            title: '',
            status: 'pending',
            createdAt: 100,
          },
        ]);
      }
      return undefined;
    });

    await loadProjectOrchestratorTasks({ id: 'project-1', root_path: '/repo' });

    const writeCall = invoke.mock.calls.find(([command]) => command === 'project_state_write');
    expect(writeCall).toBeDefined();
    const [, writeArgs] = writeCall as [string, { projectId: string; key: string; content: string }];
    expect(JSON.parse(writeArgs.content)[0]).toMatchObject({
      id: 'task-2',
      projectId: 'project-1',
      goal: 'Trim this goal',
      title: 'Trim this goal',
      status: 'todo',
    });
  });

  it('resets an in-progress task when the live session is owned by another task', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'project_state_read') {
        return JSON.stringify([
          {
            id: 'task-3',
            projectId: 'project-1',
            goal: 'Check live ownership',
            title: 'Check live ownership',
            status: 'in-progress',
            assignedSessionId: 42,
            startedAt: 111,
            createdAt: 100,
          },
        ]);
      }
      return undefined;
    });
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: 'other-task' }] });

    await loadProjectOrchestratorTasks({ id: 'project-1', root_path: '/repo' });

    expect(get(orchestratorTasks)[0]).toEqual(
      expect.objectContaining({
        id: 'task-3',
        projectId: 'project-1',
        status: 'todo',
        assignedSessionId: null,
        startedAt: null,
        completedAt: null,
      })
    );

    const writeCall = invoke.mock.calls.find(([command]) => command === 'project_state_write');
    expect(writeCall).toBeDefined();
    const [, writeArgs] = writeCall as [string, { projectId: string; key: string; content: string }];
    expect(JSON.parse(writeArgs.content)[0]).toMatchObject({
      id: 'task-3',
      projectId: 'project-1',
      status: 'todo',
      assignedSessionId: null,
      startedAt: null,
      completedAt: null,
    });
  });

  it('reclaims a loaded todo task from a live owned session', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'project_state_read') {
        return JSON.stringify([
          {
            id: 'task-4',
            projectId: 'project-1',
            goal: 'Claim live ownership',
            title: 'Claim live ownership',
            status: 'todo',
            createdAt: 100,
          },
        ]);
      }
      return undefined;
    });
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: 'task-4' }] });

    await loadProjectOrchestratorTasks({ id: 'project-1', root_path: '/repo' });

    expect(get(orchestratorTasks)[0]).toEqual(
      expect.objectContaining({
        id: 'task-4',
        projectId: 'project-1',
        status: 'in-progress',
        assignedSessionId: 42,
      })
    );

    const writeCall = invoke.mock.calls.find(([command]) => command === 'project_state_write');
    expect(writeCall).toBeDefined();
    const [, writeArgs] = writeCall as [string, { projectId: string; key: string; content: string }];
    expect(JSON.parse(writeArgs.content)[0]).toMatchObject({
      id: 'task-4',
      projectId: 'project-1',
      status: 'in-progress',
      assignedSessionId: 42,
    });
  });

  it('reclaims an in-progress task from a live owned session when the lease id is missing', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'project_state_read') {
        return JSON.stringify([
          {
            id: 'task-4',
            projectId: 'project-1',
            goal: 'Claim live ownership',
            title: 'Claim live ownership',
            status: 'in-progress',
            assignedSessionId: null,
            startedAt: 111,
            createdAt: 100,
          },
        ]);
      }
      return undefined;
    });
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: 'task-4' }] });

    await loadProjectOrchestratorTasks({ id: 'project-1', root_path: '/repo' });

    expect(get(orchestratorTasks)[0]).toEqual(
      expect.objectContaining({
        id: 'task-4',
        projectId: 'project-1',
        status: 'in-progress',
        assignedSessionId: 42,
      })
    );

    const writeCall = invoke.mock.calls.find(([command]) => command === 'project_state_write');
    expect(writeCall).toBeDefined();
    const [, writeArgs] = writeCall as [string, { projectId: string; key: string; content: string }];
    expect(JSON.parse(writeArgs.content)[0]).toMatchObject({
      id: 'task-4',
      projectId: 'project-1',
      status: 'in-progress',
      assignedSessionId: 42,
    });
  });

  it('aborts auto-send when the leased session stops running before the goal is sent', async () => {
    const task = createOrchestratorTask('project-1', 'Fix the terminal lease flow', 'claude');
    // Keep the agent "starting up" long enough for the session to die first.
    waitForAgentReady.mockImplementationOnce(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
    let sessionRunning = true;
    getTerminalProjectState.mockImplementation(() => ({ sessions: [{ id: 42, isRunning: sessionRunning, ownerTaskId: task.id }] }));

    await launchOrchestratorTask(task.id, 'claude', '/repo', true);
    sessionRunning = false;
    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('releases the lease and returns the task to todo when unlinked', async () => {
    const task = createOrchestratorTask('project-1', 'Explain how the lease boundary works', 'claude');

    await launchOrchestratorTask(task.id, 'claude', '/repo', false);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: task.id }] });
    setSessionOwnerTask.mockClear();
    setSessionTaskSummary.mockClear();

    unlinkOrchestratorTask(task.id);

    expect(setSessionOwnerTask).toHaveBeenCalledWith(42, null);
    expect(setSessionTaskSummary).toHaveBeenCalledWith(42, null);
    expect(get(orchestratorTasks)[0].status).toBe('todo');
    expect(get(orchestratorTasks)[0].assignedSessionId).toBeNull();
  });

  it('resends the goal to the leased terminal', async () => {
    const task = createOrchestratorTask('project-1', 'Fix the terminal lease flow', 'claude');
    orchestratorTasks.set([{ ...task, status: 'in-progress', assignedSessionId: 42 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: task.id }] });

    resendOrchestratorGoal(task.id);

    // A resend re-delivers the goal; claude holds the brief via its rules file, so
    // only the task is re-sent (no charter wrap).
    expect(sendAgentPromptDirect).toHaveBeenCalledWith(42, buildAgentTaskMessage(task.goal, { name: null }));
    expect(showToast).toHaveBeenCalledWith('Re-sent goal to agent', 'info', 2500);
  });

  it('does not resend to a live session owned by another task', async () => {
    const task = createOrchestratorTask('project-1', 'Fix the terminal lease flow', 'claude');
    orchestratorTasks.set([{ ...task, status: 'in-progress', assignedSessionId: 42 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: 'other-task' }] });

    resendOrchestratorGoal(task.id);

    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('orchestrator chat actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    orchestratorTasks.set([]);
    resetChatThreadsForTests();
    resetOrchestratorCachesForTests();
    resetMocks();
  });

  afterEach(() => {
    orchestratorTasks.set([]);
    chatMessages.set({});
    resetChatThreadsForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('responds with a setup message when no API key or local model is available', async () => {
    detectAgentAccess.mockResolvedValue({
      ready: false,
      via: 'none',
      providerId: null,
      message: 'To access the agent, add an API key or load a local model into the application.',
    });

    await sendChatMessage('project-1', '/repo', 'Open an agent for me');

    expect(routeOrchestratorRequest).not.toHaveBeenCalled();
    expect(get(chatMessages)['project-1']).toEqual([
      expect.objectContaining({ role: 'user', text: 'Open an agent for me' }),
      expect.objectContaining({
        role: 'assistant',
        text: 'To access the agent, add an API key or load a local model into the application.',
      }),
    ]);
  });

  it('forwards only user messages and a compact task memory while keeping assistant chat visible', async () => {
    const seed = createOrchestratorTask('project-1', 'Inspect the login flow', 'claude', 'Backend');
    orchestratorTasks.set([
      {
        ...seed,
        status: 'complete',
        completedAt: 20,
        activity: [
          makeActivityEvent('dispatch', 'Launched Backend', 10),
          makeActivityEvent('finished', 'Tests green', 20),
        ],
        transcript: 'npm test\nTest Files 2 passed\nAll green',
      },
    ]);
    chatMessages.set({
      'project-1': [
        { id: 'u1', role: 'user', text: 'Please keep going', ts: 1 },
        { id: 'a1', role: 'assistant', text: 'I can handle that.', ts: 2 },
        { id: 'u2', role: 'user', text: 'Use the same branch', ts: 3 },
      ],
    });
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Done.',
      actions: [],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'Please finish it', { projectName: 'Atlas' });

    expect(routeOrchestratorRequest).toHaveBeenCalledTimes(1);
    const [, , ctx] = routeOrchestratorRequest.mock.calls[0];
    expect(ctx.projectName).toBe('Atlas');
    expect(ctx.recentUserMessages).toEqual(['Please keep going', 'Use the same branch']);
    expect(ctx.recentUserMessages).not.toContain('I can handle that.');
    expect(ctx.taskMemory).toHaveLength(1);
    expect(ctx.taskMemory?.[0]).toContain('Backend [claude, complete]');
    expect(ctx.taskMemory?.[0]).toContain('dispatch: Launched Backend');
    expect(ctx.taskMemory?.[0]).toContain('finished: Tests green');
    expect(ctx.taskOutputs).toHaveLength(1);
    expect(ctx.taskOutputs?.[0]).toMatchObject({
      name: 'Backend',
      agent: 'claude',
      status: 'complete',
      recentOutput: expect.stringContaining('All green'),
    });

    const transcript = get(chatMessages)['project-1'];
    expect(transcript[transcript.length - 1]).toMatchObject({ role: 'assistant', text: 'Done.', pending: false });
  });

  it('fetches files the brain asks for and re-routes so it can answer from source', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'fs_read_file') return 'export const x = 1;\nconsole.log(x);';
      if (command === 'fs_read_dir') return [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }];
    });
    routeOrchestratorRequest
      .mockResolvedValueOnce({ reply: 'Let me check that.', actions: [], readFiles: ['src/a.ts'], viaLLM: true })
      .mockResolvedValueOnce({ reply: 'It exports x as 1.', actions: [], viaLLM: true });

    await sendChatMessage('project-1', '/repo', 'How is x wired?');

    expect(routeOrchestratorRequest).toHaveBeenCalledTimes(2);
    const [, , secondCtx] = routeOrchestratorRequest.mock.calls[1];
    expect(secondCtx.projectReads).toEqual([
      expect.objectContaining({ path: 'src/a.ts', content: expect.stringContaining('console.log(x);'), truncated: false }),
    ]);
    expect(secondCtx.projectTree).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('fs_read_file', { path: '/repo/src/a.ts' });

    const transcript = get(chatMessages)['project-1'];
    expect(transcript[transcript.length - 1]).toMatchObject({ role: 'assistant', text: 'It exports x as 1.', pending: false });
  });

  it('deduplicates repeated read_file calls within one tool batch', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'fs_read_file') return 'export const x = 1;';
      if (command === 'fs_read_dir') return [];
      return undefined;
    });
    routeOrchestratorRequest.mockImplementation(async (_message: string, _agents: unknown[], context: any) => {
      const calls = Array.from({ length: 7 }, (_, index) => context.toolExecutor({
        id: `read-${index}`,
        name: 'read_file',
        args: { path: 'src/a.ts' },
      }));
      const executions = await Promise.all(calls);
      return { reply: executions[0].output, actions: [], viaLLM: true };
    });

    await sendChatMessage('project-1', '/repo', 'How is x wired?');

    expect(invoke.mock.calls.filter(([command]) => command === 'fs_read_file')).toHaveLength(1);
    expect(get(chatMessages)['project-1'].filter((message) => message.type === 'activity')).toHaveLength(1);
  });

  it('uses the backend glob traversal alongside the project tree', async () => {
    invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === 'fs_glob_files') return ['src/App.tsx'];
      if (command !== 'fs_read_dir') return undefined;
      if (args?.path === '/repo') return [
        { name: 'src', is_dir: true },
        { name: 'package.json', is_dir: false },
      ];
      if (args?.path === '/repo/src') return [
        { name: 'App.tsx', is_dir: false },
      ];
      return [];
    });
    routeOrchestratorRequest.mockImplementation(async (_message: string, _agents: unknown[], context: any) => {
      const execution = await context.toolExecutor({
        id: 'glob-1',
        name: 'glob_files',
        args: { pattern: 'src/**/*' },
      });
      return { reply: execution.output, actions: [], viaLLM: true };
    });

    await sendChatMessage('project-1', '/repo', 'Review the application and suggest improvements');

    expect(routeOrchestratorRequest).toHaveBeenCalledTimes(1);
    const [, , context] = routeOrchestratorRequest.mock.calls[0];
    expect(context.projectTree).toContain('[dir] src');
    expect(context.projectTree).toContain('[file] src/App.tsx');
    expect(get(chatMessages)['project-1'].at(-1)).toMatchObject({
      role: 'assistant',
      text: expect.stringContaining('src/App.tsx'),
      pending: false,
    });
  });

  it('reads the relevant project files in one broad review tool call', async () => {
    invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === 'fs_glob_files') return ['README.md', 'package.json', 'logo.png', 'src/App.tsx', 'src/styles.css'];
      if (command === 'fs_read_dir') {
        if (args?.path === '/repo') return [
          { name: 'src', is_dir: true },
          { name: 'README.md', is_dir: false },
          { name: 'package.json', is_dir: false },
          { name: 'logo.png', is_dir: false },
        ];
        if (args?.path === '/repo/src') return [
          { name: 'App.tsx', is_dir: false },
          { name: 'styles.css', is_dir: false },
        ];
        return [];
      }
      if (command === 'fs_read_file') {
        const contents: Record<string, string> = {
          '/repo/README.md': '# SelloCRM\nReview the dashboard flow.',
          '/repo/package.json': '{"scripts":{"test":"vitest"}}',
          '/repo/src/App.tsx': 'export function App() { return <Dashboard />; }',
          '/repo/src/styles.css': '.dashboard { display: grid; }',
        };
        return contents[args?.path ?? ''] ?? '';
      }
      return undefined;
    });
    routeOrchestratorRequest.mockImplementation(async (_message: string, _agents: unknown[], context: any) => {
      const execution = await context.toolExecutor({
        id: 'review-project',
        name: 'read_project',
        args: { max_files: 80 },
      });
      return { reply: execution.output, actions: [], viaLLM: true };
    });

    await sendChatMessage('project-1', '/repo', 'Go through the application and suggest changes');

    const transcript = get(chatMessages)['project-1'];
    expect(transcript.at(-1)).toMatchObject({
      role: 'assistant',
      text: expect.stringContaining('src/App.tsx'),
      pending: false,
    });
    expect(transcript.at(-1)?.text).toContain('README.md');
    expect(transcript.at(-1)?.text).toContain('styles.css');
    expect(transcript.at(-1)?.text).not.toContain('logo.png');
    expect(invoke).toHaveBeenCalledWith('fs_read_file', { path: '/repo/src/App.tsx' });
  });

  it('does not let a bare "I will help" reply dead-end: auto-reads overview files and re-routes', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'fs_read_file') return '{"name": "spacron", "scripts": {"check": "tsc --noEmit"}}';
      if (command === 'fs_read_dir') return [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }];
    });
    routeOrchestratorRequest
      .mockResolvedValueOnce({
        reply: "Absolutely, I'll help you map out the project and every single thing.",
        actions: [],
        viaLLM: true,
      })
      .mockResolvedValueOnce({
        reply: 'The project is a TypeScript app. Its scripts live in package.json.',
        actions: [],
        viaLLM: true,
      });

    await sendChatMessage('project-1', '/repo', 'Go through the project and report back');

    // The first bare acknowledgement must not end the turn — the app reads
    // package.json (present in the tree) and re-routes so the model answers
    // from real source.
    expect(routeOrchestratorRequest).toHaveBeenCalledTimes(2);
    const [, , secondCtx] = routeOrchestratorRequest.mock.calls[1];
    expect(secondCtx.projectReads).toEqual([
      expect.objectContaining({
        path: 'package.json',
        content: expect.stringContaining('"scripts"'),
        truncated: false,
      }),
    ]);

    const transcript = get(chatMessages)['project-1'];
    expect(transcript[transcript.length - 1]).toMatchObject({
      role: 'assistant',
      text: 'The project is a TypeScript app. Its scripts live in package.json.',
      pending: false,
    });
  });

  it('renders model-declared todo statuses from update_todos instead of force-checking them', async () => {
    const thread = createChatThread('project-1', { title: 'Atlas' });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'fs_read_file') return '{"name": "spacron"}';
      if (command === 'fs_read_dir') return [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }];
    });
    routeOrchestratorRequest.mockImplementation(async (_message: string, _agents: unknown[], context: any) => {
      // The model declares its plan through the TOOL, with two items left
      // honestly unfinished (blocked + pending).
      const execution = await context.toolExecutor({
        id: 'plan-1',
        name: 'update_todos',
        args: { todos: ['[x] Inspect auth wiring', '[~] Fix token refresh', '[!] Needs the API base URL', '[ ] Add tests'] },
      });
      expect(execution.output).toContain('Recorded 4 todo items (1 completed)');
      // The real brain reports every executed round through onToolRound; the
      // test must honour that contract or Phase 4 sees no evidence at all.
      context.onToolRound?.([{ id: 'plan-1', name: 'update_todos', ok: true, output: execution.output }], 1);
      return { reply: 'Partial progress: the refresh fix is in, two items remain.', actions: [], viaLLM: true };
    });

    await sendChatMessage('project-1', '/repo', 'fix the token refresh and add tests', { projectName: 'Atlas', threadId: thread.id });

    // The turn appends tool-activity cards (also role=assistant); the reply is
    // the last assistant message that is not an activity card.
    const assistantMessages = get(chatMessages)['project-1'].filter((m) => m.role === 'assistant' && m.type !== 'activity');
    const final = assistantMessages[assistantMessages.length - 1];
    expect(final.text).toContain('### Plan & Tasks');
    expect(final.text).toContain('- [x] Inspect auth wiring');
    expect(final.text).toContain('- [~] Fix token refresh');
    expect(final.text).toContain('- [!] Needs the API base URL');
    expect(final.text).toContain('- [ ] Add tests');
    // The old blanket check must not paint unfinished items done.
    expect(final.text).not.toContain('- [x] Fix token refresh');
    expect(final.text).not.toContain('- [x] Needs the API base URL');
  });

  it('keeps the todo list sticky when update_todos re-announces reworded plans mid-turn', async () => {
    const thread = createChatThread('project-1', { title: 'Atlas' });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'fs_read_file') return '{"name": "spacron"}';
      if (command === 'fs_read_dir') return [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }];
    });
    routeOrchestratorRequest.mockImplementation(async (_message: string, _agents: unknown[], context: any) => {
      // Round 1: the model plans three steps.
      const first = await context.toolExecutor({
        id: 'plan-a',
        name: 'update_todos',
        args: { todos: ['[~] Inspect the schema', '[ ] Review onboarding flow', '[ ] Polish the landing page'] },
      });
      expect(first.output).toContain('Recorded 3 todo items');
      context.onToolRound?.([{ id: 'plan-a', name: 'update_todos', ok: true, output: first.output }], 1);
      // Round 2: the model re-announces with reworded steps and drops one.
      // The list must NOT churn: same steps stay, statuses move forward.
      const second = await context.toolExecutor({
        id: 'plan-b',
        name: 'update_todos',
        args: { todos: ['[x] Inspect schema', '[~] Review onboarding'] },
      });
      expect(second.output).toContain('Recorded 2 todo items (1 completed)');
      context.onToolRound?.([{ id: 'plan-b', name: 'update_todos', ok: true, output: second.output }], 2);
      return { reply: 'Done.', actions: [], viaLLM: true };
    });

    await sendChatMessage('project-1', '/repo', 'improve the app', { projectName: 'Atlas', threadId: thread.id });

    const assistantMessages = get(chatMessages)['project-1'].filter((m) => m.role === 'assistant' && m.type !== 'activity');
    const final = assistantMessages[assistantMessages.length - 1];
    // Every planned step survives the re-announce; nothing churned away.
    expect(final.text).toContain('Inspect the schema');
    expect(final.text).toContain('Review onboarding flow');
    expect(final.text).toContain('Polish the landing page');
  });

  it('indexes previously written Documents/ files into the brain context at turn start', async () => {
    const thread = createChatThread('project-1', { title: 'Atlas' });
    invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === 'fs_glob_files') return ['docs/plans/2026-09-01-auth-plan.md', 'Documents/legacy-notes.md', 'src/App.tsx', 'README.md'];
      if (command === 'fs_read_file' && args?.path?.includes('auth-plan')) {
        return '# Auth overhaul plan\nGoal: unify token refresh across all clients.\nPhase 1: audit the current refresh flow.';
      }
      if (command === 'fs_read_file') return '{"name": "spacron"}';
      if (command === 'fs_read_dir') return [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }];
      return undefined;
    });
    let seenIndex: string | undefined;
    routeOrchestratorRequest.mockImplementation(async (_message: string, _agents: unknown[], context: any) => {
      seenIndex = context.documentsIndex;
      return { reply: 'The stored plan says the goal is unified token refresh.', actions: [], viaLLM: true };
    });

    await sendChatMessage('project-1', '/repo', 'what did we plan for auth?', { projectName: 'Atlas', threadId: thread.id });

    // Only docs/*.md files are indexed (not src/App.tsx or README.md), with
    // the heading as title and body prose as excerpt. A legacy Documents/
    // file stays visible too.
    expect(seenIndex).toContain('docs/plans/2026-09-01-auth-plan.md');
    expect(seenIndex).toContain('Auth overhaul plan');
    expect(seenIndex).toContain('Goal: unify token refresh');
    expect(seenIndex).toContain('Documents/legacy-notes.md');
    expect(seenIndex).not.toContain('src/App.tsx');
  });

  it('does not mint a done checklist from an all-completed update_todos call with no other work', async () => {
    const thread = createChatThread('project-1', { title: 'Atlas' });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'fs_read_file') return '{"name": "spacron"}';
      if (command === 'fs_read_dir') return [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }];
    });
    routeOrchestratorRequest.mockImplementation(async (_message: string, _agents: unknown[], context: any) => {
      // The fake "5/5 done" card attempted through the new tool: the model
      // declares everything complete while executing zero real work.
      const execution = await context.toolExecutor({
        id: 'plan-2',
        name: 'update_todos',
        args: { todos: ['[x] Review auth', '[x] Fix refresh'] },
      });
      expect(execution.output).toContain('Recorded 2 todo items (2 completed)');
      context.onToolRound?.([{ id: 'plan-2', name: 'update_todos', ok: true, output: execution.output }], 1);
      return { reply: 'Everything is done!', actions: [], viaLLM: true };
    });

    await sendChatMessage('project-1', '/repo', 'wrap it up', { projectName: 'Atlas', threadId: thread.id });

    const assistantMessages = get(chatMessages)['project-1'].filter((m) => m.role === 'assistant' && m.type !== 'activity');
    expect(assistantMessages[assistantMessages.length - 1].text).not.toContain('### Plan & Tasks');
  });

  it('does not paint a fully checked-off plan when the turn executed no tools', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'fs_read_file') return '{"name": "spacron"}';
      if (command === 'fs_read_dir') return [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }];
    });
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Everything is reviewed and verified.',
      actions: [],
      viaLLM: true,
      // A FINAL-without-tools checklist: the fake "5/5 done" card from the
      // screenshot regression. The brain strips it; the store must not resurrect
      // it either.
      todos: ['Review project: active project', 'Inspect schema', 'Inspect frontend', 'Inspect docs', 'Summarize findings'],
    });

    await sendChatMessage('project-1', '/repo', 'inspect the project and suggest improvements', { projectName: 'Atlas' });

    const transcript = get(chatMessages)['project-1'];
    const final = transcript[transcript.length - 1];
    expect(final.role).toBe('assistant');
    expect(final.text).toContain('Everything is reviewed and verified.');
    // No checklist section, no evidence summary, because nothing was executed.
    expect(final.text).not.toContain('### Plan & Tasks');
    expect(final.text).not.toContain('- [x]');
    expect(final.text).not.toContain('Full detail in Work details above.');
  });

  it('spawns multiple idle agents from one message and briefs every one', async () => {
    // Distinct session ids per spawn so each agent's lease is tracked separately.
    spawnAgentPreset.mockReset();
    spawnAgentPreset.mockResolvedValueOnce(42).mockResolvedValueOnce(43);
    // Both panes report running + owned by their task, so the readiness-gated brief
    // send is allowed to proceed (leasedSessionLive stays true for each).
    getTerminalProjectState.mockImplementation(() => ({
      sessions: get(orchestratorTasks).map((t, i) => ({
        id: 42 + i,
        isRunning: true,
        ownerTaskId: t.id,
      })),
    }));
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening two agents.',
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: null, name: null },
        { kind: 'spawn', agent: 'claude', prompt: null, name: null },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open two claude agents');

    expect(spawnAgentPreset).toHaveBeenCalledTimes(2);
    // Only the primary agent takes focus; the rest spawn in the background so the
    // primary terminal stays stationary.
    expect(spawnAgentPreset).toHaveBeenNthCalledWith(1, 'claude', '/repo/isolated', { activate: true, skipAutoBrief: true });
    expect(spawnAgentPreset).toHaveBeenNthCalledWith(2, 'claude', '/repo/isolated', { activate: false, skipAutoBrief: true });

    const tasks = get(orchestratorTasks);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'in-progress')).toBe(true);
    // Each unnamed spawn is given a distinct human assistant name.
    expect(tasks[0].name).toBeTruthy();
    expect(tasks[1].name).toBeTruthy();
    expect(tasks[0].name).not.toBe(tasks[1].name);

    // Drive the readiness-gated brief sends to completion (output grows past the
    // ready threshold, then the settle + max-wait windows elapse).
    getSessionOutputBuffer.mockReturnValue('booted output................................');
    await vi.advanceTimersByTimeAsync(9300);

    // claude reads a rules file: every spawned CLI is briefed via CLAUDE.md /
    // AGENTS.md on boot, so NONE of them get the brief pasted into the REPL.
    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
  });

  it('asks where to run before spawning, and spawns nothing when dismissed', async () => {
    requestAgentPlacement.mockResolvedValue(null);

    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening Claude.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: 'refactor the auth module', name: null }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'refactor the auth module');

    expect(requestAgentPlacement).toHaveBeenCalledTimes(1);
    expect(requestAgentPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'orchestrator', agents: ['claude'] })
    );
    // Dismissing the dialog must leave no terminal and no orphaned task behind.
    expect(spawnAgentPreset).not.toHaveBeenCalled();
    expect(get(orchestratorTasks)).toHaveLength(0);
    const transcript = get(chatMessages)['project-1'];
    expect(transcript[transcript.length - 1].text).toContain('Cancelled');
  });

  it('honours a "main repo" answer over the admin-keyword heuristic', async () => {
    // The prompt has no admin keywords, so the heuristic would have isolated it —
    // the user's answer is what decides.
    answerPlacementWith('main');
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening Claude.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: 'refactor the auth module', name: null }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'refactor the auth module');

    expect(get(orchestratorTasks)[0].skipWorktree).toBe(true);
  });

  it('pre-selects the main repo for release work but still asks', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening Claude.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: 'git tag v1.2.0 and push it', name: null }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'cut the release');

    expect(requestAgentPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ suggested: 'main', suggestionReason: expect.any(String) })
    );
    // Answered 'worktree' by the default mock — the user overrules the hint.
    expect(get(orchestratorTasks)[0].skipWorktree).toBe(false);
  });

  it('asks once for a multi-agent plan, listing every agent by name', async () => {
    answerPlacementWith('main');
    spawnAgentPreset.mockReset();
    spawnAgentPreset.mockResolvedValueOnce(42).mockResolvedValueOnce(43);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening two agents.',
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Backend' },
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Frontend' },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open two claude agents');

    expect(requestAgentPlacement).toHaveBeenCalledTimes(1);
    expect(requestAgentPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ agents: ['Backend', 'Frontend'] })
    );
    expect(get(orchestratorTasks).every((t) => t.skipWorktree === true)).toBe(true);
  });

  it('places each agent independently — main repo for one, worktrees for the rest', async () => {
    answerPlacementWith('main', 'worktree', 'worktree');
    spawnAgentPreset.mockReset();
    spawnAgentPreset.mockResolvedValueOnce(42).mockResolvedValueOnce(43).mockResolvedValueOnce(44);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening three agents.',
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Release' },
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Backend' },
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Frontend' },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open three claude agents');

    const byName = Object.fromEntries(get(orchestratorTasks).map((t) => [t.name, t.skipWorktree]));
    expect(byName).toEqual({ Release: true, Backend: false, Frontend: false });
    expect(spawnAgentPreset.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['/repo', '/repo/isolated', '/repo/isolated']);
  });

  it('keeps answers aligned when a spawn is held back by a file claim', async () => {
    // The first agent claims src/a.ts; the second wants it too and is held, so it
    // never spawns. The third must still get ITS answer ('main'), not the held
    // agent's — a running counter would slide it onto the wrong one.
    answerPlacementWith('worktree', 'worktree', 'main');
    spawnAgentPreset.mockReset();
    spawnAgentPreset.mockResolvedValueOnce(42).mockResolvedValueOnce(43);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening three agents.',
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: 'edit a', name: 'First', files: ['src/a.ts'] },
        { kind: 'spawn', agent: 'claude', prompt: 'edit a too', name: 'Second', files: ['src/a.ts'] },
        { kind: 'spawn', agent: 'claude', prompt: 'ship it', name: 'Third' },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open three claude agents');

    const byName = Object.fromEntries(get(orchestratorTasks).map((t) => [t.name, t.skipWorktree]));
    expect(byName.Second).toBeUndefined();
    expect(byName).toEqual({ First: false, Third: true });
  });

  it('skips the dialog entirely when the user said where to run it', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening Claude.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: null, name: null, placement: 'main' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open claude code in the main repo');

    expect(requestAgentPlacement).not.toHaveBeenCalled();
    expect(spawnAgentPreset).toHaveBeenCalledTimes(1);
    expect(get(orchestratorTasks)[0].skipWorktree).toBe(true);
  });

  it('asks only about the agents whose placement was NOT stated', async () => {
    // "open one in a worktree and another in the main repo, plus a third" — two
    // are already decided, so the dialog must only cover the leftover.
    answerPlacementWith('main');
    spawnAgentPreset.mockReset();
    spawnAgentPreset.mockResolvedValueOnce(42).mockResolvedValueOnce(43).mockResolvedValueOnce(44);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening three agents.',
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Iso', placement: 'worktree' },
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Direct', placement: 'main' },
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Unsaid', placement: null },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open three agents');

    expect(requestAgentPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ agents: ['Unsaid'] })
    );
    const byName = Object.fromEntries(get(orchestratorTasks).map((t) => [t.name, t.skipWorktree]));
    expect(byName).toEqual({ Iso: false, Direct: true, Unsaid: true });
  });

  it('asks out loud in voice mode instead of opening a dialog nobody can click', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Launching Iris.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: null, name: 'Iris' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open a claude agent', { voiceConversation: true });

    // No modal, and nothing spawned — the question is the whole turn.
    expect(requestAgentPlacement).not.toHaveBeenCalled();
    expect(spawnAgentPreset).not.toHaveBeenCalled();
    expect(get(orchestratorTasks)).toHaveLength(0);

    const transcript = get(chatMessages)['project-1'];
    const spoken = transcript[transcript.length - 1];
    expect(spoken).toMatchObject({ role: 'assistant', pending: false });
    expect(spoken.text).toContain('Iris');
    expect(spoken.text).toContain('worktree');
    expect(spoken.text).toContain('main repo');
  });

  it('spawns straight away in voice mode once the placement was spoken', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Starting Iris in an isolated worktree.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: null, name: 'Iris', placement: 'worktree' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open a claude agent in a worktree', {
      voiceConversation: true,
    });

    expect(requestAgentPlacement).not.toHaveBeenCalled();
    expect(spawnAgentPreset).toHaveBeenCalledTimes(1);
    expect(get(orchestratorTasks)[0].skipWorktree).toBe(false);
  });

  it('holds nothing in state when it asks for a placement in voice mode', async () => {
    // The confirmation gate that once lived here was removed as unfixable: on
    // the realtime path the user's literal "yes" never arrives, so held actions
    // could never be released. This question must NOT reintroduce that — it
    // stores nothing, and the next turn re-plans from scratch.
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Launching Iris.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: null, name: 'Iris' }],
      viaLLM: true,
    });
    await sendChatMessage('project-1', '/repo', 'open a claude agent', { voiceConversation: true });
    expect(spawnAgentPreset).not.toHaveBeenCalled();

    // A follow-up carrying the placement spawns on its own, with no reference to
    // the previous turn — nothing was queued waiting for an affirmation.
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Starting Iris in an isolated worktree.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: null, name: 'Iris', placement: 'worktree' }],
      viaLLM: true,
    });
    await sendChatMessage('project-1', '/repo', 'worktree', { voiceConversation: true });

    expect(spawnAgentPreset).toHaveBeenCalledTimes(1);
    expect(get(orchestratorTasks)).toHaveLength(1);
    expect(get(orchestratorTasks)[0].skipWorktree).toBe(false);
  });

  it('names the count, not every agent, when several placements are unstated in voice mode', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening two agents.',
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Iris' },
        { kind: 'spawn', agent: 'claude', prompt: null, name: 'Nova' },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open two claude agents', { voiceConversation: true });

    expect(spawnAgentPreset).not.toHaveBeenCalled();
    const transcript = get(chatMessages)['project-1'];
    expect(transcript[transcript.length - 1].text).toContain('2 agents');
  });

  it('spawns a named agent persistent (no auto-send)', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Opening Backend.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: null, name: 'Backend' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'open a claude agent called Backend');

    expect(spawnAgentPreset).toHaveBeenCalledWith('claude', '/repo/isolated', { activate: true, skipAutoBrief: true });
    const task = get(orchestratorTasks)[0];
    expect(task.name).toBe('Backend');
    expect(task.status).toBe('in-progress');
  });

  it('executes voice-mode spawns on the same turn, with no confirmation hold', async () => {
    // `placement` is stated so this test isolates the property it was written
    // for — no PERMISSION hold ("want me to go ahead?"). An unstated placement
    // is a missing required input, not a permission request, and is asked for
    // separately (see the voice tests above).
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Handing this to Claude.',
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: 'refactor the auth module', name: null, placement: 'worktree' },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'refactor the auth module', {
      voiceConversation: true,
    });

    expect(routeOrchestratorRequest).toHaveBeenCalledTimes(1);
    expect(spawnAgentPreset).toHaveBeenCalledWith('claude', '/repo/isolated', { activate: true, skipAutoBrief: true });
    expect(get(orchestratorTasks)).toHaveLength(1);
  });

  it('rewrites a permission-question reply into a declarative one when actions execute', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: "I'll launch Claude to refactor the auth module, want me to go ahead?",
      actions: [
        { kind: 'spawn', agent: 'claude', prompt: 'refactor the auth module', name: null, placement: 'worktree' },
      ],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'refactor the auth module', {
      voiceConversation: true,
    });

    // The spawn ran immediately, so the user must never hear "want me to?".
    expect(spawnAgentPreset).toHaveBeenCalledTimes(1);
    const transcript = get(chatMessages)['project-1'];
    const assistant = transcript.filter((m) => m.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    for (const m of assistant) {
      expect(m.text.toLowerCase()).not.toContain('want me to go ahead');
    }
    expect(assistant.some((m) => m.text.toLowerCase().includes('launching'))).toBe(true);
  });

  it('leaves a genuine clarifying question (empty actions) untouched in voice mode', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Which module do you want me to refactor?',
      actions: [],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'refactor it', { voiceConversation: true });

    expect(spawnAgentPreset).not.toHaveBeenCalled();
    const transcript = get(chatMessages)['project-1'];
    expect(transcript[transcript.length - 1]).toMatchObject({
      role: 'assistant',
      text: 'Which module do you want me to refactor?',
      pending: false,
    });
  });

  it('does NOT gate spawns outside voice mode (typed dispatch stays immediate)', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Handing this to Claude.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: 'refactor the auth module', name: null }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'refactor the auth module');

    expect(spawnAgentPreset).toHaveBeenCalledTimes(1);
    expect(get(orchestratorTasks)).toHaveLength(1);
  });

it('keeps the assistant offer in the next turn context', async () => {
    const thread = createChatThread('project-1', { provider: 'deepseek' });
    appendLegacyChatMessage('project-1', { id: 'offer', role: 'assistant', text: 'I can map the actual implementation against the docs.', ts: 1 }, thread.id);
    routeOrchestratorRequest.mockResolvedValue({ reply: 'The implemented features are...', actions: [], viaLLM: true });
    await sendChatMessage('project-1', '/repo', 'do that please', { threadId: thread.id, conversationalMode: true });
    expect(routeOrchestratorRequest.mock.calls[0][2].conversation).toContainEqual({ role: 'assistant', text: 'I can map the actual implementation against the docs.' });
  });

  it('does not rewrite the thread title when the first message is edited and resent', async () => {
    const thread = createChatThread('project-1', { title: 'Review auth flow' });
    appendLegacyChatMessage('project-1', { id: 'u1', role: 'user', text: 'Review the authentication flow', ts: 1 }, thread.id);
    appendLegacyChatMessage('project-1', { id: 'a1', role: 'assistant', text: 'Done.', ts: 2 }, thread.id);
    routeOrchestratorRequest.mockResolvedValue({ reply: 'Redone with SSO.', actions: [], viaLLM: true });

    await sendChatMessage('project-1', '/repo', 'Review the auth flow with SSO', {
      threadId: thread.id,
      conversationalMode: true,
      resendFromMessageId: 'u1',
    });

    expect(get(chatThreadState).threadsByProject['project-1'][0].title).toBe('Review auth flow');
    const texts = get(chatThreadState).messagesByThread[thread.id].map((m) => m.text);
    expect(texts).toEqual(['Review the auth flow with SSO', 'Redone with SSO.']);
  });

  it('does not finalize a repeated promise as success', async () => {
    const thread = createChatThread('project-1', { provider: 'deepseek' });
    invoke.mockImplementation(async (command) => command === 'fs_read_dir' ? [{ name: 'package.json', type: 'file' }] : '{}');
    routeOrchestratorRequest.mockResolvedValue({ reply: 'I will inspect the project files.', actions: [], viaLLM: true });
    await sendChatMessage('project-1', '/repo', 'do that please', { threadId: thread.id, conversationalMode: true });
    expect(routeOrchestratorRequest).toHaveBeenCalledTimes(2);
    expect(get(chatThreadState).threadsByProject['project-1'][0].status).toBe('failed');
    expect(get(chatThreadState).messagesByThread[thread.id].at(-1)?.text).toContain('could not complete');
  });

  it('preserves explicit question options even when phrased as Would you like', async () => {
    const thread = createChatThread('project-1', { provider: 'deepseek' });
    routeOrchestratorRequest.mockResolvedValue({ reply: 'Would you like to use PostgreSQL or SQLite?', actions: [], needsInput: true, inputRequest: { question: 'Would you like to use PostgreSQL or SQLite?', options: ['PostgreSQL', 'SQLite'] }, viaLLM: true });
    await sendChatMessage('project-1', '/repo', 'Configure storage', { threadId: thread.id, conversationalMode: true });
    const request = get(chatThreadState).messagesByThread[thread.id].at(-1)?.inlineRequest;
    expect(request).toMatchObject({ type: 'choice', options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }] });
    expect(routeOrchestratorRequest).toHaveBeenCalledTimes(1);
  });

  it('shows a CLI question, sends its exact answer to the same session, and watches the next question and completion', async () => {
    const seed = createOrchestratorTask('project-1', 'Build storage', 'claude', 'Backend');
    const thread = createChatThread('project-1', { provider: 'deepseek', taskId: seed.id, sessionId: 42 });
    orchestratorTasks.set([{ ...seed, status: 'in-progress', assignedSessionId: 42 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });
    await sendChatMessage('project-1', '/repo', 'Check the storage setup', { threadId: thread.id, chatMode: true });
    expect(deliverTurnSignal(42, { kind: 'blocked', reason: '\u001b[31mWhich database?\u001b[0m\n1. PostgreSQL\n2. SQLite' })).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const question = get(chatThreadState).messagesByThread[thread.id].at(-1)!;
    expect(question.inlineRequest).toMatchObject({ taskId: seed.id, sessionId: 42, type: 'choice', options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }] });
    expect(question.inlineRequest?.prompt).not.toContain('\u001b');
    expect(get(orchestratorTasks)[0].status).toBe('blocked');
    // The next question can arrive during delivery, before its promise resolves.
    sendAgentPromptDirect.mockImplementationOnce(async () => {
      expect(deliverTurnSignal(42, { kind: 'blocked', reason: 'What should the database be named?' })).toBe(true);
      return true;
    });
    await sendChatMessage('project-1', '/repo', 'PostgreSQL', { threadId: thread.id, chatMode: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(sendAgentPromptDirect).toHaveBeenLastCalledWith(42, 'PostgreSQL');
    expect(get(chatThreadState).messagesByThread[thread.id].find((m) => m.id === question.id)?.inlineRequest?.answer).toBe('PostgreSQL');
    expect(get(orchestratorTasks)[0].status).toBe('blocked');
    expect(get(chatThreadState).threadsByProject['project-1'][0].status).toBe('needs-input');
    await sendChatMessage('project-1', '/repo', 'app_db', { threadId: thread.id, chatMode: true });
    expect(deliverTurnSignal(42, { kind: 'finished', detail: 'Storage configured and tests passed.' })).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(get(orchestratorTasks)[0].status).toBe('complete');
    expect(get(chatThreadState).threadsByProject['project-1'][0].status).toBe('complete');
    expect(get(chatThreadState).messagesByThread[thread.id].some((m) => m.completion?.reason === 'Storage configured and tests passed.')).toBe(true);
    expect(spawnAgentPreset).not.toHaveBeenCalled();
  });

  it('retains an unanswered CLI request if delivery fails', async () => {
    const seed = createOrchestratorTask('project-1', 'Build storage', 'claude', 'Backend');
    const thread = createChatThread('project-1', { provider: 'deepseek', taskId: seed.id, sessionId: 42 });
    orchestratorTasks.set([{ ...seed, status: 'blocked', assignedSessionId: 42, blockedReason: 'Which database?' }]);
    appendLegacyChatMessage('project-1', { id: 'input', role: 'assistant', text: '', ts: 1, inlineRequest: { id: 'request', type: 'text', prompt: 'Which database?', taskId: seed.id, sessionId: 42 } }, thread.id);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });
    sendAgentPromptDirect.mockResolvedValue(false);
    await sendChatMessage('project-1', '/repo', 'PostgreSQL', { threadId: thread.id, chatMode: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(get(chatThreadState).messagesByThread[thread.id].find((m) => m.id === 'input')?.inlineRequest?.answeredAt).toBeFalsy();
    expect(get(orchestratorTasks)[0].status).toBe('blocked');
    expect(get(chatThreadState).threadsByProject['project-1'][0].status).toBe('needs-input');
  });

  it('gates direct writes until approval and records tool activity', async () => {
    const thread = createChatThread('project-1', { provider: 'deepseek' });
    routeOrchestratorRequest.mockImplementation(async (_text, _agents, context) => {
      await context.toolExecutor({ id: 'write', name: 'write_file', args: { path: 'report.md', content: 'Verified report' } });
      return { reply: 'The report was written.', actions: [], viaLLM: true };
    });
    const pending = sendChatMessage('project-1', '/repo', 'Write a report', { threadId: thread.id, conversationalMode: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).not.toHaveBeenCalledWith('fs_write_file_checked', expect.anything());
    expect(get(chatThreadState).messagesByThread[thread.id].at(-1)?.inlineRequest?.type).toBe('approval');
    await sendChatMessage('project-1', '/repo', 'Approve', { threadId: thread.id, conversationalMode: true });
    await pending;
    expect(invoke).toHaveBeenCalledWith('fs_write_file_checked', { path: '/repo/report.md', content: 'Verified report', expectedContent: undefined });
    expect(get(chatThreadState).messagesByThread[thread.id].some((m) => m.type === 'activity' && m.text.includes('Wrote report.md'))).toBe(true);
  });

  it('keeps optional conversational follow-ups out of the needs-input gate', async () => {
    resetChatThreadsForTests();
    const thread = createChatThread('project-1', {
      title: 'Chat thread',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
    }, 100);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'The project is configured and ready. Would you like more detail?',
      actions: [],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'Is everything ready?', {
      threadId: thread.id,
      conversationalMode: true,
      chatMode: true,
    });

    const message = get(chatThreadState).messagesByThread[thread.id]?.at(-1);
    expect(message).toMatchObject({
      type: 'agent',
      text: 'The project is configured and ready. Would you like more detail?',
      pending: false,
    });
    expect(message?.inlineRequest).toBeNull();
  });

  it('shows a needs-input card for a genuinely blocking question', async () => {
    resetChatThreadsForTests();
    const thread = createChatThread('project-1', {
      title: 'Chat thread',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
    }, 100);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Which module should I refactor before I continue?',
      needsInput: true,
      actions: [],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'Refactor it', {
      threadId: thread.id,
      conversationalMode: true,
      chatMode: true,
    });

    const message = get(chatThreadState).messagesByThread[thread.id]?.at(-1);
    expect(message).toMatchObject({
      type: 'input',
      text: 'Which module should I refactor before I continue?',
      pending: false,
      inlineRequest: { prompt: 'Which module should I refactor before I continue?' },
    });
  });

  it('keeps provider connection errors as informational replies, not input cards', async () => {
    resetChatThreadsForTests();
    const thread = createChatThread('project-1', {
      title: 'Chat thread',
      provider: 'openai',
      model: 'gpt-5.4-mini',
    }, 100);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'I cannot complete this review yet. Composer is set to OpenAI API (gpt-5.4-mini), but that provider connection is not available to the orchestrator. Add the OpenAI API key in Settings, or choose a connected provider in Composer, then retry.',
      actions: [],
      viaLLM: false,
    });

    await sendChatMessage('project-1', '/repo', 'go through the application and suggest improvements', {
      threadId: thread.id,
      conversationalMode: true,
      chatMode: true,
    });

    const message = get(chatThreadState).messagesByThread[thread.id]?.at(-1);
    expect(message?.type).not.toBe('input');
    expect(message?.pending).toBe(false);
    expect(message?.inlineRequest).toBeNull();
    expect(get(chatThreadState).threadsByProject['project-1'][0].status).not.toBe('needs-input');
  });

  it('asks for placement before a routine Chat dispatch', async () => {
    resetChatThreadsForTests();
    const thread = createChatThread('project-1', {
      title: 'Chat thread',
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
    }, 100);
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Launching Claude to fix the bug.',
      actions: [{ kind: 'spawn', agent: 'claude', prompt: 'fix the bug', name: null }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'Fix the bug', {
      threadId: thread.id,
      conversationalMode: true,
      chatMode: true,
    });

    expect(requestAgentPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'orchestrator', agents: ['claude'] })
    );
    expect(spawnAgentPreset).toHaveBeenCalledTimes(1);
    expect(get(orchestratorTasks)[0]?.skipWorktree).toBe(false);
  });

  it('sends a follow-up to a running named agent without spawning a new one once the lease is ready', async () => {
    const seed = createOrchestratorTask('project-1', 'Original goal', 'claude', 'Backend');
    orchestratorTasks.set([{ ...seed, status: 'in-progress', assignedSessionId: 42, startedAt: 1 }]);
    // The follow-up must wait for agent readiness before it is delivered.
    waitForAgentReady.mockImplementationOnce(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });
    spawnAgentPreset.mockClear();
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Sent to Backend.',
      actions: [{ kind: 'send', target: 'Backend', prompt: 'run the tests' }],
      viaLLM: true,
    });

    const sendPromise = sendChatMessage('project-1', '/repo', 'Backend, run the tests');
    await vi.advanceTimersByTimeAsync(150);
    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    await sendPromise;

    expect(sendAgentPromptDirect).toHaveBeenCalledWith(42, 'run the tests');
    expect(spawnAgentPreset).not.toHaveBeenCalled();
    expect(get(orchestratorTasks)).toHaveLength(1);
  });

  it('routes a follow-up from a legacy agent-session thread directly to its live task', async () => {
    resetChatThreadsForTests();
    const seed = createOrchestratorTask('project-1', 'Original goal', 'claude', 'Backend');
    const thread = createChatThread('project-1', {
      title: 'Backend thread',
      agentName: 'Backend',
      agentPreset: 'claude',
      provider: 'claude',
      taskId: seed.id,
      sessionId: 42,
    }, 100);
    orchestratorTasks.set([{ ...seed, status: 'in-progress', assignedSessionId: 42, startedAt: 1 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });
    routeOrchestratorRequest.mockClear();

    await sendChatMessage('project-1', '/repo', 'Please run the tests again', { threadId: thread.id, chatMode: true });

    expect(routeOrchestratorRequest).not.toHaveBeenCalled();
    expect(spawnAgentPreset).not.toHaveBeenCalled();
    expect(sendAgentPromptDirect).toHaveBeenCalledWith(42, 'Please run the tests again');
    const state = get(chatThreadState);
    const messages = state.messagesByThread[thread.id];
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'Please run the tests again' });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      pending: false,
      text: 'Sent to Backend.',
      dispatchedTaskId: seed.id,
      dispatched: [{ taskId: seed.id, agent: 'claude', name: 'Backend', via: 'send' }],
    });
  });

  it('routes an orchestrator conversation through its composer provider instead of sending to the last task', async () => {
    resetChatThreadsForTests();
    const seed = createOrchestratorTask('project-1', 'Original goal', 'claude', 'Backend');
    const thread = createChatThread('project-1', {
      title: 'Orchestrator thread',
      provider: 'deepseek',
      model: 'deepseek-chat',
      taskId: seed.id,
      sessionId: 42,
    }, 100);
    orchestratorTasks.set([{ ...seed, status: 'in-progress', assignedSessionId: 42, startedAt: 1 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });
    routeOrchestratorRequest.mockResolvedValueOnce({ reply: 'I will coordinate that.', actions: [], viaLLM: true });
    routeOrchestratorRequest.mockClear();
    sendAgentPromptDirect.mockClear();

    await sendChatMessage('project-1', '/repo', 'Please run the tests again', {
      threadId: thread.id,
      orchestratorProvider: 'deepseek',
      orchestratorModel: 'deepseek-chat',
      accessMode: 'full-access',
      chatMode: false,
    });

    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(routeOrchestratorRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        recentUserMessages: [],
        llmConfig: expect.objectContaining({ provider: 'deepseek', model: 'deepseek-chat' }),
      }),
    );
    expect(get(chatThreadState).messagesByThread[thread.id]).toHaveLength(2);
  });

  it('resolves the Composer provider from the keychain before routing', async () => {
    invoke.mockImplementation(async (command: string, args?: { provider?: string }) => {
      if (command === 'provider_api_key_exists' && args?.provider === 'deepseek') return true;
      if (command === 'ai_complete') return '[]';
      return undefined;
    });
    const thread = createChatThread('project-1', {
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    routeOrchestratorRequest.mockResolvedValue({ reply: 'Reviewed from the selected model.', actions: [], viaLLM: true });

    await sendChatMessage('project-1', '/repo', 'Review the application and suggest improvements', {
      threadId: thread.id,
      orchestratorProvider: 'deepseek',
      orchestratorModel: 'deepseek-chat',
      chatMode: true,
      conversationalMode: true,
    });

    expect(invoke).toHaveBeenCalledWith('provider_api_key_exists', { provider: 'deepseek' });
    expect(routeOrchestratorRequest.mock.calls[0][2].llmConfig).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      hasApiKey: true,
    });
  });

  it('resumes a blocked task directly and sends the reply automatically', async () => {
    const seed = createOrchestratorTask('project-1', 'Finish the migration', 'claude', 'Backend');
    orchestratorTasks.set([
      {
        ...seed,
        status: 'blocked',
        assignedSessionId: null,
        blockedReason: 'Need the API key before continuing.',
        startedAt: 1,
        completedAt: 2,
        activity: [makeActivityEvent('blocked', 'Need the API key before continuing.', 2)],
      },
    ]);
    // The relaunched CLI must be ready before the resume prompt is delivered.
    waitForAgentReady.mockImplementationOnce(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 77, isRunning: true, ownerTaskId: seed.id }] });
    spawnAgentPreset.mockResolvedValueOnce(77);

    const resumePromise = resumeBlockedOrchestratorTask(seed.id, 'API key is set. Please continue.', '/repo');
    await vi.advanceTimersByTimeAsync(150);
    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    await resumePromise;

    expect(spawnAgentPreset).toHaveBeenCalledWith('claude', '/repo', { activate: true, skipAutoBrief: true });
    // Resuming a blocked task spawns a fresh CLI; claude re-reads its rules file on
    // boot, so only the resume prompt is sent (no charter wrap).
    expect(sendAgentPromptDirect).toHaveBeenCalledWith(
      77,
      buildAgentTaskMessage('API key is set. Please continue.', { name: 'Backend' })
    );
    const task = get(orchestratorTasks)[0];
    expect(task.status).toBe('in-progress');
    expect(task.assignedSessionId).toBe(77);
    expect(task.blockedReason).toBeNull();
    expect(task.promptSentAt).toBeTypeOf('number');
  });

  it('classifies a non-zero leased process exit as failed instead of finished', async () => {
    vi.resetModules();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = {};
    // Re-importing the module graph re-runs settings.ts, which only touches
    // localStorage once window is defined — give it a no-op store so it doesn't
    // ReferenceError in the node env.
    g.localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    sessionExitListeners.length = 0;
    const mod = await import('./orchestrator');
    const task = mod.createOrchestratorTask('project-1', 'Handle failing exits', 'claude');
    mod.orchestratorTasks.set([{ ...task, status: 'in-progress', assignedSessionId: 42, startedAt: 1, promptSentAt: 2 }]);

    // A natural (non-deliberate) exit leaves the session in project state flagged
    // isRunning:false — the reconciler only completes when the session is still
    // present (a deliberate close removes it first).
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: false, ownerTaskId: task.id, lastExitCode: 17 }] });

    expect(sessionExitListeners).toHaveLength(1);
    sessionExitListeners[0]({ sessionId: 42, projectId: 'project-1', code: 17 });

    const updated = get(mod.orchestratorTasks)[0];
    expect(updated.status).toBe('failed');
    expect(updated.failureReason).toContain('17');
    expect(updated.assignedSessionId).toBeNull();

    if (previousWindow === undefined) delete g.window;
    else g.window = previousWindow;
    if (previousLocalStorage === undefined) delete g.localStorage;
    else g.localStorage = previousLocalStorage;
  });

  it('writes a completion card to the chat log when a leased process exits', async () => {
    // The completion card is the durable record that feeds the agent inbox, so it
    // must be written on process exit too — `notify: false` suppresses only the
    // orchestrator's own toast/chime (the terminal layer already raised its exit
    // notification), never the card.
    vi.resetModules();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = {};
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    sessionExitListeners.length = 0;
    showToast.mockClear();
    const mod = await import('./orchestrator');
    const task = mod.createOrchestratorTask('project-1', 'Exit with results', 'claude');
    mod.orchestratorTasks.set([{ ...task, status: 'in-progress', assignedSessionId: 42, startedAt: 1, promptSentAt: 2 }]);

    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: false, ownerTaskId: task.id, lastExitCode: 0 }] });

    expect(sessionExitListeners).toHaveLength(1);
    sessionExitListeners[0]({ sessionId: 42, projectId: 'project-1', code: 0 });

    const updated = get(mod.orchestratorTasks)[0];
    expect(updated.status).toBe('complete');

    const chat = get(mod.chatMessages)['project-1'] ?? [];
    const card = chat.find((m) => !!m.completion);
    expect(card).toBeDefined();
    expect(card?.completion).toMatchObject({ status: 'done', agentName: 'claude', taskTitle: 'Exit with results' });

    // notify: false → no orchestrator "finished" toast (the terminal layer's own
    // exit notification covers the "right now" cue).
    await Promise.resolve(); // let any void async chains settle before asserting
    expect(showToast).not.toHaveBeenCalled();

    if (previousWindow === undefined) delete g.window;
    else g.window = previousWindow;
    if (previousLocalStorage === undefined) delete g.localStorage;
    else g.localStorage = previousLocalStorage;
  });

  it('writes a failed completion card when a leased process crashes', async () => {
    // Same contract on the non-zero exit path: the card must land with a failed
    // status so it shows up as actionable in the inbox, toast still suppressed.
    vi.resetModules();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = {};
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    sessionExitListeners.length = 0;
    showToast.mockClear();
    const mod = await import('./orchestrator');
    const task = mod.createOrchestratorTask('project-1', 'Crash loudly', 'claude');
    mod.orchestratorTasks.set([{ ...task, status: 'in-progress', assignedSessionId: 42, startedAt: 1, promptSentAt: 2 }]);

    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: false, ownerTaskId: task.id, lastExitCode: 17 }] });
    sessionExitListeners[0]({ sessionId: 42, projectId: 'project-1', code: 17 });

    const updated = get(mod.orchestratorTasks)[0];
    expect(updated.status).toBe('failed');

    const chat = get(mod.chatMessages)['project-1'] ?? [];
    const card = chat.find((m) => !!m.completion);
    expect(card).toBeDefined();
    expect(card?.completion).toMatchObject({ status: 'failed', agentName: 'claude' });

    await Promise.resolve();
    expect(showToast).not.toHaveBeenCalled();

    if (previousWindow === undefined) delete g.window;
    else g.window = previousWindow;
    if (previousLocalStorage === undefined) delete g.localStorage;
    else g.localStorage = previousLocalStorage;
  });

  it('ignores a session-exit for a deliberately closed session (no session in state)', async () => {
    vi.resetModules();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = {};
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    sessionExitListeners.length = 0;
    const mod = await import('./orchestrator');
    const task = mod.createOrchestratorTask('project-1', 'Closed deliberately', 'claude');
    mod.orchestratorTasks.set([{ ...task, status: 'in-progress', assignedSessionId: 42, startedAt: 1, promptSentAt: 2 }]);

    // killSession removes the session from project state before the async pty exit
    // fires, so the reconciler must treat this exit as an intentional close and
    // leave the (already in-progress) task untouched rather than marking it done.
    getTerminalProjectState.mockReturnValue({ sessions: [] });

    expect(sessionExitListeners).toHaveLength(1);
    sessionExitListeners[0]({ sessionId: 42, projectId: 'project-1', code: 0 });

    const updated = get(mod.orchestratorTasks)[0];
    expect(updated.status).toBe('in-progress');
    expect(updated.assignedSessionId).toBe(42);

    if (previousWindow === undefined) delete g.window;
    else g.window = previousWindow;
    if (previousLocalStorage === undefined) delete g.localStorage;
    else g.localStorage = previousLocalStorage;
  });


  it('adopts an agent the user launched by hand into a running task', async () => {
    vi.resetModules();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = {};
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    sessionExitListeners.length = 0;
    agentDetectedListeners.length = 0;
    const mod = await import('./orchestrator');
    mod.orchestratorTasks.set([]);

    // A typed `claude` launch: the session is live, unleased (no ownerTaskId),
    // and has no task tracking it yet.
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 77, isRunning: true, ownerTaskId: null, agentName: null }] });

    expect(agentDetectedListeners).toHaveLength(1);
    agentDetectedListeners[0]({ sessionId: 77, projectId: 'project-1', preset: 'claude' });

    const adopted = get(mod.orchestratorTasks);
    expect(adopted).toHaveLength(1);
    expect(adopted[0].adopted).toBe(true);
    expect(adopted[0].status).toBe('in-progress');
    expect(adopted[0].assignedSessionId).toBe(77);
    expect(adopted[0].agentPreset).toBe('claude');

    // Idempotent — a second detection for the same live session is a no-op.
    agentDetectedListeners[0]({ sessionId: 77, projectId: 'project-1', preset: 'claude' });
    expect(get(mod.orchestratorTasks)).toHaveLength(1);

    if (previousWindow === undefined) delete g.window;
    else g.window = previousWindow;
    if (previousLocalStorage === undefined) delete g.localStorage;
    else g.localStorage = previousLocalStorage;
  });

  it('completes an adopted agent on exit while dropping a lightweight inbox card', async () => {
    vi.resetModules();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = {};
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    sessionExitListeners.length = 0;
    agentDetectedListeners.length = 0;
    const mod = await import('./orchestrator');
    const task = mod.createOrchestratorTask('project-1', '', 'claude');
    mod.orchestratorTasks.set([{ ...task, status: 'in-progress', assignedSessionId: 88, adopted: true, startedAt: 1 }]);

    // Natural exit: the session is still present (flagged isRunning:false).
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 88, isRunning: false, ownerTaskId: null, agentName: null }] });

    expect(sessionExitListeners).toHaveLength(1);
    sessionExitListeners[0]({ sessionId: 88, projectId: 'project-1', code: 0 });

    const updated = get(mod.orchestratorTasks)[0];
    expect(updated.status).toBe('complete');
    expect(updated.assignedSessionId).toBeNull();
    // The exit still lands a lightweight card (no AI summary) so the last turn
    // isn't lost to a transient toast.
    const chat = get(mod.chatMessages)['project-1'] ?? [];
    const card = chat.find((m) => !!m.completion);
    expect(card).toBeDefined();
    expect(card?.completion).toMatchObject({ status: 'done', agentName: 'claude' });
    expect(card?.completion?.summaryPending).toBe(false);
    expect(card?.completion?.summary).toBeNull();

    if (previousWindow === undefined) delete g.window;
    else g.window = previousWindow;
    if (previousLocalStorage === undefined) delete g.localStorage;
    else g.localStorage = previousLocalStorage;
  });

  it('drops a lightweight inbox card when an adopted agent finishes a turn', async () => {
    // Adoption arms the re-arming turn watcher; when a real turn ends it must
    // append a lightweight completion card (the inbox source) while the task
    // stays in-progress — the user is still driving that terminal.
    vi.resetModules();
    const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = {};
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    sessionExitListeners.length = 0;
    agentDetectedListeners.length = 0;
    const mod = await import('./orchestrator');
    mod.orchestratorTasks.set([]);

    // A typed `claude` launch: live, unleased, no task tracking it yet.
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 77, isRunning: true, ownerTaskId: null, agentName: null }] });
    agentDetectedListeners[0]({ sessionId: 77, projectId: 'project-1', preset: 'claude' });

    const adopted = get(mod.orchestratorTasks)[0];
    expect(adopted.adopted).toBe(true);
    expect(adopted.assignedSessionId).toBe(77);

    // leasedSessionLive needs the session to stay running for this task.
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 77, isRunning: true, ownerTaskId: adopted.id }] });

    // A real turn: ≥500 chars of new output (the watcher's minWorkChars gate)…
    getSessionOutputBuffer.mockReturnValue('x'.repeat(600));
    await vi.advanceTimersByTimeAsync(500); // a poll sees the growth
    // …then the output goes quiet; the 90s idle fallback ends the turn.
    await vi.advanceTimersByTimeAsync(91000);
    await Promise.resolve();

    const chat = get(mod.chatMessages)['project-1'] ?? [];
    const cards = chat.filter((m) => !!m.completion);
    expect(cards).toHaveLength(1); // exactly one card per turn — no double-write
    const card = cards[0];
    expect(card.completion).toMatchObject({ status: 'done', agentName: adopted.name ?? 'claude' });
    expect(card.completion?.summaryPending).toBe(false);
    expect(card.completion?.summary).toBeNull();
    // The task stays in-progress — the watcher re-arms because the user is still
    // working in that terminal.
    expect(get(mod.orchestratorTasks)[0].status).toBe('in-progress');

    if (previousWindow === undefined) delete g.window;
    else g.window = previousWindow;
    if (previousLocalStorage === undefined) delete g.localStorage;
    else g.localStorage = previousLocalStorage;
  });

  it('executes app-control actions: navigate, open-file, preview, run, and task', async () => {
    addTask('project-1', 'Wire up auth', 'todo');
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'On it.',
      actions: [
        { kind: 'navigate', view: 'editor' },
        { kind: 'open-file', path: 'src/lib/router.ts', line: 42 },
        { kind: 'preview', url: '/login' },
        { kind: 'run', command: 'npm test' },
        { kind: 'task', op: 'doing', title: 'Wire up auth' },
      ],
      viaLLM: true,
    });
    // A plain shell to run the command in.
    getTerminalProjectState.mockReturnValue({
      sessions: [{ id: 7, isRunning: true, ownerTaskId: null, agentPreset: null, isExecuting: false }],
    });

    await sendChatMessage('project-1', '/repo', 'open the router, preview login, run tests, start the auth task');

    expect(setActiveView).toHaveBeenCalledWith('editor');
    expect(openFile).toHaveBeenCalledWith('/repo/src/lib/router.ts');
    expect(jumpToLine.set).toHaveBeenCalledWith({ path: '/repo/src/lib/router.ts', line: 42 });
    expect(navigatePreviewTab).toHaveBeenCalledWith('/login');
    expect(sendPromptToSession).toHaveBeenCalledWith(7, 'npm test');
    const moved = get(tasks).find((t) => t.projectId === 'project-1' && t.title === 'Wire up auth');
    expect(moved?.status).toBe('doing');
  });

  it('adopts a live spawned terminal agent just in time when sending by name', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'I will ask Opal.',
      actions: [{ kind: 'send', target: 'Opal', prompt: 'tell me about the project' }],
      viaLLM: true,
    });
    getTerminalProjectState.mockReturnValue({
      sessions: [
        {
          id: 51,
          isRunning: true,
          ownerTaskId: null,
          agentName: 'Opal',
          agentPreset: 'codex',
          isExecuting: false,
        },
      ],
    });

    await sendChatMessage('project-1', '/repo', 'ask Opal to tell me about the project');

    expect(sendAgentPromptDirect).toHaveBeenCalledWith(51, 'tell me about the project');
    expect(showToast).not.toHaveBeenCalledWith('No running agent named "Opal"', 'warning', 4000);
    const adopted = get(orchestratorTasks).find((t) => t.assignedSessionId === 51);
    expect(adopted?.adopted).toBe(true);
    expect(adopted?.name).toBe('Opal');
    expect(adopted?.agentPreset).toBe('codex');
  });

  it('runs a command in a fresh terminal instead of clobbering a dev-server pane', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Running tests.',
      actions: [{ kind: 'run', command: 'npm test' }],
      viaLLM: true,
    });
    // The only live shell is running a dev server (role 'Server'); it must not be reused.
    getTerminalProjectState.mockReturnValue({
      sessions: [{ id: 5, isRunning: true, ownerTaskId: null, agentPreset: null, isExecuting: false, role: 'Server' }],
    });
    createTerminalSession.mockResolvedValue(88);

    await sendChatMessage('project-1', '/repo', 'run the tests');

    expect(createTerminalSession).toHaveBeenCalled();
    expect(sendPromptToSession).toHaveBeenCalledWith(88, 'npm test');
    expect(sendPromptToSession).not.toHaveBeenCalledWith(5, 'npm test');
  });

  it('warns when no running agent matches a send target', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Hmm.',
      actions: [{ kind: 'send', target: 'Ghost', prompt: 'do something' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'Ghost, do something');

    expect(sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('No running agent named "Ghost"', 'warning', 4000);
  });

  it('names a running agent via a name action', async () => {
    const seed = createOrchestratorTask('project-1', 'Some goal', 'claude');
    orchestratorTasks.set([{ ...seed, status: 'in-progress', assignedSessionId: 42, startedAt: 1 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Named it Frontend.',
      actions: [{ kind: 'name', target: 'last', name: 'Frontend' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'call that one Frontend');

    expect(get(orchestratorTasks)[0].name).toBe('Frontend');
    // The name is reflected on the leased terminal pane (as its badge).
    expect(setSessionAgentName).toHaveBeenCalledWith(42, 'Frontend');
  });

  it('closes a running agent via a close action — kills the terminal and cancels the task', async () => {
    const seed = createOrchestratorTask('project-1', 'Some goal', 'claude', 'Iris');
    orchestratorTasks.set([{ ...seed, status: 'in-progress', assignedSessionId: 42, startedAt: 1 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Closing Iris.',
      actions: [{ kind: 'close', target: 'Iris' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'close iris');

    expect(killSession).toHaveBeenCalledWith(42);
    const task = get(orchestratorTasks)[0];
    expect(task.status).toBe('cancelled');
    expect(task.assignedSessionId).toBeNull();
  });

  it('warns when no running agent matches a close target', async () => {
    routeOrchestratorRequest.mockResolvedValue({
      reply: 'Hmm.',
      actions: [{ kind: 'close', target: 'Ghost' }],
      viaLLM: true,
    });

    await sendChatMessage('project-1', '/repo', 'close ghost');

    expect(killSession).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('No running agent named "Ghost"', 'warning', 4000);
  });

  it('renames an agent directly and reflects it on the terminal pane', () => {
    const seed = createOrchestratorTask('project-1', 'Some goal', 'claude', 'Backend');
    orchestratorTasks.set([{ ...seed, status: 'in-progress', assignedSessionId: 42 }]);
    getTerminalProjectState.mockReturnValue({ sessions: [{ id: 42, isRunning: true, ownerTaskId: seed.id }] });

    renameOrchestratorAgent(seed.id, '  API  ');

    expect(get(orchestratorTasks)[0].name).toBe('API');
    expect(setSessionAgentName).toHaveBeenCalledWith(42, 'API');
    // The tab label (role) reflects the name too.
    expect(setSessionRole).toHaveBeenCalledWith(42, 'API');

    renameOrchestratorAgent(seed.id, '   ');
    expect(get(orchestratorTasks)[0].name).toBeNull();
    // Clearing the name removes the badge and resets the tab to the default role.
    expect(setSessionAgentName).toHaveBeenCalledWith(42, null);
    expect(setSessionRole).toHaveBeenCalledWith(42, 'Agent');
  });
});

describe('trackedWorktrees', () => {
  const wt = (path: string, branch: string) => ({
    path, branch, baseBranch: 'main', baseCommit: 'aaaaaaa1', createdAt: 0,
  });

  beforeEach(async () => {
    await loadProjectOrchestratorTasks({ id: 'project-1', root_path: '/repo' });
    orchestratorTasks.set([]);
  });

  it.each([false, true])('cleans stopped picker worktrees in ambient %s and skips live agents', async (dev) => {
    setSessionWorktree.mockClear();
    const closed = wt('/repo/.spacron/worktrees/closed', 'spacron/closed');
    const live = wt('/repo/.spacron/worktrees/live', 'spacron/live');
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) => ({ sessions: isDev === dev ? [
      { id: 7, isRunning: false, ownerTaskId: null, worktree: closed },
      { id: 8, isRunning: true, ownerTaskId: null, worktree: live },
    ] : [] }));
    invoke.mockImplementation(async (command: string) => {
      if (command === 'workspace_git_worktree_delta') return { head: 'tip', dirty_files: 0, committed_files: 0, up_to_date: true };
    });
    expect(await cleanupStaleWorktrees('project-1')).toBe(1);
    expect(setSessionWorktree).toHaveBeenCalledWith(7, null);
    expect(setSessionWorktree).not.toHaveBeenCalledWith(8, null);
    expect(invoke).toHaveBeenCalledWith('workspace_git_remove_worktree', expect.objectContaining({ worktreePath: closed.path, deleteBranch: false }));
    expect(invoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.objectContaining({ worktreePath: live.path }));
  });

  it('keeps failed removals tracked for a later cleanup retry', async () => {
    setSessionWorktree.mockClear();
    const worktree = wt('/repo/.spacron/worktrees/closed', 'spacron/closed');
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) => ({ sessions: isDev ? [] : [{ id: 7, isRunning: false, ownerTaskId: null, worktree }] }));
    invoke.mockImplementation(async (command: string) => {
      if (command === 'workspace_git_worktree_delta') return { head: 'tip', dirty_files: 0, committed_files: 0, up_to_date: true };
      if (command === 'workspace_git_remove_worktree') throw new Error('Worktree locked');
    });
    await cleanupStaleWorktrees('project-1');
    expect(setSessionWorktree).not.toHaveBeenCalled();
    expect(trackedWorktrees().some((entry) => entry.worktree.path === worktree.path)).toBe(true);
  });

  it('picks up an agent spawned from the Spawn Agents picker', () => {
    // The picker keeps the worktree on the SESSION, not on a task — there is no
    // orchestrator task at all. Missing this path means a hand-spawned agent's
    // work is never staged.
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) =>
      isDev ? { sessions: [] } : {
        sessions: [{
          id: 7, isRunning: true, ownerTaskId: null, agentName: 'Alex',
          worktree: wt('/repo/.spacron/worktrees/alex', 'spacron/alex-1'),
        }],
      });

    const tracked = trackedWorktrees();

    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ projectId: 'project-1', agentName: 'Alex', live: true });
  });

  it('picks up an agent spawned into the Development ambient', () => {
    // Regression guard: dev-ambient sessions live in a separate state map that
    // `getTerminalProjectState` does not reach by default, so scanning only the
    // normal ambient silently lost every one of these agents' changes.
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) =>
      isDev ? {
        sessions: [{
          id: 9, isRunning: true, ownerTaskId: null, agentName: 'Iris',
          worktree: wt('/repo/.spacron/worktrees/iris', 'spacron/iris-2'),
        }],
      } : { sessions: [] });

    const tracked = trackedWorktrees();

    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ agentName: 'Iris', live: true });
  });

  it('picks up an orchestrator-dispatched agent whose task has finished', () => {
    getTerminalProjectState.mockImplementation(() => ({ sessions: [] }));
    const seed = createOrchestratorTask('project-1', 'Some goal', 'claude', 'Backend');
    orchestratorTasks.set([{
      ...seed, status: 'complete', assignedSessionId: null, lastSessionId: 42,
      worktree: wt('/repo/.spacron/worktrees/backend', 'spacron/backend-3'),
    }]);

    const tracked = trackedWorktrees();

    expect(tracked).toHaveLength(1);
    // Its pane is gone, but the worktree is still tracked — that is the whole point.
    expect(tracked[0]).toMatchObject({ agentName: 'Backend', live: false });
  });

  it('lists one entry when a session and a task name the same worktree', () => {
    const shared = wt('/repo/.spacron/worktrees/shared', 'spacron/shared-4');
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) =>
      isDev ? { sessions: [] } : {
        sessions: [{ id: 5, isRunning: true, ownerTaskId: null, agentName: 'Alex', worktree: shared }],
      });
    const seed = createOrchestratorTask('project-1', 'Some goal', 'claude', 'Backend');
    orchestratorTasks.set([{ ...seed, status: 'complete', worktree: shared }]);

    const tracked = trackedWorktrees();

    expect(tracked).toHaveLength(1);
    // The session entry wins, so live status isn't downgraded to false.
    expect(tracked[0]).toMatchObject({ agentName: 'Alex', live: true });
  });
});

/**
 * Closing a project (or the app) reclaims its agent checkouts so they stop
 * accumulating on disk. The invariant under test is the one that has been broken
 * twice before: reclaiming must never destroy work the user has not seen.
 */
describe('reclaimProjectWorktrees', () => {
  const wt = (path: string, branch: string) => ({
    path, branch, baseBranch: 'main', baseCommit: 'aaaaaaa1', createdAt: 0,
  });
  const CLEAN = { head: 'bbbbbbb2', dirty_files: 0, committed_files: 0, up_to_date: true };
  const DIRTY = { head: 'bbbbbbb2', dirty_files: 3, committed_files: 0, up_to_date: false };

  /**
   * Route the git commands reclaim depends on; everything else stays undefined.
   * Also clears the call history, so a `not.toHaveBeenCalledWith` assertion below
   * is about this test's reclaim and not about setup or an earlier case — the
   * `invoke` mock is shared across the whole file.
   */
  const git = (delta: unknown) => {
    invoke.mockClear();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'workspace_git_worktree_delta') return delta;
      if (command === 'workspace_git_list_worktrees') return [];
      return undefined;
    });
  };

  beforeEach(async () => {
    await loadProjectOrchestratorTasks({ id: 'project-1', root_path: '/repo' });
    orchestratorTasks.set([]);
  });

  it('removes a checkout git confirms is fully staged', async () => {
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) =>
      isDev ? { sessions: [] } : {
        sessions: [{
          id: 7, isRunning: true, ownerTaskId: null, agentName: 'Alex',
          worktree: wt('/repo/.spacron/worktrees/alex', 'spacron/alex-1'),
        }],
      });
    git(CLEAN);

    const outcome = await reclaimProjectWorktrees('project-1');

    expect(outcome).toMatchObject({ removed: 1, kept: 0 });
    expect(invoke).toHaveBeenCalledWith(
      'workspace_git_remove_worktree',
      expect.objectContaining({ worktreePath: '/repo/.spacron/worktrees/alex' }),
    );
  });

  it('KEEPS a checkout that still holds unstaged work, and names its agent', async () => {
    // The whole safety property. A close must not be a data-loss event: the
    // branch is the only durable copy until the user commits in Source Control.
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) =>
      isDev ? { sessions: [] } : {
        sessions: [{
          id: 7, isRunning: true, ownerTaskId: null, agentName: 'Alex',
          worktree: wt('/repo/.spacron/worktrees/alex', 'spacron/alex-1'),
        }],
      });
    git(DIRTY);

    const outcome = await reclaimProjectWorktrees('project-1');

    expect(outcome).toMatchObject({ removed: 0, kept: 1, keptAgents: ['Alex'] });
    expect(invoke).not.toHaveBeenCalledWith('workspace_git_remove_worktree', expect.anything());
  });

  it('never deletes the branch, even when the checkout goes', async () => {
    // Removing the checkout is what reclaims disk space; the branch costs
    // almost nothing and is the user's only route back to the work.
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) =>
      isDev ? { sessions: [] } : {
        sessions: [{
          id: 7, isRunning: true, ownerTaskId: null, agentName: 'Alex',
          worktree: wt('/repo/.spacron/worktrees/alex', 'spacron/alex-1'),
        }],
      });
    git(CLEAN);

    await reclaimProjectWorktrees('project-1');

    expect(invoke).toHaveBeenCalledWith(
      'workspace_git_remove_worktree',
      expect.objectContaining({ deleteBranch: false }),
    );
  });

  it('covers agents from BOTH ownership paths and both ambients', async () => {
    // Session-owned (Spawn Agents picker), dev-ambient, and task-owned agents
    // all have to be swept — missing any one leaves a checkout behind forever.
    getTerminalProjectState.mockImplementation((_p?: string, isDev = false) =>
      isDev ? {
        sessions: [{
          id: 9, isRunning: true, ownerTaskId: null, agentName: 'Iris',
          worktree: wt('/repo/.spacron/worktrees/iris', 'spacron/iris-2'),
        }],
      } : {
        sessions: [{
          id: 7, isRunning: true, ownerTaskId: null, agentName: 'Alex',
          worktree: wt('/repo/.spacron/worktrees/alex', 'spacron/alex-1'),
        }],
      });
    const seed = createOrchestratorTask('project-1', 'Some goal', 'claude', 'Backend');
    orchestratorTasks.set([{
      ...seed, status: 'complete', assignedSessionId: null, lastSessionId: 42,
      worktree: wt('/repo/.spacron/worktrees/backend', 'spacron/backend-3'),
    }]);
    git(CLEAN);

    const outcome = await reclaimProjectWorktrees('project-1');

    expect(outcome.removed).toBe(3);
  });

  it('leaves another project’s worktrees alone', async () => {
    getTerminalProjectState.mockImplementation(() => ({ sessions: [] }));
    const seed = createOrchestratorTask('project-2', 'Other goal', 'claude', 'Other');
    orchestratorTasks.set([{
      ...seed, status: 'complete', assignedSessionId: null, lastSessionId: 42,
      worktree: wt('/other/.spacron/worktrees/other', 'spacron/other-9'),
    }]);
    git(CLEAN);

    const outcome = await reclaimProjectWorktrees('project-1');

    expect(outcome).toMatchObject({ removed: 0, kept: 0 });
  });
});

// ---------------------------------------------------------------------------
// report_status calls that no turn watcher took
// ---------------------------------------------------------------------------

describe('recordUnwatchedAgentReport', () => {
  beforeEach(() => {
    orchestratorTasks.set([]);
    chatMessages.set({});
    resetMocks();
  });

  afterEach(() => {
    orchestratorTasks.set([]);
    chatMessages.set({});
  });

  it('files the report as a completion card under the task that owns the session', () => {
    const task = createOrchestratorTask('project-1', 'Ship the retry backoff', 'claude');
    orchestratorTasks.update((all) =>
      all.map((t) => (t.id === task.id ? { ...t, status: 'in-progress' as const, assignedSessionId: 7, name: 'Iris' } : t)),
    );
    chatMessages.set({});

    const filedUnder = recordUnwatchedAgentReport(7, { kind: 'finished', detail: 'Tests pass.' }, 'Agent');

    expect(filedUnder).toBe('project-1');
    const card = get(chatMessages)['project-1']?.at(-1)?.completion;
    expect(card).toMatchObject({
      status: 'done',
      agentName: 'Iris',
      taskTitle: task.title,
      reason: 'Tests pass.',
      agentType: 'claude',
      taskId: task.id,
      // The agent said this itself, so it is allowed to interrupt — the whole
      // point of the report is that it is not a guess.
      endedBy: 'declared',
      silent: false,
    });
  });

  it('files an unattributed report under the open project', () => {
    getActiveTerminalProjectId.mockReturnValue('project-9');

    const filedUnder = recordUnwatchedAgentReport(
      null,
      { kind: 'blocked', reason: 'Which database?' },
      'An agent',
    );

    expect(filedUnder).toBe('project-9');
    expect(get(chatMessages)['project-9']?.at(-1)?.completion).toMatchObject({
      status: 'blocked',
      agentName: 'An agent',
      reason: 'Which database?',
    });
  });

  it('uses the session to find the project when no task owns it', () => {
    allSessionsValue.push({ id: 12, projectId: 'project-3', agentName: 'Vale', taskSummary: 'Refactor the parser' });

    const filedUnder = recordUnwatchedAgentReport(12, { kind: 'failed', reason: 'Build broke.' }, 'Agent');

    expect(filedUnder).toBe('project-3');
    expect(get(chatMessages)['project-3']?.at(-1)?.completion).toMatchObject({
      status: 'failed',
      agentName: 'Vale',
      taskTitle: 'Refactor the parser',
      reason: 'Build broke.',
    });
  });

  it('declines rather than filing a report with nowhere to put it', () => {
    // No task, no session, no open project. Returning null lets the caller fall
    // back to a toast instead of dropping the report on the floor.
    expect(recordUnwatchedAgentReport(null, { kind: 'finished' }, 'An agent')).toBeNull();
    expect(get(chatMessages)).toEqual({});
  });
});

describe('runBrainCommand (brain run_command tool)', () => {
  beforeEach(() => {
    resetMocks();
  });

  // Answers the next hidden run with a completion sentinel carrying exitCode,
  // the way a real shell would after executing the wrapped command.
  function completeNextRun(exitCode: number, body = 'test output') {
    sendPromptToSession.mockImplementationOnce((_id: number, text: string) => {
      const token = /__SPACRON_EMBEDDED_DONE_([a-z0-9]+)_/.exec(text)?.[1] ?? 'missing';
      getSessionOutputSince.mockReturnValue(`${body}\n__SPACRON_EMBEDDED_DONE_${token}_${exitCode}__`);
    });
  }

  it('returns exit code + output and reclaims the hidden session', async () => {
    completeNextRun(0, 'PASS 12 tests');
    const res = await runBrainCommand('p1', '/repo', 'npm test', 5000);

    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain('PASS 12 tests');
    expect(createTerminalSession).toHaveBeenCalledWith('/repo', undefined, 'p1', expect.objectContaining({ hidden: true, assignPane: false }));
    expect(sendPromptToSession).toHaveBeenCalledWith(99, expect.stringContaining('SPACRON_EMBEDDED_DONE'));
    expect(killSession).toHaveBeenCalledWith(99);
  });

  it('reports non-zero exits without throwing', async () => {
    completeNextRun(2, 'FAIL src/auth.test.ts');
    const res = await runBrainCommand('p1', '/repo', 'npm test', 5000);

    expect(res.exitCode).toBe(2);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain('FAIL src/auth.test.ts');
  });

  it('times out with output-so-far when no sentinel arrives', async () => {
    getSessionOutputSince.mockReturnValue('still crunching…');
    const res = await runBrainCommand('p1', '/repo', 'sleep 60', 700);

    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.output).toContain('still crunching');
    expect(killSession).toHaveBeenCalledWith(99);
  });

  it('returns empty when no terminal can be created', async () => {
    createTerminalSession.mockResolvedValueOnce(null);
    const res = await runBrainCommand('p1', '/repo', 'npm test', 5000);

    expect(res.exitCode).toBeNull();
    expect(res.output).toBe('');
    expect(sendPromptToSession).not.toHaveBeenCalled();
  });
});

describe('formatBrainRunResult', () => {
  it('shows exit status and strips sentinel lines', () => {
    const text = formatBrainRunResult('npm test', {
      exitCode: 0,
      output: 'PASS 12 tests\n__SPACRON_EMBEDDED_DONE_ab12cd_0__',
      timedOut: false,
      elapsedMs: 1200,
    });
    expect(text).toContain('exit 0');
    expect(text).toContain('PASS 12 tests');
    expect(text).not.toContain('SPACRON_EMBEDDED_DONE');
  });

  it('marks timeouts and closed sessions distinctly', () => {
    expect(formatBrainRunResult('sleep 60', { exitCode: null, output: 'partial', timedOut: true, elapsedMs: 90000 })).toContain('TIMEOUT');
    expect(formatBrainRunResult('npm test', { exitCode: null, output: '', timedOut: false, elapsedMs: 400 })).toContain('SESSION CLOSED');
  });
});
