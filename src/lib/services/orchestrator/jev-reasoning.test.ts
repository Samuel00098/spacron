import { describe, expect, it, vi } from 'vitest';
const classifyDecision = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => null));
vi.mock('$lib/services/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/services/jev')>()), classifyDecision,
}));
import { suggestReasoningLevel } from './jev-reasoning';

describe('Jev reasoning suggestion', () => {
  it('suggests only a supported, confident effort and falls back without Jev', async () => {
    classifyDecision.mockResolvedValueOnce({ probabilities: { default: 0.02, minimal: 0.01, low: 0.02, medium: 0.04, high: 0.91 }, confidence: 0.9 })
      .mockResolvedValueOnce(null);
    await expect(suggestReasoningLevel('Fix a complex bug', 'openai', 'gpt-5')).resolves.toBe('high');
    await expect(suggestReasoningLevel('Fix a complex bug', 'openai', 'gpt-5')).resolves.toBeNull();
    classifyDecision.mockClear();
    await expect(suggestReasoningLevel('Simple task', 'openai', 'gpt-4o')).resolves.toBeNull();
    expect(classifyDecision).not.toHaveBeenCalled();
  });
});
