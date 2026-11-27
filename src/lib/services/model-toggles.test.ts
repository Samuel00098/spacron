import { describe, expect, it } from 'vitest';
import { claudeSupportsFast, modelTogglesFor } from './model-toggles';

describe('model toggles', () => {
  it('matches the Claude models that report fast mode', () => {
    for (const id of ['default', 'opus', 'fable', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-2', 'claude-fable-5']) {
      expect(claudeSupportsFast(id), id).toBe(true);
    }
    for (const id of ['sonnet', 'haiku', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5']) {
      expect(claudeSupportsFast(id), id).toBe(false);
    }
  });

  it("believes the CLI's own answer over the name", () => {
    expect(modelTogglesFor('claude', { id: 'opus', supportsFast: false }, [])).toEqual([]);
    expect(modelTogglesFor('codex', { id: 'gpt', supportsFast: true }, ['high', 'ultra']).map((t) => t.label)).toEqual(['Fast mode', 'Ultra']);
  });

  it('offers Ultracode only where Claude has xhigh, and nothing to other agents', () => {
    expect(modelTogglesFor('claude', { id: 'sonnet' }, ['low', 'xhigh']).map((t) => t.label)).toEqual(['Ultracode']);
    expect(modelTogglesFor('claude', { id: 'haiku' }, [])).toEqual([]);
    expect(modelTogglesFor('grok', { id: 'x', supportsFast: true }, ['xhigh'])).toEqual([]);
  });
});
