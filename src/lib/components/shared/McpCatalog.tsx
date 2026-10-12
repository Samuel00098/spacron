import { useMemo, useState, type CSSProperties } from 'react';
import { useStore } from '$lib/react/useStore';
import { mcpServers } from '$lib/stores/settings';
import {
  MCP_CATALOG,
  MCP_CATEGORIES,
  catalogServer,
  installedFrom,
  matchesCatalogQuery,
  type McpCatalogEntry,
} from '$lib/services/mcp-catalog';
import { validateServer } from '$lib/services/mcp-servers';
import './McpCatalog.css';

/** Relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/**
 * The brand tile. A near-black brand (GitHub, Notion, Vercel) would vanish on
 * the dark panel, so it flips to a light tile with a dark glyph, as Codex's
 * plugin list does; a very light brand gets a dark glyph on its colour.
 */
function CatalogIcon({ entry }: { entry: McpCatalogEntry }) {
  const lum = luminance(entry.color);
  const background = lum < 0.03 ? '#f1f1f3' : entry.color;
  const glyph = lum < 0.03 || lum > 0.55 ? '#111114' : '#ffffff';
  const style: CSSProperties = { backgroundColor: background, color: glyph };
  if (!entry.icon) {
    return (
      <span className="mcp-catalog-icon" style={style} aria-hidden="true">
        <span className="mcp-catalog-letter">{entry.name.charAt(0).toUpperCase()}</span>
      </span>
    );
  }
  const mask = `url("/mcp-icons/${entry.icon}.svg")`;
  return (
    <span className="mcp-catalog-icon" style={style} aria-hidden="true">
      <span
        className="mcp-catalog-glyph"
        style={{ backgroundColor: glyph, WebkitMaskImage: mask, maskImage: mask }}
      />
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

/**
 * Settings > MCP > Catalog: one-click installs of ready-made servers.
 *
 * An install appends an ordinary row to the user's server list, so it reaches
 * every agent CLI and the chat through the existing writers, and appears under
 * "Your servers" where it can be edited or removed like any other.
 */
export function McpCatalog({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const servers = useStore(mcpServers);
  const [query, setQuery] = useState('');
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const visible = useMemo(() => MCP_CATALOG.filter((e) => matchesCatalogQuery(e, query)), [query]);

  const install = (entry: McpCatalogEntry, withToken = '') => {
    const server = catalogServer(entry, withToken);
    const problem = validateServer(server, servers);
    if (problem) {
      // Almost always a hand-added server with the same name.
      setError(`${entry.name}: ${problem} Rename or remove it under Your servers first.`);
      return;
    }
    mcpServers.set([...servers, server]);
    setKeyFor(null);
    setToken('');
    setError('');
  };

  const onAdd = (entry: McpCatalogEntry) => {
    setError('');
    if (entry.auth === 'key' && !entry.key?.optional) {
      setKeyFor(entry.id === keyFor ? null : entry.id);
      setToken('');
      return;
    }
    install(entry);
  };

  const remove = (entry: McpCatalogEntry) => {
    const row = installedFrom(entry, servers);
    if (row) mcpServers.set(servers.filter((s) => s.id !== row.id));
  };

  const keyPanel = (entry: McpCatalogEntry) => (
    <div className="mcp-catalog-key">
      <label className="mcp-catalog-key-label" htmlFor={`mcp-key-${entry.id}`}>
        {entry.key!.label}
      </label>
      <div className="mcp-catalog-key-row">
        <input
          id={`mcp-key-${entry.id}`}
          type="password"
          value={token}
          autoFocus
          placeholder="Paste token"
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && token.trim()) install(entry, token);
            if (event.key === 'Escape') setKeyFor(null);
          }}
        />
        <button className="settings-primary" disabled={!token.trim()} onClick={() => install(entry, token)}>
          Install
        </button>
        <button className="settings-secondary" onClick={() => setKeyFor(null)}>Cancel</button>
      </div>
      <button className="settings-link-button" onClick={() => onOpenUrl(entry.key!.url)}>
        Get a token
      </button>
    </div>
  );

  return (
    <div className="mcp-catalog">
      <div className="mcp-catalog-head">
        <p className="shell-hint">
          Add a ready-made server to every agent in one click. Servers marked <em>sign-in</em> open
          a browser to sign in the first time an agent uses them; Spacron's chat cannot sign in to
          those yet.
        </p>
        <input
          className="mcp-catalog-search"
          type="search"
          value={query}
          placeholder="Search servers"
          aria-label="Search the MCP catalog"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error && <p className="shell-hint mcp-server-problem">{error}</p>}
      {MCP_CATEGORIES.map((category) => {
        const entries = visible.filter((e) => e.category === category.id);
        if (!entries.length) return null;
        return (
          <div className="mcp-catalog-group" key={category.id}>
            <h4 className="mcp-catalog-group-title">{category.label}</h4>
            <div className="mcp-catalog-grid">
              {entries.map((entry) => {
                const installed = !!installedFrom(entry, servers);
                return (
                  <div className="mcp-catalog-item" key={entry.id}>
                    <div className="mcp-catalog-row">
                      <CatalogIcon entry={entry} />
                      <div className="mcp-catalog-text">
                        <div className="mcp-catalog-name">
                          {entry.name}
                          {entry.auth === 'oauth' && <span className="mcp-catalog-badge">sign-in</span>}
                          {entry.auth === 'key' && <span className="mcp-catalog-badge">token</span>}
                        </div>
                        <div className="mcp-catalog-desc">{entry.note ?? entry.description}</div>
                      </div>
                      {installed ? (
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
                          title={`Add ${entry.name}`}
                          aria-label={`Add ${entry.name}`}
                          aria-expanded={entry.auth === 'key' ? keyFor === entry.id : undefined}
                          onClick={() => onAdd(entry)}
                        >
                          <PlusIcon />
                        </button>
                      )}
                    </div>
                    {keyFor === entry.id && !installed && keyPanel(entry)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {!visible.length && <p className="shell-hint">No servers match “{query}”.</p>}
    </div>
  );
}
