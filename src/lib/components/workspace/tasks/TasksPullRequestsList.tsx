import { useState, useMemo } from 'react';
import type { WorkItemPR } from '$lib/services/work-items';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import {
  SearchIcon,
  PullRequestIcon,
  GitMergeIcon,
  XCircleIcon,
  GitBranchIcon,
  AgentSparklesIcon,
} from './TasksIcons';

const SORT_OPTIONS: DropdownOption[] = [
  { value: 'newest', label: 'Sort: Newest' },
  { value: 'oldest', label: 'Sort: Oldest' },
  { value: 'updated', label: 'Sort: Recently Updated' },
  { value: 'title-asc', label: 'Sort: Title (A-Z)' },
  { value: 'title-desc', label: 'Sort: Title (Z-A)' },
];

export default function TasksPullRequestsList({
  pullRequests,
  loading,
  error,
  onSelectPR,
}: {
  pullRequests: WorkItemPR[];
  loading: boolean;
  error: string | null;
  onSelectPR: (pr: WorkItemPR) => void;
  onAssignToAgent: (title: string, body: string, number: number, headBranch?: string, baseBranch?: string) => void;
}) {
  const [filter, setFilter] = useState<'open' | 'closed' | 'merged' | 'all'>('open');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'updated' | 'title-asc' | 'title-desc'>('newest');
  const [authorFilter, setAuthorFilter] = useState<string>('all');

  const uniqueAuthors = useMemo(() => {
    const set = new Set<string>();
    pullRequests.forEach((pr) => {
      if (pr.author?.login) set.add(pr.author.login);
    });
    return Array.from(set).sort();
  }, [pullRequests]);

  const authorOptions = useMemo<DropdownOption[]>(() => {
    return [
      { value: 'all', label: 'Author: All' },
      ...uniqueAuthors.map((auth) => ({
        value: auth,
        label: `Author: @${auth}`,
      })),
    ];
  }, [uniqueAuthors]);

  const filteredPRs = useMemo(() => {
    const list = pullRequests.filter((item) => {
      if (filter !== 'all' && item.state !== filter) return false;
      if (authorFilter !== 'all' && item.author?.login !== authorFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          item.title.toLowerCase().includes(q) ||
          item.number.toString().includes(q) ||
          item.headBranch.toLowerCase().includes(q) ||
          item.baseBranch.toLowerCase().includes(q) ||
          item.author?.login.toLowerCase().includes(q)
        );
      }
      return true;
    });

    list.sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'oldest':
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case 'updated':
          return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
        case 'title-asc':
          return a.title.localeCompare(b.title);
        case 'title-desc':
          return b.title.localeCompare(a.title);
        default:
          return 0;
      }
    });

    return list;
  }, [pullRequests, filter, search, sortBy, authorFilter]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Search, Sort, and Filters Bar */}
      <div className="tasks-filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 260 }}>
          <div className="tasks-search-input-wrap" style={{ flex: 1 }}>
            <SearchIcon size={12} />
            <input
              type="text"
              className="tasks-search-input"
              placeholder="Filter by title, branch, #number, author..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Sort Selector */}
          <div className="tasks-filter-dropdown-wrap">
            <Dropdown
              options={SORT_OPTIONS}
              value={sortBy}
              onChange={(val) => setSortBy(val as any)}
              ariaLabel="Sort pull requests"
            />
          </div>

          {/* Author Filter (if multiple authors exist) */}
          {uniqueAuthors.length > 1 && (
            <div className="tasks-filter-dropdown-wrap">
              <Dropdown
                options={authorOptions}
                value={authorFilter}
                onChange={(val) => setAuthorFilter(val)}
                ariaLabel="Filter by author"
              />
            </div>
          )}
        </div>

        {/* State Pills: Open, Merged, Closed, All */}
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
            All ({pullRequests.length})
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

        {!loading && !error && filteredPRs.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>
              <PullRequestIcon size={24} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>No pull requests found</div>
            <div style={{ fontSize: 11.5, marginTop: 4 }}>
              {search || authorFilter !== 'all'
                ? 'Try clearing your search or author filter.'
                : 'There are no pull requests matching this filter.'}
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
                    {pr.state === 'merged' ? (
                      <>
                        <GitMergeIcon size={11} /> Merged
                      </>
                    ) : pr.state === 'closed' ? (
                      <>
                        <XCircleIcon size={11} /> Closed
                      </>
                    ) : (
                      <>
                        <PullRequestIcon size={11} /> Open
                      </>
                    )}
                  </span>
                  <span className="work-item-number">#{pr.number}</span>
                  <span className="work-item-title">{pr.title}</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="tasks-action-btn"
                    style={{ fontSize: 10, padding: '3px 8px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAssignToAgent(pr.title, pr.body, pr.number, pr.headBranch, pr.baseBranch);
                    }}
                    title="Review with an Agent"
                  >
                    <AgentSparklesIcon size={11} />
                    <span>Review with Agent</span>
                  </button>

                  <button
                    type="button"
                    className="tasks-action-btn primary"
                    style={{ fontSize: 10, padding: '3px 8px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectPR(pr);
                    }}
                  >
                    <span>{pr.state === 'merged' ? 'View Details' : 'Review & Merge'}</span>
                    <span style={{ fontSize: 11 }}>→</span>
                  </button>
                </div>
              </div>

              <div className="work-item-card-meta">
                <div className="work-item-meta-left">
                  <span className="work-item-branch-pill">
                    <GitBranchIcon size={10} />
                    <span>{pr.headBranch} → {pr.baseBranch}</span>
                  </span>
                  <span>
                    {pr.state === 'merged' && pr.mergedAt ? (
                      <>
                        Merged on{' '}
                        {new Date(pr.mergedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </>
                    ) : (
                      <>
                        Opened by <strong style={{ color: 'var(--text-primary)' }}>{pr.author.login}</strong> ·{' '}
                        {new Date(pr.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </>
                    )}
                  </span>
                  {(pr.additions !== null && pr.additions !== undefined) && (
                    <span className="diff-stats-pill" style={{ marginLeft: 4 }}>
                      <span className="diff-additions">+{pr.additions}</span>
                      <span className="diff-deletions">-{pr.deletions}</span>
                    </span>
                  )}
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
