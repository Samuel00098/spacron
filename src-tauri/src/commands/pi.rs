use crate::pi::{PiStartArgs, PiStartResult};
use crate::state::AppState;
use serde_json::Value;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn pi_start(args: PiStartArgs, app: AppHandle, state: State<AppState>) -> Result<PiStartResult, String> {
    state.pi_manager.start(args, app)
}

#[tauri::command]
pub fn pi_command(id: u32, record: Value, state: State<AppState>) -> Result<(), String> {
    state.pi_manager.command(id, record)
}

#[tauri::command]
pub fn pi_close(id: u32, state: State<AppState>) -> Result<(), String> {
    state.pi_manager.close(id)
}
