import { describe, it, expect } from 'vitest';
import {
  accountsFor,
  activeAccount,
  isConnected,
  isWebSessionProvider,
  switchableProviders,
  DEFAULT_ACCOUNT_ID,
  type AccountsState,
  type AgentAccount,
  type WebSessionStatus,
} from './agentAccounts';

function account(over: Partial<AgentAccount> = {}): AgentAccount {
  return {
    provider: 'claude',
    providerName: 'Claude Code',
    id: DEFAULT_ACCOUNT_ID,
    label: 'Default account',
    signedIn: true,
    active: false,
    ...over,
  };
}

function state(over: Partial<AccountsState> = {}): AccountsState {
  return { sessions: [], accounts: [], connecting: null, error: null, ...over };
}

function session(over: Partial<WebSessionStatus> = {}): WebSessionStatus {
  return { provider: 'opencode', name: 'OpenCode', connected: false, ...over };
}

describe('accountsFor', () => {
  it('always lists the default account first', () => {
    // The user's own home-directory account is the one they had before Spacron
    // existed; burying it under an alphabetised list would read as demotion.
    const s = state({
      accounts: [
        account({ id: 'work', label: 'Work' }),
        account({ id: DEFAULT_ACCOUNT_ID, label: 'zed@example.com' }),
        account({ id: 'alpha', label: 'Alpha' }),
      ],
    });
    expect(accountsFor(s, 'claude').map((a) => a.id)).toEqual([
      DEFAULT_ACCOUNT_ID,
      'alpha',
      'work',
    ]);
  });

  it('keeps providers apart', () => {
    const s = state({
      accounts: [
        account({ provider: 'claude', id: 'a', label: 'A' }),
        account({ provider: 'codex', id: 'b', label: 'B' }),
      ],
    });
    expect(accountsFor(s, 'codex').map((a) => a.id)).toEqual(['b']);
  });

  it('returns nothing for a provider that does not do accounts', () => {
    // The switcher renders nothing on an empty list, which is what keeps the
    // control off every row that only ever has one account.
    expect(accountsFor(state(), 'gemini')).toEqual([]);
  });
});

describe('activeAccount', () => {
  it('finds the active account for the right provider', () => {
    const s = state({
      accounts: [
        account({ provider: 'claude', id: 'work', label: 'Work', active: true }),
        account({ provider: 'codex', id: 'other', label: 'Other', active: true }),
      ],
    });
    expect(activeAccount(s, 'claude')?.label).toBe('Work');
    expect(activeAccount(s, 'codex')?.label).toBe('Other');
  });

  it('is null when nothing is marked active', () => {
    expect(activeAccount(state({ accounts: [account()] }), 'claude')).toBeNull();
  });
});

describe('web sessions', () => {
  it('knows which providers meter through a browser session', () => {
    const s = state({ sessions: [session(), session({ provider: 'minimax' })] });
    expect(isWebSessionProvider(s, 'opencode')).toBe(true);
    expect(isWebSessionProvider(s, 'minimax')).toBe(true);
    expect(isWebSessionProvider(s, 'claude')).toBe(false);
  });

  it('separates "has a session slot" from "is connected"', () => {
    // The row shows a Connect button precisely in the gap between these two —
    // collapsing them would either hide the button or show it forever.
    const s = state({ sessions: [session({ connected: false })] });
    expect(isWebSessionProvider(s, 'opencode')).toBe(true);
    expect(isConnected(s, 'opencode')).toBe(false);

    const linked = state({ sessions: [session({ connected: true })] });
    expect(isConnected(linked, 'opencode')).toBe(true);
  });

  it('reports an unknown provider as not connected rather than throwing', () => {
    expect(isConnected(state(), 'nothing')).toBe(false);
  });
});

describe('switchableProviders', () => {
  it('lists each provider once, in the order the backend gave them', () => {
    const s = state({
      accounts: [
        account({ provider: 'claude', providerName: 'Claude Code', id: DEFAULT_ACCOUNT_ID }),
        account({ provider: 'claude', providerName: 'Claude Code', id: 'work' }),
        account({ provider: 'codex', providerName: 'Codex CLI', id: DEFAULT_ACCOUNT_ID }),
      ],
    });
    expect(switchableProviders(s)).toEqual([
      { provider: 'claude', name: 'Claude Code' },
      { provider: 'codex', name: 'Codex CLI' },
    ]);
  });

  it('is empty when there are no accounts at all', () => {
    expect(switchableProviders(state())).toEqual([]);
  });
});
