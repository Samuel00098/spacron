//! TCP tunnels over the remote server's authenticated WebSocket.
//!
//! Two directions, both carried one WebSocket per TCP connection so there is no
//! multiplexing protocol to get wrong:
//!
//! - **Reverse** (`/tunnel/listen` + `/tunnel/accept`): the box listens on its
//!   own `127.0.0.1:<port>` and every connection is piped back to the desktop.
//!   This is how agents running on the box reach the Spacron MCP server, which
//!   lives in the desktop app: their config says `http://127.0.0.1:<port>`, and
//!   on the box that loopback port is this listener. The control socket stays
//!   open for as long as the desktop wants the port; for each accepted
//!   connection it announces an id, and the desktop opens `/tunnel/accept?id=`
//!   to claim and pipe it.
//! - **Forward** (`/tunnel/dial`): the desktop asks the box to connect to its own
//!   `127.0.0.1:<port>` and pipes the result. This is how the preview shows a
//!   dev server running on the box.
//!
//! Both only ever touch loopback on the box, and both require the same
//! pre-shared token as `/pty` — a token holder already has a shell there, so
//! this grants nothing new.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use dashmap::DashMap;
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::{ct_eq, ServerState, FAILED_AUTH_DELAY, TOKEN_PROTO_PREFIX, WS_SUBPROTOCOL};

/// An accepted connection waits this long for the desktop to claim it.
const CLAIM_WINDOW: Duration = Duration::from_secs(30);

fn pending() -> &'static DashMap<u64, (TcpStream, Instant)> {
    static PENDING: OnceLock<DashMap<u64, (TcpStream, Instant)>> = OnceLock::new();
    PENDING.get_or_init(DashMap::new)
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[derive(Deserialize)]
pub(super) struct PortQuery {
    port: u16,
}

#[derive(Deserialize)]
pub(super) struct IdQuery {
    id: u64,
}

/// Same check as `/pty`: the token rides in as a `token.<TOKEN>` subprotocol.
async fn authorized(headers: &HeaderMap, state: &ServerState) -> bool {
    let ok = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .into_iter()
        .flat_map(|s| s.split(','))
        .find_map(|p| p.trim().strip_prefix(TOKEN_PROTO_PREFIX))
        .map(|t| ct_eq(t.as_bytes(), state.token.as_bytes()))
        .unwrap_or(false);
    if !ok {
        tokio::time::sleep(FAILED_AUTH_DELAY).await;
    }
    ok
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response()
}

pub(super) async fn listen_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(q): Query<PortQuery>,
) -> Response {
    if !authorized(&headers, &state).await {
        return unauthorized();
    }
    ws.protocols([WS_SUBPROTOCOL]).on_upgrade(move |socket| run_listener(socket, q.port))
}

pub(super) async fn accept_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(q): Query<IdQuery>,
) -> Response {
    if !authorized(&headers, &state).await {
        return unauthorized();
    }
    let Some((_, (tcp, _))) = pending().remove(&q.id) else {
        return (StatusCode::NOT_FOUND, "no such tunnel connection").into_response();
    };
    ws.protocols([WS_SUBPROTOCOL]).on_upgrade(move |socket| pipe(socket, tcp))
}

pub(super) async fn dial_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Query(q): Query<PortQuery>,
) -> Response {
    if !authorized(&headers, &state).await {
        return unauthorized();
    }
    if q.port == 0 {
        return (StatusCode::BAD_REQUEST, "port must be 1-65535").into_response();
    }
    // Connect before upgrading, so "nothing is listening" is a clean HTTP error
    // the desktop can report instead of a socket that opens and dies.
    match TcpStream::connect(("127.0.0.1", q.port)).await {
        Ok(tcp) => {
            let _ = tcp.set_nodelay(true);
            ws.protocols([WS_SUBPROTOCOL]).on_upgrade(move |socket| pipe(socket, tcp))
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("nothing is listening on the box's port {}: {e}", q.port)).into_response(),
    }
}

async fn run_listener(socket: WebSocket, port: u16) {
    let (mut tx, mut rx) = socket.split();
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            let _ = tx
                .send(Message::Text(json!({ "t": "error", "message": format!("port {port} on the box is busy: {e}") }).to_string().into()))
                .await;
            return;
        }
    };
    if tx.send(Message::Text(json!({ "t": "ready" }).to_string().into())).await.is_err() {
        return;
    }
    let mut mine: Vec<u64> = Vec::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((tcp, _)) = accepted else { continue };
                let _ = tcp.set_nodelay(true);
                let id = next_id();
                pending().insert(id, (tcp, Instant::now()));
                mine.push(id);
                if tx.send(Message::Text(json!({ "t": "conn", "id": id }).to_string().into())).await.is_err() {
                    break;
                }
                // Forget connections nobody claimed.
                pending().retain(|_, (_, at)| at.elapsed() < CLAIM_WINDOW);
                mine.retain(|id| pending().contains_key(id));
            }
            msg = rx.next() => match msg {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
        }
    }
    // The desktop went away: unclaimed connections on this port go with it.
    for id in mine {
        pending().remove(&id);
    }
}

/// Shovel bytes between one WebSocket and one TCP stream until either closes.
async fn pipe(socket: WebSocket, tcp: TcpStream) {
    let (mut ws_tx, mut ws_rx) = socket.split();
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
