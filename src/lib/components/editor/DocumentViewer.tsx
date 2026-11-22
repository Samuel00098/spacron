import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '$lib/stores/notification';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import './DocumentViewer.css';

interface Props { kind: 'pdf' | 'docx'; data?: Uint8Array; path: string }
const DOC_FRAME = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:;"><style>html,body{margin:0;overscroll-behavior:none}body{background:#e8e8ea}.docx-wrapper{padding:16px!important}section.docx{box-sizing:border-box;max-width:100%;overflow-wrap:anywhere}a{pointer-events:none}</style></head><body></body></html>`;

export default function DocumentViewer({ kind, data, path }: Props) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (kind !== 'pdf') return;
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | undefined;
    if (!data) { setError('Document data is unavailable. Close and reopen the file.'); setLoading(false); return; }
    void (async () => {
      try {
        const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        if (cancelled) return;
        GlobalWorkerOptions.workerSrc = worker.default;
        const pending = getDocument({ data: data.slice(), useSystemFonts: true });
        task = pending;
        const document = await pending.promise;
        if (!cancelled) setPdf(document);
      } catch (reason) {
        if (!cancelled) { setError(`Could not preview PDF: ${reason instanceof Error ? reason.message : String(reason)}`); setLoading(false); }
      }
    })();
    return () => { cancelled = true; void task?.destroy(); };
  }, [kind, data]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    let render: { cancel: () => void } | undefined;
    setLoading(true);
    void (async () => {
      try {
        const documentPage = await pdf.getPage(page);
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const ratio = window.devicePixelRatio || 1;
        const viewport = documentPage.getViewport({ scale: zoom });
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable');
        const pending = documentPage.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        render = pending;
        await pending.promise;
        if (!cancelled) setLoading(false);
      } catch (reason) {
        if (!cancelled) { setError(`Could not render page: ${String(reason)}`); setLoading(false); }
      }
    })();
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, page, zoom]);

  const renderDocx = async () => {
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    try {
      if (!data) throw new Error('Document data is unavailable. Close and reopen the file.');
      const { renderAsync } = await import('docx-preview');
      if (!alive.current) return;
      await renderAsync(data.slice(), document.body, document.head, { renderAltChunks: false, useBase64URL: true, breakPages: true });
      if (alive.current) setLoading(false);
    } catch (reason) {
      if (alive.current) { setError(`Could not preview DOCX: ${String(reason)}`); setLoading(false); }
    }
  };

  return <section className="document-viewer" aria-label={`${kind.toUpperCase()} document preview`}>
    <div className="document-viewer-toolbar">
      <span title={path}>{path.split(/[\\/]/).pop()}</span><button type="button" title="Open in the system-associated application to edit"
        onClick={() => void invoke('fs_open_document', { path }).catch((reason) =>
          showToast(`Could not open document: ${String(reason)}`, 'error'))}>
        Open in desktop app
      </button>
      {kind === 'pdf' && <>
        <button disabled={!pdf || page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous page">Previous</button>
        <span>Page {page} / {pdf?.numPages ?? '-'}</span>
        <button disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((value) => value + 1)} aria-label="Next page">Next</button>
        <button onClick={() => setZoom((value) => Math.max(.25, value - .25))} disabled={zoom <= .25} aria-label="Zoom out">-</button>
        <button onClick={() => setZoom(1)} aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
        <button onClick={() => setZoom((value) => Math.min(3, value + .25))} disabled={zoom >= 3} aria-label="Zoom in">+</button>
      </>}
    </div>
    {error ? <p role="alert">{error}</p> : <>
      {loading && <p role="status">Loading document...</p>}
      {kind === 'pdf' ? <div className="document-viewer-pages"><canvas ref={canvasRef} aria-label={`PDF page ${page}`} /></div>
        : <iframe ref={frameRef} title="DOCX document" sandbox="allow-same-origin" srcDoc={DOC_FRAME} onLoad={() => { void renderDocx(); }} />}
    </>}
  </section>;
}
