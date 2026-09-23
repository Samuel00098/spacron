//! The "an agent is controlling this window" frame (docs/computer-use.md,
//! "Visible and stoppable").
//!
//! A borderless, transparent, click-through, always-on-top window laid over the
//! controlled window, showing a coloured frame and a banner with the agent's
//! name, its last action and the stop shortcut. It loads a static page from the
//! app bundle (`static/desktop-indicator.html`) and is not in any capability
//! file, so it has no IPC: it can only be written to, by `eval` from here.
//!
//! It never takes focus (WS_EX_NOACTIVATE, shown with SW_SHOWNOACTIVATE) — an
//! indicator that stole the foreground would make the next act fail its own
//! foreground check. It is click-through (WS_EX_TRANSPARENT), and hit-testing
//! in `win::window_at` skips click-through windows, so the frame lying over
//! the target does not block the agent's clicks either.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SW_HIDE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

use super::Indicator;

const LABEL: &str = "desktop-indicator";
/// How far the frame sits outside the window, in physical pixels.
const PAD: i32 = 4;

fn payload(ind: &Indicator) -> String {
    serde_json::to_string(ind).unwrap_or_else(|_| "{}".into())
}

fn raw_hwnd(w: &tauri::WebviewWindow) -> Option<HWND> {
    w.hwnd().ok().map(|h| HWND(h.0))
}

fn create(app: &AppHandle, first: &Indicator) -> Option<tauri::WebviewWindow> {
    // The first payload rides in the URL fragment, because an `eval` sent
    // before the page has loaded would be lost.
    let fragment = percent_encoding::utf8_percent_encode(&payload(first), percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = WebviewUrl::App(format!("desktop-indicator.html#{fragment}").into());
    let window = WebviewWindowBuilder::new(app, LABEL, url)
        .title("Spacron — agent in control")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| eprintln!("[computer-use] could not create the indicator: {e}"))
        .ok()?;
    let _ = window.set_ignore_cursor_events(true);
    if let Some(hwnd) = raw_hwnd(&window) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            // WS_EX_TRANSPARENT explicitly, not only via set_ignore_cursor_events:
            // `win::window_at` relies on it to see through the indicator.
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TRANSPARENT.0) as isize,
            );
        }
    }
    Some(window)
}

/// Show, move or hide the indicator. Safe to call from any thread.
pub fn update(app: &AppHandle, indicator: Option<&Indicator>) {
    let existing = app.get_webview_window(LABEL);
    let Some(ind) = indicator else {
        if let Some(hwnd) = existing.as_ref().and_then(raw_hwnd) {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        return;
    };

    let window = match existing {
        Some(w) => {
            let _ = w.eval(format!("window.__spacronIndicator && window.__spacronIndicator({})", payload(ind)));
            w
        }
        None => match create(app, ind) {
            Some(w) => w,
            None => return,
        },
    };
    let Some(hwnd) = raw_hwnd(&window) else { return };
    let b = &ind.bounds;
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            b.x - PAD,
            b.y - PAD,
            b.width + PAD * 2,
            b.height + PAD * 2,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}
