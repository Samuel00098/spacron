import { get, writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

/**
 * Voice history — the record of what was actually said.
 *
 * Two separate logs, deliberately never merged (the WhisperFlow / Typeless
 * split):
 *
 *  - **Transcriptions** — every dictation. One entry per delivered dictation
 *    (`transcription-hotkey.ts` and the Tasks panel's per-field dictation),
 *    with where it landed and whether the AI polish pass touched it.
 *  - **Conversations** — every realtime speech-to-speech call
 *    (`realtime-voice.ts`, driven from the floating prompt bar). One entry per
 *    call, holding the whole back-and-forth as turns.
 *
 * They answer different questions ("what did I dictate into that file?" vs
 * "what did I ask the agent to do?"), so keeping one list with a `kind` field
 * would only mean filtering it apart again in every consumer.
 *
 * ## Why retention lives HERE and not in `stores/settings.ts`
 *
 * `voiceHistoryRetention` is a persisted preference like any other, but this
 * module is imported by `transcription-hotkey.ts`, whose unit tests mock
 * `$lib/stores/settings` down to the two exports that service reads. Pulling
 * the retention setting from there would make this module explode at import
 * time under those mocks. It is self-contained instead: one localStorage key,
 * same pattern as `previewHistory.ts` / `runHistory.ts`, and the Settings UI
 * imports it from here.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Where a dictation was delivered. */
export type TranscriptionTarget = 'terminal' | 'field' | 'task';

export interface TranscriptionEntry {
  id: string;
  /** When the dictation was delivered. */
  ts: number;
  /** The text that actually landed. */
  text: string;
  /**
   * The mechanical-cleanup text, kept only when the AI polish pass changed it.
   * Lets the user see what they really said versus what was written for them.
   */
  raw?: string;
  target: TranscriptionTarget;
  /** Human label for the destination — "Terminal 3", "New To Do task". */
  targetLabel?: string;
  /** Voice input provider id at capture time ("local", "openai", …). */
  provider?: string;
  /** Wall-clock length of the dictation, when the caller knows it. */
  durationMs?: number;
  /** Word count of `text`, precomputed so lists don't recount on every render. */
  words: number;
  /** True when the AI polish pass rewrote the transcript. */
  refined: boolean;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface ConversationEntry {
  id: string;
  startedAt: number;
  /** Set when the call ends; absent while it is still live. */
  endedAt?: number;
  /** Engine id — 'openai-realtime' / 'openai-live' / 'xai-realtime'. */
  engine: string;
  model?: string;
  projectId?: string;
  projectName?: string;
  turns: ConversationTurn[];
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * How long history is kept. `'off'` records nothing at all (and clears what is
 * already there on the next prune), `'forever'` keeps everything up to the
 * safety caps below.
 */
export type VoiceHistoryRetention = 'off' | '1d' | '7d' | '30d' | '90d' | '365d' | 'forever';

export const retentionOptions: { id: VoiceHistoryRetention; label: string }[] = [
  { id: 'off', label: "Don't save" },
  { id: '1d', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '365d', label: '1 year' },
  { id: 'forever', label: 'Forever' },
];

const DAY_MS = 86_400_000;

/**
 * Retention as a millisecond window. `0` means "record nothing",
 * `null` means "no age limit".
 */
export function retentionWindowMs(retention: VoiceHistoryRetention): number | null {
  switch (retention) {
    case 'off': return 0;
    case '1d': return DAY_MS;
    case '7d': return 7 * DAY_MS;
    case '30d': return 30 * DAY_MS;
    case '90d': return 90 * DAY_MS;
    case '365d': return 365 * DAY_MS;
    default: return null;
  }
}

const RETENTION_KEY = 'spacron_voice_history_retention';
const TRANSCRIPTION_KEY = 'spacron_transcription_history';
const CONVERSATION_KEY = 'spacron_conversation_history';

/**
 * Safety caps, applied on top of the age window. `'forever'` is a promise about
 * time, not about disk: this all lives in localStorage (a few MB for the whole
 * app), so the oldest entries still fall off the end once a log gets this long.
 */
const MAX_TRANSCRIPTIONS = 1000;
const MAX_CONVERSATIONS = 200;
const MAX_TURNS_PER_CONVERSATION = 400;
/** Per-field text cap — a runaway STT loop must not eat the whole quota. */
const MAX_TEXT_CHARS = 8000;

function loadRetention(): VoiceHistoryRetention {
  if (typeof window === 'undefined') return 'forever';
  try {
    const raw = localStorage.getItem(RETENTION_KEY);
    if (raw && retentionOptions.some((o) => o.id === raw)) return raw as VoiceHistoryRetention;
  } catch { /* private mode */ }
  return 'forever';
}

export const voiceHistoryRetention = writable<VoiceHistoryRetention>(loadRetention());

// ── The two logs ─────────────────────────────────────────────────────────────

export const transcriptionHistory = writable<TranscriptionEntry[]>(
  loadJson<TranscriptionEntry[]>(TRANSCRIPTION_KEY, [])
);

export const conversationHistory = writable<ConversationEntry[]>(
  loadJson<ConversationEntry[]>(CONVERSATION_KEY, [])
);

transcriptionHistory.subscribe((entries) => {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(TRANSCRIPTION_KEY, JSON.stringify(entries)); } catch { /* quota */ }
});

conversationHistory.subscribe((entries) => {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(CONVERSATION_KEY, JSON.stringify(entries)); } catch { /* quota */ }
});

/**
 * Persist the retention choice and re-apply it. Subscribed HERE, below the two
 * logs, and not next to the store itself: a store's subscriber fires once
 * synchronously on subscribe, so from up there this would have reached
 * `transcriptionHistory` before its `const` was initialised (a TDZ crash on
 * import, in the browser only — under Node the persistence guard hid it).
 *
 * That first synchronous call is also what folds away whatever aged out while
 * the app was closed, so there is no separate load-time prune.
 */
voiceHistoryRetention.subscribe((value) => {
  if (typeof window !== 'undefined') {
    try { localStorage.setItem(RETENTION_KEY, value); } catch { /* quota */ }
  }
  // Shortening the window (or switching to "Don't save") must take effect on
  // what is already stored, not just on what is recorded next.
  pruneVoiceHistory();
});

// ── Pruning ──────────────────────────────────────────────────────────────────

/** Drop anything older than the window and anything past the count cap. */
export function pruneEntries<T>(
  entries: T[],
  timeOf: (entry: T) => number,
  window: number | null,
  cap: number,
  now: number
): T[] {
  if (window === 0) return [];
  const cutoff = window === null ? null : now - window;
  const kept = cutoff === null ? entries : entries.filter((e) => timeOf(e) >= cutoff);
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

/**
 * Apply the retention window to both logs. Called on load, after every append,
 * and whenever the retention setting changes.
 */
export function pruneVoiceHistory(now: number = Date.now()): void {
  const window = retentionWindowMs(get(voiceHistoryRetention));
  transcriptionHistory.update((all) => {
    const next = pruneEntries(all, (e) => e.ts, window, MAX_TRANSCRIPTIONS, now);
    return next.length === all.length ? all : next;
  });
  conversationHistory.update((all) => {
    // A conversation is aged by when it ENDED — a long call started before the
    // cutoff but finished inside it is still recent history.
    const next = pruneEntries(all, (e) => e.endedAt ?? e.startedAt, window, MAX_CONVERSATIONS, now);
    return next.length === all.length ? all : next;
  });
}

// ── Recording ────────────────────────────────────────────────────────────────

let idCounter = 0;
function historyId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function recordingDisabled(): boolean {
  return get(voiceHistoryRetention) === 'off';
}

/**
 * Log one delivered dictation. Returns the entry id, or `null` when history is
 * turned off or the transcript was empty.
 */
export function recordTranscription(input: {
  text: string;
  raw?: string;
  target: TranscriptionTarget;
  targetLabel?: string;
  provider?: string;
  durationMs?: number;
  refined?: boolean;
  ts?: number;
}): string | null {
  const text = input.text.trim();
  if (!text || recordingDisabled()) return null;
  const raw = input.raw?.trim();
  const entry: TranscriptionEntry = {
    id: historyId('tx'),
    ts: input.ts ?? Date.now(),
    text: clip(text),
    // Only worth keeping when the polish pass actually changed the words.
    ...(raw && raw !== text ? { raw: clip(raw) } : {}),
    target: input.target,
    ...(input.targetLabel ? { targetLabel: input.targetLabel } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(typeof input.durationMs === 'number' && input.durationMs > 0
      ? { durationMs: Math.round(input.durationMs) }
      : {}),
    words: countWords(text),
    refined: Boolean(input.refined && raw && raw !== text),
  };
  transcriptionHistory.update((all) => [...all, entry]);
  pruneVoiceHistory();
  return entry.id;
}

/**
 * Open a conversation record for a realtime call. Returns the id the turn
 * appenders need, or `null` when history is off — callers treat `null` as
 * "don't bother recording" and every function below no-ops on it.
 */
export function startConversationRecord(input: {
  engine: string;
  model?: string;
  projectId?: string;
  projectName?: string;
  startedAt?: number;
}): string | null {
  if (recordingDisabled()) return null;
  const entry: ConversationEntry = {
    id: historyId('cv'),
    startedAt: input.startedAt ?? Date.now(),
    engine: input.engine,
    ...(input.model ? { model: input.model } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.projectName ? { projectName: input.projectName } : {}),
    turns: [],
  };
  conversationHistory.update((all) => [...all, entry]);
  return entry.id;
}

/** Append one side of an exchange to a live conversation record. */
export function appendConversationTurn(
  id: string | null,
  role: 'user' | 'assistant',
  text: string,
  ts: number = Date.now()
): void {
  const trimmed = text.trim();
  if (!id || !trimmed) return;
  conversationHistory.update((all) =>
    all.map((entry) => {
      if (entry.id !== id) return entry;
      const turns = [...entry.turns, { role, text: clip(trimmed), ts }];
      return {
        ...entry,
        turns: turns.length > MAX_TURNS_PER_CONVERSATION
          ? turns.slice(turns.length - MAX_TURNS_PER_CONVERSATION)
          : turns,
      };
    })
  );
}

/**
 * Close a conversation record. A call that connected and produced nothing (a
 * mis-tap of the voice gesture, a failed handshake) is dropped rather than
 * kept as an empty row.
 */
export function endConversationRecord(id: string | null, endedAt: number = Date.now()): void {
  if (!id) return;
  conversationHistory.update((all) => {
    const entry = all.find((e) => e.id === id);
    // Already closed: the teardown path and the transport's own `onEnded` can
    // both land, and the first one owns the end time.
    if (!entry || entry.endedAt) return all;
    if (entry.turns.length === 0) return all.filter((e) => e.id !== id);
    return all.map((e) => (e.id === id ? { ...e, endedAt } : e));
  });
  pruneVoiceHistory();
}

// ── Deleting ─────────────────────────────────────────────────────────────────

export function deleteTranscriptionEntry(id: string): void {
  transcriptionHistory.update((all) => all.filter((e) => e.id !== id));
}

export function deleteConversationEntry(id: string): void {
  conversationHistory.update((all) => all.filter((e) => e.id !== id));
}

export function clearTranscriptionHistory(): void {
  transcriptionHistory.set([]);
}

export function clearConversationHistory(): void {
  conversationHistory.set([]);
}

// ── Time ranges ──────────────────────────────────────────────────────────────

export type VoiceHistoryRangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom';

export const rangePresets: { id: VoiceHistoryRangePreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

/** Inclusive-from, exclusive-to bounds. `null` on either side means unbounded. */
export type VoiceHistoryRange = { from: number | null; to: number | null };

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Parse a `<input type="date">` value ("2026-08-26") as LOCAL midnight.
 * `new Date('2026-08-26')` parses as UTC, which shifts the boundary by the
 * timezone offset and silently drops (or adds) a day's worth of entries.
 */
export function parseDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** Format a timestamp back into a `<input type="date">` value, in local time. */
export function toDateInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Resolve a preset (plus the two custom-range inputs) into concrete bounds.
 * The custom `to` day is inclusive — picking the same day twice means "that
 * whole day", so the upper bound is the start of the NEXT day.
 */
export function resolveRange(
  preset: VoiceHistoryRangePreset,
  now: number = Date.now(),
  custom?: { from?: string; to?: string }
): VoiceHistoryRange {
  const today = startOfLocalDay(now);
  switch (preset) {
    case 'today':
      return { from: today, to: null };
    case 'yesterday':
      return { from: today - DAY_MS, to: today };
    case '7d':
      return { from: today - 6 * DAY_MS, to: null };
    case '30d':
      return { from: today - 29 * DAY_MS, to: null };
    case 'custom': {
      const from = custom?.from ? parseDateInput(custom.from) : null;
      const toDay = custom?.to ? parseDateInput(custom.to) : null;
      return { from, to: toDay === null ? null : toDay + DAY_MS };
    }
    default:
      return { from: null, to: null };
  }
}

export function withinRange(ts: number, range: VoiceHistoryRange): boolean {
  if (range.from !== null && ts < range.from) return false;
  if (range.to !== null && ts >= range.to) return false;
  return true;
}

// ── Querying ─────────────────────────────────────────────────────────────────

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/** Newest-first transcriptions inside `range`, optionally text-filtered. */
export function filterTranscriptions(
  entries: TranscriptionEntry[],
  range: VoiceHistoryRange,
  query = ''
): TranscriptionEntry[] {
  const needle = query.trim().toLowerCase();
  return entries
    .filter((e) => withinRange(e.ts, range))
    .filter((e) => !needle || matches(e.text, needle) || matches(e.targetLabel ?? '', needle))
    .sort((a, b) => b.ts - a.ts);
}

/**
 * Newest-first conversations inside `range`, optionally text-filtered.
 * A conversation is in range if it ENDED in it (or, while still live, started
 * in it) — the same rule pruning ages them by.
 */
export function filterConversations(
  entries: ConversationEntry[],
  range: VoiceHistoryRange,
  query = ''
): ConversationEntry[] {
  const needle = query.trim().toLowerCase();
  return entries
    .filter((e) => withinRange(e.endedAt ?? e.startedAt, range))
    .filter(
      (e) =>
        !needle ||
        matches(e.projectName ?? '', needle) ||
        e.turns.some((t) => matches(t.text, needle))
    )
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
}

/** The first thing said in a call — the closest thing it has to a title. */
export function conversationTitle(entry: ConversationEntry): string {
  const firstUser = entry.turns.find((t) => t.role === 'user');
  const text = (firstUser ?? entry.turns[0])?.text ?? 'Voice conversation';
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** "Today" / "Yesterday" / a weekday inside the last week / a full date. */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const day = startOfLocalDay(ts);
  const today = startOfLocalDay(now);
  if (day === today) return 'Today';
  if (day === today - DAY_MS) return 'Yesterday';
  const date = new Date(ts);
  if (today - day < 7 * DAY_MS) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Group an already-sorted list into day buckets for a sectioned list. */
export function groupByDay<T>(
  entries: T[],
  timeOf: (entry: T) => number,
  now: number = Date.now()
): { label: string; entries: T[] }[] {
  const groups: { label: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const label = dayLabel(timeOf(entry), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}
