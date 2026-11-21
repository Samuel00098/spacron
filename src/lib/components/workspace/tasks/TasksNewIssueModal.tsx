import { useState, useRef, useEffect } from 'react';
import { createIssue, type WorkItemIssue } from '$lib/services/work-items';
import { showToast } from '$lib/stores/notification';

export default function TasksNewIssueModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (issue: WorkItemIssue) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
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
  }, [title, body, labels]);

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const labelList = labels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const issue = await createIssue(
        projectId,
        title.trim(),
        body,
        labelList.length > 0 ? labelList : undefined
      );

      showToast({ title: `Created issue #${issue.number}`, tone: 'success' });
      onCreated(issue);
      onClose();
    } catch (err) {
      showToast({
        title: typeof err === 'string' ? err : 'Failed to create issue',
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
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            New GitHub Issue
          </h3>
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
            placeholder="Issue title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
            Description (Markdown)
          </label>
          <textarea
            className="comment-textarea"
            style={{ minHeight: 120 }}
            placeholder="Describe the bug, feature request, or task..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
            Labels (comma separated)
          </label>
          <input
            type="text"
            className="tasks-search-input"
            style={{ width: '100%', maxWidth: 'none', padding: '6px 10px', fontSize: 12 }}
            placeholder="e.g. bug, frontend, high-priority"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button type="button" className="tasks-action-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tasks-action-btn primary"
            disabled={!title.trim() || submitting}
            onClick={handleSubmit}
          >
            {submitting ? 'Creating...' : 'Create Issue'}
          </button>
        </div>
      </div>
    </div>
  );
}
