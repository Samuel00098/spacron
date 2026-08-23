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
      <span className="label">{listening ? 'Listening' : 'Sending to terminal'}</span>
      {listening && (
        <span className="hint">
          again to send · <kbd className="key">Esc</kbd> to cancel
        </span>
      )}
    </div>
  );
}
