import type { ChatAccessMode, ChatProviderId, ChatReasoningEffort } from '$lib/types/chat';

export type ChatProviderProtocol =
  | 'codex-app-server'
  | 'claude-stream-json'
  | 'cursor-stream-json'
  | 'grok-stream-json'
  | 'opencode-server';

export interface AgentProviderModel {
  id: string;
  label: string;
  description?: string;
  free?: boolean;
  /** Provider catalogue entry is visible but cannot be selected yet. */
  supported?: boolean;
  supportReason?: string;
  /** Model-specific options reported by the provider, when available. */
  reasoningEfforts?: ChatReasoningEffort[];
  defaultReasoningEffort?: ChatReasoningEffort;
  isDefault?: boolean;
}

export interface AgentProviderCapabilities {
  provider: ChatProviderId;
  label: string;
  supportsChat: boolean;
  /** Native protocol used by the Chat driver. */
  protocol?: ChatProviderProtocol;
  /** Provider-native models, used until a live catalogue is available. */
  models: AgentProviderModel[];
  accessModes: ChatAccessMode[];
  reasoningEfforts: ChatReasoningEffort[];
  /** Runtime choices are fixed for the current PTY-backed Chat session. */
  sessionModelSwitch: 'unsupported';
  optionDescriptors?: Array<{ id: string; label: string; type: 'select' | 'boolean'; options?: AgentProviderModel[] }>;
}

export interface AgentProviderLaunchOptions {
  /** Undefined preserves the normal global/per-agent CLI permission setting. */
  permissionArgs: string | undefined;
  /** Model and reasoning flags that belong only to this Chat session. */
  runtimeArgs: string;
}

export interface ChatProviderAdapter {
  id: string;
  aliases: readonly string[];
  label: string;
  protocol: ChatProviderProtocol;
  models: readonly AgentProviderModel[];
  accessModes: readonly ChatAccessMode[];
  reasoningEfforts: readonly ChatReasoningEffort[];
  /** Null means this driver gets its catalogue from a native protocol or curated aliases. */
  modelCommand: string | null;
  buildLaunchOptions(selection: {
    model?: string | null;
    accessMode?: ChatAccessMode;
    reasoningEffort?: ChatReasoningEffort;
  }): AgentProviderLaunchOptions;
  parseModels(output: string): AgentProviderModel[];
}

const CODEX_REASONING: ChatReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_REASONING: ChatReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const GROK_REASONING: ChatReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function safeProviderValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed && /^[A-Za-z0-9._:/~-]+$/.test(trimmed) ? trimmed : null;
}

function cleanModelOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function addUniqueModel(
  models: AgentProviderModel[],
  seen: Set<string>,
  model: AgentProviderModel,
): void {
  const id = model.id.trim();
  if (!id || seen.has(id)) return;
  seen.add(id);
  models.push({ ...model, id, label: model.label.trim() || id });
}

function parseDashModels(output: string): AgentProviderModel[] {
  const models: AgentProviderModel[] = [];
  const seen = new Set<string>();
  for (const line of cleanModelOutput(output).split('\n')) {
    const match = line.trim().match(/^([A-Za-z0-9._:/~-]+)\s+-\s+(.+)$/);
    if (!match) continue;
    addUniqueModel(models, seen, {
      id: match[1],
      label: match[2],
      description: 'Reported by the installed agent CLI.',
      ...(/\bdefault\b/i.test(match[2]) ? { isDefault: true } : {}),
    });
  }
  return models;
}

function parseGrokModels(output: string): AgentProviderModel[] {
  const models: AgentProviderModel[] = [];
  const seen = new Set<string>();
  for (const line of cleanModelOutput(output).split('\n')) {
    const match = line.trim().match(/^\*\s+([^\s(]+)(?:\s+\(([^)]+)\))?$/);
    if (!match) continue;
    addUniqueModel(models, seen, {
      id: match[1],
      label: match[1],
      description: 'Reported by the installed agent CLI.',
      isDefault: /\bdefault\b/i.test(match[2] ?? ''),
    });
  }
  return models;
}

function parseOpenCodeModels(output: string): AgentProviderModel[] {
  const models: AgentProviderModel[] = [];
  const seen = new Set<string>();
  for (const line of cleanModelOutput(output).split('\n')) {
    const trimmed = line.trim();
    if (!/^[A-Za-z0-9._~-]+\/[A-Za-z0-9._:/~-]+$/.test(trimmed)) continue;
    addUniqueModel(models, seen, {
      id: trimmed,
      label: trimmed,
      description: 'Reported by the installed OpenCode CLI.',
      free: /(?:^|[-/])free(?:$|-)/i.test(trimmed),
    });
  }
  return models;
}

function runtimeModelArgs(model: string | null): string[] {
  return model && model !== 'default' ? ['--model', model] : [];
}

function permissionArgs(
  requested: ChatAccessMode,
  supported: readonly ChatAccessMode[],
  args: Partial<Record<Exclude<ChatAccessMode, 'inherit'>, string>>,
): string | undefined {
  if (requested === 'inherit') return undefined;
  // Invalid persisted modes fail closed to the provider's normal supervised
  // launch instead of inheriting a potentially broader global preference.
  return supported.includes(requested) ? args[requested] ?? '' : '';
}

const codexAdapter: ChatProviderAdapter = {
  id: 'codex',
  aliases: ['codex'],
  label: 'Codex',
  protocol: 'codex-app-server',
  models: [{ id: 'default', label: 'Auto', description: 'Let Codex choose the available model.' }],
  accessModes: ['supervised', 'auto-edits', 'auto', 'full-access'],
  reasoningEfforts: CODEX_REASONING,
  modelCommand: null,
  buildLaunchOptions(selection) {
    const model = safeProviderValue(selection.model);
    const reasoning = selection.reasoningEffort ?? 'default';
    const runtimeArgs = runtimeModelArgs(model);
    if (reasoning !== 'default' && CODEX_REASONING.includes(reasoning)) {
      runtimeArgs.push('-c', `model_reasoning_effort=${reasoning}`);
    }
    return {
      permissionArgs: permissionArgs(selection.accessMode ?? 'inherit', this.accessModes, {
        supervised: '--sandbox read-only --ask-for-approval on-request',
        'auto-edits': '--sandbox workspace-write --ask-for-approval on-request',
        auto: '--approve-for-me',
        'full-access': '--dangerously-bypass-approvals-and-sandbox',
      }),
      runtimeArgs: runtimeArgs.join(' '),
    };
  },
  parseModels: parseDashModels,
};

const claudeAdapter: ChatProviderAdapter = {
  id: 'claude',
  aliases: ['claude', 'claude-code'],
  label: 'Claude Code',
  protocol: 'claude-stream-json',
  models: [
    { id: 'default', label: 'Auto', description: 'Let Claude Code choose the available model.' },
    { id: 'fable', label: 'Claude Fable' },
    { id: 'opus', label: 'Claude Opus' },
    { id: 'sonnet', label: 'Claude Sonnet' },
  ],
  accessModes: ['supervised', 'auto-edits', 'auto', 'full-access'],
  reasoningEfforts: CLAUDE_REASONING,
  modelCommand: null,
  buildLaunchOptions(selection) {
    const model = safeProviderValue(selection.model);
    const reasoning = selection.reasoningEffort ?? 'default';
    const runtimeArgs = runtimeModelArgs(model);
    if (reasoning !== 'default' && CLAUDE_REASONING.includes(reasoning)) {
      runtimeArgs.push('--effort', reasoning);
    }
    return {
      permissionArgs: permissionArgs(selection.accessMode ?? 'inherit', this.accessModes, {
        supervised: '--permission-mode manual',
        'auto-edits': '--permission-mode acceptEdits',
        auto: '--permission-mode auto',
        'full-access': '--permission-mode bypassPermissions',
      }),
      runtimeArgs: runtimeArgs.join(' '),
    };
  },
  parseModels: () => [],
};

const cursorAdapter: ChatProviderAdapter = {
  id: 'cursor-agent',
  aliases: ['cursor-agent', 'cursor'],
  label: 'Cursor',
  protocol: 'cursor-stream-json',
  models: [{ id: 'default', label: 'Auto', description: 'Let Cursor choose the available model.' }],
  accessModes: ['supervised', 'full-access'],
  // Cursor exposes effort as part of each model id, not as a separate option.
  reasoningEfforts: [],
  modelCommand: 'cursor-agent models',
  buildLaunchOptions(selection) {
    const model = safeProviderValue(selection.model);
    return {
      permissionArgs: permissionArgs(selection.accessMode ?? 'inherit', this.accessModes, {
        supervised: '',
        'full-access': '--yolo',
      }),
      runtimeArgs: runtimeModelArgs(model).join(' '),
    };
  },
  parseModels: parseDashModels,
};

const grokAdapter: ChatProviderAdapter = {
  id: 'grok',
  aliases: ['grok'],
  label: 'Grok Build',
  protocol: 'grok-stream-json',
  models: [{ id: 'default', label: 'Auto', description: 'Use Grok Build’s current model.' }],
  accessModes: ['supervised', 'auto-edits', 'auto', 'full-access'],
  reasoningEfforts: GROK_REASONING,
  modelCommand: 'grok models',
  buildLaunchOptions(selection) {
    const model = safeProviderValue(selection.model);
    const reasoning = selection.reasoningEffort ?? 'default';
    const runtimeArgs = runtimeModelArgs(model);
    if (reasoning !== 'default' && GROK_REASONING.includes(reasoning)) {
      runtimeArgs.push('--reasoning-effort', reasoning);
    }
    return {
      permissionArgs: permissionArgs(selection.accessMode ?? 'inherit', this.accessModes, {
        supervised: '--permission-mode manual',
        'auto-edits': '--permission-mode acceptEdits',
        auto: '--permission-mode auto',
        'full-access': '--permission-mode bypassPermissions',
      }),
      runtimeArgs: runtimeArgs.join(' '),
    };
  },
  parseModels: parseGrokModels,
};

const openCodeAdapter: ChatProviderAdapter = {
  id: 'opencode',
  aliases: ['opencode'],
  label: 'OpenCode',
  protocol: 'opencode-server',
  models: [{ id: 'default', label: 'Auto', description: 'Let OpenCode choose the configured model.' }],
  accessModes: ['supervised', 'full-access'],
  reasoningEfforts: [],
  modelCommand: 'opencode models',
  buildLaunchOptions(selection) {
    const model = safeProviderValue(selection.model);
    return {
      permissionArgs: permissionArgs(selection.accessMode ?? 'inherit', this.accessModes, {
        supervised: '',
        'full-access': '--auto',
      }),
      runtimeArgs: runtimeModelArgs(model).join(' '),
    };
  },
  parseModels: parseOpenCodeModels,
};

export const CHAT_PROVIDER_ADAPTERS = [
  codexAdapter,
  claudeAdapter,
  cursorAdapter,
  grokAdapter,
  openCodeAdapter,
] as const;

const adaptersByAlias = new Map<string, ChatProviderAdapter>();
for (const adapter of CHAT_PROVIDER_ADAPTERS) {
  for (const alias of adapter.aliases) adaptersByAlias.set(alias, adapter);
}

function executableName(command: string): string {
  const trimmed = command.trim();
  const token = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.slice(1).find(Boolean) ?? '';
  const basename = token.replace(/\\/g, '/').split('/').pop() ?? token;
  return basename.replace(/\.(?:cmd|exe|ps1|bat)$/i, '').toLowerCase();
}

export function getChatProviderAdapter(command: string): ChatProviderAdapter | null {
  return adaptersByAlias.get(executableName(command)) ?? null;
}

export function isChatAgentProvider(command: string): boolean {
  return getChatProviderAdapter(command) !== null;
}

export function getAgentProviderCapabilities(command: string, label?: string): AgentProviderCapabilities {
  const adapter = getChatProviderAdapter(command);
  return {
    provider: adapter?.id ?? command,
    label: label ?? adapter?.label ?? command,
    supportsChat: adapter !== null,
    protocol: adapter?.protocol,
    models: adapter ? [...adapter.models] : [],
    accessModes: adapter ? [...adapter.accessModes] : [],
    reasoningEfforts: adapter ? [...adapter.reasoningEfforts] : [],
    sessionModelSwitch: 'unsupported',
  };
}

export function getAgentProviderLaunchOptions(
  command: string,
  selection: {
    model?: string | null;
    accessMode?: ChatAccessMode;
    reasoningEffort?: ChatReasoningEffort;
  },
): AgentProviderLaunchOptions {
  const adapter = getChatProviderAdapter(command);
  return adapter?.buildLaunchOptions(selection) ?? { permissionArgs: '', runtimeArgs: '' };
}

export function getLiveAgentModelCommand(command: string): string | null {
  return getChatProviderAdapter(command)?.modelCommand ?? null;
}

export function parseLiveAgentModels(command: string, output: string): AgentProviderModel[] {
  return getChatProviderAdapter(command)?.parseModels(output) ?? [];
}

export function mergeAgentProviderModels(command: string, liveModels: AgentProviderModel[]): AgentProviderModel[] {
  const curated = new Map((getChatProviderAdapter(command)?.models ?? []).map((model) => [model.id, model]));
  return liveModels.map((model) => {
    const known = curated.get(model.id);
    return {
      ...model,
      label: known?.label ?? model.label ?? model.id,
      description: known?.description ?? model.description,
      free: known?.free ?? model.free,
    };
  });
}
