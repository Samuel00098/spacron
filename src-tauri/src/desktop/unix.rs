//! Computer use on macOS and Linux (docs/computer-use.md): the same tools,
//! grants and refusals as the Windows backend (`win.rs`), with each platform's
//! own means of seeing and acting.
//!
//! - **macOS**: built-in tools only. The window list comes from CoreGraphics
//!   (through JavaScript for Automation), screenshots from `screencapture -l`,
//!   pointer and keys from CoreGraphics events and System Events. Spacron needs
//!   Screen Recording and Accessibility permission (System Settings > Privacy
//!   & Security).
//! - **Linux**: X11 sessions, through `xdotool` and ImageMagick's `import`.
//!   Wayland blocks one app from reading or driving another's windows by
//!   design, so a Wayland session is reported as unsupported.
//!
//! What is the same as Windows: windows are identified by id and process, a
//! grant binds to `(id, pid, process path)`, every action re-checks that the
//! window still belongs to the same process, brings it to the front and
//! verifies it really is in front before anything is sent, and the same keys
//! are refused (switching away, closing, locking, the stop shortcut, pasting).
//! What differs: there is no UI-element tree here, so actions take normalized
//! coordinates read off a screenshot rather than element refs.

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{Act, Bounds, MouseButton, Point, WindowInfo};

/// Processes never listed or targeted, lower-cased, without any `.exe`.
const NEVER_TARGETABLE: &[&str] = &[
    // Spacron itself; `own_name` covers renamed builds.
    "spacron",
    // macOS system surfaces: login, permission and password prompts, lock, force quit.
    "loginwindow", "securityagent", "coreautha", "universalaccessauthwarn", "screensaverengine",
    "keychain access", "system settings", "system preferences", "activity monitor", "passwords",
    // Linux system surfaces: polkit and keyring prompts, lock screens, task managers.
    "polkit-gnome-authentication-agent-1", "polkit-kde-authentication-agent-1", "lxpolkit", "gcr-prompter",
    "pinentry", "pinentry-gtk-2", "pinentry-gnome3", "pinentry-qt", "gnome-keyring-daemon", "seahorse", "kwalletd5", "kwalletd6",
    "gnome-screensaver", "xscreensaver", "light-locker", "i3lock", "swaylock", "gnome-system-monitor", "ksysguard", "plasma-systemmonitor",
    // Password managers, everywhere.
    "1password", "bitwarden", "keepass", "keepassxc", "dashlane", "enpass", "nordpass", "protonpass", "proton pass",
];

static USER_DENYLIST: std::sync::RwLock<Vec<String>> = std::sync::RwLock::new(Vec::new());

pub fn set_user_denylist(names: Vec<String>) {
    if let Ok(mut list) = USER_DENYLIST.write() {
        *list = names.into_iter().map(|n| plain_name(&n)).collect();
    }
}

/// A process name as compared: lower-case, without a Windows `.exe`, so a
/// blocked-apps list written on Windows still applies here.
fn plain_name(name: &str) -> String {
    name.trim().to_ascii_lowercase().trim_end_matches(".exe").to_string()
}

fn own_name() -> Option<String> {
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NAME.get_or_init(|| std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| plain_name(&n.to_string_lossy())))).clone()
}

pub(crate) fn never_targetable(process: &str) -> bool {
    let p = plain_name(process);
    NEVER_TARGETABLE.contains(&p.as_str())
        || own_name().as_deref() == Some(p.as_str())
        || USER_DENYLIST.read().map(|l| l.iter().any(|n| *n == p)).unwrap_or(false)
}

pub fn supported() -> bool {
    if cfg!(target_os = "macos") {
        return true;
    }
    wayland_reason().is_none()
}

/// Why this Linux session cannot be driven, if it cannot.
fn wayland_reason() -> Option<&'static str> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let wayland = std::env::var("XDG_SESSION_TYPE").map(|t| t.eq_ignore_ascii_case("wayland")).unwrap_or(false)
        || (std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none());
    wayland.then_some("This Linux session uses Wayland, which does not let one app see or control another app's windows. Log in with an X11 (Xorg) session to use computer use.")
}

pub fn unsupported_reason() -> String {
    wayland_reason().map(str::to_string).unwrap_or_else(|| "Computer use is not available on this system.".into())
}

// ── running helpers ─────────────────────────────────────────────────────────

/// The longest any one helper program may take. A tool that waits on the
/// window manager (or on a permission prompt) must never hang the agent.
const RUN_LIMIT: Duration = Duration::from_secs(10);

fn run(program: &str, args: &[&str], hint: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut child = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { hint.to_string() } else { format!("{program} failed: {e}") })?;
    // Read the pipes on their own threads so a large screenshot cannot fill one and stall the child.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || { let mut b = Vec::new(); if let Some(o) = stdout.as_mut() { let _ = o.read_to_end(&mut b); } b });
    let err_reader = std::thread::spawn(move || { let mut b = Vec::new(); if let Some(e) = stderr.as_mut() { let _ = e.read_to_end(&mut b); } b });
    let deadline = Instant::now() + RUN_LIMIT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} did not finish within {} seconds, so it was stopped.", RUN_LIMIT.as_secs()));
            }
            Err(e) => return Err(format!("{program} failed: {e}")),
        }
    };
    let out = std::process::Output { status, stdout: out_reader.join().unwrap_or_default(), stderr: err_reader.join().unwrap_or_default() };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("{program} failed.") } else { err });
    }
    Ok(out.stdout)
}

/// When Spacron last sent input, so its own clicks are not mistaken for the user.
static LAST_INJECT: Mutex<Option<Instant>> = Mutex::new(None);

fn mark_injected() {
    if let Ok(mut t) = LAST_INJECT.lock() {
        *t = Some(Instant::now());
    }
}

/// How long ago the user (not Spacron) last used the mouse or keyboard. The
/// system idle timers count injected input too, so activity that lines up
/// with Spacron's own last action is not counted as the user's.
pub fn ms_since_real_input() -> Option<u64> {
    let idle = system_idle_ms()?;
    let ours = LAST_INJECT.lock().ok().and_then(|t| *t).map(|t| t.elapsed().as_millis() as u64);
    match ours {
        Some(ours) if idle + 300 >= ours => None, // the last input was ours
        _ => Some(idle),
    }
}

#[cfg(target_os = "macos")]
fn system_idle_ms() -> Option<u64> {
    let out = run("ioreg", &["-c", "IOHIDSystem", "-d", "4"], "").ok()?;
    let text = String::from_utf8_lossy(&out);
    let line = text.lines().find(|l| l.contains("\"HIDIdleTime\""))?;
    let ns: u64 = line.rsplit('=').next()?.trim().parse().ok()?;
    Some(ns / 1_000_000)
}

#[cfg(not(target_os = "macos"))]
fn system_idle_ms() -> Option<u64> {
    // Optional: `xprintidle` is a small package; without it there is no takeover pause.
    let out = run("xprintidle", &[], "").ok()?;
    String::from_utf8_lossy(&out).trim().parse().ok()
}

// ── keys ────────────────────────────────────────────────────────────────────

/// One key combo, checked and normalized: modifiers first, then the key.
#[derive(Debug, PartialEq)]
pub(crate) struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Command on macOS. Never allowed on Linux (the Super key).
    pub cmd: bool,
    pub key: String,
}

/// Parse and check a key combo with the same rules as Windows: nothing that
/// switches away from, closes or escapes the window, locks the screen, is the
/// stop shortcut, or pastes the clipboard. `mac` selects the macOS rules
/// (Command is the shortcut key there; Super is refused on Linux).
pub(crate) fn parse_combo(combo: &str, mac: bool) -> Result<Combo, String> {
    let parts: Vec<String> = combo.split('+').map(|p| p.trim().to_ascii_lowercase()).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err("desktop_key needs 'keys', e.g. \"enter\" or \"ctrl+s\".".into());
    }
    let mut c = Combo { ctrl: false, alt: false, shift: false, cmd: false, key: String::new() };
    for p in &parts {
        match p.as_str() {
            "ctrl" | "control" => c.ctrl = true,
            "alt" | "option" | "opt" => c.alt = true,
            "shift" => c.shift = true,
            "cmd" | "command" | "meta" | "super" | "win" | "windows" => {
                if !mac {
                    return Err("The Super key is not allowed: it opens things outside the granted window.".into());
                }
                c.cmd = true;
            }
            key => {
                if !c.key.is_empty() {
                    return Err(format!("'{combo}' names two keys; send one combo at a time."));
                }
                let known = ["enter", "return", "tab", "esc", "escape", "space", "backspace", "delete", "del", "insert", "ins",
                    "home", "end", "pageup", "pgup", "pagedown", "pgdn", "up", "down", "left", "right"];
                let fkey = key.len() >= 2 && key.starts_with('f') && key[1..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n));
                if !(known.contains(&key) || fkey || (key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric())) {
                    return Err(format!("Unknown key '{key}'."));
                }
                c.key = match key { "return" => "enter", "escape" => "esc", "del" => "delete", "ins" => "insert", "pgup" => "pageup", "pgdn" => "pagedown", k => k }.to_string();
            }
        }
    }
    if c.key.is_empty() {
        return Err(format!("'{combo}' has no key, only modifiers."));
    }
    let k = c.key.as_str();
    let blocked = (c.alt && k == "tab") || (c.cmd && k == "tab")
        || (c.ctrl && k == "esc") || (c.alt && k == "esc")
        || (c.ctrl && c.alt && (k == "delete" || k == "backspace" || k.starts_with('f') && k.len() > 1))
        || (c.alt && k == "f4")
        || (c.cmd && (k == "q" || k == "space" || k == "h" || k == "m"))
        || (c.cmd && c.alt && k == "esc")
        || (c.ctrl && c.cmd && k == "q");
    if blocked {
        return Err(format!("'{combo}' is not allowed: it switches away from, closes, or escapes the granted window, or is the stop shortcut."));
    }
    let paste = ((c.ctrl || c.cmd) && k == "v") || (c.shift && k == "insert");
    if paste {
        return Err("Pasting is not allowed: the clipboard may hold something private. Use desktop_type with the text instead.".into());
    }
    Ok(c)
}

pub fn parse_keys(combo: &str) -> Result<(), String> {
    parse_combo(combo, cfg!(target_os = "macos")).map(|_| ())
}

/// The combo in xdotool's names (Linux).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn xdotool_combo(c: &Combo) -> String {
    let key = match c.key.as_str() {
        "enter" => "Return".to_string(), "tab" => "Tab".into(), "esc" => "Escape".into(), "space" => "space".into(),
        "backspace" => "BackSpace".into(), "delete" => "Delete".into(), "insert" => "Insert".into(), "home" => "Home".into(),
        "end" => "End".into(), "pageup" => "Prior".into(), "pagedown" => "Next".into(), "up" => "Up".into(), "down" => "Down".into(),
        "left" => "Left".into(), "right" => "Right".into(),
        f if f.len() >= 2 && f.starts_with('f') && f[1..].parse::<u8>().is_ok() => f.to_uppercase(),
        k => k.to_string(),
    };
    let mut parts = Vec::new();
    if c.ctrl { parts.push("ctrl".to_string()) }
    if c.alt { parts.push("alt".to_string()) }
    if c.shift { parts.push("shift".to_string()) }
    parts.push(key);
    parts.join("+")
}

/// The combo as AppleScript (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn applescript_combo(c: &Combo) -> String {
    let code = match c.key.as_str() {
        "enter" => Some(36), "tab" => Some(48), "esc" => Some(53), "space" => Some(49), "backspace" => Some(51),
        "delete" => Some(117), "home" => Some(115), "end" => Some(119), "pageup" => Some(116), "pagedown" => Some(121),
        "up" => Some(126), "down" => Some(125), "left" => Some(123), "right" => Some(124),
        "f1" => Some(122), "f2" => Some(120), "f3" => Some(99), "f4" => Some(118), "f5" => Some(96), "f6" => Some(97),
        "f7" => Some(98), "f8" => Some(100), "f9" => Some(101), "f10" => Some(109), "f11" => Some(103), "f12" => Some(111),
        _ => None,
    };
    let mut mods = Vec::new();
    if c.cmd { mods.push("command down") }
    if c.ctrl { mods.push("control down") }
    if c.alt { mods.push("option down") }
    if c.shift { mods.push("shift down") }
    let using = if mods.is_empty() { String::new() } else { format!(" using {{{}}}", mods.join(", ")) };
    match code {
        Some(code) => format!("tell application \"System Events\" to key code {code}{using}"),
        None => format!("tell application \"System Events\" to keystroke \"{}\"{using}", c.key),
    }
}

// ── geometry ────────────────────────────────────────────────────────────────

fn resolve_point(info: &WindowInfo, p: &Point) -> Result<(i32, i32), String> {
    let (fx, fy) = match p {
        Point::Ref(_) => return Err(NO_REFS.into()),
        Point::At(x, y) => (*x, *y),
        Point::Centre => (0.5, 0.5),
    };
    if !(0.0..=1.0).contains(&fx) || !(0.0..=1.0).contains(&fy) {
        return Err("x and y are fractions of the window, from 0 to 1.".into());
    }
    let b = &info.bounds;
    Ok((b.x + ((b.width - 1).max(0) as f64 * fx).round() as i32, b.y + ((b.height - 1).max(0) as f64 * fy).round() as i32))
}

const NO_REFS: &str = "Element refs are only available on Windows. Take a desktop_screenshot of the window and pass x and y as fractions of it instead.";

pub fn walk_unsupported() -> String {
    "The UI element tree is only available on Windows for now. Use desktop_screenshot to see the window, then click and type by position (x and y as fractions of the window).".into()
}

fn describe_button(b: MouseButton) -> &'static str {
    match b { MouseButton::Left => "left", MouseButton::Right => "right", MouseButton::Middle => "middle" }
}

fn describe_point(p: &Point) -> String {
    match p { Point::At(x, y) => format!("({x:.2}, {y:.2}) of the window"), Point::Centre => "the window's centre".into(), Point::Ref(r) => r.clone() }
}

// ── actions (shared shape, platform calls below) ────────────────────────────

/// Every action re-describes the window, refuses if it changed hands, brings it
/// to the front and checks it really is in front before sending anything.
pub fn act(_caller: &str, info: &WindowInfo, action: &Act) -> Result<String, String> {
    let fresh = window(&info.id)?;
    if fresh.pid != info.pid {
        return Err("The window now belongs to a different process; nothing was sent.".into());
    }
    let info = &fresh;
    match action {
        Act::Focus => {
            platform::bring_to_front(info)?;
            Ok(format!("\"{}\" is now in front.", info.title))
        }
        Act::Click { at, button, double } => {
            let (x, y) = resolve_point(info, at)?;
            platform::bring_to_front(info)?;
            platform::check_hit(info, x, y)?;
            platform::click(x, y, *button, *double)?;
            mark_injected();
            Ok(format!("{} {}-clicked at {}.", if *double { "Double" } else { "Single" }, describe_button(*button), describe_point(at)))
        }
        Act::Type { at, text, replace } => {
            if at.is_some() {
                return Err(NO_REFS.into());
            }
            platform::bring_to_front(info)?;
            if *replace {
                platform::select_all()?;
            }
            platform::type_text(text)?;
            mark_injected();
            Ok(format!("Typed {} characters.", text.chars().count()))
        }
        Act::Key { keys } => {
            let combo = parse_combo(keys, cfg!(target_os = "macos"))?;
            platform::bring_to_front(info)?;
            platform::key(&combo)?;
            mark_injected();
            Ok(format!("Pressed {keys}."))
        }
        Act::Scroll { at, dx, dy } => {
            let (x, y) = resolve_point(info, at)?;
            platform::bring_to_front(info)?;
            platform::check_hit(info, x, y)?;
            platform::scroll(x, y, *dx, *dy)?;
            mark_injected();
            Ok(format!("Scrolled at {}.", describe_point(at)))
        }
        Act::Drag { from, to } => {
            let (fx, fy) = resolve_point(info, from)?;
            let (tx, ty) = resolve_point(info, to)?;
            platform::bring_to_front(info)?;
            platform::check_hit(info, fx, fy)?;
            platform::drag(fx, fy, tx, ty)?;
            mark_injected();
            Ok(format!("Dragged from {} to {}.", describe_point(from), describe_point(to)))
        }
    }
}

pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    if let Some(reason) = wayland_reason() {
        return Err(reason.into());
    }
    Ok(platform::all_windows()?.into_iter().filter(|w| !never_targetable(&w.process)).collect())
}

pub fn window(id: &str) -> Result<WindowInfo, String> {
    let id = id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("'{id}' is not a window id. Use an id from desktop_list_windows."));
    }
    list_windows()?.into_iter().find(|w| w.id == id)
        .ok_or_else(|| "That window is closed, or is one agents may not use.".to_string())
}

pub fn capture(id: &str) -> Result<(WindowInfo, image::RgbaImage), String> {
    let info = window(id)?;
    let png = platform::capture_png(&info)?;
    let img = image::load_from_memory(&png).map_err(|e| format!("Could not read the screenshot: {e}"))?.to_rgba8();
    Ok((info, img))
}

#[cfg(target_os = "macos")]
mod platform {
    //! macOS: CoreGraphics and System Events, built in.
    use super::*;

    const PERMISSION: &str = "macOS blocked it. In System Settings > Privacy & Security, allow Spacron under Screen Recording and Accessibility, then try again.";

    fn osascript(args: &[&str]) -> Result<String, String> {
        run("osascript", args, "osascript is missing.").map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .map_err(|e| if e.contains("not allowed") || e.contains("-1743") || e.contains("-25211") || e.contains("assistive") { format!("{PERMISSION} ({e})") } else { e })
    }

    fn jxa(script: &str) -> Result<String, String> {
        osascript(&["-l", "JavaScript", "-e", script])
    }

    /// On-screen app windows, front to back, with their owning process.
    pub fn all_windows() -> Result<Vec<WindowInfo>, String> {
        let out = jxa("ObjC.import('CoreGraphics'); ObjC.import('AppKit'); \
var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1 | 16, 0)) || []; \
var front = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier; var seenFront = false; \
JSON.stringify(list.filter(function (w) { return w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 40; }).map(function (w) { \
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID); \
  var path = app && app.executableURL ? app.executableURL.path.js : ''; \
  var focused = !seenFront && w.kCGWindowOwnerPID === front; if (focused) seenFront = true; \
  return { id: String(w.kCGWindowNumber), title: w.kCGWindowName || '', owner: w.kCGWindowOwnerName || '', pid: w.kCGWindowOwnerPID, path: path, \
    x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height, focused: focused }; }))")?;
        let rows: Vec<serde_json::Value> = serde_json::from_str(&out).map_err(|e| format!("Could not read the window list: {e}"))?;
        Ok(rows.into_iter().map(|r| WindowInfo {
            id: r["id"].as_str().unwrap_or_default().to_string(),
            title: r["title"].as_str().unwrap_or_default().to_string(),
            process: r["owner"].as_str().unwrap_or_default().to_string(),
            process_path: r["path"].as_str().unwrap_or_default().to_string(),
            pid: r["pid"].as_u64().unwrap_or(0) as u32,
            bounds: Bounds { x: r["x"].as_f64().unwrap_or(0.0) as i32, y: r["y"].as_f64().unwrap_or(0.0) as i32, width: r["w"].as_f64().unwrap_or(0.0) as i32, height: r["h"].as_f64().unwrap_or(0.0) as i32 },
            focused: r["focused"].as_bool().unwrap_or(false),
            minimized: false,
        }).collect())
    }

    pub fn bring_to_front(info: &WindowInfo) -> Result<(), String> {
        // Activate the app, then raise this window over its other windows.
        jxa(&format!("ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier({}); if (a) a.activateWithOptions(2);", info.pid))?;
        let _ = osascript(&["-e", "on run argv", "-e", "tell application \"System Events\" to tell (first process whose unix id is (item 1 of argv as integer)) to perform action \"AXRaise\" of (first window whose name is (item 2 of argv))", "-e", "end run", "--", &info.pid.to_string(), &info.title]);
        for _ in 0..15 {
            if all_windows()?.first().is_some_and(|w| w.id == info.id) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("Could not bring the window to the front, so nothing was sent.".into())
    }

    /// The top-most app window under the point must be the target.
    pub fn check_hit(info: &WindowInfo, x: i32, y: i32) -> Result<(), String> {
        let top = all_windows()?.into_iter().find(|w| x >= w.bounds.x && y >= w.bounds.y && x < w.bounds.x + w.bounds.width && y < w.bounds.y + w.bounds.height);
        match top {
            Some(w) if w.id == info.id => Ok(()),
            Some(w) => Err(format!("\"{}\" is covering that spot, so nothing was sent.", w.process)),
            None => Err("That spot is outside the window.".into()),
        }
    }

    fn mouse_script(events: &str) -> String {
        format!("ObjC.import('CoreGraphics'); function ev(t, x, y, b, n) {{ var e = $.CGEventCreateMouseEvent(null, t, $.CGPointMake(x, y), b); if (n) $.CGEventSetIntegerValueField(e, 1, n); $.CGEventPost(0, e); }} {events}")
    }

    pub fn click(x: i32, y: i32, button: MouseButton, double: bool) -> Result<(), String> {
        let (down, up, b) = match button { MouseButton::Right => (3, 4, 1), MouseButton::Middle => (25, 26, 2), MouseButton::Left => (1, 2, 0) };
        let clicks = if double { 2 } else { 1 };
        jxa(&mouse_script(&format!("ev(5, {x}, {y}, {b}, 0); for (var i = 1; i <= {clicks}; i++) {{ ev({down}, {x}, {y}, {b}, i); ev({up}, {x}, {y}, {b}, i); }}"))).map(|_| ())
    }

    pub fn drag(fx: i32, fy: i32, tx: i32, ty: i32) -> Result<(), String> {
        jxa(&mouse_script(&format!("ev(5, {fx}, {fy}, 0, 0); ev(1, {fx}, {fy}, 0, 1); for (var i = 1; i <= 10; i++) ev(6, {fx} + ({tx} - {fx}) * i / 10, {fy} + ({ty} - {fy}) * i / 10, 0, 0); ev(2, {tx}, {ty}, 0, 1);"))).map(|_| ())
    }

    pub fn scroll(x: i32, y: i32, dx: i32, dy: i32) -> Result<(), String> {
        jxa(&mouse_script(&format!("ev(5, {x}, {y}, 0, 0); $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 2, {}, {}));", -dy * 3, -dx * 3))).map(|_| ())
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        // The text goes in as an argument, never into the script.
        osascript(&["-e", "on run argv", "-e", "tell application \"System Events\" to keystroke (item 1 of argv)", "-e", "end run", "--", text]).map(|_| ())
    }

    pub fn select_all() -> Result<(), String> {
        osascript(&["-e", "tell application \"System Events\" to keystroke \"a\" using {command down}"]).map(|_| ())
    }

    pub fn key(c: &Combo) -> Result<(), String> {
        osascript(&["-e", &applescript_combo(c)]).map(|_| ())
    }

    pub fn capture_png(info: &WindowInfo) -> Result<Vec<u8>, String> {
        let file = std::env::temp_dir().join(format!("spacron-window-{}.png", uuid::Uuid::new_v4().simple()));
        let path = file.to_string_lossy().to_string();
        run("screencapture", &["-x", "-o", &format!("-l{}", info.id), "-t", "png", &path], "screencapture is missing.").map_err(|e| format!("{PERMISSION} ({e})"))?;
        let png = std::fs::read(&file).map_err(|_| PERMISSION.to_string())?;
        let _ = std::fs::remove_file(&file);
        Ok(png)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    //! Linux (X11): xdotool and ImageMagick.
    use super::*;

    const XDOTOOL: &str = "Computer use needs xdotool. Install it once, e.g. sudo apt-get install -y xdotool";

    fn xdotool(args: &[&str]) -> Result<String, String> {
        run("xdotool", args, XDOTOOL).map(|o| String::from_utf8_lossy(&o).trim().to_string())
    }

    fn process_of(pid: u32) -> (String, String) {
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|s| s.trim().to_string()).unwrap_or_default();
        let path = std::fs::read_link(format!("/proc/{pid}/exe")).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        (name, path)
    }

    pub fn all_windows() -> Result<Vec<WindowInfo>, String> {
        let active = xdotool(&["getactivewindow"]).unwrap_or_default();
        let ids = xdotool(&["search", "--onlyvisible", "--name", "."]).unwrap_or_default();
        let mut out = Vec::new();
        for id in ids.split_whitespace() {
            let title = xdotool(&["getwindowname", id]).unwrap_or_default();
            let Ok(pid) = xdotool(&["getwindowpid", id]).map(|p| p.parse::<u32>().unwrap_or(0)) else { continue };
            let geo = xdotool(&["getwindowgeometry", "--shell", id]).unwrap_or_default();
            let val = |k: &str| geo.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).and_then(|v| v.parse::<i32>().ok()).unwrap_or(0);
            let bounds = Bounds { x: val("X"), y: val("Y"), width: val("WIDTH"), height: val("HEIGHT") };
            if title.trim().is_empty() || bounds.width < 40 || bounds.height < 30 || pid == 0 {
                continue;
            }
            let (process, process_path) = process_of(pid);
            out.push(WindowInfo { id: id.to_string(), title, process, process_path, pid, bounds, focused: id == active, minimized: false });
        }
        Ok(out)
    }

    /// Whether `id` is in front: the window manager's active window, or (with
    /// no window manager reporting one) the window that has keyboard focus,
    /// counting the target's own child windows.
    fn in_front(info: &WindowInfo) -> bool {
        if xdotool(&["getactivewindow"]).is_ok_and(|a| a == info.id) {
            return true;
        }
        let Ok(focus) = xdotool(&["getwindowfocus"]) else { return false };
        focus == info.id || xdotool(&["getwindowpid", &focus]).is_ok_and(|p| p == info.pid.to_string())
    }

    pub fn bring_to_front(info: &WindowInfo) -> Result<(), String> {
        // No `--sync`: it waits for the window manager to confirm, which some
        // never do. This loop waits instead, and gives up.
        let _ = xdotool(&["windowactivate", &info.id]);
        let _ = xdotool(&["windowraise", &info.id]);
        let _ = xdotool(&["windowfocus", &info.id]);
        for _ in 0..15 {
            if in_front(info) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("Could not bring the window to the front, so nothing was sent.".into())
    }

    /// Every window inside `id` (its child windows, at any depth), as
    /// decimal ids. `xwininfo -tree` lists them recursively in hex.
    fn descendants(id: &str) -> Option<Vec<String>> {
        let out = run("xwininfo", &["-tree", "-id", id], "").ok()?;
        let text = String::from_utf8_lossy(&out).to_string();
        let mut ids = Vec::new();
        for token in text.split_whitespace() {
            if let Some(hex) = token.strip_prefix("0x") {
                if let Ok(n) = u64::from_str_radix(hex.trim_end_matches(':'), 16) {
                    ids.push(n.to_string());
                }
            }
        }
        Some(ids)
    }

    /// The window under the point must be the target: the target itself, a
    /// window inside it, or the window manager's frame around it (a frame
    /// contains the target). Another app's window is none of these.
    pub fn check_hit(info: &WindowInfo, x: i32, y: i32) -> Result<(), String> {
        move_pointer(x, y)?;
        mark_injected();
        let loc = xdotool(&["getmouselocation", "--shell"])?;
        let under = loc.lines().find_map(|l| l.strip_prefix("WINDOW=")).unwrap_or("").to_string();
        if under.is_empty() {
            return Err("That spot is outside the window.".into());
        }
        if under == "0" {
            // xdotool finds app windows through the marker a window manager
            // sets; without one it cannot say what is under the pointer.
            return Err("No window manager is running on this display, so Spacron cannot check what is under the pointer; nothing was sent.".into());
        }
        if under == info.id {
            return Ok(());
        }
        match (descendants(&info.id), descendants(&under)) {
            (Some(inside), _) if inside.contains(&under) => Ok(()),
            (_, Some(frame)) if frame.contains(&info.id) => Ok(()),
            (Some(_), Some(_)) => Err("Another window is covering that spot, so nothing was sent.".into()),
            // Without xwininfo, fall back to the owning process.
            _ => {
                let pid = xdotool(&["getwindowpid", &under]).unwrap_or_default();
                if pid == info.pid.to_string() { Ok(()) } else { Err("Another window is covering that spot, so nothing was sent. (Installing x11-utils makes this check precise.)".into()) }
            }
        }
    }

    /// Move the pointer. Never `--sync`: it waits for the pointer to move, and
    /// forever when it is already there. A short pause lets the move land.
    fn move_pointer(x: i32, y: i32) -> Result<(), String> {
        xdotool(&["mousemove", &x.to_string(), &y.to_string()])?;
        std::thread::sleep(Duration::from_millis(40));
        Ok(())
    }

    fn button(b: MouseButton) -> &'static str {
        match b { MouseButton::Left => "1", MouseButton::Middle => "2", MouseButton::Right => "3" }
    }

    pub fn click(x: i32, y: i32, b: MouseButton, double: bool) -> Result<(), String> {
        move_pointer(x, y)?;
        let mut args = vec!["click"];
        if double { args.extend(["--repeat", "2"]); }
        args.push(button(b));
        xdotool(&args).map(|_| ())
    }

    pub fn drag(fx: i32, fy: i32, tx: i32, ty: i32) -> Result<(), String> {
        move_pointer(fx, fy)?;
        xdotool(&["mousedown", "1"])?;
        move_pointer(tx, ty)?;
        xdotool(&["mouseup", "1"]).map(|_| ())
    }

    pub fn scroll(x: i32, y: i32, dx: i32, dy: i32) -> Result<(), String> {
        move_pointer(x, y)?;
        if dy != 0 {
            xdotool(&["click", "--repeat", &dy.unsigned_abs().to_string(), if dy > 0 { "5" } else { "4" }])?;
        }
        if dx != 0 {
            xdotool(&["click", "--repeat", &dx.unsigned_abs().to_string(), if dx > 0 { "7" } else { "6" }])?;
        }
        Ok(())
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        xdotool(&["type", "--delay", "8", "--", text]).map(|_| ())
    }

    pub fn select_all() -> Result<(), String> {
        xdotool(&["key", "--", "ctrl+a"]).map(|_| ())
    }

    pub fn key(c: &Combo) -> Result<(), String> {
        xdotool(&["key", "--", &xdotool_combo(c)]).map(|_| ())
    }

    pub fn capture_png(info: &WindowInfo) -> Result<Vec<u8>, String> {
        run("import", &["-window", &info.id, "png:-"], "Screenshots need ImageMagick. Install it once, e.g. sudo apt-get install -y imagemagick")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_that_leave_the_window_are_refused_on_mac_and_linux() {
        for mac in [true, false] {
            for bad in ["alt+tab", "ctrl+esc", "alt+f4", "ctrl+alt+delete", "ctrl+alt+esc", "ctrl+v", "shift+insert", "ctrl+shift+v", "ctrl+alt+f2", "ctrl+alt+backspace"] {
                assert!(parse_combo(bad, mac).is_err(), "{bad} should be refused (mac: {mac})");
            }
            for ok in ["enter", "ctrl+s", "shift+tab", "f5", "a", "ctrl+shift+z", "pagedown", "escape"] {
                assert!(parse_combo(ok, mac).is_ok(), "{ok} should be allowed (mac: {mac})");
            }
        }
        // macOS: Command is the shortcut key, but not to switch, quit, hide, lock, force quit or paste.
        for bad in ["cmd+tab", "cmd+q", "cmd+space", "cmd+h", "cmd+m", "cmd+option+esc", "ctrl+cmd+q", "cmd+v"] {
            assert!(parse_combo(bad, true).is_err(), "{bad} should be refused on macOS");
        }
        assert!(parse_combo("cmd+s", true).is_ok() && parse_combo("cmd+shift+z", true).is_ok());
        // Linux: the Super key is refused outright.
        assert!(parse_combo("super+e", false).is_err() && parse_combo("cmd+s", false).is_err());
        assert!(parse_combo("ctrl", false).is_err() && parse_combo("a+b", false).is_err() && parse_combo("banana", false).is_err());
    }

    #[test]
    fn combos_are_spelled_for_each_platform() {
        let c = parse_combo("ctrl+shift+pagedown", false).unwrap();
        assert_eq!(xdotool_combo(&c), "ctrl+shift+Next");
        assert_eq!(xdotool_combo(&parse_combo("Return", false).unwrap()), "Return");
        assert_eq!(xdotool_combo(&parse_combo("f5", false).unwrap()), "F5");
        assert_eq!(applescript_combo(&parse_combo("cmd+s", true).unwrap()), "tell application \"System Events\" to keystroke \"s\" using {command down}");
        assert_eq!(applescript_combo(&parse_combo("shift+tab", true).unwrap()), "tell application \"System Events\" to key code 48 using {shift down}");
    }

    #[test]
    fn protected_apps_are_never_targetable() {
        for p in ["SecurityAgent", "1Password", "KeePassXC", "pinentry-gnome3", "polkit-gnome-authentication-agent-1", "Spacron", "loginwindow", "System Settings"] {
            assert!(never_targetable(p), "{p}");
        }
        assert!(!never_targetable("TextEdit") && !never_targetable("gedit"));
        set_user_denylist(vec!["Notepad.exe".into(), "slack".into()]);
        assert!(never_targetable("notepad") && never_targetable("Slack"));
        set_user_denylist(vec![]);
    }

    /// Drives a real xterm on an X11 display with the app's own code. Needs
    /// DISPLAY, xdotool, ImageMagick and xterm:
    /// `DISPLAY=:91 SPACRON_X11_PROOF=/tmp/proof cargo test --lib desktop::unix -- --ignored`
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn operates_a_real_window_on_x11() {
        let proof = std::env::var("SPACRON_X11_PROOF").expect("set SPACRON_X11_PROOF to a file path");
        let _ = std::fs::remove_file(&proof);
        // Closed when the test ends, pass or fail.
        struct Term(std::process::Child);
        impl Drop for Term { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
        let term = Term(Command::new("xterm").args(["-geometry", "90x20+60+60", "-T", "cu-proof-term"]).spawn().expect("xterm starts"));
        let pid = term.0.id();
        let mut win = None;
        for _ in 0..50 {
            win = list_windows().unwrap().into_iter().find(|w| w.pid == pid);
            if win.is_some() { break; }
            std::thread::sleep(Duration::from_millis(200));
        }
        let win = win.expect("the xterm window is listed");
        assert!(win.process == "xterm" && win.bounds.width > 100, "{win:?}");
        let (_, shot) = capture(&win.id).expect("window screenshot");
        assert!(shot.width() as i32 >= win.bounds.width - 2 && shot.height() > 50, "{}x{}", shot.width(), shot.height());
        act("test", &win, &Act::Click { at: Point::At(0.5, 0.5), button: MouseButton::Left, double: false }).expect("click");
        act("test", &win, &Act::Type { at: None, text: format!("echo computer-use-ok > {proof}"), replace: false }).expect("type");
        act("test", &win, &Act::Key { keys: "enter".into() }).expect("enter");
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(std::fs::read_to_string(&proof).unwrap_or_default().trim(), "computer-use-ok");
        assert!(act("test", &win, &Act::Key { keys: "ctrl+v".into() }).is_err(), "paste is refused");
        // A blocked app disappears from every tool.
        set_user_denylist(vec!["xterm".into()]);
        assert!(list_windows().unwrap().iter().all(|w| w.process != "xterm"));
        assert!(window(&win.id).is_err());
        set_user_denylist(vec![]);
        drop(term);
    }

    #[test]
    fn points_are_fractions_of_the_window_and_refs_are_explained() {
        let info = WindowInfo { id: "1".into(), title: "t".into(), process: "p".into(), process_path: String::new(), pid: 1,
            bounds: Bounds { x: 100, y: 50, width: 201, height: 101 }, focused: true, minimized: false };
        assert_eq!(resolve_point(&info, &Point::At(0.5, 0.5)).unwrap(), (200, 100));
        assert_eq!(resolve_point(&info, &Point::Centre).unwrap(), (200, 100));
        assert_eq!(resolve_point(&info, &Point::At(0.0, 1.0)).unwrap(), (100, 150));
        assert!(resolve_point(&info, &Point::Ref("e3".into())).unwrap_err().contains("only available on Windows"));
        assert!(resolve_point(&info, &Point::At(1.5, 0.0)).is_err());
    }
}
