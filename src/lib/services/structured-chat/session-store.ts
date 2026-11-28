/**
 * Durable structured chat sessions (Orca-style session identity).
 *
 * `structuredChatPanes` (panes.ts) stays the view cache: which pane shows which
 * provider right now. This module is the source of truth that outlives a pane:
 * a record per conversation with a stable Spacron id, its native provider id,
 * cwd, project, settings and handoff lineage, plus a normalized event journal
 * (`event-journal.ts`) recorded from provider state changes.
 *
 * It watches the pane map instead of being called by each launcher, so every
 * way of opening a structured chat (quick spawn, Continue in chat, handoff,
 * restore) gets a record without each call site knowing about it.
 *
 * After an app restart, open records whose pane was a pure chat (not a CLI
 * pane switched into chat; the workspace restore relaunches those as CLIs) are
 * reopened by `restoreStructuredSessions`, resuming the native conversation and
 * showing the journaled history above it.
 */
import type { AskAnswer } from './ask';
import { buildSideChatContext, clearPaneContext, setPaneContext } from '$lib/services/side-chat-context';
import { get, writable } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import { idbAvailable, idbDelete, idbGet, idbSet } from '$lib/services/idb-kv';
import {
  createTerminalSession,
  getActiveTerminalProjectId,
  allProjectSessions,
  getSessionRoot,
  sessions,
  updateSessionTitle,
} from '$lib/stores/terminal';
import {
  markStructuredChatPane,
  isNewStructuredChatPane,
  setStructuredChatHistory,
  structuredChatHistory,
  structuredChatPanes,
  structuredChatPreset,
  type StructuredChatAgent,
} from './panes';
import { structuredChatProvider } from './registry';
import { structuredAccessFor } from './defaults';
import { rememberModelCatalog } from './model-catalog';
import { accountsState, activeAccount } from '$lib/stores/agentAccounts';
import { chatAutoNames, chatModelNames } from '$lib/stores/chatViewSettings';
import type { StructuredAccess, StructuredChatState, StructuredSubagentSession } from './provider';
import {
  StructuredEventJournal,
  diffStructuredState,
  journalItem,
  type PersistedJournal,
  type StructuredEvent,
} from './event-journal';
import { startStructuredChatNotifications } from './notifications';

export type StructuredLifecycle = 'starting' | 'ready' | 'working' | 'failed' | 'detached' | 'closed';

export interface StructuredSessionRecord {
  /** Stable Spacron id; survives restarts (pane ids do not). */
  id: string;
  provider: StructuredChatAgent;
  /** Codex thread, Claude session, ACP session: what `resumeId` takes. */
  nativeSessionId: string | null;
  preset: string | null;
  accountId: string | null;
  /** Label captured when launched, so later login/selection changes do not rename its owner. */
  accountLabel?: string | null;
  cwd: string;
  projectId: string | null;
  /** `chat`: opened as a chat. `converted`: a CLI pane switched into chat. */
  origin: 'chat' | 'converted';
  view: 'chat' | 'terminal';
  lifecycle: StructuredLifecycle;
  model: string | null;
  effort: string | null;
  fast?: boolean;
  ultracode?: boolean;
  access: StructuredAccess | null;
  turnId: string | null;
  lastSeq: number;
  title: string | null;
  /** True until the chat is named: a rename, or its first prompt, clears it. */
  titleAuto?: boolean;
  /** Archived chats are hidden from tabs, /history and restore; never deleted. */
  archived?: boolean;
  archivedAt?: number;
  /**
   * The objective this chat last sent the agent through `/goal`. The agent owns
   * the goal; Spacron only mirrors what it sent so the panel can show it.
   */
  goal?: { text: string; state: 'active' | 'paused'; at: number } | null;
  handoffFrom: { recordId: string | null; paneLabel: string } | null;
  handoffTo: string[];
  forkedFrom?: string | null;
  forkMode?: 'native' | 'journal-branch' | null;
  /** Provider session to fork from on first start, until the fork has its own id. */
  forkSourceId?: string | null;
  /** The agent has not seen this chat's history: send it with the next prompt. */
  seedContext?: boolean;
  /** Shown in the right sidebar; never restored or reclaimed as a pane of its own. */
  side?: boolean;
  /** Outside-of-project standalone chat backed by a scratch workspace instead of a project room. */
  standalone?: boolean;
  /** Scratch workspace id opened via `chat_workspace_open` for standalone chats. */
  standaloneWorkspaceId?: string | null;
  /** Pinned at the top of the Chats sidebar. */
  pinned?: boolean;
  restoredMode?: 'native' | 'journal-only' | 'fresh' | null;
  /**
   * Child agents this chat spawned, with their status, reports and timeline.
   * Kept here rather than in a second storage key so a child is pruned (and
   * restored) exactly with the conversation that owns it.
   */
  subagents?: StructuredSubagentSession[];
  createdAt: number;
  updatedAt: number;
}

const RECORDS_KEY = 'spacron_structured_sessions';
const JOURNAL_PREFIX = 'spacron_structured_journal:';
// Journals run to ~1 MB each, so fifty of them overran localStorage's 5 MB and
// stopped everything else (bots, settings) from saving. They live in IndexedDB;
// this map is the copy read back at startup so loading stays synchronous.
const idbJournals = new Map<string, string>();
let idbUsable = idbAvailable();
const MAX_RECORDS = 50;
const SAVE_DELAY_MS = 600;
const DIFF_DELAY_MS = 50;

// ---------------------------------------------------------------------------
// Storage (all guarded: restricted storage keeps everything in memory)
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function loadRecords(): Record<string, StructuredSessionRecord> {
  try {
    const raw = storage()?.getItem(RECORDS_KEY);
    return raw ? JSON.parse(raw) as Record<string, StructuredSessionRecord> : {};
  } catch {
    return {};
  }
}

function loadJournal(id: string): PersistedJournal | null {
  try {
    const raw = idbJournals.get(id) ?? storage()?.getItem(JOURNAL_PREFIX + id);
    const parsed = raw ? JSON.parse(raw) as PersistedJournal : null;
    return parsed?.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export const structuredSessions = writable<Record<string, StructuredSessionRecord>>(loadRecords());

/** Read journals back from IndexedDB, and move any still in localStorage over. */
async function hydrateJournals(): Promise<void> {
  if (!idbUsable) return;
  const store = storage();
  try {
    for (const id of Object.keys(get(structuredSessions))) {
      const key = JOURNAL_PREFIX + id;
      const saved = await idbGet(key);
      const legacy = store?.getItem(key) ?? null;
      if (saved) {
        if (!idbJournals.has(id)) idbJournals.set(id, saved);
      } else if (legacy) {
        await idbSet(key, legacy);
        if (!idbJournals.has(id)) idbJournals.set(id, legacy);
      }
      if (legacy) { try { store?.removeItem(key); } catch { /* ignore */ } }
    }
  } catch {
    idbUsable = false;
  }
}
void hydrateJournals();

const journals = new Map<string, StructuredEventJournal>();
const dirtyJournals = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flushSessionStore, SAVE_DELAY_MS);
}

/** Write pending records and journals now. Also runs on page unload. */
export function flushSessionStore(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const store = storage();
  if (!store) return;
  const all = get(structuredSessions);
  // Pinned chats first: pinning is a request to keep one, however old it gets.
  const kept = Object.values(all)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECORDS);
  const keptIds = new Set(kept.map((record) => record.id));
  try {
    store.setItem(RECORDS_KEY, JSON.stringify(Object.fromEntries(kept.map((record) => [record.id, record]))));
  } catch {
    // Quota: the records stay in memory for this run.
  }
  for (const id of Object.keys(all)) {
    if (!keptIds.has(id)) {
      try { store.removeItem(JOURNAL_PREFIX + id); } catch { /* ignore */ }
      if (idbUsable) { idbJournals.delete(id); void idbDelete(JOURNAL_PREFIX + id).catch(() => {}); }
      journals.delete(id);
    }
  }
  for (const id of dirtyJournals) {
    const journal = journals.get(id);
    if (!journal || !keptIds.has(id)) continue;
    if (idbUsable) {
      const json = JSON.stringify(journal.toJSON());
      idbJournals.set(id, json);
      void idbSet(JOURNAL_PREFIX + id, json)
        .then(() => { try { store.removeItem(JOURNAL_PREFIX + id); } catch { /* ignore */ } })
        .catch(() => { try { store.setItem(JOURNAL_PREFIX + id, json); } catch { /* quota: kept in memory */ } });
      continue;
    }
    try {
      store.setItem(JOURNAL_PREFIX + id, JSON.stringify(journal.toJSON()));
    } catch {
      // Quota: fold the journal down and try once more.
      journal.compact();
      try { store.setItem(JOURNAL_PREFIX + id, JSON.stringify(journal.toJSON())); } catch { /* ignore */ }
    }
  }
  dirtyJournals.clear();
  if (kept.length !== Object.keys(all).length) {
    structuredSessions.set(Object.fromEntries(kept.map((record) => [record.id, record])));
  }
}

function journalFor(record: StructuredSessionRecord): StructuredEventJournal {
  let journal = journals.get(record.id);
  if (!journal) {
    journal = new StructuredEventJournal(record.id, record.provider, loadJournal(record.id));
    journals.set(record.id, journal);
  }
  return journal;
}

function patchRecord(id: string, patch: Partial<StructuredSessionRecord>): void {
  structuredSessions.update((all) => {
    const prev = all[id];
    if (!prev) return all;
    return { ...all, [id]: { ...prev, ...patch, updatedAt: Date.now() } };
  });
  scheduleSave();
}

/** The account the agent's CLI is selected to run as, where it supports switching. */
function accountFor(preset: string | null): string | null {
  const executable = preset?.trim().split(/\s+/)[0]?.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (!executable) return null;
  try {
    return activeAccount(get(accountsState), executable)?.id ?? null;
  } catch {
    return null;
  }
}

function newRecordId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 18);
  return `ss_${random}`;
}

// ---------------------------------------------------------------------------
// Pane <-> record links and the recorder
// ---------------------------------------------------------------------------

interface Attachment {
  recordId: string;
  agent: StructuredChatAgent;
  last: StructuredChatState | null;
  unsubscribe: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Approvals answered through `answerStructuredApproval`, already journaled with their decision. */
  answered: Set<string>;
}

const paneRecords = new Map<number, string>();
const attachments = new Map<number, Attachment>();
/** Pane ids a restore or reconnect is about to mark, with the record they belong to. */
const pendingLinks = new Map<number, string>();
/** A pane that went back to its terminal keeps its record for a later Continue in chat. */
const formerRecords = new Map<number, string>();
/** Guard against detach closing the record while swapping providers on a pane. */
const switchingPanes = new Set<number>();
let nextVirtualPaneId = -1000;
let shuttingDown = false;

/** Allocate a negative virtual pane id for terminal-less standalone & side chats. */
export function allocateVirtualStructuredPaneId(): number {
  return --nextVirtualPaneId;
}

export function isVirtualStructuredPane(paneId: number): boolean {
  return paneId < 0;
}

function commandForAgent(agent: StructuredChatAgent): string {
  return agent === 'antigravity' ? 'agy' : agent === 'cursor' ? 'cursor-agent' : agent;
}

function lifecycleOf(state: StructuredChatState | null): StructuredLifecycle {
  if (!state) return 'starting';
  return state.status === 'closed' ? 'detached' : state.status;
}

function recordState(paneId: number): void {
  const attachment = attachments.get(paneId);
  if (!attachment) return;
  attachment.timer = null;
  const record = get(structuredSessions)[attachment.recordId];
  const provider = structuredChatProvider(attachment.agent);
  const state = provider?.get(paneId) ?? null;
  if (!record || !state) return;
  const journal = journalFor(record);
  const drafts = diffStructuredState(attachment.last, state).filter((draft) => {
    if (draft.type !== 'approval.resolved') return true;
    const id = String(draft.payload.requestId);
    if (!attachment.answered.has(id)) return true;
    attachment.answered.delete(id);
    return false;
  });
  const added = journal.record(drafts);
  attachment.last = state;
  if (state.status === 'ready' && state.models.length) rememberModelCatalog(attachment.agent, state.models);
  const nativeId = provider?.conversationId?.(paneId) ?? state.threadId ?? record.nativeSessionId;
  const patch: Partial<StructuredSessionRecord> = {
    lifecycle: lifecycleOf(state),
    model: state.model ?? record.model,
    effort: state.effort ?? record.effort,
    fast: state.fast ?? record.fast,
    ultracode: state.ultracode ?? record.ultracode,
    access: state.access ?? record.access,
    nativeSessionId: nativeId,
    turnId: journal.currentTurnId,
    lastSeq: journal.lastSeq,
  };
  // A chat that still carries its agent's name gets named after its first
  // prompt, so an earlier chat is recognisable in /history and the tab strip.
  // `titleAuto` is cleared by a rename, and undefined on records written before
  // this existed: those keep the title they were given.
  if (record.titleAuto && get(chatAutoNames) && record.origin === 'chat' && !record.archived) {
    const first = state.items.find((item) => item.kind === 'user' && item.text.trim());
    const named = first ? first.text.trim().split(/\r?\n/)[0].replace(/^[#>\s]+/, '').slice(0, 60).trim() : '';
    if (named) {
      patch.title = named;
      patch.titleAuto = false;
      if ((record.standalone || get(chatModelNames)) && first) void upgradeTitleWithModel(paneId, record.id, named, first.text);
    }
  }
  const changed = added.length > 0 || (Object.keys(patch) as (keyof StructuredSessionRecord)[]).some((key) => patch[key] !== record[key]);
  if (!changed) return;
  if (added.length) dirtyJournals.add(record.id);
  patchRecord(record.id, patch);
  if (patch.title && !isVirtualStructuredPane(paneId)) updateSessionTitle(paneId, patch.title);
  for (const listener of eventListeners) {
    for (const event of added) listener(paneId, event);
  }
}

/** Chats a model name has already been requested for, so it is asked once. */
const modelNamed = new Set<string>();

/**
 * Ask the chat's own agent CLI for a title, in a separate headless run so nothing
 * is added to the conversation. The reply must carry `TITLE:`; that keeps a
 * usage-limit or sign-in message printed on stdout from becoming the name.
 */
async function generateAgentTitle(record: StructuredSessionRecord, firstMessage: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { cleanGeneratedTitle } = await import('$lib/stores/chatThreads');
  const reply = await invoke<string>('agent_cli_generate_commit_message', {
    projectId: null,
    worktreePath: record.cwd !== '.' ? record.cwd : null,
    agent: record.preset ?? commandForAgent(record.provider),
    model: null,
    prompt: 'Write a title of 3 to 7 words for a chat that starts with the message below. '
      + 'Do not answer or act on the message, and do not use any tools. '
      + `Reply with exactly one line in the form TITLE: <title>\n\nMessage:\n${firstMessage.trim().slice(0, 1000)}`,
  });
  const line = /^\W*TITLE:\s*(.+)$/im.exec(reply ?? '')?.[1] ?? '';
  return cleanGeneratedTitle(line);
}

/**
 * Replace the first-message name with a short written title: from the chat's own
 * agent for a standalone chat, from the AI provider for a project chat that opted
 * in (`chatModelNames`). The first-message name is already in place, so a failed
 * or slow request costs nothing, and a rename made meanwhile is respected (the
 * title must still be the one we set).
 */
async function upgradeTitleWithModel(paneId: number, recordId: string, placeholder: string, firstMessage: string): Promise<void> {
  if (modelNamed.has(recordId)) return;
  modelNamed.add(recordId);
  try {
    const record = get(structuredSessions)[recordId];
    if (!record) return;
    const title = (record.standalone
      ? await generateAgentTitle(record, firstMessage)
      : await (await import('$lib/stores/chatThreads')).generateAiThreadTitle(firstMessage)).trim();
    const current = recordForPane(paneId);
    if (!title || !current || current.id !== recordId || current.title !== placeholder) return;
    renameStructuredSession(paneId, title);
  } catch {
    // The first-message name stays.
  }
}

function attach(paneId: number, agent: StructuredChatAgent): void {
  if (attachments.has(paneId)) return;
  const provider = structuredChatProvider(agent);
  if (!provider) return;

  let recordId = pendingLinks.get(paneId) ?? paneRecords.get(paneId) ?? formerRecords.get(paneId) ?? null;
  pendingLinks.delete(paneId);
  formerRecords.delete(paneId);
  const existing = recordId ? get(structuredSessions)[recordId] : null;
  if (!existing) {
    const preset = structuredChatPreset(paneId);
    const info = get(sessions).find((session) => session.id === paneId);
    const now = Date.now();
    const record: StructuredSessionRecord = {
      id: newRecordId(),
      provider: agent,
      nativeSessionId: null,
      preset,
      accountId: accountFor(preset),
      accountLabel: activeAccount(get(accountsState), agent)?.label ?? null,
      cwd: getSessionRoot(paneId) ?? '.',
      projectId: get(allProjectSessions).find((session) => session.id === paneId)?.projectId ?? getActiveTerminalProjectId(),
      origin: info?.agentPreset && !isNewStructuredChatPane(paneId) ? 'converted' : 'chat',
      view: 'chat',
      lifecycle: 'starting',
      model: null,
      effort: null,
      access: null,
      turnId: null,
      lastSeq: 0,
      title: info?.title ?? provider.label,
      // A CLI conversation switched into chat keeps the title the terminal
      // gave it; only a chat Spacron opened is named from its first prompt.
      titleAuto: !info?.agentPreset,
      handoffFrom: null,
      handoffTo: [],
      createdAt: now,
      updatedAt: now,
    };
    recordId = record.id;
    structuredSessions.update((all) => ({ ...all, [record.id]: record }));
    // A CLI conversation switched into chat: keep its transcript as history.
    const history = get(structuredChatHistory)[paneId] ?? [];
    if (history.length) {
      journalFor(record).record(history.map((item) => ({ type: item.kind === 'user' ? 'user.message' : 'assistant.text', payload: { item: journalItem(item) } })));
      dirtyJournals.add(record.id);
    }
    scheduleSave();
  } else {
    patchRecord(existing.id, { view: 'chat', lifecycle: 'starting' });
  }
  paneRecords.set(paneId, recordId!);

  const attachment: Attachment = { recordId: recordId!, agent, last: null, unsubscribe: () => {}, timer: null, answered: new Set() };
  attachment.unsubscribe = provider.subscribe(() => {
    if (!attachment.timer) attachment.timer = setTimeout(() => recordState(paneId), DIFF_DELAY_MS);
  });
  attachments.set(paneId, attachment);
  recordState(paneId);
}

function detach(paneId: number): void {
  if (switchingPanes.has(paneId)) return;
  const attachment = attachments.get(paneId);
  if (!attachment) return;
  if (attachment.timer) clearTimeout(attachment.timer);
  recordState(paneId);
  attachment.unsubscribe();
  attachments.delete(paneId);
  paneRecords.delete(paneId);
  clearPaneContext(paneId);
  // A pane closed by the user ends the record; a pane going back to its
  // terminal keeps it (`view: terminal`); an app shutdown leaves it open.
  if (shuttingDown) return;
  const record = get(structuredSessions)[attachment.recordId];
  if (!record) return;
  const backToTerminal = get(sessions).some((session) => session.id === paneId && session.isRunning);
  if (backToTerminal) formerRecords.set(paneId, record.id);
  patchRecord(record.id, backToTerminal ? { view: 'terminal', lifecycle: 'detached' } : { lifecycle: 'closed' });
}

let started = false;

/** Start watching structured panes. Idempotent; called on module load in the app. */
export function startSessionStore(): void {
  if (started) return;
  started = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      shuttingDown = true;
      flushSessionStore();
    });
  }
  structuredChatPanes.subscribe((panes) => {
    for (const [id, agent] of Object.entries(panes)) attach(Number(id), agent);
    for (const paneId of [...attachments.keys()]) {
      if (!(paneId in panes)) detach(paneId);
    }
  });
  startStructuredChatNotifications();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type EventListener = (paneId: number, event: StructuredEvent) => void;
const eventListeners = new Set<EventListener>();

/** Live normalized events for every structured pane. */
export function subscribeStructuredEvents(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function recordForPane(paneId: number): StructuredSessionRecord | null {
  const id = paneRecords.get(paneId);
  return id ? get(structuredSessions)[id] ?? null : null;
}

/** Explicit resume ownership overrides the current global account selection. */
export function bindStructuredAccount(paneId: number, accountId: string, label?: string | null): void {
  const record = recordForPane(paneId);
  if (!record) return;
  const account = get(accountsState).accounts.find((a) => a.provider === record.provider && a.id === accountId);
  patchRecord(record.id, { accountId, accountLabel: label ?? account?.label ?? null });
}

export function useStructuredSessionRecord(paneId: number): StructuredSessionRecord | null {
  const all = useStore(structuredSessions);
  const id = paneRecords.get(paneId);
  return id ? all[id] ?? null : null;
}

/** Replay a record's events after `cursor` (for a remounted subscriber). */
export function replayStructuredEvents(recordId: string, cursor: number): { events: StructuredEvent[]; resetFrom: number | null } {
  const record = get(structuredSessions)[recordId];
  if (!record) return { events: [], resetFrom: null };
  const journal = journalFor(record);
  // Events before the snapshot were compacted: the caller must re-read the snapshot.
  const resetFrom = cursor < journal.replayableFrom ? journal.replayableFrom : null;
  return { events: journal.since(Math.max(cursor, journal.replayableFrom)), resetFrom };
}

export function structuredSessionHistory(recordId: string, limit = 100, before?: number) {
  const record = get(structuredSessions)[recordId];
  return record ? journalFor(record).history(limit, before) : { items: [], start: 0, hasMore: false };
}

/**
 * Rebuild a pane's history from its journal when the view mounts with none
 * (a remount after the provider restarted, or a pane relinked to a record).
 * Only items the live provider doesn't already show are used, so nothing is
 * drawn twice.
 */
export function hydrateStructuredHistory(paneId: number): boolean {
  const record = recordForPane(paneId);
  if (!record) return false;
  if ((get(structuredChatHistory)[paneId] ?? []).length) return false;
  const live = new Set((structuredChatProvider(record.provider)?.get(paneId)?.items ?? []).map((item) => item.id));
  const items = journalFor(record).snapshot().items.filter((item) => !live.has(item.id));
  if (!items.length) return false;
  setStructuredChatHistory(paneId, items);
  return true;
}

/** Link a handoff target to its source in both records where they exist. */
export function linkHandoffLineage(sourcePaneId: number, sourceLabel: string, targetPaneId: number): void {
  const source = recordForPane(sourcePaneId);
  const target = recordForPane(targetPaneId);
  if (target) patchRecord(target.id, { handoffFrom: { recordId: source?.id ?? null, paneLabel: sourceLabel } });
  if (source && target) patchRecord(source.id, { handoffTo: [...source.handoffTo, target.id] });
}

// ---------------------------------------------------------------------------
// Restore and reconnect
// ---------------------------------------------------------------------------

/** The access a chat runs with. A standalone chat asks until you say otherwise. */
function accessFor(record: StructuredSessionRecord): StructuredAccess {
  return record.access ?? (record.standalone ? 'ask' : structuredAccessFor(record.preset ?? record.provider));
}

async function openRecordInPane(paneId: number, record: StructuredSessionRecord): Promise<void> {
  const provider = structuredChatProvider(record.provider);
  if (!provider) throw new Error(`No structured chat provider for ${record.provider}`);
  const access = accessFor(record);
  const history = journalFor(record).snapshot().items;
  setStructuredChatHistory(paneId, history);
  const options = { access, accountId: record.accountId ?? 'default' };
  clearPaneContext(paneId);
  const forkSource = record.nativeSessionId ? null : record.forkSourceId ?? null;
  let resumeId = record.nativeSessionId ?? forkSource;
  let seed = record.seedContext === true;
  await provider.start(paneId, record.cwd, { ...options, resumeId, ...(forkSource ? { forkSession: true } : {}) });
  let state = provider.get(paneId);

  // The source cannot be forked (never saved, or gone): send the history instead.
  if (forkSource && state?.status === 'failed') {
    await provider.close(paneId);
    resumeId = null;
    seed = history.length > 0;
    patchRecord(record.id, { forkSourceId: null, forkMode: 'journal-branch', seedContext: seed });
    await provider.start(paneId, record.cwd, { ...options, resumeId });
    state = provider.get(paneId);
  }

  // Codex allocates an ID before it writes any conversation to disk.
  // A missing rollout is safe to recover only when this chat has no messages.
  if (record.provider === 'codex' && resumeId && !record.turnId && history.length === 0 &&
      state?.status === 'failed' && /no rollout found for thread id/i.test(state.error ?? '')) {
    await provider.close(paneId);
    resumeId = null;
    patchRecord(record.id, { nativeSessionId: null });
    await provider.start(paneId, record.cwd, { ...options, resumeId });
    state = provider.get(paneId);
  }
  if (!state || state.status === 'failed' || state.status === 'closed') {
    patchRecord(record.id, { lifecycle: 'failed' });
    return;
  }
  patchRecord(record.id, { restoredMode: resumeId && !seed ? 'native' : history.length ? 'journal-only' : 'fresh' });
  const block = seed ? buildSideChatContext(history) : null;
  if (block) setPaneContext(paneId, block, () => patchRecord(record.id, { seedContext: false }));
  if (state?.status === 'ready' || state?.status === 'working') {
    if (record.model && state.model !== record.model) provider.setModel(paneId, record.model);
    if (record.effort && state.effort !== record.effort) provider.setEffort(paneId, record.effort);
    if (record.fast !== undefined && state.fast !== record.fast) provider.setFast?.(paneId, record.fast);
    if (record.ultracode && !state.ultracode) provider.setUltracode?.(paneId, true);
  }
}

const restoring = new Set<string>();

/**
 * Rebuild a pane's subagent panel from its record. Imported lazily because the
 * subagent engine reaches back here for the parent's context (a static import
 * would close that cycle).
 */
async function restoreRecordSubagents(paneId: number, record: StructuredSessionRecord): Promise<void> {
  try {
    const { restoreMcpSubagents } = await import('./mcp-subagents');
    restoreMcpSubagents(paneId, record.id, record.subagents ?? []);
  } catch (error) {
    console.warn('Could not restore subagents for structured chat', record.id, error);
  }
}

export function restoreAgentFolder(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

export function openChatRecords(projectId: string): StructuredSessionRecord[] {
  return Object.values(get(structuredSessions)).filter((record) =>
    record.projectId === projectId &&
    !record.standalone &&
    record.origin === 'chat' &&
    !record.side &&
    !record.archived &&
    record.view === 'chat' &&
    record.lifecycle !== 'closed' &&
    structuredChatProvider(record.provider))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export async function restoreStructuredSessions(projectId: string): Promise<number> {
  startSessionStore();
  const linked = new Set(paneRecords.values());
  const latest = new Map<string, StructuredSessionRecord>();
  const superseded = new Map<string, string[]>();
  for (const record of openChatRecords(projectId)) {
    const key = JSON.stringify([record.provider, record.accountId ?? 'default', restoreAgentFolder(record.cwd)]);
    const newest = latest.get(key);
    if (!newest) {
      latest.set(key, record);
    } else if (!linked.has(record.id) && !restoring.has(record.id)) {
      const older = superseded.get(newest.id) ?? [];
      older.push(record.id);
      superseded.set(newest.id, older);
    }
  }
  const candidates = [...latest.values()].filter((record) => !linked.has(record.id) && !restoring.has(record.id));
  for (const record of candidates) restoring.add(record.id);
  let restored = 0;
  for (const record of candidates) {
    try {
      const paneId = await createTerminalSession(record.cwd, undefined, projectId, {
        assignPane: false,
        agentPreset: record.preset ?? record.provider,
      });
      if (paneId === null) continue;
      pendingLinks.set(paneId, record.id);
      markStructuredChatPane(paneId, record.provider, record.preset ?? undefined, 'chat');
      updateSessionTitle(paneId, record.title ?? `${structuredChatProvider(record.provider)?.label ?? 'Agent'} Chat`);
      await openRecordInPane(paneId, record);
      await restoreRecordSubagents(paneId, record);
      for (const id of superseded.get(record.id) ?? []) patchRecord(id, { lifecycle: 'closed' });
      restored += 1;
    } catch (error) {
      console.warn('Could not restore structured chat', record.id, error);
      patchRecord(record.id, { lifecycle: 'failed' });
    } finally {
      restoring.delete(record.id);
    }
  }
  return restored;
}

/**
 * Restart a pane's provider after it failed or its process went away, on the
 * same conversation. The journal keeps everything said so far as history.
 */
export async function reconnectStructuredSession(paneId: number): Promise<boolean> {
  const record = recordForPane(paneId);
  const attachment = attachments.get(paneId);
  const provider = record ? structuredChatProvider(record.provider) : null;
  if (!record || !attachment || !provider) return false;
  recordState(paneId);
  await provider.close(paneId).catch(() => {});
  // The restarted provider begins with no items; diff from scratch so the old
  // items are not read as a clear.
  attachment.last = null;
  patchRecord(record.id, { lifecycle: 'starting' });
  try {
    await openRecordInPane(paneId, get(structuredSessions)[record.id] ?? record);
    return provider.get(paneId)?.status !== 'failed';
  } catch {
    patchRecord(record.id, { lifecycle: 'failed' });
    return false;
  }
}

/**
 * Resume a stopped or interrupted turn in this pane without adding a user
 * message to the transcript. Reconnects the provider first if it exited or failed.
 */
export async function resumeStoppedTurn(paneId: number): Promise<boolean> {
  const record = recordForPane(paneId);
  const agent = record?.provider ?? get(structuredChatPanes)[paneId];
  const provider = structuredChatProvider(agent);
  if (!provider?.resumeTurn) return false;
  const state = provider.get(paneId);
  if (state?.status === 'working') return false;
  if (!state || state.status === 'failed' || state.status === 'closed') {
    const ok = await reconnectStructuredSession(paneId);
    if (!ok) return false;
  }
  await provider.resumeTurn(paneId);
  return true;
}

// ---------------------------------------------------------------------------
// Explicit session operations
// ---------------------------------------------------------------------------

/**
 * Answer an approval and journal the decision. The provider then drops the
 * request from its state, which the recorder would otherwise journal again as
 * a bare `approval.resolved`.
 */
export async function answerStructuredApproval(
  paneId: number,
  requestId: string | number,
  decision: 'accept' | 'acceptForSession' | 'decline',
  optionId?: string,
  optionLabel?: string,
  answers?: AskAnswer[],
): Promise<void> {
  const record = recordForPane(paneId);
  const attachment = attachments.get(paneId);
  const provider = structuredChatProvider(record?.provider ?? get(structuredChatPanes)[paneId]);
  if (record && attachment) {
    attachment.answered.add(String(requestId));
    journalFor(record).record([{ type: 'approval.resolved', payload: { requestId: String(requestId), decision, ...(optionId ? { optionId } : {}), ...(optionLabel ? { optionLabel } : {}) } }]);
    dirtyJournals.add(record.id);
    scheduleSave();
  }
  if (answers) await provider?.answerApproval(paneId, requestId, decision, optionId, answers);
  else await provider?.answerApproval(paneId, requestId, decision, optionId);
}

/**
 * Persist a chat's child agents on its record. Called by the Spacron MCP
 * subagent engine whenever a child starts, reports, is answered or ends.
 */
export function recordSubagentSnapshot(recordId: string, children: StructuredSubagentSession[]): void {
  if (!get(structuredSessions)[recordId]) return;
  patchRecord(recordId, { subagents: children });
}

/** The approval the session is waiting on right now, oldest first. */
export function currentStructuredRequest(paneId: number) {
  const record = recordForPane(paneId);
  const state = record ? structuredChatProvider(record.provider)?.get(paneId) : null;
  return state?.approvals[0] ?? null;
}

/**
 * Archive or restore the chat this pane is showing. Archiving takes it out of
 * the pane's tabs, /history and restore; its journal, native id and title stay
 * on disk for /unarchive.
 */
export function archiveStructuredSession(paneId: number, archived = true): boolean {
  const record = recordForPane(paneId);
  if (!record || record.view !== 'chat') return false;
  patchRecord(record.id, archived ? { archived: true, archivedAt: Date.now() } : { archived: false, archivedAt: undefined });
  return true;
}

/** Archive or restore one record by id (a tab that is not the current chat). */
export function archiveStructuredRecord(recordId: string, archived = true): boolean {
  const record = get(structuredSessions)[recordId];
  if (!record) return false;
  patchRecord(record.id, archived ? { archived: true, archivedAt: Date.now() } : { archived: false, archivedAt: undefined });
  return true;
}

/** Archived chats, most recently archived first, for /archived. */
export function listArchivedSessions(filter: { projectId?: string | null; provider?: string } = {}): StructuredSessionRecord[] {
  return Object.values(get(structuredSessions))
    .filter((record) => record.archived
      && (filter.projectId == null || record.projectId === filter.projectId)
      && (!filter.provider || record.provider === filter.provider))
    .sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt));
}

/** Mirror the objective a `/goal` command sent, and whether it is paused. */
export function setStructuredGoal(paneId: number, text: string, state: 'active' | 'paused' = 'active'): boolean {
  const record = recordForPane(paneId);
  const clean = text.trim().slice(0, 300);
  if (!record || !clean) return false;
  patchRecord(record.id, { goal: { text: clean, state, at: Date.now() } });
  return true;
}

export function clearStructuredGoal(paneId: number): boolean {
  const record = recordForPane(paneId);
  if (!record) return false;
  patchRecord(record.id, { goal: null });
  return true;
}

/** One answered approval or question card, as the transcript shows it. */
export interface ApprovalReceipt {
  requestId: string;
  title: string;
  decision: string | null;
  optionId: string | null;
  optionLabel?: string | null;
  at: number;
}

/**
 * Answered request cards from the journal, oldest first. Built from the paired
 * `approval.requested` / `approval.resolved` events, so a receipt survives a
 * reload with the answer that was actually sent.
 */
export function approvalReceipts(recordId: string): ApprovalReceipt[] {
  const record = get(structuredSessions)[recordId];
  if (!record) return [];
  const journal = journalFor(record);
  const titles = new Map<string, string>();
  const out: ApprovalReceipt[] = [];
  for (const event of journal.since(journal.replayableFrom)) {
    if (event.type === 'approval.requested') {
      titles.set(String(event.payload.requestId), String(event.payload.title ?? 'Approval'));
    } else if (event.type === 'approval.resolved') {
      const requestId = String(event.payload.requestId);
      out.push({
        requestId,
        title: titles.get(requestId) ?? 'Approval',
        decision: typeof event.payload.decision === 'string' ? event.payload.decision : null,
        optionId: typeof event.payload.optionId === 'string' ? event.payload.optionId : null,
        optionLabel: typeof event.payload.optionLabel === 'string' ? event.payload.optionLabel : null,
        at: event.at,
      });
    }
  }
  return out.slice(-12);
}

export function renameStructuredSession(paneId: number, title: string): boolean {
  const record = recordForPane(paneId);
  const clean = title.trim().slice(0, 120);
  if (!record || !clean) return false;
  patchRecord(record.id, { title: clean, titleAuto: false });
  updateSessionTitle(paneId, clean);
  return true;
}

export function compactStructuredSession(paneId: number): boolean {
  const record = recordForPane(paneId);
  if (!record) return false;
  const journal = journals.get(record.id);
  if (!journal) return false;
  journal.compact();
  dirtyJournals.add(record.id);
  scheduleSave();
  return true;
}

/**
 * Start a new conversation in this pane: the provider restarts without a
 * resume id and the journal marks the clear (the old conversation stays in
 * the journal up to that point).
 */
/**
 * Whether a chat holds anything worth coming back to. A chat opened and never
 * used (still on its default name, no prompt sent) is clutter in the tab strip
 * and the earlier-chats list. A chat that was renamed, or that predates the
 * naming flag, is always kept: it has a title someone chose.
 */
export function recordHasConversation(record: StructuredSessionRecord): boolean {
  if (record.titleAuto !== true) return true;
  return journalFor(record).snapshot().items.some((item) => item.kind === 'user');
}

export async function clearStructuredConversation(paneId: number): Promise<boolean> {
  const record = recordForPane(paneId);
  const attachment = attachments.get(paneId);
  const provider = record ? structuredChatProvider(record.provider) : null;
  if (!record || !attachment || !provider) return false;
  recordState(paneId);
  await provider.close(paneId).catch(() => {});
  attachment.last = null;
  journalFor(record).record([{ type: 'session.cleared', payload: {} }]);
  dirtyJournals.add(record.id);
  clearPaneContext(paneId);
  patchRecord(record.id, { nativeSessionId: null, forkSourceId: null, seedContext: false, lifecycle: 'starting', turnId: null });
  setStructuredChatHistory(paneId, []);
  await provider.start(paneId, record.cwd, { access: accessFor(record) });
  return provider.get(paneId)?.status !== 'failed';
}

/** Earlier conversations, newest first. */
export function listStructuredSessions(filter: { projectId?: string | null; provider?: string; includeArchived?: boolean; standalone?: boolean } = {}): StructuredSessionRecord[] {
  return Object.values(get(structuredSessions))
    .filter((record) => (filter.includeArchived || !record.archived)
      && (filter.projectId == null || record.projectId === filter.projectId)
      && (!filter.provider || record.provider === filter.provider)
      && (filter.standalone === undefined || Boolean(record.standalone) === filter.standalone))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Switch the active structured-chat agent in-place on an open pane between turns.
 * Flushes the outgoing provider into the journal, adds an inline switch divider,
 * closes the outgoing process, and launches the target provider with `seedContext`
 * populated from the normalized journal so the conversation continues smoothly.
 */
export async function switchStructuredAgent(
  paneId: number,
  targetAgent: StructuredChatAgent,
  options: { model?: string | null; effort?: string | null } = {},
): Promise<boolean> {
  const record = recordForPane(paneId);
  const targetProvider = structuredChatProvider(targetAgent);
  if (!record || !targetProvider) return false;
  const prevProvider = structuredChatProvider(record.provider);
  if (prevProvider?.get(paneId)?.status === 'working') return false;

  if (record.provider === targetAgent) {
    if (options.model) targetProvider.setModel(paneId, options.model);
    if (options.effort) targetProvider.setEffort(paneId, options.effort);
    patchRecord(record.id, {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
    });
    return true;
  }

  recordState(paneId);
  const attachment = attachments.get(paneId);
  if (attachment) {
    if (attachment.timer) clearTimeout(attachment.timer);
    attachment.unsubscribe();
    attachments.delete(paneId);
  }
  await prevProvider?.close(paneId).catch(() => {});

  const parts = [targetProvider.label];
  if (options.model && options.model !== 'default') parts.push(options.model);
  if (options.effort && options.effort !== 'default') parts.push(`(${options.effort})`);
  const switchLabel = `Switched to ${parts.join(' · ')}`;
  const journal = journalFor(record);
  journal.record([{
    type: 'notice',
    payload: {
      item: {
        id: `switch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: 'notice',
        text: switchLabel,
      },
    },
  }]);
  dirtyJournals.add(record.id);

  const history = journal.snapshot().items;
  const hasConversation = history.some((item) => item.kind === 'user');
  const nextPreset = commandForAgent(targetAgent);

  patchRecord(record.id, {
    provider: targetAgent,
    preset: nextPreset,
    accountId: accountFor(nextPreset),
    accountLabel: activeAccount(get(accountsState), targetAgent)?.label ?? null,
    nativeSessionId: null,
    forkSourceId: null,
    model: options.model ?? null,
    effort: options.effort ?? null,
    seedContext: hasConversation,
    lifecycle: 'starting',
  });

  switchingPanes.add(paneId);
  pendingLinks.set(paneId, record.id);
  try {
    markStructuredChatPane(paneId, targetAgent, nextPreset, 'chat');
  } finally {
    switchingPanes.delete(paneId);
  }

  try {
    await openRecordInPane(paneId, get(structuredSessions)[record.id] ?? record);
    return targetProvider.get(paneId)?.status !== 'failed';
  } catch {
    patchRecord(record.id, { lifecycle: 'failed' });
    return false;
  }
}

/**
 * Switch this pane to an earlier conversation of the same provider: the
 * current one is left detached (resumable later), the chosen one resumes here.
 */
export async function resumeStructuredSessionInPane(paneId: number, recordId: string): Promise<boolean> {
  const current = recordForPane(paneId);
  const attachment = attachments.get(paneId);
  const target = get(structuredSessions)[recordId];
  if (!current || !attachment || !target || target.id === current.id) return false;
  if (target.provider !== current.provider) return false;
  if ([...paneRecords.values()].includes(target.id)) return false;
  const provider = structuredChatProvider(target.provider);
  if (!provider) return false;
  recordState(paneId);
  await provider.close(paneId).catch(() => {});
  patchRecord(current.id, { lifecycle: 'detached' });
  attachment.recordId = target.id;
  attachment.last = null;
  attachment.answered.clear();
  paneRecords.set(paneId, target.id);
  patchRecord(target.id, { view: 'chat', lifecycle: 'starting', archived: false, archivedAt: undefined });
  if (target.title) updateSessionTitle(paneId, target.title);
  try {
    await openRecordInPane(paneId, target);
    // The pane's previous chat kept its children; this one brings its own.
    await restoreRecordSubagents(paneId, target);
    return provider.get(paneId)?.status !== 'failed';
  } catch {
    patchRecord(target.id, { lifecycle: 'failed' });
    return false;
  }
}

/**
 * Open a saved chat in its own new pane, leaving the source pane and its agent
 * running. Returns the new pane, or null when none could be created.
 */
export async function openStructuredRecordBeside(sourcePaneId: number, recordId: string): Promise<number | null> {
  const source = recordForPane(sourcePaneId);
  const target = get(structuredSessions)[recordId];
  if (!source || !target || !structuredChatProvider(target.provider)) return null;
  const useVirtual = Boolean(source.standalone || isVirtualStructuredPane(sourcePaneId) || !target.projectId);
  const paneId = useVirtual
    ? allocateVirtualStructuredPaneId()
    : await createTerminalSession(target.cwd, undefined, target.projectId ?? undefined, {
        assignPane: false,
        // No room, tab or sidebar row on the stage: the right sidebar shows it.
        hidden: true,
        agentPreset: target.preset ?? target.provider,
      });
  if (paneId === null) return null;
  // The source's child agents, goal and handoffs stay with the source.
  patchRecord(target.id, { side: true, standalone: Boolean(source.standalone), origin: 'chat', view: 'chat', lifecycle: 'starting', subagents: [], goal: null, handoffFrom: null, handoffTo: [] });
  pendingLinks.set(paneId, target.id);
  markStructuredChatPane(paneId, target.provider, target.preset ?? undefined, 'chat');
  if (!isVirtualStructuredPane(paneId) && target.title) updateSessionTitle(paneId, target.title);
  try {
    await openRecordInPane(paneId, get(structuredSessions)[target.id] ?? target);
  } catch {
    patchRecord(target.id, { lifecycle: 'failed' });
  }
  return paneId;
}

/**
 * Fork the current conversation into a new session record: creates an independent
 * branch. If the provider supports native fork, it creates a native child conversation;
 * otherwise it forks the journal history cleanly.
 */
export async function forkStructuredSession(
  paneId: number,
  options: { title?: string } = {},
): Promise<StructuredSessionRecord | null> {
  const current = recordForPane(paneId);
  if (!current) return null;
  const provider = structuredChatProvider(current.provider);
  if (!provider) return null;
  const newId = `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let nativeSessionId: string | null = null;
  let forkMode: 'native' | 'journal-branch' = 'journal-branch';
  let forkSourceId: string | null = null;

  if (provider.capabilities?.fork && provider.fork) {
    try {
      const res = await provider.fork(paneId);
      if (typeof res === 'object' && res.nativeSessionId && res.nativeSessionId !== current.nativeSessionId) {
        nativeSessionId = res.nativeSessionId;
        forkMode = 'native';
      } else if (typeof res === 'object' && res.forkSourceId && !current.seedContext) {
        forkSourceId = res.forkSourceId;
        forkMode = 'native';
      }
    } catch {
      forkMode = 'journal-branch';
    }
  }

  const journal = journalFor(current);
  const snap = journal.snapshot();
  // The fork starts from the parent's folded history, not an empty journal.
  const forkedJournal = new StructuredEventJournal(newId, provider.agent, { v: 1, base: snap, events: [] });
  journals.set(newId, forkedJournal);
  dirtyJournals.add(newId);

  const title = options.title ?? `${current.title ?? 'Chat'} (fork)`;
  const record: StructuredSessionRecord = {
    ...current,
    id: newId,
    title,
    titleAuto: false,
    nativeSessionId,
    side: false,
    forkedFrom: current.id,
    forkMode,
    forkSourceId,
    // A source still waiting to be sent its history cannot pass it on natively.
    seedContext: current.seedContext === true || (!nativeSessionId && !forkSourceId && snap.items.some((item) => item.kind === 'user')),
    lifecycle: 'closed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  structuredSessions.update((all) => ({ ...all, [newId]: record }));
  scheduleSave();
  return record;
}

/**
 * Roll back the conversation to a previous turn or checkpoint.
 * If the provider supports native rollback (e.g. Codex thread/rollback),
 * it rolls back context on the backend server.
 * Otherwise, it rolls back the event journal and restarts the provider
 * with the sliced history so the model's context window does not retain the undone turn.
 */
export async function rewindStructuredSession(
  paneId: number,
  target?: { turnId?: string } | number,
): Promise<boolean> {
  const current = recordForPane(paneId);
  if (!current) return false;
  const provider = structuredChatProvider(current.provider);
  if (!provider) return false;

  let nativeOk = false;
  if (provider.capabilities?.rewind && provider.rewind) {
    try {
      nativeOk = await provider.rewind(paneId, target);
    } catch {
      nativeOk = false;
    }
  }

  const journal = journalFor(current);
  const items = journal.snapshot().items;
  const userIndexes = items.map((it, idx) => (it.kind === 'user' ? idx : -1)).filter((idx) => idx !== -1);
  // Rewind to a message: the named prompt and everything after it go. Without
  // one, the last turn goes, which is what a bare /rewind means.
  const named = typeof target === 'object' && target?.turnId
    ? items.findIndex((it) => it.kind === 'user' && it.id === target.turnId)
    : -1;
  const cut = named >= 0 ? named : userIndexes[userIndexes.length - 1] ?? -1;
  if (cut >= 0) {
    const sliced = items.slice(0, cut);
    const rolledJournal = new StructuredEventJournal(current.id, provider.agent, { v: 1, base: { seq: 0, items: sliced, turns: 0 }, events: [] });
    journals.set(current.id, rolledJournal);
    dirtyJournals.add(current.id);
    setStructuredChatHistory(paneId, sliced);
    clearPaneContext(paneId);
    patchRecord(current.id, { lastSeq: 0, forkSourceId: null, seedContext: false, updatedAt: Date.now() });

    // If the provider lacks native rollback RPC, restart the process with
    // clean state so its token context window does not retain the undone turn.
    if (!nativeOk) {
      const attachment = attachments.get(paneId);
      if (attachment && provider.close && provider.start) {
        attachment.last = null;
        await provider.close(paneId).catch(() => {});
        patchRecord(current.id, { nativeSessionId: null, lifecycle: 'starting', turnId: null });
        await provider.start(paneId, current.cwd, {
          access: accessFor(current),
        }).catch(() => {});
      }
    }

    scheduleSave();
    return true;
  }
  return nativeOk;
}

/** Claim the latest closed chat in this project, worktree, and provider account. */
export function claimClosedChat(projectId: string, provider: StructuredChatAgent, preset: string, cwd: string, accountId?: string | null): StructuredSessionRecord | null {
  startSessionStore();
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const account = accountId ?? accountFor(preset) ?? 'default';
  const linked = new Set(paneRecords.values());
  const record = Object.values(get(structuredSessions))
    .filter((candidate) =>
      candidate.lifecycle === 'closed' && candidate.view === 'chat' && !candidate.archived && !candidate.side &&
      candidate.projectId === projectId && candidate.provider === provider && candidate.preset === preset &&
      (candidate.accountId ?? 'default') === account && normalize(candidate.cwd) === normalize(cwd) &&
      (candidate.nativeSessionId || candidate.lastSeq > 0) &&
      !linked.has(candidate.id) && !restoring.has(candidate.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!record) return null;
  restoring.add(record.id);
  return record;
}

export function releaseStructuredSessionClaim(recordId: string): void {
  restoring.delete(recordId);
}

/**
 * Cold restore of a CLI agent pane that had been switched into chat (or back).
 * Returns the newest open record for that agent and folder, claimed so a
 * second pane can't take it too; null when the pane was never a chat.
 */
export function claimConvertedSession(projectId: string, preset: string, cwd: string): StructuredSessionRecord | null {
  startSessionStore();
  const linked = new Set(paneRecords.values());
  const norm = (path: string) => path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const match = Object.values(get(structuredSessions))
    .filter((record) =>
      record.origin === 'converted' &&
      !record.archived &&
      record.projectId === projectId &&
      record.preset === preset &&
      norm(record.cwd) === norm(cwd) &&
      record.lifecycle !== 'closed' &&
      !linked.has(record.id) &&
      !restoring.has(record.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!match) return null;
  restoring.add(match.id);
  return match;
}

/** Reconnect a claimed conversation in an idle agent pane. */
export async function restoreStructuredInChat(paneId: number, record: StructuredSessionRecord): Promise<boolean> {
  startSessionStore();
  try {
    pendingLinks.set(paneId, record.id);
    markStructuredChatPane(paneId, record.provider, record.preset ?? undefined);
    if (record.title) updateSessionTitle(paneId, record.title);
    await openRecordInPane(paneId, record);
    await restoreRecordSubagents(paneId, record);
    return structuredChatProvider(record.provider)?.get(paneId)?.status !== 'failed';
  } catch (error) {
    console.warn('Could not restore converted chat', record.id, error);
    patchRecord(record.id, { lifecycle: 'failed' });
    return false;
  } finally {
    restoring.delete(record.id);
  }
}

/**
 * A claimed converted record whose pane came back as its CLI: link it to that
 * pane, so a later Continue in chat keeps the same record and journal.
 */
export function adoptConvertedPane(paneId: number, recordId: string): void {
  restoring.delete(recordId);
  formerRecords.set(paneId, recordId);
  patchRecord(recordId, { view: 'terminal', lifecycle: 'detached' });
}

/** For tests: forget in-memory state. */
export function __resetSessionStoreForTests(): void {
  for (const paneId of [...attachments.keys()]) {
    attachments.get(paneId)?.unsubscribe();
  }
  attachments.clear();
  paneRecords.clear();
  pendingLinks.clear();
  formerRecords.clear();
  switchingPanes.clear();
  restoring.clear();
  journals.clear();
  dirtyJournals.clear();
  nextVirtualPaneId = -1000;
  structuredSessions.set({});
  shuttingDown = false;
}

// ---------------------------------------------------------------------------
// Standalone (outside-of-project) structured records & migration
// ---------------------------------------------------------------------------

export function createStandaloneStructuredRecord(opts: {
  id?: string;
  provider?: StructuredChatAgent;
  model?: string | null;
  effort?: string | null;
  cwd?: string;
  workspaceId?: string | null;
  title?: string | null;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
} = {}): StructuredSessionRecord {
  startSessionStore();
  const provider = opts.provider ?? 'claude';
  const preset = commandForAgent(provider);
  const now = opts.createdAt ?? Date.now();
  const record: StructuredSessionRecord = {
    id: opts.id ?? newRecordId(),
    provider,
    nativeSessionId: null,
    preset,
    accountId: accountFor(preset),
    accountLabel: activeAccount(get(accountsState), provider)?.label ?? null,
    cwd: opts.cwd ?? '.',
    projectId: null,
    standalone: true,
    standaloneWorkspaceId: opts.workspaceId ?? null,
    pinned: Boolean(opts.pinned),
    origin: 'chat',
    view: 'chat',
    lifecycle: 'detached',
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    // Outside a project nothing is set up to be changed, so ask before acting.
    access: 'ask',
    turnId: null,
    lastSeq: 0,
    title: opts.title ?? null,
    titleAuto: !opts.title,
    handoffFrom: null,
    handoffTo: [],
    createdAt: now,
    updatedAt: opts.updatedAt ?? now,
  };
  structuredSessions.update((all) => ({ ...all, [record.id]: record }));
  scheduleSave();
  return record;
}

export function listStandaloneStructuredRecords(state?: Record<string, StructuredSessionRecord>): StructuredSessionRecord[] {
  const all = state ?? get(structuredSessions);
  return Object.values(all)
    .filter((record) => record.standalone === true && !record.side && !record.archived)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export function updateStandaloneStructuredRecord(
  recordId: string,
  patch: Partial<Pick<StructuredSessionRecord, 'title' | 'titleAuto' | 'pinned' | 'provider' | 'preset' | 'model' | 'effort' | 'access' | 'cwd' | 'standaloneWorkspaceId' | 'standalone' | 'projectId' | 'nativeSessionId' | 'forkSourceId' | 'seedContext' | 'lifecycle'>>,
): boolean {
  const existing = get(structuredSessions)[recordId];
  if (!existing) return false;
  patchRecord(recordId, patch);
  return true;
}

/**
 * Choose the agent and model of a standalone chat that has no running pane. A
 * different agent cannot resume the old one's conversation or use its account, so
 * it starts fresh and is handed the history instead.
 */
export function retargetStandaloneRecord(
  recordId: string,
  agent: StructuredChatAgent,
  options: { model?: string | null; effort?: string | null } = {},
): void {
  const record = get(structuredSessions)[recordId];
  if (!record) return;
  const preset = commandForAgent(agent);
  patchRecord(recordId, {
    provider: agent,
    preset,
    model: options.model ?? null,
    effort: options.effort ?? null,
    ...(agent === record.provider ? {} : {
      accountId: accountFor(preset),
      accountLabel: activeAccount(get(accountsState), agent)?.label ?? null,
      nativeSessionId: null,
      forkSourceId: null,
      seedContext: journalFor(record).snapshot().items.some((item) => item.kind === 'user'),
    }),
  });
}

export function findPaneForRecord(recordId: string): number | null {
  for (const [paneId, id] of paneRecords.entries()) {
    if (id === recordId) return paneId;
  }
  return null;
}

export function recordItemsSnapshot(recordId: string): import('$lib/services/terminal-chat').TerminalChatItem[] {
  const record = get(structuredSessions)[recordId];
  if (!record) return [];
  return journalFor(record).snapshot().items;
}

export async function attachStandaloneRecordToPane(
  paneId: number,
  recordId: string,
  opts: { startProvider?: boolean } = {},
): Promise<boolean> {
  startSessionStore();
  const record = get(structuredSessions)[recordId];
  const provider = record ? structuredChatProvider(record.provider) : null;
  if (!record || !provider) return false;

  const existingState = provider.get(paneId);
  // An agent already bound to this pane holds its own turns. Reloading the
  // journal (which has them too) beside it would show the thread twice.
  const bound = paneRecords.get(paneId) === recordId && existingState !== null;
  if (bound && (!opts.startProvider || existingState.status === 'ready' || existingState.status === 'working')) {
    return true;
  }

  setStructuredChatHistory(paneId, journalFor(record).snapshot().items);

  if (!opts.startProvider) return true;

  pendingLinks.set(paneId, recordId);
  markStructuredChatPane(paneId, record.provider, record.preset ?? commandForAgent(record.provider), 'chat');
  try {
    await openRecordInPane(paneId, get(structuredSessions)[recordId] ?? record);
    return provider.get(paneId)?.status !== 'failed';
  } catch {
    patchRecord(recordId, { lifecycle: 'failed' });
    return false;
  }
}

export async function deleteStandaloneStructuredRecord(recordId: string): Promise<boolean> {
  const existing = get(structuredSessions)[recordId];
  if (!existing) return false;
  const paneId = findPaneForRecord(recordId);
  if (paneId !== null) {
    const attachment = attachments.get(paneId);
    if (attachment) {
      if (attachment.timer) clearTimeout(attachment.timer);
      attachment.unsubscribe();
      attachments.delete(paneId);
    }
    paneRecords.delete(paneId);
    const provider = structuredChatProvider(existing.provider);
    await provider?.close(paneId).catch(() => {});
    structuredChatHistory.update((all) => {
      if (!(paneId in all)) return all;
      const next = { ...all };
      delete next[paneId];
      return next;
    });
    structuredChatPanes.update((panes) => {
      if (!(paneId in panes)) return panes;
      const next = { ...panes };
      delete next[paneId];
      return next;
    });
  }
  const store = storage();
  try { store?.removeItem(JOURNAL_PREFIX + recordId); } catch { /* ignore */ }
  idbJournals.delete(recordId);
  journals.delete(recordId);
  dirtyJournals.delete(recordId);
  if (idbUsable) void idbDelete(JOURNAL_PREFIX + recordId).catch(() => {});
  structuredSessions.update((all) => {
    const next = { ...all };
    delete next[recordId];
    return next;
  });
  flushSessionStore();
  return true;
}

const LEGACY_MIGRATION_FLAG = 'spacron_standalone_structured_migrated_v1';

export interface LegacyStandaloneThreadInput {
  id: string;
  title: string;
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  pinned?: boolean;
  standaloneWorkspaceId?: string | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface LegacyStandaloneMessageInput {
  id: string;
  role: string;
  type?: string;
  text: string;
  ts: number;
  pending?: boolean;
}

/**
 * One-time, non-destructive migration from legacy standalone `chatThreads`
 * records into `StructuredSessionRecord` + `StructuredEventJournal`.
 */
export function migrateLegacyStandaloneRecords(
  threads: readonly LegacyStandaloneThreadInput[],
  messagesByThread: Record<string, readonly LegacyStandaloneMessageInput[]>,
  defaultProvider: StructuredChatAgent = 'claude',
): number {
  const store = storage();
  if (store?.getItem(LEGACY_MIGRATION_FLAG) === '1') return 0;

  const existingIds = new Set(Object.keys(get(structuredSessions)));
  let migrated = 0;

  for (const thread of threads) {
    const messages = (messagesByThread[thread.id] ?? []).filter(
      (m) => !m.pending && (m.role === 'user' || m.role === 'assistant') && m.text.trim(),
    );
    if (!messages.length) continue;
    const recordId = `ss_legacy_${thread.id}`;
    if (existingIds.has(recordId)) continue;

    const provider = defaultProvider;
    const record = createStandaloneStructuredRecord({
      id: recordId,
      provider,
      model: null,
      effort: null,
      cwd: '.',
      workspaceId: thread.standaloneWorkspaceId ?? thread.id,
      title: thread.title === 'New thread' ? null : thread.title,
      pinned: Boolean(thread.pinned),
      createdAt: thread.createdAt,
      updatedAt: thread.lastActivityAt,
    });

    const drafts = messages.map((msg) => ({
      type: (msg.role === 'user' ? 'user.message' : 'assistant.text') as 'user.message' | 'assistant.text',
      payload: {
        item: {
          id: msg.id,
          kind: (msg.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          text: msg.text,
          time: new Date(msg.ts).toISOString(),
        },
      },
    }));

    journalFor(record).record(drafts);
    dirtyJournals.add(record.id);
    patchRecord(record.id, {
      seedContext: messages.some((m) => m.role === 'user'),
      lastSeq: journalFor(record).lastSeq,
      titleAuto: thread.title === 'New thread',
    });
    migrated += 1;
  }

  try { store?.setItem(LEGACY_MIGRATION_FLAG, '1'); } catch { /* ignore */ }
  if (migrated > 0) flushSessionStore();
  return migrated;
}

/**
 * Delete chats whose last activity is before `cutoff`, with their journals.
 * Chats open in a pane, and chats that are starting or working, are kept.
 */
export function pruneStructuredSessions(cutoff: number): number {
  const live = new Set(paneRecords.values());
  const doomed = Object.values(get(structuredSessions)).filter((record) =>
    record.updatedAt > 0 && record.updatedAt < cutoff && !live.has(record.id) && !record.pinned
    && record.lifecycle !== 'working' && record.lifecycle !== 'starting');
  if (!doomed.length) return 0;
  const store = storage();
  for (const record of doomed) {
    try { store?.removeItem(JOURNAL_PREFIX + record.id); } catch { /* ignore */ }
    idbJournals.delete(record.id);
    journals.delete(record.id);
    dirtyJournals.delete(record.id);
    if (idbUsable) void idbDelete(JOURNAL_PREFIX + record.id).catch(() => {});
  }
  const gone = new Set(doomed.map((record) => record.id));
  structuredSessions.update((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !gone.has(id))));
  flushSessionStore();
  return doomed.length;
}
