import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { backendInvoke } from '$lib/services/backend';
import { useModalFocus } from '$lib/react/useModalFocus';
import { openRemoteFolder } from '$lib/stores/workspace';
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
