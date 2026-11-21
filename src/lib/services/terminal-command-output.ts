/**
 * What a slash command printed on the agent's terminal, for the chat view.
 *
 * Claude Code writes a few command replies to its transcript
 * (`<local-command-stdout>`); the other CLIs write none: Codex's `/status`,
 * `/mcp` or `/diff` only ever reach the screen. So the chat reads the pane's
 * rendered screen around the command instead: everything after the command's
 * echo (an inline TUI like Codex), or what appeared that was not there before
 * (a full-screen TUI like OpenCode, which redraws one viewport), minus the
 * CLI's own composer, footer and frames.
 *
 * Screens checked against Codex 0.171 in a ConPTY: `/status` echoes as a
 * `/status` row and prints its report under it, then the composer
 * (`› Ask Codex to do anything`) and the footer (`GPT-6-Luna medium · ~\dir`).
 */
import { markTerminalScreen, readTerminalScreen, type ScreenMark } from '$lib/services/terminal-screen';

const FRAME_EDGE_START = /^\s*[│┃║▌▐]\s?/;
const FRAME_EDGE_END = /\s?[│┃║▌▐]\s*$/;
const ONLY_FRAME = /^[\s╭╮╰╯│┃┌┐└┘├┤┬┴┼─━═╔╗╚╝║·•.…⋯▔▁]*$/;
/** The CLIs' input rows, hints and status lines, never part of a command's reply. */
const CHROME: RegExp[] = [
  /^\s*[›>❯]\s*$/,
  /^\s*[›>❯]\s+(ask codex|type your message|ask anything)/i,
  /esc to interrupt/i,
  /\?\s*for shortcuts/i,
  /ctrl\+[a-z] to /i,
  /context left\b/i,
  /bypass permissions on|shift\+tab to cycle|auto-accept edits on|plan mode on|manual mode on|auto mode on/i,
  // Codex's footer: `GPT-6-Luna medium · ~\path`.
  /^\s*[^\s·][^·]{0,60}\s·\s+(?:~[\\/]|[A-Za-z]:[\\/]|\/)[^·]*$/,
];

const MAX_LINES = 120;

export interface CommandCapture {
  /** Read what the command printed, once the screen has settled. */
  finish(opts?: { settleMs?: number; maxWaitMs?: number }): Promise<string | null>;
  /** What the command shows right now (a picker as it is driven), without waiting. */
  peek(): string | null;
  /** The raw rows the command's screen shows now, for a live view of a picker. */
  screen(): string;
  /** Whether the CLI's own prompt rows are back at the bottom (its screen closed). */
  atPrompt(): boolean;
}

function lines(text: string | null): string[] {
  return (text ?? '').replace(/\r/g, '').split('\n');
}

function bare(line: string): string {
  return line.replace(/^\s*[›>❯]\s*/, '').trim();
}

/** Start watching a pane before the command is typed into it. */
export function startCommandCapture(sessionId: number, command: string): CommandCapture {
  const mark: ScreenMark | null = markTerminalScreen(sessionId);
  const before = lines(readTerminalScreen(sessionId, { maxLines: 200 }));
  // The rows a TUI keeps drawn at the bottom (composer, footer): chrome after too.
  const chromeTail = new Set(before.filter((l) => l.trim()).slice(-4).map((l) => l.trim()));
  const echo = command.trim();

  const readNow = () => readTerminalScreen(sessionId, { from: mark, maxLines: 400 });
  return {
    peek() {
      const now = readNow();
      return now == null ? null : extractCommandOutput(before, lines(now), echo, chromeTail, Boolean(mark));
    },
    screen() {
      const rows = lines(readTerminalScreen(sessionId, { maxLines: 40 }));
      // The newest copy of the command's echo starts the view when it is there.
      for (let i = rows.length - 1; i >= 0; i -= 1) if (bare(rows[i]) === echo) return rows.slice(i + 1).join('\n');
      return rows.join('\n');
    },
    atPrompt() {
      if (!chromeTail.size) return true;
      const tail = new Set(lines(readTerminalScreen(sessionId, { maxLines: 12 })).filter((l) => l.trim()).slice(-6).map((l) => l.trim()));
      // The composer row is the one that must be back; the footer can repaint with new values.
      return [...chromeTail].filter((l) => tail.has(l)).length >= Math.min(2, chromeTail.size);
    },
    async finish({ settleMs = 1200, maxWaitMs = 6000 } = {}) {
      const started = Date.now();
      let last: string | null = null;
      let stableSince = Date.now();
      // Wait until the screen stops changing (or give up and read it as is).
      while (Date.now() - started < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const now = readTerminalScreen(sessionId, { from: mark, maxLines: 400 });
        if (now !== last) {
          last = now;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 500 && Date.now() - started >= settleMs) {
          break;
        }
      }
      if (last == null) return null;
      return extractCommandOutput(before, lines(last), echo, chromeTail, Boolean(mark));
    },
  };
}

/**
 * The command's reply in `after`: the rows below the command's last echo when
 * there is one, otherwise the rows that `before` did not have.
 */
export function extractCommandOutput(
  before: string[],
  after: string[],
  command: string,
  chromeTail: Set<string> = new Set(),
  afterIsSinceMark = false,
): string | null {
  let body: string[] | null = null;
  for (let i = after.length - 1; i >= 0; i -= 1) {
    if (bare(after[i]) === command) {
      body = after.slice(i + 1);
      break;
    }
  }
  if (!body) {
    if (afterIsSinceMark) {
      body = after;
    } else {
      // A redrawn viewport: keep the rows that are new, in order.
      const seen = new Map<string, number>();
      for (const l of before) seen.set(l.trim(), (seen.get(l.trim()) ?? 0) + 1);
      body = after.filter((l) => {
        const key = l.trim();
        const n = seen.get(key) ?? 0;
        if (n > 0) {
          seen.set(key, n - 1);
          return false;
        }
        return true;
      });
    }
  }
  const kept: string[] = [];
  for (const raw of body) {
    if (chromeTail.has(raw.trim())) continue;
    if (ONLY_FRAME.test(raw) && raw.trim()) continue;
    if (CHROME.some((re) => re.test(raw))) continue;
    if (bare(raw) === command) continue;
    // A dialog's close hint (`Status        esc`) is chrome too.
    const line = raw.replace(FRAME_EDGE_START, '').replace(FRAME_EDGE_END, '').replace(/\s{2,}esc\s*$/i, '').replace(/\s+$/, '');
    if (!line.trim() && (!kept.length || !kept[kept.length - 1].trim())) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  // Common indent off, so the block reads as the CLI laid it out.
  const indent = Math.min(...kept.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  const text = kept.slice(-MAX_LINES).map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim();
  return text || null;
}

const CODEX_EFFORT_WORDS: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra high': 'xhigh',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
};

/**
 * The model and effort Codex's footer shows now (`GPT-6-Luna medium · ~\dir`):
 * the live session's values, which the transcript only records once a turn
 * runs, and which a launch `-m` sets apart from config.toml.
 */
export function codexFooterModel(screen: string | null): { model: string; effort: string | null } | null {
  const rows = lines(screen).filter((l) => l.trim()).slice(-6).reverse();
  for (const row of rows) {
    const m = /^\s*([A-Za-z0-9][\w.\-]*(?:\s[\w.\-]+)??)\s+(minimal|low|medium|high|extra high|xhigh|max|ultra)?\s*·\s+(?:~[\\/]|[A-Za-z]:[\\/]|\/)/i.exec(row);
    if (m) return { model: m[1].toLowerCase(), effort: m[2] ? CODEX_EFFORT_WORDS[m[2].toLowerCase()] ?? null : null };
  }
  return null;
}
