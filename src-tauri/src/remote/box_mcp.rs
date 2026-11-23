//! `spacron-box`: the box's own MCP server, so agents and bots on a box keep
//! their Spacron tools while the laptop is closed.
//!
//! On the desktop, agents get `spacron-mcp`, served by the app. A box only
//! reaches that through the reverse tunnel, so it is gone when the laptop
//! disconnects. This server runs inside `spacron-server` and offers what a
//! box can do on its own:
//!
//! - **Agents on the box** — `list_agents`, `read_agent_output`,
//!   `send_to_agent`, backed by the box's own terminals.
//! - **A virtual desktop** — `desktop_*` tools on an X11 virtual screen
//!   (Xvfb, started on first use), so a bot can open and operate GUI apps on
//!   a headless server. Needs `Xvfb`, `xdotool` and ImageMagick (`import`) on
//!   the box. Set `SPACRON_BOX_DISPLAY` (e.g. `:1`) to use an existing display
//!   instead, such as one you watch over VNC.
//!
//! Served at `/mcp` on the sign-in proxy's loopback listener with the same
//! per-run secret (`box_proxy.rs`), as MCP streamable HTTP with plain JSON
//! responses.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine;
use serde_json::{json, Value};

use super::ServerState;

const PROTOCOL_VERSION: &str = "2025-03-26";
const MAX_TYPE_CHARS: usize = 4096;
const MAX_READ_LINES: usize = 400;
const SCREEN: &str = "1280x800x24";

fn server() -> &'static OnceLock<Arc<ServerState>> {
    static STATE: OnceLock<Arc<ServerState>> = OnceLock::new();
    &STATE
}

/// Give the tools the server's terminals. Called once by `serve`.
pub(super) fn init(state: Arc<ServerState>) {
    let _ = server().set(state);
}

// ── MCP over HTTP ───────────────────────────────────────────────────────────

/// POST `/mcp`: one JSON-RPC message (or a batch). The caller is already
/// authenticated by the proxy listener's secret check.
pub(super) async fn handle(body: Value) -> Response {
    if let Some(batch) = body.as_array() {
        let mut out = Vec::new();
        for msg in batch {
            if let Some(reply) = respond(msg).await {
                out.push(reply);
            }
        }
        return if out.is_empty() { StatusCode::ACCEPTED.into_response() } else { Json(Value::Array(out)).into_response() };
    }
    match respond(&body).await {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// GET `/mcp`: this server pushes nothing, so there is no event stream.
pub(super) async fn no_stream(_headers: HeaderMap) -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, "This MCP server answers POST requests only.").into_response()
}

/// The reply to one JSON-RPC message; `None` for notifications.
async fn respond(msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "spacron-box", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Spacron tools on this box: see and message the other agents running here, and operate a virtual desktop (screenshots, clicks, typing) for GUI apps.",
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(tokio::task::spawn_blocking(move || call(&name, &args)).await.unwrap_or_else(|e| error_content(&e.to_string())))
        }
        _ => Err(json!({ "code": -32601, "message": format!("Method not found: {method}") })),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn tools() -> Value {
    let agent = json!({ "type": "integer", "description": "The agent's id, from list_agents." });
    json!([
        { "name": "list_agents", "description": "List the agents and terminals running on this box: id, what is running, folder, and the last line they printed.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "read_agent_output", "description": "Read the recent output of another agent or terminal on this box.",
          "inputSchema": { "type": "object", "properties": { "agent": agent, "lines": { "type": "integer", "description": "How many lines from the end (default 80, at most 400)." } }, "required": ["agent"] } },
        { "name": "send_to_agent", "description": "Send a message to another agent on this box, as if typed into its terminal, and press Enter.",
          "inputSchema": { "type": "object", "properties": { "agent": agent, "message": { "type": "string" }, "submit": { "type": "boolean", "description": "Press Enter after the message (default true)." } }, "required": ["agent", "message"] } },
        { "name": "desktop_screenshot", "description": "Take a screenshot of the box's virtual desktop. Starts the desktop if it is not running.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "desktop_list_windows", "description": "List the windows open on the virtual desktop.",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "desktop_click", "description": "Click on the virtual desktop. x and y are fractions of the screen from 0 to 1 (0,0 is top left), read off a screenshot.",
          "inputSchema": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "button": { "type": "string", "enum": ["left", "middle", "right"] }, "double": { "type": "boolean" } }, "required": ["x", "y"] } },
        { "name": "desktop_type", "description": "Type text into whatever has focus on the virtual desktop.",
          "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } },
        { "name": "desktop_key", "description": "Press keys on the virtual desktop, e.g. \"Return\", \"ctrl+l\", \"Tab Tab Return\".",
          "inputSchema": { "type": "object", "properties": { "keys": { "type": "string" } }, "required": ["keys"] } },
        { "name": "desktop_scroll", "description": "Scroll on the virtual desktop at the pointer. Positive dy scrolls down.",
          "inputSchema": { "type": "object", "properties": { "dy": { "type": "integer" } }, "required": ["dy"] } },
        { "name": "desktop_launch", "description": "Start a GUI program on the virtual desktop, e.g. \"firefox https://example.com\" or \"libreoffice --calc\".",
          "inputSchema": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] } },
    ])
}

fn text_content(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": false })
}

fn error_content(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn call(name: &str, args: &Value) -> Value {
    let result = match name {
        "list_agents" => list_agents(),
        "read_agent_output" => read_agent_output(args),
        "send_to_agent" => send_to_agent(args),
        "desktop_screenshot" => screenshot(),
        "desktop_list_windows" => list_windows(),
        "desktop_click" => click(args),
        "desktop_type" => type_text(args),
        "desktop_key" => press_keys(args),
        "desktop_scroll" => scroll(args),
        "desktop_launch" => launch(args),
        _ => Err(format!("Unknown tool: {name}")),
    };
    result.unwrap_or_else(|e| error_content(&e))
}

// ── agents on the box ───────────────────────────────────────────────────────

/// Terminal output as plain text: escape sequences removed, carriage-return
/// overwrites resolved to what is left on each line.
pub(crate) fn plain_text(bytes: &[u8]) -> String {
    static ANSI: OnceLock<regex::Regex> = OnceLock::new();
    let ansi = ANSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]").expect("valid regex"));
    let text = String::from_utf8_lossy(bytes);
    let stripped = ansi.replace_all(&text, "");
    stripped.split('\n').map(|line| line.rsplit('\r').find(|part| !part.trim().is_empty()).unwrap_or("").trim_end().to_string())
        .collect::<Vec<_>>().join("\n")
}

/// What the terminal's shell is running right now (Linux): its child's name.
fn running_program(pid: Option<u32>) -> Option<String> {
    let pid = pid?;
    let children = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")).ok()?;
    let child = children.split_whitespace().last()?;
    let comm = std::fs::read_to_string(format!("/proc/{child}/comm")).ok()?;
    Some(comm.trim().to_string()).filter(|c| !c.is_empty())
}

fn list_agents() -> Result<Value, String> {
    let state = server().get().ok_or("The box server is still starting.")?;
    let mut ids = state.pty.list_ids();
    ids.sort();
    let mut rows = Vec::new();
    for id in ids {
        let Some(sess) = state.pty.get(id) else { continue };
        let last = plain_text(&sess.output_tail(4096)).lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(160).collect::<String>();
        let program = running_program(sess.pid).unwrap_or_else(|| "shell".into());
        let status = if sess.has_exited() { "exited" } else { "running" };
        rows.push(format!("- id {id}: {program} ({status}) in {}\n  last line: {last}", sess.cwd.display()));
    }
    Ok(text_content(if rows.is_empty() { "No agents or terminals are running on this box.".into() } else { rows.join("\n") }))
}

fn agent_id(args: &Value) -> Result<u32, String> {
    args.get("agent").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
        .map(|v| v as u32).ok_or_else(|| "Give the agent's id from list_agents.".to_string())
}

fn read_agent_output(args: &Value) -> Result<Value, String> {
    let state = server().get().ok_or("The box server is still starting.")?;
    let id = agent_id(args)?;
    let sess = state.pty.get(id).ok_or(format!("No agent with id {id}. Call list_agents."))?;
    let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(80).clamp(1, MAX_READ_LINES as u64) as usize;
    let text = plain_text(&sess.output_tail(256 * 1024));
    let all: Vec<&str> = text.lines().collect();
    let tail = all[all.len().saturating_sub(lines)..].join("\n");
    Ok(text_content(if tail.trim().is_empty() { "(No output yet.)".to_string() } else { tail }))
}

fn send_to_agent(args: &Value) -> Result<Value, String> {
    let state = server().get().ok_or("The box server is still starting.")?;
    let id = agent_id(args)?;
    let message = args.get("message").and_then(|v| v.as_str()).ok_or("Give the message to send.")?;
    if message.len() > MAX_TYPE_CHARS {
        return Err(format!("Keep the message under {MAX_TYPE_CHARS} characters."));
    }
    let sess = state.pty.get(id).ok_or(format!("No agent with id {id}. Call list_agents."))?;
    if sess.has_exited() {
        return Err(format!("Agent {id} has exited."));
    }
    sess.write(message)?;
    if args.get("submit").and_then(|v| v.as_bool()).unwrap_or(true) {
        // A moment between the text and Enter, so a TUI does not read them as one paste.
        std::thread::sleep(Duration::from_millis(80));
        sess.write("\r")?;
    }
    Ok(text_content(format!("Sent to agent {id}.")))
}

// ── virtual desktop ─────────────────────────────────────────────────────────

struct Desktop {
    display: String,
    _xvfb: Option<std::process::Child>,
}

fn desktop() -> &'static Mutex<Option<Desktop>> {
    static DESKTOP: OnceLock<Mutex<Option<Desktop>>> = OnceLock::new();
    DESKTOP.get_or_init(|| Mutex::new(None))
}

fn have(program: &str) -> bool {
    Command::new("sh").arg("-c").arg(format!("command -v {program} >/dev/null 2>&1")).status().map(|s| s.success()).unwrap_or(false)
}

/// The display the desktop tools act on, starting a virtual one if needed.
fn display() -> Result<String, String> {
    if let Ok(existing) = std::env::var("SPACRON_BOX_DISPLAY") {
        if !existing.trim().is_empty() {
            return Ok(existing.trim().to_string());
        }
    }
    let mut guard = desktop().lock().map_err(|_| "desktop state poisoned")?;
    if let Some(d) = guard.as_ref() {
        if std::path::Path::new(&format!("/tmp/.X11-unix/X{}", &d.display[1..])).exists() {
            return Ok(d.display.clone());
        }
    }
    // Reuse the desktop a previous run of this server started, so a restart
    // does not leave one virtual desktop behind each time.
    let remembered = server().get().map(|st| st.workspace.join(".spacron").join("desktop-display"));
    if let Some(saved) = remembered.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) {
        let saved = saved.trim().to_string();
        if saved.starts_with(':') && saved[1..].chars().all(|c| c.is_ascii_digit()) && std::path::Path::new(&format!("/tmp/.X11-unix/X{}", &saved[1..])).exists() {
            *guard = Some(Desktop { display: saved.clone(), _xvfb: None });
            return Ok(saved);
        }
    }
    if !have("Xvfb") {
        return Err("The virtual desktop needs Xvfb on the box. Install it once: sudo apt-get install -y xvfb xdotool imagemagick".into());
    }
    let num = (90..140).find(|n| !std::path::Path::new(&format!("/tmp/.X{n}-lock")).exists() && !std::path::Path::new(&format!("/tmp/.X11-unix/X{n}")).exists())
        .ok_or("No free display number for the virtual desktop.")?;
    let display = format!(":{num}");
    let child = Command::new("Xvfb").args([display.as_str(), "-screen", "0", SCREEN, "-nolisten", "tcp"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        .map_err(|e| format!("Could not start the virtual desktop: {e}"))?;
    let socket = format!("/tmp/.X11-unix/X{num}");
    for _ in 0..50 {
        if std::path::Path::new(&socket).exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !std::path::Path::new(&socket).exists() {
        return Err("The virtual desktop did not start.".into());
    }
    // A window manager gives windows focus and borders; optional.
    for wm in ["openbox", "fluxbox", "xfwm4", "matchbox-window-manager"] {
        if have(wm) {
            let _ = Command::new(wm).env("DISPLAY", &display).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
            break;
        }
    }
    if let Some(path) = remembered {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")));
        let _ = std::fs::write(path, &display);
    }
    *guard = Some(Desktop { display: display.clone(), _xvfb: Some(child) });
    Ok(display)
}

fn xdotool(display: &str, args: &[&str]) -> Result<String, String> {
    if !have("xdotool") {
        return Err("The desktop tools need xdotool on the box. Install it once: sudo apt-get install -y xdotool".into());
    }
    let out = Command::new("xdotool").args(args).env("DISPLAY", display).output().map_err(|e| format!("xdotool failed: {e}"))?;
    if !out.status.success() {
        return Err(format!("xdotool failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn screen_size(display: &str) -> Result<(f64, f64), String> {
    let out = xdotool(display, &["getdisplaygeometry"])?;
    let mut parts = out.split_whitespace().filter_map(|p| p.parse::<f64>().ok());
    Ok((parts.next().ok_or("Unknown screen size.")?, parts.next().ok_or("Unknown screen size.")?))
}

fn screenshot() -> Result<Value, String> {
    let display = display()?;
    if !have("import") {
        return Err("Screenshots need ImageMagick on the box. Install it once: sudo apt-get install -y imagemagick".into());
    }
    let out = Command::new("import").args(["-display", &display, "-window", "root", "png:-"]).output()
        .map_err(|e| format!("Could not take a screenshot: {e}"))?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err(format!("Could not take a screenshot: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let (w, h) = screen_size(&display).unwrap_or((0.0, 0.0));
    Ok(json!({ "content": [
        { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(&out.stdout), "mimeType": "image/png" },
        { "type": "text", "text": format!("Virtual desktop {display}, {w}x{h}. Click with x and y as fractions of this screen.") },
    ], "isError": false }))
}

fn list_windows() -> Result<Value, String> {
    let display = display()?;
    let ids = xdotool(&display, &["search", "--onlyvisible", "--name", "."]).unwrap_or_default();
    let mut rows = Vec::new();
    for id in ids.split_whitespace() {
        let name = xdotool(&display, &["getwindowname", id]).unwrap_or_default();
        if !name.trim().is_empty() {
            rows.push(format!("- {}: {}", id, name.trim()));
        }
    }
    Ok(text_content(if rows.is_empty() { "No windows are open on the virtual desktop.".into() } else { rows.join("\n") }))
}

fn fraction(args: &Value, key: &str) -> Result<f64, String> {
    let v = args.get(key).and_then(|v| v.as_f64()).ok_or(format!("Give {key} as a fraction from 0 to 1."))?;
    if !(0.0..=1.0).contains(&v) {
        return Err(format!("{key} must be between 0 and 1."));
    }
    Ok(v)
}

fn click(args: &Value) -> Result<Value, String> {
    let (x, y) = (fraction(args, "x")?, fraction(args, "y")?);
    let display = display()?;
    let (w, h) = screen_size(&display)?;
    let (px, py) = (((w - 1.0) * x).round().to_string(), ((h - 1.0) * y).round().to_string());
    let button = match args.get("button").and_then(|b| b.as_str()).unwrap_or("left") { "middle" => "2", "right" => "3", _ => "1" };
    let mut cmd = vec!["mousemove", px.as_str(), py.as_str(), "click"];
    if args.get("double").and_then(|d| d.as_bool()).unwrap_or(false) {
        cmd.extend(["--repeat", "2"]);
    }
    cmd.push(button);
    xdotool(&display, &cmd)?;
    Ok(text_content(format!("Clicked at {px},{py}.")))
}

fn type_text(args: &Value) -> Result<Value, String> {
    let text = args.get("text").and_then(|t| t.as_str()).ok_or("Give the text to type.")?;
    if text.chars().count() > MAX_TYPE_CHARS {
        return Err(format!("Type at most {MAX_TYPE_CHARS} characters at a time."));
    }
    let display = display()?;
    xdotool(&display, &["type", "--delay", "8", "--", text])?;
    Ok(text_content(format!("Typed {} characters.", text.chars().count())))
}

fn press_keys(args: &Value) -> Result<Value, String> {
    let keys = args.get("keys").and_then(|k| k.as_str()).ok_or("Give the keys to press.")?;
    if keys.trim().is_empty() || !keys.chars().all(|c| c.is_ascii_alphanumeric() || " +_-".contains(c)) {
        return Err("Keys are names like Return, Tab, ctrl+l, separated by spaces.".into());
    }
    let display = display()?;
    let mut cmd = vec!["key", "--"];
    cmd.extend(keys.split_whitespace());
    xdotool(&display, &cmd)?;
    Ok(text_content(format!("Pressed {keys}.")))
}

fn scroll(args: &Value) -> Result<Value, String> {
    let dy = args.get("dy").and_then(|v| v.as_i64()).ok_or("Give dy.")?;
    let display = display()?;
    let steps = dy.unsigned_abs().clamp(1, 20).to_string();
    xdotool(&display, &["click", "--repeat", &steps, if dy > 0 { "5" } else { "4" }])?;
    Ok(text_content(format!("Scrolled {}.", if dy > 0 { "down" } else { "up" })))
}

fn launch(args: &Value) -> Result<Value, String> {
    let command = args.get("command").and_then(|c| c.as_str()).map(str::trim).filter(|c| !c.is_empty()).ok_or("Give the program to start.")?;
    let display = display()?;
    let workspace = server().get().map(|s| s.workspace.clone()).unwrap_or_else(std::env::temp_dir);
    let child = Command::new("sh").arg("-c").arg(command).env("DISPLAY", &display).current_dir(workspace)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        .map_err(|e| format!("Could not start it: {e}"))?;
    Ok(text_content(format!("Started (pid {}). Take a screenshot in a moment to see it.", child.id())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_output_becomes_plain_text() {
        let raw = b"\x1b[32mgreen\x1b[0m line\r\nprogress 10%\rprogress 100%\r\n\x1b]0;title\x07done\n";
        assert_eq!(plain_text(raw), "green line\nprogress 100%\ndone\n");
    }

    #[tokio::test]
    async fn it_speaks_mcp() {
        let init = respond(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(init["result"]["serverInfo"]["name"], "spacron-box");
        assert!(respond(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
        let list = respond(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.unwrap();
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"list_agents") && names.contains(&"desktop_screenshot") && names.contains(&"desktop_launch"));
        let missing = respond(&json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" })).await.unwrap();
        assert_eq!(missing["error"]["code"], -32601);
    }

    #[test]
    fn key_names_are_checked_before_reaching_xdotool() {
        for bad in ["", "ctrl+l; rm -rf /", "$(whoami)", "a\nb"] {
            assert!(press_keys(&json!({ "keys": bad })).is_err(), "{bad:?}");
        }
        assert!(click(&json!({ "x": 1.5, "y": 0.2 })).is_err());
    }
}
