import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const isProviderApiKeyConfiguredLocal = vi.hoisted(() => vi.fn((_provider: string): boolean => false));
/** Controllable stand-in for the active editor's extracted symbols. */
const editorSymbols = vi.hoisted(() => ({ value: [] as string[] }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/services/ai-keychain', () => ({ isProviderApiKeyConfiguredLocal }));
vi.mock('$lib/services/editor-symbols', () => ({
  getActiveEditorVocabulary: () => editorSymbols.value,
}));

import { createVoiceInputSession, downsamplePcmChunks, refineVoiceTranscript } from './voice-input';
import {
  aiBaseUrlByProvider,
  dictationVocabulary,
  smartVadEnabled,
  voiceInputModelByProvider,
  voiceInputProvider,
} from '$lib/stores/settings';

type MockTrack = { stop: ReturnType<typeof vi.fn> };
type MockStream = { getTracks: () => MockTrack[] };

class MockScriptProcessor {
  onaudioprocess: null | ((event: any) => void) = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockMediaStreamSource {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioContext {
  sampleRate = 16_000;
  state = 'running';
  destination = {};
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createMediaStreamSource = vi.fn(() => new MockMediaStreamSource());
  createScriptProcessor = vi.fn(() => {
    const processor = new MockScriptProcessor();
    audioProcessors.push(processor);
    return processor as any;
  });
  constructor() {
    audioContexts.push(this);
  }
}

class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = 'en-US';
  maxAlternatives = 1;
  onstart: null | (() => void) = null;
  onresult: null | ((event: any) => void) = null;
  onerror: null | ((event: any) => void) = null;
  onend: null | (() => void) = null;
  start = vi.fn();
  stop = vi.fn();

  constructor() {
    recognizers.push(this);
  }
}

let recognizers: MockSpeechRecognition[] = [];
let audioProcessors: MockScriptProcessor[] = [];
let audioContexts: MockAudioContext[] = [];
const permissionsQuery = vi.fn();
const getUserMedia = vi.fn<() => Promise<MockStream>>();

function installBrowserStubs() {
  const mockWindow = {};
  Object.defineProperty(globalThis, 'window', {
    value: mockWindow,
    configurable: true,
  });
  Object.defineProperty(mockWindow, 'SpeechRecognition', {
    value: MockSpeechRecognition,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(mockWindow, 'webkitSpeechRecognition', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(mockWindow, 'AudioContext', {
    value: MockAudioContext,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(mockWindow, 'webkitAudioContext', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(mockWindow, 'isSecureContext', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      language: 'en-US',
      languages: ['en-US'],
      permissions: { query: permissionsQuery },
      mediaDevices: { getUserMedia },
    },
    configurable: true,
  });
}

// Speech RMS ≈ 0.21 — well above the onset gate. Onset needs several
// consecutive loud buffers (VAD_ONSET_FRAMES) before it counts as speech, so
// helpers feed this repeatedly.
const LOUD_BUFFER = [0.25, 0.2, 0.18, 0.22];
const ONSET_FRAMES = 3;

function feedSpeech(processor: MockScriptProcessor, frames = ONSET_FRAMES) {
  for (let i = 0; i < frames; i += 1) {
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(LOUD_BUFFER) },
    });
  }
}

function feedSilence(processor: MockScriptProcessor) {
  processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array([0, 0, 0, 0]) },
  });
}

beforeEach(() => {
  recognizers = [];
  audioProcessors = [];
  audioContexts = [];
  invoke.mockReset();
  isProviderApiKeyConfiguredLocal.mockReset();
  isProviderApiKeyConfiguredLocal.mockImplementation((_provider: string) => false);
  voiceInputProvider.set('webspeech');
  voiceInputModelByProvider.set({});
  aiBaseUrlByProvider.set({});
  dictationVocabulary.set('');
  editorSymbols.value = [];
  smartVadEnabled.set(false);
  permissionsQuery.mockReset();
  permissionsQuery.mockResolvedValue({ state: 'granted' });
  getUserMedia.mockReset();
  getUserMedia.mockResolvedValue({
    getTracks: () => [{ stop: vi.fn() }],
  });
  installBrowserStubs();
});

describe('createVoiceInputSession', () => {
  it('ignores aborted speech-recognition errors', async () => {
    const onError = vi.fn();
    const onEnd = vi.fn();
    const session = createVoiceInputSession({
      onResult: vi.fn(),
      onError,
      onEnd,
    });

    await session.start();
    expect(recognizers).toHaveLength(1);

    const recognizer = recognizers[0];
    recognizer.onstart?.();
    recognizer.onerror?.({ error: 'aborted' });
    recognizer.onend?.();

    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight start before recognition begins', async () => {
    let resolveMedia: ((stream: MockStream) => void) | null = null;
    getUserMedia.mockImplementation(
      () =>
        new Promise<MockStream>((resolve) => {
          resolveMedia = resolve;
        })
    );

    const onStart = vi.fn();
    const onError = vi.fn();
    const session = createVoiceInputSession({
      onResult: vi.fn(),
      onStart,
      onError,
    });

    const startPromise = session.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveMedia).not.toBeNull();
    session.stop();
    (resolveMedia as ((stream: MockStream) => void) | null)?.({
      getTracks: () => [{ stop: vi.fn() }],
    });
    await startPromise;

    expect(recognizers).toHaveLength(0);
    expect(onStart).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('auto-finishes Google transcription after speech followed by silence', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('open the terminal');

    const onStart = vi.fn();
    const onResult = vi.fn();
    const onProcessingStart = vi.fn();
    const onEnd = vi.fn();
    const onTurnComplete = vi.fn();

    const session = createVoiceInputSession({
      onStart,
      onResult,
      onProcessingStart,
      onEnd,
      onTurnComplete,
    });

    await session.start();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(audioProcessors).toHaveLength(1);

    // Advance past the 150ms mic-warmup window before feeding audio; buffers
    // that arrive during warmup are intentionally swallowed (they only adapt the
    // noise floor), so without this the VAD never detects speech.
    await vi.advanceTimersByTimeAsync(200);
    const processor = audioProcessors[0];
    feedSpeech(processor);
    feedSilence(processor);

    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(onProcessingStart).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('ai_transcribe_audio', expect.objectContaining({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: '',
      mimeType: 'audio/wav',
    }));
    expect(onResult).toHaveBeenCalledWith('open the terminal');
    // A cold (non-conversation) turn both ends the graph and completes a turn.
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  /**
   * Turn-taking feel. The VAD used to end a turn after 500 ms of quiet, which is
   * shorter than the beat people leave mid-sentence while composing a thought —
   * so half a sentence went to the orchestrator and the rest became the next
   * turn. These pin the timings that fixed it.
   */
  it('holds through a mid-sentence pause instead of cutting the speaker off', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('spawn an agent that reviews the diff');

    const onEnd = vi.fn();
    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd });

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    const processor = audioProcessors[0];

    // A full sentence, so the turn is past the short-utterance grace window.
    feedSpeech(processor, 30);
    await vi.advanceTimersByTimeAsync(1600);

    // ...then a 600 ms thinking pause — longer than the old 500 ms cutoff.
    feedSilence(processor);
    await vi.advanceTimersByTimeAsync(600);
    expect(onEnd).not.toHaveBeenCalled();

    // Speaking again clears the silence timer and the turn continues.
    feedSpeech(processor, 5);
    await vi.advanceTimersByTimeAsync(200);
    expect(onEnd).not.toHaveBeenCalled();

    // A real end-of-turn pause does finalize it.
    feedSilence(processor);
    await vi.advanceTimersByTimeAsync(1200);
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('gives a barely-started utterance a longer grace than a full one', async () => {
    // A one-word opener ("so…", "okay…") is rarely the whole turn, so the
    // endpoint waits longer before finalizing than it would mid-paragraph.
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('okay');

    const onEnd = vi.fn();
    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd });

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    const processor = audioProcessors[0];

    feedSpeech(processor);
    feedSilence(processor);

    // Past the normal 800 ms endpoint, but inside the short-utterance grace.
    await vi.advanceTimersByTimeAsync(900);
    expect(onEnd).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('does not chop a long dictated brief mid-word at the soft cap', async () => {
    // The old hard 15 s ceiling cut detailed multi-agent instructions off
    // mid-sentence. Past the soft cap the turn now ends on the next real pause.
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('a very long brief');

    const onEnd = vi.fn();
    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd });

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    const processor = audioProcessors[0];

    // Speak continuously well past the old 15 s cap.
    for (let i = 0; i < 60; i += 1) {
      feedSpeech(processor, 5);
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(onEnd).not.toHaveBeenCalled();

    // Stopping ends it normally.
    feedSilence(processor);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('routes model transcription through OpenRouter when selected', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('openrouter');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'openrouter');
    invoke.mockResolvedValue('ship the fix');

    const onResult = vi.fn();
    const session = createVoiceInputSession({
      onResult,
      onProcessingStart: vi.fn(),
      onEnd: vi.fn(),
    });

    await session.start();
    expect(audioProcessors).toHaveLength(1);

    // Advance past the 150ms mic-warmup window before feeding audio; buffers
    // that arrive during warmup are intentionally swallowed (they only adapt the
    // noise floor), so without this the VAD never detects speech.
    await vi.advanceTimersByTimeAsync(200);
    const processor = audioProcessors[0];
    feedSpeech(processor);
    feedSilence(processor);

    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith('ai_transcribe_audio', expect.objectContaining({
      provider: 'openrouter',
      model: 'openai/whisper-1',
      apiKey: '',
      mimeType: 'audio/wav',
    }));
    expect(onResult).toHaveBeenCalledWith('ship the fix');

    vi.useRealTimers();
  });

  it('falls back from the old OpenRouter free audio model to the STT default', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('openrouter');
    voiceInputModelByProvider.set({
      openrouter: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    });
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'openrouter');
    invoke.mockResolvedValue('fallback transcript');

    const session = createVoiceInputSession({
      onResult: vi.fn(),
      onProcessingStart: vi.fn(),
      onEnd: vi.fn(),
    });

    await session.start();
    // Advance past the 150ms mic-warmup window before feeding audio; buffers
    // that arrive during warmup are intentionally swallowed (they only adapt the
    // noise floor), so without this the VAD never detects speech.
    await vi.advanceTimersByTimeAsync(200);
    const processor = audioProcessors[0];
    feedSpeech(processor);
    feedSilence(processor);

    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith('ai_transcribe_audio', expect.objectContaining({
      provider: 'openrouter',
      model: 'openai/whisper-1',
    }));

    vi.useRealTimers();
  });

  it('routes model transcription through a local provider URL when selected', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('lmstudio');
    aiBaseUrlByProvider.set({ lmstudio: 'http://localhost:1234/v1' });
    invoke.mockResolvedValue('local transcript');

    const onResult = vi.fn();
    const session = createVoiceInputSession({
      onResult,
      onProcessingStart: vi.fn(),
      onEnd: vi.fn(),
    });

    await session.start();
    expect(audioProcessors).toHaveLength(1);

    // Advance past the 150ms mic-warmup window before feeding audio; buffers
    // that arrive during warmup are intentionally swallowed (they only adapt the
    // noise floor), so without this the VAD never detects speech.
    await vi.advanceTimersByTimeAsync(200);
    const processor = audioProcessors[0];
    feedSpeech(processor);
    feedSilence(processor);

    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(isProviderApiKeyConfiguredLocal).not.toHaveBeenCalledWith('lmstudio');
    expect(invoke).toHaveBeenCalledWith('ai_transcribe_audio', expect.objectContaining({
      provider: 'lmstudio',
      model: 'local-stt-model',
      apiKey: '',
      baseUrl: 'http://localhost:1234/v1',
      mimeType: 'audio/wav',
    }));
    expect(onResult).toHaveBeenCalledWith('local transcript');

    vi.useRealTimers();
  });

  it('keeps the mic warm across turns in conversation mode and releases it on stop', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('a turn');

    // A single stable track spy so we can assert the mic is (not) released.
    const trackStop = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });

    const onEnd = vi.fn();
    const onTurnComplete = vi.fn();
    const session = createVoiceInputSession({
      onResult: vi.fn(),
      onProcessingStart: vi.fn(),
      onEnd,
      onTurnComplete,
    });
    session.setConversationMode(true);

    const speakOneTurn = async () => {
      await vi.advanceTimersByTimeAsync(200); // past the 150ms warmup
      const processor = audioProcessors[0];
      feedSpeech(processor);
      feedSilence(processor);
      await vi.advanceTimersByTimeAsync(2600); // trigger the silence timer
      await Promise.resolve();
    };

    // --- Turn 1: cold start acquires the mic + AudioContext ---
    await session.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audioContexts).toHaveLength(1);
    const ctx = audioContexts[0];

    await speakOneTurn();
    // A warm-parked turn completes, but does NOT end the graph — onEnd must
    // stay quiet (that equivalence is what made every thinking pause look like
    // "the mic died" to the dictation service). onTurnComplete is the signal.
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
    // Mic parked WARM: context not closed, tracks not stopped.
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.state).toBe('running');
    expect(trackStop).not.toHaveBeenCalled();

    // --- Turn 2: warm re-arm reuses the graph — no new getUserMedia / context ---
    await session.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audioContexts).toHaveLength(1);
    expect(audioProcessors).toHaveLength(1);

    await speakOneTurn();
    expect(onTurnComplete).toHaveBeenCalledTimes(2);
    expect(onEnd).not.toHaveBeenCalled();

    // --- stop() finally releases the mic — and that alone fires onEnd ---
    session.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.close).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  /**
   * An empty drain (nothing was ever spoken) fires BOTH signals exactly once:
   * onTurnComplete because a turn completed, onEnd because the user-driven
   * stop that triggered the drain also ended the capture graph.
   */
  it('fires each end-of-session signal once for an empty drain', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');

    const onEnd = vi.fn();
    const onTurnComplete = vi.fn();
    const onResult = vi.fn();
    const session = createVoiceInputSession({ onResult, onEnd, onTurnComplete });
    session.setConversationMode(true);

    // Silence only — nothing to transcribe, then the user ends the dictation.
    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSilence(audioProcessors[0]);
    session.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(onResult).toHaveBeenCalledWith('');
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  /**
   * The reported "it writes what I say twice" bug. We Speech engines re-send
   * the ENTIRE result list on every event; banking those cumulative payloads
   * duplicated every earlier word. Utterances mode (the dictation path) emits
   * only what finalized since the previous event.
   */
  it('emits only newly finalized segments in utterances mode', async () => {
    const onResult = vi.fn();
    const session = createVoiceInputSession({ onResult }, { mode: 'utterances' });

    await session.start();
    const recognizer = recognizers[0];
    recognizer.onstart?.();

    // Array-like result list, as the engine presents it.
    const results = (...items: any[]) => ({ length: items.length, ...Object.fromEntries(items.map((r, i) => [i, r])) });
    const res = (isFinal: boolean, transcript: string) => ({
      isFinal,
      length: 1,
      0: { transcript, confidence: 0.9 },
    });

    // Interim only — nothing finalized yet, nothing emitted.
    recognizer.onresult?.({ results: results(res(false, 'hello')) });
    expect(onResult).not.toHaveBeenCalled();

    // "hello" finalized, "world" still interim → emit just "hello".
    recognizer.onresult?.({ results: results(res(true, 'hello'), res(false, 'world')) });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenLastCalledWith('hello');

    // Same event shape re-sent with "world" final → emit just "world", NOT
    // "hello world" again.
    recognizer.onresult?.({ results: results(res(true, 'hello'), res(true, 'world'), res(false, 'today')) });
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenLastCalledWith('world');

    recognizer.onresult?.({ results: results(res(true, 'hello'), res(true, 'world'), res(true, 'today')) });
    expect(onResult.mock.calls.map(([t]) => t)).toEqual(['hello', 'world', 'today']);
  });

  /** The conversational default keeps its full-draft-per-event shape. */
  it('keeps emitting cumulative transcripts by default', async () => {
    const onResult = vi.fn();
    const session = createVoiceInputSession({ onResult });

    await session.start();
    const recognizer = recognizers[0];
    recognizer.onstart?.();

    const results = (...items: any[]) => ({ length: items.length, ...Object.fromEntries(items.map((r, i) => [i, r])) });
    const res = (isFinal: boolean, transcript: string) => ({
      isFinal,
      length: 1,
      0: { transcript, confidence: 0.9 },
    });

    recognizer.onresult?.({ results: results(res(false, 'hello')) });
    recognizer.onresult?.({ results: results(res(true, 'hello'), res(false, 'world')) });

    expect(onResult.mock.calls.map(([t]) => t)).toEqual(['hello', 'hello world']);
  });

  /**
   * WhisperFlow-style cleanup: hesitations are stripped word-bounded (never
   * touching real words that merely contain them), and opting out restores
   * verbatim text.
   */
  describe('refineVoiceTranscript fillers', () => {
    it('strips standalone hesitation words by default', () => {
      expect(refineVoiceTranscript('um okay so uh let us start')).toBe('okay so let us start');
      expect(refineVoiceTranscript('Um, hello there')).toBe('hello there');
      expect(refineVoiceTranscript('wait uh , okay')).toBe('wait, okay');
    });

    it('never touches words that merely contain a filler', () => {
      expect(refineVoiceTranscript('turn up the volume in the urban area')).toBe(
        'turn up the volume in the urban area',
      );
    });

    it('collapses to empty when nothing but fillers was said', () => {
      expect(refineVoiceTranscript('um uh ah')).toBe('');
    });

    it('can be opted out for verbatim output', () => {
      expect(refineVoiceTranscript('um okay', { removeFillers: false })).toBe('um okay');
    });
  });

  /**
   * Hotword biasing at the source: the custom vocabulary must reach the
   * transcription request itself, so terms are spelled right before any
   * polish pass — including the mechanical-only terminal path.
   */
  it('sends the vocabulary list as the cloud transcription bias', async () => {
    vi.useFakeTimers();
    dictationVocabulary.set('Spacron, Parakeet');
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('a turn');

    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd: vi.fn() });
    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0]);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith(
      'ai_transcribe_audio',
      expect.objectContaining({ vocabulary: 'Spacron, Parakeet' }),
    );

    vi.useRealTimers();
  });

  it('sends the vocabulary list as the local whisper initial prompt', async () => {
    vi.useFakeTimers();
    dictationVocabulary.set('onnxruntime');
    voiceInputProvider.set('local');
    invoke.mockResolvedValue('a turn');

    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd: vi.fn() });
    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0]);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith(
      'local_stt_transcribe',
      expect.objectContaining({ initialPrompt: 'onnxruntime' }),
    );

    vi.useRealTimers();
  });

  it('omits the bias when the vocabulary list is empty', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('a turn');

    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd: vi.fn() });
    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0]);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    const call = invoke.mock.calls.find(([cmd]) => cmd === 'ai_transcribe_audio')!;
    expect((call[1] as Record<string, unknown>).vocabulary).toBeUndefined();

    vi.useRealTimers();
  });

  /** The active editor's identifiers ride along after the user's own terms. */
  it('merges editor symbols into the bias after the custom list', async () => {
    vi.useFakeTimers();
    dictationVocabulary.set('Spacron');
    editorSymbols.value = ['collectEditorSymbols', 'fileCache'];
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('a turn');

    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd: vi.fn() });
    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0]);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith(
      'ai_transcribe_audio',
      expect.objectContaining({
        vocabulary: 'Spacron, collectEditorSymbols, fileCache',
      }),
    );

    vi.useRealTimers();
  });

  /**
   * Smart VAD (Silero): when enabled and the native detector answers, its
   * speech probability — not loudness — decides a turn. A QUIET buffer that
   * the RMS gate would never trigger on must still start speech.
   */
  it('lets the native VAD drive the turn decision when it is live', async () => {
    vi.useFakeTimers();
    smartVadEnabled.set(true);
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'vad_session_start') return 42;
      if (cmd === 'vad_session_feed') {
        expect(args).toMatchObject({ sessionId: 42 });
        return 0.9; // Silero says: definitely speech
      }
      return undefined;
    });
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');

    const onSpeechStart = vi.fn();
    const session = createVoiceInputSession({ onResult: vi.fn(), onSpeechStart, onEnd: vi.fn() });

    await session.start();
    await vi.advanceTimersByTimeAsync(200); // past the mic-warmup swallow
    const processor = audioProcessors[0];

    // Four quiet frames fill the first IPC batch…
    for (let i = 0; i < 4; i += 1) feedSilence(processor);
    // …let Silero's verdict (0.9) land…
    await Promise.resolve();
    await Promise.resolve();
    // …and three quiet frames — inaudible to the RMS gate — open the turn,
    // because every one of them now counts as ACTIVE via the probability bar.
    // (The anti-chatter onset run is deliberately shared with the level gate.)
    feedSilence(processor);
    feedSilence(processor);
    feedSilence(processor);

    expect(onSpeechStart).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  /** Any backend failure reverts dictation to the level gate silently. */
  it('falls back to the level gate when the VAD backend fails', async () => {
    vi.useFakeTimers();
    smartVadEnabled.set(true);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'vad_session_start') throw new Error('model missing');
      return undefined;
    });
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'vad_session_start') throw new Error('model missing');
      if (cmd === 'ai_transcribe_audio') return 'still works';
      return undefined;
    });

    const onResult = vi.fn();
    const session = createVoiceInputSession({ onResult, onProcessingStart: vi.fn(), onEnd: vi.fn() });

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0]);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    // The ordinary loudness flow ran untouched: transcription happened.
    expect(onResult).toHaveBeenCalledWith('still works');

    vi.useRealTimers();
  });

  /**
   * Pre-roll. Between turns the capture graph stays warm but stops feeding the
   * VAD, so anything said in the gap before the mic re-arms used to be dropped
   * outright — the reason replies that started the instant the assistant
   * finished lost their first word.
   */
  it('keeps audio spoken between turns and prepends it to the next one', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('a turn');

    const session = createVoiceInputSession({ onResult: vi.fn(), onEnd: vi.fn() });
    session.setConversationMode(true);

    const lastWavByteLength = () => {
      const call = invoke.mock.calls.filter(([cmd]) => cmd === 'ai_transcribe_audio').at(-1);
      return (call![1] as { audioBytes: number[] }).audioBytes.length;
    };

    // --- Turn 1: no pre-roll exists yet; 3 speech buffers is the baseline. ---
    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0], 3);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();
    const baseline = lastWavByteLength();

    // --- Between turns: the graph is parked, but the user starts talking. ---
    feedSpeech(audioProcessors[0], 4);

    // --- Turn 2: the same 3 in-turn buffers, now seeded with that pre-roll. ---
    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0], 3);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    // 4 extra buffers × 4 samples × 2 bytes = 32 bytes of recovered speech.
    expect(lastWavByteLength()).toBe(baseline + 32);

    vi.useRealTimers();
  });

  /**
   * Dictation, unlike the conversational loop, has nobody waiting for it: the
   * speaker pauses for 800 ms, the utterance goes off to STT, and they carry
   * straight on talking. Under the default short pre-roll everything past
   * ~1.4 s of that gap was dropped on the floor — no error, no warning, the
   * words simply never appeared in the transcript.
   */
  it('keeps everything spoken during a long transcription gap', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('a turn');

    const session = createVoiceInputSession(
      { onResult: vi.fn(), onEnd: vi.fn() },
      { gapCapture: 'continuous' },
    );
    session.setConversationMode(true);

    const lastWavByteLength = () => {
      const call = invoke.mock.calls.filter(([cmd]) => cmd === 'ai_transcribe_audio').at(-1);
      return (call![1] as { audioBytes: number[] }).audioBytes.length;
    };

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0], 3);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();
    const baseline = lastWavByteLength();

    // The user keeps talking through the whole STT round-trip: far more than
    // the 16-buffer pre-roll would have held.
    feedSpeech(audioProcessors[0], 40);

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0], 3);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    // All 40 buffers survive — 40 x 4 samples x 2 bytes.
    expect(lastWavByteLength()).toBe(baseline + 320);

    vi.useRealTimers();
  });

  /**
   * The onset detector only looks forward from the re-arm. A stretch of speech
   * that lived ENTIRELY inside the gap therefore reached `capturedChunks` and
   * was then thrown away by the "no speech in this turn" bail — the audio was
   * recovered and discarded in the same breath.
   */
  it('transcribes a turn whose speech happened entirely in the gap', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('the words from the gap');

    const onResult = vi.fn();
    const session = createVoiceInputSession({ onResult, onEnd: vi.fn() }, { gapCapture: 'continuous' });
    session.setConversationMode(true);

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSpeech(audioProcessors[0], 3);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();
    onResult.mockClear();
    invoke.mockClear();

    // Everything is said in the gap; the mic re-arms to silence.
    feedSpeech(audioProcessors[0], 6);

    await session.start();
    await vi.advanceTimersByTimeAsync(200);
    feedSilence(audioProcessors[0]);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();

    expect(invoke.mock.calls.some(([cmd]) => cmd === 'ai_transcribe_audio')).toBe(true);
    expect(onResult).toHaveBeenCalledWith('the words from the gap');

    vi.useRealTimers();
  });

  it('ignores a lone transient (click/cough) instead of treating it as speech', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');
    invoke.mockResolvedValue('real speech after the click');

    const onSpeechStart = vi.fn();
    const onResult = vi.fn();
    const session = createVoiceInputSession({ onResult, onSpeechStart, onProcessingStart: vi.fn() });

    await session.start();
    await vi.advanceTimersByTimeAsync(200); // past the 150ms warmup

    const processor = audioProcessors[0];
    // A keyboard click / door slam: loud, but only ONSET_FRAMES - 1 buffers —
    // never confirmed as speech, so no turn starts and nothing is transcribed.
    feedSpeech(processor, ONSET_FRAMES - 1);
    feedSilence(processor);
    expect(onSpeechStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith('ai_transcribe_audio', expect.anything());
    expect(onResult).not.toHaveBeenCalled();

    // The transient must not have "used up" the gate: real sustained speech
    // right after is still detected.
    feedSpeech(processor);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    feedSilence(processor);
    await vi.advanceTimersByTimeAsync(2600);
    await Promise.resolve();
    expect(onResult).toHaveBeenCalledWith('real speech after the click');

    vi.useRealTimers();
  });

  it('does not start a turn on quiet room noise below the absolute onset floor', async () => {
    vi.useFakeTimers();
    voiceInputProvider.set('google');
    isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'google');

    const onSpeechStart = vi.fn();
    const session = createVoiceInputSession({ onResult: vi.fn(), onSpeechStart, onProcessingStart: vi.fn() });

    await session.start();
    await vi.advanceTimersByTimeAsync(200); // past the 150ms warmup

    const processor = audioProcessors[0];
    // Sustained breathing / fan noise at RMS 0.006: above the old relative gate
    // (noise floor × mult) in a quiet room, but below VAD_ONSET_MIN_RMS (0.01).
    for (let i = 0; i < ONSET_FRAMES + 3; i += 1) {
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4).fill(0.006) } });
    }
    expect(onSpeechStart).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('downsamplePcmChunks', () => {
  it('concatenates chunks untouched when already at or below the target rate', () => {
    const out = downsamplePcmChunks([new Float32Array([0.1, 0.2]), new Float32Array([0.3])], 16_000, 16_000);
    expect(Array.from(out)).toEqual([expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)]);
  });

  it('reduces 48 kHz capture to a third of the samples', () => {
    const input = new Float32Array(48_000).fill(0.5); // 1 second at 48 kHz
    const out = downsamplePcmChunks([input], 48_000, 16_000);
    expect(out.length).toBe(16_000);
    // A constant signal must survive the box filter unchanged.
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[out.length - 1]).toBeCloseTo(0.5);
  });

  it('handles non-integer ratios like 44.1 kHz', () => {
    const input = new Float32Array(44_100).fill(0.25);
    const out = downsamplePcmChunks([input], 44_100, 16_000);
    expect(out.length).toBe(16_000);
    expect(out[12_345]).toBeCloseTo(0.25);
  });

  it('returns an empty buffer for empty input', () => {
    expect(downsamplePcmChunks([], 48_000, 16_000).length).toBe(0);
  });
});
