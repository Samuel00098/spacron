import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { readAloudSettings } from '$lib/stores/readAloud';
import { previewReadAloud, speakableText, speakText, speechChunks, stopReadAloud } from './read-aloud';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('read aloud', () => {
  it('reads Markdown as prose: code is announced, icons dropped, list items pause', () => {
    const text = speakableText('## Plan\n\n- Read the file\n- Fix it 🟢\n\n```ts\nconst a = 1;\n```\n\nSee [the docs](https://x.dev).');
    expect(text).toBe('Plan. Read the file. Fix it. (code sample) See the docs.');
  });

  it('packs sentences into short pieces and splits a run-on sentence', () => {
    const chunks = speechChunks('One. Two. Three.', 10);
    expect(chunks).toEqual(['One. Two.', 'Three.']);
    const long = speechChunks(`${'word '.repeat(80).trim()}.`, 60);
    expect(long.every((chunk) => chunk.length <= 60)).toBe(true);
    expect(long.join(' ')).toBe(`${'word '.repeat(80).trim()}.`);
  });

  it('reads successive completions without interrupting the first announcement', () => {
    const previous = get(readAloudSettings);
    class Utterance {
      onend?: () => void;
      constructor(readonly text: string) {}
    }
    const speak = vi.fn<(utterance: Utterance) => void>();
    vi.stubGlobal('window', { speechSynthesis: { getVoices: () => [], cancel: vi.fn(), speak } });
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    readAloudSettings.set({ ...previous, engine: 'system' });
    try {
      speakText('Iris finished.');
      speakText('Nova finished.');
      expect(speak.mock.calls.map(([line]) => line.text)).toEqual(['Iris finished.']);
      speak.mock.calls[0][0].onend?.();
      expect(speak.mock.calls.map(([line]) => line.text)).toEqual(['Iris finished.', 'Nova finished.']);
    } finally {
      stopReadAloud();
      vi.unstubAllGlobals();
      readAloudSettings.set(previous);
    }
  });

  it('uses the selected OpenRouter model and its voice for preview and completion', () => {
    const previous = get(readAloudSettings);
    const model = 'microsoft/mai-voice-2.1';
    const voice = 'en-US-Harper:MAI-Voice-2.1';
    vi.mocked(invoke).mockRejectedValue(new Error('No network in this test'));
    readAloudSettings.set({
      engine: 'openrouter',
      models: { openrouter: model },
      voices: {},
      openRouterVoices: { [model]: voice },
    });
    try {
      previewReadAloud();
      expect(invoke).toHaveBeenLastCalledWith('read_aloud_speak', expect.objectContaining({ provider: 'openrouter', model, voice }));
      speakText('Agent finished.');
      expect(invoke).toHaveBeenLastCalledWith('read_aloud_speak', { provider: 'openrouter', model, voice, text: 'Agent finished.' });
    } finally {
      stopReadAloud();
      readAloudSettings.set(previous);
      vi.mocked(invoke).mockReset();
    }
  });
});
