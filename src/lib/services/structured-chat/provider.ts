import type { AskAnswer } from './ask';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type {
  StructuredAccess,
  StructuredApproval,
  StructuredApprovalOption,
  StructuredChatState,
  StructuredModel,
} from './codex-session';

export type CompactCapability = 'native' | 'journal-only' | 'unsupported';
export type SteeringCapability = 'inject' | 'queue';
/**
 * How `rewind` is carried out. Only `native-provider` changes the provider's
 * own thread; `conversation-reset` re-seeds a fresh process from the shortened
 * journal, so the provider keeps its old turns on disk. Neither touches files.
 */
export type RewindMode = 'native-provider' | 'conversation-reset' | 'none';
/**
 * How `fork` is carried out. Only `native-provider` makes a separate native
 * conversation; `journal-branch` copies the history into a new Spacron chat
 * that starts a fresh provider conversation when it resumes.
 */
export type ForkMode = 'native-provider' | 'journal-branch' | 'none';
/** Who owns a child agent: the provider's own subagent tree, or Spacron itself. */
export type SubagentOrigin = 'native' | 'spacron';

export interface StructuredSubagentCapabilities {
  supported: boolean;
  /** The adapter implements `spawnSubagent` itself (its own subagent tree). */
  spawn: boolean;
  inspectTranscript: boolean;
}

export interface StructuredProviderCapabilities {
  /** Some path exists for rewind; `rewindMode` says which. */
  rewind: boolean;
  fork: boolean;
  rewindMode: RewindMode;
  forkMode: ForkMode;
  compact: CompactCapability;
  steering: SteeringCapability;
  contextUsage: boolean;
  mcp: boolean;
  subagents: StructuredSubagentCapabilities;
  nativeCommands: boolean;
  supportedAccessModes: StructuredAccess[];
}

/** One durable line in a child's timeline (spawn, report, answer, exit). */
export interface StructuredSubagentLogEntry {
  at: number;
  kind: string;
  text?: string;
}

export interface StructuredSubagentSession {
  id: string;
  parentSessionId: number;
  agent: string;
  model?: string;
  assignment: string;
  /** `exited` and `lost` are ends without a final report (see `exit`). */
  status: 'starting' | 'running' | 'needs-input' | 'completed' | 'failed' | 'cancelled' | 'exited' | 'lost';
  output?: string;
  question?: string;
  answer?: string;
  items?: TerminalChatItem[];
  startedAt: number;
  completedAt?: number;
  childSessionId?: number;
  branch?: string;
  /** `native` when the provider owns the child, `spacron` when Spacron spawned it. */
  origin?: SubagentOrigin;
  /** The structured-session record this child belongs to; survives a reload. */
  parentRecordId?: string | null;
  /** Set when the process ended without a final report, so the end is not guessed. */
  exit?: { clean: boolean; code: number | null; detail: string };
  /** Durable timeline, kept on the parent's record across reloads. */
  log?: StructuredSubagentLogEntry[];
}

/** The contract the chat view needs from any structured agent protocol. */
export interface StructuredChatProvider {
  readonly agent: string;
  readonly label: string;
  readonly capabilities: StructuredProviderCapabilities;
  get(sessionId: number): StructuredChatState | null;
  subscribe(listener: () => void): () => void;
  /** `accountId` launches under that managed account (or `default` for the CLI's own home) instead of the selected one. */
  start(sessionId: number, cwd: string, options?: { access?: StructuredAccess; resumeId?: string | null; model?: string | null; effort?: string | null; accountId?: string | null; forkSession?: boolean }): Promise<void>;
  send(sessionId: number, text: string, images?: string[]): Promise<void>;
  interrupt(sessionId: number): Promise<void>;
  setModel(sessionId: number, model: string): void;
  setEffort(sessionId: number, effort: string): void;
  setFast?(sessionId: number, fast: boolean): void;
  setUltracode?(sessionId: number, on: boolean): void;
  setAccess(sessionId: number, access: StructuredAccess): void;
  /**
   * Answer a pending approval. `optionId` picks one of the agent's own options
   * (the numbered answers on a question card) when it offered a list.
   */
  answerApproval(sessionId: number, requestId: string | number, decision: 'accept' | 'acceptForSession' | 'decline', optionId?: string, answers?: AskAnswer[]): Promise<void>;
  close(sessionId: number): Promise<void>;
  /** Providers may expose a live catalog for tests and settings surfaces. */
  models?(sessionId: number): StructuredModel[];
  /** Providers may expose a stable native conversation id for persistence. */
  conversationId?(sessionId: number): string | null;
  /** Native rewind when supported by the provider. */
  rewind?(sessionId: number, target?: { turnId?: string; checkpointId?: string } | number): Promise<boolean>;
  /** Native conversation fork when supported by the provider. */
  fork?(sessionId: number, newSessionId?: number): Promise<{ nativeSessionId: string | null; forkSourceId?: string | null } | boolean>;
  /** Mid-turn steering / prompt injection when supported. */
  steer?(sessionId: number, text: string, images?: string[]): Promise<void>;
  /** Resume a stopped or interrupted turn without appending a user message. */
  resumeTurn?(sessionId: number): Promise<void>;
  /** Native context compaction when supported. */
  compact?(sessionId: number): Promise<void>;
  /** Active subagents for this session. */
  subagents?(sessionId: number): StructuredSubagentSession[];
  /** Spawn a child subagent. */
  spawnSubagent?(sessionId: number, assignment: string, options?: { agent?: string; model?: string }): Promise<StructuredSubagentSession>;
  /** Answer a subagent question/input prompt. */
  answerSubagent?(sessionId: number, subagentId: string, answer: string): Promise<void>;
  /** Cancel a running subagent. */
  cancelSubagent?(sessionId: number, subagentId: string): Promise<void>;
}

export type { StoppedTurnReason, StructuredAccess, StructuredApproval, StructuredApprovalOption, StructuredChatState, StructuredModel, StructuredStoppedTurn } from './codex-session';
