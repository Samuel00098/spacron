//! Filesystem watching for the file explorer. Emits a debounced `fs-change`
//! event to the frontend whenever anything under a watched project root changes,
//! so the tree updates the moment an agent (or the user) touches a file — no
//! polling lag, no manual refresh.

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// Live watchers keyed by the watched root path. Keeping the `RecommendedWatcher`
/// alive here is what keeps watching active; dropping it stops the OS watch and
/// (because its event channel closes) ends the paired debounce thread.
static WATCHERS: OnceLock<Mutex<HashMap<String, RecommendedWatcher>>> = OnceLock::new();

fn watchers() -> &'static Mutex<HashMap<String, RecommendedWatcher>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Coalesce bursts of raw FS events (a single save can fire several) into at most
// one emit per window. Also caps sustained churn (an agent writing many files)
// to a few emits per second rather than hundreds.
const DEBOUNCE_MS: u64 = 250;

/// Start a recursive, debounced watch on `path`, invoking `on_change` once per
/// settled burst. Returns the live `RecommendedWatcher` — keep it alive to keep
/// watching; drop it to stop the OS watch and end the paired debounce thread.
///
/// Transport-agnostic: the Tauri command emits a `fs-change` event from
/// `on_change`; the remote server pushes an `fsChange` frame instead.
pub fn spawn_watch<F>(path: &str, on_change: F) -> Result<RecommendedWatcher, String>
where
    F: Fn() + Send + 'static,
{
    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        // Forward every raw event; the debounce thread decides when to emit.
        let _ = tx.send(res);
    })
    .map_err(|e| format!("failed to create filesystem watcher: {e}"))?;
    watcher
        .watch(Path::new(path), RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {path}: {e}"))?;

    std::thread::spawn(move || loop {
        // Block until the first event of a burst arrives.
        if rx.recv().is_err() {
            return; // watcher dropped -> channel closed -> stop the thread
        }
        // Swallow the rest of the burst until the filesystem goes quiet for
        // DEBOUNCE_MS (or the window elapses under sustained activity).
        let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        on_change();
    });

    Ok(watcher)
}

#[tauri::command]
pub fn start_fs_watch(app: AppHandle, path: String) -> Result<(), String> {
    let mut map = watchers()
        .lock()
        .map_err(|_| "watch registry lock poisoned".to_string())?;
    if map.contains_key(&path) {
        return Ok(()); // already watching this root
    }

    let emit_path = path.clone();
    let watcher = spawn_watch(&path, move || {
        let _ = app.emit("fs-change", &emit_path);
    })?;

    map.insert(path, watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_fs_watch(path: String) -> Result<(), String> {
    let mut map = watchers()
        .lock()
        .map_err(|_| "watch registry lock poisoned".to_string())?;
    map.remove(&path); // drop -> stops the OS watch and ends the debounce thread
    Ok(())
}
