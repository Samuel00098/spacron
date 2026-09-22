import { loadAgentCheckpoint, saveAgentCheckpoint, deleteAgentCheckpoint } from '$lib/services/orchestrator/agent-checkpoints';
import { filePage } from '$lib/services/orchestrator/agent-transport';
import { writable, get, derived } from '$lib/stores/storeCompat';
import { useOrchestratorStore } from './zustand/orchestrator';
import { invoke } from '@tauri-apps/api/core';
import { backendInvoke } from '$lib/services/backend';
import { readProjectState } from '$lib/services/project-state';
import { showToast } from '$lib/stores/notification';
import { estimateFileOverlap } from '$lib/services/jev';
import { getPresetRuns } from '$lib/stores/runs';
import {
  getProjectTaskPanelLines,
  loadProjectTasks,
  tasks,
  addTask,
  updateTaskStatus,
  deleteTask,
  type TaskStatus,
} from '$lib/stores/tasks';
import { setActiveView, showTerminal, openSettings } from '$lib/stores/layout';
import { sanitiseActiveView } from '$lib/stores/layout';
import type { ActiveView } from '$lib/types/layout';
import { openFile, closeFile, jumpToLine } from '$lib/stores/editor';
import { navigatePreviewTab, ensureProxyRunning } from '$lib/stores/preview';
import { getAppContextSnapshot, NAVIGABLE_VIEWS } from '$lib/services/orchestrator/app-context';
import { applyAgentSetting } from '$lib/services/orchestrator/app-settings';
import { loadJson } from '$lib/utils/storage';
import {
  routeOrchestratorRequest,
  ADMIN_KEYWORD_RE,
  detectStatedPlacement,
  type AgentChoice,
  type RouteResult,
  type RouteLlmConfig,
  type AgentOutputRef,
  type AgentTranscriptRead,
  type RunningAgentRef,
  type OrchestratorAction,
  type SpawnPlacement,
} from '$lib/services/orchestrator-brain';
import { detectAgentAccess, getAgentAccessBlockedMessage } from '$lib/services/agent-access';
import { reconnoiter, buildProjectTree, readProjectFilesForContext } from '$lib/services/orchestrator/recon';
import { agentInputRequest, isPromiseOnlyReply, isDeferredCompletionReply, cleanOrchestratorReply, formatTurnSummary, composeTurnReply, parseTodoList, mergeTodoItems, advanceTodoItems, findOmittedPlanItems, todoMarkerStatus, todoIsDone, formatDocumentsIndexBlock, MAX_PLAN_ITEMS, type ChatTurnTodoItem, type DocumentsIndexEntry } from '$lib/services/orchestrator/chat-turn';
import { toolArgStr, toolArgNum, toolArgBool, toolArgStrArr, BRAIN_TOOL_OUTPUT_CAP, BRAIN_REVIEW_OUTPUT_CAP, type BrainMode, type BrainToolCall, type BrainToolResult } from '$lib/services/orchestrator/brain-tools';
import {
  aiProvider,
  currentAiModel,
  isLocalProvider,
  getProviderDef,
  getProviderBaseUrl,
  announceAgentCompletions,
  type AiProviderId,
} from '$lib/stores/settings';
import { isProviderApiKeyConfiguredLocal, providerApiKeyExists } from '$lib/services/ai-keychain';
import { announceViaRealtimeVoice } from '$lib/services/realtime-voice';
import { playNudge } from '$lib/services/nudge';
import {
  createTaskRecord,
  transitionTask,
  cancelTask,
  type OrchestratorTask,
} from '$lib/services/orchestrator/task-lifecycle';
import { classifyTaskAfterExecution } from '$lib/services/orchestrator/review-gate';
import {
  makeActivityEvent,
  appendActivity,
  captureTranscript,
  MAX_ACTIVITY_EVENTS,
  MAX_TRANSCRIPT_CHARS,
  type ActivityKind,
  type ActivityEvent,
} from '$lib/services/orchestrator/activity-log';
import {
  describeTurnEnd,
  type AgentTurnOutcome,
  type TurnEndPresentation,
} from '$lib/services/orchestrator/agent-turn-watch';
import { agentCanReport } from '$lib/services/orchestrator/agent-capabilities';
import type { HookSignal } from '$lib/services/orchestrator/agent-hook-signals';
import type { ChatAccessMode, ChatAttachment, ChatInlineRequest, ChatMessageType, ChatReasoningEffort } from '$lib/types/chat';
import { getAgentAdapter, disposeAgentAdapter } from '$lib/services/orchestrator/agent-adapter';
import { requestAmbientLayout, requestRoomControl, layoutSnapshot } from '$lib/stores/layoutControl';
import {
  leaseOrchestratorTerminal,
  releaseOrchestratorTerminal,
  resendOrchestratorGoal as resendLeasedOrchestratorGoal,
  sendOrchestratorGoalWhenReady,
  sendOrchestratorFollowUpWhenReady,
  applyOrchestratorAgentName,
} from '$lib/services/orchestrator/terminal-lease';
import { pickAssistantName, isGenericAgentName } from '$lib/services/orchestrator/agent-names';
import { createTaskWorktree, removeTaskWorktree, mergeTaskWorktree, reclaimWorktree, listWorktreesOnDisk, pruneWorktrees, sweepAgentBranches, renameTaskWorktree, deriveFirstWorkBranch, type WorktreeInfo } from '$lib/services/orchestrator/worktree-manager';
import {
  initWorktreeReconciler,
  reconcileNow,
  forgetWorktree,
  stageWorktreeNow,
  type TrackedWorktree,
} from '$lib/services/orchestrator/worktree-reconciler';
import { autoStageAgentChanges } from '$lib/stores/settings';
import {
  buildEmbeddedCommand,
  detectShellKind,
  parseEmbeddedExitCode,
  EMBEDDED_DONE_PREFIX,
} from '$lib/services/embeddedCommand';
import {
  appendLegacyChatMessage,
  clearProjectThreadMessages,
  findThreadIdForTask,
  findThreadIdForMessage,
  getChatThread,
  getThreadMessageSnapshot,
  patchThreadMessage,
  moveThreadMessageToEnd,
  removeThreadMessagesFrom,
  removeThreadMessage,
  updateChatThread,
  setChatTurnTicker,
  advanceChatTurnTicker,
  clearChatTurnTicker,
  type ChatThreadStatus,
} from '$lib/stores/chatThreads';
import { requestAgentPlacement, defaultAgentPlacement, type AgentPlacement } from '$lib/stores/agentPlacement';
import { buildAgentCharter, buildAgentTaskMessage, type AgentRole } from '$lib/services/orchestrator/agent-charter';
import { parseReviewerVerdict } from '$lib/services/orchestrator/reviewer-verdict';
import { agentReadsRulesFile } from '$lib/services/orchestrator/agent-rules-file';
import { isChatAgentProvider } from '$lib/services/agent-provider-catalogue';
import {
  getProjectMemoryLines,
  loadProjectMemory,
  rememberTask,
} from '$lib/services/orchestrator/memory';
import {
  ORCHESTRATOR,
  USER,
  activeClaims,
  getMailboxCards,
  getMailboxLines,
  getProjectMailbox,
  findClaimConflicts,
  loadProjectMailbox,
  postMailboxMessage,
  dismissMailboxCard,
  type MailboxCard,
} from '$lib/services/orchestrator/mailbox';
import { acknowledge, loadProjectInbox } from '$lib/services/orchestrator/inbox';
import {
  getKnowledgeLines,
  loadKnowledgeGraph,
} from '$lib/services/orchestrator/knowledge';
import {
  getProfileLines,
  loadProjectProfile,
  reflectAndEvolve,
} from '$lib/services/orchestrator/evolve';
import {
  onSessionExit,
  onAgentDetected,
  getAgentDisplayName,
  promptBarInput,
  focusPromptBar,
  summarizeTerminalTask,
  getTerminalProjectState,
  killSession,
  createTerminalSession,
  sendPromptToSession,
  sessionHasRunningProcess,
  markOrchestratorTrackedSession,
  unmarkOrchestratorTrackedSession,
  setSessionExecuting,
  setSessionWorktree,
  setActiveSession,
  getSessionOutputBuffer,
  getSessionOutputLength,
  getSessionOutputSince,
  getActiveTerminalProjectId,
  allProjectSessions,
} from '$lib/stores/terminal';

export type {
  OrchestratorTask,
  OrchestratorTaskStatus,
} from '$lib/services/orchestrator/task-lifecycle';
export type { ActivityEvent, ActivityKind } from '$lib/services/orchestrator/activity-log';

// ─── Model ──────────────────────────────────────────────────────────────────
// Agent orchestrator: one task owns one terminal (single-agent lease).
// Multiple agents share the workspace and can exchange information via
// the orchestrator brain's `send` action.

// All loaded orchestrator tasks across projects (active project's are kept fresh).
export const orchestratorTasks = writable<OrchestratorTask[]>([]);

export function getProjectOrchestratorTasks(projectId: string) {
  return derived(orchestratorTasks, ($all) => $all.filter((t) => t.projectId === projectId));
}

/** Read durable task history without loading the rest of the orchestrator runtime. */
export async function readProjectOrchestratorTaskSummaries(project: { id: string; root_path: string }): Promise<OrchestratorTask[]> {
  try {
    const raw = await readProjectState(project.id, project.root_path, 'orchestrator.json');
    const parsed = JSON.parse(raw ?? '');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((task) => normalizeLoadedTask(task as Partial<PersistedTask>))
      .filter((task): task is OrchestratorTask => task !== null);
  } catch {
    return [];
  }
}

// projectId → root_path so flushes can write without the full project object.
const projectPaths = new Map<string, string>();
const threadIdByTaskId = new Map<string, string>();

function threadStatusForTask(task: OrchestratorTask): ChatThreadStatus {
  switch (task.status) {
    case 'in-progress': return 'working';
    case 'blocked': return 'needs-input';
    case 'complete': return 'complete';
    case 'failed':
    case 'cancelled': return 'failed';
    case 'todo': return 'draft';
  }
}

function threadIdForTask(task: OrchestratorTask, preferredThreadId?: string): string | null {
  const known = preferredThreadId ?? threadIdByTaskId.get(task.id) ?? findThreadIdForTask(task.projectId, task.id);
  if (known) threadIdByTaskId.set(task.id, known);
  return known ?? null;
}

function syncChatThreadTask(task: OrchestratorTask, preferredThreadId?: string): void {
  const threadId = threadIdForTask(task, preferredThreadId);
  if (!threadId) return;
  const now = Date.now();
  updateChatThread(threadId, {
    taskId: task.id,
    sessionId: task.assignedSessionId ?? task.lastSessionId ?? null,
    agentName: task.name ?? null,
    agentPreset: task.agentPreset ?? null,
    status: threadStatusForTask(task),
    updatedAt: now,
    lastActivityAt: now,
  });
}

type PersistedTask = Omit<Partial<OrchestratorTask>, 'status'> & {
  id: string;
  projectId: string;
  goal: string;
  title?: string;
  status?: OrchestratorTask['status'] | 'pending' | 'running' | 'done';
};

function normalizeLoadedTask(raw: Partial<PersistedTask> | null | undefined): OrchestratorTask | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.projectId !== 'string') return null;

  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  let status: OrchestratorTask['status'];
  switch (raw.status) {
    case 'pending':
      status = 'todo';
      break;
    case 'running':
      status = 'in-progress';
      break;
    case 'done':
      status = 'complete';
      break;
    case 'todo':
    case 'in-progress':
    case 'complete':
    case 'blocked':
    case 'failed':
    case 'cancelled':
      status = raw.status;
      break;
    // Legacy 'in-review' status is handled via the default case below.
    default:
      status = 'todo';
      break;
  }

  return {
    id: raw.id,
    projectId: raw.projectId,
    goal,
    title:
      typeof raw.title === 'string' && raw.title.trim()
        ? raw.title
        : summarizeTerminalTask(goal) || goal.slice(0, 72) || 'Untitled task',
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
    status,
    agentPreset: raw.agentPreset ?? null,
    role: raw.role ?? null,
    assignedSessionId: status === 'in-progress' ? raw.assignedSessionId ?? null : null,
    blockedReason: raw.blockedReason ?? null,
    failureReason: raw.failureReason ?? null,
    promptSentAt: status === 'in-progress' && typeof raw.promptSentAt === 'number' ? raw.promptSentAt : null,
    activity: Array.isArray(raw.activity) ? raw.activity.slice(-MAX_ACTIVITY_EVENTS) : [],
    transcript:
      typeof raw.transcript === 'string' && raw.transcript
        ? raw.transcript.slice(-MAX_TRANSCRIPT_CHARS)
        : null,
    worktree: raw.worktree ?? null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : null,
    completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : null,
  };
}

type LaunchState = {
  generation: number;
  cancelled: boolean;
};

const launchStateByTaskId = new Map<string, LaunchState>();

function nextLaunchGeneration(taskId: string): number {
  const generation = (launchStateByTaskId.get(taskId)?.generation ?? 0) + 1;
  launchStateByTaskId.set(taskId, { generation, cancelled: false });
  return generation;
}

function cancelPendingLaunch(taskId: string): void {
  const current = launchStateByTaskId.get(taskId);
  if (current) current.cancelled = true;
}

function clearLaunchGeneration(taskId: string, generation: number): void {
  const current = launchStateByTaskId.get(taskId);
  if (current?.generation === generation) {
    launchStateByTaskId.delete(taskId);
  }
}

function releaseTaskLease(task: OrchestratorTask): void {
  const liveSession = getTerminalProjectState(task.projectId).sessions.find((session) => session.ownerTaskId === task.id);
  if (!liveSession) return;
  releaseOrchestratorTerminal(liveSession.id);
}


// ─── Persistence ──────────────────────────────────────────────────────────────

export async function loadProjectOrchestratorTasks(project: { id: string; root_path: string }): Promise<void> {
  projectPaths.set(project.id, project.root_path);
  await loadProjectMemory(project.id, project.root_path);
  await loadProjectMailbox(project.id, project.root_path);
  // Seed on first run only: everything already on the board counts as seen, so
  // the badge starts at zero instead of at the project's whole history.
  await loadProjectInbox(project.id, project.root_path, () => [
    ...getMailboxCards(project.id, { limit: 200, actionableOnly: true, includeSeen: true }).map((c) => c.id),
    ...(get(chatMessages)[project.id] ?? []).filter((m) => m.completion).map((m) => m.id),
  ]);
  await loadKnowledgeGraph(project.id, project.root_path);
  await loadProjectProfile(project.id, project.root_path);
  let rawPersistedTasks: Array<Partial<PersistedTask> | null | undefined> = [];
  try {
    const raw = await readProjectState(project.id, project.root_path, 'orchestrator.json');
    const parsed = JSON.parse(raw ?? '');
    if (Array.isArray(parsed)) {
      rawPersistedTasks = parsed as Array<Partial<PersistedTask> | null | undefined>;
    }
  } catch {
    // No file yet — start empty.
  }

  // Reconcile persisted state with live terminals. A task can only still be
  // "in-progress" if its leased terminal is actually alive in this project's
  // terminal state; otherwise (app restart, terminal closed) reset to todo.
  const liveSessions = getTerminalProjectState(project.id).sessions;
  let needsFlush = false;
  let reconciledTasks: OrchestratorTask[] = [];

  for (const rawTask of rawPersistedTasks) {
    const task = normalizeLoadedTask(rawTask);
    if (!task) {
      needsFlush = true;
      continue;
    }

    let reconciledTask = task;

    if (task.status === 'in-progress') {
      const ownedSession = liveSessions.find((s) => s.ownerTaskId === task.id);
      const assignedSession =
        task.assignedSessionId != null
          ? liveSessions.find((s) => s.id === task.assignedSessionId)
          : undefined;
      const session = ownedSession ?? assignedSession;
      if (!session?.isRunning || session.ownerTaskId !== task.id) {
        reconciledTask = { ...transitionTask(task, 'todo'), assignedSessionId: null, startedAt: null, completedAt: null };
      } else if (reconciledTask.assignedSessionId !== session.id) {
        reconciledTask = { ...reconciledTask, assignedSessionId: session.id };
      }
    } else if (task.status === 'todo') {
      // A todo task with a live terminal still owned by it (e.g. the agent was
      // re-attached, or status was reset while the terminal kept running) is
      // actually in progress — reclaim it instead of stranding the session.
      const ownedSession = liveSessions.find((s) => s.ownerTaskId === task.id && s.isRunning);
      if (ownedSession) {
        reconciledTask = { ...transitionTask(task, 'in-progress'), assignedSessionId: ownedSession.id };
      } else if (task.assignedSessionId != null || task.startedAt != null || task.completedAt != null) {
        reconciledTask = { ...task, assignedSessionId: null, startedAt: null, completedAt: null };
      }
    } else if (task.assignedSessionId != null) {
      reconciledTask = { ...task, assignedSessionId: null };
    }

    if (
      rawTask?.goal !== reconciledTask.goal ||
      rawTask?.title !== reconciledTask.title ||
      (rawTask?.name ?? null) !== reconciledTask.name ||
      rawTask?.status !== reconciledTask.status ||
      (rawTask?.agentPreset ?? null) !== reconciledTask.agentPreset ||
      (rawTask?.assignedSessionId ?? null) !== reconciledTask.assignedSessionId ||
      (rawTask?.blockedReason ?? null) !== reconciledTask.blockedReason ||
      (rawTask?.failureReason ?? null) !== reconciledTask.failureReason ||
      (rawTask?.promptSentAt ?? null) !== reconciledTask.promptSentAt ||
      rawTask?.createdAt !== reconciledTask.createdAt ||
      (rawTask?.startedAt ?? null) !== reconciledTask.startedAt ||
      (rawTask?.completedAt ?? null) !== reconciledTask.completedAt
    ) {
      needsFlush = true;
    }

    reconciledTasks.push(reconciledTask);
  }

  // Cap completed/failed/blocked/cancelled tasks to prevent unbounded growth.
  const MAX_ORCHESTRATOR_TASKS = 100;
  const terminalIds = ['complete', 'failed', 'blocked', 'cancelled'] as const;
  let capped = 0;
  const cappedTasks = reconciledTasks.filter((t) => {
    if ((terminalIds as readonly string[]).includes(t.status)) {
      capped++;
      return capped <= MAX_ORCHESTRATOR_TASKS;
    }
    return true;
  });
  if (cappedTasks.length !== reconciledTasks.length) {
    reconciledTasks = cappedTasks;
    needsFlush = true;
  }

  // Adopted tasks aren't persisted, so a reload would otherwise wipe agents the
  // user launched by hand that are still running. Preserve the live ones.
  const liveAdopted = get(orchestratorTasks).filter(
    (t) =>
      t.projectId === project.id &&
      t.adopted &&
      t.status === 'in-progress' &&
      liveSessions.some((s) => s.id === t.assignedSessionId && s.isRunning)
  );
  orchestratorTasks.update((all) => [
    ...all.filter((t) => t.projectId !== project.id),
    ...reconciledTasks,
    ...liveAdopted,
  ]);
  if (needsFlush) await flush(project.id);

  // Fire-and-forget: a best-effort sweep must never reject into the void and
  // take down project load with an unhandled rejection. Branches after
  // checkouts — removing a worktree is what frees its branch for deletion.
  void sweepOrphanWorktrees(project.id)
    .then(() => sweepAgentBranchesForProject(project.id))
    .catch(() => {});
}

async function flush(projectId: string): Promise<void> {
  if (!projectPaths.has(projectId)) return;
  // Adopted tasks track manually-launched agents and die with the process —
  // they're in-memory only, never written to disk.
  const projectTasks = get(orchestratorTasks).filter((t) => t.projectId === projectId && !t.adopted);
  try {
    await backendInvoke('project_state_write', {
      projectId,
      key: 'orchestrator.json',
      content: JSON.stringify(projectTasks, null, 2),
    });
  } catch (err) {
    console.error('Failed to save orchestrator tasks:', err);
    showToast('Task state could not be saved, so changes may be lost on restart', 'error', 8000);
  }
}

function patchTask(id: string, patch: (t: OrchestratorTask) => OrchestratorTask): OrchestratorTask | null {
  let projectId = '';
  let updated: OrchestratorTask | null = null;
  orchestratorTasks.update((all) =>
    all.map((t) => {
      if (t.id !== id) return t;
      projectId = t.projectId;
      updated = patch(t);
      return updated;
    })
  );
  if (projectId) void flush(projectId);
  return updated;
}

// ─── Activity log ─────────────────────────────────────────────────────────────
// A durable record of what each agent did: a structured event timeline plus a
// verbatim (ANSI-stripped) snapshot of its terminal output. Both are persisted
// on the task so the record survives restarts and terminal close.

/** Record one timeline event onto a task (capped + persisted). */
export function logTaskActivity(taskId: string, kind: ActivityKind, text: string): void {
  if (!text.trim()) return;
  patchTask(taskId, (t) => ({
    ...t,
    activity: appendActivity(t.activity, makeActivityEvent(kind, text)),
  }));
}

/**
 * Snapshot the agent's live terminal output onto the task as a readable
 * transcript. Reads the session's rolling output buffer, strips control codes,
 * and stores the most recent tail. No-op when there's nothing captured.
 */
export function captureTaskTranscript(taskId: string, sessionId?: number | null): void {
  const task = get(orchestratorTasks).find((t) => t.id === taskId);
  if (!task) return;
  const sid = sessionId ?? task.assignedSessionId;
  if (sid == null) return;
  const transcript = getAgentAdapter(sid).readOutput();
  if (!transcript) return;
  patchTask(taskId, (t) => ({ ...t, transcript }));
}

/**
 * Read a task's transcript. Prefers the live terminal buffer whenever the
 * agent's session is still running — including after the turn was marked done —
 * because CLI agents stay alive in their REPL and may print their actual answer
 * a beat after a (sometimes premature) idle/bell completion. Falls back to the
 * frozen snapshot captured at completion when the session is gone.
 */
export function getTaskTranscript(task: OrchestratorTask): string {
  const sid = task.assignedSessionId ?? task.lastSessionId ?? null;
  if (sid != null) {
    const session = getTerminalProjectState(task.projectId).sessions.find((s) => s.id === sid);
    // While in-progress the lease guarantees liveness; after completion only read
    // if the process is genuinely still running, so a dead session doesn't mask
    // the durable snapshot.
    if (task.status === 'in-progress' || session?.isRunning) {
      const live = getAgentAdapter(sid).readOutput();
      // Keep whichever has more content — late output should win, but never
      // regress to a thinner live read if the snapshot captured more.
      if (live && live.length >= (task.transcript?.length ?? 0)) return live;
    }
  }
  return task.transcript ?? '';
}

// ─── Turn completion ──────────────────────────────────────────────────────────
// A leased agent finishing a turn isn't a process exit (the REPL stays alive),
// so we detect it from output signals and reconcile the task here.

/**
 * The LLM that powers the orchestrator brain — always the main AI provider and
 * model configured under AI / Models.
 *
 * Voice used to select its own provider/model here. It no longer does: a
 * realtime call brings its own brain, and the work it delegates through the
 * `spacron_orchestrator` tool is the SAME orchestrator every other surface
 * talks to, so giving spoken turns a second brain only meant two things to
 * configure and two ways for them to disagree.
 */
function getConversationLlmConfig(overrides?: { provider?: AiProviderId; model?: string; sessionId?: string }): RouteLlmConfig {
  const provider = overrides?.provider ?? get(aiProvider);
  const local = isLocalProvider(provider);
  const baseUrl = local ? getProviderBaseUrl(provider) : '';
  const model = overrides?.model?.trim() || (provider === get(aiProvider)
    ? get(currentAiModel)
    : getProviderDef(provider).defaultModel);
  return { provider, model, hasApiKey: isProviderApiKeyConfiguredLocal(provider), baseUrl, sessionId: overrides?.sessionId };
}

function isLlmConfigAvailable(config: RouteLlmConfig): boolean {
  return isLocalProvider(config.provider)
    ? Boolean(config.baseUrl)
    : Boolean(config.hasApiKey);
}

/**
 * Agent completion cards can belong to a Chat thread whose provider/model is
 * different from the global Settings selection. Keep follow-up summaries on
 * that originating connection; legacy agent-only threads fall back to global
 * Settings instead of being treated as AI provider ids.
 */
function getChatThreadLlmOverrides(threadId?: string): { provider?: AiProviderId; model?: string; sessionId?: string } | undefined {
  if (!threadId) return undefined;
  const thread = getChatThread(threadId);
  const rawProvider = thread?.provider?.trim();
  if (!rawProvider) return undefined;
  const provider = rawProvider as AiProviderId;
  if (getProviderDef(provider).id !== provider) return undefined;
  return {
    provider,
    model: thread?.model?.trim() || undefined,
    sessionId: threadId,
  };
}

/**
 * Resolve the brain connection at the point a turn is sent. The synchronous
 * cache is useful for render-time checks, but it can still be empty while the
 * startup keychain scan is running. A send must wait for the authoritative
 * existence check so a Composer-selected provider is not mistaken for an
 * unconfigured one.
 */
async function resolveConversationLlmConfig(
  overrides?: { provider?: AiProviderId; model?: string; sessionId?: string },
): Promise<RouteLlmConfig> {
  const config = getConversationLlmConfig(overrides);
  if (!isLocalProvider(config.provider)) {
    config.hasApiKey = await providerApiKeyExists(config.provider, { fresh: true });
  }
  return config;
}

const SUMMARY_TRANSCRIPT_CHARS = 3000;

async function generateTranscriptSummary(
  transcript: string,
  status: CompletionSummary['status'],
  llmConfig: RouteLlmConfig,
): Promise<string> {
  const tail = transcript.length > SUMMARY_TRANSCRIPT_CHARS
    ? transcript.slice(-SUMMARY_TRANSCRIPT_CHARS)
    : transcript;
  const outcome =
    status === 'failed' ? 'The agent did not complete the task successfully.' :
    status === 'blocked' ? 'The agent stopped and needs human input to continue.' :
    'The agent completed the task.';
  const systemPrompt =
    `Summarize what a coding agent just did based on its terminal output. ${outcome}\n` +
    `Write 1–2 concise sentences. Name specific files created or modified, commands run, and what was accomplished. Be factual and direct.`;
  if (!isLlmConfigAvailable(llmConfig)) return '';
  return await invoke<string>('ai_complete', {
    systemPrompt,
    userText: `Terminal output:\n\n${tail}`,
    provider: llmConfig.provider,
    model: llmConfig.model,
    apiKey: '',
    baseUrl: llmConfig.baseUrl || undefined,
    sessionId: llmConfig.sessionId,
  });
}

/**
 * Give a light audible nudge when an agent turn ends — enough to pull the
 * user's attention, not a spoken report. Outside voice mode this is a soft
 * status-flavored chime; during a live realtime voice
 * call the model drops a short one-liner instead, since a chime would be odd
 * mid-conversation. The recap lives in the chat completion card, not the audio.
 */
function announceCompletionAloud(
  name: string,
  status: CompletionSummary['status'],
  title: string
): void {
  if (!get(announceAgentCompletions)) return;
  if (get(agentVoiceModeActive)) {
    const line =
      status === 'blocked' ? `${name} needs your input: ${title}.` :
      status === 'failed' ? `${name} failed: ${title}.` :
      `${name} finished: ${title}.`;
    // Inject the update into the live call so the model mentions it in its own
    // voice. If no call is actually up (announceViaRealtimeVoice returns false)
    // fall back to the chime rather than letting the update pass unheard.
    if (!announceViaRealtimeVoice(line)) {
      playNudge(status);
    }
    return;
  }
  playNudge(status);
}

/** True while `sessionId` is the live, running terminal still leased to `taskId`. */
function leasedSessionLive(taskId: string, sessionId: number): boolean {
  const task = get(orchestratorTasks).find((t) => t.id === taskId);
  if (!task || task.status !== 'in-progress' || task.assignedSessionId !== sessionId) return false;
  const live = getTerminalProjectState(task.projectId).sessions.find((s) => s.id === sessionId);
  // Adopted agents are tracked without claiming the `ownerTaskId` lease (so the
  // terminal's own auto-brief still runs), so for them a running session is enough.
  return Boolean(live?.isRunning && (task.adopted || live.ownerTaskId === task.id));
}

/**
 * Post an agent's turn outcome to the shared mailbox so the rest of the team (and
 * the orchestrator's surfacing) sees what just happened without the user relaying
 * it. Complete ⇒ `done`; blocked/failed ⇒ `note`. Broadcast to the whole team.
 */
/**
 * The name of a Reviewer on this project's team that can receive a hand-off — a
 * task tagged with the `reviewer` role that is still alive (not complete/failed/
 * cancelled), excluding the handing-off task itself. Null when the team has none.
 */
function findTeamReviewer(projectId: string, excludeTaskId: string): string | null {
  const reviewer = get(orchestratorTasks).find(
    (t) =>
      t.projectId === projectId &&
      t.id !== excludeTaskId &&
      t.role === 'reviewer' &&
      t.status !== 'complete' &&
      t.status !== 'failed' &&
      t.status !== 'cancelled'
  );
  if (!reviewer) return null;
  return reviewer.name
    ?? (reviewer.agentPreset ? getAgentDisplayName(reviewer.agentPreset) : null)
    ?? reviewer.agentPreset
    ?? null;
}

/** Only a Reviewer's own output can approve or bounce back a handoff. */
function isReviewer(task: OrchestratorTask): boolean {
  return task.role === 'reviewer';
}

const AGENT_ROLES: readonly AgentRole[] = ['coordinator', 'builder', 'scout', 'reviewer', 'orchestrator'];

/**
 * Narrow a terminal session's `role` to an orchestrator `AgentRole`.
 *
 * `session.role` is the terminal PANE LABEL — a free-form string that is the
 * agent's own name ("Trinity") for orchestrator agents, and "Build" / "Server" /
 * "Agent" elsewhere. It is not the team role. The previous `as AgentRole` cast
 * merely silenced the type error, so adopted tasks were given nonsense roles:
 * `ROLE_BRIEFS[role]` came back undefined and `task.role === 'builder'` never
 * matched, which meant adopted agents never produced a handoff. Anything that
 * isn't a real role becomes null.
 */
function toAgentRole(value: string | null | undefined): AgentRole | null {
  const v = value?.trim().toLowerCase();
  return v && (AGENT_ROLES as readonly string[]).includes(v) ? (v as AgentRole) : null;
}

/**
 * When a Reviewer bounces a handoff back, route the feedback to the Builder
 * automatically. Posts a note to the mailbox addressed to the Builder so the
 * orchestrator brain sees it on the next turn and can re-dispatch the work.
 */
async function handleBounceBack(task: OrchestratorTask): Promise<boolean> {
  if (task.status !== 'complete' || !isReviewer(task)) return false;

  const verdict = parseReviewerVerdict(getTaskTranscript(task));
  if (verdict?.kind !== 'bounce') return false;
  const feedback = verdict.feedback;

  const from = task.name
    ?? (task.agentPreset ? getAgentDisplayName(task.agentPreset) : null)
    ?? task.agentPreset
    ?? 'Reviewer';
  const rootPath = projectPaths.get(task.projectId);
  if (!rootPath) return false;

  // Find the original Builder by looking for the last handoff addressed to this Reviewer
  const messages = getProjectMailbox(task.projectId);
  const handoff = [...messages]
    .reverse()
    .find((m) => m.kind === 'handoff' && m.to === from && m.taskId);
  if (!handoff) return false;

  // Post the feedback to the mailbox so it surfaces in the orchestrator context
  await postMailboxMessage(task.projectId, rootPath, {
    from,
    to: handoff.from,
    kind: 'note',
    taskId: handoff.taskId,
    text: `Bounced back. ${feedback}`,
  });

  logTaskActivity(task.id, 'info', `Bounced back to ${handoff.from}: ${feedback.slice(0, 120)}`);

  // Try to deliver the feedback directly to the Builder's live terminal and
  // re-mark its task as in-progress so the orchestrator UI stays consistent.
  let redelivered = false;
  if (handoff.taskId) {
    const builderTask = get(orchestratorTasks).find((t) => t.id === handoff.taskId);
    const builderSid = builderTask?.lastSessionId ?? builderTask?.assignedSessionId;
    if (builderSid != null && builderTask) {
      const session = getTerminalProjectState(task.projectId).sessions.find((s) => s.id === builderSid);
      if (session?.isRunning) {
        try {
          await sendOrchestratorFollowUpWhenReady(
            builderSid,
            `The Reviewer bounced your work back with these fixes needed:\n\n${feedback}\n\nPlease redo the work addressing these issues.`,
            { shouldContinue: () => true }
          );
          // Re-mark the Builder as in-progress so the UI reflects it's working again
          patchTask(handoff.taskId, (t) => ({
            ...t,
            status: 'in-progress',
            completedAt: null,
            assignedSessionId: builderSid,
          }));
          logTaskActivity(handoff.taskId, 'info', 'Bounced back by Reviewer, redoing work');
          redelivered = true;
        } catch (err) {
          console.warn('Failed to re-engage Builder after bounce-back:', err);
        }
      }
    }
  }

  showToast(
    redelivered
      ? `Reviewer bounced back to ${handoff.from}, redoing work now`
      : `Reviewer bounced back to ${handoff.from}: ${feedback.slice(0, 80)}`,
    redelivered ? 'success' : 'info',
    8000, true,
  );
  return true;
}

/**
 * When a Reviewer approves a handoff, merge the Builder's worktree branch
 * automatically. Finds the original Builder from mailbox history, gets its
 * worktree, and merges it into main with cleanup.
 */
async function handleApproved(task: OrchestratorTask): Promise<void> {
  if (task.status !== 'complete' || !isReviewer(task)) return;

  const verdict = parseReviewerVerdict(getTaskTranscript(task));
  if (verdict?.kind !== 'approved') return;
  const approvedBranch = verdict.branch;

  const from = task.name
    ?? (task.agentPreset ? getAgentDisplayName(task.agentPreset) : null)
    ?? task.agentPreset
    ?? 'Reviewer';
  const rootPath = projectPaths.get(task.projectId);
  if (!rootPath) return;

  // Find the original Builder and its worktree from mailbox history
  const messages = getProjectMailbox(task.projectId);
  const handoff = [...messages]
    .reverse()
    .find((m) => m.kind === 'handoff' && m.to === from && m.taskId);
  if (!handoff || !handoff.taskId) return;

  const builderTask = get(orchestratorTasks).find((t) => t.id === handoff.taskId);
  const worktree = builderTask?.worktree ?? null;
  if (!worktree) {
    showToast(`Reviewer approved, but ${handoff.from} had no worktree, so there is nothing to merge`, 'info', 6000);
    return;
  }

  // The Reviewer names the branch it approved. Merging a DIFFERENT branch than
  // the one that was reviewed would defeat the point of the gate, so require
  // them to agree before touching git.
  if (approvedBranch !== worktree.branch) {
    logTaskActivity(
      task.id,
      'blocked',
      `Approval named branch '${approvedBranch}' but the handoff's worktree is '${worktree.branch}', so nothing was merged.`,
    );
    showToast(
      `Reviewer approved '${approvedBranch}' but ${handoff.from} is on '${worktree.branch}', so the merge was skipped. Review it manually.`,
      'warning',
      10000, true,
    );
    return;
  }

  try {
    const result = await mergeTaskWorktree(task.projectId, worktree, true);
    if (result.success) {
      // The merge removed the worktree and branch; drop the now-dangling ref.
      forgetWorktree(worktree.path);
      patchTask(handoff.taskId, (t) => ({ ...t, worktree: null }));
      const what = result.alreadyUpToDate
        ? `Branch ${worktree.branch} held nothing new, so it was approved and the worktree cleaned up`
        : `Auto-merged branch ${worktree.branch} after approval`;
      logTaskActivity(task.id, 'info', what);
      logTaskActivity(handoff.taskId, 'info', what);
      showToast(
        result.alreadyUpToDate
          ? `Approved. ${handoff.from}'s branch held nothing to merge.`
          : `Approved and merged ${handoff.from}'s branch into main`,
        result.alreadyUpToDate ? 'info' : 'success',
        8000,
        !result.alreadyUpToDate,
      );
    } else if (result.conflicted) {
      showToast(`Merge conflict on approval: ${result.message}`, 'warning', 10000, true);
    } else {
      showToast(`Merge failed on approval: ${result.message}`, 'error', 8000, true);
    }
  } catch (err) {
    showToast(`Auto-merge failed: ${err}`, 'error', 8000);
  }
}

/**
 * Apply a Reviewer's verdict at most once per finished turn.
 *
 * A bounce-back and an approval are mutually exclusive outcomes, but they used
 * to be fired as two independent `void` calls — so a transcript matching both
 * (which, before the regexes were anchored, was every transcript) would merge
 * the branch AND tell the builder to redo the work. Bounce-back wins: it is the
 * conservative outcome, and it touches no git state.
 */
async function handleReviewerVerdict(task: OrchestratorTask): Promise<void> {
  if (await handleBounceBack(task)) return;
  await handleApproved(task);
}

async function postAgentTurnToMailbox(task: OrchestratorTask, outcome: AgentTurnOutcome): Promise<void> {
  const from = task.name
    ?? (task.agentPreset ? getAgentDisplayName(task.agentPreset) : null)
    ?? task.agentPreset
    ?? 'Agent';
  const label = task.name ?? task.title ?? task.goal;
  const rootPath = projectPaths.get(task.projectId);
  if (task.status === 'complete') {
    // Capture any files this task claimed BEFORE the `done` below releases the
    // claim, so the handoff can tell the Reviewer exactly what changed.
    const claim = activeClaims(getProjectMailbox(task.projectId)).find((c) => c.taskId === task.id);
    // A guessed finish gets the weaker word here too — this log line is read
    // back by other agents, so "Finished" would launder a guess into a fact.
    const guessed = outcome.kind === 'finished' && outcome.via === 'inferred';
    await postMailboxMessage(task.projectId, rootPath, {
      from,
      kind: 'done',
      taskId: task.id,
      text: guessed ? `Went quiet: ${label}` : `Finished: ${label}`,
    });
    // Bi-directional handoff: a Builder that just finished hands its work to a
    // Reviewer directly — no user relay. The Reviewer gates it and either merges
    // or bounces it back with a note. Only fires when a reviewer is on the team.
    //
    // NOT on a guessed finish. `handoff` is an actionable kind, so it floats a
    // card AND dispatches a reviewer against the branch — off the back of
    // "output stopped growing for 90 seconds", which is equally a long compile.
    // Reviewing half-written work is worse than reviewing late: the builder's
    // real finish (declared, or its process exiting) still reaches here.
    if (task.role === 'builder' && !guessed) {
      const reviewer = findTeamReviewer(task.projectId, task.id);
      if (reviewer) {
        // Include the worktree branch so the Reviewer agent can git-diff the
        // builder's isolated branch and review the actual changed files.
        const worktreeBranch = task.worktree?.branch;
        await postMailboxMessage(task.projectId, rootPath, {
          from,
          to: reviewer,
          kind: 'handoff',
          taskId: task.id,
          files: claim?.files,
          worktreeBranch,
          text: worktreeBranch
            ? `Ready for review: ${label} (branch: ${worktreeBranch})`
            : `Ready for review: ${label}`,
        });
      }
    }
  } else if (task.status === 'blocked') {
    await postMailboxMessage(task.projectId, projectPaths.get(task.projectId), {
      from,
      kind: 'note',
      taskId: task.id,
      text: `Blocked on ${label}: ${outcome.kind === 'blocked' ? outcome.reason : 'needs input'}`,
    });
  } else if (task.status === 'failed') {
    await postMailboxMessage(task.projectId, projectPaths.get(task.projectId), {
      from,
      kind: 'note',
      taskId: task.id,
      text: `Failed on ${label}: ${task.failureReason ?? 'exited with errors'}`,
    });
  }
}

// ─── Mailbox card actions ─────────────────────────────────────────────────────
// The "needs you" strip (AgentMailboxCards) renders the actionable mailbox cards
// — report / handoff / ask — that want a human decision. These wire its buttons
// back to the sending agent: the user's words are recorded in the shared mailbox
// (so the whole team and the orchestrator's own context see them) and delivered
// straight into the agent's live REPL when it's still running — no user relay.

async function deliverMailboxReply(
  projectId: string,
  card: MailboxCard,
  text: string,
  rootPath: string | null | undefined,
): Promise<boolean> {
  const body = text.trim();
  if (!body) return false;
  // Record the user's decision on the shared board, addressed to the sender.
  await postMailboxMessage(projectId, rootPath ?? projectPaths.get(projectId), {
    from: USER,
    to: card.from,
    kind: 'note',
    taskId: card.taskId,
    text: body,
  });
  // Deliver it live to the agent if it's still running; a finished agent just
  // gets the note on the board.
  const task = resolveRunningTaskByName(projectId, card.from);
  let delivered = false;
  if (task && rootPath) {
    try {
      delivered = await sendFollowUpToAgent(task, body, rootPath);
    } catch (err) {
      console.error('Failed to deliver mailbox reply:', err);
    }
  }
  dismissMailboxCard(card.id);
  // Acting on a card is the strongest possible "I saw this", so it clears the
  // inbox's unread flag too — and unlike `mailboxSeen`, that survives a restart,
  // so a handled card can't float back up as a toast tomorrow.
  acknowledge(projectId, card.id);
  return delivered;
}

/** Reply to an actionable card: deliver `text` to the sending agent (if live) and note it to the team. */
export async function replyToMailboxCard(
  projectId: string,
  card: MailboxCard,
  text: string,
  rootPath: string | null | undefined,
): Promise<void> {
  const delivered = await deliverMailboxReply(projectId, card, text, rootPath);
  showToast(
    delivered ? `Sent to ${card.from}` : `Noted, but ${card.from} isn't live right now`,
    delivered ? 'info' : 'warning',
    3000,
  );
}

/** Approve an actionable card: tell the sending agent to proceed and clear the card. */
export async function approveMailboxCard(
  projectId: string,
  card: MailboxCard,
  rootPath: string | null | undefined,
): Promise<void> {
  const delivered = await deliverMailboxReply(projectId, card, 'Approved, please proceed.', rootPath);
  showToast(
    delivered ? `Approved · told ${card.from} to proceed` : `Approved, but ${card.from} isn't live right now`,
    delivered ? 'success' : 'info',
    3000,
  );
}

/**
 * Merge the worktree branch (if the card's task has one), then approve.
 * Shows conflict/error toasts and stops if the merge can't proceed.
 */
export async function mergeAndApproveMailboxCard(
  projectId: string,
  card: MailboxCard,
  rootPath: string | null | undefined,
): Promise<void> {
  // 1. If the card references a task with a worktree, merge it first.
  let merged = false;
  if (card.taskId && rootPath && projectPaths.has(projectId)) {
    const task = get(orchestratorTasks).find((t) => t.id === card.taskId);
    const worktree = task?.worktree ?? null;
    if (worktree) {
      try {
        const result = await mergeTaskWorktree(projectId, worktree, true);
        if (result.success) {
          merged = !result.alreadyUpToDate;
          // The merge removed the worktree and branch; drop the dangling ref.
          forgetWorktree(worktree.path);
          patchTask(card.taskId, (t) => ({ ...t, worktree: null }));
          showToast(
            result.alreadyUpToDate
              ? `Branch '${worktree.branch}' held nothing to merge`
              : `Merged branch '${worktree.branch}' into main`,
            result.alreadyUpToDate ? 'info' : 'success',
            4000,
          );
        } else if (result.conflicted) {
          showToast(`Merge conflict. Resolve it, then approve: ${result.message}`, 'warning', 10000);
          return; // Don't approve if there's a conflict
        } else {
          showToast(`Merge failed: ${result.message}`, 'error', 8000);
          return; // Don't approve if merge failed
        }
      } catch (err) {
        showToast(`Merge failed: ${err}`, 'error', 8000);
        return;
      }
    }
  }

  // 2. Send the approval to the agent.
  const delivered = await deliverMailboxReply(projectId, card, 'Approved, please proceed.', rootPath);
  showToast(
    merged
      ? `Merged & approved · told ${card.from} to proceed`
      : delivered
        ? `Approved · told ${card.from} to proceed`
        : `Approved, but ${card.from} isn't live right now`,
    merged || delivered ? 'success' : 'info',
    3000,
  );
}

/** Reclaim closed agents after bring-in/merge/commit, without importing new work.
 * Branch refs are retained until Git's branch sweep proves them merged. They are
 * cheap; the checkout and its dependencies are what take disk space.
 */
const cleanupInFlight = new Set<string>();
export async function cleanupStaleWorktrees(projectId: string): Promise<number> {
  if (cleanupInFlight.has(projectId)) return 0;
  cleanupInFlight.add(projectId);
  let attempted = 0;
  try {
    for (const entry of trackedWorktrees().filter((w) => w.projectId === projectId && !w.live)) {
      attempted++;
      const outcome = await reclaimWorktree(projectId, entry.worktree, { deleteBranch: false, stagePending: false });
      if (!outcome.removed) continue;
      forgetWorktree(entry.worktree.path);
      for (const task of get(orchestratorTasks)) {
        if (task.projectId === projectId && task.worktree?.path === entry.worktree.path) {
          patchTask(task.id, (t) => ({ ...t, worktree: null }));
        }
      }
      for (const isDev of [false, true]) {
        for (const session of getTerminalProjectState(projectId, isDev).sessions) {
          if (session.worktree?.path === entry.worktree.path) setSessionWorktree(session.id, null);
        }
      }
    }
    return attempted;
  } finally {
    cleanupInFlight.delete(projectId);
  }
}

export interface ReclaimAllOutcome {
  /** Checkouts actually deleted from disk. */
  removed: number;
  /** Checkouts kept because they still hold work git could not move. */
  kept: number;
  /** Agent names for the kept ones, so the caller can name them to the user. */
  keptAgents: string[];
}

/**
 * Reclaim every worktree belonging to a project — used when the project (or the
 * whole app) is closing, so agent checkouts don't accumulate on disk.
 *
 * Unlike `cleanupStaleWorktrees` this does **not** skip live agents: the panes
 * are being torn down as part of the same close, so "live" is about to stop
 * being true. It is still routed through `reclaimWorktree`, which stages
 * outstanding work onto the agent's branch and re-asks git before deleting
 * anything — so a checkout holding work is kept, not destroyed.
 *
 * `deleteBranch` is deliberately false. The branch is the only durable copy of
 * an agent's work until the user commits in Source Control, and it costs
 * essentially nothing on disk once the checkout is gone. Removing the checkout
 * is what reclaims the space the user cares about.
 *
 * Anything this misses (an app kill, a git lock) is caught by
 * `sweepOrphanWorktrees` on the next project load, so a partial run is safe.
 */
export async function reclaimProjectWorktrees(projectId: string): Promise<ReclaimAllOutcome> {
  const tracked = trackedWorktrees().filter((w) => w.projectId === projectId);
  const outcome: ReclaimAllOutcome = { removed: 0, kept: 0, keptAgents: [] };

  for (const entry of tracked) {
    const result = await reclaimWorktree(projectId, entry.worktree, { deleteBranch: false });
    if (result.removed) {
      outcome.removed += 1;
      forgetWorktree(entry.worktree.path);
      const task = get(orchestratorTasks).find((t) => t.worktree?.path === entry.worktree.path);
      if (task) patchTask(task.id, (t) => ({ ...t, worktree: null }));
    } else {
      outcome.kept += 1;
      outcome.keptAgents.push(entry.agentName);
    }
  }

  // Drop any checkout no task or session claims any more, and let git forget
  // administrative entries for the ones we just deleted.
  await sweepOrphanWorktrees(projectId);
  return outcome;
}

/**
 * Remove worktrees that exist on disk but are no longer tracked by any task or
 * session. Catches orphans left behind by app crashes, force-kills, or failed
 * cleanup. Runs on project load and periodically via the prune timer.
 */
export async function sweepOrphanWorktrees(projectId: string): Promise<number> {
  const onDisk = await listWorktreesOnDisk(projectId);
  if (onDisk.length === 0) return 0;

  const known = new Set<string>();
  for (const task of get(orchestratorTasks)) {
    if (task.worktree && task.projectId === projectId) known.add(task.worktree.path);
  }
  for (const isDev of [false, true]) {
    for (const session of getTerminalProjectState(projectId, isDev).sessions) {
      if (session.worktree) known.add(session.worktree.path);
    }
  }

  let removed = 0;
  for (const dir of onDisk) {
    if (known.has(dir)) continue;
    try {
      await backendInvoke('workspace_git_remove_worktree', {
        projectId,
        worktreePath: dir,
        deleteBranch: false,
        branch: null,
      });
      removed++;
    } catch {
      // Locked or in use — leave it for the next sweep.
    }
  }

  await pruneWorktrees(projectId);
  if (removed > 0) {
    console.info(`Swept ${removed} orphan worktree(s) for project ${projectId}`);
  }
  return removed;
}

/**
 * Delete agent branches that hold nothing the base branch doesn't already have.
 *
 * The counterpart to `sweepOrphanWorktrees`: that reclaims checkouts, this
 * reclaims the refs they leave behind. Every worktree removal outside the
 * post-commit path keeps its branch on purpose (it is the only durable copy of
 * unstaged work), and nothing ever came back for the ones that turned out to
 * hold nothing — an agent that never commits leaves a branch pointing at its
 * fork commit, which is an ancestor of the base by construction.
 *
 * Every branch a live session or task still claims is passed as `skip`, since
 * only the frontend knows that. Branches with unique commits are returned, not
 * deleted.
 */
export async function sweepAgentBranchesForProject(projectId: string): Promise<number> {
  const inUse = trackedWorktrees()
    .filter((w) => w.projectId === projectId)
    .map((w) => w.worktree.branch)
    .filter(Boolean);
  const sweep = await sweepAgentBranches(projectId, { skip: inUse });
  if (sweep.deleted.length > 0) {
    console.info(
      `Swept ${sweep.deleted.length} spent agent branch(es) for project ${projectId} (contained in ${sweep.base})`
    );
  }
  return sweep.deleted.length;
}

/** Whether the agent that owns this task still has a live terminal pane. */
function agentSessionLive(task: OrchestratorTask): boolean {
  const id = task.assignedSessionId ?? task.lastSessionId ?? null;
  if (id == null) return false;
  return sessionIsRunning(task.projectId, id);
}

/**
 * Reconcile a leased task once its agent turn ends (detected by the turn watcher
 * or by terminal exit). Idempotent: only acts while the task is still the
 * in-progress owner of `sessionId`, so the watcher and the exit handler can't
 * double-complete it. `notify` gates only the "right now" chime — it is
 * suppressed on process exit, where the terminal layer plays its own exit
 * nudge — and never the durable completion card, which must be written either
 * way to land in the inbox.
 */
async function completeLeasedTask(
  taskId: string,
  sessionId: number,
  outcome: AgentTurnOutcome,
  opts?: { notify?: boolean; exitCode?: number | null }
): Promise<void> {
  const task = get(orchestratorTasks).find((t) => t.id === taskId);
  if (!task || task.status !== 'in-progress' || task.assignedSessionId !== sessionId) return;

  const blocked = outcome.kind === 'blocked';
  const declaredFailure = outcome.kind === 'failed';
  // Snapshot the agent's terminal output before we release the lease, so the
  // durable record captures exactly what it did this turn.
  captureTaskTranscript(taskId, sessionId);
  const updated = patchTask(taskId, (t) => ({
    // Remember the session even though classify clears `assignedSessionId`, so we
    // can still read late output if the agent kept printing past its turn end
    // (the CLI process survives lease release). See getTaskTranscript.
    lastSessionId: sessionId,
    ...classifyTaskAfterExecution(t, {
      exitCode: opts?.exitCode ?? 0,
      needsHumanInput: blocked,
      failed: declaredFailure,
      note: blocked || declaredFailure ? outcome.reason : undefined,
    }),
  }));
  releaseOrchestratorTerminal(sessionId);
  setSessionExecuting(sessionId, false);

  if (updated) {
    if (updated.status === 'blocked') {
      logTaskActivity(taskId, 'blocked', outcome.kind === 'blocked' ? outcome.reason : 'Agent needs your input.');
    } else if (updated.status === 'failed') {
      logTaskActivity(taskId, 'failed', updated.failureReason ?? 'Agent exited with errors.');
    } else {
      logTaskActivity(
        taskId,
        'finished',
        outcome.kind === 'finished' && outcome.via === 'exit'
          ? 'Its process exited.'
          : 'Finished its turn.',
      );
    }
    const rememberedTask = get(orchestratorTasks).find((t) => t.id === updated.id) ?? updated;
    void rememberTask(updated.projectId, projectPaths.get(updated.projectId), rememberedTask);
    void postAgentTurnToMailbox(updated, outcome);
    void handleReviewerVerdict(updated);
  }

  if (!updated) return;
  const agentType = task.agentPreset
    ? getAgentDisplayName(task.agentPreset) ?? task.agentPreset
    : null;
  const name = task.name?.trim() || agentType || task.agentPreset || 'Agent';

  // A task launched FROM the task panel ("Run with agent") asks instead of
  // auto-completing: the agent ending its turn is evidence, not a decision, so
  // the user gets a one-click move of the card to Done. Only a clean finish
  // asks — blocked/failed need human judgement first. The click re-checks the
  // board: the card may have been moved or deleted while the agent worked.
  if (task.panelTaskId && updated.status === 'complete') {
    const panelTaskId = task.panelTaskId;
    const panelTask = get(tasks).find((t) => t.id === panelTaskId);
    if (panelTask && panelTask.status !== 'done') {
      showToast(
        `"${panelTask.title}": ${name} finished its turn.`,
        'info',
        12000,
        false,
        {
          label: 'Mark done',
          onClick: () => {
            const current = get(tasks).find((t) => t.id === panelTaskId);
            if (current && current.status !== 'done') updateTaskStatus(panelTaskId, 'done');
          },
        },
      );
    }
  }

  // The completion card below is the durable record — it must be written even
  // when the toast is suppressed, because the card is what lands in the inbox
  // for a finished agent the user was not watching.
  const elapsed = task.startedAt ? Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000)) : null;
  const told = describeTurnEnd(outcome);
  const completionStatus: CompletionSummary['status'] =
    updated.status === 'blocked' ? 'blocked' : updated.status === 'failed' ? 'failed' : 'done';
  const completionReason =
    updated.status === 'blocked' && outcome.kind === 'blocked' ? outcome.reason
    : updated.status === 'failed' ? updated.failureReason ?? told?.reason ?? null
    // A finished turn used to carry no text at all, which is what left the
    // inbox showing a name and a title and nothing else. When the agent said
    // what it did, that sentence is the message.
    : told?.reason ?? null;
  // A finish we merely inferred must not be worded as one the agent declared.
  // The task's own status can outrank the outcome (a non-zero exit makes a
  // "finished" turn `failed`), and those are observed facts — so only a `done`
  // card inherits the doubt.
  const completionEndedBy: NonNullable<CompletionSummary['endedBy']> =
    completionStatus === 'done' ? (told?.endedBy ?? 'declared') : 'declared';
  // …and an inferred finish does not interrupt — but ONLY when this agent had
  // a way to tell us and didn't. A CLI with no MCP config surface can never
  // report, so silencing its guesses would mean it finishes and the user hears
  // nothing at all. Those still raise a card; it just says "went quiet".
  //
  // "Output stopped growing for 90 seconds" is not evidence that an agent
  // finished — it is equally what a long compile, a slow tool call, or an agent
  // sitting at an untouched prompt looks like. Announcing those as completions
  // is the false "your agent has finished" the user gets while nothing has
  // happened, and it costs the real ones their credibility. The turn still
  // resolves (the lease must be released either way) and the card is still
  // written for the inbox; it just does not float, chime, or raise an OS
  // notification. Only something the agent actually said — or a fact we
  // observed, like a non-zero exit — is allowed to interrupt.
  const silent = completionEndedBy === 'inferred' && agentCanReport(task.agentPreset, sessionId);

  // The completion card is the one visual notification for this event — it
  // floats as the corner card and lands in the inbox (see AgentNotifications),
  // so an orchestrator toast here would duplicate it. Only the audible chime
  // fires as the "right now" cue. `notify: false` (process exit) skips even the
  // chime — the terminal layer plays its own exit nudge — but the card above is
  // written either way.
  if (opts?.notify !== false) {
    // The worktree is handled by the reconciler, not here. Nudging it just makes
    // staging feel immediate at the moment a turn ends; the guarantee that the
    // work is noticed comes from its poll, which still holds after this task
    // reaches `complete`, after the thread is cleared, and across restarts.
    if (updated.status !== 'blocked' && updated.status !== 'failed') {
      if (updated.worktree && projectPaths.has(updated.projectId)) void reconcileNow();
    }
    // The reconcile above still runs for a silent finish — the work is real
    // whether or not the agent announced it. Only the cue is withheld.
    if (!silent) announceCompletionAloud(name, completionStatus, task.title);
  }

  const chatMsgId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  syncChatThreadTask(updated);
  const completionThreadId = threadIdForTask(updated) ?? undefined;
  const summaryLlmConfig = updated.transcript?.trim()
    ? await resolveConversationLlmConfig(getChatThreadLlmOverrides(completionThreadId))
    : null;
  const willSummarize = Boolean(summaryLlmConfig && isLlmConfigAvailable(summaryLlmConfig));

  const completionData: CompletionSummary = {
    status: completionStatus,
    agentName: name,
    agentType,
    taskTitle: task.title,
    elapsedSec: elapsed,
    reason: completionReason ?? null,
    summary: null,
    summaryPending: willSummarize,
    taskId: task.id,
    endedBy: completionEndedBy,
    silent,
  };

  appendChat(task.projectId, {
    id: chatMsgId,
    role: 'assistant',
    text: '',
    ts: Date.now(),
    completion: completionData,
  }, completionThreadId);

  if (willSummarize && updated.transcript && summaryLlmConfig) {
    const projectId = task.projectId;
    void generateTranscriptSummary(updated.transcript, completionStatus, summaryLlmConfig)
      .then((raw) => raw.trim() || null)
      .catch(() => null)
      .then((summary) => {
        patchChat(projectId, chatMsgId, {
          completion: { ...completionData, summary, summaryPending: false },
        });
      });
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function createOrchestratorTask(
  projectId: string,
  goal: string,
  agentPreset?: string | null,
  name?: string | null,
  role?: AgentRole | null,
  skipWorktree?: boolean,
  panelTaskId?: string | null
): OrchestratorTask {
  const task = createTaskRecord(
    projectId,
    goal,
    agentPreset,
    name,
    role
  );
  const titledTask: OrchestratorTask = {
    ...task,
    title: summarizeTerminalTask(task.goal) || task.title || 'Untitled task',
    skipWorktree: skipWorktree ?? false,
    panelTaskId: panelTaskId ?? null,
  };
  orchestratorTasks.update((all) => [...all, titledTask]);
  void flush(projectId);
  return titledTask;
}

export function deleteOrchestratorTask(id: string) {
  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (task) {
    cancelPendingLaunch(task.id);
    releaseTaskLease(task);
    // The orchestrator no longer owns this terminal: a later exit should get its
    // normal toast again.
    if (task.assignedSessionId != null) unmarkOrchestratorTrackedSession(task.assignedSessionId);
    // Tear down the agent's isolated worktree (best-effort). The branch is kept
    // so any committed work remains recoverable.
    if (task.worktree) void removeTaskWorktree(task.projectId, task.worktree, false);
  }
  let projectId = '';
  orchestratorTasks.update((all) => {
    const found = all.find((t) => t.id === id);
    if (found) projectId = found.projectId;
    return all.filter((t) => t.id !== id);
  });
  if (projectId) void flush(projectId);
}

/** Give a running agent a name (or rename it). Persisted, shown on its pill, and
 * reflected on its terminal pane. */
export function renameOrchestratorAgent(id: string, name: string): void {
  const trimmed = name.trim();
  const updated = patchTask(id, (t) => ({ ...t, name: trimmed ? trimmed : null }));
  if (!updated || updated.assignedSessionId == null) return;
  const live = getTerminalProjectState(updated.projectId).sessions.find((s) => s.id === updated.assignedSessionId);
  if (live?.ownerTaskId === updated.id || updated.adopted) applyOrchestratorAgentName(updated.assignedSessionId, updated.name);
}

/** Release the terminal lease without killing the terminal; task returns to todo. */
export function unlinkOrchestratorTask(id: string) {
  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (task) {
    // Snapshot the terminal output while the session is still alive.
    captureTaskTranscript(id, task.assignedSessionId);
    cancelPendingLaunch(task.id);
    releaseTaskLease(task);
    // The user took this terminal back from the orchestrator; its exit toast
    // belongs to a plain terminal now.
    if (task.assignedSessionId != null) unmarkOrchestratorTrackedSession(task.assignedSessionId);
  }
  patchTask(id, (t) => {
    const reset = t.status === 'in-progress' ? transitionTask(t, 'todo') : { ...t, status: 'todo' as const };
    return { ...reset, assignedSessionId: null, startedAt: null, completedAt: null };
  });
  logTaskActivity(id, 'released', 'Released terminal.');
}

// ─── Launch ───────────────────────────────────────────────────────────────────

/**
 * The message delivered LIVE to a leased agent's REPL. Agents that read a rules
 * file (Claude Code, Codex, Cursor, OpenCode, Antigravity) already loaded the
 * standing brief from CLAUDE.md / AGENTS.md when the CLI booted — see
 * agent-rules-file.ts — so they receive only the task. Every other agent gets the
 * brief wrapped around the goal (the legacy paste channel). This is the single
 * decision point so dispatch, resend, and resume stay consistent.
 */
function buildAgentTaskPanelContext(projectId: string): string {
  const lines = getProjectTaskPanelLines(projectId);
  if (!lines.length) return '';
  return [
    'PROJECT TASK PANEL CONTEXT',
    'Use this as situational context. Do not edit task records unless the user explicitly asks.',
    'Entries are ordered by urgency (priority, then due date; OVERDUE is past due).',
    ...lines.map((line) => `- ${line}`),
  ].join('\n');
}

function withAgentTaskPanelContext(goal: string, projectId: string): string {
  const panelContext = buildAgentTaskPanelContext(projectId);
  if (!panelContext) return goal;
  return `${goal.trim()}\n\n${panelContext}`;
}

function buildLeasedAgentMessage(
  goal: string,
  agentCommand: string | null | undefined,
  name?: string | null,
  projectId?: string,
  role?: AgentRole | null
): string {
  const contextualGoal = projectId ? withAgentTaskPanelContext(goal, projectId) : goal;
  return agentReadsRulesFile(agentCommand)
    ? buildAgentTaskMessage(contextualGoal, { name: name ?? null, role: role ?? null })
    : buildAgentCharter(contextualGoal, { name: name ?? null, role: role ?? null });
}

function sendGoalToLeasedTask(
  id: string,
  sessionId: number,
  goal: string,
  agentCommand: string,
  watchTurn: boolean,
  chatThreadId?: string,
): void {
  void (async () => {
    try {
      // Brief delivery is the guardrail that replaced git-worktree isolation.
      // Rules-file agents already have it from CLAUDE.md / AGENTS.md, so they get
      // only the task; the rest get the charter-wrapped goal. The stored goal and
      // the activity log keep the clean task text either way.
      const task = get(orchestratorTasks).find((t) => t.id === id);
      const message = buildLeasedAgentMessage(goal, agentCommand, task?.name ?? null, task?.projectId, task?.role ?? null);
      const responseStart = getSessionOutputLength(sessionId);
      if (chatThreadId) watchChatAgentResponse(id, sessionId, chatThreadId, agentCommand, responseStart);
      const sent = await sendOrchestratorGoalWhenReady(sessionId, message, {
        shouldContinue: () => leasedSessionLive(id, sessionId),
      });
      if (!sent) {
        if (chatThreadId) patchTask(id, (current) => ({ ...current, status: 'failed', failureReason: 'Could not deliver the goal.' }));
        return;
      }
      // Chat owns one watcher, armed before delivery so an immediate report cannot be lost.
      patchTask(id, (current) =>
        current.status === 'in-progress' ? { ...current, promptSentAt: Date.now() } : current
      );
      logTaskActivity(id, 'goal', goal);
      showToast('Sent goal to ' + (getAgentDisplayName(agentCommand) ?? agentCommand), 'info', 3000);
      if (chatThreadId || !watchTurn) return;
      const outcome = await getAgentAdapter(sessionId).watchTurn({
        shouldContinue: () => leasedSessionLive(id, sessionId),
        agentCommand,
      });
      if (outcome.kind !== 'aborted') completeLeasedTask(id, sessionId, outcome);
    } catch (err) {
      console.error('Failed to auto-send orchestrator goal:', err);
      showToast('Failed to send goal to agent', 'error');
    }
  })();
}

/**
 * Deliver the standing brief alone to a leased agent that was spawned WITHOUT a
 * task yet (a persistent/named agent the user will drive later). Without this,
 * such agents never receive the charter — they have no goal to wrap it around.
 */
function sendBriefToLeasedTask(id: string, sessionId: number, agentCommand: string, name?: string | null): void {
  // Rules-file agents are already briefed by their CLAUDE.md / AGENTS.md the
  // moment the CLI boots, so there is nothing to paste — sending the charter here
  // would just re-deliver the brief they already hold (and into the fragile REPL).
  if (agentReadsRulesFile(agentCommand)) return;
  void (async () => {
    try {
      const success = await sendOrchestratorGoalWhenReady(sessionId, buildAgentCharter('', { name: name ?? null }), {
        shouldContinue: () => leasedSessionLive(id, sessionId),
      });
      if (!success) {
        showToast('Could not brief the spawned agent, because the session was lost', 'warning', 4000);
      }
    } catch (err) {
      console.error('Failed to send agent brief:', err);
      showToast('Failed to brief the spawned agent', 'error', 4000);
    }
  })();
}

export async function launchOrchestratorTask(
  id: string,
  agentCommand: string,
  cwd: string,
  autoRunOrOpts: boolean | {
    autoRun?: boolean;
    watchTurn?: boolean;
    activate?: boolean;
    holdGoal?: boolean;
    model?: string | null;
    accessMode?: ChatAccessMode;
    reasoningEffort?: ChatReasoningEffort;
  } = true
): Promise<number | null> {
  // 4th arg stays boolean-compatible (= autoRun). Persistent agents pass
  // `{ watchTurn: false }` so they don't auto-complete after one turn — they
  // remain in-progress/leased and addressable until released or the process exits.
  // `activate: false` launches in the background (keeps the primary stationary).
  // `holdGoal: true` spawns the terminal but defers goal sending to the caller —
  // used by sendChatMessage to overlap terminal startup with reconnaissance.
  const opts = typeof autoRunOrOpts === 'boolean' ? { autoRun: autoRunOrOpts } : autoRunOrOpts;
  const autoRun = opts.autoRun ?? true;
  const watchTurn = opts.watchTurn ?? true;
  const activate = opts.activate ?? true;
  const holdGoal = opts.holdGoal ?? false;
  const model = opts.model?.trim() || null;

  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (!task) return null;

  const launchGeneration = nextLaunchGeneration(task.id);
  let launchCommitted = false;
  try {
    // Give each agent its own isolated git worktree (own branch off HEAD) so
    // concurrent agents never collide in the shared working tree. Reuse an
    // existing worktree on relaunch; a failed isolated launch must not change
    // the requested placement or discard an existing checkout.
    // When `skipWorktree` is true (admin/release tasks), the agent runs directly
    // in the project root so git tag/push operations work on the main branch.
    let effectiveCwd = cwd;
    let worktree = task.worktree ?? null;
    if (!worktree && !task.skipWorktree) {
      worktree = await createTaskWorktree({
        projectId: task.projectId,
        taskId: task.id,
        label: task.name ?? task.title,
      });
      if (worktree) {
        patchTask(task.id, (current) => ({ ...current, worktree }));
        logTaskActivity(task.id, 'info', `Isolated in worktree ${worktree.branch}`);
      }
    }
    if (worktree) effectiveCwd = worktree.path;

    const sessionId = await leaseOrchestratorTerminal({
      agentCommand,
      cwd: effectiveCwd,
      taskId: task.id,
      taskTitle: task.title,
      name: task.name,
      activate,
      model,
      accessMode: opts.accessMode,
      reasoningEffort: opts.reasoningEffort,
    });
    if (sessionId == null) {
      showToast(worktree ? 'Could not start the agent in its isolated worktree. The worktree was kept; retry the launch.' : 'Could not start the agent terminal', 'error');
      return null;
    }
    // Exits of this session surface as a completion card (completeLeasedTask /
    // the exit handler), so the terminal layer won't double-notify with a toast.
    markOrchestratorTrackedSession(sessionId);

    const currentTask = get(orchestratorTasks).find((entry) => entry.id === task.id);
    const launchState = launchStateByTaskId.get(task.id);
    if (!currentTask || !launchState || launchState.generation !== launchGeneration || launchState.cancelled) {
      releaseOrchestratorTerminal(sessionId);
      return null;
    }

    patchTask(task.id, (current) =>
      transitionTask({ ...current, agentPreset: agentCommand, assignedSessionId: sessionId, promptSentAt: null }, 'in-progress')
    );
    launchCommitted = true;
    logTaskActivity(task.id, 'dispatch', `Launched ${getAgentDisplayName(agentCommand) ?? agentCommand}.`);

    if (!holdGoal) {
      if (autoRun && task.goal) {
        sendGoalToLeasedTask(task.id, sessionId, task.goal, agentCommand, watchTurn);
      } else {
        // Manually launched (no auto-run) or spawned without a goal yet — still
        // deliver the standing brief so EVERY freshly-opened agent CLI is briefed,
        // then hand the goal (if any) to the prompt bar for the user to send.
        sendBriefToLeasedTask(task.id, sessionId, agentCommand, task.name);
        if (task.goal) {
          promptBarInput.set(task.goal);
          focusPromptBar();
        }
      }
    }
    return sessionId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logTaskActivity(task.id, 'failed', message);
    showToast(message, 'error');
    return null;
  } finally {
    void launchCommitted;
    clearLaunchGeneration(task.id, launchGeneration);
  }
}

/** Re-deliver an in-progress task's goal to its agent (e.g. if the first send missed). */
export function resendOrchestratorGoal(id: string): void {
  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (!task || task.assignedSessionId == null || !task.goal || task.status !== 'in-progress') return;
  const live = getTerminalProjectState(task.projectId).sessions.find((s) => s.id === task.assignedSessionId);
  if (!live?.isRunning || live.ownerTaskId !== task.id) return;
  // A missed first send means the agent never received the goal — resend exactly
  // as the initial dispatch would (charter-wrapped for paste agents, task-only for
  // rules-file agents, whose brief is already in CLAUDE.md / AGENTS.md).
  resendLeasedOrchestratorGoal(
    task.assignedSessionId,
    buildLeasedAgentMessage(task.goal, task.agentPreset, task.name ?? null, task.projectId, task.role ?? null)
  );
  patchTask(id, (current) => (current.status === 'in-progress' ? { ...current, promptSentAt: Date.now() } : current));
  logTaskActivity(id, 'follow-up', `Re-sent goal: ${task.goal}`);
  showToast('Re-sent goal to agent', 'info', 2500);
}

export async function resumeBlockedOrchestratorTask(id: string, prompt: string, rootPath: string): Promise<boolean> {
  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (!task || task.status !== 'blocked' || !task.agentPreset) return false;
  const message = prompt.trim() || 'Please continue.';
  const resumed = await sendFollowUpToAgent(task, message, rootPath);
  if (!resumed) {
    showToast('Failed to resume blocked task', 'error');
    return false;
  }
  showToast('Resumed blocked task', 'info', 2500);
  return true;
}

/** Cancel a task outright, releasing its lease. */
export function cancelOrchestratorTask(id: string, note?: string): void {
  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (task) {
    cancelPendingLaunch(task.id);
    releaseTaskLease(task);
  }
  patchTask(id, (t) => cancelTask(t, note));
  logTaskActivity(id, 'cancelled', note?.trim() ? `Cancelled: ${note.trim()}` : 'Cancelled.');
}

/**
 * Close a running agent: snapshot its output, kill its terminal pane, and mark
 * the task cancelled. This is the conversational opposite of "open" — unlike
 * unlink/cancel (which leave the terminal alive), it actually shuts the agent
 * down. Wired to the chat `close` action; safe to call on any task.
 */
export async function closeOrchestratorAgent(id: string, note?: string): Promise<void> {
  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (!task) return;
  cancelPendingLaunch(task.id);
  // Snapshot the terminal output while the session is still alive.
  captureTaskTranscript(id, task.assignedSessionId);
  const sessionId =
    task.assignedSessionId ??
    getTerminalProjectState(task.projectId).sessions.find((s) => s.ownerTaskId === task.id)?.id ??
    null;
  // killSession removes the session from project state synchronously, so the
  // onSessionExit reconciler (guarded on the session still being present) sees no
  // session for this task and won't race us to a "finished" completion.
  if (sessionId != null) await killSession(sessionId);
  patchTask(id, (t) => ({ ...cancelTask(t, note), assignedSessionId: null }));
  logTaskActivity(id, 'cancelled', note?.trim() ? `Closed: ${note.trim()}` : 'Closed.');
}

// ─── App-control actions ──────────────────────────────────────────────────────
// The orchestrator is a full in-app assistant: besides driving the agent fleet
// it can navigate the app, open editor files, point the preview, run commands,
// and manage the task board. These execute the brain's APP actions by calling
// the relevant stores directly.

export function resolveProjectFilePath(path: string, rootPath: string): string {
  const norm = path.replace(/\\/g, '/').trim();
  // Already absolute (Windows drive or POSIX root)?
  if (/^[a-zA-Z]:\//.test(norm) || norm.startsWith('/')) return norm;
  const root = rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  return root ? `${root}/${norm.replace(/^\.?\//, '')}` : norm;
}

/** Find a plain shell terminal to run a command in, creating one if needed. */
async function ensureRunTerminal(projectId: string, rootPath: string, isDev = false): Promise<number | null> {
  const sessions = getTerminalProjectState(projectId, isDev).sessions;
  // Never reuse a pane that is an agent, busy, or running a detected long-lived
  // process (dev server / build) — running a command there would clobber it.
  const reusable = sessions.filter(
    (s) => s.isRunning && !s.agentPreset && !s.ownerTaskId && !sessionHasRunningProcess(s)
  );
  const shell = reusable.find((s) => !s.isExecuting) ?? reusable[0];
  if (shell) return shell.id;
  return await createTerminalSession(rootPath || undefined, undefined, projectId, { isDev });
}

function executeTaskAction(action: Extract<OrchestratorAction, { kind: 'task' }>, projectId: string): boolean {
  const title = action.title.trim();
  if (!title) return false;
  if (action.op === 'create') {
    addTask(projectId, title, 'todo');
    showToast(`Added task: ${title}`, 'success', 2500);
    return true;
  }
  const projectTasks = get(tasks).filter((t) => t.projectId === projectId);
  const wanted = title.toLowerCase();
  const found =
    projectTasks.find((t) => t.title.toLowerCase() === wanted) ??
    projectTasks.find((t) => t.title.toLowerCase().includes(wanted)) ??
    projectTasks.find((t) => wanted.includes(t.title.toLowerCase()));
  if (!found) {
    showToast(`No task matching "${title}"`, 'warning', 3500);
    return false;
  }
  if (action.op === 'delete') {
    deleteTask(found.id);
    showToast(`Deleted task: ${found.title}`, 'info', 2500);
    return true;
  }
  updateTaskStatus(found.id, action.op as TaskStatus);
  return true;
}

/**
 * Execute one app-control action by driving the relevant store. Returns true on
 * success. Agent actions (spawn/send/name/close) are handled elsewhere; this
 * only covers the APP family.
 */
export async function executeAppAction(
  action: OrchestratorAction,
  projectId: string,
  rootPath: string
): Promise<boolean> {
  switch (action.kind) {
    case 'navigate': {
      const v = action.view.trim().toLowerCase();
      if (v === 'terminal') {
        const isDev = get(layoutSnapshot).ambient === 'development';
        if (isDev) {
          requestRoomControl('focus', 'dev-terminal');
        } else {
          showTerminal();
        }
        return true;
      }
      if (v === 'settings') { openSettings(); return true; }
      if (!NAVIGABLE_VIEWS.includes(v as (typeof NAVIGABLE_VIEWS)[number])) {
        showToast(`I don't know a "${action.view}" view`, 'warning', 3500);
        return false;
      }
      setActiveView(sanitiseActiveView(v) as ActiveView);
      return true;
    }
    case 'open-file': {
      const full = resolveProjectFilePath(action.path, rootPath);
      try {
        await openFile(full);
        setActiveView('editor');
        if (action.line && action.line > 0) jumpToLine.set({ path: full, line: action.line });
        return true;
      } catch {
        showToast(`Couldn't open ${action.path}`, 'error', 4000);
        return false;
      }
    }
    case 'close-file': {
      closeFile(resolveProjectFilePath(action.path, rootPath));
      return true;
    }
    case 'preview': {
      const url = action.url.trim();
      if (!url) return false;
      await ensureProxyRunning();
      navigatePreviewTab(url);
      setActiveView('preview');
      requestRoomControl('focus', 'preview');
      return true;
    }
    case 'run': {
      const command = action.command.trim();
      if (!command) return false;
      const isDev = get(layoutSnapshot).ambient === 'development';
      const sid = await ensureRunTerminal(projectId, rootPath, isDev);
      if (sid == null) {
        showToast('No terminal available to run that', 'error', 4000);
        return false;
      }
      if (!isDev) {
        showTerminal();
      }
      requestRoomControl('focus', isDev ? 'dev-terminal' : 'terminal');
      sendPromptToSession(sid, command);
      return true;
    }
    case 'task':
      return executeTaskAction(action, projectId);
    case 'setting': {
      const result = await applyAgentSetting(action.setting, action.value);
      showToast(result.message, result.ok ? 'success' : 'warning', result.ok ? 2500 : 4000);
      return result.ok;
    }
    case 'layout': {
      // Switch the workspace's ambient arrangement (Focus / Split / Gallery / Preview).
      requestAmbientLayout(action.mode);
      return true;
    }
    case 'room': {
      // Focus / minimize / restore / close a specific room by name. AppShell
      // resolves the name against its live rooms (panels + agents).
      const target = action.target.trim();
      if (!target) return false;
      requestRoomControl(action.op, target);
      return true;
    }
    default:
      return false;
  }
}
// The orchestrator is something you talk to: you send a natural-language
// message, the "brain" decides which agent should handle it and crafts the
// prompt, and the work is dispatched into a terminal automatically.

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
  /** The CLI/provider used for this turn, e.g. "Codex CLI" or "Claude Code". */
  agentType?: string | null;
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
  type?: ChatMessageType;
  /** Agents this turn touched. Newer field; legacy single fields kept for old chats. */
  dispatched?: DispatchRef[];
  dispatchedTaskId?: string | null;
  dispatchedAgent?: string | null;
  /** Reconnaissance findings shown before dispatch. */
  reconSummary?: string | null;
  /** Structured agent completion summary card. */
  completion?: CompletionSummary | null;
  inlineRequest?: ChatInlineRequest | null;
  attachments?: ChatAttachment[];
}

const CHAT_STORAGE_KEY = 'spacron_orchestrator_chat';
// Soft cap: reaching this schedules background compaction, which summarizes the
// oldest chunk (see compactProjectChat) rather than dropping it.
const MAX_CHAT_PER_PROJECT = 100;
const CHAT_SUMMARY_CHUNK = 15;
// Hard safety cap: only ever trims raw messages if compaction can't keep up
// (e.g. no conversation API key configured). Sits above the soft cap + one
// compaction chunk so, in the normal case, compaction shrinks the list before
// anything is dropped un-summarized.
const CHAT_HARD_CAP = MAX_CHAT_PER_PROJECT + CHAT_SUMMARY_CHUNK + 20;

function loadChat(): Record<string, ChatMessage[]> {
  return loadJson<Record<string, ChatMessage[]>>(CHAT_STORAGE_KEY, {});
}

export const chatMessages = writable<Record<string, ChatMessage[]>>(loadChat());

// ── Agent Command Center UI state ────────────────────────────────────────────
export const agentCenterOpen = writable(false);
export const agentForcedAgent = writable('auto');
export const agentVoiceModeActive = writable(false);

// Keep the Zustand mirror in sync so React components that read from it always
// see the current value. Without this, the Zustand store can lag behind the
// legacy writable, causing stale reads in React hooks.
agentVoiceModeActive.subscribe((val) => {
  useOrchestratorStore.getState().__set('agentVoiceModeActive', val);
});

chatMessages.subscribe((val) => {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(val)); } catch { /* quota */ }
});

export function getProjectChat(projectId: string) {
  return derived(chatMessages, ($all) => $all[projectId] ?? []);
}

/**
 * Log one side of a realtime voice exchange into the project chat WITHOUT
 * running the orchestrator brain. The GPT Realtime engine converses on its own
 * (speech-to-speech); this keeps the on-screen transcript and chat history in
 * sync with what was actually said. Returns the message id.
 */
export function appendVoiceExchangeMessage(projectId: string, role: 'user' | 'assistant', text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || !projectId) return null;
  const id = msgId();
  appendChat(projectId, { id, role, text: trimmed, ts: Date.now() });
  return id;
}

function appendChat(projectId: string, msg: ChatMessage, threadId?: string) {
  // Chat mode is the orchestrator conversation, not a projection of agent
  // threads. Explicit thread mirroring remains available for legacy callers,
  // but normal orchestrator messages stay in the project conversation only.
  if (threadId) appendLegacyChatMessage(projectId, msg, threadId);
  chatMessages.update((all) => {
    // Trim only at the hard safety cap. Normal shrinking is done by
    // compactProjectChat, which summarizes the oldest chunk instead of dropping
    // it — scheduled as soon as the soft cap is reached, so it runs (and frees
    // room) before the hard cap could ever drop a message un-summarized.
    const list = [...(all[projectId] ?? []), msg].slice(-CHAT_HARD_CAP);
    if (list.length >= MAX_CHAT_PER_PROJECT) {
      scheduleChatCompact(projectId);
    }
    return { ...all, [projectId]: list };
  });
}

const _compactQueued = new Set<string>();

function scheduleChatCompact(projectId: string) {
  if (_compactQueued.has(projectId)) return;
  _compactQueued.add(projectId);
  setTimeout(() => {
    _compactQueued.delete(projectId);
    compactProjectChat(projectId).catch(() => {});
  }, 3000);
}

async function compactProjectChat(projectId: string) {
  const config = await resolveConversationLlmConfig();
  const configured = isLocalProvider(config.provider) ? !!config.baseUrl : !!config.hasApiKey;
  if (!configured) return;

  const msgs = get(chatMessages)[projectId];
  if (!msgs || msgs.length < MAX_CHAT_PER_PROJECT) return;

  // Find the oldest consecutive user+assistant pairs to compact
  const toCompact: ChatMessage[] = [];
  for (const m of msgs) {
    if (toCompact.length >= CHAT_SUMMARY_CHUNK) break;
    if (m.role === 'assistant' && !m.text && m.pending) continue;
    toCompact.push(m);
  }
  if (toCompact.length < 2) return;

  const compactText = toCompact
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 600)}`)
    .join('\n---\n');

  try {
    const summary = await invoke<string>('ai_complete', {
      systemPrompt:
        'Condense the following conversation exchange into 1-2 concise sentences. ' +
        'Capture what the user asked for and what was accomplished. Be factual and omit pleasantries.',
      userText: compactText,
      provider: config.provider,
      model: config.model,
      apiKey: '',
      baseUrl: config.baseUrl || undefined,
    });

    chatMessages.update((all) => {
      const list = all[projectId] ?? [];
      // Verify oldest messages haven't changed since we started
      const ids = new Set(toCompact.map((m) => m.id));
      if (!list.slice(0, toCompact.length).every((m) => ids.has(m.id))) return all;

      const summaryMsg: ChatMessage = {
        id: `summ-${Date.now()}`,
        role: 'assistant',
        text: `📋 Earlier conversation: ${summary.trim()}`,
        ts: toCompact[0].ts,
      };
      return { ...all, [projectId]: [summaryMsg, ...list.slice(toCompact.length)] };
    });
  } catch {
    // Summarization failed — the truncated list is fine
  }
}

function patchChat(projectId: string, id: string, patch: Partial<ChatMessage>) {
  const threadId = findThreadIdForMessage(projectId, id);
  if (threadId) patchThreadMessage(threadId, id, patch as Record<string, unknown>);
  chatMessages.update((all) => {
    const list = (all[projectId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m));
    return { ...all, [projectId]: list };
  });
}

export function clearProjectChat(projectId: string) {
  clearProjectThreadMessages(projectId);
  chatMessages.update((all) => ({ ...all, [projectId]: [] }));
}

function buildAttachmentPrompt(text: string, attachments: ChatAttachment[]): string {
  if (!attachments.length) return text;
  const context = attachments.map((attachment) => {
    const header = `\n--- Attached file: ${attachment.name} (${attachment.type || 'file'}) ---`;
    if (attachment.text) return `${header}\n${attachment.text}\n--- End attached file ---`;
    if (attachment.path) return `${header}\nThe binary attachment was saved at ${attachment.path}. Inspect it when relevant.\n--- End attached file ---`;
    return `${header}\nThe file is attached in the Chat message metadata; inspect it from the project if needed.\n--- End attached file ---`;
  }).join('\n');
  return `${text}\n\nThe user attached these files. Use their contents as context when relevant:${context}`;
}

// A T3 thread receives structured provider deltas. Spacron's chat-capable
// agents still speak through their existing PTYs, so this adapter keeps the
// same user-visible contract by turning the new PTY output since the prompt
// into one streamed assistant message. The terminal remains mounted and is
// still the source of truth; Chat is a projection of that live session.
const chatTurnWatchers = new Map<number, Promise<void>>();

function chatResponseText(sessionId: number, outputStart: number): string {
  return captureTranscript(getSessionOutputSince(sessionId, outputStart), MAX_TRANSCRIPT_CHARS);
}

async function waitForChatTurn(sessionId: number): Promise<void> {
  const pending = chatTurnWatchers.get(sessionId);
  if (pending) await pending;
}

function watchChatAgentResponse(
  taskId: string,
  sessionId: number,
  threadId: string,
  agentCommand: string,
  outputStart: number,
): void {
  const responseId = msgId();
  const task = get(orchestratorTasks).find((entry) => entry.id === taskId);
  const projectId = getChatThread(threadId)?.projectId ?? task?.projectId;
  if (!projectId) return;
  appendChat(
    projectId,
    { id: responseId, role: 'assistant', text: '', ts: Date.now(), pending: true },
    threadId,
  );

  const watch = (async () => {
    const publish = (pending: boolean) => {
      const text = chatResponseText(sessionId, outputStart);
      if (text) patchChat(projectId, responseId, { text, pending });
    };
    const timer = setInterval(() => publish(true), 500);
    try {
      let outcome: AgentTurnOutcome;
      do {
        outcome = await getAgentAdapter(sessionId).watchTurn({
        shouldContinue: () => leasedSessionLive(taskId, sessionId),
        agentCommand,
        });
        // Silence is not completion. Keep listening for the next output or declared end.
      } while (outcome.kind === 'finished' && outcome.via === 'inferred' && leasedSessionLive(taskId, sessionId));
      if (outcome.kind === 'aborted') {
        const current = get(orchestratorTasks).find((entry) => entry.id === taskId);
        if (current?.status === 'in-progress') {
          patchChat(projectId, responseId, {
            text: 'The agent session ended before it returned a chat response. Check its terminal.',
            pending: false,
          });
        }
        patchChat(projectId, responseId, { pending: false });
        if (current) syncChatThreadTask(current, threadId);
        if (current?.status === 'in-progress') updateChatThread(threadId, { status: 'failed' });
        return;
      }
      if (outcome.kind === 'blocked') {
        const finalText = chatResponseText(sessionId, outputStart);
        const inlineRequest = agentInputRequest(`chat-request-${responseId}`, outcome.reason, taskId, sessionId, outcome.via === 'inferred');
        patchTask(taskId, (current) => ({ ...current, status: 'blocked', blockedReason: inlineRequest.prompt }));
        logTaskActivity(taskId, 'blocked', inlineRequest.prompt);
        patchChat(projectId, responseId, {
          type: 'input',
          text: finalText,
          pending: false,
          inlineRequest,
        });
        updateChatThread(threadId, { status: 'needs-input', updatedAt: Date.now(), lastActivityAt: Date.now() });
        return;
      }
      if (outcome.kind === 'failed') {
        patchChat(projectId, responseId, { type: 'failure', text: chatResponseText(sessionId, outputStart) || outcome.reason, pending: false });
        await completeLeasedTask(taskId, sessionId, outcome);
        return;
      }
      publish(false);
      const finalText = chatResponseText(sessionId, outputStart);
      if (!finalText) {
        patchChat(projectId, responseId, {
          text: 'The agent returned no readable chat text. Check its terminal.',
          pending: false,
        });
      }
      await completeLeasedTask(taskId, sessionId, outcome);
    } catch (error) {
      patchChat(projectId, responseId, { type: 'failure', text: `Could not monitor the agent: ${String(error)}`, pending: false });
      updateChatThread(threadId, { status: 'failed' });
    } finally {
      clearInterval(timer);
    }
  })();

  chatTurnWatchers.set(sessionId, watch);
  void watch.finally(() => {
    if (chatTurnWatchers.get(sessionId) === watch) chatTurnWatchers.delete(sessionId);
  });
}

async function sendThreadFollowUp(
  projectId: string,
  rootPath: string,
  threadId: string,
  task: OrchestratorTask,
  text: string,
  chatMode = false,
  attachments: ChatAttachment[] = [],
  inputMessageId?: string,
): Promise<void> {
  const userId = msgId();
  const assistantId = msgId();
  appendChat(projectId, { id: userId, role: 'user', text, ts: Date.now(), attachments }, threadId);
  appendChat(projectId, { id: assistantId, role: 'assistant', text: '', ts: Date.now(), pending: true }, threadId);

  try {
    const originalSessionId = task.assignedSessionId;
    if (chatMode && originalSessionId != null) await waitForChatTurn(originalSessionId);
    const request = inputMessageId ? getThreadMessageSnapshot(threadId).find((message) => message.id === inputMessageId)?.inlineRequest : null;
    const deliveryText = request?.options?.find((option) => option.label === text)?.value ?? text;
    const sent = await sendFollowUpToAgent(task, buildAttachmentPrompt(deliveryText, attachments), rootPath, chatMode, Boolean(inputMessageId), (sessionId) => {
      if (chatMode && task.agentPreset) watchChatAgentResponse(task.id, sessionId, threadId, task.agentPreset, getSessionOutputLength(sessionId));
    }, request?.inputMode === 'line');
    const latestTask = get(orchestratorTasks).find((entry) => entry.id === task.id) ?? task;
    syncChatThreadTask(latestTask, threadId);
    if (!sent) {
      patchChat(projectId, assistantId, {
        text: `I couldn't reach ${task.name?.trim() || getAgentDisplayName(task.agentPreset) || 'the running agent'}.`,
        pending: false,
      });
      if (inputMessageId) updateChatThread(threadId, { status: 'needs-input' });
      return;
    }
    if (inputMessageId) markInlineRequestAnswered(projectId, inputMessageId, text);

    patchChat(projectId, assistantId, {
      text: `Sent to ${task.name?.trim() || getAgentDisplayName(task.agentPreset) || 'the running agent'}.`,
      pending: false,
      dispatched: [{
        taskId: task.id,
        agent: task.agentPreset ?? 'agent',
        name: task.name ?? null,
        via: 'send',
      }],
      dispatchedTaskId: task.id,
      dispatchedAgent: task.agentPreset ?? null,
    });
    syncChatThreadTask(get(orchestratorTasks).find((entry) => entry.id === task.id) ?? latestTask, threadId);
  } catch (err) {
    console.error('Failed to send thread follow-up:', err);
    patchChat(projectId, assistantId, {
      text: 'I couldn’t deliver that follow-up to the agent.',
      pending: false,
    });
  }
}

/**
 * Soft session reset: stop the task(s) currently running and clear the chat
 * transcript, while KEEPING the brain's learned memory and evolving profile.
 * Cancelling releases each task's terminal lease (it does not kill the user's
 * terminal), so a mid-run agent is simply let go rather than force-closed.
 */
export function resetOrchestratorSession(projectId: string): void {
  const running = get(orchestratorTasks).filter(
    (t) => t.projectId === projectId && t.status === 'in-progress'
  );
  for (const t of running) cancelOrchestratorTask(t.id, 'Session reset');
  clearProjectChat(projectId);
}

/** Agents the orchestrator may dispatch to (the project's launchable presets). */
export function getDispatchableAgents(projectId: string): AgentChoice[] {
  return getPresetRuns(projectId)
    .filter((p) => p.command !== 'npm run dev')
    .map((p) => ({ command: p.command, name: p.name }));
}

const BRAIN_OUTPUT_TAIL = 2500;
const TASK_OUTPUT_TAIL = 4000;
const STALLED_TASK_MS = 10 * 60 * 1000;

function lastTaskSignalAt(task: OrchestratorTask): number {
  const activity = task.activity ?? [];
  const lastActivity = activity.length ? activity[activity.length - 1].ts : 0;
  return Math.max(lastActivity, task.promptSentAt ?? 0, task.startedAt ?? 0, task.completedAt ?? 0, task.createdAt ?? 0);
}

function relativeAge(ts: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - ts);
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function taskFreshness(task: OrchestratorTask, now = Date.now()): string {
  const signalAt = lastTaskSignalAt(task);
  const age = relativeAge(signalAt, now);
  if (task.status === 'in-progress' && now - signalAt > STALLED_TASK_MS) {
    return `possibly stalled; no orchestrator-visible update for ${age}`;
  }
  return `last orchestrator-visible update ${age}`;
}

function trackedSessionIds(projectId: string): Set<number> {
  return new Set(
    get(orchestratorTasks)
      .filter((t) => t.projectId === projectId && t.assignedSessionId != null)
      .map((t) => t.assignedSessionId as number)
  );
}

type LiveTerminalSession = ReturnType<typeof getTerminalProjectState>['sessions'][number];

function adoptLiveAgentSession(projectId: string, session: LiveTerminalSession, preset?: string | null): OrchestratorTask | null {
  const agentPreset = preset ?? session.agentPreset ?? null;
  if (!session.isRunning || !agentPreset) return null;

  const tracked = get(orchestratorTasks).find(
    (t) =>
      t.projectId === projectId &&
      t.assignedSessionId === session.id &&
      (t.status === 'in-progress' || t.status === 'todo')
  );
  if (tracked) return tracked;

  const taken = [
    ...getRunningAgentRefs(projectId).map((r) => r.name).filter((n): n is string => !!n),
    ...getTerminalProjectState(projectId).sessions
      .filter((s) => s.id !== session.id && s.isRunning && s.agentName?.trim())
      .map((s) => (s.agentName as string).trim()),
  ];
  const name = session.agentName?.trim() || pickAssistantName(taken);
  const adopted: OrchestratorTask = {
    ...transitionTask(createTaskRecord(projectId, '', agentPreset, name, toAgentRole(session.role)), 'in-progress'),
    title: session.taskSummary || session.paneTitle || session.title || 'Idle terminal agent',
    assignedSessionId: session.id,
    adopted: true,
  };
  orchestratorTasks.update((all) => [...all, adopted]);
  // This session's exit becomes a completion card; the terminal layer's own
  // exit toast must not double-notify.
  markOrchestratorTrackedSession(session.id);
  if (!session.agentName?.trim()) applyOrchestratorAgentName(session.id, name);
  logTaskActivity(adopted.id, 'dispatch', `Adopted live ${getAgentDisplayName(agentPreset) ?? agentPreset} session.`);
  watchAdoptedAgentTurns(adopted.id, session.id);
  return adopted;
}

/**
 * Minimum buffer growth (chars) between two turn-end notifications for the same
 * adopted session. A cursor-blink redraw or a re-matched prompt produces only a
 * few chars and should not chime again for what the user experiences as one
 * pause.
 */
const ADOPTED_NUDGE_MIN_GROWTH = 200;
/**
 * Floor between two cues for the same session, regardless of growth. The
 * watcher re-arms the instant it resolves, so anything that can re-match inside
 * one poll interval would otherwise chime at 400ms intervals. A real turn end
 * never lands within this window of the previous one.
 */
const ADOPTED_NUDGE_MIN_INTERVAL_MS = 2000;
const lastAdoptedNudge = new Map<number, { len: number; at: number }>();

/**
 * Whether an adopted session's turn end is distinct enough from the last one to
 * be worth a cue. Applies to blocked as well as finished: "blocked" used to be
 * exempt on the grounds that it always matters, but that made it the one path
 * with no dedupe at all — and the chime, unlike the toast, has no duplicate
 * suppression of its own, so the user heard a cue with nothing to show for it.
 */
function shouldNudgeAdopted(sessionId: number, bufLen: number): boolean {
  const last = lastAdoptedNudge.get(sessionId);
  if (!last) return true;
  if (Date.now() - last.at < ADOPTED_NUDGE_MIN_INTERVAL_MS) return false;
  // A shrink means the capped buffer slid, not that output was withdrawn.
  return bufLen < last.len || bufLen - last.len >= ADOPTED_NUDGE_MIN_GROWTH;
}

/**
 * Give agents the user launched by hand the same turn-end cue as orchestrated
 * ones — a chime plus a bottom-corner toast that jumps to the terminal — and a
 * lightweight inbox card so the turn survives the user looking away.
 *
 * Adopted agents never pass through goal dispatch, which is the only place a
 * turn watcher was ever armed, so until now the spawn-detector route produced
 * no cue at all: the sole completion path was process exit, and that path was
 * deliberately silent for adopted sessions.
 *
 * The card is lightweight by design: no AI transcript summary, no mailbox
 * post, and the task stays `in-progress` — the watcher re-arms, because the
 * user is still working in that terminal; ending the task on its first quiet
 * moment would sever the session from agent mode while they were
 * mid-conversation with it. `appendAdoptedTurnCard` drops the durable trace;
 * this function adds the notification on top.
 */
function watchAdoptedAgentTurns(taskId: string, sessionId: number): void {
  void (async () => {
    for (;;) {
      const task = get(orchestratorTasks).find((t) => t.id === taskId);
      if (!task) return;
      const outcome = await getAgentAdapter(sessionId).watchTurn({
        shouldContinue: () => leasedSessionLive(taskId, sessionId),
        agentCommand: task.agentPreset ?? undefined,
      });
      if (outcome.kind === 'aborted') return;

      const bufLen = getSessionOutputLength(sessionId);
      if (shouldNudgeAdopted(sessionId, bufLen)) {
        lastAdoptedNudge.set(sessionId, { len: bufLen, at: Date.now() });
        notifyAdoptedTurnEnd(task, outcome, sessionId);
      }
    }
  })();
}

/** The chime and durable inbox card for one adopted turn end. */
function notifyAdoptedTurnEnd(
  task: OrchestratorTask,
  outcome: AgentTurnOutcome,
  sessionId?: number,
): void {
  const agentType = task.agentPreset
    ? getAgentDisplayName(task.agentPreset) ?? task.agentPreset
    : null;
  const name = task.name?.trim() || agentType || task.agentPreset || 'Agent';

  const told = describeTurnEnd(outcome);
  if (!told) return;

  logTaskActivity(
    task.id,
    told.status === 'blocked' ? 'blocked' : told.status === 'failed' ? 'failed' : 'finished',
    told.reason ?? (told.declared ? 'Finished its turn.' : 'Went quiet, so it is assumed finished.'),
  );

  // A hand-launched agent gets the same rule as a leased one: only a turn end
  // the agent actually declared may interrupt. An inferred one — output stopped
  // growing, so we assumed — is recorded in the inbox and nothing else. This is
  // the loudest version of the false alarm, because an adopted watcher re-arms
  // every turn and would chime on every quiet spell.
  const silent = told.endedBy === 'inferred' && agentCanReport(task.agentPreset, sessionId);

  // The completion card below is the one visual notification for this turn end —
  // a toast would duplicate it. The chime stays as the "right now" audio cue.
  if (!silent && get(announceAgentCompletions)) {
    // In voice mode the realtime model relays it in its own voice; a chime on
    // top of a live call is jarring. Same split as announceCompletionAloud.
    if (get(agentVoiceModeActive)) {
      announceViaRealtimeVoice(spokenTurnEnd(name, told));
    } else {
      playNudge(told.status === 'done' ? 'done' : 'blocked');
    }
  }

  // The durable trace for this turn. A card lands only when a cue lands, so it
  // can never outnumber the chimes (shouldNudgeAdopted already deduped this one).
  appendAdoptedTurnCard(task, name, told.status, told.reason, told.endedBy, silent);
}

/**
 * What the voice relay says for a turn end.
 *
 * Kept separate from the card copy because it is spoken: "went quiet" reads
 * fine in a corner card and sounds evasive out loud, so an inferred finish is
 * spoken as "seems to have finished" instead.
 */
function spokenTurnEnd(name: string, told: TurnEndPresentation): string {
  if (told.status === 'blocked') return `${name} needs your input.`;
  if (told.status === 'failed') return `${name} could not finish.`;
  if (told.endedBy === 'exit') return `${name} has exited.`;
  return told.endedBy === 'declared'
    ? `${name} finished its turn.`
    : `${name} seems to have finished.`;
}

/**
 * Append the lightweight inbox card for a hand-launched agent's finished turn.
 *
 * A real completion card minus the AI summary: no `generateTranscriptSummary`
 * (the user drove this directly and a recap would be noise), no mailbox post,
 * and — on the turn-end path — the task stays `in-progress`. `completionEntry`
 * (inbox.ts) picks this up as a normal inbox row: done turns are informational,
 * blocked turns are actionable.
 */
function appendAdoptedTurnCard(
  task: OrchestratorTask,
  name: string,
  status: 'done' | 'failed' | 'blocked',
  reason: string | null,
  /** How the turn end became known. See `CompletionSummary.endedBy`. */
  endedBy: NonNullable<CompletionSummary['endedBy']> = 'declared',
  /** Inbox-only: no floating card, no chime, no OS notification. */
  silent = false,
): void {
  appendChat(task.projectId, {
    id: msgId(),
    role: 'assistant',
    text: '',
    ts: Date.now(),
    completion: {
      status,
      agentName: name,
      agentType: task.agentPreset
        ? getAgentDisplayName(task.agentPreset) ?? task.agentPreset
        : null,
      taskTitle: task.title,
      elapsedSec: null,
      reason,
      summary: null,
      summaryPending: false,
      taskId: task.id,
      endedBy,
      silent,
    },
  });
}

/**
 * File a `report_status` call that no turn watcher took.
 *
 * A report only reaches here when it could not end a turn, which happens two
 * ways and both are ordinary:
 *
 * - **Unattributed.** The report arrived with no session behind it — the agent
 *   never passed `agent_token`, or it was launched by hand and so never had
 *   one. Spacron cannot tell whose turn it was, so it cannot end one.
 * - **Nobody watching.** The session is known, but no watcher is armed. A
 *   leased task's watcher resolves when its turn ends, so every follow-up the
 *   user types straight into the agent's terminal runs unwatched.
 *
 * Either way the agent said something the user asked to be told, and until now
 * the whole trace was an eight-second toast — invisible to anyone who looked
 * away, which is the exact miss the inbox exists to prevent. So it lands as a
 * normal completion card: the inbox row, the corner card and the OS
 * notification all come from that one object, rather than from a second
 * notification surface running alongside the first.
 *
 * `endedBy: 'declared'` because the agent reported this itself. Only a declared
 * end may interrupt — see `notifyAdoptedTurnEnd` for the other half of that rule.
 *
 * Returns the project the card was filed under, or null when there is no
 * project to file it under; the caller falls back to a toast rather than
 * dropping the report.
 */
export function recordUnwatchedAgentReport(
  sessionId: number | null,
  signal: HookSignal,
  /** The agent's display name, resolved by the caller from its session. */
  fallbackName: string,
): string | null {
  // Reuse the watcher's own mapping so a report cannot be worded one way here
  // and another way when a watcher happens to be armed for it.
  const told = describeTurnEnd({ ...signal, via: 'declared' } as AgentTurnOutcome);
  if (!told) return null;

  const task =
    sessionId == null
      ? undefined
      : get(orchestratorTasks).find(
          (t) =>
            t.assignedSessionId === sessionId &&
            (t.status === 'in-progress' || t.status === 'todo'),
        );
  const session =
    sessionId == null ? undefined : get(allProjectSessions).find((s) => s.id === sessionId);
  const projectId = task?.projectId ?? session?.projectId ?? getActiveTerminalProjectId();
  if (!projectId) return null;

  const name =
    task?.name?.trim()
    || session?.agentName?.trim()
    || fallbackName;
  const agentType = task?.agentPreset
    ? getAgentDisplayName(task.agentPreset) ?? task.agentPreset
    : session?.agentPreset
      ? getAgentDisplayName(session.agentPreset) ?? session.agentPreset
      : null;

  if (task) {
    logTaskActivity(
      task.id,
      told.status === 'blocked' ? 'blocked' : told.status === 'failed' ? 'failed' : 'finished',
      told.reason ?? 'Reported its status.',
    );
  }

  appendChat(projectId, {
    id: msgId(),
    role: 'assistant',
    text: '',
    ts: Date.now(),
    completion: {
      status: told.status,
      agentName: name,
      agentType,
      // The card's second line. A report outside a task has no title to show,
      // and a blank line there reads as a rendering bug rather than as absence.
      taskTitle:
        task?.title
        || session?.taskSummary?.trim()
        || session?.paneTitle?.trim()
        || 'Status report',
      elapsedSec: null,
      reason: told.reason,
      summary: null,
      summaryPending: false,
      taskId: task?.id ?? null,
      endedBy: told.endedBy,
      silent: false,
    },
  });

  // The same audio cue every other declared turn end gets. The card above is
  // the only visual one — see the dedupe note on `notifyAdoptedTurnEnd`.
  if (get(announceAgentCompletions)) {
    if (get(agentVoiceModeActive)) {
      announceViaRealtimeVoice(spokenTurnEnd(name, told));
    } else {
      playNudge(told.status === 'done' ? 'done' : 'blocked');
    }
  }

  return projectId;
}

function matchesLiveAgentTarget(session: LiveTerminalSession, wanted: string): boolean {
  if (!wanted) return false;
  const labels = [
    session.agentName,
    session.agentPreset,
    getAgentDisplayName(session.agentPreset),
    session.taskSummary,
    session.paneTitle,
    session.title,
    session.role,
  ]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => !!value);
  return labels.some((label) => label === wanted || label.includes(wanted) || wanted.includes(label));
}

function adoptMatchingLiveAgent(projectId: string, wanted: string): OrchestratorTask | null {
  const sessions = getTerminalProjectState(projectId).sessions
    .filter((s) => s.isRunning && s.agentPreset && !trackedSessionIds(projectId).has(s.id))
    .sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0));
  if (!sessions.length) return null;

  const positional = wanted === 'last' || wanted === 'it' || wanted === 'that agent' || wanted === 'that one';
  const match = positional ? sessions[0] : sessions.find((s) => matchesLiveAgentTarget(s, wanted));
  return match ? adoptLiveAgentSession(projectId, match, match.agentPreset) : null;
}

/** In-progress agents the brain can address by name (most-recent first). */
export function getRunningAgentRefs(projectId: string): RunningAgentRef[] {
  const tracked = trackedSessionIds(projectId);
  const taskRefs = get(orchestratorTasks)
    .filter((t) => t.projectId === projectId && t.status === 'in-progress' && t.assignedSessionId != null)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((t) => {
      const full = getTaskTranscript(t);
      const recentOutput = full ? full.slice(-BRAIN_OUTPUT_TAIL) : null;
      return { name: t.name ?? null, agent: t.agentPreset ?? 'agent', title: t.goal ? t.title : 'idle', recentOutput };
    });

  const liveSessionRefs = getTerminalProjectState(projectId).sessions
    .filter((s) => s.isRunning && s.agentPreset && !tracked.has(s.id))
    .sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0))
    .map((s) => {
      const full = getAgentAdapter(s.id).readOutput();
      return {
        name: s.agentName?.trim() || null,
        agent: s.agentPreset ?? 'agent',
        title: s.taskSummary || s.paneTitle || s.title || 'idle terminal agent',
        recentOutput: full ? full.slice(-BRAIN_OUTPUT_TAIL) : null,
      };
    });

  return [...taskRefs, ...liveSessionRefs];
}

/**
 * How much of one agent's transcript to hand back for reading aloud.
 *
 * Not the whole thing: a long-running agent's buffer runs to tens of thousands
 * of characters, and speech is roughly 15 chars/second, so an uncapped read
 * would be a monologue the user cannot interrupt usefully. This is a few
 * minutes of audio — enough to cover what an agent actually reported at the end
 * of a turn — and the reply tells them when older output was cut, so they can
 * ask for more. It also stays under the 8k cap that `handleFunctionCall` puts
 * on realtime tool results.
 */
const READ_ALOUD_MAX_CHARS = 6000;

/**
 * Find the agent the user named and return its cleaned transcript to be read
 * aloud. Backs `RouteContext.readAgentTranscript`.
 *
 * Searches orchestrator tasks first, then live terminal sessions the
 * orchestrator has not adopted, so an agent is findable however it was started.
 * With no name in the message, falls back to the most recently active agent —
 * "read that back to me" after a completion notification should just work.
 */
function readAgentTranscriptFor(projectId: string, request: string): AgentTranscriptRead | null {
  const wanted = request.toLowerCase();

  const named = <T,>(items: T[], nameOf: (item: T) => string | null | undefined): T | null => {
    // Longest name first: "Iris" must not win over "Iris Two" when both exist.
    const candidates = items
      .map((item) => ({ item, name: nameOf(item)?.trim() ?? '' }))
      .filter((c) => c.name.length > 1)
      .sort((a, b) => b.name.length - a.name.length);
    return candidates.find((c) => wanted.includes(c.name.toLowerCase()))?.item ?? null;
  };

  const tasks = get(orchestratorTasks)
    .filter((t) => t.projectId === projectId && t.status !== 'todo')
    .sort((a, b) => (lastTaskSignalAt(b) ?? 0) - (lastTaskSignalAt(a) ?? 0));
  const liveSessions = getTerminalProjectState(projectId).sessions
    .filter((s) => s.isRunning && s.agentPreset)
    .sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0));

  const finish = (name: string, raw: string): AgentTranscriptRead | null => {
    const clean = captureTranscript(raw, READ_ALOUD_MAX_CHARS);
    if (!clean.trim()) return { name, text: '', truncated: false };
    // captureTranscript marks a dropped head with a leading ellipsis line.
    return { name, text: clean, truncated: clean.startsWith('…\n') };
  };

  const task = named(tasks, (t) => t.name);
  if (task) {
    return finish(
      task.name ?? getAgentDisplayName(task.agentPreset) ?? 'That agent',
      getTaskTranscript(task)
    );
  }

  const session = named(liveSessions, (s) => s.agentName);
  if (session) {
    return finish(
      session.agentName?.trim() || getAgentDisplayName(session.agentPreset) || 'That agent',
      getAgentAdapter(session.id).snapshot()
    );
  }

  // No name matched. Fall back to the most recent agent when the request is
  // clearly about "it"/"that", or when there is only one candidate so there is
  // nothing to get wrong. Otherwise return null: the user named something we
  // could not resolve (a typo, or speech-to-text mangling "Iris"), and the
  // summary path answering is better than confidently reading the wrong agent.
  const unambiguous = tasks.length + liveSessions.length === 1;
  if (unambiguous || /\b(it|that|them|the agent|last|latest|everything)\b/i.test(request)) {
    const recentTask = tasks[0];
    if (recentTask) {
      return finish(
        recentTask.name ?? getAgentDisplayName(recentTask.agentPreset) ?? 'That agent',
        getTaskTranscript(recentTask)
      );
    }
    const recentSession = liveSessions[0];
    if (recentSession) {
      return finish(
        recentSession.agentName?.trim() || getAgentDisplayName(recentSession.agentPreset) || 'That agent',
        getAgentAdapter(recentSession.id).snapshot()
      );
    }
  }
  return null;
}

/** Recent task state plus terminal output for conversational status/output answers. */
export function getAgentOutputRefs(projectId: string): AgentOutputRef[] {
  return get(orchestratorTasks)
    .filter((t) => t.projectId === projectId && t.status !== 'todo')
    .map((t) => {
      const full = getTaskTranscript(t);
      const recentOutput = full ? full.slice(-TASK_OUTPUT_TAIL) : null;
      const updatedAt = t.completedAt ?? t.startedAt ?? t.createdAt;
      const reason = t.blockedReason ?? t.failureReason ?? null;
      return {
        name: t.name ?? null,
        agent: t.agentPreset ?? 'agent',
        title: t.goal ? t.title : 'idle',
        status: t.status as AgentOutputRef['status'],
        updatedAt,
        reason,
        freshness: taskFreshness(t),
        recentOutput,
      };
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 6);
}

/** Blocked agents that the assistant can resume naturally in chat. */
export function getReviewableAgentRefs(projectId: string): RunningAgentRef[] {
  return get(orchestratorTasks)
    .filter((t) => t.projectId === projectId && t.status === 'blocked')
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((t) => ({
      name: t.name ?? null,
      agent: t.agentPreset ?? 'agent',
      title: `${t.title} (waiting on you)`,
    }));
}


/**
 * Resolve an agent the user referred to. Matches in-progress tasks by
 * name (case-insensitive), then by agent command / display name, and also
 * considers paused tasks so they can be resumed conversationally.
 */
function resolveRunningTaskByName(projectId: string, target: string): OrchestratorTask | null {
  const wanted = target.trim().toLowerCase();
  const tasks = get(orchestratorTasks)
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  const running = tasks.filter((t) => t.status === 'in-progress' && t.assignedSessionId != null);
  const resumable = tasks.filter((t) => t.status === 'blocked');
  const candidates = [...running, ...resumable];

  const byName = candidates.find((t) => t.name && t.name.toLowerCase() === wanted);
  if (byName) return byName;

  if (candidates.length > 0 && (wanted === 'last' || wanted === 'it' || wanted === 'that agent' || wanted === 'that one')) {
    return candidates[0];
  }

  const byAgent = candidates.find(
    (t) =>
      (t.agentPreset && t.agentPreset.toLowerCase() === wanted) ||
      (getAgentDisplayName(t.agentPreset)?.toLowerCase() === wanted)
  );
  if (byAgent) return byAgent;

  return adoptMatchingLiveAgent(projectId, wanted);
}

/** Push a prompt to a running agent's live terminal; if blocked, reopen it and send automatically. */
export async function sendFollowUpToAgent(task: OrchestratorTask, prompt: string, rootPath: string, chatMode = false, answeringInput = false, beforeSend?: (sessionId: number) => void, lineInput = false): Promise<boolean> {
  if (task.assignedSessionId != null) {
    const live = getTerminalProjectState(task.projectId).sessions.find((s) => s.id === task.assignedSessionId);
    // Adopted agents have no `ownerTaskId` lease (see leasedSessionLive); a live
    // session is enough to route a follow-up into.
    if (!live?.isRunning || (!task.adopted && live.ownerTaskId !== task.id)) return false;

    if (chatMode) {
      patchTask(task.id, (current) => ({ ...current, status: 'in-progress', blockedReason: null }));
      beforeSend?.(task.assignedSessionId);
    }
    const sent = lineInput
      ? await getAgentAdapter(task.assignedSessionId).sendInputLine(prompt)
      : await sendOrchestratorFollowUpWhenReady(task.assignedSessionId, answeringInput ? prompt : withAgentTaskPanelContext(prompt, task.projectId), {
      shouldContinue: () => {
        const current = get(orchestratorTasks).find((entry) => entry.id === task.id);
        const session = getTerminalProjectState(task.projectId).sessions.find((entry) => entry.id === task.assignedSessionId);
        return Boolean(current && (current.status === 'in-progress' || current.status === 'blocked') && current.assignedSessionId === task.assignedSessionId && session?.isRunning && (task.adopted || session.ownerTaskId === task.id));
      },
    });
    if (!sent) {
      if (chatMode) patchTask(task.id, (current) => ({ ...current, status: task.status, blockedReason: task.blockedReason }));
      return false;
    }
    const updated = patchTask(task.id, (current) => current.status === 'in-progress' ? { ...current, promptSentAt: Date.now() } : current);
    if (updated) syncChatThreadTask(updated);
    logTaskActivity(task.id, 'follow-up', prompt);
    return true;
  }

  if (task.status !== 'blocked' || !task.agentPreset) return false;

  const chatThread = (() => {
    const threadId = threadIdForTask(task);
    return threadId ? getChatThread(threadId) : null;
  })();

  const sessionId = await leaseOrchestratorTerminal({
    agentCommand: task.agentPreset,
    // Reopen the agent in its existing isolated worktree so resumed work stays on
    // the same branch; fall back to the project root if it never had one.
    cwd: task.worktree?.path ?? rootPath,
    taskId: task.id,
    taskTitle: task.title,
    name: task.name,
    model: chatThread?.model,
    accessMode: chatThread?.accessMode,
    reasoningEffort: chatThread?.reasoningEffort,
  });
  if (sessionId == null) return false;
  // The exit handler will write the completion card for this resumed session;
  // keep the terminal layer's own exit toast suppressed.
  markOrchestratorTrackedSession(sessionId);

  const resumedTask = patchTask(task.id, (current) => ({
    ...current,
    status: 'in-progress',
    agentPreset: task.agentPreset,
    assignedSessionId: sessionId,
    startedAt: current.startedAt ?? Date.now(),
    completedAt: null,
    blockedReason: null,
    failureReason: null,
    promptSentAt: null,
  }));
  if (resumedTask) syncChatThreadTask(resumedTask);

  const agentName = getAgentDisplayName(task.agentPreset) ?? task.agentPreset;
  logTaskActivity(task.id, 'dispatch', `Resumed ${agentName}.`);

  // Resuming a blocked task re-leases a FRESH agent CLI (the previous process
  // exited), so it has no memory of its first-turn brief. A rules-file agent
  // re-reads CLAUDE.md / AGENTS.md on this fresh boot (the re-lease re-ensures
  // them), so it just needs the resume prompt; a paste agent needs the charter
  // wrapped around it, exactly like an initial dispatch. The activity log below
  // still records the clean prompt, not the message text.
  beforeSend?.(sessionId);
  const sent = await sendOrchestratorFollowUpWhenReady(
    sessionId,
    buildLeasedAgentMessage(chatMode ? `Original goal: ${task.goal}\n\nPrevious request: ${task.blockedReason ?? ''}\n\nUser reply: ${prompt}` : prompt, task.agentPreset, task.name ?? null, task.projectId),
    { shouldContinue: () => leasedSessionLive(task.id, sessionId) }
  );
  if (!sent) return false;
  const updated = patchTask(task.id, (current) => (current.status === 'in-progress' ? { ...current, promptSentAt: Date.now() } : current));
  if (updated) syncChatThreadTask(updated);
  logTaskActivity(task.id, 'follow-up', prompt);

  if (!chatMode) void (async () => {
    const outcome = await getAgentAdapter(sessionId).watchTurn({
      shouldContinue: () => leasedSessionLive(task.id, sessionId),
      agentCommand: task.agentPreset ?? undefined,
    });
    if (outcome.kind !== 'aborted') completeLeasedTask(task.id, sessionId, outcome);
  })();

  return true;
}

function compactInlineText(raw: string, maxChars: number): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function formatTaskActivity(event: ActivityEvent): string {
  return `${event.kind}: ${compactInlineText(event.text, 90)}`;
}

function buildProjectTaskMemory(projectId: string): string[] {
  const learnedMemory = getProjectMemoryLines(projectId);
  const recentTaskMemory = get(orchestratorTasks)
    .filter((task) => task.projectId === projectId)
    .filter((task) => (task.activity?.length ?? 0) > 0 || task.status !== 'todo')
    .map((task) => {
      const lastEvent = task.activity?.[task.activity.length - 1];
      const recency = lastEvent?.ts ?? task.completedAt ?? task.startedAt ?? task.createdAt;
      return { task, recency };
    })
    .sort((a, b) => (b.recency - a.recency) || a.task.id.localeCompare(b.task.id))
    .slice(0, 5)
    .map(({ task }) => {
      const activities = task.activity ?? [];
      const label = compactInlineText(task.name ?? task.title ?? task.goal, 64);
      const agent = compactInlineText(task.agentPreset ?? 'agent', 48);
      const head = label ? `${label} [${agent}, ${task.status}]` : `[${agent}, ${task.status}]`;
      const activity = activities.slice(-2).map(formatTaskActivity).filter((line) => line.length > 0);
      const freshness = taskFreshness(task);
      if (activity.length) return `${head} (${freshness}) — ${activity.join('; ')}`;
      const goal = compactInlineText(task.goal, 120);
      return goal ? `${head} (${freshness}) — goal: ${goal}` : `${head} (${freshness})`;
    });
  return [...learnedMemory, ...recentTaskMemory].slice(-10);
}

function msgId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Reply/action consistency ─────────────────────────────────────────────────
// Actions execute the moment the brain returns them — there is no held-action
// confirmation step on any path. (The old voice-mode hold was removed: the
// realtime engines rephrase speech so a literal "yes" could never arrive, and
// app-control actions were never held anyway — so the spoken "want me to?"
// routinely trailed an action that had already run.) The remaining risk is the
// LLM pairing actions with a permission question; when it does, the reply is
// rewritten into a declarative acknowledgement so the user is never asked to
// approve something that has already happened.
const PERMISSION_QUESTION_RE =
  /\b(want me to|should i|shall i|do you want|would you like|may i|can i|ready for me to|say the word|give me the go[- ]?ahead|go ahead)\b/i;

/** A short present-progressive description of the actions being executed. */
function describeActionsInProgress(actions: OrchestratorAction[]): string {
  const spawns = actions.filter((a): a is Extract<OrchestratorAction, { kind: 'spawn' }> => a.kind === 'spawn');
  const sends = actions.filter((a): a is Extract<OrchestratorAction, { kind: 'send' }> => a.kind === 'send');
  const closes = actions.filter((a): a is Extract<OrchestratorAction, { kind: 'close' }> => a.kind === 'close');

  const bits: string[] = [];
  if (spawns.length === 1) {
    bits.push(`launching ${getAgentDisplayName(spawns[0].agent) ?? spawns[0].agent}`);
  } else if (spawns.length > 1) {
    bits.push(`launching ${spawns.length} agents`);
  }
  if (sends.length === 1) bits.push(`sending that to ${sends[0].target}`);
  else if (sends.length > 1) bits.push(`dispatching ${sends.length} tasks`);
  if (closes.length === 1) {
    const t = closes[0].target.toLowerCase();
    bits.push(t === 'all' || t === 'everything' ? 'closing all the agents' : `closing ${closes[0].target}`);
  } else if (closes.length > 1) {
    bits.push('closing those agents');
  }

  return bits.join(' and ') || 'doing that now';
}

/**
 * If the reply is a permission question about actions that are executing right
 * now, replace it with a declarative acknowledgement. A genuine clarifying
 * question comes with an EMPTY actions array (per the brain's instructions)
 * and passes through untouched.
 */
function declarativeReply(actions: OrchestratorAction[], reply: string): string {
  const trimmedReply = reply.trim();
  if (!/\?\s*$/.test(trimmedReply) || !PERMISSION_QUESTION_RE.test(trimmedReply)) return reply;
  return `On it, ${describeActionsInProgress(actions)}.`;
}

/**
 * True when an empty-actions reply needs the user's answer before useful or
 * safe progress can continue. Conversational assistants often end an answer
 * with an optional offer ("Would you like more detail?"); turning every such
 * offer into an input gate makes Chat feel blocked when it is not.
 */
function looksLikeBlockingQuestion(reply: string, explicitlyRequired = false): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return false;
  if (explicitlyRequired) return true;
  if (/(?:^|[.!?]\s+)(?:would you like|want me to|should i|shall i|can i|do you want me to|what else can i|how can i help|what would you like me to)\b/i.test(trimmed)
    || /\b(?:need anything else|anything else)\b/i.test(trimmed)) {
    return false;
  }
  // Without an explicit needsInput flag, only an actual question can become
  // an input card. Informational errors often contain words such as "choose",
  // "provide", or "required" but are instructions, not questions. Turning
  // those into cards makes a harmless "okay" submit a second, context-free
  // turn instead of leaving the error visible for the user to fix.
  if (!/[?]\s*$/.test(trimmed)) return false;
  if (/\b(?:need|required|missing|blocked|waiting for|cannot proceed|can't proceed|before i can|to continue|to proceed|provide|specify|choose|select)\b/i.test(trimmed)) {
    return true;
  }
  if (!/[?]\s*$/.test(trimmed)) return false;
  return /^(?:which|what|where|who|when|how|please\s+(?:provide|specify|choose|select))\b/i.test(trimmed);
}

function markInlineRequestAnswered(
  projectId: string,
  messageId: string,
  answer: string,
): void {
  const threadId = findThreadIdForMessage(projectId, messageId);
  const list = get(chatMessages)[projectId] ?? [];
  const current = (threadId ? getThreadMessageSnapshot(threadId) : list).find((message) => message.id === messageId);
  const request = current?.inlineRequest;
  if (!request || request.answeredAt) return;
  const nextRequest: ChatInlineRequest = {
    ...request,
    answeredAt: Date.now(),
    answer,
  };
  patchChat(projectId, messageId, { inlineRequest: nextRequest });
  if (threadId) {
    updateChatThread(threadId, {
      status: 'working',
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
  }
}

type SendChatOpts = {
  projectName?: string;
  forcedAgent?: string;
  voiceConversation?: boolean;
  /** Text conversational panel — Composer prompts + conversational brain. */
  conversationalMode?: boolean;
  panelTaskId?: string;
  threadId?: string;
  /** Legacy agent provider alias used by older agent-session chats. */
  provider?: string;
  model?: string;
  /** AI provider/model that power this turn's orchestrator brain. */
  orchestratorProvider?: AiProviderId;
  orchestratorModel?: string;
  accessMode?: ChatAccessMode;
  reasoningEffort?: ChatReasoningEffort;
  /** Keep the selected agent session alive and project its replies into Chat. */
  chatMode?: boolean;
  attachments?: ChatAttachment[];
  /**
   * Resend anchor: when set, the message with this id (a user bubble being
   * resent after an edit) and every message after it are discarded atomically
   * with the new turn's appends — the stale reply is overwritten in place
   * instead of lingering next to a duplicate bubble, and the transcript never
   * paints the shrunken intermediate state (the composer bounce).
   */
  resendFromMessageId?: string;
};

/**
 * High-signal files to read automatically when the brain answered with only a
 * bare acknowledgement and the user actually asked for project work or an
 * overview. Reading these gives a re-routed model something real to summarize
 * instead of re-promising. Matched by file name against the already-built
 * project tree, so it stays correct for most project shapes.
 */
function pickProjectOverviewFiles(treeLines: string[]): string[] {
  const wanted = [
    'package.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
    'README.md',
    'readme.md',
    'src/index.ts',
    'src/index.tsx',
    'src/main.ts',
    'src/main.rs',
    'src/main.py',
    'src/App.tsx',
  ];
  const present = wanted.filter((name) => {
    const base = name.split('/').pop() as string;
    return treeLines.some((line) => {
      // Tree lines are formatted like "[file] package.json" / "[dir] src".
      const relative = line.trim().replace(/^\[(?:file|dir)\]\s*/, '');
      return relative === base || relative.endsWith('/' + base) || relative.endsWith('\\' + base);
    });
  });
  // Never read the lockfile or node_modules by accident; keep it to the first
  // few high-value files.
  return [...new Set(present)].slice(0, 3);
}

/** True when a message is short chatter with no actual request to act. */
function isConversationalChatter(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 8) return true;
  return /^(hi|hello|hey|thanks|thank you|ok|okay|sure|cool|got it|great|nice|awesome|yes|no|yeah|nah|yep|nope|bye|goodbye|see you|cya|lol|whats up|what's up)\b/i.test(t);
}

// ─── Brain direct-tool helpers (OpenCode-style fast-path, coordinator-first) ──

/**
 * Normalise a brain-supplied path to a repo-relative `a/b/c` form, or null
 * when it must be refused. Same jail rules as `readProjectFilesForContext`:
 * no absolute paths, no parent traversal, no drive letters — plus never
 * anything under `.git/` for writes. The backend's `require_in_roots` is the
 * second lock on the same door.
 */
function sanitiseBrainRepoPath(raw: string): string | null {
  const path = String(raw ?? '').trim();
  const parts = path.split(/[\\/]/);
  if (!path || /^[\\/]/.test(path) || path.includes(':') || parts.some((part) => part === '..' || part.toLowerCase() === '.git')) return null;
  const clean = parts.filter((part) => part && part !== '.').join('/');
  if (!clean) return null;
  return clean;
}

/** Join a repo-relative clean path onto an absolute root (either separator). */
function joinRootPath(root: string, clean: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return `${base}${sep}${clean.split('/').join(sep)}`;
}

function escapeGlobRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Minimal glob → RegExp: `**` spans separators, `*`/`?` stay within one
 * segment. Case-insensitive, matched against `/`-separated relative paths.
 */
function globToRegExp(pattern: string): RegExp | null {
  try {
    const norm = pattern.trim().split(/[\\/]/).filter(Boolean).join('/');
    if (!norm) return null;
    let re = '';
    let i = 0;
    while (i < norm.length) {
      const c = norm[i];
      if (c === '*') {
        if (norm[i + 1] === '*') {
          // `**/` = zero or more directories; trailing `**` = anything.
          if (norm[i + 2] === '/') {
            re += '(?:.*/)?';
            i += 3;
          } else {
            re += '.*';
            i += 2;
          }
        } else {
          re += '[^/]*';
          i += 1;
        }
      } else if (c === '?') {
        re += '[^/]';
        i += 1;
      } else {
        re += escapeGlobRegExp(c);
        i += 1;
      }
    }
    return new RegExp(`^${re}$`, 'i');
  } catch {
    return null;
  }
}

const BRAIN_GLOB_SKIP_DIRS = new Set(['node_modules', '.git', '.spacron', 'dist', 'build', '.next', '__pycache__', 'target', 'coverage', 'out', '.turbo', '.cache', '.parcel-cache', '.vscode', '.idea']);

/** Tauri's fs_read_dir payload uses `is_dir`; retain compatibility with the old `type` shape. */
interface BrainDirectoryEntry {
  name: string;
  is_dir?: boolean;
  type?: string;
}

function isBrainDirectoryEntry(item: BrainDirectoryEntry): boolean {
  return item.is_dir === true || item.type === 'dir';
}

/**
 * Walk the project via `fs_read_dir` and return repo-relative paths matching
 * the glob. Depth- and count-capped so a `**` pattern can't blow up the turn.
 * A pattern with no `/` (e.g. `*.json`) matches basenames at any depth — the
 * convenient reading for a coordinator that doesn't know where things live.
 */
async function globFilesForBrain(rootPath: string, pattern: string, max: number): Promise<string[]> {
  const matcher = globToRegExp(pattern);
  if (!matcher) return [];
  return backendInvoke<string[]>('fs_glob_files', { rootPath, pattern: matcher.source, matchAnywhere: !pattern.includes('/') && !pattern.includes('\\'), max });
}

const BRAIN_REVIEW_MAX_FILES = 120;
const BRAIN_REVIEW_FILE_CHARS = 6000;
const BRAIN_REVIEW_TOTAL_CHARS = BRAIN_REVIEW_OUTPUT_CAP;
const BRAIN_REVIEW_SKIP_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock']);
const BRAIN_REVIEW_TEXT_EXTENSIONS = new Set([
  '.astro', '.bat', '.c', '.cc', '.cmd', '.cpp', '.css', '.go', '.gql', '.graphql', '.h', '.hpp', '.html',
  '.java', '.js', '.jsx', '.json', '.kt', '.less', '.md', '.mjs', '.mts',
  '.php', '.ps1', '.py', '.rs', '.scss', '.sh', '.sql', '.svg', '.svelte', '.toml', '.ts', '.tsx', '.txt',
  '.vue', '.xml', '.yaml', '.yml',
]);
const BRAIN_REVIEW_BINARY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.class', '.dll', '.doc', '.docx', '.eot', '.exe', '.gif', '.ico', '.jar', '.jpeg',
  '.jpg', '.mov', '.mp3', '.mp4', '.otf', '.pdf', '.png', '.so', '.tar', '.ttf', '.wasm', '.webp', '.woff',
  '.woff2', '.zip',
]);

function isLikelyBrainReviewText(path: string): boolean {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (BRAIN_REVIEW_SKIP_NAMES.has(name)) return false;
  if (name === '.env.example') return true;
  if (name.endsWith('.min.js') || name.endsWith('.min.css') || name.endsWith('.map')) return false;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true;
  const ext = name.slice(dot);
  if (BRAIN_REVIEW_BINARY_EXTENSIONS.has(ext)) return false;
  return BRAIN_REVIEW_TEXT_EXTENSIONS.has(ext);
}

/**
 * Index the project's docs/ folder at turn start: title (first markdown
 * heading or filename) plus a one-line excerpt per file. This is the folder
 * local CLI agents already store their documents in, and where the brain is
 * told to write its own plans and reports. A legacy Documents/ folder is
 * indexed too so nothing previously written becomes invisible. Purely
 * additive context — every failure is swallowed so a missing or unreadable
 * docs folder can never block a turn.
 */
async function readDocumentsIndexForBrain(rootPath: string): Promise<string | null> {
  try {
    const discovered = [
      ...(await globFilesForBrain(rootPath, 'docs/**/*.md', 40)),
      ...(await globFilesForBrain(rootPath, 'Documents/**/*.md', 40)),
    ];
    // Client-side filter too: defensive against backends that ignore the
    // pattern, and keeps stray paths out of the index. Case-insensitive
    // de-dupe (Windows/macOS filesystems treat Docs/ and docs/ alike).
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const candidate of Array.isArray(discovered) ? discovered : []) {
      const lower = candidate.toLowerCase();
      if ((!candidate.startsWith('docs/') && !candidate.startsWith('Documents/')) || !lower.endsWith('.md') || seen.has(lower)) continue;
      seen.add(lower);
      paths.push(candidate);
      if (paths.length >= 24) break;
    }
    if (!paths.length) return null;
    const entries: DocumentsIndexEntry[] = [];
    for (const path of paths.slice(0, 24)) {
      try {
        const raw = await backendInvoke<string>('fs_read_file', { path: joinRootPath(rootPath, path) });
        const text = typeof raw === 'string' ? raw : String(raw ?? '');
        const lines = text.split('\n').map((line) => line.trim());
        const heading = lines.find((line) => /^#\s+\S/.test(line));
        const title = heading
          ? heading.replace(/^#\s+/, '')
          : path.split('/').pop()!.replace(/[-_]/g, ' ').replace(/\.md$/i, '');
        const bodyStart = lines.findIndex((line) => line && !line.startsWith('#'));
        const excerpt = bodyStart >= 0 ? lines[bodyStart] : undefined;
        entries.push({ path, title, ...(excerpt ? { excerpt } : {}) });
      } catch { /* unreadable file: index the rest */ }
    }
    return formatDocumentsIndexBlock(entries);
  } catch {
    return null;
  }
}

/** Read a bounded, source-oriented project snapshot for same-turn reviews. */
async function readProjectForBrain(rootPath: string, requestedMax: number, offset = 0): Promise<string> {
  const maxFiles = Math.max(1, Math.min(Math.floor(requestedMax), BRAIN_REVIEW_MAX_FILES));
  const discovered = await globFilesForBrain(rootPath, '**/*', offset + maxFiles * 2);
  const candidates = discovered.filter(isLikelyBrainReviewText).slice(offset, offset + maxFiles);
  const loaded = await Promise.all(candidates.map(async (path) => {
    try {
      const content = await backendInvoke<string>('fs_read_file', { path: joinRootPath(rootPath, path) });
      const text = typeof content === 'string' ? content : String(content ?? '');
      if (text.includes('\u0000')) return null;
      return { path, text };
    } catch {
      return null;
    }
  }));

  let chars = 0;
  let readCount = 0;
  let truncated = false;
  const sections: string[] = [];
  for (const item of loaded) {
    if (!item) continue;
    if (chars >= BRAIN_REVIEW_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    const remaining = BRAIN_REVIEW_TOTAL_CHARS - chars;
    const content = item.text.slice(0, Math.min(BRAIN_REVIEW_FILE_CHARS, remaining));
    const fileTruncated = content.length < item.text.length;
    if (fileTruncated) truncated = true;
    sections.push(`--- ${item.path}${fileTruncated ? ' (truncated)' : ''} ---\n${content}`);
    chars += content.length;
    readCount += 1;
  }

  const header = `For further files use glob_files with offset; for full file contents use read_file with start_line. Next review offset=${offset + readCount}. Broad project snapshot: read ${readCount} of ${candidates.length} relevant text file(s), ${chars} characters${truncated || discovered.length > candidates.length ? '. Some files were omitted or truncated for safety.' : '.'}`;
  return [header, ...sections, 'Review this source before replying. Give the user the concrete findings and suggested changes in this same turn.'].join('\n\n').slice(0, BRAIN_REVIEW_TOTAL_CHARS);
}

// ─── Brain synchronous command runs (OpenCode `bash` parity) ────────────────

export const BRAIN_RUN_POLL_MS = 300;
export const BRAIN_RUN_DEFAULT_TIMEOUT_MS = 90_000;
export const BRAIN_RUN_MAX_TIMEOUT_MS = 300_000;

export interface BrainRunResult {
  /** Process exit code. Null when the session closed first or no terminal. */
  exitCode: number | null;
  /** Raw PTY output since the command was sent (sentinel lines included). */
  output: string;
  /** True when the timeout fired before the completion sentinel arrived. */
  timedOut: boolean;
  elapsedMs: number;
}

/**
 * Run one shell command for the brain and wait for it to finish, OpenCode-
 * `bash`-style: exit code plus output, in the same turn.
 *
 * Reuses the sentinel protocol from `embeddedCommand`/`embeddedRun` (wrap the
 * command so the shell echoes `__SPACRON_EMBEDDED_DONE_<token>_<code>__`, poll
 * for it) but project-scoped: a dedicated HIDDEN session on this projectId /
 * rootPath, killed the moment the command settles, so the user's visible
 * terminals are never polluted and focus never moves. No toasts, no store
 * chips — the result goes back to the model as tool output.
 */
export async function runBrainCommand(
  projectId: string,
  rootPath: string,
  command: string,
  timeoutMs: number = BRAIN_RUN_DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
  onOutput?: (output: string) => void,
): Promise<BrainRunResult> {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const timeout = timeoutMs === 0 ? 0 : Number.isFinite(timeoutMs)
    ? Math.max(1000, timeoutMs)
    : BRAIN_RUN_DEFAULT_TIMEOUT_MS;
  const elapsed = () => Date.now() - startedAt;
  const isDev = get(layoutSnapshot).ambient === 'development';

  let sessionId: number | null = null;
  try {
    sessionId = await createTerminalSession(rootPath || undefined, undefined, projectId, {
      isDev,
      assignPane: false,
      hidden: true,
    });
  } catch {
    sessionId = null;
  }
  if (sessionId == null) {
    return { exitCode: null, output: '', timedOut: false, elapsedMs: elapsed() };
  }
  const sid: number = sessionId;
  if (signal?.aborted) { await killSession(sid); signal.throwIfAborted(); }

  const wrapper = buildEmbeddedCommand(command, detectShellKind());
  const outputStart = getSessionOutputLength(sid);
  sendPromptToSession(sid, wrapper.text);

  try {
    return await new Promise<BrainRunResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      const finish = (partial: Omit<BrainRunResult, 'elapsedMs'>) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        if (killer) clearTimeout(killer);
        signal?.removeEventListener('abort', abort);
        unlisten();
        resolve({ ...partial, elapsedMs: elapsed() });
      };
      const unlisten = onSessionExit((info) => {
        if (info.sessionId === sid) {
          finish({ exitCode: null, output: getSessionOutputSince(sid, outputStart), timedOut: false });
        }
      });
      const abort = () => finish({ exitCode: null, output: getSessionOutputSince(sid, outputStart), timedOut: false });
      const killer = timeout ? setTimeout(() => {
        finish({ exitCode: null, output: getSessionOutputSince(sid, outputStart), timedOut: true });
      }, timeout) : null;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setInterval(() => {
        const output = getSessionOutputSince(sid, outputStart);
        onOutput?.(output);
        const exitCode = parseEmbeddedExitCode(output, wrapper.match);
        if (exitCode !== null) {
          finish({ exitCode, output, timedOut: false });
        }
      }, BRAIN_RUN_POLL_MS);
    });
  } finally {
    try {
      await killSession(sid);
    } catch {
      // Session already gone (or a mocked kill) — the result stands.
    }
  }
}

/** Drop the sentinel protocol lines (typed echo + executed echo) from a run. */
function stripBrainRunSentinels(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.includes(EMBEDDED_DONE_PREFIX))
    .join('\n');
}

/**
 * Render a finished brain run as compact tool output: status header plus the
 * ANSI-stripped tail, capped for the model prompt. Pure — unit-tested.
 */
export function formatBrainRunResult(command: string, result: BrainRunResult): string {
  const secs = (result.elapsedMs / 1000).toFixed(1);
  const status = result.timedOut
    ? `TIMEOUT after ${secs}s (no completion — narrow the command or raise timeout_s)`
    : result.exitCode === null
      ? `SESSION CLOSED after ${secs}s before the command completed`
      : `exit ${result.exitCode} in ${secs}s`;
  const body = stripBrainRunSentinels(captureTranscript(result.output, BRAIN_TOOL_OUTPUT_CAP)).trim() || '(no output)';
  return `${status}: \`${command.slice(0, 200)}\`\n${body}`.slice(0, BRAIN_TOOL_OUTPUT_CAP + 256);
}

/**
 * Talk to the orchestrator. Appends the user message, asks the brain how to
 * route it (LLM when configured, heuristic otherwise), replies, and — when the
 * brain decides to act — creates a task and launches the chosen agent.
 *
 * `forcedAgent` (a preset command, or 'auto') lets the user override routing.
 *
 * Actions the brain returns execute immediately on every path — there is no
 * confirmation hold. If the user should be asked first, the brain asks with an
 * empty actions array and acts on the next turn.
 */
const brainApprovals = new Map<string, (approved: boolean) => void>();
/** Short-lived per-root project-tree cache so consecutive turns skip the FS walk. */
const projectTreeCache = new Map<string, { tree: string; builtAt: number }>();
/**
 * Test hook: clear per-turn module caches (project-tree TTL cache, message
 * queues, drain locks) so tests with different FS mocks for the same root
 * never inherit a previous test's cached tree.
 */
export function resetOrchestratorCachesForTests(): void {
  projectTreeCache.clear();
  chatQueues.clear();
  drainingChatThreads.clear();
  chatMessageQueues.set({});
}
const answeringChatRequests = new Set<string>();
interface BrainJob { owner: string; controller: AbortController; output: string; result?: BrainRunResult; error?: string }
const brainJobs = new Map<string, BrainJob>();
const activeBrainTurns = new Map<string, AbortController>();
export function stopChatTurn(threadId: string): void {
  activeBrainTurns.get(threadId)?.abort();
  for (const job of brainJobs.values()) if (job.owner === threadId && !job.result) job.controller.abort();
  clearChatTurnTicker(threadId);
}

// ─── Chat message queue ────────────────────────────────────────────────────
// Sending while a turn runs ENQUEUES instead of dropping the message: FIFO
// order, one turn at a time, drained automatically. Any queued message can be
// promoted to the front AND interrupt the running turn — that is steering.

export interface QueuedChatMessage {
  id: string;
  projectId: string;
  rootPath: string;
  text: string;
  ts: number;
  opts: SendChatOpts;
}

/** Live queue snapshots per thread, for the composer's queued-messages UI. */
export const chatMessageQueues = writable<Record<string, QueuedChatMessage[]>>({});

const chatQueues = new Map<string, QueuedChatMessage[]>();
const drainingChatThreads = new Set<string>();

function notifyChatQueueListeners(threadId: string): void {
  chatMessageQueues.update((all) => {
    const queue = chatQueues.get(threadId) ?? [];
    if (!queue.length) {
      if (!(threadId in all)) return all;
      const { [threadId]: _dropped, ...rest } = all;
      return rest;
    }
    return { ...all, [threadId]: [...queue] };
  });
}

/** Snapshot of what is still waiting to run in a thread. */
export function getQueuedChatMessages(threadId: string): QueuedChatMessage[] {
  return [...(chatQueues.get(threadId) ?? [])];
}

/** Drop one queued message (the user removed it before it ran). */
export function removeQueuedChatMessage(threadId: string, id: string): void {
  const queue = chatQueues.get(threadId);
  if (!queue) return;
  chatQueues.set(threadId, queue.filter((entry) => entry.id !== id));
  notifyChatQueueListeners(threadId);
}

/** Move one queued message to the front of the queue (answer it next). */
export function promoteQueuedChatMessage(threadId: string, id: string): void {
  const queue = chatQueues.get(threadId);
  const index = queue?.findIndex((entry) => entry.id === id) ?? -1;
  if (!queue || index <= 0) return;
  const [entry] = queue.splice(index, 1);
  queue.unshift(entry);
  notifyChatQueueListeners(threadId);
}

/**
 * Steering: answer THIS message next even though a turn is already running.
 * Moves the queued message to the front and stops the in-flight turn, so the
 * drain loop starts the steered message immediately.
 */
export function steerQueuedChatMessage(threadId: string, id: string): void {
  promoteQueuedChatMessage(threadId, id);
  if (activeBrainTurns.has(threadId)) stopChatTurn(threadId);
}

async function drainChatQueue(threadId: string): Promise<void> {
  if (!threadId || drainingChatThreads.has(threadId)) return;
  drainingChatThreads.add(threadId);
  try {
    for (;;) {
      const queue = chatQueues.get(threadId);
      const next = queue?.shift();
      notifyChatQueueListeners(threadId);
      if (!next) break;
      if (!getChatThread(threadId)) {
        chatQueues.delete(threadId);
        notifyChatQueueListeners(threadId);
        break;
      }
      try {
        await sendChatMessage(next.projectId, next.rootPath, next.text, next.opts);
      } catch (error) {
        console.error('Queued chat turn failed:', error);
      }
    }
  } finally {
    drainingChatThreads.delete(threadId);
  }
}

/**
 * Send a chat message through the queue: while a turn runs (or other messages
 * are waiting), the message joins the queue and runs in order; otherwise it
 * starts immediately. Returns the queue entry so the UI can offer steering.
 */
export async function enqueueChatMessage(
  projectId: string,
  rootPath: string,
  text: string,
  opts: SendChatOpts,
): Promise<QueuedChatMessage | null> {
  const trimmed = text.trim();
  if (!trimmed || !projectId) return null;
  const threadId = opts?.threadId ? getChatThread(opts.threadId)?.id : undefined;
  const busy = (threadId && drainingChatThreads.has(threadId)) || (threadId && activeBrainTurns.has(threadId));
  const entry: QueuedChatMessage = {
    id: crypto.randomUUID(),
    projectId,
    rootPath,
    text: trimmed,
    ts: Date.now(),
    opts,
  };
  if (threadId && busy) {
    const queue = chatQueues.get(threadId) ?? [];
    queue.push(entry);
    chatQueues.set(threadId, queue);
    notifyChatQueueListeners(threadId);
    return entry;
  }
  await drainChatQueueWith(entry, threadId);
  return entry;
}

async function drainChatQueueWith(first: QueuedChatMessage, threadId: string | undefined): Promise<void> {
  if (threadId) {
    chatQueues.set(threadId, [first, ...(chatQueues.get(threadId) ?? [])]);
    notifyChatQueueListeners(threadId);
    await drainChatQueue(threadId);
    return;
  }
  // No thread (legacy project-level chat): run inline as before.
  try {
    await sendChatMessage(first.projectId, first.rootPath, first.text, first.opts);
  } catch (error) {
    console.error('Chat turn failed:', error);
  }
}


export async function sendChatMessage(
  projectId: string,
  rootPath: string,
  text: string,
  opts?: SendChatOpts,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || !projectId) return;

  const chatThreadId = opts?.threadId ? getChatThread(opts.threadId)?.id : undefined;
  const chatThread = chatThreadId ? getChatThread(chatThreadId) : null;
  if (opts?.threadId && (!chatThread || chatThread.projectId !== projectId)) return;
  if (chatThreadId) clearChatTurnTicker(chatThreadId);

  // Resend-after-edit: logically the transcript already ends at the edited
  // bubble — everything from the anchor onwards is stale and will be replaced
  // by this turn. Reads below use the pre-anchor snapshot so routing decisions
  // (pending inputs, follow-up vs fresh turn) ignore the discarded tail, while
  // the physical removal is deferred to `applyResendTruncation`, which always
  // runs synchronously back-to-back with the new turn's appends so the UI
  // paints the swap in a single frame instead of flashing the shrunken
  // transcript first (the composer jumping up and back down).
  const resendAnchorId = chatThreadId ? opts?.resendFromMessageId : undefined;
  const preResendSnapshot = chatThreadId ? getThreadMessageSnapshot(chatThreadId) : [];
  const resendAnchorIndex = resendAnchorId
    ? preResendSnapshot.findIndex((message) => message.id === resendAnchorId)
    : -1;
  const resendAnchor = resendAnchorIndex >= 0 ? preResendSnapshot[resendAnchorIndex] : null;
  const resendActive = Boolean(
    resendAnchor && resendAnchor.role === 'user' && resendAnchor.text.trim() !== trimmed,
  );
  // Reads elsewhere in this turn see the transcript as if the stale tail were
  // already gone (no physical removal yet — that stays deferred for atomicity).
  const readSnapshot = resendActive ? preResendSnapshot.slice(0, resendAnchorIndex) : preResendSnapshot;
  let resendApplied = false;
  function applyResendTruncation(): void {
    if (resendApplied || !resendActive || !chatThreadId || !resendAnchorId) return;
    resendApplied = true;
    const truncation = removeThreadMessagesFrom(chatThreadId, resendAnchorId);
    if (!truncation) return;
    const removedIds = new Set(truncation.removedIds);
    chatMessages.update((all) => {
      const list = all[projectId] ?? [];
      if (!list.some((message) => removedIds.has(message.id))) return all;
      return { ...all, [projectId]: list.filter((message) => !removedIds.has(message.id)) };
    });
  }

  const pendingInput = readSnapshot
    .slice().reverse().find((message) => message.inlineRequest && !message.inlineRequest.answeredAt);
  if (pendingInput?.inlineRequest?.id.startsWith('brain-approval-')) {
    const resolve = brainApprovals.get(pendingInput.inlineRequest.id);
    if (resolve) {
      applyResendTruncation();
      appendChat(projectId, { id: msgId(), role: 'user', text: trimmed, ts: Date.now() }, chatThreadId);
      markInlineRequestAnswered(projectId, pendingInput.id, trimmed);
      resolve(trimmed === 'Approve');
    } else {
      patchChat(projectId, pendingInput.id, { inlineRequest: null, pending: false, type: 'failure', text: 'This approval expired when the app restarted. Send the original request again; no pending operation was executed.' });
    }
    return;
  }
  const conversationalMode = opts?.conversationalMode === true || opts?.voiceConversation === true;
  const chatMode = opts?.chatMode === true
    || opts?.conversationalMode === true
    || Boolean(chatThread?.provider && isChatAgentProvider(chatThread.provider));

  const threadTask = chatThreadId
    ? (() => {
    const thread = getChatThread(chatThreadId);
        const taskId = pendingInput?.inlineRequest?.taskId ?? thread?.taskId;
        return taskId
          ? get(orchestratorTasks).find((task) => task.id === taskId && task.projectId === projectId) ?? null
          : null;
      })()
    : null;
  if (
    chatMode &&
    chatThreadId &&
    threadTask &&
    (!pendingInput || Boolean(pendingInput.inlineRequest?.taskId)) &&
    ((threadTask.status === 'in-progress' && threadTask.assignedSessionId != null) || threadTask.status === 'blocked')
  ) {
    // The stale tail (if any) goes first so the follow-up's own appends land
    // on the already-truncated transcript in the same frame.
    applyResendTruncation();
    // Answering a Composer needs-input card for this thread marks it answered.
    const pendingInput = (getThreadMessageSnapshot(chatThreadId) ?? [])
      .slice()
      .reverse()
      .find((message) =>
        (message.type === 'approval' || message.type === 'input')
        && message.inlineRequest
        && !message.inlineRequest.answeredAt,
      );
    if (answeringChatRequests.has(chatThreadId)) return;
    answeringChatRequests.add(chatThreadId);
    try {
      await sendThreadFollowUp(projectId, rootPath, chatThreadId, threadTask, trimmed, chatMode, opts?.attachments ?? [], pendingInput?.id);
    } finally { answeringChatRequests.delete(chatThreadId); }
    return;
  }

  // An inline request that holds no context — the brain's clarifying question,
  // or an agent-input card whose task was cancelled meanwhile — is answered
  // simply by sending the reply: mark it answered so the card closes, then
  // route the answer as a fresh turn below. Reads the pre-anchor snapshot so a
  // stale request in the discarded tail is never treated as the live one.
  const unheldPendingInput = readSnapshot
    .slice()
    .reverse()
    .find((message) =>
      (message.type === 'approval' || message.type === 'input')
      && message.inlineRequest
      && !message.inlineRequest.answeredAt,
    );
  if (unheldPendingInput?.inlineRequest) {
    markInlineRequestAnswered(projectId, unheldPendingInput.id, trimmed);
  }

  // Recheck the selected connection against the OS keychain for every Chat
  // turn. The startup cache is for UI responsiveness; it must not decide that
  // a key saved during/after startup is missing and prevent ai_complete from
  // ever reaching the Rust-side resolver.
  const access = await detectAgentAccess({
    fresh: true,
    preferredProvider: opts?.orchestratorProvider,
  });
  if (!access.ready) {
    const blockedAttachments = opts?.attachments ?? [];
    applyResendTruncation();
    appendChat(projectId, { id: msgId(), role: 'user', text: trimmed, ts: Date.now(), attachments: blockedAttachments }, chatThreadId);
    appendChat(projectId, {
      id: msgId(),
      role: 'assistant',
      text: access.message || getAgentAccessBlockedMessage(),
      ts: Date.now(),
    }, chatThreadId);
    return;
  }

  const agents = getDispatchableAgents(projectId);
  if (!get(tasks).some((task) => task.projectId === projectId)) {
    try {
      await loadProjectTasks({ id: projectId, root_path: rootPath });
    } catch {
      // Task-panel context is helpful but must never block dispatch.
    }
  }
  // Atomic swap point for resends: discard the stale tail and append the new
  // turn's messages with no await between, so the transcript paints once.
  applyResendTruncation();
  const conversation = (chatThreadId
    ? getThreadMessageSnapshot(chatThreadId)
    : (get(chatMessages)[projectId] ?? []))
    .filter((m) => !m.pending && m.type !== 'activity')
    .map((m) => ({ role: m.role, text: m.text || m.completion?.summary || m.completion?.reason || '' })).slice(-12);
  const recentUserMessages = conversation
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
    .slice(-6);
  const taskMemory = buildProjectTaskMemory(projectId);
  const taskPanel = getProjectTaskPanelLines(projectId);
  const mailboxLines = getMailboxLines(projectId);
  const knowledgeLines = getKnowledgeLines(projectId);
  const llmConfig = await resolveConversationLlmConfig({
    provider: opts?.orchestratorProvider,
    model: opts?.orchestratorModel,
    sessionId: chatThreadId,
  });

  const attachments = opts?.attachments ?? [];
  const promptText = buildAttachmentPrompt(trimmed, attachments);
  if (chatThreadId) {
    clearChatTurnTicker(chatThreadId);
  }
  appendChat(projectId, { id: msgId(), role: 'user', text: trimmed, ts: Date.now(), attachments }, chatThreadId);
  const assistantId = msgId();
  appendChat(projectId, { id: assistantId, role: 'assistant', text: '', ts: Date.now(), pending: true }, chatThreadId);

  let result: RouteResult;
  // Multi-step progress evidence: every completed tool round feeds the live
  // progress line and, at turn end, the completion-summary card (Phase 3/4).
  // Cleared per turn so a summary never folds a previous turn's evidence in.
  let turnEvidence: BrainToolResult[] = [];
  let turnTodos: ChatTurnTodoItem[] = [];
  const legacyProviderAgent = opts?.provider && isChatAgentProvider(opts.provider)
    ? opts.provider.trim()
    : undefined;
  const selectedAgent = opts?.forcedAgent || legacyProviderAgent;
  const forced = selectedAgent && selectedAgent !== 'auto'
    ? agents.find((a) => a.command === selectedAgent)
    : null;
  if (forced) {
    result = {
      reply: `Handing this to ${forced.name}.`,
        actions: [{ kind: 'spawn', agent: forced.command, prompt: promptText, model: opts?.model?.trim() || null, panelTaskId: opts?.panelTaskId ?? null }],
      viaLLM: false,
    };
  } else {
    // Route, but let the brain read project files it asks for before acting: the
    // LLM answers PROJECT questions itself ("how is auth wired?") by requesting
    // the relevant files, and we fetch them and re-route — bounded to a couple
    // of rounds so a read-happy model can't stall the turn. A compact project
    // tree is always included so the brain can pick exact paths on the first try.
    const routeWithProjectReads = async (): Promise<RouteResult> => {
      const turnKey = chatThreadId ?? projectId;
      if (activeBrainTurns.has(turnKey)) return { reply: 'A turn is already running in this conversation. Stop it before starting another.', actions: [], viaLLM: false, failed: true };
      const controller = new AbortController();
      activeBrainTurns.set(turnKey, controller);
      const checkActive = () => {
        if (chatThreadId && !getChatThread(chatThreadId)) controller.abort();
        controller.signal.throwIfAborted();
      };
      const MAX_READ_ROUNDS = 3;
      const projectReads: Array<{ path: string; content: string; truncated: boolean }> = [];
      const MAX_TURN_EVIDENCE_RESULTS = 400;
      turnTodos = [];
      const recordTurnProgress = (results: BrainToolResult[]): void => {
        turnEvidence = results.slice(-MAX_TURN_EVIDENCE_RESULTS);
        // Progress surfaces are the live ticker above the composer and the
        // Work details rows; the assistant bubble stays clean for the final
        // answer instead of flickering a transient "Read grep_code: …" line.
        if (!chatThreadId) return;
        if (turnTodos.length) {
          const advanced = advanceTodoItems(turnTodos, results);
          if (advanced.changed) {
            turnTodos = advanced.todos;
            advanceChatTurnTicker(chatThreadId, turnTodos);
          }
        }
      };
      // A model can emit the same read several times in one tool batch. Keep
      // one in-flight/result promise per stable project-read request so the
      // filesystem and activity timeline reflect the actual work performed,
      // rather than one activity per duplicate call.
      const projectReadCache = new Map<string, Promise<{ output: string; actions?: OrchestratorAction[] }>>();
      let projectTree: string | null = null;
      let readRounds = 0;
      let mutationDeclined = false;
      // One-shot guard for the authoritative-plan contract: a later
      // update_todos that silently drops unfinished work is sent back once for
      // the complete list, and never a second time (see the update_todos case).
      let planResendRequested = false;
      // Tool executor: the brain's tool_calls land here. Reads push into
      // projectReads too so the final turn keeps its source context.
      // Write tools (write_file/edit_file) are the coordinator fast-path for
      // SURGICAL changes only — jailed to the project root by the backend's
      // require_in_roots, plus repo-relative sanitising here. run_command
      // queues a VISIBLE terminal run (async); wait_for_agent is the
      // monitor-loop read (WORKING/BLOCKED/COMPLETE) so the brain never
      // infers done-ness from terminal silence.
      const executeTool = async (call: BrainToolCall): Promise<{ output: string; actions?: OrchestratorAction[] }> => {
        switch (call.name) {
          case 'read_project': {
            if (!rootPath) return { output: 'error: no active project.' };
            const maxFiles = toolArgNum(call.args, 'max_files', 80);
            try {
              return { output: await readProjectForBrain(rootPath, maxFiles, toolArgNum(call.args, 'offset', 0)) };
            } catch (error) {
              return { output: `error: project review read failed: ${String(error ?? 'unknown')}` };
            }
          }
          case 'read_file': {
            const path = sanitiseBrainRepoPath(toolArgStr(call.args, 'path'));
            if (!path || !rootPath) return { output: 'error: provide a repo-relative path in the active project.' };
            const content = await backendInvoke<string>('fs_read_file', { path: joinRootPath(rootPath, path) });
            return { output: `${path}\n${filePage(content, toolArgNum(call.args, 'start_line', 1), toolArgNum(call.args, 'line_count', 200), toolArgNum(call.args, 'start_char', 0))}` };
          }
          case 'read_tool_result': {
            const id = toolArgStr(call.args, 'id');
            const saved = chatThreadId ? getChatThread(chatThreadId)?.agentCheckpoint?.results.slice().reverse().find(r => r.id === id) : undefined;
            if (!saved) return { output: 'error: result not found in this conversation.' };
            const offset = toolArgNum(call.args, 'offset', 0);
            const next = offset + 12000;
            return { output: `${saved.output.slice(offset, next)}\n${next < saved.output.length ? `Continue: offset=${next}` : 'End of result'}` };
          }
          case 'glob_files': {
            const pattern = toolArgStr(call.args, 'pattern');
            if (!pattern) return { output: 'error: missing "pattern" argument.' };
            if (!rootPath) return { output: 'error: no active project.' };
            const max = Math.max(1, Math.min(toolArgNum(call.args, 'max', 20), 50));
            try {
              const offset = toolArgNum(call.args, 'offset', 0);
              const all = await globFilesForBrain(rootPath, pattern, offset + max + 1);
              const hits = all.slice(offset, offset + max);
              if (!hits.length) return { output: `No files match "${pattern}".` };
              return { output: `Files matching "${pattern}" (${hits.length}):\n${hits.map((h) => `- ${h}`).join('\n')}${all.length > offset + max ? `\nContinue: offset=${offset + max}` : '\nEnd of results'}` };
            } catch (error) {
              return { output: `error: glob failed: ${String(error ?? 'unknown')}` };
            }
          }
          case 'grep_code': {
            const query = toolArgStr(call.args, 'query');
            if (!query) return { output: 'error: missing "query" argument.' };
            if (!projectId) return { output: 'error: no active project.' };
            try {
              const res = await backendInvoke<{ files: Array<{ rel_path: string; matches: Array<{ line: number; column: number; text: string }> }>; total_matches: number; truncated: boolean }>('search_in_project', {
                projectId,
                query,
                case_sensitive: toolArgBool(call.args, 'case_sensitive', false),
                whole_word: toolArgBool(call.args, 'whole_word', false),
                use_regex: toolArgBool(call.args, 'use_regex', false),
                include_glob: toolArgStr(call.args, 'include_glob') || undefined,
                offset: toolArgNum(call.args, 'offset', 0),
                limit: Math.min(20, Math.max(1, toolArgNum(call.args, 'max', 20))),
              });
              if (!res.files.length) return { output: `No matches for "${query.slice(0, 80)}".` };
              const lines: string[] = [];
              for (const f of res.files) {
                for (const m of f.matches) {
                  lines.push(`- ${f.rel_path}:${m.line}:${m.column}: ${String(m.text ?? '').slice(0, 160)}`);
                }
              }
              const tail = res.truncated ? `\nContinue: offset=${toolArgNum(call.args, 'offset', 0) + res.total_matches}` : '\nEnd of results';
              return { output: `${res.total_matches} match(es) in ${res.files.length} file(s):\n${lines.join('\n')}${tail}`.slice(0, BRAIN_TOOL_OUTPUT_CAP) };
            } catch (error) {
              return { output: `error: search failed: ${String(error ?? 'unknown')}` };
            }
          }
          case 'write_file': {
            const rawPath = toolArgStr(call.args, 'path');
            const content = typeof call.args.content === 'string' ? call.args.content : null;
            if (!rawPath) return { output: 'error: missing "path" argument.' };
            if (content === null) return { output: 'error: missing "content" argument (full file text).' };
            if (!rootPath) return { output: 'error: no active project.' };
            const clean = sanitiseBrainRepoPath(rawPath);
            if (!clean) return { output: `error: refusing path "${rawPath}" — repo-relative paths only, never outside the project or under .git.` };

            try {
              checkActive();
              await backendInvoke('fs_write_file_checked', { path: joinRootPath(rootPath, clean), content, expectedContent: typeof call.args.expected_content === 'string' ? call.args.expected_content : undefined });
              return { output: `Wrote ${clean} (${content.length} chars).` };
            } catch (error) {
              return { output: `error: write failed: ${String(error ?? 'unknown')}` };
            }
          }
          case 'save_document': {
            const content = typeof call.args.content === 'string' ? call.args.content : null;
            if (content === null) return { output: 'error: missing "content" argument (full document text).' };
            const requestedName = toolArgStr(call.args, 'filename');
            const filename = requestedName || `spacron-document-${new Date().toISOString().slice(0, 10)}.md`;
            if (!/^[^\\/:*?"<>|]+$/.test(filename) || filename === '.' || filename === '..') {
              return { output: 'error: invalid filename; use a single filename without folders or path separators.' };
            }
            try {
              checkActive();
              const savedPath = await invoke<string>('save_document_file', { filename, content });
              return { output: `Saved ${savedPath} (${content.length} chars).` };
            } catch (error) {
              return { output: `error: document save failed: ${String(error ?? 'unknown')}` };
            }
          }
          case 'edit_file': {
            const rawPath = toolArgStr(call.args, 'path');
            const oldStr = typeof call.args.old_string === 'string' ? call.args.old_string : '';
            const newStr = typeof call.args.new_string === 'string' ? call.args.new_string : null;
            if (!rawPath) return { output: 'error: missing "path" argument.' };
            if (!oldStr) return { output: 'error: missing "old_string" argument (exact text to replace).' };
            if (newStr === null) return { output: 'error: missing "new_string" argument (may be empty for deletion).' };
            if (!rootPath) return { output: 'error: no active project.' };
            const clean = sanitiseBrainRepoPath(rawPath);
            if (!clean) return { output: `error: refusing path "${rawPath}" — repo-relative paths only, never outside the project or under .git.` };
            try {
              const current = await backendInvoke<string>('fs_read_file', { path: joinRootPath(rootPath, clean) });
              let count = 0;
              let idx = current.indexOf(oldStr);
              while (idx !== -1 && count < 3) {
                count += 1;
                idx = current.indexOf(oldStr, idx + oldStr.length);
              }
              if (count === 0) return { output: `error: old_string not found in ${clean} — re-read it and copy the exact text (whitespace included).` };
              if (count > 1) return { output: `error: old_string matches ${count} times in ${clean} — include more surrounding lines so exactly one occurrence matches.` };
              const next = current.replace(oldStr, newStr);
              checkActive();
              await backendInvoke('fs_write_file_checked', { path: joinRootPath(rootPath, clean), content: next, expectedContent: current });
              return { output: `Edited ${clean} (replaced ${oldStr.length} chars).` };
            } catch (error) {
              const msg = String(error ?? 'unknown');
              if (msg.startsWith('error: old_string') || msg.startsWith('error: edit grows')) return { output: msg };
              return { output: `error: edit failed: ${msg}` };
            }
          }
          case 'run_command': {
            const command = toolArgStr(call.args, 'command');
            if (!command) return { output: 'error: missing "command" argument.' };

            // Synchronous OpenCode-`bash` semantics: run hidden in the project
            // shell and return exit code + output in THIS turn — no next-turn
            // polling, no visible-terminal queue.
            const background = toolArgBool(call.args, 'background', false);
            const timeoutS = toolArgNum(call.args, 'timeout_s', background ? 0 : 90);
            if (background) {
              const id = crypto.randomUUID();
              const job: BrainJob = { owner: turnKey, controller: new AbortController(), output: '' };
              brainJobs.set(id, job);
              void runBrainCommand(projectId, rootPath, command, timeoutS * 1000, job.controller.signal, output => { job.output = output; })
                .then(result => { job.result = result; job.output = result.output; }, error => { job.error = String(error); });
              return { output: `Started background command ${id}. Use command_status(id) until an exit code is available. It is not complete yet.` };
            }
            const res = await runBrainCommand(projectId, rootPath, command, timeoutS * 1000, controller.signal);
            return { output: formatBrainRunResult(command, res) };
          }
          case 'command_status':
          case 'cancel_command': {
            const id = toolArgStr(call.args, 'id');
            const job = brainJobs.get(id);
            if (!job || job.owner !== turnKey) return { output: 'error: command not found in this conversation (it may have ended when the app closed). Inspect before restarting.' };
            if (call.name === 'cancel_command') { job.controller.abort(); return { output: 'Cancellation requested.' }; }
            if (!job.result && !job.error) await new Promise(resolve => setTimeout(resolve, 1000));
            const offset = toolArgNum(call.args, 'offset', 0);
            const output = stripBrainRunSentinels(captureTranscript(job.output, job.output.length));
            const next = offset + 12000;
            return { output: `${job.error ? `error: ${job.error}` : job.result ? formatBrainRunResult('', { ...job.result, output: '' }) : 'WORKING'}\n${output.slice(offset, next)}\n${next < output.length ? `Continue: offset=${next}` : 'End of current output'}` };
          }
          case 'wait_for_agent': {
            const name = toolArgStr(call.args, 'name');
            if (!name) return { output: 'error: missing "name" argument.' };
            const outputs = getAgentOutputRefs(projectId);
            const hit =
              outputs.find((o) => (o.name ?? '').toLowerCase() === name.toLowerCase()) ??
              outputs.find((o) => (o.name ?? '').toLowerCase().includes(name.toLowerCase())) ??
              outputs.find((o) => o.agent.toLowerCase() === name.toLowerCase());
            if (hit) {
              const label = `"${hit.name ?? hit.agent}"`;
              const tail = hit.recentOutput?.trim().slice(-1500) ?? '(no output captured yet)';
              if (hit.status === 'in-progress') {
                return { output: `WORKING: ${label} is still in progress on "${hit.title}". Latest output tail:\n${tail}\n\nSay briefly that it is still working and stop — the next turn re-checks. Do not report completion.` };
              }
              if (hit.status === 'blocked') {
                return { output: `BLOCKED: ${label} is waiting on input for "${hit.title}".${hit.reason ? ` Reason: ${hit.reason}.` : ''} Output tail:\n${tail}\n\nRelay its question to the user via ask_question (target ${label}) and stop. Do not answer for it.` };
              }
              if (hit.status === 'complete') {
                return { output: `COMPLETE: ${label} finished "${hit.title}". Result tail:\n${tail}` };
              }
              return { output: `${hit.status.toUpperCase()}: ${label} — "${hit.title}".${hit.reason ? ` Reason: ${hit.reason}.` : ''} Output tail:\n${tail}` };
            }
            const running = getRunningAgentRefs(projectId);
            const live =
              running.find((r) => (r.name ?? '').toLowerCase() === name.toLowerCase()) ??
              running.find((r) => (r.name ?? '').toLowerCase().includes(name.toLowerCase()));
            if (live) {
              const latest = live.recentOutput?.trim().split('\n').filter(Boolean).pop() ?? '(no output yet)';
              return { output: `WORKING: "${live.name ?? live.agent}" is live (${live.title}). Latest: ${latest.slice(0, 300)}` };
            }
            return { output: `error: no agent found named "${name}". Use list_agents to see who is running.` };
          }
          case 'ask_question': {
            const question = toolArgStr(call.args, 'question');
            const options = toolArgStrArr(call.args, 'options');
            const target = toolArgStr(call.args, 'target');
            if (!question) return { output: 'error: missing "question" argument.' };
            const opt = options.length ? ` Options: ${options.join(' | ')}.` : '';
            const tgt = target ? ` For ${target}.` : '';
            return { output: `question noted — ending turn for user input.${tgt} Q: ${question.slice(0, 500)}${opt}` };
          }
          case 'list_terminals': {
            const sessions = getTerminalProjectState(projectId).sessions.slice(0, 8);
            if (!sessions.length) return { output: 'No terminals open.' };
            return {
              output: sessions
                .map((s) => {
                  const label = (s.agentName?.trim() || s.title || `Terminal ${s.id}`).slice(0, 40);
                  const state = s.isRunning ? (s.isExecuting ? 'busy' : 'idle') : 'exited';
                  return `- ${label} [${state}]${s.cwd ? ` cwd: ${String(s.cwd).slice(-48)}` : ''}`;
                })
                .join('\n'),
            };
          }
          case 'list_agents': {
            const running = getRunningAgentRefs(projectId);
            const outputs = getAgentOutputRefs(projectId);
            const lines: string[] = [];
            if (running.length) {
              lines.push(`Running (${running.length}):`);
              for (const r of running.slice(0, 6)) {
                lines.push(`- "${(r.name ?? r.agent).slice(0, 32)}" [${r.agent}] — ${r.title.slice(0, 100)}`);
              }
            } else lines.push('Running: none');
            if (outputs.length) {
              lines.push(`Recent status (${outputs.length}):`);
              for (const o of outputs.slice(0, 6)) {
                lines.push(`- "${(o.name ?? o.agent).slice(0, 32)}" [${o.status}] — ${o.title.slice(0, 100)}${o.reason ? ` (${o.reason.slice(0, 90)})` : ''}`);
              }
            }
            return { output: lines.join('\n') };
          }
          case 'get_agent_output': {
            const name = toolArgStr(call.args, 'name');
            if (!name) return { output: 'error: missing "name" argument.' };
            const outputs = getAgentOutputRefs(projectId);
            const hit =
              outputs.find((o) => (o.name ?? '').toLowerCase() === name.toLowerCase()) ??
              outputs.find((o) => (o.name ?? '').toLowerCase().includes(name.toLowerCase()));
            if (hit?.recentOutput?.trim()) {
              return { output: `"${hit.name ?? hit.agent}" [${hit.status}] — ${hit.title}\n${hit.recentOutput.trim().slice(-3000)}` };
            }
            const read = readAgentTranscriptFor(projectId, name);
            if (read?.text.trim()) return { output: `"${read.name}":\n${read.text.slice(-3000)}` };
            return { output: `No output found for "${name}".` };
          }
          case 'update_todos': {
            // The model SETS plan state here; the runtime records it rather
            // than second-guessing content. It still enforces SHAPE: the list
            // stays small and grouped (the tool contract asks for 3-6 items),
            // so a disobedient model cannot flood the ticker with one row per
            // sub-check. Items only count as finished in the final card when
            // tool evidence exists (Phase 4 guard).
            const entries = toolArgStrArr(call.args, 'todos');
            if (!entries.length) return { output: 'error: missing "todos" argument (one entry per task).' };
            const parsed = entries
              .map((entry) => {
                const { status, text } = todoMarkerStatus(entry);
                const label = text.length > 120 ? `${text.slice(0, 119)}…` : text;
                if (!label) return null;
                return { label, done: todoIsDone(status, false), ...(status ? { status } : {}) } as ChatTurnTodoItem;
              })
              .filter((item): item is ChatTurnTodoItem => Boolean(item));
            if (!parsed.length) return { output: 'error: every todo entry was empty after removing status markers.' };
            let planNote = '';
            if (chatThreadId) {
              // The FIRST call of a turn establishes the authoritative plan.
              // Once that plan has real shape, every later call must re-state
              // it. A call that silently omits unfinished work is ambiguous —
              // a paraphrase the matcher missed, a real removal, or a forgotten
              // row — and guessing is what left the ticker with a partial plan
              // that grew by one near-duplicate row at a time. So the runtime
              // asks for the complete list instead. One-shot: the second
              // offense falls through to the sticky merge below, so a stubborn
              // model can cost a round but never deadlock the turn.
              if (!planResendRequested) {
                const omitted = findOmittedPlanItems(turnTodos, parsed);
                if (omitted.length > 0) {
                  planResendRequested = true;
                  return { output: `error: this plan update omitted ${omitted.length} unfinished item(s) — ${omitted.map((o) => o.label).join('; ')}. The plan is authoritative: re-send the COMPLETE list, repeating every unfinished item and changing only its status markers.` };
                }
              }
              // Sticky merge: the model re-announcing its plan must not churn
              // the ticker or grow it with paraphrases — mergeTodoItems folds
              // near-duplicate retellings into the existing row.
              const mergedPlan = mergeTodoItems(turnTodos, parsed);
              turnTodos = mergedPlan.todos;
              setChatTurnTicker(chatThreadId, turnTodos);
              if (mergedPlan.truncated) {
                planNote = ` Note: the plan is at its ${MAX_PLAN_ITEMS}-item ceiling; finish or cancel items before adding more.`;
              }
            }
            const inProgress = parsed.filter((item) => item.status === 'in_progress').length;
            const hint = inProgress > 1 ? ' Note: keep exactly one item in_progress.' : '';
            return { output: `Recorded ${parsed.length} todo items (${parsed.filter((i) => i.status === 'completed').length} completed).${hint}${planNote}` };
          }
          case 'ask_user':
            return { output: 'question noted — ending turn for user input.' };
          default:
            return { output: `error: unknown tool "${(call as { name: string }).name}".` };
        }
      };
      const executeToolWithActivity = async (call: BrainToolCall): Promise<{ output: string; actions?: OrchestratorAction[] }> => {
        checkActive();
        // update_todos mutates only turn-local plan state, not the workspace,
        // so it is available in every profile and never needs approval.
        const mutating = ['write_file', 'save_document', 'edit_file', 'run_command', 'cancel_command'].includes(call.name);
        if (call.name === 'update_todos') {
          // Plan bookkeeping, not workspace work: its state renders live in
          // the ticker, so it takes no transcript activity card.
          return executeTool(call);
        }
        if (mutating && !rootPath) return { output: 'error: no active project directory.' };
        if (mutating && mutationDeclined) return { output: 'error: user declined changes this turn. Stop; do not attempt an equivalent operation.' };
        if (mutating && (opts?.accessMode ?? chatThread?.accessMode) !== 'full-access') {
          if (!chatThreadId) return { output: 'error: this operation requires Full access or approval in Chat.' };
          const approvalId = `brain-approval-${msgId()}`;
          const messageId = msgId();
          const approved = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => finish(false), 10 * 60 * 1000);
            const finish = (value: boolean) => {
              clearTimeout(timeout);
              brainApprovals.delete(approvalId);
              patchChat(projectId, messageId, { inlineRequest: null, text: value ? 'Operation approved.' : 'Operation declined or approval expired.', pending: false });
              resolve(value);
            };
            controller.signal.addEventListener('abort', () => finish(false), { once: true });
            brainApprovals.set(approvalId, finish);
            appendChat(projectId, { id: messageId, role: 'assistant', type: 'approval', text: '', ts: Date.now(),
              inlineRequest: { id: approvalId, type: 'approval', prompt: `Allow this operation?\n\n${call.name}\n\n\`\`\`json\n${JSON.stringify(call.args, null, 2)}\n\`\`\``, options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Decline' }] } }, chatThreadId);
          });
          if (!approved || !getChatThread(chatThreadId)) {
            mutationDeclined = true;
            return { output: 'error: operation not approved. Do not retry it or execute an equivalent operation.' };
          }
        }
        const activityId = msgId();
        const label = `${call.name}: ${toolArgStr(call.args, 'path') || toolArgStr(call.args, 'command') || toolArgStr(call.args, 'query') || toolArgStr(call.args, 'name') || toolArgStr(call.args, 'pattern') || (call.name === 'read_project' ? 'active project' : '')}`;
        appendChat(projectId, { id: activityId, role: 'assistant', type: 'activity', text: label, pending: true, ts: Date.now() }, chatThreadId);
        try {
          checkActive();
          const result = await executeTool(call);
          if (mutating) projectReadCache.clear();
          const activityCap = call.name === 'read_project' ? BRAIN_REVIEW_OUTPUT_CAP : BRAIN_TOOL_OUTPUT_CAP;
          patchChat(projectId, activityId, { text: `${label}\n\n${result.output.slice(0, activityCap)}`, pending: false });
          if (chatThreadId) updateChatThread(chatThreadId, { status: 'working' });
          return result;
        } catch (error) {
          patchChat(projectId, activityId, { text: `${label}\n\nFailed: ${String(error)}`, pending: false });
          throw error;
        }
      };
      const toolExecutor = async (call: BrainToolCall): Promise<{ output: string; actions?: OrchestratorAction[] }> => {
        checkActive();
        const cacheKey = ['read_project', 'read_file', 'glob_files', 'grep_code'].includes(call.name) ? `${call.name}:${JSON.stringify(call.args)}` : null;
        if (!cacheKey) return executeToolWithActivity(call);
        const cached = projectReadCache.get(cacheKey);
        if (cached) return cached;
        const execution = executeToolWithActivity(call);
        projectReadCache.set(cacheKey, execution);
        void execution.then(r => { if (r.output.startsWith('error:')) projectReadCache.delete(cacheKey); }, () => projectReadCache.delete(cacheKey));
        return execution;
      };
      try {
      while (true) {
        checkActive();
        if (projectTree === null) {
          // Project trees rarely change between consecutive turns; cache the
          // last walk per project root (30 s TTL) so a follow-up turn doesn't
          // pay a fresh recursive directory scan before its first LLM call.
          const cachedTree = projectTreeCache.get(rootPath);
          if (cachedTree && Date.now() - cachedTree.builtAt < 30_000) {
            projectTree = cachedTree.tree;
          } else {
            try {
              projectTree = (await buildProjectTree(rootPath)).trim() || '(empty project)';
            } catch {
              projectTree = '(could not read project structure)';
            }
            projectTreeCache.set(rootPath, { tree: projectTree, builtAt: Date.now() });
          }
        }
        const routed = await routeOrchestratorRequest(promptText, agents, {
          projectName: opts?.projectName,
          projectRoot: rootPath,
          recentUserMessages,
          conversation,
          taskMemory,
          taskPanel,
          mailbox: mailboxLines,
          knowledge: knowledgeLines,
          runningAgents: getRunningAgentRefs(projectId),
          reviewingAgents: getReviewableAgentRefs(projectId),
          taskOutputs: getAgentOutputRefs(projectId),
          readAgentTranscript: (request) => readAgentTranscriptFor(projectId, request),
          profile: getProfileLines(projectId),
          appState: getAppContextSnapshot(projectId, rootPath),
          llmConfig,
          conversational: conversationalMode,
          projectTree,
          projectReads,
          documentsIndex: rootPath ? await readDocumentsIndexForBrain(rootPath) ?? undefined : undefined,
          toolExecutor,
          // Capability profile for this turn: chat threads inherit their access
          // mode, and conversational/voice turns stay read-only by default.
          // 'ask' removes every mutating tool from the turn physically.
          toolProfile: ((): BrainMode => {
            const mode = opts?.accessMode ?? chatThread?.accessMode;
            if (mode === 'full-access' || mode === 'auto' || mode === 'auto-edits') return 'full';
            if (conversationalMode) return 'ask';
            // Default chat turns keep the brain's full toolkit (it is approval-
            // gated per mutation); 'supervised'/'inherit' behave identically here.
            return 'full';
          })(),
          onToolRound: (results) => recordTurnProgress(results),
          // The turn's plan has exactly ONE surface: the live ticker above the
          // composer, owned exclusively by the model's update_todos calls. The
          // narration-derived plan card that used to sit in Work details is
          // gone — it was a second, disagreeing copy of the same plan, and it
          // is what overpopulated the list with near-duplicate retellings (the
          // 24-item screenshot bug).
          signal: controller.signal,
          nativeTools: true,
          checkpoint: chatThread?.agentCheckpoint ?? (chatThreadId ? await loadAgentCheckpoint(chatThreadId) : undefined),
          budgets: chatThread?.agentBudgets,
          saveCheckpoint: async state => { if (chatThreadId && getChatThread(chatThreadId)) { await saveAgentCheckpoint(chatThreadId, state, () => Boolean(getChatThread(chatThreadId))); updateChatThread(chatThreadId, { agentCheckpoint: state }); } },
        });
        if (rootPath && routed.readFiles?.length && readRounds < MAX_READ_ROUNDS) {
          readRounds += 1;
          patchChat(projectId, assistantId, { text: 'Reading the project files you asked about…' });
          const reads = await readProjectFilesForContext(routed.readFiles, rootPath);
          projectReads.push(...reads);
          continue;
        }
        // Safety net: the FIRST routing pass answered with only a bare
        // acknowledgement (no readFiles, no actions) to a substantive request —
        // e.g. "go through the project and report back" came back as
        // "Absolutely, I'll help you…" and nothing else. Auto-read high-signal
        // project files and give it one more round with real source to
        // summarize, so a promise is turned into an actual answer instead of a
        // dead-ended reply. Only fires when nothing has been read yet: once the
        // model is actively reading, it is already working the question.
        if (
          rootPath &&
          projectTree &&
          projectTree !== '(empty project)' &&
          projectTree !== '(could not read project structure)' &&
          readRounds === 0 &&
          routed.actions.length === 0 &&
          !routed.readFiles?.length &&
          !routed.needsInput && (isPromiseOnlyReply(routed.reply) || isDeferredCompletionReply(routed.reply)) && !isConversationalChatter(promptText)
        ) {
          const overviewFiles = pickProjectOverviewFiles(projectTree.split('\n'));
          const neverRead = overviewFiles.filter(
            (path) => !projectReads.some((existing) => existing.path === path)
          );
          if (neverRead.length) {
            readRounds += 1;
            patchChat(projectId, assistantId, { text: `Reading the project files to answer you…` });
            const reads = await readProjectFilesForContext(neverRead, rootPath);
            projectReads.push(...reads);
            continue;
          }
        }
        if (!routed.actions.length && !routed.needsInput && (isPromiseOnlyReply(routed.reply) || isDeferredCompletionReply(routed.reply))) {
          return { ...routed, reply: 'I could not complete that request: the model returned a promise instead of a result. Please retry.', failed: true };
        }
        return routed;
      }
      } finally { activeBrainTurns.delete(turnKey); }
    };
    try {
      result = await routeWithProjectReads();
    } catch (err) {
      // A user stop (or queue-steering interrupt) aborts this signal on
      // purpose: the turn ends silently instead of scaring the user with an
      // error bubble, and the queue's drain loop starts the next message.
      // throwIfAborted surfaces as AbortError; backend cancels mention abort too.
      const aborted = String(err ?? '').toLowerCase().includes('abort');
      if (aborted) {
        result = { reply: '', actions: [], viaLLM: false, failed: true };
        // The steered/stopped turn never answered: drop its empty pending
        // bubble instead of leaving a blank row in the transcript.
        removeThreadMessage(chatThreadId ?? '', assistantId);
        if (chatThreadId) {
          clearChatTurnTicker(chatThreadId);
          updateChatThread(chatThreadId, { turnEndedAt: Date.now(), status: 'idle' as ChatThreadStatus });
        }
      } else {
        console.error('Orchestrator routing error:', err);
        result = { reply: 'Something went wrong routing that. Try again.', actions: [], viaLLM: false };
        if (chatThreadId) {
          clearChatTurnTicker(chatThreadId);
          updateChatThread(chatThreadId, { turnEndedAt: Date.now() });
        }
      }
    }
  }

  if (chatThreadId && !getChatThread(chatThreadId)) return;
  // Never pair executing actions with a "want me to?" reply — the actions run
  // right below, so the reply must state what's happening, not ask permission.
  if (result.actions.length) {
    const selectedModel = selectedAgent ? opts?.model?.trim() : undefined;
    result = {
      ...result,
      reply: cleanOrchestratorReply(declarativeReply(result.actions, result.reply)),
      actions: selectedModel && selectedAgent
        ? result.actions.map((action) => action.kind === 'spawn' && action.agent === selectedAgent
          ? { ...action, model: selectedModel }
          : action)
        : result.actions,
    };
  } else {
    result = {
      ...result,
      reply: cleanOrchestratorReply(result.reply),
    };
  }

  // A steered/stopped turn leaves no error bubble behind: its pending row was
  // already removed in the abort path above.
  if (result.reply || result.actions.length || !result.failed) {
    patchChat(projectId, assistantId, { text: result.reply, pending: false });
    if (chatThreadId) moveThreadMessageToEnd(chatThreadId, assistantId);
  }
  if (result.failed && chatThreadId) updateChatThread(chatThreadId, { status: 'failed' });

  // Clarifying questions in conversational mode surface above the Composer.
  if (
    conversationalMode
    && chatThreadId
    && !opts?.voiceConversation
    && result.actions.length === 0
    && looksLikeBlockingQuestion(result.reply, result.needsInput === true)
  ) {
    const inlineRequest: ChatInlineRequest = {
      id: `clarify-${assistantId}`,
      type: result.inputRequest?.options.length ? 'choice' : 'text',
      prompt: result.inputRequest?.question ?? result.reply,
      options: result.inputRequest?.options.map((label, index) => ({ id: String(index + 1), label })),
      taskId: result.inputRequest?.target ? resolveRunningTaskByName(projectId, result.inputRequest.target)?.id : undefined,
      sessionId: result.inputRequest?.target ? resolveRunningTaskByName(projectId, result.inputRequest.target)?.assignedSessionId : undefined,
      placeholder: 'Type your answer…',
    };
    patchChat(projectId, assistantId, {
      type: 'input',
      inlineRequest,
    });
    updateChatThread(chatThreadId, {
      status: 'needs-input',
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    return;
  }

  const newAgentWork = result.actions
    .filter((action) => action.kind === 'spawn' || action.kind === 'send')
    .map((action) => action.prompt ?? '')
    .filter(Boolean);
  if (newAgentWork.length && await estimateFileOverlap(newAgentWork.join('\n'), getRunningAgentRefs(projectId))) {
    showToast('Possible file overlap with a running agent. Check task ownership before editing.', 'warning', 6000);
  }

  // ── Placement: explicit in the request, or the focused placement dialog ───
  // Placement is important information whenever the orchestrator is about to
  // start an agent: it changes where edits land and whether parallel work is
  // safe. Ask in text Chat as well as the legacy CLI path, while preserving
  // explicit placement the user already stated in their request. Voice keeps
  // its spoken question below because a modal cannot be used hands-free.
  const plannedSpawns = result.actions.filter(
    (action): action is Extract<OrchestratorAction, { kind: 'spawn' }> => action.kind === 'spawn'
  );
  // A placement the user SAID ("open Claude Code in a worktree, another in the
  // main repo") is the answer — asking again would be pure friction. Only the
  // spawns they left unstated need the question.
  const undecidedSpawns = plannedSpawns.filter((action) => !action.placement);
  const agentLabel = (action: (typeof plannedSpawns)[number]) =>
    action.name?.trim() || getAgentDisplayName(action.agent) || action.agent;

  let askedPlacements: AgentPlacement[] | null = null;
  let spawnsAllowed = true;

  const adminSpawn = undecidedSpawns.some(
    (action) => action.skipWorktree === true || (!!action.prompt && ADMIN_KEYWORD_RE.test(action.prompt))
  );

  if (undecidedSpawns.length && opts?.voiceConversation) {
    // Voice is hands-free: a modal nobody can click would strand the whole
    // conversation. Ask out loud instead and spawn NOTHING this turn — the
    // user's next utterance ("worktree") re-issues the plan with `placement`
    // set (see the follow-up rule in the brain's system prompt). The entire
    // dispatch is held, not just the unstated spawns, so answering can't
    // double-spawn the ones that were already decided.
    spawnsAllowed = false;
    const who =
      undecidedSpawns.length === 1
        ? agentLabel(undecidedSpawns[0])
        : `${undecidedSpawns.length} agents`;
    patchChat(projectId, assistantId, {
      text: `Where should ${who} run: an isolated worktree, or the main repo?`,
    });
  } else if (undecidedSpawns.length) {
    // The admin/release heuristic no longer decides — it only pre-selects "Main
    // repo" and explains why, since git tag/push can't work from a worktree.
    // This same focused question is used by conversational Chat. That keeps
    // normal messages friction-free while preventing a hidden worktree default
    // from breaking projects that are not Git repositories (or have no commit).
    askedPlacements = await requestAgentPlacement({
      agents: undecidedSpawns.map(agentLabel),
      source: 'orchestrator',
      suggested: adminSpawn ? 'main' : undefined,
      suggestionReason: adminSpawn
        ? 'This reads like a release or admin task (tagging, pushing, version bumps). Those need the main branch, because git tag and push do not work from a worktree.'
        : null,
      projectId,
      threadId: chatThreadId,
    });
    if (!askedPlacements) {
      spawnsAllowed = false;
      patchChat(projectId, assistantId, {
        text: `${result.reply}\n\n_Cancelled. No agent was started._`,
      });
      showToast('Spawn cancelled', 'info', 2500);
    }
  }

  await executeRoutedOrchestratorPlan({
    projectId,
    rootPath,
    result,
    assistantId,
    chatThreadId,
    chatMode,
    conversationalMode,
    opts: opts ?? {},
    askedPlacements,
    spawnsAllowed,
    userMessage: trimmed,
    llmConfig,
    selectedAgent: selectedAgent ?? undefined,
    turnEvidence,
    turnTodos,
  });
}

/**
 * Resend an edited user bubble in place: the edited bubble keeps its position,
 * everything from it onwards (the stale reply plus any later turns built on
 * it) is discarded, and a fresh turn runs from the edited text. The new
 * response therefore overwrites the previous response instead of appearing
 * alongside a duplicate user message at the end of the transcript.
 *
 * The actual removal happens inside `sendChatMessage` (via `resendFromMessageId`),
 * atomically with the new turn's appends, so the transcript never paints the
 * shrunken intermediate state. Returns how many later messages were discarded,
 * or null when the resend did not run (unknown thread/message, non-user
 * message, or empty/unchanged text).
 */
export async function resendEditedChatMessage(
  projectId: string,
  rootPath: string,
  threadId: string,
  messageId: string,
  newText: string,
  opts?: SendChatOpts,
): Promise<{ removedLaterCount: number } | null> {
  const trimmed = newText.trim();
  if (!trimmed || !projectId) return null;
  const thread = getChatThread(threadId);
  if (!thread || thread.projectId !== projectId) return null;
  const snapshot = getThreadMessageSnapshot(threadId);
  const index = snapshot.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const original = snapshot[index];
  if (original.role !== 'user') return null;
  if (trimmed === original.text.trim()) return null;

  const attachments = opts?.attachments
    ?? (original as { attachments?: ChatAttachment[] }).attachments?.map(({ previewUrl: _preview, ...rest }) => rest)
    ?? [];

  await sendChatMessage(projectId, rootPath, trimmed, {
    ...opts,
    threadId,
    attachments,
    resendFromMessageId: messageId,
  });
  return { removedLaterCount: Math.max(0, snapshot.length - 1 - index) };
}

/**
 * A chat turn whose brain work was interrupted (Stop, reload, crash) leaves an
 * execution checkpoint behind. This reports whether that checkpoint is stale:
 * a checkpoint exists AND no brain turn is currently active for the thread.
 * While a turn runs, the checkpoint is the live loop's state, not debris —
 * offering resume then would fight the running turn.
 */
export function hasResumableTurn(threadId: string): boolean {
  const thread = getChatThread(threadId);
  return Boolean(
    thread?.agentCheckpoint
    && thread.agentCheckpoint.exchanges.length > 0
    // A checkpoint saved by a turn that ENDED normally is conversation
    // memory, not interrupted work. Only a turn that failed, was stopped,
    // or never reached its end (reload/crash) leaves a resumable checkpoint.
    && !thread.turnEndedAt
    && thread.status !== 'needs-input'
    && !activeBrainTurns.has(threadId)
  );
}

/**
 * Continue interrupted orchestrator work: re-enters the normal chat pipeline
 * with an explicit user message. The transport constructor accepts the saved
 * checkpoint, so the model sees its own prior exchanges and tool evidence;
 * pending mutations were already converted to "outcome unknown — do not
 * replay" at checkpoint load, so resume cannot duplicate them.
 */
export async function resumeOrchestratorTurn(
  projectId: string,
  rootPath: string,
  threadId: string,
  opts?: SendChatOpts,
): Promise<void> {
  const thread = getChatThread(threadId);
  if (!thread || thread.projectId !== projectId) return;
  if (!hasResumableTurn(threadId)) return;
  updateChatThread(threadId, { turnEndedAt: undefined });
  await sendChatMessage(projectId, rootPath, 'Continue the interrupted work from your saved execution state. Do not repeat completed steps; finish the remaining work and deliver the result.', {
    ...opts,
    threadId,
  });
}

/** Drop a stale checkpoint without starting anything (dismiss the resume card). */
export function dismissResumableTurn(threadId: string): void {
  const thread = getChatThread(threadId);
  if (!thread?.agentCheckpoint) return;
  updateChatThread(threadId, { agentCheckpoint: undefined });
  void deleteAgentCheckpoint(threadId).catch(() => {});
}

async function executeRoutedOrchestratorPlan(args: {
  projectId: string;
  rootPath: string;
  result: RouteResult;
  assistantId: string;
  chatThreadId?: string;
  chatMode: boolean;
  conversationalMode: boolean;
  opts: SendChatOpts;
  askedPlacements: AgentPlacement[] | null;
  spawnsAllowed: boolean;
  userMessage: string;
  llmConfig?: RouteLlmConfig;
  selectedAgent?: string;
  turnEvidence?: BrainToolResult[];
  turnTodos?: ChatTurnTodoItem[];
}): Promise<void> {
  let {
    projectId,
    rootPath,
    result,
    assistantId,
    chatThreadId,
    chatMode,
    opts,
    askedPlacements,
    spawnsAllowed,
    userMessage,
    selectedAgent,
    turnEvidence = [],
    turnTodos = [],
  } = args;
  const llmConfig = args.llmConfig ?? await resolveConversationLlmConfig({
    provider: opts.orchestratorProvider,
    model: opts.orchestratorModel,
    sessionId: chatThreadId,
  });

  const plannedSpawns = result.actions.filter(
    (action): action is Extract<OrchestratorAction, { kind: 'spawn' }> => action.kind === 'spawn'
  );
  const undecidedSpawns = plannedSpawns.filter((action) => !action.placement);

  /**
   * Where one spawn action runs: what the user stated, else what they answered
   * in the dialog. Both lookups are keyed by action IDENTITY rather than a
   * running counter — the loop below can `continue` past a spawn (a file-claim
   * conflict), which would slide every later agent onto the wrong answer.
   */
  const placementFor = (action: OrchestratorAction): AgentPlacement => {
    const spawn = action as (typeof plannedSpawns)[number];
    if (spawn.placement) return spawn.placement;
    return askedPlacements?.[undecidedSpawns.indexOf(spawn)] ?? defaultAgentPlacement();
  };

  // ── Reconnaissance (started now, awaited after spawning) ──────────────────
  // Kick recon off immediately so its LLM calls (plan + craft) overlap with the
  // terminal spawn loop below. Previously recon ran strictly after every launch
  // had been awaited, so the two latencies stacked; now they run concurrently.
  // Nothing to reconnoitre for if the user just cancelled every spawn.
  const reconCommand = spawnsAllowed
    ? result.actions
        .flatMap((a) =>
          a.kind === 'spawn' && (a.prompt ?? '').trim().length > 10 ? [a.prompt as string] : []
        )
        .join('; ')
    : '';
  let reconPromise: ReturnType<typeof reconnoiter> | null = null;
  if (reconCommand && rootPath) {
    patchChat(projectId, assistantId, { text: result.reply + '\n\n🔍 Analyzing codebase…' });
    reconPromise = reconnoiter(
      reconCommand,
      rootPath,
      opts.projectName ?? 'project',
      async (sysPrompt, userText) => {
        const { provider, model, hasApiKey, baseUrl, sessionId } = llmConfig;
        const local = isLocalProvider(provider);
        if ((!local || baseUrl) && (local || hasApiKey)) {
          return await invoke<string>('ai_complete', {
            systemPrompt: sysPrompt,
            userText,
            provider,
            model,
            apiKey: '',
            baseUrl: baseUrl || undefined,
            sessionId,
          });
        }
        throw new Error('No AI provider configured');
      },
      projectId
    );
  }

  // ── Pre-spawn: start agent terminals (overlaps the recon above) ────────────
  // Terminals begin initializing (PTY, shell, CLAUDE.md load) while the recon
  // LLM calls run, so agent startup time overlaps with codebase analysis.
  const multiSpawn = result.actions.filter((a) => a.kind === 'spawn').length > 1;
  // Avoid name collisions with EVERY live named agent — including ones spawned
  // outside the orchestrator (the floating bar's "+"), which only exist as
  // terminal sessions with an agentName, not as tasks.
  const sessionAgentNames = getTerminalProjectState(projectId).sessions
    .filter((s) => s.isRunning && s.agentName?.trim())
    .map((s) => (s.agentName as string).trim());
  const usedNames = [
    ...getRunningAgentRefs(projectId)
      .map((r) => r.name)
      .filter((n): n is string => !!n),
    ...sessionAgentNames,
  ];
  let spawnIndex = 0;

  interface SpawnEntry {
    task: ReturnType<typeof createOrchestratorTask>;
    sessionId: number | null;
    rawPrompt: string;
    agent: string;
    persistent: boolean;
    watchTurn: boolean;
    name: string;
  }
  const spawnEntries: SpawnEntry[] = [];

  for (const action of result.actions) {
    if (action.kind !== 'spawn' || !spawnsAllowed) continue;
    // The brain sometimes labels a spawn generically ("claude-1") instead of
    // leaving it unnamed; treat those as unnamed so the agent still gets a
    // friendly human name the user can address ("ask Iris…").
    const explicitName =
      action.name && !isGenericAgentName(action.name, action.agent, getAgentDisplayName(action.agent))
        ? action.name
        : null;
    // A *meaningfully* named or task-less spawn is a *persistent* agent:
    // skip the turn watcher so it stays addressable. Persistence keys off a
    // real name, before we apply an auto-name below — an auto-name must
    // not make a one-shot task persistent.
    const persistent = chatMode || !!explicitName || !action.prompt;
    // Every spawned agent gets a friendly human name so it's easy to address.
    const name = explicitName ?? pickAssistantName(usedNames);

    // File ownership: a builder that declared the files it will own is held back
    // if any overlap a claim that is still live (another builder's in-flight
    // work). Worktrees stop physical collisions; this stops logical ones — two
    // agents editing the same file in parallel and conflicting at merge. The
    // Coordinator can re-dispatch once the holder releases (posts done/release).
    const wantedFiles = action.files ?? [];
    if (wantedFiles.length) {
      const conflicts = findClaimConflicts(getProjectMailbox(projectId), wantedFiles);
      if (conflicts.length) {
        const owners = [...new Set(conflicts.map((c) => c.owner))].join(', ');
        const files = [...new Set(conflicts.map((c) => c.file))].slice(0, 3).join(', ');
        void postMailboxMessage(projectId, rootPath, {
          from: ORCHESTRATOR,
          kind: 'note',
          text: `Held ${name}: ${files} still claimed by ${owners}. Will dispatch once released.`,
        });
        showToast(`Holding ${name}, because ${files} is still owned by ${owners}`, 'warning', 6000, true);
        continue;
      }
    }

    usedNames.push(name);
    const isPrimary = spawnIndex === 0;
    spawnIndex++;

    // The user answered the placement dialog above — per agent — and their
    // answer wins over both the brain's `skipWorktree` flag and the
    // admin-keyword heuristic, which only pre-selected what they were shown.
    const skipWorktree = placementFor(action) === 'main';
    const task = createOrchestratorTask(
      projectId,
      action.prompt ?? '',
      action.agent,
      name,
      action.role ?? null,
      skipWorktree,
      action.panelTaskId ?? null
    );
    if (chatThreadId) {
      threadIdByTaskId.set(task.id, chatThreadId);
      syncChatThreadTask(task, chatThreadId);
    }

    // Post the claim so later spawns in this same plan see it as live.
    if (wantedFiles.length) {
      void postMailboxMessage(projectId, rootPath, {
        from: name,
        kind: 'claim',
        taskId: task.id,
        files: wantedFiles,
        text: `Claiming ${wantedFiles.length} file(s) for: ${task.title}`,
      });
    }

    // Spawn terminal now but hold the goal — recon will enrich it before sending.
    const sessionId = await launchOrchestratorTask(task.id, action.agent, rootPath, {
      autoRun: false,
      holdGoal: true,
      activate: !multiSpawn || isPrimary,
      model: action.model,
      accessMode: opts.accessMode === 'full-access' ? 'full-access' : undefined,
      reasoningEffort: action.agent === selectedAgent ? opts.reasoningEffort : undefined,
    });

    if (sessionId == null) {
      // Launch failed (no free terminal pane) — remove the orphaned task record.
      deleteOrchestratorTask(task.id);
      showToast(`Could not start ${getAgentDisplayName(action.agent) ?? action.agent}, because no terminal is available`, 'error', 5000);
    } else if (chatThreadId) {
      const launchedTask = get(orchestratorTasks).find((entry) => entry.id === task.id);
      if (launchedTask) syncChatThreadTask(launchedTask, chatThreadId);
    }

    spawnEntries.push({ task, sessionId, rawPrompt: action.prompt ?? '', agent: action.agent, persistent, watchTurn: !persistent, name });
  }

  // ── Await reconnaissance ──────────────────────────────────────────────────
  // The recon LLM calls were started above and have been running while the
  // terminals spun up. Collect the enriched prompt now, just before dispatch.
  let reconSummary: string | null = null;
  let enrichedPrompt: string | null = null;

  if (reconPromise) {
    try {
      const recon = await reconPromise;
      reconSummary = recon.summary;
      enrichedPrompt = recon.enrichedPrompt || null;

      patchChat(projectId, assistantId, {
        text: result.reply,
        reconSummary: recon.findings.length > 0
          ? `🧠 Gathered context:\n${recon.summary}`
          : null,
      });
    } catch (err) {
      console.warn('Reconnaissance failed (dispatching with raw prompt):', err);
      patchChat(projectId, assistantId, { text: result.reply, reconSummary: null });
    }
  }

  // ── Send goals to pre-spawned agents + handle non-spawn actions ─────────────
  const dispatched: DispatchRef[] = [];

  for (const { task, sessionId, rawPrompt, agent, persistent, watchTurn, name } of spawnEntries) {
    if (sessionId == null) continue;
    const goal = enrichedPrompt ?? rawPrompt;
    if (goal !== rawPrompt) {
      patchTask(task.id, (t) => ({ ...t, goal }));
    }
    if (rawPrompt) {
      sendGoalToLeasedTask(task.id, sessionId, goal, agent, watchTurn, chatMode ? chatThreadId : undefined);
    } else {
      // No task yet (persistent/named agent) — deliver the standing brief so every
      // spawned agent is briefed (a no-op for rules-file agents, already briefed
      // via CLAUDE.md / AGENTS.md), then hand off to the user to drive it.
      sendBriefToLeasedTask(task.id, sessionId, agent, name);
      if (!persistent) {
        promptBarInput.set(goal);
        focusPromptBar();
      }
    }
    dispatched.push({ taskId: task.id, agent, name, via: 'spawn' });
  }

  for (const action of result.actions) {
    if (action.kind === 'send') {
      const target = resolveRunningTaskByName(projectId, action.target);
      if (target && (await sendFollowUpToAgent(target, action.prompt, rootPath))) {
        dispatched.push({ taskId: target.id, agent: target.agentPreset ?? 'agent', name: target.name ?? null, via: 'send' });
      } else {
        showToast(`No running agent named "${action.target}"`, 'warning', 4000);
      }
    } else if (action.kind === 'name') {
      const target = resolveRunningTaskByName(projectId, action.target);
      if (target) renameOrchestratorAgent(target.id, action.name);
      else showToast(`No running agent named "${action.target}"`, 'warning', 4000);
    } else if (action.kind === 'close') {
      const wanted = action.target.trim().toLowerCase();
      if (wanted === 'all' || wanted === 'everything') {
        const running = get(orchestratorTasks).filter(
          (t) => t.projectId === projectId && t.status === 'in-progress' && t.assignedSessionId != null
        );
        if (running.length === 0) showToast('No running agents to close', 'info', 3000);
        for (const t of running) await closeOrchestratorAgent(t.id);
      } else {
        const target = resolveRunningTaskByName(projectId, action.target);
        if (target) await closeOrchestratorAgent(target.id);
        else showToast(`No running agent named "${action.target}"`, 'warning', 4000);
      }
    } else if (
      action.kind === 'navigate' ||
      action.kind === 'open-file' ||
      action.kind === 'close-file' ||
      action.kind === 'preview' ||
      action.kind === 'run' ||
      action.kind === 'task' ||
      action.kind === 'setting' ||
      action.kind === 'layout' ||
      action.kind === 'room'
    ) {
      // APP-control actions: drive the application UI directly (no agent).
      await executeAppAction(action, projectId, rootPath);
    }
  }

  if (dispatched.length) {
    const patch: Partial<ChatMessage> = { dispatched };
    if (reconSummary != null) patch.reconSummary = reconSummary;
    patchChat(projectId, assistantId, patch);
    if (chatThreadId) {
      updateChatThread(chatThreadId, {
        status: 'working',
        updatedAt: Date.now(),
        lastActivityAt: Date.now(),
      });
    }
  }

  // Phase 4 — completion summary + honest status. This point is reached only
  // by turns that finished their pipeline (FINAL reply, or a claimed result).
  // With tool evidence this turn, append a summary derived strictly from that
  // evidence; the thread returns to idle and its checkpoint is demoted to
  // conversation memory so no phantom resume card appears afterwards.
  if (chatThreadId && getChatThread(chatThreadId)) {
    // A checklist may only be folded into the final card when the turn actually
    // executed tools:todos handed back by a FINAL-without-tools response were
    // already stripped in the brain; merging them here would paint every box
    // green for work that never ran (the fake "5/5 done" card).
    // Plan bookkeeping (update_todos) renders state the model itself declared,
    // so it is evidence enough to fold the checklist into the final card — but
    // an all-completed list from a turn that ran NO other tool is the fake
    // "5/5 done" card arriving through the new tool, and is dropped.
    const workEvidence = turnEvidence.some((entry) => entry.ok && entry.name !== 'update_todos');
    const planEvidence = turnTodos.length > 0 && turnEvidence.some((entry) => entry.ok && entry.name === 'update_todos');
    const allSelfDeclaredDone = turnTodos.length > 0 && turnTodos.every((t) => todoIsDone(t.status, t.done));
    if (result.todos?.length && workEvidence) {
      const incoming = parseTodoList('', JSON.stringify({ todos: result.todos }));
      turnTodos = mergeTodoItems(turnTodos, incoming).todos;
    }
    if (turnTodos.length > 0 && !result.failed && (workEvidence || (planEvidence && !allSelfDeclaredDone))) {
      // At a successful turn end with real work evidence the checklist closes
      // out: the model returned its final answer, so pending/in_progress items
      // are finished by that evidence (models routinely forget to re-announce
      // [x] before FINAL, which used to leave a "Working plan" box lingering
      // over a finished turn). Explicitly blocked items stay open — their
      // reason is live state the user must still act on. With plan bookkeeping
      // but NO other tool evidence, model-declared state stays untouched: a
      // turn that ran nothing must not paint itself all-green.
      turnTodos = workEvidence
        ? turnTodos.map((t) => (t.status === 'blocked' ? t : { ...t, done: true }))
        : turnTodos.map((t) => (t.status ? t : { ...t, done: false }));
      advanceChatTurnTicker(chatThreadId, turnTodos);
    } else {
      turnTodos = [];
      clearChatTurnTicker(chatThreadId);
    }
    const summaryText = formatTurnSummary(turnEvidence);
    if (!opts?.voiceConversation) {
      // turnEvidence lets a turn that did work present itself as a structured
      // report (files changed + measured verification) instead of one line.
      patchChat(projectId, assistantId, { text: composeTurnReply(result.reply, summaryText, turnTodos, turnEvidence) });
    }
    updateChatThread(chatThreadId, {
      turnEndedAt: Date.now(),
      // A failed turn keeps its failed status; idle is only the honest rest
      // state for a turn that ended without actions and without a blocker.
      ...(result.actions.length === 0 && !result.needsInput && !result.failed ? { status: 'idle' as ChatThreadStatus } : {}),
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
  }

  // Evolve the brain: fold any durable insight from this turn into the profile.
  // Fire-and-forget — never blocks the reply, and silently no-ops without AI.
  const { provider: rProvider, model: rModel, hasApiKey: rHasKey, baseUrl: rBaseUrl } = llmConfig;
  const rLocal = isLocalProvider(rProvider);
  if ((!rLocal || rBaseUrl) && (rLocal || rHasKey)) {
    void reflectAndEvolve({
      projectId,
      rootPath,
      userMessage,
      reply: result.reply,
      actions: result.actions,
      complete: (systemPrompt, userText) =>
        invoke<string>('ai_complete', {
          systemPrompt,
          userText,
          provider: rProvider,
          model: rModel,
          apiKey: '',
          baseUrl: rBaseUrl || undefined,
        }),
    });
  }
}

/**
 * Adopt an agent CLI the user launched by hand (typed `claude`/`codex`/… into a
 * terminal) so agent mode treats it like one it spawned: visible in the
 * running-agents list the brain routes against, transcript readable for status
 * answers, and addressable for follow-ups / close. Creates a lightweight
 * in-progress task bound to the live session. Adopted tasks are NOT persisted
 * (they vanish with the process) and never claim the `ownerTaskId` brief lease,
 * so the terminal's own auto-brief still delivers the standing charter.
 */
function adoptDetectedAgent(sessionId: number, projectId: string, preset: string): void {
  const session = getTerminalProjectState(projectId).sessions.find((s) => s.id === sessionId);
  if (!session) return;
  adoptLiveAgentSession(projectId, session, preset);
}

/**
 * Adopt an agent started from the Spawn Agents modal.
 *
 * The modal reaches the same `spawnAgentPreset` as everything else, but that
 * function adds the session to `suppressAgentDetection` while it types the
 * command, so the `onAgentDetected` broadcast — the typed-launch path — never
 * fires for it. Modal-spawned agents therefore had no orchestrator task.
 *
 * Reading their output already worked without one: `getRunningAgentRefs` picks
 * up untracked live agent sessions directly and gives the brain a
 * `BRAIN_OUTPUT_TAIL` slice. What a task adds is (a) a turn watcher, the only
 * source of a turn-end cue — otherwise nothing fires until the process exits —
 * and (b) an entry in `getAgentOutputRefs`, which carries status, freshness and
 * a longer tail than the running-agents list.
 *
 * No double-listing: `trackedSessionIds` counts adopted tasks, so the session
 * moves out of the untracked branch of `getRunningAgentRefs` as it gains a task.
 *
 * Safe to call more than once: `adoptLiveAgentSession` returns the existing task
 * when the session is already bound to one. Orchestrator dispatch must NOT call
 * this — it owns its own task and lease (`terminal-lease.ts`).
 */
export function adoptSpawnedAgent(sessionId: number, projectId: string): void {
  const session = getTerminalProjectState(projectId).sessions.find((s) => s.id === sessionId);
  if (!session?.agentPreset || session.ownerTaskId) return;
  adoptLiveAgentSession(projectId, session, session.agentPreset);
}

/**
 * Every agent worktree worth watching, from BOTH ownership paths — the spawn
 * modal keeps its worktree on the terminal session, orchestrator dispatch keeps it
 * on the task (see `.spacron/memory/agent-worktrees.md`). Missing either one is how
 * an agent's work goes unnoticed, so the reconciler is given both.
 *
 * Deliberately keyed off worktrees rather than task status: a `complete` task and a
 * cleared thread both still have a worktree, and both still need staging.
 */
export function trackedWorktrees(): TrackedWorktree[] {
  const byPath = new Map<string, TrackedWorktree>();

  for (const [projectId] of projectPaths) {
    // BOTH ambients. Sessions spawned in the Development ambient live in a
    // separate state map that `getTerminalProjectState` doesn't reach by default
    // (see the store-lookup gotcha in `.spacron/memory/agent-worktrees.md`), so
    // scanning only the normal one silently loses every dev-ambient agent's work.
    for (const isDev of [false, true]) {
      for (const session of getTerminalProjectState(projectId, isDev).sessions) {
        if (!session.worktree) continue;
        byPath.set(session.worktree.path, {
          projectId,
          agentName: session.agentName?.trim() || getAgentDisplayName(session.agentPreset) || 'Agent',
          worktree: session.worktree,
          live: session.isRunning === true,
        });
      }
    }
  }

  for (const task of get(orchestratorTasks)) {
    if (!task.worktree || !projectPaths.has(task.projectId)) continue;
    // A session-owned entry already carries live status; don't downgrade it.
    if (byPath.has(task.worktree.path)) continue;
    const sessionId = task.assignedSessionId ?? task.lastSessionId ?? null;
    const live = sessionId != null && sessionIsRunning(task.projectId, sessionId);
    byPath.set(task.worktree.path, {
      projectId: task.projectId,
      agentName:
        task.name?.trim() ||
        (task.agentPreset ? getAgentDisplayName(task.agentPreset) : null) ||
        'Agent',
      worktree: task.worktree,
      live,
    });
  }

  return [...byPath.values()];
}

/**
 * Write a reconciler result back onto whichever record owns the worktree. Both are
 * updated when both match, so a session-owned worktree that later gets adopted onto
 * a task can't end up with two disagreeing baselines.
 */
function persistWorktreePatch(projectId: string, worktreePath: string, patch: Partial<WorktreeInfo>): void {
  for (const task of get(orchestratorTasks)) {
    if (task.worktree?.path !== worktreePath) continue;
    patchTask(task.id, (t) =>
      t.worktree ? { ...t, worktree: { ...t.worktree, ...patch } } : t
    );
  }
  // Both ambients, for the same reason as `trackedWorktrees`: a dev-ambient
  // session's baseline would otherwise never be written back, so its work would be
  // staged again on every pass.
  for (const isDev of [false, true]) {
    const session = getTerminalProjectState(projectId, isDev).sessions.find(
      (s) => s.worktree?.path === worktreePath
    );
    if (session?.worktree) {
      setSessionWorktree(session.id, { ...session.worktree, ...patch });
      return;
    }
  }
}

/** Whether a session is live, looking in both the normal and Development ambients. */
export function sessionIsRunning(projectId: string, sessionId: number): boolean {
  return [false, true].some((isDev) =>
    getTerminalProjectState(projectId, isDev).sessions.some((s) => s.id === sessionId && s.isRunning)
  );
}

/** Bring one agent's outstanding work into the checkout on demand — the "Bring in" button. */
export async function stageAgentWorktree(projectId: string, worktree: WorktreeInfo): Promise<void> {
  const result = await stageWorktreeNow(projectId, worktree);
  if (result.ok && result.upToDate) {
    // Nothing moved. A green "success" here read as "your changes have arrived"
    // when in fact the press did nothing, so say so plainly and quietly instead.
    showToast(`Nothing new to bring in. ${worktree.branch} is already in your working tree.`, 'info', 4000);
  } else if (result.ok) {
    showToast(result.message, 'success', 6000);
  } else if (result.conflicted) {
    showToast(result.message, 'warning', 12000);
  } else {
    showToast(`Couldn't bring the changes in: ${result.message}`, 'error', 8000);
  }
  void cleanupStaleWorktrees(projectId);
  void reconcileNow();
}

/**
 * Record that a worktree's branch has been merged into the checkout.
 *
 * Merging leaves `lastStagedCommit` untouched, so the reconciler still sees the
 * whole merged range as outstanding, auto-stages it straight back in, and toasts
 * "N file changes are in Source Control" seconds after a merge the user already
 * completed. Advancing the marker to the merged tip is what makes the reconciler
 * agree that the work has landed.
 */
export function markWorktreeMerged(
  projectId: string,
  worktree: WorktreeInfo,
  mergedCommit: string,
): void {
  if (!mergedCommit.trim()) return;
  persistWorktreePatch(projectId, worktree.path, {
    lastStagedCommit: mergedCommit,
    stageConflict: false,
  });
  forgetWorktree(worktree.path);
  void cleanupStaleWorktrees(projectId);
}

if (typeof window !== 'undefined') {
  initWorktreeReconciler({
    list: trackedWorktrees,
    persist: persistWorktreePatch,
    autoStage: () => get(autoStageAgentChanges) !== false,
    // Name the branch from the agent's first real work, Orca-style — "fix login
    // redirect" instead of the spawn-time task label. Best-effort and silent:
    // a rename that git refuses keeps the old name and `renamedFromWork` is set
    // either way so the hook never re-fires. When nothing is nameable yet (the
    // oldest delta is only our own snapshot commit and the file yields no slug)
    // the flag is left unset, so a later sighting — or the next session, since
    // the reconciler's in-memory guard is the only thing that remembers — gets
    // another shot at naming it.
    onFirstWork: async (entry, delta) => {
      const branch = deriveFirstWorkBranch(entry.worktree, {
        file: delta.firstFile ?? null,
        subject: delta.firstSubject ?? null,
      });
      if (!branch) return;
      const renamed = await renameTaskWorktree(entry.projectId, entry.worktree, branch);
      persistWorktreePatch(entry.projectId, entry.worktree.path, {
        renamedFromWork: true,
        ...(renamed ? { branch: renamed } : {}),
      });
    },
    onStaged: (work, stagedFiles) => {
      showToast(
        `${work.agentName}'s ${stagedFiles} file change${stagedFiles === 1 ? '' : 's'} are in Source Control and ready to test`,
        'success',
        6000,
      );
    },
    onConflict: (work, message) => {
      showToast(`${work.agentName}: ${message}`, 'warning', 14000, true);
    },
    // Auto-staging failed for a non-conflict reason — usually the user's own
    // uncommitted edit to a file the agent touched, which blocks the patch until
    // they commit or discard it. Reported once per run of failures, not per retry.
    onError: (work, message) => {
      showToast(`${work.agentName}: ${message}`, 'warning', 14000, true);
    },
  });

  // Periodic orphan sweep + prune: catches worktrees orphaned mid-session (e.g.
  // a crashed agent whose pane-close cleanup never fired), then the branches
  // those removals leave behind.
  const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    for (const [projectId] of projectPaths) {
      void cleanupStaleWorktrees(projectId)
        .then(() => sweepOrphanWorktrees(projectId))
        .then(() => sweepAgentBranchesForProject(projectId))
        .catch(() => {});
    }
  }, PRUNE_INTERVAL_MS);

  // A user typed an agent CLI into a terminal themselves — adopt it so agent
  // mode is aware of it and can read/drive it (see adoptDetectedAgent).
  onAgentDetected(({ sessionId, projectId, preset }) => {
    try { adoptDetectedAgent(sessionId, projectId, preset); }
    catch (err) { console.error('Failed to adopt detected agent:', err); }
  });

  // Process exit is the fallback completion path (covers agents that do exit,
  // crashes, and turns the watcher missed). Driven by the project-independent
  // `onSessionExit` broadcast rather than the `sessions` store, so an agent that
  // exits while its project is in the background is reconciled immediately
  // instead of being stranded in-progress until the user reopens that project.
  onSessionExit(({ sessionId, projectId, code }) => {
    // The session is gone — tear down its agent adapter (clears any poll timers).
    disposeAgentAdapter(sessionId);
    lastAdoptedNudge.delete(sessionId);
    const task = get(orchestratorTasks).find(
      (t) => t.status === 'in-progress' && t.assignedSessionId === sessionId
    );
    if (!task) return;
    // A deliberate close (closeOrchestratorAgent → killSession) removes the
    // session from project state *before* the async pty teardown fires this exit.
    // A natural exit leaves the session in place (flagged isRunning:false). So if
    // the session is already gone, this was an intentional close that the cancel
    // path is handling — don't race it to a "finished" completion.
    const sessionStillPresent = getTerminalProjectState(projectId).sessions.some((s) => s.id === sessionId);
    if (!sessionStillPresent) return;
    // An adopted agent (one the user launched by hand) just exited. Snapshot its
    // output and complete it quietly — no AI summary, but the durable inbox card
    // still lands so the last turn isn't lost to a transient toast.
    if (task.adopted) {
      captureTaskTranscript(task.id, sessionId);
      const updated = patchTask(task.id, (t) => ({ ...transitionTask(t, 'complete'), assignedSessionId: null }));
      if (updated) {
        void handleReviewerVerdict(updated);
      }
      // An adopted agent's worktree lives on the session, not the task, so make
      // sure the task carries it before the reconciler enumerates tasks — that is
      // what keeps this agent's work visible now that its process is gone.
      const exitSession = getTerminalProjectState(projectId).sessions.find((s) => s.id === sessionId);
      const effectiveWorktree = task.worktree ?? exitSession?.worktree ?? null;
      if (effectiveWorktree && projectPaths.has(projectId)) {
        patchTask(task.id, (t) => ({ ...t, worktree: effectiveWorktree }));
        void reconcileNow();
      }
      // If the watcher detected the final turn a beat ago there will already be
      // a done card for it; this exit card is the session ending, a distinct
      // event, so the two rows are correct rather than a double-write. (The
      // leased path avoids this via completeLeasedTask's idempotence guard, but
      // adopted tasks stay in-progress by design.)
      appendAdoptedTurnCard(
        task,
        task.name
          ?? (task.agentPreset ? getAgentDisplayName(task.agentPreset) : null)
          ?? task.agentPreset
          ?? 'Agent',
        // Unknown exit code counts as clean, matching the leased path's
        // `exitCode !== null && exitCode !== 0` convention.
        code != null && code !== 0 ? 'failed' : 'done',
        code != null && code !== 0 ? `Agent process exited with code ${code}.` : null,
        // `exit`, not `declared`: the process ending is an observed fact, but
        // it is NOT a claim that the work is done — a CLI quit with `/exit`
        // exits cleanly too. The card says "exited" rather than "finished".
        'exit',
      );
      return;
    }
    // Distinguish clean exit (code 0 or unknown) from crash (non-zero code) so
    // the task ends up in the right terminal state rather than always showing
    // "complete" for both success and crashes. The terminal layer already raised
    // its own exit notification, so suppress ours here (notify: false).
    const exitCode = code ?? null;
    // A crash is `failed`, not `blocked`. The task already ended up in the right
    // state (classify reads the exit code), but the outcome is what the mailbox
    // note and the completion card are written from, so a crash used to be
    // announced as "needs your input" — sending the user to look for a question
    // the agent never asked. `via: 'declared'` because a process exit is an
    // observed fact, not a guess about what the screen means.
    const outcome: AgentTurnOutcome =
      exitCode !== null && exitCode !== 0
        ? {
            kind: 'failed',
            reason: `Agent process exited with code ${exitCode}.`,
            via: 'exit',
          }
        // `exit`, not `declared`: the process ended, which is a fact, but it is
        // not the agent saying it finished the work — a CLI quit with `/exit`
        // reaches here too. The card says "exited".
        : { kind: 'finished', via: 'exit' };
    completeLeasedTask(task.id, sessionId, outcome, { notify: false, exitCode });
  });
}
