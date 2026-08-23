import { useEditorStore } from '$lib/stores/zustand/editor';
import { clampHorizontalScroll } from '$lib/actions/clampHorizontalScroll';
import { useAction } from '$lib/react/useAction';
import './EditorTabs.css';

const LANG_COLORS: Record<string, string> = {
  image: '#b78cf0',
  javascript: '#f0db4f',
  typescript: '#3178c6',
  html: '#e34f26',
  css: '#519aba',
  scss: '#cd6799',
  sass: '#cd6799',
  rust: '#dea584',
  json: '#cbcb41',
  markdown: '#519aba',
  python: '#ffd43b',
  java: '#e76f00',
  cpp: '#5e97d0',
  csharp: '#a074c4',
  svelte: '#ff3e00',
  toml: '#b8845f',
  php: '#8993be',
  sql: '#e38c00',
  xml: '#e37933',
  yaml: '#cb171e',
  go: '#00add8',
  swift: '#f05138',
  kotlin: '#a97bff',
  shell: '#89e051',
};

function getLanguageColor(language: string | undefined, kind: string): string {
  if (kind === 'image') return LANG_COLORS.image;
  return LANG_COLORS[language ?? ''] ?? 'var(--text-muted)';
}

function TabIcon({ language, kind }: { language?: string; kind: string }) {
  const color = getLanguageColor(language, kind);
  if (kind === 'image') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="tab-icon-svg" style={{ color }}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="tab-icon-svg" style={{ color }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export default function EditorTabs() {
  const setActiveFile = useEditorStore((s) => s.setActiveFile);
  const closeFile = useEditorStore((s) => s.closeFile);
  const files = useEditorStore((s) => s.openFiles);
  const active = useEditorStore((s) => s.activeFile);
  const cache = useEditorStore((s) => s.fileCache);
  const tabsRef = useAction<HTMLDivElement>(clampHorizontalScroll);

  function handleTabClick(path: string) {
    setActiveFile(path);
  }

  function handleCloseClick(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    closeFile(path);
  }

  return (
    <div className="editor-tabs" ref={tabsRef}>
      {files.map((file) => {
        const fileState = cache.get(file);
        if (!fileState) return null;
        return (
          <button
            key={file}
            className={`editor-tab${active === file ? ' active' : ''}${fileState.isDirty ? ' dirty' : ''}`}
            onClick={() => handleTabClick(file)}
            title={file}
          >
            <TabIcon language={fileState.language} kind={fileState.kind} />
            <span className="tab-label">{getFileName(file)}</span>
            {fileState.isDirty && <span className="tab-dirty-indicator"></span>}
            <span
              className="tab-close-btn"
              onClick={(e) => handleCloseClick(e, file)}
              role="button"
              tabIndex={0}
              aria-label="Close tab"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </span>
          </button>
        );
      })}
    </div>
  );
}
