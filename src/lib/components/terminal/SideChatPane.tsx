import TerminalChatView from './TerminalChatView';
import { useStore } from '$lib/react/useStore';
import { useStructuredChatPane } from '$lib/services/structured-chat/panes';
import { allProjectSessions } from '$lib/stores/terminal';

/** A side chat in the right sidebar: the structured chat view without a room. */
export default function SideChatPane({ paneId }: { paneId: number }) {
  const session = useStore(allProjectSessions).find((entry) => entry.id === paneId);
  const agent = useStructuredChatPane(paneId);
  if (!session || !agent) return <div className="side-chat-pane" role="status">This side chat has ended.</div>;
  return (
    <div className="side-chat-pane">
      <TerminalChatView
        sessionId={paneId}
        agentPreset={session.agentPreset ?? agent}
        isRunning={Boolean(session.isRunning)}
        structuredAgent={agent}
      />
    </div>
  );
}
