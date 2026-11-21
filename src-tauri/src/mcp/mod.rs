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
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc, Mutex, oneshot};

use crate::commands::mobile;

/// Callback for reading output from a PTY session by session id.
pub type ReadFn = Arc<dyn Fn(u32) -> Vec<u8> + Send + Sync>;

/// Callback for forwarding a spawn-agent request to the frontend.
pub type SpawnFn = Arc<dyn Fn(SpawnRequest) + Send + Sync>;

/// Callback for asking the frontend to deliver a prompt into an agent's TUI.
/// Arguments: (request_id, session_id, message).
pub type DeliverEmitFn = Arc<dyn Fn(&str, u32, &str) + Send + Sync>;

/// Callback for a `report_status` call — an agent saying something about
/// *itself*, as opposed to every other tool here, which acts on someone else.
pub type ReportFn = Arc<dyn Fn(AgentReport) + Send + Sync>;

/// One agent's report about its own turn.
///
/// `session_id` is the whole point: it comes from the token the caller
/// presented, not from anything the caller said, so a report either is
/// attributable to a specific PTY session or is explicitly not. The frontend
/// treats the two differently — see `agent-report` in `mcpBridge.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReport {
    /// The session whose per-launch token was presented, or `None` when the
    /// caller authenticated with the app-wide token and could be any agent.
    pub session_id: Option<u32>,
    /// "working" | "needs_input" | "done" | "failed" — validated before this
    /// struct is built, so the frontend can match exhaustively.
    pub state: String,
    /// The agent's own words. Empty when it said nothing.
    pub detail: String,
}

/// Who is calling, as established by the presented token.
#[derive(Clone, Copy, Debug, Default)]
pub struct Caller {
    /// The PTY session this token was bound to. `None` for the app-wide token,
    /// which every agent shares and which therefore identifies nobody.
    pub session_id: Option<u32>,
}

/// Per-launch agent tokens: token → the session it is bound to.
///
/// A `std::sync::Mutex` rather than the tokio one every other shared map here
/// uses, because the authorization check that reads it is synchronous and
/// holds the lock for a single map lookup with no await in between.
pub type AgentTokens = Arc<std::sync::Mutex<HashMap<String, Option<u32>>>>;

/// A pending prompt delivery awaiting the frontend's verdict.
///
/// A delivery may legitimately sit for half a minute waiting for a booting CLI
/// to reach its prompt, so the sweeper gives it its own long ceiling
/// ([`DELIVER_SWEEP_AFTER`]) rather than a request-response timeout.
pub struct PendingSend {
    pub tx: oneshot::Sender<Result<serde_json::Value, String>>,
    pub created_at: Instant,
}

/// The user's image/video provider choice, pushed from Settings by the
/// frontend (`mediaGeneration` in `stores/settings.ts`) so `generate_image` and
/// `generate_video` honour it for agents exactly as they do in the chat.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaSettings {
    pub image_provider: String,
    pub video_provider: String,
    pub image_models: HashMap<String, String>,
    pub video_models: HashMap<String, String>,
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
    ///
    /// It authenticates but does not *identify*: every agent on this machine
    /// presents the same string, so a tool call made with it proves only that
    /// the caller could read this user's config. [`agent_tokens`] is the
    /// narrower credential that answers "which agent".
    pub token: String,
    /// Per-launch tokens, keyed by token. The value is the PTY session the
    /// token was bound to, or `None` while the agent is still starting (the
    /// token has to exist *before* the session does, because it goes into the
    /// launch command — the same two-step as `prepareTurnSignals`).
    pub agent_tokens: AgentTokens,
    /// In-flight prompt deliveries awaiting frontend responses.
    pub pending_sends: PendingSends,
    /// Active project's main checkout, shared with the server. See `ServerState`.
    pub project_root: Arc<Mutex<Option<String>>>,
    /// Launchable agents, shared with the server. See `ServerState`.
    pub agent_presets: Arc<Mutex<Vec<AgentPreset>>>,
    /// The app's assistant-name pool, shared with the server. See `ServerState`.
    pub assistant_names: Arc<Mutex<Vec<String>>>,
    /// Media provider settings, shared with the server. See `ServerState`.
    pub media_settings: Arc<Mutex<MediaSettings>>,
    /// Names handed out but not yet registered. See `ServerState`.
    reserved_names: Arc<Mutex<Vec<NameReservation>>>,
    /// Computer-use switch and grants, shared with the server. See `crate::desktop`.
    pub desktop: Arc<crate::desktop::DesktopState>,
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
        drop(map);
        // A dead session's token must stop authenticating: it was written into
        // a config file that outlives the launch, and nothing else revokes it.
        self.forget_agent_session(session_id);
        // Computer-use grants end with the session that was given them.
        self.desktop.forget_session(session_id);
        let _ = self.notify_tx.send(());
    }

    /// Mint a per-launch token, not yet bound to any session.
    ///
    /// Called *before* the agent is spawned, because the token has to be inside
    /// the launch command. Until [`bind_agent_token`] runs it authenticates as
    /// "some agent this app started" — strictly better than the app-wide token,
    /// which authenticates as "someone who can read this user's config".
    pub fn mint_agent_token(&self) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut map) = self.agent_tokens.lock() {
            map.insert(token.clone(), None);
        }
        token
    }

    /// Bind a minted token to the session that was launched with it.
    ///
    /// Returns false for a token this server never minted (or already forgot),
    /// so a caller cannot bind an arbitrary string to a session.
    pub fn bind_agent_token(&self, token: &str, session_id: u32) -> bool {
        match self.agent_tokens.lock() {
            Ok(mut map) => match map.get_mut(token) {
                Some(slot) => {
                    *slot = Some(session_id);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    /// Drop one token — the launch it was minted for never happened.
    pub fn close_agent_token(&self, token: &str) {
        if let Ok(mut map) = self.agent_tokens.lock() {
            map.remove(token);
        }
    }

    /// Drop every token bound to a session that is gone.
    pub fn forget_agent_session(&self, session_id: u32) {
        if let Ok(mut map) = self.agent_tokens.lock() {
            map.retain(|_, bound| *bound != Some(session_id));
        }
    }

    /// Ping connected clients to re-read `tools/list`.
    ///
    /// The agent roster is baked into the `spawn_agent` / `delegate_task`
    /// schemas, so an agent that connected before the user added a custom agent
    /// would otherwise never see it.
    pub fn notify_tools_changed(&self) {
        let _ = self.notify_tx.send(());
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
            // Builds before 1.0 wrote this file at the umask default, so an
            // existing install carries a world-readable token that would stay
            // that way forever — the new file mode below only covers tokens
            // minted from here on. Tighten in place instead.
            restrict_existing_token_file(&path);
            return trimmed;
        }
    }
    // Create the directory and write a new token.
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let _ = write_token_file(&path, &token);
    token
}

/// Persist the token owner-only.
///
/// This file *is* the credential `reject_unauthorized` checks, and the second of
/// its two gates exists specifically to stop a local process that cannot read
/// this user's agent config from reaching the port. A plain `fs::write` inherits
/// the umask — 0644 on a typical Unix box — which hands that token to every
/// other account on the machine and makes the gate decorative. Created 0o600
/// instead, matching the preview cookie jar, which stores live session tokens
/// under the same reasoning. On Windows the app config dir's DACL is already
/// scoped to the user profile.
/// Narrow an already-existing token file to 0o600. No-op on Windows (the config
/// dir's DACL already scopes it) and whenever the mode is right, so the common
/// path costs one stat.
fn restrict_existing_token_file(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = fs::metadata(path) else { return };
        let mode = meta.permissions().mode();
        if mode & 0o077 == 0 {
            return;
        }
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Spacron's config directory, the parent of the token file.
pub(crate) fn config_dir() -> PathBuf {
    mcp_token_path().parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."))
}

/// Write a secret owner-only. Also used for MCP sign-in grants.
pub(crate) fn write_private_file(path: &Path, text: &str) -> std::io::Result<()> {
    write_token_file(path, text)
}

fn write_token_file(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(token.as_bytes())
}

/// Start the MCP HTTP+SSE server. Returns a [`McpServerHandle`] for
/// interacting with it.
///
/// - `port`: `0` = prefer the default port (51379), fall back to an OS-assigned
///   one if it is taken; otherwise bind exactly that port or fail.
/// - `read_cb`: callback to read output from a PTY session.
/// - `spawn_fn`: callback to forward a spawn-agent request to the frontend.
/// - `deliver_emit_fn`: callback to have the frontend type a prompt into an agent.
/// - `report_fn`: callback for an agent reporting on its own turn, carrying the
///   session identity the presented token proves (see [`AgentReport`]).
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
    deliver_emit_fn: DeliverEmitFn,
    report_fn: ReportFn,
    desktop_hooks: crate::desktop::DesktopHooks,
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
    let pending_sends: PendingSends = Arc::new(DashMap::new());
    let project_root: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let agent_presets: Arc<Mutex<Vec<AgentPreset>>> = Arc::new(Mutex::new(Vec::new()));
    let assistant_names: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let media_settings: Arc<Mutex<MediaSettings>> = Arc::new(Mutex::new(MediaSettings::default()));
    let reserved_names: Arc<Mutex<Vec<NameReservation>>> = Arc::new(Mutex::new(Vec::new()));
    let sse_sessions: SseSessions = Arc::new(DashMap::new());
    // Persistent bearer-equivalent shared secret, loaded from the user's config
    // dir on every start so that external config files (.mcp.json, opencode.json)
    // can be written once and survive app restarts.
    let token = load_or_create_token();
    // Never persisted, unlike `token`: a per-launch credential that outlived the
    // launch would be a config file authenticating as an agent that no longer
    // exists. These die with the process, and every agent gets a fresh one.
    let agent_tokens: AgentTokens = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let desktop = crate::desktop::DesktopState::new(desktop_hooks);

    let server_state = Arc::new(ServerState {
        desktop: desktop.clone(),
        registry: registry.clone(),
        notify_tx: notify_tx.clone(),
        send_tx,
        read_tx,
        spawn_tx,
        port: actual_port,
        token: token.clone(),
        agent_tokens: agent_tokens.clone(),
        read_cb,
        spawn_fn,
        deliver_emit_fn,
        report_fn,
        pending_sends: pending_sends.clone(),
        project_root: project_root.clone(),
        agent_presets: agent_presets.clone(),
        assistant_names: assistant_names.clone(),
        media_settings: media_settings.clone(),
        reserved_names: reserved_names.clone(),
        sse_sessions,
    });

    // Background sweep: drop deliveries whose caller is long gone, so a frontend
    // that never answers cannot leak senders. The ceiling is generous — a
    // delivery waits on a CLI reaching its prompt.
    let sweep_sends = pending_sends.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
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
        // Signed-in remote servers, reached through Spacron so the agent never
        // holds the OAuth token. See `commands::mcp_oauth`.
        .route("/proxy/{key}", axum::routing::any(proxy_handler))
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
        agent_tokens,
        pending_sends,
        project_root,
        agent_presets,
        assistant_names,
        media_settings,
        reserved_names,
        desktop,
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
    /// Per-launch tokens that additionally identify *which* agent is calling.
    /// See [`McpServerHandle::mint_agent_token`].
    agent_tokens: AgentTokens,
    read_cb: ReadFn,
    spawn_fn: SpawnFn,
    /// Asks the frontend to type a prompt into an agent's TUI. See
    /// [`deliver_to_session`] for why this cannot be a direct PTY write.
    deliver_emit_fn: DeliverEmitFn,
    /// Hands a `report_status` call to the frontend.
    report_fn: ReportFn,
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
    /// Provider choice for `generate_image` / `generate_video`. Default (empty)
    /// means "auto", which is also what Settings starts at.
    media_settings: Arc<Mutex<MediaSettings>>,
    /// Names already handed to a spawn that the frontend has not registered yet.
    /// Registration is asynchronous, so without this two `delegate_task` calls a
    /// few milliseconds apart both see the same pool free and pick one name —
    /// which then collides in the registry and makes `send_to_agent` ambiguous.
    reserved_names: Arc<Mutex<Vec<NameReservation>>>,
    /// Live SSE clients, so `POST /message` can deliver a JSON-RPC response to
    /// the stream the requesting client is listening on. See [`SseSessions`].
    sse_sessions: SseSessions,
    /// Computer use: the global switch and per-session grants.
    desktop: Arc<crate::desktop::DesktopState>,
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

/// The one tool here an agent uses to talk about *itself*.
///
/// Everything else in this file acts on some other agent; this reports the
/// caller's own turn. That makes it the only tool whose value depends on the
/// caller being identified, which is why the per-launch token exists — see
/// [`authorize`]. The wording is deliberately imperative: a description that
/// merely permits reporting gets used once and then forgotten mid-task.
fn tool_report_status() -> serde_json::Value {
    serde_json::json!({
        "name": "report_status",
        "description": "Tell Spacron what you are doing. Call this when you finish your turn ('done'), when you are blocked and need the user ('needs_input'), or when you fail ('failed'). Spacron notifies the user from this call and from nothing else — if you do not call it, your turn ends silently and they are never told. Call it once per state change, not continuously.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "state": {
                    "type": "string",
                    "enum": ["working", "needs_input", "done", "failed"],
                    "description": "'working' = started or still going; 'needs_input' = stopped, waiting on the user; 'done' = turn finished; 'failed' = could not complete."
                },
                "detail": {
                    "type": "string",
                    "description": "One sentence for the user, in your own words: what you need, what you finished, or what went wrong. This is the text they see in the notification and the inbox, so write it for them, not for a log."
                },
                "agent_token": {
                    "type": "string",
                    "description": "The value of the SPACRON_AGENT_TOKEN environment variable in your shell. Pass it so Spacron knows which agent this report is about — without it the report cannot be tied to your terminal and cannot end your turn."
                }
            },
            "required": ["state"]
        }
    })
}

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

// ---------------------------------------------------------------------------
// Emulator tools
//
// Connected agents drive devices and emulators through the same
// `commands::mobile` backend the Mobile Emulator pane uses — same process, no
// IPC round-trip. Android gets full control (discover, boot, screenshot,
// tap/swipe/key/text/rotate, and logcat via adb); iOS gets discover,
// boot/shutdown and a view-only screenshot, because `simctl` cannot inject
// touches (that needs the Phase-4 serve-sim helper).
// ---------------------------------------------------------------------------

fn tool_emulator_list() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_list",
        "description": "Discover every mobile device and emulator the app can drive: the host platform, Android tooling availability, connected Android devices (with serials), installable Android AVDs, and iOS simulators (macOS only, with UDIDs). Returns the serials and UDIDs you pass to the other emulator_* tools. On Android, pick the stock phone AVD that ships with Android Studio — its default device, named like 'Medium_Phone_API_36' or 'Pixel_9_API_35' — unless the task is specifically about another form factor. See emulator_boot.",
        "inputSchema": { "type": "object", "properties": {}, "required": [] }
    })
}

fn tool_emulator_boot() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_boot",
        "description": "Boot an Android emulator or iOS simulator. Android: pass an AVD name from emulator_list — the emulator launches detached and can take over a minute to boot, so poll emulator_list until an emulator-* device reports state 'device' before interacting. ALWAYS prefer the standard phone AVD that comes with Android Studio (the default device in Device Manager — 'Medium Phone', or a 'Pixel' phone, named like 'Medium_Phone_API_36' / 'Pixel_9_API_35'): it is the reference form factor and the one this app's stream, tap and swipe path is tuned for. Only boot a tablet, foldable, Wear OS, TV or Automotive AVD when the task is explicitly about that form factor. If several phone AVDs are present, take the one with the highest API level. iOS: pass a simulator UDID; it opens in Simulator.app (macOS only).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android AVD name, or iOS simulator UDID, from emulator_list." },
                "platform": { "type": "string", "enum": ["android", "ios"], "description": "Which kind of target. Default 'android'." }
            },
            "required": ["target"]
        }
    })
}

fn tool_emulator_shutdown() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_shutdown",
        "description": "Shut down a running emulator or simulator. Android: pass an emulator-* serial from emulator_list (powers the emulator off via adb). iOS: pass a simulator UDID (simctl shutdown).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android emulator serial, or iOS simulator UDID, from emulator_list." },
                "platform": { "type": "string", "enum": ["android", "ios"], "description": "Which kind of target. Default 'android'." }
            },
            "required": ["target"]
        }
    })
}

fn tool_emulator_screenshot() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_screenshot",
        "description": "Capture the current screen of an Android device or iOS simulator as a base64 image. Android returns a JPEG plus the device's pixel width and height — use those dimensions to convert normalized (0–1) positions to pixels for emulator_tap and emulator_swipe. iOS returns a PNG with no dimensions (view-only). Take a fresh screenshot to see the result of your taps and swipes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android serial, or iOS UDID, from emulator_list." },
                "platform": { "type": "string", "enum": ["android", "ios"], "description": "Which kind of target. Default 'android'." }
            },
            "required": ["target"]
        }
    })
}

fn tool_emulator_tap() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_tap",
        "description": "Tap a point on an Android device screen. Coordinates are normalized 0.0–1.0 (0,0 is the top-left corner, 1,1 the bottom-right), so 'the center of the screen' is x=0.5, y=0.5 without knowing the resolution. Android only — iOS simulators cannot receive touches.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android device serial from emulator_list." },
                "x": { "type": "number", "description": "Normalized x, 0.0–1.0, from the left edge." },
                "y": { "type": "number", "description": "Normalized y, 0.0–1.0, from the top edge." }
            },
            "required": ["target", "x", "y"]
        }
    })
}

fn tool_emulator_swipe() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_swipe",
        "description": "Swipe (drag) on an Android device screen between two points. Coordinates are normalized 0.0–1.0 like emulator_tap — use it for scrolling, dismissing overlays, and pull-to-refresh. Android only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android device serial from emulator_list." },
                "x1": { "type": "number", "description": "Start x, normalized 0.0–1.0." },
                "y1": { "type": "number", "description": "Start y, normalized 0.0–1.0." },
                "x2": { "type": "number", "description": "End x, normalized 0.0–1.0." },
                "y2": { "type": "number", "description": "End y, normalized 0.0–1.0." },
                "duration_ms": { "type": "number", "description": "Optional. Gesture duration in ms (default 300, max 2000)." }
            },
            "required": ["target", "x1", "y1", "x2", "y2"]
        }
    })
}

fn tool_emulator_key() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_key",
        "description": "Press a hardware key on an Android device. Pass 'key' as a named key (back, home, recents, menu, power, volume_up, volume_down, enter, delete, tab, space, camera, search, notifications, media_play_pause, media_next, media_previous) or a raw Android keycode integer. Android only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android device serial from emulator_list." },
                "key": { "type": "string", "description": "A named key, or a raw Android keycode integer." }
            },
            "required": ["target", "key"]
        }
    })
}

fn tool_emulator_text() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_text",
        "description": "Type text into the currently focused field on an Android device. Works on the field that has focus — tap it first if needed. Android only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android device serial from emulator_list." },
                "text": { "type": "string", "description": "The text to type." }
            },
            "required": ["target", "text"]
        }
    })
}

fn tool_emulator_rotate() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_rotate",
        "description": "Rotate an Android device's display. Rotation 0 = portrait, 1 = landscape (90° clockwise), 2 = reverse portrait, 3 = reverse landscape. Auto-rotate is locked off so the orientation sticks. Android only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android device serial from emulator_list." },
                "rotation": { "type": "number", "description": "0–3. Default 1 (one 90° clockwise turn)." }
            },
            "required": ["target"]
        }
    })
}

fn tool_emulator_logcat() -> serde_json::Value {
    serde_json::json!({
        "name": "emulator_logcat",
        "description": "Read the recent Android system log (logcat) from a device — the app's own log output, stack traces, and system messages. Use it after installing or launching an app to see what it actually did. Optionally filter to lines containing a substring (e.g. the app's package name or a log tag). Returns the last N lines (default 100, max 500). Android only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "Android device serial from emulator_list." },
                "lines": { "type": "number", "description": "Optional. How many trailing lines to fetch (default 100, max 500)." },
                "filter": { "type": "string", "description": "Optional. Case-insensitive substring; only matching lines are returned." }
            },
            "required": ["target"]
        }
    })
}

/// Image and video generation for agents, on the same providers, keys and
/// Settings choice the chat uses (`images::generate_and_save`). Results land in
/// `<project>/generations`, so they sit with the work the agent is doing.
fn tool_generate_media(kind: &str) -> serde_json::Value {
    let (name, article, noun, extra) = if kind == "video" {
        ("generate_video", "a", "video", " Takes one to several minutes; wait for it rather than calling again.")
    } else {
        ("generate_image", "an", "image", "")
    };
    serde_json::json!({
        "name": name,
        "description": format!(
            "Generate {article} {noun} with the AI providers configured in Spacron (Settings > AI Providers) and save it to the project's `generations` folder. Returns the saved file's absolute path; use that file rather than generating {noun}s some other way.{extra}"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": format!("What the {noun} should show. Be specific about subject, style, composition and, for video, motion.")
                },
                "reference_images": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional absolute paths (at most 4) of images inside the project to edit or use as references."
                }
            },
            "required": ["prompt"]
        }
    })
}

/// Longest a `generate_image` / `generate_video` call may take. Video
/// providers poll for minutes; past this the agent is told it timed out rather
/// than left hanging. Mirrors `MEDIA_TOOL_TIMEOUT_SEC` in `stores/mcpBridge.ts`,
/// which raises the CLI-side timeout where the default is shorter.
const MEDIA_TIMEOUT: Duration = Duration::from_secs(840);

async fn generate_media_tool(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
    state: &ServerState,
    kind: &str,
) -> Json<JsonRpcResponse> {
    let args = tool_args(params);
    let prompt = args
        .and_then(|a| a.get("prompt"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if prompt.is_empty() {
        return Json(JsonRpcResponse::error(id, -32602, "Parameter 'prompt' is required"));
    }
    let references: Vec<String> = args
        .and_then(|a| a.get("reference_images"))
        .and_then(|v| v.as_array())
        .map(|list| list.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let root = state.project_root.lock().await.clone();
    let settings = state.media_settings.lock().await.clone();
    let (provider, models) = if kind == "video" {
        (settings.video_provider, settings.video_models)
    } else {
        (settings.image_provider, settings.image_models)
    };
    let config_dir = config_dir();
    let request_id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
    let work = crate::commands::images::generate_and_save(
        &config_dir,
        request_id.clone(),
        kind,
        Some(provider),
        models,
        prompt,
        references,
        root.as_deref(),
    );
    let result = match tokio::time::timeout(MEDIA_TIMEOUT, work).await {
        Ok(result) => result,
        Err(_) => {
            crate::commands::images::generate_image_cancel(request_id);
            Err(format!("timeout: the {kind} was not ready after {} minutes", MEDIA_TIMEOUT.as_secs() / 60))
        }
    };
    match result {
        Ok(made) => {
            let mut text = format!("Saved the {kind} to {}\nProvider: {}", made.path, made.provider);
            if let Some(revised) = made.revised_prompt.filter(|r| !r.trim().is_empty()) {
                text.push_str(&format!("\nRevised prompt: {revised}"));
            }
            if !made.skipped.is_empty() {
                text.push_str(&format!("\nSkipped first: {}", made.skipped.join("; ")));
            }
            Json(JsonRpcResponse::success(id, text_content(text)))
        }
        // A tool-level error (isError) rather than a JSON-RPC one, so the
        // agent reads the provider report and can tell the user what to fix.
        Err(e) => Json(JsonRpcResponse::success(
            id,
            serde_json::json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
        )),
    }
}

/// The Plugin Creator's instructions, the same file the built-in plugin ships
/// as its skill (`services/plugin-creator-skill.md`). Served as a tool so every
/// agent can build plugins, not only the ones that read skill folders.
const PLUGIN_CREATOR_GUIDE: &str = include_str!("../../../src/lib/services/plugin-creator-skill.md");

fn tool_plugin_creator_guide() -> serde_json::Value {
    serde_json::json!({
        "name": "plugin_creator_guide",
        "description": "Get the exact instructions for creating a Spacron plugin (MCP servers and skills packaged for Spacron, Claude Code and Codex). Call this first whenever the user asks you to create, build or edit a plugin.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn all_tools(presets: &[AgentPreset]) -> Vec<serde_json::Value> {
    vec![
        tool_report_status(),
        tool_list_agents(),
        tool_send_to_agent(),
        tool_read_agent_output(),
        tool_spawn_agent(presets),
        tool_delegate_task(presets),
        tool_bounce_task(),
        tool_check_task(),
        tool_emulator_list(),
        tool_emulator_boot(),
        tool_emulator_shutdown(),
        tool_emulator_screenshot(),
        tool_emulator_tap(),
        tool_emulator_swipe(),
        tool_emulator_key(),
        tool_emulator_text(),
        tool_emulator_rotate(),
        tool_emulator_logcat(),
        tool_generate_media("image"),
        tool_generate_media("video"),
        tool_plugin_creator_guide(),
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

// ---------------------------------------------------------------------------
// Signed-in server proxy
// ---------------------------------------------------------------------------

/// Request headers worth forwarding to a remote MCP server. Everything else —
/// above all the caller's own `Authorization` — is dropped.
const PROXY_REQUEST_HEADERS: &[&str] = &["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const PROXY_RESPONSE_HEADERS: &[&str] = &["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

fn proxy_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    // No overall timeout: a streamable-HTTP GET is a long-lived SSE stream.
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

async fn proxy_send(
    method: &axum::http::Method,
    headers: &HeaderMap,
    body: &axum::body::Bytes,
    grant: &crate::commands::mcp_oauth::Grant,
) -> Result<reqwest::Response, String> {
    let method = reqwest::Method::from_bytes(method.as_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = proxy_client()
        .request(method, &grant.resource)
        .bearer_auth(&grant.access_token)
        .body(body.to_vec());
    for name in PROXY_REQUEST_HEADERS {
        if let Some(value) = headers.get(*name) {
            req = req.header(*name, value.as_bytes());
        }
    }
    req.send().await.map_err(|e| e.to_string())
}

/// Forward an agent's MCP request to the server the user signed in to under
/// `key`, with a fresh access token. The target is the grant's own URL, so a
/// caller cannot point this anywhere else.
async fn proxy_handler(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(key): axum::extract::Path<String>,
    Query(query): Query<AuthQuery>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Err(rejection) = authorize(&state, &headers, &query) {
        return rejection;
    }
    // 403, not 401: a 401 would send the agent's own OAuth client looking for
    // sign-in metadata on 127.0.0.1, which is not where the sign-in lives.
    let not_signed_in = |detail: String| {
        (
            StatusCode::FORBIDDEN,
            format!("Not signed in to this MCP server ({key}). Sign in from Spacron: Settings > MCP & plugins. {detail}"),
        )
            .into_response()
    };
    let grant = match crate::commands::mcp_oauth::fresh_grant(&key, false).await {
        Ok(grant) => grant,
        Err(e) => return not_signed_in(e),
    };
    let mut upstream = match proxy_send(&method, &headers, &body, &grant).await {
        Ok(res) => res,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Could not reach {}: {e}", grant.resource)).into_response(),
    };
    // The token can be revoked or expire early; one forced refresh, then give up.
    if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
        match crate::commands::mcp_oauth::fresh_grant(&key, true).await {
            Ok(fresh) => match proxy_send(&method, &headers, &body, &fresh).await {
                Ok(res) => upstream = res,
                Err(e) => return (StatusCode::BAD_GATEWAY, e).into_response(),
            },
            Err(e) => return not_signed_in(e),
        }
        if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
            return not_signed_in("The server rejected the saved sign-in.".into());
        }
    }
    let mut out = Response::builder().status(upstream.status().as_u16());
    for name in PROXY_RESPONSE_HEADERS {
        if let Some(value) = upstream.headers().get(*name) {
            out = out.header(*name, value.as_bytes());
        }
    }
    out.body(axum::body::Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
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
    if let Err(rejection) = authorize(&state, &headers, &query) {
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
    let caller = match authorize(&state, &headers, &query) {
        Ok(caller) => caller,
        Err(rejection) => return rejection,
    };

    // A notification carries no `id` and must not be answered. Streamable HTTP
    // says to acknowledge it with `202 Accepted` and an empty body; replying
    // with a JSON-RPC object (which this used to do, `id` set to null) is a
    // protocol error the stricter clients reject outright.
    if req.id.is_none() {
        let _ = dispatch_message(state, req, caller).await;
        return StatusCode::ACCEPTED.into_response();
    }

    dispatch_message(state, req, caller).await.into_response()
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
    let caller = match authorize(&state, &headers, &query) {
        Ok(caller) => caller,
        Err(rejection) => return rejection,
    };

    let sse_tx = query
        .session_id
        .as_ref()
        .and_then(|sid| state.sse_sessions.get(sid).map(|e| e.value().clone()));

    let Some(tx) = sse_tx else {
        return dispatch_message(state, req, caller).await.into_response();
    };

    // A JSON-RPC notification (no `id`) must not be answered at all — a client
    // that receives a response it never asked for treats it as a protocol error.
    let is_notification = req.id.is_none();

    tokio::spawn(async move {
        let Json(resp) = dispatch_message(state, req, caller).await;
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
    caller: Caller,
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
            let mut tools = all_tools(&presets);
            // Computer use is listed only while the user has it switched on, so
            // an agent cannot even ask for it otherwise. Toggling it pings
            // `tools/list_changed` (see `mcp_set_computer_use`).
            if state.desktop.available() {
                tools.extend(crate::desktop::mcp_tools());
            }
            // Jev for agents is opt-in: while off, agents carry none of its
            // schema. Toggling it pings `tools/list_changed` (`mcp_set_jev_tool`).
            if crate::commands::jev::agent_tool_enabled() {
                tools.push(crate::commands::jev::mcp_tool_schema());
            }
            Json(JsonRpcResponse::success(id, serde_json::json!({ "tools": tools })))
        }

        "tools/call" => {
            handle_tool_call(id, req.params, &state, caller).await
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
    caller: Caller,
) -> Json<JsonRpcResponse> {
    let params = params.unwrap_or_default();
    let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");

    match tool_name {
        "report_status" => {
            let args = params.get("arguments").and_then(|a| a.as_object());
            let state_arg = args
                .and_then(|a| a.get("state"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            // Validated against the enum rather than passed through, so the
            // frontend can match on a closed set. An unknown value is a caller
            // bug worth reporting — silently coercing it to "working" would
            // turn a finished turn into one that never ends.
            if !matches!(
                state_arg.as_str(),
                "working" | "needs_input" | "done" | "failed"
            ) {
                return Json(JsonRpcResponse::error(
                    id,
                    -32602,
                    "Parameter 'state' must be one of: working, needs_input, done, failed",
                ));
            }
            let detail = args
                .and_then(|a| a.get("detail"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                // Long enough for a sentence, short enough that a card cannot
                // be used to paste a wall of text into the user's UI.
                .chars()
                .take(500)
                .collect::<String>();

            // Identity, in order of strength:
            //
            //  1. The token the caller *presented on the connection* — proof,
            //     and the only option for a CLI whose MCP config we write
            //     per launch (Claude Code, via `--mcp-config`).
            //  2. A token passed as an argument, matched against the ones this
            //     server minted. Every other CLI discovers the server from a
            //     shared config file, so its connection carries the app-wide
            //     token and cannot identify it. The per-launch token is instead
            //     put in that agent's PTY environment as SPACRON_AGENT_TOKEN,
            //     which only its own process tree can read — a shared secret
            //     rather than transport auth, but a real boundary, and the
            //     difference between "every agent works" and "one agent works".
            //
            // An unrecognised argument token resolves to None rather than
            // erroring: it means the report is unattributed, not invalid.
            let session_id = caller.session_id.or_else(|| {
                let claimed = args
                    .and_then(|a| a.get("agent_token"))
                    .and_then(|v| v.as_str())?
                    .trim();
                if claimed.is_empty() {
                    return None;
                }
                state.agent_tokens.lock().ok()?.get(claimed).copied().flatten()
            });

            (state.report_fn)(AgentReport {
                session_id,
                state: state_arg.clone(),
                detail: detail.clone(),
            });

            // The reply tells the agent whether the report was attributable.
            // An agent launched by Spacron always has its own token, so
            // "not attributed" means something is wrong with the launch path
            // and this is the only place it would ever be visible.
            let text = if session_id.is_some() {
                format!("Reported '{state_arg}' to Spacron; the user has been notified.")
            } else {
                format!(
                    "Reported '{state_arg}', but Spacron could not tell which agent sent it, \
                     so it cannot end your turn. Pass agent_token with the value of the \
                     SPACRON_AGENT_TOKEN environment variable."
                )
            };
            Json(JsonRpcResponse::success(
                id,
                serde_json::json!({ "content": [{ "type": "text", "text": text }] }),
            ))
        }

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

        // ── Emulators ────────────────────────────────────────────────────
        // These drive devices through `commands::mobile` directly — no frontend
        // round-trip, so they work for any connected agent, not just ones the
        // pane is open for. Each handler owns its own arg parsing.
        "emulator_list" => emulator_list(id).await,
        "emulator_boot" => emulator_boot(id, &params).await,
        "emulator_shutdown" => emulator_shutdown(id, &params).await,
        "emulator_screenshot" => emulator_screenshot(id, &params).await,
        "emulator_tap" => emulator_tap(id, &params).await,
        "emulator_swipe" => emulator_swipe(id, &params).await,
        "emulator_key" => emulator_key(id, &params).await,
        "emulator_text" => emulator_text(id, &params).await,
        "emulator_rotate" => emulator_rotate(id, &params).await,
        "emulator_logcat" => emulator_logcat(id, &params).await,

        // ── Media generation ─────────────────────────────────────────────
        "generate_image" => generate_media_tool(id, &params, state, "image").await,
        "generate_video" => generate_media_tool(id, &params, state, "video").await,
        "plugin_creator_guide" => {
            let root = state.project_root.lock().await.clone();
            let place = match root {
                Some(root) => format!("Create it in this project at {root}/plugins/<plugin-name>/ unless the user names another place."),
                None => "Create it in a folder the user names.".to_string(),
            };
            Json(JsonRpcResponse::success(id, text_content(format!("{PLUGIN_CREATOR_GUIDE}

{place}"))))
        }

        // ── Computer use ─────────────────────────────────────────────────
        // Grants belong to a session, so an anonymous caller is refused rather
        // than handed a grant nobody can revoke. Identity is resolved the same
        // way `report_status` does it: connection token first, then the
        // `agent_token` argument.
        "jev_classify" => {
            let root = state.project_root.lock().await.clone();
            match crate::commands::jev::run_agent_tool(tool_args(&params), root).await {
                Ok(report) => Json(JsonRpcResponse::success(id, text_content(report))),
                Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
            }
        }

        name if crate::desktop::is_desktop_tool(name) => {
            let args = tool_args(&params);
            let session_id = caller.session_id.or_else(|| {
                let claimed = args.and_then(|a| a.get("agent_token")).and_then(|v| v.as_str())?.trim();
                if claimed.is_empty() {
                    return None;
                }
                state.agent_tokens.lock().ok()?.get(claimed).copied().flatten()
            });
            let Some(session_id) = session_id else {
                return Json(JsonRpcResponse::error(
                    id,
                    -32602,
                    "Computer use needs to know which agent is asking. Pass your SPACRON_AGENT_TOKEN \
                     environment variable as 'agent_token'.",
                ));
            };
            let agent_name = state
                .registry
                .lock()
                .await
                .values()
                .find(|e| e.session_id == session_id)
                .map(|e| e.name.clone());
            let desktop_caller = crate::desktop::DesktopCaller {
                key: crate::desktop::CallerKey::Session(session_id),
                agent_name,
            };
            match crate::desktop::call_tool(&state.desktop, desktop_caller, name, args).await {
                Ok(result) => Json(JsonRpcResponse::success(id, result)),
                Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
            }
        }

        _ => Json(JsonRpcResponse::error(id, -32601, format!("Unknown tool: '{}'", tool_name))),
    }
}

// ---------------------------------------------------------------------------
// Emulator tool handlers
//
// Each handler parses its own arguments and calls `commands::mobile` directly.
// `target` is validated against the characters real adb serials and simctl
// UDIDs contain before it reaches any subprocess argument; coordinates are
// normalized (0–1) and converted to pixels against the device's live `wm size`.
// ---------------------------------------------------------------------------

/// The `{ "content": [{ "type": "text", "text": … }] }` wrapper every tool
/// result uses.
fn text_content(text: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "content": [{ "type": "text", "text": text.into() }] })
}

/// The `arguments` object of a `tools/call` request.
fn tool_args(params: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    params.get("arguments").and_then(|a| a.as_object())
}

/// Normalize the `platform` argument: `"android"` (default) or `"ios"`, either
/// case — an LLM is as likely to send "Android" as "android".
fn resolve_platform(raw: Option<&str>) -> Result<&'static str, String> {
    match raw
        .map(str::trim)
        .unwrap_or("android")
        .to_ascii_lowercase()
        .as_str()
    {
        "android" => Ok("android"),
        "ios" => Ok("ios"),
        other => Err(format!(
            "'{other}' is not a supported platform — use 'android' or 'ios'."
        )),
    }
}

/// Reject anything that cannot be a real adb serial or simctl UDID before it
/// reaches a subprocess argument. Serials are `emulator-5554`, USB ids like
/// `1a2b3c4d`, or `host:port` transports; UDIDs are hex UUIDs.
fn require_target(raw: Option<&str>) -> Result<String, String> {
    let target = raw.map(str::trim).unwrap_or("");
    if target.is_empty() {
        return Err("Missing required parameter 'target'.".to_string());
    }
    if !target
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
    {
        return Err(
            "'target' contains characters that are not valid in a device serial or UDID."
                .to_string(),
        );
    }
    Ok(target.to_string())
}

/// Named keys accepted by `emulator_key`, mapped to Android keycodes. The full
/// keycode table is too large to enumerate here, so a raw integer keycode is
/// also accepted by the handler.
fn android_keycode(name: &str) -> Option<i32> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "home" => 3,
        "back" => 4,
        "call" => 5,
        "end_call" => 6,
        "volume_up" => 24,
        "volume_down" => 25,
        "power" => 26,
        "camera" => 27,
        "tab" => 61,
        "space" => 62,
        "enter" => 66,
        "delete" | "backspace" => 67,
        "menu" => 82,
        "notifications" => 83,
        "search" => 84,
        "media_play_pause" => 85,
        "media_next" => 87,
        "media_previous" => 88,
        "recents" | "app_switch" => 187,
        _ => return None,
    })
}

/// One normalized (0–1) coordinate → device pixel. Out-of-range values fold
/// into [0, size]; the caller snaps the result to [0, size-1] so a 1.0 lands on
/// the last pixel rather than one past the framebuffer.
fn coord_to_pixel(normalized: f64, size: u32) -> i32 {
    (normalized.clamp(0.0, 1.0) * size as f64).round() as i32
}

/// Snap a computed pixel into the valid index range [0, size - 1].
fn clamp_pixel(px: i32, size: u32) -> i32 {
    px.min(size as i32 - 1).max(0)
}

/// Convert normalized (0–1) coordinates to device pixels, clamped into range so
/// a slightly-off 1.02 still lands on the screen edge instead of erroring.
async fn normalized_to_pixels(serial: &str, x: f64, y: f64) -> Result<(i32, i32), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("Coordinates must be finite numbers.".to_string());
    }
    let (w, h) = mobile::android_screen_size(serial).await?;
    Ok((
        clamp_pixel(coord_to_pixel(x, w), w),
        clamp_pixel(coord_to_pixel(y, h), h),
    ))
}

async fn emulator_list(id: Option<serde_json::Value>) -> Json<JsonRpcResponse> {
    let platform = mobile::mobile_platform();

    // Best-effort discovery: a missing adb/xcrun fails one section, not the
    // whole report, so an agent still sees what *is* reachable. Errors are
    // accumulated rather than last-write-wins, so when adb is missing the
    // report says so instead of being overwritten by the emulator error.
    let tools = mobile::android_check().await;
    let mut android_errors: Vec<String> = Vec::new();
    if !tools.adb && !tools.emulator {
        android_errors.push(
            "Neither adb nor the emulator was found — install the Android SDK platform-tools."
                .to_string(),
        );
    }
    let devices = match mobile::android_list_devices().await {
        Ok(d) => d,
        Err(e) => {
            android_errors.push(e);
            Vec::new()
        }
    };
    let avds = match mobile::android_list_avds().await {
        Ok(a) => a,
        Err(e) => {
            android_errors.push(e);
            Vec::new()
        }
    };
    let android_error = if android_errors.is_empty() {
        None
    } else {
        Some(android_errors.join(" "))
    };

    let (ios_available, sims, ios_error) = if platform == "macos" {
        match mobile::ios_list_simulators().await {
            Ok(s) => (true, s, None),
            Err(e) => (false, Vec::new(), Some(e)),
        }
    } else {
        (
            false,
            Vec::new(),
            Some("The iOS Simulator is only available on macOS.".to_string()),
        )
    };

    let payload = serde_json::json!({
        "platform": platform,
        "android": {
            "adb": tools.adb,
            "emulator": tools.emulator,
            "devices": devices.iter().map(|d| serde_json::json!({
                "serial": d.serial, "state": d.state, "label": d.label
            })).collect::<Vec<_>>(),
            "avds": avds,
            "error": android_error,
        },
        "ios": {
            "available": ios_available,
            "simulators": sims.iter().map(|s| serde_json::json!({
                "udid": s.udid, "name": s.name, "state": s.state, "runtime": s.runtime
            })).collect::<Vec<_>>(),
            "error": ios_error,
        },
    });

    Json(JsonRpcResponse::success(
        id,
        text_content(format!(
            "Mobile device discovery:\n{}",
            serde_json::to_string_pretty(&payload).unwrap_or_default()
        )),
    ))
}

async fn emulator_boot(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let args = tool_args(params);
    let platform =
        match resolve_platform(args.and_then(|a| a.get("platform")).and_then(|v| v.as_str())) {
            Ok(p) => p,
            Err(e) => return Json(JsonRpcResponse::error(id, -32602, e)),
        };
    let target = match require_target(args.and_then(|a| a.get("target")).and_then(|v| v.as_str())) {
        Ok(t) => t,
        Err(e) => return Json(JsonRpcResponse::error(id, -32602, e)),
    };

    let text = match platform {
        "ios" => match mobile::ios_boot(target.clone()).await {
            Ok(()) => format!(
                "Booting iOS simulator {target}. It opens in Simulator.app; poll emulator_list until its state is 'Booted'."
            ),
            Err(e) => return Json(JsonRpcResponse::error(id, -32000, e)),
        },
        _ => match mobile::android_launch_avd(target.clone()).await {
            Ok(()) => format!(
                "Launched Android AVD '{target}' detached. Booting can take over a minute — poll emulator_list until an emulator-* device reports state 'device'."
            ),
            Err(e) => return Json(JsonRpcResponse::error(id, -32000, e)),
        },
    };
    Json(JsonRpcResponse::success(id, text_content(text)))
}

async fn emulator_shutdown(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let args = tool_args(params);
    let platform =
        match resolve_platform(args.and_then(|a| a.get("platform")).and_then(|v| v.as_str())) {
            Ok(p) => p,
            Err(e) => return Json(JsonRpcResponse::error(id, -32602, e)),
        };
    let target = match require_target(args.and_then(|a| a.get("target")).and_then(|v| v.as_str())) {
        Ok(t) => t,
        Err(e) => return Json(JsonRpcResponse::error(id, -32602, e)),
    };

    let text = match platform {
        "ios" => match mobile::ios_shutdown(target.clone()).await {
            Ok(()) => format!("Shut down iOS simulator {target}."),
            Err(e) => return Json(JsonRpcResponse::error(id, -32000, e)),
        },
        _ => match mobile::android_emu_kill(target.clone()).await {
            Ok(()) => format!("Powered off Android emulator {target}."),
            Err(e) => return Json(JsonRpcResponse::error(id, -32000, e)),
        },
    };
    Json(JsonRpcResponse::success(id, text_content(text)))
}

async fn emulator_screenshot(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let args = tool_args(params);
    let platform =
        match resolve_platform(args.and_then(|a| a.get("platform")).and_then(|v| v.as_str())) {
            Ok(p) => p,
            Err(e) => return Json(JsonRpcResponse::error(id, -32602, e)),
        };
    let target = match require_target(args.and_then(|a| a.get("target")).and_then(|v| v.as_str())) {
        Ok(t) => t,
        Err(e) => return Json(JsonRpcResponse::error(id, -32602, e)),
    };

    match platform {
        "ios" => match mobile::ios_screenshot(target.clone()).await {
            Ok(png) => {
                let payload = serde_json::json!({
                    "target": target,
                    "format": "png",
                    "image": png,
                    "note": "iOS is view-only: no touch input and no reported dimensions. Use the image directly.",
                });
                Json(JsonRpcResponse::success(
                    id,
                    text_content(format!(
                        "iOS simulator screenshot:\n{}",
                        serde_json::to_string_pretty(&payload).unwrap_or_default()
                    )),
                ))
            }
            Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
        },
        _ => match mobile::android_screencap(target.clone()).await {
            Ok(frame) => {
                let payload = serde_json::json!({
                    "target": target,
                    "format": "jpeg",
                    "width": frame.width,
                    "height": frame.height,
                    "image": frame.image,
                    "hint": "Convert normalized positions to pixels with: px = round(x * width), py = round(y * height).",
                });
                Json(JsonRpcResponse::success(
                    id,
                    text_content(format!(
                        "Android screenshot ({}x{}):\n{}",
                        frame.width,
                        frame.height,
                        serde_json::to_string_pretty(&payload).unwrap_or_default()
                    )),
                ))
            }
            Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
        },
    }
}

/// Shared entry for the touch tools: parse platform/target, refuse iOS (simctl
/// cannot inject touches), and hand back the validated serial.
fn android_touch_target(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Result<(Option<serde_json::Value>, String), Json<JsonRpcResponse>> {
    let args = tool_args(params);
    let platform =
        match resolve_platform(args.and_then(|a| a.get("platform")).and_then(|v| v.as_str())) {
            Ok(p) => p,
            Err(e) => return Err(Json(JsonRpcResponse::error(id, -32602, e))),
        };
    if platform == "ios" {
        return Err(Json(JsonRpcResponse::error(
            id,
            -32602,
            "This tool works on Android only — iOS simulators cannot receive touches (simctl has no input injection).",
        )));
    }
    let target = match require_target(args.and_then(|a| a.get("target")).and_then(|v| v.as_str())) {
        Ok(t) => t,
        Err(e) => return Err(Json(JsonRpcResponse::error(id, -32602, e))),
    };
    Ok((id, target))
}

async fn emulator_tap(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let (id, target) = match android_touch_target(id, params) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let args = tool_args(params);
    let x = args.and_then(|a| a.get("x")).and_then(|v| v.as_f64());
    let y = args.and_then(|a| a.get("y")).and_then(|v| v.as_f64());
    let (Some(x), Some(y)) = (x, y) else {
        return Json(JsonRpcResponse::error(
            id,
            -32602,
            "emulator_tap needs 'x' and 'y' (normalized 0.0–1.0 numbers).",
        ));
    };

    let (px, py) = match normalized_to_pixels(&target, x, y).await {
        Ok(p) => p,
        Err(e) => return Json(JsonRpcResponse::error(id, -32000, e)),
    };
    match mobile::android_tap(target.clone(), px, py).await {
        Ok(()) => Json(JsonRpcResponse::success(
            id,
            text_content(format!(
                "Tapped at ({px}, {py}) on {target} (normalized ({x}, {y})). Take a screenshot to confirm."
            )),
        )),
        Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
    }
}

async fn emulator_swipe(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let (id, target) = match android_touch_target(id, params) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let args = tool_args(params);
    let x1 = args.and_then(|a| a.get("x1")).and_then(|v| v.as_f64());
    let y1 = args.and_then(|a| a.get("y1")).and_then(|v| v.as_f64());
    let x2 = args.and_then(|a| a.get("x2")).and_then(|v| v.as_f64());
    let y2 = args.and_then(|a| a.get("y2")).and_then(|v| v.as_f64());
    let (Some(x1), Some(y1), Some(x2), Some(y2)) = (x1, y1, x2, y2) else {
        return Json(JsonRpcResponse::error(
            id,
            -32602,
            "emulator_swipe needs 'x1', 'y1', 'x2' and 'y2' (normalized 0.0–1.0 numbers).",
        ));
    };
    let duration_ms = args
        .and_then(|a| a.get("duration_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(300)
        .clamp(50, 2000);

    let (p1x, p1y) = match normalized_to_pixels(&target, x1, y1).await {
        Ok(p) => p,
        Err(e) => return Json(JsonRpcResponse::error(id, -32000, e)),
    };
    let (p2x, p2y) = match normalized_to_pixels(&target, x2, y2).await {
        Ok(p) => p,
        Err(e) => return Json(JsonRpcResponse::error(id, -32000, e)),
    };
    match mobile::android_swipe(target.clone(), p1x, p1y, p2x, p2y, duration_ms as i32).await {
        Ok(()) => Json(JsonRpcResponse::success(
            id,
            text_content(format!(
                "Swiped from ({p1x}, {p1y}) to ({p2x}, {p2y}) on {target} over {duration_ms} ms."
            )),
        )),
        Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
    }
}

async fn emulator_key(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let (id, target) = match android_touch_target(id, params) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let args = tool_args(params);
    let key = args
        .and_then(|a| a.get("key"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if key.trim().is_empty() {
        return Json(JsonRpcResponse::error(
            id,
            -32602,
            "emulator_key needs a 'key' — a named key or a raw Android keycode integer.",
        ));
    }

    // A raw integer keycode passes straight through; otherwise look the name
    // up. Parsed once — the same value also labels the success message.
    let raw_keycode = key.trim().parse::<i32>().ok();
    let keycode = raw_keycode.or_else(|| android_keycode(key));
    let Some(keycode) = keycode else {
        return Json(JsonRpcResponse::error(
            id,
            -32602,
            format!(
                "Unknown key '{key}'. Named keys: back, home, recents, menu, power, volume_up, volume_down, enter, delete, tab, space, camera, search, notifications, media_play_pause, media_next, media_previous — or pass a raw Android keycode integer."
            ),
        ));
    };
    let label = if raw_keycode.is_some() {
        "keycode"
    } else {
        key.trim()
    };

    match mobile::android_key(target.clone(), keycode).await {
        Ok(()) => Json(JsonRpcResponse::success(
            id,
            text_content(format!("Pressed '{label}' (keycode {keycode}) on {target}.")),
        )),
        Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
    }
}

async fn emulator_text(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let (id, target) = match android_touch_target(id, params) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let args = tool_args(params);
    let text = args
        .and_then(|a| a.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if text.is_empty() {
        return Json(JsonRpcResponse::error(
            id,
            -32602,
            "emulator_text needs a non-empty 'text' to type.",
        ));
    }
    if text.len() > 4096 {
        return Json(JsonRpcResponse::error(
            id,
            -32602,
            "emulator_text accepts at most 4096 characters.",
        ));
    }

    match mobile::android_text(target.clone(), text.to_string()).await {
        Ok(()) => Json(JsonRpcResponse::success(
            id,
            text_content(format!("Typed {} character(s) into the focused field on {target}.", text.chars().count())),
        )),
        Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
    }
}

async fn emulator_rotate(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let (id, target) = match android_touch_target(id, params) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let args = tool_args(params);
    let rotation = args
        .and_then(|a| a.get("rotation"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1)
        .clamp(0, 3);

    match mobile::android_rotate(target.clone(), rotation as i32).await {
        Ok(()) => Json(JsonRpcResponse::success(
            id,
            text_content(format!(
                "Rotated {target} to orientation {rotation} (0 portrait, 1 landscape, 2 reverse portrait, 3 reverse landscape)."
            )),
        )),
        Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
    }
}

async fn emulator_logcat(
    id: Option<serde_json::Value>,
    params: &serde_json::Value,
) -> Json<JsonRpcResponse> {
    let (id, target) = match android_touch_target(id, params) {
        Ok(t) => t,
        Err(resp) => return resp,
    };
    let args = tool_args(params);
    let lines = args
        .and_then(|a| a.get("lines"))
        .and_then(|v| v.as_u64())
        .map(|v| v as i32);
    let filter = args
        .and_then(|a| a.get("filter"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    match mobile::android_logcat(target.clone(), lines, filter).await {
        Ok(log) => {
            let payload = serde_json::json!({ "target": target, "log": log });
            Json(JsonRpcResponse::success(
                id,
                text_content(format!(
                    "Logcat:\n{}",
                    serde_json::to_string_pretty(&payload).unwrap_or_default()
                )),
            ))
        }
        Err(e) => Json(JsonRpcResponse::error(id, -32000, e)),
    }
}

// ---------------------------------------------------------------------------
// In-process entry for the orchestrator brain
// ---------------------------------------------------------------------------
//
// The orchestrator runs inside the app, not behind the HTTP server, so it
// cannot reach these tools the way a CLI agent does — it has no MCP client. It
// calls them through here instead, which routes to the *same* handlers above
// rather than to a second copy of the logic. That matters more than it looks:
// target validation and the normalized-to-pixel conversion are the fiddly part,
// and a divergent second implementation is how the orchestrator would end up
// tapping a different spot than an agent given the same coordinates.
//
// `emulator_screenshot` is the one tool that cannot pass through unchanged. It
// answers with a base64 image, and the brain's provider layer has no vision
// path — the bytes would land in the transcript as tens of thousands of useless
// characters and blow the tool-output cap. So it is intercepted below and
// written to a file instead.

/// The emulator tools the orchestrator may call. Names match the MCP tools
/// exactly, so a prompt, a memory note, or a user instruction that says
/// `emulator_tap` means the same thing on both sides.
pub const ORCHESTRATOR_EMULATOR_TOOLS: &[&str] = &[
    "emulator_list",
    "emulator_boot",
    "emulator_shutdown",
    "emulator_screenshot",
    "emulator_tap",
    "emulator_swipe",
    "emulator_key",
    "emulator_text",
    "emulator_rotate",
    "emulator_logcat",
];

/// Unwrap a handler's JSON-RPC envelope into the plain text the brain's tool
/// loop expects: the `content[0].text` on success, the error message on
/// failure.
fn unwrap_tool_text(response: Json<JsonRpcResponse>) -> Result<String, String> {
    let JsonRpcResponse { result, error, .. } = response.0;
    if let Some(err) = error {
        return Err(err.message);
    }
    result
        .and_then(|value| {
            value
                .get("content")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .map(str::to_string)
        })
        .ok_or_else(|| "The emulator tool returned no text content.".to_string())
}

/// Capture a screen to a file and describe it, instead of returning the image.
///
/// The path goes to the OS temp directory rather than the project: a screenshot
/// is a transient artifact of one turn, and writing it into the repo would put
/// binaries in the user's `git status` that nobody asked for.
async fn screenshot_to_file(
    platform: &str,
    target: &str,
) -> Result<String, String> {
    let dir = std::env::temp_dir().join("spacron-screenshots");
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // `target` is already validated by `require_target`, so it holds nothing
    // that could climb out of the directory.
    let safe_target = target.replace(':', "-");

    if platform == "ios" {
        let png = mobile::ios_screenshot(target.to_string()).await?;
        let bytes = decode_base64(&png)?;
        let path = dir.join(format!("{safe_target}-{stamp}.png"));
        fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        return Ok(format!(
            "iOS simulator screenshot saved to {}. iOS is view-only here: no touch input and no reported dimensions.",
            path.display()
        ));
    }

    let frame = mobile::android_screencap(target.to_string()).await?;
    let bytes = decode_base64(&frame.image)?;
    let path = dir.join(format!("{safe_target}-{stamp}.jpg"));
    fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(format!(
        "Android screenshot saved to {} ({}x{}). If your model accepts images, it is attached to this result; if not, it is for the user to open. \
         Use the dimensions for coordinate maths if you need pixels, though emulator_tap and emulator_swipe \
         take normalized 0.0-1.0 coordinates and do the conversion themselves. To learn what is actually on \
         screen, read emulator_logcat or ask the user.",
        path.display(),
        frame.width,
        frame.height
    ))
}

/// Decode the standard-alphabet base64 the mobile commands produce.
fn decode_base64(encoded: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("The device returned an image that could not be decoded: {e}"))
}

/// Call one emulator tool by name, as the orchestrator brain.
///
/// `args` is the tool's argument object exactly as the MCP `arguments` member
/// would carry it, so the handlers below parse it unchanged.
pub async fn call_emulator_tool(
    name: &str,
    args: serde_json::Value,
) -> Result<String, String> {
    let params = serde_json::json!({ "arguments": args });

    // Screenshot never reaches its handler: the file-writing variant replaces
    // it wholesale. Argument parsing is duplicated here only because the
    // handler owns its own, and there is no smaller seam to borrow.
    if name == "emulator_screenshot" {
        let arg_map = tool_args(&params);
        let platform =
            resolve_platform(arg_map.and_then(|a| a.get("platform")).and_then(|v| v.as_str()))?;
        let target = require_target(arg_map.and_then(|a| a.get("target")).and_then(|v| v.as_str()))?;
        return screenshot_to_file(platform, &target).await;
    }

    let response = match name {
        "emulator_list" => emulator_list(None).await,
        "emulator_boot" => emulator_boot(None, &params).await,
        "emulator_shutdown" => emulator_shutdown(None, &params).await,
        "emulator_tap" => emulator_tap(None, &params).await,
        "emulator_swipe" => emulator_swipe(None, &params).await,
        "emulator_key" => emulator_key(None, &params).await,
        "emulator_text" => emulator_text(None, &params).await,
        "emulator_rotate" => emulator_rotate(None, &params).await,
        "emulator_logcat" => emulator_logcat(None, &params).await,
        other => return Err(format!("'{other}' is not an emulator tool.")),
    };
    unwrap_tool_text(response)
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
/// Authenticate a request and establish *who* made it.
///
/// Two credentials are accepted, and the difference between them is the whole
/// point of this function:
///
/// - The app-wide `token`, written into every agent's MCP config. It proves the
///   caller could read this user's configuration. It identifies nobody, so the
///   caller comes back with `session_id: None`.
/// - A per-launch agent token ([`McpServerHandle::mint_agent_token`]), minted
///   for one spawn and bound to that spawn's PTY session. A call carrying one
///   is attributable to exactly that agent.
///
/// Returning the identity rather than just "ok" is what lets a tool record who
/// called it. Anything derived from the *arguments* would be self-asserted —
/// an agent could name any session it liked.
fn authorize(
    state: &ServerState,
    headers: &HeaderMap,
    query: &AuthQuery,
) -> Result<Caller, Response> {
    if headers.contains_key(header::ORIGIN) {
        return Err((
            StatusCode::FORBIDDEN,
            "browser origins are not permitted to reach the Spacron MCP server",
        )
            .into_response());
    }

    let presented = query
        .token
        .as_deref()
        .or_else(|| bearer_token(headers))
        .unwrap_or("");

    // The app-wide token first, in constant time — it is the common path and
    // the one an attacker would try to guess.
    if ct_eq(presented.as_bytes(), state.token.as_bytes()) {
        return Ok(Caller { session_id: None });
    }

    // Then the per-launch tokens. A plain map lookup: these are 128-bit random
    // values that live only in memory for the life of one agent, and a
    // timing oracle over "is this key present" leaks nothing an attacker who
    // already has to guess the key can use.
    if let Ok(map) = state.agent_tokens.lock() {
        if let Some(bound) = map.get(presented) {
            return Ok(Caller { session_id: *bound });
        }
    }

    Err((StatusCode::UNAUTHORIZED, "invalid or missing token").into_response())
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

    /// The orchestrator's allowlist and the MCP tool list are two hand-written
    /// copies of the same set. If a tool is added to one and not the other,
    /// either the orchestrator silently loses a capability the agents have, or
    /// it advertises one that `call_emulator_tool` will refuse at runtime.
    #[test]
    fn orchestrator_allowlist_matches_the_served_emulator_tools() {
        let served: Vec<String> = all_tools(&[])
            .iter()
            .filter_map(|t| t["name"].as_str())
            .filter(|n| n.starts_with("emulator_"))
            .map(str::to_string)
            .collect();
        let mut allowed: Vec<String> = ORCHESTRATOR_EMULATOR_TOOLS
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut served_sorted = served.clone();
        served_sorted.sort();
        allowed.sort();
        assert_eq!(
            served_sorted, allowed,
            "the emulator tools served over MCP and the ones the orchestrator may call have drifted"
        );
    }

    #[tokio::test]
    async fn call_emulator_tool_refuses_a_name_it_does_not_route() {
        let err = call_emulator_tool("emulator_install", serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(err.contains("emulator_install"), "unexpected error: {err}");
    }

    /// A missing `target` must come back as the handler's own argument error,
    /// which proves the envelope unwrapping reaches the error branch rather
    /// than swallowing it into a success with empty text.
    #[tokio::test]
    async fn call_emulator_tool_surfaces_handler_argument_errors() {
        let err = call_emulator_tool("emulator_tap", serde_json::json!({ "x": 0.5, "y": 0.5 }))
            .await
            .unwrap_err();
        assert!(err.contains("target"), "unexpected error: {err}");
    }

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

    // ── Emulator tool arg validation ──────────────────────────────────────

    #[test]
    fn platform_defaults_to_android_and_rejects_junk() {
        assert_eq!(resolve_platform(None).unwrap(), "android");
        assert_eq!(resolve_platform(Some("ios")).unwrap(), "ios");
        assert_eq!(resolve_platform(Some("  Android ")).unwrap(), "android");
        assert!(resolve_platform(Some("tizen")).is_err());
    }

    #[test]
    fn target_accepts_real_serials_and_udids_only() {
        // What agents actually pass: an emulator serial, a USB serial, a
        // host:port transport, an iOS UDID, an AVD name.
        for valid in ["emulator-5554", "1a2b3c4d", "192.168.1.5:5555",
                      "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX", "Pixel_9_API_35"] {
            assert!(require_target(Some(valid)).is_ok(), "should accept '{valid}'");
        }
        // Nothing that could smuggle shell meaning into an adb argument.
        assert!(require_target(Some("")) .is_err());
        assert!(require_target(None).is_err());
        for bad in ["emulator; rm -rf", "$(whoami)", "serial with space", "a/b", "a\u{0}"] {
            assert!(require_target(Some(bad)).is_err(), "should reject '{bad}'");
        }
    }

    #[test]
    fn named_keys_resolve_and_raw_keycodes_pass_through() {
        assert_eq!(android_keycode("back"), Some(4));
        assert_eq!(android_keycode("HOME"), Some(3));
        assert_eq!(android_keycode("volume_up"), Some(24));
        assert_eq!(android_keycode("recents"), Some(187));
        assert_eq!(android_keycode("app_switch"), Some(187));
        assert_eq!(android_keycode("nonsense_key"), None);
        // Raw integers bypass the map (the full keycode table is not enumerated).
        assert_eq!("111".parse::<i32>().ok().or_else(|| android_keycode("111")), Some(111));
    }

    #[test]
    fn normalized_coords_convert_and_clamp() {
        // Center of a 1080-wide portrait display.
        assert_eq!(coord_to_pixel(0.5, 1080), 540);
        // Out-of-range folds into the display, then clamps onto the last pixel.
        assert_eq!(coord_to_pixel(1.5, 1080), 1080);
        assert_eq!(clamp_pixel(coord_to_pixel(1.5, 1080), 1080), 1079);
        assert_eq!(clamp_pixel(coord_to_pixel(-0.2, 1080), 1080), 0);
        assert_eq!(clamp_pixel(coord_to_pixel(1.0, 2400), 2400), 2399);
        // 0.5 of 2400 rounds up to the exact middle pixel boundary value.
        assert_eq!(coord_to_pixel(0.5, 2400), 1200);
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
            agent_tokens: Arc::new(std::sync::Mutex::new(HashMap::new())),
            read_cb: Arc::new(|_| Vec::new()),
            spawn_fn: Arc::new(|_| {}),
            deliver_emit_fn: Arc::new(|_, _, _| {}),
            report_fn: Arc::new(|_| {}),
            pending_sends: Arc::new(DashMap::new()),
            project_root: Arc::new(Mutex::new(None)),
            agent_presets: Arc::new(Mutex::new(Vec::new())),
            assistant_names: Arc::new(Mutex::new(Vec::new())),
            media_settings: Arc::new(Mutex::new(MediaSettings::default())),
            reserved_names: Arc::new(Mutex::new(Vec::new())),
            sse_sessions: Arc::new(DashMap::new()),
            desktop: crate::desktop::DesktopState::new(crate::desktop::DesktopHooks::noop()),
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
        assert!(authorize(&state, &HeaderMap::new(), &q(Some("good-token"))).is_ok());
    }

    #[test]
    fn authorize_rejects_a_wrong_token() {
        let state = state_with_token("good-token");
        assert!(authorize(&state, &HeaderMap::new(), &q(Some("bad-token"))).is_err());
    }

    #[test]
    fn authorize_rejects_a_missing_token() {
        let state = state_with_token("good-token");
        assert!(authorize(&state, &HeaderMap::new(), &q(None)).is_err());
    }

    #[test]
    fn authorize_rejects_a_token_that_is_a_prefix_of_the_real_one() {
        let state = state_with_token("good-token");
        assert!(authorize(&state, &HeaderMap::new(), &q(Some("good"))).is_err());
    }

    #[test]
    fn authorize_rejects_any_request_carrying_an_origin_even_with_a_valid_token() {
        // The DNS-rebinding case: a hostile page re-resolves its domain to
        // 127.0.0.1, so it is same-origin and its fetch is not preflighted.
        // Browsers always attach Origin; MCP CLI clients never do.
        let state = state_with_token("good-token");
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(authorize(&state, &headers, &q(Some("good-token"))).is_err());
    }

    #[test]
    fn authorize_rejects_a_null_origin() {
        let state = state_with_token("good-token");
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "null".parse().unwrap());
        assert!(authorize(&state, &headers, &q(Some("good-token"))).is_err());
    }

    // --- per-agent identity -------------------------------------------------

    /// A state plus a recorder for whatever `report_status` emits.
    fn state_with_reports(token: &str) -> (ServerState, Arc<std::sync::Mutex<Vec<AgentReport>>>) {
        let seen: Arc<std::sync::Mutex<Vec<AgentReport>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let mut state = state_with_token(token);
        state.report_fn = Arc::new(move |report| recorder.lock().unwrap().push(report));
        (state, seen)
    }

    /// Mint a token straight into a state's map, as `mint_agent_token` does.
    fn mint_into(state: &ServerState, token: &str, bound: Option<u32>) {
        state
            .agent_tokens
            .lock()
            .unwrap()
            .insert(token.to_string(), bound);
    }

    #[test]
    fn the_app_wide_token_authenticates_but_identifies_nobody() {
        let state = state_with_token("shared");
        let caller = authorize(&state, &HeaderMap::new(), &q(Some("shared"))).unwrap();
        assert_eq!(caller.session_id, None);
    }

    #[test]
    fn a_bound_agent_token_identifies_its_session() {
        let state = state_with_token("shared");
        mint_into(&state, "per-launch", Some(42));
        let caller = authorize(&state, &HeaderMap::new(), &q(Some("per-launch"))).unwrap();
        assert_eq!(caller.session_id, Some(42));
    }

    #[test]
    fn an_unbound_agent_token_authenticates_without_a_session() {
        // The window between minting and the PTY existing. It must not be
        // rejected — the agent may connect before `bind` runs — but it also
        // must not be attributed to a session it has not been bound to.
        let state = state_with_token("shared");
        mint_into(&state, "not-yet", None);
        let caller = authorize(&state, &HeaderMap::new(), &q(Some("not-yet"))).unwrap();
        assert_eq!(caller.session_id, None);
    }

    #[test]
    fn a_forgotten_agent_token_stops_authenticating() {
        let state = state_with_token("shared");
        mint_into(&state, "dead", Some(7));
        state.agent_tokens.lock().unwrap().retain(|_, b| *b != Some(7));
        assert!(authorize(&state, &HeaderMap::new(), &q(Some("dead"))).is_err());
    }

    #[test]
    fn an_origin_header_still_wins_over_a_valid_agent_token() {
        // The per-launch path must not become a way around the rebinding guard.
        let state = state_with_token("shared");
        mint_into(&state, "per-launch", Some(1));
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(authorize(&state, &headers, &q(Some("per-launch"))).is_err());
    }

    // --- report_status ------------------------------------------------------

    fn report_call(state_arg: &str, detail: Option<&str>) -> Option<serde_json::Value> {
        let mut args = serde_json::Map::new();
        args.insert("state".into(), serde_json::json!(state_arg));
        if let Some(d) = detail {
            args.insert("detail".into(), serde_json::json!(d));
        }
        Some(serde_json::json!({ "name": "report_status", "arguments": args }))
    }

    /// A `report_status` call carrying the token an agent read from its
    /// SPACRON_AGENT_TOKEN environment variable.
    fn report_call_with_token(state_arg: &str, token: &str) -> Option<serde_json::Value> {
        Some(serde_json::json!({
            "name": "report_status",
            "arguments": { "state": state_arg, "agent_token": token },
        }))
    }

    #[tokio::test]
    async fn an_env_token_identifies_an_agent_whose_connection_cannot() {
        // Every CLI except Claude Code reads a shared MCP config, so its
        // connection carries the app-wide token and identifies nobody. The
        // per-launch token in its environment is what closes that gap.
        let (state, seen) = state_with_reports("shared");
        mint_into(&state, "env-token", Some(12));

        let Json(resp) = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call_with_token("done", "env-token"),
            &state,
            Caller::default(), // authenticated with the shared token
        )
        .await;

        assert!(resp.error.is_none());
        assert_eq!(seen.lock().unwrap()[0].session_id, Some(12));
    }

    #[tokio::test]
    async fn the_connection_token_outranks_a_claimed_one() {
        // An agent cannot report as somebody else by passing their token: the
        // identity its own connection proves wins.
        let (state, seen) = state_with_reports("shared");
        mint_into(&state, "someone-elses", Some(2));

        let _ = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call_with_token("done", "someone-elses"),
            &state,
            Caller {
                session_id: Some(1),
            },
        )
        .await;

        assert_eq!(seen.lock().unwrap()[0].session_id, Some(1));
    }

    #[tokio::test]
    async fn an_invented_token_leaves_the_report_unattributed() {
        // Not an error — the report is still worth showing. It just cannot end
        // anyone's turn, and the reply says so.
        let (state, seen) = state_with_reports("shared");

        let Json(resp) = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call_with_token("done", "made-up"),
            &state,
            Caller::default(),
        )
        .await;

        assert!(resp.error.is_none());
        assert_eq!(seen.lock().unwrap()[0].session_id, None);
    }

    #[tokio::test]
    async fn an_unbound_env_token_does_not_invent_a_session() {
        // Minted but not yet bound: the agent connected before its PTY was
        // registered. Authenticates, identifies nobody.
        let (state, seen) = state_with_reports("shared");
        mint_into(&state, "not-yet", None);

        let _ = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call_with_token("done", "not-yet"),
            &state,
            Caller::default(),
        )
        .await;

        assert_eq!(seen.lock().unwrap()[0].session_id, None);
    }

    #[test]
    fn report_status_asks_for_the_env_token_by_name() {
        // The agent has to be told where to find it, or the argument is never
        // filled and every non-Claude agent stays unattributed.
        let tools = all_tools(&[]);
        let tool = tools.iter().find(|t| t["name"] == "report_status").unwrap();
        let described = tool["inputSchema"]["properties"]["agent_token"]["description"]
            .as_str()
            .unwrap();
        assert!(described.contains("SPACRON_AGENT_TOKEN"), "{described}");
    }

    #[tokio::test]
    async fn report_status_carries_the_session_the_token_proved() {
        let (state, seen) = state_with_reports("shared");
        let caller = Caller {
            session_id: Some(9),
        };
        let Json(resp) = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call("needs_input", Some("Which database?")),
            &state,
            caller,
        )
        .await;
        assert!(resp.error.is_none());

        let reports = seen.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].session_id, Some(9));
        assert_eq!(reports[0].state, "needs_input");
        assert_eq!(reports[0].detail, "Which database?");
    }

    #[tokio::test]
    async fn report_status_says_so_when_it_cannot_attribute_the_caller() {
        let (state, seen) = state_with_reports("shared");
        let Json(resp) = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call("done", None),
            &state,
            Caller::default(),
        )
        .await;
        // Still recorded — an unattributed report is worth showing — but the
        // agent is told, because for a Spacron-launched agent it means the
        // launch path failed to hand it its own token.
        assert_eq!(seen.lock().unwrap()[0].session_id, None);
        let text = resp.result.unwrap()["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        // …and tells it how to fix that, since a Spacron-launched agent always
        // has the token in its environment.
        assert!(text.contains("could not tell which agent"), "{text}");
        assert!(text.contains("SPACRON_AGENT_TOKEN"), "{text}");
    }

    #[tokio::test]
    async fn report_status_rejects_a_state_outside_the_enum() {
        let (state, seen) = state_with_reports("shared");
        let Json(resp) = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call("pondering", None),
            &state,
            Caller {
                session_id: Some(3),
            },
        )
        .await;
        assert_eq!(resp.error.unwrap().code, -32602);
        // Nothing reached the frontend: a turn state it cannot match on is
        // worse than no report at all.
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn report_status_caps_the_detail_it_will_pass_on() {
        let (state, seen) = state_with_reports("shared");
        let long = "x".repeat(2000);
        let _ = handle_tool_call(
            Some(serde_json::json!(1)),
            report_call("working", Some(&long)),
            &state,
            Caller {
                session_id: Some(1),
            },
        )
        .await;
        assert_eq!(seen.lock().unwrap()[0].detail.chars().count(), 500);
    }

    #[test]
    fn report_status_is_advertised_to_every_agent() {
        let tools = all_tools(&[]);
        let tool = tools
            .iter()
            .find(|t| t["name"] == "report_status")
            .expect("report_status must be in tools/list");
        let states: Vec<&str> = tool["inputSchema"]["properties"]["state"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        // The frontend matches on exactly these four.
        assert_eq!(states, vec!["working", "needs_input", "done", "failed"]);
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
        let (grant_tx, mut grant_rx) = mpsc::unbounded_channel::<String>();
        let recorder = seen.clone();

        let (handle, port) = start(
            0,
            Arc::new(|_| b"agent output".to_vec()),
            Arc::new(|_| {}),
            Arc::new(move |request_id, session_id, message| {
                recorder
                    .lock()
                    .unwrap()
                    .push((session_id, message.to_string()));
                let _ = tx.send(request_id.to_string());
            }),
            Arc::new(|_| {}),
            // Computer-use permission requests: the stand-in frontend declines
            // every one, so a test never shows a real window to anything.
            crate::desktop::DesktopHooks {
                grant: Arc::new(move |req: &crate::desktop::GrantRequest| {
                    let _ = grant_tx.send(req.request_id.clone());
                }),
                ..crate::desktop::DesktopHooks::noop()
            },
        )
        .expect("server should start");

        let desktop = handle.desktop.clone();
        tokio::spawn(async move {
            while let Some(id) = grant_rx.recv().await {
                desktop.respond(&id, false);
            }
        });

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

    async fn post_mcp(base: &str, token: &str, body: serde_json::Value) -> serde_json::Value {
        reqwest::Client::new()
            .post(format!("{base}/mcp?token={token}"))
            .header("Accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    fn listed_tool_names(body: &serde_json::Value) -> Vec<String> {
        body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn desktop_tools_are_listed_only_while_computer_use_is_on() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        let list = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });

        let off = listed_tool_names(&post_mcp(&base, &token, list.clone()).await);
        assert!(!off.iter().any(|n| n.starts_with("desktop_")), "listed while off: {off:?}");

        handle.desktop.enable_for_test();
        let on = listed_tool_names(&post_mcp(&base, &token, list).await);
        // Only where the platform can actually do it.
        assert_eq!(on.iter().any(|n| n == "desktop_list_windows"), crate::desktop::supported());
    }

    #[tokio::test]
    async fn desktop_tools_refuse_an_unidentified_caller() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        handle.desktop.enable_for_test();

        let body = post_mcp(
            &base,
            &token,
            serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "desktop_list_windows", "arguments": {} }
            }),
        )
        .await;
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("agent_token"), "expected an identity error, got: {body}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_declined_desktop_grant_reaches_the_agent_as_an_error() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        handle.desktop.enable_for_test();
        let agent_token = handle.mint_agent_token();
        assert!(handle.bind_agent_token(&agent_token, 7));

        let call = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {
                "name": "desktop_list_windows",
                "arguments": { "agent_token": agent_token, "reason": "test" }
            }
        });
        let body = post_mcp(&base, &token, call.clone()).await;
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("declined"), "expected the stand-in frontend's no, got: {body}");

        // Remembered for the session: the second call is refused without a
        // new dialog (the stand-in would answer, but nothing should ask it).
        let again = post_mcp(&base, &token, call).await;
        assert!(again["error"]["message"].as_str().unwrap_or_default().contains("declined"));
    }

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
