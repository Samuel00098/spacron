import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { backendInvoke } from '$lib/services/backend';
import type { EditorFile } from '$lib/types/editor';
import { useNotificationStore } from './notification';
import { useSettingsStore } from './settings';
import { useLayoutStore } from './layout';
import { formatCode } from '$lib/utils/formatter';

export interface OpenFileEntry {
  path: string;
  pinned: boolean;
}

interface EditorState {
  openFiles: string[];
  activeFile: string | null;
  fileCache: Map<string, EditorFile>;
  activeLine: number;
  activeColumn: number;
  jumpToLine: { path: string; line: number } | null;
  selectedText: string;
  openFileHistory: string[];
  /** Paths where the user has explicitly switched from default markdown preview to the code editor. */
  markdownCodeModePaths: Set<string>;
  /** Paths currently shown in markdown preview mode. */
  markdownPreviewPaths: Set<string>;

  saveActiveFile: () => Promise<void>;
  setMarkdownPreview: (path: string, on: boolean) => void;
  setFileLanguage: (path: string, language: string) => void;
  formatActiveFile: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string | null) => void;
  setActiveLine: (line: number) => void;
  setActiveColumn: (column: number) => void;
  setJumpToLine: (val: { path: string; line: number } | null) => void;
  setSelectedText: (text: string) => void;
  addOpenFile: (path: string) => void;
  removeOpenFile: (path: string) => void;
}

export const useEditorStore = create<EditorState>((set, getState) => ({
  openFiles: [],
  activeFile: null,
  fileCache: new Map(),
  activeLine: 1,
  activeColumn: 1,
  jumpToLine: null,
  selectedText: '',
  openFileHistory: [],
  markdownCodeModePaths: new Set(),
  markdownPreviewPaths: new Set(),

  setMarkdownPreview: (path: string, on: boolean) => {
    set((s) => {
      const nextCodeMode = new Set(s.markdownCodeModePaths);
      const nextPreview = new Set(s.markdownPreviewPaths);
      if (on) {
        nextCodeMode.delete(path);
        nextPreview.add(path);
      } else {
        nextCodeMode.add(path);
        nextPreview.delete(path);
      }
      return { markdownCodeModePaths: nextCodeMode, markdownPreviewPaths: nextPreview };
    });
  },

  setFileLanguage: (path: string, language: string) => {
    set((s) => {
      const file = s.fileCache.get(path);
      if (!file || file.kind !== 'text' || file.language === language) return s;
      const fileCache = new Map(s.fileCache);
      fileCache.set(path, { ...file, language });
      return { fileCache };
    });
  },

  saveActiveFile: async () => {
    const { activeFile: file, fileCache, activeLine } = getState();
    if (!file) return;
    const entry = fileCache.get(file);
    if (!entry || entry.kind !== 'text') return;

    let contentToSave = entry.content;

    if (useSettingsStore.getState().formatOnSave) {
      try {
        const formatted = await formatCode(entry.content, entry.path);
        if (formatted !== null && formatted !== entry.content) {
          contentToSave = formatted;
        }
      } catch (err: any) {
        console.warn('Formatting failed before save, saving unformatted content:', err);
      }
    }

    try {
      await backendInvoke('fs_write_file', { path: file, content: contentToSave });
      const updated: EditorFile = {
        ...entry,
        content: contentToSave,
        originalContent: contentToSave,
        isDirty: false,
      };
      const nextCache = new Map(fileCache);
      nextCache.set(file, updated);
      set({ fileCache: nextCache });
      const filename = file.split(/[\\/]/).pop() || file;
      useNotificationStore.getState().showToast(`Saved ${filename}`, 'success');
    } catch (err: any) {
      useNotificationStore.getState().showToast(`Failed to save: ${err?.message || err}`, 'error');
    }
  },

  formatActiveFile: async () => {
    const { activeFile: file, fileCache } = getState();
    if (!file) return;
    const entry = fileCache.get(file);
    if (!entry || entry.kind !== 'text') return;
    const formatOnSave = useSettingsStore.getState().formatOnSave;
    if (!formatOnSave) return;
    try {
      const formatted = await formatCode(entry.content, entry.language);
      if (formatted !== null && formatted !== entry.content) {
        const updated: EditorFile = { ...entry, content: formatted };
        const nextCache = new Map(fileCache);
        nextCache.set(file, updated);
        set({ fileCache: nextCache });
      }
    } catch (err: any) {
      console.error('Format failed:', err);
    }
  },

  openFile: async (path: string) => {
    const { fileCache, openFileHistory } = getState();
    if (fileCache.has(path)) {
      set({ activeFile: path, jumpToLine: null });
      useLayoutStore.getState().setActiveView('editor');
      if (/\.(html?|htm)$/i.test(path)) {
        const { previewLocalFile } = await import('$lib/stores/preview');
        void previewLocalFile(path);
      }
      return;
    }
    try {
      const file: EditorFile = await invoke('file_open', { path });
      const nextCache = new Map(fileCache);
      nextCache.set(path, file);
      const nextOpen = getState().openFiles.includes(path)
        ? getState().openFiles
        : [...getState().openFiles, path];
      const nextHistory = [path, ...openFileHistory.filter((p) => p !== path)].slice(0, 50);
      set({
        activeFile: path,
        fileCache: nextCache,
        openFiles: nextOpen,
        openFileHistory: nextHistory,
        jumpToLine: null,
      });
      useLayoutStore.getState().setActiveView('editor');
      if (/\.(html?|htm)$/i.test(path)) {
        const { previewLocalFile } = await import('$lib/stores/preview');
        void previewLocalFile(path);
      }
    } catch (err: any) {
      useNotificationStore.getState().showToast(`Failed to open file: ${err?.message || err}`, 'error');
    }
  },

  closeFile: (path: string) => {
    const { openFiles, activeFile, markdownCodeModePaths, markdownPreviewPaths } = getState();
    const nextOpen = openFiles.filter((p) => p !== path);
    let nextActive = activeFile;
    if (activeFile === path) {
      const idx = openFiles.indexOf(path);
      nextActive = nextOpen[Math.min(idx, nextOpen.length - 1)] ?? null;
    }
    const nextCodeMode = new Set(markdownCodeModePaths);
    nextCodeMode.delete(path);
    const nextPreview = new Set(markdownPreviewPaths);
    nextPreview.delete(path);
    set({
      openFiles: nextOpen,
      activeFile: nextActive,
      markdownCodeModePaths: nextCodeMode,
      markdownPreviewPaths: nextPreview,
    });
  },

  setActiveFile: (path: string | null) => {
    set({ activeFile: path });
    if (path) useLayoutStore.getState().setActiveView('editor');
  },

  setActiveLine: (line: number) => set({ activeLine: line }),
  setActiveColumn: (column: number) => set({ activeColumn: column }),
  setJumpToLine: (val) => set({ jumpToLine: val }),
  setSelectedText: (text: string) => set({ selectedText: text }),
  addOpenFile: (path: string) => {
    set((s) => ({
      openFiles: s.openFiles.includes(path) ? s.openFiles : [...s.openFiles, path],
    }));
  },
  removeOpenFile: (path: string) => {
    set((s) => ({
      openFiles: s.openFiles.filter((p) => p !== path),
    }));
  },
}));
