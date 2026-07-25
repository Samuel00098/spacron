//! Loopback relay for the remote-workspace WebSocket.
//!
//! # Why this exists
//!
//! The remote-workspace socket is opened by the WebView
//! (`services/pty-bridge-remote.ts`), so it is subject to the app's
//! `connect-src`. That directive deliberately lists only `ws://127.0.0.1:*` —
//! the same "no wildcard `connect-src`" rule that put the HTTP Client behind
//! Rust. The result was that every non-loopback remote (the documented
//! `ws://<tailscale-host>:9000/pty` form) was blocked outright:
//!
//! ```text
//! securitypolicyviolation: connect-src <- ws://100.64.0.1:9000/pty
//! ```
//!
//! Rather than widen the policy, this relays the connection through the backend
//! the same way `http_send_request` does. Rust binds an ephemeral **loopback**
//! listener and shovels bytes between it and the real remote host, so the WebView
//! connects to `ws://127.0.0.1:<relay_port>/pty` — already permitted — and the
//! CSP is left exactly as it was.
//!
//! # Why a byte relay rather than a WebSocket client
//!
//! Nothing here needs to understand WebSocket framing. The handshake (including
//! the `Sec-WebSocket-Protocol: token.<TOKEN>` offer that authenticates the
//! client) and every subsequent frame pass through untouched, so the remote
//! server sees exactly the connection it would have seen directly. That keeps the
//! token end-to-end, avoids re-implementing the protocol, and means the relay
//! cannot desynchronise from it.
//!
//! # Exposure
//!
//! The listener is bound to 127.0.0.1 on an ephemeral port and forwards to one
//! fixed upstream, so it is reachable only by processes already running as this
//! user. It grants no authority on its own: the remote server still requires the
//! pre-shared token and answers 401 without it, exactly as it does for a direct
//! connection.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tokio::net::{TcpListener, TcpStream};

/// Live relays keyed by upstream `host:port`, so reconnecting to the same remote
/// reuses one listener instead of leaking a new one per attempt.
fn relays() -> &'static Mutex<HashMap<String, u16>> {
    static RELAYS: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    RELAYS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Split a `ws://host:port/path` URL into the upstream authority we dial.
///
/// `wss://` is rejected rather than silently mishandled: a raw byte relay would
/// hand the WebView plaintext while the upstream expected TLS. The server speaks
/// plaintext `ws://` only today (see docs/remote-workspace.md — TLS is a later
/// hardening step), so this covers the real surface and fails loudly if that
/// changes.
fn upstream_authority(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid remote URL: {e}"))?;
    match parsed.scheme() {
        "ws" => {}
        "wss" => {
            return Err(
                "wss:// remotes are not supported yet — the relay speaks plaintext to the \
                 upstream. Use ws:// over Tailscale/VPN, which encrypts the link."
                    .to_string(),
            )
        }
        other => return Err(format!("Unsupported remote URL scheme '{other}'")),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Remote URL has no host".to_string())?;
    let port = parsed.port().unwrap_or(80);
    // Bracket IPv6 literals so the result parses back as a socket address.
    // `Url::host_str` already brackets them, so only add them when missing —
    // otherwise the authority comes out as `[[fd00::1]]:9000` and never resolves.
    if host.contains(':') && !host.starts_with('[') {
        Ok(format!("[{host}]:{port}"))
    } else {
        Ok(format!("{host}:{port}"))
    }
}

/// Ensure a loopback relay to `url`'s host is running and return its local port.
///
/// The frontend rewrites the socket URL onto `ws://127.0.0.1:<port>` keeping the
/// original path and query, then connects as before.
#[tauri::command(async)]
pub async fn remote_relay_start(url: String) -> Result<u16, String> {
    let authority = upstream_authority(&url)?;

    if let Some(port) = relays()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&authority)
        .copied()
    {
        return Ok(port);
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind the remote relay: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read the relay address: {e}"))?
        .port();

    // Record before spawning so a second caller racing us reuses this relay
    // rather than binding another listener for the same upstream.
    {
        let mut map = relays().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(&authority).copied() {
            return Ok(existing); // lost the race; the other relay is live
        }
        map.insert(authority.clone(), port);
    }

    let upstream = authority.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut inbound, _)) = listener.accept().await else {
                break; // listener died; the relay is gone
            };
            let target = upstream.clone();
            tauri::async_runtime::spawn(async move {
                match TcpStream::connect(&target).await {
                    Ok(mut outbound) => {
                        // Terminal traffic is latency-sensitive and arrives in
                        // small writes; Nagle would coalesce keystrokes.
                        let _ = inbound.set_nodelay(true);
                        let _ = outbound.set_nodelay(true);
                        // Runs until either side closes; errors just end this
                        // connection, never the relay.
                        let _ =
                            tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                    Err(err) => {
                        eprintln!("remote relay: upstream {target} unreachable: {err}");
                        // Dropping `inbound` closes it, so the WebView's
                        // WebSocket surfaces a normal connection failure.
                    }
                }
            });
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_and_port_from_a_ws_url() {
        assert_eq!(
            upstream_authority("ws://100.64.0.1:9000/pty").unwrap(),
            "100.64.0.1:9000"
        );
        assert_eq!(
            upstream_authority("ws://devbox.local:9000/pty").unwrap(),
            "devbox.local:9000"
        );
        // No explicit port → the ws:// default.
        assert_eq!(
            upstream_authority("ws://devbox.local/pty").unwrap(),
            "devbox.local:80"
        );
    }

    #[test]
    fn brackets_ipv6_literals() {
        assert_eq!(
            upstream_authority("ws://[fd00::1]:9000/pty").unwrap(),
            "[fd00::1]:9000"
        );
    }

    #[test]
    fn rejects_schemes_the_relay_cannot_carry() {
        // A byte relay would hand the WebView plaintext for a TLS upstream.
        assert!(upstream_authority("wss://host:9000/pty")
            .unwrap_err()
            .contains("wss"));
        assert!(upstream_authority("http://host:9000/pty").is_err());
        assert!(upstream_authority("not a url").is_err());
    }

    /// End-to-end: a real upstream, a relay in front of it, and a client that
    /// only ever talks to loopback — the shape the WebView is restricted to.
    #[tokio::test]
    async fn relays_bytes_between_loopback_and_upstream() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Stand-in for spacron-server: echoes back what it receives, prefixed.
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = upstream.accept().await.unwrap();
            let mut buf = [0u8; 64];
            let n = sock.read(&mut buf).await.unwrap();
            sock.write_all(format!("upstream saw: {}", String::from_utf8_lossy(&buf[..n])).as_bytes())
                .await
                .unwrap();
            sock.flush().await.unwrap();
        });

        let relay_port = remote_relay_start(format!("ws://127.0.0.1:{upstream_port}/pty"))
            .await
            .expect("relay starts");
        assert_ne!(relay_port, upstream_port, "relay binds its own port");

        let mut client = TcpStream::connect(format!("127.0.0.1:{relay_port}"))
            .await
            .expect("client reaches the relay");
        client.write_all(b"GET /pty HTTP/1.1").await.unwrap();
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out),
            "upstream saw: GET /pty HTTP/1.1"
        );
    }

    /// Two connects to the same remote must not each bind a listener.
    #[tokio::test]
    async fn reuses_one_relay_per_upstream() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = upstream.local_addr().unwrap().port();
        let url = format!("ws://127.0.0.1:{port}/pty");
        let first = remote_relay_start(url.clone()).await.unwrap();
        let second = remote_relay_start(url).await.unwrap();
        assert_eq!(first, second);
    }
}
