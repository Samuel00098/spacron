import { dismissCloneJob, type CloneJob } from '$lib/stores/cloneJobs';
import StatusIcon from './statusIcons';

/**
 * A background `git clone`, shown at the top of the agent notification stack.
 * It clears itself once the project opens; a failure stays until dismissed or
 * retried. Shares the completion card's shell so the stack reads as one surface.
 */
export default function CloneProgressCard({ job }: { job: CloneJob }) {
  const failed = job.status === 'failed';
  return (
    <div
      className={`agent-notif orc-completion clone-card${failed ? ' orc-completion-failed' : ' is-running'}`}
      role="status"
      aria-live="polite"
    >
      <span className="orc-comp-icon" aria-hidden="true">
        {failed ? <StatusIcon kind="failed" /> : <span className="clone-card-spinner" />}
      </span>
      <div className="orc-comp-body">
        <span className="orc-comp-headline">
          <span className="orc-comp-agent" title={job.label}>{job.label}</span>
          <span className="orc-comp-status">{failed ? 'clone failed' : 'cloning'}</span>
          {!failed && job.percent != null && <span className="orc-comp-time">{job.percent}%</span>}
        </span>
        {failed ? (
          <>
            <span className="orc-comp-reason">{job.error}</span>
            <div className="clone-card-actions">
              <button type="button" className="orc-mb-btn primary" onClick={job.retry}>Retry</button>
            </div>
          </>
        ) : (
          <>
            <span className="orc-comp-task">{job.phase}…</span>
            <div
              className={`clone-card-bar${job.percent == null ? ' is-indeterminate' : ''}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={job.percent ?? undefined}
              aria-label={`Cloning ${job.label}`}
            >
              <span style={job.percent == null ? undefined : { width: `${job.percent}%` }} />
            </div>
          </>
        )}
      </div>
      {failed && (
        <button className="agent-notif-close" onClick={() => dismissCloneJob(job.id)} aria-label="Dismiss" title="Dismiss">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
