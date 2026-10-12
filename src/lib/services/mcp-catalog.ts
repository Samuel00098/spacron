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
 * Anthropic's `claude-plugins-official` marketplace, read on 2026-10-12, and
 * each `oauth` entry was probed live that day: it answers 401 with RFC 9728
 * metadata and offers dynamic client registration, which Spacron's sign-in
 * needs. Servers that fail that (Slack, MongoDB Atlas, Render, SumUp: no
 * dynamic registration) or that ship a Claude-only endpoint (HubSpot, Dropbox)
 * are left out on purpose. Add an entry only from such a source, and probe it.
 *
 * ## Auth
 *
 * - `oauth`: the user signs in in their browser before it is installed
 *   (`commands/mcp_oauth.rs`).
 * - `key`: the user pastes a token, which becomes a request header.
 * - `none`: works as is.
 *
 * Icons are each vendor's own current icon, fetched from its website
 * (apple-touch-icon, else its favicon) on 2026-10-12 into `static/mcp-icons/`.
 */
import type { McpServer } from './mcp-servers';

export type McpCatalogCategory = 'popular' | 'developer' | 'data' | 'design' | 'productivity' | 'docs';

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
  /** File name in `static/mcp-icons/`; absent gets a lettered tile. */
  icon?: string;
  /** The vendor's site, where the icon came from. */
  homepage: string;
  /** Lettered-tile colour when there is no icon. */
  color?: string;
  auth: 'oauth' | 'key' | 'none';
  key?: McpCatalogKey;
  transport: McpServer['transport'];
  url?: string;
  /** Fixed headers the vendor's own config sends. */
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Shown instead of the description, e.g. a prerequisite. */
  note?: string;
}

export const MCP_CATEGORIES: { id: McpCatalogCategory; label: string }[] = [
  { id: 'popular', label: 'Popular' },
  { id: 'developer', label: 'Developer tools' },
  { id: 'data', label: 'Data & monitoring' },
  { id: 'design', label: 'Design & web' },
  { id: 'productivity', label: 'Productivity & business' },
  { id: 'docs', label: 'Search & docs' },
];

type Remote = Pick<McpCatalogEntry, 'id' | 'name' | 'description' | 'category' | 'icon' | 'homepage' | 'url'> &
  Partial<Pick<McpCatalogEntry, 'note' | 'headers'>>;

/** A hosted server the user signs in to. */
const signIn = (e: Remote): McpCatalogEntry => ({ ...e, auth: 'oauth', transport: 'http' });
/** A hosted server that needs no account. */
const open = (e: Remote): McpCatalogEntry => ({ ...e, auth: 'none', transport: 'http' });

export const MCP_CATALOG: McpCatalogEntry[] = [
  // ── Popular ──────────────────────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, pull requests, issues and CI',
    category: 'popular',
    icon: 'github.png',
    homepage: 'https://github.com',
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
  signIn({ id: 'notion', name: 'Notion', description: 'Docs, tasks and databases', category: 'popular', icon: 'notion.png', homepage: 'https://www.notion.com', url: 'https://mcp.notion.com/mcp' }),
  signIn({ id: 'linear', name: 'Linear', description: 'Issues, projects and cycles', category: 'popular', icon: 'linear.png', homepage: 'https://linear.app', url: 'https://mcp.linear.app/mcp' }),
  signIn({ id: 'figma', name: 'Figma', description: 'Read designs, ship them to code', category: 'popular', icon: 'figma.png', homepage: 'https://www.figma.com', url: 'https://mcp.figma.com/mcp' }),
  signIn({ id: 'supabase', name: 'Supabase', description: 'Manage and query databases', category: 'popular', icon: 'supabase.png', homepage: 'https://supabase.com', url: 'https://mcp.supabase.com/mcp' }),
  signIn({ id: 'stripe', name: 'Stripe', description: 'Payments, customers and billing', category: 'popular', icon: 'stripe.png', homepage: 'https://stripe.com', url: 'https://mcp.stripe.com' }),

  // ── Developer tools ──────────────────────────────────────────────────────
  signIn({ id: 'vercel', name: 'Vercel', description: 'Projects, deployments and logs', category: 'developer', icon: 'vercel.png', homepage: 'https://vercel.com', url: 'https://mcp.vercel.com' }),
  signIn({ id: 'sentry', name: 'Sentry', description: 'Errors, issues and traces', category: 'developer', icon: 'sentry.ico', homepage: 'https://sentry.io', url: 'https://mcp.sentry.dev/mcp' }),
  signIn({ id: 'cloudflare', name: 'Cloudflare', description: 'The Cloudflare API: Workers, DNS, R2', category: 'developer', icon: 'cloudflare.png', homepage: 'https://www.cloudflare.com', url: 'https://mcp.cloudflare.com/mcp' }),
  signIn({ id: 'netlify', name: 'Netlify', description: 'Sites, deploys and forms', category: 'developer', icon: 'netlify.png', homepage: 'https://www.netlify.com', url: 'https://netlify-mcp.netlify.app/mcp' }),
  signIn({ id: 'railway', name: 'Railway', description: 'Services, deploys and variables', category: 'developer', icon: 'railway.png', homepage: 'https://railway.com', url: 'https://mcp.railway.com' }),
  signIn({ id: 'gitlab', name: 'GitLab', description: 'Projects, merge requests and pipelines', category: 'developer', icon: 'gitlab.png', homepage: 'https://about.gitlab.com', url: 'https://gitlab.com/api/v4/mcp' }),
  signIn({ id: 'expo', name: 'Expo', description: 'Build, ship and update React Native apps', category: 'developer', icon: 'expo.png', homepage: 'https://expo.dev', url: 'https://mcp.expo.dev/mcp' }),
  signIn({ id: 'huggingface', name: 'Hugging Face', description: 'Models, datasets, Spaces and papers', category: 'developer', icon: 'huggingface.ico', homepage: 'https://huggingface.co', url: 'https://huggingface.co/mcp?login' }),
  signIn({ id: 'postman', name: 'Postman', description: 'Collections, environments and API tests', category: 'developer', icon: 'postman.png', homepage: 'https://www.postman.com', url: 'https://mcp.postman.com/mcp' }),
  signIn({ id: 'lovable', name: 'Lovable', description: 'Build and edit Lovable apps', category: 'developer', icon: 'lovable.png', homepage: 'https://lovable.dev', url: 'https://mcp.lovable.dev/' }),
  signIn({ id: 'valtown', name: 'Val Town', description: 'Write and run vals in the cloud', category: 'developer', icon: 'valtown.svg', homepage: 'https://www.val.town', url: 'https://api.val.town/v3/mcp' }),
  signIn({ id: 'resend', name: 'Resend', description: 'Send email and manage domains', category: 'developer', icon: 'resend.png', homepage: 'https://resend.com', url: 'https://mcp.resend.com/mcp' }),
  signIn({ id: 'revenuecat', name: 'RevenueCat', description: 'In-app subscriptions and paywalls', category: 'developer', icon: 'revenuecat.png', homepage: 'https://www.revenuecat.com', url: 'https://mcp.revenuecat.ai/mcp' }),
  signIn({ id: 'codspeed', name: 'CodSpeed', description: 'Performance benchmarks in CI', category: 'developer', icon: 'codspeed.png', homepage: 'https://codspeed.io', url: 'https://mcp.codspeed.io/mcp' }),
  signIn({ id: 'hostinger', name: 'Hostinger', description: 'Hosting, domains and VPS', category: 'developer', icon: 'hostinger.ico', homepage: 'https://www.hostinger.com', url: 'https://mcp.hostinger.com' }),
  {
    id: 'firebase',
    name: 'Firebase',
    description: 'Projects, Firestore, Auth and hosting',
    category: 'developer',
    icon: 'firebase.png',
    homepage: 'https://firebase.google.com',
    auth: 'none',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'firebase-tools@latest', 'mcp'],
    note: 'Runs locally through npx; uses your Firebase CLI login',
  },
  {
    id: 'chromedevtools',
    name: 'Chrome DevTools',
    description: 'Drive Chrome: console, network, performance',
    category: 'developer',
    icon: 'chromedevtools.png',
    homepage: 'https://developer.chrome.com',
    auth: 'none',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    note: 'Runs locally through npx; needs Chrome installed',
  },

  // ── Data & monitoring ────────────────────────────────────────────────────
  signIn({ id: 'neon', name: 'Neon', description: 'Serverless Postgres and branches', category: 'data', icon: 'neon.png', homepage: 'https://neon.com', url: 'https://mcp.neon.tech/mcp' }),
  signIn({ id: 'prisma', name: 'Prisma', description: 'Prisma Postgres databases and schema', category: 'data', icon: 'prisma.png', homepage: 'https://www.prisma.io', url: 'https://mcp.prisma.io/mcp' }),
  signIn({ id: 'clickhouse', name: 'ClickHouse', description: 'Query ClickHouse Cloud services', category: 'data', icon: 'clickhouse.png', homepage: 'https://clickhouse.com', url: 'https://mcp.clickhouse.cloud/mcp' }),
  signIn({ id: 'aiven', name: 'Aiven', description: 'Managed Postgres, Kafka and more', category: 'data', icon: 'aiven.png', homepage: 'https://aiven.io', url: 'https://mcp.aiven.live/mcp' }),
  signIn({ id: 'posthog', name: 'PostHog', description: 'Product analytics, flags and errors', category: 'data', icon: 'posthog.png', homepage: 'https://posthog.com', url: 'https://mcp.posthog.com/mcp' }),
  signIn({ id: 'amplitude', name: 'Amplitude', description: 'Charts, cohorts and experiments', category: 'data', icon: 'amplitude.png', homepage: 'https://amplitude.com', url: 'https://mcp.amplitude.com/mcp' }),
  signIn({ id: 'grafana', name: 'Grafana Cloud', description: 'Dashboards, metrics, logs and alerts', category: 'data', icon: 'grafana.ico', homepage: 'https://grafana.com', url: 'https://mcp.grafana.com/mcp' }),
  signIn({ id: 'honeycomb', name: 'Honeycomb', description: 'Query traces and observability data', category: 'data', icon: 'honeycomb.ico', homepage: 'https://www.honeycomb.io', url: 'https://mcp.honeycomb.io/mcp' }),
  signIn({ id: 'newrelic', name: 'New Relic', description: 'APM, logs and alerts', category: 'data', icon: 'newrelic.png', homepage: 'https://newrelic.com', url: 'https://mcp.newrelic.com/mcp/' }),
  signIn({ id: 'logrocket', name: 'LogRocket', description: 'Session replay and frontend errors', category: 'data', icon: 'logrocket.png', homepage: 'https://logrocket.com', url: 'https://mcp.logrocket.com/mcp?toolsets=all' }),
  signIn({ id: 'fullstory', name: 'Fullstory', description: 'Sessions and digital experience data', category: 'data', icon: 'fullstory.png', homepage: 'https://www.fullstory.com', url: 'https://api.fullstory.com/mcp/fullstory' }),
  signIn({ id: 'incidentio', name: 'incident.io', description: 'Incidents, on-call and status pages', category: 'data', icon: 'incidentio.png', homepage: 'https://incident.io', url: 'https://mcp.incident.io/mcp' }),
  signIn({ id: 'rootly', name: 'Rootly', description: 'Incident management and retros', category: 'data', icon: 'rootly.svg', homepage: 'https://rootly.com', url: 'https://mcp.rootly.com/mcp' }),
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    description: 'Incidents, services and on-call',
    category: 'data',
    icon: 'pagerduty.png',
    homepage: 'https://www.pagerduty.com',
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
  signIn({ id: 'vanta', name: 'Vanta', description: 'Compliance tests, controls and vendors', category: 'data', icon: 'vanta.png', homepage: 'https://www.vanta.com', url: 'https://mcp.vanta.com/mcp' }),

  // ── Design & web ─────────────────────────────────────────────────────────
  signIn({ id: 'canva', name: 'Canva', description: 'Create, review and edit designs', category: 'design', icon: 'canva.png', homepage: 'https://www.canva.com', url: 'https://mcp.canva.com/mcp' }),
  signIn({ id: 'miro', name: 'Miro', description: 'Boards, diagrams and stickies', category: 'design', icon: 'miro.png', homepage: 'https://miro.com', url: 'https://mcp.miro.com/' }),
  signIn({ id: 'sanity', name: 'Sanity', description: 'Content, schemas and the Content Lake', category: 'design', icon: 'sanity.png', homepage: 'https://www.sanity.io', url: 'https://mcp.sanity.io' }),
  signIn({ id: 'wix', name: 'Wix', description: 'Build and manage Wix sites', category: 'design', icon: 'wix.png', homepage: 'https://www.wix.com', url: 'https://mcp.wix.com/mcp' }),
  signIn({ id: 'mapbox', name: 'Mapbox', description: 'Maps, geocoding and directions', category: 'design', icon: 'mapbox.png', homepage: 'https://www.mapbox.com', url: 'https://mcp.mapbox.com/mcp' }),

  // ── Productivity & business ──────────────────────────────────────────────
  signIn({ id: 'atlassian', name: 'Atlassian', description: 'Jira issues and Confluence pages', category: 'productivity', icon: 'atlassian.png', homepage: 'https://www.atlassian.com', url: 'https://mcp.atlassian.com/v2/mcp' }),
  signIn({ id: 'monday', name: 'monday.com', description: 'Boards, items and updates', category: 'productivity', icon: 'monday.png', homepage: 'https://monday.com', url: 'https://mcp.monday.com/mcp' }),
  signIn({ id: 'airtable', name: 'Airtable', description: 'Bases, tables and records', category: 'productivity', icon: 'airtable.png', homepage: 'https://www.airtable.com', url: 'https://mcp.airtable.com/mcp' }),
  signIn({ id: 'zapier', name: 'Zapier', description: 'Actions across thousands of apps', category: 'productivity', icon: 'zapier.ico', homepage: 'https://zapier.com', url: 'https://mcp.zapier.com/api/v1/connect' }),
  signIn({ id: 'intercom', name: 'Intercom', description: 'Conversations and contacts', category: 'productivity', icon: 'intercom.png', homepage: 'https://www.intercom.com', url: 'https://mcp.intercom.com/mcp' }),
  signIn({ id: 'circleback', name: 'Circleback', description: 'Meeting notes and action items', category: 'productivity', icon: 'circleback.png', homepage: 'https://circleback.ai', url: 'https://circleback.ai/api/mcp' }),
  signIn({ id: 'apollo', name: 'Apollo.io', description: 'Prospects, contacts and sequences', category: 'productivity', icon: 'apollo.png', homepage: 'https://www.apollo.io', url: 'https://mcp.apollo.io/mcp' }),
  signIn({ id: 'hunter', name: 'Hunter', description: 'Find and verify email addresses', category: 'productivity', icon: 'hunter.png', homepage: 'https://hunter.io', url: 'https://mcp.hunter.io/mcp' }),
  signIn({ id: 'shippo', name: 'Shippo', description: 'Shipping labels, rates and tracking', category: 'productivity', icon: 'shippo.png', homepage: 'https://goshippo.com', url: 'https://mcp.shippo.com' }),

  // ── Search & docs ────────────────────────────────────────────────────────
  open({ id: 'context7', name: 'Context7', description: 'Up-to-date library docs for any package', category: 'docs', icon: 'context7.png', homepage: 'https://context7.com', url: 'https://mcp.context7.com/mcp' }),
  open({ id: 'exa', name: 'Exa', description: 'Web and code search for agents', category: 'docs', icon: 'exa.png', homepage: 'https://exa.ai', url: 'https://mcp.exa.ai/mcp' }),
  signIn({ id: 'you', name: 'You.com', description: 'Web search, research and finance data', category: 'docs', icon: 'you.ico', homepage: 'https://you.com', url: 'https://api.you.com/mcp' }),
  open({ id: 'mslearn', name: 'Microsoft Learn', description: 'Official Microsoft and Azure docs', category: 'docs', icon: 'mslearn.png', homepage: 'https://learn.microsoft.com', url: 'https://learn.microsoft.com/api/mcp' }),
  open({ id: 'awsknowledge', name: 'AWS Knowledge', description: 'AWS docs, best practices and regions', category: 'docs', icon: 'awsknowledge.png', homepage: 'https://aws.amazon.com', url: 'https://knowledge-mcp.global.api.aws' }),
  open({ id: 'apollographql', name: 'Apollo GraphQL', description: 'GraphQL and Apollo docs', category: 'docs', icon: 'apollographql.png', homepage: 'https://www.apollographql.com', url: 'https://mcp.apollographql.com' }),
  open({ id: 'twilio', name: 'Twilio Docs', description: 'Twilio API reference and guides', category: 'docs', icon: 'twilio.png', homepage: 'https://www.twilio.com', url: 'https://mcp.twilio.com/docs' }),
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
