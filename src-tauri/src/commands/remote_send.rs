//! Sending a local project to a remote box: the desktop half.
//!
//! [`project_send_prepare`] packs the project's whole git history into a bundle
//! in the temp folder; the frontend reads it with [`project_send_read_chunk`]
//! and uploads each chunk over the remote socket (`remote_upload_chunk`), then
//! asks the box to clone it (`remote/receive.rs`). Uncommitted work cannot
//! travel in a bundle, so the result reports it for the user to see first.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendBundle {
    pub bundle_path: String,
    pub size: u64,
    pub origin_url: Option<String>,
    pub branch: Option<String>,
    /// Files changed but not committed; they stay behind on this computer.
    pub uncommitted: usize,
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("Could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn bundle_dir() -> PathBuf {
    std::env::temp_dir().join("spacron-send")
}

/// Only bundles this module wrote may be read or deleted.
fn own_bundle(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ok = p.parent() == Some(bundle_dir().as_path()) && p.extension().is_some_and(|e| e == "bundle");
    if ok { Ok(p) } else { Err("Not a Spacron send bundle.".into()) }
}

#[tauri::command]
pub fn project_send_prepare(root: String) -> Result<SendBundle, String> {
    let root = PathBuf::from(root);
    if git(&root, &["rev-parse", "--git-dir"]).is_err() {
        return Err("Only git projects can be sent. Run `git init` and make a commit first.".into());
    }
    if git(&root, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Err("This project has no commits yet. Commit your work first, then send it.".into());
    }
    let origin_url = git(&root, &["remote", "get-url", "origin"]).ok().filter(|u| !u.is_empty());
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| !b.is_empty() && b != "HEAD");
    let uncommitted = git(&root, &["status", "--porcelain"]).map(|s| s.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0);
    std::fs::create_dir_all(bundle_dir()).map_err(|e| e.to_string())?;
    let bundle = bundle_dir().join(format!("{}.bundle", uuid::Uuid::new_v4().simple()));
    let bundle_str = bundle.to_string_lossy().to_string();
    git(&root, &["bundle", "create", "-q", &bundle_str, "--all"]).map_err(|e| format!("Could not pack the project: {e}"))?;
    let size = std::fs::metadata(&bundle).map_err(|e| e.to_string())?.len();
    Ok(SendBundle { bundle_path: bundle_str, size, origin_url, branch, uncommitted })
}

#[tauri::command]
pub fn project_send_read_chunk(path: String, offset: u64, length: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = own_bundle(&path)?;
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; length.min(8 * 1024 * 1024) as usize];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(STANDARD.encode(buf))
}

#[tauri::command]
pub fn project_send_cleanup(path: String) -> Result<(), String> {
    let path = own_bundle(&path)?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_folders_that_are_not_git_projects_and_foreign_paths() {
        let dir = tempfile::tempdir().unwrap();
        assert!(project_send_prepare(dir.path().to_string_lossy().to_string()).unwrap_err().contains("git"));
        assert!(project_send_read_chunk(dir.path().join("x.bundle").to_string_lossy().to_string(), 0, 10).is_err());
    }

    #[test]
    fn packs_history_reports_uncommitted_files_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]).unwrap();
        git(root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c"]).unwrap();
        std::fs::write(root.join("draft.txt"), "x").unwrap();
        let out = project_send_prepare(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(out.uncommitted, 1);
        assert_eq!(out.branch.as_deref(), Some("main"));
        let first = STANDARD.decode(project_send_read_chunk(out.bundle_path.clone(), 0, 64).unwrap()).unwrap();
        assert!(first.starts_with(b"# v"), "a git bundle header");
        project_send_cleanup(out.bundle_path.clone()).unwrap();
        assert!(!Path::new(&out.bundle_path).exists());
    }
}
