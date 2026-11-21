/**
 * Normalized, append-only event journal for one structured chat session.
 *
 * Pure (no stores, no Tauri) so it can be unit tested and replayed anywhere.
 * Provider adapters keep their own protocol parsing; `diffStructuredState`
 * turns two successive provider states into these normalized events, and the
 * chat UI can be rebuilt from `snapshot()` after a remount or an app restart.
 */
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import type { StructuredChatState } from './provider';

export type StructuredEventType =
  | 'user.message'
  | 'assistant.text'
  | 'reasoning'
  | 'tool.started'
  | 'tool.updated'
  | 'file.edit'
  | 'plan.updated'
  | 'subagent'
  | 'notice'
  | 'approval.requested'
  | 'approval.resolved'
  | 'config.updated'
  | 'usage.updated'
  | 'native.session'
  | 'error'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.interrupted'
  | 'session.cleared';

export interface StructuredEvent {
  /** Stable id: duplicates (same id) are dropped on ingest. */
  id: string;
  /** Journal (Spacron) session id, not the pane id. */
  sessionId: string;
  /** Monotonic per journal, starting at 1. */
  seq: number;
  turnId: string | null;
  type: StructuredEventType;
  at: number;
  provider: string;
  payload: Record<string, unknown>;
}

export interface JournalSnapshot {
  seq: number;
  items: TerminalChatItem[];
  /** Turns started up to `seq`, so turn ids stay unique after compaction. */
  turns?: number;
}

export interface PersistedJournal {
  v: 1;
  base: JournalSnapshot;
  events: StructuredEvent[];
}

const MAX_TAIL_EVENTS = 400;
const MAX_ITEMS = 400;
const MAX_TEXT = 20_000;
const MAX_TOOL_OUTPUT = 8_000;
const MAX_PERSISTED_CHARS = 1_500_000;

const EDIT_TOOL = /edit|write|patch|create|replace|apply/i;
const PLAN_TOOL = /todo|plan/i;

function clip(text: string | null | undefined, max: number): string | null | undefined {
  if (typeof text !== 'string' || text.length <= max) return text;
  return `${text.slice(0, max)}\n[shortened]`;
}

/** The persisted form of an item: bounded text, no image bytes. */
export function journalItem(item: TerminalChatItem): TerminalChatItem {
  const out: TerminalChatItem = { ...item, text: clip(item.text, MAX_TEXT) ?? '' };
  if (item.toolOutput) out.toolOutput = clip(item.toolOutput, MAX_TOOL_OUTPUT);
  if (item.toolInput) out.toolInput = clip(item.toolInput, MAX_TOOL_OUTPUT);
  if (item.images?.length) {
    // Data URLs can be megabytes; keep the count so the transcript says so.
    out.images = undefined;
    out.text = `${out.text}\n[${item.images.length} image attachment${item.images.length === 1 ? '' : 's'}]`;
  }
  return out;
}

function itemEventType(item: TerminalChatItem, isNew: boolean): StructuredEventType {
  switch (item.kind) {
    case 'user':
    case 'command':
      return 'user.message';
    case 'assistant':
    case 'command-output':
      return 'assistant.text';
    case 'reasoning':
      return 'reasoning';
    case 'notice':
      return 'notice';
    case 'tool':
      if (item.subagentId) return 'subagent';
      if (item.toolName && PLAN_TOOL.test(item.toolName)) return 'plan.updated';
      if (item.toolName && EDIT_TOOL.test(item.toolName)) return 'file.edit';
      return isNew ? 'tool.started' : 'tool.updated';
    default:
      return 'notice';
  }
}

function sameItem(a: TerminalChatItem, b: TerminalChatItem): boolean {
  return a.text === b.text &&
    a.toolStatus === b.toolStatus &&
    a.toolOutput === b.toolOutput &&
    a.toolName === b.toolName &&
    (a.images?.length ?? 0) === (b.images?.length ?? 0) &&
    a.toolData === b.toolData;
}

export type DraftEvent = Pick<StructuredEvent, 'type' | 'payload'> & { turn?: 'next' };

/**
 * The normalized events between two provider states. `prev` null means a fresh
 * attach: every current item is new. Removed items are not reported (a provider
 * restart drops its items; the journal keeps them as history), except that a
 * live state going from some items to none is a clear.
 */
export function diffStructuredState(prev: StructuredChatState | null, next: StructuredChatState): DraftEvent[] {
  const out: DraftEvent[] = [];
  const before = new Map((prev?.items ?? []).map((item) => [item.id, item]));

  if (prev && prev.items.length > 0 && next.items.length === 0 && prev.status !== 'starting' && next.status !== 'starting') {
    out.push({ type: 'session.cleared', payload: {} });
  }

  if (prev?.status !== 'working' && next.status === 'working') out.push({ type: 'turn.started', payload: {}, turn: 'next' });

  for (const item of next.items) {
    const old = before.get(item.id);
    if (old && sameItem(old, item)) continue;
    out.push({ type: itemEventType(item, !old), payload: { item: journalItem(item) } });
  }

  if (prev?.status === 'working' && next.status !== 'working') {
    out.push({ type: next.status === 'ready' && !next.error ? 'turn.completed' : 'turn.interrupted', payload: { status: next.status } });
  }
  if (next.error && next.error !== prev?.error) out.push({ type: 'error', payload: { message: next.error } });

  if (prev && (prev.model !== next.model || prev.effort !== next.effort || prev.access !== next.access)) {
    out.push({ type: 'config.updated', payload: { model: next.model, effort: next.effort, access: next.access } });
  } else if (!prev && (next.model || next.effort)) {
    out.push({ type: 'config.updated', payload: { model: next.model, effort: next.effort, access: next.access } });
  }
  if (prev && (prev.contextUsed !== next.contextUsed || prev.contextWindow !== next.contextWindow) && next.contextUsed != null) {
    out.push({ type: 'usage.updated', payload: { used: next.contextUsed, window: next.contextWindow } });
  }
  if (next.threadId && next.threadId !== prev?.threadId) out.push({ type: 'native.session', payload: { id: next.threadId } });

  const oldApprovals = new Set((prev?.approvals ?? []).map((a) => String(a.requestId)));
  const newApprovals = new Set(next.approvals.map((a) => String(a.requestId)));
  for (const approval of next.approvals) {
    if (!oldApprovals.has(String(approval.requestId))) {
      out.push({ type: 'approval.requested', payload: { requestId: approval.requestId, kind: approval.kind, title: approval.title } });
    }
  }
  for (const id of oldApprovals) {
    if (!newApprovals.has(id)) out.push({ type: 'approval.resolved', payload: { requestId: id } });
  }
  return out;
}

function foldItems(items: TerminalChatItem[], events: readonly StructuredEvent[]): TerminalChatItem[] {
  let result = items.slice();
  const index = new Map(result.map((item, i) => [item.id, i]));
  for (const event of events) {
    if (event.type === 'session.cleared') {
      result = [];
      index.clear();
      continue;
    }
    const item = event.payload.item as TerminalChatItem | undefined;
    if (!item) continue;
    const at = index.get(item.id);
    const previous = at == null ? undefined : result[at];
    const recordedAt = new Date(event.at);
    const time = item.time ?? previous?.time
      ?? (Number.isFinite(recordedAt.getTime()) ? recordedAt.toISOString() : undefined);
    const next = { ...previous, ...item, time };
    if (at == null) {
      index.set(item.id, result.length);
      result.push(next);
    } else {
      result[at] = next;
    }
  }
  return result.length > MAX_ITEMS ? result.slice(-MAX_ITEMS) : result;
}

export class StructuredEventJournal {
  private base: JournalSnapshot;
  private tail: StructuredEvent[];
  private ids: Set<string>;
  private turnCounter: number;

  constructor(readonly sessionId: string, readonly provider: string, persisted?: PersistedJournal | null) {
    this.base = persisted?.base ?? { seq: 0, items: [] };
    this.tail = persisted?.events?.slice() ?? [];
    this.ids = new Set(this.tail.map((event) => event.id));
    this.turnCounter = (this.base.turns ?? 0) + this.tail.filter((event) => event.type === 'turn.started').length;
  }

  get lastSeq(): number {
    return this.tail.at(-1)?.seq ?? this.base.seq;
  }

  get currentTurnId(): string | null {
    for (let i = this.tail.length - 1; i >= 0; i -= 1) {
      if (this.tail[i].turnId) return this.tail[i].turnId;
    }
    return null;
  }

  /** Record locally produced events, assigning ids, sequence numbers and turns. */
  record(drafts: readonly DraftEvent[], now = Date.now()): StructuredEvent[] {
    const added: StructuredEvent[] = [];
    let turnId = this.currentTurnId;
    for (const draft of drafts) {
      if (draft.turn === 'next') {
        this.turnCounter += 1;
        turnId = `${this.sessionId}:t${this.turnCounter}`;
      }
      const seq = this.lastSeq + 1;
      const event: StructuredEvent = {
        id: `${this.sessionId}:${seq}`,
        sessionId: this.sessionId,
        seq,
        turnId,
        type: draft.type,
        at: now,
        provider: this.provider,
        payload: draft.payload,
      };
      if (this.ingest(event)) added.push(event);
    }
    return added;
  }

  /**
   * Accept an event produced elsewhere (a replay, a reconnecting subscriber).
   * Duplicates and anything at or before the cursor are rejected, so replaying
   * the same range twice is harmless.
   */
  ingest(event: StructuredEvent): boolean {
    if (event.sessionId !== this.sessionId) return false;
    if (this.ids.has(event.id)) return false;
    if (event.seq <= this.lastSeq) return false;
    this.tail.push(event);
    this.ids.add(event.id);
    if (this.tail.length > MAX_TAIL_EVENTS) this.compact();
    return true;
  }

  /** Events after `cursor`, oldest first. Events folded into the snapshot are not replayable. */
  since(cursor: number): StructuredEvent[] {
    return this.tail.filter((event) => event.seq > cursor);
  }

  /** The earliest sequence still replayable as individual events. */
  get replayableFrom(): number {
    return this.base.seq;
  }

  snapshot(): JournalSnapshot {
    return { seq: this.lastSeq, items: foldItems(this.base.items, this.tail), turns: this.turnCounter };
  }

  /**
   * A page of conversation history, newest last. `before` is an item index
   * from a previous page (exclusive); omitted, the newest page is returned.
   */
  history(limit: number, before?: number): { items: TerminalChatItem[]; start: number; hasMore: boolean } {
    const items = this.snapshot().items;
    const end = Math.min(before ?? items.length, items.length);
    const start = Math.max(0, end - limit);
    return { items: items.slice(start, end), start, hasMore: start > 0 };
  }

  /** Fold the tail into the base snapshot. */
  compact(): void {
    const keep = Math.floor(MAX_TAIL_EVENTS / 4);
    const folded = this.tail.slice(0, this.tail.length - keep);
    if (!folded.length) return;
    this.base = {
      seq: folded.at(-1)!.seq,
      items: foldItems(this.base.items, folded),
      turns: (this.base.turns ?? 0) + folded.filter((event) => event.type === 'turn.started').length,
    };
    this.tail = this.tail.slice(folded.length);
    this.ids = new Set(this.tail.map((event) => event.id));
  }

  toJSON(): PersistedJournal {
    let data: PersistedJournal = { v: 1, base: this.base, events: this.tail };
    let text = JSON.stringify(data);
    if (text.length > MAX_PERSISTED_CHARS) {
      this.compact();
      data = { v: 1, base: this.base, events: this.tail };
      text = JSON.stringify(data);
    }
    // Still too big: drop the oldest history until it fits.
    while (text.length > MAX_PERSISTED_CHARS && this.base.items.length > 10) {
      this.base = { ...this.base, items: this.base.items.slice(Math.ceil(this.base.items.length / 4)) };
      data = { v: 1, base: this.base, events: this.tail };
      text = JSON.stringify(data);
    }
    return data;
  }
}
