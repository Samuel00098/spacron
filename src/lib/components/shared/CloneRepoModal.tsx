import { useEffect, useMemo, useRef, useState } from 'react';
import { cloneRepoPromptOpen, cloneRepository, type CloneProgress } from '$lib/stores/workspace';
import './CloneRepoModal.css';

function getFilename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** The folder name a bare `git clone <url>` would produce. Mirrors the backend's
 *  `folder_name_from_url` so the preview matches what actually lands on disk. */
function folderNameFromUrl(url: string): string {
  const trimmed = url.trim().split(/[?#]/)[0].replace(/\/+$/, '');
  if (!trimmed) return '';
  const last = trimmed.split(/[/:]/).pop() || '';
  return last.replace(/\.git$/, '').trim();
}

// A frontend mirror of the backend's URL allowlist, so the user gets inline
// feedback before submitting. The backend re-validates — this is only for UX.
function urlError(url: string): string | null {
  const u = url.trim();
  if (!u) return null; // empty → button disabled, no error text yet
  if (u.length > 2048) return 'That URL is too long.';
  if (/\s/.test(u)) return 'That URL contains spaces.';
  const lower = u.toLowerCase();
  const scpLike = !lower.includes('://') && u.includes(':') && u.includes('@');
  const allowed =
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('ssh://') ||
    lower.startsWith('git://') ||
    scpLike;
  if (!allowed) return 'Use an https:// or ssh repository URL.';
  if (!folderNameFromUrl(u)) return 'That URL doesn’t end in a repository name.';
  return null;
}

const INVALID_CHARS = /[/\\:*?"<>|]/;
function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  if (n === '.' || n === '..' || n.includes('..')) return 'That name isn’t allowed.';
  if (n.startsWith('-')) return 'Name can’t start with a dash.';
  if (INVALID_CHARS.test(n)) return 'Name has characters that aren’t allowed in a folder.';
  if (n.length > 255) return 'Name is too long.';
  return null;
}

export default function CloneRepoModal() {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CloneProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputEl = useRef<HTMLInputElement | null>(null);
  const submitted = useRef(false);

  useEffect(() => {
    inputEl.current?.focus();
  }, []);

  const derivedName = useMemo(() => folderNameFromUrl(url), [url]);
  const effectiveName = name.trim() || derivedName;
  const validationError = urlError(url) ?? nameError(name);
  const canClone = !!parentDir && !!url.trim() && !!effectiveName && !validationError && !busy;

  function close() {
    cloneRepoPromptOpen.set(false);
    setUrl('');
    setName('');
    setParentDir(null);
    setError(null);
    setProgress(null);
    setBusy(false);
    submitted.current = false;
  }

  async function chooseLocation() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose where to clone the repository',
      });
      if (typeof selected === 'string') {
        setParentDir(selected);
        setError(null);
      }
    } catch (e) {
      console.error('Failed to pick a location:', e);
    }
  }

  async function confirm() {
    if (!canClone || submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      await cloneRepository(url.trim(), parentDir!, name.trim() || undefined, setProgress);
      close();
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Failed to clone the repository.');
      setProgress(null);
      submitted.current = false;
      setBusy(false);
    }
  }

  function cancel() {
    // Cancelling mid-clone would leave a half-written folder the backend can no
    // longer clean up, so the dialog stays put until git finishes either way.
    if (busy) return;
    close();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void confirm();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
    }
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) cancel();
  }

  return (
    <div
      className="cr-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Clone a repository"
      tabIndex={-1}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div className="cr-modal">
        <button type="button" className="cr-close" onClick={cancel} aria-label="Close" disabled={busy}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="cr-head">
          <div className="cr-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M6 9v6" />
              <circle cx="18" cy="6" r="3" />
              <path d="M18 9v3a3 3 0 0 1-3 3H9" />
            </svg>
          </div>
          <div className="cr-head-text">
            <h2 className="cr-title">Clone a repository</h2>
            <p className="cr-subtitle">Copy a remote repo onto this machine and open it.</p>
          </div>
        </div>

        <div className="cr-body">
          <div className="cr-field">
            <span className="cr-label">Repository URL</span>
            <input
              ref={inputEl}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              className="cr-input"
              type="text"
              placeholder="https://github.com/owner/repo.git"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={busy}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div className="cr-field">
            <span className="cr-label">Location</span>
            <button
              type="button"
              className={`cr-location${parentDir ? '' : ' is-empty'}`}
              onClick={() => void chooseLocation()}
              disabled={busy}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="cr-location-text">{parentDir ?? 'Choose a location…'}</span>
              <span className="cr-location-cta">{parentDir ? 'Change' : 'Browse'}</span>
            </button>
          </div>

          <div className="cr-field">
            <span className="cr-label">Folder name <span className="cr-optional">optional</span></span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              className="cr-input"
              type="text"
              placeholder={derivedName || 'repo'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={busy}
              onKeyDown={handleKeyDown}
            />
          </div>

          {busy ? (
            <div className="cr-progress" role="status" aria-live="polite">
              <div className="cr-progress-head">
                <span className="cr-progress-phase">{progress?.phase ?? 'Starting'}…</span>
                {typeof progress?.percent === 'number' && (
                  <span className="cr-progress-pct">{progress.percent}%</span>
                )}
              </div>
              <div className={`cr-progress-track${typeof progress?.percent === 'number' ? '' : ' indeterminate'}`}>
                <div
                  className="cr-progress-fill"
                  style={typeof progress?.percent === 'number' ? { width: `${progress.percent}%` } : undefined}
                />
              </div>
            </div>
          ) : error ? (
            <div className="cr-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          ) : validationError ? (
            <div className="cr-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{validationError}</span>
            </div>
          ) : parentDir && effectiveName ? (
            <div className="cr-preview">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="cr-preview-path">
                Cloning into <b>{effectiveName}</b> in {getFilename(parentDir)}
              </span>
            </div>
          ) : null}
        </div>

        <div className="cr-footer">
          <button type="button" className="cr-btn ghost" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="cr-btn primary" disabled={!canClone} onClick={() => void confirm()}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  );
}
