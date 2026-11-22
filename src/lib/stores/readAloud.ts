import { writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

/** Speech for chat replies and agent completion announcements. */
export const READ_ALOUD_ENGINES = [
  { id: 'system', label: 'System voice (free)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'elevenlabs', label: 'ElevenLabs' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'fish', label: 'Fish Audio' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'groq', label: 'Groq' },
  { id: 'google', label: 'Gemini' },
  { id: 'xai', label: 'Grok (xAI)' },
] as const;

export type ReadAloudEngine = typeof READ_ALOUD_ENGINES[number]['id'];
export type CloudReadAloudEngine = Exclude<ReadAloudEngine, 'system'>;

const KEY = 'spacron_read_aloud_v1';

export interface ReadAloudSettings {
  engine: ReadAloudEngine;
  /** Voice id per engine, so switching engines keeps each one's pick. */
  voices: Partial<Record<ReadAloudEngine, string>>;
  models?: Partial<Record<CloudReadAloudEngine, string>>;
  openRouterVoices?: Record<string, string>;
  /** Fish Audio voice per speech model, so each model keeps its own pick. */
  fishVoices?: Record<string, string>;
}

/** OpenAI's gpt-4o-mini-tts voices; Marin and Cedar are its most natural. */
export const OPENAI_READ_ALOUD_VOICES = [
  { id: 'marin', label: 'Marin' }, { id: 'cedar', label: 'Cedar' }, { id: 'coral', label: 'Coral' },
  { id: 'sage', label: 'Sage' }, { id: 'ash', label: 'Ash' }, { id: 'ballad', label: 'Ballad' },
  { id: 'alloy', label: 'Alloy' }, { id: 'echo', label: 'Echo' }, { id: 'fable', label: 'Fable' },
  { id: 'nova', label: 'Nova' }, { id: 'onyx', label: 'Onyx' }, { id: 'shimmer', label: 'Shimmer' },
  { id: 'verse', label: 'Verse' },
];

/** ElevenLabs' long-standing default voice, used until the live list loads. */
export const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

export const GROQ_READ_ALOUD_VOICES = ['troy', 'hannah', 'austin'].map((id) => ({ id, label: id }));
export const GEMINI_READ_ALOUD_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede'].map((id) => ({ id, label: id }));

/** Fish Audio speaks with its own default voice when no voice model is chosen. */
export const FISH_DEFAULT_VOICE = 'default';

export const READ_ALOUD_MODELS = {
  // Fish Audio selects the engine with a `model` header; it has no catalogue
  // endpoint, so the backend checks the key and returns this documented list.
  fish: [
    { id: 's2.1-pro', label: 'S2.1 Pro' },
    { id: 's2-pro', label: 'S2 Pro' },
    { id: 'drama-3', label: 'Drama 3 (expressive)' },
    { id: 's1', label: 'S1' },
    { id: 's2.1-pro-free', label: 'S2.1 Pro (free tier)' },
  ],
  openai: [{ id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS' }],
  groq: [{ id: 'canopylabs/orpheus-v1-english', label: 'Orpheus English' }],
  google: [{ id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS' }],
  elevenlabs: [
    { id: 'eleven_multilingual_v2', label: 'Eleven Multilingual v2' },
    { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5' },
    { id: 'eleven_turbo_v2_5', label: 'Eleven Turbo v2.5' },
  ],
  minimax: [
    { id: 'speech-2.8-turbo', label: 'Speech 2.8 Turbo' },
    { id: 'speech-2.8-hd', label: 'Speech 2.8 HD' },
    { id: 'speech-2.6-turbo', label: 'Speech 2.6 Turbo' },
    { id: 'speech-2.6-hd', label: 'Speech 2.6 HD' },
  ],
};

export const OPENROUTER_DEFAULT_MODEL = 'x-ai/grok-voice-tts-1.0';
export const XAI_READ_ALOUD_VOICES = ['Eve', 'Ara', 'Rex', 'Sal', 'Leo']
  .map((label) => ({ id: label.toLowerCase(), label }));

const DEFAULT_VOICES: Record<ReadAloudEngine, string> = {
  system: '',
  openai: 'marin',
  elevenlabs: ELEVENLABS_DEFAULT_VOICE,
  minimax: 'English_expressive_narrator',
  fish: FISH_DEFAULT_VOICE,
  openrouter: 'eve',
  xai: 'eve',
  groq: 'troy',
  google: 'Kore',
};

function load(): ReadAloudSettings {
  const raw = loadJson<Partial<ReadAloudSettings>>(KEY, {});
  const engine = READ_ALOUD_ENGINES.find(({ id }) => id === raw.engine)?.id ?? 'system';
  return {
    engine,
    voices: typeof raw.voices === 'object' && raw.voices ? raw.voices : {},
    models: raw.models,
    openRouterVoices: raw.openRouterVoices,
    fishVoices: typeof raw.fishVoices === 'object' && raw.fishVoices ? raw.fishVoices : undefined,
  };
}

export const readAloudSettings = writable<ReadAloudSettings>(load());
readAloudSettings.subscribe((value) => {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Settings still apply this session. */ }
});

export function readAloudVoiceFor(settings: ReadAloudSettings, engine = settings.engine): string {
  if (engine === 'openrouter') {
    const model = readAloudModelFor(settings, engine);
    return settings.openRouterVoices?.[model] ?? (model === OPENROUTER_DEFAULT_MODEL ? DEFAULT_VOICES.openrouter : '');
  }
  if (engine === 'fish') {
    return settings.fishVoices?.[readAloudModelFor(settings, engine)] ?? settings.voices.fish ?? DEFAULT_VOICES.fish;
  }
  return settings.voices[engine] ?? DEFAULT_VOICES[engine];
}

export function readAloudModelFor(settings: ReadAloudSettings, engine: ReadAloudEngine = settings.engine): string {
  if (engine === 'openai' || engine === 'elevenlabs' || engine === 'minimax' || engine === 'groq' || engine === 'google' || engine === 'fish') {
    return settings.models?.[engine] ?? READ_ALOUD_MODELS[engine][0].id;
  }
  return engine === 'openrouter' ? settings.models?.openrouter ?? OPENROUTER_DEFAULT_MODEL : '';
}
