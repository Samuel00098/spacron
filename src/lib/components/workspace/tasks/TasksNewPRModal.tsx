import { useState, useRef, useEffect } from 'react';
import { createPullRequest } from '$lib/services/work-items';
import { showToast } from '$lib/stores/notification';
import { CloseIcon, PlusIcon } from './TasksIcons';

export default function TasksNewPRModal({
  projectId,
  currentBranch,
  defaultBranch,
  onClose,
  onCreated,
}: {
  projectId: string;
  currentBranch: string;
  defaultBranch: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(defaultBranch || 'main');
  const [draft, setDraft] = useState(false);
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
  }, [title, body, base, draft]);

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await createPullRequest(projectId, {
        title: title.trim(),
        body,
        base: base.trim(),
        draft,
      });

      showToast({ title: 'Pull Request created!', tone: 'success' });
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
      className="tasks-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tasks-modal-dialog">
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
            className="tasks-action-btn"
            style={{ padding: 4, background: 'transparent', border: 'none' }}
            title="Close dialog"
          >
            <CloseIcon size={14} />
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
            style={{
              width: '100%',
              maxWidth: 'none',
              padding: '6px 10px',
              fontSize: 12,
              background: 'var(--input-bg, var(--bg-primary))',
              border: '1px solid var(--input-border, var(--border))',
              borderRadius: 6,
            }}
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
            style={{
              width: '100%',
              maxWidth: 'none',
              padding: '6px 10px',
              fontSize: 12,
              background: 'var(--input-bg, var(--bg-primary))',
              border: '1px solid var(--input-border, var(--border))',
              borderRadius: 6,
            }}
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

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 12 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
            Commits unstaged changes, pushes, and creates PR.
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              className="tasks-action-btn"
              onClick={onClose}
              style={{ padding: '6px 12px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="tasks-action-btn primary"
              style={{
                padding: '6px 14px',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
              disabled={!title.trim() || submitting}
              onClick={handleSubmit}
            >
              <PlusIcon size={12} />
              <span style={{ whiteSpace: 'nowrap' }}>{submitting ? 'Creating...' : 'Create PR'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
