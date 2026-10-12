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
import { serverIdentity, serverKey, type McpServer } from './mcp-servers';

export type McpCatalogCategory =
  | 'popular'
  | 'developer'
  | 'cloud'
  | 'databases'
  | 'monitoring'
  | 'design'
  | 'productivity'
  | 'sales'
  | 'payments'
  | 'security'
  | 'docs';

export interface McpCatalogKey {
  /** The header the token goes in (hosted servers)... */
  header?: string;
  /** ...or the environment variable (local servers). */
  env?: string;
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
  { id: 'cloud', label: 'Cloud & deploy' },
  { id: 'databases', label: 'Databases & data' },
  { id: 'monitoring', label: 'Monitoring & analytics' },
  { id: 'design', label: 'Design & content' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'sales', label: 'Sales & support' },
  { id: 'payments', label: 'Payments & commerce' },
  { id: 'security', label: 'Security & identity' },
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
  signIn({ id: 'vercel', name: 'Vercel', description: 'Projects, deployments and logs', category: 'cloud', icon: 'vercel.png', homepage: 'https://vercel.com', url: 'https://mcp.vercel.com' }),
  signIn({ id: 'sentry', name: 'Sentry', description: 'Errors, issues and traces', category: 'monitoring', icon: 'sentry.ico', homepage: 'https://sentry.io', url: 'https://mcp.sentry.dev/mcp' }),
  signIn({ id: 'cloudflare', name: 'Cloudflare', description: 'The Cloudflare API: Workers, DNS, R2', category: 'cloud', icon: 'cloudflare.png', homepage: 'https://www.cloudflare.com', url: 'https://mcp.cloudflare.com/mcp' }),
  signIn({ id: 'netlify', name: 'Netlify', description: 'Sites, deploys and forms', category: 'cloud', icon: 'netlify.png', homepage: 'https://www.netlify.com', url: 'https://netlify-mcp.netlify.app/mcp' }),
  signIn({ id: 'railway', name: 'Railway', description: 'Services, deploys and variables', category: 'cloud', icon: 'railway.png', homepage: 'https://railway.com', url: 'https://mcp.railway.com' }),
  signIn({ id: 'gitlab', name: 'GitLab', description: 'Projects, merge requests and pipelines', category: 'developer', icon: 'gitlab.png', homepage: 'https://about.gitlab.com', url: 'https://gitlab.com/api/v4/mcp' }),
  signIn({ id: 'expo', name: 'Expo', description: 'Build, ship and update React Native apps', category: 'developer', icon: 'expo.png', homepage: 'https://expo.dev', url: 'https://mcp.expo.dev/mcp' }),
  signIn({ id: 'huggingface', name: 'Hugging Face', description: 'Models, datasets, Spaces and papers', category: 'developer', icon: 'huggingface.ico', homepage: 'https://huggingface.co', url: 'https://huggingface.co/mcp?login' }),
  signIn({ id: 'postman', name: 'Postman', description: 'Collections, environments and API tests', category: 'developer', icon: 'postman.png', homepage: 'https://www.postman.com', url: 'https://mcp.postman.com/mcp' }),
  signIn({ id: 'lovable', name: 'Lovable', description: 'Build and edit Lovable apps', category: 'developer', icon: 'lovable.png', homepage: 'https://lovable.dev', url: 'https://mcp.lovable.dev/' }),
  signIn({ id: 'valtown', name: 'Val Town', description: 'Write and run vals in the cloud', category: 'developer', icon: 'valtown.svg', homepage: 'https://www.val.town', url: 'https://api.val.town/v3/mcp' }),
  signIn({ id: 'resend', name: 'Resend', description: 'Send email and manage domains', category: 'developer', icon: 'resend.png', homepage: 'https://resend.com', url: 'https://mcp.resend.com/mcp' }),
  signIn({ id: 'revenuecat', name: 'RevenueCat', description: 'In-app subscriptions and paywalls', category: 'payments', icon: 'revenuecat.png', homepage: 'https://www.revenuecat.com', url: 'https://mcp.revenuecat.ai/mcp' }),
  signIn({ id: 'codspeed', name: 'CodSpeed', description: 'Performance benchmarks in CI', category: 'developer', icon: 'codspeed.png', homepage: 'https://codspeed.io', url: 'https://mcp.codspeed.io/mcp' }),
  signIn({ id: 'hostinger', name: 'Hostinger', description: 'Hosting, domains and VPS', category: 'cloud', icon: 'hostinger.ico', homepage: 'https://www.hostinger.com', url: 'https://mcp.hostinger.com' }),
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
  signIn({ id: 'neon', name: 'Neon', description: 'Serverless Postgres and branches', category: 'databases', icon: 'neon.png', homepage: 'https://neon.com', url: 'https://mcp.neon.tech/mcp' }),
  signIn({ id: 'prisma', name: 'Prisma', description: 'Prisma Postgres databases and schema', category: 'databases', icon: 'prisma.png', homepage: 'https://www.prisma.io', url: 'https://mcp.prisma.io/mcp' }),
  signIn({ id: 'clickhouse', name: 'ClickHouse', description: 'Query ClickHouse Cloud services', category: 'databases', icon: 'clickhouse.png', homepage: 'https://clickhouse.com', url: 'https://mcp.clickhouse.cloud/mcp' }),
  signIn({ id: 'aiven', name: 'Aiven', description: 'Managed Postgres, Kafka and more', category: 'databases', icon: 'aiven.png', homepage: 'https://aiven.io', url: 'https://mcp.aiven.live/mcp' }),
  signIn({ id: 'posthog', name: 'PostHog', description: 'Product analytics, flags and errors', category: 'monitoring', icon: 'posthog.png', homepage: 'https://posthog.com', url: 'https://mcp.posthog.com/mcp' }),
  signIn({ id: 'amplitude', name: 'Amplitude', description: 'Charts, cohorts and experiments', category: 'monitoring', icon: 'amplitude.png', homepage: 'https://amplitude.com', url: 'https://mcp.amplitude.com/mcp' }),
  signIn({ id: 'grafana', name: 'Grafana Cloud', description: 'Dashboards, metrics, logs and alerts', category: 'monitoring', icon: 'grafana.ico', homepage: 'https://grafana.com', url: 'https://mcp.grafana.com/mcp' }),
  signIn({ id: 'honeycomb', name: 'Honeycomb', description: 'Query traces and observability data', category: 'monitoring', icon: 'honeycomb.ico', homepage: 'https://www.honeycomb.io', url: 'https://mcp.honeycomb.io/mcp' }),
  signIn({ id: 'newrelic', name: 'New Relic', description: 'APM, logs and alerts', category: 'monitoring', icon: 'newrelic.png', homepage: 'https://newrelic.com', url: 'https://mcp.newrelic.com/mcp/' }),
  signIn({ id: 'logrocket', name: 'LogRocket', description: 'Session replay and frontend errors', category: 'monitoring', icon: 'logrocket.png', homepage: 'https://logrocket.com', url: 'https://mcp.logrocket.com/mcp?toolsets=all' }),
  signIn({ id: 'fullstory', name: 'Fullstory', description: 'Sessions and digital experience data', category: 'monitoring', icon: 'fullstory.png', homepage: 'https://www.fullstory.com', url: 'https://api.fullstory.com/mcp/fullstory' }),
  signIn({ id: 'incidentio', name: 'incident.io', description: 'Incidents, on-call and status pages', category: 'monitoring', icon: 'incidentio.png', homepage: 'https://incident.io', url: 'https://mcp.incident.io/mcp' }),
  signIn({ id: 'rootly', name: 'Rootly', description: 'Incident management and retros', category: 'monitoring', icon: 'rootly.svg', homepage: 'https://rootly.com', url: 'https://mcp.rootly.com/mcp' }),
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    description: 'Incidents, services and on-call',
    category: 'monitoring',
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
  signIn({ id: 'vanta', name: 'Vanta', description: 'Compliance tests, controls and vendors', category: 'security', icon: 'vanta.png', homepage: 'https://www.vanta.com', url: 'https://mcp.vanta.com/mcp' }),

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
  signIn({ id: 'intercom', name: 'Intercom', description: 'Conversations and contacts', category: 'sales', icon: 'intercom.png', homepage: 'https://www.intercom.com', url: 'https://mcp.intercom.com/mcp' }),
  signIn({ id: 'circleback', name: 'Circleback', description: 'Meeting notes and action items', category: 'productivity', icon: 'circleback.png', homepage: 'https://circleback.ai', url: 'https://circleback.ai/api/mcp' }),
  signIn({ id: 'apollo', name: 'Apollo.io', description: 'Prospects, contacts and sequences', category: 'sales', icon: 'apollo.png', homepage: 'https://www.apollo.io', url: 'https://mcp.apollo.io/mcp' }),
  signIn({ id: 'hunter', name: 'Hunter', description: 'Find and verify email addresses', category: 'sales', icon: 'hunter.png', homepage: 'https://hunter.io', url: 'https://mcp.hunter.io/mcp' }),
  signIn({ id: 'shippo', name: 'Shippo', description: 'Shipping labels, rates and tracking', category: 'payments', icon: 'shippo.png', homepage: 'https://goshippo.com', url: 'https://mcp.shippo.com' }),

  // ── Search & docs ────────────────────────────────────────────────────────
  open({ id: 'context7', name: 'Context7', description: 'Up-to-date library docs for any package', category: 'docs', icon: 'context7.png', homepage: 'https://context7.com', url: 'https://mcp.context7.com/mcp' }),
  open({ id: 'exa', name: 'Exa', description: 'Web and code search for agents', category: 'docs', icon: 'exa.png', homepage: 'https://exa.ai', url: 'https://mcp.exa.ai/mcp' }),
  signIn({ id: 'you', name: 'You.com', description: 'Web search, research and finance data', category: 'docs', icon: 'you.ico', homepage: 'https://you.com', url: 'https://api.you.com/mcp' }),
  open({ id: 'mslearn', name: 'Microsoft Learn', description: 'Official Microsoft and Azure docs', category: 'docs', icon: 'mslearn.png', homepage: 'https://learn.microsoft.com', url: 'https://learn.microsoft.com/api/mcp' }),
  open({ id: 'awsknowledge', name: 'AWS Knowledge', description: 'AWS docs, best practices and regions', category: 'docs', icon: 'awsknowledge.png', homepage: 'https://aws.amazon.com', url: 'https://knowledge-mcp.global.api.aws' }),
  open({ id: 'apollographql', name: 'Apollo GraphQL', description: 'GraphQL and Apollo docs', category: 'docs', icon: 'apollographql.png', homepage: 'https://www.apollographql.com', url: 'https://mcp.apollographql.com' }),
  open({ id: 'twilio', name: 'Twilio Docs', description: 'Twilio API reference and guides', category: 'docs', icon: 'twilio.png', homepage: 'https://www.twilio.com', url: 'https://mcp.twilio.com/docs' }),

  // ── Round two (2026-10-12) ───────────────────────────────────────────────
  // Hosted servers here are in a vendor's published plugin config or sit on
  // the vendor's own MCP host; every one was probed live: a 401 carrying RFC
  // 9728 metadata and dynamic registration (`signIn`), or a plain 200 (`open`).
  // SSE-only servers (Asana /sse, Square, Plaid, Webflow) are left out: the
  // sign-in proxy speaks streamable HTTP only.
  signIn({ id: 'buildkite', name: 'Buildkite', description: 'Pipelines, builds and test runs', category: 'developer', icon: 'buildkite.png', homepage: 'https://buildkite.com', url: 'https://mcp.buildkite.com/mcp' }),
  signIn({ id: 'jam', name: 'Jam', description: 'Bug reports with replays and logs', category: 'developer', icon: 'jam.png', homepage: 'https://jam.dev', url: 'https://mcp.jam.dev/mcp' }),
  signIn({ id: 'launchdarkly', name: 'LaunchDarkly', description: 'Feature flags and rollouts', category: 'developer', icon: 'launchdarkly.png', homepage: 'https://launchdarkly.com', url: 'https://mcp.launchdarkly.com/mcp/fm' }),
  signIn({ id: 'pipedream', name: 'Pipedream', description: 'Actions across 2,000+ APIs', category: 'developer', icon: 'pipedream.svg', homepage: 'https://pipedream.com', url: 'https://mcp.pipedream.net/v2' }),
  signIn({ id: 'apify', name: 'Apify', description: 'Web scrapers and automation actors', category: 'developer', icon: 'apify.png', homepage: 'https://apify.com', url: 'https://mcp.apify.com/' }),
  {
    id: 'desktopcommander',
    name: 'Desktop Commander',
    description: 'Terminal, files and processes on this computer',
    category: 'developer',
    icon: 'desktopcommander.png',
    homepage: 'https://desktopcommander.app',
    auth: 'none',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@wonderwhy-er/desktop-commander@latest'],
    note: 'Runs locally through npx, with full access to this computer',
  },
  {
    id: 'browseruse',
    name: 'Browser Use',
    description: 'Let agents drive a real browser',
    category: 'developer',
    icon: 'browseruse.png',
    homepage: 'https://browser-use.com',
    auth: 'none',
    transport: 'stdio',
    command: 'uvx',
    args: ['--python', '3.12', 'browser-use@latest', '--cli-mcp'],
    note: 'Runs locally through uvx (needs uv installed)',
  },
  {
    id: 'serena',
    name: 'Serena',
    description: 'Semantic code search and editing',
    category: 'developer',
    icon: 'serena.png',
    homepage: 'https://github.com/oraios/serena',
    auth: 'none',
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server'],
    note: 'Runs locally through uvx (needs uv installed)',
  },
  signIn({ id: 'zohocatalyst', name: 'Zoho Catalyst', description: 'Serverless functions and data store', category: 'cloud', icon: 'zohocatalyst.ico', homepage: 'https://catalyst.zoho.com', url: 'https://catalyst.zohomcp.com/mcp/message' }),
  {
    id: 'azure',
    name: 'Azure',
    description: 'Azure resources, storage and Cosmos DB',
    category: 'cloud',
    icon: 'azure.ico',
    homepage: 'https://azure.microsoft.com',
    auth: 'none',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@azure/mcp@latest', 'server', 'start'],
    note: 'Runs locally through npx; uses your Azure CLI login',
  },
  {
    id: 'convex',
    name: 'Convex',
    description: 'Deployments, tables and functions',
    category: 'databases',
    icon: 'convex.ico',
    homepage: 'https://www.convex.dev',
    auth: 'none',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'convex@latest', 'mcp', 'start'],
    note: 'Runs locally through npx; uses your Convex login',
  },
  {
    id: 'pinecone',
    name: 'Pinecone',
    description: 'Vector indexes, search and docs',
    category: 'databases',
    icon: 'pinecone.ico',
    homepage: 'https://www.pinecone.io',
    auth: 'key',
    key: { env: 'PINECONE_API_KEY', prefix: '', label: 'Pinecone API key', url: 'https://app.pinecone.io/' },
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@pinecone-database/mcp'],
  },
  signIn({ id: 'atlan', name: 'Atlan', description: 'Data catalog, lineage and glossary', category: 'databases', icon: 'atlan.png', homepage: 'https://atlan.com', url: 'https://mcp.atlan.com/mcp' }),
  signIn({ id: 'datadog', name: 'Datadog', description: 'Metrics, logs, traces and monitors', category: 'monitoring', icon: 'datadog.ico', homepage: 'https://www.datadoghq.com', url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp' }),
  signIn({ id: 'logfire', name: 'Logfire', description: 'Traces and logs from Pydantic Logfire', category: 'monitoring', icon: 'logfire.png', homepage: 'https://pydantic.dev/logfire', url: 'https://logfire-us.pydantic.dev/mcp' }),
  signIn({ id: 'pendo', name: 'Pendo', description: 'Product usage, guides and feedback', category: 'monitoring', icon: 'pendo.png', homepage: 'https://www.pendo.io', url: 'https://app.pendo.io/mcp/v0/shttp' }),
  signIn({ id: 'windsor', name: 'Windsor.ai', description: 'Marketing data from 300+ sources', category: 'monitoring', icon: 'windsor.png', homepage: 'https://windsor.ai', url: 'https://mcp.windsor.ai' }),
  signIn({ id: 'cloudinary', name: 'Cloudinary', description: 'Images, video and asset management', category: 'design', icon: 'cloudinary.png', homepage: 'https://cloudinary.com', url: 'https://asset-management.mcp.cloudinary.com/mcp' }),
  signIn({ id: 'clickup', name: 'ClickUp', description: 'Tasks, docs and spaces', category: 'productivity', icon: 'clickup.png', homepage: 'https://clickup.com', url: 'https://mcp.clickup.com/mcp' }),
  signIn({ id: 'todoist', name: 'Todoist', description: 'Tasks and projects', category: 'productivity', icon: 'todoist.png', homepage: 'https://www.todoist.com', url: 'https://ai.todoist.net/mcp' }),
  signIn({ id: 'calcom', name: 'Cal.com', description: 'Bookings, availability and event types', category: 'productivity', icon: 'calcom.png', homepage: 'https://cal.com', url: 'https://mcp.cal.com/mcp' }),
  signIn({ id: 'granola', name: 'Granola', description: 'Meeting notes and transcripts', category: 'productivity', icon: 'granola.png', homepage: 'https://www.granola.ai', url: 'https://mcp.granola.ai/mcp' }),
  signIn({ id: 'fireflies', name: 'Fireflies', description: 'Meeting transcripts and summaries', category: 'productivity', icon: 'fireflies.png', homepage: 'https://fireflies.ai', url: 'https://api.fireflies.ai/mcp' }),
  signIn({ id: 'jotform', name: 'Jotform', description: 'Forms and submissions', category: 'productivity', icon: 'jotform.png', homepage: 'https://www.jotform.com', url: 'https://mcp.jotform.com/' }),
  signIn({ id: 'egnyte', name: 'Egnyte', description: 'Files and folders in Egnyte', category: 'productivity', icon: 'egnyte.png', homepage: 'https://www.egnyte.com', url: 'https://mcp-server.egnyte.com/mcp' }),
  signIn({ id: 'attio', name: 'Attio', description: 'CRM records, lists and notes', category: 'sales', icon: 'attio.ico', homepage: 'https://attio.com', url: 'https://mcp.attio.com/mcp' }),
  signIn({ id: 'close', name: 'Close', description: 'CRM leads, calls and pipelines', category: 'sales', icon: 'close.png', homepage: 'https://www.close.com', url: 'https://mcp.close.com/mcp' }),
  signIn({ id: 'leadfeeder', name: 'Leadfeeder', description: 'Companies visiting your website', category: 'sales', icon: 'leadfeeder.svg', homepage: 'https://www.leadfeeder.com', url: 'https://mcp.leadfeeder.com/mcp' }),
  signIn({ id: 'paypal', name: 'PayPal', description: 'Payments, invoices and orders', category: 'payments', icon: 'paypal.png', homepage: 'https://www.paypal.com', url: 'https://mcp.paypal.com/mcp' }),
  signIn({ id: 'mercadopago', name: 'Mercado Pago', description: 'Payments in Latin America', category: 'payments', icon: 'mercadopago.svg', homepage: 'https://www.mercadopago.com', url: 'https://mcp.mercadopago.com/mcp' }),
  signIn({ id: 'airwallex', name: 'Airwallex', description: 'Global payments and accounts', category: 'payments', icon: 'airwallex.ico', homepage: 'https://www.airwallex.com', url: 'https://mcp.airwallex.com/mcp' }),
  signIn({ id: 'semgrep', name: 'Semgrep', description: 'Code scanning and findings', category: 'security', icon: 'semgrep.svg', homepage: 'https://semgrep.dev', url: 'https://mcp.semgrep.ai/mcp' }),
  signIn({ id: 'stytch', name: 'Stytch', description: 'Auth projects, users and sessions', category: 'security', icon: 'stytch.png', homepage: 'https://stytch.com', url: 'https://mcp.stytch.dev/mcp' }),
  signIn({ id: 'workos', name: 'WorkOS', description: 'SSO, directory sync and users', category: 'security', icon: 'workos.png', homepage: 'https://workos.com', url: 'https://mcp.workos.com/mcp' }),
  signIn({ id: 'tavily', name: 'Tavily', description: 'Search, extract and crawl the web', category: 'docs', icon: 'tavily.png', homepage: 'https://www.tavily.com', url: 'https://mcp.tavily.com/mcp' }),
  signIn({ id: 'ref', name: 'Ref', description: 'Token-efficient docs search', category: 'docs', icon: 'ref.png', homepage: 'https://ref.tools', url: 'https://api.ref.tools/mcp' }),
  signIn({ id: 'nimble', name: 'Nimble', description: 'Real-time web data and search', category: 'docs', icon: 'nimble.png', homepage: 'https://www.nimbleway.com', url: 'https://mcp.nimbleway.com/mcp' }),
  open({ id: 'deepwiki', name: 'DeepWiki', description: 'Ask questions about any GitHub repo', category: 'docs', icon: 'deepwiki.png', homepage: 'https://deepwiki.com', url: 'https://mcp.deepwiki.com/mcp' }),
  open({ id: 'cloudflaredocs', name: 'Cloudflare Docs', description: 'Cloudflare developer documentation', category: 'docs', icon: 'cloudflare.png', homepage: 'https://developers.cloudflare.com', url: 'https://docs.mcp.cloudflare.com/mcp' }),
  open({ id: 'svelte', name: 'Svelte', description: 'Svelte and SvelteKit docs', category: 'docs', icon: 'svelte.png', homepage: 'https://svelte.dev', url: 'https://mcp.svelte.dev/mcp' }),
  open({ id: 'qtdocs', name: 'Qt Docs', description: 'Qt framework documentation', category: 'docs', icon: 'qtdocs.ico', homepage: 'https://www.qt.io', url: 'https://qt-docs-mcp.qt.io/mcp' }),
];

/** The server row an install adds. `token` is required when the entry needs a key. */
export function catalogServer(entry: McpCatalogEntry, token = ''): McpServer {
  const headers: Record<string, string> = { ...(entry.headers ?? {}) };
  const trimmed = token.trim();
  if (entry.key?.header && trimmed) headers[entry.key.header] = `${entry.key.prefix}${trimmed}`;
  const env = entry.key?.env && trimmed ? { [entry.key.env]: `${entry.key.prefix}${trimmed}` } : undefined;
  return {
    id: `mcp-${entry.id}-${Date.now().toString(36)}`,
    name: entry.name,
    transport: entry.transport,
    url: entry.transport === 'stdio' ? undefined : entry.url,
    headers: entry.transport === 'stdio' || !Object.keys(headers).length ? undefined : headers,
    command: entry.transport === 'stdio' ? entry.command : undefined,
    args: entry.transport === 'stdio' ? entry.args : undefined,
    env: entry.transport === 'stdio' ? env : undefined,
    enabled: true,
    catalogId: entry.id,
  };
}

/** The installed row for this entry, if any. */
/**
 * The row that makes this entry installed: one added from the catalog, or the
 * same server added any other way (a marketplace plugin, by hand), matched by
 * URL or by name. Either way the user must not be offered it a second time.
 */
export function installedFrom(entry: McpCatalogEntry, servers: McpServer[]): McpServer | undefined {
  const byCatalog = servers.find((s) => s.catalogId === entry.id);
  if (byCatalog) return byCatalog;
  const id = entry.transport === 'stdio' ? null : serverIdentity(entry.url);
  return servers.find(
    (s) => (id && s.transport !== 'stdio' && serverIdentity(s.url) === id) || serverKey(s) === serverKey({ name: entry.name }),
  );
}

/**
 * The catalog's icon for a server or plugin of the same service, so a
 * marketplace plugin, an installed plugin and a server row all show the very
 * same tile as the catalog (Linear is Linear everywhere). Matched by catalog
 * id, by name, or by server URL.
 */
export function catalogIconFor(name: string | null | undefined, url?: string | null): string | undefined {
  const key = name ? serverKey({ name }) : null;
  const id = url ? serverIdentity(url) : null;
  const entry = MCP_CATALOG.find(
    (e) =>
      (key && (serverKey({ name: e.id }) === key || serverKey({ name: e.name }) === key)) ||
      (id && e.transport !== 'stdio' && serverIdentity(e.url) === id),
  );
  return entry?.icon ? `/mcp-icons/${entry.icon}` : undefined;
}

/** Case-insensitive match on name, description and category label. */
export function matchesCatalogQuery(entry: McpCatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const category = MCP_CATEGORIES.find((c) => c.id === entry.category)?.label ?? '';
  return `${entry.name} ${entry.description} ${category}`.toLowerCase().includes(q);
}
