import { invoke } from '@tauri-apps/api/core';
import { writable, get } from '$lib/stores/storeCompat';
import { syncCustomProviderDefs, type CustomProviderId } from '$lib/stores/settings';
import { providerApiKeyExists } from '$lib/services/ai-keychain';
import { setCustomMediaLabels } from '$lib/services/media-generation';

/**
 * User-added OpenAI-compatible providers. The backend owns the record (name,
 * base URL) and the key (`commands/custom_providers.rs`); this store mirrors
 * the list so every provider picker can show them, and caches their icons.
 */
export interface CustomProvider {
  id: CustomProviderId;
  name: string;
  baseUrl: string;
}

export const customProviders = writable<CustomProvider[]>([]);

/** Favicons fetched by the backend, as `data:` URLs; `null` = the site has none. */
export const customProviderIcons = writable<Record<string, string | null>>({});

function publish(list: CustomProvider[]): void {
  syncCustomProviderDefs(list);
  setCustomMediaLabels(Object.fromEntries(list.map((p) => [p.id, p.name])));
  customProviders.set(list);
  for (const provider of list) {
    void loadIcon(provider.id);
    // Seed the key-presence cache: readiness checks (dictation, chat) read it
    // synchronously, and it only preloads the built-in providers.
    void providerApiKeyExists(provider.id, { fresh: true });
  }
}

export async function loadCustomProviders(): Promise<CustomProvider[]> {
  try {
    const list = await invoke<CustomProvider[]>('custom_providers_list');
    publish(list);
    return list;
  } catch (err) {
    console.warn('Could not load custom providers:', err);
    return get(customProviders);
  }
}

/** Add a provider (no `id`) or edit one. `apiKey` omitted keeps the saved key. */
export async function saveCustomProvider(input: {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<CustomProvider> {
  const saved = await invoke<CustomProvider>('custom_provider_save', {
    id: input.id ?? null,
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey?.trim() ? input.apiKey : null,
  });
  // A changed address may mean a different site, so its icon is re-fetched.
  customProviderIcons.update((icons) => {
    const next = { ...icons };
    delete next[saved.id];
    return next;
  });
  await loadCustomProviders();
  return saved;
}

export async function deleteCustomProvider(id: string): Promise<void> {
  await invoke('custom_provider_delete', { id });
  await loadCustomProviders();
}

async function loadIcon(id: string): Promise<void> {
  if (id in get(customProviderIcons)) return;
  // Mark as pending so a burst of renders asks once.
  customProviderIcons.update((icons) => ({ ...icons, [id]: null }));
  try {
    const icon = await invoke<string | null>('custom_provider_icon', { id });
    if (icon && icon.startsWith('data:image/')) {
      customProviderIcons.update((icons) => ({ ...icons, [id]: icon }));
    }
  } catch {
    /* no icon: the letter mark stays */
  }
}

/**
 * Built-in providers recognised by their API host, so a custom entry that
 * points at a known service wears that service's bundled mark.
 */
const KNOWN_HOSTS: [RegExp, string][] = [
  [/(^|\.)openai\.com$/, 'openai'],
  [/(^|\.)openrouter\.ai$/, 'openrouter'],
  [/(^|\.)anthropic\.com$/, 'anthropic'],
  [/(^|\.)googleapis\.com$/, 'google'],
  [/(^|\.)x\.ai$/, 'xai'],
  [/(^|\.)groq\.com$/, 'groq'],
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)mistral\.ai$/, 'mistral'],
  [/(^|\.)together\.(ai|xyz)$/, 'together'],
  [/(^|\.)fireworks\.ai$/, 'fireworks'],
  [/(^|\.)cerebras\.ai$/, 'cerebras'],
  [/(^|\.)nvidia\.com$/, 'nvidia'],
  [/(^|\.)moonshot\.(ai|cn)$/, 'moonshot'],
  [/(^|\.)sambanova\.ai$/, 'sambanova'],
  [/(^|\.)perplexity\.ai$/, 'perplexity'],
  [/(^|\.)cohere\.(ai|com)$/, 'cohere'],
  [/(^|\.)vercel\.sh$/, 'vercel'],
  [/(^|\.)kilo\.ai$/, 'kilocode'],
  [/(^|\.)opencode\.ai$/, 'opencode'],
];

export function knownProviderForUrl(baseUrl: string): string | null {
  let host = '';
  let port = '';
  try {
    const url = new URL(baseUrl);
    host = url.hostname.toLowerCase();
    port = url.port;
  } catch {
    return null;
  }
  if (host === 'localhost' || host === '127.0.0.1') {
    if (port === '11434') return 'ollama';
    if (port === '1234') return 'lmstudio';
    return null;
  }
  return KNOWN_HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? null;
}
