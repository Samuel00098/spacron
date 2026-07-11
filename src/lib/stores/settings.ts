import { writable, derived, get } from '$lib/stores/storeCompat';
import { getAppFlag, setAppFlag } from '$lib/services/app-flags';
import { useSettingsStore } from './zustand/settings';

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
// Language-server-backed autocomplete, diagnostics and hover. Requires the
// relevant language server (rust-analyzer, typescript-language-server, …) on PATH.
export const enableLsp = persistentWritable('enableLsp', true);

// Explorer
export const showHidden = persistentWritable('showHidden', false);
export const showSnapshotsTab = persistentWritable('showSnapshotsTab', false);

// Notifications
export const notificationsEnabled = persistentWritable('notificationsEnabled', true);

// Window
export type CloseBehavior = 'quit' | 'minimize';
export const closeBehavior = persistentWritable<CloseBehavior>('closeBehavior', 'quit');

// ── AI providers & models ──
// Voice refinement and AI commit messages route through one of several
// providers. Each provider has its own API key (or, for local providers, a
// server URL) and its own model list; the model picker in Settings swaps to the
// selected provider's models. The Rust backend (`commands/secrets.rs`) calls
// each provider's native API directly.
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
  | 'ollama'
  | 'lmstudio'
  | 'local';

export type VoiceInputProviderId = 'webspeech' | 'google' | 'openai' | 'openrouter' | 'ollama' | 'lmstudio' | 'local';

export interface AiModelOption {
  id: string;
  label: string;
  description: string;
  free?: boolean;
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
  ttsSupport?: 'native' | 'self-hosted' | 'none';
  /**
   * Local providers run on the user's own machine and are configured with a
   * server URL instead of an API key. The model picker, readiness checks and
   * backend auth all branch on this flag.
   */
  local?: boolean;
  /**
   * OpenAI-compatible base URL for local providers (root that owns
   * `/chat/completions` and `/models`), e.g. `http://localhost:11434/v1`.
   */
  defaultBaseUrl?: string;
}

export const aiProviders: AiProviderDef[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyLabel: 'OpenRouter API key',
    keyPlaceholder: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'google/gemini-2.5-flash',
    ttsSupport: 'native',
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
    ttsSupport: 'none',
    models: [
      { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', description: 'Fast and cheap — great for refinement.' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Newest fast Claude.' },
      { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet', description: 'Higher quality, pricier.' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o-mini',
    ttsSupport: 'native',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Cheap, fast, capable.' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Improved mini model.' },
      { id: 'gpt-4o', label: 'GPT-4o', description: 'Flagship quality.' },
      { id: 'gpt-4.1', label: 'GPT-4.1', description: 'Highest quality OpenAI option.' },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    keyLabel: 'Google AI API key',
    keyPlaceholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-2.5-flash',
    ttsSupport: 'native',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Best balance of quality and speed.' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', description: 'Cheaper, faster fallback.' },
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
    ttsSupport: 'native',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', description: 'Higher quality, still fast.' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', description: 'Extremely fast and cheap.' },
    ],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    keyLabel: 'xAI API key',
    keyPlaceholder: 'xai-...',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    defaultModel: 'grok-4.3',
    ttsSupport: 'native',
    models: [
      { id: 'grok-4.3', label: 'Grok 4.3', description: 'Flagship — most intelligent, fastest, 1M context.' },
      { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning', description: 'Deep reasoning, 1M context.' },
      { id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 Non-Reasoning', description: 'Fast responses, 1M context.' },
      { id: 'grok-4.20-multi-agent-0309', label: 'Grok 4.20 Multi-Agent', description: 'Multi-agent orchestration, 1M context.' },
      { id: 'grok-build-0.1', label: 'Grok Build 0.1', description: 'Fast agentic coding model, 256k context.' },
      { id: 'grok-2-1212', label: 'Grok 2', description: 'Previous-generation text model.' },
      { id: 'grok-2-vision', label: 'Grok 2 Vision', description: 'Vision-capable Grok model.' },
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
    ttsSupport: 'self-hosted',
    // Runs entirely on your machine. The model list is read live from your
    // server; these are common pulls shown until then.
    defaultModel: 'llama3.1',
    models: [
      { id: 'llama3.1', label: 'Llama 3.1', description: 'Meta Llama 3.1, a solid general default.' },
      { id: 'qwen2.5', label: 'Qwen 2.5', description: 'Strong general-purpose model.' },
      { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder', description: 'Tuned for code tasks.' },
      { id: 'gemma2', label: 'Gemma 2', description: 'Google Gemma 2, lightweight.' },
      { id: 'phi3', label: 'Phi-3', description: 'Small and fast Microsoft model.' },
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
    ttsSupport: 'self-hosted',
    // The model id is whatever you've loaded in LM Studio's server tab; the
    // live list reflects your loaded models. `local-model` works as a generic
    // alias for the currently-loaded model.
    defaultModel: 'local-model',
    models: [
      { id: 'local-model', label: 'Loaded model', description: 'Uses whichever model LM Studio currently has loaded.' },
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
    ttsSupport: 'native',
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

export function getProviderTtsBadge(id: AiProviderId): string | null {
  const support = getProviderDef(id).ttsSupport ?? 'none';
  switch (support) {
    case 'native':
      return 'TTS';
    case 'self-hosted':
      return 'Self-hosted TTS';
    default:
      return null;
  }
}

export interface TtsVoiceOption {
  id: string;
  label: string;
  description: string;
}

export interface TtsModelOption extends AiModelOption {
  voices?: TtsVoiceOption[];
}

export const groqTtsVoiceOptions: TtsVoiceOption[] = [
  { id: 'austin', label: 'Austin', description: 'Male voice' },
  { id: 'daniel', label: 'Daniel', description: 'Male voice' },
  { id: 'troy', label: 'Troy', description: 'Male voice' },
  { id: 'autumn', label: 'Autumn', description: 'Female voice' },
  { id: 'diana', label: 'Diana', description: 'Female voice' },
  { id: 'hannah', label: 'Hannah', description: 'Female voice' },
];

export const openAiTtsVoiceOptions: TtsVoiceOption[] = [
  { id: 'alloy', label: 'Alloy', description: 'OpenAI built-in voice' },
  { id: 'ash', label: 'Ash', description: 'OpenAI built-in voice' },
  { id: 'ballad', label: 'Ballad', description: 'OpenAI built-in voice' },
  { id: 'coral', label: 'Coral', description: 'OpenAI built-in voice' },
  { id: 'echo', label: 'Echo', description: 'OpenAI built-in voice' },
  { id: 'fable', label: 'Fable', description: 'OpenAI built-in voice' },
  { id: 'onyx', label: 'Onyx', description: 'OpenAI built-in voice' },
  { id: 'nova', label: 'Nova', description: 'OpenAI built-in voice' },
  { id: 'sage', label: 'Sage', description: 'OpenAI built-in voice' },
  { id: 'shimmer', label: 'Shimmer', description: 'OpenAI built-in voice' },
  { id: 'verse', label: 'Verse', description: 'OpenAI built-in voice' },
  { id: 'marin', label: 'Marin', description: 'OpenAI built-in voice' },
  { id: 'cedar', label: 'Cedar', description: 'OpenAI built-in voice' },
];

export const googleTtsVoiceOptions: TtsVoiceOption[] = [
  { id: 'Zephyr', label: 'Zephyr', description: 'Bright' },
  { id: 'Puck', label: 'Puck', description: 'Upbeat' },
  { id: 'Charon', label: 'Charon', description: 'Informative' },
  { id: 'Kore', label: 'Kore', description: 'Firm' },
  { id: 'Fenrir', label: 'Fenrir', description: 'Excitable' },
  { id: 'Leda', label: 'Leda', description: 'Youthful' },
  { id: 'Orus', label: 'Orus', description: 'Firm' },
  { id: 'Aoede', label: 'Aoede', description: 'Breezy' },
  { id: 'Callirrhoe', label: 'Callirrhoe', description: 'Easy-going' },
  { id: 'Autonoe', label: 'Autonoe', description: 'Bright' },
  { id: 'Enceladus', label: 'Enceladus', description: 'Breathy' },
  { id: 'Iapetus', label: 'Iapetus', description: 'Clear' },
  { id: 'Umbriel', label: 'Umbriel', description: 'Easy-going' },
  { id: 'Algieba', label: 'Algieba', description: 'Smooth' },
  { id: 'Despina', label: 'Despina', description: 'Smooth' },
  { id: 'Erinome', label: 'Erinome', description: 'Clear' },
  { id: 'Algenib', label: 'Algenib', description: 'Gravelly' },
  { id: 'Rasalgethi', label: 'Rasalgethi', description: 'Informative' },
  { id: 'Laomedeia', label: 'Laomedeia', description: 'Upbeat' },
  { id: 'Achernar', label: 'Achernar', description: 'Soft' },
  { id: 'Alnilam', label: 'Alnilam', description: 'Firm' },
  { id: 'Schedar', label: 'Schedar', description: 'Even' },
  { id: 'Gacrux', label: 'Gacrux', description: 'Mature' },
  { id: 'Pulcherrima', label: 'Pulcherrima', description: 'Forward' },
  { id: 'Achird', label: 'Achird', description: 'Friendly' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi', description: 'Casual' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix', description: 'Gentle' },
  { id: 'Sadachbia', label: 'Sadachbia', description: 'Lively' },
  { id: 'Sadaltager', label: 'Sadaltager', description: 'Knowledgeable' },
  { id: 'Sulafat', label: 'Sulafat', description: 'Warm' },
];

const microsoftMaiVoiceOptions: TtsVoiceOption[] = [
  { id: 'en-US-Harper:MAI-Voice-2', label: 'Harper', description: 'English (US)' },
  { id: 'es-MX-Valeria:MAI-Voice-2', label: 'Valeria', description: 'Spanish (Mexico)' },
  { id: 'fr-FR-Soleil:MAI-Voice-2', label: 'Soleil', description: 'French (France)' },
  { id: 'de-DE-Klaus:MAI-Voice-2', label: 'Klaus', description: 'German (Germany)' },
];

const grokVoiceOptions: TtsVoiceOption[] = [
  { id: 'eve', label: 'Eve', description: 'Energetic, upbeat — great default' },
  { id: 'ara', label: 'Ara', description: 'Warm, friendly — conversational' },
  { id: 'rex', label: 'Rex', description: 'Confident, clear — professional' },
  { id: 'sal', label: 'Sal', description: 'Smooth, balanced — versatile' },
  { id: 'leo', label: 'Leo', description: 'Authoritative, strong — instructional' },
];

const zonosVoiceOptions: TtsVoiceOption[] = [
  { id: 'american_female', label: 'American Female', description: 'Zonos voice preset' },
  { id: 'american_male', label: 'American Male', description: 'Zonos voice preset' },
  { id: 'british_female', label: 'British Female', description: 'Zonos voice preset' },
  { id: 'british_male', label: 'British Male', description: 'Zonos voice preset' },
  { id: 'random', label: 'Random', description: 'Random Zonos voice' },
];

const sesameVoiceOptions: TtsVoiceOption[] = [
  { id: 'conversational_a', label: 'Conversational A', description: 'Conversational CSM voice' },
  { id: 'conversational_b', label: 'Conversational B', description: 'Conversational CSM voice' },
  { id: 'read_speech_a', label: 'Read Speech A', description: 'Narration CSM voice' },
  { id: 'read_speech_b', label: 'Read Speech B', description: 'Narration CSM voice' },
  { id: 'read_speech_c', label: 'Read Speech C', description: 'Narration CSM voice' },
  { id: 'read_speech_d', label: 'Read Speech D', description: 'Narration CSM voice' },
  { id: 'none', label: 'None', description: 'No fixed CSM voice' },
];

const orpheusVoiceOptions: TtsVoiceOption[] = [
  { id: 'tara', label: 'Tara', description: 'Orpheus voice' },
  { id: 'leah', label: 'Leah', description: 'Orpheus voice' },
  { id: 'jess', label: 'Jess', description: 'Orpheus voice' },
  { id: 'leo', label: 'Leo', description: 'Orpheus voice' },
  { id: 'dan', label: 'Dan', description: 'Orpheus voice' },
  { id: 'mia', label: 'Mia', description: 'Orpheus voice' },
  { id: 'zac', label: 'Zac', description: 'Orpheus voice' },
];

const kokoroVoiceOptions: TtsVoiceOption[] = [
  { id: 'af_alloy', label: 'Alloy', description: 'American female Kokoro voice' },
  { id: 'af_aoede', label: 'Aoede', description: 'American female Kokoro voice' },
  { id: 'af_bella', label: 'Bella', description: 'American female Kokoro voice' },
  { id: 'af_heart', label: 'Heart', description: 'American female Kokoro voice' },
  { id: 'af_jessica', label: 'Jessica', description: 'American female Kokoro voice' },
  { id: 'af_kore', label: 'Kore', description: 'American female Kokoro voice' },
  { id: 'af_nicole', label: 'Nicole', description: 'American female Kokoro voice' },
  { id: 'af_nova', label: 'Nova', description: 'American female Kokoro voice' },
  { id: 'af_river', label: 'River', description: 'American female Kokoro voice' },
  { id: 'af_sarah', label: 'Sarah', description: 'American female Kokoro voice' },
  { id: 'af_sky', label: 'Sky', description: 'American female Kokoro voice' },
  { id: 'am_adam', label: 'Adam', description: 'American male Kokoro voice' },
  { id: 'am_echo', label: 'Echo', description: 'American male Kokoro voice' },
  { id: 'am_eric', label: 'Eric', description: 'American male Kokoro voice' },
  { id: 'am_fenrir', label: 'Fenrir', description: 'American male Kokoro voice' },
  { id: 'am_liam', label: 'Liam', description: 'American male Kokoro voice' },
  { id: 'am_michael', label: 'Michael', description: 'American male Kokoro voice' },
  { id: 'am_onyx', label: 'Onyx', description: 'American male Kokoro voice' },
  { id: 'am_puck', label: 'Puck', description: 'American male Kokoro voice' },
  { id: 'bf_alice', label: 'Alice', description: 'British female Kokoro voice' },
  { id: 'bf_emma', label: 'Emma', description: 'British female Kokoro voice' },
  { id: 'bm_daniel', label: 'Daniel', description: 'British male Kokoro voice' },
  { id: 'bm_fable', label: 'Fable', description: 'British male Kokoro voice' },
];

const voxtralTtsVoiceOptions: TtsVoiceOption[] = [
  { id: 'en_paul_neutral', label: 'Paul Neutral', description: 'English voice' },
  { id: 'en_paul_happy', label: 'Paul Happy', description: 'English voice' },
  { id: 'en_paul_confident', label: 'Paul Confident', description: 'English voice' },
  { id: 'en_paul_cheerful', label: 'Paul Cheerful', description: 'English voice' },
  { id: 'gb_oliver_neutral', label: 'Oliver Neutral', description: 'British English voice' },
  { id: 'gb_oliver_curious', label: 'Oliver Curious', description: 'British English voice' },
  { id: 'gb_jane_neutral', label: 'Jane Neutral', description: 'British English voice' },
  { id: 'gb_jane_confident', label: 'Jane Confident', description: 'British English voice' },
  { id: 'fr_marie_neutral', label: 'Marie Neutral', description: 'French voice' },
  { id: 'fr_marie_happy', label: 'Marie Happy', description: 'French voice' },
];

export const openRouterTtsModelOptions: TtsModelOption[] = [
  { id: 'openai/gpt-4o-mini-tts-2025-12-15', label: 'OpenAI GPT-4o Mini TTS', description: 'OpenAI-compatible speech model.', voices: openAiTtsVoiceOptions },
  { id: 'mistralai/voxtral-mini-tts-2603', label: 'Mistral Voxtral Mini TTS', description: 'Expressive multilingual Voxtral speech.', voices: voxtralTtsVoiceOptions },
  { id: 'microsoft/mai-voice-2', label: 'Microsoft MAI-Voice-2', description: 'Azure-backed multilingual voices.', voices: microsoftMaiVoiceOptions },
  { id: 'x-ai/grok-voice-tts-1.0', label: 'Grok Voice TTS 1.0', description: 'xAI voice synthesis.', voices: grokVoiceOptions },
  { id: 'google/gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS Preview', description: 'Google Gemini speech through OpenRouter.', voices: googleTtsVoiceOptions },
  { id: 'zyphra/zonos-v0.1-hybrid', label: 'Zonos v0.1 Hybrid', description: 'Compact open speech model.', voices: zonosVoiceOptions },
  { id: 'zyphra/zonos-v0.1-transformer', label: 'Zonos v0.1 Transformer', description: 'Transformer Zonos speech model.', voices: zonosVoiceOptions },
  { id: 'sesame/csm-1b', label: 'Sesame CSM 1B', description: 'Conversational speech model.', voices: sesameVoiceOptions },
  { id: 'canopylabs/orpheus-3b-0.1-ft', label: 'Canopy Orpheus 3B', description: 'Expressive Orpheus voices.', voices: orpheusVoiceOptions },
  { id: 'hexgrad/kokoro-82m', label: 'Kokoro 82M', description: 'Fast low-cost TTS with many voices.', voices: kokoroVoiceOptions },
];

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

export function getTtsVoiceOptions(provider: AiProviderId): TtsVoiceOption[] {
  return getTtsVoiceOptionsForModel(provider, getDefaultTtsModel(provider));
}

export function getTtsVoiceOptionsForModel(provider: AiProviderId, modelId: string): TtsVoiceOption[] {
  switch (provider) {
    case 'openrouter': {
      const match = openRouterTtsModelOptions.find((model) => model.id === modelId);
      if (match?.voices) return match.voices;
      const idLc = modelId.toLowerCase();
      if (idLc.includes('kokoro')) return kokoroVoiceOptions;
      if (idLc.includes('voxtral')) return voxtralTtsVoiceOptions;
      if (idLc.includes('orpheus')) return orpheusVoiceOptions;
      if (idLc.includes('gemini') || idLc.includes('google')) return googleTtsVoiceOptions;
      return openAiTtsVoiceOptions;
    }
    case 'groq':
      return groqTtsVoiceOptions;
    case 'openai':
      return openAiTtsVoiceOptions;
    case 'google':
      return googleTtsVoiceOptions;
    case 'xai':
      return grokVoiceOptions;
    default:
      return [];
  }
}

export function getTtsModelOptions(provider: AiProviderId): TtsModelOption[] {
  switch (provider) {
    case 'openrouter':
      return openRouterTtsModelOptions;
    case 'groq':
      return [
        { id: 'canopylabs/orpheus-v1-english', label: 'Orpheus v1 English', description: 'Groq hosted Orpheus TTS.', voices: groqTtsVoiceOptions },
      ];
    case 'openai':
      return [
        { id: 'gpt-4o-mini-tts', label: 'GPT-4o Mini TTS', description: 'OpenAI speech model.', voices: openAiTtsVoiceOptions },
      ];
    case 'google':
      return [
        { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash Preview TTS', description: 'Google Gemini speech model.', voices: googleTtsVoiceOptions },
      ];
    case 'xai':
      return [
        { id: 'grok-voice-tts-1.0', label: 'Grok Voice TTS 1.0', description: 'xAI voice synthesis.', voices: grokVoiceOptions },
      ];
    default:
      return [];
  }
}

export function getDefaultTtsModel(provider: AiProviderId): string {
  switch (provider) {
    case 'openrouter':
      return 'openai/gpt-4o-mini-tts-2025-12-15';
    case 'groq':
      return 'canopylabs/orpheus-v1-english';
    case 'openai':
      return 'gpt-4o-mini-tts';
    case 'google':
      return 'gemini-2.5-flash-preview-tts';
    case 'xai':
      return 'grok-voice-tts-1.0';
    default:
      return 'local-tts-model';
  }
}

export function getDefaultTtsVoice(provider: AiProviderId): string {
  switch (provider) {
    case 'openrouter':
      return 'alloy';
    case 'groq':
      return 'austin';
    case 'openai':
      return 'alloy';
    case 'google':
      return 'Kore';
    case 'xai':
      return 'eve';
    default:
      return 'default';
  }
}

export function providerSupportsReplyTts(provider: AiProviderId): boolean {
  // Bundled 'local' (Kokoro) TTS was removed. Self-hosted OpenAI-compatible
  // servers (ollama/lmstudio) still support reply TTS via the tts_speak endpoint.
  return (
    provider === 'openrouter' ||
    provider === 'groq' ||
    provider === 'openai' ||
    provider === 'google' ||
    provider === 'xai' ||
    (isLocalProvider(provider) && provider !== 'local')
  );
}

export const voiceRefinementEnabled = persistentWritable('voiceRefinementEnabled', false);
export const voiceInputProvider = persistentWritable<VoiceInputProviderId>('voiceInputProvider', 'local');
export const voiceInputModelByProvider = persistentWritable<Record<string, string>>('voiceInputModelByProvider', {});
export const voiceAiProvider = persistentWritable<AiProviderId>('voiceAiProvider', 'groq');
export const voiceAiModelByProvider = persistentWritable<Record<string, string>>('voiceAiModelByProvider', {});
export const voiceConversationAiModelByProvider = persistentWritable<Record<string, string>>('voiceConversationAiModelByProvider', {});
export const voiceConversationTtsModelByProvider = persistentWritable<Record<string, string>>('voiceConversationTtsModelByProvider', {});
export const voiceConversationTtsVoiceByProvider = persistentWritable<Record<string, string>>('voiceConversationTtsVoiceByProvider', {});
/**
 * The provider that synthesizes spoken replies (TTS) and powers the brain
 * during voice conversations — one provider for both, keeping it simple.
 * The TTS model/voice maps above are keyed by provider, so each provider
 * remembers its own speech model + voice.
 */
export const voiceReplyProvider = persistentWritable<AiProviderId>('voiceReplyProvider', 'groq');
export const ttsVoice = persistentWritable<string>('ttsVoice', 'austin');

/**
 * Spoken-reply pacing and tone for the classic pipeline TTS. Which one takes
 * effect depends on the OpenAI/OpenRouter speech model, mirroring OpenAI's API:
 * - `voiceReplyTtsSpeed` (0.25–4.0) applies to the classic `tts-1`/`tts-1-hd`
 *   models, which accept a dedicated `speed` param.
 * - `voiceReplyTtsInstructions` applies to `gpt-4o-mini-tts` (the default),
 *   which ignores `speed` and instead takes free-text pacing/emotion guidance
 *   (e.g. "Warm, upbeat pair-programming tone at a brisk pace").
 * Both are ignored by providers/models that don't support them.
 */
export const voiceReplyTtsSpeed = persistentWritable<number>('voiceReplyTtsSpeed', 1);
export const voiceReplyTtsInstructions = persistentWritable<string>('voiceReplyTtsInstructions', '');

/**
 * Which engine powers the hands-free voice conversation:
 * - 'pipeline': the classic STT → orchestrator brain → TTS loop, works with
 *   any configured provider combination.
 * - 'openai-realtime': one live speech-to-speech WebRTC call to OpenAI's
 *   Realtime API — much lower latency and natural barge-in, but requires an
 *   OpenAI API key and is billed on audio tokens.
 * - 'xai-realtime': the same experience over xAI's Grok Voice Agent API
 *   (OpenAI Realtime-compatible, WebSocket). Requires an xAI API key; billed
 *   flat per minute (~$0.05/min).
 */
export type VoiceConversationEngine = 'pipeline' | 'openai-realtime' | 'xai-realtime';
export const voiceConversationEngine = persistentWritable<VoiceConversationEngine>('voiceConversationEngine', 'pipeline');
export const openaiRealtimeModel = persistentWritable<string>('openaiRealtimeModel', 'gpt-realtime-2.1-mini');
export const openaiRealtimeVoice = persistentWritable<string>('openaiRealtimeVoice', 'marin');

export const openaiRealtimeModelOptions: TtsModelOption[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 Mini', description: 'Fast and ~3× cheaper (~$10/$20 per 1M audio tokens). Good default for conversation.' },
  { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', description: 'Flagship speech-to-speech model (~$32/$64 per 1M audio tokens).' },
  { id: 'gpt-realtime-mini', label: 'GPT Realtime Mini (previous gen)', description: 'Previous-generation mini realtime model.' },
  { id: 'gpt-realtime', label: 'GPT Realtime (previous gen)', description: 'Previous-generation realtime model.' },
];

export const openaiRealtimeVoiceOptions: TtsVoiceOption[] = [
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

export const xaiRealtimeModel = persistentWritable<string>('xaiRealtimeModel', 'grok-voice-latest');
export const xaiRealtimeVoice = persistentWritable<string>('xaiRealtimeVoice', 'eve');

export const xaiRealtimeModelOptions: TtsModelOption[] = [
  { id: 'grok-voice-latest', label: 'Grok Voice (latest)', description: 'Always points at the newest Grok realtime voice model. Flat ~$0.05/min.' },
  { id: 'grok-voice-think-fast-1.0', label: 'Grok Voice Think Fast 1.0', description: 'Pinned flagship Grok realtime voice model.' },
];

export const xaiRealtimeVoiceOptions: TtsVoiceOption[] = [
  { id: 'eve', label: 'Eve', description: 'Default Grok voice' },
  { id: 'ara', label: 'Ara', description: 'Female voice' },
  { id: 'rex', label: 'Rex', description: 'Male voice' },
  { id: 'sal', label: 'Sal', description: 'Male voice' },
  { id: 'leo', label: 'Leo', description: 'Male voice' },
];

/**
 * When on, the orchestrator speaks a short status line aloud each time an agent
 * finishes/blocks/fails ("Codex finished: Add dark mode"), independent of whether
 * the voice conversation overlay is open. The detailed recap stays on-demand.
 */
export const announceAgentCompletions = persistentWritable<boolean>('announceAgentCompletions', true);

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

export const currentVoiceConversationAiModel = derived(
  [voiceReplyProvider, voiceConversationAiModelByProvider],
  ([$provider, $map]) => {
    const def = getProviderDef($provider);
    const remembered = $map[$provider];
    return remembered && remembered.trim() ? remembered : def.defaultModel;
  }
);

export function setVoiceConversationAiModel(provider: AiProviderId, modelId: string) {
  voiceConversationAiModelByProvider.update((map) => ({ ...map, [provider]: modelId }));
}

export const currentVoiceConversationTtsModel = derived(
  [voiceReplyProvider, voiceConversationTtsModelByProvider],
  ([$provider, $map]) => {
    const remembered = $map[$provider];
    return remembered && remembered.trim() ? remembered : getDefaultTtsModel($provider);
  }
);

export const currentVoiceConversationTtsVoice = derived(
  [voiceReplyProvider, voiceConversationTtsVoiceByProvider],
  ([$provider, $map]) => {
    const remembered = $map[$provider];
    return remembered && remembered.trim() ? remembered : getDefaultTtsVoice($provider);
  }
);

export function setVoiceConversationTtsModel(provider: AiProviderId, modelId: string) {
  voiceConversationTtsModelByProvider.update((map) => ({ ...map, [provider]: modelId.trim() }));
}

export function setVoiceConversationTtsVoice(provider: AiProviderId, voiceId: string) {
  voiceConversationTtsVoiceByProvider.update((map) => ({ ...map, [provider]: voiceId.trim() }));
}

// Selected provider + per-provider remembered model choice.

export const aiProvider = persistentWritable<AiProviderId>('aiProvider', 'openrouter');
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

  if (!localStorage.getItem('forge_setting_voiceConversationAiModelByProvider')) {
    const legacyModelMap = localStorage.getItem('forge_setting_aiModelByProvider');
    if (legacyModelMap) {
      try {
        const modelMap = JSON.parse(legacyModelMap);
        if (modelMap && typeof modelMap === 'object' && !Array.isArray(modelMap)) {
          voiceConversationAiModelByProvider.set(modelMap as Record<string, string>);
        }
      } catch {
        // Ignore malformed legacy value.
      }
    }
  }

  // Voice replies are synthesized with Groq's Orpheus TTS by default. Older builds
  // seeded this from the general "brain" provider, which could silently point voice
  // replies at a provider that can't speak at all. Force the Groq default once (a
  // guard flag means a later manual change in Settings still sticks).
  if (!localStorage.getItem('forge_migration_voiceReplyGroqDefault_v1')) {
    voiceReplyProvider.set('groq');
    localStorage.setItem('forge_migration_voiceReplyGroqDefault_v1', '1');
  }

  const legacyTtsVoice = localStorage.getItem('forge_setting_ttsVoice');
  if (legacyTtsVoice) {
    try {
      const voice = JSON.parse(legacyTtsVoice);
      if (!localStorage.getItem('forge_setting_voiceConversationTtsVoiceByProvider')) {
        const nextVoice = voice === 'Arista-PlayAI' ? 'austin' : voice;
        if (typeof nextVoice === 'string' && nextVoice) {
          voiceConversationTtsVoiceByProvider.set({ groq: nextVoice });
        }
      }
      if (voice === 'Arista-PlayAI') {
        ttsVoice.set('austin');
      }
    } catch {
      // Ignore malformed legacy value.
    }
  }

  voiceConversationTtsModelByProvider.update((map) => {
    if (map.google !== 'gemini-3.1-flash-tts-preview') return map;
    return {
      ...map,
      google: 'gemini-2.5-flash-preview-tts',
    };
  });
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

// Layout navigation
// A horizontal trackpad swipe (or shift + mouse wheel) slides between the
// ambient layout modes (Focus → Split → Gallery). Some users find it fires by
// accident while scrolling sideways, so it can be switched off here. Even when
// on, a swipe that starts inside the code editor never switches modes.
export const swipeNavigationEnabled = persistentWritable<boolean>('swipeNavigationEnabled', true);

// Code Formatting
export const formatOnSave = persistentWritable('formatOnSave', true);

// Keyboard Shortcuts
export interface KeyboardShortcut {
  id: string;
  label: string;
  keys: string;
  command?: string; // Custom shell command to run in active terminal
}

export interface ShortcutAction {
  id: string;
  label: string;
  category: string;
}

export const shortcutActions: ShortcutAction[] = [
  { id: 'commandPalette', label: 'Command Palette', category: 'View' },
  { id: 'openSettings',    label: 'Open Settings',   category: 'View' },
  { id: 'toggleProjectHUD', label: 'Toggle Project Launcher HUD', category: 'View' },
  { id: 'toggleSidebar',  label: 'Toggle Sidebar',  category: 'View' },
  { id: 'newWorkspace',   label: 'New Workspace',   category: 'Workspace' },
  { id: 'goToTerminal',   label: 'Go to Terminal',     category: 'View' },
  { id: 'goToEditor',     label: 'Go to Editor',       category: 'View' },
  { id: 'goToPreview',    label: 'Go to Preview',      category: 'View' },
  // goToOrchestrator removed — Orchestrator panel no longer exists
  { id: 'goToReview',     label: 'Go to Code Review',  category: 'View' },
  { id: 'goToHttp',       label: 'Go to HTTP Client',  category: 'View' },
  { id: 'goToTasks',      label: 'Go to Tasks',        category: 'View' },
  { id: 'goToDb',         label: 'Go to Database Explorer', category: 'View' },
  { id: 'goToContainers', label: 'Go to Containers',   category: 'View' },
  { id: 'goToToolbox',    label: 'Go to Dev Toolbox',  category: 'View' },
  { id: 'goToYoutube',    label: 'Go to YouTube',      category: 'View' },
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
  { id: 'quickCapture',  label: 'Quick Capture',     category: 'Workspace' },
  { id: 'spawnAgent',     label: 'Spawn Agents',     category: 'Workspace' },
  // openDailyNote removed
  // toggleSketch removed
  { id: 'launchVoiceMode', label: 'Launch Voice Mode', category: 'Voice' },
  { id: 'canvasZoomIn',   label: 'Canvas Zoom In', category: 'Canvas' },
  { id: 'canvasZoomOut',  label: 'Canvas Zoom Out', category: 'Canvas' },
  { id: 'canvasResetZoom', label: 'Canvas Reset Zoom', category: 'Canvas' },
  { id: 'cycleAmbientLayout', label: 'Cycle Ambient Layout', category: 'View' },
];

export const defaultShortcuts: KeyboardShortcut[] = [
  { id: 'commandPalette', label: 'Command Palette', keys: 'Ctrl+Shift+P' },
  { id: 'openSettings',    label: 'Open Settings',   keys: 'Ctrl+,' },
  { id: 'toggleProjectHUD', label: 'Toggle Project Launcher HUD', keys: 'Ctrl+K' },
  { id: 'toggleSidebar',  label: 'Toggle Sidebar',  keys: 'Ctrl+B' },
  { id: 'newWorkspace',   label: 'New Workspace',   keys: 'Ctrl+N' },
  { id: 'goToTerminal',   label: 'Go to Terminal',     keys: 'Ctrl+`' },
  { id: 'goToEditor',     label: 'Go to Editor',       keys: 'Ctrl+E' },
  { id: 'goToPreview',    label: 'Go to Preview',      keys: 'Ctrl+Shift+V' },
  // goToOrchestrator removed — Orchestrator panel no longer exists
  { id: 'goToReview',     label: 'Go to Code Review',  keys: 'Ctrl+Shift+R' },
  { id: 'goToHttp',       label: 'Go to HTTP Client',  keys: 'Ctrl+Shift+H' },
  { id: 'goToTasks',      label: 'Go to Tasks',        keys: 'Ctrl+Shift+T' },
  { id: 'goToDb',         label: 'Go to Database Explorer', keys: 'Ctrl+Shift+B' },
  { id: 'goToContainers', label: 'Go to Containers',   keys: 'Ctrl+Shift+C' },
  { id: 'goToToolbox',    label: 'Go to Dev Toolbox',  keys: 'Ctrl+Shift+X' },
  { id: 'goToYoutube',    label: 'Go to YouTube',      keys: 'Ctrl+Shift+Y' },
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
  { id: 'quickCapture',  label: 'Quick Capture',     keys: 'Ctrl+Shift+Space' },
  { id: 'spawnAgent',     label: 'Spawn Agents',     keys: 'Ctrl+Shift+A' },
  // openDailyNote removed
  // toggleSketch removed
  { id: 'launchVoiceMode', label: 'Launch Voice Mode', keys: 'Ctrl+Shift+M' },
  { id: 'canvasZoomIn',   label: 'Canvas Zoom In', keys: 'Alt+=' },
  { id: 'canvasZoomOut',  label: 'Canvas Zoom Out', keys: 'Alt+-' },
  { id: 'canvasResetZoom', label: 'Canvas Reset Zoom', keys: 'Alt+0' },
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
  
  const isCtrlPressed = e.ctrlKey || e.metaKey;
  const ctrlMatch = isCtrlPressed === hasCtrl;
  const shiftMatch = e.shiftKey === hasShift;
  const altMatch = e.altKey === hasAlt;
  const metaMatch = e.metaKey === hasMeta;
  
  let keyMatch = false;
  const eventKeyLower = e.key.toLowerCase();
  const targetKeyLower = primaryKeyPart.toLowerCase();
  
  if (targetKeyLower === 'space') {
    keyMatch = eventKeyLower === ' ' || eventKeyLower === 'space';
  } else if (targetKeyLower === 'esc' || targetKeyLower === 'escape') {
    keyMatch = eventKeyLower === 'escape' || eventKeyLower === 'esc';
  } else if (targetKeyLower === '+') {
    keyMatch = eventKeyLower === '+' || eventKeyLower === '=';
  } else if (targetKeyLower === '=') {
    keyMatch = eventKeyLower === '=' || eventKeyLower === '+';
  } else {
    keyMatch = eventKeyLower === targetKeyLower;
  }
  
  return ctrlMatch && shiftMatch && altMatch && keyMatch;
}

// Appearance / Theme
export const appearance = persistentWritable<'system' | 'light' | 'dark'>('appearance', 'system');

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

// Onboarding
export const onboardingCompleted = persistentWritable<boolean>('onboardingCompleted', false);

// The onboarding flag is mirrored to a durable backend file as well as
// localStorage: WebView localStorage flushes lazily and can lose the "completed"
// write when the OS is shut down abruptly, which made the tour re-appear on every
// relaunch. The backend file is the durable source of truth.
const ONBOARDING_FLAG = 'onboardingCompleted';

/** Mark onboarding complete in both localStorage and the durable backend store. */
export function markOnboardingCompleted() {
  onboardingCompleted.set(true);
  void setAppFlag(ONBOARDING_FLAG, 'true');
}

/** Reset onboarding so the tour shows again, clearing the durable flag too. */
export function markOnboardingIncomplete() {
  onboardingCompleted.set(false);
  void setAppFlag(ONBOARDING_FLAG, 'false');
}

/**
 * Reconcile the onboarding flag against the durable backend store on startup.
 * Recovers the "completed" state when localStorage lost it, and backfills the
 * backend for users who finished onboarding before this durable store existed.
 */
export async function reconcileOnboardingFlag() {
  const durable = await getAppFlag(ONBOARDING_FLAG);
  if (durable === 'true') {
    if (!get(onboardingCompleted)) onboardingCompleted.set(true);
  } else if (durable === null && get(onboardingCompleted)) {
    void setAppFlag(ONBOARDING_FLAG, 'true');
  }
}

// Terminal
export const terminalShell = persistentWritable<string>('terminalShell', ''); // empty = auto-detect
export const terminalCursorStyle = persistentWritable<'bar' | 'block' | 'underline'>('terminalCursorStyle', 'bar');
export const terminalScrollback = persistentWritable('terminalScrollback', 5000);
export const terminalFontSize = persistentWritable('terminalFontSize', 14);
export const terminalRenderer = persistentWritable<'webgl' | 'canvas' | 'dom'>('terminalRenderer', 'canvas');

export function updateSetting(key: string, value: unknown) {
  switch (key) {
    case 'fontSize':         fontSize.set(value as number); break;
    case 'fontFamily':       fontFamily.set(value as string); break;
    case 'tabSize':          tabSize.set(value as number); break;
    case 'wordWrap':         wordWrap.set(value as boolean); break;
    case 'minimap':          minimap.set(value as boolean); break;
    case 'vimMode':          vimMode.set(value as boolean); break;
    case 'enableLsp':        enableLsp.set(value as boolean); break;
    case 'aiGhostTextEnabled': aiGhostTextEnabled.set(value as boolean); break;
    case 'aiCompletionProvider': aiCompletionProvider.set(value as AiProviderId); break;
    case 'aiCompletionModelByProvider': aiCompletionModelByProvider.set(value as Record<string, string>); break;
    case 'showHidden':       showHidden.set(value as boolean); break;
    case 'voiceRefinementEnabled': voiceRefinementEnabled.set(value as boolean); break;
    case 'voiceInputProvider': voiceInputProvider.set(value as VoiceInputProviderId); break;
    case 'voiceInputModelByProvider': voiceInputModelByProvider.set(value as Record<string, string>); break;
    case 'voiceAiProvider': voiceAiProvider.set(value as AiProviderId); break;
    case 'voiceAiModelByProvider': voiceAiModelByProvider.set(value as Record<string, string>); break;
    case 'voiceConversationAiModelByProvider': voiceConversationAiModelByProvider.set(value as Record<string, string>); break;
    case 'voiceConversationTtsModelByProvider': voiceConversationTtsModelByProvider.set(value as Record<string, string>); break;
    case 'voiceConversationTtsVoiceByProvider': voiceConversationTtsVoiceByProvider.set(value as Record<string, string>); break;
    case 'voiceReplyProvider': voiceReplyProvider.set(value as AiProviderId); break;
    case 'voiceReplyTtsSpeed': voiceReplyTtsSpeed.set(value as number); break;
    case 'voiceReplyTtsInstructions': voiceReplyTtsInstructions.set(value as string); break;
    case 'voiceConversationEngine': voiceConversationEngine.set(value as VoiceConversationEngine); break;
    case 'openaiRealtimeModel': openaiRealtimeModel.set(value as string); break;
    case 'openaiRealtimeVoice': openaiRealtimeVoice.set(value as string); break;
    case 'xaiRealtimeModel': xaiRealtimeModel.set(value as string); break;
    case 'xaiRealtimeVoice': xaiRealtimeVoice.set(value as string); break;
    case 'aiProvider': aiProvider.set(value as AiProviderId); break;
    case 'aiModelByProvider': aiModelByProvider.set(value as Record<string, string>); break;
    case 'aiBaseUrlByProvider': aiBaseUrlByProvider.set(value as Record<string, string>); break;
    case 'uiZoom':           uiZoom.set(value as number); break;
    case 'swipeNavigationEnabled': swipeNavigationEnabled.set(value as boolean); break;
    case 'formatOnSave':     formatOnSave.set(value as boolean); break;
    case 'closeBehavior':    closeBehavior.set(value as CloseBehavior); break;
    case 'appearance':       appearance.set(value as 'system' | 'light' | 'dark'); break;
    case 'onboardingCompleted': onboardingCompleted.set(value as boolean); break;
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
  enableLsp.set(true);
  showHidden.set(false);
  showSnapshotsTab.set(false);
  notificationsEnabled.set(true);
  closeBehavior.set('quit');
  aiProvider.set('openrouter');
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
  voiceConversationAiModelByProvider.set({});
  voiceConversationTtsModelByProvider.set({});
  voiceConversationTtsVoiceByProvider.set({});
  voiceReplyProvider.set('groq');
  voiceReplyTtsSpeed.set(1);
  voiceReplyTtsInstructions.set('');
  voiceConversationEngine.set('pipeline');
  openaiRealtimeModel.set('gpt-realtime-2.1-mini');
  openaiRealtimeVoice.set('marin');
  xaiRealtimeModel.set('grok-voice-latest');
  xaiRealtimeVoice.set('eve');
  ttsVoice.set('austin');
  announceAgentCompletions.set(true);
  uiZoom.set(100);
  swipeNavigationEnabled.set(true);
  formatOnSave.set(true);
  userShortcuts.set(defaultShortcuts);
  appearance.set('system');
  interfaceTransparency.set(0);
  backgroundImageEnabled.set(false);
  backgroundImageOpacity.set(100);
  backgroundImageBlur.set(0);
  onboardingCompleted.set(false);
  void setAppFlag(ONBOARDING_FLAG, 'false');
  terminalShell.set('');
  terminalCursorStyle.set('bar');
  terminalScrollback.set(5000);
  terminalFontSize.set(14);
  terminalRenderer.set('canvas');
}

