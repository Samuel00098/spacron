import { deleteAgentCheckpoint } from '$lib/services/orchestrator/agent-checkpoints';
import { forkClaudeSession } from '$lib/services/claude-agent-sdk';
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
import { getActiveWorktreePath, worktreesByProject } from '$lib/stores/projectWorktrees';
import type {
  ChatCompletion,
  ChatDispatchReference,
  ChatMessage,
  ChatMessageRole,
  ChatMessageType,
  ChatThread,
  ChatThreadLlmSettings,
  ChatThreadState,
  ChatThreadStatus,
  ChatProviderId,
  ChatAccessMode,
  ChatReasoningEffort,
  ChatAttachment,
  ChatFileRef,
  ChatHandoffRecord,
  ChatThreadPullRequest,
  ChatThreadWorktree,
} from '$lib/types/chat';

export type {
  ChatCompletion,
  ChatDispatchReference,
  ChatMessage,
  ChatMessageRole,
  ChatMessageType,
  ChatThread,
  ChatThreadLlmSettings,
  ChatThreadState,
  ChatThreadStatus,
  ChatProviderId,
  ChatAccessMode,
  ChatReasoningEffort,
  ChatAttachment,
  ChatFileRef,
  ChatHandoffRecord,
} from '$lib/types/chat';

export const CHAT_THREADS_STORAGE_KEY = 'spacron_chat_threads_v1';
export const LEGACY_CHAT_STORAGE_KEY = 'spacron_orchestrator_chat';

// A reserved conversation bucket, never a filesystem project. Existing thread
// persistence/lifecycle works for this scope without inventing a project root.
export const STANDALONE_CHAT_SCOPE = 'spacron:standalone-chats';

/** Move the same conversation into a real project, preserving its message IDs. */
export function moveStandaloneChatToProject(threadId: string, projectId: string): boolean {
  if (!projectId || projectId === STANDALONE_CHAT_SCOPE) return false;
  let moved = false;
  chatThreadState.update((state) => {
    const thread = Object.values(state.threadsByProject).flat().find((entry) => entry.id === threadId);
    if (!thread || !isStandaloneChat(thread)) return state;
    const source = state.threadsByProject[thread.projectId] ?? [];
    if (thread.status === 'working' || thread.status === 'needs-input' || thread.projectId === projectId) return state;
    const remaining = source.filter((entry) => entry.id !== threadId);
    moved = true;
    return {
      ...state,
      threadsByProject: {
        ...state.threadsByProject,
        [thread.projectId]: remaining,
        [projectId]: [...(state.threadsByProject[projectId] ?? []), { ...thread, projectId, standalone: false, standaloneWorkspaceId: undefined, agentCheckpoint: undefined, taskId: null, sessionId: null, updatedAt: Date.now() }],
      },
      activeThreadByProject: {
        ...state.activeThreadByProject,
        [thread.projectId]: state.activeThreadByProject[thread.projectId] === threadId
          ? remaining[0]?.id ?? null : state.activeThreadByProject[thread.projectId] ?? null,
        [projectId]: threadId,
      },
    };
  });
  return moved;
}

export function isStandaloneChat(thread: ChatThread): boolean {
  return thread.standalone === true || thread.projectId === STANDALONE_CHAT_SCOPE;
}

export function getStandaloneChats(state: ChatThreadState): ChatThread[] {
  return Object.values(state.threadsByProject).flat().filter(isStandaloneChat);
}

/** Upgrade an older rootless chat to a private file area, retaining its IDs. */
export function bindStandaloneChatWorkspace(threadId: string, projectId: string, workspaceId: string): void {
  chatThreadState.update((state) => {
    const thread = Object.values(state.threadsByProject).flat().find((entry) => entry.id === threadId);
    if (!thread || !isStandaloneChat(thread)) return state;
    const next = { ...thread, projectId, standalone: true, standaloneWorkspaceId: workspaceId };
    const source = (state.threadsByProject[thread.projectId] ?? []).filter((entry) => entry.id !== threadId);
    return {
      ...state,
      threadsByProject: { ...state.threadsByProject, [thread.projectId]: source, [projectId]: [...(projectId === thread.projectId ? source : state.threadsByProject[projectId] ?? []), next] },
      activeThreadByProject: { ...state.activeThreadByProject, [thread.projectId]: source[0]?.id ?? null, [projectId]: threadId },
    };
  });
}

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

/**
 * An absolute POSIX or Windows path, else null. A stored worktree path is used
 * as the agent's cwd, so a relative one would silently point somewhere else.
 */
function asAbsolutePath(value: unknown): string | null {
  const raw = asString(value)?.trim();
  if (!raw) return null;
  return raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw) ? raw : null;
}

/** Restore a persisted thread worktree, or drop it if it can't be used. */
function readThreadWorktree(value: unknown, fallbackAt: number): ChatThreadWorktree | undefined {
  if (!isRecord(value)) return undefined;
  const path = asAbsolutePath(value.path);
  const branch = asString(value.branch);
  if (!path || !branch) return undefined;
  return {
    path,
    branch,
    baseBranch: asString(value.baseBranch) || 'main',
    baseCommit: asString(value.baseCommit) || '',
    createdAt: asNumber(value.createdAt) ?? fallbackAt,
    ...(value.shared === true ? { shared: true } : {}),
  };
}

/** Restore a shipped pull request; the compare URL is what makes it useful. */
function readThreadPullRequest(value: unknown, fallbackAt: number): ChatThreadPullRequest | undefined {
  if (!isRecord(value)) return undefined;
  const compareUrl = asString(value.compareUrl);
  if (!compareUrl) return undefined;
  return {
    url: asString(value.url) || null,
    number: asNumber(value.number),
    compareUrl,
    branch: asString(value.branch) || '',
    base: asString(value.base) || '',
    openedAt: asNumber(value.openedAt) ?? fallbackAt,
  };
}

function copyHandoffs(value: unknown): ChatHandoffRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: ChatHandoffRecord[] = [];
  for (const entry of value.filter(isRecord)) {
    const id = asString(entry.id);
    const sourceAgent = asString(entry.sourceAgent);
    const targetAgent = asString(entry.targetAgent);
    const prompt = asString(entry.prompt);
    const createdAt = asNumber(entry.createdAt);
    const status = entry.status;
    const reason = entry.reason;
    const coveredMessageIds = Array.isArray(entry.coveredMessageIds)
      ? entry.coveredMessageIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (!id || !sourceAgent || !targetAgent || !prompt || createdAt == null ||
      (status !== 'pending' && status !== 'delivered' && status !== 'failed') ||
      (reason !== 'agent-switch' && reason !== 'usage-limit')) continue;
    records.push({
      id, sourceAgent, targetAgent, prompt, createdAt, status, reason,
      coveredMessageIds,
      omittedMessages: Math.max(0, Math.floor(asNumber(entry.omittedMessages) ?? 0)),
      deliveredAt: asNumber(entry.deliveredAt) ?? undefined,
      failureReason: asString(entry.failureReason) ?? undefined,
    });
  }
  return records.length ? records : undefined;
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

function normalizePendingThreadSettings(value: unknown): Record<string, ChatThreadLlmSettings> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, ChatThreadLlmSettings]> = [];
  for (const [projectId, rawSettings] of Object.entries(value)) {
    if (!isRecord(rawSettings)) continue;
    entries.push([projectId, {
      provider: asProvider(rawSettings.provider),
      model: asString(rawSettings.model),
    }]);
  }
  return Object.fromEntries(entries);
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
      const path = entry.generated === true ? asString(entry.path) : null;
      const attachment: ChatAttachment = { id, name, type, size, ...(text != null ? { text } : {}) };
      if (path) Object.assign(attachment, { path, generated: true });
      return attachment;
    })
    .filter((entry): entry is ChatAttachment => entry !== null);
  return attachments.length ? attachments : undefined;
}

function copyFiles(value: unknown): ChatFileRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value
    .filter(isRecord)
    .map((entry): ChatFileRef | null => {
      const path = asString(entry.path);
      return path ? { path, action: entry.action === 'edited' ? 'edited' : 'created' } : null;
    })
    .filter((entry): entry is ChatFileRef => entry !== null);
  return files.length ? files : undefined;
}

function migrateMessage(threadId: string, raw: LegacyChatMessage, index: number, now: number): ChatMessage {
  const id = asString(raw.id) ?? `${threadId}-message-${index}`;
  const ts = asNumber(raw.ts) ?? now;
  const knownKeys = new Set([
    'id', 'role', 'text', 'ts', 'pending', 'dispatched', 'dispatchedTaskId',
    'dispatchedAgent', 'reconSummary', 'completion', 'inlineRequest', 'attachments', 'files',
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
    ...(copyFiles(raw.files) ? { files: copyFiles(raw.files) } : {}),
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
    workMode: 'build',
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
    standalone: raw.standalone === true,
    standaloneWorkspaceId: asString(raw.standaloneWorkspaceId) ?? undefined,
    title: asString(raw.title) || 'New thread',
    agentName: asString(raw.agentName),
    agentPreset: asString(raw.agentPreset),
    provider: asProvider(raw.provider),
    model: asString(raw.model),
    accessMode: asAccessMode(raw.accessMode),
    workMode: raw.workMode === 'plan' ? 'plan' : 'build',
    reasoningEffort: asReasoningEffort(raw.reasoningEffort),
    taskId: asString(raw.taskId),
    sessionId: asNumber(raw.sessionId),
    // A standalone response has no resumable project execution checkpoint.
    status: projectId === STANDALONE_CHAT_SCOPE && validStatus === 'working' ? 'idle' : validStatus,
    createdAt,
    updatedAt,
    lastActivityAt: asNumber(raw.lastActivityAt) ?? updatedAt,
    turnEndedAt: asNumber(raw.turnEndedAt) ?? undefined,
    unreadCount: Math.max(0, Math.floor(asNumber(raw.unreadCount) ?? 0)),
    draft: asString(raw.draft) ?? '',
    pinned: raw.pinned === true,
    archived: raw.archived === true,
    order: asNumber(raw.order) ?? undefined,
    forkOfThreadId: asString(raw.forkOfThreadId) ?? undefined,
    snoozedUntil: asNumber(raw.snoozedUntil) ?? undefined,
    settledAt: asNumber(raw.settledAt) ?? undefined,
    worktree: readThreadWorktree(raw.worktree, updatedAt),
    pullRequest: readThreadPullRequest(raw.pullRequest, updatedAt),
    contextUsage: isRecord(raw.contextUsage)
      && typeof raw.contextUsage.used === 'number' && typeof raw.contextUsage.size === 'number'
      && raw.contextUsage.size > 0
      ? {
        used: Math.max(0, raw.contextUsage.used),
        size: raw.contextUsage.size,
        cost: isRecord(raw.contextUsage.cost)
          && typeof raw.contextUsage.cost.amount === 'number' && typeof raw.contextUsage.cost.currency === 'string'
          ? { amount: raw.contextUsage.cost.amount, currency: raw.contextUsage.cost.currency }
          : null,
        updatedAt: asNumber(raw.contextUsage.updatedAt) ?? updatedAt,
      }
      : undefined,
    turnPlan: isRecord(raw.turnPlan) && Array.isArray(raw.turnPlan.entries)
      ? {
        planId: asString(raw.turnPlan.planId) ?? 'plan',
        entries: raw.turnPlan.entries.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.content !== 'string' || !entry.content.trim()) return [];
          return [{
            content: entry.content,
            status: asString(entry.status) ?? 'pending',
            ...(asString(entry.priority) ? { priority: asString(entry.priority) as string } : {}),
          }];
        }),
        updatedAt: asNumber(raw.turnPlan.updatedAt) ?? updatedAt,
      }
      : undefined,
    agentCheckpoint: isRecord(raw.agentCheckpoint) && Array.isArray(raw.agentCheckpoint.exchanges) && Array.isArray(raw.agentCheckpoint.results)
      && typeof raw.agentCheckpoint.provider === 'string' && typeof raw.agentCheckpoint.model === 'string' && typeof raw.agentCheckpoint.summary === 'string'
      ? raw.agentCheckpoint as unknown as ChatThread['agentCheckpoint'] : undefined,
    agentBudgets: isRecord(raw.agentBudgets) ? Object.fromEntries(Object.entries(raw.agentBudgets).filter(([key, value]) =>
      (['contextChars', 'outputTokens', 'maxRounds'].includes(key) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (key === 'toolMode' && (value === 'native' || value === 'text')))) : undefined,
    handoffs: copyHandoffs(raw.handoffs),
    nativeAcpSessionId: asString(raw.nativeAcpSessionId),
    nativeAcpCommand: asString(raw.nativeAcpCommand),
    nativeAcpModel: asString(raw.nativeAcpModel),
    nativeAcpCapabilities: isRecord(raw.nativeAcpCapabilities)
      && (typeof raw.nativeAcpCapabilities.protocolVersion === 'number' || typeof raw.nativeAcpCapabilities.protocolVersion === 'string')
      && typeof raw.nativeAcpCapabilities.negotiatedAt === 'number'
      ? raw.nativeAcpCapabilities as unknown as ChatThread['nativeAcpCapabilities']
      : undefined,
    claudeSdkSessionId: asString(raw.claudeSdkSessionId),
    cursorSdkSessionId: asString(raw.cursorSdkSessionId),
    opencodeSdkSessionId: asString(raw.opencodeSdkSessionId),
    museSdkSessionId: asString(raw.museSdkSessionId),
    parentThreadId: asString(raw.parentThreadId),
    subagentTaskId: asString(raw.subagentTaskId),
    subagentRole:
      raw.subagentRole === 'scout' || raw.subagentRole === 'builder' || raw.subagentRole === 'reviewer' || raw.subagentRole === 'custom'
        ? raw.subagentRole
        : undefined,
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
  const pendingNewThreadSettingsByProject = normalizePendingThreadSettings(raw.pendingNewThreadSettingsByProject);
  if (Object.keys(pendingNewThreadSettingsByProject).length) {
    state.pendingNewThreadSettingsByProject = pendingNewThreadSettingsByProject;
  }
  for (const [projectId, threads] of Object.entries(raw.threadsByProject)) {
    if (!Array.isArray(threads)) continue;
    const normalized = threads
      .map((thread, index) => normalizeThread(thread, projectId, index, now))
      .filter((thread): thread is ChatThread => thread !== null);
    if (normalized.length) state.threadsByProject[projectId] = normalized;
  }
  const standaloneThreadIds = new Set((state.threadsByProject[STANDALONE_CHAT_SCOPE] ?? []).map((thread) => thread.id));
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
          text: standaloneThreadIds.has(threadId) && message.pending === true && !asString(message.text)?.trim()
            ? 'Response interrupted. Send another message to continue.' : asString(message.text) ?? '',
          ts: asNumber(message.ts) ?? now,
          pending: message.pending === true && !standaloneThreadIds.has(threadId),
          dispatched: copyDispatches(message.dispatched),
          dispatchedTaskId: asString(message.dispatchedTaskId),
          dispatchedAgent: asString(message.dispatchedAgent),
          reconSummary: asString(message.reconSummary),
          completion: copyCompletion(message.completion),
          inlineRequest: copyInlineRequest(message.inlineRequest),
          attachments: copyAttachments(message.attachments),
          ...(copyFiles(message.files) ? { files: copyFiles(message.files) } : {}),
          ...(legacy ? { legacy } : {}),
        } satisfies ChatMessage;
      })
      .filter((message): message is ChatMessage => message !== null);
  }
  return state;
}

const PERSIST_MIN_INTERVAL_MS = 300;
// The module instance that owns the live store. A trailing write from an older
// instance (hot reload, or a fresh import in tests) must never overwrite newer
// state, so the timer checks that it still owns the global slot.
const storeInstance = {};
const STORE_INSTANCE_KEY = '__spacronChatStoreInstance';
function claimStoreInstance(): void {
  (globalThis as unknown as Record<string, unknown>)[STORE_INSTANCE_KEY] = storeInstance;
}
function ownsStoreInstance(): boolean {
  return (globalThis as unknown as Record<string, unknown>)[STORE_INSTANCE_KEY] === storeInstance;
}

let lastPersistAt = 0;
let pendingPersist: ReturnType<typeof setTimeout> | null = null;
let latestState: ChatThreadState | null = null;

function persistState(state: ChatThreadState): void {
  if (typeof window === 'undefined') return;
  lastPersistAt = Date.now();
  try {
    window.localStorage.setItem(CHAT_THREADS_STORAGE_KEY, JSON.stringify(state, (key, value) => key === 'agentCheckpoint' ? undefined : value));
  } catch {
    // Storage is best effort; live state remains usable when quota is full.
  }
}

/**
 * Debounced persistence. Every keystroke in a draft updates the whole store,
 * and each write serialises every thread and message — writing once per
 * keystroke is what made long transcripts stutter while typing. A burst now
 * produces one write at its start and one once the user pauses; the page
 * lifecycle flushes the newest state so a reload never loses the last keys.
 */
function schedulePersist(state: ChatThreadState): void {
  latestState = state;
  if (typeof window === 'undefined') return;
  if (pendingPersist) {
    clearTimeout(pendingPersist);
    pendingPersist = null;
  }
  const wait = PERSIST_MIN_INTERVAL_MS - (Date.now() - lastPersistAt);
  if (wait <= 0) {
    persistState(state);
    return;
  }
  pendingPersist = setTimeout(() => {
    pendingPersist = null;
    if (!ownsStoreInstance() || !latestState) return;
    persistState(latestState);
  }, wait);
}

/** Write the newest state now — used when the page is going away. */
export function flushChatThreadPersistence(): void {
  if (pendingPersist) {
    clearTimeout(pendingPersist);
    pendingPersist = null;
  }
  if (latestState) persistState(latestState);
}

function loadInitialState(): ChatThreadState {
  const stored = normalizeState(loadJson<unknown>(CHAT_THREADS_STORAGE_KEY, null));
  if (stored) return stored;
  const migrated = migrateLegacyChat(loadJson<unknown>(LEGACY_CHAT_STORAGE_KEY, {}));
  persistState(migrated);
  return migrated;
}

export const chatThreadState = writable<ChatThreadState>(loadInitialState());

claimStoreInstance();
chatThreadState.subscribe(schedulePersist);
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', flushChatThreadPersistence);
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChatThreadPersistence();
  });
}

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

/** Settings remembered from an active thread deleted before the next explicit new thread. */
export function getPendingNewThreadSettings(projectId: string): ChatThreadLlmSettings | null {
  return get(chatThreadState).pendingNewThreadSettingsByProject?.[projectId] ?? null;
}

/** Stop inheriting deleted-thread settings after the user chooses a new one. */
export function clearPendingNewThreadSettings(projectId: string): void {
  chatThreadState.update((state) => ({
    ...state,
    pendingNewThreadSettingsByProject: Object.fromEntries(
      Object.entries(state.pendingNewThreadSettingsByProject ?? {}).filter(([entryProjectId]) => entryProjectId !== projectId),
    ),
  }));
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
    pendingNewThreadSettingsByProject: Object.fromEntries(
      Object.entries(state.pendingNewThreadSettingsByProject ?? {}).filter(([entryProjectId]) => entryProjectId !== projectId),
    ),
  }));
  return true;
}

export function createChatThread(
  projectId: string,
  overrides: Partial<Pick<ChatThread, 'title' | 'agentName' | 'agentPreset' | 'provider' | 'model' | 'accessMode' | 'workMode' | 'reasoningEffort' | 'taskId' | 'sessionId' | 'claudeSdkSessionId' | 'cursorSdkSessionId' | 'opencodeSdkSessionId' | 'museSdkSessionId' | 'standalone' | 'standaloneWorkspaceId' | 'parentThreadId' | 'subagentTaskId' | 'subagentRole'>> = {},
  now = Date.now(),
): ChatThread {
  const state = get(chatThreadState);
  const pendingSettings = state.pendingNewThreadSettingsByProject?.[projectId] ?? null;
  const activeThreadId = state.activeThreadByProject[projectId] ?? null;
  const activeThread = (state.threadsByProject[projectId] ?? []).find((thread) => thread.id === activeThreadId) ?? null;
  const inheritedSettings = pendingSettings ?? activeThread;
  const id = `chat-thread-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const thread: ChatThread = {
    id,
    projectId,
    standalone: overrides.standalone,
    standaloneWorkspaceId: overrides.standaloneWorkspaceId,
    parentThreadId: overrides.parentThreadId ?? null,
    subagentTaskId: overrides.subagentTaskId ?? null,
    subagentRole: overrides.subagentRole ?? null,
    claudeSdkSessionId: overrides.claudeSdkSessionId ?? null,
    cursorSdkSessionId: overrides.cursorSdkSessionId ?? null,
    opencodeSdkSessionId: overrides.opencodeSdkSessionId ?? null,
    museSdkSessionId: overrides.museSdkSessionId ?? null,
    title: overrides.title?.trim() || 'New thread',
    agentName: overrides.agentName ?? null,
    agentPreset: overrides.agentPreset ?? null,
    provider: overrides.provider !== undefined ? overrides.provider : inheritedSettings?.provider ?? null,
    model: overrides.model !== undefined ? overrides.model : inheritedSettings?.model ?? null,
    // Full access is the default: the orchestrator edits and runs commands
    // without a card per step. "Ask before edit" stays one click away.
    accessMode: overrides.accessMode ?? 'full-access',
    workMode: overrides.workMode ?? activeThread?.workMode ?? 'build',
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
  // A new top-level thread starts in the project's selected worktree, like a
  // new agent does. Sub-agent threads keep their own placement.
  if (!thread.standalone && !thread.parentThreadId) {
    const joined = sharedWorktreeFor(projectId, now);
    if (joined) thread.worktree = joined;
  }
  chatThreadState.update((state) => ({
    ...state,
    threadsByProject: {
      ...state.threadsByProject,
      [projectId]: [...(state.threadsByProject[projectId] ?? []), thread],
    },
    messagesByThread: { ...state.messagesByThread, [id]: [] },
    activeThreadByProject: { ...state.activeThreadByProject, [projectId]: id },
    pendingNewThreadSettingsByProject: Object.fromEntries(
      Object.entries(state.pendingNewThreadSettingsByProject ?? {}).filter(([entryProjectId]) => entryProjectId !== projectId),
    ),
  }));
  return thread;
}

/** The project's selected worktree as a thread checkout, or null for the root. */
function sharedWorktreeFor(projectId: string, now: number): ChatThreadWorktree | null {
  return sharedWorktreeAt(projectId, getActiveWorktreePath(projectId), now);
}

/** A project worktree as a shared thread checkout; null path = the project root. */
export function sharedWorktreeAt(projectId: string, path: string | null, now = Date.now()): ChatThreadWorktree | null {
  if (!path) return null;
  const row = (get(worktreesByProject)[projectId] ?? []).find((w) => w.path === path);
  return {
    path,
    branch: row?.branch || row?.name || path.split(/[\\/]/).pop() || 'worktree',
    baseBranch: row?.base_ref || 'main',
    baseCommit: row?.head || '',
    createdAt: now,
    shared: true,
  };
}

export function createSubagentChatThread(
  projectId: string,
  parentThreadId: string,
  input: {
    name: string;
    command: string;
    model?: string | null;
    role?: ChatThread['subagentRole'];
    taskId?: string | null;
  },
  now = Date.now(),
): ChatThread {
  return createChatThread(projectId, {
    title: input.name.trim() || 'Sub-agent',
    agentName: input.name.trim() || null,
    agentPreset: input.command,
    model: input.model ?? null,
    parentThreadId,
    subagentTaskId: input.taskId ?? null,
    subagentRole: input.role ?? 'custom',
    accessMode: 'full-access',
    workMode: 'build',
  }, now);
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
    if (!updated) return state;
    return { ...state, threadsByProject };
  });
  return updated;
}

/** Reorder a thread within its project by setting a numeric order key.
 *  Threads with lower `order` sort first; threads without an order sort last
 *  (by activity). Callers compute sequential integers on drag. */
export function reorderChatThread(threadId: string, order: number): boolean {
  return updateChatThread(threadId, { order, updatedAt: Date.now() });
}

export function recordChatHandoff(
  threadId: string,
  handoff: Omit<ChatHandoffRecord, 'id' | 'createdAt' | 'status'> & Partial<Pick<ChatHandoffRecord, 'id' | 'createdAt' | 'status'>>,
): string | null {
  const thread = getChatThread(threadId);
  if (!thread) return null;
  const record: ChatHandoffRecord = {
    ...handoff,
    id: handoff.id ?? `chat-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: handoff.createdAt ?? Date.now(),
    status: handoff.status ?? 'pending',
  };
  updateChatThread(threadId, { handoffs: [...(thread.handoffs ?? []), record], updatedAt: record.createdAt });
  return record.id;
}

export function updateChatHandoff(
  threadId: string,
  handoffId: string,
  patch: Partial<ChatHandoffRecord>,
): boolean {
  const thread = getChatThread(threadId);
  if (!thread?.handoffs?.some((handoff) => handoff.id === handoffId)) return false;
  return updateChatThread(threadId, {
    handoffs: thread.handoffs.map((handoff) => handoff.id === handoffId ? { ...handoff, ...patch, id: handoffId } : handoff),
    updatedAt: Date.now(),
  });
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

/** Archive or restore a thread. Archiving also unpins it: a pin says "keep this
 *  in front of me", which an archived thread by definition is not. */
/**
 * Hide a thread from the live list until `until`, or wake it now with null.
 *
 * Snooze and settle are the two ways a thread leaves your attention without
 * being deleted: snooze is time-boxed (it comes back on its own), settle is a
 * done-for-now flag that only a new message or the user clears. Both leave the
 * transcript, files, and agent state untouched.
 */
export function setChatThreadSnoozed(threadId: string, until: number | null): boolean {
  return updateChatThread(threadId, {
    snoozedUntil: until === null ? null : Math.max(Date.now(), until),
    updatedAt: Date.now(),
  });
}

/** Snooze presets the sidebar offers. */
export const CHAT_SNOOZE_PRESETS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: 'In 4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: 'Tomorrow', ms: 24 * 60 * 60 * 1000 },
  { label: 'Next week', ms: 7 * 24 * 60 * 60 * 1000 },
];

export function setChatThreadSettled(threadId: string, settled: boolean): boolean {
  return updateChatThread(threadId, {
    settledAt: settled ? Date.now() : null,
    ...(settled ? { snoozedUntil: null } : {}),
    updatedAt: Date.now(),
  });
}

/**
 * Auto-settle threads that have been idle long enough to stop reading as
 * "in flight". Settling is a *presentation* move — it drops the row out of the
 * active list and out of the unread badge. Nothing about the agent session
 * itself changes, so a settled thread is still one click from being resumed.
 *
 * The threshold is deliberately long: this is not a "close the tab" gesture,
 * it is a "this turn is genuinely over" one. A thread that is still producing
 * output keeps its `lastActivityAt` advancing and stays active.
 */
export const AUTO_SETTLE_IDLE_MS = 5 * 60 * 1000;

export function autoSettleStaleThreads(
  threads: ChatThread[],
  now = Date.now(),
): { settled: string[]; remaining: ChatThread[] } {
  const settled: string[] = [];
  const remaining: ChatThread[] = [];
  for (const thread of threads) {
    if (thread.pinned) {
      remaining.push(thread);
      continue;
    }
    if (thread.status === 'working' || thread.status === 'needs-input') {
      remaining.push(thread);
      continue;
    }
    if (thread.settledAt && thread.settledAt > now - AUTO_SETTLE_IDLE_MS) {
      remaining.push(thread);
      continue;
    }
    if (thread.lastActivityAt && thread.lastActivityAt > now - AUTO_SETTLE_IDLE_MS) {
      remaining.push(thread);
      continue;
    }
    if (!thread.settledAt) {
      settled.push(thread.id);
    }
    remaining.push({ ...thread, settledAt: now, snoozedUntil: undefined, updatedAt: now });
  }
  return { settled, remaining };
}

/** Apply the stale-idle heuristic to every persisted thread once per run. */
export function runAutoSettle(): string[] {
  const state = get(chatThreadState);
  const threads: ChatThread[] = Object.values(state.threadsByProject).flat();
  const { settled, remaining } = autoSettleStaleThreads(threads, Date.now());
  for (const id of settled) updateChatThread(id, { settledAt: Date.now(), snoozedUntil: null, updatedAt: Date.now() });
  return settled;
}

/**
 * Bind an isolated checkout to a thread, or clear it. Every later turn runs its
 * agent in `worktree.path`, so two threads on one project stop colliding.
 */
export function setChatThreadWorktree(threadId: string, worktree: ChatThreadWorktree | null): boolean {
  return updateChatThread(threadId, { worktree, updatedAt: Date.now() });
}

/** Remember what the ship action produced so the row can link to it afterwards. */
export function setChatThreadPullRequest(threadId: string, pullRequest: ChatThreadPullRequest | null): boolean {
  return updateChatThread(threadId, { pullRequest, updatedAt: Date.now() });
}

export function setChatThreadArchived(threadId: string, archived: boolean): boolean {
  const thread = getChatThread(threadId);
  if (!thread) return false;
  return updateChatThread(threadId, {
    archived,
    ...(archived ? { pinned: false } : {}),
    updatedAt: Date.now(),
  });
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
    const removedThread = currentThreads[removedIndex];
    const remaining = currentThreads.filter((thread) => thread.id !== threadId);
    const nextThreads = remaining;
    const activeId = state.activeThreadByProject[ownerProjectId];
    const pendingNewThreadSettingsByProject = { ...(state.pendingNewThreadSettingsByProject ?? {}) };
    if (activeId === threadId && removedThread) {
      pendingNewThreadSettingsByProject[ownerProjectId] = {
        provider: removedThread.provider,
        model: removedThread.model,
      };
    }
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
      pendingNewThreadSettingsByProject,
    };
  });
  return deleted;
}

/** Delete a user-closed thread. Closing the open conversation (or the last
 * one) leaves the project in a fresh thread, the way ChatGPT and Claude open a
 * new chat after a delete; an untouched thread is reused instead of adding a
 * second blank one. Ordinary deletion remains available separately for
 * callers that must preserve an empty project. */
export function closeChatThread(threadId: string): boolean {
  const thread = getChatThread(threadId);
  const wasOpen = thread ? get(chatThreadState).activeThreadByProject[thread.projectId] === threadId : false;
  if (!thread || !deleteChatThread(threadId)) return false;

  const state = get(chatThreadState);
  const remaining = state.threadsByProject[thread.projectId] ?? [];
  const blank = remaining.find((entry) => !(state.messagesByThread[entry.id] ?? []).length);
  if (wasOpen && blank) {
    // Not selectChatThread: that clears the deleted thread's provider/model
    // that deleteChatThread just saved for the project's next new thread.
    chatThreadState.update((current) => ({
      ...current,
      activeThreadByProject: { ...current.activeThreadByProject, [thread.projectId]: blank.id },
    }));
  } else if (wasOpen || remaining.length === 0) {
    createChatThread(thread.projectId, {
      provider: thread.provider,
      model: thread.model,
      accessMode: thread.accessMode,
      workMode: thread.workMode,
      reasoningEffort: thread.reasoningEffort,
    });
  }
  return true;
}

export function setThreadDraft(threadId: string, draft: string): boolean {
  return updateChatThread(threadId, { draft, updatedAt: Date.now() });
}

/** Keep saved messages usable when an image is renamed in Chat or Library. */
export function renameChatImageAttachments(previousPath: string, path: string, name: string): void {
  const normalize = (value: string) => {
    const slashes = value.replace(/\\/g, '/');
    return /^[a-z]:\//i.test(slashes) || slashes.startsWith('//') ? slashes.toLowerCase() : slashes;
  };
  const previous = normalize(previousPath);
  chatThreadState.update((state) => {
    let changed = false;
    const messagesByThread = Object.fromEntries(Object.entries(state.messagesByThread).map(([id, messages]) => [
      id,
      messages.map((message) => {
        let matched = false;
        const attachments = message.attachments?.map((attachment) => {
          if (!attachment.path || normalize(attachment.path) !== previous) return attachment;
          matched = true;
          return { ...attachment, path: path.replace(/\\/g, '/'), name };
        });
        changed ||= matched;
        return matched ? { ...message, attachments } : message;
      }),
    ]));
    return changed ? { ...state, messagesByThread } : state;
  });
}

/**
 * Messages that should light the sidebar's unread dot: replies, and anything
 * that is now waiting on the user. Activity and system rows are progress, not
 * news, so they never count.
 */
function countsAsUnread(message: ChatMessage): boolean {
  // Progress rows can be attributed to the assistant without being a reply.
  if (message.type === 'activity' || message.type === 'system' ||
    message.type === 'orchestrator' || message.type === 'completion') return false;
  return message.role === 'assistant' ||
    message.type === 'failure' ||
    message.type === 'approval' ||
    message.type === 'input';
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
          // Writing in an archived thread brings it back: it is in use again.
          ? {
              ...entry,
              status: nextStatus,
              updatedAt: message.ts,
              lastActivityAt: message.ts,
              ...(message.role === 'user' ? { archived: false, snoozedUntil: null, settledAt: null } : {}),
              // Unread means "something arrived in a thread you are not looking
              // at". Selecting the thread clears its count.
              ...(countsAsUnread(message) && current.activeThreadByProject[projectId] !== message.threadId
                ? { unreadCount: Math.min(99, entry.unreadCount + 1) }
                : {}),
            }
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

/**
 * The title inside a model's reply. Models reach the same answer through very
 * different wrappers — a leading blank line, a reasoning preamble, `Title:`,
 * quotes — so this takes the first line with something on it rather than the
 * first line, which an opening newline alone would leave empty.
 */
export function cleanGeneratedTitle(raw: string): string {
  const withoutReasoning = (raw || '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, ' ')
    // An unclosed reasoning block runs to the end of the reply: there is no
    // title after it, and the caller's fallback is the honest answer.
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, ' ');
  const unwrap = (value: string) => value.replace(/^["'`*_]+|["'`*_]+$/g, '').trim();
  const line = withoutReasoning
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0) ?? '';
  // Unwrapped twice with the trailing period taken off in between, because the
  // wrappers nest in both orders: `Title: "Review"` and `` `Review`. ``
  const cleaned = unwrap(unwrap(line).replace(/^Title:\s*/i, '').replace(/[.]+$/, ''))
    .replace(/[.]+$/, '')
    .trim();
  return cleaned.length > 70 ? `${cleaned.slice(0, 67).trimEnd()}…` : cleaned;
}

/**
 * Generate a concise, intelligent thread summary title using the configured AI
 * provider, falling back to [`summarizeThreadMessage`] whenever that provider
 * cannot answer — no key, not a direct API provider, rate-limited, or a reply
 * that cleaned down to nothing. A thread always gets a real name: the AI path
 * is the better title, never the only one, and returning '' here is what used
 * to leave a conversation called "New thread" for good.
 */
export async function generateAiThreadTitle(
  text: string,
  preferredProvider?: AiProviderId,
  preferredModel?: string,
): Promise<string> {
  const fallback = summarizeThreadMessage(text);
  const provider = preferredProvider ?? get(aiProvider);
  const providerDef = getProviderDef(provider);
  // Agent-session providers such as `claude` can still exist in legacy Chat
  // metadata, but they are not direct API providers for this completion path.
  if (providerDef.id !== provider) return fallback;
  const local = isLocalProvider(provider);
  const hasKey = local ? true : await providerApiKeyExists(provider, { fresh: true });
  const baseUrl = local ? getProviderBaseUrl(provider) : '';

  if (!local && !hasKey) {
    return fallback;
  }

  const model = preferredModel?.trim() || (provider === get(aiProvider)
    ? get(currentAiModel)
    : providerDef.defaultModel);

  const sample = text.trim().slice(0, 1000);
  if (!sample) return fallback;

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
    return cleanGeneratedTitle(raw) || fallback;
  } catch (error) {
    console.warn('ai_complete failed for thread title generation:', error);
    return fallback;
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
            // The fallback title is what this thread already carries whenever
            // the AI path is unavailable, and renaming bumps `updatedAt` —
            // which reorders the list. Re-titling to the same words every
            // launch would reshuffle old threads for no gain.
            const current = getChatThread(thread.id);
            if (!aiTitle || !current || aiTitle === current.title) return;
            renameChatThread(thread.id, aiTitle);
          })
          .catch(() => {
            // Keep the current title; the next launch retries.
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

/**
 * Fork: copy the transcript up to `messageId` into a new thread, leaving the
 * original untouched. `null` copies the whole thread.
 *
 * The copy carries the conversation, not the agent's session: ACP's
 * `session/fork` is draft-only and capability-gated, so a fork starts a fresh
 * agent session that is given the transcript as context. Message ids are
 * rewritten because ids are looked up per thread — a shared id would let an
 * edit in one thread patch the other.
 */
export async function forkChatThreadFrom(threadId: string, messageId: string | null = null): Promise<ChatThread | null> {
  const thread = getChatThread(threadId);
  if (!thread) return null;
  const messages = get(chatThreadState).messagesByThread[threadId] ?? [];
  const cut = messageId ? messages.findIndex((message) => message.id === messageId) : messages.length;
  if (cut < 0) return null;
  const copied = messages.slice(0, cut);
  const fork = createChatThread(thread.projectId, {
    title: `${thread.title} (fork)`,
    agentName: thread.agentName,
    agentPreset: thread.agentPreset,
    provider: thread.provider,
    model: thread.model,
    accessMode: thread.accessMode,
    workMode: thread.workMode,
    reasoningEffort: thread.reasoningEffort,
    standalone: thread.standalone,
    standaloneWorkspaceId: thread.standaloneWorkspaceId,
    claudeSdkSessionId: thread.claudeSdkSessionId,
    cursorSdkSessionId: thread.cursorSdkSessionId,
    opencodeSdkSessionId: thread.opencodeSdkSessionId,
    museSdkSessionId: thread.museSdkSessionId,
  });
  const suffix = fork.id.slice(-6);
  chatThreadState.update((state) => ({
    ...state,
    messagesByThread: {
      ...state.messagesByThread,
      [fork.id]: copied.map((message) => ({
        ...message,
        id: `${message.id}-fork-${suffix}`,
        threadId: fork.id,
        pending: false,
      })),
    },
  }));
  updateChatThread(fork.id, {
    forkOfThreadId: thread.id,
    status: copied.length ? 'idle' : 'draft',
  });

  // Natively fork the Claude SDK session so the fork reuses the source's
  // agent conversation instead of replaying the transcript.
  if (thread.claudeSdkSessionId) {
    const forked = await forkClaudeSession(thread.claudeSdkSessionId, {
      dir: thread.projectId,
      title: fork.title,
    });
    if (forked) {
      updateChatThread(fork.id, { claudeSdkSessionId: forked.sessionId, updatedAt: Date.now() });
    }
  }
  // Carry over the remaining native SDK session IDs so forks can attempt
  // --resume on the source agent conversation.
  updateChatThread(fork.id, {
    ...(thread.cursorSdkSessionId ? { cursorSdkSessionId: thread.cursorSdkSessionId } : {}),
    ...(thread.opencodeSdkSessionId ? { opencodeSdkSessionId: thread.opencodeSdkSessionId } : {}),
    ...(thread.museSdkSessionId ? { museSdkSessionId: thread.museSdkSessionId } : {}),
    updatedAt: Date.now(),
  });

  return getChatThread(fork.id);
}

/**
 * A side chat: a thread that starts with the parent's recent turns so a
 * question can be asked without touching the running conversation. The parent
 * keeps working and receives nothing unless the side chat is brought back.
 */
export function createSideChatThread(parentThreadId: string): ChatThread | null {
  const parent = getChatThread(parentThreadId);
  if (!parent) return null;
  const side = createChatThread(parent.projectId, {
    title: `Side chat · ${parent.title}`,
    agentName: parent.agentName,
    agentPreset: parent.agentPreset,
    provider: parent.provider,
    model: parent.model,
    accessMode: parent.accessMode,
    workMode: 'build',
    reasoningEffort: parent.reasoningEffort,
    standalone: parent.standalone,
    standaloneWorkspaceId: parent.standaloneWorkspaceId,
    parentThreadId: parent.id,
  });
  const suffix = side.id.slice(-6);
  const recent = (get(chatThreadState).messagesByThread[parent.id] ?? []).slice(-12);
  chatThreadState.update((state) => ({
    ...state,
    messagesByThread: {
      ...state.messagesByThread,
      [side.id]: [
        {
          id: `side-intro-${suffix}`,
          threadId: side.id,
          role: 'system',
          type: 'system',
          ts: Date.now(),
          text: `Side chat of “${parent.title}”. The main thread keeps working; nothing said here reaches it unless you choose Bring back.`,
        },
        ...recent.map((message) => ({
          ...message,
          id: `${message.id}-sidecopy-${suffix}`,
          threadId: side.id,
          pending: false,
        })),
      ],
    },
  }));
  updateChatThread(side.id, { status: 'idle' });
  return getChatThread(side.id);
}

/** Fold a side chat's own turns into its parent, then remove the side thread. */
export function bringBackSideChat(sideThreadId: string): boolean {
  const side = getChatThread(sideThreadId);
  if (!side?.parentThreadId) return false;
  const parentId = side.parentThreadId;
  const messages = get(chatThreadState).messagesByThread[sideThreadId] ?? [];
  // The intro and the copied parent turns are not new information; only what
  // was actually said in this side chat belongs in the parent.
  const copied = messages.filter((message) => message.id.includes('-sidecopy-') || message.id.startsWith('side-intro-'));
  const own = messages.filter((message) => !copied.includes(message));
  for (const message of own) {
    appendThreadMessage({ ...message, id: `${message.id}-back`, threadId: parentId });
  }
  deleteChatThread(sideThreadId);
  return true;
}

/**
 * Revert a thread to just before `messageId`: that message and everything after
 * it are dropped, so the conversation branches here.
 *
 * A user message's text goes back into the composer, which is the point of the
 * gesture — re-send the turn with a different instruction. Two kinds of memory
 * are cleared with the transcript, because keeping them would let the agent act
 * on what the user just removed: the saved agent checkpoint (IndexedDB, and the
 * row that points at it) and the native ACP session id (the agent's own server
 * holds the dropped turns). Files already written to disk are deliberately left
 * alone: undoing those belongs to the worktree review, which knows what the
 * turn actually changed.
 */
export function revertChatThreadTo(threadId: string, messageId: string, restoreFiles: boolean = false): boolean {
  let reverted = false;
  const now = Date.now();
  chatThreadState.update((state) => {
    const messages = state.messagesByThread[threadId] ?? [];
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return state;
    const target = messages[index];
    reverted = true;
    return {
      ...state,
      messagesByThread: { ...state.messagesByThread, [threadId]: messages.slice(0, index) },
      threadsByProject: Object.fromEntries(
        Object.entries(state.threadsByProject).map(([projectId, threads]) => [
          projectId,
          threads.map((thread) => thread.id === threadId
            ? {
              ...thread,
              status: 'idle' as ChatThreadStatus,
              draft: target.role === 'user' ? target.text : thread.draft,
              updatedAt: now,
              lastActivityAt: now,
              turnEndedAt: now,
              unreadCount: 0,
              contextUsage: null,
              turnPlan: null,
              agentCheckpoint: undefined,
              nativeAcpSessionId: null,
              claudeSdkSessionId: null,
              cursorSdkSessionId: null,
              opencodeSdkSessionId: null,
              museSdkSessionId: null,
            }
            : thread),
        ]),
      ),
    };
  });
  if (reverted) void deleteAgentCheckpoint(threadId).catch(() => {});
  if (reverted && restoreFiles) {
    void restoreThreadFiles(threadId).catch(() => {});
  }
  return reverted;
}

/** Restore a thread's working-tree files to their last committed state. */
async function restoreThreadFiles(threadId: string): Promise<void> {
  const thread = getChatThread(threadId);
  if (!thread) return;
  try {
    await invoke('workspace_git_discard_all', {
      projectId: thread.projectId,
      confirmation: 'discard all changes',
    });
  } catch {
    /* best-effort: file restore failures must not block the revert */
  }
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

/** Correct a completed response without resending or removing later messages. */
export async function editAssistantChatMessage(threadId: string, messageId: string, text: string): Promise<boolean> {
  const nextText = text.trim();
  const thread = getChatThread(threadId);
  const message = get(chatThreadState).messagesByThread[threadId]?.find((entry) => entry.id === messageId);
  if (!nextText || !thread || thread.status === 'working' || thread.status === 'needs-input' || !message || message.role !== 'assistant' || message.pending) return false;
  await deleteAgentCheckpoint(threadId);
  if (!patchThreadMessage(threadId, messageId, { text: nextText })) return false;
  updateChatThread(threadId, { agentCheckpoint: undefined, updatedAt: Date.now() });
  return true;
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
          claudeSdkSessionId: null,
          cursorSdkSessionId: null,
          opencodeSdkSessionId: null,
          museSdkSessionId: null,
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
            claudeSdkSessionId: null,
            cursorSdkSessionId: null,
            opencodeSdkSessionId: null,
            museSdkSessionId: null,
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
