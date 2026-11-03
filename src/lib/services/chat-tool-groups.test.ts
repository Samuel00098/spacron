import { describe, expect, it } from 'vitest';
import { groupChatToolActivity, toolGroupIsWorking } from './chat-tool-groups';
import type { ChatMessage } from '$lib/types/chat';

function message(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id, threadId: 'thread', type: 'activity', role: 'assistant', text: id, ts: 1, ...patch };
}

describe('groupChatToolActivity', () => {
  it('collapses a run of tool rows into one group and keeps order', () => {
    const groups = groupChatToolActivity([
      message('user', { type: 'user', role: 'user' }),
      message('tool-1'),
      message('tool-2'),
      message('tool-3'),
      message('reply', { type: 'agent', text: 'done' }),
    ]);
    expect(groups.map((group) => group.map((entry) => entry.id))).toEqual([
      ['user'],
      ['tool-1', 'tool-2', 'tool-3'],
      ['reply'],
    ]);
  });

  it('does not merge across a non-tool message', () => {
    const groups = groupChatToolActivity([
      message('tool-1'),
      message('reply', { type: 'agent' }),
      message('tool-2'),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('reports a group as working while any call is pending', () => {
    expect(toolGroupIsWorking([message('tool-1'), message('tool-2', { pending: true })])).toBe(true);
    expect(toolGroupIsWorking([message('tool-1'), message('tool-2', { pending: false })])).toBe(false);
  });
});
