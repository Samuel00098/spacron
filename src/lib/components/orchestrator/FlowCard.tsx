import { ChatMessage } from '$lib/stores/orchestrator';
import { DiffCard, TerminalCard, PreviewCard } from './FlowCardContent.tsx';
import { useStore } from '$lib/react/useStore';
import { sessions } from '$lib/stores/terminal';

interface FlowCardProps {
  msg: ChatMessage;
  projectId: string;
  onExpand: (type: 'editor' | 'terminal' | 'preview', arg: any) => void;
  onApproveDiff?: () => void;
  onTweakDiff?: () => void;
}

export default function FlowCard({ msg, projectId, onExpand, onApproveDiff, onTweakDiff }: FlowCardProps) {
  const terminalSessions = useStore(sessions);

  if (msg.role === 'user') {
    return <div className="you">{msg.text}</div>;
  }

  // Assistant message rendering
  const agentName = msg.completion?.agentName || msg.dispatchedAgent || 'Ada';
  const hasDiffCard = msg.completion?.status === 'done' || (msg.text && (msg.text.includes('edited') || msg.text.includes('diff') || msg.text.includes('refactor')));

  // Check if there are active running sessions that match this dispatch
  const activeSession = msg.dispatched && msg.dispatched.length > 0
    ? terminalSessions.find((s) => msg.dispatched!.some((d) => d.taskId === s.ownerTaskId || d.agent.toLowerCase() === s.agentPreset?.toLowerCase()))
    : null;

  // Render orchestrator/agent chat bubble
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
      <div className="orch">
        <div className="pet">◠‿◠</div>
        <div className="bub">
          {msg.pending ? (
            <span style={{ display: 'flex', gap: '4px', padding: '6px 0' }}>
              <span className="dot-blink" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--flow-dim)', animation: 'breathe 1.2s infinite' }}></span>
              <span className="dot-blink" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--flow-dim)', animation: 'breathe 1.2s infinite 0.2s' }}></span>
              <span className="dot-blink" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--flow-dim)', animation: 'breathe 1.2s infinite 0.4s' }}></span>
            </span>
          ) : (
            <>
              {msg.reconSummary && (
                <div style={{ fontStyle: 'italic', color: 'var(--flow-faint)', marginBottom: '6px', fontSize: '12.5px' }}>
                  {msg.reconSummary}
                </div>
              )}
              <div dangerouslySetInnerHTML={{ __html: msg.text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>') }} />
            </>
          )}
        </div>
      </div>

      {/* Render specialised Diff Card if agent edited files */}
      {hasDiffCard && !msg.pending && (
        <div style={{ paddingLeft: '41px', width: '100%', maxWidth: '80%' }}>
          <DiffCard
            projectId={projectId}
            agentName={agentName}
            onExpand={(type, arg) => onExpand(type, arg)}
            onApprove={onApproveDiff}
            onTweak={onTweakDiff}
          />
        </div>
      )}

      {/* Render Terminal running card if session is active */}
      {activeSession && !msg.pending && (
        <div style={{ paddingLeft: '41px', width: '100%', maxWidth: '80%' }}>
          <TerminalCard
            sessionId={activeSession.id}
            agentName={agentName}
            command={activeSession.paneTitle || activeSession.title || 'npm run dev'}
            isRunning={activeSession.isRunning}
            onExpand={(type, arg) => onExpand(type, arg)}
          />
        </div>
      )}

      {/* Render Preview Card if message mentions a port/URL, dev server, or preview */}
      {(msg.text.includes('localhost') || msg.text.includes('preview') || msg.text.includes('http://')) && !msg.pending && (
        <div style={{ paddingLeft: '41px', width: '100%', maxWidth: '80%' }}>
          <PreviewCard
            url="http://localhost:5173"
            onExpand={(type, arg) => onExpand(type, arg)}
          />
        </div>
      )}
    </div>
  );
}
