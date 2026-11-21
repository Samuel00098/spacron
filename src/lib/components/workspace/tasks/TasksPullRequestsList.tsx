import { useState } from 'react';
import type { WorkItemPR } from '$lib/services/work-items';

export default function TasksPullRequestsList({
  pullRequests,
  loading,
  error,
  onSelectPR,
  onAssignToAgent,
}: {
  pullRequests: WorkItemPR[];
  loading: boolean;
  error: string | null;
  onSelectPR: (pr: WorkItemPR) => void;
  onAssignToAgent: (title: string, body: string, number: number) => void;
}) {
  const [filter, setFilter] = useState<'open' | 'closed' | 'merged' | 'all'>('open');
  const [search, setSearch] = useState('');

  const filteredPRs = pullRequests.filter((item) => {
    if (filter !== 'all' && item.state !== filter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        item.title.toLowerCase().includes(q) ||
        item.number.toString().includes(q) ||
        item.headBranch.toLowerCase().includes(q)
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
          placeholder="Filter pull requests..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="tasks-filter-pills">
          <button
            type="button"
            className={`tasks-filter-pill ${filter === 'open' ? 'active' : ''}`}
            onClick={() => setFilter('open')}
          >
            Open ({pullRequests.filter((i) => i.state === 'open').length})
          </button>
          <button
            type="button"
            className={`tasks-filter-pill ${filter === 'merged' ? 'active' : ''}`}
            onClick={() => setFilter('merged')}
          >
            Merged ({pullRequests.filter((i) => i.state === 'merged').length})
          </button>
          <button
            type="button"
            className={`tasks-filter-pill ${filter === 'closed' ? 'active' : ''}`}
            onClick={() => setFilter('closed')}
          >
            Closed ({pullRequests.filter((i) => i.state === 'closed').length})
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
            Loading pull requests...
          </div>
        )}

        {error && (
          <div style={{ padding: 12, borderRadius: 6, background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', fontSize: 11.5 }}>
            {error}
          </div>
        )}

        {!loading && !error && filteredPRs.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>🔀</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>No pull requests found</div>
            <div style={{ fontSize: 11.5, marginTop: 4 }}>
              {search ? 'Try clearing your search query.' : 'There are no pull requests matching this filter.'}
            </div>
          </div>
        )}

        {!loading &&
          filteredPRs.map((pr) => (
            <div
              key={pr.id}
              className="work-item-card"
              onClick={() => onSelectPR(pr)}
            >
              <div className="work-item-card-top">
                <div className="work-item-title-group">
                  <span className={`work-item-badge ${pr.state}`}>
                    {pr.state === 'merged' ? '⚑ Merged' : pr.state === 'closed' ? '✕ Closed' : '● Open'}
                  </span>
                  <span className="work-item-number">#{pr.number}</span>
                  <span className="work-item-title">{pr.title}</span>
                </div>

                <button
                  type="button"
                  className="tasks-action-btn primary"
                  style={{ fontSize: 10, padding: '3px 8px' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectPR(pr);
                  }}
                >
                  Review & Merge →
                </button>
              </div>

              <div className="work-item-card-meta">
                <div className="work-item-meta-left">
                  <span className="work-item-branch-pill">
                    {pr.headBranch} → {pr.baseBranch}
                  </span>
                  <span>
                    Opened by <strong>{pr.author.login}</strong> ·{' '}
                    {new Date(pr.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>

                <div className="work-item-meta-right">
                  {pr.author.avatarUrl && (
                    <img src={pr.author.avatarUrl} alt="" className="work-item-avatar" />
                  )}
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
