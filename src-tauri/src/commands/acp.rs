use crate::acp::{AcpStartArgs, AcpStartResult};
use crate::state::AppState;
use serde_json::Value;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn acp_start(
    args: AcpStartArgs,
    app: AppHandle,
    state: State<AppState>,
) -> Result<AcpStartResult, String> {
    state.acp_manager.start(args, app)
}

/// Wait for provider replies off Tauri's main thread.
#[tauri::command]
pub async fn acp_request(
    id: u32,
    request_id: String,
    method: String,
    params: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let manager = std::sync::Arc::clone(&state.acp_manager);
    tauri::async_runtime::spawn_blocking(move || manager.request(id, request_id, method, params))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn acp_respond(
    id: u32,
    request_id: Value,
    result: Value,
    error: Option<Value>,
    state: State<AppState>,
) -> Result<(), String> {
    state.acp_manager.respond(id, request_id, result, error)
}

#[tauri::command]
pub fn acp_notify(
    id: u32,
    method: String,
    params: Value,
    state: State<AppState>,
) -> Result<(), String> {
    state.acp_manager.notify(id, method, params)
}

#[tauri::command]
pub fn acp_write_raw(id: u32, text: String, state: State<AppState>) -> Result<(), String> {
    state.acp_manager.write_raw(id, text)
}

#[tauri::command]
pub fn acp_close(id: u32, state: State<AppState>) -> Result<(), String> {
    state.acp_manager.close(id)
}
