import { useEffect, useRef, useState } from 'react';
import {
  accountsFor,
  accountEnvFor,
  activeAccount,
  addAccount,
  removeAccount,
  selectAccount,
  DEFAULT_ACCOUNT_ID,
  type AccountsState,
} from '$lib/stores/agentAccounts';
import { useStore } from '$lib/react/useStore';
import { activeProject } from '$lib/stores/workspace';
import { layoutSnapshot } from '$lib/stores/layoutControl';
import { showToast } from '$lib/stores/notification';
import { runAgentSignIn } from '$lib/services/agent-signin';
import { closeUsagePanel } from '$lib/stores/usage';
import './AccountSwitcher.css';

/**
 * Switch which signed-in account a provider's meter — and its next agent —
 * uses.
 *
 * Renders nothing at all for a provider that only ever has one account, which
 * is most of them: a menu offering a single choice is chrome pretending to be a
 * feature. It appears once there is a second account to switch to, or on the
 * two providers that support adding one.
 *
 * Spacron never writes a credential — adding an account only creates the empty
 * config directory the CLI will write one into. What it *does* do is finish the
 * job: **Sign in** selects the account and opens a terminal running the CLI
 * with that account's config-dir variable already in the environment, so the
 * CLI's own login writes the token into the new account instead of overwriting
 * the one in `~`. Without that step the flow dead-ended at a directory the user
 * had no supported way to fill.
 */
export default function AccountSwitcher({
  provider,
  accounts,
}: {
  provider: string;
  accounts: AccountsState;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [hintExpanded, setHintExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const project = useStore(activeProject);
  const layout = useStore(layoutSnapshot);

  const rows = accountsFor(accounts, provider);
  const active = activeAccount(accounts, provider);
  const providerName = rows[0]?.providerName ?? provider;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (rootRef.current?.contains(target ?? null)) return;
      setOpen(false);
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setHintExpanded(false);
    }
  }, [open]);

  // Nothing to switch between and nothing to add — this provider doesn't do
  // multi-account, so the control shouldn't exist.
  if (rows.length === 0) return null;

  async function onAdd() {
    const label = draft.trim();
    if (!label) return;
    const id = await addAccount(provider, label);
    setDraft('');
    setAdding(false);
    // Straight into the login — `signIn` selects it first, and a directory the
    // CLI never wrote a credential into is not an account, just a folder.
    if (id) await signIn(id);
  }

  /**
   * Select an account and run the CLI's own login under it.
   *
   * Select first, then read the environment back from the backend rather than
   * constructing it here — `usage_account_env` is the single place that knows
   * which variable each CLI honours and refuses to set one for the default
   * account (whose config dir is the user's own `~`, where the CLI already
   * looks).
   */
  async function signIn(accountId: string) {
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
    setOpen(false);
    closeUsagePanel();
    await runAgentSignIn({
      // Provider id and launch command are the same string for both CLIs that
      // support switching (`ACCOUNT_PROVIDERS` in `agent_accounts.rs`); adding
      // one whose binary is named differently means mapping it here.
      command: provider,
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
    // No refresh here on purpose: `runAgentSignIn` re-scans when the sign-in
    // session exits. Refreshing now would only read the empty directory the
    // login has not written to yet.
  }

  return (
    <div className="account-switch" ref={rootRef}>
      <button
        className="account-switch-toggle"
        onClick={() => setOpen((v) => !v)}
        title="Switch account"
        aria-expanded={open}
      >
        <span className="account-switch-label">{active?.label ?? 'Default account'}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="account-switch-menu" role="menu">
          {rows.map((account) => (
            <div key={account.id} className="account-switch-item">
              <button
                className="account-switch-pick"
                data-active={account.active ? 'true' : 'false'}
                role="menuitem"
                onClick={() => {
                  void selectAccount(provider, account.id).then((selected) => {
                    if (!selected) showToast(`Could not switch ${providerName} account`, 'error');
                  });
                  setOpen(false);
                }}
              >
                <span className="account-switch-name">{account.label}</span>
                {/* A directory created for a login the user never finished is
                    listed, but must not look like a working account. */}
                {!account.signedIn && (
                  <span className="account-switch-flag">not signed in</span>
                )}
              </button>
              {/* The rung that used to be missing. An account with no
                  credential is a directory and nothing else until the CLI's
                  own login runs *under it* — this is the only affordance in
                  the app that arranges that. */}
              {!account.signedIn && (
                <button
                  className="account-switch-signin"
                  title={`Open a terminal running \`${provider}\` with this account's config directory, so its login writes here`}
                  onClick={() => void signIn(account.id)}
                >
                  Sign in
                </button>
              )}
              {account.id !== DEFAULT_ACCOUNT_ID && (
                <button
                  className="account-switch-remove"
                  title="Remove this account from Spacron"
                  aria-label={`Remove ${account.label}`}
                  onClick={() => void removeAccount(provider, account.id)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}

          {adding ? (
            <div className="account-switch-add">
              <input
                className="account-switch-input"
                value={draft}
                autoFocus
                placeholder="Work account"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onAdd();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setAdding(false);
                  }
                }}
              />
              <button className="account-switch-confirm" onClick={() => void onAdd()}>
                Add
              </button>
            </div>
          ) : (
            <button className="account-switch-new" onClick={() => setAdding(true)}>
              Add an account…
            </button>
          )}

          <button
            className={`account-switch-hint${hintExpanded ? ' is-expanded' : ''}`}
            type="button"
            title="Show the full account setup information"
            aria-expanded={hintExpanded}
            onClick={() => setHintExpanded((expanded) => !expanded)}
          >
            Adding one opens {providerName}'s own login in a terminal, pointed at
            a fresh config directory. Spacron never writes your credentials, it
            only decides which directory the CLI writes them to.
          </button>
        </div>
      )}
    </div>
  );
}
