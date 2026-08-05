//! Clone a remote git repository into a chosen folder and open it as a project.
//!
//! This is the "bring an existing repo onto this machine" counterpart to
//! `workspace_create_project` (start fresh) and `workspace_open_project` (open a
//! folder that's already here). It shells out to `git clone` rather than linking a
//! git library so it inherits the user's own git config, credential helpers, and
//! SSH keys — the same reasoning as the rest of the git commands in
//! `commands::workspace`.
//!
//! Clones are slow enough that a blocking spinner reads as a hang, so this streams
//! git's own progress lines to the frontend as `clone-progress` events keyed by a
//! caller-supplied id.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::{AppHandle, Emitter, State};

use crate::commands::workspace::{check_git_available, git_base, sanitize_git_error};
use crate::state::AppState;
use crate::workspace::project::Project;

/// A parsed line of `git clone --progress` output, forwarded to the modal.
#[derive(Clone, serde::Serialize)]
pub struct CloneProgress {
    /// Echoes the caller's id so a modal only reacts to its own clone.
    pub id: String,
    /// Human-readable phase, e.g. "Receiving objects".
    pub phase: String,
    /// 0–100 when git reported one; absent for phases without a percentage.
    pub percent: Option<u8>,
}

/// Scheme/shape allowlist for clone URLs.
///
/// Only these forms reach `git clone`. This deliberately excludes `ext::` and
/// `file://`: `ext::` URLs make git execute an arbitrary command, and there is no
/// use case here for cloning through it. Local-path clones are excluded for the
/// same "one obvious shape" reason — a local repo can just be opened as a folder.
fn validate_clone_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("Enter a repository URL.".to_string());
    }
    if url.len() > 2048 {
        return Err("That URL is too long.".to_string());
    }
    if url.contains('\0') || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("That URL contains invalid characters.".to_string());
    }
    // A leading dash would be read as a flag. `--` in the argv guards this too;
    // rejecting it up front gives a clearer message.
    if url.starts_with('-') {
        return Err("That doesn't look like a repository URL.".to_string());
    }

    let lower = url.to_lowercase();
    let scp_like = !lower.contains("://") && url.contains(':') && url.contains('@');
    if lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("ssh://")
        || lower.starts_with("git://")
        || scp_like
    {
        Ok(())
    } else {
        Err("Use an https:// or ssh repository URL (for example https://github.com/owner/repo.git).".to_string())
    }
}

/// The folder name a bare `git clone <url>` would produce: the last path segment
/// with any `.git` suffix and trailing slashes removed.
pub(crate) fn folder_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    // Strip a query/fragment some hosts include when you copy from the address bar.
    let trimmed = trimmed
        .split(['?', '#'])
        .next()
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    Some(name.to_string())
}

/// Same single-folder rules as `workspace_create_project`, so a cloned project can
/// never land outside the folder the user picked.
fn validate_folder_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Folder name cannot be empty.".to_string());
    }
    if name.chars().count() > 255 {
        return Err("Folder name is too long.".to_string());
    }
    if name.contains('\0')
        || name.contains('/')
        || name.contains('\\')
        || name.starts_with('-')
        || name == "."
        || name == ".."
        || name.contains("..")
        || name.chars().any(|c| c.is_control())
        || name.contains(|c: char| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("Folder name contains invalid characters.".to_string());
    }
    Ok(())
}

/// True for `https://github.com/...` URLs, the only case where the saved personal
/// access token is worth injecting.
fn is_github_https(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.starts_with("https://github.com/") || lower.starts_with("https://www.github.com/")
}

/// Parse one line of git progress output into a phase and percentage.
///
/// git writes progress as `Receiving objects:  45% (100/222), 1.2 MiB | 500 KiB/s`,
/// redrawing the same line with `\r`. Phases without a percentage ("Cloning into
/// 'repo'...") still produce an event so the modal can show what git is doing.
fn parse_progress(line: &str) -> Option<(String, Option<u8>)> {
    let line = line.trim().trim_start_matches("remote: ").trim();
    if line.is_empty() {
        return None;
    }

    if let Some((phase, rest)) = line.split_once(':') {
        let phase = phase.trim();
        if phase.is_empty() || phase.len() > 60 {
            return None;
        }
        let percent = rest
            .split('%')
            .next()
            .and_then(|p| p.trim().parse::<u32>().ok())
            .filter(|_| rest.contains('%'))
            .map(|p| p.min(100) as u8);
        return Some((phase.to_string(), percent));
    }

    if line.starts_with("Cloning into") {
        // Carries the destination path; the phase alone is all the modal needs.
        return Some(("Cloning".to_string(), None));
    }
    None
}

/// Clone `url` into a new folder under `parent` and register it as a project.
///
/// Runs on Tauri's blocking pool (`command(async)` on a sync fn) because it reads
/// git's stderr to completion. Emits `clone-progress` events tagged with
/// `progress_id` while it runs.
#[tauri::command(async)]
pub fn workspace_clone_repo(
    app: AppHandle,
    url: String,
    parent: String,
    name: Option<String>,
    progress_id: String,
    state: State<AppState>,
) -> Result<Project, String> {
    let url = url.trim().to_string();
    validate_clone_url(&url)?;
    check_git_available()?;

    let folder = match name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => folder_name_from_url(&url)
            .ok_or_else(|| "Couldn't work out a folder name from that URL.".to_string())?,
    };
    validate_folder_name(&folder)?;

    let parent_path = std::fs::canonicalize(PathBuf::from(&parent))
        .map(crate::commands::clean_path_buf)
        .map_err(|_| "The selected location does not exist.".to_string())?;
    if !parent_path.is_dir() {
        return Err("The selected location is not a folder.".to_string());
    }

    let target = crate::commands::clean_path_buf(parent_path.join(&folder));
    if target.exists() {
        return Err(format!("A folder named \"{folder}\" already exists here."));
    }

    run_clone(&url, &target, |phase, percent| {
        let _ = app.emit(
            "clone-progress",
            CloneProgress {
                id: progress_id.clone(),
                phase,
                percent,
            },
        );
    })?;

    // Canonicalize so the derived project id matches what re-opening the same
    // folder later would produce, keeping it stable across sessions.
    let root_path = std::fs::canonicalize(&target)
        .map(crate::commands::clean_path_buf)
        .unwrap_or(target);

    state
        .workspace_manager
        .open_project(root_path)
        .map_err(|e| e.to_string())
}

/// Spawn `git clone`, reporting each progress phase through `on_progress`, and
/// clean up a partial checkout if it fails. `target` is guaranteed not to exist
/// when this is called, so removing it on failure can only ever delete what git
/// just wrote.
fn run_clone(
    url: &str,
    target: &Path,
    mut on_progress: impl FnMut(String, Option<u8>),
) -> Result<(), String> {
    let mut cmd = git_base();
    cmd.args(["clone", "--progress", "--"])
        .arg(url)
        .arg(target)
        // Never let git block on an interactive credential prompt: with no TTY it
        // would hang forever behind the modal's spinner.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Authenticate GitHub HTTPS clones with the saved token when there is one, so
    // private repos work without a configured credential helper. Passed through
    // per-invocation config env vars rather than the URL, so the token never lands
    // in `.git/config`, a process listing, or the emitted progress lines.
    if is_github_https(url) {
        if let Some(header) = crate::commands::github::github_auth_header() {
            cmd.env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
                .env("GIT_CONFIG_VALUE_0", header);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    let mut stderr_tail = String::new();
    if let Some(stderr) = child.stderr.take() {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        // git redraws progress with '\r', so split on it as well as '\n' — reading
        // whole lines only would stall until each phase finished.
        loop {
            buf.clear();
            let read = read_progress_chunk(&mut reader, &mut buf)?;
            if read == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buf);
            if stderr_tail.len() < 8192 {
                stderr_tail.push_str(&chunk);
                stderr_tail.push('\n');
            }
            if let Some((phase, percent)) = parse_progress(&chunk) {
                on_progress(phase, percent);
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if status.success() {
        return Ok(());
    }

    // A failed clone can leave a partial directory behind; without this the user
    // gets "a folder named X already exists here" when they retry.
    if target.exists() {
        let _ = std::fs::remove_dir_all(target);
    }
    Err(classify_clone_error(&stderr_tail))
}

/// Read up to the next '\r' or '\n' delimiter. Returns the number of bytes
/// consumed (0 at EOF); `buf` holds the chunk without its delimiter.
fn read_progress_chunk<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> Result<usize, String> {
    let mut consumed = 0usize;
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => return Ok(consumed),
            Ok(_) => {
                consumed += 1;
                if byte[0] == b'\r' || byte[0] == b'\n' {
                    return Ok(consumed);
                }
                // Guard against a pathological remote sending one endless line.
                if buf.len() < 4096 {
                    buf.push(byte[0]);
                }
            }
            Err(e) => return Err(format!("Failed to read git output: {e}")),
        }
    }
}

/// Turn failed-clone stderr into something actionable. The generic fallback runs
/// the raw text through `sanitize_git_error` so local paths aren't leaked.
fn classify_clone_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();

    if lower.contains("repository not found")
        || lower.contains("not found")
        || lower.contains("does not appear to be a git repository")
    {
        return "Repository not found — check the URL. If it's private, save a GitHub token in Settings first.".to_string();
    }
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("permission denied")
        || lower.contains("invalid username or password")
        || lower.contains("403")
    {
        return "Authentication failed — this repo needs credentials. Save a GitHub personal access token in Settings, or set up an SSH key / credential helper.".to_string();
    }
    if lower.contains("could not resolve host")
        || lower.contains("failed to connect")
        || lower.contains("connection timed out")
        || lower.contains("network is unreachable")
    {
        return "Couldn't reach the server — check your internet connection and try again."
            .to_string();
    }
    if lower.contains("no space left") {
        return "Ran out of disk space while cloning.".to_string();
    }

    let detail = sanitize_git_error(stderr.trim());
    if detail.is_empty() {
        "git clone failed.".to_string()
    } else {
        format!("git clone failed:\n{detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_folder_name_from_common_url_shapes() {
        assert_eq!(
            folder_name_from_url("https://github.com/owner/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            folder_name_from_url("https://github.com/owner/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(
            folder_name_from_url("https://github.com/owner/repo/").as_deref(),
            Some("repo")
        );
        assert_eq!(
            folder_name_from_url("git@github.com:owner/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            folder_name_from_url("ssh://git@example.com:22/owner/repo.git").as_deref(),
            Some("repo")
        );
    }

    #[test]
    fn rejects_urls_that_are_not_remote_repos() {
        assert!(validate_clone_url("ext::sh -c 'echo pwned'").is_err());
        assert!(validate_clone_url("file:///etc").is_err());
        assert!(validate_clone_url("--upload-pack=touch /tmp/x").is_err());
        assert!(validate_clone_url("/home/user/repo").is_err());
        assert!(validate_clone_url("https://github.com/o/r\nrm -rf").is_err());
    }

    #[test]
    fn accepts_https_and_ssh_urls() {
        assert!(validate_clone_url("https://github.com/owner/repo.git").is_ok());
        assert!(validate_clone_url("git@github.com:owner/repo.git").is_ok());
        assert!(validate_clone_url("ssh://git@gitlab.com/owner/repo.git").is_ok());
    }

    #[test]
    fn parses_git_progress_lines() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (100/222), 1.2 MiB | 500 KiB/s"),
            Some(("Receiving objects".to_string(), Some(45)))
        );
        assert_eq!(
            parse_progress("remote: Counting objects: 100% (8/8), done."),
            Some(("Counting objects".to_string(), Some(100)))
        );
        assert_eq!(
            parse_progress("Cloning into 'repo'..."),
            Some(("Cloning".to_string(), None))
        );
        assert_eq!(parse_progress("   "), None);
    }

    /// Build a throwaway repo with one commit and return its path.
    fn make_source_repo(dir: &Path) -> PathBuf {
        let repo = dir.join("source");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = git_base()
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?} failed");
        };
        run(&["init", "-q"]);
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "initial"]);
        repo
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "spacron-clone-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn clones_a_real_repo_and_reports_progress() {
        if check_git_available().is_err() {
            return; // no git on this machine; nothing to verify
        }
        let dir = temp_dir("ok");
        let source = make_source_repo(&dir);
        let target = dir.join("cloned");

        let mut phases: Vec<String> = Vec::new();
        run_clone(source.to_str().unwrap(), &target, |phase, _| {
            phases.push(phase)
        })
        .expect("clone should succeed");

        assert!(target.join(".git").is_dir(), "no .git in the clone");
        assert!(target.join("README.md").is_file(), "working tree not checked out");
        assert!(!phases.is_empty(), "no progress was reported");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_clone_leaves_no_partial_folder_behind() {
        if check_git_available().is_err() {
            return;
        }
        let dir = temp_dir("fail");
        let missing = dir.join("does-not-exist");
        let target = dir.join("cloned");

        let err = run_clone(missing.to_str().unwrap(), &target, |_, _| {})
            .expect_err("cloning a missing repo should fail");

        assert!(!target.exists(), "partial clone was left behind: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_names_from_urls_stay_inside_the_parent() {
        // A crafted URL must not produce a name that escapes the chosen folder.
        for url in ["https://h/o/..", "https://h/o/../..", "https://h/o/."] {
            let name = folder_name_from_url(url);
            if let Some(name) = name {
                assert!(validate_folder_name(&name).is_err(), "accepted {name}");
            }
        }
    }
}
