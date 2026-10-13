import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  AddMarketplacePanel,
  AddMenu,
  CreatePluginPanel,
  InstallReview,
  MarketplacesTab,
  YourPluginsTab,
  pickPluginSource,
  type AddAction,
} from './McpPlugins';
import type { PluginOrigin, PluginSummary } from '$lib/services/plugins';
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
  return (
    <span className="mcp-catalog-icon is-letter" aria-hidden="true">
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

type Pending =
  | { id: string; kind: 'token' }
  | { id: string; kind: 'signing-in' }
  /** Asking for the user's own OAuth client (see `McpCatalogEntry.ownClient`). */
  | { id: string; kind: 'client' };

/** Sign-in found no way to register and no saved client of the user's own. */
const needsClient = (message: string) => /^needs_client:/.test(message);

/**
 * Settings > MCP > Catalog: one-click installs of ready-made servers.
 *
 * A sign-in server is installed only once the user has signed in, in their
 * own browser (`commands/mcp_oauth.rs`); if Spacron already holds a sign-in
 * for it, it installs straight away. An install appends an ordinary row to the
 * user's server list, so it reaches every agent CLI and the chat through the
 * existing writers — signed-in ones through Spacron's proxy.
 */
type Tab = 'catalog' | 'marketplaces' | 'yours';
type Sheet =
  | { kind: 'review'; summary: PluginSummary; origin: PluginOrigin }
  | { kind: 'create' }
  | { kind: 'marketplace' }
  | null;

const TABS: { id: Tab; label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'marketplaces', label: 'Marketplaces' },
  { id: 'yours', label: 'Your plugins' },
];

export function McpCatalog({
  onOpenUrl,
  onAddCustomServer,
}: {
  onOpenUrl: (url: string) => void;
  onAddCustomServer: () => void;
}) {
  const [tab, setTab] = useState<Tab>('catalog');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [notice, setNotice] = useState('');
  const [market, setMarket] = useState<string | null>(null);

  // A confirmation is for the moment it happens, not a banner that follows
  // the user around the tabs.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const review = (summary: PluginSummary, origin: PluginOrigin) => {
    setNotice('');
    setSheet({ kind: 'review', summary, origin });
  };

  const onAddAction = async (action: AddAction) => {
    setNotice('');
    if (action === 'custom') { setSheet(null); onAddCustomServer(); return; }
    if (action === 'create') { setSheet({ kind: 'create' }); return; }
    if (action === 'marketplace') { setSheet({ kind: 'marketplace' }); return; }
    try {
      const picked = await pickPluginSource('archive');
      if (picked) review(picked.summary, picked.origin);
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    }
  };

  const uploadFolder = async () => {
    try {
      const picked = await pickPluginSource('folder');
      if (picked) review(picked.summary, picked.origin);
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    }
  };

  const servers = useStore(mcpServers);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
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

  const askForClient = (entry: McpCatalogEntry) => {
    setError(entry.id, null);
    setClientId('');
    setClientSecret('');
    setPending({ id: entry.id, kind: 'client' });
  };

  /** `client` is an OAuth client the user just pasted; without it the backend
   * registers, or reuses one pasted earlier for the same authorization server. */
  const signIn = async (entry: McpCatalogEntry, client?: { id: string; secret: string }) => {
    setError(entry.id, null);
    setPending({ id: entry.id, kind: 'signing-in' });
    let askClient = false;
    try {
      await invoke('mcp_oauth_sign_in', {
        key: keyOf(entry),
        url: entry.url,
        name: entry.name,
        clientId: client?.id.trim() || null,
        clientSecret: client?.secret.trim() || null,
        scopes: entry.ownClient?.scopes ?? null,
      });
      markSignedIn(entry);
      await refreshStatus();
    } catch (e) {
      const message = String(e);
      if (needsClient(message) && entry.ownClient) askClient = true;
      else if (!quietFailure(message)) setError(entry.id, message);
    } finally {
      setPending((p) => (p?.id === entry.id ? (askClient ? { id: entry.id, kind: 'client' } : null) : p));
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
      <button className="settings-secondary mcp-small-button mcp-catalog-panel-link" onClick={() => onOpenUrl(entry.key!.url)}>
        Get a token
      </button>
    </div>
  );

  const submitClient = (entry: McpCatalogEntry) => {
    if (!clientId.trim()) return;
    void signIn(entry, { id: clientId, secret: clientSecret });
  };

  const clientPanel = (entry: McpCatalogEntry) => (
    <div className="mcp-catalog-panel">
      <p className="mcp-catalog-panel-label">
        {entry.name} needs an OAuth client from your own Google Cloud project. Create one of type
        Desktop app, then paste it here; it is kept on this computer and reused for the other
        Google servers.
      </p>
      <div className="mcp-catalog-panel-row">
        <input
          aria-label="OAuth client ID"
          value={clientId}
          autoFocus
          placeholder="Client ID"
          onChange={(event) => setClientId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitClient(entry);
            if (event.key === 'Escape') setPending(null);
          }}
        />
      </div>
      <div className="mcp-catalog-panel-row mcp-catalog-panel-row-gap">
        <input
          aria-label="OAuth client secret"
          type="password"
          value={clientSecret}
          placeholder="Client secret"
          onChange={(event) => setClientSecret(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitClient(entry);
            if (event.key === 'Escape') setPending(null);
          }}
        />
        <button className="settings-primary" disabled={!clientId.trim()} onClick={() => submitClient(entry)}>
          Sign in
        </button>
        <button className="settings-secondary" onClick={() => setPending(null)}>Cancel</button>
      </div>
      <button className="settings-secondary mcp-small-button mcp-catalog-panel-link" onClick={() => onOpenUrl(entry.ownClient!.guide)}>
        How to set it up
      </button>
    </div>
  );

  const status = (entry: McpCatalogEntry, installed: boolean) => {
    if (entry.auth === 'key') return <span className="mcp-catalog-badge">Token</span>;
    if (entry.auth !== 'oauth') return null;
    // The same pill the Agents tab uses for a signed-in CLI.
    if (signedIn[keyOf(entry)]) return <span className="agents-row-badge" data-tone="ready">Signed in</span>;
    return <span className="mcp-catalog-badge">{installed ? 'Not signed in' : 'Sign-in'}</span>;
  };

  return (
    <div className="mcp-catalog">
      <p className="mcp-catalog-intro">
        Give every agent and the chat new tools in one click. Servers marked{' '}
        <strong>Sign-in</strong> open your browser so you can sign in first; plugins bundle
        servers with skills.
      </p>

      <div className="mcp-toolbar">
      <div className="mcp-catalog-head">
        <label className="mcp-catalog-search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder={tab === 'catalog' ? 'Search servers' : 'Search plugins'}
            aria-label="Search"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <AddMenu onPick={(action) => void onAddAction(action)} />
      </div>

      <div className="mcp-tabs" role="tablist" aria-label="Catalog sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`mcp-pill${tab === t.id ? ' is-active' : ''}`}
            onClick={() => { setTab(t.id); setNotice(''); }}
          >
            {t.label}
          </button>
        ))}
      </div>
      </div>

      {notice && <p className="mcp-notice">{notice}</p>}
      {sheet?.kind === 'review' && (
        <InstallReview
          key={sheet.summary.path}
          summary={sheet.summary}
          origin={sheet.origin}
          onCancel={() => setSheet(null)}
          onDone={(message) => { setSheet(null); setNotice(message); setTab('yours'); }}
        />
      )}
      {sheet?.kind === 'create' && (
        <CreatePluginPanel
          onCancel={() => setSheet(null)}
          onDone={(message) => { setSheet(null); setNotice(message); setTab('yours'); }}
        />
      )}
      {sheet?.kind === 'marketplace' && (
        <AddMarketplacePanel
          onCancel={() => setSheet(null)}
          onDone={(m) => { setSheet(null); setMarket(m.id); setTab('marketplaces'); setNotice(`Added ${m.name}.`); }}
        />
      )}

      {tab === 'marketplaces' && (
        <MarketplacesTab query={query} selected={market} onSelect={setMarket} onReview={review} />
      )}
      {tab === 'yours' && (
        <>
          <YourPluginsTab query={query} onReview={review} onNotice={setNotice} />
          <button className="settings-secondary mcp-small-button mcp-folder-link" onClick={() => void uploadFolder()}>
            Install a plugin from a folder…
          </button>
        </>
      )}
      {tab === 'catalog' && <>

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
                    <div
                      className={`mcp-catalog-row${!installed && !isSigningIn ? ' is-clickable' : ''}`}
                      onClick={(event) => {
                        // A click anywhere on the row installs, like its button;
                        // the buttons inside handle their own clicks.
                        if ((event.target as HTMLElement).closest('button, input, a, label')) return;
                        if (!installed && !isSigningIn && pending?.kind !== 'signing-in') onAdd(entry);
                      }}
                    >
                      <CatalogIcon entry={entry} />
                      <div className="mcp-catalog-text">
                        <div className="mcp-catalog-name">
                          <span className="mcp-catalog-title">{entry.name}</span>
                          {status(entry, installed)}
                        </div>
                        <div className="mcp-catalog-desc">
                          {isSigningIn ? 'Finish signing in in your browser…' : entry.note ?? entry.description}
                        </div>
                      </div>
                      {isSigningIn ? (
                        <button className="settings-secondary mcp-small-button mcp-row-button" onClick={() => cancelSignIn(entry)}>
                          Cancel
                        </button>
                      ) : needsSignIn ? (
                        <button className="settings-secondary mcp-small-button mcp-row-button" onClick={() => void signIn(entry)}>
                          Sign in
                        </button>
                      ) : installed ? (
                        <button
                          className="mcp-catalog-action is-installed"
                          aria-label={`Remove ${entry.name}`}
                          onClick={() => remove(entry)}
                        >
                          <span className="mcp-catalog-check"><CheckIcon /></span>
                          <span className="mcp-catalog-remove"><CloseIcon /></span>
                        </button>
                      ) : (
                        <button
                          className="mcp-catalog-action"
                          aria-label={`Install ${entry.name}`}
                          aria-expanded={entry.auth === 'key' ? pending?.id === entry.id : undefined}
                          disabled={pending?.kind === 'signing-in'}
                          onClick={() => onAdd(entry)}
                        >
                          <PlusIcon />
                        </button>
                      )}
                    </div>
                    {pending?.id === entry.id && pending.kind === 'token' && !installed && tokenPanel(entry)}
                    {pending?.id === entry.id && pending.kind === 'client' && clientPanel(entry)}
                    {error && (
                      <div className="mcp-catalog-panel">
                        <p className="mcp-catalog-error">{error}</p>
                        {entry.ownClient && (
                          <button className="settings-secondary mcp-small-button mcp-catalog-panel-link" onClick={() => askForClient(entry)}>
                            Use a different OAuth client
                          </button>
                        )}
                        {entry.auth === 'oauth' && !installed && (
                          <button className="settings-secondary mcp-small-button mcp-catalog-panel-link" onClick={() => install(entry)}>
                            Add without signing in (each agent signs in itself)
                          </button>
                        )}
                      </div>
                    )}
                    {installed && entry.auth === 'oauth' && signedIn[keyOf(entry)] && (
                      <button className="settings-secondary mcp-small-button mcp-catalog-signout" onClick={() => void signOut(entry)}>
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
      </>}
    </div>
  );
}
