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

// ── Native turn signals (CLIs that announce turn ends themselves) ──────────
//
// Some CLIs run a program of the user's choosing when a turn completes (Codex's
// `notify`). That is a signal from the CLI itself, so it does not depend on the
// agent remembering to call `report_status` or echo a sentinel. The program here
// appends `SPACRON-NOTIFY:<nonce> <the CLI's JSON>` to the channel file named
// by the environment Spacron already gives every agent it launches, so the
// tailer, `deliverTurnSignal` and everything downstream are unchanged. Launched
// without that environment (a CLI started outside Spacron) it does nothing.

#[cfg(windows)]
const NOTIFY_SCRIPT_NAME: &str = "codex-notify.ps1";
#[cfg(not(windows))]
const NOTIFY_SCRIPT_NAME: &str = "codex-notify.sh";

#[cfg(windows)]
const NOTIFY_SCRIPT: &str = r#"param([string]$Payload)
$file = $env:SPACRON_TURN_FILE
$token = $env:SPACRON_TURN_TOKEN
if (-not $file -or -not $token) { exit 0 }
$line = ($Payload -replace "[\r\n]+", " ").Trim()
[System.IO.File]::AppendAllText($file, "SPACRON-NOTIFY:$token $line`n", (New-Object System.Text.UTF8Encoding($false)))
"#;

#[cfg(not(windows))]
const NOTIFY_SCRIPT: &str = r#"#!/bin/sh
[ -n "$SPACRON_TURN_FILE" ] && [ -n "$SPACRON_TURN_TOKEN" ] || exit 0
payload=$(printf '%s' "$1" | tr '\r\n' '  ')
printf 'SPACRON-NOTIFY:%s %s\n' "$SPACRON_TURN_TOKEN" "$payload" >> "$SPACRON_TURN_FILE"
"#;

/// True when the user's own Codex config already sets a top-level `notify`, so
/// Spacron leaves it alone rather than replacing their notifier for this launch.
fn codex_config_sets_notify(config: &str) -> bool {
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return false; // `notify` is a top-level key: it must precede any table.
        }
        if line.starts_with("notify") && line["notify".len()..].trim_start().starts_with('=') {
            return true;
        }
    }
    false
}

fn user_codex_config() -> Option<String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))?;
    std::fs::read_to_string(home.join("config.toml")).ok()
}

/// The `-c notify=[...]` launch override for Codex, with the script it points at.
/// A TOML literal string cannot hold a quote, so a path with one is refused.
fn codex_notify_flag(script: &std::path::Path) -> Option<String> {
    let path = script.to_string_lossy().replace('\\', "/");
    if path.contains('\'') || path.contains('"') {
        return None;
    }
    #[cfg(windows)]
    let argv = format!(
        "'powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','{path}'"
    );
    #[cfg(not(windows))]
    let argv = format!("'sh','{path}'");
    Some(format!(" -c \"notify=[{argv}]\""))
}

// ── Antigravity (`agy`) ────────────────────────────────────────────────────
//
// `agy` has no per-launch hooks route (`--settings` rejects a `hooks` key; hooks
// load only from `.agents/hooks.json` or `~/.gemini/config/hooks.json`). Hooks
// there are keyed by NAME, so Spacron adds one named entry beside whatever else
// the user has (another tool's, say) and never edits those. The entry is inert
// outside a Spacron launch: its script exits at once unless the environment
// Spacron gives every agent names a channel. Its `Stop` hook receives JSON on
// stdin; `fullyIdle: false` means the run is continuing, so it is skipped.

const AGY_HOOK_NAME: &str = "spacron-status";

#[cfg(windows)]
const AGY_SCRIPT_NAME: &str = "agy-stop.ps1";
#[cfg(not(windows))]
const AGY_SCRIPT_NAME: &str = "agy-stop.sh";

#[cfg(windows)]
const AGY_SCRIPT: &str = r#"$file = $env:SPACRON_TURN_FILE
$token = $env:SPACRON_TURN_TOKEN
if (-not $file -or -not $token) { exit 0 }
try { $p = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
if ($p.fullyIdle -eq $false) { exit 0 }
$reason = [string]$p.terminationReason
if ($p.error -or $reason -match 'ERROR|MAX_STEPS') {
  $why = if ($p.error) { [string]$p.error } else { "Stopped: $reason" }
  $line = "SPACRON-TURN-FAILED:$token " + (($why -replace '\s+', ' ').Trim())
} else {
  $line = "SPACRON-TURN-DONE:$token"
}
[System.IO.File]::AppendAllText($file, "$line`n", (New-Object System.Text.UTF8Encoding($false)))
"#;

#[cfg(not(windows))]
const AGY_SCRIPT: &str = r#"#!/bin/sh
[ -n "$SPACRON_TURN_FILE" ] && [ -n "$SPACRON_TURN_TOKEN" ] || exit 0
input=$(cat)
case "$input" in *'"fullyIdle":false'*) exit 0 ;; esac
reason=$(printf '%s' "$input" | sed -n 's/.*"terminationReason":"\([^"]*\)".*/\1/p')
case "$reason" in
  *ERROR*|*MAX_STEPS*) printf 'SPACRON-TURN-FAILED:%s Stopped: %s\n' "$SPACRON_TURN_TOKEN" "$reason" ;;
  *) printf 'SPACRON-TURN-DONE:%s\n' "$SPACRON_TURN_TOKEN" ;;
esac >> "$SPACRON_TURN_FILE"
"#;

fn antigravity_hooks_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".gemini").join("config").join("hooks.json"))
}

/// Where the Stop script lives. Not the temp dir: the user's hooks file names
/// it permanently, so it has to survive a temp clean.
fn antigravity_script_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("spacron").join("agent-hooks"))
}

fn antigravity_hook_command(script: &std::path::Path) -> Option<String> {
    let path = script.to_string_lossy().replace('\\', "/");
    if path.contains('"') {
        return None;
    }
    #[cfg(windows)]
    return Some(format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{path}\""
    ));
    #[cfg(not(windows))]
    return Some(format!("sh \"{path}\""));
}

/// The hooks file's new text with Spacron's entry added (`Some(command)`) or
/// removed (`None`), or `None` when nothing has to change. Other hooks are kept.
/// A file that is not a JSON object is left alone (`Err`): it is the user's.
fn merge_antigravity_hook(existing: Option<&str>, command: Option<&str>) -> Result<Option<String>, ()> {
    let mut root = match existing.map(str::trim).filter(|t| !t.is_empty()) {
        None => serde_json::Map::new(),
        Some(text) => match serde_json::from_str::<serde_json::Value>(text) {
            Ok(serde_json::Value::Object(map)) => map,
            _ => return Err(()),
        },
    };
    let wanted = command.map(|c| {
        serde_json::json!({ "Stop": [{ "type": "command", "command": c, "timeout": 10 }] })
    });
    if root.get(AGY_HOOK_NAME) == wanted.as_ref() {
        return Ok(None);
    }
    match wanted {
        Some(entry) => {
            root.insert(AGY_HOOK_NAME.to_string(), entry);
        }
        None => {
            root.remove(AGY_HOOK_NAME);
        }
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .map(|text| Some(text + "\n"))
        .map_err(|_| ())
}

fn write_atomically(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("json.spacron-tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Add or remove Spacron's Antigravity hook. Best effort: any failure leaves the
/// user's file as it was and agy on the detection it already had.
fn sync_antigravity_hook(enabled: bool) -> Option<()> {
    let hooks_path = antigravity_hooks_path()?;
    let existing = std::fs::read_to_string(&hooks_path).ok();
    let command = if enabled {
        let dir = antigravity_script_dir()?;
        std::fs::create_dir_all(&dir).ok()?;
        let script = dir.join(AGY_SCRIPT_NAME);
        std::fs::write(&script, AGY_SCRIPT).ok()?;
        Some(antigravity_hook_command(&script)?)
    } else {
        // Nothing to remove from a file that is not there.
        existing.as_ref()?;
        None
    };
    let changed = merge_antigravity_hook(existing.as_deref(), command.as_deref()).ok()??;
    std::fs::create_dir_all(hooks_path.parent()?).ok()?;
    write_atomically(&hooks_path, &changed).ok()
}

/// Launch flags that make a CLI announce its own turn ends, or `None` when this
/// CLI has no such hook, the user already has one, or the script could not be
/// written. `None` just means that CLI keeps the fallbacks it already had.
/// `enabled` mirrors Settings > Agents status hooks; turning it off also takes
/// Spacron's Antigravity hook back out of the user's file.
#[tauri::command]
pub fn agent_turn_signal_flags(agent: String, enabled: Option<bool>) -> Option<String> {
    let enabled = enabled.unwrap_or(true);
    if agent == "agy" {
        sync_antigravity_hook(enabled);
        return None;
    }
    if agent != "codex" || !enabled {
        return None;
    }
    if user_codex_config().is_some_and(|c| codex_config_sets_notify(&c)) {
        return None;
    }
    let dir = channel_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let script = dir.join(NOTIFY_SCRIPT_NAME);
    std::fs::write(&script, NOTIFY_SCRIPT).ok()?;
    codex_notify_flag(&script)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn a_users_own_codex_notify_is_detected_and_tables_end_the_search() {
        assert!(codex_config_sets_notify("model = \"x\"\nnotify = [\"say\", \"done\"]\n"));
        assert!(codex_config_sets_notify("notify=[\"a\"]"));
        // Inside a table it is a different key, and the top level has none.
        assert!(!codex_config_sets_notify("model = \"x\"\n[tui]\nnotify = true\n"));
        assert!(!codex_config_sets_notify("notifications = true\n"));
    }

    #[test]
    fn the_codex_flag_quotes_for_every_shell_and_refuses_unquotable_paths() {
        let flag = codex_notify_flag(std::path::Path::new("C:\\Users\\A B\\codex-notify.ps1")).unwrap();
        assert!(flag.starts_with(" -c \"notify=['"), "{flag}");
        assert!(flag.contains("C:/Users/A B/codex-notify.ps1"), "{flag}");
        assert!(flag.ends_with("]\""), "{flag}");
        assert!(codex_notify_flag(std::path::Path::new("/home/o'brien/x.sh")).is_none());
    }

    #[test]
    fn only_codex_gets_native_flags() {
        assert!(agent_turn_signal_flags("claude".into(), None).is_none());
        assert!(agent_turn_signal_flags("unknown".into(), None).is_none());
    }

    #[test]
    fn the_antigravity_entry_is_added_beside_other_hooks_and_removed_cleanly() {
        let theirs = r#"{"orca-status":{"Stop":[{"type":"command","command":"x"}]}}"#;
        let added = merge_antigravity_hook(Some(theirs), Some("run it")).unwrap().unwrap();
        let value: serde_json::Value = serde_json::from_str(&added).unwrap();
        assert_eq!(value["orca-status"]["Stop"][0]["command"], "x");
        assert_eq!(value[AGY_HOOK_NAME]["Stop"][0]["command"], "run it");
        // Already there: nothing to write.
        assert_eq!(merge_antigravity_hook(Some(&added), Some("run it")), Ok(None));
        // A new script path replaces ours, never theirs.
        let moved = merge_antigravity_hook(Some(&added), Some("elsewhere")).unwrap().unwrap();
        assert!(moved.contains("elsewhere") && !moved.contains("run it") && moved.contains("orca-status"));
        // Removing leaves exactly their content.
        let removed = merge_antigravity_hook(Some(&added), None).unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&removed).unwrap(),
            serde_json::from_str::<serde_json::Value>(theirs).unwrap()
        );
        assert_eq!(merge_antigravity_hook(Some(theirs), None), Ok(None));
    }

    #[test]
    fn an_antigravity_hooks_file_that_is_not_an_object_is_left_alone() {
        assert_eq!(merge_antigravity_hook(Some("not json"), Some("c")), Err(()));
        assert_eq!(merge_antigravity_hook(Some("[1,2]"), Some("c")), Err(()));
        assert!(merge_antigravity_hook(None, Some("c")).unwrap().unwrap().contains(AGY_HOOK_NAME));
        assert!(merge_antigravity_hook(Some("  "), Some("c")).unwrap().is_some());
    }

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
