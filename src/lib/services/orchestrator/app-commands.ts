/**
 * The brain's door into the command palette. Every Tools-menu item, layout
 * action, settings section and palette default is registered there (see
 * `stores/commandpalette.ts` and AppShell's palette bridge), so letting the
 * brain find and run palette commands gives it most of the app without a
 * dedicated action per feature: a new palette command is usable at once.
 *
 * Pure on purpose: callers pass the current command list, so this stays
 * testable without the UI.
 */

export interface AppCommand {
  id: string;
  name: string;
  category: string;
  action: () => void | Promise<void>;
}

const MAX_LISTED = 40;

// Words that make a command worth a click before it runs: anything that
// deletes, resets, stops, closes many things or leaves the app. Matched on the
// id and the visible name, so commands added later are covered too. When in
// doubt it asks: a card costs a click, a wrong reset costs work.
const RISKY_COMMAND_RE =
  /\b(?:delete|remove|reset|clear|wipe|erase|discard|purge|kill|stop|quit|exit|close|uninstall|restart|reload|shut ?down|log ?out|sign ?out|revoke|overwrite|factory|force)\b/i;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Commands matching every word of `query` (in id, name or category); all when empty. */
export function listAppCommands(all: readonly AppCommand[], query = ''): AppCommand[] {
  const wanted = words(query);
  return all.filter((command) => {
    if (!wanted.length) return true;
    const haystack = `${command.id} ${command.name} ${command.category}`.toLowerCase();
    return wanted.every((word) => haystack.includes(word));
  });
}

/** The listing the brain reads back from `list_app_commands`, capped. */
export function formatAppCommandList(matches: readonly AppCommand[], query: string): string {
  if (!matches.length) return `No app commands match "${query}". Call list_app_commands with a shorter query, or none to see them all.`;
  const shown = matches.slice(0, MAX_LISTED);
  const lines = shown.map((command) => `- ${command.id} | ${command.name} | ${command.category}${isRiskyAppCommand(command) ? ' | asks the user first' : ''}`);
  const more = matches.length > shown.length ? `\n${matches.length - shown.length} more; narrow the query to see them.` : '';
  return `${shown.length} app command(s) (id | name | category):\n${lines.join('\n')}${more}`;
}

/** Resolve the brain's reference: an exact id first, then an exact name. */
export function findAppCommand(all: readonly AppCommand[], ref: string): AppCommand | null {
  const wanted = ref.trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  return all.find((command) => command.id === wanted)
    ?? all.find((command) => command.id.toLowerCase() === lower)
    ?? all.find((command) => command.name.toLowerCase() === lower)
    ?? null;
}

/** Whether running this command needs the user's approval first, in every access mode. */
export function isRiskyAppCommand(command: Pick<AppCommand, 'id' | 'name'>): boolean {
  return RISKY_COMMAND_RE.test(`${command.id.replace(/[._-]/g, ' ')} ${command.name}`);
}
