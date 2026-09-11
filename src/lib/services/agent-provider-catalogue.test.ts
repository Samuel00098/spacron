import { describe, expect, it } from 'vitest';
import {
  getAgentProviderCapabilities,
  isChatAgentProvider,
  mergeAgentProviderModels,
} from './agent-provider-catalogue';

describe('agent provider catalogue', () => {
  it('treats supported agent aliases as providers, not API model providers', () => {
    expect(isChatAgentProvider('codex')).toBe(true);
    expect(isChatAgentProvider('cursor-agent')).toBe(true);
    expect(isChatAgentProvider('openrouter')).toBe(false);
    expect(isChatAgentProvider('npm run dev')).toBe(false);
  });

  it('exposes provider-native model choices and preserves live capability ids', () => {
    const codex = getAgentProviderCapabilities('codex');
    expect(codex.models.map((model) => model.id)).toContain('gpt-5.3-codex');

    expect(mergeAgentProviderModels('codex', [
      { id: 'vendor/new-model', label: 'New model', description: 'Reported by the agent.' },
    ])).toEqual([
      { id: 'vendor/new-model', label: 'New model', description: 'Reported by the agent.', free: undefined },
    ]);
  });
});
