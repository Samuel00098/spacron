import { describe, expect, it } from 'vitest';
import { contextUsageFrom } from './claude-session';

// Trimmed from a live `get_context_usage` response (Claude CLI, 2026-11-21).
const live = {
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 3583, kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 17274, kind: 'used' },
    { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 26459, kind: 'deferred' },
    { id: 'messages', name: 'Messages', tokens: 10, kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 934244, kind: 'free' },
  ],
  totalTokens: 32756,
  maxTokens: 1000000,
};

describe('Claude context usage', () => {
  it('keeps the window total and only the categories that occupy it', () => {
    expect(contextUsageFrom(live)).toEqual({
      contextUsed: 32756,
      contextWindow: 1000000,
      contextBreakdown: [
        { name: 'System prompt', tokens: 3583 },
        { name: 'System tools', tokens: 17274 },
        { name: 'Messages', tokens: 10 },
      ],
    });
  });

  it('ignores a response without totals', () => {
    expect(contextUsageFrom({})).toBeNull();
    expect(contextUsageFrom(null)).toBeNull();
  });
});
