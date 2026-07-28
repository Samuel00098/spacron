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
import { get } from './storeCompat';
import {
  getSessionLabel,
  getActiveTerminalProjectId,
  sessions,
  setSessionWorktree,
  spawnAgentPreset,
} from './terminal';
import { agentExecutable } from '$lib/services/orchestrator/agent-rules-file';
import { ASSISTANT_NAMES, pickAssistantName } from '$lib/services/orchestrator/agent-names';
import {
  applyOrchestratorAgentName,
  sendOrchestratorFollowUpWhenReady,
  sendOrchestratorGoalWhenReady,
} from '$lib/services/orchestrator/terminal-lease';
import {
  createTaskWorktree,
  removeTaskWorktree,
  type WorktreeInfo,
} from '$lib/services/orchestrator/worktree-manager';
import { getAgentRoster } from './runs';
import { customAgents, removedPresetAgents } from './customAgents';
// ---------------------------------------------------------------------------
// Rust MCP server handle — registered from lib.rs as managed Tauri state
// ---------------------------------------------------------------------------

let serverPort: number | null = null;
let serverUrl: string | null = null;
let serverHttpUrl: string | null = null;
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
 * The authenticated **Streamable HTTP** URL (`/mcp`), for the CLIs that speak
 * that transport rather than SSE.
 *
 * The two are not interchangeable. Codex supports *only* streamable HTTP — its
 * `mcp add` takes `--url` documented as "URL for a streamable HTTP MCP server"
 * and has no SSE option — while Claude Code is configured here for SSE. Giving a
 * CLI the wrong one produces a failed connection that most of them report as an
 * authentication problem, which sends you looking in entirely the wrong place.
 */
export async function getMcpHttpUrl(): Promise<string> {
  if (serverHttpUrl === null) {
    serverHttpUrl = (await invoke('mcp_server_http_url')) as string;
  }
  return serverHttpUrl!;
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

/**
 * Tell the MCP server which agents this install can launch.
 *
 * `spawn_agent` and `delegate_task` name the available agents in their tool
 * schemas, so without this a delegating agent works from whatever list happened
 * to be written into the Rust source — which is how a real preset like `pi` ends
 * up looking unavailable, and how a user's custom agents stay invisible. The
 * server also uses the roster to resolve a display name ("Pi AI Agent") to its
 * launch command.
 *
 * Best-effort: a failure leaves the server with an empty roster, which it treats
 * as "not reported yet" and stays permissive about, rather than blocking spawns.
 */
export async function setMcpAgentPresets(
  presets: { command: string; name: string }[],
): Promise<void> {
  try {
    await invoke('mcp_set_agent_presets', { presets });
  } catch (e) {
    console.error('Failed to publish the agent roster to the MCP server:', e);
  }
}

/**
 * Publish the app's assistant-name pool to the MCP server.
 *
 * The server assigns a delegated worker's name before the spawn ever reaches the
 * frontend — for `delegate_task` the name is the handle returned to the caller
 * and the path the worker writes its report to, so it cannot be changed after
 * the fact. Pushing the list keeps `agent-names.ts` the single source of truth
 * instead of Rust carrying a second copy that drifts.
 *
 * Best-effort: a failure leaves the server naming workers `worker-a1b2c3`, which
 * is ugly but not broken.
 */
export async function setMcpAssistantNames(names: string[]): Promise<void> {
  try {
    await invoke('mcp_set_assistant_names', { names });
  } catch (e) {
    console.error('Failed to publish assistant names to the MCP server:', e);
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
 * A request from the MCP server to type a message into a running agent, raised
 * by `send_to_agent` and `bounce_task`. The server blocks on the answer.
 */
export interface DeliverPromptRequest {
  request_id: string;
  session_id: number;
  message: string;
}

/**
 * Deliver an MCP message into a running agent's TUI and tell the server whether
 * it landed.
 *
 * The server used to write these straight to the PTY. That fails in the way the
 * user sees: no Enter is ever sent, so the text sits in the composer unsubmitted,
 * and because it is not a bracketed paste, every newline in the message (a
 * `bounce_task` message always has several) is read as a submit — so a fragment
 * goes and the rest scatters. `sendOrchestratorFollowUpWhenReady` is the path
 * that fixed exactly this for the floating bar: it waits for the agent to be at
 * its prompt, pastes, waits for the composer to settle, then submits and
 * confirms the agent actually started, retrying if it did not.
 */
async function deliverMcpPrompt(payload: DeliverPromptRequest): Promise<void> {
  const { request_id, session_id, message } = payload;
  let delivered = false;
  let error: string | null = null;

  try {
    delivered = await sendOrchestratorFollowUpWhenReady(session_id, message);
    if (!delivered) {
      // The distinction matters to the caller: a dead pane is permanent, a
      // rejected send is worth retrying.
      const alive = get(sessions).some((s) => s.id === session_id && s.isRunning);
      error = alive
        ? 'The agent did not accept the message — its CLI may be busy or not at a prompt.'
        : 'That agent is no longer running.';
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  try {
    await invoke('mcp_deliver_respond', {
      requestId: request_id,
      success: delivered,
      error,
    });
  } catch (e) {
    // Losing the reply just means the caller waits out its timeout instead of
    // getting a clean answer — worth logging, never worth throwing.
    console.error('[mcp] Failed to report prompt delivery result:', e);
  }
}

/**
 * Initialize the MCP bridge: start listening for spawn-agent events.
 * Call this once during app startup.
 */
export function initMcpBridge(): void {
  if (initialized) return;
  initialized = true;

  // Keep the server's agent roster live. Both stores fire immediately on
  // subscribe, so this doubles as the initial push, and again on every add,
  // edit, or removal — a custom agent the user creates mid-session is
  // delegatable without an app restart.
  const publishRoster = () => {
    setMcpAgentPresets(getAgentRoster());
  };
  customAgents.subscribe(publishRoster);
  removedPresetAgents.subscribe(publishRoster);

  // The server names delegated workers itself (a worker's name is the handle it
  // returns, so it cannot wait for the frontend), and it draws from this list so
  // those names match the ones the app gives agents the user spawns. Fixed at
  // build time, so one push at startup is all it needs.
  void setMcpAssistantNames(ASSISTANT_NAMES);

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

      // `spawnAgentPreset`, not `createTerminalSession`: the latter opens a bare
      // shell and only *records* `agentPreset` as metadata — it never types the
      // launch command. This path used it, so a delegated worker was a plain
      // shell wearing an agent's name and title, and the task prompt was
      // delivered to `$` instead of to a CLI. `spawnAgentPreset` is the sequence
      // the app's own picker uses: rules-file brief, title, `--mcp-config`
      // flags, then the command.
      //
      // `activate: false` keeps the user's focus where it is — this spawn is not
      // something they asked for at this moment. `assignPane: false` is implicit
      // in there: an agent gets its own room, and two xterms on one session id
      // is not renderable, so a claimed mosaic cell degrades to a dead
      // "<name> is open in its own room / Free this pane" placeholder.
      const sessionId = await spawnAgentPreset(preset, worktree?.path, {
        activate: false,
        projectId: projectId ?? undefined,
        // Registered before the CLI starts: this is what makes the reconciler
        // stage the agent's commits back into the main checkout, and what makes
        // closing the pane reclaim the branch instead of orphaning it. An
        // unregistered worktree's work is never seen again.
        onSessionCreated: worktree ? (id) => setSessionWorktree(id, worktree!) : undefined,
      });

      if (sessionId === null) {
        console.error('[mcp] Failed to launch agent session for spawn');
        if (worktree && projectId) {
          // Don't strand an empty worktree for a session that never existed.
          await removeTaskWorktree(projectId, worktree, true).catch(() => {});
        }
        return;
      }

      // The server has already settled the name: it rejected collisions and
      // swapped any generic label for one from the app's pool, and for a
      // delegated worker that name is the handle its spawner holds and the file
      // it reports to. Renaming it here would break both, so it is applied
      // as given.
      //
      // The fallback covers only a spawn that arrived with no name at all —
      // possible when the pool has not been pushed yet — and excludes the names
      // in use so it cannot mint a duplicate.
      const takenNames = get(sessions)
        .filter((s) => s.isRunning && s.agentName)
        .map((s) => s.agentName as string);
      const name = requestedName?.trim() || pickAssistantName(takenNames);
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

  // `send_to_agent` and `bounce_task` block on this handler's verdict, so it must
  // always answer — `deliverMcpPrompt` swallows its own failures into a reply
  // rather than rejecting.
  listen<DeliverPromptRequest>('mcp:deliver-prompt', (event) => {
    void deliverMcpPrompt(event.payload);
  }).catch((e) => {
    console.error('[mcp] Failed to listen for deliver-prompt events:', e);
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
 * Inject MCP server configuration before an agent launches.
 *
 * There is no universal file. `.mcp.json` is a Claude Code convention that the
 * other CLIs do not read, so writing only that (as this used to) left every
 * non-Claude agent with zero Spacron tools and no error to explain why. Each CLI
 * gets the file it actually reads, in the transport it actually supports —
 * verified against the shipping binaries, not assumed:
 *
 * | CLI         | File                        | Transport        |
 * |-------------|-----------------------------|------------------|
 * | Claude Code | `.mcp.json` + `--mcp-config`| SSE              |
 * | Codex       | `~/.codex/config.toml`      | streamable HTTP  |
 * | Gemini CLI  | `.gemini/settings.json`     | streamable HTTP  |
 * | opencode    | `opencode.json`             | remote (HTTP)    |
 * | droid       | `~/.factory/mcp.json`       | streamable HTTP  |
 * | Cursor      | `.cursor/mcp.json`          | streamable HTTP  |
 *
 * Codex and droid have no project-scoped MCP config, so their entries are
 * global. That is safe only because the server's port and token are now stable
 * across restarts (see `load_or_create_token` in `src-tauri/src/mcp/mod.rs`) —
 * before that, a global entry went stale the moment the app was restarted.
 *
 * Call this *before* spawning the agent's PTY so the config is in place when the
 * agent starts. Every writer is best-effort: a missing config costs the agent
 * its cross-agent tools, but must never stop it launching.
 */
export async function injectMcpConfigForAgent(
  preset: string,
  projectRoot?: string,
): Promise<void> {
  const sseUrl = await getMcpUrl();
  const httpUrl = await getMcpHttpUrl();

  // Claude Code's own file. Harmless for the others, which ignore it.
  await injectProjectMcpJson(projectRoot, sseUrl);

  switch (agentExecutable(preset)) {
    case 'codex':
      await injectCodexConfig(httpUrl);
      break;
    case 'gemini':
      await injectGeminiConfig(projectRoot, httpUrl);
      break;
    case 'opencode':
      await injectOpencodeConfig(projectRoot, httpUrl);
      break;
    case 'droid':
      await injectDroidConfig(httpUrl);
      break;
    case 'cursor':
    case 'cursor-agent':
    case 'agent':
      await injectCursorConfig(projectRoot, httpUrl);
      break;
    default:
      // No known config surface for this executable — the normal path for a
      // user-added custom agent whose CLI isn't one of the six above. It
      // launches fine and simply has no Spacron tools, so it cannot see or
      // message the other agents.
      //
      // Say so out loud. Silent-no-tools is the exact failure this module has
      // already shipped twice via env vars that nothing read (see the
      // `SPACRON_MCP_URL` comment in `stores/terminal.ts`), and it is
      // indistinguishable from an agent that simply chose not to use them.
      console.warn(
        `[mcp] No MCP config surface known for "${agentExecutable(preset) || preset}" — ` +
          `it launches without Spacron tools (no list_agents / send_to_agent / delegate_task). ` +
          `Supported: claude, codex, gemini, opencode, droid, cursor.`,
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Launch-flag injection — for agents that discover MCP servers from an argument
// rather than a config file they already read.
// ---------------------------------------------------------------------------

/** Presets whose executable is Claude Code and accepts `--mcp-config`. */
const CLAUDE_EXECUTABLES = new Set(['claude']);

/**
 * Extra arguments to append to an agent's launch command so it discovers the
 * Spacron MCP server, or `''` when the preset needs none.
 *
 * Claude Code reads MCP servers from `.mcp.json`, `~/.claude.json`, or
 * `--mcp-config` — and from no environment variable at all. We use the flag
 * because it is the only one of the three that is per-session, needs no user
 * approval prompt, and leaves neither the user's global config nor the shared
 * working tree holding a stale port after the app restarts.
 *
 * The config is written to a file rather than passed as inline JSON so the
 * `?token=` does not land in terminal scrollback or the process list.
 *
 * Returns `''` on any failure: an agent with no cross-agent tools is worse than
 * one with them, but far better than one that fails to launch.
 */
export async function mcpLaunchFlags(
  preset: string,
  projectRoot?: string,
): Promise<string> {
  if (!CLAUDE_EXECUTABLES.has(agentExecutable(preset))) return '';
  if (!projectRoot) return '';

  try {
    // No URL means the MCP server never came up. Writing a config pointing at
    // nothing would leave the agent retrying a dead endpoint on every tool call.
    const url = await getMcpUrl();
    if (!url) return '';

    const configPath = `${projectRoot.replace(/[\\/]+$/, '')}/.spacron/mcp/claude.json`;
    await invoke('fs_write_file', {
      path: configPath,
      // `type: 'sse'` is required: the Rust server speaks SSE, and a bare `url`
      // is treated as streamable HTTP, which it does not serve.
      content: JSON.stringify(
        { mcpServers: { 'spacron-mcp': { type: 'sse', url } } },
        null,
        2,
      ),
    });
    return ` --mcp-config "${configPath}"`;
  } catch (e) {
    console.warn('[mcp] Could not write Claude MCP config; agent launches without Spacron tools:', e);
    return '';
  }
}

/**
 * Write every supported CLI's MCP config for this project.
 *
 * Called on project open so the configs are in place even when the user types
 * `codex` or `gemini` into a terminal by hand rather than going through
 * Spacron's spawn path — that route never calls `injectMcpConfigForAgent`, so
 * without this those agents start with no cross-agent tools. Best-effort.
 */
export async function ensureMcpConfigs(projectRoot: string): Promise<void> {
  try {
    const sseUrl = await getMcpUrl();
    const httpUrl = await getMcpHttpUrl();

    // Before writing anything: every file below carries `?token=`, and they land
    // inside the user's repo. See `ensureMcpConfigsIgnored`.
    await ensureMcpConfigsIgnored(projectRoot);

    await Promise.allSettled([
      injectProjectMcpJson(projectRoot, sseUrl),
      injectGeminiConfig(projectRoot, httpUrl),
      injectOpencodeConfig(projectRoot, httpUrl),
      injectCursorConfig(projectRoot, httpUrl),
      injectCodexConfig(httpUrl),
      injectDroidConfig(httpUrl),
    ]);
  } catch (e) {
    console.warn('[mcp] Could not write agent MCP configs on project open:', e);
  }
}

/**
 * Project-relative paths this module writes that contain the MCP token.
 *
 * `.spacron/` covers the Claude Code config written by `mcpLaunchFlags` and the
 * worker report files, both of which are app state rather than project content.
 */
const TOKEN_BEARING_PATHS = [
  '.mcp.json',
  '.gemini/settings.json',
  '.cursor/mcp.json',
  'opencode.json',
  '.spacron/',
];

/**
 * Keep the token-bearing configs out of the user's git history.
 *
 * These files hold `http://127.0.0.1:<port>/mcp?token=<secret>`, and that token
 * is now persistent and on a fixed port — so a copy that escapes stays valid
 * indefinitely, and it grants process spawning and PTY-write access to whoever
 * holds it. Spacron writes these files into the user's own repo, whose
 * `.gitignore` it does not control, while the standing brief actively tells
 * agents to commit as they go. Without this an agent running `git add -A`
 * publishes the token.
 *
 * Written to `.git/info/exclude` rather than `.gitignore`: the effect is the
 * same, but `.gitignore` is project content the user may have committed and
 * would then show up as a spurious diff in every repo Spacron opens.
 *
 * Best-effort and idempotent — a non-git directory simply has no `.git/info`,
 * and a failure costs tidiness, not function.
 */
export async function ensureMcpConfigsIgnored(projectRoot: string): Promise<void> {
  const root = projectRoot?.replace(/[\\/]+$/, '');
  if (!root) return;
  const excludePath = `${root}/.git/info/exclude`;

  try {
    let current = '';
    try {
      current = await invoke<string>('fs_read_file', { path: excludePath });
    } catch {
      // No exclude file (or no .git at all) — a fresh one is still valid.
    }

    const present = new Set(current.split('\n').map((line) => line.trim()));
    const missing = TOKEN_BEARING_PATHS.filter((p) => !present.has(p));
    if (!missing.length) return;

    const header = '# Spacron: local MCP configs — these carry the MCP server token.';
    const body = current.includes(header) ? missing.join('\n') : [header, ...missing].join('\n');
    const separator = current.length && !current.endsWith('\n') ? '\n' : '';

    await invoke('fs_write_file', {
      path: excludePath,
      content: `${current}${separator}${body}\n`,
    });
  } catch (e) {
    console.warn('[mcp] Could not add MCP configs to .git/info/exclude:', e);
  }
}

/**
 * Write/merge the Spacron MCP server into `.mcp.json` at the project root.
 * This is the universal discovery file read by any MCP-capable agent CLI.
 */
async function injectProjectMcpJson(
  projectRoot: string | undefined,
  mcpUrl: string,
): Promise<void> {
  if (!projectRoot) return;
  const configPath = `${projectRoot}/.mcp.json`;

  try {
    let config: Record<string, unknown> = {};
    try {
      const existing = await invoke<string>('fs_read_file', { path: configPath });
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }

    const mcpServers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    mcpServers['spacron-mcp'] = { type: 'sse', url: mcpUrl };
    config['mcpServers'] = mcpServers;

    await invoke('fs_write_file', {
      path: configPath,
      content: JSON.stringify(config, null, 2) + '\n',
    });
  } catch (e) {
    console.warn('[mcp] Failed to write .mcp.json:', e);
  }
}

/**
 * Merge `{ [section]: { 'spacron-mcp': entry } }` into a JSON config file,
 * preserving whatever else is in it.
 *
 * Every CLI here keeps its servers under one top-level object and differs only
 * in the key name and the shape of the entry, so the read-merge-write dance is
 * written once. Best-effort by contract: callers treat a failure as "this agent
 * launches without Spacron tools", never as a launch error.
 */
async function mergeJsonMcpConfig(
  configPath: string,
  section: string,
  entry: Record<string, unknown>,
  label: string,
): Promise<void> {
  try {
    let config: Record<string, unknown> = {};
    try {
      const existing = await invoke<string>('fs_read_file', { path: configPath });
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }

    const servers = (config[section] as Record<string, unknown>) ?? {};
    servers['spacron-mcp'] = entry;
    config[section] = servers;

    await invoke('fs_write_file', {
      path: configPath,
      content: JSON.stringify(config, null, 2) + '\n',
    });
  } catch (e) {
    console.warn(`[mcp] Failed to write ${label} config:`, e);
  }
}

/**
 * Write/merge MCP server into a project-level `.cursor/mcp.json`.
 * Creates the file if it doesn't exist; merges into existing `mcpServers`
 * if it does.
 */
async function injectCursorConfig(
  projectRoot: string | undefined,
  httpUrl: string,
): Promise<void> {
  if (!projectRoot) return;
  await mergeJsonMcpConfig(
    `${projectRoot}/.cursor/mcp.json`,
    'mcpServers',
    { type: 'http', url: httpUrl },
    'Cursor',
  );
}

/**
 * Gemini CLI — project-scoped `.gemini/settings.json`.
 *
 * Shape taken from what `gemini mcp add -s project -t http` actually writes:
 * `url` plus `type: "http"`. It is *not* the `httpUrl` key the older docs
 * describe.
 */
async function injectGeminiConfig(
  projectRoot: string | undefined,
  httpUrl: string,
): Promise<void> {
  if (!projectRoot) return;
  await mergeJsonMcpConfig(
    `${projectRoot}/.gemini/settings.json`,
    'mcpServers',
    { type: 'http', url: httpUrl },
    'Gemini CLI',
  );
}

/**
 * opencode — project-level `opencode.json`.
 *
 * opencode calls its section `mcp` (not `mcpServers`) and names the remote
 * transport `"remote"`; `enabled` must be set explicitly.
 */
async function injectOpencodeConfig(
  projectRoot: string | undefined,
  httpUrl: string,
): Promise<void> {
  if (!projectRoot) return;
  await mergeJsonMcpConfig(
    `${projectRoot}/opencode.json`,
    'mcp',
    { type: 'remote', url: httpUrl, enabled: true },
    'opencode',
  );
}

/**
 * droid (Factory) — global `~/.factory/mcp.json`. droid has no project-scoped
 * MCP config, so this is the only place it will look.
 *
 * Goes through the dedicated Rust commands rather than `fs_write_file`, which
 * rejects everything outside an open project. See `global_agent_config_path`.
 */
async function injectDroidConfig(httpUrl: string): Promise<void> {
  try {
    const existing = await invoke<string>('mcp_read_global_agent_config', { agent: 'droid' });

    let config: Record<string, unknown> = {};
    try {
      config = existing.trim() ? JSON.parse(existing) : {};
    } catch {
      // Not valid JSON — start fresh rather than lose the agent's tools.
    }

    const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    servers['spacron-mcp'] = { type: 'http', url: httpUrl, disabled: false };
    config['mcpServers'] = servers;

    await invoke('mcp_write_global_agent_config', {
      agent: 'droid',
      content: JSON.stringify(config, null, 2) + '\n',
    });
  } catch (e) {
    console.warn('[mcp] Failed to write droid config:', e);
  }
}

/**
 * Codex CLI — global `~/.codex/config.toml`, the only place it reads MCP
 * servers from.
 *
 * Codex speaks streamable HTTP only, and its entry is a bare `url` key under a
 * `[mcp_servers.<name>]` table — the exact output of `codex mcp add --url`.
 *
 * The file is hand-edited by users and holds unrelated tables (`[projects.…]`,
 * model settings), so this replaces just our own table and appends if absent.
 * Appending a table header at EOF is always valid TOML, whatever precedes it.
 */
async function injectCodexConfig(httpUrl: string): Promise<void> {
  try {
    let content = await invoke<string>('mcp_read_global_agent_config', { agent: 'codex' });

    // Drop any previous block: the header plus its keys, up to the next table.
    content = content.replace(/\[mcp_servers\.spacron-mcp\][^[]*/g, '');

    content = `${content.trimEnd()}\n\n[mcp_servers.spacron-mcp]\nurl = "${httpUrl}"\n`;

    await invoke('mcp_write_global_agent_config', {
      agent: 'codex',
      content: content.trimStart(),
    });
  } catch (e) {
    console.warn('[mcp] Failed to write Codex config:', e);
  }
}
