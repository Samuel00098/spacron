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
  ],
  claude: [
    { id: 'default', label: 'Auto', description: 'Let Claude Code choose the available model.' },
  ],
  'cursor-agent': [
    { id: 'default', label: 'Auto', description: 'Let Cursor choose the available model.' },
  ],
  grok: [
    { id: 'default', label: 'Auto', description: 'Use Grok Build’s current model.' },
  ],
  opencode: [{ id: 'default', label: 'Auto', description: 'Let OpenCode choose the configured model.' }],
  agy: [{ id: 'antigravity-default', label: 'Auto', description: 'Use Antigravity’s current model.' }],
  pi: [{ id: 'default', label: 'Auto', description: 'Let Pi choose the available model.' }],
};

const LIVE_MODEL_COMMANDS: Record<string, string> = {
  'cursor-agent': 'cursor-agent models',
  grok: 'grok models',
  opencode: 'opencode models',
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

/** Return the provider-native command when the CLI exposes a safe model list. */
export function getLiveAgentModelCommand(command: string): string | null {
  return LIVE_MODEL_COMMANDS[command] ?? null;
}

function cleanModelOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

/** Parse the human-readable model lists emitted by the supported CLIs. */
export function parseLiveAgentModels(command: string, output: string): AgentProviderModel[] {
  const text = cleanModelOutput(output);
  const models: AgentProviderModel[] = [];
  const seen = new Set<string>();
  const add = (id: string, label?: string, description?: string) => {
    const normalized = id.trim();
    if (!normalized || normalized === 'Tip:' || seen.has(normalized)) return;
    seen.add(normalized);
    models.push({ id: normalized, label: label?.trim() || normalized, description });
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^available models:?$/i.test(trimmed) || /^tip:/i.test(trimmed)) continue;

    // Cursor Agent: `model-id - Human label`.
    const cursor = trimmed.match(/^([A-Za-z0-9._:/-]+)\s+-\s+(.+)$/);
    if (cursor) {
      add(cursor[1], cursor[2], 'Reported by the installed agent CLI.');
      continue;
    }

    // Grok: `* grok-4.6 (default)`.
    const grok = trimmed.match(/^\*\s+([^\s(]+)(?:\s+\(([^)]+)\))?$/);
    if (grok) {
      add(grok[1], grok[1], grok[2] ? `Live agent model · ${grok[2]}` : 'Reported by the installed agent CLI.');
      continue;
    }

    // OpenCode versions differ in whether they print `provider/model` alone or
    // add a human label after whitespace. Ignore banners and config warnings.
    if (command === 'opencode' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+(?:\s+.+)?$/.test(trimmed)) {
      const [id, ...label] = trimmed.split(/\s+/);
      add(id, label.join(' ') || id, 'Reported by the installed agent CLI.');
    }
  }
  return models;
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
