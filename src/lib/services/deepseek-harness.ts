/**
 * DeepSeek Harness (`dsh`) — the agent with no terminal UI.
 *
 * DeepSeek removed dsh's terminal frontend, so it cannot run in a pane the way
 * `claude` or `codex` do. It reaches Spacron two ways instead:
 *
 * - **Web panel** — the agent tile opens dsh's own browser UI in its own room
 *   (`components/deepseek/DeepSeekPanel.tsx`), on the active project. Rust
 *   starts and owns one `dsh web` per project and serves it through a loopback
 *   gateway (`commands/deepseek_harness.rs` explains why).
 * - **Headless worker** — an orchestrator dispatch (chat or `delegate_task`)
 *   opens a plain terminal; delivering the goal saves it to a file and types a
 *   `dsh --profile headless` launch that reads it. dsh exits when the task is
 *   done and the worker script reports that end as a declared turn signal.
 *
 * Both launches get Spacron's MCP tools from a dsh patch file, with the MCP URL
 * in the environment. The DeepSeek key never reaches the frontend: the worker
 * asks for it with an env marker that `terminal_create` resolves in Rust.
 */
import { invoke } from '@tauri-apps/api/core';
import { get, writable } from '$lib/stores/storeCompat';
import { activeProject, activeProjectId } from '$lib/stores/workspace';
import { createTaskWorktree, type WorktreeInfo } from '$lib/services/orchestrator/worktree-manager';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { showToast } from '$lib/stores/notification';
import { agentExecutable } from '$lib/services/orchestrator/agent-rules-file';
import { pickAssistantName } from '$lib/services/orchestrator/agent-names';

export const DEEPSEEK_HARNESS_COMMAND = 'dsh';

/** Mirrors `KEY_MARKER_ENV` in `commands/deepseek_harness.rs`. */
const KEY_MARKER_ENV = 'SPACRON_WITH_DSH_KEYS';

/**
 * Positional task for the headless launch. The real task comes from the task
 * file, but dsh's startup parser rejects a missing positional outright when
 * stdin is a terminal, so one must be present.
 */
const TASK_PLACEHOLDER = 'spacron-task';

const NAMES_STORAGE_KEY = 'spacron.deepseekHarness.names';
let agentNames: Map<string, string> | null = null;

function loadAgentNames(): Map<string, string> {
  if (agentNames) return agentNames;
  agentNames = new Map();
  try {
    const raw = localStorage.getItem(NAMES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [root, name] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof name === 'string' && name.trim()) agentNames.set(root, name);
      }
    }
  } catch {
    // Storage unavailable or corrupt: names are cosmetic, so start fresh.
  }
  return agentNames;
}

/**
 * The assistant name of a project's DeepSeek panel, like the names other agents
 * get. Picked once from the shared pool (avoiding `taken`) and kept, so the
 * panel is the same "agent" every time that project opens it.
 */
export function deepSeekAgentName(root: string, taken: Iterable<string> = []): string {
  const names = loadAgentNames();
  const existing = names.get(root);
  if (existing) return existing;
  const name = pickAssistantName(taken);
  names.set(root, name);
  try {
    localStorage.setItem(NAMES_STORAGE_KEY, JSON.stringify(Object.fromEntries(names)));
  } catch {
    // Kept for this session only.
  }
  return name;
}

// ---------------------------------------------------------------------------
// Placement: main repo or an isolated worktree, per project
// ---------------------------------------------------------------------------

/**
 * Where a project's DeepSeek panel works. `worktree` null means the main
 * checkout. `retired` holds worktrees the panel has left: they may still carry
 * work, so they stay tracked (not live) until the reconciler's cleanup brings
 * that work in and reclaims them — exactly like a closed agent pane's.
 */
export interface DeepSeekPlacement {
  worktree: WorktreeInfo | null;
  retired: WorktreeInfo[];
}

const PLACEMENT_STORAGE_KEY = 'spacron.deepseekHarness.placements';

function loadPlacements(): Record<string, DeepSeekPlacement> {
  try {
    const raw = localStorage.getItem(PLACEMENT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, DeepSeekPlacement> = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, Partial<DeepSeekPlacement>>)) {
      const worktree = value?.worktree && typeof value.worktree.path === 'string' ? value.worktree : null;
      const retired = Array.isArray(value?.retired) ? value.retired.filter((w) => typeof w?.path === 'string') : [];
      out[projectId] = { worktree, retired };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persisted so a worktree survives a restart still owned: the orphan sweep
 * deletes any checkout no session, task or this registry claims.
 */
export const deepSeekPlacements = writable<Record<string, DeepSeekPlacement>>(loadPlacements());
deepSeekPlacements.subscribe((value) => {
  try {
    localStorage.setItem(PLACEMENT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Not persisted this session; the checkout stays on disk and is kept.
  }
});

/** The folder a project's DeepSeek panel opens on. */
export function deepSeekPanelRoot(
  placements: Record<string, DeepSeekPlacement>,
  projectId: string | null | undefined,
  projectRoot: string,
): string {
  return (projectId && placements[projectId]?.worktree?.path) || projectRoot;
}

/** Point a project's panel at `worktree` (or the main checkout), retiring the old one. */
export function setDeepSeekPlacement(projectId: string, worktree: WorktreeInfo | null): void {
  deepSeekPlacements.update((all) => {
    const current = all[projectId] ?? { worktree: null, retired: [] };
    if (current.worktree?.path === worktree?.path) return all;
    const retired = current.retired.filter((w) => w.path !== worktree?.path);
    if (current.worktree) retired.push(current.worktree);
    return { ...all, [projectId]: { worktree, retired } };
  });
}

/** Every DeepSeek-owned worktree, for the reconciler and the orphan sweep. */
export function deepSeekTrackedWorktrees(): { projectId: string; agentName: string; worktree: WorktreeInfo; live: boolean }[] {
  const out: { projectId: string; agentName: string; worktree: WorktreeInfo; live: boolean }[] = [];
  for (const [projectId, placement] of Object.entries(get(deepSeekPlacements))) {
    const entries: [WorktreeInfo, boolean][] = [
      ...(placement.worktree ? [[placement.worktree, true] as [WorktreeInfo, boolean]] : []),
      ...placement.retired.map((w) => [w, false] as [WorktreeInfo, boolean]),
    ];
    for (const [worktree, live] of entries) {
      out.push({ projectId, agentName: deepSeekAgentName(worktree.path), worktree, live });
    }
  }
  return out;
}

/** Write a reconciler result (new baseline, conflict state) onto the owner. */
export function patchDeepSeekWorktree(projectId: string, path: string, patch: Partial<WorktreeInfo>): void {
  deepSeekPlacements.update((all) => {
    const current = all[projectId];
    if (!current) return all;
    const apply = (w: WorktreeInfo) => (w.path === path ? { ...w, ...patch } : w);
    return {
      ...all,
      [projectId]: { worktree: current.worktree ? apply(current.worktree) : null, retired: current.retired.map(apply) },
    };
  });
}

/** Forget a worktree once its checkout is reclaimed. */
export function dropDeepSeekWorktree(projectId: string, path: string): void {
  deepSeekPlacements.update((all) => {
    const current = all[projectId];
    if (!current) return all;
    return {
      ...all,
      [projectId]: {
        worktree: current.worktree?.path === path ? null : current.worktree,
        retired: current.retired.filter((w) => w.path !== path),
      },
    };
  });
}

/** Terminals opened as DeepSeek workers: they take a goal as a launch, not typed input. */
const workerSessions = new Set<number>();

export function markDeepSeekWorkerSession(sessionId: number): void {
  workerSessions.add(sessionId);
}

export function isDeepSeekWorkerSession(sessionId: number): boolean {
  return workerSessions.has(sessionId);
}

export interface DeepSeekHarnessStatus {
  installed: boolean;
  version: string | null;
  pinnedVersion: string;
  hasKey: boolean;
  problem: string | null;
}

export interface WorkerFiles {
  workerScript: string;
  binJs: string;
  mcpPatch: string;
  taskPatch: string;
  /** Starts every session with full access. */
  accessPatch: string;
  /** Registers non-DeepSeek providers; null when only a DeepSeek key is saved. */
  providersPatch: string | null;
}

export interface WebPanel {
  url: string;
  mcpWarning: string | null;
}

export function isDeepSeekHarness(presetOrCommand: string | null | undefined): boolean {
  return agentExecutable(presetOrCommand) === DEEPSEEK_HARNESS_COMMAND;
}

function quotePath(path: string): string {
  // Double quotes mean the same in PowerShell, cmd and bash for a path, which
  // never contains a quote on any of the platforms Spacron ships on.
  if (path.includes('"')) throw new Error(`Unsupported path for DeepSeek Harness: ${path}`);
  return `"${path}"`;
}

/** Env a worker terminal needs at creation — the only time env can be set. */
export function deepSeekWorkerEnv(mcpUrl: string): Record<string, string> {
  return { SPACRON_MCP_URL: mcpUrl, [KEY_MARKER_ENV]: '1' };
}

/**
 * The line typed into a worker terminal to run one task. `node` is bare on
 * purpose: a quoted path as the first token is a string, not a command, in
 * PowerShell. Pure, so the launch contract is testable without a PTY.
 */
export function deepSeekLaunchLine(files: WorkerFiles, taskPath: string): string {
  return [
    'node',
    quotePath(files.workerScript),
    quotePath(taskPath),
    quotePath(files.binJs),
    '--profile headless',
    `--patch ${quotePath(files.mcpPatch)}`,
    `--patch ${quotePath(files.taskPatch)}`,
    `--patch ${quotePath(files.accessPatch)}`,
    ...(files.providersPatch ? [`--patch ${quotePath(files.providersPatch)}`] : []),
    TASK_PLACEHOLDER,
  ].join(' ');
}

/** Why a worker cannot run here, worded for the user, or null when it can. */
export async function deepSeekWorkerProblem(): Promise<string | null> {
  if (get(remoteTarget)) return 'DeepSeek Harness runs on this computer only, not in a remote workspace.';
  const status = await invoke<DeepSeekHarnessStatus>('deepseek_harness_status');
  return status.problem;
}

/**
 * Hand a worker terminal its task: save it to a file and type the launch. The
 * worker script reports the task's end on the session's status channel, so the
 * orchestrator's turn watcher sees a declared finish or failure.
 */
export async function deliverDeepSeekTask(
  sessionId: number,
  task: string,
  write: (sessionId: number, data: string) => void,
): Promise<boolean> {
  try {
    const problem = await deepSeekWorkerProblem();
    if (problem) {
      showToast(problem, 'error', 10000);
      return false;
    }
    const files = await invoke<WorkerFiles>('deepseek_harness_worker_files');
    const taskPath = await invoke<string>('deepseek_harness_write_task', { text: task });
    write(sessionId, deepSeekLaunchLine(files, taskPath) + '\r');
    return true;
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), 'error', 10000);
    return false;
  }
}

/**
 * Start (or find) this project's `dsh web` and return its panel address. The
 * room calls this; Rust returns the already-running instance for a project, so
 * repeated calls are cheap. It opens on `root` as its workspace.
 */
export async function startDeepSeekHarnessWeb(root: string): Promise<WebPanel> {
  const status = await invoke<DeepSeekHarnessStatus>('deepseek_harness_status');
  if (status.problem) throw new Error(status.problem);
  // Dynamic: mcpBridge imports this module for the headless worker path.
  const { getMcpHttpUrl } = await import('$lib/stores/mcpBridge');
  return invoke<WebPanel>('deepseek_harness_web_open', { root, mcpUrl: await getMcpHttpUrl() });
}

/**
 * Open the DeepSeek Harness room on the active project. The room starts dsh and
 * reports its own progress and problems. Resolves false when it cannot open;
 * the reason has been shown as a toast.
 */
export async function openDeepSeekHarnessPanel(opts: { isolated?: boolean } = {}): Promise<boolean> {
  if (get(remoteTarget)) {
    showToast('DeepSeek Harness runs on this computer only, not in a remote workspace.', 'warning');
    return false;
  }
  const projectId = get(activeProjectId);
  if (!get(activeProject)?.root_path || !projectId) {
    showToast('Open a project first: DeepSeek Harness works inside a project folder.', 'warning');
    return false;
  }
  // The same choice every agent gets in the picker. An isolated panel keeps
  // one worktree per project: reopening it returns to the same checkout and
  // conversation rather than forking another.
  if (opts.isolated) {
    const existing = get(deepSeekPlacements)[projectId]?.worktree;
    if (!existing) {
      try {
        const worktree = await createTaskWorktree({
          projectId,
          taskId: `dsh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          label: 'deepseek',
        });
        setDeepSeekPlacement(projectId, worktree);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error', 10000);
        return false;
      }
    }
  } else {
    setDeepSeekPlacement(projectId, null);
  }
  const { useLayoutStore } = await import('$lib/stores/zustand/layout');
  useLayoutStore.getState().revealDeepSeek();
  return true;
}
