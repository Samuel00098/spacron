/**
 * Subagent management backed by the native Spacron MCP server and terminal sessions.
 *
 * Instead of relying on skill files or non-uniform provider-internal subagents,
 * this wires structured chat directly to Spacron's MCP server:
 * - Spawns child agents in isolated git worktrees via `spawnAgentPreset`.
 * - Registers them in the Spacron MCP registry via `registerAgent`.
 * - Delivers tasks and follow-up prompts via `sendOrchestratorFollowUpWhenReady`.
 * - Enables live pane opening on stage via `requestRoomControl('focus', 'agent:<id>')`.
 * - Enables child process teardown via `killSession`.
 *
 * A child belongs to the parent's *structured session record* (`ss_…`), not to
 * whichever project happens to be active: the project and cwd come from that
 * record, so switching projects while a chat is open cannot file a child under
 * the wrong one. The record also owns the children's state (status, reports,
 * answers, exit reason and a short timeline), so the panel comes back after a
 * reload; `restoreMcpSubagents` rebuilds it and marks a child whose session is
 * gone as `lost` rather than pretending it finished.
 *
 * Only a `done` report completes a child. A process that goes away without one
 * ends as `exited`, with its exit code, so a guess never reads as a result.
 * The final report stays on the parent's card (and in its record); it is not
 * injected into the parent agent's own conversation.
 */

import { get } from '$lib/stores/storeCompat';
import {
  getActiveTerminalProjectId,
  killSession,
  sessions,
  setSessionWorktree,
  spawnAgentPreset,
} from '$lib/stores/terminal';
import { registerAgent, unregisterAgent } from '$lib/stores/mcpBridge';
import { createTaskWorktree, type WorktreeInfo } from '$lib/services/orchestrator/worktree-manager';
import { sendOrchestratorFollowUpWhenReady } from '$lib/services/orchestrator/terminal-lease';
import { requestRoomControl } from '$lib/stores/layoutControl';
import type { StructuredSubagentLogEntry, StructuredSubagentSession } from './provider';

// Map: parentSessionId (pane id) -> StructuredSubagentSession[]
const subagentStore = new Map<number, StructuredSubagentSession[]>();
const listeners = new Map<number, Set<() => void>>();

/** Timeline entries kept per child; older ones are dropped. */
const MAX_LOG_ENTRIES = 30;
/** Children kept on one record; a long chat does not grow its record forever. */
export const MAX_CHILDREN_PER_RECORD = 20;

export function clearMcpSubagents(): void {
  subagentStore.clear();
  listeners.clear();
}

function notify(parentSessionId: number): void {
  const set = listeners.get(parentSessionId);
  if (set) {
    for (const listener of set) {
      try {
        listener();
      } catch (e) {
        console.error('[mcp-subagents] Listener error:', e);
      }
    }
  }
}

export function subscribeMcpSubagents(parentSessionId: number, listener: () => void): () => void {
  let set = listeners.get(parentSessionId);
  if (!set) {
    set = new Set();
    listeners.set(parentSessionId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      listeners.delete(parentSessionId);
    }
  };
}

export function listMcpSubagents(parentSessionId: number): StructuredSubagentSession[] {
  return subagentStore.get(parentSessionId)?.slice() ?? [];
}

export function findSubagentById(subagentId: string): { subagent: StructuredSubagentSession; parentSessionId: number } | null {
  for (const [parentSessionId, list] of subagentStore.entries()) {
    const sub = list.find((s) => s.id === subagentId);
    if (sub) return { subagent: sub, parentSessionId };
  }
  return null;
}

export function findSubagentByChildSessionId(childSessionId: number): { subagent: StructuredSubagentSession; parentSessionId: number } | null {
  for (const [parentSessionId, list] of subagentStore.entries()) {
    const sub = list.find((s) => s.childSessionId === childSessionId);
    if (sub) return { subagent: sub, parentSessionId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeline, durable state and the parent's own context
// ---------------------------------------------------------------------------

function addLog(subagent: StructuredSubagentSession, kind: string, text?: string): void {
  const entry: StructuredSubagentLogEntry = { at: Date.now(), kind, ...(text ? { text } : {}) };
  subagent.log = [...(subagent.log ?? []), entry].slice(-MAX_LOG_ENTRIES);
}

/**
 * Write the children onto their parent's structured session record. The record
 * is what survives a reload (and is pruned with the other records), so a
 * second storage key would only drift from it.
 */
async function persistChildren(parentSessionId: number): Promise<void> {
  const list = subagentStore.get(parentSessionId);
  const recordId = list?.[0]?.parentRecordId ?? null;
  if (!recordId || !list?.length) return;
  try {
    const { recordSubagentSnapshot } = await import('./session-store');
    recordSubagentSnapshot(recordId, list.slice(-MAX_CHILDREN_PER_RECORD));
  } catch (error) {
    console.warn('[mcp-subagents] Could not persist subagent state:', error);
  }
}

/**
 * The parent chat's own project and folder, read from its persisted record.
 * The active project is only a fallback for a pane that has no record yet
 * (e.g. a chat that is still starting).
 *
 * Imported lazily: `session-store` imports the provider registry, which imports
 * this module, so a static import would close that cycle.
 */
async function resolveParentSession(parentSessionId: number): Promise<{ recordId: string | null; projectId: string | null; cwd: string | null }> {
  try {
    const { recordForPane } = await import('./session-store');
    const record = recordForPane(parentSessionId);
    if (record) return { recordId: record.id, projectId: record.projectId, cwd: record.cwd };
  } catch (error) {
    console.warn('[mcp-subagents] Could not read the parent session record:', error);
  }
  return { recordId: null, projectId: getActiveTerminalProjectId(), cwd: null };
}

/**
 * Spawn a new child subagent using the Spacron MCP server and isolated git worktree.
 */
export async function spawnMcpSubagent(
  parentSessionId: number,
  assignment: string,
  options?: { preset?: string; model?: string },
): Promise<StructuredSubagentSession> {
  const preset = options?.preset?.trim() || 'claude';
  const parent = await resolveParentSession(parentSessionId);
  const projectId = parent.projectId;

  let worktree: WorktreeInfo | null = null;
  if (projectId) {
    try {
      worktree = await createTaskWorktree({
        projectId,
        taskId: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        label: preset,
      });
    } catch (err) {
      console.warn('[mcp-subagents] Could not create worktree branch, falling back to main cwd:', err);
    }
  }

  // The parent's own folder, never "whatever the active project is now": an
  // open chat keeps working in the folder it was opened in.
  const childSessionId = await spawnAgentPreset(preset, worktree?.path ?? parent.cwd ?? undefined, {
    activate: false,
    projectId: projectId ?? undefined,
    onSessionCreated: (createdSessionId) => {
      if (worktree) {
        setSessionWorktree(createdSessionId, worktree);
      }
    },
  });

  if (childSessionId == null) {
    throw new Error(`Failed to spawn child subagent '${preset}'.`);
  }

  const subagentId = `mcp_sub_${Date.now()}_${childSessionId}`;
  const subagent: StructuredSubagentSession = {
    id: subagentId,
    parentSessionId,
    parentRecordId: parent.recordId,
    origin: 'spacron',
    childSessionId,
    agent: preset,
    assignment,
    status: 'running',
    startedAt: Date.now(),
    branch: worktree?.branch ?? undefined,
  };
  addLog(subagent, 'spawn', worktree ? `Started in ${worktree.path} on ${worktree.branch}.` : 'Started in the chat\'s own folder.');

  // Register with Spacron MCP server so other agents and tools discover it
  const assignedName = `${preset}-${childSessionId}`;
  try {
    await registerAgent(childSessionId, assignedName, preset, preset, worktree?.branch);
  } catch (err) {
    console.warn('[mcp-subagents] Failed to register subagent in MCP server:', err);
  }

  // Deliver the assignment task prompt once the agent PTY settles
  void sendOrchestratorFollowUpWhenReady(childSessionId, assignment).catch((err) => {
    console.warn('[mcp-subagents] Failed to deliver task prompt to subagent:', err);
  });

  // Store in active subagent list
  const existing = subagentStore.get(parentSessionId) ?? [];
  subagentStore.set(parentSessionId, [...existing, subagent]);
  watchSessions();
  void persistChildren(parentSessionId);
  notify(parentSessionId);

  return subagent;
}

/**
 * Open and focus the subagent's terminal pane in the Spacron workspace.
 */
export function openMcpSubagentPane(subagentId: string): void {
  const found = findSubagentById(subagentId);
  if (!found || found.subagent.childSessionId == null) return;
  requestRoomControl('focus', `agent:${found.subagent.childSessionId}`);
}

/**
 * Cancel and terminate a running subagent.
 */
export async function cancelMcpSubagent(subagentId: string): Promise<void> {
  const found = findSubagentById(subagentId);
  if (!found) return;
  const { subagent, parentSessionId } = found;

  // Mark it cancelled *before* killing: the session watcher must not read the
  // kill as an unexpected exit.
  subagent.status = 'cancelled';
  subagent.completedAt = Date.now();
  addLog(subagent, 'cancel', 'Cancelled from the parent chat.');
  void persistChildren(parentSessionId);
  notify(parentSessionId);

  if (subagent.childSessionId != null) {
    try {
      await killSession(subagent.childSessionId);
    } catch (e) {
      console.warn('[mcp-subagents] Error killing session:', e);
    }
    try {
      await unregisterAgent(subagent.childSessionId);
    } catch (e) {
      console.warn('[mcp-subagents] Error unregistering agent:', e);
    }
  }
}

/**
 * Answer a subagent that is waiting for input (`needs-input`).
 */
export async function answerMcpSubagent(subagentId: string, answer: string): Promise<void> {
  const found = findSubagentById(subagentId);
  if (!found) return;
  const { subagent, parentSessionId } = found;

  subagent.status = 'running';
  subagent.answer = answer;
  subagent.question = undefined;
  addLog(subagent, 'answer', answer);
  void persistChildren(parentSessionId);
  notify(parentSessionId);

  if (subagent.childSessionId != null) {
    await sendOrchestratorFollowUpWhenReady(subagent.childSessionId, answer);
  }
}

/**
 * Handle turn completion or input requests from the Spacron MCP server (`mcp:agent-report`).
 */
export function handleSubagentReport(
  sessionId: number,
  state: 'done' | 'needs_input' | 'failed' | 'working',
  detail?: string,
): void {
  const found = findSubagentByChildSessionId(sessionId);
  if (!found) return;
  const { subagent, parentSessionId } = found;

  if (state === 'done') {
    subagent.status = 'completed';
    subagent.output = detail ?? subagent.output;
    subagent.completedAt = Date.now();
    subagent.exit = undefined;
    addLog(subagent, 'report:done', detail);
  } else if (state === 'needs_input') {
    subagent.status = 'needs-input';
    subagent.question = detail ?? 'The agent needs your input to continue.';
    addLog(subagent, 'report:needs_input', detail);
  } else if (state === 'failed') {
    subagent.status = 'failed';
    subagent.output = detail ?? subagent.output;
    subagent.completedAt = Date.now();
    addLog(subagent, 'report:failed', detail);
  } else if (state === 'working') {
    subagent.status = 'running';
    addLog(subagent, 'report:working', detail);
  }

  void persistChildren(parentSessionId);
  notify(parentSessionId);
}

/**
 * Rebuild a pane's children from its record, after a reload or when another
 * record is resumed in this pane. A child whose session is still running is
 * reattached; one that is gone and never reported an end is `lost`, so the
 * panel says what actually happened instead of showing it as finished.
 */
export function restoreMcpSubagents(parentSessionId: number, recordId: string, children: StructuredSubagentSession[]): void {
  const live = get(sessions);
  const restored = children.map((child) => reconcileRestoredChild(child, parentSessionId, recordId, live));
  if (restored.length) {
    subagentStore.set(parentSessionId, restored);
    watchSessions();
    void persistChildren(parentSessionId);
  } else {
    subagentStore.delete(parentSessionId);
  }
  notify(parentSessionId);
}

function reconcileRestoredChild(
  child: StructuredSubagentSession,
  parentSessionId: number,
  recordId: string,
  live: { id: number; isRunning: boolean }[],
): StructuredSubagentSession {
  const next: StructuredSubagentSession = {
    ...child,
    parentSessionId,
    parentRecordId: recordId,
    origin: child.origin ?? 'spacron',
    log: [...(child.log ?? [])],
  };
  const session = child.childSessionId != null ? live.find((s) => s.id === child.childSessionId) : undefined;
  if (session?.isRunning) {
    next.status = 'running';
    next.exit = undefined;
    addLog(next, 'restored', 'Reattached to its running terminal session.');
    return next;
  }
  if (next.status === 'completed' || next.status === 'failed' || next.status === 'cancelled' || next.status === 'exited' || next.status === 'lost') {
    return next;
  }
  next.status = 'lost';
  next.exit = { clean: false, code: null, detail: 'Its terminal session is gone and it sent no final report.' };
  next.completedAt = next.completedAt ?? Date.now();
  addLog(next, 'lost', next.exit.detail);
  return next;
}

// Watch the sessions store: a child that stops running without a report ended,
// but it did not necessarily succeed. Only a `done` report means completed.
// Started on the first child, not at import: this module sits in an import
// cycle with the terminal store, which may not have finished loading yet.
let watchingSessions = false;
function watchSessions(): void {
  if (watchingSessions) return;
  watchingSessions = true;
  sessions.subscribe(onSessionsChanged);
}
function onSessionsChanged(sessionList: typeof sessions extends { subscribe(run: (v: infer T) => void): unknown } ? T : never): void {
  for (const [parentSessionId, list] of subagentStore.entries()) {
    let changed = false;
    for (const sub of list) {
      if (sub.childSessionId == null) continue;
      if (sub.status !== 'running' && sub.status !== 'starting' && sub.status !== 'needs-input') continue;
      const session = sessionList.find((s) => s.id === sub.childSessionId);
      // Not in the list at all means "not created yet" as often as "gone":
      // a pane is added to `sessions` after its process starts.
      if (!session || session.isRunning) continue;
      const code = session.lastExitCode ?? null;
      sub.status = 'exited';
      sub.completedAt = Date.now();
      sub.exit = {
        clean: code === 0,
        code,
        detail: code == null
          ? 'The agent process ended before it sent a final report.'
          : `The agent process ended (exit code ${code}) before it sent a final report.`,
      };
      addLog(sub, 'exit', sub.exit.detail);
      changed = true;
    }
    if (changed) {
      void persistChildren(parentSessionId);
      notify(parentSessionId);
    }
  }
}
