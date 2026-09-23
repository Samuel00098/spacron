import { describe, expect, it } from 'vitest';
import { effectiveReasoningEffort, reasoningLevelsFor } from './reasoning-levels';

describe('reasoningLevelsFor', () => {
  it('offers each provider only the levels its API accepts', () => {
    expect(reasoningLevelsFor('openai', 'gpt-5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(reasoningLevelsFor('openai', 'gpt-4o')).toEqual([]);
    expect(reasoningLevelsFor('anthropic', 'claude-opus-5')).toContain('max');
    expect(reasoningLevelsFor('anthropic', 'claude-sonnet-4-5')).toEqual(['low', 'medium', 'high']);
    expect(reasoningLevelsFor('anthropic', 'claude-3-5-haiku-latest')).toEqual([]);
    expect(reasoningLevelsFor('google', 'gemini-3-pro-preview')).toEqual(['low', 'high']);
    expect(reasoningLevelsFor('xai', 'grok-3-mini')).toEqual(['low', 'high']);
    expect(reasoningLevelsFor('xai', 'grok-4')).toEqual([]);
    expect(reasoningLevelsFor('groq', 'openai/gpt-oss-120b')).toEqual(['low', 'medium', 'high']);
    expect(reasoningLevelsFor('deepseek', 'deepseek-reasoner')).toEqual([]);
  });

  it('drops a saved level the current model does not have', () => {
    expect(effectiveReasoningEffort('anthropic', 'claude-sonnet-4-5', 'max')).toBeUndefined();
    expect(effectiveReasoningEffort('anthropic', 'claude-opus-5', 'max')).toBe('max');
    expect(effectiveReasoningEffort('openai', 'gpt-5', 'default')).toBeUndefined();
  });
});
