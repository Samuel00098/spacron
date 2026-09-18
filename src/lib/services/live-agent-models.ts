import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { runEmbeddedCommand } from '$lib/stores/embeddedRun';
import { getAgentDisplayName } from '$lib/stores/terminal';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import {
  getAgentProviderCapabilities,
  getLiveAgentModelCommand,
  parseLiveAgentModels,
  type AgentProviderModel,
} from './agent-provider-catalogue';

/** Ask the selected CLI for its current account/configured model list. */
export async function loadLiveAgentProviderModels(command: string): Promise<AgentProviderModel[]> {
  const provider = getAgentProviderCapabilities(command).provider;
  const liveCommand = getLiveAgentModelCommand(command);
  const nativeCatalogueProvider = provider === 'codex';
  if (!liveCommand && !nativeCatalogueProvider) return [];

  // Local mode asks the native provider adapter directly. This is both faster
  // and more reliable than borrowing a visible shell, and Codex's model list is
  // available only through its app-server protocol. Remote workspaces retain
  // the terminal probe so the catalogue comes from the machine hosting the
  // agent rather than from the laptop.
  if (!get(remoteTarget)) {
    try {
      const result = await invoke<{ output: string; exitCode: number | null; error?: string | null }>(
        'agent_list_models',
        { command: provider },
      );
      if (result.exitCode === 0) {
        const models = parseLiveAgentModels(provider, result.output);
        if (satisfiesLiveCatalogue(models)) return models;
      }
    } catch (error) {
      console.warn(`[chat] Native model catalogue failed for ${command}; trying the terminal adapter.`, error);
    }
  }

  // `codex app-server` is a protocol process, not a one-shot shell command.
  // The native adapter above owns its initialize/model-list exchange; piping it
  // through an embedded terminal would wait forever for a TUI-style exit.
  if (nativeCatalogueProvider) return [];
  if (!liveCommand) return [];

  const result = await runEmbeddedCommand({
    key: `chat-models:${command}`,
    command: liveCommand,
    label: `${getAgentDisplayName(command) ?? command} models`,
    background: true,
    notify: false,
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) return [];
  const models = parseLiveAgentModels(provider, result.output);
  return satisfiesLiveCatalogue(models) ? models : [];
}

function satisfiesLiveCatalogue(models: AgentProviderModel[]): boolean {
  return models.length > 0;
}
