import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { refreshBrowserToolsStatus, PLAYWRIGHT_MCP_VERSION } from '$lib/stores/mcpBridge';

/**
 * Settings → Agents → Browser, below the switch (docs/agent-browser.md):
 *
 * - the pinned Playwright MCP install (Install / Reinstall), which makes an
 *   agent's browser start in about 2 s instead of the ~28 s `npx @latest` took;
 * - "Test browser tools", which starts the server the way agents will and says
 *   why it failed, instead of an agent silently having no browser;
 * - this project's sign-in: a browser the user signs in with once, whose
 *   cookies agents' isolated browsers then start from.
 *
 * Config files pick changes up on the next agent launch or project open.
 */
interface Status {
  version: string;
  cliPath: string | null;
  installedVersion: string | null;
}

interface Check {
  ok: boolean;
  toolCount: number;
  startMs: number;
  via: 'installed' | 'npx';
  error: string | null;
}

export default function BrowserToolsDetails() {
  const project = useStore(activeProject);
  const root = project?.root_path ?? null;
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<'install' | 'check' | 'sign-in' | null>(null);
  const [message, setMessage] = useState<string>('');
  const [signedIn, setSignedIn] = useState(false);
  const [startUrl, setStartUrl] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<Status>('browser_tools_status'));
    } catch {
      setStatus(null);
    }
    if (root) {
      try {
        const s = await invoke<{ exists: boolean }>('browser_sign_in_state', { projectRoot: root });
        setSignedIn(s.exists === true);
      } catch {
        setSignedIn(false);
      }
    } else {
      setSignedIn(false);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async () => {
    setBusy('install');
    setMessage('Installing… this downloads the browser tools once (about 20 seconds).');
    try {
      await invoke('browser_tools_install');
      await refreshBrowserToolsStatus();
      setMessage('Installed. Agents launched from now on use it.');
    } catch (e) {
      setMessage(`Install failed: ${String(e)}`);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const check = async () => {
    setBusy('check');
    setMessage('Starting the browser server the way an agent would…');
    try {
      const r = await invoke<Check>('browser_tools_check');
      setMessage(
        r.ok
          ? `Working: ${r.toolCount} browser tools, started in ${(r.startMs / 1000).toFixed(1)} s ${r.via === 'installed' ? 'from the install' : 'through npx (install it to start faster)'}.`
          : `Not working: ${r.error ?? 'unknown error'}`,
      );
    } catch (e) {
      setMessage(`Not working: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const signIn = async () => {
    if (!root) return;
    setBusy('sign-in');
    setMessage('A browser window opened. Sign in to what this project\'s agents need, then close the window.');
    try {
      const url = startUrl.trim();
      const r = await invoke<{ exists: boolean }>('browser_sign_in', { projectRoot: root, startUrl: url });
      setMessage(r.exists ? 'Saved. Agents launched in this project from now on start signed in.' : 'Nothing was saved.');
    } catch (e) {
      setMessage(`Sign-in failed: ${String(e)}`);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const forget = async () => {
    if (!root) return;
    try {
      await invoke('browser_forget_sign_in', { projectRoot: root });
      setMessage('Forgotten. Agents launched from now on start signed out.');
    } catch (e) {
      setMessage(`Could not forget the sign-in: ${String(e)}`);
    }
    void refresh();
  };

  const installed = !!status?.cliPath;

  return (
    <div style={{ marginTop: '14px' }}>
      <div className="agent-list">
        <div className="agent-row">
          <div className="agent-meta">
            <div className="agent-name-row">
              <span className="agent-name">Playwright MCP {PLAYWRIGHT_MCP_VERSION}</span>
            </div>
            <small className="shell-hint">
              {installed
                ? 'Installed. Agent browsers start in about 2 seconds.'
                : status?.installedVersion
                  ? `Version ${status.installedVersion} is installed; Spacron now uses ${PLAYWRIGHT_MCP_VERSION}. Reinstall to update.`
                  : 'Not installed: agents download it through npx each time, which is much slower. Needs Node.js.'}
            </small>
          </div>
          <button type="button" className="bg-btn" disabled={busy !== null} onClick={() => void install()}>
            {installed ? 'Reinstall' : 'Install'}
          </button>
          <button type="button" className="bg-btn" disabled={busy !== null} onClick={() => void check()}>
            Test
          </button>
        </div>

        <div className="agent-row">
          <div className="agent-meta">
            <div className="agent-name-row">
              <span className="agent-name">Sign-in for {project?.name ?? 'this project'}</span>
            </div>
            <small className="shell-hint">
              {!root
                ? 'Open a project to give its agents a signed-in browser.'
                : signedIn
                  ? "Saved. This project's agents start signed in; each still gets its own browser. Codex and droid use a global config and always start signed out."
                  : 'Agents start with a clean, signed-out browser. Sign in once here to change that. The saved cookies stay on this computer, outside the project.'}
            </small>
            {root && installed ? (
              <input
                className="agent-input"
                style={{ marginTop: '8px' }}
                placeholder="Start page (optional), e.g. https://staging.example.com/login"
                value={startUrl}
                onChange={(e) => setStartUrl(e.target.value)}
                aria-label="Sign-in start page"
              />
            ) : null}
          </div>
          <button type="button" className="bg-btn" disabled={!root || !installed || busy !== null} onClick={() => void signIn()} title={installed ? '' : 'Install the browser tools first'}>
            {signedIn ? 'Sign in again' : 'Sign in'}
          </button>
          {signedIn ? (
            <button type="button" className="bg-btn bg-btn-danger" disabled={busy !== null} onClick={() => void forget()}>
              Forget
            </button>
          ) : null}
        </div>
      </div>
      {message ? (
        <small className="shell-hint" style={{ display: 'block', marginTop: '8px' }} role="status">
          {message}
        </small>
      ) : null}
    </div>
  );
}
