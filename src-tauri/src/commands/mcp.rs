//! Tauri commands that bridge the frontend agent-store with the MCP server's
//! name↔session-id registry.
//!
//! The frontend calls these when an agent session is created or destroyed so
//! that MCP tools like `send_to_agent` can resolve human-readable names
//! ("Iris", "Trinity") to PTY session IDs.

use crate::mcp::{AgentPreset, McpServer};
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

/// Write the Claude Code `--mcp-config` file and return its absolute path.
///
/// This file used to be written into every project as
/// `<project>/.spacron/mcp/claude.json`. It has no project-specific content —
/// just the server URL and the browser-tools toggle, both app-global — so a copy
/// per repo bought nothing and put the server's **auth token** in the user's
/// working tree, where an agent following the "commit as you go" brief could
/// publish it. `.git/info/exclude` covered that, but only for git checkouts and
/// only if the exclude write succeeded.
///
/// It now lives once, under the app config dir. The caller contributes no part
/// of the path, so this cannot be steered elsewhere.
#[tauri::command]
pub fn mcp_write_launch_config(
    content: String,
    state: State<crate::state::AppState>,
) -> Result<String, String> {
    if content.len() > 1024 * 1024 {
        return Err("Refusing to write an implausibly large MCP config".to_string());
    }
    let path = state.config_dir.join("mcp").join("claude.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, content)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(super::clean_path_buf(path).to_string_lossy().to_string())
}

/// Register a running agent with the MCP server so other agents can discover
/// and message it by name.
#[tauri::command]
pub async fn mcp_register_agent(
    handle: State<'_, McpServer>,
    session_id: u32,
    name: String,
    preset: String,
    label: String,
    branch: Option<String>,
) -> Result<(), String> {
    handle
        .get()?
        .register_agent(session_id, &name, &preset, &label, branch)
        .await;
    Ok(())
}

/// Unregister an agent by session id (called when the agent's terminal exits).
#[tauri::command]
pub async fn mcp_unregister_agent(
    handle: State<'_, McpServer>,
    session_id: u32,
) -> Result<(), String> {
    handle.get()?.unregister_agent(session_id).await;
    Ok(())
}

/// Get the port the MCP server is listening on, so the frontend can write
/// MCP config files for launched agents.
#[tauri::command]
pub fn mcp_server_port(handle: State<'_, McpServer>) -> Result<u16, String> {
    Ok(handle.get()?.port)
}

// ── Per-agent identity ───────────────────────────────────────────────────────
//
// Three commands mirroring `agent-hook-signals.ts`'s prepare → attach →
// discard, for the same reason: the credential has to exist before the PTY
// does, because it goes into the launch command.

/// Mint a per-launch MCP token and return the SSE URL carrying it.
///
/// Returned as a whole URL, like [`mcp_server_url`], so a caller cannot
/// assemble it wrongly — and returned *with* the bare token so the caller can
/// bind it once the session exists.
#[tauri::command]
pub fn mcp_open_agent_channel(handle: State<'_, McpServer>) -> Result<AgentChannel, String> {
    let handle = handle.get()?;
    let token = handle.mint_agent_token();
    Ok(AgentChannel {
        url: format!("http://127.0.0.1:{}/sse?token={}", handle.port, token),
        http_url: format!("http://127.0.0.1:{}/mcp?token={}", handle.port, token),
        token,
    })
}

/// A per-launch MCP credential, in the two transport flavours agents use.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChannel {
    /// SSE URL (Claude Code).
    pub url: String,
    /// Streamable HTTP URL (Codex and friends).
    pub http_url: String,
    /// The bare token, to hand back to [`mcp_bind_agent_channel`].
    pub token: String,
}

/// Bind a minted token to the PTY session that was launched with it.
///
/// Returns `false` for a token this server did not mint, which is the guard
/// that stops an arbitrary string being claimed as an agent's identity.
#[tauri::command]
pub fn mcp_bind_agent_channel(
    handle: State<'_, McpServer>,
    token: String,
    session_id: u32,
) -> Result<bool, String> {
    Ok(handle.get()?.bind_agent_token(&token, session_id))
}

/// Drop a token whose launch never happened.
#[tauri::command]
pub fn mcp_close_agent_channel(
    handle: State<'_, McpServer>,
    token: String,
) -> Result<(), String> {
    handle.get()?.close_agent_token(&token);
    Ok(())
}

/// The full authenticated SSE URL to write into an agent's MCP config.
///
/// Returned whole rather than as port + token so callers can't assemble it
/// wrongly and silently produce a config that fails to authenticate.
#[tauri::command]
pub fn mcp_server_url(handle: State<'_, McpServer>) -> Result<String, String> {
    let handle = handle.get()?;
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
pub fn mcp_server_http_url(handle: State<'_, McpServer>) -> Result<String, String> {
    let handle = handle.get()?;
    Ok(format!(
        "http://127.0.0.1:{}/mcp?token={}",
        handle.port, handle.token
    ))
}

/// Report the outcome of a prompt delivery back to the waiting MCP tool call.
///
/// `send_to_agent` and `bounce_task` hand the message to the frontend rather than
/// writing it to the PTY, because getting text into an agent's TUI means pasting,
/// waiting for the composer to settle, and pressing Enter with confirmation —
/// none of which Rust can observe. They block until this comes back, so a
/// delivery that silently failed is reported as a failure instead of a success.
#[tauri::command]
pub fn mcp_deliver_respond(
    handle: State<'_, McpServer>,
    request_id: String,
    success: bool,
    error: Option<String>,
) -> Result<(), String> {
    let result = if success {
        Ok(serde_json::Value::Bool(true))
    } else {
        Err(error.unwrap_or_else(|| "The agent did not accept the message.".to_string()))
    };
    handle.get()?.resolve_send_request(&request_id, result);
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
    handle: State<'_, McpServer>,
    root: Option<String>,
) -> Result<(), String> {
    *handle.get()?.project_root.lock().await = root.filter(|r| !r.trim().is_empty());
    Ok(())
}

/// Tell the MCP server which agents this install can launch.
///
/// The roster is the frontend's: built-in presets minus the ones the user
/// removed, plus every custom agent they added. The server needs it so
/// `spawn_agent` and `delegate_task` can advertise the real set in their tool
/// schemas and resolve a display name to a launch command — otherwise a
/// delegating agent is guessing from a list baked in at compile time, and the
/// user's own agents are invisible to it.
///
/// Pushed on startup and again whenever the roster changes; the notify ping
/// makes connected clients re-read `tools/list`.
#[tauri::command]
pub async fn mcp_set_agent_presets(
    handle: State<'_, McpServer>,
    presets: Vec<AgentPreset>,
) -> Result<(), String> {
    let cleaned: Vec<AgentPreset> = presets
        .into_iter()
        .filter(|p| !p.command.trim().is_empty())
        .map(|p| AgentPreset {
            command: p.command.trim().to_string(),
            name: p.name.trim().to_string(),
        })
        .collect();
    let handle = handle.get()?;
    *handle.agent_presets.lock().await = cleaned;
    handle.notify_tools_changed();
    Ok(())
}

/// Tell the MCP server which assistant names this app uses ("Trinity", "Iris", …).
///
/// The list lives in `src/lib/services/orchestrator/agent-names.ts` and is pushed
/// here rather than duplicated in Rust, so the pane badge of an agent the user
/// spawned and the pane badge of one an orchestrator delegated to are drawn from
/// one list. The server needs it because `delegate_task` decides a worker's name
/// before the spawn reaches the frontend — the name is the caller's handle and
/// the worker's report filename, so it cannot be assigned afterwards.
///
/// An empty list leaves the server on its uuid fallback, which is what the
/// startup window before the first push looks like.
#[tauri::command]
pub async fn mcp_set_assistant_names(
    handle: State<'_, McpServer>,
    names: Vec<String>,
) -> Result<(), String> {
    let cleaned: Vec<String> = names
        .into_iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    *handle.get()?.assistant_names.lock().await = cleaned;
    Ok(())
}

/// Run one emulator tool on behalf of the in-app orchestrator.
///
/// The orchestrator is not an MCP client — it lives in the frontend, on the
/// other side of the HTTP server from the CLI agents. This is the seam that
/// gives it the same device control they have, routed to the same handlers so
/// the two cannot drift apart. The name is checked against the allowlist here
/// rather than trusted from the caller, because `name` reaches this command
/// straight from a model's tool call.
#[tauri::command]
pub async fn mcp_call_emulator_tool(
    name: String,
    args: serde_json::Value,
) -> Result<String, String> {
    if !crate::mcp::ORCHESTRATOR_EMULATOR_TOOLS.contains(&name.as_str()) {
        return Err(format!(
            "'{name}' is not an emulator tool. Available: {}.",
            crate::mcp::ORCHESTRATOR_EMULATOR_TOOLS.join(", ")
        ));
    }
    crate::mcp::call_emulator_tool(&name, args).await
}

/// Whether computer use can run on this platform at all (Windows only for now).
/// The Settings row uses it to explain itself instead of offering a switch that
/// would do nothing.
#[tauri::command]
pub fn mcp_computer_use_supported() -> bool {
    crate::desktop::supported()
}

/// The user's `Allow computer use` switch.
///
/// Off by default and pushed on startup. Turning it off withdraws every grant
/// and declines any open permission dialog; either way connected agents are
/// told to re-read `tools/list`, so the tools appear or vanish without a restart.
#[tauri::command]
pub fn mcp_set_computer_use(handle: State<'_, McpServer>, enabled: bool) -> Result<(), String> {
    let handle = handle.get()?;
    handle.desktop.set_enabled(enabled);
    handle.notify_tools_changed();
    Ok(())
}

/// The user's answer to a computer-use permission dialog. The agent's tool call
/// is blocked on this (see `desktop::DesktopState::ensure`).
#[tauri::command]
pub fn mcp_desktop_grant_respond(
    handle: State<'_, McpServer>,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    handle.get()?.desktop.respond(&request_id, allow);
    Ok(())
}
