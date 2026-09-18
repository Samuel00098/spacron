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

import { loadLiveAgentProviderModels } from './live-agent-models';

describe('live agent models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    remoteState.value = null;
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
});
