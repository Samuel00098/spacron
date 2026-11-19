/**
 * Code Review — the unified right-sidebar review utility.
 *
 * Master-detail in one panel: the changed-file list on the left, the selected
 * file's diff filling the rest. It used to be two components — this one showing
 * only the diff, and a `ReviewSidebarPanel` in the left drawer showing the list
 * *and* its own copy of the diff. They duplicated `parseDiff`, `makeSplitRows`,
 * both diff tables and ~550 lines of CSS between them, disagreed on syntax
 * highlighting, and rendered the same diff twice when both were open. A
 * The responsive layout keeps the changed-file list and diff usable at the
 * sidebar width. Source Control's inline `HunkDiffView` remains a different
 * job (reviewing a single hunk while you commit).
 */
import { useEffect, useRef, useState, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { activeProjectId, activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { openFile } from '$lib/stores/editor';
import { useStore } from '$lib/react/useStore';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import { useProjectPanelState } from '$lib/react/useProjectPanelState';
import './ReviewPanel.css';

interface ChangedFile {
  path: string;
  name: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  additions: number;
  deletions: number;
}

const STATUS_LABELS: Record<ChangedFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
};

function getFilename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}

interface DiffLine {
  type: 'header' | 'hunk-header' | 'addition' | 'deletion' | 'normal';
  text: string;
  marker: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

interface Token {
  type: string;
  text: string;
}

interface SplitRow {
  type: 'hunk-header' | 'split-line';
  hunkText?: string;
  left?: { type: 'deletion' | 'normal' | 'empty'; lineNum: number | null; text: string };
  right?: { type: 'addition' | 'normal' | 'empty'; lineNum: number | null; text: string };
}

function parseDiff(diffText: string): DiffLine[] {
  if (!diffText) return [];
  const lines = diffText.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let oldLineNum = 1;
  let newLineNum = 1;
  const parsed: DiffLine[] = [];

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename ') ||
      line.startsWith('copy ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      parsed.push({ type: 'header', text: line, marker: ' ', oldLineNum: null, newLineNum: null });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m) { oldLineNum = parseInt(m[1], 10); newLineNum = parseInt(m[2], 10); }
      parsed.push({ type: 'hunk-header', text: line, marker: ' ', oldLineNum: null, newLineNum: null });
      continue;
    }
    if (line.startsWith('+')) {
      parsed.push({ type: 'addition', text: line.substring(1), marker: '+', oldLineNum: null, newLineNum: newLineNum++ });
      continue;
    }
    if (line.startsWith('-')) {
      parsed.push({ type: 'deletion', text: line.substring(1), marker: '-', oldLineNum: oldLineNum++, newLineNum: null });
      continue;
    }
    const text = line.startsWith(' ') ? line.substring(1) : line;
    parsed.push({ type: 'normal', text, marker: ' ', oldLineNum: oldLineNum++, newLineNum: newLineNum++ });
  }
  return parsed;
}

function tokenize(text: string, filePath: string): Token[] {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  let commentRegex = /\/\/.*|#.*/;
  if (['rs', 'js', 'ts', 'tsx', 'jsx', 'json', 'css', 'svelte'].includes(ext)) {
    commentRegex = /\/\/.*|\/\*[\s\S]*?\*\//;
  } else if (['toml', 'yaml', 'yml', 'py', 'sh'].includes(ext)) {
    commentRegex = /#.*/;
  } else if (ext === 'html') {
    commentRegex = /<!--[\s\S]*?-->/;
  }
  let keywords = /\b(break|case|catch|class|const|continue|default|else|for|function|if|import|new|return|switch|this|throw|try|while|async|await|let|export|from|type|interface|implements|extends)\b/;
  if (ext === 'rs') {
    keywords = /\b(as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|union|unsafe|use|where|while|macro_rules)\b/;
  }
  const types = /\b(String|str|Option|Result|Vec|HashMap|number|string|boolean|any|void|unknown|never|Record|Promise|ReactNode|ReactElement)\b/;
  const isHtmlSvelte = ext === 'html' || ext === 'svelte';
  const tagRule = /(<\/?[\w:\-]+)/;
  const attrRule = /\b([\w\-]+)(?=\s*=)/;
  const tokenRegex = new RegExp(
    `(${commentRegex.source})|` +
    `("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|` +
    `(\\b\\d+(?:\\.\\d+)?\\b)|` +
    (isHtmlSvelte ? `(${tagRule.source})|(${attrRule.source})|` : '') +
    `(${keywords.source})|` +
    `(${types.source})|` +
    `(\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\())|` +
    `([+\\-*/%&|^!=<>~?:]+)|` +
    `([a-zA-Z_][a-zA-Z0-9_]*)|` +
    `(\\s+)|` +
    `(.)`,
    'g'
  );
  const tokens: Token[] = [];
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match[1]) tokens.push({ type: 'comment', text: match[1] });
    else if (match[2]) tokens.push({ type: 'string', text: match[2] });
    else if (match[3]) tokens.push({ type: 'number', text: match[3] });
    else {
      let idx = 4;
      if (isHtmlSvelte) {
        if (match[idx]) { tokens.push({ type: 'tag', text: match[idx] }); continue; }
        idx++;
        if (match[idx]) { tokens.push({ type: 'attribute', text: match[idx] }); continue; }
        idx++;
      }
      if (match[idx]) tokens.push({ type: 'keyword', text: match[idx] });
      else if (match[idx + 1]) tokens.push({ type: 'type', text: match[idx + 1] });
      else if (match[idx + 2]) tokens.push({ type: 'function', text: match[idx + 2] });
      else if (match[idx + 3]) tokens.push({ type: 'operator', text: match[idx + 3] });
      else if (match[idx + 4]) tokens.push({ type: 'variable', text: match[idx + 4] });
      else if (match[idx + 5]) tokens.push({ type: 'text', text: match[idx + 5] });
      else if (match[idx + 6]) tokens.push({ type: 'text', text: match[idx + 6] });
    }
  }
  return tokens;
}

function makeSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let pendingDels: DiffLine[] = [];
  let pendingAdds: DiffLine[] = [];

  const flush = () => {
    const maxLen = Math.max(pendingDels.length, pendingAdds.length);
    for (let i = 0; i < maxLen; i++) {
      const del = pendingDels[i];
      const add = pendingAdds[i];
      rows.push({
        type: 'split-line',
        left: del ? { type: 'deletion', lineNum: del.oldLineNum, text: del.text } : { type: 'empty', lineNum: null, text: '' },
        right: add ? { type: 'addition', lineNum: add.newLineNum, text: add.text } : { type: 'empty', lineNum: null, text: '' },
      });
    }
    pendingDels = [];
    pendingAdds = [];
  };

  for (const line of lines) {
    if (line.type === 'header') continue;
    if (line.type === 'hunk-header') {
      flush();
      rows.push({ type: 'hunk-header', hunkText: line.text });
      continue;
    }
    if (line.type === 'deletion') pendingDels.push(line);
    else if (line.type === 'addition') pendingAdds.push(line);
    else if (line.type === 'normal') {
      flush();
      rows.push({
        type: 'split-line',
        left: { type: 'normal', lineNum: line.oldLineNum, text: line.text },
        right: { type: 'normal', lineNum: line.newLineNum, text: line.text },
      });
    }
  }
  flush();
  return rows;
}

export default function ReviewPanel() {
  const projectId = useStore(activeProjectId);
  const project = useStore(activeProject);
  const [selectedFilePath, setSelectedFilePath] = useProjectPanelState<string | null>('review.selectedFile', null);

  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Changed-file list — migrated in from the deleted sidebar panel.
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [branch, setBranch] = useState<string>('');
  const [totalAdditions, setTotalAdditions] = useState<number>(0);
  const [totalDeletions, setTotalDeletions] = useState<number>(0);
  const [isFetching, setIsFetching] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [diffMode, setDiffMode] = useState<'inline' | 'split'>(() => {
    const saved = localStorage.getItem('spacron_diff_mode');
    return saved === 'split' ? 'split' : 'inline';
  });

  useEffect(() => { localStorage.setItem('spacron_diff_mode', diffMode); }, [diffMode]);

  // Shares the `spacron_diff_wrap` key with ReviewSidebarPanel: the two are the
  // same diff in two presentations, so the preference should not fork. On by
  // default; `!== '0'` so only an explicit opt-out turns it off.
  const [wrapLines, setWrapLines] = useState<boolean>(
    () => localStorage.getItem('spacron_diff_wrap') !== '0',
  );
  useEffect(() => { localStorage.setItem('spacron_diff_wrap', wrapLines ? '1' : '0'); }, [wrapLines]);

  const handleNativeWheel = useCallback((e: WheelEvent) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      const body = (e.currentTarget as HTMLElement).closest('.review-body');
      if (body) (body as HTMLElement).scrollTop += e.deltaY;
    }
  }, []);

  // The listener has to be attached by hand rather than through onWheel: React's
  // synthetic wheel handler is passive, so it cannot `preventDefault`.
  //
  // Returning the detach is what keeps it symmetric. React 19 calls a ref
  // callback's returned cleanup when the node goes away or the callback's
  // identity changes; without one, a re-attach would stack a second listener on
  // a reused node and scroll the diff twice per notch.
  const cardBodyRef = useCallback(
    (node: HTMLDivElement) => {
      node.addEventListener('wheel', handleNativeWheel, { passive: false });
      return () => node.removeEventListener('wheel', handleNativeWheel);
    },
    [handleNativeWheel],
  );

  const genRef = useRef(0);
  const projectIdRef = useRef<string | null>(projectId);
  projectIdRef.current = projectId;
  const listGenRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid) return;
    const gen = ++listGenRef.current;
    setIsFetching(true);
    setListError(null);
    try {
      const status = await invoke<{
        branch: string;
        modified: string[];
        added: string[];
        deleted: string[];
        untracked: string[];
        file_stats: Record<string, [number, number]>;
        total_additions: number;
        total_deletions: number;
      }>('workspace_git_status', { projectId: pid });

      if (gen !== listGenRef.current) return;

      setBranch(status.branch);
      setTotalAdditions(status.total_additions);
      setTotalDeletions(status.total_deletions);

      const getStats = (path: string): [number, number] => status.file_stats[path] || [0, 0];
      const list: ChangedFile[] = [];
      const push = (paths: string[], fileStatus: ChangedFile['status']) => {
        for (const path of paths) {
          const [additions, deletions] = getStats(path);
          list.push({ path, name: getFilename(path), status: fileStatus, additions, deletions });
        }
      };
      push(status.modified, 'modified');
      push(status.added, 'added');
      push(status.deleted, 'deleted');
      push(status.untracked, 'untracked');

      setFiles(list);
    } catch (err) {
      if (gen !== listGenRef.current) return;
      setListError(String(err));
      setFiles([]);
    } finally {
      if (gen === listGenRef.current) setIsFetching(false);
    }
  }, []);

  useEffect(() => {
    setFiles([]);
    setBranch('');
    setTotalAdditions(0);
    setTotalDeletions(0);
    setListError(null);
    if (projectId) void fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function selectFile(filePath: string) {
    setSelectedFilePath(selectedFilePath === filePath ? null : filePath);
  }

  async function openFileInEditor(path: string, event: ReactMouseEvent) {
    event.stopPropagation();
    if (!project) return;
    await openFile(`${project.root_path}/${path}`);
  }

  async function discardFile(file: ChangedFile, event: ReactMouseEvent) {
    event.stopPropagation();
    const pid = projectIdRef.current;
    if (!pid) return;
    if (!confirm(`Discard all changes to ${file.path}? This cannot be undone.`)) return;
    try {
      await invoke('workspace_git_discard_file', { projectId: pid, filePath: file.path });
      showToast(`Discarded changes for ${file.name}`, 'success');
      if (selectedFilePath === file.path) setSelectedFilePath(null);
      await fetchStatus();
    } catch (err) {
      showToast(`Failed to discard changes: ${err}`, 'error');
    }
  }

  // Fetch the diff whenever the selected file or project changes
  useEffect(() => {
    const pid = projectIdRef.current;
    if (!selectedFilePath || !pid) {
      setFileDiff(null);
      setErrorMsg(null);
      return;
    }
    const gen = ++genRef.current;
    setIsLoadingDiff(true);
    setErrorMsg(null);
    setFileDiff(null);
    invoke<string>('workspace_git_diff', { projectId: pid, filePath: selectedFilePath })
      .then((diff) => { if (gen === genRef.current) setFileDiff(diff); })
      .catch((err) => { if (gen === genRef.current) setErrorMsg(String(err)); })
      .finally(() => { if (gen === genRef.current) setIsLoadingDiff(false); });
  }, [selectedFilePath, projectId]);

  const parsed = fileDiff ? parseDiff(fileDiff) : null;
  const hasHunkHeader = parsed ? parsed.some((l) => l.type === 'hunk-header') : false;
  const filePath = selectedFilePath ?? '';
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  const diffStats = useMemo(() => {
    if (!parsed) return { additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;
    for (const line of parsed) {
      if (line.type === 'addition') additions++;
      else if (line.type === 'deletion') deletions++;
    }
    return { additions, deletions };
  }, [parsed]);

  return (
    <div className="review-panel">
      {/* Header — always identifies the panel, then the branch it is reviewing. */}
      <div className="sc-header rp-header">
        <div className="rp-header-left">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="rp-header-icon">
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" />
            <path d="M11 18H8a2 2 0 0 1-2-2V9" />
          </svg>
          <span className="sc-title rp-panel-title">Diff</span>
          {branch && (
            <span className="rp-branch" title="Branch being reviewed">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {branch}
            </span>
          )}
          {files.length > 0 && (
            <span className="rp-file-count">{files.length} file{files.length === 1 ? '' : 's'}</span>
          )}
          {(totalAdditions > 0 || totalDeletions > 0) && (
            <span className="diff-stats">
              <span className="stat-add">+{totalAdditions}</span>
              <span className="stat-del">-{totalDeletions}</span>
            </span>
          )}
        </div>

        <div className="rp-header-right">
          <div className="diff-mode-toggle">
            <button className={`toggle-btn ${diffMode === 'inline' ? 'active' : ''}`} onClick={() => setDiffMode('inline')} title="Inline diff">Inline</button>
            <button className={`toggle-btn ${diffMode === 'split' ? 'active' : ''}`} onClick={() => setDiffMode('split')} title="Split diff">Split</button>
          </div>

          <button
            className={`toolbar-btn icon-only${wrapLines ? ' wrap-active' : ''}`}
            style={{ flexShrink: 0 }}
            onClick={() => setWrapLines((on) => !on)}
            aria-pressed={wrapLines}
            title={wrapLines ? 'Wrapping long lines to the panel. Click to scroll instead.' : 'Wrap long lines to the panel width instead of scrolling sideways'}
            aria-label="Wrap long lines"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M3 12h15a3 3 0 0 1 0 6h-4" />
              <polyline points="16 15 13 18 16 21" />
              <line x1="3" y1="18" x2="8" y2="18" />
            </svg>
          </button>

          <button
            className={`toolbar-btn icon-only${isFetching ? ' spin' : ''}`}
            onClick={() => void fetchStatus()}
            disabled={isFetching || !projectId}
            title="Refresh the changed-file list"
            aria-label="Refresh"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <polyline points="21 3 21 8 16 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Master-detail: file list left, the selected file's diff filling the rest. */}
      <div className="rp-split">
        <aside className="rp-files" aria-label="Changed files">
          {listError ? (
            <div className="rp-files-empty">
              <span>{listError}</span>
              <button className="btn-retry" onClick={() => void fetchStatus()}>Retry</button>
            </div>
          ) : !projectId ? (
            <div className="rp-files-empty"><span>Open a project to review changes.</span></div>
          ) : files.length === 0 && !isFetching ? (
            <div className="rp-files-empty">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>Working tree is clean.</span>
            </div>
          ) : (
            files.map((file) => (
              <button
                key={file.path}
                className={`rp-file-row${selectedFilePath === file.path ? ' selected' : ''}`}
                onClick={() => selectFile(file.path)}
                title={file.path}
              >
                <span className={`rp-status-badge rp-status-${file.status}`}>{STATUS_LABELS[file.status]}</span>
                <FileIcon name={file.name} isDir={false} />
                <span className="rp-file-name">{file.path}</span>
                {(file.additions > 0 || file.deletions > 0) && (
                  <span className="rp-file-stats">
                    <span className="stat-add">+{file.additions}</span>
                    <span className="stat-del">-{file.deletions}</span>
                  </span>
                )}
                <span className="rp-row-actions">
                  <span
                    className="rp-icon-btn"
                    role="button"
                    tabIndex={-1}
                    title="Open in editor"
                    onClick={(event) => void openFileInEditor(file.path, event)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </span>
                  <span
                    className="rp-icon-btn rp-discard-btn"
                    role="button"
                    tabIndex={-1}
                    title="Discard changes"
                    onClick={(event) => void discardFile(file, event)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <polyline points="3 3 3 8 8 8" />
                    </svg>
                  </span>
                </span>
              </button>
            ))
          )}
        </aside>

        <div className="review-body rp-detail">
        {selectedFilePath && (
          <div className="rp-detail-head">
            <FileIcon name={fileName} isDir={false} />
            <span className="rp-detail-path" title={selectedFilePath}>{selectedFilePath}</span>
            {diffStats.additions + diffStats.deletions > 0 && (
              <span className="diff-stats">
                <span className="stat-add">+{diffStats.additions}</span>
                <span className="stat-del">-{diffStats.deletions}</span>
              </span>
            )}
          </div>
        )}
        {!selectedFilePath ? (
          <div className="sc-clean">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="15" y2="17" />
            </svg>
            <p>Pick a file on the left to see its diff.</p>
          </div>
        ) : errorMsg ? (
          <div className="sc-error">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p>{errorMsg}</p>
          </div>
        ) : isLoadingDiff ? (
          <div className="sc-clean">
            <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <polyline points="21 3 21 8 16 8" />
            </svg>
            <p>Loading diff…</p>
          </div>
        ) : !fileDiff ? (
          <div className="sc-clean">
            <p>No changes found.</p>
          </div>
        ) : (
          <div className="files-list-container">
            <div className="file-card expanded">
              <div className="file-card-body" ref={cardBodyRef}>
                {diffMode === 'split' ? (
                  <table className={`diff-table split-diff${wrapLines ? ' wrap' : ''}`}>
                    {/* Widths live in CSS, not inline styles, so the container
                        queries in ReviewPanel.css can shrink the line-number
                        gutters when the pane is narrow. */}
                    <colgroup>
                      <col className="col-ln" />
                      <col className="col-code" />
                      <col className="col-ln" />
                      <col className="col-code" />
                    </colgroup>
                    <tbody>
                      {makeSplitRows(parsed!).map((row, idx) => {
                        if (row.type === 'hunk-header') {
                          return (
                            <tr key={`hunk-${idx}`} className="hunk-header-tr">
                              <td colSpan={4} className="hunk-decor-cell">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 4 }}>
                                  <polyline points="18 15 12 9 6 15" />
                                </svg>
                                <span>{row.hunkText}</span>
                              </td>
                            </tr>
                          );
                        }
                        const left = row.left!;
                        const right = row.right!;
                        return (
                          <tr key={idx} className="diff-tr split-tr">
                            <td className={`ln left-ln ${left.type}-ln`}>{left.lineNum ?? ''}</td>
                            <td className={`code-cell left-code ${left.type}-code`}>
                              {left.type !== 'empty' && tokenize(left.text, filePath).map((t, ti) =>
                                t.type === 'text' ? t.text : <span key={ti} className={`token-${t.type}`} style={{ color: `var(--syntax-${t.type}, inherit)` }}>{t.text}</span>
                              )}
                            </td>
                            <td className={`ln right-ln ${right.type}-ln`}>{right.lineNum ?? ''}</td>
                            <td className={`code-cell right-code ${right.type}-code`}>
                              {right.type !== 'empty' && tokenize(right.text, filePath).map((t, ti) =>
                                t.type === 'text' ? t.text : <span key={ti} className={`token-${t.type}`} style={{ color: `var(--syntax-${t.type}, inherit)` }}>{t.text}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {hasHunkHeader && (
                        <tr className="hunk-header-tr">
                          <td colSpan={4} className="hunk-decor-cell hunk-decor-end">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                ) : (
                  <table className={`diff-table inline-diff${wrapLines ? ' wrap' : ''}`}>
                    <colgroup>
                      <col style={{ width: '40px' }} />
                      <col style={{ width: '40px' }} />
                      <col style={{ width: '24px' }} />
                      <col />
                    </colgroup>
                    <tbody>
                      {parsed!.map((line, idx) => {
                        if (line.type === 'header') return null;
                        if (line.type === 'hunk-header') {
                          return (
                            <tr key={`hunk-${idx}`} className="hunk-header-tr">
                              <td colSpan={4} className="hunk-decor-cell">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 4 }}>
                                  <polyline points="18 15 12 9 6 15" />
                                </svg>
                                <span>{line.text}</span>
                              </td>
                            </tr>
                          );
                        }
                        return (
                          <tr key={idx} className={`diff-tr ${line.type}`}>
                            <td className="ln old-ln">{line.oldLineNum ?? ''}</td>
                            <td className="ln new-ln">{line.newLineNum ?? ''}</td>
                            <td className={`marker-cell ${line.type}`}>
                              {line.marker !== ' ' ? line.marker : ''}
                            </td>
                            <td className="code-cell">
                              {tokenize(line.text, filePath).map((t, ti) =>
                                t.type === 'text' ? t.text : <span key={ti} className={`token-${t.type}`} style={{ color: `var(--syntax-${t.type}, inherit)` }}>{t.text}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {hasHunkHeader && (
                        <tr className="hunk-header-tr">
                          <td colSpan={4} className="hunk-decor-cell hunk-decor-end">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
