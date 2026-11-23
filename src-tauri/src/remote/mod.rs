//! Headless remote-workspace server (Step 1 of `docs/remote-workspace.md`).
//!
//! Serves the PTY core over a single WebSocket route, `GET /pty`, so the desktop
//! app can attach terminals that actually run on a remote box. One connection
//! multiplexes many sessions by id. Control frames are JSON text; live terminal
//! output is binary (`[kind:u8][id:u32 BE][payload]`) so it isn't base64-bloated.
//!
//! Also carries request/response file ops + fs-watch over the same socket (Step 2)
//! and serves language servers on a second route, `GET /lsp` (Step 3). Git and
//! agents are not moved here yet.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use dashmap::DashMap;
use futures_util::{sink::SinkExt, stream::StreamExt};
use notify::RecommendedWatcher;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::commands::file_system as fs;
use crate::commands::fs_watch;
use crate::lsp::registry::{self, ResolvedCommand};
use crate::lsp::server::LspServer;
use crate::pty::manager::PtyManager;
use crate::pty::session::{self, DataSink, ExitSink};
use crate::pty::shell::{self, ShellConfig};
use crate::state::WriteRateLimiter;

mod acp_bridge;
mod receive;
mod automations;
mod tunnel;

/// Binary frame kinds (first byte of a server→client binary message).
const KIND_DATA: u8 = 0;
const KIND_REPLAY: u8 = 1;

/// Matches the desktop path's per-write cap in `commands::terminal`.
const MAX_WRITE_LEN: usize = 256 * 1024;

/// Non-secret subprotocol echoed back to complete the handshake.
const WS_SUBPROTOCOL: &str = "spacron.v1";
/// The client presents its token as a `token.<TOKEN>` subprotocol offer.
const TOKEN_PROTO_PREFIX: &str = "token.";

/// How long a minted LSP connection token stays valid before its WebSocket must
/// connect. The `/lsp` socket is created by CodeMirror's `WebSocketTransport`,
/// which only accepts a URL — so, exactly as the desktop bridge does, `lsp_start`
/// (over the already-authenticated main socket) mints a single-use ephemeral
/// token and the `/lsp` route consumes it. The pre-shared secret never hits a URL.
const LSP_TOKEN_TTL: Duration = Duration::from_secs(30);

/// How long a connection presenting a wrong or missing token waits before it
/// is refused.
const FAILED_AUTH_DELAY: Duration = Duration::from_secs(1);

/// How the server was launched.
pub struct ServerConfig {
    /// Root the client's terminals are confined to. Canonicalized on startup.
    pub workspace: PathBuf,
    pub port: u16,
    /// Pre-shared token the client must present on connect.
    pub token: String,
    /// If set, auto-commit uncommitted changes in the workspace at this interval.
    /// None (default) disables auto-commit.
    pub auto_commit_interval: Option<Duration>,
    /// PEM cert + key. Some — serve `wss://` (TLS). None — plaintext `ws://`,
    /// only safe behind a link that encrypts for you (Tailscale/VPN).
    pub tls: Option<(PathBuf, PathBuf)>,
}

struct ServerState {
    pty: PtyManager,
    rate: WriteRateLimiter,
    workspace: PathBuf,
    token: String,
    /// Ephemeral, single-use tokens authorizing an `/lsp` WebSocket. Keyed by a
    /// uuid handed out by `lsp_start`; each carries the (already workspace-confined)
    /// launch parameters so the socket client can't inject an arbitrary command.
    lsp_tokens: DashMap<String, PendingLsp>,
}

/// A language server resolved and authorized by `lsp_start`, awaiting its socket.
struct PendingLsp {
    cmd: ResolvedCommand,
    cwd: String,
    created: Instant,
}

impl ServerState {
    /// Authorize an LSP launch and return a single-use connection token.
    fn mint_lsp_token(&self, cmd: ResolvedCommand, cwd: String) -> String {
        // Drop tokens whose socket never connected.
        self.lsp_tokens
            .retain(|_, s| s.created.elapsed() < LSP_TOKEN_TTL);
        let token = uuid::Uuid::new_v4().to_string();
        self.lsp_tokens.insert(
            token.clone(),
            PendingLsp {
                cmd,
                cwd,
                created: Instant::now(),
            },
        );
        token
    }
}

/// Bind the server and serve until the process is killed.
pub async fn serve(cfg: ServerConfig) -> anyhow::Result<()> {
    let workspace = std::fs::canonicalize(&cfg.workspace)
        .map_err(|e| anyhow::anyhow!("workspace {:?}: {e}", cfg.workspace))?;
    // Strip the Windows `\\?\` extended-length prefix so the root matches the
    // paths checked in `file_system` (which are cleaned the same way before the
    // confinement `starts_with`); otherwise every op reads as "outside project".
    let workspace = crate::commands::clean_path_buf(workspace);
    if !workspace.is_dir() {
        return Err(anyhow::anyhow!("workspace {:?} is not a directory", workspace));
    }

    let state = Arc::new(ServerState {
        pty: PtyManager::new(),
        rate: WriteRateLimiter::new(),
        workspace,
        token: cfg.token,
        lsp_tokens: DashMap::new(),
    });

    let app = Router::new()
        .route("/pty", any(ws_handler))
        .route("/lsp", any(lsp_ws_handler))
        // TCP tunnels: agents on the box reach the desktop's MCP server, and the
        // preview reaches dev servers on the box. See `tunnel.rs`.
        .route("/tunnel/listen", any(tunnel::listen_handler))
        .route("/tunnel/accept", any(tunnel::accept_handler))
        .route("/tunnel/dial", any(tunnel::dial_handler))
        .with_state(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    // ── Auto-commit background task (Step 5 durability) ──────────────────────
    // Periodically stage and commit uncommitted changes as a safety net against
    // VM loss.
    if let Some(interval_dur) = cfg.auto_commit_interval {
        let ws_path = state.workspace.clone();
        tokio::spawn(async move {
            auto_commit_loop(ws_path, interval_dur).await;
        });
        eprintln!(
            "auto-commit enabled (interval: {interval_dur:?}) — periodically saves uncommitted changes"
        );
    }

    // Automations that run here, so they fire while the laptop is closed.
    tokio::spawn(automations::run_loop(state.workspace.clone()));

    let listener = tokio::net::TcpListener::bind(addr).await?;
    if let Some((cert, key)) = cfg.tls {
        serve_tls(app, state, listener, cert, key).await?;
    } else {
        println!(
            "spacron-server listening on ws://{addr}/pty  (workspace: {})",
            state.workspace.display()
        );
        // Plaintext ws:// — the token authenticates but does not encrypt. Run
        // behind Tailscale/VPN, which encrypts the link, or start with
        // `--cert/--key` for wss://. See docs/remote-workspace.md.
        eprintln!(
            "WARNING: plaintext transport (ws://). Bound to 0.0.0.0:{:?} — only expose this over \
             Tailscale/VPN, never a public network.",
            cfg.port
        );
        axum::serve(listener, app).await?;
    }
    Ok(())
}

/// rustls 0.23 refuses to auto-pick a crypto provider when the crate-feature
/// graph enables both `ring` and `aws-lc-rs` (the updater pulls ring, reqwest's
/// rustls stack pulls aws-lc-rs), and `ClientConfig::builder()` panics. Install
/// `ring` explicitly, once, process-wide — lazy so it covers the desktop app,
/// the spacron-server binary, and the relay tests alike.
pub(crate) fn ensure_crypto_provider() {
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    });
}

/// How long a client gets to finish the TLS handshake before its connection is
/// dropped. Generous for a real client on a slow link, short enough that idle
/// sockets cannot pile up.
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Read the `--cert`/`--key` PEM pair off disk into the DER material rustls
/// wants.
///
/// Split out of [`serve_tls`] so it is reachable from a test: `serve_tls` owns a
/// listener and an accept loop that never returns, so nothing else in this file
/// can exercise the parsing.
///
/// `pem_file_iter`/`from_pem_file` open the file themselves, so an unreadable
/// path and malformed PEM both surface as one `PemError` — these split them back
/// apart so the operator is told which of the two went wrong. This runs on a
/// headless box where the printed error is the only diagnostic.
fn load_tls_material(
    cert: &Path,
    key: &Path,
) -> anyhow::Result<(
    Vec<rustls_pki_types::CertificateDer<'static>>,
    rustls_pki_types::PrivateKeyDer<'static>,
)> {
    use rustls_pki_types::pem::{Error as PemError, PemObject};
    use rustls_pki_types::{CertificateDer, PrivateKeyDer};

    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|e| match e {
            PemError::Io(io) => anyhow::anyhow!("--cert {:?}: {io}", cert),
            other => anyhow::anyhow!("--cert {:?} is not valid PEM: {other}", cert),
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("--cert {:?} is not valid PEM: {e}", cert))?;
    if certs.is_empty() {
        return Err(anyhow::anyhow!("--cert {:?} contains no certificates", cert));
    }
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| match e {
        PemError::Io(io) => anyhow::anyhow!("--key {:?}: {io}", key),
        // A PEM file that parses but holds no key section at all — the old
        // `rustls_pemfile::private_key(..) -> Option` shape reported this
        // separately, and the message is worth keeping distinct from "the bytes
        // are not PEM".
        PemError::NoItemsFound => anyhow::anyhow!("--key {:?} contains no private key", key),
        other => anyhow::anyhow!("--key {:?} is not valid PEM: {other}", key),
    })?;
    Ok((certs, key))
}

/// Serve the router over TLS (wss://) with the official axum TLS pattern:
/// a tokio-rustls `TlsAcceptor` accept loop feeding hyper-util's auto builder,
/// which performs WebSocket upgrades (the axum 0.8 Router implements
/// `Service<Request<B>>`, so `serve_connection_with_upgrades` is the right call).
async fn serve_tls(
    app: axum::Router<()>,
    state: Arc<ServerState>,
    listener: tokio::net::TcpListener,
    cert: PathBuf,
    key: PathBuf,
) -> anyhow::Result<()> {
    ensure_crypto_provider();
    use std::sync::Arc as StdArc;

    use hyper_util::rt::TokioExecutor;
    use tokio_rustls::rustls::ServerConfig as RustlsServerConfig;
    use tokio_rustls::TlsAcceptor;

    let (certs, key) = load_tls_material(&cert, &key)?;

    let server_config = RustlsServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| anyhow::anyhow!("TLS config from --cert/--key failed: {e}"))?;
    let acceptor = TlsAcceptor::from(StdArc::new(server_config));

    let addr = listener.local_addr()?;
    println!(
        "spacron-server serving WSS (TLS) on wss://{addr}/pty  (workspace: {})",
        state.workspace.display()
    );

    loop {
        // `accept` fails for per-connection reasons too (the peer vanished
        // mid-handshake, the fd table is full). `axum::serve` swallows those
        // and backs off; propagating instead would take the whole server down
        // on one bad client, which matters here because TLS mode is the one
        // meant to face a public network.
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(err) => {
                eprintln!("spacron-server: accept failed: {err}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        tokio::spawn(async move {
            // Bounded: a client that connects and then sends nothing would
            // otherwise hold this task and its fd forever.
            let handshake = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream));
            let Ok(Ok(stream)) = handshake.await else {
                return; // timed out, or handshake failed (e.g. plaintext client)
            };
            let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(
                    hyper_util::rt::TokioIo::new(stream),
                    // axum implements tower_service::Service; hyper 1.x speaks
                    // its own hyper::service::Service, so bridge the two.
                    hyper_util::service::TowerToHyperService::new(app),
                )
                .await;
        });
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    // Authenticate via the WebSocket subprotocol, not a `?token=` query param:
    // the client offers `token.<TOKEN>` in Sec-WebSocket-Protocol. This keeps the
    // secret out of the URL (which lands in server/proxy logs and history). The
    // browser WebSocket API can't set an Authorization header, so a subprotocol
    // is the only client-settable channel. Token must be a valid subprotocol
    // token (alphanumeric / -._~ etc.) — e.g. alphanumeric or base64url.
    let presented = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .into_iter()
        .flat_map(|s| s.split(','))
        .find_map(|p| p.trim().strip_prefix(TOKEN_PROTO_PREFIX));

    let authorized = presented
        .map(|t| ct_eq(t.as_bytes(), state.token.as_bytes()))
        .unwrap_or(false);
    if !authorized {
        // Slow every wrong guess down so the token can't be brute-forced at
        // wire speed from one connection.
        tokio::time::sleep(FAILED_AUTH_DELAY).await;
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }

    // Echo the non-secret subprotocol so the handshake completes; never reflect
    // the token protocol back.
    ws.protocols([WS_SUBPROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state))
}

/// A random id for this server process, minted once.
fn server_instance_id() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

/// Constant-time byte comparison, so token validation doesn't leak length-prefix
/// match progress via timing. (The length check leaks only the length, which is
/// standard and acceptable here.)
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn handle_socket(socket: WebSocket, state: Arc<ServerState>) {
    let (mut sender, mut receiver) = socket.split();
    // Single writer task owns the socket sink; every session's output sink pushes
    // through this channel so writes are serialized. When the socket dies the
    // task ends, dropping the receiver, which makes the sinks report themselves
    // dead so the still-running PTY sessions shed them (output keeps buffering for
    // a later re-attach — sessions intentionally survive a disconnect).
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    // Chat-view agents running here send their events to every connected desktop.
    acp_bridge::attach_client(out_tx.clone());
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Filesystem watchers owned by this connection, keyed by watched path. They
    // stop when the map is dropped at disconnect (dropping a watcher ends its OS
    // watch and debounce thread). Terminals are NOT tracked here — those survive
    // a disconnect for later re-attach.
    let mut watchers: HashMap<String, RecommendedWatcher> = HashMap::new();

    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => handle_control(text.as_str(), &state, &out_tx, &mut watchers),
            Message::Close(_) => break,
            _ => {}
        }
    }

    writer.abort();
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum ClientMsg {
    Create {
        req_id: Option<u64>,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        env: Option<HashMap<String, String>>,
    },
    Write {
        id: u32,
        data: String,
    },
    Resize {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Close {
        id: u32,
    },
    Attach {
        req_id: Option<u64>,
        id: u32,
    },
    ListShells {
        req_id: Option<u64>,
    },
    /// Generic request/response call for the non-streaming commands (file ops).
    /// `cmd` names the operation; `args` mirrors the Tauri command's named args.
    Invoke {
        req_id: u64,
        cmd: String,
        args: Value,
    },
    /// Begin a recursive debounced watch of `path` (confined to the workspace).
    /// Change bursts arrive as `{ t: "fsChange", path }` frames.
    StartWatch {
        path: String,
    },
    StopWatch {
        path: String,
    },
}

fn handle_control(
    text: &str,
    state: &ServerState,
    out: &UnboundedSender<Message>,
    watchers: &mut HashMap<String, RecommendedWatcher>,
) {
    let msg = match serde_json::from_str::<ClientMsg>(text) {
        Ok(m) => m,
        Err(e) => return send_err(out, None, format!("bad message: {e}")),
    };

    match msg {
        ClientMsg::Create {
            req_id,
            cols,
            rows,
            cwd,
            shell,
            env,
        } => {
            let cwd = match resolve_cwd(cwd, &state.workspace) {
                Ok(c) => c,
                Err(e) => return send_err(out, req_id, e),
            };
            let shell = select_shell(shell);
            let id = state.pty.reserve_id();
            let data_sink = Box::new(WsDataSink {
                id,
                tx: out.clone(),
                kind: KIND_DATA,
            });
            let exit_sink = Box::new(WsExitSink {
                id,
                tx: out.clone(),
            });
            match session::spawn(cols, rows, shell, cwd, data_sink, exit_sink, env) {
                Ok(sess) => {
                    state.pty.insert_with_id(id, sess);
                    send_json(out, json!({ "t": "created", "reqId": req_id, "id": id }));
                }
                Err(e) => send_err(out, req_id, e),
            }
        }
        ClientMsg::Write { id, data } => {
            if data.len() > MAX_WRITE_LEN {
                return send_err(out, None, "Data exceeds maximum write size".into());
            }
            if !state.rate.check_and_record(id, data.len()) {
                return send_err(out, None, "Write rate limit exceeded (1 MB/s per session)".into());
            }
            if let Some(sess) = state.pty.get(id) {
                let _ = sess.write(&data);
            }
        }
        ClientMsg::Resize { id, cols, rows } => {
            if let Some(sess) = state.pty.get(id) {
                let _ = sess.resize(rows, cols);
            }
        }
        ClientMsg::Close { id } => {
            if let Some(sess) = state.pty.remove(id) {
                state.rate.remove(id);
                let _ = sess.close();
            }
        }
        ClientMsg::Attach { req_id, id } => {
            let Some(sess) = state.pty.get(id) else {
                return send_err(out, req_id, format!("Session not found: {id}"));
            };
            let data_sink = Box::new(WsDataSink {
                id,
                tx: out.clone(),
                kind: KIND_DATA,
            });
            let exit_sink = Box::new(WsExitSink {
                id,
                tx: out.clone(),
            });
            match sess.attach(data_sink, exit_sink) {
                Ok(replay) => {
                    if !replay.is_empty() {
                        let _ = out.send(Message::Binary(frame(KIND_REPLAY, id, &replay).into()));
                    }
                    send_json(out, json!({ "t": "attached", "reqId": req_id, "id": id }));
                }
                Err(e) => send_err(out, req_id, e),
            }
        }
        ClientMsg::ListShells { req_id } => {
            send_json(
                out,
                json!({ "t": "shells", "reqId": req_id, "list": shell::available_shells() }),
            );
        }
        ClientMsg::Invoke { req_id, cmd, args } if cmd.starts_with("acp_") => {
            let reply_out = out.clone();
            let handled = acp_bridge::handle(&cmd, &args, &state.workspace, move |result| match result {
                Ok(value) => send_json(&reply_out, json!({ "t": "invokeOk", "reqId": req_id, "value": value })),
                Err(e) => send_json(&reply_out, json!({ "t": "invokeErr", "reqId": req_id, "message": e })),
            });
            if handled.is_none() {
                send_json(out, json!({ "t": "invokeErr", "reqId": req_id, "message": format!("unsupported remote command: {cmd}") }));
            }
        }
        ClientMsg::Invoke { req_id, cmd, args } if cmd == "remote_clone_repo" => {
            // A clone can take a while; answer when it is done.
            let out = out.clone();
            let workspace = state.workspace.clone();
            tokio::task::spawn_blocking(move || {
                match receive::clone_upload(&args, &workspace) {
                    Ok(value) => send_json(&out, json!({ "t": "invokeOk", "reqId": req_id, "value": value })),
                    Err(e) => send_json(&out, json!({ "t": "invokeErr", "reqId": req_id, "message": e })),
                }
            });
        }
        ClientMsg::Invoke { req_id, cmd, args } if cmd == "search_in_project" => {
            // Project search walks the whole tree, so it runs off this loop and
            // answers when done. The desktop's project id means nothing here:
            // the box searches its own workspace.
            let out = out.clone();
            let root = active_root(state).to_string_lossy().to_string();
            tokio::spawn(async move {
                let flag = |k: &str| args.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
                let num = |k: &str| args.get(k).and_then(|v| v.as_u64()).map(|n| n as usize);
                let result = crate::commands::search::search_roots(
                    vec![root],
                    args.get("query").and_then(|v| v.as_str()).unwrap_or(""),
                    flag("caseSensitive"),
                    flag("wholeWord"),
                    flag("useRegex"),
                    args.get("includeGlob").and_then(|v| v.as_str()).map(str::to_string),
                    num("offset"),
                    num("limit"),
                )
                .await
                .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()));
                match result {
                    Ok(value) => send_json(&out, json!({ "t": "invokeOk", "reqId": req_id, "value": value })),
                    Err(e) => send_json(&out, json!({ "t": "invokeErr", "reqId": req_id, "message": e })),
                }
            });
        }
        ClientMsg::Invoke { req_id, cmd, args } => {
            // A couple of commands need server state (LSP), so they're handled here;
            // everything else is a stateless file-system op routed to the fs core.
            // The project folder the desktop has open: the box folder itself or
            // a folder inside it (see `remote_set_project_root`).
            let root = active_root(state);
            let result = match cmd.as_str() {
                "remote_set_project_root" => set_project_root(&args, state),
                "remote_list_folders" => list_folders(&args, state),
                "remote_upload_chunk" => receive::upload_chunk(&args, &state.workspace),
                "lsp_check_server" => lsp_check_server(args),
                "lsp_start" => lsp_start(args, state),
                "workspace_info" => workspace_info(state),
                // This server's run: saved terminal ids are only meaningful
                // against the same run, which outlives the desktop app.
                "terminal_instance_id" => Ok(json!(server_instance_id())),
                "box_automations_sync" => automations::sync(args, &state.workspace),
                "box_automations_state" => automations::state(&state.workspace),
                "box_automation_run_now" => automations::run_now(args, &state.workspace),
                "workspace_git_log" => git_log(args, &root),
                "workspace_git_status" => git_status(&root),
                "workspace_git_diff" => git_diff(args, &root),
                "workspace_git_create_worktree" => git_create_worktree(args, &root),
                "project_worktree_list" => project_worktree_list(&root),
                "project_worktree_review_metadata" => crate::commands::project_worktrees::review_metadata(
                    &root, str_arg(&args, "worktreePath").as_deref(),
                ).and_then(|metadata| serde_json::to_value(metadata).map_err(|e| e.to_string())),
                "project_worktree_bases" => project_worktree_bases(&root),
                "project_worktree_create" => project_worktree_create(args, &root),
                "project_worktree_delete" => project_worktree_delete(args, &root),
                "project_worktree_update" => project_worktree_update(args, &root),
                "workspace_git_remove_worktree" => git_remove_worktree(args, &root),
                "workspace_git_worktree_status" => git_worktree_status(args, &root),
                "workspace_git_worktree_has_changes" => git_worktree_has_changes(args, &root),
                "workspace_git_worktree_delta" => git_worktree_delta(args, &root),
                "workspace_git_stage_worktree" => git_stage_worktree(args, &root),
                "workspace_git_merge_worktree" => git_merge_worktree(args, &root),
                "workspace_git_rename_worktree" => git_rename_worktree(args, &root),
                _ => dispatch_invoke(&cmd, args, &[state.workspace.clone()]),
            };
            match result {
                Ok(value) => send_json(out, json!({ "t": "invokeOk", "reqId": req_id, "value": value })),
                Err(e) => send_json(out, json!({ "t": "invokeErr", "reqId": req_id, "message": e })),
            }
        }
        ClientMsg::StartWatch { path } => {
            if watchers.contains_key(&path) {
                return; // already watching
            }
            // Confine the watch to the workspace, same rule as file ops.
            if let Err(e) = fs::require_in_roots(Path::new(&path), &[state.workspace.clone()]) {
                return send_err(out, None, e);
            }
            let out_for_watch = out.clone();
            let emit_path = path.clone();
            match fs_watch::spawn_watch(&path, move || {
                let _ = out_for_watch.send(Message::Text(
                    json!({ "t": "fsChange", "path": emit_path }).to_string().into(),
                ));
            }) {
                Ok(watcher) => {
                    watchers.insert(path, watcher);
                }
                Err(e) => send_err(out, None, e),
            }
        }
        ClientMsg::StopWatch { path } => {
            watchers.remove(&path); // drop -> stops the OS watch
        }
    }
}

/// Route a generic `invoke` to a file-system core function. `args` mirrors the
/// Tauri command's named arguments; the result is JSON-encoded for the client.
fn dispatch_invoke(cmd: &str, args: Value, roots: &[PathBuf]) -> Result<Value, String> {
    fn parse<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, String> {
        serde_json::from_value(args).map_err(|e| format!("bad args: {e}"))
    }
    fn ok<T: serde::Serialize>(value: T) -> Result<Value, String> {
        serde_json::to_value(value).map_err(|e| e.to_string())
    }

    #[derive(Deserialize)]
    struct PathArgs {
        path: String,
    }
    #[derive(Deserialize)]
    struct FromToArgs {
        from: String,
        to: String,
    }
    #[derive(Deserialize)]
    struct WriteFileArgs {
        path: String,
        content: String,
    }
    #[derive(Deserialize)]
    struct WriteBinaryArgs {
        path: String,
        data: Vec<u8>,
    }

    match cmd {
        "fs_read_dir" => ok(fs::read_dir(&parse::<PathArgs>(args)?.path, roots)?),
        "fs_read_file" => ok(fs::read_file(&parse::<PathArgs>(args)?.path, roots)?),
        "fs_read_binary" => ok(fs::read_binary(&parse::<PathArgs>(args)?.path, roots)?),
        "fs_get_file_info" => ok(fs::get_file_info(&parse::<PathArgs>(args)?.path, roots)?),
        "fs_create_file" => ok(fs::create_file(&parse::<PathArgs>(args)?.path, roots)?),
        "fs_create_dir" => ok(fs::create_dir(&parse::<PathArgs>(args)?.path, roots)?),
        "fs_delete" => ok(fs::delete(&parse::<PathArgs>(args)?.path, roots)?),
        "fs_glob_files" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Glob { root_path: String, pattern: String, match_anywhere: bool, max: usize, #[serde(default)] ignored_only: bool }
            let a = parse::<Glob>(args)?;
            if a.ignored_only {
                return ok(fs::glob_ignored_files(&a.root_path, &a.pattern, a.match_anywhere, a.max, roots)?);
            }
            ok(fs::glob_files(&a.root_path, &a.pattern, a.match_anywhere, a.max, roots)?)
        }
        "fs_write_file_checked" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Checked { path: String, content: String, expected_content: Option<String> }
            let a = parse::<Checked>(args)?;
            ok(fs::write_file_checked(&a.path, &a.content, a.expected_content.as_deref(), roots)?)
        }
        "fs_write_file" => {
            let a = parse::<WriteFileArgs>(args)?;
            ok(fs::write_file(&a.path, &a.content, roots)?)
        }
        "fs_write_binary" => {
            let a = parse::<WriteBinaryArgs>(args)?;
            ok(fs::write_binary(&a.path, &a.data, roots)?)
        }
        "fs_rename" => {
            let a = parse::<FromToArgs>(args)?;
            ok(fs::rename(&a.from, &a.to, roots)?)
        }
        "fs_copy" => {
            let a = parse::<FromToArgs>(args)?;
            ok(fs::copy(&a.from, &a.to, roots)?)
        }
        other => Err(format!("unsupported remote command: {other}")),
    }
}

/// Probe whether a language server binary is on the *server's* PATH — so the
/// desktop client checks the machine the code actually lives on. Mirrors the
/// desktop `lsp_check_server` command; returns the same `ServerStatus` shape.
fn lsp_check_server(args: Value) -> Result<Value, String> {
    #[derive(Deserialize)]
    struct LangArgs {
        language: String,
    }
    let a: LangArgs = serde_json::from_value(args).map_err(|e| format!("bad args: {e}"))?;
    serde_json::to_value(crate::commands::lsp::lsp_check_server(a.language))
        .map_err(|e| e.to_string())
}

/// Resolve `(root, language)` to a launchable server, confine the root to the
/// workspace, and mint a single-use `/lsp` connection token. The desktop
/// `lsp_start` returns a localhost bridge `{ port, token, root_uri }`; the remote
/// twin has no separate port (the `/lsp` route shares this server), so it returns
/// `{ token, root_uri }` and the client derives the URL from its remote target.
fn lsp_start(args: Value, state: &ServerState) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StartArgs {
        root: Option<String>,
        language: String,
    }
    let a: StartArgs = serde_json::from_value(args).map_err(|e| format!("bad args: {e}"))?;

    let def = registry::lookup(&a.language)
        .ok_or_else(|| format!("No language server configured for '{}'", a.language))?;
    let cmd = registry::resolve(def).ok_or_else(|| {
        format!(
            "Language server '{}' not found. Install it with: {}",
            def.command, def.install_hint
        )
    })?;

    // Confine the root to the workspace (defaults to the workspace root). Reuses
    // the terminal-cwd rule — the server runs with this as its working directory.
    let cwd = resolve_cwd(a.root, &state.workspace)?;
    let root_uri = path_to_file_uri(Path::new(&cwd));
    let token = state.mint_lsp_token(cmd, cwd);

    Ok(json!({ "token": token, "root_uri": root_uri }))
}

/// Report the server's workspace root so the client can open a project pointed
/// at it (Step 4 "open the remote root" — the file tree/editor then read/write
/// through the same socket via the fs core). The root is already canonicalized
/// and `\\?\`-stripped in `serve()`; `name` is just the leaf folder for display.
/// The project folder the desktop opened, or the box folder when it opened none.
/// Global rather than per connection: one desktop drives a server at a time,
/// and a reconnect must land back in the same folder.
fn active_root_cell() -> &'static std::sync::Mutex<Option<PathBuf>> {
    static CELL: std::sync::OnceLock<std::sync::Mutex<Option<PathBuf>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(None))
}

fn active_root(state: &ServerState) -> PathBuf {
    active_root_cell()
        .lock()
        .ok()
        .and_then(|r| r.clone())
        .filter(|r| r.starts_with(&state.workspace) && r.is_dir())
        .unwrap_or_else(|| state.workspace.clone())
}

/// Resolve a folder the desktop named to a canonical path inside the box folder.
fn folder_in_workspace(path: &str, state: &ServerState) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Folder not found on the box: {e}"))?;
    let canonical = crate::commands::clean_path_buf(canonical);
    if !canonical.starts_with(&state.workspace) {
        return Err(format!("Only folders inside {} can be opened on this box.", state.workspace.display()));
    }
    if !canonical.is_dir() {
        return Err("That is not a folder.".into());
    }
    Ok(canonical)
}

/// `remote_set_project_root`: make a folder inside the box folder the active project.
fn set_project_root(args: &Value, state: &ServerState) -> Result<Value, String> {
    let path = str_arg(args, "path").ok_or("Missing folder path.")?;
    let folder = folder_in_workspace(&path, state)?;
    if let Ok(mut cell) = active_root_cell().lock() {
        *cell = Some(folder.clone());
    }
    let name = folder.file_name().and_then(|n| n.to_str()).unwrap_or("workspace").to_string();
    Ok(json!({ "root": folder.to_string_lossy(), "name": name }))
}

/// `remote_list_folders`: the folders directly inside `path` (default: the box
/// folder), for the desktop's folder picker. Hidden folders are skipped.
fn list_folders(args: &Value, state: &ServerState) -> Result<Value, String> {
    let dir = match str_arg(args, "path") {
        Some(p) if !p.is_empty() => folder_in_workspace(&p, state)?,
        _ => state.workspace.clone(),
    };
    let mut folders: Vec<Value> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Could not read {}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" {
                return None;
            }
            let path = e.path();
            Some(json!({ "name": name, "path": path.to_string_lossy(), "isRepo": path.join(".git").exists() }))
        })
        .collect();
    folders.sort_by_key(|f| f["name"].as_str().unwrap_or_default().to_lowercase());
    let parent = (dir != state.workspace).then(|| dir.parent().map(|p| p.to_string_lossy().to_string())).flatten();
    Ok(json!({ "path": dir.to_string_lossy(), "root": state.workspace.to_string_lossy(), "parent": parent, "folders": folders }))
}

fn workspace_info(state: &ServerState) -> Result<Value, String> {
    let root = state.workspace.to_string_lossy().to_string();
    let name = state
        .workspace
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    Ok(json!({ "root": root, "name": name }))
}

fn path_to_file_uri(path: &Path) -> String {
    // url::Url handles platform-specific (e.g. Windows drive-letter) encoding.
    url::Url::from_directory_path(path)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| format!("file://{}", path.to_string_lossy()))
}

// ── Remote git operations (Step 5) ─────────────────────────────────────────
// Simplified git commands that run against the server's single workspace root.
// The desktop commands look up the project by projectId in AppState; here we
// use the workspace root directly since there is only one project.

/// Run git in the workspace root and return trimmed stdout on success.
fn git_run(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(format!("git {} failed: {stderr}", args.join(" ")))
    }
}

/// Like [`git_run`] but keeps the output exactly as git wrote it. Porcelain
/// status needs this: its first column is a space for unstaged changes, and
/// trimming would shift the two-character status code out of alignment.
fn git_run_raw(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(format!("git {} failed: {stderr}", args.join(" ")))
    }
}

fn git_capture(workspace: &Path, args: &[&str]) -> Option<String> {
    std::process::Command::new("git")
        .args(args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn git_ok(workspace: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check that git is available, returning a clear message when it isn't.
fn check_git_remote() -> Result<(), String> {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Git is not installed on the remote server. Install git to use agent worktrees.".to_string()
            } else {
                format!("Failed to run git: {e}")
            }
        })?;
    Ok(())
}

/// workspace_git_log: return recent git log entries for the workspace.
fn git_log(_args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    if !workspace.join(".git").exists() {
        return Ok(Value::Array(vec![]));
    }
    let stdout = git_run(workspace, &[
        "log",
        "--graph",
        "--pretty=format:__DELIM__%h__DELIM__%an__DELIM__%ad (%ar)__DELIM__%d__DELIM__%s",
        "--date=format:%Y-%m-%d %H:%M",
        "--abbrev-commit",
        "-n", "50",
    ])?;
    let entries: Vec<Value> = stdout.lines().filter_map(|line| {
        let idx = line.find("__DELIM__")?;
        let (graph, rest) = line.split_at(idx);
        let rest_clean = &rest[9..];
        let parts: Vec<&str> = rest_clean.split("__DELIM__").collect();
        Some(json!({
            "graph": graph,
            "hash": parts.first(),
            "author": parts.get(1),
            "date": parts.get(2),
            "refs": parts.get(3).map(|s| s.trim()),
            "subject": parts.get(4),
        }))
    }).collect();
    Ok(Value::Array(entries))
}

/// workspace_git_status: return the working tree status.
fn git_status(workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    if !workspace.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    let branch = git_capture(workspace, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| "HEAD".to_string());
    let stdout = git_run_raw(workspace, &["status", "--porcelain", "-z"])?;

    let mut modified: Vec<String> = Vec::new();
    let mut added: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut conflicted: Vec<String> = Vec::new();

    for (status_code, path) in crate::commands::workspace::parse_porcelain_z(&stdout) {
        let file_path = path.to_string();
        if status_code.contains('U') || status_code == "AA" || status_code == "DD" {
            conflicted.push(file_path);
        } else if status_code.contains('M') {
            modified.push(file_path);
        } else if status_code.contains('A') {
            added.push(file_path);
        } else if status_code.contains('D') {
            deleted.push(file_path);
        } else if status_code.contains('?') {
            untracked.push(file_path);
        }
    }

    Ok(json!({
        "branch": branch,
        "modified": modified,
        "added": added,
        "deleted": deleted,
        "untracked": untracked,
        "conflicted": conflicted,
        "file_stats": {},
        "total_additions": 0,
        "total_deletions": 0,
    }))
}

/// workspace_git_diff: return the diff against HEAD.
fn git_diff(args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    if !workspace.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }
    let path = args.get("filePath").and_then(|v| v.as_str()).unwrap_or("");
    let output = if path.is_empty() {
        git_run(workspace, &["diff", "HEAD"])
    } else {
        git_run(workspace, &["diff", "HEAD", "--", path])
    };
    output.map(|s| Value::String(s))
}

/// The managed worktree area for the served workspace: `<workspace>/.spacron/worktrees`.
/// Must be inside the workspace root — the remote server confines every terminal
/// and file op to it (`require_in_roots`), so a worktree outside can be created
/// but never used. Mirrors `commands::workspace::worktree_area`.
fn worktree_area(workspace: &Path) -> PathBuf {
    workspace.join(".spacron").join("worktrees")
}

/// Pre-0.7.4 sibling location, still accepted by remove/status so worktrees
/// created before the move can be cleaned up.
fn legacy_worktree_area(workspace: &Path) -> Option<PathBuf> {
    let repo = workspace.file_name()?.to_str()?;
    Some(workspace.parent()?.join(".spacron-worktrees").join(repo))
}

/// Whether `path` sits inside this workspace's managed worktree area (current or
/// legacy). Case-insensitive on Windows.
fn in_managed_worktree_area(path: &Path, workspace: &Path) -> bool {
    let under = |area: &Path| -> bool {
        #[cfg(windows)]
        {
            let (p, a) = (
                path.to_string_lossy().to_lowercase().replace('\\', "/"),
                area.to_string_lossy().to_lowercase().replace('\\', "/"),
            );
            let a = a.trim_end_matches('/');
            p == a || p.starts_with(&format!("{a}/"))
        }
        #[cfg(not(windows))]
        {
            path.starts_with(area)
        }
    };
    under(&worktree_area(workspace))
        || legacy_worktree_area(workspace).is_some_and(|area| under(&area))
}

// ── Project worktrees (the sidebar's worktree rows) ─────────────────────────
// Same core as the desktop commands in `commands/project_worktrees.rs`; the
// remote box has one project, its workspace root.

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn require_git_repo(workspace: &Path) -> Result<(), String> {
    check_git_remote()?;
    if workspace.join(".git").exists() {
        Ok(())
    } else {
        Err("This project is not a Git repository.".to_string())
    }
}

fn project_worktree_list(workspace: &Path) -> Result<Value, String> {
    require_git_repo(workspace)?;
    let list = crate::commands::project_worktrees::list_worktrees(workspace)?;
    serde_json::to_value(list).map_err(|e| e.to_string())
}

fn project_worktree_bases(workspace: &Path) -> Result<Value, String> {
    require_git_repo(workspace)?;
    serde_json::to_value(crate::commands::project_worktrees::list_bases(workspace)).map_err(|e| e.to_string())
}

fn project_worktree_create(args: Value, workspace: &Path) -> Result<Value, String> {
    require_git_repo(workspace)?;
    let opts = crate::commands::project_worktrees::CreateOptions {
        name: str_arg(&args, "name").unwrap_or_default(),
        branch: str_arg(&args, "branch"),
        base_ref: str_arg(&args, "baseRef"),
        note: str_arg(&args, "note"),
        parent: str_arg(&args, "parent"),
        skip_fetch: false,
    };
    let created = crate::commands::project_worktrees::create_worktree(workspace, opts)?;
    serde_json::to_value(created).map_err(|e| e.to_string())
}

fn project_worktree_delete(args: Value, workspace: &Path) -> Result<Value, String> {
    require_git_repo(workspace)?;
    let path = str_arg(&args, "worktreePath").ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;
    let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    let protect_local_files = args.get("protectLocalFiles").and_then(|v| v.as_bool()).unwrap_or(false);
    let deleted = crate::commands::project_worktrees::delete_worktree_with_protection(
        workspace, &path, force, protect_local_files,
    )?;
    serde_json::to_value(deleted).map_err(|e| e.to_string())
}

fn project_worktree_update(args: Value, workspace: &Path) -> Result<Value, String> {
    require_git_repo(workspace)?;
    let path = str_arg(&args, "worktreePath").ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;
    let parent = if args.get("clearParent").and_then(|v| v.as_bool()).unwrap_or(false) {
        Some(None)
    } else {
        str_arg(&args, "parent").map(Some)
    };
    crate::commands::project_worktrees::update_worktree_meta(
        workspace,
        &path,
        str_arg(&args, "name"),
        str_arg(&args, "note"),
        parent,
    )?;
    Ok(Value::Null)
}

/// workspace_git_create_worktree: create an isolated git worktree for an agent.
fn git_create_worktree(args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    let branch = args.get("branch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'branch' argument".to_string())?;
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.contains("..") {
        return Err("Invalid branch name".to_string());
    }

    if !workspace.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    let base_branch = git_capture(workspace, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| "HEAD".to_string());
    let base_commit = git_capture(workspace, &["rev-parse", "HEAD"])
        .ok_or_else(|| "Could not resolve HEAD. The repository has no commits yet.".to_string())?;

    let safe_branch = branch.replace('/', "-");
    let worktree_path = crate::commands::clean_path_buf(
        worktree_area(workspace).join(&safe_branch)
    );
    let path_str = worktree_path.to_string_lossy().to_string();

    // Reuse existing worktree (idempotent on retry).
    if worktree_path.join(".git").exists() {
        return Ok(json!({
            "path": path_str,
            "branch": branch,
            "base_branch": base_branch,
            "base_commit": base_commit,
        }));
    }

    if let Some(p) = worktree_path.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("Failed to create worktree directory: {e}"))?;
    }

    let ok = git_ok(workspace, &["worktree", "add", "-b", branch, &path_str, "HEAD"])
        || git_ok(workspace, &["worktree", "add", &path_str, branch]);

    if !ok {
        return Err(format!("Failed to create worktree for branch '{branch}'"));
    }

    if !worktree_path.is_dir() {
        return Err("Worktree directory was not created.".to_string());
    }

    Ok(json!({
        "path": path_str,
        "branch": branch,
        "base_branch": base_branch,
        "base_commit": base_commit,
    }))
}

/// workspace_git_remove_worktree: remove an agent worktree.
fn git_remove_worktree(args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    let worktree_path = args.get("worktreePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;

    let cleaned = crate::commands::clean_path_buf(PathBuf::from(worktree_path));
    if !in_managed_worktree_area(&cleaned, workspace) {
        return Err("Refusing to remove a path outside the managed worktree area.".to_string());
    }

    if args.get("requireMerged").and_then(|v| v.as_bool()).unwrap_or(false)
        && !crate::commands::project_worktrees::worktree_merged_into_default(
            workspace, &cleaned, args.get("originalHead").and_then(Value::as_str),
        )
    {
        return Err("This worktree has not been merged into the project's primary branch.".to_string());
    }
    crate::worktree_snapshot::remove_clean(workspace, &cleaned, || std::process::Command::new("git"))?;

    let delete_branch = args.get("deleteBranch").and_then(|v| v.as_bool()).unwrap_or(false);
    let branch = args.get("branch").and_then(|v| v.as_str());
    if delete_branch {
        if let Some(b) = branch {
            let b = b.trim();
            if !b.is_empty() && !b.starts_with('-') && !b.contains("..") {
                let _ = std::process::Command::new("git")
                    .args(["branch", "-D", b])
                    .current_dir(workspace)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .output();
            }
        }
    }

    Ok(Value::Null)
}

/// workspace_git_merge_worktree: merge a worktree branch into the main checkout.
fn git_merge_worktree(args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    if !workspace.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    let branch = args.get("branch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'branch' argument".to_string())?;
    let branch = branch.trim();
    if !is_valid_remote_branch_name(branch) {
        return Err("Invalid branch name".to_string());
    }

    let worktree_path = args.get("worktreePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;

    let cleaned = crate::commands::clean_path_buf(PathBuf::from(worktree_path));
    if !in_managed_worktree_area(&cleaned, workspace) {
        return Err("Refusing to merge a path outside the managed worktree area.".to_string());
    }

    let no_commit = args.get("noCommit").and_then(|v| v.as_bool()).unwrap_or(false);
    // With --no-commit the changes are only staged, so the branch is still the
    // sole record of them: default to KEEPING the worktree unless the caller
    // explicitly asks otherwise. Matches workspace.rs.
    let delete_after = args
        .get("deleteAfter")
        .and_then(|v| v.as_bool())
        .unwrap_or(!no_commit);

    // Snapshot before merging — `git merge` only sees commits, so an agent that
    // hasn't committed would otherwise be merged as nothing and then, on the
    // delete_after paths, have its checkout removed. Mirrors `snapshot_worktree`
    // in commands/workspace.rs.
    if cleaned.join(".git").exists() {
        snapshot_worktree_remote(&cleaned)?;
    }

    // Tip after the snapshot: what the merge actually takes.
    let merged_commit = git_capture(workspace, &["rev-parse", branch]).unwrap_or_default();

    // Run git merge from the main workspace root.
    let mut cmd_args: Vec<&str> = vec!["merge", "--no-ff"];
    if no_commit {
        cmd_args.push("--no-commit");
    }
    let merge_msg = format!("Merge worktree branch '{}'", branch);
    cmd_args.push(branch);
    if !no_commit {
        cmd_args.push("-m");
        cmd_args.push(&merge_msg);
    }
    let output = std::process::Command::new("git")
        .args(&cmd_args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git merge: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        if delete_after {
            let _ = std::process::Command::new("git")
                .args(["worktree", "remove", "--force", worktree_path])
                .current_dir(workspace)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();
            let _ = std::process::Command::new("git")
                .args(["worktree", "prune"])
                .current_dir(workspace)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();
            let _ = std::process::Command::new("git")
                .args(["branch", "-D", branch])
                .current_dir(workspace)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output();
        }

        // Both streams: git prints "Already up to date." to stdout, so the old
        // stderr-only check never matched and a no-op merge was announced as one
        // that did something.
        let already_up_to_date = stdout.contains("Already up to date")
            || stdout.contains("Already up-to-date")
            || stderr.contains("Already up to date")
            || stderr.contains("Already up-to-date");

        let msg = if already_up_to_date {
            format!("Nothing to merge. '{branch}' holds nothing your checkout doesn't already have.")
        } else if no_commit && delete_after {
            format!("Changes from '{branch}' staged for review in Source Control, and the worktree and branch were removed.")
        } else if no_commit {
            format!("Changes from '{branch}' staged for review in Source Control, and the worktree was kept for reference.")
        } else if delete_after {
            format!("Branch '{branch}' merged and cleaned up successfully.")
        } else {
            format!("Branch '{branch}' merged successfully.")
        };

        Ok(json!({
            "success": true,
            "message": msg,
            "conflicted": false,
            "already_up_to_date": already_up_to_date,
            "merged_commit": merged_commit,
        }))
    } else {
        let has_conflicts = stderr.contains("conflict") || stdout.contains("CONFLICT");
        // Route git output through the same redactor the local path uses so
        // absolute paths don't leak back to the client.
        let err_out = crate::commands::workspace::sanitize_git_error(&stderr);
        let std_out = crate::commands::workspace::sanitize_git_error(&stdout);
        Ok(json!({
            "success": false,
            "message": if has_conflicts {
                format!("Merge conflict. Resolve the conflicts in the main checkout, then commit.\n{}{}", err_out, std_out)
            } else {
                format!("Merge failed:\n{}{}", err_out, std_out)
            },
            "conflicted": has_conflicts,
            "already_up_to_date": false,
            "merged_commit": merged_commit,
        }))
    }
}

/// Commit an agent's uncommitted work onto its own branch so a commit-range
/// operation can see it. Mirrors `snapshot_worktree` in commands/workspace.rs.
fn snapshot_worktree_remote(worktree: &Path) -> Result<bool, String> {
    crate::worktree_snapshot::snapshot(worktree, || std::process::Command::new("git"))
}

/// Branch-name validation for the remote control path. Mirrors the rules in
/// `commands::workspace::is_valid_branch_name` (which is private to that module).
fn is_valid_remote_branch_name(branch: &str) -> bool {
    let b = branch.trim();
    !b.is_empty()
        && b.len() <= 255
        && !b.starts_with('-')
        && !b.starts_with('.')
        && !b.contains("..")
        && !b.contains("//")
        && !b.ends_with('/')
        && !b.ends_with(".lock")
        && !b.contains(['\0', ' ', '~', '^', ':', '?', '*', '[', '\\'])
        && !b.chars().any(|c| c.is_control())
}

/// A commit-ish about to be interpolated into a git revision range. Hex-only, so a
/// persisted value can never be read as a git flag or a pathspec.
fn is_valid_remote_commit_ish(rev: &str) -> bool {
    let rev = rev.trim();
    (4..=64).contains(&rev.len()) && rev.chars().all(|c| c.is_ascii_hexdigit())
}

/// Shared prologue for the delta/stage commands: validate the repo, branch,
/// baseline and worktree path, returning the cleaned worktree path.
fn worktree_command_setup<'a>(
    args: &'a Value,
    workspace: &Path,
) -> Result<(PathBuf, &'a str, &'a str), String> {
    check_git_remote()?;
    if !workspace.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    let branch = args
        .get("branch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'branch' argument".to_string())?
        .trim();
    if !is_valid_remote_branch_name(branch) {
        return Err("Invalid branch name".to_string());
    }

    let since_commit = args
        .get("sinceCommit")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'sinceCommit' argument".to_string())?
        .trim();
    if !is_valid_remote_commit_ish(since_commit) {
        return Err("Invalid commit".to_string());
    }

    let worktree_path = args
        .get("worktreePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;
    let cleaned = crate::commands::clean_path_buf(PathBuf::from(worktree_path));
    if !in_managed_worktree_area(&cleaned, workspace) {
        return Err("Refusing to inspect a path outside the managed worktree area.".to_string());
    }
    if !cleaned.join(".git").exists() {
        return Err("Not a git worktree.".to_string());
    }

    Ok((cleaned, branch, since_commit))
}

/// workspace_git_worktree_delta: what this worktree holds past `sinceCommit`.
/// Mirrors `workspace_git_worktree_delta` in commands/workspace.rs.
fn git_worktree_delta(args: Value, workspace: &Path) -> Result<Value, String> {
    let (cleaned, branch, since_commit) = worktree_command_setup(&args, workspace)?;

    let head = git_capture(&cleaned, &["rev-parse", "HEAD"])
        .ok_or_else(|| "Could not resolve the worktree's HEAD.".to_string())?;

    let dirty_files = git_capture(&cleaned, &["status", "--porcelain"])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count();

    // Range must be ONE argv entry — a bare ".." makes git read the rest as a pathspec.
    let range = format!("{}..{}", since_commit, branch);
    let committed_paths = git_capture(workspace, &["diff", "--name-only", &range])
        .unwrap_or_default();
    let committed_files = committed_paths
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count();

    let first_subject = if committed_files > 0 {
        git_capture(workspace, &["log", "--reverse", "--format=%s", &range]).and_then(|s| {
            s.lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(str::to_string)
        })
    } else {
        None
    };
    let first_file = committed_paths
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
        .or_else(|| {
            git_capture(&cleaned, &["status", "--porcelain"]).and_then(|s| {
                s.lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(|l| l[3.min(l.len())..].trim().to_string())
            })
        });

    Ok(json!({
        "head": head,
        "dirty_files": dirty_files,
        "committed_files": committed_files,
        "up_to_date": dirty_files == 0 && committed_files == 0,
        "first_file": first_file,
        "first_subject": first_subject,
    }))
}

/// workspace_git_rename_worktree: rename an agent worktree's branch in place.
/// Mirrors `workspace_git_rename_worktree` in commands/workspace.rs — the folder
/// is left where it is (a live agent's terminal has its cwd inside it), and the
/// rename is confined to the `spacron/` prefix.
fn git_rename_worktree(args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    if !workspace.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    let branch = args
        .get("branch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'branch' argument".to_string())?
        .trim();
    let new_branch = args
        .get("newBranch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'newBranch' argument".to_string())?
        .trim();
    if !is_valid_remote_branch_name(new_branch) || !new_branch.starts_with("spacron/") {
        return Err("Invalid branch name".to_string());
    }

    let worktree_path = args
        .get("worktreePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;
    let cleaned = crate::commands::clean_path_buf(PathBuf::from(worktree_path));
    if !in_managed_worktree_area(&cleaned, workspace) {
        return Err("Refusing to rename a path outside the managed worktree area.".to_string());
    }
    if !cleaned.join(".git").exists() {
        return Err("Not a git worktree.".to_string());
    }

    let current = git_capture(&cleaned, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if !branch.is_empty() && current != branch {
        return Err(format!("Worktree is on '{current}', not '{branch}', so the rename was refused."));
    }

    let out = std::process::Command::new("git")
        .args(["branch", "-m", new_branch])
        .current_dir(&cleaned)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git branch -m: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Failed to rename branch: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let after = git_capture(&cleaned, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if after != new_branch {
        return Err(format!("Branch rename did not take effect (still on '{after}')."));
    }

    Ok(json!(new_branch))
}

/// workspace_git_stage_worktree: snapshot the agent's uncommitted work onto its own
/// branch, then apply `sinceCommit..HEAD` into the main checkout's index.
///
/// Mirrors `workspace_git_stage_worktree` in commands/workspace.rs — see that
/// function for why this applies a patch rather than merging (a `--no-commit`
/// merge leaves MERGE_HEAD and blocks every later stage).
fn git_stage_worktree(args: Value, workspace: &Path) -> Result<Value, String> {
    use std::io::Write;
    use std::process::Stdio;

    let (cleaned, branch, since_commit) = worktree_command_setup(&args, workspace)?;
    let snapshot = args.get("snapshot").and_then(|v| v.as_bool()).unwrap_or(true);

    if snapshot {
        snapshot_worktree_remote(&cleaned)?;
    }

    let head = git_capture(&cleaned, &["rev-parse", "HEAD"])
        .ok_or_else(|| "Could not resolve the worktree's HEAD.".to_string())?;

    let range = format!("{}..{}", since_commit, head);
    let diff = std::process::Command::new("git")
        .args(["diff", "--binary", "--no-renames", &range])
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    if !diff.status.success() {
        return Err("Could not read the worktree's changes.".to_string());
    }

    if diff.stdout.is_empty() {
        return Ok(json!({
            "success": true,
            "message": "Already up to date, with nothing new to stage.",
            "conflicted": false,
            "conflicted_files": Vec::<String>::new(),
            "staged_commit": head,
            "staged_files": 0,
            "up_to_date": true,
        }));
    }

    let staged_files = git_capture(workspace, &["diff", "--name-only", &range])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count();

    let mut child = std::process::Command::new("git")
        .args(["apply", "--3way", "--index"])
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run git apply: {}", e))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "Could not write the patch to git apply.".to_string())?
        .write_all(&diff.stdout)
        .map_err(|e| format!("Failed to write patch: {}", e))?;
    drop(child.stdin.take());
    let applied = child
        .wait_with_output()
        .map_err(|e| format!("Failed to run git apply: {}", e))?;

    if applied.status.success() {
        return Ok(json!({
            "success": true,
            "message": format!("Staged {} file(s) from '{}' for review.", staged_files, branch),
            "conflicted": false,
            "conflicted_files": Vec::<String>::new(),
            "staged_commit": head,
            "staged_files": staged_files,
            "up_to_date": false,
        }));
    }

    let conflicted_files: Vec<String> = git_capture(workspace, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let stderr = String::from_utf8_lossy(&applied.stderr).to_string();
    let stdout = String::from_utf8_lossy(&applied.stdout).to_string();
    let conflicted = !conflicted_files.is_empty()
        || stdout.contains("with conflicts")
        || stderr.contains("with conflicts")
        || stderr.contains("conflict");

    Ok(json!({
        "success": false,
        "message": if conflicted {
            format!("Changes from '{}' overlap edits already in your working tree. The conflicting files are marked for you to resolve; everything else was staged.", branch)
        } else {
            format!("Could not stage changes from '{}'.", branch)
        },
        "conflicted": conflicted,
        "conflicted_files": conflicted_files,
        "staged_commit": head,
        "staged_files": staged_files,
        "up_to_date": false,
    }))
}

/// workspace_git_worktree_has_changes: check whether a worktree has any changes.
fn git_worktree_has_changes(args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    if !workspace.join(".git").exists() {
        return Err("This project is not a Git repository.".to_string());
    }

    let worktree_path = args.get("worktreePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;
    let base_commit = args.get("baseCommit")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'baseCommit' argument".to_string())?;
    let branch = args.get("branch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'branch' argument".to_string())?;

    if !is_valid_remote_branch_name(branch) {
        return Err("Invalid branch name".to_string());
    }

    // Only inspect worktrees we manage, matching the guard on git_merge_worktree.
    let cleaned = crate::commands::clean_path_buf(PathBuf::from(worktree_path));
    if !in_managed_worktree_area(&cleaned, workspace) {
        return Err("Refusing to inspect a path outside the managed worktree area.".to_string());
    }

    // 1. Check for uncommitted changes.
    let porcelain = git_capture(&cleaned, &["status", "--porcelain"]).unwrap_or_default();
    let has_uncommitted = porcelain.lines().any(|l| !l.trim().is_empty());
    if has_uncommitted {
        return Ok(json!(true));
    }

    // 2. Check for committed changes not in base. The range MUST be a single
    //    argv entry — passing "<base>", "..", "<branch>" makes git treat `..` as
    //    the end of revisions and the rest as a pathspec, which always fails.
    let range = format!("{}..{}", base_commit, branch);
    match git_capture(workspace, &["rev-list", "--count", &range]) {
        // A genuine count: 0 really means "nothing new on the branch".
        Some(out) => Ok(json!(out.trim().parse::<i64>().map(|n| n > 0).unwrap_or(true))),
        // git failed — assume there may be changes rather than silently hiding
        // the agent's work behind a "nothing to review" result.
        None => Ok(json!(true)),
    }
}

/// workspace_git_worktree_status: live changed-files + branch for a worktree.
fn git_worktree_status(args: Value, workspace: &Path) -> Result<Value, String> {
    check_git_remote()?;
    let worktree_path = args.get("worktreePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing 'worktreePath' argument".to_string())?;

    let path = PathBuf::from(worktree_path);
    let cleaned = crate::commands::clean_path_buf(path);
    if !in_managed_worktree_area(&cleaned, workspace) {
        return Err("Refusing to inspect a path outside the managed worktree area.".to_string());
    }
    if !cleaned.join(".git").exists() {
        return Err("Not a git worktree.".to_string());
    }

    let porcelain = git_capture(&cleaned, &["status", "--porcelain"]).unwrap_or_default();
    let changed_files = porcelain.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    let branch = git_capture(&cleaned, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| "HEAD".to_string());

    Ok(json!({
        "changed_files": changed_files,
        "branch": branch,
    }))
}

/// The `/lsp` WebSocket route. Consumes the single-use token minted by
/// `lsp_start`, spawns the language server next to the code, and pumps LSP
/// messages between it and CodeMirror's `WebSocketTransport`. Same wire shape as
/// the desktop bridge (`lsp/bridge.rs`), so the frontend client is transport-agnostic.
#[derive(Deserialize)]
struct LspQuery {
    token: Option<String>,
}

async fn lsp_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    Query(q): Query<LspQuery>,
) -> Response {
    let token = q.token.unwrap_or_default();
    let pending = state.lsp_tokens.remove(&token).map(|(_, v)| v);
    match pending {
        Some(p) if p.created.elapsed() < LSP_TOKEN_TTL => {
            ws.on_upgrade(move |socket| lsp_pump(socket, p.cmd, p.cwd))
        }
        _ => (StatusCode::FORBIDDEN, "invalid or expired LSP token").into_response(),
    }
}

/// Pump messages between the socket and a freshly spawned language server until
/// either side closes, then kill the server. (Mirror of `lsp::bridge::bridge_socket`.)
async fn lsp_pump(socket: WebSocket, cmd: ResolvedCommand, cwd: String) {
    let (server, mut rx) = match LspServer::spawn(cmd, &cwd) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("remote LSP spawn failed: {e}");
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

/// Confine a requested cwd to the workspace; default to the workspace root.
/// Mirrors the intent of `commands::terminal::resolve_terminal_cwd`, but against
/// a fixed root instead of the app's workspace manager.
fn resolve_cwd(requested: Option<String>, workspace: &Path) -> Result<String, String> {
    let raw = match requested
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        Some(v) => PathBuf::from(v),
        None => return Ok(workspace.to_string_lossy().to_string()),
    };
    let canonical =
        std::fs::canonicalize(&raw).map_err(|_| "Invalid terminal directory".to_string())?;
    // Clean to match the (already-cleaned) workspace root — see serve().
    let canonical = crate::commands::clean_path_buf(canonical);
    if !canonical.starts_with(workspace) {
        return Err("Terminal directory is outside the workspace".to_string());
    }
    if !canonical.is_dir() {
        return Err("Terminal directory must be a folder".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

/// Pick a shell by fuzzy name (as the desktop path does), else auto-detect.
fn select_shell(shell_program: Option<String>) -> ShellConfig {
    match shell_program {
        Some(prog) if !prog.is_empty() => {
            let prog_lower = prog.to_lowercase();
            shell::available_shells()
                .into_iter()
                .find(|s| {
                    s.program.to_lowercase().contains(&prog_lower)
                        || prog_lower.contains(
                            Path::new(&s.program)
                                .file_stem()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_lowercase()
                                .as_str(),
                        )
                })
                .unwrap_or_else(shell::detect_shell)
        }
        _ => shell::detect_shell(),
    }
}

fn frame(kind: u8, id: u32, payload: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(5 + payload.len());
    framed.push(kind);
    framed.extend_from_slice(&id.to_be_bytes());
    framed.extend_from_slice(payload);
    framed
}

fn send_json(out: &UnboundedSender<Message>, value: serde_json::Value) {
    let _ = out.send(Message::Text(value.to_string().into()));
}

fn send_err(out: &UnboundedSender<Message>, req_id: Option<u64>, message: String) {
    send_json(out, json!({ "t": "error", "reqId": req_id, "message": message }));
}

// ── Auto-commit (Step 5 durability) ───────────────────────────────────────
// Background loop that periodically stages and commits uncommitted changes to
// protect work against VM / instance loss.

/// Run git with the given args in `cwd` and return whether it succeeded.
fn git_quiet(cwd: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Build a commit message like `spacron auto-save: 2026-07-06 19:30:00+0100`
/// without external crates (uses SystemTime + local-offset heuristics).
fn auto_commit_message() -> String {
    let now = std::time::SystemTime::now();
    let since_epoch = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = since_epoch.as_secs();
    // Break down into date/time components (UTC; the offset heuristic follows).
    let days = secs / 86400;
    let day_secs = secs % 86400;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    // Civil date from days-since-epoch (Gregorian, no external crates).
    let (y, m, d) = civil_from_days(days as i64);

    // Use a fixed "+0000" offset since we can't easily get the local offset
    // without chrono or a platform-specific call. The message is primarily
    // for identifiability, not absolute time accuracy.
    format!("spacron auto-save: {y:04}-{m:02}-{d:02} {hours:02}:{minutes:02}:{seconds:02}+0000")
}

/// Convert days since 1970-01-01 to (year, month, day) using the civil
/// date algorithm (Howard Hinnant's public-domain approach).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// Background loop: every `interval`, if there are uncommitted changes, stage
/// everything and commit with a descriptive message. Best-effort — failures
/// are logged and the loop continues.
async fn auto_commit_loop(workspace: PathBuf, interval: Duration) {
    // Wait a moment before the first check so the server has time to settle.
    tokio::time::sleep(Duration::from_secs(10)).await;

    let mut timer = tokio::time::interval(interval);
    // The first tick fires immediately since we already slept above.
    timer.tick().await;

    loop {
        timer.tick().await;

        if !git_quiet(&workspace, &["rev-parse", "--is-inside-work-tree"]) {
            // Workspace is not a git repo or git isn't available — nothing to do.
            continue;
        }

        // Check if there are any uncommitted changes (including untracked).
        let has_changes = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&workspace)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .ok()
            .map(|o| {
                let s = String::from_utf8_lossy(&o.stdout);
                !s.trim().is_empty()
            })
            .unwrap_or(false);

        if !has_changes {
            continue;
        }

        // Stage everything.
        if !git_quiet(&workspace, &["add", "-A"]) {
            eprintln!("auto-commit: git add -A failed — skipping this cycle");
            continue;
        }

        // Build a descriptive commit message with timestamp.
        let message = auto_commit_message();

        if !git_quiet(&workspace, &["commit", "-m", &message]) {
            // Nothing to commit after all (possible if only untracked empty files
            // or git-hook filtered everything). Not an error.
            continue;
        }

        eprintln!("auto-commit: {message}");
    }
}

/// Bridges the PTY core's live output onto the connection's outbound channel.
struct WsDataSink {
    id: u32,
    tx: UnboundedSender<Message>,
    kind: u8,
}

impl DataSink for WsDataSink {
    fn send_data(&self, bytes: &[u8]) -> bool {
        self.tx
            .send(Message::Binary(frame(self.kind, self.id, bytes).into()))
            .is_ok()
    }
}

/// Bridges the PTY core's exit code onto the connection's outbound channel.
struct WsExitSink {
    id: u32,
    tx: UnboundedSender<Message>,
}

impl ExitSink for WsExitSink {
    fn send_exit(&self, code: i32) -> bool {
        self.tx
            .send(Message::Text(
                json!({ "t": "exit", "id": self.id, "code": code })
                    .to_string()
                    .into(),
            ))
            .is_ok()
    }
}

#[cfg(test)]
mod tls_material_tests {
    use super::load_tls_material;

    /// A throwaway self-signed cert + its key, in the PEM shape an operator's
    /// `--cert`/`--key` pair arrives in. Nothing here validates a chain — these
    /// tests are about the parsing, not the trust decision.
    fn cert_and_key() -> (String, String) {
        let leaf = rcgen::generate_simple_self_signed(vec!["spacron.test".to_string()])
            .expect("generate test cert");
        (leaf.cert.pem(), leaf.key_pair.serialize_pem())
    }

    #[test]
    fn a_valid_pem_pair_loads() {
        let dir = tempfile::tempdir().unwrap();
        let (cert_pem, key_pem) = cert_and_key();
        let cert = dir.path().join("cert.pem");
        let key = dir.path().join("key.pem");
        std::fs::write(&cert, cert_pem).unwrap();
        std::fs::write(&key, key_pem).unwrap();

        let (certs, _key) = load_tls_material(&cert, &key).expect("valid pair should load");
        assert_eq!(certs.len(), 1);
    }

    #[test]
    fn a_missing_cert_file_reports_the_path_not_a_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let (_, key_pem) = cert_and_key();
        let key = dir.path().join("key.pem");
        std::fs::write(&key, key_pem).unwrap();

        let err = load_tls_material(&dir.path().join("absent.pem"), &key)
            .expect_err("a missing cert must fail")
            .to_string();
        assert!(
            !err.contains("is not valid PEM"),
            "an unreadable file must not be reported as malformed PEM: {err}"
        );
    }

    #[test]
    fn a_malformed_cert_is_reported_as_bad_pem() {
        let dir = tempfile::tempdir().unwrap();
        let (_, key_pem) = cert_and_key();
        let cert = dir.path().join("cert.pem");
        let key = dir.path().join("key.pem");
        std::fs::write(&cert, "-----BEGIN CERTIFICATE-----\nnot base64\n").unwrap();
        std::fs::write(&key, key_pem).unwrap();

        let err = load_tls_material(&cert, &key)
            .expect_err("garbage PEM must fail")
            .to_string();
        assert!(err.contains("--cert"), "error should name the flag: {err}");
    }

    /// A well-formed PEM file that simply holds no key keeps its own message,
    /// rather than folding into the generic "not valid PEM" branch — this is the
    /// case the pre-`rustls-pki-types` code reported through an `Option`.
    #[test]
    fn a_key_file_with_no_key_section_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let (cert_pem, _) = cert_and_key();
        let cert = dir.path().join("cert.pem");
        let key = dir.path().join("key.pem");
        std::fs::write(&cert, &cert_pem).unwrap();
        // The cert PEM parses cleanly but contains no private key.
        std::fs::write(&key, &cert_pem).unwrap();

        let err = load_tls_material(&cert, &key)
            .expect_err("a keyless key file must fail")
            .to_string();
        assert!(
            err.contains("contains no private key"),
            "expected the no-key message, got: {err}"
        );
    }
}

#[cfg(test)]
mod folder_tests {
    use super::*;

    fn state(workspace: PathBuf) -> ServerState {
        ServerState { pty: PtyManager::new(), rate: WriteRateLimiter::new(), workspace, token: "t".into(), lsp_tokens: DashMap::new() }
    }

    /// One test, because the active folder is process-wide state.
    #[test]
    fn folders_are_listed_opened_and_confined_to_the_box_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = crate::commands::clean_path_buf(std::fs::canonicalize(tmp.path()).unwrap());
        std::fs::create_dir_all(ws.join("app/.git")).unwrap();
        std::fs::create_dir_all(ws.join("api/src")).unwrap();
        std::fs::create_dir_all(ws.join(".hidden")).unwrap();
        std::fs::create_dir_all(ws.join("node_modules")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let s = state(ws.clone());

        // Listing: sorted, hidden and node_modules skipped, repos marked, no parent at the top.
        let top = list_folders(&json!({}), &s).unwrap();
        let names: Vec<&str> = top["folders"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["api", "app"]);
        assert_eq!(top["folders"][1]["isRepo"], true);
        assert!(top["parent"].is_null());
        let inner = list_folders(&json!({ "path": ws.join("api").to_string_lossy() }), &s).unwrap();
        assert_eq!(inner["folders"][0]["name"], "src");
        assert!(inner["parent"].is_string());

        // Nothing outside the box folder, by path or by `..`.
        assert!(list_folders(&json!({ "path": outside.path().to_string_lossy() }), &s).is_err());
        assert!(set_project_root(&json!({ "path": ws.join("..").to_string_lossy() }), &s).is_err());
        assert!(set_project_root(&json!({ "path": ws.join("missing").to_string_lossy() }), &s).is_err());

        // Opening a folder makes it the root git, worktrees and search use.
        assert_eq!(active_root(&s), ws);
        let opened = set_project_root(&json!({ "path": ws.join("app").to_string_lossy() }), &s).unwrap();
        assert_eq!(opened["name"], "app");
        assert_eq!(active_root(&s), ws.join("app"));
        // A folder that disappears falls back to the box folder.
        std::fs::remove_dir_all(ws.join("app")).unwrap();
        assert_eq!(active_root(&s), ws);
    }
}
