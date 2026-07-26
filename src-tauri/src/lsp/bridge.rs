use crate::lsp::registry::ResolvedCommand;
use crate::lsp::server::LspServer;
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a freshly minted connection token stays valid before the WebSocket
/// must connect.
const TOKEN_TTL: Duration = Duration::from_secs(30);

/// A server resolved and authorized by `lsp_start`, waiting for its WebSocket to
/// connect. The token carries the (already project-confined) launch parameters so
/// the WebSocket client can't inject an arbitrary command or working directory.
struct PendingSession {
    cmd: ResolvedCommand,
    cwd: String,
    created: Instant,
}

struct BridgeInner {
    tokens: DashMap<String, PendingSession>,
}

/// Owns the localhost WebSocket server that bridges CodeMirror's
/// `WebSocketTransport` to language-server child processes. One server process is
/// spawned per WebSocket connection; the frontend caches one client (hence one
/// connection) per (root, language).
pub struct LspBridge {
    /// The port of the currently listening server, or `None` when nothing is
    /// serving. Shared with the server task so it can clear the entry when it
    /// stops — see `ensure_started`.
    port: Arc<Mutex<Option<u16>>>,
    inner: Arc<BridgeInner>,
}

impl Default for LspBridge {
    fn default() -> Self {
        Self {
            port: Arc::new(Mutex::new(None)),
            inner: Arc::new(BridgeInner {
                tokens: DashMap::new(),
            }),
        }
    }
}

impl LspBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start the bridge server if it isn't already running, returning its port.
    ///
    /// The listening socket is bound **on this thread**, before the port is
    /// cached or returned. That ordering is load-bearing: the previous version
    /// picked a free port, cached it, and then bound inside the spawned task, so
    /// a bind that failed — most easily by losing the just-released port to
    /// another process in the gap — left a cached port with nothing listening on
    /// it. `lsp_start` still succeeded, the frontend's WebSocket was refused, and
    /// because the bad port stayed cached every later attempt was refused too.
    /// No language server ever spawned and nothing surfaced the failure.
    pub fn ensure_started(&self) -> Result<u16, String> {
        let mut port_guard = self.port.lock().map_err(|e| e.to_string())?;
        if let Some(port) = *port_guard {
            return Ok(port);
        }

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let std_listener = std::net::TcpListener::bind(addr)
            .map_err(|e| format!("Could not bind the LSP bridge: {e}"))?;
        let port = std_listener
            .local_addr()
            .map_err(|e| format!("Could not read the LSP bridge address: {e}"))?
            .port();
        // Tokio requires a non-blocking socket to adopt it.
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("Could not configure the LSP bridge socket: {e}"))?;

        let inner = self.inner.clone();
        let port_cell = self.port.clone();

        // `TcpListener::from_std` must run inside the async runtime (it registers
        // with the reactor), so the already-bound socket is handed to the task
        // rather than converted here.
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Failed to adopt the LSP bridge socket: {e}");
                    clear_port(&port_cell);
                    return;
                }
            };
            let app = Router::new()
                .route("/lsp", get(ws_handler))
                .with_state(inner);
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("LSP bridge server error: {e}");
            }
            // Nothing is listening any more. Drop the cached port so the next
            // `lsp_start` binds a fresh one instead of handing out a dead one.
            clear_port(&port_cell);
        });

        *port_guard = Some(port);
        Ok(port)
    }

    /// Authorize a launch and return a single-use connection token.
    pub fn create_token(&self, cmd: ResolvedCommand, cwd: String) -> String {
        // Drop any tokens that were never connected.
        self.inner
            .tokens
            .retain(|_, s| s.created.elapsed() < TOKEN_TTL);

        let token = uuid::Uuid::new_v4().to_string();
        self.inner.tokens.insert(
            token.clone(),
            PendingSession {
                cmd,
                cwd,
                created: Instant::now(),
            },
        );
        token
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(inner): State<Arc<BridgeInner>>,
) -> Response {
    let token = params.get("token").cloned().unwrap_or_default();
    let pending = inner.tokens.remove(&token).map(|(_, v)| v);

    match pending {
        Some(p) if p.created.elapsed() < TOKEN_TTL => {
            ws.on_upgrade(move |socket| bridge_socket(socket, p))
        }
        _ => (StatusCode::FORBIDDEN, "invalid or expired LSP token").into_response(),
    }
}

/// Pump messages between a WebSocket and a freshly spawned language server until
/// either side closes, then kill the server.
async fn bridge_socket(socket: WebSocket, pending: PendingSession) {
    let (server, mut rx) = match LspServer::spawn(pending.cmd, &pending.cwd) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("LSP server spawn failed: {e}");
            return;
        }
    };
    let server = Arc::new(server);
    let (mut sink, mut stream) = socket.split();

    // server -> client
    let to_client = async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    };

    // client -> server
    let server_in = server.clone();
    let from_client = async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(t) => {
                    if server_in.send(t.as_str()).is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        _ = to_client => {},
        _ = from_client => {},
    }
    server.kill();
}

/// Forget the cached bridge port. A poisoned lock is ignored deliberately: the
/// only cost is one stale port, and the alternative is panicking in a detached
/// task at shutdown.
fn clear_port(cell: &Arc<Mutex<Option<u16>>>) {
    if let Ok(mut slot) = cell.lock() {
        *slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this file exists to prevent: `ensure_started` must not
    /// return a port until something is listening on it. The old version handed
    /// back a port picked by a listener it had already dropped, so a caller could
    /// — and in practice did — connect to nothing and fail silently forever.
    #[test]
    fn ensure_started_returns_a_port_that_accepts_connections() {
        let bridge = LspBridge::new();
        let port = bridge.ensure_started().expect("bridge should start");

        // Connect on the raw socket: if the listener were not bound yet this is
        // a connection refused, which is exactly the failure being guarded.
        std::net::TcpStream::connect(("127.0.0.1", port))
            .unwrap_or_else(|e| panic!("nothing listening on the returned port {port}: {e}"));

        // And the port is stable across calls rather than re-bound per request.
        assert_eq!(bridge.ensure_started().unwrap(), port);
    }

    #[test]
    fn tokens_are_single_use() {
        let bridge = LspBridge::new();
        let cmd = ResolvedCommand {
            program: "does-not-matter".to_string(),
            args: vec![],
        };
        let token = bridge.create_token(cmd, ".".to_string());

        assert!(bridge.inner.tokens.remove(&token).is_some());
        assert!(bridge.inner.tokens.remove(&token).is_none());
    }
}
