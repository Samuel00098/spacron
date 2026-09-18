import { describe, expect, it } from 'vitest';
import { getProviderBrand } from './providerBrands';

function isProviderAsset(mark: unknown): boolean {
  return Boolean(
    mark &&
      typeof mark === 'object' &&
      'props' in mark &&
      (mark as { props?: { className?: unknown } }).props?.className === 'provider-brand-asset',
  );
}

describe('provider brands', () => {
  it('uses provider-specific assets for providers that previously borrowed or used initials', () => {
    for (const provider of ['groq', 'deepseek', 'mistral', 'together', 'fireworks', 'cerebras', 'nvidia', 'sambanova', 'perplexity', 'cohere', 'ollama', 'lmstudio']) {
      expect(isProviderAsset(getProviderBrand(provider, provider).mark), provider).toBe(true);
    }
  });

  it('does not confuse Groq with Grok or Mistral with Mistral Vibe', () => {
    expect(getProviderBrand('groq', 'Groq').color).toBe('#F43E01');
    expect(getProviderBrand('mistral', 'Mistral').color).toBe('#FF7000');
    expect(getProviderBrand('xai', 'xAI (Grok)').color).toBe('mono');
  });
});
