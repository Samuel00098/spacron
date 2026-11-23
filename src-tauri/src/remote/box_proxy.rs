//! The box's own sign-in proxy, so signed-in MCP connectors (Gmail, Drive,
//! Notion, …) keep working on the box while the laptop is closed.
//!
//! On the desktop, agents reach a signed-in connector through Spacron's proxy
//! (`mcp::proxy_handler`), which adds a fresh access token to each request. A
//! box only has that while the desktop is connected (through the reverse
//! tunnel). When the user chooses to share a sign-in with a box, the desktop
//! sends the grant here (`box_mcp_grants_sync`, kept owner-only under
//! `<workspace>/.spacron/mcp-oauth/`) and this proxy serves it with the same
//! code, refreshing tokens on the box.
//!
//! It listens on `127.0.0.1` only, on its own port, and every request must
//! carry this server run's random secret (`?token=`). The box's public port
//! and its shell token are not involved.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use axum::{
    extract::Query,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

/// URL scheme bots on a box use for a shared sign-in; the runner swaps it
/// for this proxy's current address at run time (its port changes per run).
pub(crate) const PLACEHOLDER: &str = "spacron-box-proxy://";
/// The box's own MCP server (`box_mcp.rs`), resolved the same way.
pub(crate) const MCP_PLACEHOLDER: &str = "spacron-box-mcp://";

struct Info {
    port: u16,
    secret: String,
}

fn info() -> &'static OnceLock<Info> {
    static INFO: OnceLock<Info> = OnceLock::new();
    &INFO
}

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: Option<String>,
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn handler(
    axum::extract::Path(key): axum::extract::Path<String>,
    Query(query): Query<TokenQuery>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(info) = info().get() else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    if !query.token.as_deref().is_some_and(|t| same(t, &info.secret)) {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }
    crate::mcp::proxy_signed_in(&key, &method, &headers, &body).await
}

/// `/mcp`: the box's own MCP server (`box_mcp.rs`), behind the same secret.
async fn mcp_handler(Query(query): Query<TokenQuery>, body: axum::body::Bytes) -> Response {
    let Some(info) = info().get() else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    if !query.token.as_deref().is_some_and(|t| same(t, &info.secret)) {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(message) => super::box_mcp::handle(message).await,
        Err(e) => (StatusCode::BAD_REQUEST, format!("Invalid JSON-RPC: {e}")).into_response(),
    }
}

/// Start the proxy and point the grant store at the box's folder. Called once
/// by `serve`.
pub(crate) async fn start(workspace: &Path) -> Result<(), String> {
    crate::commands::mcp_oauth::use_store_dir(workspace.join(".spacron").join("mcp-oauth"));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let secret = uuid::Uuid::new_v4().simple().to_string();
    let _ = info().set(Info { port, secret });
    let app = Router::new()
        .route("/proxy/{key}", axum::routing::any(handler))
        .route("/mcp", axum::routing::post(mcp_handler).get(super::box_mcp::no_stream));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(())
}

/// This proxy's URL for one connector, when it is running.
pub(crate) fn url_for(key: &str) -> Option<String> {
    info().get().map(|i| format!("http://127.0.0.1:{}/proxy/{key}?token={}", i.port, i.secret))
}

/// The box's own MCP server address, when the proxy is running.
pub(crate) fn mcp_url() -> Option<String> {
    info().get().map(|i| format!("http://127.0.0.1:{}/mcp?token={}", i.port, i.secret))
}

/// Swap every `spacron-box-proxy://<key>` in an MCP config for this proxy's
/// real address. Left alone when the proxy is not running (this PC).
pub(crate) fn resolve(config: &str) -> String {
    let config = match (config.contains(MCP_PLACEHOLDER), mcp_url()) {
        (true, Some(url)) => config.replace(MCP_PLACEHOLDER, &url),
        _ => config.to_string(),
    };
    let config = config.as_str();
    if !config.contains(PLACEHOLDER) {
        return config.to_string();
    }
    let mut out = String::with_capacity(config.len());
    let mut rest = config;
    while let Some(at) = rest.find(PLACEHOLDER) {
        out.push_str(&rest[..at]);
        let after = &rest[at + PLACEHOLDER.len()..];
        let end = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(after.len());
        let key = &after[..end];
        match url_for(key) {
            Some(url) => out.push_str(&url),
            None => { out.push_str(PLACEHOLDER); out.push_str(key); }
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// `box_mcp_grants_sync`: keep exactly the sign-ins the desktop shares.
pub(crate) fn grants_sync(args: Value) -> Result<Value, String> {
    let grants: HashMap<String, crate::commands::mcp_oauth::Grant> = serde_json::from_value(args.get("grants").cloned().unwrap_or(json!({})))
        .map_err(|e| format!("Invalid sign-ins: {e}"))?;
    let count = crate::commands::mcp_oauth::replace_grants(&grants)?;
    Ok(json!({ "ok": true, "count": count }))
}

/// `box_mcp_info`: where agents on this box reach shared sign-ins, and which.
pub(crate) fn mcp_info(workspace: &Path) -> Result<Value, String> {
    let dir = workspace.join(".spacron").join("mcp-oauth");
    let mut shared: Vec<String> = std::fs::read_dir(&dir).into_iter().flatten().flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json").map(str::to_string))
        .collect();
    shared.sort();
    Ok(match info().get() {
        Some(i) => json!({ "proxyBase": format!("http://127.0.0.1:{}/proxy", i.port), "token": i.secret, "shared": shared, "mcpUrl": mcp_url() }),
        None => json!({ "proxyBase": null, "token": null, "shared": shared, "mcpUrl": null }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_are_left_alone_without_a_running_proxy() {
        // `start` is not called in unit tests, so nothing is substituted.
        let cfg = r#"{"mcpServers":{"spacron-gmail":{"type":"http","url":"spacron-box-proxy://spacron-gmail"}}}"#;
        if info().get().is_none() {
            assert_eq!(resolve(cfg), cfg);
        }
        assert_eq!(resolve("no placeholders"), "no placeholders");
    }

    #[test]
    fn constant_time_compare() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }
}
