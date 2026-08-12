import { useMemo } from 'react';
import { activeProject } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import { chatMessages } from '$lib/stores/orchestrator';
import { mailbox, getMailboxCards } from '$lib/services/orchestrator/mailbox';
import {
  inboxState,
  toggleInbox,
  getReadIds,
  getClearedIds,
  mergeInboxEntries,
  countUnread,
} from '$lib/services/orchestrator/inbox';
import './InboxBell.css';

/** Matches the panel's window so the badge can't count rows the list won't show. */
const MAX_ENTRIES = 40;

/**
 * The titlebar bell and its unread badge.
 *
 * Deliberately its own component rather than markup inside `TitleBar`: the count
 * is derived from live chat and mailbox traffic, and folding those subscriptions
 * into the titlebar would re-render the entire window chrome — project switcher,
 * nav, window controls — every time an agent emits a message. Here the re-render
 * stops at the button.
 */
export default function InboxBell() {
  const project = useStore(activeProject);
  const allMail = useStore(mailbox);
  const allChat = useStore(chatMessages);
  const inbox = useStore(inboxState);

  const unread = useMemo(() => {
    const projectId = project?.id ?? '';
    if (!projectId) return 0;
    const cards = getMailboxCards(projectId, { limit: MAX_ENTRIES, actionableOnly: true, includeSeen: true });
    const completions = (allChat[projectId] ?? []).filter((m) => m.completion);
    return countUnread(
      mergeInboxEntries(cards, completions, getReadIds(projectId), getClearedIds(projectId)).slice(0, MAX_ENTRIES),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMail, allChat, inbox, project?.id]);

  return (
    <button
      className="icon-btn tb-inbox"
      data-inbox-toggle
      onClick={toggleInbox}
      aria-label={unread > 0 ? `Agent inbox, ${unread} unread` : 'Agent inbox'}
      title="Agent inbox"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      {unread > 0 && (
        <span className="tb-inbox-badge" aria-hidden="true">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}
