import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '$lib/stores/notification';

export default function TasksNewPRModal({
  projectId,
  defaultBranch = 'main',
  currentBranch = '',
  onClose,
  onCreated,
}: {
  projectId: string;
  defaultBranch?: string;
  currentBranch?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(defaultBranch);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        handleSubmit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [title, body, base]);

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);

    try {
      const res: any = await invoke('workspace_git_commit_and_open_pr', {
        projectId,
        repoPath: null,
        title: title.trim(),
        body: body.trim() || null,
        base: base.trim() || null,
      });

      if (res.prUrl) {
        showToast({ title: `Pull request #${res.prNumber || ''} created!`, tone: 'success' });
      } else if (res.compareUrl) {
        showToast({ title: 'Pushed to branch. Open compare URL to complete PR.', tone: 'info' });
      } else {
        showToast({ title: 'Pushed branch successfully', tone: 'success' });
      }

      onCreated();
      onClose();
    } catch (err) {
      showToast({
        title: typeof err === 'string' ? err : 'Failed to create pull request',
        tone: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--surface-modal, #18181b)',
          border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.1))',
          borderRadius: 12,
          padding: 20,
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              Open Pull Request
            </h3>
            {currentBranch && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                From branch <code>{currentBranch}</code>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
            Title *
          </label>
          <input
            ref={inputRef}
            type="text"
            className="tasks-search-input"
            style={{ width: '100%', maxWidth: 'none', padding: '6px 10px', fontSize: 12 }}
            placeholder="PR title (e.g. Implement new chat layout)..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
            Base Branch
          </label>
          <input
            type="text"
            className="tasks-search-input"
            style={{ width: '100%', maxWidth: 'none', padding: '6px 10px', fontSize: 12 }}
            placeholder="main"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
            Description (Markdown)
          </label>
          <textarea
            className="comment-textarea"
            style={{ minHeight: 120 }}
            placeholder="Explain the changes in this pull request..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
            Commits unstaged changes, pushes, and creates PR.
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="tasks-action-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="tasks-action-btn primary"
              disabled={!title.trim() || submitting}
              onClick={handleSubmit}
            >
              {submitting ? 'Shipping PR...' : 'Ship Pull Request 🚀'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
