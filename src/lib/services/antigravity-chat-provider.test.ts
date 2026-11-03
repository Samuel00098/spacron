import { describe, expect, it } from 'vitest';
import { getAgentProviderCapabilities, getAgentProviderLaunchOptions, isChatAgentProvider } from './chat-provider-adapters';

describe('Antigravity chat provider', () => {
  it('is selectable in Chat without inventing CLI flags', () => {
    expect(isChatAgentProvider('agy')).toBe(true);
    expect(isChatAgentProvider('/usr/local/bin/agy')).toBe(true);
    const capabilities = getAgentProviderCapabilities('agy');
    expect(capabilities.label).toBe('Antigravity');
    expect(capabilities.supportsChat).toBe(true);
    expect(capabilities.models.map((model) => model.id)).toEqual(['default']);
    expect(getAgentProviderLaunchOptions('agy', { accessMode: 'full-access', model: 'default' }))
      .toEqual({ permissionArgs: '', runtimeArgs: '' });
  });
});
