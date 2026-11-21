import { describe, expect, it } from 'vitest';
import type { TerminalChatItem } from './terminal-chat';
import {
  fileChangesFor,
  forkArgs,
  latestTodos,
  lineDiff,
  mentionAt,
  opensInTerminal,
  slashCommandsFor,
  openedPullRequests,
  parseApplyPatch,
  rollupChanges,
  runGlyph,
  runSentence,
  toolCategory,
  toolLine,
  slashQuery,
  subagentFor,
  trailingUsageLimit,
  usageLimitIn,
  withContext,
} from './terminal-chat-rich';

const tool = (name: string, toolData: unknown, extra: Partial<TerminalChatItem> = {}): TerminalChatItem => ({
  id: `${name}-${Math.random()}`,
  kind: 'tool',
  text: '',
  toolName: name,
  toolStatus: 'done',
  toolData,
  ...extra,
});

describe('terminal chat rich helpers', () => {
  it('diffs lines and keeps context around changes', () => {
    const lines = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(lines).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
      { type: 'add', text: 'd' },
    ]);
    const long = lineDiff(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 20 }, (_, i) => (i === 10 ? 'x' : `l${i}`)).join('\n'));
    const shown = withContext(long, 2);
    expect(shown.filter((l) => l?.type === 'ctx')).toHaveLength(4);
  });

  it('reads Claude edits, writes and Codex patches', () => {
    const edit = fileChangesFor(tool('Edit', { file_path: 'src/a.ts', old_string: 'x\ny', new_string: 'x\nz' }));
    expect(edit).toMatchObject([{ path: 'src/a.ts', kind: 'edit', added: 1, removed: 1 }]);
    const write = fileChangesFor(tool('Write', { file_path: 'b.md', content: 'one\ntwo' }));
    expect(write).toMatchObject([{ kind: 'write', added: 2, removed: 0 }]);
    const patch = parseApplyPatch('*** Begin Patch\n*** Update File: a.rs\n@@\n-old\n+new\n ctx\n*** Add File: b.rs\n+hi\n*** End Patch');
    expect(patch).toMatchObject([
      { path: 'a.rs', kind: 'edit', added: 1, removed: 1 },
      { path: 'b.rs', kind: 'write', added: 1 },
    ]);
    expect(fileChangesFor(tool('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }, { toolStatus: 'error' }))).toEqual([]);
  });

  it('rolls a turn up per file', () => {
    const items = [
      tool('Write', { file_path: 'n.ts', content: 'a' }),
      tool('Edit', { file_path: 'n.ts', old_string: 'a', new_string: 'b' }),
      tool('Edit', { file_path: 'm.ts', old_string: 'a', new_string: 'b' }),
    ];
    expect(rollupChanges(items)).toEqual([
      { path: 'n.ts', added: 2, removed: 1, created: true, deleted: false },
      { path: 'm.ts', added: 1, removed: 1, created: false, deleted: false },
    ]);
  });

  it('finds the latest to-do list from any CLI', () => {
    const items = [
      tool('TodoWrite', { todos: [{ content: 'Old', status: 'pending' }] }),
      tool('update_plan', { plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'in_progress' }] }),
    ];
    expect(latestTodos(items)).toEqual([
      { text: 'Read', status: 'completed' },
      { text: 'Write', status: 'in_progress' },
    ]);
    expect(latestTodos([tool('Bash', null)])).toBeNull();
  });

  it('recognises subagents and opened pull requests', () => {
    expect(subagentFor(tool('Agent', { description: 'Search', prompt: 'find x', subagent_type: 'Explore' }))).toEqual({
      description: 'Search', type: 'Explore', prompt: 'find x',
    });
    expect(subagentFor(tool('Bash', { command: 'ls' }))).toBeNull();
    const pr = tool('Bash', null, { toolInput: 'gh pr create --fill', toolOutput: 'https://github.com/o/r/pull/12\n' });
    expect(openedPullRequests(pr)).toEqual(['https://github.com/o/r/pull/12']);
    expect(openedPullRequests(tool('Bash', null, { toolInput: 'gh pr view', toolOutput: 'https://github.com/o/r/pull/12' }))).toEqual([]);
  });

  it('reads usage-limit resets', () => {
    const now = new Date(2026, 10, 20, 13, 0).getTime();
    expect(usageLimitIn('Claude AI usage limit reached|1763650800', now)?.resetsAt).toBe(1763650800000);
    const at = usageLimitIn("You've hit your usage limit. Try again at 3:05 PM.", now)!;
    expect(new Date(at.resetsAt!).getHours()).toBe(15);
    expect(new Date(at.resetsAt!).getMinutes()).toBe(5);
    expect(usageLimitIn('5-hour limit reached ∙ resets in 2h 30m', now)?.resetsAt).toBe(now + 150 * 60_000);
    expect(usageLimitIn('All good here', now)).toBeNull();
    const items: TerminalChatItem[] = [
      { id: 'u', kind: 'user', text: 'go' },
      { id: 'a', kind: 'assistant', text: 'Usage limit reached|1763650800' },
    ];
    expect(trailingUsageLimit(items)?.id).toBe('a');
    expect(trailingUsageLimit([...items, { id: 'u2', kind: 'user', text: 'continue' }])).toBeNull();
  });

  it('parses composer triggers and fork args', () => {
    expect(slashQuery('/comp')).toBe('comp');
    expect(slashQuery('/compact now')).toBeNull();
    expect(mentionAt('look at @src/li', 15)).toEqual({ start: 8, query: 'src/li' });
    expect(mentionAt('mail me@x', 9)).toBeNull();
    expect(forkArgs('codex', 'abc')).toBe('fork abc');
    expect(forkArgs('opencode', 'abc')).toBeNull();
  });

  it('classifies tool calls the way Orca labels them', () => {
    const read = tool('Read', null, { toolInput: 'src/lib/App.tsx' });
    const bash = tool('Bash', null, { toolInput: 'npm test' });
    const codexRead = tool('shell', null, { toolInput: 'sed -n 1,80p src/main.rs' });
    const grep = tool('Grep', null, { toolInput: 'useStore' });
    const edit = tool('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' });
    const mcp = tool('mcp__spacron-mcp__report_status', null, { toolInput: '{}' });
    expect([read, bash, codexRead, grep, edit, mcp].map(toolCategory)).toEqual(['read', 'command', 'read', 'search', 'fileChange', 'mcp']);
    expect(toolLine(read, false)).toMatchObject({ verb: 'Read', target: 'App.tsx', context: 'src/lib' });
    expect(toolLine({ ...bash, toolStatus: 'running' }, true)).toMatchObject({ verb: 'Running', target: 'npm test', code: true });
    expect(toolLine(bash, true).verb).toBe('Ran');
    expect(toolLine(edit, false)).toMatchObject({ verb: 'Edited', target: 'a.ts', added: 1, removed: 1 });
    expect(toolLine(mcp, false)).toMatchObject({ target: 'report status', context: 'spacron-mcp' });
    expect(toolLine(tool('Read', null, { toolInput: 'x.ts', toolStatus: 'error' }), false).verb).toBe('Tried to read');
  });

  it('writes the run header as one sentence', () => {
    const items = [
      tool('Read', null, { toolInput: 'a.ts' }),
      tool('Read', null, { toolInput: 'b.ts' }),
      tool('Grep', null, { toolInput: 'x' }),
      tool('Bash', null, { toolInput: 'npm test' }),
    ];
    expect(runSentence(items, false)).toBe('Read 2 files, searched 1 time, and ran 1 command');
    expect(runSentence(items.slice(0, 2), true)).toBe('Reading 2 files');
    expect(runSentence(items.slice(2), false)).toBe('Searched 1 time and ran 1 command');
    expect(runGlyph(items.slice(0, 2))).toBe('eye');
    expect(runGlyph(items)).toBe('wrench');
    const edits = [
      tool('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      tool('Edit', { file_path: 'a.ts', old_string: 'y', new_string: 'z' }),
    ];
    expect(runSentence(edits, false)).toBe('Edited 1 file');
  });

  it('keeps slash commands in the chat unless they open a TUI screen (Orca)', () => {
    expect(opensInTerminal('codex', '/compact')).toBe(false);
    expect(opensInTerminal('codex', '/resume')).toBe(true);
    // With an argument there is no picker to show.
    expect(opensInTerminal('codex', '/resume abc')).toBe(false);
    expect(opensInTerminal('claude', '/context')).toBe(false);
    expect(opensInTerminal('claude', '/rewind')).toBe(true);
    expect(opensInTerminal('opencode', '/models')).toBe(true);
    expect(slashCommandsFor('grok')).toEqual([]);
    expect(slashCommandsFor('pi').map((c) => c.name)).toContain('/compact');
  });
});
