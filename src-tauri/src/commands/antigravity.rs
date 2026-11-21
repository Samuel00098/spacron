//! Managed Google Antigravity ACP runtime.
//!
//! Antigravity does not speak ACP through the `agy` CLI: Google ships a separate
//! extension server (`agy_acp_server`, plus its `localharness_external` helper)
//! that T3-style clients download per platform. Spacron installs that archive
//! into its own config directory, verifies the registry's sha256 before anything
//! is unpacked, and hands Chat the executable path.
//!
//! Every URL and hash below is the ACP registry's `antigravity-acp` entry at
//! version 1.4.5 (fetched 2026-11-03). When the registry moves, update the table
//! — never download an archive this table does not name, and never install one
//! whose hash does not match.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Registry version this table describes.
pub const RUNTIME_VERSION: &str = "1.4.5";

struct RuntimeArchive {
    key: &'static str,
    url: &'static str,
    sha256: &'static str,
    /// Entry inside the archive, as the registry spells it (`./name`).
    cmd: &'static str,
}

const ARCHIVES: &[RuntimeArchive] = &[
    RuntimeArchive {
        key: "darwin-aarch64",
        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
        sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
        cmd: "./agy_acp_server.par",
    },
    RuntimeArchive {
        key: "darwin-x86_64",
        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
        sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
        cmd: "./agy_acp_server.par",
    },
    RuntimeArchive {
        key: "linux-x86_64",
        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
        sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
        cmd: "./agy_acp_server.par",
    },
    RuntimeArchive {
        key: "linux-aarch64",
        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
        sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
        cmd: "./agy_acp_server.par",
    },
    RuntimeArchive {
        key: "windows-x86_64",
        url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip",
        sha256: "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50",
        cmd: "agy_acp_server.exe",
    },
    RuntimeArchive {
        key: "windows-aarch64",
        url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip",
        sha256: "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c",
        cmd: "agy_acp_server.exe",
    },
];

fn platform_key() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-aarch64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "linux-aarch64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x86_64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "windows-aarch64"
    } else {
        ""
    }
}

fn archive_for_platform() -> Option<&'static RuntimeArchive> {
    let key = platform_key();
    if key.is_empty() {
        return None;
    }
    ARCHIVES.iter().find(|archive| archive.key == key)
}

/// `<config>/antigravity/<version>/` — Spacron's own copy, so a reinstall can
/// replace it without touching anything the user extracted by hand.
fn runtime_root() -> PathBuf {
    crate::mcp::config_dir().join("antigravity").join(RUNTIME_VERSION)
}

fn executable_in(root: &Path, archive: &RuntimeArchive) -> PathBuf {
    root.join(archive.cmd.trim_start_matches("./").replace('\\', "/"))
}

#[derive(serde::Serialize)]
pub struct AntigravityRuntimeStatus {
    /// The ACP server is present and launchable at `path`.
    installed: bool,
    /// True when the copy is Spacron's managed one (removable by a reinstall).
    managed: bool,
    version: String,
    path: Option<String>,
    /// False when the registry publishes no runtime for this OS/arch.
    supported: bool,
}

fn status() -> AntigravityRuntimeStatus {
    let archive = archive_for_platform();
    let root = runtime_root();
    let path = archive.map(|archive| executable_in(&root, archive));
    let installed = path.as_ref().is_some_and(|path| path.is_file());
    AntigravityRuntimeStatus {
        installed,
        managed: installed,
        version: RUNTIME_VERSION.to_string(),
        path: installed
            .then(|| path.map(|path| path.to_string_lossy().to_string()))
            .flatten(),
        supported: archive.is_some(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// One archive entry's relative path, or `None` when it could escape `dest`.
fn safe_relative(name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            other => out.push(other),
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o755);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

fn make_tree_executable(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            make_tree_executable(&path);
        } else {
            make_executable(&path);
        }
    }
}

/// Unpack `bytes` into `dest` (replacing it), refusing unsafe paths and
/// oversized archives. Same contract as the plugin installer, which is the only
/// other place Spacron extracts third-party archives.
fn extract_archive(bytes: &[u8], dest: &Path) -> Result<(), String> {
    const MAX_FILES: usize = 2_000;
    const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("the Antigravity runtime archive is not a zip file: {error}"))?;
    let tmp = dest.with_extension("installing");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|error| error.to_string())?;
    let (mut files, mut total) = (0usize, 0u64);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let entry_name = entry.name().map_err(|error| error.to_string())?.replace('\\', "/");
        let Some(rel) = safe_relative(&entry_name) else {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("the Antigravity runtime archive contains an unsafe path".into());
        };
        let out = tmp.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|error| error.to_string())?;
            continue;
        }
        files += 1;
        total = total.saturating_add(entry.size());
        if files > MAX_FILES || total > MAX_EXTRACTED_BYTES {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("the Antigravity runtime archive is larger than expected".into());
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut data).map_err(|error| error.to_string())?;
        std::fs::write(&out, data).map_err(|error| error.to_string())?;
    }
    if files == 0 {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("the Antigravity runtime archive was empty".into());
    }
    let _ = std::fs::remove_dir_all(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|error| error.to_string())?;
    make_tree_executable(dest);
    Ok(())
}

/// What Chat should launch for Antigravity, if a managed copy is installed.
#[tauri::command]
pub fn antigravity_runtime_status() -> AntigravityRuntimeStatus {
    status()
}

/// Download, verify and install the Antigravity ACP runtime for this platform.
#[tauri::command]
pub async fn antigravity_runtime_install() -> Result<AntigravityRuntimeStatus, String> {
    let archive = archive_for_platform()
        .ok_or_else(|| "Google publishes no Antigravity ACP runtime for this platform".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        // The runtime is tens of megabytes; a short timeout would fail on slow
        // links rather than on a broken one.
        .timeout(std::time::Duration::from_secs(600))
        .user_agent("Spacron")
        .build()
        .map_err(|error| format!("could not start the download: {error}"))?;
    let response = client
        .get(archive.url)
        .send()
        .await
        .map_err(|error| format!("could not download the Antigravity runtime: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Google answered {} for the Antigravity runtime",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read the Antigravity runtime: {error}"))?;
    if !sha256_hex(&bytes).eq_ignore_ascii_case(archive.sha256) {
        return Err(
            "the downloaded Antigravity runtime does not match the registry checksum; nothing was installed"
                .into(),
        );
    }
    extract_archive(&bytes, &runtime_root())?;
    let status = status();
    if !status.installed {
        return Err("the Antigravity runtime was unpacked but its server is missing".into());
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_relative_paths_are_extracted() {
        assert_eq!(safe_relative("./agy_acp_server.par"), Some(PathBuf::from("agy_acp_server.par")));
        assert_eq!(safe_relative("bin/helper"), Some(PathBuf::from("bin/helper")));
        assert_eq!(safe_relative("../escape"), None);
        assert_eq!(safe_relative("/etc/passwd"), None);
        assert_eq!(safe_relative("C:/windows/system32"), None);
        assert_eq!(safe_relative(""), None);
    }

    #[test]
    fn every_archive_has_a_platform_and_a_hash() {
        for archive in ARCHIVES {
            assert_eq!(archive.sha256.len(), 64, "{} has a full sha256", archive.key);
            assert!(archive.url.starts_with("https://"), "{} is https", archive.key);
            assert!(!archive.key.is_empty());
        }
        assert_eq!(ARCHIVES.len(), 6);
    }

    #[test]
    fn an_uninstalled_runtime_reports_no_path() {
        let status = status();
        if !status.installed {
            assert!(status.path.is_none());
        }
        assert_eq!(status.version, RUNTIME_VERSION);
    }
}
