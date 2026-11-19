import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { bottomOf, claudeModeFromScreen, normalizeName, parsePickerRows } from './terminal-chat-inplace';

// Screens captured from Codex 0.170 and Claude Code 2.1 running in a ConPTY.
const CODEX_MODEL_PICKER = `  >_ OpenAI Codex (v0.170.0)
     ~\\Documents\\Samuel Works\\spacron
  Select Model and Effort
› 1. GPT-6-Luna (current)  Fast and affordable model for easier tasks.
  2. GPT-5.6-Terra         Legacy balanced model for agentic coding.
  3. GPT-5.6-Luna          Legacy fast model for simpler tasks.
  enter select · esc back`;

const CODEX_EFFORT_PICKER = `  Select Reasoning Level for GPT-6-Luna
  1. Low                         Fast responses with lighter reasoning
› 2. Medium (default) (current)  Balances speed and reasoning depth for everyday tasks
  3. High                        Greater reasoning depth for complex problems
  4. Extra high                  Extra high reasoning depth for complex problems
  5. More reasoning…             Max consumes usage limits faster
  enter default · s session · esc back`;

const CODEX_PERMISSIONS = `  Update Model Permissions
› 1. Ask for approval (current)  Read and edit workspace files and run commands, with approval required for internet
                                 access or edits outside the workspace
  2. Approve for me              Only ask for actions detected as potentially unsafe
  3. Full Access                 Use with caution: Codex can edit files outside this workspace and access the internet
                                 without approval
  4. Read Only                   Read workspace files, with approval required for edits or internet access
  enter select · esc back`;

describe('in-place session changes', () => {
  it('reads Codex model rows, the highlight and the current model', () => {
    const rows = parsePickerRows(CODEX_MODEL_PICKER, 'Select Model and Effort');
    expect(rows.map((r) => r.label)).toEqual(['GPT-6-Luna', 'GPT-5.6-Terra', 'GPT-5.6-Luna']);
    expect(rows[0]).toMatchObject({ highlighted: true, current: true });
    expect(rows[1]).toMatchObject({ highlighted: false, current: false });
    expect(normalizeName('gpt-5.6-terra')).toBe(normalizeName(rows[1].label));
  });

  it('reads Codex effort rows without the (default)/(current) tags', () => {
    const rows = parsePickerRows(CODEX_EFFORT_PICKER, 'Select Reasoning Level');
    expect(rows.map((r) => r.label)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'More reasoning…']);
    expect(rows.find((r) => r.current)?.label).toBe('Medium');
  });

  it('skips wrapped description lines in the permissions picker', () => {
    const rows = parsePickerRows(CODEX_PERMISSIONS, 'Update Model Permissions');
    expect(rows.map((r) => r.label)).toEqual(['Ask for approval', 'Approve for me', 'Full Access', 'Read Only']);
  });

  it('reads the Claude Code permission mode from its footer', () => {
    expect(claudeModeFromScreen('… \n  ⏸ manual mode on')).toBe('ask');
    expect(claudeModeFromScreen('… \n  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe('accept-edits');
    expect(claudeModeFromScreen('… \n  ⏵⏵ auto mode on (shift+tab to cycle)')).toBe('auto');
    expect(claudeModeFromScreen('… \n  ⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('full-access');
    expect(claudeModeFromScreen('… \n  ⏸ plan mode on (shift+tab to cycle)')).toBe('plan');
    expect(claudeModeFromScreen('no footer here')).toBeNull();
  });

  it('reads only the newest picker when an older one is still in scrollback', () => {
    const screen = [
      CODEX_EFFORT_PICKER,
      '• Model changed to gpt-6-luna medium for this session only',
      '› hello',
      ...Array.from({ length: 30 }, (_, i) => `  reply line ${i}`),
      CODEX_MODEL_PICKER.replace('› 1. GPT-6-Luna (current)', '  1. GPT-6-Luna (current)').replace('  2. GPT-5.6-Terra', '› 2. GPT-5.6-Terra'),
    ].join('\n');
    const rows = parsePickerRows(screen, 'Select Model and Effort');
    expect(rows.find((r) => r.highlighted)?.label).toBe('GPT-5.6-Terra');
    // The earlier confirmation is above the bottom of the screen, so it can't pass for a new one.
    expect(bottomOf(screen)).not.toMatch(/Model changed to/);
    expect(bottomOf(screen)).toMatch(/Select Model and Effort/);
  });
});
