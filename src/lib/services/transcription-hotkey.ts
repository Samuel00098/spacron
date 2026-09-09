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
import { transcriptionAutoSend, voiceInputProvider, voiceRefinementEnabled } from '$lib/stores/settings';
import { recordTranscription } from '$lib/stores/voiceHistory';
import {
  createVoiceInputSession,
  refineVoiceTranscript,
  type VoiceInputSession,
} from '$lib/services/voice-input';
import { refineVoicePrompt } from '$lib/services/voice-refinement';
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
 * spoken punctuation + fillers + newline flattening). No AI refinement on
 * purpose — it must never reword shell commands. Text fields DO get the AI
 * polish pass when voice refinement is enabled (WhisperFlow-style cleanup);
 * that is prose, not a command.
 */

export type TranscriptionState = 'idle' | 'listening' | 'processing';

export const transcriptionState = writable<TranscriptionState>('idle');

/**
 * Live input level (RMS, 0..~0.3) while dictating, for the indicator's meter.
 * A pill that only says "Listening" cannot tell you the mic is muted, aimed at
 * the wrong device, or simply not hearing you — which is the failure people
 * describe as "it transcribed nothing and I don't know why".
 */
export const transcriptionLevel = writable<number>(0);

/** Words banked so far in this dictation — proof the words are landing. */
export const transcriptionWordCount = writable<number>(0);

/**
 * The gesture is a TAP, not a hold, and that is deliberate.
 *
 * Push-to-talk (hold the key, release to send) was tried here and reverted: a
 * deliberate keypress routinely lasts longer than any threshold that could
 * still tell it apart from a hold, so an ordinary tap was read as a release
 * and the dictation delivered itself before the user had said a word. The pill
 * flashed and vanished, and Escape had nothing left to cancel. Tap to start,
 * tap again (or Escape) to send.
 */

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
/** Guards against double delivery: onEnd can fire more than once during the
 *  drain (teardown re-entry, a late engine event), and each of those used to
 *  be an invitation to deliver again. */
let deliveryStarted = false;
/**
 * Consecutive failed re-arm attempts after the capture graph stopped on its
 * own mid-dictation (webspeech engines end the recognizer after long silences;
 * devices hiccup). Reset by every successful `onStart`. Past the cap we stop
 * retrying and deliver what was said rather than looping forever.
 */
let rearmFailures = 0;
const MAX_REARM_FAILURES = 3;
/**
 * When the mic actually went live for THIS dictation, used only to stamp a
 * duration onto the history entry. Zero means "never started", which is what
 * makes the duration optional rather than a bogus 0 ms.
 */
let captureStartedAt = 0;

function setPhase(next: TranscriptionState) {
  phase = next;
  transcriptionState.set(next);
  if (next !== 'listening') transcriptionLevel.set(0);
  if (next === 'idle') transcriptionWordCount.set(0);
}

/** Rough word count of everything banked so far, for the indicator. */
function publishWordCount(): void {
  const words = accumulated.join(' ').trim();
  transcriptionWordCount.set(words ? words.split(/\s+/).length : 0);
}

/** A terminal pane's hidden focus sink — never treated as a text field. */
function isXtermHelper(el: HTMLElement): boolean {
  return !!el.closest('.xterm');
}

type EditableTarget =
  | { kind: 'input'; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'rich'; el: HTMLElement }
  | { kind: 'preview'; iframe: HTMLIFrameElement; origin: string };

type PreviewInsertWaiter = {
  target: Extract<EditableTarget, { kind: 'preview' }>;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

let previewTarget: Extract<EditableTarget, { kind: 'preview' }> | null = null;
const previewInsertWaiters = new Map<string, PreviewInsertWaiter>();

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
function insertIntoEditable(target: EditableTarget, text: string): boolean | Promise<boolean> {
  if (target.kind === 'preview') {
    const contentWindow = target.iframe.contentWindow;
    if (!contentWindow || !target.origin) return false;
    const requestId = `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        previewInsertWaiters.delete(requestId);
        resolve(false);
      }, 1500);
      previewInsertWaiters.set(requestId, { target, resolve, timer });
      try {
        contentWindow.postMessage(
          { type: 'forge-preview:insert-text', requestId, text },
          target.origin,
        );
      } catch {
        clearTimeout(timer);
        previewInsertWaiters.delete(requestId);
        resolve(false);
      }
    });
  }
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

function handlePreviewFocusEvent(event: Event): void {
  const detail = (event as CustomEvent).detail as {
    iframe?: HTMLIFrameElement;
    origin?: string;
    editable?: boolean;
  } | null;
  const iframe = detail?.iframe;
  const origin = typeof detail?.origin === 'string' ? detail.origin : '';
  if (!iframe || !origin) return;
  const target: Extract<EditableTarget, { kind: 'preview' }> = {
    kind: 'preview',
    iframe,
    origin,
  };
  if (detail?.editable) {
    previewTarget = target;
    retargetDuringCapture(target, iframe);
  } else if (previewTarget?.iframe === iframe) {
    // Blurring the iframe to click the floating mic is the expected start
    // gesture. Keep the page target long enough for startListening to snapshot
    // it; a generic parent button must not erase the user's caret.
    if (starting || phase === 'listening') return;
    previewTarget = null;
    if (targetField?.kind === 'preview' && targetField.iframe === iframe) {
      targetField = null;
      targetSessionId = null;
    }
  }
}

function handlePreviewInsertResultEvent(event: Event): void {
  const detail = (event as CustomEvent).detail as {
    iframe?: HTMLIFrameElement;
    origin?: string;
    requestId?: string;
    ok?: boolean;
  } | null;
  const requestId = typeof detail?.requestId === 'string' ? detail.requestId : '';
  if (!requestId) return;
  const waiter = previewInsertWaiters.get(requestId);
  if (!waiter) return;
  if (waiter.target.iframe !== detail?.iframe || waiter.target.origin !== detail?.origin) return;
  clearTimeout(waiter.timer);
  previewInsertWaiters.delete(requestId);
  waiter.resolve(Boolean(detail?.ok));
}

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
        previewTarget = null;
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
        previewTarget = null;
        lastEditableEl = target;
        retargetDuringCapture(target, el);
      }
    },
    true,
  );
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('spacron-preview-focus', handlePreviewFocusEvent);
    window.addEventListener('spacron-preview-insert-text-result', handlePreviewInsertResultEvent);
  }
  focusTrackerInstalled = true;
}

/** Install the focus bridge before a toolbar button can steal iframe focus. */
export function primeTranscriptionTargetTracking(): void {
  installFocusTracker();
}

/** Drop a remembered field that has since been unmounted. */
function liveEditable(target: EditableTarget | null): EditableTarget | null {
  if (!target) return null;
  if (target.kind === 'preview') {
    const iframeIsLive = target.iframe.isConnected && target.iframe.classList.contains('is-active');
    if (!iframeIsLive) {
      if (previewTarget?.iframe === target.iframe) previewTarget = null;
      if (targetField?.kind === 'preview' && targetField.iframe === target.iframe) targetField = null;
      return null;
    }
    return target;
  }
  if (!target.el.isConnected) {
    if (lastEditableEl === target) lastEditableEl = null;
    return null;
  }
  return target;
}

/** Where a capture started: the element under the caret NOW, else the last one. */
function resolveEditableTarget(): EditableTarget | null {
  installFocusTracker();
  const preview = previewTarget && liveEditable(previewTarget);
  return preview ?? focusedEditableTarget() ?? liveEditable(lastEditableEl);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  // Ctrl/Cmd+Escape is the discard path. Plain Escape ENDS the dictation and
  // pastes (WhisperFlow-style) — but while the mic is still opening (phase not
  // yet 'listening') there is nothing to end, and finalizeListening would
  // silently ignore the key. That dead keypress read as "Escape needs two or
  // three tries", so while starting it cancels instead.
  if (event.ctrlKey || event.metaKey || starting) {
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
  captureStartedAt = 0;
  accumulated = [];
  finalizing = false;
  deliveryStarted = false;
  starting = false;
  setPhase('idle');
}

/**
 * Kick off delivery exactly once per dictation. `onEnd` can arrive several
 * times while a dictation is being drained (the teardown stop re-enters it,
 * webspeech fires its own), and every one of those used to be a fresh chance
 * to paste the transcript twice.
 */
function beginDelivery(): void {
  if (deliveryStarted) return;
  deliveryStarted = true;
  void deliver();
}

/**
 * The capture graph stopped while the user was still dictating (webspeech
 * engines end the recognizer after a long silence; devices hiccup). Re-arm
 * instead of delivering — an unexpected onEnd used to be treated as "the mic
 * died, ship what we have", which chopped the dictation at that silence. If
 * re-arming keeps failing, hand over whatever was banked rather than binning
 * it or looping.
 */
function scheduleRearm(): void {
  queueMicrotask(() => {
    if (finalizing || phase !== 'listening') return;
    if (!voiceSession || rearmFailures >= MAX_REARM_FAILURES) {
      if (accumulated.length) beginDelivery();
      else {
        teardownMic();
        resetToIdle();
      }
      return;
    }
    void voiceSession.start().catch((error) => {
      console.error('Transcription failed to re-arm:', error);
      rearmFailures += 1;
      scheduleRearm();
    });
  });
}

/**
 * Mechanical cleanup, and the only cleanup a terminal payload ever gets.
 *
 * Spoken punctuation ("comma" → ",", "quote" → '"'), hesitation fillers, and
 * the technical pass — "get hub" → GitHub, "a p i" → API, "dash dash force" →
 * --force, "dot ts" → .ts. All of it is deterministic and word-bounded, which
 * is why it is safe over a shell command; the AI rewrite is not, and terminals
 * never see it.
 *
 * `allowNewLines` doubles as "this is prose": text fields keep their line
 * breaks AND get sentence capitalization, while terminals get a single
 * shell-safe line with the casing exactly as spoken.
 */
function cleanTranscript(raw: string, allowNewLines: boolean): string | null {
  const text = refineVoiceTranscript(raw, {
    allowNewLines,
    spokenPunctuation: true,
    capitalizeSentences: allowNewLines,
  });
  return text || null;
}

/**
 * A human name for the field a dictation landed in, for the history list.
 * Everything is read defensively — this runs on whatever element happened to
 * hold the caret, and a missing label must never cost the user their words.
 */
function describeField(target: EditableTarget): string {
  if (target.kind === 'preview') return 'Preview page input';
  const el = target.el as HTMLElement & { placeholder?: string; name?: string };
  try {
    const aria = el.getAttribute?.('aria-label')?.trim();
    if (aria) return aria;
    const placeholder = el.placeholder?.trim();
    if (placeholder) return placeholder;
    const name = el.name?.trim();
    if (name) return name;
    const id = el.id?.trim();
    if (id) return id;
  } catch {
    /* exotic element — fall through to the generic label */
  }
  return 'Text field';
}

/** "Claude — Terminal 3" style label for a dictation that went to a terminal. */
function describeSession(sessionId: number): string {
  const find = (list: TerminalSessionInfo[]) => list.find((session) => session.id === sessionId);
  const session = find(get(sessions)) ?? find(get(devSessions));
  const name = session?.agentName?.trim() || session?.title?.trim();
  return name ? `${name} (terminal ${sessionId})` : `Terminal ${sessionId}`;
}

/**
 * Log the dictation, whatever happens to it next.
 *
 * Called BEFORE delivery on purpose: a transcript that could not be inserted
 * (the field went away, the terminal session died) is exactly the one the user
 * most wants to find in history and copy out by hand.
 */
function logToHistory(input: {
  mechanical: string;
  finalText: string;
  field: EditableTarget | null;
  sessionId: number | null;
}): void {
  try {
    recordTranscription({
      text: input.finalText,
      raw: input.mechanical,
      target: input.field ? 'field' : 'terminal',
      targetLabel: input.field
        ? describeField(input.field)
        : input.sessionId != null
          ? describeSession(input.sessionId)
          : undefined,
      provider: get(voiceInputProvider),
      durationMs: captureStartedAt ? Date.now() - captureStartedAt : undefined,
      refined: input.finalText !== input.mechanical,
    });
  } catch (error) {
    // History is a nicety; delivery is the job. Never let one break the other.
    console.error('Could not record the dictation in voice history:', error);
  }
}

/**
 * End the dictation: join everything captured, clean it, and place it.
 *
 * Cleanup is two-stage. `cleanTranscript` is the mechanical pass (spoken
 * punctuation, filler words, newline flattening) that always runs — it is what
 * terminal payloads get, since a shell command must never be reworded. Text
 * fields additionally get the optional AI polish (`refineVoicePrompt`) when
 * the user has voice refinement enabled: that is the WhisperFlow/Typeless
 * "make it a clean paragraph" step, and it is safe here because the target is
 * prose, not a command.
 */
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
  let finalText = text;
  if (field && get(voiceRefinementEnabled)) {
    try {
      const refined = await refineVoicePrompt(text, { allowForModelProviders: true });
      // A polish pass that comes back empty (provider chain exhausted, empty
      // model reply) must never erase what was actually said.
      if (refined.text) finalText = refined.text;
    } catch (error) {
      console.error('Transcript polish failed; keeping the mechanical cleanup:', error);
    }
  }
  // Null means either "aimed at a terminal but retargeted mid-dictation" or
  // "the remembered field is gone" — both want the terminal the user is in NOW.
  const sessionId = field ? null : targetSessionId ?? resolveTargetSession();
  logToHistory({ mechanical: text, finalText, field, sessionId });
  try {
    // The field this dictation is aimed at wins: the one the caret was in when
    // the capture started, or the one the user deliberately clicked into since.
    // Incidental focus moves never get here — see `retargetDuringCapture`.
    if (field) {
      if (!(await insertIntoEditable(field, finalText))) {
        showToast('Could not insert the transcript at the cursor.', 'error');
      }
      return;
    }

    if (sessionId == null) {
      showToast('Click into a terminal or text field first, because there is nowhere to put the transcript.', 'error');
      return;
    }
    if (get(transcriptionAutoSend)) {
      const sent = await sendAgentPromptDirect(sessionId, finalText);
      if (!sent) {
        showToast('Could not reach the terminal session, so the transcript was discarded.', 'error');
      }
    } else {
      requestTerminalInput(sessionId, finalText);
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

  const session = createVoiceInputSession(
    {
      onStart: () => {
        starting = false;
        // A live capture graph means the re-arm machinery is healthy again.
        rearmFailures = 0;
        // Only the FIRST start of a dictation is its beginning — the mic is
        // re-armed after every pause, and each of those calls this too.
        if (!captureStartedAt) captureStartedAt = Date.now();
        setPhase('listening');
      },
      onAudioLevel: (rms) => {
        if (phase === 'listening') transcriptionLevel.set(rms);
      },
      onResult: (transcript) => {
        // One utterance, not the whole dictation. Bank it and keep the mic live;
        // `finalizeListening` is the only thing that ends a dictation.
        const piece = transcript.trim();
        if (piece) {
          accumulated.push(piece);
          publishWordCount();
        }
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
        // A failure during delivery (e.g. the final drain's STT call erroring)
        // must not clobber the processing state — but silencing it entirely
        // used to make a failed transcription look like lost words. Surface
        // it; whatever was banked still delivers when onEnd lands.
        showToast(message, 'error');
        if (phase === 'processing') return;
        teardownMic();
        resetToIdle();
      },
      onEnd: () => {
        // If the user ended the dictation, this is the moment the last flushed
        // utterance has landed — deliver everything banked, exactly once.
        if (finalizing) {
          beginDelivery();
          return;
        }
        // Otherwise the capture stopped while the dictation was still live:
        // webspeech engines auto-end after long silences, devices hiccup. Try
        // to keep listening instead of delivering half a sentence — an older
        // version treated every unexpected onEnd as "the mic died" and shipped
        // the banked text at the first pause.
        if (phase === 'listening') scheduleRearm();
      },
    },
    {
      mode: 'utterances',
      // A dictating speaker does not stop for the transcriber. Under the
      // default short pre-roll, everything said more than ~1.4 s into the gap
      // while the previous utterance was still going through STT was dropped
      // on the floor — the words simply never appeared, with no error.
      gapCapture: 'continuous',
    },
  );

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
  // Instant feedback: flip the pill out of "Listening" NOW. Draining the last
  // audio through STT takes a beat — seconds for local models on a long
  // utterance — and the pill sitting on "Listening" through that drain is
  // exactly why Escape felt like it needed two or three presses.
  setPhase('processing');
  const session = voiceSession;
  if (!session) {
    // Nothing to drain — deliver whatever was banked.
    beginDelivery();
    return;
  }
  // Leaving keep-warm makes stop() release the mic instead of parking it, so
  // `onEnd` fires once the final flushed utterance has landed in `accumulated`
  // — that is where delivery happens.
  session.setConversationMode(false);
  session.stop();
}

/**
 * Discard the dictation without delivering. Bound to Ctrl/Cmd+Escape while
 * listening (plain Escape while the mic is still opening).
 */
export function abortTranscription(): void {
  // Only a live capture — or a startup still in flight — can be cancelled;
  // delivery in flight runs to completion.
  if (phase !== 'listening' && !starting) return;
  // Clear state BEFORE releasing the mic. `teardownMic` stops the session,
  // which fires `onEnd`, and a stale "the graph stopped on its own" reaction
  // would happily deliver the very transcript the user just threw away — or
  // resurrect a dictation they cancelled before the mic ever opened.
  resetToIdle();
  teardownMic();
}

/**
 * The hotkey entry point. Idle → listen; listening → end and paste;
 * processing → ignored (delivery already in flight).
 *
 * Pressing the hotkey again is the same gesture as Escape: both end the
 * dictation. Nothing is delivered until one of them happens, which is what
 * lets you pause mid-thought without losing the sentence.
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
