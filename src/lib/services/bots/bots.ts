/**
 * Bots: agents that live outside every project and work for you on a
 * schedule, on demand, or when you chat with them, powered by the agent CLIs
 * installed where they run.
 *
 * A bot runs on one of two hosts (`boxId`):
 * - `'local'` — **this PC**, inside the desktop app, for people without a box.
 *   It runs while Spacron is open (`commands/local_bots.rs`).
 * - a remote connection id — **a box** (spacron-server), so it keeps working
 *   while this laptop is closed (`remote/bots.rs` behind `box_bot*`).
 *
 * Both hosts run the same Rust runner, which also keeps each bot's chat
 * history (every run is one exchange). The desktop owns the bot definitions
 * and the schedule language (it knows the user's time zone); a host gets each
 * bot's upcoming run times as epoch ms, exactly like box automations.
 */
import { invoke } from '@tauri-apps/api/core';
import { get, writable } from '$lib/stores/storeCompat';
import { activeRemoteId, remoteTarget } from '$lib/stores/remoteWorkspace';
import { getAgentRoster } from '$lib/stores/runs';
import { mcpServers } from '$lib/stores/settings';
import { backendInvoke } from '$lib/services/backend';
import { botChatVisuals } from '$lib/stores/botChatSettings';
import type { ChatVisualsSpot } from '$lib/stores/terminal';
import { enabledServers, standardEntry, withSignInProxy, SPACRON_OWN_KEY, SPACRON_BROWSER_KEY, type McpServer } from '$lib/services/mcp-servers';
import { nextOccurrence, type Schedule } from '$lib/services/automations/schedule';
import { sharedWith } from '$lib/services/box-signins';
import { catalogIconFor } from '$lib/services/mcp-catalog';
import { isTauriRuntime } from '$lib/utils/tauri';
import { BOT_AVATARS, DEFAULT_AVATAR, isBuiltInAvatar } from './avatars';
import { BOT_TEMPLATES } from './templates';

export type BotSchedule = 'manual' | Schedule;
/** What a bot may do unattended. Turned into each CLI's own flags on the host. */
export type BotAccess = 'research' | 'folder' | 'full';
/** `'local'` is this PC; anything else is a remote connection id. */
export const LOCAL_HOST = 'local';
/** The box's own MCP server (`remote/box_mcp.rs`): agents on the box, virtual desktop. */
export const BOX_TOOLS_KEY = 'spacron-box';
const ACCESS_RANK: Record<BotAccess, number> = { research: 0, folder: 1, full: 2 };
export const MAX_BOT_STARTER_PROMPTS = 3;
export const MAX_BOT_STARTER_LENGTH = 160;

export interface Bot {
  id: string;
  name: string;
  /** The bot's standing job, sent on every run. */
  instructions: string;
  starterPrompts?: string[];
  /** Agent launch command, e.g. `claude`. */
  agent: string;
  model?: string | null;
  schedule: BotSchedule;
  /** HH:MM (hourly uses only the minutes). */
  time: string;
  /** Weekday for weekly schedules, 0 = Sunday. */
  day: number;
  /** Whether the schedule fires. Run now and chat work either way. */
  enabled: boolean;
  /** Where it runs: `'local'` or a remote connection id. */
  boxId: string;
  access: BotAccess;
  /** Kept for bots saved before the connector picker: true meant "all". */
  connectors: boolean;
  /** The connectors (MCP config keys) this bot gets. `undefined` = all (older bots). */
  mcpKeys?: string[];
  /** Give the bot a web browser it can open and use (Playwright). */
  browser: boolean;
  /** May create other bots (the Bot Builder). */
  canCreateBots: boolean;
  /**
   * May use the computer: this PC's screen through Spacron's own tools
   * (Windows; you allow each window), or the box's virtual desktop.
   */
  computerUse: boolean;
  /** A built-in avatar id, or an uploaded image as a data URL. */
  avatar: string;
  createdAt: number;
  /** Set when another bot created this one. */
  createdBy?: string;
}

export interface BotRun {
  id: string;
  botId: string;
  name: string;
  startedAt: number;
  finishedAt?: number | null;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'missed' | 'interrupted';
  trigger: 'manual' | 'schedule' | 'chat' | '';
  detail?: string | null;
  log?: string | null;
  /** The chat message that started this run. */
  message?: string | null;
  /** Files attached to that message, relative to the bot's home folder. */
  attachments?: string[];
}

export interface BotProposal {
  id: string;
  createdBy: string;
  createdByName: string;
  creatorAccess: BotAccess;
  createdAt: number;
  spec: Record<string, unknown>;
}

export interface BotHostState { runs: BotRun[]; homeRoot: string; proposals?: BotProposal[] }

export interface BotSettings {
  /** Master switch for schedules. Run now and chat always work. */
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
const HEADLESS = new Set([
  'claude', 'codex', 'gemini', 'opencode', 'agy', 'pi', 'cursor-agent', 'grok', 'dsh', 'kilo',
]);
/** How far ahead run times are sent; refreshed on every connect and change. */
const WINDOW_MS = 14 * 24 * 60 * 60_000;
const MAX_OCCURRENCES = 400;
const MAX_INSTRUCTIONS = 20_000;
/** Uploaded avatars are resized before saving; this is a backstop. */
const MAX_AVATAR_CHARS = 120_000;

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

/** Bots saved by earlier versions get today's fields. */
function upgrade(b: Bot): Bot {
  return {
    ...b,
    starterPrompts: normalizeStarterPrompts(b.starterPrompts),
    access: ['research', 'folder', 'full'].includes(b.access) ? b.access : 'research',
    connectors: b.connectors ?? true,
    mcpKeys: Array.isArray(b.mcpKeys) ? b.mcpKeys.filter((k) => typeof k === 'string') : undefined,
    browser: b.browser === true,
    canCreateBots: b.canCreateBots === true,
    computerUse: b.computerUse === true,
    avatar: validAvatar(b.avatar) ? b.avatar : DEFAULT_AVATAR,
  };
}

export function validAvatar(avatar: unknown): avatar is string {
  return typeof avatar === 'string' && (isBuiltInAvatar(avatar) || (/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar) && avatar.length <= MAX_AVATAR_CHARS));
}

/** Pick an unused mascot for a new bot when the built-in set has room. */
export function suggestBotAvatar(preferred = DEFAULT_AVATAR): string {
  const used = new Set(get(bots).map((bot) => bot.avatar));
  if (!used.has(preferred)) return preferred;
  return BOT_AVATARS.find(({ id }) => !used.has(id))?.id ?? preferred;
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

// ── connectors ──────────────────────────────────────────────────────────────

export interface ConnectorChoice {
  key: string;
  name: string;
  /** The catalog id it was installed from, for its icon. */
  catalogId?: string;
  icon?: string;
  /** Whether a bot on this host can use it right now. */
  usable: boolean;
  /** Why not, when it can't. */
  reason?: string;
}

/** The connectors a bot on `host` can pick from (Settings > MCP & plugins). */
export function connectorChoices(host: string): ConnectorChoice[] {
  const servers = (get(mcpServers) ?? []) as McpServer[];
  const shared = new Set(host === LOCAL_HOST ? [] : sharedWith(host));
  const out: ConnectorChoice[] = enabledServers(servers).map(({ key, server }) => {
    const signIn = server.oauth === true;
    const usable = host === LOCAL_HOST || !signIn || shared.has(key);
    return {
      key, name: server.name, catalogId: server.catalogId, usable,
      icon: catalogIconFor(server.catalogId ?? server.name, server.url),
      ...(usable ? {} : { reason: 'Signed in on this computer only. Share it with the box in Settings > Bots.' }),
    };
  });
  if (get(botSettings).spacronTools) {
    out.unshift({
      key: host === LOCAL_HOST ? SPACRON_OWN_KEY : BOX_TOOLS_KEY,
      name: 'Spacron tools',
      icon: '/favicon.png',
      usable: true,
    });
  }
  return out;
}

/** Names of the connectors a bot actually gets, for display. */
export function botConnectorNames(bot: Pick<Bot, 'boxId' | 'mcpKeys' | 'connectors'>): string[] {
  const choices = connectorChoices(bot.boxId).filter((c) => c.usable);
  if (!bot.connectors) return [];
  return (bot.mcpKeys ? choices.filter((c) => bot.mcpKeys!.includes(c.key)) : choices).map((c) => c.name);
}

/**
 * Every MCP server a host's bots may use, as an `mcpServers` file body. Each
 * bot then gets only its own picks (`mcpKeys`, narrowed by the runner).
 *
 * - This PC: your connectors, signed-in ones through Spacron's sign-in proxy,
 *   plus Spacron's own tools when the setting is on.
 * - A box: connectors that need no sign-in as they are; signed-in ones only if
 *   shared with that box, through the box's own proxy (resolved by the runner
 *   from `spacron-box-proxy://<key>`). Spacron's own tools are served by this
 *   app, so a box never gets them.
 * - The browser (Playwright) when any bot on the host wants one.
 */
export async function botMcpConfig(host: string, withBrowser = false, withComputer = false): Promise<string | null> {
  const servers = (get(mcpServers) ?? []) as McpServer[];
  const entries: Record<string, unknown> = {};
  if (host === LOCAL_HOST) {
    let usable = servers.filter((s) => !s.oauth);
    try {
      const { getMcpHttpUrl } = await import('$lib/stores/mcpBridge');
      usable = withSignInProxy(servers, await getMcpHttpUrl());
    } catch { /* No sign-in proxy: keep the connectors that need none. */ }
    for (const { key, server } of enabledServers(usable)) entries[key] = standardEntry(server);
    // Computer use on this PC is Spacron's own desktop tools, served by spacron-mcp.
    if (get(botSettings).spacronTools || withComputer) {
      try {
        const { getMcpUrl } = await import('$lib/stores/mcpBridge');
        const url = await getMcpUrl();
        // `type: 'sse'`: the in-app server speaks SSE (see mcpLaunchFlags).
        if (url) entries[SPACRON_OWN_KEY] = { type: 'sse', url };
      } catch { /* The in-app MCP server is not up; bots run without it. */ }
    }
  } else {
    const shared = new Set(sharedWith(host));
    for (const { key, server } of enabledServers(servers)) {
      if (!server.oauth) entries[key] = standardEntry(server);
      else if (shared.has(key)) entries[key] = { type: 'http', url: `spacron-box-proxy://${key}` };
    }
    // The box's own tools, resolved by the runner to its live address.
    if (get(botSettings).spacronTools || withComputer) entries[BOX_TOOLS_KEY] = { type: 'http', url: 'spacron-box-mcp://' };
  }
  if (withBrowser) {
    try {
      const { botBrowserEntry } = await import('$lib/stores/mcpBridge');
      entries[SPACRON_BROWSER_KEY] = await botBrowserEntry(host === LOCAL_HOST);
    } catch { /* No browser available; the bot runs without one. */ }
  }
  return Object.keys(entries).length ? JSON.stringify({ mcpServers: entries }) : null;
}

/** The MCP keys one bot gets: its picks plus the browser. */
function keysFor(b: Bot): string[] | null {
  if (b.mcpKeys === undefined) return null;
  const computer = b.computerUse ? [b.boxId === LOCAL_HOST ? SPACRON_OWN_KEY : BOX_TOOLS_KEY] : [];
  return [...new Set([...b.mcpKeys, ...(b.browser ? [SPACRON_BROWSER_KEY] : []), ...computer])];
}

// ── saving ──────────────────────────────────────────────────────────────────

export type BotInput = Omit<Bot, 'id' | 'createdAt'> & { id?: string };

function normalizeStarterPrompts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const prompts = value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const prompt = entry.trim().replace(/\s+/g, ' ');
    return prompt && prompt.length <= MAX_BOT_STARTER_LENGTH ? [prompt] : [];
  });
  const unique = [...new Set(prompts)].slice(0, MAX_BOT_STARTER_PROMPTS);
  return unique.length ? unique : undefined;
}

/** Resolve authored prompts, original template prompts, or defaults for a custom job. */
export function botStarterPrompts(bot: Pick<Bot, 'name' | 'instructions' | 'starterPrompts'>): string[] {
  if (bot.starterPrompts?.length) return bot.starterPrompts;
  const template = BOT_TEMPLATES.find((entry) => entry.instructions === bot.instructions.trim());
  if (template) return template.starterPrompts;

  const name = bot.name.trim().slice(0, 80) || 'this bot';
  const firstLine = bot.instructions.trim().split(/\r?\n/, 1)[0] ?? '';
  const firstSentence = firstLine.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? firstLine;
  const instruction = firstSentence.trim();
  return [
    instruction.length > 0 && instruction.length <= 100 && !/^you (?:are|will|must)\b/i.test(instruction)
      ? instruction
      : `Run the ${name} job and summarize the result.`,
    `Show me an example of what ${name} can deliver.`,
    `What do you need from me to run ${name}?`,
  ];
}

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
  if (!canRunHeadless(input.agent)) throw new Error('Choose an agent that supports unattended bot runs.');
  if (!['research', 'folder', 'full'].includes(input.access)) throw new Error('Choose what the bot may do.');
  if (!validAvatar(input.avatar)) throw new Error('That picture could not be used. Try a smaller PNG, JPEG or WebP.');
  // Throws on a malformed time or day, before anything is saved.
  if (input.schedule !== 'manual') nextOccurrence(input.schedule, input.time, input.day, Date.now());
  const mcpKeys = input.mcpKeys === undefined ? undefined : [...new Set(input.mcpKeys)];
  const bot: Bot = {
    ...input,
    name,
    instructions,
    starterPrompts: normalizeStarterPrompts(input.starterPrompts),
    model: input.model || null,
    mcpKeys,
    connectors: mcpKeys === undefined ? input.connectors : mcpKeys.length > 0,
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

type HostCommand = 'sync' | 'state' | 'run_now' | 'log' | 'stop' | 'ack' | 'attach' | 'file';
const LOCAL_COMMANDS: Record<HostCommand, string> = {
  sync: 'local_bots_sync', state: 'local_bots_state', run_now: 'local_bot_run_now', log: 'local_bot_log', stop: 'local_bot_stop', ack: 'local_bot_proposals_ack',
  attach: 'local_bot_attach', file: 'local_bot_file',
};
const BOX_COMMANDS: Record<HostCommand, string> = {
  sync: 'box_bots_sync', state: 'box_bots_state', run_now: 'box_bot_run_now', log: 'box_bot_log', stop: 'box_bot_stop', ack: 'box_bot_proposals_ack',
  attach: 'box_bot_attach', file: 'box_bot_file',
};

/** How long a call to a runner may take before the UI gives up waiting. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * Call the runner on `host`, giving up after CALL_TIMEOUT_MS so a stalled box
 * connection shows an error instead of leaving "Sending…" up forever.
 */
async function call<T>(host: string, command: HostCommand, args?: Record<string, unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(host === LOCAL_HOST
      ? 'Spacron did not answer in time. Try again.'
      : 'The box did not answer in time. Check the connection and try again.')), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([callHost<T>(host, command, args), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Call the runner on `host`: in-process for this PC, over the socket for a box. */
async function callHost<T>(host: string, command: HostCommand, args?: Record<string, unknown>): Promise<T> {
  if (host === LOCAL_HOST) {
    // Straight to this app, even while a remote is active (which would route
    // `backendInvoke` to the box).
    return invoke<T>(LOCAL_COMMANDS[command], command === 'state' ? {} : { args: args ?? {} });
  }
  if (get(activeRemoteId) !== host || !get(remoteTarget)) throw new Error('Connect to this bot’s box first.');
  return backendInvoke<T>(BOX_COMMANDS[command], args);
}

/** What the Bot Builder may choose from on `host`, added to its prompt. */
function builderContext(host: string): string {
  const connectors = connectorChoices(host).filter((c) => c.usable).map((c) => c.name);
  const agents = botAgents().map((a) => `${a.command} (${a.name})`);
  return [
    `Connectors you can give a bot: ${connectors.length ? connectors.join(', ') : 'none set up yet'}.`,
    `Agents: ${agents.length ? agents.join(', ') : 'claude'}.`,
    `Avatars: ${BOT_AVATARS.map((a) => a.id).join(', ')}.`,
  ].join('\n');
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
  const mine = get(bots).filter((b) => b.boxId === host);
  const payload = mine.map((b) => ({
    id: b.id, name: b.name, instructions: b.instructions, agent: b.agent, model: b.model ?? null,
    enabled: b.enabled, occurrences: upcomingBotRuns(b, now), access: b.access,
    connectors: b.connectors || b.browser || b.computerUse, mcpKeys: keysFor(b), canCreateBots: b.canCreateBots,
    computerUse: b.computerUse,
    chatVisuals: get(botChatVisuals),
    extraContext: b.canCreateBots ? builderContext(host) : null,
  }));
  const wantsMcp = payload.some((b) => b.connectors);
  const mcpConfig = wantsMcp ? await botMcpConfig(host, mine.some((b) => b.browser), mine.some((b) => b.computerUse)) : null;
  await call(host, 'sync', {
    bots: payload, enabled: settings.enabled, catchUpMinutes: settings.catchUpMinutes,
    maxRunMinutes: settings.maxRunMinutes, mcpConfig,
  });
}

/** Sync every reachable host. */
export async function syncBots(): Promise<void> {
  await Promise.all(reachableHosts().map(syncHost));
}

/** Start a run now; with `message`, it is a chat message the bot answers. */
export async function runBotNow(id: string, message?: string, attachments: string[] = []): Promise<string> {
  const bot = get(bots).find((b) => b.id === id);
  if (!bot) throw new Error('This bot no longer exists.');
  if (!isReachable(bot.boxId)) throw new Error('Connect to this bot’s box to run it.');
  // The host may not have the latest edit yet.
  await syncHost(bot.boxId);
  const { runId } = await call<{ runId: string }>(bot.boxId, 'run_now', {
    id, ...(message?.trim() ? { message: message.trim() } : {}), ...(attachments.length ? { attachments } : {}),
  });
  return runId;
}

export function sendBotMessage(id: string, message: string, attachments: string[] = []): Promise<string> {
  if (!message.trim() && !attachments.length) return Promise.reject(new Error('Type a message first.'));
  return runBotNow(id, message, attachments);
}

/** Largest file a bot chat takes, and how many per message (the runner checks too). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** What the runner records when a message is files only. */
export const FILES_ONLY_MESSAGE = '(sent files)';

async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Upload one file into the bot's folder (PC or box); returns its path for the message. */
export async function attachToBot(bot: Pick<Bot, 'id' | 'boxId'>, file: File): Promise<string> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`"${file.name}" is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  if (!isReachable(bot.boxId)) throw new Error('Connect to this bot’s box first.');
  const { path } = await call<{ path: string }>(bot.boxId, 'attach', { botId: bot.id, name: file.name || 'file', data: await base64Of(file) });
  return path;
}

/**
 * An interactive visual the bot wrote (`::spacron-visual{file="x.html"}` in its
 * reply), served in the chat. The page is read from the bot's home, on this PC
 * or a box, and put in the chat's own folder under the visuals server.
 * Cached per page; a failure is not, because the page may only be late.
 */
const visualSpots = new Map<string, Promise<ChatVisualsSpot>>();

export function botVisualSpot(bot: Pick<Bot, 'id' | 'boxId'>, file: string): Promise<ChatVisualsSpot> {
  const cacheKey = `${bot.boxId}:${bot.id}:${file}`;
  const cached = visualSpots.get(cacheKey);
  if (cached) return cached;
  // One folder per bot; the visuals server takes `[A-Za-z0-9-]{1,64}`.
  const key = `bot-${bot.id.replace(/[^A-Za-z0-9]/g, '-')}`.slice(0, 64);
  const pending = (async () => {
    const page = await call<{ text: string }>(bot.boxId, 'file', { botId: bot.id, path: `visuals/${file}` });
    const spot = await invoke<ChatVisualsSpot>('chat_visuals_prepare', { key });
    await invoke('chat_visuals_write', { key, file, content: page.text });
    return spot;
  })();
  visualSpots.set(cacheKey, pending);
  pending.catch(() => visualSpots.delete(cacheKey));
  return pending;
}

const previews = new Map<string, Promise<string | null>>();

/** A data URL for an attached image, for chat thumbnails (cached). */
export function attachmentPreview(bot: Pick<Bot, 'id' | 'boxId'>, path: string): Promise<string | null> {
  if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return Promise.resolve(null);
  const key = `${bot.boxId}:${bot.id}:${path}`;
  if (!previews.has(key)) {
    previews.set(key, call<{ mime: string; data: string }>(bot.boxId, 'file', { botId: bot.id, path })
      .then((f) => `data:${f.mime};base64,${f.data}`).catch(() => null));
  }
  return previews.get(key)!;
}

export async function stopBotRun(bot: Pick<Bot, 'boxId'>, runId: string): Promise<void> {
  await call(bot.boxId, 'stop', { runId });
}

export async function fetchBotLog(bot: Pick<Bot, 'boxId'>, runId: string): Promise<{ text: string; truncated: boolean }> {
  return call(bot.boxId, 'log', { runId });
}

/** Refresh run records from every reachable host, and add any bots the Bot Builder made. */
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
  for (const [host, state] of Object.entries(next)) {
    if (state.proposals?.length) void adoptProposals(host, state.proposals);
  }
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

// ── Bot Builder ─────────────────────────────────────────────────────────────

type NoticeTone = 'info' | 'success' | 'warning' | 'error';
type Notice = (message: string, tone: NoticeTone, spoken?: string) => void;
let notice: Notice | null = null;
const adopting = new Set<string>();

/**
 * Turn a Bot Builder's spec into a bot input, or explain why not. A created
 * bot never gets more access than its creator, never creates bots itself, and
 * starts with its schedule off: the user turns it on.
 */
export function botFromProposal(host: string, p: BotProposal): BotInput | string {
  const spec = p.spec ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(spec.name).slice(0, 80);
  const instructions = str(spec.instructions);
  if (!name || !instructions) return 'it had no name or job';
  const schedule = (['manual', 'hourly', 'daily', 'weekdays', 'weekly'] as const).find((s) => s === spec.schedule) ?? 'manual';
  const time = /^\d{2}:\d{2}$/.test(str(spec.time)) ? str(spec.time) : '09:00';
  const day = Number.isInteger(spec.day) && (spec.day as number) >= 0 && (spec.day as number) <= 6 ? (spec.day as number) : 1;
  const creator = get(bots).find((b) => b.id === p.createdBy);
  const ceiling: BotAccess = creator?.access ?? (['research', 'folder', 'full'].includes(p.creatorAccess) ? p.creatorAccess : 'research');
  const wanted = (['research', 'folder', 'full'] as const).find((a) => a === spec.access) ?? 'research';
  const access = ACCESS_RANK[wanted] <= ACCESS_RANK[ceiling] ? wanted : ceiling;
  const agents = botAgents();
  const agent = agents.find((a) => a.command === str(spec.agent) || agentProgram(a.command) === str(spec.agent).toLowerCase())?.command
    ?? creator?.agent ?? agents[0]?.command ?? 'claude';
  const names = Array.isArray(spec.connectors) ? spec.connectors.map((n) => str(n).toLowerCase()).filter(Boolean) : [];
  const choices = connectorChoices(host).filter((c) => c.usable);
  const mcpKeys = choices.filter((c) => names.some((n) => c.name.toLowerCase() === n || c.key === n || c.catalogId === n)).map((c) => c.key);
  const avatar = suggestBotAvatar(isBuiltInAvatar(str(spec.avatar)) ? str(spec.avatar) : DEFAULT_AVATAR);
  return {
    boxId: host, name, instructions, starterPrompts: normalizeStarterPrompts(spec.starterPrompts), agent, model: null, schedule, time, day, enabled: false, access,
    connectors: mcpKeys.length > 0, mcpKeys, browser: spec.browser === true, canCreateBots: false, avatar,
    computerUse: spec.computerUse === true && creator?.computerUse === true,
    createdBy: p.createdByName || p.createdBy,
  };
}

async function adoptProposals(host: string, proposals: BotProposal[]): Promise<void> {
  const fresh = proposals.filter((p) => !adopting.has(p.id));
  if (!fresh.length) return;
  fresh.forEach((p) => adopting.add(p.id));
  const done: string[] = [];
  for (const p of fresh) {
    const input = botFromProposal(host, p);
    try {
      if (typeof input === 'string') throw new Error(input);
      const bot = saveBot(input);
      notice?.(`${p.createdByName || 'A bot'} created "${bot.name}". Open it to review it and turn on its schedule.`, 'success');
    } catch (e) {
      notice?.(`${p.createdByName || 'A bot'} tried to create a bot, but ${e instanceof Error ? e.message : String(e)}.`, 'warning');
    }
    done.push(p.id);
  }
  try { await call(host, 'ack', { ids: done }); } finally { done.forEach((id) => adopting.delete(id)); }
}

// ── background watcher ──────────────────────────────────────────────────────

let watcher: ReturnType<typeof setInterval> | null = null;
const seen = new Map<string, BotRun['status']>();

/**
 * Announce status changes and runs that finish between polls. The first
 * snapshot seeds older runs without replaying them.
 */
export function noticesFor(state: Record<string, BotHostState>, watchingSince: number): { message: string; tone: NoticeTone; spoken: string }[] {
  const out: { message: string; tone: NoticeTone; spoken: string }[] = [];
  for (const host of Object.values(state)) {
    for (const run of host.runs) {
      const before = seen.get(run.id);
      seen.set(run.id, run.status);
      if (before === run.status || run.status === 'running') continue;
      if (before === undefined && (run.finishedAt ?? run.startedAt) < watchingSince) continue;
      const name = `Bot "${run.name}"`;
      if (run.status === 'completed') out.push({ message: `${name} finished. Open Bots to read the result.`, tone: 'success', spoken: `${name} finished.` });
      else if (run.status === 'failed') out.push({ message: `${name} failed${run.detail ? `: ${run.detail}` : '.'}`, tone: 'error', spoken: `${name} could not finish.` });
      else if (run.status === 'missed') out.push({ message: `${name} missed its scheduled run.`, tone: 'warning', spoken: `${name} missed its scheduled run.` });
    }
  }
  return out;
}

/** Keep run state fresh, adopt Bot Builder creations and announce finished runs. */
export function startBotWatcher(onNotice: Notice): () => void {
  notice = onNotice;
  if (watcher) return () => {};
  const watchingSince = Date.now();
  const tick = async () => {
    try {
      const state = await refreshBotState();
      const notices = noticesFor(state, watchingSince);
      if (get(botSettings).notify) notices.forEach((n) => onNotice(n.message, n.tone, n.spoken));
    } catch { /* A host is unreachable; try again next tick. */ }
  };
  // Refresh this PC's schedule window on launch, then start watching.
  void syncBots().catch(() => {}).then(tick);
  watcher = setInterval(() => void tick(), 20_000);
  return () => { if (watcher) clearInterval(watcher); watcher = null; };
}

export { BOT_TEMPLATES, type BotTemplate } from './templates';
