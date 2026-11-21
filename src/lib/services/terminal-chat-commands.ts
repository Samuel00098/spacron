/**
 * Slash commands run in an agent pane, from either face of it, kept for the
 * chat view.
 *
 * Claude Code writes the commands typed in its terminal into its transcript,
 * so its chat shows them. Codex, OpenCode and the rest write none: a `/status`
 * typed in the terminal never reached the chat. So the pane's keystrokes are
 * watched: an Enter that submits a line starting with `/` records the command,
 * and its reply is read off the screen (`terminal-command-output.ts`), the same
 * way as for a command sent from the chat.
 *
 * The store lives here, not in the view: the view unmounts while the pane
 * shows its terminal, and what ran meanwhile must be there when it comes back.
 */
import { startCommandCapture, type CommandCapture } from '$lib/services/terminal-command-output';
import { slashCommandsFor } from '$lib/services/terminal-chat-rich';
import { transcriptAgentFor, type TranscriptAgent } from '$lib/services/terminal-chat';
import { onSessionExit } from '$lib/stores/terminal';

export type SentCommand = {
  id: number;
  text: string;
  /** How many matching command rows the transcript had when it was sent; it gives way once there are more. */
  seen: number;
  /** Transcript items before it, when known; otherwise placed by `sentAt`. */
  at: number;
  sentAt: number;
  output?: string;
  /** Typed in the terminal rather than sent from the chat. */
  fromTerminal?: boolean;
};

/** A command whose screen takes keys (a picker, a dialog), shown live in the chat. */
export type LiveScreen = { command: string; sentId: number; capture: CommandCapture };

const sentCommandStore = new Map<number, SentCommand[]>();
const liveScreenStore = new Map<number, LiveScreen>();
const listeners = new Set<() => void>();
let nextId = 1;

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeChatCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function nextCommandId(): number {
  nextId += 1;
  return nextId;
}

export function getSentCommands(sessionId: number): SentCommand[] {
  return sentCommandStore.get(sessionId) ?? [];
}

export function getLiveScreen(sessionId: number): LiveScreen | null {
  return liveScreenStore.get(sessionId) ?? null;
}

export function updateSentCommands(sessionId: number, fn: (list: SentCommand[]) => SentCommand[]): void {
  const prev = sentCommandStore.get(sessionId) ?? [];
  const next = fn(prev);
  if (next === prev) return;
  sentCommandStore.set(sessionId, next);
  notify();
}

export function setLiveScreen(sessionId: number, live: LiveScreen | null): void {
  if (live) liveScreenStore.set(sessionId, live);
  else liveScreenStore.delete(sessionId);
  notify();
}

export function forgetChatCommands(sessionId: number): void {
  sentCommandStore.delete(sessionId);
  liveScreenStore.delete(sessionId);
  lineBuffers.delete(sessionId);
  notify();
}

// A closed pane's commands go with it.
onSessionExit(({ sessionId }) => forgetChatCommands(sessionId));

// ── Commands typed in the terminal ─────────────────────────────────────────

/** What has been typed on the pane's input line since the last Enter; null once it can't be followed. */
const lineBuffers = new Map<number, string | null>();

/**
 * Follow the line a person types into an agent pane's terminal. Called with
 * each xterm `onData` chunk before it is written to the PTY, so a command's
 * screen is marked before the CLI answers it.
 */
export function noteTerminalInput(sessionId: number, agentPreset: string | null | undefined, data: string): void {
  const agent = transcriptAgentFor(agentPreset);
  if (!agent) return;
  let line: string | null = lineBuffers.has(sessionId) ? lineBuffers.get(sessionId)! : '';
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n') {
      if (line) submitTypedLine(sessionId, agent, line);
      line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (line != null) line = line.slice(0, -1);
    } else if (ch === '\x15' || ch === '\x03') {
      // Ctrl+U / Ctrl+C clear the input line.
      line = '';
    } else if (ch === '\x1b') {
      // An arrow or other key sequence: the cursor may have moved, so the
      // line can no longer be followed; skip the rest of the sequence.
      if (data.startsWith('\x1b[200~', i) || data.startsWith('\x1b[201~', i)) {
        i += 5;
        continue;
      }
      line = null;
      const rest = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(data.slice(i));
      i += Math.max(0, (rest?.[0].length ?? 1) - 1);
    } else if (ch >= ' ' && line != null) {
      line += ch;
    }
  }
  lineBuffers.set(sessionId, line);
}

/** The command a typed line runs: an exact name, or the one name it is a prefix of (the `/` popup completes it). */
export function resolveTypedCommand(agent: TranscriptAgent, line: string): string | null {
  const text = line.trim();
  if (!/^\/[\w:-]/.test(text)) return null;
  const [word, ...args] = text.split(/\s+/);
  const names = slashCommandsFor(agent).map((c) => c.name);
  if (names.includes(word) || !names.length) return text;
  // Several matches (`/stat` → `/status`, `/statusline`): the popup's top row,
  // the shortest name, is what Enter runs.
  const matches = names.filter((n) => n.startsWith(word)).sort((a, b) => a.length - b.length);
  if (matches.length) return [matches[0], ...args].join(' ');
  // A skill or custom command the catalog doesn't list: keep what was typed.
  return text;
}

function submitTypedLine(sessionId: number, agent: TranscriptAgent, line: string): void {
  // Claude Code records commands typed in its terminal itself.
  if (agent === 'claude' || agent === 'openclaude') return;
  const command = resolveTypedCommand(agent, line);
  if (!command) return;
  const id = nextCommandId();
  const capture = startCommandCapture(sessionId, command);
  updateSentCommands(sessionId, (list) => [
    ...list,
    { id, text: command, seen: Number.MAX_SAFE_INTEGER, at: -1, sentAt: Date.now(), fromTerminal: true },
  ]);
  void watchUntilClosed(capture).then((output) => {
    if (output) updateSentCommands(sessionId, (list) => list.map((c) => (c.id === id ? { ...c, output } : c)));
  });
}

/**
 * The command's reply once it is done: when a screen it opened (a picker)
 * closes again, or, for a command that just prints, once the screen settles.
 */
async function watchUntilClosed(capture: CommandCapture, maxWaitMs = 5 * 60_000): Promise<string | null> {
  const started = Date.now();
  let away = false;
  let last: string | null = null;
  let lastText: string | null = null;
  let stableSince = Date.now();
  while (Date.now() - started < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const now = capture.peek();
    if (now) last = now;
    if (now !== lastText) {
      lastText = now;
      stableSince = Date.now();
    }
    const atPrompt = capture.atPrompt();
    if (!atPrompt) away = true;
    else if (away) return last;
    // Never left the prompt: a command that only prints. Done once quiet.
    if (!away && Date.now() - started > 1200 && Date.now() - stableSince > 800) return last;
  }
  return last;
}
