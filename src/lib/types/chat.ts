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
  | 'plan'
  | 'activity'
  | 'approval'
  | 'input'
  | 'completion'
  | 'failure'
  | 'system';

export type ChatMessageRole = 'user' | 'assistant' | 'orchestrator' | 'system';

export type ChatInlineRequestType = 'approval' | 'choice' | 'text' | 'terminal' | 'dismiss';

export interface ChatInlineOption {
  id: string;
  label: string;
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
  /** Fields not understood by the first migration remain recoverable here. */
  legacy?: Record<string, unknown>;
}

export interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  agentName: string | null;
  agentPreset: string | null;
  taskId: string | null;
  sessionId: number | null;
  status: ChatThreadStatus;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  unreadCount: number;
  draft: string;
  pinned?: boolean;
  order?: number;
}

export interface ChatThreadState {
  version: 1;
  threadsByProject: Record<string, ChatThread[]>;
  messagesByThread: Record<string, ChatMessage[]>;
  activeThreadByProject: Record<string, string | null>;
}
