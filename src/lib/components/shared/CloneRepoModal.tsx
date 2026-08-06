import { useModalFocus } from '$lib/react/useModalFocus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cloneRepoPromptOpen, cloneRepository } from '$lib/stores/workspace';
import { parseGitHubRepo } from '$lib/services/github-repo-url';
import {
  deleteGithubToken,
  githubListRepos,
  githubTokenExists,
  saveGithubToken,
  type GithubRepo,
} from '$lib/services/github';
import { errorText, useGithubSignIn } from '$lib/react/useGithubSignIn';
import './CloneRepoModal.css';

function getFilename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function GithubMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85l-.01 2.75c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z" />
    </svg>
  );
}

export default function CloneRepoModal() {
  const [url, setUrl] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [repoList, setRepoList] = useState<GithubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const inputEl = useRef<HTMLInputElement | null>(null);
  const submitted = useRef(false);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  const {
    options,
    identity: signedIn,
    signingIn,
    device,
    error: signInError,
    load,
    start,
    cancel: cancelSignIn,
    importGhCli,
    openInBrowser,
  } = useGithubSignIn();

  useModalFocus(backdropRef);

  useEffect(() => {
    inputEl.current?.focus();
    githubTokenExists().then(setTokenSaved).catch(() => {});
  }, []);

  // Surface sign-in failures (expired request, declined, network) as errors.
  useEffect(() => {
    if (signInError) setError(signInError);
  }, [signInError]);

  // Load the repo picker whenever a sign-in lands; drop it on sign-out.
  useEffect(() => {
    if (signedIn) {
      void loadRepos();
    } else {
      setRepoList([]);
    }
  }, [signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    setError(null);
    try {
      setRepoList(await githubListRepos());
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      // A dead credential must not linger: clear it so public clones work
      // again and the dialog drops back to the signed-out view.
      if (msg.toLowerCase().includes('sign in')) {
        try {
          await deleteGithubToken();
        } catch {
          // keychain already gone — nothing to do
        }
        setTokenSaved(false);
        setRepoList([]);
      }
    } finally {
      setReposLoading(false);
    }
  }, []);

  const repo = parseGitHubRepo(url);
  // Only complain once there's enough typed to be worth judging — an error on
  // the first keystroke of a valid URL reads as broken.
  const validationError = url.trim().length > 3 && !repo
    ? 'Enter a GitHub repository URL, like https://github.com/owner/repo'
    : null;
  const canClone = !!parentDir && !!repo && !busy;

  const filteredRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    if (!q) return repoList;
    return repoList.filter((r) => r.full_name.toLowerCase().includes(q));
  }, [repoList, repoFilter]);

  async function openTokenPage() {
    try {
      await openInBrowser('https://github.com/settings/tokens/new?scopes=repo&description=Spacron');
    } catch {
      window.open('https://github.com/settings/tokens/new?scopes=repo&description=Spacron', '_blank', 'noopener,noreferrer');
    }
  }

  async function handleSaveToken() {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    setSavingToken(true);
    try {
      await saveGithubToken(trimmed);
      setTokenSaved(true);
      setTokenInput('');
      setError(null);
      // Backfill identity so a saved PAT lands in the repo picker too.
      void load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSavingToken(false);
    }
  }

  function close() {
    cloneRepoPromptOpen.set(false);
    setUrl('');
    setParentDir(null);
    setError(null);
    setBusy(false);
    submitted.current = false;
  }

  async function chooseLocation() {
    if (busy) return;
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
    try {
      await cloneRepository(url.trim(), parentDir!);
      close();
    } catch (e) {
      setError(errorText(e));
      submitted.current = false;
      setBusy(false);
    }
  }

  function pickRepo(r: GithubRepo) {
    setUrl(`https://github.com/${r.full_name}`);
    setError(null);
  }

  async function copyUserCode() {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.user_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the code is still visible on screen.
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

  const parsedUrl = repo ? `${repo.owner}/${repo.name}` : null;

  return (
    <div
      className="cr-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Clone a repository from GitHub"
      tabIndex={-1}
      ref={backdropRef}
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
            <GithubMark size={22} />
          </div>
          <div className="cr-head-text">
            <h2 className="cr-title">Clone from GitHub</h2>
            <p className="cr-subtitle">Paste a repository URL and pick where it should live.</p>
          </div>
        </div>

        <div className="cr-body">
          <div className="cr-field">
            <span className="cr-label">Repository</span>
            <input
              ref={inputEl}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              className="cr-input"
              type="text"
              placeholder="https://github.com/owner/repo"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={busy}
              onKeyDown={handleKeyDown}
            />
          </div>

          {signingIn ? (
            device ? (
              <div className="cr-device">
                <div className="cr-hint">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span>
                    Open{' '}
                    <button type="button" className="cr-hint-link" onClick={() => void openInBrowser(device.verification_uri)} disabled={busy}>
                      github.com/login/device
                    </button>{' '}
                    and enter this code:
                  </span>
                </div>
                <div className="cr-device-row">
                  <code className="cr-device-code">{device.user_code}</code>
                  <button type="button" className="cr-btn ghost cr-device-copy" onClick={() => void copyUserCode()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="cr-device-waiting">
                  <span className="cr-spinner" aria-hidden="true" />
                  Waiting for approval in your browser…
                </div>
                <button type="button" className="cr-btn ghost" onClick={cancelSignIn} disabled={busy}>
                  Cancel sign-in
                </button>
              </div>
            ) : (
              <div className="cr-device">
                <div className="cr-device-waiting">
                  <span className="cr-spinner" aria-hidden="true" />
                  Signing in with your GitHub CLI…
                </div>
                <button type="button" className="cr-btn ghost" onClick={cancelSignIn} disabled={busy}>
                  Cancel sign-in
                </button>
              </div>
            )
          ) : signedIn ? (
            <div className="cr-repos">
              <div className="cr-repos-head">
                <span className="cr-label">
                  Your repositories — signed in as <b>{signedIn.login}</b>
                </span>
                <button
                  type="button"
                  className="cr-refresh"
                  onClick={() => void loadRepos()}
                  disabled={reposLoading || busy}
                  aria-label="Refresh repositories"
                  title="Refresh repositories"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>
              </div>
              <input
                className="cr-input cr-repo-filter"
                type="text"
                placeholder="Filter repositories…"
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={reposLoading || busy}
              />
              {reposLoading ? (
                <div className="cr-repos-loading">
                  <span className="cr-spinner" aria-hidden="true" />
                  Loading…
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="cr-repos-empty">
                  {repoFilter ? 'No repositories match your filter.' : 'No repositories found.'}
                </div>
              ) : (
                <ul className="cr-repo-list">
                  {filteredRepos.map((r) => (
                    <li key={r.full_name}>
                      <button
                        type="button"
                        className={`cr-repo-item${parsedUrl === r.full_name ? ' is-active' : ''}`}
                        onClick={() => pickRepo(r)}
                        disabled={busy}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                        </svg>
                        <span className="cr-repo-name">{r.full_name}</span>
                        {r.private ? (
                          <span className="cr-repo-badge">private</span>
                        ) : (
                          <span className="cr-repo-badge is-public">public</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="cr-token-section">
              {options?.oauth_available && (
                <div className="cr-signin">
                  <button type="button" className="cr-btn primary cr-signin-btn" onClick={() => void start()} disabled={busy}>
                    <GithubMark size={15} />
                    Sign in with GitHub
                  </button>
                  {options.gh_cli_available && (
                    <button type="button" className="cr-btn ghost cr-signin-btn" onClick={() => void importGhCli()} disabled={busy}>
                      Use my GitHub CLI sign-in
                    </button>
                  )}
                </div>
              )}
              {options?.oauth_available ? (
                <button type="button" className="cr-advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)} disabled={busy}>
                  Advanced: use a personal access token instead
                </button>
              ) : null}
              {(advancedOpen || !options?.oauth_available) && (
                tokenSaved ? (
                  <div className="cr-hint cr-hint--success">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>GitHub token saved. Private repos will clone automatically.</span>
                  </div>
                ) : (
                  <>
                    <div className="cr-hint">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      <span>
                        Private repos need a GitHub Personal Access Token.{' '}
                        <button type="button" className="cr-hint-link" onClick={() => void openTokenPage()} disabled={busy}>
                          Create one with &lsquo;repo&rsquo; scope
                        </button>
                      </span>
                    </div>
                    <div className="cr-token-row">
                      <input
                        className="cr-input cr-token-input"
                        type="password"
                        placeholder="Paste your token here (ghp_...)"
                        value={tokenInput}
                        onChange={(e) => { setTokenInput(e.target.value); setError(null); }}
                        disabled={savingToken}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSaveToken(); } }}
                      />
                      <button
                        type="button"
                        className="cr-btn primary cr-token-save"
                        onClick={() => void handleSaveToken()}
                        disabled={savingToken || !tokenInput.trim()}
                      >
                        {savingToken ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </>
                )
              )}
            </div>
          )}

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

          {error ? (
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
          ) : repo && parentDir ? (
            <div className="cr-preview">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="cr-preview-path">
                Cloning <b>{repo.owner}/{repo.name}</b> into {getFilename(parentDir)}/<b>{repo.name}</b>
              </span>
            </div>
          ) : null}
        </div>

        <div className="cr-footer">
          <button type="button" className="cr-btn ghost" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="cr-btn primary" disabled={!canClone} onClick={() => void confirm()}>
            {busy ? <><span className="cr-spinner" aria-hidden="true" />Cloning…</> : 'Clone repository'}
          </button>
        </div>
      </div>
    </div>
  );
}
