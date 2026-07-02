import { useEffect, useRef, useCallback, useState, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { activeProjectId, activeProject } from '$lib/stores/workspace';
import { showToast } from '$lib/stores/notification';
import { openFile } from '$lib/stores/editor';
import { useStore } from '$lib/react/useStore';
import { reviewSelectedFile } from '$lib/stores/reviewSelectedFile';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import './ReviewSidebarPanel.css';

interface ChangedFile {
  path: string;
  name: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  additions: number;
  deletions: number;
}

interface DiffLine {
  type: 'header' | 'hunk-header' | 'addition' | 'deletion' | 'normal';
  text: string;
  marker: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

interface SplitRow {
  type: 'hunk-header' | 'split-line';
  hunkText?: string;
  left?: { type: 'deletion' | 'normal' | 'empty'; lineNum: number | null; text: string };
  right?: { type: 'addition' | 'normal' | 'empty'; lineNum: number | null; text: string };
}

function getFilename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}

const STATUS_LABELS: Record<ChangedFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
};

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
        left: del ? { type: 'deletion' as const, lineNum: del.oldLineNum, text: del.text } : { type: 'empty' as const, lineNum: null, text: '' },
        right: add ? { type: 'addition' as const, lineNum: add.newLineNum, text: add.text } : { type: 'empty' as const, lineNum: null, text: '' },
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

function RspInlineDiff({ diffText, filePath, diffMode }: { diffText: string; filePath: string; diffMode: 'inline' | 'split' }) {
  const parsed = useMemo(() => parseDiff(diffText), [diffText]);
  const hasHunkHeader = parsed.some((l) => l.type === 'hunk-header');

  const diffStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const line of parsed) {
      if (line.type === 'addition') additions++;
      else if (line.type === 'deletion') deletions++;
    }
    return { additions, deletions };
  }, [parsed]);

  return (
    <div className="rsp-diff-scroll">
      <div className="rsp-diff-stats-bar">
        <span className="rsp-add">+{diffStats.additions}</span>
        <span className="rsp-del">-{diffStats.deletions}</span>
      </div>
      {diffMode === 'split' ? (
        <table className="rsp-diff-table rsp-split-diff">
          <colgroup>
            <col style={{ width: '32px' }} />
            <col style={{ width: 'calc(50% - 32px)' }} />
            <col style={{ width: '32px' }} />
            <col style={{ width: 'calc(50% - 32px)' }} />
          </colgroup>
          <tbody>
            {makeSplitRows(parsed).map((row, idx) => {
              if (row.type === 'hunk-header') {
                return (
                  <tr key={`hunk-${idx}`} className="rsp-diff-hunk">
                    <td colSpan={4}>
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 3 }}>
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
                <tr key={idx} className={`rsp-diff-tr rsp-split-tr`}>
                  <td className={`rsp-ln rsp-left-ln ${left.type}-ln`}>{left.lineNum ?? ''}</td>
                  <td className={`rsp-code-cell rsp-left-code ${left.type}-code`}>
                    {left.type !== 'empty' && left.text}
                  </td>
                  <td className={`rsp-ln rsp-right-ln ${right.type}-ln`}>{right.lineNum ?? ''}</td>
                  <td className={`rsp-code-cell rsp-right-code ${right.type}-code`}>
                    {right.type !== 'empty' && right.text}
                  </td>
                </tr>
              );
            })}
            {hasHunkHeader && (
              <tr className="rsp-diff-hunk">
                <td colSpan={4}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <table className="rsp-diff-table rsp-inline-diff">
          <colgroup>
            <col style={{ width: '32px' }} />
            <col style={{ width: '32px' }} />
            <col style={{ width: '18px' }} />
            <col />
          </colgroup>
          <tbody>
            {parsed.map((line, idx) => {
              if (line.type === 'header') return null;
              if (line.type === 'hunk-header') {
                return (
                  <tr key={`hunk-${idx}`} className="rsp-diff-hunk">
                    <td colSpan={4}>
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 3 }}>
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                      <span>{line.text}</span>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={idx} className={`rsp-diff-tr ${line.type}`}>
                  <td className="rsp-ln rsp-old-ln">{line.oldLineNum ?? ''}</td>
                  <td className="rsp-ln rsp-new-ln">{line.newLineNum ?? ''}</td>
                  <td className={`rsp-marker-cell ${line.type}`}>
                    {line.marker !== ' ' ? line.marker : ''}
                  </td>
                  <td className="rsp-code-cell">{line.text}</td>
                </tr>
              );
            })}
            {hasHunkHeader && (
              <tr className="rsp-diff-hunk">
                <td colSpan={4}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ReviewSidebarPanel() {
  const projectId = useStore(activeProjectId);
  const project = useStore(activeProject);
  const selectedFile = useStore(reviewSelectedFile);

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [branch, setBranch] = useState<string>('');
  const [totalAdditions, setTotalAdditions] = useState<number>(0);
  const [totalDeletions, setTotalDeletions] = useState<number>(0);
  const [isFetching, setIsFetching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [diffMode, setDiffMode] = useState<'inline' | 'split'>(() => {
    const saved = localStorage.getItem('spacron_diff_mode');
    return saved === 'split' ? 'split' : 'inline';
  });
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const projectIdRef = useRef<string | null>(projectId);
  projectIdRef.current = projectId;
  const generationRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid) return;
    const gen = ++generationRef.current;
    setIsFetching(true);
    setErrorMsg(null);
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

      if (gen !== generationRef.current) return;

      setBranch(status.branch);
      setTotalAdditions(status.total_additions);
      setTotalDeletions(status.total_deletions);

      const list: ChangedFile[] = [];
      const getStats = (path: string): [number, number] => status.file_stats[path] || [0, 0];

      status.modified.forEach((path) => {
        const [add, del] = getStats(path);
        list.push({ path, name: getFilename(path), status: 'modified', additions: add, deletions: del });
      });
      status.added.forEach((path) => {
        const [add, del] = getStats(path);
        list.push({ path, name: getFilename(path), status: 'added', additions: add, deletions: del });
      });
      status.deleted.forEach((path) => {
        const [add, del] = getStats(path);
        list.push({ path, name: getFilename(path), status: 'deleted', additions: add, deletions: del });
      });
      status.untracked.forEach((path) => {
        const [add, del] = getStats(path);
        list.push({ path, name: getFilename(path), status: 'untracked', additions: add, deletions: del });
      });

      setFiles(list);
    } catch (err) {
      if (gen !== generationRef.current) return;
      setErrorMsg(String(err));
      setFiles([]);
    } finally {
      if (gen === generationRef.current) setIsFetching(false);
    }
  }, []);

  // Reload when project changes
  useEffect(() => {
    if (projectId) {
      setFiles([]);
      setBranch('');
      setTotalAdditions(0);
      setTotalDeletions(0);
      setErrorMsg(null);
      reviewSelectedFile.set(null);
      fetchStatus();
    } else {
      setFiles([]);
      setBranch('');
      setTotalAdditions(0);
      setTotalDeletions(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => { localStorage.setItem('spacron_diff_mode', diffMode); }, [diffMode]);

  const diffGenRef = useRef(0);

  useEffect(() => {
    const pid = projectIdRef.current;
    if (!selectedFile || !pid) {
      setFileDiff(null);
      setDiffError(null);
      return;
    }
    const gen = ++diffGenRef.current;
    setIsLoadingDiff(true);
    setDiffError(null);
    setFileDiff(null);
    invoke<string>('workspace_git_diff', { projectId: pid, filePath: selectedFile })
      .then((diff) => { if (gen === diffGenRef.current) setFileDiff(diff); })
      .catch((err) => { if (gen === diffGenRef.current) setDiffError(String(err)); })
      .finally(() => { if (gen === diffGenRef.current) setIsLoadingDiff(false); });
  }, [selectedFile, projectId]);

  function selectFile(filePath: string) {
    if (selectedFile === filePath) {
      reviewSelectedFile.set(null);
    } else {
      reviewSelectedFile.set(filePath);
    }
  }

  async function openFileInEditor(path: string, e: ReactMouseEvent) {
    e.stopPropagation();
    if (project) {
      const absPath = `${project.root_path}/${path}`;
      await openFile(absPath);
    }
  }

  async function discardFile(file: ChangedFile, e: ReactMouseEvent) {
    e.stopPropagation();
    const pid = projectIdRef.current;
    if (!pid) return;
    const confirmed = confirm(`Discard all changes to ${file.path}? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await invoke('workspace_git_discard_file', { projectId: pid, filePath: file.path });
      showToast(`Discarded changes for ${file.name}`, 'success');
      if (selectedFile === file.path) reviewSelectedFile.set(null);
      await fetchStatus();
    } catch (err) {
      showToast(`Failed to discard changes: ${err}`, 'error');
    }
  }

  return (
    <div className="rsp-root">
      {/* Header */}
      <div className="rsp-header">
        <div className="rsp-header-left">
          {branch && (
            <span className="rsp-branch" title="Current branch">
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
            <span className="rsp-file-count">{files.length} file{files.length !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="rsp-header-right">
          <div className="rsp-diff-toggle">
            <button className={`rsp-toggle-btn ${diffMode === 'inline' ? 'active' : ''}`} onClick={() => setDiffMode('inline')} title="Inline diff">Inline</button>
            <button className={`rsp-toggle-btn ${diffMode === 'split' ? 'active' : ''}`} onClick={() => setDiffMode('split')} title="Split diff">Split</button>
          </div>
          {(totalAdditions > 0 || totalDeletions > 0) && (
            <span className="rsp-stats">
              <span className="rsp-add">+{totalAdditions}</span>
              <span className="rsp-del">-{totalDeletions}</span>
            </span>
          )}
          <button
            className={`rsp-refresh-btn${isFetching ? ' spinning' : ''}`}
            onClick={fetchStatus}
            disabled={isFetching}
            title="Refresh"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="rsp-body">
        {errorMsg ? (
          <div className="rsp-empty">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{errorMsg}</span>
            <button className="rsp-retry" onClick={fetchStatus}>Retry</button>
          </div>
        ) : !projectId ? (
          <div className="rsp-empty">
            <span>Open a project to review changes.</span>
          </div>
        ) : files.length === 0 && !isFetching ? (
          <div className="rsp-empty rsp-clean">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>Working tree is clean.</span>
          </div>
        ) : (
          <div className="rsp-file-list">
            {files.map((file) => {
              const isSelected = selectedFile === file.path;
              return (
                <div key={file.path} className="rsp-file-entry">
                  <button
                    className={`rsp-file-row${isSelected ? ' selected' : ''}`}
                    onClick={() => selectFile(file.path)}
                    title={file.path}
                  >
                    <span className={`rsp-status-badge rsp-status-${file.status}`}>
                      {STATUS_LABELS[file.status]}
                    </span>
                    <FileIcon name={file.name} isDir={false} />
                    <span className="rsp-file-name">{file.path}</span>
                    {(file.additions > 0 || file.deletions > 0) && (
                      <span className="rsp-file-stats">
                        <span className="rsp-add">+{file.additions}</span>
                        <span className="rsp-del">-{file.deletions}</span>
                      </span>
                    )}
                    <span className="rsp-row-actions">
                      <span
                        className="rsp-icon-btn"
                        role="button"
                        tabIndex={-1}
                        title="Open in editor"
                        onClick={(e) => void openFileInEditor(file.path, e)}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </span>
                      <span
                        className="rsp-icon-btn rsp-discard-btn"
                        role="button"
                        tabIndex={-1}
                        title="Discard changes"
                        onClick={(e) => void discardFile(file, e)}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <polyline points="3 3 3 8 8 8" />
                        </svg>
                      </span>
                    </span>
                  </button>
                  {isSelected && (
                    <div className="rsp-diff-wrapper">
                      {diffError ? (
                        <div className="rsp-diff-empty">
                          <span>{diffError}</span>
                        </div>
                      ) : isLoadingDiff ? (
                        <div className="rsp-diff-empty">
                          <svg className="rsp-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                            <polyline points="21 3 21 8 16 8" />
                          </svg>
                          <span>Loading diff…</span>
                        </div>
                      ) : fileDiff ? (
                        <RspInlineDiff diffText={fileDiff} filePath={file.path} diffMode={diffMode} />
                      ) : (
                        <div className="rsp-diff-empty">
                          <span>No changes found.</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
