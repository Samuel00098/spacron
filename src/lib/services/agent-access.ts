import { aiProviders, getProviderBaseUrl, type AiProviderId } from '$lib/stores/settings';
import { listProviderModels, providerApiKeyExists } from '$lib/services/ai-keychain';

export interface AgentAccessStatus {
  ready: boolean;
  via: 'api-key' | 'local-model' | 'none';
  providerId: AiProviderId | null;
  message: string;
}

const BLOCKED_MESSAGE = 'To access the agent, add an API key or load a local model into the application.';

export interface AgentAccessOptions {
  fresh?: boolean;
  /** When set, verify this Composer-selected connection rather than another provider. */
  preferredProvider?: AiProviderId;
}

export async function detectAgentAccess(options?: AgentAccessOptions): Promise<AgentAccessStatus> {
  const selectedProvider = options?.preferredProvider
    ? aiProviders.find((provider) => provider.id === options.preferredProvider)
    : undefined;
  const providersToCheck = selectedProvider ? [selectedProvider] : aiProviders;
  const keyCheckOptions = options?.fresh === undefined ? undefined : { fresh: options.fresh };
  const remoteProviders = providersToCheck
    .filter((provider) => !provider.local)
    .sort((left, right) => Number(right.id === options?.preferredProvider) - Number(left.id === options?.preferredProvider));
  const localProviders = providersToCheck.filter((provider) => provider.local);

  const remoteResults = await Promise.all(
    remoteProviders.map(async (provider) => {
      try {
        return (await providerApiKeyExists(provider.id, keyCheckOptions)) ? provider : null;
      } catch {
        return null;
      }
    })
  );

  const remoteMatch = remoteResults.find(Boolean);
  if (remoteMatch) {
    return {
      ready: true,
      via: 'api-key',
      providerId: remoteMatch.id,
      message: `${remoteMatch.label} is ready.`,
    };
  }

  for (const provider of localProviders) {
    try {
      const baseUrl = getProviderBaseUrl(provider.id);
      if (!baseUrl) continue;
      const models = await listProviderModels(provider.id);
      if (models.length > 0) {
        return {
          ready: true,
          via: 'local-model',
          providerId: provider.id,
          message: `${provider.label} has a local model loaded.`,
        };
      }
    } catch {
      // Local servers may be offline or empty; keep checking the remaining options.
    }
  }

  return {
    ready: false,
    via: 'none',
    providerId: null,
    message: selectedProvider && !selectedProvider.local
      ? `${selectedProvider.label} is not connected. Add the ${selectedProvider.keyLabel || `${selectedProvider.label} API key`} in Settings, then retry.`
      : BLOCKED_MESSAGE,
  };
}

export function getAgentAccessBlockedMessage(): string {
  return BLOCKED_MESSAGE;
}
