//! Disk-persisted cookie jar for the preview proxy.
//!
//! The proxy's upstream client owns the cookies for proxied external sites (the
//! browser can't — every proxied site shares the loopback proxy origin, so
//! site-scoped Set-Cookie headers would be rejected as domain mismatches).
//! reqwest's built-in `Jar` is memory-only *and* the proxy listens on a fresh
//! ephemeral port each run, so before this jar existed every login died with
//! the app session. `PersistentJar` implements the same `reqwest::cookie::
//! CookieStore` contract on top of `cookie_store::CookieStore`, loads from disk
//! at startup, and is flushed back by a debounced saver task.
//!
//! Only *persistent* cookies (ones with an expiry / Max-Age — i.e. "remember
//! me" logins) are written to disk; session cookies evaporate on restart,
//! matching real browser behavior. The file is plain JSON in the app config
//! dir, readable only by the user's own account.

use std::collections::HashMap;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::HeaderValue;

pub struct PersistentJar {
    store: RwLock<cookie_store::CookieStore>,
    path: PathBuf,
    dirty: AtomicBool,
    saver_started: AtomicBool,
}

impl PersistentJar {
    /// Load the jar from `path` (an empty jar when the file is missing or
    /// unreadable — a corrupt cookie file must never break the preview).
    pub fn load(path: PathBuf) -> Arc<Self> {
        let store = std::fs::File::open(&path)
            .ok()
            .and_then(|file| cookie_store::serde::json::load(BufReader::new(file)).ok())
            .unwrap_or_default();
        Arc::new(PersistentJar {
            store: RwLock::new(store),
            path,
            dirty: AtomicBool::new(false),
            saver_started: AtomicBool::new(false),
        })
    }

    /// Spawn the debounced saver once (subsequent calls are no-ops). Runs on
    /// the Tauri async runtime, so call this from proxy startup — not from the
    /// `CookieStore` trait methods, which reqwest invokes on its own workers.
    pub fn ensure_saver(self: &Arc<Self>) {
        if self.saver_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let jar = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;
                if jar.dirty.swap(false, Ordering::SeqCst) {
                    jar.save();
                }
            }
        });
    }

    /// Write the jar to disk now (persistent cookies only). Failures are
    /// logged, not surfaced — cookie persistence is best-effort.
    pub fn save(&self) {
        let json = {
            let store = self.store.read().unwrap_or_else(|e| e.into_inner());
            let mut buf = Vec::new();
            match cookie_store::serde::json::save(&store, &mut buf) {
                Ok(()) => buf,
                Err(err) => {
                    eprintln!("Failed to serialize preview cookies: {err}");
                    return;
                }
            }
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Write via a temp file + rename so a crash mid-write can't leave a
        // truncated JSON that silently drops every stored login on next start.
        // The file holds live session tokens, so on Unix it's created 0o600
        // (owner-only) instead of inheriting the umask; the rename preserves
        // that mode. On Windows the app config dir's DACL is already scoped to
        // the user profile.
        let tmp = self.path.with_extension("json.tmp");
        let write_tmp = || -> std::io::Result<()> {
            use std::io::Write;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = opts.open(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()
        };
        if let Err(err) = write_tmp().and_then(|()| {
            std::fs::rename(&tmp, &self.path).or_else(|_| {
                // Windows rename-over-existing can fail; fall back to replace.
                std::fs::remove_file(&self.path).ok();
                std::fs::rename(&tmp, &self.path)
            })
        }) {
            eprintln!("Failed to save preview cookies: {err}");
        }
    }

    /// Flush immediately if anything changed since the last save.
    pub fn flush_if_dirty(&self) {
        if self.dirty.swap(false, Ordering::SeqCst) {
            self.save();
        }
    }

    /// Drop every cookie and delete the on-disk file ("clear browsing data").
    pub fn clear(&self) {
        {
            let mut store = self.store.write().unwrap_or_else(|e| e.into_inner());
            store.clear();
        }
        self.dirty.store(false, Ordering::SeqCst);
        let _ = std::fs::remove_file(&self.path);
    }

    /// The `Cookie:` header value for a request to `url`, if any cookies match.
    /// Used for upstream connections that bypass the reqwest client (the
    /// external websocket bridge) so authed sockets carry the same session.
    pub fn cookie_header_for(&self, url: &url::Url) -> Option<String> {
        let store = self.store.read().unwrap_or_else(|e| e.into_inner());
        let value = store
            .get_request_values(url)
            .map(|(name, v)| format!("{name}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
}

/// The partition every request falls back to when no top-level origin has been
/// committed yet (a fresh tab, `about:blank`, a local-file preview).
pub const DEFAULT_PARTITION: &str = "\u{0}default";

/// Cookie jars partitioned by the **top-level** origin the user navigated to.
///
/// # Why partition at all
///
/// Every proxied site is served from the one loopback proxy origin, so the
/// browser's same-origin policy cannot separate two sites the way it would in a
/// real browser: script on page A can `fetch()` page B's proxy URL, or simply
/// frame it, and read the result — it is all "same origin" to the WebView. With
/// a single shared jar the proxy would attach B's real session cookies to that
/// request, turning any page the user visits into a reader of every other
/// logged-in site. `preview::proxy_origin_e2e` demonstrates the attack.
///
/// Partitioning is the same fix browsers shipped for third-party tracking
/// (Firefox Total Cookie Protection / Chrome CHIPS): cookies are keyed not just
/// by the site that set them but by the top-level site you were on at the time.
/// A request made while the user is on `https://evil.example` looks up the
/// `https://evil.example` partition, which has never seen a Google login, so no
/// Google cookie is attached — no matter how the request was made, `fetch` or
/// nested iframe alike. The user's real Google session lives in the
/// `https://mail.google.com` partition and is used only when that is the page
/// they are actually on.
///
/// # Why the partition key must come from the app, not the request
///
/// The partition is set explicitly by the frontend before it assigns
/// `iframe.src`, because the frontend is the only party that knows which
/// navigation is *top-level*. Inferring it from request traffic — "this looks
/// like a document load, so it must be the new top-level page" — is exactly what
/// the framing attack subverts: a nested `<iframe src="/proxy/…/mail.google.com">`
/// is also a document load.
///
/// # Storage
///
/// One JSON file per partition under `dir`, named by the base64url of the
/// partition key so any origin maps to a distinct, filesystem-safe name on every
/// platform. Only persistent cookies are written (see [`PersistentJar`]).
pub struct PartitionedJars {
    dir: PathBuf,
    jars: RwLock<HashMap<String, Arc<PersistentJar>>>,
}

impl PartitionedJars {
    pub fn new(dir: PathBuf) -> Arc<Self> {
        Arc::new(PartitionedJars {
            dir,
            jars: RwLock::new(HashMap::new()),
        })
    }

    /// Base64url so `https://a-b.com` and `https://a_b.com` can never collide
    /// onto one file — a collision would silently merge two sites' cookies and
    /// reopen the very hole this exists to close.
    fn file_name(partition: &str) -> String {
        format!(
            "{}.json",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(partition.as_bytes())
        )
    }

    /// The jar for `partition`, loading it from disk on first use.
    pub fn get(self: &Arc<Self>, partition: &str) -> Arc<PersistentJar> {
        if let Some(jar) = self
            .jars
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(partition)
        {
            return jar.clone();
        }
        let mut jars = self.jars.write().unwrap_or_else(|e| e.into_inner());
        // Re-check: another thread may have loaded it while we waited.
        if let Some(jar) = jars.get(partition) {
            return jar.clone();
        }
        let jar = PersistentJar::load(self.dir.join(Self::file_name(partition)));
        jar.ensure_saver();
        jars.insert(partition.to_string(), jar.clone());
        jar
    }

    /// Flush every loaded partition (app exit).
    pub fn flush_all(&self) {
        for jar in self.jars.read().unwrap_or_else(|e| e.into_inner()).values() {
            jar.flush_if_dirty();
        }
    }

    /// "Clear browsing data": drop every partition, in memory and on disk.
    pub fn clear_all(&self) {
        let mut jars = self.jars.write().unwrap_or_else(|e| e.into_inner());
        for jar in jars.values() {
            jar.clear();
        }
        jars.clear();
        // Sweep the directory too, so partitions that were never loaded this run
        // don't survive a "clear everything".
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

impl reqwest::cookie::CookieStore for PersistentJar {
    fn set_cookies(&self, cookie_headers: &mut dyn Iterator<Item = &HeaderValue>, url: &url::Url) {
        let cookies = cookie_headers.filter_map(|value| {
            std::str::from_utf8(value.as_bytes())
                .ok()
                .and_then(|s| cookie::Cookie::parse(s.to_owned()).ok())
        });
        let mut received_any = false;
        {
            let mut store = self.store.write().unwrap_or_else(|e| e.into_inner());
            store.store_response_cookies(
                cookies.inspect(|_| received_any = true),
                url,
            );
        }
        if received_any {
            self.dirty.store(true, Ordering::SeqCst);
        }
    }

    fn cookies(&self, url: &url::Url) -> Option<HeaderValue> {
        self.cookie_header_for(url)
            .and_then(|value| HeaderValue::from_str(&value).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::cookie::CookieStore as _;

    fn set_cookie(jar: &PersistentJar, url: &str, header: &str) {
        let value = HeaderValue::from_str(header).unwrap();
        let headers = [value];
        let mut iter = headers.iter();
        jar.set_cookies(&mut iter, &url::Url::parse(url).unwrap());
    }

    #[test]
    fn persistent_cookies_round_trip_through_disk() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("cookies.json");

        let jar = PersistentJar::load(path.clone());
        set_cookie(
            &jar,
            "https://example.com/login",
            "session=abc123; Path=/; Max-Age=86400",
        );
        assert!(jar
            .cookies(&url::Url::parse("https://example.com/").unwrap())
            .is_some());
        jar.flush_if_dirty();

        // A fresh jar (a fresh app run) still has the login cookie.
        let reloaded = PersistentJar::load(path);
        let header = reloaded
            .cookies(&url::Url::parse("https://example.com/app").unwrap())
            .expect("cookie survived restart");
        assert_eq!(header.to_str().unwrap(), "session=abc123");
    }

    #[test]
    fn session_cookies_are_not_persisted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("cookies.json");

        let jar = PersistentJar::load(path.clone());
        // No Max-Age / Expires → session cookie: live now, gone after restart.
        set_cookie(&jar, "https://example.com/", "sid=ephemeral; Path=/");
        assert!(jar
            .cookies(&url::Url::parse("https://example.com/").unwrap())
            .is_some());
        jar.flush_if_dirty();

        let reloaded = PersistentJar::load(path);
        assert!(reloaded
            .cookies(&url::Url::parse("https://example.com/").unwrap())
            .is_none());
    }

    #[test]
    fn cookies_are_scoped_to_their_site() {
        let tmp = tempfile::TempDir::new().unwrap();
        let jar = PersistentJar::load(tmp.path().join("cookies.json"));
        set_cookie(&jar, "https://a.example.com/", "token=secret; Max-Age=3600");
        assert!(jar
            .cookies(&url::Url::parse("https://other.com/").unwrap())
            .is_none());
    }

    #[test]
    fn clear_removes_cookies_and_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("cookies.json");
        let jar = PersistentJar::load(path.clone());
        set_cookie(&jar, "https://example.com/", "session=abc; Max-Age=3600");
        jar.flush_if_dirty();
        assert!(path.exists());

        jar.clear();
        assert!(jar
            .cookies(&url::Url::parse("https://example.com/").unwrap())
            .is_none());
        assert!(!path.exists());
    }
}
