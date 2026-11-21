import type { WorkItemPR, WorkItemComment, PRChecksSummary } from '$lib/services/work-items';
import MarkdownPreview from '$lib/components/preview/MarkdownPreview';
import {
  PullRequestIcon,
  GitMergeIcon,
  XCircleIcon,
  CheckCircleIcon,
  MessageSquareIcon,
  GitBranchIcon,
  ClockIcon,
} from './TasksIcons';

interface TimelineEvent {
  id: string;
  type: 'opened' | 'comment' | 'checks' | 'merged' | 'closed' | 'open_status';
  timestamp: string;
  title: string;
  subtitle?: string;
  author?: {
    login: string;
    avatarUrl?: string;
  };
  content?: string;
  badge?: {
    text: string;
    tone: 'success' | 'error' | 'warning' | 'purple' | 'neutral';
  };
}

export default function TasksPRTimeline({
  pr,
  comments,
  checks,
}: {
  pr: WorkItemPR;
  comments: WorkItemComment[];
  checks: PRChecksSummary | null;
}) {
  // Aggregate and sort events
  const events: TimelineEvent[] = [];

  // 1. Opened
  events.push({
    id: 'opened',
    type: 'opened',
    timestamp: pr.createdAt,
    title: `Pull request #${pr.number} opened`,
    subtitle: `from ${pr.headBranch} into ${pr.baseBranch}`,
    author: pr.author,
    content: pr.body,
    badge: { text: 'Opened', tone: 'success' },
  });

  // 2. Checks (if available)
  if (checks && checks.total > 0) {
    events.push({
      id: 'checks',
      type: 'checks',
      timestamp: pr.updatedAt || pr.createdAt,
      title: `CI / Automated Checks (${checks.total} runs)`,
      subtitle: `Commit ${pr.headSha.slice(0, 7)}: ${checks.passed} passed, ${checks.failed} failed`,
      badge: {
        text: checks.failed > 0 ? `${checks.failed} failed` : `${checks.passed} passed`,
        tone: checks.failed > 0 ? 'error' : 'success',
      },
    });
  }

  // 3. Comments
  comments.forEach((c) => {
    events.push({
      id: `comment-${c.id}`,
      type: 'comment',
      timestamp: c.createdAt,
      title: `${c.author.login} commented`,
      author: c.author,
      content: c.body,
    });
  });

  // 4. Merged or Closed
  if (pr.state === 'merged') {
    events.push({
      id: 'merged',
      type: 'merged',
      timestamp: pr.mergedAt || pr.updatedAt || pr.createdAt,
      title: `Merged into ${pr.baseBranch}`,
      subtitle: `Head commit ${pr.headSha.slice(0, 7)} integrated`,
      author: pr.author,
      badge: { text: 'Merged', tone: 'purple' },
    });
  } else if (pr.state === 'closed') {
    events.push({
      id: 'closed',
      type: 'closed',
      timestamp: pr.closedAt || pr.updatedAt || pr.createdAt,
      title: `Closed without merging`,
      subtitle: `Target: ${pr.baseBranch}`,
      badge: { text: 'Closed', tone: 'error' },
    });
  } else {
    events.push({
      id: 'open-active',
      type: 'open_status',
      timestamp: new Date().toISOString(),
      title: `Currently Open & Awaiting Review`,
      subtitle: `Target branch: ${pr.baseBranch}`,
      badge: { text: 'Active', tone: 'success' },
    });
  }

  // Sort chronological
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const getEventIcon = (type: TimelineEvent['type']) => {
    switch (type) {
      case 'opened':
        return <PullRequestIcon size={14} style={{ color: 'var(--success, #16a34a)' }} />;
      case 'merged':
        return <GitMergeIcon size={14} style={{ color: '#9333ea' }} />;
      case 'closed':
        return <XCircleIcon size={14} style={{ color: 'var(--error, #dc2626)' }} />;
      case 'checks':
        return <CheckCircleIcon size={14} style={{ color: 'var(--accent)' }} />;
      case 'comment':
        return <MessageSquareIcon size={14} style={{ color: 'var(--text-muted)' }} />;
      default:
        return <ClockIcon size={14} style={{ color: 'var(--accent)' }} />;
    }
  };

  return (
    <div className="pr-timeline-container">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
          Pull Request Timeline ({events.length} milestones)
        </h4>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {new Date(pr.createdAt).toLocaleDateString()} → {pr.mergedAt ? new Date(pr.mergedAt).toLocaleDateString() : 'Present'}
        </span>
      </div>

      <div className="pr-timeline-track">
        {events.map((evt, idx) => (
          <div key={evt.id} className="pr-timeline-item">
            {/* Timeline Marker & Line */}
            <div className="pr-timeline-marker-col">
              <div className={`pr-timeline-icon-wrap ${evt.type}`}>
                {getEventIcon(evt.type)}
              </div>
              {idx < events.length - 1 && <div className="pr-timeline-line" />}
            </div>

            {/* Event Card */}
            <div className="pr-timeline-content-card">
              <div className="pr-timeline-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {evt.author?.avatarUrl && (
                    <img src={evt.author.avatarUrl} alt="" className="work-item-avatar" />
                  )}
                  <strong style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                    {evt.title}
                  </strong>
                  {evt.badge && (
                    <span className={`work-item-badge ${evt.badge.tone}`}>
                      {evt.badge.text}
                    </span>
                  )}
                </div>

                <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  {new Date(evt.timestamp).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              {evt.subtitle && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <GitBranchIcon size={10} />
                  <span>{evt.subtitle}</span>
                </div>
              )}

              {evt.content && (
                <div className="pr-timeline-body" style={{ marginTop: 8 }}>
                  <MarkdownPreview content={evt.content} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
