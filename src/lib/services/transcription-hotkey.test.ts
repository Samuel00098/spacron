import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * All mock handles live in vi.hoisted because vi.mock factories are hoisted
 * above module-level declarations — referencing them from a factory body
 * directly would be a TDZ violation.
 */
const h = vi.hoisted(() => {
  /**
   * Minimal store-compatible writable for mocking the settings/terminal
   * stores the service reads — same contract as storeCompat's writable.
   */
  function makeWritable<T>(initial: T) {
    let value = initial;
    const subscribers = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        fn(value);
        subscribers.add(fn);
        return () => {
          subscribers.delete(fn);
        };
      },
      set(next: T) {
        value = next;
        subscribers.forEach((fn) => fn(next));
      },
    };
  }
  return {
    makeWritable,
    activeSessionId: makeWritable<number | null>(7),
    devActiveSessionId: makeWritable<number | null>(null),
    sessions: makeWritable<{ id: number; lastActivatedAt?: number }[]>([]),
    devSessions: makeWritable<{ id: number; lastActivatedAt?: number }[]>([]),
    sendAgentPromptDirect: vi.fn<(text?: unknown, sessionId?: number) => Promise<boolean>>(),
    requestTerminalInput: vi.fn(),
    transcriptionAutoSend: makeWritable<boolean>(true),
    voiceRefinementEnabled: makeWritable<boolean>(false),
    voiceInputProvider: makeWritable<string>('local'),
    showToast: vi.fn(),
    sessionStop: vi.fn(),
    /** Overridable per-test; the default mimics a healthy warm start. */
    sessionStart: vi.fn(async () => {}),
    /** Mirrors the real session's "start() while live is a no-op" guard. */
    micActive: { value: false },
    /** Counts EFFECTIVE starts (ones that signalled onStart), not no-ops. */
    onStartCount: { value: 0 },
    refineVoicePrompt: vi.fn(async (text: string) => ({ text: text.toUpperCase(), aiRefined: true })),
    supported: { value: true },
  };
});

type CapturedCallbacks = {
  onStart?: () => void;
  onResult: (transcript: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
};

type CapturedOptions = { mode?: string } | undefined;

let capturedCallbacks: CapturedCallbacks | null = null;
let capturedOptions: CapturedOptions = undefined;

vi.mock('$lib/stores/terminal', () => ({
  activeSessionId: h.activeSessionId,
  devActiveSessionId: h.devActiveSessionId,
  sessions: h.sessions,
  devSessions: h.devSessions,
  sendAgentPromptDirect: h.sendAgentPromptDirect,
  requestTerminalInput: h.requestTerminalInput,
}));

vi.mock('$lib/stores/settings', () => ({
  transcriptionAutoSend: h.transcriptionAutoSend,
  voiceRefinementEnabled: h.voiceRefinementEnabled,
  // Read by `deliver` only to stamp the voice-history entry.
  voiceInputProvider: h.voiceInputProvider,
}));

vi.mock('$lib/stores/notification', () => ({
  showToast: h.showToast,
}));

vi.mock('$lib/services/voice-refinement', () => ({
  refineVoicePrompt: h.refineVoicePrompt,
}));

vi.mock('$lib/services/voice-input', () => ({
  createVoiceInputSession: vi.fn((callbacks: CapturedCallbacks, options: CapturedOptions) => {
    capturedCallbacks = callbacks;
    capturedOptions = options;
    return {
      start: vi.fn(() => h.sessionStart()),
      stop: vi.fn(() => {
        h.micActive.value = false;
        h.sessionStop();
        // Mirrors the real session: a user-driven stop releases the mic and
        // ends with onEnd — the drain that commits an ended dictation.
        callbacks.onEnd?.();
      }),
      isSupported: () => h.supported.value,
      setConversationMode: vi.fn(),
      setPlaybackActive: vi.fn(),
    };
  }),
  // Mirror of the mechanical cleanup the real function performs for the
  // options the service passes — good enough to pin the service's own logic.
  refineVoiceTranscript: (input: string) =>
    input.replace(/\r\n?/g, '\n').replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim(),
}));

import {
  abortTranscription,
  toggleTerminalTranscription,
  transcriptionState,
} from './transcription-hotkey';

function currentState(): string {
  let value = 'idle';
  transcriptionState.subscribe((v) => {
    value = v;
  })();
  return value;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * End the dictation. Utterances accumulate until the user says stop (hotkey
 * again or Escape), so every delivery assertion has to do this first.
 */
async function finish() {
  toggleTerminalTranscription();
  await flush();
}

describe('transcription-hotkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = null;
    capturedOptions = undefined;
    h.supported.value = true;
    h.activeSessionId.set(7);
    h.devActiveSessionId.set(null);
    h.sessions.set([]);
    h.devSessions.set([]);
    h.transcriptionAutoSend.set(true);
    h.voiceRefinementEnabled.set(false);
    // Default start: resolve and signal onStart, like a healthy capture graph.
    h.sessionStart.mockImplementation(async () => {
      if (h.micActive.value) return; // real sessions no-op a start while live
      h.micActive.value = true;
      h.onStartCount.value += 1;
      capturedCallbacks?.onStart?.();
    });
    h.micActive.value = false;
    h.onStartCount.value = 0;
    h.sendAgentPromptDirect.mockResolvedValue(true);
  });

  it('delivers the dictation via auto-send once the user ends it', async () => {
    toggleTerminalTranscription();
    expect(capturedCallbacks).not.toBeNull();
    expect(currentState()).toBe('listening');

    capturedCallbacks!.onResult('run  the\ntests   now');
    await flush();

    // Still listening — one pause must not end the dictation.
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(currentState()).toBe('listening');

    await finish();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'run the tests now');
    expect(h.requestTerminalInput).not.toHaveBeenCalled();
    expect(currentState()).toBe('idle');
  });

  /**
   * The WhisperFlow behaviour: the VAD ends an utterance after ~800 ms of
   * silence, which is shorter than an ordinary thinking pause. Those pieces
   * have to be joined, not raced against each other.
   */
  it('joins utterances spoken across pauses into one transcript', async () => {
    toggleTerminalTranscription();

    capturedCallbacks!.onResult('git commit');
    await flush();
    capturedCallbacks!.onResult('dash m');
    await flush();
    capturedCallbacks!.onResult('fix the parser');
    await flush();

    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    await finish();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'git commit dash m fix the parser');
  });

  it('types into the terminal without submitting when auto-send is off', async () => {
    h.transcriptionAutoSend.set(false);

    toggleTerminalTranscription();
    capturedCallbacks!.onResult('git status');
    await flush();
    await finish();

    expect(h.requestTerminalInput).toHaveBeenCalledWith(7, 'git status');
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(currentState()).toBe('idle');
  });

  it('ignores results that arrive once delivery has started', async () => {
    let resolveSend!: (v: boolean) => void;
    h.sendAgentPromptDirect.mockReturnValue(
      new Promise<boolean>((resolve) => (resolveSend = resolve)),
    );

    toggleTerminalTranscription();
    capturedCallbacks!.onResult('first command');
    await flush();
    await finish();
    expect(currentState()).toBe('processing');

    capturedCallbacks!.onResult('second command');

    resolveSend(true);
    await flush();
    expect(h.sendAgentPromptDirect).toHaveBeenCalledTimes(1);
    expect(currentState()).toBe('idle');
  });

  it('aborts cleanly without delivering anything', () => {
    toggleTerminalTranscription();
    expect(currentState()).toBe('listening');

    abortTranscription();

    expect(h.sessionStop).toHaveBeenCalled();
    expect(currentState()).toBe('idle');
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(h.requestTerminalInput).not.toHaveBeenCalled();
  });

  it('reports and stays idle when there is no terminal to target', () => {
    h.activeSessionId.set(null);

    toggleTerminalTranscription();

    expect(h.showToast).toHaveBeenCalledWith(
      'Click into a terminal or text field first, then speak.',
      'error',
    );
    expect(currentState()).toBe('idle');
    expect(h.sessionStop).not.toHaveBeenCalled();
  });

  /**
   * Both terminal worlds hold an active session. The agent room used to win
   * unconditionally (`activeSessionId ?? devActiveSessionId`), so dictating
   * into the dev terminal went to an off-screen session and looked like
   * "transcription does nothing".
   */
  it('delivers to whichever terminal world was activated most recently', async () => {
    h.activeSessionId.set(7);
    h.devActiveSessionId.set(99);
    h.sessions.set([{ id: 7, lastActivatedAt: 1_000 }]);
    h.devSessions.set([{ id: 99, lastActivatedAt: 2_000 }]);

    toggleTerminalTranscription();
    await flush();
    capturedCallbacks?.onResult('npm test');
    await flush();
    await finish();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(99, 'npm test');
  });

  it('keeps the agent terminal when it is the more recent one', async () => {
    h.activeSessionId.set(7);
    h.devActiveSessionId.set(99);
    h.sessions.set([{ id: 7, lastActivatedAt: 3_000 }]);
    h.devSessions.set([{ id: 99, lastActivatedAt: 2_000 }]);

    toggleTerminalTranscription();
    await flush();
    capturedCallbacks?.onResult('npm test');
    await flush();
    await finish();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'npm test');
  });

  it('surfaces provider errors and resets to idle', () => {
    toggleTerminalTranscription();
    capturedCallbacks!.onError?.('microphone blocked');

    expect(h.showToast).toHaveBeenCalledWith('microphone blocked', 'error');
    expect(currentState()).toBe('idle');
  });

  /**
   * The dictation consumer must never receive cumulative engine payloads —
   * "hello", then "hello world", banked twice, delivered as
   * "hello hello world". The session is created in utterances mode.
   */
  it('creates its voice session in utterances mode to prevent duplication', () => {
    toggleTerminalTranscription();
    expect(capturedOptions).toEqual({ mode: 'utterances' });
    // Don't leak a live dictation into the next test.
    abortTranscription();
  });

  /**
   * An unexpected graph stop mid-dictation (webspeech auto-end after a long
   * silence) used to be treated as "the mic died, ship what we have" — which
   * chopped the dictation at that silence. It must re-arm and keep banking.
   */
  it('re-arms after an unexpected graph stop instead of delivering', async () => {
    toggleTerminalTranscription();
    await flush();

    capturedCallbacks!.onResult('first piece');
    await flush();
    // The engine released its recognizer, then reported the stop.
    h.micActive.value = false;
    capturedCallbacks!.onEnd?.(); // engine stopped itself; user said nothing
    await flush();

    // Re-armed (a second effective start), still listening, nothing delivered.
    expect(h.onStartCount.value).toBe(2);
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    expect(currentState()).toBe('listening');

    capturedCallbacks!.onResult('second piece');
    await flush();
    await finish();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledTimes(1);
    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'first piece second piece');
  });

  /**
   * If the graph cannot be revived, the dictation must not loop forever — but
   * what was actually said still has to land.
   */
  it('delivers what was said once re-arming keeps failing', async () => {
    let firstStart = true;
    h.sessionStart.mockImplementation(async () => {
      if (firstStart) {
        firstStart = false;
        h.micActive.value = true;
        capturedCallbacks?.onStart?.();
        return;
      }
      throw new Error('mic gone');
    });

    toggleTerminalTranscription();
    await flush();
    capturedCallbacks!.onResult('half done');
    await flush();

    capturedCallbacks!.onEnd?.();
    // Three failing re-arm attempts, then the fallback delivery.
    await flush();
    await flush();
    await flush();
    await flush();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledTimes(1);
    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'half done');
    expect(currentState()).toBe('idle');
  });

  /**
   * The exit-lag fix: ending the dictation flips the indicator to processing
   * IMMEDIATELY — draining local STT takes seconds, and the pill sitting on
   * "Listening" through that drain is why Escape felt like it needed two or
   * three presses.
   */
  it('shows processing the instant the dictation is ended', async () => {
    let resolveSend!: (v: boolean) => void;
    h.sendAgentPromptDirect.mockReturnValue(
      new Promise<boolean>((resolve) => (resolveSend = resolve)),
    );

    toggleTerminalTranscription();
    await flush();
    capturedCallbacks!.onResult('still cooking');
    await flush();

    toggleTerminalTranscription();
    // Synchronously processing — no flush, no waiting for STT.
    expect(currentState()).toBe('processing');

    resolveSend(true);
    await flush();
    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'still cooking');
    expect(currentState()).toBe('idle');
  });

  /** Teardown re-entry fires onEnd more than once; delivery must not repeat. */
  it('delivers exactly once no matter how many times onEnd fires', async () => {
    toggleTerminalTranscription();
    await flush();
    capturedCallbacks!.onResult('once only');
    await flush();

    await finish();
    capturedCallbacks!.onEnd?.();
    await flush();
    capturedCallbacks!.onEnd?.();
    await flush();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledTimes(1);
    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'once only');
  });

  /**
   * While the mic is still opening there is no dictation to end — Escape used
   * to be swallowed there, which read as a dead key. It cancels instead.
   */
  it('cancels cleanly when Escape lands during mic startup', async () => {
    let resolveStart!: () => void;
    h.sessionStart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    toggleTerminalTranscription(); // starting=true, start() pending
    abortTranscription();

    expect(h.sessionStop).toHaveBeenCalled();
    expect(currentState()).toBe('idle');

    resolveStart(); // the pending startup settles later — must stay cancelled
    await flush();
    expect(currentState()).toBe('idle');
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
  });

  /** Terminals get mechanical cleanup only — never the AI polish pass. */
  it('never runs AI polish for terminal delivery even when enabled', async () => {
    h.voiceRefinementEnabled.set(true);

    toggleTerminalTranscription();
    await flush();
    capturedCallbacks!.onResult('git commit dash m now');
    await flush();
    await finish();

    expect(h.refineVoicePrompt).not.toHaveBeenCalled();
    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'git commit dash m now');
  });
});
