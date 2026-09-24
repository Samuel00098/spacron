import { beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => ({ handler: null as null | ((e: { payload: { provider?: string } }) => void) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (_n: string, h: typeof listeners.handler) => { listeners.handler = h; return Promise.resolve(() => {}); } }));
import { capsFor, forgetModelCaps, initModelCapabilities, loadModelCaps } from './model-capabilities';
import { reasoningLevelsFor } from './orchestrator/reasoning-levels';

describe('model capabilities learned in the background', () => {
  beforeEach(() => { invoke.mockReset(); forgetModelCaps(); });

  it('asks Rust once per list for the models it has not seen', async () => {
    invoke.mockResolvedValueOnce({ 'claude-sonnet-4-5': { vision: true, reasoning: true, reasoningEffort: null, tools: true }, 'claude-2.1': { vision: false, reasoning: null, reasoningEffort: null, tools: null } });
    await loadModelCaps('anthropic', ['claude-sonnet-4-5', 'claude-2.1', 'claude-sonnet-4-5']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({ provider: 'anthropic', models: ['claude-sonnet-4-5', 'claude-2.1'] });
    await loadModelCaps('anthropic', ['claude-2.1']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(capsFor('anthropic', 'claude-sonnet-4-5')?.vision).toBe(true);
  });

  it("gives a model no built-in rule knows a reasoning menu when its provider's list says it takes one", async () => {
    expect(reasoningLevelsFor('together', 'acme/thinker-9')).toEqual([]);
    invoke.mockResolvedValueOnce({ 'acme/thinker-9': { vision: false, reasoning: true, reasoningEffort: true, tools: true } });
    await loadModelCaps('together', ['acme/thinker-9']);
    expect(reasoningLevelsFor('together', 'acme/thinker-9')).toEqual(['low', 'medium', 'high']);
    // Built-in rules still win where they exist.
    expect(reasoningLevelsFor('google', 'gemini-3-pro-preview')).toEqual(['low', 'high']);
  });

  it("drops a provider's answers when Rust refreshed its list", async () => {
    initModelCapabilities();
    invoke.mockResolvedValueOnce({ m: { vision: true, reasoning: null, reasoningEffort: null, tools: null } });
    await loadModelCaps('openrouter', ['m']);
    expect(capsFor('openrouter', 'm')).not.toBeNull();
    listeners.handler?.({ payload: { provider: 'openrouter' } });
    expect(capsFor('openrouter', 'm')).toBeNull();
  });
});
