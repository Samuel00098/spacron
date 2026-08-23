import { type MailboxCard, type MailboxKind } from '$lib/services/orchestrator/mailbox';

/** A short label + glyph per kind. */
const KIND_GLYPH: Record<MailboxKind, string> = {
  claim: '🔒', release: '🔓', handoff: '➡️', ask: '❓', report: '📣', done: '✅', note: '📝',
};
const KIND_LABEL: Record<MailboxKind, string> = {
  claim: 'claim', release: 'release', handoff: 'hand-off', ask: 'question', report: 'report', done: 'done', note: 'note',
};

function ageLabel(ts: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface MailboxCardProps {
  card: MailboxCard;
  now: number;
  /** Whether this card is in reply mode (showing the textarea). */
  replying?: boolean;
  /** Current reply text when in reply mode. */
  replyText?: string;
  /** True when the card's task has a worktree — shows Merge & Approve. */
  hasWorktree?: boolean;
  /** CSS class added to the root element. */
  className?: string;
  /** Extra content appended below the card content (before reply/actions). */
  children?: React.ReactNode;

  // ─── Callbacks ──────────────────────────────────────────────────────────
  onStartReply?: () => void;
  onCancelReply?: () => void;
  onReplyChange?: (text: string) => void;
  onSubmitReply?: () => void;
  onApprove?: () => void;
  onMergeApprove?: () => void;
  onDismiss?: () => void;
}

/**
 * Mailbox card component, rendered by the notification stack
 * (AgentNotifications).
 * Accepts card data and action callbacks as props — no store imports.
 */
export default function MailboxCardView({
  card, now, replying, replyText, hasWorktree,
  className, children,
  onStartReply, onCancelReply, onReplyChange, onSubmitReply,
  onApprove, onMergeApprove, onDismiss,
}: MailboxCardProps) {
  return (
    <div className={`orc-mb-card orc-mb-${card.kind}${className ? ` ${className}` : ''}`}>
      <div className="orc-mb-meta">
        <span className="orc-mb-kind" title={KIND_LABEL[card.kind]}>
          <span className="orc-mb-glyph" aria-hidden="true">{KIND_GLYPH[card.kind]}</span>
          {KIND_LABEL[card.kind]}
        </span>
        <span className="orc-mb-route">
          <strong>{card.from}</strong>
          <span className="orc-mb-arrow"> → </span>
          {card.to ?? 'team'}
        </span>
        <span className="orc-mb-age">{ageLabel(card.createdAt, now)}</span>
      </div>

      <div className="orc-mb-text">{card.text}</div>

      {(card.files.length > 0 || card.worktreeBranch) && (
        <div className="orc-mb-files">
          {card.worktreeBranch && (
            <span className="orc-mb-file orc-mb-branch" title={`Branch: ${card.worktreeBranch}`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 3, verticalAlign: 'middle'}}>
                <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 01-9 9" />
              </svg>
              {card.worktreeBranch}
            </span>
          )}
          {card.files.slice(0, 4 - (card.worktreeBranch ? 1 : 0)).map((f) => (
            <span className="orc-mb-file" key={f} title={f}>{f}</span>
          ))}
          {card.files.length > 4 && <span className="orc-mb-file more">+{card.files.length - 4 + (card.worktreeBranch ? 1 : 0)}</span>}
        </div>
      )}

      {children}

      {replying ? (
        <div className="orc-mb-reply">
          <textarea
            className="orc-mb-reply-input"
            value={replyText ?? ''}
            autoFocus
            rows={2}
            placeholder={`Reply to ${card.from}…`}
            onChange={(e) => onReplyChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmitReply?.(); }
              else if (e.key === 'Escape') { e.preventDefault(); onCancelReply?.(); }
            }}
          />
          <div className="orc-mb-reply-actions">
            <button className="orc-mb-btn ghost" onClick={onCancelReply}>Cancel</button>
            <button className="orc-mb-btn primary" onClick={onSubmitReply} disabled={!replyText?.trim()}>Send</button>
          </div>
        </div>
      ) : (
        <div className="orc-mb-actions">
          {hasWorktree && onMergeApprove ? (
            <button className="orc-mb-btn primary" onClick={onMergeApprove} title="Merge the worktree branch into main, then tell the agent to proceed">
              Merge & Approve
            </button>
          ) : (
            <button className="orc-mb-btn primary" onClick={onApprove} title="Tell the agent to proceed">Approve</button>
          )}
          <button className="orc-mb-btn" onClick={onStartReply} title="Send the agent a follow-up">Reply</button>
          <button className="orc-mb-btn ghost" onClick={onDismiss} title="Clear this card">Dismiss</button>
        </div>
      )}
    </div>
  );
}
