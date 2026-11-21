import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const writes: string[] = [];
vi.mock('$lib/stores/terminal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeToSession: (_id: number, data: string) => { writes.push(data); },
}));

import { canShowTerminalChat, contextUsageFor, effortApplyFor, formatTokens, modelApplyFor, typeSlashCommand, serialPaneWrite, isShellPromptLine, permissionArgs, permissionModesFor, resumeArgs, sendMatchKey, transcriptAgentFor } from './terminal-chat';

describe('terminal chat view', () => {
  it('offers chat only for agents whose transcripts it can read', () => {
    expect(transcriptAgentFor('claude')).toBe('claude');
    expect(transcriptAgentFor('codex')).toBe('codex');
    expect(transcriptAgentFor('opencode')).toBe('opencode');
    expect(transcriptAgentFor('grok')).toBe('grok');
    // Orca's other chat agents, read from their own session files.
    expect(transcriptAgentFor('cursor-agent')).toBe('cursor');
    expect(transcriptAgentFor('agy')).toBe('antigravity');
    expect(transcriptAgentFor('pi')).toBe('pi');
    expect(transcriptAgentFor('copilot')).toBe('copilot');
    expect(transcriptAgentFor('kimi')).toBeNull();
    expect(transcriptAgentFor(null)).toBeNull();
    expect(canShowTerminalChat('aider')).toBe(false);
  });

  it('matches a pending send to its transcript row across whitespace', () => {
    expect(sendMatchKey('  fix\n the   bug ')).toBe(sendMatchKey('fix the bug'));
    // The transcript row of a send with images carries the CLI's markers.
    expect(sendMatchKey('[Image #1][Image #2]fix the bug')).toBe(sendMatchKey('fix the bug'));
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
    // Orca: Codex and OpenCode pick in their own pickers; nothing presses keys in them.
    expect(modelApplyFor('codex')).toEqual({ kind: 'picker', command: '/model' });
    expect(effortApplyFor('codex')).toEqual({ kind: 'picker', command: '/model' });
    expect(modelApplyFor('opencode')).toEqual({ kind: 'picker', command: '/models' });
    const cursor = modelApplyFor('cursor');
    expect(cursor.kind === 'command' && cursor.build('gpt-5')).toBe('/model gpt-5');
    const antigravity = effortApplyFor('antigravity');
    expect(antigravity.kind === 'command' && antigravity.build('high')).toBe('/effort high');
  });

  it('clears the input line first where Ctrl+U does that', async () => {
    writes.length = 0;
    await typeSlashCommand(1, '/x', { clearInput: true });
    expect(writes[0]).toBe(String.fromCharCode(21));
    expect(writes.slice(1).join('')).toBe('/x' + String.fromCharCode(13));
  });

  it('runs one write at a time per pane, in the order asked', async () => {
    const order: string[] = [];
    const slow = serialPaneWrite(7, async () => { await new Promise((r) => setTimeout(r, 30)); order.push('first'); });
    const fast = serialPaneWrite(7, async () => { order.push('second'); });
    const other = serialPaneWrite(8, async () => { order.push('other pane'); });
    await Promise.all([slow, fast, other]);
    expect(order).toEqual(['other pane', 'first', 'second']);
  });

  it('types a slash command one key per write, then Enter on its own', async () => {
    writes.length = 0;
    await typeSlashCommand(1, '/model');
    // A multi-character write is a paste; Codex would take it as prompt text.
    expect(writes).toEqual(['/', 'm', 'o', 'd', 'e', 'l', '\r']);
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
    expect(resumeArgs('pi', 'abc')).toBe('--session abc');
    expect(resumeArgs('omp', 'abc')).toBe('--resume abc');
    expect(resumeArgs('antigravity', 'abc')).toBe('--conversation abc');
    expect(resumeArgs('copilot', 'abc')).toBe('--resume abc');
    expect(resumeArgs('cursor', 'abc')).toBe('--resume abc');
    expect(resumeArgs('claude', 'abc; echo secret')).toBe('');
    expect(resumeArgs('claude', '--new-session')).toBe('');
  });

  it('only takes the pane folder shell prompt as "the CLI has quit"', () => {
    const folder = '3D works';
    expect(isShellPromptLine(String.raw`C:\Users\SMIDS MAN\Documents\Samuel Works\3D works>`, folder)).toBe(true);
    expect(isShellPromptLine(String.raw`PS C:\Users\SMIDS MAN\Documents\Samuel Works\3D works>`, folder)).toBe(true);
    expect(isShellPromptLine('samuel@box:~/3D works$', folder)).toBe(true);
    // A command typed at the prompt, or a CLI status line, is not the bare prompt.
    expect(isShellPromptLine(String.raw`C:\Users\SMIDS MAN\Documents\Samuel Works\3D works>/exit`, folder)).toBe(false);
    expect(isShellPromptLine('  ctrl+c quit   100% context left', folder)).toBe(false);
    expect(isShellPromptLine('gpt-6-luna medium · 100%', folder)).toBe(false);
    expect(isShellPromptLine(String.raw`C:\Users\other>`, folder)).toBe(false);
  });
});
