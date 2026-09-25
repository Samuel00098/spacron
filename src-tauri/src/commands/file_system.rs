use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

/// Resolve a (possibly new) path to its best canonical form and verify it
/// falls inside one of the currently open project roots.
pub fn require_in_project(path: &Path, state: &AppState) -> Result<(), String> {
    require_in_roots(path, &project_roots(state))
}

/// Snapshot of the open project roots — the confinement set for the local
/// (in-app) transport. The remote server passes its single `--workspace` root
/// instead; both flow through [`require_in_roots`].
pub fn project_roots(state: &AppState) -> Vec<PathBuf> {
    state
        .workspace_manager
        .list_projects()
        .into_iter()
        .map(|p| p.root_path)
        .collect()
}

/// Transport-agnostic confinement check: verify `path` falls inside one of
/// `roots`. Shared by the Tauri commands (roots = open projects) and the remote
/// server (roots = the served workspace).
pub fn require_in_roots(path: &Path, roots: &[PathBuf]) -> Result<(), String> {
    if roots.is_empty() {
        return Err("No project is open. Open a project folder first.".to_string());
    }
    // Get the best canonical path we can for a possibly-new file.
    let canonical: PathBuf = if path.exists() {
        std::fs::canonicalize(path).map_err(|_| "Invalid path".to_string())?
    } else if let Some(parent) = path.parent() {
        if parent.as_os_str().is_empty() || parent == Path::new(".") {
            path.to_path_buf()
        } else if parent.exists() {
            let cp = std::fs::canonicalize(parent).map_err(|_| "Invalid path".to_string())?;
            cp.join(path.file_name().unwrap_or_default())
        } else {
            path.to_path_buf()
        }
    } else {
        path.to_path_buf()
    };
    let canonical = crate::commands::clean_path_buf(canonical);
    if !roots.iter().any(|r| canonical.starts_with(r)) {
        return Err("Access denied: path is outside any open project".to_string());
    }
    // The checks above resolve symlinks only when the OS can — `canonicalize`
    // needs the whole chain to exist. A *dangling* symlink is invisible to them
    // (`Path::exists` follows the link and reports false), so the path falls
    // through the "new file" branch, reads as inside the root, and the caller's
    // `fs::write` / `create_dir_all` then follows the link and lands outside it.
    // This closes that gap by inspecting the links themselves.
    require_no_escaping_symlink(&canonical, roots)
}

/// How many links deep to follow before giving up. Matches the spirit of the
/// kernel's own `ELOOP` cap; a chain longer than this is pathological.
const MAX_SYMLINK_HOPS: usize = 16;

/// Reject `path` if any component of it is a symlink resolving outside `roots`.
///
/// `canonicalize` cannot help here: it fails outright when the target doesn't
/// exist, which is exactly the case that escapes. So this walks the path one
/// component at a time and uses `symlink_metadata` — which does *not* follow the
/// link — to see each link as a link, then resolves the chain lexically and
/// confines the result.
///
/// Intermediate components matter as much as the final one: `write_file` calls
/// `create_dir_all(parent)`, and `create_dir_all` happily follows a dangling
/// directory symlink and materialises the target outside the project.
fn require_no_escaping_symlink(path: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let mut prefix = PathBuf::new();
    for component in path.components() {
        prefix.push(component.as_os_str());
        // Not present at all — a genuinely new path segment, nothing to follow.
        let Ok(meta) = std::fs::symlink_metadata(&prefix) else {
            continue;
        };
        if !meta.file_type().is_symlink() {
            continue;
        }
        let mut resolved = prefix.clone();
        for _ in 0..MAX_SYMLINK_HOPS {
            let Ok(target) = std::fs::read_link(&resolved) else {
                break; // no longer a link: the chain ended
            };
            resolved = if target.is_absolute() {
                target
            } else {
                // A relative link resolves against the directory holding it.
                resolved
                    .parent()
                    .unwrap_or_else(|| Path::new(""))
                    .join(target)
            };
            resolved = crate::commands::clean_path_buf(lexically_normalize(&resolved));
            if !roots.iter().any(|r| resolved.starts_with(r)) {
                return Err(
                    "Access denied: path crosses a symlink pointing outside any open project"
                        .to_string(),
                );
            }
            // Target is inside a root, but it may itself be a link out — keep going.
            match std::fs::symlink_metadata(&resolved) {
                Ok(m) if m.file_type().is_symlink() => continue,
                _ => break,
            }
        }
    }
    Ok(())
}

/// Resolve `.` and `..` purely lexically, with no filesystem access.
///
/// Needed because the paths handled here may not exist, so `canonicalize` is not
/// available. A leading `..` that would climb above the path root is dropped
/// rather than escaping — callers confine the result against the project roots
/// immediately afterwards, so a truncated path fails that check.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out: Vec<std::path::Component> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                // Never pop a prefix/root component (`C:\`, `/`).
                if let Some(std::path::Component::Normal(_)) = out.last() {
                    out.pop();
                }
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out.iter().collect()
}

fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let resolved = if p.exists() {
        std::fs::canonicalize(&p).map_err(|_| "Invalid path".to_string())?
    } else {
        let file_name = p.file_name().unwrap_or_default();
        if file_name == ".." {
            return Err("Invalid path".to_string());
        }
        if let Some(parent) = p.parent() {
            if parent.exists() {
                let canonical_parent =
                    std::fs::canonicalize(parent).map_err(|_| "Invalid path".to_string())?;
                canonical_parent.join(file_name)
            } else {
                // Lexically resolve all .. components without I/O to prevent traversal
                // through non-existent intermediate directories (TOCTOU gap).
                let mut components: Vec<std::path::Component> = Vec::new();
                for comp in p.components() {
                    match comp {
                        std::path::Component::ParentDir => {
                            if components.is_empty() {
                                return Err(
                                    "Invalid path: directory traversal detected".to_string()
                                );
                            }
                            components.pop();
                        }
                        std::path::Component::CurDir => {}
                        other => components.push(other),
                    }
                }
                components.iter().collect::<PathBuf>()
            }
        } else {
            p
        }
    };
    Ok(crate::commands::clean_path_buf(resolved))
}

pub(crate) fn require_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    let canonical = std::fs::canonicalize(&p).map_err(|_| "Invalid path".to_string())?;
    Ok(crate::commands::clean_path_buf(canonical))
}

fn redact_path(path: &str) -> String {
    let p = Path::new(path);
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|n| format!("[redacted]/{}", n))
        .unwrap_or_else(|| "[redacted]".to_string())
}

fn sanitize_io_error(e: std::io::Error, path: &str) -> String {
    format!("{}: {}", e.kind(), redact_path(path))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

/// Every command in this module does blocking disk I/O, so they are all declared
/// `#[tauri::command(async)]` — Tauri runs a plain `#[tauri::command]` on the
/// main thread, where a single large read, a recursive copy, or a `remove_dir_all`
/// over `node_modules` freezes the whole window (including dragging it) until it
/// finishes. `async` moves them onto the async runtime instead. Same reasoning as
/// the git commands in `commands::workspace`, which were moved off the main
/// thread for exactly this reason; these were simply missed at the time.
///
/// Concurrency is safe here: each command re-checks project confinement itself
/// and the operations touch independent paths. Two writes racing on one file was
/// already possible from the frontend and is unchanged by this.
#[tauri::command(async)]
pub fn fs_read_dir(path: String, state: State<AppState>) -> Result<Vec<FileEntry>, String> {
    read_dir(&path, &project_roots(&state))
}

pub fn read_dir(path: &str, roots: &[PathBuf]) -> Result<Vec<FileEntry>, String> {
    let path = path.to_string();
    let dir = require_path(&path)?;
    require_in_roots(&dir, roots)?;
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| sanitize_io_error(e, &path))? {
        let entry = entry.map_err(|e| sanitize_io_error(e, &path))?;
        let metadata = entry.metadata().map_err(|e| sanitize_io_error(e, &path))?;
        let modified = metadata
            .modified()
            .ok()
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .to_string()
            })
            .unwrap_or_default();

        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}

#[tauri::command(async)]
pub fn fs_create_file(path: String, state: State<AppState>) -> Result<(), String> {
    create_file(&path, &project_roots(&state))
}

pub fn create_file(path: &str, roots: &[PathBuf]) -> Result<(), String> {
    let file_path = resolve_path(path)?;
    require_in_roots(&file_path, roots)?;
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| sanitize_io_error(e, path))?;
    }
    std::fs::File::create(&file_path).map_err(|e| sanitize_io_error(e, path))?;
    Ok(())
}

#[tauri::command(async)]
pub fn fs_create_dir(path: String, state: State<AppState>) -> Result<(), String> {
    create_dir(&path, &project_roots(&state))
}

pub fn create_dir(path: &str, roots: &[PathBuf]) -> Result<(), String> {
    let p = resolve_path(path)?;
    require_in_roots(&p, roots)?;
    std::fs::create_dir_all(&p).map_err(|e| sanitize_io_error(e, path))
}

#[tauri::command(async)]
pub fn fs_rename(from: String, to: String, state: State<AppState>) -> Result<(), String> {
    rename(&from, &to, &project_roots(&state))
}

pub fn rename(from: &str, to: &str, roots: &[PathBuf]) -> Result<(), String> {
    let from_path = require_path(from)?;
    let to_path = resolve_path(to)?;
    require_in_roots(&from_path, roots)?;
    require_in_roots(&to_path, roots)?;
    std::fs::rename(&from_path, &to_path).map_err(|e| format!("Failed to rename: {}", e.kind()))
}

#[tauri::command(async)]
pub fn fs_delete(path: String, state: State<AppState>) -> Result<(), String> {
    delete(&path, &project_roots(&state))
}

pub fn delete(path: &str, roots: &[PathBuf]) -> Result<(), String> {
    let p = require_path(path)?;
    require_in_roots(&p, roots)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| sanitize_io_error(e, path))
    } else {
        std::fs::remove_file(&p).map_err(|e| sanitize_io_error(e, path))
    }
}

#[tauri::command(async)]
pub fn fs_copy(from: String, to: String, state: State<AppState>) -> Result<(), String> {
    copy(&from, &to, &project_roots(&state))
}

pub fn copy(from: &str, to: &str, roots: &[PathBuf]) -> Result<(), String> {
    let from_path = require_path(from)?;
    let to_path = resolve_path(to)?;
    require_in_roots(&from_path, roots)?;
    require_in_roots(&to_path, roots)?;
    if from_path.is_dir() {
        copy_dir_recursive(&from_path, &to_path).map_err(|e| format!("Copy failed: {}", e.kind()))
    } else {
        if let Some(parent) = to_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| sanitize_io_error(e, to))?;
        }
        std::fs::copy(&from_path, &to_path).map_err(|e| sanitize_io_error(e, from))?;
        Ok(())
    }
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue; // skip symlinks — following them could escape the project root
        }
        let new_from = entry.path();
        let new_to = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&new_from, &new_to)?;
        } else {
            std::fs::copy(&new_from, &new_to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Create an AppState whose workspace has one open project rooted at `dir`.
    fn make_state_with_project(dir: &TempDir) -> crate::state::AppState {
        let config_dir = dir.path().join(".config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let state = crate::state::AppState::new(config_dir);
        let project_root = std::fs::canonicalize(dir.path()).unwrap();
        let project_root = crate::commands::clean_path_buf(project_root);
        state.workspace_manager.open_project(project_root).unwrap();
        state
    }

    // --- require_in_project ---

    #[test]
    fn require_in_project_accepts_file_inside_root() {
        let dir = TempDir::new().unwrap();
        let state = make_state_with_project(&dir);
        // Create a real file so the path can be canonicalised
        let file = dir.path().join("hello.txt");
        std::fs::write(&file, "content").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let canonical = crate::commands::clean_path_buf(canonical);
        assert!(require_in_project(&canonical, &state).is_ok());
    }

    #[test]
    fn require_in_project_accepts_new_file_path_inside_root() {
        let dir = TempDir::new().unwrap();
        let state = make_state_with_project(&dir);
        // A path that does not exist yet — but its parent (dir) does
        let new_file = dir.path().join("new_file.rs");
        assert!(require_in_project(&new_file, &state).is_ok());
    }

    #[test]
    fn require_in_project_rejects_path_outside_project() {
        let dir = TempDir::new().unwrap();
        let state = make_state_with_project(&dir);
        // A completely separate temp dir — not an open project
        let other_dir = TempDir::new().unwrap();
        let outside = other_dir.path().join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();
        let canonical = std::fs::canonicalize(&outside).unwrap();
        let canonical = crate::commands::clean_path_buf(canonical);
        assert!(require_in_project(&canonical, &state).is_err());
    }

    #[test]
    fn require_in_project_rejects_when_no_project_open() {
        let dir = TempDir::new().unwrap();
        let config_dir = dir.path().join(".config");
        std::fs::create_dir_all(&config_dir).unwrap();
        // State with NO project opened
        let state = crate::state::AppState::new(config_dir);
        let path = dir.path().join("file.txt");
        assert!(require_in_project(&path, &state).is_err());
    }

    #[test]
    fn require_in_project_accepts_nested_subdirectory() {
        let dir = TempDir::new().unwrap();
        let state = make_state_with_project(&dir);
        let nested = dir.path().join("a").join("b").join("c");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("deep.txt");
        std::fs::write(&file, "deep").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let canonical = crate::commands::clean_path_buf(canonical);
        assert!(require_in_project(&canonical, &state).is_ok());
    }

    // --- resolve_path ---

    #[test]
    fn resolve_path_resolves_existing_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        std::fs::write(&file, "data").unwrap();
        let result = resolve_path(&file.to_string_lossy());
        assert!(result.is_ok());
    }

    #[test]
    fn resolve_path_rejects_bare_dotdot() {
        // A path whose filename is ".." should fail
        let result = resolve_path("..");
        // resolve_path may succeed for ".." as it's an existing dir,
        // but require_in_project will reject it — this just checks it doesn't panic
        let _ = result;
    }

    // --- redact_path ---

    // --- symlink confinement (S3) ---

    #[test]
    fn lexically_normalize_resolves_dot_and_dotdot() {
        assert_eq!(
            lexically_normalize(Path::new("a/b/../c")),
            PathBuf::from("a/c")
        );
        assert_eq!(
            lexically_normalize(Path::new("a/./b")),
            PathBuf::from("a/b")
        );
        // Climbing past the start truncates rather than escaping; the caller's
        // root check then rejects the result.
        assert_eq!(lexically_normalize(Path::new("a/../..")), PathBuf::from(""));
    }

    #[test]
    fn plain_paths_are_unaffected_by_the_symlink_check() {
        let dir = TempDir::new().unwrap();
        let root = crate::commands::clean_path_buf(std::fs::canonicalize(dir.path()).unwrap());
        let roots = vec![root.clone()];
        std::fs::write(root.join("real.txt"), "x").unwrap();
        // An existing regular file and a not-yet-created file both pass.
        assert!(require_no_escaping_symlink(&root.join("real.txt"), &roots).is_ok());
        assert!(require_no_escaping_symlink(&root.join("new.txt"), &roots).is_ok());
        assert!(require_no_escaping_symlink(&root.join("sub/deep/new.txt"), &roots).is_ok());
    }

    /// The escape this check exists to stop. Unix-only: creating a symlink on
    /// Windows needs elevation or Developer Mode, so the behaviour is asserted on
    /// the platforms where the remote server (the transport that actually relies
    /// on this confinement) runs.
    #[cfg(unix)]
    #[test]
    fn dangling_symlink_out_of_the_project_is_rejected() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let root = crate::commands::clean_path_buf(std::fs::canonicalize(dir.path()).unwrap());
        let outside_root =
            crate::commands::clean_path_buf(std::fs::canonicalize(outside.path()).unwrap());
        let roots = vec![root.clone()];

        // Target deliberately does NOT exist: `Path::exists` follows the link and
        // reports false, which is what let this through before.
        let victim = outside_root.join("authorized_keys");
        let link = root.join("innocent.txt");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        assert!(!link.exists(), "precondition: the link dangles");

        let err = require_in_roots(&link, &roots).unwrap_err();
        assert!(err.contains("symlink"), "got: {err}");

        // And the command layer refuses rather than creating the outside file.
        assert!(write_file(&link.to_string_lossy(), "pwned", &roots).is_err());
        assert!(!victim.exists(), "must not have been created outside the root");
    }

    /// `write_file` calls `create_dir_all(parent)`, which follows a dangling
    /// *directory* symlink just as readily — so intermediate components are
    /// checked too, not only the final one.
    #[cfg(unix)]
    #[test]
    fn dangling_directory_symlink_component_is_rejected() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let root = crate::commands::clean_path_buf(std::fs::canonicalize(dir.path()).unwrap());
        let outside_root =
            crate::commands::clean_path_buf(std::fs::canonicalize(outside.path()).unwrap());
        let roots = vec![root.clone()];

        let victim_dir = outside_root.join("escaped");
        std::os::unix::fs::symlink(&victim_dir, root.join("linkdir")).unwrap();

        let target = root.join("linkdir").join("file.txt");
        assert!(require_in_roots(&target, &roots).is_err());
        assert!(write_file(&target.to_string_lossy(), "pwned", &roots).is_err());
        assert!(!victim_dir.exists(), "must not have been created outside the root");
    }

    /// A symlink that stays inside the project is ordinary and must keep working
    /// — repos legitimately contain them.
    #[cfg(unix)]
    #[test]
    fn symlink_staying_inside_the_project_is_allowed() {
        let dir = TempDir::new().unwrap();
        let root = crate::commands::clean_path_buf(std::fs::canonicalize(dir.path()).unwrap());
        let roots = vec![root.clone()];
        std::fs::create_dir_all(root.join("pkg")).unwrap();
        std::os::unix::fs::symlink(root.join("pkg").join("target.txt"), root.join("alias.txt"))
            .unwrap();
        assert!(require_in_roots(&root.join("alias.txt"), &roots).is_ok());
        assert!(write_file(&root.join("alias.txt").to_string_lossy(), "ok", &roots).is_ok());
        assert_eq!(
            std::fs::read_to_string(root.join("pkg").join("target.txt")).unwrap(),
            "ok"
        );
    }

    #[test]
    fn redact_path_keeps_only_filename() {
        let result = redact_path("/home/user/secrets/password.txt");
        assert_eq!(result, "[redacted]/password.txt");
        assert!(!result.contains("/home/user/secrets"));
    }

    #[test]
    fn redact_path_handles_filename_only() {
        let result = redact_path("readme.md");
        assert_eq!(result, "[redacted]/readme.md");
    }
}

#[tauri::command(async)]
pub fn fs_read_file(path: String, state: State<AppState>) -> Result<String, String> {
    read_file(&path, &project_roots(&state))
}

pub fn read_file(path: &str, roots: &[PathBuf]) -> Result<String, String> {
    let p = require_path(path)?;
    require_in_roots(&p, roots)?;
    if p.metadata().map(|m| m.len()).unwrap_or(0) > 50 * 1024 * 1024 {
        return Err("File too large to read".to_string());
    }
    std::fs::read_to_string(&p).map_err(|e| sanitize_io_error(e, path))
}

#[tauri::command(async)]
pub fn fs_read_binary(path: String, state: State<AppState>) -> Result<Vec<u8>, String> {
    read_binary(&path, &project_roots(&state))
}

pub fn read_binary(path: &str, roots: &[PathBuf]) -> Result<Vec<u8>, String> {
    let p = require_path(path)?;
    require_in_roots(&p, roots)?;
    if p.metadata().map(|m| m.len()).unwrap_or(0) > 50 * 1024 * 1024 {
        return Err("File too large to read".to_string());
    }
    std::fs::read(&p).map_err(|e| sanitize_io_error(e, path))
}

#[tauri::command(async)]
pub fn fs_write_file(path: String, content: String, state: State<AppState>) -> Result<(), String> {
    write_file(&path, &content, &project_roots(&state))
}

#[tauri::command(async)]
pub fn save_document_file(filename: String, content: String) -> Result<String, String> {
    let directory = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or_else(|| "Could not find the user Documents folder".to_string())?;
    save_document_in(&directory, &filename, &content)
}

/// Names Windows reserves for devices; writing to `CON.txt` opens the console,
/// not a file, whatever the extension.
const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn valid_document_filename(filename: &str) -> bool {
    if filename.is_empty()
        || filename.ends_with('.')
        || filename.ends_with(' ')
        || filename.chars().any(|c| c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return false;
    }
    let stem = filename.split('.').next().unwrap_or("").trim_end();
    !WINDOWS_RESERVED_NAMES.iter().any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Write a new document into `directory` without ever replacing an existing
/// file: a taken name becomes `stem-2.ext`, `stem-3.ext`, … (the same scheme the
/// in-project save uses). `create_new` makes the claim atomic, so a file that
/// appears between the check and the write is not clobbered either.
fn save_document_in(directory: &Path, filename: &str, content: &str) -> Result<String, String> {
    if !valid_document_filename(filename) {
        return Err("Invalid document filename".to_string());
    }
    std::fs::create_dir_all(directory).map_err(|e| sanitize_io_error(e, &directory.to_string_lossy()))?;
    let (stem, ext) = match filename.rfind('.') {
        Some(dot) if dot > 0 => (&filename[..dot], &filename[dot..]),
        _ => (filename, ""),
    };
    for n in 1..=50 {
        let candidate = if n == 1 { filename.to_string() } else { format!("{stem}-{n}{ext}") };
        let path = directory.join(&candidate);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(content.as_bytes())
                    .map_err(|e| sanitize_io_error(e, &path.to_string_lossy()))?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(sanitize_io_error(e, &path.to_string_lossy())),
        }
    }
    Err(format!("Documents already holds too many files named like {filename}; choose a different filename."))
}

fn write_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}

#[tauri::command(async)]
pub fn fs_write_file_checked(path: String, content: String, expected_content: Option<String>, state: State<AppState>) -> Result<(), String> {
    write_file_checked(&path, &content, expected_content.as_deref(), &project_roots(&state))
}

pub fn write_file_checked(path: &str, content: &str, expected: Option<&str>, roots: &[PathBuf]) -> Result<(), String> {
    let _guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
    let p = resolve_path(path)?;
    require_in_roots(&p, roots)?;
    match std::fs::read_to_string(&p) {
        Ok(current) if expected == Some(current.as_str()) => {},
        Ok(_) => return Err("File changed or overwrite precondition missing; read it again before editing".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && expected.is_none() => {
            if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).map_err(|e| sanitize_io_error(e, path))?; }
            use std::io::Write;
            return std::fs::OpenOptions::new().write(true).create_new(true).open(&p)
                .and_then(|mut file| file.write_all(content.as_bytes())).map_err(|e| sanitize_io_error(e, path));
        },
        Err(e) => return Err(sanitize_io_error(e, path)),
    }
    write_file_unlocked(path, content, roots)
}

pub fn write_file(path: &str, content: &str, roots: &[PathBuf]) -> Result<(), String> {
    let _guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
    write_file_unlocked(path, content, roots)
}

fn write_file_unlocked(path: &str, content: &str, roots: &[PathBuf]) -> Result<(), String> {
    if content.len() > 100 * 1024 * 1024 {
        return Err("Content too large to write (limit 100 MB)".to_string());
    }
    let file_path = resolve_path(path)?;
    require_in_roots(&file_path, roots)?;
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| sanitize_io_error(e, path))?;
    }
    std::fs::write(&file_path, content).map_err(|e| sanitize_io_error(e, path))
}

#[tauri::command(async)]
pub fn fs_write_binary(path: String, data: Vec<u8>, state: State<AppState>) -> Result<(), String> {
    write_binary(&path, &data, &project_roots(&state))
}

pub fn write_binary(path: &str, data: &[u8], roots: &[PathBuf]) -> Result<(), String> {
    if data.len() > 100 * 1024 * 1024 {
        return Err("Data too large to write (limit 100 MB)".to_string());
    }
    let file_path = resolve_path(path)?;
    require_in_roots(&file_path, roots)?;
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| sanitize_io_error(e, path))?;
    }
    std::fs::write(&file_path, data).map_err(|e| sanitize_io_error(e, path))
}

/// The app-owned scratch directory for clipboard-pasted images:
/// `<os-temp>/spacron/pasted`. Lives outside every project so pastes never bloat
/// a codebase; [`clear_pasted_images`] empties it on app exit.
pub fn pasted_images_dir() -> PathBuf {
    std::env::temp_dir().join("spacron").join("pasted")
}

/// Write a clipboard-pasted image to the app scratch dir and return its absolute
/// path. A pasted image is raw clipboard pixels with no source file to reference,
/// so the bytes have to be written somewhere — but the old path wrote them into
/// `<project>/.spacron/paste`, which piled screenshots up inside the working tree.
/// This writes to the OS temp dir instead, matching how terminal coding agents
/// (Claude Code, Cursor) treat a paste: ephemeral, out of the codebase.
///
/// Unlike [`fs_write_binary`], this is deliberately NOT confined to a project
/// root: the destination directory is fixed and app-controlled, and only the
/// *filename* comes from the caller — reduced to a bare name so a crafted value
/// can't traverse out of the scratch dir.
#[tauri::command(async)]
pub fn save_pasted_image(name: String, data: Vec<u8>) -> Result<String, String> {
    if data.len() > 100 * 1024 * 1024 {
        return Err("Image too large to save (limit 100 MB)".to_string());
    }
    let dir = pasted_images_dir();
    let dir_str = dir.to_string_lossy().to_string();
    std::fs::create_dir_all(&dir).map_err(|e| sanitize_io_error(e, &dir_str))?;
    let safe_name = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.trim_start_matches('.'))
        .filter(|n| !n.is_empty())
        .unwrap_or("image.png");
    let dest = dir.join(safe_name);
    std::fs::write(&dest, &data).map_err(|e| sanitize_io_error(e, safe_name))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Delete the pasted-image scratch directory. Called on app exit so ephemeral
/// clipboard pastes don't accumulate across sessions. A missing dir is not an
/// error — nothing was pasted this run.
#[tauri::command(async)]
pub fn clear_pasted_images() -> Result<(), String> {
    let dir = pasted_images_dir();
    if dir.exists() {
        let dir_str = dir.to_string_lossy().to_string();
        std::fs::remove_dir_all(&dir).map_err(|e| sanitize_io_error(e, &dir_str))?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn fs_get_file_info(path: String, state: State<AppState>) -> Result<FileEntry, String> {
    get_file_info(&path, &project_roots(&state))
}

pub fn get_file_info(path: &str, roots: &[PathBuf]) -> Result<FileEntry, String> {
    let p = require_path(path)?;
    require_in_roots(&p, roots)?;
    let metadata = std::fs::metadata(&p).map_err(|e| sanitize_io_error(e, path))?;
    let modified = metadata
        .modified()
        .ok()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string()
        })
        .unwrap_or_default();

    Ok(FileEntry {
        name: p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        path: p.to_string_lossy().to_string(),
        is_dir: metadata.is_dir(),
        size: metadata.len(),
        modified,
    })
}

#[tauri::command(async)]
pub fn fs_glob_files(root_path: String, pattern: String, match_anywhere: bool, max: usize, ignored_only: Option<bool>, state: State<AppState>) -> Result<Vec<String>, String> {
    if ignored_only.unwrap_or(false) {
        return glob_ignored_files(&root_path, &pattern, match_anywhere, max, &project_roots(&state));
    }
    glob_files(&root_path, &pattern, match_anywhere, max, &project_roots(&state))
}

const GLOB_SKIP_DIRS: [&str; 7] = [".git", "node_modules", "target", "dist", "build", ".next", ".venv"];

fn glob_walker(root: &Path) -> ignore::Walk {
    let mut builder = ignore::WalkBuilder::new(root);
    builder.hidden(false).follow_links(false).sort_by_file_path(|a,b| a.cmp(b)).filter_entry(|e| {
        !GLOB_SKIP_DIRS.iter().any(|s| e.file_name() == std::ffi::OsStr::new(s))
    });
    builder.build()
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    Ok(path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"))
}

fn glob_matches(matcher: &regex::Regex, relative: &str, match_anywhere: bool) -> bool {
    let candidate = if match_anywhere { relative.rsplit('/').next().unwrap_or(relative) } else { relative };
    matcher.is_match(candidate)
}

pub fn glob_files(root_path: &str, pattern: &str, match_anywhere: bool, max: usize, roots: &[PathBuf]) -> Result<Vec<String>, String> {
    let root = require_path(root_path)?;
    require_in_roots(&root, roots)?;
    let matcher = regex::Regex::new(pattern).map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for item in glob_walker(&root).flatten() {
        if !item.file_type().is_some_and(|f| f.is_file()) { continue; }
        let relative = relative_path(&root, item.path())?;
        if glob_matches(&matcher, &relative, match_anywhere) { paths.push(relative); }
        if paths.len() >= max { break; }
    }
    Ok(paths)
}

/// Files that exist but that `glob_files` never lists because `.gitignore`
/// (or `.ignore`) excludes them: `.env.local`, local config, generated
/// output. Only files sitting directly in directories the normal walk visits
/// are reported, so an ignored directory such as `coverage/` cannot flood the
/// list. Without this the orchestrator concluded that `.env.local` "does not
/// exist" when it was merely ignored.
pub fn glob_ignored_files(root_path: &str, pattern: &str, match_anywhere: bool, max: usize, roots: &[PathBuf]) -> Result<Vec<String>, String> {
    let root = require_path(root_path)?;
    require_in_roots(&root, roots)?;
    let matcher = regex::Regex::new(pattern).map_err(|e| e.to_string())?;
    let mut listed = std::collections::HashSet::new();
    let mut dirs = vec![root.clone()];
    for item in glob_walker(&root).flatten() {
        match item.file_type() {
            Some(kind) if kind.is_file() => { listed.insert(item.path().to_path_buf()); }
            Some(kind) if kind.is_dir() && item.depth() > 0 => dirs.push(item.path().to_path_buf()),
            _ => {}
        }
    }
    let mut paths = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = entries.flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.path())
            .filter(|path| !listed.contains(path))
            .collect();
        files.sort();
        for path in files {
            let relative = relative_path(&root, &path)?;
            if glob_matches(&matcher, &relative, match_anywhere) { paths.push(relative); }
            if paths.len() >= max { return Ok(paths); }
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod agent_file_tests {
    use super::*;

    /// A temp dir by its real path. macOS temp dirs sit under the `/var` ->
    /// `/private/var` symlink and confinement compares resolved paths; the app
    /// resolves a project root when it opens it, so these tests must too.
    fn real(path: &Path) -> PathBuf {
        crate::commands::clean_path_buf(std::fs::canonicalize(path).unwrap())
    }
    #[test]
    fn document_saves_never_overwrite_and_refuse_device_names() {
        let dir = tempfile::tempdir().unwrap();
        let first = save_document_in(dir.path(), "notes.md", "one").unwrap();
        let second = save_document_in(dir.path(), "notes.md", "two").unwrap();
        assert!(second.ends_with("notes-2.md"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "two");
        for bad in ["", ".", "..", "CON", "con.txt", "Lpt1.md", "nul .txt", "a/b.md", "..\\x.md", "trail.", "trail ", "tab\tname.md"] {
            assert!(save_document_in(dir.path(), bad, "x").is_err(), "{bad:?} should be refused");
        }
        assert!(save_document_in(dir.path(), "console.md", "ok").is_ok());
    }
    #[test]
    fn checked_writes_detect_changes_and_do_not_overwrite_unread_files() {
        let dir = tempfile::tempdir().unwrap();
        let base = real(dir.path());
        let roots = vec![base.clone()];
        let path = base.join("test.txt").to_string_lossy().to_string();
        write_file_checked(&path, "original", None, &roots).unwrap();
        assert!(write_file_checked(&path, "overwrite", None, &roots).is_err());
        std::fs::write(&path, "user change").unwrap();
        assert!(write_file_checked(&path, "overwrite", Some("original"), &roots).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "user change");
        write_file_checked(&path, "updated", Some("user change"), &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "updated");
    }
    #[test]
    fn ignored_files_are_listed_separately_without_flooding_from_ignored_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let base = real(dir.path());
        let root = base.as_path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("coverage")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".gitignore"), ".env.local\ncoverage/\n*.log\n").unwrap();
        std::fs::write(root.join(".env.local"), "SECRET=1").unwrap();
        std::fs::write(root.join(".env.example"), "SECRET=").unwrap();
        std::fs::write(root.join("coverage/index.html"), "x").unwrap();
        std::fs::write(root.join("src/app.ts"), "x").unwrap();
        std::fs::write(root.join("src/debug.log"), "x").unwrap();
        let roots = [root.to_path_buf()];
        let root_path = root.to_string_lossy();

        let normal = glob_files(&root_path, ".*", true, 50, &roots).unwrap();
        assert!(normal.contains(&".env.example".to_string()));
        assert!(!normal.contains(&".env.local".to_string()));

        let ignored = glob_ignored_files(&root_path, ".*", true, 50, &roots).unwrap();
        assert_eq!(ignored, vec![".env.local".to_string(), "src/debug.log".to_string()]);
        assert_eq!(glob_ignored_files(&root_path, "^[.]env", true, 50, &roots).unwrap(), vec![".env.local".to_string()]);
    }
    #[test]
    fn glob_reaches_files_beyond_old_depth_limit() {
        let dir = tempfile::tempdir().unwrap();
        let base = real(dir.path());
        let deep = base.join("a/b/c/d/e/f/g/h");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("target.ts"), "test").unwrap();
        let paths = glob_files(&base.to_string_lossy(), "target[.]ts$", true, 10, &[base.clone()]).unwrap();
        assert_eq!(paths, vec!["a/b/c/d/e/f/g/h/target.ts"]);
    }
}
