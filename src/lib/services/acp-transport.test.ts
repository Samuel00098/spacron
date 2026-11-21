import { describe, expect, it, vi } from 'vitest';
import type { AcpSession } from './acp-transport';
import { initializeAcp, promptAcpNativeSession, waitForAcpReplayIdle } from './acp-transport';

function fakeSession() {
  let handler: ((value: Record<string, unknown>) => void) | undefined;
  const session = {
    onNotification: vi.fn(async (next: (value: Record<string, unknown>) => void) => {
      handler = next;
      return vi.fn();
    }),
  } as unknown as AcpSession;
  return { session, emit: (value: Record<string, unknown>) => handler?.(value) };
}

describe('ACP session lifecycle', () => {
  it('returns the agent stop reason to the caller', async () => {
    const request = vi.fn().mockResolvedValue({ stopReason: 'cancelled' });
    const session = { request } as unknown as AcpSession;
    await expect(promptAcpNativeSession(session, 'agent-session', 'Build the project'))
      .resolves.toEqual({ stopReason: 'cancelled' });
    expect(request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'agent-session',
      prompt: [{ type: 'text', text: 'Build the project' }],
    });
  });

  it('waits for replay idle before continuing', async () => {
    const fake = fakeSession();
    const waiting = waitForAcpReplayIdle(fake.session, 1000, 1);
    await Promise.resolve();
    fake.emit({ params: { update: { type: 'sessionIdle' } } });
    await expect(waiting).resolves.toBeUndefined();
    expect(fake.session.onNotification).toHaveBeenCalledTimes(1);
  });
});

describe('ACP handshake', () => {
  function handshakeSession(request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    const spy = vi.fn(request);
    return { session: { request: spy } as unknown as AcpSession, spy };
  }

  it('asks for v2 first and reports the version the agent chose', async () => {
    const { session, spy } = handshakeSession(async () => ({ protocolVersion: 2, capabilities: { session: {} }, info: { name: 'agy' }, authMethods: [] }));
    const result = await initializeAcp(session);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ protocolVersion: 2 });
    expect(result).toMatchObject({ protocolVersion: 2, protocolV2: true, agentInfo: { name: 'agy' } });
  });

  it('falls back to the v1 handshake when the agent refuses v2', async () => {
    const { session, spy } = handshakeSession(async (_method, params) => {
      if (params.protocolVersion === 2) throw new Error('unsupported protocol version');
      return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'old' }, authMethods: [{ id: 'login' }] };
    });
    const result = await initializeAcp(session);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toEqual({
      protocolVersion: 1,
      clientInfo: expect.any(Object),
      clientCapabilities: expect.any(Object),
    });
    expect(result).toMatchObject({ protocolVersion: 1, protocolV2: false, agentCapabilities: { loadSession: true } });
    expect(result.authMethods).toEqual([{ id: 'login' }]);
  });

  it('treats a v2 request answered with version 1 as v1', async () => {
    const { session } = handshakeSession(async () => ({ protocolVersion: 1 }));
    await expect(initializeAcp(session)).resolves.toMatchObject({ protocolVersion: 1, protocolV2: false, agentInfo: null });
  });
});
