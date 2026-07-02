import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { activeProjectId } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import { reviewSelectedFile } from '$lib/stores/reviewSelectedFile';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';
import './ReviewPanel.css';

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
  const selectedFilePath = useStore(reviewSelectedFile);

  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [diffMode, setDiffMode] = useState<'inline' | 'split'>(() => {
    const saved = localStorage.getItem('spacron_diff_mode');
    return saved === 'split' ? 'split' : 'inline';
  });

  useEffect(() => { localStorage.setItem('spacron_diff_mode', diffMode); }, [diffMode]);

  const handleNativeWheel = useCallback((e: WheelEvent) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      const body = (e.currentTarget as HTMLElement).closest('.review-body');
      if (body) (body as HTMLElement).scrollTop += e.deltaY;
    }
  }, []);

  const cardBodyRef = useCallback((node: HTMLDivElement | null) => {
    if (node) node.addEventListener('wheel', handleNativeWheel, { passive: false });
  }, [handleNativeWheel]);

  const genRef = useRef(0);
  const projectIdRef = useRef<string | null>(projectId);
  projectIdRef.current = projectId;

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
      {/* Header */}
      <div className="sc-header" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          {selectedFilePath ? (
            <>
              <FileIcon name={fileName} isDir={false} />
              <span className="sc-title" title={selectedFilePath} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedFilePath}
              </span>
              {diffStats.additions + diffStats.deletions > 0 && (
                <span className="diff-stats" style={{ flexShrink: 0 }}>
                  <span className="stat-add">+{diffStats.additions}</span>
                  <span className="stat-del">-{diffStats.deletions}</span>
                </span>
              )}
            </>
          ) : (
            <>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="18" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <path d="M13 6h3a2 2 0 0 1 2 2v7" />
                <path d="M11 18H8a2 2 0 0 1-2-2V9" />
              </svg>
              <span className="sc-title" style={{ color: 'var(--text-muted)' }}>Code Review</span>
            </>
          )}
        </div>

        {selectedFilePath && (
          <div className="diff-mode-toggle" style={{ flexShrink: 0 }}>
            <button className={`toggle-btn ${diffMode === 'inline' ? 'active' : ''}`} onClick={() => setDiffMode('inline')} title="Inline diff">Inline</button>
            <button className={`toggle-btn ${diffMode === 'split' ? 'active' : ''}`} onClick={() => setDiffMode('split')} title="Split diff">Split</button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="review-body">
        {!selectedFilePath ? (
          <div className="sc-clean">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="15" y2="17" />
            </svg>
            <p>Select a file from the <strong>Code Review</strong> tab to view its diff.</p>
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
                  <table className="diff-table split-diff">
                    <colgroup>
                      <col style={{ width: '40px' }} />
                      <col style={{ width: 'calc(50% - 40px)' }} />
                      <col style={{ width: '40px' }} />
                      <col style={{ width: 'calc(50% - 40px)' }} />
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
                  <table className="diff-table inline-diff">
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
  );
}
