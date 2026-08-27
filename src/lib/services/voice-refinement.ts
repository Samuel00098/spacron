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

/**
 * Ceiling on one provider/model attempt. The rewrite is the last thing between
 * the speaker and their words, so a provider that is merely slow must not hold
 * the transcript hostage — past this we move on and, if nothing answers in
 * time, the mechanical cleanup is delivered instead.
 */
const REFINE_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Ceiling on the whole fallback chain. Without it, four providers x several
 * models each, all timing out, add up to minutes of a pill saying
 * "Transcribing…" over text that was ready the entire time.
 */
const REFINE_TOTAL_BUDGET_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Refinement timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Words in a string, for the content-loss check below. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Reject a "rewrite" that threw away what the speaker said.
 *
 * Rule 11 of the system prompt is "nothing is lost", and models break it in
 * two ways that look identical from here: they summarize a long dictation, or
 * they run into the token ceiling and stop mid-thought. Either way the user
 * loses words they said out loud and has no way to know it happened — the text
 * that arrives reads perfectly well.
 *
 * The threshold is a compromise, and it is set where it is deliberately.
 * Genuine copy-editing of spoken English cuts a LOT — "um so I think we should
 * probably go ahead and like retry it you know" is half padding — so a strict
 * bar would throw away good rewrites and leave the user with the mechanical
 * cleanup for no reason. Halving the word count is about the floor of honest
 * tightening; summarization and truncation land far below it. Below half we
 * assume damage, because the failure modes are not symmetric: a rejected
 * rewrite costs polish, an accepted truncation costs the user their words.
 *
 * Short inputs are exempt: "um, yeah, do that" legitimately compresses hard,
 * and a ratio over a handful of words means nothing.
 */
export function refinementKeptTheContent(original: string, refined: string): boolean {
  const before = wordCount(original);
  const after = wordCount(refined);
  if (after === 0) return false;
  if (before < 12) return true;
  return after >= before * 0.5;
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

  const deadline = Date.now() + REFINE_TOTAL_BUDGET_MS;

  for (const provider of buildVoiceProviderOrder(preferredProvider)) {
    const local = isLocalProvider(provider);
    const hasApiKey = isProviderApiKeyConfiguredLocal(provider);
    const baseUrl = local ? getProviderBaseUrl(provider) : '';

    if (local ? !baseUrl : !hasApiKey) {
      continue;
    }

    for (const model of getCandidateModels(provider, rememberedVoiceModels)) {
      if (Date.now() >= deadline) return { text: locallyCleaned, aiRefined: false };
      try {
        const remaining = Math.max(0, deadline - Date.now());
        const remoteText = await withTimeout(
          requestRefinement(provider, model, baseUrl, locallyCleaned),
          Math.min(REFINE_ATTEMPT_TIMEOUT_MS, remaining),
        );
        const normalized = normalizeModelOutput(remoteText, preserveNewLines);
        if (!normalized) continue;
        // A rewrite that dropped a third of the words is not a rewrite. Try
        // the next candidate rather than handing the user a quietly truncated
        // version of what they said.
        if (!refinementKeptTheContent(locallyCleaned, normalized)) {
          console.warn('Discarded a transcript refinement that lost most of the content.');
          continue;
        }
        return { text: normalized, aiRefined: true };
      } catch {
        // Fall through to the next model/provider pair.
      }
    }
  }

  return { text: locallyCleaned, aiRefined: false };
}
