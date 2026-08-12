import { useCallback, useEffect, useMemo, useRef } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import { chatMessages } from '$lib/stores/orchestrator';
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
 * The agent inbox — every completion and actionable mailbox card the project has
 * produced, newest first, with unread state that survives a restart.
 *
 * This exists because the notification stack is transient by design: a finished
 * agent's card clears itself after ten seconds, so looking away loses it. The
 * stack stays the "right now" surface; this is the queue behind it. The two read
 * the same underlying data — see `inbox.ts`, which stores read/dismissed flags
 * and nothing else.
 */
export default function InboxPanel() {
  const open = useStore(isInboxOpen);
  const project = useStore(activeProject);
  const projectId = project?.id ?? '';

  // Subscribe to every source so the list stays live while it's open.
  const allMail = useStore(mailbox);
  const allChat = useStore(chatMessages);
  const inbox = useStore(inboxState);

  const panelRef = useRef<HTMLDivElement>(null);

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
          {entries.map((entry) => (
            <li key={entry.id} className="inbox-item">
              <button
                className={`inbox-row${entry.read ? '' : ' unread'}${entry.actionable ? ' actionable' : ''}`}
                onClick={() => markRead(projectId, [entry.id])}
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
                    <span className="inbox-row-agent">{entry.agentName}</span>
                    <span className="inbox-row-time">{relativeTime(entry.ts, now)}</span>
                  </span>
                  <span className="inbox-row-title">{entry.title}</span>
                  {entry.body && <span className="inbox-row-text">{entry.body}</span>}
                </span>
                {!entry.read && <span className="inbox-row-dot" aria-label="Unread" />}
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
