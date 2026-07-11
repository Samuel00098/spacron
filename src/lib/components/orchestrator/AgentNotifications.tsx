import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import {
  chatMessages,
  approveMailboxCard,
  replyToMailboxCard,
  type ChatMessage,
} from '$lib/stores/orchestrator';
import {
  mailbox,
  mailboxSeen,
  getMailboxCards,
  dismissMailboxCard,
  type MailboxCard,
  type MailboxKind,
} from '$lib/services/orchestrator/mailbox';
import './AgentNotifications.css';

// How long a plain "finished" card lingers before it clears itself, like a
// notification. Actionable cards (report / hand-off / question) and failure /
// needs-input cards never auto-clear — they wait on you.
const DONE_AUTODISMISS_MS = 10000;
// Cap how many completion cards stack at once so a busy fleet can't bury the bar.
const MAX_COMPLETION_CARDS = 4;

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

function formatSecs(s: number | null | undefined): string {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

type NotifItem =
  | { key: string; ts: number; kind: 'mail'; card: MailboxCard }
  | { key: string; ts: number; kind: 'completion'; msg: ChatMessage };

/**
 * The bottom-right agent notification stack. Two card types float in as
 * work lands — actionable mailbox traffic (report / hand-off / question) you
 * can Approve / Reply / Dismiss, and task-completion cards summarizing what an
 * agent just did. Replaces the removed orchestrator panel: the same cards, but
 * surfaced as dismissible notifications instead of a docked transcript.
 * Renders nothing when there's nothing to show.
 */
export default function AgentNotifications() {
  const project = useStore(activeProject);
  const projectId = project?.id ?? '';
  const rootPath = project?.root_path ?? null;

  // Subscribe so the stack recomputes as traffic arrives and cards are worked off.
  const allMail = useStore(mailbox);
  const seen = useStore(mailboxSeen);
  const allChat = useStore(chatMessages);

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [dismissedCompletions, setDismissedCompletions] = useState<Set<string>>(new Set());
  const doneTimers = useRef<Set<string>>(new Set());

  // Only surface completions that land *after* we start watching a project, so
  // opening a project doesn't dump its whole finished-task history on screen.
  const baselineRef = useRef<{ projectId: string; ts: number }>({ projectId: '', ts: Date.now() });
  if (baselineRef.current.projectId !== projectId) {
    baselineRef.current = { projectId, ts: Date.now() };
  }

  // Reset per-project transient state when the active project changes.
  useEffect(() => {
    setDismissedCompletions(new Set());
    doneTimers.current = new Set();
    setReplyingId(null);
    setReplyText('');
  }, [projectId]);

  const mailCards = useMemo(
    () => getMailboxCards(projectId, { actionableOnly: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMail, seen, projectId],
  );

  const completionCards = useMemo(() => {
    const msgs = allChat[projectId] ?? [];
    const baseline = baselineRef.current.ts;
    return msgs
      .filter((m) => m.completion && m.ts >= baseline && !dismissedCompletions.has(m.id))
      .slice(-MAX_COMPLETION_CARDS);
  }, [allChat, projectId, dismissedCompletions]);

  // Auto-clear a plain "finished" card once its summary has settled. Failures and
  // needs-input cards are left for the user to clear deliberately.
  useEffect(() => {
    for (const m of completionCards) {
      const c = m.completion;
      if (c && c.status === 'done' && !c.summaryPending && !doneTimers.current.has(m.id)) {
        doneTimers.current.add(m.id);
        const id = m.id;
        window.setTimeout(() => {
          setDismissedCompletions((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }, DONE_AUTODISMISS_MS);
      }
    }
  }, [completionCards]);

  const items = useMemo<NotifItem[]>(() => {
    const merged: NotifItem[] = [
      ...mailCards.map((card): NotifItem => ({ key: `mb-${card.id}`, ts: card.createdAt, kind: 'mail', card })),
      ...completionCards.map((msg): NotifItem => ({ key: `cp-${msg.id}`, ts: msg.ts, kind: 'completion', msg })),
    ];
    // Ascending by time → newest sits at the bottom, nearest the corner.
    return merged.sort((a, b) => a.ts - b.ts);
  }, [mailCards, completionCards]);

  const now = Date.now();

  if (!projectId || items.length === 0) return null;

  function startReply(id: string) {
    setReplyingId(id);
    setReplyText('');
  }
  function cancelReply() {
    setReplyingId(null);
    setReplyText('');
  }
  function submitReply(card: MailboxCard) {
    const text = replyText.trim();
    if (!text) return;
    void replyToMailboxCard(projectId, card, text, rootPath);
    cancelReply();
  }
  function dismissCompletion(id: string) {
    setDismissedCompletions((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  return (
    <div className="agent-notifs" aria-label="Agent notifications">
      {items.map((item) =>
        item.kind === 'mail' ? (
          <MailNotification
            key={item.key}
            card={item.card}
            now={now}
            replying={replyingId === item.card.id}
            replyText={replyText}
            onStartReply={() => startReply(item.card.id)}
            onCancelReply={cancelReply}
            onReplyChange={setReplyText}
            onSubmitReply={() => submitReply(item.card)}
            onApprove={() => void approveMailboxCard(projectId, item.card, rootPath)}
            onDismiss={() => dismissMailboxCard(item.card.id)}
          />
        ) : (
          <CompletionNotification
            key={item.key}
            msg={item.msg}
            onDismiss={() => dismissCompletion(item.msg.id)}
          />
        ),
      )}
    </div>
  );
}

function MailNotification({
  card, now, replying, replyText,
  onStartReply, onCancelReply, onReplyChange, onSubmitReply, onApprove, onDismiss,
}: {
  card: MailboxCard;
  now: number;
  replying: boolean;
  replyText: string;
  onStartReply: () => void;
  onCancelReply: () => void;
  onReplyChange: (v: string) => void;
  onSubmitReply: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`agent-notif orc-mb-card orc-mb-${card.kind}`}>
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

      {card.files.length > 0 && (
        <div className="orc-mb-files">
          {card.files.slice(0, 4).map((f) => (
            <span className="orc-mb-file" key={f} title={f}>{f}</span>
          ))}
          {card.files.length > 4 && <span className="orc-mb-file more">+{card.files.length - 4}</span>}
        </div>
      )}

      {replying ? (
        <div className="orc-mb-reply">
          <textarea
            className="orc-mb-reply-input"
            value={replyText}
            autoFocus
            rows={2}
            placeholder={`Reply to ${card.from}…`}
            onChange={(e) => onReplyChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmitReply(); }
              else if (e.key === 'Escape') { e.preventDefault(); onCancelReply(); }
            }}
          />
          <div className="orc-mb-reply-actions">
            <button className="orc-mb-btn ghost" onClick={onCancelReply}>Cancel</button>
            <button className="orc-mb-btn primary" onClick={onSubmitReply} disabled={!replyText.trim()}>Send</button>
          </div>
        </div>
      ) : (
        <div className="orc-mb-actions">
          <button className="orc-mb-btn primary" onClick={onApprove} title="Tell the agent to proceed">Approve</button>
          <button className="orc-mb-btn" onClick={onStartReply} title="Send the agent a follow-up">Reply</button>
          <button className="orc-mb-btn ghost" onClick={onDismiss} title="Clear this card">Dismiss</button>
        </div>
      )}
    </div>
  );
}

function CompletionNotification({ msg, onDismiss }: { msg: ChatMessage; onDismiss: () => void }) {
  const c = msg.completion;
  if (!c) return null;
  const icon = c.status === 'done' ? '✅' : c.status === 'failed' ? '❌' : '⚠️';
  const statusLabel = c.status === 'done' ? 'finished' : c.status === 'failed' ? 'failed' : 'needs input';

  return (
    <div className={`agent-notif orc-completion orc-completion-${c.status}`}>
      <span className="orc-comp-icon" aria-hidden="true">{icon}</span>
      <div className="orc-comp-body">
        <span className="orc-comp-headline">
          {c.agentName}
          <span className="orc-comp-status">{statusLabel}</span>
          {c.elapsedSec != null && <span className="orc-comp-time">· {formatSecs(c.elapsedSec)}</span>}
        </span>
        <span className="orc-comp-task" title={c.taskTitle}>{c.taskTitle}</span>
        {c.reason && <span className="orc-comp-reason">{c.reason}</span>}
        {c.summaryPending ? (
          <span className="orc-comp-loading">
            <span className="orc-typing-sm"><span></span><span></span><span></span></span>Summarizing…
          </span>
        ) : c.summary ? (
          <p className="orc-comp-summary">{c.summary}</p>
        ) : null}
      </div>
      <button className="agent-notif-close" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
