use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn browser_create_window(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    state.browser_window.create(&app, &url)
}

#[tauri::command]
pub fn browser_navigate_window(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    state.browser_window.navigate(&app, &url)
}

#[tauri::command]
pub fn browser_close_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.browser_window.close(&app);
    Ok(())
}

#[tauri::command]
pub fn browser_screenshot_window(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    state.browser_window.screenshot(&app)
}

#[tauri::command]
pub fn browser_window_is_open(app: AppHandle, state: State<'_, AppState>) -> bool {
    state.browser_window.is_open(&app)
}
