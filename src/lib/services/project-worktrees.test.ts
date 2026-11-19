import { beforeEach, describe, expect, it, vi } from 'vitest';

const backendMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('$lib/services/backend', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  backendInvoke: backendMock,
}));

const { deleteProjectWorktree, isPathInside, orderWorktreeTree, worktreeForPath } = await import('./project-worktrees');
const store = await import('$lib/stores/projectWorktrees');
const { get } = await import('$lib/stores/storeCompat');

type Row = import('./project-worktrees').ProjectWorktree;

const ROOT = 'C:\\repo';
function row(over: Partial<Row>): Row {
  return {
    path: ROOT,
    branch: 'main',
    head: 'abc',
    is_main: false,
    name: 'x',
    note: null,
    parent: null,
    base_ref: null,
    created_at: null,
    missing: false,
    ...over,
  };
}
const main = row({ is_main: true, name: 'repo' });
const login = row({ path: `${ROOT}\\.spacron\\trees\\login`, name: 'login', branch: 'login', created_at: 1 });
const child = row({ path: `${ROOT}\\.spacron\\trees\\child`, name: 'child', branch: 'child', parent: login.path, created_at: 2 });

describe('path helpers', () => {
  it('compares paths ignoring case and separators', () => {
    expect(isPathInside('c:/REPO/src', ROOT)).toBe(true);
    expect(isPathInside(ROOT, ROOT)).toBe(true);
    expect(isPathInside('C:\\repo-other', ROOT)).toBe(false);
  });

  it('puts a folder in the deepest worktree, never the main checkout that contains them all', () => {
    const all = [main, login];
    expect(worktreeForPath(all, `${login.path}\\src`)?.name).toBe('login');
    expect(worktreeForPath(all, `${ROOT}\\src`)?.is_main).toBe(true);
    expect(worktreeForPath(all, null)?.is_main).toBe(true);
  });

  it('nests children under their parent and lifts orphans to the top', () => {
    const orphan = row({ path: `${ROOT}\\.spacron\\trees\\o`, name: 'o', parent: `${ROOT}\\.spacron\\trees\\gone` });
    const ordered = orderWorktreeTree([main, child, login, orphan]);
    expect(ordered.map((r) => [r.worktree.name, r.depth])).toEqual([
      ['repo', 0],
      ['login', 0],
      ['child', 1],
      ['o', 0],
    ]);
  });

  it('survives a parent cycle without dropping rows', () => {
    const a = row({ path: `${ROOT}\\a`, name: 'a', parent: `${ROOT}\\b` });
    const b = row({ path: `${ROOT}\\b`, name: 'b', parent: `${ROOT}\\a` });
    expect(orderWorktreeTree([a, b]).map((r) => r.worktree.name).sort()).toEqual(['a', 'b']);
  });
});

describe('delete', () => {
  beforeEach(() => backendMock.mockReset());

  it('reports uncommitted changes as dirty so the caller can ask first', async () => {
    backendMock.mockRejectedValueOnce('DIRTY: This worktree has uncommitted changes.');
    const result = await deleteProjectWorktree('p', login.path);
    expect(result).toEqual({ ok: false, dirty: true, error: 'This worktree has uncommitted changes.' });
  });

  it('passes through a kept branch', async () => {
    backendMock.mockResolvedValueOnce({ preserved_branch: 'login' });
    expect(await deleteProjectWorktree('p', login.path, true)).toEqual({ ok: true, preservedBranch: 'login' });
    expect(backendMock).toHaveBeenCalledWith('project_worktree_delete', { projectId: 'p', worktreePath: login.path, force: true });
  });
});

describe('active worktree', () => {
  beforeEach(() => {
    backendMock.mockReset();
    store.worktreesByProject.set({});
    store.activeWorktreeByProject.set({});
  });

  it('defaults to the project root', () => {
    expect(store.getActiveWorktreePath('p')).toBeNull();
    expect(store.workingRootFor('p', ROOT)).toBe(ROOT);
  });

  it('sends new work to the selected worktree and back to the root for main', async () => {
    backendMock.mockResolvedValueOnce([main, login]);
    await store.refreshProjectWorktrees('p');
    store.setActiveWorktree('p', login.path);
    expect(store.workingRootFor('p', ROOT)).toBe(login.path);
    store.setActiveWorktree('p', main.path);
    expect(store.getActiveWorktreePath('p')).toBeNull();
  });

  it('forgets a selection whose worktree was deleted', async () => {
    backendMock.mockResolvedValueOnce([main, login]);
    await store.refreshProjectWorktrees('p');
    store.setActiveWorktree('p', login.path);
    backendMock.mockResolvedValueOnce([main]);
    await store.refreshProjectWorktrees('p');
    expect(get(store.activeWorktreeByProject).p).toBeUndefined();
    expect(store.workingRootFor('p', ROOT)).toBe(ROOT);
  });

  it('ignores a missing worktree', async () => {
    backendMock.mockResolvedValueOnce([main, { ...login, missing: true }]);
    await store.refreshProjectWorktrees('p');
    store.activeWorktreeByProject.set({ p: login.path });
    expect(store.getActiveWorktreePath('p')).toBeNull();
  });

  it('treats a failed list as no worktrees rather than throwing', async () => {
    backendMock.mockRejectedValueOnce(new Error('unsupported remote command'));
    await expect(store.refreshProjectWorktrees('p')).resolves.toEqual([]);
  });
});
