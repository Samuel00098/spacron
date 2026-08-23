import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useStore } from '$lib/react/useStore';
import {
  remoteConnections,
  activeConnection,
  connectionStatus,
  connectRemote,
  disconnectRemote,
  addRemoteConnection,
  updateRemoteConnection,
  removeRemoteConnection,
  setReconnectOnStartup,
  getRemoteToken,
  hostLabel,
  type ConnectionStatus,
} from '$lib/stores/remoteWorkspace';
import RemoteSetupWizard from './RemoteSetupWizard';
import './RemoteStatus.css';

/**
 * The remote-workspace connection indicator + manager (Step 4 of
 * docs/remote-workspace.md). Lives in the StatusBar: a chip showing the active
 * connection and its live status, and a popover to add / edit / pick between
 * saved remotes (and "Local").
 */

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: 'Local',
  connecting: 'Connecting…',
  connected: '',
  reconnecting: 'Reconnecting…',
  error: 'Error',
};

type FormState = { id: string | null; name: string; url: string; token: string };
const EMPTY_FORM: FormState = { id: null, name: '', url: '', token: '' };

interface RemoteStatusProps {
  /** When true (default), the popover opens above the chip. Set false for
   *  title-bar placement where it should open downward. */
  dropdownUp?: boolean;
}

export default function RemoteStatus({ dropdownUp = true }: RemoteStatusProps) {
  const connections = useStore(remoteConnections);
  const active = useStore(activeConnection);
  const status = useStore(connectionStatus);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  // Two-click remove: the id whose trash button is armed, waiting for a second
  // click that actually deletes. Removing a remote destroys its keychain token,
  // so the first click asks and the second confirms.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Never carry an armed remove across a popover close — a trash button that
  // is already primed when the popover reopens reads as a trap, not a confirm.
  useEffect(() => {
    if (!open) setConfirmRemoveId(null);
  }, [open]);

  // The wizard's opener. Focus restore on close is done from HERE and not
  // inside the wizard because the wizard autofocuses its first field during
  // React's commit — by the time any effect inside it could capture
  // "who had focus", the field already has it, and restoring that on close
  // refocuses a detached node (a no-op that strands focus on a container).
  const vpsTriggerRef = useRef<HTMLButtonElement>(null);

  const busy = status === 'connecting' || status === 'reconnecting';
  // Anything other than a clean "disconnected" means we're on (or heading to) a
  // remote — drive the cloud icon + status dot off that, not just `active`,
  // so the mode reads correctly mid-connect and on error.
  const isRemote = status !== 'disconnected';
  const chipLabel = active
    ? status === 'reconnecting'
      ? `${active.name} · reconnecting`
      : active.name
    : STATUS_LABEL[status] || 'Local';

  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const url = form.url.trim();
    const token = form.token.trim();
    if (!url || !token) return;
    try {
      if (form.id) {
        await updateRemoteConnection(form.id, { name: form.name, url, token });
      } else {
        await addRemoteConnection({ name: form.name, url, token });
      }
      setForm(null);
    } catch (err) {
      // The keychain write failed (e.g. the OS credential store is locked) — the
      // remote was not saved, so tell the user instead of silently losing the token.
      const { showToast } = await import('$lib/stores/notification');
      showToast(`Couldn't save remote: ${(err as Error)?.message ?? String(err)}`, 'error', 5000);
    }
  };

  return (
    <div className={`remote-status${!dropdownUp ? ' rs-drop-down' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`rs-chip${open ? ' is-open' : ''}${isRemote ? ' rs-chip-remote' : ''}${
          status === 'connected' ? ' rs-chip-connected' : ''
        }`}
        onClick={() => setOpen((v) => !v)}
        title="Remote workspace"
        aria-expanded={open}
      >
        <span className="rs-chip-mode" aria-hidden="true">
          {isRemote ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.98A6 6 0 0 0 6.34 9 4 4 0 0 0 6.5 19z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          )}
        </span>
        <span className="rs-chip-label">{chipLabel}</span>
        {isRemote && <span className={`rs-dot rs-${status}`} />}
        <svg className="rs-chip-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="rs-popover" role="group" aria-label="Workspace connections">
          <div className="rs-pop-head">Workspace</div>

          <button
            type="button"
            className={`rs-row ${!active ? 'is-active' : ''}`}
            onClick={() => {
              void disconnectRemote();
              setOpen(false);
            }}
          >
            <span className="rs-dot rs-disconnected" />
            <span className="rs-row-main">
              <span className="rs-row-name">Local</span>
              <span className="rs-row-sub">This machine</span>
            </span>
            {!active && <span className="rs-row-badge">Active</span>}
          </button>

          {connections.map((conn) => {
            const isActive = active?.id === conn.id;
            return (
              <div key={conn.id} className={`rs-row rs-remote ${isActive ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className="rs-row-hit"
                  onClick={() => {
                    if (isActive) return;
                    void connectRemote(conn.id);
                    setOpen(false);
                  }}
                  disabled={isActive && busy}
                >
                  <span className={`rs-dot ${isActive ? `rs-${status}` : 'rs-idle'}`} />
                  <span className="rs-row-main">
                    <span className="rs-row-name">{conn.name}</span>
                    <span className="rs-row-sub">{hostLabel(conn.url)}</span>
                  </span>
                  {isActive && (
                    <span className="rs-row-badge">
                      {status === 'connected' ? 'Connected' : STATUS_LABEL[status] || 'Active'}
                    </span>
                  )}
                </button>
                <div className="rs-row-actions">
                  <button
                    type="button"
                    className={`rs-icon-btn${conn.reconnectOnStartup ? ' rs-on' : ''}`}
                    title={conn.reconnectOnStartup ? 'Reconnecting on startup — agents come back on their own' : 'Reconnect on startup'}
                    aria-pressed={!!conn.reconnectOnStartup}
                    onClick={() => setReconnectOnStartup(conn.id, !conn.reconnectOnStartup)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2 4.5 13.5H12l-1 8.5 8.5-11.5H11z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="rs-icon-btn"
                    title="Edit"
                    onClick={async () => {
                      // The token is keychain-backed; fetch it into session
                      // memory so the form prefills without ever persisting it.
                      const token = await getRemoteToken(conn.id);
                      setForm({ id: conn.id, name: conn.name, url: conn.url, token });
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={`rs-icon-btn rs-danger${confirmRemoveId === conn.id ? ' rs-armed' : ''}`}
                    title={confirmRemoveId === conn.id ? 'Click again to remove — deletes the saved token too' : 'Remove'}
                    aria-label={confirmRemoveId === conn.id ? `Confirm removing ${conn.name}` : `Remove ${conn.name}`}
                    onClick={() => {
                      if (confirmRemoveId !== conn.id) {
                        setConfirmRemoveId(conn.id);
                        // Disarm on its own: an armed button that stays armed
                        // forever is a deferred accidental delete, not a confirm.
                        window.setTimeout(() => {
                          setConfirmRemoveId((cur) => (cur === conn.id ? null : cur));
                        }, 4000);
                        return;
                      }
                      setConfirmRemoveId(null);
                      void removeRemoteConnection(conn.id);
                    }}
                  >
                    {confirmRemoveId === conn.id ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            );
          })}

          {form ? (
            <form className="rs-form" onSubmit={submitForm}>
              <div className="rs-form-title">{form.id ? 'Edit remote' : 'Add remote'}</div>
              <input
                className="rs-input"
                placeholder="Name (optional)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <input
                className="rs-input"
                placeholder="ws://host:9000/pty or wss://host:9000/pty"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                spellCheck={false}
                autoComplete="off"
                autoFocus
              />
              <input
                className="rs-input"
                placeholder="Token"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <div className="rs-form-actions">
                <button type="button" className="rs-btn" onClick={() => setForm(null)}>
                  Cancel
                </button>
                <button type="submit" className="rs-btn rs-btn-primary" disabled={!form.url.trim() || !form.token.trim()}>
                  {form.id ? 'Save' : 'Add'}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="rs-add" onClick={() => setForm({ ...EMPTY_FORM })}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add remote
            </button>
          )}

          {/* One-flow deploy: the app uploads its bundled spacron-server to a
              fresh VPS over SSH, starts it, and connects — see the wizard. */}
          <button
            type="button"
            className="rs-add"
            ref={vpsTriggerRef}
            onClick={() => { setForm(null); setSetupOpen(true); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z" />
              <path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z" />
              <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
              <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
            </svg>
            Set up a new VPS…
          </button>
        </div>
      )}

      <RemoteSetupWizard
        open={setupOpen}
        onClose={() => {
          setSetupOpen(false);
          vpsTriggerRef.current?.focus();
        }}
      />
    </div>
  );
}
