/**
 * Mailbox — the per-project agent-to-agent message bus.
 *
 * Today the orchestrator is a hub: everything flows user ↔ agent and the user
 * carries information between agents. The mailbox is the keystone that lets a
 * *team* of agents talk to each other directly: a shared, append-only log the
 * orchestrator and every agent can read and write. Roles, file-ownership claims,
 * handoff, and bi-directional reporting are all just message *kinds* on top of
 * this one channel — build the channel first (see docs/agent-intelligence.md).
 *
 * Persistence mirrors memory.ts exactly: it reuses the same
 * `backendInvoke('fs_read_file' / 'fs_write_file')` seam, so it works locally AND
 * over the remote-workspace transport for free, and lands next to the existing
 * memory at `.spacron/mailbox.json`.
 */

import { writable, get } from '$lib/stores/storeCompat';
import { backendInvoke } from '$lib/services/backend';

/** Reserved sender/recipient handles that are not agent ids. */
export const ORCHESTRATOR = 'orchestrator';
export const USER = 'user';

export type MailboxKind = 'claim' | 'release' | 'handoff' | 'ask' | 'report' | 'done' | 'note';

export interface MailboxMessage {
  id: string;
  /** Agent id / name, or "orchestrator" / "user". */
  from: string;
  /** Agent id, or null = broadcast to the whole team. */
  to: string | null;
  kind: MailboxKind;
  /** The orchestrator task this message relates to, when known. */
  taskId?: string | null;
  /** For claim/release: the repo-relative files this task owns. */
  files?: string[];
  /** For handoff: the worktree branch the builder was working on, so the
   *  Reviewer can reference it. */
  worktreeBranch?: string;
  text: string;
  createdAt: number;
}

/** Keep the log bounded so persistence stays small (append-only, oldest trimmed). */
export const MAX_MAILBOX_MESSAGES = 200;

/** In-memory mirror of every project's mailbox, keyed by projectId. */
export const mailbox = writable<Record<string, MailboxMessage[]>>({});

/**
 * Card ids the user has already acted on or dismissed. In-memory only (a session
 * queue, not persisted): the underlying messages stay in the log for context and
 * history, but a handled card drops out of the "needs you" strip so it doesn't
 * nag. Keyed by message id.
 */
export const mailboxSeen = writable<Set<string>>(new Set());

/** Drop a card from the actionable strip without touching the message log. */
export function dismissMailboxCard(id: string): void {
  mailboxSeen.update((seen) => {
    if (seen.has(id)) return seen;
    const next = new Set(seen);
    next.add(id);
    return next;
  });
}

function mailboxPath(rootPath: string): string {
  return `${rootPath}/.spacron/mailbox.json`;
}

function compactText(raw: string, maxChars: number): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function ageLabel(ts: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - ts);
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const VALID_KINDS: readonly MailboxKind[] = ['claim', 'release', 'handoff', 'ask', 'report', 'done', 'note'];

function isMailboxMessage(value: unknown): value is MailboxMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.from === 'string' &&
    (m.to === null || typeof m.to === 'string') &&
    typeof m.kind === 'string' &&
    (VALID_KINDS as readonly string[]).includes(m.kind) &&
    typeof m.text === 'string' &&
    typeof m.createdAt === 'number' &&
    (m.files === undefined || (Array.isArray(m.files) && m.files.every((f) => typeof f === 'string'))) &&
    (m.taskId === undefined || m.taskId === null || typeof m.taskId === 'string') &&
    (m.worktreeBranch === undefined || m.worktreeBranch === null || typeof m.worktreeBranch === 'string')
  );
}

/** Normalize file lists: trim, drop empties, dedupe, keep repo-relative order stable. */
function normalizeFiles(files: string[] | undefined): string[] | undefined {
  if (!files) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of files) {
    const f = raw.trim().replace(/^[./\\]+/, '');
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out.length ? out : undefined;
}

export interface NewMailboxMessage {
  from: string;
  to?: string | null;
  kind: MailboxKind;
  taskId?: string | null;
  files?: string[];
  /** For handoff: the worktree branch the builder was working on. */
  worktreeBranch?: string;
  text: string;
}

/** Build a well-formed message (pure — does not touch the store or disk). */
export function createMailboxMessage(input: NewMailboxMessage, now = Date.now()): MailboxMessage {
  return {
    id: `mb_${now}_${Math.random().toString(36).slice(2, 8)}`,
    from: input.from.trim() || ORCHESTRATOR,
    to: input.to?.trim() ? input.to.trim() : null,
    kind: input.kind,
    taskId: input.taskId ?? null,
    files: normalizeFiles(input.files),
    worktreeBranch: input.worktreeBranch,
    text: compactText(input.text, 500),
    createdAt: now,
  };
}

/** Append a message to a (possibly undefined) log, returning a new capped array. */
export function appendMailboxMessage(
  log: MailboxMessage[] | undefined | null,
  message: MailboxMessage,
  max: number = MAX_MAILBOX_MESSAGES
): MailboxMessage[] {
  const next = [...(log ?? []), message];
  return next.length > max ? next.slice(-max) : next;
}

export async function loadProjectMailbox(projectId: string, rootPath: string): Promise<void> {
  let messages: MailboxMessage[] = [];
  try {
    const raw = await backendInvoke<string>('fs_read_file', { path: mailboxPath(rootPath) });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      messages = parsed.filter(isMailboxMessage).slice(-MAX_MAILBOX_MESSAGES);
    }
  } catch {
    messages = [];
  }
  mailbox.update((all) => ({ ...all, [projectId]: messages }));
}

export async function flushProjectMailbox(projectId: string, rootPath: string): Promise<void> {
  const messages = get(mailbox)[projectId] ?? [];
  try {
    try { await backendInvoke('fs_create_dir', { path: `${rootPath}/.spacron` }); } catch { /* exists */ }
    await backendInvoke('fs_write_file', { path: mailboxPath(rootPath), content: JSON.stringify(messages, null, 2) });
  } catch (err) {
    console.error('Failed to save mailbox:', err);
  }
}

/**
 * Post a message to a project's mailbox: append in memory and persist. Returns
 * the stored message so callers can reference its id.
 */
export async function postMailboxMessage(
  projectId: string,
  rootPath: string | null | undefined,
  input: NewMailboxMessage
): Promise<MailboxMessage> {
  const message = createMailboxMessage(input);
  mailbox.update((all) => ({
    ...all,
    [projectId]: appendMailboxMessage(all[projectId] ?? [], message),
  }));
  if (rootPath) await flushProjectMailbox(projectId, rootPath);
  return message;
}

/** All messages for a project, oldest-first (a defensive copy). */
export function getProjectMailbox(projectId: string): MailboxMessage[] {
  return (get(mailbox)[projectId] ?? []).slice();
}

const KIND_GLYPH: Record<MailboxKind, string> = {
  claim: '🔒',
  release: '🔓',
  handoff: '➡️',
  ask: '❓',
  report: '📣',
  done: '✅',
  note: '📝',
};

/** A short, human-facing one-liner for a single message. */
export function formatMailboxMessage(message: MailboxMessage, now = Date.now()): string {
  const glyph = KIND_GLYPH[message.kind] ?? '•';
  const to = message.to ? `→${message.to}` : '→team';
  const files = message.files?.length ? ` [${message.files.slice(0, 3).join(', ')}${message.files.length > 3 ? ', …' : ''}]` : '';
  const body = compactText(message.text, 160);
  return `${glyph} ${message.from} ${to} (${message.kind}, ${ageLabel(message.createdAt, now)})${files}${body ? `: ${body}` : ''}`;
}

/**
 * Recent agent-to-agent traffic, formatted for injection into orchestrator
 * context so the brain can surface it to the user and reason about team state.
 * Skips pure user/orchestrator chatter (that already flows through the main
 * channel) unless it carries a claim/handoff the team needs to see.
 */
export function getMailboxLines(projectId: string, limit = 8): string[] {
  const messages = get(mailbox)[projectId] ?? [];
  const now = Date.now();
  return messages
    .filter((m) => m.from !== USER)
    .slice(-limit)
    .map((m) => formatMailboxMessage(m, now));
}

// ─── Report cards ───────────────────────────────────────────────────────────
//
// Bi-directional flow: instead of the user scraping raw terminal scroll, an
// agent's report/handoff/ask surfaces as a structured card the orchestrator can
// render and the user can approve or redirect. This is the pure data layer for
// that card; the UI renders `getMailboxCards`.

/** Kinds that typically want a human decision rather than just informing. */
const ACTIONABLE_KINDS: readonly MailboxKind[] = ['report', 'handoff', 'ask'];

export interface MailboxCard {
  id: string;
  from: string;
  to: string | null;
  kind: MailboxKind;
  taskId: string | null;
  files: string[];
  /** The builder's worktree branch, shown on handoff cards so the Reviewer
   *  can reference the branch. */
  worktreeBranch?: string;
  text: string;
  createdAt: number;
  /** True when the card asks for a human decision (report / handoff / ask). */
  actionable: boolean;
}

function toCard(message: MailboxMessage): MailboxCard {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    taskId: message.taskId ?? null,
    files: message.files ?? [],
    worktreeBranch: message.worktreeBranch,
    text: message.text,
    createdAt: message.createdAt,
    actionable: ACTIONABLE_KINDS.includes(message.kind),
  };
}

/**
 * Recent mailbox traffic as structured cards, newest first, for the UI. Pass
 * `actionableOnly` to surface just the messages that want a human decision, and
 * `includeSeen` to keep cards the user already dismissed/handled (default hides
 * them so the "needs you" strip clears as the user works through it).
 */
export function getMailboxCards(
  projectId: string,
  opts: { limit?: number; actionableOnly?: boolean; includeSeen?: boolean } = {}
): MailboxCard[] {
  const { limit = 12, actionableOnly = false, includeSeen = false } = opts;
  const messages = get(mailbox)[projectId] ?? [];
  const seen = includeSeen ? null : get(mailboxSeen);
  const cards = messages
    .filter((m) => m.from !== USER)
    .map(toCard)
    .filter((c) => !actionableOnly || c.actionable)
    .filter((c) => !seen || !seen.has(c.id));
  return cards.slice(-limit).reverse();
}

// ─── File ownership ─────────────────────────────────────────────────────────
//
// Worktrees already prevent *physical* collisions on disk; claims prevent
// *logical* ones — two agents solving the same file in parallel and conflicting
// at merge. A Builder posts a `claim` before it starts; the claim is live until
// the same task posts a `release` (or a terminal `done`). The Coordinator refuses
// to dispatch a second task whose claim overlaps a live one.

export interface ActiveClaim {
  taskId: string | null;
  owner: string;
  files: string[];
  claimedAt: number;
}

/**
 * Reduce the log to the set of files currently claimed. A `claim` opens
 * ownership for its task; a later `release` or `done` from the same task closes
 * it. Broadcast (taskId-less) claims key off the sender instead.
 */
export function activeClaims(messages: MailboxMessage[]): ActiveClaim[] {
  const byKey = new Map<string, ActiveClaim>();
  for (const m of messages) {
    const key = m.taskId ?? `from:${m.from}`;
    if (m.kind === 'claim' && m.files?.length) {
      const existing = byKey.get(key);
      const files = existing ? [...new Set([...existing.files, ...m.files])] : m.files.slice();
      byKey.set(key, { taskId: m.taskId ?? null, owner: m.from, files, claimedAt: existing?.claimedAt ?? m.createdAt });
    } else if (m.kind === 'release' || m.kind === 'done') {
      const existing = byKey.get(key);
      if (!existing) continue;
      // A release with specific files drops only those; otherwise release all.
      if (m.kind === 'release' && m.files?.length) {
        const dropped = new Set(m.files);
        const remaining = existing.files.filter((f) => !dropped.has(f));
        if (remaining.length) byKey.set(key, { ...existing, files: remaining });
        else byKey.delete(key);
      } else {
        byKey.delete(key);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Files from `wanted` that are already owned by a *different* task, with who
 * owns them. Empty ⇒ safe to dispatch. `selfTaskId` lets a task re-claim its own
 * files without tripping a conflict.
 */
export function findClaimConflicts(
  messages: MailboxMessage[],
  wanted: string[],
  selfTaskId?: string | null
): Array<{ file: string; owner: string; taskId: string | null }> {
  const want = new Set(normalizeFiles(wanted) ?? []);
  if (!want.size) return [];
  const conflicts: Array<{ file: string; owner: string; taskId: string | null }> = [];
  for (const claim of activeClaims(messages)) {
    if (selfTaskId && claim.taskId === selfTaskId) continue;
    for (const file of claim.files) {
      if (want.has(file)) conflicts.push({ file, owner: claim.owner, taskId: claim.taskId });
    }
  }
  return conflicts;
}
