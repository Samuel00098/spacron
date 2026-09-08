import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { activeProjectId } from './workspace';
import { resetProjectSearchState, runProjectSearch, searchQuery } from './projectsearch';
import { useProjectSearchStore, type SearchResponse } from './zustand/projectsearch';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const response: SearchResponse = { files: [], total_matches: 1, truncated: false };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  activeProjectId.set('a');
  resetProjectSearchState();
  searchQuery.set('needle');
});

describe('project search isolation', () => {
  it('sends the selected project explicitly and ignores stale scheduled calls', async () => {
    vi.mocked(invoke).mockResolvedValue(response);
    await runProjectSearch('a');
    expect(invoke).toHaveBeenCalledWith('search_in_project', expect.objectContaining({ projectId: 'a', query: 'needle' }));
    expect(useProjectSearchStore.getState().searchResults).toEqual(response);
    activeProjectId.set('b');
    expect(useProjectSearchStore.getState().searchResults).toBeNull();
    expect(useProjectSearchStore.getState().searchQuery).toBe('');
    await runProjectSearch('a');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('ignores a late reply even after switching A to B and back to A', async () => {
    const pending = deferred<SearchResponse>();
    vi.mocked(invoke).mockReturnValue(pending.promise);
    const search = runProjectSearch('a');
    activeProjectId.set('b');
    activeProjectId.set('a');
    pending.resolve(response);
    expect(await search).toBe(false);
    expect(useProjectSearchStore.getState().searchResults).toBeNull();
  });

  it('keeps a newer search loading when an older project request fails', async () => {
    const old = deferred<SearchResponse>();
    const current = deferred<SearchResponse>();
    vi.mocked(invoke).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = runProjectSearch('a');
    activeProjectId.set('b');
    searchQuery.set('other');
    const second = runProjectSearch('b');
    old.reject(new Error('old failure'));
    await first;
    expect(useProjectSearchStore.getState().searchLoading).toBe(true);
    expect(useProjectSearchStore.getState().searchError).toBeNull();
    current.resolve(response);
    await second;
    expect(useProjectSearchStore.getState().searchLoading).toBe(false);
  });

  it('does not let an older query overwrite a newer result in the same project', async () => {
    const old = deferred<SearchResponse>();
    vi.mocked(invoke).mockReturnValueOnce(old.promise).mockResolvedValueOnce(response);
    const first = runProjectSearch('a');
    searchQuery.set('newer');
    await runProjectSearch('a');
    old.resolve({ ...response, total_matches: 99 });
    await first;
    expect(useProjectSearchStore.getState().searchResults).toEqual(response);
  });
});
