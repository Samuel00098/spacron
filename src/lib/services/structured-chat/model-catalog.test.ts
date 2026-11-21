import { beforeEach, describe, expect, it } from 'vitest';
import type { StructuredChatState, StructuredModel } from './provider';
import {
  __resetModelCatalogForTests,
  cachedModelCatalog,
  modelCatalogNote,
  modelCatalogStatus,
  rememberModelCatalog,
  selectedModelIssue,
} from './model-catalog';

const model = (id: string, efforts: string[] = ['low', 'high']): StructuredModel => ({ id, label: id, description: null, efforts, defaultEffort: null, isDefault: false });

function state(patch: Partial<StructuredChatState>): StructuredChatState {
  return { status: 'ready', error: null, items: [], models: [], model: null, effort: null, access: 'ask', threadId: null, approvals: [], subagents: [], contextUsed: null, contextWindow: null, ...patch };
}

describe('model catalog status', () => {
  beforeEach(() => __resetModelCatalogForTests());

  it('tells loading, loaded, empty and failed apart', () => {
    expect(modelCatalogStatus('codex', null).kind).toBe('loading');
    expect(modelCatalogStatus('codex', state({ status: 'starting' })).kind).toBe('loading');
    expect(modelCatalogStatus('codex', state({ models: [model('a')] })).kind).toBe('loaded');
    expect(modelCatalogStatus('codex', state({})).kind).toBe('empty');
    expect(modelCatalogStatus('codex', state({ status: 'failed', error: 'auth' }))).toEqual({ kind: 'failed', error: 'auth' });
  });

  it('never saves an empty list, and falls back to the last good one on failure', () => {
    rememberModelCatalog('codex', []);
    expect(cachedModelCatalog('codex')).toBeNull();
    rememberModelCatalog('codex', [model('a')]);
    const status = modelCatalogStatus('codex', state({ status: 'failed', error: 'offline' }));
    expect(status.kind).toBe('cached');
    expect(modelCatalogNote('Codex', status, null)).toContain('last list');
  });

  it('flags a model the account does not offer and an unsupported effort', () => {
    const status = modelCatalogStatus('codex', state({ models: [model('a', ['low'])] }));
    expect(selectedModelIssue(status, 'b', null)).toBe('unavailable');
    expect(selectedModelIssue(status, 'a', 'high')).toBe('effort-unsupported');
    expect(selectedModelIssue(status, 'a', 'low')).toBeNull();
  });
});
