import { useState } from 'react';
import type { WorkItemIssue } from '$lib/services/work-items';

export default function TasksIssuesList({
  issues,
  loading,
  error,
  onSelectIssue,
  onAssignToAgent,
}: {
  issues: WorkItemIssue[];
  loading: boolean;
  error: string | null;
  onSelectIssue: (issue: WorkItemIssue) => void;
  onAssignToAgent: (title: string, body: string, number: number) => void;
}) {
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');
  const [search, setSearch] = useState('');

  const filteredIssues = issues.filter((item) => {
    if (filter !== 'all' && item.state !== filter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        item.title.toLowerCase().includes(q) ||
        item.number.toString().includes(q) ||
        item.labels.some((l) => l.name.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Search and state filters */}
      <div className="tasks-filter-bar">
        <input
          type="text"
          className="tasks-search-input"
          placeholder="Filter issues..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="tasks-filter-pills">
          <button
            type="button"
            className={`tasks-filter-pill ${filter === 'open' ? 'active' : ''}`}
            onClick={() => setFilter('open')}
          >
            Open ({issues.filter((i) => i.state === 'open').length})
          </button>
          <button
            type="button"
            className={`tasks-filter-pill ${filter === 'closed' ? 'active' : ''}`}
            onClick={() => setFilter('closed')}
          >
            Closed ({issues.filter((i) => i.state === 'closed').length})
          </button>
          <button
            type="button"
            className={`tasks-filter-pill ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
        </div>
      </div>

      {/* List Container */}
      <div className="work-items-list-container">
        {loading && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: 12 }}>
            Loading repository issues...
          </div>
        )}

        {error && (
          <div style={{ padding: 12, borderRadius: 6, background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', fontSize: 11.5 }}>
            {error}
          </div>
        )}

        {!loading && !error && filteredIssues.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>No issues found</div>
            <div style={{ fontSize: 11.5, marginTop: 4 }}>
              {search ? 'Try clearing your search query.' : 'There are no issues matching this filter.'}
            </div>
          </div>
        )}

        {!loading &&
          filteredIssues.map((issue) => (
            <div
              key={issue.id}
              className="work-item-card"
              onClick={() => onSelectIssue(issue)}
            >
              <div className="work-item-card-top">
                <div className="work-item-title-group">
                  <span className={`work-item-badge ${issue.state}`}>
                    {issue.state === 'open' ? '● Open' : '✓ Closed'}
                  </span>
                  <span className="work-item-number">#{issue.number}</span>
                  <span className="work-item-title">{issue.title}</span>
                </div>

                <button
                  type="button"
                  className="tasks-action-btn"
                  style={{ fontSize: 10, padding: '3px 8px' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAssignToAgent(issue.title, issue.body, issue.number);
                  }}
                  title="Assign this issue to an AI agent"
                >
                  🚀 Assign Agent
                </button>
              </div>

              <div className="work-item-card-meta">
                <div className="work-item-meta-left">
                  {issue.labels.length > 0 && (
                    <div className="work-item-labels-wrap">
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
                  <span>
                    Opened by <strong>{issue.author.login}</strong> ·{' '}
                    {new Date(issue.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>

                <div className="work-item-meta-right">
                  {issue.commentsCount > 0 && (
                    <span>💬 {issue.commentsCount}</span>
                  )}
                  {issue.author.avatarUrl && (
                    <img src={issue.author.avatarUrl} alt="" className="work-item-avatar" />
                  )}
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
