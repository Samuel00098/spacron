import { useMemo, useState } from 'react';
import EditorTabs from './EditorTabs.tsx';
import ImageViewer from './ImageViewer.tsx';
import MediaViewer from './MediaViewer.tsx';
import { isAudioPath, isVideoPath } from '$lib/stores/editor';
import RichMarkdownEditor from './RichMarkdownEditor.tsx';
import { useEditorStore } from '$lib/stores/zustand/editor';
import CodeEditor from './CodeEditor.tsx';
import './EditorPanel.css';

const EDITOR_LANGUAGES = [
  ['plaintext', 'Plain text'], ['shell', 'Bash'], ['c', 'C'], ['cpp', 'C++'],
  ['css', 'CSS'], ['diff', 'Diff'], ['go', 'Go'], ['graphql', 'GraphQL'],
  ['html', 'HTML'], ['java', 'Java'], ['javascript', 'JavaScript'], ['json', 'JSON'],
  ['kotlin', 'Kotlin'], ['markdown', 'Markdown'], ['mermaid', 'Mermaid'],
  ['powershell', 'PowerShell'], ['python', 'Python'], ['ruby', 'Ruby'],
  ['rust', 'Rust'], ['scss', 'SCSS'], ['sql', 'SQL'],
] as const;

const LANGUAGE_LABELS = new Map<string, string>([
  ...EDITOR_LANGUAGES,
  ['typescript', 'TypeScript'], ['sass', 'Sass'], ['svelte', 'Svelte'],
  ['php', 'PHP'], ['xml', 'XML'], ['yaml', 'YAML'], ['toml', 'TOML'],
  ['csharp', 'C#'], ['swift', 'Swift'],
]);

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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </svg>
  );
}

function TableOfContentsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

const MARKDOWN_TOC_KEY = 'spacron.richMarkdown.tocOpen';

function initialMarkdownTocOpen() {
  try {
    return localStorage.getItem(MARKDOWN_TOC_KEY) !== '0';
  } catch {
    return true;
  }
}

export default function EditorPanel() {
  const files = useEditorStore((s) => s.openFiles);
  const active = useEditorStore((s) => s.activeFile);
  const cache = useEditorStore((s) => s.fileCache);
  const markdownCodeModePaths = useEditorStore((s) => s.markdownCodeModePaths);
  const setMarkdownPreview = useEditorStore((s) => s.setMarkdownPreview);
  const setFileLanguage = useEditorStore((s) => s.setFileLanguage);
  const [markdownTocOpen, setMarkdownTocOpen] = useState(initialMarkdownTocOpen);

  const file = active ? cache.get(active) : null;
  const canPreviewMarkdown = file?.kind === 'text' && file?.language === 'markdown';
  const canPreviewHtml = file?.kind === 'text' && (file.language === 'html' || /\.(html?|htm)$/i.test(file.path));
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
    [file?.path, file?.content, file?.language],
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
        <div className="editor-toolbar-actions">
          {canPreviewMarkdown && (
            <>
              {showMarkdownPreview && (
                <button
                  className={`markdown-toc-toggle${markdownTocOpen ? ' active' : ''}`}
                  onClick={() => {
                    const next = !markdownTocOpen;
                    setMarkdownTocOpen(next);
                    try { localStorage.setItem(MARKDOWN_TOC_KEY, next ? '1' : '0'); } catch { /* optional preference */ }
                  }}
                  title={markdownTocOpen ? 'Hide table of contents' : 'Show table of contents'}
                  aria-label={markdownTocOpen ? 'Hide table of contents' : 'Show table of contents'}
                  aria-pressed={markdownTocOpen}
                >
                  <TableOfContentsIcon />
                </button>
              )}
              <button
                className={`markdown-toggle-btn${showMarkdownPreview ? ' active' : ''}`}
                onClick={() => active && setMarkdownPreview(active, !showMarkdownPreview)}
                title={showMarkdownPreview ? 'Edit the Markdown source' : 'Edit as formatted text'}
                aria-label={showMarkdownPreview ? 'Edit the Markdown source' : 'Edit as formatted text'}
              >
                {showMarkdownPreview ? <CodeIcon /> : <PencilIcon />}
                <span>{showMarkdownPreview ? 'Source' : 'Rich editor'}</span>
              </button>
            </>
          )}
          {canPreviewHtml && (
            <button
              type="button"
              className="html-preview-btn"
              onClick={() => {
                void import('$lib/stores/preview').then(({ previewLocalFile }) => {
                  previewLocalFile(file.path);
                });
              }}
              title="Open preview in Preview tab"
              aria-label="Open preview in Preview tab"
            >
              <EyeIcon />
              <span>Preview</span>
            </button>
          )}
          {file.kind === 'text' && !canPreviewMarkdown && (
            <select
              className="editor-language-select"
              value={file.language}
              onChange={(event) => setFileLanguage(file.path, event.target.value)}
              aria-label="Editor language"
              title="Choose syntax highlighting language"
            >
              {!LANGUAGE_LABELS.has(file.language) && <option value={file.language}>{file.language}</option>}
              {EDITOR_LANGUAGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              {[...LANGUAGE_LABELS.entries()]
                .filter(([id]) => !EDITOR_LANGUAGES.some(([choice]) => choice === id))
                .map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="editor-workspace-area">
        {file.kind === 'image' && file.imageSrc ? (
          <ImageViewer src={file.imageSrc} path={file.path} mimeType={file.mimeType} size={file.size} />
        ) : file.kind === 'audio' || file.kind === 'video' || isVideoPath(file.path) || isAudioPath(file.path) ? (
          // Decided by the file name too, so a media tab never lands in the text
          // editor; the viewer finds its own source when the entry has none.
          <MediaViewer
            kind={file.kind === 'audio' || file.kind === 'video' ? file.kind : isVideoPath(file.path) ? 'video' : 'audio'}
            src={file.imageSrc ?? null}
            path={file.path}
            mimeType={file.mimeType}
            size={file.size}
          />
        ) : file.language === 'markdown' && showMarkdownPreview ? (
          <RichMarkdownEditor
            key={file.path}
            filePath={file.path}
            content={file.content}
            tocOpen={markdownTocOpen}
            onTocOpenChange={(next) => {
              setMarkdownTocOpen(next);
              try { localStorage.setItem(MARKDOWN_TOC_KEY, next ? '1' : '0'); } catch { /* optional preference */ }
            }}
          />
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
