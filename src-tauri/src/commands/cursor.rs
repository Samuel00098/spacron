//! Cursor native SDK adapter for Spacron Chat.
//!
//! Spawns the user's `cursor-agent` CLI and speaks Cursor's native protocol
//! over stdio. Cursor's own auth (`~/.cursor`) is used — Spacron never sees
//! or stores API keys.
//!
//! Each turn is one ephemeral `cursor-agent` process. The frontend assembles
//! the full conversation context into `user_text` and passes it here.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct CursorTurnResult {
    pub text: String,
    pub session_id: Option<String>,
}

fn build_args(
    model: Option<&str>,
    permission_mode: &str,
    session_id: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
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
    if let Some(id) = session_id {
        if !id.is_empty() {
            args.push("--resume".to_string());
            args.push(id.to_string());
        }
    }
    args
}

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

fn validate_cwd(cwd: &str) -> Result<String, String> {
    let path = std::path::Path::new(cwd);
    if !path.is_absolute() {
        return Err("provider_error: Cursor cwd must be absolute".to_string());
    }
    if !path.is_dir() {
        return Err("provider_error: Cursor cwd does not exist".to_string());
    }
    Ok(cwd.to_string())
}

fn permission_mode_for(access_mode: Option<&str>) -> &'static str {
    match access_mode {
        Some("full-access") => "bypassPermissions",
        Some("auto") => "auto",
        Some("auto-edits") => "acceptEdits",
        Some("supervised") => "manual",
        _ => "default",
    }
}

async fn run_turn(
    cwd: &str,
    model: Option<&str>,
    system_prompt: &str,
    user_text: &str,
    images: &[PathBuf],
    effort: Option<&str>,
    access_mode: Option<&str>,
    session_id: Option<&str>,
) -> Result<CursorTurnResult, String> {
    let _cwd = validate_cwd(cwd)?;
    let permission_mode = permission_mode_for(access_mode);

    let mut prompt = user_text.to_string();
    for image in images {
        prompt.push_str(&format!("\n\n[Image: {}]", image.display()));
    }

    let args = build_args(model, permission_mode, session_id);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // applied below
    }

    let mut command = Command::new("cursor-agent");
    command.args(args).current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("provider_error: could not start Cursor: {e}"))?;

    let stdout = child.stdout.take().ok_or("provider_error: Cursor stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("provider_error: Cursor stderr unavailable")?;

    let mut lines = BufReader::new(stdout).lines();
    let mut final_text = String::new();
    let mut session_id_out: Option<String> = None;
    let mut stderr_lines = Vec::new();

    while let Some(line) = lines.next_line().await.map_err(|e| format!("provider_error: {e}"))? {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if value.get("type").and_then(|t| t.as_str()) == Some("system")
                && value.get("subtype").and_then(|s| s.as_str()) == Some("init")
            {
                if let Some(id) = value.get("session_id").and_then(|s| s.as_str()) {
                    session_id_out = Some(id.to_string());
                }
            }
            if value.get("type").and_then(|t| t.as_str()) == Some("result") {
                if let Some(id) = value.get("session_id").and_then(|s| s.as_str()) {
                    session_id_out = Some(id.to_string());
                }
            }
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

    let mut stderr_reader = BufReader::new(stderr);
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
        return Err(format!("{}: the Cursor CLI exited unexpectedly{detail}", classify(&tail)));
    }

    Ok(CursorTurnResult {
        text: final_text,
        session_id: session_id_out,
    })
}

#[tauri::command]
pub async fn cursor_chat_complete(
    cwd: String,
    model: Option<String>,
    system_prompt: String,
    user_text: String,
    images: Vec<String>,
    effort: Option<String>,
    access_mode: Option<String>,
    session_id: Option<String>,
) -> Result<CursorTurnResult, String> {
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
    )
    .await
}
