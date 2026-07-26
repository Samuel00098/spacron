import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildClaudeHookSettings,
  parseSignalLine,
  supportsHookSignals,
  onTurnSignal,
  hasTurnSignalChannel,
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
});
