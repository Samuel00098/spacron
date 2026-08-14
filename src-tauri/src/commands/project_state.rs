//! Per-project **app-private** state, stored outside the user's repository.
//!
//! Spacron used to keep its bookkeeping — the orchestrator's task list, its
//! memory and evolved profile, the agent mailbox, the task board, and the
//! generated MCP config — in `<project>/.spacron/`. That put six app-owned files
//! inside every repo the user opened, where they showed up in file trees and
//! searches, and where the MCP config sat in the working tree carrying the local
//! server's auth token.
//!
//! None of those files is ever read by an agent CLI or by the user, so none of
//! them needs to live in the project. They now live under
//! `config_dir/project-state/<project_id>/<key>`, keyed by the project's UUIDv5
//! (derived from its canonical path, so it is stable across restarts).
//!
//! What deliberately **stays** in the repo:
//!   - `.spacron/worktrees/` — must be under the project root, because
//!     `terminal_create` runs its cwd through `require_in_project`.
//!   - `.spacron/memory/` — the shared agent knowledge base. Agents are pointed
//!     at it by the standing brief, and it is the user's content.
//!   - `.spacron/reports/` — how a delegated worker signals completion; written
//!     by the worker's own (root-confined) file tools.
//!   - `CLAUDE.md` / `AGENTS.md` / `.mcp.json` / `.cursor/mcp.json` /
//!     `opencode.json` — the CLIs only discover these from the project root.
//!
//! ## Trust boundary
//!
//! These commands take an id and a key, never a path. Both are validated against
//! a strict charset and the result is joined onto `config_dir`, so a caller
//! cannot traverse out of the state directory. This is the same shape as
//! `app_flags` and `background`, and it is why moving these files does **not**
//! require relaxing `require_in_roots` (the confinement check that silently
//! killed the Codex MCP config write — see `.spacron/memory/mcp-architecture.md`).

use crate::state::AppState;
use std::path::PathBuf;
use tauri::State;

/// Accept only characters that are unambiguously safe in a single path segment.
/// Rejects separators, `..`, and anything empty or over-long, so a validated
/// segment can never escape the state directory.
fn safe_segment(value: &str, label: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("Invalid {label}: must be 1-128 characters"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!(
            "Invalid {label}: only letters, digits, '-', '_' and '.' are allowed"
        ));
    }
    // `.` and `..` are legal under the charset above but are directory
    // references, not names.
    if value.chars().all(|c| c == '.') {
        return Err(format!("Invalid {label}: reserved name"));
    }
    Ok(value.to_string())
}

fn project_dir(state: &State<AppState>, project_id: &str) -> Result<PathBuf, String> {
    let id = safe_segment(project_id, "project id")?;
    Ok(state.config_dir.join("project-state").join(id))
}

fn state_path(state: &State<AppState>, project_id: &str, key: &str) -> Result<PathBuf, String> {
    let key = safe_segment(key, "state key")?;
    Ok(project_dir(state, project_id)?.join(key))
}

/// Every command below touches the disk, so all four are `#[tauri::command(async)]`
/// — a plain `#[tauri::command]` runs on the main thread, which is the window's
/// message pump, and a stalled write (or the `remove_dir_all` in
/// `project_state_clear`) freezes the whole window while it waits. Same reasoning
/// and same fix as `commands::file_system`; these were missed for the same reason.
///
/// Concurrency is safe: each command re-validates its own segments and the paths
/// are per-project and per-key, so two of them never contend for one file that
/// they could not already have contended for from the frontend.

/// Read one app-private state file. `None` when it has never been written —
/// callers treat that as "no saved state" and fall back to their defaults.
#[tauri::command(async)]
pub fn project_state_read(
    project_id: String,
    key: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let path = state_path(&state, &project_id, &key)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Failed to read project state: {err}")),
    }
}

/// Write one app-private state file, creating the project's directory on demand.
#[tauri::command(async)]
pub fn project_state_write(
    project_id: String,
    key: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    let path = state_path(&state, &project_id, &key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create project state dir: {e}"))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("Failed to write project state: {e}"))
}

/// Absolute path to one state file, for the cases that must hand a real path to
/// an external process — notably the generated MCP config, which reaches the CLI
/// as `--mcp-config <path>`. Creates the directory so the caller can write there.
#[tauri::command(async)]
pub fn project_state_path(
    project_id: String,
    key: String,
    state: State<AppState>,
) -> Result<String, String> {
    let path = state_path(&state, &project_id, &key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create project state dir: {e}"))?;
    }
    Ok(super::clean_path_buf(path).to_string_lossy().to_string())
}

/// Drop every app-private file for a project. Called when the user removes a
/// project from the workspace, so closing a project doesn't leave its
/// bookkeeping behind forever.
#[tauri::command(async)]
pub fn project_state_clear(project_id: String, state: State<AppState>) -> Result<(), String> {
    let dir = project_dir(&state, &project_id)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to clear project state: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::safe_segment;

    #[test]
    fn accepts_a_uuid_project_id() {
        assert!(safe_segment("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "project id").is_ok());
    }

    #[test]
    fn accepts_ordinary_state_keys() {
        for key in ["orchestrator.json", "mailbox.json", "claude.json"] {
            assert!(safe_segment(key, "state key").is_ok(), "{key} should be accepted");
        }
    }

    /// The whole point of the charset check: no caller can climb out of the
    /// state directory, whatever it passes.
    #[test]
    fn rejects_traversal_and_separators() {
        for bad in ["..", ".", "../etc/passwd", "a/b", "a\\b", "", "a b", "a:b"] {
            assert!(
                safe_segment(bad, "state key").is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_over_long_segments() {
        assert!(safe_segment(&"a".repeat(129), "state key").is_err());
    }
}
