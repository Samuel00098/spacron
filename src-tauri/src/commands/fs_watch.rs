//! Filesystem watching for the file explorer. Emits a debounced `fs-change`
//! event to the frontend whenever anything under a watched project root changes,
//! so the tree updates the moment an agent (or the user) touches a file — no
//! polling lag, no manual refresh.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Component, Path};
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

/// Directories whose internal churn must not wake the file explorer.
///
/// `.git` is the expensive one: a single commit rewrites the index, refs, logs
/// and objects, so committing from Source Control fired a burst here that made
/// the explorer rebuild its whole tree — on top of the git work the commit was
/// already doing. `node_modules` is the same story for installs.
///
/// This only suppresses the *push*; it does not make the tree wrong. The explorer
/// still lists both directories, and `FileExplorer`'s 15 s backstop poll picks up
/// anything inside them. The trade is that a change under `.git`/`node_modules`
/// surfaces within 15 s instead of 250 ms — nobody watches those live.
const IGNORED_DIRS: [&str; 2] = [".git", "node_modules"];

fn has_ignored_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => IGNORED_DIRS.iter().any(|dir| name == OsStr::new(dir)),
        _ => false,
    })
}

/// Whether an event can be dropped without the explorer missing anything.
///
/// Only events where *every* path is ignorable count: a rename out of
/// `node_modules` into the tree proper must still get through. Errors and
/// path-less events are always delivered — they carry no location to judge.
fn is_ignorable(res: &notify::Result<notify::Event>) -> bool {
    match res {
        Ok(event) => {
            !event.paths.is_empty() && event.paths.iter().all(|p| has_ignored_component(p))
        }
        Err(_) => false,
    }
}

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
    // If the watched root is *itself* inside an ignored directory, filtering would
    // suppress every one of its events. That's a real case — a project opened from
    // inside a `node_modules` tree — so the filter turns itself off rather than
    // silently watching nothing.
    let filter_noise = !has_ignored_component(Path::new(path));

    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        // Drop ignorable events here rather than in the debounce thread, so a
        // burst inside `.git` doesn't even wake it. Everything else is forwarded
        // raw; the debounce thread decides when to emit.
        if filter_noise && is_ignorable(&res) {
            return;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{EventKind, ModifyKind};
    use std::path::PathBuf;

    fn event(paths: &[&str]) -> notify::Result<notify::Event> {
        Ok(notify::Event {
            kind: EventKind::Modify(ModifyKind::Any),
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: Default::default(),
        })
    }

    #[test]
    fn drops_events_confined_to_ignored_directories() {
        // The commit case: git rewriting its own internals must not wake the tree.
        assert!(is_ignorable(&event(&["/p/.git/index"])));
        assert!(is_ignorable(&event(&["/p/.git/refs/heads/main"])));
        assert!(is_ignorable(&event(&["/p/node_modules/react/index.js"])));
        // Several paths, all ignorable — still ignorable.
        assert!(is_ignorable(&event(&["/p/.git/index", "/p/.git/ORIG_HEAD"])));
    }

    #[test]
    fn keeps_events_touching_real_project_files() {
        assert!(!is_ignorable(&event(&["/p/src/main.rs"])));
        // A path merely *containing* the word is not inside the directory.
        assert!(!is_ignorable(&event(&["/p/src/gitignore-parser.ts"])));
        assert!(!is_ignorable(&event(&["/p/.gitignore"])));
    }

    #[test]
    fn keeps_a_rename_out_of_an_ignored_directory() {
        // Both endpoints arrive on one event; dropping it would lose the arrival
        // of the file in the visible tree.
        assert!(!is_ignorable(&event(&[
            "/p/node_modules/thing.js",
            "/p/src/thing.js"
        ])));
    }

    #[test]
    fn keeps_events_it_cannot_place() {
        // No paths to judge, and errors, must always get through.
        assert!(!is_ignorable(&event(&[])));
        assert!(!is_ignorable(&Err(notify::Error::generic("watch failed"))));
    }

    #[test]
    fn filter_disables_itself_for_a_root_inside_an_ignored_directory() {
        // Otherwise every event under such a root would be suppressed and the
        // watch would silently do nothing.
        assert!(has_ignored_component(Path::new("/p/node_modules/pkg")));
        assert!(!has_ignored_component(Path::new("/p/src")));
    }
}
