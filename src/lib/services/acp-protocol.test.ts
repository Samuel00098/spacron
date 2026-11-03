import { describe, expect, it } from 'vitest';
import { isAcpReplayIdle, normalizeAcpUpdate } from './acp-protocol';

describe('ACP protocol normalization', () => {
  it('normalizes v1 envelopes and array content', () => {
    const update = normalizeAcpUpdate({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'Hi' }] } },
    });
    expect(update).toMatchObject({ kind: 'agent_message_chunk', content: 'Hi' });
  });

  it('accepts v2-style update names and idle markers', () => {
    const update = normalizeAcpUpdate({ params: { update: { type: 'sessionIdle' } } });
    expect(update?.kind).toBe('session_idle');
    expect(isAcpReplayIdle(update)).toBe(true);
  });
});
