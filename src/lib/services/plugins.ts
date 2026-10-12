/**
 * Plugins: Claude Code / Codex plugin folders, as Spacron uses them.
 *
 * A plugin can carry MCP servers, skills, and Claude Code-only parts
 * (commands, sub-agents, hooks, language servers). Spacron gives:
 *
 * - its **MCP servers** to every agent CLI and the chat, as ordinary rows of
 *   the user's server list tagged `pluginId` — so they go through the same
 *   writers, sign-in proxy and pruning as any other server;
 * - its **skills** to Claude Code and Codex, copied into their user skill
 *   folders as `spacron-<plugin>-<skill>` (`commands/plugins.rs`);
 * - the Claude Code-only parts are listed, not run.
 *
 * Files are fetched, unpacked and read in Rust; this module decides what to do
 * with them and keeps the installed list.
 */
import { invoke } from '@tauri-apps/api/core';
import { get, writable } from '$lib/stores/storeCompat';
import { mcpServers } from '$lib/stores/settings';
import { serverKey, validateServer, type McpServer } from './mcp-servers';

export interface PluginSkill {
  name: string;
  description: string;
}

/** What `commands/plugins.rs` reads out of a plugin folder. */
export interface PluginSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string | null;
  homepage: string | null;
  author: string | null;
  path: string;
  mcpServers: Record<string, Record<string, unknown>>;
  /** `${NAME}` placeholders the user has to fill in. */
  variables: string[];
  skills: PluginSkill[];
  claudeOnly: string[];
  icon: string | null;
}

export interface MarketplacePlugin {
  name: string;
  title: string;
  description: string;
  category: string | null;
  homepage: string | null;
  author: string | null;
  installable: boolean;
}

export interface Marketplace {
  name: string;
  owner: string | null;
  plugins: MarketplacePlugin[];
}

export interface MarketplaceSource {
  id: string;
  /** `owner/repo` (optionally `#ref`) or a github.com link. */
  source: string;
  name: string;
  /** Shipped with Spacron; can be hidden but not deleted. */
  builtin?: boolean;
}

export type PluginOrigin =
  | { kind: 'marketplace'; marketplace: string; source: string }
  | { kind: 'archive' }
  | { kind: 'folder' }
  | { kind: 'created' }
  | { kind: 'builtin' };

export interface InstalledPlugin {
  id: string;
  name: string;
  title: string;
  description: string;
  path: string;
  origin: PluginOrigin;
  /** Ids of the server rows this plugin added. */
  serverIds: string[];
  /** Skill folders written into Claude Code's and Codex's skill dirs. */
  skillFolders: string[];
  claudeOnly: string[];
  icon: string | null;
  homepage: string | null;
  installedAt: number;
}

export const DEFAULT_MARKETPLACES: MarketplaceSource[] = [
  { id: 'claude-official', source: 'anthropics/claude-plugins-official', name: 'Claude plugins', builtin: true },
  { id: 'openai-curated', source: 'openai/plugins', name: 'Codex plugins', builtin: true },
];

// ---------------------------------------------------------------------------
// Persistent state (own keys: the settings store belongs to Settings)
// ---------------------------------------------------------------------------

function stored<T>(key: string, fallback: T) {
  let initial = fallback;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw) initial = JSON.parse(raw) as T;
  } catch {
    // Unreadable storage: start from the default.
  }
  const store = writable<T>(initial);
  store.subscribe((value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable (private window, tests): the session still works.
    }
  });
  return store;
}

export const installedPlugins = stored<InstalledPlugin[]>('spacron.installedPlugins', []);
export const pluginMarketplaces = stored<MarketplaceSource[]>('spacron.pluginMarketplaces', DEFAULT_MARKETPLACES);

// ---------------------------------------------------------------------------
// Turning a plugin's MCP servers into server rows
// ---------------------------------------------------------------------------

/** Replace `${NAME}` with the user's values, everywhere in a JSON value. */
export function fillVariables<T>(value: T, values: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{(?:env:|user_config\.)?([A-Za-z0-9_]+)\}/g, (match, name: string) =>
      name in values ? values[name] : match,
    ) as T;
  }
  if (Array.isArray(value)) return value.map((v) => fillVariables(v, values)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillVariables(v, values)])) as T;
  }
  return value;
}

const asStringMap = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  // An empty value (a `${VAR:-}` default) means "not set": sending an empty
  // Authorization header would fail where omitting it works.
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && val.trim()) out[k] = val;
  return Object.keys(out).length ? out : undefined;
};

/**
 * One entry of a plugin's `mcpServers` as a server row, or null when it is not
 * a shape Spacron can run. Plugins spell the transport several ways
 * (`http`, `streamable-http`, `url`, `sse`, `stdio`, or nothing).
 */
export function pluginServerRow(pluginId: string, key: string, spec: Record<string, unknown>, name: string): McpServer | null {
  const type = String(spec.type ?? spec.transport ?? '').toLowerCase();
  const url = [spec.url, spec.serverUrl, spec.httpUrl].find((u): u is string => typeof u === 'string' && !!u.trim());
  const base = { id: `mcp-plugin-${pluginId}-${key}-${Date.now().toString(36)}`, name, enabled: true, pluginId };
  if (typeof spec.command === 'string' && spec.command.trim()) {
    return {
      ...base,
      transport: 'stdio',
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      env: asStringMap(spec.env),
    };
  }
  if (!url) return null;
  return { ...base, transport: type === 'sse' ? 'sse' : 'http', url, headers: asStringMap(spec.headers) };
}

/** A name for a plugin's server that does not collide with the user's list. */
function serverName(plugin: PluginSummary, key: string, taken: McpServer[]): string {
  const candidates = [key, `${plugin.name}-${key}`];
  for (const name of candidates) {
    if (!taken.some((s) => serverKey(s) === serverKey({ name }))) return name;
  }
  let n = 2;
  while (taken.some((s) => serverKey(s) === serverKey({ name: `${plugin.name}-${key}-${n}` }))) n += 1;
  return `${plugin.name}-${key}-${n}`;
}

export interface InstallProgress {
  (message: string): void;
}

export interface InstallResult {
  plugin: InstalledPlugin;
  /** Servers added without a sign-in because it failed (the agents can still sign in). */
  warnings: string[];
}

/**
 * Install a plugin Rust has already put on disk: add its servers (signing in
 * to the ones that need it, in the user's browser), copy its skills to the
 * agents, and record it. Throws `cancelled:` when the user cancels a sign-in;
 * nothing is left half-installed in that case.
 */
export async function installPlugin(
  summary: PluginSummary,
  origin: PluginOrigin,
  values: Record<string, string>,
  progress: InstallProgress = () => {},
): Promise<InstallResult> {
  const existing = get(installedPlugins).find((p) => p.id === summary.id);
  if (existing) await uninstallPlugin(existing, { keepFiles: true });

  const warnings: string[] = [];
  const rows: McpServer[] = [];
  const current = get(mcpServers);
  for (const [key, spec] of Object.entries(summary.mcpServers ?? {})) {
    const filled = fillVariables(spec, values);
    const row = pluginServerRow(summary.id, key, filled, serverName(summary, key, [...current, ...rows]));
    if (!row) {
      warnings.push(`${key}: not a server shape Spacron can run, skipped.`);
      continue;
    }
    if (validateServer(row, [...current, ...rows])) {
      warnings.push(`${key}: ${validateServer(row, [...current, ...rows])}`);
      continue;
    }
    if (row.transport !== 'stdio' && !row.headers && row.url?.startsWith('https://')) {
      const needsSignIn = await invoke<boolean>('mcp_oauth_needs_sign_in', { url: row.url }).catch(() => false);
      if (needsSignIn) {
        progress(`Sign in to ${row.name} in your browser…`);
        try {
          await invoke('mcp_oauth_sign_in', { key: serverKey(row), url: row.url, name: row.name });
          row.oauth = true;
        } catch (e) {
          const message = String(e);
          if (/^cancelled:|^timeout:/.test(message)) throw new Error(message);
          warnings.push(`${row.name}: sign-in failed (${message}). Added anyway; agents can sign in themselves.`);
        }
      }
    }
    rows.push(row);
  }

  progress('Installing skills…');
  const skillFolders = summary.skills.length
    ? await invoke<string[]>('plugin_enable_skills', { pluginId: summary.id, path: summary.path })
    : [];

  mcpServers.set([...get(mcpServers), ...rows]);
  const plugin: InstalledPlugin = {
    id: summary.id,
    name: summary.name,
    title: summary.title,
    description: summary.description,
    path: summary.path,
    origin,
    serverIds: rows.map((r) => r.id),
    skillFolders,
    claudeOnly: summary.claudeOnly,
    icon: summary.icon,
    homepage: summary.homepage,
    installedAt: Date.now(),
  };
  installedPlugins.set([...get(installedPlugins).filter((p) => p.id !== plugin.id), plugin]);
  return { plugin, warnings };
}

/** Remove a plugin's servers and skills, and its downloaded files. */
export async function uninstallPlugin(plugin: InstalledPlugin, options: { keepFiles?: boolean } = {}): Promise<void> {
  mcpServers.set(get(mcpServers).filter((s) => s.pluginId !== plugin.id && !plugin.serverIds.includes(s.id)));
  await invoke('plugin_disable_skills', { pluginId: plugin.id }).catch(() => {});
  // Files Spacron downloaded or unpacked; Rust refuses anything outside its own store.
  if (!options.keepFiles && plugin.origin.kind !== 'created' && plugin.origin.kind !== 'folder') {
    await invoke('plugin_delete_files', { path: plugin.path }).catch(() => {});
  }
  installedPlugins.set(get(installedPlugins).filter((p) => p.id !== plugin.id));
}

// ---------------------------------------------------------------------------
// Rust calls
// ---------------------------------------------------------------------------

export const fetchMarketplace = (source: string) => invoke<Marketplace>('plugin_marketplace_fetch', { source });
export const downloadMarketplacePlugin = (source: string, plugin: string) =>
  invoke<PluginSummary>('plugin_install_from_marketplace', { source, plugin });
export const unpackArchive = (path: string) => invoke<PluginSummary>('plugin_install_archive', { path });
export const readPluginFolder = (path: string) => invoke<PluginSummary>('plugin_read_folder', { path });
export const createPluginFolder = (parent: string | null, name: string, description: string) =>
  invoke<PluginSummary>('plugin_create', { parent, name, description });

const siteIcons = new Map<string, Promise<string | null>>();
/** A plugin's homepage icon as a data URL, fetched once per session. */
export function siteIcon(homepage: string | null | undefined): Promise<string | null> {
  if (!homepage) return Promise.resolve(null);
  let hit = siteIcons.get(homepage);
  if (!hit) {
    hit = invoke<string | null>('plugin_site_icon', { homepage }).catch(() => null);
    siteIcons.set(homepage, hit);
  }
  return hit;
}

/** `owner/repo` or a github.com link → a stable id for the marketplace list. */
export function marketplaceId(source: string): string {
  return source
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
