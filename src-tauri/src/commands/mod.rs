pub mod app_flags;
pub mod audio;
pub mod background;
pub mod db;
pub mod deps;
pub mod env_vars;
pub mod file_system;
pub mod fs_watch;
pub mod github;
pub mod http;
pub mod lsp;
pub mod mobile;
pub mod notification;
pub mod parakeet;
pub mod preview;
pub mod search;
pub mod secrets;
pub mod terminal;
pub mod theme;
#[cfg(feature = "whisper-stt")]
pub mod whisper;
pub mod workspace;
pub mod models;

use std::path::PathBuf;

pub fn clean_path_buf(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let path_str = path.to_string_lossy();
        if path_str.starts_with(r"\\?\UNC\") {
            return PathBuf::from(format!("\\{}", &path_str[7..]));
        } else if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}
