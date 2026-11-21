import type { RemoteRepoInfo } from '$lib/services/work-items';
import {
  BoardIcon,
  IssueIcon,
  PullRequestIcon,
  WorkflowIcon,
  GitBranchIcon,
  RefreshIcon,
  PlusIcon,
} from './TasksIcons';

export type TaskPanelTab = 'board' | 'issues' | 'prs' | 'actions';

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
          title="Local Task Board"
        >
          <BoardIcon size={14} />
          <span>Board</span>
        </button>

        <button
          type="button"
          className={`tasks-nav-btn ${activeTab === 'issues' ? 'active' : ''}`}
          onClick={() => onTabChange('issues')}
          title="Remote Repository Issues"
        >
          <IssueIcon size={14} />
          <span>Issues</span>
          {issuesCount > 0 && <span className="tasks-nav-count">{issuesCount}</span>}
        </button>

        <button
          type="button"
          className={`tasks-nav-btn ${activeTab === 'prs' ? 'active' : ''}`}
          onClick={() => onTabChange('prs')}
          title="Remote Repository Pull Requests"
        >
          <PullRequestIcon size={14} />
          <span>Pull Requests</span>
          {prsCount > 0 && <span className="tasks-nav-count">{prsCount}</span>}
        </button>

        <button
          type="button"
          className={`tasks-nav-btn ${activeTab === 'actions' ? 'active' : ''}`}
          onClick={() => onTabChange('actions')}
          title="CI/CD & GitHub Actions Workflows"
        >
          <WorkflowIcon size={14} />
          <span>Actions</span>
        </button>
      </div>

      {/* Right Controls: Repo details & Actions */}
      <div className="tasks-actions-bar">
        {repoInfo && (
          <div
            className="tasks-repo-chip"
            title={`Remote: ${repoInfo.remoteUrl}`}
          >
            <GitBranchIcon size={12} />
            <span className="tasks-repo-name">{repoInfo.owner}/{repoInfo.repo}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span className="tasks-repo-branch">{repoInfo.currentBranch}</span>
          </div>
        )}

        <button
          type="button"
          className="tasks-action-btn"
          onClick={onRefresh}
          title="Refresh issues and pull requests"
        >
          <RefreshIcon size={13} />
        </button>

        {activeTab === 'issues' && (
          <button
            type="button"
            className="tasks-action-btn primary"
            onClick={onOpenNewIssue}
          >
            <PlusIcon size={12} />
            <span>New Issue</span>
          </button>
        )}

        {activeTab === 'prs' && (
          <button
            type="button"
            className="tasks-action-btn primary"
            onClick={onOpenNewPR}
          >
            <PlusIcon size={12} />
            <span>New PR</span>
          </button>
        )}
      </div>
    </div>
  );
}
