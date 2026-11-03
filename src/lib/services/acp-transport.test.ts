import { describe, expect, it, vi } from 'vitest';
import type { AcpSession } from './acp-transport';
import { waitForAcpReplayIdle } from './acp-transport';

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
  it('waits for replay idle before continuing', async () => {
    const fake = fakeSession();
    const waiting = waitForAcpReplayIdle(fake.session, 1000, 1);
    await Promise.resolve();
    fake.emit({ params: { update: { type: 'sessionIdle' } } });
    await expect(waiting).resolves.toBeUndefined();
    expect(fake.session.onNotification).toHaveBeenCalledTimes(1);
  });
});
