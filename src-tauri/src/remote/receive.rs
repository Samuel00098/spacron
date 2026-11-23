//! Receiving a project from the desktop.
//!
//! The desktop packs the project's git history into a bundle (`git bundle
//! create --all`), uploads it in chunks (`remote_upload_chunk`), then asks for a
//! clone (`remote_clone_repo`). A bundle carries every commit, unpushed ones
//! included, and needs no access to the project's git host from the box. After
//! the clone the bundle is deleted and `origin` is pointed back at the
//! project's real remote, so pushes from the box go where they always went.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

/// Largest project history accepted, so a mistaken upload cannot fill the disk.
const MAX_UPLOAD: u64 = 2 * 1024 * 1024 * 1024;

fn uploads(workspace: &Path) -> PathBuf {
    workspace.join(".spacron").join("uploads")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

/// Folder names a project may be cloned into: one plain path segment.
pub(super) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

/// `remote_upload_chunk`: write one base64 chunk at `offset` of upload `uploadId`.
pub(super) fn upload_chunk(args: &Value, workspace: &Path) -> Result<Value, String> {
    use std::io::{Seek, SeekFrom, Write};
    let id = args.get("uploadId").and_then(|v| v.as_str()).filter(|id| valid_id(id)).ok_or("Invalid upload id.")?;
    let offset = args.get("offset").and_then(|v| v.as_u64()).ok_or("Missing offset.")?;
    let data = STANDARD
        .decode(args.get("data").and_then(|v| v.as_str()).unwrap_or_default())
        .map_err(|_| "Upload chunk is not valid base64.")?;
    if offset + data.len() as u64 > MAX_UPLOAD {
        return Err("This project's history is larger than 2 GB, too big to send.".into());
    }
    let dir = uploads(workspace);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(dir.join(format!("{id}.bundle")))
        .map_err(|e| format!("Could not store the upload: {e}"))?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| format!("Could not store the upload: {e}"))?;
    Ok(json!({ "received": offset + data.len() as u64 }))
}

fn git(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("Could not run git on the box (is it installed?): {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `remote_clone_repo`: clone an uploaded bundle into `<workspace>/<name>`.
/// Blocking (a clone takes a while), so the server runs it off its socket loop.
pub(super) fn clone_upload(args: &Value, workspace: &Path) -> Result<Value, String> {
    let id = args.get("uploadId").and_then(|v| v.as_str()).filter(|id| valid_id(id)).ok_or("Invalid upload id.")?;
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or_default();
    if !valid_name(name) {
        return Err("Use a folder name made of letters, numbers, dots, dashes or underscores.".into());
    }
    let dest = workspace.join(name);
    if dest.exists() {
        return Err(format!("A folder named '{name}' already exists on the box. Pick another name."));
    }
    let bundle = uploads(workspace).join(format!("{id}.bundle"));
    if !bundle.is_file() {
        return Err("The upload is missing; send the project again.".into());
    }
    let bundle_str = bundle.to_string_lossy().to_string();
    // No separate `git bundle verify`: it needs a repository, and the box folder
    // may not be one. `git clone` rejects a damaged bundle itself.
    let result = (|| {
        let dest_str = dest.to_string_lossy().to_string();
        git(&["clone", &bundle_str, &dest_str], Some(workspace))?;
        // The clone's origin is the bundle file, which is about to be deleted.
        let _ = git(&["remote", "remove", "origin"], Some(&dest));
        if let Some(url) = args.get("originUrl").and_then(|v| v.as_str()).filter(|u| !u.trim().is_empty()) {
            git(&["remote", "add", "origin", url], Some(&dest))?;
        }
        if let Some(branch) = args.get("branch").and_then(|v| v.as_str()).filter(|b| !b.is_empty() && *b != "HEAD") {
            let _ = git(&["checkout", branch], Some(&dest));
        }
        Ok::<_, String>(())
    })();
    let _ = std::fs::remove_file(&bundle);
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!("Could not clone the project on the box: {e}"));
    }
    Ok(json!({ "path": dest.to_string_lossy(), "name": name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        assert!(git(args, Some(dir)).is_ok(), "git {args:?} failed");
    }

    #[test]
    fn names_are_single_safe_segments() {
        assert!(valid_name("my-app_2.0"));
        for bad in ["", ".", "..", ".git", "a/b", "a\\b", "x y"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_bundle_uploaded_in_chunks_clones_with_its_real_origin() {
        let src = tempfile::tempdir().unwrap();
        run(src.path(), &["init", "-q", "-b", "main"]);
        run(src.path(), &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"]);
        run(src.path(), &["checkout", "-q", "-b", "feature"]);
        run(src.path(), &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "unpushed"]);
        let bundle = src.path().join("p.bundle");
        run(src.path(), &["bundle", "create", "-q", &bundle.to_string_lossy(), "--all"]);
        let bytes = std::fs::read(&bundle).unwrap();

        let box_dir = tempfile::tempdir().unwrap();
        let ws = box_dir.path();
        let half = bytes.len() / 2;
        for (offset, chunk) in [(0usize, &bytes[..half]), (half, &bytes[half..])] {
            upload_chunk(&json!({ "uploadId": "u-1", "offset": offset, "data": STANDARD.encode(chunk) }), ws).unwrap();
        }
        let out = clone_upload(&json!({ "uploadId": "u-1", "name": "proj", "originUrl": "https://example.com/r.git", "branch": "feature" }), ws).unwrap();
        let dest = PathBuf::from(out["path"].as_str().unwrap());
        assert_eq!(git(&["remote", "get-url", "origin"], Some(&dest)).unwrap(), "https://example.com/r.git");
        assert_eq!(git(&["log", "-1", "--format=%s"], Some(&dest)).unwrap(), "unpushed");
        assert!(!uploads(ws).join("u-1.bundle").exists(), "the bundle is deleted after cloning");
        // A second send to the same name is refused rather than overwritten.
        upload_chunk(&json!({ "uploadId": "u-2", "offset": 0, "data": STANDARD.encode(&bytes) }), ws).unwrap();
        assert!(clone_upload(&json!({ "uploadId": "u-2", "name": "proj" }), ws).is_err());
    }
}
