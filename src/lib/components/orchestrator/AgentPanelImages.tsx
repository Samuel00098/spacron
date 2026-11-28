import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as agentPanelImagesModule from '$lib/stores/agentPanelImages';
import { requestTerminalInput, terminalChatInputRequest } from '$lib/stores/terminal';
import { structuredChatPanes, useStructuredChatPane } from '$lib/services/structured-chat/panes';
import { isTerminalChatView, useTerminalChatView } from '$lib/services/terminal-chat';
import { get } from '$lib/stores/storeCompat';
import { showToast } from '$lib/stores/notification';
import { isImagePath, getImageMimeType } from '$lib/stores/editor';
import { isTauriRuntime, dropPositionToCss } from '$lib/utils/tauri';
import { isPointOverDropTarget } from '$lib/utils/drop-target';
import { useStore } from '$lib/react/useStore';
import './AgentPanelImages.css';

interface Props {
  sessionId: number;
}

// A rect test is not enough here: every mounted agent room listens to the same
// window-level drag streams, and hidden rooms stay laid out at full stage size,
// so a plain containment check made every agent's tray claim the same drop.
function isOverElement(el: Element, clientX: number, clientY: number): boolean {
  return isPointOverDropTarget(el, clientX, clientY);
}

function isPaneInChatView(sessionId: number): boolean {
  return Boolean(get(structuredChatPanes)[sessionId]) || isTerminalChatView(sessionId);
}

export default function AgentPanelImages({ sessionId }: Props) {
  const structuredAgent = useStructuredChatPane(sessionId);
  const terminalChatView = useTerminalChatView(sessionId);
  const inChatView = Boolean(structuredAgent) || terminalChatView;
  const allImages = useStore(agentPanelImagesModule.agentPanelImages);
  const images = allImages.get(sessionId) ?? [];
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const internalDropHandledRef = useRef(false);
  const isExplorerDragRef = useRef(false);

  // Deliver the path to the active surface: chat view receives it as a
  // composer attachment chip, while terminal view receives a bracketed paste
  // (no trailing Enter) so TUI agents attach it without auto-submitting.
  const deliverPathToComposer = useCallback(
    (path: string, name?: string, previewUrl?: string | null) => {
      const normalized = path.replace(/\\/g, '/');
      if (isPaneInChatView(sessionId)) {
        terminalChatInputRequest.set({
          sessionId,
          text: '',
          image: {
            path: normalized,
            name: name ?? (normalized.split('/').pop() || 'image'),
            dataUrl: previewUrl ?? undefined,
          },
        });
        return;
      }
      const quoted = normalized.includes(' ') ? `"${normalized}"` : normalized;
      requestTerminalInput(sessionId, quoted);
    },
    [sessionId]
  );

  const addImageFromPath = useCallback(async (path: string) => {
    const normalized = path.replace(/\\/g, '/');
    const name = normalized.split('/').pop() || 'image';
    const preview = await invoke<string>('chat_image_preview', { path }).catch(() => null);
    if (!isPaneInChatView(sessionId) && preview) {
      agentPanelImagesModule.agentPanelImages.add(sessionId, {
        id: crypto.randomUUID(),
        objectUrl: preview,
        diskPath: normalized,
        name,
      });
    }
    deliverPathToComposer(normalized, name, preview);
    if (!preview) {
      showToast(`Attached ${name} (preview unavailable)`, 'info');
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
      if (!isPaneInChatView(sessionId)) {
        agentPanelImagesModule.agentPanelImages.add(sessionId, {
          id: crypto.randomUUID(),
          objectUrl,
          diskPath: normalized,
          name,
        });
      }
      deliverPathToComposer(normalized, name, objectUrl);
    } catch (error) {
      console.error('Failed to add pasted image:', error);
      showToast('Failed to attach pasted image', 'error');
    }
  }, [sessionId, deliverPathToComposer]);

  const handlePaste = useCallback(async (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    );
    const items = files.length
      ? []
      : Array.from(event.clipboardData?.items ?? []).filter((item) =>
          item.type.startsWith('image/')
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
    if (inChatView) return;
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
  }, [addImageFromPath, inChatView]);

  // ── HTML5 dragover/drop on document (fallback for non-Tauri drops) ──
  useEffect(() => {
    if (inChatView || typeof document === 'undefined') return;

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
  }, [addImageFromPath, inChatView]);

  // ── OS file manager drag (Tauri event) ──
  useEffect(() => {
    if (inChatView || !isTauriRuntime()) return;
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
  }, [addImageFromPath, inChatView]);

  // Escape closes the expanded preview.
  useEffect(() => {
    if (!expandedImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedImage(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [expandedImage]);

  if (inChatView) return null;

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
            <div key={img.id} className="api-thumb" title={`${img.name}: click to preview`}>
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
