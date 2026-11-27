/**
 * Unified Agent -> Model -> Reasoning catalog for structured chats (standalone
 * and in-project). Reads live provider catalogs, persisted structured catalogs,
 * cached CLI probes, install status, and reasoning effort levels without booting
 * any CLI process upfront.
 */
import { useMemo } from 'react';
import { get } from '$lib/stores/storeCompat';
import { useStore } from '$lib/react/useStore';
import { haveAgentDetection, installedAgentCommands, usageState } from '$lib/stores/usage';
import { favouriteAgentCommands } from '$lib/stores/agentFavourites';
import { installDocsFor } from '$lib/services/agent-install';
import {
  freshLiveAgentProviderModels,
  loadLiveAgentProviderModels,
  peekLiveAgentProviderModels,
} from '$lib/services/live-agent-models';
import type { AgentProviderModel } from '$lib/services/agent-provider-catalogue';
import { reasoningLevelsFor } from '$lib/services/orchestrator/reasoning-levels';
import type { ChatReasoningEffort } from '$lib/types/chat';
import { cachedModelCatalog } from './model-catalog';
import { commandForStructuredAgent, type StructuredChatAgent } from './panes';
import type { StructuredChatState, StructuredModel } from './provider';

export interface StructuredAgentDef {
  agent: StructuredChatAgent;
  command: string;
  name: string;
}

export interface StructuredAgentEntry extends StructuredAgentDef {
  installed: boolean;
  installDocs: { url: string; known: boolean };
}

export const STRUCTURED_AGENT_DEFS: readonly StructuredAgentDef[] = [
  { agent: 'codex', command: 'codex', name: 'Codex' },
  { agent: 'claude', command: 'claude', name: 'Claude Code' },
  { agent: 'antigravity', command: 'agy', name: 'Antigravity' },
  { agent: 'opencode', command: 'opencode', name: 'OpenCode' },
  { agent: 'pi', command: 'pi', name: 'Pi AI Agent' },
  { agent: 'cursor', command: 'cursor-agent', name: 'Cursor' },
  { agent: 'hermes', command: 'hermes', name: 'Hermes Agent' },
  { agent: 'grok', command: 'grok', name: 'Grok' },
  { agent: 'copilot', command: 'copilot', name: 'GitHub Copilot' },
  { agent: 'kimi', command: 'kimi', name: 'Kimi' },
  { agent: 'omp', command: 'omp', name: 'OMP' },
];

const CLAUDE_FALLBACK_MODELS: AgentProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Most capable, for complex work',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Fast and capable for everyday tasks',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
    isDefault: true,
  },
  {
    id: 'haiku',
    label: 'Haiku',
    description: 'Fastest, for quick answers',
    reasoningEfforts: ['low', 'medium', 'high'],
  },
];

function reasoningProviderFor(agent: StructuredChatAgent): string {
  if (agent === 'codex') return 'chatgpt';
  if (agent === 'claude') return 'anthropic';
  return agent;
}

function enrichModelEfforts(agent: StructuredChatAgent, model: AgentProviderModel): AgentProviderModel {
  const existing = (model.reasoningEfforts ?? []).filter((effort) => effort !== 'default');
  if (existing.length > 0) {
    return { ...model, reasoningEfforts: existing };
  }
  const inferred = reasoningLevelsFor(reasoningProviderFor(agent), model.id).filter((effort) => effort !== 'default');
  return inferred.length > 0 ? { ...model, reasoningEfforts: inferred } : model;
}

function fromStructuredModel(agent: StructuredChatAgent, model: StructuredModel): AgentProviderModel {
  return enrichModelEfforts(agent, {
    id: model.id,
    label: model.label,
    description: model.description ?? undefined,
    reasoningEfforts: model.efforts as ChatReasoningEffort[],
    defaultReasoningEffort: model.defaultEffort as ChatReasoningEffort | undefined,
    supportsFast: model.supportsFast,
    isDefault: model.isDefault,
  });
}

/**
 * Return all 11 structured-chat agents sorted with installed agents first
 * (favourites pinned in order), followed by uninstalled agents with install
 * documentation links.
 */
export function getStructuredAgentEntries(opts?: {
  installedCommands?: Set<string>;
  detected?: boolean;
  favourites?: readonly string[];
}): StructuredAgentEntry[] {
  const usage = get(usageState);
  const detected = opts?.detected ?? haveAgentDetection(usage);
  const installedSet = opts?.installedCommands ?? installedAgentCommands(usage);
  const favourites = opts?.favourites ?? get(favouriteAgentCommands);

  const rankFavourite = (command: string): number => {
    const idx = favourites.indexOf(command.trim().toLowerCase());
    return idx === -1 ? favourites.length : idx;
  };

  return STRUCTURED_AGENT_DEFS
    .map((def, index) => {
      const installed = detected ? installedSet.has(def.command.toLowerCase()) : true;
      return {
        entry: {
          ...def,
          installed,
          installDocs: installDocsFor(def.command, def.name),
        },
        index,
      };
    })
    .sort((a, b) => {
      if (a.entry.installed !== b.entry.installed) return a.entry.installed ? -1 : 1;
      const favDiff = rankFavourite(a.entry.command) - rankFavourite(b.entry.command);
      return favDiff !== 0 ? favDiff : a.index - b.index;
    })
    .map((item) => item.entry);
}

/** Reactive hook returning the sorted structured agent catalog. */
export function useStructuredAgentCatalog(): StructuredAgentEntry[] {
  const usage = useStore(usageState);
  const favourites = useStore(favouriteAgentCommands);
  return useMemo(() => {
    const installedCommands = installedAgentCommands(usage);
    const detected = haveAgentDetection(usage);
    return getStructuredAgentEntries({ installedCommands, detected, favourites });
  }, [usage, favourites]);
}

/** Pick the best installed default structured agent for a fresh chat. */
export function pickDefaultStructuredAgent(): StructuredChatAgent {
  const entries = getStructuredAgentEntries();
  const favourites = get(favouriteAgentCommands);
  const favInstalled = entries.find((e) => e.installed && favourites.includes(e.command.toLowerCase()));
  if (favInstalled) return favInstalled.agent;
  const preferred = entries.find((e) => e.installed && (e.agent === 'claude' || e.agent === 'codex'));
  if (preferred) return preferred.agent;
  return entries.find((e) => e.installed)?.agent ?? 'claude';
}

/** Synchronously resolve the best-known model list + reasoning efforts for an agent. */
export function resolveStructuredAgentModels(
  agent: StructuredChatAgent,
  liveState?: StructuredChatState | null,
): AgentProviderModel[] {
  if (liveState?.models?.length) {
    return liveState.models.map((model) => fromStructuredModel(agent, model));
  }
  const cachedStructured = cachedModelCatalog(agent);
  if (cachedStructured?.length) {
    return cachedStructured.map((model) => fromStructuredModel(agent, model));
  }
  const command = commandForStructuredAgent(agent);
  const peeked = peekLiveAgentProviderModels(command);
  if (peeked?.length) {
    return peeked.map((model) => enrichModelEfforts(agent, model));
  }
  if (agent === 'claude') {
    return CLAUDE_FALLBACK_MODELS.map((model) => ({ ...model }));
  }
  return [];
}

/** Trigger or force-refresh a CLI probe for the given structured agent. */
export async function loadStructuredAgentModels(
  agent: StructuredChatAgent,
  force = false,
): Promise<AgentProviderModel[]> {
  const command = commandForStructuredAgent(agent);
  const list = force
    ? await freshLiveAgentProviderModels(command, true)
    : await loadLiveAgentProviderModels(command);
  return list.map((model) => enrichModelEfforts(agent, model));
}
