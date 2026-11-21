import { useState } from 'react';
import type { WorkItemFile } from '$lib/services/work-items';
import {
  ColumnsIcon,
  RowsIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from './TasksIcons';

interface SplitRow {
  type: 'hunk' | 'line';
  hunkHeader?: string;
  left?: {
    lineNo: number | null;
    content: string;
    isDel: boolean;
  };
  right?: {
    lineNo: number | null;
    content: string;
    isAdd: boolean;
  };
}

function parseUnifiedPatch(patch: string): SplitRow[] {
  const lines = patch.split('\n');
  const rows: SplitRow[] = [];

  let oldLine = 1;
  let newLine = 1;

  let pendingDels: { lineNo: number; content: string }[] = [];
  let pendingAdds: { lineNo: number; content: string }[] = [];

  const flushPending = () => {
    const maxLen = Math.max(pendingDels.length, pendingAdds.length);
    for (let i = 0; i < maxLen; i++) {
      const del = pendingDels[i];
      const add = pendingAdds[i];
      rows.push({
        type: 'line',
        left: del ? { lineNo: del.lineNo, content: del.content, isDel: true } : undefined,
        right: add ? { lineNo: add.lineNo, content: add.content, isAdd: true } : undefined,
      });
    }
    pendingDels = [];
    pendingAdds = [];
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flushPending();
      // Extract starting lines from @@ -a,b +c,d @@
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      rows.push({ type: 'hunk', hunkHeader: line });
    } else if (line.startsWith('-')) {
      pendingDels.push({ lineNo: oldLine, content: line.slice(1) });
      oldLine++;
    } else if (line.startsWith('+')) {
      pendingAdds.push({ lineNo: newLine, content: line.slice(1) });
      newLine++;
    } else {
      flushPending();
      const content = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({
        type: 'line',
        left: { lineNo: oldLine, content, isDel: false },
        right: { lineNo: newLine, content, isAdd: false },
      });
      oldLine++;
      newLine++;
    }
  }

  flushPending();
  return rows;
}

export default function TasksDiffViewer({
  files,
  onClose,
}: {
  files: WorkItemFile[];
  onClose?: () => void;
}) {
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  const toggleFile = (filename: string) => {
    setCollapsedFiles((prev) => ({
      ...prev,
      [filename]: !prev[filename],
    }));
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    files.forEach((f) => (next[f.filename] = true));
    setCollapsedFiles(next);
  };

  const expandAll = () => {
    setCollapsedFiles({});
  };

  const totalAdditions = files.reduce((acc, f) => acc + f.additions, 0);
  const totalDeletions = files.reduce((acc, f) => acc + f.deletions, 0);

  return (
    <div className="diff-files-layout">
      {/* Diff Controls Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 12px',
          background: 'var(--app-surface)',
          borderRadius: 8,
          border: '1px solid var(--border, rgba(127, 127, 127, 0.15))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
            Files Changed ({files.length})
          </span>
          <span className="diff-stats-pill">
            <span className="diff-additions">+{totalAdditions}</span>
            <span className="diff-deletions">-{totalDeletions}</span>
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Collapse / Expand all */}
          <button
            type="button"
            className="tasks-action-btn"
            style={{ fontSize: 10.5, padding: '3px 8px' }}
            onClick={Object.keys(collapsedFiles).length === files.length ? expandAll : collapseAll}
          >
            {Object.keys(collapsedFiles).length === files.length ? 'Expand All' : 'Collapse All'}
          </button>

          {/* Mode Switcher: Unified vs Split */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--bg-tertiary, color-mix(in srgb, var(--text-primary) 6%, transparent))',
              border: '1px solid var(--border, rgba(127, 127, 127, 0.15))',
              borderRadius: 6,
              padding: 2,
            }}
          >
            <button
              type="button"
              className={`tasks-action-btn ${viewMode === 'unified' ? 'primary' : ''}`}
              style={{
                border: 'none',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 10.5,
              }}
              onClick={() => setViewMode('unified')}
              title="Unified (up-and-down lines)"
            >
              <RowsIcon size={12} />
              <span>Unified</span>
            </button>
            <button
              type="button"
              className={`tasks-action-btn ${viewMode === 'split' ? 'primary' : ''}`}
              style={{
                border: 'none',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 10.5,
              }}
              onClick={() => setViewMode('split')}
              title="Split (side-by-side view)"
            >
              <ColumnsIcon size={12} />
              <span>Split</span>
            </button>
          </div>

          {onClose && (
            <button
              type="button"
              className="tasks-action-btn"
              onClick={onClose}
              title="Close diff view"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* List of File Diffs */}
      {files.map((file) => {
        const isCollapsed = !!collapsedFiles[file.filename];
        return (
          <div key={file.filename} className="diff-file-card">
            {/* Header: Click to collapse / expand */}
            <div
              className="diff-file-header"
              onClick={() => toggleFile(file.filename)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
              title="Click to toggle file diff"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isCollapsed ? <ChevronRightIcon size={13} /> : <ChevronDownIcon size={13} />}
                <span className="diff-filename">{file.filename}</span>
              </div>
              <span className="diff-stats-pill">
                <span className="diff-additions">+{file.additions}</span>
                <span className="diff-deletions">-{file.deletions}</span>
              </span>
            </div>

            {/* Content when expanded */}
            {!isCollapsed && (
              <>
                {file.patch ? (
                  viewMode === 'unified' ? (
                    /* Unified (up-and-down) view */
                    <pre className="diff-patch-pre">
                      {file.patch.split('\n').map((line, idx) => {
                        const isAdd = line.startsWith('+');
                        const isDel = line.startsWith('-');
                        const isHunk = line.startsWith('@@');
                        const cls = isAdd
                          ? 'diff-line-add'
                          : isDel
                          ? 'diff-line-del'
                          : isHunk
                          ? 'diff-line-hunk'
                          : '';
                        return (
                          <span key={idx} className={cls}>
                            {line}
                          </span>
                        );
                      })}
                    </pre>
                  ) : (
                    /* Side-by-Side (Split) view */
                    <div className="diff-split-table">
                      {parseUnifiedPatch(file.patch).map((row, rIdx) => {
                        if (row.type === 'hunk') {
                          return (
                            <div key={rIdx} className="diff-split-hunk-row">
                              {row.hunkHeader}
                            </div>
                          );
                        }

                        return (
                          <div key={rIdx} className="diff-split-row">
                            {/* Left: Original / Deletions */}
                            <div
                              className={`diff-split-col ${
                                row.left?.isDel ? 'diff-line-del' : ''
                              }`}
                            >
                              <span className="diff-line-no">
                                {row.left?.lineNo ?? ''}
                              </span>
                              <span className="diff-line-code">
                                {row.left ? (row.left.isDel ? '- ' : '  ') + row.left.content : ''}
                              </span>
                            </div>

                            {/* Right: Modified / Additions */}
                            <div
                              className={`diff-split-col ${
                                row.right?.isAdd ? 'diff-line-add' : ''
                              }`}
                            >
                              <span className="diff-line-no">
                                {row.right?.lineNo ?? ''}
                              </span>
                              <span className="diff-line-code">
                                {row.right ? (row.right.isAdd ? '+ ' : '  ') + row.right.content : ''}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : (
                  <p style={{ padding: 12, margin: 0, color: 'var(--text-muted)', fontSize: 11 }}>
                    Binary or large file changed without inline diff preview.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
