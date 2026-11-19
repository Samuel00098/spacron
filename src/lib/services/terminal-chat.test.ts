import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { canShowTerminalChat, sendMatchKey, transcriptAgentFor } from './terminal-chat';

describe('terminal chat view', () => {
  it('offers chat only for agents whose transcripts it can read', () => {
    expect(transcriptAgentFor('claude')).toBe('claude');
    expect(transcriptAgentFor('codex')).toBe('codex');
    expect(transcriptAgentFor('opencode')).toBe('opencode');
    expect(transcriptAgentFor('grok')).toBe('grok');
    expect(transcriptAgentFor('cursor-agent')).toBeNull();
    expect(transcriptAgentFor(null)).toBeNull();
    expect(canShowTerminalChat('aider')).toBe(false);
  });

  it('matches a pending send to its transcript row across whitespace', () => {
    expect(sendMatchKey('  fix\n the   bug ')).toBe(sendMatchKey('fix the bug'));
  });
});
