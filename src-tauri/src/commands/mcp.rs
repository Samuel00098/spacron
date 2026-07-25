//! Tauri commands that bridge the frontend agent-store with the MCP server's
//! name↔session-id registry.
//!
//! The frontend calls these when an agent session is created or destroyed so
//! that MCP tools like `send_to_agent` can resolve human-readable names
//! ("Iris", "Trinity") to PTY session IDs.

use crate::mcp::McpServerHandle;
use tauri::State;

/// Register a running agent with the MCP server so other agents can discover
/// and message it by name.
#[tauri::command]
pub async fn mcp_register_agent(
    handle: State<'_, McpServerHandle>,
    session_id: u32,
    name: String,
    preset: String,
    label: String,
) -> Result<(), String> {
    handle
        .register_agent(session_id, &name, &preset, &label)
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