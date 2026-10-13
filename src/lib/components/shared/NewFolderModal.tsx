import { useModalFocus } from '$lib/react/useModalFocus';
import { useEffect, useRef, useState } from 'react';
import { newFolderPromptOpen, createProjectFolder } from '$lib/stores/workspace';
import { useStore } from '$lib/react/useStore';
import { createProjectFromChat, projectFromChat } from '$lib/services/standalone-chat';
import './NewFolderModal.css';

function getFilename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

// A frontend mirror of the backend's folder-name validation, so we can give inline
// feedback before submitting. The backend re-validates — this is only for UX.
// Rejects path separators + Windows-reserved chars. Spaces and mid-name dashes are
// allowed (the backend only rejects a *leading* dash, handled separately below).
const INVALID_CHARS = /[/\\:*?"<>|]/;
function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return null; // empty → button disabled, no error text yet
  if (n === '.' || n === '..' || n.includes('..')) return 'That name isn’t allowed.';
  if (n.startsWith('-')) return 'Name can’t start with a dash.';
  if (INVALID_CHARS.test(n)) return 'Name has characters that aren’t allowed in a folder.';
  if (n.length > 255) return 'Name is too long.';
  return null;
}

export default function NewFolderModal() {
  const sourceChatId = useStore(projectFromChat);
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputEl = useRef<HTMLInputElement | null>(null);
  const submitted = useRef(false);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  useModalFocus(backdropRef);

  useEffect(() => {
    inputEl.current?.focus();
  }, []);

  const validationError = nameError(name);
  const canCreate = !!parentDir && !!name.trim() && !validationError && !busy;

  function close() {
    projectFromChat.set(null);
    newFolderPromptOpen.set(false);
    setName('');
    setParentDir(null);
    setError(null);
    setBusy(false);
    submitted.current = false;
  }

  async function chooseLocation() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose where to create the project',
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
    if (!canCreate || submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError(null);
    try {
      if (sourceChatId) await createProjectFromChat(sourceChatId, parentDir!, name.trim());
      else await createProjectFolder(parentDir!, name.trim());
      close();
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Failed to create folder.');
      submitted.current = false;
      setBusy(false);
    }
  }

  function cancel() {
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
      className="nf-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Create a project"
      tabIndex={-1}
      ref={backdropRef}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div className="nf-modal">
        <button type="button" className="nf-close" onClick={cancel} aria-label="Close" disabled={busy}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="nf-head">
          <div className="nf-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </div>
          <div className="nf-head-text">
            <h2 className="nf-title">{sourceChatId ? 'Create project from chat' : 'Create a project'}</h2>
            <p className="nf-subtitle">{sourceChatId ? 'Keep this conversation as a project thread. Continue in Chat or switch to Code whenever you choose.' : 'Start a fresh project in a new folder.'}</p>
          </div>
        </div>

        <div className="nf-body">
          <div className="nf-field">
            <span className="nf-label">Project name</span>
            <input
              ref={inputEl}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              className="nf-input"
              type="text"
              placeholder="my-new-project"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onKeyDown={handleKeyDown}
            />
          </div>

          <div className="nf-field">
            <span className="nf-label">Location</span>
            <button
              type="button"
              className={`nf-location${parentDir ? '' : ' is-empty'}`}
              onClick={() => void chooseLocation()}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="nf-location-text">{parentDir ?? 'Choose a location…'}</span>
              <span className="nf-location-cta">{parentDir ? 'Change' : 'Browse'}</span>
            </button>
          </div>

          {error ? (
            <div className="nf-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          ) : validationError ? (
            <div className="nf-error">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{validationError}</span>
            </div>
          ) : parentDir && name.trim() ? (
            <div className="nf-preview">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="nf-preview-path">
                Creating <b>{name.trim()}</b> in {getFilename(parentDir)}
              </span>
            </div>
          ) : null}
        </div>

        <div className="nf-footer">
          <button type="button" className="nf-btn ghost" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="nf-btn primary" disabled={!canCreate} onClick={() => void confirm()}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
