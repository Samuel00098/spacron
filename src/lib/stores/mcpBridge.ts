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
import { backendInvoke } from '$lib/services/backend';
import { listen } from '@tauri-apps/api/event';
import { get } from './storeCompat';
import { remoteTarget } from './remoteWorkspace';
import {
  getSessionLabel,
  getActiveTerminalProjectId,
  sessions,
  setSessionWorktree,
  spawnAgentPreset,
} from './terminal';
import { agentExecutable } from '$lib/services/orchestrator/agent-rules-file';
import { isDeepSeekHarness, isDeepSeekWorkerSession } from '$lib/services/deepseek-harness';
import { deliverTurnSignal } from '$lib/services/orchestrator/agent-hook-signals';
import { showToast } from './notification';
import { shouldUseSystemNotification } from './zustand/notification';
import { agentTurnStates, noteAgentPrompted } from './agentTurnState';
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
import { usageState } from './usage';
import { agentBrowserTools, mcpServers, mediaGeneration } from './settings';
import { setBrowserToolsAvailable } from '$lib/services/orchestrator/brain-tools';
import { syncChatMcpServers } from '$lib/services/orchestrator/mcp-client';
import {
  antigravityEntry,
  codexTable,
  deepSeekMcpPatch,
  devinEntry,
  droidEntry,
  enabledServers,
  headersLostOnCodex,
  isSpacronKey,
  mergeMap,
  opencodeEntry,
  qwenEntry,
  standardEntry,
  untypedEntry,
  withSignInProxy,
  type McpServer,
} from '$lib/services/mcp-servers';
// ---------------------------------------------------------------------------
// Rust MCP server handle — registered from lib.rs as managed Tauri state
// ---------------------------------------------------------------------------

let serverPort: number | null = null;
let serverUrl: string | null = null;
let serverHttpUrl: string | null = null;
let initialized = false;

// ---------------------------------------------------------------------------
// Per-agent identity — the credential that makes a tool call attributable
// ---------------------------------------------------------------------------

/**
 * A per-launch MCP credential, minted before the agent starts.
 *
 * The app-wide token in every other URL here authenticates but identifies
 * nobody: every agent presents the same string, so a `report_status` call made
 * with it proves only that *something* on this machine could read the user's
 * config. This is the narrower one — bound to a single PTY session, so a report
 * carrying it is attributable to exactly that agent.
 *
 * The two-step (mint, then bind once the session exists) is forced by the same
 * ordering that shapes `prepareTurnSignals`: the token has to be inside the
 * launch command, which is built before there is a session to bind it to.
 */
export interface AgentChannel {
  /** SSE URL carrying this agent's token. */
  url: string;
  /** Streamable HTTP URL carrying this agent's token. */
  httpUrl: string;
  /** The bare token, for `bindAgentChannel`. */
  token: string;
}

/**
 * A `report_status` call, as it reaches the frontend.
 *
 * `sessionId` comes from the token the caller presented, so it is evidence
 * rather than testimony; `state` is validated against the tool's enum in Rust,
 * so this really is a closed set.
 */
export interface AgentReportEvent {
  sessionId: number | null;
  state: 'working' | 'needs_input' | 'done' | 'failed';
  detail: string;
}

/**
 * Turn one report into a turn signal, a notification, or both.
 *
 * The split matters and is the same "one notification per event" rule the
 * inbox already follows: when the report ends a watched turn, the orchestrator's
 * own completion card is what the user sees, so raising a toast here as well
 * would double-notify. A toast is only for reports the turn machinery cannot
 * act on — an unattributed one, or an agent nobody is watching.
 *
 * Exported for tests; `initMcpBridge` is the only caller in the app.
 */
export async function handleAgentReport(report: AgentReportEvent): Promise<void> {
  if (report.sessionId !== null) {
    try {
      const { handleSubagentReport } = await import('$lib/services/structured-chat/mcp-subagents');
      handleSubagentReport(report.sessionId, report.state, report.detail);
    } catch {}
  }

  // "working" is a progress ping, not a turn boundary. It is deliberately not
  // surfaced: an agent that says "still going" every few minutes must not
  // produce a notification each time.
  if (report.state === 'working') {
    if (report.sessionId !== null && get(agentTurnStates)[report.sessionId]?.phase === 'quiet') {
      noteAgentPrompted(report.sessionId);
    }
    return;
  }

  // One state, one outcome. Collapsing `failed` into `blocked` here (which an
  // earlier cut of this did) makes an error arrive as "needs your input" — the
  // user goes looking for a question that was never asked.
  const signal =
    report.state === 'done'
      ? ({ kind: 'finished', detail: report.detail } as const)
      : report.state === 'failed'
        ? ({
            kind: 'failed',
            reason: report.detail || 'The agent reported that it could not finish.',
          } as const)
        : ({
            kind: 'blocked',
            reason: report.detail || 'The agent is waiting for your input.',
          } as const);

  if (report.sessionId !== null && deliverTurnSignal(report.sessionId, signal)) {
    // A watcher took it: the turn ends now instead of after the idle timeout,
    // and the completion card is raised by the orchestrator as usual.
    return;
  }

  const who = report.sessionId === null ? 'An agent' : agentLabel(report.sessionId);

  // No watcher took it, so this report ends no turn — but the agent still said
  // something the user asked to be told, and a toast is gone in eight seconds.
  // Filing it as a completion card puts it in the inbox, where it waits.
  //
  // Imported lazily because `stores/orchestrator` imports `stores/terminal`,
  // which imports this module: a static import would close that cycle.
  const { recordUnwatchedAgentReport } = await import('./orchestrator');
  const result = recordUnwatchedAgentReport(report.sessionId, signal, who);
  if (result?.kind === 'duplicate') return;
  const filedUnder = result?.projectId ?? null;

  // The card is the notification whenever the user is looking at the project it
  // was filed under — raising a toast as well is the double-notification the
  // inbox work removed. A report belonging to a *background* project would
  // otherwise be silent until the user switched to it, which is the wrong
  // failure for a "needs input", so that one still interrupts.
  if (filedUnder && (filedUnder === getActiveTerminalProjectId() || shouldUseSystemNotification())) return;

  const what =
    report.state === 'done'
      ? 'finished'
      : report.state === 'failed'
        ? 'failed'
        : 'needs your input';
  const text = report.detail ? `${who} ${what}: ${report.detail}` : `${who} ${what}`;
  const tone = report.state === 'failed' ? 'error' : report.state === 'done' ? 'success' : 'warning';

  // showToast mirrors to the OS whenever the app is out of focus, which is the
  // whole case a "needs input" report exists for.
  showToast(text, tone, 8000);
}

/** The agent's display name, or a neutral fallback if it has already gone. */
function agentLabel(sessionId: number): string {
  const all = get(sessions);
  const session = all.find((s) => s.id === sessionId);
  return session ? getSessionLabel(session, all) : 'An agent';
}

/**
 * Channels already bound to a live session, so the launch path and the config
 * writer hand one agent ONE token rather than minting a second for the same
 * terminal.
 */
const channelsBySession = new Map<number, AgentChannel>();

/** The channel bound to this session, if it has one. */
export function agentChannelForSession(sessionId: number): AgentChannel | null {
  return channelsBySession.get(sessionId) ?? null;
}

/** Forget a session's channel when its terminal goes away. */
export function forgetAgentChannel(sessionId: number): void {
  channelsBySession.delete(sessionId);
}

/** Mint a per-launch channel, or null when the MCP server isn't running. */
export async function prepareAgentChannel(): Promise<AgentChannel | null> {
  try {
    return await invoke<AgentChannel>('mcp_open_agent_channel');
  } catch (e) {
    // Never fatal: an agent without its own token still gets the shared one and
    // every tool keeps working — its reports just arrive unattributed.
    console.warn('[mcp] Could not mint a per-agent token; reports will be unattributed:', e);
    return null;
  }
}

/** Bind a minted channel to the session that was launched with it. */
export async function bindAgentChannel(
  channel: AgentChannel,
  sessionId: number,
): Promise<void> {
  try {
    const bound = await invoke<boolean>('mcp_bind_agent_channel', {
      token: channel.token,
      sessionId,
    });
    if (!bound) {
      console.warn('[mcp] The MCP server did not recognise this agent token; not bound.');
      return;
    }
    channelsBySession.set(sessionId, channel);
  } catch (e) {
    console.warn('[mcp] Could not bind the per-agent token:', e);
  }
}

/** Drop a channel whose launch never happened. */
export async function discardAgentChannel(channel: AgentChannel): Promise<void> {
  try {
    await invoke('mcp_close_agent_channel', { token: channel.token });
  } catch {
    /* the server is gone; the token died with it */
  }
}

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
  // The server drops this session's per-launch tokens inside `unregister_agent`
  // (a dead session's token must stop authenticating), so the local mirror is
  // cleared here rather than at every caller.
  forgetAgentChannel(sessionId);
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
  /**
   * Where the user chose for it to run, asked by the calling agent:
   * 'new_worktree' | 'main' | 'existing'. Older servers omit it, which keeps
   * the previous isolated-by-default behaviour.
   */
  workspace?: string;
  /** Absolute path of the existing worktree (already validated by the server). */
  worktree_path?: string;
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
    // A headless DeepSeek worker exits when its task is done, leaving a bare
    // shell: typed feedback would run as a shell command. Refuse instead.
    if (isDeepSeekWorkerSession(session_id)) {
      throw new Error(
        'DeepSeek Harness workers run one task and exit, so they cannot take follow-up messages. Delegate a new task that includes the feedback instead.',
      );
    }
    delivered = await sendOrchestratorFollowUpWhenReady(session_id, message);
    if (!delivered) {
      // The distinction matters to the caller: a dead pane is permanent, a
      // rejected send is worth retrying.
      const alive = get(sessions).some((s) => s.id === session_id && s.isRunning);
      error = alive
        ? 'The agent did not accept the message. Its CLI may be busy or not at a prompt.'
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
/**
 * Mirror every agent's turn phase into the MCP server, so `list_agents` can
 * tell one agent whether another is working, blocked or done. `agentTurnStates`
 * already merges every report path (MCP report_status, CLI hooks, the turn
 * file), so agents that never call the MCP tool still show a real status.
 */
function syncAgentStatusesToMcp(): void {
  const sent = new Map<number, string>();
  agentTurnStates.subscribe((all) => {
    for (const [key, turn] of Object.entries(all)) {
      const sessionId = Number(key);
      const signature = `${turn.phase}|${turn.since}|${turn.task ?? ''}`;
      if (sent.get(sessionId) === signature) continue;
      sent.set(sessionId, signature);
      void invoke('mcp_set_agent_status', { sessionId, phase: turn.phase, task: turn.task ?? null, since: turn.since })
        .catch((e) => console.warn('Could not share agent status with the MCP server:', e));
    }
  });
}

export function initMcpBridge(): void {
  if (initialized) return;
  initialized = true;
  syncAgentStatusesToMcp();

  // Keep the server's agent roster live. The stores fire immediately on
  // subscribe, so this doubles as the initial push, and again on every add,
  // edit, or removal — a custom agent the user creates mid-session is
  // delegatable without an app restart. `usageState` is subscribed too so the
  // roster narrows to installed agents the moment the detection scan lands
  // (see `getAgentRoster` in runs.ts) instead of holding the unfiltered list
  // until something else changes.
  const publishRoster = () => {
    setMcpAgentPresets(getAgentRoster());
  };
  customAgents.subscribe(publishRoster);
  removedPresetAgents.subscribe(publishRoster);
  usageState.subscribe(publishRoster);

  // The server names delegated workers itself (a worker's name is the handle it
  // returns, so it cannot wait for the frontend), and it draws from this list so
  // those names match the ones the app gives agents the user spawns. Fixed at
  // build time, so one push at startup is all it needs.
  void setMcpAssistantNames(ASSISTANT_NAMES);

  // The chat's browser follows the same switch as the agents' (Settings →
  // Agents → Browser), so turning it off takes the tools away from both.
  agentBrowserTools.subscribe((on) => setBrowserToolsAvailable(on === true));

  // The chat uses the same MCP servers the agents get (Settings > MCP).
  mcpServers.subscribe((servers) => syncChatMcpServers(servers ?? []));

  // Plugin skills: re-copied once per launch, so agents installed since a
  // plugin was (and earlier copies) get the current set. Loaded lazily; it
  // only matters once the app is up.
  void import('$lib/services/plugins')
    .then(({ syncPluginSkills }) => syncPluginSkills())
    .catch((e) => console.warn('[plugins] Could not sync plugin skills:', e));

  // ...and the agents get them without reopening the project. The configs used
  // to be rewritten only on project open and agent launch, so a server added in
  // Settings stayed invisible to every CLI until then. Skips each store's
  // initial fire: project open already writes everything once.
  let seenServers = false;
  mcpServers.subscribe(() => {
    if (seenServers) scheduleMcpConfigResync();
    seenServers = true;
  });
  let seenBrowser = false;
  agentBrowserTools.subscribe(() => {
    if (seenBrowser) scheduleMcpConfigResync();
    seenBrowser = true;
  });

  // `generate_image` / `generate_video` run in Rust for agents, but the
  // provider choice and model map live in Settings here.
  mediaGeneration.subscribe((settings) => {
    invoke('mcp_set_media_settings', { settings }).catch((e) =>
      console.warn('[mcp] Could not publish media settings to the MCP server:', e),
    );
  });

  // An agent reporting on its own turn. This is the deterministic counterpart
  // to the screen-scraping in `agent-turn-watch.ts`: instead of matching an
  // English phrase against the PTY tail and hoping, the agent says what it is
  // doing, and the MCP server attaches the session identity its *token* proved
  // (never anything the agent claimed — see `authorize` in mcp/mod.rs).
  //
  // `sessionId` is null when the caller authenticated with the app-wide token,
  // which every agent shares. Such a report is still shown, because "an agent
  // needs you" beats silence — but it cannot end a turn, since there is no way
  // to know whose turn it was.
  listen<AgentReportEvent>('mcp:agent-report', (event) => {
    void handleAgentReport(event.payload);
  });

  listen<SpawnRequest>('mcp:spawn-agent', async (event) => {
    const { preset, prompt, name: requestedName, workspace = 'new_worktree', worktree_path: existingPath } = event.payload;
    console.log(`[mcp] Spawning agent: ${preset}${prompt ? ` (prompt: ${prompt})` : ''}`);

    try {
      // A DeepSeek worker without a task would be an idle shell: it runs one
      // task per launch, delivered below as its goal.
      if (isDeepSeekHarness(preset) && !prompt?.trim()) {
        throw new Error('DeepSeek Harness needs a task to start. Use delegate_task with a prompt.');
      }

      // The calling agent asks the user where this agent should work and passes
      // the answer (the MCP server refuses a spawn without one). 'new_worktree'
      // is the isolated default: without it every worker edits the SAME working
      // tree concurrently, and two workers touching one file clobber each other;
      // the reconciler stages the branch back into the main checkout on its own.
      // 'main' runs in the project root, and 'existing' in a worktree the user
      // named — neither is registered for reconcile or cleanup, because the
      // user owns those checkouts and closing the pane must not delete them.
      const projectId = getActiveTerminalProjectId();
      let worktree: WorktreeInfo | null = null;
      const cwd = workspace === 'existing' ? existingPath || undefined : undefined;
      if (workspace === 'existing' && !cwd) throw new Error('The chosen worktree was not found.');
      if (projectId && workspace === 'new_worktree') {
        worktree = await createTaskWorktree({
          projectId,
          // No OrchestratorTask backs an MCP spawn, so synthesize the id the
          // branch name is derived from. `mcp_` keeps these identifiable on disk.
          taskId: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          label: preset,
        });
      }
      if (!projectId) throw new Error('Open a project first to create an isolated worktree.');

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
      const sessionId = await spawnAgentPreset(preset, worktree?.path ?? cwd, {
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
      showToast(e instanceof Error ? e.message : String(e), 'error');
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
// Playwright MCP — the agent's browser
// ---------------------------------------------------------------------------

/**
 * Microsoft's Playwright MCP server (`@playwright/mcp`), launched on demand
 * through npx and written into the same agent configs as `spacron-mcp`.
 *
 * This is what lets an agent open the page it just built, read it, and fix what
 * is wrong. Spacron does not implement any of it — Playwright already solves
 * browser automation properly (auto-waiting, the accessibility tree rather than
 * screenshots, console and network access), and a hand-rolled version would be a
 * worse copy that we would then own.
 *
 * Both flags are load-bearing:
 *
 * `-y` — without it, the first launch on a machine that hasn't cached the
 * package makes npx ask "Ok to proceed?", and a stdio MCP server has nobody to
 * answer that prompt. It hangs at startup and the agent just sees a server that
 * never becomes ready.
 *
 * `--isolated` — Playwright MCP defaults to a *persistent* browser profile, and
 * upstream is explicit that one profile can only be used by one browser instance
 * at a time. Spacron's whole model is several agents running at once, so the
 * default would mean the first agent's browser takes the profile lock and every
 * other agent's Playwright fails to start. Isolated sessions keep nothing on
 * disk, which is also the right default for "open the thing I just built and
 * look at it" — a clean browser each run, no stale login state.
 */
const PLAYWRIGHT_COMMAND = 'npx';

/**
 * The Playwright MCP version every Spacron browser runs. It was `@latest`,
 * which made npm re-resolve the tag on every launch (~28 s warm on Windows)
 * and let an upstream release change the tools under us. Must equal
 * `PLAYWRIGHT_MCP_VERSION` in `src-tauri/src/commands/browser_tools.rs` — a
 * test reads that line — because Rust installs it and runs the chat's browser.
 */
export const PLAYWRIGHT_MCP_VERSION = '0.0.82';

/**
 * Where the pinned server is installed and where its output goes, from Rust.
 * Fetched once per app run (and again after an install from Settings); while
 * unknown, or when not installed, agents get the pinned npx command instead.
 */
interface BrowserToolsStatus {
  version: string;
  cliPath: string | null;
  installedVersion: string | null;
  outputDir: string;
}
let browserStatus: Promise<BrowserToolsStatus | null> | null = null;

function browserToolsStatus(): Promise<BrowserToolsStatus | null> {
  if (!browserStatus) {
    browserStatus = invoke<BrowserToolsStatus>('browser_tools_status')
      .then((s) => (s && typeof s === 'object' ? s : null))
      .catch(() => null);
  }
  return browserStatus;
}

/** Re-read the install after Settings installed or removed it. */
export function refreshBrowserToolsStatus(): Promise<BrowserToolsStatus | null> {
  browserStatus = null;
  return browserToolsStatus();
}

/** The saved sign-in for a project, when the user made one (Settings). */
async function projectSignInState(projectRoot: string | null | undefined): Promise<string | null> {
  if (!projectRoot) return null;
  try {
    const state = await invoke<{ path: string; exists: boolean }>('browser_sign_in_state', { projectRoot });
    return state?.exists ? state.path : null;
  } catch {
    return null;
  }
}

/**
 * The argv that starts the agent browser.
 *
 * `node <cli.js>` from the pinned install when present (~1.3 s), else the
 * pinned npx (`-y`, see above). Always `--isolated`. `--output-dir` keeps
 * snapshots and screenshots out of the project: Playwright's default is the
 * current directory, which for an agent is the user's repo. With a project
 * sign-in, `--storage-state` starts each agent's isolated browser from it —
 * signed in, yet with no shared profile, so parallel agents do not collide.
 *
 * `projectRoot` is `null` for the global configs (Codex, droid): one file
 * serves every project, so it can never carry one project's sign-in.
 */
async function playwrightArgv(projectRoot: string | null | undefined): Promise<{ command: string; args: string[] }> {
  const status = await browserToolsStatus();
  const storageState = await projectSignInState(projectRoot);
  const extra = [
    '--isolated',
    ...(status?.outputDir ? ['--output-dir', status.outputDir] : []),
    ...(storageState ? ['--storage-state', storageState] : []),
  ];
  if (status?.cliPath) return { command: 'node', args: [status.cliPath, ...extra] };
  return { command: PLAYWRIGHT_COMMAND, args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, ...extra] };
}

/**
 * Our key for it, in every config file.
 *
 * Deliberately *not* the bare `playwright` that the upstream docs use. These
 * writers merge into files the user also edits by hand, and the setting can be
 * turned off — which has to remove the entry again, or a toggle that only ever
 * adds would leave dead servers behind forever. Owning a distinctly-named key
 * means the removal can never delete a `playwright` server the user configured
 * themselves.
 */
const BROWSER_SERVER_KEY = 'spacron-playwright';

/** The `{ command, args }` shape every CLI here uses except opencode. */
async function playwrightStdioEntry(projectRoot: string | null | undefined) {
  return playwrightArgv(projectRoot);
}

/**
 * opencode takes the executable and its arguments as one flat array under
 * `type: "local"`, and wants `enabled` set explicitly — the same divergence its
 * remote entries already have.
 */
async function playwrightOpencodeEntry(projectRoot: string | null | undefined) {
  const { command, args } = await playwrightArgv(projectRoot);
  return { type: 'local', command: [command, ...args], enabled: true };
}

/**
 * How long an agent should wait for the browser server to finish starting.
 *
 * `npx -y @playwright/mcp@latest` is far slower to start than any CLI's default
 * allows, and the `@latest` tag is why: npm re-resolves the tag against the
 * registry on every single launch, so the cost is paid even on a warm cache.
 * Measured on Windows, package already downloaded, just printing its version:
 *
 *   `npx -y @playwright/mcp@latest --version`   27.8s
 *   `npx -y @playwright/mcp@0.0.79 --version`   17.5s
 *
 * That is before Playwright does any work at all. Codex's 10s default and
 * Claude Code's 30s default both fall inside that window, so the server was
 * timing out on launch and the agent simply had no browser tools — with nothing
 * in the UI to say why. A first run that still has to download the package and
 * a browser is slower again, which is what this number is really sized for.
 *
 * Erring long is the safe direction: a too-short timeout breaks the server
 * outright, while a too-long one only delays the error message for a server
 * that was never going to start.
 *
 * Claude Code takes the same budget through `MCP_TIMEOUT` in the agent's PTY
 * environment rather than through a config file — see `terminal.ts`. Keep the
 * two in step; they are sizing the same npx cold start.
 */
export const BROWSER_STARTUP_TIMEOUT_SEC = 120;

/**
 * Tool-call budget for `spacron-mcp` where a CLI's default is too short.
 * `generate_video` polls the provider for minutes; Codex's default is 60s.
 * Mirrors `MEDIA_TIMEOUT` in `src-tauri/src/mcp/mod.rs`, with headroom.
 */
export const MEDIA_TOOL_TIMEOUT_SEC = 900;

/** The same budget in milliseconds, for CLIs whose knob is an env var. */
export const BROWSER_STARTUP_TIMEOUT_MS = BROWSER_STARTUP_TIMEOUT_SEC * 1000;

/**
 * How long a single MCP *tool call* may run, once the server is up.
 *
 * Separate from the startup budget and necessarily larger: starting is a
 * one-off, but a browser tool call navigates a real page, waits on real network
 * and can legitimately take minutes on a slow site. Claude Code's default here
 * is generous already; this only stops a genuinely slow page load from being
 * reported to the agent as a broken tool.
 */
export const BROWSER_TOOL_TIMEOUT_MS = 180_000;

/** Whether the user has opted into giving agents a browser. Off by default. */
function wantsBrowserTools(): boolean {
  try {
    return get(agentBrowserTools) === true;
  } catch {
    // Store not initialised (tests, non-browser contexts). Treat as off: adding
    // a browser nobody asked for is worse than omitting one they did.
    return false;
  }
}

// ---------------------------------------------------------------------------
// User-managed MCP servers
// ---------------------------------------------------------------------------

/**
 * The user's server list, or empty when the store is not initialised (tests,
 * non-browser contexts). Empty is the safe reading: it writes no servers, and
 * the prune below then removes any we wrote earlier — which is wrong but
 * recoverable on the next real project open, whereas guessing a list is not.
 */
function userServers(): McpServer[] {
  try {
    const value = get(mcpServers);
    // Every writer fetches the HTTP URL before calling this, so the cache is
    // warm; signed-in servers then go through Spacron's proxy.
    return Array.isArray(value) ? withSignInProxy(value, serverHttpUrl) : [];
  } catch {
    return [];
  }
}

/**
 * Keys already in a config file's server section.
 *
 * Pruning needs them: a server the user deleted leaves a `spacron-` key behind
 * that nothing in the desired set mentions, so the only way to find it is to
 * look at what is actually in the file. See invariant 2 in `mcp-servers.ts`.
 */
function sectionKeys(config: Record<string, unknown>, section: string): string[] {
  const servers = config[section];
  return servers && typeof servers === 'object' ? Object.keys(servers as object) : [];
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
 * | Qwen Code   | `.qwen/settings.json`       | streamable HTTP  |
 * | Kiro CLI    | `.kiro/settings/mcp.json`   | streamable HTTP  |
 * | Amp         | `.amp/settings.json`        | streamable HTTP  |
 * | Devin CLI   | `.devin/config.local.json`  | streamable HTTP  |
 * | Antigravity | `~/.gemini/config/mcp_config.json` | streamable HTTP |
 * | Copilot CLI, Qoder CLI | `.mcp.json` (read as a workspace file) | SSE |
 *
 * Codex and droid have no project-scoped MCP config, so their entries are
 * global. That rests on the server's port and token being stable across
 * restarts (see `load_or_create_token` and `DEFAULT_MCP_PORT` in
 * `src-tauri/src/mcp/mod.rs`) — before that, a global entry went stale the
 * moment the app was restarted.
 *
 * The token is genuinely stable. The port only is while `DEFAULT_MCP_PORT` is
 * free: a second Spacron instance can't bind it, falls back to an OS-assigned
 * port, and rewrites these machine-wide files to a URL that dies with it. See
 * `warnIfGlobalConfigPortIsEphemeral`, which is where that case is caught.
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
    case 'qwen':
      await injectQwenConfig(projectRoot, httpUrl);
      break;
    case 'kiro-cli':
      await injectKiroConfig(projectRoot, httpUrl);
      break;
    case 'amp':
      await injectAmpConfig(projectRoot, httpUrl);
      break;
    case 'devin':
      await injectDevinConfig(projectRoot, httpUrl);
      break;
    case 'agy':
      await injectAntigravityConfig(httpUrl);
      break;
    case 'copilot':
    case 'qodercli':
      // Both read the project `.mcp.json` written above as a workspace config
      // (`copilot mcp list` / `qodercli mcp list` show it, checked 2026-10-12).
      break;
    case 'dsh':
      // DeepSeek Harness gets the server from a `--patch` file on its command
      // line, with the URL in its launch env — nothing to write here. See
      // `services/deepseek-harness.ts`.
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
        `[mcp] No MCP config surface known for "${agentExecutable(preset) || preset}". ` +
          `it launches without Spacron tools (no list_agents / send_to_agent / delegate_task). ` +
          `Supported: claude, codex, gemini, opencode, droid, cursor, qwen, kiro-cli, amp, devin, agy, copilot, qodercli.`,
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
 * It is written to the **app config dir**, not into the project. Its content is
 * app-global (server URL + browser-tools toggle), so a copy per repo bought
 * nothing while putting the server's auth token in the user's working tree.
 *
 * Returns `''` on any failure: an agent with no cross-agent tools is worse than
 * one with them, but far better than one that fails to launch.
 */
async function writeRemoteLaunchConfig(projectRoot: string, sessionId: number | undefined, content: string): Promise<string> {
  const path = `${projectRoot}/.spacron/mcp-launch-${sessionId ?? 'shared'}.json`;
  await backendInvoke('fs_write_file', { path, content });
  return path;
}

export async function mcpLaunchFlags(
  preset: string,
  projectRoot?: string,
  sessionId?: number,
): Promise<string> {
  if (!CLAUDE_EXECUTABLES.has(agentExecutable(preset))) return '';
  if (!projectRoot) return '';

  try {
    // A per-launch token when we know which session this launch belongs to, so
    // this agent's `report_status` calls are attributable to it rather than to
    // "some agent on this machine". This is the one config surface that is
    // genuinely per-launch — every other CLI here discovers the server from a
    // shared config file, so their reports arrive unattributed. Widening that
    // means giving those CLIs a per-launch config of their own.
    //
    // Bound immediately rather than in a second step, because unlike the hook
    // channel the PTY session already exists here: the agent is launched by
    // typing into a terminal that is already open.
    let url: string | null = null;
    if (sessionId !== undefined) {
      // Reuse the channel the spawn path already bound for this terminal —
      // one agent, one token. Minting a second here would work but would leave
      // the env var and the transport disagreeing about which token is "this
      // agent's", which is exactly the kind of thing that reads as a bug later.
      let channel = agentChannelForSession(sessionId);
      if (!channel) {
        channel = await prepareAgentChannel();
        if (channel) await bindAgentChannel(channel, sessionId);
      }
      if (channel) url = channel.url;
    }
    // No URL means the MCP server never came up. Writing a config pointing at
    // nothing would leave the agent retrying a dead endpoint on every tool call.
    url = url ?? (await getMcpUrl());
    if (!url) return '';

    // `type: 'sse'` is required: the Rust server speaks SSE, and a bare `url`
    // is treated as streamable HTTP, which it does not serve.
    const servers: Record<string, unknown> = { 'spacron-mcp': { type: 'sse', url } };
    // This file is rewritten on every launch, so an omitted entry is already a
    // removed one — no delete branch needed here, unlike the merging writers.
    if (wantsBrowserTools()) servers[BROWSER_SERVER_KEY] = await playwrightStdioEntry(projectRoot);
    for (const { key, server } of enabledServers(userServers())) {
      servers[key] = standardEntry(server);
    }
    const content = JSON.stringify({ mcpServers: servers }, null, 2);
    // On a remote the agent runs on the box, so its config has to be there too.
    // It goes in `.spacron/` (excluded from git by ensureMcpConfigsIgnored), one
    // file per session so concurrent launches never read each other's token.
    const configPath = get(remoteTarget)
      ? await writeRemoteLaunchConfig(projectRoot, sessionId, content)
      : await invoke<string>('mcp_write_launch_config', { content });
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
  lastConfiguredRoot = projectRoot;
  try {
    const sseUrl = await getMcpUrl();
    const httpUrl = await getMcpHttpUrl();

    // Before writing anything: every file below carries `?token=`, and they land
    // inside the user's repo. See `ensureMcpConfigsIgnored`.
    await ensureMcpConfigsIgnored(projectRoot);

    await Promise.allSettled([
      removeLegacyClaudeConfig(projectRoot),
      injectProjectMcpJson(projectRoot, sseUrl),
      injectGeminiConfig(projectRoot, httpUrl),
      injectOpencodeConfig(projectRoot, httpUrl),
      injectCursorConfig(projectRoot, httpUrl),
      injectQwenConfig(projectRoot, httpUrl),
      injectKiroConfig(projectRoot, httpUrl),
      injectAmpConfig(projectRoot, httpUrl),
      injectDevinConfig(projectRoot, httpUrl),
      injectCodexConfig(httpUrl),
      injectDroidConfig(httpUrl),
      injectAntigravityConfig(httpUrl),
      injectDeepSeekServers(),
    ]);
  } catch (e) {
    console.warn('[mcp] Could not write agent MCP configs on project open:', e);
  }
}

/** The project `ensureMcpConfigs` last wrote, for a resync after a settings change. */
let lastConfiguredRoot: string | null = null;
let resyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Rewrite every CLI's config for the open project, debounced so typing in the
 * MCP editor does not rewrite a dozen files per keystroke-save.
 */
function scheduleMcpConfigResync(): void {
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    if (lastConfiguredRoot) void ensureMcpConfigs(lastConfiguredRoot);
  }, 400);
}

/**
 * Delete the Claude Code MCP config Spacron used to write into the project at
 * `.spacron/mcp/claude.json`.
 *
 * `mcpLaunchFlags` now writes this to the app config dir, but that alone only
 * stops *new* copies appearing — every project that ever launched a Claude agent
 * still holds the old file, and it carries a live `?token=` granting process
 * spawning and PTY-write. Leaving it there would keep the exact exposure the
 * move was meant to end, indefinitely.
 *
 * Best-effort and idempotent: a project that never had one just gets a failed
 * delete, which is why this is fire-and-forget inside `Promise.allSettled`.
 */
async function removeLegacyClaudeConfig(projectRoot: string): Promise<void> {
  const root = projectRoot?.replace(/[\\/]+$/, '');
  if (!root) return;
  try {
    await backendInvoke('fs_delete', { path: `${root}/.spacron/mcp/claude.json` });
  } catch {
    // Never existed, or already cleaned up.
  }
}

/**
 * Project-relative paths this module writes that contain the MCP token.
 *
 * The Claude Code config written by `mcpLaunchFlags` is no longer among them —
 * it now lives in the app config dir, so the token never enters the working tree
 * at all. The `.spacron/` data directory is covered separately, by
 * SPACRON_SCRATCH_RULES below: it needs a rule shape a flat path list cannot
 * express.
 */
const TOKEN_BEARING_PATHS = [
  '.mcp.json',
  '.gemini/settings.json',
  '.cursor/mcp.json',
  'opencode.json',
  '.qwen/settings.json',
  '.kiro/settings/mcp.json',
  '.amp/settings.json',
  '.devin/config.local.json',
];

/**
 * The `.spacron/` runtime-scratch rule, and the one exception to it.
 *
 * `/.spacron/*` rather than `/.spacron/` is load-bearing: **git never descends
 * into an excluded directory**, so a `!` re-include for anything underneath one
 * is never even evaluated. Excluding the *contents* is the only arrangement in
 * which the exception can take effect.
 *
 * A bare `/.spacron/` here is not a harmless synonym for it. That form hides the
 * shared agent memory — notes whose whole purpose is to be committed — and makes
 * `git add` on one of them fail outright with “paths are ignored by one of your
 * .gitignore files”, which is what the Source Control pane reports as a failure
 * to stage.
 *
 * These mirror `SPACRON_EXCLUDE_RULE` / `SPACRON_MEMORY_EXCEPTION` in
 * `workspace.rs`, which manages the same two lines for worktree creation. Both
 * writers have to emit the identical pair: the Rust side actively migrates the
 * legacy bare form away, so anything here that re-appends it just undoes that
 * repair on the next project open.
 */
const SPACRON_EXCLUDE_RULE = '/.spacron/*';
const SPACRON_MEMORY_EXCEPTION = '!/.spacron/memory/';
const SPACRON_SCRATCH_RULES = [SPACRON_EXCLUDE_RULE, SPACRON_MEMORY_EXCEPTION];

/**
 * A leading `/` is redundant for a pattern that already contains a slash, so
 * `/.spacron/*` and `.spacron/*` are the same rule. Normalising lets the
 * present-check see a rule the Rust writer (or the user) spelled the other
 * way, instead of appending a second copy on every project open.
 *
 * The slash to strip on a negation sits AFTER the `!`, not at the start.
 */
function normalizeRule(rule: string): string {
  return rule.trim().replace(/^(!?)\//, '$1');
}

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
      current = await backendInvoke<string>('fs_read_file', { path: excludePath });
    } catch {
      // No exclude file (or no .git at all) — a fresh one is still valid.
    }

    const present = new Set(
      current.split('\n').map((line) => normalizeRule(line)),
    );
    const has = (rule: string) => present.has(normalizeRule(rule));

    // Emitted as a unit when the rule is absent: the exception only takes effect
    // when it FOLLOWS the rule, so re-adding the rule after a stray exception
    // would silently re-exclude the memory directory.
    const scratch = !has(SPACRON_EXCLUDE_RULE)
      ? SPACRON_SCRATCH_RULES
      : has(SPACRON_MEMORY_EXCEPTION)
        ? []
        : [SPACRON_MEMORY_EXCEPTION];

    const missing = [...TOKEN_BEARING_PATHS.filter((p) => !has(p)), ...scratch];
    if (!missing.length) return;

    const header = '# Spacron: local MCP configs. These carry the MCP server token.';
    const body = current.includes(header) ? missing.join('\n') : [header, ...missing].join('\n');
    const separator = current.length && !current.endsWith('\n') ? '\n' : '';

    await backendInvoke('fs_write_file', {
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
      const existing = await backendInvoke<string>('fs_read_file', { path: configPath });
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }

    const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    servers['spacron-mcp'] = { type: 'sse', url: mcpUrl };
    if (wantsBrowserTools()) servers[BROWSER_SERVER_KEY] = await playwrightStdioEntry(projectRoot);
    else delete servers[BROWSER_SERVER_KEY];
    for (const [key, entry] of Object.entries(mergeMap(userServers(), Object.keys(servers), standardEntry))) {
      if (entry === null) delete servers[key];
      else servers[key] = entry;
    }
    config['mcpServers'] = servers;

    await backendInvoke('fs_write_file', {
      path: configPath,
      content: JSON.stringify(config, null, 2) + '\n',
    });
  } catch (e) {
    console.warn('[mcp] Failed to write .mcp.json:', e);
  }
}

/**
 * Merge server entries into a JSON config file's `[section]` object, preserving
 * whatever else is in it.
 *
 * Every CLI here keeps its servers under one top-level object and differs only
 * in the key name and the shape of the entry, so the read-merge-write dance is
 * written once. Best-effort by contract: callers treat a failure as "this agent
 * launches without Spacron tools", never as a launch error.
 *
 * A `null` value removes that key instead of writing it — how a server the user
 * has switched off gets cleaned out of configs we previously wrote.
 */
async function mergeJsonMcpConfig(
  configPath: string,
  section: string,
  entries:
    | Record<string, unknown | null>
    | ((existingKeys: string[]) => Record<string, unknown | null>),
  label: string,
): Promise<void> {
  try {
    let config: Record<string, unknown> = {};
    try {
      const existing = await backendInvoke<string>('fs_read_file', { path: configPath });
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }

    const servers = (config[section] as Record<string, unknown>) ?? {};
    // A callback form is what lets a caller prune: the keys it has to delete
    // are the stale `spacron-` ones already in the file, which are only known
    // once it has been read.
    const resolved =
      typeof entries === 'function' ? entries(sectionKeys(config, section)) : entries;
    for (const [name, entry] of Object.entries(resolved)) {
      if (entry === null) delete servers[name];
      else servers[name] = entry;
    }
    config[section] = servers;

    await backendInvoke('fs_write_file', {
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
  const browser = wantsBrowserTools() ? await playwrightStdioEntry(projectRoot) : null;
  await mergeJsonMcpConfig(
    `${projectRoot}/.cursor/mcp.json`,
    'mcpServers',
    (keys) => ({
      'spacron-mcp': { type: 'http', url: httpUrl },
      [BROWSER_SERVER_KEY]: browser,
      ...mergeMap(userServers(), keys, standardEntry),
    }),
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
  const browser = wantsBrowserTools() ? await playwrightStdioEntry(projectRoot) : null;
  await mergeJsonMcpConfig(
    `${projectRoot}/.gemini/settings.json`,
    'mcpServers',
    (keys) => ({
      'spacron-mcp': { type: 'http', url: httpUrl },
      [BROWSER_SERVER_KEY]: browser,
      ...mergeMap(userServers(), keys, standardEntry),
    }),
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
  const browser = wantsBrowserTools() ? await playwrightOpencodeEntry(projectRoot) : null;
  await mergeJsonMcpConfig(
    `${projectRoot}/opencode.json`,
    'mcp',
    (keys) => ({
      'spacron-mcp': { type: 'remote', url: httpUrl, enabled: true },
      [BROWSER_SERVER_KEY]: browser,
      ...mergeMap(userServers(), keys, opencodeEntry),
    }),
    'opencode',
  );
}

/** Qwen Code — project `.qwen/settings.json`. See `qwenEntry` for its keys. */
async function injectQwenConfig(projectRoot: string | undefined, httpUrl: string): Promise<void> {
  if (!projectRoot) return;
  const browser = wantsBrowserTools() ? await playwrightStdioEntry(projectRoot) : null;
  await mergeJsonMcpConfig(
    `${projectRoot}/.qwen/settings.json`,
    'mcpServers',
    (keys) => ({
      'spacron-mcp': { httpUrl },
      [BROWSER_SERVER_KEY]: browser,
      ...mergeMap(userServers(), keys, qwenEntry),
    }),
    'Qwen Code',
  );
}

/** Kiro CLI — project `.kiro/settings/mcp.json`, merged over the user file. */
async function injectKiroConfig(projectRoot: string | undefined, httpUrl: string): Promise<void> {
  if (!projectRoot) return;
  const browser = wantsBrowserTools() ? await playwrightStdioEntry(projectRoot) : null;
  await mergeJsonMcpConfig(
    `${projectRoot}/.kiro/settings/mcp.json`,
    'mcpServers',
    (keys) => ({
      'spacron-mcp': { url: httpUrl },
      [BROWSER_SERVER_KEY]: browser,
      ...mergeMap(userServers(), keys, untypedEntry),
    }),
    'Kiro CLI',
  );
}

/**
 * Amp — project `.amp/settings.json`. The section key really is the dotted
 * string `amp.mcpServers`. Amp asks the user once before running servers from
 * a workspace file; that approval is Amp's, not something to bypass.
 */
async function injectAmpConfig(projectRoot: string | undefined, httpUrl: string): Promise<void> {
  if (!projectRoot) return;
  const browser = wantsBrowserTools() ? await playwrightStdioEntry(projectRoot) : null;
  await mergeJsonMcpConfig(
    `${projectRoot}/.amp/settings.json`,
    'amp.mcpServers',
    (keys) => ({
      'spacron-mcp': { url: httpUrl },
      [BROWSER_SERVER_KEY]: browser,
      ...mergeMap(userServers(), keys, untypedEntry),
    }),
    'Amp',
  );
}

/**
 * Devin CLI — project `.devin/config.local.json`, its "not committed" scope.
 * `.devin/config.json` is the committed one, the wrong home for a file that
 * carries the MCP token.
 */
async function injectDevinConfig(projectRoot: string | undefined, httpUrl: string): Promise<void> {
  if (!projectRoot) return;
  const browser = wantsBrowserTools() ? await playwrightStdioEntry(projectRoot) : null;
  await mergeJsonMcpConfig(
    `${projectRoot}/.devin/config.local.json`,
    'mcpServers',
    (keys) => ({
      'spacron-mcp': { url: httpUrl, transport: 'http' },
      [BROWSER_SERVER_KEY]: browser ? { ...browser, transport: 'stdio' } : null,
      ...mergeMap(userServers(), keys, devinEntry),
    }),
    'Devin CLI',
  );
}

/**
 * DeepSeek Harness: the user's servers as an extra `--patch` file both of its
 * launches add (`deepseek_harness.rs`). Spacron's own server already reaches
 * it through `spacron-mcp.patch.yml`.
 */
async function injectDeepSeekServers(): Promise<void> {
  try {
    await invoke('deepseek_harness_set_user_mcp', { content: deepSeekMcpPatch(get(mcpServers) ?? []) });
  } catch (e) {
    console.warn('[mcp] Could not write the DeepSeek Harness server patch:', e);
  }
}

/**
 * Antigravity CLI (`agy`) — global `~/.gemini/config/mcp_config.json`, the
 * file `agy mcp add` writes; it has no project scope. Same global-file caveats
 * as droid.
 */
async function injectAntigravityConfig(httpUrl: string): Promise<void> {
  try {
    await warnIfGlobalConfigPortIsEphemeral('agy');
    const existing = await invoke<string>('mcp_read_global_agent_config', { agent: 'agy' });
    let config: Record<string, unknown> = {};
    try {
      config = existing.trim() ? JSON.parse(existing) : {};
    } catch {
      // Unlike droid, never start fresh: Google's other tools read this file
      // too, and replacing it would drop their servers.
      console.warn('[mcp] ~/.gemini/config/mcp_config.json is not valid JSON; leaving it alone.');
      return;
    }
    const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    servers['spacron-mcp'] = { serverUrl: httpUrl, disabled: false };
    if (wantsBrowserTools()) servers[BROWSER_SERVER_KEY] = await playwrightStdioEntry(null);
    else delete servers[BROWSER_SERVER_KEY];
    for (const [key, entry] of Object.entries(mergeMap(userServers(), Object.keys(servers), antigravityEntry))) {
      if (entry === null) delete servers[key];
      else servers[key] = entry;
    }
    config['mcpServers'] = servers;
    await invoke('mcp_write_global_agent_config', {
      agent: 'agy',
      content: JSON.stringify(config, null, 2) + '\n',
    });
  } catch (e) {
    console.warn('[mcp] Failed to write Antigravity config:', e);
  }
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
    await warnIfGlobalConfigPortIsEphemeral('droid');
    const existing = await invoke<string>('mcp_read_global_agent_config', { agent: 'droid' });

    let config: Record<string, unknown> = {};
    try {
      config = existing.trim() ? JSON.parse(existing) : {};
    } catch {
      // Not valid JSON — start fresh rather than lose the agent's tools.
    }

    const servers = (config['mcpServers'] as Record<string, unknown>) ?? {};
    servers['spacron-mcp'] = { type: 'http', url: httpUrl, disabled: false };
    if (wantsBrowserTools()) servers[BROWSER_SERVER_KEY] = await playwrightStdioEntry(null);
    else delete servers[BROWSER_SERVER_KEY];
    for (const [key, entry] of Object.entries(mergeMap(userServers(), Object.keys(servers), droidEntry))) {
      if (entry === null) delete servers[key];
      else servers[key] = entry;
    }
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
 * The port the MCP server gets when it can have its first choice. Mirrors
 * `DEFAULT_MCP_PORT` in `src-tauri/src/mcp/mod.rs`.
 *
 * Duplicated rather than plumbed through because it feeds only the warning
 * below. If the two ever drift, the cost is a warning that stops firing, not a
 * broken config — so a stale copy here degrades quietly in the safe direction.
 */
const DEFAULT_MCP_PORT = 51379;

/**
 * Shout when a **global** agent config is about to be pointed at an ephemeral
 * port.
 *
 * Codex and droid have no project-scoped MCP config, so their entries are
 * machine-wide. That is fine while the server holds [`DEFAULT_MCP_PORT`], which
 * survives restarts — but the bind falls back to an OS-assigned port whenever
 * the default is taken, and the commonest way for it to be taken is *a second
 * Spacron already running*. When that happens the second instance rewrites the
 * global config to its own throwaway port, and the moment it closes, every
 * Codex session on the machine — in every project, not just this one — is
 * pointing at a dead port. The tools just aren't there, and the CLI reports it
 * as a connection failure that leads nowhere near the real cause.
 *
 * The entry is still written: a URL that works until this instance closes beats
 * no Spacron tools at all, and refusing would break the running instance to
 * protect a future one. But it must not happen silently — this is the single
 * hardest failure in this module to diagnose from the symptom.
 */
async function warnIfGlobalConfigPortIsEphemeral(agent: string): Promise<void> {
  try {
    const port = await getMcpPort();
    if (port === DEFAULT_MCP_PORT) return;
    console.warn(
      `[mcp] Writing ${agent}'s GLOBAL config with ephemeral port ${port} ` +
        `(default ${DEFAULT_MCP_PORT} was taken, most likely by another Spacron instance ` +
        `already has it). This URL dies with this instance, and because the config is ` +
        `machine-wide it will leave every ${agent} session on this machine without Spacron ` +
        `tools once it does. Running a single Spacron instance keeps the port stable.`,
    );
  } catch {
    // Port unavailable (server not up yet, non-Tauri context). The caller's
    // write is best-effort too, so a missing warning must not abort it.
  }
}

/**
 * Remove one TOML table — its `[header]` line plus every key it owns — leaving
 * other tables untouched.
 *
 * The obvious regex form (`/\[header\][^[]*+/`) is a trap here: it stops at the
 * *next* `[` anywhere, and our own blocks contain one (the `args` array in
 * `spacron-playwright`). That left `["-y", …]` orphaned at top level, which
 * parses as an unclosed table and breaks Codex's whole config. Line-based is
 * immune: only a line that starts a new table header ends a block.
 */
function stripTomlTable(content: string, header: string): string {
  return stripTomlTablesWhere(content, (h) => h === header);
}

/**
 * The same removal, for every table whose header matches a predicate.
 *
 * User servers make the set of tables we own dynamic, so a list of exact
 * headers no longer covers it: a server the user deleted or renamed leaves a
 * `[mcp_servers.spacron-*]` table that nothing in the desired set names. Only
 * the file itself knows it is there.
 */
function stripTomlTablesWhere(content: string, matches: (header: string) => boolean): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (dropping && !trimmed.startsWith('[')) continue;
    dropping = trimmed.startsWith('[') && matches(trimmed);
    if (!dropping) kept.push(line);
  }
  return kept.join('\n');
}

/** `[mcp_servers.<key>]` → `<key>`, or null for any other table header. */
function codexServerKey(header: string): string | null {
  const match = header.match(/^\[mcp_servers\.([^\]]+)\]$/);
  return match ? match[1].trim() : null;
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
    await warnIfGlobalConfigPortIsEphemeral('codex');
    let content = await invoke<string>('mcp_read_global_agent_config', { agent: 'codex' });

    // Drop every block we own — each header plus its keys, up to the next
    // table — then write the wanted ones back. Rewriting from scratch is also
    // how the browser server disappears when the user turns it off, and how a
    // user server disappears when they delete or rename it. Tables outside the
    // `spacron-` namespace are never matched, so a server the user configured
    // by hand survives untouched.
    content = stripTomlTablesWhere(content, (header) => {
      const key = codexServerKey(header);
      return key !== null && isSpacronKey(key);
    });

    // `tool_timeout_sec`: Codex gives a tool call 60s by default, and
    // `generate_video` routinely takes several minutes.
    content =
      `${content.trimEnd()}\n\n[mcp_servers.spacron-mcp]\nurl = "${httpUrl}"\n` +
      `tool_timeout_sec = ${MEDIA_TOOL_TIMEOUT_SEC}\n`;

    if (wantsBrowserTools()) {
      // TOML wants the argv split into `command` + `args`, unlike opencode's
      // single array. Codex's config is global, so no project sign-in. Paths
      // may hold backslashes: JSON string escaping is valid TOML escaping.
      const argv = await playwrightStdioEntry(null);
      const args = argv.args.map((a) => JSON.stringify(a)).join(', ');
      content +=
        `\n[mcp_servers.${BROWSER_SERVER_KEY}]\ncommand = ${JSON.stringify(argv.command)}\nargs = [${args}]\n` +
        `startup_timeout_sec = ${BROWSER_STARTUP_TIMEOUT_SEC}\n`;
    }

    for (const { key, server } of enabledServers(userServers())) {
      if (headersLostOnCodex(server)) {
        console.warn(
          `[mcp] Codex has no config key for request headers, so "${server.name}" is written ` +
            `to ~/.codex/config.toml without its auth header. It will work in the other agents ` +
            `and fail to authenticate in Codex.`,
        );
      }
      content += `\n${codexTable(key, server)}`;
    }

    await invoke('mcp_write_global_agent_config', {
      agent: 'codex',
      content: content.trimStart(),
    });
  } catch (e) {
    console.warn('[mcp] Failed to write Codex config:', e);
  }
}
