import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import { chatMessages, orchestratorTasks, sessionIsRunning } from '$lib/stores/orchestrator';
import { setActiveSession } from '$lib/stores/terminal';
import { mailbox, getMailboxCards } from '$lib/services/orchestrator/mailbox';
import {
  inboxState,
  isInboxOpen,
  closeInbox,
  getReadIds,
  getClearedIds,
  markRead,
  markAllRead,
  clearInbox,
  mergeInboxEntries,
  countUnread,
  type InboxEntry,
} from '$lib/services/orchestrator/inbox';
import StatusIcon, { type StatusIconKind } from './statusIcons';
import './InboxPanel.css';

/** How many entries the list holds. Older traffic ages out of the mailbox log anyway. */
const MAX_ENTRIES = 40;

/** Maps an inbox status to its line-icon glyph and colour role (CSS class). */
const STATUS_ICON: Record<string, { kind: StatusIconKind; cls: string }> = {
  done: { kind: 'done', cls: 'ok' },
  failed: { kind: 'failed', cls: 'bad' },
  blocked: { kind: 'blocked', cls: 'warn' },
  report: { kind: 'report', cls: 'info' },
  handoff: { kind: 'handoff', cls: 'accent' },
  ask: { kind: 'ask', cls: 'warn' },
};

function relativeTime(ts: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The exact moment, for the expanded row — "2h ago" stops being enough once you
 * are actually reading the thing.
 */
function absoluteTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

function formatSecs(s: number | null | undefined): string {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * What the expanded row calls this entry's status. Worded the same way as the
 * floating card's `completionVerb` on purpose — a card and its inbox row are the
 * same event, and calling it "finished" in one place and "done" in the other
 * makes them look like two things. Defined locally rather than imported so this
 * panel doesn't pull in the notification stack for one string.
 */
function statusLabel(entry: InboxEntry): string {
  switch (entry.status) {
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Needs input';
    case 'handoff':
      return 'Handoff';
    case 'ask':
      return 'Question';
    case 'report':
      return 'Report';
    case 'done':
      if (entry.detail.endedBy === 'inferred') return 'Went quiet';
      if (entry.detail.endedBy === 'exit') return 'Exited';
      return 'Finished';
    default:
      return 'Update';
  }
}

/** The whole entry as plain text, for the expanded row's copy button. */
function copyText(entry: InboxEntry): string {
  const { reason, summary } = entry.detail;
  const parts = [`${entry.agentName} — ${entry.title}`, absoluteTime(entry.ts)];
  if (entry.kind === 'mail') {
    parts.push('', entry.body);
  } else {
    if (reason) parts.push('', reason);
    if (summary && summary !== reason) parts.push('', `Recap: ${summary}`);
    if (!reason && !summary) parts.push('', entry.body);
  }
  return parts.join('\n');
}

/**
 * The agent inbox — every completion and actionable mailbox card the project has
 * produced, newest first, with unread state that survives a restart.
 *
 * This exists because the notification stack is transient by design: a finished
 * agent's card clears itself after ten seconds, so looking away loses it. The
 * stack stays the "right now" surface; this is the queue behind it. The two read
 * the same underlying data — see `inbox.ts`, which stores read/dismissed flags
 * and nothing else.
 *
 * A row has two states. Collapsed it is a scan line: who, what, and two clamped
 * lines of the message. Clicking opens it in place — the message in full, the
 * agent's own words alongside the AI recap, when it happened and how long it
 * ran, and a jump to its terminal while the session is still alive. One row is
 * open at a time: the popover is 420px tall, and letting every row open turns
 * the queue into a scroll.
 */
export default function InboxPanel() {
  const open = useStore(isInboxOpen);
  const project = useStore(activeProject);
  const projectId = project?.id ?? '';

  // Subscribe to every source so the list stays live while it's open.
  const allMail = useStore(mailbox);
  const allChat = useStore(chatMessages);
  const inbox = useStore(inboxState);
  const tasks = useStore(orchestratorTasks);

  const panelRef = useRef<HTMLDivElement>(null);
  /** The one open row, by entry id. Session state, never persisted: an inbox
   *  that reopens with a row already open hides the rows above it. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const entries = useMemo<InboxEntry[]>(() => {
    if (!projectId) return [];
    const cards = getMailboxCards(projectId, { limit: MAX_ENTRIES, actionableOnly: true, includeSeen: true });
    const completions = (allChat[projectId] ?? []).filter((m) => m.completion);
    return mergeInboxEntries(cards, completions, getReadIds(projectId), getClearedIds(projectId)).slice(0, MAX_ENTRIES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMail, allChat, inbox, projectId]);

  const unread = countUnread(entries);

  // Close on Escape and on a click outside. Deliberately not `useModalFocus`:
  // this is a popover, not a modal — it must not trap Tab or suppress the app's
  // shortcuts while it's showing.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeInbox();
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target ?? null)) return;
      // The titlebar bell toggles on its own click; ignoring it here stops the
      // two handlers from cancelling each other out into a no-op.
      if (target instanceof Element && target.closest('[data-inbox-toggle]')) return;
      closeInbox();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  // A closed panel forgets which row was open, so the inbox always reopens as a
  // plain queue rather than mid-read.
  useEffect(() => {
    if (!open) {
      setExpandedId(null);
      setCopiedId(null);
    }
  }, [open]);

  useEffect(() => {
    setExpandedId(null);
  }, [projectId]);

  // An entry cleared while it was open must not leave a dangling id behind — the
  // next row to carry that id would open by itself.
  useEffect(() => {
    if (expandedId && !entries.some((e) => e.id === expandedId)) setExpandedId(null);
  }, [entries, expandedId]);

  // Opening the bottom row would otherwise expand it below the fold, leaving the
  // user looking at the row they clicked and none of what it said.
  useEffect(() => {
    if (!expandedId) return;
    const el = panelRef.current?.querySelector(`[data-entry-id="${CSS.escape(expandedId)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [expandedId]);

  const handleMarkAll = useCallback(() => {
    markAllRead(projectId, entries);
  }, [projectId, entries]);

  const handleClearAll = useCallback(() => {
    clearInbox(projectId, entries.map((e) => e.id));
  }, [projectId, entries]);

  const handleClearEntry = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      clearInbox(projectId, [id]);
    },
    [projectId],
  );

  // Opening a row is the deliberate act that marks it read — the same bar the
  // rest of the feature holds to (see inbox.ts on read vs dismissed). Closing
  // one again is not, so that direction only toggles.
  const handleToggle = useCallback(
    (id: string) => {
      setExpandedId((current) => {
        if (current === id) return null;
        markRead(projectId, [id]);
        return id;
      });
    },
    [projectId],
  );

  const handleCopy = useCallback((entry: InboxEntry) => {
    void navigator.clipboard?.writeText(copyText(entry)).then(
      () => setCopiedId(entry.id),
      // A clipboard the browser refuses is not worth an error state; the button
      // simply doesn't confirm.
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (!copiedId) return;
    const t = setTimeout(() => setCopiedId(null), 1600);
    return () => clearTimeout(t);
  }, [copiedId]);

  /**
   * "Show terminal", when the agent's session is still alive — the same gate the
   * floating completion card uses. Returns undefined when there is nothing to
   * show, so the button isn't rendered at all rather than appearing and failing.
   */
  const showTerminal = useCallback(
    (entry: InboxEntry): (() => void) | undefined => {
      const taskId = entry.detail.taskId;
      if (!taskId) return undefined;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return undefined;
      const sid = task.assignedSessionId ?? task.lastSessionId ?? null;
      if (sid == null || !sessionIsRunning(task.projectId, sid)) return undefined;
      return () => {
        setActiveSession(sid);
        closeInbox();
      };
    },
    [tasks],
  );

  if (!open || !projectId) return null;

  const now = Date.now();

  return (
    <div className="inbox-panel" ref={panelRef} role="dialog" aria-label="Agent inbox">
      <header className="inbox-head">
        <span className="inbox-head-left">
          <span className="inbox-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
          </span>
          <span className="inbox-title">Inbox</span>
          {unread > 0 && <span className="inbox-head-count">{unread} unread</span>}
        </span>
        <div className="inbox-head-actions">
          {unread > 0 && (
            <button className="inbox-mark-all" onClick={handleMarkAll}>
              Mark all read
            </button>
          )}
          {entries.length > 0 && (
            <button className="inbox-clear-all" onClick={handleClearAll} title="Clear inbox">
              Clear
            </button>
          )}
          <button className="inbox-close" onClick={closeInbox} aria-label="Close inbox" title="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {entries.length === 0 ? (
        <p className="inbox-empty">
          Nothing yet. Finished agents and anything needing your decision will collect here.
        </p>
      ) : (
        <ul className="inbox-list">
          {entries.map((entry) => {
            const expanded = expandedId === entry.id;
            return (
              <li key={entry.id} className="inbox-item">
                <div
                  className={`inbox-row${entry.read ? '' : ' unread'}${entry.actionable ? ' actionable' : ''}${expanded ? ' expanded' : ''}`}
                  data-entry-id={entry.id}
                >
                  <button
                    className="inbox-row-trigger"
                    onClick={() => handleToggle(entry.id)}
                    aria-expanded={expanded}
                    aria-controls={`inbox-detail-${entry.id}`}
                  >
                    <span
                      className={`inbox-row-glyph ${STATUS_ICON[entry.status]?.cls ?? 'muted'}`}
                      aria-hidden="true"
                    >
                      {STATUS_ICON[entry.status] ? (
                        <StatusIcon kind={STATUS_ICON[entry.status].kind} />
                      ) : (
                        <span className="inbox-row-fallback" />
                      )}
                    </span>
                    <span className="inbox-row-body">
                      <span className="inbox-row-head">
                        {/* Leading marker rather than a corner dot: the row's
                            right edge is the chevron's, and the clear button's
                            on hover. */}
                        {!entry.read && <span className="inbox-row-dot" aria-label="Unread" />}
                        <span className="inbox-row-agent">{entry.agentName}</span>
                        <span className="inbox-row-time">{relativeTime(entry.ts, now)}</span>
                      </span>
                      <span className="inbox-row-title">{entry.title}</span>
                      {/* Hidden while open: the detail below carries the same
                          message in full, and two copies read as a stutter. */}
                      {entry.body && !expanded && <span className="inbox-row-text">{entry.body}</span>}
                    </span>
                    <span className="inbox-row-chevron" aria-hidden="true">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </span>
                  </button>

                  <button
                    className="inbox-row-clear"
                    onClick={(e) => handleClearEntry(e, entry.id)}
                    aria-label="Clear entry"
                    title="Clear item"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>

                  {expanded && (
                    <InboxRowDetail
                      entry={entry}
                      copied={copiedId === entry.id}
                      onCopy={() => handleCopy(entry)}
                      onShow={showTerminal(entry)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The opened row. Everything here comes from `entry.detail`, which the merge in
 * `inbox.ts` derives fresh from the mailbox log and the chat cards — the panel
 * never keeps a copy of message content of its own.
 */
function InboxRowDetail({
  entry,
  copied,
  onCopy,
  onShow,
}: {
  entry: InboxEntry;
  copied: boolean;
  onCopy: () => void;
  onShow?: () => void;
}) {
  const { reason, summary, summaryPending, elapsedSec, to, files, worktreeBranch } = entry.detail;
  const elapsed = formatSecs(elapsedSec);
  // A recap that merely echoes the agent's own sentence is not a second thing to
  // read.
  const recap = summary && summary !== reason ? summary : null;
  const said = entry.kind === 'mail' ? !!entry.body : !!(reason || recap || summaryPending);

  return (
    <div className="inbox-detail" id={`inbox-detail-${entry.id}`}>
      <div className="inbox-detail-meta">
        <span className={`inbox-detail-chip ${STATUS_ICON[entry.status]?.cls ?? 'muted'}`}>
          {statusLabel(entry)}
        </span>
        {elapsed && <span className="inbox-detail-fact">ran {elapsed}</span>}
        <span className="inbox-detail-fact">{absoluteTime(entry.ts)}</span>
      </div>

      {entry.kind === 'mail' ? (
        <p className="inbox-detail-message">{entry.body}</p>
      ) : (
        <>
          {reason && <p className="inbox-detail-message">{reason}</p>}
          {summaryPending ? (
            <p className="inbox-detail-pending">Summarising what it did…</p>
          ) : recap ? (
            <div className="inbox-detail-block">
              <span className="inbox-detail-label">Recap</span>
              <p className="inbox-detail-message muted">{recap}</p>
            </div>
          ) : null}
          {/* Nothing was said at all — show the fallback sentence rather than an
              opened row that is emptier than the collapsed one. */}
          {!said && <p className="inbox-detail-message muted">{entry.body}</p>}
        </>
      )}

      {(to || worktreeBranch || (files && files.length > 0)) && (
        <dl className="inbox-detail-fields">
          {to && (
            <>
              <dt>To</dt>
              <dd>{to}</dd>
            </>
          )}
          {worktreeBranch && (
            <>
              <dt>Branch</dt>
              <dd className="mono">{worktreeBranch}</dd>
            </>
          )}
          {files && files.length > 0 && (
            <>
              <dt>Files</dt>
              <dd className="mono">{files.join(', ')}</dd>
            </>
          )}
        </dl>
      )}

      <div className="inbox-detail-actions">
        {onShow && (
          <button className="inbox-detail-action" onClick={onShow}>
            Show terminal
          </button>
        )}
        <button className="inbox-detail-action" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
