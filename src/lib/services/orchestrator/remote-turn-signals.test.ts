import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A turn signal is a file on whichever machine opened it, and the MCP route
 * hands the agent a `127.0.0.1` URL. Neither crosses to a remote workspace: the
 * agent runs on the box, so the sentinel path names a laptop location it cannot
 * see, and its loopback is its own rather than the laptop's MCP server.
 *
 * These tests pin the two consequences of that:
 *
 *   1. No channel is opened at all when a remote is active. Opening one anyway
 *      made `agent-turn-watch` treat the session as `signalled`, skip the
 *      BEL/regex path and wait out the 15-minute `SIGNALLED_IDLE_MS` backstop —
 *      strictly worse than the heuristic it displaced.
 *   2. `agentCanReport` is false there, so an inferred end is worded as a guess
 *      ("went quiet") instead of being silenced as a report the agent declined
 *      to make. Silence is only information when the agent had a way to speak.
 */

const invoke = vi.hoisted(() =>
  vi.fn(async (_command: string, _args?: any): Promise<any> => '/tmp/signals/chan.signals'),
);
const backendInvoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: any): Promise<any> => undefined));
const listen = vi.hoisted(() => vi.fn(async () => () => {}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('$lib/services/backend', () => ({ backendInvoke }));

import { prepareTurnSignals, prepareStatusChannel } from './agent-hook-signals';
import { agentCanReport } from './agent-capabilities';
import { remoteConnections, activeRemoteId } from '$lib/stores/remoteWorkspace';

/** Point the app at a remote box, the way connecting to one does. */
function useRemoteWorkspace(): void {
  remoteConnections.set([
    { id: 'box-1', name: 'Build box', url: 'wss://box.example:7777', token: 'tok' },
  ]);
  activeRemoteId.set('box-1');
}

/** Back to Local mode. */
function useLocalWorkspace(): void {
  activeRemoteId.set(null);
  remoteConnections.set([]);
}

beforeEach(() => {
  useLocalWorkspace();
  invoke.mockClear();
  backendInvoke.mockClear();
});

afterEach(() => {
  useLocalWorkspace();
});

describe('turn-signal hooks against a remote workspace', () => {
  it('opens a channel normally in Local mode', async () => {
    const prepared = await prepareTurnSignals('claude');

    expect(prepared).not.toBeNull();
    expect(prepared?.command).toContain('--settings');
    expect(invoke.mock.calls.map(([c]) => c)).toContain('agent_signal_channel_open');
  });

  it('declines to open one when a remote is active', async () => {
    useRemoteWorkspace();

    const prepared = await prepareTurnSignals('claude');

    expect(prepared).toBeNull();
    // Nothing opened means nothing to leave dangling, and no settings file
    // written to the box carrying a laptop path.
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain('agent_signal_channel_open');
    expect(backendInvoke.mock.calls.map(([c]) => c)).not.toContain('fs_write_file');
  });

  it('declines the shell status channel when a remote is active', async () => {
    useRemoteWorkspace();

    expect(await prepareStatusChannel()).toBeNull();
    expect(invoke.mock.calls.map(([c]) => c)).not.toContain('agent_signal_channel_open');
  });

  it('still opens the shell status channel in Local mode', async () => {
    const channel = await prepareStatusChannel();

    expect(channel).not.toBeNull();
    expect(channel?.path).toBe('/tmp/signals/chan.signals');
  });
});

describe('agentCanReport across the same seam', () => {
  it('trusts the MCP-configurable list in Local mode', () => {
    expect(agentCanReport('claude')).toBe(true);
    expect(agentCanReport('codex')).toBe(true);
  });

  it('still answers false for a CLI with no channel in Local mode', () => {
    expect(agentCanReport('aider')).toBe(false);
  });

  it('answers false for every agent when a remote is active', () => {
    useRemoteWorkspace();

    // Even the CLIs Spacron writes an MCP config for: that config points at a
    // loopback address that means the box, not this machine.
    for (const cmd of ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'aider']) {
      expect(agentCanReport(cmd), `${cmd} cannot report from a remote box`).toBe(false);
    }
  });
});
