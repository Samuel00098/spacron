//! Tauri commands that bridge the frontend agent-store with the MCP server's
//! name↔session-id registry.
//!
//! The frontend calls these when an agent session is created or destroyed so
//! that MCP tools like `send_to_agent` can resolve human-readable names
//! ("Iris", "Trinity") to PTY session IDs.

use crate::mcp::McpServerHandle;
use std::path::PathBuf;
use tauri::State;

/// Absolute path of an agent CLI's *global* MCP config.
///
/// Codex and droid have no project-scoped MCP config — these files are the only
/// place they look — so the frontend cannot write them through `fs_write_file`,
/// which refuses any path outside an open project. That guard is right for
/// editor writes and wrong here, so these two paths get their own commands.
///
/// The allowlist is the whole security story: the caller picks an agent by name
/// and contributes no part of the path, so this cannot be steered into writing
/// somewhere else. Resolving `~` in Rust also avoids a trap on the JS side —
/// Tauri v2's `homeDir()` returns no trailing separator, so the obvious
/// `${home}.codex/...` silently produces `C:\Users\samue.codex\...`.
fn global_agent_config_path(agent: &str) -> Result<PathBuf, String> {
    let relative = match agent {
        "codex" => ".codex/config.toml",
        "droid" => ".factory/mcp.json",
        other => return Err(format!("No global MCP config path is known for '{other}'")),
    };
    dirs::home_dir()
        .map(|home| home.join(relative))
        .ok_or_else(|| "Could not resolve the user's home directory".to_string())
}

/// Read an agent's global MCP config, or `""` when it doesn't exist yet.
///
/// Returning empty rather than erroring keeps the caller's merge logic to one
/// path: parse-or-start-fresh, whether or not the user has the CLI installed.
#[tauri::command]
pub fn mcp_read_global_agent_config(agent: String) -> Result<String, String> {
    let path = global_agent_config_path(&agent)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Write an agent's global MCP config, creating the parent directory if needed.
#[tauri::command]
pub fn mcp_write_global_agent_config(agent: String, content: String) -> Result<(), String> {
    if content.len() > 1024 * 1024 {
        return Err("Refusing to write an implausibly large MCP config".to_string());
    }
    let path = global_agent_config_path(&agent)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// Register a running agent with the MCP server so other agents can discover
/// and message it by name.
#[tauri::command]
pub async fn mcp_register_agent(
    handle: State<'_, McpServerHandle>,
    session_id: u32,
    name: String,
    preset: String,
    label: String,
    branch: Option<String>,
) -> Result<(), String> {
    handle
        .register_agent(session_id, &name, &preset, &label, branch)
        .await;
    Ok(())
}

/// Unregister an agent by session id (called when the agent's terminal exits).
#[tauri::command]
pub async fn mcp_unregister_agent(
    handle: State<'_, McpServerHandle>,
    session_id: u32,
) -> Result<(), String> {
    handle.unregister_agent(session_id).await;
    Ok(())
}

/// Get the port the MCP server is listening on, so the frontend can write
/// MCP config files for launched agents.
#[tauri::command]
pub fn mcp_server_port(handle: State<'_, McpServerHandle>) -> Result<u16, String> {
    Ok(handle.port)
}

/// The full authenticated SSE URL to write into an agent's MCP config.
///
/// Returned whole rather than as port + token so callers can't assemble it
/// wrongly and silently produce a config that fails to authenticate.
#[tauri::command]
pub fn mcp_server_url(handle: State<'_, McpServerHandle>) -> Result<String, String> {
    Ok(format!(
        "http://127.0.0.1:{}/sse?token={}",
        handle.port, handle.token
    ))
}

/// The full authenticated **Streamable HTTP** URL.
///
/// Not interchangeable with [`mcp_server_url`]: Codex CLI supports only this
/// transport, and several others (Gemini CLI, droid, opencode, Cursor) prefer
/// it. Handing one of them the `/sse` URL under an `http` transport type, or
/// vice versa, produces a connection failure that surfaces as an auth prompt.
#[tauri::command]
pub fn mcp_server_http_url(handle: State<'_, McpServerHandle>) -> Result<String, String> {
    Ok(format!(
        "http://127.0.0.1:{}/mcp?token={}",
        handle.port, handle.token
    ))
}

/// Resolve a pending browser-tool request with a result from the frontend.
/// Called by the MCP browser bridge after executing a browser tool.
#[tauri::command]
pub fn mcp_browser_respond(
    handle: State<'_, McpServerHandle>,
    request_id: String,
    success: bool,
    data: serde_json::Value,
) -> Result<(), String> {
    let result = if success {
        Ok(data)
    } else {
        Err(data
            .as_str()
            .unwrap_or("Unknown browser tool error")
            .to_string())
    };
    handle.resolve_browser_request(&request_id, result);
    Ok(())
}

/// Tell the MCP server which project is open.
///
/// `delegate_task` waits on a file under the project's `.spacron/reports/`, and
/// the server has no other way to learn where the project lives — the frontend
/// owns that. Called on project open and on switch; passing `None` (no project)
/// makes `delegate_task` refuse rather than guess.
#[tauri::command]
pub async fn mcp_set_project_root(
    handle: State<'_, McpServerHandle>,
    root: Option<String>,
) -> Result<(), String> {
    *handle.project_root.lock().await = root.filter(|r| !r.trim().is_empty());
    Ok(())
}
