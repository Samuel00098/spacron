import { describe, expect, it } from 'vitest';
import { cleanAgentScreen } from './terminal-screen';

// A rendered Codex screen, as xterm holds it after every repaint has landed.
const CODEX_SCREEN = [
  '╭──────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.157.1)                   │',
  '│ model: GPT-6-Luna high   /model to change    │',
  '│ directory: ~\\OneDrive\\Documents\\sello        │',
  '╰──────────────────────────────────────────────╯',
  '',
  '› tell them to check out the project',
  '',
  '• I’ll check the project’s collaboration context to see who “them” refers to.',
  '',
  '• Ran Get-Content -LiteralPath .spacron/memory/INDEX.md',
  '  └ (no output)',
  '',
  '• There is no team list in this project, so I need to know who to contact.',
  '',
  '• Working (19s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close',
  '',
  '› Ask Codex to do anything',
  '',
  '  ? for shortcuts',
  '  model: GPT-6-Luna high /model to change  ↓ Back to bottom · esc',
].join('\n');

describe('cleanAgentScreen', () => {
  it('keeps only the reply after the prompt echo and drops the CLI chrome', () => {
    const text = cleanAgentScreen(CODEX_SCREEN, 'tell them to check out the project');
    expect(text).toBe([
      '• I’ll check the project’s collaboration context to see who “them” refers to.',
      '',
      '• Ran Get-Content -LiteralPath .spacron/memory/INDEX.md',
      '  └ (no output)',
      '',
      '• There is no team list in this project, so I need to know who to contact.',
    ].join('\n'));
  });

  it('drops chrome but keeps everything when the prompt is unknown', () => {
    const text = cleanAgentScreen(CODEX_SCREEN);
    expect(text).toContain('› tell them to check out the project');
    expect(text).toContain('There is no team list');
    expect(text).not.toMatch(/esc to interrupt|for shortcuts|OpenAI Codex|model to change|Ask Codex/);
  });

  it('skips the wrapped rows of a long prompt', () => {
    const prompt = 'Review the settings page and the router, then write a short summary of anything that looks broken';
    const screen = [
      '› Review the settings page and the router, then write a short summary of',
      '  anything that looks broken',
      '',
      '● The router has a duplicate /settings route.',
    ].join('\n');
    expect(cleanAgentScreen(screen, prompt)).toBe('● The router has a duplicate /settings route.');
  });

  it('keeps an ordinary sentence that merely mentions a status word', () => {
    const screen = '› fix it\n\n• The model directory is now configurable.';
    expect(cleanAgentScreen(screen, 'fix it')).toBe('• The model directory is now configurable.');
  });

  it('reads a Codex pane whose pasted prompt is still in the composer as empty', () => {
    // What Chat showed as an agent "reply": the unsubmitted paste and the footer.
    const screen = [
      '│ permissions: YOLO mode                       │',
      '╰──────────────────────────────────────────────╯',
      '',
      '› [Pasted Content 6830 chars]',
      '',
      '  GPT-6-Luna high · ~\\OneDrive\\Documents\\Projects\\Real Projects\\clipforge',
    ].join('\n');
    expect(cleanAgentScreen(screen)).toBe('');
    expect(cleanAgentScreen(screen, 'Inspect the ClipForge project')).toBe('');
  });

  it("starts after a pasted prompt's placeholder echo", () => {
    const screen = [
      '› [Pasted Content 5236 chars]',
      '',
      '• ClipForge is a desktop video clipper.',
      '',
      '› Ask Codex to do anything',
      '',
      '  GPT-6-Luna high · C:\\repo\\clipforge',
    ].join('\n');
    expect(cleanAgentScreen(screen, 'GOAL: Perform an independent read-only review')).toBe('• ClipForge is a desktop video clipper.');
  });

  it('keeps a reply line that uses a middle dot in prose', () => {
    const screen = '› fix it\n\n• Build · tests · lint all pass.';
    expect(cleanAgentScreen(screen, 'fix it')).toBe('• Build · tests · lint all pass.');
  });
});
