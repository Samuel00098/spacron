import { useStore } from '$lib/react/useStore';
import {
  transcriptionLevel,
  transcriptionState,
  transcriptionTarget,
  transcriptionWordCount,
} from '$lib/services/transcription-hotkey';
import { formatShortcutLabel } from '$lib/utils/shortcut-label';
import './TranscriptionIndicator.css';

// Colors mapped across the meter bars to create a vibrant spectrum
const SPECTRUM_BAR_COLORS = [
  '#00f5d4', // electric mint cyan
  '#3b82f6', // cobalt blue
  '#8b5cf6', // vivid violet
  '#ec4899', // hot pink
  '#fb923c', // sunset coral
];

// Bars are struck at different fractions of the level so the meter reads as a
// waveform rather than five copies of one value. Centre bar is the tallest.
const BAR_WEIGHTS = [0.45, 0.75, 1, 0.8, 0.5];
// Speech lands roughly between 0.02 and 0.2 RMS with the browser's AGC on.
// Normalizing against the top of that band keeps the meter lively at a normal
// speaking volume instead of pinning or barely moving.
const LEVEL_FULL_SCALE = 0.15;

/**
 * Ambient status pill for the dictation hotkey. Rendered at the app root so it
 * is visible over any room; purely informational (no pointer events) — the
 * hotkey and Escape drive the lifecycle.
 *
 * It stays up for the WHOLE dictation. Pauses do not end a dictation, so the
 * pill sitting there is the thing that tells you the mic is still open and
 * your sentence is still being collected.
 *
 * The live meter is not decoration. A muted mic, one aimed at the wrong input
 * device, or a browser that handed back a dead track all look exactly like a
 * working dictation until the transcript comes back empty; bars that never
 * move say which of those it is while there is still time to fix it.
 */
export default function TranscriptionIndicator() {
  const state = useStore(transcriptionState);
  const level = useStore(transcriptionLevel);
  const words = useStore(transcriptionWordCount);
  const target = useStore(transcriptionTarget);
  if (state === 'idle') return null;

  // Dictation aimed at the chat composer has its own indicator inside that
  // composer (mode-contextual by design) — never render both.
  if (target?.kind === 'chat') return null;

  const listening = state === 'listening';
  const amplitude = Math.min(1, Math.max(0, level / LEVEL_FULL_SCALE));
  // Strip verbose placeholder hints ("Message X · / for commands, @ for files")
  // so the ambient pill stays short and scannable.
  const shortTarget = target?.label
    ? target.label.split(/\s+[·—–]\s+/)[0].replace(/^Message\s+/i, '').trim()
    : '';

  return (
    <div className={`transcription-indicator ${state}`} role="status" aria-live="polite">
      {listening ? (
        <span className="meter" aria-hidden="true">
          {BAR_WEIGHTS.map((weight, index) => {
            const color = SPECTRUM_BAR_COLORS[index % SPECTRUM_BAR_COLORS.length];
            return (
              <span
                key={index}
                className="bar"
                // 18% keeps a resting bar visible, so "silent" still looks alive.
                style={{
                  transform: `scaleY(${0.18 + amplitude * weight * 0.82})`,
                  backgroundColor: color,
                  boxShadow: `0 0 6px ${color}88`,
                }}
              />
            );
          })}
        </span>
      ) : (
        <span className="dot" />
      )}
      <span className="label">
        {listening ? `Listening${shortTarget ? ` · ${shortTarget}` : ''}` : 'Transcribing…'}
      </span>
      {words > 0 && (
        <span className="count">
          {words}w
        </span>
      )}
      {listening && (
        <span className="hint">
          <kbd className="key">Esc</kbd> finish · <kbd className="key">{formatShortcutLabel('Ctrl+Esc')}</kbd> cancel
        </span>
      )}
    </div>
  );
}
