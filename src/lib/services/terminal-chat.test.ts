import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { canShowTerminalChat, contextUsageFor, formatTokens, modelApplyFor, permissionArgs, permissionModesFor, resumeArgs, sendMatchKey, transcriptAgentFor } from './terminal-chat';

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

  it('uses the window a CLI reports, and infers the Claude Code one', () => {
    expect(contextUsageFor('codex', 'gpt', 232_168, 258_400)).toEqual({ used: 232_168, window: 258_400, estimated: false });
    expect(contextUsageFor('claude', 'claude-opus', 50_000, null)?.window).toBe(200_000);
    expect(contextUsageFor('claude', 'claude-opus', 331_456, null)?.window).toBe(1_000_000);
    expect(contextUsageFor('opencode', 'm', 10, null)?.window).toBeNull();
    expect(contextUsageFor('claude', 'm', null, null)).toBeNull();
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(18_640)).toBe('18.6k');
    expect(formatTokens(331_456)).toBe('331k');
    expect(formatTokens(1_000_000)).toBe('1M');
  });

  it('changes models the way each CLI accepts mid-session', () => {
    const claude = modelApplyFor('claude');
    expect(claude.kind === 'command' && claude.build('opus')).toBe('/model opus');
    expect(modelApplyFor('codex')).toEqual({ kind: 'relaunch' });
    expect(modelApplyFor('opencode').kind).toBe('none');
  });

  it('offers Orca’s permission modes per agent with each CLI’s own flags', () => {
    expect(permissionModesFor('claude')).toEqual(['ask', 'accept-edits', 'auto', 'full-access']);
    expect(permissionModesFor('codex')).toEqual(['ask', 'auto', 'full-access']);
    expect(permissionModesFor('opencode')).toEqual(['ask', 'full-access']);
    expect(permissionArgs('claude', 'accept-edits')).toBe('--permission-mode acceptEdits');
    expect(permissionArgs('codex', 'auto')).toBe('--approve-for-me');
    expect(permissionArgs('codex', 'ask')).toBe('-a on-request -s read-only -c approvals_reviewer="user"');
    expect(resumeArgs('codex', 'abc')).toBe('resume abc');
    expect(resumeArgs('claude', 'abc')).toBe('--resume abc');
  });
});
