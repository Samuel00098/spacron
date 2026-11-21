/**
 * Sidebar extras for a structured-chat agent row: an unread dot (the chat's
 * turn finished while the window was hidden) and its child agents as indented
 * rows. Both read the chat's own stores, so a session that is not a structured
 * chat renders nothing.
 */
import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { structuredChatUnread, useStructuredChatPane, useStructuredChatUnread } from '$lib/services/structured-chat/panes';
import { getStructuredSubagents, openStructuredSubagent, subscribeStructuredSubagents } from '$lib/services/structured-chat/registry';
import type { StructuredSubagentSession } from '$lib/services/structured-chat/provider';

const LIVE = new Set<StructuredSubagentSession['status']>(['starting', 'running', 'needs-input']);
/** Ended children stay listed (dimmed) so a result is not lost, but only a few. */
const MAX_ENDED = 3;

export function ChatUnreadDot({ sessionId }: { sessionId: number }) {
  const agent = useStructuredChatPane(sessionId);
  const unread = useStructuredChatUnread(sessionId);
  if (!agent || !unread) return null;
  return <span className="project-process-unread" title="Finished while you were away" aria-label="Unread" />;
}

/**
 * Roll-up for the project card: any chat in the project that finished while the
 * window was hidden. Only meant for a collapsed card, where the per-row dots
 * are out of sight.
 */
export function ProjectChatUnreadDot({ sessionIds }: { sessionIds: number[] }) {
  const unread = useStore(structuredChatUnread);
  const count = sessionIds.filter((id) => unread[id]).length;
  if (!count) return null;
  return (
    <span
      className="project-card-unread"
      title={count === 1 ? '1 chat finished while you were away' : `${count} chats finished while you were away`}
      aria-label="Unread chats"
    />
  );
}

export function SessionChatChildren({ sessionId }: { sessionId: number }) {
  const agent = useStructuredChatPane(sessionId);
  const [children, setChildren] = useState<StructuredSubagentSession[]>([]);
  useEffect(() => {
    if (!agent) {
      setChildren([]);
      return undefined;
    }
    const read = () => setChildren(getStructuredSubagents(agent, sessionId));
    read();
    return subscribeStructuredSubagents(sessionId, read);
  }, [agent, sessionId]);

  if (!agent || !children.length) return null;
  const live = children.filter((child) => LIVE.has(child.status));
  const ended = children.filter((child) => !LIVE.has(child.status)).slice(-MAX_ENDED);
  return (
    <div className="project-process-children" role="group" aria-label="Child agents">
      {[...live, ...ended].map((child) => (
        <button
          key={child.id}
          type="button"
          className={`project-process-child status-${child.status}`}
          onClick={() => openStructuredSubagent(child.id)}
          title={`${child.agent}: ${child.assignment} (${child.status})`}
        >
          <span className="project-process-child-dot" aria-hidden="true" />
          <span className="project-process-child-name">{child.agent}</span>
          <span className="project-process-child-detail">{child.status === 'needs-input' ? 'needs input' : child.assignment}</span>
        </button>
      ))}
    </div>
  );
}
