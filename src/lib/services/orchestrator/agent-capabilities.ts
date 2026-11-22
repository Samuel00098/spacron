/**
 * Which agent CLIs can actually talk back to Spacron.
 *
 * Spacron writes an MCP config for eight executables; the other ~30 CLIs in the
 * preset catalog launch with no Spacron tools at all (see the `default:` branch
 * of `injectMcpConfigForAgent`, which warns about exactly this). The shell
 * status channel covers most of the gap, but not a remote box.
 *
 * This answers ONE question for the notification path: when an agent appears to
 * have PAUSED and never said so, was that silence a choice? An agent that could
 * report and didn't is telling us it is not blocked, so an inferred pause stays
 * in the inbox. An agent with no channel at all could not have told us either
 * way, and a missed "needs input" strands the user waiting on an agent that is
 * waiting on them — so that guess still interrupts.
 *
 * It deliberately does NOT gate inferred *finishes*. Those never interrupt for
 * any agent: "output stopped growing" is equally a long compile, and a card
 * reading "Agent went quiet" is the false completion alert the whole rule
 * exists to stop. Such a turn is still recorded — worded "went quiet" rather
 * than "finished" — it just waits in the inbox instead of floating.
 *
 * Kept in its own leaf module so both `stores/mcpBridge` (which writes the
 * configs) and `stores/orchestrator` (which decides what interrupts) can read
 * it without importing each other.
 */

import { agentExecutable } from './agent-rules-file';
import { hasAnyTurnSignalChannel } from './agent-hook-signals';
import { get } from '$lib/stores/storeCompat';
import { remoteMcpTunnelOpen, remoteTarget } from '$lib/stores/remoteWorkspace';

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
  // DeepSeek Harness: the server arrives through a `--patch` launch flag.
  'dsh',
  'qwen',
  'kiro-cli',
  'amp',
  'devin',
  'agy',
  // These two read the project `.mcp.json` written for Claude Code.
  'copilot',
  'qodercli',
]);

/**
 * Whether this agent has a way to report its own turn end (`report_status`).
 *
 * False means the CLI launches with no Spacron tools, so its turn can only ever
 * be inferred from its output — its silence carries no information, which is
 * why an inferred PAUSE from such an agent is still allowed to interrupt.
 */
export function agentCanReport(
  presetOrCommand: string | null | undefined,
  sessionId?: number | null,
): boolean {
  // Neither channel crosses to a remote workspace, so no agent can report from
  // one and the executable list below stops being a fair rule. The shell
  // sentinel is a file `agent_signal_channel_open` creates on *this* machine
  // (see `signalChannelsReachAgent`), and the MCP route hands the agent
  // `http://127.0.0.1:<port>` — which, from the box, is the box's own loopback
  // and not the laptop's server. An agent over there is silent because we gave
  // it no way to speak, so a pause we infer from its screen must not be
  // swallowed as a report it chose not to make.
  // With the MCP tunnel up, an agent on the box reaches report_status like a
  // local one, so only a remote without it is speechless.
  if (get(remoteTarget) && !get(remoteMcpTunnelOpen)) return false;
  // The shell status channel reaches every agent Spacron spawned, whatever its
  // CLI — so in practice this is the branch that answers true for the ~30 CLIs
  // with no MCP config surface. Checked first because it is the specific fact
  // about *this session*, where the executable list is only a general rule.
  if (sessionId != null && hasAnyTurnSignalChannel(sessionId)) return true;
  if (!presetOrCommand) return false;
  return MCP_CONFIGURABLE_EXECUTABLES.has(agentExecutable(presetOrCommand));
}

/**
 * Whether this turn end is inbox-only — no corner card, no chime, no OS
 * notification.
 *
 * The one place the interrupt rule lives, because `completeLeasedTask`,
 * `notifyAdoptedTurnEnd` and the blocked path each used to spell it out and
 * drifted apart. What may interrupt:
 *
 *   done, declared      the agent said it finished — the recap the user wants
 *   failed              an observed fact, however we learned it
 *   blocked, declared   the agent asked a question
 *   blocked, inferred   ONLY from an agent with no channel (see below)
 *
 * …and the one thing that never may:
 *
 *   done, inferred      "output stopped growing" — a long compile looks exactly
 *                       like this, and the card claiming otherwise is the false
 *                       "your agent has finished" alert. Recorded for the inbox
 *                       as "went quiet"; it simply does not interrupt.
 *
 * The asymmetry between the two inferred rows is deliberate. A wrong finish
 * costs the user an interruption over nothing and teaches them to distrust the
 * real ones; a missed pause strands them waiting on an agent that is waiting on
 * them. So a guessed pause still speaks up — but only from an agent that had no
 * way to tell us, since one that could report and stayed quiet is itself
 * evidence that it is not blocked.
 */
export function turnEndIsSilent(
  end: { status: 'done' | 'blocked' | 'failed'; endedBy?: string | null },
  agent: { preset?: string | null; sessionId?: number | null } = {},
): boolean {
  if (end.endedBy !== 'inferred') return false;
  if (end.status === 'done') return true;
  if (end.status === 'failed') return false;
  return agentCanReport(agent.preset, agent.sessionId);
}
