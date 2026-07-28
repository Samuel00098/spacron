// Agent names drawn from The Matrix. When the user (or the brain) doesn't name a
// spawned agent, we give it one of these so it's easy to refer to
// ("ask Trinity to run the tests") and shows a distinctive badge on its pane.

// Exported because the MCP server needs the same pool: a worker spawned through
// `delegate_task` is named in Rust (the name is its handle and its report
// filename, so it has to be decided before the spawn is forwarded), and it must
// come from this list — not a second one that drifts. `setMcpAssistantNames`
// pushes it at startup.
export const ASSISTANT_NAMES = [
  'Neo', 'Trinity', 'Morpheus', 'Cypher', 'Switch', 'Apoc', 'Mouse', 'Tank', 'Dozer', 'Oracle',
  'Niobe', 'Ghost', 'Seraph', 'Link', 'Zee', 'Sati', 'Persephone', 'Bane', 'Lock', 'Roland',
  'Cas', 'Choi', 'Kid', 'Hamann', 'Rama', 'Ballard', 'Keymaker', 'Trainman', 'Spoon', 'Architect',
];

// Generic words a model reaches for when it labels an agent instead of leaving it
// unnamed — we strip these so the film name takes over.
const GENERIC_NAME_WORDS = new Set(['agent', 'assistant', 'bot', 'ai', 'coder', 'worker', 'task']);

/**
 * True when `name` is a throwaway, machine-flavored label rather than a real name
 * the user would choose — e.g. "claude-1", "Claude Code 2", "agent", "bot 3".
 * The orchestrator's brain (especially weaker models) tends to emit these; we
 * treat them as unnamed so every agent still gets a distinctive film name.
 *
 * `command` is the agent's CLI id (e.g. "claude"); `displayName` its product name
 * (e.g. "Claude Code"). A label is generic when, after dropping a trailing number,
 * it collapses to the command, the product name, or a bland word like "agent".
 */
export function isGenericAgentName(
  name: string | null | undefined,
  command?: string | null,
  displayName?: string | null,
): boolean {
  const normalized = (name ?? '').trim().toLowerCase();
  if (!normalized) return true;

  // Drop a trailing index ("claude-1", "agent 2", "bot_3") to get the base label.
  const base = normalized.replace(/[\s_-]*\d+$/, '').trim();
  if (!base) return true; // name was just a number

  if (GENERIC_NAME_WORDS.has(base)) return true;

  const cmd = command?.trim().toLowerCase();
  if (cmd && base === cmd) return true;

  const display = displayName?.trim().toLowerCase();
  if (display && base === display) return true;

  return false;
}

/**
 * Pick an agent name not already in `taken` (case-insensitive). If every
 * name is in use, falls back to a numbered variant ("Trinity 2") so it stays unique.
 */
export function pickAssistantName(taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (n) => n.trim().toLowerCase()).filter(Boolean));
  const free = ASSISTANT_NAMES.filter((n) => !used.has(n.toLowerCase()));

  if (free.length) return free[Math.floor(Math.random() * free.length)];

  const base = ASSISTANT_NAMES[Math.floor(Math.random() * ASSISTANT_NAMES.length)];
  let suffix = 2;
  while (used.has(`${base} ${suffix}`.toLowerCase())) suffix++;
  return `${base} ${suffix}`;
}
