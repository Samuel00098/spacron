use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

const CONSOLE_CAPTURE_SCRIPT: &str = r#"
(() => {
    if (window.__spacronNativeConsole) return;
    window.__spacronNativeConsole = true;
    const post = (level, args) => {
        try {
            window.__TAURI_INTERNALS__.invoke('native_preview_console_event', {
                level,
                message: Array.from(args).map(a => {
                    try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
                    catch { return String(a); }
                }).join(' ')
            });
        } catch {}
    };
    ['log','info','warn','error','debug'].forEach(level => {
        const orig = console[level];
        if (typeof orig !== 'function') return;
        console[level] = (...args) => { post(level, args); orig.apply(console, args); };
    });
    window.addEventListener('error', e => post('error', [e.message || 'Uncaught error']));
    window.addEventListener('unhandledrejection', e => post('error', ['Unhandled rejection', e.reason]));
})();
"#;

const MCP_BRIDGE_SCRIPT: &str = r#"
(() => {
    if (window.__spacronNativeMcp) return;
    window.__spacronNativeMcp = true;
    window.__spacronMcpQuery = (selector, format, limit) => {
        const els = document.querySelectorAll(selector || 'body');
        return Array.from(els).slice(0, limit || 10).map(el => ({
            tag: el.tagName.toLowerCase(),
            text: format === 'html' ? undefined : (el.innerText || '').slice(0, 2000),
            html: format === 'html' ? (el.outerHTML || '').slice(0, 5000) : undefined,
        }));
    };
    window.__spacronMcpInteract = (action, selector, text, submit) => {
        const el = document.querySelector(selector);
        if (!el) return { success: false, error: 'Element not found: ' + selector };
        if (action === 'click') {
            el.click();
            return { success: true, action: 'click', selector };
        }
        if (action === 'type') {
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(el, text || '');
            else el.value = text || '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (submit) {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                const form = el.closest('form');
                if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }
            return { success: true, action: 'type', selector };
        }
        return { success: false, error: 'Unknown action: ' + action };
    };
})();
"#;

pub struct NativePreviewManager {
    webview_label: Mutex<Option<String>>,
}

impl NativePreviewManager {
    pub fn new() -> Self {
        Self {
            webview_label: Mutex::new(None),
        }
    }

    pub fn create(
        &self,
        app: &AppHandle,
        url: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<String, String> {
        self.close(app);

        let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err("Only http/https URLs are supported".to_string());
        }

        let window = app
            .get_window("main")
            .ok_or("Main window not found")?;

        let label = format!("native-preview-{}", uuid::Uuid::new_v4().simple());

        let ah = app.clone();
        let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
            .on_page_load(move |webview, _payload| {
                let _ = webview.eval(CONSOLE_CAPTURE_SCRIPT);
                let _ = webview.eval(MCP_BRIDGE_SCRIPT);
                if let Ok(url) = webview.url() {
                    let _ = ah.emit("native-preview:navigation", url.to_string());
                }
            });

        let position = tauri::LogicalPosition::new(x, y);
        let size = tauri::LogicalSize::new(width, height);

        let _webview = window
            .add_child(builder, position, size)
            .map_err(|e| format!("Failed to create native preview webview: {e}"))?;

        *self.webview_label.lock().unwrap() = Some(label.clone());
        Ok(label)
    }

    pub fn navigate(&self, app: &AppHandle, url: &str) -> Result<(), String> {
        let webview = self.get_webview(app)?;
        let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
        webview
            .navigate(parsed)
            .map_err(|e| format!("Navigation failed: {e}"))
    }

    pub fn eval(&self, app: &AppHandle, script: &str) -> Result<(), String> {
        let webview = self.get_webview(app)?;
        webview.eval(script).map_err(|e| format!("Eval failed: {e}"))
    }

    pub fn set_bounds(
        &self,
        app: &AppHandle,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let webview = self.get_webview(app)?;
        webview
            .set_bounds(tauri::Rect {
                position: tauri::LogicalPosition::new(x, y).into(),
                size: tauri::LogicalSize::new(width, height).into(),
            })
            .map_err(|e| format!("Failed to set bounds: {e}"))
    }

    pub fn show(&self, app: &AppHandle) -> Result<(), String> {
        let webview = self.get_webview(app)?;
        webview.show().map_err(|e| format!("Show failed: {e}"))
    }

    pub fn hide(&self, app: &AppHandle) -> Result<(), String> {
        let webview = self.get_webview(app)?;
        webview.hide().map_err(|e| format!("Hide failed: {e}"))
    }

    pub fn screenshot(&self, app: &AppHandle) -> Result<Vec<u8>, String> {
        let webview = self.get_webview(app)?;
        let (tx, rx) = std::sync::mpsc::channel();

        webview
            .with_webview(move |platform_webview| {
                let result = capture_screenshot(platform_webview);
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;

        // `with_webview` dispatches to the main thread; if that thread is busy or
        // the webview goes away, an unbounded recv() would wedge this command
        // forever. Bound the wait so the MCP browser tool surfaces a real error
        // instead of hanging until its own 15s timeout.
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "Screenshot capture timed out or was interrupted".to_string())?
    }

    pub fn close(&self, app: &AppHandle) {
        if let Some(label) = self.webview_label.lock().unwrap().take() {
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.close();
            }
        }
    }

    pub fn is_active(&self, app: &AppHandle) -> bool {
        let label = self.webview_label.lock().unwrap().clone();
        match label {
            Some(l) => app.get_webview(&l).is_some(),
            None => false,
        }
    }

    fn get_webview(&self, app: &AppHandle) -> Result<tauri::webview::Webview, String> {
        let label = self
            .webview_label
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "No native preview webview exists".to_string())?;
        app.get_webview(&label)
            .ok_or_else(|| "Native preview webview not found".to_string())
    }
}

// ---------------------------------------------------------------------------
// Platform screenshot
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn capture_screenshot(webview: tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
    use std::slice;
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::{
        Foundation::HGLOBAL,
        System::{
            Com::StructuredStorage::{CreateStreamOnHGlobal, GetHGlobalFromStream},
            Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        },
    };

    let controller = webview.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| e.to_string())?;
    let stream =
        unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }.map_err(|e| e.to_string())?;
    let capture_stream = stream.clone();

    unsafe {
        CapturePreviewCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &capture_stream,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(|result| {
                result?;
                Ok(())
            }),
        )
        .map_err(|e| e.to_string())?;
    }

    let png = unsafe {
        let hglobal = GetHGlobalFromStream(&stream).map_err(|e| e.to_string())?;
        let size = GlobalSize(hglobal);
        if size == 0 {
            return Err("WebView2 returned an empty screenshot".to_string());
        }
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            return Err("Failed to read WebView2 screenshot stream".to_string());
        }
        let bytes = slice::from_raw_parts(ptr as *const u8, size).to_vec();
        let _ = GlobalUnlock(hglobal);
        bytes
    };

    Ok(png)
}

#[cfg(target_os = "macos")]
fn capture_screenshot(_webview: tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
    Err("Native preview screenshot not yet implemented on macOS".to_string())
}

#[cfg(target_os = "linux")]
fn capture_screenshot(_webview: tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
    Err("Native preview screenshot not yet implemented on Linux".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn capture_screenshot(_webview: tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
    Err("Screenshot not supported on this platform".to_string())
}
