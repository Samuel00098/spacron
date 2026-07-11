import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import {
  currentVoiceInputModel,
  getDefaultVoiceInputModel,
  getProviderBaseUrl,
  getProviderDef,
  isLocalProvider,
  type AiProviderId,
  voiceInputProvider,
  voiceInputUsesModelTranscription,
} from '$lib/stores/settings';
import { isProviderApiKeyConfiguredLocal } from '$lib/services/ai-keychain';
import { isWebkitGtk } from '$lib/utils/tauri';

export type VoiceInputCallbacks = {
  onStart?: () => void;
  onSpeechStart?: () => void;
  onResult: (transcript: string) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
  onProcessingStart?: (message: string) => void;
  onAudioLevel?: (rms: number) => void;
};

export type VoiceInputSession = {
  start: () => Promise<void>;
  stop: () => void;
  isSupported: () => boolean;
  /** Keep the mic warm between turns for the conversational loop (see impl). */
  setConversationMode: (enabled: boolean) => void;
  /**
   * Tell the VAD the assistant's TTS reply is playing. While set, the speech
   * onset gate is raised (see VAD_PLAYBACK_*) so echo residue doesn't trigger a
   * false barge-in, and pre-speech audio is trimmed to a short lead-in.
   */
  setPlaybackActive: (active: boolean) => void;
};

export type VoiceRefineOptions = {
  allowNewLines?: boolean;
  spokenPunctuation?: boolean;
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
// How long of a silence ends an utterance. Kept snappy for responsive turn-
// taking; the release-multiplier hysteresis (VAD_RELEASE_MULT) holds through the
// brief quiet dips inside a sentence, so this only elapses on a real end-of-turn
// pause rather than cutting a speaker off mid-thought.
const VAD_SILENCE_MS = 500;
// Absolute ceiling on a single utterance.
const VAD_MAX_UTTERANCE_MS = 15_000;
// Barge-in gate: while the assistant's TTS reply is playing the mic stays live
// so the user can interrupt, but echo-cancellation residue can still leak the
// reply into the capture. Require a clearly louder onset before treating audio
// as user speech during playback — a real interruption easily clears it.
const VAD_PLAYBACK_ONSET_MULT = 2.5;
const VAD_PLAYBACK_ABS_FLOOR = 0.025;
// While playback is active and no speech has been detected, keep only this many
// trailing buffers (~0.5 s) so a barge-in turn starts with a clean lead-in
// instead of dragging the whole reply's echo into the transcript.
const PLAYBACK_TAIL_CHUNKS = 6;

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

export function refineVoiceTranscript(input: string, options: VoiceRefineOptions = {}) {
  const { allowNewLines = false, spokenPunctuation = true } = options;
  let text = input.replace(/\r\n?/g, '\n').trim();

  if (!text) return '';

  if (spokenPunctuation) {
    for (const [pattern, replacement] of SPOKEN_PUNCTUATION_REPLACEMENTS) {
      text = text.replace(pattern, replacement);
    }
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
    // Enable the browser's DSP: echo cancellation stops the assistant's own TTS
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

export function createVoiceInputSession(callbacks: VoiceInputCallbacks): VoiceInputSession {
  let recognition: BrowserSpeechRecognition | null = null;
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
  // True while the assistant's TTS reply is playing (see setPlaybackActive).
  let playbackActive = false;

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
    capturedChunks = [];
    speechDetected = false;
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
    speechDetected = false;
    onsetRun = 0;
    noiseFloor = 0;
    listening = false;
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
      releaseOrParkGraph();
      transcriptionPending = false;
      stopRequested = false;
      callbacks.onResult('');
      callbacks.onEnd?.();
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
      if (provider === 'local') {
        callbacks.onProcessingStart?.('Transcribing locally…');
        const model = get(currentVoiceInputModel) || getDefaultVoiceInputModel(provider);
        transcript = await invoke<string>('local_stt_transcribe', {
          audioBytes: Array.from(bytes),
          modelId: model,
        });
      } else {
        const providerId = (provider === 'webspeech' ? 'google' : provider) as AiProviderId;
        const providerDef = getProviderDef(providerId);
        const local = isLocalProvider(providerId);
        const hasApiKey = local || isProviderApiKeyConfiguredLocal(providerDef.id);
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
        });
      }
      callbacks.onResult(transcript.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError?.(message || 'Transcription failed.');
    } finally {
      transcriptionPending = false;
      // A stop() that arrived while this transcription was in flight parked the
      // graph warm (it couldn't tear down mid-finalize) — release the mic now.
      if (teardownRequested) {
        teardownRequested = false;
        clearCaptureState();
      }
      stopRequested = false;
      callbacks.onEnd?.();
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
        const streamOrError = await requestMicrophoneStream();
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
          speechDetected = false;
          onsetRun = 0;
          clearSilenceTimer();
          startTime = Date.now();
          noiseFloor = VAD_ABS_FLOOR;
          listening = true;

          captureProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
            // The processor runs continuously in keep-warm mode; only feed audio
            // into the VAD while a turn is actively listening (not between turns
            // or during transcription).
            if (stopRequested || !listening) return;
            const input = event.inputBuffer.getChannelData(0);
            capturedChunks.push(new Float32Array(input));

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

            // Hard cap: never listen indefinitely.
            if (Date.now() - startTime >= VAD_MAX_UTTERANCE_MS) {
              clearSilenceTimer();
              autoStopAfterSilence();
              return;
            }

            // Waiting for a barge-in: drop all but a short rolling lead-in so
            // the eventual turn doesn't start with the assistant's own reply.
            if (playbackActive && !speechDetected && capturedChunks.length > PLAYBACK_TAIL_CHUNKS) {
              capturedChunks.splice(0, capturedChunks.length - PLAYBACK_TAIL_CHUNKS);
            }

            // Simple gate: speech if RMS exceeds threshold, silence if below.
            // Onset has a higher bar than release (hysteresis) to avoid chatter,
            // and a higher bar still while the assistant's reply is playing.
            const threshold = speechDetected
              ? Math.max(VAD_ABS_FLOOR, noiseFloor * VAD_RELEASE_MULT)
              : playbackActive
                ? Math.max(VAD_PLAYBACK_ABS_FLOOR, noiseFloor * VAD_PLAYBACK_ONSET_MULT)
                : Math.max(VAD_ONSET_MIN_RMS, noiseFloor * VAD_ONSET_MULT);

            if (rms >= threshold) {
              if (!speechDetected) {
                // Confirm onset only after several consecutive loud buffers so
                // a lone transient (keyboard click, cough, door slam) neither
                // starts a turn nor barges in on the assistant's reply.
                onsetRun += 1;
                if (onsetRun >= VAD_ONSET_FRAMES) {
                  speechDetected = true;
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
              silenceTimer = setTimeout(() => {
                silenceTimer = null;
                autoStopAfterSilence();
              }, VAD_SILENCE_MS);
            }
          };

          captureSource.connect(captureProcessor);
          // Connect to destination so the ScriptProcessorNode fires callbacks
          // (required by many browser implementations).
          captureProcessor.connect(captureContext.destination);
          starting = false;
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

    setPlaybackActive(active: boolean) {
      playbackActive = active;
    },
  };
}
