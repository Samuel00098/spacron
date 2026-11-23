import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { speakAgentCompletions } from '$lib/stores/settings';
import { speakText } from '$lib/services/read-aloud';
import { noteAgentPrompted, noteAgentTurnEnded } from './agentTurnState';

vi.mock('$lib/services/read-aloud', () => ({ speakText: vi.fn() }));
import { platformLaunchFlags, pasteLineBreak } from '$lib/services/agent-permissions';

const ptyDataHandlers = vi.hoisted(() => new Map<number, (bytes: Uint8Array) => void>());
const ptyReplayHandlers = vi.hoisted(() => new Map<number, (bytes: Uint8Array) => void>());
const ptyExitHandlers = vi.hoisted(() => new Map<number, (code: number) => void>());

vi.mock('$lib/services/pty-bridge', () => {
  let nextId = 1;
  return {
    openPty: vi.fn(async (_cols: number, _rows: number, opts?: { onData?: (bytes: Uint8Array) => void; onExit?: (code: number) => void }) => {
      const id = nextId++;
      if (opts?.onData) ptyDataHandlers.set(id, opts.onData);
      if (opts?.onExit) ptyExitHandlers.set(id, opts.onExit);
      return {
        id,
        write: vi.fn(async () => {}),
        resize: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
    }),
    attachPty: vi.fn(async (id: number, opts?: { onData?: (bytes: Uint8Array) => void; onReplay?: (bytes: Uint8Array) => void }) => {
      if (opts?.onData) ptyDataHandlers.set(id, opts.onData);
      if (opts?.onReplay) ptyReplayHandlers.set(id, opts.onReplay);
      return {
        id,
        write: vi.fn(async () => {}),
        resize: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
    }),
  };
});

/**
 * Simulate the session's process exiting. The pty mock's `close` is a no-op, so
 * the exit event that fires after `killSession` has to be raised by hand.
 */
function firePtyExit(sessionId: number, code = 0) {
  ptyExitHandlers.get(sessionId)?.(code);
}

/** Simulate the shell/CLI printing to a session's terminal. */
function feedPtyOutput(sessionId: number, text: string) {
  ptyDataHandlers.get(sessionId)?.(new TextEncoder().encode(text));
}

vi.mock('./notification', () => ({
  showToast: vi.fn(),
}));

// Rules-file delivery (CLAUDE.md / AGENTS.md) goes through Tauri's invoke. Most
// tests pass no cwd, so resolveSessionRoot returns null and this is never hit;
// the cwd-aware tests below assert against it.
// Accepts any args so individual tests can mockImplementation a richer
// response (e.g. a pre-existing .aider.conf.yml); still resolves undefined by
// default. beforeEach resets both calls and the implementation.
const invokeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// workspace.ts and terminal.ts import each other (transitively). Entering the
// cycle from terminal lets vitest's async module runner fire workspace's
// queued autosave binding before terminal's stores exist; entering from
// workspace finishes evaluating terminal first.
import './workspace';
import {
  appendToCommandBlock,
  applyOscPaneTitle,
  attachTerminalSession,
  commandBlocks,
  createTerminalSession,
  devProjectTerminalStates,
  devSessions,
  getSessionOutputBuffer,
  getSessionOutputLength,
  registerDataCallback,
  unregisterDataCallback,
  finalizeCommandBlockWithExit,
  killAllSessions,
  killSession,
  markSessionAgentPreset,
  normalizeForEchoMatch,
  pasteEchoLanded,
  sessions,
  sessionHasRunningProcess,
  setActiveTerminalProject,
  setTerminalProjectRoot,
  setSessionAgentName,
  setSessionOwnerTask,
  setSessionTaskSummary,
  setSessionWorktree,
  applyRestoredSessionMetadata,
  startCommandBlock,
  sendAgentPromptDirect,
  sendAgentInputLine,
  sendPromptToSession,
  spawnAgentPreset,
  relaunchRestoredAgentSession,
  waitForAgentReady,
  isAgentSession,
  updateSessionTitle,
  recordTerminalGeometry,
  __resetTerminalGeometry,
  isShellPromptRow,
} from './terminal';
import { openPty } from '$lib/services/pty-bridge';
import { showToast } from './notification';
import { buildAgentCharter } from '$lib/services/orchestrator/agent-charter';
import { registerTerminalScreen } from '$lib/services/terminal-screen';
import type { Terminal } from '@xterm/xterm';

/** A mounted pane whose rendered rows are whatever `rows()` returns now. */
function fakeScreen(rows: () => string[]): Terminal {
  return {
    buffer: {
      active: {
        type: 'alternate',
        get length() { return rows().length; },
        getLine: (index: number) => {
          const text = rows()[index];
          return text == null ? undefined : { isWrapped: false, translateToString: () => text };
        },
      },
    },
  } as unknown as Terminal;
}

describe('development terminal project parking', () => {
  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('publishes each project state and restores the active development sessions on switch', async () => {
    const projectA = 'dev-project-a';
    const projectB = 'dev-project-b';

    setActiveTerminalProject(projectA);
    const sessionA = await createTerminalSession('/repo-a', 0, projectA, { isDev: true });

    setActiveTerminalProject(projectB);
    const sessionB = await createTerminalSession('/repo-b', 0, projectB, { isDev: true });

    const parked = get(devProjectTerminalStates);
    expect(parked.get(projectA)?.sessions.map((session) => session.id)).toEqual([sessionA]);
    expect(parked.get(projectB)?.sessions.map((session) => session.id)).toEqual([sessionB]);
    expect(get(devSessions).map((session) => session.id)).toEqual([sessionB]);

    setActiveTerminalProject(projectA);
    expect(get(devSessions).map((session) => session.id)).toEqual([sessionA]);
  });
});

describe('sessionHasRunningProcess', () => {
  const base = { id: 1, isRunning: true, isExecuting: false } as const;

  it('flags panes running a detected dev server or build', () => {
    expect(sessionHasRunningProcess({ ...base, role: 'Server' } as any)).toBe(true);
    expect(sessionHasRunningProcess({ ...base, role: 'Build' } as any)).toBe(true);
    expect(sessionHasRunningProcess({ ...base, role: 'server' } as any)).toBe(true);
  });

  it('does not flag idle shells, agents, or unrelated roles', () => {
    expect(sessionHasRunningProcess({ ...base, role: null } as any)).toBe(false);
    expect(sessionHasRunningProcess({ ...base, role: 'Agent' } as any)).toBe(false);
    expect(sessionHasRunningProcess({ ...base, role: 'Tests' } as any)).toBe(false);
  });

  it('ignores roles on a session whose process already exited', () => {
    expect(sessionHasRunningProcess({ ...base, isRunning: false, role: 'Server' } as any)).toBe(false);
    expect(sessionHasRunningProcess(null)).toBe(false);
  });
});

describe('Chat terminal line answers', () => {
  beforeEach(() => setActiveTerminalProject('chat-line-input'));
  afterEach(() => killAllSessions());

  it('writes one literal line and refuses control characters', async () => {
    const sessionId = await createTerminalSession();
    const pty = await vi.mocked(openPty).mock.results.at(-1)!.value;
    expect(await sendAgentInputLine(sessionId!, 'y')).toBe(true);
    expect(pty.write).toHaveBeenLastCalledWith('y\r');
    const count = vi.mocked(pty.write).mock.calls.length;
    expect(await sendAgentInputLine(sessionId!, 'yes\nrun something')).toBe(false);
    expect(await sendAgentInputLine(sessionId!, '\x1b[A')).toBe(false);
    expect(vi.mocked(pty.write).mock.calls.length).toBe(count);
  });

  it('does not report successful delivery after a PTY write failure', async () => {
    const sessionId = await createTerminalSession();
    const pty = await vi.mocked(openPty).mock.results.at(-1)!.value;
    vi.mocked(pty.write).mockRejectedValueOnce(new Error('Session disconnected'));
    expect(await sendAgentInputLine(sessionId!, 'n')).toBe(false);
  });
});

describe('terminal task summaries', () => {
  const projectId = 'project-terminal-summary';

  beforeEach(() => {
    setActiveTerminalProject(projectId);
    commandBlocks.set(new Map());
  });

  afterEach(async () => {
    commandBlocks.set(new Map());
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('keeps the prompt task summary after Claude finishes', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();

    markSessionAgentPreset(sessionId!, 'claude');
    setSessionTaskSummary(sessionId!, 'Fix the terminal panel title');

    startCommandBlock(sessionId!, 'claude');
    appendToCommandBlock(sessionId!, 'Summary: Updated the implementation details.\n');
    finalizeCommandBlockWithExit(sessionId!, 0);

    const session = get(sessions).find((entry) => entry.id === sessionId);
    expect(session?.taskSummary).toBe('Fix the terminal panel title');
  });

  it('shows the assistant name and the agent CLI title side by side on a leased pane', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();

    setSessionOwnerTask(sessionId!, 'task-1');
    setSessionAgentName(sessionId!, 'Iris');
    applyOscPaneTitle(sessionId!, 'Claude Code is ready');

    const session = get(sessions).find((entry) => entry.id === sessionId);
    // The assistant name (badge) and the CLI's OSC title (main heading) live in
    // separate fields, so both stay visible even while the pane is leased.
    expect(session?.agentName).toBe('Iris');
    expect(session?.paneTitle).toBe('Claude Code is ready');
  });
});

describe('reattach history replay', () => {
  const projectId = 'project-reattach-replay';

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('parks replayed history in the session buffer without touching live data callbacks', async () => {
    const backendId = 987;
    const sessionId = await attachTerminalSession(backendId, null, undefined, projectId);
    expect(sessionId).toBe(backendId);

    const liveCallback = vi.fn();
    registerDataCallback(backendId, liveCallback);

    // History replayed on reattach contains the agent's past terminal queries
    // (e.g. Codex's OSC 10/11 color probes). It must reach the session buffer
    // (so TerminalPane can write it through the gated path) but must NOT flow
    // through the live data callbacks — that would re-feed the queries to a
    // live xterm, whose re-answers land in Codex's input as `]10;rgb:…` junk.
    const replay = ptyReplayHandlers.get(backendId);
    expect(replay).toBeDefined();
    replay!(new TextEncoder().encode('\x1b]10;?\x07codex history'));

    expect(getSessionOutputBuffer(backendId)).toContain('codex history');
    expect(liveCallback).not.toHaveBeenCalled();

    // Genuinely live output still flows through the callback as before.
    feedPtyOutput(backendId, 'live output');
    expect(liveCallback).toHaveBeenCalledTimes(1);
    expect(getSessionOutputBuffer(backendId)).toContain('live output');

    unregisterDataCallback(backendId);
  });
});

describe('session output buffer', () => {
  const projectId = 'project-output-buffer';
  // Mirrors MAX_SESSION_BUFFER_CHARS in the store.
  const MAX = 250000;

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  // The buffer keeps chunks in a list and trims them as they age out, rather
  // than rebuilding one big string per chunk. These lock in that the window it
  // exposes is byte-for-byte what the naive `(buffer + text).slice(-MAX)` gave,
  // including the case where the trim has to cut a chunk in half.
  it('keeps exactly the last MAX chars once output passes the cap', async () => {
    const id = await createTerminalSession(undefined, undefined, projectId);
    expect(id).not.toBeNull();

    // Chunk size deliberately does not divide MAX, so the cap lands mid-chunk.
    const chunk = 'abcdefg'.repeat(1000); // 7000 chars
    let expected = '';
    for (let i = 0; i < 60; i++) {
      feedPtyOutput(id!, chunk);
      expected = (expected + chunk).slice(-MAX);
    }

    const actual = getSessionOutputBuffer(id!);
    expect(actual.length).toBe(MAX);
    expect(getSessionOutputLength(id!)).toBe(actual.length);
    expect(actual).toBe(expected);
  });

  it('returns everything written while still under the cap', async () => {
    const id = await createTerminalSession(undefined, undefined, projectId);
    feedPtyOutput(id!, 'first ');
    feedPtyOutput(id!, 'second ');
    feedPtyOutput(id!, 'third');

    expect(getSessionOutputBuffer(id!)).toBe('first second third');
    expect(getSessionOutputLength(id!)).toBe('first second third'.length);
  });

  it('reports a length that matches the buffer across repeated reads', async () => {
    const id = await createTerminalSession(undefined, undefined, projectId);
    // The joined string is memoised and invalidated on write; reading twice with
    // a write in between must not go stale.
    feedPtyOutput(id!, 'x'.repeat(10));
    expect(getSessionOutputBuffer(id!).length).toBe(getSessionOutputLength(id!));
    feedPtyOutput(id!, 'y'.repeat(5));
    expect(getSessionOutputBuffer(id!)).toBe('x'.repeat(10) + 'y'.repeat(5));
    expect(getSessionOutputLength(id!)).toBe(15);
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    const id = await createTerminalSession(undefined, undefined, projectId);
    // A single stateful decoder per session is what makes this work; the pane
    // no longer runs a second one over the same bytes.
    const bytes = new TextEncoder().encode('é');
    ptyDataHandlers.get(id!)?.(bytes.slice(0, 1));
    ptyDataHandlers.get(id!)?.(bytes.slice(1));

    expect(getSessionOutputBuffer(id!)).toBe('é');
  });

  it('hands the decoded chunk to the data callback', async () => {
    const id = await createTerminalSession(undefined, undefined, projectId);
    const cb = vi.fn();
    registerDataCallback(id!, cb);

    feedPtyOutput(id!, 'hello');

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1]).toBe('hello');
    unregisterDataCallback(id!);
  });
});

describe('agent prompt paste-echo detection', () => {
  const PROMPT = 'Explain how the auth flow works';

  it('does not fire on ambient TUI redraw before the paste lands', () => {
    const base = '\x1b[2K\x1b[1G> \x1b[7m \x1b[27m';
    // The status bar redrew (spinner/token counter ticked) but the pasted text
    // has not yet been committed to the composer — this is the exact noise that
    // tripped the old length-delta heuristic and submitted an empty composer.
    const afterRedraw = base + '\x1b[2K\x1b[1GOpus 4 (1M context) | [....] | 0% | 0 /';
    expect(pasteEchoLanded(base, afterRedraw, PROMPT)).toBe(false);
  });

  it('fires once the pasted text is echoed into the composer', () => {
    const base = '\x1b[2K\x1b[1G> ';
    // Claude Code redraws the input box with the pasted text, wrapped in ANSI.
    const withEcho =
      base + `\x1b[2K\x1b[1G\x1b[38;5;245m│\x1b[0m > ${PROMPT}\x1b[7m \x1b[27m`;
    expect(pasteEchoLanded(base, withEcho, PROMPT)).toBe(true);
  });

  it('treats a prompt identical to earlier output as newly echoed', () => {
    // The same prompt was sent before (still in scrollback); a fresh echo must
    // still register, so we compare occurrence counts rather than presence.
    const base = `previously: ${PROMPT}\n> `;
    const withEcho = `${base}\x1b[1G> ${PROMPT}`;
    expect(pasteEchoLanded(base, withEcho, PROMPT)).toBe(true);
  });

  it('matches across reflowed whitespace/newlines in the redraw', () => {
    const base = '> ';
    // A line wrap split the echo across rows; normalization collapses it back.
    const wrapped = base + 'Explain how the\r\n  auth flow works';
    expect(pasteEchoLanded(base, wrapped, PROMPT)).toBe(true);
  });

  it('normalizes ANSI and whitespace to the bare text', () => {
    expect(normalizeForEchoMatch('\x1b[1m\x1b[32mhello\x1b[0m   world\r\n')).toBe('hello world');
  });

  it('returns false for empty prompt text', () => {
    expect(pasteEchoLanded('anything', 'anything more', '')).toBe(false);
  });

  it('fires on a collapsed paste placeholder when the text is not echoed literally', () => {
    // Claude Code collapses multi-line pastes — the literal text never appears,
    // only "[Pasted text #N +M lines]". That placeholder must count as the echo.
    const base = '\x1b[2K\x1b[1G> ';
    const withPlaceholder = base + '\x1b[2K\x1b[1G> [Pasted text #1 +6 lines]\x1b[7m \x1b[27m';
    expect(pasteEchoLanded(base, withPlaceholder, 'SORYQ AGENT BRIEF\nline two\nline three')).toBe(true);
  });

  it('does not fire on a placeholder left over from an earlier paste', () => {
    const base = '> [Pasted text #1 +6 lines] sent earlier\n> ';
    const afterRedraw = base + '\x1b[2K\x1b[1GOpus 4 | [....] | 0%';
    expect(pasteEchoLanded(base, afterRedraw, 'A brand new prompt that is not echoed')).toBe(false);
  });
});

describe('sendAgentPromptDirect', () => {
  const projectId = 'project-terminal-direct';

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it('delivers prompt using bracketed paste for Codex as preset', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'codex', true); // Skip auto-brief

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    writeSpy.mockClear();
    writeSpy.mockImplementation(async (data: string) => {
      if (data === '\r') feedPtyOutput(sessionId!, 'Agent started'.padEnd(512, '.'));
    });

    const multilinePrompt = 'Line 1\nLine 2\nLine 3';
    const result = await sendAgentPromptDirect(sessionId!, multilinePrompt);

    expect(result).toBe(true);
    // Newlines become the paste's line break: \r, as a real terminal paste
    // delivers, except for Codex on Windows, where \r would submit each line.
    const br = pasteLineBreak('codex');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining(`\x1b[200~Line 1${br}Line 2${br}Line 3\x1b[201~`));
  });

  it('delivers Claude charter prompts as one bracketed multi-line paste payload', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'claude', true);

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();
    writeSpy.mockImplementation(async (data: string) => {
      if (data === '\r') feedPtyOutput(sessionId!, 'Agent started'.padEnd(512, '.'));
    });

    const charter = buildAgentCharter('Fix the failing tests', { name: 'Iris' });
    const result = await sendAgentPromptDirect(sessionId!, charter);

    expect(result).toBe(true);
    const pasteWrite = writeSpy.mock.calls.find((call: unknown[]) => typeof call[0] === 'string' && call[0].includes('SORYQ AGENT BRIEF'));
    expect(pasteWrite).toBeDefined();
    const payload = pasteWrite![0] as string;
    expect(payload).toContain('\x1b[200~');
    expect(payload).toContain('\x1b[201~');
    expect(payload).toContain('\r');
    expect(payload).toContain('YOUR TASK (untrusted task text');
    expect(payload).toContain('Fix the failing tests');
  });

  it('does not report success when the PTY stays alive but the CLI never starts the prompt', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'codex', true);

    const result = await sendAgentPromptDirect(sessionId!, 'Inspect the project');

    expect(result).toBe(false);
  });

  it('keeps pressing Enter until the pane shows the paste has left the composer', async () => {
    // Codex on Windows: a long paste arrives as key events, and an Enter that
    // lands while they are still being ingested becomes a newline. The pane
    // redraws throughout, so output growth must not count as "submitted".
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'codex', true);
    const callCount = vi.mocked(openPty).mock.results.length;
    const writeSpy = (await vi.mocked(openPty).mock.results[callCount - 1].value).write;
    writeSpy.mockClear();

    let enters = 0;
    let composer = '› Ask Codex to do anything';
    writeSpy.mockImplementation(async (data: string) => {
      if (data.startsWith('\x1b[200~')) composer = '› [Pasted Content 6830 chars]';
      if (data === '\r') {
        enters += 1;
        feedPtyOutput(sessionId!, 'repaint'.padEnd(600, '.'));
        if (enters === 3) composer = '› Ask Codex to do anything';
      }
    });
    const unregister = registerTerminalScreen(sessionId!, fakeScreen(() => [
      '• Working (2s • esc to interrupt)',
      '',
      composer,
      '',
      '  GPT-6-Luna high · ~\\repo',
    ]));

    try {
      const result = await sendAgentPromptDirect(sessionId!, 'x'.repeat(6830));
      expect(result).toBe(true);
      expect(enters).toBe(3);
    } finally {
      unregister();
    }
  });

  it("does not take an empty composer hint mid-paste as a submit, only the agent's working line", async () => {
    // Codex shows its empty "Ask Codex…" hint while it is still buffering a
    // paste; that is not the prompt being taken.
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'codex', true);
    const callCount = vi.mocked(openPty).mock.results.length;
    const writeSpy = (await vi.mocked(openPty).mock.results[callCount - 1].value).write;
    writeSpy.mockClear();

    let enters = 0;
    let status = '';
    writeSpy.mockImplementation(async (data: string) => {
      if (data !== '\r') return;
      enters += 1;
      feedPtyOutput(sessionId!, 'repaint'.padEnd(600, '.'));
      if (enters === 2) status = '◦ Working (1s • esc to interrupt)';
    });
    const unregister = registerTerminalScreen(sessionId!, fakeScreen(() => [status, '', '› Ask Codex to do anything']));

    try {
      expect(await sendAgentPromptDirect(sessionId!, 'x'.repeat(6830))).toBe(true);
      expect(enters).toBe(2);
    } finally {
      unregister();
    }
  });

  it('reports failure when the paste never leaves the composer', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'codex', true);
    const callCount = vi.mocked(openPty).mock.results.length;
    const writeSpy = (await vi.mocked(openPty).mock.results[callCount - 1].value).write;
    writeSpy.mockClear();
    writeSpy.mockImplementation(async (data: string) => {
      if (data === '\r') feedPtyOutput(sessionId!, 'repaint'.padEnd(600, '.'));
    });
    const unregister = registerTerminalScreen(sessionId!, fakeScreen(() => ['› [Pasted Content 6830 chars]', '', '  GPT-6-Luna high · ~\\repo']));

    try {
      expect(await sendAgentPromptDirect(sessionId!, 'x'.repeat(6830))).toBe(false);
    } finally {
      unregister();
    }
  });

  it('uses the same one-payload charter delivery for OpenCode and Antigravity aliases', async () => {
    for (const preset of ['opencode', 'agy', 'antigravity']) {
      const sessionId = await createTerminalSession(undefined, undefined, projectId);
      expect(sessionId).not.toBeNull();
      markSessionAgentPreset(sessionId!, preset, true);

      const callCount = vi.mocked(openPty).mock.results.length;
      const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
      const writeSpy = mockPty.write;
      writeSpy.mockClear();

      await sendAgentPromptDirect(sessionId!, buildAgentCharter('', { name: 'Rex' }));

      const pasteWrite = writeSpy.mock.calls.find((call: unknown[]) => typeof call[0] === 'string' && call[0].includes('SORYQ AGENT BRIEF'));
      expect(pasteWrite?.[0]).toContain('\x1b[200~');
      expect(pasteWrite?.[0]).toContain('\x1b[201~');
      expect(pasteWrite?.[0]).toContain('you are Rex');
    }
  });
});

describe('agent launch failure detection', () => {
  const projectId = 'project-terminal-launch-fail';

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('reports launch-failed when the shell does not recognize the agent command', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'opencode', true);

    const readiness = waitForAgentReady(sessionId!);
    // PowerShell rejects the command — wrapped mid-word, as narrow terminals do.
    feedPtyOutput(
      sessionId!,
      "opencode : The term 'opencode' is not recognized as the name of a \r\ncmdlet, function, script file, or operable program.\r\n    + FullyQualifiedErrorId : Co\r\n   mmandNotFoundException\r\n"
    );
    expect(await readiness).toBe('launch-failed');
  });

  it('stays ready when the CLI takes over the terminal normally', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();
    markSessionAgentPreset(sessionId!, 'codex', true);

    const readiness = waitForAgentReady(sessionId!);
    feedPtyOutput(sessionId!, 'codex\r\n\x1b[?1049h welcome to codex');
    expect(await readiness).toBe('ready');
  });

  it('treats an already-rendered agent banner as ready', async () => {
    const sessionId = await spawnAgentPreset('claude', undefined, { skipAutoBrief: true });
    expect(sessionId).not.toBeNull();

    feedPtyOutput(
      sessionId!,
      `Claude Code v2.1.172\nWelcome back samuel!\n${'Fable 5 is here. '.repeat(40)}\n> `
    );

    expect(await waitForAgentReady(sessionId!)).toBe('ready');
  });

  it('applies Chat-only launch options without changing the saved agent preset', async () => {
    const sessionId = await spawnAgentPreset('codex', '/repo', {
      skipAutoBrief: true,
      permissionArgsOverride: '--sandbox read-only --ask-for-approval on-request',
      runtimeArgs: '--model gpt-5.6-sol -c model_reasoning_effort=high',
    });
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    expect(mockPty.write).toHaveBeenCalledWith(
      `codex --sandbox read-only --ask-for-approval on-request --model gpt-5.6-sol -c model_reasoning_effort=high${platformLaunchFlags('codex')}\r`,
    );
    expect(get(sessions).find((session) => session.id === sessionId)?.agentPreset).toBe('codex');
  });
});

describe('unified agent briefing', () => {
  const projectId = 'project-terminal-briefing';
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Poll until `check` holds. `briefed` is only set at the very end of the send
   * pipeline (echo wait → composer quiesce → submit-confirm retries), each stage
   * on a real timer, so any fixed sleep is a bet on how loaded the machine is.
   * That bet lost exactly once per parallel full-suite run.
   */
  const waitUntil = async (check: () => boolean, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await sleep(25);
    }
    return check();
  };

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('automatically briefs manually launched agents', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    // Set preset without briefed flag — triggers auto-brief
    markSessionAgentPreset(sessionId!, 'claude');

    // Wait for the auto-brief pipeline to actually finish. `briefed` flips last,
    // after the charter has been written, so this also guarantees the write below.
    const briefed = await waitUntil(() => get(sessions).find(s => s.id === sessionId)?.briefed === true);
    expect(briefed).toBe(true);

    // Verify it sent the brief to the PTY
    expect(writeSpy).toHaveBeenCalled();
    const pastedText = writeSpy.mock.calls.find((call: unknown[]) => typeof call[0] === 'string' && call[0].includes('SORYQ AGENT BRIEF'));
    expect(pastedText).toBeDefined();
  });

  it('skips auto-briefing if skipAutoBrief is true', async () => {
    const sessionId = await spawnAgentPreset('claude', undefined, { skipAutoBrief: true });
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    // Wait to make sure no auto-brief fires
    await sleep(350);

    const calls = writeSpy.mock.calls.map((c: unknown[]) => c[0]);
    const hasBrief = calls.some((c: unknown) => typeof c === 'string' && c.includes('SORYQ AGENT BRIEF'));
    expect(hasBrief).toBe(false);

    const session = get(sessions).find(s => s.id === sessionId);
    expect(session?.briefed).toBe(true);
  });

  it('re-briefs an agent relaunched in a previously-briefed pane', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    const sawBrief = () =>
      writeSpy.mock.calls.some((c: unknown[]) => typeof c[0] === 'string' && c[0].includes('SORYQ AGENT BRIEF'));
    const isBriefed = () => get(sessions).find(s => s.id === sessionId)?.briefed === true;

    // Phase one must be allowed to run to COMPLETION before the relaunch, not just
    // until the charter appears on the wire. `briefed` flips at the end of the send
    // pipeline; re-marking the preset while that pipeline is still in flight is
    // swallowed by the in-flight send, and phase two then never fires.
    markSessionAgentPreset(sessionId!, 'claude');
    expect(await waitUntil(isBriefed)).toBe(true);
    expect(sawBrief()).toBe(true);

    // The agent exits and the user launches it again in the same pane — input
    // detection re-marks the preset, which must reset `briefed` and send the
    // charter to the new process too.
    writeSpy.mockClear();
    markSessionAgentPreset(sessionId!, 'claude');
    expect(await waitUntil(sawBrief)).toBe(true);
    expect(await waitUntil(isBriefed)).toBe(true);
  });

  it('briefs a plain spawnAgentPreset exactly once', async () => {
    const sessionId = await spawnAgentPreset('claude', undefined);
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    // Wait for the pipeline to actually finish rather than guessing at a delay,
    // then assert the charter went out exactly once. Ordered this way the
    // "exactly once" check still covers the full window, not just the first 350ms.
    const briefed = await waitUntil(() => get(sessions).find(s => s.id === sessionId)?.briefed === true);
    expect(briefed).toBe(true);

    // The spawn's own `claude\r` launch write must not re-trigger detection and
    // double-deliver the charter.
    const briefWrites = writeSpy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SORYQ AGENT BRIEF')
    );
    expect(briefWrites).toHaveLength(1);
  });

  it('includes the assigned assistant name in the auto-brief charter', async () => {
    const sessionId = await spawnAgentPreset('claude', undefined);
    expect(sessionId).not.toBeNull();
    // Name applied right after spawn (as the floating-bar "+" does) — the brief
    // is built at send time, so the charter must open with the name.
    setSessionAgentName(sessionId!, 'Iris');

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    await sleep(350);

    const brief = writeSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('SORYQ AGENT BRIEF')
    );
    expect(brief).toBeDefined();
    expect(brief![0]).toContain('you are Iris');
  });

  it('rides the charter along with the first prompt to a not-yet-briefed agent', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();

    // Lease the pane purely to suppress the readiness-gated auto-brief, so this
    // test isolates the prompt path: an agent the user drives before any brief
    // has landed (briefed === false). The lease doesn't affect sendPromptToSession.
    setSessionOwnerTask(sessionId!, 'lease-suppress-autobrief');
    markSessionAgentPreset(sessionId!, 'claude');
    setSessionAgentName(sessionId!, 'Iris');
    await sleep(100);

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    // First prompt: the brief must ride along, wrapped around the task.
    sendPromptToSession(sessionId!, 'Fix the failing tests', 'claude');
    await sleep(100);

    const firstPaste = writeSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('SORYQ AGENT BRIEF')
    );
    expect(firstPaste).toBeDefined();
    expect(firstPaste![0]).toContain('you are Iris');
    expect(firstPaste![0]).toContain('Fix the failing tests');
    expect(get(sessions).find((s) => s.id === sessionId)?.briefed).toBe(true);

    // Second prompt: already briefed, so it goes raw — no charter re-injected.
    writeSpy.mockClear();
    sendPromptToSession(sessionId!, 'Now add a test', 'claude');
    await sleep(100);

    const reBriefed = writeSpy.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('SORYQ AGENT BRIEF')
    );
    expect(reBriefed).toBe(false);
    const secondPaste = writeSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Now add a test')
    );
    expect(secondPaste).toBeDefined();
  });

  it('skips auto-briefing if session is leased by orchestrator task', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    // Mark as preset and lease it immediately before the auto-brief ready timeout completes
    markSessionAgentPreset(sessionId!, 'claude');
    setSessionOwnerTask(sessionId!, 'task-123');

    await sleep(350);

    const calls = writeSpy.mock.calls.map((c: unknown[]) => c[0]);
    const hasBrief = calls.some((c: unknown) => typeof c === 'string' && c.includes('SORYQ AGENT BRIEF'));
    expect(hasBrief).toBe(false);

    const session = get(sessions).find(s => s.id === sessionId);
    expect(session?.briefed).toBeFalsy();
  });
});

describe('worktree metadata across restore', () => {
  const projectId = 'project-terminal-worktree-restore';
  const worktree = {
    path: '/repo/.spacron/worktrees/spacron-neo-342ci1',
    branch: 'spacron/neo-342ci1',
    baseBranch: 'main',
    baseCommit: '6170ecf',
    createdAt: 1_700_000_000_000,
  };

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('restores an agent into its isolated worktree so the badge survives a restart', async () => {
    const sessionId = await createTerminalSession(worktree.path, undefined, projectId, {
      assignPane: false,
      agentPreset: 'claude',
    });
    expect(sessionId).not.toBeNull();

    // Cold start: the pane comes back from localStorage, and its worktree rides
    // along on the restore metadata rather than being dropped.
    await relaunchRestoredAgentSession(sessionId!, 'claude', {
      agentName: 'Neo',
      role: 'Agent',
      worktree,
    });

    expect(get(sessions).find((s) => s.id === sessionId)?.worktree).toEqual(worktree);
  });

  it('keeps an existing worktree when restore metadata omits it', async () => {
    const sessionId = await createTerminalSession(worktree.path, undefined, projectId, {
      assignPane: false,
      agentPreset: 'claude',
    });
    setSessionWorktree(sessionId!, worktree);

    applyRestoredSessionMetadata(sessionId!, { agentName: 'Neo' });

    expect(get(sessions).find((s) => s.id === sessionId)?.worktree).toEqual(worktree);
  });
});

describe('rules-file brief delivery', () => {
  const projectId = 'project-terminal-rules-file';
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Poll until `predicate` holds, then return.
   *
   * Brief delivery is asynchronous, so every test here has to wait for it. A
   * fixed `sleep` is the wrong tool: it is simultaneously too slow on an idle
   * machine and too short on a loaded one, and it fails *asymmetrically* —
   * a test asserting the brief is absent passes trivially when the sleep is too
   * short, while a test asserting it arrived fails. That is exactly how this
   * block used to flake under CPU load. Polling makes both directions honest
   * and usually returns in a few milliseconds.
   */
  const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(10);
    }
    return predicate();
  };

  /** Paths passed to `fs_write_file` so far. */
  const writtenPathsSoFar = (): string[] =>
    invokeMock.mock.calls
      .filter((c: unknown[]) => c[0] === 'fs_write_file')
      .map((c: unknown[]) => (c[1] as { path: string }).path);

  /** Whether the standing brief has been pasted into the PTY. */
  const briefWasPasted = (writeSpy: { mock: { calls: unknown[][] } }): boolean =>
    writeSpy.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('SORYQ AGENT BRIEF')
    );

  /**
   * Whether the session has been marked briefed.
   *
   * Delivery and this flag do not land in the same tick — the flag is set just
   * after the write — so any wait that gates only on the delivery can release
   * while `briefed` is still false. Wait on the *whole* post-condition.
   */
  const sessionBriefed = (id: number | null): boolean =>
    get(sessions).find((s) => s.id === id)?.briefed === true;

  beforeEach(() => {
    setActiveTerminalProject(projectId);
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('briefs a rules-file agent via CLAUDE.md/AGENTS.md and skips the REPL paste', async () => {
    const sessionId = await spawnAgentPreset('claude', '/repo');
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    // Wait for the rules files themselves, not a fixed delay — otherwise the
    // "nothing was pasted" assertion below passes for free if delivery simply
    // hasn't run yet.
    await waitFor(
      () => writtenPathsSoFar().includes('/repo/AGENTS.md') && sessionBriefed(sessionId),
    );

    // The standing brief was written to rules files, not pasted into the REPL.
    expect(writtenPathsSoFar()).toContain('/repo/CLAUDE.md');
    expect(writtenPathsSoFar()).toContain('/repo/AGENTS.md');
    expect(briefWasPasted(writeSpy)).toBe(false);

    const session = get(sessions).find((s) => s.id === sessionId);
    expect(session?.briefed).toBe(true);
  });

  it('sends the first prompt raw (no charter wrap) once briefed via rules file', async () => {
    const sessionId = await spawnAgentPreset('claude', '/repo');
    expect(sessionId).not.toBeNull();
    await sleep(50);

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    sendPromptToSession(sessionId!, 'Fix the failing tests', 'claude');
    await sleep(50);

    const pasted = writeSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('Fix the failing tests')
    );
    expect(pasted).toBeDefined();
    // The brief lives in the rules file now, so the prompt is not re-wrapped.
    expect(pasted![0] as string).not.toContain('SORYQ AGENT BRIEF');
  });

  it('briefs a typed-launch agent via the registered project root when it has no explicit cwd', async () => {
    // Mirrors the user typing `claude` into a shell opened without a cwd: the
    // session has no cwd, but the project root was registered when the project
    // opened, so the rules file still resolves and the paste is skipped. Uses a
    // dedicated project id so the registered root can't leak into other tests.
    const typedProjectId = 'project-terminal-rules-typed';
    setActiveTerminalProject(typedProjectId);
    setTerminalProjectRoot(typedProjectId, '/repo-typed');
    const sessionId = await createTerminalSession(undefined, undefined, typedProjectId);
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    markSessionAgentPreset(sessionId!, 'claude');
    await waitFor(
      () => writtenPathsSoFar().includes('/repo-typed/AGENTS.md') && sessionBriefed(sessionId),
    );

    expect(writtenPathsSoFar()).toContain('/repo-typed/CLAUDE.md');
    expect(writtenPathsSoFar()).toContain('/repo-typed/AGENTS.md');
    expect(briefWasPasted(writeSpy)).toBe(false);

    const session = get(sessions).find((s) => s.id === sessionId);
    expect(session?.briefed).toBe(true);
  });

  it('falls back to the paste brief for rules-file agents launched without a cwd', async () => {
    const sessionId = await spawnAgentPreset('claude', undefined);
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    await waitFor(() => briefWasPasted(writeSpy));

    // No cwd → no rules file written → the legacy paste path delivers the brief.
    expect(invokeMock).not.toHaveBeenCalledWith('fs_write_file', expect.anything());
    expect(briefWasPasted(writeSpy)).toBe(true);
  });

  it('briefs pi via the rules file, not the paste, even with a cwd', async () => {
    const sessionId = await spawnAgentPreset('pi', '/repo');
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    await waitFor(
      () => writtenPathsSoFar().includes('/repo/AGENTS.md') && sessionBriefed(sessionId),
    );

    // Pi loads AGENTS.md/CLAUDE.md as context files at startup (verified
    // 2026-08-12), so the rules file is written and no charter is pasted.
    expect(writtenPathsSoFar()).toContain('/repo/CLAUDE.md');
    expect(writtenPathsSoFar()).toContain('/repo/AGENTS.md');
    expect(briefWasPasted(writeSpy)).toBe(false);
    const session = get(sessions).find((s) => s.id === sessionId);
    expect(session?.briefed).toBe(true);
  });

  it('briefs cn via its Continue rule file, not the paste, even with a cwd', async () => {
    const sessionId = await spawnAgentPreset('cn', '/repo');
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    await waitFor(
      () =>
        writtenPathsSoFar().includes('/repo/.continue/rules/spacron-brief.md') &&
        sessionBriefed(sessionId),
    );

    // Continue loads markdown rule files from .continue/rules/ (verified
    // against docs.continue.dev), so the rules file is written and no charter
    // is pasted.
    expect(writtenPathsSoFar()).toContain('/repo/.continue/rules/spacron-brief.md');
    expect(briefWasPasted(writeSpy)).toBe(false);
    const session = get(sessions).find((s) => s.id === sessionId);
    expect(session?.briefed).toBe(true);
  });

  it('falls back to the paste for aider when its config already declares read:', async () => {
    // .aider.conf.yml pre-exists with its own read list — the file channel
    // cannot complete without merging the user's YAML, so the paste delivers
    // the brief instead of silently starving aider.
    // The describe-level beforeEach restores the default mock afterwards.
    invokeMock.mockImplementation(async (cmd: unknown, args: unknown) => {
      const path = (args as { path?: string } | null)?.path ?? '';
      if (cmd === 'fs_read_file' && path.endsWith('.aider.conf.yml')) {
        return 'read: [CONVENTIONS.md, house.md]\n';
      }
      return undefined;
    });
    const sessionId = await spawnAgentPreset('aider', '/repo');
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    await waitFor(() => briefWasPasted(writeSpy));

    expect(briefWasPasted(writeSpy)).toBe(true);
  });

  it('still pastes the brief for non-rules agents (traecli) even with a cwd', async () => {
    const sessionId = await spawnAgentPreset('traecli', '/repo');
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;

    await waitFor(() => briefWasPasted(writeSpy) && sessionBriefed(sessionId));

    // `traecli` reads no rules file at all (verified 2026-08-12 — the open-source
    // trae-agent CLI has no AGENTS.md/CLAUDE.md/.trae-rules loader), so it keeps
    // the paste delivery. The TRAE IDE rule file is still written as a bonus.
    expect(writtenPathsSoFar()).toContain('/repo/.trae/rules/project_rules.md');
    expect(briefWasPasted(writeSpy)).toBe(true);
    const session = get(sessions).find((s) => s.id === sessionId);
    expect(session?.briefed).toBe(true);
  });
});

describe('restored agent sessions', () => {
  const projectId = 'project-terminal-restore';
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  it('relaunches a remembered agent without auto-sending the standing brief', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(sessionId).not.toBeNull();

    const callCount = vi.mocked(openPty).mock.results.length;
    const mockPty = await vi.mocked(openPty).mock.results[callCount - 1].value;
    const writeSpy = mockPty.write;
    writeSpy.mockClear();

    const relaunched = await relaunchRestoredAgentSession(sessionId!, 'claude', {
      agentName: 'Iris',
      taskSummary: 'Continue the saved workspace session',
    });

    expect(relaunched).toBe(true);
    // Permission mode defaults to yolo, so a relaunched agent carries its own
    // skip-permissions flag on the launch line.
    expect(writeSpy).toHaveBeenCalledWith('claude --dangerously-skip-permissions\r');

    await sleep(100);

    const calls = writeSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((c: unknown) => typeof c === 'string' && c.includes('SORYQ AGENT BRIEF'))).toBe(false);

    const session = get(sessions).find((s) => s.id === sessionId);
    expect(session?.agentPreset).toBe('claude');
    expect(session?.agentName).toBe('Iris');
    expect(session?.taskSummary).toBe('Continue the saved workspace session');
    expect(session?.briefed).toBe(false);
  });
});


describe('shell / agent separation', () => {
  const projectId = 'project-shell-agent-split';

  beforeEach(() => {
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  const titleOf = (id: number) => get(sessions).find((s) => s.id === id)?.title;

  it('numbers shells consecutively, ignoring agents in between', async () => {
    const first = await createTerminalSession(undefined, undefined, projectId);
    expect(titleOf(first!)).toBe('Terminal 1');

    // An agent spawned between two shells must not consume "Terminal 2".
    const agent = await spawnAgentPreset('claude', undefined);
    expect(agent).not.toBeNull();

    const second = await createTerminalSession(undefined, undefined, projectId);
    expect(titleOf(second!)).toBe('Terminal 2');
  });

  it('titles a spawned agent with its tool name, never "Terminal N"', async () => {
    const agent = await spawnAgentPreset('claude', undefined);
    expect(agent).not.toBeNull();
    expect(titleOf(agent!)).toBe('Claude Code');
    expect(titleOf(agent!)).not.toMatch(/^Terminal \d+$/);
  });

  it('retitles a shell that becomes an agent by typing the command', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    expect(titleOf(sessionId!)).toBe('Terminal 1');

    // This is the in-place conversion: the agent really is running in this PTY.
    markSessionAgentPreset(sessionId!, 'claude');

    expect(titleOf(sessionId!)).toBe('Claude Code');
    expect(titleOf(sessionId!)).not.toBe('Terminal 1');
  });

  it('keeps a user-renamed pane title when it becomes an agent', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    updateSessionTitle(sessionId!, 'my scratch shell');

    markSessionAgentPreset(sessionId!, 'claude');

    expect(titleOf(sessionId!)).toBe('my scratch shell');
  });

  it('marks converted sessions as agents so shell-only views exclude them', async () => {
    const shell = await createTerminalSession(undefined, undefined, projectId);
    const converted = await createTerminalSession(undefined, undefined, projectId);
    markSessionAgentPreset(converted!, 'claude');

    const all = get(sessions);
    const shellsOnly = all.filter((s) => !isAgentSession(s));

    expect(shellsOnly.map((s) => s.id)).toEqual([shell!]);
    expect(isAgentSession(all.find((s) => s.id === converted!))).toBe(true);
  });

  it('frees the terminal number again once an agent reverts to a shell', async () => {
    const sessionId = await createTerminalSession(undefined, undefined, projectId);
    markSessionAgentPreset(sessionId!, 'claude');
    expect(isAgentSession(get(sessions).find((s) => s.id === sessionId!))).toBe(true);

    markSessionAgentPreset(sessionId!, null);
    const reverted = get(sessions).find((s) => s.id === sessionId!);
    expect(isAgentSession(reverted)).toBe(false);

    // With the agent gone, the next shell is numbered against shells only.
    const next = await createTerminalSession(undefined, undefined, projectId);
    expect(titleOf(next!)).toBe('Terminal 2');
  });
});

describe('close notifications', () => {
  const projectId = 'project-close-toast';

  beforeEach(() => {
    setActiveTerminalProject(projectId);
    vi.mocked(showToast).mockClear();
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
  });

  const toastMessages = () =>
    vi.mocked(showToast).mock.calls.map((call: unknown[]) => String(call[0]));

  it('names a closed terminal by its per-project number, not the pty id', async () => {
    // Burn a pty id in another project first: pty ids come from a process-wide
    // counter, so without this the counter and the per-project number could
    // agree by accident and the regression would pass unnoticed.
    await createTerminalSession(undefined, undefined, 'project-close-toast-other');
    setActiveTerminalProject(projectId);

    const id = await createTerminalSession(undefined, undefined, projectId);
    expect(get(sessions).find((s) => s.id === id)?.title).toBe('Terminal 1');
    expect(id).toBeGreaterThan(1);

    await killSession(id!);
    firePtyExit(id!, 0);

    expect(toastMessages()).toContain('Terminal 1 closed');
    expect(toastMessages().join(' ')).not.toContain(`Terminal ${id}`);
  });

  it('gives each project its own terminal numbers when closing', async () => {
    const projectA = 'project-close-toast-a';
    const projectB = 'project-close-toast-b';

    setActiveTerminalProject(projectA);
    const inA = await createTerminalSession(undefined, undefined, projectA);
    setActiveTerminalProject(projectB);
    const inB = await createTerminalSession(undefined, undefined, projectB);

    // Both are the first terminal of their own project, whatever their pty ids.
    expect(get(sessions).find((s) => s.id === inB)?.title).toBe('Terminal 1');

    await killSession(inA!);
    firePtyExit(inA!, 0);
    await killSession(inB!);
    firePtyExit(inB!, 0);

    expect(toastMessages().filter((m) => m === 'Terminal 1 closed')).toHaveLength(2);
  });

  it('reports a terminal the user closed as closed, never as an error', async () => {
    const id = await createTerminalSession(undefined, undefined, projectId);

    await killSession(id!);
    // A killed pty does not always exit cleanly — on Windows the kill often
    // surfaces as a non-zero code. The close was still deliberate.
    firePtyExit(id!, 1);

    expect(toastMessages()).toContain('Terminal 1 closed');
    const severities = vi.mocked(showToast).mock.calls.map((call: unknown[]) => String(call[1]));
    expect(severities).not.toContain('error');
  });

  it('speaks a busy agent exit but does not repeat an announced turn', async () => {
    const previousSpeech = get(speakAgentCompletions);
    speakAgentCompletions.set(true);
    vi.mocked(speakText).mockClear();
    try {
      const busyAgent = await spawnAgentPreset('claude', undefined, { skipAutoBrief: true });
      expect(busyAgent).not.toBeNull();
      noteAgentPrompted(busyAgent!, 'Check the build');
      firePtyExit(busyAgent!, 0);
      expect(speakText).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('has exited'));

      const finishedAgent = await spawnAgentPreset('claude', undefined, { skipAutoBrief: true });
      expect(finishedAgent).not.toBeNull();
      noteAgentPrompted(finishedAgent!, 'Check the build');
      noteAgentTurnEnded(finishedAgent!, 'finished', 'declared');
      firePtyExit(finishedAgent!, 0);
      expect(speakText).toHaveBeenCalledTimes(1);
    } finally {
      speakAgentCompletions.set(previousSpeech);
    }
  });

  it('still reports a process that quit by itself as an error', async () => {
    const id = await createTerminalSession(undefined, undefined, projectId);

    // No killSession first: nobody asked this terminal to leave, so a non-zero
    // exit really is a death and must stay an error.
    firePtyExit(id!, 137);

    expect(toastMessages()).toContain('Terminal 1 process died (exit 137)');
    const severities = vi.mocked(showToast).mock.calls.map((call: unknown[]) => String(call[1]));
    expect(severities).toContain('error');
  });
});

describe('MCP project root propagation', () => {
  /** The root the last `mcp_set_project_root` invoke carried, or undefined. */
  function lastPushedRoot(): string | null | undefined {
    const roots = invokeMock.mock.calls
      .filter((c: unknown[]) => c[0] === 'mcp_set_project_root')
      .map((c: unknown[]) => (c[1] as { root: string | null }).root);
    return roots.length === 0 ? undefined : roots[roots.length - 1];
  }

  beforeEach(() => {
    invokeMock.mockClear();
  });

  afterEach(() => {
    setActiveTerminalProject(null);
  });

  it('pushes the root when the project is activated before it is registered', () => {
    // The real open order: every caller activates first and registers the root a
    // line later. Without the push from `setTerminalProjectRoot`, the server was
    // left holding null and refused every delegate_task with "No project is
    // open" — for a project that was very much open.
    const projectId = 'project-mcp-root-activate-first';
    setActiveTerminalProject(projectId);
    expect(lastPushedRoot()).toBeNull();

    setTerminalProjectRoot(projectId, '/repo-mcp-root');
    expect(lastPushedRoot()).toBe('/repo-mcp-root');
  });

  it('pushes the root when it is registered before the project is activated', () => {
    const projectId = 'project-mcp-root-register-first';
    setTerminalProjectRoot(projectId, '/repo-mcp-early');
    setActiveTerminalProject(projectId);
    expect(lastPushedRoot()).toBe('/repo-mcp-early');
  });

  it('ignores a root registered for a project that is not the active one', () => {
    // A background project's root must not retarget the server, or a worker
    // delegated from the visible project would run in the wrong checkout.
    const active = 'project-mcp-root-active';
    setActiveTerminalProject(active);
    setTerminalProjectRoot(active, '/repo-active');
    setTerminalProjectRoot('project-mcp-root-other', '/repo-other');
    expect(lastPushedRoot()).toBe('/repo-active');
  });

  it('clears the root when the last project closes', () => {
    const projectId = 'project-mcp-root-closing';
    setActiveTerminalProject(projectId);
    setTerminalProjectRoot(projectId, '/repo-closing');
    setActiveTerminalProject(null);
    expect(lastPushedRoot()).toBeNull();
  });
});

describe('new PTY spawn geometry', () => {
  const projectId = 'project-spawn-geometry';

  // The node test environment has no localStorage, and the persistence hop is
  // half of what this covers — so stand up the smallest thing that behaves
  // like one rather than skipping the cold-start case.
  const store = new Map<string, string>();
  const fakeLocalStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', fakeLocalStorage);
    __resetTerminalGeometry();
    vi.mocked(openPty).mockClear();
    setActiveTerminalProject(projectId);
  });

  afterEach(async () => {
    await killAllSessions();
    setActiveTerminalProject(null);
    __resetTerminalGeometry();
    store.clear();
    vi.unstubAllGlobals();
  });

  function lastSpawnSize() {
    const calls = vi.mocked(openPty).mock.calls;
    const [cols, rows] = calls[calls.length - 1] as unknown as [number, number];
    return { cols, rows };
  }

  function lastSpawnEnv(): Record<string, string> {
    const calls = vi.mocked(openPty).mock.calls;
    return calls[calls.length - 1][5] as Record<string, string>;
  }

  it('falls back to 120x34 before any pane has measured', async () => {
    await createTerminalSession('/repo');
    expect(lastSpawnSize()).toEqual({ cols: 120, rows: 34 });
  });

  it('opens at the grid a pane last measured, so the shell never reflows', async () => {
    recordTerminalGeometry(97, 21);
    await createTerminalSession('/repo');
    expect(lastSpawnSize()).toEqual({ cols: 97, rows: 21 });
  });

  it('recovers the measured grid from storage on a cold start', async () => {
    recordTerminalGeometry(88, 19);
    __resetTerminalGeometry(); // simulate a fresh process with the same localStorage
    await createTerminalSession('/repo');
    expect(lastSpawnSize()).toEqual({ cols: 88, rows: 19 });
  });

  it('ignores a collapsed or mid-animation pane rather than poisoning the default', async () => {
    recordTerminalGeometry(60, 15);
    recordTerminalGeometry(2, 1); // pane collapsed during a layout transition
    await createTerminalSession('/repo');
    expect(lastSpawnSize()).toEqual({ cols: 60, rows: 15 });
  });

  it('lets an explicit initialCols/initialRows win over the measured default', async () => {
    recordTerminalGeometry(97, 21);
    await createTerminalSession('/repo', undefined, undefined, { initialCols: 200, initialRows: 50 });
    expect(lastSpawnSize()).toEqual({ cols: 200, rows: 50 });
  });

  it('advertises the dark truecolor surface that agent TUIs actually render on', async () => {
    await createTerminalSession('/repo');
    expect(lastSpawnEnv()).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLAUDE_CODE_THEME: 'dark',
      THEME: 'dark',
      COLORFGBG: '15;0',
    });
  });

  it('still lets an explicit per-session environment override a color default', async () => {
    await createTerminalSession('/repo', undefined, undefined, {
      extraEnv: { COLORTERM: '24bit' },
    });
    expect(lastSpawnEnv().COLORTERM).toBe('24bit');
  });
});


describe('agent launch detection', () => {
  it('counts a line typed at a shell prompt', () => {
    expect(isShellPromptRow('PS C:\\work\\app> claude --resume', 'claude --resume')).toBe(true);
    expect(isShellPromptRow('C:\\work\\app>codex', 'codex')).toBe(true);
    expect(isShellPromptRow('me@box:~/app$ opencode', 'opencode')).toBe(true);
  });

  it('ignores the same words typed into a running agent', () => {
    // OpenCode's prompt box, and its /models search box.
    expect(isShellPromptRow('  ┃  claude sonnet 4.5', 'claude sonnet 4.5')).toBe(false);
    expect(isShellPromptRow('                 claude sonnet 4.5', 'claude sonnet 4.5')).toBe(false);
    // Codex and Claude Code composers.
    expect(isShellPromptRow('› claude, review this', 'claude, review this')).toBe(false);
    expect(isShellPromptRow('> codex is slow today', 'codex is slow today')).toBe(false);
  });
});
