/**
 * Live model catalog states for structured chats.
 *
 * Every provider fills `StructuredChatState.models` from its own live source
 * (ACP session config, Codex `model/list`, Claude initialize, Pi RPC state).
 * An empty array alone can't tell "not loaded yet" from "loaded and empty" or
 * "the request failed", so this classifies it, and keeps the last good list
 * per provider so a failed start never shows (or saves) an empty catalog as
 * if it were the real one.
 */
import type { StructuredChatState, StructuredModel } from './provider';

export type ModelCatalogStatus =
  | { kind: 'loading' }
  | { kind: 'loaded'; models: StructuredModel[] }
  | { kind: 'empty' }
  | { kind: 'failed'; error: string }
  /** The live request failed; the list is the last good one, for display only. */
  | { kind: 'cached'; models: StructuredModel[]; error: string };

const STORAGE_KEY = 'spacron_structured_model_catalogs';
const memory = new Map<string, StructuredModel[]>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) as Record<string, StructuredModel[]> : {};
    for (const [agent, models] of Object.entries(parsed)) {
      if (Array.isArray(models) && models.length) memory.set(agent, models);
    }
  } catch {
    // No saved catalogs.
  }
}

function save(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // Restricted storage: the cache lasts for this run.
  }
}

/** Remember a successfully loaded, non-empty catalog. Empty lists are never saved. */
export function rememberModelCatalog(agent: string, models: readonly StructuredModel[]): void {
  load();
  if (!models.length) return;
  const prev = memory.get(agent);
  if (prev && prev.length === models.length && prev.every((m, i) => m.id === models[i].id && m.efforts.join() === models[i].efforts.join())) return;
  memory.set(agent, models.slice());
  save();
}

export function cachedModelCatalog(agent: string): StructuredModel[] | null {
  load();
  return memory.get(agent) ?? null;
}

export function modelCatalogStatus(agent: string, state: StructuredChatState | null): ModelCatalogStatus {
  if (!state || state.status === 'starting') return { kind: 'loading' };
  if (state.models.length) return { kind: 'loaded', models: state.models };
  if (state.status === 'failed' || state.status === 'closed') {
    const error = state.error ?? 'The model list could not be loaded.';
    const cached = cachedModelCatalog(agent);
    return cached ? { kind: 'cached', models: cached, error } : { kind: 'failed', error };
  }
  return { kind: 'empty' };
}

export type ModelIssue = 'unavailable' | 'effort-unsupported' | null;

/** Whether the selected model and effort are valid against a loaded catalog. */
export function selectedModelIssue(status: ModelCatalogStatus, model: string | null, effort: string | null): ModelIssue {
  if (status.kind !== 'loaded' || !model) return null;
  const entry = status.models.find((candidate) => candidate.id === model);
  if (!entry) return 'unavailable';
  if (effort && entry.efforts.length && !entry.efforts.includes(effort)) return 'effort-unsupported';
  return null;
}

/** One line for the model picker's tooltip. */
export function modelCatalogNote(agentLabel: string, status: ModelCatalogStatus, issue: ModelIssue): string | null {
  switch (status.kind) {
    case 'loading': return `Loading ${agentLabel}'s models…`;
    case 'empty': return `${agentLabel} reported no models for this account`;
    case 'failed': return `Couldn't load ${agentLabel}'s models: ${status.error}`;
    case 'cached': return `Couldn't load ${agentLabel}'s models (${status.error}). Showing the last list it reported.`;
    case 'loaded':
      if (issue === 'unavailable') return `The selected model isn't offered by ${agentLabel} for this account`;
      if (issue === 'effort-unsupported') return 'The selected reasoning level is not supported by this model';
      return null;
  }
}

/** For tests. */
export function __resetModelCatalogForTests(): void {
  memory.clear();
  loaded = true;
}
