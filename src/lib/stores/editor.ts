import { writable, get } from '$lib/stores/storeCompat';
// Route file reads/writes through the backend seam so they follow a remote
// workspace when active (docs/remote-workspace.md). Local mode is a pass-through
// to Tauri invoke — every call in this file is a workspace file op.
import { backendInvoke as invoke } from '$lib/services/backend';
// The asset protocol is this machine's webview: local projects only.
import { convertFileSrc, invoke as localInvoke } from '@tauri-apps/api/core';
import { remoteTarget } from './remoteWorkspace';
import type { EditorFile } from '$lib/types/editor';
import { showToast } from './notification';
import { formatCode } from '$lib/utils/formatter';
import { formatOnSave, autoSave } from './settings';
import { setActiveView } from './layout';
import { setInteractionMode } from './interactionMode';
import { useEditorStore } from './zustand/editor';

// ── Zustand-backed writables ──

function syncWritable<T>(key: string, defaultValue: T): import('$lib/stores/storeCompat').Writable<T> {
  const zustandVal = (useEditorStore.getState() as any)[key];
  const initial = zustandVal !== undefined ? zustandVal as T : defaultValue;
  const store = writable<T>(initial);
  void useEditorStore.subscribe((state) => {
    const next = (state as any)[key] as T | undefined;
    if (next !== undefined) store.set(next);
  });
  return {
    subscribe: store.subscribe,
    set(value: T) {
      const state = useEditorStore.getState() as any;
      if (typeof state.__set === 'function') {
        state.__set(key, value);
      } else {
        useEditorStore.setState({ [key]: value } as any);
      }
    },
    update(fn: (val: T) => T) {
      const current = (useEditorStore.getState() as any)[key] as T;
      this.set(fn(current));
    },
  };
}

export const openFiles = syncWritable<string[]>('openFiles', []);
export const activeFile = syncWritable<string | null>('activeFile', null);
export const fileCache = syncWritable<Map<string, EditorFile>>('fileCache', new Map());
export const activeLine = syncWritable<number>('activeLine', 1);
export const activeColumn = syncWritable<number>('activeColumn', 1);
export const jumpToLine = syncWritable<{ path: string; line: number } | null>('jumpToLine', null);
export const activeSelection = syncWritable<string>('selectedText', '');

// ── Utility functions (unchanged) ──

// Async file work belongs to the editor session that started it.
let editorGeneration = 0;
export function resetEditorSession() {
  editorGeneration++;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  autoSavePendingPath = null;
  openFiles.set([]);
  activeFile.set(null);
  fileCache.set(new Map());
  activeLine.set(1);
  activeColumn.set(1);
  activeSelection.set('');
  jumpToLine.set(null);
}

const IMAGE_EXTENSIONS = new Set([
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'cur',
  'svg', 'avif', 'tif', 'tiff',
]);

const HTML_EXTENSIONS = new Set(['html', 'htm']);

export function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

export function isHtmlPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return HTML_EXTENSIONS.has(ext);
}

export function getImageMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'apng': return 'image/apng';
    case 'jpg': case 'jpeg': case 'jpe': case 'jfif': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'ico': case 'cur': return 'image/x-icon';
    case 'svg': return 'image/svg+xml';
    case 'avif': return 'image/avif';
    case 'tif': case 'tiff': return 'image/tiff';
    default: return 'application/octet-stream';
  }
}

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm',
};
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

function extOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

export function isAudioPath(path: string): boolean {
  return extOf(path) in AUDIO_MIME;
}

export function isVideoPath(path: string): boolean {
  return extOf(path) in VIDEO_MIME;
}

export function isDocumentPath(path: string): boolean {
  return ['pdf', 'docx'].includes(extOf(path));
}

/** Files the editor shows in a viewer rather than as text. */
export function isViewerPath(path: string): boolean {
  return isImagePath(path) || isAudioPath(path) || isVideoPath(path) || isDocumentPath(path);
}

/** Read an image, audio or video file into an editor entry. Audio and video
 *  stream from disk over the asset protocol where possible (no size limit,
 *  and seeking works); otherwise, and for images, the bytes become a blob. */
async function loadViewerFile(path: string): Promise<EditorFile> {
  if (isDocumentPath(path)) {
    const bytes = await invoke<number[]>('fs_read_binary', { path });
    const kind = extOf(path) === 'pdf' ? 'pdf' : 'docx';
    return { path, kind, language: kind, content: '', originalContent: '', isDirty: false,
      documentData: new Uint8Array(bytes), size: bytes.length };
  }
  const kind = isImagePath(path) ? 'image' : isVideoPath(path) ? 'video' : 'audio';
  const mimeType = kind === 'image'
    ? getImageMimeType(path)
    : (kind === 'video' ? VIDEO_MIME : AUDIO_MIME)[extOf(path)] ?? 'application/octet-stream';
  const base = { path, content: '', originalContent: '', isDirty: false, language: kind, kind, mimeType } as const;
  if (kind !== 'image' && !get(remoteTarget)) {
    try {
      await localInvoke('fs_allow_media', { path });
      return { ...base, imageSrc: convertFileSrc(path), size: null };
    } catch {
      // Fall back to reading the bytes below.
    }
  }
  const bytes = await invoke<number[]>('fs_read_binary', { path });
  return { ...base, imageSrc: createObjectUrl(bytes, mimeType), size: bytes.length };
}

function createObjectUrl(bytes: number[], mimeType: string): string {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  return URL.createObjectURL(blob);
}

function revokeEditorAsset(file: EditorFile | undefined) {
  if (file && file.kind !== 'text' && file.imageSrc?.startsWith('blob:')) {
    URL.revokeObjectURL(file.imageSrc);
  }
}

export function updateCursorPosition(line: number, col: number) {
  activeLine.set(line);
  activeColumn.set(col);
}

export function detectLanguage(path: string): string {
  if (isImagePath(path)) return 'image';
  if (isVideoPath(path)) return 'video';
  if (isAudioPath(path)) return 'audio';
  const filename = path.split(/[/\\]/).pop()?.toLowerCase() || '';
  const ext = filename.split('.').pop()?.toLowerCase();
  const name = filename.split('.').slice(0, -1).join('.');
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || (!ext && name === '' && filename !== '')) return 'shell';
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'html': case 'htm': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'sass': return 'sass';
    case 'rs': return 'rust';
    case 'json': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'py': return 'python';
    case 'java': return 'java';
    case 'c': case 'cpp': case 'cc': case 'cxx': case 'h': case 'hpp': case 'hxx': case 'ino': return 'cpp';
    case 'cs': return 'csharp';
    case 'svelte': return 'svelte';
    case 'toml': return 'toml';
    case 'php': return 'php';
    case 'sql': return 'sql';
    case 'xml': case 'svg': case 'plist': return 'xml';
    case 'yaml': case 'yml': return 'yaml';
    case 'go': return 'go';
    case 'swift': return 'swift';
    case 'kt': case 'kts': return 'kotlin';
    default: return 'plaintext';
  }
}

// ── Functions using Zustand-backed writables ──

// Opening a file is always an explicit "show me this" gesture — an explorer
// click, a search hit, a diagnostic, or the orchestrator acting on "open X".
// In conversational mode the editor sits underneath the chat overlay, so
// switching the active view alone opens the file invisibly and the click
// appears dead. Dropping to Code mode first makes the file actually seen;
// the conversation (and its threads) persists, one click away in the sidebar.
function revealEditor() {
  setInteractionMode('cli');
  setActiveView('editor');
}

export async function openFile(path: string) {
  const generation = editorGeneration;
  const currentOpenFiles = get(openFiles);
  activeSelection.set('');

  if (currentOpenFiles.includes(path)) {
    activeFile.set(path);
    revealEditor();
    return true;
  }

  try {
    let editorFile: EditorFile;

    if (isViewerPath(path)) {
      editorFile = await loadViewerFile(path);
      if (generation !== editorGeneration) { revokeEditorAsset(editorFile); return false; }
    } else {
      const content = await invoke<string>('fs_read_file', { path });
      if (generation !== editorGeneration) return false;
      const language = detectLanguage(path);
      editorFile = {
        path, content, originalContent: content, isDirty: false,
        language, kind: 'text', imageSrc: null, mimeType: null, size: content.length,
      };
    }

    fileCache.update((c) => { const next = new Map(c); next.set(path, editorFile); return next; });
    openFiles.update((files) => [...files, path]);
    activeFile.set(path);
    revealEditor();
    return true;
  } catch (err: any) {
    console.error('Failed to open file:', err);
    showToast(`Failed to open file: ${err?.message || err}`, 'error');
    return false;
  }
}

export function closeFile(path: string) {
  const currentActive = get(activeFile);
  const files = get(openFiles);
  const cachedFile = get(fileCache).get(path);
  const updatedFiles = files.filter((f) => f !== path);
  openFiles.set(updatedFiles);
  fileCache.update((c) => { const next = new Map(c); next.delete(path); return next; });
  useEditorStore.getState().setMarkdownPreview(path, true);
  revokeEditorAsset(cachedFile);
  if (currentActive === path) {
    activeFile.set(updatedFiles.length > 0 ? updatedFiles[updatedFiles.length - 1] : null);
  }
}

export function onFileRenamed(oldPath: string, newPath: string) {
  openFiles.update((files) => files.map((f) => (f === oldPath ? newPath : f)));
  activeFile.update((a) => (a === oldPath ? newPath : a));
  fileCache.update((cache) => {
    const existing = cache.get(oldPath);
    if (!existing) return cache;
    const next = new Map(cache);
    next.delete(oldPath);
    next.set(newPath, { ...existing, path: newPath });
    return next;
  });
  const state = useEditorStore.getState();
  if (state.markdownCodeModePaths?.has(oldPath)) {
    const nextCodeMode = new Set(state.markdownCodeModePaths);
    nextCodeMode.delete(oldPath);
    nextCodeMode.add(newPath);
    useEditorStore.setState({ markdownCodeModePaths: nextCodeMode });
  }
}

function normalisePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

export function onFileDeleted(path: string) {
  closeFile(path);
  const deletedPath = normalisePathSeparators(path).replace(/\/+$/, '');
  const dirPrefix = `${deletedPath}/`;
  const children = get(openFiles).filter((f) => normalisePathSeparators(f).startsWith(dirPrefix));
  children.forEach(closeFile);
}

export function updateContent(path: string, newContent: string) {
  fileCache.update((cache) => {
    const next = new Map(cache);
    const file = next.get(path);
    if (file && file.kind === 'text') {
      next.set(path, { ...file, content: newContent, isDirty: newContent !== file.originalContent });
    }
    return next;
  });
  scheduleAutoSave(path);
}

// ── Auto save ──
// A single debounce timer: each keystroke resets it, and when typing has been
// still for ~1s the latest file is saved silently through the normal save path
// (so format-on-save and the backend seam apply). Fires only while the setting
// is on; the toggle is read again at fire time so flipping it off cancels the
// pending save.
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let autoSavePendingPath: string | null = null;

const AUTO_SAVE_DELAY_MS = 1000;

function scheduleAutoSave(path: string) {
  if (!get(autoSave)) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSavePendingPath = path;
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    const target = autoSavePendingPath;
    autoSavePendingPath = null;
    if (target && get(autoSave)) void saveFile(target, true);
  }, AUTO_SAVE_DELAY_MS);
}

export async function saveFile(path: string, silent = false) {
  const generation = editorGeneration;
  const cache = get(fileCache);
  const file = cache.get(path);
  if (!file || file.kind !== 'text') return;

  let contentToSave = file.content;

  if (get(formatOnSave)) {
    try {
      const formatted = await formatCode(file.content, path);
      if (generation !== editorGeneration) return;
      if (formatted !== file.content) {
        contentToSave = formatted;
        fileCache.update((c) => {
          const next = new Map(c);
          next.set(path, { ...file, content: formatted, isDirty: true });
          return next;
        });
      }
    } catch (err: any) {
      console.warn('Formatting failed before save, saving unformatted content:', err);
    }
  }

  if (generation !== editorGeneration) return;
  try {
    await invoke('fs_write_file', { path, content: contentToSave });
    if (generation !== editorGeneration) return;
    fileCache.update((c) => {
      const next = new Map(c);
      const currentFile = next.get(path) || file;
      next.set(path, { ...currentFile, content: contentToSave, originalContent: contentToSave, isDirty: false });
      return next;
    });
    if (!silent) {
      const filename = path.split(/[/\\]/).pop() || path;
      showToast(`Saved ${filename}`, 'success');
    }
  } catch (err: any) {
    console.error('Failed to save file:', err);
    showToast(`Failed to save file: ${err?.message || err}`, 'error');
  }
}

export async function saveActiveFile() {
  const active = get(activeFile);
  if (active) await saveFile(active);
}

export async function restoreEditorFiles(filePaths: string[], activeFilePath: string | null) {
  const generation = editorGeneration;
  const previousCache = get(fileCache);
  const newCache = new Map<string, EditorFile>();
  const validPaths: string[] = [];

  try {
    for (const path of filePaths) {
      if (generation !== editorGeneration) return;
      try {
        if (isViewerPath(path)) {
          const viewerFile = await loadViewerFile(path);
          if (generation !== editorGeneration) { revokeEditorAsset(viewerFile); return; }
          newCache.set(path, viewerFile);
        } else {
          const content = await invoke<string>('fs_read_file', { path });
          if (generation !== editorGeneration) return;
          newCache.set(path, {
            path, content, originalContent: content, isDirty: false,
            language: detectLanguage(path), kind: 'text', imageSrc: null, mimeType: null, size: content.length,
          });
        }
        validPaths.push(path);
      } catch {}
    }

    if (generation !== editorGeneration) return;
    previousCache.forEach((file, path) => { if (!newCache.has(path)) revokeEditorAsset(file); });

    fileCache.set(newCache);
    openFiles.set(validPaths);
    const restoredActive = validPaths.includes(activeFilePath ?? '') ? activeFilePath : (validPaths[0] ?? null);
    activeFile.set(restoredActive);
  } finally {
    if (generation !== editorGeneration) newCache.forEach(revokeEditorAsset);
  }
}

export async function formatActiveFile() {
  const generation = editorGeneration;
  const active = get(activeFile);
  if (!active) return;
  const cache = get(fileCache);
  const file = cache.get(active);
  if (!file) return;
  if (file.kind !== 'text') { showToast('Only text files can be formatted', 'info'); return; }

  try {
    const formatted = await formatCode(file.content, active);
    if (generation !== editorGeneration) return;
    if (formatted !== file.content) {
      fileCache.update((c) => {
        const next = new Map(c);
        next.set(active, { ...file, content: formatted, isDirty: formatted !== file.originalContent });
        return next;
      });
      showToast('Formatted document', 'success');
    } else {
      showToast('Document already formatted', 'info');
    }
  } catch (err: any) {
    console.error('Manual formatting failed:', err);
    showToast(`Formatting failed: ${err?.message || err}`, 'error');
  }
}
