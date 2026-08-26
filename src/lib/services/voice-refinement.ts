import { invoke } from '@tauri-apps/api/core';
import {
  voiceRefinementEnabled,
  dictationVocabulary,
  voiceInputProvider,
  voiceInputUsesModelTranscription,
  voiceAiProvider,
  voiceAiModelByProvider,
  getProviderDef,
  isLocalProvider,
  getProviderBaseUrl,
  type AiProviderId,
} from '$lib/stores/settings';
import { refineVoiceTranscript } from '$lib/services/voice-input';
import { get } from '$lib/stores/storeCompat';
import { isProviderApiKeyConfiguredLocal } from '$lib/services/ai-keychain';

const VOICE_FALLBACK_PROVIDERS: AiProviderId[] = ['groq', 'ollama', 'lmstudio', 'openrouter'];

export function buildVoiceProviderOrder(preferredProvider: AiProviderId): AiProviderId[] {
  return [preferredProvider, ...VOICE_FALLBACK_PROVIDERS].filter(
    (provider, index, all) => all.indexOf(provider) === index
  );
}

function getCandidateModels(provider: AiProviderId, rememberedModels: Record<string, string>) {
  const def = getProviderDef(provider);
  const primary = rememberedModels[provider]?.trim() || def.defaultModel;
  const curated = def.models.map((m) => m.id).filter((id) => id !== primary);
  return [primary, ...curated];
}
function normalizeModelOutput(text: string, preserveNewLines: boolean) {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/^```(?:text|markdown)?\s*([\s\S]*?)\s*```$/i);
  const unwrapped = fenced?.[1]?.trim() ?? trimmed;

  const locallyCleaned = refineVoiceTranscript(unwrapped, { allowNewLines: preserveNewLines });
  return locallyCleaned || unwrapped;
}

function getPreserveNewLines(rawText: string) {
  return rawText.includes('\n');
}

async function requestRefinement(provider: string, model: string, baseUrl: string, cleanedText: string) {
  return invoke<string>('ai_refine_prompt', {
    text: cleanedText,
    provider,
    model,
    apiKey: '',
    baseUrl: baseUrl || undefined,
    // The developer's own terms (project names, libraries, coworkers) — the
    // backend appends them to the system prompt so they are spelled exactly.
    // Empty list simply means no extra instruction.
    vocabulary: get(dictationVocabulary).trim() || undefined,
  });
}

export type RefinementResult = { text: string; aiRefined: boolean };
export type RefineVoicePromptOptions = {
  aiRefinement?: boolean;
  /**
   * The default gate refuses AI refinement whenever voice INPUT runs through a
   * model provider (the old assumption: model STT output is already clean, and
   * the conversational loop must stay fast). Dictation quality work wants
   * polish regardless of which STT engine produced the text, so the F9 path
   * passes this flag; nothing else changes for existing callers.
   */
  allowForModelProviders?: boolean;
};

export async function refineVoicePrompt(
  rawText: string,
  options: RefineVoicePromptOptions = {}
): Promise<RefinementResult> {
  const { aiRefinement = true, allowForModelProviders = false } = options;
  const preserveNewLines = getPreserveNewLines(rawText);
  const locallyCleaned = refineVoiceTranscript(rawText, { allowNewLines: preserveNewLines });

  if (!locallyCleaned) return { text: '', aiRefined: false };
  if (!allowForModelProviders && voiceInputUsesModelTranscription(get(voiceInputProvider))) {
    return { text: locallyCleaned, aiRefined: false };
  }
  if (!aiRefinement || !get(voiceRefinementEnabled)) {
    return { text: locallyCleaned, aiRefined: false };
  }

  const preferredProvider = get(voiceAiProvider);
  const rememberedVoiceModels = get(voiceAiModelByProvider);

  for (const provider of buildVoiceProviderOrder(preferredProvider)) {
    const local = isLocalProvider(provider);
    const hasApiKey = isProviderApiKeyConfiguredLocal(provider);
    const baseUrl = local ? getProviderBaseUrl(provider) : '';

    if (local ? !baseUrl : !hasApiKey) {
      continue;
    }

    for (const model of getCandidateModels(provider, rememberedVoiceModels)) {
      try {
        const remoteText = await requestRefinement(provider, model, baseUrl, locallyCleaned);
        const normalized = normalizeModelOutput(remoteText, preserveNewLines);
        if (normalized) {
          return { text: normalized, aiRefined: true };
        }
      } catch {
        // Fall through to the next model/provider pair.
      }
    }
  }

  return { text: locallyCleaned, aiRefined: false };
}
