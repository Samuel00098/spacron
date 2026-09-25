//! The chat's MCP *client* for the user's own servers (Settings > MCP).
//!
//! Spacron writes those servers into every agent CLI's config; this module is
//! what lets the chat (the orchestrator) use them too. The webview hands over
//! the server's spec from the user's list with every call, and the chat's
//! approval policy (`stores/orchestrator.ts`) decides whether a call may run
//! before it ever reaches here — this module only speaks the protocol.
//!
//! One connection per server, shared by every conversation, restarted when the
//! spec changes or the server dies, and shut down after idling.
//!
//! Transports, matching the three the settings list offers:
//! - `stdio`: spawn the command, newline-delimited JSON-RPC.
//! - `http`: Streamable HTTP. POST each message; the answer is JSON or an SSE
//!   stream carrying it. `Mcp-Session-Id` is echoed once the server issues it.
//! - `sse`: the older HTTP+SSE transport. GET an event stream, whose first
//!   `endpoint` event names where to POST; answers come back on the stream.
//!
//! The Playwright browser keeps its own client in `browser_tools.rs`, which is
//! pinned and allowlisted; this one is general.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const PROTOCOL_VERSION: &str = "2025-03-26";
/// A first `npx -y` run downloads the package, so starting is slow once.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(120);
const CALL_TIMEOUT: Duration = Duration::from_secs(180);
const IDLE_SHUTDOWN: Duration = Duration::from_secs(15 * 60);
const STDERR_KEEP: usize = 4096;
const MAX_TOOL_PAGES: usize = 20;

/// A server as the settings list describes it (`services/mcp-servers.ts`).
#[derive(Debug, Clone, Deserialize, PartialEq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSpec {
    pub transport: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<std::collections::BTreeMap<String, String>>,
}

impl McpServerSpec {
    fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.hash(&mut h);
        h.finish()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    /// The server's own `readOnlyHint`. Only ever relaxes approval for a server
    /// the user added themselves; absent means "may change things".
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    pub text: String,
    pub images: Vec<String>,
    pub is_error: bool,
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing shared by the transports
// ---------------------------------------------------------------------------

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>;

/// Route one incoming JSON-RPC message to whoever is waiting for its id.
/// Server-initiated requests and notifications are ignored: we declare no
/// client capabilities, so a well-behaved server sends none that need us.
async fn deliver(pending: &Pending, msg: serde_json::Value) {
    if msg.get("method").is_some() {
        return;
    }
    if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
        if let Some(tx) = pending.lock().await.remove(&id) {
            let _ = tx.send(msg);
        }
    }
}

fn rpc_result(msg: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(err) = msg.get("error") {
        return Err(err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("the MCP server returned an error")
            .to_string());
    }
    Ok(msg.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

/// Minimal SSE parser: feed it bytes, get back each complete event's
/// `(event, data)`.
#[derive(Default)]
struct SseParser {
    buf: String,
    event: String,
    data: String,
}

impl SseParser {
    fn feed(&mut self, chunk: &str) -> Vec<(String, String)> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let event = if self.event.is_empty() { "message".to_string() } else { std::mem::take(&mut self.event) };
                    out.push((event, std::mem::take(&mut self.data)));
                }
                self.event.clear();
            } else if let Some(v) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(v.strip_prefix(' ').unwrap_or(v));
            } else if let Some(v) = line.strip_prefix("event:") {
                self.event = v.trim().to_string();
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

enum Transport {
    Stdio {
        child: Child,
        stdin: ChildStdin,
        pending: Pending,
        stderr: Arc<Mutex<String>>,
    },
    Http {
        client: reqwest::Client,
        url: String,
        headers: reqwest::header::HeaderMap,
        session_id: Option<String>,
        protocol: Option<String>,
    },
    Sse {
        client: reqwest::Client,
        post_url: String,
        headers: reqwest::header::HeaderMap,
        pending: Pending,
        alive: Arc<AtomicBool>,
        reader: tokio::task::JoinHandle<()>,
    },
}

struct Connection {
    transport: Transport,
    next_id: AtomicU64,
    tools: Option<Vec<McpToolInfo>>,
    fingerprint: u64,
    last_used: Instant,
}

fn header_map(spec: &McpServerSpec) -> Result<reqwest::header::HeaderMap, String> {
    let mut map = reqwest::header::HeaderMap::new();
    for (k, v) in spec.headers.iter().flatten() {
        let name = reqwest::header::HeaderName::from_bytes(k.trim().as_bytes())
            .map_err(|_| format!("'{k}' is not a valid header name."))?;
        let value = reqwest::header::HeaderValue::from_str(v.trim())
            .map_err(|_| format!("The value of header '{k}' is not valid."))?;
        map.insert(name, value);
    }
    Ok(map)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // Credentials in `headers` must not follow a redirect to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

fn remote_url(spec: &McpServerSpec) -> Result<String, String> {
    let url = spec.url.as_deref().unwrap_or("").trim().to_string();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("The server URL must start with http:// or https://.".into());
    }
    Ok(url)
}

/// Resolve a bare program name the way a terminal would: `npx` must become
/// `npx.cmd` on Windows (and run through `cmd /c`), never the extensionless
/// bash script npm installs next to it (see the windows-pathext-shims note).
fn stdio_command(spec: &McpServerSpec) -> Result<Command, String> {
    let program = spec.command.as_deref().unwrap_or("").trim();
    if program.is_empty() {
        return Err("This server has no command to start it.".into());
    }
    let args: Vec<String> = spec.args.iter().flatten().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();

    let resolved: Option<PathBuf> = {
        #[cfg(windows)]
        {
            let has_ext = std::path::Path::new(program).extension().is_some();
            let mut found = None;
            if !has_ext {
                for ext in ["exe", "cmd", "bat", "com"] {
                    if let Some(p) = super::agent_probe::which(&format!("{program}.{ext}")) {
                        found = Some(p);
                        break;
                    }
                }
            }
            found.or_else(|| super::agent_probe::which(program))
        }
        #[cfg(not(windows))]
        {
            super::agent_probe::which(program)
        }
    };
    let path = resolved.unwrap_or_else(|| PathBuf::from(program));

    let is_batch = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    let mut cmd = if is_batch {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(&path);
        c
    } else {
        Command::new(&path)
    };
    cmd.args(&args);
    if let Some(p) = super::agent_probe::search_path() {
        cmd.env("PATH", p);
    }
    for (k, v) in spec.env.iter().flatten() {
        if !k.trim().is_empty() {
            cmd.env(k.trim(), v);
        }
    }
    cmd.current_dir(std::env::temp_dir());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

impl Connection {
    async fn open(spec: &McpServerSpec) -> Result<Self, String> {
        let transport = match spec.transport.as_str() {
            "stdio" => Self::open_stdio(spec).await?,
            "http" => Transport::Http {
                client: http_client()?,
                url: remote_url(spec)?,
                headers: header_map(spec)?,
                session_id: None,
                protocol: None,
            },
            "sse" => Self::open_sse(spec).await?,
            other => return Err(format!("Unknown MCP transport '{other}'.")),
        };
        let mut conn = Connection {
            transport,
            next_id: AtomicU64::new(1),
            tools: None,
            fingerprint: spec.fingerprint(),
            last_used: Instant::now(),
        };
        let init = conn
            .request(
                "initialize",
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "spacron", "version": env!("CARGO_PKG_VERSION") }
                }),
                INITIALIZE_TIMEOUT,
            )
            .await;
        let init = match init {
            Ok(v) => v,
            Err(e) => {
                let detail = conn.stderr_tail().await;
                conn.shutdown().await;
                return Err(if detail.is_empty() { e } else { format!("{e}\n{detail}") });
            }
        };
        if let Transport::Http { protocol, .. } = &mut conn.transport {
            *protocol = init.get("protocolVersion").and_then(|v| v.as_str()).map(str::to_string);
        }
        conn.notify("notifications/initialized").await?;
        Ok(conn)
    }

    async fn open_stdio(spec: &McpServerSpec) -> Result<Transport, String> {
        let mut cmd = stdio_command(spec)?;
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start '{}': {e}", spec.command.as_deref().unwrap_or("")))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr_pipe = child.stderr.take().ok_or("no stderr")?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                    deliver(&reader_pending, msg).await;
                }
            }
            // The process is gone: dropping the senders fails every waiter.
            reader_pending.lock().await.clear();
        });

        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = stderr.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr_pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut s = sink.lock().await;
                s.push_str(&String::from_utf8_lossy(&buf[..n]));
                if s.len() > STDERR_KEEP {
                    let cut = s.len() - STDERR_KEEP;
                    let cut = (cut..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(s.len());
                    s.drain(..cut);
                }
            }
        });
        Ok(Transport::Stdio { child, stdin, pending, stderr })
    }

    async fn open_sse(spec: &McpServerSpec) -> Result<Transport, String> {
        let client = http_client()?;
        let url = remote_url(spec)?;
        let headers = header_map(spec)?;
        let res = client
            .get(&url)
            .headers(headers.clone())
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| format!("Could not reach the MCP server: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("The MCP server answered {} to the event stream.", res.status()));
        }
        let base = res.url().clone();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let (endpoint_tx, endpoint_rx) = oneshot::channel::<String>();

        let reader_pending = pending.clone();
        let reader_alive = alive.clone();
        let reader = tokio::spawn(async move {
            let mut endpoint_tx = Some(endpoint_tx);
            let mut parser = SseParser::default();
            let mut stream = res.bytes_stream();
            while let Some(Ok(chunk)) = stream.next().await {
                for (event, data) in parser.feed(&String::from_utf8_lossy(&chunk)) {
                    if event == "endpoint" {
                        if let Some(tx) = endpoint_tx.take() {
                            let _ = tx.send(data);
                        }
                    } else if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&data) {
                        deliver(&reader_pending, msg).await;
                    }
                }
            }
            reader_alive.store(false, Ordering::SeqCst);
            reader_pending.lock().await.clear();
        });

        let endpoint = tokio::time::timeout(Duration::from_secs(30), endpoint_rx)
            .await
            .map_err(|_| "The MCP server's event stream never said where to send messages.".to_string())?
            .map_err(|_| "The MCP server closed its event stream.".to_string())?;
        let post_url = base
            .join(endpoint.trim())
            .map_err(|_| "The MCP server sent an invalid message endpoint.".to_string())?;
        // The endpoint comes from the server; keep credentials on its origin.
        if post_url.origin() != base.origin() {
            reader.abort();
            return Err("The MCP server's message endpoint is on another site; refusing to send credentials there.".into());
        }
        Ok(Transport::Sse { client, post_url: post_url.to_string(), headers, pending, alive, reader })
    }

    fn alive(&mut self) -> bool {
        match &mut self.transport {
            Transport::Stdio { child, .. } => matches!(child.try_wait(), Ok(None)),
            Transport::Http { .. } => true,
            Transport::Sse { alive, .. } => alive.load(Ordering::SeqCst),
        }
    }

    async fn stderr_tail(&self) -> String {
        match &self.transport {
            Transport::Stdio { stderr, .. } => stderr.lock().await.trim().to_string(),
            _ => String::new(),
        }
    }

    async fn shutdown(&mut self) {
        match &mut self.transport {
            Transport::Stdio { child, .. } => {
                let _ = child.start_kill();
            }
            Transport::Http { client, url, headers, session_id: Some(id), .. } => {
                // Best effort: tell the server the session is over.
                let _ = client
                    .delete(url.as_str())
                    .headers(headers.clone())
                    .header("Mcp-Session-Id", id.as_str())
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await;
            }
            Transport::Sse { reader, .. } => reader.abort(),
            _ => {}
        }
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        let msg = serde_json::json!({ "jsonrpc": "2.0", "method": method });
        if matches!(self.transport, Transport::Http { .. }) {
            return self.http_post(&msg, None).await.map(|_| ());
        }
        match &mut self.transport {
            Transport::Stdio { stdin, .. } => write_line(stdin, &msg).await,
            Transport::Http { .. } => unreachable!("handled above"),
            Transport::Sse { client, post_url, headers, .. } => client
                .post(post_url.as_str())
                .headers(headers.clone())
                .json(&msg)
                .send()
                .await
                .map(|_| ())
                .map_err(|e| format!("The MCP server stopped: {e}")),
        }
    }

    async fn request(&mut self, method: &str, params: serde_json::Value, timeout: Duration) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if matches!(self.transport, Transport::Http { .. }) {
            let reply = tokio::time::timeout(timeout, self.http_post(&msg, Some(id)))
                .await
                .map_err(|_| format!("The MCP server did not answer within {} s.", timeout.as_secs()))??;
            return rpc_result(reply.ok_or_else(|| "The MCP server sent no answer.".to_string())?);
        }
        let answer = match &mut self.transport {
            Transport::Http { .. } => unreachable!("handled above"),
            Transport::Stdio { stdin, pending, .. } => {
                let (tx, rx) = oneshot::channel();
                pending.lock().await.insert(id, tx);
                write_line(stdin, &msg).await?;
                await_answer(pending, id, rx, timeout).await?
            }
            Transport::Sse { client, post_url, headers, pending, .. } => {
                let (tx, rx) = oneshot::channel();
                pending.lock().await.insert(id, tx);
                let res = client
                    .post(post_url.as_str())
                    .headers(headers.clone())
                    .json(&msg)
                    .send()
                    .await
                    .map_err(|e| format!("The MCP server stopped: {e}"))?;
                if !res.status().is_success() {
                    pending.lock().await.remove(&id);
                    return Err(format!("The MCP server answered {}.", res.status()));
                }
                await_answer(pending, id, rx, timeout).await?
            }
        };
        rpc_result(answer)
    }

    /// One Streamable HTTP exchange. Returns the response whose id is
    /// `expect`, or `None` for a notification.
    async fn http_post(&mut self, msg: &serde_json::Value, expect: Option<u64>) -> Result<Option<serde_json::Value>, String> {
        let Transport::Http { client, url, headers, session_id, protocol } = &mut self.transport else {
            unreachable!("http_post on a non-HTTP transport")
        };
        let mut req = client
            .post(url.as_str())
            .headers(headers.clone())
            .header("Accept", "application/json, text/event-stream")
            .json(msg);
        if let Some(id) = session_id.as_deref() {
            req = req.header("Mcp-Session-Id", id);
        }
        if let Some(v) = protocol.as_deref() {
            req = req.header("MCP-Protocol-Version", v);
        }
        let res = req.send().await.map_err(|e| format!("Could not reach the MCP server: {e}"))?;
        if let Some(id) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session_id = Some(id.to_string());
        }
        let status = res.status();
        if status.is_redirection() {
            return Err(format!("The MCP server redirected ({status}); put the final URL in Settings > MCP."));
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            let hint = if status.as_u16() == 401 || status.as_u16() == 403 {
                " Check the server's auth header in Settings > MCP."
            } else {
                ""
            };
            return Err(format!("The MCP server answered {status}.{hint} {}", body.chars().take(300).collect::<String>()).trim().to_string());
        }
        let Some(expect) = expect else { return Ok(None) };
        let is_sse = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.starts_with("text/event-stream"))
            .unwrap_or(false);
        if !is_sse {
            let body: serde_json::Value = res.json().await.map_err(|e| format!("The MCP server sent invalid JSON: {e}"))?;
            // A batch reply is an array; take our id from it.
            if let Some(items) = body.as_array() {
                return Ok(items.iter().find(|m| m.get("id").and_then(|v| v.as_u64()) == Some(expect)).cloned());
            }
            return Ok(Some(body));
        }
        let mut parser = SseParser::default();
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("The MCP server's stream broke: {e}"))?;
            for (_, data) in parser.feed(&String::from_utf8_lossy(&chunk)) {
                if let Ok(m) = serde_json::from_str::<serde_json::Value>(&data) {
                    if m.get("method").is_none() && m.get("id").and_then(|v| v.as_u64()) == Some(expect) {
                        return Ok(Some(m));
                    }
                }
            }
        }
        Err("The MCP server closed the stream without answering.".into())
    }

    async fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, String> {
        if let Some(tools) = &self.tools {
            return Ok(tools.clone());
        }
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_TOOL_PAGES {
            let params = match &cursor {
                Some(c) => serde_json::json!({ "cursor": c }),
                None => serde_json::json!({}),
            };
            let page = self.request("tools/list", params, CALL_TIMEOUT).await?;
            for t in page.get("tools").and_then(|t| t.as_array()).into_iter().flatten() {
                let Some(name) = t.get("name").and_then(|n| n.as_str()) else { continue };
                tools.push(McpToolInfo {
                    name: name.to_string(),
                    description: t.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                    input_schema: t.get("inputSchema").cloned().unwrap_or_else(|| serde_json::json!({ "type": "object" })),
                    read_only: t
                        .get("annotations")
                        .and_then(|a| a.get("readOnlyHint"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                });
            }
            cursor = page.get("nextCursor").and_then(|c| c.as_str()).map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        self.tools = Some(tools.clone());
        Ok(tools)
    }
}

async fn write_line(stdin: &mut ChildStdin, msg: &serde_json::Value) -> Result<(), String> {
    let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.map_err(|e| format!("The MCP server stopped: {e}"))?;
    stdin.flush().await.map_err(|e| format!("The MCP server stopped: {e}"))
}

async fn await_answer(
    pending: &Pending,
    id: u64,
    rx: oneshot::Receiver<serde_json::Value>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(msg)) => Ok(msg),
        Ok(Err(_)) => Err("The MCP server stopped while working.".into()),
        Err(_) => {
            pending.lock().await.remove(&id);
            Err(format!("The MCP server did not answer within {} s.", timeout.as_secs()))
        }
    }
}

// ---------------------------------------------------------------------------
// Connections, keyed by the server's id in the settings list
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct McpClients {
    connections: Mutex<HashMap<String, Arc<Mutex<Option<Connection>>>>>,
    reaper_started: AtomicBool,
}

impl McpClients {
    async fn slot(&self, server_id: &str) -> Arc<Mutex<Option<Connection>>> {
        self.connections
            .lock()
            .await
            .entry(server_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }

    async fn close(&self, server_id: &str) {
        let slot = self.connections.lock().await.remove(server_id);
        if let Some(slot) = slot {
            if let Some(mut c) = slot.lock().await.take() {
                c.shutdown().await;
            }
        }
    }
}

fn start_reaper(state: Arc<McpClients>) {
    if state.reaper_started.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let slots: Vec<(String, Arc<Mutex<Option<Connection>>>)> =
                state.connections.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (key, slot) in slots {
                let idle = match slot.try_lock() {
                    Ok(guard) => guard.as_ref().map(|c| c.last_used.elapsed() > IDLE_SHUTDOWN).unwrap_or(true),
                    Err(_) => false,
                };
                if idle {
                    state.close(&key).await;
                }
            }
        }
    });
}

/// Run `f` against a live connection for this server, (re)connecting first
/// when there is none, it died, or the user edited the server since.
async fn with_connection<T>(
    state: &Arc<McpClients>,
    server_id: &str,
    spec: &McpServerSpec,
    f: impl for<'a> FnOnce(&'a mut Connection) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>>,
) -> Result<T, String> {
    if server_id.trim().is_empty() {
        return Err("The MCP call needs a server id.".into());
    }
    start_reaper(state.clone());
    let slot = state.slot(server_id).await;
    let mut guard = slot.lock().await;
    let reusable = match guard.as_mut() {
        Some(c) => c.fingerprint == spec.fingerprint() && c.alive(),
        None => false,
    };
    if !reusable {
        if let Some(mut old) = guard.take() {
            old.shutdown().await;
        }
        *guard = Some(Connection::open(spec).await?);
    }
    let conn = guard.as_mut().expect("connection just opened");
    conn.last_used = Instant::now();
    let result = f(conn).await;
    if result.is_err() && !conn.alive() {
        // A dead server is restarted by the next call.
        if let Some(mut c) = guard.take() {
            c.shutdown().await;
        }
    }
    result
}

/// The server's tools (cached per connection).
#[tauri::command]
pub async fn mcp_client_list_tools(
    state: tauri::State<'_, Arc<McpClients>>,
    server_id: String,
    spec: McpServerSpec,
) -> Result<Vec<McpToolInfo>, String> {
    let state = state.inner().clone();
    with_connection(&state, &server_id, &spec, |c| Box::pin(c.list_tools())).await
}

/// Call one tool. Whether the call is allowed is decided by the chat's
/// approval policy before this runs.
#[tauri::command]
pub async fn mcp_client_call_tool(
    state: tauri::State<'_, Arc<McpClients>>,
    server_id: String,
    spec: McpServerSpec,
    tool: String,
    arguments: serde_json::Value,
) -> Result<McpCallResult, String> {
    let arguments = if arguments.is_object() { arguments } else { serde_json::json!({}) };
    let state = state.inner().clone();
    let result = with_connection(&state, &server_id, &spec, |c| {
        Box::pin(async move {
            let tools = c.list_tools().await?;
            if !tools.iter().any(|t| t.name == tool) {
                return Err(format!("This server has no tool named '{tool}'."));
            }
            c.request("tools/call", serde_json::json!({ "name": tool, "arguments": arguments }), CALL_TIMEOUT).await
        })
    })
    .await?;
    Ok(collect_content(&result, &server_id))
}

/// Forget a server's connection (removed or edited in settings).
#[tauri::command]
pub async fn mcp_client_close(state: tauri::State<'_, Arc<McpClients>>, server_id: String) -> Result<(), String> {
    state.close(&server_id).await;
    Ok(())
}

fn collect_content(result: &serde_json::Value, server_id: &str) -> McpCallResult {
    let mut parts: Vec<String> = Vec::new();
    let mut images = Vec::new();
    let dir = std::env::temp_dir().join("spacron-mcp").join(sanitize(server_id));
    for (index, item) in result.get("content").and_then(|c| c.as_array()).into_iter().flatten().enumerate() {
        match item.get("type").and_then(|t| t.as_str()) {
            Some("text") => parts.push(item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string()),
            Some("image") => {
                if let Some(path) = save_image(&dir, index, item) {
                    parts.push(format!("[image saved to {path}]"));
                    images.push(path);
                }
            }
            Some("resource") => {
                let res = item.get("resource");
                let uri = res.and_then(|r| r.get("uri")).and_then(|u| u.as_str()).unwrap_or("");
                match res.and_then(|r| r.get("text")).and_then(|t| t.as_str()) {
                    Some(text) => parts.push(format!("[resource {uri}]\n{text}")),
                    None => parts.push(format!("[binary resource {uri}]")),
                }
            }
            Some("resource_link") => {
                let uri = item.get("uri").and_then(|u| u.as_str()).unwrap_or("");
                parts.push(format!("[resource link {uri}]"));
            }
            Some(other) => parts.push(format!("[{other} content omitted]")),
            None => {}
        }
    }
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            parts.push(structured.to_string());
        }
    }
    McpCallResult {
        text: parts.join("\n"),
        images,
        is_error: result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
    }
}

fn save_image(dir: &std::path::Path, index: usize, item: &serde_json::Value) -> Option<String> {
    use base64::Engine as _;
    let ext = match item.get("mimeType").and_then(|m| m.as_str()) {
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("image/gif") => "gif",
        _ => "png",
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(item.get("data")?.as_str()?).ok()?;
    std::fs::create_dir_all(dir).ok()?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("image-{stamp}-{index}.{ext}"));
    std::fs::write(&path, bytes).ok()?;
    Some(path.display().to_string())
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(64).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_joins_split_chunks_and_multiline_data() {
        let mut p = SseParser::default();
        assert!(p.feed("event: endpoint\ndata: /messages?s").is_empty());
        let events = p.feed("=1\n\ndata: {\"a\":\ndata: 1}\r\n\r\n");
        assert_eq!(events, vec![
            ("endpoint".to_string(), "/messages?s=1".to_string()),
            ("message".to_string(), "{\"a\":\n1}".to_string()),
        ]);
    }

    #[test]
    fn content_is_flattened_to_text() {
        let result = serde_json::json!({
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "resource", "resource": { "uri": "file:///a.txt", "text": "body" } },
                { "type": "audio", "data": "" }
            ],
            "isError": true
        });
        let out = collect_content(&result, "srv");
        assert_eq!(out.text, "hello\n[resource file:///a.txt]\nbody\n[audio content omitted]");
        assert!(out.is_error);
    }

    #[test]
    fn a_spec_edit_changes_the_fingerprint() {
        let a = McpServerSpec { transport: "stdio".into(), url: None, headers: None, command: Some("node".into()), args: Some(vec!["a.js".into()]), env: None };
        let mut b = a.clone();
        assert_eq!(a.fingerprint(), b.fingerprint());
        b.args = Some(vec!["b.js".into()]);
        assert_ne!(a.fingerprint(), b.fingerprint());
    }

    /// End to end over stdio against a tiny scripted server (needs `node`).
    #[tokio::test]
    async fn stdio_server_lists_and_calls_tools() {
        if super::super::agent_probe::which("node").is_none() && super::super::agent_probe::which("node.exe").is_none() {
            eprintln!("node not found; skipping");
            return;
        }
        let script = r#"
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'wipe', description: 'Wipe', inputSchema: { type: 'object' } } ] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'you said ' + m.params.arguments.say }] } });
});
"#;
        let dir = std::env::temp_dir().join(format!("spacron-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("server.js");
        std::fs::write(&file, script).unwrap();
        let spec = McpServerSpec {
            transport: "stdio".into(),
            url: None,
            headers: None,
            command: Some("node".into()),
            args: Some(vec![file.display().to_string()]),
            env: None,
        };
        let state = Arc::new(McpClients::default());
        let tools = with_connection(&state, "t", &spec, |c| Box::pin(c.list_tools())).await.unwrap();
        assert_eq!(tools.len(), 2);
        assert!(tools[0].read_only);
        assert!(!tools[1].read_only);
        let result = with_connection(&state, "t", &spec, |c| {
            Box::pin(c.request("tools/call", serde_json::json!({ "name": "echo", "arguments": { "say": "hi" } }), CALL_TIMEOUT))
        })
        .await
        .unwrap();
        assert_eq!(collect_content(&result, "t").text, "you said hi");
        state.close("t").await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
