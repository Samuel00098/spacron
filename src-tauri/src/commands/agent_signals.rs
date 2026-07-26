//! Deterministic agent turn signals.
//!
//! Turn state used to be guessed from the agent's screen — a terminal bell, an
//! English regex over the output tail, and a 90-second idle fallback that
//! false-completed turns and released the lease before the real answer arrived.
//! This module is the other half of the replacement: a per-session append-only
//! file that the agent's own hooks write a sentinel line to, tailed here and
//! pushed to the frontend as an `agent-signal` event.
//!
//! Why a file and not the terminal: hook stdout is captured by the agent CLI and
//! never reaches the PTY, and writing to the controlling terminal device is
//! shell- and platform-specific. `echo <line>>><path>` behaves identically in
//! `cmd.exe` and in POSIX shells, which is the whole requirement.
//!
//! The frontend never chooses the path — `agent_signal_channel_open` picks it and
//! hands it back — so there is no way to aim the watcher at an arbitrary file.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use notify::RecommendedWatcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One sentinel line observed on a channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSignal {
    pub channel_id: String,
    /// The raw line, trimmed. Interpreting it is the frontend's job — the nonce
    /// that makes it trustworthy is only known there.
    pub line: String,
}

struct Channel {
    path: PathBuf,
    /// Kept alive to keep the OS watch running; dropped on close.
    _watcher: RecommendedWatcher,
}

static CHANNELS: OnceLock<Mutex<HashMap<String, Channel>>> = OnceLock::new();

fn channels() -> &'static Mutex<HashMap<String, Channel>> {
    CHANNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where the channel files live. Deliberately outside the project: a signal file
/// inside the repo would show up in the user's git surface and wake the file
/// explorer's watcher on every turn.
fn channel_dir() -> PathBuf {
    std::env::temp_dir().join("spacron-agent-signals")
}

/// Channels are opened before the terminal session exists (the launch command
/// has to carry the settings path), so they are keyed by the caller's nonce
/// rather than a session id. That nonce becomes part of a filename, so it is
/// restricted to characters that cannot escape the directory or mean anything
/// to a shell.
fn validate_channel_id(channel_id: &str) -> Result<(), String> {
    if channel_id.is_empty() || channel_id.len() > 64 {
        return Err("Invalid agent signal channel id".to_string());
    }
    if !channel_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid agent signal channel id".to_string());
    }
    Ok(())
}

fn channel_path(channel_id: &str) -> PathBuf {
    // The pid keeps two Spacron instances (a real workflow — see the
    // running-two-instances note) from colliding in the shared temp directory.
    channel_dir().join(format!("{}-{channel_id}.signals", std::process::id()))
}

/// Read everything after `offset`, returning the complete lines found and the
/// new offset. A trailing partial line is left for the next read: a hook's
/// `echo` is not guaranteed to land atomically, and half a sentinel must never
/// be reported as a turn ending.
fn read_new_lines(path: &PathBuf, offset: &mut u64) -> Vec<String> {
    let Ok(mut file) = OpenOptions::new().read(true).open(path) else {
        return Vec::new();
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return Vec::new(),
    };
    // Truncated or replaced (a new session reusing the id) — start over.
    if len < *offset {
        *offset = 0;
    }
    if len == *offset {
        return Vec::new();
    }
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return Vec::new();
    }

    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return Vec::new();
    }

    let consumed = match buf.rfind('\n') {
        Some(i) => i + 1,
        None => return Vec::new(), // nothing complete yet
    };
    *offset += consumed as u64;

    buf[..consumed]
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// Open a signal channel and start tailing it. Returns the path the agent's
/// hooks should append to.
#[tauri::command]
pub fn agent_signal_channel_open(app: AppHandle, channel_id: String) -> Result<String, String> {
    validate_channel_id(&channel_id)?;

    let mut map = channels()
        .lock()
        .map_err(|_| "agent signal registry lock poisoned".to_string())?;
    if let Some(existing) = map.get(&channel_id) {
        return Ok(existing.path.to_string_lossy().to_string());
    }

    let dir = channel_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the agent signal directory: {e}"))?;

    let path = channel_path(&channel_id);
    std::fs::write(&path, b"")
        .map_err(|e| format!("Could not create the agent signal channel: {e}"))?;

    let watch_path = path.clone();
    let emit_id = channel_id.clone();
    // `spawn_watch` takes an `Fn`, and the debounce thread is the only caller, so
    // the read cursor lives behind a mutex rather than in the closure.
    let offset = Mutex::new(0u64);
    // The directory is watched rather than the file: a watch on a path that gets
    // replaced (rather than appended to) can lose the inode on some platforms.
    // The directory holds only our own channel files, and each watcher reads
    // just its own, so other channels' events cost one no-op read.
    let watcher = crate::commands::fs_watch::spawn_watch(&dir.to_string_lossy(), move || {
        let Ok(mut offset) = offset.lock() else { return };
        for line in read_new_lines(&watch_path, &mut offset) {
            let _ = app.emit(
                "agent-signal",
                AgentSignal {
                    channel_id: emit_id.clone(),
                    line,
                },
            );
        }
    })?;

    let resolved = path.to_string_lossy().to_string();
    map.insert(
        channel_id,
        Channel {
            path,
            _watcher: watcher,
        },
    );
    Ok(resolved)
}

/// Stop tailing a channel and remove its files.
#[tauri::command]
pub fn agent_signal_channel_close(channel_id: String) -> Result<(), String> {
    validate_channel_id(&channel_id)?;
    let mut map = channels()
        .lock()
        .map_err(|_| "agent signal registry lock poisoned".to_string())?;
    if let Some(channel) = map.remove(&channel_id) {
        // Best effort: the settings file sits beside the channel and is written
        // by the frontend, but cleaning both here means a crashed renderer
        // doesn't leave credentials-free but confusing litter in temp.
        let settings = channel.path.with_extension("signals.settings.json");
        let _ = std::fs::remove_file(&channel.path);
        let _ = std::fs::remove_file(settings);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("spacron-signal-test-{name}"));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn reads_complete_lines_and_advances_the_offset() {
        let path = temp_file("complete");
        std::fs::write(&path, "ONE\nTWO\n").unwrap();

        let mut offset = 0;
        assert_eq!(read_new_lines(&path, &mut offset), vec!["ONE", "TWO"]);
        // Nothing new on a second pass.
        assert!(read_new_lines(&path, &mut offset).is_empty());

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "THREE").unwrap();
        drop(file);
        assert_eq!(read_new_lines(&path, &mut offset), vec!["THREE"]);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn withholds_a_partial_line_until_it_is_terminated() {
        // A hook's echo is not atomic. Reporting half a sentinel would end a turn
        // on a line that isn't there yet.
        let path = temp_file("partial");
        std::fs::write(&path, "SPACRON-TURN-").unwrap();

        let mut offset = 0;
        assert!(read_new_lines(&path, &mut offset).is_empty());
        assert_eq!(offset, 0);

        std::fs::write(&path, "SPACRON-TURN-DONE:abc\n").unwrap();
        assert_eq!(read_new_lines(&path, &mut offset), vec!["SPACRON-TURN-DONE:abc"]);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn restarts_when_the_file_shrinks() {
        // A reused session id truncates the channel; the stale offset would
        // otherwise skip past the new agent's first turns.
        let path = temp_file("shrink");
        std::fs::write(&path, "OLD-AND-LONG\nSTILL-OLD\n").unwrap();
        let mut offset = 0;
        assert_eq!(read_new_lines(&path, &mut offset).len(), 2);

        std::fs::write(&path, "NEW\n").unwrap();
        assert_eq!(read_new_lines(&path, &mut offset), vec!["NEW"]);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ignores_blank_lines() {
        let path = temp_file("blank");
        std::fs::write(&path, "\n\nREAL\n\n").unwrap();
        let mut offset = 0;
        assert_eq!(read_new_lines(&path, &mut offset), vec!["REAL"]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_channel_ids_that_could_escape_the_directory() {
        // The id becomes a filename, so anything path-like or shell-meaningful
        // has to be refused rather than sanitised.
        assert!(validate_channel_id("a1b2c3").is_ok());
        assert!(validate_channel_id("with-dashes-1234").is_ok());
        assert!(validate_channel_id("").is_err());
        assert!(validate_channel_id("../../etc/passwd").is_err());
        assert!(validate_channel_id("a/b").is_err());
        assert!(validate_channel_id("a\\b").is_err());
        assert!(validate_channel_id("a b").is_err());
        assert!(validate_channel_id(&"x".repeat(65)).is_err());
    }
}
