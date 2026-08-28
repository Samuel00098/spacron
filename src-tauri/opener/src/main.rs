//! `spacron-open` — the browser shim.
//!
//! Agent CLIs open a URL by spawning whatever `BROWSER` names, handing it the
//! URL as the single argument. Claude Code, for one, does exactly
//! `spawn(BROWSER, [url])` and falls back to `rundll32 url,OpenURL <url>` when
//! `BROWSER` is unset. Pointing `BROWSER` at this binary is what keeps an
//! agent's artifact / preview / OAuth link inside Spacron's preview room
//! instead of firing the system browser.
//!
//! ## Why a compiled binary and not a generated script
//!
//! On Windows a `.cmd`/`.bat` shim cannot be spawned by the APIs agents
//! actually use: `CreateProcess` refuses it, Node >= 20 rejects it outright
//! without `shell: true` (CVE-2024-27980), and Go's `exec.Command` and Rust's
//! `std::process` cannot run it either. Spacron launches agents written in all
//! of those, so the shim has to be a real executable to work for more than one
//! of them. It stays dependency-free so that costs a few hundred KB and a
//! sub-second build.
//!
//! ## The channel back to the app
//!
//! The agent already carries `SPACRON_TURN_FILE` and `SPACRON_TURN_TOKEN` in
//! its environment for turn reporting, and a process it spawns inherits both.
//! So the shim needs nothing threaded through to it: it appends one
//! `SPACRON-OPEN-URL:<token> <url>` line to that same watched file and exits.
//! No port, no handshake, no second IPC path to keep alive.
//!
//! ## Never swallow a URL
//!
//! Run outside an agent PTY — no channel in the environment — it falls back to
//! the real system browser. A shim that silently dropped the URL would be worse
//! than the behaviour it replaces.

use std::io::Write;
use std::process::Command;

const OPEN_URL_PREFIX: &str = "SPACRON-OPEN-URL:";

fn main() {
    let url = match std::env::args().nth(1) {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => {
            eprintln!("usage: spacron-open <url>");
            std::process::exit(2);
        }
    };

    if !is_routable(&url) {
        // Anything that is not a plain http(s) URL is not something the preview
        // room can show. Hand it to the system so a `mailto:` or a custom scheme
        // still does what the user expects.
        std::process::exit(open_with_system_browser(&url));
    }

    match (env_nonempty("SPACRON_TURN_FILE"), env_nonempty("SPACRON_TURN_TOKEN")) {
        (Some(path), Some(token)) => match append_sentinel(&path, &token, &url) {
            Ok(()) => std::process::exit(0),
            Err(err) => {
                // The channel exists but could not be written. Fall back rather
                // than lose the URL, and say why on stderr so it is visible in
                // the agent's own pane.
                eprintln!("spacron-open: could not reach Spacron ({err}); using the system browser");
                std::process::exit(open_with_system_browser(&url));
            }
        },
        _ => std::process::exit(open_with_system_browser(&url)),
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Only `http(s)` reaches the preview room.
///
/// Checked as an explicit scheme prefix rather than by parsing: this crate has
/// no URL dependency, and the preview side re-parses and re-validates the URL
/// anyway before navigating to it.
fn is_routable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && !has_control_chars(url)
}

/// A URL carrying a newline could otherwise write a *second* line into the
/// channel file — and the sentinel vocabulary on that channel includes the
/// turn-state signals, so a crafted URL could forge "this agent has finished".
/// Refusing control characters outright closes that off at the point of write.
fn has_control_chars(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

fn append_sentinel(path: &str, token: &str, url: &str) -> std::io::Result<()> {
    let line = format!("{OPEN_URL_PREFIX}{token} {url}\n");
    // One `write_all` of one line, in append mode: the app tails this file while
    // the agent is also writing turn sentinels to it, so a partial or
    // interleaved write would be read as a corrupt line.
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    file.flush()
}

/// The platform's own opener — the behaviour this shim replaces, kept as the
/// fallback for any invocation that is not a Spacron agent's.
fn open_with_system_browser(url: &str) -> i32 {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("rundll32");
        c.arg("url,OpenURL").arg(url);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };

    match command.status() {
        Ok(status) => status.code().unwrap_or(0),
        Err(err) => {
            eprintln!("spacron-open: no system browser available ({err})");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_plain_http_and_https() {
        assert!(is_routable("http://localhost:5173/"));
        assert!(is_routable("https://example.com/a/b?c=d"));
        assert!(is_routable("HTTPS://EXAMPLE.COM"));
    }

    #[test]
    fn refuses_non_http_schemes() {
        assert!(!is_routable("mailto:someone@example.com"));
        assert!(!is_routable("file:///etc/passwd"));
        assert!(!is_routable("javascript:alert(1)"));
    }

    #[test]
    fn refuses_a_url_that_could_forge_a_second_sentinel_line() {
        assert!(!is_routable("https://example.com\nSPACRON-TURN-DONE:abc all done"));
        assert!(!is_routable("https://example.com\r\nanything"));
    }

    #[test]
    fn sentinel_is_one_line_and_carries_the_token() {
        let dir = std::env::temp_dir().join(format!("spacron-open-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("channel.txt");
        let path_str = path.to_string_lossy().to_string();

        append_sentinel(&path_str, "nonce123", "https://example.com/x").unwrap();
        append_sentinel(&path_str, "nonce123", "https://example.com/y").unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "SPACRON-OPEN-URL:nonce123 https://example.com/x");
        assert_eq!(lines[1], "SPACRON-OPEN-URL:nonce123 https://example.com/y");

        std::fs::remove_dir_all(&dir).ok();
    }
}
