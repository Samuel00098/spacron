import { beforeEach, describe, expect, it, vi } from 'vitest';

const pane = vi.hoisted(() => ({ writes: [] as string[], screen: '', onWrite: null as null | ((data: string) => void) }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/stores/terminal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeToSession: (_id: number, data: string) => { pane.writes.push(data); pane.onWrite?.(data); },
  getSessionOutputLength: () => 0,
  getSessionRoot: () => 'C:\\Users\\SMIDS MAN\\Documents\\Samuel Works\\Video Gen',
}));
vi.mock('$lib/services/terminal-screen', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTerminalScreen: () => pane.screen,
}));

import { quitAgentCli, shellPromptShowing } from './terminal-chat';

const PROMPT = 'C:\\Users\\SMIDS MAN\\Documents\\Samuel Works\\Video Gen>';

describe('quitting the CLI before a switch', () => {
  beforeEach(() => {
    pane.writes = [];
    pane.onWrite = null;
  });

  it('sends nothing when the CLI has already exited to the shell', async () => {
    pane.screen = `some output\n${PROMPT}`;
    expect(await quitAgentCli(1)).toBe(true);
    expect(pane.writes).toEqual([]);
  });

  it('sends one Ctrl+C pair when the CLI quits on it', async () => {
    pane.screen = '> claude is waiting';
    pane.onWrite = () => { if (pane.writes.length >= 2) pane.screen = `bye\n${PROMPT}`; };
    expect(await quitAgentCli(1)).toBe(true);
    expect(pane.writes).toEqual(['\x03', '\x03']);
  });

  it('accepts a cmd prompt in another folder than the project root', () => {
    pane.screen = 'C:\\Users\\SMIDS MAN\\worktrees\\feature>';
    expect(shellPromptShowing(1)).toBe(true);
    pane.screen = '│ > type here';
    expect(shellPromptShowing(1)).toBe(false);
  });
});
