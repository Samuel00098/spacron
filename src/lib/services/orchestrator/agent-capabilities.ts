/**
 * Which agent CLIs can actually talk back to Spacron.
 *
 * This exists because the notification rule "only a turn end the agent
 * declared may interrupt" is only fair to apply when the agent *had a way to
 * declare it*. Spacron writes an MCP config for eight executables; the other
 * ~30 CLIs in the preset catalog launch with no Spacron tools at all (see the
 * `default:` branch of `injectMcpConfigForAgent`, which warns about exactly
 * this). Staying silent for those would mean they finish and the user is never
 * told anything — the opposite failure from the one the rule exists to stop.
 *
 * So: an agent that COULD report and didn't gets silence, because its silence
 * is information. An agent with no channel at all still gets a card, worded
 * "went quiet" rather than "finished", because a guess honestly labelled as a
 * guess beats nothing.
 *
 * Kept in its own leaf module so both `stores/mcpBridge` (which writes the
 * configs) and `stores/orchestrator` (which decides what interrupts) can read
 * it without importing each other.
 */

import { agentExecutable } from './agent-rules-file';
import { hasAnyTurnSignalChannel } from './agent-hook-signals';

/**
 * Executables Spacron writes an MCP server config for.
 *
 * Must stay in step with the `switch` in `injectMcpConfigForAgent`
 * (mcpBridge.ts) — `agent-capabilities.test.ts` asserts they match, because a
 * CLI added there and forgotten here would be told to report and then silenced
 * for not reporting.
 *
 * `claude` is included even though it takes a different route (a per-launch
 * `--mcp-config` from `mcpLaunchFlags`, plus the project `.mcp.json`) — what
 * matters here is that it ends up holding the tools.
 */
export const MCP_CONFIGURABLE_EXECUTABLES: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'gemini',
  'opencode',
  'droid',
  'cursor',
  'cursor-agent',
  // Legacy key: the Cursor preset launched the bare `agent` before the rename.
  'agent',
]);

/**
 * Whether this agent has a way to report its own turn end (`report_status`).
 *
 * False means the CLI launches with no Spacron tools, so its turn can only ever
 * be inferred from its output — and a card saying so is the best available
 * truth, not a false alarm.
 */
export function agentCanReport(
  presetOrCommand: string | null | undefined,
  sessionId?: number | null,
): boolean {
  // The shell status channel reaches every agent Spacron spawned, whatever its
  // CLI — so in practice this is the branch that answers true for the ~30 CLIs
  // with no MCP config surface. Checked first because it is the specific fact
  // about *this session*, where the executable list is only a general rule.
  if (sessionId != null && hasAnyTurnSignalChannel(sessionId)) return true;
  if (!presetOrCommand) return false;
  return MCP_CONFIGURABLE_EXECUTABLES.has(agentExecutable(presetOrCommand));
}
