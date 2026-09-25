import { describe, expect, it, beforeEach, vi } from 'vitest';
import { get, writable } from '$lib/stores/storeCompat';
import type { FileNode } from '$lib/types/explorer';

const activeProjectStore = writable<{ id: string; root_path: string } | null>(null);

vi.mock('$lib/stores/workspace', () => ({
  get activeProject() {
    return activeProjectStore;
  },
}));

vi.mock('$lib/services/backend', () => ({ backendInvoke: vi.fn() }));

vi.mock('$lib/stores/notification', () => ({ showToast: vi.fn() }));

import {
  getCreateTarget,
  projectRootNodes,
  selectedPath,
  selectedPaths,
} from './explorer';

function node(path: string, isDir = false): FileNode {
  const parts = path.split('/');
  return {
    entry: { name: parts[parts.length - 1], path, is_dir: isDir, size: 0, modified: '' },
    children: null,
    expanded: isDir,
    loading: false,
    depth: 0,
  };
}

const srcNode = node('/proj/src', true);
srcNode.children = [node('/proj/src/a.ts'), node('/proj/src/components', true)];
srcNode.depth = 0;
srcNode.children[0].depth = 1;
srcNode.children[1].depth = 1;

function setTree() {
  projectRootNodes.set(new Map([['/proj', [srcNode, node('/proj/main.ts')]]]));
}

function select(path: string) {
  selectedPaths.set(new Set([path]));
  selectedPath.set(path);
}

beforeEach(() => {
  activeProjectStore.set({ id: 'p1', root_path: '/proj' });
  projectRootNodes.set(new Map());
  selectedPaths.set(new Set());
  selectedPath.set(null);
});

describe('getCreateTarget', () => {
  it('falls back to the project root without a selection', () => {
    setTree();
    expect(getCreateTarget()).toBe('/proj');
  });

  it('targets a single selected folder', () => {
    setTree();
    select('/proj/src');
    expect(getCreateTarget()).toBe('/proj/src');
  });

  it('targets the parent of a single selected file', () => {
    setTree();
    select('/proj/src/a.ts');
    expect(getCreateTarget()).toBe('/proj/src');
  });

  it('falls back to the root for a selected file directly in the root', () => {
    setTree();
    select('/proj/main.ts');
    expect(getCreateTarget()).toBe('/proj');
  });

  it('falls back to the root for a multi-item selection', () => {
    setTree();
    selectedPaths.set(new Set(['/proj/src', '/proj/main.ts']));
    selectedPath.set('/proj/src');
    expect(getCreateTarget()).toBe('/proj');
  });

  it('falls back to the root when the active item is not the single selection', () => {
    setTree();
    selectedPaths.set(new Set(['/proj/src']));
    selectedPath.set('/proj/main.ts');
    expect(getCreateTarget()).toBe('/proj');
  });

  it('returns an empty string with no active project', () => {
    activeProjectStore.set(null);
    setTree();
    select('/proj/src');
    expect(getCreateTarget()).toBe('');
  });

  it('preserves raw backslash paths so the inline input lines up on Windows', () => {
    activeProjectStore.set({ id: 'p1', root_path: 'C:\\proj' });
    const folder = node('C:\\proj\\src', true);
    folder.children = [node('C:\\proj\\src\\a.ts')];
    projectRootNodes.set(new Map([['C:\\proj', [folder, node('C:\\proj\\main.ts')]]]));
    select('C:\\proj\\src\\a.ts');
    expect(getCreateTarget()).toBe('C:\\proj\\src');
    select('C:\\proj\\src');
    expect(getCreateTarget()).toBe('C:\\proj\\src');
  });
});