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

    pub fn list_ids(&self) -> Vec<u32> {
        self.sessions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect()
    }
}
