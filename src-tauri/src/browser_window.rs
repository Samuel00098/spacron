use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MAX_CONSOLE_ENTRIES: usize = 500;

#[derive(Clone, Debug, serde::Serialize)]
pub struct ConsoleEntry {
    pub level: String,
    pub message: String,
    pub timestamp: String,
}

pub struct BrowserWindowManager {
    window_label: Mutex<Option<String>>,
    console_logs: Mutex<VecDeque<ConsoleEntry>>,
}

impl BrowserWindowManager {
    pub fn new() -> Self {
        Self {
            window_label: Mutex::new(None),
            console_logs: Mutex::new(VecDeque::new()),
        }
    }

    pub fn create(&self, app: &AppHandle, url: &str) -> Result<String, String> {
        self.close(app);

        let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err("Only http/https URLs are supported".to_string());
        }

        let label = format!("browser-{}", uuid::Uuid::new_v4().simple());
        let _window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
            .title("Spacron Browser")
            .inner_size(1280.0, 800.0)
            .build()
            .map_err(|e| format!("Failed to create browser window: {e}"))?;

        *self.window_label.lock().unwrap() = Some(label.clone());
        self.console_logs.lock().unwrap().clear();

        Ok(label)
    }

    pub fn navigate(&self, app: &AppHandle, url: &str) -> Result<(), String> {
        let label = self
            .window_label
            .lock()
            .unwrap()
            .clone()
            .ok_or("No browser window open")?;
        let window = app
            .get_webview_window(&label)
            .ok_or("Browser window not found")?;
        let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
        window
            .navigate(parsed)
            .map_err(|e| format!("Navigation failed: {e}"))
    }

    /// Execute a script in the browser window. The script must be a
    /// self-contained JS expression or IIFE. Dynamic values should be
    /// JSON-serialized by the caller before interpolation.
    pub fn eval(&self, app: &AppHandle, script: &str) -> Result<(), String> {
        let label = self
            .window_label
            .lock()
            .unwrap()
            .clone()
            .ok_or("No browser window open")?;
        let window = app
            .get_webview_window(&label)
            .ok_or("Browser window not found")?;
        window.eval(script).map_err(|e| format!("Eval failed: {e}"))
    }

    pub fn screenshot(&self, app: &AppHandle) -> Result<Vec<u8>, String> {
        let label = self
            .window_label
            .lock()
            .unwrap()
            .clone()
            .ok_or("No browser window open")?;
        let window = app
            .get_webview_window(&label)
            .ok_or("Browser window not found")?;

        let (tx, rx) = std::sync::mpsc::channel();

        window
            .with_webview(move |webview| {
                let result = capture_webview_screenshot(webview);
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;

        rx.recv()
            .map_err(|_| "Screenshot capture was interrupted".to_string())?
    }

    pub fn close(&self, app: &AppHandle) {
        if let Some(label) = self.window_label.lock().unwrap().take() {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
    }

    pub fn is_open(&self, app: &AppHandle) -> bool {
        let label = self.window_label.lock().unwrap().clone();
        match label {
            Some(l) => app.get_webview_window(&l).is_some(),
            None => false,
        }
    }

    pub fn push_console_log(&self, entry: ConsoleEntry) {
        let mut logs = self.console_logs.lock().unwrap();
        logs.push_back(entry);
        if logs.len() > MAX_CONSOLE_ENTRIES {
            logs.pop_front();
        }
    }

    pub fn get_console_logs(&self, level: Option<&str>, limit: usize) -> Vec<ConsoleEntry> {
        let logs = self.console_logs.lock().unwrap();
        let filtered: Vec<ConsoleEntry> = logs
            .iter()
            .filter(|e| level.map_or(true, |l| l == "all" || e.level == l))
            .cloned()
            .collect();
        let start = filtered.len().saturating_sub(limit);
        filtered[start..].to_vec()
    }
}

// ---------------------------------------------------------------------------
// Platform screenshot (full webview capture)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn capture_webview_screenshot(
    webview: tauri::webview::PlatformWebview,
) -> Result<Vec<u8>, String> {
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
fn capture_webview_screenshot(
    _webview: tauri::webview::PlatformWebview,
) -> Result<Vec<u8>, String> {
    Err("Tier 2 screenshot not yet implemented on macOS — use browser_screenshot with the iframe preview instead".to_string())
}

#[cfg(target_os = "linux")]
fn capture_webview_screenshot(
    _webview: tauri::webview::PlatformWebview,
) -> Result<Vec<u8>, String> {
    Err("Tier 2 screenshot not yet implemented on Linux — use browser_screenshot with the iframe preview instead".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn capture_webview_screenshot(
    _webview: tauri::webview::PlatformWebview,
) -> Result<Vec<u8>, String> {
    Err("Screenshot not supported on this platform".to_string())
}
