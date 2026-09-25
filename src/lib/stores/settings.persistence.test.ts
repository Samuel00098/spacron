import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// A setting exported from stores/settings.ts via `persistentWritable` is saved
// on every change, but at boot it only reads back what the zustand store
// declares in `createSettingsState`. An undeclared key reads `undefined`, falls
// back to its default, and silently resets on every restart. The voice engine
// and computer-use settings both shipped that way. This test fails instead.

const source = readFileSync('src/lib/stores/settings.ts', 'utf8');
const keys = [...source.matchAll(/=\s*persistentWritable\b[^(]*\(\s*'(\w+)'/g)].map((m) => m[1]);

describe('persisted settings', () => {
  it('finds every persistentWritable call in stores/settings.ts', () => {
    // Guards the regex itself: if a call shape stops matching, the check
    // below would pass without looking at it.
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBe(source.match(/=\s*persistentWritable\b/g)?.length);
  });

  it('declares every persistentWritable key in the zustand settings store', async () => {
    const g = globalThis as any;
    const previousWindow = g.window;
    const previousLocalStorage = g.localStorage;
    g.window = g;
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    try {
      vi.resetModules();
      const { useSettingsStore } = await import('./zustand/settings');
      const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
      const undeclared = keys.filter((key) => state[key] === undefined);
      expect(undeclared, 'add these to createSettingsState and defaults in stores/zustand/settings.ts').toEqual([]);
    } finally {
      if (previousWindow === undefined) delete g.window;
      else g.window = previousWindow;
      if (previousLocalStorage === undefined) delete g.localStorage;
      else g.localStorage = previousLocalStorage;
    }
  });
});
