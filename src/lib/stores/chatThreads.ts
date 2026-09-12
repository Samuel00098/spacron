import { derived, get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';
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
            ? { id: optionId, label, description: asString(option.description) ?? undefined, destructive: option.destructive === true }
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
    const messages = asLegacyMessages(rawMessages).map((message, index) => {
      const id = threadIdForProject(projectId);
      return migrateMessage(id, message, index, now);
    });
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
    taskId: asString(raw.taskId),
    sessionId: asNumber(raw.sessionId),
    status: validStatus,
    createdAt,
    updatedAt,
    lastActivityAt: asNumber(raw.lastActivityAt) ?? updatedAt,
    unreadCount: Math.max(0, Math.floor(asNumber(raw.unreadCount) ?? 0)),
    draft: asString(raw.draft) ?? '',
    pinned: raw.pinned === true,
    order: asNumber(raw.order) ?? undefined,
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
      .map((message, index) => {
        const type = message.type;
        const role = message.role;
        const legacy = isRecord(message.legacy) ? message.legacy : undefined;
        return {
          id: asString(message.id) ?? `${threadId}-message-${index}`,
          threadId,
          type:
            type === 'user' || type === 'agent' || type === 'orchestrator' || type === 'plan' ||
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
      });
  }
  return state;
}

function persistState(state: ChatThreadState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAT_THREADS_STORAGE_KEY, JSON.stringify(state));
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

export function getProjectThreads(projectId: string) {
  return derived(chatThreadState, (state) => state.threadsByProject[projectId] ?? []);
}

export function getChatThread(threadId: string): ChatThread | null {
  return Object.values(get(chatThreadState).threadsByProject)
    .flat()
    .find((thread) => thread.id === threadId) ?? null;
}

export function findThreadIdForTask(projectId: string, taskId: string): string | null {
  return (get(chatThreadState).threadsByProject[projectId] ?? [])
    .find((thread) => thread.taskId === taskId)?.id ?? null;
}

export function getThreadMessages(threadId: string) {
  return derived(chatThreadState, (state) => state.messagesByThread[threadId] ?? []);
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
  overrides: Partial<Pick<ChatThread, 'title' | 'agentName' | 'agentPreset' | 'provider' | 'model' | 'taskId' | 'sessionId'>> = {},
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

/** Remove a thread and keep the project's active selection usable. */
export function deleteChatThread(threadId: string): boolean {
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
    const nextThreads = remaining.length
      ? remaining
      : [createDefaultThread(ownerProjectId, [], Date.now())];
    const activeId = state.activeThreadByProject[ownerProjectId];
    const nextActiveId = activeId === threadId || !nextThreads.some((thread) => thread.id === activeId)
      ? nextThreads[Math.min(Math.max(removedIndex, 0), nextThreads.length - 1)].id
      : activeId;
    const messagesByThread = { ...state.messagesByThread };
    delete messagesByThread[threadId];
    for (const thread of nextThreads) {
      if (!messagesByThread[thread.id]) messagesByThread[thread.id] = [];
    }
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
  return true;
}

/** Mirror one legacy orchestrator message into its owning thread. */
export function appendLegacyChatMessage(
  projectId: string,
  raw: unknown,
  threadId?: string,
): string | null {
  const state = get(chatThreadState);
  const targetId = threadId && (state.threadsByProject[projectId] ?? []).some((thread) => thread.id === threadId)
    ? threadId
    : ensureProjectThread(projectId).id;
  const existing = state.messagesByThread[targetId] ?? [];
  const message = migrateMessage(
    targetId,
    isRecord(raw) ? raw as LegacyChatMessage : {},
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
        : patch.pending === false
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

export function resetChatThreadsForTests(): void {
  chatThreadState.set({
    version: 1,
    threadsByProject: {},
    messagesByThread: {},
    activeThreadByProject: {},
  });
}
