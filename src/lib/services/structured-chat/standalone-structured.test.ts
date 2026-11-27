import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Listener = () => void;
  const states = new Map<number, any>();
  const listeners = new Set<Listener>();
  const makeProvider = (agent: string, label: string) => ({
    agent,
    label,
    get: (id: number) => states.get(id) ?? null,
    subscribe: (listener: Listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    start: vi.fn(async (id: number) => {
      states.set(id, { status: 'ready', error: null, items: [], models: [], model: null, effort: null, access: 'ask', threadId: `${agent}-t`, approvals: [] });
      listeners.forEach((l) => l());
    }),
    send: vi.fn(async (id: number, text: string) => {
      const s = states.get(id);
      states.set(id, { ...s, items: [...(s?.items ?? []), { id: 'u1', kind: 'user', text }] });
      listeners.forEach((l) => l());
    }),
    close: vi.fn(async (id: number) => { states.delete(id); listeners.forEach((l) => l()); }),
    setModel: vi.fn(),
    setEffort: vi.fn(),
  });
  return {
    codex: makeProvider('codex', 'Codex'),
    claude: makeProvider('claude', 'Claude Code'),
    states,
    invoke: vi.fn(),
    createProjectFolder: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('$lib/stores/terminal', () => ({
  sessions: { subscribe: (fn: (v: unknown[]) => void) => { fn([]); return () => {}; } },
  allProjectSessions: { subscribe: (fn: (v: unknown[]) => void) => { fn([]); return () => {}; } },
  getSessionRoot: () => null,
  getActiveTerminalProjectId: () => null,
  createTerminalSession: vi.fn(async () => 1),
  onSessionExit: vi.fn(),
  updateSessionTitle: vi.fn(),
  getAgentDisplayName: (preset: string) => preset,
  activeSessionId: { subscribe: (fn: (v: unknown) => void) => { fn(null); return () => {}; } },
  setActiveSession: vi.fn(),
}));
vi.mock('$lib/stores/workspace', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return {
    createProjectFolder: h.createProjectFolder,
    newFolderPromptOpen: writable(false),
  };
});
vi.mock('$lib/stores/interactionMode', () => ({ setInteractionMode: vi.fn() }));
vi.mock('$lib/stores/orchestrator', () => ({ enqueueChatMessage: vi.fn(), loadProjectOrchestratorTasks: vi.fn(async () => {}), stopChatTurn: vi.fn() }));
vi.mock('./mcp-subagents', () => ({ restoreMcpSubagents: vi.fn() }));
vi.mock('./registry', () => ({
  structuredChatProvider: (agent: string) => (agent === 'codex' ? h.codex : agent === 'claude' ? h.claude : null),
  sendStructuredChat: (agent: string, id: number, text: string) => (agent === 'codex' ? h.codex : h.claude).send(id, text),
}));

import { get } from '$lib/stores/storeCompat';
import { __resetSessionStoreForTests, createStandaloneStructuredRecord, findPaneForRecord, flushSessionStore, structuredSessions } from './session-store';
import { startStandaloneStructuredChat } from '$lib/stores/chatNavigation';
import {
  __resetStandaloneStructuredForTests,
  ensureStandaloneWorkspaceCwd,
  promoteStandaloneStructuredChatToProject,
  sendStandaloneStructuredMessage,
  switchStandaloneStructuredAgent,
  virtualPaneForStandaloneRecord,
} from './standalone-structured';

describe('standalone-structured', () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    __resetStandaloneStructuredForTests();
    h.states.clear();
    vi.clearAllMocks();
    h.invoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === 'chat_workspace_open') {
        return { id: `ws-${args.workspaceId}`, name: 'Chat', root_path: `C:/Scratch/${args.workspaceId}`, state: { open_files: [], active_file: null, last_modified: '' } };
      }
      if (command === 'chat_workspace_export') return ['notes.md'];
      if (command === 'fs_read_file') throw new Error('Not found');
      return undefined;
    });
    h.createProjectFolder.mockResolvedValue({ id: 'proj-99', name: 'NewApp', root_path: 'C:/Projects/NewApp', state: { open_files: [], active_file: null, last_modified: '' } });
  });

  it('allocates negative virtual pane IDs and resolves scratch workspace cwd lazily', async () => {
    const rec = createStandaloneStructuredRecord({ provider: 'claude' });
    const paneId = virtualPaneForStandaloneRecord(rec.id);
    expect(paneId).toBeLessThan(0);

    const cwd = await ensureStandaloneWorkspaceCwd(rec.id);
    expect(cwd).toBe(`C:/Scratch/${rec.id}`);
    expect(get(structuredSessions)[rec.id]).toMatchObject({ cwd, standaloneWorkspaceId: rec.id });
    expect(h.claude.start).not.toHaveBeenCalled();
  });

  it('updates draft agent lazily before first send, boots on send, and swaps live thereafter', async () => {
    const rec = createStandaloneStructuredRecord({ provider: 'claude' });
    await switchStandaloneStructuredAgent(rec.id, 'codex', { model: 'gpt-5', effort: 'high' });
    expect(h.codex.start).not.toHaveBeenCalled();
    expect(get(structuredSessions)[rec.id]).toMatchObject({ provider: 'codex', model: 'gpt-5', effort: 'high' });

    await sendStandaloneStructuredMessage(rec.id, 'Build a prototype');
    const paneId = findPaneForRecord(rec.id)!;
    expect(paneId).toBeLessThan(0);
    expect(h.codex.start).toHaveBeenCalled();
    expect(h.codex.send).toHaveBeenCalledWith(paneId, 'Build a prototype');

    await switchStandaloneStructuredAgent(rec.id, 'claude', { model: 'sonnet', effort: 'medium' });
    expect(h.codex.close).toHaveBeenCalledWith(paneId);
    expect(h.claude.start).toHaveBeenCalled();
  });

  it('starts a different agent fresh when no pane is running', async () => {
    const rec = createStandaloneStructuredRecord({ provider: 'claude' });
    structuredSessions.update((all) => ({ ...all, [rec.id]: { ...all[rec.id], nativeSessionId: 'claude-t' } }));

    await switchStandaloneStructuredAgent(rec.id, 'codex', { model: 'gpt-5' });
    expect(get(structuredSessions)[rec.id]).toMatchObject({ provider: 'codex', model: 'gpt-5', nativeSessionId: null });
  });

  it('shows the untouched chat again instead of adding another', () => {
    const first = startStandaloneStructuredChat();
    expect(startStandaloneStructuredChat()).toBe(first);
    structuredSessions.update((all) => ({ ...all, [first]: { ...all[first], lastSeq: 3, title: 'Used' } }));
    expect(startStandaloneStructuredChat()).not.toBe(first);
  });

  it('keeps a pinned chat when more than fifty newer ones exist', () => {
    const old = createStandaloneStructuredRecord({ provider: 'claude', pinned: true, createdAt: 1, updatedAt: 1 });
    for (let i = 0; i < 55; i += 1) createStandaloneStructuredRecord({ provider: 'claude' });
    const stored = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) } });
    flushSessionStore();
    vi.unstubAllGlobals();
    const saved = JSON.parse(stored.get('spacron_structured_sessions') ?? '{}');
    expect(Object.keys(saved)).toHaveLength(50);
    expect(saved[old.id]).toBeTruthy();
  });

  it('starts a new standalone chat asking before it acts', async () => {
    const rec = createStandaloneStructuredRecord({ provider: 'claude' });
    expect(rec.access).toBe('ask');
    await sendStandaloneStructuredMessage(rec.id, 'Hello');
    expect(h.claude.start).toHaveBeenCalledWith(expect.any(Number), expect.any(String), expect.objectContaining({ access: 'ask' }));
  });

  it('promotes a standalone structured chat to a project with exported files and brief', async () => {
    const rec = createStandaloneStructuredRecord({ provider: 'claude', title: 'Planner' });
    await sendStandaloneStructuredMessage(rec.id, 'Outline API design');

    const project = await promoteStandaloneStructuredChatToProject(rec.id, 'C:/Projects', 'NewApp');
    expect(project.id).toBe('proj-99');
    expect(h.invoke).toHaveBeenCalledWith('chat_workspace_export', { workspaceId: rec.id, projectId: 'proj-99' });
    expect(h.invoke).toHaveBeenCalledWith('fs_write_file_checked', expect.objectContaining({
      path: 'C:/Projects/NewApp/PROJECT_BRIEF.md',
    }));
    expect(get(structuredSessions)[rec.id]).toMatchObject({
      standalone: false,
      projectId: 'proj-99',
      cwd: 'C:/Projects/NewApp',
      seedContext: true,
    });
  });
});
