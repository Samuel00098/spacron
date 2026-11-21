//! Agent session history: an index over the transcripts each CLI already keeps
//! on disk (Claude `projects/**.jsonl`, Codex `sessions/Y/M/D/*.jsonl`,
//! OpenCode's SQLite). Spacron owns none of this data; it only lists it, so
//! deleting a row here never touches the CLI's files.
//!
//! Scanning is cached per file by (modified time, size): the first listing pays
//! for parsing, later ones only re-read files that changed.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

const DEFAULT_LIMIT: usize = 300;
const MAX_LIMIT: usize = 2000;
const PROMPT_CHARS: usize = 600;
/// Past this size a transcript is read only for its opening: the first prompt,
/// folder and model are still found, but the message count is left at 0.
const FULL_SCAN_BYTES: u64 = 48 * 1024 * 1024;
const HEAD_LINES: usize = 800;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    /// Transcript reader id (see `AGENTS`).
    pub agent: String,
    /// The id the CLI resumes by.
    pub id: String,
    pub first_prompt: String,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    /// Real prompts and replies, not tool results. 0 when unknown (huge file).
    pub message_count: u32,
    pub created_ms: i64,
    pub updated_ms: i64,
    /// The transcript file (OpenCode: its database).
    pub log_path: Option<String>,
    /// The managed account that owns this session, or None for the CLI's own home.
    /// Spacron launches Codex and Claude under an account's own home, so a session
    /// can only be resumed under the account that wrote it.
    pub account: Option<String>,
    /// Human label (e.g. email) for the account that ran this session, when known.
    pub account_label: Option<String>,
    /// True only for identity stored in session metadata, rather than the current profile.
    pub account_label_recorded: bool,
    /// OpenCode names its own sessions; empty for the others.
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub agents: Option<Vec<String>>,
    pub limit: Option<usize>,
}

struct Times {
    created: i64,
    modified: i64,
    len: u64,
}

type Cache = HashMap<PathBuf, (i64, u64, HistoryRow)>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `<app config>/spacron`: where Spacron keeps per-user data (matches the app's own helper).
fn app_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("spacron"))
}

/// An account id names a directory, so it is limited to a charset that cannot escape the managed root.
pub fn account_id_is_safe(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id != "default" && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The managed home of `account` for `agent` (`claude` or `codex`), when it exists.
pub fn account_home(agent: &str, account: &str) -> Option<PathBuf> {
    if super::agent_accounts::provider_spec(agent).is_none() || !account_id_is_safe(account) {
        return None;
    }
    let dir = app_config_dir()?.join("agent-accounts").join(agent).join(account);
    dir.is_dir().then_some(dir)
}

/// Every home an agent's sessions can live in: the CLI's own, then each managed account's.
fn session_homes(agent: &str, default_home: Option<PathBuf>) -> Vec<(Option<String>, PathBuf)> {
    let mut homes: Vec<(Option<String>, PathBuf)> = default_home.into_iter().map(|p| (None, p)).collect();
    if let Some(root) = app_config_dir().map(|d| d.join("agent-accounts").join(agent)) {
        if let Ok(entries) = fs::read_dir(root) {
            let mut accounts: Vec<(String, PathBuf)> = entries
                .filter_map(Result::ok)
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(|n| (n.to_string(), e.path())))
                .filter(|(name, _)| account_id_is_safe(name))
                .collect();
            accounts.sort();
            homes.extend(accounts.into_iter().map(|(name, path)| (Some(name), path)));
        }
    }
    homes
}

struct Found {
    path: PathBuf,
    times: Times,
    account: Option<String>,
}

fn file_times(path: &Path) -> Option<Times> {
    let meta = fs::metadata(path).ok()?;
    let ms = |t: std::time::SystemTime| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64);
    let modified = meta.modified().ok().and_then(ms)?;
    let created = meta.created().ok().and_then(ms).unwrap_or(modified);
    Some(Times { created, modified, len: meta.len() })
}

fn clip(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut out: String = t.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}

/// Newest files first, at most `limit`.
fn newest(mut files: Vec<Found>, limit: usize) -> Vec<Found> {
    files.sort_by(|a, b| b.times.modified.cmp(&a.times.modified));
    files.truncate(limit);
    files
}

fn cached(path: &Path, times: &Times, parse: impl FnOnce() -> Option<HistoryRow>) -> Option<HistoryRow> {
    if let Ok(map) = cache().lock() {
        if let Some((modified, len, row)) = map.get(path) {
            if *modified == times.modified && *len == times.len {
                return Some(row.clone());
            }
        }
    }
    let row = parse()?;
    if let Ok(mut map) = cache().lock() {
        map.insert(path.to_path_buf(), (times.modified, times.len, row.clone()));
    }
    Some(row)
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/// A real typed prompt or reply from a Claude content value, never harness text.
fn claude_text(content: &Value) -> Option<String> {
    let raw = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let t = raw.trim();
    // Slash commands, hook output, system reminders and interrupts start with a
    // tag or a fixed phrase; none of them is what the person asked.
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") || t.starts_with("[Request interrupted") {
        return None;
    }
    Some(t.to_string())
}

fn parse_claude(path: &Path, times: &Times, account: Option<String>) -> Option<HistoryRow> {
    let id = path.file_stem()?.to_string_lossy().to_string();
    let file = fs::File::open(path).ok()?;
    let head_only = times.len > FULL_SCAN_BYTES;
    let account_label = Some(profile_account_label("claude", account.as_deref()));
    let mut row = HistoryRow {
        agent: "claude".into(),
        account,
        account_label,
        account_label_recorded: false,
        id,
        first_prompt: String::new(),
        cwd: None,
        branch: None,
        model: None,
        message_count: 0,
        created_ms: times.created,
        updated_ms: times.modified,
        log_path: Some(path.to_string_lossy().to_string()),
        title: String::new(),
    };
    for (index, line) in BufReader::new(file).lines().map_while(Result::ok).enumerate() {
        if head_only && index >= HEAD_LINES {
            break;
        }
        let is_user = line.contains("\"type\":\"user\"");
        let is_assistant = line.contains("\"type\":\"assistant\"");
        if !is_user && !is_assistant {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if row.cwd.is_none() {
            row.cwd = str_of(&v, "cwd");
        }
        if row.branch.is_none() {
            row.branch = str_of(&v, "gitBranch").filter(|b| b != "HEAD");
        }
        let Some(content) = v.pointer("/message/content") else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let Some(text) = claude_text(content) {
                    if row.first_prompt.is_empty() {
                        row.first_prompt = clip(&text, PROMPT_CHARS);
                    }
                    row.message_count += 1;
                }
            }
            Some("assistant") => {
                if row.model.is_none() {
                    row.model = v.pointer("/message/model").and_then(Value::as_str).map(str::to_string).filter(|m| m != "<synthetic>");
                }
                if claude_text(content).is_some() {
                    row.message_count += 1;
                }
            }
            _ => {}
        }
    }
    Some(row)
}

fn scan_claude(limit: usize) -> Vec<HistoryRow> {
    let default_home = env_dir("CLAUDE_CONFIG_DIR").or_else(|| home().map(|h| h.join(".claude")));
    let mut files = Vec::new();
    for (account, home) in session_homes("claude", default_home) {
        let Ok(projects) = fs::read_dir(home.join("projects")) else { continue };
        for dir in projects.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()) {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for path in entries.filter_map(Result::ok).map(|e| e.path()) {
                if path.extension().is_some_and(|x| x == "jsonl") {
                    if let Some(times) = file_times(&path) {
                        files.push(Found { path, times, account: account.clone() });
                    }
                }
            }
        }
    }
    newest(files, limit)
        .into_iter()
        .filter_map(|f| cached(&f.path, &f.times, || parse_claude(&f.path, &f.times, f.account.clone())))
        .collect()
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

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
        || t.starts_with("<image")
}

fn codex_message_text(payload: &Value, block_type: &str) -> Option<String> {
    let text = payload
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some(block_type))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .filter(|t| !codex_injected(t))
        .collect::<Vec<_>>()
        .join("\n");
    let t = text.trim();
    (!t.is_empty()).then(|| t.to_string())
}

fn parse_codex(path: &Path, times: &Times, account: Option<String>) -> Option<HistoryRow> {
    let file = fs::File::open(path).ok()?;
    let head_only = times.len > FULL_SCAN_BYTES;
    let account_label = Some(profile_account_label("codex", account.as_deref()));
    let mut row = HistoryRow {
        agent: "codex".into(),
        account,
        account_label,
        account_label_recorded: false,
        id: String::new(),
        first_prompt: String::new(),
        cwd: None,
        branch: None,
        model: None,
        message_count: 0,
        created_ms: times.created,
        updated_ms: times.modified,
        log_path: Some(path.to_string_lossy().to_string()),
        title: String::new(),
    };
    for (index, line) in BufReader::new(file).lines().map_while(Result::ok).enumerate() {
        if head_only && index >= HEAD_LINES {
            break;
        }
        let interesting = line.contains("\"session_meta\"")
            || line.contains("\"turn_context\"")
            || line.contains("\"role\":\"user\"")
            || line.contains("\"role\":\"assistant\"");
        if !interesting {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(p) = v.get("payload") else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if row.id.is_empty() {
                    row.id = str_of(p, "id").or_else(|| str_of(p, "session_id")).unwrap_or_default();
                }
                row.cwd = row.cwd.take().or_else(|| str_of(p, "cwd"));
                row.branch = row.branch.take().or_else(|| p.pointer("/git/branch").and_then(Value::as_str).map(str::to_string));
            }
            Some("turn_context") => {
                if row.model.is_none() {
                    row.model = str_of(p, "model");
                }
                if row.cwd.is_none() {
                    row.cwd = str_of(p, "cwd");
                }
            }
            Some("response_item") if p.get("type").and_then(Value::as_str) == Some("message") => {
                match p.get("role").and_then(Value::as_str) {
                    Some("user") => {
                        if let Some(text) = codex_message_text(p, "input_text") {
                            if row.first_prompt.is_empty() {
                                row.first_prompt = clip(&text, PROMPT_CHARS);
                            }
                            row.message_count += 1;
                        }
                    }
                    Some("assistant") => {
                        if codex_message_text(p, "output_text").is_some() {
                            row.message_count += 1;
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if row.id.is_empty() {
        // rollout-<timestamp>-<uuid>.jsonl
        let stem = path.file_stem()?.to_string_lossy().to_string();
        row.id = stem.get(stem.len().saturating_sub(36)..)?.to_string();
    }
    Some(row)
}

fn collect_jsonl(dir: &Path, depth: usize, account: &Option<String>, out: &mut Vec<Found>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for path in entries.filter_map(Result::ok).map(|e| e.path()) {
        if path.is_dir() {
            if depth > 0 {
                collect_jsonl(&path, depth - 1, account, out);
            }
        } else if path.extension().is_some_and(|x| x == "jsonl") {
            if let Some(times) = file_times(&path) {
                out.push(Found { path, times, account: account.clone() });
            }
        }
    }
}

fn scan_codex(limit: usize) -> Vec<HistoryRow> {
    let default_home = env_dir("CODEX_HOME").or_else(|| home().map(|h| h.join(".codex")));
    let mut files = Vec::new();
    for (account, home) in session_homes("codex", default_home) {
        collect_jsonl(&home.join("sessions"), 3, &account, &mut files);
    }
    newest(files, limit)
        .into_iter()
        .filter_map(|f| cached(&f.path, &f.times, || parse_codex(&f.path, &f.times, f.account.clone())))
        .collect()
}

// ---------------------------------------------------------------------------
// OpenCode (2.x): SQLite at <data>/opencode/opencode.db
// ---------------------------------------------------------------------------

fn opencode_db() -> Option<PathBuf> {
    let base = env_dir("XDG_DATA_HOME").or_else(|| home().map(|h| h.join(".local").join("share")))?;
    let db = base.join("opencode").join("opencode.db");
    db.is_file().then_some(db)
}

fn scan_opencode(limit: usize) -> Vec<HistoryRow> {
    let Some(db) = opencode_db() else { return Vec::new() };
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    // A schema we do not recognise yields an empty list, not an error: history
    // is a convenience and must never break the panel it sits in.
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, directory, title, model, time_created, time_updated FROM session_v2 \
         WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?1",
    ) else {
        return Vec::new();
    };
    let sessions: Vec<_> = stmt
        .query_map([limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default();
    let log_path = Some(db.to_string_lossy().to_string());
    sessions
        .into_iter()
        .map(|(id, directory, title, model, created, updated)| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_message WHERE session_id = ?1 AND type IN ('user', 'assistant')",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let first: Option<String> = conn
                .query_row(
                    "SELECT data FROM session_message WHERE session_id = ?1 AND type = 'user' ORDER BY seq LIMIT 1",
                    [&id],
                    |r| r.get(0),
                )
                .ok();
            let first_prompt = first
                .and_then(|data| serde_json::from_str::<Value>(&data).ok())
                .and_then(|v| str_of(&v, "text"))
                .map(|t| clip(&t, PROMPT_CHARS))
                .unwrap_or_default();
            // `model` may be a bare id or a JSON object with one.
            let model = model.filter(|m| !m.is_empty()).map(|m| {
                serde_json::from_str::<Value>(&m)
                    .ok()
                    .and_then(|v| str_of(&v, "id").or_else(|| str_of(&v, "modelID")))
                    .unwrap_or(m)
            });
            HistoryRow {
                agent: "opencode".into(),
                account: None,
                account_label: None,
                account_label_recorded: false,
                id,
                first_prompt,
                cwd: directory.filter(|d| !d.is_empty()),
                branch: None,
                model,
                message_count: count.max(0) as u32,
                created_ms: created,
                updated_ms: updated,
                log_path: log_path.clone(),
                title: title.unwrap_or_default(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------


/// Walk only known transcript roots. Never follow directory symlinks into unrelated trees.
fn collect_extra(dir: &Path, depth: usize, out: &mut Vec<Found>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() && depth > 0 {
            collect_extra(&path, depth - 1, out);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            if let Some(times) = file_times(&path) {
                out.push(Found { path, times, account: None });
            }
        }
    }
}

fn content_text(value: &Value) -> String {
    if let Some(s) = value.as_str() { return s.to_string() }
    value.as_array().map(|blocks| blocks.iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

fn tag_text(text: String, tag: &str) -> String {
    let start = format!("<{tag}>");
    let end = format!("</{tag}>");
    text.split_once(&start).and_then(|(_, rest)| rest.split_once(&end)).map(|(body, _)| body.trim().to_string()).unwrap_or(text)
}

fn parse_extra(agent: &str, path: &Path, times: &Times) -> Option<HistoryRow> {
    // OpenClaude uses the Claude format but must never inherit Claude's account.
    if agent == "openclaude" {
        let mut row = parse_claude(path, times, None)?;
        row.agent = agent.into();
        row.account_label = None;
        return Some(row);
    }
    let file = fs::File::open(path).ok()?;
    let mut row = HistoryRow {
        agent: agent.into(), id: path.file_stem()?.to_string_lossy().into_owned(),
        title: String::new(), first_prompt: String::new(), cwd: None, branch: None,
        model: None, message_count: 0, created_ms: times.created, updated_ms: times.modified,
        log_path: Some(path.to_string_lossy().into_owned()), account: None, account_label: None, account_label_recorded: false,
    };
    if matches!(agent, "copilot" | "grok" | "antigravity") {
        row.id = path.parent()?.file_name()?.to_string_lossy().into_owned();
    }
    if agent == "grok" {
        // Grok encodes the original working directory as a URI component.
        if let Some(folder) = path.parent().and_then(Path::parent).and_then(Path::file_name).and_then(|s| s.to_str()) {
            let bytes = folder.as_bytes();
            let mut decoded = Vec::new();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' && i + 2 < bytes.len() {
                    if let Some(byte) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                        decoded.push(byte); i += 3; continue;
                    }
                }
                decoded.push(bytes[i]); i += 1;
            }
            row.cwd = String::from_utf8(decoded).ok();
        }
    }
    let head_only = times.len > FULL_SCAN_BYTES;
    for (index, line) in BufReader::new(file).lines().map_while(Result::ok).enumerate() {
        if head_only && index >= HEAD_LINES { break }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind, "session" | "session.start" | "session_meta") {
            let metadata = v.get("data").or_else(|| v.get("payload")).unwrap_or(&v);
            if let Some(label) = str_of(metadata, "accountLabel").or_else(|| str_of(metadata, "accountEmail")) {
                row.account_label = Some(label);
                row.account_label_recorded = true;
            }
        }
        row.cwd = row.cwd.or_else(|| str_of(&v, "cwd"));
        let (role, text) = match agent {
            "pi" | "omp" => {
                if kind == "session" { row.id = str_of(&v, "id").unwrap_or(row.id); }
                if kind == "model_change" { row.model = str_of(&v, "modelId"); }
                let message = v.get("message").unwrap_or(&Value::Null);
                row.model = str_of(message, "model").or(row.model);
                (message.get("role").and_then(Value::as_str).unwrap_or(""), content_text(&message["content"]))
            }
            "copilot" => {
                let data = &v["data"];
                if kind == "session.start" {
                    row.id = str_of(data, "sessionId").unwrap_or(row.id);
                    row.cwd = data.pointer("/context/cwd").and_then(Value::as_str).map(str::to_string).or(row.cwd);
                }
                row.model = str_of(data, "model").or(row.model);
                (match kind { "user.message" => "user", "assistant.message" => "assistant", _ => "" }, content_text(&data["content"]))
            }
            "grok" => {
                row.model = str_of(&v, "model_id").or(row.model);
                let role = if kind == "user" && v.get("prompt_index").is_none() { "" } else { kind };
                (role, tag_text(content_text(&v["content"]), "user_query"))
            }
            "cursor" => {
                let content = v.pointer("/message/content").unwrap_or(&v["content"]);
                (v.get("role").and_then(Value::as_str).unwrap_or(""), tag_text(content_text(content), "user_query"))
            }
            "antigravity" => {
                row.model = str_of(&v, "model").or(row.model);
                let source = v.get("source").and_then(Value::as_str).unwrap_or("");
                let role = match (source, kind) {
                    ("USER_EXPLICIT" | "USER", "USER_INPUT" | "REQUEST") => "user",
                    ("MODEL", "PLANNER_RESPONSE") => "assistant", _ => "",
                };
                (role, tag_text(content_text(&v["content"]), "USER_REQUEST"))
            }
            _ => ("", String::new()),
        };
        if matches!(role, "user" | "assistant") && !text.trim().is_empty() {
            row.message_count += 1;
            if role == "user" && row.first_prompt.is_empty() { row.first_prompt = clip(&text, PROMPT_CHARS); }
        }
    }
    if head_only { row.message_count = 0; }
    Some(row)
}

fn profile_account_label(agent: &str, account: Option<&str>) -> String {
    match account {
        Some(id) if id != "default" => format!("{} (profile)", super::agent_accounts::account_label(agent, id)),
        _ => "Default profile (account not recorded)".into(),
    }
}

fn apply_account(row: &mut HistoryRow, account: Option<String>) {
    row.account = account;
    if row.account_label.is_none() && super::agent_accounts::provider_spec(&row.agent).is_some() {
        row.account_label = Some(profile_account_label(&row.agent, row.account.as_deref()));
    }
}

fn scan_extra(agent: &str, limit: usize) -> Vec<HistoryRow> {
    if agent == "antigravity" {
        let mut files: Vec<_> = session_homes(agent, env_dir("GEMINI_HOME").or_else(|| home().map(|h| h.join(".gemini"))))
            .into_iter().flat_map(|(account, base)| super::agent_transcript::antigravity_history_files(Some(base)).into_iter()
                .map(move |(id, cwd, path)| (account.clone(), id, cwd, path)))
            .filter_map(|(account, id, cwd, path)| Some((account, id, cwd, file_times(&path)?, path))).collect();
        files.sort_by(|a, b| b.3.modified.cmp(&a.3.modified));
        return files.into_iter().take(limit).filter_map(|(account, id, cwd, times, path)| {
            let mut row = cached(&path, &times, || parse_extra(agent, &path, &times))?;
            row.id = id; row.cwd = Some(cwd); apply_account(&mut row, account); Some(row)
        }).collect();
    }
    let Some(h) = home() else { return Vec::new() };
    let (root, depth) = match agent {
        "openclaude" => (env_dir("OPENCLAUDE_CONFIG_DIR").unwrap_or_else(|| h.join(".openclaude")).join("projects"), 1),
        "pi" => (env_dir("PI_CODING_AGENT_DIR").unwrap_or_else(|| h.join(".pi/agent")).join("sessions"), 1),
        "omp" => (env_dir("OMP_CODING_AGENT_DIR").unwrap_or_else(|| h.join(".omp/agent")).join("sessions"), 1),
        "copilot" => (env_dir("COPILOT_HOME").unwrap_or_else(|| h.join(".copilot")).join("session-state"), 1),
        "grok" => (env_dir("GROK_HOME").unwrap_or_else(|| h.join(".grok")).join("sessions"), 2),
        "cursor" => (h.join(".cursor/projects"), 2),
        _ => return Vec::new(),
    };
    let mut files = Vec::new();
    if super::agent_accounts::provider_spec(agent).is_some() {
        let base = root.parent().map(Path::to_path_buf);
        let folder = root.file_name().unwrap_or_default();
        for (account, base) in session_homes(agent, base) {
            let start = files.len();
            collect_extra(&base.join(folder), depth, &mut files);
            for file in &mut files[start..] { file.account = account.clone(); }
        }
    } else {
        collect_extra(&root, depth, &mut files);
    }
    files.retain(|f| match agent {
        "copilot" => f.path.file_name().is_some_and(|s| s == "events.jsonl"),
        "grok" => f.path.file_name().is_some_and(|s| s == "chat_history.jsonl"),
        "cursor" => f.path.parent().and_then(Path::file_name).is_some_and(|s| s == "agent-transcripts"),
        _ => true,
    });
    newest(files, limit).into_iter().filter_map(|f| {
        let mut row = cached(&f.path, &f.times, || parse_extra(agent, &f.path, &f.times))?;
        apply_account(&mut row, f.account);
        Some(row)
    }).collect()
}

pub const AGENTS: [&str; 10] = ["claude", "codex", "opencode", "grok", "openclaude", "pi", "omp", "antigravity", "copilot", "cursor"];


/// Every requested agent's recent sessions, newest first.
pub fn list_history(agents: &[String], limit: usize) -> Vec<HistoryRow> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let wants = |name: &str| agents.is_empty() || agents.iter().any(|a| a == name);
    let mut rows = Vec::new();
    if wants("claude") {
        rows.extend(scan_claude(limit));
    }
    if wants("codex") {
        rows.extend(scan_codex(limit));
    }
    if wants("opencode") {
        rows.extend(scan_opencode(limit));
    }
    for agent in &AGENTS[3..] {
        if wants(agent) { rows.extend(scan_extra(agent, limit)); }
    }
    rows.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    rows
}

// --- tauri command (omitted from the scratch crate) ---
#[tauri::command]
pub async fn agent_history_list(query: Option<HistoryQuery>) -> Result<Vec<HistoryRow>, String> {
    let (agents, limit) = match query {
        Some(q) => (q.agents.unwrap_or_default(), q.limit.unwrap_or(DEFAULT_LIMIT)),
        None => (Vec::new(), DEFAULT_LIMIT),
    };
    tauri::async_runtime::spawn_blocking(move || list_history(&agents, limit))
        .await
        .map_err(|e| e.to_string())
}
// --- end tauri command ---

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str, body: &str) -> (PathBuf, Times) {
        let dir = std::env::temp_dir().join(format!("hist-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::File::create(&path).unwrap().write_all(body.as_bytes()).unwrap();
        let t = file_times(&path).unwrap();
        (path, t)
    }

    #[test]
    fn claude_skips_harness_text_and_counts_real_messages() {
        let body = concat!(
            "{\"type\":\"queue-operation\"}\n",
            "{\"type\":\"user\",\"isSidechain\":false,\"cwd\":\"C:\\\\proj\",\"gitBranch\":\"main\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/model</command-name>\"}}\n",
            "{\"type\":\"user\",\"isSidechain\":false,\"cwd\":\"C:\\\\proj\",\"gitBranch\":\"main\",\"message\":{\"role\":\"user\",\"content\":\"Fix the login bug\"}}\n",
            "{\"type\":\"assistant\",\"isSidechain\":false,\"message\":{\"model\":\"claude-x\",\"content\":[{\"type\":\"text\",\"text\":\"On it.\"}]}}\n",
            "{\"type\":\"assistant\",\"isSidechain\":false,\"message\":{\"model\":\"claude-x\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\"}]}}\n",
            "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"content\":\"subagent prompt\"}}\n",
        );
        let (path, t) = tmp("abc123.jsonl", body);
        let row = parse_claude(&path, &t, None).unwrap();
        assert_eq!(row.id, "abc123");
        assert_eq!(row.first_prompt, "Fix the login bug");
        assert_eq!(row.cwd.as_deref(), Some("C:\\proj"));
        assert_eq!(row.branch.as_deref(), Some("main"));
        assert_eq!(row.model.as_deref(), Some("claude-x"));
        assert_eq!(row.message_count, 2);
    }

    #[test]
    fn codex_ignores_injected_context() {
        let body = concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"sess-1\",\"cwd\":\"C:\\\\w\",\"git\":{\"branch\":\"dev\"}}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>x</environment_context>\"}]}}\n",
            "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-x\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Add a retry\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done\"}]}}\n",
        );
        let (path, t) = tmp("rollout-2026-11-20T16-39-25-01a1f99c-cb43-7943-9b42-d08ef7f2f7b4.jsonl", body);
        let row = parse_codex(&path, &t, None).unwrap();
        assert_eq!(row.id, "sess-1");
        assert_eq!(row.first_prompt, "Add a retry");
        assert_eq!(row.branch.as_deref(), Some("dev"));
        assert_eq!(row.model.as_deref(), Some("gpt-x"));
        assert_eq!(row.message_count, 2);
    }

    #[test]
    fn codex_falls_back_to_the_id_in_the_file_name() {
        let (path, t) = tmp("rollout-fallback-01a1f99c-cb43-7943-9b42-d08ef7f2f7b4.jsonl", "{}\n");
        assert_eq!(parse_codex(&path, &t, None).unwrap().id, "01a1f99c-cb43-7943-9b42-d08ef7f2f7b4");
    }

    #[test]
    fn account_ids_cannot_escape_the_managed_root() {
        assert!(account_id_is_safe("samuelsolesi16-gmail-com"));
        assert!(!account_id_is_safe("default"));
        assert!(!account_id_is_safe(""));
        assert!(!account_id_is_safe("../x"));
        assert!(!account_id_is_safe("a/b"));
        assert!(account_home("opencode", "x").is_none());
        assert!(account_home("codex", "../etc").is_none());
    }

    #[test]
    fn extra_readers_extract_native_ids_prompts_and_models() {
        for agent in ["pi", "omp"] {
            let (path, t) = tmp(&format!("{agent}.jsonl"), concat!(
                "{\"type\":\"session\",\"id\":\"native-id\",\"cwd\":\"C:/work\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Fix it\"}]}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"model\":\"m\",\"content\":\"Done\"}}\n"));
            let row = parse_extra(agent, &path, &t).unwrap();
            assert_eq!(row.id, "native-id");
            assert_eq!(row.first_prompt, "Fix it");
            assert_eq!(row.cwd.as_deref(), Some("C:/work"));
            assert_eq!(row.model.as_deref(), Some("m"));
            assert_eq!(row.message_count, 2);
        }
        let (path, t) = tmp("copilot.jsonl", concat!(
            "{\"type\":\"session.start\",\"data\":{\"sessionId\":\"cp-id\",\"context\":{\"cwd\":\"C:/p\"}}}\n",
            "{\"type\":\"user.message\",\"data\":{\"content\":\"Hello\"}}\n"));
        let row = parse_extra("copilot", &path, &t).unwrap();
        assert_eq!(row.id, "cp-id");
        assert_eq!(row.cwd.as_deref(), Some("C:/p"));
        assert_eq!(row.first_prompt, "Hello");
    }

    #[test]
    fn owner_identity_comes_from_session_metadata_not_message_content() {
        let (path, t) = tmp("owner.jsonl", concat!(
            "{\"type\":\"session\",\"id\":\"owned\",\"accountEmail\":\"original@example.com\"}\n",
            "{\"type\":\"message\",\"accountEmail\":\"unrelated@example.com\",\"message\":{\"role\":\"user\",\"content\":\"Hello\"}}\n"));
        let mut row = parse_extra("pi", &path, &t).unwrap();
        apply_account(&mut row, Some("work".into()));
        assert_eq!(row.account_label.as_deref(), Some("original@example.com"));
        assert!(row.account_label_recorded);
        assert_eq!(row.account.as_deref(), Some("work"));
        assert_eq!(profile_account_label("claude", None), "Default profile (account not recorded)");
    }

    #[test]
    fn extra_readers_skip_tools_and_unwrap_user_prompts() {
        let (path, t) = tmp("cursor.jsonl", concat!(
            "bad json\n",
            "{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"noise\"}]}}\n",
            "{\"role\":\"user\",\"message\":{\"content\":\"<user_query>Fix Cursor</user_query>\"}}\n"));
        let row = parse_extra("cursor", &path, &t).unwrap();
        assert_eq!(row.first_prompt, "Fix Cursor");
        assert_eq!(row.message_count, 1);
        assert!(row.cwd.is_none()); // An encoded directory name cannot safely be reversed.
        let (path, t) = tmp("grok.jsonl", concat!(
            "{\"type\":\"user\",\"content\":\"injected instructions\"}\n",
            "{\"type\":\"user\",\"prompt_index\":0,\"content\":\"<user_query>Fix Grok</user_query>\"}\n"));
        assert_eq!(parse_extra("grok", &path, &t).unwrap().first_prompt, "Fix Grok");
        let (path, t) = tmp("antigravity.jsonl", "{\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"content\":\"<USER_REQUEST>Fix AG</USER_REQUEST>metadata\"}\n");
        assert_eq!(parse_extra("antigravity", &path, &t).unwrap().first_prompt, "Fix AG");
        let (path, t) = tmp("openclaude.jsonl", "{\"type\":\"user\",\"cwd\":\"C:/oc\",\"message\":{\"content\":\"Hello OC\"}}\n");
        let row = parse_extra("openclaude", &path, &t).unwrap();
        assert_eq!(row.agent, "openclaude");
        assert!(row.account_label.is_none());
        assert_eq!(row.first_prompt, "Hello OC");
    }

    #[test]
    fn cache_reuses_an_unchanged_file_and_reparses_a_changed_one() {
        let (path, t) = tmp("cache.jsonl", "{\"type\":\"user\",\"message\":{\"content\":\"one\"}}\n");
        let mut calls = 0;
        let a = cached(&path, &t, || { calls += 1; parse_claude(&path, &t, None) }).unwrap();
        let b = cached(&path, &t, || { calls += 1; parse_claude(&path, &t, None) }).unwrap();
        assert_eq!(calls, 1);
        assert_eq!(a, b);
        let changed = Times { created: t.created, modified: t.modified + 1, len: t.len };
        cached(&path, &changed, || { calls += 1; parse_claude(&path, &changed, None) }).unwrap();
        assert_eq!(calls, 2);
    }
}
