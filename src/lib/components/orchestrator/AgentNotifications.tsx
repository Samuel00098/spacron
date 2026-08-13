import { useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import {
  chatMessages,
  approveMailboxCard,
  mergeAndApproveMailboxCard,
  replyToMailboxCard,
  orchestratorTasks,
  sessionIsRunning,
  type ChatMessage,
} from '$lib/stores/orchestrator';
import { setActiveSession } from '$lib/stores/terminal';
import {
  mailbox,
  mailboxSeen,
  getMailboxCards,
  dismissMailboxCard,
  type MailboxCard,
} from '$lib/services/orchestrator/mailbox';
import {
  inboxState,
  acknowledge,
  markDismissed,
  getDismissedIds,
} from '$lib/services/orchestrator/inbox';
import MailboxCardView from './MailboxCard';
import StatusIcon from './statusIcons';
import { showSystemNotification } from '$lib/stores/zustand/notification';
import './AgentNotifications.css';

// How long a plain "finished" card lingers before it clears itself, like a
// notification. Actionable cards (report / hand-off / question) and failure /
// needs-input cards never auto-clear — they wait on you.
const DONE_AUTODISMISS_MS = 10000;
// Cap how many completion cards stack at once so a busy fleet can't bury the bar.
const MAX_COMPLETION_CARDS = 4;
// How many member rows a grouped burst card renders before collapsing to "+N more".
const MAX_GROUP_ROWS = 3;

function formatSecs(s: number | null | undefined): string {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

type CompletionGroup = {
  key: string;
  status: 'done' | 'failed' | 'blocked';
  members: ChatMessage[];
};

function newestTs(group: CompletionGroup): number {
  return Math.max(...group.members.map((m) => m.ts));
}

type NotifItem =
  | { key: string; ts: number; kind: 'mail'; card: MailboxCard }
  | { key: string; ts: number; kind: 'completion'; group: CompletionGroup };

/**
 * The bottom-right agent notification stack. Two card types float in as
 * work lands — actionable mailbox traffic (report / hand-off / question) you
 * can Approve / Reply / Dismiss, and task-completion cards summarizing what an
 * agent just did. Plain finishes that land close together group into one
 * "3 agents finished" card so a busy fleet reads as one event. Replaces the
 * removed orchestrator panel: the same cards, but surfaced as dismissible
 * notifications instead of a docked transcript. Renders nothing when there's
 * nothing to show.
 *
 * This is the single transient notification surface for agent events — the
 * orchestrator and terminal layers deliberately do NOT raise their own toasts
 * for completions anymore (see the dedupe notes in orchestrator.ts / terminal.ts).
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
  // Dismissal now lives in the persisted inbox rather than component state, so
  // a card cleared here stays cleared across remounts and restarts.
  const inbox = useStore(inboxState);

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const doneTimers = useRef<Map<string, number>>(new Map());
  // Completion ids already raised as an OS notification while the app was hidden.
  const systemPinged = useRef<Set<string>>(new Set());

  // Only surface completions that land *after* we start watching a project, so
  // opening a project doesn't dump its whole finished-task history on screen.
  const baselineRef = useRef<{ projectId: string; ts: number }>({ projectId: '', ts: Date.now() });
  if (baselineRef.current.projectId !== projectId) {
    baselineRef.current = { projectId, ts: Date.now() };
  }

  // Reset per-project transient state when the active project changes. Dismissal
  // is no longer reset here — it is per-project in the inbox store already.
  useEffect(() => {
    for (const timer of doneTimers.current.values()) clearTimeout(timer);
    doneTimers.current.clear();
    systemPinged.current.clear();
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

  // Ids cleared from this stack. `mailboxSeen` covers the current session;
  // this set additionally covers everything cleared before the last restart.
  const dismissed = useMemo(
    () => getDismissedIds(projectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inbox, projectId],
  );

  const mailCards = useMemo(
    () => getMailboxCards(projectId, { actionableOnly: true }).filter((c) => !dismissed.has(c.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allMail, seen, dismissed, projectId],
  );

  // Group completions by kind: every plain "done" lands in one burst card (they
  // auto-dismiss in seconds, so co-located finishes are near-certainly the same
  // wave of work), while failed / blocked cards stay individual — each one is an
  // actionable decision that should never be buried inside a list.
  const completionGroups = useMemo<CompletionGroup[]>(() => {
    const msgs = allChat[projectId] ?? [];
    const baseline = baselineRef.current.ts;
    const pending = msgs
      .filter((m) => m.completion && m.ts >= baseline && !dismissed.has(m.id))
      .slice(-MAX_COMPLETION_CARDS * 3);
    const done = pending.filter((m) => m.completion!.status === 'done').slice(-MAX_COMPLETION_CARDS);
    const others = pending.filter((m) => m.completion!.status !== 'done');

    const groups: CompletionGroup[] = [];
    if (done.length > 0) groups.push({ key: 'cp-done', status: 'done', members: done });
    for (const m of others) {
      groups.push({ key: `cp-${m.id}`, status: m.completion!.status, members: [m] });
    }
    // Ascending by time → newest sits at the bottom, nearest the corner.
    groups.sort((a, b) => newestTs(a) - newestTs(b));
    return groups;
  }, [allChat, projectId, dismissed]);

  // Auto-clear a plain "finished" burst once its summaries have settled.
  // Failures and needs-input cards are left for the user to clear deliberately.
  //
  // NOTE: the timer captures `g.members` at the moment it is set — a member that
  // joins the group AFTER the timer is armed is NOT dismissed by it. That is
  // deliberate: the recomputed group then gets its own timer once the newcomer's
  // summary resolves, so every card still gets its full ten seconds. Don't
  // "fix" the staleness by reading fresh state inside the timeout.
  useEffect(() => {
    for (const g of completionGroups) {
      if (g.status !== 'done') continue;
      if (g.members.some((m) => m.completion?.summaryPending)) continue;
      if (doneTimers.current.has(g.key)) continue;
      const key = g.key;
      const owner = projectId;
      // Time the dismissal from the burst's newest arrival so a straggler
      // finishing mid-burst still gets its full ten seconds.
      const newest = newestTs(g);
      const delay = Math.max(0, DONE_AUTODISMISS_MS - (Date.now() - newest));
      doneTimers.current.set(
        key,
        window.setTimeout(() => {
          doneTimers.current.delete(key);
          // Dismissed, deliberately NOT read: the timer firing is exactly the
          // case where the user was looking elsewhere. It leaves the corner
          // and stays bold in the inbox.
          markDismissed(owner, g.members.map((m) => m.id));
        }, delay),
      );
    }
  }, [completionGroups, projectId]);

  // When the window is hidden, a completion card is invisible — raise it as an
  // OS notification instead (once per card). When the window is visible the
  // floating card IS the notification, so nothing fires.
  useEffect(() => {
    if (typeof document === 'undefined' || !document.hidden) return;
    for (const g of completionGroups) {
      for (const m of g.members) {
        if (systemPinged.current.has(m.id)) continue;
        systemPinged.current.add(m.id);
        const c = m.completion;
        if (!c) continue;
        showSystemNotification(
          `${c.status === 'done' ? 'Agent finished' : c.status === 'failed' ? 'Agent failed' : 'Agent needs input'} — ${c.agentName}: ${c.taskTitle}`,
          c.status === 'done' ? 'success' : c.status === 'failed' ? 'error' : 'warning',
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completionGroups, projectId]);

  const items = useMemo<NotifItem[]>(() => {
    const merged: NotifItem[] = [
      ...mailCards.map((card): NotifItem => ({ key: `mb-${card.id}`, ts: card.createdAt, kind: 'mail', card })),
      ...completionGroups.map((group): NotifItem => ({ key: group.key, ts: newestTs(group), kind: 'completion', group })),
    ];
    // Ascending by time → newest sits at the bottom, nearest the corner.
    return merged.sort((a, b) => a.ts - b.ts);
  }, [mailCards, completionGroups]);

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
  // Closing a card by hand is an acknowledgement: it clears the corner *and*
  // clears the unread flag. The auto-dismiss timer above deliberately does not.
  function dismissCompletionGroup(group: CompletionGroup) {
    for (const m of group.members) acknowledge(projectId, m.id);
  }
  function dismissMail(id: string) {
    dismissMailboxCard(id);
    acknowledge(projectId, id);
  }
  // "Show terminal" for a single-member card whose agent session is still live.
  function showGroupTerminal(group: CompletionGroup): (() => void) | undefined {
    if (group.members.length !== 1) return undefined;
    const taskId = group.members[0].completion?.taskId;
    if (!taskId) return undefined;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    const sid = task.assignedSessionId ?? task.lastSessionId ?? null;
    if (sid == null || !sessionIsRunning(task.projectId, sid)) return undefined;
    return () => setActiveSession(sid);
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
            onDismiss={() => dismissMail(item.card.id)}
          />
        ) : (
          <CompletionNotification
            key={item.key}
            group={item.group}
            onShow={showGroupTerminal(item.group)}
            onDismiss={() => dismissCompletionGroup(item.group)}
          />
        ),
      )}
    </div>
  );
}

function TerminalGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function CompletionNotification({
  group,
  onDismiss,
  onShow,
}: {
  group: CompletionGroup;
  onDismiss: () => void;
  onShow?: () => void;
}) {
  const newest = group.members[group.members.length - 1];
  const c = newest.completion;
  if (!c) return null;
  const statusLabel = c.status === 'done' ? 'finished' : c.status === 'failed' ? 'failed' : 'needs input';

  if (group.members.length > 1) {
    const shown = group.members.slice(-MAX_GROUP_ROWS);
    const more = group.members.length - shown.length;
    return (
      <div className={`agent-notif orc-completion orc-completion-${c.status}`}>
        <span className="orc-comp-icon" aria-hidden="true">
          <StatusIcon kind={c.status} />
        </span>
        <div className="orc-comp-body">
          <span className="orc-comp-headline">
            {group.members.length} agents {statusLabel}
            <span className="orc-comp-time">· {formatSecs(c.elapsedSec)}</span>
          </span>
          <ul className="orc-comp-group-list">
            {shown.map((m) => (
              <li key={m.id} title={m.completion?.taskTitle}>
                <span className="orc-comp-group-agent">{m.completion?.agentName}</span>
                <span className="orc-comp-group-task">{m.completion?.taskTitle}</span>
              </li>
            ))}
          </ul>
          {more > 0 && <span className="orc-comp-more">+{more} more</span>}
        </div>
        <button className="agent-notif-close" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className={`agent-notif orc-completion orc-completion-${c.status}`}>
      <span className="orc-comp-icon" aria-hidden="true">
        <StatusIcon kind={c.status} />
      </span>
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
      <div className="orc-comp-actions">
        {onShow && (
          <button className="orc-comp-show" onClick={onShow} aria-label="Show terminal" title="Show terminal">
            <TerminalGlyph />
          </button>
        )}
        <button className="agent-notif-close" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
