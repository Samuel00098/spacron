import { useEffect, useState } from 'react';
import {
  getIssueDetails,
  updateIssueState,
  addIssueComment,
  type WorkItemIssue,
  type WorkItemComment,
} from '$lib/services/work-items';
import MarkdownPreview from '$lib/components/preview/MarkdownPreview';
import { showToast } from '$lib/stores/notification';
import {
  ArrowLeftIcon,
  AgentSparklesIcon,
  IssueIcon,
  CheckCircleIcon,
} from './TasksIcons';

export default function TasksIssueDetail({
  projectId,
  issueNumber,
  onBack,
  onAssignToAgent,
}: {
  projectId: string;
  issueNumber: number;
  onBack: () => void;
  onAssignToAgent: (title: string, body: string, number: number) => void;
}) {
  const [issue, setIssue] = useState<WorkItemIssue | null>(null);
  const [comments, setComments] = useState<WorkItemComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [submittingReply, setSubmittingReply] = useState(false);
  const [updatingState, setUpdatingState] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    getIssueDetails(projectId, issueNumber)
      .then((data) => {
        if (active) {
          setIssue(data.issue);
          setComments(data.comments);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(typeof err === 'string' ? err : 'Failed to load issue');
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [projectId, issueNumber]);

  const handleToggleState = async () => {
    if (!issue || updatingState) return;
    const targetState = issue.state === 'open' ? 'closed' : 'open';
    setUpdatingState(true);
    try {
      await updateIssueState(projectId, issue.number, targetState);
      setIssue({ ...issue, state: targetState });
      showToast(targetState === 'closed' ? 'Issue closed' : 'Issue reopened', 'success');
    } catch {
      showToast('Failed to update issue', 'error');
    } finally {
      setUpdatingState(false);
    }
  };

  const handleAddComment = async () => {
    if (!replyText.trim() || submittingReply || !issue) return;
    setSubmittingReply(true);
    try {
      const newComment = await addIssueComment(projectId, issue.number, replyText);
      setComments((prev) => [...prev, newComment]);
      setReplyText('');
      showToast('Comment posted', 'success');
    } catch {
      showToast('Failed to post comment', 'error');
    } finally {
      setSubmittingReply(false);
    }
  };

  if (loading) {
    return (
      <div className="work-item-detail-view" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading issue #{issueNumber}...</p>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="work-item-detail-view" style={{ padding: 24 }}>
        <button type="button" className="work-item-back-btn" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          <span>Back to Issues</span>
        </button>
        <p style={{ color: 'var(--error, #dc2626)', marginTop: 16, fontSize: 12 }}>{error || 'Issue not found'}</p>
      </div>
    );
  }

  return (
    <div className="work-item-detail-view">
      {/* Top action bar */}
      <div className="work-item-detail-topbar">
        <button type="button" className="work-item-back-btn" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          <span>Back to Issues</span>
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="tasks-action-btn primary"
            onClick={() => onAssignToAgent(issue.title, issue.body, issue.number)}
            title="Create an isolated worktree branch and dispatch an agent to work on this issue"
          >
            <AgentSparklesIcon size={12} />
            <span>Assign to Agent</span>
          </button>

          <button
            type="button"
            className="tasks-action-btn"
            disabled={updatingState}
            onClick={handleToggleState}
          >
            {issue.state === 'open' ? 'Close Issue' : 'Reopen Issue'}
          </button>
        </div>
      </div>

      {/* Main content body */}
      <div className="work-item-detail-content">
        <div className="work-item-header-block">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`work-item-badge ${issue.state}`}>
              {issue.state === 'open' ? (
                <>
                  <IssueIcon size={11} /> Open
                </>
              ) : (
                <>
                  <CheckCircleIcon size={11} /> Closed
                </>
              )}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono, monospace)' }}>
              #{issue.number}
            </span>
          </div>

          <h2 className="work-item-detail-title">{issue.title}</h2>

          <div className="work-item-detail-sub">
            {issue.author.avatarUrl && (
              <img src={issue.author.avatarUrl} alt="" className="work-item-avatar" />
            )}
            <span>
              <strong style={{ color: 'var(--text-primary)' }}>{issue.author.login}</strong> opened this on{' '}
              {new Date(issue.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <span>·</span>
            <span>{comments.length} comments</span>
          </div>

          {/* Labels */}
          {issue.labels.length > 0 && (
            <div className="work-item-labels-wrap" style={{ marginTop: 4 }}>
              {issue.labels.map((lbl) => (
                <span
                  key={lbl.name}
                  className="work-item-label-tag"
                  style={{
                    backgroundColor: `#${lbl.color}25`,
                    color: `#${lbl.color}`,
                    border: `1px solid #${lbl.color}40`,
                  }}
                >
                  {lbl.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Issue Markdown Description */}
        <div className="work-item-detail-box">
          <MarkdownPreview content={issue.body || '_No description provided._'} />
        </div>

        {/* Discussion / Comments Timeline */}
        {comments.length > 0 && (
          <div className="comments-stream">
            <h4 style={{ fontSize: 12, fontWeight: 700, margin: '8px 0 0', color: 'var(--text-primary)' }}>
              Activity & Comments
            </h4>
            {comments.map((comment) => (
              <div key={comment.id} className="comment-card">
                <div className="comment-card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {comment.author.avatarUrl && (
                      <img src={comment.author.avatarUrl} alt="" className="work-item-avatar" />
                    )}
                    <strong style={{ color: 'var(--text-primary)' }}>{comment.author.login}</strong>
                  </div>
                  <span>
                    {new Date(comment.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <MarkdownPreview content={comment.body} />
              </div>
            ))}
          </div>
        )}

        {/* Post Comment Box */}
        <div className="comment-composer-box">
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
            Leave a comment
          </label>
          <textarea
            className="comment-textarea"
            placeholder="Write a comment (Markdown supported)..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="tasks-action-btn primary"
              disabled={!replyText.trim() || submittingReply}
              onClick={handleAddComment}
            >
              {submittingReply ? 'Posting...' : 'Comment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
