//! Computer use: letting agents see — and, from phase 2, operate — the user's
//! desktop windows. Design and threat model: docs/computer-use.md.
//!
//! Phase 1 is read-only: list windows, read a window's UI Automation tree, find
//! elements in it, and capture it. Even that is gated twice, because a window
//! list and a screenshot can carry anything the user has open:
//!
//! 1. A global switch (`Allow computer use`, off by default). While it is off
//!    the tools are not even listed, so an agent cannot ask for them.
//! 2. A per-agent grant, asked for in a dialog the first time an agent wants to
//!    see the window list or a particular window. Grants live in memory, end
//!    with the agent's session, and bind to the exact window (handle, process
//!    id and image path), so a new window from the same app asks again.
//!
//! Windows only for now. On other platforms `supported()` is false, the tools
//! are never listed, and every entry point here returns an explanation.

#[cfg(windows)]
mod win;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct WindowInfo {
    /// Stable for the window's lifetime; the handle, as a decimal string.
    pub id: String,
    pub title: String,
    /// Image file name, e.g. `notepad.exe`.
    pub process: String,
    /// Full image path. Part of a grant's identity; not shown to agents.
    #[serde(skip)]
    pub process_path: String,
    #[serde(skip)]
    pub pid: u32,
    /// Window frame in physical screen pixels.
    pub bounds: Bounds,
    pub focused: bool,
    pub minimized: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct TreeLimits {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub time_budget_ms: u64,
}

/// What `desktop_ui_tree` walks by default. Enough for a dialog or a normal app
/// window; a browser page or an IDE will hit a bound and say so.
const TREE_LIMITS: TreeLimits = TreeLimits { max_depth: 12, max_nodes: 600, time_budget_ms: 8_000 };
/// `desktop_find` searches deeper, since it prints only the matches.
const FIND_LIMITS: TreeLimits = TreeLimits { max_depth: 40, max_nodes: 5_000, time_budget_ms: 12_000 };
const MAX_TREE_DEPTH_ARG: usize = 40;
const MAX_FIND_RESULTS: usize = 40;

/// Longest side of a screenshot we hand to a model. Larger images are
/// downscaled rather than refused: vision models resize anyway, and a 4K frame
/// as base64 is megabytes of tool result.
const MAX_SCREENSHOT_SIDE: u32 = 1568;

/// How long a tool call waits for the user to answer a grant dialog.
const GRANT_TIMEOUT: Duration = Duration::from_secs(120);

pub fn supported() -> bool {
    cfg!(windows)
}

fn unsupported() -> String {
    "Computer use is only available on Windows in this version of Spacron.".to_string()
}

/// Run blocking, COM-bound platform work off the async runtime.
#[cfg_attr(not(windows), allow(dead_code))]
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Computer-use worker failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/// What a grant is for.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Subject {
    /// The titles, processes and positions of every open window.
    WindowList,
    /// One window, pinned to the process that owns it. A recycled handle in a
    /// different process is a different subject.
    Window { id: String, pid: u32, process_path: String },
}

#[derive(Default)]
struct SessionGrants {
    allowed: Vec<Subject>,
    /// Remembered so a declined agent cannot re-raise the same dialog in a loop.
    denied: Vec<Subject>,
}

/// Sent to the frontend, which shows the dialog and answers through
/// `mcp_desktop_grant_respond`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    pub request_id: String,
    pub session_id: u32,
    /// The agent's registered name, when it has one.
    pub agent_name: Option<String>,
    /// `"window_list"` or `"window"`.
    pub kind: &'static str,
    pub window_title: Option<String>,
    pub process: Option<String>,
    /// The agent's own explanation. Untrusted text; the dialog shows it quoted.
    pub reason: String,
}

pub type GrantEmitFn = Arc<dyn Fn(&GrantRequest) + Send + Sync>;

/// Computer-use state shared by the MCP server and the app's commands.
pub struct DesktopState {
    enabled: AtomicBool,
    grants: Mutex<HashMap<u32, SessionGrants>>,
    pending: DashMap<String, oneshot::Sender<bool>>,
    emit: GrantEmitFn,
}

impl DesktopState {
    pub fn new(emit: GrantEmitFn) -> Self {
        Self {
            enabled: AtomicBool::new(false),
            grants: Mutex::new(HashMap::new()),
            pending: DashMap::new(),
            emit,
        }
    }

    /// Whether the tools should be listed at all.
    pub fn available(&self) -> bool {
        supported() && self.enabled.load(Ordering::SeqCst)
    }

    /// The user's global switch. Turning it off withdraws every grant and
    /// declines every open dialog, so "off" means off immediately.
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
        if !on {
            if let Ok(mut g) = self.grants.lock() {
                g.clear();
            }
            let ids: Vec<String> = self.pending.iter().map(|e| e.key().clone()).collect();
            for id in ids {
                self.respond(&id, false);
            }
        }
    }

    /// Drop everything granted to a session that has ended.
    pub fn forget_session(&self, session_id: u32) {
        if let Ok(mut g) = self.grants.lock() {
            g.remove(&session_id);
        }
    }

    /// The user's answer to a grant dialog.
    pub fn respond(&self, request_id: &str, allow: bool) {
        if let Some((_, tx)) = self.pending.remove(request_id) {
            let _ = tx.send(allow);
        }
    }

    fn lookup(&self, session_id: u32, subject: &Subject) -> Option<bool> {
        let g = self.grants.lock().ok()?;
        let s = g.get(&session_id)?;
        if s.allowed.contains(subject) {
            Some(true)
        } else if s.denied.contains(subject) {
            Some(false)
        } else {
            None
        }
    }

    fn record(&self, session_id: u32, subject: Subject, allow: bool) {
        if let Ok(mut g) = self.grants.lock() {
            let s = g.entry(session_id).or_default();
            if allow {
                s.allowed.push(subject);
            } else {
                s.denied.push(subject);
            }
        }
    }

    /// Succeed if the session may see `subject`, asking the user if it has not
    /// been decided yet. Blocks for up to [`GRANT_TIMEOUT`].
    async fn ensure(
        &self,
        caller: &DesktopCaller,
        subject: Subject,
        window: Option<&WindowInfo>,
        reason: &str,
    ) -> Result<(), String> {
        match self.lookup(caller.session_id, &subject) {
            Some(true) => return Ok(()),
            Some(false) => return Err(declined(&subject)),
            None => {}
        }

        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(request_id.clone(), tx);
        (self.emit)(&GrantRequest {
            request_id: request_id.clone(),
            session_id: caller.session_id,
            agent_name: caller.agent_name.clone(),
            kind: match subject {
                Subject::WindowList => "window_list",
                Subject::Window { .. } => "window",
            },
            window_title: window.map(|w| w.title.clone()),
            process: window.map(|w| w.process.clone()),
            reason: reason.chars().take(300).collect(),
        });

        match tokio::time::timeout(GRANT_TIMEOUT, rx).await {
            Ok(Ok(allow)) => {
                // The switch may have been turned off while the dialog was up;
                // that path answers `false`, but check anyway so a late `true`
                // cannot slip through after "off".
                let allow = allow && self.enabled.load(Ordering::SeqCst);
                self.record(caller.session_id, subject.clone(), allow);
                if allow {
                    Ok(())
                } else {
                    Err(declined(&subject))
                }
            }
            _ => {
                self.pending.remove(&request_id);
                Err("The user did not answer the permission request within 2 minutes. \
                     Ask them in your reply before trying again."
                    .to_string())
            }
        }
    }
}

fn declined(subject: &Subject) -> String {
    match subject {
        Subject::WindowList => {
            "The user declined to let you see their open windows. Do not ask again this session."
        }
        Subject::Window { .. } => {
            "The user declined to let you see this window. Do not ask again this session."
        }
    }
    .to_string()
}

/// The identified agent a call comes from. Computer use refuses anonymous
/// callers outright: a grant has to belong to someone.
pub struct DesktopCaller {
    pub session_id: u32,
    pub agent_name: Option<String>,
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

fn common_props() -> serde_json::Value {
    serde_json::json!({
        "reason": {
            "type": "string",
            "description": "One sentence, shown to the user when they are asked to allow this: why you need to see it."
        },
        "agent_token": {
            "type": "string",
            "description": "Your SPACRON_AGENT_TOKEN environment variable. Computer use has to know which agent is asking; pass it unless your MCP connection already identifies you."
        }
    })
}

fn with_props(extra: serde_json::Value) -> serde_json::Value {
    let mut props = common_props();
    if let (Some(p), Some(e)) = (props.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            p.insert(k.clone(), v.clone());
        }
    }
    props
}

/// The computer-use tools, for `tools/list`. Only listed while
/// [`DesktopState::available`].
pub fn mcp_tools() -> Vec<serde_json::Value> {
    let window_prop = serde_json::json!({
        "window": { "type": "string", "description": "Window id from desktop_list_windows." }
    });
    vec![
        serde_json::json!({
            "name": "desktop_list_windows",
            "description": "List the user's open desktop windows: id, title, process, position and size (physical pixels), and whether each is focused or minimised. The user is asked to allow this the first time. Read-only: this version of Spacron can look at windows but not click or type in them.",
            "inputSchema": { "type": "object", "properties": common_props() }
        }),
        serde_json::json!({
            "name": "desktop_ui_tree",
            "description": "Read one window's UI Automation tree as indented text: role, name, value and state of each control, with its centre as normalized 0-1 coordinates within the window (@x,y). This is the reliable way to learn what is on screen. Password values are never returned. Long trees are cut off with a note; use desktop_find to search instead. The user is asked to allow each window the first time.",
            "inputSchema": {
                "type": "object",
                "properties": with_props(serde_json::json!({
                    "window": window_prop["window"],
                    "depth": { "type": "integer", "description": "How many levels to descend (default 12, max 40)." }
                })),
                "required": ["window"]
            }
        }),
        serde_json::json!({
            "name": "desktop_find",
            "description": "Search one window's UI Automation tree for controls whose name, value or automation id contains `query` (case-insensitive), optionally only of one `role` (Button, Edit, MenuItem, …). Returns each match with its path from the window. The user is asked to allow each window the first time.",
            "inputSchema": {
                "type": "object",
                "properties": with_props(serde_json::json!({
                    "window": window_prop["window"],
                    "query": { "type": "string", "description": "Text to look for." },
                    "role": { "type": "string", "description": "Only controls of this role." }
                })),
                "required": ["window"]
            }
        }),
        serde_json::json!({
            "name": "desktop_screenshot",
            "description": "Capture one window's own pixels as a PNG (other windows lying on top are not included). Large windows are downscaled to at most 1568 px on the long side. The user is asked to allow each window the first time.",
            "inputSchema": {
                "type": "object",
                "properties": with_props(window_prop),
                "required": ["window"]
            }
        }),
    ]
}

pub fn is_desktop_tool(name: &str) -> bool {
    matches!(name, "desktop_list_windows" | "desktop_ui_tree" | "desktop_find" | "desktop_screenshot")
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

fn text(t: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "content": [{ "type": "text", "text": t.into() }] })
}

fn str_arg<'a>(args: Option<&'a serde_json::Map<String, serde_json::Value>>, key: &str) -> Option<&'a str> {
    args.and_then(|a| a.get(key)).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

/// Run one computer-use tool for an identified caller. Returns the MCP
/// `result` object (`{ content: [...] }`) or an error message.
pub async fn call_tool(
    state: &DesktopState,
    caller: DesktopCaller,
    name: &str,
    args: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    if !supported() {
        return Err(unsupported());
    }
    if !state.enabled.load(Ordering::SeqCst) {
        return Err("Computer use is turned off. The user can enable it in Settings → Agents → Computer use.".into());
    }
    let reason = str_arg(args, "reason").unwrap_or("(no reason given)").to_string();

    if name == "desktop_list_windows" {
        state.ensure(&caller, Subject::WindowList, None, &reason).await?;
        let windows = list_windows().await?;
        return Ok(text(format_window_list(&windows)));
    }

    let window_id = str_arg(args, "window")
        .ok_or_else(|| format!("{name} needs 'window' — an id from desktop_list_windows."))?
        .to_string();
    let info = window(window_id.clone()).await?;
    let subject = Subject::Window {
        id: info.id.clone(),
        pid: info.pid,
        process_path: info.process_path.clone(),
    };
    state.ensure(&caller, subject, Some(&info), &reason).await?;

    match name {
        "desktop_ui_tree" => {
            let depth = args
                .and_then(|a| a.get("depth"))
                .and_then(|v| v.as_u64())
                .map(|d| (d as usize).clamp(1, MAX_TREE_DEPTH_ARG))
                .unwrap_or(TREE_LIMITS.max_depth);
            let limits = TreeLimits { max_depth: depth, ..TREE_LIMITS };
            let (info, nodes, truncated) = walk(window_id, limits).await?;
            Ok(text(format_tree(&info, &nodes, truncated)))
        }
        "desktop_find" => {
            let query = str_arg(args, "query").map(str::to_lowercase);
            let role = str_arg(args, "role").map(str::to_lowercase);
            if query.is_none() && role.is_none() {
                return Err("desktop_find needs a 'query', a 'role', or both.".into());
            }
            let (info, nodes, truncated) = walk(window_id, FIND_LIMITS).await?;
            Ok(text(format_find(&info, &nodes, truncated, query.as_deref(), role.as_deref())))
        }
        "desktop_screenshot" => screenshot(window_id).await,
        other => Err(format!("Unknown computer-use tool: '{other}'")),
    }
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

#[cfg(windows)]
async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    blocking(win::list_windows).await
}

#[cfg(windows)]
async fn window(id: String) -> Result<WindowInfo, String> {
    blocking(move || win::window(&id)).await
}

#[cfg(windows)]
async fn walk(id: String, limits: TreeLimits) -> Result<(WindowInfo, Vec<Node>, bool), String> {
    blocking(move || win::walk(&id, limits)).await
}

#[cfg(windows)]
async fn screenshot(id: String) -> Result<serde_json::Value, String> {
    blocking(move || {
        let (info, img) = win::capture(&id)?;
        encode_screenshot(&info, img)
    })
    .await
}

#[cfg(windows)]
use win::Node;

/// Only built by the Windows backend (and tests); the formatters read it everywhere.
#[cfg(not(windows))]
#[allow(dead_code)]
pub struct Node {
    pub depth: usize,
    pub role: &'static str,
    pub name: String,
    pub value: Option<String>,
    pub automation_id: String,
    pub enabled: bool,
    pub focused: bool,
    pub offscreen: bool,
    pub at: Option<(f64, f64)>,
}

#[cfg(not(windows))]
async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    Err(unsupported())
}

#[cfg(not(windows))]
async fn window(_id: String) -> Result<WindowInfo, String> {
    Err(unsupported())
}

#[cfg(not(windows))]
async fn walk(_id: String, _limits: TreeLimits) -> Result<(WindowInfo, Vec<Node>, bool), String> {
    Err(unsupported())
}

#[cfg(not(windows))]
async fn screenshot(_id: String) -> Result<serde_json::Value, String> {
    Err(unsupported())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn encode_screenshot(info: &WindowInfo, img: image::RgbaImage) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    let img = if longest > MAX_SCREENSHOT_SIDE {
        let scale = MAX_SCREENSHOT_SIDE as f64 / longest as f64;
        let nw = ((w as f64 * scale).round() as u32).max(1);
        let nh = ((h as f64 * scale).round() as u32).max(1);
        image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;
    let note = format!(
        "Screenshot of window {} \"{}\" ({}): {}x{} px{}.",
        info.id,
        info.title,
        info.process,
        img.width(),
        img.height(),
        if img.width() != w { format!(", downscaled from {w}x{h}") } else { String::new() }
    );
    Ok(serde_json::json!({
        "content": [
            { "type": "text", "text": note },
            {
                "type": "image",
                "data": base64::engine::general_purpose::STANDARD.encode(&png),
                "mimeType": "image/png"
            }
        ]
    }))
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

fn format_window_list(windows: &[WindowInfo]) -> String {
    if windows.is_empty() {
        return "No windows are available to agents.".into();
    }
    let mut out = format!("{} windows (Spacron and protected apps are not listed):\n", windows.len());
    for w in windows {
        let mut flags = Vec::new();
        if w.focused {
            flags.push("focused");
        }
        if w.minimized {
            flags.push("minimised");
        }
        out.push_str(&format!(
            "- id {} · \"{}\" · {} · {}x{} at {},{}{}\n",
            w.id,
            w.title,
            w.process,
            w.bounds.width,
            w.bounds.height,
            w.bounds.x,
            w.bounds.y,
            if flags.is_empty() { String::new() } else { format!(" · {}", flags.join(", ")) }
        ));
    }
    out
}

fn describe_node(n: &Node) -> String {
    let mut line = format!("{} \"{}\"", n.role, n.name.replace('"', "'"));
    if let Some(v) = &n.value {
        line.push_str(&format!(" value=\"{}\"", v.replace('"', "'")));
    }
    if !n.automation_id.is_empty() && n.automation_id.chars().count() <= 60 {
        line.push_str(&format!(" #{}", n.automation_id));
    }
    let mut flags = Vec::new();
    if !n.enabled {
        flags.push("disabled");
    }
    if n.focused {
        flags.push("focused");
    }
    if n.offscreen {
        flags.push("offscreen");
    }
    if !flags.is_empty() {
        line.push_str(&format!(" [{}]", flags.join(", ")));
    }
    if let (Some((x, y)), false) = (n.at, n.offscreen) {
        line.push_str(&format!(" @{x:.3},{y:.3}"));
    }
    line
}

fn format_tree(info: &WindowInfo, nodes: &[Node], truncated: bool) -> String {
    let mut out = format!(
        "UI tree of window {} \"{}\" ({}), {} elements:\n",
        info.id,
        info.title,
        info.process,
        nodes.len()
    );
    for n in nodes {
        out.push_str(&"  ".repeat(n.depth));
        out.push_str(&describe_node(n));
        out.push('\n');
    }
    if truncated {
        out.push_str("… cut off at a depth, size or time limit. Use desktop_find to search the rest.\n");
    }
    out
}

fn format_find(
    info: &WindowInfo,
    nodes: &[Node],
    truncated: bool,
    query: Option<&str>,
    role: Option<&str>,
) -> String {
    let mut path: Vec<String> = Vec::new();
    let mut hits = Vec::new();
    let mut total = 0usize;
    for n in nodes {
        path.truncate(n.depth);
        let role_ok = role.map(|r| n.role.eq_ignore_ascii_case(r)).unwrap_or(true);
        let query_ok = query
            .map(|q| {
                n.name.to_lowercase().contains(q)
                    || n.value.as_deref().map(|v| v.to_lowercase().contains(q)).unwrap_or(false)
                    || n.automation_id.to_lowercase().contains(q)
            })
            .unwrap_or(true);
        if role_ok && query_ok && n.depth > 0 {
            total += 1;
            if hits.len() < MAX_FIND_RESULTS {
                let trail = if path.len() > 1 { format!("{} > ", path[1..].join(" > ")) } else { String::new() };
                hits.push(format!("- {trail}{}", describe_node(n)));
            }
        }
        let label = if n.name.is_empty() { n.role.to_string() } else { format!("{} \"{}\"", n.role, n.name) };
        path.push(label);
    }
    let mut out = format!(
        "{} match{} in window {} \"{}\" ({} elements searched):\n",
        total,
        if total == 1 { "" } else { "es" },
        info.id,
        info.title,
        nodes.len()
    );
    for h in &hits {
        out.push_str(h);
        out.push('\n');
    }
    if total > hits.len() {
        out.push_str(&format!("… and {} more. Narrow the query or add a role.\n", total - hits.len()));
    }
    if truncated {
        out.push_str("The search stopped at a size or time limit, so there may be more.\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller() -> DesktopCaller {
        DesktopCaller { session_id: 7, agent_name: Some("Iris".into()) }
    }

    fn state_with(answer: Option<bool>) -> Arc<DesktopState> {
        let slot: Arc<Mutex<Option<Arc<DesktopState>>>> = Arc::new(Mutex::new(None));
        let slot2 = slot.clone();
        let state = Arc::new(DesktopState::new(Arc::new(move |req: &GrantRequest| {
            if let (Some(allow), Some(s)) = (answer, slot2.lock().unwrap().clone()) {
                s.respond(&req.request_id, allow);
            }
        })));
        *slot.lock().unwrap() = Some(state.clone());
        state.set_enabled(true);
        state
    }

    #[tokio::test]
    async fn a_granted_subject_is_not_asked_again() {
        let state = state_with(Some(true));
        state.ensure(&caller(), Subject::WindowList, None, "r").await.unwrap();
        // A second ask would need an answer; lookup must short-circuit instead.
        assert_eq!(state.lookup(7, &Subject::WindowList), Some(true));
        state.ensure(&caller(), Subject::WindowList, None, "r").await.unwrap();
    }

    #[tokio::test]
    async fn a_declined_subject_stays_declined_without_a_new_dialog() {
        let state = state_with(Some(false));
        assert!(state.ensure(&caller(), Subject::WindowList, None, "r").await.is_err());
        assert_eq!(state.lookup(7, &Subject::WindowList), Some(false));
    }

    #[tokio::test]
    async fn grants_are_per_session_and_per_window_identity() {
        let state = state_with(Some(true));
        let a = Subject::Window { id: "1".into(), pid: 10, process_path: "C:\\a.exe".into() };
        state.ensure(&caller(), a.clone(), None, "r").await.unwrap();
        assert_eq!(state.lookup(8, &a), None, "another session must ask for itself");
        let recycled = Subject::Window { id: "1".into(), pid: 11, process_path: "C:\\b.exe".into() };
        assert_eq!(state.lookup(7, &recycled), None, "a reused handle in another process is a new window");
    }

    #[tokio::test]
    async fn turning_off_withdraws_grants_and_declines_open_dialogs() {
        let state = state_with(None);
        state.record(7, Subject::WindowList, true);
        let s2 = state.clone();
        let waiting = tokio::spawn(async move {
            let w = Subject::Window { id: "5".into(), pid: 1, process_path: "x".into() };
            s2.ensure(&caller(), w, None, "r").await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        state.set_enabled(false);
        assert!(waiting.await.unwrap().is_err());
        assert_eq!(state.lookup(7, &Subject::WindowList), None);
    }

    #[tokio::test]
    async fn ending_a_session_forgets_its_grants() {
        let state = state_with(Some(true));
        state.ensure(&caller(), Subject::WindowList, None, "r").await.unwrap();
        state.forget_session(7);
        assert_eq!(state.lookup(7, &Subject::WindowList), None);
    }

    #[test]
    fn find_reports_the_path_to_each_match() {
        let node = |depth, role, name: &str| Node {
            depth,
            role,
            name: name.into(),
            value: None,
            automation_id: String::new(),
            enabled: true,
            focused: false,
            offscreen: false,
            at: Some((0.5, 0.5)),
        };
        let info = WindowInfo {
            id: "1".into(),
            title: "T".into(),
            process: "p.exe".into(),
            process_path: String::new(),
            pid: 1,
            bounds: Bounds { x: 0, y: 0, width: 10, height: 10 },
            focused: false,
            minimized: false,
        };
        let nodes = vec![
            node(0, "Window", "T"),
            node(1, "Pane", "Toolbar"),
            node(2, "Button", "Save"),
            node(1, "Button", "Save as"),
        ];
        let out = format_find(&info, &nodes, false, Some("save"), Some("button"));
        assert!(out.starts_with("2 matches"), "{out}");
        assert!(out.contains("- Pane \"Toolbar\" > Button \"Save\""), "{out}");
        assert!(out.contains("- Button \"Save as\""), "{out}");
    }

    /// Drives the real Windows backend against whatever is open on this
    /// machine. Opt-in (`cargo test --lib desktop -- --ignored`): it needs a
    /// desktop session, and prints counts only — never titles or contents.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn real_backend_lists_walks_and_captures() {
        let windows = list_windows().await.expect("list");
        assert!(!windows.is_empty(), "no windows visible to agents");
        assert!(
            windows.iter().all(|w| w.pid != std::process::id() && !w.process.eq_ignore_ascii_case("spacron.exe")),
            "Spacron's own windows must be filtered"
        );
        // SPACRON_TEST_LARGEST=1 picks the biggest restored window, to exercise
        // the tree limits on something heavier than a dialog.
        let mut restored: Vec<&WindowInfo> = windows.iter().filter(|w| !w.minimized).collect();
        if std::env::var_os("SPACRON_TEST_LARGEST").is_some() {
            restored.sort_by_key(|w| std::cmp::Reverse(w.bounds.width * w.bounds.height));
        }
        // SPACRON_TEST_PROCESS=explorer.exe targets one app instead.
        if let Ok(p) = std::env::var("SPACRON_TEST_PROCESS") {
            restored.retain(|w| w.process.eq_ignore_ascii_case(&p));
        }
        let target = (*restored.first().expect("a restored window")).clone();
        let started = std::time::Instant::now();
        let (_, nodes, truncated) = walk(target.id.clone(), TREE_LIMITS).await.expect("walk");
        println!(
            "{} windows; walked {} elements of a {} window in {:?} (truncated: {truncated})",
            windows.len(),
            nodes.len(),
            target.process,
            started.elapsed()
        );
        assert!(!nodes.is_empty());
        assert!(nodes.iter().all(|n| n.value.as_deref() != Some("")));
        let shot = screenshot(target.id.clone()).await.expect("capture");
        assert_eq!(shot["content"][1]["mimeType"], "image/png");
    }

    #[test]
    fn tools_are_only_the_read_only_four() {
        let names: Vec<String> = mcp_tools()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["desktop_list_windows", "desktop_ui_tree", "desktop_find", "desktop_screenshot"]);
        assert!(names.iter().all(|n| is_desktop_tool(n)));
    }
}
