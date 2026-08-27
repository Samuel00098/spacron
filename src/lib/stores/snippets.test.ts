import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';

/**
 * These tests are about **whether a snippet the user typed comes back**.
 *
 * A snippet lives in one of two places depending on its scope: a global one in
 * `localStorage`, a project one in `<root>/.spacron/snippets.json`. Both halves
 * share a single in-memory list, and every load merges into that list by
 * filtering out the slice it is about to replace — so a load for one scope must
 * never take the other scope's snippets with it. That merge is the part with no
 * type to protect it, which is why it is pinned here.
 *
 * The project file deliberately stores no `projectId`: the field is re-stamped
 * on load from the project doing the loading, so the file stays portable and a
 * project whose id changed still finds its own snippets.
 */

interface FakeBackend {
  files: Map<string, string>;
  invoke: ReturnType<typeof vi.fn>;
}

const backend = vi.hoisted<FakeBackend>(() => {
  const files = new Map<string, string>();
  const invoke = vi.fn(async (command: string, args?: any): Promise<any> => {
    switch (command) {
      case 'fs_read_file': {
        const content = files.get(args.path);
        if (content === undefined) throw new Error('No such file');
        return content;
      }
      case 'fs_write_file':
        files.set(args.path, args.content);
        return null;
      case 'fs_create_dir':
        return null;
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  });
  return { files, invoke };
});

vi.mock('$lib/services/backend', () => ({ backendInvoke: backend.invoke }));

const PROJECT = { id: 'proj-a', root_path: '/repo' };
const SNIPPETS_PATH = '/repo/.spacron/snippets.json';

/** The `localStorage` half of the store, as a plain map. */
let store: Map<string, string>;

/**
 * Load a *fresh copy* of the module, the way relaunching the app would: the
 * in-memory list starts empty and everything has to come back off disk.
 */
async function freshSession() {
  vi.resetModules();
  return import('./snippets');
}

beforeEach(() => {
  backend.invoke.mockClear();
  backend.files.clear();
  store = new Map();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});

describe('project snippets', () => {
  it('comes back in the next session', async () => {
    const first = await freshSession();
    await first.loadProjectSnippets(PROJECT);
    first.addSnippet('dev build', 'npm run tauri dev', '', PROJECT.id);
    await vi.waitFor(() => expect(backend.files.has(SNIPPETS_PATH)).toBe(true));

    const next = await freshSession();
    await next.loadProjectSnippets(PROJECT);

    const loaded = get(next.snippets);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: 'dev build',
      command: 'npm run tauri dev',
      projectId: PROJECT.id,
    });
  });

  it('is stored without a projectId, and re-stamped on load', async () => {
    const session = await freshSession();
    await session.loadProjectSnippets(PROJECT);
    session.addSnippet('dev build', 'npm run tauri dev', '', PROJECT.id);
    await vi.waitFor(() => expect(backend.files.has(SNIPPETS_PATH)).toBe(true));

    expect(JSON.parse(backend.files.get(SNIPPETS_PATH)!)[0]).not.toHaveProperty('projectId');

    // The same folder opened under a new id still finds its snippets.
    const renamed = await freshSession();
    await renamed.loadProjectSnippets({ id: 'proj-b', root_path: '/repo' });
    expect(get(renamed.snippets)[0]).toMatchObject({ projectId: 'proj-b' });
  });

  it('survives a project with no snippets file yet', async () => {
    const session = await freshSession();
    await expect(session.loadProjectSnippets(PROJECT)).resolves.toBeUndefined();
    expect(get(session.snippets)).toEqual([]);
  });
});

describe('global snippets', () => {
  it('comes back in the next session', async () => {
    const first = await freshSession();
    first.addSnippet('list ports', 'lsof -i -P', '');

    const next = await freshSession();
    next.loadGlobalSnippets();

    expect(get(next.snippets)).toHaveLength(1);
    expect(get(next.snippets)[0]).toMatchObject({ name: 'list ports', command: 'lsof -i -P' });
    // `JSON.stringify` drops the undefined `projectId`, so it comes back as an
    // absent key rather than an explicit one. Both read as global — which is
    // what every scope filter in the panel actually tests.
    expect(get(next.snippets)[0].projectId).toBeUndefined();
  });

  it('does not lose the snippet when the write fails', async () => {
    const session = await freshSession();
    (globalThis as any).localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    // The in-memory list still takes it, so the panel does not blank out mid-edit.
    expect(() => session.addSnippet('list ports', 'lsof -i -P', '')).not.toThrow();
    expect(get(session.snippets)).toHaveLength(1);
  });
});

describe('the two scopes share one list', () => {
  it('loading a project keeps the global snippets', async () => {
    const session = await freshSession();
    session.addSnippet('list ports', 'lsof -i -P', '');
    backend.files.set(SNIPPETS_PATH, JSON.stringify([{ id: 'p1', name: 'dev', command: 'npm run dev', description: '' }]));

    await session.loadProjectSnippets(PROJECT);

    expect(get(session.snippets).map((s) => s.name).sort()).toEqual(['dev', 'list ports']);
  });

  it('loading the globals keeps the project snippets', async () => {
    const session = await freshSession();
    backend.files.set(SNIPPETS_PATH, JSON.stringify([{ id: 'p1', name: 'dev', command: 'npm run dev', description: '' }]));
    await session.loadProjectSnippets(PROJECT);
    store.set('spacron_global_snippets', JSON.stringify([{ id: 'g1', name: 'list ports', command: 'lsof -i -P', description: '' }]));

    session.loadGlobalSnippets();

    expect(get(session.snippets).map((s) => s.name).sort()).toEqual(['dev', 'list ports']);
  });

  it('deleting a global snippet leaves the project file alone', async () => {
    const session = await freshSession();
    await session.loadProjectSnippets(PROJECT);
    const project = session.addSnippet('dev', 'npm run dev', '', PROJECT.id);
    const global = session.addSnippet('list ports', 'lsof -i -P', '');
    await vi.waitFor(() => expect(backend.files.has(SNIPPETS_PATH)).toBe(true));

    session.deleteSnippet(global.id);

    expect(get(session.snippets)).toHaveLength(1);
    expect(get(session.snippets)[0].id).toBe(project.id);
    expect(JSON.parse(backend.files.get(SNIPPETS_PATH)!)).toHaveLength(1);
  });
});
