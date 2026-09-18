import { invoke } from '@tauri-apps/api/core';
import { isLocalProvider, getProviderBaseUrl, type AiProviderId } from '$lib/stores/settings';

const KNOWN_PROVIDERS: AiProviderId[] = [
  'openrouter', 'anthropic', 'openai', 'google', 'groq', 'xai',
  'deepseek', 'mistral', 'together', 'fireworks', 'cerebras', 'nvidia',
  'moonshot', 'sambanova', 'perplexity', 'cohere', 'opencode', 'opencode-go', 'ollama', 'lmstudio',
];

// In-memory key-existence cache backed by the OS keychain.
// The frontend deliberately never reads or stores full provider keys.
const keyExistsCache = new Map<AiProviderId, boolean>();
// A save/clear can happen while the startup scan is awaiting the OS keychain.
// Version writes so that an older scan result cannot overwrite a newer user
// choice when it resumes.
const keyCacheMutationVersion = new Map<AiProviderId, number>();
let cacheReady = false;
let cacheInitialization: Promise<void> | null = null;

function keyMutationVersion(provider: AiProviderId): number {
  const next = (keyCacheMutationVersion.get(provider) ?? 0) + 1;
  keyCacheMutationVersion.set(provider, next);
  return next;
}

/**
 * Call once at app startup. Migrates any leftover localStorage keys to the OS
 * keychain, then populates the in-memory existence cache from the keychain.
 */
export function initApiKeyCache(): Promise<void> {
  if (cacheInitialization) return cacheInitialization;
  cacheInitialization = initializeApiKeyCache().catch((error) => {
    // Permit a later app call to retry if the startup migration or scan failed
    // before it could establish a usable cache.
    cacheInitialization = null;
    throw error;
  });
  return cacheInitialization;
}

async function initializeApiKeyCache(): Promise<void> {
  await migrateLocalStorageToKeychain();

  for (const provider of KNOWN_PROVIDERS) {
    const versionAtStart = keyCacheMutationVersion.get(provider) ?? 0;
    try {
      const exists = await invoke<boolean>('provider_api_key_exists', { provider });
      if ((keyCacheMutationVersion.get(provider) ?? 0) === versionAtStart) {
        keyExistsCache.set(provider, exists);
      }
    } catch (err) {
      // Don't poison the cache with null on error — leave this provider out so
      // providerApiKeyExists() falls back to a live keychain query instead of
      // returning false from a stale cache entry.
      console.error(`[keychain] Failed to read key for ${provider} at startup:`, err);
    }
  }

  cacheReady = true;
}

async function migrateLocalStorageToKeychain(): Promise<void> {
  if (typeof localStorage === 'undefined') return;

  // Handle the legacy OpenRouter key name from before multi-provider support.
  const LEGACY_OPENROUTER_KEY = 'forge_openrouter_api_key';
  const legacyOrKey = localStorage.getItem(LEGACY_OPENROUTER_KEY);
  if (legacyOrKey && legacyOrKey.trim()) {
    localStorage.setItem('spacron_openrouter_api_key', legacyOrKey.trim());
    localStorage.removeItem(LEGACY_OPENROUTER_KEY);
  }

  for (const provider of KNOWN_PROVIDERS) {
    const lsKey = `spacron_${provider}_api_key`;
    const value = localStorage.getItem(lsKey);
    if (!value || !value.trim()) continue;
    try {
      await invoke('provider_api_key_set', { provider, apiKey: value.trim() });
      localStorage.removeItem(lsKey);
    } catch {
      // Migration failed for this provider — leave it in localStorage and retry next launch.
    }
  }
}

async function safeInvoke<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, payload);
  } catch (error) {
    console.warn(`Keychain command failed: ${command}`, error);
    throw error;
  }
}

/** Synchronous read from the in-memory existence cache. */
export function isProviderApiKeyConfiguredLocal(provider: AiProviderId): boolean {
  return keyExistsCache.get(provider) ?? false;
}

/** Options for checking a provider connection. */
export interface ProviderApiKeyExistsOptions {
  /** Bypass a cached answer, while still waiting for startup migration first. */
  fresh?: boolean;
}

/** True if a key exists in the cache (or the keychain if the cache is not yet ready). */
export async function providerApiKeyExists(
  provider: AiProviderId,
  options: ProviderApiKeyExistsOptions = {},
): Promise<boolean> {
  // App startup starts this asynchronously. A first Chat turn must not query
  // the keychain before legacy localStorage migration has finished.
  if (!cacheReady && cacheInitialization) {
    try {
      await cacheInitialization;
    } catch {
      // The live lookup below still gives the caller the best available answer.
    }
  }

  // Use the cache only if it's ready AND this provider was successfully loaded into it.
  // Providers that errored during initApiKeyCache are absent from the map (not set to null),
  // so we fall through to a live keychain query for them.
  if (!options.fresh && cacheReady && keyExistsCache.has(provider)) return !!keyExistsCache.get(provider);
  const versionAtStart = keyCacheMutationVersion.get(provider) ?? 0;
  try {
    const exists = await safeInvoke<boolean>('provider_api_key_exists', { provider });
    if ((keyCacheMutationVersion.get(provider) ?? 0) !== versionAtStart) {
      return keyExistsCache.get(provider) ?? exists;
    }
    keyExistsCache.set(provider, exists);
    return exists;
  } catch {
    return false;
  }
}

/** Persist to the OS keychain and update the cache. */
export async function saveProviderApiKey(provider: AiProviderId, apiKey: string): Promise<void> {
  const normalized = apiKey.trim();
  if (!normalized) {
    await clearProviderApiKey(provider);
    return;
  }
  keyMutationVersion(provider);
  await safeInvoke('provider_api_key_set', { provider, apiKey: normalized });
  keyExistsCache.set(provider, true);
}

/** Remove from the OS keychain and update the cache. */
export async function clearProviderApiKey(provider: AiProviderId): Promise<void> {
  keyMutationVersion(provider);
  await safeInvoke('provider_api_key_delete', { provider });
  keyExistsCache.set(provider, false);
}

/** A model offered by a provider, as returned by the backend list command. */
export interface ProviderModelInfo {
  id: string;
  label: string;
  description: string;
  /** False means the provider exposed the model, but this adapter cannot run it yet. */
  supported?: boolean;
  supportReason?: string;
}

/**
 * Ask the backend to fetch the live model catalogue for a provider using its
 * stored key. Optionally filter by purpose ("chat", "stt", "realtime")
 * so the picker shows only usable options. Throws if no key is configured or
 * the provider rejects the call.
 */
export async function listProviderModels(provider: AiProviderId, purpose?: 'chat' | 'stt' | 'realtime'): Promise<ProviderModelInfo[]> {
  if (isLocalProvider(provider)) {
    const baseUrl = getProviderBaseUrl(provider);
    if (!baseUrl) throw new Error('No server URL configured for this provider.');
    return await safeInvoke<ProviderModelInfo[]>('list_provider_models', { provider, apiKey: '', baseUrl, purpose });
  }
  if (!(await providerApiKeyExists(provider))) throw new Error('No API key configured for this provider.');
  return await safeInvoke<ProviderModelInfo[]>('list_provider_models', { provider, apiKey: '', purpose });
}
