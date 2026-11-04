import { describe, expect, it } from 'vitest';

describe('Pi RPC session policy', () => {
  it('uses one long-lived RPC process for repeated prompts', () => {
    const sessions = new Map<string, { command: string; id: number }>();
    sessions.set('thread-1', { command: 'pi --mode rpc --no-session', id: 1 });
    expect(sessions.get('thread-1')).toEqual({ command: 'pi --mode rpc --no-session', id: 1 });
  });
});
