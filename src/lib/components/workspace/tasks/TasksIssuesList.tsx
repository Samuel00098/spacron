import { useState } from 'react';
import type { WorkItemIssue } from '$lib/services/work-items';
import {
  SearchIcon,
  IssueIcon,
  CheckCircleIcon,
  AgentSparklesIcon,
  MessageSquareIcon,
} from './TasksIcons';

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
      <div className="tasks-filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="tasks-search-input-wrap" style={{ flex: '1 1 180px', minWidth: 140, maxWidth: 'none' }}>
          <SearchIcon size={12} />
          <input
            type="text"
            className="tasks-search-input"
            placeholder="Filter issues..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="tasks-filter-pills" style={{ flexWrap: 'wrap' }}>
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
          <div
            style={{
              padding: 12,
              borderRadius: 6,
              background: 'color-mix(in srgb, var(--error, #ef4444) 12%, transparent)',
              color: 'var(--error, #dc2626)',
              border: '1px solid color-mix(in srgb, var(--error, #ef4444) 25%, transparent)',
              fontSize: 11.5,
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && filteredIssues.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>
              <CheckCircleIcon size={24} style={{ color: 'var(--text-muted)' }} />
            </div>
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
                  <AgentSparklesIcon size={11} />
                  <span>Assign Agent</span>
                </button>
              </div>

              <div className="work-item-card-meta">
                <div className="work-item-meta-left">
                  {issue.labels.length > 0 && (
                    <div className="work-item-labels-wrap">
                      {issue.labels.map((l) => (
                        <span
                          key={l.name}
                          className="work-item-label-tag"
                          style={{
                            background: `#${l.color}25`,
                            color: `#${l.color}`,
                            border: `1px solid #${l.color}50`,
                          }}
                        >
                          {l.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="work-item-meta-right">
                  <span className="work-item-author-chip">
                    {issue.author.avatarUrl && (
                      <img src={issue.author.avatarUrl} alt="" className="work-item-avatar" />
                    )}
                    <span>{issue.author.login}</span>
                  </span>

                  {issue.commentsCount > 0 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <MessageSquareIcon size={11} />
                      <span>{issue.commentsCount}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
