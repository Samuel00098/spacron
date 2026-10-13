import { writable } from '$lib/stores/storeCompat';
import { loadJson } from '$lib/utils/storage';

/**
 * Which voice the chat's Read aloud button uses. `system` is the free voice
 * built into the OS; the cloud engines sound like a person and use the
 * matching key from the keychain (OpenAI's AI-connection key, or the
 * ElevenLabs key saved under Settings > Voice > Read aloud).
 */
export type ReadAloudEngine = 'system' | 'openai' | 'elevenlabs';

const KEY = 'spacron_read_aloud_v1';

export interface ReadAloudSettings {
  engine: ReadAloudEngine;
  /** Voice id per engine, so switching engines keeps each one's pick. */
  voices: Partial<Record<ReadAloudEngine, string>>;
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

function load(): ReadAloudSettings {
  const raw = loadJson<Partial<ReadAloudSettings>>(KEY, {});
  const engine = raw.engine === 'openai' || raw.engine === 'elevenlabs' ? raw.engine : 'system';
  return { engine, voices: typeof raw.voices === 'object' && raw.voices ? raw.voices : {} };
}

export const readAloudSettings = writable<ReadAloudSettings>(load());
readAloudSettings.subscribe((value) => {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Settings still apply this session. */ }
});

export function readAloudVoiceFor(settings: ReadAloudSettings, engine = settings.engine): string {
  return settings.voices[engine]
    ?? (engine === 'openai' ? 'marin' : engine === 'elevenlabs' ? ELEVENLABS_DEFAULT_VOICE : '');
}
