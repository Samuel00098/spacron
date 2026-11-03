/**
 * Durable contracts for the project-scoped Chat mode.
 *
 * The legacy orchestrator chat is intentionally a different shape: it is a
 * project -> flat-message map and predates threads. The migration in
 * `stores/chatThreads.ts` converts that shape into these contracts without
 * changing or deleting the legacy data.
 */

export type ChatThreadStatus =
  | 'draft'
  | 'idle'
  | 'working'
  | 'needs-input'
  | 'complete'
  | 'failed'
  | 'archived';

export type ChatMessageType =
  | 'user'
  | 'agent'
  | 'orchestrator'
  | 'activity'
  | 'approval'
  | 'input'
  | 'completion'
  | 'failure'
  | 'system';

export type ChatMessageRole = 'user' | 'assistant' | 'orchestrator' | 'system';

/** AI inference provider used to power this conversation's orchestrator brain. */
export type ChatProviderId = string;

/** Per-thread agent authority. The composer exposes Default and Full access;
 * older values remain readable so existing persisted conversations migrate. */
export type ChatAccessMode = 'inherit' | 'supervised' | 'auto-edits' | 'auto' | 'full-access';
export type ChatWorkMode = 'plan' | 'build';

/** Legacy per-agent setting retained only for persisted thread compatibility. */
export type ChatReasoningEffort = 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export type ChatInlineRequestType = 'approval' | 'choice' | 'text' | 'terminal' | 'dismiss';

export interface ChatInlineOption {
  id: string;
  label: string;
  /** Exact terminal response for a displayed choice, when different from its label. */
  value?: string;
  description?: string;
  destructive?: boolean;
}

export interface ChatInlineRequest {
  id: string;
  type: ChatInlineRequestType;
  prompt: string;
  options?: ChatInlineOption[];
  placeholder?: string;
  taskId?: string | null;
  sessionId?: number | null;
  answeredAt?: number | null;
  answer?: string | null;
  inputMode?: 'prompt' | 'line';
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Ephemeral path for binary attachments materialized in the app temp area. */
  path?: string;
  /** Text content is retained for prompt context; binary files keep metadata only. */
  text?: string;
  /** Ephemeral blob: URL for image thumbnails and click-to-preview. Never persisted. */
  previewUrl?: string;
  /**
   * An image Spacron generated and keeps in its generated-images folder. Only
   * these keep `path` when a thread is saved: pasted-image paths die with the
   * temp folder on exit, generated ones do not.
   */
  generated?: boolean;
}

/**
 * A file the orchestrator wrote during a turn, shown as a card under its reply
 * that opens the file viewer. `path` is relative to the conversation's root
 * (project or standalone file area) so it still resolves after a standalone
 * chat becomes a project; only a document saved with no root open is absolute.
 */
export interface ChatFileRef {
  path: string;
  action: 'created' | 'edited';
}

export interface ChatDispatchReference {
  taskId: string;
  agent: string;
  name?: string | null;
  via: 'spawn' | 'send';
}

export interface ChatCompletion {
  status: 'done' | 'failed' | 'blocked';
  agentName: string;
  taskTitle: string;
  elapsedSec: number | null;
  reason?: string | null;
  summary?: string | null;
  summaryPending?: boolean;
  endedBy?: 'declared' | 'exit' | 'inferred';
  silent?: boolean;
  taskId?: string | null;
}

export type ChatHandoffDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface ChatHandoffRecord {
  id: string;
  sourceAgent: string;
  targetAgent: string;
  createdAt: number;
  reason: 'agent-switch' | 'usage-limit';
  status: ChatHandoffDeliveryStatus;
  coveredMessageIds: string[];
  omittedMessages: number;
  prompt: string;
  deliveredAt?: number;
  failureReason?: string;
}

export interface ChatAcpCapabilities {
  protocolVersion: number | string;
  agentInfo?: { name?: string; version?: string; title?: string } | null;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: Array<{ id: string; name?: string; type?: string }>;
  negotiatedAt: number;
}

/**
 * The thread-aware message contract. `threadId` is required so consumers can
 * never accidentally render another thread's transcript by project alone.
 */
export interface ChatMessage {
  id: string;
  threadId: string;
  type: ChatMessageType;
  role: ChatMessageRole;
  text: string;
  ts: number;
  pending?: boolean;
  dispatched?: ChatDispatchReference[];
  dispatchedTaskId?: string | null;
  dispatchedAgent?: string | null;
  reconSummary?: string | null;
  completion?: ChatCompletion | null;
  inlineRequest?: ChatInlineRequest | null;
  attachments?: ChatAttachment[];
  /** Files this reply's turn created or edited. */
  files?: ChatFileRef[];
  /** Fields not understood by the first migration remain recoverable here. */
  legacy?: Record<string, unknown>;
}

export interface ChatThread {
  /** Standalone conversation with its own app-managed file area. */
  standalone?: boolean;
  standaloneWorkspaceId?: string;
  agentCheckpoint?: import('../services/orchestrator/agent-transport').AgentCheckpoint;
  agentBudgets?: import('../services/orchestrator/agent-transport').AgentBudgets;
  /** Durable provider/agent handoff records, retained for retry and audit. */
  handoffs?: ChatHandoffRecord[];
  /** Native ACP session identity, when Chat is using an ACP transport. */
  nativeAcpSessionId?: string | null;
  nativeAcpCommand?: string | null;
  nativeAcpModel?: string | null;
  nativeAcpCapabilities?: ChatAcpCapabilities | null;
  /** Parent conversation when this is a dedicated sub-agent thread. */
  parentThreadId?: string | null;
  subagentTaskId?: string | null;
  subagentRole?: 'scout' | 'builder' | 'reviewer' | 'custom' | null;
  id: string;
  projectId: string;
  title: string;
  agentName: string | null;
  agentPreset: string | null;
  /** Explicit orchestrator provider/model. Null means use the app default. */
  provider: ChatProviderId | null;
  model: string | null;
  accessMode: ChatAccessMode;
  workMode: ChatWorkMode;
  reasoningEffort: ChatReasoningEffort;
  taskId: string | null;
  sessionId: number | null;
  status: ChatThreadStatus;
  /**
   * Set when a brain turn finished normally (FINAL reply, failure, or user
   * stop). The transport then treats the saved checkpoint as conversation
   * memory only — not as interrupted work — so the thread never offers to
   * resume a turn that actually ended.
   */
  turnEndedAt?: number;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  unreadCount: number;
  draft: string;
  pinned?: boolean;
  /** Put away by the user: listed under the project's collapsed "Archived"
   *  group instead of with the live threads. A flag rather than a `status`,
   *  because status is recomputed from activity and would drop it. */
  archived?: boolean;
  order?: number;
}

/** Provider/model to use for the next explicit conversation after deletion. */
export interface ChatThreadLlmSettings {
  provider: ChatProviderId | null;
  model: string | null;
}

export interface ChatThreadState {
  version: 1;
  threadsByProject: Record<string, ChatThread[]>;
  messagesByThread: Record<string, ChatMessage[]>;
  activeThreadByProject: Record<string, string | null>;
  pendingNewThreadSettingsByProject?: Record<string, ChatThreadLlmSettings>;
}
