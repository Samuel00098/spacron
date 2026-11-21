import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAgentRoster } from '$lib/stores/runs';
import { getSessionRoot } from '$lib/stores/terminal';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import { structuredChatAgentFor } from '$lib/services/structured-chat/panes';
import { structuredChatProvider } from '$lib/services/structured-chat/registry';
import {
  clearPaneHandoff,
  initiateHandoff,
  isHandoffInProgress,
  retryHandoff,
  useHandoffPickerRequest,
  usePaneHandoff,
  type HandoffMode,
} from '$lib/services/structured-chat/handoff-coordinator';
import './ContextHandoffButton.css';

const LABEL = 'Hand off context to another agent';

const STATUS_TEXT: Record<string, string> = {
  pending: 'Preparing context…',
  starting: 'Starting the new agent…',
  delivering: 'Sending context…',
  delivered: 'Context delivered.',
};

interface Props {
  sessionId: number;
  sourceAgentName: string;
  sourcePreset: string | null;
  /** Whether the pane is showing a chat right now; picks the default target mode. */
  chatActive?: boolean;
}

/**
 * Title-bar action shared by terminal and chat views: pick another configured
 * agent and start it with a bounded summary of this conversation. The current
 * pane is left running until the replacement has accepted the context.
 */
export default function ContextHandoffButton({ sessionId, sourceAgentName, sourcePreset, chatActive }: Props) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [mode, setMode] = useState<HandoffMode>(chatActive ? 'chat' : 'terminal');
  const record = usePaneHandoff(sessionId);
  const busy = isHandoffInProgress(sessionId);
  const pickerRequest = useHandoffPickerRequest(sessionId);
  useEffect(() => {
    if (pickerRequest) setOpen(true);
  }, [pickerRequest]);

  const agents = useMemo(
    () => (open ? getAgentRoster().filter((agent) => agent.command !== sourcePreset) : []),
    [open, sourcePreset],
  );
  const chosen = agents.find((agent) => agent.command === target) ?? null;
  const chatCapable = (command: string) => {
    const kind = structuredChatAgentFor(command);
    return Boolean(kind && structuredChatProvider(kind));
  };
  const effectiveMode: HandoffMode = mode === 'chat' && chosen && chatCapable(chosen.command) ? 'chat' : 'terminal';

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function start() {
    if (!chosen || busy) return;
    void initiateHandoff({
      sourceSessionId: sessionId,
      sourceAgentName,
      sourcePreset,
      targetCommand: chosen.command,
      targetName: chosen.name,
      mode: effectiveMode,
    }).then((ok) => {
      if (ok) setOpen(false);
    });
  }

  const cwd = getSessionRoot(sessionId);
  const failed = record?.status === 'failed';

  return (
    <>
      <button
        type="button"
        className={`pane-handoff-btn${busy ? ' busy' : ''}`}
        aria-label={LABEL}
        title={LABEL}
        disabled={busy}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 8h14m-4-4 4 4-4 4M20 16H6m4 4-4-4 4-4" />
        </svg>
      </button>
      {open && createPortal(
        <div className="chh-backdrop" onMouseDown={() => setOpen(false)}>
          <div
            className="chh-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={LABEL}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="chh-head">
              <span className="chh-head-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 8h14m-4-4 4 4-4 4M20 16H6m4 4-4-4 4-4" />
                </svg>
              </span>
              <div className="chh-head-copy">
                <h3 className="chh-title">{LABEL}</h3>
                <p className="chh-note">Sends a bounded summary of this conversation. This pane keeps running.</p>
              </div>
              <button type="button" className="chh-x" aria-label="Close" onClick={() => setOpen(false)}>
                <svg width="10" height="10" viewBox="0 0 9 9" aria-hidden="true"><path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </button>
            </header>

            <div className="chh-source">
              <span className="chh-label">From</span>
              <AgentBrandMark command={sourcePreset} name={sourceAgentName} className="chh-mark" />
              <strong className="chh-source-name">{sourceAgentName}</strong>
              {cwd && <code className="chh-path" title={cwd}>{cwd}</code>}
            </div>

            <span className="chh-label chh-section">To</span>
            {agents.length === 0 ? (
              <p className="chh-empty">No other agent is configured. Add one in Settings, then try again.</p>
            ) : (
              <div className="chh-list" role="radiogroup" aria-label="Target agent">
                {agents.map((agent) => (
                  <label key={agent.command} className={`chh-option${target === agent.command ? ' selected' : ''}`}>
                    <input
                      type="radio"
                      name="handoff-target"
                      value={agent.command}
                      checked={target === agent.command}
                      disabled={busy}
                      onChange={() => setTarget(agent.command)}
                    />
                    <AgentBrandMark command={agent.command} name={agent.name} className="chh-mark" />
                    <span className="chh-name">{agent.name}</span>
                    {!chatCapable(agent.command) && <span className="chh-cmd">Terminal only</span>}
                    <span className="chh-check" aria-hidden="true">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="chh-mode-row">
              <span className="chh-label">Open in</span>
              <div className="chh-mode" role="group" aria-label="Open the new agent in">
                <button type="button" aria-pressed={effectiveMode === 'chat'} disabled={busy || !chosen || !chatCapable(chosen.command)} onClick={() => setMode('chat')}>Chat</button>
                <button type="button" aria-pressed={effectiveMode === 'terminal'} disabled={busy || !chosen} onClick={() => setMode('terminal')}>Terminal</button>
              </div>
            </div>

            {record && (
              <p className={`chh-status ${record.status}`} role="status">
                {failed ? `Handoff to ${record.request.targetName} failed: ${record.error ?? 'unknown error'}` : STATUS_TEXT[record.status]}
              </p>
            )}

            <div className="chh-actions">
              {failed && (
                <button type="button" onClick={() => void retryHandoff(sessionId)}>Retry</button>
              )}
              {record && !busy && (
                <button type="button" onClick={() => clearPaneHandoff(sessionId)}>Clear status</button>
              )}
              <button type="button" onClick={() => setOpen(false)}>{busy ? 'Hide' : 'Cancel'}</button>
              <button type="button" className="primary" disabled={!chosen || busy} onClick={start}>
                {busy ? 'Handing off…' : chosen ? `Hand off to ${chosen.name}` : 'Hand off'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
