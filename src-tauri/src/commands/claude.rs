//! Claude Code native adapter for Spacron Chat.
//!
//! Spawns the user's `claude` CLI with `--output-format stream-json` and
//! parses the structured stream back into chat messages. Unlike the
//! `@anthropic-ai/claude-agent-sdk` npm package (which is Node-only and cannot
//! run inside the Tauri webview), this adapter lives on the Rust side and
//! works in production. Claude's own auth (`~/.claude`, OAuth) is used —
//! Spacron never sees or stores API keys.
//!
//! Each turn is one ephemeral `claude -p` process. The frontend sends the full
//! conversation context in the prompt, so session resume is achieved by
//! replaying transcript rather than relying on a `--resume` CLI flag that may
//! not exist. When the `claude` CLI reports a session id (via the SDK-style
//! `init` system message), it is captured and stored on the thread so follow-up
//! turns can attempt `--resume` on later Claude versions.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Result of one Claude turn: the assistant's text and any session id the CLI
/// reported (captured from the `init` system message or result message).
#[derive(Debug, Serialize, Deserialize)]
pub struct ClaudeTurnResult {
    pub text: String,
    pub session_id: Option<String>,
}

/// Build the `claude` CLI argument vector for one turn.
fn build_args(
    model: Option<&str>,
    permission_mode: &str,
    session_id: Option<&str>,
    fork_session: bool,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--permission-mode".to_string(),
        permission_mode.to_string(),
    ];
    if let Some(model) = model {
        if !model.is_empty() && model != "default" {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    // Attempt session resume; the `claude` CLI may or may not honour this flag.
    // If it does not, the process errors and the caller falls back to replaying
    // the transcript in the prompt (already done by the frontend).
    if let Some(id) = session_id {
        if !id.is_empty() {
            args.push("--resume".to_string());
            args.push(id.to_string());
        }
    }
    if fork_session {
        args.push("--fork-session".to_string());
    }
    args
}

/// Classify a Claude error message into the error kinds the orchestrator
/// already understands (`agent-transport.ts` reads the prefix).
fn classify(message: &str) -> &'static str {
    let m = message.to_lowercase();
    if m.contains("usage limit") || m.contains("usagelimit") || m.contains("quota") || m.contains("rate limit reached") || m.contains("credits") {
        "quota"
    } else if m.contains("rate limit") || m.contains("too many requests") {
        "rate_limit"
    } else if m.contains("unauthorized") || m.contains("not logged in") || m.contains("log in") || m.contains("login") || m.contains("401") || m.contains("expired") {
        "authentication"
    } else if m.contains("context") && (m.contains("window") || m.contains("length") || m.contains("exceed")) {
        "context_limit"
    } else if m.contains("model") && (m.contains("not found") || m.contains("not supported") || m.contains("unavailable")) {
        "model_unavailable"
    } else {
        "provider_error"
    }
}

/// Validate that the cwd is absolute and exists.
fn validate_cwd(cwd: &str) -> Result<String, String> {
    let path = std::path::Path::new(cwd);
    if !path.is_absolute() {
        return Err("provider_error: Claude cwd must be absolute".to_string());
    }
    if !path.is_dir() {
        return Err("provider_error: Claude cwd does not exist".to_string());
    }
    Ok(cwd.to_string())
}

/// Run one Claude turn and return the result.
async fn run_turn(
    cwd: &str,
    model: Option<&str>,
    _system_prompt: &str,
    user_text: &str,
    images: &[PathBuf],
    _effort: Option<&str>,
    access_mode: Option<&str>,
    session_id: Option<&str>,
    fork_session: bool,
) -> Result<ClaudeTurnResult, String> {
    let _cwd = validate_cwd(cwd)?;

    // Permission mode: map Spacron access tier to Claude's native mode.
    let permission_mode = match access_mode {
        Some("full-access") => "bypassPermissions",
        Some("auto") => "auto",
        Some("auto-edits") => "acceptEdits",
        Some("supervised") => "manual",
        _ => "default",
    };

    // Build the full prompt: system instructions + user message.
    // Images are referenced by path; Claude reads them from the filesystem.
    let mut prompt = user_text.to_string();
    for image in images {
        prompt.push_str(&format!("\n\n[Image: {}]", image.display()));
    }

    let args = build_args(model, permission_mode, session_id, fork_session);

    let mut command = Command::new("claude");
    command.args(args).current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("provider_error: could not start Claude CLI: {e}"))?;

    let stdout = child.stdout.take().ok_or("provider_error: Claude stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("provider_error: Claude stderr unavailable")?;

    let mut lines = BufReader::new(stdout).lines();
    let mut final_text = String::new();
    let mut session_id_out: Option<String> = None;
    let mut stderr_lines = Vec::new();

    // Read stdout lines in a blocking loop within this async function.
    // tokio::task::spawn_blocking is not needed because BufReader::lines()
    // on a ChildStdout works with async_next_line via AsyncBufReadExt.
    while let Some(line) = lines.next_line().await.map_err(|e| format!("provider_error: {e}"))? {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            // SDK-style init message carries the session id.
            if value.get("type").and_then(|t| t.as_str()) == Some("system")
                && value.get("subtype").and_then(|s| s.as_str()) == Some("init")
            {
                if let Some(id) = value.get("session_id").and_then(|s| s.as_str()) {
                    session_id_out = Some(id.to_string());
                }
            }
            // Result message may also carry session_id and final usage.
            if value.get("type").and_then(|t| t.as_str()) == Some("result") {
                if let Some(id) = value.get("session_id").and_then(|s| s.as_str()) {
                    session_id_out = Some(id.to_string());
                }
            }
            // Extract assistant text from message blocks.
            if let Some(message) = value.get("message") {
                if let Some(content) = message.get("content") {
                    if let Some(array) = content.as_array() {
                        for block in array {
                            if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                                if block_type == "text" {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        final_text.push_str(text);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Drain stderr for error classification on failure.
    let mut stderr_reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = stderr_reader.next_line().await {
        if !line.trim().is_empty() {
            stderr_lines.push(line);
        }
    }

    let status = child.wait().await.map_err(|e| format!("provider_error: {e}"))?;
    if !status.success() {
        let tail = stderr_lines.join(" ").trim().to_string();
        let detail = if tail.is_empty() {
            String::new()
        } else {
            format!(": {}", tail.lines().rev().take(3).collect::<Vec<_>>().join(" "))
        };
        return Err(format!("{}: the Claude CLI exited unexpectedly{detail}", classify(&tail)));
    }

    Ok(ClaudeTurnResult {
        text: final_text,
        session_id: session_id_out,
    })
}

/// Native Chat entry point for a selected Claude agent.
///
/// The frontend assembles the full conversation context into `user_text` and
/// passes it here. Each call spawns one `claude -p` process, streams the
/// response, and returns the final text plus any session id the CLI reported.
#[tauri::command]
pub async fn claude_chat_complete(
    cwd: String,
    model: Option<String>,
    system_prompt: String,
    user_text: String,
    images: Vec<String>,
    effort: Option<String>,
    access_mode: Option<String>,
    session_id: Option<String>,
    fork_session: Option<bool>,
) -> Result<ClaudeTurnResult, String> {
    let image_paths = images.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    run_turn(
        &cwd,
        model.as_deref(),
        &system_prompt,
        &user_text,
        &image_paths,
        effort.as_deref(),
        access_mode.as_deref(),
        session_id.as_deref(),
        fork_session.unwrap_or(false),
    )
    .await
}

/// Fork an existing Claude session into a new native session.
///
/// Spawns `claude --resume <session_id> --fork-session` with a minimal prompt
/// so the CLI creates a forked session and reports its new session id via the
/// `init` system message. The returned session id can be stored on a thread so
/// subsequent turns resume the forked conversation.
#[tauri::command]
pub async fn claude_fork_session(
    cwd: String,
    session_id: String,
) -> Result<ClaudeTurnResult, String> {
    run_turn(
        &cwd,
        None,
        "",
        "fork",
        &[],
        None,
        None,
        Some(&session_id),
        true,
    )
    .await
}
