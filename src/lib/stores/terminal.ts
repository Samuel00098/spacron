import { writable, get } from '$lib/stores/storeCompat';
import { invoke } from '@tauri-apps/api/core';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import {
  attachPty,
  openPty,
  closeBackendSession,
  type PtySession,
} from '$lib/services/pty-bridge';
import {
  terminalShell,
  announceAgentCompletions,
  agentPermissionMode,
  agentCmdOverrides,
  agentDefaultArgs,
  agentDefaultEnv,
} from '$lib/stores/settings';
import {
  resolveAgentLaunchArgs,
  platformLaunchFlags,
  pasteLineBreak,
  resolveAgentLaunchCommand,
  resolveAgentLaunchEnv,
} from '$lib/services/agent-permissions';
import { playNudge } from '$lib/services/nudge';
import { showToast } from '$lib/stores/notification';
import { buildAgentCharter } from '$lib/services/orchestrator/agent-charter';
import {
  agentExecutable,
  agentReadsRulesFile,
  agentHasNativeExtras,
  ensureAgentRulesFiles,
} from '$lib/services/orchestrator/agent-rules-file';

/** Mirrors `DEEPSEEK_HARNESS_COMMAND`; the service is imported lazily here. */
function isDeepSeekHarnessCommand(command: string): boolean {
  return agentExecutable(command) === 'dsh';
}
import { ensureOrchestratorBrief } from '$lib/services/orchestrator/orchestrator-brief';
import { getCustomAgents } from '$lib/stores/customAgents';
import { recordAgentSpawn, forgetAgentSpawn } from '$lib/stores/activityStats';
import { agentSessionClosed } from '$lib/services/keep-awake';
import { forgetAgentTurnState, noteAgentLaunched, noteAgentLineSubmitted, noteAgentPrompted } from './agentTurnState';
import { accountEnvFor } from '$lib/stores/agentAccounts';
import { agentPanelImages } from '$lib/stores/agentPanelImages';
import { reclaimWorktree, type WorktreeInfo } from '$lib/services/orchestrator/worktree-manager';
import { forgetWorktree } from '$lib/services/orchestrator/worktree-reconciler';
import {
  getMcpUrl,
  injectMcpConfigForAgent,
  mcpLaunchFlags,
  prepareAgentChannel,
  bindAgentChannel,
  type AgentChannel,
  registerAgent,
  setMcpProjectRoot,
  unregisterAgent,
  BROWSER_STARTUP_TIMEOUT_MS,
  BROWSER_TOOL_TIMEOUT_MS,
} from './mcpBridge';
import { attachTurnSignals, prepareStatusChannel } from '$lib/services/orchestrator/agent-hook-signals';
import { readTerminalScreen } from '$lib/services/terminal-screen';
import { getActiveWorktreePath } from '$lib/stores/projectWorktrees';

export type TerminalSessionInfo = {
  id: number;
  projectId: string;
  title: string;
  // Title driven by the agent CLI's OSC escape sequences (what the tool reports
  // it is doing). Shown as the pane's main heading.
  paneTitle?: string | null;
  // Orchestrator-assigned human/assistant name (e.g. "Iris"). Kept separate from
  // paneTitle so the assistant name (a badge) and the live CLI title can coexist.
  agentName?: string | null;
  isRunning: boolean;
  isExecuting?: boolean;
  agentPreset?: string | null;
  briefed?: boolean;
  lastActivatedAt?: number;
  role?: string | null;
  // Internal background sessions (e.g. embedded status probes). Never take a
  // pane, never show in the session-tab bar, and their exit is silent.
  hidden?: boolean;
  cwd?: string | null;
  taskSummary?: string | null;
  lastExitCode?: number | null;
  // Orchestrator: id of the OrchestratorTask that currently owns this terminal
  // (single-agent lease). null/undefined = unowned / user-controlled.
  ownerTaskId?: string | null;
  // Isolated git worktree this agent runs in, when spawned outside the
  // orchestrator (e.g. the floating prompt bar). Orchestrator-dispatched agents
  // keep their worktree on the OrchestratorTask instead, so this stays unset for
  // them — that ownership split is what decides who cleans the worktree up.
  worktree?: WorktreeInfo | null;
};

// Keyed by the agent's launch command (see AI_AGENT_PRESETS in runs.ts), with a
// few natural-name aliases kept so display names resolve whether code passes the
// command id ("agy") or the spoken name ("antigravity").
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
  aider: 'Aider',
  agy: 'Antigravity',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  // The product name, not the command: the brand mark looks an unbundled
  // CLI's logo up by name, and "dsh" found nothing (or the wrong logo).
  dsh: 'DeepSeek Harness',
  pi: 'Pi',
  'cursor-agent': 'Cursor',
  // Legacy: the preset used to launch the bare `agent`. Sessions and stored
  // tasks from before the rename still carry it.
  agent: 'Cursor',
  cursor: 'Cursor',
  hermes: 'Hermes Agent',
  grok: 'Grok CLI',
};

export type GridLayout = 'single' | '2h' | '2v' | '3h' | '3v' | '4' | '9';

// A custom mosaic arrangement (columns of stacked cells, with their relative
// widths/heights) built by dragging/splitting panes. This is the source of
// truth for the *visible* terminal layout; `gridLayout` is only the named
// quick-pick label. Persisting the mosaic (not just the preset) lets a custom
// arrangement survive a TerminalPanel remount — e.g. when the workspace ambient
// mode switches (Focus / Split / Canvas / Preview) and React tears the panel
// down and rebuilds it elsewhere in the tree. null = "follow the named preset".
export type MosaicCell = { index: number };
export type MosaicColumn = { cells: MosaicCell[] };
export interface TerminalMosaic {
  columns: MosaicColumn[];
  colWidths: number[];
  cellHeights: number[][];
}

function cloneMosaic(mosaic: TerminalMosaic | null | undefined): TerminalMosaic | null {
  if (!mosaic) return null;
  return {
    columns: mosaic.columns.map((column) => ({ cells: column.cells.map((cell) => ({ ...cell })) })),
    colWidths: [...mosaic.colWidths],
    cellHeights: mosaic.cellHeights.map((heights) => [...heights]),
  };
}

export const sessions = writable<TerminalSessionInfo[]>([]);
export const activeSessionId = writable<number | null>(null);

export const devSessions = writable<TerminalSessionInfo[]>([]);
export const devActiveSessionId = writable<number | null>(null);
export const devPaneAssignments = writable<(number | null)[]>([null]);
export const devActivePaneIndex = writable<number>(0);
export const devGridLayout = writable<GridLayout>('single');
export const devTerminalMosaic = writable<TerminalMosaic | null>(null);

export const devSessionIds = new Set<number>();

// Session the floating prompt bar should target. Set whenever the user focuses a
// terminal pane (click / keyboard) so the bar follows the terminal in view, and
// from the bar's own target picker. null = no explicit target (fall back to auto).
export const manualPromptTargetId = writable<number | null>(null);

export type TerminalInputRequest = {
  sessionId: number;
  text: string;
};

export const terminalInputRequest = writable<TerminalInputRequest | null>(null);

export function requestTerminalInput(sessionId: number, text: string) {
  if (!text || text.trim() === '') return;
  terminalInputRequest.set({ sessionId, text });
}

// Inject text directly into the FloatingPromptBar textarea
export const promptBarInput = writable<string | null>(null);

// Inject an image directly into the FloatingPromptBar as an image chip
export const promptBarImage = writable<{ dataUrl: string; name: string } | null>(null);

// Bumped to request the FloatingPromptBar focus its textarea (e.g. when handing
// a session off to the user for manual input).
export const promptBarFocusRequest = writable(0);
export function focusPromptBar() {
  promptBarFocusRequest.update((n) => n + 1);
}

// Bumped to request the FloatingPromptBar launch agent voice mode.
export const promptBarVoiceModeRequest = writable(0);
export function launchPromptBarVoiceMode() {
  promptBarVoiceModeRequest.update((n) => n + 1);
}

// Command history store, persisted in localStorage
export const commandHistory = writable<string[]>(
  typeof window !== 'undefined'
    ? (() => {
        try {
          const parsed = JSON.parse(localStorage.getItem('forge_terminal_history') || '[]');
          return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
        } catch { return []; }
      })()
    : []
);

if (typeof window !== 'undefined') {
  commandHistory.subscribe((history) => {
    localStorage.setItem('forge_terminal_history', JSON.stringify(history));
  });
}

export function addHistoryEntry(cmd: string) {
  if (!cmd || cmd.trim() === '') return;
  if (cmd.length > 4096) return; // skip unusually long inputs (e.g. pasted blobs)
  commandHistory.update((hist) => {
    const filtered = hist.filter((x) => x !== cmd);
    return [cmd, ...filtered].slice(0, 100);
  });
}

// Grid layout: which format is the terminal area in
export const gridLayout = writable<GridLayout>('single');

// The live custom mosaic arrangement for the active project (null = the named
// `gridLayout` preset is in effect). The visible TerminalPanel reads this on
// mount so a hand-built split survives a remount; it writes back here whenever
// the user drags, splits or resizes panes.
export const terminalMosaic = writable<TerminalMosaic | null>(null);

// Which session IDs occupy each pane slot (null = empty/new terminal slot)
export const paneAssignments = writable<(number | null)[]>([null]);

// Which pane index is focused (receives keyboard)
export const activePaneIndex = writable<number>(0);

type TerminalProjectState = {
  sessions: TerminalSessionInfo[];
  activeSessionId: number | null;
  gridLayout: GridLayout;
  mosaic: TerminalMosaic | null;
  paneAssignments: (number | null)[];
  activePaneIndex: number;
};

function createDefaultProjectState(): TerminalProjectState {
  return {
    sessions: [],
    activeSessionId: null,
    gridLayout: 'single',
    mosaic: null,
    paneAssignments: [null],
    activePaneIndex: 0,
  };
}

function cloneProjectState(state: TerminalProjectState): TerminalProjectState {
  return {
    sessions: state.sessions.map((session) => ({ ...session })),
    activeSessionId: state.activeSessionId,
    gridLayout: state.gridLayout,
    mosaic: cloneMosaic(state.mosaic),
    paneAssignments: [...state.paneAssignments],
    activePaneIndex: state.activePaneIndex,
  };
}

const terminalProjectStates = new Map<string, TerminalProjectState>();

// Every non-dev session in EVERY project that has terminal state, not just the
// visible one. `sessions` only ever reflects the active project, so a UI driven
// by it must unmount a project's panes when you switch away — and unmounting a
// TerminalPane disposes its xterm, forcing a lossy reattach-by-replay when you
// come back. The room stage mounts from this list and merely HIDES the panes of
// background projects, so their terminals (and scrollback) stay live and
// correct. Each entry carries its own `projectId`.
export const allProjectSessions = writable<TerminalSessionInfo[]>([]);

// The same idea one level up: each project's WHOLE terminal state (sessions,
// pane assignments, mosaic, …). The terminal room mounts one TerminalPanel per
// open project and parks the inactive ones, and a parked panel reads its slice
// from here — the visible `paneAssignments`/`terminalMosaic`/… stores always
// describe the active project only.
export const projectTerminalStates = writable<Map<string, TerminalProjectState>>(new Map());
export const devProjectTerminalStates = writable<Map<string, TerminalProjectState>>(new Map());

function publishProjectTerminalStates(isDev = false) {
  const stateMap = isDev ? devTerminalProjectStates : terminalProjectStates;
  const snapshot = new Map<string, TerminalProjectState>();
  const out: TerminalSessionInfo[] = [];
  for (const [id, state] of stateMap) {
    if (!isDev) {
      for (const session of state.sessions) out.push({ ...session });
    }
    snapshot.set(id, cloneProjectState(state));
  }
  if (isDev) {
    devProjectTerminalStates.set(snapshot);
  } else {
    allProjectSessions.set(out);
    projectTerminalStates.set(snapshot);
  }
}

const terminalSessionProjects = new Map<number, string>();
// Project id → working-tree root, registered by the workspace store as projects
// open. Lets a session resolve its repo root for the rules-file brief even when
// it was created without an explicit cwd (e.g. a terminal opened with the
// default shell dir, then the user types `claude`/`codex` into it). Injected
// rather than imported to avoid a workspace↔terminal import cycle.
const terminalProjectRoots = new Map<string, string>();
let activeTerminalProjectId: string | null = null;
let activeDevTerminalProjectId: string | null = null;

const devTerminalProjectStates = new Map<string, TerminalProjectState>();

/** Record a project's working-tree root for rules-file brief resolution. */
export function setTerminalProjectRoot(projectId: string, rootPath: string) {
  if (!projectId || !rootPath) return;
  terminalProjectRoots.set(projectId, rootPath);
  // Every open path activates the project BEFORE registering its root (see
  // `setActiveProject` and `restoreProjectState`), so the activation's lookup
  // misses and pushes `null` to the MCP server — which then refuses every
  // `delegate_task` with "No project is open" for the rest of the session.
  // Pushing from here too makes the pair order-independent rather than relying
  // on three call sites staying in the right sequence.
  if (projectId === activeTerminalProjectId) setMcpProjectRoot(rootPath);
}

// Two independent places open the "you just opened this project" shell: the
// workspace restore (`restoreProjectState`) and TerminalPanel's auto-open
// effect. `createTerminalSession` is async, so a guard that checks the sessions
// store loses — both callers pass their check before either session registers,
// and every launch ended up with two terminals instead of one. This claim is
// synchronous, so exactly one caller wins.
//
// The claim is released on a timer rather than held forever: it only needs to
// cover the startup race, and a permanent claim would stop the panel from
// re-opening a shell later (e.g. you close every terminal, switch ambient mode
// and come back to an empty grid).
const STARTUP_SHELL_CLAIM_MS = 5000;
const startupShellClaims = new Map<string, number>();

/** True for the FIRST caller per project within the startup window. */
export function claimStartupShell(projectId: string | null | undefined): boolean {
  if (!projectId) return true;
  const now = Date.now();
  const claimedAt = startupShellClaims.get(projectId);
  if (claimedAt !== undefined && now - claimedAt < STARTUP_SHELL_CLAIM_MS) return false;
  startupShellClaims.set(projectId, now);
  return true;
}

/** Drop the claim so a later auto-open can run (used when sessions are torn down). */
export function releaseStartupShellClaim(projectId?: string | null) {
  if (projectId) startupShellClaims.delete(projectId);
  else startupShellClaims.clear();
}

function getProjectState(projectId: string, isDev = false): TerminalProjectState {
  const stateMap = isDev ? devTerminalProjectStates : terminalProjectStates;
  const existing = stateMap.get(projectId);
  if (existing) return existing;
  const created = createDefaultProjectState();
  stateMap.set(projectId, created);
  return created;
}

function setVisibleProjectState(state: TerminalProjectState, isDev = false) {
  const sessionsStore = isDev ? devSessions : sessions;
  const activeSessionIdStore = isDev ? devActiveSessionId : activeSessionId;
  const gridLayoutStore = isDev ? devGridLayout : gridLayout;
  const terminalMosaicStore = isDev ? devTerminalMosaic : terminalMosaic;
  const paneAssignmentsStore = isDev ? devPaneAssignments : paneAssignments;
  const activePaneIndexStore = isDev ? devActivePaneIndex : activePaneIndex;

  sessionsStore.set(state.sessions.map((session) => ({ ...session })));
  activeSessionIdStore.set(state.activeSessionId);
  gridLayoutStore.set(state.gridLayout);
  terminalMosaicStore.set(cloneMosaic(state.mosaic));
  paneAssignmentsStore.set([...state.paneAssignments]);
  activePaneIndexStore.set(state.activePaneIndex);
}

function updateProjectState(
  projectId: string,
  updater: (state: TerminalProjectState) => TerminalProjectState,
  isDev = false
) {
  const stateMap = isDev ? devTerminalProjectStates : terminalProjectStates;
  const next = updater(cloneProjectState(getProjectState(projectId, isDev)));
  stateMap.set(projectId, next);
  publishProjectTerminalStates(isDev);
  if (projectId === (isDev ? activeDevTerminalProjectId : activeTerminalProjectId)) {
    setVisibleProjectState(next, isDev);
  }
}

export function setActiveTerminalProject(projectId: string | null) {
  activeTerminalProjectId = projectId;
  activeDevTerminalProjectId = projectId;
  // Keep the MCP server pointed at the open project: `delegate_task` waits on a
  // file under its `.spacron/reports/`, and the server has no other way to know
  // where that is. Cleared with the project so a delegate call refuses rather
  // than waiting on a stale path.
  setMcpProjectRoot(projectId ? terminalProjectRoots.get(projectId) ?? null : null);
  if (!projectId) {
    setVisibleProjectState(createDefaultProjectState(), false);
    setVisibleProjectState(createDefaultProjectState(), true);
    return;
  }
  setVisibleProjectState(getProjectState(projectId, false), false);
  setVisibleProjectState(getProjectState(projectId, true), true);
}

export function getTerminalProjectState(projectId: string, isDev = false): TerminalProjectState {
  return cloneProjectState(getProjectState(projectId, isDev));
}

export function restoreTerminalProjectState(projectId: string, state: TerminalProjectState, isDev = false) {
  const stateMap = isDev ? devTerminalProjectStates : terminalProjectStates;
  stateMap.set(projectId, cloneProjectState(state));
  publishProjectTerminalStates(isDev);
  if ((isDev ? activeDevTerminalProjectId : activeTerminalProjectId) === projectId) {
    setVisibleProjectState(getProjectState(projectId, isDev), isDev);
  }
}

const ptyInstances = new Map<number, PtySession>();
// `text` is the chunk already decoded by appendSessionOutputBuffer. It is handed
// to the callback rather than left for it to decode again: the pane needs the
// same string for its OSC/dev-server/agent-attention scanning, and running a
// second stateful TextDecoder over every byte of every session bought nothing.
const dataCallbacks = new Map<number, (data: Uint8Array, text: string) => void>();
const exitCallbacks = new Map<number, (code: number) => void>();

// Project-independent exit broadcast. Unlike `exitCallbacks` (registered by the
// visible TerminalPane and torn down when the pane unmounts) and the `sessions`
// store (which only ever reflects the active project), these listeners fire for
// EVERY session exit in EVERY project. The orchestrator uses this so an agent
// that exits while its project is in the background is still reconciled instead
// of being stranded in-progress until the user reopens that project.
export type SessionExitInfo = { sessionId: number; projectId: string; code: number };
const sessionExitListeners = new Set<(info: SessionExitInfo) => void>();
export function onSessionExit(listener: (info: SessionExitInfo) => void): () => void {
  sessionExitListeners.add(listener);
  return () => sessionExitListeners.delete(listener);
}

// Sessions the orchestrator owns — leased tasks and adopted agents. Their exits
// surface as completion cards in the inbox, so the generic "finished its work"
// exit toast below is suppressed for them: one notification per exit, and the
// card is the durable one. The orchestrator marks a session when it leases or
// adopts it; ids are never reused, so entries are never removed.
const orchestratorTrackedSessions = new Set<number>();
export function markOrchestratorTrackedSession(sessionId: number): void {
  orchestratorTrackedSessions.add(sessionId);
}
export function isOrchestratorTrackedSession(sessionId: number): boolean {
  return orchestratorTrackedSessions.has(sessionId);
}
/** Call ONLY when the orchestrator deliberately stops tracking a session
 *  (unlink / delete), so a later exit of the now-untracked terminal gets its
 *  normal exit toast again. NOT called on turn completion — a card has already
 *  landed there, so the exit toast must stay suppressed. */
export function unmarkOrchestratorTrackedSession(sessionId: number): void {
  orchestratorTrackedSessions.delete(sessionId);
}

// Project-independent "agent launched" broadcast. Fires when a manually-typed
// command is recognized as an AI agent CLI — the typed-launch path only, NOT an
// orchestrator/floating-bar spawn (those manage their own bookkeeping). The
// orchestrator listens so it can *adopt* agents it didn't spawn itself:
// surface them in its running-agents list, read their terminal, and route
// follow-ups / close to them. Mirrors the `onSessionExit` channel so background
// projects are covered too.
export type AgentDetectedInfo = { sessionId: number; projectId: string; preset: string };
const agentDetectedListeners = new Set<(info: AgentDetectedInfo) => void>();
export function onAgentDetected(listener: (info: AgentDetectedInfo) => void): () => void {
  agentDetectedListeners.add(listener);
  return () => agentDetectedListeners.delete(listener);
}
// A session's recent output, held as the list of chunks it arrived in rather
// than as one repeatedly re-sliced string.
//
// `parts` are the decoded chunks still inside the window, oldest first; `len` is
// their combined length and is kept at or under MAX_SESSION_BUFFER_CHARS by
// trimming on append, so it always equals the length of the string
// getSessionOutputBuffer() returns. `joined` memoises that string until the next
// append dirties it.
// `produced` is the total number of chars this session has EVER emitted. `len`
// plateaus at MAX_SESSION_BUFFER_CHARS once the window fills, so it stops being
// a usable "is this agent still working?" signal after a couple of minutes;
// `produced` never stops growing, which is what the worktree pollers back off
// against.
type SessionOutput = { parts: string[]; len: number; produced: number; joined: string | null };
const sessionOutputBuffers = new Map<number, SessionOutput>();
const sessionOutputDecoders = new Map<number, TextDecoder>();
const sessionInputBuffers = new Map<number, string>();
const agentLaunchStartLengths = new Map<number, number>();
const MAX_SESSION_BUFFER_CHARS = 250000;

// Maps a launched executable (the first real token of a command, basename
// only) to the agent preset it represents. Detection keys off the executable
// name — NOT any word appearing in the line — so subcommands/arguments like
// `pi agent ...` aren't misattributed to Cursor's bare `agent` CLI.
const AGENT_COMMAND_EXECUTABLES: Array<{ preset: string; names: string[] }> = [
  { preset: 'codex', names: ['codex'] },
  { preset: 'claude', names: ['claude', 'claude-code'] },
  { preset: 'opencode', names: ['opencode'] },
  { preset: 'pi', names: ['pi'] },
  { preset: 'antigravity', names: ['agy', 'antigravity'] },
  { preset: 'aider', names: ['aider'] },
  { preset: 'cursor',      names: ['cursor-agent', 'cursor', 'agent'] },
  { preset: 'hermes',      names: ['hermes'] },
  { preset: 'grok',        names: ['grok'] },
];

// Tokens that wrap the real command and should be skipped when locating the
// executable (e.g. `npx claude`, `sudo aider`, `FOO=bar codex`).
const COMMAND_LAUNCHER_PREFIXES = new Set([
  'npx',
  'bunx',
  'pnpx',
  'sudo',
  'command',
  'exec',
  'time',
  'nice',
]);

// Extracts the basename of the executable being launched, stripping a leading
// PowerShell call operator, env-var assignments, launcher prefixes, any path,
// and a Windows executable extension.
function extractExecutable(command: string): string | null {
  const tokens = command
    .trim()
    .replace(/^&\s*/, '')
    .split(/\s+/)
    .filter(Boolean);

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i++;
      continue;
    }
    if (COMMAND_LAUNCHER_PREFIXES.has(token.toLowerCase())) {
      i++;
      continue;
    }
    break;
  }

  const exe = tokens[i];
  if (!exe) return null;

  const base = exe.split(/[\\/]/).pop() ?? exe;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

export function getLayoutPaneCount(layout: GridLayout): number {
  if (layout === 'single') return 1;
  if (layout === '3h' || layout === '3v') return 3;
  if (layout === '4') return 4;
  if (layout === '9') return 9;
  return 2;
}

export function setGridLayout(layout: GridLayout, isDev = false) {
  const projectId = isDev ? activeDevTerminalProjectId : activeTerminalProjectId;
  const count = getLayoutPaneCount(layout);
  if (!projectId) {
    const gridLayoutStore = isDev ? devGridLayout : gridLayout;
    const terminalMosaicStore = isDev ? devTerminalMosaic : terminalMosaic;
    const paneAssignmentsStore = isDev ? devPaneAssignments : paneAssignments;
    const activePaneIndexStore = isDev ? devActivePaneIndex : activePaneIndex;

    gridLayoutStore.set(layout);
    // Picking a named preset replaces any hand-built arrangement.
    terminalMosaicStore.set(null);
    paneAssignmentsStore.update((current) => {
      const updated = [...current];
      while (updated.length < count) updated.push(null);
      return updated.slice(0, count);
    });
    activePaneIndexStore.update((i) => Math.min(i, count - 1));
    return;
  }

  updateProjectState(projectId, (state) => {
    const paneAssignments = [...state.paneAssignments];
    while (paneAssignments.length < count) paneAssignments.push(null);
    return {
      ...state,
      gridLayout: layout,
      mosaic: null,
      paneAssignments: paneAssignments.slice(0, count),
      activePaneIndex: Math.min(state.activePaneIndex, count - 1),
    };
  }, isDev);
}

// Persist a hand-built mosaic arrangement for the active project. The visible
// store keeps the exact object passed in (so the panel's own writes don't
// thrash its local state); the per-project copy is cloned so switching projects
// can't mutate it from under us.
export function setTerminalMosaic(mosaic: TerminalMosaic | null, isDev = false) {
  const projectId = isDev ? activeDevTerminalProjectId : activeTerminalProjectId;
  if (projectId) {
    getProjectState(projectId, isDev).mosaic = cloneMosaic(mosaic);
  }
  const terminalMosaicStore = isDev ? devTerminalMosaic : terminalMosaic;
  terminalMosaicStore.set(mosaic);
}

export function assignToPane(paneIdx: number, sessionId: number | null, isDev = false) {
  const projectId = isDev ? activeDevTerminalProjectId : activeTerminalProjectId;
  if (!projectId) {
    const paneAssignmentsStore = isDev ? devPaneAssignments : paneAssignments;
    paneAssignmentsStore.update((p) => {
      const copy = [...p];
      copy[paneIdx] = sessionId;
      return copy;
    });
    return;
  }

  updateProjectState(projectId, (state) => {
    const paneAssignments = [...state.paneAssignments];
    paneAssignments[paneIdx] = sessionId;
    return { ...state, paneAssignments };
  }, isDev);
}

export function swapPanes(from: number, to: number, isDev = false) {
  if (from === to) return;
  const projectId = isDev ? activeDevTerminalProjectId : activeTerminalProjectId;
  if (!projectId) {
    const paneAssignmentsStore = isDev ? devPaneAssignments : paneAssignments;
    paneAssignmentsStore.update((p) => {
      const copy = [...p];
      if (from < 0 || to < 0 || from >= copy.length || to >= copy.length) return p;
      [copy[from], copy[to]] = [copy[to], copy[from]];
      return copy;
    });
    return;
  }

  updateProjectState(projectId, (state) => {
    const copy = [...state.paneAssignments];
    if (from < 0 || to < 0 || from >= copy.length || to >= copy.length) return state;
    [copy[from], copy[to]] = [copy[to], copy[from]];
    return { ...state, paneAssignments: copy };
  }, isDev);
}

export function focusPane(paneIdx: number, isDev = false) {
  const projectId = isDev ? activeDevTerminalProjectId : activeTerminalProjectId;
  if (!projectId) {
    const activePaneIndexStore = isDev ? devActivePaneIndex : activePaneIndex;
    const paneAssignmentsStore = isDev ? devPaneAssignments : paneAssignments;
    if (get(activePaneIndexStore) !== paneIdx) {
      activePaneIndexStore.set(paneIdx);
    }
    const panes = get(paneAssignmentsStore);
    if (panes[paneIdx] !== null) {
      activateSessionInPane(panes[paneIdx]!);
    }
    // Focusing a pane makes its terminal the prompt-bar target.
    if (get(manualPromptTargetId) !== panes[paneIdx]) {
      manualPromptTargetId.set(panes[paneIdx]);
    }
    return;
  }

  updateProjectState(projectId, (state) => (
    state.activePaneIndex === paneIdx ? state : { ...state, activePaneIndex: paneIdx }
  ), isDev);
  const panes = getProjectState(projectId, isDev).paneAssignments;
  if (panes[paneIdx] !== null) {
    activateSessionInPane(panes[paneIdx]!);
  }
  // Focusing a pane makes its terminal the prompt-bar target.
  if (get(manualPromptTargetId) !== panes[paneIdx]) {
    manualPromptTargetId.set(panes[paneIdx]);
  }
}

export function setActiveSession(id: number) {
  activateSessionInPane(id);
  // Explicitly selecting a terminal makes it the prompt-bar target.
  manualPromptTargetId.set(id);
}

export function activateSessionInPane(id: number) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;

  updateProjectState(projectId, (state) => {
    const idx = state.paneAssignments.indexOf(id);
    const nextActivePaneIndex = idx !== -1 ? idx : state.activePaneIndex;
    if (state.activeSessionId === id && state.activePaneIndex === nextActivePaneIndex) {
      return state;
    }
    return {
      ...state,
      activePaneIndex: nextActivePaneIndex,
      activeSessionId: id,
      sessions: state.sessions.map((session) => (
        session.id === id
          ? { ...session, lastActivatedAt: Date.now() }
          : session
      )),
    };
  }, isDev);
}

export function registerDataCallback(id: number, cb: (data: Uint8Array, text: string) => void) {
  dataCallbacks.set(id, cb);
}

export function unregisterDataCallback(id: number) {
  dataCallbacks.delete(id);
}

export function registerExitCallback(id: number, cb: (code: number) => void) {
  exitCallbacks.set(id, cb);
}

export function unregisterExitCallback(id: number) {
  exitCallbacks.delete(id);
}

function detectAgentPresetFromCommand(command: string): string | null {
  const executable = extractExecutable(command);
  if (!executable) return null;

  for (const { preset, names } of AGENT_COMMAND_EXECUTABLES) {
    if (names.includes(executable)) return preset;
  }

  // User-defined agents: match on the executable of their stored launch command
  // (so typing `aider` adopts a custom "aider --flag" agent). The preset key is
  // the custom agent's full command, matching what the spawn path records, so
  // display-name and rules-file lookups resolve consistently.
  for (const agent of getCustomAgents()) {
    if (extractExecutable(agent.command) === executable) return agent.command;
  }

  return null;
}

// Sessions whose programmatic launch write must NOT re-trigger agent-command
// detection: spawnAgentPreset already records the preset (and the caller's
// explicit briefed flag) itself, so letting its own `writeToSession(command)`
// run through detection would clobber that flag and double-schedule the brief.
const suppressAgentDetection = new Set<number>();

/**
 * Temporarily suppress typed-command agent detection on a session.
 * Used during programmatic writes so the CLI command doesn't trigger
 * auto-detection state changes.
 */
export function suppressSessionAgentDetection(id: number): () => void {
  suppressAgentDetection.add(id);
  return () => {
    suppressAgentDetection.delete(id);
  };
}

// Processes raw input sent to a session (manual keystrokes and programmatic
// writes alike) to (a) auto-detect when an AI agent CLI is launched and
// (b) flag the session as "executing" the moment a non-empty command is
// submitted. The executing flag is cleared by TerminalPane once the command's
// output goes idle, giving us a live "in use" signal for manually-typed
// commands — not just prompt-bar/agent runs.
/**
 * The text of a typed line, without the printable halves of escape sequences
 * the input buffer keeps once their ESC byte is dropped: bracketed-paste
 * markers (`[200~`, `[201~`) and arrow/navigation keys (`[A`, `[1;5C`, ...).
 */
function typedLine(buffer: string): string {
  return buffer.replace(/\[20[01]~/g, '').replace(/\[[0-9;]*[A-Za-z~]/g, '').trim();
}

function processSessionInput(id: number, data: string) {
  let buffer = sessionInputBuffers.get(id) ?? '';
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      const command = buffer.trim();
      if (command) {
        const preset = detectAgentPresetFromCommand(buffer);
        // A line the user submitted to a running agent is a prompt. xterm
        // sends the Enter key as its own write, while everything Spacron types
        // itself (launch lines, charters, auto-answers) arrives as one
        // `text\r` chunk, so a lone Enter is what tells the two apart.
        if (!preset && data === '\r' && findSessionAnyProject(id)?.agentPreset) {
          noteAgentLineSubmitted(id, typedLine(buffer));
        }
        if (preset && !suppressAgentDetection.has(id)) {
          // A fresh launch starts idle, whatever the pane ran before.
          noteAgentLaunched(id);
          agentLaunchStartLengths.set(id, getSessionOutputLength(id));
          markSessionAgentPreset(id, preset);
          // Broadcast a genuine typed launch so the orchestrator can adopt it.
          // Skip panes already leased by the orchestrator (it tracks those via
          // its own task model). `suppressAgentDetection` already excludes the
          // programmatic writes spawnAgentPreset makes, so this is user typing.
          const detectedProjectId = terminalSessionProjects.get(id);
          if (detectedProjectId) {
            const isDev = devSessionIds.has(id);
            const detectedSession = getProjectState(detectedProjectId, isDev).sessions.find((s) => s.id === id);
            if (!detectedSession?.ownerTaskId) {
              for (const listener of agentDetectedListeners) {
                try { listener({ sessionId: id, projectId: detectedProjectId, preset }); }
                catch (err) { console.error('Agent detected listener failed:', err); }
              }
            }
          }
        }
        // A real command was just submitted — mark the shell busy so agent
        // runs won't target a terminal that's actively running something.
        setSessionExecuting(id, true);
      }
      buffer = '';
      continue;
    }
    if (ch === '\b' || ch === '\u007f') {
      buffer = buffer.slice(0, -1);
      continue;
    }
    if (ch >= ' ') {
      buffer += ch;
      if (buffer.length > 512) {
        buffer = buffer.slice(-512);
      }
    }
  }
  sessionInputBuffers.set(id, buffer);
}

// Append one chunk of a session's output, and return the decoded text so the
// caller can hand it to listeners instead of decoding the same bytes twice.
//
// This used to be `buffer = (buffer + text).slice(-MAX)`. That is two full
// copies of the whole window per chunk, and the pty layer coalesces at 15 ms /
// 8 KB, so a busy agent delivers up to ~66 chunks a second. While the buffer is
// still filling that is cheap; once it reaches MAX_SESSION_BUFFER_CHARS — a
// couple of minutes of a working agent — every later chunk pays the full price,
// forever, because the buffer never shrinks back below the cap again. Measured
// cost of one second of streaming output: 0.5 ms with a fresh buffer, 32 ms for
// a single session at the cap, 184 ms across six sessions at the cap. That is
// the "fine at first, then everything lags once the agents have been running a
// while" behaviour, and it is paid on the main thread, ahead of rendering.
//
// Appending is now O(chunk): push the chunk, then drop leading chunks that have
// fallen out of the window. Only the first surviving chunk is ever sliced, and
// it is one pty chunk rather than the whole 250k window.
function appendSessionOutputBuffer(id: number, bytes: Uint8Array): string {
  const decoder = sessionOutputDecoders.get(id) ?? new TextDecoder();
  sessionOutputDecoders.set(id, decoder);
  const text = decoder.decode(bytes, { stream: true });
  if (!text) return '';

  let entry = sessionOutputBuffers.get(id);
  if (!entry) {
    entry = { parts: [], len: 0, produced: 0, joined: null };
    sessionOutputBuffers.set(id, entry);
  }

  entry.parts.push(text);
  entry.len += text.length;
  entry.produced += text.length;
  entry.joined = null;

  // Drop whole chunks that are entirely outside the window, then trim whatever
  // still overhangs off the front of the oldest surviving chunk.
  while (entry.parts.length > 1 && entry.len - entry.parts[0].length >= MAX_SESSION_BUFFER_CHARS) {
    entry.len -= entry.parts[0].length;
    entry.parts.shift();
  }
  if (entry.len > MAX_SESSION_BUFFER_CHARS) {
    const overflow = entry.len - MAX_SESSION_BUFFER_CHARS;
    entry.parts[0] = entry.parts[0].slice(overflow);
    entry.len -= overflow;
  }

  return text;
}

export function getSessionOutputBuffer(id: number): string {
  const entry = sessionOutputBuffers.get(id);
  if (!entry) return '';
  if (entry.joined === null) entry.joined = entry.parts.join('');
  return entry.joined;
}

/**
 * The last `chars` characters of the buffer, built from only the chunks that
 * reach back that far.
 *
 * `getSessionOutputBuffer(id).slice(-n)` joins the whole 250k window to throw
 * almost all of it away, and every append drops the `joined` memo — so a caller
 * that wants a 2 KB tail on a timer rebuilds a quarter-megabyte string on every
 * tick, per session. The scanners that watch a working agent do exactly that
 * several times a second, so the waste multiplies by the number of agents
 * running, which is the case this exists for.
 */
export function getSessionOutputTail(id: number, chars: number): string {
  const entry = sessionOutputBuffers.get(id);
  if (!entry || chars <= 0) return '';
  if (chars >= entry.len) return getSessionOutputBuffer(id);
  const picked: string[] = [];
  let have = 0;
  for (let i = entry.parts.length - 1; i >= 0 && have < chars; i -= 1) {
    picked.push(entry.parts[i]);
    have += entry.parts[i].length;
  }
  return picked.reverse().join('').slice(-chars);
}

/**
 * Everything appended after index `from` (an earlier {@link getSessionOutputLength}
 * reading), or `''` when nothing has been. O(what was added) rather than O(window),
 * for the same reason as {@link getSessionOutputTail}.
 *
 * When the window has slid past `from` — the buffer trimmed away output the
 * caller had not read yet — the whole surviving window is returned, matching
 * what `getSessionOutputBuffer(id).slice(from)` would have produced in spirit:
 * everything still available. Callers that care about the distinction compare
 * lengths themselves, exactly as they did before.
 */
export function getSessionOutputSince(id: number, from: number): string {
  const entry = sessionOutputBuffers.get(id);
  if (!entry) return '';
  if (from <= 0) return getSessionOutputBuffer(id);
  if (from >= entry.len) return '';
  return getSessionOutputTail(id, entry.len - from);
}

/**
 * Total characters this session has produced since it started — monotonic, and
 * unaffected by the buffer window sliding. Poll loops use it to tell "this agent
 * is still working" from "this agent has been idle", which
 * {@link getSessionOutputLength} cannot do once the window is full.
 */
export function getSessionOutputProduced(id: number): number {
  return sessionOutputBuffers.get(id)?.produced ?? 0;
}

/**
 * Length of what {@link getSessionOutputBuffer} would return, without building
 * the string. The polling loops that only compare growth (prompt echo, submit
 * confirmation, agent-ready detection) run every 60–120 ms, so joining a 250k
 * window just to read `.length` is pure waste.
 */
export function getSessionOutputLength(id: number): number {
  return sessionOutputBuffers.get(id)?.len ?? 0;
}

// Label a session carried at the moment it was closed, kept only until its pty
// actually exits.
//
// `killSession` removes the session from its project state synchronously and
// only *then* closes the pty, so by the time the exit event reaches
// `handlePtyExit` there is nothing left to look up. The toast used to fall back
// to `Terminal ${id}` — but `id` is the pty manager's process-wide counter, not
// the per-project number on the tab. Closing the first terminal of the day's
// tenth project announced "Terminal 31 closed" while the tab said "Terminal 1".
// Capturing the label at close time keeps the message saying what the user was
// actually looking at, in every project.
const closingSessions = new Map<number, { label: string; hidden: boolean }>();

function handlePtyExit(id: number, owningProjectId: string, code: number) {
  const isDev = devSessionIds.has(id);
  const sessionProjectId = terminalSessionProjects.get(id) ?? owningProjectId;
  const state = getProjectState(sessionProjectId, isDev);
  const session = state.sessions.find((x) => x.id === id);
  const closing = closingSessions.get(id);
  exitCallbacks.get(id)?.(code);
  updateProjectState(sessionProjectId, (current) => ({
    ...current,
    sessions: current.sessions.map((x) => (
      x.id === id ? { ...x, isRunning: false, lastExitCode: code } : x
    )),
  }), isDev);
  // Broadcast to project-independent listeners (e.g. the orchestrator's
  // task reconciler) so background-project exits are handled too.
  for (const listener of sessionExitListeners) {
    try { listener({ sessionId: id, projectId: sessionProjectId, code }); }
    catch (err) { console.error('Session exit listener failed:', err); }
  }
  const visibleSessions = sessionProjectId === (isDev ? activeDevTerminalProjectId : activeTerminalProjectId) ? get(isDev ? devSessions : sessions) : state.sessions;
  const label = session
    ? getSessionLabel(session, visibleSessions)
    : closing?.label ?? 'Terminal';
  // Map membership means `killSession` initiated this teardown. A killed pty
  // frequently reports a non-zero exit code, so classifying by code alone
  // announced every deliberate close as "process died".
  const wasKilled = closingSessions.delete(id);
  const isAgent = isAgentSession(session);
  const clean = code === 0;

  // A dead process is not working, whatever its turn watcher still believes.
  // The watcher normally releases its own hold, but a process that dies without
  // the watch noticing would otherwise keep the machine awake for nothing.
  agentSessionClosed(id);
  forgetAgentTurnState(id);

  if (session?.hidden || closing?.hidden) {
    // Hidden sessions (background probes) are invisible by contract: no pane,
    // no tab, and no exit announcement.
  } else if (isAgent) {
    // Exit is the other way an agent's work ends (the turn watcher covers agents
    // that stay in their REPL). Pair the chime with the completion card the
    // orchestrator writes on exit, so the cue is the same however the agent was
    // started and however it ended.
    // Never chime a completion for a terminal the USER closed: they did it,
    // they know, and a "done" cue there is the app claiming an agent finished
    // work that was cancelled out from under it.
    if (!wasKilled && get(announceAgentCompletions)) {
      playNudge(clean ? 'done' : 'failed');
    }
    // Orchestrator-tracked sessions (leased/adopted) already get a completion
    // card in the inbox on exit — the card is the notification. Only untracked
    // agent terminals — a CLI run by hand and never adopted — get the toast.
    if (!isOrchestratorTrackedSession(id)) {
      if (wasKilled) {
        showToast(`${label} closed`, 'info', 3000, true);
      } else if (clean) {
        // "Exited", not "finished its work". A clean exit is the process
        // ending — which is also what `/exit`, Ctrl-D and a finished session
        // all look like. Claiming completion from it is the same false alarm
        // as claiming it from an idle screen.
        showToast(`${label} exited`, 'info', 5000, true);
      } else {
        showToast(`${label} exited with errors (code ${code})`, 'error', 8000, true);
      }
    }
  } else if (wasKilled || clean) {
    showToast(`${label} closed`, 'info', 3000, true);
  } else {
    showToast(`${label} process died (exit ${code})`, 'error', 6000, true);
  }

  // Unregister from MCP server so other agents stop seeing it
  unregisterAgent(id).catch((e) =>
    console.error('Failed to unregister agent from MCP server:', e),
  );
}

function registerPtySession(
  pty: PtySession,
  owningProjectId: string,
  cwd?: string | null,
  targetPaneIndex?: number,
  metadata: RestoredSessionMetadata = {},
  assignPane = true,
  isDev = false
) {
  ptyInstances.set(pty.id, pty);
  terminalSessionProjects.set(pty.id, owningProjectId);
  if (isDev) devSessionIds.add(pty.id);

  const existing = getProjectState(owningProjectId, isDev).sessions.find((session) => session.id === pty.id);
  const agentPreset = metadata.agentPreset ?? existing?.agentPreset ?? null;
  // Shells and agents are numbered/named from DISJOINT pools. Counting agents
  // toward `Terminal N` made the two bleed together: a spawned agent with no
  // explicit title landed as "Terminal 1", and the user's first real shell then
  // came up as "Terminal 2". Agents fall back to their tool's display name and
  // never take a terminal number; shells count only other shells. Hidden
  // sessions (background probes) are invisible, so they count toward nothing.
  const shellCount = getProjectState(owningProjectId, isDev).sessions
    .filter((session) => !isAgentSession(session) && !session.hidden).length;
  const fallbackTitle = agentPreset
    ? getAgentDisplayName(agentPreset) ?? agentPreset
    : `Terminal ${shellCount + 1}`;
  const info: TerminalSessionInfo = {
    id: pty.id,
    projectId: owningProjectId,
    title: metadata.title?.trim() || existing?.title || fallbackTitle,
    paneTitle: metadata.paneTitle ?? existing?.paneTitle ?? null,
    agentName: metadata.agentName ?? existing?.agentName ?? null,
    isRunning: true,
    isExecuting: false,
    agentPreset,
    briefed: agentPreset ? false : existing?.briefed,
    lastExitCode: null,
    lastActivatedAt: Date.now(),
    role: metadata.role ?? existing?.role ?? (agentPreset ? 'Agent' : null),
    cwd: cwd ?? existing?.cwd ?? null,
    taskSummary: metadata.taskSummary ?? existing?.taskSummary ?? null,
    ownerTaskId: existing?.ownerTaskId ?? null,
    worktree: metadata.worktree ?? existing?.worktree ?? null,
    hidden: metadata.hidden ?? existing?.hidden ?? false,
  };

  updateProjectState(owningProjectId, (state) => ({
    ...state,
    sessions: existing
      ? state.sessions.map((session) => (session.id === pty.id ? info : session))
      : [...state.sessions, info],
    // Hidden sessions stay out of the way entirely — they must not steal the
    // active highlight from the terminal the user is actually looking at.
    activeSessionId: info.hidden ? state.activeSessionId : pty.id,
  }), isDev);

  // Register with MCP server so other agents can discover this one
  if (info.agentPreset && info.agentName) {
    registerAgent(info.id, info.agentName, info.agentPreset, getSessionLabel(info, [info]), info.worktree?.branch).catch((e) =>
      console.error('Failed to register agent with MCP server:', e),
    );
  }

  // Agent rooms (assignPane: false) live in `sessions` but never take a slot in
  // the user's personal terminal mosaic — assigning one would render its cell as
  // an empty "Agent is open as a panel" pane instead of the agent itself.
  if (!assignPane) return;

  updateProjectState(owningProjectId, (state) => {
    const paneAssignments = [...state.paneAssignments];
    let nextActivePaneIndex = state.activePaneIndex;
    if (targetPaneIndex !== undefined && targetPaneIndex >= 0) {
      while (paneAssignments.length <= targetPaneIndex) paneAssignments.push(null);
      paneAssignments[targetPaneIndex] = pty.id;
      nextActivePaneIndex = targetPaneIndex;
    } else if (!paneAssignments.includes(pty.id)) {
      const emptyIdx = paneAssignments.findIndex((p) => p === null);
      if (emptyIdx !== -1) {
        paneAssignments[emptyIdx] = pty.id;
        nextActivePaneIndex = emptyIdx;
      } else {
        paneAssignments.push(pty.id);
        nextActivePaneIndex = paneAssignments.length - 1;
      }
    }
    return {
      ...state,
      paneAssignments,
      activePaneIndex: nextActivePaneIndex,
    };
  }, isDev);
}

// Looks a session up in its OWNING project's state, not just the visible
// `sessions` store (which only reflects the active project). Prompt delivery
// must see the agent preset of a session living in a background project too —
// missing it would silently downgrade a TUI agent to the plain-shell send path.
function findSessionAnyProject(id: number): TerminalSessionInfo | undefined {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  const pool = projectId ? getProjectState(projectId, isDev).sessions : get(isDev ? devSessions : sessions);
  return pool.find((s) => s.id === id);
}

/**
 * The last grid an on-screen pane actually measured, and the storage key it
 * survives a restart under.
 *
 * ## Why this exists
 *
 * A PTY has to be opened with *some* size before any pane exists to measure,
 * and that used to be a hardcoded 120x34. The shell (and worse, a TUI agent)
 * draws its first frame at that size, then the pane finishes laying out, xterm
 * fits, `term.onResize` fires, and `resizeSession` sends the real grid. The
 * process gets SIGWINCH and reflows everything it had already painted — the
 * visible "opens wrong, then snaps" flicker on every new terminal.
 *
 * Threading an explicit size in from the call sites does not fix it: there are
 * ~20 of them (command palette, snapshots, workspace restore, the orchestrator)
 * and almost none own a DOM node to measure. So the default itself is what has
 * to be right. Any pane that fits successfully records its grid here, and the
 * next spawn opens at that size — which, since panes in one window are usually
 * the same size, is normally exact. Persisting it means even the first terminal
 * after a restart opens at the size the last one ended at, instead of 120x34.
 *
 * `initialCols` / `initialRows` on the options still win when a caller genuinely
 * knows better; this is only the fallback.
 */
const TERMINAL_GEOMETRY_KEY = 'forge_terminal_geometry';
const FALLBACK_COLS = 120;
const FALLBACK_ROWS = 34;
/** Guards against a collapsed or mid-animation pane poisoning the default. */
const MIN_SANE_COLS = 20;
const MIN_SANE_ROWS = 5;

let lastMeasuredGeometry: { cols: number; rows: number } | null = null;

/**
 * Publish the grid a pane just measured. Called from the fit path in
 * `TerminalPane`, which is the only place that knows a real cell size.
 */
export function recordTerminalGeometry(cols: number, rows: number): void {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  if (cols < MIN_SANE_COLS || rows < MIN_SANE_ROWS) return;
  const next = { cols: Math.floor(cols), rows: Math.floor(rows) };
  if (lastMeasuredGeometry?.cols === next.cols && lastMeasuredGeometry?.rows === next.rows) return;
  lastMeasuredGeometry = next;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TERMINAL_GEOMETRY_KEY, JSON.stringify(next));
  } catch {}
}

/** Size to open a new PTY at: measured this session, else last session's, else the fallback. */
function defaultSpawnGeometry(): { cols: number; rows: number } {
  if (lastMeasuredGeometry) return lastMeasuredGeometry;
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(TERMINAL_GEOMETRY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { cols?: unknown; rows?: unknown };
        const cols = Number(parsed.cols);
        const rows = Number(parsed.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_SANE_COLS && rows >= MIN_SANE_ROWS) {
          lastMeasuredGeometry = { cols: Math.floor(cols), rows: Math.floor(rows) };
          return lastMeasuredGeometry;
        }
      }
    } catch {}
  }
  return { cols: FALLBACK_COLS, rows: FALLBACK_ROWS };
}

/** Test seam: forget the measured grid so a case can assert the fallback. */
export function __resetTerminalGeometry(): void {
  lastMeasuredGeometry = null;
}

/**
 * xterm is always a dark terminal surface, even while the surrounding app is
 * using a light theme. Advertise that real surface to child processes and
 * expose the color capability xterm actually supports, so agent TUIs keep
 * their own borders, prompts, and status colors instead of choosing a pale or
 * reduced-color palette that disappears against the terminal well.
 */
function buildTerminalColorEnv(extraEnv?: Record<string, string>): Record<string, string> {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLAUDE_CODE_THEME: 'dark',
    THEME: 'dark',
    COLORFGBG: '15;0',
    ...(extraEnv ?? {}),
  };
}

export async function createTerminalSession(
  cwd?: string,
  targetPaneIndex?: number,
  projectId?: string,
  opts?: {
    assignPane?: boolean;
    agentPreset?: string | null;
    isDev?: boolean;
    /** Extra environment for this session only, merged over the defaults. */
    extraEnv?: Record<string, string>;
    initialCols?: number;
    initialRows?: number;
    /** Hidden background session — no pane, no tab, silent exit. */
    hidden?: boolean;
  }
): Promise<number | null> {
  const assignPane = opts?.assignPane ?? true;
  const agentPreset = opts?.agentPreset ?? null;
  const isDev = opts?.isDev ?? false;
  try {
    let pty: PtySession;
    const owningProjectId = projectId ?? (isDev ? activeDevTerminalProjectId : activeTerminalProjectId);
    if (!owningProjectId) {
      console.warn('Cannot create terminal session without an active project');
      return null;
    }

    // No explicit folder: start in the project's active worktree (the row the
    // user selected in the sidebar), else the project root. Restores and agent
    // spawns pass their own cwd and are unaffected.
    const resolvedCwd = cwd
      ?? (isDev ? null : getActiveWorktreePath(owningProjectId))
      ?? terminalProjectRoots.get(owningProjectId);
 
    const env = buildTerminalColorEnv(opts?.extraEnv);

    // Both bound to the PTY once it exists — see SPACRON_AGENT_TOKEN and
    // SPACRON_TURN_FILE below.
    let agentChannel: AgentChannel | null = null;
    let statusChannel: { channelId: string; path: string } | null = null;
    // Inject MCP server config when launching an agent so it auto-discovers
    // other running agents via the Spacron MCP bridge.
    if (agentPreset) {
      try {
        // Carries the `?token=` the MCP server requires — never rebuild this URL
        // from the bare port, or the agent connects unauthenticated and loses
        // every cross-agent tool.
        const mcpUrl = await getMcpUrl();

        // Generic fallback for any CLI that looks for a simple env var. This is
        // the *only* env var worth setting: no shipping agent CLI discovers MCP
        // servers from the environment. `CLAUDE_CODE__MCP__SERVERS` and
        // `AIDER_MCP_SERVERS` used to be set here and were read by nothing —
        // agents booted with zero Spacron tools and reported no error. Claude
        // Code is now handled by `mcpLaunchFlags`; do not re-add an env var for
        // an agent without first confirming the CLI actually reads it.
        env['SPACRON_MCP_URL'] = mcpUrl;

        // How long the agent waits for a stdio MCP server to finish starting.
        //
        // These two *are* read — Claude Code's own MCP client reads both — which
        // is what separates them from the dead `CLAUDE_CODE__MCP__SERVERS`
        // described above. Claude Code allows 30s by default and the browser
        // server does not make it: `npx -y @playwright/mcp@latest` spends ~28s
        // on Windows before Playwright starts doing anything, because `@latest`
        // re-resolves against the registry on every launch even with the package
        // already cached. Agents were losing their browser tools on essentially
        // every launch, and a server that never finished starting is reported
        // only as a connection failure, so there was nothing to debug from.
        //
        // Set for every agent rather than only when the browser toggle is on: a
        // user's own hand-written stdio server in `.mcp.json` pays the same npx
        // cost, and a longer ceiling costs a working server nothing.
        env['MCP_TIMEOUT'] = String(BROWSER_STARTUP_TIMEOUT_MS);
        env['MCP_TOOL_TIMEOUT'] = String(BROWSER_TOOL_TIMEOUT_MS);

        // This agent's own identity, for `report_status`.
        //
        // Only Claude Code gets a config file written per launch, so only it
        // can be identified by the token it presents on the connection. Every
        // other CLI reads a shared config and connects as "some agent on this
        // machine". Putting the per-launch token in the PTY environment closes
        // that gap for all of them: the agent passes it back as `agent_token`,
        // and only its own process tree could have read it.
        //
        // Minted here and bound below, once the PTY exists — the env has to be
        // complete before the process starts, and the session id does not exist
        // until after.
        agentChannel = await prepareAgentChannel();
        if (agentChannel) env['SPACRON_AGENT_TOKEN'] = agentChannel.token;

        // The universal fallback channel. `report_status` only exists for the
        // CLIs Spacron can write an MCP config for; every other agent gets a
        // file and a nonce here and is told (in its standing brief) to echo one
        // line into it when it stops. Running a shell command is the one thing
        // every coding CLI can do, so this is what makes turn reporting reach
        // all of them rather than eight of them.
        statusChannel = await prepareStatusChannel();
        if (statusChannel) {
          env['SPACRON_TURN_FILE'] = statusChannel.path;
          env['SPACRON_TURN_TOKEN'] = statusChannel.channelId;
        }

        // Keep the agent's links inside the app.
        //
        // Every CLI that opens a URL does it the same way: spawn whatever
        // `BROWSER` names, with the URL as the single argument. Claude Code,
        // gh, Vite, and Python's `webbrowser` all read it, which is what makes
        // this the one hook that works across the agents Spacron launches
        // rather than a per-CLI special case. `spacron-open` appends the URL to
        // the status channel above and the preview room shows it, so an agent
        // publishing an artifact no longer throws the user out to the system
        // browser mid-task.
        //
        // Bound to the status channel deliberately: the shim inherits
        // SPACRON_TURN_FILE / SPACRON_TURN_TOKEN from the agent that spawns it,
        // so there is nothing extra to thread through. No channel, no BROWSER —
        // an agent with a `BROWSER` it cannot route through is worse off than
        // one with none, since the shim would have nowhere to send the URL.
        //
        // GH_BROWSER too: `gh` prefers it over BROWSER, and the GitHub auth
        // flow is one of the most common times an agent reaches for a browser.
        if (statusChannel) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const shimPath = await invoke<string | null>('browser_shim_path');
            if (shimPath) {
              env['BROWSER'] = shimPath;
              env['GH_BROWSER'] = shimPath;
            }
          } catch (e) {
            console.warn('[browser] no URL shim available; agent links will open externally:', e);
          }
        }

        // Config-file-based agents (Cursor, Codex CLI) — fire-and-forget
        injectMcpConfigForAgent(agentPreset, resolvedCwd).catch((e) =>
          console.warn('[mcp] config injection failed:', e),
        );
      } catch (e) {
        console.warn('Could not inject MCP server config:', e);
      }
    }

    const fallback = defaultSpawnGeometry();
    const cols = opts?.initialCols && opts.initialCols >= 10 ? opts.initialCols : fallback.cols;
    const rows = opts?.initialRows && opts.initialRows >= 3 ? opts.initialRows : fallback.rows;

    const ptyPromise = openPty(cols, rows, {
      onData: (bytes) => {
        const text = appendSessionOutputBuffer(pty.id, bytes);
        const cb = dataCallbacks.get(pty.id);
        cb?.(bytes, text);
      },
      onExit: (code) => {
        handlePtyExit(pty.id, owningProjectId, code);
      },
    }, resolvedCwd, get(terminalShell) || undefined, env);

    pty = await ptyPromise;
    // The token is already in the process's environment; this is what makes it
    // mean "session N" rather than "an agent this app started".
    if (agentChannel) void bindAgentChannel(agentChannel, pty.id);
    // `guaranteed: false` — the agent may simply forget to echo, so this must
    // not buy the long idle window a Claude hook does.
    if (statusChannel) {
      attachTurnSignals(pty.id, { command: '', channelId: statusChannel.channelId });
    }
    registerPtySession(pty, owningProjectId, resolvedCwd, targetPaneIndex, { agentPreset, hidden: opts?.hidden }, assignPane, isDev);
    return pty.id;
  } catch (err) {
    console.error('Failed to create terminal session:', err);
    return null;
  }
}

export async function attachTerminalSession(
  backendSessionId: number,
  cwd?: string | null,
  targetPaneIndex?: number,
  projectId?: string,
  metadata: RestoredSessionMetadata = {},
  opts?: { assignPane?: boolean; isDev?: boolean }
): Promise<number | null> {
  try {
    const isDev = opts?.isDev ?? false;
    const owningProjectId = projectId ?? (isDev ? activeDevTerminalProjectId : activeTerminalProjectId);
    if (!owningProjectId || !Number.isInteger(backendSessionId) || backendSessionId <= 0) {
      return null;
    }

    if (ptyInstances.has(backendSessionId)) {
      return backendSessionId;
    }

    let pty: PtySession;
    const ptyPromise = attachPty(backendSessionId, {
      onReplay: (bytes) => {
        appendSessionOutputBuffer(backendSessionId, bytes);
      },
      onData: (bytes) => {
        const text = appendSessionOutputBuffer(backendSessionId, bytes);
        const cb = dataCallbacks.get(backendSessionId);
        cb?.(bytes, text);
      },
      onExit: (code) => {
        handlePtyExit(backendSessionId, owningProjectId, code);
      },
    });

    pty = await ptyPromise;
    registerPtySession(pty, owningProjectId, cwd ?? null, targetPaneIndex, metadata, opts?.assignPane ?? true, isDev);
    return pty.id;
  } catch {
    return null;
  }
}

export function writeToSession(id: number, data: string) {
  const pty = ptyInstances.get(id);
  if (pty) {
    processSessionInput(id, data);
    pty.write(data).catch((err) => console.error('Failed to write to terminal:', err));
  }
}

function submitAfterPaste(sessionId: number, settleMs = 140, maxWaitMs = 4000) {
  const start = Date.now();
  const tick = () => {
    const req = get(terminalInputRequest);
    const delivered = req === null || req.sessionId !== sessionId;
    if (delivered || Date.now() - start >= maxWaitMs) {
      setTimeout(() => writeToSession(sessionId, '\r'), settleMs);
    } else {
      setTimeout(tick, 60);
    }
  };
  tick();
}

export function sendPromptToSession(sessionId: number, text: string, agentPreset?: string | null) {
  if (!text) return;
  if (agentPreset) {
    const session = findSessionAnyProject(sessionId);
    const payload =
      session && !session.briefed
        ? buildAgentCharter(text, { name: session.agentName ?? null })
        : text;
    noteAgentPrompted(sessionId, text);
    void deliverPromptRaw(sessionId, payload);
    markSessionBriefed(sessionId, true);
    return;
  }
  writeToSession(sessionId, `${text}\r`);
}

const isTestEnv = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true');

const PASTE_ECHO_POLL_MS = isTestEnv ? 1 : 40;
const PASTE_ECHO_MIN_WAIT_MS = isTestEnv ? 2 : 60;
const PASTE_ECHO_NEEDLE_CHARS = 48;
const PASTE_SUBMIT_SETTLE_MS = isTestEnv ? 2 : 140;
const PASTE_SUBMIT_MAX_WAIT_MS = isTestEnv ? 15 : 6000;
const SUBMIT_CONFIRM_POLL_MS = isTestEnv ? 2 : 80;
const SUBMIT_CONFIRM_WINDOW_MS = isTestEnv ? 15 : 8000;
// How long a composer may still show the prompt before Enter is pressed again,
// and how long to keep pressing it. A 6.7k-character paste took Codex on
// Windows ~18s to ingest; startup can add a few more.
const PENDING_COMPOSER_RETRY_MS = isTestEnv ? 4 : 3000;
const SUBMIT_TOTAL_WINDOW_MS = isTestEnv ? 250 : 90000;
/** An emptied composer must stay empty this long to count as a submit. */
const SUBMIT_CLEAR_HOLD_MS = isTestEnv ? 3 : 900;
const SUBMIT_CONFIRM_DELTA = 512;
const MAX_SUBMIT_ATTEMPTS = isTestEnv ? 1 : 3;
const PASTE_COMMIT_QUIET_MS = isTestEnv ? 1 : 220;
const PASTE_COMMIT_QUIET_MAX_MS = isTestEnv ? 4 : 1600;
const PASTE_INGEST_QUIET_MS = isTestEnv ? 2 : 700;
const PASTE_INGEST_MS_PER_CHAR = isTestEnv ? 0 : 4;
const PASTE_INGEST_MAX_MS = isTestEnv ? 20 : 45000;
const ECHO_ANSI =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=>]/g;
const ECHO_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function normalizeForEchoMatch(raw: string): string {
  if (!raw) return '';
  return raw.replace(ECHO_ANSI, '').replace(ECHO_CONTROL, '').replace(/\s+/g, ' ').trim();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    count++;
    from = haystack.indexOf(needle, from + needle.length);
  }
  return count;
}

const PASTE_PLACEHOLDER_RE = /pasted\s+(?:text|content|\d+\s+lines?)/gi;

function countPastePlaceholders(haystack: string): number {
  return haystack.match(PASTE_PLACEHOLDER_RE)?.length ?? 0;
}

export function pasteEchoLanded(base: string, current: string, text: string): boolean {
  const needle = normalizeForEchoMatch(text).slice(0, PASTE_ECHO_NEEDLE_CHARS);
  if (!needle) return false;
  const normalBase = normalizeForEchoMatch(base);
  const normalNow = normalizeForEchoMatch(current);
  if (countOccurrences(normalNow, needle) > countOccurrences(normalBase, needle)) return true;
  return countPastePlaceholders(normalNow) > countPastePlaceholders(normalBase);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function logAgentSend(sessionId: number, event: string, detail?: Record<string, unknown>) {
  if (isTestEnv) return;
  console.info(`[agent-send] #${sessionId} ${event}`, detail ?? '');
}

async function waitForPasteEcho(sessionId: number, base: string, text: string): Promise<boolean> {
  const startedAt = Date.now();
  let landed = false;
  for (;;) {
    const elapsed = Date.now() - startedAt;
    landed =
      elapsed >= PASTE_ECHO_MIN_WAIT_MS && pasteEchoLanded(base, getSessionOutputBuffer(sessionId), text);
    if (landed || elapsed >= PASTE_SUBMIT_MAX_WAIT_MS) break;
    await sleep(PASTE_ECHO_POLL_MS);
  }
  await sleep(PASTE_SUBMIT_SETTLE_MS);
  return landed;
}

/** What a mounted pane's composer shows right now, for one prompt delivery. */
type ComposerState = 'working' | 'pending' | 'clear';

/**
 * Whether the CLI took the prompt after one Enter.
 *
 * With the pane mounted, only the screen counts. `working` (the CLI's own
 * "esc to interrupt" line) is proof on its own. An empty composer counts only
 * once this delivery has SEEN the prompt sitting there and the row then stays
 * empty: while a TUI is still ingesting a long paste the row can show its
 * empty hint for a moment (Codex does), and output keeps growing the whole
 * time, which is why growth "confirmed" Enters the CLI had swallowed. Growth
 * is only the fallback for a pane this code cannot read.
 */
async function confirmAgentStarted(
  sessionId: number,
  baseLen: number,
  prompt: string,
  seen: { pending: boolean },
): Promise<boolean> {
  const startedAt = Date.now();
  let clearSince: number | null = null;
  for (;;) {
    if (!ptyInstances.get(sessionId)) return false;
    const state = readComposerState(sessionId, prompt);
    const now = Date.now();
    if (state === 'working') return true;
    if (state === 'pending') seen.pending = true;
    if (state === 'clear' && seen.pending) {
      clearSince ??= now;
      if (now - clearSince >= SUBMIT_CLEAR_HOLD_MS) return true;
    } else {
      clearSince = null;
    }
    if (state == null && getSessionOutputLength(sessionId) >= baseLen + SUBMIT_CONFIRM_DELTA) return true;
    const elapsed = now - startedAt;
    // Still waiting in the box (or not readable yet): press Enter again.
    if (state !== 'clear' && state != null && elapsed >= PENDING_COMPOSER_RETRY_MS) return false;
    if (elapsed >= SUBMIT_CONFIRM_WINDOW_MS) return false;
    await sleep(SUBMIT_CONFIRM_POLL_MS);
  }
}

const PASTE_PLACEHOLDER_ROW = /\[\s*pasted\s+(?:content|text|\d+\s+lines?)[^\]]*\]/i;
/** A composer row: `› text` (Codex), `> text` / `│ > text │` (Claude), `❯ text`. */
const COMPOSER_ROW = /^[\s│┃|]*[›>❯]\s?(.*?)[\s│┃|]*$/;
/** The status line Claude Code, Codex and Gemini show while a turn runs. */
const WORKING_ROW = /esc to (?:interrupt|cancel)/i;
const COMPOSER_SCAN_ROWS = 14;

/**
 * What a mounted pane shows for this prompt: the agent `working` on a turn,
 * the prompt `pending` in the composer (its paste placeholder or its opening
 * words), or the composer `clear`. null when there is no pane, or no composer
 * row this code recognises — callers then fall back to output growth.
 */
function readComposerState(sessionId: number, prompt: string): ComposerState | null {
  const screen = readTerminalScreen(sessionId, { maxLines: COMPOSER_SCAN_ROWS });
  if (screen == null) return null;
  const rows = screen.split('\n');
  let composerIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (COMPOSER_ROW.test(rows[index])) {
      composerIndex = index;
      break;
    }
  }
  // A paste placeholder is prompt-in-waiting wherever it sits near the bottom.
  const fromComposer = composerIndex >= 0 ? rows.slice(composerIndex).join('\n') : rows.slice(-4).join('\n');
  if (PASTE_PLACEHOLDER_ROW.test(fromComposer)) return 'pending';
  if (rows.some((row) => WORKING_ROW.test(row))) return 'working';
  if (composerIndex < 0) return null;
  const typed = normalizeForEchoMatch(COMPOSER_ROW.exec(rows[composerIndex])?.[1] ?? '');
  if (!typed) return 'clear';
  const promptStart = normalizeForEchoMatch(prompt).slice(0, PASTE_ECHO_NEEDLE_CHARS);
  if (!promptStart) return 'clear';
  // The row shows the prompt's first line, possibly cut at the pane's width.
  const probe = typed.slice(0, Math.min(typed.length, promptStart.length));
  if (probe.length < 4) return null; // too little on the row to tell either way
  return promptStart.startsWith(probe) ? 'pending' : 'clear';
}

/**
 * Wait until the CLI has finished taking the paste in, so the Enter that
 * follows is a submit and not a newline inside it. On Windows ConPTY hands a
 * paste over key by key and the TUI repaints for each one: 6.7k characters
 * took Codex ~18s. Done once the output has been quiet for a moment — with a
 * readable pane, also once the prompt is visibly in the composer.
 */
async function waitForPasteIngested(sessionId: number, prompt: string): Promise<void> {
  const startedAt = Date.now();
  const maxWait = Math.min(PASTE_INGEST_MAX_MS, PASTE_COMMIT_QUIET_MAX_MS + prompt.length * PASTE_INGEST_MS_PER_CHAR);
  let lastLen = getSessionOutputLength(sessionId);
  let quietSince = Date.now();
  for (;;) {
    await sleep(PASTE_COMMIT_QUIET_MS);
    if (!ptyInstances.get(sessionId)) return;
    const len = getSessionOutputLength(sessionId);
    const now = Date.now();
    if (len !== lastLen) {
      lastLen = len;
      quietSince = now;
    }
    const state = readComposerState(sessionId, prompt);
    const quietFor = now - quietSince;
    if (state == null ? quietFor >= PASTE_COMMIT_QUIET_MS : state === 'pending' && quietFor >= PASTE_INGEST_QUIET_MS) return;
    if (now - startedAt >= maxWait) return;
  }
}

export async function sendAgentPromptDirect(sessionId: number, text: string): Promise<boolean> {
  if (!text) return false;
  noteAgentPrompted(sessionId, text);
  return deliverPromptRaw(sessionId, text);
}

/** Answer an explicit line-input prompt, without TUI paste framing or a task charter. */
export async function sendAgentInputLine(sessionId: number, text: string): Promise<boolean> {
  const pty = ptyInstances.get(sessionId);
  if (!pty || !text.trim() || /[\r\n\x00-\x1f\x7f]/.test(text)) return false;
  try {
    await pty.write(`${text}\r`);
    setSessionExecuting(sessionId, true);
    // Answering the agent's question hands it the turn back.
    noteAgentPrompted(sessionId);
    return true;
  } catch { return false; }
}

async function deliverPromptRaw(sessionId: number, text: string): Promise<boolean> {
  const pty = ptyInstances.get(sessionId);
  if (!pty) return false;

  const session = findSessionAnyProject(sessionId);
  const preset = session?.agentPreset;
  const isTui = Boolean(preset);

  if (!isTui) {
    const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    pty.write(cleanText + '\r').catch((err) => console.error('Failed to submit prompt:', err));
    setSessionExecuting(sessionId, true);
    await sleep(80);
    const success = ptyInstances.has(sessionId);
    if (success) {
      markSessionBriefed(sessionId, true);
    }
    return success;
  }

  const base = getSessionOutputBuffer(sessionId);
  const promptBody = text;
  const pasteBody = promptBody.replace(/\r?\n/g, pasteLineBreak(preset));
  const pastePayload = `\x1b[200~${pasteBody}\x1b[201~`;
  try {
    await pty.write(pastePayload);
  } catch (err) {
    logAgentSend(sessionId, 'paste-write-failed');
    console.error('Failed to paste prompt:', err);
    return false;
  }
  setSessionExecuting(sessionId, true);
  logAgentSend(sessionId, 'paste-written', { preset, chars: pasteBody.length });

  const echoLanded = await waitForPasteEcho(sessionId, base, promptBody);
  logAgentSend(sessionId, echoLanded ? 'echo-confirmed' : 'echo-timeout');

  await waitForPasteIngested(sessionId, promptBody);
  logAgentSend(sessionId, 'composer-settled', { state: readComposerState(sessionId, promptBody) });

  // Press Enter until the pane shows the prompt was taken. An Enter can be
  // lost two ways, both reproduced with Codex on Windows: it lands while the
  // CLI is still ingesting a long paste (it becomes a newline inside it), or
  // while the CLI is still booting. A repeat is safe: Enter on an empty
  // composer is a no-op. Never paste again — that could send the prompt twice.
  const submitStartedAt = Date.now();
  const seen = { pending: readComposerState(sessionId, promptBody) === 'pending' };
  for (let attempt = 0; ; attempt += 1) {
    if (!ptyInstances.get(sessionId)) return false;
    const lenBeforeEnter = getSessionOutputLength(sessionId);
    try {
      await pty.write('\r');
    } catch (err) {
      logAgentSend(sessionId, 'enter-write-failed', { attempt: attempt + 1 });
      console.error('Failed to submit prompt:', err);
      return false;
    }
    const confirmed = await confirmAgentStarted(sessionId, lenBeforeEnter, promptBody, seen);
    logAgentSend(sessionId, 'enter', {
      attempt: attempt + 1,
      confirmed,
      growth: getSessionOutputLength(sessionId) - lenBeforeEnter,
    });
    if (confirmed) {
      markSessionBriefed(sessionId, true);
      return true;
    }
    // Without a readable composer there is nothing to tell a lost Enter from a
    // slow start, so keep the old bounded retry count.
    const readable = readComposerState(sessionId, promptBody) != null;
    if (!readable && attempt + 1 >= MAX_SUBMIT_ATTEMPTS) break;
    if (Date.now() - submitStartedAt >= SUBMIT_TOTAL_WINDOW_MS) break;
  }
  const sessionAlive = ptyInstances.has(sessionId);
  logAgentSend(sessionId, 'submit-unconfirmed', { sessionAlive });
  // A live PTY only proves the terminal still exists; it does not prove the
  // CLI accepted the prompt. Returning true here leaves the orchestrator task
  // marked as working while the prompt can still be sitting in the composer.
  return false;
}

export function setSessionExecuting(id: number, executing: boolean) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => (x.id === id ? { ...x, isExecuting: executing } : x)),
  }), isDev);
}

export function updateSessionTitle(id: number, title: string) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) =>
      x.id === id ? { ...x, title } : x
    ),
  }), isDev);
}

export function setSessionPaneTitle(id: number, paneTitle: string | null) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) =>
      x.id === id ? { ...x, paneTitle } : x
    ),
  }), isDev);
}

export function setSessionAgentName(id: number, agentName: string | null) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) =>
      x.id === id ? { ...x, agentName } : x
    ),
  }), isDev);

  // If a real agent name was assigned, register it with the MCP server
  if (agentName?.trim()) {
    const session = getProjectState(projectId, isDev).sessions.find((x) => x.id === id);
    if (session?.agentPreset) {
      registerAgent(id, agentName, session.agentPreset, getSessionLabel(session, [session]), session.worktree?.branch).catch((e) =>
        console.error('Failed to register agent with MCP server:', e),
      );
    }
  }
}

export function applyOscPaneTitle(id: number, paneTitle: string): void {
  setSessionPaneTitle(id, paneTitle);
}

export type RestoredSessionMetadata = {
  title?: string | null;
  paneTitle?: string | null;
  agentName?: string | null;
  agentPreset?: string | null;
  role?: string | null;
  taskSummary?: string | null;
  // Carried across restarts so a restored agent is still known to be running in
  // its isolated worktree. The agent relaunches there either way (its `cwd` is
  // persisted), so dropping this only blinded the UI — and left the worktree
  // orphaned, since cleanup on close keys off this field.
  worktree?: WorktreeInfo | null;
  hidden?: boolean;
};

export function applyRestoredSessionMetadata(id: number, metadata: RestoredSessionMetadata) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => {
      if (x.id !== id) return x;
      const agentPreset = metadata.agentPreset ?? x.agentPreset ?? null;
      const role = metadata.role ?? (agentPreset ? x.role ?? 'Agent' : x.role ?? null);
      return {
        ...x,
        title: metadata.title?.trim() || x.title,
        paneTitle: metadata.paneTitle ?? x.paneTitle ?? null,
        agentName: metadata.agentName ?? x.agentName ?? null,
        agentPreset,
        role,
        taskSummary: metadata.taskSummary ?? x.taskSummary ?? x.taskSummary ?? null,
        worktree: metadata.worktree ?? x.worktree ?? null,
        hidden: metadata.hidden ?? x.hidden ?? false,
        briefed: agentPreset ? false : x.briefed,
        isExecuting: false,
        lastExitCode: null,
      };
    }),
  }), isDev);
}

/**
 * Async because the MCP config has to be rewritten before the CLI starts: the
 * server binds a fresh random port and token on every app launch, so the file a
 * previous run left behind points at nothing.
 */
export async function relaunchRestoredAgentSession(
  id: number,
  agentPreset: string,
  metadata: RestoredSessionMetadata = {}
): Promise<boolean> {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId || !agentPreset.trim()) return false;

  const displayName = getAgentDisplayName(agentPreset) ?? agentPreset;
  applyRestoredSessionMetadata(id, {
    ...metadata,
    title: metadata.title?.trim() || displayName,
    agentPreset,
    role: metadata.role ?? 'Agent',
  });

  const mcpFlags = await mcpLaunchFlags(agentPreset, resolveSessionRoot(id) ?? undefined, id);
  // A restored session is a relaunch of an agent Spacron spawned, so it follows
  // the same permission mode as a fresh spawn — the yolo args belong on the
  // line written to the PTY, never in the preset key. (Env overrides like
  // Goose's `GOOSE_MODE=auto` can't be re-injected into an existing PTY, so
  // they only apply at first spawn; relaunch inherits the shell's env.)
  const launchOverrides = {
    agentCmdOverrides: get(agentCmdOverrides),
    agentDefaultArgs: get(agentDefaultArgs),
  };
  const launchCommand = resolveAgentLaunchCommand(agentPreset, launchOverrides);
  const launchArgs = resolveAgentLaunchArgs(agentPreset, get(agentPermissionMode), launchOverrides);
  const launchLine = `${launchCommand}${launchArgs ? ` ${launchArgs}` : ''}${platformLaunchFlags(agentPreset)}${mcpFlags}`;

  agentLaunchStartLengths.set(id, getSessionOutputLength(id));
  suppressAgentDetection.add(id);
  try {
    writeToSession(id, `${launchLine}\r`);
  } finally {
    suppressAgentDetection.delete(id);
  }
  return true;
}

/**
 * Start `agentPreset` again in a session whose CLI has already exited back to
 * the shell, with `args` in place of the default permission args. The chat
 * view uses it to apply a permission, model or effort change the CLI can only
 * take at launch, resuming the same conversation (`args` carries the resume
 * flag). Same command, MCP and platform flags as any other launch.
 */
export async function relaunchAgentInSession(id: number, agentPreset: string, args: string): Promise<boolean> {
  if (!ptyInstances.get(id) || !agentPreset.trim()) return false;
  const mcpFlags = await mcpLaunchFlags(agentPreset, resolveSessionRoot(id) ?? undefined, id);
  const launchCommand = resolveAgentLaunchCommand(agentPreset, {
    agentCmdOverrides: get(agentCmdOverrides),
    agentDefaultArgs: get(agentDefaultArgs),
  });
  const launchLine = `${launchCommand}${args.trim() ? ` ${args.trim()}` : ''}${platformLaunchFlags(agentPreset)}${mcpFlags}`;
  agentLaunchStartLengths.set(id, getSessionOutputLength(id));
  suppressAgentDetection.add(id);
  try {
    writeToSession(id, `${launchLine}\r`);
  } finally {
    suppressAgentDetection.delete(id);
  }
  markSessionAgentPreset(id, agentPreset, true);
  return true;
}

export function markSessionBriefed(id: number, briefed: boolean) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) =>
      x.id === id ? { ...x, briefed } : x
    ),
  }), isDev);
}

const READY_OUTPUT_DELTA = 16;
const READY_POLL_MS = isTestEnv ? 2 : 50;
const READY_NO_OUTPUT_WAIT_MS = isTestEnv ? 40 : 9000;
const READY_MAX_WAIT_MS = isTestEnv ? 40 : 20000;
const READY_BANNER_DELTA = 32;
const READY_MIN_STARTUP_MS = isTestEnv ? 10 : 4000;
const READY_QUIET_MS = isTestEnv ? 5 : 400;
const READY_TUI_MARKERS = ['\x1b[?2004h', '\x1b[?1049h'];
const READY_MARKER_SETTLE_MS = isTestEnv ? 5 : 1200;
const READY_BOOT_MARKER_WAIT_MS = isTestEnv ? 40 : 30000;
const READY_BOOT_BANNER_DELTA = 512;

const LAUNCH_FAILURE_SIGNATURES = [
  'isnotrecognized',
  'commandnotfound',
];

function launchFailedSince(sessionId: number, startLen: number): boolean {
  const grown = getSessionOutputBuffer(sessionId).slice(startLen);
  if (!grown) return false;
  const compact = normalizeForEchoMatch(grown).replace(/\s+/g, '').toLowerCase();
  return LAUNCH_FAILURE_SIGNATURES.some((sig) => compact.includes(sig));
}

export type AgentReadiness = 'ready' | 'launch-failed';

/**
 * Whether an agent CLI actually came up, judged from its terminal after
 * `waitForAgentReady` returned. That wait says "ready" even when the pane
 * stayed silent, so it cannot tell a live agent from a blank screen; this can:
 * - `started`: the CLI drew its interface (a TUI marker) or printed a banner.
 * - `blank`: the session is alive but nothing the CLI drew ever arrived.
 * - `launch-failed`: the shell could not find the command (not installed).
 * - `gone`: the session is closed or its process exited.
 */
export type AgentStartupState = 'started' | 'blank' | 'launch-failed' | 'gone';

export function agentStartupState(sessionId: number): AgentStartupState {
  const session = findSessionAnyProject(sessionId);
  if (!session || !session.isRunning) return 'gone';
  const launchStart = agentLaunchStartLengths.get(sessionId) ?? 0;
  if (launchFailedSince(sessionId, launchStart)) return 'launch-failed';
  const grown = getSessionOutputBuffer(sessionId).slice(launchStart);
  if (READY_TUI_MARKERS.some((marker) => grown.includes(marker))) return 'started';
  return grown.length >= READY_BOOT_BANNER_DELTA ? 'started' : 'blank';
}

export async function waitForAgentReady(sessionId: number): Promise<AgentReadiness> {
  const startedAt = Date.now();
  const initialBuffer = getSessionOutputBuffer(sessionId);
  const startLen = initialBuffer.length;
  const launchStartLen = agentLaunchStartLengths.get(sessionId);
  const sinceLaunch = launchStartLen != null ? initialBuffer.slice(launchStartLen) : initialBuffer;
  const tuiMarkerSeen = () => {
    const grown = getSessionOutputBuffer(sessionId).slice(startLen);
    return READY_TUI_MARKERS.some((marker) => grown.includes(marker));
  };

  const session = findSessionAnyProject(sessionId);
  const markerAlreadyVisible = READY_TUI_MARKERS.some((marker) => sinceLaunch.includes(marker));
  const bannerAlreadyVisible =
    launchStartLen != null && initialBuffer.length >= launchStartLen + READY_BOOT_BANNER_DELTA;
  const mustSeeMarker = Boolean(session?.agentPreset) && !markerAlreadyVisible && !bannerAlreadyVisible;
  const maxWaitMs = mustSeeMarker ? READY_BOOT_MARKER_WAIT_MS : READY_MAX_WAIT_MS;
  const launchFailureStartLen = launchStartLen ?? startLen;
  const display = getAgentDisplayName(session?.agentPreset) ?? session?.agentPreset ?? 'The agent CLI';

  const launchFailed = () => {
    if (!mustSeeMarker || tuiMarkerSeen() || !launchFailedSince(sessionId, launchFailureStartLen)) return false;
    logAgentSend(sessionId, 'launch-failed', { preset: session?.agentPreset ?? null });
    showToast(
      `${display} isn't installed. The shell doesn't recognize the command. Install it (or fix PATH), then relaunch.`,
      'error',
      9000
    );
    return true;
  };

  if (Boolean(session?.agentPreset) && !markerAlreadyVisible && launchFailedSince(sessionId, launchFailureStartLen)) {
    logAgentSend(sessionId, 'launch-failed', { preset: session?.agentPreset ?? null, beforeReadyWait: true });
    showToast(
      `${display} isn't installed. The shell doesn't recognize the command. Install it (or fix PATH), then relaunch.`,
      'error',
      9000
    );
    return 'launch-failed';
  }

  if (bannerAlreadyVisible) {
    logAgentSend(sessionId, 'ready-existing-banner', {
      preset: session?.agentPreset ?? null,
      grownChars: initialBuffer.length - (launchStartLen ?? startLen),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, READY_QUIET_MS));
    return 'ready';
  }

  let initiallyGrown = false;
  while (Date.now() - startedAt < (mustSeeMarker ? maxWaitMs : READY_NO_OUTPUT_WAIT_MS)) {
    if (launchFailed()) return 'launch-failed';
    if (getSessionOutputLength(sessionId) > startLen + READY_OUTPUT_DELTA || tuiMarkerSeen()) {
      initiallyGrown = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  if (!initiallyGrown) {
    logAgentSend(sessionId, 'ready-silent', {
      preset: session?.agentPreset ?? null,
      mustSeeMarker,
      waitedMs: Date.now() - startedAt,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, READY_QUIET_MS));
    return 'ready';
  }

  while (Date.now() - startedAt < maxWaitMs) {
    if (launchFailed()) return 'launch-failed';
    if (tuiMarkerSeen()) break;
    const currentLen = getSessionOutputLength(sessionId);
    if (mustSeeMarker) {
      if (currentLen >= startLen + READY_BOOT_BANNER_DELTA) break;
    } else if (currentLen >= startLen + READY_BANNER_DELTA || Date.now() - startedAt >= READY_MIN_STARTUP_MS) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  let markerAt: number | null = tuiMarkerSeen() ? Date.now() : null;
  let lastLen = getSessionOutputLength(sessionId);
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, READY_POLL_MS));
    if (markerAt === null && launchFailed()) return 'launch-failed';
    if (markerAt === null && tuiMarkerSeen()) markerAt = Date.now();
    const currentLen = getSessionOutputLength(sessionId);
    if (currentLen !== lastLen) {
      lastLen = currentLen;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= READY_QUIET_MS) {
      if (markerAt !== null) break;
      const bannerGrown = lastLen >= startLen + READY_BOOT_BANNER_DELTA;
      if ((!mustSeeMarker || bannerGrown) && Date.now() - startedAt >= READY_MIN_STARTUP_MS) break;
    }
    if (markerAt !== null && Date.now() - markerAt >= READY_MARKER_SETTLE_MS) break;
  }

  logAgentSend(sessionId, 'ready', {
    preset: session?.agentPreset ?? null,
    mustSeeMarker,
    marker: markerAt !== null,
    grownChars: getSessionOutputLength(sessionId) - startLen,
    elapsedMs: Date.now() - startedAt,
  });
  return 'ready';
}

function resolveSessionRoot(id: number): string | null {
  const explicit = findSessionAnyProject(id)?.cwd;
  if (explicit) return explicit;
  const projectId = terminalSessionProjects.get(id);
  return (projectId ? terminalProjectRoots.get(projectId) : null) ?? null;
}

const autoBriefInFlight = new Set<number>();

async function autoBriefSession(id: number, preset: string) {
  const isDev = devSessionIds.has(id);
  const current = get(isDev ? devSessions : sessions).find((s) => s.id === id);
  if (!current || !current.isRunning || current.agentPreset !== preset || current.briefed || current.ownerTaskId) {
    return;
  }
  if (autoBriefInFlight.has(id)) return;
  autoBriefInFlight.add(id);

  try {
    // Attempt the file channel for rules-file agents AND for agents that have a
    // bonus native file (e.g. traecli's .trae/rules) — ensureAgentRulesFiles
    // returns false for non-members, so the paste fallback below still fires.
    if (agentReadsRulesFile(preset) || agentHasNativeExtras(preset)) {
      const root = resolveSessionRoot(id);
      if (root && (await ensureAgentRulesFiles(root, preset))) {
        logAgentSend(id, 'briefed-via-rules-file', { preset, root });
        markSessionBriefed(id, true);
        return;
      }
      logAgentSend(id, 'rules-file-unavailable', { preset, root });
    }

    if ((await waitForAgentReady(id)) === 'launch-failed') {
      return;
    }

    const session = get(isDev ? devSessions : sessions).find((s) => s.id === id);
    if (!session || !session.isRunning || session.agentPreset !== preset || session.briefed) {
      return;
    }

    if (session.ownerTaskId) {
      return;
    }

    const name = session.agentName || null;
    const brief = buildAgentCharter('', { name });
    // Straight to delivery, not `sendAgentPromptDirect`: the charter is setup,
    // not a task, so it must not mark the agent as working.
    await deliverPromptRaw(id, brief);
    // Briefed once the charter is in the pane, even when the submit could not
    // be confirmed: briefing again would paste a second charter on top of it.
    if (ptyInstances.has(id)) markSessionBriefed(id, true);
  } finally {
    autoBriefInFlight.delete(id);
  }
}

/**
 * When the agent now running in each session was started. The terminal chat
 * view finds the CLI's own transcript by working directory and this time, so
 * a session from an earlier run in the same folder is never shown here.
 */
const agentStartedAt = new Map<number, { preset: string; at: number }>();

export function getSessionAgentStartedAt(id: number): number | null {
  return agentStartedAt.get(id)?.at ?? null;
}

/** The directory the session's agent runs in: its own cwd, else its project root. */
export function getSessionRoot(id: number): string | null {
  return resolveSessionRoot(id);
}

export function markSessionAgentPreset(id: number, agentPreset: string | null, briefed?: boolean) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  if (!agentPreset) agentStartedAt.delete(id);
  else if (agentStartedAt.get(id)?.preset !== agentPreset) agentStartedAt.set(id, { preset: agentPreset, at: Date.now() });
  // Activity stats: this is the one point every agent passes through, whether
  // spawned from the picker or adopted after the user typed `claude` into a
  // shell. The recorder dedupes by session id — this fires again on re-brief.
  if (agentPreset) recordAgentSpawn(id, agentPreset);
  else forgetAgentSpawn(id);
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => {
      if (x.id !== id) return x;
      if (!agentPreset) {
        return { ...x, agentPreset: null, role: x.role === 'Agent' ? null : x.role, briefed: false };
      }
      const nextBriefed = briefed !== undefined ? briefed : false;
      // Typing `claude` into a shell converts THAT session into an agent in
      // place (the agent really is running in that PTY, so the pane has to
      // follow it). Its title is still the shell's `Terminal N`, which then
      // showed up as an agent named "Terminal 1" and left a hole in the shell
      // numbering. Retitle to the tool's display name — but only when the title
      // is still the untouched default, so a user-renamed pane keeps its name.
      const isDefaultShellTitle = /^Terminal \d+$/.test(x.title ?? '');
      const nextTitle = isDefaultShellTitle
        ? getAgentDisplayName(agentPreset) ?? agentPreset
        : x.title;
      return { ...x, title: nextTitle, agentPreset, role: x.role ?? 'Agent', briefed: nextBriefed };
    }),
  }), isDev);

  if (agentPreset) {
    setTimeout(() => {
      const session = get(isDev ? devSessions : sessions).find((s) => s.id === id);
      if (session && !session.briefed && !session.ownerTaskId) {
        void autoBriefSession(id, agentPreset);
      }
    }, 50);
  }
}

export function getSessionLabel(session: TerminalSessionInfo, allSessions: TerminalSessionInfo[]): string {
  const role = session.role;
  if (!role) return session.title;
  const sameRole = allSessions.filter((s) => s.role === role);
  if (sameRole.length <= 1) return role;
  const idx = sameRole.findIndex((s) => s.id === session.id);
  return idx === -1 ? role : `${role} ${idx + 1}`;
}

/**
 * The one-line summary an agent shows in its own header: the title its CLI
 * sets (Claude Code titles the pane after the conversation, "◐ Fix the login
 * redirect"), else the pane's task summary. The leading spinner/status glyph
 * is dropped, and a title that is only the product's own name ("✳ Claude
 * Code") says nothing, so it reads as no summary. Null when there is none.
 */
export function sessionHeaderSummary(
  session: Pick<TerminalSessionInfo, 'paneTitle' | 'taskSummary' | 'agentPreset'> | null | undefined,
): string | null {
  if (!session) return null;
  const product = getAgentDisplayName(session.agentPreset)?.toLowerCase() ?? '';
  for (const raw of [session.paneTitle, session.taskSummary]) {
    const text = (raw ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (lower === product || /^(claude code|codex( cli)?|gemini( cli)?|opencode|aider)$/i.test(text)) continue;
    return text;
  }
  return null;
}

/** {@link sessionHeaderSummary} for a session id, in any project. */
export function getSessionHeaderSummary(id: number): string | null {
  return sessionHeaderSummary(findSessionAnyProject(id));
}

export function getSessionPaneDisplayTitle(session: TerminalSessionInfo, allSessions: TerminalSessionInfo[]): string {
  const paneTitle = session.paneTitle?.trim();
  if (paneTitle) return paneTitle;

  const taskSummary = session.taskSummary?.trim();
  if (taskSummary) return taskSummary;

  return session.role ? getSessionLabel(session, allSessions) : session.title;
}

export function getSessionPaneSecondaryTitle(session: TerminalSessionInfo): string {
  const paneTitle = session.paneTitle?.trim();
  const taskSummary = session.taskSummary?.trim();
  if (!paneTitle || !taskSummary || paneTitle === taskSummary) return '';
  return taskSummary;
}

export function getSessionDisplayName(session: TerminalSessionInfo, allSessions: TerminalSessionInfo[]): string {
  const title = getSessionPaneDisplayTitle(session, allSessions);
  const agentName = getAgentDisplayName(session.agentPreset);
  if (!agentName) return title;
  return title.toLowerCase() === agentName.toLowerCase() ? title : `${agentName} · ${title}`;
}

export function getSessionPromptTargetLabel(session: TerminalSessionInfo, allSessions: TerminalSessionInfo[]): string {
  const assistantName = session.agentName?.trim();
  if (assistantName) return assistantName;
  const agentName = getAgentDisplayName(session.agentPreset);
  if (!agentName) return getSessionLabel(session, allSessions);

  const sameAgentSessions = allSessions.filter(
    (entry) => entry.isRunning && entry.agentPreset === session.agentPreset
  );
  if (sameAgentSessions.length <= 1) return agentName;

  const idx = sameAgentSessions.findIndex((entry) => entry.id === session.id);
  return idx === -1 ? agentName : `${agentName} ${idx + 1}`;
}

export function setSessionRole(id: number, role: string | null) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => (x.id === id ? { ...x, role } : x)),
  }), isDev);
}

/**
 * The project an externally-triggered spawn should land in — used by the MCP
 * bridge, which receives a spawn request from an agent process and has no
 * project context of its own. Returns the normal ambient's active project; a
 * spawn arriving with no project open has nowhere to go and must be refused
 * rather than guessed at.
 */
export function getActiveTerminalProjectId(): string | null {
  return activeTerminalProjectId;
}

export function setSessionWorktree(id: number, worktree: WorktreeInfo | null) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => (x.id === id ? { ...x, worktree } : x)),
  }), isDev);
}

export function setSessionCwd(id: number, cwd: string | null) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => (x.id === id ? { ...x, cwd } : x)),
  }), isDev);
}

export function summarizeTerminalTask(text: string): string {
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .trim();
  if (!normalized) return '';
  const firstSentence = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
  const summary = firstSentence.trim();
  return summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
}

export function getAgentDisplayName(agentPreset: string | null | undefined): string | null {
  if (!agentPreset) return null;
  if (AGENT_DISPLAY_NAMES[agentPreset]) return AGENT_DISPLAY_NAMES[agentPreset];
  const custom = getCustomAgents().find((a) => a.command === agentPreset);
  return custom?.name ?? agentPreset;
}

export function isAgentSession(session: TerminalSessionInfo | null | undefined): boolean {
  if (!session) return false;
  return Boolean(session.agentPreset);
}

/**
 * Resolve the agent input that should receive context injected by another
 * surface, such as Preview's element inspector. Prefer the explicitly focused
 * agent, then the active pane's agent, and finally the most recently activated
 * running agent in the current project. Shell sessions are never targeted.
 */
export function getActiveAgentSessionId(): number | null {
  const candidates = [...get(sessions), ...get(devSessions)].filter(
    (session) => session.isRunning && isAgentSession(session),
  );
  if (candidates.length === 0) return null;

  const candidateIds = new Set(candidates.map((session) => session.id));
  for (const preferredId of [get(manualPromptTargetId), get(activeSessionId), get(devActiveSessionId)]) {
    if (preferredId !== null && candidateIds.has(preferredId)) return preferredId;
  }

  return [...candidates].sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0))[0]?.id ?? null;
}

const RUNNING_PROCESS_ROLES = new Set(['server', 'build']);

export function sessionHasRunningProcess(session: TerminalSessionInfo | null | undefined): boolean {
  if (!session || !session.isRunning) return false;
  const role = session.role?.trim().toLowerCase();
  return !!role && RUNNING_PROCESS_ROLES.has(role);
}

export async function ensureIdleOrCreateTerminal(rootPath: string, projectId: string, isDev = false): Promise<number | null> {
  const sessions = getProjectState(projectId, isDev).sessions;
  const reusable = sessions.filter(
    (s) => s.isRunning && !s.agentPreset && !s.ownerTaskId && !s.hidden && !sessionHasRunningProcess(s)
  );
  const shell = reusable.find((s) => !s.isExecuting) ?? reusable[0];
  if (shell) return shell.id;
  return await createTerminalSession(rootPath || undefined, undefined, projectId, { isDev });
}

export function setSessionTaskSummary(id: number, taskSummary: string | null) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => (x.id === id ? { ...x, taskSummary } : x)),
  }), isDev);
}

export function setSessionOwnerTask(id: number, ownerTaskId: string | null) {
  const isDev = devSessionIds.has(id);
  const projectId = terminalSessionProjects.get(id);
  if (!projectId) return;
  updateProjectState(projectId, (state) => ({
    ...state,
    sessions: state.sessions.map((x) => (x.id === id ? { ...x, ownerTaskId } : x)),
  }), isDev);
}

export type CommandBlock = {
  id: string;
  sessionId: number;
  command: string;
  startTime: number;
  endTime?: number;
  output: string;
  exitCode?: number;
  collapsed: boolean;
};

export const commandBlocks = writable<Map<number, CommandBlock[]>>(new Map());

export function startCommandBlock(sessionId: number, command: string) {
  const block: CommandBlock = {
    id: Math.random().toString(36).substring(2, 9),
    sessionId,
    command: command.trim(),
    startTime: Date.now(),
    output: '',
    collapsed: false,
  };
  commandBlocks.update((map) => {
    const copy = new Map(map);
    const list = copy.get(sessionId) ?? [];
    copy.set(sessionId, [...list, block].slice(-10));
    return copy;
  });
}

const _pendingBlockText = new Map<number, string>();
let _blockFlushTimer: ReturnType<typeof setTimeout> | null = null;

function _flushCommandBlockAppendBatch(batch: Map<number, string>) {
  if (batch.size === 0) return;
  commandBlocks.update((map) => {
    let dirty = false;
    const copy = new Map(map);
    for (const [id, text] of batch) {
      const list = copy.get(id);
      if (!list || list.length === 0) continue;
      const last = list[list.length - 1];
      if (last.endTime !== undefined) continue;
      copy.set(id, [...list.slice(0, -1), { ...last, output: (last.output + text).slice(-4000) }]);
      dirty = true;
    }
    return dirty ? copy : map;
  });
}

function _flushCommandBlockAppends() {
  _blockFlushTimer = null;
  if (_pendingBlockText.size === 0) return;
  const batch = new Map(_pendingBlockText);
  _pendingBlockText.clear();
  _flushCommandBlockAppendBatch(batch);
}

function _flushCommandBlockAppendsForSession(sessionId: number) {
  const text = _pendingBlockText.get(sessionId);
  if (!text) return;
  _pendingBlockText.delete(sessionId);
  _flushCommandBlockAppendBatch(new Map([[sessionId, text]]));
  if (_pendingBlockText.size === 0 && _blockFlushTimer !== null) {
    clearTimeout(_blockFlushTimer);
    _blockFlushTimer = null;
  }
}

export function appendToCommandBlock(sessionId: number, text: string) {
  _pendingBlockText.set(sessionId, (_pendingBlockText.get(sessionId) ?? '') + text);
  if (_blockFlushTimer === null) {
    _blockFlushTimer = setTimeout(_flushCommandBlockAppends, 300);
  }
}

export function finalizeCommandBlock(sessionId: number) {
  finalizeCommandBlockWithExit(sessionId);
}

export function finalizeCommandBlockWithExit(sessionId: number, exitCode?: number) {
  _flushCommandBlockAppendsForSession(sessionId);

  commandBlocks.update((map) => {
    const list = map.get(sessionId);
    if (!list || list.length === 0) return map;
    const last = list[list.length - 1];
    if (last.endTime !== undefined) return map;
    const copy = new Map(map);
    const finalizedBlock = { ...last, endTime: Date.now(), exitCode, collapsed: true };
    const updated = [...list.slice(0, -1), finalizedBlock];
    copy.set(sessionId, updated);
    return copy;
  });
}

export function toggleCommandBlockCollapse(sessionId: number, blockId: string) {
  commandBlocks.update((map) => {
    const list = map.get(sessionId);
    if (!list) return map;
    const copy = new Map(map);
    copy.set(sessionId, list.map((b) => b.id === blockId ? { ...b, collapsed: !b.collapsed } : b));
    return copy;
  });
}

export function findAvailablePaneForAgentRun(isDev = false) {
  const paneAssignmentsStore = isDev ? devPaneAssignments : paneAssignments;
  const activePaneIndexStore = isDev ? devActivePaneIndex : activePaneIndex;
  const sessionsStore = isDev ? devSessions : sessions;

  const panes = get(paneAssignmentsStore);
  const activeIdx = get(activePaneIndexStore);
  const allSessions = get(sessionsStore);

  const isIdleShell = (sessionId: number | null): boolean => {
    if (sessionId === null) return false;
    const session = allSessions.find((entry) => entry.id === sessionId);
    if (!session) return false;
    if (sessionHasRunningProcess(session)) return false;
    return Boolean(session.isRunning) && !isAgentSession(session) && !session.isExecuting;
  };

  for (let paneIdx = 0; paneIdx < panes.length; paneIdx += 1) {
    if (paneIdx === activeIdx) continue;
    if (panes[paneIdx] === null) return { paneIdx, sessionId: null as number | null };
  }

  for (let paneIdx = 0; paneIdx < panes.length; paneIdx += 1) {
    if (paneIdx === activeIdx) continue;
    if (isIdleShell(panes[paneIdx])) return { paneIdx, sessionId: panes[paneIdx] };
  }

  if (panes[activeIdx] === null) {
    return { paneIdx: activeIdx, sessionId: null as number | null };
  }
  if (isIdleShell(panes[activeIdx])) {
    return { paneIdx: activeIdx, sessionId: panes[activeIdx] };
  }

  return null;
}

let mosaicGrowFn: (() => number) | null = null;
let devMosaicGrowFn: (() => number) | null = null;

export function registerMosaicGrow(fn: (() => number) | null, isDev = false) {
  if (isDev) {
    devMosaicGrowFn = fn;
  } else {
    mosaicGrowFn = fn;
  }
}

let mosaicClosePaneFn: ((paneIndex: number) => void) | null = null;
let devMosaicClosePaneFn: ((paneIndex: number) => void) | null = null;

export function registerMosaicClose(fn: ((paneIndex: number) => void) | null, isDev = false) {
  if (isDev) {
    devMosaicClosePaneFn = fn;
  } else {
    mosaicClosePaneFn = fn;
  }
}

/**
 * Create a pane and actually launch an agent CLI in it.
 *
 * This is the ONE launch sequence — brief files, display title, MCP launch
 * flags, detection suppression, and the typed command. Anything that wants an
 * agent running must come through here: `createTerminalSession` on its own opens
 * a bare shell with `agentPreset` recorded as metadata and never starts the CLI,
 * which looks like a launched agent in every list and pane header while the
 * prompt goes to a shell prompt that has no idea what to do with it.
 *
 * `command` is the launch command, so a user's custom agent (`aider --no-x`)
 * works exactly like a built-in preset.
 */
export type ChatVisualsSpot = { dir: string; baseUrl: string };

/** Each agent session's chat-visuals folder and the URL its pages are served under. */
const sessionVisuals = new Map<number, ChatVisualsSpot>();

export function getSessionVisuals(id: number): ChatVisualsSpot | null {
  return sessionVisuals.get(id) ?? null;
}

export function setSessionVisuals(id: number, spot: ChatVisualsSpot | null): void {
  if (spot) sessionVisuals.set(id, spot);
  else sessionVisuals.delete(id);
}

export async function spawnAgentPreset(
  command: string,
  cwd?: string,
  opts?: {
    activate?: boolean;
    skipAutoBrief?: boolean;
    isDev?: boolean;
    /**
     * Project the pane belongs to. Needed by callers outside the active-project
     * flow (an MCP spawn arrives from a background process); omitted, the
     * session resolves the active project as before.
     */
    projectId?: string;
    /** Chat-only permission override. Undefined preserves the established CLI
     * global/per-agent setting; an empty string explicitly launches supervised. */
    permissionArgsOverride?: string;
    /** Provider-native model/reasoning flags for this one Chat session. */
    runtimeArgs?: string;
    /**
     * Launch under a specific signed-in account rather than the user's current
     * selection. Failover passes this so a successor can run on an account that
     * still has headroom without moving the picker in Settings.
     */
    accountId?: string | null;
    /**
     * Run against the new session before the CLI is launched. Used to attach a
     * worktree, which has to be registered while the pane is still empty — the
     * reconciler stages that branch back, and a late registration races the
     * agent's first commit.
     */
    onSessionCreated?: (sessionId: number) => void;
  }
): Promise<number | null> {
  const activate = opts?.activate ?? true;
  const isDev = opts?.isDev ?? false;
  const projectForFocus = isDev ? activeDevTerminalProjectId : activeTerminalProjectId;
  const priorActive = projectForFocus
    ? {
        sessionId: getProjectState(projectForFocus, isDev).activeSessionId,
        paneIndex: getProjectState(projectForFocus, isDev).activePaneIndex,
      }
    : null;

  // Resolve the effective launch before the session exists: the env has to be
  // in place at PTY creation (Goose's `GOOSE_MODE=auto` cannot be injected
  // after the fact), and the args land on the typed command below.
  const launchOverrides = {
    agentCmdOverrides: get(agentCmdOverrides),
    agentDefaultArgs: get(agentDefaultArgs),
    agentDefaultEnv: get(agentDefaultEnv),
  };
  const permissionMode = get(agentPermissionMode);
  const launchCommand = resolveAgentLaunchCommand(command, launchOverrides);
  const defaultLaunchArgs = resolveAgentLaunchArgs(command, permissionMode, launchOverrides);
  const launchArgs = opts?.permissionArgsOverride === undefined
    ? defaultLaunchArgs
    : opts.permissionArgsOverride.trim();
  const runtimeArgs = opts?.runtimeArgs?.trim() ?? '';
  const launchEnv = resolveAgentLaunchEnv(command, permissionMode, launchOverrides);

  // Point the CLI at the selected account's config directory. Empty for the
  // default account and for every CLI that doesn't do account switching, so
  // this needs no per-provider branching here. Merged *under* `launchEnv` on
  // purpose: an env var the user set themselves in Settings is a deliberate
  // override and must outrank the account picker.
  const accountEnv = await accountEnvFor(command, opts?.accountId);
  // DeepSeek Harness has no terminal UI: its session stays a plain shell until
  // the goal arrives, when `deliverDeepSeekTask` types a headless launch. Only
  // the env has to be in place now. Dynamic import: the service reaches stores
  // that import this module.
  const deepSeek = isDeepSeekHarnessCommand(command) ? await import('$lib/services/deepseek-harness') : null;
  let deepSeekEnv: Record<string, string> = {};
  if (deepSeek) {
    const problem = await deepSeek.deepSeekWorkerProblem();
    if (problem) {
      showToast(problem, 'error', 10000);
      return null;
    }
    const { getMcpHttpUrl } = await import('./mcpBridge');
    deepSeekEnv = deepSeek.deepSeekWorkerEnv(await getMcpHttpUrl());
  }
  // A scratch folder for inline chat visuals (`::spacron-visual{…}`): the agent
  // writes HTML pages there and the chat view shows them. Local only: on a
  // remote box the folder would not exist where the agent runs.
  let visuals: ChatVisualsSpot | null = null;
  if (!get(remoteTarget)) {
    try {
      visuals = await invoke<ChatVisualsSpot>('chat_visuals_prepare', { key: crypto.randomUUID() });
    } catch (err) {
      console.warn('Chat visuals folder unavailable:', err);
    }
  }
  const visualsEnv: Record<string, string> = visuals ? { SPACRON_CHAT_VISUALS_DIR: visuals.dir } : {};
  const effectiveEnv = { ...accountEnv, ...launchEnv, ...deepSeekEnv, ...visualsEnv };

  const sessionId = await createTerminalSession(cwd, undefined, opts?.projectId, {
    assignPane: false,
    agentPreset: command,
    isDev,
    extraEnv: effectiveEnv,
  });
  if (sessionId === null || sessionId === undefined) return null;
  if (visuals) sessionVisuals.set(sessionId, visuals);

  opts?.onSessionCreated?.(sessionId);

  let rulesBriefed = false;
  const briefRoot = cwd ?? resolveSessionRoot(sessionId);
  if (briefRoot) {
    if (agentReadsRulesFile(command) || agentHasNativeExtras(command)) {
      try { rulesBriefed = await ensureAgentRulesFiles(briefRoot, command); }
      catch (err) { console.error('Failed to ensure agent rules files:', err); }
    }
    // Deliberately NOT gated on `agentReadsRulesFile`: the orchestrator protocol
    // is delivered as a file any agent reads on demand (its one-line role brief
    // points at it), so it must be present whatever preset was launched.
    try { await ensureOrchestratorBrief(briefRoot); }
    catch (err) { console.error('Failed to ensure orchestrator brief:', err); }
  }
  markSessionAgentPreset(sessionId, command, opts?.skipAutoBrief || rulesBriefed || undefined);
  const displayName = getAgentDisplayName(command) ?? command;
  updateSessionTitle(sessionId, displayName);
  // Appended to the typed command, not the environment: Claude Code discovers
  // the Spacron MCP server only from `--mcp-config`. Empty for every other preset.
  const mcpFlags = await mcpLaunchFlags(command, briefRoot ?? undefined, sessionId);

  // `command` (not `launchCommand`) stays the preset key for detection, rules
  // files and display names; only the line written to the PTY carries the
  // resolved command + permission args + MCP flags.
  const launchLine = `${launchCommand}${launchArgs ? ` ${launchArgs}` : ''}${runtimeArgs ? ` ${runtimeArgs}` : ''}${platformLaunchFlags(command)}${mcpFlags}`;

  if (deepSeek) {
    deepSeek.markDeepSeekWorkerSession(sessionId);
  } else {
    agentLaunchStartLengths.set(sessionId, getSessionOutputLength(sessionId));
    suppressAgentDetection.add(sessionId);
    try {
      writeToSession(sessionId, launchLine + '\r');
    } finally {
      suppressAgentDetection.delete(sessionId);
    }
  }

  if (!activate && projectForFocus && priorActive?.sessionId != null && priorActive.sessionId !== sessionId) {
    updateProjectState(projectForFocus, (state) => ({
      ...state,
      activeSessionId: priorActive.sessionId,
    }), isDev);
  }

  return sessionId;
}

export function resizeSession(id: number, rows: number, cols: number) {
  const pty = ptyInstances.get(id);
  if (pty) {
    pty.resize(cols, rows).catch((err) => console.error('Failed to resize terminal:', err));
  }
}

export async function killAllSessions() {
  const ids = Array.from(ptyInstances.keys());
  await Promise.all(ids.map((id) => killSession(id)));
  dataCallbacks.clear();
  exitCallbacks.clear();
  sessionOutputBuffers.clear();
  sessionOutputDecoders.clear();
  releaseStartupShellClaim();
  sessionInputBuffers.clear();
  agentLaunchStartLengths.clear();
  terminalSessionProjects.clear();
  suppressAgentDetection.clear();
  closingSessions.clear();
  autoBriefInFlight.clear();
  devSessionIds.clear();
  commandBlocks.set(new Map());
  _pendingBlockText.clear();
  // Each killSession above already emptied its project's session list through
  // updateProjectState; this just makes sure the cross-project view agrees even
  // if a project had state but no live pty.
  publishProjectTerminalStates(false);
  publishProjectTerminalStates(true);
}

export async function killSession(id: number) {
  const projectId = terminalSessionProjects.get(id);
  const isDev = devSessionIds.has(id);

  const paneIndexForMosaicClose = projectId
    ? getProjectState(projectId, isDev).paneAssignments.indexOf(id)
    : get(isDev ? devPaneAssignments : paneAssignments).indexOf(id);

  const siblings = projectId
    ? getProjectState(projectId, isDev).sessions
    : get(isDev ? devSessions : sessions);
  const closing = siblings.find((s) => s.id === id);
  // Remember what this terminal was called before we drop it from state — the
  // pty's exit event arrives after, and that is what names the toast.
  if (closing) {
    // The session is removed before its PTY exit callback runs, so preserve the
    // hidden flag too. Otherwise an automatic hidden-shell cleanup looks like
    // a user closing a visible terminal and emits a misleading toast.
    closingSessions.set(id, {
      label: getSessionLabel(closing, siblings),
      hidden: Boolean(closing.hidden),
    });
  }

  if (projectId) {
    // Closing the pane is where a worktree's disk space comes back, but it used to
    // remove the checkout outright — destroying any edits the agent had not
    // committed. Reclaim instead: stage what's outstanding (which snapshots
    // uncommitted work onto the branch) and only delete once git confirms nothing
    // is left. If it can't be moved, keep the worktree and say so.
    if (closing?.worktree) {
      const worktree = closing.worktree;
      void (async () => {
        const outcome = await reclaimWorktree(projectId, worktree, { deleteBranch: false });
        if (outcome.removed) {
          forgetWorktree(worktree.path);
          if (outcome.staged > 0) {
            showToast(
              `Staged ${outcome.staged} file change${outcome.staged === 1 ? '' : 's'} from the closed agent. Review it in Source Control.`,
              'info',
              7000,
            );
          }
        } else {
          showToast(
            outcome.reason === 'conflict'
              ? `Kept branch '${worktree.branch}'. Its changes conflict with your working tree and need resolving.`
              : `Kept branch '${worktree.branch}'. It still holds ${outcome.pendingFiles} unstaged file change${outcome.pendingFiles === 1 ? '' : 's'}`,
            'warning',
            10000,
          );
        }
      })();
    }
  }

  if (projectId) {
    updateProjectState(projectId, (state) => {
      const sessions = state.sessions.filter((x) => x.id !== id);
      const paneAssignments = state.paneAssignments.map((p) => (p === id ? null : p));
      const activeSessionId = state.activeSessionId === id
        ? (sessions.length > 0 ? sessions[sessions.length - 1].id : null)
        : state.activeSessionId;
      return {
        ...state,
        sessions,
        paneAssignments,
        activeSessionId,
      };
    }, isDev);
  } else {
    const paneAssignmentsStore = isDev ? devPaneAssignments : paneAssignments;
    const activeSessionIdStore = isDev ? devActiveSessionId : activeSessionId;
    const sessionsStore = isDev ? devSessions : sessions;
    sessionsStore.update((s) => s.filter((x) => x.id !== id));
    paneAssignmentsStore.update((panes) => panes.map((p) => (p === id ? null : p)));
    activeSessionIdStore.update((active) => {
      if (active !== id) return active;
      const $sessions = get(sessions);
      return $sessions.length > 0 ? $sessions[$sessions.length - 1].id : null;
    });
  }

  dataCallbacks.delete(id);
  exitCallbacks.delete(id);
  sessionOutputBuffers.delete(id);
  sessionOutputDecoders.delete(id);
  sessionInputBuffers.delete(id);
  agentLaunchStartLengths.delete(id);
  terminalSessionProjects.delete(id);
  commandBlocks.update((map) => { const c = new Map(map); c.delete(id); return c; });
  _pendingBlockText.delete(id);
  // Images dropped on this session's agent panel are held as object URLs, which
  // pin their Blobs in the renderer until revoked. Nothing revoked them when a
  // session closed — the entry simply stayed in the map — so every image ever
  // attached leaked for the life of the window. `clear` does the revoking.
  agentPanelImages.clear(id);

  // Close the mosaic cell so surrounding terminals reclaim the freed space.
  // No-op when: called from closePane (cell already removed before killSession),
  // the session was orphaned (paneIndex === -1), or TerminalPanel isn't mounted.
  if (paneIndexForMosaicClose !== -1 && mosaicClosePaneFn) {
    mosaicClosePaneFn(paneIndexForMosaicClose);
  }

  // Tear the pty down in the background; state no longer depends on it.
  const pty = ptyInstances.get(id);
  if (pty) {
    ptyInstances.delete(id);
    await pty.close().catch((err) => console.error('Failed to close terminal:', err));
  } else {
    // A resource-panel row can list a backend session the webview never
    // attached a PtySession to (e.g. a session created while the webview was
    // down, or one that only lives in the pty manager). There is no handle to
    // close, so tell the backend directly — otherwise the process keeps
    // running with no way to stop it from this surface. "Session not found"
    // here is the already-exited case (the exit path freed it first) — not an
    // error worth logging.
    try {
      await closeBackendSession(id);
    } catch (err) {
      if (!String(err).includes('not found')) {
        console.error('Failed to close backend terminal:', err);
      }
    }
  }
}
