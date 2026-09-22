import { describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { aiProvider, currentAiModel, fontSize, getProviderDef, resetSettingsToDefault } from './settings';

describe('settings resetSettingsToDefault', () => {
  it('resets font size to 14', () => {
    fontSize.set(20);
    expect(get(fontSize)).toBe(20);
    resetSettingsToDefault();
    expect(get(fontSize)).toBe(14);
  });

  it('uses the ChatGPT subscription and GPT-5.6 Luna as the chat defaults', () => {
    expect(getProviderDef('chatgpt').label).toBe('ChatGPT subscription');
    expect(getProviderDef('chatgpt').defaultModel).toBe('gpt-5.6-luna');
    expect(get(aiProvider)).toBe('chatgpt');
    expect(get(currentAiModel)).toBe('gpt-5.6-luna');

    resetSettingsToDefault();
    expect(get(aiProvider)).toBe('chatgpt');
    expect(get(currentAiModel)).toBe('gpt-5.6-luna');
  });
});
