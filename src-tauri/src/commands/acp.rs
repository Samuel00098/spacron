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

#[tauri::command]
pub fn acp_request(
    id: u32,
    request_id: String,
    method: String,
    params: Value,
    state: State<AppState>,
) -> Result<Value, String> {
    state.acp_manager.request(id, request_id, method, params)
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
pub fn acp_close(id: u32, state: State<AppState>) -> Result<(), String> {
    state.acp_manager.close(id)
}
