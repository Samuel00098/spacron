use crate::state::AppState;
use crate::workspace::project::Project;
use std::path::{Path, PathBuf};
use tauri::State;

fn chat_root(config_dir: &Path, workspace_id: &str) -> Result<PathBuf, String> {
    if workspace_id.is_empty() || workspace_id.len() > 128
        || !workspace_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("Invalid chat workspace identifier".into());
    }
    let base = config_dir.join("chat-files");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let base = std::fs::canonicalize(base).map_err(|e| e.to_string())?;
    let root = base.join(workspace_id);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !root.starts_with(&base) { return Err("Chat workspace is outside its file area".into()); }
    Ok(crate::commands::clean_path_buf(root))
}

#[tauri::command(async)]
pub fn chat_workspace_open(workspace_id: String, state: State<AppState>) -> Result<Project, String> {
    let root = chat_root(&state.config_dir, &workspace_id)?;
    Ok(state.workspace_manager.register_chat_workspace(&workspace_id, root))
}

#[tauri::command(async)]
pub fn chat_workspace_reveal(workspace_id: String, app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let root = chat_root(&state.config_dir, &workspace_id)?;
    #[allow(deprecated)]
    app.shell().open(root.to_string_lossy().as_ref(), None).map_err(|e| format!("Could not open chat files: {e}"))
}

fn copy_chat_files(source: &Path, target: &Path, root: &Path, files: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        // Execution checkpoints and worker leases belong to the original chat.
        if source == root && entry.file_name() == ".spacron" { continue; }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() { return Err("Chat files contain a symbolic link. Export regular files before creating a project.".into()); }
        let from = entry.path();
        let to = target.join(entry.file_name());
        if kind.is_dir() {
            if to.exists() && std::fs::symlink_metadata(&to).map_err(|e| e.to_string())?.file_type().is_symlink() {
                return Err("Project destination contains a symbolic link".into());
            }
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            copy_chat_files(&from, &to, root, files)?;
        } else if kind.is_file() {
            let bytes = std::fs::read(&from).map_err(|e| e.to_string())?;
            use std::io::Write;
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&to) {
                Ok(mut file) => file.write_all(&bytes).map_err(|e| e.to_string())?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = std::fs::symlink_metadata(&to).map_err(|e| e.to_string())?;
                    if !metadata.is_file() || metadata.file_type().is_symlink() || std::fs::read(&to).map_err(|e| e.to_string())? != bytes {
                        return Err("An exported chat file already exists with different content; it was not overwritten.".into());
                    }
                }
                Err(e) => return Err(e.to_string()),
            }
            files.push(from.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn chat_workspace_export(workspace_id: String, project_id: String, state: State<AppState>) -> Result<Vec<String>, String> {
    let source = chat_root(&state.config_dir, &workspace_id)?;
    let project = state.workspace_manager.list_projects().into_iter().find(|p| p.id == project_id && !p.id.starts_with("chat-"))
        .ok_or_else(|| "Open the destination project before exporting chat files".to_string())?;
    let target = std::fs::canonicalize(&project.root_path).map_err(|e| e.to_string())?;
    if target.starts_with(&source) || source.starts_with(&target) { return Err("The chat and project file areas must be separate".into()); }
    let mut files = Vec::new();
    copy_chat_files(&source, &target, &source, &mut files)?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf { let path = std::env::temp_dir().join(format!("spacron-chat-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir_all(&path).unwrap(); path }
    #[test]
    fn chat_paths_are_stable_and_identifiers_cannot_escape() {
        let config = temporary();
        let root = chat_root(&config, "chat-thread-123").unwrap();
        assert_eq!(root, chat_root(&config, "chat-thread-123").unwrap());
        for id in ["../outside", "", "a/b", "C:\\outside"] { assert!(chat_root(&config, id).is_err()); }
        std::fs::remove_dir_all(config).unwrap();
    }
    #[test]
    fn registering_chat_files_keeps_the_active_project_and_recents() {
        let base = temporary();
        let manager = crate::workspace::manager::WorkspaceManager::new(base.clone(), std::sync::Arc::new(std::sync::RwLock::new(None)));
        let project = manager.open_project(base.clone()).unwrap();
        manager.set_active_project(Some(project.id.clone()));
        let chat = manager.register_chat_workspace("standalone-123", chat_root(&base, "standalone-123").unwrap());
        assert_eq!(chat.id, "chat-standalone-123");
        assert_eq!(manager.get_active_project().unwrap().id, project.id);
        assert_eq!(manager.get_recent_projects().len(), 1);
        assert!(manager.list_projects().iter().any(|p| p.id == chat.id));
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn export_preserves_files_and_retries_without_overwriting_or_copying_checkpoints() {
        let base = temporary(); let source = base.join("source"); let target = base.join("target");
        std::fs::create_dir_all(source.join("notes")).unwrap(); std::fs::create_dir_all(source.join(".spacron")).unwrap(); std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("notes/idea.md"), "Keep this decision").unwrap(); std::fs::write(source.join(".spacron/checkpoint.json"), "private state").unwrap();
        let mut files = vec![]; copy_chat_files(&source, &target, &source, &mut files).unwrap();
        assert_eq!(files, vec!["notes/idea.md"]); assert!(!target.join(".spacron").exists());
        copy_chat_files(&source, &target, &source, &mut vec![]).unwrap();
        std::fs::write(target.join("notes/idea.md"), "User changed this").unwrap();
        assert!(copy_chat_files(&source, &target, &source, &mut vec![]).is_err());
        assert_eq!(std::fs::read_to_string(target.join("notes/idea.md")).unwrap(), "User changed this");
        std::fs::remove_dir_all(base).unwrap();
    }
}
