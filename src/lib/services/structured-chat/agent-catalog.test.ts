import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  installed: new Set<string>(['codex', 'claude']),
  detected: true,
  favourites: [] as string[],
  structuredCatalogs: {} as Record<string, any[]>,
  liveModels: {} as Record<string, any[]>,
}));

vi.mock('$lib/stores/usage', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return {
    usageState: writable({ detected: [], lastFetchedAt: 1 }),
    installedAgentCommands: () => h.installed,
    haveAgentDetection: () => h.detected,
  };
});

vi.mock('$lib/stores/agentFavourites', async () => {
  const { writable } = await import('$lib/stores/storeCompat');
  return {
    favouriteAgentCommands: writable(h.favourites),
  };
});

vi.mock('./model-catalog', () => ({
  cachedModelCatalog: (agent: string) => h.structuredCatalogs[agent] ?? null,
}));

vi.mock('$lib/services/live-agent-models', () => ({
  peekLiveAgentProviderModels: (cmd: string) => h.liveModels[cmd] ?? null,
  loadLiveAgentProviderModels: vi.fn(async (cmd: string) => h.liveModels[cmd] ?? []),
  freshLiveAgentProviderModels: vi.fn(async (cmd: string) => h.liveModels[cmd] ?? []),
}));

import {
  getStructuredAgentEntries,
  pickDefaultStructuredAgent,
  resolveStructuredAgentModels,
  STRUCTURED_AGENT_DEFS,
} from './agent-catalog';

describe('agent-catalog', () => {
  beforeEach(() => {
    h.installed = new Set(['codex', 'claude']);
    h.detected = true;
    h.favourites = [];
    h.structuredCatalogs = {};
    h.liveModels = {};
  });

  it('lists all 11 structured agents and sorts installed agents first with favourites pinned', () => {
    const entries = getStructuredAgentEntries({
      installedCommands: new Set(['codex', 'opencode']),
      detected: true,
      favourites: ['opencode'],
    });
    expect(entries).toHaveLength(STRUCTURED_AGENT_DEFS.length);
    expect(entries[0]).toMatchObject({ agent: 'opencode', installed: true });
    expect(entries[1]).toMatchObject({ agent: 'codex', installed: true });
    const claudeEntry = entries.find((e) => e.agent === 'claude')!;
    expect(claudeEntry.installed).toBe(false);
    expect(claudeEntry.installDocs.url).toContain('claude.com');
  });

  it('picks preferred installed agent via pickDefaultStructuredAgent', () => {
    expect(pickDefaultStructuredAgent()).toBe('codex');
  });

  it('resolves models in priority order: live > cached > CLI probe > Claude fallback and enriches efforts', () => {
    // 1. Live state wins
    const live = resolveStructuredAgentModels('codex', {
      status: 'ready',
      models: [{ id: 'gpt-live', label: 'Live GPT', description: null, efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }],
    } as any);
    expect(live[0]).toMatchObject({ id: 'gpt-live', reasoningEfforts: ['low', 'high'] });

    // 2. Cached structured catalog
    h.structuredCatalogs.codex = [{ id: 'gpt-cached', label: 'Cached', description: null, efforts: ['medium', 'high'], defaultEffort: 'medium' }];
    expect(resolveStructuredAgentModels('codex')[0].id).toBe('gpt-cached');

    // 3. Live CLI probe peek + reasoningLevelsFor enrichment when efforts are omitted
    delete h.structuredCatalogs.codex;
    h.liveModels.codex = [{ id: 'gpt-5', label: 'GPT-5' }];
    const peeked = resolveStructuredAgentModels('codex');
    expect(peeked[0].id).toBe('gpt-5');
    expect(peeked[0].reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);

    // 4. Claude alias fallback
    const claudeFallback = resolveStructuredAgentModels('claude');
    expect(claudeFallback.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
  });
});
