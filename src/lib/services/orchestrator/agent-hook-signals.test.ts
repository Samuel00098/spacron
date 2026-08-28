import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildClaudeHookSettings,
  parseSignalLine,
  parseOpenUrlLine,
  supportsHookSignals,
  onTurnSignal,
  hasTurnSignalChannel,
  hasAnyTurnSignalChannel,
  hasTurnSignalListener,
  __registerStatusChannelForTest,
  deliverTurnSignal,
  __registerChannelForTest,
  __deliverLineForTest,
  __resetTurnSignalsForTest,
  type HookSignal,
} from './agent-hook-signals';

const NONCE = 'deadbeefcafe0123';

beforeEach(() => {
  __resetTurnSignalsForTest();
});

describe('supportsHookSignals', () => {
  it('recognises Claude Code however the command is written', () => {
    expect(supportsHookSignals('claude')).toBe(true);
    expect(supportsHookSignals('claude --dangerously-skip-permissions')).toBe(true);
    expect(supportsHookSignals('/usr/local/bin/claude')).toBe(true);
    expect(supportsHookSignals('C:\\tools\\claude.cmd')).toBe(true);
  });

  it('leaves every other CLI on the output-scanning fallback', () => {
    for (const cmd of ['codex', 'aider', 'cursor-agent', 'grok', '', null, undefined]) {
      expect(supportsHookSignals(cmd)).toBe(false);
    }
  });
});

describe('parseOpenUrlLine', () => {
  it('returns the URL an agent asked to open', () => {
    expect(parseOpenUrlLine(`SPACRON-OPEN-URL:${NONCE} https://example.com/a`, NONCE)).toBe(
      'https://example.com/a',
    );
  });

  it('ignores a line carrying a different nonce', () => {
    expect(parseOpenUrlLine(`SPACRON-OPEN-URL:someone-else https://example.com`, NONCE)).toBeNull();
  });

  it('is not a turn signal, so it never ends a turn', () => {
    // The two vocabularies share a channel; they must not share a meaning.
    expect(parseSignalLine(`SPACRON-OPEN-URL:${NONCE} https://example.com`, NONCE)).toBeNull();
    expect(parseOpenUrlLine(`SPACRON-TURN-DONE:${NONCE} all done`, NONCE)).toBeNull();
  });

  it('refuses a scheme the preview iframe must never navigate to', () => {
    expect(parseOpenUrlLine(`SPACRON-OPEN-URL:${NONCE} javascript:alert(1)`, NONCE)).toBeNull();
    expect(parseOpenUrlLine(`SPACRON-OPEN-URL:${NONCE} file:///etc/passwd`, NONCE)).toBeNull();
  });

  it('refuses a line with no URL on it', () => {
    expect(parseOpenUrlLine(`SPACRON-OPEN-URL:${NONCE}`, NONCE)).toBeNull();
    expect(parseOpenUrlLine(`SPACRON-OPEN-URL:${NONCE}   `, NONCE)).toBeNull();
    expect(parseOpenUrlLine(`SPACRON-OPEN-URL:${NONCE} not-a-url`, NONCE)).toBeNull();
  });
});

describe('parseSignalLine', () => {
  it('reads the two sentinels', () => {
    expect(parseSignalLine(`SPACRON-TURN-DONE:${NONCE}`, NONCE)).toEqual({ kind: 'finished' });
    expect(parseSignalLine(`SPACRON-NEEDS-INPUT:${NONCE}`, NONCE)).toEqual({
      kind: 'blocked',
      reason: 'Agent is waiting for your input.',
    });
  });

  it('carries a reason when the hook supplies one', () => {
    const signal = parseSignalLine(`SPACRON-NEEDS-INPUT:${NONCE}: overwrite config.ts?`, NONCE);
    expect(signal).toEqual({ kind: 'blocked', reason: 'overwrite config.ts?' });
  });

  it('tolerates the trailing whitespace cmd.exe adds to echo', () => {
    expect(parseSignalLine(`SPACRON-TURN-DONE:${NONCE}  \r`, NONCE)).toEqual({ kind: 'finished' });
  });

  it('ignores a sentinel carrying a different nonce', () => {
    // Two agents share one temp directory; one must never end the other's turn.
    expect(parseSignalLine('SPACRON-TURN-DONE:someoneelse', NONCE)).toBeNull();
  });

  it('ignores the bare prefix, so an agent echoing this file cannot end its turn', () => {
    // The same trap as the reviewer verdict tokens: the sentinel's text can end
    // up in the agent's own context. Only the nonce makes it authoritative.
    expect(parseSignalLine('SPACRON-TURN-DONE:', NONCE)).toBeNull();
    expect(parseSignalLine('the sentinel is SPACRON-TURN-DONE:<nonce>', NONCE)).toBeNull();
    expect(parseSignalLine(`prefix SPACRON-TURN-DONE:${NONCE}`, NONCE)).toBeNull();
  });

  it('ignores unrelated output', () => {
    expect(parseSignalLine('Running tests...', NONCE)).toBeNull();
    expect(parseSignalLine('', NONCE)).toBeNull();
  });
});

describe('buildClaudeHookSettings', () => {
  const settings = buildClaudeHookSettings(NONCE, '/tmp/chan.signals') as any;

  it('installs a Stop hook and a Notification hook', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'Stop']);
  });

  it('appends rather than truncating, so two turns in a row both register', () => {
    const stop = settings.hooks.Stop[0].hooks[0].command as string;
    expect(stop).toContain('>>');
    expect(stop).not.toMatch(/[^>]>[^>]/);
  });

  it('emits a command that means the same thing in cmd.exe and sh', () => {
    const stop = settings.hooks.Stop[0].hooks[0].command as string;
    // `echo <text>>>"<path>"` — no space before the redirect (cmd would write a
    // trailing one) and the path quoted (both shells honour double quotes).
    expect(stop).toBe(`echo SPACRON-TURN-DONE:${NONCE}>>"/tmp/chan.signals"`);
  });

  it('carries the nonce in both sentinels', () => {
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(NONCE);
    expect(settings.hooks.Notification[0].hooks[0].command).toContain(NONCE);
  });
});

describe('channel routing', () => {
  it('delivers a sentinel to the session bound to that channel', () => {
    const seen: HookSignal[] = [];
    __registerChannelForTest(7, NONCE);
    onTurnSignal(7, (s) => seen.push(s));

    __deliverLineForTest(NONCE, `SPACRON-TURN-DONE:${NONCE}`);
    expect(seen).toEqual([{ kind: 'finished' }]);
  });

  it('keeps two concurrent agents apart', () => {
    const a: HookSignal[] = [];
    const b: HookSignal[] = [];
    __registerChannelForTest(1, 'aaaa1111');
    __registerChannelForTest(2, 'bbbb2222');
    onTurnSignal(1, (s) => a.push(s));
    onTurnSignal(2, (s) => b.push(s));

    __deliverLineForTest('bbbb2222', 'SPACRON-TURN-DONE:bbbb2222');
    expect(a).toEqual([]);
    expect(b).toEqual([{ kind: 'finished' }]);
  });

  it('reports whether a session is on the sentinel path', () => {
    expect(hasTurnSignalChannel(9)).toBe(false);
    __registerChannelForTest(9, NONCE);
    expect(hasTurnSignalChannel(9)).toBe(true);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: HookSignal[] = [];
    __registerChannelForTest(3, NONCE);
    const off = onTurnSignal(3, (s) => seen.push(s));
    off();
    __deliverLineForTest(NONCE, `SPACRON-TURN-DONE:${NONCE}`);
    expect(seen).toEqual([]);
  });

  it('distinguishes an armed watcher from a channel with nobody listening', () => {
    __registerChannelForTest(3, NONCE);
    expect(hasTurnSignalListener(3)).toBe(false);

    const off = onTurnSignal(3, () => {});
    expect(hasTurnSignalListener(3)).toBe(true);

    off();
    expect(hasTurnSignalListener(3)).toBe(false);
    // The launch channel remains attached after a turn watcher resolves.
    expect(hasAnyTurnSignalChannel(3)).toBe(true);
  });
});

describe('deliverTurnSignal (reports pushed in from the MCP path)', () => {
  it('reaches a watcher on a session that never had a hook channel', () => {
    const seen: HookSignal[] = [];
    const stop = onTurnSignal(7, (s) => seen.push(s));

    expect(deliverTurnSignal(7, { kind: 'finished' })).toBe(true);
    expect(seen).toEqual([{ kind: 'finished' }]);
    stop();
  });

  it('does not make a watched session look hook-capable', () => {
    // A true answer here moves the watcher's idle fallback from 90s to 15
    // minutes, which is only right for an agent whose sentinel is guaranteed.
    const stop = onTurnSignal(7, () => {});
    expect(hasTurnSignalChannel(7)).toBe(false);
    stop();

    __registerChannelForTest(8, NONCE);
    expect(hasTurnSignalChannel(8)).toBe(true);
  });

  it('reports it delivered nothing when no watcher is armed', () => {
    expect(deliverTurnSignal(99, { kind: 'finished' })).toBe(false);
  });

  it('stops delivering once the watcher unsubscribes', () => {
    const seen: HookSignal[] = [];
    const stop = onTurnSignal(7, (s) => seen.push(s));
    stop();
    expect(deliverTurnSignal(7, { kind: 'finished' })).toBe(false);
    expect(seen).toEqual([]);
  });

  it('still delivers hook sentinels to a listener registered before the channel', () => {
    // Ordering guard: the watcher subscribes first, and attaching the channel
    // afterwards must not replace the entry holding its listener.
    const seen: HookSignal[] = [];
    const stop = onTurnSignal(5, (s) => seen.push(s));
    deliverTurnSignal(5, { kind: 'blocked', reason: 'which db?' });
    expect(seen).toEqual([{ kind: 'blocked', reason: 'which db?' }]);
    stop();
  });
});

describe('the shell status channel (every CLI, not just the eight)', () => {
  it('reads a done sentinel an agent echoed by hand, with its sentence', () => {
    const seen: HookSignal[] = [];
    __registerStatusChannelForTest(3, NONCE);
    const stop = onTurnSignal(3, (s) => seen.push(s));

    __deliverLineForTest(NONCE, `SPACRON-TURN-DONE:${NONCE} Added the retry backoff; 12 tests pass.`);

    expect(seen).toEqual([
      { kind: 'finished', detail: 'Added the retry backoff; 12 tests pass.' },
    ]);
    stop();
  });

  it('reads needs-input and failure sentinels', () => {
    const seen: HookSignal[] = [];
    __registerStatusChannelForTest(3, NONCE);
    const stop = onTurnSignal(3, (s) => seen.push(s));

    __deliverLineForTest(NONCE, `SPACRON-NEEDS-INPUT:${NONCE} Which database?`);
    __deliverLineForTest(NONCE, `SPACRON-TURN-FAILED:${NONCE} Dependency conflict.`);

    expect(seen).toEqual([
      { kind: 'blocked', reason: 'Which database?' },
      { kind: 'failed', reason: 'Dependency conflict.' },
    ]);
    stop();
  });

  it('still accepts the bare sentinel Claude\'s hook writes', () => {
    const seen: HookSignal[] = [];
    __registerStatusChannelForTest(3, NONCE);
    const stop = onTurnSignal(3, (s) => seen.push(s));
    __deliverLineForTest(NONCE, `SPACRON-TURN-DONE:${NONCE}`);
    expect(seen).toEqual([{ kind: 'finished' }]);
    stop();
  });

  it('does not buy the long idle window a hook does', () => {
    // A shell channel depends on the agent remembering to echo. Treating it as
    // guaranteed would move every CLI to the 15-minute fallback.
    __registerStatusChannelForTest(3, NONCE);
    expect(hasTurnSignalChannel(3)).toBe(false);
    expect(hasAnyTurnSignalChannel(3)).toBe(true);
  });

  it('lets one session hold both a hook and a shell channel', () => {
    // Claude gets both. Whichever line lands first ends the turn.
    const other = 'ffffeeeeddddcccc';
    const seen: HookSignal[] = [];
    __registerChannelForTest(4, NONCE);
    __registerStatusChannelForTest(4, other);
    const stop = onTurnSignal(4, (s) => seen.push(s));

    __deliverLineForTest(other, `SPACRON-TURN-DONE:${other} via the shell`);
    __deliverLineForTest(NONCE, `SPACRON-TURN-DONE:${NONCE}`);

    expect(seen).toHaveLength(2);
    // Guaranteed standing survives the second, best-effort channel.
    expect(hasTurnSignalChannel(4)).toBe(true);
    stop();
  });

  it('ignores a sentinel carrying another session\'s nonce', () => {
    const seen: HookSignal[] = [];
    __registerStatusChannelForTest(3, NONCE);
    const stop = onTurnSignal(3, (s) => seen.push(s));
    // The nonce is the whole guard: it lives only in that session's env.
    __deliverLineForTest(NONCE, 'SPACRON-TURN-DONE:someone-elses-nonce');
    expect(seen).toEqual([]);
    stop();
  });
});
