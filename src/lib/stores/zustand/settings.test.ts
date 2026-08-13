import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression tests for the wrapper-only settings keys (agentWorktrees,
// autoStageAgentChanges, agentBrowserTools). They are declared in
// stores/settings.ts behind `persistentWritable` but were missing from this
// store's `createSettingsState()`, so `persistentWritable`'s boot-time
// `getState()[key]` read hit undefined and fell back to the wrapper default
// every launch — toggles survived a session but silently reset on restart.
//
// Vitest runs in `node` (no jsdom), so `window` and `localStorage` are stubbed
// per test. `vi.resetModules()` gives every test a fresh module graph, which is
// the only way to exercise the at-import boot read.
//
// The stored key format must match `persistValue` in this file:
// `forge_setting_<key>` with a JSON-encoded value.

function stubWebStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  });
  return store;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('zustand settings boot rehydration', () => {
  it('rehydrates the wrapper-only keys from persisted localStorage at boot', async () => {
    const storage = stubWebStorage();
    storage.set('forge_setting_agentWorktrees', JSON.stringify(false));
    storage.set('forge_setting_autoStageAgentChanges', JSON.stringify(true));
    storage.set('forge_setting_agentBrowserTools', JSON.stringify(true));

    const { useSettingsStore } = await import('./settings');
    const s = useSettingsStore.getState();
    expect(s.agentWorktrees).toBe(false);
    expect(s.autoStageAgentChanges).toBe(true);
    expect(s.agentBrowserTools).toBe(true);
  });

  it('falls back to the same defaults as stores/settings.ts when nothing is persisted', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    const s = useSettingsStore.getState();
    expect(s.agentWorktrees).toBe(true);
    expect(s.autoStageAgentChanges).toBe(false);
    expect(s.agentBrowserTools).toBe(false);
  });

  it('round-trips a toggle through __set into persisted storage', async () => {
    stubWebStorage();

    const { useSettingsStore } = await import('./settings');
    useSettingsStore.getState().__set('agentWorktrees', false);

    const s = useSettingsStore.getState();
    expect(s.agentWorktrees).toBe(false);
    expect(globalThis.localStorage.getItem('forge_setting_agentWorktrees')).toBe('false');
  });
});
