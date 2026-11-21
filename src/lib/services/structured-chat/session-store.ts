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
import { get, writable } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import {
  createTerminalSession,
  getActiveTerminalProjectId,
  getSessionRoot,
  sessions,
  updateSessionTitle,
} from '$lib/stores/terminal';
import {
  markStructuredChatPane,
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
  cwd: string;
  projectId: string | null;
  /** `chat`: opened as a chat. `converted`: a CLI pane switched into chat. */
  origin: 'chat' | 'converted';
  view: 'chat' | 'terminal';
  lifecycle: StructuredLifecycle;
  model: string | null;
  effort: string | null;
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
    const raw = storage()?.getItem(JOURNAL_PREFIX + id);
    const parsed = raw ? JSON.parse(raw) as PersistedJournal : null;
    return parsed?.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export const structuredSessions = writable<Record<string, StructuredSessionRecord>>(loadRecords());

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
  const kept = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS);
  const keptIds = new Set(kept.map((record) => record.id));
  try {
    store.setItem(RECORDS_KEY, JSON.stringify(Object.fromEntries(kept.map((record) => [record.id, record]))));
  } catch {
    // Quota: the records stay in memory for this run.
  }
  for (const id of Object.keys(all)) {
    if (!keptIds.has(id)) {
      try { store.removeItem(JOURNAL_PREFIX + id); } catch { /* ignore */ }
      journals.delete(id);
    }
  }
  for (const id of dirtyJournals) {
    const journal = journals.get(id);
    if (!journal || !keptIds.has(id)) continue;
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
let shuttingDown = false;

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
      if (get(chatModelNames) && first) void upgradeTitleWithModel(paneId, record.id, named, first.text);
    }
  }
  const changed = added.length > 0 || (Object.keys(patch) as (keyof StructuredSessionRecord)[]).some((key) => patch[key] !== record[key]);
  if (!changed) return;
  if (added.length) dirtyJournals.add(record.id);
  patchRecord(record.id, patch);
  if (patch.title) updateSessionTitle(paneId, patch.title);
  for (const listener of eventListeners) {
    for (const event of added) listener(paneId, event);
  }
}

/** Chats a model name has already been requested for, so it is asked once. */
const modelNamed = new Set<string>();

/**
 * Opt-in (`chatModelNames`): replace the first-message name with a short model
 * title. The first-message name is already in place, so a failed or slow request
 * costs nothing, and a rename made meanwhile is respected (the title must still
 * be the one we set).
 */
async function upgradeTitleWithModel(paneId: number, recordId: string, placeholder: string, firstMessage: string): Promise<void> {
  if (modelNamed.has(recordId)) return;
  modelNamed.add(recordId);
  try {
    const { generateAiThreadTitle } = await import('$lib/stores/chatThreads');
    const title = (await generateAiThreadTitle(firstMessage)).trim();
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
      cwd: getSessionRoot(paneId) ?? '.',
      projectId: getActiveTerminalProjectId(),
      origin: info?.agentPreset ? 'converted' : 'chat',
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
  const attachment = attachments.get(paneId);
  if (!attachment) return;
  if (attachment.timer) clearTimeout(attachment.timer);
  recordState(paneId);
  attachment.unsubscribe();
  attachments.delete(paneId);
  paneRecords.delete(paneId);
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

async function openRecordInPane(paneId: number, record: StructuredSessionRecord): Promise<void> {
  const provider = structuredChatProvider(record.provider);
  if (!provider) throw new Error(`No structured chat provider for ${record.provider}`);
  const access = record.access ?? structuredAccessFor(record.preset ?? record.provider);
  const journal = journalFor(record);
  setStructuredChatHistory(paneId, journal.snapshot().items);
  await provider.start(paneId, record.cwd, { resumeId: record.nativeSessionId, access });
  let state = provider.get(paneId);
  if (record.nativeSessionId && (!state || state.status === 'failed')) {
    // The native conversation is gone (expired, deleted, other account):
    // start a new one rather than leave the pane dead. The journal still
    // shows everything said so far as history.
    await provider.close(paneId).catch(() => {});
    await provider.start(paneId, record.cwd, { access });
    state = provider.get(paneId);
    patchRecord(record.id, { restoredMode: 'journal-only' });
  } else if (record.nativeSessionId && state?.status !== 'failed') {
    patchRecord(record.id, { restoredMode: 'native' });
  } else {
    patchRecord(record.id, { restoredMode: 'fresh' });
  }
  if (state?.status === 'ready' || state?.status === 'working') {
    if (record.model && state.model !== record.model) provider.setModel(paneId, record.model);
    if (record.effort && state.effort !== record.effort) provider.setEffort(paneId, record.effort);
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

/**
 * Reopen this project's open chat sessions from the previous run. Each comes
 * back in a fresh pane, resumed by its native id, with its journaled
 * conversation shown as history.
 */
export async function restoreStructuredSessions(projectId: string): Promise<number> {
  startSessionStore();
  const linked = new Set(paneRecords.values());
  const candidates = Object.values(get(structuredSessions)).filter((record) =>
    record.projectId === projectId &&
    record.origin === 'chat' &&
    !record.archived &&
    record.view === 'chat' &&
    record.lifecycle !== 'closed' &&
    !linked.has(record.id) &&
    !restoring.has(record.id) &&
    structuredChatProvider(record.provider));
  let restored = 0;
  for (const record of candidates) {
    restoring.add(record.id);
    try {
      const paneId = await createTerminalSession(record.cwd, undefined, projectId, {
        assignPane: false,
        agentPreset: record.preset ?? record.provider,
      });
      if (paneId === null) continue;
      pendingLinks.set(paneId, record.id);
      markStructuredChatPane(paneId, record.provider, record.preset ?? undefined);
      updateSessionTitle(paneId, record.title ?? `${structuredChatProvider(record.provider)?.label ?? 'Agent'} Chat`);
      await openRecordInPane(paneId, record);
      await restoreRecordSubagents(paneId, record);
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
  await provider?.answerApproval(paneId, requestId, decision, optionId);
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
  patchRecord(record.id, { nativeSessionId: null, lifecycle: 'starting', turnId: null });
  setStructuredChatHistory(paneId, []);
  await provider.start(paneId, record.cwd, { access: record.access ?? structuredAccessFor(record.preset ?? record.provider) });
  return provider.get(paneId)?.status !== 'failed';
}

/** Earlier conversations, newest first. */
export function listStructuredSessions(filter: { projectId?: string | null; provider?: string; includeArchived?: boolean } = {}): StructuredSessionRecord[] {
  return Object.values(get(structuredSessions))
    .filter((record) => (filter.includeArchived || !record.archived)
      && (filter.projectId == null || record.projectId === filter.projectId)
      && (!filter.provider || record.provider === filter.provider))
    .sort((a, b) => b.updatedAt - a.updatedAt);
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

  if (provider.capabilities?.fork && provider.fork) {
    try {
      const res = await provider.fork(paneId);
      if (typeof res === 'object' && res.nativeSessionId && res.nativeSessionId !== current.nativeSessionId) {
        nativeSessionId = res.nativeSessionId;
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
    forkedFrom: current.id,
    forkMode,
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
    patchRecord(current.id, { lastSeq: 0, updatedAt: Date.now() });

    // If the provider lacks native rollback RPC, restart the process with
    // clean state so its token context window does not retain the undone turn.
    if (!nativeOk) {
      const attachment = attachments.get(paneId);
      if (attachment && provider.close && provider.start) {
        attachment.last = null;
        await provider.close(paneId).catch(() => {});
        patchRecord(current.id, { nativeSessionId: null, lifecycle: 'starting', turnId: null });
        await provider.start(paneId, current.cwd, {
          access: current.access ?? structuredAccessFor(current.preset ?? current.provider),
        }).catch(() => {});
      }
    }

    scheduleSave();
    return true;
  }
  return nativeOk;
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

/** Bring a claimed converted record back as a chat in an idle agent pane. */
export async function restoreConvertedInChat(paneId: number, record: StructuredSessionRecord): Promise<boolean> {
  startSessionStore();
  try {
    pendingLinks.set(paneId, record.id);
    markStructuredChatPane(paneId, record.provider, record.preset ?? undefined);
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
  restoring.clear();
  journals.clear();
  dirtyJournals.clear();
  structuredSessions.set({});
  shuttingDown = false;
}
