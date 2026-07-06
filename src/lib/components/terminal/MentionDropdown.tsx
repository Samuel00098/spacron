import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listProjectFiles } from '$lib/utils/projectFiles';
import type { FileEntry } from '$lib/types/explorer';

export interface MentionDropdownProps {
  projectRoot: string;
  query: string;
  selectedIndex: number;
  onSelect: (entry: FileEntry) => void;
  onSetSelectedIndex: (index: number) => void;
  onClose: () => void;
}

export default function MentionDropdown({ projectRoot, query, selectedIndex, onSelect, onSetSelectedIndex, onClose }: MentionDropdownProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listProjectFiles(projectRoot).then((all) => {
      if (cancelled) return;
      setFiles(all);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectRoot]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return files.filter((f) => !f.is_dir).slice(0, 50);
    return files.filter((f) => !f.is_dir && f.name.toLowerCase().includes(q)).slice(0, 50);
  }, [files, query]);

  useEffect(() => {
    onSetSelectedIndex(0);
  }, [filtered.length, onSetSelectedIndex]);

  useEffect(() => {
    (listRef.current?.children[selectedIndex] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        onSetSelectedIndex(Math.min(selectedIndex + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        onSetSelectedIndex(Math.max(selectedIndex - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const entry = filtered[selectedIndex];
        if (entry) onSelect(entry);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedIndex, filtered, onSelect, onClose, onSetSelectedIndex]);

  if (!projectRoot) return null;

  return (
    <div className="mention-dropdown">
      {loading ? (
        <div className="mention-loading">Loading files…</div>
      ) : filtered.length === 0 ? (
        <div className="mention-empty">No files found</div>
      ) : (
        <div className="mention-list" ref={listRef}>
          {filtered.map((entry, i) => (
            <div
              key={entry.path}
              className={`mention-item${i === selectedIndex ? ' selected' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onSelect(entry); }}
              onMouseEnter={() => onSetSelectedIndex(i)}
            >
              <span className="mention-name">{entry.name}</span>
              <span className="mention-path">{relPath(entry.path, projectRoot)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function relPath(full: string, root: string): string {
  const r = root.replace(/\/$/, '') + '/';
  return full.startsWith(r) ? full.slice(r.length) : full;
}
