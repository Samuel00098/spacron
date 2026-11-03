import { describe, expect, it } from 'vitest';
import { decideChatProviderTransition } from './chat-provider-transition';

describe('chat provider transitions', () => {
  const current = { agent: 'claude', model: 'opus', workspace: '/repo' };

  it('reuses an unchanged provider session', () => {
    expect(decideChatProviderTransition(current, current)).toBe('reuse');
  });

  it('creates a handoff for an agent or model change', () => {
    expect(decideChatProviderTransition(current, { ...current, agent: 'codex' })).toBe('create_with_handoff');
    expect(decideChatProviderTransition(current, { ...current, model: 'sonnet' })).toBe('create_with_handoff');
  });

  it('restarts when only the workspace changes', () => {
    expect(decideChatProviderTransition(current, { ...current, workspace: '/other' })).toBe('restart_and_resume');
  });
});
