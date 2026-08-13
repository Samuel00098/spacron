import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filterInstalledAgents, getAgentRoster, type QuickRun } from './runs';

// getAgentRoster reads detection state, which only exists inside Tauri — mock
// the runtime check so the roster-filtering path is exercised.
vi.mock('$lib/utils/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/tauri')>()),
  isTauriRuntime: () => true,
}));

import { usageState } from './usage';

function run(command: string, extra: Partial<QuickRun> = {}): QuickRun {
  return { id: command, name: command, command, projectId: 'p1', ...extra };
}

const builtinCodex = run('codex', { isPreset: true, isAgent: true });
const builtinClaude = run('claude', { isPreset: true, isAgent: true });
const customCoder = run('my-coder', { isPreset: true, isAgent: true });

function detected(command: string, installed: boolean) {
  return {
    provider: command,
    command,
    name: command,
    installed,
    signedIn: false,
    detectsSignIn: true,
    supportsUsage: true,
  };
}

describe('filterInstalledAgents', () => {
  it('keeps built-in presets that are auto-detected as installed', () => {
    const out = filterInstalledAgents([builtinCodex, builtinClaude], {
      installedCommands: new Set(['codex']),
      customCommands: new Set(),
      haveDetection: true,
    });
    expect(out.map((r) => r.command)).toEqual(['codex']);
  });

  it('always keeps custom agents, which detection cannot know about', () => {
    const out = filterInstalledAgents([builtinCodex, customCoder], {
      installedCommands: new Set(['codex']),
      customCommands: new Set(['my-coder']),
      haveDetection: true,
    });
    expect(out.map((r) => r.command)).toEqual(['codex', 'my-coder']);
  });

  it('drops a built-in whose command is only in the catalog, not installed', () => {
    const out = filterInstalledAgents([builtinCodex, builtinClaude, customCoder], {
      installedCommands: new Set(['claude']),
      customCommands: new Set(['my-coder']),
      haveDetection: true,
    });
    expect(out.map((r) => r.command)).toEqual(['claude', 'my-coder']);
  });

  it('falls back to the full list before the first scan completes', () => {
    const all = [builtinCodex, builtinClaude, customCoder];
    expect(
      filterInstalledAgents(all, {
        installedCommands: new Set(),
        customCommands: new Set(),
        haveDetection: false,
      }),
    ).toEqual(all);
  });

  it('is safe with an empty installed set once detection has run', () => {
    const out = filterInstalledAgents([builtinCodex, customCoder], {
      installedCommands: new Set(),
      customCommands: new Set(['my-coder']),
      haveDetection: true,
    });
    expect(out.map((r) => r.command)).toEqual(['my-coder']);
  });
});

describe('getAgentRoster detection filter', () => {
  beforeEach(() => {
    // Scan not run yet by default — tests below override per case.
    usageState.set({
      providers: [],
      detected: [],
      loading: false,
      lastFetchedAt: 0,
    });
  });

  it('narrows built-ins to installed agents once detection has run', () => {
    usageState.set({
      providers: [],
      detected: [detected('codex', true), detected('claude', false)],
      loading: false,
      lastFetchedAt: Date.now(),
    });
    const roster = getAgentRoster();
    expect(roster.map((a) => a.command)).toContain('codex');
    expect(roster.map((a) => a.command)).not.toContain('claude');
  });

  it('returns the full roster before the first scan has completed', () => {
    const roster = getAgentRoster();
    expect(roster.map((a) => a.command)).toContain('codex');
    expect(roster.map((a) => a.command)).toContain('claude');
  });
});
