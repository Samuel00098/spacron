import TerminalChatView from './TerminalChatView';
import { useStore } from '$lib/react/useStore';
import { commandForStructuredAgent, useStructuredChatPane } from '$lib/services/structured-chat/panes';
import { useStructuredSessionRecord } from '$lib/services/structured-chat/session-store';
import { allProjectSessions } from '$lib/stores/terminal';

/** A side chat in the right sidebar: the structured chat view without a room. */
export default function SideChatPane({ paneId }: { paneId: number }) {
  const session = useStore(allProjectSessions).find((entry) => entry.id === paneId);
  const record = useStructuredSessionRecord(paneId);
  const agent = useStructuredChatPane(paneId);
  if (!agent || (!session && !record)) return <div className="side-chat-pane" role="status">This side chat has ended.</div>;
  return (
    <div className="side-chat-pane">
      <TerminalChatView
        sessionId={paneId}
        agentPreset={session?.agentPreset ?? record?.preset ?? commandForStructuredAgent(agent)}
        cwd={record?.cwd ?? null}
        isRunning={session ? Boolean(session.isRunning) : true}
        structuredAgent={agent}
      />
    </div>
  );
}
