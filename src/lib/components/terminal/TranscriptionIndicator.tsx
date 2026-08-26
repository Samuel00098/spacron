import { useStore } from '$lib/react/useStore';
import { transcriptionState } from '$lib/services/transcription-hotkey';
import './TranscriptionIndicator.css';

/**
 * Ambient status pill for the Transcribe-to-Terminal hotkey. Rendered at the
 * app root so it is visible over any room; purely informational (no pointer
 * events) — Escape and the hotkey itself drive the lifecycle.
 */
export default function TranscriptionIndicator() {
  const state = useStore(transcriptionState);
  if (state === 'idle') return null;

  const listening = state === 'listening';
  return (
    <div className={`transcription-indicator ${state}`} role="status" aria-live="polite">
      <span className="dot" />
      {/* Processing covers the final STT drain (and the optional AI polish), so
        * "Sending to terminal" was a promise the label couldn't keep — it also
        * showed while dictating into a text field. */}
      <span className="label">{listening ? 'Listening' : 'Transcribing…'}</span>
      {listening && (
        <span className="hint">
          again to send · <kbd className="key">Esc</kbd> to cancel
        </span>
      )}
    </div>
  );
}
