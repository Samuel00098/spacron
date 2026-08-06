import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import {
  chatMessages,
  approveMailboxCard,
  mergeAndApproveMailboxCard,
  replyToMailboxCard,
  orchestratorTasks,
  type ChatMessage,
} from '$lib/stores/orchestrator';
import {
  mailbox,
  mailboxSeen,
  getMailboxCards,
  dismissMailboxCard,
  type MailboxCard,
} from '$lib/services/orchestrator/mailbox';
import MailboxCardView from './MailboxCard';
import './AgentNotifications.css';

// How long a plain "finished" card lingers before it clears itself, like a
// notification. Actionable cards (report / hand-off / question) and failure /
// needs-input cards never auto-clear — they wait on you.
const DONE_AUTODISMISS_MS = 10000;
// Cap how many completion cards stack at once so a busy fleet can't bury the bar.
const MAX_COMPLETION_CARDS = 4;

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
  const tasks = useStore(orchestratorTasks);

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [dismissedCompletions, setDismissedCompletions] = useState<Set<string>>(new Set());
  const doneTimers = useRef<Map<string, number>>(new Map());

  // Only surface completions that land *after* we start watching a project, so
  // opening a project doesn't dump its whole finished-task history on screen.
  const baselineRef = useRef<{ projectId: string; ts: number }>({ projectId: '', ts: Date.now() });
  if (baselineRef.current.projectId !== projectId) {
    baselineRef.current = { projectId, ts: Date.now() };
  }

  // Reset per-project transient state when the active project changes.
  useEffect(() => {
    setDismissedCompletions(new Set());
    for (const timer of doneTimers.current.values()) clearTimeout(timer);
    doneTimers.current.clear();
    setReplyingId(null);
    setReplyText('');
  }, [projectId]);

  // Clear any pending auto-dismiss timers on unmount.
  useEffect(() => {
    const timers = doneTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

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
        const id = m.id;
        doneTimers.current.set(
          id,
          window.setTimeout(() => {
            doneTimers.current.delete(id);
            setDismissedCompletions((prev) => {
              const next = new Set(prev);
              next.add(id);
              return next;
            });
          }, DONE_AUTODISMISS_MS),
        );
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
          <MailboxCardView
            key={item.key}
            card={item.card}
            now={now}
            className="agent-notif"
            replying={replyingId === item.card.id}
            replyText={replyText}
            hasWorktree={!!(item.card.kind === 'handoff' && item.card.taskId && tasks.some((t) => t.id === item.card.taskId && t.worktree))}
            onStartReply={() => startReply(item.card.id)}
            onCancelReply={cancelReply}
            onReplyChange={setReplyText}
            onSubmitReply={() => submitReply(item.card)}
            onApprove={() => void approveMailboxCard(projectId, item.card, rootPath)}
            onMergeApprove={() => void mergeAndApproveMailboxCard(projectId, item.card, rootPath)}
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
