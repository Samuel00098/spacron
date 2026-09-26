import { describe, it, expect } from 'vitest';
import { writable, get } from '$lib/stores/storeCompat';
import {
  isYoloCapable,
  yoloArgsFor,
  yoloEnvFor,
  resolveAgentLaunchArgs,
  resolveAgentLaunchEnv,
  resolveAgentLaunchCommand,
  effectiveAgentMode,
  setAgentPermissionMode,
  hasCustomizedYoloAgents,
  platformLaunchFlags,
} from './agent-permissions';

describe('agent-permissions', () => {
  describe('yoloArgsFor / yoloEnvFor', () => {
    it('maps each known CLI to its own skip-permissions flag', () => {
      expect(yoloArgsFor('claude')).toBe('--dangerously-skip-permissions');
      expect(yoloArgsFor('codex')).toBe('--dangerously-bypass-approvals-and-sandbox');
      expect(yoloArgsFor('gemini')).toBe('--yolo');
      expect(yoloArgsFor('qwen')).toBe('--approval-mode yolo');
      expect(yoloArgsFor('grok')).toBe('--permission-mode bypassPermissions');
      // OpenCode documents `--auto` (auto-approve not-explicitly-denied) on
      // both the TUI and `run`, so it is yolo-capable like the rest.
      expect(yoloArgsFor('opencode')).toBe('--auto');
    });

    it('resolves the flag from the executable even behind a launcher', () => {
      expect(yoloArgsFor('npx claude')).toBe('--dangerously-skip-permissions');
      expect(yoloArgsFor('claude --resume')).toBe('--dangerously-skip-permissions');
    });

    it('returns empty for agents with no bypass flag', () => {
      // `pi` and `droid` still launch bare in yolo mode — no verified flag.
      expect(yoloArgsFor('pi')).toBe('');
      expect(yoloArgsFor('droid')).toBe('');
      expect(yoloArgsFor('')).toBe('');
      expect(yoloArgsFor(null)).toBe('');
    });

    it('maps Goose to an env var rather than a flag', () => {
      expect(yoloEnvFor('goose')).toEqual({ GOOSE_MODE: 'auto' });
      expect(yoloArgsFor('goose')).toBe('');
    });

    it('flags yolo capability only for known executables', () => {
      expect(isYoloCapable('claude')).toBe(true);
      expect(isYoloCapable('goose')).toBe(true);
      expect(isYoloCapable('opencode')).toBe(true);
      expect(isYoloCapable('pi')).toBe(false);
      expect(isYoloCapable('')).toBe(false);
      expect(isYoloCapable(null)).toBe(false);
    });
  });

  describe('resolveAgentLaunchArgs', () => {
    const manual: 'manual' = 'manual';

    it('returns the yolo flag for a known agent in yolo mode', () => {
      expect(resolveAgentLaunchArgs('claude', 'yolo')).toBe('--dangerously-skip-permissions');
    });

    it('returns nothing for an agent without a flag, even in yolo mode', () => {
      expect(resolveAgentLaunchArgs('pi', 'yolo')).toBe('');
    });

    it('returns nothing in manual mode', () => {
      expect(resolveAgentLaunchArgs('claude', manual)).toBe('');
    });

    it('lets a per-agent override win, including empty string pinning to manual', () => {
      const overrides = { agentDefaultArgs: { claude: '--model sonnet' } };
      expect(resolveAgentLaunchArgs('claude', 'yolo', overrides)).toBe('--model sonnet');

      const pinned = { agentDefaultArgs: { claude: '' } };
      expect(resolveAgentLaunchArgs('claude', 'yolo', pinned)).toBe('');
      expect(resolveAgentLaunchArgs('claude', manual, pinned)).toBe('');
    });

    it('ignores overrides for a different agent', () => {
      const overrides = { agentDefaultArgs: { codex: '--x' } };
      expect(resolveAgentLaunchArgs('claude', 'yolo', overrides)).toBe('--dangerously-skip-permissions');
    });
  });

  describe('resolveAgentLaunchEnv', () => {
    it('returns the yolo env for Goose in yolo mode', () => {
      expect(resolveAgentLaunchEnv('goose', 'yolo')).toEqual({ GOOSE_MODE: 'auto' });
    });

    it('returns nothing in manual mode or for flag-based agents', () => {
      expect(resolveAgentLaunchEnv('goose', 'manual')).toEqual({});
      expect(resolveAgentLaunchEnv('claude', 'yolo')).toEqual({});
    });

    it('lets a per-agent env override win', () => {
      const overrides = { agentDefaultEnv: { goose: { GOOSE_MODE: 'strict' } } };
      expect(resolveAgentLaunchEnv('goose', 'yolo', overrides)).toEqual({ GOOSE_MODE: 'strict' });
    });
  });

  describe('resolveAgentLaunchCommand', () => {
    it('returns the preset command when no override exists', () => {
      expect(resolveAgentLaunchCommand('claude')).toBe('claude');
    });

    it('uses a non-empty override', () => {
      const overrides = { agentCmdOverrides: { claude: 'claude --dangerously-skip-permissions' } };
      expect(resolveAgentLaunchCommand('claude', overrides)).toBe('claude --dangerously-skip-permissions');
    });

    it('falls back to the preset command when the override is blank', () => {
      const overrides = { agentCmdOverrides: { claude: '   ' } };
      expect(resolveAgentLaunchCommand('claude', overrides)).toBe('claude');
    });
  });

  describe('effectiveAgentMode', () => {
    it('reports the global mode when nothing is overridden', () => {
      expect(effectiveAgentMode('claude', 'yolo')).toBe('yolo');
      expect(effectiveAgentMode('claude', 'manual')).toBe('manual');
      expect(effectiveAgentMode('goose', 'yolo')).toBe('yolo');
      expect(effectiveAgentMode('goose', 'manual')).toBe('manual');
    });

    it('reports yolo when the override equals the CLI flag', () => {
      const overrides = { agentDefaultArgs: { claude: '--dangerously-skip-permissions' } };
      expect(effectiveAgentMode('claude', 'manual', overrides)).toBe('yolo');
    });

    it('reports manual when pinned by an empty-string override', () => {
      const overrides = { agentDefaultArgs: { claude: '' } };
      expect(effectiveAgentMode('claude', 'yolo', overrides)).toBe('manual');
    });

    it('reports custom for a bespoke args override', () => {
      const overrides = { agentDefaultArgs: { claude: '--model sonnet' } };
      expect(effectiveAgentMode('claude', 'yolo', overrides)).toBe('custom');
    });

    it('reports yolo for env-only agents (Goose) when the env matches', () => {
      const overrides = { agentDefaultEnv: { goose: { GOOSE_MODE: 'auto' } } };
      expect(effectiveAgentMode('goose', 'manual', overrides)).toBe('yolo');
    });

    it('reports custom for a bespoke env override', () => {
      const overrides = { agentDefaultEnv: { goose: { GOOSE_MODE: 'strict' } } };
      expect(effectiveAgentMode('goose', 'yolo', overrides)).toBe('custom');
    });

    it('reports custom for CLIs without any bypass', () => {
      expect(effectiveAgentMode('pi', 'yolo')).toBe('custom');
    });
  });

  describe('setAgentPermissionMode', () => {
    function stores() {
      return {
        agentDefaultArgs: writable<Record<string, string>>({}),
        agentDefaultEnv: writable<Record<string, Record<string, string>>>({}),
      };
    }

    it('pins a flag-based agent to yolo with its native flag', () => {
      const s = stores();
      setAgentPermissionMode('claude', 'yolo', s);
      expect(get(s.agentDefaultArgs)).toEqual({ claude: '--dangerously-skip-permissions' });
      expect(get(s.agentDefaultEnv)).toEqual({});
    });

    it('pins an env-only agent (Goose) to yolo with its env', () => {
      const s = stores();
      setAgentPermissionMode('goose', 'yolo', s);
      expect(get(s.agentDefaultArgs)).toEqual({});
      expect(get(s.agentDefaultEnv)).toEqual({ goose: { GOOSE_MODE: 'auto' } });
    });

    it('pins a flag-based agent to manual with an empty-string args override', () => {
      const s = stores();
      setAgentPermissionMode('claude', 'manual', s);
      expect(get(s.agentDefaultArgs)).toEqual({ claude: '' });
      // Claude has no env bypass, so no env key is written at all.
      expect(get(s.agentDefaultEnv)).toEqual({});
    });

    it('pins an env-only agent to manual with an empty env override', () => {
      const s = stores();
      setAgentPermissionMode('goose', 'manual', s);
      // Goose has no flag, so no args key is written.
      expect(get(s.agentDefaultArgs)).toEqual({});
      expect(get(s.agentDefaultEnv)).toEqual({ goose: {} });
    });

    it('yolo round-trips through the resolve layer', () => {
      const s = stores();
      setAgentPermissionMode('claude', 'yolo', s);
      expect(
        resolveAgentLaunchArgs('claude', 'manual', { agentDefaultArgs: get(s.agentDefaultArgs) })
      ).toBe('--dangerously-skip-permissions');
      expect(
        effectiveAgentMode('claude', 'manual', { agentDefaultArgs: get(s.agentDefaultArgs) })
      ).toBe('yolo');
    });

    it('manual round-trips through the resolve layer even in yolo mode', () => {
      const s = stores();
      setAgentPermissionMode('claude', 'manual', s);
      expect(
        resolveAgentLaunchArgs('claude', 'yolo', { agentDefaultArgs: get(s.agentDefaultArgs) })
      ).toBe('');
      expect(
        effectiveAgentMode('claude', 'yolo', { agentDefaultArgs: get(s.agentDefaultArgs) })
      ).toBe('manual');
    });

    it('manual pin for goose still blocks yolo env injection', () => {
      const s = stores();
      setAgentPermissionMode('goose', 'manual', s);
      expect(
        resolveAgentLaunchEnv('goose', 'yolo', { agentDefaultEnv: get(s.agentDefaultEnv) })
      ).toEqual({});
      expect(
        effectiveAgentMode('goose', 'yolo', { agentDefaultEnv: get(s.agentDefaultEnv) })
      ).toBe('manual');
    });
  });

  describe('hasCustomizedYoloAgents', () => {
    it('is false when nothing is overridden', () => {
      expect(hasCustomizedYoloAgents('yolo')).toBe(false);
      expect(hasCustomizedYoloAgents('manual')).toBe(false);
    });

    it('is true when an override diverges from the global mode', () => {
      const overrides = { agentDefaultArgs: { claude: '--model sonnet' } };
      expect(hasCustomizedYoloAgents('yolo', overrides)).toBe(true);
      expect(hasCustomizedYoloAgents('manual', overrides)).toBe(true);
    });

    it('is false when the override equals what the global mode would produce', () => {
      const overrides = { agentDefaultArgs: { claude: '--dangerously-skip-permissions' } };
      expect(hasCustomizedYoloAgents('yolo', overrides)).toBe(false);
      expect(hasCustomizedYoloAgents('manual', overrides)).toBe(true);
    });

    it('is false when a manual pin matches the manual global mode', () => {
      const overrides = { agentDefaultArgs: { claude: '' } };
      expect(hasCustomizedYoloAgents('manual', overrides)).toBe(false);
    });

    it('ignores agents with no yolo capability', () => {
      const overrides = { agentDefaultArgs: { pi: '--x' } };
      expect(hasCustomizedYoloAgents('yolo', overrides)).toBe(false);
    });

    it('detects diverging env overrides', () => {
      const overrides = { agentDefaultEnv: { goose: { GOOSE_MODE: 'strict' } } };
      expect(hasCustomizedYoloAgents('yolo', overrides)).toBe(true);
    });
  });
});

// Codex's app-server daemon has no console on Windows, so every command it runs
// pops a console window; Spacron keeps Codex's app server inside the PTY.
describe('platformLaunchFlags', () => {
  it('turns off the Codex daemon on Windows', () => {
    expect(platformLaunchFlags('codex', 'Win32')).toBe(' --no-daemon');
    expect(platformLaunchFlags('npx codex --resume', 'Win32')).toBe(' --no-daemon');
  });

  it('adds nothing elsewhere or for other CLIs', () => {
    expect(platformLaunchFlags('codex', 'MacIntel')).toBe('');
    expect(platformLaunchFlags('codex', 'Linux x86_64')).toBe('');
    expect(platformLaunchFlags('claude', 'Win32')).toBe('');
    expect(platformLaunchFlags('', 'Win32')).toBe('');
  });
});
