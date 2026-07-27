/**
 * Bridge between the Rust MCP server (agent-to-agent communication) and the
 * frontend stores that own the actual PTY sessions and agent lifecycle.
 *
 * Responsibilities:
 *   1. Listen for spawn-agent requests from the MCP server and create
 *      terminal sessions.
 *   2. Register agents with the MCP server when terminals are created.
 *   3. Unregister agents when terminals are closed.
 *   4. Provide the MCP server port for writing agent config files.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import {
  createTerminalSession,
  getSessionLabel,
  getActiveTerminalProjectId,
  setSessionWorktree,
} from './terminal';
import { pickAssistantName } from '$lib/services/orchestrator/agent-names';
import {
  applyOrchestratorAgentName,
  sendOrchestratorGoalWhenReady,
} from '$lib/services/orchestrator/terminal-lease';
import {
  createTaskWorktree,
  removeTaskWorktree,
  type WorktreeInfo,
} from '$lib/services/orchestrator/worktree-manager';
// ---------------------------------------------------------------------------
// Rust MCP server handle — registered from lib.rs as managed Tauri state
// ---------------------------------------------------------------------------

let serverPort: number | null = null;
let serverUrl: string | null = null;
let initialized = false;

/** Get the port the MCP server is listening on. */
export async function getMcpPort(): Promise<number> {
  if (serverPort === null) {
    serverPort = (await invoke('mcp_server_port')) as number;
  }
  return serverPort!;
}

/**
 * The full SSE URL agents must connect to, including the `?token=` the server
 * requires. Built in Rust and returned whole so the token can never be dropped
 * on the way through — a URL missing it authenticates as nobody and the agent
 * silently loses every cross-agent tool.
 */
export async function getMcpUrl(): Promise<string> {
  if (serverUrl === null) {
    serverUrl = (await invoke('mcp_server_url')) as string;
  }
  return serverUrl!;
}

/**
 * Point the MCP server at the open project's main checkout.
 *
 * `delegate_task` blocks on a worker's report file under
 * `<root>/.spacron/reports/`, and the Rust server has no way to learn that path
 * on its own. Best-effort: a failure here disables delegation, not the app.
 */
export async function setMcpProjectRoot(root: string | null): Promise<void> {
  try {
    await invoke('mcp_set_project_root', { root });
  } catch (e) {
    console.error('Failed to set MCP project root:', e);
  }
}

/** Register an agent with the MCP server so other agents can discover it. */
export async function registerAgent(
  sessionId: number,
  name: string,
  preset: string,
  label: string,
  /**
   * The agent's isolated git branch, when it has one. Surfaced through
   * `list_agents` so an orchestrating agent can review a worker's real change
   * with `git diff` rather than scraping its terminal output.
   */
  branch?: string | null,
): Promise<void> {
  try {
    await invoke('mcp_register_agent', { sessionId, name, preset, label, branch: branch ?? null });
  } catch (e) {
    console.error('Failed to register agent with MCP server:', e);
  }
}

/** Unregister an agent by session id. */
export async function unregisterAgent(sessionId: number): Promise<void> {
  try {
    await invoke('mcp_unregister_agent', { sessionId });
  } catch (e) {
    console.error('Failed to unregister agent from MCP server:', e);
  }
}

// ---------------------------------------------------------------------------
// Spawn request handler — listens for Tauri events from the Rust MCP server
// and creates terminal sessions in response.
// ---------------------------------------------------------------------------

export interface SpawnRequest {
  preset: string;
  prompt: string;
  /** Name the requesting agent asked for; empty means "assign one". */
  name: string;
}

export interface SendToAgentRequest {
  target_name: string;
  message: string;
  target_session_id: number;
}

export interface ReadOutputRequest {
  target_name: string;
  target_session_id: number;
}

/**
 * Initialize the MCP bridge: start listening for spawn-agent events.
 * Call this once during app startup.
 */
export function initMcpBridge(): void {
  if (initialized) return;
  initialized = true;

  listen<SpawnRequest>('mcp:spawn-agent', async (event) => {
    const { preset, prompt, name: requestedName } = event.payload;
    console.log(`[mcp] Spawning agent: ${preset}${prompt ? ` (prompt: ${prompt})` : ''}`);

    try {
      // An agent-driven spawn is isolated by default. Without this every worker
      // an orchestrator spawns edits the SAME working tree concurrently, and two
      // workers touching one file silently clobber each other — the exact thing
      // worktree isolation exists to prevent. There is no user in this path to
      // ask (the placement dialog is interactive and this spawn arrives from a
      // background process), and isolation is the safe default: the reconciler
      // stages the branch back into the main checkout on its own.
      const projectId = getActiveTerminalProjectId();
      let worktree: WorktreeInfo | null = null;
      if (projectId) {
        worktree = await createTaskWorktree({
          projectId,
          // No OrchestratorTask backs an MCP spawn, so synthesize the id the
          // branch name is derived from. `mcp_` keeps these identifiable on disk.
          taskId: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          label: preset,
        });
      }
      // `createTaskWorktree` returns null for a non-git or empty repo. That is
      // not fatal — the agent runs in the project root, exactly as before.

      const sessionId = await createTerminalSession(worktree?.path, undefined, projectId ?? undefined, {
        agentPreset: preset,
      });

      if (sessionId === null) {
        console.error('[mcp] Failed to create terminal session for spawn');
        if (worktree && projectId) {
          // Don't strand an empty worktree for a session that never existed.
          await removeTaskWorktree(projectId, worktree, true).catch(() => {});
        }
        return;
      }

      // Session-owned worktree: this is what makes the reconciler stage the
      // agent's commits back into the main checkout, and what makes closing the
      // pane reclaim the branch instead of orphaning it. Registering it is not
      // bookkeeping — an unregistered worktree's work is never seen again.
      if (worktree) setSessionWorktree(sessionId, worktree);

      // Honour the requested name so the spawner can address this agent
      // immediately; the server has already rejected a name that collides with a
      // running agent. Falling back to a generated one keeps the old behaviour
      // for callers that don't ask.
      const name = requestedName?.trim() || pickAssistantName();
      applyOrchestratorAgentName(sessionId, name);

      if (prompt) {
        // Was a flat `setTimeout(…, 3000)`, which is a race the agent loses
        // whenever the CLI takes longer than three seconds to boot — routine for
        // Claude Code. The prompt then lands in a REPL that isn't listening and
        // is mangled or dropped, and for an orchestrator's worker that prompt is
        // what carries its whole task. `sendGoal` waits for actual readiness.
        const delivered = await sendOrchestratorGoalWhenReady(sessionId, prompt);
        if (!delivered) {
          console.error(`[mcp] Prompt was not delivered to spawned agent '${name}' (${preset})`);
        }
      }
    } catch (e) {
      console.error('[mcp] Failed to spawn agent:', e);
    }
  }).catch((e) => {
    console.error('[mcp] Failed to listen for spawn-agent events:', e);
  });

  console.log('[mcp] Bridge initialized, listening for spawn-agent events');

}

// ---------------------------------------------------------------------------
// Agent config injection — writes MCP server settings into agent config
// files so they auto-discover the MCP server on launch.
// ---------------------------------------------------------------------------

/**
 * Build the MCP server configuration block to inject into an agent's
 * settings file (e.g., `~/.claude/settings.json`).
 *
 * Each agent connects via SSE to `http://127.0.0.1:{port}/sse` and sends
 * JSON-RPC messages to `http://127.0.0.1:{port}/message`.
 */
export async function buildMcpServerConfig(): Promise<Record<string, unknown>> {
  return {
    'spacron-mcp': {
      url: await getMcpUrl(),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-preset config injection
// ---------------------------------------------------------------------------

/**
 * Inject MCP server configuration for the given agent preset before it
 * launches. Different agents discover MCP servers through different files:
 *
 *   - Claude Code: env var `CLAUDE_CODE__MCP__SERVERS` (set in createTerminalSession)
 *   - Codex CLI:   `~/.codex/config.toml`  (TOML `[mcp_servers]` table)
 *   - Cursor:      `.cursor/mcp.json` in the project root (JSON `mcpServers`)
 *   - Aider:       env var or `--mcp-servers` flag
 *
 * Call this *before* spawning the agent's PTY so the config is in place
 * when the agent starts.
 */
export async function injectMcpConfigForAgent(
  preset: string,
  projectRoot?: string,
): Promise<void> {
  const mcpUrl = await getMcpUrl();

  switch (preset) {
    case 'cursor':
      await injectCursorConfig(projectRoot, mcpUrl);
      break;
    case 'codex':
      await injectCodexConfig(mcpUrl);
      break;
    // Claude Code uses env var (handled in createTerminalSession)
    // Aider uses env var (handled in createTerminalSession via AIDER_MCP_SERVERS)
    default:
      break;
  }
}

/**
 * Write/merge MCP server into a project-level `.cursor/mcp.json`.
 * Creates the file if it doesn't exist; merges into existing `mcpServers`
 * if it does.
 */
async function injectCursorConfig(
  projectRoot: string | undefined,
  mcpUrl: string,
): Promise<void> {
  if (!projectRoot) return;
  const configPath = `${projectRoot}/.cursor/mcp.json`;

  try {
    let config: Record<string, unknown> = {};
    try {
      const existing = await invoke<string>('fs_read_file', { path: configPath });
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
      config = {};
    }

    const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    mcpServers['spacron-mcp'] = { url: mcpUrl };
    config['mcpServers'] = mcpServers;

    await invoke('fs_write_file', {
      path: configPath,
      content: JSON.stringify(config, null, 2),
    });
  } catch (e) {
    console.warn('[mcp] Failed to inject Cursor config:', e);
  }
}

/**
 * Write/merge MCP server into `~/.codex/config.toml`.
 * Appends a `[mcp_servers.spacron-mcp]` table with the SSE URL.
 */
async function injectCodexConfig(mcpUrl: string): Promise<void> {
  try {
    const home = await homeDir();
    const configPath = `${home}.codex/config.toml`;

    let content = '';
    try {
      content = await invoke<string>('fs_read_file', { path: configPath });
    } catch {
      // File doesn't exist — start empty
    }

    // Remove any existing [mcp_servers.spacron-mcp] block so we replace it
    content = content.replace(
      /\[mcp_servers\.spacron-mcp\][^\[]*/g,
      '',
    );

    content += `\n[mcp_servers.spacron-mcp]\nurl = "${mcpUrl}"\n`;

    await invoke('fs_write_file', {
      path: configPath,
      content: content.trim() + '\n',
    });
  } catch (e) {
    console.warn('[mcp] Failed to inject Codex config:', e);
  }
}