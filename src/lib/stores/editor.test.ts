import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from '$lib/stores/storeCompat';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./notification', () => ({
  showToast: vi.fn(),
}));

import { formatOnSave } from './settings';
import { invoke } from '@tauri-apps/api/core';
import { openFile, restoreEditorFiles, resetEditorSession, saveFile, activeFile, fileCache, onFileDeleted, onFileRenamed, openFiles } from './editor';
import { useEditorStore } from './zustand/editor';
import type { EditorFile } from '$lib/types/editor';

function textFile(path: string): EditorFile {
  return {
    path,
    content: '',
    originalContent: '',
    isDirty: false,
    language: 'plaintext',
    kind: 'text',
    imageSrc: null,
    mimeType: null,
    size: 0,
  };
}

describe('editor file deletion handling', () => {
  beforeEach(() => {
    openFiles.set([]);
    activeFile.set(null);
    fileCache.set(new Map());
  });

  it('closes child tabs when a Windows-style folder path is deleted', () => {
    const deletedDir = 'C:\\repo\\src';
    const childWin = 'C:\\repo\\src\\main.ts';
    const childForward = 'C:/repo/src/utils.ts';
    const sibling = 'C:\\repo\\src-other\\main.ts';
    const files = [childWin, childForward, sibling];

    openFiles.set(files);
    activeFile.set(childForward);
    fileCache.set(new Map(files.map((path) => [path, textFile(path)])));

    onFileDeleted(deletedDir);

    expect(get(openFiles)).toEqual([sibling]);
    expect(get(activeFile)).toBe(sibling);
    expect([...get(fileCache).keys()]).toEqual([sibling]);
  });
});

describe('markdown preview default and toggle behavior', () => {
  beforeEach(() => {
    openFiles.set([]);
    activeFile.set(null);
    fileCache.set(new Map());
    useEditorStore.setState({
      openFiles: [],
      activeFile: null,
      fileCache: new Map(),
      markdownCodeModePaths: new Set(),
      markdownPreviewPaths: new Set(),
    });
  });

  it('defaults to preview mode (not in markdownCodeModePaths) when opened', () => {
    const mdPath = 'C:\\repo\\README.md';

    // By default, markdownCodeModePaths does not contain the path -> preview is active
    expect(useEditorStore.getState().markdownCodeModePaths.has(mdPath)).toBe(false);
  });

  it('switches to code mode when preview is toggled off, and restores preview when toggled on', () => {
    const mdPath = 'C:\\repo\\README.md';

    // User switches to code mode (preview = false)
    useEditorStore.getState().setMarkdownPreview(mdPath, false);
    expect(useEditorStore.getState().markdownCodeModePaths.has(mdPath)).toBe(true);

    // User switches back to preview mode (preview = true)
    useEditorStore.getState().setMarkdownPreview(mdPath, true);
    expect(useEditorStore.getState().markdownCodeModePaths.has(mdPath)).toBe(false);
  });

  it('resets code mode state when file is closed', () => {
    const mdPath = 'C:\\repo\\README.md';

    useEditorStore.getState().addOpenFile(mdPath);
    useEditorStore.getState().setMarkdownPreview(mdPath, false);
    expect(useEditorStore.getState().markdownCodeModePaths.has(mdPath)).toBe(true);

    useEditorStore.getState().closeFile(mdPath);
    expect(useEditorStore.getState().markdownCodeModePaths.has(mdPath)).toBe(false);
  });

  it('migrates code mode state on file rename', () => {
    const oldPath = 'C:\\repo\\README.md';
    const newPath = 'C:\\repo\\DOCS.md';

    useEditorStore.getState().addOpenFile(oldPath);
    useEditorStore.getState().setMarkdownPreview(oldPath, false);
    expect(useEditorStore.getState().markdownCodeModePaths.has(oldPath)).toBe(true);

    onFileRenamed(oldPath, newPath);
    expect(useEditorStore.getState().markdownCodeModePaths.has(oldPath)).toBe(false);
    expect(useEditorStore.getState().markdownCodeModePaths.has(newPath)).toBe(true);
  });
});



describe('project editor isolation', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    resetEditorSession();
  });

  it.each(['open', 'restore'])('discards a delayed %s from the outgoing project', async (operation) => {
    let finish!: (content: string) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = operation === 'open'
      ? openFile('C:/project-a/a.ts')
      : restoreEditorFiles(['C:/project-a/a.ts'], 'C:/project-a/a.ts');
    resetEditorSession();
    vi.mocked(invoke).mockResolvedValueOnce('project b');
    await openFile('C:/project-b/b.ts');
    finish('project a');
    await pending;
    expect(get(openFiles)).toEqual(['C:/project-b/b.ts']);
    expect(get(activeFile)).toBe('C:/project-b/b.ts');
    expect([...get(fileCache).keys()]).toEqual(['C:/project-b/b.ts']);
  });

  it('does not repopulate the next project when an outgoing save completes', async () => {
    const path = 'C:/project-a/a.ts';
    fileCache.set(new Map([[path, textFile(path)]]));
    let finish!: () => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    formatOnSave.set(false);
    const pending = saveFile(path, true);
    resetEditorSession();
    finish();
    await pending;
    expect(get(fileCache).size).toBe(0);
  });
});
