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
    showToast: vi.fn(),
    sessionStop: vi.fn(),
    sessionStart: vi.fn(async () => {}),
    supported: { value: true },
  };
});

type CapturedCallbacks = {
  onStart?: () => void;
  onResult: (transcript: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
};

let capturedCallbacks: CapturedCallbacks | null = null;

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
}));

vi.mock('$lib/stores/notification', () => ({
  showToast: h.showToast,
}));

vi.mock('$lib/services/voice-input', () => ({
  createVoiceInputSession: vi.fn((callbacks: CapturedCallbacks) => {
    capturedCallbacks = callbacks;
    return {
      start: vi.fn(async () => {
        callbacks.onStart?.();
      }),
      stop: vi.fn(() => {
        h.sessionStop();
        // Mirrors the real session: releasing the mic always ends with onEnd.
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
    h.supported.value = true;
    h.activeSessionId.set(7);
    h.devActiveSessionId.set(null);
    h.sessions.set([]);
    h.devSessions.set([]);
    h.transcriptionAutoSend.set(true);
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
});
