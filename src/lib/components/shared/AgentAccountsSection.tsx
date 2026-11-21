import { useEffect, useState } from 'react';
import { useStore } from '$lib/react/useStore';
import { AgentBrandMark } from '$lib/components/shared/useAgentBrand';
import {
  accountsState,
  accountsFor,
  accountEnvFor,
  addAccount,
  connectWebSession,
  disconnectWebSession,
  refreshAccounts,
  removeAccount,
  selectAccount,
  switchableProviders,
  DEFAULT_ACCOUNT_ID,
} from '$lib/stores/agentAccounts';
import { activeProject } from '$lib/stores/workspace';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import { closeSettings } from '$lib/stores/layout';
import { showToast } from '$lib/stores/notification';
import { runAgentSignIn } from '$lib/services/agent-signin';
import './AgentAccountsSection.css';

/**
 * Settings > AI Providers > Accounts: every account Spacron knows for each
 * agent CLI, and the one place they are added, signed in and removed. The
 * usage panel's switcher only picks between accounts listed here.
 *
 * Spacron never writes a credential. Adding an account creates the empty
 * config directory the CLI will log into; **Sign in** selects it and opens a
 * terminal running the CLI with that directory's variable set, so the CLI's own
 * login writes the token there instead of over the default account in `~`.
 */
export default function AgentAccountsSection() {
  const accounts = useStore(accountsState);
  const project = useStore(activeProject);
  const layout = useStore(layoutSnapshot);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void refreshAccounts();
  }, []);

  const providers = switchableProviders(accounts);

  async function signIn(provider: string, providerName: string, accountId: string) {
    const cwd = project?.root_path;
    const projectId = project?.id;
    if (!cwd || !projectId) {
      showToast('Open a project first to sign in to an account', 'warning');
      return;
    }
    if (!await selectAccount(provider, accountId)) {
      showToast(`Could not switch ${providerName} account`, 'error');
      return;
    }
    const env = await accountEnvFor(provider);
    if (accountId !== DEFAULT_ACCOUNT_ID && Object.keys(env).length === 0) {
      // The directory is gone, or this CLI has no config-dir override. Running
      // the login anyway would write into the default account.
      showToast(`Spacron can't point ${providerName} at that account`, 'error');
      return;
    }
    closeSettings();
    await runAgentSignIn({
      // Provider id and launch command: Antigravity CLI is 'agy', others match provider.
      command: provider === 'antigravity' ? 'agy' : provider,
      name: providerName,
      cwd,
      projectId,
      isDev: layout.ambient === 'development',
      extraEnv: env,
      toast:
        accountId === DEFAULT_ACCOUNT_ID
          ? `Signing in to ${providerName}. Complete the login in the agent panel.`
          : `Signing in to ${providerName} as this account. The login writes into its own directory, not your default one.`,
    });
  }

  async function add(provider: string, providerName: string) {
    const label = draft.trim();
    if (!label) return;
    const id = await addAccount(provider, label);
    setDraft('');
    setAddingFor(null);
    if (!id) {
      showToast(`Could not add a ${providerName} account`, 'error');
      return;
    }
    // Straight into the login: a directory the CLI never wrote a credential
    // into is not an account yet.
    await signIn(provider, providerName, id);
  }

  return (
    <section className="settings-card" data-settings-section="accounts">
      <h3>Accounts</h3>
      <div className="settings-card-body agent-accounts">
        {providers.length === 0 && accounts.sessions.length === 0 && (
          <p className="agent-accounts-empty">
            {accounts.error ?? 'No agent CLI that supports accounts was found on this machine.'}
          </p>
        )}

        {providers.map(({ provider, name }) => {
          const rows = accountsFor(accounts, provider);
          const adding = addingFor === provider;
          return (
            <div className="agent-accounts-provider" key={provider}>
              <div className="agent-accounts-head">
                <span className="agent-accounts-mark" aria-hidden="true">
                  <AgentBrandMark command={provider} name={name} />
                </span>
                <span className="agent-accounts-name">{name}</span>
                <span className="agent-accounts-count">
                  {rows.length} account{rows.length === 1 ? '' : 's'}
                </span>
                {!adding && (
                  <button
                    type="button"
                    className="settings-secondary agent-accounts-add-btn"
                    onClick={() => {
                      setDraft('');
                      setAddingFor(provider);
                    }}
                  >
                    + Add account
                  </button>
                )}
              </div>

              <ul className="agent-accounts-list">
                {rows.map((account) => (
                  <li className="agent-accounts-row" key={account.id} data-active={account.active ? 'true' : 'false'}>
                    <span className="agent-accounts-dot" aria-hidden="true" />
                    <span className="agent-accounts-label">
                      {account.label}
                      {account.id === DEFAULT_ACCOUNT_ID && <small>System default</small>}
                    </span>
                    {account.active && <span className="agent-accounts-badge">Active</span>}
                    {!account.signedIn && <span className="agent-accounts-flag">Not signed in</span>}
                    <span className="agent-accounts-actions">
                      {!account.active && account.signedIn && (
                        <button
                          type="button"
                          className="settings-link-button"
                          onClick={() => {
                            void selectAccount(provider, account.id).then((ok) => {
                              if (!ok) showToast(`Could not switch ${name} account`, 'error');
                            });
                          }}
                        >
                          Use
                        </button>
                      )}
                      {!account.signedIn && (
                        <button
                          type="button"
                          className="settings-link-button"
                          title={`Open a terminal running \`${provider}\` with this account's config directory, so its login writes here`}
                          onClick={() => void signIn(provider, name, account.id)}
                        >
                          Sign in
                        </button>
                      )}
                      {account.id !== DEFAULT_ACCOUNT_ID && (
                        <button
                          type="button"
                          className="agent-accounts-remove"
                          title="Remove this account from Spacron"
                          aria-label={`Remove ${account.label}`}
                          onClick={() => void removeAccount(provider, account.id)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {adding && (
                <div className="agent-accounts-new">
                  <input
                    value={draft}
                    autoFocus
                    placeholder="Name it, e.g. Work account"
                    aria-label={`New ${name} account name`}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void add(provider, name);
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setAddingFor(null);
                      }
                    }}
                  />
                  <button type="button" className="settings-primary" disabled={!draft.trim()} onClick={() => void add(provider, name)}>
                    Add &amp; sign in
                  </button>
                  <button type="button" className="settings-secondary" onClick={() => setAddingFor(null)}>
                    Cancel
                  </button>
                  <small>
                    Opens {name}&apos;s own login in a terminal, pointed at a fresh config directory.
                    Spacron never sees your credentials.
                  </small>
                </div>
              )}
            </div>
          );
        })}

        {accounts.sessions.map((session) => {
          const connecting = accounts.connecting === session.provider;
          return (
            <div className="agent-accounts-provider" key={`session-${session.provider}`}>
              <div className="agent-accounts-head">
                <span className="agent-accounts-mark" aria-hidden="true">
                  <AgentBrandMark command={session.provider} name={session.name} />
                </span>
                <span className="agent-accounts-name">{session.name}</span>
                <span className="agent-accounts-count">{session.connected ? 'Connected' : 'Not connected'}</span>
                {session.connected ? (
                  <button type="button" className="settings-secondary agent-accounts-add-btn" onClick={() => void disconnectWebSession(session.provider)}>
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className="settings-secondary agent-accounts-add-btn"
                    disabled={connecting}
                    onClick={() => void connectWebSession(session.provider)}
                  >
                    {connecting ? 'Waiting for sign-in…' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
