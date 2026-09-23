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

  it('pre-lists no models for any CLI and preserves live capability ids', () => {
    for (const command of ['codex', 'claude', 'cursor-agent', 'grok', 'opencode']) {
      expect(getAgentProviderCapabilities(command).models.map((model) => model.id)).toEqual(['default']);
    }

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

    expect(getAgentProviderLaunchOptions('opencode', {
      model: 'opencode/claude-fable-5-1',
      reasoningEffort: 'high',
    // The interactive `opencode` TUI silently ignores `--variant` (only
    // `opencode run` takes it), so no reasoning flag is sent.
    })).toEqual({ permissionArgs: undefined, runtimeArgs: '--model opencode/claude-fable-5-1' });
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
    const grokModels = parseLiveAgentModels('grok', 'Available models:\n  - grok-4.6');
    expect(grokModels.map((model) => [model.id, model.label]))
      .toEqual([['grok-4.6', 'Grok 4.6']]);
    const openCodeModels = parseLiveAgentModels('opencode', 'opencode/claude-fable-5-1\nopencode/gpt-5.6-sol');
    expect(openCodeModels.map((model) => [model.id, model.label]))
      .toEqual([
        ['opencode/claude-fable-5-1', 'Claude Fable 5.1'],
        ['opencode/gpt-5.6-sol', 'GPT 5.6 Sol'],
      ]);
  });
});
