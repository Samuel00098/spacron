//! Transcript readers for the agents Orca's chat covers beyond the first four:
//! OpenClaude (Claude Code's format, its own home), Pi and OMP (Pi's session
//! JSONL), Antigravity (its `brain/<id>/.system_generated/logs/transcript.jsonl`),
//! GitHub Copilot CLI (`session-state/<id>/events.jsonl`) and Cursor Agent
//! (`projects/<folder>/agent-transcripts/*.jsonl`).
//!
//! Layouts follow Orca's session scanners (`src/main/ai-vault/scanners/*`).
//! Pi and Antigravity were checked against files on a real machine; Copilot and
//! Cursor follow Orca's parsers and read defensively, so an unknown record is
//! skipped rather than misread.

use super::*;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// OpenClaude: Claude Code's transcript format under ~/.openclaude
// ---------------------------------------------------------------------------

pub(super) fn openclaude_candidates(cwd: &str) -> Vec<Candidate> {
    let Some(base) = env_dir("OPENCLAUDE_CONFIG_DIR").or_else(|| home().map(|h| h.join(".openclaude"))) else {
        return Vec::new();
    };
    jsonl_candidates_in(&base.join("projects"), &claude_project_dir_name(cwd.trim_end_matches(['\\', '/'])))
}

/// `<root>/<folder>/*.jsonl`, the folder matched without regard to case.
fn jsonl_candidates_in(root: &Path, folder: &str) -> Vec<Candidate> {
    let Some(dir) = find_dir_ci(root, folder) else { return Vec::new() };
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| candidate(p.file_stem()?.to_string_lossy().to_string(), p))
        .collect()
}

fn find_dir_ci(root: &Path, name: &str) -> Option<PathBuf> {
    let exact = root.join(name);
    if exact.is_dir() {
        return Some(exact);
    }
    fs::read_dir(root).ok()?.filter_map(Result::ok).find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)).map(|e| e.path())
}

// ---------------------------------------------------------------------------
// Pi and OMP: <agent>/sessions/--<cwd with / \ : as ->--/<time>_<id>.jsonl
// ---------------------------------------------------------------------------

pub(super) fn pi_sessions_dir() -> Option<PathBuf> {
    env_dir("PI_CODING_AGENT_DIR").map(|d| d.join("sessions")).or_else(|| home().map(|h| h.join(".pi").join("agent").join("sessions")))
}

pub(super) fn omp_sessions_dir() -> Option<PathBuf> {
    env_dir("OMP_CODING_AGENT_DIR").map(|d| d.join("sessions")).or_else(|| home().map(|h| h.join(".omp").join("agent").join("sessions")))
}

/// Pi's folder name for a working directory: `C:\Users\me` → `--C--Users-me--`.
pub(super) fn pi_dir_name(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(['\\', '/']).trim_start_matches(['\\', '/']);
    format!("--{}--", trimmed.replace(['/', '\\', ':'], "-"))
}

pub(super) fn pi_candidates(root: Option<PathBuf>, cwd: &str) -> Vec<Candidate> {
    let Some(root) = root else { return Vec::new() };
    jsonl_candidates_in(&root, &pi_dir_name(cwd))
}

fn pi_text(content: &Value) -> (String, Vec<String>) {
    match content {
        Value::String(s) => (s.clone(), Vec::new()),
        Value::Array(blocks) => {
            let mut words = Vec::new();
            let mut images = Vec::new();
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => words.push(str_of(b, "text").unwrap_or_default()),
                    Some("image") => {
                        if let Some(data) = str_of(b, "data") {
                            let mime = str_of(b, "mimeType").unwrap_or_else(|| "image/png".into());
                            let url = format!("data:{mime};base64,{data}");
                            if url.len() <= MAX_IMAGE_URL_CHARS {
                                images.push(url);
                            }
                        }
                    }
                    _ => {}
                }
            }
            (words.join("\n"), images)
        }
        _ => (String::new(), Vec::new()),
    }
}

pub(super) fn parse_pi(path: &Path) -> Parsed {
    let mut parsed = Parsed::default();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let time = str_of(&line, "timestamp");
        let id = str_of(&line, "id").unwrap_or_else(|| format!("p-{index}"));
        match line.get("type").and_then(Value::as_str) {
            Some("model_change") => parsed.model = str_of(&line, "modelId").or(parsed.model.take()),
            Some("thinking_level_change") => parsed.effort = str_of(&line, "thinkingLevel").filter(|l| l != "off"),
            Some("compaction") => parsed.push_text("notice", id, "Conversation compacted".into(), time),
            Some("message") => {
                let Some(message) = line.get("message") else { continue };
                let content = message.get("content").cloned().unwrap_or(Value::Null);
                match message.get("role").and_then(Value::as_str) {
                    Some("user") => {
                        let (text, images) = pi_text(&content);
                        parsed.push_user(id, text, images, time);
                        parsed.busy = Some(true);
                    }
                    Some("assistant") => {
                        if let Some(model) = str_of(message, "model") {
                            parsed.model = Some(model);
                        }
                        if let Some(usage) = message.get("usage").filter(|u| u.is_object()) {
                            let used = usage.get("totalTokens").and_then(Value::as_u64).unwrap_or_else(|| {
                                u64_at(usage, "/input") + u64_at(usage, "/output") + u64_at(usage, "/cacheRead") + u64_at(usage, "/cacheWrite")
                            });
                            if used > 0 {
                                parsed.context_used = Some(used);
                            }
                        }
                        if let Value::Array(blocks) = &content {
                            for (bi, block) in blocks.iter().enumerate() {
                                let bid = format!("{id}:{bi}");
                                match block.get("type").and_then(Value::as_str) {
                                    Some("text") => parsed.push_text("assistant", bid, str_of(block, "text").unwrap_or_default(), time.clone()),
                                    Some("thinking") => parsed.push_text("reasoning", bid, str_of(block, "thinking").unwrap_or_default(), time.clone()),
                                    Some("toolCall") => {
                                        let call = str_of(block, "id").unwrap_or(bid);
                                        let name = str_of(block, "name").unwrap_or_else(|| "tool".into());
                                        let raw = block.get("arguments").unwrap_or(&Value::Null);
                                        parsed.push_tool_with(call, name.clone(), tool_input_summary(raw), tool_structured(&name, raw), time.clone());
                                    }
                                    _ => {}
                                }
                            }
                        } else if let Value::String(s) = &content {
                            parsed.push_text("assistant", id.clone(), s.clone(), time.clone());
                        }
                        let stop = str_of(message, "stopReason").unwrap_or_default();
                        parsed.busy = Some(stop == "toolUse");
                        if stop == "error" {
                            if let Some(err) = str_of(message, "errorMessage") {
                                parsed.push_text("notice", format!("{id}:error"), clip(&err, 600), time);
                            }
                        }
                    }
                    Some("toolResult") => {
                        let call = str_of(message, "toolCallId").unwrap_or_default();
                        let (text, _) = pi_text(&content);
                        let error = message.get("isError").and_then(Value::as_bool) == Some(true);
                        parsed.finish_tool(&call, text, error);
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
// Antigravity: <home>/brain/<id>/.system_generated/logs/transcript.jsonl, with
// <home>/history.jsonl naming each conversation's workspace
// ---------------------------------------------------------------------------

fn antigravity_homes() -> Vec<PathBuf> {
    let Some(h) = home() else { return Vec::new() };
    let gemini = env_dir("GEMINI_HOME").unwrap_or_else(|| h.join(".gemini"));
    vec![gemini.join("antigravity-cli"), gemini.join("antigravity")]
}

pub(super) fn antigravity_candidates(cwd: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    for base in antigravity_homes() {
        let workspaces = antigravity_workspaces(&base);
        for (id, workspace) in workspaces {
            if !same_dir(&workspace, cwd) {
                continue;
            }
            let brain = base.join("brain").join(&id);
            let transcript = brain.join(".system_generated").join("logs").join("transcript.jsonl");
            if let Some(mut c) = candidate(id, transcript) {
                if let Some((created, _, _)) = file_times(&brain) {
                    c.created_ms = created;
                }
                out.push(c);
            }
        }
    }
    out
}

/// Conversation id → workspace, from history.jsonl and ACP's `conversations/<id>.meta`.
fn antigravity_workspaces(base: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in read_lines(&base.join("history.jsonl")) {
        if let (Some(id), Some(ws)) = (str_of(&line, "conversationId"), str_of(&line, "workspace")) {
            map.insert(id, ws);
        }
    }
    // Newer CLIs (seen 2026-11-20) leave `conversationId` out of history.jsonl
    // and keep each folder's current conversation in this cache instead:
    // `{ "<workspace>": "<conversation id>" }`.
    if let Some(Value::Object(latest)) = fs::read_to_string(base.join("cache").join("last_conversations.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        for (workspace, id) in latest {
            if let Some(id) = id.as_str() {
                map.entry(id.to_string()).or_insert(workspace);
            }
        }
    }
    if let Ok(entries) = fs::read_dir(base.join("conversations")) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.extension().is_some_and(|x| x == "meta") {
                continue;
            }
            let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
            let cwd = fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| str_of(&v, "cwd").or_else(|| str_of(&v, "workspace")));
            if let Some(cwd) = cwd {
                map.entry(id).or_insert(cwd);
            }
        }
    }
    map
}

/// Antigravity stores each tool argument JSON-encoded inside a string.
fn decode_antigravity_args(args: &Value) -> Value {
    match args {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let decoded = v.as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or_else(|| v.clone());
                    (k.clone(), decoded)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The parts of a tool's output worth reading: Antigravity prefixes timing lines.
fn antigravity_output(text: &str) -> String {
    text.lines()
        .filter(|l| !l.starts_with("Created At:") && !l.starts_with("Completed At:"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub(super) fn parse_antigravity(path: &Path) -> Parsed {
    let mut parsed = Parsed::default();
    // Calls waiting for their GENERIC result, oldest first.
    let mut open_calls: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let time = str_of(&line, "created_at");
        let step = line.get("step_index").and_then(Value::as_u64).map(|n| n.to_string()).unwrap_or_else(|| index.to_string());
        let id = format!("ag-{step}");
        let source = str_of(&line, "source").unwrap_or_default();
        let kind = str_of(&line, "type").unwrap_or_default();
        let content = str_of(&line, "content").unwrap_or_default();
        match (source.as_str(), kind.as_str()) {
            ("USER_EXPLICIT" | "USER", "USER_INPUT" | "REQUEST") => {
                let text = tag_body(&content, "USER_REQUEST").unwrap_or(content);
                parsed.push_text("user", id, text, time);
                parsed.busy = Some(true);
            }
            ("MODEL", "PLANNER_RESPONSE") => {
                if let Some(model) = str_of(&line, "model") {
                    parsed.model = Some(model);
                }
                let used = line.get("input_tokens").and_then(Value::as_u64).unwrap_or(0)
                    + line.get("cache_read_tokens").and_then(Value::as_u64).unwrap_or(0)
                    + line.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
                if used > 0 {
                    parsed.context_used = Some(used);
                }
                if let Some(thinking) = str_of(&line, "thinking") {
                    parsed.push_text("reasoning", format!("{id}:think"), thinking, time.clone());
                }
                if !content.is_empty() {
                    parsed.push_text("assistant", format!("{id}:text"), content, time.clone());
                }
                let calls = line.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();
                for (ci, call) in calls.iter().enumerate() {
                    let call_id = format!("{id}:{ci}");
                    let name = str_of(call, "name").unwrap_or_else(|| "tool".into());
                    let args = decode_antigravity_args(call.get("args").unwrap_or(&Value::Null));
                    parsed.push_tool_with(call_id.clone(), name.clone(), tool_input_summary(&args), tool_structured(&name, &args), time.clone());
                    open_calls.push_back(call_id);
                }
                parsed.busy = Some(!calls.is_empty() || str_of(&line, "status").is_some_and(|s| s != "DONE"));
            }
            ("MODEL", "GENERIC") => {
                if let Some(call) = open_calls.pop_front() {
                    let output = antigravity_output(&content);
                    let failed = output.contains("exited with code") && !output.contains("exited with code 0");
                    parsed.finish_tool(&call, output, failed);
                }
                parsed.busy = Some(true);
            }
            _ => {}
        }
    }
    parsed
}

// ---------------------------------------------------------------------------
// GitHub Copilot CLI: <COPILOT_HOME>/session-state/<id>/events.jsonl
// ---------------------------------------------------------------------------

fn copilot_home() -> Option<PathBuf> {
    env_dir("COPILOT_HOME").or_else(|| home().map(|h| h.join(".copilot")))
}

pub(super) fn copilot_candidates(cwd: &str, since_ms: i64) -> Vec<Candidate> {
    let Some(base) = copilot_home() else { return Vec::new() };
    let Ok(entries) = fs::read_dir(base.join("session-state")) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let events = entry.path().join("events.jsonl");
        let Some((_, modified, _)) = file_times(&events) else { continue };
        if modified < since_ms - SINCE_SLACK_MS {
            continue;
        }
        if !copilot_session_cwd(&events).is_some_and(|c| same_dir(&c, cwd)) {
            continue;
        }
        if let Some(c) = candidate(entry.file_name().to_string_lossy().to_string(), events) {
            out.push(c);
        }
    }
    out
}

/// The launch folder from `session.start` (`data.context.cwd`), near the top of the file.
fn copilot_session_cwd(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(20).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) == Some("session.start") {
            let context = v.pointer("/data/context")?;
            return str_of(context, "cwd").or_else(|| str_of(context, "gitRoot"));
        }
    }
    None
}

pub(super) fn parse_copilot(path: &Path) -> Parsed {
    let mut parsed = Parsed::default();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let time = str_of(&line, "timestamp");
        let id = str_of(&line, "id").unwrap_or_else(|| format!("cp-{index}"));
        let data = line.get("data").cloned().unwrap_or(Value::Null);
        match line.get("type").and_then(Value::as_str).unwrap_or("") {
            "session.model_change" => parsed.model = str_of(&data, "newModel").or(parsed.model.take()),
            "user.message" => {
                parsed.push_text("user", id, str_of(&data, "content").unwrap_or_default(), time);
                parsed.busy = Some(true);
            }
            "assistant.reasoning" => parsed.push_text("reasoning", id, str_of(&data, "content").unwrap_or_default(), time),
            "assistant.message" => {
                parsed.push_text("assistant", id.clone(), str_of(&data, "content").unwrap_or_default(), time.clone());
                let requests = data.get("toolRequests").and_then(Value::as_array).cloned().unwrap_or_default();
                for (ri, request) in requests.iter().enumerate() {
                    let call = str_of(request, "toolCallId").unwrap_or_else(|| format!("{id}:{ri}"));
                    let name = str_of(request, "name").unwrap_or_else(|| "tool".into());
                    let raw = request.get("arguments").unwrap_or(&Value::Null);
                    parsed.push_tool_with(call, name.clone(), tool_input_summary(raw), tool_structured(&name, raw), time.clone());
                }
                parsed.busy = Some(!requests.is_empty());
            }
            "tool.execution_start" => {
                let call = str_of(&data, "toolCallId").unwrap_or_else(|| id.clone());
                if !parsed.items.iter().any(|i| i.kind == "tool" && i.id == call) {
                    let name = str_of(&data, "toolName").unwrap_or_else(|| "tool".into());
                    let raw = data.get("arguments").unwrap_or(&Value::Null);
                    parsed.push_tool_with(call, name.clone(), tool_input_summary(raw), tool_structured(&name, raw), time);
                }
                parsed.busy = Some(true);
            }
            "tool.execution_complete" => {
                let call = str_of(&data, "toolCallId").unwrap_or_default();
                let result = data.get("result").cloned().unwrap_or(Value::Null);
                let output = str_of(&result, "content").or_else(|| str_of(&result, "detailedContent")).unwrap_or_else(|| value_text(&result));
                let failed = data.get("success").and_then(Value::as_bool) == Some(false);
                parsed.finish_tool(&call, output, failed);
            }
            "assistant.turn_end" | "session.idle" | "abort" => parsed.busy = Some(false),
            "session.compaction_complete" => parsed.push_text("notice", id, "Conversation compacted".into(), time),
            "session.error" => {
                if let Some(message) = str_of(&data, "message") {
                    parsed.push_text("notice", id, clip(&message, 600), time);
                }
            }
            _ => {}
        }
    }
    parsed
}

// ---------------------------------------------------------------------------
// Cursor Agent: ~/.cursor/projects/<folder>/agent-transcripts/*.jsonl
// ---------------------------------------------------------------------------

pub(super) fn cursor_candidates(cwd: &str) -> Vec<Candidate> {
    let Some(root) = home().map(|h| h.join(".cursor").join("projects")) else { return Vec::new() };
    let trimmed = cwd.trim_end_matches(['\\', '/']);
    // Cursor names a project folder after its path with separators as dashes; the
    // drive colon and leading separator are dropped, unlike Claude's encoding.
    let dashed: String = trimmed.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let squeezed = dashed.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for name in [squeezed, dashed.trim_start_matches('-').to_string(), dashed] {
        if !seen.insert(name.to_lowercase()) {
            continue;
        }
        let Some(dir) = find_dir_ci(&root, &name) else { continue };
        out.extend(jsonl_candidates_in(&dir, "agent-transcripts"));
    }
    out
}

pub(super) fn parse_cursor(path: &Path) -> Parsed {
    let mut parsed = Parsed::default();
    for (index, line) in read_lines(path).into_iter().enumerate() {
        let time = str_of(&line, "timestamp");
        let id = str_of(&line, "id").unwrap_or_else(|| format!("cu-{index}"));
        let role = str_of(&line, "role").unwrap_or_default();
        let content = line.pointer("/message/content").or_else(|| line.get("content")).cloned().unwrap_or(Value::Null);
        match role.as_str() {
            "user" => {
                let mut words = Vec::new();
                match &content {
                    Value::String(s) => words.push(s.clone()),
                    Value::Array(blocks) => {
                        for block in blocks {
                            match block.get("type").and_then(Value::as_str) {
                                Some("text") => words.push(str_of(block, "text").unwrap_or_default()),
                                Some("tool_result") => {
                                    let call = str_of(block, "tool_use_id").unwrap_or_default();
                                    let error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                                    parsed.finish_tool(&call, value_text(block.get("content").unwrap_or(&Value::Null)), error);
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                let text = words.join("\n");
                // Cursor wraps the prompt with context; the user's words are in <user_query>.
                let text = tag_body(&text, "user_query").unwrap_or(text);
                if !text.trim().is_empty() {
                    parsed.push_text("user", id, text, time);
                    parsed.busy = Some(true);
                }
            }
            "assistant" => {
                let mut calls = 0;
                match &content {
                    Value::String(s) => parsed.push_text("assistant", id.clone(), s.clone(), time.clone()),
                    Value::Array(blocks) => {
                        for (bi, block) in blocks.iter().enumerate() {
                            let bid = format!("{id}:{bi}");
                            match block.get("type").and_then(Value::as_str) {
                                Some("text") => parsed.push_text("assistant", bid, str_of(block, "text").unwrap_or_default(), time.clone()),
                                Some("thinking" | "reasoning") => {
                                    let text = str_of(block, "thinking").or_else(|| str_of(block, "text")).unwrap_or_default();
                                    parsed.push_text("reasoning", bid, text, time.clone());
                                }
                                Some("tool_use" | "tool_call") => {
                                    calls += 1;
                                    let call = str_of(block, "id").unwrap_or(bid);
                                    let name = str_of(block, "name").unwrap_or_else(|| "tool".into());
                                    let raw = block.get("input").or_else(|| block.get("arguments")).unwrap_or(&Value::Null);
                                    parsed.push_tool_with(call, name.clone(), tool_input_summary(raw), tool_structured(&name, raw), time.clone());
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                parsed.busy = Some(calls > 0);
            }
            _ => {}
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(name: &str, lines: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spacron-transcripts-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, lines.join("\n")).unwrap();
        path
    }

    #[test]
    fn pi_folder_names_match_the_cli() {
        assert_eq!(pi_dir_name(r"C:\Users\SMIDS MAN"), "--C--Users-SMIDS MAN--");
        assert_eq!(pi_dir_name("/home/me/proj/"), "--home-me-proj--");
    }

    #[test]
    fn reads_pi_sessions() {
        let path = write_temp("pi.jsonl", &[
            r#"{"type":"session","version":3,"id":"s1","cwd":"C:\\x"}"#,
            r#"{"type":"model_change","id":"m","provider":"openrouter","modelId":"kimi-k2"}"#,
            r#"{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"list files"}]}}"#,
            r#"{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"use ls"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls"}}],"stopReason":"toolUse","usage":{"totalTokens":1200}}}"#,
            r#"{"type":"message","id":"r1","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"a.txt"}],"isError":false}}"#,
            r#"{"type":"message","id":"a2","message":{"role":"assistant","content":[{"type":"text","text":"One file."}],"stopReason":"stop"}}"#,
        ]);
        let parsed = parse_pi(&path);
        let kinds: Vec<_> = parsed.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "reasoning", "tool", "assistant"]);
        assert_eq!(parsed.items[2].tool_output.as_deref(), Some("a.txt"));
        assert_eq!(parsed.busy, Some(false));
        assert_eq!(parsed.model.as_deref(), Some("kimi-k2"));
        assert_eq!(parsed.context_used, Some(1200));
    }

    #[test]
    fn maps_antigravity_conversations_from_the_newer_cache() {
        let base = std::env::temp_dir().join(format!("spacron-agy-{}", std::process::id()));
        fs::create_dir_all(base.join("cache")).unwrap();
        // Newer CLIs: no conversationId in history.jsonl, the link is in the cache.
        fs::write(base.join("history.jsonl"), "{\"display\":\"hi\",\"workspace\":\"C:\\\\work\\\\app\"}\n").unwrap();
        fs::write(base.join("cache").join("last_conversations.json"), r#"{ "C:\\work\\app": "abc-123" }"#).unwrap();
        let map = antigravity_workspaces(&base);
        assert_eq!(map.get("abc-123").map(String::as_str), Some("C:\\work\\app"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn reads_antigravity_transcripts() {
        let path = write_temp("ag.jsonl", &[
            r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>\ninstall codex\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"}"#,
            r#"{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","model":"gemini","thinking":"run npm","tool_calls":[{"name":"run_command","args":{"CommandLine":"\"npm i -g codex\""}}]}"#,
            r#"{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","content":"Created At: x\nCommand exited with code 1.\nnpm failed"}"#,
            r#"{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"It failed."}"#,
        ]);
        let parsed = parse_antigravity(&path);
        let kinds: Vec<_> = parsed.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "reasoning", "tool", "assistant"]);
        assert_eq!(parsed.items[0].text, "install codex");
        assert_eq!(parsed.items[2].tool_input.as_deref(), Some("npm i -g codex"));
        assert_eq!(parsed.items[2].tool_status.as_deref(), Some("error"));
        assert_eq!(parsed.busy, Some(false));
    }

    #[test]
    fn reads_copilot_events() {
        let path = write_temp("cp.jsonl", &[
            r#"{"type":"session.start","data":{"sessionId":"s","context":{"cwd":"C:\\proj"}}}"#,
            r#"{"type":"user.message","data":{"content":"fix it"}}"#,
            r#"{"type":"assistant.message","data":{"content":"Looking.","toolRequests":[{"toolCallId":"t1","name":"bash","arguments":{"command":"ls"}}]}}"#,
            r#"{"type":"tool.execution_complete","data":{"toolCallId":"t1","success":true,"result":{"content":"a.rs"}}}"#,
            r#"{"type":"assistant.message","data":{"content":"Done."}}"#,
            r#"{"type":"assistant.turn_end","data":{}}"#,
        ]);
        assert_eq!(copilot_session_cwd(&path).as_deref(), Some(r"C:\proj"));
        let parsed = parse_copilot(&path);
        let kinds: Vec<_> = parsed.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "assistant", "tool", "assistant"]);
        assert_eq!(parsed.items[2].tool_output.as_deref(), Some("a.rs"));
        assert_eq!(parsed.busy, Some(false));
    }

    #[test]
    fn reads_cursor_transcripts() {
        let path = write_temp("cu.jsonl", &[
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\nhi there\n</user_query>"}]}}"#,
            r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Hello."}]}}"#,
        ]);
        let parsed = parse_cursor(&path);
        assert_eq!(parsed.items[0].text, "hi there");
        assert_eq!(parsed.items[1].kind, "assistant");
        assert_eq!(parsed.busy, Some(false));
    }
}
