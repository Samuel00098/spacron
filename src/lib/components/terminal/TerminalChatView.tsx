import { getCurrentWindow } from '@tauri-apps/api/window';
import { dropPositionToCss, isTauriRuntime } from '$lib/utils/tauri';
import { revealAgentChat } from '$lib/services/reveal-agent-chat';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { showToast } from '$lib/stores/notification';
import { getAgentRoster } from '$lib/stores/runs';
import { buildChatContextHandoff } from '$lib/services/chat-context-handoff';
import {
  getAgentDisplayName,
  getSessionAgentStartedAt,
  getSessionRoot,
  sendAgentPromptDirect,
  spawnAgentPreset,
  writeToSession,
} from '$lib/stores/terminal';
import { openFile } from '$lib/stores/editor';
import {
  bindTranscript,
  contextUsageFor,
  effortApplyFor,
  formatTokens,
  modelApplyFor,
  readTerminalTranscript,
  sendMatchKey,
  setTerminalChatView,
  transcriptAgentFor,
  permissionArgs,
  permissionDescription,
  permissionModesFor,
  applyLaunchView,
  typeSlashCommand,
  serialPaneWrite,
  clearsInputWithCtrlU,
  relaunchTerminalAgent,
  applyModelChange,
  applyPermissionChange,
  clearSessionPicks,
  setSessionPicks,
  sessionPermissionMode,
  useSessionPicks,
  PERMISSION_MODE_COPY,
  type ChatPermissionMode,
  type ContextUsage,
  type SessionOptionApply,
  type TerminalChatItem,
} from '$lib/services/terminal-chat';
import { freshLiveAgentProviderModels, loadLiveAgentProviderModels, peekLiveAgentProviderModels } from '$lib/services/live-agent-models';
import type { AgentProviderModel } from '$lib/services/chat-provider-adapters';
import { REASONING_LABELS } from '$lib/services/orchestrator/reasoning-levels';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { useStore } from '$lib/react/useStore';
import { toggleTerminalTranscription, transcriptionActive } from '$lib/services/transcription-hotkey';
import type { WorktreeInfo } from '$lib/services/orchestrator/worktree-manager';
import ImageViewer, { type ViewerImage } from '$lib/components/shared/ImageViewer';
import { getSessionVisuals, requestTerminalInput, terminalInputRequest, terminalChatInputRequest } from '$lib/stores/terminal';
import { ChatVisual, splitReply, visualReplyText } from './ChatVisual';
import { AgentModeChip, AnswerReceipts, GoalPanel, SignInNotice, looksLikeAuthError } from './StructuredChatExtras';
import { readChatDraft, writeChatDraft } from '$lib/services/structured-chat/drafts';
import { parseDroppedPaths } from '$lib/services/structured-chat/attachments';
import { clearStructuredChatUnread, markStructuredChatUnread } from '$lib/services/structured-chat/panes';
import PromptCard from './PromptCard';
import { answerScreenPrompt, dismissScreenPrompt, promptKey, readScreenPrompt, type ScreenPrompt } from '$lib/services/terminal-prompt';
import { codexFooterModel, startCommandCapture } from '$lib/services/terminal-command-output';
import {
  getLiveScreen,
  getSentCommands,
  nextCommandId,
  setLiveScreen,
  subscribeChatCommands,
  updateSentCommands,
  type LiveScreen,
  type SentCommand,
} from '$lib/services/terminal-chat-commands';
import { readTerminalScreen } from '$lib/services/terminal-screen';
import { opencodeFooterModel, opencodeModelFromFooter } from '$lib/services/terminal-chat-inplace';
import { get } from '$lib/stores/storeCompat';
import {
  CHAT_WIDTH_COLUMN,
  CHAT_FONT_SIZE_RANGE,
  chatAppearance,
  chatCiLines,
  chatComposerSpellcheck,
  chatLinkPreviews,
  chatMarkNewMessages,
  chatPullRequests,
  chatQueueFollowUps,
  chatScrollToLatestOnSend,
  chatShowTimestamps,
  chatSuggestedPrompts,
  chatTurnDiffs,
  chatUsageAutoContinue,
} from '$lib/stores/chatViewSettings';
import {
  fileChangesFor,
  forkArgs,
  itemTime,
  latestTodos,
  mentionAt,
  openedPullRequests,
  opensInTerminal,
  closesAfterReading,
  rewindCommand,
  rollupChanges,
  slashCommandsFor,
  slashQuery,
  terminalChatContextText,
  type SlashCommand,
  trailingUsageLimit,
  type FileChange,
} from '$lib/services/terminal-chat-rich';
import { foldUserText } from '$lib/services/chat-fold';
import { enqueue, moveQueued, removeQueued, shiftQueue, updateQueued, useQueue, type QueuedMessage } from '$lib/services/terminal-chat-queue';
import { highlightCodeElement } from '$lib/services/chat-highlight';
import {
  getStructuredChat,
  interruptStructuredChat,
  sendStructuredChat,
  setStructuredChatAccess,
  setStructuredChatEffort,
  setStructuredChatModel,
  subscribeStructuredChat,
} from '$lib/services/structured-chat/registry';
import { useStructuredChatHistory, type StructuredChatAgent } from '$lib/services/structured-chat/panes';
import { answerStructuredApproval, hydrateStructuredHistory, reconnectStructuredSession } from '$lib/services/structured-chat/session-store';
import { runStructuredCommand, STRUCTURED_COMMANDS } from '$lib/services/structured-chat/commands';
import { modelCatalogNote, modelCatalogStatus, selectedModelIssue } from '$lib/services/structured-chat/model-catalog';
import { requestHandoffPicker } from '$lib/services/structured-chat/handoff-coordinator';
import type { StructuredAccess } from '$lib/services/structured-chat/provider';
import {
  CommandOutput,
  CommandRow,
  ComposerMenu,
  FindBar,
  JumpToLatest,
  LinkHoverCard,
  MessageActions,
  MessageRail,
  NewMessagesLine,
  PullRequestCard,
  QueueCards,
  SelectionQuote,
  SuggestedPrompts,
  TodoDock,
  TurnChanges,
  UsageLimitRow,
  type ChatSkillEntry,
  type ComposerSuggestion,
} from './TerminalChatRich';
import { ToolRun } from './TerminalChatToolRun';
import TerminalChatContextMenu, { type ChatMenuAgent, type ChatMenuPoint } from './TerminalChatContextMenu';
import './TerminalChatView.css';
import { openUrlInPreviewPanel } from '$lib/stores/preview';

/** What tool rows deep in the thread need from the view. */
export type RichContextValue = {
  /** A link in a reply was hovered (rect) or left (null). */
  onLinkHover: (url: string, rect: DOMRect | null) => void;
  cwd: string | null;
  parentSessionId: string | null;
  diffs: boolean;
  onOpenFile: (path: string) => void;
  renderNested: (items: TerminalChatItem[]) => React.ReactNode;
};
export const RichContext = createContext<RichContextValue | null>(null);

/** Usage-limit stops already continued, so a reset sends "continue" once. */
const continuedLimits = new Set<string>();

/** A path from a tool call, made absolute against the pane's folder. */
function resolvePath(root: string | null, path: string): string {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path) || !root) return path;
  return `${root.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`;
}

const POLL_MS = 900;
const POLL_HIDDEN_MS = 4000;
const READ_TIMEOUT_MS = 8000;

type PendingSend = { id: number; text: string; key: string; seenBefore: number; at: number; images: string[] };

/** An image waiting in the composer: saved to disk (the CLI gets the path) with a preview to show. */
type Attachment = { id: number; path: string; name: string; preview: string | null; revoke?: string };

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Quote a path only when it has spaces, with forward slashes, as a terminal drop does. */
function terminalPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.includes(' ') ? `"${normalized}"` : normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Paste a path into the pane through xterm (bracketed, no Enter) and wait until it has gone in. */
async function pasteIntoPane(sessionId: number, text: string): Promise<void> {
  requestTerminalInput(sessionId, text);
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const pending = get(terminalInputRequest);
    if (!pending || pending.sessionId !== sessionId) break;
    await sleep(50);
  }
  await sleep(250);
}

/** A send whose row never lands (no transcript found, CLI rejected it) stops counting as busy. */
const PENDING_EXPIRY_MS = 90_000;

/** Keys a TUI prompt (approval, picker, question) answers to, sent straight to the PTY. */
const PROMPT_KEYS: { label: string; title: string; data: string }[] = [
  { label: '1', title: 'Send 1 (usually “Yes”)', data: '1' },
  { label: '2', title: 'Send 2', data: '2' },
  { label: '3', title: 'Send 3', data: '3' },
  { label: '↑', title: 'Arrow up', data: '\x1b[A' },
  { label: '↓', title: 'Arrow down', data: '\x1b[B' },
  { label: 'Enter', title: 'Press Enter', data: '\r' },
  { label: 'Esc', title: 'Press Escape', data: '\x1b' },
];

// Chat-side state that must outlive the view (it unmounts while the pane shows
// its terminal) lives in `terminal-chat-commands.ts`, which also records the
// commands typed straight into the terminal.
function useChatState(sessionId: number): { sent: SentCommand[]; live: LiveScreen | null } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeChatCommands(bump), []);
  return { sent: getSentCommands(sessionId), live: getLiveScreen(sessionId) };
}

/**
 * The transcript as a reader sees it: turns, with each run of tool calls folded
 * into one activity block under the message before it (Orca's fold units:
 * an assistant row absorbs the tool rows that follow it), so calls stay in
 * the order they ran.
 */
type Block =
  | { type: 'user'; item: TerminalChatItem }
  | { type: 'assistant'; item: TerminalChatItem }
  | { type: 'activity'; id: string; items: TerminalChatItem[] }
  | { type: 'notice'; item: TerminalChatItem }
  | { type: 'command'; item: TerminalChatItem }
  | { type: 'output'; item: TerminalChatItem };

function toBlocks(items: TerminalChatItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.kind === 'user') {
      blocks.push({ type: 'user', item });
    } else if (item.kind === 'notice') {
      blocks.push({ type: 'notice', item });
    } else if (item.kind === 'command') {
      blocks.push({ type: 'command', item });
    } else if (item.kind === 'command-output') {
      blocks.push({ type: 'output', item });
    } else if (item.kind === 'assistant') {
      blocks.push({ type: 'assistant', item });
    } else {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'activity') last.items.push(item);
      else blocks.push({ type: 'activity', id: item.id, items: [item] });
    }
  }
  return blocks;
}

function useStructuredRuntime(agent: StructuredChatAgent | null | undefined, sessionId: number) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!agent) return undefined;
    return subscribeStructuredChat(agent, bump);
  }, [agent]);
  return agent ? getStructuredChat(agent, sessionId) : null;
}

/**
 * The rich chat surface shared by terminal-backed and structured sessions.
 * Terminal sessions read/write the CLI transcript and PTY; structured sessions
 * read/write the provider runtime while the same pane and composer remain.
 */
const forkedChatSessions = new Set<number>();

export default function TerminalChatView({
  sessionId,
  agentPreset,
  isRunning: terminalRunning,
  worktree = null,
  structuredAgent = null,
  onOpenTerminal,
}: {
  sessionId: number;
  agentPreset: string;
  isRunning: boolean;
  worktree?: WorktreeInfo | null;
  /** When set, the same chat UI is backed by the structured provider, not the PTY. */
  structuredAgent?: StructuredChatAgent | null;
  onOpenTerminal?: () => void;
}) {
  const structuredMode = Boolean(structuredAgent);
  const structuredState = useStructuredRuntime(structuredAgent, sessionId);
  const structuredHistory = useStructuredChatHistory(sessionId);
  // The journal is the durable copy of the conversation: a view mounting with
  // no history picks up whatever the live provider no longer holds.
  useEffect(() => {
    if (structuredAgent) hydrateStructuredHistory(sessionId);
  }, [structuredAgent, sessionId]);
  // A send that was in flight when the app closed may never have arrived. Once
  // the journal is read back, a message the transcript does not show is offered
  // again instead of vanishing.
  const restoredInflightRef = useRef(false);
  useEffect(() => {
    if (!structuredMode || restoredInflightRef.current) return undefined;
    restoredInflightRef.current = true;
    const key = `spacron_structured_inflight_${sessionId}`;
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { return undefined; }
    if (!raw) return undefined;
    try { localStorage.removeItem(key); } catch { /* nothing saved */ }
    let saved: { text?: string; at?: number } = {};
    try { saved = JSON.parse(raw) as { text?: string; at?: number }; } catch { return undefined; }
    if (!saved.text || !saved.at || Date.now() - saved.at < 1500) return undefined;
    const text = saved.text;
    const timer = setTimeout(() => {
      const shown = [...structuredHistory, ...(structuredState?.items ?? [])]
        .some((item) => item.kind === 'user' && item.text.trim() === text.trim());
      if (!shown) setUncertainSend(text);
    }, 800);
    return () => clearTimeout(timer);
  }, [structuredMode, sessionId]);
  const agent = transcriptAgentFor(agentPreset) ?? (structuredAgent as NonNullable<ReturnType<typeof transcriptAgentFor>> | null);
  const agentLabel = getAgentDisplayName(agentPreset) ?? agentPreset;
  const isRunning = structuredMode
    ? structuredState?.status === 'ready' || structuredState?.status === 'working'
    : terminalRunning;
  const textareaRefEarly = useRef<HTMLTextAreaElement | null>(null);
  const [items, setItems] = useState<TerminalChatItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnectChat = () => {
    setError(null);
    void reconnectStructuredSession(sessionId).then((ok) => {
      if (ok) return;
      const detail = structuredAgent ? getStructuredChat(structuredAgent, sessionId)?.error : null;
      setError(detail ?? `Couldn't reconnect ${agentLabel}. The conversation so far is kept above.`);
    });
  };

  const [transcriptBusy, setTranscriptBusy] = useState<boolean | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [draft, setDraft] = useState('');
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  // The unsent message (and its attachments) stays with the pane across a
  // reload, as Orca keeps it across a reconnect.
  const restoredDraftRef = useRef(false);
  useEffect(() => {
    if (restoredDraftRef.current) return;
    restoredDraftRef.current = true;
    const saved = readChatDraft(sessionId);
    if (!saved) return;
    if (saved.text) setDraft(saved.text);
    if (!saved.attachments.length) return;
    const restored = saved.attachments.map((attachment) => ({
      id: ++attachmentIdRef.current,
      path: attachment.path,
      name: attachment.name,
      preview: null as string | null,
    }));
    setAttachments(restored);
    for (const attachment of restored) {
      if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.path)) continue;
      void invoke<string>('chat_image_preview', { path: attachment.path })
        .then((preview) => setAttachments((list) => list.map((a) => (a.id === attachment.id ? { ...a, preview } : a))))
        .catch(() => undefined);
    }
  }, [sessionId]);

  const appearance = useStore(chatAppearance);
  const spellcheck = useStore(chatComposerSpellcheck);
  const [sending, setSending] = useState(false);
  // A structured send the app was still making when it closed, if it never arrived.
  const [uncertainSend, setUncertainSend] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  // A question or approval the CLI is waiting on, read from its screen.
  const [screenPrompt, setScreenPrompt] = useState<ScreenPrompt | null>(null);
  const [answering, setAnswering] = useState<number | null>(null);
  const promptKeyRef = useRef<string | null>(null);
  const attachmentIdRef = useRef(0);
  // Save the draft (and its attachment paths) with the pane, debounced.
  useEffect(() => {
    const timer = setTimeout(() => writeChatDraft(sessionId, {
      text: draft,
      attachments: attachments.map((a) => ({ path: a.path, name: a.name })),
    }), 300);
    return () => clearTimeout(timer);
  }, [draft, attachments, sessionId]);
  const picks = useSessionPicks(sessionId);
  const [relaunching, setRelaunching] = useState(false);
  // Why a model/effort/permission change didn't apply, shown at the pill (Orca's
  // apply-error text) rather than as the conversation's error banner.
  const [settingError, setSettingError] = useState<string | null>(null);
  useEffect(() => {
    if (!settingError) return undefined;
    const timer = setTimeout(() => setSettingError(null), 8000);
    return () => clearTimeout(timer);
  }, [settingError]);
  const dictationOn = useStore(transcriptionActive);
  // Dictation is app-wide; only show it as recording here when it aims at this composer.
  const dictating = dictationOn && document.activeElement === textareaRefEarly.current;
  const root = getSessionRoot(sessionId);
  // What the transcript says the session runs on, and what was picked here
  // since (shown until a later turn records it).
  const [reported, setReported] = useState<{
    model: string | null; effort: string | null; used: number | null; window: number | null; permission: ChatPermissionMode | null;
  }>({ model: null, effort: null, used: null, window: null, permission: null });
  const [models, setModels] = useState<AgentProviderModel[]>(() => peekLiveAgentProviderModels(agentPreset) ?? []);
  const modelsRef = useRef(models);
  modelsRef.current = models;
  // Settings > Chat
  const queueFollowUps = useStore(chatQueueFollowUps);
  const markNew = useStore(chatMarkNewMessages);
  const showTimestamps = useStore(chatShowTimestamps);
  const linkPreviews = useStore(chatLinkPreviews);
  const turnDiffs = useStore(chatTurnDiffs);
  const pullRequests = useStore(chatPullRequests);
  const ciLines = useStore(chatCiLines);
  const autoContinue = useStore(chatUsageAutoContinue);
  const suggestedPrompts = useStore(chatSuggestedPrompts);
  const queue = useQueue(sessionId);
  const [findOpen, setFindOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ChatMenuPoint | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  // The first block that arrived while the reader was away ("New" line).
  const [newMarker, setNewMarker] = useState<string | null>(null);
  const [boundSession, setBoundSession] = useState<string | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [threadEl, setThreadEl] = useState<HTMLDivElement | null>(null);
  // Composer `/` and `@` menus.
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  // A command just run in the chat; if nothing lands in the conversation for a
  // few seconds, its answer is on the terminal's screen and the chat says so.
  const [commandWatch, setCommandWatch] = useState<{ command: string; seen: number; at: number } | null>(null);
  const [commandInTerminal, setCommandInTerminal] = useState<string | null>(null);
  // Commands sent from here, shown as rows until the transcript records them
  // (most TUIs never write a command to their transcript, so most stay).
  const { sent: sentCommands, live: liveScreen } = useChatState(sessionId);
  const setSentCommands = (fn: (list: SentCommand[]) => SentCommand[]) => updateSentCommands(sessionId, fn);
  // Codex's footer names the live model and effort; the transcript only does once a turn runs.
  const [screenModel, setScreenModel] = useState<{ model: string; effort: string | null } | null>(null);
  const itemsRef = useRef<TerminalChatItem[]>([]);
  // Settings > Chat > Link previews: the link the pointer rests on.
  const [hoverLink, setHoverLink] = useState<{ url: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const boundRef = useRef<string | null>(null);
  const revisionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const textareaRef = textareaRefEarly;
  const pendingIdRef = useRef(0);
  // The started-at time is fixed for this agent run; read it once per mount.
  const sinceMs = useMemo(() => getSessionAgentStartedAt(sessionId) ?? Date.now(), [sessionId, agentPreset]);

  // Structured providers already own the conversation state. Feed that state
  // into the same item/reporting slots used by the terminal-backed view so the
  // rest of this component remains one UI, including its rich rows, settings,
  // slash menu and composer behavior.
  useEffect(() => {
    if (!structuredMode) return;
    const items = [...structuredHistory, ...(structuredState?.items ?? [])];
    setItems(items);
    setLoaded(structuredState?.status !== 'starting');
    setTranscriptBusy(structuredState?.status === 'working');
    setError(structuredState?.error ?? null);
    if (structuredState?.threadId) {
      boundRef.current = structuredState.threadId;
      setBoundSession(structuredState.threadId);
    }
    const permission: ChatPermissionMode | null = structuredState?.access === 'ask'
      ? 'ask'
      : structuredState?.access === 'auto'
        ? 'auto'
        : structuredState?.access === 'full-access'
          ? 'full-access'
          : null;
    setReported({
      model: structuredState?.model ?? null,
      effort: structuredState?.effort ?? null,
      used: structuredState?.contextUsed ?? null,
      window: structuredState?.contextWindow ?? null,
      permission,
    });
  }, [structuredMode, structuredHistory, structuredState]);

  // Poll the transcript. The backend answers "unchanged" cheaply from file size
  // and mtime, so a steady poll costs a stat, not a parse.
  useEffect(() => {
    if (!agent || structuredMode) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const cwd = getSessionRoot(sessionId);
      if (!cwd) {
        setError('This terminal has no working folder, so its conversation cannot be found.');
        setLoaded(true);
      } else {
        try {
          // Bounded: a call that never settles must not stop the polling for good.
          const result = await Promise.race([
            readTerminalTranscript({
              sessionId,
              agent,
              cwd,
              sinceMs,
              boundSessionId: boundRef.current,
              knownRevision: revisionRef.current,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Reading the conversation timed out.')), READ_TIMEOUT_MS)),
          ]);
          if (cancelled) return;
          setError(null);
          if (result.sessionId !== boundRef.current) {
            boundRef.current = result.sessionId;
            bindTranscript(sessionId, result.sessionId);
            setBoundSession(result.sessionId);
          }
          revisionRef.current = result.revision;
          if (!result.unchanged) {
            setItems(result.messages);
            setTranscriptBusy(result.busy);
            setTruncated(result.truncated);
            setReported({
              model: result.model,
              effort: result.effort,
              used: result.contextUsed,
              window: result.contextWindow,
              permission: isChatPermission(result.permission) ? result.permission : null,
            });
          }
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoaded(true);
      }
      // The footer is the live session; Codex and OpenCode both draw one.
      const footer = agent === 'codex'
        ? codexFooterModel(readTerminalScreen(sessionId, { maxLines: 12 }))
        : agent === 'opencode'
          ? (() => {
            const shown = opencodeFooterModel(readTerminalScreen(sessionId, { maxLines: 12 }) ?? '');
            const id = shown ? opencodeModelFromFooter(shown, modelsRef.current.map((m) => m.id)) : null;
            return id ? { model: id, effort: null } : null;
          })()
          : null;
      if (footer) {
        setScreenModel((prev) => (prev && prev.model === footer.model && prev.effort === footer.effort ? prev : footer));
      }
      setPending((list) => (list.some((p) => Date.now() - p.at > PENDING_EXPIRY_MS)
        ? list.filter((p) => Date.now() - p.at <= PENDING_EXPIRY_MS)
        : list));
      if (!cancelled) timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agent, sessionId, sinceMs, structuredMode]);

  // The CLI's own model list (the spawn picker's catalogue), for the model menu.
  useEffect(() => {
    let cancelled = false;
    if (structuredMode) {
      // Only a live, successful catalog is authoritative. When the request
      // failed, the last good list is shown (and labelled) instead of an
      // empty one that would look like "no models".
      const status = structuredAgent ? modelCatalogStatus(structuredAgent, structuredState) : null;
      const source = status?.kind === 'loaded' || status?.kind === 'cached' ? status.models : [];
      setModels(source.map((model) => ({
        id: model.id,
        label: model.label,
        description: model.description ?? undefined,
        reasoningEfforts: model.efforts as ChatReasoningEffort[],
        defaultReasoningEffort: model.defaultEffort as ChatReasoningEffort | undefined,
        isDefault: model.isDefault,
      })));
      return () => { cancelled = true; };
    }
    // A pane can switch CLIs under the same view; never offer the last CLI's
    // models (picking a Claude model in OpenCode then drove Claude's list).
    setModels(peekLiveAgentProviderModels(agentPreset) ?? []);
    loadLiveAgentProviderModels(agentPreset)
      .then((list) => { if (!cancelled && list.length) setModels(list); })
      .catch(() => {});
    // Then what the CLI offers now, replacing a list saved from an earlier run.
    freshLiveAgentProviderModels(agentPreset)
      .then((list) => { if (!cancelled && list.length) setModels(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentPreset, structuredMode, structuredAgent, structuredState?.models, structuredState?.status]);

  // What the session runs on now: Codex's footer when it shows one (it is
  // the live session, set by a launch `-m` or a /model pick), else the transcript.
  const liveModel = structuredMode ? structuredState?.model ?? reported.model : screenModel?.model ?? reported.model;
  const liveEffort = structuredMode
    ? structuredState?.effort ?? reported.effort
    : screenModel ? screenModel.effort ?? reported.effort : reported.effort;

  // A pick stays shown until the CLI reports that value.
  useEffect(() => {
    const confirmed: ('model' | 'effort' | 'permission')[] = [];
    if (picks.model && liveModel && sameModel(liveModel, picks.model)) confirmed.push('model');
    if (picks.effort && liveEffort === picks.effort) confirmed.push('effort');
    if (picks.permission && reported.permission === picks.permission) confirmed.push('permission');
    if (confirmed.length) clearSessionPicks(sessionId, confirmed);
  }, [liveModel, liveEffort, reported.permission, picks.model, picks.effort, picks.permission, sessionId]);

  // Watch the terminal for a question or approval prompt while the chat is open.
  useEffect(() => {
    if (structuredMode || !isRunning) {
      setScreenPrompt(null);
      return undefined;
    }
    const check = () => {
      const prompt = readScreenPrompt(sessionId);
      const key = prompt ? promptKey(prompt) : null;
      if (key !== promptKeyRef.current) {
        promptKeyRef.current = key;
        setScreenPrompt(prompt);
        setAnswering(null);
      }
    };
    check();
    const timer = setInterval(check, 450);
    return () => clearInterval(timer);
  }, [sessionId, isRunning, structuredMode]);

  async function answerPrompt(index: number, text?: string) {
    if (answering !== null) return;
    setAnswering(index);
    const problem = await answerScreenPrompt(sessionId, index, text);
    revisionRef.current = null;
    if (problem) {
      setError(problem);
      setAnswering(null);
    }
    // Success: the prompt leaves the screen and the watcher clears the card.
    setTimeout(() => setAnswering((current) => (current === index ? null : current)), 4000);
  }

  // The pane closed or the agent changed: release the transcript binding.
  useEffect(() => () => {
    if (!structuredMode) bindTranscript(sessionId, null);
  }, [sessionId, structuredMode]);

  // Entering chat moves focus off the (now hidden) terminal onto the composer,
  // so typing never lands in the TUI behind it.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const userKeys = useMemo(() => items.filter((i) => i.kind === 'user').map((i) => sendMatchKey(i.text)), [items]);

  // A pending send disappears once its own row lands in the transcript.
  useEffect(() => {
    if (!pending.length) return;
    setPending((list) =>
      list.filter((p) => userKeys.filter((k) => k === p.key || k.startsWith(p.key.slice(0, 60))).length <= p.seenBefore),
    );
  }, [userKeys, pending.length]);

  // Sent commands sit where they were sent, between the transcript's rows.
  const blocks = useMemo(() => {
    if (!sentCommands.length) return toBlocks(items);
    const merged = [...items];
    // A command typed in the terminal is placed by time: after the last
    // transcript row written before it.
    const positioned = sentCommands.map((c) => {
      if (c.at >= 0) return c;
      let at = 0;
      items.forEach((item, index) => {
        const t = item.time ? Date.parse(item.time) : NaN;
        if (Number.isNaN(t) || t <= c.sentAt) at = index + 1;
      });
      return { ...c, at };
    });
    positioned.sort((a, b) => b.at - a.at || b.id - a.id).forEach((c) => {
      const rows: TerminalChatItem[] = [{ id: `sent-command-${c.id}`, kind: 'command', text: c.text }];
      if (c.output) rows.push({ id: `sent-command-${c.id}-output`, kind: 'command-output', text: c.output });
      merged.splice(Math.min(c.at, merged.length), 0, ...rows);
    });
    return toBlocks(merged);
  }, [items, sentCommands]);
  itemsRef.current = items;

  // A sent command's row gives way once the transcript records the same command.
  useEffect(() => {
    if (!sentCommands.length) return;
    setSentCommands((list) => {
      const next = list.filter((c) => items.filter((i) => i.kind === 'command' && i.text.trim() === c.text).length <= c.seen);
      return next.length === list.length ? list : next;
    });
  }, [items, sentCommands.length]);

  useEffect(() => {
    if (!commandWatch) return undefined;
    if (items.length > commandWatch.seen) {
      setCommandWatch(null);
      setCommandInTerminal(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setCommandInTerminal(commandWatch.command);
      setCommandWatch(null);
    }, Math.max(0, 5000 - (Date.now() - commandWatch.at)));
    return () => clearTimeout(timer);
  }, [commandWatch, items.length]);
  // Busy comes from the conversation itself (a turn started and has not ended)
  // and from sends not yet in it, never from terminal output: TUIs repaint on
  // focus, resize and clicks, and the pane's output-based `isExecuting` blinked
  // "Working" on with every one of them. Orca reads the same turn records.
  const busy = isRunning && (structuredMode ? structuredState?.status === 'working' : transcriptBusy === true || pending.length > 0);
  // Up/Down in an empty draft walks back through the prompts this chat sent.
  const prompts = useMemo(() => items.filter((item) => item.kind === 'user').map((item) => item.text).filter(Boolean), [items]);
  // A turn that finishes while the window is hidden leaves a dot on the chat
  // tab; focusing the composer clears it.
  const wasBusyRef = useRef(false);
  useEffect(() => {
    const was = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (structuredMode && was && !busy && typeof document !== 'undefined' && document.hidden) {
      markStructuredChatUnread(sessionId);
    }
  }, [busy, structuredMode, sessionId]);

  // Follow the conversation while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, busy, queue.length]);

  useLayoutEffect(() => {
    if (!scrollEl || !threadEl) return;
    const resize = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    resize.observe(scrollEl);
    resize.observe(threadEl);
    return () => resize.disconnect();
  }, [scrollEl, threadEl]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnread(0);
  }, []);

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    setAtBottom(true);
    setUnread(0);
  }

  // Blocks that arrive while the reader is scrolled up or the window is hidden
  // count as unread, and the first of them gets the "New" line above it.
  const seenBlocksRef = useRef<number | null>(null);
  useEffect(() => {
    const seen = seenBlocksRef.current;
    seenBlocksRef.current = blocks.length;
    if (seen == null || blocks.length <= seen) return;
    const away = !stickToBottomRef.current || document.hidden;
    if (!away) return;
    const fresh = blocks.slice(seen).filter((b) => b.type !== 'user');
    if (!fresh.length) return;
    setUnread((n) => n + fresh.length);
    if (markNew) setNewMarker((current) => current ?? blockKey(fresh[0]));
  }, [blocks, markNew]);

  /** Answer a structured approval, optionally with one of the agent's own options. */
  function answerStructuredCard(
    approval: { requestId: string | number },
    decision: 'accept' | 'acceptForSession' | 'decline',
    optionId?: string,
  ) {
    void answerStructuredApproval(sessionId, approval.requestId, decision, optionId);
  }

  // A numbered question card is answerable from the keyboard: 1…9 picks that
  // option, unless the user is typing in a field.
  useEffect(() => {
    if (!structuredMode) return undefined;
    const el = viewRef.current;
    if (!el) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const card = structuredState?.approvals.find((approval) => approval.options?.length);
      if (!card?.options) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= card.options.length) return;
      event.preventDefault();
      event.stopPropagation();
      const option = card.options[index];
      answerStructuredCard(card, /reject|cancel|deny|declin/i.test(`${option.kind ?? ''} ${option.id}`) ? 'decline' : 'accept', option.id);
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [structuredMode, structuredState?.approvals]);

  /** Put text and images into the CLI's prompt and press Enter. */
  async function deliver(text: string, images: { path: string; preview: string | null; revoke?: string }[]) {
    const key = sendMatchKey(text);
    const seenBefore = userKeys.filter((k) => k === key || k.startsWith(key.slice(0, 60))).length;
    const id = ++pendingIdRef.current;
    setPending((list) => [...list, { id, text, key, seenBefore, at: Date.now(), images: images.map((a) => a.preview).filter((u): u is string => Boolean(u)) }]);
    // Settings > Chat > "Scroll to latest when sending"; off keeps the reader's place.
    if (get(chatScrollToLatestOnSend)) stickToBottomRef.current = true;
    setNewMarker(null);
    setSending(true);
    try {
      if (structuredMode && structuredAgent) {
        const inflightKey = `spacron_structured_inflight_${sessionId}`;
        try { localStorage.setItem(inflightKey, JSON.stringify({ text, at: Date.now() })); } catch { /* nothing to remember */ }
        try {
          await sendStructuredChat(structuredAgent, sessionId, text, images.map((image) => image.path));
        } finally {
          try { localStorage.removeItem(inflightKey); } catch { /* nothing saved */ }
        }
        for (const image of images) if (image.revoke) URL.revokeObjectURL(image.revoke);
        return;
      }
      // Images first, each pasted as a path the way a terminal drop delivers
      // it, so the CLI attaches it ("[Image #1]") to the prompt that follows.
      for (const image of images) await pasteIntoPane(sessionId, `${terminalPath(image.path)} `);
      for (const image of images) if (image.revoke) URL.revokeObjectURL(image.revoke);
      const ok = await serialPaneWrite(sessionId, async () => {
        if (text) return sendAgentPromptDirect(sessionId, text);
        writeToSession(sessionId, '\r');
        return true;
      });
      revisionRef.current = null;
      if (!ok) {
        // Not re-filled into the composer: the text may still have reached the
        // CLI, and a blind retry would send it twice.
        setError(`${agentLabel} did not confirm the message. Check the terminal view before sending it again.`);
        setPending((list) => list.filter((p) => p.id !== id));
      }
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  /**
   * A slash command goes in as keystrokes (a paste would land as prompt text)
   * and the chat always stays open: the command shows as a row in the
   * conversation, and whatever the CLI writes back shows under it. A command
   * that opens a TUI screen (a picker, a dialog) never yanks the pane to its
   * terminal; the chat says where the screen is, with a button to open it.
   */
  async function runSlashCommand(command: string) {
    if (!agent) return;
    setSending(true);
    try {
      const text = command.trim();
      if (structuredMode && structuredAgent) {
        // Commands that map to a session operation (model, clear, rename,
        // resume…) run in Spacron against the provider; the rest go to the
        // agent through its native prompt channel. No terminal keystrokes.
        const lastUserMessage = [...itemsRef.current].reverse().find((i) => i.kind === 'user')?.text ?? null;
        const result = await runStructuredCommand(structuredAgent, sessionId, text, { lastUserMessage });
        if (!result.handled) {
          await sendStructuredChat(structuredAgent, sessionId, text);
          return;
        }
        if (result.action === 'continue-in-terminal') onOpenTerminal?.();
        if (result.action === 'handoff') requestHandoffPicker(sessionId);
        const output = result.error ?? result.output;
        if (output) {
          const id = nextCommandId();
          stickToBottomRef.current = true;
          setSentCommands((list) => [...list, { id, text, seen: Number.MAX_SAFE_INTEGER, at: itemsRef.current.length, sentAt: Date.now(), output }]);
        }
        return;
      }
      const name = text.split(/\s+/)[0];
      const seen = itemsRef.current.filter((i) => i.kind === 'command' && i.text.trim() === text).length;
      const id = nextCommandId();
      const itemsAtSend = itemsRef.current.length;
      setSentCommands((list) => [...list, { id, text, seen, at: itemsAtSend, sentAt: Date.now() }]);
      stickToBottomRef.current = true;
      setCommandWatch(null);
      setCommandInTerminal(null);
      // Most CLIs print a command's reply only on their screen; read it from
      // there so it shows in the chat for every agent, not just Claude Code.
      // Marked and typed in the pane's queue, so nothing else lands in between.
      const capture = await serialPaneWrite(sessionId, async () => {
        const mark = startCommandCapture(sessionId, text);
        await typeSlashCommand(sessionId, text, { clearInput: clearsInputWithCtrlU(agent) });
        return mark;
      });
      revisionRef.current = null;
      const screen = agent;
      // A screen that takes keys (a picker, a dialog) opens right here in the
      // chat, live, with keys and an input box, until it closes.
      if (opensInTerminal(screen, text)) {
        setLiveScreen(sessionId, { command: text, sentId: id, capture });
        return;
      }
      void capture.finish().then((output) => {
        // Claude Code writes some replies to its transcript; never show one twice.
        const fromTranscript = (screen === 'claude' || screen === 'openclaude') && itemsRef.current.length > itemsAtSend;
        if (output && !fromTranscript) {
          stickToBottomRef.current = true;
          setSentCommands((list) => list.map((c) => (c.id === id ? { ...c, output } : c)));
        }
        // An information screen has been read into the chat: close it, so the
        // CLI is back at its prompt for the next message.
        if (output && closesAfterReading(screen, text)) {
          writeToSession(sessionId, '\x1b');
          return;
        }
        // A screen the chat cannot drive (a picker, a dialog) stays in the
        // terminal; say so rather than switching the pane away.
        if (opensInTerminal(screen, text) || (!output && !fromTranscript)) setCommandInTerminal(name);
      });
    } finally {
      setSending(false);
    }
  }

  async function dispatchQueued(message: QueuedMessage) {
    if (message.text.startsWith('/') && !message.images.length) await runSlashCommand(message.text);
    else await deliver(message.text, message.images);
  }

  // Latest functions for timers that outlive a render.
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  const dispatchRef = useRef(dispatchQueued);
  dispatchRef.current = dispatchQueued;

  async function send(options: { now?: boolean } = {}) {
    const text = draft.trim();
    const images = attachments;
    if ((!text && !images.length) || sending || !isRunning) return;
    const isCommand = Boolean(agent) && text.startsWith('/') && !images.length;
    // Settings > Chat > "Queue follow-ups": while a turn runs, the message
    // waits here. Ctrl+Enter ("send now") types it into the running turn.
    if (busy && !options.now && queueFollowUps) {
      enqueue(sessionId, text, images.map((a) => ({ path: a.path, preview: a.preview })));
      setDraft('');
      setAttachments([]);
      if (get(chatScrollToLatestOnSend)) stickToBottomRef.current = true;
      return;
    }
    setDraft('');
    setAttachments([]);
    if (isCommand) await runSlashCommand(text);
    else await deliver(text, images);
  }

  // A structured turn that failed holds the queue (Orca pauses it too): firing
  // the next message straight into the same failure helps nobody. Resume lifts
  // the hold for that error; a different error pauses again.
  const turnError = structuredMode ? structuredState?.error ?? null : null;
  const [resumedError, setResumedError] = useState<string | null>(null);
  const queuePaused = Boolean(turnError) && turnError !== resumedError && queue.length > 0;

  // Send the next queued message once the turn ends and nothing waits on the user.
  useEffect(() => {
    if (queuePaused || busy || sending || !isRunning || screenPrompt || liveScreen || relaunching || !queue.length) return undefined;
    const timer = setTimeout(() => {
      const next = shiftQueue(sessionId);
      if (next) void dispatchRef.current(next);
    }, 700);
    return () => clearTimeout(timer);
  }, [queuePaused, busy, sending, isRunning, screenPrompt, liveScreen, relaunching, queue.length, sessionId]);

  function sendQueuedNow(id: number) {
    const message = removeQueued(sessionId, id);
    if (message) void dispatchQueued(message);
  }

  // Settings > Chat > Usage limits: continue once the limit has reset.
  const usageLimit = useMemo(() => (isRunning && !busy ? trailingUsageLimit(items) : null), [items, busy, isRunning]);
  useEffect(() => {
    if (!usageLimit || !autoContinue || !usageLimit.resetsAt || continuedLimits.has(usageLimit.id)) return undefined;
    const wait = Math.max(0, usageLimit.resetsAt + 60_000 - Date.now());
    const timer = setTimeout(() => {
      continuedLimits.add(usageLimit.id);
      void deliverRef.current('Continue where you left off.', []);
    }, Math.min(wait, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [usageLimit?.id, usageLimit?.resetsAt, autoContinue]);

  function stop() {
    if (structuredMode && structuredAgent) void interruptStructuredChat(structuredAgent, sessionId);
    else writeToSession(sessionId, '\x1b');
  }

  function openTerminalView() {
    if (structuredMode) onOpenTerminal?.();
    else setTerminalChatView(sessionId, false);
  }

  const otherAgents = useMemo(
    () => getAgentRoster().filter((candidate) => candidate.command !== agentPreset),
    [agentPreset],
  );

  function openChatContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('textarea, input, [contenteditable="true"]')) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }

  async function handOffToAgent(target: ChatMenuAgent) {
    setContextMenu(null);
    const messages = itemsRef.current
      .filter((item) => item.kind !== 'reasoning')
      .map((item) => {
        const role = item.kind === 'user' || item.kind === 'command' ? 'user' : 'assistant';
        const text = item.kind === 'tool'
          ? `${item.toolName ? `${item.toolName}: ` : ''}${item.text}${item.toolOutput ? `\nTool output:\n${item.toolOutput}` : ''}`
          : item.text;
        const images = item.images?.length ? `\n[${item.images.length} image attachment${item.images.length === 1 ? '' : 's'}]` : '';
        return { id: item.id, role, text: `${text}${images}` };
      });
    const handoff = buildChatContextHandoff(
      messages,
      agentLabel,
      target.name,
      'Continue the current task from the latest state in this workspace. Inspect the repository before changing anything.',
    );
    try {
      const nextSession = await spawnAgentPreset(target.command, root ?? undefined, { activate: true });
      if (nextSession == null) {
        showToast(`Couldn't start ${target.name}.`, 'error', 6000);
        return;
      }
      applyLaunchView(nextSession, target.command, 'chat');
      await revealAgentChat(nextSession);
      const sent = await sendAgentPromptDirect(nextSession, handoff.prompt);
      if (!sent) {
        showToast(`${target.name} opened, but the handoff prompt was not sent. Copy Context is available from this menu.`, 'error', 7000);
        return;
      }
      showToast(`Conversation handed off to ${target.name}.`, 'info', 5000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : `Couldn't hand off to ${target.name}.`, 'error', 7000);
    }
  }

  async function copyChatContext() {
    setContextMenu(null);
    try {
      await copyTextToClipboard(terminalChatContextText(itemsRef.current, agentLabel, root));
      showToast('Chat context copied to clipboard.', 'info', 4000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not copy chat context.', 'error', 6000);
    }
  }

  function runContextCommand(command: SlashCommand) {
    setContextMenu(null);
    void revealAgentChat(sessionId).then(() => {
      if (busy && queueFollowUps) enqueue(sessionId, command.name);
      else if (!busy) void runSlashCommand(command.name);
    });
  }

  // ── Composer menus: `/` commands and skills, `$` skills (Codex), `@` files ──
  const slash = agent ? slashQuery(draft) : null;
  // Codex invokes a skill by mentioning it as `$name` anywhere in the prompt.
  const dollar = !slash && agent === 'codex' ? tokenAt(draft, caret, '$') : null;
  const mention = !slash && !dollar && root ? mentionAt(draft, caret) : null;
  const menuKey = slash != null ? `/${slash}` : dollar ? `$${dollar.start}:${dollar.query}` : mention ? `@${mention.start}:${mention.query}` : null;

  // The CLI's skills and custom commands, re-read whenever the menu opens so a
  // skill added while the chat is open shows up.
  const [skills, setSkills] = useState<ChatSkillEntry[]>(() => (agent && root ? peekSkills(agent, root) : []));
  const skillMenuOpen = slash != null || dollar != null;
  useEffect(() => {
    if (!agent || !root || (!skillMenuOpen && skills.length)) return undefined;
    let cancelled = false;
    void loadSkills(agent, root).then((list) => { if (!cancelled) setSkills(list); });
    return () => { cancelled = true; };
  }, [agent, root, skillMenuOpen]);

  const commandMatches = useMemo((): ComposerSuggestion[] => {
    if (!agent) return [];
    if (dollar) {
      return rankByName(skills.filter((sk) => sk.name.startsWith('$')), dollar.query, (sk) => sk.name.slice(1))
        .map((skill) => ({ kind: 'skill' as const, skill }));
    }
    if (slash == null) return [];
    // A structured chat runs these as session operations (see
    // structured-chat/commands.ts); they replace the CLI's rows of the same name.
    const curated = slashCommandsFor(agent);
    const liveBuiltins = skills.filter((sk) => sk.kind === 'builtin');
    // Claude's own list names every built-in it has right now; the curated
    // rows add the "opens in terminal" knowledge and fill missing prose.
    const cliRows: SlashCommand[] = liveBuiltins.length
      ? liveBuiltins.map((sk) => {
        const known = curated.find((c) => c.name === sk.name);
        return { ...known, name: sk.name, description: sk.description || known?.description || '' };
      })
      : curated;
    // A structured chat runs these as session operations (see
    // structured-chat/commands.ts); they replace the CLI's rows of the same
    // name, and rows that only open a TUI screen have no place without one.
    const commandRows: SlashCommand[] = structuredMode
      ? [...STRUCTURED_COMMANDS, ...cliRows.filter((c) => !c.opensInTerminal && !STRUCTURED_COMMANDS.some((s) => s.name === c.name))]
      : cliRows;
    const builtins = rankByName(commandRows, slash, (c) => c.name.slice(1))
      .map((command) => ({ kind: 'command' as const, command }));
    const custom = rankByName(skills.filter((sk) => sk.kind !== 'builtin'), slash, (sk) => sk.name.replace(/^[/$]/, ''));
    return [
      ...builtins,
      ...custom.filter((sk) => sk.kind === 'skill').map((skill) => ({ kind: 'skill' as const, skill })),
      ...custom.filter((sk) => sk.kind === 'command').map((skill) => ({ kind: 'skill' as const, skill })),
    ];
  }, [slash, dollar?.query, agent, skills, structuredMode]);

  useEffect(() => {
    if (!mention || !root) {
      setFileMatches([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<string[]>('chat_list_files', { root, query: mention.query, limit: 20 })
        .then((list) => { if (!cancelled) setFileMatches(list); })
        .catch(() => { if (!cancelled) setFileMatches([]); });
    }, 110);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention?.query, mention?.start, root]);

  const suggestions: ComposerSuggestion[] = menuKey && menuKey !== menuDismissed
    ? slash != null || dollar
      ? commandMatches.slice(0, 80)
      : fileMatches.map((path) => ({ kind: 'file' as const, path }))
    : [];
  useEffect(() => setMenuIndex(0), [menuKey]);
  const selectedSuggestion = suggestions[Math.min(menuIndex, suggestions.length - 1)];
  const selectedName = selectedSuggestion?.kind === 'command' ? selectedSuggestion.command.name
    : selectedSuggestion?.kind === 'skill' ? selectedSuggestion.skill.name : null;

  /** Replace the token being typed (from `start` to the caret) with `insert`. */
  function replaceToken(start: number, insert: string) {
    const next = draft.slice(0, start) + insert + draft.slice(caret);
    setDraft(next);
    const at = start + insert.length;
    setCaret(at);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(at, at));
  }

  function pickSuggestion(item: ComposerSuggestion) {
    if (item.kind === 'command') {
      setDraft(`${item.command.name} `);
      setCaret(item.command.name.length + 1);
    } else if (item.kind === 'skill') {
      if (dollar) replaceToken(dollar.start, item.skill.insert);
      else {
        setDraft(item.skill.insert);
        setCaret(item.skill.insert.length);
      }
    } else if (mention) {
      replaceToken(mention.start, `@${/\s/.test(item.path) ? `"${item.path}"` : item.path} `);
    }
    textareaRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    event.stopPropagation();
    if (suggestions.length && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((i) => (i + delta + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && selectedName !== draft.trim())) {
        event.preventDefault();
        pickSuggestion(suggestions[Math.min(menuIndex, suggestions.length - 1)]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuDismissed(menuKey);
        return;
      }
    }
    // Up/Down in an empty draft walks back through the prompts this chat sent.
    if (event.key === 'ArrowUp' && (historyAt != null || (!draft.trim() && !attachments.length)) && prompts.length) {
      event.preventDefault();
      const next = historyAt == null ? prompts.length - 1 : Math.max(0, historyAt - 1);
      setHistoryAt(next);
      setDraft(prompts[next]);
      setCaret(prompts[next].length);
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(prompts[next].length, prompts[next].length));
      return;
    }
    if (event.key === 'ArrowDown' && historyAt != null) {
      event.preventDefault();
      const next = historyAt + 1;
      if (next >= prompts.length) {
        setHistoryAt(null);
        setDraft('');
        setCaret(0);
      } else {
        setHistoryAt(next);
        setDraft(prompts[next]);
        setCaret(prompts[next].length);
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const now = event.ctrlKey || event.metaKey;
      // Orca: Ctrl+Enter with nothing typed steers the first waiting card into the running turn.
      if (now && !draft.trim() && !attachments.length && queue.length) {
        sendQueuedNow(queue[0].id);
        return;
      }
      void send({ now });
    } else if (event.key === 'Escape' && busy && !draft) {
      event.preventDefault();
      stop();
    }
  }

  // Ctrl+F finds in the conversation, wherever focus is in the view.
  const viewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        setFindOpen(true);
      } else if (event.key === 'End' && event.ctrlKey) {
        event.preventDefault();
        jumpToLatest();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && ['=', '+', '-', '_', '0'].includes(event.key)) {
        // Settings > Chat > Text size, from inside the chat.
        event.preventDefault();
        event.stopPropagation();
        const current = get(chatAppearance);
        const base = current.fontSize ?? appFontSize();
        const next = event.key === '0'
          ? null
          : Math.min(CHAT_FONT_SIZE_RANGE.max, Math.max(CHAT_FONT_SIZE_RANGE.min, base + (event.key === '-' || event.key === '_' ? -1 : 1)));
        chatAppearance.set({ ...current, fontSize: next });
      }
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, []);

  // ── Message actions ──────────────────────────────────────────────────────
  async function forkConversation() {
    if (!agent || !boundRef.current) return;
    const args = forkArgs(agent, boundRef.current);
    if (!args) return;
    const id = await spawnAgentPreset(agentPreset, root ?? undefined, {
      permissionArgsOverride: `${args} ${permissionArgs(agent, permissionMode)}`.trim(),
    });
    if (id == null) setError(`Couldn't start a forked ${agentLabel}.`);
    else {
      applyLaunchView(id, agentPreset, 'chat');
      // A fork continues the existing conversation, so don't show the empty
      // chat onboarding prompt cards over the inherited context.
      forkedChatSessions.add(id);
    }
  }

  async function rewindHere() {
    const command = agent ? rewindCommand(agent) : null;
    if (!command || busy || !isRunning) return;
    if (structuredMode) {
      await runSlashCommand(command);
      return;
    }
    await serialPaneWrite(sessionId, () => typeSlashCommand(sessionId, command, { clearInput: clearsInputWithCtrlU(agent) }));
    revisionRef.current = null;
    // Claude's rewind is a picker of earlier points; it is chosen in the terminal.
    if (agent === 'claude') setTerminalChatView(sessionId, false);
  }

  function quoteIntoComposer(text: string) {
    const quoted = text.split('\n').map((line) => `> ${line}`).join('\n');
    setDraft((current) => `${current.trim() ? `${current.replace(/\s+$/, '')}\n\n` : ''}${quoted}\n\n`);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  const openPath = useCallback((path: string) => { void openFile(resolvePath(root, path)); }, [root]);

  // Each agent turn's file changes, shown under the turn's last block.
  const turnRollups = useMemo(() => {
    const out = new Map<number, TerminalChatItem[]>();
    let turn: TerminalChatItem[] = [];
    blocks.forEach((block, index) => {
      if (block.type === 'user') turn = [];
      else if (block.type === 'activity') turn.push(...block.items);
      const next = blocks[index + 1];
      if ((!next || next.type === 'user') && turn.length) out.set(index, turn);
    });
    return out;
  }, [blocks]);

  const todos = useMemo(() => latestTodos(items), [items]);
  const showTodos = Boolean(todos?.length) && (busy || todos!.some((t) => t.status !== 'completed'));
  const userTurns = useMemo(() => items.filter((i) => i.kind === 'user').map((i) => ({ id: i.id, text: i.text })), [items]);
  const lastUserId = userTurns[userTurns.length - 1]?.id ?? null;
  const lastAssistantIndex = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) if (blocks[i].type === 'assistant') return i;
    return -1;
  }, [blocks]);
  const canFork = Boolean(agent && boundSession && forkArgs(agent, boundSession));

  const renderNested = useCallback((nested: TerminalChatItem[]) => (
    toBlocks(nested).map((block) => {
      if (block.type === 'user') return <div key={block.item.id} className="tcr-muted">{firstLine(block.item.text)}</div>;
      if (block.type === 'notice') return <div key={block.item.id} className="terminal-chat-notice">{block.item.text}</div>;
      if (block.type === 'assistant') return <Markdown key={block.item.id} text={block.item.text} onOpenImage={() => {}} />;
      if (block.type === 'command') return <CommandRow key={block.item.id} text={block.item.text} />;
      if (block.type === 'output') return <CommandOutput key={block.item.id} text={block.item.text} />;
      return <Activity key={block.id} items={block.items} live={false} />;
    })
  ), []);

  const onLinkHover = useCallback((url: string, rect: DOMRect | null) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (!get(chatLinkPreviews)) return;
    hoverTimerRef.current = setTimeout(() => setHoverLink(rect ? { url, rect } : null), rect ? 380 : 220);
  }, []);
  const keepHoverCard = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const richContext = useMemo<RichContextValue>(() => ({
    onLinkHover,
    cwd: root,
    parentSessionId: boundSession,
    diffs: turnDiffs,
    onOpenFile: openPath,
    renderNested,
  }), [onLinkHover, root, boundSession, turnDiffs, openPath, renderNested]);

  const modelApply: SessionOptionApply = structuredMode
    ? { kind: 'command', build: (value) => value }
    : agent ? modelApplyFor(agent) : { kind: 'none' };
  const effortApply: SessionOptionApply = structuredMode
    ? { kind: 'command', build: (value) => value }
    : agent ? effortApplyFor(agent) : { kind: 'none' };
  const currentModelId = structuredMode ? liveModel : picks.model ?? liveModel;
  // Until the CLI answers with its own list (or if it can't), Claude Code still
  // takes its aliases, so a model can be picked before any conversation.
  // A structured chat shows only what its provider reported, never hard-coded aliases.
  const catalogModels: AgentProviderModel[] = models.length ? models : agent === 'claude' && !structuredMode ? CLAUDE_ALIAS_MODELS : [];
  const catalogModel = catalogModels.find((model) => model.id === currentModelId)
    ?? (!structuredMode ? catalogModels.find((model) => currentModelId && sameModel(currentModelId, model.id)) : undefined);
  const unlistedModel: AgentProviderModel | null = structuredMode && currentModelId && !catalogModel
    ? { id: currentModelId, label: prettyModel(currentModelId) }
    : null;
  const menuModels = unlistedModel ? [unlistedModel, ...catalogModels] : catalogModels;
  const currentModel = catalogModel ?? unlistedModel;
  const modelLabel = currentModel?.label ?? (currentModelId ? prettyModel(currentModelId) : 'Default model');
  const efforts = (currentModel?.reasoningEfforts ?? (agent === 'claude' && !structuredMode ? CLAUDE_EFFORTS : []))
    .filter((e) => e !== 'default');
  const currentEffort = structuredMode ? liveEffort : picks.effort ?? liveEffort;
  const catalogStatus = structuredMode && structuredAgent ? modelCatalogStatus(structuredAgent, structuredState) : null;
  const catalogNote = catalogStatus
    ? modelCatalogNote(agentLabel, catalogStatus, selectedModelIssue(catalogStatus, currentModelId ?? null, currentEffort ?? null))
    : null;
  const permissionMode: ChatPermissionMode = picks.permission ?? reported.permission ?? sessionPermissionMode(sessionId);
  const permissionModes = agent ? permissionModesFor(agent, structuredMode) : [];
  const context = structuredMode
    ? structuredState?.contextUsed != null
      ? { used: structuredState.contextUsed, window: structuredState.contextWindow, estimated: false, breakdown: structuredState.contextBreakdown ?? null }
      : null
    : agent ? contextUsageFor(agent, currentModelId, reported.used, reported.window) : null;
  // A slash command typed mid-turn would queue as prompt text, so options
  // change between turns.
  const optionsLocked = busy || !isRunning || relaunching;

  async function applyOption(apply: SessionOptionApply, value: string | null, which: 'model' | 'effort') {
    if (apply.kind === 'none' || optionsLocked || !agent) return;
    // The CLI's own picker (Codex): open it, here in the chat, and let the
    // person choose. Orca never drives these pickers with keys.
    if (apply.kind === 'picker') {
      setSettingError(null);
      await runSlashCommand(apply.command);
      return;
    }
    if (!value) return;
    const before = { model: picks.model, effort: picks.effort };
    setSessionPicks(sessionId, { [which]: value });
    await runSetting(async () => {
      if (structuredMode && structuredAgent) {
        if (which === 'model') setStructuredChatModel(structuredAgent, sessionId, value);
        else setStructuredChatEffort(structuredAgent, sessionId, value);
        return null;
      }
      // No mid-session route (OpenCode): restart on the same conversation.
      if (apply.kind === 'relaunch') {
        return relaunchTerminalAgent(sessionId, agentPreset, boundRef.current, which === 'model' ? { model: value } : { effort: value });
      }
      const label = which === 'model' ? menuModels.find((m) => m.id === value)?.label ?? null : currentModel?.label ?? null;
      return applyModelChange(sessionId, agent, {
        model: which === 'model' ? value : null,
        modelLabel: which === 'model' ? label : null,
        effort: which === 'effort' ? value : null,
      });
    }, () => setSessionPicks(sessionId, before));
  }

  async function applyPermission(mode: ChatPermissionMode) {
    if (optionsLocked) return;
    const before = picks.permission;
    setSessionPicks(sessionId, { permission: mode });
    await runSetting(
      () => {
        if (structuredMode && structuredAgent) {
          const access: StructuredAccess = mode === 'full-access' ? 'full-access' : mode === 'auto' ? 'auto' : 'ask';
          setStructuredChatAccess(structuredAgent, sessionId, access);
          return Promise.resolve(null);
        }
        return applyPermissionChange(sessionId, agentPreset, boundRef.current, mode);
      },
      () => (before ? setSessionPicks(sessionId, { permission: before }) : clearSessionPicks(sessionId, ['permission'])),
    );
    revisionRef.current = null;
  }

  /** Run a settings change inside the CLI; on failure, show why and undo the pick. */
  async function runSetting(apply: () => Promise<string | null>, undo: () => void) {
    if (relaunching) return;
    setRelaunching(true);
    setSettingError(null);
    try {
      const problem = await serialPaneWrite(sessionId, apply);
      if (problem) {
        setSettingError(problem);
        undo();
      }
    } finally {
      setRelaunching(false);
    }
  }

  // The F9 dictation, aimed at this composer: focus it first so the capture's
  // field target is this textarea (it inserts React-safely, see transcription-hotkey).
  function dictate() {
    textareaRef.current?.focus();
    toggleTerminalTranscription();
  }

  // Agents read files by path; images given as a path are attached by Claude
  // Code and Codex the way a dropped file is.
  async function attachFiles() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: true, directory: false });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(String);
      if (!paths.length) return;
      const images = paths.filter((p) => IMAGE_EXTENSIONS.test(p));
      const others = paths.filter((p) => !IMAGE_EXTENSIONS.test(p));
      for (const path of images) {
        const preview = await invoke<string>('chat_image_preview', { path }).catch(() => null);
        addAttachment({ path, name: path.split(/[\\/]/).pop() ?? path, preview });
      }
      if (others.length) {
        const quoted = others.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
        setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${quoted} ` : `${quoted} `));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      textareaRef.current?.focus();
    }
  }

  function addAttachment(attachment: Omit<Attachment, 'id'>) {
    const id = ++attachmentIdRef.current;
    setAttachments((list) => [...list, { ...attachment, id }]);
  }

  function removeAttachment(id: number) {
    setAttachments((list) => {
      const gone = list.find((a) => a.id === id);
      if (gone?.revoke) URL.revokeObjectURL(gone.revoke);
      return list.filter((a) => a.id !== id);
    });
  }

  // Receive prompts and element/drawing context from the web preview inspector or annotation overlay
  useEffect(() => {
    const unsub = terminalChatInputRequest.subscribe((req) => {
      if (req && req.sessionId === sessionId) {
        if (req.text) {
          setDraft((current) => (current.trim() ? `${current.trim()}\n\n${req.text}` : req.text));
        }
        if (req.image) {
          addAttachment({
            path: req.image.path,
            name: req.image.name,
            preview: req.image.dataUrl ?? null,
          });
        }
        terminalChatInputRequest.set(null);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    });
    return () => unsub();
  }, [sessionId]);

  // A pasted image is saved to disk (the CLI gets its path) and shown as a chip;
  // text pastes are left to the textarea.
  async function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    const fromItems = files.length
      ? []
      : Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((f): f is File => Boolean(f));
    const images = files.length ? files : fromItems;
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    for (const file of images) {
      try {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const name = file.name && IMAGE_EXTENSIONS.test(file.name) ? file.name : `pasted-image-${Date.now()}.${ext}`;
        const path = await invoke<string>('save_pasted_image', { name, data: Array.from(new Uint8Array(await file.arrayBuffer())) });
        const url = URL.createObjectURL(file);
        addAttachment({ path, name, preview: url, revoke: url });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Files dropped on the composer: a real path from the explorer (or a text
  // drag) becomes an attachment chip or a quoted path in the draft; an image
  // file dropped from a plain-browser session is saved and attached like a
  // pasted one.
  const [dropOver, setDropOver] = useState(false);

  function onComposerDragOver(event: React.DragEvent) {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!types.includes('Files') && !types.includes('application/x-spacron-path') && !types.includes('text/plain')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropOver(true);
  }

  function onComposerDragLeave(event: React.DragEvent) {
    if (event.currentTarget === event.target) setDropOver(false);
  }

  async function attachDroppedPaths(paths: string[]) {
    if (!paths.length) return;
    const images = paths.filter((path) => IMAGE_EXTENSIONS.test(path));
    const others = paths.filter((path) => !IMAGE_EXTENSIONS.test(path));
    for (const path of images) {
      const name = path.split(/[\\/]/).pop() ?? path;
      let preview: string | null = null;
      try { preview = await invoke<string>('chat_image_preview', { path }); } catch { /* chip without a thumbnail */ }
      addAttachment({ path, name, preview });
    }
    if (!others.length) return;
    const quoted = others.map((path) => (/\s/.test(path) ? `"${path}"` : path)).join(' ');
    setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${quoted} ` : `${quoted} `));
  }

  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isRunning) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let revision = 0;
    const overComposer = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest('.terminal-chat-composer') === composerRef.current;
    const overPanel = (x: number, y: number) => {
      const panel = composerRef.current?.closest('.terminal-chat-view');
      return Boolean(panel && document.elementFromPoint(x, y)?.closest('.terminal-chat-view') === panel);
    };
    const attach = (paths: string[]) => {
      void attachDroppedPaths(paths);
      textareaRef.current?.focus();
    };
    const onExplorerMove = (event: Event) => {
      const { clientX, clientY } = (event as CustomEvent<{ clientX: number; clientY: number }>).detail;
      setDropOver(overPanel(clientX, clientY));
    };
    const onExplorerEnd = (event: Event) => {
      const { path, clientX, clientY } = (event as CustomEvent<{ path?: string; clientX: number; clientY: number }>).detail;
      setDropOver(false);
      if (path && overPanel(clientX, clientY)) attach([path]);
    };
    window.addEventListener('spacron-explorer-drag-move', onExplorerMove);
    window.addEventListener('spacron-explorer-drag-end', onExplorerEnd);
    if (isTauriRuntime()) {
      void getCurrentWindow().onDragDropEvent(({ payload }) => {
        const current = ++revision;
        if (payload.type === 'leave') {
          setDropOver(false);
          return;
        }
        void dropPositionToCss(payload.position).then((point) => {
          if (disposed) return;
          const over = Boolean(point && overComposer(point.x, point.y));
          if (payload.type === 'drop') {
            if (current === revision) setDropOver(false);
            if (over && payload.paths.length) attach(payload.paths);
          } else if (current === revision) {
            setDropOver(over);
          }
        });
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch((error) => console.warn('Could not listen for desktop file drops', error));
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('spacron-explorer-drag-move', onExplorerMove);
      window.removeEventListener('spacron-explorer-drag-end', onExplorerEnd);
    };
  }, [isRunning, sessionId]);

  async function onComposerDrop(event: React.DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const hint = event.dataTransfer?.getData('application/x-spacron-path')?.trim()
      || event.dataTransfer?.getData('text/plain')?.trim()
      || '';
    if (!files.length && !hint) return;
    event.preventDefault();
    event.stopPropagation();
    setDropOver(false);
    if (!files.length) {
      await attachDroppedPaths(parseDroppedPaths(hint));
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const name = file.name && IMAGE_EXTENSIONS.test(file.name) ? file.name : `dropped-image-${Date.now()}.${ext}`;
        const path = await invoke<string>('save_pasted_image', { name, data: Array.from(new Uint8Array(await file.arrayBuffer())) });
        const url = URL.createObjectURL(file);
        addAttachment({ path, name, preview: url, revoke: url });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Previews are blob: URLs; release them when the view goes away.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => {
    for (const a of attachmentsRef.current) if (a.revoke) URL.revokeObjectURL(a.revoke);
  }, []);

  function openViewer(images: string[], index: number) {
    setViewer({ images: images.map((src, i) => ({ src, name: `Image ${i + 1}` })), index });
  }

  const visualsSpot = getSessionVisuals(sessionId);

  // A visual's "send to agent" button: the request lands in the composer for
  // the user to read and send. Never sent on its own: the page is the agent's
  // own output, and auto-sending it could loop.
  function composeFromVisual(text: string) {
    setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }
  const folderName = root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? null : null;
  const empty = loaded && items.length === 0 && pending.length === 0 && sentCommands.length === 0 && !liveScreen;
  const canSend = (Boolean(draft.trim()) || attachments.length > 0) && !sending && isRunning;
  // Only a run of tool calls still at the end of the conversation is live.
  const lastBlock = blocks[blocks.length - 1];
  const lastActivity = lastBlock?.type === 'activity' ? lastBlock : null;

  return (
    <RichContext.Provider value={richContext}>
    <div
      ref={viewRef}
      className="terminal-chat-view"
      onMouseOver={(event) => {
        const target = event.target instanceof Element ? event.target.closest('[title]') as HTMLElement | null : null;
        if (!target || !event.currentTarget.contains(target)) return;
        target.dataset.chatTooltipTitle ??= target.getAttribute('title') ?? '';
        target.removeAttribute('title');
      }}
      onMouseOut={(event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-chat-tooltip-title]') as HTMLElement | null : null;
        if (!target || target.contains(event.relatedTarget as Node | null)) return;
        target.setAttribute('title', target.dataset.chatTooltipTitle ?? '');
        delete target.dataset.chatTooltipTitle;
      }}
      data-timestamps={showTimestamps ? '' : undefined}
      data-match-terminal={appearance.matchTerminal ? '' : undefined}
      data-contrast={appearance.contrast !== 100 ? '' : undefined}
      data-chat-font={appearance.font === 'app' ? undefined : appearance.font === 'system' || appearance.font === 'terminal' ? appearance.font : 'custom'}
      data-chat-font-size={appearance.fontSize == null ? undefined : 'set'}
      style={{
        '--tc-col': CHAT_WIDTH_COLUMN[appearance.width],
        '--tc-code-size': `${appearance.codeFontSize}px`,
        // An installed family picked in Settings > Chat > Font family.
        '--tc-font-family': `"${appearance.font}", system-ui, sans-serif`,
        ...contrastVars(appearance.contrast, appearance.matchTerminal),
        ...(appearance.fontSize == null ? {} : { '--tc-font-size': `${appearance.fontSize}px` }),
      } as React.CSSProperties}
      onContextMenu={openChatContextMenu}
      // The terminal's own mouse handlers (middle-click paste, copy-on-select)
      // belong to xterm; keep chat clicks out of them.
      onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {/* The agent's mark lives only here, large and faint behind the thread. */}
      <div className="terminal-chat-watermark" aria-hidden="true">
        <AgentBrandMark command={agentPreset} name={agentLabel} className="terminal-chat-watermark-mark" />
      </div>
      {findOpen && <FindBar root={threadEl} revision={items} onClose={() => { setFindOpen(false); textareaRef.current?.focus(); }} />}
      <TerminalChatContextMenu
        point={contextMenu}
        commands={agent ? slashCommandsFor(agent) : []}
        agents={otherAgents}
        commandDisabled={!isRunning || (busy && !queueFollowUps)}
        onClose={() => setContextMenu(null)}
        onFind={() => {
          setContextMenu(null);
          void revealAgentChat(sessionId).then(() => {
            setFindOpen(true);
            requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="Find in chat"]')?.focus());
          });
        }}
        onCommand={runContextCommand}
        onHandOff={() => {
          setContextMenu(null);
          requestHandoffPicker(sessionId);
        }}
        onCopyContext={() => void copyChatContext()}
      />
      {hoverLink && linkPreviews && (
        <LinkHoverCard url={hoverLink.url} rect={hoverLink.rect} onEnter={keepHoverCard} onLeave={() => onLinkHover(hoverLink.url, null)} />
      )}
      <SelectionQuote container={scrollEl} onQuote={quoteIntoComposer} />
      <div className="terminal-chat-transcript">
      <MessageRail scroller={scrollEl} turns={userTurns} revision={items} />
      <div
        className="terminal-chat-scroll"
        ref={attachScroller}
        onScroll={onScroll}
      >
        <div className="terminal-chat-thread" ref={setThreadEl}>
          {truncated && <div className="terminal-chat-notice">Earlier messages are in the terminal history</div>}
          {!loaded && <div className="terminal-chat-loading"><Dots /></div>}
          {empty && isRunning && suggestedPrompts && !structuredMode && !forkedChatSessions.has(sessionId) && (
            <div className="tcr-empty">
              <span>Ask {agentLabel} anything about {folderName ?? 'this folder'}</span>
              <SuggestedPrompts onPick={(text) => { setDraft(text); requestAnimationFrame(() => textareaRef.current?.focus()); }} />
            </div>
          )}
          {blocks.map((block, index) => {
            const key = blockKey(block);
            const marker = newMarker === key ? <NewMessagesLine key={`new-${key}`} /> : null;
            const rollup = turnDiffs ? turnRollups.get(index) : undefined;
            const files = rollup ? rollupChanges(rollup) : [];
            const changes = files.length ? (
              <TurnChanges
                key={`changes-${key}`}
                files={files}
                changesFor={(path) => rollup!.filter((item) => item.toolStatus !== 'running').flatMap((item) => fileChangesFor(item)).filter((c: FileChange) => c.path === path)}
                onOpen={openPath}
              />
            ) : null;
            let body: React.ReactNode;
            if (block.type === 'user') {
              const canRewind = Boolean(agent && rewindCommand(agent)) && isRunning && !busy
                && (agent === 'claude' || block.item.id === lastUserId);
              body = (
                <div key={key} className="tcr-msg user" data-turn-id={block.item.id}>
                  <UserTurn text={block.item.text} images={block.item.images ?? []} onOpenImage={openViewer} />
                  <MessageActions
                    align="end"
                    text={block.item.text}
                    time={itemTime(block.item.time)}
                    canResend={isRunning && !busy && !sending}
                    onResend={async (text) => {
                      if (!isRunning || busy || sending) return false;
                      await deliver(text, []);
                    }}
                    onRewind={canRewind ? () => void rewindHere() : undefined}
                  />
                </div>
              );
            } else if (block.type === 'notice') {
              body = <div key={key} className="terminal-chat-notice">{block.item.text}</div>;
            } else if (block.type === 'assistant') {
              const segments = splitReply(block.item.text);
              body = (
                <div key={key} className="tcr-msg">
                  <div className="terminal-chat-agent">
                    {segments.map((segment, i) => (segment.type === 'visual'
                      ? <ChatVisual key={`v-${i}`} visual={segment.visual} spot={visualsSpot} onCompose={composeFromVisual} />
                      : <Markdown key={`t-${i}`} text={segment.text} onOpenImage={openViewer} />))}
                  </div>
                  <MessageActions
                    text={visualReplyText(segments)}
                    replyId={`terminal:${sessionId}:${block.item.id}`}
                    time={itemTime(block.item.time)}
                    onFork={canFork && index === lastAssistantIndex && !busy ? () => void forkConversation() : undefined}
                  />
                </div>
              );
            } else if (block.type === 'command') {
              body = <CommandRow key={key} text={block.item.text} />;
            } else if (block.type === 'output') {
              body = <CommandOutput key={key} text={block.item.text} />;
            } else {
              const prs = pullRequests ? [...new Set(block.items.flatMap(openedPullRequests))] : [];
              body = (
                <div key={key} className="terminal-chat-agent">
                  <Activity items={block.items} live={busy && block === lastActivity} />
                  {prs.map((url) => <PullRequestCard key={url} url={url} ciLines={ciLines} />)}
                </div>
              );
            }
            return marker || changes ? [marker, body, changes] : body;
          })}
          {pending.map((p) => <UserTurn key={`pending-${p.id}`} text={p.text} images={p.images} onOpenImage={openViewer} pending />)}
          {structuredState?.approvals.map((approval) => (
            <div key={String(approval.requestId)} className="tcr-command-notice structured-chat-approval" role="group" aria-label={approval.title}>
              <span>
                <strong>{approval.title}</strong>
                {approval.detail && <code className="structured-chat-approval-detail">{approval.detail}</code>}
              </span>
              {approval.options?.length ? (
                <div className="structured-chat-approval-options" role="group" aria-label="Answers">
                  {approval.options.map((option, optionIndex) => (
                    <button
                      key={option.id}
                      type="button"
                      className="tcr-link-btn structured-chat-approval-option"
                      title={`Answer ${optionIndex + 1} (press ${optionIndex + 1})`}
                      onClick={() => answerStructuredCard(approval, /reject|cancel|deny|declin/i.test(`${option.kind ?? ''} ${option.id}`) ? 'decline' : 'accept', option.id)}
                    >
                      <kbd>{optionIndex + 1}</kbd>
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <button type="button" className="tcr-link-btn" onClick={() => answerStructuredCard(approval, 'accept')}>Allow</button>
                  <button type="button" className="tcr-link-btn" onClick={() => answerStructuredCard(approval, 'acceptForSession')}>Allow for this chat</button>
                  <button type="button" className="tcr-link-btn" onClick={() => answerStructuredCard(approval, 'decline')}>Decline</button>
                </>
              )}
            </div>
          ))}
          {structuredMode && <AnswerReceipts sessionId={sessionId} />}
          {liveScreen && (
            <LiveScreenCard
              key={liveScreen.sentId}
              sessionId={sessionId}
              live={liveScreen}
              agentLabel={agentLabel}
              onClose={(output) => {
                if (output) setSentCommands((list) => list.map((c) => (c.id === liveScreen.sentId ? { ...c, output } : c)));
                setLiveScreen(sessionId, null);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          )}
          {relaunching && (
            <div className="terminal-chat-working">
              <Dots />
              <span>Applying the new settings in {agentLabel}</span>
            </div>
          )}
          {busy && !relaunching && !screenPrompt && (
            <div className="terminal-chat-working">
              <Dots />
              <span>Working</span>
            </div>
          )}
        </div>
      </div>

        {!atBottom && blocks.length > 0 && <JumpToLatest unread={unread} onClick={jumpToLatest} />}
      </div>
      <div className="terminal-chat-dock">
        {showTodos && todos && <TodoDock todos={todos} />}
        {usageLimit && (
          <UsageLimitRow
            limit={usageLimit}
            autoContinue={autoContinue}
            onToggleAuto={(on) => chatUsageAutoContinue.set(on)}
            onContinue={() => { continuedLimits.add(usageLimit.id); void deliver('Continue where you left off.', []); }}
          />
        )}
        {queue.length > 0 && (
          <QueueCards
            queue={queue}
            onEdit={(id, text) => updateQueued(sessionId, id, text)}
            onDelete={(id) => removeQueued(sessionId, id)}
            onMove={(id, delta) => moveQueued(sessionId, id, delta)}
            onSendNow={sendQueuedNow}
            paused={queuePaused}
            onResume={() => setResumedError(turnError)}
          />
        )}
        {!structuredMode && commandInTerminal && !screenPrompt && (
          <div className="tcr-command-notice" role="status">
            <span><code>{commandInTerminal}</code> {opensInTerminal(agent ?? 'claude', commandInTerminal) ? 'opened a screen' : 'showed its answer'} in {agentLabel}'s terminal, not in the conversation.</span>
            <button type="button" className="tcr-link-btn" onClick={() => { setCommandInTerminal(null); openTerminalView(); }}>Open terminal</button>
            <button type="button" className="tcr-link-btn" aria-label="Dismiss" onClick={() => setCommandInTerminal(null)}>Dismiss</button>
          </div>
        )}
        {screenPrompt && !liveScreen && (
          <PromptCard
            prompt={screenPrompt}
            agentLabel={agentLabel}
            answering={answering}
            onAnswer={(index, text) => void answerPrompt(index, text)}
            onDismiss={() => dismissScreenPrompt(sessionId)}
            onOpenTerminal={openTerminalView}
          />
        )}
        {uncertainSend && (
          <div className="tcr-command-notice" role="alert">
            <span>This message may not have reached {agentLabel} when the app closed:</span>
            <span className="tcr-uncertain-text">{uncertainSend}</span>
            <button type="button" className="tcr-link-btn" onClick={() => { const text = uncertainSend; setUncertainSend(null); void deliver(text, []); }}>Send again</button>
            <button type="button" className="tcr-link-btn" onClick={() => setUncertainSend(null)}>Dismiss</button>
          </div>
        )}
        {structuredMode && error && looksLikeAuthError(error) && (
          <SignInNotice
            label={agentLabel}
            onOpenTerminal={openTerminalView}
            onRetry={reconnectChat}
          />
        )}
        {error && (
          <div className="terminal-chat-error" role="alert">
            <span>{error}</span>
            {structuredMode && (structuredState?.status === 'failed' || structuredState?.status === 'closed' || !structuredState) && (
              <button
                type="button"
                onClick={reconnectChat}
              >
                Reconnect
              </button>
            )}
            <button type="button" onClick={openTerminalView}>Open terminal</button>
          </div>
        )}
        {structuredMode && <GoalPanel sessionId={sessionId} onCommand={(command) => void runSlashCommand(command)} />}
        <div
          ref={composerRef}
          className={`terminal-chat-composer${isRunning ? '' : ' exited'}${dropOver ? ' drop-over' : ''}`}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={(event) => void onComposerDrop(event)}
        >
          {suggestions.length > 0 && (
            <ComposerMenu
              items={suggestions}
              active={Math.min(menuIndex, suggestions.length - 1)}
              title={slash != null ? `${agentLabel} commands and skills` : dollar ? `${agentLabel} skills` : 'Files'}
              onHover={setMenuIndex}
              onPick={pickSuggestion}
            />
          )}
        {!structuredMode && showKeys && (
            <div className="terminal-chat-keys" role="group" aria-label="Send keys to the terminal">
              <span className="terminal-chat-keys-hint">Answer a prompt in the terminal</span>
              <div className="terminal-chat-keys-row">
                {PROMPT_KEYS.map((k) => (
                  <button key={k.label} type="button" title={k.title} onClick={() => writeToSession(sessionId, k.data)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="terminal-chat-attachments">
              {attachments.map((a, index) => (
                <div key={a.id} className="terminal-chat-attachment" title={a.name}>
                  <button
                    type="button"
                    className="terminal-chat-attachment-thumb"
                    aria-label={`Preview ${a.name}`}
                    onClick={() => {
                      const previews = attachments.map((x) => x.preview).filter((u): u is string => Boolean(u));
                      if (a.preview) openViewer(previews, Math.max(0, previews.indexOf(a.preview)));
                    }}
                  >
                    {a.preview ? <img src={a.preview} alt="" /> : <span className="terminal-chat-attachment-icon">IMG</span>}
                  </button>
                  <button type="button" className="terminal-chat-attachment-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>
                    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1 1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                  </button>
                  {index === 0 && attachments.length > 1 && <span className="terminal-chat-attachment-count">{attachments.length}</span>}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onPaste={(e) => void onPaste(e)}
            rows={1}
            spellCheck={spellcheck}
            autoCorrect={spellcheck ? 'on' : 'off'}
            placeholder={isRunning
              ? busy && queueFollowUps ? `Queue a follow-up (Ctrl+Enter sends it now)` : `Message ${agentLabel}  ·  / for commands, @ for files`
              : `${agentLabel} has exited`}
            disabled={!isRunning}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              if (historyAt != null && e.target.value !== prompts[historyAt]) setHistoryAt(null);
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onBlur={() => setMenuDismissed(menuKey)}
            onFocus={() => { setMenuDismissed(null); clearStructuredChatUnread(sessionId); }}
            onKeyDown={onKeyDown}
          />
          <div className="terminal-chat-composer-bar">
            <button
              type="button"
              className="terminal-chat-icon-btn"
              title="Attach files (their paths go into the message)"
              aria-label="Attach files"
              disabled={!isRunning}
              onClick={() => void attachFiles()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            {agent && permissionModes.length > 0 && (
              <AccessMenu
                agent={agent}
                modes={permissionModes}
                mode={permissionMode}
                disabled={optionsLocked}
                title={optionsLocked ? 'Change permissions between turns' : 'Permissions'}
                onPick={(mode) => void applyPermission(mode)}
              />
            )}
            {!structuredMode && (
              <button
                type="button"
                className={`terminal-chat-icon-btn${showKeys ? ' active' : ''}`}
                title="Keys for terminal prompts (approvals, pickers)"
                aria-label="Keys for terminal prompts"
                aria-pressed={showKeys}
                onClick={() => setShowKeys((v) => !v)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="2" y="6" width="20" height="12" rx="2.5" />
                  <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
                </svg>
              </button>
            )}
            <span className="terminal-chat-bar-spacer" />
            {structuredMode && <AgentModeChip mode={structuredState?.mode ?? null} />}
            {context && <ContextRing usage={context} />}
            <ModelMenu
              modelLabel={modelLabel}
              effortLabel={currentEffort ? shortEffort(currentEffort) : null}
              title={catalogNote ?? (modelApply.kind === 'none'
                ? `${agentLabel} can't switch models mid-session`
                : optionsLocked ? 'Change the model between turns'
                  : modelApply.kind === 'picker' ? `Choose the model and reasoning in ${agentLabel}'s own picker`
                    : modelApply.kind === 'relaunch' ? `${agentLabel} restarts on this conversation with the new model`
                      : 'Model and reasoning')}
              disabled={modelApply.kind === 'none' || optionsLocked}
              applying={relaunching}
              error={settingError}
              onPicker={modelApply.kind === 'picker' ? () => void applyOption(modelApply, null, 'model') : undefined}
              models={menuModels.filter((m) => m.supported !== false).map((m) => ({ value: m.id, label: m.label, hint: m.description }))}
              model={currentModel?.id ?? null}
              onModel={(value) => void applyOption(modelApply, value, 'model')}
              efforts={effortApply.kind !== 'none' ? efforts.map((e) => ({ value: e, label: shortEffort(e) })) : []}
              effort={currentEffort}
              onEffort={(value) => void applyOption(effortApply, value, 'effort')}
            />
            <button
              type="button"
              className={`terminal-chat-icon-btn${dictating ? ' recording' : ''}`}
              title={dictating ? 'Stop dictation (F9)' : 'Dictate (F9)'}
              aria-label={dictating ? 'Stop dictation' : 'Dictate'}
              aria-pressed={dictating}
              disabled={!isRunning}
              onClick={dictate}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
              </svg>
            </button>
            {busy && !draft.trim() ? (
              <button type="button" className="terminal-chat-send stop" title="Stop (Esc)" aria-label="Stop" onClick={stop}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2.2" fill="currentColor" /></svg>
              </button>
            ) : (
              <button
                type="button"
                className="terminal-chat-send"
                title="Send (Enter)"
                aria-label="Send"
                disabled={!canSend}
                onClick={() => void send()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {viewer && (
          <ImageViewer images={viewer.images} startIndex={viewer.index} projectRoot={root} onClose={() => setViewer(null)} />
        )}
        <div className="terminal-chat-context-line">
          {folderName && (
            <span title={root ?? undefined}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              {folderName}
              <em>· {worktree ? 'Worktree' : 'Main checkout'}</em>
            </span>
          )}
          {worktree?.branch && (
            <span className="branch">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-12 7" /></svg>
              {worktree.branch}
            </span>
          )}
        </div>
      </div>
    </div>
    </RichContext.Provider>
  );
}

/** The `<sigil>word` being typed at the caret, at a word start. */
export function tokenAt(draft: string, caret: number, sigil: string): { start: number; query: string } | null {
  const before = draft.slice(0, caret);
  const escaped = sigil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\s)${escaped}([\\w:.-]*)$`).exec(before);
  return m ? { start: caret - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

/** Names containing `query`, those starting with it first, then in their own order. */
export function rankByName<T>(list: T[], query: string, name: (item: T) => string): T[] {
  const q = query.toLowerCase();
  return list
    .map((item) => ({ item, n: name(item).toLowerCase() }))
    .filter(({ n }) => n.includes(q))
    .sort((a, b) => Number(!a.n.startsWith(q)) - Number(!b.n.startsWith(q)))
    .map(({ item }) => item);
}

const skillCache = new Map<string, { at: number; list: ChatSkillEntry[]; live?: boolean }>();

export function peekSkills(agent: string, root: string): ChatSkillEntry[] {
  return skillCache.get(`${agent}|${root}`)?.list ?? [];
}

/**
 * The skills and custom commands an agent loads for `root`. Claude Code (and
 * OpenClaude) are asked for their live list, the way Orca does it, which also
 * carries plugin skills and built-ins; the folder scan is the fallback and the
 * source for every other agent. Claude's answer takes a few seconds, so it is
 * cached for five minutes; a folder scan for fifteen seconds.
 */
export async function loadSkills(agent: string, root: string): Promise<ChatSkillEntry[]> {
  const key = `${agent}|${root}`;
  const cached = skillCache.get(key);
  const live = agent === 'claude' || agent === 'openclaude';
  if (cached && Date.now() - cached.at < (live && cached.live ? 300_000 : 15_000)) return cached.list;
  let pending = skillLoads.get(key);
  if (!pending) {
    pending = (async () => {
      if (live) {
        try {
          const list = await invoke<ChatSkillEntry[]>('chat_claude_commands', { cwd: root, command: agent });
          if (list.length) {
            skillCache.set(key, { at: Date.now(), list, live: true });
            return list;
          }
        } catch {
          // Fall back to reading the skill folders.
        }
      }
      try {
        const list = await invoke<ChatSkillEntry[]>('chat_list_skills', { agent, cwd: root });
        skillCache.set(key, { at: Date.now(), list, live: false });
        return list;
      } catch {
        return cached?.list ?? [];
      }
    })().finally(() => skillLoads.delete(key));
    skillLoads.set(key, pending);
  }
  return pending;
}

const skillLoads = new Map<string, Promise<ChatSkillEntry[]>>();

/** The app's UI text size, which the chat follows until its own size is set. */
function appFontSize(): number {
  if (typeof document === 'undefined') return 14;
  return Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size')) || 14);
}

/**
 * Settings > Chat > Contrast. Below 100 text fades toward the background;
 * above it, toward pure white (dark themes) or black (light themes).
 */
export function contrastVars(contrast: number, matchTerminal: boolean): Record<string, string> {
  if (contrast === 100) return {};
  const lightText = matchTerminal || isLightColor(typeof document === 'undefined'
    ? '#fff'
    : getComputedStyle(document.documentElement).getPropertyValue('--text-primary'));
  const extreme = lightText ? '#ffffff' : '#000000';
  const mix = (base: string) => (contrast < 100
    ? `color-mix(in srgb, var(${base}) ${contrast}%, transparent)`
    : `color-mix(in srgb, var(${base}), ${extreme} ${Math.round((contrast - 100) * 2.6)}%)`);
  return {
    '--tc-base-ink': 'var(--text-primary)',
    '--tc-base-muted': 'var(--text-muted)',
    '--tc-ink': mix('--tc-base-ink'),
    '--tc-ink-muted': mix('--tc-base-muted'),
  };
}

function isLightColor(value: string): boolean {
  const v = value.trim();
  let r = 255;
  let g = 255;
  let b = 255;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else if (rgb) {
    [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

function blockKey(block: Block): string {
  return block.type === 'activity' ? block.id : block.item.id;
}

const CLAUDE_EFFORTS: ChatReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude Code's model aliases (always the latest of each family), for when no live list is available. */
const CLAUDE_ALIAS_MODELS: AgentProviderModel[] = [
  { id: 'opus', label: 'Opus', description: 'Most capable, for complex work' },
  { id: 'sonnet', label: 'Sonnet', description: 'Fast and capable for everyday tasks' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest, for quick answers' },
];

function effortLabel(value: string): string {
  return REASONING_LABELS[value as ChatReasoningEffort] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

/** Transcript ids carry versions and vendor prefixes the catalogue may not ("claude-opus-5-5" vs "opus"). */
function sameModel(a: string, b: string): boolean {
  // OpenCode ids name their provider ("abacus/claude-opus-4-5"); the same
  // model under another provider is a different pick.
  if (a.includes('/') && b.includes('/')) return a.toLowerCase() === b.toLowerCase();
  const norm = (v: string) => v.toLowerCase().replace(/\[1m\]$/, '').replace(/^.*\//, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`)) return true;
  // A Claude family alias ("opus") names the latest model of that family.
  const family = (alias: string, id: string) => /^(opus|sonnet|haiku)$/.test(alias) && new RegExp(`(^|-)${alias}(-|$)`).test(id);
  return family(x, y) || family(y, x);
}

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6-luna" → "Gpt 6 Luna". */
function prettyModel(id: string): string {
  const bare = id.replace(/^.*\//, '');
  // OpenAI names read as written: "gpt-6-luna" → "GPT-6-Luna".
  if (/^(gpt|o\d)/i.test(bare)) {
    return bare.split('-').map((part, i) => (i === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))).join('-');
  }
  const parts = id.replace(/^.*\//, '').replace(/^claude-/, '').replace(/\[1m\]$/i, '').split('-');
  let out = '';
  parts.forEach((part, i) => {
    const joinsVersion = /^\d+$/.test(part) && /^\d+$/.test(parts[i - 1] ?? '');
    out += joinsVersion ? `.${part}` : `${i ? ' ' : ''}${part.charAt(0).toUpperCase()}${part.slice(1)}`;
  });
  return out;
}

function isChatPermission(value: string | null): value is ChatPermissionMode {
  return value === 'ask' || value === 'accept-edits' || value === 'auto' || value === 'full-access';
}

export function shortEffort(value: string): string {
  const short: Record<string, string> = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
  return short[value] ?? effortLabel(value);
}

type MenuOption = { value: string; label: string; hint?: string };

/** Close a popover on outside click or Escape. */
function useDismiss(open: boolean, setOpen: (v: boolean) => void, rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen, rootRef]);
}

function PermissionIcon({ mode }: { mode: ChatPermissionMode }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (mode === 'ask') {
    return <svg {...common}><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v8M14 11.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 16.5a1.6 1.6 0 0 1 2.4-2.1L8 17" /></svg>;
  }
  if (mode === 'accept-edits') {
    return <svg {...common}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
  }
  if (mode === 'auto') {
    return <svg {...common}><path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3z" /><path d="m9 12 2 2 4-4" /></svg>;
  }
  return <svg {...common}><path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3z" /><path d="M12 8v4M12 16h.01" /></svg>;
}

/**
 * The permission pill and its menu (Orca's modes and copy). A pick restarts the
 * CLI in its terminal with the new flags and resumes the same conversation.
 */
function AccessMenu({
  agent,
  modes,
  mode,
  disabled,
  title,
  onPick,
}: {
  agent: NonNullable<ReturnType<typeof transcriptAgentFor>>;
  modes: ChatPermissionMode[];
  mode: ChatPermissionMode;
  disabled: boolean;
  title: string;
  onPick: (mode: ChatPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, setOpen, rootRef);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  // Keep scrolling firm: prevent wheel events from escaping and bouncing the chat behind it.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;

    const onWheel = (e: WheelEvent) => {
      e.stopPropagation();
      // Block horizontal wheel gestures completely so it never scrolls left or right
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        return;
      }
      const isAtTop = menu.scrollTop <= 0 && e.deltaY < 0;
      const isAtBottom = menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 1 && e.deltaY > 0;
      if (isAtTop || isAtBottom || menu.scrollHeight <= menu.clientHeight) {
        e.preventDefault();
      }
    };

    menu.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      menu.removeEventListener('wheel', onWheel);
    };
  }, [open]);

  return (
    <div className="terminal-chat-option" ref={rootRef}>
      <button
        type="button"
        className={`terminal-chat-pill access${mode === 'full-access' ? ' full' : ''}${open ? ' open' : ''}`}
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <PermissionIcon mode={mode} />
        <span className="terminal-chat-pill-label">{PERMISSION_MODE_COPY[mode].label}</span>
        <svg className="terminal-chat-pill-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 3.8 5 6.3l2.5-2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="terminal-chat-menu access" role="menu" ref={menuRef}>
          {modes.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === mode}
              className={`terminal-chat-access-item${value === mode ? ' selected' : ''}${value === 'full-access' ? ' full' : ''}`}
              onClick={() => {
                setOpen(false);
                if (value !== mode) onPick(value);
              }}
            >
              <span className="terminal-chat-access-bullet" aria-hidden="true" />
              <span className="terminal-chat-access-icon"><PermissionIcon mode={value} /></span>
              <span className="terminal-chat-menu-text">
                <span className="terminal-chat-menu-label">{PERMISSION_MODE_COPY[value].label}</span>
                <span className="terminal-chat-access-desc">{permissionDescription(agent, value)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * The composer's model pill: search, the leading models, "More models (n)",
 * and the effort levels along the bottom, as Orca and T3 Code draw it.
 */
export function ModelMenu({
  modelLabel,
  effortLabel: effortText,
  title,
  disabled,
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
  applying = false,
  error = null,
  onPicker,
}: {
  modelLabel: string;
  effortLabel: string | null;
  title: string;
  disabled?: boolean;
  /** A change is on its way to the CLI. */
  applying?: boolean;
  /** Why the last change didn't apply. */
  error?: string | null;
  /** The CLI picks in its own picker: the pill opens that instead of a list. */
  onPicker?: () => void;
  models: MenuOption[];
  model: string | null;
  onModel: (value: string) => void;
  efforts: MenuOption[];
  effort: string | null;
  onEffort: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoClose = useCallback(() => {
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) clearAutoClose();
    return clearAutoClose;
  }, [open, clearAutoClose]);

  useDismiss(open, setOpen, rootRef);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    requestAnimationFrame(() => {
      searchRef.current?.focus({ preventScroll: true });
      // Bring the current model into view inside the list without moving the window or chat history.
      const list = listRef.current;
      const selected = list?.querySelector<HTMLElement>('.terminal-chat-menu-item.selected');
      if (list && selected) {
        const itemTop = selected.offsetTop;
        const itemHeight = selected.offsetHeight;
        if (itemTop < list.scrollTop) {
          list.scrollTop = itemTop;
        } else if (itemTop + itemHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = itemTop + itemHeight - list.clientHeight;
        }
      }
    });
  }, [open]);

  // Prevent wheel events from escaping and scrolling the chat background,
  // and completely block horizontal trackpad/wheel gestures.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu) return;

    const onWheel = (e: WheelEvent) => {
      e.stopPropagation();
      // Block horizontal wheel / trackpad gestures completely so it never scrolls left or right
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        return;
      }
      const list = listRef.current;
      if (!list) {
        e.preventDefault();
        return;
      }
      const isInsideList = list.contains(e.target as Node);
      if (!isInsideList) {
        list.scrollTop += e.deltaY;
        e.preventDefault();
        return;
      }
      const isAtTop = list.scrollTop <= 0 && e.deltaY < 0;
      const isAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1 && e.deltaY > 0;
      if (isAtTop || isAtBottom || list.scrollHeight <= list.clientHeight) {
        e.preventDefault();
      }
    };

    menu.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      menu.removeEventListener('wheel', onWheel);
    };
  }, [open]);

  const handlePickModel = useCallback((value: string) => {
    if (value !== model) onModel(value);
    if (efforts.length > 0) {
      clearAutoClose();
      autoCloseTimerRef.current = setTimeout(() => {
        setOpen(false);
      }, 20_000);
    } else {
      setOpen(false);
    }
  }, [model, onModel, efforts.length, clearAutoClose]);

  const handlePickEffort = useCallback((value: string) => {
    clearAutoClose();
    setOpen(false);
    if (value !== effort) onEffort(value);
  }, [effort, onEffort, clearAutoClose]);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? models.filter((m) => `${m.label} ${m.value} ${m.hint ?? ''}`.toLowerCase().includes(needle))
    : models;
  // Firm: the list keeps the CLI's order and a fixed height, and only scrolls vertically.
  const visible = matches;
  const hasMenu = models.length > 0 || efforts.length > 0;

  // Single-line models without hints are ~36px; models with hints are ~52px.
  // Sized from the whole list, not the search results, so typing never resizes or bounces the menu.
  const hasHints = useMemo(() => models.some((m) => Boolean(m.hint)), [models]);
  const rowHeight = hasHints ? 52 : 36;
  const gap = 2;
  const maxRows = hasHints ? 5 : 6;
  const visibleRows = Math.min(models.length, maxRows);
  const listHeight = visibleRows > 0 ? (visibleRows * rowHeight + Math.max(0, visibleRows - 1) * gap + 4) : 40;

  return (
    <div className="terminal-chat-option" ref={rootRef}>
      <button
        type="button"
        className={`terminal-chat-pill model${open ? ' open' : ''}${applying ? ' applying' : ''}`}
        title={error ?? title}
        disabled={disabled || applying}
        aria-haspopup={onPicker ? 'dialog' : 'menu'}
        aria-expanded={onPicker ? undefined : open}
        aria-busy={applying}
        onClick={() => {
          if (onPicker) onPicker();
          else if (hasMenu) setOpen((v) => !v);
        }}
      >
        <span className="terminal-chat-pill-label">{modelLabel}</span>
        {effortText && <span className="terminal-chat-pill-effort">{effortText}</span>}
        <svg className="terminal-chat-pill-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.5 3.8 5 6.3l2.5-2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {error && !open && <span className="terminal-chat-pill-error" role="status">{error}</span>}
      {open && (
        <div className="terminal-chat-menu right model" role="menu" ref={menuRef}>
          {models.length > 0 && (
            <>
              <label className="terminal-chat-model-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input
                  ref={searchRef}
                  value={query}
                  placeholder="Search models..."
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && visible[0]) {
                      handlePickModel(visible[0].value);
                    }
                  }}
                />
              </label>
              <div
                className="terminal-chat-model-list"
                ref={listRef}
                style={{ height: `${listHeight}px` }}
                onScroll={(e) => {
                  if ((e.currentTarget as HTMLDivElement).scrollLeft !== 0) {
                    (e.currentTarget as HTMLDivElement).scrollLeft = 0;
                  }
                }}
              >
                {visible.map((option) => (
                  <MenuItem
                    key={option.value}
                    option={option}
                    selected={option.value === model}
                    onPick={() => handlePickModel(option.value)}
                  />
                ))}
                {!visible.length && <div className="terminal-chat-menu-empty">No models match</div>}
              </div>
            </>
          )}
          {efforts.length > 0 && (
            <div className="terminal-chat-effort-bar" role="group" aria-label="Reasoning effort">
              <span>Effort</span>
              <div className="terminal-chat-effort-segments">
                {efforts.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.value === effort}
                    className={option.value === effort ? 'selected' : ''}
                    onClick={() => handlePickEffort(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ option, selected, onPick }: { option: MenuOption; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`terminal-chat-menu-item${selected ? ' selected' : ''}`}
      onClick={onPick}
    >
      <span className="terminal-chat-menu-text">
        <span className="terminal-chat-menu-label">{option.label}</span>
        {option.hint && <span className="terminal-chat-menu-hint">{option.hint}</span>}
      </span>
      {selected && (
        <svg className="terminal-chat-menu-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m2.5 6.2 2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/** How much of the model's context window the conversation fills. */
export function ContextRing({ usage }: { usage: ContextUsage }) {
  const percent = usage.window ? Math.min(100, (usage.used / usage.window) * 100) : null;
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const tone = percent == null ? '' : percent >= 90 ? ' critical' : percent >= 75 ? ' warn' : '';
  const title = usage.window
    ? `Context: ${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens (${Math.round(percent ?? 0)}%)${usage.estimated ? ', window estimated' : ''}`
    : `Context: ${formatTokens(usage.used)} tokens`;
  const detail = usage.breakdown?.length
    ? `${title}\n${usage.breakdown.map((row) => `${row.name}: ${formatTokens(row.tokens)}`).join('\n')}`
    : title;
  return (
    <div className={`terminal-chat-context${tone}`} title={detail} aria-label={title}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="track" />
        {percent != null && (
          <circle
            cx="9"
            cy="9"
            r={r}
            className="fill"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - percent / 100)}
            transform="rotate(-90 9 9)"
          />
        )}
      </svg>
      <span>{usage.window ? `${formatTokens(usage.used)} / ${formatTokens(usage.window)}` : formatTokens(usage.used)}</span>
    </div>
  );
}

export function Dots() {
  return <span className="terminal-chat-dots" aria-hidden="true"><i /><i /><i /></span>;
}

export function UserTurn({
  text,
  images,
  onOpenImage,
  pending = false,
}: {
  text: string;
  images: string[];
  onOpenImage: (images: string[], index: number) => void;
  pending?: boolean;
}) {
  // Codex and Claude write an "[Image #1]" marker for each attachment; the
  // thumbnails stand in for it.
  const words = images.length ? text.replace(/\[Image #\d+\]\s*/g, '').trim() : text;
  const [expanded, setExpanded] = useState(false);
  const fold = useMemo(() => foldUserText(words), [words]);
  return (
    <div className={`terminal-chat-user${pending ? ' pending' : ''}`}>
      {images.length > 0 && (
        <div className="terminal-chat-user-images">
          {images.map((src, index) => (
            <button key={index} type="button" className="terminal-chat-user-image" aria-label={`Open image ${index + 1}`} onClick={() => onOpenImage(images, index)}>
              <img src={src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {words && (
        <div className="terminal-chat-user-bubble">
          {fold.long && !expanded ? fold.preview : words}
          {fold.long && (
            <button type="button" className="terminal-chat-user-fold" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show less' : fold.hiddenLines > 0 ? `Show more (${fold.hiddenLines} more lines)` : 'Show more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** A run of tool calls and thinking, drawn as Orca's tool run (TerminalChatToolRun). */
export function Activity({ items, live }: { items: TerminalChatItem[]; live: boolean }) {
  const rich = useContext(RichContext);
  return <ToolRun items={items} live={live} context={rich} />;
}

/** An agent reply as Markdown. Links never navigate the app window. */
export function Markdown({ text, onOpenImage }: { text: string; onOpenImage: (images: string[], index: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rich = useContext(RichContext);
  const html = useMemo(() => {
    try {
      return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }) as string);
    } catch {
      return DOMPurify.sanitize(text);
    }
  }, [text]);
  // One object per `html`, so React doesn't rewrite the markup (and drop the copy buttons) every render.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
      const pre = code.parentElement!;
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = 'true';
      void highlightCodeElement(code);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'terminal-chat-code-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        void copyTextToClipboard(code.textContent ?? '').then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
        });
      });
      pre.appendChild(copy);
    });
    // Images in a reply: a local path can't load directly (the asset protocol
    // is scoped to wallpapers), so it is read through the preview command.
    root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      if (img.dataset.enhanced) return;
      img.dataset.enhanced = 'true';
      img.classList.add('terminal-chat-md-image');
      const src = img.getAttribute('src') ?? '';
      if (src && !/^(data:|blob:|https?:)/i.test(src)) {
        let path = src.replace(/^file:\/\/\/?/i, '');
        try { path = decodeURI(path); } catch { /* Keep the literal filename. */ }
        const candidates = [resolvePath(rich?.cwd ?? null, path)];
        if (rich?.cwd && !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path) && !path.startsWith('generations/')) {
          candidates.push(resolvePath(rich.cwd, `generations/${path}`));
        }
        void (async () => {
          for (const candidate of candidates) {
            try {
              img.src = await invoke<string>('chat_image_preview', { path: candidate });
              img.dataset.localPath = candidate;
              return;
            } catch { /* Try the next location. */ }
          }
          img.alt = `${img.alt || 'Image'} (preview unavailable)`;
        })();
      }
    });
    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('terminal-chat-table')) return;
      const wrap = document.createElement('div');
      wrap.className = 'terminal-chat-table';
      const headers = Array.from(table.tHead?.rows[0]?.cells ?? []);
      table.setAttribute('role', 'table');
      for (const section of Array.from(table.tBodies)) {
        section.setAttribute('role', 'rowgroup');
        for (const row of Array.from(section.rows)) {
          row.setAttribute('role', 'row');
          for (const [index, cell] of Array.from(row.cells).entries()) {
            cell.setAttribute('role', 'cell');
            const label = headers[index]?.textContent?.trim();
            if (!label) continue;
            const caption = document.createElement('span');
            caption.className = 'terminal-chat-table-label';
            caption.setAttribute('aria-hidden', 'true');
            caption.textContent = label;
            cell.prepend(caption);
          }
        }
      }
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className="terminal-chat-md"
      onMouseOver={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        const href = anchor?.getAttribute('href') ?? '';
        if (anchor && /^https?:/i.test(href) && !anchor.contains(event.relatedTarget as Node)) {
          rich?.onLinkHover(href, anchor.getBoundingClientRect());
        }
      }}
      onMouseOut={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (anchor && !anchor.contains(event.relatedTarget as Node)) rich?.onLinkHover(anchor.getAttribute('href') ?? '', null);
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target instanceof HTMLImageElement) {
          const elements = Array.from(ref.current?.querySelectorAll<HTMLImageElement>('img') ?? [])
            .filter((image) => image.complete && image.naturalWidth > 0);
          const images = elements.map((image) => image.src);
          const index = elements.indexOf(target);
          if (index >= 0) onOpenImage(images, index);
          return;
        }
        const anchor = target.closest('a');
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute('href') ?? '';
        if (/^(?:https?:|mailto:)/i.test(href)) {
          if (/^https?:/i.test(href)) void openUrlInPreviewPanel(href);
          else void invoke('preview_open_in_browser', { url: href }).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
        }
      }}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}


/** Keys a TUI screen takes, by the browser key that sends them. */
const SCREEN_KEYS: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  Backspace: '\x7f',
  ' ': ' ',
};

/**
 * A slash command's screen (a picker, a dialog, a question) driven from the
 * chat: what the CLI shows, live, with its keys and an input box. It closes
 * when the CLI's prompt comes back, or on Esc, and its last state stays in the
 * conversation as the command's output.
 */
function LiveScreenCard({
  sessionId,
  live,
  agentLabel,
  onClose,
}: {
  sessionId: number;
  live: LiveScreen;
  agentLabel: string;
  onClose: (output: string | null) => void;
}) {
  const [text, setText] = useState<string>(() => live.capture.peek() ?? '');
  const [input, setInput] = useState('');
  const awayRef = useRef(false);
  const lastRef = useRef<string | null>(null);
  const closedRef = useRef(false);
  const screenRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((output: string | null) => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose(output);
  }, [onClose]);

  useEffect(() => {
    requestAnimationFrame(() => screenRef.current?.focus());
    // The picker's title row (OpenCode "Select model"), once seen.
    let title: string | null = null;
    const timer = setInterval(() => {
      const now = live.capture.peek();
      if (now) {
        lastRef.current = now;
        title ??= now.split('\n').map((l) => l.trim()).find(Boolean) ?? null;
      }
      setText(now ?? '');
      const atPrompt = live.capture.atPrompt();
      if (!atPrompt) awayRef.current = true;
      // The CLI drew its prompt again: the screen is done.
      else if (awayRef.current) close(lastRef.current);
      // A dialog drawn over the prompt (OpenCode) never hides it, so the
      // prompt test can't tell; its title leaving the screen does.
      else if (title && !live.capture.screen().includes(title)) close(lastRef.current);
    }, 250);
    return () => clearInterval(timer);
  }, [live, close]);

  function send(data: string) {
    writeToSession(sessionId, data);
  }

  function escape() {
    send('\x1b');
    // A dialog drawn over the prompt never hid it; close once Esc lands.
    setTimeout(() => {
      if (!awayRef.current || live.capture.atPrompt()) close(lastRef.current);
    }, 450);
  }

  async function submitInput() {
    const value = input;
    setInput('');
    for (const ch of value) {
      send(ch);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    send('\r');
    screenRef.current?.focus();
  }

  function onScreenKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      escape();
      return;
    }
    const data = SCREEN_KEYS[event.key] ?? (event.key.length === 1 ? event.key : null);
    if (data == null) return;
    event.preventDefault();
    event.stopPropagation();
    send(data);
  }

  return (
    <div className="tcr-live-screen" role="group" aria-label={`${live.command} in ${agentLabel}`}>
      <div className="tcr-live-screen-head">
        <code>{live.command}</code>
        <span>Use the arrow keys and Enter here, or type below. Press <kbd>Esc</kbd> to go back to the chat.</span>
      </div>
      <div
        ref={screenRef}
        className="tcr-live-screen-body"
        tabIndex={0}
        onKeyDown={onScreenKey}
        aria-live="polite"
      >
        <pre>{text || 'Waiting for ' + agentLabel + '…'}</pre>
      </div>
      <div className="tcr-live-screen-keys">
        <button type="button" onClick={() => send(SCREEN_KEYS.ArrowUp)} aria-label="Up">↑</button>
        <button type="button" onClick={() => send(SCREEN_KEYS.ArrowDown)} aria-label="Down">↓</button>
        <button type="button" onClick={() => send(SCREEN_KEYS.Tab)}>Tab</button>
        <button type="button" onClick={() => send(SCREEN_KEYS[' '])}>Space</button>
        <button type="button" onClick={() => send(SCREEN_KEYS.Enter)}>Enter</button>
        <button type="button" onClick={escape}>Esc</button>
        <input
          className="tcr-live-screen-input"
          value={input}
          placeholder="Type an answer, then Enter"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submitInput();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              escape();
            }
          }}
        />
      </div>
    </div>
  );
}
