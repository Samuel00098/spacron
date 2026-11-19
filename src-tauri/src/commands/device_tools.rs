//! Device "Tools" panel backend: app control, appearance, text size, motion,
//! network, layout bounds, location, permissions and full-resolution
//! screenshots, for Android (adb) and the iOS Simulator (`xcrun simctl`).
//!
//! Safety: nothing here runs a host shell — adb and xcrun get a raw argv. adb
//! `shell` arguments *are* parsed by the device's shell, so every free-form
//! value that reaches one (a URL) is single-quoted for it, and every structured
//! value (package, permission, numbers) is validated to a strict charset first.

use std::path::PathBuf;

use serde::Serialize;

use super::mobile::{adb_program, check_serial, quiet_command};

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("Device command failed to run: {e}"))?
}

fn not_found(tool: &str, err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        format!("`{tool}` was not found.")
    } else {
        format!("Failed to run `{tool}`: {err}")
    }
}

/// `adb -s <serial> <args…>`, returning stdout.
fn adb(serial: &str, args: &[&str]) -> Result<String, String> {
    check_serial(serial)?;
    let mut full = vec!["-s", serial];
    full.extend_from_slice(args);
    let out = quiet_command(&adb_program())
        .args(&full)
        .output()
        .map_err(|e| not_found("adb", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn adb_shell(serial: &str, args: &[&str]) -> Result<String, String> {
    let mut full = vec!["shell"];
    full.extend_from_slice(args);
    adb(serial, &full)
}

/// `xcrun simctl <args…>` (macOS only), returning stdout.
fn simctl(args: &[&str]) -> Result<String, String> {
    if cfg!(not(target_os = "macos")) {
        return Err("The iOS Simulator is only available on macOS.".to_string());
    }
    let mut full = vec!["simctl"];
    full.extend_from_slice(args);
    let out = quiet_command("xcrun")
        .args(&full)
        .output()
        .map_err(|e| not_found("xcrun", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Android package / iOS bundle id: letters, digits, `.`, `_`, `-`.
fn check_app_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 255
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        Err("Enter a valid package name (e.g. com.example.app).".to_string())
    }
}

/// Quote a value for the *device* shell that `adb shell` hands its argv to.
fn device_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn check_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() || url.len() > 2048 || url.chars().any(|c| c.is_control()) || !url.contains(':') {
        return Err("Enter a URL or deep link, e.g. https://example.com or myapp://path.".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct DeviceToolsState {
    /// Foreground app package / bundle id, when it can be read.
    pub foreground: Option<String>,
    /// "light" / "dark", when known.
    pub appearance: Option<String>,
    /// Android font scale (1.0 = default), or iOS content size category.
    pub text_size: Option<String>,
    pub reduce_motion: Option<bool>,
    pub network: Option<bool>,
    pub layout_bounds: Option<bool>,
}

/// Read what the Tools panel shows. Each field is best-effort: a value that
/// cannot be read stays `None` rather than failing the whole call.
#[tauri::command]
pub async fn device_tools_state(platform: String, target: String) -> Result<DeviceToolsState, String> {
    check_serial(&target)?;
    blocking(move || {
        if platform == "ios" {
            let appearance = simctl(&["ui", &target, "appearance"]).ok().map(|s| s.trim().to_string());
            let text_size = simctl(&["ui", &target, "content_size"]).ok().map(|s| s.trim().to_string());
            return Ok(DeviceToolsState { appearance, text_size, ..Default::default() });
        }
        let foreground = adb_shell(&target, &["dumpsys", "activity", "activities"])
            .ok()
            .and_then(|out| parse_resumed_package(&out));
        let appearance = adb_shell(&target, &["cmd", "uimode", "night"]).ok().map(|out| {
            if out.to_lowercase().contains("yes") { "dark".to_string() } else { "light".to_string() }
        });
        let text_size = adb_shell(&target, &["settings", "get", "system", "font_scale"])
            .ok()
            .map(|s| s.trim().to_string())
            .map(|s| if s == "null" || s.is_empty() { "1.0".to_string() } else { s });
        let reduce_motion = adb_shell(&target, &["settings", "get", "global", "animator_duration_scale"])
            .ok()
            .map(|s| s.trim() == "0" || s.trim() == "0.0");
        let network = adb_shell(&target, &["settings", "get", "global", "wifi_on"])
            .ok()
            .map(|s| s.trim() != "0");
        let layout_bounds = adb_shell(&target, &["getprop", "debug.layout"])
            .ok()
            .map(|s| s.trim() == "true");
        Ok(DeviceToolsState { foreground, appearance, text_size, reduce_motion, network, layout_bounds })
    })
    .await
}

/// Pull the package of the resumed activity out of `dumpsys activity activities`
/// ("topResumedActivity=ActivityRecord{… u0 com.pkg/.Main t12}").
fn parse_resumed_package(dump: &str) -> Option<String> {
    let line = dump
        .lines()
        .find(|l| l.contains("topResumedActivity") || l.contains("mResumedActivity") || l.contains("ResumedActivity:"))?;
    let token = line.split_whitespace().find(|t| t.contains('/'))?;
    let pkg = token.split('/').next()?.trim_start_matches('{');
    check_app_id(pkg).ok()?;
    Some(pkg.to_string())
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/// `action`: "terminate", "launch" or "relaunch".
#[tauri::command]
pub async fn device_app_action(platform: String, target: String, app: String, action: String) -> Result<(), String> {
    check_serial(&target)?;
    check_app_id(&app)?;
    blocking(move || {
        let terminate = action == "terminate" || action == "relaunch";
        let launch = action == "launch" || action == "relaunch";
        if !terminate && !launch {
            return Err(format!("Unknown app action: {action}"));
        }
        if platform == "ios" {
            if terminate {
                // Not running is fine for a relaunch.
                let r = simctl(&["terminate", &target, &app]);
                if action == "terminate" {
                    r?;
                }
            }
            if launch {
                simctl(&["launch", &target, &app])?;
            }
            return Ok(());
        }
        if terminate {
            adb_shell(&target, &["am", "force-stop", &app])?;
        }
        if launch {
            let out = adb_shell(&target, &["monkey", "-p", &app, "-c", "android.intent.category.LAUNCHER", "1"])?;
            if out.contains("No activities found") {
                return Err(format!("{app} has no launchable activity (is it installed?)."));
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn device_open_url(platform: String, target: String, url: String) -> Result<(), String> {
    check_serial(&target)?;
    check_url(&url)?;
    blocking(move || {
        let url = url.trim().to_string();
        if platform == "ios" {
            simctl(&["openurl", &target, &url]).map(|_| ())
        } else {
            let quoted = device_quote(&url);
            adb_shell(&target, &["am", "start", "-a", "android.intent.action.VIEW", "-d", &quoted]).map(|_| ())
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Emulator settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn device_set_appearance(platform: String, target: String, dark: bool) -> Result<(), String> {
    check_serial(&target)?;
    blocking(move || {
        if platform == "ios" {
            simctl(&["ui", &target, "appearance", if dark { "dark" } else { "light" }]).map(|_| ())
        } else {
            adb_shell(&target, &["cmd", "uimode", "night", if dark { "yes" } else { "no" }]).map(|_| ())
        }
    })
    .await
}

const IOS_CONTENT_SIZES: &[&str] = &[
    "extra-small",
    "small",
    "medium",
    "large",
    "extra-large",
    "extra-extra-large",
    "extra-extra-extra-large",
    "accessibility-medium",
    "accessibility-large",
    "accessibility-extra-large",
    "accessibility-extra-extra-large",
    "accessibility-extra-extra-extra-large",
];

/// Android: `size` is a font scale like "1.15". iOS: a content size category.
#[tauri::command]
pub async fn device_set_text_size(platform: String, target: String, size: String) -> Result<(), String> {
    check_serial(&target)?;
    blocking(move || {
        if platform == "ios" {
            if !IOS_CONTENT_SIZES.contains(&size.as_str()) {
                return Err("Unknown text size.".to_string());
            }
            return simctl(&["ui", &target, "content_size", &size]).map(|_| ());
        }
        let scale: f32 = size.parse().map_err(|_| "Unknown text size.".to_string())?;
        if !(0.5..=2.0).contains(&scale) {
            return Err("Unknown text size.".to_string());
        }
        adb_shell(&target, &["settings", "put", "system", "font_scale", &format!("{scale}")]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn device_set_reduce_motion(platform: String, target: String, on: bool) -> Result<(), String> {
    check_serial(&target)?;
    blocking(move || {
        if platform == "ios" {
            simctl(&[
                "spawn",
                &target,
                "defaults",
                "write",
                "com.apple.Accessibility",
                "ReduceMotionEnabled",
                "-bool",
                if on { "true" } else { "false" },
            ])
            .map(|_| ())
        } else {
            let value = if on { "0" } else { "1" };
            for key in ["animator_duration_scale", "transition_animation_scale", "window_animation_scale"] {
                adb_shell(&target, &["settings", "put", "global", key, value])?;
            }
            Ok(())
        }
    })
    .await
}

/// Android only: Wi-Fi and mobile data together.
#[tauri::command]
pub async fn device_set_network(target: String, on: bool) -> Result<(), String> {
    check_serial(&target)?;
    blocking(move || {
        let verb = if on { "enable" } else { "disable" };
        adb_shell(&target, &["svc", "wifi", verb])?;
        adb_shell(&target, &["svc", "data", verb])?;
        Ok(())
    })
    .await
}

/// Android only: "Show layout bounds" (outline every view).
#[tauri::command]
pub async fn device_set_layout_bounds(target: String, on: bool) -> Result<(), String> {
    check_serial(&target)?;
    blocking(move || {
        adb_shell(&target, &["setprop", "debug.layout", if on { "true" } else { "false" }])?;
        // Poke every process to re-read system properties so the change shows
        // without restarting the app (SYSPROPS_TRANSACTION).
        let _ = adb_shell(&target, &["service", "call", "activity", "1599295570"]);
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Location & permissions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn device_set_location(platform: String, target: String, lat: f64, lng: f64) -> Result<(), String> {
    check_serial(&target)?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return Err("Latitude must be −90…90 and longitude −180…180.".to_string());
    }
    blocking(move || {
        if platform == "ios" {
            simctl(&["location", &target, "set", &format!("{lat},{lng}")]).map(|_| ())
        } else {
            if !target.starts_with("emulator-") {
                return Err("Setting a location needs an emulator; a USB device uses its real GPS.".to_string());
            }
            // `geo fix` takes longitude first.
            adb(&target, &["emu", "geo", "fix", &lng.to_string(), &lat.to_string()]).map(|_| ())
        }
    })
    .await
}

/// Android permission short names → manifest permissions.
fn android_permission(name: &str) -> Option<&'static str> {
    Some(match name {
        "camera" => "android.permission.CAMERA",
        "microphone" => "android.permission.RECORD_AUDIO",
        "location" => "android.permission.ACCESS_FINE_LOCATION",
        "contacts" => "android.permission.READ_CONTACTS",
        "calendar" => "android.permission.READ_CALENDAR",
        "photos" => "android.permission.READ_MEDIA_IMAGES",
        "notifications" => "android.permission.POST_NOTIFICATIONS",
        _ => return None,
    })
}

const IOS_PRIVACY_SERVICES: &[&str] =
    &["camera", "microphone", "location", "contacts", "calendar", "photos", "reminders", "motion"];

#[tauri::command]
pub async fn device_set_permission(
    platform: String,
    target: String,
    app: String,
    permission: String,
    grant: bool,
) -> Result<(), String> {
    check_serial(&target)?;
    check_app_id(&app)?;
    blocking(move || {
        if platform == "ios" {
            if !IOS_PRIVACY_SERVICES.contains(&permission.as_str()) {
                return Err("That permission isn't available on the iOS Simulator.".to_string());
            }
            simctl(&["privacy", &target, if grant { "grant" } else { "revoke" }, &permission, &app]).map(|_| ())
        } else {
            let perm = android_permission(&permission).ok_or_else(|| "Unknown permission.".to_string())?;
            adb_shell(&target, &["pm", if grant { "grant" } else { "revoke" }, &app, perm]).map(|_| ())
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

/// Take a full-resolution screenshot and save it as a PNG under
/// `Pictures/Spacron Screenshots` (falling back to the home folder). Returns
/// the saved path.
#[tauri::command]
pub async fn device_save_screenshot(platform: String, target: String, name: String) -> Result<String, String> {
    check_serial(&target)?;
    blocking(move || {
        let png: Vec<u8> = if platform == "ios" {
            if cfg!(not(target_os = "macos")) {
                return Err("The iOS Simulator is only available on macOS.".to_string());
            }
            let out = quiet_command("xcrun")
                .args(["simctl", "io", &target, "screenshot", "--type", "png", "-"])
                .output()
                .map_err(|e| not_found("xcrun", e))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            out.stdout
        } else {
            check_serial(&target)?;
            let out = quiet_command(&adb_program())
                .args(["-s", &target, "exec-out", "screencap", "-p"])
                .output()
                .map_err(|e| not_found("adb", e))?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            out.stdout
        };
        if png.is_empty() {
            return Err("The device returned an empty screenshot.".to_string());
        }
        // Validate it really is an image before writing it to disk.
        image::load_from_memory(&png).map_err(|e| format!("Screenshot was not a valid image: {e}"))?;

        let dir = dirs::picture_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Spacron Screenshots");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        let safe: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') { c } else { '_' })
            .take(60)
            .collect();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("{}-{stamp}.png", if safe.is_empty() { "device" } else { &safe }));
        std::fs::write(&path, &png).map_err(|e| format!("Could not save screenshot: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_package_is_parsed() {
        let dump = "  topResumedActivity=ActivityRecord{1a2b u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t5}\n";
        assert_eq!(parse_resumed_package(dump).as_deref(), Some("com.google.android.apps.nexuslauncher"));
    }

    #[test]
    fn app_ids_are_validated() {
        assert!(check_app_id("com.example.app").is_ok());
        assert!(check_app_id("com.example; rm -rf /").is_err());
        assert!(check_app_id("").is_err());
    }

    #[test]
    fn urls_are_quoted_for_the_device_shell() {
        assert_eq!(device_quote("myapp://a'b"), "'myapp://a'\\''b'");
        assert!(check_url("https://example.com").is_ok());
        assert!(check_url("no scheme").is_err());
        assert!(check_url("https://x\ny").is_err());
    }
}
