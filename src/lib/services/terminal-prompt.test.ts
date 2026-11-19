import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { parseScreenPrompt, promptKey } from './terminal-prompt';

// Captured from Claude Code 2.1 (AskUserQuestion) running in a ConPTY.
const CLAUDE_QUESTION = `❯ Use your AskUserQuestion tool to ask me exactly one question
────────────────────────────────────────────────────────────────
 ☐ Color
Which color do you prefer?
❯ 1. Red
     Red as your preferred color.
  2. Green
     Green as your preferred color.
  3. Blue
     Blue as your preferred color.
  4. Type something.
────────────────────────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`;

// Codex picker (same shape: › marker, "enter select · esc back").
const CODEX_PERMISSIONS = `  Update Model Permissions
› 1. Ask for approval (current)  Read and edit workspace files and run commands
  2. Approve for me              Only ask for actions detected as potentially unsafe
  3. Full Access                 Use with caution
  enter select · esc back`;

describe('terminal prompts', () => {
  it('reads a Claude question: header, question, options, descriptions, free text', () => {
    const prompt = parseScreenPrompt(CLAUDE_QUESTION);
    expect(prompt).not.toBeNull();
    expect(prompt!.header).toBe('Color');
    expect(prompt!.question).toBe('Which color do you prefer?');
    expect(prompt!.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue', 'Type something.', 'Chat about this']);
    expect(prompt!.options[0]).toMatchObject({ number: 1, highlighted: true, description: 'Red as your preferred color.' });
    expect(prompt!.options[3]).toMatchObject({ freeText: true, description: null });
    expect(prompt!.multiSelect).toBe(false);
  });

  it('reads a Codex prompt with inline descriptions', () => {
    const prompt = parseScreenPrompt(CODEX_PERMISSIONS);
    expect(prompt!.question).toBe('Update Model Permissions');
    expect(prompt!.options.map((o) => o.label)).toEqual(['Ask for approval (current)', 'Approve for me', 'Full Access']);
    expect(prompt!.options[1].description).toBe('Only ask for actions detected as potentially unsafe');
  });

  it('ignores an ordinary screen and a numbered list in a reply', () => {
    expect(parseScreenPrompt('❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)')).toBeNull();
    expect(parseScreenPrompt('Steps:\n1. Build\n2. Test\n❯ ')).toBeNull();
  });

  it('keys a prompt by its question and options, not by the highlight', () => {
    const moved = CLAUDE_QUESTION.replace('❯ 1. Red', '  1. Red').replace('  2. Green', '❯ 2. Green');
    expect(promptKey(parseScreenPrompt(moved)!)).toBe(promptKey(parseScreenPrompt(CLAUDE_QUESTION)!));
  });
});
