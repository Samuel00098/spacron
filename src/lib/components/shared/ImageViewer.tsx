import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { renameChatImageAttachments } from '$lib/stores/chatThreads';
import { useModalFocus } from '$lib/react/useModalFocus';
import { copyPngToClipboard } from '$lib/utils/clipboard';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import './ImageViewer.css';

export interface ViewerImage {
  /** What the <img> loads: an asset URL for a file, or a blob: preview. */
  src: string;
  name: string;
  /** The file on disk, when there is one; enables save and show-in-folder. */
  path?: string;
}

interface ImageViewerProps {
  images: ViewerImage[];
  startIndex?: number;
  /** The active project, so images inside it pass the backend's path check. */
  projectRoot?: string | null;
  onClose: () => void;
  onRename?: (previous: ViewerImage, renamed: ViewerImage) => void;
  /** Offer "Use as input" (adds the image to the next message's attachments). */
  onUseAsInput?: (image: ViewerImage) => void;
  /**
   * Offer Edit: the user paints the area to change (optional) and describes
   * the change. `markPath` is the picture with that area painted over, saved
   * for the provider; absent means "edit the whole image".
   */
  onEdit?: (image: ViewerImage, prompt: string, markPath?: string, target?: string) => void;
  /**
   * Where Edit can send the request (an image provider, the chat, an agent).
   * With two or more, a picker sits next to Apply and its value reaches
   * `onEdit` as `target`; without, Edit behaves as it always has.
   */
  editTargets?: DropdownOption[];
  defaultEditTarget?: string;
}

/** Selection colour; the edit prompt names it, so keep the two in step. */
const MARK_COLOR = '#ff00ff';
const MARK_ALPHA = 0.55;

async function loadBitmap(src: string): Promise<ImageBitmap> {
  // Drawing the <img> itself would taint the canvas (the asset protocol is
  // another origin); a fetched blob does not.
  const response = await fetch(src);
  return createImageBitmap(await response.blob());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

/**
 * Full-size image viewer: zoom, pan, step through a set, and the file actions
 * (copy, save a copy, show in folder, reuse as input). Portaled to <body> so a
 * transformed or blurred ancestor cannot trap its fixed overlay, and mounted
 * only while open, which is what `useModalFocus`'s shortcut gate requires.
 */
export default function ImageViewer({ images, startIndex = 0, projectRoot, onClose, onRename, onUseAsInput, onEdit, editTargets, defaultEditTarget }: ImageViewerProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, images.length - 1)));
  // null = fit to the window; a number is an explicit scale (1 = actual pixels).
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // Track whether pointerdown began on the empty stage backdrop (not on the
  // image). setPointerCapture on the stage retargets the post-pan click event
  // onto stageRef, so event.target === stageRef alone cannot distinguish a
  // backdrop click from releasing an image pan.
  const backdropDownRef = useRef(false);
  const image = images[index];
  const [renameName, setRenameName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const renameState = useRef({ name: renameName, saving: renaming });
  renameState.current = { name: renameName, saving: renaming };
  // Edit mode: pointer strokes paint the selection instead of panning.
  const [editing, setEditing] = useState(false);
  const [editPrompt, setEditPrompt] = useState('');
  const [brush, setBrush] = useState(40);
  const [hasMark, setHasMark] = useState(false);
  const [applying, setApplying] = useState(false);
  const [editTarget, setEditTarget] = useState(() => defaultEditTarget ?? editTargets?.[0]?.value ?? '');
  // A target can vanish while the viewer is open (an agent exits); fall back.
  const target = editTargets?.some((option) => option.value === editTarget && !option.disabled)
    ? editTarget
    : editTargets?.find((option) => !option.disabled)?.value ?? '';
  const markRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef<{ x: number; y: number } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useModalFocus(dialogRef, () => {
    if (renameState.current.name !== null) {
      if (!renameState.current.saving) setRenameName(null);
    } else onClose();
  });

  const step = useCallback((delta: number) => {
    if (images.length < 2 || renaming) return;
    setIndex((current) => (current + delta + images.length) % images.length);
  }, [images.length, renaming]);

  // Centre each image while preserving the viewer's chosen zoom.
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
    // Cached images may load before this effect; retain their measured size.
    const loaded = imageRef.current;
    setNatural(loaded?.complete && loaded.naturalWidth
      ? { width: loaded.naturalWidth, height: loaded.naturalHeight } : null);
    setStatus(null);
    setEditing(false);
    setHasMark(false);
    setRenameName(null);
  }, [index]);

  useEffect(() => {
    if (editing) promptRef.current?.focus();
  }, [editing]);

  // The fit scale follows the stage size, so "Fit" stays right when resized.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const measure = () => {
      const { width, height } = stage.getBoundingClientRect();
      setFitScale(Math.min(1, (width - 32) / natural.width, (height - 32) / natural.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [natural]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.25); }
      else if (event.key === '-') { event.preventDefault(); zoomBy(0.8); }
      else if (event.key === '0') { event.preventDefault(); setZoom(null); setOffset({ x: 0, y: 0 }); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  const scale = zoom ?? fitScale;

  function zoomBy(factor: number) {
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (current ?? fitScale) * factor)));
  }

  function onWheel(event: ReactWheelEvent) {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  /** The pointer in the selection canvas's pixel space (the image's natural size). */
  function markPoint(event: ReactPointerEvent): { x: number; y: number } | null {
    const canvas = markRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: ((event.clientX - rect.left) / rect.width) * canvas.width, y: ((event.clientY - rect.top) / rect.height) * canvas.height };
  }

  function paintTo(point: { x: number; y: number }) {
    const canvas = markRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const from = painting.current ?? point;
    // Brush size is in screen pixels so it feels the same at any zoom.
    ctx.lineWidth = brush / scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = MARK_COLOR;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    painting.current = point;
    setHasMark(true);
  }

  function clearMark() {
    const canvas = markRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setHasMark(false);
  }

  async function applyEdit() {
    const prompt = editPrompt.trim();
    if (!onEdit || !image.path || !prompt || applying) return;
    setApplying(true);
    try {
      let markPath: string | undefined;
      const mark = markRef.current;
      if (hasMark && mark) {
        const bitmap = await loadBitmap(image.src);
        const out = document.createElement('canvas');
        out.width = bitmap.width;
        out.height = bitmap.height;
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('canvas unavailable');
        ctx.drawImage(bitmap, 0, 0);
        ctx.globalAlpha = MARK_ALPHA;
        ctx.drawImage(mark, 0, 0, out.width, out.height);
        const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('could not encode the selection');
        const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
        markPath = await invoke<string>('save_edit_mark', { pngBase64: base64 });
      }
      onEdit(image, prompt, markPath, editTargets ? target : undefined);
      onClose();
    } catch (error) {
      setStatus(`Edit failed: ${String(error ?? 'unknown error')}`);
      setApplying(false);
    }
  }

  function onPointerDown(event: ReactPointerEvent) {
    if (event.button !== 0) return;
    // Capturing a navigation button's pointer redirects its click to the stage.
    if (event.target instanceof Element && event.target.closest('button')) return;
    // Clicking the transparent backdrop outside the image dismisses the lightbox
    // instead of starting a pan drag.
    if (!editing && event.target === stageRef.current) {
      backdropDownRef.current = true;
      return;
    }
    backdropDownRef.current = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (editing) {
      const point = markPoint(event);
      if (point) { painting.current = null; paintTo(point); }
      return;
    }
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  }

  function onPointerMove(event: ReactPointerEvent) {
    if (editing) {
      if (!painting.current) return;
      const point = markPoint(event);
      if (point) paintTo(point);
      return;
    }
    const start = drag.current;
    if (!start) return;
    setOffset({ x: start.ox + event.clientX - start.x, y: start.oy + event.clientY - start.y });
  }

  function endDrag() {
    drag.current = null;
    painting.current = null;
  }

  async function run(label: string, action: () => Promise<unknown>) {
    try {
      await action();
      setStatus(label);
    } catch (error) {
      setStatus(`Failed: ${String(error ?? 'unknown error')}`);
    }
  }

  const copy = () => run('Copied to clipboard', async () => {
    const response = await fetch(image.src);
    await copyPngToClipboard(new Uint8Array(await response.arrayBuffer()));
  });

  const reveal = () => run('Opened the folder', () => invoke('reveal_image', { path: image.path, projectRoot: projectRoot ?? null }));

  async function rename() {
    if (!image.path || !renameName?.trim() || renaming || !onRename) return;
    setRenaming(true);
    try {
      const result = await invoke<{ path: string; name: string }>('rename_image', {
        path: image.path, name: renameName.trim(), projectRoot: projectRoot ?? null,
      });
      renameChatImageAttachments(image.path, result.path, result.name);
      onRename(image, { ...result, src: convertFileSrc(result.path) });
      setRenameName(null);
      setStatus('Image renamed');
    } catch (error) {
      setStatus(`Rename failed: ${String(error ?? 'unknown error')}`);
    } finally {
      setRenaming(false);
    }
  }

  if (!image) return null;

  return createPortal(
    <div className="image-viewer-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="image-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`Image: ${image.name}`}
        onClick={(event) => {
          if (event.target !== event.currentTarget || editing) event.stopPropagation();
        }}
      >
        <header className="image-viewer-bar">
          {renameName !== null ? (
            <div className="image-viewer-rename">
              <input
                autoFocus
                aria-label="Image name"
                value={renameName}
                disabled={renaming}
                maxLength={120}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void rename(); }
                  if (event.key === 'Escape') { event.stopPropagation(); if (!renaming) setRenameName(null); }
                }}
              />
              <span>{image.name.match(/\.[^.]+$/)?.[0]}</span>
            </div>
          ) : <span className="image-viewer-name" title={image.path ?? image.name}>{image.name}</span>}
          {images.length > 1 && <span className="image-viewer-count">{index + 1} / {images.length}</span>}
          <div className="image-viewer-tools">
            <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">−</button>
            <span className="image-viewer-zoom">{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => { setZoom(null); setOffset({ x: 0, y: 0 }); }} className={zoom === null ? 'active' : ''}>Fit</button>
            <button type="button" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} className={zoom === 1 ? 'active' : ''}>100%</button>
            <span className="image-viewer-divider" aria-hidden />
            <button type="button" onClick={copy}>Copy</button>
            {image.path && onRename && (renameName !== null ? (
              <>
                <button type="button" onClick={() => void rename()} disabled={renaming || !renameName.trim()}>{renaming ? 'Saving…' : 'Save'}</button>
                <button type="button" onClick={() => setRenameName(null)} disabled={renaming}>Cancel</button>
              </>
            ) : <button type="button" onClick={() => setRenameName(image.name.replace(/\.[^.]+$/, ''))}>Rename</button>)}
            {image.path && <button type="button" onClick={reveal}>Show in folder</button>}
            {onEdit && image.path && !editing && (
              <button type="button" className="primary" onClick={() => setEditing(true)} title="Select an area and describe a change">Edit</button>
            )}
            {onUseAsInput && image.path && (
              <button type="button" className="primary" onClick={() => { onUseAsInput(image); onClose(); }}>Use as input</button>
            )}
            <button type="button" onClick={onClose} aria-label="Close viewer" className="image-viewer-close">✕</button>
          </div>
        </header>
        <div
          ref={stageRef}
          className={`image-viewer-stage${drag.current ? ' dragging' : ''}${editing ? ' editing' : ''}`}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={(event) => {
            const startedOnBackdrop = backdropDownRef.current;
            backdropDownRef.current = false;
            if (!editing && startedOnBackdrop && event.target === stageRef.current) onClose();
          }}
          onDoubleClick={(event) => {
            if (editing || backdropDownRef.current || (event.target instanceof Element && event.target.closest('button'))) return;
            setZoom(zoom === null ? 1 : null);
            setOffset({ x: 0, y: 0 });
          }}
        >
          <img
            ref={imageRef}
            src={image.src}
            alt={image.name}
            draggable={false}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            style={natural ? {
              width: natural.width * scale,
              height: natural.height * scale,
              transform: `translate(${offset.x}px, ${offset.y}px)`,
            } : { maxWidth: '100%', maxHeight: '100%' }}
          />
          {editing && natural && (
            <canvas
              ref={markRef}
              className="image-viewer-mark"
              width={natural.width}
              height={natural.height}
              style={{
                width: natural.width * scale,
                height: natural.height * scale,
                transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
                opacity: MARK_ALPHA,
              }}
            />
          )}
          {images.length > 1 && (
            <>
              <button type="button" className="image-viewer-step prev" onClick={() => step(-1)} disabled={renaming} aria-label="Previous image">‹</button>
              <button type="button" className="image-viewer-step next" onClick={() => step(1)} disabled={renaming} aria-label="Next image">›</button>
            </>
          )}
        </div>
        {editing && (
          <div className="image-viewer-edit">
            <textarea
              ref={promptRef}
              rows={2}
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void applyEdit(); }
                if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); clearMark(); }
              }}
              placeholder={hasMark ? 'Describe the change to the selected area…' : 'Describe the edit, or paint over an area first to change only that part…'}
              aria-label="Describe the edit"
            />
            <div className="image-viewer-edit-tools">
              <label title="Brush size">
                Brush
                <input type="range" min={8} max={160} value={brush} onChange={(event) => setBrush(Number(event.target.value))} />
              </label>
              <button type="button" onClick={clearMark} disabled={!hasMark}>Clear selection</button>
              {editTargets && editTargets.length > 1 && (
                <span className="image-viewer-edit-target">
                  Send to
                  <Dropdown options={editTargets} value={target} onChange={setEditTarget} ariaLabel="Where to send the edit" direction="up" />
                </span>
              )}
              <button type="button" onClick={() => { setEditing(false); clearMark(); }}>Cancel</button>
              <button type="button" className="primary" onClick={() => void applyEdit()} disabled={!editPrompt.trim() || applying || (editTargets !== undefined && !target)}>
                {applying ? 'Sending…' : 'Apply edit'}
              </button>
            </div>
          </div>
        )}
        <footer className="image-viewer-foot">
          <span>{natural ? `${natural.width} × ${natural.height}` : 'Loading…'}</span>
          {status && <span className="image-viewer-status">{status}</span>}
          <span className="image-viewer-hint">{editing ? 'Paint over what to change · scroll to zoom · Enter to apply' : 'Scroll to zoom · drag to pan · double-click for 100%'}</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
