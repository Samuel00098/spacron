/**
 * Linked browser sessions and multi-account switching for the usage meters.
 *
 * Two different things share this module because they answer the same user
 * question — *which account am I looking at, and why is this row empty?* — and
 * the panel renders them side by side:
 *
 * - **Web sessions** (`commands::web_session`): OpenCode and MiniMax meter their
 *   plans on a website, so Spacron opens the vendor's real login page and keeps
 *   the resulting session cookie in the OS keychain. The cookie itself never
 *   reaches this file; `connected` is the whole of what the webview learns.
 * - **Accounts** (`commands::agent_accounts`): Claude Code and Codex can hold
 *   more than one login. Switching points the CLI's config-dir environment
 *   variable at a managed directory — Spacron never writes a credential.
 */

import { writable, get } from '$lib/stores/storeCompat';
import { isTauriRuntime } from '$lib/utils/tauri';
import type { ProviderUsage } from '$lib/stores/usage';
import { refreshUsage } from '$lib/stores/usage';

export interface WebSessionStatus {
  provider: string;
  name: string;
  /** Whether a usable session is stored. Never the credential itself. */
  connected: boolean;
}

export interface AgentAccount {
  provider: string;
  providerName: string;
  id: string;
  /** Email where the CLI records one, else the account id. */
  label: string;
  /** Whether the CLI has actually written a credential into this account. */
  signedIn: boolean;
  active: boolean;
}

export interface AccountsState {
  sessions: WebSessionStatus[];
  accounts: AgentAccount[];
  /** Provider currently mid-connect, so its button can show progress. */
  connecting: string | null;
  /** Read failures surface; write failures are reported by the caller. */
  error: string | null;
}

export const accountsState = writable<AccountsState>({
  sessions: [],
  accounts: [],
  connecting: null,
  error: null,
});

/** The reserved id of the account living in the user's own home directory. */
export const DEFAULT_ACCOUNT_ID = 'default';

async function invoker() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

export async function refreshAccounts(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const invoke = await invoker();
    const [sessions, accounts] = await Promise.all([
      invoke<WebSessionStatus[]>('web_session_list'),
      invoke<AgentAccount[]>('usage_list_accounts'),
    ]);
    accountsState.update((s) => ({ ...s, sessions, accounts, error: null }));
  } catch (err) {
    // A panel that cannot load its accounts has to say so rather than render an
    // empty list that reads as "you have none".
    accountsState.update((s) => ({ ...s, error: String(err) }));
  }
}

/**
 * Open the vendor's sign-in page and wait for the session.
 *
 * Resolves `true` when a session was captured. Closing the window is how the
 * user cancels, and resolves `false` — not an error, so the caller should not
 * dress it as one.
 */
export async function connectWebSession(provider: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  // Guard here as well as in Rust: the button is disabled while connecting, but
  // a second call would otherwise sit waiting on a window it didn't open.
  if (get(accountsState).connecting) return false;

  accountsState.update((s) => ({ ...s, connecting: provider, error: null }));
  try {
    const invoke = await invoker();
    const connected = await invoke<boolean>('web_session_connect', { provider });
    await refreshAccounts();
    return connected;
  } catch (err) {
    accountsState.update((s) => ({ ...s, error: String(err) }));
    return false;
  } finally {
    accountsState.update((s) => ({ ...s, connecting: null }));
  }
}

export async function disconnectWebSession(provider: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const invoke = await invoker();
    await invoke('web_session_disconnect', { provider });
    await refreshAccounts();
  } catch (err) {
    accountsState.update((s) => ({ ...s, error: String(err) }));
  }
}

export async function selectAccount(provider: string, accountId: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const invoke = await invoker();
    await invoke('usage_select_account', { provider, accountId });
    accountsState.update((s) => ({
      ...s,
      accounts: s.accounts.map((account) => account.provider === provider
        ? { ...account, active: account.id === accountId }
        : account),
      error: null,
    }));
    void refreshAccounts();
    void refreshUsage(true);
    return true;
  } catch (err) {
    accountsState.update((s) => ({ ...s, error: String(err) }));
    return false;
  }
}

export async function addAccount(provider: string, label: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const invoke = await invoker();
    const id = await invoke<string>('usage_add_account', { provider, label });
    await refreshAccounts();
    return id;
  } catch (err) {
    accountsState.update((s) => ({ ...s, error: String(err) }));
    return null;
  }
}

/** Add an account that is an API key rather than a login (Cursor), and use it. */
export async function addKeyAccount(provider: string, label: string, key: string): Promise<boolean> {
  const id = await addAccount(provider, label);
  if (!id) return false;
  try {
    const invoke = await invoker();
    await invoke('usage_set_account_key', { provider, accountId: id, key });
  } catch (err) {
    // An account with no key is no account.
    await removeAccount(provider, id);
    accountsState.update((s) => ({ ...s, error: String(err) }));
    return false;
  }
  await refreshAccounts();
  return selectAccount(provider, id);
}

export async function removeAccount(provider: string, accountId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const invoke = await invoker();
    await invoke('usage_remove_account', { provider, accountId });
    await refreshAccounts();
  } catch (err) {
    accountsState.update((s) => ({ ...s, error: String(err) }));
  }
}

/**
 * The environment a launched agent needs to use an account.
 *
 * Empty for the default account, and empty for every provider that doesn't do
 * account switching — so this is safe to merge unconditionally at spawn time,
 * which is what keeps the call site free of provider-specific branching.
 *
 * `accountId` is normally omitted, meaning "whichever account the user
 * selected". Failover passes one: a successor launches under a *different*
 * account from the one that ran out, and doing that must not move the user's
 * global selection — the picker in Settings says who the user works as, and a
 * handover is not the user changing their mind.
 */
export async function accountEnvFor(
  provider: string,
  accountId?: string | null
): Promise<Record<string, string>> {
  if (!isTauriRuntime()) return {};
  try {
    const invoke = await invoker();
    const env = await invoke<Record<string, string>>('usage_account_env', {
      provider: accountProviderFor(provider),
      accountId: accountId ?? null,
    });
    if (accountId && accountId !== DEFAULT_ACCOUNT_ID && Object.keys(env).length === 0) {
      throw new Error(`Account ${accountId} is unavailable for ${provider}. Restore that account before resuming.`);
    }
    return env;
  } catch (error) {
    if (accountId) throw error;
    // A launch must never be blocked by this. Falling back to no patch means
    // the agent uses its default account, which is the pre-existing behaviour.
    return {};
  }
}

/**
 * One account's own headroom, whether or not it is the selected one.
 *
 * The usage panel reads the selected account; this reads every account, which
 * is a different question and only failover asks it. Two accounts on one
 * billing plan share a limit, so a handover has to check the successor's
 * headroom *before* launching into it — otherwise the hop lands in an immediate
 * second stop.
 */
export interface AccountUsage {
  provider: string;
  accountId: string;
  label: string;
  active: boolean;
  /**
   * Whether this account resolves to a login of its own.
   *
   * False for a managed Claude account on macOS: the login Keychain holds one
   * item per CLI, so relocating the config dir moves settings but not the
   * login, and this account shares the default account's credential. Handing
   * work to it would hand it back to the login that just ran out.
   */
  distinctLogin: boolean;
  usage: ProviderUsage;
}

/**
 * Headroom for every account of every account-capable CLI.
 *
 * Shares Rust's per-account freshness cache with the panel's own poll, so this
 * costs no extra network traffic for whichever account is selected.
 */
export async function fetchAccountUsage(force = false): Promise<AccountUsage[]> {
  if (!isTauriRuntime()) return [];
  try {
    const invoke = await invoker();
    return await invoke<AccountUsage[]>('usage_fetch_accounts', { force });
  } catch (err) {
    // Same rule as `refreshAccounts`: a failed read is reported, never rendered
    // as "you have no accounts". Failover treats an empty list as "nothing
    // qualifies", which stops rather than hops — the safe direction.
    accountsState.update((s) => ({ ...s, error: String(err) }));
    return [];
  }
}

/** Accounts for one provider, default first then alphabetically by label. */
export function accountsFor(state: AccountsState, provider: string): AgentAccount[] {
  return state.accounts
    .filter((account) => account.provider === provider)
    .sort((a, b) => {
      if (a.id === DEFAULT_ACCOUNT_ID) return -1;
      if (b.id === DEFAULT_ACCOUNT_ID) return 1;
      return a.label.localeCompare(b.label);
    });
}

/** The active account for a provider, if that provider supports switching. */
export function activeAccount(state: AccountsState, provider: string): AgentAccount | null {
  return state.accounts.find((a) => a.provider === accountProviderFor(provider) && a.active) ?? null;
}

/** CLI aliases and transcript ids share the account provider's namespace. */
export function accountProviderFor(command: string): string {
  return command === 'agy' ? 'antigravity' : command === 'cursor-agent' ? 'cursor' : command;
}

/** Whether a provider gets its numbers from a linked browser session. */
export function isWebSessionProvider(state: AccountsState, provider: string): boolean {
  return state.sessions.some((session) => session.provider === provider);
}

export function isConnected(state: AccountsState, provider: string): boolean {
  return state.sessions.some((s) => s.provider === provider && s.connected);
}

/** Providers that support more than one account, in table order. */
export function switchableProviders(state: AccountsState): { provider: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const account of state.accounts) {
    if (!seen.has(account.provider)) seen.set(account.provider, account.providerName);
  }
  return [...seen].map(([provider, name]) => ({ provider, name }));
}
