import { useEffect, useRef, useState } from 'react';
import {
  accountsFor,
  activeAccount,
  selectAccount,
  type AccountsState,
} from '$lib/stores/agentAccounts';
import { showToast } from '$lib/stores/notification';
import { closeUsagePanel } from '$lib/stores/usage';
import { openSettings } from '$lib/stores/layout';
import './AccountSwitcher.css';

/**
 * Switch which already-added account a provider's meter — and its next agent —
 * uses.
 *
 * Picking only. Adding, signing in and removing accounts live in
 * Settings > AI Providers > Accounts (`AgentAccountsSection`); the menu links
 * there. Renders nothing for a provider with no accounts to pick between.
 */
export default function AccountSwitcher({
  provider,
  accounts,
}: {
  provider: string;
  accounts: AccountsState;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  if (rows.length === 0) return null;

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
            </div>
          ))}

          <button
            className="account-switch-new"
            onClick={() => {
              setOpen(false);
              closeUsagePanel();
              openSettings('models');
            }}
          >
            Manage accounts…
          </button>
        </div>
      )}
    </div>
  );
}
