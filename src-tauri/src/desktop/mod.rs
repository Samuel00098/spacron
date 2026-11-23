//! Computer use: letting agents see and operate the user's desktop windows.
//! Design and threat model: docs/computer-use.md.
//!
//! Tools come in two kinds. **See** tools (list windows, read a window's UI
//! Automation tree, search it, capture it) and **act** tools (click, type,
//! press keys, scroll, drag, bring to front). Every call passes through:
//!
//! 1. A global switch (`Allow computer use`, off by default). While it is off
//!    the tools are not even listed, so an agent cannot ask for them.
//! 2. A grant, asked for in a dialog: the window list, seeing one window, or
//!    controlling one window (which includes seeing it). Grants live in memory,
//!    belong to one agent session or one chat turn, and bind to the exact
//!    window (handle, process id and image path).
//! 3. For acts: a rate limit, a pause while the user is using the mouse or
//!    keyboard, and a single app-wide input lease, so only one agent drives
//!    the machine at a time. While a lease is held an indicator frames the
//!    window, and Ctrl+Alt+Esc withdraws everything at once.
//! 4. The platform backend's own checks right before input is sent: the window
//!    is still the same process, it is in front, nothing else is on top of the
//!    click point, it is not elevated, and focus is not in a password field.
//!
//! Every act is written to an activity log. Windows only for now: elsewhere
//! `supported()` is false, the tools are never listed, and every entry point
//! returns an explanation.

#[cfg(windows)]
pub mod indicator;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix;
#[cfg(windows)]
mod win;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

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
#[cfg_attr(not(windows), allow(dead_code))] // the element tree (and its limits) is Windows-only for now
pub struct TreeLimits {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub time_budget_ms: u64,
}

/// Where a pointer action lands.
#[derive(Clone, Debug, PartialEq)]
pub enum Point {
    /// An element ref from the latest `desktop_ui_tree` (`e…`) or `desktop_find` (`f…`).
    Ref(String),
    /// Normalized 0–1 within the window frame.
    At(f64, f64),
    Centre,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

impl MouseButton {
    fn name(self) -> &'static str {
        match self {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
            MouseButton::Middle => "middle",
        }
    }
}

/// One act, already parsed and validated as far as that is possible without
/// touching the window.
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    Focus,
    Click { at: Point, button: MouseButton, double: bool },
    Type { at: Option<String>, text: String, replace: bool },
    Key { keys: String },
    Scroll { at: Point, dx: i32, dy: i32 },
    Drag { from: Point, to: Point },
}

/// What `desktop_ui_tree` walks by default. Enough for a dialog or a normal app
/// window; a browser page or an IDE will hit a bound and say so.
const TREE_LIMITS: TreeLimits = TreeLimits { max_depth: 12, max_nodes: 600, time_budget_ms: 8_000 };
/// `desktop_find` searches deeper, since it prints only the matches.
const FIND_LIMITS: TreeLimits = TreeLimits { max_depth: 40, max_nodes: 5_000, time_budget_ms: 12_000 };
const MAX_TREE_DEPTH_ARG: usize = 40;
const MAX_FIND_RESULTS: usize = 40;
const MAX_TYPE_CHARS: usize = 4_096;
const MAX_SCROLL_STEPS: i32 = 50;

/// Longest side of a screenshot we hand to a model. Larger images are
/// downscaled rather than refused: vision models resize anyway, and a 4K frame
/// as base64 is megabytes of tool result.
const MAX_SCREENSHOT_SIDE: u32 = 1568;

/// How long a tool call waits for the user to answer a grant dialog.
const GRANT_TIMEOUT: Duration = Duration::from_secs(120);

/// The input lease is released after this long without an act, so an agent
/// that stopped mid-task does not keep the indicator up and the others out.
const LEASE_IDLE: Duration = Duration::from_secs(30);

/// Acts per caller per second. Far above any honest use; low enough that a
/// runaway loop cannot outpace the user reaching for the stop shortcut.
const MAX_ACTS_PER_SECOND: usize = 10;

/// How recently the user must have touched the mouse or keyboard for an act to
/// wait for them, and how long it waits before giving up.
const USER_ACTIVE_MS: u64 = 1_500;
const USER_QUIET_WAIT: Duration = Duration::from_secs(5);

const ACTIVITY_KEEP: usize = 200;
const ACTIVITY_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub const STOP_SHORTCUT: &str = "Ctrl+Alt+Esc";

pub fn supported() -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        unix::supported()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        cfg!(windows)
    }
}

#[cfg_attr(any(windows, target_os = "macos", target_os = "linux"), allow(dead_code))]
fn unsupported() -> String {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        unix::unsupported_reason()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "Computer use is not available on this operating system.".to_string()
    }
}

/// Registers (`true`) or removes (`false`) the stop shortcut on macOS and
/// Linux, where it goes through Tauri's global-shortcut plugin (Windows uses
/// its own hook in `win.rs`). Set once by the app at startup; returns whether
/// it worked.
#[cfg_attr(windows, allow(dead_code))]
pub type StopShortcutFn = Arc<dyn Fn(bool) -> bool + Send + Sync>;
#[cfg_attr(windows, allow(dead_code))]
static STOP_SHORTCUT_FN: std::sync::OnceLock<StopShortcutFn> = std::sync::OnceLock::new();
#[cfg_attr(windows, allow(dead_code))]
static STOP_TARGET: std::sync::Mutex<Option<Weak<DesktopState>>> = std::sync::Mutex::new(None);

#[cfg_attr(windows, allow(dead_code))]
pub fn set_stop_shortcut_registrar(f: StopShortcutFn) {
    let _ = STOP_SHORTCUT_FN.set(f);
}

/// The stop shortcut was pressed (macOS and Linux).
#[cfg_attr(windows, allow(dead_code))]
pub fn stop_shortcut_pressed() {
    let target = STOP_TARGET.lock().ok().and_then(|t| t.as_ref().and_then(Weak::upgrade));
    if let Some(state) = target {
        if state.enabled.load(Ordering::SeqCst) {
            state.stop_by_shortcut();
        }
    }
}

/// Run blocking platform work off the async runtime.
#[cfg_attr(not(windows), allow(dead_code))]
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Computer-use worker failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Callers and grants
// ---------------------------------------------------------------------------

/// Who a grant belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum CallerKey {
    /// A CLI agent, by the PTY session its token proved.
    Session(u32),
    /// The in-app orchestrator, by chat conversation. Its grants end with the
    /// turn (see [`DesktopState::end_chat_turn`]).
    Chat(String),
}

impl CallerKey {
    fn as_string(&self) -> String {
        match self {
            CallerKey::Session(s) => format!("s:{s}"),
            CallerKey::Chat(c) => format!("c:{c}"),
        }
    }
}

/// The identified caller of a tool. Anonymous callers are refused before they
/// get here: a grant has to belong to something that can end.
pub struct DesktopCaller {
    pub key: CallerKey,
    pub agent_name: Option<String>,
}

impl DesktopCaller {
    fn display_name(&self) -> String {
        self.agent_name.clone().unwrap_or_else(|| match &self.key {
            CallerKey::Chat(_) => "Spacron chat".to_string(),
            CallerKey::Session(_) => "An agent".to_string(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowIdent {
    id: String,
    pid: u32,
    process_path: String,
}

impl WindowIdent {
    fn of(w: &WindowInfo) -> Self {
        Self { id: w.id.clone(), pid: w.pid, process_path: w.process_path.clone() }
    }
}

/// What a grant is for.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Subject {
    /// The titles, processes and positions of every open window.
    WindowList,
    /// Read one window. A recycled handle in another process is another window.
    See(WindowIdent),
    /// Click, type and press keys in one window. Implies `See`.
    Control(WindowIdent),
}

impl Subject {
    fn kind(&self) -> &'static str {
        match self {
            Subject::WindowList => "window_list",
            Subject::See(_) => "window",
            Subject::Control(_) => "control",
        }
    }
}

#[derive(Default)]
struct CallerGrants {
    name: String,
    allowed: Vec<(Subject, String)>,
    /// Remembered so a declined caller cannot re-raise the same dialog in a loop.
    denied: Vec<Subject>,
}

/// Sent to the frontend, which shows the dialog and answers through
/// `mcp_desktop_grant_respond`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    pub request_id: String,
    /// The CLI agent's session, when the caller is one.
    pub session_id: Option<u32>,
    /// The chat conversation, when the caller is the orchestrator.
    pub chat_id: Option<String>,
    /// The agent's registered name, when it has one.
    pub agent_name: Option<String>,
    /// `"window_list"`, `"window"` or `"control"`.
    pub kind: &'static str,
    pub window_title: Option<String>,
    pub process: Option<String>,
    /// The agent's own explanation. Untrusted text; the dialog shows it quoted.
    pub reason: String,
}

/// What the indicator over a controlled window shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Indicator {
    pub agent: String,
    pub window_title: String,
    pub bounds: Bounds,
    pub last_action: String,
    pub stop_shortcut: &'static str,
}

/// One logged act (or refused act).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub at_ms: u64,
    pub agent: String,
    pub tool: String,
    pub window: String,
    pub process: String,
    pub detail: String,
    pub ok: bool,
}

/// A grant as the Settings pane lists it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantSummary {
    /// Opaque; pass back to `revoke`.
    pub caller: String,
    pub agent: String,
    pub kind: &'static str,
    pub target: String,
}

type GrantFn = Arc<dyn Fn(&GrantRequest) + Send + Sync>;
type IndicatorFn = Arc<dyn Fn(Option<&Indicator>) + Send + Sync>;
type NoticeFn = Arc<dyn Fn(&str) + Send + Sync>;

/// How the desktop module reaches the app. Kept as callbacks so this module
/// (and the MCP server that owns it) do not depend on a Tauri handle.
#[derive(Clone)]
pub struct DesktopHooks {
    /// Ask the user for a grant.
    pub grant: GrantFn,
    /// Show (`Some`), move, or hide (`None`) the control indicator.
    pub indicator: IndicatorFn,
    /// A one-line message for the user (e.g. "stopped by the shortcut").
    pub notice: NoticeFn,
}

impl DesktopHooks {
    /// Hooks that do nothing; for tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn noop() -> Self {
        Self { grant: Arc::new(|_| {}), indicator: Arc::new(|_| {}), notice: Arc::new(|_| {}) }
    }
}

struct Lease {
    holder: CallerKey,
    holder_name: String,
    last_act: Instant,
}

/// Computer-use state shared by the MCP server and the app's commands.
pub struct DesktopState {
    me: Weak<DesktopState>,
    enabled: AtomicBool,
    grants: Mutex<HashMap<CallerKey, CallerGrants>>,
    pending: DashMap<String, oneshot::Sender<bool>>,
    lease: Mutex<Option<Lease>>,
    lease_watch: AtomicBool,
    recent_acts: Mutex<HashMap<CallerKey, VecDeque<Instant>>>,
    activity: Mutex<VecDeque<ActivityEntry>>,
    hooks: DesktopHooks,
}

impl DesktopState {
    pub fn new(hooks: DesktopHooks) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            enabled: AtomicBool::new(false),
            grants: Mutex::new(HashMap::new()),
            pending: DashMap::new(),
            lease: Mutex::new(None),
            lease_watch: AtomicBool::new(false),
            recent_acts: Mutex::new(HashMap::new()),
            activity: Mutex::new(VecDeque::new()),
            hooks,
        })
    }

    /// Whether the tools should be listed at all.
    pub fn available(&self) -> bool {
        supported() && self.enabled.load(Ordering::SeqCst)
    }

    /// The user's global switch. Turning it off withdraws every grant, releases
    /// the lease and declines every open dialog, so "off" means off at once.
    /// Turning it on starts the guard (stop shortcut + user-activity hooks).
    pub fn set_enabled(&self, on: bool) {
        let was = self.enabled.swap(on, Ordering::SeqCst);
        if on && !was {
            self.start_guard();
        }
        if !on {
            self.withdraw_everything();
            #[cfg(windows)]
            win::stop_guard();
            #[cfg(not(windows))]
            if was {
                if let Some(f) = STOP_SHORTCUT_FN.get() {
                    f(false);
                }
            }
        }
    }

    /// Turn on without the guard, for tests elsewhere in the crate: the guard
    /// installs a global shortcut and system-wide input hooks.
    #[cfg(test)]
    pub(crate) fn enable_for_test(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }

    #[cfg(windows)]
    fn start_guard(&self) {
        let me = self.me.clone();
        let registered = win::start_guard(Arc::new(move || {
            if let Some(state) = me.upgrade() {
                state.stop_by_shortcut();
            }
        }));
        if !registered {
            (self.hooks.notice)(&format!(
                "Computer use is on, but {STOP_SHORTCUT} could not be registered as the stop shortcut \
                 (another app may own it). Turn computer use off in Settings to stop an agent."
            ));
        }
    }

    #[cfg(not(windows))]
    fn start_guard(&self) {
        if let Ok(mut t) = STOP_TARGET.lock() {
            *t = Some(self.me.clone());
        }
        let registered = STOP_SHORTCUT_FN.get().is_some_and(|f| f(true));
        if !registered {
            (self.hooks.notice)(&format!(
                "Computer use is on, but {STOP_SHORTCUT} could not be registered as the stop shortcut \
                 (another app may own it). Turn computer use off in Settings to stop an agent."
            ));
        }
    }

    /// The stop shortcut: everything withdrawn, the switch stays on so the user
    /// can grant again deliberately.
    pub fn stop_by_shortcut(&self) {
        let had_lease = self.lease.lock().map(|l| l.is_some()).unwrap_or(false);
        self.withdraw_everything();
        (self.hooks.notice)(if had_lease {
            "Stopped. Every computer-use permission was withdrawn."
        } else {
            "Every computer-use permission was withdrawn."
        });
    }

    fn withdraw_everything(&self) {
        let callers: Vec<CallerKey> = self.grants.lock().map(|g| g.keys().cloned().collect()).unwrap_or_default();
        if let Ok(mut g) = self.grants.lock() {
            g.clear();
        }
        for c in callers {
            forget_refs(&c);
        }
        let ids: Vec<String> = self.pending.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.respond(&id, false);
        }
        self.release_lease();
    }

    /// Drop everything granted to a CLI session that has ended.
    pub fn forget_session(&self, session_id: u32) {
        self.forget_caller(&CallerKey::Session(session_id));
    }

    /// The orchestrator's grants last one turn; the store calls this when a
    /// turn ends (however it ends).
    pub fn end_chat_turn(&self, chat_id: &str) {
        self.forget_caller(&CallerKey::Chat(chat_id.to_string()));
    }

    fn forget_caller(&self, key: &CallerKey) {
        if let Ok(mut g) = self.grants.lock() {
            g.remove(key);
        }
        forget_refs(key);
        let holds_lease = self
            .lease
            .lock()
            .map(|l| l.as_ref().map(|l| &l.holder == key).unwrap_or(false))
            .unwrap_or(false);
        if holds_lease {
            self.release_lease();
        }
    }

    /// Revoke one caller's grants from the Settings pane. `caller` is the
    /// opaque id from [`GrantSummary`].
    pub fn revoke(&self, caller: &str) {
        let key = self
            .grants
            .lock()
            .ok()
            .and_then(|g| g.keys().find(|k| k.as_string() == caller).cloned());
        if let Some(key) = key {
            self.forget_caller(&key);
        }
    }

    pub fn active_grants(&self) -> Vec<GrantSummary> {
        let Ok(g) = self.grants.lock() else { return Vec::new() };
        let mut out = Vec::new();
        for (key, grants) in g.iter() {
            for (subject, label) in &grants.allowed {
                out.push(GrantSummary {
                    caller: key.as_string(),
                    agent: grants.name.clone(),
                    kind: subject.kind(),
                    target: label.clone(),
                });
            }
        }
        out
    }

    pub fn recent_activity(&self) -> Vec<ActivityEntry> {
        self.activity.lock().map(|a| a.iter().rev().cloned().collect()).unwrap_or_default()
    }

    /// Extra apps the user never wants agents to see (Settings).
    pub fn set_blocked_apps(&self, names: Vec<String>) {
        let cleaned: Vec<String> = names
            .into_iter()
            .map(|n| n.trim().to_ascii_lowercase())
            .filter(|n| !n.is_empty())
            .map(|n| if n.ends_with(".exe") { n } else { format!("{n}.exe") })
            .collect();
        #[cfg(windows)]
        win::set_user_denylist(cleaned);
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        unix::set_user_denylist(cleaned);
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        let _ = cleaned;
    }

    /// The user's answer to a grant dialog.
    pub fn respond(&self, request_id: &str, allow: bool) {
        if let Some((_, tx)) = self.pending.remove(request_id) {
            let _ = tx.send(allow);
        }
    }

    fn lookup(&self, key: &CallerKey, subject: &Subject) -> Option<bool> {
        let g = self.grants.lock().ok()?;
        let s = g.get(key)?;
        let covers = |granted: &Subject| {
            granted == subject || matches!((granted, subject), (Subject::Control(a), Subject::See(b)) if a == b)
        };
        if s.allowed.iter().any(|(granted, _)| covers(granted)) {
            Some(true)
        } else if s.denied.contains(subject) {
            Some(false)
        } else {
            None
        }
    }

    fn record(&self, caller: &DesktopCaller, subject: Subject, label: String, allow: bool) {
        if let Ok(mut g) = self.grants.lock() {
            let s = g.entry(caller.key.clone()).or_default();
            s.name = caller.display_name();
            if allow {
                s.allowed.push((subject, label));
            } else {
                s.denied.push(subject);
            }
        }
    }

    /// Succeed if the caller may do `subject`, asking the user if it has not
    /// been decided yet. Blocks for up to [`GRANT_TIMEOUT`].
    async fn ensure(
        &self,
        caller: &DesktopCaller,
        subject: Subject,
        window: Option<&WindowInfo>,
        reason: &str,
    ) -> Result<(), String> {
        match self.lookup(&caller.key, &subject) {
            Some(true) => return Ok(()),
            Some(false) => return Err(declined(&subject)),
            None => {}
        }

        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(request_id.clone(), tx);
        let (session_id, chat_id) = match &caller.key {
            CallerKey::Session(s) => (Some(*s), None),
            CallerKey::Chat(c) => (None, Some(c.clone())),
        };
        (self.hooks.grant)(&GrantRequest {
            request_id: request_id.clone(),
            session_id,
            chat_id,
            agent_name: caller.agent_name.clone(),
            kind: subject.kind(),
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
                let label = match window {
                    Some(w) => format!("\"{}\" ({})", w.title, w.process),
                    None => "the list of open windows".to_string(),
                };
                self.record(caller, subject.clone(), label, allow);
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

    // --- acts --------------------------------------------------------------

    fn check_rate(&self, key: &CallerKey) -> Result<(), String> {
        let mut map = self.recent_acts.lock().map_err(|_| "rate limiter poisoned".to_string())?;
        let q = map.entry(key.clone()).or_default();
        let now = Instant::now();
        while q.front().map(|t| now.duration_since(*t) > Duration::from_secs(1)).unwrap_or(false) {
            q.pop_front();
        }
        if q.len() >= MAX_ACTS_PER_SECOND {
            return Err("Too many actions in one second. Slow down and check the result of each step.".into());
        }
        q.push_back(now);
        Ok(())
    }

    /// Take (or keep) the single input lease.
    fn acquire_lease(&self, caller: &DesktopCaller) -> Result<(), String> {
        let mut lease = self.lease.lock().map_err(|_| "lease poisoned".to_string())?;
        if let Some(l) = lease.as_ref() {
            if l.holder != caller.key && l.last_act.elapsed() < LEASE_IDLE {
                return Err(format!(
                    "The computer is being controlled by {} right now. Try again in a little while.",
                    l.holder_name
                ));
            }
        }
        *lease = Some(Lease { holder: caller.key.clone(), holder_name: caller.display_name(), last_act: Instant::now() });
        drop(lease);
        self.watch_lease();
        Ok(())
    }

    fn touch_lease(&self) {
        if let Ok(mut lease) = self.lease.lock() {
            if let Some(l) = lease.as_mut() {
                l.last_act = Instant::now();
            }
        }
    }

    fn release_lease(&self) {
        let had = self.lease.lock().map(|mut l| l.take().is_some()).unwrap_or(false);
        if had {
            (self.hooks.indicator)(None);
        }
    }

    /// Release an idle lease (and hide the indicator) in the background.
    fn watch_lease(&self) {
        if self.lease_watch.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.me.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(state) = me.upgrade() else { return };
                let idle = state
                    .lease
                    .lock()
                    .map(|l| l.as_ref().map(|l| l.last_act.elapsed() >= LEASE_IDLE))
                    .unwrap_or(None);
                match idle {
                    Some(true) => state.release_lease(),
                    Some(false) => {}
                    None => {
                        state.lease_watch.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }
        });
    }

    fn log(&self, caller: &DesktopCaller, tool: &str, window: &WindowInfo, detail: &str, ok: bool) {
        let entry = ActivityEntry {
            at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            agent: caller.display_name(),
            tool: tool.to_string(),
            window: window.title.clone(),
            process: window.process.clone(),
            detail: detail.chars().take(300).collect(),
            ok,
        };
        append_activity_log(&entry);
        if let Ok(mut a) = self.activity.lock() {
            a.push_back(entry);
            while a.len() > ACTIVITY_KEEP {
                a.pop_front();
            }
        }
    }
}

fn declined(subject: &Subject) -> String {
    match subject {
        Subject::WindowList => "The user declined to let you see their open windows. Do not ask again.",
        Subject::See(_) => "The user declined to let you see this window. Do not ask again.",
        Subject::Control(_) => "The user declined to let you control this window. Do not ask again.",
    }
    .to_string()
}

fn forget_refs(key: &CallerKey) {
    #[cfg(windows)]
    {
        let k = key.as_string();
        win::post(move |w| w.forget_caller(&k));
    }
    #[cfg(not(windows))]
    let _ = key;
}

/// Append one entry to the on-disk log (JSON lines). Best-effort: a log that
/// cannot be written must not block the act. Rotated at 5 MB into a `.1` file.
fn append_activity_log(entry: &ActivityEntry) {
    use std::io::Write as _;
    let Some(path) = activity_log_path() else { return };
    if std::fs::metadata(&path).map(|m| m.len() > ACTIVITY_LOG_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("1.jsonl"));
    }
    if let (Ok(line), Ok(mut f)) = (
        serde_json::to_string(entry),
        std::fs::OpenOptions::new().create(true).append(true).open(&path),
    ) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn activity_log_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("spacron").join("computer-use-activity.jsonl"))
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

pub const SEE_TOOLS: &[&str] = &["desktop_list_windows", "desktop_ui_tree", "desktop_find", "desktop_screenshot"];
pub const ACT_TOOLS: &[&str] = &[
    "desktop_focus_window",
    "desktop_click",
    "desktop_type",
    "desktop_key",
    "desktop_scroll",
    "desktop_drag",
];

pub fn is_desktop_tool(name: &str) -> bool {
    SEE_TOOLS.contains(&name) || ACT_TOOLS.contains(&name)
}

pub fn is_act_tool(name: &str) -> bool {
    ACT_TOOLS.contains(&name)
}

fn common_props(with_token: bool) -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    m.insert(
        "reason".into(),
        serde_json::json!({
            "type": "string",
            "description": "One sentence, shown to the user when they are asked to allow this: why you need it."
        }),
    );
    if with_token {
        m.insert(
            "agent_token".into(),
            serde_json::json!({
                "type": "string",
                "description": "Your SPACRON_AGENT_TOKEN environment variable. Computer use has to know which agent is asking; pass it unless your MCP connection already identifies you."
            }),
        );
    }
    m
}

fn tool(name: &str, description: &str, extra: serde_json::Value, required: &[&str], with_token: bool) -> serde_json::Value {
    let mut props = common_props(with_token);
    if let Some(e) = extra.as_object() {
        for (k, v) in e {
            props.insert(k.clone(), v.clone());
        }
    }
    serde_json::json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required }
    })
}

/// Every computer-use tool definition. `with_token` adds the `agent_token`
/// argument MCP callers need; the orchestrator is identified by its chat.
pub fn tool_definitions(with_token: bool) -> Vec<serde_json::Value> {
    let window = serde_json::json!({ "type": "string", "description": "Window id from desktop_list_windows." });
    let reference = serde_json::json!({ "type": "string", "description": "Element ref from the latest desktop_ui_tree (e12) or desktop_find (f3) of this window. Preferred over x/y." });
    let x = serde_json::json!({ "type": "number", "description": "Horizontal position, 0-1 across the window (0 = left edge)." });
    let y = serde_json::json!({ "type": "number", "description": "Vertical position, 0-1 down the window (0 = top edge)." });
    let control_note = "The user is asked to allow control of each window the first time; while you are in control a border frames the window and the user can stop you with Ctrl+Alt+Esc. Actions wait while the user is using the mouse or keyboard. Read the window again afterwards to see the result.";
    vec![
        tool(
            "desktop_list_windows",
            "List the user's open desktop windows: id, title, process, position and size (physical pixels), and whether each is focused or minimised. The user is asked to allow this the first time.",
            serde_json::json!({}),
            &[],
            with_token,
        ),
        tool(
            "desktop_ui_tree",
            "Read one window's UI Automation tree as indented text: a ref (e12) plus the role, name, value and state of each control, with its centre as normalized 0-1 coordinates within the window (@x,y). This is the reliable way to learn what is on screen, and refs are how to click and type precisely. Refs stay valid until the next desktop_ui_tree of the same window. Password values are never returned. Long trees are cut off with a note; use desktop_find to search instead. The user is asked to allow each window the first time.",
            serde_json::json!({
                "window": window,
                "depth": { "type": "integer", "description": "How many levels to descend (default 12, max 40)." }
            }),
            &["window"],
            with_token,
        ),
        tool(
            "desktop_find",
            "Search one window's UI Automation tree for controls whose name, value or automation id contains `query` (case-insensitive), optionally only of one `role` (Button, Edit, MenuItem, …). Returns each match with a ref (f3) and its path from the window. Refs stay valid until the next desktop_find of the same window. The user is asked to allow each window the first time.",
            serde_json::json!({
                "window": window,
                "query": { "type": "string", "description": "Text to look for." },
                "role": { "type": "string", "description": "Only controls of this role." }
            }),
            &["window"],
            with_token,
        ),
        tool(
            "desktop_screenshot",
            "Capture one window's own pixels as a PNG (other windows lying on top are not included), cropped to the window frame so a pixel at (px, py) is the normalized point (px/width, py/height). Large windows are downscaled to at most 1568 px on the long side. The user is asked to allow each window the first time.",
            serde_json::json!({ "window": window }),
            &["window"],
            with_token,
        ),
        tool(
            "desktop_focus_window",
            &format!("Bring a window to the front (restoring it if minimised). {control_note}"),
            serde_json::json!({ "window": window }),
            &["window"],
            with_token,
        ),
        tool(
            "desktop_click",
            &format!("Click in a window, on an element `ref` (preferred: buttons, checkboxes, list items and menus are activated directly, without moving the pointer) or at normalized `x`,`y`. {control_note}"),
            serde_json::json!({
                "window": window,
                "ref": reference,
                "x": x,
                "y": y,
                "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "Default left." },
                "double": { "type": "boolean", "description": "Double-click. Default false." }
            }),
            &["window"],
            with_token,
        ),
        tool(
            "desktop_type",
            &format!("Type text into a window: into the element `ref` if given (it is focused first), otherwise wherever keyboard focus is. Newlines press Enter. With `replace`, the field's content is replaced instead of appended to. Password fields are refused. Max 4096 characters. {control_note}"),
            serde_json::json!({
                "window": window,
                "ref": reference,
                "text": { "type": "string", "description": "The text to type." },
                "replace": { "type": "boolean", "description": "Replace the field's current content. Default false." }
            }),
            &["window", "text"],
            with_token,
        ),
        tool(
            "desktop_key",
            &format!("Press a key or shortcut in a window, e.g. \"enter\", \"ctrl+s\", \"shift+tab\", \"f5\". The Windows key, Alt+Tab, Alt+F4, Ctrl+Esc and similar combinations that leave the window are refused. {control_note}"),
            serde_json::json!({
                "window": window,
                "keys": { "type": "string", "description": "Keys joined with +." }
            }),
            &["window", "keys"],
            with_token,
        ),
        tool(
            "desktop_scroll",
            &format!("Scroll in a window, over an element `ref`, at normalized `x`,`y`, or at the window centre. Positive dy scrolls down, positive dx scrolls right; each unit is one wheel notch (max 50). {control_note}"),
            serde_json::json!({
                "window": window,
                "ref": reference,
                "x": x,
                "y": y,
                "dx": { "type": "integer" },
                "dy": { "type": "integer" }
            }),
            &["window"],
            with_token,
        ),
        tool(
            "desktop_drag",
            &format!("Drag with the left button from one point to another in a window. Each end is a ref (from_ref / to_ref) or normalized coordinates (from_x, from_y / to_x, to_y). {control_note}"),
            serde_json::json!({
                "window": window,
                "from_ref": reference, "from_x": x, "from_y": y,
                "to_ref": reference, "to_x": x, "to_y": y
            }),
            &["window"],
            with_token,
        ),
    ]
}

/// The computer-use tools, for MCP `tools/list`. Only listed while
/// [`DesktopState::available`].
pub fn mcp_tools() -> Vec<serde_json::Value> {
    tool_definitions(true)
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type Args<'a> = Option<&'a serde_json::Map<String, serde_json::Value>>;

fn str_arg<'a>(args: Args<'a>, key: &str) -> Option<&'a str> {
    args.and_then(|a| a.get(key)).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

/// Numbers may arrive as numbers or as numeric strings (models do both).
fn num_arg(args: Args, key: &str) -> Option<f64> {
    let v = args.and_then(|a| a.get(key))?;
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
}

fn bool_arg(args: Args, key: &str) -> bool {
    args.and_then(|a| a.get(key))
        .map(|v| v.as_bool().unwrap_or_else(|| v.as_str().map(|s| s.eq_ignore_ascii_case("true")).unwrap_or(false)))
        .unwrap_or(false)
}

fn point_arg(args: Args, prefix: &str, required: bool) -> Result<Point, String> {
    if let Some(r) = str_arg(args, &format!("{prefix}ref")) {
        return Ok(Point::Ref(r.to_string()));
    }
    match (num_arg(args, &format!("{prefix}x")), num_arg(args, &format!("{prefix}y"))) {
        (Some(x), Some(y)) => {
            if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                return Err("Coordinates are normalized to the window: x and y must be between 0 and 1.".into());
            }
            Ok(Point::At(x, y))
        }
        (None, None) if !required => Ok(Point::Centre),
        _ => Err(format!("Give either '{prefix}ref', or both '{prefix}x' and '{prefix}y' (0-1 within the window).")),
    }
}

/// Turn an act tool's arguments into an [`Act`].
pub fn parse_act(name: &str, args: Args) -> Result<Act, String> {
    match name {
        "desktop_focus_window" => Ok(Act::Focus),
        "desktop_click" => {
            let button = match str_arg(args, "button").map(str::to_ascii_lowercase).as_deref() {
                None | Some("left") => MouseButton::Left,
                Some("right") => MouseButton::Right,
                Some("middle") => MouseButton::Middle,
                Some(other) => return Err(format!("Unknown button '{other}'. Use left, right or middle.")),
            };
            Ok(Act::Click { at: point_arg(args, "", true)?, button, double: bool_arg(args, "double") })
        }
        "desktop_type" => {
            let text = args
                .and_then(|a| a.get("text"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| "desktop_type needs 'text'.".to_string())?;
            if text.is_empty() {
                return Err("desktop_type needs non-empty 'text'.".into());
            }
            if text.chars().count() > MAX_TYPE_CHARS {
                return Err(format!("desktop_type accepts at most {MAX_TYPE_CHARS} characters."));
            }
            Ok(Act::Type {
                at: str_arg(args, "ref").map(str::to_string),
                text: text.to_string(),
                replace: bool_arg(args, "replace"),
            })
        }
        "desktop_key" => {
            let keys = str_arg(args, "keys")
                .ok_or_else(|| "desktop_key needs 'keys', e.g. \"enter\" or \"ctrl+s\".".to_string())?;
            #[cfg(windows)]
            win::parse_keys(keys)?;
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            unix::parse_keys(keys)?;
            Ok(Act::Key { keys: keys.to_string() })
        }
        "desktop_scroll" => {
            let clamp = |v: Option<f64>| (v.unwrap_or(0.0).round() as i32).clamp(-MAX_SCROLL_STEPS, MAX_SCROLL_STEPS);
            let (dx, dy) = (clamp(num_arg(args, "dx")), clamp(num_arg(args, "dy")));
            if dx == 0 && dy == 0 {
                return Err("desktop_scroll needs a non-zero 'dx' or 'dy'.".into());
            }
            Ok(Act::Scroll { at: point_arg(args, "", false)?, dx, dy })
        }
        "desktop_drag" => Ok(Act::Drag { from: point_arg(args, "from_", true)?, to: point_arg(args, "to_", true)? }),
        other => Err(format!("Unknown computer-use tool: '{other}'")),
    }
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

fn text(t: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "content": [{ "type": "text", "text": t.into() }] })
}

/// Run one computer-use tool for an identified caller. Returns the MCP
/// `result` object (`{ content: [...] }`) or an error message.
///
/// For the orchestrator (`CallerKey::Chat`) screenshots are written to a file
/// and only the path is returned: its providers have no vision path, and a
/// base64 image would be tens of thousands of useless characters.
pub async fn call_tool(
    state: &DesktopState,
    caller: DesktopCaller,
    name: &str,
    args: Args<'_>,
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
    // Parse before asking: a malformed call should not raise a dialog.
    let act = if is_act_tool(name) { Some(parse_act(name, args)?) } else { None };
    let info = window(window_id.clone()).await?;
    let ident = WindowIdent::of(&info);

    if let Some(act) = act {
        state.ensure(&caller, Subject::Control(ident), Some(&info), &reason).await?;
        return run_act(state, &caller, name, &info, act).await;
    }

    state.ensure(&caller, Subject::See(ident), Some(&info), &reason).await?;
    let key = caller.key.as_string();
    match name {
        "desktop_ui_tree" => {
            let depth = args
                .and_then(|a| a.get("depth"))
                .and_then(|v| v.as_u64())
                .map(|d| (d as usize).clamp(1, MAX_TREE_DEPTH_ARG))
                .unwrap_or(TREE_LIMITS.max_depth);
            let limits = TreeLimits { max_depth: depth, ..TREE_LIMITS };
            let (info, nodes, truncated) = walk(key, window_id, false, limits).await?;
            Ok(text(format_tree(&info, &nodes, truncated)))
        }
        "desktop_find" => {
            let query = str_arg(args, "query").map(str::to_lowercase);
            let role = str_arg(args, "role").map(str::to_lowercase);
            if query.is_none() && role.is_none() {
                return Err("desktop_find needs a 'query', a 'role', or both.".into());
            }
            let (info, nodes, truncated) = walk(key, window_id, true, FIND_LIMITS).await?;
            Ok(text(format_find(&info, &nodes, truncated, query.as_deref(), role.as_deref())))
        }
        "desktop_screenshot" => screenshot(window_id, matches!(caller.key, CallerKey::Chat(_))).await,
        other => Err(format!("Unknown computer-use tool: '{other}'")),
    }
}

async fn run_act(
    state: &DesktopState,
    caller: &DesktopCaller,
    tool_name: &str,
    info: &WindowInfo,
    act: Act,
) -> Result<serde_json::Value, String> {
    let outcome = async {
        state.check_rate(&caller.key)?;
        wait_for_user_quiet().await?;
        state.acquire_lease(caller)?;
        let indicator = |last: &str| Indicator {
            agent: caller.display_name(),
            window_title: info.title.clone(),
            bounds: info.bounds.clone(),
            last_action: last.to_string(),
            stop_shortcut: STOP_SHORTCUT,
        };
        (state.hooks.indicator)(Some(&indicator(&describe_act(&act))));
        let done = perform(caller.key.as_string(), info.clone(), act.clone()).await;
        state.touch_lease();
        if let Ok(summary) = &done {
            (state.hooks.indicator)(Some(&indicator(summary)));
        }
        done
    }
    .await;

    match outcome {
        Ok(summary) => {
            state.log(caller, tool_name, info, &format!("{} — {summary}", describe_act(&act)), true);
            Ok(text(format!("{summary} Read the window again to check the result.")))
        }
        Err(e) => {
            state.log(caller, tool_name, info, &format!("{} — refused: {e}", describe_act(&act)), false);
            Err(e)
        }
    }
}

/// A short, log-safe description of an act. Typed text is summarised by length
/// only: the log should not become a copy of whatever an agent typed.
fn describe_act(act: &Act) -> String {
    let point = |p: &Point| match p {
        Point::Ref(r) => r.clone(),
        Point::At(x, y) => format!("({x:.3}, {y:.3})"),
        Point::Centre => "centre".into(),
    };
    match act {
        Act::Focus => "bring to front".into(),
        Act::Click { at, button, double } => {
            format!("{}{} click at {}", if *double { "double " } else { "" }, button.name(), point(at))
        }
        Act::Type { at, text, replace } => format!(
            "{} {} characters{}",
            if *replace { "replace with" } else { "type" },
            text.chars().count(),
            at.as_ref().map(|r| format!(" into {r}")).unwrap_or_default()
        ),
        Act::Key { keys } => format!("press {keys}"),
        Act::Scroll { at, dx, dy } => format!("scroll {dx},{dy} at {}", point(at)),
        Act::Drag { from, to } => format!("drag {} → {}", point(from), point(to)),
    }
}

/// Wait until the user has not touched the mouse or keyboard for a moment.
/// The agent must never fight the user for control; it waits, and gives up if
/// the user keeps working.
async fn wait_for_user_quiet() -> Result<(), String> {
    let started = Instant::now();
    loop {
        match ms_since_real_input() {
            Some(ms) if ms < USER_ACTIVE_MS => {}
            _ => return Ok(()),
        }
        if started.elapsed() > USER_QUIET_WAIT {
            return Err("The user is using the mouse or keyboard right now, so nothing was sent. \
                        Wait for them to finish, then try again."
                .into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

#[cfg(windows)]
use win::Node;

#[cfg(windows)]
fn ms_since_real_input() -> Option<u64> {
    win::ms_since_real_input()
}

#[cfg(windows)]
async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    blocking(win::list_windows).await
}

#[cfg(windows)]
async fn window(id: String) -> Result<WindowInfo, String> {
    blocking(move || win::window(&id)).await
}

#[cfg(windows)]
async fn walk(caller: String, id: String, find: bool, limits: TreeLimits) -> Result<(WindowInfo, Vec<Node>, bool), String> {
    let kind = if find { win::RefKind::Find } else { win::RefKind::Tree };
    win::on_worker(move |w| win::walk(w, &caller, &id, kind, limits)).await
}

#[cfg(windows)]
async fn perform(caller: String, info: WindowInfo, act: Act) -> Result<String, String> {
    win::on_worker(move |w| win::act(w, &caller, &info, &act)).await
}

#[cfg(windows)]
async fn screenshot(id: String, to_file: bool) -> Result<serde_json::Value, String> {
    blocking(move || {
        let (info, img) = win::capture(&id)?;
        if to_file {
            screenshot_to_file(&info, img)
        } else {
            encode_screenshot(&info, img)
        }
    })
    .await
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn ms_since_real_input() -> Option<u64> {
    unix::ms_since_real_input()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    blocking(unix::list_windows).await
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn window(id: String) -> Result<WindowInfo, String> {
    blocking(move || unix::window(&id)).await
}

/// No UI element tree on macOS and Linux yet: say how to work instead.
#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn walk(_caller: String, _id: String, _find: bool, _limits: TreeLimits) -> Result<(WindowInfo, Vec<Node>, bool), String> {
    Err(unix::walk_unsupported())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn perform(caller: String, info: WindowInfo, act: Act) -> Result<String, String> {
    blocking(move || unix::act(&caller, &info, &act)).await
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn screenshot(id: String, to_file: bool) -> Result<serde_json::Value, String> {
    blocking(move || {
        let (info, img) = unix::capture(&id)?;
        if to_file {
            screenshot_to_file(&info, img)
        } else {
            encode_screenshot(&info, img)
        }
    })
    .await
}

/// Only built by the Windows backend (and tests); the formatters read it everywhere.
#[cfg(not(windows))]
#[allow(dead_code)]
pub struct Node {
    pub depth: usize,
    pub reference: String,
    pub role: &'static str,
    pub name: String,
    pub value: Option<String>,
    pub automation_id: String,
    pub enabled: bool,
    pub focused: bool,
    pub offscreen: bool,
    pub at: Option<(f64, f64)>,
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn ms_since_real_input() -> Option<u64> {
    None
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    Err(unsupported())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn window(_id: String) -> Result<WindowInfo, String> {
    Err(unsupported())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn walk(_c: String, _id: String, _find: bool, _l: TreeLimits) -> Result<(WindowInfo, Vec<Node>, bool), String> {
    Err(unsupported())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn perform(_c: String, _info: WindowInfo, _act: Act) -> Result<String, String> {
    Err(unsupported())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn screenshot(_id: String, _to_file: bool) -> Result<serde_json::Value, String> {
    Err(unsupported())
}

fn downscale(img: image::RgbaImage) -> image::RgbaImage {
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    if longest <= MAX_SCREENSHOT_SIDE {
        return img;
    }
    let scale = MAX_SCREENSHOT_SIDE as f64 / longest as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle)
}

fn png_bytes(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(img.clone())
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;
    Ok(png)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn encode_screenshot(info: &WindowInfo, img: image::RgbaImage) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let (w, h) = (img.width(), img.height());
    let img = downscale(img);
    let png = png_bytes(&img)?;
    let note = format!(
        "Screenshot of window {} \"{}\" ({}): {}x{} px{}. A pixel (px, py) is the normalized point (px/{}, py/{}).",
        info.id,
        info.title,
        info.process,
        img.width(),
        img.height(),
        if img.width() != w { format!(", downscaled from {w}x{h}") } else { String::new() },
        img.width(),
        img.height()
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

/// The orchestrator's screenshot: a file in the temp dir (never the project,
/// which would put binaries in the user's `git status`), and a note saying the
/// model cannot see it — same contract as `emulator_screenshot`.
#[cfg_attr(not(windows), allow(dead_code))]
fn screenshot_to_file(info: &WindowInfo, img: image::RgbaImage) -> Result<serde_json::Value, String> {
    let img = downscale(img);
    let png = png_bytes(&img)?;
    let dir = std::env::temp_dir().join("spacron-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("window-{}-{stamp}.png", info.id));
    std::fs::write(&path, png).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    let mut result = text(format!(
        "Screenshot of \"{}\" saved to {} ({}x{}). If your model accepts images, it is attached to this result; \
         if not, it is for the user to open, and desktop_ui_tree or desktop_find tell you what is in the window.",
        info.title,
        path.display(),
        img.width(),
        img.height()
    ));
    // Not part of MCP: the chat's command reads it to attach the image for
    // models that can see (commands/secrets/agent_turn/vision.rs).
    result["images"] = serde_json::json!([path.display().to_string()]);
    Ok(result)
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
    let mut line = format!("[{}] {} \"{}\"", n.reference, n.role, n.name.replace('"', "'"));
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

fn format_find(info: &WindowInfo, nodes: &[Node], truncated: bool, query: Option<&str>, role: Option<&str>) -> String {
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
        DesktopCaller { key: CallerKey::Session(7), agent_name: Some("Iris".into()) }
    }

    fn ident(id: &str, pid: u32, path: &str) -> WindowIdent {
        WindowIdent { id: id.into(), pid, process_path: path.into() }
    }

    fn state_with(answer: Option<bool>) -> Arc<DesktopState> {
        let slot: Arc<Mutex<Option<Arc<DesktopState>>>> = Arc::new(Mutex::new(None));
        let slot2 = slot.clone();
        let hooks = DesktopHooks {
            grant: Arc::new(move |req: &GrantRequest| {
                if let (Some(allow), Some(s)) = (answer, slot2.lock().unwrap().clone()) {
                    s.respond(&req.request_id, allow);
                }
            }),
            ..DesktopHooks::noop()
        };
        let state = DesktopState::new(hooks);
        *slot.lock().unwrap() = Some(state.clone());
        // Not `set_enabled`: that would start the real guard (hooks and a
        // global shortcut) inside a unit test.
        state.enabled.store(true, Ordering::SeqCst);
        state
    }

    #[tokio::test]
    async fn a_granted_subject_is_not_asked_again() {
        let state = state_with(Some(true));
        state.ensure(&caller(), Subject::WindowList, None, "r").await.unwrap();
        assert_eq!(state.lookup(&caller().key, &Subject::WindowList), Some(true));
        state.ensure(&caller(), Subject::WindowList, None, "r").await.unwrap();
    }

    #[tokio::test]
    async fn a_declined_subject_stays_declined_without_a_new_dialog() {
        let state = state_with(Some(false));
        assert!(state.ensure(&caller(), Subject::WindowList, None, "r").await.is_err());
        assert_eq!(state.lookup(&caller().key, &Subject::WindowList), Some(false));
    }

    #[tokio::test]
    async fn grants_are_per_caller_and_per_window_identity() {
        let state = state_with(Some(true));
        let a = Subject::See(ident("1", 10, "C:\\a.exe"));
        state.ensure(&caller(), a.clone(), None, "r").await.unwrap();
        assert_eq!(state.lookup(&CallerKey::Session(8), &a), None, "another session must ask for itself");
        assert_eq!(state.lookup(&CallerKey::Chat("7".into()), &a), None, "a chat is not a session");
        let recycled = Subject::See(ident("1", 11, "C:\\b.exe"));
        assert_eq!(state.lookup(&caller().key, &recycled), None, "a reused handle in another process is a new window");
    }

    #[tokio::test]
    async fn control_implies_see_but_not_the_reverse() {
        let state = state_with(Some(true));
        let w = ident("1", 10, "C:\\a.exe");
        state.ensure(&caller(), Subject::See(w.clone()), None, "r").await.unwrap();
        assert_eq!(state.lookup(&caller().key, &Subject::Control(w.clone())), None, "seeing must not grant control");
        let other = CallerKey::Session(9);
        state.record(&DesktopCaller { key: other.clone(), agent_name: None }, Subject::Control(w.clone()), "x".into(), true);
        assert_eq!(state.lookup(&other, &Subject::See(w)), Some(true));
    }

    #[tokio::test]
    async fn turning_off_withdraws_grants_and_declines_open_dialogs() {
        let state = state_with(None);
        state.record(&caller(), Subject::WindowList, "list".into(), true);
        let s2 = state.clone();
        let waiting = tokio::spawn(async move { s2.ensure(&caller(), Subject::See(ident("5", 1, "x")), None, "r").await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        state.enabled.store(false, Ordering::SeqCst);
        state.withdraw_everything();
        assert!(waiting.await.unwrap().is_err());
        assert_eq!(state.lookup(&caller().key, &Subject::WindowList), None);
    }

    #[tokio::test]
    async fn the_stop_shortcut_withdraws_everything_and_releases_the_lease() {
        let notices: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let hidden = Arc::new(AtomicBool::new(false));
        let (n2, h2) = (notices.clone(), hidden.clone());
        let state = DesktopState::new(DesktopHooks {
            notice: Arc::new(move |m| n2.lock().unwrap().push(m.to_string())),
            indicator: Arc::new(move |i| {
                if i.is_none() {
                    h2.store(true, Ordering::SeqCst)
                }
            }),
            ..DesktopHooks::noop()
        });
        state.enabled.store(true, Ordering::SeqCst);
        state.record(&caller(), Subject::Control(ident("1", 1, "x")), "w".into(), true);
        state.acquire_lease(&caller()).unwrap();

        state.stop_by_shortcut();

        assert!(state.active_grants().is_empty());
        assert!(state.lease.lock().unwrap().is_none());
        assert!(hidden.load(Ordering::SeqCst), "the indicator must be hidden");
        assert_eq!(notices.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn only_one_caller_holds_the_input_lease() {
        let state = state_with(None);
        state.acquire_lease(&caller()).unwrap();
        state.acquire_lease(&caller()).unwrap();
        let other = DesktopCaller { key: CallerKey::Session(8), agent_name: Some("Neo".into()) };
        let err = state.acquire_lease(&other).unwrap_err();
        assert!(err.contains("Iris"), "{err}");
        state.forget_session(7);
        state.acquire_lease(&other).unwrap();
    }

    #[test]
    fn acts_are_rate_limited_per_caller() {
        let state = DesktopState::new(DesktopHooks::noop());
        for _ in 0..MAX_ACTS_PER_SECOND {
            state.check_rate(&caller().key).unwrap();
        }
        assert!(state.check_rate(&caller().key).is_err());
        state.check_rate(&CallerKey::Session(8)).unwrap();
    }

    #[tokio::test]
    async fn ending_a_session_or_chat_turn_forgets_its_grants() {
        let state = state_with(Some(true));
        state.ensure(&caller(), Subject::WindowList, None, "r").await.unwrap();
        state.forget_session(7);
        assert_eq!(state.lookup(&caller().key, &Subject::WindowList), None);

        let chat = DesktopCaller { key: CallerKey::Chat("conv-1".into()), agent_name: None };
        state.ensure(&chat, Subject::WindowList, None, "r").await.unwrap();
        state.end_chat_turn("conv-1");
        assert_eq!(state.lookup(&chat.key, &Subject::WindowList), None);
    }

    #[tokio::test]
    async fn revoke_by_summary_id() {
        let state = state_with(Some(true));
        state.ensure(&caller(), Subject::WindowList, None, "r").await.unwrap();
        let grants = state.active_grants();
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].agent, "Iris");
        state.revoke(&grants[0].caller);
        assert!(state.active_grants().is_empty());
    }

    #[test]
    fn act_arguments_are_parsed_and_validated() {
        let args = |v: serde_json::Value| v.as_object().cloned();
        let a = args(serde_json::json!({ "ref": "e3" }));
        assert_eq!(
            parse_act("desktop_click", a.as_ref()).unwrap(),
            Act::Click { at: Point::Ref("e3".into()), button: MouseButton::Left, double: false }
        );
        let a = args(serde_json::json!({ "x": "0.5", "y": 0.25, "button": "Right", "double": true }));
        assert_eq!(
            parse_act("desktop_click", a.as_ref()).unwrap(),
            Act::Click { at: Point::At(0.5, 0.25), button: MouseButton::Right, double: true }
        );
        let a = args(serde_json::json!({ "x": 1.5, "y": 0.2 }));
        assert!(parse_act("desktop_click", a.as_ref()).is_err(), "out of range");
        let a = args(serde_json::json!({ "x": 0.5 }));
        assert!(parse_act("desktop_click", a.as_ref()).is_err(), "half a point");
        let a = args(serde_json::json!({ "dy": 3 }));
        assert_eq!(parse_act("desktop_scroll", a.as_ref()).unwrap(), Act::Scroll { at: Point::Centre, dx: 0, dy: 3 });
        let a = args(serde_json::json!({ "text": "" }));
        assert!(parse_act("desktop_type", a.as_ref()).is_err());
        let a = args(serde_json::json!({ "text": "x".repeat(MAX_TYPE_CHARS + 1) }));
        assert!(parse_act("desktop_type", a.as_ref()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn keys_that_leave_the_window_are_refused() {
        for bad in ["win+r", "alt+tab", "ctrl+esc", "alt+f4", "ctrl+alt+delete", "ctrl+alt+esc", "meta", "ctrl+v", "shift+insert", "ctrl+shift+v"] {
            assert!(win::parse_keys(bad).is_err(), "{bad} should be refused");
        }
        for ok in ["enter", "ctrl+s", "shift+tab", "f5", "a", "ctrl+shift+z", "pagedown"] {
            assert!(win::parse_keys(ok).is_ok(), "{ok} should be allowed");
        }
    }

    #[test]
    fn logged_typing_records_length_not_content() {
        let d = describe_act(&Act::Type { at: Some("e2".into()), text: "hunter2".into(), replace: false });
        assert!(!d.contains("hunter2"), "{d}");
        assert!(d.contains("7 characters"), "{d}");
    }

    #[test]
    fn find_reports_the_path_to_each_match() {
        let node = |depth, role, name: &str, r: &str| Node {
            depth,
            reference: r.into(),
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
            node(0, "Window", "T", "f0"),
            node(1, "Pane", "Toolbar", "f1"),
            node(2, "Button", "Save", "f2"),
            node(1, "Button", "Save as", "f3"),
        ];
        let out = format_find(&info, &nodes, false, Some("save"), Some("button"));
        assert!(out.starts_with("2 matches"), "{out}");
        assert!(out.contains("- Pane \"Toolbar\" > [f2] Button \"Save\""), "{out}");
        assert!(out.contains("- [f3] Button \"Save as\""), "{out}");
    }

    /// Drives every act through the full tool path — grant lookup, lease,
    /// worker, pre-input checks, input — against a throwaway WinForms window
    /// this test launches itself. Opt-in: it moves the real mouse (and puts it
    /// back). `cargo test --lib desktop::tests::real_acts -- --ignored --nocapture`
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn real_acts_drive_a_test_window() {
        let script = std::env::temp_dir().join("spacron-desktop-test-form.ps1");
        std::fs::write(&script, TEST_FORM).unwrap();
        let mut child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .spawn()
            .unwrap();

        let state = DesktopState::new(DesktopHooks::noop());
        state.enable_for_test();
        let text_of = |v: &serde_json::Value| v["content"][0]["text"].as_str().unwrap_or_default().to_string();
        let run = |name: &'static str, args: serde_json::Value| {
            let state = state.clone();
            async move { call_tool(&state, caller(), name, args.as_object()).await }
        };

        let mut target = None;
        for _ in 0..100 {
            if let Ok(ws) = list_windows().await {
                target = ws.into_iter().find(|w| w.title == "SpacronActTest");
            }
            if target.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let target = target.expect("test window never appeared");
        tokio::time::sleep(Duration::from_millis(400)).await;
        // Pre-grant instead of answering dialogs: this test is about acting.
        state.record(&caller(), Subject::Control(WindowIdent::of(&target)), "test".into(), true);
        let window = target.id.clone();

        // First `[fN]` ref in a desktop_find answer.
        let first_ref = |out: &str| {
            out.lines()
                .find_map(|l| l.split_once("[f").map(|(_, rest)| format!("f{}", rest.split(']').next().unwrap_or(""))))
        };
        let find = |q: &'static str| {
            let window = window.clone();
            let run = run.clone();
            async move {
                let out = run("desktop_find", serde_json::json!({ "window": window, "query": q })).await.unwrap();
                out["content"][0]["text"].as_str().unwrap_or_default().to_string()
            }
        };

        // Click by ref: InvokePattern, no pointer.
        let out = find("Press me").await;
        let r = run("desktop_click", serde_json::json!({ "window": window, "ref": first_ref(&out).unwrap() })).await.unwrap();
        println!("click by ref: {}", text_of(&r));
        assert!(find("clicked").await.contains("clicked 1"));

        // Toggle a checkbox by ref.
        let out = find("Check me").await;
        let r = run("desktop_click", serde_json::json!({ "window": window, "ref": first_ref(&out).unwrap() })).await.unwrap();
        println!("checkbox: {}", text_of(&r));

        // Type into the text box by ref (focus + synthesized keys), then a key.
        let out = find("Input").await;
        let input = first_ref(&out).expect("input ref");
        run("desktop_type", serde_json::json!({ "window": window, "ref": input, "text": "héllo ✓" })).await.unwrap();
        run("desktop_key", serde_json::json!({ "window": window, "keys": "end" })).await.unwrap();
        let out = find("héllo").await;
        assert!(out.contains("héllo ✓"), "typed text not found: {out}");

        // Replace the content through ValuePattern (refs from the last find).
        let out = find("Input").await;
        let input = first_ref(&out).expect("input ref");
        run("desktop_type", serde_json::json!({ "window": window, "ref": input, "text": "replaced", "replace": true }))
            .await
            .unwrap();
        let out = find("replaced").await;
        assert!(out.contains("value=\"replaced\""), "{out}");

        // A real pointer click at normalized coordinates on the button.
        let out = find("Press me").await;
        let at = out.split('@').nth(1).expect("button centre").lines().next().unwrap().trim().to_string();
        let (x, y) = at.split_once(',').unwrap();
        let r = run(
            "desktop_click",
            serde_json::json!({ "window": window, "x": x.parse::<f64>().unwrap(), "y": y.parse::<f64>().unwrap() }),
        )
        .await
        .unwrap();
        println!("click at point: {}", text_of(&r));
        let out = find("clicked").await;
        assert!(out.contains("clicked 2"), "{out}");

        // Refusals.
        let out = find("Secret").await;
        let err = run("desktop_type", serde_json::json!({ "window": window, "ref": first_ref(&out).unwrap(), "text": "x" }))
            .await
            .unwrap_err();
        assert!(err.contains("password"), "{err}");
        let err = run("desktop_key", serde_json::json!({ "window": window, "keys": "alt+f4" })).await.unwrap_err();
        assert!(err.contains("not allowed"), "{err}");
        let err = run("desktop_click", serde_json::json!({ "window": window, "ref": "e9999" })).await.unwrap_err();
        assert!(err.contains("latest read"), "{err}");

        // Another caller cannot take the lease while this one holds it.
        let other = DesktopCaller { key: CallerKey::Session(8), agent_name: Some("Neo".into()) };
        state.record(&other, Subject::Control(WindowIdent::of(&target)), "test".into(), true);
        let err = call_tool(&state, other, "desktop_focus_window", serde_json::json!({ "window": window }).as_object())
            .await
            .unwrap_err();
        assert!(err.contains("Iris"), "{err}");

        println!("activity entries: {}", state.recent_activity().len());
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(windows)]
    const TEST_FORM: &str = r#"Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'SpacronActTest'; $f.Width = 420; $f.Height = 300; $f.StartPosition = 'Manual'; $f.Left = 240; $f.Top = 240; $f.TopMost = $true
$tb = New-Object System.Windows.Forms.TextBox; $tb.AccessibleName = 'Input'; $tb.Left = 20; $tb.Top = 20; $tb.Width = 360
$b = New-Object System.Windows.Forms.Button; $b.Text = 'Press me'; $b.Left = 20; $b.Top = 70; $b.Width = 150; $b.Height = 40
$c = New-Object System.Windows.Forms.CheckBox; $c.Text = 'Check me'; $c.Left = 200; $c.Top = 75; $c.Width = 150
$l = New-Object System.Windows.Forms.Label; $l.Text = 'clicked 0'; $l.Left = 20; $l.Top = 130; $l.Width = 360
$pw = New-Object System.Windows.Forms.TextBox; $pw.AccessibleName = 'Secret'; $pw.UseSystemPasswordChar = $true; $pw.Left = 20; $pw.Top = 170; $pw.Width = 200
$script:n = 0
$b.Add_Click({ $script:n++; $l.Text = "clicked $script:n" })
$f.Controls.AddRange(@($tb, $b, $c, $l, $pw))
[System.Windows.Forms.Application]::Run($f)
"#;

    #[test]
    fn tool_list_matches_the_see_and_act_sets() {
        let names: Vec<String> = mcp_tools().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        let expected: Vec<&str> = SEE_TOOLS.iter().chain(ACT_TOOLS).copied().collect();
        assert_eq!(names, expected);
        assert!(mcp_tools().iter().all(|t| t["inputSchema"]["properties"]["agent_token"].is_object()));
        assert!(tool_definitions(false).iter().all(|t| t["inputSchema"]["properties"]["agent_token"].is_null()));
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
        let (_, nodes, truncated) = walk("test".into(), target.id.clone(), false, TREE_LIMITS).await.expect("walk");
        println!(
            "{} windows; walked {} elements of a {} window in {:?} (truncated: {truncated})",
            windows.len(),
            nodes.len(),
            target.process,
            started.elapsed()
        );
        assert!(!nodes.is_empty());
        assert!(nodes.iter().all(|n| n.value.as_deref() != Some("")));
        let shot = screenshot(target.id.clone(), false).await.expect("capture");
        assert_eq!(shot["content"][1]["mimeType"], "image/png");
    }
}
