/**
 * A structured chat pane (Orca's "Codex Chat"): the agent runs over its own
 * protocol (`services/structured-chat/codex-session.ts`), with no terminal,
 * so every model and reasoning level it lists can be picked at any time
 * between turns. It reuses the terminal chat view's pieces and styles, so the
 * two look the same.
 *
 * NOT MOUNTED: nothing imports this file. The structured surface the app shows
 * is `TerminalChatView` with `structuredAgent` set (from `TerminalPane`), and
 * chrome added later lives in `StructuredChatExtras.tsx`. Anything added here
 * alone never runs — port it to the live view before calling it done.
 */
import { reconnectStructuredSession } from '$lib/services/structured-chat/session-store';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import {
  answerStructuredChatApproval,
  answerStructuredSubagent,
  cancelStructuredSubagent,
  getStructuredChat,
  getStructuredSubagents,
  interruptStructuredChat,
  openStructuredSubagent,
  providerCapabilities,
  providerOwnsSubagents,
  sendStructuredChat,
  setStructuredChatAccess,
  setStructuredChatEffort,
  setStructuredChatModel,
  spawnStructuredSubagent,
  steerStructuredChat,
  subscribeStructuredChat,
  subscribeStructuredSubagents,
} from '$lib/services/structured-chat/registry';
import { structuredChatProvider } from '$lib/services/structured-chat/registry';
import { useStructuredChatHistory, useStructuredChatPane } from '$lib/services/structured-chat/panes';
import { runStructuredCommand, STRUCTURED_COMMANDS, STRUCTURED_PASSTHROUGH } from '$lib/services/structured-chat/commands';
import { forkStructuredSession, rewindStructuredSession } from '$lib/services/structured-chat/session-store';
import {
  draftToPersist,
  filterModels,
  promptHistoryOf,
  quoteAsBlockquote,
  structuredDraftKey,
} from '$lib/services/structured-chat/composer';
import type { StructuredAccess, StructuredApprovalOption, StructuredSubagentSession } from '$lib/services/structured-chat/provider';
import { useStore } from '$lib/react/useStore';
import {
  CHAT_WIDTH_COLUMN,
  chatAppearance,
  chatCiLines,
  chatComposerSpellcheck,
  chatLinkPreviews,
  chatMarkNewMessages,
  chatPullRequests,
  chatScrollToLatestOnSend,
  chatShowTimestamps,
  chatSuggestedPrompts,
  chatTurnDiffs,
  chatUsageAutoContinue,
} from '$lib/stores/chatViewSettings';
import {
  fileChangesFor,
  latestTodos,
  mentionAt,
  openedPullRequests,
  rollupChanges,
  slashCommandsFor,
  slashQuery,
  trailingUsageLimit,
  type FileChange,
  type SlashCommand,
  itemTime,
} from '$lib/services/terminal-chat-rich';
import { openFile } from '$lib/stores/editor';
import { getAgentRoster } from '$lib/stores/runs';
import { enqueue, moveQueued, removeQueued, shiftQueue, updateQueued, useQueue } from '$lib/services/terminal-chat-queue';
import ImageViewer, { type ViewerImage } from '$lib/components/shared/ImageViewer';
import { ChatVisual, splitReply, visualReplyText } from './ChatVisual';
import { structuredVisualsSpot } from '$lib/services/structured-chat/visuals';
import {
  Markdown,
  RichContext,
  UserTurn,
  contrastVars,
  loadSkills,
  peekSkills,
  rankByName,
  tokenAt,
  type RichContextValue,
} from './TerminalChatView';
import {
  CommandOutput,
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
import './TerminalChatRich.css';
import './TerminalChatView.css';

export const shortEffort = (value: string): string => value.replace(/^x/, 'X').replace(/^./, (letter) => letter.toUpperCase());
const Dots = () => <span aria-hidden="true">…</span>;
const ContextRing = ({ usage }: { usage: { used: number; window: number; estimated?: boolean } }) => (
  <span
    className="terminal-chat-context"
    title={`${usage.used.toLocaleString()} of ${usage.window.toLocaleString()} tokens used · ${Math.max(0, usage.window - usage.used).toLocaleString()} free`}
  >
    {Math.round((usage.used / Math.max(usage.window, 1)) * 100)}%
  </span>
);
const Activity = ({ items }: { items: TerminalChatItem[]; live?: boolean }) => <div className="terminal-chat-activity">{items.map((item) => <div key={item.id}>{item.toolName ? `${item.toolName}: ${item.toolOutput ?? item.toolInput ?? ''}` : item.text}</div>)}</div>;

type ModelChoice = { value: string; label: string; hint?: string };
type EffortChoice = { value: string; label: string };

/**
 * Model and reasoning pills. The list is searchable, because a provider can
 * report dozens of models, and it filters before scrolling as Orca's does.
 */
function ModelMenu(props: {
  modelLabel: string; disabled?: boolean; title?: string; models: ModelChoice[]; model: string | null; onModel: (value: string) => void;
  efforts: EffortChoice[]; effort: string | null; onEffort: (value: string) => void;
}) {
  const [open, setOpen] = useState<'model' | 'effort' | null>(null);
  const [query, setQuery] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const shown = filterModels(props.models, query);
  const current = props.models.find((model) => model.value === props.model);
  const currentEffort = props.efforts.find((effort) => effort.value === props.effort);
  return (
    <div className="terminal-chat-model-menu" ref={menuRef}>
      {props.models.length > 1 && (
        <>
          <button
            type="button"
            className={`terminal-chat-pill${open === 'model' ? ' open' : ''}`}
            title={props.title ?? 'Model'}
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open === 'model'}
            onClick={() => setOpen((value) => (value === 'model' ? null : 'model'))}
          >
            <span className="terminal-chat-pill-label">{current?.label ?? props.modelLabel}</span>
          </button>
          {open === 'model' && (
            <div className="terminal-chat-menu tcr-model-menu" role="menu">
              <input
                className="tcr-model-search"
                autoFocus
                value={query}
                placeholder="Search models…"
                aria-label="Search models"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') { event.preventDefault(); setOpen(null); }
                }}
              />
              <div className="tcr-model-list">
                {shown.map((model) => (
                  <button
                    key={model.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={model.value === props.model}
                    className={`terminal-chat-menu-item${model.value === props.model ? ' selected' : ''}`}
                    onClick={() => { props.onModel(model.value); setOpen(null); }}
                  >
                    <span className="terminal-chat-menu-label">{model.label}</span>
                    {model.hint && <span className="terminal-chat-menu-hint">{model.hint}</span>}
                  </button>
                ))}
                {!shown.length && <div className="tcr-muted tcr-model-empty">No model matches “{query}”.</div>}
              </div>
            </div>
          )}
        </>
      )}
      {props.efforts.length > 0 && (
        <>
          <button
            type="button"
            className={`terminal-chat-pill${open === 'effort' ? ' open' : ''}`}
            title="Reasoning effort"
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open === 'effort'}
            onClick={() => setOpen((value) => (value === 'effort' ? null : 'effort'))}
          >
            <span className="terminal-chat-pill-label">{currentEffort?.label ?? 'Effort'}</span>
          </button>
          {open === 'effort' && (
            <div className="terminal-chat-menu tcr-model-menu" role="menu">
              {props.efforts.map((effort) => (
                <button
                  key={effort.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={effort.value === props.effort}
                  className={`terminal-chat-menu-item${effort.value === props.effort ? ' selected' : ''}`}
                  onClick={() => { props.onEffort(effort.value); setOpen(null); }}
                >
                  <span className="terminal-chat-menu-label">{effort.label}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function useStructuredChat(sessionId: number, agent: string | null) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeStructuredChat(agent, bump), [agent]);
  return getStructuredChat(agent, sessionId);
}

type Block =
  | { type: 'user'; item: TerminalChatItem }
  | { type: 'assistant'; item: TerminalChatItem }
  | { type: 'notice'; item: TerminalChatItem }
  | { type: 'activity'; id: string; items: TerminalChatItem[] };

/** Each run of tool calls and thinking folds under the message before it, as in Orca. */
function toBlocks(items: TerminalChatItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.kind === 'user') blocks.push({ type: 'user', item });
    else if (item.kind === 'assistant') blocks.push({ type: 'assistant', item });
    else if (item.kind === 'notice') blocks.push({ type: 'notice', item });
    else {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'activity') last.items.push(item);
      else blocks.push({ type: 'activity', id: item.id, items: [item] });
    }
  }
  return blocks;
}

/** A stable key per block, for the "New" marker. */
function blockKeyOf(block: Block): string {
  return block.type === 'activity' ? `x:${block.id}` : `${block.type[0]}:${block.item.id}`;
}

/**
 * Providers report a tool's arguments as `toolData` (Claude) or as raw JSON / a
 * patch string in `toolInput` (Codex, the ACP agents). The diff and pull-request
 * helpers read `toolData`, so fill it in where the provider only sent text.
 */
function withToolData(item: TerminalChatItem): TerminalChatItem {
  if (item.kind !== 'tool' || item.toolData != null) return item;
  const raw = item.toolInput?.trim();
  if (!raw) return item;
  if (/^\*\*\* (Add|Update|Delete) File:/.test(raw) || raw.startsWith('*** Begin Patch')) {
    return { ...item, toolData: { patch: raw } };
  }
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...item, toolData: parsed };
    } catch {
      return item;
    }
  }
  return item;
}

/** A locally added row: command output or an answered approval. */
interface LocalRow { id: string; text: string; kind: 'output' | 'error' | 'receipt' }

interface ComposerAttachment { id: number; path: string; name: string; preview: string | null }
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

const ACCESS_LABELS: Record<StructuredAccess, { label: string; hint: string }> = {
  ask: { label: 'Ask', hint: 'Works in this folder and asks before anything outside it' },
  auto: { label: 'Auto', hint: 'Works in this folder without stopping to ask' },
  'full-access': { label: 'Full access', hint: 'No sandbox and no questions' },
};

export default function StructuredChatView({ sessionId, cwd, agentLabel }: { sessionId: number; cwd: string; agentLabel?: string }) {
  const agent = useStructuredChatPane(sessionId);
  const provider = structuredChatProvider(agent);
  const label = agentLabel ?? provider?.label ?? 'agent';
  const state = useStructuredChat(sessionId, agent);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [accessOpen, setAccessOpen] = useState(false);
  // Settings > Chat: the same appearance, spellcheck and scroll rules the
  // terminal-backed chat follows.
  const appearance = useStore(chatAppearance);
  const spellcheck = useStore(chatComposerSpellcheck);
  const scrollOnSend = useStore(chatScrollToLatestOnSend);
  const timestamps = useStore(chatShowTimestamps);
  const linkPreviews = useStore(chatLinkPreviews);
  const markNew = useStore(chatMarkNewMessages);
  const turnDiffs = useStore(chatTurnDiffs);
  const pullRequests = useStore(chatPullRequests);
  const ciLines = useStore(chatCiLines);
  const suggestedPrompts = useStore(chatSuggestedPrompts);
  const autoContinue = useStore(chatUsageAutoContinue);
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const openViewer = useCallback((images: string[], index: number) => {
    setViewer({ images: images.map((src, i) => ({ src, name: `Image ${i + 1}` })), index });
  }, []);
  // A visual's own "hand this back to the agent" button puts its text in the
  // draft; it is never sent on its own.
  const composeFromVisual = useCallback((text: string) => {
    setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Images the composer sends with the next message. Agents read them by path,
  // the same way a dropped file is attached.
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentIdRef = useRef(0);

  function addAttachment(attachment: Omit<ComposerAttachment, 'id'>) {
    const id = ++attachmentIdRef.current;
    setAttachments((list) => [...list, { ...attachment, id }]);
  }

  function removeAttachment(id: number) {
    setAttachments((list) => list.filter((attachment) => attachment.id !== id));
  }

  // Images are attached as paths the agent can read; other files go into the
  // draft as paths, as Orca does when you drop them on the pane.
  async function attachFiles() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: true, directory: false });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(String);
      if (!paths.length) return;
      const images = paths.filter((path) => IMAGE_FILE.test(path));
      const others = paths.filter((path) => !IMAGE_FILE.test(path));
      for (const path of images) {
        const preview = await invoke<string>('chat_image_preview', { path }).catch(() => null);
        addAttachment({ path, name: path.split(/[\\/]/).pop() ?? path, preview });
      }
      if (others.length) {
        const quoted = others.map((path) => (/\s/.test(path) ? `"${path}"` : path)).join(' ');
        setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${quoted} ` : `${quoted} `));
      }
    } catch (err) {
      addRow('error', err instanceof Error ? err.message : 'Could not attach those files.');
    } finally {
      textareaRef.current?.focus();
    }
  }

  // A pasted image is saved to disk (the agent gets its path) and shown as a
  // chip; text pastes are left to the textarea.
  async function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
    const fromItems = files.length
      ? []
      : Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
    const images = files.length ? files : fromItems;
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    for (const file of images) {
      try {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const name = file.name && IMAGE_FILE.test(file.name) ? file.name : `pasted-image-${Date.now()}.${ext}`;
        const path = await invoke<string>('save_pasted_image', { name, data: Array.from(new Uint8Array(await file.arrayBuffer())) });
        const preview = await invoke<string>('chat_image_preview', { path }).catch(() => null);
        addAttachment({ path, name, preview });
      } catch (err) {
        addRow('error', err instanceof Error ? err.message : 'Could not save the pasted image.');
      }
    }
  }

  const queue = useQueue(sessionId);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickRef = useRef(true);
  // The transcript's scroll and thread elements, for find, the rail and quoting.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [threadEl, setThreadEl] = useState<HTMLElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const bottomCountRef = useRef(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [pendingSend, setPendingSend] = useState<{ text: string; images: string[] } | null>(null);
  const [failedSend, setFailedSend] = useState<{ text: string; error: string; attachments: ComposerAttachment[] } | null>(null);
  const [pendingCompact, setPendingCompact] = useState(false);
  // A message the app was still sending when it closed, if it never arrived.
  const [uncertainSend, setUncertainSend] = useState<string | null>(null);
  const inflightSendKey = `spacron_structured_inflight_${sessionId}`;
  const restoredDraft = useRef(false);

  // The conversation from before the chat took over (the terminal CLI's
  // transcript), then the live one.
  const history = useStructuredChatHistory(sessionId);
  const live = state?.items ?? [];
  const items = useMemo(() => (history.length ? [...history, ...live] : live), [history, live]);
  const blocks = useMemo(() => toBlocks(items), [items]);
  // Tool rows are normalized once, so the diff and pull-request surfaces work
  // for providers that only send their arguments as text.
  const diffBlocks = useMemo(
    () => blocks.map((block) => (block.type === 'activity' ? { ...block, items: block.items.map(withToolData) } : block)),
    [blocks],
  );
  const working = state?.status === 'working';
  const ready = state?.status === 'ready' || working;

  // Each agent turn's file changes, shown under the turn's last block.
  const turnRollups = useMemo(() => {
    const out = new Map<number, TerminalChatItem[]>();
    let turn: TerminalChatItem[] = [];
    diffBlocks.forEach((block, index) => {
      if (block.type === 'user') turn = [];
      else if (block.type === 'activity') turn.push(...block.items);
      const next = diffBlocks[index + 1];
      if ((!next || next.type === 'user') && turn.length) out.set(index, turn);
    });
    return out;
  }, [diffBlocks]);

  // Blocks that arrive while the reader is scrolled up or the window is hidden
  // get the "New" line above the first of them (Settings > Chat).
  const seenBlocksRef = useRef<number | null>(null);
  const [newMarker, setNewMarker] = useState<string | null>(null);
  useEffect(() => {
    const seen = seenBlocksRef.current;
    seenBlocksRef.current = diffBlocks.length;
    if (seen == null || diffBlocks.length <= seen) return;
    if (stickRef.current && !document.hidden) return;
    const fresh = diffBlocks.slice(seen).filter((block) => block.type !== 'user');
    if (!fresh.length) return;
    if (markNew) setNewMarker((current) => current ?? blockKeyOf(fresh[0]));
  }, [diffBlocks, markNew]);

  // Settings > Chat > usage limits: continue once the limit has reset.
  const usageLimit = useMemo(() => (ready && !working ? trailingUsageLimit(items) : null), [items, working, ready]);
  const continuedLimitsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!usageLimit || !autoContinue || !usageLimit.resetsAt || !agent) return undefined;
    if (continuedLimitsRef.current.has(usageLimit.id)) return undefined;
    const wait = Math.max(0, usageLimit.resetsAt + 60_000 - Date.now());
    const timer = setTimeout(() => {
      continuedLimitsRef.current.add(usageLimit.id);
      void sendStructuredChat(agent, sessionId, 'Continue where you left off.');
    }, Math.min(wait, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [usageLimit?.id, usageLimit?.resetsAt, autoContinue, agent, sessionId]);

  // Settings > Chat > link previews, on the shared Markdown renderer.
  const [hoverLink, setHoverLink] = useState<{ url: string; rect: DOMRect } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLinkHover = useCallback((url: string, rect: DOMRect | null) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (!linkPreviews) return;
    hoverTimerRef.current = setTimeout(() => setHoverLink(rect ? { url, rect } : null), rect ? 380 : 220);
  }, [linkPreviews]);
  const keepHoverCard = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  // Follow the conversation while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, state?.approvals.length, working]);

  // Ctrl/Cmd+F finds in the conversation, and Ctrl+End jumps to the latest.
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
      }
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, []);

  // A question card is answerable from the keyboard: 1…9 picks that option,
  // unless the user is typing in a field (the composer keeps its own keys).
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const card = state?.approvals.find((approval) => approval.options?.length);
      if (!card?.options) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= card.options.length) return;
      event.preventDefault();
      event.stopPropagation();
      answerApprovalOption(card, card.options[index]);
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [state?.approvals]);

  // An unsent draft stays with the pane across a reload, as on the terminal side.
  useEffect(() => {
    if (restoredDraft.current) return;
    restoredDraft.current = true;
    try {
      const saved = localStorage.getItem(structuredDraftKey(sessionId));
      if (saved) {
        setDraft(saved);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    } catch {
      // Storage can be unavailable; the composer still works.
    }
  }, [sessionId]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const keep = draftToPersist(draft);
        if (keep) localStorage.setItem(structuredDraftKey(sessionId), keep);
        else localStorage.removeItem(structuredDraftKey(sessionId));
      } catch {
        // Nothing to keep, nothing to do.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, sessionId]);

  // A send that was in flight when the app closed may never have arrived: say
  // so once, and let the user send it again. Only a message with no matching
  // turn in the restored transcript is reported.
  const restoredInflight = useRef(false);
  useEffect(() => {
    if (restoredInflight.current) return;
    restoredInflight.current = true;
    try {
      const raw = localStorage.getItem(inflightSendKey);
      if (!raw) return;
      localStorage.removeItem(inflightSendKey);
      const saved = JSON.parse(raw) as { text?: string; at?: number };
      if (!saved.text || !saved.at || Date.now() - saved.at < 1500) return;
      const arrived = (agent ? getStructuredChat(agent, sessionId)?.items ?? [] : [])
        .some((item) => item.kind === 'user' && item.text === saved.text);
      if (!arrived) setUncertainSend(saved.text);
    } catch {
      // Nothing was in flight, or storage is unavailable.
    }
  }, [sessionId]);

  const openPath = useCallback((path: string) => {
    const absolute = /^([A-Za-z]:[\\/]|\/)/.test(path) ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`;
    void openFile(absolute);
  }, [cwd]);
  const richContext = useMemo<RichContextValue>(() => ({
    onLinkHover,
    cwd,
    parentSessionId: String(sessionId),
    diffs: turnDiffs,
    onOpenFile: openPath,
    renderNested: (nested?: TerminalChatItem[]) => {
      if (!nested?.length) return null;
      return (
        <div className="terminal-chat-nested-thread">
          {nested.map((item) => (
            <div key={item.id} className={`terminal-chat-nested-item kind-${item.kind}`}>
              {item.kind === 'user' ? (
                <div className="terminal-chat-user">{item.text}</div>
              ) : item.kind === 'assistant' ? (
                <Markdown text={item.text} onOpenImage={() => {}} />
              ) : (
                <div className="terminal-chat-activity-item">
                  {item.toolName ? `${item.toolName}: ${item.toolOutput ?? item.toolInput ?? ''}` : item.text}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    },
  }), [cwd, openPath, sessionId, onLinkHover, turnDiffs]);

  // Where this chat's agent writes inline visuals (prepared at launch).
  const visualsSpot = structuredVisualsSpot(sessionId);
  const models = state?.models ?? [];
  const current = models.find((m) => m.id === state?.model) ?? null;
  const modelLabel = current?.label ?? (state?.status === 'starting' ? 'Loading models…' : 'Default model');
  const capabilities = providerCapabilities(agent);
  const supportedAccess = capabilities?.supportedAccessModes ?? (['ask', 'auto', 'full-access'] as StructuredAccess[]);
  const subagents = useMemo(() => {
    return agent ? getStructuredSubagents(agent, sessionId) : (state?.subagents ?? []);
  }, [agent, sessionId, state?.subagents]);

  const [subagentList, setSubagentList] = useState<StructuredSubagentSession[]>(subagents);
  useEffect(() => {
    if (!agent) return;
    setSubagentList(getStructuredSubagents(agent, sessionId));
    return subscribeStructuredSubagents(sessionId, () => {
      setSubagentList(getStructuredSubagents(agent, sessionId));
    });
  }, [agent, sessionId]);

  const displaySubagents = subagentList.length > 0 ? subagentList : subagents;

  const [showCreateSubagent, setShowCreateSubagent] = useState(false);
  const [subagentPreset, setSubagentPreset] = useState('');
  const [subagentPrompt, setSubagentPrompt] = useState('');
  const [isSpawningSubagent, setIsSpawningSubagent] = useState(false);

  const availablePresets = useMemo(() => {
    const roster = getAgentRoster();
    if (roster.length > 0) return roster;
    return [
      { command: 'claude', name: 'Claude Code' },
      { command: 'codex', name: 'Codex' },
      { command: 'antigravity', name: 'Antigravity' },
      { command: 'pi', name: 'Pi' },
    ];
  }, []);

  async function handleSpawnSubagent() {
    const prompt = subagentPrompt.trim();
    if (!prompt || isSpawningSubagent || !agent) return;
    setIsSpawningSubagent(true);
    try {
      const preset = subagentPreset || availablePresets[0]?.command || 'claude';
      await spawnStructuredSubagent(agent, sessionId, prompt, { agent: preset });
      setSubagentPrompt('');
      setShowCreateSubagent(false);
      setSubagentList(getStructuredSubagents(agent, sessionId));
    } catch (err) {
      console.error('[StructuredChatView] Failed to spawn subagent:', err);
    } finally {
      setIsSpawningSubagent(false);
    }
  }

  // Automatically send the next queued message once the turn finishes and agent is ready.
  useEffect(() => {
    if (working || !ready || !agent || queue.length === 0) return;
    const next = shiftQueue(sessionId);
    if (!next) return;
    void sendStructuredChat(agent, sessionId, next.text, (next.images ?? []).map((img) => img.path));
  }, [working, ready, agent, queue.length, sessionId]);

  // A `/compact` typed mid-turn waits in line instead of being refused.
  useEffect(() => {
    if (!pendingCompact) return;
    if (working || !ready || !agent) return;
    setPendingCompact(false);
    void runStructuredCommand(agent, sessionId, '/compact').then((result) => {
      if (result.output) addRow('output', result.output);
      if (result.error) addRow('error', result.error);
    });
  }, [pendingCompact, working, ready, agent, sessionId]);

  function addRow(kind: LocalRow['kind'], text: string) {
    setRows((list) => [...list, { id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, text }]);
  }

  function quoteIntoComposer(text: string) {
    setDraft((current) => `${current.trim() ? `${current.replace(/\s+$/, '')}\n\n` : ''}${quoteAsBlockquote(text)}\n\n`);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    });
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickRef.current = true;
    setAtBottom(true);
    bottomCountRef.current = items.length;
  }

  /**
   * Send one message, with the "Sending…" and "Not sent" states around it. The
   * in-flight marker outlives a crash: on the next start a message that may
   * never have arrived is offered again instead of disappearing.
   */
  async function deliver(text: string, sentAttachments: ComposerAttachment[] = []) {
    if (!agent) return;
    setPendingSend({ text, images: sentAttachments.flatMap(({ preview }) => preview ? [preview] : []) });
    setFailedSend(null);
    setUncertainSend(null);
    try { localStorage.setItem(inflightSendKey, JSON.stringify({ text, at: Date.now() })); } catch { /* nothing to remember */ }
    try {
      await sendStructuredChat(agent, sessionId, text, sentAttachments.map(({ path }) => path));
      setNewMarker(null);
    } catch (err) {
      setFailedSend({ text, attachments: sentAttachments, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setPendingSend(null);
      // Cleared either way: a failure already has its own "Not sent" row.
      try { localStorage.removeItem(inflightSendKey); } catch { /* nothing saved */ }
    }
  }

  const prompts = useMemo(() => promptHistoryOf(items), [items]);

  // ── Composer menus: `/` commands and skills, `$` skills (Codex), `@` files ──
  const slash = ready ? slashQuery(draft) : null;
  // Codex invokes a skill by mentioning it as `$name` anywhere in the prompt.
  const dollar = !slash && ready && agent === 'codex' ? tokenAt(draft, caret, '$') : null;
  const mention = !slash && !dollar && ready && cwd ? mentionAt(draft, caret) : null;
  const menuKey = slash != null ? `/${slash}` : dollar ? `$${dollar.start}:${dollar.query}` : mention ? `@${mention.start}:${mention.query}` : null;

  // The agent's skills and custom commands, re-read whenever the menu opens.
  const [skills, setSkills] = useState<ChatSkillEntry[]>(() => (agent && cwd ? peekSkills(agent, cwd) : []));
  const skillMenuOpen = slash != null || dollar != null;
  useEffect(() => {
    if (!agent || !cwd || (!skillMenuOpen && skills.length)) return undefined;
    let cancelled = false;
    void loadSkills(agent, cwd).then((list) => { if (!cancelled) setSkills(list); });
    return () => { cancelled = true; };
  }, [agent, cwd, skillMenuOpen]);

  const commandMatches = useMemo((): ComposerSuggestion[] => {
    if (!agent) return [];
    if (dollar) {
      return rankByName(skills.filter((skill) => skill.name.startsWith('$')), dollar.query, (skill) => skill.name.slice(1))
        .map((skill) => ({ kind: 'skill' as const, skill }));
    }
    if (slash == null) return [];
    // The chat runs its own commands itself; everything else the CLI owns is
    // offered too and sent through, so `/init` or `/goal` reach the agent.
    const cliRows = slashCommandsFor(agent as Parameters<typeof slashCommandsFor>[0]).filter((command) => !command.opensInTerminal);
    const commandRows: SlashCommand[] = [
      ...STRUCTURED_COMMANDS,
      ...STRUCTURED_PASSTHROUGH,
      ...cliRows.filter((command) => !STRUCTURED_COMMANDS.some((own) => own.name === command.name)
        && !STRUCTURED_PASSTHROUGH.some((own) => own.name === command.name)),
    ];
    const builtins = rankByName(commandRows, slash, (command) => command.name.slice(1))
      .map((command) => ({ kind: 'command' as const, command }));
    const custom = rankByName(skills.filter((skill) => skill.kind !== 'builtin'), slash, (skill) => skill.name.replace(/^[/$]/, ''));
    return [
      ...builtins,
      ...custom.filter((skill) => skill.kind === 'skill').map((skill) => ({ kind: 'skill' as const, skill })),
      ...custom.filter((skill) => skill.kind === 'command').map((skill) => ({ kind: 'skill' as const, skill })),
    ];
  }, [slash, dollar?.query, agent, skills]);

  const [fileMatches, setFileMatches] = useState<string[]>([]);
  useEffect(() => {
    if (!mention || !cwd) {
      setFileMatches([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<string[]>('chat_list_files', { root: cwd, query: mention.query, limit: 20 })
        .then((list) => { if (!cancelled) setFileMatches(list); })
        .catch(() => { if (!cancelled) setFileMatches([]); });
    }, 110);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention?.query, mention?.start, cwd]);

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
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function send() {
    const text = draft.trim();
    if ((!text && !attachments.length) || !ready) return;
    if (working) {
      setAttachments([]);
      if (capabilities?.steering === 'inject' && agent) {
        setDraft('');
        if (scrollOnSend) stickRef.current = true;
        await steerStructuredChat(agent, sessionId, text, attachments.map(({ path }) => path));
      } else {
        enqueue(sessionId, text, attachments.map(({ path, preview }) => ({ path, preview })));
        setDraft('');
      }
      return;
    }
    setDraft('');
    setHistoryAt(null);
    if (scrollOnSend) stickRef.current = true;
    if (agent) {
      if (text.startsWith('/')) {
        setAttachments([]);
        const lastUser = [...items].reverse().find((item) => item.kind === 'user')?.text ?? null;
        const result = await runStructuredCommand(agent, sessionId, text, { lastUserMessage: lastUser });
        if (result.handled) {
          if (result.defer === 'compact') setPendingCompact(true);
          if (result.output) addRow('output', result.output);
          if (result.error) addRow('error', result.error);
          if (/^\/(clear|new)\b/.test(text) && !result.error) {
            setRows([]);
            try { localStorage.removeItem(structuredDraftKey(sessionId)); } catch { /* nothing saved */ }
          }
          textareaRef.current?.focus();
          return;
        }
      }
      setAttachments([]);
      await deliver(text, attachments);
    }
    textareaRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    event.stopPropagation();
    if (suggestions.length && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((index) => (index + delta + suggestions.length) % suggestions.length);
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
    if (event.key === 'ArrowUp' && (historyAt != null || !draft.trim()) && prompts.length) {
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
      void send();
    } else if (event.key === 'Escape' && working && !draft) {
      event.preventDefault();
      if (agent) void interruptStructuredChat(agent, sessionId);
    }
  }

  function answerApproval(
    requestId: string | number,
    title: string,
    decision: 'accept' | 'acceptForSession' | 'decline',
    option?: StructuredApprovalOption,
  ) {
    if (!agent) return;
    const wording = option
      ? `Chose “${option.label}”`
      : decision === 'accept' ? 'Allowed once' : decision === 'acceptForSession' ? 'Allowed for this chat' : 'Declined';
    addRow('receipt', `${wording}: ${title}`);
    void answerStructuredChatApproval(agent, sessionId, requestId, decision, option?.id);
  }

  /** Answer a question card with one of the options the agent itself offered. */
  function answerApprovalOption(approval: { requestId: string | number; title: string }, option: StructuredApprovalOption) {
    const decision = /reject|cancel|deny|declin/i.test(`${option.kind ?? ''} ${option.id}`) ? 'decline' : 'accept';
    answerApproval(approval.requestId, approval.title, decision, option);
  }

  function rewriteDraft(text: string) {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
      setCaret(text.length);
    });
  }

  async function forkHere() {
    const forked = await forkStructuredSession(sessionId);
    if (forked) addRow('receipt', `Forked into “${forked.title}”. Resume it with /resume ${forked.id}.`);
    else addRow('error', 'Could not fork this conversation.');
  }

  async function rewindTo(item: TerminalChatItem) {
    const ok = await rewindStructuredSession(sessionId, { turnId: item.id });
    if (!ok) {
      addRow('error', 'Could not rewind this conversation.');
      return;
    }
    rewriteDraft(item.text);
    addRow('receipt', 'Rewound to before this message; it is back in the composer. Files on disk are unchanged.');
  }

  const lastBlock = diffBlocks[diffBlocks.length - 1];
  const access = state?.access ?? 'ask';
  const lastAssistantIndex = useMemo(() => {
    for (let index = diffBlocks.length - 1; index >= 0; index -= 1) if (diffBlocks[index].type === 'assistant') return index;
    return -1;
  }, [diffBlocks]);
  const lastUserIndex = useMemo(() => {
    for (let index = diffBlocks.length - 1; index >= 0; index -= 1) if (diffBlocks[index].type === 'user') return index;
    return -1;
  }, [diffBlocks]);
  const userTurns = useMemo(
    () => blocks.filter((block): block is { type: 'user'; item: TerminalChatItem } => block.type === 'user').map((block) => ({ id: block.item.id, text: block.item.text })),
    [blocks],
  );
  const todos = useMemo(() => latestTodos(items), [items]);
  const showTodos = Boolean(todos?.length) && (working || todos!.some((todo) => todo.status !== 'completed'));
  const canRewind = Boolean(capabilities && capabilities.rewindMode !== 'none') && !working && ready;
  const canFork = Boolean(capabilities?.fork) && !working && ready;
  const unread = atBottom ? 0 : Math.max(0, items.length - bottomCountRef.current);

  // How long this turn has been running. Only shown while Orca-style "working"
  // state is observed, so an unknown duration is never guessed.
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (working) setTurnStart((start) => start ?? Date.now());
    else setTurnStart(null);
  }, [working]);
  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const elapsed = working && turnStart ? Math.max(0, Math.round((clock - turnStart) / 1000)) : null;

  return (
    <RichContext.Provider value={richContext}>
      <div
        ref={viewRef}
        className="terminal-chat-view structured-chat-view"
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
        data-timestamps={timestamps ? '' : undefined}
        data-match-terminal={appearance.matchTerminal ? '' : undefined}
        data-contrast={appearance.contrast !== 100 ? '' : undefined}
        data-chat-font={appearance.font === 'app' ? undefined : appearance.font === 'system' || appearance.font === 'terminal' ? appearance.font : 'custom'}
        data-chat-font-size={appearance.fontSize == null ? undefined : 'set'}
        style={{
          '--tc-col': CHAT_WIDTH_COLUMN[appearance.width],
          '--tc-code-size': `${appearance.codeFontSize}px`,
          '--tc-font-family': `"${appearance.font}", system-ui, sans-serif`,
          ...contrastVars(appearance.contrast, appearance.matchTerminal),
          ...(appearance.fontSize == null ? {} : { '--tc-font-size': `${appearance.fontSize}px` }),
        } as React.CSSProperties}
      >
        {findOpen && <FindBar root={threadEl} revision={items} onClose={() => { setFindOpen(false); textareaRef.current?.focus(); }} />}
        <SelectionQuote container={scrollEl} onQuote={quoteIntoComposer} />
        <div className="terminal-chat-transcript">
        <MessageRail scroller={scrollEl} turns={userTurns} revision={items} />
        <div
          className="terminal-chat-scroll"
          ref={(el) => { scrollRef.current = el; if (el !== scrollEl) setScrollEl(el); }}
          onScroll={(event) => {
            const el = event.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            stickRef.current = bottom;
            setAtBottom(bottom);
            if (bottom) bottomCountRef.current = items.length;
          }}
        >
          <div className="terminal-chat-thread" ref={(el) => { if (el !== threadEl) setThreadEl(el); }}>
            {state?.status === 'starting' && !items.length && (
              <div className="terminal-chat-working"><Dots /><span>Starting {label}</span></div>
            )}
            {state?.status === 'ready' && !items.length && (
              <div className="tcr-empty">
                <span>Start a chat with {label}. Pick any model and reasoning level below.</span>
                {suggestedPrompts && (
                  <SuggestedPrompts onPick={(text) => {
                    setDraft(text);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }} />
                )}
              </div>
            )}
            {diffBlocks.map((block, index) => {
              const key = blockKeyOf(block);
              const marker = newMarker === key ? <NewMessagesLine key={`new-${key}`} /> : null;
              const rollup = turnDiffs ? turnRollups.get(index) : undefined;
              const files = rollup ? rollupChanges(rollup) : [];
              const changes = files.length ? (
                <TurnChanges
                  key={`changes-${key}`}
                  files={files}
                  changesFor={(path) => rollup!.filter((item) => item.toolStatus !== 'running').flatMap((item) => fileChangesFor(item)).filter((change: FileChange) => change.path === path)}
                  onOpen={openPath}
                />
              ) : null;
              let body: React.ReactNode;
              if (block.type === 'user') {
                body = (
                  <div key={key} className="tcr-msg user" data-turn-id={block.item.id}>
                    <UserTurn text={block.item.text} images={block.item.images ?? []} onOpenImage={openViewer} />
                    <MessageActions
                      align="end"
                      text={block.item.text}
                      time={itemTime(block.item.time)}
                      canResend={ready && !working && !pendingSend}
                      onResend={async (text) => {
                        if (!ready || working || pendingSend) return false;
                        if (scrollOnSend) stickRef.current = true;
                        await deliver(text);
                      }}
                      onRewind={canRewind && index === lastUserIndex ? () => void rewindTo(block.item) : undefined}
                    />
                  </div>
                );
              } else if (block.type === 'assistant') {
                const segments = splitReply(block.item.text);
                body = (
                  <div key={key} className="tcr-msg">
                    <div className="terminal-chat-agent">
                      {segments.map((segment, segmentIndex) => segment.type === 'visual' ? (
                        <ChatVisual
                          key={`${key}-visual-${segmentIndex}`}
                          visual={segment.visual}
                          spot={visualsSpot}
                          onCompose={composeFromVisual}
                        />
                      ) : (
                        <Markdown key={`${key}-text-${segmentIndex}`} text={segment.text} onOpenImage={openViewer} />
                      ))}
                    </div>
                    <MessageActions
                      text={visualReplyText(segments)}
                      replyId={`structured:${sessionId}:${block.item.id}`}
                      time={itemTime(block.item.time)}
                      onFork={canFork && index === lastAssistantIndex ? () => void forkHere() : undefined}
                    />
                  </div>
                );
              } else if (block.type === 'notice') {
                body = <div key={key} className="terminal-chat-notice">{block.item.text}</div>;
              } else {
                const prs = pullRequests ? [...new Set(block.items.flatMap(openedPullRequests))] : [];
                body = (
                  <div key={key} className="terminal-chat-agent">
                    <Activity items={block.items} live={working && block === lastBlock} />
                    {prs.map((url) => <PullRequestCard key={url} url={url} ciLines={ciLines} />)}
                  </div>
                );
              }
              return marker || changes ? [marker, body, changes] : body;
            })}
            {pendingSend && <UserTurn text={pendingSend.text} images={pendingSend.images} onOpenImage={openViewer} pending />}
            {failedSend && (
              <div className="tcr-command-notice" role="alert">
                <span>Not sent: {failedSend.error}</span>
                <button type="button" className="tcr-link-btn" onClick={() => void deliver(failedSend.text, failedSend.attachments)}>Retry</button>
              </div>
            )}
            {uncertainSend && (
              <div className="tcr-command-notice" role="alert">
                <span>This message may not have reached {label} when the app closed:</span>
                <span className="tcr-uncertain-text">{uncertainSend}</span>
                <button type="button" className="tcr-link-btn" onClick={() => { const text = uncertainSend; setUncertainSend(null); void deliver(text); }}>Send again</button>
                <button type="button" className="tcr-link-btn" onClick={() => setUncertainSend(null)}>Dismiss</button>
              </div>
            )}
            {rows.map((row) => (
              row.kind === 'output' ? <CommandOutput key={row.id} text={row.text} />
                : <div key={row.id} className={row.kind === 'error' ? 'terminal-chat-error' : 'tcr-command-notice'}>{row.text}</div>
            ))}
            {state?.approvals.map((approval) => (
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
                        onClick={() => answerApprovalOption(approval, option)}
                      >
                        <kbd>{optionIndex + 1}</kbd>
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <button type="button" className="tcr-link-btn" onClick={() => answerApproval(approval.requestId, approval.title, 'accept')}>Allow</button>
                    <button type="button" className="tcr-link-btn" onClick={() => answerApproval(approval.requestId, approval.title, 'acceptForSession')}>Allow for this chat</button>
                    <button type="button" className="tcr-link-btn" onClick={() => answerApproval(approval.requestId, approval.title, 'decline')}>Decline</button>
                  </>
                )}
              </div>
            ))}
            {(displaySubagents.length > 0 || showCreateSubagent) && (
              <div className="structured-chat-subagents-panel" role="region" aria-label="Sub-agents">
                <div className="structured-chat-subagents-header">
                  <div className="structured-chat-subagents-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    <span>Sub-agents ({displaySubagents.length})</span>
                  </div>
                  <button
                    type="button"
                    className="structured-chat-subagent-toggle-btn"
                    onClick={() => setShowCreateSubagent((value) => !value)}
                  >
                    {showCreateSubagent ? 'Close' : '+ New Sub-agent'}
                  </button>
                </div>

                {showCreateSubagent && (
                  <div className="structured-chat-subagent-create-form">
                    <div className="subagent-create-row">
                      <select
                        aria-label="Sub-agent preset"
                        value={subagentPreset || availablePresets[0]?.command || ''}
                        onChange={(event) => setSubagentPreset(event.target.value)}
                        className="subagent-preset-select"
                        disabled={isSpawningSubagent}
                      >
                        {availablePresets.map((preset) => (
                          <option key={preset.command} value={preset.command}>
                            {preset.name} ({preset.command})
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        placeholder="Task assignment for sub-agent..."
                        value={subagentPrompt}
                        disabled={isSpawningSubagent}
                        onChange={(event) => setSubagentPrompt(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void handleSpawnSubagent();
                          }
                        }}
                        className="subagent-prompt-input"
                      />
                      <button
                        type="button"
                        className="subagent-submit-btn"
                        disabled={!subagentPrompt.trim() || isSpawningSubagent}
                        onClick={() => void handleSpawnSubagent()}
                      >
                        {isSpawningSubagent ? 'Spawning…' : 'Spawn'}
                      </button>
                      </div>
                      <small className="subagent-create-hint">
                        {providerOwnsSubagents(agent)
                          ? `${label} runs this child in its own subagent tree.`
                          : `${label} has no subagent protocol here, so Spacron runs the child as its own agent session, isolated in a worktree when this chat has a project.`}
                      </small>
                  </div>
                )}

                <div className="structured-chat-subagents-list">
                  {displaySubagents.map((sub) => (
                    <div key={sub.id} className={`structured-chat-subagent-card status-${sub.status}`}>
                      <div className="subagent-card-head">
                        <div className="subagent-card-title">
                          <strong>{sub.agent}</strong>
                          <span
                            className={`subagent-origin-tag ${sub.origin === 'native' ? 'native' : 'spacron'}`}
                            title={sub.origin === 'native'
                              ? `A ${label} subagent, from the provider's own subagent tree`
                              : 'A separate agent session Spacron started, with its own terminal pane'}
                          >
                            {sub.origin === 'native' ? 'Native' : 'Spacron'}
                          </span>
                          {sub.branch && <span className="subagent-branch-tag">{sub.branch}</span>}
                          <span className={`subagent-status-badge ${sub.status}`}>{sub.status}</span>
                        </div>
                        <div className="subagent-card-actions">
                          {sub.childSessionId != null && (
                            <button
                              type="button"
                              className="subagent-action-btn open-btn"
                              title="Open agent pane on stage"
                              onClick={() => openStructuredSubagent(sub.id)}
                            >
                              Open pane
                            </button>
                          )}
                          {(sub.status === 'running' || sub.status === 'starting' || sub.status === 'needs-input') && (
                            <button
                              type="button"
                              className="subagent-action-btn cancel-btn"
                              title="Cancel sub-agent"
                              onClick={() => agent && void cancelStructuredSubagent(agent, sessionId, sub.id)}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="subagent-card-assignment">{sub.assignment}</div>
                      {sub.output && <pre className="subagent-card-output">{sub.output}</pre>}
                      {sub.exit && <div className="subagent-exit-note">{sub.exit.detail}</div>}
                      {(sub.log?.length ?? 0) > 0 && (
                        <details className="subagent-card-log">
                          <summary>{sub.log!.length} event{sub.log!.length === 1 ? '' : 's'}</summary>
                          <ul>
                            {sub.log!.slice(-6).map((entry, index) => (
                              <li key={`${entry.at}-${index}`}>
                                <span>{new Date(entry.at).toLocaleTimeString()}</span> {entry.kind}{entry.text ? `: ${entry.text}` : ''}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {sub.status === 'needs-input' && (
                        <div className="subagent-card-input">
                          <span className="subagent-question">{sub.question || 'Needs input:'}</span>
                          <div className="subagent-reply-row">
                            <input
                              type="text"
                              placeholder="Type reply and press Enter..."
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && event.currentTarget.value.trim() && agent) {
                                  void answerStructuredSubagent(agent, sessionId, sub.id, event.currentTarget.value.trim());
                                  event.currentTarget.value = '';
                                }
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {working && !state?.approvals.length && lastBlock?.type !== 'activity' && (
              <div className="terminal-chat-working">
                <Dots />
                <span>{label} is working{elapsed != null ? ` · ${elapsed}s` : ''}</span>
              </div>
            )}
            {state?.status === 'failed' && (
              <div className="terminal-chat-error" role="alert">
                <span>{state.error ?? `${label} stopped.`}</span>
                <button type="button" onClick={() => void reconnectStructuredSession(sessionId)}>Reconnect</button>
              </div>
            )}
          </div>
        </div>
          {!atBottom && items.length > 0 && <JumpToLatest unread={unread} onClick={jumpToLatest} />}
        </div>
        <div className="terminal-chat-dock">
          {showTodos && todos && <TodoDock todos={todos} />}
          {state?.error && state.status !== 'failed' && (
            <div className="terminal-chat-error" role="alert"><span>{state.error}</span></div>
          )}
          {usageLimit && (
            <UsageLimitRow
              limit={usageLimit}
              autoContinue={autoContinue}
              onToggleAuto={(on) => chatUsageAutoContinue.set(on)}
              onContinue={() => {
                continuedLimitsRef.current.add(usageLimit.id);
                if (agent) void sendStructuredChat(agent, sessionId, 'Continue where you left off.');
              }}
            />
          )}
          {queue.length > 0 && (
            <QueueCards
              queue={queue}
              onEdit={(id, text) => updateQueued(sessionId, id, text)}
              onDelete={(id) => removeQueued(sessionId, id)}
              onMove={(id, delta) => moveQueued(sessionId, id, delta)}
              onSendNow={async (id) => {
                const message = removeQueued(sessionId, id);
                if (message && agent) {
                  if (capabilities?.steering === 'inject' && working) {
                    await steerStructuredChat(agent, sessionId, message.text);
                  } else {
                    await sendStructuredChat(agent, sessionId, message.text, (message.images ?? []).map((img) => img.path));
                  }
                }
              }}
            />
          )}
          <div className={`terminal-chat-composer${ready ? '' : ' exited'}`}>
            {suggestions.length > 0 && (
              <ComposerMenu
                items={suggestions}
                active={Math.min(menuIndex, suggestions.length - 1)}
                title={slash != null ? `${label} commands and skills` : dollar ? `${label} skills` : 'Files'}
                onHover={setMenuIndex}
                onPick={pickSuggestion}
              />
            )}
            {attachments.length > 0 && (
              <div className="terminal-chat-attachments">
                {attachments.map((attachment, index) => (
                  <div key={attachment.id} className="terminal-chat-attachment" title={attachment.name}>
                    <button
                      type="button"
                      className="terminal-chat-attachment-thumb"
                      aria-label={`Preview ${attachment.name}`}
                      onClick={() => {
                        const previews = attachments.map((item) => item.preview).filter((url): url is string => Boolean(url));
                        if (attachment.preview) openViewer(previews, Math.max(0, previews.indexOf(attachment.preview)));
                      }}
                    >
                      {attachment.preview ? <img src={attachment.preview} alt="" /> : <span className="terminal-chat-attachment-icon">IMG</span>}
                    </button>
                    <button type="button" className="terminal-chat-attachment-remove" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
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
              onPaste={(event) => void onPaste(event)}
              rows={1}
              placeholder={
                !ready
                  ? state?.status === 'failed' ? `${label} isn't running` : `Starting ${label}…`
                  : working
                    ? capabilities?.steering === 'inject'
                      ? `Steer ${label}'s active turn (Enter to inject guidance)`
                      : `Queue follow-up for ${label} (Enter to queue)`
                    : `Message ${label}  ·  / for commands, @ for files, ↑ for earlier prompts`
              }
              disabled={!ready}
              spellCheck={spellcheck}
              onChange={(event) => {
                setDraft(event.target.value);
                setCaret(event.target.selectionStart ?? event.target.value.length);
                if (historyAt != null && event.target.value !== prompts[historyAt]) setHistoryAt(null);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
            />
            <div className="terminal-chat-composer-bar">
              <button
                type="button"
                className="terminal-chat-icon-btn"
                title="Attach images (sent with your message) or files (their paths go into the message)"
                aria-label="Attach files"
                disabled={!ready}
                onClick={() => void attachFiles()}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <div className="terminal-chat-option">
                <button
                  type="button"
                  className={`terminal-chat-pill${accessOpen ? ' open' : ''}`}
                  title={ACCESS_LABELS[access].hint}
                  disabled={working}
                  aria-haspopup="menu"
                  aria-expanded={accessOpen}
                  onClick={() => setAccessOpen((value) => !value)}
                >
                  <span className="terminal-chat-pill-label">{ACCESS_LABELS[access].label}</span>
                </button>
                {accessOpen && (
                  <div className="terminal-chat-menu" role="menu">
                    {(Object.keys(ACCESS_LABELS) as StructuredAccess[]).map((mode) => {
                      const isSupported = supportedAccess.includes(mode);
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="menuitemradio"
                          aria-checked={mode === access}
                          disabled={!isSupported}
                          className={`terminal-chat-menu-item${mode === access ? ' selected' : ''}${!isSupported ? ' disabled' : ''}`}
                          onClick={() => {
                            if (agent && isSupported) {
                              setStructuredChatAccess(agent, sessionId, mode);
                              setAccessOpen(false);
                            }
                          }}
                        >
                          <span className="terminal-chat-menu-label">
                            {ACCESS_LABELS[mode].label}
                            {!isSupported ? ' (Unsupported)' : ''}
                          </span>
                          <span className="terminal-chat-menu-hint">
                            {isSupported ? ACCESS_LABELS[mode].hint : `${label} does not support session-wide ${mode}.`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`terminal-chat-pill subagents-pill${displaySubagents.length > 0 || showCreateSubagent ? ' open' : ''}`}
                title="Sub-agents for this chat"
                onClick={() => setShowCreateSubagent((value) => !value)}
              >
                <span className="terminal-chat-pill-label">Sub-agents{displaySubagents.length > 0 ? ` (${displaySubagents.length})` : ''}</span>
              </button>
              <span className="terminal-chat-bar-spacer" />
              {state?.restoredMode && (
                <span
                  className="terminal-chat-pill"
                  style={{ opacity: 0.8, fontSize: '11px', cursor: 'default' }}
                  title={state.restoredMode === 'native' ? 'Resumed native session' : 'History from Spacron journal'}
                >
                  {state.restoredMode === 'native' ? 'Native' : 'Journal'}
                </span>
              )}
              {state?.contextUsed != null && state.contextWindow != null && (
                <ContextRing usage={{ used: state.contextUsed, window: state.contextWindow, estimated: false }} />
              )}
              <ModelMenu
                modelLabel={modelLabel}
                title={working ? 'Change the model between turns' : 'Model and reasoning (applies to your next message)'}
                disabled={!ready || working || !models.length}
                models={models.map((model) => ({ value: model.id, label: model.label, hint: model.description ?? undefined }))}
                model={current?.id ?? null}
                onModel={(value) => agent && setStructuredChatModel(agent, sessionId, value)}
                efforts={(current?.efforts ?? []).map((effort) => ({ value: effort, label: shortEffort(effort) }))}
                effort={state?.effort ?? null}
                onEffort={(value) => agent && setStructuredChatEffort(agent, sessionId, value)}
              />
              {working && !draft.trim() && !attachments.length ? (
                <button type="button" className="terminal-chat-send stop" title="Stop (Esc)" aria-label="Stop" onClick={() => agent && void interruptStructuredChat(agent, sessionId)}>
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2.2" fill="currentColor" /></svg>
                </button>
              ) : (
                <button
                  type="button"
                  className={`terminal-chat-send${working ? ' steer' : ''}`}
                  title={working ? (capabilities?.steering === 'inject' ? 'Inject guidance (Enter)' : 'Queue follow-up (Enter)') : 'Send (Enter)'}
                  aria-label={working ? (capabilities?.steering === 'inject' ? 'Inject guidance' : 'Queue follow-up') : 'Send'}
                  disabled={(!draft.trim() && !attachments.length) || !ready}
                  onClick={() => void send()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        {hoverLink && linkPreviews && (
          <LinkHoverCard
            url={hoverLink.url}
            rect={hoverLink.rect}
            onEnter={keepHoverCard}
            onLeave={() => onLinkHover(hoverLink.url, null)}
          />
        )}
        {viewer && (
          <ImageViewer images={viewer.images} startIndex={viewer.index} projectRoot={cwd} onClose={() => setViewer(null)} />
        )}
      </div>
    </RichContext.Provider>
  );
}
