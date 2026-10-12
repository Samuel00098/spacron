/**
 * The MCP catalog: ready-made servers the user installs from Settings > MCP
 * with one click instead of typing a URL and headers.
 *
 * Installing an entry just adds an ordinary `McpServer` row (tagged with
 * `catalogId`), so everything downstream — writing it into every agent CLI's
 * config, pruning it on removal, the chat's MCP client — is the existing path.
 *
 * ## The honesty rule for this file
 *
 * Every URL and command below is copied from the vendor's own published plugin
 * config (`.mcp.json` / `plugin.json`) in OpenAI's curated Codex marketplace or
 * Anthropic's `claude-plugins-official` marketplace, read on 2026-10-12. None is
 * guessed from the vendor's name. Entries whose published config only works for
 * one client (a Claude-only endpoint, a client id registered to Claude) are
 * left out on purpose. Add an entry only from such a source.
 *
 * ## Auth
 *
 * - `oauth`: the server asks the user to sign in in a browser on first use.
 *   Claude Code, Codex (`codex mcp login`) and Gemini CLI handle that
 *   themselves. Spacron's own chat client cannot yet — it only sends headers.
 * - `key`: the user pastes a token, which becomes a request header.
 * - `none`: works as is.
 *
 * Icons are Simple Icons (CC0) 13.21.0 in `static/mcp-icons/`; an entry
 * without `icon` gets a lettered tile.
 */
import type { McpServer } from './mcp-servers';

export type McpCatalogCategory = 'popular' | 'developer' | 'design' | 'productivity' | 'data';

export interface McpCatalogKey {
  /** The header the token goes in. */
  header: string;
  /** Text before the token in the header value, e.g. `Bearer `. */
  prefix: string;
  /** What to call it in the UI. */
  label: string;
  /** Where the user gets one. */
  url: string;
  /** True when the server also works without it. */
  optional?: boolean;
}

export interface McpCatalogEntry {
  id: string;
  /** Display name; also the config key once prefixed (`spacron-<name>`). */
  name: string;
  description: string;
  category: McpCatalogCategory;
  /** File stem in `static/mcp-icons/`. */
  icon?: string;
  /** Tile colour: the brand colour, or a lighter brand accent where the logo colour is near-black. */
  color: string;
  auth: 'oauth' | 'key' | 'none';
  key?: McpCatalogKey;
  transport: McpServer['transport'];
  url?: string;
  /** Fixed headers the vendor's own config sends. */
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Shown under the row, e.g. a prerequisite. */
  note?: string;
}

export const MCP_CATEGORIES: { id: McpCatalogCategory; label: string }[] = [
  { id: 'popular', label: 'Popular' },
  { id: 'developer', label: 'Developer tools' },
  { id: 'design', label: 'Design' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'data', label: 'Data & monitoring' },
];

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ── Popular ──────────────────────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, pull requests, issues and CI',
    category: 'popular',
    icon: 'github',
    color: '#181717',
    auth: 'key',
    key: {
      header: 'Authorization',
      prefix: 'Bearer ',
      label: 'GitHub personal access token',
      url: 'https://github.com/settings/personal-access-tokens',
    },
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Docs, tasks and databases',
    category: 'popular',
    icon: 'notion',
    color: '#000000',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles',
    category: 'popular',
    icon: 'linear',
    color: '#5E6AD2',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read designs, ship them to code',
    category: 'popular',
    icon: 'figma',
    color: '#F24E1E',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Manage and query databases',
    category: 'popular',
    icon: 'supabase',
    color: '#3FCF8E',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payments, customers and billing',
    category: 'popular',
    icon: 'stripe',
    color: '#635BFF',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.stripe.com',
  },

  // ── Developer tools ──────────────────────────────────────────────────────
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Projects, deployments and logs',
    category: 'developer',
    icon: 'vercel',
    color: '#000000',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.vercel.com',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Errors, issues and traces',
    category: 'developer',
    icon: 'sentry',
    color: '#362D59',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'The Cloudflare API: Workers, DNS, R2',
    category: 'developer',
    icon: 'cloudflare',
    color: '#F38020',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    description: 'Sites, deploys and forms',
    category: 'developer',
    icon: 'netlify',
    color: '#00C7B7',
    auth: 'oauth',
    transport: 'http',
    url: 'https://netlify-mcp.netlify.app/mcp',
  },
  {
    id: 'railway',
    name: 'Railway',
    description: 'Services, deploys and variables',
    category: 'developer',
    icon: 'railway',
    color: '#0B0D0E',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.railway.com',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Projects, merge requests and pipelines',
    category: 'developer',
    icon: 'gitlab',
    color: '#FC6D26',
    auth: 'oauth',
    transport: 'http',
    url: 'https://gitlab.com/api/v4/mcp',
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Serverless Postgres and branches',
    category: 'developer',
    color: '#00E599',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.neon.tech/mcp',
  },
  {
    id: 'firebase',
    name: 'Firebase',
    description: 'Projects, Firestore, Auth and hosting',
    category: 'developer',
    icon: 'firebase',
    color: '#DD2C00',
    auth: 'none',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'firebase-tools@latest', 'mcp'],
    note: 'Runs locally through npx; uses your Firebase CLI login',
  },
  {
    id: 'exa',
    name: 'Exa',
    description: 'Web and code search for agents',
    category: 'developer',
    color: '#1F40ED',
    auth: 'none',
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
  },

  // ── Design ───────────────────────────────────────────────────────────────
  {
    id: 'canva',
    name: 'Canva',
    description: 'Create, review and edit designs',
    category: 'design',
    icon: 'canva',
    color: '#00C4CC',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.canva.com/mcp',
  },
  {
    id: 'miro',
    name: 'Miro',
    description: 'Boards, diagrams and stickies',
    category: 'design',
    icon: 'miro',
    color: '#FFD02F',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.miro.com/',
  },

  // ── Productivity ─────────────────────────────────────────────────────────
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira issues and Confluence pages',
    category: 'productivity',
    icon: 'atlassian',
    color: '#0052CC',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.atlassian.com/v2/mcp',
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'Boards, items and updates',
    category: 'productivity',
    color: '#FF3D57',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.monday.com/mcp',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Bases, tables and records',
    category: 'productivity',
    icon: 'airtable',
    color: '#18BFFF',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.airtable.com/mcp',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Actions across thousands of apps',
    category: 'productivity',
    icon: 'zapier',
    color: '#FF4F00',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.zapier.com/api/v1/connect',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    description: 'Conversations and contacts',
    category: 'productivity',
    icon: 'intercom',
    color: '#1F8DED',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.intercom.com/mcp',
  },

  // ── Data & monitoring ────────────────────────────────────────────────────
  {
    id: 'posthog',
    name: 'PostHog',
    description: 'Product analytics, flags and errors',
    category: 'data',
    icon: 'posthog',
    color: '#F54E00',
    auth: 'oauth',
    transport: 'http',
    url: 'https://mcp.posthog.com/mcp',
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    description: 'Incidents, services and on-call',
    category: 'data',
    icon: 'pagerduty',
    color: '#06AC38',
    auth: 'key',
    key: {
      header: 'Authorization',
      prefix: 'Token token=',
      label: 'PagerDuty API key',
      url: 'https://support.pagerduty.com/main/docs/api-access-keys',
    },
    transport: 'http',
    url: 'https://mcp.pagerduty.com/mcp',
  },
];

/** The server row an install adds. `token` is required when the entry needs a key. */
export function catalogServer(entry: McpCatalogEntry, token = ''): McpServer {
  const headers: Record<string, string> = { ...(entry.headers ?? {}) };
  const trimmed = token.trim();
  if (entry.key && trimmed) headers[entry.key.header] = `${entry.key.prefix}${trimmed}`;
  return {
    id: `mcp-${entry.id}-${Date.now().toString(36)}`,
    name: entry.name,
    transport: entry.transport,
    url: entry.transport === 'stdio' ? undefined : entry.url,
    headers: entry.transport === 'stdio' || !Object.keys(headers).length ? undefined : headers,
    command: entry.transport === 'stdio' ? entry.command : undefined,
    args: entry.transport === 'stdio' ? entry.args : undefined,
    enabled: true,
    catalogId: entry.id,
  };
}

/** The installed row for this entry, if any. */
export function installedFrom(entry: McpCatalogEntry, servers: McpServer[]): McpServer | undefined {
  return servers.find((s) => s.catalogId === entry.id);
}

/** Case-insensitive match on name, description and category label. */
export function matchesCatalogQuery(entry: McpCatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const category = MCP_CATEGORIES.find((c) => c.id === entry.category)?.label ?? '';
  return `${entry.name} ${entry.description} ${category}`.toLowerCase().includes(q);
}
