import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ExcalidrawCanvas from '../src/lib/components/sketch/ExcalidrawCanvas.tsx';

/**
 * Throwaway probe: renders the room's real canvas component (not a copy) and
 * exposes its theme, Excalidraw's container class and the canvas's own pixels,
 * so "does it follow the theme" can be answered from the browser instead of
 * from reading the source.
 */

function Probe() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [changes, setChanges] = useState<string[]>([]);

  useEffect(() => {
    (window as any).__probeToggle = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
    (window as any).__probeState = () => {
      const container = document.querySelector<HTMLElement>('.excalidraw');
      const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas'));
      const pixels = canvases.map((canvas) => {
        try {
          const context = canvas.getContext('2d');
          return context ? Array.from(context.getImageData(3, 3, 1, 1).data).join(',') : 'no-ctx';
        } catch (error) {
          return `err:${String(error)}`;
        }
      });
      return {
        theme,
        containerClass: container?.className ?? null,
        backgroundColor: container ? getComputedStyle(container).backgroundColor : null,
        canvasCount: canvases.length,
        pixels,
        changes: changes.slice(-4),
      };
    };
  }, [theme, changes]);

  return (
    <div className="excalidraw-room" data-theme={theme} style={{ flex: 1, minHeight: 0 }}>
      <ExcalidrawCanvas
        initialScene={{ elements: [], files: {} }}
        theme={theme}
        onChange={(scene) => setChanges((all) => [...all.slice(-5), `bg=${scene.canvasBackground ?? 'theme'}`])}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Probe />);
