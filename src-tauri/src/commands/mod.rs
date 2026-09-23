pub mod activity_stats;
pub mod agent_accounts;
pub mod agent_models;
pub mod agent_probe;
pub mod agent_signals;
pub mod app_flags;
pub mod audio;
pub mod background;
pub mod browser_shim;
pub mod browser_tools;
pub mod chatgpt;
pub mod deepseek_harness;
pub mod db;
pub mod deps;
pub mod env_vars;
pub mod file_system;
pub mod fs_watch;
pub mod github;
pub mod http;
pub mod images;
pub mod jev;
pub mod media;
pub mod keep_awake;
pub mod lsp;
pub mod mcp;
pub mod emulator_grpc;
pub mod mobile;
pub mod mobile_stream;
pub mod ios_sim;
pub mod music_library;
pub mod notification;
pub mod open_with;
pub mod launch;
pub mod onnx_runtime;
pub mod parakeet;
pub mod preview;
pub mod project_state;
pub mod remote_deploy;
pub mod remote_relay;
pub mod search;
pub mod secrets;
pub mod terminal;
pub mod theme;
pub mod usage;
pub mod usage_stats;
pub mod vad;
pub mod web_session;
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
