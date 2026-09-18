import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { initApiKeyCache, listProviderModels, providerApiKeyExists, saveProviderApiKey } from './ai-keychain';

describe('live provider model requests', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'provider_api_key_exists') return true;
      if (command === 'list_provider_models') {
        return [{ id: 'grok-4.1', label: 'Grok 4.1', description: '' }];
      }
      throw new Error(`unexpected command: ${command}`);
    });
  });

  it('asks the backend for Grok chat models instead of using the curated list', async () => {
    const models = await listProviderModels('xai', 'chat');

    expect(models).toEqual([{ id: 'grok-4.1', label: 'Grok 4.1', description: '' }]);
    expect(invoke).toHaveBeenCalledWith('list_provider_models', {
      provider: 'xai',
      apiKey: '',
      purpose: 'chat',
    });
  });

  it('preserves live model capability metadata for the picker', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'provider_api_key_exists') return true;
      if (command === 'list_provider_models') {
        return [{
          id: 'gpt-5.6-sol',
          label: 'gpt-5.6-sol',
          description: '',
          supported: false,
          supportReason: 'This model uses an OpenCode protocol that Spacron does not support yet.',
        }];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(listProviderModels('opencode', 'chat')).resolves.toMatchObject([
      { id: 'gpt-5.6-sol', supported: false, supportReason: expect.any(String) },
    ]);
  });

  it('does not let an in-flight startup scan overwrite a newly saved key', async () => {
    let releaseOpenAiCheck: (() => void) | undefined;
    let openAiCheckStarted = false;
    const openAiCheck = new Promise<boolean>((resolve) => {
      releaseOpenAiCheck = () => resolve(false);
    });
    invoke.mockImplementation(async (command: string, args?: { provider?: string }) => {
      if (command === 'provider_api_key_exists' && args?.provider === 'openai') {
        openAiCheckStarted = true;
        return openAiCheck;
      }
      if (command === 'provider_api_key_exists') return false;
      if (command === 'provider_api_key_set') return undefined;
      throw new Error(`unexpected command: ${command}`);
    });

    const startup = initApiKeyCache();
    while (!openAiCheckStarted) await Promise.resolve();

    await saveProviderApiKey('openai', 'sk-test');
    releaseOpenAiCheck!();
    await startup;

    expect(await providerApiKeyExists('openai')).toBe(true);
  });
});
