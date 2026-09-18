import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dropdown from '$lib/components/shared/Dropdown.tsx';
import { useStore } from '$lib/react/useStore';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { showToast } from '$lib/stores/notification';
import {
  clearConversationHistory,
  clearTranscriptionHistory,
  clockLabel,
  conversationHistory,
  conversationTitle,
  deleteConversationEntry,
  deleteTranscriptionEntry,
  durationLabel,
  filterConversations,
  filterTranscriptions,
  groupByDay,
  pruneVoiceHistory,
  rangePresets,
  resolveRange,
  retentionOptions,
  toDateInput,
  transcriptionHistory,
  voiceHistoryRetention,
  type ConversationEntry,
  type TranscriptionEntry,
  type VoiceHistoryRangePreset,
  type VoiceHistoryRetention,
} from '$lib/stores/voiceHistory';
import './VoiceHistoryPanel.css';

/**
 * Settings → Voice → History.
 *
 * Two logs the user can go back through: every dictation, and every realtime
 * conversation. They are read from `stores/voiceHistory`, which also owns the
 * retention window — this component only chooses a time range and renders.
 *
 * The `<Dropdown>`s are the shared portaled one (never a native `<select>`):
 * native popups detach under the app's CSS zoom, and the settings modal is
 * exactly where that shows up. See the `modal-containing-block-gotcha` note.
 */

const SETTINGS_BOUNDARY = '.settings-modal';
const DAY_MS = 86_400_000;

type HistoryKind = 'transcriptions' | 'conversations';

const TARGET_LABELS: Record<string, string> = {
  terminal: 'Terminal',
  field: 'Text field',
  task: 'Task',
};

const PROVIDER_LABELS: Record<string, string> = {
  webspeech: 'System speech',
  google: 'Gemini',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  local: 'On-device',
};

const ENGINE_LABELS: Record<string, string> = {
  'openai-realtime': 'GPT Realtime',
  'openai-live': 'GPT Live',
  'xai-realtime': 'Grok Realtime',
};

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

/**
 * "Clear all" behind one deliberate second click. History is the only copy of
 * what was said — a mis-click must not be able to erase months of it, and the
 * app has no undo for a store wipe.
 */
function ClearAllButton({ label, onClear }: { label: string; onClear: () => void }) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const disarm = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  };

  return (
    <button
      type="button"
      className={`vh-clear${armed ? ' armed' : ''}`}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          // Long enough to read the new label and decide, short enough that a
          // stale armed button can't be erased by a later stray click.
          timerRef.current = setTimeout(() => setArmed(false), 6000);
          return;
        }
        disarm();
        onClear();
      }}
      onBlur={disarm}
    >
      {armed ? 'Click again to erase' : label}
    </button>
  );
}

function TranscriptionRow({ entry }: { entry: TranscriptionEntry }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const meta = [
    entry.targetLabel ?? TARGET_LABELS[entry.target] ?? entry.target,
    `${entry.words} ${entry.words === 1 ? 'word' : 'words'}`,
    entry.durationMs ? durationLabel(entry.durationMs) : null,
    entry.provider ? PROVIDER_LABELS[entry.provider] ?? entry.provider : null,
  ].filter(Boolean) as string[];

  return (
    <article className="vh-row">
      <div className="vh-row-head">
        <time className="vh-time">{clockLabel(entry.ts)}</time>
        <span className={`vh-chip vh-chip-${entry.target}`}>
          {TARGET_LABELS[entry.target] ?? entry.target}
        </span>
        <span className="vh-meta">{meta.join(' · ')}</span>
        <div className="vh-row-actions">
          {entry.raw && (
            <button
              type="button"
              className={`vh-icon-btn vh-text-btn${showOriginal ? ' on' : ''}`}
              onClick={() => setShowOriginal((v) => !v)}
              title="Show what you actually said, before the AI polish pass"
            >
              {showOriginal ? 'Polished' : 'Original'}
            </button>
          )}
          <button
            type="button"
            className="vh-icon-btn"
            aria-label="Copy transcript"
            title="Copy"
            onClick={() => {
              void copyTextToClipboard(entry.text)
                .then(() => showToast('Transcript copied.', 'success'))
                .catch(() => showToast('Could not copy the transcript.', 'error'));
            }}
          >
            <CopyIcon />
          </button>
          <button
            type="button"
            className="vh-icon-btn vh-danger"
            aria-label="Delete transcript"
            title="Delete"
            onClick={() => deleteTranscriptionEntry(entry.id)}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      <p className="vh-text">{showOriginal && entry.raw ? entry.raw : entry.text}</p>
    </article>
  );
}

function ConversationRow({ entry }: { entry: ConversationEntry }) {
  // Conversation history is primarily a record of both sides of the exchange.
  // Keep the turns visible when the user opens the Conversations view instead
  // of making them discover a second Transcript click for every call.
  const [open, setOpen] = useState(true);
  const duration = entry.endedAt ? entry.endedAt - entry.startedAt : 0;
  const meta = [
    ENGINE_LABELS[entry.engine] ?? entry.engine,
    entry.projectName ?? null,
    `${entry.turns.length} ${entry.turns.length === 1 ? 'turn' : 'turns'}`,
    duration > 0 ? durationLabel(duration) : null,
  ].filter(Boolean) as string[];

  const asText = () =>
    entry.turns
      .map((turn) => `${turn.role === 'user' ? 'You' : 'Assistant'}: ${turn.text}`)
      .join('\n\n');

  return (
    <article className={`vh-row${open ? ' open' : ''}`}>
      <div className="vh-row-head">
        <time className="vh-time">{clockLabel(entry.startedAt)}</time>
        <span className="vh-chip vh-chip-conversation">Call</span>
        <span className="vh-meta">{meta.join(' · ')}</span>
        <div className="vh-row-actions">
          <button
            type="button"
            className="vh-icon-btn vh-text-btn"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? 'Hide' : 'Transcript'}
          </button>
          <button
            type="button"
            className="vh-icon-btn"
            aria-label="Copy conversation"
            title="Copy"
            onClick={() => {
              void copyTextToClipboard(asText())
                .then(() => showToast('Conversation copied.', 'success'))
                .catch(() => showToast('Could not copy the conversation.', 'error'));
            }}
          >
            <CopyIcon />
          </button>
          <button
            type="button"
            className="vh-icon-btn vh-danger"
            aria-label="Delete conversation"
            title="Delete"
            onClick={() => deleteConversationEntry(entry.id)}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      {open ? (
        <div className="vh-turns">
          {entry.turns.map((turn, index) => (
            <div key={`${entry.id}_${index}`} className={`vh-turn vh-turn-${turn.role}`}>
              <span className="vh-turn-who">{turn.role === 'user' ? 'You' : 'Assistant'}</span>
              <p>{turn.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="vh-text">{conversationTitle(entry)}</p>
      )}
    </article>
  );
}

export default function VoiceHistoryPanel() {
  const transcriptions = useStore(transcriptionHistory);
  const conversations = useStore(conversationHistory);
  const retention = useStore(voiceHistoryRetention);

  const [kind, setKind] = useState<HistoryKind>('conversations');
  const [preset, setPreset] = useState<VoiceHistoryRangePreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [query, setQuery] = useState('');

  // Anchored once per mount so "Today" can't shift under the list while the
  // user is reading it, and so the memos below don't re-run on every render.
  const now = useMemo(() => Date.now(), []);

  // Fold away whatever aged out while the app was closed or the modal shut.
  useEffect(() => { pruneVoiceHistory(); }, []);

  const selectPreset = useCallback((value: string) => {
    const next = value as VoiceHistoryRangePreset;
    // Seed the custom pickers with the last week so switching to "Custom"
    // shows a real range instead of an empty (and therefore unbounded) one.
    if (next === 'custom') {
      setCustomFrom((current) => current || toDateInput(Date.now() - 6 * DAY_MS));
      setCustomTo((current) => current || toDateInput(Date.now()));
    }
    setPreset(next);
  }, []);

  const range = useMemo(
    () => resolveRange(preset, now, { from: customFrom, to: customTo }),
    [preset, now, customFrom, customTo]
  );

  const visibleTranscriptions = useMemo(
    () => filterTranscriptions(transcriptions, range, query),
    [transcriptions, range, query]
  );
  const visibleConversations = useMemo(
    () => filterConversations(conversations, range, query),
    [conversations, range, query]
  );

  const transcriptionGroups = useMemo(
    () => groupByDay(visibleTranscriptions, (e) => e.ts, now),
    [visibleTranscriptions, now]
  );
  const conversationGroups = useMemo(
    () => groupByDay(visibleConversations, (e) => e.endedAt ?? e.startedAt, now),
    [visibleConversations, now]
  );

  const showingTranscriptions = kind === 'transcriptions';
  const total = showingTranscriptions ? transcriptions.length : conversations.length;
  const shown = showingTranscriptions ? visibleTranscriptions.length : visibleConversations.length;
  const groups = showingTranscriptions ? transcriptionGroups : conversationGroups;

  const emptyMessage = (() => {
    if (retention === 'off') {
      return 'History is turned off, so nothing is being saved. Pick a retention period below to start keeping it.';
    }
    if (total === 0) {
      return showingTranscriptions
        ? 'No dictations yet. Press the transcription hotkey and speak, and everything you dictate lands here.'
        : 'No conversations yet. Tap left Alt (or press Ctrl+Shift+M) to start a voice call, and each one is logged here.';
    }
    return query.trim()
      ? 'Nothing matches that search in this time period.'
      : 'Nothing in this time period.';
  })();

  return (
    <div className="voice-history">
      <div className="vh-head">
        <div>
          <h3 className="vh-title">Voice history</h3>
          <p className="vh-sub">
            Everything you have dictated and every voice conversation, kept separately.
          </p>
        </div>
        <div className="vh-kind-switch" role="tablist" aria-label="History type">
          {([
            { id: 'transcriptions' as const, label: 'Transcriptions', count: transcriptions.length },
            { id: 'conversations' as const, label: 'Conversations', count: conversations.length },
          ]).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={kind === tab.id}
              className={`vh-kind-btn${kind === tab.id ? ' active' : ''}`}
              onClick={() => setKind(tab.id)}
            >
              {tab.label}
              <span className="vh-count">{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="settings-card">
        <div className="vh-toolbar">
          <div className="vh-control">
            <span className="vh-control-label">Period</span>
            <Dropdown
              options={rangePresets.map((p) => ({ value: p.id, label: p.label }))}
              value={preset}
              onChange={selectPreset}
              ariaLabel="Time period"
              boundarySelector={SETTINGS_BOUNDARY}
            />
          </div>
          {preset === 'custom' && (
            <div className="vh-control vh-dates">
              <span className="vh-control-label">From / to</span>
              <div className="vh-date-inputs">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  aria-label="From date"
                />
                <span className="vh-date-dash">–</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(event) => setCustomTo(event.target.value)}
                  aria-label="To date"
                />
              </div>
            </div>
          )}
          <div className="vh-control vh-search">
            <span className="vh-control-label">Search</span>
            <input
              type="search"
              value={query}
              placeholder={showingTranscriptions ? 'Find a dictation…' : 'Find something that was said…'}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
              aria-label="Search history"
            />
          </div>
        </div>

        <div className="vh-list">
          {shown === 0 ? (
            <p className="vh-empty">{emptyMessage}</p>
          ) : (
            groups.map((group) => (
              <div className="vh-group" key={group.label}>
                <div className="vh-group-label">
                  {group.label}
                  <span>{group.entries.length}</span>
                </div>
                {showingTranscriptions
                  ? (group.entries as TranscriptionEntry[]).map((entry) => (
                      <TranscriptionRow key={entry.id} entry={entry} />
                    ))
                  : (group.entries as ConversationEntry[]).map((entry) => (
                      <ConversationRow key={entry.id} entry={entry} />
                    ))}
              </div>
            ))
          )}
        </div>

        {shown > 0 && shown !== total && (
          <p className="vh-count-note">
            Showing {shown} of {total} saved {showingTranscriptions ? 'dictations' : 'conversations'}.
          </p>
        )}
      </section>

      <section className="settings-card">
        <h3>Storage</h3>
        <div className="settings-card-body">
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Keep history for</span>
              <small>
                Applies to both logs. Anything older is deleted automatically, here and on
                disk. “Don’t save” stops recording and clears what is already stored.
              </small>
            </div>
            <div className="settings-control">
              <Dropdown
                options={retentionOptions.map((o) => ({ value: o.id, label: o.label }))}
                value={retention}
                onChange={(value) => voiceHistoryRetention.set(value as VoiceHistoryRetention)}
                ariaLabel="History retention"
                boundarySelector={SETTINGS_BOUNDARY}
              />
            </div>
          </div>
          <div className="settings-control-row">
            <div className="settings-control-copy">
              <span>Erase history</span>
              <small>
                {transcriptions.length} {transcriptions.length === 1 ? 'dictation' : 'dictations'} and{' '}
                {conversations.length} {conversations.length === 1 ? 'conversation' : 'conversations'} stored
                on this machine. Nothing here is ever uploaded.
              </small>
            </div>
            <div className="settings-control vh-clear-actions">
              <ClearAllButton
                label="Clear transcriptions"
                onClear={() => {
                  clearTranscriptionHistory();
                  showToast('Transcription history cleared.', 'info');
                }}
              />
              <ClearAllButton
                label="Clear conversations"
                onClear={() => {
                  clearConversationHistory();
                  showToast('Conversation history cleared.', 'info');
                }}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
