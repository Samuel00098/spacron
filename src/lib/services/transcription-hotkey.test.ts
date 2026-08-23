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
      stop: h.sessionStop,
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

describe('transcription-hotkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = null;
    h.supported.value = true;
    h.activeSessionId.set(7);
    h.devActiveSessionId.set(null);
    h.transcriptionAutoSend.set(true);
    h.sendAgentPromptDirect.mockResolvedValue(true);
  });

  it('delivers the first finalized utterance via auto-send', async () => {
    toggleTerminalTranscription();
    expect(capturedCallbacks).not.toBeNull();
    expect(currentState()).toBe('listening');

    capturedCallbacks!.onResult('run  the\ntests   now');
    await flush();

    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'run the tests now');
    expect(h.requestTerminalInput).not.toHaveBeenCalled();
    expect(currentState()).toBe('idle');
  });

  it('types into the terminal without submitting when auto-send is off', async () => {
    h.transcriptionAutoSend.set(false);

    toggleTerminalTranscription();
    capturedCallbacks!.onResult('git status');
    await flush();

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
      'No active terminal — open a terminal tab first.',
      'error',
    );
    expect(currentState()).toBe('idle');
    expect(h.sessionStop).not.toHaveBeenCalled();
  });

  it('surfaces provider errors and resets to idle', () => {
    toggleTerminalTranscription();
    capturedCallbacks!.onError?.('microphone blocked');

    expect(h.showToast).toHaveBeenCalledWith('microphone blocked', 'error');
    expect(currentState()).toBe('idle');
  });
});
