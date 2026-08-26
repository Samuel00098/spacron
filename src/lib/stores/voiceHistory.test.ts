import { beforeEach, describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  appendConversationTurn,
  clearConversationHistory,
  clearTranscriptionHistory,
  conversationHistory,
  conversationTitle,
  countWords,
  dayLabel,
  deleteTranscriptionEntry,
  endConversationRecord,
  filterConversations,
  filterTranscriptions,
  groupByDay,
  parseDateInput,
  pruneEntries,
  pruneVoiceHistory,
  recordTranscription,
  resolveRange,
  retentionWindowMs,
  startConversationRecord,
  toDateInput,
  transcriptionHistory,
  voiceHistoryRetention,
  withinRange,
  type ConversationEntry,
  type TranscriptionEntry,
} from './voiceHistory';

const DAY = 86_400_000;

beforeEach(() => {
  clearTranscriptionHistory();
  clearConversationHistory();
  voiceHistoryRetention.set('forever');
});

describe('retention', () => {
  it('maps each option to a window, with off = 0 and forever = null', () => {
    expect(retentionWindowMs('off')).toBe(0);
    expect(retentionWindowMs('1d')).toBe(DAY);
    expect(retentionWindowMs('30d')).toBe(30 * DAY);
    expect(retentionWindowMs('forever')).toBeNull();
  });

  it('records nothing while set to off', () => {
    voiceHistoryRetention.set('off');
    expect(recordTranscription({ text: 'hello there', target: 'terminal' })).toBeNull();
    expect(startConversationRecord({ engine: 'openai-realtime' })).toBeNull();
    expect(get(transcriptionHistory)).toHaveLength(0);
  });

  it('clears what is already stored when switched to off', () => {
    recordTranscription({ text: 'keep me', target: 'field' });
    expect(get(transcriptionHistory)).toHaveLength(1);
    voiceHistoryRetention.set('off');
    expect(get(transcriptionHistory)).toHaveLength(0);
  });

  it('drops entries older than the window and keeps the rest', () => {
    const now = Date.UTC(2026, 7, 26, 12);
    recordTranscription({ text: 'ancient', target: 'field', ts: now - 40 * DAY });
    recordTranscription({ text: 'recent', target: 'field', ts: now - 2 * DAY });
    voiceHistoryRetention.set('30d');
    pruneVoiceHistory(now);
    expect(get(transcriptionHistory).map((e) => e.text)).toEqual(['recent']);
  });

  it('ages a conversation by when it ended, not when it started', () => {
    const now = Date.UTC(2026, 7, 26, 12);
    // A long call that began outside the window but finished inside it.
    conversationHistory.set([
      {
        id: 'cv_long',
        startedAt: now - 8 * DAY,
        endedAt: now - 1 * DAY,
        engine: 'openai-realtime',
        turns: [{ role: 'user', text: 'hi', ts: now - 8 * DAY }],
      },
    ]);
    voiceHistoryRetention.set('7d');
    pruneVoiceHistory(now);
    expect(get(conversationHistory)).toHaveLength(1);
  });
});

describe('pruneEntries', () => {
  const stamp = (ts: number) => ({ ts });

  it('returns nothing when the window is zero', () => {
    expect(pruneEntries([stamp(1)], (e) => e.ts, 0, 10, 100)).toEqual([]);
  });

  it('keeps everything inside an unbounded window, up to the cap', () => {
    const entries = [stamp(1), stamp(2), stamp(3)];
    expect(pruneEntries(entries, (e) => e.ts, null, 10, 100)).toHaveLength(3);
    // The cap trims from the FRONT — the oldest are the ones that fall off.
    expect(pruneEntries(entries, (e) => e.ts, null, 2, 100)).toEqual([stamp(2), stamp(3)]);
  });
});

describe('recordTranscription', () => {
  it('counts words and keeps the pre-polish text only when it differs', () => {
    recordTranscription({
      text: 'Ship the release notes.',
      raw: 'ship the release notes',
      target: 'field',
      refined: true,
    });
    const [entry] = get(transcriptionHistory);
    expect(entry.words).toBe(4);
    expect(entry.raw).toBe('ship the release notes');
    expect(entry.refined).toBe(true);
  });

  it('does not store a duplicate original, nor claim a refinement that did not happen', () => {
    recordTranscription({ text: 'same text', raw: 'same text', target: 'terminal', refined: true });
    const [entry] = get(transcriptionHistory);
    expect(entry.raw).toBeUndefined();
    expect(entry.refined).toBe(false);
  });

  it('ignores an empty transcript', () => {
    expect(recordTranscription({ text: '   ', target: 'terminal' })).toBeNull();
    expect(get(transcriptionHistory)).toHaveLength(0);
  });

  it('deletes one entry without touching the others', () => {
    const keep = recordTranscription({ text: 'one', target: 'field' })!;
    const drop = recordTranscription({ text: 'two', target: 'field' })!;
    deleteTranscriptionEntry(drop);
    expect(get(transcriptionHistory).map((e) => e.id)).toEqual([keep]);
  });
});

describe('conversation records', () => {
  it('collects turns and stamps an end time', () => {
    const id = startConversationRecord({ engine: 'xai-realtime', model: 'grok-voice' })!;
    appendConversationTurn(id, 'user', 'spawn an agent', 1000);
    appendConversationTurn(id, 'assistant', 'on it', 2000);
    endConversationRecord(id, 3000);
    const [entry] = get(conversationHistory);
    expect(entry.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(entry.endedAt).toBe(3000);
  });

  it('drops a call that produced nothing', () => {
    const id = startConversationRecord({ engine: 'openai-realtime' })!;
    endConversationRecord(id);
    expect(get(conversationHistory)).toHaveLength(0);
  });

  it('keeps the first end time when the teardown and the transport both close it', () => {
    const id = startConversationRecord({ engine: 'openai-realtime' })!;
    appendConversationTurn(id, 'user', 'hello', 1000);
    endConversationRecord(id, 2000);
    endConversationRecord(id, 9999);
    expect(get(conversationHistory)[0].endedAt).toBe(2000);
  });

  it('no-ops on a null id (history off) and on empty text', () => {
    const id = startConversationRecord({ engine: 'openai-realtime' })!;
    appendConversationTurn(null, 'user', 'lost');
    appendConversationTurn(id, 'user', '   ');
    expect(get(conversationHistory)[0].turns).toHaveLength(0);
  });

  it('titles a conversation from the first thing the user said', () => {
    const entry: ConversationEntry = {
      id: 'cv',
      startedAt: 0,
      engine: 'openai-realtime',
      turns: [
        { role: 'assistant', text: 'Ready when you are.', ts: 1 },
        { role: 'user', text: 'Review the diff', ts: 2 },
      ],
    };
    expect(conversationTitle(entry)).toBe('Review the diff');
  });
});

describe('time ranges', () => {
  // 26 Aug 2026, mid-afternoon local time.
  const now = new Date(2026, 7, 26, 15, 30).getTime();
  const midnight = new Date(2026, 7, 26).getTime();

  it('resolves today as midnight-onwards', () => {
    expect(resolveRange('today', now)).toEqual({ from: midnight, to: null });
  });

  it('resolves yesterday as a closed single day', () => {
    expect(resolveRange('yesterday', now)).toEqual({ from: midnight - DAY, to: midnight });
  });

  it('counts the last 7 days inclusive of today', () => {
    expect(resolveRange('7d', now)).toEqual({ from: midnight - 6 * DAY, to: null });
  });

  it('leaves all-time unbounded', () => {
    expect(resolveRange('all', now)).toEqual({ from: null, to: null });
  });

  it('treats a custom end date as the whole of that day', () => {
    const range = resolveRange('custom', now, { from: '2026-08-20', to: '2026-08-22' });
    expect(range.from).toBe(new Date(2026, 7, 20).getTime());
    expect(range.to).toBe(new Date(2026, 7, 23).getTime());
    // 23:59 on the end day is still inside the range.
    expect(withinRange(new Date(2026, 7, 22, 23, 59).getTime(), range)).toBe(true);
    // …but the first minute of the next day is not.
    expect(withinRange(new Date(2026, 7, 23, 0, 1).getTime(), range)).toBe(false);
  });

  it('parses a date input as LOCAL midnight, not UTC', () => {
    expect(parseDateInput('2026-08-26')).toBe(new Date(2026, 7, 26).getTime());
    expect(parseDateInput('not-a-date')).toBeNull();
    expect(toDateInput(new Date(2026, 7, 6, 23, 0).getTime())).toBe('2026-08-06');
  });
});

describe('filtering', () => {
  const now = new Date(2026, 7, 26, 15, 30).getTime();

  function tx(text: string, ts: number, targetLabel?: string): TranscriptionEntry {
    return { id: `tx${ts}`, ts, text, target: 'field', targetLabel, words: countWords(text), refined: false };
  }

  it('returns newest first, inside the range only', () => {
    const entries = [
      tx('older', now - 3 * DAY),
      tx('newest', now - 1000),
      tx('ancient', now - 40 * DAY),
    ];
    const result = filterTranscriptions(entries, resolveRange('7d', now));
    expect(result.map((e) => e.text)).toEqual(['newest', 'older']);
  });

  it('searches the text and the destination label', () => {
    const entries = [tx('deploy the site', now, 'Terminal 3'), tx('write the changelog', now, 'Editor')];
    expect(filterTranscriptions(entries, resolveRange('all', now), 'DEPLOY')).toHaveLength(1);
    expect(filterTranscriptions(entries, resolveRange('all', now), 'terminal')).toHaveLength(1);
    expect(filterTranscriptions(entries, resolveRange('all', now), 'nothing')).toHaveLength(0);
  });

  it('searches inside a conversation transcript', () => {
    const entries: ConversationEntry[] = [
      {
        id: 'cv1',
        startedAt: now - 1000,
        endedAt: now,
        engine: 'openai-realtime',
        projectName: 'spacron',
        turns: [{ role: 'user', text: 'refactor the parser', ts: now - 900 }],
      },
    ];
    expect(filterConversations(entries, resolveRange('today', now), 'parser')).toHaveLength(1);
    expect(filterConversations(entries, resolveRange('today', now), 'spacron')).toHaveLength(1);
    expect(filterConversations(entries, resolveRange('yesterday', now), 'parser')).toHaveLength(0);
  });
});

describe('display helpers', () => {
  const now = new Date(2026, 7, 26, 15, 30).getTime();

  it('names today and yesterday', () => {
    expect(dayLabel(now - 1000, now)).toBe('Today');
    expect(dayLabel(new Date(2026, 7, 25, 9).getTime(), now)).toBe('Yesterday');
  });

  it('groups a sorted list into consecutive day buckets', () => {
    const entries = [
      { ts: now - 1000 },
      { ts: now - 2000 },
      { ts: new Date(2026, 7, 25, 9).getTime() },
    ];
    const groups = groupByDay(entries, (e) => e.ts, now);
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
    ]);
  });
});
