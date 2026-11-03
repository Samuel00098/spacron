/**
 * ACP entry points for Spacron's chat presets.
 *
 * A preset like Claude Code or Codex is a *terminal* agent: typing `claude`
 * opens its own TUI, which is not the Agent Client Protocol. Each of these
 * vendors ships (or has a maintained adapter for) a separate stdio entry point
 * that speaks ACP. Chat uses these so the same picker entry can hold a real
 * conversation instead of dispatching a background task.
 *
 * Every command below was verified against the vendor's own ACP surface on
 * 2026-11-03; nothing here is guessed from a preset name:
 *
 * - Claude  — `claude-acp` in the ACP registry: `@agentclientprotocol/claude-agent-acp`
 * - Codex   — `codex-acp` in the ACP registry: `@agentclientprotocol/codex-acp`
 * - Cursor  — the installed `cursor-agent` binary takes the `acp` subcommand
 *             (cursor.com/docs/cli/acp; registry entry `cursor`)
 * - OpenCode— `opencode acp` is OpenCode's documented native ACP entry point
 * - Grok    — Grok Build's ACP preset is `grok agent stdio` (xAI's CLI)
 *
 * Antigravity is deliberately absent: Google ships ACP as an IDE extension
 * server binary (`agy_acp_server`), not as a subcommand of the `agy` CLI, so
 * there is no launch form we can assume is on the user's PATH. Declaring the
 * installed server path in Settings is the only honest way to use it.
 */

export interface AcpLauncher {
  /** Lowercase executable names this launcher belongs to. */
  executables: readonly string[];
  /** Command that speaks ACP over stdio. */
  command: string;
  /** Vendor surface the launch form comes from, for the Settings hint. */
  source: string;
}

const ACP_LAUNCHERS: readonly AcpLauncher[] = [
  {
    executables: ['claude', 'claude-code'],
    command: 'npx -y @agentclientprotocol/claude-agent-acp',
    source: 'ACP registry: claude-acp',
  },
  {
    executables: ['codex'],
    command: 'npx -y @agentclientprotocol/codex-acp',
    source: 'ACP registry: codex-acp',
  },
  {
    executables: ['cursor-agent', 'cursor'],
    command: 'cursor-agent acp',
    source: 'cursor.com/docs/cli/acp',
  },
  {
    executables: ['opencode'],
    command: 'opencode acp',
    source: 'opencode.ai/docs/acp',
  },
  {
    executables: ['grok'],
    command: 'grok agent stdio',
    source: 'Grok Build ACP preset',
  },
];

/** The Antigravity ACP server, for documentation and Settings. */
export const ANTIGRAVITY_ACP_SERVER = 'agy_acp_server';

function executableName(command: string): string {
  const token = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.slice(1).find(Boolean) ?? '';
  return token.replace(/\\/g, '/').split('/').pop()?.replace(/\.(?:cmd|exe|bat|ps1)$/i, '').toLowerCase() ?? '';
}

/** The ACP entry point shipped alongside this CLI, if we know one. */
export function builtinAcpLauncher(command: string | null | undefined): AcpLauncher | null {
  const executable = executableName(command ?? '');
  if (!executable) return null;
  return ACP_LAUNCHERS.find((launcher) => launcher.executables.includes(executable)) ?? null;
}

/**
 * The command Chat should actually spawn for this agent.
 *
 * A command the user (or the ACP registry) declared ACP is already an entry
 * point and is used as written. A preset CLI gets its vendor ACP launcher.
 * Everything else returns null and keeps the terminal-dispatch path.
 */
export function resolveAcpLaunchCommand(
  command: string | null | undefined,
  declaredAcp = false,
): string | null {
  const trimmed = command?.trim();
  if (!trimmed) return null;
  if (declaredAcp) return trimmed;
  return builtinAcpLauncher(trimmed)?.command ?? null;
}

/** Human-readable note for the Settings row: why this agent can (or cannot) chat over ACP. */
export function acpLauncherNote(command: string): string {
  const launcher = builtinAcpLauncher(command);
  if (launcher) return `ACP via \`${launcher.command}\` (${launcher.source}).`;
  if (executableName(command) === 'agy' || executableName(command) === 'antigravity') {
    return `Google ships ACP as the \`${ANTIGRAVITY_ACP_SERVER}\` extension server, not an \`agy\` subcommand — install it and declare its path here.`;
  }
  return '';
}
