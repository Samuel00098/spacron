//! What the user wrote about themselves (Settings > Bots > About you), as a file
//! every agent Spacron launches can read.
//!
//! Agents get the file's path in `$SPACRON_ABOUT_YOU_FILE` and are told in the
//! standing brief to read it. The text itself never goes into the brief: that is
//! written into each project's rules files (CLAUDE.md, AGENTS.md, …), which can be
//! committed, so only the variable's name may appear there. The file lives in the
//! app's own config folder, outside every project.

use std::path::PathBuf;

const MAX_CHARS: usize = 2000;

fn about_you_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("spacron").join("about-you.md"))
}

/// Save (or, for empty text, remove) the file. Returns its path when there is one.
#[tauri::command]
pub fn about_you_sync(text: String) -> Option<String> {
    let path = about_you_path()?;
    let clean: String = text.trim().chars().take(MAX_CHARS).collect();
    if clean.is_empty() {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    std::fs::create_dir_all(path.parent()?).ok()?;
    let body = format!("# About the user\n\nWritten by the user in Spacron so you can work well with them. Keep it private: never copy it into project files, commits or messages to anyone else.\n\n{clean}\n");
    std::fs::write(&path, body).ok()?;
    Some(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_the_text_and_frames_it_as_private() {
        let long = "x".repeat(MAX_CHARS + 100);
        let clean: String = long.trim().chars().take(MAX_CHARS).collect();
        assert_eq!(clean.chars().count(), MAX_CHARS);
        assert!(about_you_path().is_some_and(|p| p.ends_with("about-you.md")));
    }
}
