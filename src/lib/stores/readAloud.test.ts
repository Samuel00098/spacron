import { describe, expect, it } from 'vitest';
import { READ_ALOUD_ENGINES, readAloudModelFor, readAloudVoiceFor } from './readAloud';

describe('cloud speech defaults', () => {
  it.each([
    ['groq', 'canopylabs/orpheus-v1-english', 'troy'],
    ['google', 'gemini-3.8-flash-tts', 'Kore'],
  ] as const)('provides a usable default model and voice for %s', (engine, model, voice) => {
    expect(READ_ALOUD_ENGINES.some((entry) => entry.id === engine)).toBe(true);
    const settings = { engine, voices: {} };
    expect(readAloudModelFor(settings)).toBe(model);
    expect(readAloudVoiceFor(settings)).toBe(voice);
  });
});

describe('Fish Audio voices follow the speech model', () => {
  it('keeps a voice per model and falls back to the default voice', () => {
    const settings = { engine: 'fish' as const, voices: {}, models: { fish: 'drama-3' }, fishVoices: { 'drama-3': 'abc123', 's1': 'def456' } };
    expect(readAloudModelFor(settings)).toBe('drama-3');
    expect(readAloudVoiceFor(settings)).toBe('abc123');
    expect(readAloudVoiceFor({ ...settings, models: { fish: 's1' } })).toBe('def456');
    expect(readAloudVoiceFor({ ...settings, models: { fish: 's2-pro' } })).toBe('default');
  });
});
