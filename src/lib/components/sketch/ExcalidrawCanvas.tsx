import { useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { PersistedSketchScene } from './legacySketchToScene';

/**
 * The one module that pulls in @excalidraw/excalidraw.
 *
 * It exists apart from the room shell so the package (and its CSS and fonts)
 * lands in its own lazy chunk: the room's chrome, storage and legacy
 * conversion load first, and the canvas streams in behind a small placeholder.
 */

// Excalidraw filters the rendered canvas in dark mode, including its fill.
// Keep the scene color independent of the app theme so it inverts only once.
const DEFAULT_CANVAS_BACKGROUND = '#ffffff';

export type SceneChangeHandler = (scene: {
  elements: PersistedSketchScene['elements'];
  files: PersistedSketchScene['files'];
  canvasBackground?: string;
}) => void;

export type ExcalidrawCanvasProps = {
  /** Read once on mount; the canvas is remounted for a different document. */
  initialScene: Pick<PersistedSketchScene, 'elements' | 'files' | 'canvasBackground'>;
  /** 'light' | 'dark', from the app's actual theme, not just its appearance. */
  theme: 'light' | 'dark';
  onChange: SceneChangeHandler;
};

export default function ExcalidrawCanvas({ initialScene, theme, onChange }: ExcalidrawCanvasProps) {
  // initialData is consumed on the first render only, so it must not be rebuilt.
  const [initialData] = useState(() => ({
    elements: initialScene.elements,
    files: initialScene.files,
    appState: {
      viewBackgroundColor:
        initialScene.canvasBackground ??
        DEFAULT_CANVAS_BACKGROUND,
    },
    scrollToContent: true,
  }));

  return (
    <Excalidraw
      initialData={initialData as unknown as Parameters<typeof Excalidraw>[0]['initialData']}
      theme={theme}
      onChange={(elements, appState, files) => {
        const background = appState.viewBackgroundColor;
        onChange({
          // Deleted elements are tombstones; keeping them would grow storage on
          // every erase without changing what is drawn.
          elements: elements.filter((element) => !element.isDeleted) as PersistedSketchScene['elements'],
          files: files as PersistedSketchScene['files'],
          canvasBackground: background && background !== DEFAULT_CANVAS_BACKGROUND ? background : undefined,
        });
      }}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
        },
      }}
      // Keys stay inside the canvas; the app's window-level shortcuts must not
      // see Delete/undo from a drawing. Excalidraw defaults to this, and the
      // room keeps Escape for itself only when focus is outside the canvas.
      handleKeyboardGlobally={false}
    />
  );
}
