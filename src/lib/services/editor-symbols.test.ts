import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The service reads the editor stores through `$lib/stores/editor`, whose
 * import chain drags in zustand/backend/notification — all irrelevant to the
 * symbol extraction under test. Mocking at that seam keeps this suite pure
 * AND lets `getActiveEditorVocabulary` be exercised against fake store state.
 */
const h = vi.hoisted(() => {
  function makeWritable<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        fn(value);
        subs.add(fn);
        return () => subs.delete(fn);
      },
      set(next: T) {
        value = next;
        subs.forEach((fn) => fn(next));
      },
    };
  }
  return {
    makeWritable,
    activeFile: makeWritable<string | null>(null),
    fileCache: makeWritable<Map<string, { path: string; content: string; kind: 'text' | 'image' }>>(new Map()),
  };
});

vi.mock('$lib/stores/editor', () => ({
  activeFile: h.activeFile,
  fileCache: h.fileCache,
}));

import { collectEditorSymbols, getActiveEditorVocabulary } from './editor-symbols';

beforeEach(() => {
  h.activeFile.set(null);
  h.fileCache.set(new Map());
});

describe('collectEditorSymbols', () => {
  it('ranks declared names first, whatever their casing', () => {
    const code = [
      'function collectEditorSymbols(content: string) {',
      '  return plainLocalVariable;',
      '}',
      'class SymbolRanker {}',
      'const MAX_SYMBOLS = 80;',
    ].join('\n');

    const symbols = collectEditorSymbols(code);

    // Declared names come out before incidental body identifiers.
    expect(symbols.indexOf('collectEditorSymbols')).toBeLessThan(symbols.indexOf('plainLocalVariable'));
    expect(symbols).toContain('SymbolRanker');
    expect(symbols).toContain('MAX_SYMBOLS');
  });

  it('includes structured names used anywhere but skips prose words', () => {
    const code = '// this helper handles the data value\nconst parsed = readMyConfigFile(data);';
    const symbols = collectEditorSymbols(code);

    // camelCase/snake_case names survive even without a declaration keyword;
    // generic prose around them does not.
    expect(symbols).toContain('readMyConfigFile');
    expect(symbols).toContain('parsed'); // declaration line: const counts
    expect(symbols).not.toContain('helper');
    expect(symbols).not.toContain('handles');
  });

  it('never returns language plumbing or tiny tokens', () => {
    const code = 'if (a.b) { const fn = () => void this.return; } let x = 1;';
    expect(collectEditorSymbols(code)).toEqual([]);
  });

  it('dedupes and caps the result', () => {
    const line = 'export function alphaBetaGamma() {}\n';
    const code = line.repeat(200); // same name over and over, plus padding words
    const symbols = collectEditorSymbols(code);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(symbols.length).toBeLessThanOrEqual(80);
  });

  it('scans nothing when handed empty content', () => {
    expect(collectEditorSymbols('')).toEqual([]);
  });
});

describe('getActiveEditorVocabulary', () => {
  it('returns the active text file’s symbols', () => {
    h.activeFile.set('src/lib/services/editor-symbols.ts');
    h.fileCache.set(
      new Map([
        [
          'src/lib/services/editor-symbols.ts',
          {
            path: 'src/lib/services/editor-symbols.ts',
            content: 'export function collectEditorSymbols() {}',
            kind: 'text' as const,
          },
        ],
      ]),
    );

    expect(getActiveEditorVocabulary()).toContain('collectEditorSymbols');
  });

  it('returns nothing when no file is open or the tab is an image', () => {
    expect(getActiveEditorVocabulary()).toEqual([]);

    h.activeFile.set('shot.png');
    h.fileCache.set(
      new Map([['shot.png', { path: 'shot.png', content: '', kind: 'image' as const }]]),
    );
    expect(getActiveEditorVocabulary()).toEqual([]);
  });
});
