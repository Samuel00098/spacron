import { useEffect, useState, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getSessionOutputBuffer } from '$lib/stores/terminal';
import FileIcon from '$lib/components/explorer/FileIcon.tsx';

// ── git status & review selected file helpers ───────────────────────────────
import { useGitStatusCache } from '$lib/stores/zustand/gitStatus';
import { reviewSelectedFile } from '$lib/stores/reviewSelectedFile';
import { usePinnedStore } from '$lib/stores/zustand/pinned';

interface DiffLine {
  type: 'header' | 'hunk-header' | 'addition' | 'deletion' | 'normal';
  text: string;
  marker: string;
  oldLineNum: number | null;
  newLineNum: number | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// DIFF CARD
// ─────────────────────────────────────────────────────────────────────────────
interface DiffCardProps {
  projectId: string;
  agentName: string;
  initialFilePath?: string;
  onExpand: (type: 'editor', arg: string) => void;
  onApprove?: () => void;
  onTweak?: () => void;
}

export function DiffCard({ projectId, agentName, initialFilePath, onExpand, onApprove, onTweak }: DiffCardProps) {
  const gitStatus = useGitStatusCache((s) => (projectId ? s.statusByProject[projectId] ?? null : null));
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFilePath || null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const pinCard = usePinnedStore((s) => s.pinCard);
  const pinnedCards = usePinnedStore((s) => s.pinnedCards);

  // If no initial file path is provided, default to the first modified file
  useEffect(() => {
    if (!selectedFile && gitStatus) {
      const firstMod = gitStatus.modified[0] || gitStatus.added[0] || gitStatus.deleted[0] || gitStatus.untracked[0];
      if (firstMod) setSelectedFile(firstMod);
    }
  }, [gitStatus, selectedFile]);

  useEffect(() => {
    if (!selectedFile || !projectId) {
      setFileDiff(null);
      return;
    }
    setIsLoading(true);
    invoke<string>('workspace_git_diff', { projectId, filePath: selectedFile })
      .then((diff) => setFileDiff(diff))
      .catch(() => setFileDiff(null))
      .finally(() => setIsLoading(false));
  }, [selectedFile, projectId]);

  const parsed = useMemo(() => (fileDiff ? parseDiff(fileDiff) : []), [fileDiff]);
  const fileName = selectedFile?.split(/[/\\]/).pop() ?? selectedFile ?? 'file';

  const isPinned = pinnedCards.some((c) => c.id === `diff-${selectedFile}`);

  const handlePin = () => {
    if (selectedFile) {
      if (isPinned) {
        usePinnedStore.getState().unpinCard(`diff-${selectedFile}`);
      } else {
        pinCard(`diff-${selectedFile}`, 'diff', `${fileName} diff`, { projectId, filePath: selectedFile });
      }
    }
  };

  return (
    <div className="card">
      <div className="ch">
        <div className="who">
          <span className="av">{agentName[0]?.toUpperCase() || 'A'}</span>
          <span>{agentName}</span>
          <span className="tag">· edited {fileName}</span>
        </div>
        <div className="st"><span className="g">✓</span> done</div>
      </div>
      <div className="cb diff" style={{ padding: '8px 12px', background: 'var(--flow-ink)', maxHeight: '180px', overflow: 'auto', borderRadius: '6px', margin: '12px' }}>
        {isLoading ? (
          <div style={{ color: 'var(--flow-dim)', fontSize: '12px' }}>Loading diff...</div>
        ) : parsed.length === 0 ? (
          <div style={{ color: 'var(--flow-faint)', fontSize: '12px' }}>No changes or unable to load diff.</div>
        ) : (
          parsed.map((line, idx) => {
            if (line.type === 'header' || line.type === 'hunk-header') return null;
            return (
              <span key={idx} className={line.type} style={{ display: 'block', fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                {line.marker === '+' ? '+ ' : line.marker === '-' ? '- ' : '  '}
                {line.text}
              </span>
            );
          })
        )}
      </div>
      <div className="acts">
        <button className="act pri" onClick={onApprove}>✓ Approve</button>
        <button className="act" onClick={onTweak}>✎ Tweak</button>
        <button className="act" onClick={() => selectedFile && onExpand('editor', selectedFile)}>⤢ Expand to editor</button>
        <button className={`act${isPinned ? ' pinned' : ''}`} onClick={handlePin}>
          {isPinned ? '⌖ Pinned' : '⌖ Pin'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TERMINAL CARD
// ─────────────────────────────────────────────────────────────────────────────
interface TerminalCardProps {
  sessionId: number;
  agentName: string;
  command: string;
  isRunning: boolean;
  onExpand: (type: 'terminal', arg: number) => void;
}

export function TerminalCard({ sessionId, agentName, command, isRunning, onExpand }: TerminalCardProps) {
  const [output, setOutput] = useState('');
  const pinCard = usePinnedStore((s) => s.pinCard);
  const pinnedCards = usePinnedStore((s) => s.pinnedCards);

  // Poll for terminal output buffer
  useEffect(() => {
    const fetchOutput = () => {
      const buffer = getSessionOutputBuffer(sessionId);
      // Get the last 10 lines
      const lines = buffer.split('\n');
      const last10 = lines.slice(-10).join('\n');
      setOutput(last10);
    };

    fetchOutput();
    const interval = setInterval(fetchOutput, 800);
    return () => clearInterval(interval);
  }, [sessionId]);

  const isPinned = pinnedCards.some((c) => c.id === `term-${sessionId}`);

  const handlePin = () => {
    if (isPinned) {
      usePinnedStore.getState().unpinCard(`term-${sessionId}`);
    } else {
      pinCard(`term-${sessionId}`, 'term', `Terminal: ${command}`, { sessionId, command });
    }
  };

  return (
    <div className="card">
      <div className="ch">
        <div className="who">
          <span className="av">{agentName[0]?.toUpperCase() || 'A'}</span>
          <span>{agentName}</span>
          <span className="tag">· ran a command</span>
        </div>
        <div className={`st ${isRunning ? 'work' : ''}`}>
          <span className="g">{isRunning ? '✻' : '✓'}</span> {isRunning ? 'live' : 'done'}
        </div>
      </div>
      <div className="cb" style={{ padding: '0 12px 12px 12px' }}>
        <div className="termmini" style={{ padding: '10px', background: 'var(--flow-ink)', borderRadius: '6px', overflow: 'auto', maxHeight: '160px', fontFamily: 'monospace', fontSize: '11.5px', whiteSpace: 'pre-wrap' }}>
          <span className="p" style={{ color: 'var(--flow-sage)' }}>spacron ❯ </span>{command}
          <div style={{ marginTop: '6px', color: '#bcae97' }}>{output || 'Waiting for output...'}</div>
        </div>
      </div>
      <div className="acts">
        <button className="act" onClick={() => onExpand('terminal', sessionId)}>⤢ Open full terminal</button>
        <button className={`act${isPinned ? ' pinned' : ''}`} onClick={handlePin}>
          {isPinned ? '⌖ Pinned' : '⌖ Pin'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW CARD
// ─────────────────────────────────────────────────────────────────────────────
interface PreviewCardProps {
  url: string;
  onExpand: (type: 'preview', arg: string) => void;
}

export function PreviewCard({ url, onExpand }: PreviewCardProps) {
  const pinCard = usePinnedStore((s) => s.pinCard);
  const pinnedCards = usePinnedStore((s) => s.pinnedCards);
  const isPinned = pinnedCards.some((c) => c.id === `prev-${url}`);

  const handlePin = () => {
    if (isPinned) {
      usePinnedStore.getState().unpinCard(`prev-${url}`);
    } else {
      pinCard(`prev-${url}`, 'prev', `Preview: ${url}`, { url });
    }
  };

  return (
    <div className="card">
      <div className="ch">
        <div className="who">
          <span className="av" style={{ background: 'var(--flow-sage-soft)', color: 'var(--flow-sage)', display: 'grid', placeItems: 'center' }}>◆</span>
          <span>Orchestrator</span>
          <span className="tag">· preview ready</span>
        </div>
        <div className="st"><span className="g">✓</span> ready</div>
      </div>
      <div className="cb" style={{ padding: '0 12px 12px 12px' }}>
        <div className="prevmini" style={{ height: '90px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--flow-ink)', borderRadius: '6px', border: '1px solid var(--flow-line)', textAlign: 'center' }}>
          <h4 className="serif" style={{ fontSize: '15px', color: 'var(--flow-cream)', fontWeight: 'normal', marginBottom: '4px' }}>Welcome page ready</h4>
          <p style={{ fontSize: '11px', color: 'var(--flow-dim)' }}>{url}</p>
        </div>
      </div>
      <div className="acts">
        <button className="act" onClick={() => onExpand('preview', url)}>⤢ Open preview</button>
        <button className={`act${isPinned ? ' pinned' : ''}`} onClick={handlePin}>
          {isPinned ? '⌖ Pinned' : '⌖ Pin'}
        </button>
      </div>
    </div>
  );
}
