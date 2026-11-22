import { writable, get } from '$lib/stores/storeCompat';
// Routed: on a remote workspace the box searches its own files.
import { backendInvoke } from '$lib/services/backend';
import { useWorkspaceStore } from './zustand/workspace';
import { DEFAULT_PROJECT_SEARCH_STATE, useProjectSearchStore, type SearchResponse } from './zustand/projectsearch';

export type { SearchMatch, SearchFileResult, SearchResponse } from './zustand/projectsearch';

function syncWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  const zustandVal = (useProjectSearchStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;
  const store = writable<T>(initial);
  void useProjectSearchStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) store.set(next);
  });
  return {
    subscribe: store.subscribe,
    set(value: T) { (useProjectSearchStore.getState() as any).__set(key, value); },
    update(fn: (val: T) => T) {
      const current = (useProjectSearchStore.getState() as any)[key] as T;
      (useProjectSearchStore.getState() as any).__set(key, fn(current));
    },
  };
}

// Persisted across sidebar-tab switches so re-opening Search keeps your results.
export const searchQuery = syncWritable<string>('searchQuery', '');
export const searchCaseSensitive = syncWritable<boolean>('searchCaseSensitive', false);
export const searchWholeWord = syncWritable<boolean>('searchWholeWord', false);
export const searchUseRegex = syncWritable<boolean>('searchUseRegex', false);
export const searchInclude = syncWritable<string>('searchInclude', '');
export const searchResults = syncWritable<SearchResponse | null>('searchResults', null);
export const searchLoading = syncWritable<boolean>('searchLoading', false);
export const searchError = syncWritable<string | null>('searchError', null);
export const isFloatingSearchOpen = syncWritable<boolean>('isFloatingSearchOpen', false);

let searchGeneration = 0;

/** Search results and the query are project data, not workspace-global UI. */
export function resetProjectSearchState() {
  searchGeneration += 1;
  useProjectSearchStore.setState(DEFAULT_PROJECT_SEARCH_STATE);
}

/** Shared by both search surfaces; late replies cannot cross a project switch
 * (including A -> B -> A) or overwrite a newer request. */
export async function runProjectSearch(projectId: string | null): Promise<boolean> {
  if (!projectId || useWorkspaceStore.getState().activeProjectId !== projectId) return false;
  const generation = ++searchGeneration;
  const state = useProjectSearchStore.getState();
  const isCurrent = () => generation === searchGeneration
    && useWorkspaceStore.getState().activeProjectId === projectId;
  if (!state.searchQuery) {
    useProjectSearchStore.setState({ searchResults: null, searchError: null, searchLoading: false });
    return true;
  }
  useProjectSearchStore.setState({ searchLoading: true, searchError: null });
  try {
    const response = await backendInvoke<SearchResponse>('search_in_project', {
      projectId,
      query: state.searchQuery,
      caseSensitive: state.searchCaseSensitive,
      wholeWord: state.searchWholeWord,
      useRegex: state.searchUseRegex,
      includeGlob: state.searchInclude.trim() || null,
    });
    if (!isCurrent()) return false;
    searchResults.set(response);
    return true;
  } catch (error) {
    if (isCurrent()) useProjectSearchStore.setState({ searchError: String(error), searchResults: null });
    return false;
  } finally {
    if (isCurrent()) searchLoading.set(false);
  }
}

export function toggleFloatingSearch() {
  const open = get(isFloatingSearchOpen);
  isFloatingSearchOpen.set(!open);
}
