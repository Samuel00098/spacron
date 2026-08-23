import { get, writable } from '$lib/stores/storeCompat';
import {
  activeSessionId,
  devActiveSessionId,
  requestTerminalInput,
  sendAgentPromptDirect,
} from '$lib/stores/terminal';
import { transcriptionAutoSend } from '$lib/stores/settings';
import {
  createVoiceInputSession,
  refineVoiceTranscript,
  type VoiceInputSession,
} from '$lib/services/voice-input';
import { showToast } from '$lib/stores/notification';

/**
 * Transcribe-to-terminal: one hotkey, one spoken command, straight into the
 * active terminal's PTY.
 *
 * Deliberately separate from the FloatingPromptBar's dictation (which types
 * into the prompt input) and from voice conversation mode (a continuous loop):
 * this is single-shot — press the hotkey, speak one command, and it lands in
 * the terminal. Delivery reuses the same paths as every other prompt send:
 * `sendAgentPromptDirect` (bracketed paste + echo confirm + Enter for TUI
 * agent CLIs, plain text + \r for shells) when auto-send is on, or a silent
 * xterm paste via `requestTerminalInput` when it is off.
 */

export type TranscriptionState = 'idle' | 'listening' | 'processing';

export const transcriptionState = writable<TranscriptionState>('idle');

let phase: TranscriptionState = 'idle';
let starting = false;
let targetSessionId: number | null = null;
let voiceSession: VoiceInputSession | null = null;
let keyHandlerInstalled = false;

function setPhase(next: TranscriptionState) {
  phase = next;
  transcriptionState.set(next);
}

function resolveTargetSession(): number | null {
  return get(activeSessionId) ?? get(devActiveSessionId);
}

function handleKeydown(event: KeyboardEvent) {
  // Escape always discards — a mistimed hotkey press must never fire a
  // half-spoken sentence into a live terminal.
  if (event.key !== 'Escape') return;
  event.preventDefault();
  abortTranscription();
}

function installKeyHandler() {
  if (keyHandlerInstalled || typeof document === 'undefined') return;
  document.addEventListener('keydown', handleKeydown, true);
  keyHandlerInstalled = true;
}

function removeKeyHandler() {
  if (!keyHandlerInstalled || typeof document === 'undefined') return;
  document.removeEventListener('keydown', handleKeydown, true);
  keyHandlerInstalled = false;
}

function teardownMic() {
  removeKeyHandler();
  if (voiceSession) {
    voiceSession.stop();
    voiceSession = null;
  }
}

/**
 * Mechanical cleanup shared by both delivery paths — spoken punctuation
 * ("comma" → ",", "quote" → '"', …) and newlines flattened so the payload is
 * always a single shell-safe line.
 */
function cleanTranscript(raw: string): string | null {
  const text = refineVoiceTranscript(raw, { allowNewLines: false, spokenPunctuation: true });
  return text || null;
}

async function deliver(text: string): Promise<void> {
  const sessionId = targetSessionId;
  setPhase('processing');
  teardownMic();
  if (sessionId == null || !text) {
    setPhase('idle');
    return;
  }
  try {
    if (get(transcriptionAutoSend)) {
      const sent = await sendAgentPromptDirect(sessionId, text);
      if (!sent) {
        showToast('Could not reach the terminal session — transcript discarded.', 'error');
      }
    } else {
      requestTerminalInput(sessionId, text);
    }
  } catch (error) {
    console.error('Terminal transcription delivery failed:', error);
    showToast('Failed to deliver the transcript to the terminal.', 'error');
  } finally {
    targetSessionId = null;
    setPhase('idle');
  }
}

async function startListening(): Promise<void> {
  const sessionId = resolveTargetSession();
  if (sessionId == null) {
    showToast('No active terminal — open a terminal tab first.', 'error');
    starting = false;
    return;
  }

  const session = createVoiceInputSession({
    onStart: () => {
      starting = false;
      setPhase('listening');
    },
    onResult: (transcript) => {
      // Single-shot: the first finalized utterance ends the capture. A later
      // result (e.g. flushed by stop()) lands after phase left 'listening'
      // and is dropped here, so delivery can never happen twice.
      if (phase !== 'listening') return;
      void deliver(cleanTranscript(transcript) ?? '');
    },
    onError: (message) => {
      // Late mic errors while a transcript is already being delivered would
      // clobber the processing state — the delivery path owns cleanup then.
      if (phase === 'processing') return;
      teardownMic();
      targetSessionId = null;
      starting = false;
      setPhase('idle');
      showToast(message, 'error');
    },
    onEnd: () => {
      // Mic released without ever producing a transcript (e.g. stop() flushed
      // silence). Only meaningful while still listening — deliver() owns the
      // transition otherwise.
      if (phase === 'listening') {
        teardownMic();
        targetSessionId = null;
        setPhase('idle');
      }
    },
  });

  if (!session.isSupported()) {
    showToast('Voice input is not supported with the current provider.', 'error');
    starting = false;
    return;
  }

  voiceSession = session;
  targetSessionId = sessionId;
  installKeyHandler();
  try {
    await session.start();
  } catch (error) {
    console.error('Terminal transcription failed to start:', error);
    teardownMic();
    targetSessionId = null;
    starting = false;
    setPhase('idle');
    showToast('Could not start the microphone.', 'error');
  }
}

/** Stop early and send whatever was captured so far. */
function finalizeListening(): void {
  // stop() flushes any pending audio; the flush arrives as onResult while the
  // phase is still 'listening' and delivers from there. If nothing was
  // captured, onEnd resets to idle instead.
  voiceSession?.stop();
}

/**
 * Cancel without delivering anything. Bound to Escape while listening.
 */
export function abortTranscription(): void {
  // Only a live capture can be cancelled — delivery in flight runs to completion.
  if (phase !== 'listening') return;
  teardownMic();
  targetSessionId = null;
  starting = false;
  setPhase('idle');
}

/**
 * The hotkey entry point. Idle → listen; listening → stop and send;
 * processing → ignored (delivery already in flight).
 */
export function toggleTerminalTranscription(): void {
  if (starting || phase === 'processing') return;
  if (phase === 'listening') {
    finalizeListening();
    return;
  }
  starting = true;
  void startListening();
}
