import { describe, expect, it } from 'vitest';
import {
  getAgentProviderCapabilities,
  getAgentProviderLaunchOptions,
  isChatAgentProvider,
  mergeAgentProviderModels,
  parseLiveAgentModels,
} from './agent-provider-catalogue';

describe('agent provider catalogue', () => {
  it('treats supported agent aliases as providers, not API model providers', () => {
    expect(isChatAgentProvider('codex')).toBe(true);
    expect(isChatAgentProvider('cursor-agent')).toBe(true);
    expect(isChatAgentProvider('openrouter')).toBe(false);
    expect(isChatAgentProvider('npm run dev')).toBe(false);
  });

  it('exposes provider-native model choices and preserves live capability ids', () => {
    const codex = getAgentProviderCapabilities('codex');
    expect(codex.models.map((model) => model.id)).toEqual(['default']);
    expect(getAgentProviderCapabilities('claude').models.map((model) => model.id))
      .toEqual(['default', 'fable', 'opus', 'sonnet']);

    expect(mergeAgentProviderModels('codex', [
      { id: 'vendor/new-model', label: 'New model', description: 'Reported by the agent.' },
    ])).toEqual([
      { id: 'vendor/new-model', label: 'New model', description: 'Reported by the agent.', free: undefined },
    ]);
  });

  it('maps Chat access and reasoning choices to provider-native launch flags', () => {
    expect(getAgentProviderLaunchOptions('codex', {
      model: 'gpt-5.6-sol',
      accessMode: 'auto-edits',
      reasoningEffort: 'high',
    })).toEqual({
      permissionArgs: '--sandbox workspace-write --ask-for-approval on-request',
      runtimeArgs: '--model gpt-5.6-sol -c model_reasoning_effort=high',
    });

    expect(getAgentProviderLaunchOptions('claude', {
      accessMode: 'full-access',
      reasoningEffort: 'xhigh',
    })).toEqual({
      permissionArgs: '--permission-mode bypassPermissions',
      runtimeArgs: '--effort xhigh',
    });
  });

  it('preserves CLI defaults for inherit and rejects unsafe model values', () => {
    expect(getAgentProviderLaunchOptions('cursor-agent', {
      model: 'model; Remove-Item anything',
      accessMode: 'inherit',
      reasoningEffort: 'high',
    })).toEqual({ permissionArgs: undefined, runtimeArgs: '' });
  });

  it('parses the installed Cursor and Grok model list formats', () => {
    const cursorModels = parseLiveAgentModels('cursor-agent', 'Available models\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\ncomposer-2.5 - Composer 2.5');
    expect(cursorModels.map((model) => [model.id, model.label]))
      .toEqual([
        ['gpt-5.6-sol-high', 'GPT-5.6 Sol 1M High'],
        ['composer-2.5', 'Composer 2.5'],
      ]);
    const grokModels = parseLiveAgentModels('grok', 'Available models:\n  * grok-4.6 (default)');
    expect(grokModels.map((model) => [model.id, model.label]))
      .toEqual([['grok-4.6', 'grok-4.6']]);
  });
});
