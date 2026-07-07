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
  hostLabel,
  type ConnectionStatus,
} from '$lib/stores/remoteWorkspace';
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

  const busy = status === 'connecting' || status === 'reconnecting';
  const chipLabel = active
    ? status === 'reconnecting'
      ? `${active.name} · reconnecting`
      : active.name
    : STATUS_LABEL[status] || 'Local';

  const submitForm = (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const url = form.url.trim();
    const token = form.token.trim();
    if (!url || !token) return;
    if (form.id) {
      updateRemoteConnection(form.id, { name: form.name, url, token });
    } else {
      addRemoteConnection({ name: form.name, url, token });
    }
    setForm(null);
  };

  return (
    <div className={`remote-status${!dropdownUp ? ' rs-drop-down' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="rs-chip"
        onClick={() => setOpen((v) => !v)}
        title="Remote workspace"
      >
        <span className={`rs-dot rs-${status}`} />
        <span className="rs-chip-label">{chipLabel}</span>
      </button>

      {open && (
        <div className="rs-popover" role="menu">
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
                    className="rs-icon-btn"
                    title="Edit"
                    onClick={() =>
                      setForm({ id: conn.id, name: conn.name, url: conn.url, token: conn.token })
                    }
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="rs-icon-btn rs-danger"
                    title="Remove"
                    onClick={() => removeRemoteConnection(conn.id)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                    </svg>
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
              />
              <input
                className="rs-input"
                placeholder="ws://host:9000/pty"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                autoFocus
              />
              <input
                className="rs-input"
                placeholder="Token"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
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
        </div>
      )}
    </div>
  );
}
