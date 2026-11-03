import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ACP registry settings', () => {
  it('declares a command ACP by hand, normalized, and removes it again', async () => {
    const store = await import('./acpRegistry');
    expect(store.isAcpExplicit('agy')).toBe(false);
    store.setAcpExplicit('  AGY  ', true);
    expect(store.getExplicitAcpCommands()).toEqual(['agy']);
    expect(store.isAcpExplicit('Agy')).toBe(true);
    store.setAcpExplicit('agy', false);
    expect(store.isAcpExplicit('agy')).toBe(false);
  });

  it('persists the declaration with the rest of the ACP settings', async () => {
    const store = await import('./acpRegistry');
    store.setAcpExplicit('claude', true);
    store.setAcpCommandEnabled('claude', false);
    const saved = JSON.parse(values.get('spacron_acp_registry_settings') ?? '{}') as {
      explicitCommands?: string[];
      disabledCommands?: string[];
    };
    expect(saved.explicitCommands).toEqual(['claude']);
    expect(saved.disabledCommands).toEqual(['claude']);
  });

  it('keeps the master switch, per-command enablement and the ACP flag independent', async () => {
    const store = await import('./acpRegistry');
    store.setAcpExplicit('codex', true);
    expect(store.isAcpEnabled('codex')).toBe(true);
    store.setAcpCommandEnabled('codex', false);
    expect(store.isAcpExplicit('codex')).toBe(true);
    expect(store.isAcpEnabled('codex')).toBe(false);
    store.acpRegistryEnabled.set(false);
    expect(store.isAcpEnabled('codex')).toBe(false);
  });
});
