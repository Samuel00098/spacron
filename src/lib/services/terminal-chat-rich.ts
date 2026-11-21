/**
 * What the terminal chat view reads out of an agent's tool calls beyond their
 * one-line summary: file changes (diff cards and the per-turn rollup), the
 * agent's to-do list, subagents, pull requests it opened, usage-limit stops,
 * and each CLI's slash commands. Pure functions over `TerminalChatItem`s; the
 * transcript reader (`agent_transcript.rs`) keeps the raw input of these tools
 * in `toolData`.
 */

import type { TerminalChatItem, TranscriptAgent } from './terminal-chat';

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };

export interface FileChange {
  path: string;
  /** `edit` changes part of a file, `write` replaces or creates it, `delete` removes it. */
  kind: 'edit' | 'write' | 'delete';
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Above this many cell comparisons the diff is shown as remove-all/add-all. */
const MAX_DIFF_CELLS = 2_500_000;

/** A line diff (longest common subsequence), with shared lead and tail trimmed first. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'ctx', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ type: 'ctx', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let middle: DiffLine[];
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    middle = [...midA.map((text) => ({ type: 'del' as const, text })), ...midB.map((text) => ({ type: 'add' as const, text }))];
  } else {
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j]: common length of midA[i..] and midB[j..], flattened.
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * (m + 1) + j] = midA[i] === midB[j]
          ? lcs[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ type: 'ctx', text: midA[i] });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
        middle.push({ type: 'del', text: midA[i] });
        i += 1;
      } else {
        middle.push({ type: 'add', text: midB[j] });
        j += 1;
      }
    }
    while (i < n) middle.push({ type: 'del', text: midA[i++] });
    while (j < m) middle.push({ type: 'add', text: midB[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** Keep `context` unchanged lines around each change; longer runs collapse to a gap marker (`null`). */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === 'ctx') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, index) => {
    if (keep[index]) out.push(line);
    else if (out[out.length - 1] !== null) out.push(null);
  });
  if (out[out.length - 1] === null) out.pop();
  if (out[0] === null) out.shift();
  return out;
}

function count(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added += 1;
    else if (line.type === 'del') removed += 1;
  }
  return { added, removed };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pathOf(data: Record<string, unknown>): string | null {
  return str(data.file_path) ?? str(data.filePath) ?? str(data.path) ?? str(data.target_file);
}

/** Codex's `*** Begin Patch` format, one change per file. */
export function parseApplyPatch(patch: string): FileChange[] {
  const changes: FileChange[] = [];
  let current: FileChange | null = null;
  const flush = () => {
    if (current) {
      Object.assign(current, count(current.lines));
      changes.push(current);
    }
    current = null;
  };
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(raw);
    if (header) {
      flush();
      const kind = header[1] === 'Add' ? 'write' : header[1] === 'Delete' ? 'delete' : 'edit';
      current = { path: header[2].trim(), kind, lines: [], added: 0, removed: 0 };
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(raw);
    if (move && current) {
      (current as FileChange).path = move[1].trim();
      continue;
    }
    if (!current || raw.startsWith('***') || raw.startsWith('@@')) continue;
    const c = current as FileChange;
    if (raw.startsWith('+')) c.lines.push({ type: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) c.lines.push({ type: 'del', text: raw.slice(1) });
    else if (raw.startsWith(' ')) c.lines.push({ type: 'ctx', text: raw.slice(1) });
  }
  flush();
  return changes;
}

/** The file changes one tool call made, when it is an edit, write or patch. */
export function fileChangesFor(item: TerminalChatItem): FileChange[] {
  if (item.kind !== 'tool' || item.toolStatus === 'error') return [];
  const data = record(item.toolData);
  if (!data) return [];
  const patch = str(data.patch) ?? str(data.input);
  if (patch && /\*\*\* (Add|Update|Delete) File:/.test(patch)) return parseApplyPatch(patch);
  const path = pathOf(data);
  if (!path) return [];
  const oldText = str(data.old_string) ?? str(data.oldString);
  const newText = str(data.new_string) ?? str(data.newString);
  if (oldText != null && newText != null) {
    const lines = lineDiff(oldText, newText);
    return [{ path, kind: 'edit', lines, ...count(lines) }];
  }
  if (Array.isArray(data.edits)) {
    const lines: DiffLine[] = [];
    for (const edit of data.edits) {
      const e = record(edit);
      if (!e) continue;
      const before = str(e.old_string) ?? str(e.oldString) ?? '';
      const after = str(e.new_string) ?? str(e.newString) ?? '';
      lines.push(...lineDiff(before, after));
    }
    return lines.length ? [{ path, kind: 'edit', lines, ...count(lines) }] : [];
  }
  const content = str(data.content);
  if (content != null) {
    const lines = lineDiff('', content);
    return [{ path, kind: 'write', lines, ...count(lines) }];
  }
  return [];
}

export interface FileRollup {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
}

/** Every file a run of items changed, merged per path, in first-touched order. */
export function rollupChanges(items: TerminalChatItem[]): FileRollup[] {
  const byPath = new Map<string, FileRollup>();
  for (const item of items) {
    for (const change of fileChangesFor(item)) {
      const entry = byPath.get(change.path) ?? { path: change.path, added: 0, removed: 0, created: false, deleted: false };
      entry.added += change.added;
      entry.removed += change.removed;
      if (change.kind === 'write' && !byPath.has(change.path)) entry.created = true;
      if (change.kind === 'delete') entry.deleted = true;
      byPath.set(change.path, entry);
    }
  }
  return [...byPath.values()];
}

// ---------------------------------------------------------------------------
// To-do list
// ---------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoItem { text: string; status: TodoStatus }

function todoStatus(value: unknown): TodoStatus {
  const s = String(value ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'completed' || s === 'done' || s === 'complete') return 'completed';
  if (s === 'in_progress' || s === 'active' || s === 'running') return 'in_progress';
  return 'pending';
}

/** The to-do list a tool call set (Claude's TodoWrite, Codex's update_plan, OpenCode's todowrite). */
export function todosFor(item: TerminalChatItem): TodoItem[] | null {
  if (item.kind !== 'tool') return null;
  const data = record(item.toolData);
  if (!data) return null;
  const list = Array.isArray(data.todos) ? data.todos : Array.isArray(data.plan) ? data.plan : null;
  if (!list) return null;
  return list
    .map((entry) => {
      const e = record(entry);
      if (!e) return null;
      const text = str(e.content) ?? str(e.step) ?? str(e.text) ?? str(e.title) ?? '';
      const status = todoStatus(e.status);
      // Claude shows the present-tense form while a step runs.
      const shown = status === 'in_progress' ? str(e.activeForm) ?? text : text;
      return shown.trim() ? { text: shown.trim(), status } : null;
    })
    .filter((t): t is TodoItem => t != null);
}

/** The latest to-do list in the conversation, or null when none was ever set. */
export function latestTodos(items: TerminalChatItem[]): TodoItem[] | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const todos = todosFor(items[i]);
    if (todos) return todos;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export interface SubagentCall { description: string; type: string | null; prompt: string }

export function subagentFor(item: TerminalChatItem): SubagentCall | null {
  if (item.kind !== 'tool') return null;
  const name = (item.toolName ?? '').toLowerCase();
  const data = record(item.toolData);
  if (!data || (name !== 'task' && name !== 'agent' && !('subagent_type' in data) && !('subagentType' in data))) return null;
  const prompt = str(data.prompt) ?? '';
  return {
    description: str(data.description) ?? (prompt.split('\n')[0] || 'Subagent'),
    type: str(data.subagent_type) ?? str(data.subagentType),
    prompt,
  };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Pull requests a tool call opened (`gh pr create` and the like print the new PR's URL). */
export function openedPullRequests(item: TerminalChatItem): string[] {
  if (item.kind !== 'tool' || item.toolStatus === 'error') return [];
  const input = item.toolInput ?? '';
  const creates = /\bgh\s+pr\s+create\b|create_pull_request|pull_request_create/i.test(`${item.toolName ?? ''} ${input}`);
  if (!creates) return [];
  return [...new Set((item.toolOutput ?? '').match(PR_URL) ?? [])];
}

export interface PullRequestRef { url: string; owner: string; repo: string; number: number }

export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url);
  return m ? { url: m[0], owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

// ---------------------------------------------------------------------------
// Usage limits
// ---------------------------------------------------------------------------

export interface UsageLimit {
  /** When the limit resets, when the message says. */
  resetsAt: number | null;
  text: string;
}

const LIMIT_TEXT = /(usage limit|rate limit|limit reached|hit your (?:usage )?limit|out of (?:extra )?usage|quota exceeded|5-hour limit|weekly limit)/i;

/**
 * A usage-limit stop in an agent message: Claude Code's "…limit reached ∙
 * resets 3pm" / "usage limit reached|<epoch>", Codex's "You've hit your usage
 * limit … try again at 3:05 PM". `now` anchors clock times to a date.
 */
export function usageLimitIn(text: string, now = Date.now()): UsageLimit | null {
  if (!LIMIT_TEXT.test(text) || text.length > 600) return null;
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return { resetsAt: n < 1e12 ? n * 1000 : n, text: text.split('|')[0].trim() };
  }
  const clock = /(?:resets?|try again)(?:\s+at|\s+in)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text);
  if (clock && !/\bin\b/i.test(clock[0])) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? 0);
    const meridiem = clock[3]?.toLowerCase().replace(/\./g, '');
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return { resetsAt: at.getTime(), text: text.trim() };
  }
  const relative = /(?:resets?|try again)\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(text);
  if (relative && (relative[1] || relative[2])) {
    const ms = (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000;
    return { resetsAt: now + ms, text: text.trim() };
  }
  return { resetsAt: null, text: text.trim() };
}

/** The usage-limit stop that ended the conversation so far, if the last agent word is one. */
export function trailingUsageLimit(items: TerminalChatItem[], now = Date.now()): (UsageLimit & { id: string }) | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === 'user') return null;
    if (item.kind === 'assistant' || item.kind === 'notice') {
      const limit = usageLimitIn(item.text, now);
      return limit ? { ...limit, id: item.id } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string;
  description: string;
  /**
   * Sent bare, it opens a TUI screen (a picker, a dialog) the chat cannot show,
   * so the pane switches to its terminal. Every other command stays in the
   * chat, as in Orca, and its reply shows there when the CLI writes one.
   */
  opensInTerminal?: boolean;
}

const cmd = (name: string, description: string, opensInTerminal = false): SlashCommand =>
  (opensInTerminal ? { name: `/${name}`, description, opensInTerminal } : { name: `/${name}`, description });

// Orca's curated catalogs (src/shared/native-chat/input/commands/native-chat-slash-commands.ts):
// CLIs publish no machine-readable list, except Claude Code, whose live list
// (`chat_claude_commands`) replaces this one when it can be read.
const CLAUDE_COMMANDS: SlashCommand[] = [
  cmd('clear', 'Clear conversation history'),
  cmd('compact', 'Summarize and compact the conversation'),
  cmd('init', 'Initialize a CLAUDE.md'),
  cmd('review', 'Review the current changes'),
  cmd('security-review', 'Review pending changes for security issues'),
  cmd('context', 'Show context usage'),
  cmd('cost', 'Show token usage and cost'),
  cmd('help', 'Show available commands', true),
  cmd('rewind', 'Go back to an earlier point', true),
  cmd('resume', 'Resume a previous conversation', true),
  cmd('memory', 'Edit memory files', true),
  cmd('mcp', 'Manage MCP servers', true),
  cmd('agents', 'Manage subagents', true),
  cmd('hooks', 'Manage hooks', true),
  cmd('permissions', 'Manage tool permissions', true),
  cmd('config', 'Open settings', true),
  cmd('status', 'Show version, model and account', true),
  cmd('usage', 'Show plan usage limits', true),
  cmd('doctor', 'Check the installation', true),
  cmd('ide', 'Connect to an IDE', true),
];

const CODEX_COMMANDS: SlashCommand[] = [
  cmd('model', 'Choose the model and reasoning effort', true),
  cmd('ide', 'Include IDE context'),
  cmd('permissions', 'Choose what Codex is allowed to do', true),
  cmd('keymap', 'Remap TUI shortcuts', true),
  cmd('vim', 'Toggle Vim mode'),
  cmd('experimental', 'Toggle experimental features', true),
  cmd('approve', 'Approve one auto-review retry'),
  cmd('memories', 'Configure memory use', true),
  cmd('skills', 'Manage and use skills', true),
  cmd('import', 'Import setup from Claude Code'),
  cmd('hooks', 'View lifecycle hooks'),
  cmd('review', 'Review the current changes', true),
  cmd('rename', 'Rename the current thread', true),
  cmd('new', 'Start a new chat'),
  cmd('archive', 'Archive this session and exit'),
  cmd('delete', 'Delete this session and exit'),
  cmd('resume', 'Resume a saved chat', true),
  cmd('fork', 'Fork the current chat'),
  cmd('app', 'Continue in Codex Desktop'),
  cmd('init', 'Create an AGENTS.md file'),
  cmd('compact', 'Compact the conversation'),
  cmd('plan', 'Switch to Plan mode'),
  cmd('goal', 'Set or view the goal'),
  cmd('agent', 'Switch the active agent thread'),
  cmd('side', 'Start a side conversation'),
  cmd('copy', 'Copy the last response as markdown'),
  cmd('raw', 'Toggle raw scrollback mode'),
  cmd('diff', 'Show the working diff'),
  cmd('mention', 'Mention a file'),
  cmd('status', 'Show session configuration and usage'),
  cmd('usage', 'View account usage'),
  cmd('title', 'Configure the terminal title', true),
  cmd('statusline', 'Configure the status line', true),
  cmd('theme', 'Choose a syntax highlighting theme', true),
  cmd('pets', 'Choose or hide the terminal pet', true),
  cmd('mcp', 'List configured MCP tools'),
  cmd('plugins', 'Browse plugins', true),
  cmd('logout', 'Log out of Codex'),
  cmd('exit', 'Exit Codex'),
  cmd('feedback', 'Send logs to maintainers', true),
  cmd('ps', 'List background terminals'),
  cmd('stop', 'Stop all background terminals'),
  cmd('clear', 'Clear the terminal and start a new chat'),
  cmd('personality', 'Choose a communication style'),
  cmd('subagents', 'Switch the active agent thread', true),
];

const OMP_COMMANDS: SlashCommand[] = [
  cmd('model', 'Open the model selector in Terminal', true),
  cmd('switch', 'Open the temporary model selector in Terminal', true),
  cmd('plan', 'Toggle plan mode'),
  cmd('compact', 'Compact conversation context'),
  cmd('clear', 'Clear context while keeping the session'),
  cmd('new', 'Start a new session'),
  cmd('resume', 'Resume a session; without arguments, choose in Terminal', true),
  cmd('fork', 'Fork from a previous message in Terminal', true),
  cmd('branch', 'Rewind to a previous message in Terminal', true),
  cmd('tree', 'Browse the session tree in Terminal', true),
  cmd('session', 'Show session information and controls'),
  cmd('rename', 'Rename the session'),
  cmd('context', 'Show estimated context usage'),
  cmd('usage', 'Show provider usage and limits'),
  cmd('fast', 'Toggle priority service tier'),
  cmd('tools', 'Show tools visible to the agent'),
  cmd('jobs', 'Show background jobs'),
  cmd('git', 'Open the Git viewer in Terminal', true),
  cmd('export', 'Export the session to HTML'),
  cmd('settings', 'Open settings in Terminal', true),
  cmd('extensions', 'Open the extension dashboard in Terminal', true),
  cmd('hotkeys', 'Show keyboard shortcuts in Terminal', true),
];

const OPENCODE_COMMANDS: SlashCommand[] = [
  cmd('clear', 'Clear the conversation'),
  cmd('compact', 'Compact the conversation'),
  cmd('undo', 'Undo the last message'),
  cmd('redo', 'Redo an undone message'),
  cmd('share', 'Share this conversation'),
  cmd('init', 'Create an AGENTS.md file'),
  cmd('models', 'Open the model selector in Terminal', true),
  cmd('agents', 'Choose the agent in Terminal', true),
  cmd('sessions', 'Switch sessions in Terminal', true),
  cmd('skills', 'Browse skills in Terminal', true),
  cmd('mcps', 'Manage MCP servers in Terminal', true),
  cmd('connect', 'Connect a provider in Terminal', true),
  cmd('status', 'View status in Terminal', true),
  cmd('themes', 'Choose a theme in Terminal', true),
  cmd('diff', 'Open the diff viewer in Terminal', true),
  cmd('editor', 'Open your editor in Terminal', true),
  cmd('debug', 'View debug info in Terminal', true),
  cmd('help', 'Show help in Terminal', true),
  cmd('fork', 'Fork the session in Terminal', true),
  cmd('rename', 'Rename the session in Terminal', true),
  cmd('timeline', 'Browse the session timeline in Terminal', true),
  cmd('export', 'Export the session in Terminal', true),
];

/** Orca's fallback so the `/` menu is never empty for a known agent. */
const COMMON_COMMANDS: SlashCommand[] = [
  cmd('clear', 'Clear the conversation'),
  cmd('compact', 'Compact the conversation'),
  cmd('help', 'Show available commands', true),
];

export function slashCommandsFor(agent: TranscriptAgent): SlashCommand[] {
  switch (agent) {
    case 'claude':
    case 'openclaude': return CLAUDE_COMMANDS;
    case 'codex': return CODEX_COMMANDS;
    case 'omp': return OMP_COMMANDS;
    case 'opencode': return OPENCODE_COMMANDS;
    // Orca keeps Grok skills-only until its command catalog is verified.
    case 'grok': return [];
    default: return COMMON_COMMANDS;
  }
}

/** A bounded, readable transcript for Copy Context; image bytes and reasoning are excluded. */
export function terminalChatContextText(
  items: TerminalChatItem[],
  agentName: string,
  cwd: string | null,
): string {
  const rows = items
    .filter((item) => item.kind !== 'reasoning')
    .slice(-80)
    .map((item) => {
      const label = item.kind === 'user'
        ? 'You'
        : item.kind === 'tool'
          ? `Tool${item.toolName ? `: ${item.toolName}` : ''}`
          : item.kind === 'command'
            ? `${agentName} command`
            : item.kind === 'command-output'
              ? `${agentName} command output`
              : item.kind === 'notice'
                ? 'Note'
                : agentName;
      const body = item.kind === 'tool' && item.toolOutput
        ? `${item.text}\n${item.toolOutput}`
        : item.text;
      const attachment = item.images?.length ? `\n[${item.images.length} image attachment${item.images.length === 1 ? '' : 's'}]` : '';
      const clipped = body.length > 4000 ? `${body.slice(0, 4000)}\n[This message was shortened]` : body;
      return `${label}:\n${clipped}${attachment}`;
    });
  const allRows = items.filter((item) => item.kind !== 'reasoning').length;
  const omitted = Math.max(0, allRows - rows.length);
  const header = [
    `Conversation with ${agentName}`,
    cwd ? `Workspace: ${cwd}` : null,
    omitted ? `${omitted} older transcript entries omitted.` : null,
    '',
  ].filter((line): line is string => line !== null).join('\n');
  const body = rows.join('\n\n');
  const budget = 48_000;
  if (header.length + body.length <= budget) return `${header}${body}`;
  return `${header}Earlier context shortened to fit.\n\n${body.slice(-(budget - header.length - 40))}`;
}

/**
 * Whether a typed command opens a TUI screen in `agent`'s CLI. Only the bare
 * command does: `/resume <id>` or `/review main` run without a picker.
 */
export function opensInTerminal(agent: TranscriptAgent, command: string, catalog: SlashCommand[] = slashCommandsFor(agent)): boolean {
  const text = command.trim();
  return catalog.some((entry) => entry.opensInTerminal === true && text === entry.name);
}

/**
 * Commands whose TUI screen only shows information (a status card, a help
 * page). The chat reads that screen, shows it in the conversation, and closes
 * it with Esc so the CLI is back at its prompt; pickers are left open.
 */
const INFO_SCREENS: Partial<Record<TranscriptAgent, string[]>> = {
  claude: ['/status', '/usage', '/help', '/cost', '/context', '/doctor'],
  openclaude: ['/status', '/usage', '/help', '/cost', '/doctor'],
  opencode: ['/status', '/help', '/debug'],
  omp: ['/hotkeys'],
};

export function closesAfterReading(agent: TranscriptAgent, command: string): boolean {
  return (INFO_SCREENS[agent] ?? []).includes(command.trim());
}

/** The slash-command query being typed: the draft is `/word` with no space yet. */
export function slashQuery(draft: string): string | null {
  const m = /^\/([\w:-]*)$/.exec(draft);
  return m ? m[1].toLowerCase() : null;
}

/** The `@` mention being typed at the caret: `@` at a word start, then no space. */
export function mentionAt(draft: string, caret: number): { start: number; query: string } | null {
  const before = draft.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

/** Launch args that fork a provider session into a new one, for CLIs that can. */
export function forkArgs(agent: TranscriptAgent, providerSessionId: string): string | null {
  switch (agent) {
    case 'claude':
    case 'openclaude': return `--resume ${providerSessionId} --fork-session`;
    case 'codex': return `fork ${providerSessionId}`;
    case 'grok': return `-r ${providerSessionId} --fork-session`;
    default: return null;
  }
}

/** How to go back to an earlier point inside each CLI. */
export function rewindCommand(agent: TranscriptAgent): string | null {
  switch (agent) {
    case 'claude':
    case 'openclaude': return '/rewind';
    case 'opencode': return '/undo';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** A transcript time (ISO string or epoch ms as text) as epoch ms. */
export function itemTime(time: string | null | undefined): number | null {
  if (!time) return null;
  if (/^\d{10,13}$/.test(time)) {
    const n = Number(time);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? null : ms;
}

export function formatClock(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

// ---------------------------------------------------------------------------
// Tool lines and runs (Orca's vocabulary: a glyph, a verb, a target)
// ---------------------------------------------------------------------------

export type ToolCategory =
  | 'read'
  | 'search'
  | 'listFiles'
  | 'command'
  | 'fileChange'
  | 'webSearch'
  | 'mcp'
  | 'subagent'
  | 'todoList'
  | 'other';

const EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'notebookedit', 'apply_patch', 'str_replace_based_edit_tool', 'str_replace_editor', 'create_file', 'edit_file', 'write_file', 'search_replace', 'patch', 'replace', 'diff']);
const READ_TOOLS = new Set(['read', 'read_file', 'view', 'view_image', 'notebookread', 'cat', 'open_file', 'read_many_files']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'find', 'codebase_search', 'grep_search', 'file_search', 'search_files', 'find_files', 'ripgrep']);
const LIST_TOOLS = new Set(['ls', 'list', 'list_dir', 'list_directory', 'list_files', 'tree']);
const WEB_TOOLS = new Set(['webfetch', 'web_fetch', 'websearch', 'web_search', 'fetch', 'web search', 'google_web_search', 'browse']);
const SUBAGENT_TOOLS = new Set(['task', 'agent', 'subagent', 'spawn_agent', 'dispatch_agent']);
const PLAN_TOOLS = new Set(['todowrite', 'todoread', 'update_plan', 'todo_write', 'write_todos']);
const COMMAND_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'local_shell_call', 'exec', 'run_terminal_cmd', 'powershell', 'terminal', 'execute_command', 'run_shell_command', 'run_command', 'command', 'bashoutput', 'shell_command']);

/** What a command line does, the way Codex classifies its own shell calls. */
function commandCategory(command: string): ToolCategory {
  const words = command.trim().replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '').split(/\s+/);
  const first = (words[0] ?? '').toLowerCase().replace(/^.*[\\/]/, '');
  if (['cat', 'head', 'tail', 'less', 'more', 'nl', 'get-content', 'type', 'bat'].includes(first)) return 'read';
  if (first === 'sed' && words[1] === '-n') return 'read';
  if (['rg', 'grep', 'egrep', 'findstr', 'select-string', 'ag', 'ack'].includes(first) || (first === 'git' && words[1] === 'grep')) return 'search';
  if (['ls', 'dir', 'tree', 'get-childitem', 'gci', 'find', 'fd'].includes(first)) return 'listFiles';
  return 'command';
}

export function toolCategory(item: TerminalChatItem): ToolCategory {
  const name = (item.toolName ?? '').trim().toLowerCase();
  if (name.startsWith('mcp__') || name.startsWith('mcp_')) return 'mcp';
  if (subagentFor(item)) return 'subagent';
  if (todosFor(item)) return 'todoList';
  if (fileChangesFor(item).length || EDIT_TOOLS.has(name)) return 'fileChange';
  if (COMMAND_TOOLS.has(name)) return commandCategory(item.toolInput ?? '');
  if (READ_TOOLS.has(name)) return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (LIST_TOOLS.has(name)) return 'listFiles';
  if (WEB_TOOLS.has(name)) return 'webSearch';
  if (SUBAGENT_TOOLS.has(name)) return 'subagent';
  if (PLAN_TOOLS.has(name)) return 'todoList';
  return 'other';
}

export type ToolGlyph = 'eye' | 'search' | 'folder' | 'terminal' | 'pencil' | 'globe' | 'plug' | 'bot' | 'list-checks' | 'wrench' | 'brain';

export const TOOL_GLYPHS: Record<ToolCategory, ToolGlyph> = {
  read: 'eye',
  search: 'search',
  listFiles: 'folder',
  command: 'terminal',
  fileChange: 'pencil',
  webSearch: 'globe',
  mcp: 'plug',
  subagent: 'bot',
  todoList: 'list-checks',
  other: 'wrench',
};

type Verbs = { live: string; done: string; failed: string };
const VERBS: Record<ToolCategory, Verbs> = {
  read: { live: 'Reading', done: 'Read', failed: 'Tried to read' },
  search: { live: 'Searching', done: 'Searched', failed: 'Tried to search' },
  listFiles: { live: 'Listing', done: 'Listed', failed: 'Tried to list' },
  command: { live: 'Running', done: 'Ran', failed: 'Ran' },
  fileChange: { live: 'Editing', done: 'Edited', failed: 'Tried to edit' },
  webSearch: { live: 'Fetching', done: 'Fetched', failed: 'Tried to fetch' },
  mcp: { live: 'Using', done: 'Used', failed: 'Tried' },
  subagent: { live: 'Subagent', done: 'Subagent', failed: 'Subagent' },
  todoList: { live: 'Updating the plan', done: 'Updated the plan', failed: 'Tried to update the plan' },
  other: { live: 'Using', done: 'Used', failed: 'Tried' },
};

export interface ToolLine {
  category: ToolCategory;
  verb: string;
  /** The thing acted on: a file, a command, a pattern, a URL. */
  target: string;
  /** Shown muted after the target (a file's folder, an MCP server). */
  context: string | null;
  /** Targets that are code (commands, patterns) render in the code font. */
  code: boolean;
  added: number;
  removed: number;
  failed: boolean;
  running: boolean;
}

function splitPath(path: string): { name: string; dir: string | null } {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const at = clean.lastIndexOf('/');
  return at < 0 ? { name: clean, dir: null } : { name: clean.slice(at + 1), dir: clean.slice(0, at) };
}

/** One tool call as Orca's row: "Read  App.tsx  src/lib", "Ran  npm test", "Edited  a.rs  +3 −1". */
export function toolLine(item: TerminalChatItem, live: boolean): ToolLine {
  const category = toolCategory(item);
  const running = live && (item.toolStatus ?? 'running') === 'running';
  const failed = item.toolStatus === 'error';
  const verbs = VERBS[category];
  const input = (item.toolInput ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  const base = { category, failed, running, added: 0, removed: 0, context: null as string | null, code: false };
  let verb = running ? verbs.live : failed ? verbs.failed : verbs.done;
  switch (category) {
    case 'fileChange': {
      const changes = fileChangesFor(item);
      const first = changes[0];
      const path = first?.path ?? input;
      const { name, dir } = splitPath(path);
      if (!running && !failed && first) {
        if (changes.length === 1 && first.kind === 'write' && first.removed === 0) verb = 'Wrote';
        if (first.kind === 'delete') verb = 'Deleted';
      }
      const added = changes.reduce((n, c) => n + c.added, 0);
      const removed = changes.reduce((n, c) => n + c.removed, 0);
      const target = changes.length > 1 ? `${changes.length} files` : name;
      return { ...base, verb, target, context: changes.length > 1 ? null : dir, added, removed };
    }
    case 'read':
    case 'listFiles': {
      const isCommand = COMMAND_TOOLS.has((item.toolName ?? '').toLowerCase());
      if (isCommand) return { ...base, verb, target: input, code: true };
      const { name, dir } = splitPath(input);
      return { ...base, verb, target: name || input, context: dir };
    }
    case 'search':
    case 'command':
      return { ...base, verb, target: input, code: true };
    case 'webSearch': {
      const isUrl = /^https?:\/\//.test(input);
      if (!isUrl) verb = running ? 'Searching the web' : failed ? 'Tried to search the web' : 'Searched the web';
      let target = input;
      if (isUrl) {
        try {
          const url = new URL(input);
          target = url.host + url.pathname.replace(/\/$/, '');
        } catch {
          // keep the raw url
        }
      }
      return { ...base, verb, target };
    }
    case 'mcp': {
      const parts = (item.toolName ?? '').split('__').filter(Boolean);
      const tool = parts.length >= 3 ? parts.slice(2).join('__') : parts[parts.length - 1] ?? 'tool';
      const server = parts.length >= 3 ? parts[1] : null;
      return { ...base, verb, target: tool.replace(/_/g, ' '), context: server };
    }
    case 'subagent': {
      const call = subagentFor(item);
      return { ...base, verb: call?.type ?? verb, target: call?.description ?? input };
    }
    case 'todoList': {
      const todos = todosFor(item) ?? [];
      const done = todos.filter((t) => t.status === 'completed').length;
      return { ...base, verb, target: todos.length ? `${done} of ${todos.length} done` : '' };
    }
    default:
      return { ...base, verb: item.toolName ?? 'Tool', target: input };
  }
}

const RUN_COPY: Record<ToolCategory, { one: string; many: string; liveOne: string; liveMany: string }> = {
  read: { one: 'Read 1 file', many: 'Read {n} files', liveOne: 'Reading 1 file', liveMany: 'Reading {n} files' },
  search: { one: 'Searched 1 time', many: 'Searched {n} times', liveOne: 'Searching 1 time', liveMany: 'Searching {n} times' },
  listFiles: { one: 'Listed 1 directory', many: 'Listed {n} directories', liveOne: 'Listing 1 directory', liveMany: 'Listing {n} directories' },
  command: { one: 'Ran 1 command', many: 'Ran {n} commands', liveOne: 'Running 1 command', liveMany: 'Running {n} commands' },
  fileChange: { one: 'Edited 1 file', many: 'Edited {n} files', liveOne: 'Editing 1 file', liveMany: 'Editing {n} files' },
  webSearch: { one: 'Searched the web 1 time', many: 'Searched the web {n} times', liveOne: 'Searching the web 1 time', liveMany: 'Searching the web {n} times' },
  mcp: { one: 'Used 1 integration', many: 'Used {n} integrations', liveOne: 'Using 1 integration', liveMany: 'Using {n} integrations' },
  subagent: { one: 'Ran 1 agent', many: 'Ran {n} agents', liveOne: 'Running 1 agent', liveMany: 'Running {n} agents' },
  todoList: { one: 'Updated the plan', many: 'Updated the plan {n} times', liveOne: 'Updating the plan', liveMany: 'Updating the plan {n} times' },
  other: { one: 'Used 1 tool', many: 'Used {n} tools', liveOne: 'Using 1 tool', liveMany: 'Using {n} tools' },
};

/** The categories a run used, in first-use order (edits count files, not calls). */
export function runClauses(tools: TerminalChatItem[]): { category: ToolCategory; count: number }[] {
  const counts = new Map<ToolCategory, number>();
  const editedFiles = new Set<string>();
  for (const item of tools) {
    const category = toolCategory(item);
    if (category === 'fileChange') {
      const paths = fileChangesFor(item).map((c) => c.path);
      if (!paths.length) paths.push(item.toolInput ?? item.id);
      for (const p of paths) editedFiles.add(p);
      counts.set(category, editedFiles.size);
    } else {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts].map(([category, count]) => ({ category, count }));
}

/** "Read 3 files, searched 2 times, and ran 1 command": Orca's run header. */
export function runSentence(tools: TerminalChatItem[], live: boolean): string | null {
  const clauses = runClauses(tools).map(({ category, count }, index) => {
    const copy = RUN_COPY[category];
    const text = (live ? (count === 1 ? copy.liveOne : copy.liveMany) : count === 1 ? copy.one : copy.many).replace('{n}', String(count));
    return index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
  });
  if (!clauses.length) return null;
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}

/** The glyph for a whole run: the shared category's, or the wrench when mixed. */
export function runGlyph(tools: TerminalChatItem[]): ToolGlyph {
  const categories = new Set(tools.map(toolCategory));
  return categories.size === 1 ? TOOL_GLYPHS[[...categories][0]] : 'wrench';
}
