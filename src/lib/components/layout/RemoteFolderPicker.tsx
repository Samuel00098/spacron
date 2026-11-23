import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { backendInvoke } from '$lib/services/backend';
import { useModalFocus } from '$lib/react/useModalFocus';
import { openRemoteFolder, projects } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import { boxFolderName, sendProjectToBox } from '$lib/services/remote-send';
import { showToast } from '$lib/stores/notification';
import './RemoteFolderPicker.css';

interface FolderListing {
  path: string;
  root: string;
  parent: string | null;
  folders: { name: string; path: string; isRepo: boolean }[];
}

/**
 * Pick a folder on the connected box and open it as its own project. The box's
 * server only exposes folders inside the one it was deployed with, so browsing
 * starts there and never climbs above it.
 */
export default function RemoteFolderPicker({ remoteName, onClose }: { remoteName: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, onClose);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  // "Send a project from this computer": local (non-remote) projects only.
  const allProjects = useStore(projects);
  const localProjects = [...allProjects.values()].filter((p) => !p.id.startsWith('remote:'));
  const [sendRoot, setSendRoot] = useState('');
  const [sendName, setSendName] = useState('');
  const [sendProgress, setSendProgress] = useState('');
  const [sending, setSending] = useState(false);
  const chooseSend = (root: string) => { setSendRoot(root); setSendName(root ? boxFolderName(root) : ''); };
  const send = async () => {
    if (!sendRoot || !sendName.trim()) return;
    setSending(true);
    setError('');
    setSendProgress('Packing the project…');
    try {
      const result = await sendProjectToBox(sendRoot, sendName.trim(), (sent, total) =>
        setSendProgress(`Uploading ${Math.round((sent / total) * 100)}% (${(total / 1048576).toFixed(1)} MB)…`));
      setSendProgress('Opening it on the box…');
      if (result.uncommitted > 0) {
        showToast(`Sent. ${result.uncommitted} uncommitted file${result.uncommitted === 1 ? ' was' : 's were'} left on this computer; commit and send again to include them.`, 'warning', 9000);
      }
      await openRemoteFolder(result.path);
      onClose();
    } catch (e) {
      setError(String(e).includes('unsupported remote command')
        ? 'This box runs an older Spacron server. Redeploy it from "Set up a new VPS…" to send projects.'
        : String(e));
    } finally {
      setSending(false);
      setSendProgress('');
    }
  };

  const browse = (path?: string) => {
    setLoading(true);
    setError('');
    backendInvoke<FolderListing>('remote_list_folders', path ? { path } : {})
      .then(setListing)
      .catch((e) => setError(String(e).includes('unsupported remote command')
        ? 'This box runs an older Spacron server. Redeploy it from "Set up a new VPS…" to open folders.'
        : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { browse(); }, []);

  const open = async (path: string) => {
    setOpening(true);
    try {
      await openRemoteFolder(path);
      onClose();
    } catch (e) {
      showToast(`Couldn't open that folder: ${String(e)}`, 'error', 6000);
    } finally {
      setOpening(false);
    }
  };

  const crumbs = listing ? listing.path.slice(listing.root.length).split(/[\\/]/).filter(Boolean) : [];
  const rootName = listing ? listing.root.split(/[\\/]/).filter(Boolean).pop() ?? listing.root : '';
  const crumbPath = (i: number) => {
    if (!listing) return '';
    const sep = listing.root.includes('\\') ? '\\' : '/';
    return [listing.root.replace(/[\\/]$/, ''), ...crumbs.slice(0, i + 1)].join(sep);
  };

  return createPortal(
    <div className="rfp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rfp-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="rfp-title">
        <header className="rfp-head">
          <div>
            <h2 id="rfp-title">Open a folder on {remoteName}</h2>
            <p>Each folder opens as its own project. Terminals, agents, git and worktrees run there.</p>
          </div>
          <button className="rfp-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <section className="rfp-send" aria-label="Send a project from this computer">
          <span className="rfp-send-title">Send a project from this computer</span>
          <div className="rfp-send-row">
            <select aria-label="Local project to send" value={sendRoot} onChange={(e) => chooseSend(e.target.value)} disabled={sending}>
              <option value="">Choose a project…</option>
              {localProjects.map((p) => <option key={p.id} value={p.root_path}>{p.name}</option>)}
            </select>
            <input aria-label="Folder name on the box" value={sendName} onChange={(e) => setSendName(e.target.value)} placeholder="Folder name" disabled={sending || !sendRoot} />
            <button className="rfp-open" disabled={!sendRoot || !sendName.trim() || sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Send'}</button>
          </div>
          <small className="rfp-muted">{sendProgress || 'Copies the git history, unpushed commits included, and keeps its origin. Uncommitted changes stay here.'}</small>
        </section>
        {listing && (
          <nav className="rfp-crumbs" aria-label="Folder path">
            <button onClick={() => browse(listing.root)}>{rootName}</button>
            {crumbs.map((name, i) => (
              <span key={i}><span className="rfp-sep">/</span><button onClick={() => browse(crumbPath(i))}>{name}</button></span>
            ))}
          </nav>
        )}
        <div className="rfp-body">
          {error && <p role="alert" className="rfp-error">{error}</p>}
          {loading && <p className="rfp-muted">Loading folders…</p>}
          {!loading && listing && !listing.folders.length && <p className="rfp-muted">No folders here. Clone a repository into it from a terminal on the box, then come back.</p>}
          {!loading && listing?.folders.map((f) => (
            <div className="rfp-row" key={f.path}>
              <button className="rfp-folder" onClick={() => browse(f.path)} title="Show folders inside">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z" /></svg>
                <span>{f.name}</span>
                {f.isRepo && <span className="rfp-badge">git</span>}
              </button>
              <button className="rfp-open" disabled={opening} onClick={() => void open(f.path)}>Open</button>
            </div>
          ))}
        </div>
        <footer className="rfp-foot">
          <span className="rfp-muted">{listing ? listing.path : ''}</span>
          <button className="rfp-primary" disabled={!listing || opening} onClick={() => listing && void open(listing.path)}>
            {opening ? 'Opening…' : 'Open this folder'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
