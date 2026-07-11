import { describe, expect, it, beforeEach } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import { remoteConnections, setReconnectOnStartup, startupRemote } from './remoteWorkspace';

describe('reconnect-on-startup', () => {
  beforeEach(() => {
    remoteConnections.set([
      { id: 'a', name: 'A', url: 'ws://a:9000/pty', token: 't' },
      { id: 'b', name: 'B', url: 'ws://b:9000/pty', token: 't' },
    ]);
  });

  it('flags a remote and surfaces it via startupRemote', () => {
    expect(startupRemote()).toBeNull();
    setReconnectOnStartup('a', true);
    expect(startupRemote()?.id).toBe('a');
  });

  it('keeps at most one flagged remote — moving it clears the previous', () => {
    setReconnectOnStartup('a', true);
    setReconnectOnStartup('b', true);
    const list = get(remoteConnections);
    expect(list.find((c) => c.id === 'a')?.reconnectOnStartup).toBe(false);
    expect(list.find((c) => c.id === 'b')?.reconnectOnStartup).toBe(true);
    expect(startupRemote()?.id).toBe('b');
  });

  it('unflagging leaves no startup remote', () => {
    setReconnectOnStartup('a', true);
    setReconnectOnStartup('a', false);
    expect(startupRemote()).toBeNull();
  });
});
