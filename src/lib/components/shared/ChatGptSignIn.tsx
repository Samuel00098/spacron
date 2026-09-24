import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { providerApiKeyExists } from '$lib/services/ai-keychain';
import { ProviderBrandMark } from './providerBrands';
import { showToast } from '$lib/stores/notification';
import { refreshModelCapabilities } from '$lib/services/model-capabilities';

interface ChatGptStatus {
  installed: boolean;
  signedIn: boolean;
  authMode: string | null;
  email: string | null;
  plan: string | null;
  error: string | null;
}

interface LoginStart {
  authUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
}

const INSTALL_COMMAND = 'npm install -g @openai/codex';

/** Codex errors arrive as "kind: message"; the kind is for the transport. */
function readableError(error: unknown): string {
  return String(error).replace(/^[a-z_]+:\s*/, '');
}

/**
 * Settings → AI Connections → ChatGPT subscription. The orchestrator runs on
 * the user's own ChatGPT plan through their Codex CLI (`commands/chatgpt.rs`):
 * Codex runs the OAuth flow and keeps the tokens, Spacron only relays the link.
 */
export function ChatGptSignIn({
  openUrl,
  onSignedInChange,
}: {
  openUrl: (url: string) => void;
  onSignedInChange: (signedIn: boolean) => void;
}) {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<LoginStart | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await invoke<ChatGptStatus>('chatgpt_status');
      setStatus(next);
      // Re-read the key-existence cache so the Composer and the brain agree.
      onSignedInChange(await providerApiKeyExists('chatgpt', { fresh: true }));
    } catch (error) {
      setStatus({ installed: false, signedIn: false, authMode: null, email: null, plan: null, error: readableError(error) });
    } finally {
      setChecking(false);
    }
  }, [onSignedInChange]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<{ success: boolean; error: string | null }>('chatgpt-login-finished', (event) => {
      setPending(null);
      if (event.payload.success) {
        showToast('Signed in with ChatGPT', 'success');
        // No API key is saved for ChatGPT, so Rust's "key saved" refresh never
        // fires: learn the plan's models (and what they support) here.
        void refreshModelCapabilities('chatgpt');
      } else if (event.payload.error) {
        showToast(`ChatGPT sign-in failed: ${event.payload.error}`, 'error');
      }
      void refresh();
    }).then((fn) => {
      if (disposed) fn(); else unlisten = fn;
    });
    return () => { disposed = true; unlisten?.(); };
  }, [refresh]);

  // Leaving the panel mid-login abandons that login.
  useEffect(() => () => { void invoke('chatgpt_login_cancel').catch(() => {}); }, []);

  const start = async (deviceCode: boolean) => {
    setStarting(true);
    try {
      const login = await invoke<LoginStart>('chatgpt_login_start', { deviceCode });
      setPending(login);
      const url = login.authUrl ?? login.verificationUrl;
      if (url) openUrl(url);
    } catch (error) {
      showToast(`Could not start ChatGPT sign-in: ${readableError(error)}`, 'error');
    } finally {
      setStarting(false);
    }
  };

  const cancel = () => {
    void invoke('chatgpt_login_cancel').catch(() => {});
    setPending(null);
  };

  const signOut = async () => {
    try {
      await invoke('chatgpt_logout');
      showToast('Signed out of ChatGPT in Codex', 'info');
    } catch (error) {
      showToast(`Could not sign out: ${readableError(error)}`, 'error');
    }
    void refresh();
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => showToast('Copied', 'success')).catch(() => {});
  };

  const plan = status?.plan ? status.plan.charAt(0).toUpperCase() + status.plan.slice(1) : null;
  let detail = 'Checking…';
  if (status && !checking) {
    if (!status.installed) detail = 'The Codex CLI is not installed';
    else if (status.signedIn) detail = `Signed in${status.email ? ` as ${status.email}` : ''}${plan ? ` · ChatGPT ${plan}` : ''}`;
    else if (status.authMode === 'apiKey') detail = 'Codex is using an API key, not a ChatGPT plan';
    else if (status.error) detail = status.error;
    else detail = 'Not signed in';
  }

  return (
    <div className="chatgpt-signin">
      <div className="chatgpt-signin-head">
        <ProviderBrandMark id="chatgpt" label="ChatGPT subscription" className="chatgpt-signin-logo" />
        <div className="chatgpt-signin-head-copy">
          <span className="chatgpt-signin-title">ChatGPT account</span>
          <span className="chatgpt-signin-detail">
            <span className={`chatgpt-signin-dot${status?.signedIn ? ' on' : ''}`} aria-hidden="true" />
            {detail}
          </span>
        </div>
      </div>

      <p className="shell-hint chatgpt-signin-intro">
        Use the ChatGPT plan you already pay for (Plus, Pro, Business…) as the orchestrator&apos;s brain.
        No API key and no extra cost: requests count against your plan&apos;s Codex usage limits.
        It runs through OpenAI&apos;s Codex CLI on this computer, which keeps your login; Spacron never sees it.
      </p>

      {status && !status.installed && (
        <div className="chatgpt-signin-install">
          <p className="shell-hint">Install the Codex CLI first (it needs Node.js), then check again:</p>
          <div className="chatgpt-signin-code">
            <code>{INSTALL_COMMAND}</code>
            <button type="button" className="settings-secondary" onClick={() => copy(INSTALL_COMMAND)}>Copy</button>
          </div>
        </div>
      )}

      {pending && (
        <div className="chatgpt-signin-pending">
          {pending.userCode ? (
            <>
              <p className="shell-hint">
                Open the page below, sign in to ChatGPT, and enter this one-time code:
              </p>
              <div className="chatgpt-signin-code">
                <code className="chatgpt-signin-usercode">{pending.userCode}</code>
                <button type="button" className="settings-secondary" onClick={() => copy(pending.userCode!)}>Copy code</button>
              </div>
            </>
          ) : (
            <p className="shell-hint">Finish signing in in your browser. This page updates when you are done.</p>
          )}
          <div className="settings-action-row">
            {(pending.authUrl ?? pending.verificationUrl) && (
              <button type="button" className="settings-secondary" onClick={() => openUrl((pending.authUrl ?? pending.verificationUrl)!)}>Open sign-in page again</button>
            )}
            <button type="button" className="settings-secondary" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}

      <div className="settings-action-row chatgpt-signin-actions">
        {status?.installed && !status.signedIn && !pending && (
          <>
            <button type="button" className="settings-primary" onClick={() => void start(false)} disabled={starting}>
              {starting ? 'Opening…' : 'Sign in with ChatGPT'}
            </button>
            <button
              type="button"
              className="settings-secondary"
              onClick={() => void start(true)}
              disabled={starting}
              title="Use a one-time code instead, e.g. when the browser cannot reach this computer. Device codes must be enabled in your ChatGPT security settings."
            >
              Use a code instead
            </button>
          </>
        )}
        {status?.signedIn && (
          <button type="button" className="settings-secondary" onClick={() => void signOut()}>Sign out</button>
        )}
        <button type="button" className="settings-secondary" onClick={() => void refresh()} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <button type="button" className="settings-link-button" onClick={() => openUrl('https://developers.openai.com/codex/cli')}>About Codex CLI</button>
      </div>
    </div>
  );
}
