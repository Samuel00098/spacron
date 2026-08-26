import { create } from 'zustand';
import type { OrchestratorTask } from '$lib/services/orchestrator/task-lifecycle';
import { loadJson } from '$lib/utils/storage';

// ─── Types ──────────────────────────────────────────────────────────────────

export type {
  OrchestratorTask,
  OrchestratorTaskStatus,
} from '$lib/services/orchestrator/task-lifecycle';
export type { ActivityEvent, ActivityKind } from '$lib/services/orchestrator/activity-log';

export interface DispatchRef {
  taskId: string;
  agent: string;
  name?: string | null;
  /** 'spawn' opened a new agent; 'send' pushed to an existing one. */
  via: 'spawn' | 'send';
}

export interface CompletionSummary {
  /** 'done' | 'failed' | 'blocked' */
  status: 'done' | 'failed' | 'blocked';
  agentName: string;
  taskTitle: string;
  elapsedSec: number | null;
  reason?: string | null;
  /** AI-generated plain-English summary of what the agent did this turn. */
  summary?: string | null;
  /** True while the summary LLM call is in flight. */
  summaryPending?: boolean;
  /** The orchestrator task this turn belonged to, when one exists. Lets the
   *  notification card offer a "Show terminal" action while the session lives. */
  /**
   * How this turn end became known, which decides what the card is allowed to
   * claim:
   *
   * - `declared` — the agent said so (hook sentinel or `report_status`).
   *   The card says **finished**.
   * - `exit` — the agent's process ended. An observed fact, but not a claim
   *   that the work is done: a CLI you quit with `/exit` exits cleanly too.
   *   The card says **exited**.
   * - `inferred` — output stopped growing and we assumed. Equally a long
   *   compile. The card says **went quiet**, and does not interrupt.
   *
   * Optional for cards persisted before this field existed; a missing value is
   * treated as `declared`, which is how they were already worded.
   */
  endedBy?: 'declared' | 'exit' | 'inferred';
  /**
   * True when this turn end must not interrupt: no floating card, no chime, no
   * OS notification. The row still lands in the inbox.
   *
   * Set for a finish nobody declared — one the idle fallback inferred from the
   * output going quiet. That is the same shape as a long compile or an agent
   * parked at an untouched prompt, so announcing it produces exactly the
   * "your agent finished" alert that arrives while nothing has happened.
   */
  silent?: boolean;
  taskId?: string | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  pending?: boolean;
  /** Agents this turn touched. Newer field; legacy single fields kept for old chats. */
  dispatched?: DispatchRef[];
  dispatchedTaskId?: string | null;
  dispatchedAgent?: string | null;
  /** Reconnaissance findings shown before dispatch. */
  reconSummary?: string | null;
  /** Structured agent completion summary card. */
  completion?: CompletionSummary | null;
}

// ─── State shape ────────────────────────────────────────────────────────────

const CHAT_STORAGE_KEY = 'spacron_orchestrator_chat';

function loadChat(): Record<string, ChatMessage[]> {
  return loadJson<Record<string, ChatMessage[]>>(CHAT_STORAGE_KEY, {});
}

interface OrchestratorState {
  orchestratorTasks: OrchestratorTask[];
  chatMessages: Record<string, ChatMessage[]>;
  agentCenterOpen: boolean;
  agentForcedAgent: string;
  agentVoiceModeActive: boolean;
  __set: <K extends keyof OrchestratorStateValueKeys>(key: K, value: OrchestratorStateValueKeys[K]) => void;
}

type OrchestratorStateValueKeys = Omit<OrchestratorState, '__set'>;

// ─── Store ──────────────────────────────────────────────────────────────────

export const useOrchestratorStore = create<OrchestratorState>((set) => ({
  orchestratorTasks: [],
  chatMessages: loadChat(),
  agentCenterOpen: false,
  agentForcedAgent: 'auto',
  agentVoiceModeActive: false,
  __set: (key, value) => set({ [key]: value }),
}));
