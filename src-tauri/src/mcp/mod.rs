//! In-app MCP (Model Context Protocol) server.
//!
//! Runs an axum HTTP+SSE server on a local port so that connected CLI agents
//! (Claude Code, Codex, Gemini CLI, …) can discover and call tools that
//! interact with *other* running agents inside the app:
//!
//!   - `list_agents`       — who's running
//!   - `send_to_agent`     — write a message into another agent's PTY
//!   - `read_agent_output` — tail another agent's terminal output
//!   - `spawn_agent`       — request the frontend to launch a new agent
//!
//! The MCP server is purely a protocol bridge: the frontend owns the agent
//! registry, PTY sessions, and spawn logic. The server stores tool requests
//! on internal broadcast channels that the frontend reads via Tauri events
//! or by subscribing to [`McpServerHandle`] channels.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use dashmap::DashMap;
use futures_util::stream::{self, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    convert::Infallible,
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc, Mutex, oneshot};

/// Callback for reading output from a PTY session by session id.
pub type ReadFn = Arc<dyn Fn(u32) -> Vec<u8> + Send + Sync>;

/// Callback for forwarding a spawn-agent request to the frontend.
pub type SpawnFn = Arc<dyn Fn(SpawnRequest) + Send + Sync>;

/// Callback for emitting a browser-tool request to the frontend via Tauri event.
/// Arguments: (request_id, tool_name, args_json).
pub type BrowserEmitFn = Arc<dyn Fn(&str, &str, serde_json::Value) + Send + Sync>;

/// Callback for asking the frontend to deliver a prompt into an agent's TUI.
/// Arguments: (request_id, session_id, message).
pub type DeliverEmitFn = Arc<dyn Fn(&str, u32, &str) + Send + Sync>;

/// A pending browser-tool request awaiting a response from the frontend.
pub struct PendingBrowserRequest {
    pub tx: oneshot::Sender<Result<serde_json::Value, String>>,
    pub created_at: Instant,
}

/// A pending prompt delivery awaiting the frontend's verdict.
///
/// Separate from [`PendingBrowserRequest`] because the timescales are nothing
/// alike: a browser call answers in milliseconds and is swept at 30s, while a
/// delivery may legitimately sit for half a minute waiting for a booting CLI to
/// reach its prompt. Sharing the map would have the sweeper cancel deliveries
/// mid-flight.
pub struct PendingSend {
    pub tx: oneshot::Sender<Result<serde_json::Value, String>>,
    pub created_at: Instant,
}

/// Shared map of in-flight prompt deliveries, keyed by request ID.
pub type PendingSends = Arc<DashMap<String, PendingSend>>;

/// Outbound message channel for one SSE-connected client, keyed by session id.
///
/// The HTTP+SSE transport is asymmetric: requests arrive on `POST /message`, but
/// every response has to travel back down the client's `GET /sse` stream. This
/// map is what connects the two halves — without it a POST handler has no way to
/// reach the stream the client is actually listening on.
type SseSessions = Arc<DashMap<String, mpsc::UnboundedSender<serde_json::Value>>>;

/// Removes an SSE session from the registry when its stream is dropped, so a
/// disconnected client doesn't leave a sender behind that nothing ever reads.
struct SseSessionGuard {
    sessions: SseSessions,
    id: String,
}

impl Drop for SseSessionGuard {
    fn drop(&mut self) {
        self.sessions.remove(&self.id);
    }
}

/// Shared map of in-flight browser requests, keyed by request ID.
pub type PendingRequests = Arc<DashMap<String, PendingBrowserRequest>>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Information about one registered agent session.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentEntry {
    pub session_id: u32,
    pub name: String,
    pub preset: String,
    pub label: String,
    /// The agent's isolated git branch, when it runs in a worktree. This is what
    /// lets an orchestrating agent review a worker's actual change
    /// (`git diff <base>..<branch>`) instead of scraping its terminal — the
    /// report a worker writes says what it believes it did; the diff says what
    /// it did. `None` when the agent runs directly in the main checkout.
    pub branch: Option<String>,
}

/// A request to send a message to a specific agent, emitted by the
/// `send_to_agent` MCP tool. The frontend should pick this up and call
/// `writeToSession()` on the resolved session.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SendToAgentRequest {
    pub target_name: String,
    pub message: String,
    /// Populated by the server from the registry before emitting.
    pub target_session_id: u32,
}

/// A request to read an agent's output.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReadOutputRequest {
    pub target_name: String,
    pub target_session_id: u32,
}

/// One agent the user can actually launch: a built-in preset the app ships, or
/// a custom agent they added themselves. Pushed from the frontend, which owns
/// the roster (built-ins minus the ones the user removed, plus their own).
///
/// The server keeps this only to *describe* and *resolve* what a caller asked
/// for. It never decides what may run — an unrecognised name still launches when
/// the roster is empty, because an empty roster means "not told yet", not "no
/// agents exist".
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentPreset {
    /// The launch command typed into the shell — the canonical id. e.g. `pi`,
    /// `cursor-agent`, `aider --no-auto-commits`.
    pub command: String,
    /// Human label shown in the app's picker, e.g. "Pi AI Agent".
    pub name: String,
}

/// A request to spawn a new agent.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub preset: String,
    pub prompt: String,
    /// Name the caller asked for. Without this the frontend assigns a random
    /// name and the requester has to call `list_agents` afterwards to discover
    /// it — which cannot be done reliably while several spawns are in flight,
    /// since nothing correlates a returned name with the task it was given.
    /// Empty string means "assign one for me".
    pub name: String,
}

/// Always-managed wrapper around the server handle.
///
/// [`start`] can fail — loopback unbindable, or an explicitly requested port
/// already taken — and then there is no handle to hand to `app.manage`. Managing
/// nothing leaves every `mcp_*` command extracting state that was never
/// registered, which Tauri resolves inside the command handler rather than as a
/// `Result` the caller can act on. Managing this wrapper unconditionally turns
/// "the server never came up" into an ordinary error string on every call, which
/// the frontend already handles as "this agent launches without Spacron tools".
pub struct McpServer(pub Option<McpServerHandle>);

impl McpServer {
    /// The live handle, or an error explaining that there isn't one.
    pub fn get(&self) -> Result<&McpServerHandle, String> {
        self.0.as_ref().ok_or_else(|| {
            "The Spacron MCP server is not running, so agents cannot discover or \
             message each other. Check the startup log for the bind failure."
                .to_string()
        })
    }
}

/// Handle returned by [`start`] for interacting with the server.
pub struct McpServerHandle {
    /// The agent registry (name → AgentEntry), shared with the MCP server.
    pub registry: Arc<Mutex<HashMap<String, AgentEntry>>>,
    notify_tx: broadcast::Sender<()>,
    _shutdown_tx: oneshot::Sender<()>,
    /// The port the MCP server is listening on.
    pub port: u16,
    /// Shared secret agents must include as `?token=…` when connecting. Handed
    /// to the frontend so it can write the full URL into each agent's MCP config.
    pub token: String,
    /// In-flight browser-tool requests awaiting frontend responses.
    pub pending_browser: PendingRequests,
    /// In-flight prompt deliveries awaiting frontend responses.
    pub pending_sends: PendingSends,
    /// Active project's main checkout, shared with the server. See `ServerState`.
    pub project_root: Arc<Mutex<Option<String>>>,
    /// Launchable agents, shared with the server. See `ServerState`.
    pub agent_presets: Arc<Mutex<Vec<AgentPreset>>>,
    /// The app's assistant-name pool, shared with the server. See `ServerState`.
    pub assistant_names: Arc<Mutex<Vec<String>>>,
    /// Names handed out but not yet registered. See `ServerState`.
    reserved_names: Arc<Mutex<Vec<NameReservation>>>,
}

impl McpServerHandle {
    /// Register an agent so MCP clients can discover and message it.
    pub async fn register_agent(
        &self,
        session_id: u32,
        name: &str,
        preset: &str,
        label: &str,
        branch: Option<String>,
    ) {
        let entry = AgentEntry {
            session_id,
            name: name.to_string(),
            preset: preset.to_string(),
            label: label.to_string(),
            branch,
        };
        self.registry.lock().await.insert(name.to_string(), entry);
        // The name is in the registry now, so the reservation that kept a
        // concurrent spawn off it has done its job.
        self.reserved_names
            .lock()
            .await
            .retain(|r| !r.name.eq_ignore_ascii_case(name));
        let _ = self.notify_tx.send(());
    }

    /// Unregister an agent by session id.
    pub async fn unregister_agent(&self, session_id: u32) {
        let mut map = self.registry.lock().await;
        map.retain(|_, v| v.session_id != session_id);
        let _ = self.notify_tx.send(());
    }

    /// Ping connected clients to re-read `tools/list`.
    ///
    /// The agent roster is baked into the `spawn_agent` / `delegate_task`
    /// schemas, so an agent that connected before the user added a custom agent
    /// would otherwise never see it.
    pub fn notify_tools_changed(&self) {
        let _ = self.notify_tx.send(());
    }

    /// Resolve a pending browser-tool request with a result from the frontend.
    pub fn resolve_browser_request(
        &self,
        request_id: &str,
        result: Result<serde_json::Value, String>,
    ) {
        if let Some((_, pending)) = self.pending_browser.remove(request_id) {
            let _ = pending.tx.send(result);
        }
    }

    /// Resolve a pending prompt delivery with the frontend's verdict.
    pub fn resolve_send_request(
        &self,
        request_id: &str,
        result: Result<serde_json::Value, String>,
    ) {
        if let Some((_, pending)) = self.pending_sends.remove(request_id) {
            let _ = pending.tx.send(result);
        }
    }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/// Default port for the MCP server.
const DEFAULT_MCP_PORT: u16 = 51379;

/// Sub-path under the user's config dir where the persistent MCP token lives.
fn mcp_token_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("spacron")
        .join("mcp-token")
}

/// Load a previously-stored token, or generate + persist one.
fn load_or_create_token() -> String {
    let path = mcp_token_path();
    // Try to read an existing token first.
    if let Ok(t) = fs::read_to_string(&path) {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    // Create the directory and write a new token.
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let _ = fs::write(&path, &token);
    token
}

/// Start the MCP HTTP+SSE server. Returns a [`McpServerHandle`] for
/// interacting with it.
///
/// - `port`: `0` = prefer the default port (51379), fall back to an OS-assigned
///   one if it is taken; otherwise bind exactly that port or fail.
/// - `read_cb`: callback to read output from a PTY session.
/// - `spawn_fn`: callback to forward a spawn-agent request to the frontend.
/// - `browser_emit_fn`: callback to emit a browser-tool request to the frontend.
/// - `deliver_emit_fn`: callback to have the frontend type a prompt into an agent.
///
/// There is deliberately no "write to a PTY" callback. Every tool that puts text
/// into an agent goes through `deliver_emit_fn`, because a raw write lands in a
/// TUI's composer unsubmitted — see [`deliver_to_session`].
///
/// The token is persisted to the user's config directory so it survives app
/// restarts. The port is stable too *while* [`DEFAULT_MCP_PORT`] is free, but it
/// is not guaranteed — a second instance, or any process holding 51379, moves us
/// elsewhere. So config files must still be rewritten from `mcp_server_url()` on
/// every agent launch rather than written once and trusted.
pub fn start(
    port: u16,
    read_cb: ReadFn,
    spawn_fn: SpawnFn,
    browser_emit_fn: BrowserEmitFn,
    deliver_emit_fn: DeliverEmitFn,
) -> Result<(McpServerHandle, u16), String> {
    // Bind now, synchronously, and *keep* the socket. This used to probe with a
    // throwaway listener, drop it, and rebind for real inside the spawned task
    // below — which left two holes. Another process could take the port in
    // between; and because the real bind happened after `start` had already
    // returned `Ok`, losing that race published a URL for a server that was
    // never listening. Every agent then got a config pointing at a dead
    // endpoint, reported nothing, and simply had no Spacron tools.
    let (std_listener, actual_port) = bind_listener(port)?;

    let registry: Arc<Mutex<HashMap<String, AgentEntry>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let (notify_tx, _) = broadcast::channel::<()>(32);
    let (send_tx, _) = broadcast::channel::<SendToAgentRequest>(32);
    let (read_tx, _) = broadcast::channel::<ReadOutputRequest>(32);
    let (spawn_tx, _) = broadcast::channel::<SpawnRequest>(32);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let pending_browser: PendingRequests = Arc::new(DashMap::new());
    let pending_sends: PendingSends = Arc::new(DashMap::new());
    let project_root: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let agent_presets: Arc<Mutex<Vec<AgentPreset>>> = Arc::new(Mutex::new(Vec::new()));
    let assistant_names: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let reserved_names: Arc<Mutex<Vec<NameReservation>>> = Arc::new(Mutex::new(Vec::new()));
    let sse_sessions: SseSessions = Arc::new(DashMap::new());
    // Persistent bearer-equivalent shared secret, loaded from the user's config
    // dir on every start so that external config files (.mcp.json, opencode.json)
    // can be written once and survive app restarts.
    let token = load_or_create_token();

    let server_state = Arc::new(ServerState {
        registry: registry.clone(),
        notify_tx: notify_tx.clone(),
        send_tx,
        read_tx,
        spawn_tx,
        port: actual_port,
        token: token.clone(),
        read_cb,
        spawn_fn,
        browser_emit_fn,
        deliver_emit_fn,
        pending_browser: pending_browser.clone(),
        pending_sends: pending_sends.clone(),
        project_root: project_root.clone(),
        agent_presets: agent_presets.clone(),
        assistant_names: assistant_names.clone(),
        reserved_names: reserved_names.clone(),
        sse_sessions,
    });

    // Background sweep: drop pending browser requests older than 30s, and
    // deliveries older than their own (much longer) ceiling — a delivery waits on
    // a CLI reaching its prompt, which a browser call never does.
    let sweep_map = pending_browser.clone();
    let sweep_sends = pending_sends.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            sweep_map.retain(|_, v| v.created_at.elapsed() < Duration::from_secs(30));
            sweep_sends.retain(|_, v| v.created_at.elapsed() < DELIVER_SWEEP_AFTER);
        }
    });

    let app = Router::new()
        // Root and OAuth-discovery endpoints.
        //
        // MCP clients (opencode, Claude Code, Cursor) that implement the spec
        // check these before connecting to the SSE endpoint. If they are missing
        // (404) the MCP SDK treats the 404 *body* as if it were an OAuth error
        // response and fails with "Invalid OAuth error response: SyntaxError".
        // Returning 200 with no auth metadata tells the client "OAuth is not
        // available — proceed without it".
        .route("/", get(root_handler).post(streamable_handler))
        .route("/.well-known/oauth-authorization-server", get(oauth_handler))
        .route("/sse", get(sse_handler).post(streamable_handler))
        .route("/message", post(message_handler))
        // Streamable HTTP transport. Codex CLI speaks *only* this — its
        // `mcp add --url` is documented as "URL for a streamable HTTP MCP
        // server" with no SSE option — and Gemini CLI, droid, opencode and
        // Cursor all support it too. Giving it its own path keeps the two
        // transports from having to share response semantics.
        .route(
            "/mcp",
            post(streamable_handler)
                .get(streamable_no_stream)
                .delete(streamable_no_stream),
        )
        .with_state(server_state);

    tauri::async_runtime::spawn(async move {
        // The port is already ours; this only hands the socket to tokio's
        // reactor, so a failure here is not a bind race and cannot be one.
        if let Err(e) = std_listener.set_nonblocking(true) {
            eprintln!("Failed to set the MCP listener non-blocking: {}", e);
            return;
        }
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to hand the MCP listener to tokio: {}", e);
                return;
            }
        };

        let serve = axum::serve(NoDelayListener(listener), app);

        tokio::select! {
            res = serve => {
                if let Err(e) = res {
                    eprintln!("MCP server error: {}", e);
                }
            }
            _ = shutdown_rx => {
                eprintln!("MCP server shutdown signal received");
            }
        }
    });

    let handle = McpServerHandle {
        registry,
        notify_tx,
        _shutdown_tx: shutdown_tx,
        port: actual_port,
        token,
        pending_browser,
        pending_sends,
        project_root,
        agent_presets,
        assistant_names,
        reserved_names,
    };

    Ok((handle, actual_port))
}

// ---------------------------------------------------------------------------
// Server state (shared across handlers)
// ---------------------------------------------------------------------------

struct ServerState {
    registry: Arc<Mutex<HashMap<String, AgentEntry>>>,
    notify_tx: broadcast::Sender<()>,
    send_tx: broadcast::Sender<SendToAgentRequest>,
    read_tx: broadcast::Sender<ReadOutputRequest>,
    spawn_tx: broadcast::Sender<SpawnRequest>,
    port: u16,
    /// Shared secret every request must present as `?token=…`. See [`authorize`].
    token: String,
    read_cb: ReadFn,
    spawn_fn: SpawnFn,
    browser_emit_fn: BrowserEmitFn,
    /// Asks the frontend to type a prompt into an agent's TUI. See
    /// [`deliver_to_session`] for why this cannot be a direct PTY write.
    deliver_emit_fn: DeliverEmitFn,
    pending_browser: PendingRequests,
    pending_sends: PendingSends,
    /// Absolute path of the active project's main checkout, set by the frontend
    /// on project open. `delegate_task` needs it to locate the reports directory
    /// workers write their completion signal into — the server has no other way
    /// to know where the project lives.
    project_root: Arc<Mutex<Option<String>>>,
    /// Every agent the user can launch right now — built-in presets they have
    /// not removed, plus the custom agents they added. Pushed by the frontend on
    /// startup and whenever the roster changes, so `spawn_agent` and
    /// `delegate_task` advertise what this install actually has rather than a
    /// list baked in at compile time.
    agent_presets: Arc<Mutex<Vec<AgentPreset>>>,
    /// The app's own pool of assistant names ("Trinity", "Morpheus", …), pushed
    /// by the frontend from `agent-names.ts` so there is one list, not two. Used
    /// to name a worker whose spawner left it unnamed or labelled it generically.
    /// Empty means the frontend has not reported yet.
    assistant_names: Arc<Mutex<Vec<String>>>,
    /// Names already handed to a spawn that the frontend has not registered yet.
    /// Registration is asynchronous, so without this two `delegate_task` calls a
    /// few milliseconds apart both see the same pool free and pick one name —
    /// which then collides in the registry and makes `send_to_agent` ambiguous.
    reserved_names: Arc<Mutex<Vec<NameReservation>>>,
    /// Live SSE clients, so `POST /message` can deliver a JSON-RPC response to
    /// the stream the requesting client is listening on. See [`SseSessions`].
    sse_sessions: SseSessions,
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    pub id: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

impl JsonRpcResponse {
    fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Option<serde_json::Value>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

fn tool_list_agents() -> serde_json::Value {
    serde_json::json!({
        "name": "list_agents",
        "description": "List all running AI coding agents with their names, presets, and session IDs.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    })
}

fn tool_send_to_agent() -> serde_json::Value {
    serde_json::json!({
        "name": "send_to_agent",
        "description": "Send a message to a running agent by name. The text is typed into that agent's prompt and submitted for you, and this call waits until it has actually landed — so an error here means the agent did not receive it, not that it was merely slow. Multi-line messages are fine. Use list_agents first to find available agents.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The name of the target agent (e.g. 'Iris'). Use list_agents to see available agents."
                },
                "message": {
                    "type": "string",
                    "description": "The message or prompt to send to the agent."
                }
            },
            "required": ["name", "message"]
        }
    })
}

fn tool_read_agent_output() -> serde_json::Value {
    serde_json::json!({
        "name": "read_agent_output",
        "description": "Read the recent terminal output of a running agent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name of the agent whose output to read."
                }
            },
            "required": ["name"]
        }
    })
}

// ---------------------------------------------------------------------------
// Agent roster — what this install can actually launch
// ---------------------------------------------------------------------------

/// Human-readable list of launchable agents for a tool description, e.g.
/// `'claude' (Claude Code), 'pi' (Pi AI Agent)`.
///
/// Returns `None` when the frontend has not pushed a roster yet, which is a
/// different thing from "there are no agents": callers get generic guidance and
/// [`resolve_preset`] stays permissive rather than rejecting valid names.
fn describe_presets(presets: &[AgentPreset]) -> Option<String> {
    if presets.is_empty() {
        return None;
    }
    Some(
        presets
            .iter()
            .map(|p| {
                if p.name.is_empty() || p.name == p.command {
                    format!("'{}'", p.command)
                } else {
                    format!("'{}' ({})", p.command, p.name)
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// Sentence for the `preset` parameter, naming the agents this install has.
fn preset_param_description(presets: &[AgentPreset]) -> String {
    match describe_presets(presets) {
        Some(list) => format!(
            "Which agent to run. Available in this workspace right now: {}. \
             Pass the command (the quoted value) or the display name — both resolve. \
             The list includes any custom agents the user added, so prefer a name from \
             it over one you assume exists.",
            list
        ),
        None => "Which agent to run — the launch command of a Spacron agent preset or \
                 custom agent, e.g. 'claude' or 'codex'. The workspace has not reported \
                 its roster yet; call list_agents to see what is already running."
            .to_string(),
    }
}

/// Resolve whatever the caller passed to a launch command.
///
/// Accepts the command or the display name, case-insensitively, so an agent can
/// say either `pi` or `Pi AI Agent`. An unknown value is an error *only* when we
/// have a roster to check against — with no roster the input passes through, so
/// a race at startup cannot make a perfectly valid agent unlaunchable.
fn resolve_preset(input: &str, presets: &[AgentPreset]) -> Result<String, String> {
    let wanted = input.trim();
    if wanted.is_empty() {
        return Err("Missing required parameter 'preset'.".to_string());
    }
    if presets.is_empty() {
        return Ok(wanted.to_string());
    }

    let lowered = wanted.to_lowercase();
    if let Some(hit) = presets
        .iter()
        .find(|p| p.command.to_lowercase() == lowered)
        .or_else(|| presets.iter().find(|p| p.name.to_lowercase() == lowered))
    {
        return Ok(hit.command.clone());
    }

    Err(format!(
        "'{}' is not an agent in this workspace. Available: {}.",
        wanted,
        describe_presets(presets).unwrap_or_default()
    ))
}

// ---------------------------------------------------------------------------
// Prompt delivery
//
// Getting text into a running agent is not a PTY write. These CLIs are TUIs with
// their own composer, and typing into one means: wait until it is actually at its
// prompt, send the body as a bracketed paste (so embedded newlines stay in the
// composer instead of submitting a fragment per line), wait for the paste to echo
// and the composer to stop redrawing, then press Enter and confirm the agent
// really started — retrying if it didn't.
//
// The frontend already does all of that in `deliverPromptRaw`, and it is what
// made the floating bar reliable. `send_to_agent` and `bounce_task` used to skip
// all of it and write the raw message straight to the PTY, with no Enter at all —
// so the message sat in the composer unsent, and any newline in it (every
// `bounce_task` message has several) submitted a fragment early and scattered the
// rest. That is why a delegated worker sometimes just sat there.
//
// So delivery is a request to the frontend, with a verdict coming back.
// ---------------------------------------------------------------------------

/// How long to wait for the frontend's delivery verdict.
///
/// Sized from what delivery actually does: up to 30s for a cold CLI to reach its
/// prompt, then ~15s of paste-echo, composer-settle and up to three confirmed
/// Enter attempts. 90s leaves headroom without hanging the caller forever.
const DELIVER_TIMEOUT: Duration = Duration::from_secs(90);

/// When the sweeper reclaims a delivery nothing ever answered. Must exceed
/// [`DELIVER_TIMEOUT`] or the sweep would cancel calls that are still waiting.
const DELIVER_SWEEP_AFTER: Duration = Duration::from_secs(120);

/// Ask the frontend to type `message` into `session_id`'s agent, and wait for it
/// to say whether the agent actually took it.
///
/// `Err` means the message did not land — the caller must report that rather than
/// claim it was sent, because an orchestrator that believes a bounce was
/// delivered will sit and wait for work nobody was asked to do.
async fn deliver_to_session(
    state: &ServerState,
    session_id: u32,
    target: &str,
    message: &str,
) -> Result<(), String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.pending_sends.insert(
        request_id.clone(),
        PendingSend {
            tx,
            created_at: Instant::now(),
        },
    );

    (state.deliver_emit_fn)(&request_id, session_id, message);

    match tokio::time::timeout(DELIVER_TIMEOUT, rx).await {
        Ok(Ok(Ok(_))) => Ok(()),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err(format!(
            "Delivery to '{}' was cancelled before it completed.",
            target
        )),
        Err(_) => {
            state.pending_sends.remove(&request_id);
            Err(format!(
                "Timed out waiting for '{}' to accept the message. Its CLI may still be starting, or its pane may be gone — check it with read_agent_output.",
                target
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Worker naming
//
// A spawned worker's name is what the user sees on its pane and what the
// spawner addresses it by, so it has to be a name — "Trinity", not "worker-3".
// Left to the model, it is usually neither: weaker orchestrators label workers
// after the CLI they run ("claude-1") or after nothing at all ("agent 2"), and
// an unnamed `delegate_task` used to get a uuid stub. Both are resolved here,
// against the same pool the app itself uses.
//
// This is decided server-side, not in the frontend, because for `delegate_task`
// the name is also the handle returned to the caller and the filename the worker
// writes its report to — renaming it after the fact would break both.
// ---------------------------------------------------------------------------

/// A name handed to a spawn that has not reached the registry yet.
struct NameReservation {
    name: String,
    at: Instant,
}

/// How long a handed-out name stays reserved before it can be picked again.
/// Long enough to cover a slow CLI launch; short enough that a spawn which died
/// before registering does not retire a name for the rest of the session.
const NAME_RESERVATION_TTL: Duration = Duration::from_secs(180);

/// Bland words a model reaches for when it labels a worker instead of naming it.
/// Mirrors `GENERIC_NAME_WORDS` in `src/lib/services/orchestrator/agent-names.ts`.
const GENERIC_NAME_WORDS: &[&str] = &["agent", "assistant", "bot", "ai", "coder", "worker", "task"];

/// Longest accepted agent name. Names become filenames and pane labels; nothing
/// legitimate comes close.
const MAX_AGENT_NAME_LEN: usize = 64;

/// Win32 reserved device names. Still special-cased with an extension, so
/// `CON.md` opens the console rather than a file — a read of it can block.
const RESERVED_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// True when `name` is safe to use as a single path component.
///
/// An agent name is not only a label. [`report_paths`] joins it into
/// `<root>/.spacron/reports/<name>.md`, which `delegate_task` **deletes** and
/// `check_task` **reads back to the caller** — so a name containing `..`, a
/// separator or a drive letter steers those operations anywhere on the disk.
///
/// "The caller already holds the token" is not a defence here. The caller is an
/// LLM, and [`delegate_result`] feeds a worker's own report text straight back
/// into it, so untrusted content reaches the thing choosing these names.
///
/// The allowlist is deliberately stricter than rejecting `..` and separators: it
/// also rules out NUL, the trailing dots and spaces Windows silently strips, and
/// anything non-ASCII that could normalise into a separator.
///
/// Interior spaces *are* allowed, because the app's own numbered fallback
/// produces them ("Trinity 2", see `pickAssistantName`) and these names are
/// shown to the user on the pane. A space cannot traverse; a leading or trailing
/// one can be silently dropped by the filesystem, so those are refused. `.` is
/// banned outright, which is what makes `..` unreachable.
fn is_safe_agent_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_AGENT_NAME_LEN {
        return false;
    }
    if name.starts_with(' ') || name.ends_with(' ') {
        return false;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ')
    {
        return false;
    }
    !RESERVED_DEVICE_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

/// True when `name` is a throwaway machine label rather than a name the user
/// would choose — "claude-1", "Claude Code 2", "agent", "bot_3".
///
/// Port of `isGenericAgentName` in `agent-names.ts`, with one deliberate
/// difference: it tests the label against *every* preset in the roster, not just
/// the one being launched. "codex" is a bad name for a worker whichever CLI it
/// turns out to be running.
fn is_generic_agent_name(name: &str, presets: &[AgentPreset]) -> bool {
    let normalized = name.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    // Drop a trailing index ("claude-1", "agent 2", "bot_3") to get the base.
    let base = normalized
        .trim_end_matches(|c: char| c.is_ascii_digit())
        .trim_end_matches([' ', '_', '-'])
        .trim();
    if base.is_empty() {
        return true; // the name was just a number
    }

    if GENERIC_NAME_WORDS.contains(&base) {
        return true;
    }

    presets.iter().any(|p| {
        p.command.trim().eq_ignore_ascii_case(base) || p.name.trim().eq_ignore_ascii_case(base)
    })
}

/// Pick the name a spawn will actually run under.
///
/// Honours a name the caller chose when it is a real one — a worker deliberately
/// called "Reviewer" keeps that. A generic label or no label at all draws from
/// the app's pool instead. Returns `Err` only for a genuine collision, so the
/// caller learns that rather than silently getting a second "Trinity".
///
/// The returned name is reserved; the frontend releases it by registering the
/// agent under it (see [`McpServerHandle::register_agent`]).
async fn assign_agent_name(state: &ServerState, requested: &str) -> Result<String, String> {
    let presets = state.agent_presets.lock().await.clone();
    // Snapshot the registry and drop the lock before taking `reserved_names`, so
    // this never holds both at once — `register_agent` takes them in the other
    // order.
    let registered: Vec<String> = {
        let registry = state.registry.lock().await;
        registry.keys().map(|k| k.to_lowercase()).collect()
    };
    let pool = state.assistant_names.lock().await.clone();

    let mut reserved = state.reserved_names.lock().await;
    reserved.retain(|r| r.at.elapsed() < NAME_RESERVATION_TTL);

    let taken: Vec<String> = registered
        .into_iter()
        .chain(reserved.iter().map(|r| r.name.to_lowercase()))
        .collect();
    let is_taken = |candidate: &str| {
        let lowered = candidate.to_lowercase();
        taken.iter().any(|t| *t == lowered)
    };

    let wanted = requested.trim();
    if !wanted.is_empty() && !is_generic_agent_name(wanted, &presets) {
        // Checked here as well as in `report_paths`, so a bad name is refused
        // before a pane is opened under it rather than after. A registry key is
        // also what `bounce_task` later feeds to `report_paths`.
        if !is_safe_agent_name(wanted) {
            return Err(format!(
                "'{wanted}' is not a usable agent name — use letters, digits, '-' or '_' only (max {MAX_AGENT_NAME_LEN} characters)."
            ));
        }
        if is_taken(wanted) {
            return Err(format!(
                "An agent named '{}' is already running — pick another name.",
                wanted
            ));
        }
        reserved.push(NameReservation {
            name: wanted.to_string(),
            at: Instant::now(),
        });
        return Ok(wanted.to_string());
    }

    // The pool arrives from the frontend, so it is filtered rather than trusted:
    // an assigned name ends up in `report_paths` exactly like a requested one.
    let free: Vec<&String> = pool
        .iter()
        .filter(|n| is_safe_agent_name(n) && !is_taken(n))
        .collect();
    let assigned = if !free.is_empty() {
        // Rotate the starting point so a fleet isn't always Neo, Trinity, …
        // in the same order. `rand` is not a dependency and does not need to be
        // for this.
        let offset = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as usize)
            .unwrap_or(0);
        free[offset % free.len()].clone()
    } else if let Some(base) = pool.iter().find(|n| is_safe_agent_name(n)) {
        // Every name is in use — number one of them, as the app does.
        let mut suffix = 2;
        loop {
            let candidate = format!("{} {}", base, suffix);
            if !is_taken(&candidate) {
                break candidate;
            }
            suffix += 1;
        }
    } else {
        // The frontend has not pushed the pool yet (startup window). A stub name
        // beats refusing to spawn.
        format!(
            "worker-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..6]
        )
    };

    reserved.push(NameReservation {
        name: assigned.clone(),
        at: Instant::now(),
    });
    Ok(assigned)
}

fn tool_spawn_agent(presets: &[AgentPreset]) -> serde_json::Value {
    serde_json::json!({
        "name": "spawn_agent",
        "description": format!(
            "Launch a new AI coding agent with an optional prompt. The new agent appears in its own terminal pane. Agents available in this workspace: {}.",
            describe_presets(presets).unwrap_or_else(|| "not reported yet — pass any preset command the user has configured".to_string())
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "preset": {
                    "type": "string",
                    "description": preset_param_description(presets)
                },
                "prompt": {
                    "type": "string",
                    "description": "Optional. The initial prompt/task to give the new agent."
                },
                "name": {
                    "type": "string",
                    "description": "Optional. The name to give the new agent, so you can address it with send_to_agent without calling list_agents first. Must not match an agent that is already running. Omit it unless the name means something to the user — a real name is assigned for you, and a generic label like 'agent-1' or 'claude-2' is replaced by one. The reply tells you the name that was used."
                }
            },
            "required": ["preset"]
        }
    })
}

// ---------------------------------------------------------------------------
// Browser tool definitions
// ---------------------------------------------------------------------------

fn tool_browser_navigate() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_navigate",
        "description": "Navigate the browser preview to a URL. Use mode='window' for sites that block iframe embedding (Google, GitHub, etc.), or mode='system' to just hand a URL to the user's own browser.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to navigate to."
                },
                "mode": {
                    "type": "string",
                    "enum": ["iframe", "window", "system", "auto"],
                    "description": "iframe: use the preview panel — the only mode with full control (browser_read_dom, browser_click, browser_type all need the bridge the proxy injects into embedded pages). window: open a standalone in-app browser window, which renders sites that refuse embedding; browser_screenshot and browser_close_window work on it, but DOM reads and clicks do not. system: open in the user's default OS browser — nothing is embedded, so no other browser tool can act on that page; use it only to hand a link to the user. auto (default): try iframe first, fall back to a standalone window if the page refuses embedding."
                }
            },
            "required": ["url"]
        }
    })
}

fn tool_browser_screenshot() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_screenshot",
        "description": "Capture a screenshot of the current browser preview as a base64-encoded PNG image.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "Optional CSS selector to screenshot a specific element. If omitted, captures the full viewport."
                }
            },
            "required": []
        }
    })
}

fn tool_browser_get_page_info() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_get_page_info",
        "description": "Get the current URL, page title, and document readyState of the browser preview.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    })
}

fn tool_browser_read_dom() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_read_dom",
        "description": "Read the text content or HTML of elements matching a CSS selector in the browser preview.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector to match elements. Defaults to 'body'."
                },
                "format": {
                    "type": "string",
                    "enum": ["text", "html"],
                    "description": "Return innerText or outerHTML. Defaults to 'text'."
                },
                "limit": {
                    "type": "number",
                    "description": "Max number of elements to return. Defaults to 10."
                }
            },
            "required": []
        }
    })
}

fn tool_browser_console_logs() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_console_logs",
        "description": "Read captured console output (log, warn, error) from the browser preview page.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "level": {
                    "type": "string",
                    "enum": ["all", "error", "warn"],
                    "description": "Filter by log level. Defaults to 'all'."
                },
                "limit": {
                    "type": "number",
                    "description": "Max number of entries to return. Defaults to 50."
                }
            },
            "required": []
        }
    })
}

fn tool_browser_click() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_click",
        "description": "Click an element in the browser preview matching a CSS selector.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector of the element to click."
                }
            },
            "required": ["selector"]
        }
    })
}

fn tool_browser_type() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_type",
        "description": "Type text into an input or textarea element in the browser preview.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector of the input element."
                },
                "text": {
                    "type": "string",
                    "description": "Text to type into the element."
                },
                "submit": {
                    "type": "boolean",
                    "description": "Press Enter after typing. Defaults to false."
                }
            },
            "required": ["selector", "text"]
        }
    })
}

fn tool_browser_close_window() -> serde_json::Value {
    serde_json::json!({
        "name": "browser_close_window",
        "description": "Close the standalone browser window (Tier 2) if one is open.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    })
}

/// How long a worker's report is waited for by default, and the ceiling a caller
/// may ask for. Bounded because an MCP client times out its own requests: a tool
/// that blocks for an hour is a hung session, not a patient one. On expiry the
/// call returns `status: "working"` and a handle rather than an error, so the
/// caller resumes with `check_task` instead of losing the worker.
///
/// The default is short **because of the Streamable HTTP transport**. That path
/// (`POST /mcp`) answers in the response body, so the request stays open for the
/// whole wait — and Codex, Gemini CLI, droid, opencode and Cursor all use it,
/// with Codex supporting nothing else. Most of them abandon a request well
/// before a minute, so a longer default would make `delegate_task` fail for
/// every non-Claude preset. 25s clears the common 30s client timeout with room
/// to spare; a caller that knows its own client can ask for more via
/// `wait_seconds`.
///
/// The SSE transport does not share this constraint (`POST /message` returns
/// `202` immediately and answers on the stream), but one default has to serve
/// both, and the safe one is the short one.
const DELEGATE_DEFAULT_WAIT_SECS: u64 = 25;
const DELEGATE_MAX_WAIT_SECS: u64 = 600;

/// How long a spawn is given to reach the registry before a silent one is called
/// `gone` rather than `working`. See the deadline arm of [`await_worker_report`].
const LAUNCH_GRACE: Duration = Duration::from_secs(45);

fn clamp_wait(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DELEGATE_DEFAULT_WAIT_SECS)
        .clamp(1, DELEGATE_MAX_WAIT_SECS)
}

/// Where a worker signals completion: `<root>/.spacron/reports/<name>.md` for
/// success, `.blocked.md` for "I need a decision". Two files rather than one
/// with a status field, so the check stays a file-exists test with nothing to
/// parse and no partially-written state to misread.
///
/// Fallible on purpose. `name` reaches here from tool arguments, and these paths
/// are deleted and read — so this is the one place that must not be reachable
/// with an unvalidated name. Returning `Result` makes every call site handle it
/// rather than relying on each of them to remember to pre-check.
fn report_paths(root: &str, name: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    if !is_safe_agent_name(name) {
        return Err(format!(
            "'{name}' is not a usable agent name — use letters, digits, '-' or '_' only (max {MAX_AGENT_NAME_LEN} characters)."
        ));
    }
    let dir = std::path::Path::new(root).join(".spacron").join("reports");
    Ok((
        dir.join(format!("{}.md", name)),
        dir.join(format!("{}.blocked.md", name)),
    ))
}

/// Wait for a worker's report to appear, up to `wait_secs`.
///
/// Polls rather than watching the filesystem: the wait is bounded and coarse
/// anyway, a poll has no platform-specific watcher setup, and a worker writing
/// its report is a once-per-task event where two seconds of latency is
/// irrelevant. Returns MCP tool content either way — a timeout is `working`,
/// not an error, because the worker is still going and the caller must be able
/// to resume rather than treat it as failed.
async fn await_worker_report(
    state: &ServerState,
    paths: &(std::path::PathBuf, std::path::PathBuf),
    name: &str,
    wait_secs: u64,
) -> serde_json::Value {
    let (done_path, blocked_path) = paths;
    let started = Instant::now();
    let deadline = started + Duration::from_secs(wait_secs);

    // A worker that dies without reporting should be called `gone` as soon as we
    // can tell, not at the end of the wait. Telling requires knowing it reached
    // the registry first — before that, "absent" just means the CLI is still
    // booting. So the early exit arms only once the agent has actually been seen.
    let mut was_registered = false;

    loop {
        if let Ok(text) = std::fs::read_to_string(done_path) {
            return delegate_result("complete", name, branch_of(state, name).await, Some(text));
        }
        if let Ok(text) = std::fs::read_to_string(blocked_path) {
            return delegate_result("blocked", name, branch_of(state, name).await, Some(text));
        }

        let registered = state.registry.lock().await.contains_key(name);
        if registered {
            was_registered = true;
        } else if was_registered {
            // Seen, then gone, with no report: it exited mid-task.
            return delegate_result("gone", name, None, None);
        }

        if Instant::now() >= deadline {
            // Never reached the registry. That usually means the launch failed —
            // but it also looks exactly like a CLI that is simply slow to boot,
            // and calling a live worker `gone` is the costlier mistake: the
            // orchestrator abandons it and spawns a replacement alongside it. So
            // this only becomes a verdict once the wait was long enough that a
            // boot would have finished; a shorter wait returns the recoverable
            // `working` and lets `check_task` decide.
            let never_came_up = !was_registered && started.elapsed() >= LAUNCH_GRACE;
            let status = if never_came_up { "gone" } else { "working" };
            return delegate_result(status, name, branch_of(state, name).await, None);
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn branch_of(state: &ServerState, name: &str) -> Option<String> {
    state
        .registry
        .lock()
        .await
        .get(name)
        .and_then(|e| e.branch.clone())
}

fn delegate_result(
    status: &str,
    name: &str,
    branch: Option<String>,
    report: Option<String>,
) -> serde_json::Value {
    let guidance = match status {
        "complete" => format!(
            "Worker '{}' finished. Review its actual change with `git diff <your-branch>..{}` — the report says what it believes it did.",
            name,
            branch.clone().unwrap_or_else(|| "<its-branch>".into())
        ),
        "blocked" => format!("Worker '{}' is blocked and has stopped. It needs a decision from you.", name),
        "working" => format!(
            "Worker '{}' is still working. Call check_task with handle '{}' to keep waiting.",
            name, name
        ),
        _ => format!(
            "Worker '{}' is no longer running and never reported. It may have failed at launch — check its pane.",
            name
        ),
    };

    let payload = serde_json::json!({
        "status": status,
        "handle": name,
        "name": name,
        "branch": branch,
        "report": report,
        "next": guidance,
    });

    serde_json::json!({ "content": [
        { "type": "text", "text": serde_json::to_string_pretty(&payload).unwrap_or_default() }
    ]})
}

fn tool_delegate_task(presets: &[AgentPreset]) -> serde_json::Value {
    serde_json::json!({
        "name": "delegate_task",
        "description": "Delegate a piece of work to a NEW agent and wait for its result. Prefer this over your own in-process sub-agents whenever the work WRITES CODE: the worker gets its own visible pane and its own git branch, so the user can watch it, steer it, and review its diff — none of which is possible for an in-process sub-agent. (For read-only research your own sub-agents are fine.) Returns the worker's report when it finishes, or status 'working' with a handle if it is still going — then call check_task with that handle.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "preset": {
                    "type": "string",
                    "description": preset_param_description(presets)
                },
                "prompt": {
                    "type": "string",
                    "description": "The task for the worker. Instructions for reporting back are appended automatically — do not write your own."
                },
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional. Files this worker owns. Keep these disjoint from other workers' files so their branches merge cleanly."
                },
                "name": {
                    "type": "string",
                    "description": "Optional. Name for the worker; must not match a running agent. Omit it unless the name means something to the user — a real name is assigned for you, and a generic label like 'worker-1' or 'claude-2' is replaced by one. Always use the 'handle' from the result to address the worker, not the name you asked for."
                },
                "wait_seconds": {
                    "type": "number",
                    "description": "Optional. How long to wait before returning 'working' (default 25, max 600)."
                }
            },
            "required": ["preset", "prompt"]
        }
    })
}

fn tool_bounce_task() -> serde_json::Value {
    serde_json::json!({
        "name": "bounce_task",
        "description": "Send a worker back to fix its work, and wait for the new result. Use this instead of send_to_agent when you want another round from a worker you delegated to: it clears the previous report first, so what you get back is the redone work and not the old report again.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "handle": {
                    "type": "string",
                    "description": "The handle delegate_task returned (the worker's name)."
                },
                "feedback": {
                    "type": "string",
                    "description": "Specific, actionable fixes: the file, the problem, and what correct looks like. Not 'please improve this'."
                },
                "wait_seconds": {
                    "type": "number",
                    "description": "Optional. How long to wait before returning 'working' (default 25, max 600)."
                }
            },
            "required": ["handle", "feedback"]
        }
    })
}

fn tool_check_task() -> serde_json::Value {
    serde_json::json!({
        "name": "check_task",
        "description": "Resume waiting for a worker delegated with delegate_task that had not finished yet. Pass the handle delegate_task returned.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "handle": {
                    "type": "string",
                    "description": "The handle returned by delegate_task (the worker's name)."
                },
                "wait_seconds": {
                    "type": "number",
                    "description": "Optional. How long to wait before returning 'working' again (default 25, max 600)."
                }
            },
            "required": ["handle"]
        }
    })
}

fn all_tools(presets: &[AgentPreset]) -> Vec<serde_json::Value> {
    vec![
        tool_list_agents(),
        tool_send_to_agent(),
        tool_read_agent_output(),
        tool_spawn_agent(presets),
        tool_delegate_task(presets),
        tool_bounce_task(),
        tool_check_task(),
        tool_browser_navigate(),
        tool_browser_screenshot(),
        tool_browser_get_page_info(),
        tool_browser_read_dom(),
        tool_browser_console_logs(),
        tool_browser_click(),
        tool_browser_type(),
        tool_browser_close_window(),
    ]
}

// ---------------------------------------------------------------------------
// OAuth-discovery handlers
// ---------------------------------------------------------------------------

/// Root — alive probe. MCP clients that attempt OAuth discovery often start
/// with the server's origin (stripping the `/sse` path) to check whether the
/// server exists and whether it returns any auth-related headers. A 200 here
/// stops the client from interpreting a 404 as an OAuth error.
async fn root_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "server": "spacron-mcp"
    }))
}

/// `/.well-known/oauth-authorization-server` (RFC 8414).
///
/// Spacron does not use OAuth — it authenticates via a pre-shared `?token=`
/// query parameter or `Authorization: Bearer` header.
///
/// The MCP SDK validates the well-known response against a strict Zod schema
/// (`issuer`, `authorization_endpoint`, `token_endpoint`,
/// `response_types_supported` are all required). Returning `200` with `{}`
/// makes the SDK try to validate and fail. Returning `404` (no body) caused
/// the original "JSON Parse error: Unexpected EOF". What the SDK needs is a
/// `404` with a parseable JSON body — it treats non-200 as "no OAuth" and the
/// JSON body keeps the parser from crashing.
async fn oauth_handler() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "not_found",
            "error_description": "OAuth is not supported by the Spacron MCP server. Use the ?token= query parameter or Authorization: Bearer header instead."
        })),
    )
}

// ---------------------------------------------------------------------------
// SSE endpoint – the main MCP transport channel
// ---------------------------------------------------------------------------

type SseEvent = Result<Event, Infallible>;

async fn sse_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if let Some(rejection) = reject_unauthorized(&state, &headers, &query) {
        return rejection;
    }

    let rx = state.notify_tx.subscribe();

    // Per-connection mailbox. `POST /message` finds this sender by `sessionId`
    // and pushes the JSON-RPC response into it; the stream below drains it.
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    let (msg_tx, msg_rx) = mpsc::unbounded_channel::<serde_json::Value>();
    state.sse_sessions.insert(session_id.clone(), msg_tx);

    // The client POSTs wherever this endpoint event points, so carrying the token
    // here means /message stays authenticated with no client-side config. The
    // `sessionId` is what lets the POST handler route the reply back to *this*
    // stream rather than answering in the POST body, which no SSE client reads.
    let endpoint_url = format!(
        "http://127.0.0.1:{}/message?sessionId={}&token={}",
        state.port, session_id, state.token
    );

    let guard = SseSessionGuard {
        sessions: state.sse_sessions.clone(),
        id: session_id,
    };

    Sse::new(sse_event_stream(endpoint_url, rx, msg_rx, guard))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

/// Build the SSE event stream for an MCP transport session.
fn sse_event_stream(
    endpoint_url: String,
    rx: broadcast::Receiver<()>,
    msg_rx: mpsc::UnboundedReceiver<serde_json::Value>,
    guard: SseSessionGuard,
) -> impl Stream<Item = SseEvent> + Send + 'static {
    // ── Initial events: endpoint notification + tool-list-changed ─────
    let init = vec![
        Ok(Event::default().event("endpoint").data(&endpoint_url)),
        Ok(Event::default().event("message").data(
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/tools/list_changed",
                "params": {}
            })
            .to_string(),
        )),
    ];

    // ── Loop: JSON-RPC responses + registry-change pings + keepalives ─
    let tail = stream::unfold(
        (rx, msg_rx, tokio::time::interval(Duration::from_secs(15)), guard),
        |(mut rx, mut msg_rx, mut tick, guard)| async move {
            // `guard` is threaded through the fold state purely so it lives
            // exactly as long as the stream: when the client disconnects and
            // this future is dropped, its `Drop` unregisters the session.
            //
            // No `loop` here: `unfold` is the loop — it calls this closure again
            // for each item, and every arm below returns. Wrapping it in one made
            // `cargo clippy` fail outright on `never_loop` (a deny-by-default
            // lint), which is why clippy was red on this crate.
            tokio::select! {
                // Responses to the client's own requests. This arm is the whole
                // point of the SSE transport — a client that POSTs `initialize`
                // blocks here until its answer arrives, and times out without it.
                Some(msg) = msg_rx.recv() => {
                    Some((
                        Ok(Event::default().event("message").data(msg.to_string())),
                        (rx, msg_rx, tick, guard),
                    ))
                }
                _ = rx.recv() => {
                    let notif = serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/tools/list_changed",
                        "params": {}
                    });
                    Some((
                        Ok(Event::default().event("message").data(notif.to_string())),
                        (rx, msg_rx, tick, guard),
                    ))
                }
                _ = tick.tick() => {
                    Some((
                        Ok(Event::default().event("heartbeat").data("")),
                        (rx, msg_rx, tick, guard),
                    ))
                }
                else => None,
            }
        },
    );

    stream::iter(init).chain(tail)
}

// ---------------------------------------------------------------------------
// POST /message – JSON-RPC endpoint
// ---------------------------------------------------------------------------

/// Streamable HTTP handler (POST /).
///
/// Modern MCP clients (opencode, Claude Code, Cursor via MCP SDK 0.6+) try
/// Streamable HTTP before falling back to SSE. If the server returns anything
/// other than 200 (e.g. the 405 we would get from a GET-only route), the MCP
/// SDK treats the response as an OAuth error and fails.
///
/// Accepting JSON-RPC POSTs on the root path lets Streamable HTTP clients
/// connect without a fallback, while SSE clients still use GET /sse.
async fn streamable_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(req): Json<JsonRpcRequest>,
) -> Response {
    if let Some(rejection) = reject_unauthorized(&state, &headers, &query) {
        return rejection;
    }

    // A notification carries no `id` and must not be answered. Streamable HTTP
    // says to acknowledge it with `202 Accepted` and an empty body; replying
    // with a JSON-RPC object (which this used to do, `id` set to null) is a
    // protocol error the stricter clients reject outright.
    if req.id.is_none() {
        let _ = dispatch_message(state, req).await;
        return StatusCode::ACCEPTED.into_response();
    }

    dispatch_message(state, req).await.into_response()
}

/// `GET`/`DELETE` on the Streamable HTTP endpoint.
///
/// Spacron delivers no server-initiated messages on this transport (agents poll
/// via tool calls; the push channel is SSE). The spec's prescribed answer for a
/// server that doesn't offer the optional stream is `405`, and clients treat it
/// as "no stream available" and carry on. Anything else — notably a `200` with a
/// JSON body — reads as a malformed stream and fails the connection.
async fn streamable_no_stream() -> impl IntoResponse {
    StatusCode::METHOD_NOT_ALLOWED
}

/// `POST /message` — the request half of the HTTP+SSE transport.
///
/// An SSE client is *not* reading this response body: it is blocked on the
/// `GET /sse` stream waiting for a message whose `id` matches its request. So
/// when the caller identifies itself with the `sessionId` we handed out in the
/// `endpoint` event, the reply is pushed onto that stream and this returns a
/// bare `202 Accepted`. Answering in the body instead is what made every SSE
/// client hang through `initialize` and report a 30s connection timeout.
///
/// Dispatch runs on a spawned task so a slow tool (`delegate_task` blocks until
/// a worker reports) cannot hold the POST open or stall the client's next call.
///
/// Callers with no `sessionId` are answered in the body, which keeps plain
/// request/response probes and Streamable HTTP clients working.
async fn message_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(req): Json<JsonRpcRequest>,
) -> Response {
    if let Some(rejection) = reject_unauthorized(&state, &headers, &query) {
        return rejection;
    }

    let sse_tx = query
        .session_id
        .as_ref()
        .and_then(|sid| state.sse_sessions.get(sid).map(|e| e.value().clone()));

    let Some(tx) = sse_tx else {
        return dispatch_message(state, req).await.into_response();
    };

    // A JSON-RPC notification (no `id`) must not be answered at all — a client
    // that receives a response it never asked for treats it as a protocol error.
    let is_notification = req.id.is_none();

    tokio::spawn(async move {
        let Json(resp) = dispatch_message(state, req).await;
        if is_notification {
            return;
        }
        match serde_json::to_value(&resp) {
            Ok(v) => {
                // Send failure just means the client disconnected mid-call.
                let _ = tx.send(v);
            }
            Err(e) => eprintln!("MCP: could not serialize JSON-RPC response: {e}"),
        }
    });

    StatusCode::ACCEPTED.into_response()
}

async fn dispatch_message(
    state: Arc<ServerState>,
    req: JsonRpcRequest,
) -> Json<JsonRpcResponse> {
    let id = req.id.clone();

    match req.method.as_str() {
        // ── MCP lifecycle ────────────────────────────────────────────────
        "initialize" => {
            let resp = serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": { "listChanged": true }
                },
                "serverInfo": {
                    "name": "spacron-mcp",
                    "version": "1.0.0"
                }
            });
            Json(JsonRpcResponse::success(id, resp))
        }

        "notifications/initialized" | "notifications/cancelled" => {
            Json(JsonRpcResponse::success(id, serde_json::json!({})))
        }

        // ── Tools ────────────────────────────────────────────────────────
        "tools/list" => {
            // Read the roster per request, not once at startup: the user can add
            // or remove an agent at any time, and the frontend fires
            // `notifications/tools/list_changed` so connected clients come back
            // here for the updated list.
            let presets = state.agent_presets.lock().await.clone();
            Json(JsonRpcResponse::success(
                id,
                serde_json::json!({ "tools": all_tools(&presets) }),
            ))
        }

        "tools/call" => {
            handle_tool_call(id, req.params, &state).await
        }

        // ── Sampling ─────────────────────────────────────────────────────
        "sampling/createMessage" => Json(JsonRpcResponse::error(
            id,
            -32001,
            "Sampling is not supported by the Spacron MCP server.",
        )),

        _ => Json(JsonRpcResponse::error(
            id,
            -32601,
            format!("Method not found: '{}'", req.method),
        )),
    }
}

async fn handle_tool_call(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &ServerState,
) -> Json<JsonRpcResponse> {
    let params = params.unwrap_or_default();
    let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");

    match tool_name {
        "list_agents" => {
            let registry = state.registry.lock().await;
            let agents: Vec<serde_json::Value> = registry
                .values()
                .map(|e| {
                    serde_json::json!({
                        "name": e.name,
                        "preset": e.preset,
                        "label": e.label,
                        "session_id": e.session_id,
                        // Absent when the agent runs in the main checkout.
                        "branch": e.branch,
                    })
                })
                .collect();
            let text = if agents.is_empty() {
                "No agents are currently running.".to_string()
            } else {
                serde_json::to_string_pretty(&agents).unwrap_or_default()
            };
            Json(JsonRpcResponse::success(
                id,
                serde_json::json!({ "content": [{ "type": "text", "text": text }] }),
            ))
        }

        "send_to_agent" => {
            let args = params.get("arguments").and_then(|a| a.as_object());
            let target_name = args
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let message = args
                .and_then(|a| a.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if target_name.is_empty() {
                return Json(JsonRpcResponse::error(id, -32602, "Missing required parameter 'name'"));
            }
            if message.is_empty() {
                return Json(JsonRpcResponse::error(id, -32602, "Missing required parameter 'message'"));
            }

            let session_id = {
                let registry = state.registry.lock().await;
                registry.get(target_name).map(|e| e.session_id)
            };

            match session_id {
                Some(sid) => {
                    // Typed into the agent's composer and submitted, not written
                    // raw to the PTY — see `deliver_to_session`. The success
                    // message is only accurate because this waits for the verdict.
                    match deliver_to_session(&state, sid, target_name, message).await {
                        Ok(_) => {
                            let _ = state.send_tx.send(SendToAgentRequest {
                                target_name: target_name.to_string(),
                                message: message.to_string(),
                                target_session_id: sid,
                            });
                            Json(JsonRpcResponse::success(
                                id,
                                serde_json::json!({ "content": [{ "type": "text", "text": format!("Message delivered to '{}' and submitted.", target_name) }] }),
                            ))
                        }
                        Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
                    }
                }
                None => Json(JsonRpcResponse::error(
                    id,
                    -32000,
                    format!("No agent named '{}' is running. Use list_agents to see available agents.", target_name),
                )),
            }
        }

        "read_agent_output" => {
            let args = params.get("arguments").and_then(|a| a.as_object());
            let target_name = args
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if target_name.is_empty() {
                return Json(JsonRpcResponse::error(id, -32602, "Missing required parameter 'name'"));
            }

            let session_id = {
                let registry = state.registry.lock().await;
                registry.get(target_name).map(|e| e.session_id)
            };

            match session_id {
                Some(sid) => {
                    // Read output from the target PTY session
                    let output = (state.read_cb)(sid);
                    let output_str = String::from_utf8_lossy(&output);
                    // Keep last ~50KB to avoid huge responses. The cut must land
                    // on a char boundary or the slice panics — see
                    // `tail_from_char_boundary`.
                    let text = if output_str.len() > MAX_OUTPUT_BYTES {
                        format!("... [{} bytes trimmed] ...\n{}",
                            output_str.len(),
                            tail_from_char_boundary(&output_str, MAX_OUTPUT_BYTES))
                    } else {
                        output_str.to_string()
                    };
                    let _ = state.read_tx.send(ReadOutputRequest {
                        target_name: target_name.to_string(),
                        target_session_id: sid,
                    });
                    Json(JsonRpcResponse::success(
                        id,
                        serde_json::json!({ "content": [{ "type": "text", "text": text }] }),
                    ))
                }
                None => Json(JsonRpcResponse::error(
                    id,
                    -32000,
                    format!("No agent named '{}' is running.", target_name),
                )),
            }
        }

        "spawn_agent" => {
            let args = params.get("arguments").and_then(|a| a.as_object());
            let preset = args
                .and_then(|a| a.get("preset"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let prompt = args
                .and_then(|a| a.get("prompt"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let name = args
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            // Normalise to a launch command, accepting either the command or the
            // display name. Rejecting an unknown name here beats typing it into a
            // shell and leaving the user with a pane full of "command not found".
            let presets = state.agent_presets.lock().await.clone();
            let preset = match resolve_preset(preset, &presets) {
                Ok(p) => p,
                Err(msg) => return Json(JsonRpcResponse::error(id, -32602, msg)),
            };

            // Settle the name here, not in the frontend. A collision is refused
            // rather than silently renamed — `send_to_agent` resolves by name, so
            // two agents answering to one makes every later message ambiguous —
            // and a generic label is replaced by a real name from the app's pool.
            let name = match assign_agent_name(&state, name).await {
                Ok(n) => n,
                Err(msg) => return Json(JsonRpcResponse::error(id, -32602, &msg)),
            };

            let req = SpawnRequest {
                preset: preset.to_string(),
                prompt: prompt.to_string(),
                name: name.clone(),
            };

            let _ = state.spawn_tx.send(req.clone());
            (state.spawn_fn)(req);

            // Name the agent in the reply: the caller may have asked for one and
            // been given another, and it needs the real one for `send_to_agent`.
            Json(JsonRpcResponse::success(
                id,
                serde_json::json!({ "content": [
                    { "type": "text", "text": format!(
                        "Spawning '{}' as '{}'{}... It will appear in a new terminal. Address it as '{}'.",
                        preset,
                        name,
                        if prompt.is_empty() { String::new() } else { format!(" with prompt: {}", prompt) },
                        name
                    )}
                ]}),
            ))
        }

        "delegate_task" => {
            let args = params.get("arguments").and_then(|a| a.as_object());
            let preset = args.and_then(|a| a.get("preset")).and_then(|v| v.as_str()).unwrap_or("");
            let prompt = args.and_then(|a| a.get("prompt")).and_then(|v| v.as_str()).unwrap_or("");
            let requested = args
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let files: Vec<String> = args
                .and_then(|a| a.get("files"))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let wait = clamp_wait(args.and_then(|a| a.get("wait_seconds")).and_then(|v| v.as_u64()));

            if preset.is_empty() || prompt.is_empty() {
                return Json(JsonRpcResponse::error(
                    id,
                    -32602,
                    "delegate_task needs both 'preset' and 'prompt'.",
                ));
            }

            // Same normalisation as `spawn_agent` — see the note there.
            let presets = state.agent_presets.lock().await.clone();
            let preset = match resolve_preset(preset, &presets) {
                Ok(p) => p,
                Err(msg) => return Json(JsonRpcResponse::error(id, -32602, msg)),
            };

            let root = match state.project_root.lock().await.clone() {
                Some(r) => r,
                None => {
                    return Json(JsonRpcResponse::error(
                        id,
                        -32000,
                        "No project is open, so there is nowhere to run a worker.",
                    ))
                }
            };

            // The worker's name is also its report filename and its handle, so it
            // has to be unique across running agents — a collision would make two
            // workers write over one report and make `send_to_agent` ambiguous.
            // It is also what the user sees on the pane, which is why an unnamed
            // or generically-labelled worker gets a real name from the app's pool
            // rather than the uuid stub this used to invent.
            let name = match assign_agent_name(&state, &requested).await {
                Ok(n) => n,
                Err(msg) => return Json(JsonRpcResponse::error(id, -32602, &msg)),
            };

            // Clear any report left by an earlier worker of the same name, so a
            // stale file can't be mistaken for this run finishing instantly.
            let paths = match report_paths(&root, &name) {
                Ok(p) => p,
                Err(msg) => return Json(JsonRpcResponse::error(id, -32602, &msg)),
            };
            let (done_path, blocked_path) = &paths;
            let _ = std::fs::remove_file(done_path);
            let _ = std::fs::remove_file(blocked_path);
            if let Some(dir) = done_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }

            // The caller supplies the task; the reporting protocol is appended
            // here so it can never be forgotten or written wrong. The paths are
            // ABSOLUTE on purpose: the worker runs in its own git worktree, and a
            // relative path would put the report inside that checkout where
            // nobody is looking for it.
            let ownership = if files.is_empty() {
                String::new()
            } else {
                format!(
                    "\nYou own these files and nothing else: {}. Do not edit anything outside that list — another agent owns it.",
                    files.join(", ")
                )
            };
            let full_prompt = format!(
                "{prompt}{ownership}\n\nCommit your work on your branch as you go.\n\
                 When you are FINISHED, write your summary to this exact absolute path:\n  {done}\n\
                 Say what you changed, which files, and how you verified it. Writing that file is how you signal you are done — nothing else counts.\n\
                 If you get stuck or need a decision, write what you need to this exact absolute path instead and stop:\n  {blocked}",
                prompt = prompt,
                ownership = ownership,
                done = done_path.display(),
                blocked = blocked_path.display(),
            );

            let req = SpawnRequest {
                preset: preset.to_string(),
                prompt: full_prompt,
                name: name.clone(),
            };
            let _ = state.spawn_tx.send(req.clone());
            (state.spawn_fn)(req);

            Json(JsonRpcResponse::success(
                id,
                await_worker_report(&state, &paths, &name, wait).await,
            ))
        }

        "bounce_task" => {
            let args = params.get("arguments").and_then(|a| a.as_object());
            let handle = args
                .and_then(|a| a.get("handle"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let feedback = args.and_then(|a| a.get("feedback")).and_then(|v| v.as_str()).unwrap_or("");
            let wait = clamp_wait(args.and_then(|a| a.get("wait_seconds")).and_then(|v| v.as_u64()));

            if handle.is_empty() || feedback.is_empty() {
                return Json(JsonRpcResponse::error(
                    id,
                    -32602,
                    "bounce_task needs both 'handle' and 'feedback'.",
                ));
            }
            let root = match state.project_root.lock().await.clone() {
                Some(r) => r,
                None => return Json(JsonRpcResponse::error(id, -32000, "No project is open.")),
            };
            let session_id = state.registry.lock().await.get(&handle).map(|e| e.session_id);
            let sid = match session_id {
                Some(s) => s,
                None => {
                    return Json(JsonRpcResponse::error(
                        id,
                        -32000,
                        &format!("No running agent named '{}' — it may have exited.", handle),
                    ))
                }
            };

            // Delete the previous report BEFORE sending, not after: the worker
            // may start writing the new one immediately, and deleting afterwards
            // would race it away. Without this the next wait returns the stale
            // report instantly and the loop "converges" without anything having
            // been redone.
            let paths = match report_paths(&root, &handle) {
                Ok(p) => p,
                Err(msg) => return Json(JsonRpcResponse::error(id, -32602, &msg)),
            };
            let (done_path, blocked_path) = &paths;
            let _ = std::fs::remove_file(done_path);
            let _ = std::fs::remove_file(blocked_path);

            let message = format!(
                "{feedback}\n\nWhen you have addressed this, write your summary again to:\n  {done}\nIf you cannot proceed, write why to:\n  {blocked}",
                feedback = feedback,
                done = done_path.display(),
                blocked = blocked_path.display(),
            );

            // Must be a real delivery, not a PTY write: a bounce message is always
            // multi-line (feedback plus the two report paths), and raw newlines
            // submit it a fragment at a time. If it does not land, say so — the
            // wait below would otherwise sit out its whole timeout on a worker
            // that was never actually asked for anything.
            if let Err(e) = deliver_to_session(&state, sid, &handle, &message).await {
                return Json(JsonRpcResponse::error(id, -32000, &e));
            }
            let _ = state.send_tx.send(SendToAgentRequest {
                target_name: handle.clone(),
                message: message.clone(),
                target_session_id: sid,
            });

            Json(JsonRpcResponse::success(
                id,
                await_worker_report(&state, &paths, &handle, wait).await,
            ))
        }

        "check_task" => {
            let args = params.get("arguments").and_then(|a| a.as_object());
            let handle = args
                .and_then(|a| a.get("handle"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let wait = clamp_wait(args.and_then(|a| a.get("wait_seconds")).and_then(|v| v.as_u64()));

            if handle.is_empty() {
                return Json(JsonRpcResponse::error(id, -32602, "check_task needs a 'handle'."));
            }
            let root = match state.project_root.lock().await.clone() {
                Some(r) => r,
                None => return Json(JsonRpcResponse::error(id, -32000, "No project is open.")),
            };
            // Unlike `bounce_task` this never looks the handle up in the
            // registry, so `report_paths` is the only thing standing between a
            // caller-supplied handle and a file read whose contents come back in
            // the response.
            let paths = match report_paths(&root, &handle) {
                Ok(p) => p,
                Err(msg) => return Json(JsonRpcResponse::error(id, -32602, &msg)),
            };

            Json(JsonRpcResponse::success(
                id,
                await_worker_report(&state, &paths, &handle, wait).await,
            ))
        }

        // ── Browser tools — dispatched to the frontend via request-response bridge ──
        t if t.starts_with("browser_") => {
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));

            let request_id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();

            state.pending_browser.insert(
                request_id.clone(),
                PendingBrowserRequest {
                    tx,
                    created_at: Instant::now(),
                },
            );

            (state.browser_emit_fn)(&request_id, tool_name, args);

            match tokio::time::timeout(Duration::from_secs(15), rx).await {
                Ok(Ok(Ok(result))) => {
                    let text = match &result {
                        serde_json::Value::String(s) => s.clone(),
                        other => serde_json::to_string_pretty(other).unwrap_or_default(),
                    };
                    Json(JsonRpcResponse::success(
                        id,
                        serde_json::json!({ "content": [{ "type": "text", "text": text }] }),
                    ))
                }
                Ok(Ok(Err(err))) => {
                    Json(JsonRpcResponse::error(id, -32000, err))
                }
                Ok(Err(_)) => {
                    Json(JsonRpcResponse::error(id, -32000, "Browser request was cancelled."))
                }
                Err(_) => {
                    state.pending_browser.remove(&request_id);
                    Json(JsonRpcResponse::error(
                        id,
                        -32000,
                        "Browser tool timed out waiting for a response (15s). The preview may not be open.",
                    ))
                }
            }
        }

        _ => Json(JsonRpcResponse::error(id, -32601, format!("Unknown tool: '{}'", tool_name))),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Cap on how much PTY output `read_agent_output` returns in one response.
const MAX_OUTPUT_BYTES: usize = 51200;

/// Keep the last `max_bytes` of `s`, snapping the cut *forward* to the next
/// UTF-8 character boundary.
///
/// Slicing a `str` at a raw byte offset panics when the offset lands inside a
/// multi-byte character. Agent TUI output is full of box-drawing characters
/// (`─`, `│`, `╭`), so for a cut at an arbitrary offset that is the common
/// case, not a rare one.
fn tail_from_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Constant-time byte comparison, so token validation doesn't leak match
/// progress via timing. Mirrors `remote::ct_eq`.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract the bearer token from an `Authorization: Bearer <tok>` header.
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let val = headers.get(header::AUTHORIZATION)?;
    let val = val.to_str().ok()?;
    val.strip_prefix("Bearer ")
}

/// Gate every request on two independent checks.
///
/// 1. **No `Origin` header.** MCP CLI clients (Claude Code, Codex, Cursor) never
///    send one; browsers always do. Rejecting any request that carries one is
///    what stops a DNS-rebinding attack, where a hostile page re-resolves its
///    own domain to 127.0.0.1 and becomes same-origin with us. The JSON
///    content-type requirement alone does not cover that case.
/// 2. **Matching `?token=` or `Authorization: Bearer`.** Defends against a local
///    process that can reach the port but cannot read this user's agent config
///    files — e.g. another account on a shared machine. The token rides in the
///    query string for SSE (which has no way to set custom headers), and in the
///    standard `Authorization` header for Streamable HTTP clients.
///
/// Returns `Some(response)` when the request must be refused, `None` when it may
/// proceed.
fn reject_unauthorized(
    state: &ServerState,
    headers: &HeaderMap,
    query: &AuthQuery,
) -> Option<Response> {
    if headers.contains_key(header::ORIGIN) {
        return Some(
            (
                StatusCode::FORBIDDEN,
                "browser origins are not permitted to reach the Spacron MCP server",
            )
                .into_response(),
        );
    }

    let presented = query
        .token
        .as_deref()
        .or_else(|| bearer_token(headers))
        .unwrap_or("");
    if !ct_eq(presented.as_bytes(), state.token.as_bytes()) {
        return Some((StatusCode::UNAUTHORIZED, "invalid or missing token").into_response());
    }

    None
}

/// The `?token=…` every route requires, plus the `?sessionId=…` that
/// `POST /message` uses to find the SSE stream awaiting the reply.
#[derive(Deserialize, Default)]
struct AuthQuery {
    token: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

/// Bind the server's listener, returning it together with the port it holds.
///
/// `port == 0` prefers [`DEFAULT_MCP_PORT`] so agent config files point at a
/// stable address across restarts, and falls back to an OS-assigned port when it
/// is taken — by an unrelated process, or by a second Spacron (a dev build
/// running alongside the installed app).
///
/// The listener is returned rather than dropped on purpose: whoever advertises a
/// port must be holding it. Probing and rebinding later is what let the
/// advertised port and the listening port disagree.
fn bind_listener(port: u16) -> Result<(std::net::TcpListener, u16), String> {
    let candidates: &[u16] = if port == 0 {
        &[DEFAULT_MCP_PORT, 0]
    } else {
        // An explicitly requested port has no fallback: silently landing
        // somewhere else would be worse than failing.
        &[port]
    };

    let mut last_err = "no candidate ports".to_string();
    for &candidate in candidates {
        match std::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], candidate))) {
            Ok(listener) => {
                let bound = listener
                    .local_addr()
                    .map_err(|e| format!("Bound the MCP server but could not read its port: {e}"))?
                    .port();
                return Ok((listener, bound));
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!("Could not bind the MCP server: {last_err}"))
}

/// Wraps a TcpListener so every accepted connection has TCP_NODELAY set.
struct NoDelayListener(tokio::net::TcpListener);

impl axum::serve::Listener for NoDelayListener {
    type Io = tokio::net::TcpStream;
    type Addr = SocketAddr;

    fn local_addr(&self) -> Result<Self::Addr, std::io::Error> {
        self.0.local_addr()
    }

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.0.accept().await {
                Ok((stream, addr)) => {
                    if let Err(e) = stream.set_nodelay(true) {
                        eprintln!("Failed to set TCP_NODELAY on MCP connection: {e}");
                    }
                    return (stream, addr);
                }
                Err(e) => {
                    eprintln!("MCP server accept error: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(command: &str, name: &str) -> AgentPreset {
        AgentPreset {
            command: command.to_string(),
            name: name.to_string(),
        }
    }

    /// The roster a typical install reports: built-ins plus one custom agent.
    fn roster() -> Vec<AgentPreset> {
        vec![
            preset("claude", "Claude Code"),
            preset("pi", "Pi AI Agent"),
            preset("aider --no-auto-commits", "Aider"),
        ]
    }

    #[test]
    fn resolves_a_preset_by_its_launch_command() {
        assert_eq!(resolve_preset("pi", &roster()).unwrap(), "pi");
        assert_eq!(
            resolve_preset("aider --no-auto-commits", &roster()).unwrap(),
            "aider --no-auto-commits"
        );
    }

    #[test]
    fn resolves_a_preset_by_its_display_name() {
        // An agent reading the tool description sees "'pi' (Pi AI Agent)" and may
        // reasonably send either half. Both must land on the launch command,
        // because that is what gets typed into the shell.
        assert_eq!(resolve_preset("Pi AI Agent", &roster()).unwrap(), "pi");
        assert_eq!(resolve_preset("Aider", &roster()).unwrap(), "aider --no-auto-commits");
    }

    #[test]
    fn preset_resolution_ignores_case_and_padding() {
        assert_eq!(resolve_preset("  CLAUDE  ", &roster()).unwrap(), "claude");
        assert_eq!(resolve_preset("claude code", &roster()).unwrap(), "claude");
    }

    #[test]
    fn a_custom_agent_is_as_launchable_as_a_builtin() {
        // The whole point of the roster: the user's own agents are not a second
        // class of thing an orchestrator has to know about out of band.
        let presets = vec![preset("my-agent --flag", "My Agent")];
        assert_eq!(resolve_preset("My Agent", &presets).unwrap(), "my-agent --flag");
    }

    #[test]
    fn an_unknown_preset_is_rejected_with_the_real_list() {
        let err = resolve_preset("gpt5", &roster()).unwrap_err();
        assert!(err.contains("gpt5"), "should name what was asked for: {err}");
        // Listing the alternatives is the difference between a caller that can
        // retry correctly and one that guesses again.
        assert!(err.contains("'pi' (Pi AI Agent)"), "should list what is available: {err}");
    }

    #[test]
    fn an_empty_roster_stays_permissive() {
        // No roster means the frontend has not reported yet — not that there are
        // no agents. Rejecting here would make a valid preset unlaunchable
        // during the startup window.
        assert_eq!(resolve_preset("pi", &[]).unwrap(), "pi");
        assert_eq!(resolve_preset("anything-at-all", &[]).unwrap(), "anything-at-all");
    }

    #[test]
    fn an_empty_preset_is_still_rejected() {
        assert!(resolve_preset("", &roster()).is_err());
        assert!(resolve_preset("   ", &[]).is_err());
    }

    #[test]
    fn the_spawn_tools_advertise_the_live_roster() {
        let tools = all_tools(&roster());
        for name in ["spawn_agent", "delegate_task"] {
            let tool = tools
                .iter()
                .find(|t| t["name"] == name)
                .unwrap_or_else(|| panic!("{name} missing from tools/list"));
            let described = tool["inputSchema"]["properties"]["preset"]["description"]
                .as_str()
                .unwrap();
            assert!(described.contains("'pi' (Pi AI Agent)"), "{name}: {described}");
            assert!(described.contains("Aider"), "{name}: {described}");
        }
    }

    #[test]
    fn the_spawn_tools_stay_usable_with_no_roster_reported() {
        let tools = all_tools(&[]);
        let tool = tools.iter().find(|t| t["name"] == "delegate_task").unwrap();
        let described = tool["inputSchema"]["properties"]["preset"]["description"]
            .as_str()
            .unwrap();
        // No stale hardcoded roster masquerading as the truth, and no empty
        // enum that would make every value invalid.
        assert!(described.contains("not reported"), "{described}");
        assert!(tool["inputSchema"]["properties"]["preset"]["enum"].is_null());
    }

    fn state_with_token(token: &str) -> ServerState {
        let (notify_tx, _) = broadcast::channel::<()>(1);
        let (send_tx, _) = broadcast::channel::<SendToAgentRequest>(1);
        let (read_tx, _) = broadcast::channel::<ReadOutputRequest>(1);
        let (spawn_tx, _) = broadcast::channel::<SpawnRequest>(1);
        ServerState {
            registry: Arc::new(Mutex::new(HashMap::new())),
            notify_tx,
            send_tx,
            read_tx,
            spawn_tx,
            port: 1234,
            token: token.to_string(),
            read_cb: Arc::new(|_| Vec::new()),
            spawn_fn: Arc::new(|_| {}),
            browser_emit_fn: Arc::new(|_, _, _| {}),
            deliver_emit_fn: Arc::new(|_, _, _| {}),
            pending_browser: Arc::new(DashMap::new()),
            pending_sends: Arc::new(DashMap::new()),
            project_root: Arc::new(Mutex::new(None)),
            agent_presets: Arc::new(Mutex::new(Vec::new())),
            assistant_names: Arc::new(Mutex::new(Vec::new())),
            reserved_names: Arc::new(Mutex::new(Vec::new())),
            sse_sessions: Arc::new(DashMap::new()),
        }
    }

    /// A state carrying the roster and a small name pool, as a running app has.
    async fn state_with_names(names: &[&str]) -> ServerState {
        let state = state_with_token("t");
        *state.agent_presets.lock().await = roster();
        *state.assistant_names.lock().await =
            names.iter().map(|n| n.to_string()).collect();
        state
    }

    async fn register(state: &ServerState, name: &str) {
        state.registry.lock().await.insert(
            name.to_string(),
            AgentEntry {
                session_id: 1,
                name: name.to_string(),
                preset: "claude".to_string(),
                label: name.to_string(),
                branch: None,
            },
        );
    }

    fn q(token: Option<&str>) -> AuthQuery {
        AuthQuery {
            token: token.map(String::from),
            session_id: None,
        }
    }

    // --- worker naming ------------------------------------------------------

    #[test]
    fn a_cli_flavoured_label_is_generic() {
        // The shapes an orchestrator's brain actually emits.
        for label in ["claude", "claude-1", "Claude Code 2", "claude_3", "Aider"] {
            assert!(is_generic_agent_name(label, &roster()), "{label}");
        }
    }

    #[test]
    fn a_bland_word_is_generic() {
        for label in ["agent", "Agent 1", "assistant", "bot-3", "worker", "worker-2", "  ", "7"] {
            assert!(is_generic_agent_name(label, &roster()), "{label}");
        }
    }

    #[test]
    fn a_real_name_is_not_generic() {
        // Both an app name and a name the orchestrator chose deliberately — a
        // worker the user has been told to expect as "Reviewer" must stay one.
        for label in ["Trinity", "Neo 2", "Reviewer", "Frontend", "claude-reviewer"] {
            assert!(!is_generic_agent_name(label, &roster()), "{label}");
        }
    }

    #[tokio::test]
    async fn an_unnamed_spawn_gets_a_name_from_the_apps_pool() {
        let state = state_with_names(&["Trinity"]).await;
        assert_eq!(assign_agent_name(&state, "").await.unwrap(), "Trinity");
    }

    #[tokio::test]
    async fn a_generic_label_is_replaced_by_a_real_name() {
        // The bug this exists for: the orchestrator labels its workers
        // "claude-1", "claude-2" and the user sees a fleet of identical stubs.
        let state = state_with_names(&["Trinity"]).await;
        assert_eq!(assign_agent_name(&state, "claude-1").await.unwrap(), "Trinity");
    }

    #[tokio::test]
    async fn a_deliberate_name_is_kept() {
        let state = state_with_names(&["Trinity"]).await;
        assert_eq!(assign_agent_name(&state, "Reviewer").await.unwrap(), "Reviewer");
    }

    #[tokio::test]
    async fn a_name_already_running_is_refused() {
        let state = state_with_names(&["Trinity"]).await;
        register(&state, "Reviewer").await;
        let err = assign_agent_name(&state, "Reviewer").await.unwrap_err();
        assert!(err.contains("already running"), "{err}");
    }

    #[tokio::test]
    async fn two_spawns_in_flight_cannot_take_the_same_name() {
        // Neither has been registered by the frontend yet, so the registry is
        // still empty when the second call picks — the reservation is the only
        // thing keeping them apart.
        let state = state_with_names(&["Trinity", "Morpheus"]).await;
        let first = assign_agent_name(&state, "").await.unwrap();
        let second = assign_agent_name(&state, "").await.unwrap();
        assert_ne!(first, second);
        assert!(state.registry.lock().await.is_empty());
    }

    // --- agent names as path components ------------------------------------
    //
    // A name is joined into `<root>/.spacron/reports/<name>.md`, which
    // `delegate_task` deletes and `check_task` reads back to its caller. These
    // guard that boundary: the caller is an LLM whose context carries a worker's
    // own report text, so an injected name is a realistic input, not a
    // hypothetical one.

    #[test]
    fn ordinary_agent_names_are_accepted() {
        for name in ["Trinity", "Trinity 2", "worker-3", "scout_a", "Neo"] {
            assert!(is_safe_agent_name(name), "should accept {name:?}");
        }
    }

    #[test]
    fn names_that_could_escape_the_reports_directory_are_refused() {
        for name in [
            "../secrets",
            "..",
            "a/b",
            "a\\b",
            "C:/Windows/Temp/x",
            "report.md",
            "trailing ",
            " leading",
            "nul\0byte",
            "",
        ] {
            assert!(!is_safe_agent_name(name), "should refuse {name:?}");
        }
        // Longer than the cap.
        assert!(!is_safe_agent_name(&"a".repeat(MAX_AGENT_NAME_LEN + 1)));
        // Win32 device names open the console even inside a directory.
        for name in ["CON", "nul", "Com1", "LPT9"] {
            assert!(!is_safe_agent_name(name), "should refuse device name {name:?}");
        }
    }

    #[test]
    fn report_paths_refuses_a_traversing_name() {
        assert!(report_paths("/tmp/project", "../../../../etc/hosts").is_err());
        assert!(report_paths("/tmp/project", "Trinity").is_ok());
    }

    #[test]
    fn report_paths_stay_inside_the_reports_directory() {
        let (done, blocked) = report_paths("/tmp/project", "Trinity 2").unwrap();
        let dir = std::path::Path::new("/tmp/project").join(".spacron").join("reports");
        assert_eq!(done.parent().unwrap(), dir);
        assert_eq!(blocked.parent().unwrap(), dir);
        assert_eq!(done.file_name().unwrap(), "Trinity 2.md");
        assert_eq!(blocked.file_name().unwrap(), "Trinity 2.blocked.md");
    }

    #[tokio::test]
    async fn a_traversing_name_is_refused_at_assignment() {
        let state = state_with_names(&["Trinity"]).await;
        let err = assign_agent_name(&state, "../../evil").await.unwrap_err();
        assert!(err.contains("not a usable agent name"), "{err}");
    }

    #[tokio::test]
    async fn every_assigned_name_is_path_safe() {
        // Covers the generated paths too: the numbered fallback and the
        // no-pool stub both end up as filenames.
        let state = state_with_names(&["Trinity"]).await;
        let first = assign_agent_name(&state, "").await.unwrap();
        register(&state, &first).await;
        let second = assign_agent_name(&state, "").await.unwrap();
        let stub = assign_agent_name(&state_with_names(&[]).await, "").await.unwrap();
        for name in [first, second, stub] {
            assert!(is_safe_agent_name(&name), "assigned an unusable name: {name:?}");
        }
    }

    #[tokio::test]
    async fn an_assigned_name_is_reserved_until_registration() {
        let state = state_with_names(&["Trinity"]).await;
        assign_agent_name(&state, "").await.unwrap();
        assert_eq!(state.reserved_names.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn a_pool_that_is_fully_taken_numbers_a_name() {
        let state = state_with_names(&["Trinity"]).await;
        register(&state, "Trinity").await;
        assert_eq!(assign_agent_name(&state, "").await.unwrap(), "Trinity 2");
    }

    #[tokio::test]
    async fn no_pool_yet_still_spawns() {
        // Startup window: the frontend has not pushed the names. A stub beats
        // refusing to launch the worker.
        let state = state_with_names(&[]).await;
        let name = assign_agent_name(&state, "").await.unwrap();
        assert!(name.starts_with("worker-"), "{name}");
    }

    // --- tail_from_char_boundary -------------------------------------------

    #[test]
    fn tail_returns_whole_string_when_under_cap() {
        assert_eq!(tail_from_char_boundary("hello", 100), "hello");
    }

    #[test]
    fn tail_cutting_inside_a_multibyte_char_does_not_panic() {
        // 'y' at byte 0, U+2500 (3 bytes) at 1..4, then ASCII filler. Sized so
        // the naive `len - max` offset lands at byte 2 — inside the box-drawing
        // character. This is the exact shape of real agent TUI output.
        let mut s = String::from("y─");
        s.push_str(&"x".repeat(51198));
        assert_eq!(s.len() - MAX_OUTPUT_BYTES, 2);
        assert!(!s.is_char_boundary(2));

        let tail = tail_from_char_boundary(&s, MAX_OUTPUT_BYTES);

        // Snapped forward past the split character rather than panicking.
        assert!(tail.starts_with('x'));
        assert_eq!(tail.len(), 51198);
    }

    #[test]
    fn tail_keeps_a_clean_cut_exact() {
        let s = "z".repeat(MAX_OUTPUT_BYTES + 10);
        let tail = tail_from_char_boundary(&s, MAX_OUTPUT_BYTES);
        assert_eq!(tail.len(), MAX_OUTPUT_BYTES);
    }

    #[test]
    fn tail_never_splits_a_char_for_any_offset() {
        // Sweep every cut point across an all-multibyte string.
        let s: String = "─".repeat(200); // 600 bytes
        for max in 1..s.len() {
            let tail = tail_from_char_boundary(&s, max);
            assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
            assert!(tail.len() <= max);
        }
    }

    // --- authorize ----------------------------------------------------------

    #[test]
    fn authorize_accepts_a_matching_token_with_no_origin() {
        let state = state_with_token("good-token");
        assert!(reject_unauthorized(&state, &HeaderMap::new(), &q(Some("good-token"))).is_none());
    }

    #[test]
    fn authorize_rejects_a_wrong_token() {
        let state = state_with_token("good-token");
        assert!(reject_unauthorized(&state, &HeaderMap::new(), &q(Some("bad-token"))).is_some());
    }

    #[test]
    fn authorize_rejects_a_missing_token() {
        let state = state_with_token("good-token");
        assert!(reject_unauthorized(&state, &HeaderMap::new(), &q(None)).is_some());
    }

    #[test]
    fn authorize_rejects_a_token_that_is_a_prefix_of_the_real_one() {
        let state = state_with_token("good-token");
        assert!(reject_unauthorized(&state, &HeaderMap::new(), &q(Some("good"))).is_some());
    }

    #[test]
    fn authorize_rejects_any_request_carrying_an_origin_even_with_a_valid_token() {
        // The DNS-rebinding case: a hostile page re-resolves its domain to
        // 127.0.0.1, so it is same-origin and its fetch is not preflighted.
        // Browsers always attach Origin; MCP CLI clients never do.
        let state = state_with_token("good-token");
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(reject_unauthorized(&state, &headers, &q(Some("good-token"))).is_some());
    }

    #[test]
    fn authorize_rejects_a_null_origin() {
        let state = state_with_token("good-token");
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "null".parse().unwrap());
        assert!(reject_unauthorized(&state, &headers, &q(Some("good-token"))).is_some());
    }

    // --- ct_eq --------------------------------------------------------------

    #[test]
    fn ct_eq_matches_only_identical_slices() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(!ct_eq(b"", b"a"));
        assert!(ct_eq(b"", b""));
    }

    // --- end-to-end over real HTTP -----------------------------------------
    //
    // The agent-to-agent transport had no test at all before this. These drive
    // an actually-bound server the way a CLI agent does, so they cover the
    // wiring (routing, extractor order, auth rejection) that testing `authorize`
    // in isolation cannot.

    /// What the stand-in frontend was asked to type: `(session_id, message)`.
    type SeenDeliveries = Arc<std::sync::Mutex<Vec<(u32, String)>>>;

    /// Boot a real server behind a stand-in frontend, and record what it is asked
    /// to deliver.
    ///
    /// `accept` decides the frontend's verdict. Something has to answer: sends now
    /// block until the frontend reports whether the agent actually took the
    /// message, so a server booted without a frontend would sit out the full
    /// delivery timeout on every send.
    fn boot_with_frontend(accept: bool) -> (String, String, McpServerHandle, SeenDeliveries) {
        let seen: SeenDeliveries = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let recorder = seen.clone();

        let (handle, port) = start(
            0,
            Arc::new(|_| b"agent output".to_vec()),
            Arc::new(|_| {}),
            Arc::new(|_, _, _| {}),
            Arc::new(move |request_id, session_id, message| {
                recorder
                    .lock()
                    .unwrap()
                    .push((session_id, message.to_string()));
                let _ = tx.send(request_id.to_string());
            }),
        )
        .expect("server should start");

        let pending = handle.pending_sends.clone();
        tokio::spawn(async move {
            while let Some(id) = rx.recv().await {
                if let Some((_, p)) = pending.remove(&id) {
                    let _ = p.tx.send(if accept {
                        Ok(serde_json::Value::Bool(true))
                    } else {
                        Err("The agent did not accept the message.".to_string())
                    });
                }
            }
        });

        let token = handle.token.clone();
        (format!("http://127.0.0.1:{port}"), token, handle, seen)
    }

    /// Boot a real server and return `(base_url, token, handle)`.
    fn boot() -> (String, String, McpServerHandle) {
        let (base, token, handle, _) = boot_with_frontend(true);
        (base, token, handle)
    }

    async fn wait_until_listening(base: &str, token: &str) {
        let client = reqwest::Client::new();
        for _ in 0..100 {
            let ok = client
                .post(format!("{base}/message?token={token}"))
                .json(&serde_json::json!({"jsonrpc":"2.0","id":0,"method":"initialize"}))
                .send()
                .await
                .is_ok();
            if ok {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("MCP server never came up");
    }

    /// Read an in-flight SSE response until `needle` shows up, or give up.
    /// Returns everything read so far either way, so a failing assertion can
    /// show what the stream actually delivered.
    async fn read_sse_until(resp: &mut reqwest::Response, needle: &str) -> String {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut buf = String::new();
            loop {
                match resp.chunk().await {
                    Ok(Some(bytes)) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        if buf.contains(needle) {
                            return buf;
                        }
                    }
                    // Stream ended or broke; hand back what we have.
                    _ => return buf,
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("SSE stream never produced {needle:?}"))
    }

    /// Open an SSE stream and return it plus the POST endpoint it advertises.
    async fn open_sse(base: &str, token: &str) -> (reqwest::Response, String) {
        let mut resp = reqwest::Client::new()
            .get(format!("{base}/sse?token={token}"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);

        let raw = read_sse_until(&mut resp, "event: endpoint").await;
        let endpoint = raw
            .lines()
            .find(|l| l.starts_with("data: http"))
            .map(|l| l.trim_start_matches("data: ").trim().to_string())
            .unwrap_or_else(|| panic!("no endpoint event in stream: {raw:?}"));

        (resp, endpoint)
    }

    #[tokio::test]
    async fn an_sse_client_gets_its_response_on_the_stream_not_in_the_post_body() {
        // The regression this guards: responses used to be returned in the POST
        // body only. An SSE client never reads that body — it blocks on the
        // stream waiting for a matching `id` — so every client hung through
        // `initialize` and reported "connection timed out after 30000ms".
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        let (mut stream, endpoint) = open_sse(&base, &token).await;
        assert!(
            endpoint.contains("sessionId="),
            "endpoint must identify the stream so the reply can be routed: {endpoint}"
        );

        let status = reqwest::Client::new()
            .post(&endpoint)
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2024-11-05", "capabilities": {} }
            }))
            .send()
            .await
            .unwrap()
            .status();

        // Accepted, not answered: the answer belongs on the stream.
        assert_eq!(status, reqwest::StatusCode::ACCEPTED);

        let raw = read_sse_until(&mut stream, "\"id\":1").await;
        assert!(
            raw.contains("spacron-mcp"),
            "initialize result never arrived on the stream: {raw:?}"
        );
    }

    #[tokio::test]
    async fn an_sse_client_gets_tool_results_on_the_stream() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        handle.register_agent(7, "Iris", "claude", "Agent 1", None).await;

        let (mut stream, endpoint) = open_sse(&base, &token).await;

        reqwest::Client::new()
            .post(&endpoint)
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                "params": { "name": "list_agents" }
            }))
            .send()
            .await
            .unwrap();

        let raw = read_sse_until(&mut stream, "\"id\":9").await;
        assert!(raw.contains("Iris"), "tool result never reached the stream: {raw:?}");
    }

    #[tokio::test]
    async fn a_notification_is_accepted_without_a_reply() {
        // A JSON-RPC notification carries no `id`, so answering it at all is a
        // protocol violation — clients treat an unsolicited response as an error.
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        let (mut stream, endpoint) = open_sse(&base, &token).await;

        let client = reqwest::Client::new();
        let status = client
            .post(&endpoint)
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "method": "notifications/initialized"
            }))
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(status, reqwest::StatusCode::ACCEPTED);

        // Follow it with a real request. Once *its* reply lands, anything the
        // notification wrongly produced would already be in the buffer ahead of
        // it — an `id: null` response is exactly what the old code emitted.
        client
            .post(&endpoint)
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 5, "method": "tools/list"
            }))
            .send()
            .await
            .unwrap();

        let raw = read_sse_until(&mut stream, "\"id\":5").await;
        assert!(
            !raw.contains("\"id\":null"),
            "server answered a notification: {raw:?}"
        );
    }

    // --- streamable HTTP transport (`/mcp`) ---------------------------------
    //
    // Codex CLI speaks only this transport, so these cover the path that makes
    // it — and Gemini CLI, droid, opencode — able to connect at all.

    #[tokio::test]
    async fn the_streamable_endpoint_answers_in_the_body() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        handle.register_agent(7, "Iris", "claude", "Agent 1", None).await;

        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/mcp?token={token}"))
            .header("Accept", "application/json, text/event-stream")
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "list_agents" }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let text = body["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Iris"), "expected the registered agent, got: {text}");
    }

    #[tokio::test]
    async fn the_streamable_endpoint_acknowledges_notifications_without_answering() {
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        let resp = reqwest::Client::new()
            .post(format!("{base}/mcp?token={token}"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "method": "notifications/initialized"
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::ACCEPTED);
        assert!(
            resp.text().await.unwrap().is_empty(),
            "a notification must not be answered"
        );
    }

    #[tokio::test]
    async fn the_streamable_endpoint_declines_the_optional_get_stream() {
        // 405 is the spec's "this server offers no server-initiated stream".
        // A 200 with a JSON body here reads as a malformed SSE stream instead
        // and takes the whole connection down with it.
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        let status = reqwest::Client::new()
            .get(format!("{base}/mcp?token={token}"))
            .header("Accept", "text/event-stream")
            .send()
            .await
            .unwrap()
            .status();

        assert_eq!(status, reqwest::StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn the_streamable_endpoint_is_gated_too() {
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        let status = reqwest::Client::new()
            .post(format!("{base}/mcp"))
            .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .send()
            .await
            .unwrap()
            .status();

        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn check_task_refuses_a_handle_that_climbs_out_of_the_project() {
        // The end-to-end version of `report_paths_refuses_a_traversing_name`.
        // `check_task` never consults the registry, so before validation this
        // read any `.md` file on the machine and returned it to the caller.
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        *handle.project_root.lock().await = Some("/tmp/project".to_string());

        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/mcp?token={token}"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {
                    "name": "check_task",
                    "arguments": { "handle": "../../../../../../etc/hosts", "wait_seconds": 1 }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("not a usable agent name"),
            "traversing handle was not refused: {body}"
        );
    }

    #[tokio::test]
    async fn a_valid_token_reaches_the_tools() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        handle.register_agent(7, "Iris", "claude", "Agent 1", None).await;

        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/message?token={token}"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "list_agents" }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let text = body["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Iris"), "expected the registered agent, got: {text}");
    }

    #[tokio::test]
    async fn send_to_agent_still_works_end_to_end() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        handle.register_agent(7, "Trinity", "codex", "Agent 2", None).await;

        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/message?token={token}"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "send_to_agent",
                    "arguments": { "name": "Trinity", "message": "status?" }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert!(body.get("error").is_none(), "unexpected error: {body}");
        let text = body["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Trinity"));
    }

    /// The bug: this used to be a raw PTY write with no Enter and no bracketed
    /// paste, so the message sat unsubmitted in the agent's composer. It has to
    /// reach the frontend, which owns the paste-and-submit sequence.
    #[tokio::test]
    async fn send_to_agent_hands_the_message_to_the_frontend_to_type() {
        let (base, token, handle, seen) = boot_with_frontend(true);
        wait_until_listening(&base, &token).await;
        handle.register_agent(7, "Trinity", "opencode", "Agent 2", None).await;

        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/message?token={token}"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "send_to_agent",
                    "arguments": { "name": "Trinity", "message": "line one\nline two" }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert!(body.get("error").is_none(), "unexpected error: {body}");
        let deliveries = seen.lock().unwrap().clone();
        assert_eq!(deliveries.len(), 1, "expected exactly one delivery");
        assert_eq!(deliveries[0].0, 7, "must target the registered session");
        // Handed over intact — the frontend brackets and submits it; splitting or
        // pre-terminating it here is what scattered multi-line messages.
        assert_eq!(deliveries[0].1, "line one\nline two");
    }

    /// A send the agent never took must read as a failure. Reporting success
    /// leaves an orchestrator waiting on work nobody was asked to do.
    #[tokio::test]
    async fn a_send_the_agent_refuses_is_reported_as_an_error() {
        let (base, token, handle, _) = boot_with_frontend(false);
        wait_until_listening(&base, &token).await;
        handle.register_agent(7, "Trinity", "opencode", "Agent 2", None).await;

        let body: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/message?token={token}"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "send_to_agent",
                    "arguments": { "name": "Trinity", "message": "status?" }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert!(body.get("error").is_some(), "should not claim success: {body}");
        assert!(body["result"].is_null());
    }

    /// A bounce carries feedback plus two report paths, so it is always
    /// multi-line — the exact shape a raw write scattered.
    #[tokio::test]
    async fn bounce_task_delivers_its_whole_message_in_one_go() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let (base, token, handle, seen) = boot_with_frontend(true);
        wait_until_listening(&base, &token).await;
        *handle.project_root.lock().await = Some(root);
        handle.register_agent(7, "Trinity", "opencode", "Agent 2", None).await;

        let _: serde_json::Value = reqwest::Client::new()
            .post(format!("{base}/message?token={token}"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "bounce_task",
                    "arguments": {
                        "handle": "Trinity",
                        "feedback": "Fix the null check in parse().",
                        "wait_seconds": 1
                    }
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let deliveries = seen.lock().unwrap().clone();
        assert_eq!(deliveries.len(), 1, "the bounce must go as one delivery");
        let message = &deliveries[0].1;
        assert!(message.contains("Fix the null check"), "{message}");
        assert!(message.contains("write your summary again"), "{message}");
    }

    #[tokio::test]
    async fn a_request_without_a_token_is_rejected() {
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        let status = reqwest::Client::new()
            .post(format!("{base}/message"))
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "list_agents" }
            }))
            .send()
            .await
            .unwrap()
            .status();

        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_browser_origin_is_rejected_even_with_the_right_token() {
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        // What a DNS-rebound page looks like on the wire.
        let status = reqwest::Client::new()
            .post(format!("{base}/message?token={token}"))
            .header("Origin", "https://evil.example")
            .json(&serde_json::json!({
                "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {
                    "name": "send_to_agent",
                    "arguments": { "name": "Iris", "message": "rm -rf /" }
                }
            }))
            .send()
            .await
            .unwrap()
            .status();

        assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn the_sse_route_is_gated_too() {
        let (base, token, _handle) = boot();
        wait_until_listening(&base, &token).await;

        let client = reqwest::Client::new();
        assert_eq!(
            client.get(format!("{base}/sse")).send().await.unwrap().status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/sse?token={token}"))
                .header("Origin", "https://evil.example")
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::FORBIDDEN
        );
    }
}
