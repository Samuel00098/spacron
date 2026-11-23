/**
 * Bots: agents that live outside every project and work for you from the box
 * (spacron-server), so they keep running while this laptop is closed.
 *
 * The desktop owns the bot definitions and the schedule language (it knows the
 * user's time zone); the box gets each bot's upcoming run times as epoch ms,
 * exactly like box automations. See `src-tauri/src/remote/bots.rs`.
 *
 * A bot belongs to the box it was created on (`boxId`, the remote connection
 * id): its home folder, memory and run history live there.
 */
import { get, writable } from '$lib/stores/storeCompat';
import { activeRemoteId, remoteTarget } from '$lib/stores/remoteWorkspace';
import { getAgentRoster } from '$lib/stores/runs';
import { backendInvoke } from '$lib/services/backend';
import { nextOccurrence, type Schedule } from '$lib/services/automations/schedule';

export type BotSchedule = 'manual' | Schedule;

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
  /** Remote connection id of the box this bot lives on. */
  boxId: string;
  createdAt: number;
}

/** A run recorded by the box (`.spacron/bots/runs.json`). */
export interface BotRun {
  id: string;
  botId: string;
  name: string;
  startedAt: number;
  finishedAt?: number | null;
  status: 'running' | 'completed' | 'failed' | 'missed' | 'interrupted';
  trigger: 'manual' | 'schedule' | '';
  detail?: string | null;
  log?: string | null;
}

export interface BotBoxState { runs: BotRun[]; homeRoot: string }

const KEY = 'spacron_bots_v1';
/** Agent CLIs with a headless mode the box runner knows (see `agent_command`). */
const HEADLESS = new Set(['claude', 'codex', 'gemini', 'opencode']);
/** How far ahead run times are sent; refreshed on every connect and change. */
const BOX_WINDOW_MS = 14 * 24 * 60 * 60_000;
const BOX_MAX_OCCURRENCES = 400;
const MAX_INSTRUCTIONS = 20_000;

function load(): Bot[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { bots?: unknown };
    return Array.isArray(parsed.bots) ? (parsed.bots as Bot[]).filter(isBot) : [];
  } catch {
    return [];
  }
}

function isBot(b: Bot): boolean {
  return Boolean(b && typeof b.id === 'string' && b.id && typeof b.name === 'string' && typeof b.instructions === 'string'
    && typeof b.agent === 'string' && typeof b.boxId === 'string'
    && ['manual', 'hourly', 'daily', 'weekdays', 'weekly'].includes(b.schedule));
}

export const bots = writable<Bot[]>(load());
/** The bot open in the Bots panel. */
export const selectedBotId = writable<string | null>(null);
/** Whether the Bots home covers the workspace. Projects stay mounted underneath. */
export const botsOpen = writable(false);

/** Open the Bots home, optionally on one bot (or `null` for the list). */
export function openBots(botId?: string | null): void {
  if (botId !== undefined) selectedBotId.set(botId);
  botsOpen.set(true);
}

export function closeBots(): void {
  botsOpen.set(false);
}

function commit(next: Bot[]) {
  // Persist first: a bot that was not saved must never reach the box.
  localStorage.setItem(KEY, JSON.stringify({ bots: next }));
  bots.set(next);
  if (get(remoteTarget)) void syncBots().catch((error) => console.warn('[bots] Could not sync to the box:', error));
}

/** The program name of an agent command, e.g. `claude` for `/usr/bin/claude --verbose`. */
function programName(command: string): string {
  const exe = command.trim().split(/\s+/)[0] ?? '';
  return (exe.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

export function canRunHeadless(command: string): boolean {
  return HEADLESS.has(programName(command));
}

/** Installed agents that can run unattended on the box. */
export function botAgents(): { command: string; name: string }[] {
  return getAgentRoster().filter((agent) => canRunHeadless(agent.command));
}

/** Bots that live on the box this window is connected to. */
export function botsOnActiveBox(list: Bot[] = get(bots)): Bot[] {
  const box = get(activeRemoteId);
  return box ? list.filter((b) => b.boxId === box) : [];
}

export function nextBotRun(b: Pick<Bot, 'schedule' | 'time' | 'day' | 'enabled'>, from = Date.now()): number | null {
  if (b.schedule === 'manual' || !b.enabled) return null;
  return nextOccurrence(b.schedule, b.time, b.day, from);
}

/** Upcoming run times in this computer's time zone, as epoch ms. */
export function upcomingBotRuns(b: Pick<Bot, 'schedule' | 'time' | 'day'>, from: number): number[] {
  if (b.schedule === 'manual') return [];
  const out: number[] = [];
  let t = from;
  while (out.length < BOX_MAX_OCCURRENCES) {
    t = nextOccurrence(b.schedule, b.time, b.day, t);
    if (t > from + BOX_WINDOW_MS) break;
    out.push(t);
  }
  return out;
}

export type BotInput = Omit<Bot, 'id' | 'boxId' | 'createdAt'> & { id?: string };

/** Create or update a bot on the box this window is connected to. */
export function saveBot(input: BotInput): Bot {
  const box = get(activeRemoteId);
  const existing = input.id ? get(bots).find((b) => b.id === input.id) : undefined;
  if (!existing && (!box || !get(remoteTarget))) throw new Error('Connect to a box first. Bots run on the box so they keep working while this laptop is closed.');
  if (existing && existing.boxId !== box) throw new Error('This bot lives on another box. Connect to it to edit the bot.');
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  if (!name || !instructions) throw new Error('Give the bot a name and a job.');
  if (instructions.length > MAX_INSTRUCTIONS) throw new Error(`Keep the job under ${MAX_INSTRUCTIONS.toLocaleString()} characters.`);
  if (!canRunHeadless(input.agent)) throw new Error('Choose Claude Code, Codex, Gemini CLI or opencode: bots need an agent that can run unattended.');
  // Throws on a malformed time or day, before anything is saved.
  if (input.schedule !== 'manual') nextOccurrence(input.schedule, input.time, input.day, Date.now());
  const bot: Bot = {
    ...input,
    name,
    instructions,
    model: input.model || null,
    id: existing?.id ?? crypto.randomUUID(),
    boxId: existing?.boxId ?? box!,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  commit([...get(bots).filter((b) => b.id !== bot.id), bot]);
  return bot;
}

export function toggleBot(id: string) {
  commit(get(bots).map((b) => (b.id === id ? { ...b, enabled: !b.enabled } : b)));
}

export function removeBot(id: string) {
  commit(get(bots).filter((b) => b.id !== id));
  if (get(selectedBotId) === id) selectedBotId.set(null);
}

let syncChain: Promise<void> = Promise.resolve();

/**
 * Send the active box's bots, with upcoming run times, to the box. Syncs run
 * one at a time and each reads the state when it is sent, so quick edits can
 * never land out of order and leave the box with a stale list (a deleted bot
 * that still fires, say).
 */
export function syncBots(): Promise<void> {
  const run = syncChain.then(sendBots);
  syncChain = run.catch(() => {});
  return run;
}

async function sendBots(): Promise<void> {
  if (!get(remoteTarget) || !get(activeRemoteId)) return;
  const now = Date.now();
  const payload = botsOnActiveBox().map((b) => ({
    id: b.id, name: b.name, instructions: b.instructions, agent: b.agent, model: b.model ?? null,
    enabled: b.enabled, occurrences: upcomingBotRuns(b, now),
  }));
  await backendInvoke('box_bots_sync', { bots: payload, enabled: true, catchUpMinutes: 15 });
}

export async function runBotNow(id: string): Promise<string> {
  const bot = get(bots).find((b) => b.id === id);
  if (!bot) throw new Error('This bot no longer exists.');
  if (!get(remoteTarget) || get(activeRemoteId) !== bot.boxId) throw new Error('Connect to this bot’s box to run it.');
  // The box may not have the latest edit yet.
  await syncBots();
  const { runId } = await backendInvoke<{ runId: string }>('box_bot_run_now', { id });
  return runId;
}

export async function fetchBotState(): Promise<BotBoxState> {
  if (!get(remoteTarget)) return { runs: [], homeRoot: '' };
  return backendInvoke<BotBoxState>('box_bots_state');
}

/** The box's latest run records, refreshed by the Bots panel while it is open. */
export const botBoxState = writable<BotBoxState>({ runs: [], homeRoot: '' });

export async function refreshBotState(): Promise<BotBoxState> {
  const next = await fetchBotState();
  botBoxState.set(next);
  return next;
}

/** A bot's newest run, if any. */
export function latestRun(runs: BotRun[], botId: string): BotRun | undefined {
  return runs.find((r) => r.botId === botId);
}

export async function fetchBotLog(runId: string): Promise<{ text: string; truncated: boolean }> {
  return backendInvoke<{ text: string; truncated: boolean }>('box_bot_log', { runId });
}

/** Ready-made jobs to start a bot from. Nothing here touches a project. */
export const BOT_TEMPLATES: { id: string; name: string; blurb: string; instructions: string; schedule: BotSchedule; time: string; day: number }[] = [
  { id: 'digest', name: 'Morning tech digest', blurb: 'Every day at 08:00', schedule: 'daily', time: '08:00', day: 1,
    instructions: 'Search the web for the most important news from the last 24 hours in AI, cybersecurity and software engineering. Pick the five stories that matter most, and for each write two sentences on what happened and why it matters. Save the digest as digests/<today’s date>.md and keep a one-line entry per day in NOTES.md.' },
  { id: 'ideas', name: 'Content idea scout', blurb: 'Mondays at 10:00', schedule: 'weekly', time: '10:00', day: 1,
    instructions: 'Find what is trending this week in tech and developer culture. Propose ten video ideas, each with a hook, a working title and why it could perform now. Check NOTES.md first and never repeat an idea you already suggested; append the new ones to it. Save this week’s list as ideas/<today’s date>.md.' },
  { id: 'cve', name: 'Security advisory watch', blurb: 'Weekdays at 09:00', schedule: 'weekdays', time: '09:00', day: 1,
    instructions: 'Look up newly published critical and high severity CVEs and security advisories from the last day for widely used software (browsers, operating systems, Node.js, Python, Rust, popular web frameworks). Summarise each in plain language with who is affected and the fix. Save the report as advisories/<today’s date>.md.' },
  { id: 'research', name: 'Research assistant', blurb: 'Run on demand', schedule: 'manual', time: '09:00', day: 1,
    instructions: 'Read TOPIC.md in your folder for the question to research (create it with a placeholder if it is missing and stop). Research it thoroughly from reliable sources, then write a clear report with sources to reports/<today’s date>.md.' },
];
