import { invoke } from '@tauri-apps/api/core';
import type { PersistedSketchScene } from './legacySketchToScene';

/**
 * The project copy of a sketch.
 *
 * A sketch lives in two places: localStorage (synchronous, so the room paints
 * immediately and survives a failed write) and the project folder, as a real
 * `.excalidraw` document an agent can read, diff and edit. The folder is the
 * durable copy; localStorage is the fast one.
 */

export const SKETCH_DIR = '.spacron/sketches';
export const SKETCH_FILE_NAME = 'sketch.excalidraw';

export function sketchDirPath(rootPath: string): string {
  return `${rootPath.replace(/[\\/]+$/, '')}/${SKETCH_DIR}`;
}

export function sketchFilePath(rootPath: string): string {
  return `${sketchDirPath(rootPath)}/${SKETCH_FILE_NAME}`;
}

/**
 * A standard Excalidraw document. `type`/`version`/`source` make it open in
 * Excalidraw itself (and in editors that understand the extension), while the
 * app only reads `elements`, `files` and `appState.viewBackgroundColor` back.
 */
export function serialiseSketchFile(scene: PersistedSketchScene): string {
  return `${JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'spacron',
      savedAt: scene.savedAt,
      elements: scene.elements,
      appState: scene.canvasBackground ? { viewBackgroundColor: scene.canvasBackground } : {},
      files: scene.files,
    },
    null,
    2,
  )}\n`;
}

export function parseSketchFile(raw: string): PersistedSketchScene | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.elements)) return null;
  const background = data.appState?.viewBackgroundColor;
  return {
    version: 1,
    elements: data.elements,
    files: data.files && typeof data.files === 'object' ? data.files : {},
    savedAt: typeof data.savedAt === 'number' ? data.savedAt : undefined,
    // Only a deliberate canvas colour is stored. Excalidraw's two theme
    // backgrounds are implied by the app theme and must not be frozen here.
    canvasBackground: typeof background === 'string' ? background : undefined,
  };
}

/** `null` when the file does not exist yet (or cannot be read). */
export async function readSketchFile(rootPath: string): Promise<PersistedSketchScene | null> {
  try {
    const raw = await invoke<string>('fs_read_file', { path: sketchFilePath(rootPath) });
    return parseSketchFile(raw);
  } catch {
    return null;
  }
}

export async function writeSketchFile(rootPath: string, scene: PersistedSketchScene): Promise<void> {
  const dir = sketchDirPath(rootPath);
  try {
    await invoke('fs_create_dir', { path: dir });
  } catch {
    // Already there, or the write below will report the real failure.
  }
  await invoke('fs_write_file', { path: sketchFilePath(rootPath), content: serialiseSketchFile(scene) });
}
