import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';

import {
  filterHistory,
  detectHistoryAgents,
  withHistoryOwners,
  resolveHistoryFolders,
  historyAccountIssue,
  historyAgentOptions,
  selectedHistoryAgents,
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
  it('forces fresh CLI detection without requesting usage meters', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await expect(detectHistoryAgents()).resolves.toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith('usage_detect_agents', { force: true });
  });
  it('lists every installed and custom agent, including agents without a reader', () => {
    const options = historyAgentOptions([
      { command: 'agy', name: 'Antigravity', installed: true },
      { command: 'gemini', name: 'Gemini', installed: true },
      { command: 'codex', name: 'Codex', installed: false },
    ], [{ command: 'my-agent --chat', name: 'My agent' }], [row({ agent: 'codex' })]);
    expect(options.map((a) => a.id)).toEqual(['antigravity', 'codex', 'gemini', 'my-agent --chat']);
    expect(options[0]).toMatchObject({ command: 'agy', indexed: true, installed: true });
    expect(options[1]).toMatchObject({ installed: false, indexed: true });
    expect(options[2]).toMatchObject({ indexed: false, installed: true });
  });

  it('automatically includes a newly installed agent while keeping existing exclusions', () => {
    const before = historyAgentOptions([{ command: 'claude', name: 'Claude', installed: true }], [], []);
    const excluded = before.map((a) => a.id);
    const after = historyAgentOptions([
      { command: 'claude', name: 'Claude', installed: true },
      { command: 'cursor-agent', name: 'Cursor', installed: true },
    ], [], []);
    expect(selectedHistoryAgents(before, excluded)).toEqual([]);
    expect(selectedHistoryAgents(after, excluded)).toEqual(['cursor']);
    expect(filterHistory([row({ agent: 'cursor' })], { ...base, agents: selectedHistoryAgents(after, excluded) })).toHaveLength(1);
  });

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

  it('resolves recorded account labels for any provider without guessing an owner', () => {
    const accounts = [
      { provider: 'claude', id: 'default', label: 'claude-user@gmail.com' },
      { provider: 'codex', id: 'work', label: 'codex-work@corp.com' },
    ];

    // Claude with backend label
    expect(sessionAccountLabel(row({ agent: 'claude', accountLabel: 'direct@domain.com' }), accounts)).toBe('direct@domain.com');

    // Claude default account looked up from store
    expect(sessionAccountLabel(row({ agent: 'claude', account: null, accountLabel: 'Default account' }), accounts)).toBe('claude-user@gmail.com');

    // Codex managed account looked up from store
    expect(sessionAccountLabel(row({ agent: 'codex', account: 'work' }), accounts)).toBe('codex-work@corp.com');

    // Codex fallback to account id when not in known accounts
    expect(sessionAccountLabel(row({ agent: 'codex', account: 'custom-id' }), [])).toBe('custom-id');

    // Explicit owner metadata is preserved for any current or future provider.
    expect(sessionAccountLabel(row({ agent: 'opencode', account: 'some-acct', accountLabel: 'some-acct' }), accounts)).toBe('some-acct');
    expect(sessionAccountLabel(row({ agent: 'future-agent', accountLabel: 'old@company.com' }), accounts)).toBe('old@company.com');
    expect(sessionAccountLabel(row({ agent: 'claude', account: null, accountLabel: null }), accounts)).toBeNull();
  });

  it('builds the resume command each CLI uses', () => {
    expect(resumeCommand(row({ agent: 'claude', id: 'abc' }))).toBe('claude --resume abc');
    expect(resumeCommand(row({ agent: 'codex', id: 'abc' }))).toBe('codex resume abc');
    expect(resumeCommand(row({ agent: 'opencode', id: 'ses_1' }))).toBe('opencode --session ses_1');
    for (const [agent, expected] of [
      ['pi', 'pi --session abc'], ['omp', 'omp --resume abc'], ['antigravity', 'agy --conversation abc'],
      ['copilot', 'copilot --resume abc'], ['cursor', 'cursor-agent --resume abc'],
    ]) expect(resumeCommand(row({ agent, id: 'abc' }))).toBe(expected);
  });

  it('preserves historical account snapshots and separates equal ids across accounts', () => {
    const rows = [row({ account: 'work', accountLabel: 'current@example.com' }), row({ account: 'personal' })];
    const owners = [{ provider: 'claude', nativeSessionId: 's1', cwd: 'c:/users/me/proj', accountId: 'work', accountLabel: 'original@example.com' }];
    expect(withHistoryOwners(rows, owners).map((r) => r.accountLabel)).toEqual(['original@example.com', null]);
    expect(withHistoryOwners(rows, [{ ...owners[0], cwd: '/other' }])[0].accountLabel).toBe('current@example.com');
  });

  it('blocks reuse of a recorded owner profile after its login has changed', () => {
    const session = row({ agent: 'grok', account: 'work', accountLabel: 'original@example.com', accountLabelRecorded: true });
    const accounts = [{ provider: 'grok', id: 'work', label: 'other@example.com' }];
    expect(historyAccountIssue(session, accounts)).toContain('Restore the original login');
    expect(historyAccountIssue(session, [{ ...accounts[0], label: 'original@example.com' }])).toBeNull();
    expect(historyAccountIssue({ ...session, accountLabelRecorded: false }, accounts)).toBeNull();
  });

  it('recovers Cursor folders only when the transcript path has a unique known match', () => {
    const session = row({ agent: 'cursor', cwd: null, logPath: 'C:/Users/me/.cursor/projects/C-work-app/agent-transcripts/abc.jsonl' });
    expect(resolveHistoryFolders([session], ['C:/work/app'])[0].cwd).toBe('C:/work/app');
    expect(resolveHistoryFolders([session], ['C:/work/app', 'C:/work-app'])[0].cwd).toBeNull();
    expect(resolveHistoryFolders([session], ['D:/other'])[0].cwd).toBeNull();
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
