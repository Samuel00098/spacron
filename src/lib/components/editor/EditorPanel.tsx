import { useMemo } from 'react';
import EditorTabs from './EditorTabs.tsx';
import ImageViewer from './ImageViewer.tsx';
import MarkdownPreview from '$lib/components/preview/MarkdownPreview.tsx';
import { useEditorStore } from '$lib/stores/zustand/editor';
import CodeEditor from './CodeEditor.tsx';
import './EditorPanel.css';

function CodeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function EditorPanel() {
  const files = useEditorStore((s) => s.openFiles);
  const active = useEditorStore((s) => s.activeFile);
  const cache = useEditorStore((s) => s.fileCache);
  const markdownCodeModePaths = useEditorStore((s) => s.markdownCodeModePaths);
  const setMarkdownPreview = useEditorStore((s) => s.setMarkdownPreview);

  const file = active ? cache.get(active) : null;
  const canPreviewMarkdown = file?.kind === 'text' && file?.language === 'markdown';
  const showMarkdownPreview = canPreviewMarkdown && active ? !markdownCodeModePaths?.has(active) : false;

  const codeEditorProps = useMemo(
    () =>
      file
        ? {
            filePath: file.path,
            initialContent: file.content,
            language: file.language,
          }
        : undefined,
    [file?.path],
  );

  if (files.length === 0 || !active || !file) {
    return (
      <div className="editor-panel">
        <div className="editor-empty-placeholder">
          <div className="placeholder-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35 }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <p className="placeholder-text">No document open</p>
          <p className="placeholder-hint">Select a file from the explorer to view or edit</p>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-panel">
      <div className="editor-toolbar">
        <EditorTabs />
        {canPreviewMarkdown && (
          <button
            className={`markdown-toggle-btn${showMarkdownPreview ? ' active' : ''}`}
            onClick={() => active && setMarkdownPreview(active, !showMarkdownPreview)}
            title={showMarkdownPreview ? 'Show Editor' : 'Show Preview'}
            aria-label="Toggle markdown preview"
          >
            {showMarkdownPreview ? <CodeIcon /> : <EyeIcon />}
            <span>{showMarkdownPreview ? 'Show Code' : 'Show Preview'}</span>
          </button>
        )}
      </div>

      <div className="editor-workspace-area">
        {file.kind === 'image' && file.imageSrc ? (
          <ImageViewer src={file.imageSrc} path={file.path} mimeType={file.mimeType} size={file.size} />
        ) : file.language === 'markdown' && showMarkdownPreview ? (
          <MarkdownPreview content={file.content} />
        ) : (
          codeEditorProps && (
            <CodeEditor
              key={file.path}
              {...codeEditorProps}
            />
          )
        )}
      </div>
    </div>
  );
}
