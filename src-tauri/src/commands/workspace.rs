use crate::state::AppState;
use crate::workspace::project::Project;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::State;

pub(crate) fn sanitize_git_error(stderr: &str) -> String {
    stderr
        .lines()
        .map(|line| {
            line.split_whitespace()
                .map(|token| {
                    let trimmed = token.trim_matches(|c| matches!(c, '\'' | '"' | '`'));
                    let looks_like_path = trimmed.starts_with('/')
                        || trimmed.starts_with(r"\\")
                        || (trimmed.len() > 2
                            && trimmed.as_bytes()[1] == b':'
                            && matches!(trimmed.as_bytes()[2], b'\\' | b'/'))
                        || trimmed.contains('/')
                        || trimmed.contains('\\');
                    if looks_like_path {
                        "[path redacted]"
                    } else {
                        token
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Turn a failed `git push` stderr into a clear, actionable message. Without this,
/// auth failures surface as a cryptic blob (or, with prompts disabled, as a silent
/// "terminal prompts disabled" line) that's easy to miss — the user is left thinking
/// the push worked when it didn't.
pub(crate) fn classify_push_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();

    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("permission denied")
        || lower.contains("invalid username or password")
        || lower.contains("403")
    {
        return "Authentication failed — your changes were NOT pushed. Sign in to GitHub (Git Credential Manager) or check that your saved credentials / access token are still valid, then push again.".to_string();
    }

    if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("[rejected]")
        || lower.contains("tip of your current branch is behind")
    {
        return "Push rejected — the remote has commits you don't have locally. Fetch and merge (or pull) first, then push again.".to_string();
    }

    if lower.contains("no configured push destination")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("no such remote")
        || lower.contains("repository not found")
    {
        return "No remote to push to — check that an 'origin' remote is configured for this project.".to_string();
    }

    if lower.contains("could not resolve host")
        || lower.contains("failed to connect")
        || lower.contains("connection timed out")
    {
        return "Couldn't reach GitHub — check your internet connection and try again.".to_string();
    }

    format!("Git push failed:\n{}", sanitize_git_error(stderr))
}

/// Construct a `git` Command. On Windows this sets the CREATE_NO_WINDOW process
/// creation flag so the child git process doesn't flash a console window.
/// Without it, every git invocation pops up a terminal — and opening Source
/// Control fires several git commands back-to-back (status, branches, log),
/// so the user sees terminals opening repeatedly and the UI stutters.
///
/// Drop-in replacement for `git_base()`: callers add their own
/// `.args(..)`, `.current_dir(..)`, and env as before.
pub(crate) fn git_base() -> Command {
    let program = "git";
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Cached `git --version` output. Only a *successful* probe is stored: git does
/// not vanish mid-session, but it can well be installed mid-session, so a failure
/// must re-probe rather than pin "git is missing" until restart.
static GIT_VERSION: OnceLock<String> = OnceLock::new();

/// Check whether `git` is available on the system PATH. Returns the `--version`
/// output on success, or a descriptive error explaining that git is not found.
///
/// Every write-side git command calls this, and spawning a process costs ~250 ms
/// on a large repo, so the answer is memoized after the first success. It also
/// goes through `git_base()` — a bare `Command::new("git")` misses
/// CREATE_NO_WINDOW and flashes a console window on Windows on every commit.
pub(crate) fn check_git_available() -> Result<String, String> {
    if let Some(version) = GIT_VERSION.get() {
        return Ok(version.clone());
    }
    match git_base().arg("--version").output() {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let _ = GIT_VERSION.set(version.clone());
            Ok(version)
        }
        Ok(_) => Err("git --version exited with non-zero status".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Give the user install guidance for whichever OS they're on, not a
            // Windows-only hint. See commands::deps for the source of truth.
            Err(super::deps::GIT.missing_message())
        }
        Err(e) => Err(format!("Failed to run git --version: {e}")),
    }
}

/// One lock per repository root, guarding the commands that write that repo's
/// index or working tree.
///
/// Until these commands moved off the main thread they were serialized by the
/// event loop, so nothing could interleave. Now that they run concurrently, two
/// index writers racing — the user committing while the worktree reconciler
/// applies an agent's patch, say — would collide on `.git/index.lock` and fail
/// one of them with a cryptic error. This restores exactly the mutual exclusion
/// the main thread used to provide, and nothing more: read-only commands
/// (status, log, diff, branches) take no lock and still run in parallel. Git
/// itself degrades gracefully when its opportunistic index refresh can't take
/// the lock, so readers need no protection.
/// Each per-repo lock is leaked so it lives for the process and callers can hold a
/// plain `MutexGuard<'static, ()>`. Bounded by the number of distinct project roots
/// opened in a session — a handful of pointers, never freed, never grows unbounded.
static REPO_LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();

/// Acquire the write lock for `root`. Hold the returned guard for the duration of
/// the git invocations that mutate the repo.
///
/// Poisoning is ignored deliberately: the guard protects nothing but ordering, so
/// a panic in an unrelated command must not wedge every later git write.
fn lock_repo_write(root: &Path) -> MutexGuard<'static, ()> {
    let registry = REPO_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let lock: &'static Mutex<()> = {
        let mut map = match registry.lock() {
            Ok(map) => map,
            Err(poisoned) => poisoned.into_inner(),
        };
        map.entry(root.to_path_buf())
            .or_insert_with(|| &*Box::leak(Box::new(Mutex::new(()))))
    };
    match lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Run a git command in `root` and return its trimmed stdout on success, or None.
fn git_capture(root: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

fn validate_relative_path(file_path: &str) -> Result<(), String> {
    if file_path.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    if file_path.starts_with("--") {
        return Err("Invalid file path".to_string());
    }
    if file_path.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("Path traversal is not allowed".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_open_project(path: String, state: State<AppState>) -> Result<Project, String> {
    let root_path =
        std::fs::canonicalize(PathBuf::from(&path)).map_err(|_| "Invalid path".to_string())?;
    let root_path = crate::commands::clean_path_buf(root_path);
    state
        .workspace_manager
        .open_project(root_path)
        .map_err(|e| e.to_string())
}

/// Create a brand-new empty folder named `name` inside `parent`, then open it as a
/// project. This is the "start fresh" path. Unlike `fs_create_dir` (which requires
/// the target to already sit inside an open project root), this deliberately creates
/// a directory *outside* every existing root and registers it as a new root in one
/// step, so a user can spin up a project from nothing without first opening a folder.
#[tauri::command]
pub fn workspace_create_project(
    parent: String,
    name: String,
    state: State<AppState>,
) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Folder name cannot be empty.".to_string());
    }
    if name.chars().count() > 255 {
        return Err("Folder name is too long.".to_string());
    }
    // A single new folder — reject separators, parent refs, leading dashes, and
    // control characters so this can only ever create one directory under `parent`.
    if name.contains('\0')
        || name.contains('/')
        || name.contains('\\')
        || name.starts_with('-')
        || name == "."
        || name == ".."
        || name.contains("..")
        || name.chars().any(|c| c.is_control())
    {
        return Err("Folder name contains invalid characters.".to_string());
    }
    // Characters that are illegal in Windows filenames (and best avoided elsewhere).
    if name.contains(|c: char| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Err("Folder name contains invalid characters.".to_string());
    }

    let parent_path = std::fs::canonicalize(PathBuf::from(&parent))
        .map(crate::commands::clean_path_buf)
        .map_err(|_| "The selected location does not exist.".to_string())?;
    if !parent_path.is_dir() {
        return Err("The selected location is not a folder.".to_string());
    }

    let target = crate::commands::clean_path_buf(parent_path.join(name));
    if target.exists() {
        return Err(format!("A folder named \"{name}\" already exists here."));
    }

    // Create exactly one directory (not create_dir_all) so a malformed name can't
    // silently produce a chain of nested folders.
    std::fs::create_dir(&target).map_err(|e| format!("Failed to create folder: {e}"))?;

    // Canonicalize the freshly-created directory so its path (and therefore the
    // project id derived from it) matches what opening the same folder later would
    // produce, keeping the project id stable across sessions.
    let root_path = std::fs::canonicalize(&target)
        .map(crate::commands::clean_path_buf)
        .unwrap_or(target);

    state
        .workspace_manager
        .open_project(root_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_get_active(state: State<AppState>) -> Option<Project> {
    state.workspace_manager.get_active_project()
}

#[tauri::command]
pub fn workspace_list_projects(state: State<AppState>) -> Vec<Project> {
    state.workspace_manager.list_projects()
}

#[tauri::command]
pub fn workspace_get_recent(
    state: State<AppState>,
) -> Vec<crate::workspace::project::RecentProject> {
    state.workspace_manager.get_recent_projects()
}

#[tauri::command(async)]
pub fn workspace_git_commit(
    project_id: String,
    message: String,
    files: Option<Vec<String>>,
    state: State<AppState>,
) -> Result<String, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    // Surface a clear, cross-platform "install Git" message instead of a cryptic
    // "program not found" if the git binary is missing on this machine.
    check_git_available()?;

    if message.trim().is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    if message.len() > 10_000 {
        return Err("Commit message is too long (limit 10 000 characters)".to_string());
    }
    if message.contains('\0') {
        return Err("Commit message contains invalid characters.".to_string());
    }

    // Determine whether to commit a selected subset or everything. An empty list
    // is treated as "no files selected" rather than "commit all".
    let selected: Option<Vec<String>> = match files {
        Some(list) if !list.is_empty() => {
            for path in &list {
                if path.is_empty() || path.contains('\0') {
                    return Err("A selected file path is invalid.".to_string());
                }
            }
            Some(list)
        }
        Some(_) => return Err("No files selected to commit.".to_string()),
        None => None,
    };

    // Hold the repo write lock across the add + commit pair so the reconciler
    // can't apply an agent patch between them and land in this commit.
    let _repo = lock_repo_write(root_path);

    // 1. Stage changes. With a selection, stage only those paths (the "--"
    //    separator stops paths that begin with "-" from being read as flags);
    //    otherwise stage everything. `git add -A -- <paths>` also records
    //    deletions and newly-tracked files within the selection.
    let mut add_args: Vec<&str> = vec!["add", "-A"];
    if let Some(ref list) = selected {
        add_args.push("--");
        for path in list {
            add_args.push(path);
        }
    }
    let add_output = git_base()
        .args(&add_args)
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to stage changes: {}", e))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!(
            "Failed to stage changes: {}",
            sanitize_git_error(&stderr)
        ));
    }

    // 2. Commit changes. With a selection, restrict the commit to those paths so
    //    anything else already staged is left untouched.
    let mut commit_args: Vec<&str> = vec!["commit", "-m", &message];
    if let Some(ref list) = selected {
        commit_args.push("--");
        for path in list {
            commit_args.push(path);
        }
    }
    let commit_output = git_base()
        .args(&commit_args)
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to commit changes: {}", e))?;

    let stdout = String::from_utf8_lossy(&commit_output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&commit_output.stderr).to_string();

    if commit_output.status.success() {
        Ok(format!(
            "Successfully committed changes!\n{}{}",
            stdout,
            sanitize_git_error(&stderr)
        ))
    } else {
        Err(format!(
            "Commit failed:\n{}{}",
            sanitize_git_error(&stderr),
            stdout
        ))
    }
}

#[tauri::command(async)]
pub fn workspace_git_push(project_id: String, state: State<AppState>) -> Result<String, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    // Surface a clear, cross-platform "install Git" message instead of a cryptic
    // "program not found" if the git binary is missing on this machine.
    check_git_available()?;

    // 1. Determine current branch
    let branch = git_base()
        .args(["branch", "--show-current"])
        .current_dir(root_path)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // 2. Push to origin and set upstream (-u) so the branch tracks origin/<branch>
    //    afterward — that's what lets us show ahead/behind counts. The "--"
    //    separator prevents branch names starting with "-" from being read as flags.
    let mut push_args: Vec<&str> = vec!["push", "-u", "origin"];
    let branch_owned = branch.clone();
    if !branch_owned.is_empty() {
        push_args.push("--");
        push_args.push(&branch_owned);
    }

    let output = git_base()
        .args(push_args)
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        // git reports a no-op push ("Everything up-to-date") on stderr.
        if stderr.to_lowercase().contains("everything up-to-date") {
            Ok("Already up to date — nothing new to push.".to_string())
        } else {
            Ok(format!(
                "Successfully pushed to GitHub!\n{}{}",
                stdout,
                sanitize_git_error(&stderr)
            ))
        }
    } else {
        Err(classify_push_error(&stderr))
    }
}

#[tauri::command(async)]
pub fn workspace_git_fetch(project_id: String, state: State<AppState>) -> Result<String, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    // Surface a clear, cross-platform "install Git" message instead of a cryptic
    // "program not found" if the git binary is missing on this machine.
    check_git_available()?;

    let output = git_base()
        .args(["fetch", "origin"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to execute git fetch: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!(
            "Successfully fetched from remote!\n{}{}",
            sanitize_git_error(&stdout),
            sanitize_git_error(&stderr)
        ))
    } else {
        Err(format!(
            "Git fetch failed:\n{}{}",
            sanitize_git_error(&stderr),
            sanitize_git_error(&stdout)
        ))
    }
}

#[tauri::command]
pub fn workspace_detect_port(path: String, state: State<AppState>) -> u16 {
    let root = match std::fs::canonicalize(std::path::PathBuf::from(&path)) {
        Ok(r) => crate::commands::clean_path_buf(r),
        Err(_) => return 5173,
    };
    // Only read files that belong to an open project
    let projects = state.workspace_manager.list_projects();
    if !projects.iter().any(|p| root.starts_with(&p.root_path)) {
        return 5173;
    }

    // 1. Try to read package.json (cap at 1MB to prevent DoS on malformed projects)
    let package_json_path = root.join("package.json");
    if package_json_path.is_file() {
        let too_large = std::fs::metadata(&package_json_path)
            .map(|m| m.len() > 1_048_576)
            .unwrap_or(false);
        if !too_large {
            if let Ok(content) = std::fs::read_to_string(&package_json_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    // If package.json has scripts:
                    if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                        for (_name, cmd_val) in scripts {
                            if let Some(cmd) = cmd_val.as_str() {
                                if let Some(port) = extract_port_from_cmd(cmd) {
                                    return port;
                                }
                            }
                        }
                    }

                    // If no port specified in scripts, check framework signatures
                    if let Some(dependencies) = json.get("dependencies").and_then(|d| d.as_object())
                    {
                        if dependencies.contains_key("next") || dependencies.contains_key("nuxt") {
                            return 3000;
                        }
                        if dependencies.contains_key("astro") {
                            return 4321;
                        }
                    }
                    if let Some(dev_dependencies) =
                        json.get("devDependencies").and_then(|d| d.as_object())
                    {
                        if dev_dependencies.contains_key("next")
                            || dev_dependencies.contains_key("nuxt")
                        {
                            return 3000;
                        }
                        if dev_dependencies.contains_key("astro") {
                            return 4321;
                        }
                    }
                }
            }
        } // end !too_large
    }

    // 2. Scan vite config if it exists
    for config_name in &["vite.config.ts", "vite.config.js"] {
        let config_path = root.join(config_name);
        if config_path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Some(port) = extract_port_from_vite_config(&content) {
                    return port;
                }
            }
        }
    }

    // Default fallback
    5173
}

fn extract_port_from_cmd(cmd: &str) -> Option<u16> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    for i in 0..parts.len() {
        if (parts[i] == "--port" || parts[i] == "-p") && i + 1 < parts.len() {
            if let Ok(port) = parts[i + 1].parse::<u16>() {
                return Some(port);
            }
        }
    }
    None
}

fn extract_port_from_vite_config(content: &str) -> Option<u16> {
    // Parse line-by-line and skip comments to avoid false positives like `// port: 22`
    let mut in_block_comment = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if in_block_comment {
            if trimmed.contains("*/") {
                in_block_comment = false;
            }
            continue;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        if trimmed.starts_with("/*") {
            // Single-line block comment: /* ... */ — enter and immediately exit
            if trimmed.contains("*/") {
                continue;
            }
            in_block_comment = true;
            continue;
        }
        if let Some(pos) = trimmed.find("port:") {
            let after = &trimmed[pos + 5..];
            let num_str: String = after
                .chars()
                .skip_while(|c| c.is_whitespace())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !num_str.is_empty() {
                if let Ok(port) = num_str.parse::<u16>() {
                    return Some(port);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchResult {
    pub file_path: String,
    pub relative_path: String,
    pub line_number: usize,
    pub line_content: String,
}

/// `async` because this walks the entire project tree and reads every candidate
/// file into memory. On the main thread (a plain `#[tauri::command]`) that froze
/// the whole window for the duration of the scan — seconds on a large repo, and
/// it scales with the user's project, not ours.
#[tauri::command(async)]
pub fn workspace_search_codebase(
    project_path: String,
    query: String,
    state: State<AppState>,
) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let root = std::path::PathBuf::from(&project_path);
    if !root.exists() {
        return Err("Project path does not exist".to_string());
    }

    let root = std::fs::canonicalize(&root).map_err(|_| "Invalid project path".to_string())?;
    let root = crate::commands::clean_path_buf(root);

    // Verify the requested path is an open project (prevents arbitrary directory traversal)
    let projects = state.workspace_manager.list_projects();
    if !projects
        .iter()
        .any(|p| root == p.root_path || root.starts_with(&p.root_path))
    {
        return Err("Project path is not an open project".to_string());
    }

    let mut results = Vec::new();
    let query_lower = query.to_lowercase();

    // Scan recursively
    if let Err(e) = search_dir_recursive(&root, &root, &query_lower, &mut results) {
        return Err(format!("Search failed: {}", e));
    }

    Ok(results)
}

fn search_dir_recursive(
    dir: &std::path::Path,
    root: &std::path::Path,
    query: &str,
    results: &mut Vec<SearchResult>,
) -> std::io::Result<()> {
    if results.len() >= 150 {
        return Ok(());
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            // Skip symlinks to prevent escaping the project root
            if path.is_symlink() {
                continue;
            }
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.')
                        || name == "node_modules"
                        || name == "dist"
                        || name == "build"
                        || name == "target"
                        || name == "out"
                    {
                        continue;
                    }
                }
                search_dir_recursive(&path, root, query, results)?;
            } else if path.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    if metadata.len() > 10 * 1024 * 1024 {
                        // Skip files larger than 10MB
                        continue;
                    }
                }

                // Read and check if it's text
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content.contains('\0') {
                        continue; // binary
                    }

                    let relative_path = path
                        .strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();
                    let file_path = path.to_string_lossy().to_string();

                    for (idx, line) in content.lines().enumerate() {
                        if line.to_lowercase().contains(query) {
                            results.push(SearchResult {
                                file_path: file_path.clone(),
                                relative_path: relative_path.clone(),
                                line_number: idx + 1,
                                line_content: line.trim().chars().take(1024).collect(),
                            });
                            if results.len() >= 150 {
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub modified: Vec<String>,
    pub added: Vec<String>,
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
    pub file_stats: std::collections::HashMap<String, (i32, i32)>,
    pub total_additions: i32,
    pub total_deletions: i32,
}

#[tauri::command(async)]
pub fn workspace_git_status(
    project_id: String,
    state: State<AppState>,
) -> Result<GitStatus, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    // 1. Get branch name
    let branch = git_base()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "HEAD".to_string());

    // 2. Get porcelain status
    let output = git_base()
        .args(["status", "--porcelain"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut modified = Vec::new();
    let mut added = Vec::new();
    let mut deleted = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let status_code = &line[0..2];
        let file_path = line[3..].trim().to_string();

        // Unmerged paths (merge/rebase conflicts) come first: any 'U', or the
        // both-added / both-deleted cases, which the M/A/D checks would
        // otherwise misclassify.
        if status_code.contains('U') || status_code == "AA" || status_code == "DD" {
            conflicted.push(file_path);
        } else if status_code.contains('M') {
            modified.push(file_path);
        } else if status_code.contains('A') {
            added.push(file_path);
        } else if status_code.contains('D') {
            deleted.push(file_path);
        } else if status_code.contains('?') {
            untracked.push(file_path);
        }
    }

    // 3. Get additions/deletions stats from git diff HEAD --numstat
    let mut file_stats = std::collections::HashMap::new();
    let mut total_additions = 0;
    let mut total_deletions = 0;

    let numstat_output = git_base()
        .args(["diff", "HEAD", "--numstat", "--no-renames"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();

    if let Ok(ref output) = numstat_output {
        let numstat_stdout = String::from_utf8_lossy(&output.stdout);
        for line in numstat_stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let additions = parts[0].parse::<i32>().unwrap_or(0);
                let deletions = parts[1].parse::<i32>().unwrap_or(0);
                let file_path = parts[2].to_string();
                file_stats.insert(file_path.clone(), (additions, deletions));
                total_additions += additions;
                total_deletions += deletions;
            }
        }
    }

    // 4. Manually add untracked file stats (since they aren't in numstat)
    for file in &untracked {
        if validate_relative_path(file).is_err() {
            continue;
        }
        let absolute_path = root_path.join(file);
        let additions = if absolute_path.exists() && absolute_path.is_file() {
            let size = std::fs::metadata(&absolute_path)
                .map(|m| m.len())
                .unwrap_or(u64::MAX);
            if size > 10 * 1024 * 1024 {
                0 // skip large files to avoid reading multi-GB binaries into memory
            } else {
                match std::fs::read_to_string(&absolute_path) {
                    Ok(content) => content.lines().count() as i32,
                    Err(_) => 0,
                }
            }
        } else {
            0
        };
        file_stats.insert(file.clone(), (additions, 0));
        total_additions += additions;
    }

    Ok(GitStatus {
        branch,
        modified,
        added,
        deleted,
        untracked,
        conflicted,
        file_stats,
        total_additions,
        total_deletions,
    })
}

#[tauri::command(async)]
pub fn workspace_git_discard_file(
    project_id: String,
    file_path: String,
    state: State<AppState>,
) -> Result<(), String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    validate_relative_path(&file_path)?;

    // Verify the absolute path stays within the project root
    let absolute_check = root_path.join(&file_path);
    let canonical_check = if absolute_check.exists() {
        std::fs::canonicalize(&absolute_check).map_err(|_| "Invalid path".to_string())?
    } else if let Some(parent) = absolute_check.parent() {
        if parent.exists() {
            let cp = std::fs::canonicalize(parent).map_err(|_| "Invalid path".to_string())?;
            cp.join(absolute_check.file_name().unwrap_or_default())
        } else {
            absolute_check.clone()
        }
    } else {
        absolute_check.clone()
    };
    let canonical_check = crate::commands::clean_path_buf(canonical_check);
    if !canonical_check.starts_with(root_path) {
        return Err("Access denied: path is outside project root".to_string());
    }

    let _repo = lock_repo_write(root_path);

    // 1. Get current git status to see if file is untracked
    let status_output = git_base()
        .args(["status", "--porcelain", "--", &file_path])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to check file status: {}", e))?;

    let stdout = String::from_utf8_lossy(&status_output.stdout);
    let is_untracked = stdout.lines().any(|line| line.starts_with("??"));

    if is_untracked {
        // Delete the file
        let absolute_path = root_path.join(&file_path);
        if absolute_path.exists() {
            if absolute_path.is_dir() {
                std::fs::remove_dir_all(&absolute_path)
                    .map_err(|e| format!("Failed to delete directory {}: {}", file_path, e))?;
            } else {
                std::fs::remove_file(&absolute_path)
                    .map_err(|e| format!("Failed to delete file {}: {}", file_path, e))?;
            }
        }
    } else {
        // Tracked file: unstage and discard changes
        // Unstage first (in case it was added/staged)
        let _ = git_base()
            .args(["reset", "HEAD", "--", &file_path])
            .current_dir(root_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output();

        // Discard changes in worktree
        let checkout_output = git_base()
            .args(["checkout", "--", &file_path])
            .current_dir(root_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("Failed to checkout file: {}", e))?;

        if !checkout_output.status.success() {
            // If checkout failed, it might be a new file that has been reset and is now untracked.
            // Let's check status again, or check if it's untracked now.
            let status_output2 = git_base()
                .args(["status", "--porcelain", "--", &file_path])
                .current_dir(root_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();

            if let Ok(out) = status_output2 {
                let stdout2 = String::from_utf8_lossy(&out.stdout);
                if stdout2.lines().any(|line| line.starts_with("??")) {
                    let absolute_path = root_path.join(&file_path);
                    if absolute_path.exists() {
                        let _ = std::fs::remove_file(&absolute_path);
                    }
                }
            }
        }
    }

    Ok(())
}

#[tauri::command(async)]
pub fn workspace_git_discard_all(
    project_id: String,
    confirmation: String,
    state: State<AppState>,
) -> Result<(), String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    if confirmation.trim() != "discard all changes" {
        return Err("Discard all requires explicit confirmation.".to_string());
    }

    // Held across reset + clean so no concurrent write lands in between and gets
    // destroyed by the clean without ever having been seen.
    let _repo = lock_repo_write(root_path);

    // 1. Reset all tracked changes
    let reset_output = git_base()
        .args(["reset", "--hard", "HEAD"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git reset: {}", e))?;

    if !reset_output.status.success() {
        let stderr = String::from_utf8_lossy(&reset_output.stderr);
        return Err(format!("Discard all failed on reset: {}", stderr));
    }

    // 2. Clean untracked files
    let clean_output = git_base()
        .args(["clean", "-fd"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git clean: {}", e))?;

    if !clean_output.status.success() {
        let stderr = String::from_utf8_lossy(&clean_output.stderr);
        return Err(format!("Discard all failed on clean: {}", stderr));
    }

    Ok(())
}

// ── Agent worktree isolation ────────────────────────────────────────────────
// Each orchestrator agent works in its own git worktree on a dedicated branch,
// so multiple agents can edit the same repository concurrently without stepping
// on each other.
//
// Worktrees live *inside* the project at `.spacron/worktrees/<branch>`. They must
// be inside the root: terminals, file ops and LSP are all confined to the open
// project roots (`file_system::require_in_project`), so a worktree anywhere else
// can be created but never *used* — `terminal_create` rejects its cwd and the
// agent silently falls back to the project root. `.spacron/` is already the app's
// project-local data directory and is added to `.git/info/exclude`, so the
// checkouts stay out of the user's git status.

/// The managed worktree area for a project: `<project>/.spacron/worktrees`.
fn worktree_area(root: &std::path::Path) -> PathBuf {
    root.join(".spacron").join("worktrees")
}

/// Pre-0.7.4 location: a sibling `<project_parent>/.spacron-worktrees/<repo>`
/// directory. Still accepted by remove/status so worktrees recorded in persisted
/// sessions before the move can still be cleaned up.
fn legacy_worktree_area(root: &std::path::Path) -> Option<PathBuf> {
    let repo = root.file_name()?.to_str()?;
    Some(root.parent()?.join(".spacron-worktrees").join(repo))
}

/// Whether `path` sits inside `area`. Compared case-insensitively on Windows,
/// where the same directory legitimately reaches us with different casing.
fn is_under(path: &std::path::Path, area: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        let (p, a) = (
            path.to_string_lossy().to_lowercase().replace('\\', "/"),
            area.to_string_lossy().to_lowercase().replace('\\', "/"),
        );
        let a = a.trim_end_matches('/');
        p == a || p.starts_with(&format!("{a}/"))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(area)
    }
}

/// Keep the worktree checkouts out of the user's git surface by excluding the
/// whole `.spacron/` data directory in `.git/info/exclude` (local-only, never
/// committed). Without this a nested worktree shows up as an untracked directory
/// in the project's own status — and `git add -A` would try to embed it.
/// Best-effort: a linked worktree or a repo without an exclude file is skipped.
fn ensure_spacron_excluded(root: &std::path::Path) {
    let exclude = root.join(".git").join("info").join("exclude");
    let Ok(current) = std::fs::read_to_string(&exclude) else {
        return; // no plain .git/info/exclude — not a standard checkout
    };
    if current
        .lines()
        .any(|l| matches!(l.trim(), "/.spacron/" | ".spacron/" | "/.spacron" | ".spacron"))
    {
        return;
    }
    let next = format!("{}\n/.spacron/\n", current.trim_end());
    let _ = std::fs::write(&exclude, next);
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub base_branch: String,
    pub base_commit: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeStatus {
    pub changed_files: u32,
    pub branch: String,
}

fn is_valid_branch_name(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with('-')
        && !branch.starts_with('/')
        && !branch.ends_with('/')
        && !branch.contains("..")
        && !branch
            .contains(|c: char| matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\' | ' ' | '\0'))
}

/// Create an isolated git worktree on a fresh branch (forked from current HEAD)
/// for one agent. Returns the worktree's absolute path plus branch metadata, or
/// an error when the project isn't a git repo (the caller then runs the agent in
/// the project root instead).
#[tauri::command(async)]
pub fn workspace_git_create_worktree(
    project_id: String,
    branch: String,
    state: State<AppState>,
) -> Result<WorktreeInfo, String> {

    // Verify git is available before attempting any git operations. In production
    // builds (packaged app), the PATH may differ from the dev environment, and
    // `git` might not be resolvable. This gives a clear error instead of a cryptic
    // "program not found" from Command::output.
    check_git_available().map_err(|e| format!("Git not available: {e}"))?;

    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;
    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    let branch = branch.trim();
    if !is_valid_branch_name(branch) {
        return Err("Invalid branch name".to_string());
    }

    // `git worktree add` writes .git/worktrees and the branch ref; serialize it
    // against the other repo writers.
    let _repo = lock_repo_write(root_path);

    let base_branch =
        git_capture(root_path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| "HEAD".to_string());
    let base_commit = git_capture(root_path, &["rev-parse", "HEAD"])
        .ok_or_else(|| "Could not resolve HEAD — the repository has no commits yet.".to_string())?;

    let safe_branch = branch.replace('/', "-");
    let worktree_path =
        crate::commands::clean_path_buf(worktree_area(root_path).join(&safe_branch));
    let path_str = worktree_path.to_string_lossy().to_string();

    // Do this before `git worktree add` so the checkout is never briefly visible
    // in the project's git status.
    ensure_spacron_excluded(root_path);

    // Reuse an existing worktree at this path (idempotent on retry/relaunch).
    if worktree_path.join(".git").exists() {
        return Ok(WorktreeInfo {
            path: path_str,
            branch: branch.to_string(),
            base_branch,
            base_commit,
        });
    }

    if let Some(p) = worktree_path.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("Failed to create worktree directory: {}", e))?;
    }

    // Fresh branch from HEAD. If the branch already exists (a prior run), fall
    // back to checking it out into the new worktree path.
    let output = git_base()
        .args(["worktree", "add", "-b", branch, &path_str, "HEAD"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let retry = git_base()
            .args(["worktree", "add", &path_str, branch])
            .current_dir(root_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;
        if !retry.status.success() {
            return Err(format!("Failed to create worktree: {}", sanitize_git_error(&stderr)));
        }
    }

    // Defensive: only report success if the checkout actually materialized, so the
    // frontend can fall back to the project root rather than try to start a shell
    // in a directory that doesn't exist.
    if !worktree_path.is_dir() {
        return Err("Worktree directory was not created.".to_string());
    }

    Ok(WorktreeInfo {
        path: path_str,
        branch: branch.to_string(),
        base_branch,
        base_commit,
    })
}

/// Remove an agent worktree (and optionally delete its branch). Refuses to touch
/// anything outside the project's managed worktree area as a safety guard.
#[tauri::command(async)]
pub fn workspace_git_remove_worktree(
    project_id: String,
    worktree_path: String,
    delete_branch: Option<bool>,
    branch: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    // Confine removal to this project's managed area — current or legacy — so a
    // crafted path can never make us `git worktree remove` an arbitrary directory.
    let cleaned = crate::commands::clean_path_buf(PathBuf::from(&worktree_path));
    let in_managed_area = is_under(&cleaned, &worktree_area(root_path))
        || legacy_worktree_area(root_path).is_some_and(|area| is_under(&cleaned, &area));
    if !in_managed_area {
        return Err("Refusing to remove a path outside the managed worktree area.".to_string());
    }

    let _repo = lock_repo_write(root_path);

    let remove_out = git_base()
        .args(["worktree", "remove", "--force", &worktree_path])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
    let _ = git_base()
        .args(["worktree", "prune"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();

    if let Ok(out) = remove_out {
        if !out.status.success() && PathBuf::from(&worktree_path).exists() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!("git worktree remove failed: {stderr}"));
        }
    }

    if delete_branch.unwrap_or(false) {
        if let Some(b) = branch {
            let b = b.trim();
            if is_valid_branch_name(b) {
                let _ = git_base()
                    .args(["branch", "-D", b])
                    .current_dir(root_path)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .output();
            }
        }
    }

    Ok(())
}

/// List worktree directories currently on disk in the project's managed area.
/// Used by the frontend to detect orphaned worktrees that outlived their sessions.
#[tauri::command(async)]
pub fn workspace_git_list_worktrees(
    project_id: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    let mut results = Vec::new();
    let areas: Vec<PathBuf> = [Some(worktree_area(root_path)), legacy_worktree_area(root_path)]
        .into_iter()
        .flatten()
        .collect();

    for area in areas {
        let Ok(entries) = std::fs::read_dir(&area) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                results.push(path.to_string_lossy().to_string());
            }
        }
    }

    Ok(results)
}

/// Run `git worktree prune` to clean stale metadata in `.git/worktrees/`.
#[tauri::command(async)]
pub fn workspace_git_prune_worktrees(
    project_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    let _ = git_base()
        .args(["worktree", "prune"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();

    Ok(())
}

// ---------------------------------------------------------------------------
// Agent branch sweep
//
// Removing a worktree deliberately KEEPS its branch: until the user commits in
// Source Control the branch is the only durable copy of the agent's work (see
// `reclaimWorktree`). Nothing ever came back for them afterwards, so they
// accumulated — 157 in this repo's own checkout, 156 of which held no commits at
// all, because an agent that never commits leaves a branch pointing at the fork
// commit.
//
// That is exactly the class this sweeps: a branch whose tip is already reachable
// from a base branch contains nothing the base does not, so deleting it cannot
// lose information. Branches with unique commits are reported, never deleted —
// deciding those is the user's call.
// ---------------------------------------------------------------------------

/// Prefix every agent branch carries. Mirrors `deriveTaskBranch` in
/// `worktree-manager.ts` (`spacron/<slug>-<id>`). Confining the sweep to this
/// prefix is the first guard keeping it off the user's own branches.
const AGENT_BRANCH_PREFIX: &str = "spacron/";

/// Above this many branches holding commits, the per-branch detail reads are
/// skipped. `git cherry` is a patch-id computation per commit, and a repo in
/// that state wants the summary count, not a hundred round trips.
const RETAINED_DETAIL_LIMIT: usize = 60;

/// An agent branch the sweep chose to keep, with enough detail for the user to
/// decide what to do with it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetainedAgentBranch {
    pub branch: String,
    /// Commits on this branch that the base does not have.
    pub unique_commits: u32,
    /// Committer date of the tip, ISO-8601, for "last touched" display.
    pub last_commit: String,
    /// True when `git cherry` reports every unique commit as already applied to
    /// the base by patch id — i.e. the work landed through staging (which
    /// applies patches rather than merging, so the branch never becomes an
    /// ancestor). Strong evidence it is safe to drop, but NOT proof: a patch
    /// applied with `--3way` and then edited no longer matches. Reported for
    /// the user to act on; never acted on automatically.
    pub patch_equivalent: bool,
}

/// Result of one sweep pass.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentBranchSweep {
    /// Branches deleted (or, in a dry run, that would be).
    pub deleted: Vec<String>,
    /// Branches kept because they hold commits the base does not have.
    pub retained: Vec<RetainedAgentBranch>,
    /// Branches that were eligible but that git refused to delete.
    pub failed: Vec<String>,
    /// Branch the containment test was run against.
    pub base: String,
}

/// Run a git read and return trimmed stdout, or None when the command failed.
fn git_read(root: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Non-empty trimmed lines of a git read.
fn git_read_lines(root: &std::path::Path, args: &[&str]) -> Vec<String> {
    git_read(root, args)
        .map(|s| {
            s.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Branch names out of `git worktree list --porcelain`, which reports them as
/// `branch refs/heads/<name>` lines (and omits the line entirely for a detached
/// worktree).
fn parse_checked_out_branches(porcelain: &str) -> std::collections::HashSet<String> {
    porcelain
        .lines()
        .filter_map(|line| line.trim().strip_prefix("branch refs/heads/"))
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .collect()
}

/// Branches currently checked out in ANY worktree, including the main one.
/// Deleting one of these is refused by git anyway; excluding them up front keeps
/// a live agent's branch out of the failure list entirely.
fn checked_out_branches(root: &std::path::Path) -> std::collections::HashSet<String> {
    parse_checked_out_branches(
        &git_read(root, &["worktree", "list", "--porcelain"]).unwrap_or_default(),
    )
}

/// Agent branches whose tip is reachable from `base` — git's own answer, via
/// `--merged`, in one call rather than a `merge-base` per branch.
fn agent_branches_merged_into(root: &std::path::Path, base: &str) -> Vec<String> {
    git_read_lines(
        root,
        &[
            "branch",
            "--merged",
            base,
            "--format=%(refname:short)",
            "--list",
            "spacron/*",
        ],
    )
}

/// Delete branches in chunks, returning the ones git confirms it deleted.
/// `force` selects `-D` over `-d`; see the two-phase note in the sweep.
fn delete_branches(root: &std::path::Path, branches: &[String], force: bool) -> Vec<String> {
    let mut deleted = Vec::new();
    // Chunked so a repo with hundreds of branches can't overflow the command
    // line length limit.
    for chunk in branches.chunks(50) {
        let mut args: Vec<&str> = vec!["branch", if force { "-D" } else { "-d" }];
        args.extend(chunk.iter().map(String::as_str));
        let Ok(out) = git_base()
            .args(&args)
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
        else {
            continue;
        };
        // Parsed from stdout rather than inferred from the exit code: a chunk
        // where one branch is refused still deletes the rest, and reports a
        // non-zero status for the whole call.
        deleted.extend(parse_deleted_branches(&String::from_utf8_lossy(&out.stdout)));
    }
    deleted
}

/// Branch names out of `git branch -d/-D` stdout, whose success line reads
/// `Deleted branch <name> (was <sha>).` — one per branch deleted.
fn parse_deleted_branches(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Deleted branch "))
        .filter_map(|rest| rest.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Delete agent branches that hold nothing the base branch does not already
/// have, and report the ones that do.
///
/// Three guards stand between this and a user's branch:
///
/// 1. **Prefix** — only `spacron/*` is even considered.
/// 2. **In use** — anything checked out in a worktree, or named in `skip` (the
///    frontend passes every branch a live session or task still claims), is left
///    alone.
/// 3. **Containment** — deletion requires git to have listed the branch under
///    `--merged`, which is precisely "its tip is reachable from the base".
///
/// Containment is tested against the checked-out branch first and, when that is
/// not the repo's main branch, against `main`/`master` as well — otherwise the
/// sweep would silently stop working the moment the user starts a feature
/// branch. Deletion is then two-phase: `-d` for everything (git's own safety
/// check, which agrees with our set whenever HEAD is the base), then `-D` for
/// the remainder, which is only ever the branches proven contained in the other
/// base — where `-d` refuses purely because it measures against HEAD.
///
/// `dry_run` fills `deleted` with what would go and touches nothing.
#[tauri::command(async)]
pub fn workspace_git_sweep_agent_branches(
    project_id: String,
    skip: Option<Vec<String>>,
    dry_run: Option<bool>,
    state: State<AppState>,
) -> Result<AgentBranchSweep, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    let _repo = lock_repo_write(root_path);
    sweep_agent_branches_at(root_path, &skip.unwrap_or_default(), dry_run.unwrap_or(false))
}

/// The sweep itself, against a repository path. Split from the command so it can
/// be exercised against a real temp repo without an `AppState`; the caller holds
/// the repo write lock.
fn sweep_agent_branches_at(
    root_path: &std::path::Path,
    skip: &[String],
    dry_run: bool,
) -> Result<AgentBranchSweep, String> {
    // The checked-out branch is the primary base: worktrees fork from HEAD, so
    // it is what agent branches were cut from. A detached HEAD leaves it unset
    // and the sweep falls back to main/master alone.
    let head = git_read(root_path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .filter(|h| !h.is_empty());

    let mut bases: Vec<String> = Vec::new();
    if let Some(h) = &head {
        bases.push(h.clone());
    }
    for candidate in ["main", "master"] {
        if bases.iter().any(|b| b == candidate) {
            continue;
        }
        // `--verify` keeps a missing branch from being reported as an error.
        if git_read(
            root_path,
            &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{candidate}")],
        )
        .is_some_and(|s| !s.is_empty())
        {
            bases.push(candidate.to_string());
        }
    }
    if bases.is_empty() {
        return Err("No branch to compare against — the repository has no commits yet.".to_string());
    }
    let primary = bases[0].clone();

    let mut protected = checked_out_branches(root_path);
    protected.extend(bases.iter().cloned());
    protected.extend(
        skip.iter()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty()),
    );

    // Contained per base, kept separate so phase two knows which branches were
    // proven safe by a base that is NOT HEAD.
    let contained_primary: Vec<String> = agent_branches_merged_into(root_path, &primary)
        .into_iter()
        .filter(|b| b.starts_with(AGENT_BRANCH_PREFIX) && !protected.contains(b))
        .collect();
    let mut contained: std::collections::HashSet<String> =
        contained_primary.iter().cloned().collect();
    for base in bases.iter().skip(1) {
        for b in agent_branches_merged_into(root_path, base) {
            if b.starts_with(AGENT_BRANCH_PREFIX) && !protected.contains(&b) {
                contained.insert(b);
            }
        }
    }

    let eligible: Vec<String> = {
        let mut v: Vec<String> = contained.iter().cloned().collect();
        v.sort();
        v
    };

    let mut deleted: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    if dry_run {
        deleted = eligible.clone();
    } else if !eligible.is_empty() {
        deleted = delete_branches(root_path, &eligible, false);
        let remaining: Vec<String> = eligible
            .iter()
            .filter(|b| !deleted.contains(b))
            .cloned()
            .collect();
        if !remaining.is_empty() {
            // Safe: every one of these came out of a `--merged` listing, so git
            // has already confirmed the base contains it. `-d` refused only
            // because it measures reachability from HEAD.
            deleted.extend(delete_branches(root_path, &remaining, true));
        }
        failed = eligible
            .iter()
            .filter(|b| !deleted.contains(b))
            .cloned()
            .collect();
    }

    // Everything else with the prefix holds commits the base does not.
    let all_agent_branches = git_read_lines(
        root_path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/spacron/"],
    );
    let holding: Vec<String> = all_agent_branches
        .into_iter()
        .filter(|b| !contained.contains(b) && !protected.contains(b))
        .collect();
    let detail = holding.len() <= RETAINED_DETAIL_LIMIT;

    let retained: Vec<RetainedAgentBranch> = holding
        .into_iter()
        .map(|branch| {
            if !detail {
                return RetainedAgentBranch {
                    branch,
                    unique_commits: 0,
                    last_commit: String::new(),
                    patch_equivalent: false,
                };
            }
            let range = format!("{primary}..{branch}");
            let unique_commits = git_read(root_path, &["rev-list", "--count", &range])
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            let last_commit =
                git_read(root_path, &["log", "-1", "--format=%cI", &branch]).unwrap_or_default();
            // Every unique commit marked `-` means git found an equivalent patch
            // already in the base.
            let cherry = git_read_lines(root_path, &["cherry", &primary, &branch]);
            let patch_equivalent =
                !cherry.is_empty() && cherry.iter().all(|l| l.starts_with('-'));
            RetainedAgentBranch {
                branch,
                unique_commits,
                last_commit,
                patch_equivalent,
            }
        })
        .collect();

    Ok(AgentBranchSweep {
        deleted,
        retained,
        failed,
        base: primary,
    })
}

/// Merge a worktree branch into the main checkout, then optionally clean up.
/// Runs `git merge` from the main project root (not the worktree), returns
/// success or a conflict/error message.
///
/// When `no_commit` is true (`--no-commit`), changes are staged in the main
/// checkout without creating a merge commit — the user can review them in
/// Source Control and commit themselves.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MergeWorktreeResult {
    pub success: bool,
    pub message: String,
    pub conflicted: bool,
}

#[tauri::command(async)]
pub fn workspace_git_merge_worktree(
    project_id: String,
    worktree_path: String,
    branch: String,
    delete_after: Option<bool>,
    no_commit: Option<bool>,
    state: State<AppState>,
) -> Result<MergeWorktreeResult, String> {
    check_git_available().map_err(|e| format!("Git not available: {e}"))?;

    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    if !is_valid_branch_name(&branch) {
        return Err("Invalid branch name".to_string());
    }

    // Verify the worktree path is in the managed worktree area.
    let cleaned = crate::commands::clean_path_buf(PathBuf::from(&worktree_path));
    let in_managed_area = is_under(&cleaned, &worktree_area(root_path))
        || legacy_worktree_area(root_path).is_some_and(|area| is_under(&cleaned, &area));
    if !in_managed_area {
        return Err("Refusing to merge a path outside the managed worktree area.".to_string());
    }

    let no_commit = no_commit.unwrap_or(false);

    let _repo = lock_repo_write(root_path);

    // Ensure we're on the base branch (the main checkout, not the worktree).
    // The merge happens from the main project root against the worktree branch.
    // With --no-commit the changes are staged without creating a merge commit,
    // letting the user review them in Source Control and commit manually.
    let merge_msg = format!("Merge worktree branch '{}'", branch);
    let mut merge_args: Vec<&str> = vec!["merge", "--no-ff"];
    if no_commit {
        merge_args.push("--no-commit");
    }
    merge_args.push(&branch);
    if !no_commit {
        merge_args.push("-m");
        merge_args.push(&merge_msg);
    }

    let output = git_base()
        .args(&merge_args)
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git merge: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        // Optionally clean up the worktree.
        // When `no_commit` is true, only clean up if explicitly requested (default off).
        let do_cleanup = if no_commit { delete_after.unwrap_or(false) } else { delete_after.unwrap_or(true) };
        if do_cleanup {
            let _ = git_base()
                .args(["worktree", "remove", "--force", &worktree_path])
                .current_dir(root_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();
            let _ = git_base()
                .args(["worktree", "prune"])
                .current_dir(root_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();
            // Also delete the branch since the worktree is gone.
            let _ = git_base()
                .args(["branch", "-D", &branch])
                .current_dir(root_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();
        }

        let msg = if stderr.contains("Already up to date") {
            "Already up to date — no new changes to merge.".to_string()
        } else if no_commit {
            format!("Changes from '{}' staged for review in Source Control — worktree kept for reference.", branch)
        } else if delete_after.unwrap_or(true) {
            format!("Branch '{}' merged and cleaned up successfully.", branch)
        } else {
            format!("Branch '{}' merged successfully.", branch)
        };

        Ok(MergeWorktreeResult {
            success: true,
            message: msg,
            conflicted: false,
        })
    } else {
        // Merge failed — check for conflicts
        let has_conflicts = stderr.contains("conflict") || stdout.contains("CONFLICT");
        if has_conflicts {
            Ok(MergeWorktreeResult {
                success: false,
                message: format!(
                    "Merge conflict — resolve conflicts in the main checkout, then commit.\n{} {}.",
                    sanitize_git_error(&stderr),
                    sanitize_git_error(&stdout)
                ),
                conflicted: true,
            })
        } else {
            Ok(MergeWorktreeResult {
                success: false,
                message: format!(
                    "Merge failed:\n{}{}",
                    sanitize_git_error(&stderr),
                    sanitize_git_error(&stdout)
                ),
                conflicted: false,
            })
        }
    }
}

/// Check whether a worktree has any changes relative to its base commit.
/// Checks both uncommitted working-tree changes and committed differences not
/// yet in the base branch. Used to decide whether to show a merge prompt.
#[tauri::command(async)]
pub fn workspace_git_worktree_has_changes(
    project_id: String,
    worktree_path: String,
    base_commit: String,
    branch: String,
    state: State<AppState>,
) -> Result<bool, String> {
    check_git_available()?;

    // Look up the project root so we can compare from the main checkout.
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    if !is_valid_branch_name(&branch) {
        return Err("Invalid branch name".to_string());
    }

    // Only inspect worktrees we manage, matching the guard on
    // `workspace_git_merge_worktree` — this runs git in the given directory.
    let cleaned = crate::commands::clean_path_buf(PathBuf::from(&worktree_path));
    let in_managed_area = is_under(&cleaned, &worktree_area(root_path))
        || legacy_worktree_area(root_path).is_some_and(|area| is_under(&cleaned, &area));
    if !in_managed_area {
        return Err("Refusing to inspect a path outside the managed worktree area.".to_string());
    }

    // 1. Check for uncommitted changes inside the worktree checkout.
    let porcelain = git_capture(&cleaned, &["status", "--porcelain"]).unwrap_or_default();
    let has_uncommitted = porcelain.lines().any(|l| !l.trim().is_empty());
    if has_uncommitted {
        return Ok(true);
    }

    // 2. Check for committed changes NOT in the base commit.
    //    `git rev-list --count <base_commit>..<branch>` returns the number of
    //    commits reachable from <branch> but not from <base_commit>. The range
    //    MUST be a single argv entry — passing "<base>", "..", "<branch>" makes
    //    git treat `..` as the end of revisions and the rest as a pathspec, which
    //    always fails with "no such path in the working tree".
    let range = format!("{}..{}", base_commit, branch);
    match git_capture(root_path, &["rev-list", "--count", &range]) {
        // A genuine count: 0 really means "nothing new on the branch".
        Some(out) => Ok(out.trim().parse::<i64>().map(|n| n > 0).unwrap_or(true)),
        // git failed — assume there may be changes rather than silently hiding
        // the agent's work behind a "nothing to review" result.
        None => Ok(true),
    }
}

/// Live status for an agent worktree: number of changed files (staged, unstaged,
/// and untracked) plus the current branch. Used to surface review-readiness.
#[tauri::command(async)]
pub fn workspace_git_worktree_status(
    worktree_path: String,
    state: State<AppState>,
) -> Result<WorktreeStatus, String> {
    // Confine to the managed worktree area of an open project. Worktrees are
    // created at <project>/.spacron/worktrees/<branch> (see
    // workspace_git_create_worktree), so a legitimate status query always sits
    // under some open project's area. Without this the command would run git in
    // any attacker-named path and leak whether it is a repo and its branch.
    let path = crate::commands::clean_path_buf(PathBuf::from(&worktree_path));
    let canonical = std::fs::canonicalize(&path)
        .map(crate::commands::clean_path_buf)
        .map_err(|_| "Not a git worktree.".to_string())?;
    let in_managed_area = state.workspace_manager.list_projects().iter().any(|p| {
        [Some(worktree_area(&p.root_path)), legacy_worktree_area(&p.root_path)]
            .into_iter()
            .flatten()
            .filter_map(|area| std::fs::canonicalize(area).ok())
            .map(crate::commands::clean_path_buf)
            .any(|area| is_under(&canonical, &area))
    });
    if !in_managed_area {
        return Err("Refusing to inspect a path outside the managed worktree area.".to_string());
    }
    if !canonical.join(".git").exists() {
        return Err("Not a git worktree.".to_string());
    }

    let porcelain = git_capture(&canonical, &["status", "--porcelain"]).unwrap_or_default();
    let changed_files = porcelain.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    let branch = git_capture(&canonical, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| "HEAD".to_string());

    Ok(WorktreeStatus {
        changed_files,
        branch,
    })
}

/// A commit-ish we are about to interpolate into a git revision range. Rejecting
/// anything but a hex object name keeps a persisted-state value from ever being
/// read as a git flag or a pathspec.
fn is_valid_commit_ish(rev: &str) -> bool {
    let rev = rev.trim();
    (4..=64).contains(&rev.len()) && rev.chars().all(|c| c.is_ascii_hexdigit())
}

/// What an agent worktree is holding that the main checkout has not seen yet.
/// Cheap enough to poll: three `git` reads, no writes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorktreeDelta {
    /// Current tip of the worktree branch.
    pub head: String,
    /// Uncommitted files inside the worktree (the agent is mid-work, or never
    /// committed). These are invisible to a commit-range diff until snapshotted.
    pub dirty_files: u32,
    /// Files changed by commits after `since_commit` — work the agent committed
    /// but that has not been staged into the main checkout yet.
    pub committed_files: u32,
    /// True when `since_commit` is already the branch tip and nothing is dirty,
    /// i.e. the main checkout has everything this worktree holds.
    pub up_to_date: bool,
}

/// Report what an agent worktree holds beyond `since_commit`.
///
/// This is the reconciler's signal, and it deliberately asks git rather than
/// trusting app state: it stays correct across finished turns, cleared threads,
/// restarts, and agents that keep working after their turn was marked done.
#[tauri::command(async)]
pub fn workspace_git_worktree_delta(
    project_id: String,
    worktree_path: String,
    branch: String,
    since_commit: String,
    state: State<AppState>,
) -> Result<WorktreeDelta, String> {
    check_git_available().map_err(|e| format!("Git not available: {e}"))?;

    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    if !is_valid_branch_name(&branch) {
        return Err("Invalid branch name".to_string());
    }
    if !is_valid_commit_ish(&since_commit) {
        return Err("Invalid commit".to_string());
    }

    let cleaned = crate::commands::clean_path_buf(PathBuf::from(&worktree_path));
    let in_managed_area = is_under(&cleaned, &worktree_area(root_path))
        || legacy_worktree_area(root_path).is_some_and(|area| is_under(&cleaned, &area));
    if !in_managed_area {
        return Err("Refusing to inspect a path outside the managed worktree area.".to_string());
    }
    if !cleaned.join(".git").exists() {
        return Err("Not a git worktree.".to_string());
    }

    let head = git_capture(&cleaned, &["rev-parse", "HEAD"])
        .ok_or_else(|| "Could not resolve the worktree's HEAD.".to_string())?;

    let dirty_files = git_capture(&cleaned, &["status", "--porcelain"])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count() as u32;

    // Range must be ONE argv entry — a bare ".." makes git read the rest as a
    // pathspec and the command fails. See the note on worktree_has_changes.
    let range = format!("{}..{}", since_commit.trim(), branch);
    let committed_files = git_capture(root_path, &["diff", "--name-only", &range])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count() as u32;

    Ok(WorktreeDelta {
        up_to_date: dirty_files == 0 && committed_files == 0,
        head,
        dirty_files,
        committed_files,
    })
}

/// Outcome of staging an agent worktree's delta into the main checkout.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StageWorktreeResult {
    pub success: bool,
    pub message: String,
    pub conflicted: bool,
    /// Files left with conflict markers in the main checkout — the only case that
    /// genuinely needs a human.
    pub conflicted_files: Vec<String>,
    /// Branch tip this stage covered. The caller persists it as the worktree's new
    /// `lastStagedCommit`, so the next stage moves only what arrives after it, and
    /// so cleanup can tell "fully staged" from "still holding unstaged work".
    pub staged_commit: String,
    pub staged_files: u32,
    /// True when there was nothing new to move.
    pub up_to_date: bool,
}

/// Stage an agent worktree's changes into the main checkout so they can be tested,
/// reviewed in Source Control, and committed by hand.
///
/// Two deliberate differences from `workspace_git_merge_worktree`:
///
/// 1. **It snapshots first.** Uncommitted edits in the worktree are invisible to
///    any commit-range diff, so they can neither be staged nor survive the
///    checkout being removed. Committing them to the agent's own throwaway branch
///    makes every piece of work representable as a commit range — that is what
///    makes "nothing is lost" true rather than aspirational.
///
/// 2. **It applies a patch instead of merging.** `git merge --no-commit` leaves
///    MERGE_HEAD behind, and git then refuses every later merge with "You have not
///    concluded your merge" until the user commits. That makes merge-based staging
///    a strictly one-shot operation per commit — fatal for repeated turns and for
///    several agents feeding one checkout. Applying `since_commit..HEAD` with
///    `git apply --3way --index` enters no merge state, so stages compose freely,
///    and a conflict is confined to the files it actually touches instead of
///    blocking the whole checkout.
///
/// The trade-off is that the branch is not recorded as merged. That costs nothing
/// here: the user writes the real commit in Source Control, and worktree cleanup
/// already force-deletes the branch.
#[tauri::command(async)]
pub fn workspace_git_stage_worktree(
    project_id: String,
    worktree_path: String,
    branch: String,
    since_commit: String,
    snapshot: Option<bool>,
    state: State<AppState>,
) -> Result<StageWorktreeResult, String> {
    check_git_available().map_err(|e| format!("Git not available: {e}"))?;

    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    if !is_valid_branch_name(&branch) {
        return Err("Invalid branch name".to_string());
    }
    if !is_valid_commit_ish(&since_commit) {
        return Err("Invalid commit".to_string());
    }

    let cleaned = crate::commands::clean_path_buf(PathBuf::from(&worktree_path));
    let in_managed_area = is_under(&cleaned, &worktree_area(root_path))
        || legacy_worktree_area(root_path).is_some_and(|area| is_under(&cleaned, &area));
    if !in_managed_area {
        return Err("Refusing to stage a path outside the managed worktree area.".to_string());
    }
    if !cleaned.join(".git").exists() {
        return Err("Not a git worktree.".to_string());
    }

    // 1. Snapshot uncommitted work onto the agent's own branch.
    if snapshot.unwrap_or(true) {
        let dirty = git_capture(&cleaned, &["status", "--porcelain"])
            .unwrap_or_default()
            .lines()
            .any(|l| !l.trim().is_empty());
        if dirty {
            let _ = git_base()
                .args(["add", "-A"])
                .current_dir(&cleaned)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();

            // A repo with no configured identity would fail to commit; supply one
            // only in that case so a real identity is never overridden.
            let mut commit: Vec<String> = Vec::new();
            if git_capture(&cleaned, &["config", "user.email"]).is_none() {
                commit.extend([
                    "-c".into(),
                    "user.name=Spacron".into(),
                    "-c".into(),
                    "user.email=agent@spacron.local".into(),
                ]);
            }
            // `--no-verify`: this is an automated snapshot on a throwaway branch that
            // can fire many times per session, not a commit the user authored. Running
            // their pre-commit hooks on each one would be both slow and surprising.
            // The commit the user actually keeps is written in Source Control, where
            // hooks run normally.
            commit.extend([
                "commit".into(),
                "--no-verify".into(),
                "-m".into(),
                "spacron: snapshot uncommitted agent work".into(),
            ]);
            let _ = git_base()
                .args(&commit)
                .current_dir(&cleaned)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();
        }
    }

    let head = git_capture(&cleaned, &["rev-parse", "HEAD"])
        .ok_or_else(|| "Could not resolve the worktree's HEAD.".to_string())?;

    // Everything from here touches the *main* checkout's index (step 1 above only
    // wrote the worktree's own). Taking the lock now — not earlier — keeps the
    // snapshot, which is the slow part, off the critical section, while still
    // guaranteeing the diff and the `apply --index` see the same index the user's
    // commit isn't halfway through rewriting.
    let _repo = lock_repo_write(root_path);

    // 2. Diff the delta. `--binary` keeps non-text files applyable, `--no-renames`
    //    emits plain add/delete pairs, which apply far more reliably than rename
    //    hunks. Run from the main checkout so both endpoints resolve there.
    let range = format!("{}..{}", since_commit.trim(), head);
    let diff = git_base()
        .args(["diff", "--binary", "--no-renames", &range])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    if !diff.status.success() {
        return Err(format!(
            "Could not read the worktree's changes: {}",
            sanitize_git_error(&String::from_utf8_lossy(&diff.stderr))
        ));
    }

    if diff.stdout.is_empty() {
        return Ok(StageWorktreeResult {
            success: true,
            message: "Already up to date — nothing new to stage.".to_string(),
            conflicted: false,
            conflicted_files: Vec::new(),
            staged_commit: head,
            staged_files: 0,
            up_to_date: true,
        });
    }

    let staged_files = git_capture(root_path, &["diff", "--name-only", &range])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count() as u32;

    // 3. Apply into the main checkout's index and working tree. `--3way` falls back
    //    to a real merge per hunk, so the user's own edits are respected instead of
    //    the patch being rejected wholesale.
    let mut child = git_base()
        .args(["apply", "--3way", "--index"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run git apply: {}", e))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| "Could not write the patch to git apply.".to_string())?
        .write_all(&diff.stdout)
        .map_err(|e| format!("Failed to write patch: {}", e))?;
    drop(child.stdin.take());

    let applied = child
        .wait_with_output()
        .map_err(|e| format!("Failed to run git apply: {}", e))?;

    let stdout = String::from_utf8_lossy(&applied.stdout).to_string();
    let stderr = String::from_utf8_lossy(&applied.stderr).to_string();

    if applied.status.success() {
        return Ok(StageWorktreeResult {
            success: true,
            message: format!("Staged {} file(s) from '{}' for review.", staged_files, branch),
            conflicted: false,
            conflicted_files: Vec::new(),
            staged_commit: head,
            staged_files,
            up_to_date: false,
        });
    }

    // A 3-way apply that hit conflicts still writes the conflicting files with
    // markers and stages everything else, so the work is present, not lost — it
    // just needs a human. Report which files, and do NOT advance the caller's
    // staged marker: the delta is not cleanly represented in the main checkout yet.
    let conflicted_files: Vec<String> = git_capture(root_path, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let looks_conflicted = !conflicted_files.is_empty()
        || stdout.contains("with conflicts")
        || stderr.contains("with conflicts")
        || stderr.contains("conflict");

    if looks_conflicted {
        Ok(StageWorktreeResult {
            success: false,
            message: format!(
                "Changes from '{}' overlap edits already in your working tree. The conflicting files are marked for you to resolve; everything else was staged.",
                branch
            ),
            conflicted: true,
            conflicted_files,
            staged_commit: head,
            staged_files,
            up_to_date: false,
        })
    } else if let Some(blocked) = index_mismatch_paths(&stderr) {
        // `git apply --index` requires each patched path's working-tree copy to
        // match the index, so the user's own *uncommitted* edit to a file the agent
        // also touched aborts the whole patch — nothing is applied, not even the
        // unrelated files. Same for an untracked file sitting where the agent
        // created one. Neither is a merge conflict (no markers, no `U` entries), so
        // it lands here, and neither clears on its own: the fix is the user's to
        // make. Say which paths and what to do, rather than surfacing raw git.
        Ok(StageWorktreeResult {
            success: false,
            message: format!(
                "Your own uncommitted changes to {} block bringing in '{}'. Commit, stash or discard them in Source Control, then bring the agent's work in again — nothing was lost, it is still on the branch.",
                blocked.join(", "),
                branch
            ),
            conflicted: false,
            conflicted_files,
            staged_commit: head,
            staged_files,
            up_to_date: false,
        })
    } else {
        Ok(StageWorktreeResult {
            success: false,
            message: format!(
                "Could not stage changes from '{}': {}{}",
                branch,
                sanitize_git_error(&stderr),
                sanitize_git_error(&stdout)
            ),
            conflicted: false,
            conflicted_files,
            staged_commit: head,
            staged_files,
            up_to_date: false,
        })
    }
}

/// Paths `git apply --index` refused because the working tree disagrees with the
/// index there. Returns `None` when the failure was something else.
///
/// git emits one line per path:
///   `error: <path>: does not match index`     — user has an uncommitted edit
///   `error: <path>: does not exist in index`  — untracked file in the way
fn index_mismatch_paths(stderr: &str) -> Option<Vec<String>> {
    let paths: Vec<String> = stderr
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("error: ")?;
            let path = rest
                .strip_suffix(": does not match index")
                .or_else(|| rest.strip_suffix(": does not exist in index"))?;
            (!path.is_empty()).then(|| path.to_string())
        })
        .collect();
    let mut paths: Vec<String> = paths;
    paths.dedup();
    (!paths.is_empty()).then_some(paths)
}

#[tauri::command(async)]
pub fn workspace_git_diff(
    project_id: String,
    file_path: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    if let Some(ref path) = file_path {
        if !path.trim().is_empty() {
            validate_relative_path(path)?;
            // First check if the file is tracked in git.
            let is_tracked = git_base()
                .args(["ls-files", "--error-unmatch", "--", path])
                .current_dir(root_path)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if !is_tracked {
                // Read the file and format as a diff where every line is an addition
                let absolute_path = root_path.join(path);
                // Verify path stays within project root before reading
                if let Ok(canonical) = std::fs::canonicalize(&absolute_path) {
                    let canonical = crate::commands::clean_path_buf(canonical);
                    if !canonical.starts_with(root_path) {
                        return Err("Access denied: path is outside project root".to_string());
                    }
                }
                if absolute_path.exists() {
                    match std::fs::read_to_string(&absolute_path) {
                        Ok(content) => {
                            let mut diff = format!(
                                "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n",
                                path,
                                content.lines().count()
                            );
                            for line in content.lines() {
                                diff.push('+');
                                diff.push_str(line);
                                diff.push('\n');
                            }
                            return Ok(diff);
                        }
                        Err(e) => return Err(format!("Failed to read untracked file: {}", e)),
                    }
                }
            }

            // Otherwise, get git diff for this specific file
            let output = git_base()
                .args(["diff", "HEAD", "--", path])
                .current_dir(root_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .map_err(|e| format!("Failed to run git diff: {}", e))?;

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            if output.status.success() {
                return Ok(stdout);
            } else {
                return Err(format!(
                    "Git diff failed:\n{}{}",
                    sanitize_git_error(&stderr),
                    sanitize_git_error(&stdout)
                ));
            }
        }
    }

    // Default: get full repo git diff
    let output = git_base()
        .args(["diff", "HEAD"])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!(
            "Git diff failed:\n{}{}",
            sanitize_git_error(&stderr),
            sanitize_git_error(&stdout)
        ))
    }
}

/// Resolve a merge conflict in `file_path` by collapsing each conflict block to
/// a single side. `resolution` is "ours", "theirs", or "both". The file is
/// rewritten and staged with `git add` so Git treats the conflict as handled.
#[tauri::command(async)]
pub fn workspace_resolve_conflict(
    project_id: String,
    file_path: String,
    resolution: String,
    state: State<AppState>,
) -> Result<(), String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    validate_relative_path(&file_path)?;

    let absolute_path = root_path.join(&file_path);
    if let Ok(canonical) = std::fs::canonicalize(&absolute_path) {
        let canonical = crate::commands::clean_path_buf(canonical);
        if !canonical.starts_with(root_path) {
            return Err("Access denied: path is outside project root".to_string());
        }
    }

    let content = std::fs::read_to_string(&absolute_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let resolved = resolve_conflict_markers(&content, &resolution)?;

    std::fs::write(&absolute_path, resolved)
        .map_err(|e| format!("Failed to write resolved file: {}", e))?;

    let _repo = lock_repo_write(root_path);

    let output = git_base()
        .args(["add", "--", &file_path])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to stage resolved file: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("git add failed:\n{}", sanitize_git_error(&stderr)));
    }

    Ok(())
}

/// Collapse Git conflict blocks (`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`)
/// to a single side. Errors when no markers are present so the caller can tell
/// the user there was nothing to resolve.
fn resolve_conflict_markers(content: &str, resolution: &str) -> Result<String, String> {
    #[derive(PartialEq)]
    enum Section {
        None,
        Ours,
        Base,
        Theirs,
    }

    let mut out: Vec<&str> = Vec::new();
    let mut ours: Vec<&str> = Vec::new();
    let mut theirs: Vec<&str> = Vec::new();
    let mut section = Section::None;
    let mut found = false;

    for line in content.lines() {
        if line.starts_with("<<<<<<<") {
            found = true;
            section = Section::Ours;
            ours.clear();
            theirs.clear();
        } else if line.starts_with("|||||||") && section != Section::None {
            section = Section::Base;
        } else if line.starts_with("=======") && section != Section::None {
            section = Section::Theirs;
        } else if line.starts_with(">>>>>>>") && section != Section::None {
            match resolution {
                "ours" => out.extend(ours.iter().copied()),
                "theirs" => out.extend(theirs.iter().copied()),
                "both" => {
                    out.extend(ours.iter().copied());
                    out.extend(theirs.iter().copied());
                }
                other => return Err(format!("Unknown resolution '{}'", other)),
            }
            section = Section::None;
        } else {
            match section {
                Section::None => out.push(line),
                Section::Ours => ours.push(line),
                Section::Base => { /* base side is discarded */ }
                Section::Theirs => theirs.push(line),
            }
        }
    }

    if !found {
        return Err("No conflict markers found in this file.".to_string());
    }

    let mut result = out.join("\n");
    if content.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GitLogEntry {
    pub graph: String,
    pub hash: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    pub refs: Option<String>,
    pub subject: Option<String>,
}

#[tauri::command(async)]
pub fn workspace_git_log(
    project_id: String,
    state: State<AppState>,
) -> Result<Vec<GitLogEntry>, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    let root_path = &project.root_path;

    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    let output = git_base()
        .args([
            "log",
            "--graph",
            "--pretty=format:__DELIM__%h__DELIM__%an__DELIM__%ad (%ar)__DELIM__%d__DELIM__%s",
            "--date=format:%Y-%m-%d %H:%M",
            "--abbrev-commit",
            "-n",
            "50",
        ])
        .current_dir(root_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for line in stdout.lines() {
        if let Some(idx) = line.find("__DELIM__") {
            let (graph, rest) = line.split_at(idx);
            let rest_clean = &rest[9..]; // "__DELIM__" is 9 chars
            let parts: Vec<&str> = rest_clean.split("__DELIM__").collect();

            let hash = parts.first().map(|s| s.to_string());
            let author = parts.get(1).map(|s| s.to_string());
            let date = parts.get(2).map(|s| s.to_string());
            let refs = parts.get(3).map(|s| {
                let trimmed = s.trim();
                if trimmed.starts_with('(') && trimmed.ends_with(')') {
                    trimmed[1..trimmed.len() - 1].to_string()
                } else {
                    trimmed.to_string()
                }
            });
            let subject = parts.get(4).map(|s| s.to_string());

            entries.push(GitLogEntry {
                graph: graph.to_string(),
                hash,
                author,
                date,
                refs: if refs.as_ref().is_none_or(|r| r.is_empty()) {
                    None
                } else {
                    refs
                },
                subject,
            });
        } else {
            entries.push(GitLogEntry {
                graph: line.to_string(),
                hash: None,
                author: None,
                date: None,
                refs: None,
                subject: None,
            });
        }
    }

    Ok(entries)
}

fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.starts_with('-') {
        return Err("Invalid branch name".to_string());
    }
    if name.contains("..") {
        return Err("Invalid branch name".to_string());
    }
    // Only allow safe characters
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || "-_./".contains(c))
    {
        return Err("Branch name contains invalid characters".to_string());
    }
    Ok(())
}

fn get_project_path(project_id: &str, state: &AppState) -> Result<std::path::PathBuf, String> {
    let projects = state.workspace_manager.list_projects();
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    Ok(project.root_path.clone())
}

#[derive(serde::Serialize)]
pub struct GitBranchInfo {
    pub current: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
    /// Tracking branch (e.g. "origin/main"), or None if the current branch isn't
    /// published / has no upstream configured.
    pub upstream: Option<String>,
    /// Local commits not yet on the upstream (i.e. waiting to be pushed).
    pub ahead: usize,
    /// Upstream commits not yet pulled into the local branch.
    pub behind: usize,
    /// Whether any remote is configured at all.
    pub has_remote: bool,
}

/// Parse git's `%(upstream:track)` field into `(ahead, behind)`.
///
/// The field is a human-readable bracketed summary — `[ahead 2]`, `[behind 1]`,
/// `[ahead 2, behind 1]`, `[gone]`, or empty — so anything unrecognised yields
/// zeros rather than an error; a bad count must not fail the whole branch list.
fn parse_upstream_track(track: &str) -> (usize, usize) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    let (mut ahead, mut behind) = (0usize, 0usize);
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(count) = part.strip_prefix("ahead ") {
            ahead = count.trim().parse().unwrap_or(0);
        } else if let Some(count) = part.strip_prefix("behind ") {
            behind = count.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

#[tauri::command(async)]
pub fn workspace_git_branches(
    project_id: String,
    state: State<AppState>,
) -> Result<GitBranchInfo, String> {
    let root_path = get_project_path(&project_id, &state)?;
    if !root_path.join(".git").exists() {
        return Err("Not a git repository".to_string());
    }
    // One `for-each-ref` yields the branch lists *and* the current branch's
    // upstream and ahead/behind counts. This used to be four separate git
    // processes (branch -a, remote, rev-parse @{u}, rev-list) — ~1 s on a large
    // repo, and the Source Control panel calls it on every refresh.
    let output = git_base()
        .args([
            "for-each-ref",
            "--format=%(refname)|||%(refname:short)|||%(HEAD)|||%(upstream:short)|||%(upstream:track)",
            "refs/heads",
            "refs/remotes",
        ])
        .current_dir(&root_path)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current = String::new();
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let mut upstream: Option<String> = None;
    let (mut ahead, mut behind) = (0usize, 0usize);
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split("|||").collect();
        if parts.len() < 5 {
            continue;
        }
        // The full refname is what distinguishes a local branch from a
        // remote-tracking one; the short form alone is ambiguous (a local
        // branch may legitimately be named "origin/thing").
        let is_remote = parts[0].trim().starts_with("refs/remotes/");
        let name = parts[1].trim().to_string();
        let is_head = parts[2].trim() == "*";
        if is_remote {
            // refs/remotes entries are already short ("origin/main"); drop the
            // origin/HEAD symref, which is not a branch anyone can check out.
            if !name.contains("/HEAD") {
                remote.push(name);
            }
            continue;
        }
        if is_head {
            current = name.clone();
            // `%(upstream:track)` is "[ahead 2, behind 1]", "[gone]", or empty.
            // "[gone]" means the remote branch was deleted; report no upstream,
            // matching what `rev-parse @{u}` used to do (it fails outright), so
            // the panel still offers to publish the branch.
            let track = parts[4].trim();
            let up = parts[3].trim();
            if !up.is_empty() && track != "[gone]" {
                upstream = Some(up.to_string());
                let (a, b) = parse_upstream_track(track);
                ahead = a;
                behind = b;
            }
        }
        local.push(name);
    }

    // A detached HEAD marks no ref, so nothing above set `current`.
    if current.is_empty() {
        current = git_capture(&root_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_else(|| "HEAD".to_string());
    }

    // Kept as its own call: a remote can be configured with nothing fetched yet,
    // so the presence of refs/remotes entries is not a substitute.
    let has_remote = git_capture(&root_path, &["remote"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    Ok(GitBranchInfo {
        current,
        local,
        remote,
        upstream,
        ahead,
        behind,
        has_remote,
    })
}

#[tauri::command(async)]
pub fn workspace_git_checkout(
    project_id: String,
    branch: String,
    state: State<AppState>,
) -> Result<String, String> {
    validate_branch_name(&branch)?;
    let root_path = get_project_path(&project_id, &state)?;
    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    let _repo = lock_repo_write(&root_path);
    let output = git_base()
        .args(["switch", &branch])
        .current_dir(&root_path)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(format!("Switched to branch '{}'", branch))
    } else {
        Err(sanitize_git_error(&String::from_utf8_lossy(&output.stderr)))
    }
}

#[tauri::command(async)]
pub fn workspace_git_branch_create(
    project_id: String,
    name: String,
    from: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    validate_branch_name(&name)?;
    if let Some(ref f) = from {
        validate_branch_name(f)?;
    }
    let root_path = get_project_path(&project_id, &state)?;
    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    let mut args = vec!["checkout", "-b", &name];
    if let Some(ref f) = from {
        args.push(f);
    }
    let output = git_base()
        .args(&args)
        .current_dir(&root_path)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(format!("Created and switched to branch '{}'", name))
    } else {
        Err(sanitize_git_error(&String::from_utf8_lossy(&output.stderr)))
    }
}

#[tauri::command(async)]
pub fn workspace_git_branch_delete(
    project_id: String,
    name: String,
    force: bool,
    state: State<AppState>,
) -> Result<String, String> {
    validate_branch_name(&name)?;
    let root_path = get_project_path(&project_id, &state)?;
    if !root_path.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    let flag = if force { "-D" } else { "-d" };
    let output = git_base()
        .args(["branch", flag, &name])
        .current_dir(&root_path)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(format!("Deleted branch '{}'", name))
    } else {
        Err(sanitize_git_error(&String::from_utf8_lossy(&output.stderr)))
    }
}

// ─── Explicit-path staging (§7) ──────────────────────────────────────────────
//
// Spacron runs several agents against one shared working tree, so `git add -A`
// is not a curation nicety here — it sweeps another agent's in-flight edits, and
// any file the user was midway through, into your commit. Everything below
// stages by explicit path or by explicit patch. Nothing in this section ever
// runs a blanket add.

/// Resolve the repository a source-control command should act on.
///
/// `repo_path` lets the caller target an agent's worktree instead of the open
/// project — the Fleet Dashboard reviews worktrees through this same diff and
/// staging surface. It is accepted **only** when it names a checkout inside a
/// known project's managed worktree area, so a stray path cannot turn these
/// commands into an arbitrary-repository write primitive.
fn resolve_repo(
    project_id: &str,
    repo_path: Option<&str>,
    state: &AppState,
) -> Result<PathBuf, String> {
    let root_path = get_project_path(project_id, state)?;
    let Some(raw) = repo_path.map(str::trim).filter(|p| !p.is_empty()) else {
        if !root_path.join(".git").exists() {
            return Err("This project is not a Git repository.".to_string());
        }
        return Ok(root_path);
    };

    let candidate = std::fs::canonicalize(PathBuf::from(raw))
        .map(crate::commands::clean_path_buf)
        .map_err(|_| "That repository path does not exist.".to_string())?;

    if candidate == root_path {
        return Ok(candidate);
    }
    let allowed = is_under(&candidate, &worktree_area(&root_path))
        || legacy_worktree_area(&root_path)
            .is_some_and(|area| is_under(&candidate, &area));
    if !allowed {
        return Err("That path is not a worktree of this project.".to_string());
    }
    // A linked worktree has a `.git` *file*, not a directory.
    if !candidate.join(".git").exists() {
        return Err("That path is not a Git worktree.".to_string());
    }
    Ok(candidate)
}

/// Validate a batch of repo-relative paths destined for a git argv.
fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No files selected.".to_string());
    }
    for path in paths {
        if path.trim().is_empty() {
            return Err("A selected file path is empty.".to_string());
        }
        validate_relative_path(path)?;
    }
    Ok(())
}

fn run_git(root: &std::path::Path, args: &[&str], what: &str) -> Result<String, String> {
    let output = git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to {what}: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Failed to {what}: {}{}",
            sanitize_git_error(&stderr),
            sanitize_git_error(&stdout)
        ))
    }
}

fn stage_paths_at(root: &std::path::Path, paths: &[String]) -> Result<(), String> {
    let _repo = lock_repo_write(root);
    // `-A` **scoped to the listed paths** so deletions and newly-tracked files
    // inside the selection are recorded. `--` stops a path beginning with `-`
    // from being read as a flag.
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(root, &args, "stage the selected files").map(|_| ())
}

/// Stage exactly these paths. Replaces the blanket `git add -A`.
#[tauri::command(async)]
pub fn workspace_git_stage_paths(
    project_id: String,
    paths: Vec<String>,
    repo_path: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    check_git_available()?;
    validate_paths(&paths)?;
    let root = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    stage_paths_at(&root, &paths)
}

fn unstage_paths_at(root: &std::path::Path, paths: &[String]) -> Result<(), String> {
    let _repo = lock_repo_write(root);
    // `git reset -- <paths>` fails on a repo with no commits yet (no HEAD to
    // reset to); `rm --cached` is the equivalent there.
    let has_head = git_capture(root, &["rev-parse", "--verify", "HEAD"]).is_some();
    if has_head {
        let mut args: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
        args.extend(paths.iter().map(String::as_str));
        run_git(root, &args, "unstage the selected files").map(|_| ())
    } else {
        let mut args: Vec<&str> = vec!["rm", "--cached", "-q", "-r", "--"];
        args.extend(paths.iter().map(String::as_str));
        run_git(root, &args, "unstage the selected files").map(|_| ())
    }
}

/// Remove exactly these paths from the index, leaving the working tree alone.
#[tauri::command(async)]
pub fn workspace_git_unstage_paths(
    project_id: String,
    paths: Vec<String>,
    repo_path: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    check_git_available()?;
    validate_paths(&paths)?;
    let root = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    unstage_paths_at(&root, &paths)
}

fn apply_patch_at(root: &std::path::Path, patch: &str, reverse: bool) -> Result<(), String> {
    let _repo = lock_repo_write(root);

    let mut args: Vec<&str> = vec!["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"];
    if reverse {
        args.push("--reverse");
    }
    args.push("-");

    let mut child = git_base()
        .args(&args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run git apply: {e}"))?;

    {
        use std::io::Write;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "git apply refused its stdin".to_string())?;
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("Failed to send the patch to git: {e}"))?;
        // Dropping stdin closes the pipe; git blocks forever without this.
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("git apply did not finish: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "Could not {} that change: {}",
        if reverse { "unstage" } else { "stage" },
        sanitize_git_error(&stderr)
    ))
}

/// Apply a patch to the index only — the mechanism behind hunk and line staging.
///
/// `reverse` un-applies it, which is how unstaging a hunk works: the patch comes
/// from `git diff --cached` and is reversed back out of the index.
#[tauri::command(async)]
pub fn workspace_git_apply_patch(
    project_id: String,
    patch: String,
    reverse: bool,
    repo_path: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    check_git_available()?;
    if patch.trim().is_empty() {
        return Err("Nothing to apply.".to_string());
    }
    let root = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    apply_patch_at(&root, &patch, reverse)
}

fn commit_staged_at(root: &std::path::Path, message: &str, amend: bool) -> Result<String, String> {
    let _repo = lock_repo_write(root);

    if amend && git_capture(root, &["rev-parse", "--verify", "HEAD"]).is_none() {
        return Err("There is no commit to amend yet.".to_string());
    }

    // Refuse an empty commit explicitly rather than letting git's own message
    // ("nothing to commit, working tree clean") imply the user's changes vanished.
    if !amend {
        let staged = git_base()
            .args(["diff", "--cached", "--quiet"])
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .map_err(|e| format!("Failed to inspect the index: {e}"))?;
        if staged.success() {
            return Err("Nothing is staged. Stage a file or a hunk first.".to_string());
        }
    }

    let mut args: Vec<&str> = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    run_git(root, &args, "commit")
}

/// Commit whatever is in the index. No implicit add — the caller decides what
/// is staged, which is the whole point of the staged/unstaged split.
#[tauri::command(async)]
pub fn workspace_git_commit_staged(
    project_id: String,
    message: String,
    amend: bool,
    repo_path: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    check_git_available()?;
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    if message.len() > 10_000 {
        return Err("Commit message is too long (limit 10 000 characters)".to_string());
    }
    if message.contains('\0') {
        return Err("Commit message contains invalid characters.".to_string());
    }
    let root = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    commit_staged_at(&root, &message, amend)
}

/// The staged (HEAD→index) and unstaged (index→worktree) diffs for one file, or
/// for the whole repo when `file_path` is omitted.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GitSplitDiff {
    pub staged: String,
    pub unstaged: String,
    /// True when the file is untracked, so `unstaged` was synthesised rather
    /// than produced by git — it cannot be hunk-staged, only added whole.
    pub untracked: bool,
}

fn diff_split_at(
    root: &std::path::Path,
    file_path: Option<String>,
    base_ref: Option<&str>,
) -> Result<GitSplitDiff, String> {
    let path = file_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(ref p) = path {
        validate_relative_path(p)?;
    }

    let mut untracked = false;
    if let Some(ref p) = path {
        let tracked = git_base()
            .args(["ls-files", "--error-unmatch", "--", p])
            .current_dir(root)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !tracked {
            // Not in the index and not in HEAD: everything about it is new, and
            // there is no old side for git to diff against.
            untracked = true;
            let absolute = root.join(p);
            if let Ok(canonical) = std::fs::canonicalize(&absolute) {
                if !is_under(&crate::commands::clean_path_buf(canonical), root) {
                    return Err("Access denied: path is outside the repository".to_string());
                }
            }
            let content = std::fs::read_to_string(&absolute).unwrap_or_default();
            let count = content.lines().count();
            let mut diff = format!(
                "diff --git a/{p} b/{p}\n--- /dev/null\n+++ b/{p}\n@@ -0,0 +1,{count} @@\n"
            );
            for line in content.lines() {
                diff.push('+');
                diff.push_str(line);
                diff.push('\n');
            }
            return Ok(GitSplitDiff {
                staged: String::new(),
                unstaged: if count == 0 { String::new() } else { diff },
                untracked,
            });
        }
    }

    // The Fleet Dashboard reviews a worktree against the commit it branched
    // from, not against its own index — an agent is expected to have committed
    // its work, so the interesting delta is `base_ref..worktree`, committed and
    // uncommitted parts alike. `git diff <base_ref>` (no `..`) is a tree-to-
    // worktree comparison that covers exactly that in one call, so this mode
    // has no "staged" side — there is no index question being asked here.
    if let Some(base) = base_ref {
        let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", base];
        if let Some(ref p) = path {
            args.extend(["--", p.as_str()]);
        }
        return Ok(GitSplitDiff {
            staged: String::new(),
            unstaged: run_git(root, &args, "read the worktree diff")?,
            untracked,
        });
    }

    let mut staged_args: Vec<&str> = vec!["diff", "--cached", "--no-color", "--no-ext-diff"];
    let mut unstaged_args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff"];
    if let Some(ref p) = path {
        staged_args.extend(["--", p.as_str()]);
        unstaged_args.extend(["--", p.as_str()]);
    }

    Ok(GitSplitDiff {
        staged: run_git(root, &staged_args, "read the staged diff")?,
        unstaged: run_git(root, &unstaged_args, "read the unstaged diff")?,
        untracked,
    })
}

#[tauri::command(async)]
pub fn workspace_git_diff_split(
    project_id: String,
    file_path: Option<String>,
    repo_path: Option<String>,
    base_ref: Option<String>,
    state: State<AppState>,
) -> Result<GitSplitDiff, String> {
    if let Some(ref b) = base_ref {
        if !is_valid_commit_ish(b) {
            return Err("Invalid base commit".to_string());
        }
    }
    let root = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    diff_split_at(&root, file_path, base_ref.as_deref())
}

/// Per-file line stats for the Fleet Dashboard's `+N / -M` summary.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeFileStat {
    pub path: String,
    pub additions: i32,
    pub deletions: i32,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeDiffStat {
    pub files: Vec<WorktreeFileStat>,
    pub total_additions: i32,
    pub total_deletions: i32,
    /// The ref these numbers were measured against, echoed back because the
    /// caller may not have known it: a main-repo agent has no fork point, so it
    /// asks for HEAD and needs the resolved sha to open the same diff per file.
    pub base_commit: String,
}

fn worktree_diff_stat_at(root: &std::path::Path, base_ref: &str) -> Result<WorktreeDiffStat, String> {
    // `git diff <base_ref>` (tree vs worktree, no `..`) covers everything the
    // worktree holds beyond base_ref — committed and uncommitted alike — which
    // is what the dashboard cares about: has the main checkout seen this yet?
    let numstat = run_git(
        root,
        &["diff", "--numstat", "--no-renames", base_ref],
        "read the worktree diff stat",
    )?;
    let name_status = run_git(
        root,
        &["diff", "--name-status", "--no-renames", base_ref],
        "read the worktree change types",
    )?;
    let mut status_by_path: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in name_status.lines() {
        let mut parts = line.splitn(2, '\t');
        let (Some(code), Some(path)) = (parts.next(), parts.next()) else { continue };
        let status = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            _ => "modified",
        };
        status_by_path.insert(path.to_string(), status.to_string());
    }

    let mut files = Vec::new();
    let mut total_additions = 0i32;
    let mut total_deletions = 0i32;
    for line in numstat.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        // Binary files report "-" for both counts; treat as zero rather than a
        // parse failure that would drop the file from the list entirely.
        let additions = parts[0].parse::<i32>().unwrap_or(0);
        let deletions = parts[1].parse::<i32>().unwrap_or(0);
        let path = parts[2].to_string();
        total_additions += additions;
        total_deletions += deletions;
        let status = status_by_path.get(&path).cloned().unwrap_or_else(|| "modified".to_string());
        files.push(WorktreeFileStat { path, additions, deletions, status });
    }

    // Untracked files never appear in `git diff <ref>` (it matches `git status`'s
    // notion of "not part of history"), so they need a separate pass — same
    // treatment `workspace_git_status` already gives them.
    let untracked = run_git(
        root,
        &["ls-files", "--others", "--exclude-standard"],
        "list untracked files",
    )?;
    for path in untracked.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if validate_relative_path(path).is_err() {
            continue;
        }
        let absolute = root.join(path);
        let additions = std::fs::metadata(&absolute)
            .ok()
            .filter(|m| m.len() <= 10 * 1024 * 1024)
            .and_then(|_| std::fs::read_to_string(&absolute).ok())
            .map(|c| c.lines().count() as i32)
            .unwrap_or(0);
        total_additions += additions;
        files.push(WorktreeFileStat {
            path: path.to_string(),
            additions,
            deletions: 0,
            status: "untracked".to_string(),
        });
    }

    Ok(WorktreeDiffStat {
        files,
        total_additions,
        total_deletions,
        base_commit: base_ref.to_string(),
    })
}

/// Git's fixed empty-tree object. Diffing against it in a repo with no commits
/// yet is what makes "everything here is new" expressible as a normal diff, and
/// it is 40 hex characters so it survives `is_valid_commit_ish` downstream.
const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Settle what a diff stat is measured against.
///
/// A requested base is validated exactly as before. `None` means the caller has
/// no fork point to name — the main-repo case — so it resolves to HEAD, or to
/// the empty tree in a repo with no commits yet.
fn resolve_diff_base(
    root: &std::path::Path,
    requested: Option<String>,
) -> Result<String, String> {
    match requested.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
        Some(commit) => {
            if !is_valid_commit_ish(&commit) {
                return Err("Invalid base commit".to_string());
            }
            Ok(commit)
        }
        None => Ok(git_capture(root, &["rev-parse", "HEAD"])
            .filter(|sha| is_valid_commit_ish(sha))
            .unwrap_or_else(|| EMPTY_TREE_OID.to_string())),
    }
}

/// `+N / -M` and a changed-file list for one agent, measured against the commit
/// it branched from — the Fleet Dashboard's per-agent card.
///
/// Both arguments are optional, and for the same reason: an agent running in
/// the **main repo** has neither a checkout nor a fork point of its own. It
/// edits the one you are sitting in, so `worktree_path` omitted means the
/// project root and `base_commit` omitted means HEAD — the uncommitted work in
/// the tree, which is the only honest answer for that placement.
///
/// Omitting the path is not the same as passing the root: `resolve_repo`
/// canonicalises what it is given, and the caller's copy of the root need not
/// canonicalise back to the stored one (symlinks, or a differently-cased drive
/// letter on Windows). `None` uses the stored root directly and cannot miss.
#[tauri::command(async)]
pub fn workspace_git_worktree_diff_stat(
    project_id: String,
    worktree_path: Option<String>,
    base_commit: Option<String>,
    state: State<AppState>,
) -> Result<WorktreeDiffStat, String> {
    check_git_available()?;
    let root = resolve_repo(&project_id, worktree_path.as_deref(), &state)?;
    let base = resolve_diff_base(&root, base_commit)?;
    worktree_diff_stat_at(&root, &base)
}

fn staged_paths_at(root: &std::path::Path) -> Result<Vec<String>, String> {
    // No HEAD yet: everything in the index is staged, and `diff --cached` has
    // nothing to compare against.
    let args: &[&str] = if git_capture(root, &["rev-parse", "--verify", "HEAD"]).is_some() {
        &["diff", "--cached", "--name-only", "--no-renames"]
    } else {
        &["ls-files", "--cached"]
    };
    let out = run_git(root, args, "list staged files")?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Paths currently in the index, so the UI can split Changes into staged and
/// unstaged without re-deriving it from porcelain codes on the frontend.
#[tauri::command(async)]
pub fn workspace_git_staged_paths(
    project_id: String,
    repo_path: Option<String>,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let root = resolve_repo(&project_id, repo_path.as_deref(), &state)?;
    staged_paths_at(&root)
}

#[tauri::command]
pub fn workspace_set_active(
    project_id: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    state.workspace_manager.set_active_project(project_id);
    Ok(())
}

#[tauri::command]
pub fn workspace_clear_recent(state: State<AppState>) -> Result<(), String> {
    state.workspace_manager.clear_recent_projects();
    Ok(())
}

fn parse_daily_note_markdown(content: &str) -> (Vec<String>, Vec<String>) {
    let mut focus = Vec::new();
    let mut done = Vec::new();
    let mut current_section = ""; // "focus", "done" or ""

    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(stripped) = trimmed.strip_prefix("##") {
            let section_name = stripped.trim().to_lowercase();
            if section_name.contains("focus") {
                current_section = "focus";
            } else if section_name.contains("done") {
                current_section = "done";
            } else {
                current_section = "";
            }
            continue;
        }

        if current_section == "focus" || current_section == "done" {
            if trimmed.starts_with('-')
                || trimmed.starts_with('*')
                || (trimmed.len() > 2
                    && trimmed.chars().next().unwrap().is_ascii_digit()
                    && trimmed.contains('.'))
            {
                let item = trimmed
                    .trim_start_matches([
                        '-', '*', ' ', '.', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
                    ])
                    .trim()
                    .to_string();
                if !item.is_empty() {
                    if current_section == "focus" {
                        focus.push(item);
                    } else {
                        done.push(item);
                    }
                }
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                if current_section == "focus" {
                    focus.push(trimmed.to_string());
                } else {
                    done.push(trimmed.to_string());
                }
            }
        }
    }

    (focus, done)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DailyNoteSummary {
    pub project_name: String,
    pub project_path: String,
    pub date: String,
    pub filepath: String,
    pub focus: Vec<String>,
    pub done: Vec<String>,
}

#[tauri::command]
pub fn workspace_get_recent_daily_notes(
    state: State<AppState>,
) -> Result<Vec<DailyNoteSummary>, String> {
    let recents = state.workspace_manager.get_recent_projects();
    let mut summaries = Vec::new();

    for project in recents {
        let daily_dir = project.root_path.join(".spacron").join("daily");
        let daily_notes_dir = project.root_path.join(".spacron").join("daily-notes");

        let dir_to_read = if daily_dir.is_dir() {
            Some(daily_dir)
        } else if daily_notes_dir.is_dir() {
            Some(daily_notes_dir)
        } else {
            None
        };

        if let Some(dir) = dir_to_read {
            if let Ok(entries) = std::fs::read_dir(dir) {
                let mut note_files = Vec::new();
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() && path.extension().map(|s| s == "md").unwrap_or(false) {
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            note_files.push((stem.to_string(), path));
                        }
                    }
                }

                note_files.sort_by(|a, b| b.0.cmp(&a.0));

                for (date, path) in note_files.into_iter().take(3) {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        let (focus, done) = parse_daily_note_markdown(&content);
                        summaries.push(DailyNoteSummary {
                            project_name: project.name.clone(),
                            project_path: project.root_path.to_string_lossy().to_string(),
                            date,
                            filepath: path.to_string_lossy().to_string(),
                            focus,
                            done,
                        });
                    }
                }
            }
        }
    }

    Ok(summaries)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- upstream tracking ---

    #[test]
    fn parses_both_directions_from_upstream_track() {
        assert_eq!(parse_upstream_track("[ahead 2, behind 1]"), (2, 1));
        assert_eq!(parse_upstream_track("[ahead 17]"), (17, 0));
        assert_eq!(parse_upstream_track("[behind 3]"), (0, 3));
    }

    #[test]
    fn treats_absent_or_unparseable_tracking_as_level() {
        // Empty (no upstream), "[gone]" (remote branch deleted), and anything
        // unexpected must all read as 0/0 rather than failing the branch list.
        assert_eq!(parse_upstream_track(""), (0, 0));
        assert_eq!(parse_upstream_track("[gone]"), (0, 0));
        assert_eq!(parse_upstream_track("[ahead lots]"), (0, 0));
    }

    // --- stage failures that need the user, not a retry ---

    #[test]
    fn recognises_the_paths_git_apply_refused_over_the_index() {
        // The user's own uncommitted edit to a file the agent also touched. git
        // aborts the whole patch, with no markers and no `U` entries — so this is
        // not a merge conflict, and retrying can never clear it.
        let stderr = "error: src/app.css: does not match index\nFalling back to direct application...\n";
        assert_eq!(
            index_mismatch_paths(stderr),
            Some(vec!["src/app.css".to_string()])
        );

        // An untracked file sitting where the agent created one.
        let stderr = "error: notes.md: does not exist in index\nerror: notes.md: patch does not apply\n";
        assert_eq!(
            index_mismatch_paths(stderr),
            Some(vec!["notes.md".to_string()])
        );

        // Several at once.
        let stderr = "error: a.ts: does not match index\nerror: b.ts: does not match index\n";
        assert_eq!(
            index_mismatch_paths(stderr),
            Some(vec!["a.ts".to_string(), "b.ts".to_string()])
        );
    }

    #[test]
    fn leaves_other_git_failures_to_the_generic_message() {
        assert_eq!(index_mismatch_paths(""), None);
        assert_eq!(index_mismatch_paths("error: corrupt patch at line 4\n"), None);
        // A real conflict is handled on the branch above this one.
        assert_eq!(
            index_mismatch_paths("Applied patch to 'x.ts' with conflicts.\nU x.ts\n"),
            None
        );
    }

    // --- agent worktree area ---

    #[test]
    fn worktree_area_sits_inside_the_project_root() {
        // The whole point of the 0.7.4 move: terminals are confined to the open
        // project roots, so the area must be reachable from the root.
        let root = PathBuf::from("/home/u/proj");
        let area = worktree_area(&root);
        assert!(area.starts_with(&root));
        assert_eq!(area, root.join(".spacron").join("worktrees"));
    }

    #[test]
    fn is_under_accepts_the_area_and_its_children() {
        let area = PathBuf::from("/home/u/proj/.spacron/worktrees");
        assert!(is_under(&area, &area));
        assert!(is_under(&area.join("spacron-neo-342ci1"), &area));
    }

    #[test]
    fn is_under_rejects_siblings_and_prefix_lookalikes() {
        let area = PathBuf::from("/home/u/proj/.spacron/worktrees");
        assert!(!is_under(&PathBuf::from("/home/u/proj/src"), &area));
        assert!(!is_under(&PathBuf::from("/home/u/other"), &area));
        // "worktrees-evil" must not pass just because it shares a prefix.
        assert!(!is_under(
            &PathBuf::from("/home/u/proj/.spacron/worktrees-evil"),
            &area
        ));
    }

    #[test]
    fn legacy_area_is_still_recognised_for_cleanup() {
        // Worktrees created before the move are recorded in persisted sessions;
        // remove/status must still accept them or they can never be cleaned up.
        let root = PathBuf::from("/home/u/proj");
        let legacy = legacy_worktree_area(&root).expect("root has a parent and a name");
        assert_eq!(legacy, PathBuf::from("/home/u/.spacron-worktrees/proj"));
        assert!(is_under(&legacy.join("spacron-neo-342ci1"), &legacy));
    }

    // --- is_valid_commit_ish ---

    #[test]
    fn commit_ish_accepts_short_and_full_object_names() {
        assert!(is_valid_commit_ish("380ac7f"));
        assert!(is_valid_commit_ish("fb7ce5d1a2b3c4d5e6f708192a3b4c5d6e7f8091"));
        assert!(is_valid_commit_ish(" 380ac7f "));
    }

    #[test]
    fn commit_ish_rejects_anything_git_could_read_as_a_flag_or_path() {
        // These reach the command from persisted state, and are interpolated into a
        // revision range — a non-hex value must never get that far.
        assert!(!is_valid_commit_ish("--upload-pack=evil"));
        assert!(!is_valid_commit_ish("HEAD"));
        assert!(!is_valid_commit_ish("main..evil"));
        assert!(!is_valid_commit_ish("src/main.rs"));
        assert!(!is_valid_commit_ish(""));
        assert!(!is_valid_commit_ish("abc")); // too short to be an object name
    }

    // --- sanitize_git_error ---

    #[test]
    fn sanitize_git_error_passes_clean_lines() {
        let input = "remote: Counting objects: 5, done.\nremote: Total 5";
        let result = sanitize_git_error(input);
        assert_eq!(result, input);
    }

    #[test]
    fn sanitize_git_error_redacts_windows_absolute_paths() {
        let input = "error: could not read C:\\Users\\sam\\project\\.git\\config";
        let result = sanitize_git_error(input);
        assert_eq!(result, "error: could not read [path redacted]");
    }

    #[test]
    fn sanitize_git_error_redacts_unix_absolute_paths() {
        let input = "/home/user/project: not a git repository";
        let result = sanitize_git_error(input);
        assert_eq!(result, "[path redacted] not a git repository");
    }

    #[test]
    fn sanitize_git_error_redacts_mixed_output() {
        // The function redacts a line when it starts with '/' (unix absolute path).
        // Here the first line starts with '/' and the second is clean.
        let input = "/home/user/project/.git: not a git repository\nUsage: git fetch <remote>";
        let result = sanitize_git_error(input);
        assert!(result.contains("[path redacted]"));
        assert!(result.contains("Usage: git fetch <remote>"));
    }

    #[test]
    fn sanitize_git_error_handles_empty_string() {
        assert_eq!(sanitize_git_error(""), "");
    }

    // --- validate_relative_path ---

    #[test]
    fn validate_relative_path_accepts_normal_paths() {
        assert!(validate_relative_path("src/main.rs").is_ok());
        assert!(validate_relative_path("README.md").is_ok());
        assert!(validate_relative_path("a/b/c/d.txt").is_ok());
    }

    #[test]
    fn validate_relative_path_rejects_null_bytes() {
        assert!(validate_relative_path("file\0name").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_double_dash_prefix() {
        assert!(validate_relative_path("--malicious").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_path_traversal_unix() {
        assert!(validate_relative_path("../outside").is_err());
        assert!(validate_relative_path("a/../../outside").is_err());
    }

    #[test]
    fn validate_relative_path_rejects_path_traversal_windows() {
        assert!(validate_relative_path("a\\..\\outside").is_err());
    }

    // --- validate_branch_name ---

    #[test]
    fn validate_branch_name_accepts_valid_names() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("feature/my-branch").is_ok());
        assert!(validate_branch_name("fix_bug_123").is_ok());
    }

    #[test]
    fn validate_branch_name_rejects_empty() {
        assert!(validate_branch_name("").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_leading_dash() {
        assert!(validate_branch_name("-bad-branch").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_double_dot() {
        assert!(validate_branch_name("branch..name").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_special_characters() {
        assert!(validate_branch_name("branch name").is_err());
        assert!(validate_branch_name("branch@name").is_err());
        assert!(validate_branch_name("branch;name").is_err());
    }

    // --- extract_port_from_cmd ---

    #[test]
    fn extract_port_from_cmd_finds_port_flag() {
        assert_eq!(extract_port_from_cmd("vite --port 5174"), Some(5174));
    }

    #[test]
    fn extract_port_from_cmd_finds_short_port_flag() {
        assert_eq!(extract_port_from_cmd("node server.js -p 8080"), Some(8080));
    }

    #[test]
    fn extract_port_from_cmd_returns_none_when_absent() {
        assert_eq!(extract_port_from_cmd("vite --host 0.0.0.0"), None);
    }

    #[test]
    fn extract_port_from_cmd_returns_none_for_empty() {
        assert_eq!(extract_port_from_cmd(""), None);
    }

    // --- extract_port_from_vite_config ---

    #[test]
    fn extract_port_from_vite_config_parses_port() {
        let config = "export default defineConfig({\n  server: {\n    port: 3001,\n  }\n})";
        assert_eq!(extract_port_from_vite_config(config), Some(3001));
    }

    #[test]
    fn extract_port_from_vite_config_skips_line_comments() {
        let config = "// port: 22\nexport default defineConfig({ server: { port: 4000 } })";
        assert_eq!(extract_port_from_vite_config(config), Some(4000));
    }

    #[test]
    fn extract_port_from_vite_config_skips_block_comments() {
        // The parser opens a block comment on "/*" and closes it on a later line containing "*/".
        // A single-line "/* ... */" is NOT closed within the same line (the parser `continue`s
        // after setting in_block_comment = true), so this test uses a proper multi-line form.
        let config = "/*\n  port: 22\n*/\nexport default defineConfig({ server: { port: 4321 } })";
        assert_eq!(extract_port_from_vite_config(config), Some(4321));
    }

    #[test]
    fn extract_port_from_vite_config_returns_none_when_absent() {
        let config = "export default defineConfig({ server: { host: true } })";
        assert_eq!(extract_port_from_vite_config(config), None);
    }

    // --- §7 explicit-path staging, against a real repo ---
    //
    // This is the section the whole roadmap item calls "the strongest argument
    // on the list": several agents editing one shared working tree, so a
    // blanket `git add -A` sweeps in whatever any of them happened to be
    // touching. These tests exercise real `git` against a throwaway repo rather
    // than mocking it, because the thing worth proving is what actually lands
    // in the index — a mock would just assert the code calls itself correctly.

    struct TestRepo {
        dir: tempfile::TempDir,
    }

    impl TestRepo {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path();
            let run = |args: &[&str]| {
                let status = git_base()
                    .args(args)
                    .current_dir(root)
                    .status()
                    .expect("git available for tests");
                assert!(status.success(), "git {:?} failed", args);
            };
            run(&["init", "-q"]);
            run(&["config", "user.email", "test@example.com"]);
            run(&["config", "user.name", "Test"]);
            Self { dir }
        }

        fn path(&self) -> &std::path::Path {
            self.dir.path()
        }

        fn write(&self, rel: &str, content: &str) {
            let full = self.path().join(rel);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(full, content).unwrap();
        }

        fn commit_all(&self, message: &str) {
            let status = git_base()
                .args(["add", "-A"])
                .current_dir(self.path())
                .status()
                .unwrap();
            assert!(status.success());
            let status = git_base()
                .args(["commit", "-q", "-m", message])
                .current_dir(self.path())
                .status()
                .unwrap();
            assert!(status.success());
        }
    }

    #[test]
    fn stage_paths_leaves_an_unlisted_file_untouched() {
        // The regression this whole section exists to close: staging file A must
        // never pick up file B, even though a bare `git add -A` would.
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.write("b.txt", "two\n");
        repo.commit_all("initial");

        repo.write("a.txt", "one changed\n");
        repo.write("b.txt", "two changed\n");

        stage_paths_at(repo.path(), &["a.txt".to_string()]).expect("stage a.txt");

        let staged = staged_paths_at(repo.path()).expect("list staged");
        assert_eq!(staged, vec!["a.txt".to_string()]);

        // b.txt's edit is real but must still be sitting in the working tree,
        // unstaged — exactly what an in-flight agent edit needs to survive.
        let diff = diff_split_at(repo.path(), Some("b.txt".to_string()), None).unwrap();
        assert!(diff.staged.is_empty());
        assert!(diff.unstaged.contains("two changed"));
    }

    #[test]
    fn stage_paths_records_a_new_untracked_file() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        repo.write("new.txt", "brand new\n");

        stage_paths_at(repo.path(), &["new.txt".to_string()]).expect("stage new.txt");
        assert_eq!(staged_paths_at(repo.path()).unwrap(), vec!["new.txt".to_string()]);
    }

    #[test]
    fn unstage_paths_reverts_the_index_without_touching_the_worktree() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        repo.write("a.txt", "one changed\n");

        stage_paths_at(repo.path(), &["a.txt".to_string()]).unwrap();
        assert_eq!(staged_paths_at(repo.path()).unwrap(), vec!["a.txt".to_string()]);

        unstage_paths_at(repo.path(), &["a.txt".to_string()]).expect("unstage a.txt");
        assert!(staged_paths_at(repo.path()).unwrap().is_empty());

        // The edit itself must survive — unstaging is an index operation only.
        let diff = diff_split_at(repo.path(), Some("a.txt".to_string()), None).unwrap();
        assert!(diff.unstaged.contains("one changed"));
    }

    #[test]
    fn unstage_paths_works_before_the_first_commit() {
        // No HEAD yet, so `git reset` has nothing to reset to; the `rm --cached`
        // branch has to carry this case.
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        stage_paths_at(repo.path(), &["a.txt".to_string()]).unwrap();
        assert_eq!(staged_paths_at(repo.path()).unwrap(), vec!["a.txt".to_string()]);

        unstage_paths_at(repo.path(), &["a.txt".to_string()]).expect("unstage before first commit");
        assert!(staged_paths_at(repo.path()).unwrap().is_empty());
    }

    #[test]
    fn commit_staged_refuses_an_empty_commit() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        // Nothing staged.
        let err = commit_staged_at(repo.path(), "should not land", false).unwrap_err();
        assert!(err.contains("staged"));
    }

    #[test]
    fn commit_staged_commits_only_what_was_staged() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.write("b.txt", "two\n");
        repo.commit_all("initial");

        repo.write("a.txt", "one changed\n");
        repo.write("b.txt", "two changed\n");
        stage_paths_at(repo.path(), &["a.txt".to_string()]).unwrap();

        commit_staged_at(repo.path(), "update a only", false).expect("commit");

        // b.txt's edit must still be sitting there, unstaged and uncommitted.
        assert!(staged_paths_at(repo.path()).unwrap().is_empty());
        let diff = diff_split_at(repo.path(), Some("b.txt".to_string()), None).unwrap();
        assert!(diff.unstaged.contains("two changed"));
    }

    #[test]
    fn commit_staged_can_amend() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("first message");

        repo.write("a.txt", "one changed\n");
        stage_paths_at(repo.path(), &["a.txt".to_string()]).unwrap();
        commit_staged_at(repo.path(), "amended message", true).expect("amend");

        let log = run_git(repo.path(), &["log", "--oneline", "-n", "5"], "log").unwrap();
        assert_eq!(log.lines().count(), 1, "amend must not add a second commit");
        assert!(log.contains("amended message"));
    }

    #[test]
    fn amend_refuses_when_there_is_no_commit_yet() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        stage_paths_at(repo.path(), &["a.txt".to_string()]).unwrap();
        let err = commit_staged_at(repo.path(), "msg", true).unwrap_err();
        assert!(err.contains("no commit"));
    }

    #[test]
    fn hunk_patch_round_trip_stages_and_unstages_a_real_hunk() {
        // Exercises the Rust apply side against a patch shaped the way the
        // frontend's `buildHunkPatch` produces it (see services/git/patch.ts),
        // proving the two halves actually agree on the format.
        let repo = TestRepo::new();
        repo.write("a.txt", "one\ntwo\nthree\n");
        repo.commit_all("initial");
        repo.write("a.txt", "one\nTWO\nthree\n");

        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";

        apply_patch_at(repo.path(), patch, false).expect("stage the hunk");
        assert_eq!(staged_paths_at(repo.path()).unwrap(), vec!["a.txt".to_string()]);
        let after_stage = diff_split_at(repo.path(), Some("a.txt".to_string()), None).unwrap();
        assert!(after_stage.staged.contains("+TWO"));
        assert!(after_stage.unstaged.is_empty());

        apply_patch_at(repo.path(), patch, true).expect("unstage the hunk");
        assert!(staged_paths_at(repo.path()).unwrap().is_empty());
        let after_unstage = diff_split_at(repo.path(), Some("a.txt".to_string()), None).unwrap();
        assert!(after_unstage.unstaged.contains("+TWO"));
    }

    #[test]
    fn diff_split_synthesises_a_diff_for_an_untracked_file() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        repo.write("new.txt", "hello\nworld\n");

        let diff = diff_split_at(repo.path(), Some("new.txt".to_string()), None).unwrap();
        assert!(diff.untracked);
        assert!(diff.staged.is_empty());
        assert!(diff.unstaged.contains("+hello"));
        assert!(diff.unstaged.contains("+world"));
    }

    #[test]
    fn resolve_repo_confines_a_worktree_path_to_the_managed_area() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");

        // A path elsewhere on disk — not this project's worktree area — must be
        // rejected even though it happens to be a real git repo, otherwise
        // `repo_path` becomes an arbitrary-repository write primitive.
        let other = tempfile::tempdir().unwrap();
        let status = git_base().args(["init", "-q"]).current_dir(other.path()).status().unwrap();
        assert!(status.success());

        let allowed = is_under(&crate::commands::clean_path_buf(other.path().to_path_buf()), &worktree_area(repo.path()));
        assert!(!allowed, "a foreign repo must not resolve as this project's worktree");
    }

    // --- §13 worktree diff stat (Fleet Dashboard) ---

    #[test]
    fn worktree_diff_stat_covers_committed_and_uncommitted_work_together() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\ntwo\nthree\n");
        repo.commit_all("initial");
        let base = run_git(repo.path(), &["rev-parse", "HEAD"], "rev-parse").unwrap().trim().to_string();

        // One committed change on the agent's branch...
        repo.write("a.txt", "one\nTWO\nthree\n");
        repo.commit_all("agent work");
        // ...and one still sitting uncommitted, the way an in-progress turn does.
        repo.write("b.txt", "brand new\n");

        let stat = worktree_diff_stat_at(repo.path(), &base).unwrap();
        let paths: Vec<&str> = stat.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"), "committed change missing: {paths:?}");
        assert!(paths.contains(&"b.txt"), "uncommitted/untracked change missing: {paths:?}");
        assert!(stat.total_additions > 0);
    }

    #[test]
    fn worktree_diff_stat_classifies_added_and_deleted_files() {
        let repo = TestRepo::new();
        repo.write("keep.txt", "unchanged\n");
        repo.write("gone.txt", "will be deleted\n");
        repo.commit_all("initial");
        let base = run_git(repo.path(), &["rev-parse", "HEAD"], "rev-parse").unwrap().trim().to_string();

        std::fs::remove_file(repo.path().join("gone.txt")).unwrap();
        repo.write("fresh.txt", "tracked and new\n");
        stage_paths_at(repo.path(), &["fresh.txt".to_string(), "gone.txt".to_string()]).unwrap();
        commit_staged_at(repo.path(), "add and remove", false).unwrap();

        let stat = worktree_diff_stat_at(repo.path(), &base).unwrap();
        let fresh = stat.files.iter().find(|f| f.path == "fresh.txt").expect("fresh.txt present");
        assert_eq!(fresh.status, "added");
        let gone = stat.files.iter().find(|f| f.path == "gone.txt").expect("gone.txt present");
        assert_eq!(gone.status, "deleted");
        assert!(!stat.files.iter().any(|f| f.path == "keep.txt"), "unchanged file must not appear");
    }

    #[test]
    fn worktree_diff_stat_is_empty_when_nothing_has_changed() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        let base = run_git(repo.path(), &["rev-parse", "HEAD"], "rev-parse").unwrap().trim().to_string();

        let stat = worktree_diff_stat_at(repo.path(), &base).unwrap();
        assert!(stat.files.is_empty());
        assert_eq!(stat.total_additions, 0);
        assert_eq!(stat.total_deletions, 0);
    }

    // --- main-repo agents: no fork point, so the base is HEAD ---

    #[test]
    fn diff_base_defaults_to_head_when_no_fork_point_is_given() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        let head = run_git(repo.path(), &["rev-parse", "HEAD"], "rev-parse").unwrap().trim().to_string();

        assert_eq!(resolve_diff_base(repo.path(), None).unwrap(), head);
        assert_eq!(resolve_diff_base(repo.path(), Some("  ".to_string())).unwrap(), head);
    }

    #[test]
    fn diff_base_falls_back_to_the_empty_tree_before_the_first_commit() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\ntwo\n");

        let base = resolve_diff_base(repo.path(), None).unwrap();
        assert_eq!(base, EMPTY_TREE_OID);
        // The point of the fallback: an unborn HEAD still produces a usable
        // diff rather than a hard error on the card.
        let stat = worktree_diff_stat_at(repo.path(), &base).unwrap();
        assert!(stat.files.iter().any(|f| f.path == "a.txt"), "new file missing: {:?}", stat.files);
    }

    #[test]
    fn diff_base_still_rejects_a_bogus_commit_ish() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");

        // Anything non-hex would otherwise reach a git argv.
        assert!(resolve_diff_base(repo.path(), Some("--upload-pack=evil".to_string())).is_err());
        assert!(resolve_diff_base(repo.path(), Some("HEAD".to_string())).is_err());
    }

    // --- agent branch sweep ---

    #[test]
    fn reads_branch_names_out_of_git_porcelain_and_delete_output() {
        let porcelain = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
                         worktree /repo/.spacron/worktrees/x\nHEAD def\nbranch refs/heads/spacron/ada-1\n\n\
                         worktree /repo/.spacron/worktrees/y\nHEAD 999\ndetached\n";
        let out = parse_checked_out_branches(porcelain);
        assert!(out.contains("main"));
        assert!(out.contains("spacron/ada-1"));
        // A detached worktree contributes no branch line at all.
        assert_eq!(out.len(), 2);

        let stdout = "Deleted branch spacron/ada-1 (was 1a2b3c4).\n\
                      Deleted branch spacron/bane-2 (was 5d6e7f8).\n";
        assert_eq!(
            parse_deleted_branches(stdout),
            vec!["spacron/ada-1".to_string(), "spacron/bane-2".to_string()]
        );
        assert!(parse_deleted_branches("").is_empty());
    }

    /// Cut a branch at the current HEAD without checking it out — exactly what a
    /// worktree spawn leaves behind when its agent never commits.
    fn branch_at_head(repo: &TestRepo, name: &str) {
        let status = git_base()
            .args(["branch", name])
            .current_dir(repo.path())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn sweeps_agent_branches_that_hold_nothing_the_base_lacks() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");

        // The dominant real-world case: agents that never committed, so their
        // branch is just a pointer at the fork commit.
        branch_at_head(&repo, "spacron/ada-1");
        branch_at_head(&repo, "spacron/bane-2");
        // The user's own branch, and an agent branch still in use.
        branch_at_head(&repo, "my-feature");
        branch_at_head(&repo, "spacron/live-9");

        let skip = vec!["spacron/live-9".to_string()];
        let sweep = sweep_agent_branches_at(repo.path(), &skip, false).unwrap();

        let mut deleted = sweep.deleted.clone();
        deleted.sort();
        assert_eq!(deleted, vec!["spacron/ada-1", "spacron/bane-2"]);
        assert!(sweep.failed.is_empty());

        let remaining = git_read(repo.path(), &["branch", "--format=%(refname:short)"]).unwrap();
        // Prefix guard and skip list both held.
        assert!(remaining.contains("my-feature"));
        assert!(remaining.contains("spacron/live-9"));
        assert!(!remaining.contains("spacron/ada-1"));
    }

    #[test]
    fn keeps_an_agent_branch_that_holds_its_own_commits() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");

        // An agent that committed on its branch and was never merged back.
        let run = |args: &[&str]| {
            let status = git_base().args(args).current_dir(repo.path()).status().unwrap();
            assert!(status.success(), "git {args:?}");
        };
        run(&["checkout", "-q", "-b", "spacron/niobe-4"]);
        repo.write("feature.txt", "agent work\n");
        repo.commit_all("agent commit");
        run(&["checkout", "-q", "-"]);

        let sweep = sweep_agent_branches_at(repo.path(), &[], false).unwrap();

        assert!(sweep.deleted.is_empty());
        assert_eq!(sweep.retained.len(), 1);
        let kept = &sweep.retained[0];
        assert_eq!(kept.branch, "spacron/niobe-4");
        assert_eq!(kept.unique_commits, 1);
        assert!(!kept.last_commit.is_empty());
        // Nothing equivalent has been applied to the base, so this is real work.
        assert!(!kept.patch_equivalent);

        let remaining = git_read(repo.path(), &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(remaining.contains("spacron/niobe-4"));
    }

    #[test]
    fn a_dry_run_reports_without_deleting() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        branch_at_head(&repo, "spacron/ada-1");

        let sweep = sweep_agent_branches_at(repo.path(), &[], true).unwrap();

        assert_eq!(sweep.deleted, vec!["spacron/ada-1".to_string()]);
        let remaining = git_read(repo.path(), &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(remaining.contains("spacron/ada-1"), "dry run must not delete");
    }

    #[test]
    fn sweeps_from_a_feature_branch_by_falling_back_to_main() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        let run = |args: &[&str]| {
            let status = git_base().args(args).current_dir(repo.path()).status().unwrap();
            assert!(status.success(), "git {args:?}");
        };
        // Normalise the default branch name, then move off it — `git branch -d`
        // measures against HEAD, so without the main/master fallback the sweep
        // would silently stop working here.
        run(&["branch", "-M", "main"]);
        branch_at_head(&repo, "spacron/ada-1");
        run(&["checkout", "-q", "-b", "my-feature"]);
        repo.write("b.txt", "feature\n");
        repo.commit_all("feature commit");

        let sweep = sweep_agent_branches_at(repo.path(), &[], false).unwrap();

        assert_eq!(sweep.deleted, vec!["spacron/ada-1".to_string()]);
        assert!(sweep.failed.is_empty());
    }

    #[test]
    fn never_deletes_a_branch_checked_out_in_a_worktree() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");

        // A live agent's checkout: contained in the base (no commits yet), but
        // occupied — deleting it would break the running agent.
        let wt = repo.path().join(".spacron").join("worktrees").join("live");
        let status = git_base()
            .args(["worktree", "add", "-b", "spacron/live-9"])
            .arg(&wt)
            .current_dir(repo.path())
            .status()
            .unwrap();
        assert!(status.success());

        let sweep = sweep_agent_branches_at(repo.path(), &[], false).unwrap();

        assert!(sweep.deleted.is_empty());
        // Checked out, so it is neither deleted nor reported as work to review.
        assert!(sweep.retained.iter().all(|r| r.branch != "spacron/live-9"));
        let remaining = git_read(repo.path(), &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(remaining.contains("spacron/live-9"));
    }

    #[test]
    fn diff_stat_reports_the_base_it_measured_against() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one\n");
        repo.commit_all("initial");
        let head = run_git(repo.path(), &["rev-parse", "HEAD"], "rev-parse").unwrap().trim().to_string();

        // The Fleet card reuses this to open the same diff per file, so an echo
        // that disagreed with the numbers would show a different change set.
        let stat = worktree_diff_stat_at(repo.path(), &head).unwrap();
        assert_eq!(stat.base_commit, head);
    }
}
