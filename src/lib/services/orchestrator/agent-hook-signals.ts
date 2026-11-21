/**
 * Deterministic turn signals — the agent tells us when its turn ended, instead
 * of us guessing from its screen.
 *
 * The screen-scraping path (`agent-signals.ts` + the BEL/regex/idle logic in
 * `agent-turn-watch.ts`) is brittle per-CLI and per-version: a missed phrase
 * leaves an agent stuck until the idle fallback **false-completes it and
 * releases the lease, losing the real answer**, and a quiet compile looks like
 * completion. Neither failure is detectable from the outside, which is what
 * makes it corrosive rather than merely imprecise.
 *
 * How it works, for CLIs that support hooks (today: Claude Code):
 *
 *   1. `prepareTurnSignals` mints a nonce, asks the backend to open an
 *      append-only file keyed by it, and writes a settings file containing a
 *      `Stop` hook and a `Notification` hook that each append one sentinel line
 *      carrying that nonce.
 *   2. The CLI is launched with `--settings <file>`, so the hooks apply to this
 *      launch only — nothing is written into the user's repo or their global
 *      config, which matters because several agents share one working tree.
 *   3. Once the session exists, `attachTurnSignals` binds the channel to it.
 *      The channel has to be opened *before* the session id is known, because
 *      the settings path is part of the launch command — hence the two steps.
 *   4. The backend tails the file and emits `agent-signal`; this module routes
 *      each line to the waiting watcher.
 *
 * The nonce is what makes a sentinel trustworthy. Without it, an agent that
 * echoes its own configuration — or a task description quoting this file —
 * could end its own turn. This is the same trap documented for the reviewer
 * verdict tokens in `.spacron/memory/reviewer-verdict-signals.md`.
 */

import { invoke } from '@tauri-apps/api/core';
import { agentStatusHooksEnabled } from '$lib/stores/settings';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { backendInvoke } from '$lib/services/backend';
import { get } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';

/**
 * Whether a signal channel opened here can actually be reached by the agent.
 *
 * A channel is a file. `agent_signal_channel_open` is a bare Tauri `invoke`, so
 * the file and its watcher are always created on **this** machine. That is
 * correct only while the agent runs on this machine too.
 *
 * With a remote workspace active the agent runs on the box, so the path we hand
 * it — in a `--settings` hook command, or in `$SPACRON_TURN_FILE` — names a
 * location that only exists on the laptop. The agent writes its sentinel over
 * there and the watcher over here never sees a line.
 *
 * Silently opening one anyway is worse than opening none. `hasTurnSignalChannel`
 * would report true, so `agent-turn-watch` treats the session as `signalled`,
 * skips the BEL/regex path entirely and waits out the 15-minute
 * `SIGNALLED_IDLE_MS` backstop — every remote turn hanging for a quarter of an
 * hour, on the strength of a channel nothing can write to. Declining here puts
 * those sessions back on the heuristic fallback at its normal window, which is
 * merely imprecise rather than broken.
 *
 * Making this actually work remotely means giving `spacron-server` its own
 * `agent_signal_channel_open`/`_close` and streaming the tail back over the
 * existing WebSocket; see `.spacron/memory/remote-invoke-seam-gap.md`. Until
 * then hooks-plus-remote is unsupported, and this is what says so out loud.
 */
function signalChannelsReachAgent(): boolean {
  return !get(remoteTarget);
}

/**
 * Outcome a declared signal can carry. Mirrors `AgentTurnOutcome`'s useful
 * cases minus its `via` field, which the watcher stamps — everything on this
 * channel is `declared` by definition.
 *
 * `failed` cannot come from a hook (Claude's `Stop`/`Notification` hooks have
 * no failure variant); it exists for `report_status`, where an agent can say
 * outright that it could not finish.
 */
export type HookSignal =
  /** `detail` is the agent's own summary of what it just did, when it gave one. */
  | { kind: 'finished'; detail?: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'failed'; reason: string };

const DONE_PREFIX = 'SPACRON-TURN-DONE:';
const INPUT_PREFIX = 'SPACRON-NEEDS-INPUT:';
const FAILED_PREFIX = 'SPACRON-TURN-FAILED:';
/**
 * Not a turn state — a URL an agent asked to open.
 *
 * It rides the same channel because the shim that writes it (`spacron-open`,
 * handed to every agent as its `BROWSER`) inherits `SPACRON_TURN_FILE` and
 * `SPACRON_TURN_TOKEN` from the agent that spawned it, so there is nothing to
 * thread through and no second watcher to keep alive. It is dispatched away
 * from the turn listeners deliberately: opening a link says nothing about
 * whether the agent has finished, and routing it through `HookSignal` would
 * end turns every time an agent showed you something.
 */
const OPEN_URL_PREFIX = 'SPACRON-OPEN-URL:';

/**
 * Agent presets whose CLI can emit turn hooks. Everything else keeps the
 * BEL/regex/idle fallback, which is why that code stays.
 */
const HOOK_CAPABLE = new Set(['claude', 'claude-code']);

/** A channel opened but not yet bound to a terminal session. */
export type PreparedTurnSignals = {
  /** The launch command with `--settings` appended. */
  command: string;
  /** Doubles as the nonce carried in every sentinel line. */
  channelId: string;
};

type ChannelState = {
  /**
   * The sentinel nonce, or **null** for a session that has no hook channel and
   * only ever receives signals pushed in from elsewhere (today: an agent's own
   * `report_status` MCP call — see `mcpBridge.ts`).
   *
   * The distinction is load-bearing, not bookkeeping. `hasTurnSignalChannel`
   * tests it rather than mere map membership, because a true answer moves the
   * watcher's idle fallback from 90 seconds to 15 minutes. That trade is right
   * for a hook agent, whose sentinel is guaranteed to arrive; it would be a
   * silent regression for every other CLI, which might report once and never
   * again — or never report at all.
   */
  channelId: string | null;
  /**
   * Every nonce bound to this session. A Claude agent can hold two at once —
   * the hook channel installed at launch and the shell channel every agent
   * gets — and both feed the same listeners, so whichever fires first ends the
   * turn and the other is ignored.
   */
  channelIds: Set<string>;
  /**
   * True only for a channel whose sentinel is *guaranteed* to arrive: Claude's
   * `Stop` hook. A shell channel depends on the agent remembering to echo, so
   * it must not buy the 15-minute idle window — see `hasTurnSignalChannel`.
   */
  guaranteed: boolean;
  listeners: Set<(signal: HookSignal) => void>;
};

/** Bound channels, keyed by terminal session. */
const channels = new Map<number, ChannelState>();
/** Reverse index so an incoming `agent-signal` can find its session in one step. */
const sessionByChannel = new Map<string, number>();

let unlisten: UnlistenFn | null = null;
let listening: Promise<void> | null = null;

/** True when this agent command can be driven by hook sentinels. */
export function supportsHookSignals(presetOrCommand: string | null | undefined): boolean {
  if (!presetOrCommand) return false;
  const first = presetOrCommand.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const executable = first.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/, '') ?? '';
  return HOOK_CAPABLE.has(executable);
}

/**
 * Interpret one line from a session's channel.
 *
 * Exported for tests, and anchored to the exact nonce: a line only counts when
 * it is the sentinel *for this session*, so echoed configuration and quoted
 * documentation can never end a turn.
 */
export function parseSignalLine(line: string, nonce: string): HookSignal | null {
  const trimmed = line.trim();
  /** Everything the agent wrote after the nonce — its own words, verbatim. */
  const detailAfter = (prefix: string) =>
    trimmed.slice(prefix.length + nonce.length).replace(/^[\s:]+/, '').trim();

  if (trimmed.startsWith(`${DONE_PREFIX}${nonce}`)) {
    // Claude's `Stop` hook writes the bare sentinel; an agent echoing this by
    // hand may add a sentence, and that sentence is what the inbox row shows.
    const detail = detailAfter(DONE_PREFIX);
    return detail ? { kind: 'finished', detail } : { kind: 'finished' };
  }
  if (trimmed.startsWith(`${INPUT_PREFIX}${nonce}`)) {
    const detail = detailAfter(INPUT_PREFIX);
    return { kind: 'blocked', reason: detail || 'Agent is waiting for your input.' };
  }
  if (trimmed.startsWith(`${FAILED_PREFIX}${nonce}`)) {
    const detail = detailAfter(FAILED_PREFIX);
    return { kind: 'failed', reason: detail || 'The agent reported that it could not finish.' };
  }
  return null;
}

/**
 * Interpret one line as an open-url sentinel, returning the URL to show.
 *
 * Anchored to the nonce exactly like `parseSignalLine`, and re-validated here
 * rather than trusted from the shim: this is the boundary where a line of text
 * an agent's own output could have influenced becomes a navigation. Only
 * http(s) survives, so a `file://` or `javascript:` line cannot reach the
 * preview iframe.
 */
export function parseOpenUrlLine(line: string, nonce: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${OPEN_URL_PREFIX}${nonce}`)) return null;
  const raw = trimmed.slice(OPEN_URL_PREFIX.length + nonce.length).replace(/^[\s:]+/, '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Randomness good enough that an agent cannot guess or accidentally reproduce it. */
function mintNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Show an agent's URL in the preview room.
 *
 * Imported lazily so this service does not pull the preview store (and the
 * layout store behind it) into every module that only wants turn signals —
 * the same shape `changelog.ts` and `agent-install.ts` use for the panel.
 */
async function showUrlInPreview(url: string): Promise<void> {
  try {
    const { openUrlInPreviewPanel } = await import('$lib/stores/preview');
    await openUrlInPreviewPanel(url);
  } catch (err) {
    console.error('Could not show an agent URL in the preview panel:', err);
  }
}

async function ensureListening(): Promise<void> {
  if (listening) return listening;
  listening = listen<{ channelId: string; line: string }>('agent-signal', (event) => {
    const { channelId, line } = event.payload;
    const sessionId = sessionByChannel.get(channelId);
    if (sessionId === undefined) return;
    const channel = channels.get(sessionId);
    if (!channel) return;
    // Parse against the nonce of the channel the line actually arrived on —
    // a session can have two, and the entry's `channelId` is only one of them.
    // A URL the agent asked to open. Handled before the turn parse and returned
    // on, so it never reaches the turn listeners — see OPEN_URL_PREFIX.
    const url = parseOpenUrlLine(line, channelId);
    if (url) {
      void showUrlInPreview(url);
      return;
    }
    const signal = parseSignalLine(line, channelId);
    if (!signal) return;
    emitToListeners(channel, signal);
  }).then((fn) => {
    unlisten = fn;
  });
  return listening;
}

/**
 * A hook command that appends one sentinel line to `path`.
 *
 * `echo <text>>><path>` is the rare construct that means the same thing in
 * `cmd.exe` and in every POSIX shell, so the same settings file works whichever
 * shell the CLI uses to run hooks. No space before `>>` — `cmd` would otherwise
 * write a trailing one (harmless, since lines are trimmed, but noisy).
 */
function appendCommand(text: string, path: string): string {
  return `echo ${text}>>"${path}"`;
}

/**
 * Claude Code notification types that mean "the agent is waiting on you":
 * a tool permission, an MCP input form (in-app or by URL), or an explicit
 * request for input. Matched as a regex against the notification type.
 * Source: code.claude.com/docs/en/hooks, Notification matchers (2026-09-24).
 */
export const NOTIFICATION_INPUT_TYPES =
  'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input';

/**
 * The Claude Code settings document that installs the two hooks.
 *
 * Exported for tests. `Stop` fires when the agent finishes its turn;
 * `Notification` fires when it wants the user — which is exactly the
 * finished/blocked distinction the watcher has been inferring from prose.
 */
export function buildClaudeHookSettings(nonce: string, path: string): unknown {
  return {
    hooks: {
      Stop: [
        {
          hooks: [{ type: 'command', command: appendCommand(`${DONE_PREFIX}${nonce}`, path) }],
        },
      ],
      Notification: [
        {
          // Only notifications that ARE a request for the user. Unfiltered,
          // this also fired on `idle_prompt` (the "waiting for your input"
          // reminder a minute after a turn FINISHES), `agent_completed`,
          // `auth_success` and the quota notices, and each one was reported
          // as "needs your input", so a finished agent raised a question card.
          matcher: NOTIFICATION_INPUT_TYPES,
          hooks: [{ type: 'command', command: appendCommand(`${INPUT_PREFIX}${nonce}`, path) }],
        },
      ],
    },
  };
}

/**
 * Open a signal channel and produce the launch command that uses it.
 *
 * Returns null — and the caller launches the CLI unchanged — whenever anything
 * fails. A missing sentinel channel costs accuracy; a failed launch costs the
 * whole turn, so this never blocks a spawn.
 */
export async function prepareTurnSignals(command: string): Promise<PreparedTurnSignals | null> {
  if (!get(agentStatusHooksEnabled) || !supportsHookSignals(command)) return null;
  if (!signalChannelsReachAgent()) {
    console.info(
      'Remote workspace active: skipping turn-signal hooks (the channel file would be on the laptop, the agent is on the box). Falling back to output scanning.',
    );
    return null;
  }

  const channelId = mintNonce();
  try {
    const path = await invoke<string>('agent_signal_channel_open', { channelId });
    const settingsPath = `${path}.settings.json`;
    await backendInvoke('fs_write_file', {
      path: settingsPath,
      content: JSON.stringify(buildClaudeHookSettings(channelId, path), null, 2),
    });
    await ensureListening();

    // Appended, not substituted: the user's own flags stay as they wrote them,
    // and `--settings` layers on top of their global/project config rather than
    // replacing it.
    return { command: `${command} --settings "${settingsPath}"`, channelId };
  } catch (err) {
    console.error('Could not install turn-signal hooks; falling back to output scanning:', err);
    try {
      await invoke('agent_signal_channel_close', { channelId });
    } catch {
      /* nothing open */
    }
    return null;
  }
}

/**
 * Open a status channel for an agent that has no hooks and no MCP tools.
 *
 * This is what makes turn reporting available to *every* CLI rather than the
 * handful Spacron can write an MCP config for. The agent is handed a file path
 * and a nonce in its environment and told, in its standing brief, to append one
 * line when it stops:
 *
 *     echo SPACRON-TURN-DONE:$SPACRON_TURN_TOKEN done here >> $SPACRON_TURN_FILE
 *
 * Every coding CLI can run a shell command — that is the one capability they
 * all share — so this reaches the ~30 agents that `injectMcpConfigForAgent` has
 * no branch for. The nonce is what makes it trustworthy: it exists only in that
 * session's environment, so no other agent (and no quoted documentation) can
 * produce a line that ends this turn.
 *
 * Best-effort by design, hence `guaranteed: false` when attached — an agent may
 * simply forget, and the idle fallback must stay at its normal window for it.
 */
export async function prepareStatusChannel(): Promise<{
  channelId: string;
  path: string;
} | null> {
  if (!signalChannelsReachAgent()) {
    console.info(
      'Remote workspace active: skipping the agent status channel (the sentinel file would be on the laptop, the agent is on the box).',
    );
    return null;
  }

  const channelId = mintNonce();
  try {
    const path = await invoke<string>('agent_signal_channel_open', { channelId });
    await ensureListening();
    return { channelId, path };
  } catch (err) {
    console.error('Could not open an agent status channel:', err);
    return null;
  }
}

/**
 * Bind a prepared channel to the session that was launched with it. Until this
 * runs, sentinels arriving on the channel have nowhere to go — which is fine,
 * since the agent cannot have finished a turn before its terminal exists.
 */
export function attachTurnSignals(
  sessionId: number,
  prepared: PreparedTurnSignals,
  opts: { guaranteed?: boolean } = {},
): void {
  const existing = channels.get(sessionId);
  const channel: ChannelState = existing ?? {
    channelId: null,
    channelIds: new Set(),
    guaranteed: false,
    listeners: new Set(),
  };
  channel.channelId = prepared.channelId;
  channel.channelIds.add(prepared.channelId);
  // Additive: a session that already has a guaranteed channel keeps that
  // standing when a best-effort one is added alongside it.
  channel.guaranteed = channel.guaranteed || opts.guaranteed === true;
  channels.set(sessionId, channel);
  sessionByChannel.set(prepared.channelId, sessionId);
}

/**
 * Throw away a channel that was prepared but never attached — the launch it was
 * built for failed, so nothing will ever write to it.
 */
export async function discardPreparedTurnSignals(prepared: PreparedTurnSignals): Promise<void> {
  try {
    await invoke('agent_signal_channel_close', { channelId: prepared.channelId });
  } catch (err) {
    console.error('Failed to discard agent signal channel:', err);
  }
}

/** Deliver one signal to everything watching this session. */
function emitToListeners(channel: ChannelState, signal: HookSignal): void {
  for (const listener of [...channel.listeners]) {
    try {
      listener(signal);
    } catch (err) {
      console.error('Agent signal listener failed:', err);
    }
  }
}

/**
 * Whether this session has a live **hook** sentinel channel.
 *
 * Deliberately not `channels.has(sessionId)`: `onTurnSignal` now creates an
 * entry for any watched session so a signal arriving later has somewhere to go,
 * and treating those as hook channels would move every non-hook agent onto the
 * 15-minute idle fallback. See the `channelId` doc on `ChannelState`.
 */
export function hasTurnSignalChannel(sessionId: number): boolean {
  return channels.get(sessionId)?.guaranteed === true;
}

/**
 * Whether this session has *any* way for its agent to declare a turn end —
 * a hook channel, or the shell channel every spawned agent gets.
 *
 * This is the question "was its silence a choice?", which is what decides
 * whether an inferred finish is allowed to stay quiet.
 */
export function hasAnyTurnSignalChannel(sessionId: number): boolean {
  return (channels.get(sessionId)?.channelIds.size ?? 0) > 0;
}

/**
 * Whether a turn watcher is currently armed for this session.
 *
 * Terminal output has a legacy attention-prompt fallback for sessions whose
 * turns are not being watched. It must stand down while a watcher is present,
 * otherwise one prompt produces both that fallback toast and the orchestrator's
 * durable needs-input card. Channel presence is not enough here: a leased
 * session keeps its channels after one turn ends so a hand-typed follow-up can
 * still report, even though no watcher may be listening for screen heuristics.
 */
export function hasTurnSignalListener(sessionId: number): boolean {
  return (channels.get(sessionId)?.listeners.size ?? 0) > 0;
}

/**
 * Subscribe to this session's turn signals. Returns an unsubscribe function.
 *
 * Registers even when the session has no channel yet. A hook channel is opened
 * before launch, but an MCP report can arrive from a session that never had
 * one — and the watcher subscribes once, at the start of the turn, so a
 * no-op subscription would drop every signal that arrived afterwards.
 */
export function onTurnSignal(
  sessionId: number,
  listener: (signal: HookSignal) => void,
): () => void {
  let channel = channels.get(sessionId);
  if (!channel) {
    channel = { channelId: null, channelIds: new Set(), guaranteed: false, listeners: new Set() };
    channels.set(sessionId, channel);
  }
  channel.listeners.add(listener);
  return () => {
    channel.listeners.delete(listener);
    // A listener-only entry exists solely for its listeners. Dropping it keeps
    // `channels` from growing one entry per session for the life of the app.
    if (channel.channelIds.size === 0 && channel.listeners.size === 0) {
      channels.delete(sessionId);
    }
  };
}

/**
 * Push a signal in from outside the hook path — an agent's own `report_status`
 * MCP call, which carries the same "the agent said so" trust as a sentinel
 * because the MCP server attributed it by token, not by anything the agent
 * claimed (see `authorize` in `src-tauri/src/mcp/mod.rs`).
 *
 * Returns whether anything was listening: a report for a session with no armed
 * watcher is still worth showing the user, but it did not end a turn.
 */
export function deliverTurnSignal(sessionId: number, signal: HookSignal): boolean {
  const channel = channels.get(sessionId);
  if (!channel || channel.listeners.size === 0) return false;
  emitToListeners(channel, signal);
  return true;
}

/** Tear down a session's channel. Safe to call for sessions that never had one. */
export async function closeTurnSignalChannel(sessionId: number): Promise<void> {
  const channel = channels.get(sessionId);
  if (!channel) return;
  channels.delete(sessionId);
  channel.listeners.clear();
  // Nothing was opened for a listener-only entry, so there is nothing to close.
  if (channel.channelIds.size === 0) return;
  for (const channelId of channel.channelIds) {
    sessionByChannel.delete(channelId);
    try {
      await invoke('agent_signal_channel_close', { channelId });
    } catch (err) {
      console.error('Failed to close agent signal channel:', err);
    }
  }
  if (channels.size === 0 && unlisten) {
    unlisten();
    unlisten = null;
    listening = null;
  }
}

/** Test seam: forget all channel state without touching the backend. */
export function __resetTurnSignalsForTest(): void {
  channels.clear();
  sessionByChannel.clear();
  unlisten = null;
  listening = null;
}

/** Test seam: bind a hook (guaranteed) channel without a backend round trip. */
export function __registerChannelForTest(sessionId: number, channelId: string): void {
  attachTurnSignals(sessionId, { command: '', channelId }, { guaranteed: true });
}

/** Test seam: bind a shell status channel — a real channel, but best-effort. */
export function __registerStatusChannelForTest(sessionId: number, channelId: string): void {
  attachTurnSignals(sessionId, { command: '', channelId });
}

/** Test seam: deliver a raw line as though the backend had emitted it. */
export function __deliverLineForTest(channelId: string, line: string): void {
  const sessionId = sessionByChannel.get(channelId);
  if (sessionId === undefined) return;
  const channel = channels.get(sessionId);
  if (!channel) return;
  // Parse against the incoming nonce, exactly as `ensureListening` does — a
  // session can hold two channels and the entry's `channelId` is only one.
  const signal = parseSignalLine(line, channelId);
  if (!signal) return;
  emitToListeners(channel, signal);
}
