/**
 * Questions and approvals an agent CLI is waiting on, read from its terminal so
 * the chat view can answer them with buttons and a text box (Orca's ask cards).
 *
 * Every TUI here draws a prompt the same way, captured from the real CLIs:
 *
 *    ☐ Color                                   ← optional header chip
 *   Which color do you prefer?                 ← the question
 *   ❯ 1. Red                                   ← highlighted option
 *        Red as your preferred color.          ← its description
 *     2. Green
 *     4. Type something.                       ← free-text row
 *   Enter to select · ↑/↓ to navigate · Esc to cancel
 *
 * (Claude Code AskUserQuestion and permission prompts; Codex approvals and
 * pickers use `›` and "enter select · esc back".) Answering: arrows move the
 * highlight, Enter chooses; on a "Type something." row the answer is typed in
 * place and then Enter, which Claude records as "→ <answer>".
 */

import { readTerminalScreen } from '$lib/services/terminal-screen';
import { writeToSession } from '$lib/stores/terminal';

export interface PromptOption {
  /** Position in the list, 0-based. */
  index: number;
  /** The number the CLI shows (1-based), used for the keyboard shortcut. */
  number: number;
  label: string;
  description: string | null;
  highlighted: boolean;
  /** "Type something." style row: the answer is typed into it. */
  freeText: boolean;
}

export interface ScreenPrompt {
  header: string | null;
  question: string;
  options: PromptOption[];
  /** A checkbox (multi-select) prompt: answered in the terminal for now. */
  multiSelect: boolean;
}

const OPTION_ROW = /^(\s*)([❯›>▶])?\s*(\d{1,2})[.)]\s+(.+?)\s*$/;
const FOOTER = /(enter to (select|confirm)|↑\/↓ to navigate|enter select|esc (to cancel|back)|press enter|esc to cancel)/i;
const SEPARATOR = /^[\s─━═╌┄·•.…_\-]*$/;
const FREE_TEXT = /^(type something|type your (own )?answer|other\b|something else)/i;

/** Box-drawing and checkbox decoration around a line's text. */
function cleanLine(line: string): string {
  return line.replace(/^[\s│┃|╭╰]+|[\s│┃|╮╯]+$/g, '').trim();
}

function optionMatch(line: string): RegExpExecArray | null {
  return OPTION_ROW.exec(line.replace(/^\s*[│┃|]\s?/, ''));
}

/** The prompt the bottom of `screen` is waiting on, or null when there is none. */
export function parseScreenPrompt(screen: string): ScreenPrompt | null {
  const lines = screen.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const bottom = lines.slice(-40);
  // A live prompt ends with its key hint near the bottom of the screen.
  let footerAt = -1;
  for (let i = bottom.length - 1; i >= Math.max(0, bottom.length - 6); i -= 1) {
    if (FOOTER.test(bottom[i])) {
      footerAt = i;
      break;
    }
  }
  if (footerAt < 0) return null;

  // The option block: option rows, their indented descriptions and separators,
  // running up from the footer to the first line that is none of those.
  let firstOptionAt = -1;
  for (let i = footerAt - 1; i >= 0; i -= 1) {
    const line = bottom[i];
    const text = cleanLine(line);
    if (optionMatch(line)) {
      firstOptionAt = i;
      continue;
    }
    if (!text || SEPARATOR.test(text) || /^\s{3,}/.test(line)) continue;
    break;
  }
  if (firstOptionAt < 0) return null;

  const options: PromptOption[] = [];
  for (let i = firstOptionAt; i < footerAt; i += 1) {
    const line = bottom[i];
    const match = optionMatch(line);
    if (match) {
      // Codex puts the description on the same line, after a run of spaces.
      const [label, ...inline] = match[4].split(/\s{2,}/).map((part) => part.trim());
      options.push({
        index: options.length,
        number: Number(match[3]),
        label,
        description: inline.filter(Boolean).join(' ') || null,
        highlighted: Boolean(match[2]),
        freeText: FREE_TEXT.test(label),
      });
      continue;
    }
    const text = cleanLine(line);
    const last = options[options.length - 1];
    if (last && text && !SEPARATOR.test(text) && /^\s{3,}/.test(line)) {
      last.description = last.description ? `${last.description} ${text}` : text;
    }
  }
  if (options.length < 2 || !options.some((o) => o.highlighted)) return null;

  // The question: the nearest text above the options; a checkbox line above it is the header chip.
  let question = '';
  let header: string | null = null;
  for (let i = firstOptionAt - 1; i >= Math.max(0, firstOptionAt - 6); i -= 1) {
    const text = cleanLine(bottom[i]);
    if (!text || SEPARATOR.test(text)) {
      if (question) break;
      continue;
    }
    if (!question) {
      question = text;
      continue;
    }
    const chip = /^[☐☑✓✔□■◻◼]\s*(.+)$/.exec(text);
    if (chip) header = chip[1].trim();
    break;
  }
  if (!question) return null;
  const multiSelect = options.some((o) => /^\[[ x✓]\]/i.test(o.label));
  return { header, question, options, multiSelect };
}

/** A stable identity for a prompt, to tell a new question from a repaint of the same one. */
export function promptKey(prompt: ScreenPrompt): string {
  return `${prompt.question}\u0000${prompt.options.map((o) => o.label).join('\u0001')}`;
}

export function readScreenPrompt(sessionId: number): ScreenPrompt | null {
  const screen = readTerminalScreen(sessionId, { maxLines: 60 });
  return screen ? parseScreenPrompt(screen) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Answer the prompt on screen: move to the option from wherever the highlight
 * is now, then Enter. On a free-text row the answer is typed in place first.
 * Re-reads the screen so a prompt that changed underneath is not answered blind.
 */
export async function answerScreenPrompt(sessionId: number, optionIndex: number, text?: string): Promise<string | null> {
  const prompt = readScreenPrompt(sessionId);
  if (!prompt) return 'The question is no longer open in the terminal.';
  const target = prompt.options[optionIndex];
  if (!target) return 'That option is no longer offered.';
  const from = prompt.options.find((o) => o.highlighted)?.index ?? 0;
  const steps = target.index - from;
  for (let i = 0; i < Math.abs(steps); i += 1) {
    writeToSession(sessionId, steps > 0 ? '\x1b[B' : '\x1b[A');
    await sleep(55);
  }
  await sleep(140);
  if (target.freeText && text?.trim()) {
    writeToSession(sessionId, text.replace(/[\r\n]+/g, ' ').trim());
    await sleep(220);
  }
  writeToSession(sessionId, '\r');
  return null;
}

/** Leave the prompt (Esc), as its footer offers. */
export function dismissScreenPrompt(sessionId: number): void {
  writeToSession(sessionId, '\x1b');
}
