/**
 * What an agent's pane actually SHOWS, read from its xterm buffer.
 *
 * The raw PTY stream is the wrong source for anything a person reads: a
 * full-screen TUI (Codex, Claude Code) draws by moving the cursor and
 * repainting the same rows, so stripping escape codes from the byte stream
 * leaves every intermediate frame glued together — the prompt echoed five
 * times, spinner ticks, "Working (11s • esc to interrupt)" and the composer
 * box, all on one line. xterm has already applied every cursor move, so its
 * buffer holds the finished screen, row by row.
 *
 * Panes register their terminal here while mounted (agent panes stay mounted
 * across project switches, see agent-pane-survival). Callers fall back to the
 * stripped byte stream when no pane is registered.
 */
import type { IMarker, Terminal } from '@xterm/xterm';

const screens = new Map<number, Terminal>();

/** Register a pane's terminal; returns the matching unregister. */
export function registerTerminalScreen(sessionId: number, term: Terminal): () => void {
  screens.set(sessionId, term);
  return () => {
    if (screens.get(sessionId) === term) screens.delete(sessionId);
  };
}

export function hasTerminalScreen(sessionId: number): boolean {
  return screens.has(sessionId);
}

/**
 * A position to read from later ("everything the agent printed after I sent
 * this prompt"). Backed by an xterm marker, which follows its line as the
 * scrollback is trimmed. Only meaningful on the normal buffer: a TUI on the
 * alternate screen repaints one viewport, which is read whole.
 */
export type ScreenMark = { marker: IMarker };

export function markTerminalScreen(sessionId: number): ScreenMark | null {
  const term = screens.get(sessionId);
  if (!term || term.buffer.active.type !== 'normal') return null;
  const marker = term.registerMarker(0);
  return marker ? { marker } : null;
}

/**
 * The rendered text of a session's pane, wrapped rows rejoined, or null when
 * no pane is mounted for it. With `from`, reading starts at that mark (when it
 * is still on the active buffer); `maxLines` keeps only the newest rows.
 */
export function readTerminalScreen(
  sessionId: number,
  opts: { from?: ScreenMark | null; maxLines?: number } = {},
): string | null {
  const term = screens.get(sessionId);
  if (!term) return null;
  const buffer = term.buffer.active;
  let start = 0;
  const marker = opts.from?.marker;
  if (buffer.type === 'normal' && marker && !marker.isDisposed && marker.line >= 0) start = marker.line;
  if (opts.maxLines && buffer.length - start > opts.maxLines) start = buffer.length - opts.maxLines;

  const rows: string[] = [];
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && rows.length) rows[rows.length - 1] += text;
    else rows.push(text);
  }
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  return rows.join('\n');
}

// ─── Agent TUI chrome ─────────────────────────────────────────────────────────

/**
 * Box-drawing frame characters: the composer, header cards and rules. Not
 * `└ ├ ⎿`: Codex and Claude hang a tool's output off those, and it is content.
 */
const FRAME_START = /^[\s]*[╭╮╰╯│┃┌┐┘┤─━═╔╗╚╝║▌▐]/;
const ONLY_FRAME = /^[\s╭╮╰╯│┃┌┐└┘├┤┬┴┼─━═╔╗╚╝║·•.…⋯▔▁]*$/;

/**
 * Status lines the agent CLIs repaint around their output. Matched per line,
 * so a sentence in the agent's actual reply is never cut in half.
 */
const CHROME_LINES: RegExp[] = [
  /esc to interrupt/i,
  /\?\s*for shortcuts/i,
  /\/model to change/i,
  /^\s*(?:model|directory|permissions|approval|sandbox|workdir|account):\s/i,
  /background terminals? running/i,
  /\/ps to view|\/stop to close/i,
  /back to bottom/i,
  /^\s*[•·]?\s*new activity\b/i,
  /enter\/esc latest/i,
  /ask codex to do anything/i,
  />_\s*openai codex/i,
  /context left until auto-compact|context left\b/i,
  /bypass permissions on|shift\+tab to cycle|auto-accept edits on|plan mode on/i,
  /^\s*[⏵⏸]{1,2}\s/,
  /^\s*[✻✽✶✳✢·*]\s*\w+…\s*\(/, // Claude's "✻ Thinking… (12s · esc…)" spinner row
  /^\s*tip:/i,
];

function isChrome(line: string): boolean {
  if (!line.trim()) return false;
  if (FRAME_START.test(line) || ONLY_FRAME.test(line)) return true;
  return CHROME_LINES.some((pattern) => pattern.test(line));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A composer/prompt echo row: `› text`, `> text`, `❯ text`. */
const PROMPT_ROW = /^\s*[›>❯]\s+(.*)$/;

/**
 * Turn a rendered agent screen into the text a person wants to read: the
 * CLI's frames, spinners and status bars dropped, and — when the prompt that
 * started this turn is known — only what came after its echo.
 */
export function cleanAgentScreen(screen: string, prompt?: string | null): string {
  let lines = screen.replace(/\r/g, '').split('\n');

  const wanted = prompt ? normalize(prompt) : '';
  if (wanted.length >= 4) {
    // The LAST echo of the prompt: the composer row above it may repeat it.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const echo = PROMPT_ROW.exec(lines[index]);
      const shown = echo ? normalize(echo[1]).slice(0, 40) : '';
      if (shown.length < 4 || !wanted.startsWith(shown)) continue;
      // A long prompt wraps onto more rows; skip those too.
      let next = index + 1;
      while (next < lines.length && lines[next].trim() && wanted.includes(normalize(lines[next]))) next += 1;
      lines = lines.slice(next);
      break;
    }
  }

  const kept: string[] = [];
  for (const line of lines) {
    if (isChrome(line)) continue;
    // A leftover empty composer row (`›` on its own) is chrome too.
    if (/^\s*[›>❯]\s*$/.test(line)) continue;
    if (!line.trim() && (!kept.length || !kept[kept.length - 1].trim())) continue;
    kept.push(line.replace(/\s+$/, ''));
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

/** The cleaned tail of a session's pane, or null when no pane is mounted. */
export function readAgentScreen(
  sessionId: number,
  opts: { from?: ScreenMark | null; prompt?: string | null; maxLines?: number } = {},
): string | null {
  const screen = readTerminalScreen(sessionId, { from: opts.from, maxLines: opts.maxLines });
  return screen == null ? null : cleanAgentScreen(screen, opts.prompt);
}
