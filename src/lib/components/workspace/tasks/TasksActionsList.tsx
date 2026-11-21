import { useEffect, useState, useMemo } from 'react';
import {
  listWorkflowRuns,
  getWorkflowRunJobs,
  rerunWorkflow,
  cancelWorkflowRun,
  type WorkflowRun,
  type WorkflowJob,
} from '$lib/services/work-items';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import { showToast } from '$lib/stores/notification';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import {
  SearchIcon,
  RefreshIcon,
  WorkflowIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  GitBranchIcon,
  ExternalLinkIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlayCircleIcon,
} from './TasksIcons';

interface TasksActionsListProps {
  projectId: string;
}

export default function TasksActionsList({ projectId }: TasksActionsListProps) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [branchFilter, setBranchFilter] = useState<string>('all');

  // Expanded Jobs map
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [jobsByRun, setJobsByRun] = useState<Record<number, WorkflowJob[]>>({});
  const [loadingJobs, setLoadingJobs] = useState<number | null>(null);

  // Action busy states
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);

  const loadRuns = async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const data = await listWorkflowRuns(projectId, {
        statusFilter: statusFilter !== 'all' ? statusFilter : undefined,
        branch: branchFilter !== 'all' ? branchFilter : undefined,
      });
      setRuns(data);
    } catch (err: any) {
      console.warn('Failed to load GitHub Actions workflow runs:', err);
      setError(typeof err === 'string' ? err : err?.message || 'Could not fetch workflow runs.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      void loadRuns();
    }
  }, [projectId, statusFilter, branchFilter]);

  const uniqueBranches = useMemo(() => {
    const set = new Set<string>();
    runs.forEach((r) => {
      if (r.headBranch) set.add(r.headBranch);
    });
    return Array.from(set).sort();
  }, [runs]);

  const branchOptions: DropdownOption[] = useMemo(() => {
    return [
      { value: 'all', label: 'All branches' },
      ...uniqueBranches.map((b) => ({ value: b, label: `Branch: ${b}` })),
    ];
  }, [uniqueBranches]);

  const statusOptions: DropdownOption[] = [
    { value: 'all', label: 'All statuses' },
    { value: 'success', label: 'Success' },
    { value: 'failure', label: 'Failed' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'queued', label: 'Queued' },
  ];

  const filteredRuns = useMemo(() => {
    if (!search.trim()) return runs;
    const q = search.toLowerCase();
    return runs.filter((r) => {
      return (
        r.name.toLowerCase().includes(q) ||
        r.displayTitle.toLowerCase().includes(q) ||
        r.headBranch.toLowerCase().includes(q) ||
        r.actor.login.toLowerCase().includes(q) ||
        `#${r.runNumber}`.includes(q) ||
        r.headSha.slice(0, 7).toLowerCase().includes(q)
      );
    });
  }, [runs, search]);

  const handleToggleJobs = async (runId: number) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }

    setExpandedRunId(runId);
    if (!jobsByRun[runId]) {
      setLoadingJobs(runId);
      try {
        const jobs = await getWorkflowRunJobs(projectId, runId);
        setJobsByRun((prev) => ({ ...prev, [runId]: jobs }));
      } catch (err) {
        console.warn('Failed to load jobs for run:', err);
        showToast('Could not load jobs for workflow run', 'error');
      } finally {
        setLoadingJobs(null);
      }
    }
  };

  const handleRerun = async (e: React.MouseEvent, runId: number) => {
    e.stopPropagation();
    setActionBusyId(runId);
    try {
      await rerunWorkflow(projectId, runId);
      showToast('Workflow re-run requested', 'success');
      await loadRuns(true);
    } catch (err: any) {
      showToast(typeof err === 'string' ? err : 'Failed to re-run workflow', 'error');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleCancel = async (e: React.MouseEvent, runId: number) => {
    e.stopPropagation();
    setActionBusyId(runId);
    try {
      await cancelWorkflowRun(projectId, runId);
      showToast('Workflow run cancelled', 'info');
      await loadRuns(true);
    } catch (err: any) {
      showToast(typeof err === 'string' ? err : 'Failed to cancel workflow', 'error');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleOpenRun = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    if (url) openUrlInPreviewPanel(url);
  };

  const formatDuration = (startStr?: string, endStr?: string) => {
    if (!startStr) return '';
    const start = new Date(startStr).getTime();
    const end = endStr ? new Date(endStr).getTime() : Date.now();
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}m ${remSec}s`;
  };

  const formatExactTime = (dateStr?: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatRelativeTime = (dateStr: string) => {
    if (!dateStr) return '';
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Search and Filters Bar */}
      <div className="tasks-filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 260 }}>
          <div className="tasks-search-input-wrap" style={{ flex: 1 }}>
            <SearchIcon size={12} />
            <input
              type="text"
              className="tasks-search-input"
              placeholder="Filter workflow runs by title, branch, #number..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Status Dropdown */}
          <div className="tasks-filter-dropdown-wrap">
            <Dropdown
              options={statusOptions}
              value={statusFilter}
              onChange={(val) => setStatusFilter(val)}
              ariaLabel="Filter by status"
            />
          </div>

          {/* Branch Dropdown */}
          {uniqueBranches.length > 0 && (
            <div className="tasks-filter-dropdown-wrap">
              <Dropdown
                options={branchOptions}
                value={branchFilter}
                onChange={(val) => setBranchFilter(val)}
                ariaLabel="Filter by branch"
              />
            </div>
          )}
        </div>

        {/* Refresh Button */}
        <button
          type="button"
          className="tasks-action-btn"
          onClick={() => void loadRuns(true)}
          disabled={loading || refreshing}
          title="Refresh GitHub Actions"
        >
          <RefreshIcon size={12} className={refreshing ? 'spin-icon' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Main Workflow Runs Container */}
      <div className="work-items-list-container">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="work-item-card"
                style={{ height: 64, opacity: 0.5, animation: 'pulse 1.5s infinite' }}
              />
            ))}
          </div>
        ) : error ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: 'var(--text-muted)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div style={{ color: 'var(--error, #ef4444)' }}>{error}</div>
            <button type="button" className="tasks-action-btn" onClick={() => void loadRuns(true)}>
              <RefreshIcon size={12} /> Retry
            </button>
          </div>
        ) : filteredRuns.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--text-muted)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <div style={{ opacity: 0.4 }}>
              <WorkflowIcon size={32} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>No workflow runs found</div>
            <div style={{ fontSize: 11.5 }}>
              {search || statusFilter !== 'all' || branchFilter !== 'all'
                ? 'Try clearing your search or status filter.'
                : 'No GitHub Actions runs found for this repository.'}
            </div>
          </div>
        ) : (
          filteredRuns.map((run) => {
            const isExpanded = expandedRunId === run.id;
            const jobs = jobsByRun[run.id] || [];
            const isBusy = actionBusyId === run.id;
            const isRunning = run.status === 'in_progress' || run.status === 'queued';
            const isSuccess = run.conclusion === 'success';
            const isFailed = run.conclusion === 'failure' || run.conclusion === 'timed_out';

            return (
              <div
                key={run.id}
                className="work-item-card"
                style={{ cursor: 'default' }}
                onClick={() => void handleToggleJobs(run.id)}
              >
                {/* Top Row: Status, Name, Run #, Display Title */}
                <div className="work-item-card-top">
                  <div className="work-item-title-group">
                    {/* Status Glyph */}
                    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                      {isSuccess ? (
                        <CheckCircleIcon size={14} className="check-glyph-success" />
                      ) : isFailed ? (
                        <XCircleIcon size={14} className="check-glyph-failed" />
                      ) : (
                        <ClockIcon size={14} className="check-glyph-running" />
                      )}
                    </span>

                    <span className="work-item-number">#{run.runNumber}</span>

                    <span className="work-item-title" title={run.displayTitle}>
                      {run.displayTitle}
                    </span>

                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        padding: '1px 6px',
                        background: 'var(--bg-tertiary, color-mix(in srgb, var(--text-primary) 6%, transparent))',
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    >
                      {run.name}
                    </span>
                  </div>

                  {/* Right Header: Status Badge & Quick Actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <span
                      className={`work-item-badge ${
                        isSuccess ? 'open' : isFailed ? 'closed' : 'draft'
                      }`}
                      style={{
                        textTransform: 'capitalize',
                        fontSize: 9.5,
                        padding: '2px 8px',
                      }}
                    >
                      {run.conclusion || run.status}
                    </span>

                    {/* Re-run button */}
                    <button
                      type="button"
                      className="tasks-action-btn"
                      style={{ padding: '2px 7px', fontSize: 10 }}
                      onClick={(e) => void handleRerun(e, run.id)}
                      disabled={isBusy || isRunning}
                      title="Re-run workflow"
                    >
                      <PlayCircleIcon size={11} />
                      <span>Re-run</span>
                    </button>

                    {/* Cancel button if running */}
                    {isRunning && (
                      <button
                        type="button"
                        className="tasks-action-btn"
                        style={{ padding: '2px 7px', fontSize: 10, color: 'var(--error, #ef4444)' }}
                        onClick={(e) => void handleCancel(e, run.id)}
                        disabled={isBusy}
                        title="Cancel run"
                      >
                        <XCircleIcon size={11} />
                        <span>Cancel</span>
                      </button>
                    )}

                    {/* Open in preview / browser button */}
                    {run.htmlUrl && (
                      <button
                        type="button"
                        className="tasks-action-btn"
                        style={{ padding: '2px 7px', fontSize: 10 }}
                        onClick={(e) => handleOpenRun(e, run.htmlUrl)}
                        title="Open in preview pane"
                      >
                        <ExternalLinkIcon size={11} />
                      </button>
                    )}

                    {/* Expand/Collapse Chevron */}
                    <button
                      type="button"
                      className="tasks-action-btn"
                      style={{ padding: '2px 5px' }}
                      title={isExpanded ? 'Collapse jobs' : 'Expand jobs'}
                    >
                      {isExpanded ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
                    </button>
                  </div>
                </div>

                {/* Bottom Meta Row */}
                <div className="work-item-card-meta">
                  <div className="work-item-meta-left">
                    {/* Event Pill */}
                    <span
                      style={{
                        fontSize: 9.5,
                        fontWeight: 500,
                        padding: '1px 6px',
                        background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                        color: 'var(--accent)',
                        borderRadius: 4,
                      }}
                    >
                      {run.event}
                    </span>

                    {/* Branch Pill */}
                    {run.headBranch && (
                      <span className="work-item-branch-pill">
                        <GitBranchIcon size={10} />
                        <span>{run.headBranch}</span>
                      </span>
                    )}

                    {/* Commit SHA */}
                    {run.headSha && (
                      <code style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                        {run.headSha.slice(0, 7)}
                      </code>
                    )}

                    {/* Time, Start, End & Working State */}
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {run.status === 'in_progress' ? (
                        <span className="actions-live-indicator working">
                          <span className="actions-live-dot" /> Working now (started {formatExactTime(run.runStartedAt || run.createdAt)})
                        </span>
                      ) : run.status === 'queued' ? (
                        <span className="actions-live-indicator queued">
                          ⏳ Queued · Waiting to be picked up
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          Started {formatExactTime(run.runStartedAt || run.createdAt)}
                          {run.updatedAt && (
                            <span> → Ended {formatExactTime(run.updatedAt)} ({formatDuration(run.runStartedAt || run.createdAt, run.updatedAt)})</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right: Author */}
                  <div className="work-item-meta-right">
                    <span className="work-item-author-chip">
                      {run.actor.avatarUrl && (
                        <img src={run.actor.avatarUrl} alt="" className="work-item-avatar" />
                      )}
                      <span>@{run.actor.login}</span>
                    </span>
                  </div>
                </div>

                {/* Expanded Jobs Breakdown */}
                {isExpanded && (
                  <div
                    style={{
                      marginTop: 10,
                      paddingTop: 10,
                      borderTop: '1px solid var(--border, rgba(127, 127, 127, 0.15))',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {loadingJobs === run.id ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 0' }}>
                        Loading jobs and steps…
                      </div>
                    ) : jobs.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 0' }}>
                        No individual jobs recorded for this run.
                      </div>
                    ) : (
                      jobs.map((job) => {
                        const jobSuccess = job.conclusion === 'success';
                        const jobFailed = job.conclusion === 'failure';
                        const isWorkingNow = job.status === 'in_progress';
                        return (
                          <div
                            key={job.id}
                            style={{
                              background: 'var(--bg-tertiary, color-mix(in srgb, var(--text-primary) 3%, transparent))',
                              border: '1px solid var(--border, rgba(127, 127, 127, 0.15))',
                              borderRadius: 6,
                              padding: '8px 10px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                            }}
                          >
                            {/* Job Header */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {jobSuccess ? (
                                  <CheckCircleIcon size={12} className="check-glyph-success" />
                                ) : jobFailed ? (
                                  <XCircleIcon size={12} className="check-glyph-failed" />
                                ) : (
                                  <ClockIcon size={12} className="check-glyph-running" />
                                )}
                                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                                  {job.name}
                                </span>
                                {isWorkingNow ? (
                                  <span className="actions-job-pill working">
                                    <span className="actions-live-dot" /> Working now
                                  </span>
                                ) : job.status === 'queued' ? (
                                  <span className="actions-job-pill queued">Queued · Waiting</span>
                                ) : jobSuccess ? (
                                  <span className="actions-job-pill success">Finished</span>
                                ) : jobFailed ? (
                                  <span className="actions-job-pill failed">Failed</span>
                                ) : null}
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--text-muted)' }}>
                                {job.startedAt && (
                                  <span>Started: {formatExactTime(job.startedAt)}</span>
                                )}
                                {job.completedAt ? (
                                  <span>Ended: {formatExactTime(job.completedAt)} ({formatDuration(job.startedAt, job.completedAt)})</span>
                                ) : job.startedAt ? (
                                  <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Running for {formatDuration(job.startedAt)}</span>
                                ) : null}
                                {job.htmlUrl && (
                                  <button
                                    type="button"
                                    className="check-details-link-btn"
                                    onClick={() => openUrlInPreviewPanel(job.htmlUrl)}
                                  >
                                    <span>Details</span>
                                    <ExternalLinkIcon size={10} />
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Job Steps Breakdown */}
                            {job.steps.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, paddingLeft: 18 }}>
                                {job.steps.map((step) => {
                                  const stepSuccess = step.conclusion === 'success';
                                  const stepFailed = step.conclusion === 'failure';
                                  const stepWorking = step.status === 'in_progress';
                                  return (
                                    <div
                                      key={step.number}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        fontSize: 10.5,
                                        color: 'var(--text-secondary)',
                                      }}
                                    >
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ fontSize: 9 }}>
                                          {stepSuccess ? '✓' : stepFailed ? '✗' : '•'}
                                        </span>
                                        <span style={{ fontWeight: stepWorking ? 600 : 400 }}>{step.name}</span>
                                        {stepWorking && (
                                          <span className="actions-step-tag working">active step</span>
                                        )}
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, color: 'var(--text-muted)' }}>
                                        {step.startedAt && (
                                          <span>{formatExactTime(step.startedAt)}</span>
                                        )}
                                        {step.completedAt ? (
                                          <span>→ {formatExactTime(step.completedAt)} ({formatDuration(step.startedAt, step.completedAt)})</span>
                                        ) : step.startedAt ? (
                                          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>running ({formatDuration(step.startedAt)})</span>
                                        ) : (
                                          <span>queued</span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}