import { describe, expect, it } from 'vitest';
import { getAgentProviderCapabilities, getAgentProviderLaunchOptions, getChatProviderTransport, getNativeChatProviderTransport, isChatAgentProvider } from './chat-provider-adapters';

describe('Antigravity chat provider', () => {
  it('is selectable in Chat without inventing CLI flags', () => {
    expect(isChatAgentProvider('agy')).toBe(true);
    expect(isChatAgentProvider('/usr/local/bin/agy')).toBe(true);
    const capabilities = getAgentProviderCapabilities('agy');
    expect(capabilities.label).toBe('Antigravity');
    expect(capabilities.supportsChat).toBe(true);
    expect(capabilities.transport).toBe('acp-fallback');
    expect(capabilities.models.map((model) => model.id)).toEqual(['default']);
    expect(getAgentProviderLaunchOptions('agy', { accessMode: 'full-access', model: 'default' }))
      .toEqual({ permissionArgs: '', runtimeArgs: '' });
  });

  it('exposes Pi as a provider-native RPC adapter', () => {
    expect(isChatAgentProvider('pi')).toBe(true);
    expect(getChatProviderTransport('pi')).toBe('terminal-fallback');
    expect(getNativeChatProviderTransport('pi')).toBe('pi-rpc');
    expect(getAgentProviderLaunchOptions('pi', { accessMode: 'supervised', model: 'default' }))
      .toEqual({ permissionArgs: '', runtimeArgs: '--mode rpc --no-session' });
  });
});
