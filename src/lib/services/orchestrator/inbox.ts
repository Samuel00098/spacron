/**
 * Inbox — the durable read-state layer under the agent notification stack.
 *
 * The problem this solves: a toast is transient. An agent finishes while you're
 * looking at another window, its card auto-clears after ten seconds, and the
 * only trace is a chime you didn't hear. "An agent needs you" has to be a queue
 * that survives inattention, not an event you can miss.
 *
 * **This module deliberately stores no message content.** The mailbox log
 * (`mailbox.ts`) and the chat completion cards (`stores/orchestrator.ts`) are
 * already the persisted sources of truth for *what happened*; duplicating them
 * here would give us two copies to keep in step. All this file owns is the two
 * bits of per-entry state neither of them tracks — has the user *read* it, and
 * has the user *dismissed* it — plus the pure merge that presents both sources
 * as one time-ordered list.
 *
 * Read and dismissed are genuinely different, and conflating them is the bug
 * this feature exists to fix:
 *
 * - **dismissed** — drop it from the floating stack. Set when the user clicks
 *   the card's close button, *and* when a finished card auto-clears on its
 *   timer.
 * - **read** — the user actually saw it. Set only by a deliberate act (closing
 *   the card, or opening the inbox). An auto-clear is precisely the case where
 *   the user was not looking, so it must NOT mark read — the entry leaves the
 *   corner and stays bold in the inbox.
 *
 * Persistence mirrors `mailbox.ts`: `$lib/services/project-state`, app config
 * dir, never the user's repository.
 */

import { writable, get } from '$lib/stores/storeCompat';
import { readProjectState, writeProjectState } from '$lib/services/project-state';
import type { MailboxCard, MailboxKind } from './mailbox';

/** Cap the id lists so a long-lived project can't grow this file without bound. */
export const MAX_TRACKED_IDS = 500;

export type InboxStatus = 'done' | 'failed' | 'blocked' | MailboxKind;

export interface InboxEntry {
  /** The underlying message id — a mailbox message id or a chat message id. */
  id: string;
  kind: 'mail' | 'completion';
  ts: number;
  read: boolean;
  /** The agent the entry is about, for the row's leading label. */
  agentName: string;
  /** One-line headline: the task title, or the mailbox message's subject line. */
  title: string;
  /** Longer supporting text — the AI recap, or the message body. */
  body: string;
  status: InboxStatus;
  /** True when the entry wants a human decision rather than just informing. */
  actionable: boolean;
}

/**
 * Structural shape of a chat message carrying a completion card. Declared here
 * rather than imported from `stores/orchestrator` on purpose: that module is
 * ~3k lines and imports the mailbox, so importing it back would close a cycle.
 * `ChatMessage` satisfies this structurally.
 */
export interface CompletionLike {
  id: string;
  ts: number;
  completion?: {
    status: 'done' | 'failed' | 'blocked';
    agentName: string;
    taskTitle: string;
    elapsedSec: number | null;
    reason?: string | null;
    summary?: string | null;
    summaryPending?: boolean;
    /** How the turn end became known: reported, observed, or assumed. */
    endedBy?: 'declared' | 'exit' | 'inferred';
    /** True for a turn end that must not interrupt — inbox only. */
    silent?: boolean;
  } | null;
}

export interface InboxState {
  /** Entry ids the user has actually seen. */
  read: string[];
  /** Entry ids cleared from the floating stack (deliberately or on a timer). */
  dismissed: string[];
  /** Entry ids explicitly cleared from the inbox panel view by the user. */
  cleared: string[];
}

function emptyState(): InboxState {
  return { read: [], dismissed: [], cleared: [] };
}

/** In-memory mirror of every project's inbox state, keyed by projectId. */
export const inboxState = writable<Record<string, InboxState>>({});

/**
 * Whether the inbox popover is showing. Lives here rather than in a UI store so
 * the whole feature is one module — the titlebar bell and the panel are its only
 * two consumers. Not persisted: the inbox opens closed every launch.
 */
export const isInboxOpen = writable<boolean>(false);

export function toggleInbox(): void {
  isInboxOpen.update((open) => !open);
}

export function closeInbox(): void {
  isInboxOpen.set(false);
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Append ids to a tracked list, deduped and capped (oldest dropped first). */
export function addTrackedIds(list: string[], ids: string[], max: number = MAX_TRACKED_IDS): string[] {
  const seen = new Set(list);
  const fresh = ids.filter((id) => id && !seen.has(id));
  if (!fresh.length) return list;
  const next = [...list, ...fresh];
  return next.length > max ? next.slice(-max) : next;
}

/** Build an inbox entry from an actionable mailbox card. */
export function mailEntry(card: MailboxCard, read: boolean): InboxEntry {
  const title =
    card.kind === 'handoff'
      ? `Handed off to ${card.to ?? 'the team'}`
      : card.kind === 'ask'
        ? 'Needs a decision'
        : 'Reported back';
  return {
    id: card.id,
    kind: 'mail',
    ts: card.createdAt,
    read,
    agentName: card.from,
    title,
    body: card.text,
    status: card.kind,
    actionable: card.actionable,
  };
}

/**
 * Build an inbox entry from a chat completion card. Returns null for a chat
 * message that isn't a completion, so callers can map-and-filter in one pass.
 */
export function completionEntry(msg: CompletionLike, read: boolean): InboxEntry | null {
  const c = msg.completion;
  if (!c) return null;
  return {
    id: msg.id,
    kind: 'completion',
    ts: msg.ts,
    read,
    agentName: c.agentName,
    title: c.taskTitle,
    body: completionBody(c),
    status: c.status,
    // Only a stalled or failed agent is actually waiting on the user; a clean
    // finish is information, not a task.
    actionable: c.status !== 'done',
  };
}

/**
 * The line an inbox row actually shows.
 *
 * An inbox whose rows are a name and a title tells you nothing you did not
 * already know — the whole point of the row is *what happened*. So this never
 * returns an empty string: it prefers the real message and falls back through
 * progressively weaker ones rather than rendering a blank.
 *
 * In order: the AI recap of the turn, then whatever the agent said itself (its
 * `report_status` detail, the blocked prompt, the failure), then — only when
 * there is genuinely nothing — a sentence stating the outcome, which at least
 * distinguishes a turn the agent finished from one that merely went quiet.
 */
export function completionBody(c: NonNullable<CompletionLike['completion']>): string {
  const said = c.summary?.trim() || c.reason?.trim();
  if (said) return said;
  if (c.summaryPending) return 'Summarising what it did…';
  if (c.status === 'failed') return 'The agent stopped without finishing.';
  if (c.status === 'blocked') return 'The agent is waiting for you.';
  if (c.endedBy === 'inferred') return 'Went quiet — no completion reported.';
  if (c.endedBy === 'exit') return 'The agent process exited.';
  return 'Finished its turn.';
}

/**
 * Merge both sources into one newest-first list, stamping read state. This is
 * the whole view model — the panel renders exactly what this returns.
 */
export function mergeInboxEntries(
  cards: MailboxCard[],
  messages: CompletionLike[],
  read: ReadonlySet<string>,
  cleared: ReadonlySet<string> = new Set(),
): InboxEntry[] {
  const entries: InboxEntry[] = [
    ...cards
      .filter((card) => !cleared.has(card.id))
      .map((card) => mailEntry(card, read.has(card.id))),
    ...messages
      .filter((msg) => !cleared.has(msg.id))
      .map((msg) => completionEntry(msg, read.has(msg.id)))
      .filter((e): e is InboxEntry => e !== null),
  ];
  // Newest first: the inbox is read top-down, unlike the floating stack, which
  // grows toward the corner.
  return entries.sort((a, b) => b.ts - a.ts);
}

/** How many entries still want the user's attention. */
export function countUnread(entries: InboxEntry[]): number {
  return entries.reduce((n, e) => (e.read ? n : n + 1), 0);
}

// ─── Store access ────────────────────────────────────────────────────────────

function projectState(all: Record<string, InboxState>, projectId: string): InboxState {
  return all[projectId] ?? emptyState();
}

/** Read-state for a project as a set, for `mergeInboxEntries`. */
export function getReadIds(projectId: string): Set<string> {
  return new Set(projectState(get(inboxState), projectId).read);
}

/** Dismissed-state for a project as a set, for the floating stack's filter. */
export function getDismissedIds(projectId: string): Set<string> {
  return new Set(projectState(get(inboxState), projectId).dismissed);
}

/** Cleared-state for a project as a set, for filtering cleared entries out of the inbox view. */
export function getClearedIds(projectId: string): Set<string> {
  return new Set(projectState(get(inboxState), projectId).cleared ?? []);
}

function update(projectId: string, fn: (state: InboxState) => InboxState): void {
  inboxState.update((all) => {
    const next = fn(projectState(all, projectId));
    return { ...all, [projectId]: next };
  });
  void flushProjectInbox(projectId);
}

/** Mark entries as seen by the user. Idempotent. */
export function markRead(projectId: string, ids: string[]): void {
  if (!projectId || !ids.length) return;
  update(projectId, (state) => ({ ...state, read: addTrackedIds(state.read, ids) }));
}

/** Clear entries from the floating stack without claiming the user read them. */
export function markDismissed(projectId: string, ids: string[]): void {
  if (!projectId || !ids.length) return;
  update(projectId, (state) => ({ ...state, dismissed: addTrackedIds(state.dismissed, ids) }));
}

/** Explicitly clear entry ids from the inbox panel view (and mark read + dismissed). */
export function clearInbox(projectId: string, ids: string[]): void {
  if (!projectId || !ids.length) return;
  update(projectId, (state) => ({
    ...state,
    read: addTrackedIds(state.read, ids),
    dismissed: addTrackedIds(state.dismissed, ids),
    cleared: addTrackedIds(state.cleared ?? [], ids),
  }));
}

/**
 * The user closed a card by hand — that is both an acknowledgement and a
 * dismissal, so it sets both bits in one write.
 */
export function acknowledge(projectId: string, id: string): void {
  if (!projectId || !id) return;
  // Spread the rest of state first — an ack is read + dismissed but must not
  // wipe the `cleared` list (or any future field) while it's at it. Every
  // sibling update here spreads; this one was the lone object that didn't.
  update(projectId, (state) => ({
    ...state,
    read: addTrackedIds(state.read, [id]),
    dismissed: addTrackedIds(state.dismissed, [id]),
  }));
}

/** Mark every currently-visible entry read (the inbox's "clear" action). */
export function markAllRead(projectId: string, entries: InboxEntry[]): void {
  markRead(
    projectId,
    entries.filter((e) => !e.read).map((e) => e.id),
  );
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Coerce whatever is on disk into a valid state, tolerating a hand-edited file. */
export function parseInboxState(raw: string | null): InboxState {
  try {
    const parsed = JSON.parse(raw ?? '') as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      read: isStringArray(parsed.read) ? parsed.read.slice(-MAX_TRACKED_IDS) : [],
      dismissed: isStringArray(parsed.dismissed) ? parsed.dismissed.slice(-MAX_TRACKED_IDS) : [],
      cleared: isStringArray(parsed.cleared) ? parsed.cleared.slice(-MAX_TRACKED_IDS) : [],
    };
  } catch {
    return emptyState();
  }
}

/**
 * Load a project's inbox state.
 *
 * `seedRead` covers the cold start. A project that has never had an inbox file
 * still has a full history of completion cards in its chat log, and treating all
 * of it as unread would greet the user with a badge of forty on first launch —
 * an inbox that is wrong the moment it appears. So the first load marks
 * everything that already exists as read, and only work that lands *after* the
 * inbox existed can be unread. It is called only when there is no file, and the
 * result is written straight back so the seed is decided exactly once.
 *
 * The caller supplies the ids rather than this module reading them, because the
 * chat log lives in `stores/orchestrator`, which imports the mailbox — importing
 * it back here would close a cycle.
 */
export async function loadProjectInbox(
  projectId: string,
  rootPath: string,
  seedRead?: () => string[],
): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await readProjectState(projectId, rootPath, 'inbox.json');
  } catch {
    raw = null;
  }
  const firstRun = raw === null;
  const state = parseInboxState(raw);
  if (firstRun && seedRead) {
    state.read = addTrackedIds(state.read, seedRead());
  }
  inboxState.update((all) => ({ ...all, [projectId]: state }));
  if (firstRun) await flushProjectInbox(projectId);
}

export async function flushProjectInbox(projectId: string): Promise<void> {
  const state = projectState(get(inboxState), projectId);
  try {
    await writeProjectState(projectId, 'inbox.json', JSON.stringify(state, null, 2));
  } catch (err) {
    // Read state is a convenience, never load-bearing — a failed write must not
    // break the notification stack that called us.
    console.error('Failed to persist inbox state:', err);
  }
}
