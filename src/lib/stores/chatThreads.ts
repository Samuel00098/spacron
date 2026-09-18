import { deleteAgentCheckpoint } from '$lib/services/orchestrator/agent-checkpoints';
import { derived, get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';
import { invoke } from '@tauri-apps/api/core';
import {
  aiProvider,
  currentAiModel,
  isLocalProvider,
  getProviderDef,
  getProviderBaseUrl,
  type AiProviderId,
} from '$lib/stores/settings';
import { providerApiKeyExists } from '$lib/services/ai-keychain';
import type {
  ChatCompletion,
  ChatDispatchReference,
  ChatMessage,
  ChatMessageRole,
  ChatMessageType,
  ChatThread,
  ChatThreadState,
  ChatThreadStatus,
  ChatProviderId,
  ChatAccessMode,
  ChatReasoningEffort,
  ChatAttachment,
} from '$lib/types/chat';

export type {
  ChatCompletion,
  ChatDispatchReference,
  ChatMessage,
  ChatMessageRole,
  ChatMessageType,
  ChatThread,
  ChatThreadState,
  ChatThreadStatus,
  ChatProviderId,
  ChatAccessMode,
  ChatReasoningEffort,
  ChatAttachment,
} from '$lib/types/chat';

export const CHAT_THREADS_STORAGE_KEY = 'spacron_chat_threads_v1';
export const LEGACY_CHAT_STORAGE_KEY = 'spacron_orchestrator_chat';

type LegacyChatMessage = {
  id?: unknown;
  role?: unknown;
  text?: unknown;
  ts?: unknown;
  pending?: unknown;
  dispatched?: unknown;
  dispatchedTaskId?: unknown;
  dispatchedAgent?: unknown;
  reconSummary?: unknown;
  completion?: unknown;
  [key: string]: unknown;
};

export interface LegacyChatByProject {
  [projectId: string]: LegacyChatMessage[];
}

export const EMPTY_CHAT_THREAD_STATE: ChatThreadState = {
  version: 1,
  threadsByProject: {},
  messagesByThread: {},
  activeThreadByProject: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asProvider(value: unknown): ChatProviderId | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asAccessMode(value: unknown): ChatAccessMode {
  return value === 'supervised' || value === 'auto-edits' || value === 'auto' || value === 'full-access'
    ? value
    : 'inherit';
}

function asReasoningEffort(value: unknown): ChatReasoningEffort {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' ||
    value === 'xhigh' || value === 'max' || value === 'ultra'
    ? value
    : 'default';
}

function asLegacyMessages(value: unknown): LegacyChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord) as LegacyChatMessage[];
}

function threadIdForProject(projectId: string): string {
  return `chat-thread-${projectId}-default`;
}

function messageType(message: LegacyChatMessage): ChatMessageType {
  const inlineRequest = copyInlineRequest(message.inlineRequest);
  if (inlineRequest) return inlineRequest.type === 'approval' ? 'approval' : 'input';
  if (isRecord(message.completion)) {
    const completionStatus = message.completion.status;
    return completionStatus === 'failed' ? 'failure' : 'completion';
  }
  if (message.type === 'activity' || message.type === 'failure' || message.type === 'orchestrator') return message.type;
  if (message.pending === true) return 'agent';
  return message.role === 'user' ? 'user' : 'agent';
}

function messageRole(message: LegacyChatMessage): ChatMessageRole {
  if (message.role === 'user') return 'user';
  return 'assistant';
}

function copyCompletion(value: unknown): ChatCompletion | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== 'done' && status !== 'failed' && status !== 'blocked') return null;
  const agentName = asString(value.agentName) ?? 'Agent';
  const taskTitle = asString(value.taskTitle) ?? 'Agent task';
  const elapsedSec = asNumber(value.elapsedSec);
  return {
    status,
    agentName,
    taskTitle,
    elapsedSec,
    reason: asString(value.reason),
    summary: asString(value.summary),
    summaryPending: value.summaryPending === true,
    endedBy:
      value.endedBy === 'declared' || value.endedBy === 'exit' || value.endedBy === 'inferred'
        ? value.endedBy
        : undefined,
    silent: value.silent === true,
    taskId: asString(value.taskId),
  };
}

function copyDispatches(value: unknown): ChatDispatchReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dispatches: ChatDispatchReference[] = [];
  for (const entry of value.filter(isRecord)) {
      const taskId = asString(entry.taskId);
      const agent = asString(entry.agent);
      const via = entry.via === 'send' ? 'send' : entry.via === 'spawn' ? 'spawn' : null;
      if (!taskId || !agent || !via) continue;
      dispatches.push({ taskId, agent, name: asString(entry.name), via });
  }
  return dispatches.length ? dispatches : undefined;
}

function copyInlineRequest(value: unknown): ChatMessage['inlineRequest'] {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const type = value.type;
  const prompt = asString(value.prompt);
  if (!id || !prompt || (type !== 'approval' && type !== 'choice' && type !== 'text' && type !== 'terminal' && type !== 'dismiss')) {
    return null;
  }
  const options = Array.isArray(value.options)
    ? value.options
        .filter(isRecord)
        .map((option) => {
          const optionId = asString(option.id);
          const label = asString(option.label);
          return optionId && label
            ? { id: optionId, label, value: asString(option.value) ?? undefined, description: asString(option.description) ?? undefined, destructive: option.destructive === true }
            : null;
        })
        .filter((option): option is NonNullable<typeof option> => option !== null)
    : undefined;
  return {
    id,
    type,
    prompt,
    options,
    placeholder: asString(value.placeholder) ?? undefined,
    taskId: asString(value.taskId),
    sessionId: asNumber(value.sessionId),
    answeredAt: asNumber(value.answeredAt),
    answer: asString(value.answer),
    inputMode: value.inputMode === 'line' ? 'line' : 'prompt',
  };
}

function copyAttachments(value: unknown): ChatAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value
    .filter(isRecord)
    .map((entry) => {
      const id = asString(entry.id);
      const name = asString(entry.name);
      const type = asString(entry.type);
      const size = asNumber(entry.size);
      if (!id || !name || !type || size == null) return null;
      const text = asString(entry.text);
      return { id, name, type, size, ...(text != null ? { text } : {}) } satisfies ChatAttachment;
    })
    .filter((entry): entry is ChatAttachment => entry !== null);
  return attachments.length ? attachments : undefined;
}

function migrateMessage(threadId: string, raw: LegacyChatMessage, index: number, now: number): ChatMessage {
  const id = asString(raw.id) ?? `${threadId}-message-${index}`;
  const ts = asNumber(raw.ts) ?? now;
  const knownKeys = new Set([
    'id', 'role', 'text', 'ts', 'pending', 'dispatched', 'dispatchedTaskId',
    'dispatchedAgent', 'reconSummary', 'completion', 'inlineRequest', 'attachments',
  ]);
  const legacy = Object.fromEntries(Object.entries(raw).filter(([key]) => !knownKeys.has(key)));
  return {
    id,
    threadId,
    type: messageType(raw),
    role: messageRole(raw),
    text: asString(raw.text) ?? '',
    ts,
    pending: raw.pending === true,
    dispatched: copyDispatches(raw.dispatched),
    dispatchedTaskId: asString(raw.dispatchedTaskId),
    dispatchedAgent: asString(raw.dispatchedAgent),
    reconSummary: asString(raw.reconSummary),
    completion: copyCompletion(raw.completion),
    inlineRequest: copyInlineRequest(raw.inlineRequest),
    attachments: copyAttachments(raw.attachments),
    ...(Object.keys(legacy).length ? { legacy } : {}),
  };
}

function createDefaultThread(projectId: string, messages: ChatMessage[], now: number): ChatThread {
  const firstTs = messages[0]?.ts ?? now;
  const lastActivityAt = messages[messages.length - 1]?.ts ?? firstTs;
  const lastMessage = messages[messages.length - 1];
  const status: ChatThreadStatus = lastMessage?.completion
    ? lastMessage.completion.status === 'blocked'
      ? 'needs-input'
      : lastMessage.completion.status === 'failed'
        ? 'failed'
        : 'complete'
    : messages.length
      ? 'idle'
      : 'draft';
  return {
    id: threadIdForProject(projectId),
    projectId,
    title: 'General',
    agentName: lastMessage?.completion?.agentName ?? null,
    agentPreset: null,
    provider: null,
    model: null,
    accessMode: 'inherit',
    reasoningEffort: 'default',
    taskId: lastMessage?.completion?.taskId ?? null,
    sessionId: null,
    status,
    createdAt: firstTs,
    updatedAt: lastActivityAt,
    lastActivityAt,
    unreadCount: 0,
    draft: '',
  };
}

/**
 * Pure one-time migration from the legacy project-level chat map. Invalid
 * entries are skipped, but valid messages retain their ids, text, timestamps,
 * dispatch metadata, completion cards, and unknown fields.
 */
export function migrateLegacyChat(legacy: unknown, now = Date.now()): ChatThreadState {
  const state: ChatThreadState = {
    version: 1,
    threadsByProject: {},
    messagesByThread: {},
    activeThreadByProject: {},
  };
  if (!isRecord(legacy)) return state;

  for (const [projectId, rawMessages] of Object.entries(legacy)) {
    if (!projectId) continue;
    const messages = asLegacyMessages(rawMessages)
      // The narration-derived plan card is deleted — a turn's plan has exactly
      // one surface now, the update_todos ticker. Old transcripts still carry
      // these rows; drop them rather than migrate a card nothing produces. Kept
      // as null-then-filter so `index` still aligns with the raw array for the
      // id fallback of messages that never had one.
      .map((message, index) => (message.type === 'plan' ? null : migrateMessage(threadIdForProject(projectId), message, index, now)))
      .filter((message): message is ChatMessage => message !== null);
    const threadId = threadIdForProject(projectId);
    state.threadsByProject[projectId] = [createDefaultThread(projectId, messages, now)];
    state.messagesByThread[threadId] = messages;
    state.activeThreadByProject[projectId] = threadId;
  }
  return state;
}

function normalizeThread(raw: unknown, projectId: string, index: number, now: number): ChatThread | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id) ?? `${threadIdForProject(projectId)}-${index}`;
  const status = raw.status;
  const validStatus: ChatThreadStatus =
    status === 'draft' || status === 'idle' || status === 'working' || status === 'needs-input' ||
    status === 'complete' || status === 'failed' || status === 'archived'
      ? status
      : 'idle';
  const createdAt = asNumber(raw.createdAt) ?? now;
  const updatedAt = asNumber(raw.updatedAt) ?? createdAt;
  return {
    id,
    projectId,
    title: asString(raw.title) || 'New thread',
    agentName: asString(raw.agentName),
    agentPreset: asString(raw.agentPreset),
    provider: asProvider(raw.provider),
    model: asString(raw.model),
    accessMode: asAccessMode(raw.accessMode),
    reasoningEffort: asReasoningEffort(raw.reasoningEffort),
    taskId: asString(raw.taskId),
    sessionId: asNumber(raw.sessionId),
    status: validStatus,
    createdAt,
    updatedAt,
    lastActivityAt: asNumber(raw.lastActivityAt) ?? updatedAt,
    turnEndedAt: asNumber(raw.turnEndedAt) ?? undefined,
    unreadCount: Math.max(0, Math.floor(asNumber(raw.unreadCount) ?? 0)),
    draft: asString(raw.draft) ?? '',
    pinned: raw.pinned === true,
    order: asNumber(raw.order) ?? undefined,
    agentCheckpoint: isRecord(raw.agentCheckpoint) && Array.isArray(raw.agentCheckpoint.exchanges) && Array.isArray(raw.agentCheckpoint.results)
      && typeof raw.agentCheckpoint.provider === 'string' && typeof raw.agentCheckpoint.model === 'string' && typeof raw.agentCheckpoint.summary === 'string'
      ? raw.agentCheckpoint as unknown as ChatThread['agentCheckpoint'] : undefined,
    agentBudgets: isRecord(raw.agentBudgets) ? Object.fromEntries(Object.entries(raw.agentBudgets).filter(([key, value]) =>
      (['contextChars', 'outputTokens', 'maxRounds'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (key === 'toolMode' && (value === 'native' || value === 'text')))) : undefined,
  };
}

function normalizeState(raw: unknown, now = Date.now()): ChatThreadState | null {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.threadsByProject) || !isRecord(raw.messagesByThread)) {
    return null;
  }
  const state: ChatThreadState = {
    version: 1,
    threadsByProject: {},
    messagesByThread: {},
    activeThreadByProject: isRecord(raw.activeThreadByProject)
      ? Object.fromEntries(
          Object.entries(raw.activeThreadByProject).map(([projectId, threadId]) => [projectId, asString(threadId)]),
        )
      : {},
  };
  for (const [projectId, threads] of Object.entries(raw.threadsByProject)) {
    if (!Array.isArray(threads)) continue;
    const normalized = threads
      .map((thread, index) => normalizeThread(thread, projectId, index, now))
      .filter((thread): thread is ChatThread => thread !== null);
    if (normalized.length) state.threadsByProject[projectId] = normalized;
  }
  for (const [threadId, messages] of Object.entries(raw.messagesByThread)) {
    if (!Array.isArray(messages)) continue;
    state.messagesByThread[threadId] = messages
      .filter(isRecord)
      .map((message, index): ChatMessage | null => {
        const type = message.type;
        // LEGACY: strip the deleted narration-derived plan card (see the note in
        // migrateLegacyChat). Null-then-filter keeps `index` aligned with the
        // raw array, so the id fallback never shifts for later messages.
        if (type === 'plan') return null;
        const role = message.role;
        const legacy = isRecord(message.legacy) ? message.legacy : undefined;
        return {
          id: asString(message.id) ?? `${threadId}-message-${index}`,
          threadId,
          type:
            type === 'user' || type === 'agent' || type === 'orchestrator' ||
            type === 'activity' || type === 'approval' || type === 'input' || type === 'completion' ||
            type === 'failure' || type === 'system' ? type : 'system',
          role: role === 'user' || role === 'assistant' || role === 'orchestrator' || role === 'system' ? role : 'system',
          text: asString(message.text) ?? '',
          ts: asNumber(message.ts) ?? now,
          pending: message.pending === true,
          dispatched: copyDispatches(message.dispatched),
          dispatchedTaskId: asString(message.dispatchedTaskId),
          dispatchedAgent: asString(message.dispatchedAgent),
          reconSummary: asString(message.reconSummary),
          completion: copyCompletion(message.completion),
          inlineRequest: copyInlineRequest(message.inlineRequest),
          attachments: copyAttachments(message.attachments),
          ...(legacy ? { legacy } : {}),
        } satisfies ChatMessage;
      })
      .filter((message): message is ChatMessage => message !== null);
  }
  return state;
}

function persistState(state: ChatThreadState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAT_THREADS_STORAGE_KEY, JSON.stringify(state, (key, value) => key === 'agentCheckpoint' ? undefined : value));
  } catch {
    // Storage is best effort; live state remains usable when quota is full.
  }
}

function loadInitialState(): ChatThreadState {
  const stored = normalizeState(loadJson<unknown>(CHAT_THREADS_STORAGE_KEY, null));
  if (stored) return stored;
  const migrated = migrateLegacyChat(loadJson<unknown>(LEGACY_CHAT_STORAGE_KEY, {}));
  persistState(migrated);
  return migrated;
}

export const chatThreadState = writable<ChatThreadState>(loadInitialState());

chatThreadState.subscribe((state) => persistState(state));

// ── Live turn to-do ticker (ephemeral, never persisted) ───────────────────────
// When a turn starts executing, its plan prints as a small ticker box above the
// composer and items check off as tool rounds complete. This is presentation
// state only: it lives outside `chatThreadState` so refreshes never resurrect a
// stale checklist. A completed checklist remains visible until the next turn
// starts, where it is replaced or cleared.
export interface ChatTurnTicker {
  threadId: string;
  items: import('$lib/services/orchestrator/chat-turn').ChatTurnTodoItem[];
}

export const chatTurnTicker = writable<ChatTurnTicker | null>(null);

/** Start (or replace) the live ticker for a thread's turn. */
export function setChatTurnTicker(threadId: string, items: ChatTurnTicker['items']): void {
  chatTurnTicker.set({ threadId, items });
}

/** Advance the live ticker to the given progress (used while the turn runs). */
export function advanceChatTurnTicker(threadId: string, items: ChatTurnTicker['items']): void {
  chatTurnTicker.update((current) => (current && current.threadId === threadId ? { threadId, items } : current));
}

/** Clear the ticker when its thread's turn ends (or a new turn starts). */
export function clearChatTurnTicker(threadId?: string): void {
  chatTurnTicker.update((current) => (current && (!threadId || current.threadId === threadId) ? null : current));
}

// Back-fill AI summaries for threads that were created before, or without, the
// AI title generator (their title is still the 'New thread'/'General' placeholder
// or a first-line snippet from the old behavior).
void repairThreadSummaries();

export function getProjectThreads(projectId: string) {
  return derived(chatThreadState, (state) => state.threadsByProject[projectId] ?? []);
}

export function getChatThread(threadId: string): ChatThread | null {
  return Object.values(get(chatThreadState).threadsByProject)
    .flat()
    .find((thread) => thread.id === threadId) ?? null;
}

export function findThreadIdForTask(projectId: string, taskId: string): string | null {
  const state = get(chatThreadState);
  return (state.threadsByProject[projectId] ?? []).find((thread) => thread.taskId === taskId
    || (state.messagesByThread[thread.id] ?? []).some((message) => message.dispatched?.some((dispatch) => dispatch.taskId === taskId)))?.id ?? null;
}

/** Keep the final answer after the activity produced while it was pending. */
export function moveThreadMessageToEnd(threadId: string, messageId: string): void {
  chatThreadState.update((state) => {
    const messages = state.messagesByThread[threadId];
    const message = messages?.find((entry) => entry.id === messageId);
    if (!message || messages.at(-1)?.id === messageId) return state;
    return { ...state, messagesByThread: { ...state.messagesByThread, [threadId]: [...messages.filter((entry) => entry.id !== messageId), message] } };
  });
}

export function getThreadMessages(threadId: string) {
  return derived(chatThreadState, (state) => state.messagesByThread[threadId] ?? []);
}

/** Synchronous snapshot for orchestration code that is already inside a turn. */
export function getThreadMessageSnapshot(threadId: string): ChatMessage[] {
  return get(chatThreadState).messagesByThread[threadId] ?? [];
}

export function getActiveThreadId(projectId: string): string | null {
  const state = get(chatThreadState);
  const activeId = state.activeThreadByProject[projectId] ?? null;
  return activeId && (state.threadsByProject[projectId] ?? []).some((thread) => thread.id === activeId)
    ? activeId
    : null;
}

/** Return the selected thread, creating the migration-compatible General
 * thread for projects that have no chat history yet. */
export function ensureProjectThread(projectId: string, now = Date.now()): ChatThread {
  const state = get(chatThreadState);
  const existing = (state.threadsByProject[projectId] ?? []).find(
    (thread) => thread.id === state.activeThreadByProject[projectId],
  ) ?? state.threadsByProject[projectId]?.[0];
  if (existing) {
    if (state.activeThreadByProject[projectId] !== existing.id) selectChatThread(projectId, existing.id);
    return existing;
  }

  const thread = createDefaultThread(projectId, [], now);
  chatThreadState.update((current) => ({
    ...current,
    threadsByProject: { ...current.threadsByProject, [projectId]: [thread] },
    messagesByThread: { ...current.messagesByThread, [thread.id]: [] },
    activeThreadByProject: { ...current.activeThreadByProject, [projectId]: thread.id },
  }));
  return thread;
}

export function selectChatThread(projectId: string, threadId: string): boolean {
  const belongsToProject = (get(chatThreadState).threadsByProject[projectId] ?? []).some((thread) => thread.id === threadId);
  if (!belongsToProject) return false;
  chatThreadState.update((state) => ({
    ...state,
    activeThreadByProject: { ...state.activeThreadByProject, [projectId]: threadId },
    threadsByProject: {
      ...state.threadsByProject,
      [projectId]: (state.threadsByProject[projectId] ?? []).map((thread) =>
        thread.id === threadId ? { ...thread, unreadCount: 0 } : thread,
      ),
    },
  }));
  return true;
}

export function createChatThread(
  projectId: string,
  overrides: Partial<Pick<ChatThread, 'title' | 'agentName' | 'agentPreset' | 'provider' | 'model' | 'accessMode' | 'reasoningEffort' | 'taskId' | 'sessionId'>> = {},
  now = Date.now(),
): ChatThread {
  const id = `chat-thread-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const thread: ChatThread = {
    id,
    projectId,
    title: overrides.title?.trim() || 'New thread',
    agentName: overrides.agentName ?? null,
    agentPreset: overrides.agentPreset ?? null,
    provider: overrides.provider ?? null,
    model: overrides.model ?? null,
    accessMode: overrides.accessMode ?? 'inherit',
    reasoningEffort: overrides.reasoningEffort ?? 'default',
    taskId: overrides.taskId ?? null,
    sessionId: overrides.sessionId ?? null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    unreadCount: 0,
    draft: '',
  };
  chatThreadState.update((state) => ({
    ...state,
    threadsByProject: {
      ...state.threadsByProject,
      [projectId]: [...(state.threadsByProject[projectId] ?? []), thread],
    },
    messagesByThread: { ...state.messagesByThread, [id]: [] },
    activeThreadByProject: { ...state.activeThreadByProject, [projectId]: id },
  }));
  return thread;
}

export function updateChatThread(threadId: string, patch: Partial<ChatThread>): boolean {
  let updated = false;
  chatThreadState.update((state) => {
    const threadsByProject = { ...state.threadsByProject };
    for (const [projectId, threads] of Object.entries(threadsByProject)) {
      const index = threads.findIndex((thread) => thread.id === threadId);
      if (index < 0) continue;
      const next = { ...threads[index], ...patch, id: threadId, projectId };
      threadsByProject[projectId] = threads.map((thread, entryIndex) => (entryIndex === index ? next : thread));
      updated = true;
      break;
    }
    return updated ? { ...state, threadsByProject } : state;
  });
  return updated;
}

export function renameChatThread(threadId: string, title: string): boolean {
  const nextTitle = title.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!nextTitle) return false;
  return updateChatThread(threadId, { title: nextTitle, updatedAt: Date.now() });
}

export function toggleChatThreadPinned(threadId: string): boolean {
  const thread = getChatThread(threadId);
  if (!thread) return false;
  return updateChatThread(threadId, { pinned: !thread.pinned, updatedAt: Date.now() });
}

/** Remove a thread without silently creating a replacement conversation. */
export function deleteChatThread(threadId: string): boolean {
  void deleteAgentCheckpoint(threadId).catch(console.error);
  let deleted = false;
  chatThreadState.update((state) => {
    let ownerProjectId: string | null = null;
    let removedIndex = -1;
    for (const [projectId, threads] of Object.entries(state.threadsByProject)) {
      const index = threads.findIndex((thread) => thread.id === threadId);
      if (index >= 0) {
        ownerProjectId = projectId;
        removedIndex = index;
        break;
      }
    }
    if (!ownerProjectId) return state;
    deleted = true;
    const currentThreads = state.threadsByProject[ownerProjectId] ?? [];
    const remaining = currentThreads.filter((thread) => thread.id !== threadId);
    const nextThreads = remaining;
    const activeId = state.activeThreadByProject[ownerProjectId];
    const nextActiveId = nextThreads.length === 0
      ? null
      : activeId === threadId || !nextThreads.some((thread) => thread.id === activeId)
        ? nextThreads[Math.min(Math.max(removedIndex, 0), nextThreads.length - 1)].id
        : activeId;
    const messagesByThread = { ...state.messagesByThread };
    delete messagesByThread[threadId];
    return {
      ...state,
      threadsByProject: { ...state.threadsByProject, [ownerProjectId]: nextThreads },
      messagesByThread,
      activeThreadByProject: { ...state.activeThreadByProject, [ownerProjectId]: nextActiveId },
    };
  });
  return deleted;
}

export function setThreadDraft(threadId: string, draft: string): boolean {
  return updateChatThread(threadId, { draft, updatedAt: Date.now() });
}

export function appendThreadMessage(message: ChatMessage): boolean {
  const state = get(chatThreadState);
  const thread = Object.values(state.threadsByProject).flat().find((entry) => entry.id === message.threadId);
  if (!thread) return false;
  const isFirstTitleable = message.role === 'user' && (thread.title === 'New thread' || thread.title === 'General');
  const nextStatus: ChatThreadStatus = message.type === 'failure'
    ? 'failed'
    : message.type === 'approval' || message.type === 'input'
      ? 'needs-input'
      : message.role === 'user'
        ? 'working'
        : thread.status === 'draft'
          ? 'idle'
          : thread.status;
  chatThreadState.update((current) => ({
    ...current,
    messagesByThread: {
      ...current.messagesByThread,
      [message.threadId]: [...(current.messagesByThread[message.threadId] ?? []), message],
    },
    threadsByProject: Object.fromEntries(
      Object.entries(current.threadsByProject).map(([projectId, threads]) => [
        projectId,
        threads.map((entry) => entry.id === message.threadId
          ? { ...entry, status: nextStatus, updatedAt: message.ts, lastActivityAt: message.ts }
          : entry),
      ]),
    ),
  }));

  if (isFirstTitleable && message.text?.trim()) {
    void generateAiThreadTitle(message.text, thread.provider as AiProviderId | undefined, thread.model || undefined)
      .then((aiTitle) => {
        if (!aiTitle) return;
        renameChatThread(thread.id, aiTitle);
      })
      .catch((err) => {
        console.warn('AI thread title generation failed:', err);
      });
  }

  return true;
}

/** Turn the first user message into a compact, readable thread header. */
export function summarizeThreadMessage(text: string): string {
  const summary = text
    .split(/\r?\n/, 1)[0]
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/[>*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!summary) return '';
  return summary.length > 80 ? `${summary.slice(0, 77).trimEnd()}…` : summary;
}

/** Generate a concise, intelligent thread summary title using the configured AI provider. */
export async function generateAiThreadTitle(
  text: string,
  preferredProvider?: AiProviderId,
  preferredModel?: string,
): Promise<string> {
  const provider = preferredProvider ?? get(aiProvider);
  const providerDef = getProviderDef(provider);
  // Agent-session providers such as `claude` can still exist in legacy Chat
  // metadata, but they are not direct API providers for this completion path.
  if (providerDef.id !== provider) return '';
  const local = isLocalProvider(provider);
  const hasKey = local ? true : await providerApiKeyExists(provider, { fresh: true });
  const baseUrl = local ? getProviderBaseUrl(provider) : '';

  if (!local && !hasKey) {
    return '';
  }

  const model = preferredModel?.trim() || (provider === get(aiProvider)
    ? get(currentAiModel)
    : providerDef.defaultModel);

  const sample = text.trim().slice(0, 1000);
  if (!sample) return '';

  const systemPrompt =
    'You are a title generator. Generate a concise, natural, 3 to 7 word summary or title describing what this chat is about based on the user\'s first message. ' +
    'Do NOT prefix with "Title:", do NOT wrap in quotes, and do NOT add markdown punctuation or period at the end. Be concise, direct, and helpful.';

  try {
    const raw = await invoke<string>('ai_complete', {
      systemPrompt,
      userText: sample,
      provider,
      model,
      apiKey: '',
      baseUrl: baseUrl || undefined,
    });
    const cleaned = (raw || '')
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/^Title:\s*/i, '')
      .replace(/\r?\n.*$/s, '')
      .replace(/[.]+$/, '')
      .trim();
    return cleaned.length > 70 ? `${cleaned.slice(0, 67).trimEnd()}…` : cleaned;
  } catch (error) {
    console.warn('ai_complete failed for thread title generation:', error);
    return '';
  }
}

/**
 * Give every thread that has a first user message a real AI-generated summary
 * instead of a placeholder or first-line snippet. Only threads whose title is
 * still the placeholder ('New thread'/'General') or the old first-line
 * derivation are regenerated; AI-generated and manually set titles are left
 * alone, so editing messages in a thread never touches its summary.
 */
export async function repairThreadSummaries(): Promise<void> {
  const state = get(chatThreadState);
  const jobs: Promise<void>[] = [];
  for (const threads of Object.values(state.threadsByProject)) {
    for (const thread of threads) {
      const firstUser = (state.messagesByThread[thread.id] ?? []).find((message) => message.role === 'user');
      if (!firstUser?.text?.trim()) continue;
      const firstLineSnippet = summarizeThreadMessage(firstUser.text);
      if (thread.title !== 'New thread' && thread.title !== 'General' && firstLineSnippet !== thread.title) {
        continue;
      }
      jobs.push(
        generateAiThreadTitle(firstUser.text, thread.provider as AiProviderId | undefined, thread.model || undefined)
          .then((aiTitle) => {
            if (!aiTitle || !getChatThread(thread.id)) return;
            renameChatThread(thread.id, aiTitle);
          })
          .catch(() => {
            // Keep the placeholder; the next launch retries.
          }),
      );
    }
  }
  await Promise.all(jobs);
}

/**
 * Remove one message from a thread. Used by the voice bridge to drop a live
 * echo row when the orchestrator's own record of the same turn (which
 * `sendChatMessage` appends) supersedes it — without this, orchestrator voice
 * turns read twice in the transcript.
 */
export function removeThreadMessage(threadId: string, messageId: string): boolean {
  let removed = false;
  chatThreadState.update((current) => {
    const messages = current.messagesByThread[threadId] ?? [];
    if (!messages.some((entry) => entry.id === messageId)) return current;
    removed = true;
    return {
      ...current,
      messagesByThread: {
        ...current.messagesByThread,
        [threadId]: messages.filter((entry) => entry.id !== messageId),
      },
    };
  });
  return removed;
}

/**
 * Remove a message and every message after it (inclusive truncation). Used by
 * edit-and-resend so the stale reply to an edited user bubble — and any later
 * turns built on it — is replaced by the fresh turn instead of lingering
 * alongside a duplicate user message at the end.
 * Returns the removed ids (first entry is the anchor itself) or null when the
 * anchor message is not in the thread.
 */
export function removeThreadMessagesFrom(threadId: string, fromMessageId: string): { removedIds: string[]; removedLaterCount: number } | null {
  let result: { removedIds: string[]; removedLaterCount: number } | null = null;
  const now = Date.now();
  chatThreadState.update((current) => {
    const messages = current.messagesByThread[threadId] ?? [];
    const index = messages.findIndex((entry) => entry.id === fromMessageId);
    if (index < 0) return current;
    const removed = messages.slice(index);
    result = {
      removedIds: removed.map((entry) => entry.id),
      removedLaterCount: Math.max(0, removed.length - 1),
    };
    return {
      ...current,
      messagesByThread: {
        ...current.messagesByThread,
        [threadId]: messages.slice(0, index),
      },
      threadsByProject: Object.fromEntries(
        Object.entries(current.threadsByProject).map(([projectId, threads]) => [
          projectId,
          threads.map((thread) => thread.id === threadId
            ? { ...thread, updatedAt: now, lastActivityAt: now }
            : thread),
        ]),
      ),
    };
  });
  return result;
}

/** Mirror one legacy orchestrator message into its owning thread. */
export function appendLegacyChatMessage(
  projectId: string,
  raw: unknown,
  threadId?: string,
): string | null {
  const state = get(chatThreadState);
  if (threadId && !(state.threadsByProject[projectId] ?? []).some((thread) => thread.id === threadId)) {
    // A task can finish after its Chat thread was deleted. Do not resurrect a
    // default thread just to hold late output for a conversation the user chose
    // to remove.
    return null;
  }
  const rawRecord = isRecord(raw) ? raw : {};
  const completionTaskId = isRecord(rawRecord.completion) ? asString(rawRecord.completion.taskId) : null;
  const taskId = asString(rawRecord.dispatchedTaskId) ?? completionTaskId;
  const targetId = threadId
    ?? (taskId
      ? (state.threadsByProject[projectId] ?? []).find((thread) => thread.taskId === taskId)?.id
      : null)
    ?? state.activeThreadByProject[projectId]
    ?? (state.threadsByProject[projectId] ?? [])[0]?.id;
  if (!targetId) return null;
  const existing = state.messagesByThread[targetId] ?? [];
  const message = migrateMessage(
    targetId,
    rawRecord as LegacyChatMessage,
    existing.length,
    Date.now(),
  );
  if (existing.some((entry) => entry.id === message.id)) return targetId;
  appendThreadMessage(message);
  return targetId;
}

export function findThreadIdForMessage(projectId: string, messageId: string): string | null {
  const state = get(chatThreadState);
  const thread = (state.threadsByProject[projectId] ?? []).find((entry) =>
    (state.messagesByThread[entry.id] ?? []).some((message) => message.id === messageId),
  );
  return thread?.id ?? null;
}

export function patchThreadMessage(threadId: string, messageId: string, patch: Partial<ChatMessage>): boolean {
  let patched = false;
  chatThreadState.update((state) => {
    const messages = state.messagesByThread[threadId] ?? [];
    const currentMessage = messages.find((message) => message.id === messageId);
    if (!currentMessage) return state;
    patched = true;
    const nextMessage = { ...currentMessage, ...patch, threadId };
    const nextStatus: ChatThreadStatus | null = nextMessage.inlineRequest
      ? nextMessage.inlineRequest.answeredAt ? 'working' : 'needs-input'
      : nextMessage.completion
      ? nextMessage.completion.status === 'blocked'
        ? 'needs-input'
        : nextMessage.completion.status === 'failed'
          ? 'failed'
          : 'complete'
      : patch.dispatched?.length
        ? 'working'
        : patch.pending === false && nextMessage.type !== 'activity'
          ? 'idle'
          : null;
    return {
      ...state,
      messagesByThread: {
        ...state.messagesByThread,
        [threadId]: messages.map((message) => message.id === messageId ? nextMessage : message),
      },
      threadsByProject: nextStatus
        ? Object.fromEntries(
            Object.entries(state.threadsByProject).map(([projectId, threads]) => [
              projectId,
              threads.map((thread) => thread.id === threadId
                ? { ...thread, status: nextStatus, updatedAt: nextMessage.ts, lastActivityAt: nextMessage.ts }
                : thread),
            ]),
          )
        : state.threadsByProject,
    };
  });
  return patched;
}

/** Edit a stored message in place. The owning thread and its title are left untouched. */
export function editChatMessage(threadId: string, messageId: string, text: string): boolean {
  const nextText = text.trim();
  if (!nextText) return false;
  let edited = false;
  const now = Date.now();
  chatThreadState.update((state) => {
    const messages = state.messagesByThread[threadId] ?? [];
    const current = messages.find((message) => message.id === messageId);
    if (!current || current.role !== 'user') return state;
    edited = true;
    const nextMessages = messages.map((message) =>
      message.id === messageId ? { ...message, text: nextText } : message,
    );
    return {
      ...state,
      messagesByThread: { ...state.messagesByThread, [threadId]: nextMessages },
      threadsByProject: Object.fromEntries(
        Object.entries(state.threadsByProject).map(([projectId, threads]) => [
          projectId,
          threads.map((thread) => thread.id === threadId
            ? { ...thread, updatedAt: now }
            : thread),
        ]),
      ),
    };
  });
  return edited;
}

export function clearProjectThreadMessages(projectId: string): void {
  chatThreadState.update((state) => {
    const threads = state.threadsByProject[projectId] ?? [];
    if (!threads.length) return state;
    const ids = new Set(threads.map((thread) => thread.id));
    const messagesByThread = { ...state.messagesByThread };
    for (const id of ids) messagesByThread[id] = [];
    return {
      ...state,
      messagesByThread,
      threadsByProject: {
        ...state.threadsByProject,
        [projectId]: threads.map((thread) => ({
          ...thread,
          status: 'draft' as ChatThreadStatus,
          taskId: null,
          sessionId: null,
          updatedAt: Date.now(),
          lastActivityAt: Date.now(),
        })),
      },
    };
  });
}

export function clearChatThreadMessages(threadId: string): boolean {
  void deleteAgentCheckpoint(threadId).catch(console.error);
  updateChatThread(threadId, { agentCheckpoint: undefined });
  const thread = getChatThread(threadId);
  if (!thread) return false;
  chatThreadState.update((state) => ({
    ...state,
    messagesByThread: { ...state.messagesByThread, [threadId]: [] },
    threadsByProject: {
      ...state.threadsByProject,
      [thread.projectId]: (state.threadsByProject[thread.projectId] ?? []).map((entry) => entry.id === threadId
        ? {
            ...entry,
            status: 'draft' as ChatThreadStatus,
            taskId: null,
            sessionId: null,
            updatedAt: Date.now(),
            lastActivityAt: Date.now(),
          }
        : entry),
    },
  }));
  return true;
}

export function resetChatThreadsForTests(): void {
  chatThreadState.set({
    version: 1,
    threadsByProject: {},
    messagesByThread: {},
    activeThreadByProject: {},
  });
}
