import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useStore } from '$lib/react/useStore';
import { get } from '$lib/stores/storeCompat';
import { activeProject } from '$lib/stores/workspace';
import { closeSettings } from '$lib/stores/layout';
import { setInteractionMode } from '$lib/stores/interactionMode';
import { createChatThread, selectChatThread } from '$lib/stores/chatThreads';
import { sendChatMessage } from '$lib/stores/orchestrator';
import {
  createPluginFolder,
  downloadMarketplacePlugin,
  fetchMarketplace,
  installPlugin,
  installedPlugins,
  isPluginInstalled,
  marketplaceId,
  PLUGIN_GROUPS,
  pluginGroup,
  pluginMarketplaces,
  readPluginFolder,
  listingIcon,
  uninstallPlugin,
  unpackArchive,
  type InstalledPlugin,
  type Marketplace,
  type MarketplacePlugin,
  type MarketplaceSource,
  type PluginOrigin,
  type PluginSummary,
} from '$lib/services/plugins';
import { PLUGIN_CREATOR_ICON, PLUGIN_CREATOR_ID, buildPluginRequest, writePluginCreator } from '$lib/services/plugin-creator';
import { MCP_CATALOG } from '$lib/services/mcp-catalog';
import { mcpServers } from '$lib/stores/settings';
import type { McpServer } from '$lib/services/mcp-servers';

const quiet = (message: string) => /^(Error: )?(cancelled|timeout):/.test(message);
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, '');

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** A plugin's icon: its own (manifest or homepage), else a lettered tile. */
export function PluginIcon({
  title,
  icon,
  homepage,
  listing,
}: {
  title: string;
  icon?: string | null;
  homepage?: string | null;
  /** Where the plugin is listed, for looking its icon up. */
  listing?: { source: string; plugin: string } | null;
}) {
  const [src, setSrc] = useState<string | null>(icon ?? null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (icon || !listing || !ref.current) return;
    // Fetch the homepage icon only once the row scrolls into view: a
    // marketplace lists hundreds of plugins.
    const el = ref.current;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void listingIcon(listing.source, listing.plugin, homepage).then((data) => data && setSrc(data));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [icon, homepage, listing?.source, listing?.plugin]);
  return src ? (
    <span ref={ref} className="mcp-catalog-icon is-image" aria-hidden="true">
      <img src={src} alt="" draggable={false} />
    </span>
  ) : (
    <span ref={ref} className="mcp-catalog-icon is-letter" aria-hidden="true">
      <span className="mcp-catalog-letter">{title.charAt(0).toUpperCase()}</span>
    </span>
  );
}

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
);

const ChevronIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export type AddAction = 'create' | 'marketplace' | 'archive' | 'custom';

/** The header's Add button and its menu. */
export function AddMenu({ onPick }: { onPick: (action: AddAction) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const items: { id: AddAction; label: string; icon: string }[] = [
    { id: 'create', label: 'Create plugin', icon: 'M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z' },
    { id: 'marketplace', label: 'Add a marketplace', icon: 'M12 5v14M5 12h14' },
    { id: 'archive', label: 'Upload plugin archive', icon: 'M7 3h7l5 5v13H7zM14 3v5h5M12 18v-6M9 15l3-3 3 3' },
    { id: 'custom', label: 'Add custom MCP server', icon: 'M5 12h4l2-5 3 10 2-5h3' },
  ];
  return (
    <div className="mcp-add" ref={ref}>
      <button className="mcp-add-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Add <ChevronIcon />
      </button>
      {open && (
        <div className="mcp-add-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              className="mcp-add-item"
              onClick={() => { setOpen(false); onPick(item.id); }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d={item.icon} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Install review: what a plugin brings, its variables, Install / Cancel
// ---------------------------------------------------------------------------

/** What a server will reach or run, shown before anything is installed. */
function describeServer(spec: Record<string, unknown>): string {
  if (typeof spec.command === 'string') {
    const args = Array.isArray(spec.args) ? spec.args.map(String).join(' ') : '';
    return `runs: ${spec.command} ${args}`.trim();
  }
  const url = [spec.url, spec.serverUrl, spec.httpUrl].find((u) => typeof u === 'string');
  return typeof url === 'string' ? url : 'unsupported server shape';
}

export function InstallReview({
  summary,
  origin,
  onDone,
  onCancel,
}: {
  summary: PluginSummary;
  origin: PluginOrigin;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const servers = Object.keys(summary.mcpServers ?? {});
  const missing = summary.variables.filter((v) => !values[v]?.trim());

  const install = async () => {
    setError('');
    setBusy('Installing…');
    try {
      const { warnings } = await installPlugin(summary, origin, values, setBusy);
      onDone(warnings.length ? `Installed ${summary.title}. ${warnings.join(' ')}` : `Installed ${summary.title}.`);
    } catch (e) {
      const message = errorText(e);
      setBusy(null);
      if (!quiet(message)) setError(message);
    }
  };

  return (
    <div className="mcp-sheet">
      <div className="mcp-sheet-head">
        <PluginIcon
          title={summary.title}
          icon={summary.icon}
          homepage={summary.homepage}
          listing={origin.kind === 'marketplace' ? { source: origin.source, plugin: summary.name } : null}
        />
        <div className="mcp-catalog-text">
          <div className="mcp-catalog-name">
            <span className="mcp-catalog-title">{summary.title}</span>
            {summary.version && <span className="mcp-catalog-badge">v{summary.version}</span>}
          </div>
          <div className="mcp-sheet-desc">{summary.description || 'No description.'}</div>
        </div>
      </div>
      <ul className="mcp-sheet-list">
        <li>
          <strong>{servers.length} MCP server{servers.length === 1 ? '' : 's'}</strong>
          {servers.length ? ' for every agent and the chat:' : ''}
          {servers.length > 0 && (
            <ul className="mcp-sheet-servers">
              {Object.entries(summary.mcpServers).map(([key, spec]) => (
                <li key={key}>
                  <span className="mcp-sheet-server-name">{key}</span>
                  <code title={describeServer(spec)}>{describeServer(spec)}</code>
                </li>
              ))}
            </ul>
          )}
        </li>
        <li>
          <strong>{summary.skills.length} skill{summary.skills.length === 1 ? '' : 's'}</strong>
          {summary.skills.length ? ` for Claude Code and Codex: ${summary.skills.map((s) => s.name).join(', ')}` : ''}
        </li>
        {summary.claudeOnly.length > 0 && (
          <li className="is-muted">Also has {summary.claudeOnly.join(', ')}, which only Claude Code runs (install it there to use them).</li>
        )}
      </ul>
      {summary.variables.length > 0 && (
        <div className="mcp-sheet-vars">
          <p className="mcp-catalog-panel-label">This plugin needs these values. They are saved with its servers.</p>
          {summary.variables.map((name) => (
            <label key={name} className="mcp-sheet-var">
              <span>{name}</span>
              <input
                type={/KEY|TOKEN|SECRET|PASSWORD/i.test(name) ? 'password' : 'text'}
                value={values[name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      {error && <p className="mcp-catalog-error">{error}</p>}
      <div className="mcp-sheet-actions">
        <span className="mcp-sheet-status">{busy}</span>
        <button className="settings-secondary" onClick={onCancel} disabled={!!busy && !busy.startsWith('Sign in')}>Cancel</button>
        <button className="settings-primary" onClick={() => void install()} disabled={!!busy || missing.length > 0}>
          Install
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add a marketplace / Create plugin panels
// ---------------------------------------------------------------------------

export function AddMarketplacePanel({ onDone, onCancel }: { onDone: (m: MarketplaceSource) => void; onCancel: () => void }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const listing = await fetchMarketplace(source.trim());
      const entry: MarketplaceSource = { id: marketplaceId(source), source: source.trim(), name: listing.name };
      pluginMarketplaces.set([...get(pluginMarketplaces).filter((m) => m.id !== entry.id), entry]);
      onDone(entry);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mcp-sheet">
      <h4 className="mcp-sheet-title">Add a marketplace</h4>
      <p className="mcp-sheet-desc">
        A GitHub repository that lists plugins in <code>.claude-plugin/marketplace.json</code> (Claude Code) or{' '}
        <code>.agents/plugins/marketplace.json</code> (Codex).
      </p>
      <div className="mcp-catalog-panel-row">
        <input
          autoFocus
          value={source}
          placeholder="owner/repo or https://github.com/owner/repo"
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && source.trim()) void add(); if (e.key === 'Escape') onCancel(); }}
        />
        <button className="settings-primary" disabled={!source.trim() || busy} onClick={() => void add()}>
          {busy ? 'Checking…' : 'Add'}
        </button>
        <button className="settings-secondary" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="mcp-catalog-error">{error}</p>}
    </div>
  );
}

export function CreatePluginPanel({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const project = useStore(activeProject);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parent = project ? `${project.root_path.replace(/[\\/]+$/, '')}/plugins` : null;

  const create = async (withAi: boolean) => {
    setBusy(true);
    setError('');
    try {
      const summary = await createPluginFolder(parent, name.trim(), description.trim());
      await installPlugin(summary, { kind: 'created' }, {});
      if (withAi && project) {
        const thread = createChatThread(project.id, { title: `Build plugin: ${summary.title}` });
        selectChatThread(project.id, thread.id);
        setInteractionMode('chat');
        closeSettings();
        void sendChatMessage(project.id, project.root_path, buildPluginRequest(summary.title, summary.path, goal), { threadId: thread.id });
        return;
      }
      onDone(`Created ${summary.title} at ${summary.path}. Edit its files, then reinstall it from Your plugins.`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="mcp-sheet">
      <h4 className="mcp-sheet-title">Create plugin</h4>
      <p className="mcp-sheet-desc">
        {parent
          ? <>Made in this project at <code>plugins/</code>, so you can edit and commit it.</>
          : 'No project is open, so it is made in Spacron\'s own plugin folder.'}{' '}
        Describe what it should do and the chat builds it with the Plugin Creator.
      </p>
      <div className="mcp-sheet-form">
        <label className="mcp-sheet-var"><span>Name</span>
          <input autoFocus value={name} placeholder="Release notes" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="mcp-sheet-var"><span>Description</span>
          <input value={description} placeholder="One sentence: what it lets an agent do" onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="mcp-sheet-var"><span>What should it do?</span>
          <textarea rows={3} value={goal} placeholder="e.g. Use Linear and GitHub to write release notes from merged PRs" onChange={(e) => setGoal(e.target.value)} />
        </label>
      </div>
      {error && <p className="mcp-catalog-error">{error}</p>}
      <div className="mcp-sheet-actions">
        <span className="mcp-sheet-status">{busy ? 'Creating…' : ''}</span>
        <button className="settings-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="settings-secondary" onClick={() => void create(false)} disabled={busy || !name.trim()}>Create empty</button>
        <button
          className="settings-primary"
          onClick={() => void create(true)}
          disabled={busy || !name.trim() || !goal.trim() || !project}
          title={project ? undefined : 'Open a project to build with the chat'}
        >
          Build with AI
        </button>
      </div>
    </div>
  );
}

/** Upload: a .zip, or a plugin folder. Resolves to a summary ready to review. */
export async function pickPluginSource(kind: 'archive' | 'folder'): Promise<{ summary: PluginSummary; origin: PluginOrigin } | null> {
  const picked = await openDialog(
    kind === 'archive'
      ? { multiple: false, filters: [{ name: 'Plugin archive', extensions: ['zip'] }], title: 'Choose a plugin archive' }
      : { multiple: false, directory: true, title: 'Choose a plugin folder' },
  );
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;
  return kind === 'archive'
    ? { summary: await unpackArchive(path), origin: { kind: 'archive' } }
    : { summary: await readPluginFolder(path), origin: { kind: 'folder' } };
}

// ---------------------------------------------------------------------------
// Marketplaces tab
// ---------------------------------------------------------------------------

export function MarketplacesTab({
  query,
  selected,
  onSelect,
  onReview,
}: {
  query: string;
  selected: string | null;
  onSelect: (id: string) => void;
  onReview: (summary: PluginSummary, origin: PluginOrigin) => void;
}) {
  const markets = useStore(pluginMarketplaces);
  const installed = useStore(installedPlugins);
  const servers = useStore(mcpServers);
  const current = markets.find((m) => m.id === selected) ?? markets[0] ?? null;
  const [listing, setListing] = useState<Record<string, Marketplace | { error: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!current || listing[current.id]) return;
    fetchMarketplace(current.source)
      .then((m) => setListing((l) => ({ ...l, [current.id]: m })))
      .catch((e) => setListing((l) => ({ ...l, [current.id]: { error: errorText(e) } })));
  }, [current, listing]);

  const data = current ? listing[current.id] : undefined;
  const plugins = useMemo(() => {
    if (!data || 'error' in data) return [];
    const q = query.trim().toLowerCase();
    return data.plugins.filter((p) => !q || `${p.title} ${p.name} ${p.description} ${p.category ?? ''}`.toLowerCase().includes(q));
  }, [data, query]);

  const groups = useMemo(
    () =>
      PLUGIN_GROUPS.map((g) => ({ ...g, plugins: plugins.filter((p) => pluginGroup(p.category) === g.id) })).filter(
        (g) => g.plugins.length > 0,
      ),
    [plugins],
  );

  const download = async (market: MarketplaceSource, plugin: MarketplacePlugin) => {
    setBusy(plugin.name);
    setError('');
    try {
      const summary = await downloadMarketplacePlugin(market.source, plugin.name);
      onReview(summary, { kind: 'marketplace', marketplace: market.id, source: market.source });
    } catch (e) {
      setError(`${plugin.title}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const removeMarket = (m: MarketplaceSource) => {
    pluginMarketplaces.set(get(pluginMarketplaces).filter((x) => x.id !== m.id));
  };

  if (!current) return <p className="mcp-catalog-empty">No marketplaces. Add one from the Add menu.</p>;
  return (
    <div>
      <div className="mcp-market-pills" role="tablist" aria-label="Marketplaces">
        {markets.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={m.id === current.id}
            className={`mcp-pill${m.id === current.id ? ' is-active' : ''}`}
            onClick={() => onSelect(m.id)}
          >
            {m.name}
          </button>
        ))}
      </div>
      <div className="mcp-market-meta">
        <span className="shell-hint">{current.source}</span>
        <span className="mcp-market-meta-actions">
          <button className="settings-secondary mcp-small-button" onClick={() => setListing((l) => { const n = { ...l }; delete n[current.id]; return n; })}>Refresh</button>
          {!current.builtin && <button className="settings-secondary mcp-small-button" onClick={() => removeMarket(current)}>Remove marketplace</button>}
        </span>
      </div>
      <p className="mcp-market-warning">Only install plugins you trust: a plugin can run programs and reach services on your behalf.</p>
      {error && <p className="mcp-catalog-error">{error}</p>}
      {!data && <p className="mcp-catalog-empty">Loading {current.name}…</p>}
      {data && 'error' in data && <p className="mcp-catalog-error">{data.error}</p>}
      {data && !('error' in data) && (
        <>
          {groups.map((group) => (
            <section className="mcp-catalog-group" key={group.id} aria-label={group.label}>
              <h4 className="mcp-catalog-group-title">
                {group.label} <span className="mcp-group-count">{group.plugins.length}</span>
              </h4>
              <div className="mcp-catalog-grid">
                  {group.plugins.map((plugin) => {
            const isInstalled = isPluginInstalled(plugin.name, installed, servers);
            return (
              <div className="mcp-catalog-item" key={plugin.name}>
                <div className="mcp-catalog-row">
                  <PluginIcon title={plugin.title} homepage={plugin.homepage} listing={{ source: current.source, plugin: plugin.name }} />
                  <div className="mcp-catalog-text">
                    <div className="mcp-catalog-name">
                      <span className="mcp-catalog-title">{plugin.title}</span>
                    </div>
                    <div className="mcp-catalog-desc" title={plugin.description}>{plugin.description}</div>
                  </div>
                  {isInstalled ? (
                    <span className="mcp-catalog-badge is-ok">Installed</span>
                  ) : busy === plugin.name ? (
                    <span className="mcp-sheet-status">Downloading…</span>
                  ) : (
                    <button
                      className="mcp-catalog-action"
                      aria-label={`Add ${plugin.title}`}
                      title={plugin.installable ? `Add ${plugin.title}` : 'Not hosted on GitHub; Spacron cannot download it'}
                      disabled={!plugin.installable || !!busy}
                      onClick={() => void download(current, plugin)}
                    >
                      <PlusIcon />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
              </div>
            </section>
          ))}
          {!plugins.length && <p className="mcp-catalog-empty">No plugins match “{query}”.</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your plugins tab
// ---------------------------------------------------------------------------

/** Where an installed plugin is listed, for its icon. */
const listingOf = (p: InstalledPlugin) =>
  p.origin.kind === 'marketplace' ? { source: p.origin.source, plugin: p.name } : null;

const originLabel = (p: InstalledPlugin) =>
  p.origin.kind === 'marketplace' ? 'Marketplace'
  : p.origin.kind === 'archive' ? 'Archive'
  : p.origin.kind === 'folder' ? 'Folder'
  : p.origin.kind === 'created' ? 'Created'
  : 'Built in';

export function YourPluginsTab({
  query,
  onReview,
  onNotice,
}: {
  query: string;
  onReview: (summary: PluginSummary, origin: PluginOrigin) => void;
  onNotice: (message: string) => void;
}) {
  const installed = useStore(installedPlugins);
  const [busy, setBusy] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const list = installed.filter((p) => !q || `${p.title} ${p.description}`.toLowerCase().includes(q));
  const hasCreator = installed.some((p) => p.id === PLUGIN_CREATOR_ID);

  const reinstall = async (p: InstalledPlugin) => {
    setBusy(p.id);
    try {
      onReview(await readPluginFolder(p.path), p.origin);
    } catch (e) {
      onNotice(`${p.title}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const addCreator = async () => {
    setBusy(PLUGIN_CREATOR_ID);
    try {
      // One click installs it: Spacron wrote it, so there is nothing to review.
      const { plugin } = await installPlugin(await writePluginCreator(), { kind: 'builtin' }, {});
      onNotice(`Installed ${plugin.title}. Any agent can now build a plugin when you ask.`);
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {!hasCreator && (
        <div className="mcp-catalog-item mcp-creator-promo">
          <div className="mcp-catalog-row">
            <PluginIcon title="Plugin Creator" icon={`data:image/svg+xml,${encodeURIComponent(PLUGIN_CREATOR_ICON)}`} />
            <div className="mcp-catalog-text">
              <div className="mcp-catalog-name"><span className="mcp-catalog-title">Plugin Creator</span><span className="mcp-catalog-badge">Built in</span></div>
              <div className="mcp-catalog-desc">Lets every agent build plugins when you ask: "create a plugin that…"</div>
            </div>
            <button className="mcp-catalog-action" aria-label="Add Plugin Creator" disabled={!!busy} onClick={() => void addCreator()}>
              <PlusIcon />
            </button>
          </div>
        </div>
      )}
      {list.length === 0 ? (
        <p className="mcp-catalog-empty">
          {installed.length ? `No plugins match “${query}”.` : 'No plugins yet. Install one from a marketplace, upload one, or create your own from the Add menu.'}
        </p>
      ) : (
        <div className="mcp-plugin-list">
          {list.map((p) => (
            <div className="mcp-plugin-row" key={p.id}>
              <PluginIcon title={p.title} icon={p.icon} homepage={p.homepage} listing={listingOf(p)} />
              <div className="mcp-catalog-text">
                <div className="mcp-catalog-name">
                  <span className="mcp-catalog-title">{p.title}</span>
                  <span className="mcp-catalog-badge">{originLabel(p)}</span>
                </div>
                <div className="mcp-catalog-desc" title={p.path}>
                  {p.serverIds.length} server{p.serverIds.length === 1 ? '' : 's'} · {p.skillFolders.length} skill{p.skillFolders.length === 1 ? '' : 's'}
                  {p.claudeOnly.length ? ` · ${p.claudeOnly.join(', ')} (Claude Code only)` : ''}
                </div>
              </div>
              <button className="settings-secondary mcp-catalog-text-button" disabled={busy === p.id} onClick={() => void reinstall(p)}>
                Reinstall
              </button>
              <button
                className="settings-secondary mcp-catalog-text-button"
                onClick={() => void uninstallPlugin(p).then(() => onNotice(`Removed ${p.title}.`))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The icon for a row of the user's server list: its catalog entry's, its plugin's, or a letter. */
export function ServerIcon({ server }: { server: McpServer }) {
  const plugins = useStore(installedPlugins);
  const entry = server.catalogId ? MCP_CATALOG.find((e) => e.id === server.catalogId) : undefined;
  if (entry?.icon) {
    return (
      <span className="mcp-catalog-icon is-image is-small" aria-hidden="true">
        <img src={`/mcp-icons/${entry.icon}`} alt="" draggable={false} />
      </span>
    );
  }
  const plugin = server.pluginId ? plugins.find((p) => p.id === server.pluginId) : undefined;
  return (
    <span className="mcp-server-icon">
      <PluginIcon title={plugin?.title ?? server.name ?? '?'} icon={plugin?.icon} homepage={plugin?.homepage} listing={plugin ? listingOf(plugin) : null} />
    </span>
  );
}

export type { MarketplaceSource };
