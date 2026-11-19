import { useCallback, useEffect, useRef, useState } from 'react';
import './ImageViewer.css';

interface Props {
  src: string;
  path: string;
  mimeType?: string | null;
  size?: number | null;
}

export function formatBytes(value: number | null | undefined): string {
  if (!value || value < 0) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let sizeValue = value / 1024;
  let unitIndex = 0;
  while (sizeValue >= 1024 && unitIndex < units.length - 1) {
    sizeValue /= 1024;
    unitIndex += 1;
  }
  return `${sizeValue >= 10 ? sizeValue.toFixed(0) : sizeValue.toFixed(1)} ${units[unitIndex]}`;
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 40;
const STEP = 1.25;
/** Room left around a fitted image so it never touches the editor's edges. */
const FIT_PADDING = 24;

type View = { scale: number; x: number; y: number };

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The editor's image tab: the picture on its own, centered and fitted to the
 * editor. Scroll (or the toolbar, or + / - / 0) zooms around the pointer, and
 * dragging moves it around; double-click flips between fit and actual size.
 */
export default function ImageViewer({ src, path, mimeType = null, size = null }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  // While fitted, the image refits when the editor is resized.
  const [fitted, setFitted] = useState(true);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number } | null>(null);

  const fitScale = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !natural) return 1;
    const w = Math.max(1, stage.clientWidth - FIT_PADDING * 2);
    const h = Math.max(1, stage.clientHeight - FIT_PADDING * 2);
    // Small images stay at their real size rather than being blown up.
    return clampScale(Math.min(1, w / natural.w, h / natural.h));
  }, [natural]);

  const fit = useCallback(() => {
    setView({ scale: fitScale(), x: 0, y: 0 });
    setFitted(true);
  }, [fitScale]);

  // A new file starts fitted.
  useEffect(() => {
    setNatural(null);
    setFitted(true);
  }, [src]);

  useEffect(() => {
    if (fitted) fit();
  }, [natural, fitted, fit]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (fitted) fit();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fitted, fit]);

  /** Zoom to `next`, keeping the image point under (cx, cy) — stage
   *  coordinates from its center — where it is. */
  const zoomTo = useCallback((next: number, cx = 0, cy = 0) => {
    setFitted(false);
    setView((v) => {
      const scale = clampScale(next);
      const ratio = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }, []);

  const pointFromCenter = (clientX: number, clientY: number) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { cx: clientX - rect.left - rect.width / 2, cy: clientY - rect.top - rect.height / 2 };
  };

  // Native listener: React's wheel handler is passive and cannot stop the
  // page from scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cx = event.clientX - rect.left - rect.width / 2;
      const cy = event.clientY - rect.top - rect.height / 2;
      // Trackpad pinches arrive as small ctrl+wheel deltas; mouse wheels as
      // larger steps. Both map smoothly onto an exponential zoom.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      setFitted(false);
      setView((v) => {
        const scale = clampScale(v.scale * factor);
        const ratio = scale / v.scale;
        return { scale, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y };
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    setFitted(false);
    setView((v) => ({ ...v, x: d.x + event.clientX - d.startX, y: d.y + event.clientY - d.startY }));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  }

  function onDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!fitted) {
      fit();
      return;
    }
    const { cx, cy } = pointFromCenter(event.clientX, event.clientY);
    zoomTo(Math.max(1, view.scale * 2), cx, cy);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === '+' || event.key === '=') zoomTo(view.scale * STEP);
    else if (event.key === '-' || event.key === '_') zoomTo(view.scale / STEP);
    else if (event.key === '0') fit();
    else if (event.key === '1') zoomTo(1);
    else return;
    event.preventDefault();
  }

  const percent = Math.round(view.scale * 100);

  return (
    <div className="image-viewer">
      <div className="image-meta-bar">
        <span className="meta-pill meta-name" title={path}>{fileName(path)}</span>
        {mimeType && <span className="meta-pill">{mimeType.replace('image/', '').replace('+xml', '').toUpperCase()}</span>}
        {natural && <span className="meta-pill">{natural.w} × {natural.h}</span>}
        {size ? <span className="meta-pill">{formatBytes(size)}</span> : null}
        <div className="image-zoom-controls" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomTo(view.scale / STEP)} title="Zoom out (−)" aria-label="Zoom out">−</button>
          <button type="button" className="image-zoom-level" onClick={fit} title="Fit to editor (0)">{percent}%</button>
          <button type="button" onClick={() => zoomTo(view.scale * STEP)} title="Zoom in (+)" aria-label="Zoom in">+</button>
          <button type="button" className={fitted ? 'active' : ''} onClick={fit} title="Fit to editor (0)">Fit</button>
          <button type="button" className={!fitted && view.scale === 1 ? 'active' : ''} onClick={() => zoomTo(1)} title="Actual size (1)">1:1</button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`image-stage${dragging ? ' dragging' : ''}`}
        tabIndex={0}
        aria-label={`${fileName(path)}. Scroll to zoom, drag to move, double-click to fit.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        <img
          src={src}
          alt={fileName(path)}
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            setNatural({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
          }}
          style={{
            width: natural?.w,
            height: natural?.h,
            visibility: natural ? 'visible' : 'hidden',
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            imageRendering: view.scale >= 4 ? 'pixelated' : 'auto',
          }}
        />
      </div>
    </div>
  );
}
