import { invoke } from '@tauri-apps/api/core';
import { get } from '$lib/stores/storeCompat';
import { getProviderBaseUrl, getProviderDef, jevModel, jevProvider, type AiProviderId } from '$lib/stores/settings';
import { stripTerminalOutput } from './orchestrator/activity-log';

export type JevLabels = Record<string, string>;
export type JevProbabilities = Record<string, number>;
export interface JevDecision {
  probabilities: JevProbabilities;
  confidence: number;
}

/** Optional, bounded Choice call. Null means the caller must use its existing path. */
export async function classify(
  state: string,
  labels: JevLabels,
  question = 'Which answer best fits the input?',
): Promise<JevProbabilities | null> {
  return (await classifyDecision(state, labels, question))?.probabilities ?? null;
}

export async function classifyDecision(
  state: string,
  labels: JevLabels,
  question: string,
): Promise<JevDecision | null> {
  const names = Object.keys(labels);
  if (!state.trim() || !question.trim() || names.length < 2 || names.length > 255) return null;
  try {
    const answer = await invoke<{
      type?: unknown;
      probabilities?: unknown;
      confidence?: unknown;
    } | null>('jev_classify', { state, question, labels, ...jevRoute() });
    if (!answer || answer.type !== 'choice' || !answer.probabilities || typeof answer.probabilities !== 'object'
      || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
      || answer.confidence < 0 || answer.confidence > 1) return null;
    const raw = answer.probabilities as Record<string, unknown>;
    if (Object.keys(raw).length !== names.length) return null;
    const probabilities: JevProbabilities = {};
    for (const name of names) {
      const value = raw[name];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
      probabilities[name] = value;
    }
    const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
    return Math.abs(total - 1) <= 0.02 ? { probabilities, confidence: answer.confidence } : null;
  } catch {
    return null;
  }
}

/** Who answers: TypeSafe (no extras) or a chat provider with its model. */
function jevRoute(): { provider?: string; model?: string; baseUrl?: string } {
  const provider = get(jevProvider);
  if (!provider || provider === 'typesafe') return {};
  const local = getProviderDef(provider as AiProviderId).local;
  return {
    provider,
    model: get(jevModel),
    // Local servers are addressed by the renderer; every other provider's
    // address (a custom one's included) is resolved by the backend.
    baseUrl: local ? getProviderBaseUrl(provider as AiProviderId) : undefined,
  };
}

export function confidentChoice<T extends string>(
  decision: JevDecision | null,
  threshold = 0.75,
): T | null {
  if (!decision || decision.confidence < threshold) return null;
  const [label, probability] = Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1])[0] ?? [];
  return probability >= threshold ? label as T : null;
}

export type NeedsInputCategory = 'permission_prompt' | 'question' | 'crash' | 'auth_or_rate_limit';

export async function triageNeedsInput(reason: string): Promise<NeedsInputCategory | null> {
  return confidentChoice<NeedsInputCategory>(await classifyDecision(
    stripTerminalOutput(reason).slice(-2_000),
    {
      permission_prompt: 'Asks the user to approve an action or grant permission',
      question: 'Asks the user for information or a decision',
      crash: 'The agent or its tool crashed or hit an unrecoverable error',
      auth_or_rate_limit: 'Authentication, quota, or rate limiting stopped the agent',
    },
    'Why does this agent need attention?',
  ), 0.8);
}

export const NEEDS_INPUT_LABELS: Record<NeedsInputCategory, string> = {
  permission_prompt: 'Approval',
  question: 'Question',
  crash: 'Crash',
  auth_or_rate_limit: 'Auth or rate limit',
};

export async function estimateFileOverlap(
  task: string,
  running: Array<{ name?: string | null; title: string; recentOutput?: string | null }>,
): Promise<boolean> {
  if (!task.trim() || running.length === 0) return false;
  const state = JSON.stringify({
    newTask: task.slice(0, 2_000),
    running: running.slice(0, 8).map((agent) => ({
      name: agent.name,
      task: agent.title,
      recentWork: agent.recentOutput?.slice(-1_000) ?? '',
    })),
  });
  return confidentChoice<'overlap' | 'separate'>(await classifyDecision(
    state,
    {
      overlap: 'The new task is likely to edit at least one file a running agent is editing',
      separate: 'The new task appears to involve different files, or there is too little evidence to name an overlap',
    },
    'Is the new task likely to edit a file a running agent is currently editing?',
  ), 0.85) === 'overlap';
}

export type JevRoute = 'answer_directly' | 'delegate' | 'split';

/** Advisory only. The existing permission and delegation policy remains authoritative. */
export async function classifyRouting(prompt: string): Promise<JevRoute | null> {
  return confidentChoice<JevRoute>(await classifyDecision(
    prompt.slice(0, 4_000),
    {
      answer_directly: 'The current assistant can answer or perform the work directly',
      delegate: 'One coding agent would be suitable if the user has authorized delegation',
      split: 'Several independently owned coding tasks could run in parallel if the user has authorized delegation',
    },
    'What is the most suitable way to handle this user request?',
  ), 0.8);
}
