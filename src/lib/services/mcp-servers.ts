/**
 * User-managed MCP servers, and how each agent CLI wants them spelled.
 *
 * Spacron already wrote two servers into every agent's config: its own
 * (`spacron-mcp`) and Playwright, behind a single boolean. This generalises
 * that to a list the user owns — a hosted server's URL, or a local command —
 * while keeping the two invariants the hardcoded version depended on:
 *
 *   1. **Every key we write carries the `spacron-` prefix.** These files are
 *      also hand-edited, and we delete keys we no longer want. Owning a
 *      namespace is what makes a removal safe: a user's own `linear` entry is
 *      never touched by us dropping our `spacron-linear`.
 *   2. **The desired set is written whole, and stale `spacron-` keys are
 *      pruned.** A server the user renamed, disabled or deleted has to
 *      disappear from six config files, and no bookkeeping of "what did we
 *      write last time" survives a reinstall. Reconciling against the prefix
 *      needs no memory and repairs itself.
 *
 * The per-dialect shapes below are not interchangeable — each CLI names the
 * transport differently, and two of them do not use `mcpServers` at all. The
 * shapes for Spacron's own entry were verified against the shipping binaries
 * (see the table in `stores/mcpBridge.ts`); these reuse exactly those spellings
 * rather than inventing new ones.
 */

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServer {
  /** Stable identity across renames, so the UI can edit a row in place. */
  id: string;
  /** User-facing name; also the config key once prefixed and sanitised. */
  name: string;
  transport: McpTransport;
  /** Remote transports only. */
  url?: string;
  /** Remote transports only — auth lives here (`Authorization`, `X-Api-Key`). */
  headers?: Record<string, string>;
  /** stdio only. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Off keeps the row but writes it nowhere. */
  enabled: boolean;
  /** Set when the row was installed from the catalog (`services/mcp-catalog.ts`). */
  catalogId?: string;
  /** Set when the row came from a plugin (`services/plugins.ts`). */
  pluginId?: string;
  /**
   * Signed in through Spacron (`commands/mcp_oauth.rs`). Agents and the chat
   * then reach it through Spacron's proxy, which adds the token — see
   * `withSignInProxy`.
   */
  oauth?: boolean;
}

/** The namespace every key Spacron writes lives in. See invariant 1 above. */
export const SPACRON_KEY_PREFIX = 'spacron-';

/** Our own server's key — never a user server, never pruned. */
export const SPACRON_OWN_KEY = 'spacron-mcp';

/** The browser server's key, still owned by its own setting. */
export const SPACRON_BROWSER_KEY = 'spacron-playwright';

/**
 * Keys Spacron writes that no user server may claim or prune.
 *
 * Without this a user server named "mcp" would render as `spacron-mcp` and
 * overwrite the app's own entry — taking every agent's cross-agent tools with
 * it, and looking like the agents had simply stopped seeing each other.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([SPACRON_OWN_KEY, SPACRON_BROWSER_KEY]);

/**
 * Config-file key for a server.
 *
 * Lowercased and reduced to a safe character set because this string becomes a
 * TOML table header (`[mcp_servers.<key>]`) as well as a JSON key, and a space
 * or a dot there produces a file the CLI cannot parse — which breaks not just
 * our entry but every other server in the user's config.
 */
export function serverKey(server: Pick<McpServer, 'name'>): string {
  const slug = server.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${SPACRON_KEY_PREFIX}${slug || 'server'}`;
}

/** True for a key this module owns and may therefore remove. */
export function isSpacronKey(key: string): boolean {
  return key.startsWith(SPACRON_KEY_PREFIX);
}

/** Human-readable problem with a server, or null when it is usable. */
export function validateServer(server: McpServer, others: McpServer[] = []): string | null {
  if (!server.name.trim()) return 'Give the server a name.';
  const key = serverKey(server);
  if (RESERVED_KEYS.has(key)) return `"${server.name}" is a name Spacron uses for its own server. Pick another.`;
  if (others.some((other) => other.id !== server.id && serverKey(other) === key)) {
    return `Another server already uses the name "${server.name}".`;
  }
  if (server.transport === 'stdio') {
    if (!server.command?.trim()) return 'Give the command that starts the server.';
    return null;
  }
  const url = server.url?.trim() ?? '';
  if (!url) return 'Give the server URL.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'That is not a valid URL.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The URL must start with http:// or https://.';
  }
  return null;
}

/**
 * Spacron's proxy URL for a signed-in server: the app's own streamable-HTTP
 * URL (`…/mcp?token=…`) with the path swapped for `/proxy/<key>`. The proxy
 * holds the OAuth token and refreshes it, so the agent never has to.
 */
export function signInProxyUrl(spacronHttpUrl: string, key: string): string {
  return spacronHttpUrl.replace(/\/mcp(\?|$)/, `/proxy/${key}$1`);
}

/**
 * The list as agents and the chat should see it: a server signed in through
 * Spacron points at the proxy instead of its own URL, with no headers. Others
 * are unchanged. Without Spacron's URL (server not up) they are left as is,
 * which still lets an agent run its own sign-in.
 */
export function withSignInProxy(servers: McpServer[], spacronHttpUrl: string | null | undefined): McpServer[] {
  if (!spacronHttpUrl) return servers;
  return servers.map((server) =>
    server.oauth && server.transport !== 'stdio'
      ? { ...server, transport: 'http', url: signInProxyUrl(spacronHttpUrl, serverKey(server)), headers: undefined }
      : server,
  );
}

/**
 * A server URL reduced to what identifies the server: host without `www.`,
 * path without a trailing slash, no query (vendors tag their plugin URLs with
 * `?client=…`). Two rows with the same identity are the same server, whichever
 * route added them.
 */
export function serverIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The row already in `servers` that is the same server as `candidate`, if any. */
export function sameServer(candidate: Pick<McpServer, 'name' | 'url' | 'transport'>, servers: McpServer[]): McpServer | undefined {
  const id = candidate.transport === 'stdio' ? null : serverIdentity(candidate.url);
  return servers.find((s) => (id && s.transport !== 'stdio' && serverIdentity(s.url) === id) || serverKey(s) === serverKey(candidate));
}

/**
 * The user's servers as a DeepSeek Harness patch: one `dsh-mcp-client` row
 * each. That client speaks stdio and streamable HTTP (with headers), per its
 * README in the installed package; SSE servers are left out because it has no
 * SSE transport. A server signed in through Spacron goes through the proxy,
 * whose URL is built from `SPACRON_MCP_URL` in the launch environment so the
 * token never lands in the patch file. Returns '' when there is nothing to add.
 */
export function deepSeekMcpPatch(servers: McpServer[]): string {
  const q = (value: string) => JSON.stringify(value);
  const rows: string[] = [];
  for (const { key, server } of enabledServers(servers)) {
    const name = key.replace(/^spacron-/, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
    if (!name || name === 'spacron') continue;
    const lines = [`    - id: ${q(`spacron-user-${name}`)}`, `      name: '@deepseek-ai/dsh-mcp-client'`, `      config:`, `        serverName: ${q(name)}`];
    if (server.transport === 'stdio') {
      if (!server.command?.trim()) continue;
      lines.push(`        transport: stdio`, `        command: ${q(server.command.trim())}`);
      lines.push(`        args: [${(server.args ?? []).map(q).join(', ')}]`);
      const env = Object.entries(server.env ?? {}).filter(([k]) => k.trim());
      if (env.length) lines.push(`        env:`, ...env.map(([k, v]) => `          ${q(k)}: ${q(v)}`));
    } else if (server.transport === 'sse') {
      continue;
    } else if (server.oauth) {
      // A plain string replace: Spacron's URL is always `…/mcp?token=…`, and a
      // regex here would need escaping through TS, JSON and YAML at once.
      const expr = `process.env.SPACRON_MCP_URL.replace('/mcp?', '/proxy/${key}?')`;
      lines.push(`        transport: streamable-http`, `        url: !!js ${q(expr)}`);
    } else {
      if (!server.url?.trim()) continue;
      lines.push(`        transport: streamable-http`, `        url: ${q(server.url.trim())}`);
      const headers = Object.entries(server.headers ?? {}).filter(([k]) => k.trim());
      if (headers.length) lines.push(`        headers:`, ...headers.map(([k, v]) => `          ${q(k)}: ${q(v)}`));
    }
    rows.push(lines.join('\n'));
  }
  if (!rows.length) return '';
  return `# Written by Spacron: the servers from Settings > MCP & plugins.\n- insert:\n${rows.join('\n')}\n`;
}

/** The servers that should actually be written, keyed and deduplicated. */
export function enabledServers(servers: McpServer[]): Array<{ key: string; server: McpServer }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; server: McpServer }> = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    if (validateServer(server, servers)) continue;
    const key = serverKey(server);
    if (seen.has(key) || RESERVED_KEYS.has(key)) continue;
    seen.add(key);
    out.push({ key, server });
  }
  return out;
}

/** Drop empty keys/values so a half-filled header row never reaches a config. */
function cleanMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function argList(server: McpServer): string[] {
  return (server.args ?? []).map((a) => a.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Per-dialect entries
// ---------------------------------------------------------------------------

/**
 * The `mcpServers` shape Claude Code, Cursor and Gemini CLI share: `type` plus
 * `url` for remote, `command`/`args` for local.
 */
export function standardEntry(server: McpServer): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const entry: Record<string, unknown> = { command: server.command?.trim(), args: argList(server) };
    const env = cleanMap(server.env);
    if (env) entry.env = env;
    return entry;
  }
  const entry: Record<string, unknown> = { type: server.transport, url: server.url?.trim() };
  const headers = cleanMap(server.headers);
  if (headers) entry.headers = headers;
  return entry;
}

/**
 * droid's variant: the same shape, plus the explicit `disabled` flag its own
 * writer already sets on Spacron's entry.
 */
export function droidEntry(server: McpServer): Record<string, unknown> {
  return { ...standardEntry(server), disabled: false };
}

/**
 * opencode's variant. It calls a remote server `"remote"` rather than naming
 * the transport, takes a local server's argv as one flat array, and wants
 * `enabled` set explicitly.
 */
export function opencodeEntry(server: McpServer): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const entry: Record<string, unknown> = {
      type: 'local',
      command: [server.command?.trim() ?? '', ...argList(server)].filter(Boolean),
      enabled: true,
    };
    const env = cleanMap(server.env);
    if (env) entry.environment = env;
    return entry;
  }
  const entry: Record<string, unknown> = { type: 'remote', url: server.url?.trim(), enabled: true };
  const headers = cleanMap(server.headers);
  if (headers) entry.headers = headers;
  return entry;
}

/** `command`/`args`/`env` with no `type` — the local entry every dialect below shares. */
function stdioEntry(server: McpServer): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: server.command?.trim(), args: argList(server) };
  const env = cleanMap(server.env);
  if (env) entry.env = env;
  return entry;
}

/** A remote entry: `{ [urlKey]: url, headers? }` plus any fixed extras. */
function remoteEntry(server: McpServer, urlKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const entry: Record<string, unknown> = { [urlKey]: server.url?.trim(), ...extra };
  const headers = cleanMap(server.headers);
  if (headers) entry.headers = headers;
  return entry;
}

/**
 * Kiro CLI (`.kiro/settings/mcp.json`) and Amp (`.amp/settings.json`): a bare
 * `url` for remote, no transport field. Both from the vendors' MCP docs,
 * fetched 2026-10-12.
 */
export function untypedEntry(server: McpServer): Record<string, unknown> {
  return server.transport === 'stdio' ? stdioEntry(server) : remoteEntry(server, 'url');
}

/**
 * Qwen Code (`.qwen/settings.json`). A Gemini CLI fork that kept the older
 * keys: streamable HTTP is `httpUrl`, SSE is `url`. From its MCP docs,
 * fetched 2026-10-12.
 */
export function qwenEntry(server: McpServer): Record<string, unknown> {
  if (server.transport === 'stdio') return stdioEntry(server);
  return remoteEntry(server, server.transport === 'http' ? 'httpUrl' : 'url');
}

/**
 * Devin CLI (`.devin/config.local.json`): names the transport under
 * `transport`, not `type`. Shape is what `devin mcp add -s local` wrote,
 * verified 2026-10-12.
 */
export function devinEntry(server: McpServer): Record<string, unknown> {
  if (server.transport === 'stdio') return { ...stdioEntry(server), transport: 'stdio' };
  return remoteEntry(server, 'url', { transport: server.transport });
}

/**
 * Antigravity CLI (`~/.gemini/config/mcp_config.json`): the URL key is
 * `serverUrl`. Shape is what `agy mcp add` wrote, verified 2026-10-12.
 */
export function antigravityEntry(server: McpServer): Record<string, unknown> {
  if (server.transport === 'stdio') return stdioEntry(server);
  return remoteEntry(server, 'serverUrl', { disabled: false });
}

/** Escape a string for a double-quoted TOML value. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One `[mcp_servers.<key>]` table for Codex's `config.toml`.
 *
 * Codex speaks streamable HTTP only, so an SSE server is written with its URL
 * anyway and may simply fail to connect there — the alternative, silently
 * dropping it, is worse: the user sees the server in Spacron's list and no
 * reason for its absence. A stdio server gets `command`/`args`, matching what
 * `codex mcp add` writes.
 *
 * Headers are NOT written. Codex's table has no verified key for them, and
 * inventing one would either be ignored or break the file's parse — so a
 * server that authenticates with a header is written unauthenticated here and
 * the UI says so, rather than failing in a way that points nowhere.
 */
export function codexTable(key: string, server: McpServer): string {
  const lines = [`[mcp_servers.${key}]`];
  if (server.transport === 'stdio') {
    lines.push(`command = ${tomlString(server.command?.trim() ?? '')}`);
    const args = argList(server);
    if (args.length) lines.push(`args = [${args.map(tomlString).join(', ')}]`);
    const env = cleanMap(server.env);
    if (env) {
      const pairs = Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`);
      lines.push(`env = { ${pairs.join(', ')} }`);
    }
  } else {
    lines.push(`url = ${tomlString(server.url?.trim() ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** True when this server carries auth Codex's config cannot express. */
export function headersLostOnCodex(server: McpServer): boolean {
  return server.transport !== 'stdio' && !!cleanMap(server.headers);
}

// ---------------------------------------------------------------------------
// Form text ↔ structured values
// ---------------------------------------------------------------------------
//
// The editor takes headers, env and args as plain multi-line text rather than
// a grid of inputs. One entry per line, never split on whitespace: a header
// value and a command argument can both legitimately contain spaces, and
// silently cutting one in half produces a server that fails to authenticate
// or start with nothing on screen to explain it.

/** `Name: value` per line → a header/env map. Blank and `#` lines are ignored. */
export function parsePairs(text: string, separator: ':' | '='): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(separator);
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** The inverse, for loading a saved server back into the editor. */
export function formatPairs(map: Record<string, string> | undefined, separator: ':' | '='): string {
  if (!map) return '';
  return Object.entries(map)
    .map(([key, value]) => `${key}${separator} ${value}`)
    .join('\n');
}

/** One argument per line → an argv tail. */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Build the `{ key: entry | null }` map a config writer merges.
 *
 * `existingKeys` is every key already in that file. Ours that are no longer
 * wanted map to `null`, which the writers treat as "delete this key" — this is
 * the pruning half of invariant 2. Keys outside our prefix are never listed,
 * so a merge can only ever touch what Spacron owns.
 */
export function mergeMap(
  servers: McpServer[],
  existingKeys: Iterable<string>,
  build: (server: McpServer) => Record<string, unknown>,
): Record<string, unknown | null> {
  const wanted = enabledServers(servers);
  const out: Record<string, unknown | null> = {};
  const wantedKeys = new Set(wanted.map((w) => w.key));
  for (const key of existingKeys) {
    if (!isSpacronKey(key) || RESERVED_KEYS.has(key) || wantedKeys.has(key)) continue;
    out[key] = null;
  }
  for (const { key, server } of wanted) out[key] = build(server);
  return out;
}
