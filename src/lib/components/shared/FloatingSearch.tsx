import { useEffect, useRef, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { get, type Writable } from '$lib/stores/storeCompat';
import { jumpToLine, openFile } from '$lib/stores/editor';
import {
  searchCaseSensitive,
  searchError,
  searchInclude,
  searchLoading,
  searchQuery,
  searchResults,
  searchUseRegex,
  searchWholeWord,
  isFloatingSearchOpen,
} from '$lib/stores/projectsearch';
import type { SearchFileResult, SearchMatch, SearchResponse } from '$lib/stores/zustand/projectsearch';
import { useStore } from '$lib/react/useStore';
import './FloatingSearch.css';

function splitMatch(text: string, column: number, length: number) {
  const chars = Array.from(text);
  const start = Math.max(0, column - 1);
  return {
    before: chars.slice(0, start).join(''),
    hit: chars.slice(start, start + length).join(''),
    after: chars.slice(start + length).join(''),
  };
}

function SearchIcon() {
  return (
    <svg className="search-glass" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className={`chevron${collapsed ? ' collapsed' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function FloatingSearch() {
  const isOpen = useStore(isFloatingSearchOpen);
  const query = useStore(searchQuery);
  const caseSensitive = useStore(searchCaseSensitive);
  const wholeWord = useStore(searchWholeWord);
  const useRegex = useStore(searchUseRegex);
  const include = useStore(searchInclude);
  const results = useStore(searchResults);
  const loading = useStore(searchLoading);
  const error = useStore(searchError);
  
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isKeyboardSelectionRef = useRef<boolean>(false);

  // Flatten matches for keyboard navigation
  const flatMatches = useMemo(() => {
    if (!results) return [];
    const list: { file: SearchFileResult; match: SearchMatch }[] = [];
    results.files.forEach((file) => {
      if (collapsed[file.path]) return;
      file.matches.forEach((match) => {
        list.push({ file, match });
      });
    });
    return list;
  }, [results, collapsed]);

  async function runSearch() {
    const currentQuery = get(searchQuery);
    if (!currentQuery) {
      searchResults.set(null);
      searchError.set(null);
      searchLoading.set(false);
      return;
    }

    searchLoading.set(true);
    searchError.set(null);
    try {
      const response = await invoke<SearchResponse>('search_in_project', {
        query: currentQuery,
        caseSensitive: get(searchCaseSensitive),
        wholeWord: get(searchWholeWord),
        useRegex: get(searchUseRegex),
        includeGlob: get(searchInclude).trim() || null,
      });
      searchResults.set(response);
      isKeyboardSelectionRef.current = true;
      setSelectedIndex(0);
    } catch (err) {
      searchError.set(String(err));
      searchResults.set(null);
    } finally {
      searchLoading.set(false);
    }
  }

  function scheduleSearch() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch();
    }, 250);
  }

  function handleInputKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void runSearch();
    }
  }

  function toggleOption(store: Writable<boolean>) {
    store.update((value) => !value);
    scheduleSearch();
  }

  function toggleCollapse(path: string) {
    setCollapsed((current) => ({ ...current, [path]: !current[path] }));
  }

  async function openMatch(file: SearchFileResult, match: SearchMatch) {
    await openFile(file.path);
    jumpToLine.set({ path: file.path, line: match.line });
    isFloatingSearchOpen.set(false);
  }

  // 1. Initial reset and focus when search is opened
  useEffect(() => {
    if (!isOpen) return;
    isKeyboardSelectionRef.current = true;
    setSelectedIndex(0);
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, [isOpen]);

  // 2. Keyboard navigation & global window listening when open
  useEffect(() => {
    if (!isOpen) return;

    function handleGlobalKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        isFloatingSearchOpen.set(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (flatMatches.length > 0) {
          isKeyboardSelectionRef.current = true;
          setSelectedIndex((i) => (i + 1) % flatMatches.length);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (flatMatches.length > 0) {
          isKeyboardSelectionRef.current = true;
          setSelectedIndex((i) => (i - 1 + flatMatches.length) % flatMatches.length);
        }
      } else if (e.key === 'Enter') {
        if (flatMatches.length > 0 && selectedIndex >= 0 && selectedIndex < flatMatches.length) {
          e.preventDefault();
          const target = flatMatches[selectedIndex];
          void openMatch(target.file, target.match);
        }
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [isOpen, flatMatches, selectedIndex]);

  // Scroll selected match into view
  useEffect(() => {
    if (!isKeyboardSelectionRef.current) return;
    isKeyboardSelectionRef.current = false; // Reset
    if (!resultsRef.current) return;
    const selectedEl = resultsRef.current.querySelector('.match-row-spotlight.selected');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  const totalMatches = results?.total_matches ?? 0;
  const fileCount = results?.files.length ?? 0;

  // Track the match index to match selectedIndex
  let matchIndexCounter = 0;

  return (
    <div className="floating-search-overlay" onClick={() => isFloatingSearchOpen.set(false)}>
      <div className="floating-search" onClick={(e) => e.stopPropagation()}>
        <div className="search-header-spotlight">
          <div className="search-input-wrap-spotlight">
            <SearchIcon />
            <input
              ref={inputRef}
              className="search-input-spotlight"
              type="text"
              placeholder="Search in files..."
              value={query}
              onChange={(event) => {
                searchQuery.set(event.target.value);
                scheduleSearch();
              }}
              onKeyDown={handleInputKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="search-toggles-spotlight">
              <button className={`toggle-btn-spotlight${caseSensitive ? ' active' : ''}`} onClick={() => toggleOption(searchCaseSensitive)} title="Match case" aria-label="Match case" aria-pressed={caseSensitive}>
                Aa
              </button>
              <button className={`toggle-btn-spotlight${wholeWord ? ' active' : ''}`} onClick={() => toggleOption(searchWholeWord)} title="Match whole word" aria-label="Match whole word" aria-pressed={wholeWord}>
                <span className="ab-underline">ab</span>
              </button>
              <button className={`toggle-btn-spotlight${useRegex ? ' active' : ''}`} onClick={() => toggleOption(searchUseRegex)} title="Use regular expression" aria-label="Use regular expression" aria-pressed={useRegex}>
                .*
              </button>
            </div>
          </div>
          <input
            className="search-include-spotlight"
            type="text"
            placeholder="files to include, e.g. *.ts, src/**"
            value={include}
            onChange={(event) => {
              searchInclude.set(event.target.value);
              scheduleSearch();
            }}
            onKeyDown={handleInputKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="search-status-spotlight">
          {loading ? (
            <span className="status-text-spotlight">Searching...</span>
          ) : error ? (
            <span className="status-text-spotlight error">{error}</span>
          ) : results ? (
            totalMatches === 0 ? (
              <span className="status-text-spotlight">No results found</span>
            ) : (
              <span className="status-text-spotlight">
                {totalMatches} {totalMatches === 1 ? 'result' : 'results'} in {fileCount} {fileCount === 1 ? 'file' : 'files'}
                {results.truncated && <span className="truncated"> (truncated)</span>}
              </span>
            )
          ) : (
            <span className="status-text-spotlight muted">Type a query to search across your workspace</span>
          )}
        </div>

        {results && results.files.length > 0 && (
          <div ref={resultsRef} className="search-results-spotlight scrollable">
            {results.files.map((file) => {
              const fileCollapsed = Boolean(collapsed[file.path]);
              return (
                <div className="file-group-spotlight" key={file.path}>
                  <button type="button" className="file-row-spotlight" onClick={() => toggleCollapse(file.path)}>
                    <ChevronIcon collapsed={fileCollapsed} />
                    <span className="file-name-spotlight" title={file.rel_path}>{file.rel_path}</span>
                    <span className="file-count-spotlight">{file.matches.length}</span>
                  </button>
                  {!fileCollapsed &&
                    file.matches.map((match) => {
                      const currentIdx = matchIndexCounter++;
                      const isSelected = currentIdx === selectedIndex;
                      const parts = splitMatch(match.text, match.column, match.length);
                      return (
                        <button
                          type="button"
                          className={`match-row-spotlight${isSelected ? ' selected' : ''}`}
                          key={`${file.path}:${match.line}:${match.column}:${match.length}`}
                          onClick={() => void openMatch(file, match)}
                          onMouseEnter={() => setSelectedIndex(currentIdx)}
                          title={`Line ${match.line}`}
                        >
                          <span className="match-line-no-spotlight">{match.line}</span>
                          <span className="match-text-spotlight">
                            <span className="match-before-spotlight">{parts.before}</span>
                            <span className="match-hit-spotlight">{parts.hit}</span>
                            <span className="match-after-spotlight">{parts.after}</span>
                          </span>
                        </button>
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
