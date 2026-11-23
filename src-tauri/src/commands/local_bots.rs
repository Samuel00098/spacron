//! Bots on this PC: the same runner as a box's (`remote/bots.rs`), run inside
//! the desktop app over its own folder, for people without a box yet.
//!
//! Local bots run while Spacron is open. Their files live in
//! `<config dir>/bots-local/.spacron/bots/`.

use std::path::PathBuf;

use serde_json::Value;
use tauri::State;

use crate::remote::bots;
use crate::state::AppState;

/// The folder local bots live in.
pub fn local_root(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join("bots-local")
}

/// Started once from `setup`, so schedules fire without opening the panel.
pub fn start(config_dir: &std::path::Path) {
    let root = local_root(config_dir);
    if std::fs::create_dir_all(&root).is_ok() {
        tauri::async_runtime::spawn(bots::run_loop(root));
    }
}

#[tauri::command]
pub fn local_bots_sync(args: Value, state: State<AppState>) -> Result<Value, String> {
    bots::sync(args, &local_root(&state.config_dir))
}

#[tauri::command]
pub fn local_bots_state(state: State<AppState>) -> Result<Value, String> {
    bots::state(&local_root(&state.config_dir))
}

#[tauri::command]
pub async fn local_bot_run_now(args: Value, state: State<'_, AppState>) -> Result<Value, String> {
    // Async so the run is spawned on Tauri's tokio runtime.
    bots::run_now(args, &local_root(&state.config_dir))
}

#[tauri::command]
pub fn local_bot_log(args: Value, state: State<AppState>) -> Result<Value, String> {
    bots::log(args, &local_root(&state.config_dir))
}

#[tauri::command]
pub fn local_bot_stop(args: Value, state: State<AppState>) -> Result<Value, String> {
    bots::stop(args, &local_root(&state.config_dir))
}

#[tauri::command]
pub fn local_bot_proposals_ack(args: Value, state: State<AppState>) -> Result<Value, String> {
    bots::proposals_ack(args, &local_root(&state.config_dir))
}
