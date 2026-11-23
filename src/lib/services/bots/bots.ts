/**
 * Bots: agents that live outside every project and work for you on a
 * schedule or on demand, powered by the agent CLIs installed where they run.
 *
 * A bot runs on one of two hosts (`boxId`):
 * - `'local'` — **this PC**, inside the desktop app, for people without a box.
 *   It runs while Spacron is open (`commands/local_bots.rs`).
 * - a remote connection id — **a box** (spacron-server), so it keeps working
 *   while this laptop is closed (`remote/bots.rs` behind `box_bot*`).
 *
 * Both hosts run the same Rust runner. The desktop owns the bot definitions
 * and the schedule language (it knows the user's time zone); a host gets each
 * bot's upcoming run times as epoch ms, exactly like box automations.
 */
import { invoke } from '@tauri-apps/api/core';
import { get, writable } from '$lib/stores/storeCompat';
import { activeRemoteId, remoteTarget } from '$lib/stores/remoteWorkspace';
import { getAgentRoster } from '$lib/stores/runs';
import { mcpServers } from '$lib/stores/settings';
import { backendInvoke } from '$lib/services/backend';
import { enabledServers, standardEntry, withSignInProxy, SPACRON_OWN_KEY, type McpServer } from '$lib/services/mcp-servers';
import { nextOccurrence, type Schedule } from '$lib/services/automations/schedule';
import { isTauriRuntime } from '$lib/utils/tauri';

export type BotSchedule = 'manual' | Schedule;
/** What a bot may do unattended. Turned into each CLI's own flags on the host. */
export type BotAccess = 'research' | 'folder' | 'full';
/** `'local'` is this PC; anything else is a remote connection id. */
export const LOCAL_HOST = 'local';

export interface Bot {
  id: string;
  name: string;
  /** The bot's standing job, sent on every run. */
  instructions: string;
  /** Agent launch command, e.g. `claude`. */
  agent: string;
  model?: string | null;
  schedule: BotSchedule;
  /** HH:MM (hourly uses only the minutes). */
  time: string;
  /** Weekday for weekly schedules, 0 = Sunday. */
  day: number;
  /** Whether the schedule fires. Run now works either way. */
  enabled: boolean;
  /** Where it runs: `'local'` or a remote connection id. */
  boxId: string;
  access: BotAccess;
  /** Give the agent your MCP connectors (and Spacron's tools on this PC). */
  connectors: boolean;
  createdAt: number;
}

export interface BotRun {
  id: string;
  botId: string;
  name: string;
  startedAt: number;
  finishedAt?: number | null;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'missed' | 'interrupted';
  trigger: 'manual' | 'schedule' | '';
  detail?: string | null;
  log?: string | null;
}

export interface BotHostState { runs: BotRun[]; homeRoot: string }

export interface BotSettings {
  /** Master switch for schedules. Run now always works. */
  enabled: boolean;
  /** How late a scheduled run may still start. */
  catchUpMinutes: number;
  /** A run still going after this long is stopped. */
  maxRunMinutes: number;
  /** Show a notice when a run finishes, fails or is missed. */
  notify: boolean;
  /** Give bots on this PC Spacron's own MCP tools (spacron-mcp). */
  spacronTools: boolean;
  /** Access level a new bot starts with. */
  defaultAccess: BotAccess;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  enabled: true, catchUpMinutes: 15, maxRunMinutes: 60, notify: true, spacronTools: true, defaultAccess: 'research',
};

const KEY = 'spacron_bots_v1';
/** Agent CLIs with a headless mode the runner knows (see `agent_command`). */
const HEADLESS = new Set(['claude', 'codex', 'gemini', 'opencode']);
/** How far ahead run times are sent; refreshed on every connect and change. */
const WINDOW_MS = 14 * 24 * 60 * 60_000;
const MAX_OCCURRENCES = 400;
const MAX_INSTRUCTIONS = 20_000;

interface Saved { bots: Bot[]; settings: BotSettings }

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { bots: [], settings: DEFAULT_BOT_SETTINGS };
    const parsed = JSON.parse(raw) as { bots?: unknown; settings?: Partial<BotSettings> };
    const list = Array.isArray(parsed.bots) ? (parsed.bots as Bot[]).filter(isBot).map(upgrade) : [];
    return { bots: list, settings: { ...DEFAULT_BOT_SETTINGS, ...(parsed.settings ?? {}) } };
  } catch {
    return { bots: [], settings: DEFAULT_BOT_SETTINGS };
  }
}

function isBot(b: Bot): boolean {
  return Boolean(b && typeof b.id === 'string' && b.id && typeof b.name === 'string' && typeof b.instructions === 'string'
    && typeof b.agent === 'string' && typeof b.boxId === 'string'
    && ['manual', 'hourly', 'daily', 'weekdays', 'weekly'].includes(b.schedule));
}

/** Bots saved before access levels and connectors existed. */
function upgrade(b: Bot): Bot {
  return { ...b, access: ['research', 'folder', 'full'].includes(b.access) ? b.access : 'research', connectors: b.connectors ?? true };
}

const initial = load();
export const bots = writable<Bot[]>(initial.bots);
export const botSettings = writable<BotSettings>(initial.settings);
/** The bot open in the Bots panel. */
export const selectedBotId = writable<string | null>(null);
/** Whether the Bots home covers the workspace. Projects stay mounted underneath. */
export const botsOpen = writable(false);
/** Latest run records per host, refreshed by the panel and the watcher. */
export const botHostState = writable<Record<string, BotHostState>>({});

export function openBots(botId?: string | null): void {
  if (botId !== undefined) selectedBotId.set(botId);
  botsOpen.set(true);
}

export function closeBots(): void {
  botsOpen.set(false);
}

function persist(next: Saved) {
  // Persist first: a bot that was not saved must never reach a host.
  localStorage.setItem(KEY, JSON.stringify(next));
  bots.set(next.bots);
  botSettings.set(next.settings);
}

function commit(nextBots: Bot[], hosts: string[]) {
  persist({ bots: nextBots, settings: get(botSettings) });
  for (const host of new Set(hosts)) void syncHost(host).catch((error) => console.warn(`[bots] Could not sync ${host}:`, error));
}

/** The program name of an agent command, e.g. `claude` for `/usr/bin/claude --verbose`. */
function programName(command: string): string {
  const exe = command.trim().split(/\s+/)[0] ?? '';
  return (exe.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

export function canRunHeadless(command: string): boolean {
  return HEADLESS.has(programName(command));
}

export function agentProgram(command: string): string {
  return programName(command);
}

/** Installed agents that can run unattended. */
export function botAgents(): { command: string; name: string }[] {
  return getAgentRoster().filter((agent) => canRunHeadless(agent.command));
}

/** Whether this PC can run bots (only inside the desktop app). */
export function localAvailable(): boolean {
  return isTauriRuntime();
}

/** Hosts this window can reach right now: this PC and the connected box. */
export function reachableHosts(): string[] {
  const out: string[] = [];
  if (localAvailable()) out.push(LOCAL_HOST);
  const box = get(activeRemoteId);
  if (box && get(remoteTarget)) out.push(box);
  return out;
}

export function isReachable(host: string): boolean {
  return reachableHosts().includes(host);
}

/** Bots this window can see and run: this PC's and the connected box's. */
export function visibleBots(list: Bot[] = get(bots)): Bot[] {
  const hosts = new Set(reachableHosts());
  return list.filter((b) => hosts.has(b.boxId));
}

export function nextBotRun(b: Pick<Bot, 'schedule' | 'time' | 'day' | 'enabled'>, from = Date.now()): number | null {
  if (b.schedule === 'manual' || !b.enabled || !get(botSettings).enabled) return null;
  return nextOccurrence(b.schedule, b.time, b.day, from);
}

/** Upcoming run times in this computer's time zone, as epoch ms. */
export function upcomingBotRuns(b: Pick<Bot, 'schedule' | 'time' | 'day'>, from: number): number[] {
  if (b.schedule === 'manual') return [];
  const out: number[] = [];
  let t = from;
  while (out.length < MAX_OCCURRENCES) {
    t = nextOccurrence(b.schedule, b.time, b.day, t);
    if (t > from + WINDOW_MS) break;
    out.push(t);
  }
  return out;
}

export type BotInput = Omit<Bot, 'id' | 'createdAt'> & { id?: string };

/** Create or update a bot on a reachable host. */
export function saveBot(input: BotInput): Bot {
  const existing = input.id ? get(bots).find((b) => b.id === input.id) : undefined;
  const host = existing?.boxId ?? input.boxId;
  if (!isReachable(host)) {
    throw new Error(host === LOCAL_HOST
      ? 'Bots on this PC need the Spacron desktop app.'
      : existing ? 'This bot lives on another box. Connect to it to edit the bot.' : 'Connect to that box first.');
  }
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  if (!name || !instructions) throw new Error('Give the bot a name and a job.');
  if (instructions.length > MAX_INSTRUCTIONS) throw new Error(`Keep the job under ${MAX_INSTRUCTIONS.toLocaleString()} characters.`);
  if (!canRunHeadless(input.agent)) throw new Error('Choose Claude Code, Codex, Gemini CLI or opencode: bots need an agent that can run unattended.');
  if (!['research', 'folder', 'full'].includes(input.access)) throw new Error('Choose what the bot may do.');
  // Throws on a malformed time or day, before anything is saved.
  if (input.schedule !== 'manual') nextOccurrence(input.schedule, input.time, input.day, Date.now());
  const bot: Bot = {
    ...input,
    name,
    instructions,
    model: input.model || null,
    id: existing?.id ?? crypto.randomUUID(),
    boxId: host,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  commit([...get(bots).filter((b) => b.id !== bot.id), bot], [host]);
  return bot;
}

export function toggleBot(id: string) {
  const bot = get(bots).find((b) => b.id === id);
  if (!bot) return;
  commit(get(bots).map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)), [bot.boxId]);
}

export function removeBot(id: string) {
  const bot = get(bots).find((b) => b.id === id);
  commit(get(bots).filter((b) => b.id !== id), bot ? [bot.boxId] : []);
  if (get(selectedBotId) === id) selectedBotId.set(null);
}

export function updateBotSettings(patch: Partial<BotSettings>) {
  persist({ bots: get(bots), settings: { ...get(botSettings), ...patch } });
  void syncBots().catch((error) => console.warn('[bots] Could not sync settings:', error));
}

// ── talking to a host ───────────────────────────────────────────────────────

type HostCommand = 'sync' | 'state' | 'run_now' | 'log' | 'stop';
const LOCAL_COMMANDS: Record<HostCommand, string> = {
  sync: 'local_bots_sync', state: 'local_bots_state', run_now: 'local_bot_run_now', log: 'local_bot_log', stop: 'local_bot_stop',
};
const BOX_COMMANDS: Record<HostCommand, string> = {
  sync: 'box_bots_sync', state: 'box_bots_state', run_now: 'box_bot_run_now', log: 'box_bot_log', stop: 'box_bot_stop',
};

/** Call the runner on `host`: in-process for this PC, over the socket for a box. */
async function call<T>(host: string, command: HostCommand, args?: Record<string, unknown>): Promise<T> {
  if (host === LOCAL_HOST) {
    // Straight to this app, even while a remote is active (which would route
    // `backendInvoke` to the box).
    return invoke<T>(LOCAL_COMMANDS[command], command === 'state' ? {} : { args: args ?? {} });
  }
  if (get(activeRemoteId) !== host || !get(remoteTarget)) throw new Error('Connect to this bot’s box first.');
  return backendInvoke<T>(BOX_COMMANDS[command], args);
}

/**
 * The MCP servers a host's bots may use, as an `mcpServers` file body.
 *
 * - Your connectors from Settings > MCP & plugins, in Claude's shape.
 * - On this PC, signed-in connectors go through Spacron's sign-in proxy, and
 *   Spacron's own tools (spacron-mcp) are added when the setting is on.
 * - On a box, signed-in connectors and spacron-mcp are left out: both are
 *   served by this desktop app, which is not there while the laptop is closed.
 */
export async function botMcpConfig(host: string): Promise<string | null> {
  const servers = (get(mcpServers) ?? []) as McpServer[];
  const entries: Record<string, unknown> = {};
  let usable = servers.filter((s) => !s.oauth);
  if (host === LOCAL_HOST) {
    try {
      const { getMcpHttpUrl } = await import('$lib/stores/mcpBridge');
      usable = withSignInProxy(servers, await getMcpHttpUrl());
    } catch { /* No sign-in proxy: keep the connectors that need none. */ }
  }
  for (const { key, server } of enabledServers(usable)) entries[key] = standardEntry(server);
  if (host === LOCAL_HOST && get(botSettings).spacronTools) {
    try {
      const { getMcpUrl } = await import('$lib/stores/mcpBridge');
      const url = await getMcpUrl();
      // `type: 'sse'`: the in-app server speaks SSE (see mcpLaunchFlags).
      if (url) entries[SPACRON_OWN_KEY] = { type: 'sse', url };
    } catch { /* The in-app MCP server is not up; bots run without it. */ }
  }
  return Object.keys(entries).length ? JSON.stringify({ mcpServers: entries }) : null;
}

/** Connector names a bot on `host` would get, for the editor. */
export function connectorNames(host: string): string[] {
  const servers = ((get(mcpServers) ?? []) as McpServer[]).filter((s) => host === LOCAL_HOST || !s.oauth);
  const names = enabledServers(servers).map(({ server }) => server.name);
  if (host === LOCAL_HOST && get(botSettings).spacronTools) names.unshift('Spacron tools');
  return names;
}

const chains = new Map<string, Promise<void>>();

/**
 * Send one host its bots. Syncs to a host run one at a time and each reads
 * the state when it is sent, so quick edits can never land out of order and
 * leave the host with a stale list (a deleted bot that still fires, say).
 */
export function syncHost(host: string): Promise<void> {
  const run = (chains.get(host) ?? Promise.resolve()).then(() => sendHost(host));
  chains.set(host, run.catch(() => {}));
  return run;
}

async function sendHost(host: string): Promise<void> {
  if (!isReachable(host)) return;
  const settings = get(botSettings);
  const now = Date.now();
  const payload = get(bots).filter((b) => b.boxId === host).map((b) => ({
    id: b.id, name: b.name, instructions: b.instructions, agent: b.agent, model: b.model ?? null,
    enabled: b.enabled, occurrences: upcomingBotRuns(b, now), access: b.access, connectors: b.connectors,
  }));
  const mcpConfig = payload.some((b) => b.connectors) ? await botMcpConfig(host) : null;
  await call(host, 'sync', {
    bots: payload, enabled: settings.enabled, catchUpMinutes: settings.catchUpMinutes,
    maxRunMinutes: settings.maxRunMinutes, mcpConfig,
  });
}

/** Sync every reachable host. */
export async function syncBots(): Promise<void> {
  await Promise.all(reachableHosts().map(syncHost));
}

export async function runBotNow(id: string): Promise<string> {
  const bot = get(bots).find((b) => b.id === id);
  if (!bot) throw new Error('This bot no longer exists.');
  if (!isReachable(bot.boxId)) throw new Error('Connect to this bot’s box to run it.');
  // The host may not have the latest edit yet.
  await syncHost(bot.boxId);
  const { runId } = await call<{ runId: string }>(bot.boxId, 'run_now', { id });
  return runId;
}

export async function stopBotRun(bot: Pick<Bot, 'boxId'>, runId: string): Promise<void> {
  await call(bot.boxId, 'stop', { runId });
}

export async function fetchBotLog(bot: Pick<Bot, 'boxId'>, runId: string): Promise<{ text: string; truncated: boolean }> {
  return call(bot.boxId, 'log', { runId });
}

/** Refresh run records from every reachable host. */
export async function refreshBotState(): Promise<Record<string, BotHostState>> {
  const hosts = reachableHosts();
  const results = await Promise.allSettled(hosts.map((h) => call<BotHostState>(h, 'state')));
  const next: Record<string, BotHostState> = {};
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') next[hosts[i]] = r.value;
    else errors.push(String(r.reason));
  });
  botHostState.set(next);
  if (errors.length && !Object.keys(next).length) throw new Error(errors[0]);
  return next;
}

export function runsFor(state: Record<string, BotHostState>, bot: Pick<Bot, 'id' | 'boxId'>): BotRun[] {
  return (state[bot.boxId]?.runs ?? []).filter((r) => r.botId === bot.id);
}

/** A bot's newest run, if any. */
export function latestRun(state: Record<string, BotHostState>, bot: Pick<Bot, 'id' | 'boxId'>): BotRun | undefined {
  return runsFor(state, bot)[0];
}

// ── background watcher ──────────────────────────────────────────────────────

type Tone = 'info' | 'success' | 'warning' | 'error';
type Notice = (message: string, tone: Tone) => void;
let watcher: ReturnType<typeof setInterval> | null = null;
const seen = new Map<string, BotRun['status']>();

/**
 * Notices for runs that changed since the last look. The first look only
 * records what is there. A finished run seen for the first time is announced
 * only if the schedule started it (a manual run was watched from the panel).
 */
export function noticesFor(state: Record<string, BotHostState>, seeded: boolean): { message: string; tone: Tone }[] {
  const out: { message: string; tone: Tone }[] = [];
  for (const host of Object.values(state)) {
    for (const run of host.runs) {
      const before = seen.get(run.id);
      seen.set(run.id, run.status);
      if (!seeded || before === run.status || run.status === 'running') continue;
      if (before === undefined && run.trigger !== 'schedule') continue;
      const name = `Bot "${run.name}"`;
      if (run.status === 'completed') out.push({ message: `${name} finished. Open Bots to read the result.`, tone: 'success' });
      else if (run.status === 'failed') out.push({ message: `${name} failed${run.detail ? `: ${run.detail}` : '.'}`, tone: 'error' });
      else if (run.status === 'missed') out.push({ message: `${name} missed its scheduled run.`, tone: 'warning' });
    }
  }
  return out;
}

/** Keep run state fresh and announce finished runs while the app is open. */
export function startBotWatcher(notice: Notice): () => void {
  if (watcher) return () => {};
  let seeded = false;
  const tick = async () => {
    try {
      const state = await refreshBotState();
      const notices = noticesFor(state, seeded);
      seeded = true;
      if (get(botSettings).notify) notices.forEach((n) => notice(n.message, n.tone));
    } catch { /* A host is unreachable; try again next tick. */ }
  };
  // Refresh this PC's schedule window on launch, then start watching.
  void syncBots().catch(() => {}).then(tick);
  watcher = setInterval(() => void tick(), 20_000);
  return () => { if (watcher) clearInterval(watcher); watcher = null; };
}

/** Ready-made jobs to start a bot from. Nothing here touches a project. */
export const BOT_TEMPLATES: { id: string; name: string; blurb: string; instructions: string; schedule: BotSchedule; time: string; day: number; access: BotAccess }[] = [
  { id: 'digest', name: 'Morning tech digest', blurb: 'Every day at 08:00', schedule: 'daily', time: '08:00', day: 1, access: 'folder',
    instructions: 'Search the web for the most important news from the last 24 hours in AI, cybersecurity and software engineering. Pick the five stories that matter most, and for each write two sentences on what happened and why it matters. Save the digest as digests/<today’s date>.md and keep a one-line entry per day in NOTES.md.' },
  { id: 'ideas', name: 'Content idea scout', blurb: 'Mondays at 10:00', schedule: 'weekly', time: '10:00', day: 1, access: 'folder',
    instructions: 'Find what is trending this week in tech and developer culture. Propose ten video ideas, each with a hook, a working title and why it could perform now. Check NOTES.md first and never repeat an idea you already suggested; append the new ones to it. Save this week’s list as ideas/<today’s date>.md.' },
  { id: 'cve', name: 'Security advisory watch', blurb: 'Weekdays at 09:00', schedule: 'weekdays', time: '09:00', day: 1, access: 'research',
    instructions: 'Look up newly published critical and high severity CVEs and security advisories from the last day for widely used software (browsers, operating systems, Node.js, Python, Rust, popular web frameworks). Summarise each in plain language with who is affected and the fix.' },
  { id: 'research', name: 'Research assistant', blurb: 'Run on demand', schedule: 'manual', time: '09:00', day: 1, access: 'folder',
    instructions: 'Read TOPIC.md in your folder for the question to research (create it with a placeholder if it is missing and stop). Research it thoroughly from reliable sources, then write a clear report with sources to reports/<today’s date>.md.' },
];
