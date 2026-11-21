import type { RemoteRepoInfo } from '$lib/services/work-items';

export type TaskPanelTab = 'board' | 'issues' | 'prs';

export default function TasksTabHeader({
  activeTab,
  onTabChange,
  issuesCount,
  prsCount,
  repoInfo,
  onRefresh,
  onOpenNewIssue,
  onOpenNewPR,
}: {
  activeTab: TaskPanelTab;
  onTabChange: (tab: TaskPanelTab) => void;
  issuesCount: number;
  prsCount: number;
  repoInfo: RemoteRepoInfo | null;
  onRefresh: () => void;
  onOpenNewIssue: () => void;
  onOpenNewPR: () => void;
}) {
  return (
    <div className="tasks-tabs-header">
      {/* Navigation Pills */}
      <div className="tasks-nav-pills">
        <button
          type="button"
          className={`tasks-nav-btn ${activeTab === 'board' ? 'active' : ''}`}
          onClick={() => onTabChange('board')}
        >
          <span>📋</span>
          <span>Board</span>
        </button>

        <button
          type="button"
          className={`tasks-nav-btn ${activeTab === 'issues' ? 'active' : ''}`}
          onClick={() => onTabChange('issues')}
        >
          <span>🐙</span>
          <span>Issues</span>
          {issuesCount > 0 && <span className="tasks-nav-count">{issuesCount}</span>}
        </button>

        <button
          type="button"
          className={`tasks-nav-btn ${activeTab === 'prs' ? 'active' : ''}`}
          onClick={() => onTabChange('prs')}
        >
          <span>🔀</span>
          <span>Pull Requests</span>
          {prsCount > 0 && <span className="tasks-nav-count">{prsCount}</span>}
        </button>
      </div>

      {/* Right Controls: Repo details & Actions */}
      <div className="tasks-actions-bar">
        {repoInfo && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              borderRadius: 6,
              background: 'rgba(0, 0, 0, 0.25)',
              fontSize: 11,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono, monospace)',
            }}
            title={`Remote: ${repoInfo.remoteUrl}`}
          >
            <span style={{ color: 'var(--text-secondary)' }}>{repoInfo.owner}/{repoInfo.repo}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ color: 'var(--accent, #6366f1)' }}>{repoInfo.currentBranch}</span>
          </div>
        )}

        <button
          type="button"
          className="tasks-action-btn"
          onClick={onRefresh}
          title="Refresh issues and pull requests"
        >
          ↻
        </button>

        {activeTab === 'issues' && (
          <button
            type="button"
            className="tasks-action-btn primary"
            onClick={onOpenNewIssue}
          >
            + New Issue
          </button>
        )}

        {activeTab === 'prs' && (
          <button
            type="button"
            className="tasks-action-btn primary"
            onClick={onOpenNewPR}
          >
            + New PR
          </button>
        )}
      </div>
    </div>
  );
}
