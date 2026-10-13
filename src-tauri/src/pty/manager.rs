use crate::pty::session::PtySession;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::RwLock;

pub struct PtyManager {
    sessions: RwLock<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session: PtySession) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, session);
        id
    }

    /// Allocate a session id without inserting anything. Used by the remote
    /// server, whose output sinks need the id up front (to tag WebSocket frames)
    /// before the session is spawned and inserted via [`Self::insert_with_id`].
    pub fn reserve_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Insert a session under an id previously handed out by [`Self::reserve_id`].
    pub fn insert_with_id(&self, id: u32, session: PtySession) {
        self.sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, session);
    }

    pub fn get(&self, id: u32) -> Option<PtySession> {
        self.sessions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
    }

    pub fn remove(&self, id: u32) -> Option<PtySession> {
        self.sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
    }

    /// Remove and close every session that was started inside `root`. Returns
    /// the closed ids. Paths are compared case-insensitively on Windows, where
    /// the same folder can arrive spelled with different casing.
    pub fn close_under(&self, root: &std::path::Path) -> Vec<u32> {
        let closed: Vec<(u32, PtySession)> = {
            let mut sessions = self.sessions.write().unwrap_or_else(|e| e.into_inner());
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, s)| is_under(&s.cwd, root))
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id).map(|s| (id, s)))
                .collect()
        };
        closed
            .into_iter()
            .map(|(id, session)| {
                let _ = session.close();
                id
            })
            .collect()
    }

    pub fn list_ids(&self) -> Vec<u32> {
        self.sessions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect()
    }
}

/// Whether `path` is `root` or somewhere beneath it, compared as text so it
/// works for folders that may already be gone. Separator- and (on Windows)
/// case-insensitive; `/a/bc` is not under `/a/b`.
fn is_under(path: &std::path::Path, root: &std::path::Path) -> bool {
    let norm = |p: &std::path::Path| {
        let s = p.to_string_lossy().replace('\\', "/");
        let s = s.trim_end_matches('/').to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    let (path, root) = (norm(path), norm(root));
    path == root || path.starts_with(&format!("{root}/"))
}

#[cfg(test)]
mod tests {
    use super::is_under;
    use std::path::Path;

    #[test]
    fn matches_the_root_and_its_descendants_only() {
        assert!(is_under(Path::new("/p/new"), Path::new("/p/new")));
        assert!(is_under(Path::new("/p/new/src"), Path::new("/p/new/")));
        assert!(!is_under(Path::new("/p/newer"), Path::new("/p/new")));
        assert!(!is_under(Path::new("/p"), Path::new("/p/new")));
    }

    #[cfg(windows)]
    #[test]
    fn ignores_case_and_separator_style_on_windows() {
        assert!(is_under(Path::new(r"C:\Proj\New\src"), Path::new("c:/proj/new")));
    }
}
