import { writable, get, derived } from '$lib/stores/storeCompat';
import { useOrchestratorStore } from './zustand/orchestrator';
import { invoke } from '@tauri-apps/api/core';
import { backendInvoke } from '$lib/services/backend';
import { readProjectState } from '$lib/services/project-state';
import { showToast } from '$lib/stores/notification';
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
  type AgentChoice,
  type RouteResult,
  type RouteLlmConfig,
  type AgentOutputRef,
  type AgentTranscriptRead,
  type RunningAgentRef,
  type OrchestratorAction,
} from '$lib/services/orchestrator-brain';
import { detectAgentAccess, getAgentAccessBlockedMessage } from '$lib/services/agent-access';
import { reconnoiter } from '$lib/services/orchestrator/recon';
import {
  aiProvider,
  currentAiModel,
  currentVoiceConversationAiModel,
  voiceReplyProvider,
  isLocalProvider,
  getProviderBaseUrl,
  announceAgentCompletions,
} from '$lib/stores/settings';
import { isProviderApiKeyConfiguredLocal } from '$lib/services/ai-keychain';
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
import { type AgentTurnOutcome } from '$lib/services/orchestrator/agent-turn-watch';
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
import { requestAgentPlacement, defaultAgentPlacement, type AgentPlacement } from '$lib/stores/agentPlacement';
import { buildAgentCharter, buildAgentTaskMessage, type AgentRole } from '$lib/services/orchestrator/agent-charter';
import { parseReviewerVerdict } from '$lib/services/orchestrator/reviewer-verdict';
import { agentReadsRulesFile } from '$lib/services/orchestrator/agent-rules-file';
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

// projectId → root_path so flushes can write without the full project object.
const projectPaths = new Map<string, string>();

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
    showToast('Task state could not be saved — changes may be lost on restart', 'error', 8000);
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

function isAiAvailable(): boolean {
  const p = get(aiProvider);
  const local = isLocalProvider(p);
  const base = local ? getProviderBaseUrl(p) : '';
  return (!local || !!base) && (local || isProviderApiKeyConfiguredLocal(p));
}

/**
 * The LLM that powers the orchestrator brain. By default uses the main AI
 * provider/model (configured under AI / Models). During a voice conversation
 * it uses the voice reply provider as the brain so both brain and speech
 * share the same provider — except when the reply provider is `'local'`
 * (offline Kokoro TTS), which has no LLM, so we fall back to the main AI
 * provider.
 */
function getConversationLlmConfig(voiceConversation?: boolean): RouteLlmConfig {
  const useReplyProvider = voiceConversation && get(voiceReplyProvider) !== 'local';
  const provider = useReplyProvider ? get(voiceReplyProvider) : get(aiProvider);
  const local = isLocalProvider(provider);
  const baseUrl = local ? getProviderBaseUrl(provider) : '';
  const model = useReplyProvider ? get(currentVoiceConversationAiModel) : get(currentAiModel);
  return { provider, model, hasApiKey: isProviderApiKeyConfiguredLocal(provider), baseUrl };
}

const SUMMARY_TRANSCRIPT_CHARS = 3000;

async function generateTranscriptSummary(
  transcript: string,
  status: CompletionSummary['status']
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
  const p = get(aiProvider);
  const local = isLocalProvider(p);
  const base = local ? getProviderBaseUrl(p) : '';
  const model = get(currentAiModel);
  return await invoke<string>('ai_complete', {
    systemPrompt,
    userText: `Terminal output:\n\n${tail}`,
    provider: p,
    model,
    apiKey: '',
    baseUrl: base || undefined,
  });
}

/**
 * Give a light audible nudge when an agent turn ends — enough to pull the
 * user's attention, not a spoken report. Outside voice mode this is a soft
 * status-flavored chime (no TTS provider needed); during a live realtime voice
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
    // With a realtime engine, inject the update into the live call so the model
    // mentions it in its own voice. With the pipeline engine
    // (announceViaRealtimeVoice returns false), also play a nudge so the user
    // gets an audible signal even though the auto-speak effect handles the reply.
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
    text: `Bounced back — ${feedback}`,
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
          logTaskActivity(handoff.taskId, 'info', 'Bounced back by Reviewer — redoing work');
          redelivered = true;
        } catch (err) {
          console.warn('Failed to re-engage Builder after bounce-back:', err);
        }
      }
    }
  }

  showToast(
    redelivered
      ? `Reviewer bounced back to ${handoff.from} — redoing work now`
      : `Reviewer bounced back to ${handoff.from} — ${feedback.slice(0, 80)}`,
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
    showToast(`Reviewer approved but ${handoff.from} had no worktree — nothing to merge`, 'info', 6000);
    return;
  }

  // The Reviewer names the branch it approved. Merging a DIFFERENT branch than
  // the one that was reviewed would defeat the point of the gate, so require
  // them to agree before touching git.
  if (approvedBranch !== worktree.branch) {
    logTaskActivity(
      task.id,
      'blocked',
      `Approval named branch '${approvedBranch}' but the handoff's worktree is '${worktree.branch}' — not merging.`,
    );
    showToast(
      `Reviewer approved '${approvedBranch}' but ${handoff.from} is on '${worktree.branch}' — merge skipped, review manually`,
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
        ? `Branch ${worktree.branch} held nothing new — approved, worktree cleaned up`
        : `Auto-merged branch ${worktree.branch} after approval`;
      logTaskActivity(task.id, 'info', what);
      logTaskActivity(handoff.taskId, 'info', what);
      showToast(
        result.alreadyUpToDate
          ? `Approved — ${handoff.from}'s branch held nothing to merge`
          : `Approved & merged — ${handoff.from}'s branch merged into main`,
        result.alreadyUpToDate ? 'info' : 'success',
        8000,
        !result.alreadyUpToDate,
      );
    } else if (result.conflicted) {
      showToast(`Merge conflict on approval — ${result.message}`, 'warning', 10000, true);
    } else {
      showToast(`Merge failed on approval — ${result.message}`, 'error', 8000, true);
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
    await postMailboxMessage(task.projectId, rootPath, {
      from,
      kind: 'done',
      taskId: task.id,
      text: `Finished: ${label}`,
    });
    // Bi-directional handoff: a Builder that just finished hands its work to a
    // Reviewer directly — no user relay. The Reviewer gates it and either merges
    // or bounces it back with a note. Only fires when a reviewer is on the team.
    if (task.role === 'builder') {
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
      text: `Blocked on ${label} — ${outcome.kind === 'blocked' ? outcome.reason : 'needs input'}`,
    });
  } else if (task.status === 'failed') {
    await postMailboxMessage(task.projectId, projectPaths.get(task.projectId), {
      from,
      kind: 'note',
      taskId: task.id,
      text: `Failed on ${label} — ${task.failureReason ?? 'exited with errors'}`,
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
    delivered ? `Sent to ${card.from}` : `Noted — ${card.from} isn't live right now`,
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
  const delivered = await deliverMailboxReply(projectId, card, 'Approved — please proceed.', rootPath);
  showToast(
    delivered ? `Approved · told ${card.from} to proceed` : `Approved — ${card.from} isn't live right now`,
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
          showToast(`Merge conflict — resolve then approve: ${result.message}`, 'warning', 10000);
          return; // Don't approve if there's a conflict
        } else {
          showToast(`Merge failed — ${result.message}`, 'error', 8000);
          return; // Don't approve if merge failed
        }
      } catch (err) {
        showToast(`Merge failed: ${err}`, 'error', 8000);
        return;
      }
    }
  }

  // 2. Send the approval to the agent.
  const delivered = await deliverMailboxReply(projectId, card, 'Approved — please proceed.', rootPath);
  showToast(
    merged
      ? `Merged & approved · told ${card.from} to proceed`
      : delivered
        ? `Approved · told ${card.from} to proceed`
        : `Approved — ${card.from} isn't live right now`,
    merged || delivered ? 'success' : 'info',
    3000,
  );
}

/**
 * Reclaim the worktrees of agents that are finished and fully staged, after a
 * successful commit in Source Control.
 *
 * Two rules, both learned the hard way:
 *
 * 1. **Only agents that are actually gone.** A live agent keeps its worktree —
 *    that is its working directory. Deleting it out from under a running process
 *    breaks the agent, and on Windows can't even fully succeed, leaving an
 *    orphaned directory behind.
 * 2. **Only when git says nothing is outstanding.** `reclaimWorktree` stages any
 *    remainder and re-checks before deleting. An earlier version keyed off a
 *    sticky `worktreeStaged` boolean, so committing one agent's work force-deleted
 *    branches still holding work nobody had reviewed — unrecoverable.
 *
 * Returns how many worktrees it attempted, so the caller knows whether the main
 * checkout may have moved underneath it. Reclaiming stages any remainder into the
 * index, so a non-zero result means a displayed git status is now stale. Zero —
 * the common case, no finished agents — means nothing was touched and no refresh
 * is warranted.
 */
export async function cleanupStaleWorktrees(projectId: string): Promise<number> {
  const finished = new Set(['complete', 'failed', 'cancelled']);
  const tasks = get(orchestratorTasks).filter(
    (t) => t.projectId === projectId && t.worktree && finished.has(t.status) && !agentSessionLive(t)
  );
  let attempted = 0;
  for (const task of tasks) {
    if (!task.worktree) continue;
    attempted += 1;
    const outcome = await reclaimWorktree(projectId, task.worktree, { deleteBranch: true });
    if (outcome.removed) {
      forgetWorktree(task.worktree.path);
      patchTask(task.id, (t) => ({ ...t, worktree: null }));
    }
    // Not removed → it still holds work (or needs a conflict resolved). Leave it
    // alone; the Agent changes list is already showing it.
  }
  return attempted;
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
      note: blocked ? outcome.reason : undefined,
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
      logTaskActivity(taskId, 'finished', 'Finished its turn.');
    }
    const rememberedTask = get(orchestratorTasks).find((t) => t.id === updated.id) ?? updated;
    void rememberTask(updated.projectId, projectPaths.get(updated.projectId), rememberedTask);
    void postAgentTurnToMailbox(updated, outcome);
    void handleReviewerVerdict(updated);
  }

  if (!updated) return;
  const name = (task.agentPreset ? getAgentDisplayName(task.agentPreset) : null) ?? task.agentPreset ?? 'Agent';

  // The completion card below is the durable record — it must be written even
  // when the toast is suppressed, because the card is what lands in the inbox
  // for a finished agent the user was not watching.
  const elapsed = task.startedAt ? Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000)) : null;
  const completionStatus: CompletionSummary['status'] =
    updated.status === 'blocked' ? 'blocked' : updated.status === 'failed' ? 'failed' : 'done';
  const completionReason =
    updated.status === 'blocked' && outcome.kind === 'blocked' ? outcome.reason
    : updated.status === 'failed' ? updated.failureReason
    : null;

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
    announceCompletionAloud(name, completionStatus, task.title);
  }

  const chatMsgId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const willSummarize = !!(updated.transcript?.trim()) && isAiAvailable();

  const completionData: CompletionSummary = {
    status: completionStatus,
    agentName: name,
    taskTitle: task.title,
    elapsedSec: elapsed,
    reason: completionReason ?? null,
    summary: null,
    summaryPending: willSummarize,
    taskId: task.id,
  };

  appendChat(task.projectId, {
    id: chatMsgId,
    role: 'assistant',
    text: '',
    ts: Date.now(),
    completion: completionData,
  });

  if (willSummarize && updated.transcript) {
    const projectId = task.projectId;
    void generateTranscriptSummary(updated.transcript, completionStatus)
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
  skipWorktree?: boolean
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
): void {
  void (async () => {
    try {
      // Brief delivery is the guardrail that replaced git-worktree isolation.
      // Rules-file agents already have it from CLAUDE.md / AGENTS.md, so they get
      // only the task; the rest get the charter-wrapped goal. The stored goal and
      // the activity log keep the clean task text either way.
      const task = get(orchestratorTasks).find((t) => t.id === id);
      const message = buildLeasedAgentMessage(goal, agentCommand, task?.name ?? null, task?.projectId, task?.role ?? null);
      const sent = await sendOrchestratorGoalWhenReady(sessionId, message, {
        shouldContinue: () => leasedSessionLive(id, sessionId),
      });
      if (!sent) return;
      patchTask(id, (current) =>
        current.status === 'in-progress' ? { ...current, promptSentAt: Date.now() } : current
      );
      logTaskActivity(id, 'goal', goal);
      showToast('Sent goal to ' + (getAgentDisplayName(agentCommand) ?? agentCommand), 'info', 3000);
      if (!watchTurn) return;
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
        showToast('Could not brief the spawned agent — session was lost', 'warning', 4000);
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
  autoRunOrOpts: boolean | { autoRun?: boolean; watchTurn?: boolean; activate?: boolean; holdGoal?: boolean } = true
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

  const task = get(orchestratorTasks).find((t) => t.id === id);
  if (!task) return null;

  const launchGeneration = nextLaunchGeneration(task.id);
  let launchCommitted = false;
  try {
    // Give each agent its own isolated git worktree (own branch off HEAD) so
    // concurrent agents never collide in the shared working tree. Reuse an
    // existing worktree on relaunch; fall back to the project root when isolation
    // isn't possible (non-git project, empty repo, …).
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

    let sessionId = await leaseOrchestratorTerminal({
      agentCommand,
      cwd: effectiveCwd,
      taskId: task.id,
      taskTitle: task.title,
      name: task.name,
      activate,
    });
    // If the isolated worktree couldn't start the agent, don't fail the launch —
    // drop the worktree and retry in the project root so the agent still runs.
    if (sessionId == null && worktree && effectiveCwd !== cwd) {
      void removeTaskWorktree(task.projectId, worktree, false);
      patchTask(task.id, (current) => ({ ...current, worktree: null }));
      worktree = null;
      sessionId = await leaseOrchestratorTerminal({
        agentCommand,
        cwd,
        taskId: task.id,
        taskTitle: task.title,
        name: task.name,
        activate,
      });
    }
    if (sessionId == null) {
      showToast('Could not start the agent terminal', 'error');
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

function resolveProjectFilePath(path: string, rootPath: string): string {
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
  taskTitle: string;
  elapsedSec: number | null;
  reason?: string | null;
  /** AI-generated plain-English summary of what the agent did this turn. */
  summary?: string | null;
  /** True while the summary LLM call is in flight. */
  summaryPending?: boolean;
  /** The orchestrator task this turn belonged to, when one exists. Lets the
   *  notification card offer a "Show terminal" action while the session lives. */
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

function appendChat(projectId: string, msg: ChatMessage) {
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
  const config = getConversationLlmConfig(false);
  if (!config.hasApiKey) return;

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
  chatMessages.update((all) => {
    const list = (all[projectId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m));
    return { ...all, [projectId]: list };
  });
}

export function clearProjectChat(projectId: string) {
  chatMessages.update((all) => ({ ...all, [projectId]: [] }));
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
        notifyAdoptedTurnEnd(task, outcome);
      }
    }
  })();
}

/** The chime and durable inbox card for one adopted turn end. */
function notifyAdoptedTurnEnd(task: OrchestratorTask, outcome: AgentTurnOutcome): void {
  const name =
    task.name
    ?? (task.agentPreset ? getAgentDisplayName(task.agentPreset) : null)
    ?? task.agentPreset
    ?? 'Agent';

  logTaskActivity(task.id, outcome.kind === 'blocked' ? 'blocked' : 'finished',
    outcome.kind === 'blocked' ? outcome.reason : 'Finished its turn.');

  // The completion card below is the one visual notification for this turn end —
  // a toast would duplicate it. The chime stays as the "right now" audio cue.
  if (get(announceAgentCompletions)) {
    // In voice mode the realtime model relays it in its own voice; a chime on
    // top of a live call is jarring. Same split as announceCompletionAloud.
    if (get(agentVoiceModeActive)) {
      announceViaRealtimeVoice(
        outcome.kind === 'blocked'
          ? `${name} needs your input.`
          : `${name} finished its turn.`
      );
    } else {
      playNudge(outcome.kind === 'blocked' ? 'blocked' : 'done');
    }
  }

  // The durable trace for this turn. A card lands only when a cue lands, so it
  // can never outnumber the chimes (shouldNudgeAdopted already deduped this one).
  appendAdoptedTurnCard(
    task,
    name,
    outcome.kind === 'blocked' ? 'blocked' : 'done',
    outcome.kind === 'blocked' ? outcome.reason : null,
  );
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
): void {
  appendChat(task.projectId, {
    id: msgId(),
    role: 'assistant',
    text: '',
    ts: Date.now(),
    completion: {
      status,
      agentName: name,
      taskTitle: task.title,
      elapsedSec: null,
      reason,
      summary: null,
      summaryPending: false,
      taskId: task.id,
    },
  });
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
async function sendFollowUpToAgent(task: OrchestratorTask, prompt: string, rootPath: string): Promise<boolean> {
  if (task.assignedSessionId != null) {
    const live = getTerminalProjectState(task.projectId).sessions.find((s) => s.id === task.assignedSessionId);
    // Adopted agents have no `ownerTaskId` lease (see leasedSessionLive); a live
    // session is enough to route a follow-up into.
    if (!live?.isRunning || (!task.adopted && live.ownerTaskId !== task.id)) return false;

    const sent = await sendOrchestratorFollowUpWhenReady(task.assignedSessionId, withAgentTaskPanelContext(prompt, task.projectId), {
      shouldContinue: () => leasedSessionLive(task.id, task.assignedSessionId!),
    });
    if (!sent) return false;
    patchTask(task.id, (current) => (current.status === 'in-progress' ? { ...current, promptSentAt: Date.now() } : current));
    logTaskActivity(task.id, 'follow-up', prompt);
    return true;
  }

  if (task.status !== 'blocked' || !task.agentPreset) return false;

  const sessionId = await leaseOrchestratorTerminal({
    agentCommand: task.agentPreset,
    // Reopen the agent in its existing isolated worktree so resumed work stays on
    // the same branch; fall back to the project root if it never had one.
    cwd: task.worktree?.path ?? rootPath,
    taskId: task.id,
    taskTitle: task.title,
    name: task.name,
  });
  if (sessionId == null) return false;
  // The exit handler will write the completion card for this resumed session;
  // keep the terminal layer's own exit toast suppressed.
  markOrchestratorTrackedSession(sessionId);

  patchTask(task.id, (current) => ({
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

  const agentName = getAgentDisplayName(task.agentPreset) ?? task.agentPreset;
  logTaskActivity(task.id, 'dispatch', `Resumed ${agentName}.`);

  // Resuming a blocked task re-leases a FRESH agent CLI (the previous process
  // exited), so it has no memory of its first-turn brief. A rules-file agent
  // re-reads CLAUDE.md / AGENTS.md on this fresh boot (the re-lease re-ensures
  // them), so it just needs the resume prompt; a paste agent needs the charter
  // wrapped around it, exactly like an initial dispatch. The activity log below
  // still records the clean prompt, not the message text.
  const sent = await sendOrchestratorFollowUpWhenReady(
    sessionId,
    buildLeasedAgentMessage(prompt, task.agentPreset, task.name ?? null, task.projectId),
    { shouldContinue: () => leasedSessionLive(task.id, sessionId) }
  );
  if (!sent) return false;
  patchTask(task.id, (current) => (current.status === 'in-progress' ? { ...current, promptSentAt: Date.now() } : current));
  logTaskActivity(task.id, 'follow-up', prompt);

  void (async () => {
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
  return `On it — ${describeActionsInProgress(actions)}.`;
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
export async function sendChatMessage(
  projectId: string,
  rootPath: string,
  text: string,
  opts?: {
    projectName?: string;
    forcedAgent?: string;
    voiceConversation?: boolean;
  }
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || !projectId) return;

  const access = await detectAgentAccess();
  if (!access.ready) {
    appendChat(projectId, { id: msgId(), role: 'user', text: trimmed, ts: Date.now() });
    appendChat(projectId, {
      id: msgId(),
      role: 'assistant',
      text: getAgentAccessBlockedMessage(),
      ts: Date.now(),
    });
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
  const recentUserMessages = (get(chatMessages)[projectId] ?? [])
    .filter((m) => !m.pending && m.role === 'user')
    .map((m) => m.text)
    .slice(-6);
  const taskMemory = buildProjectTaskMemory(projectId);
  const taskPanel = getProjectTaskPanelLines(projectId);
  const mailboxLines = getMailboxLines(projectId);
  const knowledgeLines = getKnowledgeLines(projectId);
  const llmConfig = getConversationLlmConfig(opts?.voiceConversation);

  appendChat(projectId, { id: msgId(), role: 'user', text: trimmed, ts: Date.now() });
  const assistantId = msgId();
  appendChat(projectId, { id: assistantId, role: 'assistant', text: '', ts: Date.now(), pending: true });

  let result: RouteResult;
  const forced = opts?.forcedAgent && opts.forcedAgent !== 'auto'
    ? agents.find((a) => a.command === opts.forcedAgent)
    : null;
  if (forced) {
    result = {
      reply: `Handing this to ${forced.name}.`,
      actions: [{ kind: 'spawn', agent: forced.command, prompt: trimmed }],
      viaLLM: false,
    };
  } else {
    try {
      result = await routeOrchestratorRequest(trimmed, agents, {
        projectName: opts?.projectName,
        projectRoot: rootPath,
        recentUserMessages,
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
        conversational: !!opts?.voiceConversation,
      });
    } catch (err) {
      console.error('Orchestrator routing error:', err);
      result = { reply: 'Something went wrong routing that. Try again.', actions: [], viaLLM: false };
    }
  }

  // Never pair executing actions with a "want me to?" reply — the actions run
  // right below, so the reply must state what's happening, not ask permission.
  if (result.actions.length) {
    result = { ...result, reply: declarativeReply(result.actions, result.reply) };
  }

  patchChat(projectId, assistantId, { text: result.reply, pending: false });

  // ── Placement gate: isolated worktree or main repo? ────────────────────────
  // Asked before ANY terminal is leased, on every dispatch that spawns. An agent
  // working inside an isolated worktree leaves the main checkout untouched, so
  // deciding this silently is how a user loses track of where the work went.
  // The dialog answers PER AGENT — a three-agent plan can put one in the main
  // repo and isolate the other two. Dismissing cancels the spawns only;
  // send/name/close actions in the same plan still run.
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
      text: `Where should ${who} run — an isolated worktree, or the main repo?`,
    });
  } else if (undecidedSpawns.length) {
    // The admin/release heuristic no longer decides — it only pre-selects "Main
    // repo" and explains why, since git tag/push can't work from a worktree.
    const adminSpawn = undecidedSpawns.some(
      (action) => action.skipWorktree === true || (!!action.prompt && ADMIN_KEYWORD_RE.test(action.prompt))
    );
    askedPlacements = await requestAgentPlacement({
      agents: undecidedSpawns.map(agentLabel),
      source: 'orchestrator',
      suggested: adminSpawn ? 'main' : undefined,
      suggestionReason: adminSpawn
        ? 'This reads like a release or admin task (tagging, pushing, version bumps). Those need the main branch — git tag and push do not work from a worktree.'
        : null,
    });
    if (!askedPlacements) {
      spawnsAllowed = false;
      patchChat(projectId, assistantId, {
        text: `${result.reply}\n\n_Cancelled — no agent was started._`,
      });
      showToast('Spawn cancelled', 'info', 2500);
    }
  }

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
      opts?.projectName ?? 'project',
      async (sysPrompt, userText) => {
        const { provider, model, hasApiKey, baseUrl } = llmConfig;
        const local = isLocalProvider(provider);
        if ((!local || baseUrl) && (local || hasApiKey)) {
          return await invoke<string>('ai_complete', {
            systemPrompt: sysPrompt,
            userText,
            provider,
            model,
            apiKey: '',
            baseUrl: baseUrl || undefined,
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
    const persistent = !!explicitName || !action.prompt;
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
        showToast(`Holding ${name} — ${files} is still owned by ${owners}`, 'warning', 6000, true);
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
      skipWorktree
    );

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
    });

    if (sessionId == null) {
      // Launch failed (no free terminal pane) — remove the orphaned task record.
      deleteOrchestratorTask(task.id);
      showToast(`Could not start ${getAgentDisplayName(action.agent) ?? action.agent} — no terminal available`, 'error', 5000);
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
      sendGoalToLeasedTask(task.id, sessionId, goal, agent, watchTurn);
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
  }

  // Evolve the brain: fold any durable insight from this turn into the profile.
  // Fire-and-forget — never blocks the reply, and silently no-ops without AI.
  const { provider: rProvider, model: rModel, hasApiKey: rHasKey, baseUrl: rBaseUrl } = llmConfig;
  const rLocal = isLocalProvider(rProvider);
  if ((!rLocal || rBaseUrl) && (rLocal || rHasKey)) {
    void reflectAndEvolve({
      projectId,
      rootPath,
      userMessage: trimmed,
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
    showToast(`Nothing new to bring in — ${worktree.branch} is already in your working tree.`, 'info', 4000);
  } else if (result.ok) {
    showToast(result.message, 'success', 6000);
  } else if (result.conflicted) {
    showToast(result.message, 'warning', 12000);
  } else {
    showToast(`Couldn't bring the changes in: ${result.message}`, 'error', 8000);
  }
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
        `${work.agentName}'s ${stagedFiles} file change${stagedFiles === 1 ? '' : 's'} are in Source Control — ready to test`,
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
      void sweepOrphanWorktrees(projectId)
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
      );
      return;
    }
    // Distinguish clean exit (code 0 or unknown) from crash (non-zero code) so
    // the task ends up in the right terminal state rather than always showing
    // "complete" for both success and crashes. The terminal layer already raised
    // its own exit notification, so suppress ours here (notify: false).
    const exitCode = code ?? null;
    const outcome: AgentTurnOutcome =
      exitCode !== null && exitCode !== 0
        ? { kind: 'blocked', reason: `Agent process exited with code ${exitCode}.` }
        : { kind: 'finished' };
    completeLeasedTask(task.id, sessionId, outcome, { notify: false, exitCode });
  });
}
