import { writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

/** Speech for chat replies and agent completion announcements. */
export const READ_ALOUD_ENGINES = [
  { id: 'system', label: 'System voice (free)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'elevenlabs', label: 'ElevenLabs' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'openrouter', label: 'OpenRouter' },
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

export const READ_ALOUD_MODELS = {
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
  openrouter: 'eve',
  xai: 'eve',
};

function load(): ReadAloudSettings {
  const raw = loadJson<Partial<ReadAloudSettings>>(KEY, {});
  const engine = READ_ALOUD_ENGINES.find(({ id }) => id === raw.engine)?.id ?? 'system';
  return {
    engine,
    voices: typeof raw.voices === 'object' && raw.voices ? raw.voices : {},
    models: raw.models,
    openRouterVoices: raw.openRouterVoices,
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
  return settings.voices[engine] ?? DEFAULT_VOICES[engine];
}

export function readAloudModelFor(settings: ReadAloudSettings, engine: ReadAloudEngine = settings.engine): string {
  if (engine === 'elevenlabs' || engine === 'minimax') {
    return settings.models?.[engine] ?? READ_ALOUD_MODELS[engine][0].id;
  }
  return engine === 'openrouter' ? settings.models?.openrouter ?? OPENROUTER_DEFAULT_MODEL : '';
}
