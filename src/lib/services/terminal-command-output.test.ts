import { describe, expect, it } from 'vitest';
import { codexFooterModel, extractCommandOutput } from './terminal-command-output';

// Rows as Codex 0.171 drew them in a ConPTY (paths shortened).
const CODEX_IDLE = [
  '  >_ OpenAI Codex (v0.171.0)',
  '     ~\\work\\app',
  '  To get started, describe a task or try one of these commands:',
  '  /status - show current session configuration',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-6-Luna medium · ~\\work\\app',
];

describe('slash command output from the screen', () => {
  it("keeps what Codex printed under the command's echo", () => {
    const after = [
      ...CODEX_IDLE.slice(0, 4),
      '/status',
      '╭───────────────────────────────────────────╮',
      '│  >_ OpenAI Codex (v0.171.0)               │',
      '│  Model:               GPT-6-Luna (reasoning medium) │',
      '│  Permissions:         Workspace (granular) │',
      '╰───────────────────────────────────────────╯',
      '',
      '› Ask Codex to do anything',
      '',
      '  GPT-6-Luna medium · ~\\work\\app',
    ];
    const chrome = new Set(CODEX_IDLE.filter((l) => l.trim()).slice(-4).map((l) => l.trim()));
    const out = extractCommandOutput(CODEX_IDLE, after, '/status', chrome);
    expect(out).toContain('Model:               GPT-6-Luna (reasoning medium)');
    expect(out).toContain('Permissions:');
    expect(out).not.toContain('Ask Codex');
    expect(out).not.toContain('·');
    expect(out).not.toContain('╭');
  });

  it('keeps only new rows when a full-screen TUI redraws its viewport', () => {
    const before = ['  OpenCode', '', '> ', '  build · anthropic/claude'];
    const after = ['  OpenCode', '  Status', '  Provider: anthropic', '> ', '  build · anthropic/claude'];
    expect(extractCommandOutput(before, after, '/status')).toBe('Status\nProvider: anthropic');
  });

  it('reads nothing when the command printed nothing', () => {
    expect(extractCommandOutput(CODEX_IDLE, [...CODEX_IDLE], '/clear', new Set(['› Ask Codex to do anything']))).toBeNull();
  });
});

describe("Codex's footer", () => {
  it('names the live model and effort', () => {
    expect(codexFooterModel(CODEX_IDLE.join('\n'))).toEqual({ model: 'gpt-6-luna', effort: 'medium' });
    expect(codexFooterModel('  GPT-5.6-Terra extra high · C:\\src')).toEqual({ model: 'gpt-5.6-terra', effort: 'xhigh' });
    expect(codexFooterModel('  gpt-6-luna · /home/me')).toEqual({ model: 'gpt-6-luna', effort: null });
    expect(codexFooterModel('Working (3s · esc to interrupt)')).toBeNull();
  });
});

describe('OpenCode dialogs', () => {
  it("reads OpenCode's /status dialog without its close hint or prompt box", () => {
    const before = [
      '                       ┃',
      '                       ┃  Ask anything… "Fix broken tests"',
      '                       ┃',
      '                       ┃  Build · GPT-5.1 Abacus',
      '                       …/app  shift+tab agents  ctrl+p commands',
    ];
    const after = [
      '                                 Status                                             esc',
      '                                 No MCP servers',
      ...before,
    ];
    const chrome = new Set(before.filter((l) => l.trim()).slice(-4).map((l) => l.trim()));
    expect(extractCommandOutput(before, after, '/status', chrome)).toBe('Status\nNo MCP servers');
  });
});
