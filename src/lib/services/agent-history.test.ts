import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  filterHistory,
  folderName,
  groupHistory,
  isInside,
  resumeCommand,
  rowTitle,
  sessionAccountLabel,
  timeAgo,
  type HistoryFilter,
  type HistoryRow,
} from './agent-history';

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  agent: 'claude',
  id: 's1',
  title: '',
  firstPrompt: 'Fix the login bug',
  cwd: 'C:\\Users\\me\\proj',
  branch: 'main',
  model: 'm',
  messageCount: 4,
  createdMs: 1000,
  updatedMs: 2000,
  logPath: null,
  account: null,
  accountLabel: null,
  ...over,
});

const base: HistoryFilter = {
  scope: 'all',
  roots: [],
  agents: ['claude', 'codex', 'opencode'],
  query: '',
  hideEmpty: false,
  sort: 'updated',
};

describe('agent history', () => {
  it('matches paths regardless of slash style, case or trailing slash', () => {
    expect(isInside('C:/Users/me/proj', ['c:\\users\\me\\PROJ\\'])).toBe(true);
    expect(isInside('C:\\Users\\me\\proj\\sub', ['C:/Users/me/proj'])).toBe(true);
    expect(isInside('C:\\Users\\me\\project2', ['C:/Users/me/proj'])).toBe(false);
    expect(isInside(null, ['C:/x'])).toBe(false);
    expect(isInside('C:/x', [''])).toBe(false);
  });

  it('names a session by the CLI title, else the first prompt, first line only', () => {
    expect(rowTitle(row({ title: 'Red or Blue colour' }))).toBe('Red or Blue colour');
    expect(rowTitle(row({ firstPrompt: 'Line one\nline two' }))).toBe('Line one');
    expect(rowTitle(row({ firstPrompt: '', title: '' }))).toBe('Untitled session');
    expect(rowTitle(row({ firstPrompt: 'x'.repeat(200) })).length).toBe(90);
  });

  it('filters by project scope, agent, empty sessions and search', () => {
    const rows = [
      row({ id: 'a', accountLabel: 'work@example.com' }),
      row({ id: 'b', cwd: 'D:\\other', agent: 'codex', account: 'personal-acct' }),
      row({ id: 'c', messageCount: 0 }),
      row({ id: 'd', agent: 'opencode', firstPrompt: 'Add a retry', branch: 'dev' }),
    ];
    expect(filterHistory(rows, { ...base, scope: 'project', roots: ['C:/Users/me/proj'] }).map((r) => r.id)).toEqual(['a', 'c', 'd']);
    expect(filterHistory(rows, { ...base, agents: ['codex'] }).map((r) => r.id)).toEqual(['b']);
    expect(filterHistory(rows, { ...base, hideEmpty: true }).map((r) => r.id)).toEqual(['a', 'b', 'd']);
    expect(filterHistory(rows, { ...base, query: 'RETRY' }).map((r) => r.id)).toEqual(['d']);
    expect(filterHistory(rows, { ...base, query: 'dev' }).map((r) => r.id)).toEqual(['d']);
    expect(filterHistory(rows, { ...base, query: 'work@example.com' }).map((r) => r.id)).toEqual(['a']);
    expect(filterHistory(rows, { ...base, query: 'personal-acct' }).map((r) => r.id)).toEqual(['b']);
  });

  it('sorts by last updated or created', () => {
    const rows = [row({ id: 'a', createdMs: 1, updatedMs: 9 }), row({ id: 'b', createdMs: 5, updatedMs: 3 })];
    expect(filterHistory(rows, base).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterHistory(rows, { ...base, sort: 'created' }).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('groups by folder, agent, or account, keeping newest-first order', () => {
    const rows = [
      row({ id: 'a', cwd: 'C:/p/one', accountLabel: 'user@gmail.com' }),
      row({ id: 'b', cwd: 'C:\\p\\two', agent: 'codex', account: 'work-acct' }),
      row({ id: 'c', cwd: 'C:\\P\\ONE' }),
    ];
    const byFolder = groupHistory(rows, 'folder');
    expect(byFolder.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([['one', ['a', 'c']], ['two', ['b']]]);
    expect(groupHistory(rows, 'agent').map((g) => g.label)).toEqual(['Claude', 'Codex']);

    const byAccount = groupHistory(rows, 'account');
    expect(byAccount.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['user@gmail.com', ['a']],
      ['work-acct', ['b']],
      ['No account', ['c']],
    ]);

    const projects = [{ name: 'proj', roots: ['C:/p'] }];
    expect(groupHistory(rows, 'project', projects).map((g) => [g.label, g.rows.length])).toEqual([['proj', 3]]);
    // Outside every project: grouped by its own folder, never a shared "Other" bucket.
    const outside = [row({ id: 'x', cwd: 'D:/work/alpha' }), row({ id: 'y', cwd: String.raw`D:\work\beta` }), row({ id: 'z', cwd: 'd:/WORK/alpha' })];
    expect(groupHistory(outside, 'project', projects).map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([['alpha', ['x', 'z']], ['beta', ['y']]]);
    expect(groupHistory([], 'folder')).toEqual([]);
  });

  it('resolves account label only for agents that support it', () => {
    const accounts = [
      { provider: 'claude', id: 'default', label: 'claude-user@gmail.com' },
      { provider: 'codex', id: 'work', label: 'codex-work@corp.com' },
    ];

    // Claude with backend label
    expect(sessionAccountLabel(row({ agent: 'claude', accountLabel: 'direct@domain.com' }), accounts)).toBe('direct@domain.com');

    // Claude default account looked up from store
    expect(sessionAccountLabel(row({ agent: 'claude', account: null, accountLabel: null }), accounts)).toBe('claude-user@gmail.com');

    // Codex managed account looked up from store
    expect(sessionAccountLabel(row({ agent: 'codex', account: 'work' }), accounts)).toBe('codex-work@corp.com');

    // Codex fallback to account id when not in known accounts
    expect(sessionAccountLabel(row({ agent: 'codex', account: 'custom-id' }), [])).toBe('custom-id');

    // OpenCode does NOT support accounts - must return null even if account set
    expect(sessionAccountLabel(row({ agent: 'opencode', account: 'some-acct', accountLabel: 'some-acct' }), accounts)).toBeNull();
  });

  it('builds the resume command each CLI uses', () => {
    expect(resumeCommand(row({ agent: 'claude', id: 'abc' }))).toBe('claude --resume abc');
    expect(resumeCommand(row({ agent: 'codex', id: 'abc' }))).toBe('codex resume abc');
    expect(resumeCommand(row({ agent: 'opencode', id: 'ses_1' }))).toBe('opencode --session ses_1');
  });

  it('shows relative times and folder names', () => {
    const now = 10_000_000_000;
    expect(timeAgo(now - 30_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(folderName('C:\\a\\b\\')).toBe('b');
    expect(folderName(null)).toBe('Unknown folder');
  });
});
