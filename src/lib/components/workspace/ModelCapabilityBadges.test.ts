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

describe('vision answers for a whole model list', () => {
  it('asks Rust once for the models it has not seen, and remembers the answers', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mock = vi.mocked(invoke);
    mock.mockReset();
    mock.mockResolvedValueOnce({ 'claude-sonnet-4-5': true, 'claude-2.1': false });
    const { loadModelVision } = await import('./ModelCapabilityBadges');
    await loadModelVision('anthropic', ['claude-sonnet-4-5', 'claude-2.1', 'claude-sonnet-4-5']);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][1]).toMatchObject({ provider: 'anthropic', models: ['claude-sonnet-4-5', 'claude-2.1'] });
    await loadModelVision('anthropic', ['claude-2.1']);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
