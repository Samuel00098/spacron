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

async function waitForScreen(sessionId: number, test: (text: string) => boolean, timeoutMs = 4000): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = screenOf(sessionId);
    if (test(text)) return text;
    await sleep(120);
  }
  return null;
}

async function typeCommand(sessionId: number, command: string): Promise<void> {
  writeToSession(sessionId, command);
  await sleep(180);
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
  const start = lines.findIndex((line) => line.includes(header));
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

const CODEX_EFFORT_LABEL: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra high',
  max: 'max',
  ultra: 'ultra',
};

/**
 * Codex: model and/or effort through `/model`, applied for this session only.
 * `model` null keeps the current model; `effort` null keeps the current level.
 */
export async function codexSetModelInPlace(
  sessionId: number,
  target: { model: string | null; modelLabel: string | null; effort: string | null },
): Promise<string | null> {
  await typeCommand(sessionId, '/model');
  const modelScreen = await waitForScreen(sessionId, (t) => t.includes('Select Model and Effort'));
  if (!modelScreen) {
    await backOut(sessionId);
    return "Codex didn't open its model picker. Check the terminal view.";
  }
  const modelRows = parsePickerRows(modelScreen, 'Select Model and Effort');
  const wanted = [target.modelLabel, target.model].filter(Boolean).map((v) => normalizeName(v as string));
  const modelRow = target.model || target.modelLabel
    ? modelRows.find((row) => wanted.includes(normalizeName(row.label)))
    : modelRows.find((row) => row.current);
  if (!modelRow) {
    await backOut(sessionId);
    return `Codex doesn't offer ${target.modelLabel ?? target.model ?? 'that model'} here.`;
  }
  await moveHighlight(sessionId, modelRows, modelRow);
  writeToSession(sessionId, KEY.enter);

  const effortScreen = await waitForScreen(sessionId, (t) => t.includes('Select Reasoning Level') || /Model changed to/i.test(t));
  if (!effortScreen) {
    await backOut(sessionId);
    return "Codex didn't show its reasoning levels. Check the terminal view.";
  }
  // A model without effort levels is applied straight away.
  if (!effortScreen.includes('Select Reasoning Level')) return null;

  let header = 'Select Reasoning Level';
  let rows = parsePickerRows(effortScreen, header);
  const wantedEffort = target.effort ? CODEX_EFFORT_LABEL[target.effort] ?? target.effort : null;
  let effortRow = wantedEffort
    ? rows.find((row) => row.label.toLowerCase() === wantedEffort)
    : rows.find((row) => row.current) ?? rows.find((row) => row.highlighted);
  if (!effortRow && wantedEffort && (wantedEffort === 'max' || wantedEffort === 'ultra')) {
    const more = rows.find((row) => /^more reasoning/i.test(row.label));
    if (more) {
      await moveHighlight(sessionId, rows, more);
      writeToSession(sessionId, KEY.enter);
      const advanced = await waitForScreen(sessionId, (t) => t.includes('Advanced Reasoning'));
      if (advanced) {
        header = 'Advanced Reasoning';
        rows = parsePickerRows(advanced, header);
        effortRow = rows.find((row) => row.label.toLowerCase() === wantedEffort);
      }
    }
  }
  if (!effortRow) {
    await backOut(sessionId);
    return `Codex doesn't offer ${wantedEffort ?? 'that'} reasoning for this model.`;
  }
  await moveHighlight(sessionId, rows, effortRow);
  // `s`: this session only, so the user's Codex default is left alone.
  writeToSession(sessionId, 's');
  const done = await waitForScreen(sessionId, (t) => /Model changed to/i.test(t), 4000);
  return done ? null : "Codex didn't confirm the change. Check the terminal view.";
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

/** OpenCode: model through `/models`' search box. */
export async function opencodeSetModelInPlace(sessionId: number, label: string): Promise<string | null> {
  await typeCommand(sessionId, '/models');
  const screen = await waitForScreen(sessionId, (t) => t.includes('Select model'));
  if (!screen) {
    await backOut(sessionId);
    return "OpenCode didn't open its model picker. Check the terminal view.";
  }
  writeToSession(sessionId, label);
  await sleep(450);
  writeToSession(sessionId, KEY.enter);
  await sleep(400);
  if (screenOf(sessionId).includes('Select model')) {
    await backOut(sessionId);
    return `OpenCode didn't find ${label}.`;
  }
  return null;
}
