/**
 * What each chat model can do — vision, reasoning, tools — as Rust learned it
 * from the providers' own model lists (src-tauri/src/commands/secrets/
 * agent_turn/capabilities.rs). Rust refreshes those lists in the background:
 * at startup, and whenever an API key is saved. This module caches the answers
 * per provider for the picker's icons and the reasoning menu, and drops a
 * provider's answers when Rust says its list changed.
 *
 * Deliberately a leaf: `reasoning-levels.ts` reads it, so it must not import
 * anything that imports that.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writable } from '$lib/stores/storeCompat';

export interface ModelCaps {
  /** Rust's `accepts_images`: the same answer the chat's requests use. */
  vision: boolean;
  /** Whether the provider's list says the model reasons; null = it did not say. */
  reasoning: boolean | null;
  /** Whether the list says a reasoning amount can be requested; null = not said. */
  reasoningEffort: boolean | null;
  tools: boolean | null;
}

const cache = new Map<string, Map<string, ModelCaps>>();
const pending = new Map<string, Promise<void>>();
const baseUrls = new Map<string, string | null>();

/** Bumped whenever answers arrive or are dropped; components subscribe to redraw. */
export const modelCapabilitiesVersion = writable(0);
const bump = () => modelCapabilitiesVersion.update((n) => n + 1);

export function capsFor(provider: string, model: string): ModelCaps | null {
  return cache.get(provider)?.get(model) ?? null;
}

/**
 * Ask Rust about every model in `models` that has no answer yet, in one call.
 * `baseUrl` follows the chat's own rule (only local providers send one), so
 * both read the same catalogue entry.
 */
export function loadModelCaps(provider: string, models: string[], baseUrl: string | null = null): Promise<void> {
  baseUrls.set(provider, baseUrl);
  const known = cache.get(provider);
  const missing = [...new Set(models)].filter((m) => m && !known?.has(m));
  if (!missing.length) return Promise.resolve();
  const key = `${provider}\u0000${missing.join('\u0000')}`;
  const running = pending.get(key);
  if (running) return running;
  const job = invoke<Record<string, ModelCaps>>('ai_models_capabilities', { provider, models: missing, baseUrl })
    .then((answers) => {
      const map = cache.get(provider) ?? new Map<string, ModelCaps>();
      for (const [model, caps] of Object.entries(answers ?? {})) {
        map.set(model, {
          vision: caps?.vision === true,
          reasoning: typeof caps?.reasoning === 'boolean' ? caps.reasoning : null,
          reasoningEffort: typeof caps?.reasoningEffort === 'boolean' ? caps.reasoningEffort : null,
          tools: typeof caps?.tools === 'boolean' ? caps.tools : null,
        });
      }
      cache.set(provider, map);
      bump();
    })
    .catch(() => undefined)
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** Drop a provider's answers (or all) so the next look asks Rust again. */
export function forgetModelCaps(provider?: string): void {
  if (provider) cache.delete(provider);
  else cache.clear();
  bump();
}

let initialized = false;

/** Listen for Rust's background refreshes. Called once at app start. */
export function initModelCapabilities(): void {
  if (initialized) return;
  initialized = true;
  listen<{ provider?: string }>('model-capabilities-updated', (event) => {
    forgetModelCaps(event.payload?.provider);
  }).catch(() => undefined);
}

/** Refresh one provider's model list now (e.g. right after signing in). */
export async function refreshModelCapabilities(provider?: string): Promise<void> {
  await invoke('ai_refresh_model_capabilities', { provider: provider ?? null }).catch(() => undefined);
  forgetModelCaps(provider);
}
