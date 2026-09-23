//! Windows backend for computer use: window enumeration, UI Automation, capture.
//!
//! Everything here is blocking and COM-bound, so callers run it on a blocking
//! thread (see `desktop::blocking`). Each entry point initialises COM for the
//! duration of the call and opts the thread into per-monitor-v2 DPI awareness,
//! so coordinates are physical pixels no matter what the process manifest says
//! — the class of bug that sank the native preview overlay
//! (docs/browser-pillar-spike.md, "Bounds and DPI").

use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, TRUE};
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
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

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
        if NEVER_TARGETABLE.contains(&lower.as_str()) || own_exe_name().as_deref() == Some(lower.as_str()) {
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
// UI Automation
// ---------------------------------------------------------------------------

/// One element of a walked tree, already flattened to what we print.
pub struct Node {
    pub depth: usize,
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

fn node_of(el: &IUIAutomationElement, depth: usize, frame: &Bounds) -> Node {
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
        let at = el.CachedBoundingRectangle().ok().and_then(|r| {
            if r.right <= r.left || r.bottom <= r.top || frame.width <= 0 || frame.height <= 0 {
                return None;
            }
            let cx = (r.left + r.right) as f64 / 2.0;
            let cy = (r.top + r.bottom) as f64 / 2.0;
            Some(((cx - frame.x as f64) / frame.width as f64, (cy - frame.y as f64) / frame.height as f64))
        });
        Node {
            depth,
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

/// Walk a window's control view depth-first, bounded by depth, node count and
/// wall time. Returns the nodes and whether any bound cut the walk short.
pub fn walk(id: &str, limits: TreeLimits) -> Result<(WindowInfo, Vec<Node>, bool), String> {
    let _scope = ThreadScope::enter();
    let hwnd = hwnd_from_id(id)?;
    let info = describe(hwnd, unsafe { GetForegroundWindow() }).ok_or_else(|| {
        format!("Window {id} is not available to agents (hidden, Spacron's own, or a protected app).")
    })?;

    let ui = automation()?;
    let cr = cache_request(&ui)?;
    let started = Instant::now();
    let deadline = Duration::from_millis(limits.time_budget_ms);
    let mut nodes = Vec::new();
    let mut truncated = false;

    unsafe {
        let walker = ui.ControlViewWalker().map_err(|e| e.to_string())?;
        let root = ui
            .ElementFromHandleBuildCache(hwnd, &cr)
            .map_err(|e| format!("Could not read window {id} through UI Automation: {e}"))?;

        // Explicit stack instead of recursion: a pathological tree must not be
        // able to overflow a blocking-pool thread's stack.
        let mut stack: Vec<(IUIAutomationElement, usize)> = vec![(root, 0)];
        while let Some((el, depth)) = stack.pop() {
            if nodes.len() >= limits.max_nodes || started.elapsed() > deadline {
                truncated = true;
                break;
            }
            nodes.push(node_of(&el, depth, &info.bounds));
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
    Ok((info, nodes, truncated))
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/// Capture one window's own pixels (not the screen region it covers, which
/// would include whatever other app is lying on top of it).
pub fn capture(id: &str) -> Result<(WindowInfo, image::RgbaImage), String> {
    let info = window(id)?;
    if info.minimized {
        return Err(format!("Window {id} is minimised, so there is nothing to capture."));
    }
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
    let img = target.capture_image().map_err(|e| format!("Could not capture window {id}: {e}"))?;
    // xcap links its own `image`; round-trip through raw bytes so the two crate
    // versions never have to agree on a type.
    let (w, h) = (img.width(), img.height());
    let img = image::RgbaImage::from_raw(w, h, img.into_raw())
        .ok_or_else(|| "The captured image had an unexpected size.".to_string())?;
    Ok((info, img))
}
