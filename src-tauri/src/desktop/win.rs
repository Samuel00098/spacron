//! Windows backend for computer use: window enumeration, UI Automation, capture.
//!
//! Everything here is blocking and COM-bound, so callers run it on a blocking
//! thread (see `desktop::blocking`). Each entry point initialises COM for the
//! duration of the call and opts the thread into per-monitor-v2 DPI awareness,
//! so coordinates are physical pixels no matter what the process manifest says
//! — the class of bug that sank the native preview overlay
//! (docs/browser-pillar-spike.md, "Bounds and DPI").

use std::collections::HashMap;
use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, TRUE, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::{Bounds, TreeLimits, WindowInfo};

// ---------------------------------------------------------------------------
// Thread setup
// ---------------------------------------------------------------------------

/// COM + DPI awareness for one call, undone on drop.
///
/// Blocking-pool threads are reused, so both have to be restored: a thread left
/// in an MTA or a different DPI context would change behaviour for whatever
/// unrelated work lands on it next.
struct ThreadScope {
    com: bool,
    prev_dpi: DPI_AWARENESS_CONTEXT,
}

impl ThreadScope {
    fn enter() -> Self {
        // S_FALSE (already initialised) still needs a matching uninit; a mode
        // clash (RPC_E_CHANGED_MODE) does not, and UIA works from either model.
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let prev_dpi = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        Self { com, prev_dpi }
    }
}

impl Drop for ThreadScope {
    fn drop(&mut self) {
        unsafe {
            if !self.prev_dpi.0.is_null() {
                SetThreadDpiAwarenessContext(self.prev_dpi);
            }
            if self.com {
                CoUninitialize();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// Processes whose windows are never shown to or targeted by an agent, in
/// addition to Spacron's own. Lower-case image names.
///
/// Credential and security surfaces: an agent must not be able to read or (from
/// phase 2) drive them, whatever the user granted. Password managers are here
/// for the same reason. See docs/computer-use.md, "Never-targetable".
const NEVER_TARGETABLE: &[&str] = &[
    // Spacron itself, by its shipped name; `own_exe_name` covers renamed builds.
    "spacron.exe",
    "credentialuibroker.exe",
    "consent.exe",
    "logonui.exe",
    "lockapp.exe",
    "taskmgr.exe",
    "sechealthui.exe",
    "securityhealthsystray.exe",
    "1password.exe",
    "bitwarden.exe",
    "keepass.exe",
    "keepassxc.exe",
    "dashlane.exe",
    "enpass.exe",
    "nordpass.exe",
    "protonpass.exe",
];

/// Our own executable's file name, lower-cased. Any process running it is
/// Spacron — another instance (a dev build beside the installed app) included —
/// and an agent must never see or drive Spacron's approval surfaces.
fn own_exe_name() -> Option<String> {
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()))
    })
    .clone()
}

/// Extra image names the user added in Settings (lower-case). Checked with the
/// built-in list everywhere a window is described, so a blocked app is invisible
/// to every tool, not just refused by some.
static USER_DENYLIST: std::sync::RwLock<Vec<String>> = std::sync::RwLock::new(Vec::new());

pub fn set_user_denylist(names: Vec<String>) {
    if let Ok(mut list) = USER_DENYLIST.write() {
        *list = names;
    }
}

fn user_denied(lower_process: &str) -> bool {
    USER_DENYLIST.read().map(|l| l.iter().any(|n| n == lower_process)).unwrap_or(false)
}

/// Window classes of the shell itself rather than of an app.
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

fn hwnd_from_id(id: &str) -> Result<HWND, String> {
    let raw: isize = id
        .trim()
        .parse()
        .map_err(|_| format!("'{id}' is not a window id. Use an id from desktop_list_windows."))?;
    let hwnd = HWND(raw as *mut c_void);
    if raw == 0 || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(format!(
            "Window {id} no longer exists. Call desktop_list_windows for current ids."
        ));
    }
    Ok(hwnd)
}

fn process_image(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
        let _ = CloseHandle(handle);
        ok.then(|| String::from_utf16_lossy(&buf[..size as usize]))
    }
}

fn frame_bounds(hwnd: HWND) -> Bounds {
    let mut r = RECT::default();
    unsafe {
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut _ as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        );
    }
    Bounds { x: r.left, y: r.top, width: (r.right - r.left).max(0), height: (r.bottom - r.top).max(0) }
}

/// Describe one window, or `None` when it is not something an agent may see:
/// invisible, cloaked (another virtual desktop, a suspended UWP app), untitled,
/// Spacron's own, or on the never-targetable list.
fn describe(hwnd: HWND, foreground: HWND) -> Option<WindowInfo> {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut c_void, 4);
        if cloaked != 0 {
            return None;
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len <= 0 {
            return None;
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);

        // The shell's desktop ("Program Manager") and taskbar are top-level
        // windows too, but not apps: nothing to read, and capture fails on them.
        let mut class = [0u16; 64];
        let class_len = GetClassNameW(hwnd, &mut class);
        if class_len > 0 {
            let class = String::from_utf16_lossy(&class[..class_len as usize]);
            if SHELL_CLASSES.contains(&class.as_str()) {
                return None;
            }
        }
        // Tool windows (overlays, floating palettes) are left out of Alt-Tab
        // for the same reason: they are not something a user thinks of as an
        // open app. Their owning app's main window is still listed.
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex_style & WS_EX_TOOLWINDOW.0 != 0 && ex_style & WS_EX_APPWINDOW.0 == 0 {
            return None;
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return None;
        }
        let image = process_image(pid).unwrap_or_default();
        let process = image.rsplit(['\\', '/']).next().unwrap_or("").to_string();
        let lower = process.to_ascii_lowercase();
        if NEVER_TARGETABLE.contains(&lower.as_str())
            || own_exe_name().as_deref() == Some(lower.as_str())
            || user_denied(&lower)
        {
            return None;
        }

        Some(WindowInfo {
            id: (hwnd.0 as isize).to_string(),
            title,
            process,
            process_path: image,
            pid,
            bounds: frame_bounds(hwnd),
            focused: hwnd == foreground,
            minimized: IsIconic(hwnd).as_bool(),
        })
    }
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<HWND>);
    out.push(hwnd);
    TRUE
}

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let _scope = ThreadScope::enter();
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(Some(collect_window), LPARAM(&mut handles as *mut _ as isize))
            .map_err(|e| format!("Could not enumerate windows: {e}"))?;
    }
    let foreground = unsafe { GetForegroundWindow() };
    Ok(handles.into_iter().filter_map(|h| describe(h, foreground)).collect())
}

/// Resolve an id to a window an agent may see, or say why not.
pub fn window(id: &str) -> Result<WindowInfo, String> {
    let _scope = ThreadScope::enter();
    let hwnd = hwnd_from_id(id)?;
    describe(hwnd, unsafe { GetForegroundWindow() }).ok_or_else(|| {
        format!("Window {id} is not available to agents (hidden, Spacron's own, or a protected app).")
    })
}

// ---------------------------------------------------------------------------
// The UI Automation worker
// ---------------------------------------------------------------------------
//
// Every UIA read and every act runs on ONE long-lived thread. Two reasons:
//
// - Element refs (`e12`) have to outlive the call that printed them, so the
//   `IUIAutomationElement`s behind them must live in a COM apartment that stays
//   initialised. A blocking-pool thread uninitialises COM when it is done.
// - Acts must never overlap. A click racing a keystroke lands somewhere nobody
//   intended; a single queue makes them sequential by construction.

type Job = Box<dyn FnOnce(&mut Worker) + Send>;

static WORKER: std::sync::OnceLock<std::sync::Mutex<std::sync::mpsc::Sender<Job>>> =
    std::sync::OnceLock::new();

/// Run `f` on the UIA worker and wait for its answer.
pub async fn on_worker<T: Send + 'static>(
    f: impl FnOnce(&mut Worker) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let job: Job = Box::new(move |w| {
        let _ = tx.send(f(w));
    });
    let sender = WORKER.get_or_init(|| std::sync::Mutex::new(spawn_worker()));
    sender
        .lock()
        .map_err(|_| "The computer-use worker is unavailable.".to_string())?
        .send(job)
        .map_err(|_| "The computer-use worker stopped.".to_string())?;
    rx.await.map_err(|_| "The computer-use worker dropped the request.".to_string())?
}

/// Queue `f` on the worker without waiting for it (clean-up work).
pub fn post(f: impl FnOnce(&mut Worker) + Send + 'static) {
    if let Some(sender) = WORKER.get() {
        if let Ok(sender) = sender.lock() {
            let _ = sender.send(Box::new(f));
        }
    }
}

fn spawn_worker() -> std::sync::mpsc::Sender<Job> {
    let (tx, rx) = std::sync::mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name("spacron-desktop".into())
        .spawn(move || {
            // Never undone: this thread lives as long as the app.
            let _scope = ThreadScope::enter();
            let mut worker = Worker { ui: None, cache: None, refs: HashMap::new() };
            while let Ok(job) = rx.recv() {
                // A panic in one job must not take the queue down with it.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut worker)));
            }
        })
        .expect("spawn computer-use worker");
    tx
}

/// Which snapshot a ref came from. `desktop_ui_tree` refs are `e…`,
/// `desktop_find` refs are `f…`; each walk replaces only its own kind, so a
/// search does not invalidate the refs of a tree the agent is still reading.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefKind {
    Tree,
    Find,
}

impl RefKind {
    fn prefix(self) -> char {
        match self {
            RefKind::Tree => 'e',
            RefKind::Find => 'f',
        }
    }
}

pub struct Worker {
    ui: Option<IUIAutomation>,
    cache: Option<IUIAutomationCacheRequest>,
    /// (caller, window, kind) → the elements of the last walk, index = ref number.
    refs: HashMap<(String, String, RefKind), Vec<IUIAutomationElement>>,
}

/// Most snapshots kept at once. Each holds COM references into another
/// process; a caller that walks many windows should not pin them all forever.
const MAX_SNAPSHOTS: usize = 32;

impl Worker {
    fn ui(&mut self) -> Result<IUIAutomation, String> {
        if self.ui.is_none() {
            self.ui = Some(automation()?);
        }
        Ok(self.ui.clone().unwrap())
    }

    fn cache(&mut self) -> Result<IUIAutomationCacheRequest, String> {
        if self.cache.is_none() {
            let ui = self.ui()?;
            self.cache = Some(cache_request(&ui)?);
        }
        Ok(self.cache.clone().unwrap())
    }

    /// Forget every snapshot a caller holds (its grants ended).
    pub fn forget_caller(&mut self, caller: &str) {
        self.refs.retain(|(c, _, _), _| c != caller);
    }

    fn element(&self, caller: &str, window: &str, r: &str) -> Result<IUIAutomationElement, String> {
        let r = r.trim();
        let kind = match r.chars().next() {
            Some('e') => RefKind::Tree,
            Some('f') => RefKind::Find,
            _ => return Err(format!("'{r}' is not a ref. Refs look like e12 (from desktop_ui_tree) or f3 (from desktop_find).")),
        };
        let index: usize = r[1..]
            .parse()
            .map_err(|_| format!("'{r}' is not a ref. Refs look like e12 or f3."))?;
        self.refs
            .get(&(caller.to_string(), window.to_string(), kind))
            .and_then(|v| v.get(index))
            .cloned()
            .ok_or_else(|| {
                format!("Ref {r} is not from the latest read of window {window}. Call desktop_ui_tree or desktop_find again.")
            })
    }
}

// ---------------------------------------------------------------------------
// UI Automation
// ---------------------------------------------------------------------------

/// One element of a walked tree, already flattened to what we print.
pub struct Node {
    pub depth: usize,
    /// e.g. `e12`; see [`RefKind`].
    pub reference: String,
    pub role: &'static str,
    pub name: String,
    pub value: Option<String>,
    pub automation_id: String,
    pub enabled: bool,
    pub focused: bool,
    pub offscreen: bool,
    /// Element centre, normalized 0–1 within the window frame. `None` when the
    /// element has no on-screen rectangle.
    pub at: Option<(f64, f64)>,
}

/// How long UIA may wait on a target that is slow or hung. Without these the
/// defaults let one frozen app stall the call for far longer than any agent's
/// tool timeout.
const UIA_CONNECTION_TIMEOUT_MS: u32 = 2_000;
const UIA_TRANSACTION_TIMEOUT_MS: u32 = 5_000;

/// Longest text we return for a name or value. Documents and chat logs expose
/// their whole contents as a value; the agent needs to know it is there, not
/// read all of it through a tree dump.
const MAX_TEXT_CHARS: usize = 200;

fn clip(s: &str) -> String {
    let s = s.replace(['\r', '\n'], " ");
    if s.chars().count() <= MAX_TEXT_CHARS {
        s
    } else {
        let mut out: String = s.chars().take(MAX_TEXT_CHARS).collect();
        out.push('…');
        out
    }
}

pub fn role_name(control_type: i32) -> &'static str {
    match control_type {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Element",
    }
}

fn automation() -> Result<IUIAutomation, String> {
    unsafe {
        // CUIAutomation8 exposes IUIAutomation2, which is where the timeouts live.
        let ui: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
            .map_err(|e| format!("UI Automation is unavailable: {e}"))?;
        if let Ok(ui2) = windows::core::Interface::cast::<IUIAutomation2>(&ui) {
            let _ = ui2.SetConnectionTimeout(UIA_CONNECTION_TIMEOUT_MS);
            let _ = ui2.SetTransactionTimeout(UIA_TRANSACTION_TIMEOUT_MS);
        }
        Ok(ui)
    }
}

/// One cache request for every property we print, so each element costs one
/// cross-process round-trip instead of one per property. Uncached, the spike
/// measured 12–20 ms per element — seconds for a real app.
fn cache_request(ui: &IUIAutomation) -> Result<IUIAutomationCacheRequest, String> {
    unsafe {
        let cr = ui.CreateCacheRequest().map_err(|e| e.to_string())?;
        for prop in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
            UIA_AutomationIdPropertyId,
            UIA_IsEnabledPropertyId,
            UIA_HasKeyboardFocusPropertyId,
            UIA_IsOffscreenPropertyId,
            UIA_IsPasswordPropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_ValueValuePropertyId,
        ] {
            cr.AddProperty(prop).map_err(|e| e.to_string())?;
        }
        cr.AddPattern(UIA_ValuePatternId).map_err(|e| e.to_string())?;
        Ok(cr)
    }
}

fn node_of(el: &IUIAutomationElement, depth: usize, reference: String, frame: &Bounds) -> Node {
    unsafe {
        let name = el.CachedName().map(|b| b.to_string()).unwrap_or_default();
        let control_type = el.CachedControlType().map(|c| c.0).unwrap_or(0);
        let password = el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false);
        let value = if password {
            // Never returned, whatever it holds — see docs/computer-use.md.
            Some("[password field — value hidden]".to_string())
        } else {
            el.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|p| p.CachedValue())
                .map(|b| b.to_string())
                .ok()
                .filter(|v| !v.is_empty())
                .map(|v| clip(&v))
        };
        let at = el.CachedBoundingRectangle().ok().and_then(|r| normalize_rect_centre(&r, frame));
        Node {
            depth,
            reference,
            role: role_name(control_type),
            name: clip(&name),
            value,
            automation_id: el.CachedAutomationId().map(|b| b.to_string()).unwrap_or_default(),
            enabled: el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
            focused: el.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
            offscreen: el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
            at,
        }
    }
}

fn normalize_rect_centre(r: &RECT, frame: &Bounds) -> Option<(f64, f64)> {
    if r.right <= r.left || r.bottom <= r.top || frame.width <= 0 || frame.height <= 0 {
        return None;
    }
    let cx = (r.left + r.right) as f64 / 2.0;
    let cy = (r.top + r.bottom) as f64 / 2.0;
    Some(((cx - frame.x as f64) / frame.width as f64, (cy - frame.y as f64) / frame.height as f64))
}

/// Walk a window's control view depth-first, bounded by depth, node count and
/// wall time, and remember the elements so their refs can be acted on. Returns
/// the nodes and whether any bound cut the walk short. Runs on the worker.
pub fn walk(
    w: &mut Worker,
    caller: &str,
    id: &str,
    kind: RefKind,
    limits: TreeLimits,
) -> Result<(WindowInfo, Vec<Node>, bool), String> {
    let hwnd = hwnd_from_id(id)?;
    let info = describe(hwnd, unsafe { GetForegroundWindow() }).ok_or_else(|| {
        format!("Window {id} is not available to agents (hidden, Spacron's own, or a protected app).")
    })?;

    let ui = w.ui()?;
    let cr = w.cache()?;
    let started = Instant::now();
    let deadline = Duration::from_millis(limits.time_budget_ms);
    let mut nodes = Vec::new();
    let mut elements = Vec::new();
    let mut truncated = false;

    unsafe {
        let walker = ui.ControlViewWalker().map_err(|e| e.to_string())?;
        let root = ui
            .ElementFromHandleBuildCache(hwnd, &cr)
            .map_err(|e| format!("Could not read window {id} through UI Automation: {e}"))?;

        // Explicit stack instead of recursion: a pathological tree must not be
        // able to overflow the worker's stack.
        let mut stack: Vec<(IUIAutomationElement, usize)> = vec![(root, 0)];
        while let Some((el, depth)) = stack.pop() {
            if nodes.len() >= limits.max_nodes || started.elapsed() > deadline {
                truncated = true;
                break;
            }
            let reference = format!("{}{}", kind.prefix(), nodes.len());
            nodes.push(node_of(&el, depth, reference, &info.bounds));
            elements.push(el.clone());
            if depth >= limits.max_depth {
                if walker.GetFirstChildElement(&el).is_ok() {
                    truncated = true;
                }
                continue;
            }
            let mut children = Vec::new();
            let mut child = walker.GetFirstChildElementBuildCache(&el, &cr).ok();
            while let Some(c) = child {
                child = walker.GetNextSiblingElementBuildCache(&c, &cr).ok();
                children.push(c);
                if children.len() + nodes.len() > limits.max_nodes {
                    truncated = true;
                    break;
                }
            }
            // Reverse so the first child is popped first: output stays in
            // reading order.
            for c in children.into_iter().rev() {
                stack.push((c, depth + 1));
            }
        }
    }

    if w.refs.len() >= MAX_SNAPSHOTS {
        w.refs.clear();
    }
    w.refs.insert((caller.to_string(), info.id.clone(), kind), elements);
    Ok((info, nodes, truncated))
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

pub use super::{Act, MouseButton, Point};

/// Is `pid` running elevated? A non-elevated process cannot send input to an
/// elevated one (UIPI): Windows drops it silently, so we refuse up front
/// instead of reporting a click that never happened.
fn is_elevated(pid: u32) -> Option<bool> {
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::OpenProcessToken;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut token = windows::Win32::Foundation::HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok();
        let _ = CloseHandle(process);
        if !opened {
            return None;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok.then_some(elevation.TokenIsElevated != 0)
    }
}

fn refuse_if_elevated(info: &WindowInfo) -> Result<(), String> {
    let theirs = is_elevated(info.pid);
    let ours = is_elevated(std::process::id()).unwrap_or(false);
    // `None` for theirs means we could not even open its token — which is what
    // an elevated process looks like from a normal one.
    if !ours && theirs != Some(false) {
        return Err(format!(
            "\"{}\" is running as administrator, and Windows blocks input to it from Spacron. \
             Ask the user to do this step themselves.",
            info.title
        ));
    }
    Ok(())
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

/// Bring the target to the foreground, and fail rather than guess if Windows
/// will not let us: typing into whatever *did* take focus is the failure this
/// check exists to prevent. The window's own dialogs and menus count as the
/// target (see [`belongs_to_target`]).
fn ensure_foreground(info: &WindowInfo) -> Result<(), String> {
    let hwnd = hwnd_from_id(&info.id)?;
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let owns_foreground = || belongs_to_target(GetForegroundWindow(), info);
        if owns_foreground() {
            return Ok(());
        }
        let _ = SetForegroundWindow(hwnd);
        std::thread::sleep(Duration::from_millis(120));
        if owns_foreground() {
            return Ok(());
        }
        // Foreground lock: Windows only lets the process that owns the input
        // queue change the foreground. Joining the current foreground thread's
        // input queue for the moment of the switch makes us part of it. (The
        // usual "press ALT first" trick is not used: that ALT goes to whatever
        // app is in front, which is not the window the agent was granted, and
        // opens its menu bar.)
        let foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let me = windows::Win32::System::Threading::GetCurrentThreadId();
        if foreground_thread != 0 && foreground_thread != me {
            let attached = windows::Win32::System::Threading::AttachThreadInput(me, foreground_thread, true).as_bool();
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            if attached {
                let _ = windows::Win32::System::Threading::AttachThreadInput(me, foreground_thread, false);
            }
            std::thread::sleep(Duration::from_millis(120));
            if owns_foreground() {
                return Ok(());
            }
        }
    }
    Err(format!(
        "Windows would not bring \"{}\" to the front, so nothing was sent. Ask the user to click on it, then try again.",
        info.title
    ))
}

/// Whether `h` is the granted window, one of its own dialogs (owned by it), or
/// a popup menu of the same process. Another top-level window of the same app
/// (a second browser window, say) is NOT the target: the grant was for one
/// window.
fn belongs_to_target(h: HWND, info: &WindowInfo) -> bool {
    let Ok(target) = hwnd_from_id(&info.id) else { return false };
    if h == target {
        return true;
    }
    unsafe {
        if GetAncestor(h, GA_ROOTOWNER) == target {
            return true;
        }
        let mut class = [0u16; 16];
        let len = GetClassNameW(h, &mut class);
        let is_menu = len > 0 && String::from_utf16_lossy(&class[..len as usize]) == "#32768";
        is_menu && window_pid(h) == info.pid
    }
}

/// The top-level window a real click at (x, y) would reach. Click-through
/// windows are skipped, because a real click passes through them; that is how
/// the control indicator stays out of the way. Our OTHER windows are not
/// skipped: if Spacron itself is on top of the target, the click would land on
/// Spacron (on its permission dialog, say), and it must be refused.
fn window_at(x: i32, y: i32) -> Option<HWND> {
    unsafe {
        let mut h = GetTopWindow(None).ok()?;
        loop {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
            let mut cloaked: u32 = 0;
            let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut c_void, 4);
            let mut r = RECT::default();
            if IsWindowVisible(h).as_bool()
                && cloaked == 0
                && ex & WS_EX_TRANSPARENT.0 == 0
                && GetWindowRect(h, &mut r).is_ok()
                && x >= r.left
                && x < r.right
                && y >= r.top
                && y < r.bottom
            {
                return Some(h);
            }
            h = GetWindow(h, GW_HWNDNEXT).ok()?;
        }
    }
}

fn check_hit(info: &WindowInfo, x: i32, y: i32) -> Result<(), String> {
    match window_at(x, y) {
        Some(h) if belongs_to_target(h, info) => Ok(()),
        _ => Err(format!(
            "Something else is on top of \"{}\" at that point, so the click was not sent. \
             Use desktop_focus_window, or target a ref instead of coordinates.",
            info.title
        )),
    }
}

fn to_screen(info: &WindowInfo, p: (f64, f64)) -> Result<(i32, i32), String> {
    let (x, y) = p;
    if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) || x.is_nan() || y.is_nan() {
        return Err("Coordinates are normalized to the window: x and y must be between 0 and 1.".into());
    }
    let b = &info.bounds;
    let px = b.x + ((x * b.width as f64).round() as i32).clamp(0, (b.width - 1).max(0));
    let py = b.y + ((y * b.height as f64).round() as i32).clamp(0, (b.height - 1).max(0));
    Ok((px, py))
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err("Windows blocked the input (another program may be holding the desktop).".into());
    }
    Ok(())
}

fn key_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn is_extended(vk: VIRTUAL_KEY) -> bool {
    matches!(
        vk,
        VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_INSERT | VK_DELETE
    )
}

fn unicode_input(unit: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn mouse_input(x: i32, y: i32, flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);
        // Absolute coordinates are 0..65535 across the whole virtual desktop.
        let ax = (((x - vx) as f64 + 0.5) * 65535.0 / vw as f64).round() as i32;
        let ay = (((y - vy) as f64 + 0.5) * 65535.0 / vh as f64).round() as i32;
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: ax,
                    dy: ay,
                    mouseData: data as u32,
                    dwFlags: flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
}

fn click_at(x: i32, y: i32, button: MouseButton, double: bool) -> Result<(), String> {
    let (down, up) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    let mut inputs = vec![mouse_input(x, y, MOUSEEVENTF_MOVE, 0)];
    for _ in 0..if double { 2 } else { 1 } {
        inputs.push(mouse_input(x, y, down, 0));
        inputs.push(mouse_input(x, y, up, 0));
    }
    send(&inputs)
}

/// Put the pointer back where the user left it: an agent borrowing the mouse
/// should not leave it somewhere surprising.
struct CursorRestore(POINT);

impl CursorRestore {
    fn save() -> Self {
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        Self(p)
    }
}

impl Drop for CursorRestore {
    fn drop(&mut self) {
        unsafe {
            let _ = SetCursorPos(self.0.x, self.0.y);
        }
    }
}

/// Parse `ctrl+shift+s`, `enter`, `f5`, `a`. Refuses combinations that would
/// take input out of the granted window (the Windows key, Alt+Tab, Ctrl+Esc)
/// or reach system surfaces (Ctrl+Alt+Del, Ctrl+Shift+Esc), and the kill
/// switch itself.
pub fn parse_keys(combo: &str) -> Result<Vec<VIRTUAL_KEY>, String> {
    let parts: Vec<String> = combo
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("desktop_key needs 'keys', e.g. \"enter\" or \"ctrl+s\".".into());
    }
    let mut keys = Vec::new();
    for p in &parts {
        let vk = match p.as_str() {
            "ctrl" | "control" => VK_CONTROL,
            "shift" => VK_SHIFT,
            "alt" => VK_MENU,
            "win" | "windows" | "meta" | "super" | "cmd" => {
                return Err("The Windows key is not allowed: it opens things outside the granted window.".into())
            }
            "enter" | "return" => VK_RETURN,
            "tab" => VK_TAB,
            "esc" | "escape" => VK_ESCAPE,
            "space" => VK_SPACE,
            "backspace" => VK_BACK,
            "delete" | "del" => VK_DELETE,
            "insert" | "ins" => VK_INSERT,
            "home" => VK_HOME,
            "end" => VK_END,
            "pageup" | "pgup" => VK_PRIOR,
            "pagedown" | "pgdn" => VK_NEXT,
            "up" => VK_UP,
            "down" => VK_DOWN,
            "left" => VK_LEFT,
            "right" => VK_RIGHT,
            "f1" => VK_F1,
            "f2" => VK_F2,
            "f3" => VK_F3,
            "f4" => VK_F4,
            "f5" => VK_F5,
            "f6" => VK_F6,
            "f7" => VK_F7,
            "f8" => VK_F8,
            "f9" => VK_F9,
            "f10" => VK_F10,
            "f11" => VK_F11,
            "f12" => VK_F12,
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphanumeric() => {
                VIRTUAL_KEY(s.as_bytes()[0].to_ascii_uppercase() as u16)
            }
            other => return Err(format!("Unknown key '{other}'.")),
        };
        keys.push(vk);
    }
    let has = |vk: VIRTUAL_KEY| keys.contains(&vk);
    let blocked = (has(VK_MENU) && has(VK_TAB))
        || (has(VK_CONTROL) && has(VK_ESCAPE))
        || (has(VK_CONTROL) && has(VK_MENU) && has(VK_DELETE))
        || (has(VK_MENU) && has(VK_ESCAPE))
        || (has(VK_MENU) && has(VK_F4));
    if blocked {
        return Err(format!(
            "'{combo}' is not allowed: it switches away from, closes, or escapes the granted window, or is the stop shortcut."
        ));
    }
    // Paste would put whatever is on the user's clipboard (possibly a password)
    // into an app the agent controls.
    let paste = (has(VK_CONTROL) && has(VIRTUAL_KEY(b'V' as u16))) || (has(VK_SHIFT) && has(VK_INSERT));
    if paste {
        return Err("Pasting is not allowed: the clipboard may hold something private. Use desktop_type with the text instead.".into());
    }
    Ok(keys)
}

/// Where a pointer action lands: a ref's centre, a normalized point, or the
/// middle of the window.
fn resolve_point(w: &Worker, caller: &str, info: &WindowInfo, p: &Point) -> Result<(i32, i32), String> {
    match p {
        Point::Ref(r) => {
            let el = w.element(caller, &info.id, r)?;
            check_element_owner(&el, info)?;
            let rect = unsafe { el.CurrentBoundingRectangle() }.map_err(stale)?;
            if rect.right <= rect.left || rect.bottom <= rect.top {
                return Err(format!("{r} has no on-screen area (it may be scrolled out of view)."));
            }
            Ok(((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))
        }
        Point::At(x, y) => to_screen(info, (*x, *y)),
        Point::Centre => to_screen(info, (0.5, 0.5)),
    }
}

fn stale(e: windows::core::Error) -> String {
    format!("That element is no longer available ({e}). Read the window again.")
}

/// A ref must still belong to the granted window's process. Elements can be
/// re-parented or recycled; acting on one that moved to another app would be
/// acting outside the grant.
fn check_element_owner(el: &IUIAutomationElement, info: &WindowInfo) -> Result<(), String> {
    let pid = unsafe { el.CurrentProcessId() }.map_err(stale)?;
    if pid as u32 != info.pid {
        return Err("That element no longer belongs to the granted window.".into());
    }
    Ok(())
}

/// Keystrokes go wherever keyboard focus is. Right before sending any, make
/// sure that is inside the granted window and not a password field.
fn check_focus(w: &mut Worker, info: &WindowInfo) -> Result<(), String> {
    let ui = w.ui()?;
    if let Ok(focused) = unsafe { ui.GetFocusedElement() } {
        if is_password(&focused) {
            return Err("Keyboard focus is in a password field. Agents may not type into password fields.".into());
        }
        let pid = unsafe { focused.CurrentProcessId() }.unwrap_or(0) as u32;
        if pid != info.pid {
            return Err("Keyboard focus is not in the granted window, so nothing was sent.".into());
        }
    }
    if !belongs_to_target(unsafe { GetForegroundWindow() }, info) {
        return Err("The granted window lost the foreground, so nothing was sent.".into());
    }
    Ok(())
}

fn is_password(el: &IUIAutomationElement) -> bool {
    unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(true)
}

/// Carry out one act. Runs on the worker, so acts are strictly sequential.
/// Returns a one-line description of what happened, for the agent and the log.
pub fn act(w: &mut Worker, caller: &str, info: &WindowInfo, action: &Act) -> Result<String, String> {
    // Re-describe: the window may have moved, closed, or changed hands since the
    // grant check read it.
    let hwnd = hwnd_from_id(&info.id)?;
    let fresh = describe(hwnd, unsafe { GetForegroundWindow() })
        .ok_or_else(|| "The window is no longer available.".to_string())?;
    if fresh.pid != info.pid {
        return Err("The window now belongs to a different process; nothing was sent.".into());
    }
    let info = &fresh;

    match action {
        Act::Focus => {
            refuse_if_elevated(info)?;
            ensure_foreground(info)?;
            Ok(format!("\"{}\" is now in front.", info.title))
        }

        Act::Click { at, button, double } => {
            // Prefer acting on the element itself: no pointer, no focus, immune
            // to DPI and to whatever is lying on top.
            if let (Point::Ref(r), MouseButton::Left, false) = (at, button, double) {
                let el = w.element(caller, &info.id, r)?;
                check_element_owner(&el, info)?;
                if let Some(done) = invoke_by_pattern(&el)? {
                    return Ok(format!("{done} {r}."));
                }
            }
            refuse_if_elevated(info)?;
            let (x, y) = resolve_point(w, caller, info, at)?;
            ensure_foreground(info)?;
            check_hit(info, x, y)?;
            let _restore = CursorRestore::save();
            click_at(x, y, *button, *double)?;
            Ok(format!(
                "{} {}-clicked at {}.",
                if *double { "Double" } else { "Single" },
                button.name(),
                describe_point(at)
            ))
        }

        Act::Type { at, text, replace } => {
            if let Some(r) = at {
                let el = w.element(caller, &info.id, r)?;
                check_element_owner(&el, info)?;
                if is_password(&el) {
                    return Err("That is a password field. Agents may not type into password fields.".into());
                }
                if *replace {
                    if let Ok(vp) = unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) } {
                        let read_only = unsafe { vp.CurrentIsReadOnly() }.map(|b| b.as_bool()).unwrap_or(true);
                        if !read_only {
                            unsafe { vp.SetValue(&windows::core::BSTR::from(text.as_str())) }.map_err(stale)?;
                            return Ok(format!("Set the value of {r} ({} characters).", text.chars().count()));
                        }
                    }
                }
                refuse_if_elevated(info)?;
                ensure_foreground(info)?;
                unsafe { el.SetFocus() }.map_err(stale)?;
                std::thread::sleep(Duration::from_millis(60));
            } else {
                refuse_if_elevated(info)?;
                ensure_foreground(info)?;
            }
            // Whatever has focus now is where the keystrokes go; check it again.
            check_focus(w, info)?;
            if *replace {
                send(&[
                    key_input(VK_CONTROL, false),
                    key_input(VIRTUAL_KEY(b'A' as u16), false),
                    key_input(VIRTUAL_KEY(b'A' as u16), true),
                    key_input(VK_CONTROL, true),
                ])?;
            }
            let mut inputs = Vec::new();
            for unit in text.encode_utf16() {
                match unit {
                    // Newlines and tabs as real keys: many controls ignore them
                    // as Unicode input.
                    0x0A => {
                        inputs.push(key_input(VK_RETURN, false));
                        inputs.push(key_input(VK_RETURN, true));
                    }
                    0x0D => {}
                    0x09 => {
                        inputs.push(key_input(VK_TAB, false));
                        inputs.push(key_input(VK_TAB, true));
                    }
                    u => {
                        inputs.push(unicode_input(u, false));
                        inputs.push(unicode_input(u, true));
                    }
                }
            }
            send(&inputs)?;
            Ok(format!("Typed {} characters.", text.chars().count()))
        }

        Act::Key { keys } => {
            let vks = parse_keys(keys)?;
            refuse_if_elevated(info)?;
            ensure_foreground(info)?;
            check_focus(w, info)?;
            let mut inputs: Vec<INPUT> = vks.iter().map(|vk| key_input(*vk, false)).collect();
            inputs.extend(vks.iter().rev().map(|vk| key_input(*vk, true)));
            send(&inputs)?;
            Ok(format!("Pressed {keys}."))
        }

        Act::Scroll { at, dx, dy } => {
            if let Point::Ref(r) = at {
                let el = w.element(caller, &info.id, r)?;
                check_element_owner(&el, info)?;
                if let Ok(sp) = unsafe { el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) } {
                    let step = |d: i32| {
                        if d > 0 {
                            ScrollAmount_SmallIncrement
                        } else if d < 0 {
                            ScrollAmount_SmallDecrement
                        } else {
                            ScrollAmount_NoAmount
                        }
                    };
                    for i in 0..dx.abs().max(dy.abs()) {
                        let h = if i < dx.abs() { step(*dx) } else { ScrollAmount_NoAmount };
                        let v = if i < dy.abs() { step(*dy) } else { ScrollAmount_NoAmount };
                        unsafe { sp.Scroll(h, v) }.map_err(stale)?;
                    }
                    return Ok(format!("Scrolled {r} by {dx},{dy} steps."));
                }
            }
            refuse_if_elevated(info)?;
            let (x, y) = resolve_point(w, caller, info, at)?;
            ensure_foreground(info)?;
            check_hit(info, x, y)?;
            let _restore = CursorRestore::save();
            let mut inputs = vec![mouse_input(x, y, MOUSEEVENTF_MOVE, 0)];
            // Positive dy scrolls down, like the page moving under the finger;
            // the wheel's positive direction is away from the user (up).
            if *dy != 0 {
                inputs.push(mouse_input(x, y, MOUSEEVENTF_WHEEL, -dy * 120));
            }
            if *dx != 0 {
                inputs.push(mouse_input(x, y, MOUSEEVENTF_HWHEEL, dx * 120));
            }
            send(&inputs)?;
            Ok(format!("Scrolled at {} by {dx},{dy} notches.", describe_point(at)))
        }

        Act::Drag { from, to } => {
            refuse_if_elevated(info)?;
            let (x1, y1) = resolve_point(w, caller, info, from)?;
            let (x2, y2) = resolve_point(w, caller, info, to)?;
            ensure_foreground(info)?;
            check_hit(info, x1, y1)?;
            check_hit(info, x2, y2)?;
            let _restore = CursorRestore::save();
            let mut inputs = vec![mouse_input(x1, y1, MOUSEEVENTF_MOVE, 0), mouse_input(x1, y1, MOUSEEVENTF_LEFTDOWN, 0)];
            // Intermediate moves: many apps only start a drag after the pointer
            // has travelled a few pixels with the button held.
            for i in 1..=10 {
                let t = i as f64 / 10.0;
                let x = x1 + ((x2 - x1) as f64 * t).round() as i32;
                let y = y1 + ((y2 - y1) as f64 * t).round() as i32;
                inputs.push(mouse_input(x, y, MOUSEEVENTF_MOVE, 0));
            }
            inputs.push(mouse_input(x2, y2, MOUSEEVENTF_LEFTUP, 0));
            send(&inputs)?;
            Ok(format!("Dragged from {} to {}.", describe_point(from), describe_point(to)))
        }
    }
}

fn describe_point(p: &Point) -> String {
    match p {
        Point::Ref(r) => r.clone(),
        Point::At(x, y) => format!("({x:.3}, {y:.3})"),
        Point::Centre => "the window centre".into(),
    }
}

/// Click an element through its automation pattern, when it has one that means
/// "activate". `Ok(None)` means none applies and a real click is needed.
fn invoke_by_pattern(el: &IUIAutomationElement) -> Result<Option<&'static str>, String> {
    unsafe {
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            // A button that opens a modal dialog can hold Invoke until the
            // transaction timeout; the click has still happened.
            return match p.Invoke() {
                Ok(()) => Ok(Some("Invoked")),
                Err(e) if e.code() == windows::Win32::Foundation::E_FAIL => Ok(Some("Invoked (the app is slow to respond; it may have opened a dialog)")),
                Err(e) => Err(stale(e)),
            };
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            p.Toggle().map_err(stale)?;
            return Ok(Some("Toggled"));
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            p.Select().map_err(stale)?;
            return Ok(Some("Selected"));
        }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            let state = p.CurrentExpandCollapseState().map_err(stale)?;
            if state == ExpandCollapseState_Collapsed {
                p.Expand().map_err(stale)?;
                return Ok(Some("Expanded"));
            }
            p.Collapse().map_err(stale)?;
            return Ok(Some("Collapsed"));
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/// Capture one window's own pixels (not the screen region it covers, which
/// would include whatever other app is lying on top of it), cropped to the
/// same frame rectangle that normalized coordinates are measured against — so
/// a point picked from the screenshot is the point a click lands on.
pub fn capture(id: &str) -> Result<(WindowInfo, image::RgbaImage), String> {
    let info = window(id)?;
    if info.minimized {
        return Err(format!("Window {id} is minimised, so there is nothing to capture."));
    }
    let _scope = ThreadScope::enter();
    let wanted: u32 = info
        .id
        .parse::<isize>()
        .map(|v| v as u32)
        .map_err(|_| "bad window id".to_string())?;
    let windows = xcap::Window::all().map_err(|e| format!("Could not list windows for capture: {e}"))?;
    let target = windows
        .into_iter()
        .find(|w| w.id().map(|v| v == wanted).unwrap_or(false))
        .ok_or_else(|| format!("Window {id} could not be found for capture."))?;
    let origin = (target.x().unwrap_or(info.bounds.x), target.y().unwrap_or(info.bounds.y));
    let img = target.capture_image().map_err(|e| format!("Could not capture window {id}: {e}"))?;
    // xcap links its own `image`; round-trip through raw bytes so the two crate
    // versions never have to agree on a type.
    let (w, h) = (img.width(), img.height());
    let img = image::RgbaImage::from_raw(w, h, img.into_raw())
        .ok_or_else(|| "The captured image had an unexpected size.".to_string())?;

    // Crop to the DWM frame. The spike measured the capture a few pixels off the
    // frame (507×316 frame, 500×314 capture); without this, coordinates read off
    // a screenshot miss by that much.
    let b = &info.bounds;
    let left = (b.x - origin.0).clamp(0, w as i32) as u32;
    let top = (b.y - origin.1).clamp(0, h as i32) as u32;
    let right = ((b.x + b.width - origin.0).clamp(0, w as i32) as u32).max(left);
    let bottom = ((b.y + b.height - origin.1).clamp(0, h as i32) as u32).max(top);
    let img = if right - left >= 1 && bottom - top >= 1 && (left, top, right, bottom) != (0, 0, w, h) {
        image::imageops::crop_imm(&img, left, top, right - left, bottom - top).to_image()
    } else {
        img
    };
    Ok((info, img))
}

// ---------------------------------------------------------------------------
// The guard: kill switch and "the user is using the computer"
// ---------------------------------------------------------------------------
//
// One thread, alive while computer use is switched on. It registers the global
// stop shortcut and low-level mouse/keyboard hooks. The hooks store only a
// timestamp — never which key or where — and tell real input from ours by the
// INJECTED flag Windows sets on everything SendInput produces.

static LAST_REAL_INPUT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static GUARD_THREAD: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);
type KillFn = std::sync::Arc<dyn Fn() + Send + Sync>;
static KILL_FN: std::sync::OnceLock<std::sync::Mutex<Option<KillFn>>> =
    std::sync::OnceLock::new();

const KILL_HOTKEY_ID: i32 = 0x5C01;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Milliseconds since the user last touched the mouse or keyboard themselves,
/// or `None` if the guard has not seen any real input.
pub fn ms_since_real_input() -> Option<u64> {
    match LAST_REAL_INPUT_MS.load(std::sync::atomic::Ordering::SeqCst) {
        0 => None,
        t => Some(now_ms().saturating_sub(t)),
    }
}

unsafe extern "system" fn guard_mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(l.0 as *const MSLLHOOKSTRUCT);
        if info.flags & LLMHF_INJECTED == 0 {
            LAST_REAL_INPUT_MS.store(now_ms(), std::sync::atomic::Ordering::SeqCst);
        }
    }
    CallNextHookEx(None, code, w, l)
}

unsafe extern "system" fn guard_keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(l.0 as *const KBDLLHOOKSTRUCT);
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            LAST_REAL_INPUT_MS.store(now_ms(), std::sync::atomic::Ordering::SeqCst);
        }
    }
    CallNextHookEx(None, code, w, l)
}

/// Start the guard (idempotent). `on_kill` runs on the guard thread when the
/// user presses the stop shortcut. Returns whether the shortcut registered —
/// another app may already own it.
pub fn start_guard(on_kill: KillFn) -> bool {
    *KILL_FN.get_or_init(|| std::sync::Mutex::new(None)).lock().unwrap() = Some(on_kill);
    let mut slot = GUARD_THREAD.lock().unwrap();
    if slot.is_some() {
        return true;
    }
    let (tx, rx) = std::sync::mpsc::channel::<(u32, bool)>();
    let spawned = std::thread::Builder::new().name("spacron-desktop-guard".into()).spawn(move || unsafe {
        let thread_id = windows::Win32::System::Threading::GetCurrentThreadId();
        let hotkey = RegisterHotKey(None, KILL_HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_ESCAPE.0 as u32).is_ok();
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(guard_mouse), None, 0).ok();
        let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(guard_keyboard), None, 0).ok();
        let _ = tx.send((thread_id, hotkey));
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == KILL_HOTKEY_ID {
                let kill = KILL_FN.get().and_then(|m| m.lock().ok().and_then(|g| g.clone()));
                if let Some(kill) = kill {
                    kill();
                }
            }
        }
        if hotkey {
            let _ = UnregisterHotKey(None, KILL_HOTKEY_ID);
        }
        if let Some(h) = mouse {
            let _ = UnhookWindowsHookEx(h);
        }
        if let Some(h) = keyboard {
            let _ = UnhookWindowsHookEx(h);
        }
    });
    if spawned.is_err() {
        return false;
    }
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok((thread_id, hotkey)) => {
            *slot = Some(thread_id);
            hotkey
        }
        Err(_) => false,
    }
}

/// Stop the guard: unregister the shortcut and remove the hooks.
pub fn stop_guard() {
    if let Some(thread_id) = GUARD_THREAD.lock().unwrap().take() {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}
