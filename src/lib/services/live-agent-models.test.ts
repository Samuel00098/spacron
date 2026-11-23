import { beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
const runEmbeddedCommand = vi.hoisted(() => vi.fn());
const remoteState = vi.hoisted(() => ({ value: null as null | { url: string; token: string } }));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('$lib/stores/embeddedRun', () => ({ runEmbeddedCommand }));
vi.mock('$lib/stores/terminal', () => ({ getAgentDisplayName: (command: string) => command }));
vi.mock('$lib/stores/remoteWorkspace', () => ({
  remoteTarget: {
    subscribe: (callback: (value: typeof remoteState.value) => void) => {
      callback(remoteState.value);
      return () => {};
    },
  },
}));

import { loadLiveAgentProviderModels, freshLiveAgentProviderModels, resetLiveAgentModelCacheForTests } from './live-agent-models';

describe('live agent models', () => {
  it('refreshes the current model catalog instead of returning a persisted list', async () => {
    invoke.mockResolvedValueOnce({ exitCode: 0, output: '', models: [{ id: 'old-model', label: 'Old', reasoningEfforts: ['high'] }] });
    await loadLiveAgentProviderModels('codex');
    invoke.mockResolvedValueOnce({ exitCode: 0, output: '', models: [{ id: 'new-model', label: 'New', reasoningEfforts: ['low'] }] });
    const models = await freshLiveAgentProviderModels('codex', true);
    expect(models.map(model => model.id)).toEqual(['new-model']);
    expect(models[0].reasoningEfforts).toEqual(['low']);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    remoteState.value = null;
    resetLiveAgentModelCacheForTests();
  });

  it('loads Codex models from the native app-server adapter', async () => {
    invoke.mockResolvedValue({
      exitCode: 0,
      output: 'gpt-6-astra - GPT-6-Astra\ngpt-5.6-sol - GPT-5.6-Sol\n',
    });

    await expect(loadLiveAgentProviderModels('codex')).resolves.toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Reported by the installed agent CLI.' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Reported by the installed agent CLI.' },
    ]);
    expect(runEmbeddedCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['agy', 'Fetching available models...\nmodel-id\tModel label', 'model-id'],
    ['pi', 'provider  model  context  max-out  thinking  images\nopenrouter  ~vendor/model  1M  64K  yes  no', 'openrouter/~vendor/model'],
    ['kilo', 'kilo/~vendor/model\n', 'kilo/~vendor/model'],
  ])('reads the installed %s model catalogue when a box is active', async (command, output, modelId) => {
    remoteState.value = { url: 'ws://box', token: 'test' };
    invoke.mockResolvedValueOnce({ exitCode: 0, output });

    const models = await freshLiveAgentProviderModels(command, false, 'local');
    expect(models.map(({ id }) => id)).toEqual([modelId]);
    expect(invoke).toHaveBeenCalledWith('agent_list_models', { command });
    expect(runEmbeddedCommand).not.toHaveBeenCalled();
  });

  it('keeps structured native model capabilities from Codex', async () => {
    invoke.mockResolvedValue({
      exitCode: 0,
      output: 'gpt-6-astra - GPT-6-Astra\n',
      models: [{
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        description: 'Live Codex model',
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
        isDefault: true,
      }],
    });

    await expect(loadLiveAgentProviderModels('codex')).resolves.toEqual([
      {
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        description: 'Live Codex model',
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'low',
        isDefault: true,
      },
    ]);
  });

  it('loads Claude Code model names and effort levels from the native catalogue', async () => {
    invoke.mockResolvedValue({
      exitCode: 0,
      output: 'claude-opus-5-5 - Opus 5.5\nclaude-fable-5-1 - Fable 5.1\n',
      models: [{
        id: 'claude-opus-5-5',
        label: 'Opus 5.5',
        description: 'For complex tasks',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'medium',
        isDefault: true,
      }],
    });

    await expect(loadLiveAgentProviderModels('claude')).resolves.toEqual([{
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'For complex tasks',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'medium',
      isDefault: true,
      free: undefined,
    }]);
    expect(invoke).toHaveBeenCalledWith('agent_list_models', { command: 'claude' });
  });

  it('normalizes a provider command alias before invoking the native catalogue', async () => {
    invoke.mockResolvedValue({
      exitCode: 0,
      output: 'gpt-live - Live model\n',
    });

    await expect(loadLiveAgentProviderModels('C:\\Tools\\codex.cmd')).resolves.toEqual([
      { id: 'gpt-live', label: 'Live model', description: 'Reported by the installed agent CLI.' },
    ]);
    expect(invoke).toHaveBeenCalledWith('agent_list_models', { command: 'codex' });
  });

  it('never opens a terminal locally when the CLI cannot list models', async () => {
    invoke.mockResolvedValue({ exitCode: null, output: '', error: 'timed out' });
    await expect(loadLiveAgentProviderModels('cursor-agent')).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('agent_list_models', { command: 'cursor-agent' });
    expect(runEmbeddedCommand).not.toHaveBeenCalled();
  });

  it('serves the last reported list at once and refreshes it behind', async () => {
    invoke.mockResolvedValue({ exitCode: 0, output: 'gpt-old - Old\n' });
    await loadLiveAgentProviderModels('codex');
    // Past the in-memory TTL (as after a restart): the persisted list answers
    // immediately while a new probe runs.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    let finishProbe!: (value: unknown) => void;
    invoke.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));
    await expect(loadLiveAgentProviderModels('codex')).resolves.toEqual([
      { id: 'gpt-old', label: 'Old', description: 'Reported by the installed agent CLI.' },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    finishProbe({ exitCode: 0, output: 'gpt-new - New\n' });
    vi.restoreAllMocks();
  });

  it('falls back to the remote terminal adapter for a remote Cursor agent', async () => {
    remoteState.value = { url: 'ws://remote.test/pty', token: 'test' };
    runEmbeddedCommand.mockResolvedValue({
      exitCode: 0,
      output: 'auto - Auto (current, default)\ngpt-5.6-sol-high - GPT-5.6 Sol High\n',
    });

    const models = await loadLiveAgentProviderModels('cursor-agent');
    expect(invoke).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toEqual(['auto', 'gpt-5.6-sol-high']);
  });

  it('does not treat Codex app-server as a one-shot remote shell command', async () => {
    remoteState.value = { url: 'ws://remote.test/pty', token: 'test' };
    await expect(loadLiveAgentProviderModels('codex')).resolves.toEqual([]);
    expect(runEmbeddedCommand).not.toHaveBeenCalled();
  });

  it('reuses a successful catalogue but retries after an empty one', async () => {
    invoke.mockResolvedValue({ exitCode: 0, output: '', models: [] });
    await expect(loadLiveAgentProviderModels('codex')).resolves.toEqual([]);
    invoke.mockResolvedValue({ exitCode: 0, output: 'gpt-6-astra - GPT-6-Astra\n' });
    await loadLiveAgentProviderModels('codex');
    await loadLiveAgentProviderModels('codex');
    // One failed probe, then one real probe served twice.
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
