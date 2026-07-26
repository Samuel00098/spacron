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
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { backendInvoke } from '$lib/services/backend';

/** Outcome a sentinel line can carry. Mirrors `AgentTurnOutcome`'s useful cases. */
export type HookSignal = { kind: 'finished' } | { kind: 'blocked'; reason: string };

const DONE_PREFIX = 'SPACRON-TURN-DONE:';
const INPUT_PREFIX = 'SPACRON-NEEDS-INPUT:';

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
  channelId: string;
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
  if (trimmed === `${DONE_PREFIX}${nonce}`) return { kind: 'finished' };
  if (trimmed.startsWith(`${INPUT_PREFIX}${nonce}`)) {
    // Anything after the nonce is the CLI's own "why", passed through verbatim.
    const detail = trimmed.slice(INPUT_PREFIX.length + nonce.length).replace(/^[\s:]+/, '').trim();
    return { kind: 'blocked', reason: detail || 'Agent is waiting for your input.' };
  }
  return null;
}

/** Randomness good enough that an agent cannot guess or accidentally reproduce it. */
function mintNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureListening(): Promise<void> {
  if (listening) return listening;
  listening = listen<{ channelId: string; line: string }>('agent-signal', (event) => {
    const { channelId, line } = event.payload;
    const sessionId = sessionByChannel.get(channelId);
    if (sessionId === undefined) return;
    const channel = channels.get(sessionId);
    if (!channel) return;
    const signal = parseSignalLine(line, channel.channelId);
    if (!signal) return;
    for (const listener of [...channel.listeners]) {
      try {
        listener(signal);
      } catch (err) {
        console.error('Agent signal listener failed:', err);
      }
    }
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
  if (!supportsHookSignals(command)) return null;

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
 * Bind a prepared channel to the session that was launched with it. Until this
 * runs, sentinels arriving on the channel have nowhere to go — which is fine,
 * since the agent cannot have finished a turn before its terminal exists.
 */
export function attachTurnSignals(sessionId: number, prepared: PreparedTurnSignals): void {
  channels.set(sessionId, { channelId: prepared.channelId, listeners: new Set() });
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

/** Whether this session has a live sentinel channel. */
export function hasTurnSignalChannel(sessionId: number): boolean {
  return channels.has(sessionId);
}

/** Subscribe to this session's sentinels. Returns an unsubscribe function. */
export function onTurnSignal(
  sessionId: number,
  listener: (signal: HookSignal) => void,
): () => void {
  const channel = channels.get(sessionId);
  if (!channel) return () => {};
  channel.listeners.add(listener);
  return () => {
    channel.listeners.delete(listener);
  };
}

/** Tear down a session's channel. Safe to call for sessions that never had one. */
export async function closeTurnSignalChannel(sessionId: number): Promise<void> {
  const channel = channels.get(sessionId);
  if (!channel) return;
  channels.delete(sessionId);
  sessionByChannel.delete(channel.channelId);
  channel.listeners.clear();
  try {
    await invoke('agent_signal_channel_close', { channelId: channel.channelId });
  } catch (err) {
    console.error('Failed to close agent signal channel:', err);
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

/** Test seam: bind a channel without a backend round trip. */
export function __registerChannelForTest(sessionId: number, channelId: string): void {
  attachTurnSignals(sessionId, { command: '', channelId });
}

/** Test seam: deliver a raw line as though the backend had emitted it. */
export function __deliverLineForTest(channelId: string, line: string): void {
  const sessionId = sessionByChannel.get(channelId);
  if (sessionId === undefined) return;
  const channel = channels.get(sessionId);
  if (!channel) return;
  const signal = parseSignalLine(line, channel.channelId);
  if (!signal) return;
  for (const listener of [...channel.listeners]) listener(signal);
}
