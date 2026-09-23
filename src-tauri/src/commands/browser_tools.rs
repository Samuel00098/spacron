//! The agent browser (docs/agent-browser.md): Microsoft's Playwright MCP server.
//!
//! Three jobs, one module, because all three are about the same pinned server:
//!
//! 1. **The pinned install.** `npx -y @playwright/mcp@latest` re-resolved the
//!    tag against the registry on every launch (~28 s warm on Windows) and let
//!    an upstream release change the tool surface under us. The server is now
//!    installed once, at [`PLAYWRIGHT_MCP_VERSION`], under the app's config dir
//!    and launched with `node cli.js` (~1.3 s). The agent configs written by
//!    `mcpBridge.ts` use the same install; `npx` pinned to the same version is
//!    the fallback when it is missing.
//! 2. **The orchestrator's browser.** Spacron is an MCP *server*, not a client,
//!    so the in-app chat could not use Playwright. This is a minimal stdio
//!    JSON-RPC client for this one server: one browser process per chat
//!    conversation, started on first use, stopped after it idles, killed with
//!    the app. Only an allowlisted set of tools passes (see
//!    [`ORCHESTRATOR_BROWSER_TOOLS`]).
//! 3. **Project sign-in.** A headed browser the user signs in with once; its
//!    cookies and storage are saved per project, and agents' isolated browsers
//!    start from that saved state (`--storage-state`) — signed-in browsing with
//!    no shared profile to lock, so agents still run in parallel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

/// The Playwright MCP version every Spacron browser uses. Bump deliberately:
/// `mcpBridge.ts` has the same constant (a test there reads this line to keep
/// them equal), and [`KNOWN_TOOLS`] must be re-recorded from the new version.
pub const PLAYWRIGHT_MCP_VERSION: &str = "0.0.82";

/// `tools/list` of the pinned version, recorded from the real server. Only the
/// tests read it: they hold the allowlist and the live server to it.
#[cfg(test)]
const KNOWN_TOOLS: &[&str] = &[
    "browser_close",
    "browser_resize",
    "browser_console_messages",
    "browser_handle_dialog",
    "browser_emulate_media",
    "browser_evaluate",
    "browser_file_upload",
    "browser_drop",
    "browser_find",
    "browser_fill_form",
    "browser_press_key",
    "browser_type",
    "browser_navigate",
    "browser_navigate_back",
    "browser_network_requests",
    "browser_network_request",
    "browser_run_code_unsafe",
    "browser_take_screenshot",
    "browser_snapshot",
    "browser_click",
    "browser_drag",
    "browser_hover",
    "browser_select_option",
    "browser_tabs",
    "browser_wait_for",
];

/// What the orchestrator may call. Deliberately absent:
/// - `browser_file_upload` and `browser_drop` take local file paths, which
///   would go around path confinement;
/// - `browser_run_code_unsafe` runs arbitrary code in the server process —
///   upstream calls it RCE-equivalent — so no approval makes it safe here;
/// - `browser_fill_form` and `browser_emulate_media` have argument shapes the
///   chat's tool schemas cannot express; `browser_type` and a click cover forms.
pub const ORCHESTRATOR_BROWSER_TOOLS: &[&str] = &[
    "browser_navigate",
    "browser_navigate_back",
    "browser_snapshot",
    "browser_take_screenshot",
    "browser_console_messages",
    "browser_network_requests",
    "browser_network_request",
    "browser_tabs",
    "browser_wait_for",
    "browser_find",
    "browser_click",
    "browser_hover",
    "browser_type",
    "browser_select_option",
    "browser_press_key",
    "browser_drag",
    "browser_handle_dialog",
    "browser_resize",
    "browser_close",
    "browser_evaluate",
];

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(120);
const CALL_TIMEOUT: Duration = Duration::from_secs(180);
const IDLE_SHUTDOWN: Duration = Duration::from_secs(10 * 60);
const STDERR_KEEP: usize = 4096;

// ---------------------------------------------------------------------------
// Paths and the pinned install
// ---------------------------------------------------------------------------

fn spacron_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|d| d.join("spacron"))
        .ok_or_else(|| "Could not find the config directory.".to_string())
}

fn install_dir() -> Result<PathBuf, String> {
    Ok(spacron_dir()?.join("tools").join("playwright-mcp"))
}

fn cli_path(dir: &Path) -> PathBuf {
    dir.join("node_modules").join("@playwright").join("mcp").join("cli.js")
}

/// Where Playwright writes snapshots and screenshots. Its default is the
/// current directory — for an agent, the user's repo, which put a
/// `.playwright-mcp` folder into their `git status`.
fn output_dir(sub: &str) -> PathBuf {
    std::env::temp_dir().join("spacron-playwright").join(sub)
}

/// The installed version, if the pinned install is present and complete.
fn installed_version(dir: &Path) -> Option<String> {
    let manifest = dir.join("node_modules").join("@playwright").join("mcp").join("package.json");
    let text = std::fs::read_to_string(manifest).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let version = json.get("version")?.as_str()?.to_string();
    cli_path(dir).is_file().then_some(version)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolsStatus {
    /// The version Spacron pins.
    pub version: &'static str,
    /// Absolute path of `cli.js` when the pinned version is installed.
    pub cli_path: Option<String>,
    /// The version found on disk, when it differs from the pin.
    pub installed_version: Option<String>,
    /// Where agents' snapshots and screenshots go (never the project).
    pub output_dir: String,
}

fn status() -> Result<BrowserToolsStatus, String> {
    let dir = install_dir()?;
    let found = installed_version(&dir);
    let ready = found.as_deref() == Some(PLAYWRIGHT_MCP_VERSION);
    Ok(BrowserToolsStatus {
        version: PLAYWRIGHT_MCP_VERSION,
        cli_path: ready.then(|| cli_path(&dir).display().to_string()),
        installed_version: if ready { None } else { found },
        output_dir: output_dir("agents").display().to_string(),
    })
}

#[tauri::command]
pub fn browser_tools_status() -> Result<BrowserToolsStatus, String> {
    status()
}

/// A `Command` for an npm-installed CLI. On Windows `npm`/`npx` are `.cmd`
/// shims that only run through `cmd /c` (see the windows-pathext-shims note).
fn shim_command(program: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(program);
        c
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

const CHILD_PATH_LIMIT: usize = 6000;

fn child_path() -> Option<std::ffi::OsString> {
    let full = crate::commands::agent_probe::search_path()?;
    let mut length = 0usize;
    let kept: Vec<PathBuf> = std::env::split_paths(&full)
        .take_while(|dir| {
            length += dir.as_os_str().len() + 1;
            length <= CHILD_PATH_LIMIT
        })
        .collect();
    std::env::join_paths(kept).ok()
}

/// Every child here gets the same PATH a fresh terminal would, trimmed to what
/// cmd.exe can still search (`agent_probe::search_path`). npm and npx start
/// the package through shells of their own, and those stop finding anything
/// once PATH passes cmd's line limit — which a dev environment easily does.
///
/// Trimmed further than `search_path` alone (to [`CHILD_PATH_LIMIT`]): npx
/// prepends its cache's `.bin` directory before its shell runs the package,
/// and at 8000 characters that pushed PATH back over the limit — "npx" ran,
/// then "'playwright-mcp' is not recognized".
fn hide_console(cmd: &mut Command) {
    if let Some(path) = child_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Install (or reinstall) the pinned version. Needs Node and npm on PATH.
#[tauri::command]
pub async fn browser_tools_install() -> Result<BrowserToolsStatus, String> {
    let dir = install_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let mut cmd = shim_command("npm");
    cmd.arg("install")
        .arg("--prefix")
        .arg(&dir)
        .arg(format!("@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}"))
        .args(["--no-audit", "--no-fund", "--loglevel", "error"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| "npm install took longer than 10 minutes.".to_string())?
        .map_err(|e| format!("Could not run npm (is Node.js installed and on PATH?): {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("npm install failed: {}", err.trim().chars().take(800).collect::<String>()));
    }
    let s = status()?;
    if s.cli_path.is_none() {
        return Err("npm finished, but the Playwright MCP server is not where it should be.".into());
    }
    Ok(s)
}

/// The command line that starts the pinned server: `node cli.js …` when it is
/// installed, `npx -y @playwright/mcp@<pin> …` otherwise.
fn server_command(extra: &[String]) -> Result<Command, String> {
    let s = status()?;
    let mut cmd = match &s.cli_path {
        Some(cli) => {
            let mut c = Command::new("node");
            c.arg(cli);
            c
        }
        None => {
            let mut c = shim_command("npx");
            c.arg("-y").arg(format!("@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}"));
            c
        }
    };
    cmd.args(extra);
    hide_console(&mut cmd);
    Ok(cmd)
}

// ---------------------------------------------------------------------------
// A minimal MCP stdio client
// ---------------------------------------------------------------------------

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>;

struct McpStdioClient {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    next_id: AtomicU64,
    stderr: Arc<Mutex<String>>,
}

impl McpStdioClient {
    /// Spawn the server and complete the MCP handshake.
    async fn start(mut cmd: Command) -> Result<Self, String> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start the browser server (is Node.js installed?): {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr_pipe = child.stderr.take().ok_or("no stderr")?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            // Newline-delimited JSON-RPC. Server-initiated requests and
            // notifications (no `id` we issued) are ignored.
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                if msg.get("method").is_some() {
                    continue;
                }
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = reader_pending.lock().await.remove(&id) {
                        let _ = tx.send(msg);
                    }
                }
            }
            // The process is gone: fail everything still waiting.
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

        let mut client = Self { child, stdin, pending, next_id: AtomicU64::new(1), stderr };
        let init = client
            .request(
                "initialize",
                serde_json::json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "spacron", "version": env!("CARGO_PKG_VERSION") }
                }),
                INITIALIZE_TIMEOUT,
            )
            .await;
        if let Err(e) = init {
            let detail = client.stderr.lock().await.trim().to_string();
            let _ = client.child.start_kill();
            return Err(if detail.is_empty() { e } else { format!("{e}\n{detail}") });
        }
        client.notify("notifications/initialized").await?;
        Ok(client)
    }

    async fn write(&mut self, msg: &serde_json::Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("The browser server stopped: {e}"))?;
        self.stdin.flush().await.map_err(|e| format!("The browser server stopped: {e}"))
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        self.write(&serde_json::json!({ "jsonrpc": "2.0", "method": method })).await
    }

    async fn request(&mut self, method: &str, params: serde_json::Value, timeout: Duration) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write(&serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;
        let msg = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(msg)) => msg,
            Ok(Err(_)) => return Err("The browser server stopped while working.".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err(format!("The browser did not answer within {} s.", timeout.as_secs()));
            }
        };
        if let Some(err) = msg.get("error") {
            return Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("browser error").to_string());
        }
        Ok(msg.get("result").cloned().unwrap_or(serde_json::Value::Null))
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

// ---------------------------------------------------------------------------
// The orchestrator's sessions
// ---------------------------------------------------------------------------

struct Session {
    client: McpStdioClient,
    last_used: Instant,
}

/// One browser per chat conversation. Behind one async mutex per session, so
/// a conversation's calls are sequential (a click must not race a navigation)
/// while different conversations do not wait for each other.
#[derive(Default)]
pub struct BrowserSessions {
    sessions: Mutex<HashMap<String, Arc<Mutex<Option<Session>>>>>,
    reaper_started: std::sync::atomic::AtomicBool,
}

impl BrowserSessions {
    async fn slot(&self, conversation: &str) -> Arc<Mutex<Option<Session>>> {
        self.sessions
            .lock()
            .await
            .entry(conversation.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }

    async fn close(&self, conversation: &str) {
        let slot = self.sessions.lock().await.remove(conversation);
        if let Some(slot) = slot {
            if let Some(mut s) = slot.lock().await.take() {
                let _ = s.client.child.start_kill();
            }
        }
    }
}

fn start_reaper(state: Arc<BrowserSessions>) {
    if state.reaper_started.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let slots: Vec<(String, Arc<Mutex<Option<Session>>>)> =
                state.sessions.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (key, slot) in slots {
                // try_lock: a session that is busy right now is not idle.
                let idle = match slot.try_lock() {
                    Ok(guard) => guard.as_ref().map(|s| s.last_used.elapsed() > IDLE_SHUTDOWN).unwrap_or(true),
                    Err(_) => false,
                };
                if idle {
                    state.close(&key).await;
                }
            }
        }
    });
}

/// What one browser call returns to the orchestrator.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCallResult {
    /// The tool's text output (images are dropped; the server already saved
    /// screenshots to the output dir and names the file in the text).
    pub text: String,
    /// The page's URL after the call, when the server reported one. The
    /// orchestrator's origin policy checks it after every call, because a
    /// click can navigate just as well as `browser_navigate` can.
    pub page_url: Option<String>,
    pub is_error: bool,
}

fn page_url(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .find_map(|l| l.trim().strip_prefix("- Page URL:").map(|u| u.trim().to_string()))
        .filter(|u| !u.is_empty())
}

/// Only web pages. `file:` would read the user's disk around path confinement,
/// and `javascript:`/`data:` are code, not a destination.
fn check_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower == "about:blank" {
        return Ok(());
    }
    if !lower.contains("://") && !lower.starts_with("about:") && !lower.contains(':') {
        // A bare host ("localhost:3000" has a colon but no scheme, handled
        // below); Playwright would treat it as relative and fail anyway.
        return Err("Use a full http:// or https:// address.".into());
    }
    if lower.starts_with("localhost:") || lower.starts_with("127.0.0.1:") {
        return Err("Use a full address, e.g. http://localhost:3000.".into());
    }
    Err("Only http:// and https:// pages can be opened in the browser.".into())
}

/// Run one Playwright tool in the chat conversation's browser, starting it if
/// needed. `name` comes from a model's tool call, so it is checked against the
/// allowlist here as well as in the frontend.
#[tauri::command]
pub async fn browser_call_tool(
    state: tauri::State<'_, Arc<BrowserSessions>>,
    conversation: String,
    name: String,
    args: serde_json::Value,
) -> Result<BrowserCallResult, String> {
    if !ORCHESTRATOR_BROWSER_TOOLS.contains(&name.as_str()) {
        return Err(format!("'{name}' is not available to the chat's browser."));
    }
    if conversation.trim().is_empty() {
        return Err("The browser needs a conversation id.".into());
    }
    let mut args = args;
    if name == "browser_navigate" {
        check_url(args.get("url").and_then(|u| u.as_str()).unwrap_or(""))?;
    }
    // A new tab can open a URL too.
    if name == "browser_tabs" {
        if let Some(url) = args.get("url").and_then(|u| u.as_str()) {
            check_url(url)?;
        }
    }
    // `filename` makes several tools write a file wherever it points; the
    // server's output dir is where results belong.
    if let Some(map) = args.as_object_mut() {
        map.remove("filename");
    }
    let state = state.inner().clone();
    start_reaper(state.clone());
    let slot = state.slot(&conversation).await;
    let mut guard = slot.lock().await;

    let needs_start = match guard.as_mut() {
        Some(s) => !s.client.alive(),
        None => true,
    };
    if needs_start {
        // Headed, so the user can watch; isolated, so nothing persists and
        // several conversations never contend for a profile.
        let out = output_dir(&format!("chat-{}", sanitize(&conversation)));
        let _ = std::fs::create_dir_all(&out);
        let args = vec!["--isolated".to_string(), "--output-dir".to_string(), out.display().to_string()];
        let mut cmd = server_command(&args)?;
        cmd.current_dir(std::env::temp_dir());
        let client = McpStdioClient::start(cmd).await?;
        *guard = Some(Session { client, last_used: Instant::now() });
    }
    let session = guard.as_mut().expect("session just started");
    session.last_used = Instant::now();
    let result = session
        .client
        .request("tools/call", serde_json::json!({ "name": name, "arguments": args }), CALL_TIMEOUT)
        .await;
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            // A dead or wedged server is restarted by the next call.
            if let Some(mut s) = guard.take() {
                let _ = s.client.child.start_kill();
            }
            return Err(e);
        }
    };
    let mut text = String::new();
    for item in result.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(item.get("text").and_then(|t| t.as_str()).unwrap_or(""));
        }
    }
    Ok(BrowserCallResult {
        page_url: page_url(&text),
        is_error: result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
        text,
    })
}

/// Close a conversation's browser (conversation deleted, or the user asked).
#[tauri::command]
pub async fn browser_close_session(state: tauri::State<'_, Arc<BrowserSessions>>, conversation: String) -> Result<(), String> {
    state.close(&conversation).await;
    Ok(())
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(64).collect()
}

// ---------------------------------------------------------------------------
// "Test browser tools"
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolsCheck {
    pub ok: bool,
    pub server: Option<String>,
    pub tool_count: usize,
    pub start_ms: u128,
    pub via: &'static str,
    pub error: Option<String>,
}

/// Start the server exactly the way agents will, complete the handshake, list
/// its tools, and stop it. Surfaces the failure an agent would otherwise only
/// experience as "no browser tools", with no reason given.
#[tauri::command]
pub async fn browser_tools_check() -> Result<BrowserToolsCheck, String> {
    let via = if status()?.cli_path.is_some() { "installed" } else { "npx" };
    let started = Instant::now();
    let mut cmd = server_command(&["--isolated".to_string(), "--headless".to_string()])?;
    cmd.current_dir(std::env::temp_dir());
    let mut client = match McpStdioClient::start(cmd).await {
        Ok(c) => c,
        Err(e) => {
            return Ok(BrowserToolsCheck { ok: false, server: None, tool_count: 0, start_ms: started.elapsed().as_millis(), via, error: Some(e) })
        }
    };
    let start_ms = started.elapsed().as_millis();
    let tools = client.request("tools/list", serde_json::json!({}), Duration::from_secs(30)).await;
    let _ = client.child.start_kill();
    Ok(match tools {
        Ok(t) => BrowserToolsCheck {
            ok: true,
            server: Some(format!("Playwright MCP {PLAYWRIGHT_MCP_VERSION}")),
            tool_count: t.get("tools").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
            start_ms,
            via,
            error: None,
        },
        Err(e) => BrowserToolsCheck { ok: false, server: None, tool_count: 0, start_ms, via, error: Some(e) },
    })
}

// ---------------------------------------------------------------------------
// Project sign-in (storage state)
// ---------------------------------------------------------------------------

/// Where a project's saved sign-in lives. Outside the project on purpose: it
/// holds session cookies, which must never be committed.
fn state_path(project_root: &str) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let normalized = project_root.trim().replace('\\', "/").trim_end_matches('/').to_lowercase();
    if normalized.is_empty() {
        return Err("No project is open.".into());
    }
    let digest = Sha256::digest(normalized.as_bytes());
    let name: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok(spacron_dir()?.join("browser-state").join(format!("{name}.json")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSignIn {
    pub path: String,
    pub exists: bool,
}

#[tauri::command]
pub fn browser_sign_in_state(project_root: String) -> Result<BrowserSignIn, String> {
    let path = state_path(&project_root)?;
    Ok(BrowserSignIn { exists: path.is_file(), path: path.display().to_string() })
}

#[tauri::command]
pub fn browser_forget_sign_in(project_root: String) -> Result<(), String> {
    let path = state_path(&project_root)?;
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
    }
    Ok(())
}

/// The sign-in browser. Saves the context's storage state every two seconds
/// (and once more when the last tab closes), so whatever the user signed in to
/// is on disk however they close the window.
const SIGN_IN_SCRIPT: &str = r#"
const fs = require('fs');
const { chromium } = require('playwright');
const [url, out] = process.argv.slice(1);
(async () => {
  let browser;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ headless: false, channel }); break; } catch (e) { /* next */ }
  }
  if (!browser) { console.error('No Chrome or Edge found to sign in with.'); process.exit(2); }
  const context = await browser.newContext(fs.existsSync(out) ? { storageState: out } : {});
  const save = async () => {
    try { await context.storageState({ path: out + '.tmp' }); fs.renameSync(out + '.tmp', out); } catch (e) { /* closing */ }
  };
  const page = await context.newPage();
  page.goto(url).catch(() => {});
  const timer = setInterval(save, 2000);
  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
    const check = () => { if (context.pages().length === 0) resolve(); };
    context.on('page', (p) => p.on('close', check));
    page.on('close', check);
  });
  clearInterval(timer);
  await save();
  await browser.close().catch(() => {});
})();
"#;

/// Open a browser for the user to sign in to whatever this project's agents
/// should be signed in to. Returns when the user closes it. Needs the pinned
/// install (it uses the Playwright library that ships with it).
#[tauri::command]
pub async fn browser_sign_in(project_root: String, start_url: String) -> Result<BrowserSignIn, String> {
    let start = if start_url.trim().is_empty() { "about:blank".to_string() } else { start_url.trim().to_string() };
    check_url(&start)?;
    let dir = install_dir()?;
    if installed_version(&dir).as_deref() != Some(PLAYWRIGHT_MCP_VERSION) {
        return Err("Install the browser tools first (Settings → Agents → Browser).".into());
    }
    let path = state_path(&project_root)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let mut cmd = Command::new("node");
    cmd.arg("-e").arg(SIGN_IN_SCRIPT).arg(&start).arg(&path).current_dir(&dir);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    hide_console(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(60 * 60), cmd.output())
        .await
        .map_err(|_| "The sign-in browser was open for an hour; it was closed.".to_string())?
        .map_err(|e| format!("Could not start the sign-in browser (is Node.js installed?): {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(500).collect());
    }
    Ok(BrowserSignIn { exists: path.is_file(), path: path.display().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_orchestrator_allowlist_is_served_by_the_pinned_version() {
        for tool in ORCHESTRATOR_BROWSER_TOOLS {
            assert!(KNOWN_TOOLS.contains(tool), "{tool} is not served by Playwright MCP {PLAYWRIGHT_MCP_VERSION}");
        }
        for banned in ["browser_file_upload", "browser_drop", "browser_run_code_unsafe"] {
            assert!(!ORCHESTRATOR_BROWSER_TOOLS.contains(&banned), "{banned} reaches outside the page");
        }
    }

    #[test]
    fn only_web_pages_can_be_opened() {
        for ok in ["https://example.com", "http://localhost:3000/x", "HTTP://127.0.0.1:8080", "about:blank"] {
            assert!(check_url(ok).is_ok(), "{ok}");
        }
        for bad in ["file:///C:/Users/me/.ssh/id_rsa", "javascript:alert(1)", "data:text/html,x", "chrome://settings", "localhost:3000", "view-source:https://x"] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_page_url_is_read_from_the_last_page_section() {
        let text = "### Ran Playwright code\n```js\nawait page.goto('https://a.test');\n```\n### Page\n- Page URL: https://b.test/landing\n- Page Title: B";
        assert_eq!(page_url(text).as_deref(), Some("https://b.test/landing"));
        assert_eq!(page_url("no page here"), None);
    }

    #[test]
    fn sign_in_state_is_per_project_and_outside_it() {
        let a = state_path("C:\\work\\repo").unwrap();
        assert_eq!(a, state_path("c:/work/repo/").unwrap(), "same project, different spelling");
        assert_ne!(a, state_path("C:\\work\\other").unwrap());
        assert!(!a.starts_with("C:\\work\\repo"));
        assert!(state_path("  ").is_err());
    }

    /// Installs the pinned version where Settings would, then checks it starts
    /// from the install. Opt-in: needs Node, npm and network, and writes to
    /// the real tools directory (that is the point).
    #[tokio::test]
    #[ignore]
    async fn real_install_then_start_from_it() {
        let s = browser_tools_install().await.unwrap();
        assert!(s.cli_path.is_some());
        let check = browser_tools_check().await.unwrap();
        println!("installed check: ok={} via={} start={}ms tools={}", check.ok, check.via, check.start_ms, check.tool_count);
        assert!(check.ok);
        assert_eq!(check.via, "installed");
    }

    /// Starts the real pinned server (installed or through npx) and drives one
    /// page. Opt-in: needs Node and network.
    /// `cargo test --lib browser_tools -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_server_answers_and_navigates() {
        let check = browser_tools_check().await.unwrap();
        println!("check: ok={} via={} start={}ms tools={} err={:?}", check.ok, check.via, check.start_ms, check.tool_count, check.error);
        assert!(check.ok);
        assert_eq!(check.tool_count, KNOWN_TOOLS.len(), "the pinned version's tool list changed; re-record KNOWN_TOOLS");

        let mut cmd = server_command(&["--isolated".into(), "--headless".into(), "--output-dir".into(), output_dir("test").display().to_string()]).unwrap();
        cmd.current_dir(std::env::temp_dir());
        let mut client = McpStdioClient::start(cmd).await.unwrap();
        let r = client
            .request("tools/call", serde_json::json!({ "name": "browser_navigate", "arguments": { "url": "https://example.com" } }), CALL_TIMEOUT)
            .await
            .unwrap();
        let text = r["content"][0]["text"].as_str().unwrap_or_default().to_string();
        println!("{}", text.lines().take(8).collect::<Vec<_>>().join("\n"));
        assert_eq!(page_url(&text).as_deref(), Some("https://example.com/"));
        let _ = client.child.start_kill();
    }
}

