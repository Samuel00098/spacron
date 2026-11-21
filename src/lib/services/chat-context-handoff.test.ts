import { describe, expect, it } from 'vitest';
import { buildChatContextHandoff, estimateHandoffTokens, lastDispatchedChatAgent } from './chat-context-handoff';

describe('chat context handoff', () => {
  it('finds the most recent dispatched agent', () => {
    expect(lastDispatchedChatAgent([
      { id: 'u', role: 'user', text: 'Build it' },
      { id: 'a', role: 'assistant', text: 'Working', dispatchedAgent: 'claude' },
      { id: 'b', role: 'assistant', text: 'Still working', dispatched: [{ agent: 'codex' }] },
    ])).toBe('codex');
  });

  it('carries bounded transcript context and the new request', () => {
    const handoff = buildChatContextHandoff([
      { id: 'u', role: 'user', text: 'Create the feature' },
      { id: 'a', role: 'assistant', text: 'I edited src/feature.ts', dispatchedAgent: 'claude' },
    ], 'claude', 'codex', 'Finish the tests');

    expect(handoff.prompt).toContain('Previous agent: claude');
    expect(handoff.prompt).toContain('Recent conversation:');
    expect(handoff.prompt).toContain('Finish the tests');
    expect(handoff.coveredMessageIds).toEqual(['u', 'a']);
    expect(handoff.omittedMessages).toBe(0);
  });

  it('keeps the complete handoff prompt within its token budget', () => {
    const handoff = buildChatContextHandoff(
      Array.from({ length: 20 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 ? 'assistant' : 'user',
        text: 'context '.repeat(2_000),
      })),
      'claude',
      'codex',
      'request '.repeat(2_000),
    );

    expect(estimateHandoffTokens(handoff.prompt)).toBeLessThanOrEqual(16_000);
    expect(handoff.omittedMessages).toBeGreaterThan(0);
  });

  it('adds workspace, files and unfinished work while staying bounded', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(9000) }));
    const result = buildChatContextHandoff(messages, 'Claude', 'Codex', 'go', {
      cwd: '/repo',
      project: 'demo',
      model: 'opus',
      filesTouched: ['src/a.ts'],
      unfinished: ['Latest user request: fix it'],
    });
    expect(result.prompt).toContain('Working directory: /repo');
    expect(result.prompt).toContain('- src/a.ts');
    expect(result.prompt).toContain('Latest user request: fix it');
    expect(estimateHandoffTokens(result.prompt)).toBeLessThanOrEqual(16_000);
  });
});
