import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { runEmbeddedCommand } from '$lib/stores/embeddedRun';
import { getAgentDisplayName } from '$lib/stores/terminal';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import {
  getAgentProviderCapabilities,
  getLiveAgentModelCommand,
  isChatAgentProvider,
  mergeAgentProviderModels,
  parseLiveAgentModels,
  type AgentProviderModel,
} from './agent-provider-catalogue';
import type { ChatReasoningEffort } from '$lib/types/chat';

/**
 * Successful catalogues, per provider and machine. The spawn modal, placement
 * prompt and Chat composer each ask on open, and some CLIs are slow to answer
 * (`opencode models` takes ~15s) — without this every open re-ran the probe.
 * Failures are never cached, so a CLI that was signed out can recover.
 */
const CATALOGUE_TTL_MS = 10 * 60_000;
const catalogueCache = new Map<string, { at: number; models: Promise<AgentProviderModel[]> }>();
/** The settled lists behind `catalogueCache`, readable without awaiting. */
const settledCatalogues = new Map<string, AgentProviderModel[]>();

/**
 * The last list each CLI reported, kept across restarts so a picker opens
 * with that CLI's own models at once while a fresh probe runs behind it. It
 * only ever holds what a CLI returned — never a pre-listed model.
 */
const PERSISTED_KEY = 'spacron.liveAgentModels.v1';

function readPersisted(): Record<string, AgentProviderModel[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PERSISTED_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persist(key: string, models: AgentProviderModel[]): void {
  try {
    localStorage.setItem(PERSISTED_KEY, JSON.stringify({ ...readPersisted(), [key]: models }));
  } catch {
    // Storage unavailable: the in-memory cache still serves this session.
  }
}

function catalogueKey(provider: string): string {
  return `${get(remoteTarget) ? 'remote' : 'local'}:${provider}`;
}

/**
 * The last catalogue this CLI reported, or null if none has loaded yet. Used
 * where a prompt is built synchronously (the orchestrator's system prompt);
 * pair it with `loadLiveAgentProviderModels` to warm the cache.
 */
export function peekLiveAgentProviderModels(command: string): AgentProviderModel[] | null {
  const key = catalogueKey(getAgentProviderCapabilities(command).provider);
  return settledCatalogues.get(key) ?? readPersisted()[key] ?? null;
}

/** Ask the selected CLI for its current account/configured model list. */
export function loadLiveAgentProviderModels(command: string): Promise<AgentProviderModel[]> {
  const provider = getAgentProviderCapabilities(command).provider;
  const key = catalogueKey(provider);
  const cached = catalogueCache.get(key);
  if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.models;

  const models = probeLiveAgentProviderModels(command);
  catalogueCache.set(key, { at: Date.now(), models });
  // An empty or failed probe is not a catalogue; let the next caller retry.
  void models.then(
    (list) => {
      if (list.length) {
        settledCatalogues.set(key, list);
        persist(key, list);
      } else if (catalogueCache.get(key)?.models === models) catalogueCache.delete(key);
    },
    () => { if (catalogueCache.get(key)?.models === models) catalogueCache.delete(key); },
  );
  // Serve the list this CLI reported last time straight away; the probe
  // above refreshes it for the next open.
  const previous = settledCatalogues.get(key) ?? readPersisted()[key];
  return previous?.length ? Promise.resolve(previous) : models;
}

/**
 * The CLI's current list, never the copy saved from an earlier run:
 * `loadLiveAgentProviderModels` answers with that copy at once, so a picker
 * that stays open (the chat composer's) also needs the fresh probe, or it
 * keeps offering models the account no longer has.
 */
export function freshLiveAgentProviderModels(command: string, force = false): Promise<AgentProviderModel[]> {
  const key = catalogueKey(getAgentProviderCapabilities(command).provider);
  if (force) catalogueCache.delete(key);
  void loadLiveAgentProviderModels(command);
  return catalogueCache.get(key)?.models ?? Promise.resolve([]);
}

/**
 * Start probing these CLIs now so their pickers are ready when opened.
 * Already-cached providers cost nothing.
 */
export function prewarmLiveAgentProviderModels(commands: Iterable<string>): void {
  for (const command of commands) {
    if (!isChatAgentProvider(command)) continue;
    void loadLiveAgentProviderModels(command).catch(() => undefined);
  }
}

/** Test helper — forget cached catalogues between cases. */
export function resetLiveAgentModelCacheForTests(): void {
  catalogueCache.clear();
  settledCatalogues.clear();
  try { localStorage.removeItem(PERSISTED_KEY); } catch { /* no storage */ }
}

async function probeLiveAgentProviderModels(command: string): Promise<AgentProviderModel[]> {
  const provider = getAgentProviderCapabilities(command).provider;
  const liveCommand = getLiveAgentModelCommand(command);
  const nativeCatalogueProvider = provider === 'codex' || provider === 'claude';
  if (!liveCommand && !nativeCatalogueProvider) return [];

  // Local mode asks the installed CLI directly from Rust, in a windowless
  // background process — never through a terminal session, which would take
  // a pane and hold the user's shell. When the CLI cannot answer, the picker
  // offers only "CLI default".
  if (!get(remoteTarget)) {
    try {
      const result = await invoke<{ output: string; exitCode: number | null; error?: string | null; models?: AgentProviderModel[] }>(
        'agent_list_models',
        { command: provider },
      );
      if (result.exitCode !== 0) return [];
      const models = result.models?.length ? result.models : parseLiveAgentModels(provider, result.output);
      return satisfiesLiveCatalogue(models) ? mergeAgentProviderModels(provider, models) : [];
    } catch (error) {
      console.warn(`[chat] Native model catalogue failed for ${command}.`, error);
      return [];
    }
  }

  // Remote workspaces probe through a hidden background session so the
  // catalogue comes from the machine hosting the agent, not from the laptop.
  // `codex app-server` is a protocol process, not a one-shot shell command;
  // piping it through a terminal would wait forever for a TUI-style exit.
  if (nativeCatalogueProvider) return [];
  if (!liveCommand) return [];

  const result = await runEmbeddedCommand({
    key: `chat-models:${command}`,
    command: liveCommand,
    label: `${getAgentDisplayName(command) ?? command} models`,
    background: true,
    notify: false,
    // Matches the native probe's budget for slow CLIs (see agent_models.rs).
    timeoutMs: 40_000,
  });
  if (result.exitCode !== 0) return [];
  const models = parseLiveAgentModels(provider, result.output);
  return satisfiesLiveCatalogue(models) ? mergeAgentProviderModels(provider, models) : [];
}

function satisfiesLiveCatalogue(models: AgentProviderModel[]): boolean {
  return models.length > 0;
}

/**
 * Drop a model or reasoning level the installed CLI did not report, so a
 * launch never carries a flag the CLI rejects (the brain can name an id that
 * does not exist). Unknown catalogue = trust the caller; the CLI decides.
 */
export function sanitizeLaunchSelection(
  command: string,
  model: string | null,
  reasoningEffort: ChatReasoningEffort | undefined,
): { model: string | null; reasoningEffort: ChatReasoningEffort | undefined; dropped: string[] } {
  const dropped: string[] = [];
  const capabilities = getAgentProviderCapabilities(command);
  const catalogue = peekLiveAgentProviderModels(command);
  let safeModel = model;
  if (safeModel && catalogue && !catalogue.some((entry) => entry.id === safeModel)) {
    dropped.push(`model "${safeModel}"`);
    safeModel = null;
  }
  const entry = catalogue?.find((candidate) => safeModel ? candidate.id === safeModel : candidate.isDefault);
  const allowed = entry?.reasoningEfforts ?? capabilities.reasoningEfforts;
  let safeEffort = reasoningEffort;
  if (safeEffort && safeEffort !== 'default' && !allowed.includes(safeEffort)) {
    dropped.push(`reasoning "${safeEffort}"`);
    safeEffort = undefined;
  }
  return { model: safeModel, reasoningEffort: safeEffort, dropped };
}
