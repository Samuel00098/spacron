import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/terminal', () => ({ getAgentDisplayName: () => null }));

import { launchFieldOptions } from './AgentLaunchConfigFields';

const codexLive = [
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', isDefault: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'low' },
  { id: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' },
] as const;

describe('launchFieldOptions', () => {
  it('uses only the selected model’s reported reasoning in reported-only mode', () => {
    const options = launchFieldOptions('codex', [
      { id: 'model-a', label: 'A', reasoningEfforts: ['high', 'low'], defaultReasoningEffort: 'high' },
      { id: 'model-b', label: 'B', reasoningEfforts: ['ultra'] },
    ], 'model-a', true);
    expect(options.reasoning).toEqual([{ effort: 'high', disabled: false }, { effort: 'low', disabled: false }]);
    expect(options.defaultReasoning).toBe('high');
  });
  it('does not invent reasoning when model metadata is missing', () => {
    expect(launchFieldOptions('codex', [{ id: 'model-a', label: 'A' }], 'model-a', true).reasoning).toEqual([]);
    expect(launchFieldOptions('claude', [], 'default', true).reasoning).toEqual([]);
  });
  it('does not insert a saved model missing from the agent catalog', () => {
    const options = launchFieldOptions('codex', [{ id: 'current-model', label: 'Current' }], 'removed-model', true);
    expect(options.models.map(model => model.id)).toEqual(['current-model']);
    expect(options.reasoning).toEqual([]);
  });
  it('uses the reported default model without guessing a default or effort', () => {
    const reported = [{ id: 'model-a', label: 'A', isDefault: true, reasoningEfforts: ['medium' as const], defaultReasoningEffort: 'high' as const }];
    expect(launchFieldOptions('codex', reported, 'default', true).reasoning).toEqual([{ effort: 'medium', disabled: false }]);
    expect(launchFieldOptions('codex', reported, 'default', true).defaultReasoning).toBeNull();
    expect(launchFieldOptions('codex', [{ id: 'model-a', label: 'A', reasoningEfforts: ['high'] }], 'default', true).reasoning).toEqual([]);
  });
  it('lists the CLI-reported models and resolves the CLI default', () => {
    const options = launchFieldOptions('codex', [...codexLive] as never, 'default');
    expect(options.models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5']);
    expect(options.defaultModel?.id).toBe('gpt-6-astra');
    expect(options.defaultReasoning).toBe('low');
  });

  it('disables reasoning levels the selected model does not support', () => {
    const options = launchFieldOptions('codex', [...codexLive] as never, 'gpt-5.5');
    const disabled = options.reasoning.filter((r) => r.disabled).map((r) => r.effort);
    expect(disabled).toEqual(expect.arrayContaining(['max', 'ultra']));
    expect(disabled).not.toContain('high');
  });

  it('lists only what the installed CLI reports', () => {
    const options = launchFieldOptions('claude', [
      { id: 'claude-opus-5-5', label: 'Opus 5.5', reasoningEfforts: ['low', 'medium'] },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', reasoningEfforts: [] },
    ], 'claude-haiku-4-5-20251001');
    expect(options.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001']);
    // Haiku has no effort control, so every level is disabled.
    expect(options.reasoning.every((r) => r.disabled)).toBe(true);
  });

  it('offers no models at all when the CLI reports none', () => {
    expect(launchFieldOptions('claude', [], 'default').models).toEqual([]);
  });

  it('offers no reasoning for a CLI whose launch takes no reasoning flag', () => {
    expect(launchFieldOptions('opencode', [], 'default').reasoning).toEqual([]);
  });
});
