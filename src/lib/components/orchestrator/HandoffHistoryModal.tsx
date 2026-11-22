import { agentLaunchView } from '$lib/services/terminal-chat';
import { get } from '$lib/stores/storeCompat';
/**
 * Hand a past session's context to another agent. Shows exactly what will be
 * sent (editable), lets you pick the agent and whether it opens as a chat or a
 * terminal, and only then delivers. The original session is never touched.
 *
 * Mounted only while open, so `useModalFocus` releases its shortcut gate on
 * unmount; portaled to <body> so it is relative to the viewport.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '$lib/react/useStore';
import { useModalFocus } from '$lib/react/useModalFocus';
import { getAgentRoster } from '$lib/stores/runs';
import { accountsState } from '$lib/stores/agentAccounts';
import { structuredChatAgentFor } from '$lib/services/structured-chat/panes';
import { structuredChatProvider } from '$lib/services/structured-chat/registry';
import {
  buildHistoryHandoffPrompt,
  handOffFromHistory,
  readHistoryHandoffSource,
  type HistoryHandoffSnapshot,
  type HistoryHandoffSource,
} from '$lib/services/structured-chat/handoff-coordinator';
import { HISTORY_AGENTS, folderName, rowTitle, sessionAccountLabel, timeAgo, type HistoryRow } from '$lib/services/agent-history';
import HistoryBrand from './HistoryBrand.tsx';
import './HandoffHistoryModal.css';

const chatCapable = (command: string) => {
  const kind = structuredChatAgentFor(command);
  return Boolean(kind && structuredChatProvider(kind));
};

export default function HandoffHistoryModal({ row, onClose }: { row: HistoryRow; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const accounts = useStore(accountsState);
  const agent = HISTORY_AGENTS.find((a) => a.id === row.agent);
  const roster = useMemo(() => getAgentRoster().filter((a) => a.command !== agent?.command), [agent?.command]);
  const [snapshot, setSnapshot] = useState<HistoryHandoffSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<'chat' | 'terminal'>(() => get(agentLaunchView));
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [sending, setSending] = useState(false);

  const source: HistoryHandoffSource | null = useMemo(
    () => (agent && row.cwd ? { command: agent.command, agentName: agent.label, sessionId: row.id, cwd: row.cwd, account: row.account } : null),
    [agent, row.cwd, row.id, row.account],
  );
  const chosen = roster.find((a) => a.command === target) ?? null;
  const effectiveMode = mode === 'chat' && chosen && chatCapable(chosen.command) ? 'chat' : 'terminal';

  const close = () => { if (!sending) onClose(); };
  useModalFocus(cardRef, close);

  // Read the conversation once; the preview is built from it.
  useEffect(() => {
    if (!source) {
      setLoadError('This session has no folder recorded, so it cannot be handed over.');
      return undefined;
    }
    let cancelled = false;
    readHistoryHandoffSource(source)
      .then((snap) => { if (!cancelled) setSnapshot(snap); })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [source]);

  // The preview follows the chosen agent until the person edits it themselves.
  useEffect(() => {
    if (!snapshot || !source || edited) return;
    setText(buildHistoryHandoffPrompt(source, snapshot, chosen ?? { command: '', name: 'the next agent' }, effectiveMode));
  }, [snapshot, source, chosen, effectiveMode, edited]);

  async function send() {
    if (!source || !chosen || !text.trim()) return;
    setSending(true);
    const done = await handOffFromHistory(source, chosen, effectiveMode, text);
    setSending(false);
    if (done) onClose();
  }

  const loading = !snapshot && !loadError;
  const modal = (
    <div className="hom-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={cardRef} className="hom-card" role="dialog" aria-modal="true" aria-labelledby="hom-title">
        <div className="hom-head">
          <h2 id="hom-title">Hand off to another agent</h2>
          <button type="button" className="hom-close" onClick={close} aria-label="Close" disabled={sending}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="hom-body">
          <div className="hom-source">
            <HistoryBrand command={agent?.command ?? row.agent} name={agent?.label ?? row.agent} />
            <div className="hom-source-text">
              <span className="hom-source-title">{rowTitle(row)}</span>
              <span className="hom-muted">
                {[agent?.label, folderName(row.cwd), row.branch, row.model, sessionAccountLabel(row, accounts.accounts), row.messageCount > 0 ? `${row.messageCount} msgs` : null, timeAgo(row.updatedMs)].filter(Boolean).join(' · ')}
              </span>
            </div>
          </div>

          <section className="hom-section">
            <span className="hom-label">Hand over to</span>
            {roster.length === 0 ? (
              <span className="hom-muted">No other agents are installed.</span>
            ) : (
              <div className="hom-agents">
                {roster.map((a) => (
                  <button
                    key={a.command}
                    type="button"
                    className={`hom-agent${target === a.command ? ' on' : ''}`}
                    aria-pressed={target === a.command}
                    disabled={sending}
                    onClick={() => setTarget(a.command)}
                  >
                    <HistoryBrand command={a.command} name={a.name} />
                    <span>{a.name}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="hom-section">
            <span className="hom-label">Open it as</span>
            <div className="hom-seg" role="group" aria-label="Open as">
              <button type="button" className={effectiveMode === 'chat' ? 'on' : ''} disabled={sending || !chosen || !chatCapable(chosen.command)} onClick={() => setMode('chat')}>Chat</button>
              <button type="button" className={effectiveMode === 'terminal' ? 'on' : ''} disabled={sending} onClick={() => setMode('terminal')}>Terminal</button>
            </div>
          </section>

          <section className="hom-section">
            <div className="hom-label-row">
              <span className="hom-label">Context that will be sent</span>
              {snapshot && <span className="hom-muted">{snapshot.items.length} messages read · {text.length.toLocaleString()} characters</span>}
            </div>
            {loading && <div className="hom-note">Reading the conversation…</div>}
            {loadError && <div className="hom-note hom-error" role="alert">{loadError}</div>}
            {snapshot && (
              <>
                <textarea
                  className="hom-context"
                  value={text}
                  spellCheck={false}
                  disabled={sending}
                  aria-label="Context that will be sent"
                  onChange={(e) => { setText(e.target.value); setEdited(true); }}
                />
                <span className="hom-muted">
                  A summary of the conversation, the files it touched and its latest request. You can edit it before sending.
                  {edited && ' '}
                  {edited && <button type="button" className="hom-link" disabled={sending} onClick={() => setEdited(false)}>Reset</button>}
                </span>
              </>
            )}
          </section>
        </div>

        <div className="hom-foot">
          <span className="hom-muted">The original session is not changed.</span>
          <div className="hom-foot-actions">
            <button type="button" className="hom-btn" onClick={close} disabled={sending}>Cancel</button>
            <button type="button" className="hom-btn hom-btn-primary" onClick={() => void send()} disabled={sending || !chosen || !snapshot || !text.trim()}>
              {sending ? 'Handing over…' : chosen ? `Hand over to ${chosen.name}` : 'Hand over'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}
