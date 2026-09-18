import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as agentPanelImagesModule from '$lib/stores/agentPanelImages';
import { requestTerminalInput } from '$lib/stores/terminal';
import { isImagePath, getImageMimeType } from '$lib/stores/editor';
import { isTauriRuntime, dropPositionToCss } from '$lib/utils/tauri';
import { useStore } from '$lib/react/useStore';
import './AgentPanelImages.css';

interface Props {
  sessionId: number;
}

function isOverElement(el: Element, clientX: number, clientY: number): boolean {
  const rect = el.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right &&
         clientY >= rect.top && clientY <= rect.bottom;
}

export default function AgentPanelImages({ sessionId }: Props) {
  const allImages = useStore(agentPanelImagesModule.agentPanelImages);
  const images = allImages.get(sessionId) ?? [];
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const internalDropHandledRef = useRef(false);
  const isExplorerDragRef = useRef(false);

  // Deliver the path through xterm's bracketed paste (no trailing Enter), so
  // a TUI composer like opencode's reads it as an image attachment sitting in
  // its input box. Direct PTY writes with `\r` submitted the prompt
  // immediately instead of attaching.
  const deliverPathToComposer = useCallback(
    (path: string) => {
      const normalized = path.replace(/\\/g, '/');
      const quoted = normalized.includes(' ') ? `"${normalized}"` : normalized;
      requestTerminalInput(sessionId, quoted);
    },
    [sessionId]
  );

  const addImageFromPath = useCallback(async (path: string) => {
    try {
      const bytes = await invoke<number[]>('fs_read_binary', { path });
      const mimeType = getImageMimeType(path);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      const name = path.split(/[\\/]/).pop() || 'image';
      agentPanelImagesModule.agentPanelImages.add(sessionId, {
        id: crypto.randomUUID(),
        objectUrl,
        diskPath: path,
        name,
      });
      deliverPathToComposer(path);
    } catch (error) {
      console.error('Failed to add image from disk:', error);
    }
  }, [sessionId, deliverPathToComposer]);

  // Persist pasted/dropped raw bytes (clipboard screenshots, browser file
  // drops with no OS path) to the scratch dir, then treat them like any other
  // attached image.
  const addImageFromBytes = useCallback(async (bytes: Uint8Array, name: string) => {
    try {
      const savePath = await invoke<string>('save_pasted_image', {
        name,
        data: Array.from(bytes),
      });
      const normalized = savePath.replace(/\\/g, '/');
      const mimeType = getImageMimeType(normalized);
      const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      agentPanelImagesModule.agentPanelImages.add(sessionId, {
        id: crypto.randomUUID(),
        objectUrl,
        diskPath: normalized,
        name,
      });
      deliverPathToComposer(normalized);
    } catch (error) {
      console.error('Failed to add pasted image:', error);
    }
  }, [sessionId, deliverPathToComposer]);

  const handlePaste = useCallback(async (event: React.ClipboardEvent) => {
    const items = Array.from(event.clipboardData?.items ?? []).filter((item) =>
      item.type.startsWith('image/')
    );
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    );
    if (!items.length && !files.length) return;
    event.preventDefault();
    event.stopPropagation();
    for (const file of files) {
      const buffer = new Uint8Array(await file.arrayBuffer());
      await addImageFromBytes(buffer, file.name || `pasted-image-${Date.now()}.png`);
    }
    for (const item of items) {
      const file = item.getAsFile();
      if (!file) continue;
      const buffer = new Uint8Array(await file.arrayBuffer());
      await addImageFromBytes(buffer, `pasted-image-${Date.now()}.png`);
    }
  }, [addImageFromBytes]);

  const handleFileInput = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const buffer = new Uint8Array(await file.arrayBuffer());
      await addImageFromBytes(buffer, file.name || `attached-image-${Date.now()}.png`);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [addImageFromBytes]);

  const pickImageFiles = useCallback(async () => {
    if (isTauriRuntime()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          multiple: true,
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'] }],
        });
        const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
        for (const p of paths) {
          if (typeof p === 'string') await addImageFromPath(p);
        }
        return;
      } catch (error) {
        console.error('Failed to open image picker:', error);
      }
    }
    fileInputRef.current?.click();
  }, [addImageFromPath]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    // Browser file drops (real File objects, no OS path yet).
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    );
    if (files.length) {
      internalDropHandledRef.current = true;
      queueMicrotask(() => { internalDropHandledRef.current = false; });
      void (async () => {
        for (const file of files) {
          const buffer = new Uint8Array(await file.arrayBuffer());
          await addImageFromBytes(buffer, file.name || `dropped-image-${Date.now()}.png`);
        }
      })();
      return;
    }

    const path = (
      event.dataTransfer?.getData('application/x-spacron-path')?.trim() ||
      event.dataTransfer?.getData('text/plain')?.trim() ||
      null
    );

    if (path && isImagePath(path)) {
      internalDropHandledRef.current = true;
      queueMicrotask(() => { internalDropHandledRef.current = false; });
      void addImageFromPath(path);
    }
  }, [addImageFromPath, addImageFromBytes]);

  // ── Internal explorer drag (custom pointer events) ──
  useEffect(() => {
    const handleStart = () => { isExplorerDragRef.current = true; };

    const handleMove = (event: Event) => {
      const custom = event as CustomEvent<{ clientX?: number; clientY?: number }>;
      const el = rootRef.current;
      const cx = custom.detail?.clientX;
      const cy = custom.detail?.clientY;
      if (!el || cx == null || cy == null) return;
      setIsDragOver(isOverElement(el, cx, cy));
    };

    const handleEnd = (event: Event) => {
      const custom = event as CustomEvent<{ path?: string; clientX?: number; clientY?: number }>;
      const el = rootRef.current;
      if (!el || custom.detail?.path == null) {
        isExplorerDragRef.current = false;
        setIsDragOver(false);
        return;
      }
      const path = custom.detail.path.trim();
      const cx = custom.detail.clientX;
      const cy = custom.detail.clientY;
      const over = cx != null && cy != null
        ? isOverElement(el, cx, cy)
        : false;
      isExplorerDragRef.current = false;
      setIsDragOver(false);
      if (over && isImagePath(path)) {
        void addImageFromPath(path);
      }
    };

    window.addEventListener('spacron-explorer-drag-start', handleStart);
    window.addEventListener('spacron-explorer-drag-move', handleMove);
    window.addEventListener('spacron-explorer-drag-end', handleEnd);
    return () => {
      window.removeEventListener('spacron-explorer-drag-start', handleStart);
      window.removeEventListener('spacron-explorer-drag-move', handleMove);
      window.removeEventListener('spacron-explorer-drag-end', handleEnd);
    };
  }, [addImageFromPath]);

  // ── HTML5 dragover/drop on document (fallback for non-Tauri drops) ──
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleDocumentDragOver = (event: DragEvent) => {
      if (!isExplorerDragRef.current) return;
      const el = rootRef.current;
      if (!el) return;
      const over = isOverElement(el, event.clientX, event.clientY);
      if (over) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }
      setIsDragOver(over);
    };

    const handleDocumentDrop = (event: DragEvent) => {
      if (internalDropHandledRef.current) return;
      if (!isExplorerDragRef.current) return;
      const el = rootRef.current;
      if (!el) return;
      const over = isOverElement(el, event.clientX, event.clientY);
      setIsDragOver(false);
      if (!over) return;

      event.preventDefault();
      event.stopPropagation();
      isExplorerDragRef.current = false;

      const droppedPath =
        event.dataTransfer?.getData('text/plain')?.trim() || null;
      if (droppedPath && isImagePath(droppedPath)) {
        void addImageFromPath(droppedPath);
      }
    };

    document.addEventListener('dragover', handleDocumentDragOver);
    document.addEventListener('drop', handleDocumentDrop);
    return () => {
      document.removeEventListener('dragover', handleDocumentDragOver);
      document.removeEventListener('drop', handleDocumentDrop);
    };
  }, [addImageFromPath]);

  // ── OS file manager drag (Tauri event) ──
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;

    getCurrentWindow().onDragDropEvent((event) => {
      if (internalDropHandledRef.current) return;

      const type = event.payload.type;
      if (type === 'enter' || type === 'over') {
        const el = rootRef.current;
        if (!el) return;
        const pos = (event.payload as any).position as { x: number; y: number };
        void dropPositionToCss(pos).then((css) => {
          if (!css) return;
          setIsDragOver(isOverElement(el, css.x, css.y));
        });
        return;
      }
      if (type === 'leave') {
        setIsDragOver(false);
        return;
      }
      if (type === 'drop') {
        const el = rootRef.current;
        if (!el) return;
        const payload = event.payload as any;
        const pos = payload.position as { x: number; y: number };
        setIsDragOver(false);
        void dropPositionToCss(pos).then((css) => {
          if (!css) return;
          // Hidden rooms stay laid out at full size; reject them the same way
          // TerminalPane does before the rect test.
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.pointerEvents === 'none') return;
          if (!isOverElement(el, css.x, css.y)) return;

          const paths: string[] = payload.paths ?? [];
          for (const p of paths) {
            if (isImagePath(p)) {
              void addImageFromPath(p);
            }
          }
        });
      }
    }).then((u) => { unlisten = u; });

    return () => { unlisten?.(); };
  }, [addImageFromPath]);

  // Escape closes the expanded preview.
  useEffect(() => {
    if (!expandedImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedImage(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [expandedImage]);

  return (
    <div
      ref={rootRef}
      className={`agent-panel-images${isDragOver ? ' drag-over' : ''}${images.length === 0 && !isDragOver ? ' empty' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => void handleFileInput(event.target.files)}
        aria-hidden="true"
        tabIndex={-1}
      />
      {images.length > 0 && (
        <div className="api-strip">
          {images.map((img) => (
            <div key={img.id} className="api-thumb" title={`${img.name} — click to preview`}>
              <img
                src={img.objectUrl}
                alt={img.name}
                onClick={() => setExpandedImage(img.objectUrl)}
                style={{ cursor: 'zoom-in' }}
              />
              <button
                className="api-remove"
                onClick={() => agentPanelImagesModule.agentPanelImages.remove(sessionId, img.id)}
                title="Remove image"
                aria-label={`Remove ${img.name}`}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            className="api-add"
            onClick={() => void pickImageFiles()}
            title="Attach images (or paste with Ctrl+V, drop files here)"
            aria-label="Attach images"
          >
            +
          </button>
        </div>
      )}
      {images.length === 0 && (
        <button
          type="button"
          className={`api-empty-add${isDragOver ? ' drag-over' : ''}`}
          onClick={() => void pickImageFiles()}
          title="Attach images (or paste with Ctrl+V, drop files here)"
        >
          {isDragOver ? 'Drop images to attach' : 'Attach images · paste · drop'}
        </button>
      )}
      {expandedImage && (
        <div
          className="api-preview-overlay"
          onClick={() => setExpandedImage(null)}
          role="dialog"
          aria-label="Image preview"
        >
          <div
            className="api-preview-content"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={expandedImage}
              alt="Expanded preview"
              className="api-preview-img"
            />
            <button
              type="button"
              className="api-preview-close"
              onClick={() => setExpandedImage(null)}
              aria-label="Close preview"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
