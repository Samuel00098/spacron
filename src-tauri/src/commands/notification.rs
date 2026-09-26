use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[derive(serde::Deserialize)]
pub struct NotificationPayload {
    title: String,
    body: String,
}

#[cfg(target_os = "windows")]
fn focus_main_window(app: AppHandle) {
    let app_for_thread = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = app_for_thread.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
}

#[tauri::command]
pub async fn notification_show(app: AppHandle, payload: NotificationPayload) -> Result<(), String> {
    show_system_notification(app, payload)
}

/// The AppUserModelID to raise toasts under. Windows silently drops a toast
/// whose ID no Start-menu shortcut registers — `show()` still returns Ok — and
/// only the installer registers ours. A build run straight out of `target\`
/// (`npm run dev:app`, a local release build) borrows PowerShell's registered
/// ID instead, the same rule tauri-plugin-notification applies.
#[cfg(target_os = "windows")]
fn windows_app_id(app: &AppHandle) -> String {
    use tauri_winrt_notification::Toast;

    let installed = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .is_some_and(|dir| !runs_from_cargo_target(&dir));
    if installed {
        app.config().identifier.clone()
    } else {
        Toast::POWERSHELL_APP_ID.to_string()
    }
}

#[cfg(target_os = "windows")]
fn runs_from_cargo_target(dir: &std::path::Path) -> bool {
    let name = |p: &std::path::Path| p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    let profile = name(dir);
    // `target\debug`, or `target\<triple>\release` for a cross build.
    (profile == "debug" || profile == "release") && dir.ancestors().skip(1).take(2).any(|a| name(a) == "target")
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::runs_from_cargo_target;
    use std::path::Path;

    #[test]
    fn only_cargo_output_folders_count_as_uninstalled() {
        assert!(runs_from_cargo_target(Path::new(r"C:\src\spacron\src-tauri\target\debug")));
        assert!(runs_from_cargo_target(Path::new(r"C:\src\spacron\src-tauri\target\release")));
        assert!(runs_from_cargo_target(Path::new(r"C:\src\spacron\target\aarch64-pc-windows-msvc\release")));
        assert!(!runs_from_cargo_target(Path::new(r"C:\Program Files\Spacron")));
        assert!(!runs_from_cargo_target(Path::new(r"C:\Users\me\AppData\Local\Spacron")));
    }
}

#[cfg(target_os = "windows")]
fn show_system_notification(app: AppHandle, payload: NotificationPayload) -> Result<(), String> {
    use tauri_winrt_notification::{Duration, Toast};

    let app_id = windows_app_id(&app);
    let focus_app = app.clone();

    Toast::new(&app_id)
        .title(&payload.title)
        .text1(&payload.body)
        // Long (~25 s): the click handler below only runs while the toast is
        // on screen, and the short one was gone before you could reach it.
        .duration(Duration::Long)
        .on_activated(move |_| {
            focus_main_window(focus_app.clone());
            Ok(())
        })
        .show()
        .map_err(|err| format!("Failed to show Windows notification: {err}"))
}

#[cfg(not(target_os = "windows"))]
fn show_system_notification(app: AppHandle, payload: NotificationPayload) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(payload.title)
        .body(payload.body)
        .show()
        .map_err(|err| format!("Failed to show notification: {err}"))
}
