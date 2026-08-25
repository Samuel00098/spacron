import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Targeting tests for the transcription hotkey — "does the text land where the
 * caret actually is?".
 *
 * The suite in `transcription-hotkey.test.ts` runs in vitest's `node`
 * environment, where `typeof document === 'undefined'` short-circuits every
 * text-field path, so it can only ever exercise terminal delivery. The project
 * has no jsdom/happy-dom dependency and this is not worth adding one for, so
 * the handful of DOM surfaces the service actually touches are stubbed on
 * `globalThis` below — installed BEFORE the service is imported, because
 * `installFocusTracker` binds `document` on first use.
 */

// --- Minimal DOM stub -------------------------------------------------------

class StubElement {
  isConnected = true;
  isContentEditable = false;
  className = '';
  /** Real ancestor, when a test needs `closest`/`contains` to walk a tree. */
  parent: StubElement | null = null;
  /** Shorthand for "somewhere above me has this class" when the tree itself
   *  doesn't matter — enough for `closest`, but not for identity comparisons. */
  parentClasses: string[] = [];
  dispatched: string[] = [];
  closest(selector: string): StubElement | null {
    const want = selector.replace(/^\./, '');
    let node: StubElement | null = this;
    while (node) {
      if (node.className.split(' ').includes(want)) return node;
      if (!node.parent && node.parentClasses.includes(want)) return node;
      node = node.parent;
    }
    return null;
  }
  contains(other: StubElement | null): boolean {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
  dispatchEvent(event: { type: string }): boolean {
    this.dispatched.push(event.type);
    return true;
  }
}

class StubInput extends StubElement {
  value = '';
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  setRangeText(text: string, start: number, end: number, _mode: string) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
}

class StubTextArea extends StubInput {}

type FocusListener = (event: { target: unknown }) => void;
type KeyListener = (event: KeyLike) => void;
type KeyLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};
const focusListeners: FocusListener[] = [];
const pointerListeners: FocusListener[] = [];
let keyListeners: KeyListener[] = [];

const stubDocument = {
  activeElement: null as StubElement | null,
  body: new StubElement(),
  addEventListener(type: string, handler: FocusListener | KeyListener) {
    if (type === 'focusin') focusListeners.push(handler as FocusListener);
    if (type === 'pointerdown') pointerListeners.push(handler as FocusListener);
    if (type === 'keydown') keyListeners.push(handler as KeyListener);
  },
  removeEventListener(type: string, handler: FocusListener | KeyListener) {
    if (type === 'keydown') keyListeners = keyListeners.filter((fn) => fn !== handler);
  },
  execCommand: vi.fn(() => true),
};

/** Press a key, driving the service's while-listening keydown handler. */
function press(key: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const event: KeyLike = { key, ...mods, preventDefault: () => {}, stopPropagation: () => {} };
  [...keyListeners].forEach((fn) => fn(event));
}

/** Move focus, driving the service's `focusin` tracker exactly as a browser would. */
function focus(el: StubElement | null) {
  stubDocument.activeElement = el;
  if (el) focusListeners.forEach((fn) => fn({ target: el }));
}

/** Press the pointer on `el` without moving focus — the half of a click the
 *  service reads to tell a deliberate retarget from a stolen focus. */
function pointerDown(el: StubElement) {
  pointerListeners.forEach((fn) => fn({ target: el }));
}

/** A real click: pointer down on the element, then focus lands on `lands ?? el`
 *  (terminals focus a hidden helper textarea beside the surface you hit). */
function click(el: StubElement, lands: StubElement = el) {
  pointerDown(el);
  focus(lands);
}

/** An `.xterm` root plus the hidden helper textarea focus actually lands on. */
function makeTerminal() {
  const root = new StubElement();
  root.className = 'xterm';
  const screen = new StubElement();
  screen.className = 'xterm-screen';
  screen.parent = root;
  const helper = new StubElement();
  helper.className = 'xterm-helper-textarea';
  helper.parent = root;
  return { root, screen, helper };
}

Object.assign(globalThis, {
  document: stubDocument,
  HTMLElement: StubElement,
  HTMLInputElement: StubInput,
  HTMLTextAreaElement: StubTextArea,
  Event: class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
  window: { getSelection: () => ({ rangeCount: 1 }) },
});

// --- Service mocks ----------------------------------------------------------

const h = vi.hoisted(() => {
  function makeWritable<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        fn(value);
        subs.add(fn);
        return () => subs.delete(fn);
      },
      set(next: T) {
        value = next;
        subs.forEach((fn) => fn(next));
      },
    };
  }
  return {
    makeWritable,
    activeSessionId: makeWritable<number | null>(7),
    devActiveSessionId: makeWritable<number | null>(null),
    sendAgentPromptDirect: vi.fn(async () => true),
    requestTerminalInput: vi.fn(),
    transcriptionAutoSend: makeWritable<boolean>(true),
    showToast: vi.fn(),
  };
});

type Callbacks = { onStart?: () => void; onResult: (t: string) => void; onEnd?: () => void };
let captured: Callbacks | null = null;

vi.mock('$lib/stores/terminal', () => ({
  activeSessionId: h.activeSessionId,
  devActiveSessionId: h.devActiveSessionId,
  sendAgentPromptDirect: h.sendAgentPromptDirect,
  requestTerminalInput: h.requestTerminalInput,
}));
vi.mock('$lib/stores/settings', () => ({ transcriptionAutoSend: h.transcriptionAutoSend }));
vi.mock('$lib/stores/notification', () => ({ showToast: h.showToast }));
vi.mock('$lib/services/voice-input', () => ({
  createVoiceInputSession: (callbacks: Callbacks) => {
    captured = callbacks;
    return {
      start: vi.fn(async () => callbacks.onStart?.()),
      // Mirrors the real session: releasing the mic always ends with onEnd,
      // which is what commits an accumulated dictation.
      stop: vi.fn(() => callbacks.onEnd?.()),
      isSupported: () => true,
      setConversationMode: vi.fn(),
    };
  },
  refineVoiceTranscript: (input: string) => input.trim(),
}));

import { toggleTerminalTranscription } from './transcription-hotkey';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Start a dictation, say `text`, end it, and let delivery settle. */
async function speak(text: string) {
  toggleTerminalTranscription();
  await flush();
  captured?.onResult(text);
  await flush();
  // Utterances accumulate until the user ends the dictation.
  toggleTerminalTranscription();
  await flush();
}

describe('transcription-hotkey targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured = null;
    h.activeSessionId.set(7);
    h.transcriptionAutoSend.set(true);
    focus(null);
    stubDocument.activeElement = null;
  });

  it('types into the focused text field, leaving the terminal alone', async () => {
    const field = new StubInput();
    focus(field);

    await speak('hello there');

    expect(field.value).toBe('hello there');
    expect(field.dispatched).toContain('input');
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
  });

  it('inserts at the caret rather than appending', async () => {
    const field = new StubInput();
    field.value = 'git  --oneline';
    field.selectionStart = field.selectionEnd = 4;
    focus(field);

    await speak('log');

    expect(field.value).toBe('git log --oneline');
  });

  /**
   * The regression this file exists for. The service used to resolve the
   * target at DELIVERY time from a module-global that was only ever set and
   * never cleared, so any text field touched earlier in the session kept
   * swallowing transcripts meant for the terminal.
   */
  it('sends to the terminal once focus has moved from a field into a terminal', async () => {
    const field = new StubInput();
    focus(field);

    const term = new StubElement();
    term.className = 'xterm-helper-textarea';
    term.parentClasses = ['xterm'];
    focus(term);

    await speak('npm run build');

    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'npm run build');
    expect(field.value).toBe('');
  });

  /** The mic button steals focus mid-utterance; the text must still go home. */
  it('keeps the field chosen at capture start when focus moves while speaking', async () => {
    const field = new StubInput();
    focus(field);

    toggleTerminalTranscription();
    await flush();

    const micButton = new StubElement(); // not editable, not a terminal
    focus(micButton);

    captured?.onResult('still mine');
    await flush();
    toggleTerminalTranscription();
    await flush();

    expect(field.value).toBe('still mine');
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
  });

  /**
   * The code editor (CodeMirror) and any rich text surface are contenteditable
   * rather than <input>/<textarea>, so they take the execCommand path. "Anywhere
   * text can go" has to include them, not just plain form fields.
   */
  it('dictates into a contenteditable surface such as the editor', async () => {
    const editor = new StubElement();
    editor.isContentEditable = true;
    editor.className = 'cm-content';
    focus(editor);

    await speak('const total = sum(items)');

    expect(stubDocument.execCommand).toHaveBeenCalledWith(
      'insertText',
      false,
      'const total = sum(items)',
    );
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
  });

  /**
   * WhisperFlow-style ending: Escape is not "throw it away", it is "I'm done".
   * Discarding moved to Ctrl+Escape so a mistimed hotkey still has an out.
   */
  it('Escape ends the dictation and pastes everything said', async () => {
    const field = new StubInput();
    focus(field);

    toggleTerminalTranscription();
    await flush();
    captured?.onResult('first part');
    await flush();
    captured?.onResult('second part');
    await flush();

    expect(field.value).toBe('');

    press('Escape');
    await flush();

    expect(field.value).toBe('first part second part');
  });

  it('Ctrl+Escape discards the dictation without pasting', async () => {
    const field = new StubInput();
    focus(field);

    toggleTerminalTranscription();
    await flush();
    captured?.onResult('never mind');
    await flush();

    press('Escape', { ctrlKey: true });
    await flush();

    expect(field.value).toBe('');
    expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
  });

  /**
   * What the user asked for: the box you click into last is the box the text
   * lands in, even when the dictation started over a terminal. The click can
   * come mid-sentence or after the last word — the target follows either way.
   */
  describe('following the caret mid-dictation', () => {
    it('moves to a text box clicked while still speaking', async () => {
      const term = makeTerminal();
      click(term.screen, term.helper);

      toggleTerminalTranscription();
      await flush();
      captured?.onResult('put this in the box');
      await flush();

      const field = new StubInput();
      click(field);

      toggleTerminalTranscription();
      await flush();

      expect(field.value).toBe('put this in the box');
      expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    });

    it('moves to a text box clicked after the last utterance, before ending', async () => {
      const term = makeTerminal();
      click(term.screen, term.helper);

      toggleTerminalTranscription();
      await flush();
      captured?.onResult('late change of mind');
      await flush();

      const field = new StubInput();
      click(field);
      await flush();

      press('Escape');
      await flush();

      expect(field.value).toBe('late change of mind');
      expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    });

    it('inserts at the caret of the box that was clicked', async () => {
      const term = makeTerminal();
      click(term.screen, term.helper);

      toggleTerminalTranscription();
      await flush();
      captured?.onResult('log');
      await flush();

      const field = new StubInput();
      field.value = 'git  --oneline';
      field.selectionStart = field.selectionEnd = 4;
      click(field);

      toggleTerminalTranscription();
      await flush();

      expect(field.value).toBe('git log --oneline');
    });

    it('moves a dictation started in a field to a terminal clicked into', async () => {
      const field = new StubInput();
      click(field);

      toggleTerminalTranscription();
      await flush();
      captured?.onResult('npm run build');
      await flush();

      const term = makeTerminal();
      click(term.screen, term.helper);

      toggleTerminalTranscription();
      await flush();

      expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'npm run build');
      expect(field.value).toBe('');
    });

    it('follows a Tab into the next box', async () => {
      const term = makeTerminal();
      click(term.screen, term.helper);

      toggleTerminalTranscription();
      await flush();
      captured?.onResult('tabbed over');
      await flush();

      const field = new StubInput();
      press('Tab');
      focus(field);

      toggleTerminalTranscription();
      await flush();

      expect(field.value).toBe('tabbed over');
    });

    /**
     * The other half of the rule. A field that grabs focus on its own — a dialog
     * opened by clicking a button elsewhere, a re-render, a toast — is not the
     * user pointing at it, and must not steal a transcript aimed at the terminal.
     */
    it('ignores a field that autofocuses itself after a click on something else', async () => {
      const term = makeTerminal();
      click(term.screen, term.helper);

      toggleTerminalTranscription();
      await flush();
      captured?.onResult('git status');
      await flush();

      const button = new StubElement(); // "Spawn agent"
      pointerDown(button);
      const dialogField = new StubInput(); // the dialog focuses its own input
      focus(dialogField);

      toggleTerminalTranscription();
      await flush();

      expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'git status');
      expect(dialogField.value).toBe('');
    });

    /** The mic button steals focus but is not a text surface at all — the
     *  pre-existing snapshot rule, still intact alongside the new one. */
    it('still ignores focus stolen by a non-text control', async () => {
      const field = new StubInput();
      click(field);

      toggleTerminalTranscription();
      await flush();

      const micButton = new StubElement();
      click(micButton);

      captured?.onResult('still mine');
      await flush();
      toggleTerminalTranscription();
      await flush();

      expect(field.value).toBe('still mine');
      expect(h.sendAgentPromptDirect).not.toHaveBeenCalled();
    });
  });

  it('falls back to the terminal when the remembered field has been unmounted', async () => {
    const field = new StubInput();
    focus(field);
    focus(null);
    field.isConnected = false; // its panel closed

    await speak('echo hi');

    expect(h.sendAgentPromptDirect).toHaveBeenCalledWith(7, 'echo hi');
  });
});
