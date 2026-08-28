//! Where the `spacron-open` browser shim lives on this machine.
//!
//! The shim is what an agent's `BROWSER` points at, so that a URL the agent
//! tries to open — a published artifact, a dev server, an OAuth callback —
//! comes back into the preview room instead of launching the system browser.
//! See `opener/src/main.rs` for the shim itself and why it has to be a compiled
//! executable rather than a generated script.
//!
//! Resolution mirrors `remote_deploy::resolve_server_binary_for`, because the
//! two sidecars are staged by the same script and land in the same places: an
//! explicit override first, then next to the running exe (a packaged install),
//! then the dev-tree spots a `npm run server:build` writes to.

use std::path::{Path, PathBuf};

fn shim_file_name() -> String {
    format!("spacron-open{}", std::env::consts::EXE_SUFFIX)
}

/// A candidate is only real if it is a NON-EMPTY file.
///
/// `build.rs` stamps a zero-byte placeholder at the sidecar path on any cargo
/// invocation that finds none there (it has to — see the note on
/// `ensure_sidecar_placeholder`). That placeholder is a perfectly good file as
/// far as `is_file()` is concerned, so a plain existence check would hand every
/// agent in a dev tree a `BROWSER` pointing at something that cannot spawn.
fn is_real_binary(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

/// Absolute path to the shim, or `None` when no build of it can be found.
///
/// `None` is not an error state worth surfacing to the user: it just means
/// agents keep the browser behaviour they had before, so the caller leaves
/// `BROWSER` unset rather than pointing it at something that does not exist.
/// Handing an agent a `BROWSER` that fails to spawn would be strictly worse
/// than not setting it — the agent reports `opener_missing` and the user gets
/// no browser at all.
pub fn resolve_browser_shim() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("SPACRON_OPEN_PATH") {
        if !path.is_empty() {
            let pb = PathBuf::from(&path);
            if is_real_binary(&pb) {
                return Some(pb);
            }
        }
    }

    // Packaged: Tauri copies every `externalBin` next to the app binary and
    // strips the target triple from the name.
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)) {
        let candidate = dir.join(shim_file_name());
        if is_real_binary(&candidate) {
            return Some(candidate);
        }
    }

    // Dev tree: the staged sidecar keeps its triple, and the raw cargo output
    // does not. Both are present after `npm run server:build`.
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let root = PathBuf::from(&manifest);
        let triple_named = format!(
            "spacron-open-{}{}",
            current_triple(),
            std::env::consts::EXE_SUFFIX
        );
        let candidate = root.join("binaries").join(&triple_named);
        if is_real_binary(&candidate) {
            return Some(candidate);
        }
        for profile in ["release", "debug"] {
            let candidate = root.join("target").join(profile).join(shim_file_name());
            if is_real_binary(&candidate) {
                return Some(candidate);
            }
        }
    }

    None
}

/// The host triple, as the sidecar staging script spells it.
///
/// Built from the same `std::env::consts` the shim name uses rather than read
/// from a build-time constant, so a `cargo check` and a bundled build agree.
fn current_triple() -> String {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    match os {
        "windows" => format!("{arch}-pc-windows-msvc"),
        "macos" => format!("{arch}-apple-darwin"),
        _ => format!("{arch}-unknown-{os}-gnu"),
    }
}

/// Path to the browser shim for the frontend to put in an agent's `BROWSER`.
///
/// Returns `null` when there is no shim on this machine.
#[tauri::command]
pub fn browser_shim_path() -> Option<String> {
    resolve_browser_shim().map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_name_carries_the_platform_executable_suffix() {
        let name = shim_file_name();
        assert!(name.starts_with("spacron-open"));
        if cfg!(windows) {
            assert!(name.ends_with(".exe"));
        } else {
            assert_eq!(name, "spacron-open");
        }
    }

    #[test]
    fn an_override_that_is_not_a_file_is_ignored_rather_than_returned() {
        // A stale SPACRON_OPEN_PATH must not make us hand an agent a BROWSER
        // that cannot spawn — falling through to the real search is the whole
        // point of the `is_file` check.
        std::env::set_var("SPACRON_OPEN_PATH", "/definitely/not/here/spacron-open");
        let resolved = resolve_browser_shim();
        std::env::remove_var("SPACRON_OPEN_PATH");
        assert!(resolved.map(|p| p.to_string_lossy().to_string()).map_or(
            true,
            |p| !p.contains("definitely/not/here")
        ));
    }

    #[test]
    fn the_zero_byte_build_placeholder_is_not_accepted_as_a_shim() {
        let dir = std::env::temp_dir().join(format!("spacron-shim-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let placeholder = dir.join(shim_file_name());
        std::fs::File::create(&placeholder).unwrap();
        assert!(placeholder.is_file(), "the placeholder is a file");
        assert!(!is_real_binary(&placeholder), "but it must not pass as a shim");

        std::fs::write(&placeholder, b"MZ").unwrap();
        assert!(is_real_binary(&placeholder), "a non-empty build does pass");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn triple_matches_the_sidecar_naming_on_this_host() {
        let triple = current_triple();
        assert!(triple.contains(std::env::consts::ARCH));
        if cfg!(windows) {
            assert!(triple.ends_with("-pc-windows-msvc"));
        }
    }
}
