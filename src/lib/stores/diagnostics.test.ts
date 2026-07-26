import { beforeEach, describe, expect, it } from 'vitest';
import { get } from '$lib/stores/storeCompat';
import {
  clearAllDiagnostics,
  clearDiagnosticsForOwner,
  countBySeverity,
  diagnosticsByFile,
  groupForProject,
  normalizeDiagnostic,
  publishDiagnostics,
  severityFromLsp,
  totalDiagnosticCounts,
} from './diagnostics';

const ROOT = '/work/proj';
const err = (line: number, message = 'boom') => ({
  range: { start: { line, character: 4 } },
  severity: 1,
  message,
  source: 'ts',
  code: 2345,
});

beforeEach(() => {
  clearAllDiagnostics();
});

describe('severityFromLsp', () => {
  it('maps the four LSP severities', () => {
    expect(severityFromLsp(1)).toBe('error');
    expect(severityFromLsp(2)).toBe('warning');
    expect(severityFromLsp(3)).toBe('info');
    expect(severityFromLsp(4)).toBe('hint');
  });

  it('falls back to info for missing or unknown values', () => {
    expect(severityFromLsp(undefined)).toBe('info');
    expect(severityFromLsp(99)).toBe('info');
  });
});

describe('normalizeDiagnostic', () => {
  it('converts 0-based LSP positions to 1-based', () => {
    const d = normalizeDiagnostic('/work/proj/a.ts', err(0));
    expect(d.line).toBe(1);
    expect(d.column).toBe(5);
  });

  it('stringifies numeric codes and keeps the source', () => {
    const d = normalizeDiagnostic('/work/proj/a.ts', err(3));
    expect(d.code).toBe('2345');
    expect(d.source).toBe('ts');
  });

  it('tolerates a diagnostic with no range', () => {
    const d = normalizeDiagnostic('/work/proj/a.ts', { message: 'x', severity: 2 });
    expect(d.line).toBe(1);
    expect(d.column).toBe(1);
    expect(d.severity).toBe('warning');
  });
});

describe('publishDiagnostics', () => {
  it('stores diagnostics under the path decoded from the URI', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [err(1)]);
    expect([...get(diagnosticsByFile).keys()]).toEqual(['/work/proj/a.ts']);
  });

  it('REPLACES a file rather than appending', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [err(1), err(2)]);
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [err(9)]);

    const entry = get(diagnosticsByFile).get('/work/proj/a.ts');
    expect(entry?.diagnostics).toHaveLength(1);
    expect(entry?.diagnostics[0].line).toBe(10);
  });

  it('treats an empty array as "file is clean" and removes it', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [err(1)]);
    expect(get(diagnosticsByFile).has('/work/proj/a.ts')).toBe(true);

    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', []);
    expect(get(diagnosticsByFile).has('/work/proj/a.ts')).toBe(false);
  });

  it('drops diagnostics with an empty message', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [{ message: '   ', severity: 1 }]);
    expect(get(diagnosticsByFile).has('/work/proj/a.ts')).toBe(false);
  });

  it('decodes percent-encoded and Windows-drive URIs', () => {
    publishDiagnostics('C:/work/proj', 'file:///C:/work/proj/my%20file.ts', [err(0)]);
    expect(get(diagnosticsByFile).has('C:/work/proj/my file.ts')).toBe(true);
  });
});

describe('clearDiagnosticsForOwner', () => {
  it('removes only the given client, leaving other servers intact', () => {
    publishDiagnostics('/work/a', 'file:///work/a/one.ts', [err(1)]);
    publishDiagnostics('/work/b', 'file:///work/b/two.ts', [err(1)]);

    clearDiagnosticsForOwner('/work/a');

    const keys = [...get(diagnosticsByFile).keys()];
    expect(keys).toEqual(['/work/b/two.ts']);
  });
});

describe('countBySeverity', () => {
  it('tallies each severity', () => {
    const counts = countBySeverity([
      normalizeDiagnostic('a', { message: 'e', severity: 1 }),
      normalizeDiagnostic('a', { message: 'e', severity: 1 }),
      normalizeDiagnostic('a', { message: 'w', severity: 2 }),
      normalizeDiagnostic('a', { message: 'h', severity: 4 }),
    ]);
    expect(counts).toEqual({ error: 2, warning: 1, info: 0, hint: 1 });
  });
});

describe('totalDiagnosticCounts', () => {
  it('sums across files and updates as files are published and cleared', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [err(1), err(2)]);
    publishDiagnostics(ROOT, 'file:///work/proj/b.ts', [
      { message: 'w', severity: 2 },
    ]);
    expect(get(totalDiagnosticCounts)).toEqual({ error: 2, warning: 1, info: 0, hint: 0 });

    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', []);
    expect(get(totalDiagnosticCounts)).toEqual({ error: 0, warning: 1, info: 0, hint: 0 });
  });
});

describe('groupForProject', () => {
  it('excludes files outside the project root', () => {
    publishDiagnostics('/work/proj', 'file:///work/proj/a.ts', [err(1)]);
    publishDiagnostics('/work/other', 'file:///work/other/b.ts', [err(1)]);

    const groups = groupForProject(get(diagnosticsByFile), '/work/proj');
    expect(groups.map((g) => g.filePath)).toEqual(['/work/proj/a.ts']);
  });

  it('does not match a sibling directory sharing a prefix', () => {
    publishDiagnostics('/work/proj-evil', 'file:///work/proj-evil/a.ts', [err(1)]);
    const groups = groupForProject(get(diagnosticsByFile), '/work/proj');
    expect(groups).toEqual([]);
  });

  it('sorts files alphabetically and diagnostics by position', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/z.ts', [err(5)]);
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [
      { range: { start: { line: 9, character: 2 } }, severity: 1, message: 'later' },
      { range: { start: { line: 1, character: 8 } }, severity: 1, message: 'earlier' },
      { range: { start: { line: 1, character: 1 } }, severity: 1, message: 'first' },
    ]);

    const groups = groupForProject(get(diagnosticsByFile), ROOT);
    expect(groups.map((g) => g.filePath)).toEqual(['/work/proj/a.ts', '/work/proj/z.ts']);
    expect(groups[0].diagnostics.map((d) => d.message)).toEqual(['first', 'earlier', 'later']);
  });

  it('reports per-file counts', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [
      err(1),
      { message: 'w', severity: 2 },
    ]);
    const groups = groupForProject(get(diagnosticsByFile), ROOT);
    expect(groups[0].counts).toEqual({ error: 1, warning: 1, info: 0, hint: 0 });
  });

  it('returns nothing when no project is open', () => {
    publishDiagnostics(ROOT, 'file:///work/proj/a.ts', [err(1)]);
    expect(groupForProject(get(diagnosticsByFile), null)).toEqual([]);
  });
});
