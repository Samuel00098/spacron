import { writable, get } from '$lib/stores/storeCompat';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauri';
import { usageState } from '$lib/stores/usage';
import { showToast } from '$lib/stores/notification';
import { explainError } from '$lib/utils/explainError';
import { agentExecutable } from '$lib/services/orchestrator/agent-rules-file';
import type { InboxEntry } from '$lib/services/orchestrator/inbox';

/**
 * Agent CLI updates: which installed agents have a newer npm release, the
 * one-click install behind the update button, and the inbox notices for both.
 *
 * Rust (`commands/agent_updates.rs`) decides everything that touches the
 * machine — which install a command resolves to, which version is newer, and
 * the hidden `npm install -g`. This store only schedules checks, remembers what
 * is in flight so the UI can grey an agent out, and keeps the notices.
 *
 * The notices are app-wide, not per project: an agent CLI is installed once
 * for the whole machine, so reading "Codex has an update" in one project must
 * not leave it unread in the next. That is why they keep their own read/cleared
 * lists here instead of the per-project lists in `inbox.ts`.
 */

export interface AgentUpdateInfo {
  command: string;
  package: string;
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
}

interface Failure {
  id: string;
  command: string;
  name: string;
  message: string;
  ts: number;
}

interface NoticeState {
  read: string[];
  cleared: string[];
  /** When each "update available" notice first appeared, so its row time is stable. */
  firstSeen: Record<string, number>;
  failures: Failure[];
}

export interface AgentUpdatesState {
  /** Only npm installs Spacron can update; a missing command means "not ours to update". */
  byCommand: Record<string, AgentUpdateInfo>;
  /** Commands whose update is running right now. */
  updating: string[];
  checking: boolean;
  lastCheckedAt: number;
}

const NOTICE_KEY = 'spacron.agentUpdateNotices';
const MAX_TRACKED = 200;
/** A check is a registry round trip per npm agent; twice a day is plenty. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Opening the spawn picker or Settings → Agents re-checks when older than this. */
const STALE_AFTER_MS = 30 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 20_000;

export const UPDATE_ID_PREFIX = 'agent-update:';

function loadNotices(): NoticeState {
  const empty: NoticeState = { read: [], cleared: [], firstSeen: {}, failures: [] };
  try {
    const raw = localStorage.getItem(NOTICE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<NoticeState>;
    return {
      read: Array.isArray(parsed.read) ? parsed.read : [],
      cleared: Array.isArray(parsed.cleared) ? parsed.cleared : [],
      firstSeen: parsed.firstSeen && typeof parsed.firstSeen === 'object' ? parsed.firstSeen : {},
      failures: Array.isArray(parsed.failures) ? parsed.failures : [],
    };
  } catch {
    return empty;
  }
}

export const agentUpdates = writable<AgentUpdatesState>({
  byCommand: {},
  updating: [],
  checking: false,
  lastCheckedAt: 0,
});

export const agentUpdateNotices = writable<NoticeState>(loadNotices());
agentUpdateNotices.subscribe((value) => {
  try {
    localStorage.setItem(NOTICE_KEY, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the notices just won't survive a restart.
  }
});

function cap(list: string[]): string[] {
  return list.length > MAX_TRACKED ? list.slice(-MAX_TRACKED) : list;
}

function availableId(info: AgentUpdateInfo): string {
  return `${UPDATE_ID_PREFIX}${info.command}:${info.latest}`;
}

/** Whether an update is available for `command` (and not already running). */
export function updateFor(state: AgentUpdatesState, command: string): AgentUpdateInfo | null {
  const info = state.byCommand[command];
  return info?.updateAvailable ? info : null;
}

export function isAgentUpdating(command: string | null | undefined): boolean {
  const exe = agentExecutable(command);
  return !!exe && get(agentUpdates).updating.includes(exe);
}

function agentName(command: string): string {
  return get(usageState).detected.find((d) => d.command === command)?.name || command;
}

let inFlight: Promise<void> | null = null;

/**
 * Ask Rust which installed agents have a newer release. `force` skips the
 * staleness gate; concurrent calls share one check.
 */
export function checkAgentUpdates(force = false): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  if (inFlight) return inFlight;
  const state = get(agentUpdates);
  if (!force && state.lastCheckedAt && Date.now() - state.lastCheckedAt < STALE_AFTER_MS) {
    return Promise.resolve();
  }
  const commands = get(usageState)
    .detected.filter((d) => d.installed)
    .map((d) => d.command);
  if (!commands.length) return Promise.resolve();

  agentUpdates.update((s) => ({ ...s, checking: true }));
  inFlight = invoke<AgentUpdateInfo[]>('agent_updates_check', { commands })
    .then((results) => {
      const byCommand: Record<string, AgentUpdateInfo> = {};
      for (const info of results) byCommand[info.command] = info;
      agentUpdates.update((s) => ({ ...s, byCommand, checking: false, lastCheckedAt: Date.now() }));

      const now = Date.now();
      const fresh = results.filter((i) => i.updateAvailable && !get(agentUpdateNotices).firstSeen[availableId(i)]);
      if (fresh.length) {
        agentUpdateNotices.update((n) => {
          const firstSeen = { ...n.firstSeen };
          for (const info of fresh) firstSeen[availableId(info)] = now;
          return { ...n, firstSeen };
        });
        const names = fresh.map((i) => agentName(i.command));
        showToast(
          names.length === 1
            ? `${names[0]} has an update (${fresh[0].latest}). It's in your inbox.`
            : `${names.length} agents have updates. They're in your inbox.`,
          'info',
          6000,
        );
      }
    })
    .catch((e) => {
      console.warn('[agent-updates] check failed', e);
      agentUpdates.update((s) => ({ ...s, checking: false }));
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Re-check if the last answer is old; for surfaces that list agents. */
export function refreshAgentUpdatesIfStale(): void {
  void checkAgentUpdates(false);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the background schedule once per app run. Returns a stop function. */
export function startAgentUpdateChecks(): () => void {
  if (timer || !isTauriRuntime()) return () => undefined;
  // The first check needs the detection scan (which agents are installed), and
  // that lands on its own schedule; wait for it, but not during startup work.
  let unsubscribe: (() => void) | null = null;
  const first = setTimeout(() => {
    unsubscribe = usageState.subscribe((usage) => {
      if (get(agentUpdates).lastCheckedAt || !usage.detected.some((d) => d.installed)) return;
      void checkAgentUpdates(true);
    });
  }, FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => void checkAgentUpdates(true), CHECK_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    unsubscribe?.();
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/**
 * Running terminals of this agent. On Windows they hold its files open. The
 * terminal store is imported lazily: it reaches `deepseek-harness.ts` through
 * `mcpBridge`, and `deepseek-harness.ts` imports this store, so a static import
 * would close a cycle.
 */
async function runningSessionsOf(command: string): Promise<number> {
  const { sessions } = await import('$lib/stores/terminal');
  return get(sessions).filter((s) => s.isRunning && agentExecutable(s.agentPreset) === command).length;
}

/**
 * Install the update behind `command` in a hidden process. The agent is greyed
 * out everywhere while it runs; the result lands as a toast, and a failure
 * also as an inbox notice.
 */
export async function installAgentUpdate(command: string): Promise<void> {
  const state = get(agentUpdates);
  if (state.updating.includes(command)) return;
  const info = updateFor(state, command);
  const name = agentName(command);
  if (!info) return;

  const running = await runningSessionsOf(command);
  if (get(agentUpdates).updating.includes(command)) return;
  if (running > 0) {
    showToast(
      `Close ${name}'s ${running === 1 ? 'terminal' : `${running} terminals`} first. A running copy keeps its files locked, so the update would fail.`,
      'warning',
      7000,
    );
    return;
  }

  agentUpdates.update((s) => ({ ...s, updating: [...s.updating, command] }));
  try {
    const result = await invoke<{ package: string; from: string; to: string; warning?: string }>(
      'agent_update_install',
      { command },
    );
    if (result.warning) {
      // The CLI moved but a companion (Codex's daemon) did not: say so, and
      // keep the toast up until it is read, since sessions still run the old one.
      const [summary, hint, ...raw] = result.warning.split('\n');
      showToast(summary, 'warning', 0, true, undefined, { hint, details: raw.join('\n') || undefined });
    } else {
      showToast(`${name} updated to ${result.to}.`, 'success', 5000, true);
    }
    agentUpdateNotices.update((n) => ({
      ...n,
      failures: n.failures.filter((f) => f.command !== command),
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showToast(`${name} could not be updated. Details are in your inbox.`, 'error', 7000, true);
    agentUpdateNotices.update((n) => ({
      ...n,
      failures: [
        ...n.failures.filter((f) => f.command !== command),
        { id: `${UPDATE_ID_PREFIX}failed:${command}:${Date.now()}`, command, name, message, ts: Date.now() },
      ].slice(-20),
    }));
  } finally {
    agentUpdates.update((s) => ({ ...s, updating: s.updating.filter((c) => c !== command) }));
    await checkAgentUpdates(true);
  }
}

// ─── Inbox ───────────────────────────────────────────────────────────────────

export function isAgentUpdateEntry(id: string): boolean {
  return id.startsWith(UPDATE_ID_PREFIX);
}

/** The command an update entry is about, so the row can offer "Update now". */
export function commandOfUpdateEntry(id: string): string | null {
  if (!isAgentUpdateEntry(id)) return null;
  const rest = id.slice(UPDATE_ID_PREFIX.length);
  const parts = rest.startsWith('failed:') ? rest.slice('failed:'.length).split(':') : rest.split(':');
  return parts[0] || null;
}

/**
 * Inbox rows for the update notices. An "available" row lives exactly as long
 * as the update does: installing it, or a newer check finding nothing, removes
 * it. A failure row stays until it is cleared or a later attempt succeeds.
 */
export function agentUpdateInboxEntries(state: AgentUpdatesState, notices: NoticeState): InboxEntry[] {
  const read = new Set(notices.read);
  const cleared = new Set(notices.cleared);
  const entries: InboxEntry[] = [];
  for (const info of Object.values(state.byCommand)) {
    if (!info.updateAvailable) continue;
    const id = availableId(info);
    if (cleared.has(id)) continue;
    const updating = state.updating.includes(info.command);
    entries.push({
      id,
      kind: 'update',
      ts: notices.firstSeen[id] ?? state.lastCheckedAt,
      read: read.has(id),
      agentName: agentName(info.command),
      title: updating ? `Updating to ${info.latest}…` : `Update available: ${info.latest}`,
      body: `${info.package} ${info.installed} → ${info.latest}. Installs in the background; the agent is unavailable until it finishes.`,
      status: 'update',
      actionable: false,
      detail: {},
    });
  }
  for (const failure of notices.failures) {
    if (cleared.has(failure.id)) continue;
    const explained = explainError(failure.message, { subject: failure.name, action: 'update' });
    entries.push({
      id: failure.id,
      kind: 'update',
      ts: failure.ts,
      read: read.has(failure.id),
      agentName: failure.name,
      title: 'Update failed',
      body: explained.summary,
      status: 'failed',
      actionable: true,
      detail: { reason: failure.message, nextStep: explained.nextStep, technical: explained.details },
    });
  }
  return entries;
}

export function markAgentUpdateNoticesRead(ids: string[]): void {
  const mine = ids.filter(isAgentUpdateEntry);
  if (!mine.length) return;
  agentUpdateNotices.update((n) => ({ ...n, read: cap([...new Set([...n.read, ...mine])]) }));
}

export function clearAgentUpdateNotices(ids: string[]): void {
  const mine = ids.filter(isAgentUpdateEntry);
  if (!mine.length) return;
  agentUpdateNotices.update((n) => ({
    ...n,
    read: cap([...new Set([...n.read, ...mine])]),
    cleared: cap([...new Set([...n.cleared, ...mine])]),
    failures: n.failures.filter((f) => !mine.includes(f.id)),
  }));
}
