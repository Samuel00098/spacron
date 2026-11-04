import { describe, expect, it } from 'vitest';
import { isPiSettled, piPrompt, piTextDelta } from './pi-rpc';

describe('Pi RPC protocol helpers', () => {
  it('creates a correlated prompt command', () => {
    expect(piPrompt('inspect the repo', 'req-1')).toEqual({
      id: 'req-1',
      type: 'prompt',
      message: 'inspect the repo',
    });
  });

  it('extracts streamed assistant text and settles runs', () => {
    expect(piTextDelta({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    })).toBe('hello');
    expect(isPiSettled({ type: 'agent_settled' })).toBe(true);
    expect(isPiSettled({ type: 'message_update' })).toBe(false);
  });
});
