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
    extract::State,
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Sse,
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
}

/// Handle returned by [`McpServer::start`] for interacting with the server.
pub struct McpServerHandle {
    /// The agent registry (name → AgentEntry), shared with the MCP server.
    pub registry: Arc<Mutex<HashMap<String, AgentEntry>>>,
    notify_tx: broadcast::Sender<()>,
    _shutdown_tx: oneshot::Sender<()>,
    /// The port the MCP server is listening on.
    pub port: u16,
    /// In-flight browser-tool requests awaiting frontend responses.
    pub pending_browser: PendingRequests,
}

impl McpServerHandle {
    /// Register an agent so MCP clients can discover and message it.
    pub async fn register_agent(&self, session_id: u32, name: &str, preset: &str, label: &str) {
        let entry = AgentEntry {
            session_id,
            name: name.to_string(),
            preset: preset.to_string(),
            label: label.to_string(),
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

    let server_state = Arc::new(ServerState {
        registry: registry.clone(),
        notify_tx: notify_tx.clone(),
        send_tx,
        read_tx,
        spawn_tx,
        port: actual_port,
        write_cb,
        read_cb,
        spawn_fn,
        browser_emit_fn,
        pending_browser: pending_browser.clone(),
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
        pending_browser,
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
    write_cb: WriteFn,
    read_cb: ReadFn,
    spawn_fn: SpawnFn,
    browser_emit_fn: BrowserEmitFn,
    pending_browser: PendingRequests,
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
        "description": "Navigate the embedded browser preview to a URL. Use mode='window' for sites that block iframe embedding (Google, GitHub, etc.).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to navigate to."
                },
                "mode": {
                    "type": "string",
                    "enum": ["iframe", "window", "auto"],
                    "description": "iframe: use the preview panel. window: open a real browser window. auto (default): try iframe first, fall back to window if the page refuses embedding."
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

fn all_tools() -> Vec<serde_json::Value> {
    vec![
        tool_list_agents(),
        tool_send_to_agent(),
        tool_read_agent_output(),
        tool_spawn_agent(),
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
) -> impl IntoResponse {
    let rx = state.notify_tx.subscribe();
    let endpoint_url = format!("http://127.0.0.1:{}/message", state.port);

    Sse::new(sse_event_stream(endpoint_url, rx))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
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
            loop {
                tokio::select! {
                    _ = rx.recv() => {
                        let notif = serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "notifications/tools/list_changed",
                            "params": {}
                        });
                        return Some((
                            Ok(Event::default().event("message").data(notif.to_string())),
                            (rx, tick),
                        ));
                    }
                    _ = tick.tick() => {
                        return Some((
                            Ok(Event::default().event("heartbeat").data("")),
                            (rx, tick),
                        ));
                    }
                    else => return None,
                }
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
    Json(req): Json<JsonRpcRequest>,
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
                    // Keep last ~50KB to avoid huge responses
                    let text = if output_str.len() > 51200 {
                        format!("... [{} bytes trimmed] ...\n{}",
                            output_str.len(),
                            &output_str[output_str.len() - 51200..])
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

            if preset.is_empty() {
                return Json(JsonRpcResponse::error(id, -32602, "Missing required parameter 'preset'"));
            }

            let req = SpawnRequest {
                preset: preset.to_string(),
                prompt: prompt.to_string(),
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