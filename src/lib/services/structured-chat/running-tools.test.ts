import { describe, expect, it } from 'vitest';
import type { TerminalChatItem } from '$lib/services/terminal-chat';
import { groupRunningTools, toolKind } from './running-tools';

const tool = (id: string, toolName: string, input: unknown, toolStatus: 'running' | 'done' = 'running'): TerminalChatItem =>
  ({ id, kind: 'tool', text: '', toolName, toolInput: JSON.stringify(input), toolStatus });

describe('running tool groups', () => {
  it('classifies tools from every adapter by name', () => {
    expect(toolKind('Bash')).toBe('shell');
    expect(toolKind('commandExecution')).toBe('shell');
    expect(toolKind('Edit')).toBe('edit');
    expect(toolKind('WebFetch')).toBe('web');
    expect(toolKind('Task')).toBe('other');
    expect(toolKind(null)).toBe('other');
  });

  it('groups only running tools, shell first, with the command as detail', () => {
    const groups = groupRunningTools([
      tool('1', 'Edit', { file_path: 'src/a.ts' }),
      tool('2', 'Bash', { command: 'npm test', run_in_background: true }),
      tool('3', 'Bash', { command: 'ls' }, 'done'),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['shell', 'edit']);
    expect(groups[0].rows).toEqual([{ id: '2', name: 'Bash', detail: 'npm test', detached: true }]);
    expect(groups[1].rows[0].detail).toBe('src/a.ts');
  });

  it('tolerates missing or malformed input', () => {
    const groups = groupRunningTools([{ id: 'x', kind: 'tool', text: '', toolName: 'Bash', toolInput: '{not json', toolStatus: 'running' }]);
    expect(groups[0].rows[0]).toMatchObject({ detail: '', detached: false });
  });
});
