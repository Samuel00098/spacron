//! Project worktrees — the user's own worktrees, listed under each project.
//!
//! Modelled on Orca: a project shows its main checkout (the 🏠 row) and every
//! worktree the user created for it. A worktree is a place to work, not an
//! agent's private copy — any number of agents and terminals can run in one.
//! Agent-isolated worktrees (`.spacron/worktrees/`) are a separate mechanism
//! owned by the orchestrator and are deliberately not listed here.
//!
//! ## Where they live, and why there
//!
//! `<project>/.spacron/trees/<name>`. Two constraints decide it:
//!
//! - **Inside the project root.** Terminals, file ops and LSP are confined to the
//!   open project roots, so a worktree anywhere else could be created but never
//!   used (see the note above `worktree_area` in `workspace.rs`).
//! - **Outside `.spacron/worktrees/`.** The orchestrator's orphan sweep removes
//!   every folder there that no task or session claims. A user worktree with no
//!   agent in it would be deleted on the next sweep.
//!
//! `.spacron/*` is already in `.git/info/exclude`, so the checkouts stay out of
//! the main checkout's git status.
//!
//! The list itself always comes from `git worktree list`, so it can never drift
//! from what git knows. Only the cosmetic metadata (display name, note, parent,
//! base ref) is stored, in `.spacron/trees.json`.

use super::workspace::{
    check_git_available, ensure_spacron_excluded, git_base, is_under, lock_repo_write, sanitize_git_error,
};
use crate::state::AppState;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::State;

/// Folder under `.spacron/` that holds user worktrees.
const TREES_DIR: &str = "trees";
/// Metadata file under `.spacron/`.
const META_FILE: &str = "trees.json";
/// How many `-2`, `-3`… suffixes to try before giving up, as Orca does.
const MAX_NAME_ATTEMPTS: u32 = 100;
/// Longest folder / generated branch name we produce.
const MAX_SLUG_LEN: usize = 60;

fn trees_area(root: &Path) -> PathBuf {
    root.join(".spacron").join(TREES_DIR)
}

fn meta_path(root: &Path) -> PathBuf {
    root.join(".spacron").join(META_FILE)
}

/// One row under a project in the sidebar.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ProjectWorktree {
    pub path: String,
    /// Checked-out branch, or None when HEAD is detached.
    pub branch: Option<String>,
    pub head: String,
    /// The project's own checkout (Orca's "primary worktree").
    pub is_main: bool,
    pub name: String,
    pub note: Option<String>,
    /// Path of the worktree this one is nested under in the sidebar.
    pub parent: Option<String>,
    pub base_ref: Option<String>,
    /// Unix milliseconds.
    pub created_at: Option<u64>,
    /// The folder is gone but git still has it registered.
    pub missing: bool,
}

/// What `project_worktree_create` returns.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CreatedWorktree {
    pub worktree: ProjectWorktree,
    /// A non-fatal problem the user should hear about (for example the remote
    /// base could not be fetched, so the local branch was used instead).
    pub warning: Option<String>,
}

/// What `project_worktree_delete` returns.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeletedWorktree {
    /// Set when the branch was kept because it holds unmerged commits.
    pub preserved_branch: Option<String>,
}

/// Base-branch choices for the Create worktree dialog.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeBases {
    pub default_base: String,
    /// Remote and local refs, default first, then most recently committed.
    pub refs: Vec<String>,
    /// Local branches only — the ones that can be opened in a worktree as-is.
    pub local: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct WorktreeReviewMetadata {
    size_bytes: u64,
    size_partial: bool,
    modified_at: Option<u64>,
    branch: Option<String>,
    git_state: Option<&'static str>,
}

fn scan_review_folder(root: &Path) -> (u64, bool, Option<u64>) {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut folders = vec![root.to_path_buf()];
    let mut size = 0u64;
    let mut partial = false;
    let mut modified = None;
    'scan: while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(folder) else {
            partial = true;
            continue;
        };
        for entry in entries {
            if Instant::now() >= deadline {
                partial = true;
                break 'scan;
            }
            let Ok(entry) = entry else {
                partial = true;
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                partial = true;
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                // Do not count files in junction targets or hydrate placeholders.
                if metadata.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            if let Some(ms) = metadata.modified().ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .and_then(|age| u64::try_from(age.as_millis()).ok())
            {
                modified = Some(modified.map_or(ms, |current: u64| current.max(ms)));
            }
            if metadata.is_dir() {
                folders.push(entry.path());
            } else if metadata.is_file() {
                size = size.saturating_add(metadata.len());
            }
        }
    }
    (size, partial, modified)
}

pub(crate) fn review_metadata(root: &Path, worktree_path: Option<&str>) -> Result<WorktreeReviewMetadata, String> {
    let dir = match worktree_path {
        Some(path) => {
            let path = canon(&require_user_worktree(root, path)?.0);
            if !is_under(&path, &canon(root))
                || !path.parent().is_some_and(|parent| same_dir(parent, &canon(&trees_area(root))))
            {
                return Err("Worktree folder is outside the managed project area.".to_string());
            }
            path
        }
        None => root.to_path_buf(),
    };
    if !dir.is_dir() {
        return Err("Workspace folder is unavailable.".to_string());
    }
    let (size_bytes, size_partial, modified_at) = scan_review_folder(&dir);
    let (branch, git_state) = if dir.join(".git").exists() {
        let branch = git_out(&dir, &["symbolic-ref", "--short", "-q", "HEAD"]);
        let state = git_out(&dir, &["--no-optional-locks", "status", "--porcelain", "--ignored=matching"]).map(|status| {
            let changes = status.lines().any(|line| !line.starts_with("!!"));
            let ignored = status.lines().any(|line| line.starts_with("!!"));
            match (changes, ignored) {
                (true, true) => "Local changes and ignored files",
                (true, false) => "Local changes",
                (false, true) => "Ignored files",
                (false, false) => "Clean",
            }
        });
        (branch, state)
    } else {
        (None, None)
    };
    Ok(WorktreeReviewMetadata { size_bytes, size_partial, modified_at, branch, git_state })
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct TreeMeta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    base_ref: Option<String>,
    #[serde(default)]
    created_at: Option<u64>,
}

/// Keyed by the worktree's folder name under `.spacron/trees/`.
type MetaMap = BTreeMap<String, TreeMeta>;

fn read_meta(root: &Path) -> MetaMap {
    std::fs::read_to_string(meta_path(root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_meta(root: &Path, meta: &MetaMap) -> Result<(), String> {
    let path = meta_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not save worktree details: {e}"))?;
    }
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Could not save worktree details: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save worktree details: {e}"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn git(root: &Path) -> std::process::Command {
    let mut cmd = git_base();
    // Windows checkouts of deep trees exceed MAX_PATH without this.
    #[cfg(windows)]
    cmd.args(["-c", "core.longpaths=true"]);
    cmd.current_dir(root).env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

fn git_out(root: &Path, args: &[&str]) -> Option<String> {
    let out = git(root).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git_ok(root: &Path, args: &[&str]) -> bool {
    git(root).args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

fn git_run(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(root)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Turn a free-form name into a folder / branch segment: letters, digits, `.`,
/// `_` and `-`; everything else becomes `-`. Slashes are kept for branches only.
fn slugify(raw: &str, keep_slashes: bool) -> String {
    let mut out = String::new();
    for c in raw.trim().chars() {
        let ok = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || (keep_slashes && c == '/');
        let next = if ok { c } else { '-' };
        if next == '-' && out.ends_with('-') {
            continue;
        }
        out.push(next);
    }
    let mut s: String = out
        .split('/')
        .map(|part| part.trim_matches(|c| matches!(c, '-' | '.' | '_')))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    // `.lock` is reserved by git at the end of any ref component.
    while s.ends_with(".lock") {
        s.truncate(s.len() - 5);
    }
    if s.len() > MAX_SLUG_LEN {
        s.truncate(MAX_SLUG_LEN);
        s = s.trim_end_matches(|c| matches!(c, '-' | '.' | '_' | '/')).to_string();
    }
    s
}

/// `name`, then `name-2`, `name-3`…
fn suffixed(base: &str, attempt: u32) -> String {
    if attempt == 1 {
        base.to_string()
    } else {
        format!("{base}-{attempt}")
    }
}

fn branch_exists(root: &Path, branch: &str) -> bool {
    git_ok(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])
}

fn valid_branch(root: &Path, branch: &str) -> bool {
    !branch.starts_with('-') && git_ok(root, &["check-ref-format", "--branch", branch])
}

fn remotes(root: &Path) -> Vec<String> {
    git_out(root, &["remote"])
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// The ref new worktrees start from by default: the remote's default branch
/// (`origin/master`), else the branch checked out in the main checkout.
fn default_base(root: &Path) -> String {
    let remotes = remotes(root);
    let remote = if remotes.iter().any(|r| r == "origin") {
        Some("origin".to_string())
    } else {
        remotes.first().cloned()
    };
    if let Some(remote) = remote {
        if let Some(head) = git_out(root, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")]) {
            if !head.is_empty() {
                return head;
            }
        }
        for name in ["main", "master"] {
            let r = format!("{remote}/{name}");
            if git_ok(root, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/{r}")]) {
                return r;
            }
        }
    }
    match git_out(root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(b) if !b.is_empty() && b != "HEAD" => b,
        _ => "HEAD".to_string(),
    }
}

pub(crate) fn worktree_merged_into_default(root: &Path, worktree: &Path, original_head: Option<&str>) -> bool {
    // Resolve the actual checkout tip. A supplied branch label may be stale
    // or unrelated to the worktree being removed.
    let Some(head) = git_out(worktree, &["rev-parse", "--verify", "HEAD^{commit}"]) else {
        return false;
    };
    original_head.is_some_and(|original| !original.is_empty() && original != head)
        && git_ok(root, &["merge-base", "--is-ancestor", &head, &default_base(root)])
}

/// When `base` names a remote-tracking branch (`origin/x`), its remote and branch.
fn split_remote_ref(root: &Path, base: &str) -> Option<(String, String)> {
    let base = base.strip_prefix("refs/remotes/").unwrap_or(base);
    let (remote, branch) = base.split_once('/')?;
    remotes(root).iter().any(|r| r == remote).then(|| (remote.to_string(), branch.to_string()))
}

/// Fetch a remote base before branching from it, as Orca does. Falls back to the
/// local branch of the same name when the fetch fails and the remote ref is
/// missing, and says so.
fn refresh_base(root: &Path, base: &str) -> Result<(String, Option<String>), String> {
    let Some((remote, branch)) = split_remote_ref(root, base) else {
        return Ok((base.to_string(), None));
    };
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let fetched = git_ok(root, &["fetch", "--no-tags", "--quiet", &remote, &branch]);
    let have_remote = git_ok(root, &["show-ref", "--verify", "--quiet", &remote_ref]);
    if fetched {
        return Ok((base.to_string(), None));
    }
    if have_remote {
        return Ok((
            base.to_string(),
            Some(format!("Could not fetch {remote}/{branch}, so this worktree may not include the latest remote changes.")),
        ));
    }
    if branch_exists(root, &branch) {
        return Ok((
            branch.clone(),
            Some(format!("{remote}/{branch} was unavailable, so the local \"{branch}\" was used instead.")),
        ));
    }
    Err(format!("Base \"{base}\" was not found. Check your network and try again."))
}

/// Parsed `git worktree list --porcelain`.
#[derive(Debug, Default, Clone, PartialEq)]
struct PorcelainEntry {
    path: String,
    head: String,
    branch: Option<String>,
    prunable: bool,
}

fn parse_porcelain(text: &str) -> Vec<PorcelainEntry> {
    let mut entries = Vec::new();
    let mut current: Option<PorcelainEntry> = None;
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            current = Some(PorcelainEntry { path: path.to_string(), ..Default::default() });
        } else if let Some(entry) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                entry.head = head.to_string();
            } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                entry.branch = Some(branch.to_string());
            } else if line.starts_with("prunable") {
                entry.prunable = true;
            }
        }
    }
    if let Some(entry) = current {
        entries.push(entry);
    }
    entries
}

fn native_path(p: &str) -> PathBuf {
    #[cfg(windows)]
    let p = p.replace('/', "\\");
    crate::commands::clean_path_buf(PathBuf::from(p))
}

/// The real, long-form path when it exists (resolves 8.3 short names and
/// symlinks), else the path as given.
fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p)
        .map(crate::commands::clean_path_buf)
        .unwrap_or_else(|_| p.to_path_buf())
}

fn same_path(a: &Path, b: &Path) -> bool {
    (is_under(a, b) && is_under(b, a)) || {
        let (a, b) = (canon(a), canon(b));
        is_under(&a, &b) && is_under(&b, &a)
    }
}

/// The folder name of `path` when it sits directly inside `area`. Compared both
/// as given and canonicalised, because git reports long paths while a project
/// root can reach us in 8.3 short form.
fn folder_name(area: &Path, path: &Path) -> Option<String> {
    let direct_child = |area: &Path, path: &Path| {
        is_under(path, area) && path.parent().is_some_and(|parent| same_dir(parent, area))
    };
    let inside = direct_child(area, path) || direct_child(&canon(area), &canon(path));
    if !inside {
        return None;
    }
    path.file_name().map(|n| n.to_string_lossy().to_string())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    is_under(a, b) && is_under(b, a)
}

/// Every worktree that belongs in the sidebar for `root`: the main checkout
/// first, then the user's worktrees, oldest first.
pub(crate) fn list_worktrees(root: &Path) -> Result<Vec<ProjectWorktree>, String> {
    let porcelain = git_run(root, &["worktree", "list", "--porcelain"]).map_err(|e| sanitize_git_error(&e))?;
    let entries = parse_porcelain(&porcelain);
    let area = trees_area(root);
    let meta = read_meta(root);
    let mut out = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let path = native_path(&entry.path);
        if index == 0 {
            let name = root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "main".to_string());
            out.push(ProjectWorktree {
                path: root.to_string_lossy().to_string(),
                branch: entry.branch.clone(),
                head: entry.head.clone(),
                is_main: true,
                name,
                note: None,
                parent: None,
                base_ref: None,
                created_at: None,
                missing: false,
            });
            continue;
        }
        let Some(folder) = folder_name(&area, &path) else { continue };
        let m = meta.get(&folder).cloned().unwrap_or_default();
        // Built from the project root as Spacron knows it, so it matches the
        // paths terminals and the file tree are confined to.
        let path = area.join(&folder);
        out.push(ProjectWorktree {
            path: path.to_string_lossy().to_string(),
            branch: entry.branch.clone(),
            head: entry.head.clone(),
            is_main: false,
            name: m.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or(folder),
            note: m.note,
            parent: m.parent,
            base_ref: m.base_ref,
            created_at: m.created_at,
            missing: entry.prunable || !path.is_dir(),
        });
    }
    let (main, mut rest): (Vec<_>, Vec<_>) = out.into_iter().partition(|w| w.is_main);
    rest.sort_by_key(|w| w.created_at.unwrap_or(0));
    Ok(main.into_iter().chain(rest).collect())
}

/// Options for `create_worktree`, everything but the name optional.
#[derive(Debug, Default, Clone)]
pub(crate) struct CreateOptions {
    pub name: String,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    pub note: Option<String>,
    pub parent: Option<String>,
    /// Skip fetching a remote base (tests, offline).
    pub skip_fetch: bool,
}

pub(crate) fn create_worktree(root: &Path, opts: CreateOptions) -> Result<CreatedWorktree, String> {
    let display_name = opts.name.trim().to_string();
    let folder_base = slugify(&display_name, false);
    if folder_base.is_empty() {
        return Err("Give the worktree a name.".to_string());
    }
    let explicit_branch = opts
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    if let Some(branch) = &explicit_branch {
        if !valid_branch(root, branch) {
            return Err(format!("\"{branch}\" is not a valid branch name."));
        }
    }
    let branch_base = slugify(&display_name, true);

    let _repo = lock_repo_write(root);
    ensure_spacron_excluded(root);

    let checked_out: Vec<String> = parse_porcelain(&git_out(root, &["worktree", "list", "--porcelain"]).unwrap_or_default())
        .into_iter()
        .filter_map(|e| e.branch)
        .collect();

    let area = trees_area(root);
    let mut chosen: Option<(String, String, bool)> = None; // (folder, branch, reuse existing branch)
    for attempt in 1..=MAX_NAME_ATTEMPTS {
        let folder = suffixed(&folder_base, attempt);
        if area.join(&folder).exists() {
            continue;
        }
        match &explicit_branch {
            Some(branch) => {
                if branch_exists(root, branch) {
                    if checked_out.iter().any(|b| b == branch) {
                        return Err(format!("Branch \"{branch}\" is already checked out in another worktree."));
                    }
                    chosen = Some((folder, branch.clone(), true));
                } else {
                    chosen = Some((folder, branch.clone(), false));
                }
            }
            None => {
                let branch = suffixed(&branch_base, attempt);
                if branch_exists(root, &branch) || !valid_branch(root, &branch) {
                    continue;
                }
                chosen = Some((folder, branch, false));
            }
        }
        break;
    }
    let Some((folder, branch, reuse)) = chosen else {
        return Err(format!("Could not find a free worktree name for \"{display_name}\". Pick a different name."));
    };

    let requested_base = opts
        .base_ref
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_base(root));
    let (base, warning) = if reuse || opts.skip_fetch {
        (requested_base.clone(), None)
    } else {
        refresh_base(root, &requested_base)?
    };

    std::fs::create_dir_all(&area).map_err(|e| format!("Failed to create the worktree folder: {e}"))?;
    let path = crate::commands::clean_path_buf(area.join(&folder));
    let path_str = path.to_string_lossy().to_string();

    let result = if reuse {
        git_run(root, &["worktree", "add", &path_str, &branch])
    } else {
        git_run(root, &["worktree", "add", "--no-track", "-b", &branch, &path_str, &base])
    };
    if let Err(stderr) = result {
        return Err(format!("Failed to create worktree: {}", sanitize_git_error(&stderr)));
    }
    if !path.is_dir() {
        return Err("The worktree folder was not created.".to_string());
    }

    let entry = TreeMeta {
        name: Some(display_name.clone()),
        note: opts.note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
        parent: opts.parent.filter(|p| !p.trim().is_empty()),
        base_ref: Some(if reuse { branch.clone() } else { base.clone() }),
        created_at: Some(now_ms()),
    };
    let mut meta = read_meta(root);
    meta.insert(folder.clone(), entry.clone());
    // The worktree exists either way; losing the note is not worth failing over.
    let _ = write_meta(root, &meta);

    let head = git_out(&path, &["rev-parse", "HEAD"]).unwrap_or_default();
    Ok(CreatedWorktree {
        worktree: ProjectWorktree {
            path: path_str,
            branch: Some(branch),
            head,
            is_main: false,
            name: display_name,
            note: entry.note,
            parent: entry.parent,
            base_ref: entry.base_ref,
            created_at: entry.created_at,
            missing: false,
        },
        warning,
    })
}

/// Refuse anything that is not one of this project's user worktrees.
fn require_user_worktree(root: &Path, worktree_path: &str) -> Result<(PathBuf, String), String> {
    let path = crate::commands::clean_path_buf(PathBuf::from(worktree_path));
    let area = trees_area(root);
    match folder_name(&area, &path) {
        Some(folder) => Ok((path, folder)),
        _ => Err("That is not one of this project's worktrees.".to_string()),
    }
}

pub(crate) fn delete_worktree(root: &Path, worktree_path: &str, force: bool) -> Result<DeletedWorktree, String> {
    delete_worktree_with_protection(root, worktree_path, force, false)
}

pub(crate) fn delete_worktree_with_protection(
    root: &Path,
    worktree_path: &str,
    force: bool,
    protect_local_files: bool,
) -> Result<DeletedWorktree, String> {
    let (path, folder) = require_user_worktree(root, worktree_path)?;
    let _repo = lock_repo_write(root);

    let branch = parse_porcelain(&git_out(root, &["worktree", "list", "--porcelain"]).unwrap_or_default())
        .into_iter()
        .find(|e| folder_name(&trees_area(root), &native_path(&e.path)).as_deref() == Some(folder.as_str()))
        .and_then(|e| e.branch);

    if protect_local_files {
        if branch.is_none() || !path.is_dir() {
            return Err("Could not verify the workspace branch and folder.".to_string());
        }
        let status = git_run(&path, &["status", "--porcelain", "--untracked-files=all", "--ignored=matching"])
            .map_err(|_| "Could not check workspace files.".to_string())?;
        if !status.is_empty() {
            return Err("DIRTY: This workspace contains uncommitted, untracked, or ignored files.".to_string());
        }
    }

    let path_str = path.to_string_lossy().to_string();
    if path.exists() {
        let mut args = vec!["worktree", "remove"];
        if force && !protect_local_files {
            args.push("--force");
        }
        args.push(&path_str);
        if let Err(stderr) = git_run(root, &args) {
            if !force && (stderr.contains("modified or untracked") || stderr.contains("is dirty")) {
                return Err("DIRTY: This worktree has uncommitted changes.".to_string());
            }
            return Err(format!("Failed to delete worktree: {}", sanitize_git_error(&stderr)));
        }
    }
    let _ = git_run(root, &["worktree", "prune"]);

    // Delete the branch only when it is fully merged; otherwise keep it so no
    // work is lost — the same rule Orca follows.
    let mut preserved_branch = None;
    if let Some(branch) = branch {
        if git_run(root, &["branch", "-d", "--", &branch]).is_err() && branch_exists(root, &branch) {
            preserved_branch = Some(branch);
        }
    }

    let mut meta = read_meta(root);
    if meta.remove(&folder).is_some() {
        // Children of a deleted worktree move up to the top level.
        for entry in meta.values_mut() {
            if entry.parent.as_deref().is_some_and(|p| same_path(Path::new(p), &path)) {
                entry.parent = None;
            }
        }
        let _ = write_meta(root, &meta);
    }
    Ok(DeletedWorktree { preserved_branch })
}

pub(crate) fn update_worktree_meta(
    root: &Path,
    worktree_path: &str,
    name: Option<String>,
    note: Option<String>,
    parent: Option<Option<String>>,
) -> Result<(), String> {
    let (path, folder) = require_user_worktree(root, worktree_path)?;
    if !path.is_dir() {
        return Err("That worktree no longer exists.".to_string());
    }
    let mut meta = read_meta(root);
    let entry = meta.entry(folder).or_default();
    if let Some(name) = name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Give the worktree a name.".to_string());
        }
        entry.name = Some(name);
    }
    if let Some(note) = note {
        entry.note = Some(note.trim().to_string()).filter(|n| !n.is_empty());
    }
    if let Some(parent) = parent {
        if parent.as_deref().is_some_and(|p| same_path(Path::new(p), &path)) {
            return Err("A worktree cannot be its own parent.".to_string());
        }
        entry.parent = parent.filter(|p| !p.trim().is_empty());
    }
    write_meta(root, &meta)
}

fn refs_under(root: &Path, namespace: &str) -> Vec<String> {
    git_out(root, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", namespace])
        .map(|s| {
            s.lines()
                .map(str::trim)
                // `origin/HEAD` is an alias, and the orchestrator's `spacron/*`
                // agent branches would bury everything else.
                .filter(|r| !r.is_empty() && !r.ends_with("/HEAD") && !r.starts_with("spacron/") && *r != "HEAD")
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn list_bases(root: &Path) -> WorktreeBases {
    let default_base = default_base(root);
    let local = refs_under(root, "refs/heads");
    let mut refs = refs_under(root, "refs/remotes");
    refs.extend(local.iter().cloned());
    refs.retain(|r| r != &default_base);
    refs.insert(0, default_base.clone());
    WorktreeBases { default_base, refs, local }
}

fn project_root(state: &State<AppState>, project_id: &str) -> Result<PathBuf, String> {
    let root = state
        .workspace_manager
        .list_projects()
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.root_path.clone())
        .or_else(|| {
            let p = PathBuf::from(project_id);
            if p.is_dir() {
                Some(p)
            } else {
                None
            }
        })
        .ok_or_else(|| "Project not found".to_string())?;
    if !root.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    check_git_available().map_err(|e| format!("Git not available: {e}"))?;
    Ok(root)
}

#[tauri::command(async)]
pub fn project_worktree_list(project_id: String, state: State<AppState>) -> Result<Vec<ProjectWorktree>, String> {
    list_worktrees(&project_root(&state, &project_id)?)
}

#[tauri::command(async)]
pub fn project_worktree_review_metadata(
    project_id: String,
    worktree_path: Option<String>,
    state: State<AppState>,
) -> Result<WorktreeReviewMetadata, String> {
    let candidate = Path::new(&project_id);
    let root = state.workspace_manager.list_projects().into_iter()
        .find(|p| p.id == project_id || (candidate.is_absolute() && same_path(&p.root_path, candidate)))
        .map(|p| p.root_path)
        .or_else(|| {
            state.workspace_manager.get_recent_projects().into_iter()
                .find(|p| p.id == project_id || (candidate.is_absolute() && same_path(&p.root_path, candidate)))
                .map(|p| p.root_path)
        })
        .ok_or_else(|| "Workspace is not registered.".to_string())?;
    review_metadata(&root, worktree_path.as_deref())
}

#[tauri::command(async)]
pub fn project_worktree_bases(project_id: String, state: State<AppState>) -> Result<WorktreeBases, String> {
    Ok(list_bases(&project_root(&state, &project_id)?))
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn project_worktree_create(
    project_id: String,
    name: String,
    branch: Option<String>,
    base_ref: Option<String>,
    note: Option<String>,
    parent: Option<String>,
    state: State<AppState>,
) -> Result<CreatedWorktree, String> {
    let root = project_root(&state, &project_id)?;
    create_worktree(&root, CreateOptions { name, branch, base_ref, note, parent, skip_fetch: false })
}

#[tauri::command(async)]
pub fn project_worktree_delete(
    project_id: String,
    worktree_path: String,
    force: Option<bool>,
    protect_local_files: Option<bool>,
    state: State<AppState>,
) -> Result<DeletedWorktree, String> {
    let root = project_root(&state, &project_id)?;
    if protect_local_files.unwrap_or(false) {
        delete_worktree_with_protection(&root, &worktree_path, false, true)
    } else {
        delete_worktree(&root, &worktree_path, force.unwrap_or(false))
    }
}

#[tauri::command(async)]
pub fn project_worktree_update(
    project_id: String,
    worktree_path: String,
    name: Option<String>,
    note: Option<String>,
    parent: Option<String>,
    clear_parent: Option<bool>,
    state: State<AppState>,
) -> Result<(), String> {
    let root = project_root(&state, &project_id)?;
    let parent = if clear_parent.unwrap_or(false) { Some(None) } else { parent.map(Some) };
    update_worktree_meta(&root, &worktree_path, name, note, parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = git(dir).args(args).output().expect("git runs");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repo with one commit on `main`, no remote.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "main"]);
        run(root, &["config", "user.email", "t@example.com"]);
        run(root, &["config", "user.name", "T"]);
        run(root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("a.txt"), "a").unwrap();
        run(root, &["add", "."]);
        run(root, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn create(root: &Path, name: &str) -> CreatedWorktree {
        create_worktree(root, CreateOptions { name: name.into(), skip_fetch: true, ..Default::default() }).unwrap()
    }

    #[test]
    fn slugs_are_safe_folder_and_branch_names() {
        assert_eq!(slugify("My cool feature!", false), "My-cool-feature");
        assert_eq!(slugify("feat/login page", true), "feat/login-page");
        assert_eq!(slugify("feat/login page", false), "feat-login-page");
        assert_eq!(slugify("  ..weird.lock", false), "weird");
        assert_eq!(slugify("???", false), "");
    }

    #[test]
    fn main_checkout_is_listed_first() {
        let dir = repo();
        let list = list_worktrees(dir.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn review_cleanup_keeps_worktrees_containing_ignored_files() {
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "local.env\n").unwrap();
        run(root, &["add", ".gitignore"]);
        run(root, &["commit", "-qm", "Ignore local configuration"]);
        let created = create(root, "review");
        let path = Path::new(&created.worktree.path);
        std::fs::write(path.join("local.env"), "local test data").unwrap();

        let error = delete_worktree_with_protection(root, &created.worktree.path, false, true).unwrap_err();
        assert!(error.starts_with("DIRTY:"));
        assert!(path.join("local.env").is_file());
    }

    #[test]
    fn review_metadata_sums_file_sizes_and_reports_git_changes() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::create_dir(folder.path().join("nested")).unwrap();
        std::fs::write(folder.path().join("one"), b"abc").unwrap();
        std::fs::write(folder.path().join("nested/two"), b"12345").unwrap();
        let metadata = review_metadata(folder.path(), None).unwrap();
        assert_eq!(metadata.size_bytes, 8);
        assert!(!metadata.size_partial);
        assert!(metadata.modified_at.is_some());
        assert_eq!(metadata.git_state, None);

        let repo = repo();
        let created = create(repo.path(), "review");
        let path = Path::new(&created.worktree.path);
        std::fs::write(path.join("draft"), b"draft").unwrap();
        let metadata = review_metadata(repo.path(), Some(&created.worktree.path)).unwrap();
        assert_eq!(metadata.branch.as_deref(), Some("review"));
        assert_eq!(metadata.git_state, Some("Local changes"));
    }

    #[test]
    fn merged_cleanup_requires_a_changed_tip_reachable_from_the_primary_branch() {
        let dir = repo();
        let root = dir.path();
        let created = create(root, "agent-work");
        let path = Path::new(&created.worktree.path);
        let original = run(path, &["rev-parse", "HEAD"]);
        assert!(!worktree_merged_into_default(root, path, Some(&original)));

        run(path, &["commit", "--allow-empty", "-qm", "Agent work"]);
        assert!(!worktree_merged_into_default(root, path, Some(&original)));
        run(root, &["merge", "--ff-only", "agent-work"]);
        assert!(worktree_merged_into_default(root, path, Some(&original)));
    }

    #[test]
    fn create_lists_and_names_follow_the_typed_name() {
        let dir = repo();
        let created = create(dir.path(), "Login page");
        assert_eq!(created.worktree.branch.as_deref(), Some("Login-page"));
        assert!(is_under(&PathBuf::from(&created.worktree.path), &trees_area(dir.path())));

        let list = list_worktrees(dir.path()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].name, "Login page");
        assert_eq!(list[1].base_ref.as_deref(), Some("main"));
        assert!(!list[1].missing);
    }

    #[test]
    fn a_taken_name_gets_a_numeric_suffix() {
        let dir = repo();
        create(dir.path(), "fix");
        let second = create(dir.path(), "fix");
        assert_eq!(second.worktree.branch.as_deref(), Some("fix-2"));
        assert!(second.worktree.path.ends_with("fix-2"));
    }

    #[test]
    fn an_existing_free_branch_is_reused() {
        let dir = repo();
        run(dir.path(), &["branch", "existing"]);
        let created = create_worktree(
            dir.path(),
            CreateOptions { name: "x".into(), branch: Some("existing".into()), skip_fetch: true, ..Default::default() },
        )
        .unwrap();
        assert_eq!(created.worktree.branch.as_deref(), Some("existing"));
    }

    #[test]
    fn a_branch_checked_out_elsewhere_is_refused() {
        let dir = repo();
        let err = create_worktree(
            dir.path(),
            CreateOptions { name: "x".into(), branch: Some("main".into()), skip_fetch: true, ..Default::default() },
        )
        .unwrap_err();
        assert!(err.contains("already checked out"), "{err}");
    }

    #[test]
    fn agent_worktrees_are_not_listed() {
        let dir = repo();
        let agent = dir.path().join(".spacron").join("worktrees").join("agent");
        run(dir.path(), &["worktree", "add", "-q", "-b", "spacron/agent", agent.to_str().unwrap()]);
        let list = list_worktrees(dir.path()).unwrap();
        assert_eq!(list.len(), 1, "only the main checkout: {list:?}");
    }

    #[test]
    fn delete_removes_a_merged_branch_and_keeps_an_unmerged_one() {
        let dir = repo();
        let merged = create(dir.path(), "merged");
        let out = delete_worktree(dir.path(), &merged.worktree.path, false).unwrap();
        assert_eq!(out.preserved_branch, None);
        assert!(!branch_exists(dir.path(), "merged"));

        let work = create(dir.path(), "work");
        let wt = PathBuf::from(&work.worktree.path);
        std::fs::write(wt.join("b.txt"), "b").unwrap();
        run(&wt, &["add", "."]);
        run(&wt, &["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "work"]);
        let out = delete_worktree(dir.path(), &work.worktree.path, false).unwrap();
        assert_eq!(out.preserved_branch.as_deref(), Some("work"));
        assert!(branch_exists(dir.path(), "work"));
        assert_eq!(list_worktrees(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn delete_asks_before_discarding_uncommitted_changes() {
        let dir = repo();
        let created = create(dir.path(), "dirty");
        std::fs::write(PathBuf::from(&created.worktree.path).join("new.txt"), "x").unwrap();
        let err = delete_worktree(dir.path(), &created.worktree.path, false).unwrap_err();
        assert!(err.starts_with("DIRTY:"), "{err}");
        delete_worktree(dir.path(), &created.worktree.path, true).unwrap();
        assert!(!PathBuf::from(&created.worktree.path).exists());
    }

    #[test]
    fn delete_refuses_paths_outside_the_trees_area() {
        let dir = repo();
        assert!(delete_worktree(dir.path(), dir.path().to_str().unwrap(), true).is_err());
        let agent = dir.path().join(".spacron").join("worktrees").join("a");
        assert!(delete_worktree(dir.path(), agent.to_str().unwrap(), true).is_err());
    }

    #[test]
    fn notes_and_parents_round_trip() {
        let dir = repo();
        let a = create(dir.path(), "a");
        let b = create(dir.path(), "b");
        update_worktree_meta(dir.path(), &b.worktree.path, Some("Bee".into()), Some("hello".into()), Some(Some(a.worktree.path.clone()))).unwrap();
        let list = list_worktrees(dir.path()).unwrap();
        let row = list.iter().find(|w| w.path == b.worktree.path).unwrap();
        assert_eq!(row.name, "Bee");
        assert_eq!(row.note.as_deref(), Some("hello"));
        assert_eq!(row.parent.as_deref(), Some(a.worktree.path.as_str()));

        // Deleting the parent lifts the child to the top level.
        delete_worktree(dir.path(), &a.worktree.path, true).unwrap();
        let list = list_worktrees(dir.path()).unwrap();
        assert_eq!(list.iter().find(|w| w.path == b.worktree.path).unwrap().parent, None);
    }

    #[test]
    fn default_base_falls_back_to_the_current_branch() {
        let dir = repo();
        assert_eq!(default_base(dir.path()), "main");
        run(dir.path(), &["branch", "feature/x"]);
        let bases = list_bases(dir.path());
        assert_eq!(bases.refs.first().map(String::as_str), Some("main"));
        assert!(bases.local.iter().any(|b| b == "feature/x"), "{:?}", bases.local);
    }

    #[test]
    fn porcelain_parses_branch_detached_and_prunable() {
        let text = "worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/r/.spacron/trees/x\nHEAD def\ndetached\nprunable gitdir file points to non-existent location\n";
        let entries = parse_porcelain(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[1].branch, None);
        assert!(entries[1].prunable);
    }
}
