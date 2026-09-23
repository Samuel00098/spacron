use super::clean_path_buf;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Paths passed to the desktop executable by Explorer's "Open with Spacron"
/// command.  The installer only passes one path, but accepting all existing
/// non-option arguments keeps this useful for manual launches and future shell
/// integrations too.
#[tauri::command]
pub fn app_launch_paths() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    project_paths_from_args(std::env::args_os().skip(1), &cwd)
}

/// Project folders named by a command line (without the executable itself).
/// Relative paths resolve against `cwd`, which for a forwarded second launch is
/// that process's working directory, not this one's.
pub fn project_paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    args.into_iter()
        .map(Into::into)
        .filter(|arg| !arg.to_string_lossy().starts_with('-'))
        .filter_map(|arg| resolve_project_path(cwd.join(arg)))
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn resolve_project_path(path: PathBuf) -> Option<PathBuf> {
    let path = path.canonicalize().ok().map(clean_path_buf)?;
    if path.is_dir() {
        Some(path)
    } else {
        path.parent()
            .map(PathBuf::from)
            .filter(|parent| parent.is_dir())
    }
}

#[cfg(test)]
mod tests {
    use super::{project_paths_from_args, resolve_project_path};
    use std::fs;

    #[test]
    fn folder_paths_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_project_path(root.path().to_path_buf()),
            Some(root.path().to_path_buf())
        );
    }

    #[test]
    fn forwarded_args_skip_flags_and_resolve_relative_paths() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("app")).unwrap();
        let paths = project_paths_from_args(["--flag", "app", "missing"], root.path());
        let expected = resolve_project_path(root.path().join("app")).unwrap();
        assert_eq!(paths, vec![expected.to_string_lossy().into_owned()]);
    }

    #[test]
    fn file_paths_resolve_to_their_parent_folder() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("main.rs");
        fs::write(&file, "fn main() {}").unwrap();
        assert_eq!(resolve_project_path(file), Some(root.path().to_path_buf()));
    }
}
