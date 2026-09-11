import { getAgentDisplayName } from '$lib/stores/terminal';
import type { ChatProviderId } from '$lib/types/chat';

export interface AgentProviderModel {
  id: string;
  label: string;
  description?: string;
  free?: boolean;
}

export interface AgentProviderCapabilities {
  provider: ChatProviderId;
  label: string;
  /** Whether the installed agent can expose a model/config picker in Chat. */
  supportsChat: boolean;
  /** Provider-native models, used until a live agent catalogue is available. */
  models: AgentProviderModel[];
  /** ACP-style capability descriptors reserved for the live adapter seam. */
  optionDescriptors?: Array<{ id: string; label: string; type: 'select' | 'boolean'; options?: AgentProviderModel[] }>;
}

// These are the provider aliases whose CLIs have a stable interactive chat
// session and a provider-native model/config concept. Other installed agents
// remain available from the CLI and can be added here when their adapter can
// report capabilities instead of guessing from a global AI model list.
const CHAT_PROVIDER_MODELS: Record<string, AgentProviderModel[]> = {
  codex: [
    { id: 'default', label: 'Auto', description: 'Let Codex choose the available model.' },
    { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Codex general-purpose model.' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Coding-focused Codex model.' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'Fast Codex model.' },
  ],
  claude: [
    { id: 'default', label: 'Auto', description: 'Let Claude Code choose the available model.' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', description: 'Balanced Claude model.' },
    { id: 'claude-opus-4-5', label: 'Opus 4.5', description: 'Highest-quality Claude model.' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fast Claude model.' },
  ],
  'cursor-agent': [
    { id: 'default', label: 'Auto', description: 'Let Cursor choose the available model.' },
    { id: 'composer-2', label: 'Composer 2', description: 'Cursor’s default agent model.' },
    { id: 'composer-1.5', label: 'Composer 1.5', description: 'Earlier Composer model.' },
  ],
  grok: [
    { id: 'default', label: 'Auto', description: 'Use Grok Build’s current model.' },
    { id: 'grok-build', label: 'Grok Build', description: 'Grok’s coding-agent model.' },
  ],
  opencode: [
    { id: 'openai/gpt-5', label: 'OpenAI GPT-5', description: 'OpenCode model alias.' },
    { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'OpenCode model alias.' },
  ],
  agy: [{ id: 'antigravity-default', label: 'Auto', description: 'Use Antigravity’s current model.' }],
  pi: [{ id: 'default', label: 'Auto', description: 'Let Pi choose the available model.' }],
};

export function isChatAgentProvider(command: string): boolean {
  return Boolean(CHAT_PROVIDER_MODELS[command]);
}

export function getAgentProviderCapabilities(command: string, label = getAgentDisplayName(command) ?? command): AgentProviderCapabilities {
  return {
    provider: command,
    label,
    supportsChat: isChatAgentProvider(command),
    models: CHAT_PROVIDER_MODELS[command] ?? [],
  };
}

/** Normalize a live provider capability catalogue into the model picker shape.
 * The ACP/agent adapter can call this when it begins exposing descriptors. */
export function mergeAgentProviderModels(
  command: string,
  liveModels: AgentProviderModel[],
): AgentProviderModel[] {
  const curated = new Map((CHAT_PROVIDER_MODELS[command] ?? []).map((model) => [model.id, model]));
  return liveModels.map((model) => {
    const known = curated.get(model.id);
    return {
      id: model.id,
      label: known?.label ?? model.label ?? model.id,
      description: known?.description ?? model.description,
      free: known?.free ?? model.free,
    };
  });
}
