/**
 * The slash commands each agent publishes itself, for the chat's `/` menu.
 *
 * ACP agents send `available_commands_update` after a session opens; Pi answers
 * `get_commands` over RPC. Structured chats record what their own session
 * reports (and probes record it too, see `agent-command-probe.ts`). Claude Code
 * has its own live list (`chat_claude_commands`). Kept per agent and folder,
 * because project skills and commands differ, and saved so the menu is full the
 * next time it opens.
 */
import { persisted } from '$lib/stores/chatViewSettings';

export interface AgentCommand {
  /** With the leading `/`. */
  name: string;
  description: string;
}

type CommandMap = Record<string, AgentCommand[]>;
type Json = Record<string, unknown>;

const MAX_FOLDERS = 40;
const MAX_COMMANDS = 600;

function normalize(raw: unknown): CommandMap {
  const out: CommandMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    const rows = commandRows(list);
    if (rows.length) out[key] = rows;
  }
  return out;
}

export const agentCommands = persisted<CommandMap>('spacron_agent_commands_v1', {}, normalize);

export function agentCommandsKey(agent: string, cwd: string): string {
  return `${agent}|${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`;
}

/** Rows from an ACP or Pi command list; anything without a plain name is dropped. */
export function commandRows(raw: unknown): AgentCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AgentCommand[] = [];
  for (const entry of raw.slice(0, MAX_COMMANDS)) {
    const row = entry && typeof entry === 'object' ? entry as Json : null;
    const bare = typeof row?.name === 'string' ? row.name.trim().replace(/^\//, '') : '';
    if (!bare || /\s/.test(bare)) continue;
    const name = `/${bare}`;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const description = typeof row!.description === 'string' ? row!.description.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    out.push({ name, description });
  }
  return out;
}

/** The command list inside an ACP `session/update` notification, if that is what it is. */
export function acpCommandsFrom(notification: Json): AgentCommand[] | null {
  const params = (notification.params ?? notification) as Json;
  const update = (params.update ?? params) as Json;
  if (update.sessionUpdate !== 'available_commands_update') return null;
  return commandRows(update.availableCommands);
}

export function setAgentCommands(agent: string, cwd: string, commands: AgentCommand[]): void {
  if (!commands.length) return;
  agentCommands.update((all) => {
    const key = agentCommandsKey(agent, cwd);
    const rest = Object.entries(all).filter(([k]) => k !== key).slice(-(MAX_FOLDERS - 1));
    return { ...Object.fromEntries(rest), [key]: commands };
  });
}
