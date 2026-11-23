//! Chat-view agents on the box.
//!
//! The desktop's chat view talks to an agent CLI over JSON-RPC on its stdio
//! (`crate::acp`). On a remote workspace that process has to run here, next to
//! the code, so the same `acp_*` calls arrive over the WebSocket and the
//! agent's events go back as `{ t: "event", name, payload }` frames.
//!
//! Events go to every desktop currently connected, not to the socket that
//! started the agent: a dropped link that reconnects keeps receiving the turn
//! that was in flight, which is the point of running it on the box.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::ws::Message;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::acp::{AcpManager, AcpStartArgs};

fn manager() -> &'static Arc<AcpManager> {
    static MANAGER: OnceLock<Arc<AcpManager>> = OnceLock::new();
    MANAGER.get_or_init(|| Arc::new(AcpManager::new()))
}

fn clients() -> &'static Mutex<Vec<UnboundedSender<Message>>> {
    static CLIENTS: OnceLock<Mutex<Vec<UnboundedSender<Message>>>> = OnceLock::new();
    CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Register a connected desktop to receive agent events.
pub(super) fn attach_client(out: UnboundedSender<Message>) {
    if let Ok(mut list) = clients().lock() {
        list.retain(|c| !c.is_closed());
        list.push(out);
    }
}

fn broadcast(name: &str, payload: Value) {
    let frame = json!({ "t": "event", "name": name, "payload": payload }).to_string();
    if let Ok(mut list) = clients().lock() {
        list.retain(|c| c.send(Message::Text(frame.clone().into())).is_ok());
    }
}

/// The `acp_*` commands this bridge answers, or `None` for anything else.
/// `acp_request` waits on the agent, so it answers through `reply` later.
pub(super) fn handle(
    cmd: &str,
    args: &Value,
    workspace: &Path,
    reply: impl FnOnce(Result<Value, String>) + Send + 'static,
) -> Option<()> {
    let id = || args.get("id").and_then(|v| v.as_u64()).map(|n| n as u32).ok_or_else(|| "Missing ACP session id".to_string());
    match cmd {
        "acp_start" => reply(start(args, workspace)),
        "acp_request" => {
            let (session, request_id, method, params) = match (
                id(),
                args.get("requestId").and_then(|v| v.as_str()),
                args.get("method").and_then(|v| v.as_str()),
            ) {
                (Ok(s), Some(r), Some(m)) => (s, r.to_string(), m.to_string(), args.get("params").cloned().unwrap_or(Value::Null)),
                _ => {
                    reply(Err("acp_request needs id, requestId and method".into()));
                    return Some(());
                }
            };
            tokio::spawn(async move {
                let manager = Arc::clone(manager());
                let started = tokio::task::spawn_blocking(move || manager.start_request(session, request_id, method, params)).await;
                let result = match started {
                    Ok(Ok(request)) => request.wait().await,
                    Ok(Err(e)) => Err(e),
                    Err(e) => Err(e.to_string()),
                };
                reply(result);
            });
        }
        "acp_respond" => reply(id().and_then(|id| manager().respond(
            id,
            args.get("requestId").cloned().unwrap_or(Value::Null),
            args.get("result").cloned().unwrap_or(Value::Null),
            args.get("error").cloned().filter(|e| !e.is_null()),
        )).map(|_| Value::Null)),
        "acp_notify" => reply(id().and_then(|id| manager().notify(
            id,
            args.get("method").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            args.get("params").cloned().unwrap_or(Value::Null),
        )).map(|_| Value::Null)),
        "acp_write_raw" => reply(id().and_then(|id| manager().write_raw(
            id,
            args.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        )).map(|_| Value::Null)),
        "acp_close" => reply(id().and_then(|id| manager().close(id)).map(|_| Value::Null)),
        _ => return None,
    }
    Some(())
}

fn start(args: &Value, workspace: &Path) -> Result<Value, String> {
    let mut start: AcpStartArgs = serde_json::from_value(args.get("args").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("Invalid acp_start arguments: {e}"))?;
    // The desktop sends agents by bare name (it can't know the box's OS); on
    // a Windows box that name is usually an npm `.cmd` shim only a PATHEXT
    // lookup finds. A pre-quoted cmd.exe line (`raw_args`) is left as sent.
    if start.raw_args.is_none() {
        start.command = super::automations::resolve_agent_program(&start.command);
    }
    // The agent works on this box's workspace and nothing outside it.
    let cwd = PathBuf::from(&start.cwd);
    crate::commands::file_system::require_in_roots(&cwd, &[workspace.to_path_buf()])?;
    let result = manager().start_with(start, Arc::new(|name: &str, payload: Value| broadcast(name, payload)))?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_working_directory_outside_the_workspace() {
        let ws = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let args = json!({ "args": { "command": "claude", "args": [], "cwd": other.path().to_string_lossy(), "env": {} } });
        assert!(start(&args, ws.path()).is_err());
    }

    /// The server canonicalizes its workspace at startup; do the same here.
    fn root(dir: &tempfile::TempDir) -> PathBuf {
        crate::commands::clean_path_buf(std::fs::canonicalize(dir.path()).unwrap())
    }

    #[tokio::test]
    async fn an_agents_output_reaches_connected_desktops_as_events() {
        let dir = tempfile::tempdir().unwrap();
        let ws = root(&dir);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
        attach_client(tx);
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}"#;
        // Printed from a file: `cmd echo` would mangle the quotes.
        std::fs::write(ws.join("line.json"), format!("{line}
")).unwrap();
        let (command, cmd_args) = if cfg!(windows) {
            ("cmd", vec!["/c".to_string(), "type".to_string(), "line.json".to_string()])
        } else {
            ("cat", vec!["line.json".to_string()])
        };
        let args = json!({ "args": { "command": command, "args": cmd_args, "cwd": ws.to_string_lossy(), "env": {} } });
        let id = start(&args, &ws).unwrap()["id"].as_u64().unwrap();
        let mut names = Vec::new();
        while let Ok(Some(Message::Text(text))) = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
            let frame: Value = serde_json::from_str(text.as_str()).unwrap();
            names.push(frame["name"].as_str().unwrap_or_default().to_string());
            if names.iter().any(|n| n.ends_with("/exit")) { break; }
        }
        assert!(names.contains(&format!("acp://{id}/notification")), "{names:?}");
        assert!(names.contains(&format!("acp://{id}/exit")), "{names:?}");
    }
}
