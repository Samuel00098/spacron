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
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, Mutex, oneshot};

/// Callback for writing data into a PTY session by session id.
pub type WriteFn = Arc<dyn Fn(u32, &str) -> Result<(), String> + Send + Sync>;

/// Callback for reading output from a PTY session by session id.
pub type ReadFn = Arc<dyn Fn(u32) -> Vec<u8> + Send + Sync>;

/// Callback for forwarding a spawn-agent request to the frontend.
pub type SpawnFn = Arc<dyn Fn(SpawnRequest) + Send + Sync>;

/// Callback for emitting a browser-tool request to the frontend via Tauri event.
/// Arguments: (request_id, tool_name, args_json).
pub type BrowserEmitFn = Arc<dyn Fn(&str, &str, serde_json::Value) + Send + Sync>;

/// A pending browser-tool request awaiting a response from the frontend.
pub struct PendingBrowserRequest {
    pub tx: oneshot::Sender<Result<serde_json::Value, String>>,
    pub created_at: Instant,
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

/// Handle returned by [`McpServer::start`] for interacting with the server.
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
    /// Active project's main checkout, shared with the server. See `ServerState`.
    pub project_root: Arc<Mutex<Option<String>>>,
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
        let _ = self.notify_tx.send(());
    }

    /// Unregister an agent by session id.
    pub async fn unregister_agent(&self, session_id: u32) {
        let mut map = self.registry.lock().await;
        map.retain(|_, v| v.session_id != session_id);
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
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/// Start the MCP HTTP+SSE server. Returns a [`McpServerHandle`] for
/// interacting with it.
///
/// - `port`: `0` = pick a random free port; otherwise bind exactly.
/// - `write_cb`: callback to write data into a PTY session.
/// - `read_cb`: callback to read output from a PTY session.
/// - `spawn_fn`: callback to forward a spawn-agent request to the frontend.
/// - `browser_emit_fn`: callback to emit a browser-tool request to the frontend.
pub fn start(
    port: u16,
    write_cb: WriteFn,
    read_cb: ReadFn,
    spawn_fn: SpawnFn,
    browser_emit_fn: BrowserEmitFn,
) -> Result<(McpServerHandle, u16), String> {
    let actual_port = if port == 0 {
        get_free_port().ok_or_else(|| "Could not find a free port for the MCP server".to_string())?
    } else {
        port
    };

    let registry: Arc<Mutex<HashMap<String, AgentEntry>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let (notify_tx, _) = broadcast::channel::<()>(32);
    let (send_tx, _) = broadcast::channel::<SendToAgentRequest>(32);
    let (read_tx, _) = broadcast::channel::<ReadOutputRequest>(32);
    let (spawn_tx, _) = broadcast::channel::<SpawnRequest>(32);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let pending_browser: PendingRequests = Arc::new(DashMap::new());
    let project_root: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    // Bearer-equivalent shared secret. Loopback binding alone does not isolate
    // us: on a multi-user machine another local account can reach 127.0.0.1 but
    // cannot read this user's agent config files, which is where the token lives.
    let token = uuid::Uuid::new_v4().simple().to_string();

    let server_state = Arc::new(ServerState {
        registry: registry.clone(),
        notify_tx: notify_tx.clone(),
        send_tx,
        read_tx,
        spawn_tx,
        port: actual_port,
        token: token.clone(),
        write_cb,
        read_cb,
        spawn_fn,
        browser_emit_fn,
        pending_browser: pending_browser.clone(),
        project_root: project_root.clone(),
    });

    // Background sweep: drop pending browser requests older than 30s.
    let sweep_map = pending_browser.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            sweep_map.retain(|_, v| v.created_at.elapsed() < Duration::from_secs(30));
        }
    });

    let app = Router::new()
        .route("/sse", get(sse_handler))
        .route("/message", post(message_handler))
        .with_state(server_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], actual_port));

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind MCP server: {}", e);
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
        project_root,
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
    write_cb: WriteFn,
    read_cb: ReadFn,
    spawn_fn: SpawnFn,
    browser_emit_fn: BrowserEmitFn,
    pending_browser: PendingRequests,
    /// Absolute path of the active project's main checkout, set by the frontend
    /// on project open. `delegate_task` needs it to locate the reports directory
    /// workers write their completion signal into — the server has no other way
    /// to know where the project lives.
    project_root: Arc<Mutex<Option<String>>>,
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
        "description": "Send a message to a running agent by name. The text is written directly into the target agent's terminal as if you typed it. Use list_agents first to find available agents.",
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

fn tool_spawn_agent() -> serde_json::Value {
    serde_json::json!({
        "name": "spawn_agent",
        "description": "Launch a new AI coding agent (claude, codex, gemini, cursor, etc.) with an optional prompt. The new agent appears in its own terminal pane.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "preset": {
                    "type": "string",
                    "description": "Agent preset name ('claude', 'codex', 'gemini', 'cursor', etc.)."
                },
                "prompt": {
                    "type": "string",
                    "description": "Optional. The initial prompt/task to give the new agent."
                },
                "name": {
                    "type": "string",
                    "description": "Optional. The name to give the new agent, so you can address it with send_to_agent without calling list_agents first. Must not match an agent that is already running. When omitted, a name is assigned for you."
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
const DELEGATE_DEFAULT_WAIT_SECS: u64 = 120;
const DELEGATE_MAX_WAIT_SECS: u64 = 600;

fn clamp_wait(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DELEGATE_DEFAULT_WAIT_SECS)
        .clamp(1, DELEGATE_MAX_WAIT_SECS)
}

/// Where a worker signals completion: `<root>/.spacron/reports/<name>.md` for
/// success, `.blocked.md` for "I need a decision". Two files rather than one
/// with a status field, so the check stays a file-exists test with nothing to
/// parse and no partially-written state to misread.
fn report_paths(root: &str, name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::path::Path::new(root).join(".spacron").join("reports");
    (
        dir.join(format!("{}.md", name)),
        dir.join(format!("{}.blocked.md", name)),
    )
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
    root: &str,
    name: &str,
    wait_secs: u64,
) -> serde_json::Value {
    let (done_path, blocked_path) = report_paths(root, name);
    let deadline = Instant::now() + Duration::from_secs(wait_secs);

    loop {
        if let Ok(text) = std::fs::read_to_string(&done_path) {
            return delegate_result("complete", name, branch_of(state, name).await, Some(text));
        }
        if let Ok(text) = std::fs::read_to_string(&blocked_path) {
            return delegate_result("blocked", name, branch_of(state, name).await, Some(text));
        }
        // A worker that vanished without reporting would otherwise be waited on
        // for the full timeout. It can only be absent from the registry after it
        // has been registered, so this cannot fire during the launch window.
        if !state.registry.lock().await.contains_key(name) && Instant::now() > deadline {
            return delegate_result("gone", name, None, None);
        }
        if Instant::now() >= deadline {
            return delegate_result("working", name, branch_of(state, name).await, None);
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

fn tool_delegate_task() -> serde_json::Value {
    serde_json::json!({
        "name": "delegate_task",
        "description": "Delegate a piece of work to a NEW agent and wait for its result. Prefer this over your own in-process sub-agents whenever the work WRITES CODE: the worker gets its own visible pane and its own git branch, so the user can watch it, steer it, and review its diff — none of which is possible for an in-process sub-agent. (For read-only research your own sub-agents are fine.) Returns the worker's report when it finishes, or status 'working' with a handle if it is still going — then call check_task with that handle.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "preset": {
                    "type": "string",
                    "description": "Agent preset to run the work ('claude', 'codex', 'gemini', 'cursor', …)."
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
                    "description": "Optional. Name for the worker; must not match a running agent. Assigned for you when omitted."
                },
                "wait_seconds": {
                    "type": "number",
                    "description": "Optional. How long to wait before returning 'working' (default 120, max 600)."
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
                    "description": "Optional. How long to wait before returning 'working' (default 120, max 600)."
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
                    "description": "Optional. How long to wait before returning 'working' again (default 120, max 600)."
                }
            },
            "required": ["handle"]
        }
    })
}

fn all_tools() -> Vec<serde_json::Value> {
    vec![
        tool_list_agents(),
        tool_send_to_agent(),
        tool_read_agent_output(),
        tool_spawn_agent(),
        tool_delegate_task(),
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
    // The client POSTs wherever this endpoint event points, so carrying the token
    // here means /message stays authenticated with no client-side config.
    let endpoint_url = format!(
        "http://127.0.0.1:{}/message?token={}",
        state.port, state.token
    );

    Sse::new(sse_event_stream(endpoint_url, rx))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

/// Build the SSE event stream for an MCP transport session.
fn sse_event_stream(
    endpoint_url: String,
    rx: broadcast::Receiver<()>,
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

    // ── Loop: registry-change pings + keepalive heartbeats ────────────
    let tail = stream::unfold(
        (rx, tokio::time::interval(Duration::from_secs(15))),
        |(mut rx, mut tick)| async move {
            // No `loop` here: `unfold` is the loop — it calls this closure again
            // for each item, and every arm below returns. Wrapping it in one made
            // `cargo clippy` fail outright on `never_loop` (a deny-by-default
            // lint), which is why clippy was red on this crate.
            tokio::select! {
                _ = rx.recv() => {
                    let notif = serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/tools/list_changed",
                        "params": {}
                    });
                    Some((
                        Ok(Event::default().event("message").data(notif.to_string())),
                        (rx, tick),
                    ))
                }
                _ = tick.tick() => {
                    Some((
                        Ok(Event::default().event("heartbeat").data("")),
                        (rx, tick),
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

async fn message_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(req): Json<JsonRpcRequest>,
) -> Response {
    if let Some(rejection) = reject_unauthorized(&state, &headers, &query) {
        return rejection;
    }
    dispatch_message(state, req).await.into_response()
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
            Json(JsonRpcResponse::success(
                id,
                serde_json::json!({ "tools": all_tools() }),
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
                    // Write directly to the target PTY session
                    match (state.write_cb)(sid, message) {
                        Ok(_) => {
                            let _ = state.send_tx.send(SendToAgentRequest {
                                target_name: target_name.to_string(),
                                message: message.to_string(),
                                target_session_id: sid,
                            });
                            Json(JsonRpcResponse::success(
                                id,
                                serde_json::json!({ "content": [{ "type": "text", "text": format!("Message sent to '{}'.", target_name) }] }),
                            ))
                        }
                        Err(e) => Json(JsonRpcResponse::error(
                            id,
                            -32000,
                            format!("Failed to write to '{}': {}", target_name, e),
                        )),
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

            if preset.is_empty() {
                return Json(JsonRpcResponse::error(id, -32602, "Missing required parameter 'preset'"));
            }

            // Refuse a name already in the registry rather than letting the
            // frontend silently rename it: `send_to_agent` resolves by name, so
            // two agents answering to one name makes every later message
            // ambiguous.
            if !name.is_empty() && state.registry.lock().await.contains_key(name) {
                return Json(JsonRpcResponse::error(
                    id,
                    -32602,
                    &format!("An agent named '{}' is already running — pick another name.", name),
                ));
            }

            let req = SpawnRequest {
                preset: preset.to_string(),
                prompt: prompt.to_string(),
                name: name.to_string(),
            };

            let _ = state.spawn_tx.send(req.clone());
            (state.spawn_fn)(req);

            Json(JsonRpcResponse::success(
                id,
                serde_json::json!({ "content": [
                    { "type": "text", "text": format!(
                        "Spawning '{}'{}... It will appear in a new terminal.",
                        preset,
                        if prompt.is_empty() { String::new() } else { format!(" with prompt: {}", prompt) }
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
            let name = if requested.is_empty() {
                format!("worker-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])
            } else {
                requested
            };
            if state.registry.lock().await.contains_key(&name) {
                return Json(JsonRpcResponse::error(
                    id,
                    -32602,
                    &format!("An agent named '{}' is already running — pick another name.", name),
                ));
            }

            // Clear any report left by an earlier worker of the same name, so a
            // stale file can't be mistaken for this run finishing instantly.
            let (done_path, blocked_path) = report_paths(&root, &name);
            let _ = std::fs::remove_file(&done_path);
            let _ = std::fs::remove_file(&blocked_path);
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
                await_worker_report(&state, &root, &name, wait).await,
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
            let (done_path, blocked_path) = report_paths(&root, &handle);
            let _ = std::fs::remove_file(&done_path);
            let _ = std::fs::remove_file(&blocked_path);

            let message = format!(
                "{feedback}\n\nWhen you have addressed this, write your summary again to:\n  {done}\nIf you cannot proceed, write why to:\n  {blocked}",
                feedback = feedback,
                done = done_path.display(),
                blocked = blocked_path.display(),
            );

            if let Err(e) = (state.write_cb)(sid, &message) {
                return Json(JsonRpcResponse::error(
                    id,
                    -32000,
                    &format!("Failed to write to '{}': {}", handle, e),
                ));
            }
            let _ = state.send_tx.send(SendToAgentRequest {
                target_name: handle.clone(),
                message: message.clone(),
                target_session_id: sid,
            });

            Json(JsonRpcResponse::success(
                id,
                await_worker_report(&state, &root, &handle, wait).await,
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

            Json(JsonRpcResponse::success(
                id,
                await_worker_report(&state, &root, &handle, wait).await,
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

/// Gate every request on two independent checks.
///
/// 1. **No `Origin` header.** MCP CLI clients (Claude Code, Codex, Cursor) never
///    send one; browsers always do. Rejecting any request that carries one is
///    what stops a DNS-rebinding attack, where a hostile page re-resolves its
///    own domain to 127.0.0.1 and becomes same-origin with us. The JSON
///    content-type requirement alone does not cover that case.
/// 2. **Matching `?token=`.** Defends against a local process that can reach the
///    port but cannot read this user's agent config files — e.g. another account
///    on a shared machine. The token rides in the query string rather than a
///    header because the SSE transport gives MCP clients no way to set headers
///    from a bare URL, and this listener is loopback-only, so there is no proxy
///    or CDN log for the URL to leak into.
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

    let presented = query.token.as_deref().unwrap_or("");
    if !ct_eq(presented.as_bytes(), state.token.as_bytes()) {
        return Some((StatusCode::UNAUTHORIZED, "invalid or missing token").into_response());
    }

    None
}

/// The `?token=…` every route requires.
#[derive(Deserialize, Default)]
struct AuthQuery {
    token: Option<String>,
}

fn get_free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    Some(port)
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
            write_cb: Arc::new(|_, _| Ok(())),
            read_cb: Arc::new(|_| Vec::new()),
            spawn_fn: Arc::new(|_| {}),
            browser_emit_fn: Arc::new(|_, _, _| {}),
            pending_browser: Arc::new(DashMap::new()),
        }
    }

    fn q(token: Option<&str>) -> AuthQuery {
        AuthQuery {
            token: token.map(String::from),
        }
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

    /// Boot a real server and return `(base_url, token, handle)`.
    fn boot() -> (String, String, McpServerHandle) {
        let (handle, port) = start(
            0,
            Arc::new(|_, _| Ok(())),
            Arc::new(|_| b"agent output".to_vec()),
            Arc::new(|_| {}),
            Arc::new(|_, _, _| {}),
        )
        .expect("server should start");
        let token = handle.token.clone();
        (format!("http://127.0.0.1:{port}"), token, handle)
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

    #[tokio::test]
    async fn a_valid_token_reaches_the_tools() {
        let (base, token, handle) = boot();
        wait_until_listening(&base, &token).await;
        handle.register_agent(7, "Iris", "claude", "Agent 1").await;

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
        handle.register_agent(7, "Trinity", "codex", "Agent 2").await;

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
