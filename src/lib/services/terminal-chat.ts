/**
 * Terminal ⇄ Chat view for agent panes, after Orca's design
 * (`.spacron/memory/orca-chat-view.md`).
 *
 * The chat is just another way of looking at the agent's terminal. The CLI
 * keeps running in its PTY and stays the only owner of the conversation:
 * - reading: the backend parses the transcript the CLI writes itself
 *   (`agent_transcript_read`), found from the pane's directory and launch time;
 * - writing: prompts go into the same PTY through `sendAgentPromptDirect`,
 *   which is how every other Spacron surface types into an agent TUI.
 * Nothing here starts a process, so flipping views can never fork the session.
 */

import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { get, writable } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { activeSessionId, getSessionOutputLength, relaunchAgentInSession, sessions, writeToSession } from '$lib/stores/terminal';
import { agentPermissionMode } from '$lib/stores/settings';
import { readTerminalScreen } from '$lib/services/terminal-screen';

/** Agent presets whose transcripts the chat view can read, mapped to their reader. */
const TRANSCRIPT_AGENTS: Record<string, TranscriptAgent> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok',
};

export type TranscriptAgent = 'claude' | 'codex' | 'opencode' | 'grok';

export function transcriptAgentFor(preset: string | null | undefined): TranscriptAgent | null {
  if (!preset) return null;
  return TRANSCRIPT_AGENTS[preset] ?? null;
}

/**
 * Whether this pane can switch to chat. Transcripts are read from this
 * machine's disk, so a remote workspace (agent on the box) stays terminal-only.
 */
export function canShowTerminalChat(preset: string | null | undefined): boolean {
  return transcriptAgentFor(preset) != null && get(remoteTarget) == null;
}

export interface TerminalChatItem {
  id: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice';
  text: string;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  toolStatus?: 'running' | 'done' | 'error' | null;
  time?: string | null;
}

export interface TranscriptResult {
  sessionId: string | null;
  revision: string | null;
  unchanged: boolean;
  messages: TerminalChatItem[];
  busy: boolean | null;
  truncated: boolean;
  model: string | null;
  effort: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
}

export type AgentLaunchView = 'terminal' | 'chat';

const LAUNCH_VIEW_KEY = 'spacron_agent_launch_view';

function loadLaunchView(): AgentLaunchView {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(LAUNCH_VIEW_KEY) === 'chat' ? 'chat' : 'terminal';
  } catch {
    return 'terminal';
  }
}

/**
 * How a newly launched agent opens: in its terminal, or in the chat view of
 * that same terminal. Set in Settings → Agents; agents the chat view cannot
 * read always open in the terminal.
 */
export const agentLaunchView = writable<AgentLaunchView>(loadLaunchView());

agentLaunchView.subscribe((view) => {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(LAUNCH_VIEW_KEY, view);
  } catch {
    // Restricted storage: the choice lasts for this session only.
  }
});

/** Put a just-launched agent pane in the requested (or default) view. */
export function applyLaunchView(sessionId: number, preset: string, view?: AgentLaunchView): void {
  const wanted = view ?? get(agentLaunchView);
  setTerminalChatView(sessionId, wanted === 'chat' && canShowTerminalChat(preset));
}

const chatViewSessions = writable<ReadonlySet<number>>(new Set());

export function isTerminalChatView(sessionId: number): boolean {
  return get(chatViewSessions).has(sessionId);
}

export function setTerminalChatView(sessionId: number, on: boolean): void {
  const current = get(chatViewSessions);
  if (current.has(sessionId) === on) return;
  const next = new Set(current);
  if (on) next.add(sessionId);
  else next.delete(sessionId);
  chatViewSessions.set(next);
  if (!on) boundTranscripts.delete(sessionId);
}

export function toggleTerminalChatView(sessionId: number): void {
  setTerminalChatView(sessionId, !isTerminalChatView(sessionId));
}

/**
 * Flip the focused agent pane between Terminal and Chat (the shortcut that used
 * to switch the whole window between Code and Chat mode). False when the focused
 * pane is not an agent the chat view can read.
 */
export function toggleActiveTerminalChatView(): boolean {
  const id = get(activeSessionId);
  if (id == null) return false;
  const session = get(sessions).find((s) => s.id === id);
  if (!canShowTerminalChat(session?.agentPreset)) return false;
  toggleTerminalChatView(id);
  return true;
}

export function useTerminalChatView(sessionId: number): boolean {
  return useStore(chatViewSessions).has(sessionId);
}

/**
 * Provider session each pane's chat view is showing. Other panes exclude these
 * so two agents started in the same folder never show each other's transcript.
 */
const boundTranscripts = new Map<number, string>();

export function bindTranscript(sessionId: number, providerSessionId: string | null): void {
  if (providerSessionId) boundTranscripts.set(sessionId, providerSessionId);
  else boundTranscripts.delete(sessionId);
}

export function forgetTerminalChat(sessionId: number): void {
  boundTranscripts.delete(sessionId);
  setTerminalChatView(sessionId, false);
}

export async function readTerminalTranscript(args: {
  sessionId: number;
  agent: TranscriptAgent;
  cwd: string;
  sinceMs: number;
  boundSessionId: string | null;
  knownRevision: string | null;
}): Promise<TranscriptResult> {
  const exclude = [...boundTranscripts.entries()]
    .filter(([pane]) => pane !== args.sessionId)
    .map(([, provider]) => provider);
  return invoke<TranscriptResult>('agent_transcript_read', {
    query: {
      agent: args.agent,
      cwd: args.cwd,
      sinceMs: args.sinceMs,
      sessionId: args.boundSessionId,
      exclude,
      knownRevision: args.knownRevision,
    },
  });
}

/** Normalise text the way both a pending send and its transcript row can be compared. */
export function sendMatchKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Session options: model and reasoning effort, changed inside the running CLI
// ---------------------------------------------------------------------------

/**
 * How each CLI takes a model or effort change mid-session. This is Orca's
 * table: Claude Code and Grok accept `/model <id>` and `/effort <level>`;
 * Codex only opens its own picker (`/model`), so that pick happens in the
 * terminal; OpenCode has no mid-session command, so its model shows read-only.
 */
export type SessionOptionApply =
  | { kind: 'command'; build: (value: string) => string }
  | { kind: 'relaunch' }
  | { kind: 'none' };

/**
 * How each CLI takes a model or effort change. Claude Code and Grok accept
 * `/model <id>` and `/effort <level>` mid-session (Orca's table). Codex only
 * has its own picker, so Spacron applies the pick at launch instead: exit and
 * resume the same session with `-m` / `model_reasoning_effort`. OpenCode's
 * model shows read-only.
 */
export function modelApplyFor(agent: TranscriptAgent): SessionOptionApply {
  switch (agent) {
    case 'claude':
    case 'grok':
      return { kind: 'command', build: (value) => `/model ${value}` };
    case 'codex':
      return { kind: 'relaunch' };
    default:
      return { kind: 'none' };
  }
}

export function effortApplyFor(agent: TranscriptAgent): SessionOptionApply {
  switch (agent) {
    case 'claude':
    case 'grok':
      return { kind: 'command', build: (value) => `/effort ${value}` };
    case 'codex':
      return { kind: 'relaunch' };
    default:
      return { kind: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Permission modes (Orca's per-agent table and copy)
// ---------------------------------------------------------------------------

export type ChatPermissionMode = 'ask' | 'accept-edits' | 'auto' | 'full-access';

export const PERMISSION_MODE_COPY: Record<ChatPermissionMode, { label: string; description: string }> = {
  ask: { label: 'Ask for approval', description: "Asks before edits or commands it isn't already allowed to make" },
  'accept-edits': { label: 'Accept edits', description: 'Approves file edits and file commands; asks for the rest' },
  auto: { label: 'Approve for me', description: 'Reviews approval requests for you' },
  'full-access': { label: 'Full access', description: 'Never asks before edits or commands' },
};

export function permissionDescription(agent: TranscriptAgent, mode: ChatPermissionMode): string {
  if (agent === 'claude' && mode === 'ask') return "Asks before edits and commands your settings don't allow";
  if (agent === 'codex' && mode === 'full-access') return 'Never asks; can edit any file and use the network';
  return PERMISSION_MODE_COPY[mode].description;
}

export function permissionModesFor(agent: TranscriptAgent): ChatPermissionMode[] {
  switch (agent) {
    case 'claude': return ['ask', 'accept-edits', 'auto', 'full-access'];
    case 'codex':
    case 'grok': return ['ask', 'auto', 'full-access'];
    default: return ['ask', 'full-access'];
  }
}

/** The CLI flags for a permission mode, checked against each CLI's --help. */
export function permissionArgs(agent: TranscriptAgent, mode: ChatPermissionMode): string {
  switch (agent) {
    case 'claude':
      if (mode === 'full-access') return '--dangerously-skip-permissions';
      if (mode === 'auto') return '--permission-mode auto';
      if (mode === 'accept-edits') return '--permission-mode acceptEdits';
      return '--permission-mode manual';
    case 'codex':
      // Every field stated, so the user's config.toml cannot turn Ask into no prompts (Orca's rule).
      if (mode === 'full-access') return '--dangerously-bypass-approvals-and-sandbox';
      if (mode === 'auto') return '--approve-for-me';
      return '-a on-request -s read-only -c approvals_reviewer="user"';
    case 'grok':
      if (mode === 'full-access') return '--permission-mode bypassPermissions';
      if (mode === 'auto') return '--permission-mode auto';
      return '--permission-mode default';
    case 'opencode':
      return mode === 'full-access' ? '--auto' : '';
  }
}

export function resumeArgs(agent: TranscriptAgent, providerSessionId: string): string {
  switch (agent) {
    case 'claude': return `--resume ${providerSessionId}`;
    case 'codex': return `resume ${providerSessionId}`;
    case 'grok': return `-r ${providerSessionId}`;
    case 'opencode': return `--session ${providerSessionId}`;
  }
}

function modelArgs(agent: TranscriptAgent, model: string | null, effort: string | null): string {
  const parts: string[] = [];
  if (agent === 'codex') {
    if (model) parts.push(`-m ${model}`);
    if (effort) parts.push(`-c model_reasoning_effort="${effort}"`);
  } else if (agent === 'claude') {
    if (model) parts.push(`--model ${model}`);
    if (effort) parts.push(`--effort ${effort}`);
  } else if (agent === 'grok') {
    if (model) parts.push(`-m ${model}`);
    if (effort) parts.push(`--reasoning-effort ${effort}`);
  }
  return parts.join(' ');
}

type LaunchState = { permission: ChatPermissionMode; model: string | null; effort: string | null };

/** What each pane's CLI was last launched with from the chat view. */
const launchState = new Map<number, LaunchState>();
const launchStateStore = writable(0);

/** The permission mode a pane runs under: its last chat-view relaunch, else the app setting it was spawned with. */
export function sessionPermissionMode(sessionId: number): ChatPermissionMode {
  return launchState.get(sessionId)?.permission ?? (get(agentPermissionMode) === 'yolo' ? 'full-access' : 'ask');
}

export function useSessionPermissionMode(sessionId: number): ChatPermissionMode {
  useStore(launchStateStore);
  useStore(agentPermissionMode);
  return sessionPermissionMode(sessionId);
}

/** PowerShell, cmd and POSIX prompts, i.e. the CLI has handed the shell back. */
const SHELL_PROMPT = /(^PS [^>]*>\s*$)|(^[A-Za-z]:\\[^>]*>\s*$)|([$#%]\s*$)/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the pane shows a shell prompt again after output has gone quiet. */
async function waitForShellPrompt(sessionId: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  let lastLen = getSessionOutputLength(sessionId);
  let quietSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(200);
    const len = getSessionOutputLength(sessionId);
    if (len !== lastLen) {
      lastLen = len;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince < 500) continue;
    const screen = readTerminalScreen(sessionId, { maxLines: 6 }) ?? '';
    const lastLine = screen.split('\n').map((l) => l.trimEnd()).filter(Boolean).pop() ?? '';
    if (SHELL_PROMPT.test(lastLine)) return true;
  }
  return false;
}

/**
 * Apply a launch-time option by restarting the CLI in its own terminal and
 * resuming the same conversation; Orca applies Claude permission picks the same
 * way. Callers only offer this between turns. Returns an error, or null.
 */
export async function relaunchTerminalAgent(
  sessionId: number,
  preset: string,
  providerSessionId: string | null,
  patch: Partial<LaunchState>,
): Promise<string | null> {
  const agent = transcriptAgentFor(preset);
  if (!agent) return 'This agent has no chat view.';
  if (!providerSessionId) return 'Send a first message so there is a conversation to resume.';
  const current = launchState.get(sessionId) ?? { permission: sessionPermissionMode(sessionId), model: null, effort: null };
  const next = { ...current, ...patch };
  await typeSlashCommand(sessionId, '/exit');
  if (!(await waitForShellPrompt(sessionId, 8000))) {
    return "The agent didn't exit, so nothing changed. Check the terminal view.";
  }
  const args = [
    resumeArgs(agent, providerSessionId),
    permissionArgs(agent, next.permission),
    modelArgs(agent, next.model, next.effort),
  ].filter(Boolean).join(' ');
  if (!(await relaunchAgentInSession(sessionId, preset, args))) return "Couldn't restart the agent in this terminal.";
  launchState.set(sessionId, next);
  launchStateStore.update((n) => n + 1);
  return null;
}

/**
 * Type a slash command into the CLI as keystrokes, then press Enter on its own
 * write. A bracketed paste would land as prompt text instead of a command, and
 * an Enter in the same write as the text is read as part of it.
 */
export async function typeSlashCommand(sessionId: number, command: string): Promise<void> {
  writeToSession(sessionId, command);
  await new Promise((resolve) => setTimeout(resolve, 160));
  writeToSession(sessionId, '\r');
}

export interface ContextUsage {
  used: number;
  window: number | null;
  /** The window is inferred from the model rather than reported by the CLI. */
  estimated: boolean;
}

/**
 * Codex records its window; Claude Code does not, so it is inferred: 1M for
 * `[1m]` models or once usage has passed 200k (it could not otherwise fit),
 * else the standard 200k. OpenCode and Grok record no window.
 */
export function contextUsageFor(
  agent: TranscriptAgent,
  model: string | null,
  used: number | null,
  window: number | null,
): ContextUsage | null {
  if (!used) return null;
  if (window) return { used, window, estimated: false };
  if (agent === 'claude') {
    const large = /\[1m\]/i.test(model ?? '') || used > 200_000;
    return { used, window: large ? 1_000_000 : 200_000, estimated: true };
  }
  return { used, window: null, estimated: true };
}

/** `18.6k`, `981k`, `1M`: compact token counts. */
export function formatTokens(tokens: number): string {
  const safe = Math.max(0, tokens);
  if (safe >= 999_950) return `${trimZero((safe / 1_000_000).toFixed(1))}M`;
  if (safe >= 1_000) return `${trimZero((safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1))}k`;
  return String(Math.round(safe));
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}
