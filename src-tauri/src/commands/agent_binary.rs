//! Managed agent binary installation via the ACP registry.
//!
//! Agents published to the ACP registry with a `binary` distribution can be
//! installed and managed by Spacron: download the platform archive, verify its
//! sha256 against the registry, extract into `<config>/agents/<id>/<version>/`,
//! and hand Chat the executable path. npx/uvx distributions need no installation
//! — they resolve at launch — so only binary entries are manageable here.
//!
//! Follows the same safety contract as antigravity.rs: never unpack an archive
//! whose hash doesn't match, refuse path-escaping entries, cap file counts and
//! extracted bytes. The frontend supplies the distribution url/sha256/cmd from
//! the TypeScript ACP registry.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Status of a managed agent binary.
#[derive(Serialize, Clone)]
pub struct AgentBinaryStatus {
    /// The agent's registry id (e.g. "cursor-agent").
    pub id: String,
    /// True when a verified copy is installed and launchable.
    pub installed: bool,
    /// True when the copy is Spacron's managed one (removable by reinstall).
    pub managed: bool,
    /// Version currently installed.
    pub version: String,
    /// Path to the executable, when installed.
    pub path: Option<String>,
    /// True when the registry publishes a binary for this OS/arch.
    pub supported: bool,
}

/// The registry's platform key for this build.
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

/// `<config>/agents/` — Spacron's managed agent binaries.
fn agents_root() -> PathBuf {
    crate::mcp::config_dir().join("agents")
}

fn agent_dir(agent_id: &str, version: &str) -> PathBuf {
    agents_root().join(agent_id).join(version)
}

fn executable_in(root: &Path, cmd: &str) -> PathBuf {
    root.join(cmd.trim_start_matches("./").replace('\\', "/"))
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
/// oversized archives.
fn extract_archive(bytes: &[u8], dest: &Path) -> Result<(), String> {
    const MAX_FILES: usize = 2_000;
    const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("the agent archive is not a zip file: {error}"))?;
    let tmp = dest.with_extension("installing");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|error| error.to_string())?;
    let (mut files, mut total) = (0usize, 0u64);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(rel) = safe_relative(&entry.name().replace('\\', "/")) else {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("the agent archive contains an unsafe path".into());
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
            return Err("the agent archive is larger than expected".into());
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
        return Err("the agent archive was empty".into());
    }
    let _ = std::fs::remove_dir_all(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|error| error.to_string())?;
    make_tree_executable(dest);
    Ok(())
}

/// Status of one agent's managed binary install.
#[tauri::command]
pub fn agent_binary_status(agent_id: String, version: String) -> AgentBinaryStatus {
    let supported = platform_key() != "";
    let dest = agent_dir(&agent_id, &version);
    let exe_path = dest.join("agent"); // default; caller knows the real cmd
    let installed = exe_path.is_file();
    AgentBinaryStatus {
        id: agent_id,
        installed,
        managed: installed,
        version,
        path: installed.then(|| exe_path.to_string_lossy().to_string()),
        supported,
    }
}

/// Download, verify and install one agent's binary distribution.
#[tauri::command(async)]
pub async fn agent_binary_install(
    agent_id: String,
    version: String,
    url: String,
    sha256: String,
    cmd: String,
) -> Result<AgentBinaryStatus, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(600))
        .user_agent("Spacron")
        .build()
        .map_err(|error| format!("could not start the download: {error}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("could not download {agent_id}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("registry answered {} for {agent_id}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read {agent_id}: {error}"))?;
    if !sha256_hex(&bytes).eq_ignore_ascii_case(&sha256) {
        return Err(
            format!("the downloaded {agent_id} does not match the registry checksum; nothing was installed"),
        );
    }
    let dest = agent_dir(&agent_id, &version);
    extract_archive(&bytes, &dest)?;
    let path = executable_in(&dest, &cmd);
    if !path.is_file() {
        return Err(format!("the {agent_id} archive was unpacked but its executable is missing"));
    }
    Ok(AgentBinaryStatus {
        id: agent_id,
        installed: true,
        managed: true,
        version,
        path: Some(path.to_string_lossy().to_string()),
        supported: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_relative_paths_are_extracted() {
        assert_eq!(safe_relative("./agent"), Some(PathBuf::from("agent")));
        assert_eq!(safe_relative("bin/helper"), Some(PathBuf::from("bin/helper")));
        assert_eq!(safe_relative("../escape"), None);
        assert_eq!(safe_relative("/etc/passwd"), None);
        assert_eq!(safe_relative("C:/windows/system32"), None);
        assert_eq!(safe_relative(""), None);
    }
}
