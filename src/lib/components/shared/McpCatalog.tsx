import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { get } from '$lib/stores/storeCompat';
import { mcpServers } from '$lib/stores/settings';
import {
  MCP_CATALOG,
  MCP_CATEGORIES,
  catalogServer,
  installedFrom,
  matchesCatalogQuery,
  type McpCatalogEntry,
} from '$lib/services/mcp-catalog';
import { serverKey, validateServer } from '$lib/services/mcp-servers';
import './McpCatalog.css';

/**
 * The vendor's own icon (from its website) on a neutral tile, or a lettered
 * tile when there is none.
 */
function CatalogIcon({ entry }: { entry: McpCatalogEntry }) {
  if (entry.icon) {
    return (
      <span className="mcp-catalog-icon is-image" aria-hidden="true">
        <img src={`/mcp-icons/${entry.icon}`} alt="" draggable={false} />
      </span>
    );
  }
  const style: CSSProperties = { backgroundColor: entry.color ?? 'var(--accent)', color: '#ffffff' };
  return (
    <span className="mcp-catalog-icon" style={style} aria-hidden="true">
      <span className="mcp-catalog-letter">{entry.name.charAt(0).toUpperCase()}</span>
    </span>
  );
}

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
);

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
  </svg>
);

const SearchIcon = () => (
  <svg className="mcp-catalog-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
  </svg>
);

/** The config key, which is also the sign-in store's key for the server. */
const keyOf = (entry: McpCatalogEntry) => serverKey({ name: entry.name });

/** Errors that are the user's own doing and need no explanation. */
const quietFailure = (message: string) => /^(cancelled|timeout):/.test(message);

type Pending = { id: string; kind: 'token' } | { id: string; kind: 'signing-in' };

/**
 * Settings > MCP > Catalog: one-click installs of ready-made servers.
 *
 * A sign-in server is installed only once the user has signed in, in their
 * own browser (`commands/mcp_oauth.rs`); if Spacron already holds a sign-in
 * for it, it installs straight away. An install appends an ordinary row to the
 * user's server list, so it reaches every agent CLI and the chat through the
 * existing writers — signed-in ones through Spacron's proxy.
 */
export function McpCatalog({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const servers = useStore(mcpServers);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [signedIn, setSignedIn] = useState<Record<string, boolean>>({});

  const refreshStatus = useCallback(async () => {
    const keys = MCP_CATALOG.filter((e) => e.auth === 'oauth').map(keyOf);
    try {
      setSignedIn(await invoke<Record<string, boolean>>('mcp_oauth_status', { keys }));
    } catch {
      // Not in the desktop app (browser build): nobody is signed in.
    }
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const visible = useMemo(() => MCP_CATALOG.filter((e) => matchesCatalogQuery(e, query)), [query]);

  const setError = (id: string, message: string | null) =>
    setErrors((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const install = (entry: McpCatalogEntry, options: { token?: string; oauth?: boolean } = {}) => {
    const current = get(mcpServers);
    const server = { ...catalogServer(entry, options.token ?? ''), oauth: options.oauth || undefined };
    const problem = validateServer(server, current);
    if (problem) {
      // Almost always a hand-added server with the same name.
      setError(entry.id, `${problem} Rename or remove it under Your servers first.`);
      return;
    }
    mcpServers.set([...current, server]);
    setError(entry.id, null);
  };

  /** Mark an installed row as signed in through Spacron, or add it if missing. */
  const markSignedIn = (entry: McpCatalogEntry) => {
    const current = get(mcpServers);
    const row = installedFrom(entry, current);
    if (row) mcpServers.set(current.map((s) => (s.id === row.id ? { ...s, oauth: true, headers: undefined } : s)));
    else install(entry, { oauth: true });
  };

  const signIn = async (entry: McpCatalogEntry) => {
    setError(entry.id, null);
    setPending({ id: entry.id, kind: 'signing-in' });
    try {
      await invoke('mcp_oauth_sign_in', { key: keyOf(entry), url: entry.url, name: entry.name });
      markSignedIn(entry);
      await refreshStatus();
    } catch (e) {
      const message = String(e);
      if (!quietFailure(message)) setError(entry.id, message);
    } finally {
      setPending((p) => (p?.id === entry.id ? null : p));
    }
  };

  const onAdd = (entry: McpCatalogEntry) => {
    setError(entry.id, null);
    if (entry.auth === 'key' && !entry.key?.optional) {
      setToken('');
      setPending(pending?.id === entry.id ? null : { id: entry.id, kind: 'token' });
      return;
    }
    if (entry.auth === 'oauth') {
      if (signedIn[keyOf(entry)]) install(entry, { oauth: true });
      else void signIn(entry);
      return;
    }
    install(entry);
  };

  const cancelSignIn = (entry: McpCatalogEntry) => {
    void invoke('mcp_oauth_cancel', { key: keyOf(entry) }).catch(() => {});
    setPending(null);
  };

  const remove = (entry: McpCatalogEntry) => {
    const current = get(mcpServers);
    const row = installedFrom(entry, current);
    if (row) mcpServers.set(current.filter((s) => s.id !== row.id));
  };

  const signOut = async (entry: McpCatalogEntry) => {
    try {
      await invoke('mcp_oauth_sign_out', { key: keyOf(entry) });
    } finally {
      await refreshStatus();
    }
  };

  const tokenPanel = (entry: McpCatalogEntry) => (
    <div className="mcp-catalog-panel">
      <label className="mcp-catalog-panel-label" htmlFor={`mcp-key-${entry.id}`}>{entry.key!.label}</label>
      <div className="mcp-catalog-panel-row">
        <input
          id={`mcp-key-${entry.id}`}
          type="password"
          value={token}
          autoFocus
          placeholder="Paste token"
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && token.trim()) { install(entry, { token }); setPending(null); }
            if (event.key === 'Escape') setPending(null);
          }}
        />
        <button
          className="settings-primary"
          disabled={!token.trim()}
          onClick={() => { install(entry, { token }); setPending(null); }}
        >
          Install
        </button>
        <button className="settings-secondary" onClick={() => setPending(null)}>Cancel</button>
      </div>
      <button className="settings-link-button mcp-catalog-panel-link" onClick={() => onOpenUrl(entry.key!.url)}>
        Get a token
      </button>
    </div>
  );

  const status = (entry: McpCatalogEntry, installed: boolean) => {
    if (entry.auth === 'key') return <span className="mcp-catalog-badge">Token</span>;
    if (entry.auth !== 'oauth') return null;
    if (signedIn[keyOf(entry)]) return <span className="mcp-catalog-badge is-ok">Signed in</span>;
    return <span className="mcp-catalog-badge">{installed ? 'Not signed in' : 'Sign-in'}</span>;
  };

  return (
    <div className="mcp-catalog">
      <div className="mcp-catalog-head">
        <p className="mcp-catalog-intro">
          Add a ready-made server to every agent and the chat in one click. Servers marked{' '}
          <strong>Sign-in</strong> open your browser so you can sign in first.
        </p>
        <label className="mcp-catalog-search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder="Search servers"
            aria-label="Search the MCP catalog"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {MCP_CATEGORIES.map((category) => {
        const entries = visible.filter((e) => e.category === category.id);
        if (!entries.length) return null;
        return (
          <section className="mcp-catalog-group" key={category.id} aria-label={category.label}>
            <h4 className="mcp-catalog-group-title">{category.label}</h4>
            <div className="mcp-catalog-grid">
              {entries.map((entry) => {
                const installed = !!installedFrom(entry, servers);
                const isSigningIn = pending?.id === entry.id && pending.kind === 'signing-in';
                const needsSignIn = installed && entry.auth === 'oauth' && !signedIn[keyOf(entry)];
                const error = errors[entry.id];
                return (
                  <div className="mcp-catalog-item" key={entry.id}>
                    <div className="mcp-catalog-row">
                      <CatalogIcon entry={entry} />
                      <div className="mcp-catalog-text">
                        <div className="mcp-catalog-name">
                          <span className="mcp-catalog-title">{entry.name}</span>
                          {status(entry, installed)}
                        </div>
                        <div className="mcp-catalog-desc" title={entry.note ?? entry.description}>
                          {isSigningIn ? 'Finish signing in in your browser…' : entry.note ?? entry.description}
                        </div>
                      </div>
                      {isSigningIn ? (
                        <button className="settings-secondary mcp-catalog-text-button" onClick={() => cancelSignIn(entry)}>
                          Cancel
                        </button>
                      ) : needsSignIn ? (
                        <button className="settings-secondary mcp-catalog-text-button" onClick={() => void signIn(entry)}>
                          Sign in
                        </button>
                      ) : installed ? (
                        <button
                          className="mcp-catalog-action is-installed"
                          title={`Remove ${entry.name}`}
                          aria-label={`Remove ${entry.name}`}
                          onClick={() => remove(entry)}
                        >
                          <span className="mcp-catalog-check"><CheckIcon /></span>
                          <span className="mcp-catalog-remove"><CloseIcon /></span>
                        </button>
                      ) : (
                        <button
                          className="mcp-catalog-action"
                          title={entry.auth === 'oauth' && !signedIn[keyOf(entry)] ? `Sign in and add ${entry.name}` : `Add ${entry.name}`}
                          aria-label={`Add ${entry.name}`}
                          aria-expanded={entry.auth === 'key' ? pending?.id === entry.id : undefined}
                          disabled={pending?.kind === 'signing-in'}
                          onClick={() => onAdd(entry)}
                        >
                          <PlusIcon />
                        </button>
                      )}
                    </div>
                    {pending?.id === entry.id && pending.kind === 'token' && !installed && tokenPanel(entry)}
                    {error && (
                      <div className="mcp-catalog-panel">
                        <p className="mcp-catalog-error">{error}</p>
                        {entry.auth === 'oauth' && !installed && (
                          <button className="settings-link-button mcp-catalog-panel-link" onClick={() => install(entry)}>
                            Add without signing in (each agent signs in itself)
                          </button>
                        )}
                      </div>
                    )}
                    {installed && entry.auth === 'oauth' && signedIn[keyOf(entry)] && (
                      <button className="settings-link-button mcp-catalog-signout" onClick={() => void signOut(entry)}>
                        Sign out
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {!visible.length && <p className="mcp-catalog-empty">No servers match “{query}”.</p>}
    </div>
  );
}
