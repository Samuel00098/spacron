import { writable, get } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

const STORAGE_KEY = 'spacron_favourite_models';

/**
 * Models the user pinned in the Chat model picker.
 *
 * T3 keeps favourites per provider; the picker sorts them to the top with a
 * star. Purely presentational: never changes which models exist.
 */

export interface FavouriteModelKey {
  provider: string;
  modelId: string;
}

export function favouriteModelKey(key: FavouriteModelKey): string {
  return `${key.provider.trim().toLowerCase()}:::${key.modelId.trim().toLowerCase()}`;
}

export function parseFavouriteModelKey(key: string): FavouriteModelKey | null {
  const idx = key.indexOf(':::');
  if (idx === -1) return null;
  const provider = key.slice(0, idx);
  const modelId = key.slice(idx + 3);
  return provider && modelId ? { provider, modelId } : null;
}

export const favouriteModels = writable<FavouriteModelKey[]>(
  (() => {
    const stored = loadJson<string[]>(STORAGE_KEY, []);
    if (!Array.isArray(stored)) return [];
    return stored
      .map((key) => parseFavouriteModelKey(key))
      .filter((k): k is FavouriteModelKey => Boolean(k))
      .filter((k, i, arr) => arr.findIndex((other) => other.provider === k.provider && other.modelId === k.modelId) === i);
  })(),
);

favouriteModels.subscribe((models) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(models.map(favouriteModelKey)));
  } catch {}
});

export function isFavouriteModel(provider: string, modelId: string): boolean {
  const key = favouriteModelKey({ provider, modelId });
  return get(favouriteModels).some((entry) => favouriteModelKey(entry) === key);
}

/** Pin or unpin a model; returns whether it is now pinned. */
export function toggleFavouriteModel(provider: string, modelId: string): boolean {
  const key = favouriteModelKey({ provider, modelId });
  const current = get(favouriteModels);
  const next = current.some((entry) => favouriteModelKey(entry) === key)
    ? current.filter((entry) => favouriteModelKey(entry) !== key)
    : [...current, { provider, modelId }];
  favouriteModels.set(next);
  return next.some((entry) => favouriteModelKey(entry) === key);
}

/** Pinned models first (in pin order, grouped by provider), then everything
 *  else in its existing order. Stable across renders. */
export function sortModelsByFavourite<T extends { id: string }>(
  models: readonly T[],
  provider: string,
): T[] {
  const pinned = get(favouriteModels).filter((entry) => entry.provider.trim().toLowerCase() === provider.trim().toLowerCase());
  if (pinned.length === 0) return [...models];
  const rank = (modelId: string): number => {
    const index = pinned.findIndex((entry) => entry.modelId.trim().toLowerCase() === modelId.trim().toLowerCase());
    return index === -1 ? pinned.length : index;
  };
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => rank(a.model.id) - rank(b.model.id) || a.index - b.index)
    .map((entry) => entry.model);
}
