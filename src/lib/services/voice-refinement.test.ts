import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => undefined));
const isProviderApiKeyConfiguredLocal = vi.hoisted(() =>
  vi.fn((_provider: string): boolean => false)
);

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/services/ai-keychain', () => ({ isProviderApiKeyConfiguredLocal }));

import { buildVoiceProviderOrder, refineVoicePrompt } from './voice-refinement';
import {
  dictationVocabulary,
  voiceAiModelByProvider,
  voiceAiProvider,
  voiceInputProvider,
  voiceRefinementEnabled,
} from '$lib/stores/settings';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (_command: string, args: { provider: string; model: string }) => {
    if (args.provider === 'openrouter') {
      return '  Write the thing clearly.  ';
    }
    throw new Error(`missing ${args.provider}/${args.model}`);
  });

  // Only OpenRouter has a key configured.
  isProviderApiKeyConfiguredLocal.mockImplementation((provider: string) => provider === 'openrouter');

  voiceRefinementEnabled.set(true);
  dictationVocabulary.set('');
  voiceInputProvider.set('webspeech');
  voiceAiProvider.set('groq');
  voiceAiModelByProvider.set({});
});

afterEach(() => {
  voiceRefinementEnabled.set(true);
  dictationVocabulary.set('');
  voiceInputProvider.set('webspeech');
  voiceAiProvider.set('groq');
  voiceAiModelByProvider.set({});
});

describe('voice refinement provider chain', () => {
  it('prefers Groq, then local providers, then OpenRouter', () => {
    expect(buildVoiceProviderOrder('groq')).toEqual(['groq', 'ollama', 'lmstudio', 'openrouter']);
    expect(buildVoiceProviderOrder('openrouter')).toEqual(['openrouter', 'groq', 'ollama', 'lmstudio']);
    expect(buildVoiceProviderOrder('lmstudio')).toEqual(['lmstudio', 'groq', 'ollama', 'openrouter']);
  });

  it('falls back to OpenRouter when Groq is unavailable', async () => {
    const result = await refineVoicePrompt('um please clean this up');

    expect(result).toEqual({ text: 'Write the thing clearly.', aiRefined: true });
    expect(invoke.mock.calls.some(([, args]) => (args as { provider: string }).provider === 'openrouter')).toBe(true);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ provider: 'ollama' });
  });

  it('can skip AI refinement and keep only the local cleanup', async () => {
    const result = await refineVoicePrompt('um please clean this up', { aiRefinement: false });

    // The mechanical pass now strips hesitation fillers too — that is part of
    // "local cleanup", not the AI stage.
    expect(result).toEqual({ text: 'please clean this up', aiRefined: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips AI refinement when Google voice input is active', async () => {
    voiceInputProvider.set('google');

    const result = await refineVoicePrompt('please transcribe this exactly');

    expect(result).toEqual({ text: 'please transcribe this exactly', aiRefined: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * The dictation path polishes prose regardless of which STT engine produced
   * it; only it may bypass the model-provider gate.
   */
  it('lets the dictation path polish even when model transcription is active', async () => {
    voiceInputProvider.set('google');

    const result = await refineVoicePrompt('please transcribe this exactly', {
      allowForModelProviders: true,
    });

    expect(result).toEqual({ text: 'Write the thing clearly.', aiRefined: true });
    expect(invoke).toHaveBeenCalled();
  });

  /** WhisperFlow's hotword trick: the user's own terms ride along to the model. */
  it('passes the custom vocabulary list to the polish call', async () => {
    dictationVocabulary.set('Spacron, Parakeet');

    await refineVoicePrompt('clean this up');

    const refineCall = invoke.mock.calls.at(-1)!;
    expect((refineCall[1] as Record<string, unknown>).vocabulary).toBe('Spacron, Parakeet');
  });

  it('sends no vocabulary instruction when the list is empty', async () => {
    await refineVoicePrompt('clean this up');

    const refineCall = invoke.mock.calls.at(-1)!;
    expect((refineCall[1] as Record<string, unknown>).vocabulary).toBeUndefined();
  });
});
