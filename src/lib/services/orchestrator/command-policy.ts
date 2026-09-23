/**
 * Which orchestrator operations need the user's approval under "Ask before edit".
 *
 * Codex and Claude Code both let read-only commands run without asking and let
 * the user approve a kind of operation once for the whole session. This module
 * is that policy: a strict read-only allowlist (anything that could write,
 * chain into an unknown command, or redirect output falls through to "ask"),
 * plus the key an "Always allow in this conversation" answer is stored under.
 *
 * Pure: the store owns the per-conversation rule sets.
 */

export type CommandSafety = 'read-only' | 'needs-approval';

// Redirection, command substitution and subshells can write or run anything,
// whatever the leading command is. Braces cover PowerShell script blocks
// (`Where-Object { Remove-Item x }`); a single `&` chains commands in cmd.exe.
const UNSAFE_SHELL_RE = /(?:>|`|\$\(|\$\{|<\(|[{}]|(?<!&)&(?!&)|\n|\r)/;
const SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\|)\s*/;

const READ_ONLY_COMMANDS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'rg', 'grep', 'egrep', 'fgrep', 'findstr', 'pwd', 'wc', 'tree',
  'which', 'where', 'echo', 'stat', 'file', 'du', 'df', 'sort', 'cut', 'tr', 'jq', 'basename', 'dirname',
  'realpath', 'whoami', 'uname',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'get-item', 'gi',
  'test-path', 'resolve-path', 'measure-object', 'select-object', 'sort-object', 'format-list', 'format-table',
]);

const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog',
  'cat-file', 'grep', 'reflog', 'whatchanged', 'merge-base', 'rev-list', 'name-rev', 'count-objects',
]);

const VERSION_FLAGS = new Set(['-v', '--version', 'version', '-version']);

function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean).map((token) => token.replace(/^["']|["']$/g, ''));
}

function isReadOnlyGit(rest: string[]): boolean {
  // `-c core.fsmonitor=…` and friends make any git command run a program.
  if (rest.some((token) => token === '-c' || /^--(?:exec-path|ext-diff|output|config-env)/.test(token))) return false;
  const sub = rest.find((token) => !token.startsWith('-'))?.toLowerCase();
  if (!sub) return false;
  const args = rest.slice(rest.indexOf(sub) + 1);
  if (sub === 'branch') return args.every((token) => !/^-[dDmMcCf]$|^--(?:delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(token));
  if (sub === 'remote') return args.length === 0 || (args.length === 1 && args[0] === '-v');
  if (sub === 'stash') return args[0] === 'list' || args[0] === 'show';
  if (sub === 'tag') return args.length === 0 || args.includes('-l') || args.includes('--list');
  return READ_ONLY_GIT.has(sub);
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = tokenize(segment);
  if (!tokens.length) return false;
  const [head, ...rest] = tokens;
  const command = head.toLowerCase().replace(/\.exe$/, '');
  if (rest.length === 1 && VERSION_FLAGS.has(rest[0].toLowerCase())) return true;
  if (command === 'git') return isReadOnlyGit(rest);
  // `--pre` runs a preprocessor program; `-o` makes sort/tree write a file.
  if (command === 'rg') return !rest.some((token) => token === '--pre' || token.startsWith('--pre='));
  if (command === 'sort' || command === 'tree') return !rest.some((token) => token === '-o' || token.startsWith('--output'));
  if (command === 'find') return !rest.some((token) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(token));
  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    return rest[0] === 'ls' || rest[0] === 'list' || rest[0] === 'why' || (rest[0] === 'config' && rest[1] === 'get');
  }
  if (command === 'cargo') return rest[0] === 'tree' || rest[0] === 'metadata';
  return READ_ONLY_COMMANDS.has(command);
}

/** Read-only commands run without asking under "Ask before edit"; everything else asks. */
export function classifyCommand(command: string): CommandSafety {
  const text = command.trim();
  if (!text || UNSAFE_SHELL_RE.test(text)) return 'needs-approval';
  const segments = text.split(SEGMENT_SPLIT_RE).filter(Boolean);
  return segments.length > 0 && segments.every(isReadOnlySegment) ? 'read-only' : 'needs-approval';
}

/**
 * The rule an "Always allow" answer grants. For commands it is the leading
 * words up to the first flag or path ("npm test", "npm run check", "cargo
 * test"), so a later `npm test -- src/a.test.ts` is covered but `npm run
 * deploy` is not. Chained or redirected commands are never generalised: they
 * are allowed only verbatim. File edits share one rule per conversation.
 */
export function approvalRuleKey(tool: string, command?: string): string {
  // One risky app command allowed must not allow every other one.
  if (tool === 'run_app_command') return `app:${(command ?? '').trim()}`;
  if (tool !== 'run_command') return tool === 'write_file' || tool === 'edit_file' ? 'edit' : tool;
  const text = (command ?? '').trim().replace(/\s+/g, ' ');
  if (UNSAFE_SHELL_RE.test(text) || SEGMENT_SPLIT_RE.test(text)) return `cmd=${text}`;
  const words: string[] = [];
  for (const token of tokenize(text)) {
    if (words.length >= 3 || token.startsWith('-') || (words.length > 0 && /[\\/.]/.test(token))) break;
    words.push(token.toLowerCase());
  }
  return `cmd:${words.join(' ')}`;
}

/** Whether a stored "Always allow" rule covers this call. */
export function ruleAllows(rules: ReadonlySet<string>, tool: string, command?: string): boolean {
  return rules.has(approvalRuleKey(tool, command));
}

/** How the approval card names the rule it would store. */
export function describeRule(tool: string, command?: string): string {
  const key = approvalRuleKey(tool, command);
  if (key === 'edit') return 'file edits';
  if (key.startsWith('cmd:')) return `\`${key.slice(4)}\` commands`;
  if (key.startsWith('cmd=')) return `\`${key.slice(4)}\``;
  if (key.startsWith('app:')) return `the \`${key.slice(4)}\` app command`;
  return key.replace(/_/g, ' ');
}
