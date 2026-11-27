import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import {
  currentVoiceInputModel,
  dictationVocabulary,
  getDefaultVoiceInputModel,
  getProviderBaseUrl,
  getProviderDef,
  isLocalProvider,
  smartVadEnabled,
  type AiProviderId,
  voiceInputProvider,
  voiceInputUsesModelTranscription,
} from '$lib/stores/settings';
import { isProviderApiKeyConfiguredLocal } from '$lib/services/ai-keychain';
import { getActiveEditorVocabulary } from '$lib/services/editor-symbols';
import { isWebkitGtk } from '$lib/utils/tauri';
import { normalizeTechnicalTranscript } from '$lib/services/technical-transcript';

export type VoiceInputCallbacks = {
  onStart?: () => void;
  onSpeechStart?: () => void;
  onResult: (transcript: string) => void;
  /**
   * Every finalized turn, fired exactly once per turn — whether the capture
   * graph was parked warm for the next one or torn down.
   *
   * `onEnd` deliberately does NOT do that job any more. It used to fire after
   * every finalized turn, so for any consumer that treats `onEnd` as "the mic
   * is gone" (the F9 dictation service does), an ordinary thinking pause
   * looked identical to the graph dying, and the dictation delivered itself
   * halfway through. Now: `onTurnComplete` = a turn finished; `onEnd` = the
   * capture graph really ended (user stop, teardown, fatal error).
   */
  onTurnComplete?: () => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  onProcessingStart?: (message: string) => void;
  onAudioLevel?: (rms: number) => void;
};

/**
 * How the webspeech engine hands transcripts to `onResult`. The two consumer
 * shapes genuinely disagree:
 *
 * - 'cumulative' (default): every `onresult` event carries the WHOLE
 *   transcript so far (finals + interim). What a live-preview/conversation
 *   consumer expects — it just replaces its draft each time.
 * - 'utterances': each event emits ONLY segments finalized since the previous
 *   event. What an accumulating consumer (dictation banking) needs — feeding
 *   it cumulative payloads duplicates every earlier word on every event, the
 *   reported "it writes what I say twice" bug.
 */
export type VoiceInputSessionOptions = {
  mode?: 'cumulative' | 'utterances';
  /**
   * What happens to audio spoken while the PREVIOUS turn is still being
   * transcribed — the window between the silence timer firing and the mic
   * re-arming, which is however long the STT round-trip takes (seconds, for a
   * local Whisper model on a long utterance).
   *
   * - 'pre-roll' (default): keep only a short rolling tail (PRE_ROLL_CHUNKS).
   *   What the conversational loop wants — it must not carry a wall of audio
   *   from the assistant's turn into the user's next one.
   * - 'continuous': keep EVERYTHING said in the gap, bounded only by
   *   GAP_CAPTURE_MAX_MS. What dictation needs: a speaker who pauses for
   *   800 ms and carries straight on is not waiting for the transcriber, and
   *   under 'pre-roll' every word past ~1.4 s of that gap was simply dropped.
   */
  gapCapture?: 'pre-roll' | 'continuous';
};

export type VoiceInputSession = {
  start: () => Promise<void>;
  stop: () => void;
  isSupported: () => boolean;
  /** Keep the mic warm between turns for the conversational loop (see impl). */
  setConversationMode: (enabled: boolean) => void;
};

export type VoiceRefineOptions = {
  allowNewLines?: boolean;
  spokenPunctuation?: boolean;
  /**
   * Strip hesitation words ("um", "uh", …) — the WhisperFlow/Typeless cleanup
   * everyone expects from a dictation bar. On by default: it is a mechanical,
   * word-bounded edit, safe even for terminal payloads (nobody dictates a bare
   * "um" as a shell command, and \b keeps it away from volume/urban).
   */
  removeFillers?: boolean;
  /**
   * Run the technical pass — spelled-out product names, acronym casing,
   * reconstructed CLI flags and file extensions, stumbled word repeats. On by
   * default: every rule in it is word-bounded and deterministic, and a
   * developer dictating "get hub" never meant two words.
   */
  technicalTerms?: boolean;
  /**
   * Capitalize sentence openings. Prose only — a terminal payload is a
   * command, where "Npm install" is a typo, so the dictation path leaves this
   * off for terminals.
   */
  capitalizeSentences?: boolean;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: null | (() => void);
  onresult: null | ((event: any) => void);
  onerror: null | ((event: any) => void);
  onend: null | (() => void);
  start: () => void;
  stop: () => void;
};

type AudioContextCtor = new () => AudioContext;
// VAD (voice-activity detection) tuning. A *fixed* RMS gate was the cause of the
// "stuck on Listening, transcript only appears when I exit" bug: when the room's
// noise floor sat near the threshold, every buffer looked like speech, so the
// silence timer never completed and the utterance never auto-finalized (only the
// manual stop on exit flushed it). We instead track the ambient noise floor and
// gate relative to it, with hysteresis, plus a hard cap so a wedged VAD can never
// listen forever.
const VAD_ABS_FLOOR = 0.002; // never treat anything quieter than this as speech
const VAD_ONSET_MULT = 2.0; // speech starts when RMS exceeds noiseFloor × this
const VAD_RELEASE_MULT = 1.1; // still speaking while RMS exceeds noiseFloor × this
// Absolute minimum RMS for speech onset. The relative gate alone let very quiet
// rooms (adapted floor ≈ VAD_ABS_FLOOR) trigger on breathing and mouse clicks;
// with the browser's AGC even soft speech lands well above this.
const VAD_ONSET_MIN_RMS = 0.01;
// Speech vs. background noise: a single loud buffer (~85 ms at 48 kHz) is how
// keyboard clicks, coughs and door slams got transcribed as turns — and, with
// barge-in, cut the assistant off mid-reply. Real speech sustains energy, so
// onset is only confirmed after this many consecutive above-threshold buffers
// (~250 ms). No audio is lost while confirming: buffers keep accumulating in
// capturedChunks either way.
const VAD_ONSET_FRAMES = 3;
// How long of a silence ends an utterance. The release-multiplier hysteresis
// (VAD_RELEASE_MULT) holds through the brief quiet dips *inside* a phrase, but
// this is what decides an end-of-turn — and at the old 500 ms it fired on the
// ordinary mid-sentence beat people leave while composing a thought ("spawn an
// agent that… uh… reviews the diff"), sending half a sentence to the
// orchestrator and swallowing the rest into the next turn. 800 ms is the
// shortest pause that reliably reads as "I'm done" rather than "I'm thinking".
const VAD_SILENCE_MS = 800;
// Grace for an utterance that has barely started. A false start or a one-word
// opener ("okay…", "so…") is almost never the whole turn, so give the speaker
// longer to continue before finalizing — this is the difference between the
// loop feeling patient and feeling like it interrupts.
const VAD_SILENCE_SHORT_MS = 1_200;
const VAD_SHORT_UTTERANCE_MS = 1_500;
// Soft ceiling on a single utterance. Past this we stop *extending* the turn but
// still wait for a real pause, so a long dictated brief is never chopped
// mid-word — the old hard 15 s cut is why detailed multi-agent instructions
// arrived truncated.
const VAD_MAX_UTTERANCE_MS = 45_000;
// Absolute ceiling. Only a wedged VAD (sustained noise that never dips below the
// release gate) can reach this, and it must never listen forever.
const VAD_HARD_MAX_UTTERANCE_MS = 120_000;
// While the graph is parked warm between turns we keep this many trailing
// buffers (~1.4 s at 48 kHz) as pre-roll. Without it, anything said in the gap
// between the assistant finishing and the mic re-arming is simply gone — which
// is why replies that began the instant the reply ended lost their first word.
const PRE_ROLL_CHUNKS = 16;
// Ceiling on 'continuous' gap capture (see `gapCapture`). Long enough to cover
// any realistic STT round-trip — including a large local model chewing on a
// 45 s utterance — while still bounding what a wedged transcription can hold in
// memory (60 s of 48 kHz mono f32 is ~11 MB).
const GAP_CAPTURE_MAX_MS = 60_000;

function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  // WebKitGTK (Linux) exposes a `webkitSpeechRecognition` object, but its
  // implementation is non-functional and its `.start()` segfaults the web
  // process — which takes the whole Tauri app down (the reported "mic closes the
  // app" crash). A native segfault is NOT catchable by the try/catch around
  // start(), so the only safe option is to never hand out the ctor here. Returning
  // null makes the webspeech provider surface a graceful "not supported" message
  // (and, because this check runs before getUserMedia, it also avoids touching the
  // mic at all on that path). Linux users should pick a local/cloud STT provider.
  if (isWebkitGtk()) return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

/** Is `getUserMedia` available in this runtime? */
function isGetUserMediaApiAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return true;
}

/** Probes whether the GStreamer audio bridge is installed on Linux.
 *
 * WebKitGTK (Tauri on Linux) enables media capture via GStreamer. If the
 * required GStreamer audio bridge (`gstreamer1.0-pulseaudio` for PulseAudio,
 * or `gstreamer1.0-pipewire` for PipeWire) is missing, calling getUserMedia
 * segfaults the web process — an unrecoverable crash.  This async check
 * asks the Rust backend whether the bridge .so is present.
 */
async function checkAudioSafe(): Promise<boolean> {
  if (!isGetUserMediaApiAvailable()) return false;
  if (!isWebkitGtk()) return true;
  try {
    return await invoke<boolean>('check_audio_safe');
  } catch {
    return false;
  }
}

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as any).AudioContext || (window as any).webkitAudioContext || null;
}

function getPreferredSpeechLanguage() {
  if (typeof navigator === 'undefined') return 'en-US';
  return navigator.languages?.[0] || navigator.language || 'en-US';
}

type SpeechRecognitionAlternativeLike = {
  transcript?: string;
  confidence?: number;
};

type SpeechRecognitionResultLike = {
  isFinal?: boolean;
  length?: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};

function getBestAlternative(result: SpeechRecognitionResultLike) {
  const alternatives = Array.from({ length: result.length ?? 0 }, (_, index) => result[index]).filter(Boolean);
  if (alternatives.length === 0) return '';

  const best = alternatives.reduce<SpeechRecognitionAlternativeLike>((winner, candidate) => {
    if (!winner) return candidate;
    return (candidate.confidence ?? 0) > (winner.confidence ?? 0) ? candidate : winner;
  }, alternatives[0]);

  return best?.transcript?.trim() || '';
}

function buildTranscript(results: ArrayLike<SpeechRecognitionResultLike>) {
  const finalSegments: string[] = [];
  let interimTranscript = '';

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const transcript = getBestAlternative(result);
    if (!transcript) continue;

    if (result.isFinal) {
      finalSegments[i] = transcript;
    } else {
      interimTranscript = transcript;
    }
  }

  return [...finalSegments.filter(Boolean), interimTranscript].filter(Boolean).join(' ').trim();
}

const SPOKEN_PUNCTUATION_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bnew paragraph\b/gi, '\n\n'],
  [/\bnew line\b/gi, '\n'],
  [/\bline break\b/gi, '\n'],
  [/\bnext line\b/gi, '\n'],
  [/\bcomma\b/gi, ','],
  [/\bperiod\b/gi, '.'],
  [/\bfull stop\b/gi, '.'],
  [/\bdot\b/gi, '.'],
  [/\bquestion mark\b/gi, '?'],
  [/\bexclamation mark\b/gi, '!'],
  [/\bexclamation point\b/gi, '!'],
  [/\bcolon\b/gi, ':'],
  [/\bsemicolon\b/gi, ';'],
  [/\bdash\b/gi, '-'],
  [/\bhyphen\b/gi, '-'],
  [/\bslash\b/gi, '/'],
  [/\bbackslash\b/gi, '\\'],
  [/\bopen parenthesis\b/gi, '('],
  [/\bclose parenthesis\b/gi, ')'],
  [/\bopen paren\b/gi, '('],
  [/\bclose paren\b/gi, ')'],
  [/\bopen bracket\b/gi, '['],
  [/\bclose bracket\b/gi, ']'],
  [/\bopen brace\b/gi, '{'],
  [/\bclose brace\b/gi, '}'],
  [/\bquote\b/gi, '"'],
  [/\bdouble quote\b/gi, '"'],
  [/\bapostrophe\b/gi, "'"],
];

// Hesitations dictation engines faithfully write down and nobody wants to keep.
// Word boundaries are what make this safe next to real vocabulary — "volume",
// "urban" and "here" never match; an optional trailing punctuation mark is
// swept up too so "wait um , okay" doesn't leave a dangling comma behind (the
// whitespace rules below clean up whatever spacing remains).
const FILLER_WORD_RE = /\b(?:umm?|uhh?|uhm|erm|ahh?)\b[.,;:!?]?\s*/gi;

export function refineVoiceTranscript(input: string, options: VoiceRefineOptions = {}) {
  const {
    allowNewLines = false,
    spokenPunctuation = true,
    removeFillers = true,
    technicalTerms = true,
    capitalizeSentences = false,
  } = options;
  let text = input.replace(/\r\n?/g, '\n').trim();

  if (!text) return '';

  // Before the punctuation table, which rewrites "dot" and "dash" to bare
  // symbols and so destroys the evidence that ".ts" and "--force" were ever
  // spoken. Capitalization is held back to the end of this function, once the
  // fillers are gone and each sentence starts where it looks like it starts.
  if (technicalTerms) {
    text = normalizeTechnicalTranscript(text);
  }

  if (spokenPunctuation) {
    for (const [pattern, replacement] of SPOKEN_PUNCTUATION_REPLACEMENTS) {
      text = text.replace(pattern, replacement);
    }
  }

  if (removeFillers) {
    text = text.replace(FILLER_WORD_RE, '');
  }

  if (!allowNewLines) {
    text = text.replace(/\s*\n+\s*/g, ' ');
  } else {
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
  }

  if (allowNewLines) {
    text = text
      .split('\n')
      .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
      .join('\n');
  } else {
    text = text.replace(/[ \t]{2,}/g, ' ');
  }

  text = text.replace(/\s+([,.;:!?])/g, '$1');

  if (capitalizeSentences) {
    text = normalizeTechnicalTranscript(text, { capitalize: true });
  }

  return text.trim();
}

export function mergeVoiceTranscript(base: string, transcript: string, separator = ' ') {
  const cleanBase = base.trimEnd();
  const cleanTranscript = transcript.trim();

  if (!cleanBase) return cleanTranscript;
  if (!cleanTranscript) return cleanBase;

  return `${cleanBase}${separator}${cleanTranscript}`;
}

async function verifyMicrophoneAccess(): Promise<string | null> {
  const stream = await requestMicrophoneStream();
  if (typeof stream === 'string') {
    return stream;
  }
  stream.getTracks().forEach((track) => track.stop());
  return null;
}

export async function requestMicrophoneStream(): Promise<MediaStream | string> {
  if (typeof window === 'undefined') {
    return 'Voice input is only available in the browser.';
  }

  if (!window.isSecureContext) {
    return 'Voice input requires localhost or HTTPS.';
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This runtime cannot access the microphone.';
  }

  if (!(await checkAudioSafe())) {
    return 'Microphone access requires the GStreamer audio bridge. Run: sudo apt install gstreamer1.0-pulseaudio';
  }

  // Check permission state before prompting — the browser/OS will show its own
  // permission prompt via getUserMedia below.
  if (navigator.permissions) {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (status.state === 'denied') {
        return 'Microphone access denied. Enable microphone permissions and try again.';
      }
    } catch {
      // Permissions API unavailable — fall through to getUserMedia
    }
  }

  try {
    // Enable the browser's DSP: echo cancellation stops speaker output
    // playback from being heard back by the mic (which, in hands-free voice mode,
    // kept the VAD from ever registering silence), and noise suppression lowers
    // the ambient floor so the silence detector actually fires.
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err: any) {
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      return 'Microphone access denied. Enable microphone permissions and try again.';
    }
    if (err?.name === 'NotFoundError') {
      return 'No microphone was found.';
    }
    if (err?.name === 'NotReadableError' || err?.name === 'AbortError') {
      return 'Microphone capture failed. Another app may be using it.';
    }
    return 'Could not access the microphone.';
  }
}

// Every STT consumer works on 16 kHz mono: local Whisper/Parakeet resample to
// 16 kHz in Rust, and the cloud endpoints accept it natively. Capture runs at
// the device rate (typically 44.1/48 kHz), so downsampling before the WAV
// encode cuts the Tauri IPC payload (serialized as a JSON number array) and any
// network upload to a third of the size — a directly audible chunk of the
// "stop talking → transcript appears" latency — and saves the backend resample.
const STT_SAMPLE_RATE = 16_000;

export function downsamplePcmChunks(chunks: Float32Array[], fromRate: number, toRate: number): Float32Array {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const input = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  if (fromRate <= toRate || totalSamples === 0) return input;

  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(totalSamples / ratio));
  for (let i = 0; i < output.length; i += 1) {
    // Average the source window per output sample — a cheap box filter that
    // keeps aliasing out of the speech band without a full FIR pass.
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), totalSamples);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = end > start ? sum / (end - start) : input[start] ?? 0;
  }
  return output;
}

function pcmToWavBytes(chunks: Float32Array[], sampleRate: number) {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
}

function mapRecognitionError(code: string | undefined) {
  switch (code) {
    case 'aborted':
      return 'Voice input was stopped.';
    case 'no-speech':
      return 'No speech was detected.';
    case 'audio-capture':
      return 'Microphone capture failed.';
    case 'not-allowed':
      return 'Microphone access denied.';
    case 'network':
      return 'Speech recognition network error.';
    default:
      return code ? `Voice input error: ${code}` : 'Voice input failed.';
  }
}

export function createVoiceInputSession(
  callbacks: VoiceInputCallbacks,
  options: VoiceInputSessionOptions = {},
): VoiceInputSession {
  const { mode = 'cumulative', gapCapture = 'pre-roll' } = options;
  const continuousGap = gapCapture === 'continuous';
  let recognition: BrowserSpeechRecognition | null = null;
  // Results already handed to onResult in 'utterances' mode (webspeech only).
  // The engine re-sends every result on each event; anything before this index
  // is history we've already delivered.
  let finalsEmitted = 0;
  let starting = false;
  let stopRequested = false;
  let transcriptionPending = false;
  let captureStream: MediaStream | null = null;
  let captureContext: AudioContext | null = null;
  let captureSource: MediaStreamAudioSourceNode | null = null;
  let captureProcessor: ScriptProcessorNode | null = null;
  let capturedChunks: Float32Array[] = [];
  let captureSampleRate = 16_000;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let speechDetected = false;
  // Consecutive above-threshold buffers seen while waiting for speech onset;
  // speechDetected flips only once this reaches VAD_ONSET_FRAMES (see the
  // constant's comment — this is what separates speech from transient noise).
  let onsetRun = 0;
  let startTime = 0;
  // When speech onset was confirmed in the current turn (0 = not yet). Used to
  // pick the end-of-turn silence window: a turn that has barely started gets a
  // longer grace than one already carrying a full sentence.
  let speechStartedAt = 0;
  // Audio captured while the graph is warm but not listening — a short rolling
  // pre-roll by default, everything said in the gap under 'continuous' — so a
  // turn that begins before the mic re-arms doesn't lose its first syllable
  // (or, in dictation, its next three sentences).
  let preRoll: Float32Array[] = [];
  // Whether the gap audio above already contains confirmed speech. The next
  // turn's onset detector only looks forward from the re-arm, so without this
  // a stretch of speech that lived ENTIRELY inside the gap would be carried
  // into `capturedChunks` and then thrown away by the `!speechDetected` bail.
  let gapHadSpeech = false;
  let gapVoicedRun = 0;
  // Rolling estimate of the ambient noise floor (RMS), seeded during the mic
  // warmup and adapted between utterances so the gate tracks the room.
  let noiseFloor = 0;
  // Conversation ("keep-warm") mode: when set, the capture graph (mic stream +
  // AudioContext + processor) is kept alive between turns and re-armed instantly
  // instead of torn down and re-acquired (getUserMedia + AudioContext + warmup)
  // on every turn — the dominant source of inter-turn lag in the voice loop.
  let keepWarm = false;
  // Whether the live graph is currently feeding audio into a turn. False while a
  // turn is transcribing or the graph is parked warm between turns, so the
  // always-running processor ignores audio until the next re-arm.
  let listening = false;
  // Set when stop() arrives mid-transcription: the in-flight finalizer releases
  // the mic in its `finally` instead of parking the graph warm.
  let teardownRequested = false;

  // ── Smart VAD (Silero, native) ────────────────────────────────────────────
  // When enabled AND the model is downloaded, raw PCM batches go to Rust and
  // the turn decision runs on Silero's speech probability instead of the RMS
  // gate. ANY failure here silently reverts to the level gate — smart VAD is
  // an upgrade, never a dependency. Hysteresis mirrors the gate: higher bar to
  // START a turn than to KEEP it.
  let vadSessionId: number | null = null;
  let vadProb = 0;
  let vadQueue: Float32Array[] = [];
  // ~4 processor buffers (~85 ms each at 48 kHz) per IPC batch keeps traffic
  // around 3 calls/second without adding perceptible endpointing lag.
  const VAD_FLUSH_FRAMES = 4;
  const VAD_ONSET_PROB = 0.55;
  const VAD_RELEASE_PROB = 0.35;

  function ensureVad(): void {
    if (!get(smartVadEnabled) || vadSessionId != null) return;
    invoke<number>('vad_session_start')
      .then((id) => {
        // A stop() may already have torn things down while we were starting.
        if (!get(smartVadEnabled)) {
          void invoke('vad_session_end', { sessionId: id }).catch(() => undefined);
          return;
        }
        vadSessionId = id;
        vadProb = 0;
      })
      .catch(() => {
        // Model missing, ORT absent, whatever — level gate carries on.
        vadSessionId = null;
      });
  }

  function stopVad(): void {
    if (vadSessionId != null) {
      const id = vadSessionId;
      void invoke('vad_session_end', { sessionId: id }).catch(() => undefined);
    }
    vadSessionId = null;
    vadProb = 0;
    vadQueue = [];
  }

  function flushVadQueue(): void {
    if (vadSessionId == null || vadQueue.length === 0) return;
    const batch = vadQueue;
    vadQueue = [];
    const total = batch.reduce((sum, chunk) => sum + chunk.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const chunk of batch) {
      for (let i = 0; i < chunk.length; i += 1) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm[offset + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      offset += chunk.length;
    }
    invoke<number>('vad_session_feed', {
      sessionId: vadSessionId,
      samples: Array.from(pcm),
      sampleRate: captureSampleRate,
    })
      .then((prob) => {
        if (typeof prob === 'number') vadProb = prob;
      })
      .catch(() => {
        // The backend gave up on this session (model removed mid-dictation,
        // ORT failure): revert to the level gate for the rest of the capture.
        vadSessionId = null;
        vadProb = 0;
      });
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  // Re-arm the VAD for the next turn on an already-live graph: drop the previous
  // utterance's audio and reset speech state, but KEEP the learned noise floor
  // (the room hasn't changed) and re-base the warmup window.
  function softResetVad() {
    clearSilenceTimer();
    // Seed the new turn with the gap audio so speech that started — or, under
    // 'continuous', ran entirely — while the last turn was transcribing is
    // still in what we send to STT.
    capturedChunks = preRoll;
    preRoll = [];
    // Carry the gap's own speech verdict forward. Onset confirmation runs on
    // live buffers only, so a turn whose speech is all in the past would
    // otherwise finalize as silence and drop the words.
    speechDetected = gapHadSpeech;
    speechStartedAt = gapHadSpeech ? Date.now() : 0;
    gapHadSpeech = false;
    gapVoicedRun = 0;
    onsetRun = 0;
    startTime = Date.now();
  }

  function clearCaptureState() {
    clearSilenceTimer();
    captureProcessor?.disconnect();
    captureSource?.disconnect();
    if (captureContext && captureContext.state !== 'closed') {
      void captureContext.close().catch(() => undefined);
    }
    captureStream?.getTracks().forEach((track) => track.stop());
    captureProcessor = null;
    captureSource = null;
    captureContext = null;
    captureStream = null;
    capturedChunks = [];
    preRoll = [];
    gapHadSpeech = false;
    gapVoicedRun = 0;
    speechDetected = false;
    speechStartedAt = 0;
    onsetRun = 0;
    noiseFloor = 0;
    listening = false;
    // The Rust VAD session belongs to this capture graph — release it with it.
    stopVad();
  }

  function autoStopAfterSilence() {
    if (stopRequested || transcriptionPending || (!captureStream && !captureContext)) return;
    // Normal end-of-turn (silence or hard cap). Halt capture via `listening`
    // (NOT `stopRequested`, which is reserved for a real user stop) so
    // finishGoogleTranscription can tell a turn-end apart from an exit and park
    // the graph warm instead of releasing the mic.
    listening = false;
    void finishGoogleTranscription();
  }

  // Park the live capture graph for the next turn (keep-warm) unless we're
  // actually stopping — in which case release the mic. Called at the same point
  // the old code unconditionally tore everything down.
  function releaseOrParkGraph() {
    if (keepWarm && !stopRequested && !teardownRequested) {
      softResetVad();
    } else {
      clearCaptureState();
    }
  }

  async function finishGoogleTranscription() {
    if (transcriptionPending) return;
    transcriptionPending = true;
    listening = false;
    clearSilenceTimer();
    callbacks.onProcessingStart?.('Transcribing with Google…');

    if (capturedChunks.length === 0 || !speechDetected) {
      // Decide from the flags BEFORE anything mutates them: does this finalize
      // end the capture graph, or park it warm for the next turn?
      const graphEnded = !keepWarm || stopRequested || teardownRequested;
      releaseOrParkGraph();
      transcriptionPending = false;
      stopRequested = false;
      teardownRequested = false;
      callbacks.onResult('');
      if (graphEnded) callbacks.onEnd?.();
      callbacks.onTurnComplete?.();
      return;
    }

    // All local STT (Parakeet and Whisper) runs natively in Rust via
    // `local_stt_transcribe`, receiving WAV bytes. Parakeet used to run
    // in-renderer via onnxruntime-web (WASM), but that grew a CPU memory arena
    // that never shrank and OOM-killed the WebKitGTK web process on long
    // utterances — so it now runs in the app process alongside Whisper.
    const pcm = downsamplePcmChunks(capturedChunks, captureSampleRate, STT_SAMPLE_RATE);
    const bytes = pcmToWavBytes([pcm], Math.min(captureSampleRate, STT_SAMPLE_RATE));
    releaseOrParkGraph();

    try {
      const provider = get(voiceInputProvider);
      let transcript = '';
      // Hotword biasing at the SOURCE: the developer's custom terms go into
      // the transcription request itself (Whisper initial-prompt conditioning,
      // Gemini/OpenAI prompt hints), so names come out right before any
      // polish pass — including the mechanical-only terminal path. The user's
      // own list ranks first; the active editor's identifiers ride along after
      // it (STT spelling hints only — never fed to the prose rewriter).
      const customTerms = get(dictationVocabulary).trim();
      const vocabulary = [customTerms, ...getActiveEditorVocabulary()]
        .filter(Boolean)
        .join(', ')
        .trim() || undefined;
      if (provider === 'local') {
        const model = get(currentVoiceInputModel) || getDefaultVoiceInputModel(provider);
        // Parakeet runs on ONNX Runtime, which no build ships: fetch it once.
        if (model.startsWith('parakeet')) {
          const runtime = await invoke<{ installed: boolean; supported: boolean } | null>('onnx_runtime_status');
          if (runtime && !runtime.installed && runtime.supported) {
            callbacks.onProcessingStart?.('Downloading ONNX Runtime…');
            const { showToast } = await import('$lib/stores/notification');
            showToast('Downloading ONNX Runtime (about 160 MB, once). Your words will be typed when it finishes.', 'info', 10000);
            await invoke('onnx_runtime_download');
          }
        }
        callbacks.onProcessingStart?.('Transcribing locally…');
        transcript = await invoke<string>('local_stt_transcribe', {
          audioBytes: Array.from(bytes),
          modelId: model,
          initialPrompt: vocabulary,
        });
      } else {
        const providerId = (provider === 'webspeech' ? 'google' : provider) as AiProviderId;
        const providerDef = getProviderDef(providerId);
        const local = provider !== 'fish' && isLocalProvider(providerId);
        const hasApiKey = provider === 'fish' || local || isProviderApiKeyConfiguredLocal(providerDef.id);
        const baseUrl = local ? getProviderBaseUrl(providerId) : '';
        if (!hasApiKey) {
          throw new Error(`${providerDef.label} API key is missing. Add it in Settings to use voice mode.`);
        }
        if (local && !baseUrl) {
          throw new Error(`${providerDef.label} server URL is missing. Add it in Settings to use voice mode.`);
        }
        const model = get(currentVoiceInputModel) || getDefaultVoiceInputModel(provider);
        transcript = await invoke<string>('ai_transcribe_audio', {
          audioBytes: Array.from(bytes),
          mimeType: 'audio/wav',
          provider,
          model,
          apiKey: '',
          baseUrl: baseUrl || undefined,
          vocabulary,
        });
      }
      callbacks.onResult(transcript.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError?.(message || 'Transcription failed.');
    } finally {
      transcriptionPending = false;
      // Read while the flags still describe this finalize: a warm park keeps
      // the graph (keepWarm, nothing requested a stop); anything else — user
      // stop, teardown-while-busy, conversation mode off — ends it.
      const graphEnded = !keepWarm || stopRequested || teardownRequested;
      // A stop() that arrived while this transcription was in flight parked the
      // graph warm (it couldn't tear down mid-finalize) — release the mic now.
      if (teardownRequested) {
        teardownRequested = false;
        clearCaptureState();
      }
      stopRequested = false;
      // onEnd is reserved for "the capture graph is gone". A warm-parked turn
      // fires onTurnComplete only — firing onEnd here as well made every
      // end-of-turn pause indistinguishable from the mic dying, which is how
      // dictations delivered themselves at the first thinking pause.
      if (graphEnded) callbacks.onEnd?.();
      callbacks.onTurnComplete?.();
    }
  }

  return {
    isSupported() {
      const provider = get(voiceInputProvider);
      if (voiceInputUsesModelTranscription(provider)) {
        return !!getAudioContextCtor() && isGetUserMediaApiAvailable();
      }
      return !!getSpeechRecognitionCtor();
    },

    async start() {
      if (starting || recognition) return;
      const provider = get(voiceInputProvider);

      if (voiceInputUsesModelTranscription(provider)) {
        if (transcriptionPending) return; // a turn is still finalizing

        // Warm re-arm: the capture graph from the previous turn is still alive
        // (keep-warm conversation mode), so just reset the VAD and resume —
        // skipping getUserMedia, AudioContext creation, and the mic warmup that
        // otherwise run on every single turn.
        if (captureContext && captureContext.state !== 'closed' && captureProcessor && captureStream) {
          stopRequested = false;
          teardownRequested = false;
          // A parked context can auto-suspend (OS audio interruption); resume it
          // so the processor keeps firing on this turn.
          if (captureContext.state === 'suspended') void captureContext.resume().catch(() => undefined);
          softResetVad();
          ensureVad();
          listening = true;
          callbacks.onStart?.();
          return;
        }

        const AudioContextClass = getAudioContextCtor();
        if (!AudioContextClass) {
          callbacks.onError?.('Voice input is not supported in this runtime.');
          return;
        }

        starting = true;
        stopRequested = false;
        let streamOrError: MediaStream | string;
        try {
          streamOrError = await requestMicrophoneStream();
        } catch (err) {
          starting = false;
          callbacks.onError?.(err instanceof Error ? err.message : 'Could not access the microphone.');
          return;
        }
        if (typeof streamOrError === 'string') {
          starting = false;
          callbacks.onError?.(streamOrError);
          return;
        }
        if (stopRequested) {
          starting = false;
          streamOrError.getTracks().forEach((track) => track.stop());
          return;
        }

        try {
          captureStream = streamOrError;
          captureContext = new AudioContextClass();
          captureSampleRate = captureContext.sampleRate;
          captureSource = captureContext.createMediaStreamSource(streamOrError);
          captureProcessor = captureContext.createScriptProcessor(4096, 1, 1);
          capturedChunks = [];
          preRoll = [];
          speechDetected = false;
          speechStartedAt = 0;
          onsetRun = 0;
          clearSilenceTimer();
          startTime = Date.now();
          noiseFloor = VAD_ABS_FLOOR;
          listening = true;

          captureProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
            // The processor runs continuously in keep-warm mode; only feed audio
            // into the VAD while a turn is actively listening (not between turns
            // or during transcription). Between turns we still keep a short
            // rolling pre-roll so a turn that starts before the mic re-arms
            // isn't missing its opening syllable (see PRE_ROLL_CHUNKS).
            if (stopRequested || !listening) {
              if (!stopRequested) {
                const gapBuffer = new Float32Array(event.inputBuffer.getChannelData(0));
                preRoll.push(gapBuffer);
                if (continuousGap) {
                  // Dictation: the speaker did not stop for us. Keep every
                  // buffer, and run the same onset test over it so the next
                  // turn knows this audio holds speech (see `gapHadSpeech`).
                  // The level meter keeps ticking too — a pill that freezes
                  // while you are mid-sentence reads as "it stopped hearing me".
                  let gapSumSquares = 0;
                  for (let i = 0; i < gapBuffer.length; i += 1) {
                    gapSumSquares += gapBuffer[i] * gapBuffer[i];
                  }
                  const gapRms = Math.sqrt(gapSumSquares / Math.max(gapBuffer.length, 1));
                  callbacks.onAudioLevel?.(gapRms);
                  if (gapRms >= Math.max(VAD_ONSET_MIN_RMS, noiseFloor * VAD_ONSET_MULT)) {
                    gapVoicedRun += 1;
                    if (gapVoicedRun >= VAD_ONSET_FRAMES) gapHadSpeech = true;
                  } else {
                    gapVoicedRun = 0;
                  }
                }
                const gapCap = continuousGap
                  ? Math.max(
                      PRE_ROLL_CHUNKS,
                      Math.ceil((GAP_CAPTURE_MAX_MS / 1000) * captureSampleRate / gapBuffer.length),
                    )
                  : PRE_ROLL_CHUNKS;
                if (preRoll.length > gapCap) {
                  preRoll.splice(0, preRoll.length - gapCap);
                }
              }
              return;
            }
            const input = event.inputBuffer.getChannelData(0);
            capturedChunks.push(new Float32Array(input));
            // Smart VAD: every listening buffer also queues for the native
            // detector. The RMS work below stays — it still drives the level
            // meter and the fallback gate.
            vadQueue.push(new Float32Array(input));
            if (vadQueue.length >= VAD_FLUSH_FRAMES) flushVadQueue();

            let sumSquares = 0;
            for (let i = 0; i < input.length; i += 1) {
              sumSquares += input[i] * input[i];
            }
            const rms = Math.sqrt(sumSquares / Math.max(input.length, 1));
            callbacks.onAudioLevel?.(rms);

            // Skip the first 150ms (mic startup artifacts) but still adapt the
            // noise floor so we start with a sensible estimate.
            if (Date.now() - startTime < 150) {
              noiseFloor = noiseFloor * 0.9 + rms * 0.1;
              return;
            }

            // Absolute ceiling: only a wedged VAD gets here, and it must never
            // listen forever. The *soft* cap (VAD_MAX_UTTERANCE_MS) is handled
            // below by shortening the end-of-turn wait rather than cutting, so a
            // long dictated brief ends on a pause instead of mid-word.
            if (Date.now() - startTime >= VAD_HARD_MAX_UTTERANCE_MS) {
              clearSilenceTimer();
              autoStopAfterSilence();
              return;
            }

            // Simple gate: speech if above threshold, silence if below. Onset
            // has a higher bar than release (hysteresis) to avoid chatter.
            const threshold = speechDetected
              ? Math.max(VAD_ABS_FLOOR, noiseFloor * VAD_RELEASE_MULT)
              : Math.max(VAD_ONSET_MIN_RMS, noiseFloor * VAD_ONSET_MULT);

            // When the native detector is live it OWNS the decision: Silero's
            // speech probability with hysteresis replaces the loudness compare,
            // which is what makes clicks/fans/fans-of-noise stop counting as
            // turns. The level gate remains as instant fallback.
            const active = vadSessionId != null
              ? vadProb >= (speechDetected ? VAD_RELEASE_PROB : VAD_ONSET_PROB)
              : rms >= threshold;

            if (active) {
              if (!speechDetected) {
                // Confirm onset only after several consecutive loud buffers so
                // a lone transient (keyboard click, cough, door slam) neither
                // starts a turn nor barges in on the assistant's reply.
                onsetRun += 1;
                if (onsetRun >= VAD_ONSET_FRAMES) {
                  speechDetected = true;
                  speechStartedAt = Date.now();
                  callbacks.onSpeechStart?.();
                }
              }
              clearSilenceTimer();
              return;
            }

            // Below the gate: any unconfirmed onset was just a transient.
            onsetRun = 0;

            // No speech — blend noise floor toward the ambient level.
            noiseFloor = noiseFloor * 0.95 + rms * 0.05;

            if (speechDetected && !silenceTimer) {
              // Pick the end-of-turn wait from how much has actually been said:
              // a turn still under VAD_SHORT_UTTERANCE_MS is more likely a false
              // start than a complete thought, so wait longer before finalizing.
              // Past the soft cap, stop extending — take the first real pause.
              const spokenMs = speechStartedAt ? Date.now() - speechStartedAt : 0;
              const overSoftCap = Date.now() - startTime >= VAD_MAX_UTTERANCE_MS;
              const wait = overSoftCap
                ? VAD_SILENCE_MS
                : spokenMs < VAD_SHORT_UTTERANCE_MS
                  ? VAD_SILENCE_SHORT_MS
                  : VAD_SILENCE_MS;
              silenceTimer = setTimeout(() => {
                silenceTimer = null;
                autoStopAfterSilence();
              }, wait);
            }
          };

          captureSource.connect(captureProcessor);
          // Connect to destination so the ScriptProcessorNode fires callbacks
          // (required by many browser implementations).
          captureProcessor.connect(captureContext.destination);
          starting = false;
          ensureVad();
          callbacks.onStart?.();
        } catch {
          starting = false;
          clearCaptureState();
          callbacks.onError?.('Could not start voice input.');
        }
        return;
      }

      const SpeechRecognition = getSpeechRecognitionCtor();
      if (!SpeechRecognition) {
        callbacks.onError?.(
          isWebkitGtk()
            ? 'Web Speech voice input isn’t available on Linux. Pick a local or cloud voice provider in Settings → Voice.'
            : 'Voice input is not supported in this runtime.',
        );
        return;
      }

      starting = true;
      stopRequested = false;
      const micError = await verifyMicrophoneAccess();
      if (micError) {
        starting = false;
        callbacks.onError?.(micError);
        return;
      }
      if (stopRequested) {
        starting = false;
        return;
      }

      const recognizer: BrowserSpeechRecognition = new SpeechRecognition();
      recognition = recognizer;
      speechDetected = false;
      finalsEmitted = 0;
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.maxAlternatives = 3;
      recognizer.lang = getPreferredSpeechLanguage();

      recognizer.onstart = () => {
        starting = false;
        if (stopRequested) {
          recognizer.stop();
          return;
        }
        callbacks.onStart?.();
      };

      recognizer.onresult = (event: any) => {
        // Fire onSpeechStart on the first result so barge-in works with Web Speech.
        if (!speechDetected && event?.results?.length > 0) {
          speechDetected = true;
          callbacks.onSpeechStart?.();
        }
        if (mode === 'utterances') {
          // Emit ONLY what finalized since the last event. The engine re-sends
          // the whole result list every time; banking cumulative payloads was
          // duplicating each earlier word on every event ("hello", then
          // "hello world" → delivered "hello hello world"). Scanning stops at
          // the first non-final entry — results finalize left to right, and an
          // interim slot may still be rewritten in place by the next event.
          const pieces: string[] = [];
          let consumed = finalsEmitted;
          for (let i = finalsEmitted; i < (event?.results?.length ?? 0); i += 1) {
            const result = event.results[i];
            if (!result?.isFinal) break;
            const transcript = getBestAlternative(result);
            if (transcript) pieces.push(transcript);
            consumed = i + 1;
          }
          finalsEmitted = consumed;
          if (pieces.length > 0) callbacks.onResult(pieces.join(' ').trim());
          return;
        }
        const transcript = buildTranscript(event?.results ?? []);
        callbacks.onResult(transcript);
      };

      recognizer.onerror = (event: any) => {
        starting = false;
        if (event?.error === 'aborted') {
          return;
        }
        callbacks.onError?.(mapRecognitionError(event?.error));
      };

      recognizer.onend = () => {
        starting = false;
        if (recognition === recognizer) {
          recognition = null;
        }
        stopRequested = false;
        callbacks.onEnd?.();
      };

      try {
        recognizer.start();
      } catch {
        starting = false;
        callbacks.onError?.('Could not start voice input.');
      }
    },

    stop() {
      stopRequested = true;
      listening = false;
      keepWarm = false; // leaving the loop — release the mic, don't park it warm
      if (transcriptionPending) {
        // A turn is transcribing and can't be torn down mid-finalize; its
        // `finally` releases the mic once it settles.
        teardownRequested = true;
        return;
      }
      if (captureStream || captureContext) {
        void finishGoogleTranscription();
        return;
      }
      recognition?.stop();
      recognition = null;
    },

    // Enable "keep-warm" behavior for the conversational voice loop: the capture
    // graph stays alive between turns so each turn re-arms instantly instead of
    // re-acquiring the mic. Disable (and call stop()) when leaving voice mode.
    setConversationMode(enabled: boolean) {
      keepWarm = enabled;
    },
  };
}
