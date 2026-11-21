import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
// No pane is mounted in tests; the capture reads an empty screen.
vi.mock('$lib/services/terminal-screen', () => ({
  markTerminalScreen: () => null,
  readTerminalScreen: () => '',
}));

import { forgetChatCommands, getSentCommands, noteTerminalInput, resolveTypedCommand } from './terminal-chat-commands';

describe('slash commands typed in the terminal', () => {
  beforeEach(() => forgetChatCommands(1));

  it('records a command submitted in a Codex pane', () => {
    for (const ch of '/stat') noteTerminalInput(1, 'codex', ch);
    noteTerminalInput(1, 'codex', 'us');
    noteTerminalInput(1, 'codex', '\r');
    expect(getSentCommands(1).map((c) => [c.text, c.fromTerminal])).toEqual([['/status', true]]);
  });

  it('follows backspace and ignores prompts and lines it lost track of', () => {
    noteTerminalInput(1, 'codex', '/diffx\x7f\r');
    noteTerminalInput(1, 'codex', 'fix the bug\r');
    // An arrow key moves the cursor: the line can't be trusted any more.
    noteTerminalInput(1, 'codex', '/sta\x1b[Dx\r');
    expect(getSentCommands(1).map((c) => c.text)).toEqual(['/diff']);
  });

  it("leaves Claude Code's commands to its transcript, and ignores plain shells", () => {
    noteTerminalInput(1, 'claude', '/status\r');
    noteTerminalInput(1, null, '/status\r');
    expect(getSentCommands(1)).toEqual([]);
  });

  it('completes a typed prefix the way the `/` popup does', () => {
    expect(resolveTypedCommand('codex', '/stat')).toBe('/status');
    expect(resolveTypedCommand('opencode', '/mod')).toBe('/models');
    expect(resolveTypedCommand('codex', '/my-skill arg')).toBe('/my-skill arg');
    expect(resolveTypedCommand('codex', 'hello')).toBeNull();
  });
});
