import type { ChatReasoningEffort } from '$lib/types/chat';
import { capsFor } from '$lib/services/model-capabilities';

/**
 * The reasoning levels the orchestrator brain can ask for on a given
 * provider + model. An empty list means the model exposes no effort control,
 * and the composer hides the picker. The Rust side (`apply_reasoning` in
 * agent_turn.rs) turns the chosen level into each provider's own parameter,
 * so a level listed here must be one that provider's API accepts.
 */
export function reasoningLevelsFor(provider: string, model: string): ChatReasoningEffort[] {
  const known = builtInLevels(provider, model);
  if (known.length) return known;
  // No built-in rule for this provider or model, but its own model list says
  // a reasoning amount can be requested (learned in the background, see
  // services/model-capabilities.ts): offer the common three. If the provider
  // still rejects the parameter, Rust drops it and retries (downgrade_reasoning).
  return capsFor(provider, model)?.reasoningEffort === true ? ['low', 'medium', 'high'] : [];
}

function builtInLevels(provider: string, model: string): ChatReasoningEffort[] {
  const id = (model || '').toLowerCase();
  // Gateways prefix a vendor ("openai/gpt-5"); the family is what decides.
  const bare = id.slice(id.lastIndexOf('/') + 1);

  switch (provider) {
    case 'openrouter':
      // OpenRouter's unified `reasoning.effort`; ignored by models without it.
      return ['low', 'medium', 'high'];
    case 'chatgpt':
      return ['low', 'medium', 'high', 'xhigh'];
    case 'anthropic':
      return anthropicLevels(bare);
    case 'google':
      return googleLevels(bare);
    case 'xai':
      return /^grok-3-mini/.test(bare) ? ['low', 'high'] : [];
    case 'perplexity':
      return bare.includes('deep-research') ? ['low', 'medium', 'high'] : [];
    default:
      return openAiStyleLevels(bare);
  }
}

function openAiStyleLevels(model: string): ChatReasoningEffort[] {
  if (/^gpt-oss/.test(model)) return ['low', 'medium', 'high'];
  if (/^o[134](-|$)/.test(model)) return ['low', 'medium', 'high'];
  if (/^gpt-5(-mini|-nano)?$|^gpt-5-(mini|nano)-/.test(model)) return ['minimal', 'low', 'medium', 'high'];
  if (/^gpt-5\.1/.test(model)) return ['low', 'medium', 'high'];
  if (/^gpt-5(\.\d+)?/.test(model)) return ['low', 'medium', 'high', 'xhigh'];
  return [];
}

function anthropicLevels(model: string): ChatReasoningEffort[] {
  // Claude 3.5 and older have no extended thinking.
  if (/^claude-(instant|2|3-(opus|sonnet|haiku)|3-5)/.test(model)) return [];
  if (!model.startsWith('claude')) return [];
  // `max` is the Opus-class top effort; other models stop at high.
  return /opus|fable/.test(model) &&!/opus-4(-[015])?(-|$)/.test(model)
    ? ['low', 'medium', 'high', 'max']
    : ['low', 'medium', 'high'];
}

function googleLevels(model: string): ChatReasoningEffort[] {
  if (/^gemini-3.*pro/.test(model)) return ['low', 'high'];
  if (/^gemini-3/.test(model)) return ['minimal', 'low', 'medium', 'high'];
  if (/^gemini-2\.5/.test(model)) return ['low', 'medium', 'high'];
  return [];
}

export const REASONING_LABELS: Record<ChatReasoningEffort, string> = {
  default: 'Default',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** The effort to send, or undefined when the model has no such level. */
export function effectiveReasoningEffort(provider: string, model: string, effort?: ChatReasoningEffort): ChatReasoningEffort | undefined {
  if (!effort || effort === 'default') return undefined;
  return reasoningLevelsFor(provider, model).includes(effort) ? effort : undefined;
}
