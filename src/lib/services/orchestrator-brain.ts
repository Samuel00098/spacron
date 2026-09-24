import {
  AgentTransport,
  DEFAULT_AGENT_BUDGETS,
  validateToolCall,
  type AgentCheckpoint,
  type AgentBudgets,
} from './orchestrator/agent-transport';
import { streamingReplyPreview } from './orchestrator/reply-stream';
import { getAgentProviderCapabilities, isChatAgentProvider } from './chat-provider-adapters';
import { loadLiveAgentProviderModels, peekLiveAgentProviderModels } from './live-agent-models';
import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import {
  aiProvider,
  currentAiModel,
  type AiProviderId,
  getProviderDef,
  isLocalProvider,
  getProviderBaseUrl,
  providerSetupHint,
  orchestratorCustomSkills,
  orchestratorDisabledSkills,
} from '$lib/stores/settings';
import { isProviderApiKeyConfiguredLocal } from '$lib/services/ai-keychain';
import { cleanOrchestratorReply, hasReadEvidence, hasUnverifiedMutation, isDeferredCompletionReply, isPromiseOnlyReply, mediaGenerationRequest, userRequestText, attachedImagePaths, replyClaimsDocumentWrite, findClaimedWritePaths, writeEvidenceCoversClaims } from '$lib/services/orchestrator/chat-turn';
import { buildSkillsPrompt } from '$lib/services/orchestrator/skills';
import {
  BRAIN_ASK_TOOLS,
  BRAIN_READONLY_TOOLS,
  BRAIN_WRITE_TOOLS,
  brainToolProfile,
  brainToolSignature,
  buildBrainToolsPrompt,
  formatBrainToolResults,
  formatBrainToolResultIndex,
  isDoomLoop,
  parseBrainTodos,
  parseBrainToolCalls,
  toolArgStr,
  type BrainMode,
  type BrainToolCall,
  type BrainToolResult,
} from '$lib/services/orchestrator/brain-tools';
import type { AgentRole } from '$lib/services/orchestrator/agent-charter';
import { DIRECT_EDIT_FILE_LIMIT, EXPLICIT_SPAWN_RE, hasDelegationAction } from '$lib/services/orchestrator/delegation-policy';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { classifyRouting } from '$lib/services/jev';
import { suggestReasoningLevel } from '$lib/services/orchestrator/jev-reasoning';

export interface AgentChoice {
  command: string;
  name: string;
}

/**
 * One thing the orchestrator decided to do this turn. A single message can yield
 * several of these — e.g. "open two claude agents" → two `spawn` actions.
 *
 * Actions split into two families: AGENT actions (spawn/send/name/close) drive
 * the fleet of coding agents, and APP actions (navigate/open-file/…) drive the
 * application UI itself so the orchestrator works as a full in-app assistant.
 */
/**
 * Where the user SAID an agent should run. `null`/absent means they didn't say,
 * so the app has to ask. Structurally identical to `AgentPlacement` in
 * `$lib/stores/agentPlacement` — declared here so the brain stays free of store
 * imports.
 */
export type SpawnPlacement = 'worktree' | 'main';

const VALID_REASONING_EFFORTS: readonly ChatReasoningEffort[] = [
  'default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

export type OrchestratorAction =
  /**
   * Launch a new agent. Omit `prompt` to open it idle/ready; `name` labels it.
   * `role` assigns a team charter (coordinator/builder/scout/reviewer) when the
   * spawn is part of a divided plan. Set `skipWorktree` to true for admin/
   * release tasks (tagging, pushing, changelogs) that need the main branch.
   * `panelTaskId` is never set by the brain — only by an in-app dispatch that
   * launched this agent FROM a task-panel card, so completion can offer that
   * card a one-click move to Done.
   */
  | { kind: 'spawn'; agent: string; prompt?: string | null; name?: string | null; role?: AgentRole | null; files?: string[] | null; model?: string | null; reasoningEffort?: ChatReasoningEffort; skipWorktree?: boolean; placement?: SpawnPlacement | null; panelTaskId?: string | null }
  /** Push a new prompt to an already-running agent, addressed by its name. */
  | { kind: 'send'; target: string; prompt: string }
  /** Give a running agent a name (or rename it). */
  | { kind: 'name'; target: string; name: string }
  /** Stop a running agent and close its terminal. `target` is its name, or "all". */
  | { kind: 'close'; target: string }
  /** Switch the active page/panel (e.g. "editor", "preview", "tasks", "settings", "terminal"). */
  | { kind: 'navigate'; view: string }
  /** Open a file in the editor (path relative to the project root), optionally jumping to a line. */
  | { kind: 'open-file'; path: string; line?: number | null }
  /** Close an open editor file (path relative to the project root). */
  | { kind: 'close-file'; path: string }
  /** Point the preview browser at a URL or route (e.g. "/", "/login", a full URL). */
  | { kind: 'preview'; url: string }
  /** Run a shell command (or a named run preset) in a terminal. */
  | { kind: 'run'; command: string }
  /** Manage the task board: create a new item, move one by title, or delete one. */
  | { kind: 'task'; op: 'create' | 'todo' | 'doing' | 'done' | 'delete'; title: string }
  /** Change an application setting or the active theme (the things the user can
   *  set manually in Settings). `setting` names the option; `value` is its new value. */
  | { kind: 'setting'; setting: string; value: string | number | boolean }
  /** Switch the workspace's ambient arrangement (Focus = one room, Split = tiled rooms). */
  | { kind: 'layout'; mode: 'focus' | 'development' | 'gallery' | 'preview' }
  /** Focus / minimize / restore / close a specific room (panel or agent) by name. */
  | { kind: 'room'; op: 'focus' | 'minimize' | 'restore' | 'close'; target: string };

export interface RouteResult {
  /** Short conversational message shown back to the user. */
  reply: string;
  /** The actions the orchestrator wants to take this turn (may be empty for chat). */
  actions: OrchestratorAction[];
  /** True when an LLM produced this routing (vs the heuristic fallback). */
  viaLLM: boolean;
  /** Legacy project-file request, used when no direct tool executor is wired. */
  readFiles?: string[];
  /** True only when the model is blocked on a genuinely required answer. */
  needsInput?: boolean;
  inputRequest?: { question: string; options: string[]; target?: string };
  /** True when execution was deliberately stopped or could not be completed. */
  failed?: boolean;
  /** Optional task checklist items from the plan */
  todos?: string[];
}

export interface ConversationTurn {
  role: string;
  text: string;
}

export interface ProjectReadContext {
  path: string;
  content: string;
  truncated: boolean;
}

export interface BrainToolExecution {
  output: string;
  actions?: OrchestratorAction[];
  /** Screenshot files, attached as images for models that accept them. */
  images?: string[];
}

export type BrainToolExecutor = (call: BrainToolCall) => Promise<BrainToolExecution>;

/** A currently-running agent the orchestrator can address by name. */
export interface RunningAgentRef {
  name?: string | null;
  agent: string;
  title: string;
  /** Tail of the agent's terminal output, ANSI-stripped. Null when nothing captured yet. */
  recentOutput?: string | null;
}

/**
 * A task can keep its live session for follow-up messages after its latest
 * turn has ended. This separates that reusable-session state from the task's
 * lease status, so the brain does not call a finished turn "still in progress".
 */
export type AgentTurnState = 'working' | 'ready';

export interface AgentOutputRef extends RunningAgentRef {
  status: 'in-progress' | 'complete' | 'blocked' | 'failed' | 'cancelled';
  turnState?: AgentTurnState;
  updatedAt?: number | null;
  reason?: string | null;
  freshness?: string | null;
}

/** One agent's transcript, fetched on demand to be read aloud. */
export interface AgentTranscriptRead {
  /** The agent as the user refers to it ("Iris") — used in the spoken lead-in. */
  name: string;
  /** Cleaned transcript text, terminal escapes and redraw noise already stripped. */
  text: string;
  /** True when older output was dropped to keep the spoken read a sane length. */
  truncated: boolean;
}

/**
 * A structured read of what the user currently sees and is working with across
 * the whole application. Lets the orchestrator answer questions about the app
 * ("what's open?", "am I on the preview?") and choose app-control actions.
 */
export interface AppStateRef {
  /** The active main view, e.g. "editor" | "terminal" | "preview" | "tasks". */
  activeView?: string;
  settingsOpen?: boolean;
  /** Aux panels currently visible. */
  visiblePanels?: string[];
  /** The workspace's room layout: ambient arrangement + the open rooms. */
  layout?: {
    ambient: 'focus' | 'development' | 'gallery' | 'vibe' | 'preview';
    rooms: Array<{ title: string; focused: boolean; minimized: boolean }>;
  };
  sidebar?: { open: boolean; tab?: string };
  editor?: {
    activeFile?: string | null;
    openFiles?: string[];
    dirtyFiles?: string[];
    cursor?: { line: number; col: number } | null;
    /** Language of the active file (e.g. "typescript", "svelte"). */
    language?: string | null;
    /** Live text of the active file (capped). Null when not on the editor or binary. */
    content?: string | null;
    /** True when `content` was truncated to fit the token budget. */
    contentTruncated?: boolean;
    /** The text the user currently has highlighted in the editor (capped). */
    selection?: string | null;
  };
  terminals?: Array<{ label: string; agent?: string | null; cwd?: string | null; running: boolean; busy?: boolean; recentOutput?: string | null }>;
  preview?: { url?: string | null; running?: boolean };
  branch?: string | null;
  /** Views the assistant may navigate to. */
  availableViews?: string[];
  /** Saved run presets the assistant may launch by name. */
  availableRuns?: Array<{ name: string; command: string }>;
  /** Current user-configurable settings + theme, so the assistant can report and change them. */
  settings?: {
    /** Name of the active theme. */
    theme?: string | null;
    /** All theme names the assistant can switch to (by name). */
    availableThemes?: string[];
    /** Current values of the settings the assistant may change, keyed by setting name. */
    values?: Record<string, string | number | boolean>;
  };
}

export interface RouteContext {
  projectName?: string;
  projectRoot?: string;
  /** Recent persisted turns, including assistant replies, for follow-ups such as "do that". */
  conversation?: ConversationTurn[];
  recentUserMessages?: string[];
  taskMemory?: string[];
  taskPanel?: string[];
  /** Recent agent-to-agent traffic on the shared mailbox (claim/handoff/report/…). */
  mailbox?: string[];
  /** Authored, wikilinked knowledge notes the team has written for this project. */
  knowledge?: string[];
  /**
   * Index of previously written docs/ files (title + excerpt per path),
   * gathered at turn start so past plans and reports are answerable without
   * re-reading chat history or re-sweeping the project.
   */
  documentsIndex?: string;
  runningAgents?: RunningAgentRef[];
  reviewingAgents?: RunningAgentRef[];
  taskOutputs?: AgentOutputRef[];
  /**
   * Pull ONE agent's full cleaned transcript, for reading aloud on request.
   *
   * Supplied by the orchestrator, which owns transcripts; the brain only decides
   * that a read was asked for. Deliberately a callback rather than another field
   * on `taskOutputs`: full transcripts are far too large to carry in the route
   * prompt for every agent on every turn, and this fetches exactly one, only
   * when the user actually asks.
   *
   * Takes the raw message rather than a pre-matched name so resolution can span
   * both tasks and untracked live sessions — the brain only sees the former.
   * Returns null when no agent in the message can be resolved.
   */
  readAgentTranscript?: (request: string) => AgentTranscriptRead | null;
  /** The evolving brain profile — durable things learned about the user + project. */
  profile?: string[];
  /** Full read of the application UI state (active page, editor, terminals, …). */
  appState?: AppStateRef;
  llmConfig?: RouteLlmConfig;
  /** Compact project structure and files already fetched during this turn. */
  projectTree?: string;
  projectReads?: ProjectReadContext[];
  /** Results from direct brain tools, fed back before the next model call. */
  toolResults?: BrainToolResult[];
  /** A local instruction used for promise recovery and forced final passes. */
  executionNote?: string;
  toolExecutor?: BrainToolExecutor;
  maxToolRounds?: number;
  /**
   * Live progress callback: fires after each tool-execution round with the
   * results so far. Purely observational — the store uses it to update the
   * transcript between rounds; failures never affect routing.
   */
  onToolRound?: (results: BrainToolResult[], round: number) => void;
  /**
   * Messages the user steered into this turn while it runs (Codex-style): the
   * loop drains them before each model request and will not accept a FINAL
   * while one is waiting.
   */
  steering?: { pending: () => boolean; drain: () => string[] };
  /** Observational: wall-clock time of each model request, for the turn's timing line. */
  onModelCall?: (elapsedMs: number) => void;
  /**
   * Display only: the readable reply text of the model request in flight, as
   * it streams ('' when a new request starts). Tool rounds are never shown.
   * Must not affect routing; the finished response is parsed as usual.
   */
  onReplyStream?: (preview: string) => void;
  /**
   * The project's own check, run once when a turn that changed files is about
   * to finish without having verified them. Null when the project has none.
   */
  postEditCheck?: () => Promise<{ command: string; ok: boolean; output: string } | null>;
  signal?: AbortSignal;
  nativeTools?: boolean;
  checkpoint?: AgentCheckpoint;
  saveCheckpoint?: (state: AgentCheckpoint) => void | Promise<void>;
  budgets?: AgentBudgets;
  /**
   * Capability profile for this turn: 'ask'/'plan' physically remove mutating
   * tools; 'full' is the default. Ask/plan turns keep the todo planner and all
   * reads, so a research turn cannot write even if the model tries.
   */
  toolProfile?: BrainMode;
  /**
   * Spoken voice-conversation mode. The user is primarily *talking* with the
   * orchestrator, not commanding a fleet, so routing defaults to plain
   * conversation and only acts (spawn/send/close) on an explicit request.
   */
  conversational?: boolean;
  /**
   * The turn is SPOKEN (realtime voice call), not typed in the Chat panel.
   * Both set `conversational`, but only speech wants short, markdown-free
   * replies; a typed chat wants a full ChatGPT/Claude-style answer. Leaving
   * this unset in Chat is what keeps the voice style rules out of its prompt.
   */
  voice?: boolean;
}

export interface RouteLlmConfig {
  provider: AiProviderId;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
  baseUrl?: string;
  sessionId?: string;
  /**
   * Visible-output budget in tokens for this model's replies. The loop may
   * raise it mid-turn: a reasoning model that spends the default budget
   * thinking returns its FINAL answer truncated, which parses as an invalid
   * protocol response — more headroom, not another lecture, is the fix.
   */
  outputTokens?: number;
}


function compactText(raw: string, maxChars: number): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Keep the orchestrator's assembled user prompt below the Rust-side
 * `ai_complete` ceiling (128,000 characters), with room for counting
 * differences and future small additions to the request envelope.
 */
export const ORCHESTRATOR_USER_TEXT_CHAR_LIMIT = 120_000;
const ORCHESTRATOR_NEW_MESSAGE_CHAR_LIMIT = 16_000;
/**
 * Past this much tool output, a turn whose transport already replays the full
 * results sends an index in the prompt instead of a second copy.
 */
const TOOL_RESULT_INLINE_LIMIT = 20_000;
/** Tool evidence never drops below this, however tight the rest of the prompt is. */
const MIN_TOOL_RESULT_CHARS = 18_000;
/** Room kept for the app state, project tree and conversation beside the evidence. */
const MIN_SURROUNDING_CONTEXT_CHARS = 8_000;

const ORCHESTRATOR_CONTEXT_TRUNCATION_MARKER =
  '\n\n[Earlier context was trimmed to fit the orchestrator input limit.]\n\n';

/** Trim a context block while retaining both its beginning and its latest evidence. */
function truncatePromptContext(raw: string, maxChars: number): string {
  const text = raw.trim();
  if (!text || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= ORCHESTRATOR_CONTEXT_TRUNCATION_MARKER.length) return text.slice(0, maxChars);

  const available = maxChars - ORCHESTRATOR_CONTEXT_TRUNCATION_MARKER.length;
  const headChars = Math.floor(available * 0.45);
  const tailChars = available - headChars;
  return `${text.slice(0, headChars)}${ORCHESTRATOR_CONTEXT_TRUNCATION_MARKER}${text.slice(-tailChars)}`;
}

function describeAppState(app: AppStateRef): string[] {
  const lines: string[] = ['Application state (what the user is looking at right now):'];
  if (app.activeView) lines.push(`- Active view: ${compactText(app.activeView, 40)}${app.settingsOpen ? ' (Settings panel open)' : ''}`);
  if (app.visiblePanels?.length) lines.push(`- Visible panels: ${app.visiblePanels.map((p) => compactText(p, 24)).join(', ')}`);
  if (app.layout) {
    const rooms = app.layout.rooms
      .map((r) => {
        const tags = [r.focused ? 'focused' : null, r.minimized ? 'minimized' : null].filter(Boolean).join(', ');
        return `${compactText(r.title, 32)}${tags ? ` (${tags})` : ''}`;
      })
      .join(', ');
    lines.push(`- Workspace layout: ${app.layout.ambient} mode${rooms ? `; rooms: ${rooms}` : ''}`);
  }
  const ed = app.editor;
  if (ed) {
    if (ed.activeFile) {
      const cur = ed.cursor ? ` (cursor ${ed.cursor.line}:${ed.cursor.col})` : '';
      const lang = ed.language && ed.language !== 'image' ? `, ${compactText(ed.language, 24)}` : '';
      lines.push(`- Active editor file: ${compactText(ed.activeFile, 120)}${cur}${lang}`);
    }
    if (ed.openFiles?.length) lines.push(`- Open files: ${ed.openFiles.slice(0, 12).map((f) => compactText(f, 80)).join(', ')}`);
    if (ed.dirtyFiles?.length) lines.push(`- Unsaved changes in: ${ed.dirtyFiles.map((f) => compactText(f, 80)).join(', ')}`);
    if (ed.selection?.trim()) {
      lines.push('- Highlighted selection in the editor:');
      lines.push('```');
      lines.push(ed.selection.trim());
      lines.push('```');
    }
    if (ed.content?.trim()) {
      lines.push(`- Contents of the active file${ed.contentTruncated ? ' (truncated)' : ''}:`);
      lines.push('```' + (ed.language && ed.language !== 'image' ? ed.language : ''));
      lines.push(ed.content);
      lines.push('```');
    }
  }
  if (app.terminals?.length) {
    lines.push(`- Terminals (${app.terminals.length}):`);
    for (const t of app.terminals.slice(0, 8)) {
      const tags = [t.agent ? `agent: ${compactText(t.agent, 32)}` : null, t.running ? (t.busy ? 'busy' : 'idle') : 'exited', t.cwd ? `cwd: ${compactText(t.cwd, 48)}` : null]
        .filter(Boolean)
        .join(', ');
      lines.push(`  - ${compactText(t.label, 40)}${tags ? ` [${tags}]` : ''}`);
      if (t.recentOutput?.trim()) {
        const out = t.recentOutput.trim().split('\n').slice(-6).map((l) => `      | ${l}`).join('\n');
        lines.push(out);
      }
    }
  }
  if (app.preview?.url) lines.push(`- Preview URL: ${compactText(app.preview.url, 120)}${app.preview.running ? ' (dev server connected)' : ''}`);
  if (app.branch) lines.push(`- Git branch: ${compactText(app.branch, 60)}`);
  if (app.availableRuns?.length) lines.push(`- Run presets: ${app.availableRuns.map((r) => `${compactText(r.name, 24)} (\`${compactText(r.command, 40)}\`)`).join(', ')}`);
  const settings = app.settings;
  if (settings) {
    if (settings.theme) lines.push(`- Active theme: ${compactText(settings.theme, 48)}`);
    if (settings.values && Object.keys(settings.values).length) {
      const pairs = Object.entries(settings.values).map(([k, v]) => `${k}=${compactText(String(v), 32)}`);
      lines.push(`- Current settings: ${pairs.join(', ')}`);
    }
    if (settings.availableThemes?.length) {
      lines.push(`- Themes you can switch to (use the exact name with a "setting" action, setting="theme"): ${settings.availableThemes.map((t) => compactText(t, 32)).join(', ')}`);
    }
  }
  return lines;
}

function buildUserText(message: string, ctx?: RouteContext): string {
  const parts: string[] = [];
  if (ctx?.projectName || ctx?.projectRoot) {
    const name = ctx.projectName ? compactText(ctx.projectName, 80) : '(unnamed project)';
    const root = ctx.projectRoot ? ` at ${compactText(ctx.projectRoot, 180)}` : '';
    parts.push(`Current active project: ${name}${root}. Treat this as the only current project unless the user switches projects.`);
  }
  if (ctx?.appState) parts.push(truncatePromptContext(describeAppState(ctx.appState).join('\n'), 8_000));
  const hasProjectSnapshot = ctx?.toolResults?.some((result) => result.name === 'read_project') ?? false;
  if (ctx?.projectTree?.trim() && !hasProjectSnapshot) {
    parts.push('Project structure (file tree, relative to the project root):');
    parts.push(ctx.projectTree.trim().slice(0, 8_000));
  }
  if (ctx?.projectReads?.length) {
    const reads: string[] = ['Files fetched from the project for you to answer from:'];
    for (const read of ctx.projectReads.slice(-8)) {
      const suffix = read.truncated ? ' (truncated)' : '';
      reads.push(`- ${read.path}${suffix}:\n${read.content.slice(0, 8_000)}`);
    }
    parts.push(truncatePromptContext(reads.join('\n'), 12_000));
  }
  const running = ctx?.runningAgents ?? [];
  if (running.length) {
    parts.push('Currently running agents:');
    for (const r of running) {
      parts.push(`- ${r.name ? `"${compactText(r.name, 48)}"` : '(unnamed)'} [${compactText(r.agent, 48)}] — ${compactText(r.title, 120)}`);
      if (r.recentOutput?.trim()) {
        const lines = r.recentOutput.trim().split('\n').slice(-8).map((l) => `  | ${l}`).join('\n');
        parts.push(`  Terminal output (recent tail):\n${truncatePromptContext(lines, 2_000)}`);
      }
    }
  }
  const reviewing = ctx?.reviewingAgents ?? [];
  if (reviewing.length) {
    parts.push('Tasks awaiting review that can be resumed automatically:');
    for (const r of reviewing) {
      parts.push(`- ${r.name ? `"${compactText(r.name, 48)}"` : '(unnamed)'} [${compactText(r.agent, 48)}] — ${compactText(r.title, 120)}`);
    }
  }
  const taskOutputs = (ctx?.taskOutputs ?? []).slice(0, 6);
  if (taskOutputs.length) {
    parts.push('Recent agent/task status and terminal output:');
    for (const r of taskOutputs) {
      const turnState = r.turnState === 'ready' ? ', latest turn complete and ready for a new message' : '';
      parts.push(`- ${r.name ? `"${compactText(r.name, 48)}"` : '(unnamed)'} [${compactText(r.agent, 48)}, ${r.status}${turnState}] - ${compactText(r.title, 120)}`);
      if (r.freshness) parts.push(`  Freshness: ${compactText(r.freshness, 160)}`);
      if (r.reason) parts.push(`  Reason: ${compactText(r.reason, 180)}`);
      if (r.recentOutput?.trim()) {
        const isPlan = r.status === 'complete' && r.recentOutput.length > 200;
        // Voice mode is where the user asks to have an agent's output read back
        // to them, and a 10-line tail routinely cuts off the very thing they
        // asked for — the answer usually sits above the agent's closing prompt.
        const tailCount = isPlan ? 80 : ctx?.conversational ? 40 : 10;
        const lines = r.recentOutput.trim().split('\n').slice(-tailCount).join('\n');
        const outputBudget = isPlan ? 6_000 : ctx?.conversational ? 3_000 : 1_600;
        parts.push(`  Terminal output (${isPlan ? 'full plan' : 'recent tail'}):\n${truncatePromptContext(lines, outputBudget)}`);
      }
    }
  }
  const knowledge = (ctx?.knowledge ?? []).slice(0, 6);
  if (knowledge.length) {
    parts.push('Project knowledge notes (authored by the team):');
    for (const line of knowledge) parts.push(`- ${compactText(line, 240)}`);
  }
  if (ctx?.documentsIndex?.trim()) {
    parts.push(truncatePromptContext(ctx.documentsIndex.trim(), 3_000));
  }
  const memory = (ctx?.taskMemory ?? []).slice(-8);
  if (memory.length) {
    parts.push('Project memory and recent task activity:');
    for (const line of memory) parts.push(`- ${compactText(line, 240)}`);
  }
  const taskPanel = (ctx?.taskPanel ?? []).slice(0, 6);
  if (taskPanel.length) {
    parts.push('Task panel board:');
    for (const line of taskPanel) parts.push(`- ${compactText(line, 240)}`);
  }
  const mailbox = (ctx?.mailbox ?? []).slice(-8);
  if (mailbox.length) {
    parts.push('Team mailbox (agent-to-agent traffic):');
    for (const line of mailbox) parts.push(`- ${compactText(line, 240)}`);
  }
  const conversation = (ctx?.conversation ?? []).slice(-12);
  if (conversation.length) {
    // Your previous answer is kept (nearly) whole: a follow-up such as "what
    // about point 4?" is unanswerable when that answer was cut to 800 chars.
    const previousAnswer = conversation.map((turn) => turn.role).lastIndexOf('assistant');
    parts.push('Conversation history (oldest first; context for the new message, not a request to answer again):');
    conversation.forEach((turn, index) => {
      const role = turn.role === 'user' ? 'user' : turn.role === 'assistant' ? 'assistant' : turn.role;
      const label = index === previousAnswer ? 'assistant (your previous answer)' : role;
      parts.push(`${label}: ${compactText(turn.text, index === previousAnswer ? PREVIOUS_ANSWER_CHAR_LIMIT : 800)}`);
    });
  }
  // Everything after the tool results, so the results can be sized against
  // whatever budget the rest of the prompt leaves.
  const tailParts: string[] = [];
  if (ctx?.executionNote?.trim()) tailParts.push(`Execution instruction: ${ctx.executionNote.trim()}`);
  const recentUserMessages = (ctx?.recentUserMessages ?? []).slice(-6);
  if (recentUserMessages.length) {
    tailParts.push('Recent user messages:');
    for (const text of recentUserMessages) tailParts.push(`- ${compactText(text, 240)}`);
  }
  const focus = describeTurnFocus(message, ctx);
  if (focus) tailParts.push(`Turn focus: ${focus}`);
  const newMessage = `New user message: ${ctx?.nativeTools ? message : compactText(message, ORCHESTRATOR_NEW_MESSAGE_CHAR_LIMIT)}`;
  const contextBudget = (ctx?.nativeTools ? (ctx.budgets?.contextChars ?? DEFAULT_AGENT_BUDGETS.contextChars) : ORCHESTRATOR_USER_TEXT_CHAR_LIMIT) - newMessage.length - 1;

  // Tool results are this turn's evidence: what the model read, ran and found.
  // They used to be squeezed into a fixed 18k slice of an up-to-128k budget,
  // so a `read_project` snapshot arrived gutted and the model correctly
  // reported that it could not review the project. They now take what the rest
  // of the prompt leaves, and the surrounding context is trimmed first.
  let context: string;
  if (ctx?.toolResults?.length) {
    // With a transport the full outputs are already in the conversation
    // history it replays, so a second full copy here only slows the turn down.
    // Past a threshold the prompt carries an index of them instead.
    const full = formatBrainToolResults(ctx.toolResults);
    const carriedByTransport = ctx.nativeTools === true && ctx.toolExecutor !== undefined;
    const indexed = carriedByTransport && full.length > TOOL_RESULT_INLINE_LIMIT;
    const label = indexed
      ? 'Tool results from this turn (full outputs are in the tool messages; page any of them with read_tool_result(id)):'
      : 'Results from tools already executed in this turn:';
    const tail = tailParts.join('\n');
    const overhead = label.length + tail.length + 4;
    const resultsBudget = Math.max(MIN_TOOL_RESULT_CHARS, contextBudget - overhead - MIN_SURROUNDING_CONTEXT_CHARS);
    const results = truncatePromptContext(indexed ? formatBrainToolResultIndex(ctx.toolResults) : full, resultsBudget);
    const head = truncatePromptContext(parts.join('\n'), Math.max(0, contextBudget - overhead - results.length));
    context = truncatePromptContext([head, label, results, tail].filter(Boolean).join('\n'), contextBudget);
  } else {
    context = truncatePromptContext([...parts, ...tailParts].join('\n'), contextBudget);
  }
  return context ? `${context}\n${newMessage}` : newMessage;
}


const ACTION_RE =
  /\b(add|build|create|fix|refactor|implement|write|update|change|modify|remove|delete|test|run|make|generate|debug|optimi[sz]e|install|set ?up|migrate|rename|move|wire|integrate|deploy|scaffold|convert|port|upgrade|jot|note|document|record)\b/i;

// Anchored at the start so it only fires on an actual "close that agent" command,
// not a task that merely mentions one of these words ("fix the bug that stops X").
const CLOSE_CMD_RE = /^(?:please\s+|can you\s+)?(close|stop|shut\s?down|shut|kill|end|dismiss|terminate|release|quit)\b/i;
const CLOSE_ALL_RE = /\b(all|everything|every ?one|every agent|them all|the agents)\b/i;

// Question patterns — prevent the heuristic from spawning agents when the user is
// just chatting, asking for an explanation, or asking for status.
const QUESTION_START_RE = /^(what|why|how|when|where|who|which|is|are|does|do|can|could|would|should|explain|describe|tell me|show me|help me understand|help me|give me|walk me through)\b/i;
const QUESTION_MARK_RE = /\?\s*$/;

// Status-check patterns — intercepted before the LLM so we respond instantly.
const STATUS_CHECK_RE = /^(status|what[‘’]?s (?:the )?status|what[‘’]?s running|list agents|show agents|which agents|what agents are running|show me the agents|what are (?:my |the )?agents doing|how (?:is|are) (?:the |my |that |those )?agents? doing|is (?:it|that|the agent) (?:done|finished|complete)|has (?:it|that|the agent) finished|are (?:they|the agents) (?:done|finished|complete))\b/i;

// Output-query patterns — user wants to see what an agent said/wrote/outputted.
// Intercept before routing so we never send a new message to the agent.
const OUTPUT_QUERY_RE =
  /^(what did|what has|what[‘’]?s|show me what|get|fetch|read|check|see what|summari[sz]e|tell me what)\b.{0,80}\b(said?|respond(?:ed)?|wrot[eo]|output(?:ted)?|terminal|result(?:s)?|response|reply|answer|return(?:ed)?|produc(?:ed)?|finish(?:ed)?|complet(?:ed)?|done)\b/i;

/**
 * An explicit request to have an agent's output READ ALOUD, as opposed to the
 * "what did it say" summary that `OUTPUT_QUERY_RE` answers. Checked first,
 * because these phrasings match that pattern too but want the full transcript
 * rather than a 20-line digest: "read out what Iris outputted", "read me Iris's
 * output", "what was the Iris output? can you read it out for me".
 */
const READ_ALOUD_RE = new RegExp(
  [
    // "read out what Iris did", "read Iris's output aloud", "read that back to me"
    /\bread\b[^.?!]{0,60}\b(?:out loud|out|aloud|to me|back to me|back)\b/.source,
    // "read me the output", "read it", "read through what it wrote"
    /\bread (?:me|it|that|through|the)\b/.source,
    // "say that out loud" — same intent, different verb
    /\bsay\b[^.?!]{0,40}\b(?:out loud|aloud)\b/.source,
    // "give me the full output", "what's the whole transcript"
    /\b(?:full|whole|entire|complete)\s+(?:output|transcript|response|answer|log)\b/.source,
    /\bplay back\b/.source,
  ].join('|'),
  'i',
);

// Narrow, question-shaped prioritization asks only. The earlier version matched
// every "recommend"/"suggest" mention, which swallowed whole project-inspection
// requests into a canned task-panel line before the LLM or any tool could run
// ("Can you help me inspect the project and then suggest some improvements?"
// was answered from the board and the turn ended with zero operations).
const TASK_ADVICE_RE =
  /\b(what should (?:we|i)|what[‘’]?s next|what next|next task|what do you (?:suggest|recommend)|any (?:suggestions|recommendations))\b/i;

// These are operator/review requests. They should be answered by the brain
// itself, using app state and read tools, rather than being treated as coding
// work that needs a terminal agent.
const DIRECT_ADVICE_RE =
  /\b(audit|assess|evaluate|inspect|review|go through|look through|walk through|analy[sz]e|summari[sz]e|suggest|recommend|advise|improvement|prioriti[sz]e)\b/i;

// "the project" (as the object of a review ask) counts as broad: "inspect the
// project and suggest improvements" used to miss every pattern, so the bounded
// read_project snapshot was never pre-gathered and the evidence gates below had
// nothing to enforce.
const BROAD_REVIEW_RE =
  /\b(go through|look through|walk through|read all (?:the )?files?|all (?:the )?files?|whole project|entire project|the project|application|codebase)\b/i;

// Thanks and praise that close out a finished task ("this is good, thanks for
// the work on the project"). Such a message asks for nothing, so every
// "keep working" net must stand down for it: the reply to it is a sentence of
// thanks, and a polite "let me know if you'd like…" is not a deferral. Before
// this, the deferral net ordered a redo and the user got the previous answer
// again, once per thank-you.
const ACKNOWLEDGEMENT_RE =
  /\b(?:thanks?|thank you|thx|cheers|appreciate(?:d)?|great|perfect|awesome|amazing|excellent|brilliant|fantastic|wonderful|nice|cool|love it|well done|good (?:job|work)|nice (?:job|work)|great (?:job|work)|(?:this|that|it)(?:['’]s| is| looks| was) (?:good|great|fine|perfect|helpful|exactly))\b/i;
// Anything that turns the message back into a request: a question, a
// go-ahead, a correction or a new instruction.
const ACKNOWLEDGEMENT_BLOCKER_RE =
  /\?|\b(?:but|however|although|except|now|next|also|then|continue|go ahead|proceed|keep going|carry on|do it|can you|could you|would you|will you|let['’]?s|please (?:do|go|continue|check|look|review)|check|review|explain|inspect|look (?:at|into)|why|how|what|which|where|when)\b/i;

const ACKNOWLEDGEMENT_FALLBACK_REPLY = "You're welcome, glad it helped. Tell me whenever you want to pick up the next thing.";

/** A thank-you or a word of praise with no request in it. */
export function isAcknowledgement(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 200) return false;
  return ACKNOWLEDGEMENT_RE.test(text)
    && !ACKNOWLEDGEMENT_BLOCKER_RE.test(text)
    && !ACTION_RE.test(text)
    && !EXPLICIT_SPAWN_RE.test(text);
}

function isDirectAdviceOnlyRequest(message: string): boolean {
  if (isAcknowledgement(message)) return false;
  return (DIRECT_ADVICE_RE.test(message) || BROAD_REVIEW_RE.test(message)) && !ACTION_RE.test(message);
}

function isBroadDirectReviewRequest(message: string): boolean {
  return isDirectAdviceOnlyRequest(message) && BROAD_REVIEW_RE.test(message);
}

// Short go-aheads that continue the PREVIOUS request instead of stating a new
// one. Only meaningful when the recent conversation actually asked for direct
// work; kept away from ACTION_RE/EXPLICIT_SPAWN_RE so a real new task is
// always judged on its own words.
const CONTINUATION_RE =
  /\b(continue|go ahead|proceed|keep going|carry on|go on|do it|sounds good|yes|yeah|yep|ok|okay|sure)\b/i;

/**
 * A short go-ahead ("okay", "continue") whose recent conversation asked for
 * direct review/inspection work inherits that request. The user's follow-up
 * turns used to dodge every evidence gate ("okay" matches none of the review
 * patterns), so a lazy conversational FINAL with zero tool rounds was accepted
 * and the requested inspection never ran. Judged on the USER's own prior
 * messages only, so assistant phrasing cannot manufacture the requirement.
 */
function isContinuationOfDirectWork(message: string, ctx?: RouteContext): boolean {
  const trimmedMessage = message.trim();
  if (!trimmedMessage || trimmedMessage.length > 80) return false;
  if (!CONTINUATION_RE.test(trimmedMessage) || isAcknowledgement(trimmedMessage)) return false;
  if (ACTION_RE.test(trimmedMessage) || EXPLICIT_SPAWN_RE.test(trimmedMessage)) return false;
  const priorUserText = (ctx?.conversation ?? [])
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text)
    .join('\n');
  if (!priorUserText.trim()) return false;
  return isDirectAdviceOnlyRequest(priorUserText) || BROAD_REVIEW_RE.test(priorUserText);
}

// "but there is a .env.local", "that's not right", "you missed the tests":
// the user disputing a claim in the previous answer.
const DISPUTE_RE =
  /^(?:but|no,?|nope|actually|wait)\b|\b(?:that'?s|this is|it'?s) (?:not (?:true|right|correct)|wrong|incorrect)\b|\b(?:you'?re|you are|you were) wrong\b|\byou (?:missed|forgot|overlooked)\b|\b(?:it|that|this|the file) (?:does|do) exist\b|\bcheck (?:it |that |this )?again\b|\blook again\b/i;

const ASKS_FOR_REPEAT_RE = /\b(?:repeat|again|same|resend|re-?send|say that|one more time|remind me)\b/i;

function wordShingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9_.\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const shingles = new Set<string>();
  for (let i = 0; i + 2 < words.length; i += 1) shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return shingles;
}

/**
 * The reply is (nearly) the previous answer again, and the user did not ask
 * for that. Word-trigram overlap, so small edits to a re-sent report still
 * count, while a genuinely new answer on the same topic does not.
 */
export function repeatsPreviousAnswer(reply: string, message: string, ctx?: RouteContext): boolean {
  if (ASKS_FOR_REPEAT_RE.test(message)) return false;
  const previous = [...(ctx?.conversation ?? [])].reverse().find((turn) => turn.role === 'assistant')?.text ?? '';
  if (reply.length < 300 || previous.length < 300) return false;
  const a = wordShingles(reply);
  const b = wordShingles(previous);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const shingle of a) if (b.has(shingle)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.6;
}

/** How much of the previous answer the next turn sees verbatim. */
const PREVIOUS_ANSWER_CHAR_LIMIT = 6_000;

/**
 * The questions and requests in one message: sentences ending in "?" plus
 * numbered or bulleted items. Two or more means "answer every one".
 */
export function countAsks(message: string): number {
  const questions = (message.match(/[^?.!\n]+\?/g) ?? []).length;
  const items = message.split('\n').filter((line) => /^\s*(?:\d+[.)]|[-*•])\s+\S/.test(line)).length;
  return Math.max(questions, items);
}

/** What kind of message the user just sent, judged before any work starts. */
export type TurnIntent = 'acknowledgement' | 'correction' | 'continuation' | 'question' | 'task' | 'conversation';

const TURN_QUESTION_RE = /^(?:what|why|how|when|where|which|who|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|any)\b/i;
// "can you fix…", "please add…": polite phrasing of an instruction, not a question.
const POLITE_REQUEST_RE = /^(?:(?:can|could|would|will) you|please|pls|i (?:want|need) you to|i(?:['’]d| would) like you to)\b/i;

/**
 * Read the message before acting on it. A thank-you gets a sentence back, a
 * question gets an answer, a correction gets re-checked, a go-ahead continues
 * the last task, and only a request for work starts new work.
 */
export function classifyTurnIntent(message: string, ctx?: RouteContext): TurnIntent {
  const text = message.trim();
  if (!text) return 'conversation';
  if (isAcknowledgement(text)) return 'acknowledgement';
  if (disputesPreviousAnswer(text, ctx)) return 'correction';
  const hasPrevious = (ctx?.conversation ?? []).some((turn) => turn.role === 'assistant' && turn.text.trim());
  if (hasPrevious && (isContinuationOfDirectWork(text, ctx) || (CONTINUATION_RE.test(text) && text.length <= 60))) return 'continuation';
  const politeRequest = POLITE_REQUEST_RE.test(text);
  const wantsWork = politeRequest || ACTION_RE.test(text) || EXPLICIT_SPAWN_RE.test(text) || DIRECT_ADVICE_RE.test(text);
  if (!politeRequest && (TURN_QUESTION_RE.test(text) || (text.endsWith('?') && !wantsWork))) return 'question';
  if (wantsWork) return 'task';
  return 'conversation';
}

/**
 * One line telling the model what kind of message it is answering, placed
 * right before that message. Without it a follow-up ("but there is a
 * .env.local") was answered by re-sending the whole previous report.
 */
export function describeTurnFocus(message: string, ctx?: RouteContext): string | null {
  const hasPrevious = (ctx?.conversation ?? []).some((turn) => turn.role === 'assistant' && turn.text.trim());
  const asks = countAsks(message);
  const every = asks >= 2 ? ` It contains ${asks} questions or requests: answer every one, in order, and label each answer.` : '';
  const ongoing = hasPrevious ? ' Answer THIS message specifically. Earlier turns are context only: refer back briefly where it helps, and never re-send your previous answer.' : '';
  switch (classifyTurnIntent(message, ctx)) {
    case 'acknowledgement':
      return hasPrevious
        ? 'the user is thanking you or approving the finished work; there is no new request. Reply in one or two warm sentences, with at most a one-line offer of a next step. Use no tools, and do not repeat, summarise or redo the previous work.'
        : 'a friendly remark with no request in it. Reply briefly and naturally; use no tools.';
    case 'correction':
      return `the user is disputing your previous answer. Verify their point with tools, then correct your answer; do not restate it.${every}`;
    case 'continuation':
      return `a go-ahead to continue the previous task. Carry on from where it stopped instead of starting over.${every}`;
    case 'question':
      return `a question. Answer it directly and completely. If it is about this project, check the code with read tools first; do not edit files, change settings, or start agents unless the user asks.${ongoing}${every}`;
    case 'task':
      return `a request to do work. Read what you need, do it with the right tools or app actions, verify it, then report what changed.${ongoing}${every}`;
    default:
      if (!hasPrevious) return every ? every.trim() : null;
      return `a new message in an ongoing conversation.${ongoing}${every}`;
  }
}

/** A short message disputing the previous answer, when there was one. */
function disputesPreviousAnswer(message: string, ctx?: RouteContext): boolean {
  const trimmedMessage = message.trim();
  if (!trimmedMessage || trimmedMessage.length > 400) return false;
  if (!(ctx?.conversation ?? []).some((turn) => turn.role === 'assistant' && turn.text.trim())) return false;
  return DISPUTE_RE.test(trimmedMessage);
}

function pickDefaultAgent(agents: AgentChoice[]): AgentChoice | null {
  return agents.find((a) => a.command === 'claude') ?? agents[0] ?? null;
}

// App-navigation command, anchored at the start so a task that merely mentions
// "open" doesn't trigger it. "hide"/"close" a panel maps to the terminal view.
const NAV_CMD_RE = /^(?:please\s+|can you\s+|could you\s+)?(go to|open|show(?:\s+me)?|switch to|take me to|navigate to|bring up|jump to|hide|close)\b/i;
const VIEW_TERMS: Array<{ view: string; re: RegExp }> = [
  { view: 'editor', re: /\beditor\b/i },
  { view: 'preview', re: /\b(preview|browser)\b/i },
  { view: 'tasks', re: /\btasks?\b|\btask board\b|\bkanban\b/i },
  { view: 'terminal', re: /\b(terminal|console|shell)\b/i },
  { view: 'settings', re: /\b(settings?|preferences)\b/i },
  { view: 'review', re: /\breview\b/i },
  { view: 'http', re: /\b(http|api client|rest client)\b/i },
  { view: 'db', re: /\b(database|db)\b/i },
  { view: 'containers', re: /\b(containers?|docker)\b/i },
  { view: 'toolbox', re: /\btoolbox\b/i },
  { view: 'youtube', re: /\b(youtube|yt)\b/i },
];

/**
 * Recognize a plain "go to / show / hide <view>" command so navigation works
 * without an LLM. Returns null when the message names an agent (that's a spawn,
 * not navigation) or doesn't clearly reference a known view.
 */
function navigationRoute(text: string, agents: AgentChoice[]): RouteResult | null {
  if (!NAV_CMD_RE.test(text)) return null;
  if (resolveAgentCommand(text, agents)) return null; // "open codex" is a spawn
  const hideVerb = /^(?:please\s+|can you\s+|could you\s+)?(hide|close)\b/i.test(text);
  const match = VIEW_TERMS.find(({ re }) => re.test(text));
  if (!match) return null;
  const view = hideVerb && match.view !== 'terminal' ? 'terminal' : match.view;
  const label = view === 'terminal' && hideVerb ? 'Hiding that panel.' : `Opening ${view}.`;
  return { reply: label, actions: [{ kind: 'navigate', view }], viaLLM: false };
}

// Spoken synonyms for command ids that aren't an obvious word. The command id
// itself and the preset name are matched generically (below); these cover the
// gap where the id is opaque ("agy" → "antigravity") or differs from how people
// say it. Cursor ships as "cursor-agent"; the bare "agent" is kept for sessions
// created before the rename, and is too generic to match on its own, so it is
// reached only via "cursor".
const AGENT_ALIASES: Record<string, string[]> = {
  codex: ['codex'],
  claude: ['claude'],
  agy: ['agy', 'antigravity'],
  opencode: ['opencode', 'open code'],
  pi: ['pi'],
  'cursor-agent': ['cursor'],
  agent: ['cursor'],
  aider: ['aider'],
  grok: ['grok'],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The words/phrases that name a given agent: its command id (unless generic),
 * its preset name, and any spoken aliases. */
function agentMatchTerms(agent: AgentChoice): string[] {
  const terms = new Set<string>();
  const cmd = agent.command.trim().toLowerCase();
  // The bare "agent" command (Cursor) is too generic to match as a word.
  if (cmd && cmd !== 'agent' && !cmd.includes(' ')) terms.add(cmd);
  const name = agent.name.trim().toLowerCase();
  if (name) terms.add(name);
  for (const alias of AGENT_ALIASES[cmd] ?? []) terms.add(alias);
  return [...terms].filter(Boolean);
}

/**
 * Resolve the agent a message names to its command id — matching the command,
 * the preset name, or a spoken alias, case-insensitively and on word
 * boundaries. Returns the MOST specific (longest) match so "Codex CLI" beats a
 * stray "codex"; null when no agent is named.
 */
export function resolveAgentCommand(text: string, agents: AgentChoice[]): string | null {
  const haystack = ` ${text.toLowerCase()} `;
  let best: { command: string; len: number } | null = null;
  for (const agent of agents) {
    for (const term of agentMatchTerms(agent)) {
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:[^a-z0-9]|$)`, 'i');
      if (re.test(haystack) && (!best || term.length > best.len)) {
        best = { command: agent.command, len: term.length };
      }
    }
  }
  return best?.command ?? null;
}

/** Find a running agent the message names, so heuristic close can target it. */
function matchRunningName(message: string, running: RunningAgentRef[]): string | null {
  const lower = message.toLowerCase();
  for (const r of running) {
    if (r.name && lower.includes(r.name.toLowerCase())) return r.name;
  }
  return null;
}

function statusPhrase(status: AgentOutputRef['status'], turnState?: AgentOutputRef['turnState']): string {
  if (turnState === 'ready' && status === 'in-progress') return 'ready for your next message';
  switch (status) {
    case 'in-progress': return 'still in progress';
    case 'complete': return 'done';
    case 'blocked': return 'waiting for input';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return status;
  }
}

function outputRefs(ctx?: RouteContext): AgentOutputRef[] {
  const refs = ctx?.taskOutputs ?? [];
  if (refs.length) return refs;
  return (ctx?.runningAgents ?? []).map((r) => ({ ...r, status: 'in-progress' as const }));
}

function displayAgentName(ref: RunningAgentRef): string {
  return ref.name ? compactText(ref.name, 32) : compactText(ref.agent, 32) || 'Agent';
}

function latestOutputLine(ref: RunningAgentRef, maxChars = 160): string {
  const line = ref.recentOutput
    ?.trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line ? compactText(line, maxChars) : '';
}

function formatStatusReply(refs: AgentOutputRef[]): string {
  if (!refs.length) return 'No agents are currently running, and I do not have recent task output to summarize yet.';
  const lines = refs.slice(0, 6).map((r) => {
    const latest = latestOutputLine(r);
    const reason = r.reason ? ` (${compactText(r.reason, 90)})` : '';
    const tail = latest ? ` Latest output: ${latest}` : '';
    return `- ${displayAgentName(r)} is ${statusPhrase(r.status, r.turnState)}${reason}: ${compactText(r.title, 90)}.${tail}`;
  });
  if (refs.length === 1) return lines[0].replace(/^- /, '');
  return `${refs.length} recent agent tasks:\n${lines.join('\n')}`;
}

function formatOutputReply(refs: AgentOutputRef[], conversational = false): string {
  const withOutput = refs.filter((r) => r.recentOutput?.trim());
  if (!withOutput.length) {
    if (!refs.length) return 'No agents are currently running, and I do not have captured terminal output yet.';
    return formatStatusReply(refs);
  }

  const parts = withOutput.slice(0, 3).map((r) => {
    const output = r.recentOutput!.trim().split('\n').slice(-20).join('\n');
    const compact = compactText(output, conversational ? 520 : 900);
    const intro = `${displayAgentName(r)} is ${statusPhrase(r.status, r.turnState)} on "${compactText(r.title, 80)}".`;
    if (conversational) return `${intro} The latest terminal output says: ${compact}`;
    return `${intro}\n\nLatest terminal output:\n\`\`\`\n${output}\n\`\`\``;
  });
  return parts.join('\n\n');
}

/**
 * The spoken form of a read-aloud request. The transcript is passed through
 * as-is (the orchestrator already stripped terminal noise); only the framing
 * sentence is added, so the user hears what the agent actually wrote rather
 * than a paraphrase of it.
 */
function formatReadAloud(read: AgentTranscriptRead): string {
  const text = read.text.trim();
  if (!text) return `${read.name} has not produced any output yet.`;
  const lead = read.truncated
    ? `Here is the most recent part of ${read.name}'s output.`
    : `Here is ${read.name}'s output.`;
  return `${lead}\n\n${text}`;
}

function formatTaskPanelAdvice(taskPanel: string[]): string {
  const doing = taskPanel.find((line) => /^In progress\b/i.test(line));
  const todo = taskPanel.find((line) => /^To do\b/i.test(line));
  if (doing && todo) {
    return `I would focus on ${compactText(doing, 150)} first, then pick from ${compactText(todo, 150)}. Work already in progress usually has the best payoff unless it is blocked.`;
  }
  if (doing) return `I would finish or unblock ${compactText(doing, 170)} before starting new work.`;
  if (todo) return `I would start with ${compactText(todo, 170)}. Nothing is currently marked in progress.`;
  return 'The task panel is empty right now, so there is no queued work to prioritize.';
}

function missingBrainConnectionReply(ctx?: RouteContext): string {
  const provider = ctx?.llmConfig?.provider ?? get(aiProvider);
  const definition = getProviderDef(provider);
  const providerLabel = definition?.label ?? provider;
  const model = ctx?.llmConfig?.model ?? get(currentAiModel);
  if (isLocalProvider(provider)) {
    return `Composer is set to ${providerLabel} (${model}), but its local server is not available to the orchestrator. ${providerSetupHint(provider)} Then retry.`;
  }
  return `Composer is set to ${providerLabel} (${model}), but it is not connected yet. ${providerSetupHint(provider)} Or choose a connected provider in Composer, then retry. Once connected, I will review it here without launching an agent.`;
}

/**
 * Turn a backend credential/auth failure into a useful message. The route used
 * to hide every ai_complete failure behind the no-provider heuristic, which
 * made a bad key, a stale keychain entry, and a network/model error look alike.
 * Never include the provider's response body here: it may contain sensitive
 * request details even though Rust redacts known key formats.
 */
function providerCredentialFailureReply(provider: AiProviderId, model: string, error: string): string | null {
  const normalized = error.toLowerCase();
  const missing = normalized.includes('api key is not set')
    || normalized.includes('no api key configured')
    || normalized.includes('could not resolve the saved')
    || normalized.includes('failed to read the api key')
    || normalized.includes('failed to access the system keychain');
  const rejected = /\b(401|403)\b/.test(normalized)
    || normalized.includes('unauthorized')
    || normalized.includes('forbidden')
    || normalized.includes('invalid_api_key')
    || normalized.includes('invalid api key')
    || normalized.includes('authentication');
  if (!missing && !rejected) return null;

  const definition = getProviderDef(provider);
  const providerLabel = definition?.label ?? provider;
  const keyLabel = definition?.keyLabel ?? `${providerLabel} API key`;
  if (missing) {
    return `The orchestrator reached ${providerLabel} (${model}), but the desktop keychain could not provide the saved ${keyLabel}. Re-save that key in Settings, then retry.`;
  }
  // The provider's own words beat a guess: a 403 is as often "this model is
  // not in your plan" as "bad key", and only the body says which.
  const said = providerErrorMessage(error);
  if (provider === 'opencode' || provider === 'opencode-go') {
    if (normalized.includes('freetiererror') || normalized.includes('free tier')) {
      return `${model} is one of OpenCode's free models, and OpenCode only serves those inside its own app, so every other client (Spacron included) gets a 403 whatever the key. Pick a paid model instead: an OpenCode Zen model needs Zen balance, or use the "OpenCode Go subscription" provider with your Go key.`;
    }
    const other = provider === 'opencode' ? 'OpenCode Go subscription' : 'OpenCode Zen';
    return `${providerLabel} rejected the saved ${keyLabel} for ${model}${said ? `: "${said}"` : ''}. Zen and Go share one console but not one endpoint: a Go subscription key only works with the "OpenCode Go subscription" provider, and Zen models need Zen balance. If your key is for the other plan, switch the provider to ${other} (or re-save the key under it), then retry.`;
  }
  return `The orchestrator reached ${providerLabel} (${model}), but the provider rejected the saved ${keyLabel}${said ? `: "${said}"` : ''}. Check that key in Settings and retry.`;
}

/** The human-readable message inside a provider error body, if it has one. */
function providerErrorMessage(error: string): string | null {
  const match = /"message"\s*:\s*"((?:[^"\\]|\\.){1,300})"/.exec(error);
  return match ? match[1].replace(/\\"/g, '"').trim() || null : null;
}

/** Turn provider quota, credit, and billing failures into an explicit user notice. */
function providerQuotaFailureReply(provider: AiProviderId, model: string, error: string): string | null {
  const normalized = error.toLowerCase();
  const exhausted = /\b402\b/.test(normalized)
    || normalized.includes('payment required')
    || normalized.includes('quota')
    || normalized.includes('insufficient_quota')
    || normalized.includes('insufficient balance')
    || normalized.includes('out of credit')
    || normalized.includes('no credits')
    || normalized.includes('credit balance')
    || normalized.includes('billing')
    || normalized.includes('usage limit');
  if (!exhausted) return null;

  const definition = getProviderDef(provider);
  const providerLabel = definition?.label ?? provider;
  return `The orchestrator reached ${providerLabel} (${model}), but that provider reports that the account has no remaining usage credit or quota. Check the provider's billing or usage page, or switch to another provider/model, then retry.`;
}

/**
 * The selected model id does not exist for this key, or exists but cannot
 * serve a chat completion (Responses-only, image, speech, embedding models).
 * Retrying cannot help, and the keyword fallback would silently answer in its
 * place, so name the model and send the user to the picker.
 */
export function modelUnavailableFailureReply(provider: AiProviderId, model: string, error: string): string | null {
  const normalized = error.toLowerCase();
  const unavailable = /(?:^|error: )model_unavailable:/.test(normalized)
    || normalized.includes('model_not_found')
    || /\bmodel\b[^.]{0,80}\b(?:does not exist|not found|is not available|not supported|unsupported)\b/.test(normalized)
    || normalized.includes('not a chat model')
    || normalized.includes('v1/responses')
    || normalized.includes('only supported in v1/completions');
  if (!unavailable) return null;
  const providerLabel = getProviderDef(provider)?.label ?? provider;
  return `${providerLabel} cannot run "${model}" as a chat model for this key. It may be retired, need access this account does not have, or only work through a different API (image, speech, or Responses-only models). Pick another model in the Composer model menu, then retry.`;
}

/** A local validation failure cannot be fixed by retrying another model. */
function inputLengthFailureReply(provider: AiProviderId, model: string, error: string): string | null {
  if (!error.toLowerCase().includes('input text exceeds maximum length')) return null;
  const definition = getProviderDef(provider);
  const providerLabel = definition?.label ?? provider;
  return `The orchestrator could not send this request to ${providerLabel} (${model}) because its input context is too large. I trimmed the local context, but this request is still over the provider's context limit. Start a fresh conversation or ask for a narrower review, then retry.`;
}

/** Backoff before each retry of one model request after a transient failure. */
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 4_000] as const;

function isTransientProviderFailure(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes('network')
    || normalized.includes('fetch failed')
    || normalized.includes('connection reset')
    || normalized.includes('connection refused')
    || normalized.includes('connection closed')
    || normalized.includes('timed out')
    || /(?:^|error: )timeout:/.test(normalized)
    || /(?:^|error: )rate_limit:/.test(normalized)
    || normalized.includes('overloaded')
    || /\b(?:500|502|503|504|529)\b/.test(normalized);
}

function networkFailureReply(provider: AiProviderId, model: string, attempts: number, error: string): string {
  const definition = getProviderDef(provider);
  const providerLabel = definition?.label ?? provider;
  const detail = compactText(error.replace(/^error:\s*/i, ''), 180);
  return `The orchestrator could not reach ${providerLabel} (${model}) after ${attempts} attempts${detail ? ` (${detail})` : ''}. No further work was claimed. Completed tool work is preserved; inspect its evidence before retrying.`;
}

function protocolFailureReply(
  provider: AiProviderId,
  model: string,
  results: BrainToolResult[],
): string {
  const definition = getProviderDef(provider);
  const providerLabel = definition?.label ?? provider;
  const successfulReads = results.filter((result) => result.ok && ['read_project', 'read_file', 'glob_files', 'grep_code'].includes(result.name)).length;
  const hasPlan = results.some((result) => result.ok && result.name === 'update_todos');
  const hasWork = results.some((result) => result.ok && !['update_todos'].includes(result.name));
  const working = successfulReads
    ? `- Project inspection completed: ${successfulReads} read/search operation${successfulReads === 1 ? '' : 's'} succeeded.`
    : '- The provider was reached, but no usable inspection result was returned.';
  const plan = hasPlan
    ? '- A review plan was recorded before the response failed.'
    : '- The review plan was not completed.';
  const work = hasWork
    ? '- Some tool work completed and has been preserved in Work details.'
    : '- No tool work was completed beyond the conversation attempt.';
  return [
    `The review could not be completed because ${providerLabel} (${model}) did not return a valid final response after one recovery attempt.`,
    '',
    'What is working',
    working,
    plan,
    work,
    '',
    'What is not working',
    '- The model response format was invalid, so no trustworthy findings were produced.',
    '',
    'What needs improvement',
    '- Retry with a model that reliably follows JSON/tool instructions, or continue this review with a narrower request.',
    '- The completed evidence remains available above; no unverified code changes are being claimed.',
  ].join('\n');
}

/** Routing without an LLM: pick a sensible agent and decide chat vs dispatch. */
// A pure "open N <agent> agents" request: nothing else in the message but
// politeness, a count, an agent name, the noun, and optionally where to run.
const OPEN_AGENTS_RE = /^(?:(?:hey|ok(?:ay)?|so)[,\s]+)?(?:(?:please|pls|can you|could you|would you|will you|can u)\s+)?(?:please\s+)?(?:open|spawn|launch|start|bring up|spin up|fire up|give me)\s+(?:up\s+)?(?:(a couple(?: of)?|a few|another|\d{1,2}|an?|one|two|three|four|five|six|seven|eight)\s+)?(?:new\s+|more\s+)?([a-z0-9 .-]*?)\s*(agents?|instances?|sessions?|clis?)?(?:\s+(?:for me|please|now))?(?:\s+(?:in|on)\s+(?:an?\s+|the\s+)?(?:new\s+|separate\s+|isolated\s+)?(?:work[\s-]?trees?|isolation|main(?:\s+(?:repo(?:sitory)?|branch))?|primary\s+repo)(?:\s+each)?)?\s*[.!?]*$/i;
const COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  'a couple': 2, 'a couple of': 2, 'a few': 3,
};
const MAX_AGENTS_PER_REQUEST = 8;

/**
 * "can you open 2 claude code agents" → two idle Claude spawns, with no model
 * call. Opening agents is the most common app command, and a weak or free
 * brain model can fumble the protocol for it (it once answered with a bare
 * `{"tool_calls":[]}`), so the harness does it itself. Only a PURE open
 * request matches; anything carrying a task goes to the model.
 */
export function parseOpenAgentsCommand(message: string, agents: AgentChoice[]): { agent: AgentChoice; count: number } | null {
  const match = message.trim().match(OPEN_AGENTS_RE);
  if (!match) return null;
  const [, countWord, rawName, noun] = match;
  const name = (rawName ?? '').trim();
  if (name && ACTION_RE.test(name)) return null;
  const command = name ? resolveAgentCommand(name, agents) : null;
  // Without an agent name it must say "agent(s)": "open 2 terminals" or
  // "open settings" are not agent requests.
  if (!command && (name || !noun)) return null;
  if (command) {
    // Every word of the name must belong to the agent's own terms ("claude code"),
    // so "open claude with the auth notes" never matches.
    const agentTerms = agentMatchTerms(agents.find((a) => a.command === command) as AgentChoice).join(' ');
    const extra = name.toLowerCase().split(/\s+/).filter((word) => word && !agentTerms.includes(word) && !['code', 'cli', 'the'].includes(word));
    if (extra.length) return null;
  }
  const agent = (command ? agents.find((a) => a.command === command) : null) ?? pickDefaultAgent(agents);
  if (!agent) return null;
  const parsed = countWord ? (/^\d+$/.test(countWord) ? Number(countWord) : COUNT_WORDS[countWord.toLowerCase()] ?? 1) : 1;
  const count = Math.min(Math.max(parsed, 1), MAX_AGENTS_PER_REQUEST);
  return { agent, count };
}

function openAgentsRoute(request: { agent: AgentChoice; count: number }): RouteResult {
  const { agent, count } = request;
  return {
    reply: count === 1 ? `Opening ${agent.name}. Its terminal will be ready for you.` : `Opening ${count} ${agent.name} agents. Their terminals will be ready for you.`,
    actions: Array.from({ length: count }, () => ({ kind: 'spawn' as const, agent: agent.command, prompt: null })),
    viaLLM: false,
  };
}

function heuristicRoute(message: string, agents: AgentChoice[], ctx?: RouteContext): RouteResult {
  const text = message.trim();

  // "close it" / "stop that agent" — only when there's actually something running
  // to close, so a bare "stop" can't no-op confusingly.
  const running = ctx?.runningAgents ?? [];
  if (running.length && CLOSE_CMD_RE.test(text)) {
    if (CLOSE_ALL_RE.test(text)) {
      return { reply: 'Closing all running agents.', actions: [{ kind: 'close', target: 'all' }], viaLLM: false };
    }
    const target = matchRunningName(text, running) ?? 'last';
    return { reply: 'Closing that agent.', actions: [{ kind: 'close', target }], viaLLM: false };
  }

  // Plain app navigation ("show the editor", "go to tasks") — no agent needed.
  const nav = navigationRoute(text, agents);
  if (nav) return nav;

  const defaultAgent = pickDefaultAgent(agents);
  if (!defaultAgent) {
    return { reply: 'No agents are configured for this project yet.', actions: [], viaLLM: false };
  }
  // If the user named a specific agent ("open codex", "use Codex CLI"), bring
  // THAT one out — not the default. Falls back to the default when none named.
  const namedCommand = resolveAgentCommand(text, agents);
  const agent = (namedCommand ? agents.find((a) => a.command === namedCommand) : null) ?? defaultAgent;
  const isQuestion = QUESTION_START_RE.test(text) || QUESTION_MARK_RE.test(text);
  const isExplicitSpawn = EXPLICIT_SPAWN_RE.test(text);
  const hasRealTask = ACTION_RE.test(message);

  // Review and recommendation requests are a direct brain capability. With no
  // model available we cannot honestly perform the review, but we also must
  // not turn it into an unsolicited coding-agent dispatch.
  if (isDirectAdviceOnlyRequest(text) && !namedCommand && !isExplicitSpawn) {
    return {
      reply: `I cannot complete this review yet. ${missingBrainConnectionReply(ctx)}`,
      actions: [],
      viaLLM: false,
    };
  }

  // Without a configured model there is no safe way to infer which worker the
  // user intends. Ask instead of claiming that work was delegated, especially
  // when a worker is already running and can be selected explicitly.
  if (!isQuestion && hasRealTask && !namedCommand && !isExplicitSpawn) {
    if (ctx?.conversational) {
      return {
        reply: `I can delegate that, but I need you to say which agent should do it${running.length ? ` (${running.map((r) => r.name || r.agent).join(', ')})` : ''}.`,
        actions: [],
        needsInput: true,
        viaLLM: false,
      };
    }
    if (running.length) {
      const names = running.map((r) => r.name || r.agent).join(', ');
      return {
        reply: `Which running agent should I delegate this to? ${names}.`,
        actions: [],
        needsInput: true,
        viaLLM: false,
      };
    }
    return {
      reply: `Which agent should I delegate this to? ${agent.name} is available.`,
      actions: [],
      needsInput: true,
      viaLLM: false,
    };
  }

  // In spoken conversation mode, talking is the default — only dispatch when the
  // user explicitly asks to open an agent. Otherwise just keep the conversation
  // going rather than silently spawning a terminal behind the voice overlay.
  // When there are running agents, surface their terminal output so the reply
  // is useful (e.g. "how's the agent doing" → recent output) instead of canned.
  if (ctx?.conversational && !EXPLICIT_SPAWN_RE.test(text) && !(ACTION_RE.test(text) && !QUESTION_START_RE.test(text) && !QUESTION_MARK_RE.test(text))) {
    const refs = outputRefs(ctx);
    if (refs.length) {
      return {
        reply: formatStatusReply(refs),
        actions: [],
        viaLLM: false,
      };
    }
    if (running.length) {
      const lines = running.map((r) => {
        const nameStr = r.name ? `**${compactText(r.name, 32)}**` : '(unnamed)';
        const agentStr = compactText(r.agent, 32);
        const titleStr = compactText(r.title, 80);
        let line = `• ${nameStr} [${agentStr}] — ${titleStr}`;
        if (r.recentOutput?.trim()) {
          const lastLine = r.recentOutput.trim().split('\n').filter((l) => l.trim()).pop() ?? '';
          if (lastLine) line += `\n  › ${compactText(lastLine, 120)}`;
        }
        return line;
      });
      return {
        reply: `${running.length} agent${running.length === 1 ? '' : 's'} running:\n${lines.join('\n')}`,
        actions: [],
        viaLLM: false,
      };
    }
    return {
      reply: "Got it. Say the word \u2014 like \u201copen an agent and \u2026\u201d \u2014 whenever you want me to put one on it.",
      actions: [],
      viaLLM: false,
    };
  }

  // Pure "open/spawn/launch X agent" request with no real task → spawn idle.
  const openAgents = parseOpenAgentsCommand(text, agents);
  if (openAgents) return openAgentsRoute(openAgents);
  if (isExplicitSpawn && !hasRealTask) {
    return {
      reply: `Opening ${agent.name}. Its terminal will be ready for you.`,
      actions: [{ kind: 'spawn', agent: agent.command, prompt: null }],
      viaLLM: false,
    };
  }

  // Don't spawn an agent for a question — the heuristic isn't smart enough to
  // answer it, so fall back to a helpful prompt asking for an actionable goal.
  const actionable = !isQuestion && (hasRealTask || message.trim().length > 24);
  if (actionable) {
    const reply = ctx?.conversational
      ? `On it \u2014 I'll launch ${agent.name} to work on that and keep you posted.`
      : `On it \u2014 handing this to ${agent.name} to work on. You can watch it in its terminal.`;
    return {
      reply,
      actions: [{ kind: 'spawn', agent: agent.command, prompt: message.trim() }],
      viaLLM: false,
    };
  }
  return {
    reply: isQuestion
      ? `I can help with that, but I need an AI provider connected to give a good answer. ${providerSetupHint(ctx?.llmConfig?.provider ?? get(aiProvider))} Or describe a coding task and I'll put an agent on it.`
      : "Tell me what you'd like built, fixed, or changed and I'll put an agent on it.",
    actions: [],
    viaLLM: false,
  };
}

const PROMPT_MODEL_LIMIT = 15;

/**
 * The models and reasoning levels one agent CLI actually offers, as reported
 * by the installed CLI, so the brain can honour "open Claude Code on Opus 5.5,
 * low reasoning" with real ids. Empty until that CLI's catalogue has loaded
 * once (see `warmLaunchCatalogues`); the brain then falls back to leaving
 * model/reasoning unset, which launches on the CLI's own defaults.
 */
function launchCatalogueLine(command: string): string {
  if (!isChatAgentProvider(command)) return '';
  const capabilities = getAgentProviderCapabilities(command);
  const models = (peekLiveAgentProviderModels(command) ?? []).filter((m) => m.id !== 'default');
  const shown = models.slice(0, PROMPT_MODEL_LIMIT).map((m) => {
    const efforts = m.reasoningEfforts
      ? m.reasoningEfforts.length ? m.reasoningEfforts.join('/') : 'no reasoning control'
      : null;
    return `${m.id}${m.isDefault ? ' (default)' : ''}${efforts ? ` [${efforts}]` : ''}`;
  });
  const more = models.length > PROMPT_MODEL_LIMIT ? `, +${models.length - PROMPT_MODEL_LIMIT} more` : '';
  const modelPart = shown.length ? `\n    models: ${shown.join(', ')}${more}` : '';
  const reasoningPart = capabilities.reasoningEfforts.length
    ? models.some((m) => m.reasoningEfforts) ? '' : `\n    reasoning: ${capabilities.reasoningEfforts.join('/')}`
    : '\n    reasoning: not settable at launch';
  return `${modelPart}${reasoningPart}`;
}

/** Start loading each agent CLI's catalogue so a later turn can list it. */
function warmLaunchCatalogues(agents: AgentChoice[]): void {
  for (const agent of agents) {
    if (!isChatAgentProvider(agent.command) || peekLiveAgentProviderModels(agent.command)) continue;
    void loadLiveAgentProviderModels(agent.command).catch(() => undefined);
  }
}

function buildSystemPrompt(
  agents: AgentChoice[],
  running: RunningAgentRef[],
  reviewing: RunningAgentRef[],
  conversational = false,
  profile: string[] = [],
  voice = false,
): string {
  const list = agents.map((a) => `- ${a.command} — ${a.name}${launchCatalogueLine(a.command)}`).join('\n');
  const runningList = running.length
    ? running
        .map((r) => `- ${r.name ? `"${compactText(r.name, 48)}"` : '(unnamed)'} [${compactText(r.agent, 48)}] — working on: ${compactText(r.title, 120)}`)
        .join('\n')
    : '(none running)';
  const reviewingList = reviewing.length
    ? reviewing
        .map((r) => `- ${r.name ? `"${compactText(r.name, 48)}"` : '(unnamed)'} [${compactText(r.agent, 48)}] — awaiting review: ${compactText(r.title, 120)}`)
        .join('\n')
    : '(none awaiting review)';
  return [
    "You are Spacron's in-app assistant. The user talks to you in natural language. You can see the whole application — the active page, open editor files and cursor, terminals, preview, git branch, the task board — shown under \"Application state\" in the user message. You do two kinds of things: (1) DRIVE THE APP directly (navigate pages, open files, run the preview, manage tasks), and (2) DELEGATE coding work to a fleet of local terminal agents you spawn and direct. Answer questions about anything you can see, and take the right actions to do what the user asks inside the app.",
    '',
    ...(profile.length
      ? [
          'What you have learned about this user and project (apply it; it reflects how they like to work). Tagged [you] = applies everywhere, [this project] = project-specific:',
          ...profile.map((line) => `- ${line}`),
          '',
        ]
      : []),
    'Available agent types (use the exact command id on the left when spawning):',
    list,
    '',
    'Currently running agents you can address by name:',
    runningList,
    'Recent terminal output for each running agent is shown in the user message.',
    '',
    'Tasks awaiting review that can be resumed automatically without approval:',
    reviewingList,
    '',
    'For a FINAL answer, you may return ordinary prose or markdown, or one JSON object. Use the JSON form when you need actions; never hide an action in prose:',
    '{"reply": "<concise message to the user; list findings as short bullets>", "actions": [ <zero or more action objects> ]}',
    '',
    'Each action is ONE of:',
    '- {"kind": "spawn", "agent": "<command id>", "prompt": "<full standalone prompt>" | null, "name": null, "role": null}',
    '    Launch a NEW agent. Omit/null "prompt" to just open it idle and ready. Leave "name" null — the app auto-assigns a name (e.g. "Trinity"). Only set "name" to echo a specific name the USER explicitly chose; never invent generic labels like "claude-1" or "agent 2".',
    '    "role" (optional): when you divide ONE goal across a TEAM, tag each spawn with its role so it gets the right charter — "coordinator" (plans + sequences the sub-tasks), "builder" (implements one sub-task), "scout" (read-only recon, no edits), "reviewer" (gates each hand-off), "orchestrator" (runs a whole team ITSELF: spawns its own workers, reviews their work, sends fixes back, and reports when done — use this when the user asks for agents to be run/managed for them, and spawn it ALONE, it recruits the rest). Leave null for an ordinary single agent.',
    '    "files" (optional): for a builder in a divided plan, the repo-relative files that sub-task will own. The app posts a claim so no two builders edit the same file at once — a spawn whose files overlap a live claim is held until released. Only set it when you know the files; otherwise omit.',
    '    "skipWorktree" (optional, boolean): set to true for admin/release tasks (tagging, pushing, changelogs, version bumps, deploy) so the agent runs directly in the project root instead of an isolated git worktree. Defaults to false — the app ALSO auto-detects it from the prompt content, so you typically do not need to set this explicitly.',
    '    "placement" (optional, "worktree" | "main" | null): set ONLY when the user says where that agent should run — "in a worktree" / "isolated" → "worktree"; "in the main repo" / "on the main branch" / "no worktree" → "main". Set it PER SPAWN: "open one in a worktree and another in the main repo" is two spawns with different values. Leave it null when they did not say — the app then asks them, so never guess.',
    '    If your PREVIOUS reply asked the user where an agent should run and their latest message answers with a place ("worktree", "main repo"), re-issue the spawn they originally asked for with that "placement" set. Do not ask again.',
    '    "model" (optional, string | null): the model that agent’s CLI should launch on. Set it ONLY when the user names one ("Opus 5.5", "GPT-5.6 Sol", "use a cheap model"), and use an exact id from that agent’s "models" list above — map the user’s words to the closest listed id. Never invent an id; if nothing listed matches, leave it null and say which models are available. Null = the CLI’s own default model.',
    '    "reasoningEffort" (optional, "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null): the reasoning level for that agent. Set it ONLY when the user asks for one ("low reasoning", "think hard" → "high", "max effort"), and only to a level listed for the chosen model in brackets (or the agent’s "reasoning" line). An agent marked "not settable at launch", or a model marked "no reasoning control", takes null. Null = the CLI default. Neither field ever needs a question: when the user did not say, leave them null.',
    '- {"kind": "send", "target": "<running agent name>", "prompt": "<full standalone prompt>"}',
    '    Give a new task to an agent that is ALREADY running. Use this instead of spawning when the user refers to an existing agent.',
    '- {"kind": "name", "target": "<running agent name or unnamed reference>", "name": "<new name>"}',
    '    Give a running agent a name (or rename it).',
    '- {"kind": "close", "target": "<running agent name, or \\"all\\">"}',
    '    Stop a running agent and close its terminal. Use when the user wants to close, stop, end, dismiss, release, or shut down an agent they are done with. "close everything"/"stop them all" → one close with target "all".',
    '',
    'APP-CONTROL actions — drive the application UI directly (no agent needed):',
    '- {"kind": "navigate", "view": "<one of: editor, terminal, preview, review, http, tasks, db, containers, toolbox, pet, youtube, mobile, settings>"}',
    '    Switch the active page/panel. "show me the editor" → editor; "open settings" → settings; "go back to the terminal" / "hide that panel" → terminal; "open youtube" → youtube; "android emulator" / "ios simulator" → mobile.',
    '- {"kind": "open-file", "path": "<path relative to project root>", "line": <number or null>}',
    '    Open a file in the editor (optionally jump to a line). Use the open-files / project paths shown in the app state. Prefer this over spawning an agent when the user just wants to SEE or go to a file.',
    '- {"kind": "close-file", "path": "<path relative to project root>"}',
    '    Close an open editor file.',
    '- {"kind": "preview", "url": "<route or full URL>"}',
    '    Point the preview browser at a route ("/login") or URL. Navigate to every URL through this action — it opens inside the app, not in an external browser. Switch to the preview view first with a navigate action if it is not visible.',
    '- {"kind": "run", "command": "<shell command or a run-preset name>"}',
    '    Run a command in a terminal (e.g. "npm run dev", "npm test"). If the user names a saved run preset, pass its command. This is for plain shell commands — to do CODING work, spawn an agent instead.',
    '- {"kind": "task", "op": "create"|"todo"|"doing"|"done"|"delete", "title": "<task title>"}',
    '    Manage the task board. "add a task to …" → create; "mark X done" / "move X to in progress" → done/doing (match the existing item by title); "remove the X task" → delete.',
    '- {"kind": "setting", "setting": "<setting name>", "value": <string | number | boolean>}',
    '    Change a setting the user can normally set in Settings — including the THEME. "switch to the Dracula theme" / "use a light theme" → setting "theme" with the theme name as value (pick the closest name from the themes listed in the app state). Other settings you can set: appearance ("system"|"light"|"dark"), fontSize (number), tabSize (number), wordWrap (true|false), minimap (true|false), vimMode (true|false), formatOnSave (true|false), autoSave (true|false), enableLsp (true|false), showHidden (true|false), notificationsEnabled (true|false), aiGhostTextEnabled (true|false), uiZoom (number, 50-200), interfaceTransparency (number, 0-100), terminalFontSize (number). Match the user\'s request to the closest setting and a valid value. The current values are shown in the app state; report from there when asked what a setting is.',
    '- {"kind": "layout", "mode": "focus"|"development"|"gallery"|"preview"}',
    '    Rearrange the whole workspace. Focus = one big room; Development = dedicated dev tools page; Canvas (mode "gallery") = a freeform, pan/zoom board with every open room; Preview = the live app preview (dev server) with the terminal alongside, for testing web apps. "focus mode" → focus; "dev tools" / "development page" → development; "show everything" / "canvas" / "gallery" / "the board" → gallery; "preview" / "test the app" / "preview mode" / "run the app" → preview.',
    '- {"kind": "room", "op": "focus"|"minimize"|"restore"|"close", "target": "<room name>"}',
    '    Act on one room. Rooms are the workspace, terminal, an agent (by its name), or a panel (editor, preview, review, http, tasks, db, containers, toolbox, pet). "focus the terminal" → focus terminal; "minimize the editor" → minimize editor; "close the preview" → close preview. Use the workspace layout shown in the app state to pick the right room name.',
    '',
    'Rules:',
    '- Prefer an APP action when the user wants to look at or move around the app (open a file, switch pages, run the preview, jump to a line, manage tasks). Use SPAWN/SEND only for big changes (see the SCOPE RULE) or when the user asks for an agent.',
    '- ANYTHING ELSE IN THE APP — When the user asks for something in Spacron that no action above covers (a tool, room, panel, layout, settings page, palette command), call list_app_commands with a word or two from the request, then run_app_command with the matching id. Never say the app cannot do something before you have looked. Risky commands show the user an approval card; that is expected, not a failure.',
    '- DIRECT-FIRST POLICY — For review, audit, inspect, explain, summarize, plan, prioritize, recommend, suggest, or "go through the application" requests, act as the operator yourself. Use the application state and READ tools, then return an evidence-based answer with an EMPTY actions array. Do not spawn or send an agent unless the user explicitly asks for one or substantial code work is actually required.',
    '- For a broad review, call read_project first to gather the relevant text files in one bounded snapshot, then synthesize the findings in this same turn. Broad inspection is not by itself a reason to delegate.',
    '- DIRECT OPERATIONS — Use APP actions for safe UI control and run_command for bounded checks whose output you need in this turn. Use write_file/edit_file for authorized project changes and save_document for user-requested documents. Never claim an operation is complete from intention alone; wait for its tool result.',
    '- COMPLETION CONTRACT — A turn ends only when the requested work is complete or a blocker requires the user. Never end with "then I can…", "next step is…", "ready when you are", or any promise of future recommendations. If you have partial findings, continue with tools and deliver the full answer in this turn; findings must come from tool results in this turn.',
    '- VERIFY BEFORE FINISHING — If you changed files with write_file, save_document, or edit_file, run the project\'s verification with run_command (its tests, typecheck, lint, or build) AFTER that change and report the real result, exit code included. A failing verification is a finding to report, not a reason to keep editing silently. If no such command exists, say so explicitly rather than implying the change was checked.',
    `- SCOPE RULE: EDIT SMALL, DELEGATE BIG — You make small changes yourself: a task that changes at most ${DIRECT_EDIT_FILE_LIMIT} project files. Work that needs more than ${DIRECT_EDIT_FILE_LIMIT} files (a new feature or module, a refactor, a cross-cutting change) is a big change you must NOT make on your own. After reconnaissance, if the task clearly needs more than ${DIRECT_EDIT_FILE_LIMIT} files, make no edits: return a FINAL whose reply explains the scope (which files, why) and whose actions hold ONE spawn with a complete, self-contained brief written per DETAILED AGENT BRIEFS below. That spawn is a PROPOSAL: the app asks the user to approve it and pick the agent (Claude Code, Codex, or another local model) before anything starts, so never describe it as already started. The executor also refuses the file that would cross the limit; when that happens, stop editing and propose the hand-off the same way.`,
    '- EXISTENCE CLAIMS — Never say a file, folder, or setting is missing unless a tool result looked for it BY NAME in this turn (glob_files also lists git-ignored files, marked as such). A file absent from a snapshot or tree is not evidence it is missing. Listings mark secret files: read_file on an env file shows each variable name and whether it is set (never the value), so report "X is set" or "X is empty", never guess values; key and credential files are only confirmed to exist.',
    '- ANSWER WHAT WAS ASKED — The "New user message" is the one you answer now; the "Turn focus" line says what kind of message it is. Earlier conversation is context: use it to resolve "it", "that", or "point 3", but never re-send a previous answer. If the message holds several questions or requests, answer every one, in order. If something it needs is ambiguous and you cannot resolve it from the conversation or the project, ask one short question instead of guessing.',
    '- CORRECTIONS — When the user says your previous answer was wrong ("but there is…", "that\'s not right"), re-check the claim with tools before replying, then say plainly what was wrong and give only the corrected findings. Never repeat the previous answer unchanged.',
    '- FAILED COMMANDS — If a command fails or times out, report exactly that with its output. Commands run with CI=1; one that still never finishes is usually in watch mode, serving, or prompting. Retry with the run-once form (for example "vitest run") before concluding anything, and never invent an unrelated cause such as missing environment variables without evidence.',
    '- NEVER DELEGATE ON YOUR OWN — Never spawn or send an agent without the user\'s approval. When the user explicitly asks for an agent ("have Codex do it", "delegate this"), their message is the approval.',
    '- You can combine actions: "open the router file and have claude add a route" → one open-file action AND one spawn action.',
    '- When the user asks a question about the app ("what file am I on?", "is the dev server running?", "what terminals are open?"), answer from the application state with an EMPTY actions array.',
    '- The actions array may contain MULTIPLE actions. "open two claude agents" → two spawn actions.',
    '- Each spawn/send prompt must be fully self-contained — the agent has NO access to this conversation.',
    '- DETAILED AGENT BRIEFS — Whenever a spawn or send carries real work, its "prompt" is a thorough, elaborate brief, never a copy of the user\'s words. Even when the user is vague ("fix the sidebar", "make it better", "add auth"), expand the request into a complete work order a senior engineer could execute without asking anything. Do reconnaissance with your read tools first so the brief is grounded in the actual code, then write it in plain markdown with these sections: GOAL (what to build or fix and why, in the user\'s intent spelled out); CONTEXT (the relevant files, functions, components, and how they connect, with repo-relative paths you actually saw; the stack and conventions to follow); REQUIREMENTS (numbered, concrete, testable steps and behaviours, including edge cases, error states, and UI details where relevant); CONSTRAINTS (what must not change, files to leave alone, style and patterns to match, no scope creep); ACCEPTANCE CRITERIA (how "done" looks, observably); VERIFICATION (the exact commands to run, such as tests, typecheck, lint, or build, and what to check by hand). Where the user left a choice open, make a sensible decision in the brief and state it as an assumption instead of leaving the agent to guess. Never invent file paths or APIs you did not see; say "locate X" when you have not found it. Length follows the work: a small fix gets a focused brief, a feature gets a long one. This applies to every agent (Claude Code, Codex, Gemini, or any other local CLI) and to each sub-task in a plan-and-delegate dispatch.',
    '- If the user refers to a running agent (by name, "the first one", "that agent"), prefer send/name over spawning a duplicate.',
    '- Everything opens inside the app — when you need to visit a URL, use the preview action instead of opening the system browser.',
    '- If a task is awaiting review and the user wants more work, use send to resume it automatically instead of waiting for approval.',
    '- Use the task panel board in the user message as project truth. Prefer work that unblocks "In progress" items, then "To do" items. If the user asks for advice, suggest what should be done next and what can wait; use an empty actions array unless they explicitly ask you to act.',
    '- To shut an agent down that the user is finished with, use close (never spawn a new agent to "close" one).',
    '- If the user asks what an agent said, responded, wrote, outputted, or what its result/response/answer was — report it from the terminal output shown above. Use an EMPTY actions array. Never send a new message to the agent for this.',
    '- If the user asks whether something is done, still running, blocked, failed, or what the terminal says, answer from the recent agent/task status and terminal output. Use an EMPTY actions array unless they explicitly ask you to continue or change something.',
    '- If the user is only chatting, greeting, or you need clarification, use an empty actions array and answer in reply.',
    '- Prefer "claude" for general coding unless another agent is clearly better.',
    '- To-do lists (the "todos" field) are execution plans. Only produce them in a round that calls tools that will work them. NEVER include "todos" in a FINAL reply with zero tool_calls this turn; claiming finished checklists without executed tool work is a protocol violation.',
    '- EXPLORATION FIRST (RECON): For any task requiring 3+ steps, gather context BEFORE creating a todo list, then plan, then execute (Explore-Plan-Code). Match the reconnaissance to the scope: for a focused task (one feature, one bug, named files) use grep_code, glob_files, and read_file on the files involved; reserve read_project for broad reviews or an unfamiliar codebase where you do not yet know where to look. The plan must be grounded in what you actually found, not what you assume exists.',
    '- PLAN STRUCTURE: After reconnaissance, establish the complete todo list in one update_todos call with 3-6 logical items. Include exploration, implementation or delegation, any blocking question, and verification as separate items where applicable. Later update_todos calls must repeat the full list and change statuses, not append paraphrases. Add a new item only when execution discovers genuinely new work.',
    '- COMPLETION REPORT: Match the report to the request. For a simple question or small change, answer naturally and concisely. For a review, multi-step implementation, investigation, or verification task, use a breakdown with only the sections that have substance: What is working, What is not working, What needs improvement, and verification/evidence. Do not force empty sections or a formal report onto simple requests.',
    '- STYLE & PUNCTUATION — Do NOT use em dashes (—), en dashes (–), or hyphens (-) between clauses, sentences, or phrases in your replies. Use normal commas, periods, or semicolons instead.',
    '- REPLY DETAIL — "concise" means dense with facts, never vague. A reply that reports work, reviews code, or answers a project question must name the actual files, paths, commands, and numbers you saw in tool results, and list distinct findings as short bullet lines (one per line) instead of one compressed sentence. A one-line acknowledgement is acceptable only for small talk; after real tool work, deliver the specifics in this reply.',
    '- DOCUMENTS & PLANS — If the user asks you to save, write, draft, or export a document, use save_document. Choose a descriptive kebab-case filename yourself; it is saved in the project docs/ folder (the user Documents folder only when no project is open). Do not ask for a filename or location unless the user explicitly requires one. If the user only asks for research or an answer, do not save a file. A later explicit save request may use the research already in the conversation. Do not dump long documents into the chat reply; save it, then briefly summarise the key points and give the exact returned file path.',
    ...(conversational ? [] : ['- Keep reply to one or two sentences.']),
    '- CRITICAL: "open/spawn/launch X agent" without a real task (e.g. "open Claude", "spawn Codex", "launch an agent") means spawn with null prompt. Do NOT use the user\'s message as the agent\'s prompt — the user just wants the agent opened and ready, not given a meaningless task.',
    '- Only include a real task prompt when the user describes actual work to do ("fix this bug", "build a login page", "refactor the router").',
    '',
    'PLAN-AND-DELEGATE WORKFLOW — Only when the user explicitly requests delegation, use this two-phase pattern to create a plan and then dispatch sub-tasks to already-running agents:',
    '',
    'Phase 1 — Plan: When the user explicitly asks a worker to plan a task ("build X", "create a full Y", "implement Z with multiple parts"), spawn an agent to create a plan. Use a prompt like: "Create a detailed implementation plan for [the task]. Break it into clear numbered sub-tasks that can be worked on independently. Output ONLY the numbered plan, one sub-task per line." For that explicit delegation request, get the plan. Otherwise plan, implement, and verify the work directly with tools.',
    '',
    'Phase 2 — Delegate: In a later turn, the planning agent\'s terminal output appears under "Recent agent/task status and terminal output" (with status "complete" and the plan visible). When you see a completed plan AND running agents (under "Currently running agents") AND the user wants to proceed, READ THE PLAN from the terminal output and dispatch sub-tasks:',
    '  - For each sub-task in the plan, pick an available running agent (by name).',
    '  - Use a SEND action to push the sub-task: {"kind": "send", "target": "<agent name>", "prompt": "<fully self-contained sub-task>"}. Expand each one-line plan item into a full brief per DETAILED AGENT BRIEFS, adding the overall goal, which sibling sub-tasks other agents own (so this agent stays out of their files), and how to verify.',
    '  - You can issue MULTIPLE send actions in one turn to dispatch different sub-tasks to different agents simultaneously.',
    '  - If there are more sub-tasks than running agents, send one per agent and the rest will be dispatched in a follow-up turn when agents free up.',
    '  - If no agents are running, use SPAWN instead of SEND.',
    '',
    'Example: User says "Build a login system, plan first then delegate to my open agents." Turn 1: spawn claude to plan. Turn 2 (plan is ready, two agents "Neo" and "Trinity" are running): send sub-task 1 ("Set up the login form UI") to Neo, send sub-task 2 ("Create the auth API endpoint") to Trinity.',
    ...(conversational && !voice
      ? [
          '',
          'CHAT MODE — IMPORTANT:',
          'The user is typing to you in a chat panel, the way they would talk to ChatGPT or Claude. You are a hands-on assistant for THIS project: you answer questions, read and search the code, run commands, edit files, and plan multi-step work yourself with your tools. Delegating to a terminal agent is the exception, not the default.',
          '- ANSWER DIRECTLY. A general question (a concept, an API, "how do I…", an opinion) needs no tools: answer it fully right away. A question about THIS project\'s code needs evidence: grep_code / glob_files to locate, read_file to read, then answer citing the paths and line numbers you read. Never guess at code you have not read this turn.',
          '- FORMAT like a chat assistant: GitHub-flavored markdown, short paragraphs, bullet lists for distinct points, fenced code blocks with a language tag for code and commands, and `inline code` for paths, symbols, and commands. Use a compact, well-labeled table for comparisons or repeated fields; include consistent units and a brief lead-in or takeaway when it helps. Keep headers and columns concise, and use bullets for sequences or long prose. Add icons or emoji only when they make the information easier to scan. Lead with the answer; put detail after it. Length follows the question: a quick question gets a quick answer; a review or explanation gets the depth it needs.',
          '- STATUS ICONS — Use 🔴 for a confirmed failure or critical bug, 🟡 for a warning, partial result, or work not yet verified, and 🟢 only for a successful result supported by tool evidence. Put a short text label beside each icon, do not rely on color alone, and do not mark an overall result green when it also contains a confirmed failure.',
          '- DO THE WORK when asked to change something ("fix", "add", "rename", "update", "refactor"): read the relevant files, make the change with edit_file (or write_file for a new file), run the project\'s verification with run_command, and report what changed. Edits and commands are approval-gated in the UI when the user has not granted full access, so call the tool and let the user approve; do not ask "should I?" in prose first.',
          '- PLAN VISIBLY for work with 3 or more steps: after gathering context, call update_todos with the full plan, mark exactly one item in progress as you work it, and update statuses as items finish. Skip the plan for a single question or a one-step change.',
          '- ONE PLAN PER REQUEST: a plan covers only the work THIS message asks for. Checklists from earlier replies are history; never copy their finished items into a new plan. When the user adds to the work mid-conversation, plan the new items plus anything still unfinished, nothing else. The update_todos result shows the plan of record with its count; report progress from it, not from memory.',
          '- Spawn or send to a terminal agent only when the user explicitly asks for an agent, or the work is long-running or parallel enough that it cannot reasonably be done here. A question, an observation, brainstorming, or describing a problem is NOT a request to spawn.',
          '- ACTIONS RUN IMMEDIATELY — app-control, spawn, send, and close actions execute the moment you return them. State what you did in the reply; never pair an action with a "want me to go ahead?" question. If you need permission or a missing detail first, use ask_question with an EMPTY actions array.',
          '- Use the conversation so far: a follow-up like "do that", "yes", or "and the tests?" continues the previous request, so act on it instead of asking the user to repeat themselves.',
        ]
      : []),
    ...(conversational && voice
      ? [
          '',
          'VOICE CONVERSATION MODE — IMPORTANT:',
          'You are in a spoken, back-and-forth conversation. The user is talking WITH you, and they may ask you to do work while you keep replying conversationally.',
          '- Reply like a real person in conversation: usually two to four natural sentences. Be substantive — actually answer, add a relevant detail, ask a follow-up, or react — rather than a single clipped acknowledgement. Avoid one-word or one-line dead-end replies.',
          '- Vary your phrasing every turn. Never reuse the same stock opener or the same canned sentence twice in a row ("Got it.", "On it.", "Working on it." back-to-back sounds robotic). Keep it warm and human.',
          '- Always include a natural spoken acknowledgement in "reply", even when you are also returning actions. The reply should say what you are about to do or what you just did.',
          '- Use an EMPTY actions array for questions, brainstorming, observations, status checks, or anything that sounds like thinking out loud.',
          '- DO spawn/send/close or use APP-CONTROL actions when the user clearly asks you to do something — e.g. "fix X", "build Y", "run the tests", "open the preview", "switch to Dracula", "open an agent and add X", "spawn claude to fix Y", "have an agent do Z".',
           '- A question, an observation, thinking out loud, brainstorming, or describing a problem is NOT a request to spawn. When in any doubt, DO NOT act — just talk and, if useful, offer to put an agent on it.',
           '- Never spawn an agent merely because the message mentions code or a task. Wait for the explicit go-ahead.',
           '- ACTIONS RUN IMMEDIATELY — Every action you return (spawn/send/close AND app-control like navigate, open-file, preview, run, setting) is executed the moment you return it; there is NO held-action confirmation step. Phrase your "reply" as a short declarative statement of what you are doing — e.g. "Launching Claude to refactor the auth module." NEVER pair an action with a "want me to go ahead?" question; by the time the user hears it, the action has already run. If you truly need permission or clarification first, ask the question with an EMPTY actions array and act on the next turn once they answer.',
           '- READING AN AGENT\'S OUTPUT ALOUD — When the user asks what an agent produced, said, wrote, or found ("read me what Agent A did", "what did Trinity output?"), DO relay the actual content from the "Recent agent/task status and terminal output" section — that is the answer they want, not a status line. Convert it into speech: read the substance in plain spoken English, skip escape codes, box-drawing characters, progress bars and log noise, say file paths as words ("the orchestrator store" rather than spelling out src slash lib slash stores), and describe code by what it does instead of reading it character by character. Never dump raw terminal text verbatim.',
           '- If the output is long, lead with what the agent concluded or produced, then offer to go deeper ("that\'s the gist — want the detail on any part?") rather than reading everything at once.',
        ]
      : []),
    '',
    buildSkillsPrompt({ disabled: get(orchestratorDisabledSkills), custom: get(orchestratorCustomSkills) }),
    '',
    buildBrainToolsPrompt(),
  ].join('\n');
}


function snapAgent(raw: unknown, agents: AgentChoice[]): string | null {
  const agent = typeof raw === 'string' ? raw.trim() : '';
  if (!agent) return pickDefaultAgent(agents)?.command ?? null;
  // Exact command id is the happy path.
  const exact = agents.find((a) => a.command.toLowerCase() === agent.toLowerCase());
  if (exact) return exact.command;
  // The model may have returned a display name ("Codex CLI") or alias instead of
  // the command id — resolve it before falling back to the default.
  return resolveAgentCommand(agent, agents) ?? pickDefaultAgent(agents)?.command ?? null;
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

const VALID_ROLES: readonly AgentRole[] = ['coordinator', 'builder', 'scout', 'reviewer', 'orchestrator'];

/** Snap a model-supplied role string to a known preset, or null. */
function parseRole(raw: unknown): AgentRole | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return (VALID_ROLES as readonly string[]).includes(key) ? (key as AgentRole) : null;
}

/** Snap a model-supplied file list to a clean array of paths, or null. */
function parseFileList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const files = raw
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  return files.length ? files : null;
}

/**
 * Admin/release phrases that signal a task should bypass worktree isolation so
 * git tag/push/changelog operations work on the main branch directly. Exported
 * so sendChatMessage can apply the same check to heuristic-route spawns.
 *
 * These must be VERB PHRASES, not bare nouns. The first version matched bare
 * `tag`, `ship`, `deploy`, `publish` and `release`, so everyday feature work —
 * "add an image tag", "fix the ship date field", "restyle the deploy button",
 * "update the release notes component" — silently dropped the agent into the
 * shared main checkout, which is the exact collision worktree isolation exists
 * to prevent. Prefer the explicit `skipWorktree` flag; this is a narrow fallback.
 */
export const ADMIN_KEYWORD_RE = new RegExp(
  [
    /\bgit\s+tag\b/,
    /\b(create|add|push|cut)\s+(a\s+)?(new\s+)?(git\s+)?tag\b/,
    /\bcut(ting)?\s+(a\s+)?release\b/,
    /\b(publish|ship)\s+(a\s+)?(new\s+)?release\b/,
    /\brelease\s+v?\d/,
    /\b(bump|update)\s+(the\s+)?version\b/,
    /\bversion\s*bump\b/,
    /\b(npm|cargo|pnpm|yarn)\s+publish\b/,
    /\bpush\s+(to\s+)?(remote|origin|upstream)\b/,
    /\bupdate\s+(the\s+)?changelog\b/,
    /\bdeploy\s+(to\s+)?(prod|production|staging|vercel|netlify)\b/,
  ].map((r) => r.source).join('|'),
  'i',
);

/**
 * "…in the main repo", "…without a worktree" — the user naming the main
 * checkout as the place to run. Listed first because several of these mention
 * "worktree" negatively ("no worktree"), and `detectStatedPlacement` strips
 * every match before it looks for a positive worktree phrase.
 */
const MAIN_REPO_PHRASE_RE = new RegExp(
  [
    // A preposition is required here for the same reason as the worktree
    // patterns below: bare "main repo" fires on ordinary task text like "fix the
    // main repo button label". A bare answer is handled by STANDALONE_MAIN_RE.
    /\b(in|into|inside|on)\s+(the\s+)?(main|primary|actual|real|same)\s+(repo|repository|checkout|working\s+tree)\b/,
    // NO "in/on the main branch" pattern here, deliberately. A branch is where a
    // bug LIVES as often as it is where an agent should run — "fix the failing
    // test on the main branch" is task text, and matching it silently spawned an
    // unisolated agent without ever showing the placement dialog. Since a wrong
    // 'main' is the damaging direction (the agent edits the user's real working
    // tree unasked) and a miss only costs one click, the ambiguous phrasing falls
    // through to the dialog. A bare "main branch" reply is still an answer, and
    // STANDALONE_MAIN_RE handles that.
    /\b(in|into|inside)\s+(the\s+)?project\s+root\b/,
    /\bdirectly\s+in\s+the\s+(repo|repository|project)\b/,
    /\b(no|without|outside)\s+(a\s+|an\s+)?(isolated\s+)?work[\s-]?trees?\b/,
    /\bnot\s+in\s+(a\s+|an\s+)?work[\s-]?trees?\b/,
  ].map((r) => r.source).join('|'),
  'gi',
);

/**
 * "…in a worktree", "…in its own worktree", "isolate them".
 *
 * Every pattern requires a PREPOSITION in front of the noun. Matching a bare
 * "worktree" would fire on ordinary task text — "remove the worktree cleanup
 * code" — and silently skip the placement dialog for a request that never
 * mentioned placement at all.
 *
 * A bare "in isolation" is NOT here for the same reason: "refactor the parser so
 * it can be tested in isolation" is a description of the work, not of where to
 * run it, and matching it skipped the dialog outright. The imperative "isolate
 * it / them" stays, because an instruction to isolate has no second reading.
 * A one-word "isolation" reply is covered by STANDALONE_WORKTREE_RE.
 */
const WORKTREE_PHRASE_RE = new RegExp(
  [
    /\b(in|into|inside|on|using|with)\s+(its\s+own\s+|their\s+own\s+|a\s+|an\s+|the\s+)?(new\s+|separate\s+|isolated\s+|fresh\s+)?work[\s-]?trees?\b/,
    /\bisolate\s+(it|them|that|those|each|the\s+agents?)\b/,
  ].map((r) => r.source).join('|'),
  'i',
);

/**
 * A bare answer to "worktree or main repo?" — the voice follow-up turn. Covers
 * "isolation" / "isolated" as a whole reply, which is why WORKTREE_PHRASE_RE can
 * afford to drop the ambiguous mid-sentence "in isolation".
 */
const STANDALONE_WORKTREE_RE = /^\s*(in\s+)?(an?\s+|the\s+)?(new\s+|separate\s+|isolated\s+)?(work[\s-]?trees?|isolation|isolated)\b[\s.!]*$/i;
const STANDALONE_MAIN_RE = /^\s*(in\s+)?(the\s+)?(main|primary)\s*(repo(sitory)?|branch|checkout)?\b[\s.!]*$/i;

/**
 * Read an explicit placement out of what the user actually said. Returns `null`
 * when they didn't say — the caller must then ask — and ALSO when they named
 * both places in one breath ("one in a worktree, another in the main repo"),
 * because that is a per-agent decision only the LLM can split.
 */
export function detectStatedPlacement(text: string): SpawnPlacement | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  if (STANDALONE_WORKTREE_RE.test(trimmed)) return 'worktree';
  if (STANDALONE_MAIN_RE.test(trimmed)) return 'main';

  const withoutMain = trimmed.replace(MAIN_REPO_PHRASE_RE, ' ');
  const saysMain = withoutMain !== trimmed;
  const saysWorktree = WORKTREE_PHRASE_RE.test(withoutMain);
  if (saysMain && saysWorktree) return null;
  if (saysMain) return 'main';
  if (saysWorktree) return 'worktree';
  return null;
}

function parsePlacement(raw: unknown): SpawnPlacement | null {
  const value = str(raw).toLowerCase();
  if (value === 'worktree' || value === 'isolated') return 'worktree';
  if (value === 'main' || value === 'main-repo' || value === 'root') return 'main';
  return null;
}

function parseReasoningEffort(raw: unknown): ChatReasoningEffort {
  const value = str(raw).toLowerCase();
  return (VALID_REASONING_EFFORTS as readonly string[]).includes(value)
    ? value as ChatReasoningEffort
    : 'default';
}

/**
 * Fill in `placement` for spawns the model left unset, from a placement the user
 * stated for the whole request ("open two agents in the main repo"). Only
 * applied when the message names ONE place — a mixed request stays per-action,
 * where the model's own `placement` is the only thing that can split it.
 */
export function withStatedPlacement(result: RouteResult, message: string): RouteResult {
  const stated = detectStatedPlacement(message);
  const cleanedReply = cleanOrchestratorReply(result.reply);
  if (!stated || !result.actions.some((a) => a.kind === 'spawn' && !a.placement)) {
    return cleanedReply !== result.reply ? { ...result, reply: cleanedReply } : result;
  }
  return {
    ...result,
    reply: cleanedReply,
    actions: result.actions.map((action) =>
      action.kind === 'spawn' && !action.placement ? { ...action, placement: stated } : action
    ),
  };
}

function parseAction(raw: unknown, agents: AgentChoice[]): OrchestratorAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = str(obj.kind);
  if (kind === 'spawn') {
    const agent = snapAgent(obj.agent, agents);
    if (!agent) return null;
    const prompt = str(obj.prompt);
    const name = str(obj.name);
    const role = parseRole(obj.role);
    const files = parseFileList(obj.files);
    const model = str(obj.model) || null;
    const rawReasoningEffort = obj.reasoningEffort ?? obj.reasoning_effort;
    const reasoningEffort = rawReasoningEffort == null ? undefined : parseReasoningEffort(rawReasoningEffort);
    // The brain can explicitly set skipWorktree, or we auto-detect it from
    // admin/release keywords in the prompt so e.g. "tag v2.0 and push"
    // automatically bypasses isolation without the LLM needing to know about it.
    const skipWorktree =
      obj.skipWorktree === true ||
      (!!prompt && ADMIN_KEYWORD_RE.test(prompt));
    // `placement` is what the USER stated, so it's authoritative and skips the
    // placement dialog. It is deliberately NOT inferred from `prompt`: the task
    // text can mention a worktree without being about placement at all.
    const placement = parsePlacement(obj.placement);
    return {
      kind: 'spawn',
      agent,
      prompt: prompt || null,
      name: name || null,
      role,
      files,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      skipWorktree,
      placement,
    };
  }
  if (kind === 'send') {
    const target = str(obj.target);
    const prompt = str(obj.prompt);
    if (!target || !prompt) return null;
    return { kind: 'send', target, prompt };
  }
  if (kind === 'name') {
    const target = str(obj.target);
    const name = str(obj.name);
    if (!target || !name) return null;
    return { kind: 'name', target, name };
  }
  if (kind === 'close') {
    const target = str(obj.target);
    if (!target) return null;
    return { kind: 'close', target };
  }
  if (kind === 'navigate') {
    const view = str(obj.view).toLowerCase();
    if (!view) return null;
    return { kind: 'navigate', view };
  }
  if (kind === 'open-file' || kind === 'open_file' || kind === 'openfile') {
    const path = str(obj.path);
    if (!path) return null;
    const lineNum = typeof obj.line === 'number' && Number.isFinite(obj.line) && obj.line > 0 ? Math.floor(obj.line) : null;
    return { kind: 'open-file', path, line: lineNum };
  }
  if (kind === 'close-file' || kind === 'close_file' || kind === 'closefile') {
    const path = str(obj.path);
    if (!path) return null;
    return { kind: 'close-file', path };
  }
  if (kind === 'preview' || kind === 'navigate-preview') {
    const url = str(obj.url);
    if (!url) return null;
    return { kind: 'preview', url };
  }
  if (kind === 'run') {
    const command = str(obj.command);
    if (!command) return null;
    return { kind: 'run', command };
  }
  if (kind === 'setting' || kind === 'config' || kind === 'theme') {
    // "theme" is sugar for a setting action targeting the theme.
    const setting = kind === 'theme' ? 'theme' : str(obj.setting || obj.key).toLowerCase();
    const rawValue = kind === 'theme' ? (obj.theme ?? obj.value) : obj.value;
    if (!setting) return null;
    if (typeof rawValue === 'string') {
      const v = rawValue.trim();
      if (!v) return null;
      return { kind: 'setting', setting, value: v };
    }
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      return { kind: 'setting', setting, value: rawValue };
    }
    if (typeof rawValue === 'boolean') {
      return { kind: 'setting', setting, value: rawValue };
    }
    return null;
  }
  if (kind === 'layout') {
    const mode = str(obj.mode).toLowerCase();
    if (mode === 'focus' || mode === 'development' || mode === 'gallery' || mode === 'preview') {
      return { kind: 'layout', mode: mode as any };
    }
    return null;
  }
  if (kind === 'room') {
    const op = str(obj.op).toLowerCase();
    const target = str(obj.target);
    if (!target) return null;
    if (op === 'focus' || op === 'minimize' || op === 'restore' || op === 'close') {
      return { kind: 'room', op, target };
    }
    return null;
  }
  if (kind === 'task') {
    const op = str(obj.op).toLowerCase();
    const title = str(obj.title);
    if (!title) return null;
    if (op === 'create' || op === 'todo' || op === 'doing' || op === 'done' || op === 'delete') {
      return { kind: 'task', op, title };
    }
    return null;
  }
  if (kind === 'canvas' || kind === 'board') {
    // The Canvas board was removed. Parsing these into an action was worse than
    // rejecting them: `executeAppAction` returned true for a command nothing
    // consumed, so the orchestrator reported success for a no-op.
    return null;
  }
  return null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  // Be lenient: grab the first {...} block if the model added stray text.
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseRouteJson(raw: string, agents: AgentChoice[]): RouteResult | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;
  const reply = str(obj.reply);

  const actions: OrchestratorAction[] = [];
  if (Array.isArray(obj.actions)) {
    for (const entry of obj.actions) {
      const action = parseAction(entry, agents);
      if (action) actions.push(action);
    }
  } else if (obj.dispatch && typeof obj.dispatch === 'object') {
    // Back-compat: an older single-dispatch shape → one spawn action.
    const d = obj.dispatch as Record<string, unknown>;
    const agent = snapAgent(d.agent, agents);
    const prompt = str(d.prompt);
    if (agent && prompt) actions.push({ kind: 'spawn', agent, prompt, name: null });
  }

  const needsInput = obj.needsInput === true;
  const readFiles = Array.isArray(obj.readFiles)
    ? obj.readFiles.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    : undefined;
  const rawInput = obj.inputRequest;
  const inputRequest = rawInput && typeof rawInput === 'object'
    ? (() => {
        const value = rawInput as Record<string, unknown>;
        const question = str(value.question);
        if (!question) return undefined;
        const options = Array.isArray(value.options)
          ? value.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
          : [];
        const target = str(value.target);
        return { question, options, ...(target ? { target } : {}) };
      })()
    : undefined;
  const rawTodos = obj.todos;
  const todos = Array.isArray(rawTodos)
    ? rawTodos
        .map((t) => (typeof t === 'string' ? t.trim() : typeof t === 'object' && t !== null && 'label' in t ? String((t as any).label).trim() : ''))
        .filter(Boolean)
    : undefined;
  if (!reply && actions.length === 0 && !needsInput && !readFiles?.length && !todos?.length) return null;
  return {
    reply: cleanOrchestratorReply(reply || inputRequest?.question || 'Working on it.'),
    actions,
    viaLLM: true,
    ...(readFiles?.length ? { readFiles } : {}),
    ...(needsInput ? { needsInput: true } : {}),
    ...(inputRequest ? { inputRequest } : {}),
    ...(obj.failed === true ? { failed: true } : {}),
    ...(todos?.length ? { todos } : {}),
  };
}

/**
 * A model's final answer does not need to be JSON. JSON remains required for
 * executable actions and tool requests, but ordinary replies can be returned
 * as plain text or markdown and shown directly in the response card.
 */
function parseRouteResponse(raw: string, agents: AgentChoice[]): RouteResult | null {
  const structured = parseRouteJson(raw, agents);
  if (structured) return structured;

  const reply = raw.trim();
  if (!reply || isProtocolDebris(reply)) return null;
  return { reply: cleanOrchestratorReply(reply), actions: [], viaLLM: true };
}

/**
 * A reply that is only protocol JSON the loop could not use: an empty or
 * unknown-tool `{"tool_calls":[]}`, or a bare reply/actions envelope that did
 * not parse. Prose replies are allowed, but this is not prose, and showing it
 * put a raw `{"tool_calls":[]}` in the chat instead of a retry.
 */
export function isProtocolDebris(text: string): boolean {
  const unfenced = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  if (!unfenced.startsWith('{') || !unfenced.endsWith('}')) return false;
  return /"(?:tool_calls|actions|reply|needsInput)"\s*:/.test(unfenced);
}

function parseToolQuestion(call: BrainToolCall): RouteResult {
  const question = str(call.args.question) || 'I need one detail from you before I continue.';
  const options = Array.isArray(call.args.options)
    ? call.args.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0).slice(0, 6)
    : typeof call.args.options === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(call.args.options);
            return Array.isArray(parsed)
              ? parsed.filter((option): option is string => typeof option === 'string' && option.trim().length > 0).slice(0, 6)
              : [];
          } catch {
            return [];
          }
        })()
      : [];
  const target = str(call.args.target);
  const lead = target ? `${target} is waiting on you: ${question}` : question;
  const reply = options.length
    ? `${lead}\n${options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
    : lead;
  return {
    reply: cleanOrchestratorReply(reply),
    actions: [],
    viaLLM: true,
    needsInput: true,
    inputRequest: { question, options, ...(target ? { target } : {}) },
  };
}

async function executeBrainToolCalls(
  calls: BrainToolCall[],
  executor: BrainToolExecutor,
): Promise<{ results: BrainToolResult[]; actions: OrchestratorAction[] }> {
  const execute = async (call: BrainToolCall): Promise<{ result: BrainToolResult; actions: OrchestratorAction[] }> => {
    try {
      const invalid = validateToolCall(call);
      if (invalid) throw new Error(invalid);
      const executed = await executor(call);
      // `ok` deliberately lumps "never reported" (TIMEOUT, SESSION CLOSED,
      // error:) in with "reported badly" (exit N) — for the model, both mean
      // the call did not deliver. The completion card must NOT: it splits them
      // again via `INCONCLUSIVE_RUN_RE` in `orchestrator/chat-turn.ts`, which
      // matches these same prefixes. Keep the two lists in step.
      return {
        result: {
          id: call.id,
          name: call.name,
          ok: !/^error:|^TIMEOUT|^SESSION CLOSED|^exit [1-9]/i.test(String(executed.output ?? '')),
          output: String(executed.output ?? ''),
          ...(executed.images?.length ? { images: executed.images } : {}),
        },
        actions: executed.actions ?? [],
      };
    } catch (error) {
      return {
        result: { id: call.id, name: call.name, ok: false, output: `error: ${String(error ?? 'unknown')}` },
        actions: [],
      };
    }
  };

  // PURE-READ batches run CONCURRENTLY (matching the prompt contract): a
  // batch of four file reads previously cost four round-trips of serial
  // latency. Any batch containing a write/execute call runs fully sequentially
  // in declared order — a model that declares read_file after write_file
  // intends the read to see the write, and interleaving families would break
  // that guarantee.
  const all: Array<{ result: BrainToolResult; actions: OrchestratorAction[] }> = [];
  if (calls.every((call) => BRAIN_READONLY_TOOLS.has(call.name))) {
    all.push(...await Promise.all(calls.map((call) => execute(call))));
  } else {
    for (const call of calls) all.push(await execute(call));
  }
  return {
    results: all.map((entry) => entry.result),
    actions: all.flatMap((entry) => entry.actions),
  };
}

/**
 * Route a natural-language request to the agent fleet. Uses the configured AI
 * provider when available (smarter routing + a real reply); otherwise falls back
 * to a keyword heuristic so the orchestrator still works with no API key.
 */
export async function routeOrchestratorRequest(
  message: string,
  agents: AgentChoice[],
  ctx?: RouteContext
): Promise<RouteResult> {
  const trimmed = message.trim();
  const acknowledgement = isAcknowledgement(trimmed);

  // Fast-path: status check — respond instantly from live state, no LLM needed.
  if (STATUS_CHECK_RE.test(trimmed)) {
    return { reply: cleanOrchestratorReply(formatStatusReply(outputRefs(ctx))), actions: [], viaLLM: false };
  }

  // Fast-path: "read out what Iris outputted" — the user wants to HEAR the
  // agent's actual output, not a digest of it. Handled before the LLM on
  // purpose: routing through the model would paraphrase the very text they
  // asked to have read verbatim, and burn a call to do it. Falls through to the
  // summary path below when nothing matches the name they used.
  if (READ_ALOUD_RE.test(trimmed) && ctx?.readAgentTranscript) {
    const read = ctx.readAgentTranscript(trimmed);
    if (read) return { reply: cleanOrchestratorReply(formatReadAloud(read)), actions: [], viaLLM: false };
  }

  // Fast-path: output query — user wants to read what an agent said/wrote.
  // Never send a new message; just surface the terminal output directly.
  if (OUTPUT_QUERY_RE.test(trimmed)) {
    return { reply: cleanOrchestratorReply(formatOutputReply(outputRefs(ctx), !!ctx?.conversational)), actions: [], viaLLM: false };
  }

  if (TASK_ADVICE_RE.test(trimmed) && (ctx?.taskPanel?.length ?? 0) > 0) {
    return { reply: cleanOrchestratorReply(formatTaskPanelAdvice(ctx?.taskPanel ?? [])), actions: [], viaLLM: false };
  }

  // Fast-path: "open 2 claude code agents" — the harness opens them itself,
  // whatever model is the brain. Placement ("in a worktree") is applied below.
  const openAgents = parseOpenAgentsCommand(trimmed, agents);
  if (openAgents) return withStatedPlacement(openAgentsRoute(openAgents), trimmed);

  const provider = ctx?.llmConfig?.provider ?? get(aiProvider);
  const local = isLocalProvider(provider);
  const hasApiKey = ctx?.llmConfig?.hasApiKey ?? isProviderApiKeyConfiguredLocal(provider);
  const baseUrl = ctx?.llmConfig?.baseUrl ?? (local ? getProviderBaseUrl(provider) : '');
  const configured = local ? !!baseUrl : !!hasApiKey;
  let providerFailureReply: string | null = null;

  if (configured) {
    const def = getProviderDef(provider);
    const primaryModel = ctx?.llmConfig?.model ?? get(currentAiModel);
    const [routeAdvice, reasoningAdvice] = ctx?.conversational
      ? await Promise.all([
          classifyRouting(trimmed),
          suggestReasoningLevel(trimmed, provider, primaryModel),
        ])
      : [null, null];
    const modelsToTry = [primaryModel];
    warmLaunchCatalogues(agents);
    const baseSystemPrompt = buildSystemPrompt(agents, ctx?.runningAgents ?? [], ctx?.reviewingAgents ?? [], ctx?.conversational, ctx?.profile, ctx?.voice === true)
      + (routeAdvice || reasoningAdvice
        ? `\nJev advisory for this prompt: ${routeAdvice ?? 'no routing suggestion'}; reasoning effort ${reasoningAdvice ?? 'no suggestion'}. This is a suggestion only. Keep the user's explicit choices and all delegation approval rules.`
        : '');
    const maxToolRounds = ctx?.maxToolRounds ?? ctx?.budgets?.maxRounds ?? DEFAULT_AGENT_BUDGETS.maxRounds;

    for (const model of modelsToTry) {
      const profile = brainToolProfile(ctx?.budgets?.toolProfile ?? ctx?.toolProfile ?? 'full');
      const transport = ctx?.nativeTools && ctx.toolExecutor ? new AgentTransport(provider, model, ctx.checkpoint, ctx.saveCheckpoint, ctx.signal, { ...ctx.budgets, toolProfile: ctx.budgets?.toolProfile ?? ctx.toolProfile }) : undefined;
      const onReplyStream = ctx?.onReplyStream;
      if (transport && onReplyStream) {
        let streamed = '';
        let shown = '';
        const show = (preview: string) => {
          if (preview === shown) return;
          shown = preview;
          try { onReplyStream(preview); } catch { /* display only */ }
        };
        transport.stream = {
          start: () => { streamed = ''; show(''); },
          delta: (text) => { streamed += text; show(streamingReplyPreview(streamed) ?? ''); },
        };
      }
      // Undefined until the loop RAISES it: normal requests must keep the
      // exact budget shape they had before (the transport's own budgets, the
      // Rust default), so the override only ever applies after a starved or
      // protocol-failed reply, and it persists for the rest of the turn so
      // later recovery passes and the forced final pass inherit the room.
      let raisedOutputTokens: number | undefined;
      const complete = async (systemPrompt: string, userText: string, final = false): Promise<string> => {
        const startedAt = Date.now();
        try {
          return await (transport
            ? transport.request(systemPrompt, userText, baseUrl || undefined, ctx?.llmConfig?.sessionId, final, raisedOutputTokens)
            : invoke<string>('ai_complete', { systemPrompt, userText, provider, model, apiKey: '', baseUrl: baseUrl || undefined, sessionId: ctx?.llmConfig?.sessionId, ...(raisedOutputTokens !== undefined ? { maxTokens: raisedOutputTokens } : {}) }));
        } finally {
          try { ctx?.onModelCall?.(Date.now() - startedAt); } catch { /* observational only */ }
        }
      };
      let toolRounds = 0;
      let toolResults: BrainToolResult[] = [];
      let toolSignatures: string[] = [];
      let executedActions: OrchestratorAction[] = [];
      let promiseRecoveryUsed = false;
      let deferredRecoveryUsed = false;
      let mediaRecoveryUsed = false;
      let incompleteReviewRecoveryPages = 0;
      let incompleteFileRecoveryPages = 0;
      let directPolicyRecoveryUsed = false;
      let claimWriteRecoveryUsed = false;
      let verificationRecoveryUsed = false;
      let correctionRecoveryUsed = false;
      let repeatRecoveryUsed = false;
      // The automatic post-edit check runs at most twice per turn: once for the
      // edits, once more after the model fixes what the first run reported.
      let postEditChecks = 0;
      // User messages steered into this running turn, in arrival order.
      const steeredMessages: string[] = [];
      const turnMessage = (): string => (steeredMessages.length
        ? `${message}\n\nMessages the user sent while you were working (newest last; they refine or redirect the request above, take them into account now):\n${steeredMessages.map((text) => `- ${text}`).join('\n')}`
        : message);
      let protocolRecoveryUsed = false;
      let reviewPlanRecoveryUsed = false;
      let reviewExecutionRecoveryUsed = false;
      let executionNote = '';
      let networkAttempts = 0;
      // Todos the model attached to its LATEST response. Tool rounds legitimately
      // carry an intended plan; a FINAL response may not (a checklist in a FINAL
      // reply with no tool work behind it is the fake "5/5 done" card).
      let intendedTodos: string[] | null = null;

      // Broad reviews (and short go-aheads continuing one) must not depend on
      // the model remembering to turn a file list into reads. Gather the
      // bounded source snapshot before the first model response, so the
      // recommendations can be returned in this turn and the evidence gates
      // below have something to enforce.
      if (
        ctx?.toolExecutor &&
        ctx.projectRoot &&
        (isBroadDirectReviewRequest(trimmed) || isContinuationOfDirectWork(trimmed, ctx)) &&
        !ctx.toolResults?.some((result) => result.name === 'read_project')
      ) {
        const reviewCall: BrainToolCall = { id: 'review-project', name: 'read_project', args: { max_files: 80 } };
        const reviewExecution = await executeBrainToolCalls([reviewCall], ctx.toolExecutor);
        toolResults = reviewExecution.results;
        executedActions = reviewExecution.actions;
        toolSignatures = [brainToolSignature(reviewCall)];
        toolRounds = 1;
        try { ctx.onToolRound?.(toolResults, toolRounds); } catch { /* observational only */ }
        executionNote = reviewExecution.results[0]?.ok
          ? 'A broad project snapshot was already gathered before this response. Review it and return concrete findings and suggested changes now. Do not ask the user to prompt you again.'
          : 'The initial project inspection did not return successful evidence. Use a read-only tool to inspect the project before making any claims about it.';
      }
      try {
        while (true) {
          ctx?.signal?.throwIfAborted();
          steeredMessages.push(...(ctx?.steering?.drain() ?? []));
          const routeContext: RouteContext = {
            ...ctx,
            toolResults: transport ? toolResults.filter(r => r.id === 'review-project') : toolResults,
            executionNote: executionNote || undefined,
          };
          const userText = buildUserText(turnMessage(), routeContext);
          const systemPrompt = executionNote.startsWith('Execution has stopped')
            ? `${baseSystemPrompt}\n\n${executionNote}`
            : baseSystemPrompt;
          let raw: string;
          // The retry budget is PER REQUEST. It used to be one retry for the
          // whole turn, so a long agentic turn that absorbed a single blip in
          // round 2 died on the next blip in round 15 with "could not reach".
          for (let attempt = 0; ; attempt += 1) {
            try {
              raw = await complete(systemPrompt, userText);
              break;
            } catch (error) {
              const msg = String(error ?? '');
              networkAttempts = attempt;
              if (!isTransientProviderFailure(msg) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw error;
              ctx?.signal?.throwIfAborted();
              await new Promise(resolve => setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]));
              ctx?.signal?.throwIfAborted();
            }
          }
          const rawText = typeof raw === 'string' ? raw : '';
          const calls = parseBrainToolCalls(rawText);

          if (calls?.length) {
            const question = calls.find((call) => BRAIN_ASK_TOOLS.has(call.name));
            if (question) return parseToolQuestion(question);

            // Before executing, remember protocol-only fields (reply, todos)
            // that mixed-mode responses carry alongside tool_calls: they
            // describe the INTENDED plan, not completed work. Surfacing them
            // as turn todos made the store render a fully checked-off plan
            // card for a turn whose tools had not run yet.
            intendedTodos = parseBrainTodos(rawText);

            // Older callers use the legacy readFiles round-trip. Preserve it
            // when this route is used without the store-owned executor.
            if (!ctx?.toolExecutor) {
              const readFiles = calls
                .filter((call) => call.name === 'read_file')
                .map((call) => toolArgStr(call.args, 'path'))
                .filter((path): path is string => Boolean(path));
              const parsed = parseRouteJson(rawText, agents);
              if (readFiles.length) {
                return withStatedPlacement({
                  ...(parsed ?? { reply: 'Let me inspect that.', actions: [], viaLLM: true }),
                  readFiles,
                  todos: undefined,
                }, trimmed);
              }
              return {
                ...(parsed ?? { reply: 'I could not execute that request in this context.', actions: [], viaLLM: true }),
                failed: true,
              };
            }

            // Only tools that will actually run count toward the doom loop:
            // profile-stripped calls must not poison the signature history.
            const profiledCalls = profile.mutating ? calls : calls.filter((call) => profile.allowed.has(call.name));
            const nextSignatures = [...toolSignatures, ...profiledCalls.filter(c => c.name !== 'command_status' && c.name !== 'wait_for_agent').map(brainToolSignature)];
            const doomLoop = isDoomLoop(nextSignatures);
            if (toolRounds >= maxToolRounds || doomLoop) {
              executionNote = doomLoop
                ? 'Execution has stopped because the same tool request repeated. Return a FINAL answer using the evidence already available, or explain what remains without requesting another tool.'
                : 'Execution has stopped because the tool-call budget was reached. Return a FINAL answer using the evidence already available, and be explicit about any verification that remains unfinished.';
              const finalContext: RouteContext = {
                ...ctx,
                toolResults,
                executionNote,
              };
              const finalRaw = await complete(`${baseSystemPrompt}\n\n${executionNote}`, buildUserText(turnMessage(), finalContext), true);
              const finalText = typeof finalRaw === 'string' ? finalRaw : '';
              const finalCalls = parseBrainToolCalls(finalText);
              const finalResult = finalCalls ? null : parseRouteResponse(finalText, agents);
              if (finalResult) {
                return withStatedPlacement({
                  ...finalResult,
                  actions: [...executedActions, ...finalResult.actions],
                  failed: true,
                }, trimmed);
              }
              return {
                reply: 'I stopped before claiming that work was complete because the execution limit was reached.',
                actions: executedActions,
                viaLLM: true,
                failed: true,
              };
            }

            ctx.signal?.throwIfAborted();
            // Text-mode profile enforcement mirrors the native transport's:
            // tools outside the profile never reach the executor.
            const execution = await executeBrainToolCalls(profiledCalls, ctx.toolExecutor);
            await transport?.record(execution.results);
            toolResults = [...toolResults, ...execution.results];
            executedActions = [...executedActions, ...execution.actions];
            toolSignatures = nextSignatures;
            toolRounds += 1;
            // The turn's plan has exactly ONE surface: the update_todos tool.
            // The opening narration is deliberately NOT rendered as a plan —
            // a second, narration-derived card duplicated the ticker and
            // disagreed with it, and the tool's own state is the honest one.
            try { ctx.onToolRound?.(toolResults, toolRounds); } catch { /* observational only */ }
            continue;
          }

          const result = parseRouteResponse(rawText, agents);
          if (result && result.todos?.length && !(intendedTodos?.length)) {
            // FINAL with a checklist but no tool work behind it: the user sees
            // every box pre-checked while nothing was verified. Strip it; the
            // honest-failure path or a recovery pass takes over below.
            result.todos = undefined;
          }
          if (!result) {
            if (!protocolRecoveryUsed) {
              protocolRecoveryUsed = true;
              // A reasoning model usually fails the protocol by STARVATION, not
              // disobedience: hidden thinking tokens consume the output budget
              // and the FINAL object arrives truncated (finish_reason length),
              // so no rewording of the instruction alone can fix it. Raise the
              // output budget before the retry — with_reasoning_headroom's 4x
              // on the Rust side turns this into a real ceiling bump — and
              // keep it for the rest of the turn so later recovery passes and
              // the forced final pass inherit the room instead of re-failing.
              // It is a ceiling, not a spend, so a compliant model is unchanged.
              raisedOutputTokens = Math.max(
                (raisedOutputTokens ?? ctx?.llmConfig?.outputTokens ?? DEFAULT_AGENT_BUDGETS.outputTokens) * 4,
                DEFAULT_AGENT_BUDGETS.outputTokens,
              );
              executionNote = [
                ...(/"tool_calls"\s*:/.test(rawText)
                  ? ['Your previous response was a tool_calls list with no usable tool in it. App actions such as spawn, navigate, open-file or setting are NOT tools: return them in a FINAL {"reply":"...","actions":[...]} object. Call a tool only by one of the listed tool names.']
                  : []),
                'The previous model response did not follow the required JSON protocol.',
                `Convert the useful content into exactly one valid JSON object now; this retry has a larger output budget (${raisedOutputTokens} tokens), so return the complete answer and do not truncate it to save tokens.`,
                'Return either FINAL {"reply":"...","needsInput":false,"actions":[]} or a valid TOOL REQUEST.',
                'Do not include markdown fences, commentary, or any text outside the JSON object.',
              ].join(' ');
              continue;
            }
            throw new Error('protocol: the model did not return a valid final reply');
          }

          // "But there is a .env.local file": the user disputes the previous
          // answer. A reply built from memory just repeated the old report,
          // false claim included (0 operations). The correction must be
          // checked with a tool this turn before any answer is accepted.
          if (
            ctx?.toolExecutor
            && !correctionRecoveryUsed
            && !result.needsInput
            && disputesPreviousAnswer(trimmed, ctx)
            && !toolResults.some((tool) => tool.id !== 'review-project' && tool.name !== 'update_todos')
          ) {
            correctionRecoveryUsed = true;
            executionNote = `The user is correcting your previous answer: "${compactText(trimmed, 300)}". Do not repeat that answer. Check the claim with tools now (glob_files also lists git-ignored files; read_file, grep_code, run_command), then say plainly what was wrong, what the evidence shows, and give only the corrected findings.`;
            continue;
          }

          // Re-sending the previous answer is not an answer to a new message.
          if (!repeatRecoveryUsed && !result.needsInput && repeatsPreviousAnswer(result.reply, trimmed, ctx)) {
            repeatRecoveryUsed = true;
            executionNote = `Your reply repeats your previous answer almost word for word. The user asked something new: "${compactText(trimmed, 300)}". Answer that message specifically, using tools if it needs checking; mention earlier findings only where they bear on it.`;
            continue;
          }
          // Never answer a thank-you by re-sending the work, even when the
          // corrective pass above repeated it again.
          if (acknowledgement && repeatsPreviousAnswer(result.reply, trimmed, ctx)) {
            return { ...result, reply: ACKNOWLEDGEMENT_FALLBACK_REPLY, actions: executedActions };
          }

          // A turn does not end while the user has steered a message into it:
          // the next request carries the message, and the model continues.
          if (ctx?.steering?.pending()) {
            executionNote = 'The user sent a new message while you were working; it is shown with the request now. Take it into account and continue this turn. Do not finish without addressing it.';
            continue;
          }

          // Models can still reach for a worker despite the direct-first
          // contract. Give that model one corrective pass with the same app
          // context and tool executor before accepting the plan. If it repeats
          // the violation, strip only the delegation so no unsolicited agent
          // starts and report the limitation honestly.
          // Short go-aheads ("okay", "continue with the program") inherit the
          // previous direct-review request, so every evidence gate below must
          // treat them like the review they continue. Without this, the
          // follow-up turn dodged the gates entirely ("okay" matches no review
          // pattern), accepted a conversational FINAL with zero tool rounds,
          // and surfaced a fully checked-off plan the turn never executed.
          const followUpDirectReview = isDirectAdviceOnlyRequest(trimmed)
            || isBroadDirectReviewRequest(trimmed)
            || isContinuationOfDirectWork(trimmed, ctx);
          const directReviewDelegates = followUpDirectReview
            && !EXPLICIT_SPAWN_RE.test(trimmed)
            && hasDelegationAction(result.actions);
          if (directReviewDelegates && !directPolicyRecoveryUsed) {
            directPolicyRecoveryUsed = true;
            executionNote = 'This is a direct review and recommendation request. Do not spawn or send an agent. Use app state and read-only tools, then return the findings directly.';
            continue;
          }
          if (directReviewDelegates) {
            return withStatedPlacement({
              ...result,
              reply: 'I did not start an agent because this is a direct review request, but the model did not produce the review itself.',
              actions: result.actions.filter((action) => action.kind !== 'spawn' && action.kind !== 'send'),
              failed: true,
            }, trimmed);
          }

          // A reply claiming "File created: docs/x.md" (or "saved the
          // suggestions as a document") without a successful write this turn
          // is a fabrication the user then cannot find on disk. Force one
          // corrective pass; if the model still claims it, correct the record
          // honestly instead of letting the claim stand.
          if (ctx?.toolExecutor && replyClaimsDocumentWrite(result.reply)) {
            const claimedPaths = findClaimedWritePaths(result.reply);
            const writeOutputs = toolResults
              .filter((tool) => tool.ok && (tool.name === 'write_file' || tool.name === 'save_document' || tool.name === 'edit_file'))
              .map((tool) => tool.output);
            if (!writeEvidenceCoversClaims(claimedPaths, writeOutputs)) {
              if (!claimWriteRecoveryUsed) {
                claimWriteRecoveryUsed = true;
                executionNote = 'Your previous reply claimed a file or document was created, but no write tool executed this turn. Either create it now with save_document for a user document or write_file for a project file, or return the same reply WITHOUT claiming any file was created. Never state a file exists unless a tool result proves it.';
                continue;
              }
              result.reply = `${result.reply}\n\n(Note: no file was actually written this turn; the creation claim above did not happen.)`;
            }
          }

          // Before asking the model to verify, run the project's own check
          // for it (the cheap stand-in for OpenCode's post-edit LSP errors).
          // A failure goes back to the model with the output so it fixes the
          // errors in this turn; a pass is recorded as the verification run.
          if (
            ctx?.postEditCheck
            && postEditChecks < 2
            && !result.failed
            && !result.needsInput
            && !result.actions.length
            && hasUnverifiedMutation(toolResults)
          ) {
            postEditChecks += 1;
            const check = await ctx.postEditCheck();
            ctx.signal?.throwIfAborted();
            if (check) {
              toolResults = [...toolResults, { id: `post-edit-check-${postEditChecks}`, name: 'run_command', ok: check.ok, output: check.output }];
              try { ctx.onToolRound?.(toolResults, toolRounds); } catch { /* observational only */ }
              if (!check.ok && postEditChecks < 2) {
                executionNote = `The automatic check after your edits failed (\`${check.command}\`). Fix the errors in the files you changed, then finish. Output:\n${check.output.slice(0, 6_000)}`;
                continue;
              }
              if (!check.ok) {
                result.reply = `${result.reply}\n\n(Note: the automatic check \`${check.command}\` still fails after the last edit.)`;
              }
            }
          }

          // A turn that changed files and never ran a verification command is
          // reaching FINAL with work nothing checked. One corrective pass, and
          // only one: the model may have run its verification before the last
          // edit, or the command may have timed out before printing, and a
          // second nudge would stall a turn that cannot satisfy it. It never
          // fires for a question, a dispatch, or a failed turn, and a project
          // with no verification command ends the turn by SAYING so — see the
          // VERIFY BEFORE FINISHING rule in the prompt.
          if (
            ctx?.toolExecutor
            && !verificationRecoveryUsed
            && !result.failed
            && !result.needsInput
            && !result.actions.length
            && !result.readFiles?.length
            && hasUnverifiedMutation(toolResults)
          ) {
            verificationRecoveryUsed = true;
            executionNote = 'You changed files this turn but ran no verification afterwards. Run this project\'s verification now with run_command (its tests, typecheck, lint, or build) and report the actual result, exit code included, before finishing. Only if the change genuinely cannot be verified by running a command, or this project has no test or typecheck command, say exactly that instead of implying it was checked.';
            continue;
          }

          if (result.actions.length || result.needsInput || result.readFiles?.length) {
            return withStatedPlacement({
              ...result,
              actions: [...executedActions, ...result.actions],
            }, trimmed);
          }

          // An advice/review FINAL must be backed by at least one successful
          // read this turn — for ANY direct advice request, not only broad
          // reviews. The screenshot failure ("inspect the project and suggest
          // improvements" answered from one skim) used to reach FINAL because
          // this gate fired on broad-review phrasing alone.
          const reviewEvidenceAvailable = hasReadEvidence(toolResults);
          const broadReview = isBroadDirectReviewRequest(trimmed)
            || isContinuationOfDirectWork(trimmed, ctx);
          const planEvidenceAvailable = toolResults.some((tool) => tool.ok && tool.name === 'update_todos');
          const planIndex = toolResults.findIndex((tool) => tool.ok && tool.name === 'update_todos');
          const postPlanReadEvidence = planIndex >= 0
            && toolResults.slice(planIndex + 1).some((tool) => tool.ok && ['read_project', 'read_file', 'glob_files', 'grep_code'].includes(tool.name));

          // The bootstrap snapshot is reconnaissance, not the review itself.
          // Broad reviews must create the complete plan, then execute at least
          // one targeted read from that plan before a final answer is accepted.
          if (
            broadReview
            && ctx?.toolExecutor
            && reviewEvidenceAvailable
            && !planEvidenceAvailable
            && !result.needsInput
            && !reviewPlanRecoveryUsed
          ) {
            reviewPlanRecoveryUsed = true;
            executionNote = 'The project snapshot was reconnaissance only. Before returning findings, create the complete 3-6 item plan with update_todos, then continue executing it. Do not end the turn with only the snapshot summary.';
            continue;
          }
          if (
            broadReview
            && ctx?.toolExecutor
            && planEvidenceAvailable
            && !postPlanReadEvidence
            && !result.needsInput
            && !reviewExecutionRecoveryUsed
          ) {
            reviewExecutionRecoveryUsed = true;
            executionNote = 'The plan is recorded, but it has not been executed beyond the bootstrap snapshot. Use read_file, grep_code, glob_files, or a continued read_project pass for the planned review areas, then return the findings.';
            continue;
          }
          const latestProjectSnapshot = toolResults
            .slice()
            .reverse()
            .find((tool) => tool.name === 'read_project' && tool.ok);
          const incompleteProjectSnapshot = Boolean(
            latestProjectSnapshot
              && /Some files were omitted or truncated for safety\./i.test(latestProjectSnapshot.output),
          );
          if (
            followUpDirectReview
            && ctx?.toolExecutor
            && incompleteProjectSnapshot
            && incompleteReviewRecoveryPages < 8
            && !result.needsInput
          ) {
            incompleteReviewRecoveryPages += 1;
            // The literal next offset, so even a small model has nothing to
            // work out. Without it, models asked the USER to let them continue
            // — a question the app can answer itself.
            const nextOffset = latestProjectSnapshot?.output.match(/Next review offset=(\d+)/)?.[1];
            executionNote = `The project snapshot is incomplete. Do not summarize it as a complete review, and do not ask the user for permission to keep reading: you can read the rest yourself now. Call read_project with {"offset": ${nextOffset ?? 'the next review offset shown in the tool result'}} (repeat until the header stops reporting omitted files), or read_file for the exact files you still need, then return concrete findings in this turn.`;
            continue;
          }
          const latestFileRead = toolResults
            .slice()
            .reverse()
            .find((tool) => tool.name === 'read_file' && tool.ok);
          const incompleteFileRead = Boolean(
            latestFileRead
              && /(?:^|\n)Continue:\s*(?:start_line|start_char)=/i.test(latestFileRead.output),
          );
          if (
            followUpDirectReview
            && ctx?.toolExecutor
            && incompleteFileRead
            && incompleteFileRecoveryPages < 4
            && !result.needsInput
          ) {
            incompleteFileRecoveryPages += 1;
            executionNote = 'A requested file read is incomplete. Do not claim to have read the full file. Continue with read_file using the exact continuation values from the tool result, then return the findings in this turn.';
            continue;
          }
          if (
            followUpDirectReview
            && ctx?.toolExecutor
            && toolResults.length > 0
            && !reviewEvidenceAvailable
            && !result.needsInput
          ) {
            if (!directPolicyRecoveryUsed) {
              directPolicyRecoveryUsed = true;
              executionNote = 'The project inspection has not produced successful evidence yet. Do not claim to have reviewed the project. Use a read-only tool now, or explain that the inspection failed.';
              continue;
            }
            return {
              reply: 'I could not complete the project review because the inspection tools did not return usable evidence. No review findings are being claimed.',
              actions: executedActions,
              viaLLM: true,
              failed: true,
            };
          }

          // A model sometimes acknowledges a follow-up but emits neither an
          // action nor a tool call. Give it one explicit recovery pass so the
          // same turn can turn that promise into real execution.
          const canRecoverPromise = !promiseRecoveryUsed
            && !acknowledgement
            && isPromiseOnlyReply(result.reply)
            && Boolean(ctx?.toolExecutor)
            && (Boolean(ctx?.conversation?.length) || Boolean(ctx?.projectRoot) || ACTION_RE.test(trimmed));
          if (canRecoverPromise) {
            promiseRecoveryUsed = true;
            executionNote = 'The previous response was only a promise and no work has happened yet. Do not acknowledge again. Use an appropriate tool or return an executable action now, then provide the result.';
            continue;
          }

          // The user asked for a picture or clip and the model answered without
          // calling the tool — typically "image generation is unavailable in
          // this session", because the ChatGPT brain's own image tool is off
          // (see chatgpt.rs `run_turn`) and it forgets Spacron's. One pass that
          // names the tool; if the model refuses again, Spacron calls the tool
          // itself with the user's words — a refusal never reaches the user.
          const userRequest = userRequestText(trimmed);
          const mediaKind = mediaGenerationRequest(userRequest);
          const mediaTool = mediaKind === 'video' ? 'generate_video' : 'generate_image';
          if (
            mediaKind
            && ctx?.toolExecutor
            && profile.allowed.has(mediaTool)
            && !result.needsInput
            && !toolResults.some((tool) => tool.name === 'generate_image' || tool.name === 'generate_video')
          ) {
            if (!mediaRecoveryUsed) {
              mediaRecoveryUsed = true;
              executionNote = `The user asked for ${mediaKind === 'video' ? 'a video' : 'an image'} and you have not generated it. ${mediaTool} IS available in this session and is how Spacron makes it — your own built-in media tools are not, so never say generation is unavailable. Call ${mediaTool} now with a prompt written from the user's words, then give a short FINAL description.`;
              continue;
            }
            const refs = attachedImagePaths(trimmed);
            const call: BrainToolCall = {
              id: 'media-fallback',
              name: mediaTool,
              args: mediaKind === 'video'
                ? { prompt: userRequest, ...(refs[0] ? { reference_image: refs[0] } : {}) }
                : { prompt: userRequest, ...(refs.length ? { reference_images: refs } : {}) },
            };
            const execution = await executeBrainToolCalls([call], ctx.toolExecutor);
            toolResults = [...toolResults, ...execution.results];
            toolRounds += 1;
            try { ctx.onToolRound?.(toolResults, toolRounds); } catch { /* observational only */ }
            const made = execution.results[0];
            const noun = mediaKind === 'video' ? 'video' : 'image';
            return withStatedPlacement({
              reply: made?.ok
                ? `Here is the ${noun}.`
                : made?.output.includes('already been shown')
                  ? `The ${noun} could not be generated.`
                  : `The ${noun} could not be generated: ${(made?.output ?? 'no result').replace(/^error:\s*/, '')}`,
              actions: executedActions,
              viaLLM: true,
              failed: !made?.ok,
            }, trimmed);
          }

          // A deferral ("I've inspected…, then I can give you recommendations")
          // claims progress but hands the deliverable to a future exchange.
          // Auto-continue: the turn keeps working until the request is answered
          // or a real blocker requires the user. One dedicated pass; a second
          // deferral falls through to the store's honest-failure conversion.
          if (!deferredRecoveryUsed && !acknowledgement && isDeferredCompletionReply(result.reply) && Boolean(ctx?.toolExecutor) && !result.needsInput) {
            deferredRecoveryUsed = true;
            executionNote = 'You stated partial progress and deferred the rest of the work. The turn does not end while requested work remains. Continue now using the available tools until the request is answered or a real blocker requires the user. Do not ask permission to continue.';
            continue;
          }
          return withStatedPlacement({
            ...result,
            actions: [...executedActions, ...result.actions],
          }, trimmed);
        }
      } catch (error) {
        const msg = String(error ?? '');
        // Billing/quota text takes precedence over 403 because some providers
        // use that status for an exhausted account as well as bad credentials.
        providerFailureReply = providerQuotaFailureReply(provider, model, msg);
        if (providerFailureReply) break;
        providerFailureReply = providerCredentialFailureReply(provider, model, msg);
        if (providerFailureReply) break;
        providerFailureReply = inputLengthFailureReply(provider, model, msg);
        if (providerFailureReply) break;
        providerFailureReply = modelUnavailableFailureReply(provider, model, msg);
        if (providerFailureReply) break;
        // No key / Tauri command missing or denied (older binary) → stop trying
        // the LLM. Match the command-registry wording only: a bare "not found"
        // also matched a provider's "model not found", which dropped a real
        // model error into the keyword heuristic as if no provider existed.
        if (msg.includes('API key is not set') || /\bcommand\b.*\bnot (?:found|allowed)\b/i.test(msg)) {
          break;
        }
        providerFailureReply = msg.includes('protocol: the model did not return a valid final reply')
          ? protocolFailureReply(provider, model, toolResults)
          : isTransientProviderFailure(msg)
          ? networkFailureReply(provider, model, networkAttempts + 1, msg)
          : `The turn stopped with ${provider}/${model}: ${msg}. No further work was claimed. Completed tool work is preserved; inspect its evidence before continuing.`;
        break;
      }
    }
  }

  if (providerFailureReply) {
    return { reply: providerFailureReply, actions: [], viaLLM: false, failed: true };
  }

  // The heuristic route has no model to set `placement`, so the stated-placement
  // pass is the ONLY way "open an agent in the main repo" is honoured without an
  // AI provider configured.
  return withStatedPlacement(heuristicRoute(message, agents, ctx), trimmed);
}
