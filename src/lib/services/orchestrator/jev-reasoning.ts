import type { ChatReasoningEffort } from '$lib/types/chat';
import { classifyDecision, confidentChoice } from '$lib/services/jev';
import { reasoningLevelsFor } from './reasoning-levels';

/** An optional suggestion for the current prompt; never overrides a saved or explicit choice. */
export async function suggestReasoningLevel(
  prompt: string,
  provider: string,
  model: string,
): Promise<ChatReasoningEffort | null> {
  const levels = reasoningLevelsFor(provider, model);
  if (!levels.length) return null;
  const descriptions: Record<string, string> = {
    default: 'Use the model default effort',
    minimal: 'Very simple, short task with little analysis',
    low: 'Straightforward task with limited reasoning',
    medium: 'Moderate analysis or several steps',
    high: 'Complex task that needs careful multi-step reasoning',
    xhigh: 'Exceptionally difficult reasoning or planning',
    max: 'Maximum available reasoning for an exceptionally difficult task',
    ultra: 'Highest available reasoning for an exceptionally difficult task',
  };
  const labels = Object.fromEntries(['default', ...levels].map((level) => [level, descriptions[level]]));
  const chosen = confidentChoice<ChatReasoningEffort>(await classifyDecision(
    prompt.slice(0, 4_000), labels, 'What reasoning effort is appropriate for this request?',
  ), 0.8);
  return chosen && chosen !== 'default' && levels.includes(chosen) ? chosen : null;
}
