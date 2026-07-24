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

    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!(
        "spacron-server listening on ws://{addr}/pty  (workspace: {})",
        state.workspace.display()
    );
    // The transport is plaintext ws:// — the token authenticates but does not
    // encrypt. Run behind Tailscale/VPN, which encrypts the link. TLS (wss://) is
    // a later hardening step; see docs/remote-workspace.md.
    eprintln!(
        "WARNING: plaintext transport (ws://). Bound to 0.0.0.0:{} — only expose this over \
         Tailscale/VPN, never a public network.",
        cfg.port
    );
    axum::serve(listener, app).await?;
    Ok(())
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
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }

    // Echo the non-secret subprotocol so the handshake completes; never reflect
    // the token protocol back.
    ws.protocols([WS_SUBPROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state))
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
        ClientMsg::Invoke { req_id, cmd, args } => {
            // A couple of commands need server state (LSP), so they're handled here;
            // everything else is a stateless file-system op routed to the fs core.
            let result = match cmd.as_str() {
                "lsp_check_server" => lsp_check_server(args),
                "lsp_start" => lsp_start(args, state),
                "workspace_info" => workspace_info(state),
                "workspace_git_log" => git_log(args, &state.workspace),
                "workspace_git_status" => git_status(&state.workspace),
                "workspace_git_diff" => git_diff(args, &state.workspace),
                "workspace_git_create_worktree" => git_create_worktree(args, &state.workspace),
                "workspace_git_remove_worktree" => git_remove_worktree(args, &state.workspace),
                "workspace_git_worktree_status" => git_worktree_status(args, &state.workspace),
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
    let stdout = git_run(workspace, &["status", "--porcelain"])?;

    let mut modified: Vec<String> = Vec::new();
    let mut added: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut conflicted: Vec<String> = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 { continue; }
        let status_code = &line[0..2];
        let file_path = line[3..].trim().to_string();
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
        .ok_or_else(|| "Could not resolve HEAD — the repository has no commits yet.".to_string())?;

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

    // Optionally delete the branch.
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
