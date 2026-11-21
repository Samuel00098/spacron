/**
 * Keep the machine awake while agents are working.
 *
 * A coding agent can run unattended for an hour with nobody touching the
 * keyboard, which is precisely what the OS reads as "idle" before suspending —
 * taking every running agent down with it, mid-turn. When the
 * `keepSystemAwake` setting is on, this module holds an OS sleep inhibitor for
 * exactly as long as at least one agent is mid-turn, and drops it the moment
 * the last one finishes.
 *
 * The platform calls live in `src-tauri/src/commands/keep_awake.rs`. This side
 * owns the two things Rust cannot see: **which sessions are working**, and
 * **whether the user asked for this at all**.
 *
 * ## Why turns, not sessions
 *
 * "An agent is open" is the wrong signal — CLI agents sit in a REPL
 * indefinitely after finishing, so a session-based hold would pin the machine
 * awake for as long as a pane stayed open. A *turn* is the interval the agent
 * is actually working, and `watchLeasedAgentTurn` already resolves exactly that
 * boundary for every armed watcher — leased, adopted and adapter-driven. So the
 * refcount is keyed on turns, and that watcher is the only place that reports
 * into it.
 *
 * Aborted turns count as ended: the watch was torn down (session killed, task
 * unlinked), so there is nothing left to keep the machine awake for. This is
 * the one place that deliberately differs from the activity recorder, which
 * drops aborted turns to keep its totals honest.
 */

import { get, writable } from '$lib/stores/storeCompat';
import { keepAwakeMode, keepSystemAwake } from '$lib/stores/settings';
import { isTauriRuntime } from '$lib/utils/tauri';

export interface KeepAwakeStatus {
  active: boolean;
  mechanism: string;
  supported: boolean;
}

export interface KeepAwakeState {
  /** True while the OS inhibitor is actually held. */
  holding: boolean;
  /** How many agent turns are in flight right now. */
  workingAgents: number;
  /** Platform mechanism name, once the backend has reported one. */
  mechanism: string | null;
  /** False on a platform with no inhibitor at all. */
  supported: boolean;
  /** Last failure to take or drop the hold, for the settings row. */
  error: string | null;
}

export const keepAwakeState = writable<KeepAwakeState>({
  holding: false,
  workingAgents: 0,
  mechanism: null,
  supported: true,
  error: null,
});

/**
 * Sessions with a turn in flight.
 *
 * A set rather than a counter: a watcher torn down between its start and end
 * report would leak a count that never comes back down, and with a set the
 * worst case is one stale id that `agentSessionClosed` clears. Re-arming
 * watchers (the adopted path re-arms in a loop) also report the same session id
 * repeatedly, which a set absorbs and a counter would not.
 */
const workingSessions = new Set<number>();

/** Desired state at the last reconcile, so a no-op change skips the round trip. */
let appliedHold = false;
/** Serialises reconciles — two overlapping invokes could land out of order. */
let reconciling: Promise<void> = Promise.resolve();

function publish(patch: Partial<KeepAwakeState>) {
  keepAwakeState.update((s) => ({ ...s, ...patch }));
}

function desiredHold(): boolean {
  const mode = get(keepAwakeMode);
  // Preserve the legacy setting for users upgrading from the boolean control.
  return mode === 'on' || (mode === 'agent' || (mode === 'off' && get(keepSystemAwake))) && workingSessions.size > 0;
}

async function applyHold(active: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const status = await invoke<KeepAwakeStatus>('keep_awake_set', { active });
  appliedHold = status.active;
  publish({
    holding: status.active,
    mechanism: status.mechanism,
    supported: status.supported,
    error: null,
  });
}

/**
 * Bring the OS hold in line with the setting and the live turn count.
 *
 * Every entry point funnels here rather than acquiring/releasing directly, so
 * the hold is a function of current state and can never be left dangling by a
 * missed release.
 */
function reconcile(): Promise<void> {
  if (!isTauriRuntime()) {
    publish({ workingAgents: workingSessions.size });
    return Promise.resolve();
  }
  reconciling = reconciling.then(async () => {
    const wanted = desiredHold();
    publish({ workingAgents: workingSessions.size });
    if (wanted === appliedHold) return;
    try {
      await applyHold(wanted);
    } catch (e) {
      // Surfaced in the settings row rather than as a toast: failing to keep the
      // machine awake must never interrupt the agent run it was protecting.
      // `appliedHold` is left untouched so the next turn boundary retries.
      publish({
        holding: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
  return reconciling;
}

/** An agent turn started on this session. */
export function agentTurnStarted(sessionId: number): void {
  if (workingSessions.has(sessionId)) return;
  workingSessions.add(sessionId);
  void reconcile();
}

/** An agent turn ended on this session — finished, blocked or aborted alike. */
export function agentTurnEnded(sessionId: number): void {
  if (!workingSessions.delete(sessionId)) return;
  void reconcile();
}

/**
 * A session is gone. Clears any turn still attributed to it, so a watcher that
 * died without reporting an end cannot hold the machine awake indefinitely.
 */
export function agentSessionClosed(sessionId: number): void {
  agentTurnEnded(sessionId);
}

/** Test/reset seam: drop every tracked turn and release the hold. */
export function resetKeepAwake(): Promise<void> {
  workingSessions.clear();
  return reconcile();
}

/** How many agent turns are in flight, for callers that cannot subscribe. */
export function workingAgentCount(): number {
  return workingSessions.size;
}

// Adopt whatever the backend is already holding, then reconcile against it.
//
// The hold lives in the Rust process, which outlives the webview: a reload (or
// an HMR round in dev) leaves this module believing nothing is held while the
// machine is still pinned awake, and with no turns in flight nothing would ever
// come along to release it. Reading the real state first makes that stale hold
// the very thing the first reconcile drops.
if (isTauriRuntime()) {
  reconciling = reconciling.then(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<KeepAwakeStatus>('keep_awake_status');
      appliedHold = status.active;
      publish({
        holding: status.active,
        mechanism: status.mechanism,
        supported: status.supported,
      });
    } catch {
      // Nothing to adopt, or no backend at all. The optimistic default (not
      // held) is right in every case where this call cannot answer.
    }
  });
  void reconcile();
}

// Turning the setting off must release an existing hold immediately rather than
// waiting for the current turn to end — the user asked for the machine back now.
// Turning it on mid-run takes the hold for turns already in flight.
keepSystemAwake.subscribe(() => {
  void reconcile();
});
keepAwakeMode.subscribe(() => {
  void reconcile();
});
