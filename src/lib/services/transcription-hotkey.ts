import { get, writable } from '$lib/stores/storeCompat';
import {
  activeSessionId,
  devActiveSessionId,
  devSessions,
  requestTerminalInput,
  sendAgentPromptDirect,
  sessions,
  type TerminalSessionInfo,
} from '$lib/stores/terminal';
import { transcriptionAutoSend } from '$lib/stores/settings';
import {
  createVoiceInputSession,
  refineVoiceTranscript,
  type VoiceInputSession,
} from '$lib/services/voice-input';
import { showToast } from '$lib/stores/notification';

/**
 * Transcription mode: speak once, land the text somewhere useful.
 *
 * Deliberately separate from the floating bar's realtime conversation mode (a
 * live speech-to-speech call). No reply is ever synthesized; this is pure
 * speech-to-text, WhisperFlow-style.
 *
 * The gesture:
 *
 *   hotkey (F9 by default)  start dictating
 *   ...speak, pause, keep speaking — pauses do NOT end it...
 *   hotkey again / Escape   end, then paste everything at once
 *   Ctrl/Cmd+Escape         discard without pasting
 *
 * Pauses are the subtle part. The VAD finalizes an utterance after ~800 ms of
 * silence, far shorter than an ordinary thinking pause, so the original
 * single-shot design (deliver on the first `onResult`) chopped any sentence you
 * paused inside. Utterances are banked in `accumulated` and the mic is re-armed;
 * only `finalizeListening` ends a dictation. The session is kept in
 * conversation mode so re-arming skips getUserMedia — that latency is what
 * would otherwise swallow the first word after each pause.
 *
 * The target is chosen when the capture starts (`startListening`) and held in
 * `targetField` / `targetSessionId`. It then FOLLOWS THE USER: clicking (or
 * tabbing) into another text box while — or just after — speaking retargets the
 * dictation there, so a sentence begun over a terminal still lands in the box
 * you moved to.
 *
 * What must NOT retarget is focus the user did not direct: the bar's mic button
 * stealing the caret, a toast, a re-render, a dialog autofocusing its own field.
 * `retargetDuringCapture` therefore takes two votes — the landing has to BE a
 * text surface (or a terminal), and `wasUserDirected` has to place the user's
 * own pointer/Tab on it. Blindly re-reading the focused element at delivery is
 * the original bug and is still wrong.
 *
 * Delivery seams (do not add new ones):
 * - Focused text field (input / textarea / contenteditable) → inserted at the
 *   caret, newlines preserved. This is the WhisperFlow-style path. `focusin`
 *   remembers the last such field so clicking the bar's mic (which steals
 *   focus) does not lose it -- but focusing a terminal CLEARS that memory, so
 *   the terminal always wins while the caret is in it.
 * - Terminal sessions → `sendAgentPromptDirect` (bracketed paste + echo
 *   confirm + Enter retry for TUI agent CLIs, plain text + `\r` for shells)
 *   when auto-send is on, or a silent xterm paste via `requestTerminalInput`
 *   when off. Target = whichever world's active session was activated most
 *   recently (see `resolveTargetSession`).
 *
 * Transcript cleanup into TERMINALS is mechanical only (`refineVoiceTranscript`,
 * spoken punctuation + newline flattening). No AI refinement on purpose — it
 * must never reword shell commands.
 */

export type TranscriptionState = 'idle' | 'listening' | 'processing';

export const transcriptionState = writable<TranscriptionState>('idle');

let phase: TranscriptionState = 'idle';
let starting = false;
// The terminal session this dictation is aimed at, resolved when the capture
// starts. Cleared by a mid-dictation retarget, which makes `deliver` resolve it
// again at the moment of delivery — the pane the user clicked into is only
// reliably active by then.
let targetSessionId: number | null = null;
// The field the transcript belongs to: snapshotted when the capture STARTS, and
// updated by `retargetDuringCapture` when the user deliberately moves the caret
// to another text surface. Never re-read `lastEditableEl` at delivery time —
// incidental focus moves (the mic button, a toast, a re-render) would otherwise
// let a stale remembered field swallow a transcript meant for the terminal.
let targetField: EditableTarget | null = null;
let voiceSession: VoiceInputSession | null = null;
let keyHandlerInstalled = false;
/**
 * Every finalized utterance so far in THIS dictation.
 *
 * The VAD ends an utterance after ~800 ms of silence, which is far shorter than
 * a normal thinking pause. Delivering on the first one (the old single-shot
 * behaviour) chopped any sentence you paused inside. Utterances are collected
 * here and the mic is re-armed instead; nothing is delivered until you end the
 * dictation yourself.
 */
let accumulated: string[] = [];
/** True once the user has ended the dictation and we're draining the last audio. */
let finalizing = false;

function setPhase(next: TranscriptionState) {
  phase = next;
  transcriptionState.set(next);
}

/** A terminal pane's hidden focus sink — never treated as a text field. */
function isXtermHelper(el: HTMLElement): boolean {
  return !!el.closest('.xterm');
}

type EditableTarget =
  | { kind: 'input'; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'rich'; el: HTMLElement };

/** The focused element, if spoken text can be typed straight into it. */
function focusedEditableTarget(): EditableTarget | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return isXtermHelper(el) ? null : { kind: 'input', el };
  }
  if (el instanceof HTMLElement && el.isContentEditable) return { kind: 'rich', el };
  return null;
}

/**
 * Insert `text` at the caret of the focused editable. Inputs/textareas use
 * `setRangeText` (+ a dispatched input event so React/Vue bindings see it);
 * rich editors take `execCommand('insertText')`, which every WebView engine
 * still honours for caret insertion.
 */
function insertIntoEditable(target: EditableTarget, text: string): boolean {
  try {
    if (target.kind === 'input') {
      const el = target.el;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    return document.execCommand('insertText', false, text);
  } catch {
    return false;
  }
}

/**
 * The terminal the user is actually working in.
 *
 * There are two independent terminal worlds — the agent room (`sessions` /
 * `activeSessionId`) and the dev-terminal room (`devSessions` /
 * `devActiveSessionId`) — and each remembers its own active session
 * indefinitely. This used to be `activeSessionId ?? devActiveSessionId`, which
 * always preferred the agent room whenever it held anything at all: dictating
 * into the dev terminal delivered the transcript to an off-screen session and
 * reported success, so the text simply never appeared.
 *
 * `lastActivatedAt` is the tiebreak, since activating a pane stamps it.
 */
function resolveTargetSession(): number | null {
  const agentId = get(activeSessionId);
  const devId = get(devActiveSessionId);
  if (agentId == null) return devId;
  if (devId == null) return agentId;

  const activatedAt = (id: number, list: TerminalSessionInfo[]) =>
    list.find((session) => session.id === id)?.lastActivatedAt ?? 0;
  return activatedAt(devId, get(devSessions)) > activatedAt(agentId, get(sessions))
    ? devId
    : agentId;
}

// Clicking the bar's mic button (or any UI) steals focus from the field the
// user was typing in. Remember the last editable that held the caret anywhere
// in the app so "insert at cursor" survives that focus steal. Tracked lazily
// with one focusin listener for the module's lifetime.
let lastEditableEl: EditableTarget | null = null;
let focusTrackerInstalled = false;

/**
 * The element the user last pressed a pointer on, and whether the last focus
 * move came from Tab. Together these separate "I clicked into that box" from
 * "focus moved on its own" — the mic button, a toast, a re-render, or a dialog
 * that opens on a click and autofocuses its own field. Only the former may
 * redirect a dictation that is already running.
 */
let lastPointerDownEl: HTMLElement | null = null;
let tabbedFocus = false;

/** Did the user themselves put the caret on `el`, with the gesture that just
 *  happened? Tab always counts. A pointer counts when it landed on the surface
 *  itself — clicking a button that then opens a dialog and focuses a field in it
 *  lands on the button, not on the field, so it does not. */
function wasUserDirected(el: HTMLElement): boolean {
  if (tabbedFocus) return true;
  const from = lastPointerDownEl;
  if (!from) return false;
  if (from === el || el.contains(from) || from.contains(el)) return true;
  // Terminals hand focus to a hidden helper textarea that is a SIBLING of the
  // screen you actually clicked, so containment never holds inside one. Same
  // `.xterm` root is the equivalent test there.
  const term = el.closest('.xterm');
  return !!term && from.closest('.xterm') === term;
}

/**
 * Move a dictation in flight to the text surface the user just put the caret in.
 * `target` is null for a terminal, which is deliberately NOT resolved to a
 * session here — the pane activation that follows a click into a terminal can
 * land after this focus event, so the session is read again in `deliver`.
 */
function retargetDuringCapture(target: EditableTarget | null, el: HTMLElement) {
  if (phase !== 'listening' && !starting) return;
  if (!wasUserDirected(el)) return;
  targetField = target;
  targetSessionId = null;
}

function installFocusTracker() {
  if (focusTrackerInstalled || typeof document === 'undefined') return;
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastPointerDownEl = event.target instanceof HTMLElement ? event.target : null;
      tabbedFocus = false;
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if ((event as KeyboardEvent).key !== 'Tab') return;
      tabbedFocus = true;
      lastPointerDownEl = null;
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement)) return;
      // Focus landed inside a terminal: the caret is there now, so a field
      // remembered from earlier must stop claiming the next transcript.
      if (isXtermHelper(el)) {
        lastEditableEl = null;
        retargetDuringCapture(null, el);
        return;
      }
      const target =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? { kind: 'input' as const, el }
          : el.isContentEditable
            ? { kind: 'rich' as const, el }
            : null;
      // A landing that is neither a text surface nor a terminal leaves the
      // target alone — that is the mic-button/toast case the snapshot exists for.
      if (target) {
        lastEditableEl = target;
        retargetDuringCapture(target, el);
      }
    },
    true,
  );
  focusTrackerInstalled = true;
}

/** Drop a remembered field that has since been unmounted. */
function liveEditable(target: EditableTarget | null): EditableTarget | null {
  if (!target) return null;
  if (!target.el.isConnected) {
    if (lastEditableEl === target) lastEditableEl = null;
    return null;
  }
  return target;
}

/** Where a capture started: the element under the caret NOW, else the last one. */
function resolveEditableTarget(): EditableTarget | null {
  installFocusTracker();
  return focusedEditableTarget() ?? liveEditable(lastEditableEl);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  // Escape ENDS the dictation and pastes (WhisperFlow-style). Ctrl/Cmd+Escape
  // is the discard path, kept so a mistimed hotkey never has to fire a
  // half-spoken sentence into a live terminal.
  if (event.ctrlKey || event.metaKey) {
    abortTranscription();
  } else {
    finalizeListening();
  }
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
    const session = voiceSession;
    voiceSession = null;
    session.setConversationMode(false);
    session.stop();
  }
}

/** Reset everything this dictation owned and return to idle. */
function resetToIdle() {
  targetSessionId = null;
  targetField = null;
  accumulated = [];
  finalizing = false;
  starting = false;
  setPhase('idle');
}

/**
 * Mechanical cleanup — spoken punctuation ("comma" → ",", "quote" → '"', …).
 * Terminals additionally get newlines flattened so the payload is always a
 * single shell-safe line; text fields keep them (multi-line dictation).
 */
function cleanTranscript(raw: string, allowNewLines: boolean): string | null {
  const text = refineVoiceTranscript(raw, { allowNewLines, spokenPunctuation: true });
  return text || null;
}

/** End the dictation: join everything captured, clean it, and place it. */
async function deliver(): Promise<void> {
  setPhase('processing');
  const field = liveEditable(targetField);
  const allowNewLines = field != null;
  const text = cleanTranscript(accumulated.join(' '), allowNewLines) ?? '';
  teardownMic();
  if (!text) {
    resetToIdle();
    return;
  }
  try {
    // The field this dictation is aimed at wins: the one the caret was in when
    // the capture started, or the one the user deliberately clicked into since.
    // Incidental focus moves never get here — see `retargetDuringCapture`.
    if (field) {
      if (!insertIntoEditable(field, text)) {
        showToast('Could not insert the transcript at the cursor.', 'error');
      }
      return;
    }

    // Null means either "aimed at a terminal but retargeted mid-dictation" or
    // "the remembered field is gone" — both want the terminal the user is in NOW.
    const sessionId = targetSessionId ?? resolveTargetSession();
    if (sessionId == null) {
      showToast('Click into a terminal or text field first — nowhere to put the transcript.', 'error');
      return;
    }
    if (get(transcriptionAutoSend)) {
      const sent = await sendAgentPromptDirect(sessionId, text);
      if (!sent) {
        showToast('Could not reach the terminal session — transcript discarded.', 'error');
      }
    } else {
      requestTerminalInput(sessionId, text);
    }
  } catch (error) {
    console.error('Transcription delivery failed:', error);
    showToast('Failed to deliver the transcript.', 'error');
  } finally {
    resetToIdle();
  }
}

async function startListening(): Promise<void> {
  // Snapshot BOTH kinds of target up front: whichever held the caret when the
  // capture started (now, or the last field before focus moved to the bar's
  // mic button) is where the transcript lands — unless the user moves the caret
  // to another text surface before it ends, which retargets it.
  const field = resolveEditableTarget();
  const sessionId = field ? null : resolveTargetSession();
  if (!field && sessionId == null) {
    showToast('Click into a terminal or text field first, then speak.', 'error');
    starting = false;
    return;
  }
  targetSessionId = sessionId;
  targetField = field;
  accumulated = [];
  finalizing = false;

  const session = createVoiceInputSession({
    onStart: () => {
      starting = false;
      setPhase('listening');
    },
    onResult: (transcript) => {
      // One utterance, not the whole dictation. Bank it and keep the mic live;
      // `finalizeListening` is the only thing that ends a dictation.
      const piece = transcript.trim();
      if (piece) accumulated.push(piece);
      // The flush that `stop()` triggers arrives here too — `onEnd` delivers
      // right after, so don't re-arm into a session we're tearing down.
      if (finalizing || phase !== 'listening') return;
      // Re-arm out of band: `start()` re-entering the session from inside its
      // own callback is asking for trouble, and a warm re-arm is cheap.
      queueMicrotask(() => {
        if (finalizing || phase !== 'listening') return;
        void voiceSession?.start().catch((error) => {
          console.error('Transcription failed to re-arm:', error);
        });
      });
    },
    onError: (message) => {
      // Late mic errors while a transcript is already being delivered would
      // clobber the processing state — the delivery path owns cleanup then.
      if (phase === 'processing') return;
      teardownMic();
      resetToIdle();
      showToast(message, 'error');
    },
    onEnd: () => {
      // The mic is gone. If the user ended the dictation, this is the moment the
      // last flushed utterance has landed — deliver everything banked.
      //
      // The phase check is load-bearing: `deliver` itself calls `teardownMic`,
      // whose `stop()` fires `onEnd` a second time. Without it that re-entered
      // delivery and sent the transcript twice.
      if (finalizing) {
        if (phase === 'listening') void deliver();
        return;
      }
      // Otherwise the graph died on its own (device unplugged, OS interruption).
      // Don't silently bin what was already said.
      if (phase === 'listening') {
        if (accumulated.length) {
          void deliver();
        } else {
          teardownMic();
          resetToIdle();
        }
      }
    },
  });

  if (!session.isSupported()) {
    showToast('Voice input is not supported with the current provider.', 'error');
    starting = false;
    return;
  }

  voiceSession = session;
  // Keep the capture graph warm between utterances so re-arming after a pause
  // skips getUserMedia + AudioContext setup — that latency is what would
  // otherwise swallow the first word after every pause.
  session.setConversationMode(true);
  installKeyHandler();
  try {
    await session.start();
  } catch (error) {
    console.error('Transcription failed to start:', error);
    teardownMic();
    resetToIdle();
    showToast('Could not start the microphone.', 'error');
  }
}

/** End the dictation and deliver everything captured so far. */
function finalizeListening(): void {
  if (phase !== 'listening' || finalizing) return;
  finalizing = true;
  const session = voiceSession;
  if (!session) {
    // Nothing to drain — deliver whatever was banked.
    void deliver();
    return;
  }
  // Leaving keep-warm makes stop() release the mic instead of parking it, so
  // `onEnd` is guaranteed to fire; that is where delivery happens, once the
  // final flushed utterance has landed in `accumulated`.
  session.setConversationMode(false);
  session.stop();
}

/**
 * Discard the dictation without delivering. Bound to Ctrl/Cmd+Escape while
 * listening.
 */
export function abortTranscription(): void {
  // Only a live capture can be cancelled — delivery in flight runs to completion.
  if (phase !== 'listening') return;
  // Clear state BEFORE releasing the mic. `teardownMic` stops the session, which
  // fires `onEnd`, and onEnd's "the graph died on its own" branch would happily
  // deliver the very transcript the user just asked to throw away.
  resetToIdle();
  teardownMic();
}

/**
 * The hotkey entry point. Idle → listen; listening → end and paste;
 * processing → ignored (delivery already in flight).
 *
 * Pressing the hotkey again is the same gesture as Escape: both end the
 * dictation. Nothing is delivered until one of them happens.
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

/**
 * Entry point for the floating bar's mic button — the same single-shot
 * transcription, just triggered from the bar instead of the global hotkey.
 * Returns false when a capture is already running elsewhere.
 */
export function startBarTranscription(): boolean {
  if (starting || phase !== 'idle') return false;
  starting = true;
  void startListening();
  return true;
}
