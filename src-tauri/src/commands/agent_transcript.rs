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

fn read_transcript(q: &TranscriptQuery) -> Result<TranscriptResult, String> {
    let mut result = match q.agent.as_str() {
        "claude" => read_file_agent(q, claude_candidates(&q.cwd), parse_claude),
        "codex" => read_file_agent(q, codex_candidates(&q.cwd, q.since_ms), parse_codex),
        "grok" => read_file_agent(q, grok_candidates(&q.cwd), parse_grok),
        "opencode" => read_opencode(q),
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
}

impl Parsed {
    fn push_text(&mut self, kind: &str, id: String, text: String, time: Option<String>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.items.push(ChatItem { id, kind: kind.into(), text: clip(&text, MAX_TEXT_CHARS), time, ..Default::default() });
    }

    fn push_tool(&mut self, id: String, name: String, input: String, time: Option<String>) {
        self.items.push(ChatItem {
            id,
            kind: "tool".into(),
            tool_name: Some(name),
            tool_input: Some(clip(&input, MAX_TOOL_CHARS)),
            tool_status: Some("running".into()),
            time,
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
    for key in ["command", "cmd", "file_path", "filePath", "path", "target_file", "target_directory", "pattern", "query", "url", "description", "prompt"] {
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

fn claude_candidates(cwd: &str) -> Vec<Candidate> {
    let Some(base) = env_dir("CLAUDE_CONFIG_DIR").or_else(|| home().map(|h| h.join(".claude"))) else {
        return Vec::new();
    };
    let projects = base.join("projects");
    let wanted = claude_project_dir_name(cwd.trim_end_matches(['\\', '/']));
    let mut dir = projects.join(&wanted);
    if !dir.is_dir() {
        // Drive-letter and folder case can differ between our cwd and Claude's.
        let found = fs::read_dir(&projects).ok().and_then(|entries| {
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
    let mut parsed = Parsed::default();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if line.get("isSidechain").and_then(Value::as_bool) == Some(true)
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
                    if let Some(text) = claude_user_text(s) {
                        parsed.push_text("user", uuid, text, time);
                    }
                }
                Value::Array(blocks) => {
                    let mut words = Vec::new();
                    let mut images = 0;
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = block.get("text").and_then(Value::as_str).and_then(claude_user_text) {
                                    words.push(text);
                                }
                            }
                            Some("image") => images += 1,
                            Some("tool_result") => {
                                let id = str_of(block, "tool_use_id").unwrap_or_default();
                                let output = value_text(block.get("content").unwrap_or(&Value::Null));
                                let error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                                parsed.finish_tool(&id, output, error);
                            }
                            _ => {}
                        }
                    }
                    if images > 0 {
                        words.push(if images == 1 { "[image]".into() } else { format!("[{images} images]") });
                    }
                    if !words.is_empty() {
                        parsed.push_text("user", uuid, words.join("\n"), time);
                    }
                }
                _ => {}
            }
            continue;
        }
        // assistant
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
                        let input = tool_input_summary(block.get("input").unwrap_or(&Value::Null));
                        parsed.push_tool(call, name, input, time.clone());
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

fn codex_candidates(cwd: &str, since_ms: i64) -> Vec<Candidate> {
    let Some(base) = env_dir("CODEX_HOME").or_else(|| home().map(|h| h.join(".codex"))) else {
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
                "task_complete" | "turn_aborted" => parsed.busy = Some(false),
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
                            let mut images = 0;
                            for b in &blocks {
                                match b.get("type").and_then(Value::as_str) {
                                    Some("input_text") => {
                                        let t = str_of(b, "text").unwrap_or_default();
                                        if t.trim_start().starts_with("<image") {
                                            images += 1;
                                        } else if !codex_injected(&t) {
                                            words.push(t);
                                        }
                                    }
                                    Some("input_image") if images == 0 => images += 1,
                                    _ => {}
                                }
                            }
                            if images > 0 {
                                words.push(if images == 1 { "[image]".into() } else { format!("[{images} images]") });
                            }
                            parsed.push_text("user", id, words.join("\n"), time);
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
                        let input = p
                            .get("arguments")
                            .or_else(|| p.get("input"))
                            .or_else(|| p.get("action"))
                            .map(tool_input_summary)
                            .unwrap_or_default();
                        parsed.push_tool(call, name, input, time);
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

fn grok_candidates(cwd: &str) -> Vec<Candidate> {
    let Some(base) = env_dir("GROK_HOME").or_else(|| home().map(|h| h.join(".grok"))) else {
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
            }
            Some("assistant") => {
                if let Some(model) = str_of(&line, "model_id") {
                    parsed.model = Some(model);
                }
                if let Some(effort) = str_of(&line, "reasoning_effort") {
                    parsed.effort = Some(effort);
                }
                parsed.push_text("assistant", id.clone(), value_text(line.get("content").unwrap_or(&Value::Null)), None);
                if let Some(calls) = line.get("tool_calls").and_then(Value::as_array) {
                    for (ci, call) in calls.iter().enumerate() {
                        let call_id = str_of(call, "id").unwrap_or_else(|| format!("{id}:{ci}"));
                        let name = str_of(call, "name").unwrap_or_else(|| "tool".into());
                        let input = call.get("arguments").map(tool_input_summary).unwrap_or_default();
                        parsed.push_tool(call_id, name, input, None);
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
                            let input = state.get("input").map(tool_input_summary).unwrap_or_default();
                            parsed.push_tool(call.clone(), name, input, time.clone());
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
        for agent in ["claude", "codex", "opencode", "grok"] {
            let q = TranscriptQuery {
                agent: agent.into(),
                cwd: cwd.clone(),
                since_ms: 0,
                session_id: None,
                exclude: vec![],
                known_revision: None,
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
        };
        let all = || vec![mk("old", 1, 2), mk("a", 100_000, 120_000), mk("b", 110_000, 115_000)];
        assert_eq!(pick(&q(None, vec![]), all()).unwrap().id, "b");
        assert_eq!(pick(&q(None, vec!["b"]), all()).unwrap().id, "a");
        assert_eq!(pick(&q(Some("old"), vec![]), all()).unwrap().id, "old");
    }
}
