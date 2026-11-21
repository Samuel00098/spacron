/**
 * Change a running agent CLI's model, effort or permission mode IN PLACE, by
 * driving the CLI's own pickers through its terminal, so the conversation and
 * its context are never restarted.
 *
 * Every screen and key here was captured from the real CLIs in a ConPTY
 * (Codex 0.170, Claude Code 2.1, OpenCode 2.3; see
 * `.spacron/memory/orca-chat-view.md`):
 *
 * - Codex `/model` → "Select Model and Effort" (numbered rows, `›` marks the
 *   highlighted one, Enter selects) → "Select Reasoning Level for <model>",
 *   where `s` applies to this session only (Enter, or a digit, would also save
 *   it as the user's default in config.toml). "More reasoning…" opens
 *   "Advanced Reasoning" (Max, Ultra), same keys.
 * - Codex `/permissions` → "Update Model Permissions" (Ask for approval,
 *   Approve for me, Full Access, Read Only); Full Access asks "Enable full
 *   access?" with "Yes, continue anyway" highlighted.
 * - Claude Code: Shift+Tab cycles auto → manual → accept edits → plan (→
 *   bypass when launched allowing it); the footer names the mode.
 * - OpenCode `/models` → "Select model" with a search box: type, then Enter.
 *
 * The screen is read back after every step, so a picker that looks different
 * from what is expected is backed out of (Esc) instead of being clicked blind.
 */

import { readTerminalScreen } from '$lib/services/terminal-screen';
import { writeToSession } from '$lib/stores/terminal';

const KEY = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', shiftTab: '\x1b[Z' } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function screenOf(sessionId: number): string {
  return readTerminalScreen(sessionId, { maxLines: 60 }) ?? '';
}

/**
 * The bottom of the screen, where a picker or confirmation is drawn now.
 * Codex renders inline, so its scrollback keeps every earlier "Select Model…"
 * and "Model changed to…" line; matching the whole screen made a second switch
 * see the first one's confirmation, stop early and leave the effort picker
 * open on top of the next message.
 */
export function bottomOf(screen: string, rows = 24): string {
  const lines = screen.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-rows).join('\n');
}

function countOf(text: string, pattern: RegExp): number {
  return (text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}

/** Wait for `test` to pass on the bottom of the screen; returns that bottom. */
async function waitForScreen(sessionId: number, test: (text: string) => boolean, timeoutMs = 4000): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = bottomOf(screenOf(sessionId));
    if (test(text)) return text;
    await sleep(120);
  }
  return null;
}

/**
 * One key per PTY write: a multi-character write is read as a paste, and
 * Codex then takes `/model` as prompt text instead of opening its picker.
 */
async function typeKeys(sessionId: number, text: string): Promise<void> {
  for (const key of text) {
    writeToSession(sessionId, key);
    await sleep(16);
  }
}

async function typeCommand(sessionId: number, command: string): Promise<void> {
  await typeKeys(sessionId, command);
  // Codex drops an Enter sent within ~0.3s of the typed command.
  await sleep(600);
  writeToSession(sessionId, KEY.enter);
}

async function backOut(sessionId: number): Promise<void> {
  writeToSession(sessionId, KEY.esc);
  await sleep(150);
  writeToSession(sessionId, KEY.esc);
}

export interface PickerRow {
  /** Position in the list, 0-based. */
  index: number;
  label: string;
  highlighted: boolean;
  current: boolean;
}

/**
 * The numbered rows of a Codex picker below `header`: `› 2. GPT-5.6-Terra  Legacy…`.
 * Wrapped description lines (no number) are skipped.
 */
export function parsePickerRows(screen: string, header: string): PickerRow[] {
  const lines = screen.split('\n');
  // The newest copy of the header: older pickers can still sit in scrollback.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(header)) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const rows: PickerRow[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*([›❯>])?\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!match) {
      if (rows.length && /enter (select|default)|esc back/i.test(line)) break;
      continue;
    }
    // The label is the text up to the first run of 2+ spaces (the description column).
    const text = match[3];
    const label = text.split(/\s{2,}/)[0].trim();
    rows.push({
      index: rows.length,
      label: label.replace(/\s*\((current|default)\)/gi, '').trim(),
      highlighted: Boolean(match[1]),
      current: /\(current\)/i.test(label),
    });
  }
  return rows;
}

/** Comparable form of a model name or id: "GPT-6-Luna" ≡ "gpt-6-luna". */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Move the highlight from its row to `target` with arrow keys. */
async function moveHighlight(sessionId: number, rows: PickerRow[], target: PickerRow): Promise<void> {
  const from = rows.find((row) => row.highlighted)?.index ?? 0;
  const steps = target.index - from;
  const key = steps > 0 ? KEY.down : KEY.up;
  for (let i = 0; i < Math.abs(steps); i += 1) {
    writeToSession(sessionId, key);
    await sleep(60);
  }
  await sleep(120);
}

const CODEX_PERMISSION_LABEL: Record<string, string> = {
  ask: 'ask for approval',
  auto: 'approve for me',
  'full-access': 'full access',
};

/** Codex: permission mode through `/permissions`, confirming Full Access for this session. */
export async function codexSetPermissionInPlace(sessionId: number, mode: string): Promise<string | null> {
  const wanted = CODEX_PERMISSION_LABEL[mode];
  if (!wanted) return 'Codex has no such permission mode.';
  await typeCommand(sessionId, '/permissions');
  const header = 'Update Model Permissions';
  const screen = await waitForScreen(sessionId, (t) => t.includes(header));
  if (!screen) {
    await backOut(sessionId);
    return "Codex didn't open its permissions picker. Check the terminal view.";
  }
  const rows = parsePickerRows(screen, header);
  const row = rows.find((r) => r.label.toLowerCase() === wanted);
  if (!row) {
    await backOut(sessionId);
    return "Codex's permissions picker didn't list that mode.";
  }
  if (row.current) {
    await backOut(sessionId);
    return null;
  }
  await moveHighlight(sessionId, rows, row);
  writeToSession(sessionId, KEY.enter);
  if (mode === 'full-access') {
    const confirm = await waitForScreen(sessionId, (t) => /Enable full access\?/i.test(t), 3000);
    if (confirm) {
      const options = parsePickerRows(confirm, 'Enable full access?');
      const yes = options.find((o) => /^yes/i.test(o.label));
      if (yes) await moveHighlight(sessionId, options, yes);
      writeToSession(sessionId, KEY.enter);
    }
  }
  await sleep(400);
  return null;
}

/** The footer Claude Code shows for each permission mode. */
const CLAUDE_MODE_FOOTER: Record<string, RegExp> = {
  ask: /manual mode on/i,
  'accept-edits': /accept edits on/i,
  auto: /auto mode on/i,
  'full-access': /bypass permissions on/i,
};

/** Which mode the Claude Code footer shows now, if any. */
export function claudeModeFromScreen(screen: string): string | null {
  const tail = screen.split('\n').slice(-8).join('\n');
  for (const [mode, re] of Object.entries(CLAUDE_MODE_FOOTER)) if (re.test(tail)) return mode;
  if (/plan mode on/i.test(tail)) return 'plan';
  return null;
}

/**
 * Claude Code: cycle Shift+Tab until the footer shows the wanted mode. Returns
 * an error when the mode is not in this session's cycle (bypass is only there
 * when Claude was launched allowing it); the caller then falls back.
 */
export async function claudeSetPermissionInPlace(sessionId: number, mode: string): Promise<string | null> {
  const wanted = CLAUDE_MODE_FOOTER[mode];
  if (!wanted) return 'Claude Code has no such permission mode.';
  for (let press = 0; press <= 6; press += 1) {
    if (claudeModeFromScreen(screenOf(sessionId)) === mode) return null;
    if (press === 6) break;
    writeToSession(sessionId, KEY.shiftTab);
    await sleep(350);
  }
  return 'not-in-cycle';
}

/**
 * The search OpenCode's `/models` box matches an id with. Its rows show the
 * models.dev name ("Claude Sonnet 4.5", "GPT-5.1", "DeepSeek V4.1 Flash
 * Free"), so the id's model part is turned into words: the date suffix
 * dropped, version digits joined ("claude-sonnet-4-5-20250929" → "claude sonnet 4.5").
 */
export function opencodeSearchQuery(id: string): string {
  const model = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  const parts = model.replace(/[-_]\d{8}$/, '').split(/[-_/]+/).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(part) && prev && /\d$/.test(prev) && !prev.includes('.')) out[out.length - 1] = `${prev}.${part}`;
    else out.push(part);
  }
  return out.join(' ');
}

/** OpenCode's footer: `Build · GPT-5.1 Abacus` (agent · model provider). */
export function opencodeFooterModel(screen: string): string | null {
  const rows = screen.split('\n').filter((l) => l.trim()).slice(-8).reverse();
  for (const row of rows) {
    const m = /^[\s┃]*(?:Build|Plan|[A-Z][\w-]*)\s+·\s+(.+?)\s*$/.exec(row);
    if (m && !/shift\+tab|ctrl\+p/i.test(m[1])) return m[1];
  }
  return null;
}

/** Which of `models` (OpenCode ids) the footer's "Name Provider" names. */
export function opencodeModelFromFooter(footer: string, ids: string[]): string | null {
  const shown = normalizeName(footer);
  return ids.find((id) => {
    const slash = id.indexOf('/');
    if (slash < 0) return false;
    const provider = normalizeName(id.slice(0, slash));
    return normalizeName(opencodeSearchQuery(id)) + provider === shown;
  }) ?? null;
}
