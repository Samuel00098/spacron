import { useStore } from '$lib/react/useStore';
import {
  transcriptionLevel,
  transcriptionState,
  transcriptionWordCount,
} from '$lib/services/transcription-hotkey';
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
  if (state === 'idle') return null;

  const listening = state === 'listening';
  const amplitude = Math.min(1, Math.max(0, level / LEVEL_FULL_SCALE));

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
      {/* Processing covers the final STT drain (and the optional AI polish), so
        * "Sending to terminal" was a promise the label couldn't keep — it also
        * showed while dictating into a text field. */}
      <span className="label">{listening ? 'Listening' : 'Transcribing…'}</span>
      {words > 0 && (
        <span className="count">
          {words} word{words === 1 ? '' : 's'}
        </span>
      )}
      {listening && (
        <span className="hint">
          again to send · <kbd className="key">Esc</kbd> to cancel
        </span>
      )}
    </div>
  );
}
