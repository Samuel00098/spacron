//! Desktop side of the remote server's TCP tunnels (`remote/tunnel.rs`).
//!
//! - [`remote_tunnel_open_mcp`] makes the box listen on its own
//!   `127.0.0.1:<mcp_port>` and pipes every connection to this app's MCP server,
//!   so agents running on the box get `report_status`, `list_agents`,
//!   `delegate_task` and the rest with the config they already receive.
//! - [`remote_tunnel_forward`] listens on a local loopback port and pipes each
//!   connection to a port on the box, so the preview can show a dev server that
//!   runs there.
//!
//! Each TCP connection gets its own WebSocket, dialed the same way the relay
//! dials (`remote_relay::connect_upstream`: plaintext or TLS against the OS
//! trust store) and authenticated with the same `token.<TOKEN>` subprotocol.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use tokio_tungstenite::WebSocketStream;

use super::remote_relay::{connect_upstream, default_tls_config, upstream_authority, Upstream};

type Ws = WebSocketStream<Upstream>;

#[derive(Default)]
struct Tunnels {
    /// The reverse MCP tunnel's supervisor task, if one is running.
    mcp: Option<AbortHandle>,
    /// Forwarded box ports: (remote url, box port) -> (local port, accept task).
    forwards: HashMap<(String, u16), (u16, AbortHandle)>,
}

fn tunnels() -> &'static Mutex<Tunnels> {
    static TUNNELS: OnceLock<Mutex<Tunnels>> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(Tunnels::default()))
}

/// The tunnel endpoint on the same server as the saved `/pty` URL.
fn tunnel_url(base: &str, path: &str, query: &str) -> Result<String, String> {
    let mut url = url::Url::parse(base).map_err(|e| format!("Invalid remote URL: {e}"))?;
    url.set_path(path);
    url.set_query(Some(query));
    Ok(url.to_string())
}

async fn open_ws(url: &str, token: &str) -> Result<Ws, String> {
    let (scheme, authority) = upstream_authority(url)?;
    let tls = if scheme == "wss" { Some(default_tls_config()?) } else { None };
    let stream = connect_upstream(&scheme, &authority, tls.as_ref()).await?;
    let mut request = url.into_client_request().map_err(|e| format!("Invalid tunnel URL: {e}"))?;
    let protocols = HeaderValue::from_str(&format!("spacron.v1, token.{token}"))
        .map_err(|_| "The remote token contains characters a WebSocket cannot carry.".to_string())?;
    request.headers_mut().insert("Sec-WebSocket-Protocol", protocols);
    let (ws, _) = tokio_tungstenite::client_async(request, stream).await.map_err(|e| match e {
        tokio_tungstenite::tungstenite::Error::Http(resp) if resp.status() == 404 => {
            "The remote server is too old for tunnels. Redeploy it from the remote setup wizard.".to_string()
        }
        tokio_tungstenite::tungstenite::Error::Http(resp) => {
            let body = resp.body().as_ref().map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default();
            format!("The remote server refused the tunnel ({}): {body}", resp.status())
        }
        other => format!("Could not open a tunnel to the remote: {other}"),
    })?;
    Ok(ws)
}

/// Shovel bytes between a tunnel WebSocket and a local TCP stream.
async fn pipe(ws: Ws, tcp: TcpStream) {
    let _ = tcp.set_nodelay(true);
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (mut rd, mut wr) = tcp.into_split();
    let up = async {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_tx.send(Message::Close(None)).await;
    };
    let down = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(bytes) => {
                    if wr.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = wr.shutdown().await;
    };
    tokio::select! { _ = up => {}, _ = down => {} }
}

/// Wait for the box's `ready` (or its `error`) on a fresh control socket.
async fn await_ready(ws: &mut Ws) -> Result<(), String> {
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("Tunnel control socket failed: {e}"))?;
        if let Message::Text(text) = msg {
            let value: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
            match value["t"].as_str() {
                Some("ready") => return Ok(()),
                Some("error") => return Err(value["message"].as_str().unwrap_or("The box refused the tunnel.").to_string()),
                _ => {}
            }
        }
    }
    Err("The remote closed the tunnel before it was ready.".to_string())
}

/// Serve one control socket until it drops: claim each announced connection
/// and pipe it to the local MCP server.
async fn serve_control(mut ws: Ws, url: String, token: String, mcp_port: u16) {
    while let Some(Ok(msg)) = ws.next().await {
        let Message::Text(text) = msg else { continue };
        let value: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
        if value["t"].as_str() != Some("conn") {
            continue;
        }
        let Some(id) = value["id"].as_u64() else { continue };
        let (url, token) = (url.clone(), token.clone());
        tokio::spawn(async move {
            let Ok(local) = TcpStream::connect(("127.0.0.1", mcp_port)).await else { return };
            let Ok(accept_url) = tunnel_url(&url, "/tunnel/accept", &format!("id={id}")) else { return };
            if let Ok(data) = open_ws(&accept_url, &token).await {
                pipe(data, local).await;
            }
        });
    }
}

/// Open the reverse tunnel that gives agents on the box the Spacron MCP server.
///
/// The first connection is made here so a failure (old server, busy port, bad
/// token) is reported to the caller; after that a supervisor keeps it up,
/// reconnecting with backoff when the link drops.
#[tauri::command]
pub async fn remote_tunnel_open_mcp(url: String, token: String, mcp_port: u16) -> Result<(), String> {
    open_reverse(url, token, mcp_port, mcp_port).await
}

/// The box listens on `box_port`; each connection is piped to local `mcp_port`.
async fn open_reverse(url: String, token: String, box_port: u16, mcp_port: u16) -> Result<(), String> {
    if let Some(old) = tunnels().lock().map_err(|_| "tunnel state poisoned")?.mcp.take() {
        old.abort();
    }
    let listen_url = tunnel_url(&url, "/tunnel/listen", &format!("port={box_port}"))?;
    let mut first = open_ws(&listen_url, &token).await?;
    await_ready(&mut first).await?;
    let task = tokio::spawn(async move {
        let mut ws = Some(first);
        let mut backoff = Duration::from_secs(2);
        loop {
            if let Some(control) = ws.take() {
                serve_control(control, url.clone(), token.clone(), mcp_port).await;
                backoff = Duration::from_secs(2);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
            if let Ok(mut next) = open_ws(&listen_url, &token).await {
                if await_ready(&mut next).await.is_ok() {
                    ws = Some(next);
                }
            }
        }
    });
    tunnels().lock().map_err(|_| "tunnel state poisoned")?.mcp = Some(task.abort_handle());
    Ok(())
}

/// Share the chosen sign-ins with a box, so its own proxy can serve them
/// while the laptop is closed (`remote/box_proxy.rs`). The box keeps exactly
/// this set: an empty `keys` removes every shared sign-in from it.
///
/// The grants go from this process straight to the box over its
/// authenticated socket, so tokens never pass through the web UI.
#[tauri::command]
pub async fn remote_share_mcp_grants(url: String, token: String, keys: Vec<String>) -> Result<usize, String> {
    let mut grants = serde_json::Map::new();
    for key in &keys {
        let grant = crate::commands::mcp_oauth::load_grant(key).ok_or_else(|| format!("Not signed in to {key} on this computer."))?;
        grants.insert(key.clone(), serde_json::to_value(grant).map_err(|e| e.to_string())?);
    }
    let pty_url = tunnel_url(&url, "/pty", "")?;
    let mut ws = open_ws(pty_url.trim_end_matches('?'), &token).await?;
    let request = serde_json::json!({ "t": "invoke", "reqId": 1, "cmd": "box_mcp_grants_sync", "args": { "grants": grants } });
    ws.send(Message::Text(request.to_string().into())).await.map_err(|e| format!("Could not reach the box: {e}"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let next = tokio::time::timeout_at(deadline, ws.next()).await.map_err(|_| "The box did not answer.".to_string())?;
        let Some(msg) = next else { return Err("The box closed the connection.".into()) };
        let Message::Text(text) = msg.map_err(|e| format!("Could not reach the box: {e}"))? else { continue };
        let value: serde_json::Value = serde_json::from_str(text.as_str()).unwrap_or_default();
        if value["reqId"].as_u64() != Some(1) {
            continue;
        }
        let _ = ws.close(None).await;
        return match value["t"].as_str() {
            Some("invokeOk") => Ok(value["value"]["count"].as_u64().unwrap_or(0) as usize),
            _ => Err(value["message"].as_str().unwrap_or("The box refused the sign-ins.").to_string()),
        };
    }
}

/// Forward a port on the box to a local loopback port and return the local
/// port. Reuses an existing forward for the same remote and box port.
#[tauri::command]
pub async fn remote_tunnel_forward(url: String, token: String, remote_port: u16) -> Result<u16, String> {
    if remote_port == 0 {
        return Err("Port must be 1-65535.".to_string());
    }
    let key = (url.clone(), remote_port);
    if let Some((port, _)) = tunnels().lock().map_err(|_| "tunnel state poisoned")?.forwards.get(&key) {
        return Ok(*port);
    }
    let dial_url = tunnel_url(&url, "/tunnel/dial", &format!("port={remote_port}"))?;
    // Fail now, with a readable reason, if nothing on the box answers.
    drop(open_ws(&dial_url, &token).await?);
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Could not open a local port: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let task = tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (dial_url, token) = (dial_url.clone(), token.clone());
            tokio::spawn(async move {
                if let Ok(ws) = open_ws(&dial_url, &token).await {
                    pipe(ws, tcp).await;
                }
            });
        }
    });
    tunnels().lock().map_err(|_| "tunnel state poisoned")?.forwards.insert(key, (local_port, task.abort_handle()));
    Ok(local_port)
}

/// Close every tunnel (called when the app leaves the remote workspace).
#[tauri::command]
pub fn remote_tunnel_close_all() -> Result<(), String> {
    let mut t = tunnels().lock().map_err(|_| "tunnel state poisoned")?;
    if let Some(mcp) = t.mcp.take() {
        mcp.abort();
    }
    for (_, (_, task)) in t.forwards.drain() {
        task.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    /// An echo server standing in for the MCP server or a dev server.
    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = tcp.read(&mut buf).await {
                        if n == 0 || tcp.write_all(&buf[..n]).await.is_err() { break; }
                    }
                });
            }
        });
        port
    }

    async fn boot_server(token: &str) -> String {
        let dir = tempfile::tempdir().unwrap();
        let port = free_port();
        let cfg = crate::remote::ServerConfig {
            workspace: dir.path().to_path_buf(),
            port,
            token: token.to_string(),
            auto_commit_interval: None,
            tls: None,
        };
        std::mem::forget(dir);
        tokio::spawn(async move { let _ = crate::remote::serve(cfg).await; });
        for _ in 0..50 {
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        format!("ws://127.0.0.1:{port}/pty")
    }

    async fn round_trip(port: u16) -> Vec<u8> {
        let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tcp.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(5), tcp.read_exact(&mut buf)).await.unwrap().unwrap();
        buf.to_vec()
    }

    #[tokio::test]
    async fn reverse_tunnel_carries_box_connections_to_the_desktop() {
        let url = boot_server("tok").await;
        let mcp = echo_server().await;
        let box_port = free_port();
        open_reverse(url, "tok".into(), box_port, mcp).await.unwrap();
        assert_eq!(round_trip(box_port).await, b"ping");
        // Only this test's tunnel: tests run in parallel and share the registry.
        if let Some(task) = tunnels().lock().unwrap().mcp.take() { task.abort(); }
    }

    #[tokio::test]
    async fn forward_tunnel_reaches_a_port_on_the_box() {
        let url = boot_server("tok2").await;
        let dev = echo_server().await;
        let local = remote_tunnel_forward(url.clone(), "tok2".into(), dev).await.unwrap();
        assert_eq!(round_trip(local).await, b"ping");
        // The same forward is reused rather than opened twice.
        assert_eq!(remote_tunnel_forward(url, "tok2".into(), dev).await.unwrap(), local);
    }

    #[tokio::test]
    async fn a_wrong_token_is_refused() {
        let url = boot_server("right").await;
        let err = remote_tunnel_forward(url, "wrong".into(), echo_server().await).await.unwrap_err();
        assert!(err.contains("refused"), "{err}");
    }

    #[test]
    fn tunnel_urls_keep_the_server_and_replace_the_path() {
        assert_eq!(
            tunnel_url("wss://box.example:9000/pty", "/tunnel/listen", "port=51379").unwrap(),
            "wss://box.example:9000/tunnel/listen?port=51379"
        );
        assert_eq!(
            tunnel_url("ws://100.64.0.1:9000/pty?x=1", "/tunnel/dial", "port=3000").unwrap(),
            "ws://100.64.0.1:9000/tunnel/dial?port=3000"
        );
    }
}
