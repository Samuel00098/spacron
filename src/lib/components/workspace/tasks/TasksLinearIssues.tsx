import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import MarkdownPreview from '$lib/components/preview/MarkdownPreview';
import { useStore } from '$lib/react/useStore';
import {
  getLinearIssue,
  getLinearMapping,
  linearAccountRevision,
  linearError,
  linearMappingRevision,
  listLinearIssues,
  type LinearIssue,
  type LinearIssueSummary,
  type LinearMapping,
} from '$lib/services/linear';
import { openCreateWorktree } from '$lib/stores/projectWorktrees';
import { useLayoutStore } from '$lib/stores/zustand/layout';
import { ArrowLeftIcon } from './TasksIcons';

function openTaskProviderSettings() {
  useLayoutStore.getState().openSettings('source-control');
}

export default function TasksLinearIssues({ projectId, refresh }: { projectId: string; refresh: number }) {
  const accountRevision = useStore(linearAccountRevision);
  useStore(linearMappingRevision);
  const mapping = getLinearMapping(projectId);
  if (!mapping) {
    return (
      <div className="work-item-detail-content">
        <p>Connect Linear and choose a team or project to see its issues here.</p>
        <button type="button" className="tasks-action-btn" onClick={openTaskProviderSettings}>Open Settings</button>
      </div>
    );
  }
  return <LinearIssueList
    key={`${projectId}:${mapping.kind}:${mapping.id}:${accountRevision}:${refresh}`}
    projectId={projectId}
    mapping={mapping}
  />;
}

function LinearIssueList({ projectId, mapping }: { projectId: string; mapping: LinearMapping }) {
  const [issues, setIssues] = useState<LinearIssueSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { id, name, kind } = mapping;

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    void listLinearIssues({ id, name, kind }, cursor).then(
      (page) => {
        if (!current) return;
        setIssues((previous) => {
          const known = new Set(previous.map((issue) => issue.id));
          return [...previous, ...page.nodes.filter((issue) => !known.has(issue.id))];
        });
        const next = page.pageInfo.endCursor;
        setMore(page.pageInfo.hasNextPage && next !== cursor ? next : null);
      },
      (failure) => { if (current) setError(linearError(failure)); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [id, name, kind, cursor, retry]);

  if (selectedId) {
    return <LinearIssueDetail issueId={selectedId} projectId={projectId} onBack={() => setSelectedId(null)} />;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = issues.filter((issue) =>
    `${issue.identifier} ${issue.title}`.toLowerCase().includes(normalizedQuery));

  return (
    <>
      <div className="tasks-filter-bar">
        <div className="tasks-search-input-wrap">
          <input type="search" className="tasks-search-input" aria-label="Filter loaded Linear issues"
            placeholder="Filter loaded issues…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <span>{name}</span>
      </div>
      <div className="work-items-list-container">
        {filtered.map((issue) => (
          <button type="button" className="work-item-card linear-issue-row" key={issue.id} onClick={() => setSelectedId(issue.id)}>
            <span className="work-item-card-top">
              <span className="work-item-title-group">
                <span className="work-item-number">{issue.identifier}</span>
                <span className="work-item-title">{issue.title}</span>
              </span>
            </span>
            <span className="work-item-card-meta">
              <span>{issue.state.name}</span>
              {issue.assignee && <span>{issue.assignee.name}</span>}
            </span>
          </button>
        ))}
        {loading && <p role="status">Loading Linear issues…</p>}
        {error && (
          <div>
            <p role="alert">{error}</p>
            <button type="button" className="tasks-action-btn" onClick={() => setRetry((value) => value + 1)}>Retry</button>
            {' '}
            <button type="button" className="tasks-action-btn" onClick={openTaskProviderSettings}>Open Settings</button>
          </div>
        )}
        {!loading && !error && !filtered.length && (
          <p>{normalizedQuery ? 'No loaded issues match this filter.' : 'No Linear issues found.'}</p>
        )}
        {!loading && !error && more && (
          <button type="button" className="tasks-action-btn" onClick={() => setCursor(more)}>Load more</button>
        )}
      </div>
    </>
  );
}

function LinearIssueDetail({ issueId, projectId, onBack }: { issueId: string; projectId: string; onBack: () => void }) {
  const [issue, setIssue] = useState<LinearIssue | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    void getLinearIssue(issueId).then(
      (detail) => { if (current) setIssue(detail); },
      (failure) => { if (current) setError(linearError(failure)); },
    );
    return () => { current = false; };
  }, [issueId]);

  return (
    <div className="work-item-detail-view">
      <div className="work-item-detail-topbar">
        <button type="button" className="work-item-back-btn" onClick={onBack}><ArrowLeftIcon size={13} /> Back to Issues</button>
        {issue && (
          <button type="button" className="tasks-action-btn primary"
            onClick={() => openCreateWorktree(projectId, null, issue)}>Create worktree</button>
        )}
      </div>
      <div className="work-item-detail-content">
        {error && <p role="alert">{error}</p>}
        {!issue && !error && <p role="status">Loading Linear issue…</p>}
        {issue && (
          <>
            <div className="work-item-header-block">
              <span className="work-item-number">{issue.identifier}</span>
              <h2 className="work-item-detail-title">{issue.title}</h2>
              <div className="work-item-detail-sub">
                <span>{issue.state.name}</span>
                {issue.assignee && <span>{issue.assignee.name}</span>}
                <button type="button" className="tasks-action-btn" onClick={() => {
                  void invoke('preview_open_in_browser', { url: issue.url })
                    .catch((failure) => setError(linearError(failure)));
                }}>Open in Linear</button>
              </div>
            </div>
            <div className="work-item-detail-box">
              <MarkdownPreview content={issue.description || '_No description provided._'} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
