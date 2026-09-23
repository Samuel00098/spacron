import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerApiKeyExists = vi.hoisted(() => vi.fn());
const listProviderModels = vi.hoisted(() => vi.fn());
const getProviderBaseUrl = vi.hoisted(() => vi.fn((provider: string) => {
  if (provider === 'ollama') return 'http://localhost:11434/v1';
  if (provider === 'lmstudio') return 'http://localhost:1234/v1';
  return '';
}));

vi.mock('$lib/services/ai-keychain', () => ({
  providerApiKeyExists,
  listProviderModels,
}));

vi.mock('$lib/stores/settings', () => ({
  aiProviders: [
    { id: 'openrouter', label: 'OpenRouter', local: false },
    { id: 'groq', label: 'Groq', local: false },
    { id: 'ollama', label: 'Ollama', local: true },
    { id: 'lmstudio', label: 'LM Studio', local: true },
  ],
  getProviderBaseUrl,
  providerSetupHint: (id: string) => `Add the ${id} API key in Settings → AI Connections.`,
}));

import { detectAgentAccess, getAgentAccessBlockedMessage } from './agent-access';

describe('detectAgentAccess', () => {
  beforeEach(() => {
    providerApiKeyExists.mockReset().mockResolvedValue(false);
    listProviderModels.mockReset().mockResolvedValue([]);
    getProviderBaseUrl.mockClear();
  });

  it('unlocks access when any remote provider has an API key', async () => {
    providerApiKeyExists.mockImplementation(async (provider: string) => provider === 'groq');

    await expect(detectAgentAccess()).resolves.toMatchObject({
      ready: true,
      via: 'api-key',
      providerId: 'groq',
      message: 'Groq API key is configured.',
    });
    expect(listProviderModels).not.toHaveBeenCalled();
  });

  it('unlocks access when a local provider has a detected model', async () => {
    listProviderModels.mockImplementation(async (provider: string) => (
      provider === 'ollama' ? [{ id: 'qwen2.5-coder' }] : []
    ));

    await expect(detectAgentAccess()).resolves.toMatchObject({
      ready: true,
      via: 'local-model',
      providerId: 'ollama',
    });
  });

  it('stays blocked when neither an API key nor a local model is available', async () => {
    await expect(detectAgentAccess()).resolves.toEqual({
      ready: false,
      via: 'none',
      providerId: null,
      message: getAgentAccessBlockedMessage(),
    });
  });

  it('does not unlock Chat for a local catalogue containing only unsupported models', async () => {
    listProviderModels.mockResolvedValue([{ id: 'unsupported', supported: false }]);
    await expect(detectAgentAccess({ preferredProvider: 'ollama' })).resolves.toMatchObject({ ready: false });
    expect(listProviderModels).toHaveBeenCalledWith('ollama', 'chat');
  });

  it('continues to a usable local provider after an unsupported catalogue', async () => {
    listProviderModels.mockImplementation(async (provider: string) => (
      provider === 'ollama'
        ? [{ id: 'unsupported', supported: false }]
        : [{ id: 'chat-model', supported: true }]
    ));
    await expect(detectAgentAccess()).resolves.toMatchObject({ ready: true, providerId: 'lmstudio' });
  });

  it('does not unlock Chat through a different provider when Composer selected one', async () => {
    providerApiKeyExists.mockImplementation(async (provider: string) => provider === 'groq');

    await expect(detectAgentAccess({ preferredProvider: 'openrouter' })).resolves.toEqual({
      ready: false,
      via: 'none',
      providerId: null,
      // The per-provider setup hint (a free Kilo account, a ChatGPT sign-in, a
      // key) is what the message carries now — see `providerSetupHint`.
      message: 'OpenRouter is not connected. Add the openrouter API key in Settings → AI Connections. Then retry.',
    });
    expect(providerApiKeyExists).toHaveBeenCalledTimes(1);
    expect(providerApiKeyExists).toHaveBeenCalledWith('openrouter', undefined);
  });
});
