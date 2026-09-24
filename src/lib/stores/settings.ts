import { writable, derived, get } from '$lib/stores/storeCompat';
import { useSettingsStore } from './zustand/settings';
import type { McpServer } from '$lib/services/mcp-servers';
import { DEFAULT_MEDIA_GENERATION, type MediaGenerationSettings } from '$lib/services/media-generation';

function persistentWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  if (typeof window === 'undefined') {
    return writable(defaultValue);
  }

  const zustandVal = (useSettingsStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;

  const store = writable<T>(initial);

  // Sync Zustand → writable on every change
  const unsub = useSettingsStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) {
      store.set(next);
    }
  });

  return {
    subscribe: store.subscribe,
    set(value: T) {
      (useSettingsStore.getState() as any).__set(key, value);
    },
    update(fn: (val: T) => T) {
      const current = (useSettingsStore.getState() as any)[key] as T;
      const next = fn(current);
      (useSettingsStore.getState() as any).__set(key, next);
    },
  };
}

const FONT_CANDIDATES = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Cascadia Mono',
  'Victor Mono',
  'IBM Plex Mono',
  'Source Code Pro',
  'Consolas',
  'Monaco',
  'Menlo',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Courier New',
];

let detectedFontCache: string | null = null;

export function detectBestFont(): string {
  if (detectedFontCache) return detectedFontCache;

  if (typeof document === 'undefined') {
    detectedFontCache = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace";
    return detectedFontCache;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    detectedFontCache = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace";
    return detectedFontCache;
  }

  ctx.font = '12px monospace';
  const testStr = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const baseWidth = ctx.measureText(testStr).width;

  for (const font of FONT_CANDIDATES) {
    ctx.font = `12px "${font}", monospace`;
    const width = ctx.measureText(testStr).width;
    if (width !== baseWidth) {
      detectedFontCache = `'${font}', '${FONT_CANDIDATES.filter(f => f !== font).join("', '")}', monospace`;
      return detectedFontCache;
    }
  }

  detectedFontCache = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace";
  return detectedFontCache;
}

// Editor
export const fontSize = persistentWritable('fontSize', 14);
const FONT_FALLBACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Ubuntu Mono', 'Noto Mono', Consolas, monospace";
export const fontFamily = persistentWritable('fontFamily', FONT_FALLBACK);
export const resolvedFontFamily = derived(fontFamily, ($ff) => {
  if (!$ff || $ff.trim() === '') return FONT_FALLBACK;
  return $ff;
});
export const tabSize = persistentWritable('tabSize', 2);
export const wordWrap = persistentWritable('wordWrap', true);
export const minimap = persistentWritable('minimap', false);
export const vimMode = persistentWritable('vimMode', false);
/**
 * Column (box) selection via Alt+Shift+drag, plus the crosshair cursor that
 * signals it. On by default — the gesture is what every editor does, and its
 * absence reads as the editor being broken rather than minimal. The toggle
 * exists because the crosshair cursor and the Alt-drag capture are visible even
 * to people who never box-select, and Alt-drag collides with some window
 * managers' move-window binding on Linux.
 */
export const columnSelection = persistentWritable('columnSelection', true);
// Language-server-backed autocomplete, diagnostics and hover. Requires the
// relevant language server (rust-analyzer, typescript-language-server, …) on PATH.
export const enableLsp = persistentWritable('enableLsp', true);

// Explorer
export const showHidden = persistentWritable('showHidden', false);
export const showSnapshotsTab = persistentWritable('showSnapshotsTab', false);

// Notifications
export const notificationsEnabled = persistentWritable('notificationsEnabled', true);

// Agent git worktrees
// Default for whether a spawned agent gets its own isolated worktree and branch.
// The Isolated / Main repo toggle in the spawn modal overrides it per spawn; turn
// this off to have every agent work directly in the project root instead.
//
// Defaults ON, and should stay that way: without it two agents run concurrently
// in one working tree and silently clobber each other's edits — the failure
// worktrees exist to prevent (docs/agent-loops.md, gap 1). The MCP spawn path
// isolates unconditionally for the same reason, so turning this off leaves the
// two spawn routes behaving oppositely.
export const agentWorktrees = persistentWritable('agentWorktrees', true);
// Move each agent's changes into the main checkout on their own, so the app can be
// run and tested against them without pressing anything. Off — the default — keeps
// every agent's work quarantined in its own worktree until the user reviews it in
// the fleet dashboard and brings it in or merges it (Orca's review-wall model).
// The same work stays visible in the Agent changes list either way.
export const autoStageAgentChanges = persistentWritable('autoStageAgentChanges', false);
// Give agents a real browser (Microsoft's Playwright MCP server) alongside
// Spacron's own tools, so an agent can open what it just built, read the page and
// fix what's wrong instead of guessing from the dev-server log.
//
// Defaults OFF, and the default matters: turning it on adds a `playwright` entry
// to agent config files — including the *global* ones for Codex and droid — and
// the server itself is `npx @playwright/mcp@latest`, which needs Node on PATH and
// downloads a browser on first run. None of that should happen to a user who
// never asked for it, so this is opt-in rather than opt-out.
export const agentBrowserTools = persistentWritable('agentBrowserTools', false);
// Computer use (docs/computer-use.md): agents may ask to see the user's desktop
// windows. OFF by default, and while off the tools are not even listed to
// agents. Even when on, every window needs the user's per-agent permission.
export const computerUse = persistentWritable('computerUse', false);
// Apps (image names like `slack.exe`) agents may never see or control, on top
// of the built-in list of password managers and security prompts.
export const computerUseBlockedApps = persistentWritable<string[]>('computerUseBlockedApps', []);

// ─── Failover on usage limits ───────────────────────────────────────────────
// When an agent is about to run out of usage mid-feature, move the unfinished
// work to one that still has headroom instead of letting it stop at the wall.
// The work stays in the same task, the same worktree and the same branch, so a
// handover changes who is typing and nothing else. See
// `services/orchestrator/agent-failover.ts` for the ladder and
// `agent-handover.ts` for what actually happens.
export const agentFailover = persistentWritable('agentFailover', true);
// Headroom, in percent, at which the work moves. The brief asked for "3-5%,
// mid-feature": switching *before* the wall is what leaves the outgoing agent
// enough left to be asked to wrap up and commit, which is the whole difference
// between a handover and a crash. Raising this towards 99 forces the path to
// fire on demand, which is how it gets exercised without staging a real limit.
export const agentFailoverHeadroomPercent = persistentWritable('agentFailoverHeadroomPercent', 4);
// Whether the ladder may cross to a *different* CLI on its own. A same-CLI
// account hop spends only the user's own plan and always happens; a
// cross-provider hop may spend money on a different service.
export const agentFailoverCrossProvider = persistentWritable('agentFailoverCrossProvider', true);
/**
 * User-managed MCP servers, handed to every agent CLI. Spacron's own server and
 * the Playwright one are not in here — they are owned by the app and by
 * `agentBrowserTools` respectively. See `services/mcp-servers.ts`.
 */
export const mcpServers = persistentWritable<McpServer[]>('mcpServers', []);

/** Image/video generation provider and models — see `services/media-generation.ts`. */
export const mediaGeneration = persistentWritable<MediaGenerationSettings>('mediaGeneration', DEFAULT_MEDIA_GENERATION);

// Hold an OS sleep inhibitor for as long as any agent is mid-turn, so a long
// unattended run isn't suspended halfway through by the machine's idle timer.
// The refcount, the platform calls and the "idle sleep only, never the display"
// rule all live in `services/keep-awake.ts` and `commands/keep_awake.rs`.
//
// Defaults OFF: overriding the machine's power policy is not something to do to
// a user who never asked, and on a laptop away from a charger it is the wrong
// trade. The hold is released the moment the last turn ends either way.
export const keepSystemAwake = persistentWritable('keepSystemAwake', false);

// Agent permissions & launch overrides — the Orca-style "Yolo" mode.
//
// `agentPermissionMode` is the global default for how agents are launched:
// 'yolo' appends each CLI's own bypass flag (Claude's `--dangerously-skip-
// permissions`, Codex's `--dangerously-bypass-approvals-and-sandbox`, ...) so
// the run never stalls on a permission prompt; 'manual' launches bare and the
// CLI asks as usual. Defaults to 'yolo', matching Orca's default behaviour.
//
// The three override maps are per-agent escapes from the global mode, keyed by
// the preset's launch command. An explicit value wins (including an empty
// string, which pins that agent to manual). See services/agent-permissions.ts.
//
// `AgentPermissionMode` itself lives in the service module — the single source
// of truth for the flag tables and the mode type — and is re-exported here so
// store consumers keep one import path.
import type { AgentPermissionMode } from '$lib/services/agent-permissions';
import type { CustomSkill } from '$lib/services/orchestrator/skills';
export type { AgentPermissionMode };
export const agentPermissionMode = persistentWritable<AgentPermissionMode>('agentPermissionMode', 'yolo');
export const agentCmdOverrides = persistentWritable<Record<string, string>>('agentCmdOverrides', {});
export const agentDefaultArgs = persistentWritable<Record<string, string>>('agentDefaultArgs', {});
export const agentDefaultEnv = persistentWritable<Record<string, Record<string, string>>>('agentDefaultEnv', {});

// Window
export type CloseBehavior = 'quit' | 'minimize';
export const closeBehavior = persistentWritable<CloseBehavior>('closeBehavior', 'quit');

// ── AI providers & models ──
// Voice refinement and AI commit messages route through one of several
// providers. Each provider has its own API key (or, for local providers, a
// server URL) and its own model list. Settings manages those connections; the
// Chat composer selects the provider/model that powers each orchestrator
// conversation. The Rust backend (`commands/secrets.rs`) calls each provider's
// native API directly.
//
// Local providers (Ollama, LM Studio) run on the user's own machine. They need
// a base URL instead of an API key and expose OpenAI-compatible endpoints, so
// the backend reuses its OpenAI-compatible request path with no auth header.
export type AiProviderId =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'groq'
  | 'xai'
  | 'deepseek'
  | 'mistral'
  | 'together'
  | 'fireworks'
  | 'cerebras'
  | 'nvidia'
  | 'moonshot'
  | 'sambanova'
  | 'perplexity'
  | 'cohere'
  | 'opencode'
  | 'opencode-go'
  | 'kilocode'
  | 'chatgpt'
  | 'ollama'
  | 'lmstudio'
  | 'local';

export type VoiceInputProviderId = 'webspeech' | 'google' | 'openai' | 'openrouter' | 'ollama' | 'lmstudio' | 'local';

export interface AiModelOption {
  id: string;
  label: string;
  description: string;
  free?: boolean;
  /** Live catalogues may include models whose protocol is not supported yet. */
  supported?: boolean;
  supportReason?: string;
}

export interface AiProviderDef {
  id: AiProviderId;
  label: string;
  /** Label shown above the key field, e.g. "OpenRouter API key". */
  keyLabel: string;
  /** Placeholder hinting at the key shape, e.g. "sk-or-...". */
  keyPlaceholder: string;
  /** Where the user can create a key (or, for local providers, install docs). */
  keyUrl: string;
  defaultModel: string;
  models: AiModelOption[];
  /**
   * Local providers run on the user's own machine and are configured with a
   * server URL instead of an API key. The model picker, readiness checks and
   * backend auth all branch on this flag.
   */
  local?: boolean;
  /**
   * Signed in through the user's own CLI instead of an API key. `chatgpt`
   * runs on their ChatGPT plan via the Codex CLI (`commands/chatgpt.rs`);
   * Settings shows a sign-in panel in place of the key field.
   */
  signIn?: 'chatgpt';
  /**
   * OpenAI-compatible base URL for local providers (root that owns
   * `/chat/completions` and `/models`), e.g. `http://localhost:11434/v1`.
   */
  defaultBaseUrl?: string;
}

/** Default model used by the signed-in ChatGPT subscription composer route. */
export const CHATGPT_DEFAULT_MODEL = 'gpt-5.6-luna';

export const aiProviders: AiProviderDef[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyLabel: 'OpenRouter API key',
    keyPlaceholder: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'google/gemini-2.5-flash',
    models: [
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Best balance of quality and speed.' },
      { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', description: 'Cheaper, faster fallback.' },
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Best overall quality.' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'Cheap, fast Claude.' },
      { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', description: 'Fast, polished rewrites.' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', description: 'Cheap OpenAI option.' },
      { id: 'qwen/qwen3-30b-a3b-instruct-2507', label: 'Qwen3 30B Instruct', description: 'Very cheap fallback.' },
      { id: 'qwen/qwen-2.5-7b-instruct', label: 'Qwen 2.5 7B Instruct', description: 'Ultra-cheap fallback.' },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', description: 'Free Google option.', free: true },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-3-5-haiku-latest',
    models: [
      { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', description: 'Fast and cheap, great for refinement.' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Newest fast Claude.' },
      { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet', description: 'Higher quality, pricier.' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI API',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o-mini',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Cheap, fast, capable.' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Improved mini model.' },
      { id: 'gpt-4o', label: 'GPT-4o', description: 'Flagship quality.' },
      { id: 'gpt-4.1', label: 'GPT-4.1', description: 'Highest quality OpenAI option.' },
      { id: 'gpt-5', label: 'GPT-5', description: 'Newest flagship reasoning model.' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Cheaper, faster GPT-5.' },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyLabel: 'Google AI API key',
    keyPlaceholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Best balance of quality and speed.' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', description: 'Cheaper, faster fallback.' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Highest quality Gemini option.' },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', description: 'Older, very cheap.' },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    keyLabel: 'Groq API key',
    keyPlaceholder: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', description: 'Higher quality, still fast.' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', description: 'Extremely fast and cheap.' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', description: 'Open-weight reasoning model.' },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', description: 'Smaller open-weight model.' },
    ],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    keyLabel: 'xAI API key',
    keyPlaceholder: 'xai-...',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    defaultModel: 'grok-4-6',
    models: [
      { id: 'grok-4-6', label: 'Grok 4.6', description: 'Newest flagship Grok model.' },
      { id: 'grok-4', label: 'Grok 4', description: 'Flagship reasoning model.' },
      { id: 'grok-3', label: 'Grok 3', description: 'Previous-generation flagship.' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini', description: 'Fast, cheaper Grok 3.' },
      { id: 'grok-2-1212', label: 'Grok 2', description: 'Previous-generation text model.' },
      { id: 'grok-2-vision', label: 'Grok 2 Vision', description: 'Vision-capable Grok model.' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyLabel: 'DeepSeek API key',
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', description: 'General chat model.' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', description: 'Deep reasoning model.' },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    keyLabel: 'Mistral API key',
    keyPlaceholder: '...',
    keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModel: 'mistral-small-latest',
    models: [
      { id: 'mistral-small-latest', label: 'Mistral Small', description: 'Fast general-purpose Mistral model.' },
      { id: 'mistral-medium-latest', label: 'Mistral Medium', description: 'Balanced quality and speed.' },
      { id: 'mistral-large-latest', label: 'Mistral Large', description: 'Highest quality Mistral model.' },
      { id: 'codestral-latest', label: 'Codestral', description: 'Mistral coding model.' },
    ],
  },
  {
    id: 'together',
    label: 'Together AI',
    keyLabel: 'Together API key',
    keyPlaceholder: '...',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', description: 'Fast hosted Llama through Together AI.' },
    ],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    keyLabel: 'Fireworks API key',
    keyPlaceholder: 'fw_...',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    defaultModel: 'accounts/fireworks/models/deepseek-v3p1',
    models: [
      { id: 'accounts/fireworks/models/deepseek-v3p1', label: 'DeepSeek V3.1', description: 'Fireworks-hosted reasoning and instruction model.' },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    keyLabel: 'Cerebras API key',
    keyPlaceholder: 'csk-...',
    keyUrl: 'https://cloud.cerebras.ai/platform',
    defaultModel: 'gpt-oss-120b',
    models: [
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', description: 'High-speed Cerebras inference.' },
    ],
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    keyLabel: 'NVIDIA API key',
    keyPlaceholder: 'nvapi-...',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    defaultModel: 'deepseek-ai/deepseek-v4-flash',
    models: [
      { id: 'deepseek-ai/deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Current NVIDIA-hosted chat model.' },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    keyLabel: 'Moonshot API key',
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    defaultModel: 'kimi-k2.6',
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6', description: 'Moonshot general and coding model.' },
    ],
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    keyLabel: 'SambaNova API key',
    keyPlaceholder: '...',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    models: [
      { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', description: 'SambaNova-hosted instruction model.' },
    ],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    keyLabel: 'Perplexity API key',
    keyPlaceholder: 'pplx-...',
    keyUrl: 'https://www.perplexity.ai/settings/api',
    defaultModel: 'sonar-pro',
    models: [
      { id: 'sonar-pro', label: 'Sonar Pro', description: 'Frontier search-grounded model.' },
      { id: 'sonar', label: 'Sonar', description: 'Fast search-grounded model.' },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', description: 'Search-grounded reasoning.' },
      { id: 'sonar-reasoning', label: 'Sonar Reasoning', description: 'Fast reasoning with search.' },
    ],
  },
  {
    id: 'cohere',
    label: 'Cohere',
    keyLabel: 'Cohere API key',
    keyPlaceholder: '...',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    defaultModel: 'command-a-03-2025',
    models: [
      { id: 'command-a-03-2025', label: 'Command A', description: 'Flagship efficient chat model.' },
      { id: 'command-r-plus-08-2024', label: 'Command R+', description: 'Complex RAG and agentic tasks.' },
      { id: 'command-r-08-2024', label: 'Command R', description: 'Balanced RAG model.' },
      { id: 'command-r7b-12-2024', label: 'Command R7B', description: 'Small, fast model.' },
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    keyLabel: 'OpenCode Zen API key',
    keyPlaceholder: '...',
    keyUrl: 'https://opencode.ai/zen',
    defaultModel: 'glm-5.3-flash',
    models: [
      // No free models here: OpenCode's free tier answers every client except
      // OpenCode itself with 403 FreeTierError, so it can never work from Spacron.
      { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', description: 'OpenCode Zen model using its chat-completions endpoint. Needs Zen balance.' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'OpenCode Zen model using its chat-completions endpoint. Needs Zen balance.' },
    ],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go subscription',
    keyLabel: 'OpenCode Go subscription key',
    keyPlaceholder: '...',
    keyUrl: 'https://opencode.ai/go',
    defaultModel: 'glm-5.3-flash',
    models: [
      { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', description: 'Uses the included OpenCode Go subscription allowance.' },
      { id: 'kimi-k3', label: 'Kimi K3', description: 'Kimi coding model through OpenCode Go.' },
    ],
  },
  {
    id: 'kilocode',
    label: 'Kilo Code',
    keyLabel: 'Kilo Code API key',
    keyPlaceholder: '...',
    keyUrl: 'https://app.kilo.ai',
    // Kilo Gateway is OpenRouter-compatible. A free Kilo account key unlocks
    // the `:free` models; the live list tags them from the id suffix.
    defaultModel: 'kilo-auto/free',
    models: [
      { id: 'kilo-auto/free', label: 'Auto (free)', description: 'Kilo routes each request to a free model.', free: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B', description: 'Free NVIDIA model with tool calling.', free: true },
      { id: 'deepseek/deepseek-v4-flash-0731:free', label: 'DeepSeek V4 Flash', description: 'Free DeepSeek model with a 1M context.', free: true },
      { id: 'qwen/qwen3.8-27b:free', label: 'Qwen 3.8 27B', description: 'Free Qwen model.', free: true },
    ],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT subscription',
    signIn: 'chatgpt',
    keyLabel: 'ChatGPT sign-in',
    keyPlaceholder: '',
    keyUrl: 'https://developers.openai.com/codex/cli',
    // Runs on the user's own ChatGPT plan through their Codex CLI. Keep this
    // explicit so a fresh composer does not fall back to another connection's
    // model or to a provider-specific default.
    defaultModel: CHATGPT_DEFAULT_MODEL,
    models: [
      { id: CHATGPT_DEFAULT_MODEL, label: 'GPT-5.6 Luna', description: 'Default model for the signed-in ChatGPT subscription.' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    local: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    keyLabel: 'Ollama server URL',
    keyPlaceholder: 'http://localhost:11434/v1',
    keyUrl: 'https://ollama.com/download',
    // Runs entirely on your machine. The model list is read live from your
    // server; these are common pulls shown until then.
    defaultModel: 'llama3.1',
    models: [
      { id: 'llama3.1', label: 'Llama 3.1', description: 'Meta Llama 3.1, a solid general default.' },
      { id: 'qwen2.5', label: 'Qwen 2.5', description: 'Strong general-purpose model.' },
      { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder', description: 'Tuned for code tasks.' },
      { id: 'gemma2', label: 'Gemma 2', description: 'Google Gemma 2, lightweight.' },
      { id: 'phi3', label: 'Phi-3', description: 'Small and fast Microsoft model.' },
      { id: 's1-mini', label: 'S1-mini by Superwhisper', description: 'Local English dictation cleanup; load it in Ollama first.' },
    ],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    local: true,
    defaultBaseUrl: 'http://localhost:1234/v1',
    keyLabel: 'LM Studio server URL',
    keyPlaceholder: 'http://localhost:1234/v1',
    keyUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    // The model id is whatever you've loaded in LM Studio's server tab; the
    // live list reflects your loaded models. `local-model` works as a generic
    // alias for the currently-loaded model.
    defaultModel: 'local-model',
    models: [
      { id: 'local-model', label: 'Loaded model', description: 'Uses whichever model LM Studio currently has loaded.' },
      { id: 's1-mini', label: 'S1-mini by Superwhisper', description: 'Local English dictation cleanup; load the GGUF in LM Studio first.' },
    ],
  },
  {
    id: 'local',
    label: 'Local (Offline)',
    local: true,
    defaultBaseUrl: '',
    keyLabel: '',
    keyPlaceholder: '',
    keyUrl: '',
    defaultModel: 'parakeet-tdt-v3',
    models: [
      { id: 'whisper-tiny-en', label: 'Whisper Tiny (English)', description: 'Fast offline Speech-to-Text.' },
      { id: 'whisper-base-en', label: 'Whisper Base (English)', description: 'Balanced offline Speech-to-Text.' },
      { id: 'whisper-small-en', label: 'Whisper Small (English)', description: 'Higher-accuracy offline Speech-to-Text.' },
      { id: 'whisper-large-v3-turbo-q5', label: 'Whisper Large v3 Turbo (Quantized)', description: 'Latest multilingual Speech-to-Text, compact.' },
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (Full)', description: 'Highest-accuracy multilingual Speech-to-Text.' },
      { id: 'parakeet-tdt-v3', label: 'NVIDIA Parakeet TDT v3', description: 'Fastest, top-accuracy multilingual Speech-to-Text (WASM).' },
    ],
  },
];

export function getProviderDef(id: AiProviderId): AiProviderDef {
  return aiProviders.find((p) => p.id === id) ?? aiProviders[0];
}

/**
 * What to tell someone whose selected provider is not connected yet, in one
 * sentence. Every "not connected" message uses this so the advice matches the
 * provider: a free Kilo account, a ChatGPT sign-in, a server URL or a key.
 */
export function providerSetupHint(id: AiProviderId): string {
  const def = getProviderDef(id);
  if (def.signIn === 'chatgpt') {
    return 'Open Settings → AI Connections → ChatGPT subscription and click "Sign in with ChatGPT" (it uses your ChatGPT plan through the Codex CLI, so no API key is needed).';
  }
  if (id === 'kilocode') {
    return "Kilo Code's free models only need a free account: sign up at app.kilo.ai, copy your API key from your Kilo profile, and paste it into Settings → AI Connections → Kilo Code. The \"Auto (free)\" model then works at no cost.";
  }
  if (def.local) {
    return `Check the ${def.keyLabel || `${def.label} server URL`} in Settings → AI Connections, and make sure ${def.label} is running.`;
  }
  return `Add the ${def.keyLabel || `${def.label} API key`} in Settings → AI Connections.`;
}

export interface VoiceOption {
  id: string;
  label: string;
  description: string;
}

export interface VoiceModelOption extends AiModelOption {
  voices?: VoiceOption[];
}

export const openRouterVoiceInputModels: AiModelOption[] = [
  { id: 'openai/gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe', description: 'Modern low-cost OpenAI STT.' },
  { id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe', description: 'Higher-quality OpenAI STT.' },
  { id: 'openai/whisper-1', label: 'OpenAI Whisper 1', description: 'Stable OpenRouter STT default.' },
  { id: 'openai/whisper-large-v3', label: 'Whisper Large v3', description: 'Higher-accuracy Whisper transcription.' },
  { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', description: 'Faster Whisper Large v3 variant.' },
  { id: 'mistralai/voxtral-mini-transcribe', label: 'Voxtral Mini Transcribe', description: 'Mistral transcription model.' },
  { id: 'microsoft/mai-transcribe-1.5', label: 'MAI-Transcribe 1.5', description: 'Microsoft transcription model.' },
  { id: 'nvidia/parakeet-tdt-0.6b-v3', label: 'Parakeet TDT 0.6B v3', description: 'NVIDIA ASR model.' },
  { id: 'qwen/qwen3-asr-flash-2026-02-10', label: 'Qwen3 ASR Flash', description: 'Fast Qwen speech recognition.' },
  { id: 'google/chirp-3', label: 'Google Chirp 3', description: 'Google speech recognition through OpenRouter.' },
];

export const openAiVoiceInputModels: AiModelOption[] = [
  { id: 'whisper-1', label: 'Whisper 1', description: 'OpenAI Whisper STT model.' },
];

export const localVoiceInputModels: AiModelOption[] = [
  { id: 'local-stt-model', label: 'Local STT model', description: 'Generic model id for an OpenAI-compatible /audio/transcriptions server.' },
  { id: 'whisper-1', label: 'Whisper 1', description: 'Common OpenAI-compatible Whisper alias.' },
  { id: 'whisper-large-v3', label: 'Whisper Large v3', description: 'Common local Whisper model id.' },
  { id: 'whisper.cpp', label: 'whisper.cpp', description: 'Common whisper.cpp server model id.' },
];

export function getVoiceInputModelOptions(provider: VoiceInputProviderId): AiModelOption[] {
  switch (provider) {
    case 'google':
      return getProviderDef('google').models.filter((model) => model.id.startsWith('gemini'));
    case 'openrouter':
      return openRouterVoiceInputModels;
    case 'openai':
      return openAiVoiceInputModels;
    case 'ollama':
    case 'lmstudio':
      return localVoiceInputModels;
    case 'local':
      return [
        { id: 'whisper-tiny-en', label: 'Whisper Tiny (English)', description: 'Fast offline Speech-to-Text.' },
        { id: 'whisper-base-en', label: 'Whisper Base (English)', description: 'Balanced offline Speech-to-Text.' },
        { id: 'whisper-small-en', label: 'Whisper Small (English)', description: 'Higher-accuracy offline Speech-to-Text.' },
        { id: 'whisper-large-v3-turbo-q5', label: 'Whisper Large v3 Turbo (Quantized)', description: 'Latest multilingual Speech-to-Text, compact.' },
        { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (Full)', description: 'Highest-accuracy multilingual Speech-to-Text.' },
        { id: 'parakeet-tdt-v3', label: 'NVIDIA Parakeet TDT v3', description: 'Fastest, top-accuracy multilingual Speech-to-Text (WASM).' },
      ];
    default:
      return [];
  }
}

export function getDefaultVoiceInputModel(provider: VoiceInputProviderId): string {
  switch (provider) {
    case 'google':
      return getProviderDef('google').defaultModel;
    case 'openrouter':
      return 'openai/whisper-1';
    case 'openai':
      return 'whisper-1';
    case 'ollama':
    case 'lmstudio':
      return 'local-stt-model';
    case 'local':
      return 'parakeet-tdt-v3';
    default:
      return '';
  }
}

export const voiceRefinementEnabled = persistentWritable('voiceRefinementEnabled', true);
/**
 * Custom vocabulary for the AI polish pass, comma-separated ("Spacron,
 * Parakeet, zustand, onnxruntime"). WhisperFlow's accuracy trick: speech
 * models mangle exactly the names that matter most to a developer, and no
 * generic prompt can know them. Injected into the refinement system prompt so
 * those terms are spelled exactly as written.
 */
export const dictationVocabulary = persistentWritable('dictationVocabulary', '');
/**
 * Smart VAD (Silero, native ONNX) for dictation turn detection. OFF by
 * default: it needs the ~2 MB Silero model downloaded, and until then (or on
 * any error) dictation falls back to the built-in level gate transparently.
 */
export const smartVadEnabled = persistentWritable('smartVadEnabled', false);
export const voiceInputProvider = persistentWritable<VoiceInputProviderId>('voiceInputProvider', 'local');
/**
 * Terminal transcription (Transcribe-to-Terminal hotkey): when on, the
 * transcript is submitted to the terminal as if Enter was pressed; when off,
 * it is only typed in.
 *
 * OFF by default. Auto-send fires a half-heard sentence at a live shell with no
 * chance to read it first, so sending is the opt-in and typing-only is the safe
 * landing. Turning it on is a deliberate click in Settings and it sticks — the
 * key is declared in `zustand/settings.ts`, which is what makes the persisted
 * value rehydrate at boot (it did not use to be, so this toggle silently reset
 * to on at every restart).
 */
export const transcriptionAutoSend = persistentWritable('transcriptionAutoSend', false);
export const voiceInputModelByProvider = persistentWritable<Record<string, string>>('voiceInputModelByProvider', {});
export const voiceAiProvider = persistentWritable<AiProviderId>('voiceAiProvider', 'groq');
export const voiceAiModelByProvider = persistentWritable<Record<string, string>>('voiceAiModelByProvider', {});

/**
 * Which engine powers the hands-free voice conversation:
 * - 'openai-realtime': one live speech-to-speech WebRTC call to OpenAI's
 *   Realtime API — much lower latency and natural barge-in, but requires an
 *   OpenAI API key and is billed on audio tokens.
 * - 'xai-realtime': the same experience over xAI's Grok Voice Agent API
 *   (OpenAI Realtime-compatible, WebSocket). Requires an xAI API key; billed
 *   flat per minute (~$0.05/min).
 * - 'openai-live': OpenAI GPT-Live over WebRTC. The voice model delegates
 *   project work to Spacron's existing orchestrator.
 */
export type VoiceConversationEngine = 'openai-realtime' | 'xai-realtime' | 'openai-live';
export const voiceConversationEngine = persistentWritable<VoiceConversationEngine>('voiceConversationEngine', 'openai-realtime');
export const openaiRealtimeModel = persistentWritable<string>('openaiRealtimeModel', 'gpt-realtime-2.1-mini');
export const openaiRealtimeVoice = persistentWritable<string>('openaiRealtimeVoice', 'marin');

export const openaiRealtimeModelOptions: VoiceModelOption[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 Mini', description: 'Fast and ~3× cheaper (~$10/$20 per 1M audio tokens). Good default for conversation.' },
  { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', description: 'Flagship speech-to-speech model (~$32/$64 per 1M audio tokens).' },
  { id: 'gpt-realtime-mini', label: 'GPT Realtime Mini (previous gen)', description: 'Previous-generation mini realtime model.' },
  { id: 'gpt-realtime', label: 'GPT Realtime (previous gen)', description: 'Previous-generation realtime model.' },
];

export const openaiRealtimeVoiceOptions: VoiceOption[] = [
  { id: 'marin', label: 'Marin', description: 'Natural conversational voice (recommended)' },
  { id: 'cedar', label: 'Cedar', description: 'Natural conversational voice (recommended)' },
  { id: 'alloy', label: 'Alloy', description: 'Neutral voice' },
  { id: 'ash', label: 'Ash', description: 'Male voice' },
  { id: 'ballad', label: 'Ballad', description: 'Male voice' },
  { id: 'coral', label: 'Coral', description: 'Female voice' },
  { id: 'echo', label: 'Echo', description: 'Male voice' },
  { id: 'sage', label: 'Sage', description: 'Female voice' },
  { id: 'shimmer', label: 'Shimmer', description: 'Female voice' },
  { id: 'verse', label: 'Verse', description: 'Male voice' },
];

export const openaiLiveModel = persistentWritable<string>('openaiLiveModel', 'gpt-live-1');
export const openaiLiveVoice = persistentWritable<string>('openaiLiveVoice', 'marin');

export const openaiLiveModelOptions: VoiceModelOption[] = [
  { id: 'gpt-live-1', label: 'GPT Live 1', description: 'Full-duplex voice conversation with delegated project work.' },
];

export const openaiLiveVoiceOptions: VoiceOption[] = openaiRealtimeVoiceOptions;

export const xaiRealtimeModel = persistentWritable<string>('xaiRealtimeModel', 'grok-voice-latest');
export const xaiRealtimeVoice = persistentWritable<string>('xaiRealtimeVoice', 'eve');

export const xaiRealtimeModelOptions: VoiceModelOption[] = [
  { id: 'grok-voice-latest', label: 'Grok Voice (latest)', description: 'Always points at the newest Grok realtime voice model. Flat ~$0.05/min.' },
  { id: 'grok-voice-think-fast-1.0', label: 'Grok Voice Think Fast 1.0', description: 'Pinned flagship Grok realtime voice model.' },
];

export const xaiRealtimeVoiceOptions: VoiceOption[] = [
  { id: 'eve', label: 'Eve', description: 'Default Grok voice' },
  { id: 'ara', label: 'Ara', description: 'Female voice' },
  { id: 'rex', label: 'Rex', description: 'Male voice' },
  { id: 'sal', label: 'Sal', description: 'Male voice' },
  { id: 'leo', label: 'Leo', description: 'Male voice' },
];

/**
 * When on, the orchestrator gives a soft audible nudge (a short chime) each
 * time an agent finishes/blocks/fails, independent of whether the voice
 * conversation overlay is open. The recap lives in the chat completion card;
 * during a live realtime voice call the model mentions it in a one-liner instead.
 */
export const announceAgentCompletions = persistentWritable<boolean>('announceAgentCompletions', true);

/** Built-in orchestrator skills the user switched off in Settings (by skill id). */
export const orchestratorDisabledSkills = persistentWritable<string[]>('orchestratorDisabledSkills', []);
/** Skills the user wrote themselves; see services/orchestrator/skills.ts. */
export const orchestratorCustomSkills = persistentWritable<CustomSkill[]>('orchestratorCustomSkills', []);

export const currentVoiceInputModel = derived(
  [voiceInputProvider, voiceInputModelByProvider],
  ([$provider, $map]) => {
    if ($provider === 'webspeech') return '';
    const remembered = $map[$provider];
    if (remembered && remembered.trim()) {
      const trimmed = remembered.trim();
      if ($provider === 'ollama' || $provider === 'lmstudio') return trimmed;
      if (getVoiceInputModelOptions($provider).some((model) => model.id === trimmed)) return trimmed;
    }
    return getDefaultVoiceInputModel($provider);
  }
);

export function setVoiceInputModel(provider: Exclude<VoiceInputProviderId, 'webspeech'>, modelId: string) {
  voiceInputModelByProvider.update((map) => ({ ...map, [provider]: modelId.trim() }));
}

export function voiceInputUsesModelTranscription(provider: VoiceInputProviderId): boolean {
  return provider === 'google' || provider === 'openai' || provider === 'openrouter' || provider === 'ollama' || provider === 'lmstudio' || provider === 'local';
}

export const currentVoiceAiModel = derived(
  [voiceAiProvider, voiceAiModelByProvider],
  ([$provider, $map]) => {
    const def = getProviderDef($provider);
    const remembered = $map[$provider];
    return remembered && remembered.trim() ? remembered : def.defaultModel;
  }
);

export function setVoiceAiModel(provider: AiProviderId, modelId: string) {
  voiceAiModelByProvider.update((map) => ({ ...map, [provider]: modelId }));
}


// Selected provider + per-provider remembered model choice.

// New installs start on the user's signed-in ChatGPT subscription. Existing
// persisted selections remain untouched, including per-thread choices.
export const aiProvider = persistentWritable<AiProviderId>('aiProvider', 'chatgpt');
export const aiModelByProvider = persistentWritable<Record<string, string>>('aiModelByProvider', {});

// Per-provider server URL, used only by local providers (Ollama, LM Studio).
// Empty means "fall back to the provider's defaultBaseUrl".
export const aiBaseUrlByProvider = persistentWritable<Record<string, string>>('aiBaseUrlByProvider', {});

// AI ghost text ("Cursor Tab"): faded inline code predictions accepted with Tab.
// Off by default — it streams surrounding code to an AI provider on every typing
// pause, so it's opt-in. Uses its own provider/model so completions can use a
// fast/cheap model independent of the main AI provider (commit msgs, voice).
export const aiGhostTextEnabled = persistentWritable('aiGhostTextEnabled', false);
export const aiCompletionProvider = persistentWritable<AiProviderId>('aiCompletionProvider', 'groq');
export const aiCompletionModelByProvider = persistentWritable<Record<string, string>>('aiCompletionModelByProvider', {});

/** Whether a provider runs locally and is configured by URL rather than key. */
export function isLocalProvider(id: AiProviderId): boolean {
  return getProviderDef(id).local === true;
}

/**
 * The effective server URL for a local provider: the user's override if set,
 * otherwise the provider's default. Returns '' for non-local providers.
 */
export function getProviderBaseUrl(id: AiProviderId, overrides?: Record<string, string>): string {
  const def = getProviderDef(id);
  if (!def.local) return '';
  const map = overrides ?? get(aiBaseUrlByProvider);
  const override = map[id];
  return (override && override.trim()) || def.defaultBaseUrl || '';
}

export function setProviderBaseUrl(id: AiProviderId, url: string) {
  aiBaseUrlByProvider.update((map) => ({ ...map, [id]: url.trim() }));
}

// One-time migration: fold the legacy single voice model into the new
// voice-specific provider + model stores so existing users keep their choice.
if (typeof localStorage !== 'undefined') {
  const legacy = localStorage.getItem('forge_setting_voiceRefinementModel');
  if (legacy) {
    try {
      const model = JSON.parse(legacy);
      if (typeof model === 'string' && model) {
        if (!localStorage.getItem('forge_setting_voiceAiProvider')) {
          voiceAiProvider.set('openrouter');
        }
        voiceAiModelByProvider.update((map) => (map.openrouter ? map : { ...map, openrouter: model }));
      }
    } catch {
      // Ignore malformed legacy value.
    }
    localStorage.removeItem('forge_setting_voiceRefinementModel');
  }

  // Spoken replies (TTS) were removed: speech-to-speech now runs only through a
  // realtime engine. Move anyone still on the deleted 'pipeline' engine onto
  // GPT Realtime -- leaving them there silently routed them to OpenAI anyway.
  if ((get(voiceConversationEngine) as string) === 'pipeline') {
    voiceConversationEngine.set('openai-realtime');
  }
}

// The active model id, derived from the selected provider and its remembered
// choice (falling back to the provider's default). The remembered id is trusted
// as-is: models are now loaded live from each provider, so a valid choice may
// not appear in the static curated `models` list.
export const currentAiModel = derived(
  [aiProvider, aiModelByProvider],
  ([$provider, $map]) => {
    const def = getProviderDef($provider);
    const remembered = $map[$provider];
    return remembered && remembered.trim() ? remembered : def.defaultModel;
  }
);

export function setAiModel(provider: AiProviderId, modelId: string) {
  aiModelByProvider.update((map) => ({ ...map, [provider]: modelId }));
}

// UI Scaling
export const uiZoom = persistentWritable('uiZoom', 100);
// UI font size is intentionally separate from the editor font size above. It
// changes application chrome and settings text while leaving code and terminal
// typography under their own controls.
export const uiFontSize = persistentWritable('uiFontSize', 14);

// Layout navigation
// A horizontal trackpad swipe (or shift + mouse wheel) slides between the
// ambient layout modes (Focus → Split → Gallery). Some users find it fires by
// accident while scrolling sideways, so it can be switched off here. Even when
// on, a swipe that starts inside the code editor never switches modes.
export const swipeNavigationEnabled = persistentWritable<boolean>('swipeNavigationEnabled', true);

// Code Formatting
export const formatOnSave = persistentWritable('formatOnSave', true);

// Editor autosave — saves the active file shortly after typing stops.
export const autoSave = persistentWritable('autoSave', true);

// Keyboard Shortcuts
export interface KeyboardShortcut {
  id: string;
  label: string;
  keys: string;
  action?: string; // For custom shortcuts: id of the app action (see shortcutActions) this key triggers
}

export interface ShortcutAction {
  id: string;
  label: string;
  category: string;
}

export const shortcutActions: ShortcutAction[] = [
  { id: 'commandPalette', label: 'Command Palette', category: 'View' },
  { id: 'openSettings',    label: 'Open Settings',   category: 'View' },
  { id: 'toggleProjectHUD', label: 'Toggle Projects Sidebar', category: 'View' },
  { id: 'toggleSidebar',  label: 'Toggle Sidebar',  category: 'View' },
  { id: 'toggleInteractionMode', label: 'Switch Code / Chat Mode', category: 'View' },
  // Id kept as-is so any saved custom binding keeps working; it opens the
  // new-project-folder prompt now that workspaces are gone.
  { id: 'newWorkspace',   label: 'Create Project', category: 'Project' },
  { id: 'goToTerminal',   label: 'Go to Terminal',     category: 'View' },
  { id: 'goToEditor',     label: 'Go to Editor',       category: 'View' },
  { id: 'goToPreview',    label: 'Go to Preview',      category: 'View' },
  // goToOrchestrator removed — Orchestrator panel no longer exists
  { id: 'goToReview',     label: 'Go to Code Review',  category: 'View' },
  { id: 'goToHttp',       label: 'Go to HTTP Client',  category: 'View' },
  { id: 'goToTasks',      label: 'Go to Tasks',        category: 'View' },
  { id: 'goToFleet',      label: 'Go to Agent Fleet', category: 'View' },
  { id: 'goToDb',         label: 'Go to Database Explorer', category: 'View' },
  { id: 'goToContainers', label: 'Go to Containers',   category: 'View' },
  { id: 'goToToolbox',    label: 'Go to Dev Toolbox',  category: 'View' },
  { id: 'openSearch',     label: 'Search in Files', category: 'View' },
  { id: 'openEnvManager', label: 'Environment Manager', category: 'Workspace' },
  { id: 'saveFile',       label: 'Save File',       category: 'File' },
  { id: 'openFolder',     label: 'Open Folder',     category: 'Workspace' },
  { id: 'newTerminal',    label: 'New Terminal Tab',category: 'Terminal' },
  { id: 'formatDocument', label: 'Format Document',       category: 'Editor' },
  { id: 'startProxy',     label: 'Start Preview Proxy', category: 'Preview' },
  { id: 'stopProxy',      label: 'Stop Preview Proxy', category: 'Preview' },
  { id: 'zoomIn',         label: 'Zoom In',         category: 'Window' },
  { id: 'zoomOut',        label: 'Zoom Out',        category: 'Window' },
  { id: 'resetZoom',      label: 'Reset Zoom',      category: 'Window' },
  { id: 'spawnAgent',     label: 'Spawn Agents',     category: 'Workspace' },
  // openDailyNote removed
  // toggleSketch removed
  { id: 'launchVoiceMode', label: 'Launch Voice Mode', category: 'Voice' },
  { id: 'transcribeToTerminal', label: 'Transcribe (speech to text)', category: 'Voice' },
  // Canvas actions removed with the Canvas view.
  { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', category: 'View' },
];

export const defaultShortcuts: KeyboardShortcut[] = [
  { id: 'commandPalette', label: 'Command Palette', keys: 'Ctrl+Shift+P' },
  { id: 'openSettings',    label: 'Open Settings',   keys: 'Ctrl+,' },
  { id: 'toggleProjectHUD', label: 'Toggle Projects Sidebar', keys: 'Ctrl+K' },
  { id: 'toggleSidebar',  label: 'Toggle Sidebar',  keys: 'Ctrl+B' },
  { id: 'toggleInteractionMode', label: 'Switch Code / Chat Mode', keys: 'Ctrl+Shift+J' },
  { id: 'newWorkspace',   label: 'Create Project', keys: 'Ctrl+N' },
  { id: 'goToTerminal',   label: 'Go to Terminal',     keys: 'Ctrl+`' },
  { id: 'goToEditor',     label: 'Go to Editor',       keys: 'Ctrl+E' },
  { id: 'goToPreview',    label: 'Go to Preview',      keys: 'Ctrl+Shift+V' },
  // goToOrchestrator removed — Orchestrator panel no longer exists
  { id: 'goToReview',     label: 'Go to Code Review',  keys: 'Ctrl+Shift+R' },
  { id: 'goToHttp',       label: 'Go to HTTP Client',  keys: 'Ctrl+Shift+H' },
  { id: 'goToTasks',      label: 'Go to Tasks',        keys: 'Ctrl+Shift+T' },
  { id: 'goToFleet',      label: 'Go to Agent Fleet', keys: 'Ctrl+Shift+G' },
  { id: 'goToDb',         label: 'Go to Database Explorer', keys: 'Ctrl+Shift+B' },
  { id: 'goToContainers', label: 'Go to Containers',   keys: 'Ctrl+Shift+C' },
  { id: 'goToToolbox',    label: 'Go to Dev Toolbox',  keys: 'Ctrl+Shift+X' },
  { id: 'openSearch',     label: 'Search in Files', keys: 'Ctrl+Shift+F' },
  { id: 'openEnvManager', label: 'Environment Manager', keys: 'Ctrl+Shift+E' },
  { id: 'saveFile',       label: 'Save File',       keys: 'Ctrl+S' },
  { id: 'openFolder',     label: 'Open Folder',     keys: 'Ctrl+O' },
  { id: 'newTerminal',    label: 'New Terminal Tab',keys: 'Ctrl+Shift+`' },
  { id: 'formatDocument', label: 'Format Document',       keys: 'Alt+Shift+F' },
  { id: 'startProxy',     label: 'Start Preview Proxy', keys: 'Ctrl+Alt+P' },
  { id: 'stopProxy',      label: 'Stop Preview Proxy', keys: 'Ctrl+Alt+O' },
  { id: 'zoomIn',         label: 'Zoom In',         keys: 'Ctrl+=' },
  { id: 'zoomOut',        label: 'Zoom Out',        keys: 'Ctrl+-' },
  { id: 'resetZoom',      label: 'Reset Zoom',      keys: 'Ctrl+0' },
  { id: 'spawnAgent',     label: 'Spawn Agents',     keys: 'Ctrl+Shift+A' },
  // openDailyNote removed
  // toggleSketch removed
  { id: 'launchVoiceMode', label: 'Launch Voice Mode', keys: 'Ctrl+Shift+M' },
  { id: 'transcribeToTerminal', label: 'Transcribe (speech to text)', keys: 'F9' },
  // canvasZoomIn / canvasZoomOut / canvasResetZoom removed with the Canvas view.
  { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', keys: 'Ctrl+Alt+A' },
];

export const userShortcuts = persistentWritable<KeyboardShortcut[]>('userShortcuts', defaultShortcuts);

export function parseShortcutString(str: string): string[] {
  const trimmed = str.trim();
  if (trimmed.endsWith('+') && trimmed.length > 1) {
    const lastPlus = trimmed.slice(0, -1).lastIndexOf('+');
    if (lastPlus !== -1) {
      const modifiersStr = trimmed.slice(0, lastPlus);
      const parts = modifiersStr.split('+').map(p => p.trim());
      parts.push('+');
      return parts;
    }
  }
  return trimmed.split('+').map(p => p.trim());
}

// Shifted punctuation → the unshifted character printed on the same key.
//
// `KeyboardEvent.key` reports the *produced* character, so `Ctrl+Shift+\`` -
// which is how "New Terminal Tab" is written - arrives as `~`, not as `` ` ``.
// Comparing the raw characters made every shortcut on a shifted punctuation key
// unreachable. Canonicalising both sides through this table is what lets a
// binding be written with the key cap the user actually presses.
const UNSHIFTED_PUNCTUATION: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
  '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

// `event.code` → the character that physical key prints on a US layout. Only
// consulted when `event.key` is not plain ASCII, which is the macOS case: Option
// (Alt) rewrites the produced character, so `Alt+Shift+F` arrives as `Ï` and
// nothing would ever match. Deliberately NOT the primary comparison — on a
// non-US layout `code` names the US key cap, so preferring it would fire the
// Ctrl+Q binding when an AZERTY user pressed Ctrl+A.
function keyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const punctuation: Record<string, string> = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Space: ' ',
  };
  return punctuation[code] ?? null;
}

function canonicalKey(key: string): string {
  const lower = key.toLowerCase();
  return UNSHIFTED_PUNCTUATION[lower] ?? lower;
}

export function matchShortcut(e: KeyboardEvent, shortcutKeys: string): boolean {
  if (!shortcutKeys) return false;
  const parts = parseShortcutString(shortcutKeys).map(p => p.toLowerCase());

  const hasCtrl = parts.includes('ctrl');
  const hasShift = parts.includes('shift');
  const hasAlt = parts.includes('alt');
  const hasMeta = parts.includes('meta');

  const modifiers = ['ctrl', 'shift', 'alt', 'meta'];
  const primaryKeyPart = parts.find(p => !modifiers.includes(p));
  if (!primaryKeyPart) return false;

  // A binding written with `Ctrl` matches Cmd on macOS, which is why Meta counts
  // as Ctrl here. A binding that names `Meta` explicitly is the exception: it
  // wants the Meta key specifically, so Ctrl is checked on its own.
  const isCtrlPressed = hasMeta ? e.ctrlKey : (e.ctrlKey || e.metaKey);
  const ctrlMatch = isCtrlPressed === hasCtrl;
  const shiftMatch = e.shiftKey === hasShift;
  const altMatch = e.altKey === hasAlt;
  const metaMatch = hasMeta ? e.metaKey : true;

  let keyMatch = false;
  const eventKeyLower = e.key.toLowerCase();
  const targetKeyLower = primaryKeyPart.toLowerCase();

  if (targetKeyLower === 'space') {
    keyMatch = eventKeyLower === ' ' || eventKeyLower === 'space';
  } else if (targetKeyLower === 'esc' || targetKeyLower === 'escape') {
    keyMatch = eventKeyLower === 'escape' || eventKeyLower === 'esc';
  } else {
    keyMatch = canonicalKey(eventKeyLower) === canonicalKey(targetKeyLower);
    if (!keyMatch && !/^[\x20-\x7e]$/.test(e.key)) {
      const fromCode = keyFromCode(e.code);
      keyMatch = fromCode !== null && canonicalKey(fromCode) === canonicalKey(targetKeyLower);
    }
  }

  return ctrlMatch && shiftMatch && altMatch && metaMatch && keyMatch;
}

// Appearance / Theme
export const appearance = persistentWritable<'system' | 'light' | 'dark'>('appearance', 'system');
// Empty means use the selected theme's default accent.
export const accentColor = persistentWritable<string>('accentColor', '');

// Global interface transparency (0 = solid, 100 = most see-through). Controls the
// frost/glass opacity of every surface — works with or without a background image,
// letting the desktop/acrylic (or the image) show through. Default 0.
export const interfaceTransparency = persistentWritable<number>('interfaceTransparency', 0);

// Background image — an optional personalization layer painted behind the frosted UI.
// The image file lives in the app data dir (managed by the Rust backend); this only
// tracks whether it's currently shown.
export const backgroundImageEnabled = persistentWritable<boolean>('backgroundImageEnabled', false);

// Background image appearance (Terax-style), independent of the global interface
// transparency. Opacity 0–100 dims the image against the desktop; blur 0–60px
// softens it for legibility. Pure CSS on the html::before layer — no backend.
export const backgroundImageOpacity = persistentWritable<number>('backgroundImageOpacity', 100);
export const backgroundImageBlur = persistentWritable<number>('backgroundImageBlur', 0);

// Terminal
export const terminalShell = persistentWritable<string>('terminalShell', ''); // empty = auto-detect
export const terminalCursorStyle = persistentWritable<'bar' | 'block' | 'underline'>('terminalCursorStyle', 'bar');
export const terminalScrollback = persistentWritable('terminalScrollback', 5000);
export const terminalFontSize = persistentWritable('terminalFontSize', 14);
// Canvas is the default — this line is the single source of truth for that; the
// zustand mirror in `stores/zustand/settings.ts` just repeats it.
//
// An earlier comment here claimed canvas and webgl ghost against our alpha-0
// background, on the theory that they clear a frame by painting the background
// over it and so erase nothing when it is fully transparent. That was measured
// and is not true at xterm 5.5.0 / addon-canvas 0.7.0 / addon-webgl 0.18.0: both
// renderers clear transparent cells to bare wallpaper, and both survive heavy
// streaming output, alt-screen enter/exit and a DPR-2 resize without residue.
// Transparency does not require the DOM renderer.
//
// Canvas rather than webgl because of a limit that IS real: a page gets 16 WebGL
// contexts in Chromium and the oldest are silently evicted past that. Panes never
// unmount while their session lives (`.spacron/memory/terminal-pane-lifetime.md`),
// so a busy workspace exceeds 16 and would start killing its longest-running
// agents' contexts. Canvas has no such ceiling. WebGL stays user-selectable and
// falls back via `onContextLoss`; DOM stays available as the no-GPU escape hatch.
export const terminalRenderer = persistentWritable<'webgl' | 'canvas' | 'dom'>('terminalRenderer', 'canvas');

// Legacy generic setter — no callers remain; settings are set through the
// per-key `persistentWritable` wrappers. Deliberately partial: new settings
// keys should NOT add a case here, they should be declared in the zustand
// store (`stores/zustand/settings.ts`) and read through their wrapper.
export function updateSetting(key: string, value: unknown) {
  switch (key) {
    case 'fontSize':         fontSize.set(value as number); break;
    case 'fontFamily':       fontFamily.set(value as string); break;
    case 'tabSize':          tabSize.set(value as number); break;
    case 'wordWrap':         wordWrap.set(value as boolean); break;
    case 'minimap':          minimap.set(value as boolean); break;
    case 'vimMode':          vimMode.set(value as boolean); break;
    case 'columnSelection':  columnSelection.set(value as boolean); break;
    case 'enableLsp':        enableLsp.set(value as boolean); break;
    case 'aiGhostTextEnabled': aiGhostTextEnabled.set(value as boolean); break;
    case 'aiCompletionProvider': aiCompletionProvider.set(value as AiProviderId); break;
    case 'aiCompletionModelByProvider': aiCompletionModelByProvider.set(value as Record<string, string>); break;
    case 'showHidden':       showHidden.set(value as boolean); break;
    case 'voiceRefinementEnabled': voiceRefinementEnabled.set(value as boolean); break;
    case 'dictationVocabulary': dictationVocabulary.set(value as string); break;
    case 'smartVadEnabled': smartVadEnabled.set(value as boolean); break;
    case 'voiceInputProvider': voiceInputProvider.set(value as VoiceInputProviderId); break;
    case 'voiceInputModelByProvider': voiceInputModelByProvider.set(value as Record<string, string>); break;
    case 'voiceAiProvider': voiceAiProvider.set(value as AiProviderId); break;
    case 'voiceAiModelByProvider': voiceAiModelByProvider.set(value as Record<string, string>); break;
    case 'voiceConversationEngine': voiceConversationEngine.set(value as VoiceConversationEngine); break;
    case 'openaiRealtimeModel': openaiRealtimeModel.set(value as string); break;
    case 'openaiRealtimeVoice': openaiRealtimeVoice.set(value as string); break;
    case 'openaiLiveModel': openaiLiveModel.set(value as string); break;
    case 'openaiLiveVoice': openaiLiveVoice.set(value as string); break;
    case 'xaiRealtimeModel': xaiRealtimeModel.set(value as string); break;
    case 'xaiRealtimeVoice': xaiRealtimeVoice.set(value as string); break;
    case 'aiProvider': aiProvider.set(value as AiProviderId); break;
    case 'aiModelByProvider': aiModelByProvider.set(value as Record<string, string>); break;
    case 'aiBaseUrlByProvider': aiBaseUrlByProvider.set(value as Record<string, string>); break;
    case 'uiZoom':           uiZoom.set(value as number); break;
    case 'uiFontSize':       uiFontSize.set(value as number); break;
    case 'swipeNavigationEnabled': swipeNavigationEnabled.set(value as boolean); break;
    case 'formatOnSave':     formatOnSave.set(value as boolean); break;
    case 'autoSave':         autoSave.set(value as boolean); break;
    case 'closeBehavior':    closeBehavior.set(value as CloseBehavior); break;
    case 'appearance':       appearance.set(value as 'system' | 'light' | 'dark'); break;
    case 'accentColor':      accentColor.set(value as string); break;
    case 'terminalShell':    terminalShell.set(value as string); break;
    case 'terminalFontSize': terminalFontSize.set(value as number); break;
    case 'terminalRenderer': terminalRenderer.set(value as 'webgl' | 'canvas' | 'dom'); break;
  }
}

export function resetSettingsToDefault() {
  fontSize.set(14);
  fontFamily.set(FONT_FALLBACK);
  tabSize.set(2);
  wordWrap.set(true);
  minimap.set(false);
  vimMode.set(false);
  columnSelection.set(true);
  enableLsp.set(true);
  showHidden.set(false);
  showSnapshotsTab.set(false);
  notificationsEnabled.set(true);
  agentWorktrees.set(true);
  autoStageAgentChanges.set(false);
  agentBrowserTools.set(false);
  keepSystemAwake.set(false);
  closeBehavior.set('quit');
  aiProvider.set('chatgpt');
  aiModelByProvider.set({});
  aiBaseUrlByProvider.set({});
  aiGhostTextEnabled.set(false);
  aiCompletionProvider.set('groq');
  aiCompletionModelByProvider.set({});
  voiceRefinementEnabled.set(false);
  voiceInputProvider.set('webspeech');
  voiceInputModelByProvider.set({});
  voiceAiProvider.set('groq');
  voiceAiModelByProvider.set({});
  voiceConversationEngine.set('openai-realtime');
  openaiRealtimeModel.set('gpt-realtime-2.1-mini');
  openaiRealtimeVoice.set('marin');
  openaiLiveModel.set('gpt-live-1');
  openaiLiveVoice.set('marin');
  xaiRealtimeModel.set('grok-voice-latest');
  xaiRealtimeVoice.set('eve');
  announceAgentCompletions.set(true);
  uiZoom.set(100);
  uiFontSize.set(14);
  swipeNavigationEnabled.set(true);
  formatOnSave.set(true);
  autoSave.set(false);
  userShortcuts.set(defaultShortcuts);
  appearance.set('system');
  accentColor.set('');
  interfaceTransparency.set(0);
  backgroundImageEnabled.set(false);
  backgroundImageOpacity.set(100);
  backgroundImageBlur.set(0);
  terminalShell.set('');
  terminalCursorStyle.set('bar');
  terminalScrollback.set(5000);
  terminalFontSize.set(14);
  terminalRenderer.set('canvas');
}
