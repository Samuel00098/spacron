import { useEffect, useState } from 'react';
import {
  getPullRequestDetails,
  getPullRequestFiles,
  getPullRequestChecks,
  mergePullRequest,
  addPullRequestComment,
  type WorkItemPR,
  type WorkItemComment,
  type WorkItemFile,
  type PRChecksSummary,
} from '$lib/services/work-items';
import MarkdownPreview from '$lib/components/preview/MarkdownPreview';
import { showToast } from '$lib/stores/notification';

export default function TasksPullRequestDetail({
  projectId,
  prNumber,
  onBack,
  onAssignToAgent,
}: {
  projectId: string;
  prNumber: number;
  onBack: () => void;
  onAssignToAgent: (title: string, body: string, number: number) => void;
}) {
  const [pr, setPr] = useState<WorkItemPR | null>(null);
  const [comments, setComments] = useState<WorkItemComment[]>([]);
  const [files, setFiles] = useState<WorkItemFile[]>([]);
  const [checks, setChecks] = useState<PRChecksSummary | null>(null);
  const [activeTab, setActiveTab] = useState<'conversation' | 'checks' | 'files'>('conversation');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Merge state
  const [mergeMethod, setMergeMethod] = useState<'squash' | 'merge' | 'rebase'>('squash');
  const [commitTitle, setCommitTitle] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Comment state
  const [replyText, setReplyText] = useState('');
  const [submittingReply, setSubmittingReply] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    getPullRequestDetails(projectId, prNumber)
      .then((data) => {
        if (!active) return;
        setPr(data.pr);
        setComments(data.comments);
        setCommitTitle(`${data.pr.title} (#${data.pr.number})`);
        setLoading(false);

        // Fetch files & checks in parallel
        getPullRequestFiles(projectId, prNumber)
          .then((f) => active && setFiles(f))
          .catch(() => {});

        if (data.pr.headSha) {
          getPullRequestChecks(projectId, data.pr.headSha)
            .then((c) => active && setChecks(c))
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (active) {
          setError(typeof err === 'string' ? err : 'Failed to load pull request');
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [projectId, prNumber]);

  const handleMerge = async () => {
    if (!pr || merging) return;
    setMerging(true);
    setMergeError(null);

    try {
      const res = await mergePullRequest(projectId, pr.number, {
        method: mergeMethod,
        commitTitle: commitTitle || undefined,
        commitMessage: commitMessage || undefined,
        expectedHeadSha: pr.headSha || undefined,
      });

      if (res.success) {
        setPr({ ...pr, state: 'merged', mergedAt: new Date().toISOString() });
        showToast({ title: 'Pull Request merged successfully!', tone: 'success' });
      }
    } catch (err) {
      const msg = typeof err === 'string' ? err : 'Failed to merge pull request';
      setMergeError(msg);
      showToast({ title: 'Merge failed', tone: 'error' });
    } finally {
      setMerging(false);
    }
  };

  const handleAddComment = async () => {
    if (!replyText.trim() || submittingReply || !pr) return;
    setSubmittingReply(true);
    try {
      const newComment = await addPullRequestComment(projectId, pr.number, replyText);
      setComments((prev) => [...prev, newComment]);
      setReplyText('');
      showToast({ title: 'Comment posted', tone: 'success' });
    } catch {
      showToast({ title: 'Failed to post comment', tone: 'error' });
    } finally {
      setSubmittingReply(false);
    }
  };

  if (loading) {
    return (
      <div className="work-item-detail-view" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading PR #{prNumber}...</p>
      </div>
    );
  }

  if (error || !pr) {
    return (
      <div className="work-item-detail-view" style={{ padding: 24 }}>
        <button type="button" className="work-item-back-btn" onClick={onBack}>
          ← Back to Pull Requests
        </button>
        <p style={{ color: 'var(--error, #f87171)', marginTop: 16, fontSize: 12 }}>
          {error || 'Pull request not found'}
        </p>
      </div>
    );
  }

  return (
    <div className="work-item-detail-view">
      {/* Top action bar */}
      <div className="work-item-detail-topbar">
        <button type="button" className="work-item-back-btn" onClick={onBack}>
          ← Back to Pull Requests
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="tasks-action-btn primary"
            onClick={() => onAssignToAgent(pr.title, pr.body, pr.number)}
            title="Create an isolated worktree branch and dispatch an agent to review or edit this PR"
          >
            🚀 Review with Agent
          </button>
        </div>
      </div>

      {/* Header Info */}
      <div style={{ padding: '16px 24px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className={`work-item-badge ${pr.state}`}>
            {pr.state === 'merged' ? '⚑ Merged' : pr.state === 'closed' ? '✕ Closed' : '● Open'}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
            #{pr.number}
          </span>
          <span className="work-item-branch-pill">
            {pr.headBranch} → {pr.baseBranch}
          </span>
        </div>

        <h2 className="work-item-detail-title">{pr.title}</h2>

        <div className="work-item-detail-sub" style={{ marginTop: 6 }}>
          {pr.author.avatarUrl && (
            <img src={pr.author.avatarUrl} alt="" className="work-item-avatar" />
          )}
          <span>
            <strong>{pr.author.login}</strong> wants to merge into <code>{pr.baseBranch}</code>
          </span>
          <span>·</span>
          <span>{files.length} files changed</span>
          {checks && (
            <>
              <span>·</span>
              <span style={{ color: checks.failed > 0 ? '#f87171' : checks.passed > 0 ? '#4ade80' : 'var(--text-muted)' }}>
                {checks.failed > 0 ? `✕ ${checks.failed} checks failed` : `✓ ${checks.passed} checks passed`}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Sub-Tabs: Conversation, Checks, Files Changed */}
      <div className="pr-tabs-bar">
        <button
          type="button"
          className={`pr-tab-btn ${activeTab === 'conversation' ? 'active' : ''}`}
          onClick={() => setActiveTab('conversation')}
        >
          💬 Conversation
          {comments.length > 0 && <span className="pr-tab-count">{comments.length}</span>}
        </button>

        <button
          type="button"
          className={`pr-tab-btn ${activeTab === 'checks' ? 'active' : ''}`}
          onClick={() => setActiveTab('checks')}
        >
          ⚙ Checks
          {checks && <span className="pr-tab-count">{checks.total}</span>}
        </button>

        <button
          type="button"
          className={`pr-tab-btn ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => setActiveTab('files')}
        >
          📄 Files Changed
          {files.length > 0 && <span className="pr-tab-count">{files.length}</span>}
        </button>
      </div>

      {/* Tab Contents */}
      <div className="work-item-detail-content">
        {/* Tab 1: Conversation */}
        {activeTab === 'conversation' && (
          <>
            {/* PR Description */}
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: 16, borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
              <MarkdownPreview content={pr.body || '_No description provided._'} />
            </div>

            {/* Comments Thread */}
            {comments.length > 0 && (
              <div className="comments-stream">
                <h4 style={{ fontSize: 12, fontWeight: 700, margin: '8px 0 0', color: 'var(--text-primary)' }}>
                  Discussion & Reviews
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

            {/* Merge PR Bar */}
            {pr.state === 'open' ? (
              <div className="pr-merge-container">
                <div className="pr-merge-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🔀</span>
                    <div>
                      <div className="pr-merge-status-text">Ready to merge</div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        Target: <code>{pr.baseBranch}</code> · Head: <code>{pr.headSha.slice(0, 7)}</code>
                      </div>
                    </div>
                  </div>

                  <select
                    className="pr-merge-method-select"
                    value={mergeMethod}
                    onChange={(e) => setMergeMethod(e.target.value as any)}
                  >
                    <option value="squash">Squash and merge</option>
                    <option value="merge">Create a merge commit</option>
                    <option value="rebase">Rebase and merge</option>
                  </select>
                </div>

                {mergeError && <div className="pr-merge-error-banner">⚠ {mergeError}</div>}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Safety check: merges with <code>--match-head-commit</code> verified.
                  </span>

                  <button
                    type="button"
                    className="pr-merge-btn"
                    disabled={merging}
                    onClick={handleMerge}
                  >
                    {merging ? 'Merging...' : `Merge Pull Request (${mergeMethod})`}
                  </button>
                </div>
              </div>
            ) : pr.state === 'merged' ? (
              <div className="pr-merge-container" style={{ background: 'rgba(147, 51, 234, 0.1)', borderColor: 'rgba(147, 51, 234, 0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>✓</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#c084fc' }}>
                      Pull request successfully merged and closed
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Merged into <code>{pr.baseBranch}</code> on {new Date(pr.mergedAt || '').toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Post Reply */}
            <div className="comment-composer-box">
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                Add review comment
              </label>
              <textarea
                className="comment-textarea"
                placeholder="Leave a review comment or feedback..."
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
          </>
        )}

        {/* Tab 2: Checks */}
        {activeTab === 'checks' && (
          <div className="checks-list">
            <h4 style={{ fontSize: 12, fontWeight: 700, margin: '0 0 4px', color: 'var(--text-primary)' }}>
              CI / CD Check Runs
            </h4>
            {checks && checks.checks.length > 0 ? (
              checks.checks.map((check) => (
                <div key={check.id} className="check-item-row">
                  <div className="check-item-left">
                    <span
                      className={
                        check.conclusion === 'success'
                          ? 'check-glyph-success'
                          : check.conclusion === 'failure'
                          ? 'check-glyph-failed'
                          : 'check-glyph-running'
                      }
                    >
                      {check.conclusion === 'success' ? '✓' : check.conclusion === 'failure' ? '✕' : '●'}
                    </span>
                    <strong style={{ color: 'var(--text-primary)' }}>{check.name}</strong>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>
                      {check.status === 'completed' ? check.conclusion : 'in progress'}
                    </span>
                    {check.htmlUrl && (
                      <a
                        href={check.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent, #6366f1)', fontSize: 10.5, textDecoration: 'none' }}
                      >
                        Details ↗
                      </a>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No CI check runs reported for commit {pr.headSha.slice(0, 7)}.</p>
            )}
          </div>
        )}

        {/* Tab 3: Files Changed */}
        {activeTab === 'files' && (
          <div className="diff-files-layout">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <h4 style={{ fontSize: 12, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Changed Files ({files.length})
              </h4>
            </div>

            {files.map((file) => (
              <div key={file.filename} className="diff-file-card">
                <div className="diff-file-header">
                  <span className="diff-filename">{file.filename}</span>
                  <span className="diff-stats-pill">
                    <span className="diff-additions">+{file.additions}</span>
                    <span className="diff-deletions">-{file.deletions}</span>
                  </span>
                </div>

                {file.patch ? (
                  <pre className="diff-patch-pre">
                    {file.patch.split('\n').map((line, idx) => {
                      const isAdd = line.startsWith('+');
                      const isDel = line.startsWith('-');
                      const isHunk = line.startsWith('@@');
                      const cls = isAdd ? 'diff-line-add' : isDel ? 'diff-line-del' : isHunk ? 'diff-line-hunk' : '';
                      return (
                        <span key={idx} className={cls}>
                          {line}
                        </span>
                      );
                    })}
                  </pre>
                ) : (
                  <p style={{ padding: 12, margin: 0, color: 'var(--text-muted)', fontSize: 11 }}>
                    Binary or large file changed without inline diff preview.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
