import { describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { modelCapabilities } from './ModelCapabilityBadges';

describe('model capability badges', () => {
  it('always shows text, and reasoning exactly when the reasoning picker has levels', () => {
    expect(modelCapabilities('anthropic', 'claude-sonnet-4-5', true)).toEqual({ text: true, vision: true, reasoning: true });
    expect(modelCapabilities('deepseek', 'deepseek-chat', false)).toEqual({ text: true, vision: false, reasoning: false });
    expect(modelCapabilities('openai', 'gpt-4o', true).reasoning).toBe(false);
    expect(modelCapabilities('openai', 'o3', true).reasoning).toBe(true);
  });

  it('leaves vision unknown until Rust has answered', () => {
    expect(modelCapabilities('google', 'gemini-2.5-pro', null).vision).toBeNull();
  });
});

describe('listed reasoning', () => {
  it('uses what the provider list says, over the built-in rule', () => {
    expect(modelCapabilities('openrouter', 'some/plain-model', true, false).reasoning).toBe(false);
    expect(modelCapabilities('together', 'new/thinker', false, true).reasoning).toBe(true);
    expect(modelCapabilities('openai', 'o3', true, null).reasoning).toBe(true);
  });
});
