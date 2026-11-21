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
import { workingRootFor } from '$lib/stores/projectWorktrees';
import { isPathInside } from '$lib/services/project-worktrees';
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
// Placement: which of the project's worktrees the panel works in
// ---------------------------------------------------------------------------

/**
 * Where a project's DeepSeek panel works: the path of one of the project's own
 * worktrees, or `null` for the main checkout.
 *
 * The panel is an agent like every other one, so it starts in the sidebar's
 * selected worktree and moves only when it is opened somewhere else. It never
 * creates a checkout of its own: an agent-owned `.spacron/worktrees/` checkout
 * is not one of the user's worktree rows, so the panel would be working outside
 * the worktrees they can see and manage.
 */
export interface DeepSeekPlacement {
  worktreePath: string | null;
}

const PLACEMENT_STORAGE_KEY = 'spacron.deepseekHarness.placements';

function loadPlacements(): Record<string, DeepSeekPlacement> {
  try {
    const raw = localStorage.getItem(PLACEMENT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, DeepSeekPlacement> = {};
    for (const [projectId, value] of Object.entries(parsed as Record<string, { worktreePath?: unknown }>)) {
      // Records written before this shape named an agent-owned checkout under
      // `worktree`; those folders are not worktree rows, so they are dropped and
      // the panel opens on the main checkout.
      out[projectId] = { worktreePath: typeof value?.worktreePath === 'string' ? value.worktreePath : null };
    }
    return out;
  } catch {
    return {};
  }
}

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
  return (projectId && placements[projectId]?.worktreePath) || projectRoot;
}

/** True when two folders are the same one, despite separators or case. */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b) && isPathInside(a, b!) && isPathInside(b, a!);
}

/** Point a project's panel at one of its worktrees, or the main checkout. */
export function setDeepSeekPlacement(projectId: string, worktreePath: string | null): void {
  deepSeekPlacements.update((all) => {
    if ((all[projectId]?.worktreePath ?? null) === worktreePath) return all;
    return { ...all, [projectId]: { worktreePath } };
  });
}

/** Forget a project's placement, whose worktree is gone. */
export function clearDeepSeekPlacement(projectId: string, worktreePath: string): void {
  deepSeekPlacements.update((all) => {
    if (!sameFolder(all[projectId]?.worktreePath, worktreePath)) return all;
    return { ...all, [projectId]: { worktreePath: null } };
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
  /** The user's MCP servers (Settings > MCP & plugins); null when there are none. */
  userMcpPatch: string | null;
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
    ...(files.userMcpPatch ? [`--patch ${quotePath(files.userMcpPatch)}`] : []),
    TASK_PLACEHOLDER,
  ].join(' ');
}

/** Why a worker cannot run here, worded for the user, or null when it can. */
export async function deepSeekWorkerProblem(): Promise<string | null> {
  if (get(remoteTarget)) return 'DeepSeek Harness runs on this computer only, not in a remote workspace.';
  // Lazy: the update store pulls in the usage store, and this module sits on
  // the orchestrator's import path, where a new static edge shifts load order.
  const { isAgentUpdating } = await import('$lib/stores/agentUpdates');
  if (isAgentUpdating(DEEPSEEK_HARNESS_COMMAND)) {
    return 'DeepSeek Harness is updating. Try again when the update finishes.';
  }
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
 * Open the DeepSeek Harness room on the active project, working in the
 * sidebar's selected worktree - exactly where every other agent launch starts.
 * A caller that knows the worktree (the "+" on a worktree row) names it:
 * `null` is the main checkout, a path one of the project's worktrees. The room
 * starts dsh and reports its own progress and problems; it resolves false when
 * it cannot open, and the reason has been shown as a toast.
 */
export async function openDeepSeekHarnessPanel(opts: { worktreePath?: string | null } = {}): Promise<boolean> {
  if (get(remoteTarget)) {
    showToast('DeepSeek Harness runs on this computer only, not in a remote workspace.', 'warning');
    return false;
  }
  const project = get(activeProject);
  const projectId = get(activeProjectId);
  if (!project?.root_path || !projectId) {
    showToast('Open a project first: DeepSeek Harness works inside a project folder.', 'warning');
    return false;
  }
  const root = opts.worktreePath === undefined
    ? workingRootFor(projectId, project.root_path)
    : opts.worktreePath ?? project.root_path;
  setDeepSeekPlacement(projectId, sameFolder(root, project.root_path) ? null : root);
  const { useLayoutStore } = await import('$lib/stores/zustand/layout');
  useLayoutStore.getState().revealDeepSeek();
  return true;
}
