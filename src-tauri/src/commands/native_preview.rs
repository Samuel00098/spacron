use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn native_preview_create(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    state.native_preview.create(&app, &url, x, y, width, height)
}

#[tauri::command]
pub fn native_preview_navigate(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    state.native_preview.navigate(&app, &url)
}

#[tauri::command]
pub fn native_preview_set_bounds(
    app: AppHandle,
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    state.native_preview.set_bounds(&app, x, y, width, height)
}

#[tauri::command]
pub fn native_preview_show(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.native_preview.show(&app)
}

#[tauri::command]
pub fn native_preview_hide(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.native_preview.hide(&app)
}

#[tauri::command]
pub fn native_preview_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    state.native_preview.screenshot(&app)
}

#[tauri::command]
pub fn native_preview_eval(
    app: AppHandle,
    state: State<'_, AppState>,
    script: String,
) -> Result<(), String> {
    state.native_preview.eval(&app, &script)
}

#[tauri::command]
pub fn native_preview_close(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.native_preview.close(&app);
    Ok(())
}

#[tauri::command]
pub fn native_preview_is_active(app: AppHandle, state: State<'_, AppState>) -> bool {
    state.native_preview.is_active(&app)
}

#[tauri::command]
pub fn native_preview_console_event(
    app: AppHandle,
    level: String,
    message: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let _ = app.emit(
        "native-preview:console",
        serde_json::json!({ "level": level, "message": message }),
    );
    Ok(())
}
