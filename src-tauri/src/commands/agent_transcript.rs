//! Read an agent CLI's own transcript so a terminal pane can show it as chat.
//!
//! This is the Orca model (see `.spacron/memory/orca-chat-view.md`): the real
//! TUI keeps running in the PTY and stays the only owner of the conversation.
//! The chat view never starts a second process. It reads what the CLI already
//! writes to disk and types new prompts back into the same PTY.
//!
//! A pane does not tell us its provider session id, so we find it by working
//! directory and launch time. Every lookup is read-only and bounded.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[path = "agent_transcript_extra.rs"]
mod extra;

const MAX_ITEMS: usize = 400;
const MAX_TEXT_CHARS: usize = 60_000;
const MAX_TOOL_CHARS: usize = 4_000;
/// A session counts as the pane's if it was written to after the agent started,
/// give or take this much clock and file-system slack.
const SINCE_SLACK_MS: i64 = 5_000;
/// How many Codex day folders to look back through.
const CODEX_DAY_SCAN: i64 = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptQuery {
    pub agent: String,
    pub cwd: String,
    /// Epoch ms the agent was started in this pane.
    pub since_ms: i64,
    /// Session already bound to this pane; kept while it still exists.
    pub session_id: Option<String>,
    /// Sessions other panes already show; never picked for this one.
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Revision the caller already rendered; when equal no messages are sent.
    pub known_revision: Option<String>,
    /// Managed account whose home holds the session (Agent History); None is the CLI's own home.
    #[serde(default)]
    pub account: Option<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub id: String,
    /// `user` | `assistant` | `reasoning` | `tool` | `notice`
    pub kind: String,
    pub text: String,
    pub tool_name: Option<String>,
    pub tool_input: Option<String>,
    pub tool_output: Option<String>,
    /// `running` | `done` | `error`
    pub tool_status: Option<String>,
    /// ISO-8601 or epoch-ms string, as the CLI wrote it.
    pub time: Option<String>,
    /// Images attached to a user turn, as `data:` URLs (the CLIs store them inline).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// A tool call's input as the CLI wrote it, kept only for tools the chat
    /// draws richly: file edits and patches (diffs), to-do lists, subagents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_data: Option<Value>,
    /// The subagent a tool call started (Claude Code's Task/Agent), whose own
    /// transcript `agent_subagent_transcript_read` returns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    pub session_id: Option<String>,
    pub revision: Option<String>,
    pub unchanged: bool,
    pub messages: Vec<ChatItem>,
    /// Whether the transcript itself says a turn is still running, when it can tell.
    pub busy: Option<bool>,
    pub truncated: bool,
    /// Model the latest turn ran on, as the CLI names it.
    pub model: Option<String>,
    /// Reasoning effort the latest turn ran at, when the transcript records it.
    pub effort: Option<String>,
    /// Tokens the conversation occupies in the model's context window now.
    pub context_used: Option<u64>,
    /// Size of that window, when the CLI records it (Codex does; others are inferred client-side).
    pub context_window: Option<u64>,
    /// Permission mode the session last reported: `ask` | `accept-edits` | `auto` | `full-access` | `plan`.
    pub permission: Option<String>,
}

#[tauri::command]
pub async fn agent_transcript_read(query: TranscriptQuery) -> Result<TranscriptResult, String> {
    tauri::async_runtime::spawn_blocking(move || read_transcript(&query))
        .await
        .map_err(|e| e.to_string())?
}

/// Largest image file the chat composer previews.
const MAX_PREVIEW_BYTES: u64 = 15 * 1024 * 1024;

/// A `data:` URL preview of an image the user attached in the chat composer
/// (the app's asset protocol is scoped to wallpapers, so a file path cannot be
/// shown directly). Images only, size-capped; anything else is refused.
#[tauri::command]
pub async fn chat_image_preview(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let p = PathBuf::from(&path);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            _ => return Err("Not an image".to_string()),
        };
        let size = fs::metadata(&p).map_err(|e| e.to_string())?.len();
        if size > MAX_PREVIEW_BYTES {
            return Err("Image too large to preview".to_string());
        }
        let bytes = fs::read(&p).map_err(|e| e.to_string())?;
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentQuery {
    pub cwd: String,
    /// The parent conversation (the pane's bound provider session).
    pub session_id: String,
    pub agent_id: String,
}

/// A Claude Code subagent's own transcript, which it writes beside the parent
/// conversation at `<project>/<session>/subagents/agent-<id>.jsonl`.
#[tauri::command]
pub async fn agent_subagent_transcript_read(query: SubagentQuery) -> Result<TranscriptResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !safe(&query.session_id) || !safe(&query.agent_id) {
            return Err("Invalid subagent id".to_string());
        }
        let Some(dir) = claude_project_dir(&query.cwd, None) else {
            return Ok(TranscriptResult::default());
        };
        let path = dir.join(&query.session_id).join("subagents").join(format!("agent-{}.jsonl", query.agent_id));
        if !path.is_file() {
            return Ok(TranscriptResult::default());
        }
        let revision = file_times(&path).map(|(_, modified, len)| format!("{len}:{modified}"));
        Ok(finish(Some(query.agent_id.clone()), revision, parse_claude_lines(&path, true)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The managed account home a query names, when it names one that exists.
fn account_base(q: &TranscriptQuery) -> Option<PathBuf> {
    q.account.as_deref().and_then(|account| super::agent_history::account_home(&q.agent, account))
}

/// History uses the same workspace metadata as the terminal reader.
pub(super) fn antigravity_history_files(base: Option<PathBuf>) -> Vec<(String, String, PathBuf)> {
    extra::antigravity_homes(base).into_iter().flat_map(|base| {
        extra::antigravity_workspaces(&base).into_iter().map(move |(id, cwd)| {
            let path = base.join("brain").join(&id).join(".system_generated/logs/transcript.jsonl");
            (id, cwd, path)
        })
    }).collect()
}

fn read_transcript(q: &TranscriptQuery) -> Result<TranscriptResult, String> {
    if q.account.as_deref().is_some_and(|a| a != "default") && account_base(q).is_none() {
        return Err("The session's account home is unavailable; restore that account before resuming".into());
    }
    let mut result = match q.agent.as_str() {
        "claude" => read_file_agent(q, claude_candidates(&q.cwd, account_base(q)), parse_claude),
        "codex" => read_file_agent(q, codex_candidates(&q.cwd, q.since_ms, account_base(q)), parse_codex),
        "grok" => read_file_agent(q, grok_candidates(&q.cwd, account_base(q)), parse_grok),
        "opencode" => read_opencode(q),
        "openclaude" => read_file_agent(q, extra::openclaude_candidates(&q.cwd), parse_claude),
        "pi" => read_file_agent(q, extra::pi_candidates(extra::pi_sessions_dir(), &q.cwd), extra::parse_pi),
        "omp" => read_file_agent(q, extra::pi_candidates(extra::omp_sessions_dir(), &q.cwd), extra::parse_pi),
        "antigravity" => read_file_agent(q, extra::antigravity_candidates(&q.cwd, account_base(q)), extra::parse_antigravity),
        "copilot" => read_file_agent(q, extra::copilot_candidates(&q.cwd, q.since_ms), extra::parse_copilot),
        "cursor" => read_file_agent(q, extra::cursor_candidates(&q.cwd), extra::parse_cursor),
        other => Err(format!("Chat view does not support {other}")),
    }?;
    // Before the first turn there is no transcript to say what the session runs
    // on, so the composer would read "Default model". The CLI's own configured
    // default is what it will use, so report that instead.
    if !result.unchanged && result.model.is_none() {
        let (model, effort) = configured_defaults(&q.agent);
        result.model = model;
        if result.effort.is_none() {
            result.effort = effort;
        }
    }
    Ok(result)
}

/// The model (and effort) a CLI starts with when none is passed: Claude Code's
/// `settings.json` `model`, Codex's `config.toml` `model` / `model_reasoning_effort`.
fn configured_defaults(agent: &str) -> (Option<String>, Option<String>) {
    match agent {
        "claude" => {
            let base = env_dir("CLAUDE_CONFIG_DIR").or_else(|| home().map(|h| h.join(".claude")));
            let model = base
                .and_then(|b| fs::read_to_string(b.join("settings.json")).ok())
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|v| str_of(&v, "model"));
            (model, None)
        }
        "codex" => {
            let base = env_dir("CODEX_HOME").or_else(|| home().map(|h| h.join(".codex")));
            let Some(text) = base.and_then(|b| fs::read_to_string(b.join("config.toml")).ok()) else {
                return (None, None);
            };
            (toml_top_level_string(&text, "model"), toml_top_level_string(&text, "model_reasoning_effort"))
        }
        _ => (None, None),
    }
}

/// A top-level `key = "value"` from a TOML file, ignoring anything under a table header.
fn toml_top_level_string(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() == key {
            let v = v.split('#').next().unwrap_or("").trim().trim_matches('"').trim_matches('\'');
            return Some(v.to_string()).filter(|s| !s.is_empty());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Session selection (file-backed agents)
// ---------------------------------------------------------------------------

struct Candidate {
    id: String,
    path: PathBuf,
    created_ms: i64,
    modified_ms: i64,
    len: u64,
}

fn file_times(path: &Path) -> Option<(i64, i64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let ms = |t: std::time::SystemTime| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64);
    let modified = meta.modified().ok().and_then(ms)?;
    let created = meta.created().ok().and_then(ms).unwrap_or(modified);
    Some((created, modified, meta.len()))
}

fn candidate(id: String, path: PathBuf) -> Option<Candidate> {
    let (created_ms, modified_ms, len) = file_times(&path)?;
    Some(Candidate { id, path, created_ms, modified_ms, len })
}

/// The bound session while it still exists; otherwise the newest-created session
/// written to since the agent started that no other pane already shows.
fn pick(q: &TranscriptQuery, candidates: Vec<Candidate>) -> Option<Candidate> {
    if let Some(bound) = q.session_id.as_deref() {
        if let Some(index) = candidates.iter().position(|c| c.id == bound) {
            return candidates.into_iter().nth(index);
        }
        return None;
    }
    let since = q.since_ms - SINCE_SLACK_MS;
    candidates
        .into_iter()
        .filter(|c| c.modified_ms >= since && !q.exclude.iter().any(|e| e == &c.id))
        .max_by_key(|c| (c.created_ms, c.modified_ms))
}

fn read_file_agent(
    q: &TranscriptQuery,
    candidates: Vec<Candidate>,
    parse: fn(&Path) -> Parsed,
) -> Result<TranscriptResult, String> {
    let Some(found) = pick(q, candidates) else {
        return Ok(TranscriptResult::default());
    };
    let revision = format!("{}:{}", found.len, found.modified_ms);
    if q.known_revision.as_deref() == Some(revision.as_str()) && q.session_id.as_deref() == Some(found.id.as_str()) {
        return Ok(TranscriptResult {
            session_id: Some(found.id),
            revision: Some(revision),
            unchanged: true,
            ..Default::default()
        });
    }
    let parsed = parse(&found.path);
    Ok(finish(Some(found.id), Some(revision), parsed))
}

fn finish(session_id: Option<String>, revision: Option<String>, parsed: Parsed) -> TranscriptResult {
    let mut items = parsed.items;
    let truncated = items.len() > MAX_ITEMS;
    if truncated {
        items.drain(..items.len() - MAX_ITEMS);
    }
    TranscriptResult {
        session_id,
        revision,
        unchanged: false,
        messages: items,
        busy: parsed.busy,
        truncated,
        model: parsed.model,
        effort: parsed.effort,
        context_used: parsed.context_used,
        context_window: parsed.context_window,
        permission: parsed.permission,
    }
}

#[derive(Default)]
struct Parsed {
    items: Vec<ChatItem>,
    busy: Option<bool>,
    model: Option<String>,
    effort: Option<String>,
    context_used: Option<u64>,
    context_window: Option<u64>,
    permission: Option<String>,
    /// The last slash command was a settings change the chat applies itself;
    /// its "Set model to …" reply is hidden too.
    hide_next_output: bool,
}

impl Parsed {
    fn push_text(&mut self, kind: &str, id: String, text: String, time: Option<String>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.items.push(ChatItem { id, kind: kind.into(), text: clip(&text, MAX_TEXT_CHARS), time, ..Default::default() });
    }

    /// A user turn: its words and any images, shown even when it has only images.
    fn push_user(&mut self, id: String, text: String, images: Vec<String>, time: Option<String>) {
        let text = text.trim().to_string();
        if text.is_empty() && images.is_empty() {
            return;
        }
        self.items.push(ChatItem {
            id,
            kind: "user".into(),
            text: clip(&text, MAX_TEXT_CHARS),
            time,
            images,
            ..Default::default()
        });
    }

    fn push_tool_with(&mut self, id: String, name: String, input: String, data: Option<Value>, time: Option<String>) {
        self.items.push(ChatItem {
            id,
            kind: "tool".into(),
            tool_name: Some(name),
            tool_input: Some(clip(&input, MAX_TOOL_CHARS)),
            tool_status: Some("running".into()),
            time,
            tool_data: data,
            ..Default::default()
        });
    }

    /// Attach a result to the call it answers, searching from the newest.
    fn finish_tool(&mut self, call_id: &str, output: String, error: bool) {
        if let Some(item) = self.items.iter_mut().rev().find(|i| i.kind == "tool" && i.id == call_id) {
            item.tool_output = Some(clip(output.trim(), MAX_TOOL_CHARS));
            item.tool_status = Some(if error { "error" } else { "done" }.into());
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("\n…");
    out
}

fn read_lines(path: &Path) -> Vec<Value> {
    let Ok(file) = fs::File::open(path) else { return Vec::new() };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect()
}

fn u64_at(v: &Value, pointer: &str) -> u64 {
    v.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Largest inline image passed to the chat; bigger ones show as "[image]".
const MAX_IMAGE_URL_CHARS: usize = 12_000_000;

/// A `data:` URL for an image block (`{type: base64, media_type, data}`) or a URL source.
fn image_source_url(source: &Value) -> Option<String> {
    let url = match source.get("type").and_then(Value::as_str) {
        Some("base64") => {
            let media = source.get("media_type").and_then(Value::as_str).unwrap_or("image/png");
            let data = source.get("data").and_then(Value::as_str)?;
            format!("data:{media};base64,{data}")
        }
        Some("url") => str_of(source, "url")?,
        _ => return None,
    };
    (url.len() <= MAX_IMAGE_URL_CHARS).then_some(url)
}

/// A one-line-ish summary of a tool's input: the field people care about
/// (command, path, pattern) when there is one, otherwise compact JSON.
fn tool_input_summary(input: &Value) -> String {
    if let Some(s) = input.as_str() {
        // Some CLIs pass JSON as a string.
        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
            if parsed.is_object() {
                return tool_input_summary(&parsed);
            }
        }
        return s.to_string();
    }
    // Antigravity names its arguments in CamelCase (CommandLine, AbsolutePath…).
    for key in [
        "command", "cmd", "CommandLine", "file_path", "filePath", "path", "target_file", "TargetFile", "AbsolutePath",
        "target_directory", "DirectoryPath", "SearchPath", "pattern", "Pattern", "query", "Query", "url", "Url",
        "description", "prompt", "toolSummary",
    ] {
        if let Some(value) = input.get(key) {
            match value {
                Value::String(s) if !s.is_empty() => return s.clone(),
                Value::Array(parts) if !parts.is_empty() => {
                    return parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ");
                }
                _ => {}
            }
        }
    }
    serde_json::to_string(input).unwrap_or_default()
}

/// Longest single string kept in a tool's structured input (an edit's old or new text).
const MAX_TOOL_DATA_STRING: usize = 24_000;

/// Input keys that mark a tool the chat draws richly.
const STRUCTURED_KEYS: &[&str] = &[
    "old_string", "new_string", "oldString", "newString", "edits", "todos", "plan", "patch", "subagent_type", "subagentType",
];

/// A tool call's input, kept when the chat can draw it: file edits, whole-file
/// writes, patches, to-do lists and subagents. Everything else stays summary-only.
fn tool_structured(name: &str, input: &Value) -> Option<Value> {
    let lower = name.to_ascii_lowercase();
    let object = match input {
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(v) if v.is_object() => v,
            _ => {
                // Codex's apply_patch is a freeform tool: its input is the patch text.
                if s.trim_start().starts_with("*** Begin Patch") || lower == "apply_patch" {
                    return Some(serde_json::json!({ "patch": clip(s, MAX_TOOL_DATA_STRING * 2) }));
                }
                return None;
            }
        },
        other => other.clone(),
    };
    let map = object.as_object()?;
    // Older Codex: the shell tool running `apply_patch <patch>`.
    if let Some(Value::Array(cmd)) = map.get("command") {
        if cmd.first().and_then(Value::as_str) == Some("apply_patch") {
            if let Some(patch) = cmd.get(1).and_then(Value::as_str) {
                return Some(serde_json::json!({ "patch": clip(patch, MAX_TOOL_DATA_STRING * 2) }));
            }
        }
    }
    let has_path = ["file_path", "filePath", "path", "target_file"].iter().any(|k| map.contains_key(*k));
    let whole_write = has_path && map.contains_key("content") && (lower.contains("write") || lower.contains("create"));
    let antigravity_file = map.get("Path").and_then(Value::as_str).is_some()
        && ((lower == "edit_file" && map.contains_key("Replacement"))
            || (lower == "write_file" && map.contains_key("Content")));
    let subagent = (lower == "task" || lower == "agent") && map.contains_key("prompt");
    if !whole_write && !antigravity_file && !subagent && !STRUCTURED_KEYS.iter().any(|k| map.contains_key(*k)) {
        return None;
    }
    Some(clip_strings(&object, MAX_TOOL_DATA_STRING))
}

fn clip_strings(v: &Value, max: usize) -> Value {
    match v {
        Value::String(s) => Value::String(clip(s, max)),
        Value::Array(items) => Value::Array(items.iter().take(200).map(|i| clip_strings(i, max)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, val)| (k.clone(), clip_strings(val, max))).collect()),
        other => other.clone(),
    }
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str).or_else(|| p.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn same_dir(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.trim().replace('\\', "/");
        let s = s.trim_end_matches('/').to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(b)
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Claude Code: <config>/projects/<cwd with every non-alphanumeric as '-'>/<id>.jsonl
// ---------------------------------------------------------------------------

fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Claude Code's folder for conversations started in `cwd`.
fn claude_project_dir(cwd: &str, base: Option<PathBuf>) -> Option<PathBuf> {
    let base = base.or_else(|| env_dir("CLAUDE_CONFIG_DIR")).or_else(|| home().map(|h| h.join(".claude")))?;
    let projects = base.join("projects");
    let wanted = claude_project_dir_name(cwd.trim_end_matches(['\\', '/']));
    let dir = projects.join(&wanted);
    if dir.is_dir() {
        return Some(dir);
    }
    // Drive-letter and folder case can differ between our cwd and Claude's.
    fs::read_dir(&projects).ok().and_then(|entries| {
        entries
            .filter_map(Result::ok)
            .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&wanted))
            .map(|e| e.path())
    })
}

fn claude_candidates(cwd: &str, base: Option<PathBuf>) -> Vec<Candidate> {
    let Some(dir) = claude_project_dir(cwd, base) else { return Vec::new() };
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_string_lossy().to_string();
            candidate(id, p)
        })
        .collect()
}

/// Claude Code's `permissionMode` in the chat view's vocabulary.
fn claude_permission(mode: &str) -> Option<String> {
    let mapped = match mode {
        "default" | "manual" => "ask",
        "acceptEdits" => "accept-edits",
        "auto" | "dontAsk" => "auto",
        "bypassPermissions" => "full-access",
        "plan" => "plan",
        _ => return None,
    };
    Some(mapped.to_string())
}

/// Codex's thread settings in the chat view's vocabulary.
fn codex_permission(settings: &Value) -> Option<String> {
    let approval = settings.get("approval_policy").and_then(Value::as_str)?;
    let reviewer = settings.get("approvals_reviewer").and_then(Value::as_str).unwrap_or("user");
    let profile = settings.pointer("/permission_profile/type").and_then(Value::as_str).unwrap_or("");
    let mode = if approval == "never" && (profile == "disabled" || profile.is_empty()) {
        "full-access"
    } else if reviewer == "auto_review" {
        "auto"
    } else {
        "ask"
    };
    Some(mode.to_string())
}

/// Slash commands that only change session settings; never shown as messages.
const SETTINGS_COMMANDS: &[&str] = &["/model", "/effort", "/fast", "/permissions", "/approvals"];

/// What a Claude Code user turn is, beyond plain words.
#[derive(Debug, PartialEq)]
enum ClaudeUserEntry {
    /// Nothing to show (injected context, hook output, a settings command).
    Skip,
    /// The user's own words.
    Text(String),
    /// A slash command the user ran: `/name args`.
    Command(String),
    /// A settings command (`/model`, `/effort`…) the chat applies quietly.
    SettingsCommand,
    /// What a local command printed (`<local-command-stdout>`).
    Output(String),
}

fn claude_user_entry(raw: &str) -> ClaudeUserEntry {
    let trimmed = raw.trim();
    if let Some(out) = tag_body(trimmed, "local-command-stdout").or_else(|| tag_body(trimmed, "local-command-stderr")) {
        return ClaudeUserEntry::Output(strip_ansi(&out).trim().to_string());
    }
    if trimmed.starts_with("<command-name>") || trimmed.starts_with("<command-message>") {
        let name = tag_body(trimmed, "command-name").unwrap_or_default();
        if SETTINGS_COMMANDS.contains(&name.trim()) {
            return ClaudeUserEntry::SettingsCommand;
        }
        let args = tag_body(trimmed, "command-args").unwrap_or_default();
        let line = format!("{} {}", name.trim(), args.trim()).trim().to_string();
        return if line.is_empty() { ClaudeUserEntry::Skip } else { ClaudeUserEntry::Command(line) };
    }
    match claude_user_text(raw) {
        Some(text) => ClaudeUserEntry::Text(text),
        None => ClaudeUserEntry::Skip,
    }
}

/// Terminal colour and cursor sequences out of a command's printed output.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() || n == '~' {
                        break;
                    }
                }
            } else {
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out
}

impl Parsed {
    /// Apply a classified Claude user turn; true when it was a command or its output.
    fn push_claude_entry(&mut self, entry: &ClaudeUserEntry, id: &str, time: &Option<String>) -> bool {
        match entry {
            ClaudeUserEntry::Command(line) => {
                self.hide_next_output = false;
                self.items.push(ChatItem { id: id.to_string(), kind: "command".into(), text: clip(line, MAX_TEXT_CHARS), time: time.clone(), ..Default::default() });
                self.busy = Some(true);
                true
            }
            ClaudeUserEntry::SettingsCommand => {
                self.hide_next_output = true;
                true
            }
            ClaudeUserEntry::Output(text) => {
                // A local command's reply ends it; nothing more runs for it.
                self.busy = Some(false);
                if !std::mem::take(&mut self.hide_next_output) && !text.is_empty() {
                    self.items.push(ChatItem { id: format!("{id}:out"), kind: "command-output".into(), text: clip(text, MAX_TOOL_CHARS * 2), time: time.clone(), ..Default::default() });
                }
                true
            }
            _ => false,
        }
    }
}

/// Wrappers Claude Code writes into user turns that are not the user's words.
fn claude_user_text(raw: &str) -> Option<String> {
    let text = strip_tag_blocks(raw, "system-reminder");
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("<local-command-stdout>")
        || trimmed.starts_with("<local-command-stderr>")
        || trimmed.starts_with("<local-command-caveat>")
        || trimmed.starts_with("Caveat:")
        || trimmed.starts_with("[Request interrupted")
        // Harness-injected turns: background task results and hook output.
        || trimmed.starts_with("<task-notification>")
        || trimmed.starts_with("<user-prompt-submit-hook>")
        || trimmed.starts_with("<bash-stdout>")
        || trimmed.starts_with("<bash-stderr>")
    {
        return None;
    }
    if let Some(command) = tag_body(trimmed, "bash-input") {
        return Some(format!("! {}", command.trim()));
    }
    if trimmed.starts_with("<command-name>") || trimmed.starts_with("<command-message>") {
        let name = tag_body(trimmed, "command-name").unwrap_or_default();
        // Session settings the chat view applies itself (its model, effort and
        // permission pickers type these). Like Orca, the change happens quietly
        // instead of as a turn in the conversation.
        if SETTINGS_COMMANDS.contains(&name.trim()) {
            return None;
        }
        let args = tag_body(trimmed, "command-args").unwrap_or_default();
        let line = format!("{} {}", name.trim(), args.trim());
        return Some(line.trim().to_string()).filter(|s| !s.is_empty());
    }
    Some(trimmed.to_string())
}

fn tag_body(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].to_string())
}

fn strip_tag_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        match rest[start..].find(&close) {
            Some(end) => rest = &rest[start + end + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn parse_claude(path: &Path) -> Parsed {
    parse_claude_lines(path, false)
}

/// `subagent`: the file is a subagent's own transcript, where every line is a
/// sidechain; in the main transcript those lines are skipped.
fn parse_claude_lines(path: &Path, subagent: bool) -> Parsed {
    let mut parsed = Parsed::default();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if (!subagent && line.get("isSidechain").and_then(Value::as_bool) == Some(true))
            || line.get("isMeta").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let time = str_of(&line, "timestamp");
        let uuid = str_of(&line, "uuid").unwrap_or_else(|| format!("line-{index}"));
        if let Some(mode) = line.get("permissionMode").and_then(Value::as_str) {
            parsed.permission = claude_permission(mode);
        }
        let Some(message) = line.get("message") else { continue };
        if kind == "user" {
            // The chat's own /model and /effort leave no message, but they are
            // the latest word on what the session runs on.
            let raw = value_text(message.get("content").unwrap_or(&Value::Null));
            if let Some(name) = tag_body(&raw, "command-name") {
                let args = tag_body(&raw, "command-args").unwrap_or_default();
                let args = args.trim();
                if !args.is_empty() {
                    match name.trim() {
                        "/model" => parsed.model = Some(args.to_string()),
                        "/effort" => parsed.effort = Some(args.to_string()),
                        _ => {}
                    }
                }
            }
        }
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        if kind == "user" {
            if line.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
                parsed.push_text("notice", uuid, "Conversation compacted".into(), time);
                continue;
            }
            match &content {
                Value::String(s) => {
                    let entry = claude_user_entry(s);
                    if parsed.push_claude_entry(&entry, &uuid, &time) {
                        continue;
                    }
                    if let ClaudeUserEntry::Text(text) = entry {
                        parsed.push_text("user", uuid, text, time);
                        parsed.busy = Some(true);
                    } else if s.contains("[Request interrupted") {
                        parsed.busy = Some(false);
                    }
                }
                Value::Array(blocks) => {
                    let mut words = Vec::new();
                    let mut images = 0;
                    let mut interrupted = false;
                    let mut tool_results = false;
                    let mut image_urls: Vec<String> = Vec::new();
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                let raw = block.get("text").and_then(Value::as_str).unwrap_or("");
                                interrupted |= raw.contains("[Request interrupted");
                                let entry = claude_user_entry(raw);
                                if parsed.push_claude_entry(&entry, &format!("{uuid}:{}", words.len()), &time) {
                                    continue;
                                }
                                if let ClaudeUserEntry::Text(text) = entry {
                                    words.push(text);
                                }
                            }
                            Some("image") => match block.get("source").and_then(image_source_url) {
                                Some(url) => image_urls.push(url),
                                None => images += 1,
                            },
                            Some("tool_result") => {
                                tool_results = true;
                                let id = str_of(block, "tool_use_id").unwrap_or_default();
                                let output = value_text(block.get("content").unwrap_or(&Value::Null));
                                let error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                                parsed.finish_tool(&id, output, error);
                                // A Task/Agent call names the subagent it started.
                                if let Some(agent) = line.pointer("/toolUseResult/agentId").and_then(Value::as_str) {
                                    if let Some(item) = parsed.items.iter_mut().rev().find(|i| i.kind == "tool" && i.id == id) {
                                        item.subagent_id = Some(agent.to_string());
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    if images > 0 {
                        words.push(if images == 1 { "[image]".into() } else { format!("[{images} images]") });
                    }
                    // A prompt or a tool result hands the turn to the model; an
                    // interrupt ends it. Settings commands change neither.
                    if interrupted {
                        parsed.busy = Some(false);
                    } else if tool_results || !words.is_empty() || !image_urls.is_empty() {
                        parsed.busy = Some(true);
                    }
                    parsed.push_user(uuid, words.join("\n"), image_urls, time);
                }
                _ => {}
            }
            continue;
        }
        // assistant: Claude Code writes `tool_use` on every line of a turn that
        // continues (thinking and tool calls) and `end_turn` on its final reply.
        parsed.busy = Some(!matches!(
            message.get("stop_reason").and_then(Value::as_str),
            Some("end_turn" | "stop_sequence" | "max_tokens" | "refusal")
        ));
        if let Some(model) = message.get("model").and_then(Value::as_str).filter(|m| !m.starts_with('<')) {
            parsed.model = Some(model.to_string());
        }
        if let Some(usage) = message.get("usage").filter(|u| u.is_object()) {
            let used = u64_at(usage, "/input_tokens")
                + u64_at(usage, "/cache_creation_input_tokens")
                + u64_at(usage, "/cache_read_input_tokens")
                + u64_at(usage, "/output_tokens");
            if used > 0 {
                parsed.context_used = Some(used);
            }
        }
        if let Value::Array(blocks) = &content {
            for (bi, block) in blocks.iter().enumerate() {
                let id = format!("{uuid}:{bi}");
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => parsed.push_text("assistant", id, str_of(block, "text").unwrap_or_default(), time.clone()),
                    Some("thinking") => parsed.push_text("reasoning", id, str_of(block, "thinking").unwrap_or_default(), time.clone()),
                    Some("tool_use") => {
                        let call = str_of(block, "id").unwrap_or(id);
                        let name = str_of(block, "name").unwrap_or_else(|| "tool".into());
                        let raw = block.get("input").unwrap_or(&Value::Null);
                        let input = tool_input_summary(raw);
                        let data = tool_structured(&name, raw);
                        parsed.push_tool_with(call, name, input, data, time.clone());
                    }
                    _ => {}
                }
            }
        } else if let Value::String(s) = &content {
            parsed.push_text("assistant", uuid, s.clone(), time);
        }
    }
    parsed
}

// ---------------------------------------------------------------------------
// Codex: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, first line session_meta
// ---------------------------------------------------------------------------

fn codex_candidates(cwd: &str, since_ms: i64, base: Option<PathBuf>) -> Vec<Candidate> {
    let Some(base) = base.or_else(|| env_dir("CODEX_HOME")).or_else(|| home().map(|h| h.join(".codex"))) else {
        return Vec::new();
    };
    let sessions = base.join("sessions");
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let now_ms = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let start_ms = since_ms.min(now_ms) - CODEX_DAY_SCAN * 86_400_000;
    let mut day = start_ms;
    while day <= now_ms + 86_400_000 {
        let (y, m, d) = civil_from_days(day.div_euclid(86_400_000));
        let dir = sessions.join(format!("{y:04}")).join(format!("{m:02}")).join(format!("{d:02}"));
        day += 86_400_000;
        if !seen.insert(dir.clone()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.extension().is_some_and(|x| x == "jsonl") {
                continue;
            }
            let Some((_, modified, _)) = file_times(&path) else { continue };
            if modified < since_ms - SINCE_SLACK_MS {
                continue;
            }
            let Some(meta) = codex_session_meta(&path) else { continue };
            if !meta.1.as_deref().is_some_and(|c| same_dir(c, cwd)) {
                continue;
            }
            if let Some(c) = candidate(meta.0, path) {
                out.push(c);
            }
        }
    }
    out
}

/// (session id, cwd) from a rollout's opening `session_meta` line.
fn codex_session_meta(path: &Path) -> Option<(String, Option<String>)> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(5).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            let p = v.get("payload")?;
            let id = str_of(p, "id").or_else(|| str_of(p, "session_id"))?;
            return Some((id, str_of(p, "cwd")));
        }
    }
    None
}

/// Days since 1970-01-01 to a civil (UTC) date. Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Context Codex injects as user input that the user never typed.
fn codex_injected(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("# AGENTS.md")
        || t.starts_with("<environment_context")
        || t.starts_with("<user_instructions")
        || t.starts_with("<permissions")
        || t.starts_with("<INSTRUCTIONS")
        || t.starts_with("<turn_aborted")
        || t.starts_with("<user_shell_command")
        || t.starts_with("</image>")
}

fn parse_codex(path: &Path) -> Parsed {
    let mut parsed = Parsed::default();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let time = str_of(&line, "timestamp");
        let Some(p) = line.get("payload") else { continue };
        let ptype = p.get("type").and_then(Value::as_str).unwrap_or("");
        match line.get("type").and_then(Value::as_str) {
            Some("event_msg") => match ptype {
                "task_started" => parsed.busy = Some(true),
                "task_complete" | "turn_aborted" => {
                    parsed.busy = Some(false);
                    // A turn that failed (usage limit, network) carries why; the
                    // TUI shows it, so the chat must too, or the prompt sits unanswered.
                    if let Some(msg) = p.pointer("/error/message").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) {
                        parsed.push_text("notice", format!("{index}:error"), msg.to_string(), time);
                    }
                }
                // Written whenever the session's settings change, including a
                // /model or /permissions pick made mid-session.
                "thread_settings_applied" => {
                    if let Some(settings) = p.get("thread_settings") {
                        if let Some(model) = str_of(settings, "model") {
                            parsed.model = Some(model);
                        }
                        if let Some(effort) = str_of(settings, "reasoning_effort") {
                            parsed.effort = Some(effort);
                        }
                        if let Some(mode) = codex_permission(settings) {
                            parsed.permission = Some(mode);
                        }
                    }
                }
                "token_count" => {
                    if let Some(info) = p.get("info").filter(|i| i.is_object()) {
                        let last = info.get("last_token_usage").cloned().unwrap_or(Value::Null);
                        let used = last.get("total_tokens").and_then(Value::as_u64).unwrap_or_else(|| {
                            u64_at(&last, "/input_tokens") + u64_at(&last, "/output_tokens")
                        });
                        if used > 0 {
                            parsed.context_used = Some(used);
                        }
                        if let Some(window) = info.get("model_context_window").and_then(Value::as_u64) {
                            parsed.context_window = Some(window);
                        }
                    }
                }
                _ => {}
            },
            Some("turn_context") => {
                if let Some(model) = str_of(p, "model") {
                    parsed.model = Some(model);
                }
                parsed.effort = str_of(p, "effort")
                    .or_else(|| str_of(p, "reasoning_effort"))
                    .or_else(|| p.pointer("/collaboration_mode/settings/reasoning_effort").and_then(Value::as_str).map(str::to_string));
            }
            Some("compacted") => parsed.push_text("notice", format!("c-{index}"), "Conversation compacted".into(), time),
            Some("response_item") => {
                let id = str_of(p, "id").unwrap_or_else(|| format!("r-{index}"));
                match ptype {
                    "message" => {
                        let role = p.get("role").and_then(Value::as_str).unwrap_or("");
                        let blocks = p.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
                        if role == "user" {
                            let mut words = Vec::new();
                            let mut image_urls: Vec<String> = Vec::new();
                            let mut unreadable = 0;
                            for b in &blocks {
                                match b.get("type").and_then(Value::as_str) {
                                    Some("input_text") => {
                                        let t = str_of(b, "text").unwrap_or_default();
                                        // `<image name=… path=…>` / `</image>` wrap each input_image.
                                        if !t.trim_start().starts_with("<image") && !codex_injected(&t) {
                                            words.push(t);
                                        }
                                    }
                                    Some("input_image") => match str_of(b, "image_url").filter(|u| u.len() <= MAX_IMAGE_URL_CHARS) {
                                        Some(url) => image_urls.push(url),
                                        None => unreadable += 1,
                                    },
                                    _ => {}
                                }
                            }
                            if unreadable > 0 {
                                words.push(if unreadable == 1 { "[image]".into() } else { format!("[{unreadable} images]") });
                            }
                            parsed.push_user(id, words.join("\n"), image_urls, time);
                        } else if role == "assistant" {
                            let text = blocks
                                .iter()
                                .filter_map(|b| b.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n");
                            parsed.push_text("assistant", id, text, time);
                        }
                    }
                    "reasoning" => {
                        let text = p
                            .get("summary")
                            .and_then(Value::as_array)
                            .map(|s| s.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
                            .unwrap_or_default();
                        parsed.push_text("reasoning", id, text, time);
                    }
                    "function_call" | "custom_tool_call" | "local_shell_call" => {
                        let call = str_of(p, "call_id").unwrap_or(id);
                        let name = str_of(p, "name").unwrap_or_else(|| "shell".into());
                        let raw = p.get("arguments").or_else(|| p.get("input")).or_else(|| p.get("action"));
                        let input = raw.map(tool_input_summary).unwrap_or_default();
                        let data = raw.and_then(|r| tool_structured(&name, r));
                        parsed.push_tool_with(call, name, input, data, time);
                    }
                    "function_call_output" | "custom_tool_call_output" => {
                        let call = str_of(p, "call_id").unwrap_or_default();
                        let raw = p.get("output").cloned().unwrap_or(Value::Null);
                        // function_call_output wraps `{output, metadata}` as a JSON string.
                        let output = match &raw {
                            Value::String(s) => serde_json::from_str::<Value>(s)
                                .ok()
                                .and_then(|v| v.get("output").map(value_text))
                                .unwrap_or_else(|| s.clone()),
                            other => value_text(other),
                        };
                        parsed.finish_tool(&call, output, false);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    parsed
}

// ---------------------------------------------------------------------------
// Grok CLI: <GROK_HOME>/sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl
// ---------------------------------------------------------------------------

fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "-_.~".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn grok_candidates(cwd: &str, base: Option<PathBuf>) -> Vec<Candidate> {
    let Some(base) = base.or_else(|| env_dir("GROK_HOME")).or_else(|| home().map(|h| h.join(".grok"))) else {
        return Vec::new();
    };
    let sessions = base.join("sessions");
    let wanted = encode_uri_component(cwd.trim_end_matches(['\\', '/']));
    let mut dir = sessions.join(&wanted);
    if !dir.is_dir() {
        let found = fs::read_dir(&sessions).ok().and_then(|entries| {
            entries
                .filter_map(Result::ok)
                .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&wanted))
                .map(|e| e.path())
        });
        match found {
            Some(path) => dir = path,
            None => return Vec::new(),
        }
    }
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().to_string();
            let history = e.path().join("chat_history.jsonl");
            if !history.is_file() {
                return None;
            }
            let mut c = candidate(id, history)?;
            // The session folder's birth is the session's; the file is rewritten.
            if let Some((created, _, _)) = file_times(&e.path()) {
                c.created_ms = created;
            }
            Some(c)
        })
        .collect()
}

fn parse_grok(path: &Path) -> Parsed {
    let mut parsed = Parsed::default();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let id = format!("g-{index}");
        match line.get("type").and_then(Value::as_str) {
            Some("user") => {
                // Only real prompts carry an index; the rest is injected context.
                if line.get("prompt_index").is_none() {
                    continue;
                }
                let raw = value_text(line.get("content").unwrap_or(&Value::Null));
                let text = tag_body(&raw, "user_query").map(|q| strip_leading_tag_blocks(&q)).unwrap_or(raw);
                parsed.push_text("user", id, text, None);
                parsed.busy = Some(true);
            }
            Some("assistant") => {
                if let Some(model) = str_of(&line, "model_id") {
                    parsed.model = Some(model);
                }
                if let Some(effort) = str_of(&line, "reasoning_effort") {
                    parsed.effort = Some(effort);
                }
                parsed.push_text("assistant", id.clone(), value_text(line.get("content").unwrap_or(&Value::Null)), None);
                // A reply that calls tools continues the turn; one without ends it.
                parsed.busy = Some(line.get("tool_calls").and_then(Value::as_array).is_some_and(|c| !c.is_empty()));
                if let Some(calls) = line.get("tool_calls").and_then(Value::as_array) {
                    for (ci, call) in calls.iter().enumerate() {
                        let call_id = str_of(call, "id").unwrap_or_else(|| format!("{id}:{ci}"));
                        let name = str_of(call, "name").unwrap_or_else(|| "tool".into());
                        let raw = call.get("arguments");
                        let input = raw.map(tool_input_summary).unwrap_or_default();
                        let data = raw.and_then(|r| tool_structured(&name, r));
                        parsed.push_tool_with(call_id, name, input, data, None);
                    }
                }
            }
            Some("reasoning") => {
                let text = line
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|s| s.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default();
                parsed.push_text("reasoning", id, text, None);
            }
            Some("tool_result") => {
                parsed.busy = Some(true);
                let call = str_of(&line, "tool_call_id").unwrap_or_default();
                parsed.finish_tool(&call, value_text(line.get("content").unwrap_or(&Value::Null)), false);
            }
            _ => {}
        }
    }
    parsed
}

/// Grok nests harness instructions (`<t3_code_instructions>` etc.) at the top of a query.
fn strip_leading_tag_blocks(text: &str) -> String {
    let mut rest = text.trim_start();
    while rest.starts_with('<') {
        let Some(close_open) = rest.find('>') else { break };
        let tag = &rest[1..close_open];
        if tag.contains(' ') || tag.starts_with('/') {
            break;
        }
        let close = format!("</{tag}>");
        match rest.find(&close) {
            Some(end) => rest = rest[end + close.len()..].trim_start(),
            None => break,
        }
    }
    rest.to_string()
}

// ---------------------------------------------------------------------------
// OpenCode (2.x): SQLite at <data>/opencode/opencode.db, tables session_v2 / session_message
// ---------------------------------------------------------------------------

fn opencode_db() -> Option<PathBuf> {
    let base = env_dir("XDG_DATA_HOME").or_else(|| home().map(|h| h.join(".local").join("share")))?;
    let db = base.join("opencode").join("opencode.db");
    db.is_file().then_some(db)
}

fn read_opencode(q: &TranscriptQuery) -> Result<TranscriptResult, String> {
    let Some(db) = opencode_db() else { return Ok(TranscriptResult::default()) };
    let conn = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));

    let mut stmt = conn
        .prepare("SELECT id, directory, time_created, time_updated FROM session_v2 WHERE parent_id IS NULL AND time_updated >= ?1")
        .map_err(|e| format!("OpenCode database not readable (expected 2.x schema): {e}"))?;
    let floor = q.since_ms - SINCE_SLACK_MS;
    let rows = stmt
        .query_map([floor.min(q.since_ms)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
        })
        .map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    for row in rows.flatten() {
        if same_dir(&row.1, &q.cwd) {
            candidates.push(Candidate { id: row.0, path: PathBuf::new(), created_ms: row.2, modified_ms: row.3, len: 0 });
        }
    }
    // The bound session can be older than the floor (a resumed session).
    if let Some(bound) = q.session_id.as_deref() {
        if !candidates.iter().any(|c| c.id == bound) {
            if let Ok((id, created, updated)) = conn.query_row(
                "SELECT id, time_created, time_updated FROM session_v2 WHERE id = ?1",
                [bound],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
            ) {
                candidates.push(Candidate { id, path: PathBuf::new(), created_ms: created, modified_ms: updated, len: 0 });
            }
        }
    }
    let Some(found) = pick(q, candidates) else { return Ok(TranscriptResult::default()) };

    let (count, latest): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(time_updated), 0) FROM session_message WHERE session_id = ?1",
            [&found.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    let revision = format!("{count}:{latest}");
    if q.known_revision.as_deref() == Some(revision.as_str()) && q.session_id.as_deref() == Some(found.id.as_str()) {
        return Ok(TranscriptResult { session_id: Some(found.id), revision: Some(revision), unchanged: true, ..Default::default() });
    }

    let mut parsed = Parsed::default();
    let mut stmt = conn
        .prepare("SELECT id, type, time_created, data FROM session_message WHERE session_id = ?1 ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&found.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))
        })
        .map_err(|e| e.to_string())?;
    for (id, kind, created, data) in rows.flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
        let time = Some(created.to_string());
        match kind.as_str() {
            "user" => {
                let mut text = str_of(&v, "text").unwrap_or_default();
                let files = v.get("files").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
                if files > 0 {
                    text.push_str(&if files == 1 { "\n[attachment]".to_string() } else { format!("\n[{files} attachments]") });
                }
                parsed.push_text("user", id, text, time);
                parsed.busy = Some(true);
            }
            "assistant" => {
                parsed.busy = Some(v.pointer("/time/completed").is_none());
                if let Some(model) = v.pointer("/model/id").and_then(Value::as_str) {
                    parsed.model = Some(model.to_string());
                    parsed.effort = v.pointer("/model/variant").and_then(Value::as_str).filter(|x| *x != "default").map(str::to_string);
                }
                if let Some(tokens) = v.get("tokens").filter(|t| t.is_object()) {
                    let used = u64_at(tokens, "/input")
                        + u64_at(tokens, "/output")
                        + u64_at(tokens, "/reasoning")
                        + u64_at(tokens, "/cache/read")
                        + u64_at(tokens, "/cache/write");
                    if used > 0 {
                        parsed.context_used = Some(used);
                    }
                }
                for (bi, block) in v.get("content").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate() {
                    let bid = format!("{id}:{bi}");
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => parsed.push_text("assistant", bid, str_of(block, "text").unwrap_or_default(), time.clone()),
                        Some("reasoning") => parsed.push_text("reasoning", bid, str_of(block, "text").unwrap_or_default(), time.clone()),
                        Some("tool") => {
                            let call = str_of(block, "id").unwrap_or(bid);
                            let name = str_of(block, "name").unwrap_or_else(|| "tool".into());
                            let state = block.get("state").cloned().unwrap_or(Value::Null);
                            let raw = state.get("input");
                            let input = raw.map(tool_input_summary).unwrap_or_default();
                            let data = raw.and_then(|r| tool_structured(&name, r));
                            parsed.push_tool_with(call.clone(), name, input, data, time.clone());
                            match state.get("status").and_then(Value::as_str) {
                                Some("completed") => {
                                    let out = state.get("output").map(value_text).unwrap_or_default();
                                    parsed.finish_tool(&call, out, false);
                                }
                                Some("error") => {
                                    let out = state.get("error").map(value_text).unwrap_or_default();
                                    parsed.finish_tool(&call, out, true);
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                    let msg = err.pointer("/data/message").or_else(|| err.get("message")).map(value_text).unwrap_or_else(|| err.to_string());
                    parsed.push_text("notice", format!("{id}:error"), msg, time);
                }
            }
            "idle" => parsed.busy = Some(false),
            "compaction" => parsed.push_text("notice", id, "Conversation compacted".into(), time),
            _ => {}
        }
    }
    Ok(finish(Some(found.id), Some(revision), parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_dir_name_matches_cli_encoding() {
        assert_eq!(
            claude_project_dir_name(r"C:\Users\SMIDS MAN\Documents\Samuel Works\spacron"),
            "C--Users-SMIDS-MAN-Documents-Samuel-Works-spacron"
        );
    }

    #[test]
    fn grok_dir_name_matches_cli_encoding() {
        assert_eq!(encode_uri_component(r"C:\Samuel Works\spacron"), "C%3A%5CSamuel%20Works%5Cspacron");
    }

    #[test]
    fn claude_user_text_drops_wrappers() {
        assert_eq!(claude_user_text("<local-command-stdout>x</local-command-stdout>"), None);
        assert_eq!(
            claude_user_text("<command-name>/clear</command-name>\n<command-args></command-args>").as_deref(),
            Some("/clear")
        );
        assert_eq!(claude_user_text("hi<system-reminder>secret</system-reminder>").as_deref(), Some("hi"));
        assert_eq!(claude_user_text("<task-notification><task-id>x</task-id></task-notification>"), None);
        assert_eq!(
            claude_user_text("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-opus-5-5</command-args>"),
            None
        );
        assert_eq!(claude_user_text("<command-name>/effort</command-name>\n<command-args>high</command-args>"), None);
        assert_eq!(claude_user_text("<local-command-stdout>Set model to `Opus 5.5`</local-command-stdout>"), None);
        assert_eq!(
            claude_user_text("<command-name>/review</command-name>\n<command-args></command-args>").as_deref(),
            Some("/review")
        );
        assert_eq!(claude_user_text("<bash-input>git status</bash-input>").as_deref(), Some("! git status"));
    }

    #[test]
    fn reads_top_level_toml_strings_only() {
        let text = "model = \"gpt-6-luna\" # comment\nmodel_reasoning_effort = 'medium'\n[profiles.x]\nmodel = \"other\"\n";
        assert_eq!(toml_top_level_string(text, "model").as_deref(), Some("gpt-6-luna"));
        assert_eq!(toml_top_level_string(text, "model_reasoning_effort").as_deref(), Some("medium"));
        assert_eq!(toml_top_level_string("[a]\nmodel = \"x\"\n", "model"), None);
    }

    #[test]
    fn maps_permission_modes() {
        assert_eq!(claude_permission("bypassPermissions").as_deref(), Some("full-access"));
        assert_eq!(claude_permission("acceptEdits").as_deref(), Some("accept-edits"));
        assert_eq!(claude_permission("manual").as_deref(), Some("ask"));
        let full = serde_json::json!({"approval_policy": "never", "approvals_reviewer": "user", "permission_profile": {"type": "disabled"}});
        let auto = serde_json::json!({"approval_policy": "on-request", "approvals_reviewer": "auto_review"});
        let ask = serde_json::json!({"approval_policy": "on-request", "approvals_reviewer": "user", "permission_profile": {"type": "managed"}});
        assert_eq!(codex_permission(&full).as_deref(), Some("full-access"));
        assert_eq!(codex_permission(&auto).as_deref(), Some("auto"));
        assert_eq!(codex_permission(&ask).as_deref(), Some("ask"));
    }

    #[test]
    fn classifies_claude_commands_and_their_output() {
        assert_eq!(
            claude_user_entry("<command-name>/cost</command-name>\n<command-args></command-args>"),
            ClaudeUserEntry::Command("/cost".into())
        );
        assert_eq!(claude_user_entry("<command-name>/model</command-name>\n<command-args>opus</command-args>"), ClaudeUserEntry::SettingsCommand);
        assert_eq!(
            claude_user_entry("<local-command-stdout>\u{1b}[1mTotal cost:\u{1b}[22m $0.12</local-command-stdout>"),
            ClaudeUserEntry::Output("Total cost: $0.12".into())
        );
        let mut parsed = Parsed::default();
        let time = None;
        parsed.push_claude_entry(&ClaudeUserEntry::SettingsCommand, "a", &time);
        parsed.push_claude_entry(&ClaudeUserEntry::Output("Set model to opus".into()), "b", &time);
        parsed.push_claude_entry(&ClaudeUserEntry::Command("/cost".into()), "c", &time);
        parsed.push_claude_entry(&ClaudeUserEntry::Output("Total cost: $0.12".into()), "d", &time);
        let kinds: Vec<_> = parsed.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, ["command", "command-output"]);
        assert_eq!(parsed.busy, Some(false));
    }

    #[test]
    fn keeps_structured_input_only_for_rich_tools() {
        let edit = serde_json::json!({"file_path": "a.rs", "old_string": "x", "new_string": "y"});
        assert!(tool_structured("Edit", &edit).is_some());
        let todos = serde_json::json!({"todos": [{"content": "a", "status": "pending"}]});
        assert!(tool_structured("TodoWrite", &todos).is_some());
        let plan = Value::String(r#"{"plan":[{"step":"a","status":"completed"}]}"#.into());
        assert!(tool_structured("update_plan", &plan).is_some());
        let patch = Value::String("*** Begin Patch\n*** Update File: a\n*** End Patch".into());
        assert_eq!(tool_structured("apply_patch", &patch).unwrap()["patch"].as_str().unwrap().lines().count(), 3);
        assert!(tool_structured("Write", &serde_json::json!({"file_path": "a.md", "content": "hi"})).is_some());
        assert!(tool_structured("Agent", &serde_json::json!({"description": "d", "prompt": "p"})).is_some());
        assert!(tool_structured("Bash", &serde_json::json!({"command": "ls"})).is_none());
        assert!(tool_structured("Read", &serde_json::json!({"file_path": "a.rs", "content": "x"})).is_none());
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_000), (2024, 10, 4));
    }

    #[test]
    fn grok_query_strips_harness_blocks() {
        assert_eq!(strip_leading_tag_blocks("<t3>do x</t3>\n hello"), "hello");
    }

    /// Reads this machine's real transcripts: `cargo test agent_transcript -- --ignored --nocapture`
    /// with `TRANSCRIPT_SMOKE_CWD` set to a folder the CLIs have run in.
    #[test]
    #[ignore]
    fn smoke_reads_local_transcripts() {
        let cwd = std::env::var("TRANSCRIPT_SMOKE_CWD").expect("set TRANSCRIPT_SMOKE_CWD");
        for agent in ["claude", "codex", "opencode", "grok", "pi", "antigravity", "copilot", "cursor", "openclaude", "omp"] {
            let q = TranscriptQuery {
                agent: agent.into(),
                cwd: cwd.clone(),
                since_ms: 0,
                session_id: None,
                exclude: vec![],
                known_revision: None,
                account: None,
            };
            match read_transcript(&q) {
                Ok(r) => {
                    let kinds = r.messages.iter().fold(std::collections::BTreeMap::new(), |mut m, i| {
                        *m.entry(i.kind.clone()).or_insert(0) += 1;
                        m
                    });
                    println!(
                        "{agent}: session={:?} busy={:?} model={:?} effort={:?} ctx={:?}/{:?} kinds={kinds:?}",
                        r.session_id, r.busy, r.model, r.effort, r.context_used, r.context_window
                    );
                    if let Some(u) = r.messages.iter().rev().find(|i| i.kind == "user") {
                        println!("  last user: {}", u.text.chars().take(100).collect::<String>().replace('\n', " "));
                    }
                }
                Err(e) => println!("{agent}: error {e}"),
            }
        }
    }

    #[test]
    fn picks_bound_then_newest_unclaimed() {
        let mk = |id: &str, created: i64, modified: i64| Candidate {
            id: id.into(),
            path: PathBuf::new(),
            created_ms: created,
            modified_ms: modified,
            len: 0,
        };
        let q = |bound: Option<&str>, exclude: Vec<&str>| TranscriptQuery {
            agent: "claude".into(),
            cwd: String::new(),
            since_ms: 100_000,
            session_id: bound.map(str::to_string),
            exclude: exclude.into_iter().map(str::to_string).collect(),
            known_revision: None,
            account: None,
        };
        let all = || vec![mk("old", 1, 2), mk("a", 100_000, 120_000), mk("b", 110_000, 115_000)];
        assert_eq!(pick(&q(None, vec![]), all()).unwrap().id, "b");
        assert_eq!(pick(&q(None, vec!["b"]), all()).unwrap().id, "a");
        assert_eq!(pick(&q(Some("old"), vec![]), all()).unwrap().id, "old");
        assert!(pick(&q(Some("missing"), vec![]), all()).is_none());
    }
}
