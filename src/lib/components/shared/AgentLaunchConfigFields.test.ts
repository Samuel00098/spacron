import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/terminal', () => ({ getAgentDisplayName: () => null }));

import { launchFieldOptions } from './AgentLaunchConfigFields';

const codexLive = [
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', isDefault: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'low' },
  { id: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' },
] as const;

describe('launchFieldOptions', () => {
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
