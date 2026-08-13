use crate::commands::resource::{DiskUsageCache, ResourceSampler};
use crate::lsp::bridge::LspBridge;
use crate::preview::PreviewManager;
use crate::pty::manager::PtyManager;
use crate::theme::registry::ThemeRegistry;
use crate::workspace::manager::WorkspaceManager;
use std::path::PathBuf;
use std::sync::Arc;

/// Per-session write rate limiter: tracks (window_start, bytes_in_window).
/// Resets each second; caps at 1 MB/s per session to prevent runaway write loops.
pub struct WriteRateLimiter {
    pub sessions: dashmap::DashMap<u32, (std::time::Instant, usize)>,
}

impl WriteRateLimiter {
    pub fn new() -> Self {
        Self {
            sessions: dashmap::DashMap::new(),
        }
    }

    /// Returns true if the write is allowed, false if the rate limit is exceeded.
    pub fn check_and_record(&self, session_id: u32, byte_count: usize) -> bool {
        const MAX_BYTES_PER_SEC: usize = 1024 * 1024; // 1 MB/s
        let now = std::time::Instant::now();
        let mut entry = self.sessions.entry(session_id).or_insert((now, 0));
        if entry.0.elapsed().as_secs() >= 1 {
            *entry = (now, byte_count);
            true
        } else if entry.1 + byte_count > MAX_BYTES_PER_SEC {
            false
        } else {
            entry.1 += byte_count;
            true
        }
    }

    pub fn remove(&self, session_id: u32) {
        self.sessions.remove(&session_id);
    }
}

pub struct AppState {
    pub theme_registry: ThemeRegistry,
    pub workspace_manager: WorkspaceManager,
    pub pty_manager: Arc<PtyManager>,
    pub lsp_bridge: LspBridge,
    pub preview_manager: PreviewManager,
    pub write_rate_limiter: WriteRateLimiter,
    pub config_dir: PathBuf,
    /// Persistent sysinfo sampler for the resource monitor. Lives across
    /// `resource_snapshot` calls so CPU deltas are computed between polls
    /// rather than from a cold baseline every time.
    pub resource_sampler: ResourceSampler,
    /// TTL cache for `project_disk_usage` scans — walking a project tree is
    /// too slow to redo on every poll, so sizes stay fresh for a minute.
    pub disk_usage_cache: DiskUsageCache,
}

impl AppState {
    pub fn new(config_dir: PathBuf) -> Self {
        let active_project_id = std::sync::Arc::new(std::sync::RwLock::new(None));
        AppState {
            theme_registry: ThemeRegistry::new(config_dir.clone()),
            workspace_manager: WorkspaceManager::new(config_dir.clone(), active_project_id.clone()),
            pty_manager: Arc::new(PtyManager::new()),
            lsp_bridge: LspBridge::new(),
            preview_manager: PreviewManager::new(active_project_id, config_dir.clone()),
            write_rate_limiter: WriteRateLimiter::new(),
            resource_sampler: ResourceSampler::default(),
            disk_usage_cache: DiskUsageCache::default(),
            config_dir,
        }
    }
}
