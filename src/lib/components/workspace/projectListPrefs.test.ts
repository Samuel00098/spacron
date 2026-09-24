import { describe, expect, it } from 'vitest';
import { applyProjectPrefs, normalizeProjectPath, togglePath } from './projectListPrefs';

const rows = [
  { name: 'alpha', path: 'C:\\code\\alpha' },
  { name: 'beta', path: 'C:\\code\\beta' },
  { name: 'gamma', path: 'C:\\code\\gamma' },
  { name: 'empty collection', path: '' },
];

describe('applyProjectPrefs', () => {
  it('hides projects and floats pinned ones to the top in their existing order', () => {
    const hidden = new Set([normalizeProjectPath('c:/code/beta/')]);
    const pinned = new Set([normalizeProjectPath('C:\\code\\gamma')]);
    expect(applyProjectPrefs(rows, hidden, pinned).map((row) => row.name)).toEqual([
      'gamma',
      'alpha',
      'empty collection',
    ]);
  });

  it('leaves the list alone with no preferences', () => {
    expect(applyProjectPrefs(rows, new Set(), new Set())).toEqual(rows);
  });
});

describe('togglePath', () => {
  it('adds and removes by normalized path without mutating the input', () => {
    const start = new Set<string>();
    const added = togglePath(start, 'C:\\Code\\Alpha\\', true);
    expect(start.size).toBe(0);
    expect([...added]).toEqual(['c:/code/alpha']);
    expect(togglePath(added, 'c:/code/alpha', false).size).toBe(0);
  });
});
