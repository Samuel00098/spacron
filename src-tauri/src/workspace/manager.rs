use crate::error::ForgeError;
use crate::workspace::project::{Project, RecentProject};
use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub struct WorkspaceManager {
    projects: DashMap<String, Project>,
    pub active_project_id: std::sync::Arc<RwLock<Option<String>>>,
    recent_projects: RwLock<Vec<RecentProject>>,
    #[allow(dead_code)]
    config_dir: PathBuf,
}

impl WorkspaceManager {
    pub fn new(
        config_dir: PathBuf,
        active_project_id: std::sync::Arc<RwLock<Option<String>>>,
    ) -> Self {
        let recent_projects = Self::load_recent(&config_dir);
        WorkspaceManager {
            projects: DashMap::new(),
            active_project_id,
            recent_projects: RwLock::new(recent_projects),
            config_dir,
        }
    }

    pub fn set_active_project(&self, id: Option<String>) {
        if let Ok(mut active) = self.active_project_id.write() {
            *active = id;
        }
    }

    fn save_recent(&self) {
        if let Ok(recents) = self.recent_projects.read() {
            let path = self.config_dir.join("recent_projects.json");
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            if let Ok(content) = serde_json::to_string_pretty(&*recents) {
                std::fs::write(path, content).ok();
            }
        }
    }

    fn load_recent(config_dir: &Path) -> Vec<RecentProject> {
        let path = config_dir.join("recent_projects.json");
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(recents) = serde_json::from_str(&content) {
                    return recents;
                }
            }
        }
        Vec::new()
    }

    pub fn open_project(&self, root_path: PathBuf) -> Result<Project, ForgeError> {
        // Reuse an existing project for the same path so its id stays stable
        // across workspace switches. The frontend keys all per-project state
        // (live terminal sessions, editor/preview caches, localStorage) by the
        // project id; minting a fresh id on every open would orphan running
        // terminals when a workspace is re-entered.
        if let Some(existing) = self
            .projects
            .iter()
            .find(|entry| entry.value().root_path == root_path)
            .map(|entry| entry.value().clone())
        {
            self.add_to_recent(&existing);
            return Ok(existing);
        }

        let mut project = Project::new(root_path.clone());
        // A project normally has a path-derived id. A root-folder rename is the
        // one exception: keep the remembered id written by `rename_project` so
        // every per-project store continues to address the same project after a
        // restart, even though its canonical path changed.
        if let Some(remembered_id) = self.recent_projects.read().ok().and_then(|recents| {
            recents
                .iter()
                .find(|recent| recent.root_path == root_path)
                .map(|recent| recent.id.clone())
        }) {
            if !self.projects.contains_key(&remembered_id) {
                project.id = remembered_id;
            }
        }
        let id = project.id.clone();
        self.projects.insert(id.clone(), project.clone());

        self.add_to_recent(&project);
        Ok(project)
    }

    pub fn rename_project(&self, project_id: &str, new_name: &str) -> Result<Project, String> {
        let project = self
            .projects
            .get(project_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| "Project not found".to_string())?;
        let old_root = project.root_path.clone();
        let parent = old_root
            .parent()
            .ok_or_else(|| "The project folder cannot be renamed.".to_string())?;
        let target = parent.join(new_name);
        if target.exists() {
            return Err(format!(
                "A folder named \"{new_name}\" already exists here."
            ));
        }

        std::fs::rename(&old_root, &target)
            .map_err(|error| format!("Failed to rename the project folder: {}", error.kind()))?;
        let new_root =
            crate::commands::clean_path_buf(std::fs::canonicalize(&target).unwrap_or(target));
        let mut renamed = project;
        renamed.name = new_name.to_string();
        renamed.root_path = new_root.clone();
        renamed.state.open_files = renamed
            .state
            .open_files
            .iter()
            .map(|path| rebase_path(path, &old_root, &new_root))
            .collect();
        renamed.state.active_file = renamed
            .state
            .active_file
            .as_ref()
            .map(|path| rebase_path(path, &old_root, &new_root));
        self.projects
            .insert(project_id.to_string(), renamed.clone());

        if let Ok(mut recents) = self.recent_projects.write() {
            recents.retain(|recent| {
                recent.id != project_id
                    && recent.root_path != old_root
                    && recent.root_path != new_root
            });
            recents.insert(
                0,
                RecentProject {
                    id: renamed.id.clone(),
                    name: renamed.name.clone(),
                    root_path: renamed.root_path.clone(),
                    last_opened: renamed.state.last_modified.clone(),
                },
            );
            if recents.len() > 20 {
                recents.truncate(20);
            }
        }
        self.save_recent();
        Ok(renamed)
    }

    pub fn get_active_project(&self) -> Option<Project> {
        let active_id = self.active_project_id.read().ok()?.clone()?;
        self.projects.get(&active_id).map(|p| p.value().clone())
    }

    pub fn list_projects(&self) -> Vec<Project> {
        self.projects
            .iter()
            .map(|entry| entry.value().clone())
            .collect()
    }

    pub fn get_recent_projects(&self) -> Vec<RecentProject> {
        self.recent_projects
            .read()
            .ok()
            .map(|r| r.clone())
            .unwrap_or_default()
    }

    fn add_to_recent(&self, project: &Project) {
        let recent = RecentProject {
            id: project.id.clone(),
            name: project.name.clone(),
            root_path: project.root_path.clone(),
            last_opened: project.state.last_modified.clone(),
        };

        if let Ok(mut recents) = self.recent_projects.write() {
            // Dedup by path as well as id so a folder that was saved under an
            // older random id is replaced by its deterministic-id entry.
            recents.retain(|r| r.id != recent.id && r.root_path != recent.root_path);
            recents.insert(0, recent);
            if recents.len() > 20 {
                recents.truncate(20);
            }
        }
        self.save_recent();
    }

    pub fn clear_recent_projects(&self) {
        if let Ok(mut recents) = self.recent_projects.write() {
            recents.clear();
        }
        self.save_recent();
    }
}

fn rebase_path(path: &Path, old_root: &Path, new_root: &Path) -> PathBuf {
    path.strip_prefix(old_root)
        .map(|suffix| new_root.join(suffix))
        .unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, RwLock};

    #[test]
    fn renaming_a_project_keeps_its_id_across_restart() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("before");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("file.txt"), "kept").unwrap();
        let active = Arc::new(RwLock::new(None));
        let manager = WorkspaceManager::new(temp.path().join("config"), active);
        let project = manager.open_project(root.clone()).unwrap();

        let renamed = manager.rename_project(&project.id, "after").unwrap();
        assert_eq!(renamed.id, project.id);
        assert!(!root.exists());
        assert!(renamed.root_path.join("file.txt").exists());

        let reopened =
            WorkspaceManager::new(temp.path().join("config"), Arc::new(RwLock::new(None)))
                .open_project(renamed.root_path)
                .unwrap();
        assert_eq!(reopened.id, project.id);
    }
}
