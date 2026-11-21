import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listWorkflowRuns,
  getWorkflowRunJobs,
  getWorkflowJobLog,
  rerunWorkflow,
  cancelWorkflowRun,
  type WorkflowRun,
  type WorkflowJob,
} from '$lib/services/work-items';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown';
import { showToast } from '$lib/stores/notification';
import { openUrlInPreviewPanel } from '$lib/stores/preview';
import { copyTextToClipboard } from '$lib/utils/clipboard';
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

const ACTIVE_REFRESH_MS = 5_000;
const IDLE_REFRESH_MS = 15_000;

function isFailure(conclusion?: string): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out'
    || conclusion === 'startup_failure' || conclusion === 'stale';
}

function isActiveRun(run: WorkflowRun): boolean {
  return ['queued', 'in_progress', 'requested', 'pending', 'waiting'].includes(run.status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const [copyingRunId, setCopyingRunId] = useState<number | null>(null);
  const runRequest = useRef(0);

  const handleCopyFailure = async (event: React.MouseEvent, run: WorkflowRun) => {
    event.stopPropagation();
    setCopyingRunId(run.id);
    const report = [
      `CI failure: ${run.name} #${run.runNumber} (${run.conclusion})`,
      run.displayTitle,
      run.headBranch && `Branch: ${run.headBranch}`,
      run.headSha && `Commit: ${run.headSha}`,
      run.htmlUrl,
    ].filter(Boolean);
    try {
      const jobs = await getWorkflowRunJobs(projectId, run.id);
      const failedJobs = jobs.filter((job) => isFailure(job.conclusion));
      const logs = await Promise.allSettled(
        failedJobs.slice(0, 6).map((job) => getWorkflowJobLog(projectId, job.id)),
      );
      for (const [index, job] of failedJobs.entries()) {
        report.push('', `Job: ${job.name} (${job.conclusion})`);
        if (job.htmlUrl) report.push(job.htmlUrl);
        if (job.failureReason) report.push(`Reason: ${job.failureReason}`);
        for (const step of job.steps.filter((step) => isFailure(step.conclusion))) {
          report.push(`Failed step: ${step.name} (${step.conclusion})`);
        }
        const log = logs[index];
        if (!log) report.push('Log omitted from this report. See the job link for full output.');
        else if (log.status === 'fulfilled') report.push('Log excerpt:', log.value);
        else report.push(errorMessage(log.reason));
      }
      if (failedJobs.length === 0) report.push('', 'The provider reported no failed jobs for this run.');
    } catch (error) {
      report.push('', `Job details unavailable: ${errorMessage(error)}`);
    }

    try {
      await copyTextToClipboard(report.join('\n'));
      showToast('Failure details copied', 'success');
    } catch {
      showToast('Could not copy failure details', 'error');
    } finally {
      setCopyingRunId(null);
    }
  };

  const loadRuns = useCallback(async (mode: 'initial' | 'manual' | 'poll' = 'initial') => {
    const request = ++runRequest.current;
    if (mode === 'manual') setRefreshing(true);
    if (mode === 'initial') setLoading(true);
    if (mode !== 'poll') setError(null);

    try {
      const data = await listWorkflowRuns(projectId, {
        statusFilter: statusFilter !== 'all' ? statusFilter : undefined,
        branch: branchFilter !== 'all' ? branchFilter : undefined,
      });
      if (request === runRequest.current) setRuns(data);
    } catch (err) {
      if (request === runRequest.current && mode !== 'poll') setError(errorMessage(err));
    } finally {
      if (request === runRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [projectId, statusFilter, branchFilter]);

  useEffect(() => {
    if (projectId) void loadRuns();
    return () => { runRequest.current += 1; };
  }, [projectId, loadRuns]);

  const hasActiveRuns = runs.some(isActiveRun);

  useEffect(() => {
    if (!projectId || loading || refreshing || error) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    function schedulePoll() {
      timer = setTimeout(async () => {
        await loadRuns('poll');
        if (!stopped) schedulePoll();
      }, hasActiveRuns ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
    }
    schedulePoll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [error, hasActiveRuns, loadRuns, loading, projectId, refreshing]);

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

  const expandedRun = runs.find((run) => run.id === expandedRunId);
  const expandedStatus = expandedRun?.status;
  const expandedIsActive = expandedRun ? isActiveRun(expandedRun) : false;

  useEffect(() => {
    if (expandedRunId === null || expandedStatus === undefined || loading) return;
    const runId = expandedRunId;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function refreshJobs() {
      setLoadingJobs(runId);
      try {
        const jobs = await getWorkflowRunJobs(projectId, runId);
        if (!stopped) setJobsByRun((prev) => ({ ...prev, [runId]: jobs }));
      } catch (err) {
        if (!stopped) console.warn('Failed to load jobs for run:', err);
      } finally {
        if (!stopped) {
          setLoadingJobs(null);
          if (expandedIsActive) timer = setTimeout(refreshJobs, ACTIVE_REFRESH_MS);
        }
      }
    }

    void refreshJobs();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [expandedIsActive, expandedRunId, expandedStatus, loading, projectId]);

  const handleRerun = async (e: React.MouseEvent, runId: number) => {
    e.stopPropagation();
    setActionBusyId(runId);
    try {
      await rerunWorkflow(projectId, runId);
      showToast('Workflow re-run requested', 'success');
      await loadRuns('manual');
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
      await loadRuns('manual');
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
      <div className="tasks-filter-bar tasks-actions-filter-bar">
        <div className="tasks-search-input-wrap tasks-actions-search-wrap">
          <SearchIcon size={12} />
          <input
            type="text"
            className="tasks-search-input"
            placeholder="Filter actions by title, branch, #number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="tasks-actions-filter-group">
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

          {/* Refresh Button */}
          <button
            type="button"
            className="tasks-action-btn"
            onClick={() => void loadRuns('manual')}
            disabled={loading || refreshing}
            title="Refresh CI/CD runs"
          >
            <RefreshIcon size={12} className={refreshing ? 'spin-icon' : ''} />
            <span>Refresh</span>
          </button>
        </div>
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
            <button
              type="button"
              className="tasks-action-btn"
              onClick={async () => {
                try {
                  await copyTextToClipboard(error);
                  showToast('Error copied', 'success');
                } catch {
                  showToast('Could not copy the error', 'error');
                }
              }}
            >
              Copy error
            </button>
            <button type="button" className="tasks-action-btn" onClick={() => void loadRuns('manual')}>
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
                : 'No CI/CD runs found for this repository.'}
            </div>
          </div>
        ) : (
          filteredRuns.map((run) => {
            const isExpanded = expandedRunId === run.id;
            const jobs = jobsByRun[run.id] || [];
            const isBusy = actionBusyId === run.id;
            const isRunning = isActiveRun(run);
            const isSuccess = run.conclusion === 'success';
            const isFailed = isFailure(run.conclusion);

            return (
              <div
                key={run.id}
                className="work-item-card"
                style={{ cursor: 'default' }}
                onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
              >
                {/* Top Row: Status, Name, Run #, Display Title */}
                <div className="work-item-card-top" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div className="work-item-title-group" style={{ flexWrap: 'wrap', flex: '1 1 200px', minWidth: 0 }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
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

                    {isFailed && (
                      <button
                        type="button"
                        className="tasks-action-btn"
                        style={{ padding: '2px 7px', fontSize: 10 }}
                        onClick={(e) => void handleCopyFailure(e, run)}
                        disabled={copyingRunId !== null}
                        title="Copy failed jobs, steps and available logs"
                      >
                        {copyingRunId === run.id ? 'Copying…' : 'Copy failure'}
                      </button>
                    )}

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
                <div className="work-item-card-meta" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <div className="work-item-meta-left" style={{ flexWrap: 'wrap', gap: 6, minWidth: 0, flex: 1 }}>
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
                    {loadingJobs === run.id && !jobsByRun[run.id] ? (
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
                        const jobFailed = isFailure(job.conclusion);
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

                            {job.failureReason && (
                              <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                                {job.failureReason}
                              </span>
                            )}

                            {/* Job Steps Breakdown */}
                            {job.steps.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, paddingLeft: 18 }}>
                                {job.steps.map((step) => {
                                  const stepSuccess = step.conclusion === 'success';
                                  const stepFailed = isFailure(step.conclusion);
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
