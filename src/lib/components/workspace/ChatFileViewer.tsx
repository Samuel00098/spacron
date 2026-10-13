import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language';
import { customTheme, customHighlightStyle, loadLanguageExtension } from '$lib/components/editor/CodeEditor';
import { detectLanguage } from '$lib/stores/editor';
import { copyTextToClipboard } from '$lib/utils/clipboard';
import { showToast } from '$lib/stores/notification';
import { isTauriRuntime } from '$lib/utils/tauri';
import ChatFileGlyph from './ChatFileGlyph';
import ChatDocument from './ChatDocument';
import './ChatFileViewer.css';

type ViewMode = 'preview' | 'code' | 'edit';

/**
 * Side viewer for a file the chat wrote (or a path a reply named), the way
 * Codex and ChatGPT show a created file: Markdown renders as a document, HTML
 * as a sandboxed page, everything else as highlighted source. Edit swaps in a
 * source editor; Save writes only if the file still holds what was loaded, so
 * a change made elsewhere meanwhile is never overwritten.
 */
export default function ChatFileViewer({ path, label, onClose, onOpenInEditor, onOpenFile }: {
  /** Absolute path of the file to show. */
  path: string;
  /** Path as the conversation names it (relative to its root). */
  label: string;
  onClose: () => void;
  onOpenInEditor?: () => void;
  /** A link inside a rendered document pointing at another file (absolute path). */
  onOpenFile?: (absolutePath: string) => void;
}) {
  const language = detectLanguage(path);
  const name = path.replace(/\\/g, '/').split('/').pop() || path;
  const previewable = language === 'markdown' || language === 'html';
  const restingMode: ViewMode = previewable ? 'preview' : 'code';
  const [mode, setMode] = useState<ViewMode>(restingMode);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<null | 'close' | 'leave'>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const contentRef = useRef<string | null>(null);
  contentRef.current = content;
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    setMode(restingMode);
    setDirty(false);
    setConfirmDiscard(null);
  }, [path, restingMode]);

  useEffect(() => {
    if (language === 'image') { setContent(''); setError(null); return; }
    let cancelled = false;
    setContent(null);
    setError(null);
    invoke<string>('fs_read_file', { path })
      .then((text) => { if (!cancelled) setContent(text); })
      .catch((reason) => { if (!cancelled) setError(String(reason ?? 'unknown error')); });
    return () => { cancelled = true; };
  }, [path, language, reloadKey]);

  // Source view and editor share one CodeMirror setup with the editor's own
  // theme. The editor is built once per entry into Edit, from the content at
  // that moment, so typing never rebuilds it.
  const editing = mode === 'edit';
  const loaded = content !== null;
  useEffect(() => {
    const host = codeRef.current;
    const doc = contentRef.current;
    if (!host || doc === null || (mode !== 'code' && mode !== 'edit') || language === 'image') return;
    let view: EditorView | null = null;
    let cancelled = false;
    const build = (extra: Extension[]) => {
      const keep = view?.state.doc.toString();
      view?.destroy();
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: keep ?? doc,
          extensions: [
            lineNumbers(),
            customTheme,
            syntaxHighlighting(customHighlightStyle),
            EditorView.lineWrapping,
            ...(editing
              ? [
                  history(),
                  drawSelection(),
                  highlightActiveLine(),
                  bracketMatching(),
                  indentOnInput(),
                  keymap.of([
                    { key: 'Mod-s', preventDefault: true, run: () => { saveRef.current(); return true; } },
                    indentWithTab,
                    ...defaultKeymap,
                    ...historyKeymap,
                  ]),
                  EditorView.updateListener.of((update) => {
                    if (update.docChanged) setDirty(update.state.doc.toString() !== contentRef.current);
                  }),
                ]
              : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
            ...extra,
          ],
        }),
      });
      editorRef.current = view;
      if (editing) view.focus();
    };
    build([]);
    void loadLanguageExtension(language).then((extension) => {
      if (!cancelled && extension) build([extension]);
    });
    return () => {
      cancelled = true;
      view?.destroy();
      if (editorRef.current === view) editorRef.current = null;
    };
    // `content` changes only re-render the read-only view (after a save or
    // reload); the editor deliberately ignores them while open.
  }, [mode, language, loaded, editing ? null : content]);

  useEffect(() => { rootRef.current?.focus(); }, [path]);

  const save = async () => {
    const view = editorRef.current;
    const original = contentRef.current;
    if (!view || original === null || saving) return;
    const next = view.state.doc.toString();
    if (next === original) { setDirty(false); setMode(restingMode); return; }
    setSaving(true);
    try {
      await invoke('fs_write_file_checked', { path, content: next, expectedContent: original });
      setContent(next);
      setDirty(false);
      setMode(restingMode);
      showToast(`Saved ${name}`, 'success', 1800);
    } catch (reason) {
      const message = String(reason ?? 'unknown error');
      showToast(/changed|modified|expected/i.test(message)
        ? `${name} changed on disk since it was opened. Copy your edits, then reload.`
        : `Could not save ${name}: ${message}`, 'error', 6000);
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => { void save(); };

  const leaveEdit = (force = false) => {
    if (dirty && !force) { setConfirmDiscard('leave'); return; }
    setConfirmDiscard(null);
    setDirty(false);
    setMode(restingMode);
  };
  const requestClose = () => {
    if (editing && dirty) { setConfirmDiscard('close'); return; }
    onClose();
  };

  const copy = () => {
    const text = editing ? editorRef.current?.state.doc.toString() : content;
    if (text == null) return;
    void copyTextToClipboard(text).then(
      () => showToast('Copied the file', 'success', 1800),
      () => showToast('Could not copy the file', 'error', 3000),
    );
  };

  let body: ReactNode;
  if (error) {
    body = <div className="chat-file-viewer-message">{/not found|cannot find|no such file|os error 2/i.test(error) ? 'This file no longer exists.' : `Could not open this file: ${error}`}</div>;
  } else if (language === 'image') {
    body = isTauriRuntime()
      ? <div className="chat-file-viewer-image"><img src={convertFileSrc(path)} alt={name} /></div>
      : <div className="chat-file-viewer-message">Images can be previewed in the desktop app.</div>;
  } else if (content === null) {
    body = <div className="chat-file-viewer-message">Loading…</div>;
  } else if (mode === 'preview' && language === 'markdown') {
    body = <ChatDocument source={content} filePath={path} onOpenFile={onOpenFile} />;
  } else if (mode === 'preview' && language === 'html') {
    // No scripts, no same-origin: the page renders but cannot reach the app.
    body = <iframe className="chat-file-viewer-frame" title={name} sandbox="" srcDoc={content} />;
  } else {
    body = <div ref={codeRef} className={`chat-file-viewer-code${editing ? ' editing' : ''}`} />;
  }

  const canEdit = language !== 'image' && content !== null && !error;

  return (
    <aside
      ref={rootRef}
      className="chat-file-viewer"
      aria-label={`File viewer: ${name}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (confirmDiscard) setConfirmDiscard(null);
        else if (editing) leaveEdit();
        else onClose();
      }}
    >
      <header className="chat-file-viewer-header">
        <ChatFileGlyph />
        <div className="chat-file-viewer-title">
          <strong title={name}>{name}{editing && dirty ? <span className="chat-file-viewer-dirty" aria-label="Unsaved changes"> ●</span> : null}</strong>
          {label !== name && <span title={label}>{label}</span>}
        </div>
        {editing ? (
          <div className="chat-file-viewer-edit-actions">
            <button type="button" onClick={() => leaveEdit()} disabled={saving}>Cancel</button>
            <button type="button" className="primary" onClick={() => void save()} disabled={saving || !dirty} title="Save (Ctrl+S)">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        ) : previewable && (
          <div className="chat-file-viewer-toggle" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</button>
            <button type="button" aria-pressed={mode === 'code'} onClick={() => setMode('code')}>Code</button>
          </div>
        )}
        <div className="chat-file-viewer-actions">
          {!editing && canEdit && (
            <button type="button" onClick={() => setMode('edit')} title="Edit file" aria-label="Edit file">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.7 3.9 3.9-.7L18.8 8.1a2.2 2.2 0 0 0-3.1-3.1z" /><path d="m14.4 6.8 2.8 2.8" /></svg>
            </button>
          )}
          {!editing && (
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} title="Reload from disk" aria-label="Reload from disk">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
            </button>
          )}
          {language !== 'image' && (
            <button type="button" onClick={copy} disabled={content === null} title="Copy contents" aria-label="Copy contents">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></svg>
            </button>
          )}
          {onOpenInEditor && !editing && (
            <button type="button" onClick={onOpenInEditor} title="Open in editor" aria-label="Open in editor">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
            </button>
          )}
          <button type="button" onClick={requestClose} title="Close (Esc)" aria-label="Close viewer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </header>
      {confirmDiscard && (
        <div className="chat-file-viewer-confirm" role="alertdialog" aria-label="Unsaved changes">
          <span>Discard your unsaved changes to {name}?</span>
          <button type="button" onClick={() => setConfirmDiscard(null)}>Keep editing</button>
          <button type="button" className="danger" onClick={() => { const closing = confirmDiscard === 'close'; leaveEdit(true); if (closing) onClose(); }}>Discard</button>
        </div>
      )}
      <div className="chat-file-viewer-body">{body}</div>
    </aside>
  );
}
