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
//! # TLS (`wss://`) upstreams
//!
//! The same byte-relay trick cannot extend past an encrypted link: a raw byte
//! relay would hand the WebView plaintext for a TLS upstream. So when the saved
//! remote is `wss://`, the relay **terminates TLS itself** — it dials the
//! upstream with rustls, verifies the certificate against the OS trust store
//! (`rustls-platform-verifier`: Windows/macOS cert stores, Linux nss/native),
//! and shovels plaintext loopback ↔ decrypted bytes. The WebView still only
//! ever speaks `ws://127.0.0.1:*`. A self-signed cert therefore works as long
//! as the operator installs its CA in the client's OS trust store — the normal
//! "trust my own server" flow.
//!
//! # Exposure
//!
//! The listener is bound to 127.0.0.1 on an ephemeral port and forwards to one
//! fixed upstream, so it is reachable only by processes already running as this
//! user. It grants no authority on its own: the remote server still requires the
//! pre-shared token and answers 401 without it, exactly as it does for a direct
//! connection.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::rustls::ClientConfig;

/// A dialed upstream, plaintext or TLS-wrapped. Boxed because the two variants
/// are different concrete types; `copy_bidirectional` only needs the traits.
trait UpstreamIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> UpstreamIo for T {}

type Upstream = Box<dyn UpstreamIo>;

/// Live relays keyed by upstream `scheme://host:port`, so reconnecting to the
/// same remote reuses one listener instead of leaking a new one per attempt.
/// The scheme is part of the key because `ws://` and `wss://` are different
/// upstreams (TLS vs not) and must not share a relay.
fn relays() -> &'static Mutex<HashMap<String, u16>> {
    static RELAYS: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    RELAYS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Split a `ws://`/`wss://` URL into `(scheme, authority)` where authority is
/// the `host:port` we dial (default ports: 80 for ws, 443 for wss).
fn upstream_authority(url: &str) -> Result<(String, String), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid remote URL: {e}"))?;
    let scheme = match parsed.scheme() {
        "ws" | "wss" => parsed.scheme().to_string(),
        other => return Err(format!("Unsupported remote URL scheme '{other}'")),
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| "Remote URL has no host".to_string())?;
    let port = parsed.port().unwrap_or(if scheme == "wss" { 443 } else { 80 });
    // Bracket IPv6 literals so the result parses back as a socket address.
    // `Url::host_str` already brackets them, so only add them when missing —
    // otherwise the authority comes out as `[[fd00::1]]:9000` and never resolves.
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    Ok((scheme, authority))
}

/// Default TLS client config: verify against the OS trust store, so both public
/// CAs and operator-installed private CAs validate. `with_platform_verifier` is
/// the rustls builder integration from rustls-platform-verifier.
fn default_tls_config() -> Result<ClientConfig, String> {
    crate::remote::ensure_crypto_provider();
    use rustls_platform_verifier::BuilderVerifierExt;
    Ok(ClientConfig::builder()
        .with_platform_verifier()
        .with_no_client_auth())
}

/// Dial `authority`, wrapping the stream in TLS when `scheme == "wss"`.
/// `tls_config` is only consulted for `wss://` — the plaintext path is a bare
/// TCP connect, so no config is needed (or built) there.
async fn connect_upstream(
    _scheme: &str,
    authority: &str,
    tls_config: Option<&ClientConfig>,
) -> Result<Upstream, String> {
    let tcp = TcpStream::connect(authority)
        .await
        .map_err(|e| format!("Upstream {authority} unreachable: {e}"))?;
    // Terminal traffic is latency-sensitive and arrives in small writes; Nagle
    // would coalesce keystrokes. Set here, on the raw socket, because the
    // caller only sees a boxed `UpstreamIo` (and for TLS, a `TlsStream` that
    // does not expose the option at all).
    let _ = tcp.set_nodelay(true);
    let Some(tls_config) = tls_config else {
        return Ok(Box::new(tcp));
    };
    // The authority's host, unbracketed (IP literals don't want `[ ]`).
    let host = authority
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(authority)
        .trim_start_matches('[')
        .trim_end_matches(']');
    let server_name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|e| format!("Invalid upstream host '{host}': {e}"))?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config.clone()));
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|e| format!("TLS handshake with {authority} failed: {e}"))?;
    Ok(Box::new(tls))
}

/// Ensure a loopback relay to `url`'s host is running and return its local port.
///
/// The frontend rewrites the socket URL onto `ws://127.0.0.1:<port>` keeping the
/// original path and query, then connects as before.
#[tauri::command(async)]
pub async fn remote_relay_start(url: String) -> Result<u16, String> {
    remote_relay_start_with_config(url, None).await
}

/// The command body with an injectable TLS config, so tests can trust a
/// throwaway CA instead of the OS store.
async fn remote_relay_start_with_config(
    url: String,
    tls_config_override: Option<ClientConfig>,
) -> Result<u16, String> {
    crate::remote::ensure_crypto_provider();
    let (scheme, authority) = upstream_authority(&url)?;
    let key = format!("{scheme}://{authority}");

    if let Some(port) = relays()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
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
        if let Some(existing) = map.get(&key).copied() {
            return Ok(existing); // lost the race; the other relay is live
        }
        map.insert(key.clone(), port);
    }

    let upstream = authority.clone();
    let tls_config = match scheme.as_str() {
        "wss" => Some(match tls_config_override {
            Some(override_cfg) => override_cfg,
            None => default_tls_config()?,
        }),
        _ => None,
    };
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut inbound, _)) = listener.accept().await else {
                break; // listener died; the relay is gone
            };
            let target = upstream.clone();
            let tls_config = tls_config.clone();
            let scheme = scheme.clone();
            tauri::async_runtime::spawn(async move {
                match connect_upstream(&scheme, &target, tls_config.as_ref()).await {
                    Ok(mut outbound) => {
                        // The loopback leg; `connect_upstream` sets the same
                        // option on the upstream leg, where it actually costs
                        // round trips.
                        let _ = inbound.set_nodelay(true);
                        // Runs until either side closes; errors just end this
                        // connection, never the relay.
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
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

    fn authority(url: &str) -> String {
        let (scheme, host) = upstream_authority(url).unwrap();
        format!("{scheme}://{host}")
    }

    #[test]
    fn parses_host_and_port_from_a_ws_url() {
        assert_eq!(authority("ws://100.64.0.1:9000/pty"), "ws://100.64.0.1:9000");
        assert_eq!(authority("ws://devbox.local:9000/pty"), "ws://devbox.local:9000");
        // No explicit port → the ws:// default.
        assert_eq!(authority("ws://devbox.local/pty"), "ws://devbox.local:80");
    }

    #[test]
    fn parses_wss_urls_with_the_https_default_port() {
        assert_eq!(authority("wss://devbox.local:9000/pty"), "wss://devbox.local:9000");
        // No explicit port → the wss:// default, not the ws:// one.
        assert_eq!(authority("wss://devbox.local/pty"), "wss://devbox.local:443");
    }

    #[test]
    fn brackets_ipv6_literals() {
        assert_eq!(authority("ws://[fd00::1]:9000/pty"), "ws://[fd00::1]:9000");
    }

    #[test]
    fn rejects_schemes_the_relay_cannot_carry() {
        assert!(upstream_authority("http://host:9000/pty").is_err());
        assert!(upstream_authority("https://host:9000/pty").is_err());
        assert!(upstream_authority("not a url").is_err());
    }

    /// End-to-end plaintext: a real upstream, a relay in front of it, and a
    /// client that only ever talks to loopback — the shape the WebView is
    /// restricted to.
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

    /// End-to-end TLS: an upstream that only speaks TLS, a relay in front of
    /// it, and a plaintext loopback client. Proves the relay terminates the
    /// TLS itself (the WebView side stays plaintext). The cert is signed by a
    /// throwaway CA; the relay trusts that CA via an injected root store, so
    /// the test never touches the machine's real trust.
    #[tokio::test]
    async fn relays_bytes_between_loopback_and_tls_upstream() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
        use tokio_rustls::rustls::{RootCertStore, ServerConfig as RustlsServerConfig};

        crate::remote::ensure_crypto_provider();

        // Throwaway CA + leaf for `localhost`.
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let ca = rcgen::CertificateParams::new(vec!["Spacron Test CA".to_string()])
            .unwrap()
            .self_signed(&ca_key)
            .unwrap();
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let mut leaf_params =
            rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap();
        leaf_params.is_ca = rcgen::IsCa::NoCa;
        leaf_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let leaf = leaf_params.signed_by(&leaf_key, &ca, &ca_key).unwrap();

        let ca_cert_der = CertificateDer::from(ca.der().to_vec());
        let leaf_cert_der = CertificateDer::from(leaf.der().to_vec());
        let leaf_key_der = PrivateKeyDer::try_from(leaf_key.serialize_der())
            .expect("rcgen key parses as a DER key");

        // TLS upstream: accepts one connection, echoes with a prefix.
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (sock, _) = upstream.accept().await.unwrap();
            let tls_config = RustlsServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(vec![leaf_cert_der], leaf_key_der)
                .expect("leaf cert + key are a valid server pair");
            let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls_config));
            let mut tls = acceptor.accept(sock).await.unwrap();
            let mut buf = [0u8; 64];
            let n = tls.read(&mut buf).await.unwrap();
            tls.write_all(format!("tls upstream saw: {}", String::from_utf8_lossy(&buf[..n])).as_bytes())
                .await
                .unwrap();
            tls.flush().await.unwrap();
        });

        // Relay config trusting ONLY our throwaway CA (not the OS store).
        let mut roots = RootCertStore::empty();
        roots.add(ca_cert_der).unwrap();
        let relay_config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();

        let relay_port =
            remote_relay_start_with_config(
                format!("wss://localhost:{upstream_port}/pty"),
                Some(relay_config),
            )
                .await
                .expect("TLS relay starts");
        assert_ne!(relay_port, upstream_port, "relay binds its own port");

        let mut client = TcpStream::connect(format!("127.0.0.1:{relay_port}"))
            .await
            .expect("client reaches the relay");
        client.write_all(b"GET /pty HTTP/1.1").await.unwrap();
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out),
            "tls upstream saw: GET /pty HTTP/1.1"
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

    /// Same host on different schemes is a different upstream: each gets its
    /// own relay.
    #[tokio::test]
    async fn does_not_share_a_relay_across_schemes() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = upstream.local_addr().unwrap().port();
        let ws = remote_relay_start(format!("ws://127.0.0.1:{port}/pty")).await.unwrap();
        let wss = remote_relay_start(format!("wss://127.0.0.1:{port}/pty")).await.unwrap();
        assert_ne!(ws, wss);
    }
}
