//! Agents the box starts on its own: `spawn_agent` and the delegation tools
//! (`delegate_task`, `check_task`, `bounce_task`, `report_status`) of the box's
//! MCP server (`box_mcp.rs`), so agents and bots on a box can start and manage
//! other agents while the laptop is closed.
//!
//! On the desktop these tools live in the app, which owns the panes. Here
//! the box owns the terminals: each agent runs in a box terminal that the
//! desktop picks up as a normal pane when it connects (`box_agents_list`).
//!
//! The desktop tells the box which agents exist and which MCP servers they
//! should get (`box_agents_config_sync`). Claude Code gets them through
//! `--mcp-config`, Codex through `-c` overrides; the other CLIs read the
//! project and global configs the desktop already writes on the box.
//!
//! Files under `<workspace>/.spacron/`:
//! - `agents-config.json` — presets and MCP servers from the desktop (owner-only)
//! - `box-agents.json`    — the agents the box started, with their reports
//! - `agent-mcp/<name>.json` — each Claude agent's MCP config (owner-only)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::automations::{now_ms, read_json, write_json};
use super::ServerState;

const MAX_PROMPT: usize = 32_000;
const MAX_WAIT_SECONDS: u64 = 600;
const DEFAULT_WAIT_SECONDS: u64 = 25;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preset {
    /// The launch command, e.g. `claude` or `codex --model gpt-5`.
    pub command: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentsConfig {
    #[serde(default)]
    pub presets: Vec<Preset>,
    /// `mcpServers` entries for agents started here (Claude's shape).
    #[serde(default)]
    pub mcp_servers: serde_json::Map<String, Value>,
    /// Codex `-c` overrides for the same servers, built by the desktop.
    #[serde(default)]
    pub codex_flags: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRecord {
    pub id: u32,
    pub name: String,
    pub preset: String,
    pub cwd: String,
    pub started_at: u64,
    /// working | needs_input | done | failed, from `report_status`.
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub reported_at: Option<u64>,
}

fn dir(workspace: &Path) -> PathBuf {
    workspace.join(".spacron")
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn records(workspace: &Path) -> Vec<AgentRecord> {
    read_json(&dir(workspace).join("box-agents.json"))
}

fn save_records(workspace: &Path, list: &[AgentRecord]) {
    let _ = write_json(&dir(workspace).join("box-agents.json"), &list);
}

/// Change the records under the lock, dropping agents whose terminal is gone.
fn update(state: &ServerState, f: impl FnOnce(&mut Vec<AgentRecord>)) -> Vec<AgentRecord> {
    let _guard = lock().lock();
    let mut list = records(&state.workspace);
    let live: std::collections::HashSet<u32> = state.pty.list_ids().into_iter().collect();
    list.retain(|r| live.contains(&r.id));
    f(&mut list);
    save_records(&state.workspace, &list);
    list
}

fn config(workspace: &Path) -> AgentsConfig {
    read_json(&dir(workspace).join("agents-config.json"))
}

fn private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// `box_agents_config_sync`: which agents exist and the MCP servers they get.
pub(crate) fn config_sync(args: Value, workspace: &Path) -> Result<Value, String> {
    let cfg: AgentsConfig = serde_json::from_value(args).map_err(|e| format!("Invalid agent config: {e}"))?;
    if cfg.codex_flags.len() > 64 * 1024 || cfg.mcp_servers.len() > 200 {
        return Err("The agent config is too large.".into());
    }
    let path = dir(workspace).join("agents-config.json");
    write_json(&path, &cfg)?;
    private(&path);
    Ok(json!({ "ok": true, "presets": cfg.presets.len() }))
}

/// `box_agents_list`: agents the box started, for the desktop to show as panes.
pub(crate) fn list(state: &ServerState) -> Result<Value, String> {
    let list = update(state, |_| {});
    serde_json::to_value(list).map_err(|e| e.to_string())
}

/// The program name of a launch command (`/usr/bin/claude --x` -> `claude`).
pub(crate) fn program(command: &str) -> String {
    let exe = command.split_whitespace().next().unwrap_or("");
    let base = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    base.trim_end_matches(".exe").trim_end_matches(".cmd").to_ascii_lowercase()
}

/// A name that is safe as a file name and unique among the running agents.
fn agent_name(wanted: Option<&str>, preset: &str, taken: &[AgentRecord]) -> Result<String, String> {
    if let Some(w) = wanted.map(str::trim).filter(|w| !w.is_empty()) {
        let clean: String = w.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
        let clean = clean.trim_matches('-').chars().take(40).collect::<String>();
        if clean.is_empty() {
            return Err("Pick a name with letters or digits.".into());
        }
        if taken.iter().any(|r| r.name.eq_ignore_ascii_case(&clean)) {
            return Err(format!("An agent named {clean} is already running."));
        }
        return Ok(clean);
    }
    let base = program(preset);
    let base = if base.is_empty() { "agent".to_string() } else { base };
    (1..1000).map(|n| format!("{base}-{n}")).find(|n| !taken.iter().any(|r| r.name.eq_ignore_ascii_case(n)))
        .ok_or_else(|| "Too many agents are running.".to_string())
}

/// The full command line typed into the agent's terminal: the preset, plus
/// the MCP servers it gets (Claude via a config file, Codex via `-c`).
pub(crate) fn launch_line(preset: &str, mcp_file: Option<&Path>, codex_flags: &str, box_url: Option<&str>) -> String {
    let mut line = preset.trim().to_string();
    match program(preset).as_str() {
        "claude" => {
            if let Some(file) = mcp_file {
                line.push_str(&format!(" --mcp-config \"{}\"", file.display()));
            }
        }
        "codex" => {
            if !codex_flags.trim().is_empty() {
                line.push(' ');
                line.push_str(codex_flags.trim());
            }
            if let Some(url) = box_url.filter(|u| !u.contains('\'')) {
                line.push_str(&format!(" -c 'mcp_servers.spacron-box.url=\"{url}\"'"));
            }
        }
        _ => {}
    }
    line
}

/// What a delegated worker is told on top of its task.
pub(crate) fn worker_instructions(name: &str) -> String {
    format!("\n\nWhen you have finished, call the report_status tool of the spacron-box MCP server with agent \"{name}\", \
state \"done\" and a short summary of what you did. If you are blocked and need the user, call it with state \"needs_input\"; \
if you cannot complete the task, with state \"failed\".")
}

fn git_worktree(cwd: &Path, name: &str) -> Result<PathBuf, String> {
    let path = cwd.join(".spacron").join("worktrees").join(name);
    let out = std::process::Command::new("git").arg("-C").arg(cwd)
        .args(["worktree", "add", "-b", &format!("spacron/{name}")]).arg(&path).output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if !out.status.success() {
        return Err(format!("Could not create a worktree (is this folder a git repository?): {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(path)
}

/// A terminal output sink nobody reads: output is still kept in the session's
/// replay buffer, which is what the desktop gets when it attaches.
struct Nowhere;
impl crate::pty::session::DataSink for Nowhere {
    fn send_data(&self, _: &[u8]) -> bool { false }
}
impl crate::pty::session::ExitSink for Nowhere {
    fn send_exit(&self, _: i32) -> bool { false }
}

/// Start an agent in a new box terminal; returns its record.
pub(crate) fn spawn(state: &ServerState, args: &Value) -> Result<AgentRecord, String> {
    let cfg = config(&state.workspace);
    let preset = args.get("preset").and_then(|v| v.as_str()).map(str::trim).filter(|p| !p.is_empty()).ok_or("Choose which agent to start (preset).")?.to_string();
    // Only agents the desktop listed, or a known agent CLI by name: never an arbitrary command line.
    let known = cfg.presets.iter().any(|p| p.command.trim() == preset)
        || (cfg.presets.is_empty() && ["claude", "codex", "gemini", "opencode", "droid", "agy", "qwen", "cursor-agent", "amp"].contains(&preset.as_str()));
    if !known {
        let names: Vec<&str> = cfg.presets.iter().map(|p| p.command.as_str()).collect();
        return Err(format!("Unknown agent '{preset}'. Available: {}.", if names.is_empty() { "claude, codex, gemini, opencode".to_string() } else { names.join(", ") }));
    }
    let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if prompt.len() > MAX_PROMPT {
        return Err(format!("Keep the prompt under {MAX_PROMPT} characters."));
    }
    let taken = update(state, |_| {});
    let name = agent_name(args.get("name").and_then(|v| v.as_str()), &preset, &taken)?;
    let root = super::active_root(state);
    let cwd = match args.get("workspace").and_then(|v| v.as_str()).unwrap_or("main") {
        "new_worktree" => git_worktree(&root, &name)?,
        "existing" => {
            let wt = args.get("worktree").and_then(|v| v.as_str()).ok_or("Give the worktree to use.")?;
            let path = std::fs::canonicalize(root.join(wt)).map_err(|_| format!("No worktree at {wt}."))?;
            if !path.starts_with(&root) || !path.is_dir() {
                return Err("That worktree is not inside the project.".into());
            }
            path
        }
        _ => root.clone(),
    };
    // Each Claude agent gets its own config, with the box tools under its name
    // so report_status knows who is calling.
    let box_url = super::box_proxy::mcp_url().map(|u| format!("{u}&agent={name}"));
    let mcp_file = if program(&preset) == "claude" {
        let mut servers = cfg.mcp_servers.clone();
        if let Some(url) = &box_url {
            servers.insert("spacron-box".into(), json!({ "type": "http", "url": url }));
        }
        let path = dir(&state.workspace).join("agent-mcp").join(format!("{name}.json"));
        std::fs::create_dir_all(path.parent().ok_or("Bad path.")?).map_err(|e| e.to_string())?;
        std::fs::write(&path, serde_json::to_vec_pretty(&json!({ "mcpServers": servers })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        private(&path);
        Some(path)
    } else {
        None
    };
    let line = launch_line(&preset, mcp_file.as_deref(), &cfg.codex_flags, box_url.as_deref());

    let shell = super::select_shell(None);
    let id = state.pty.reserve_id();
    let session = crate::pty::session::spawn(120, 32, shell, cwd.to_string_lossy().to_string(), Box::new(Nowhere), Box::new(Nowhere), None)?;
    session.write(&format!("{line}\r"))?;
    state.pty.insert_with_id(id, session.clone());

    let record = AgentRecord { id, name: name.clone(), preset: preset.clone(), cwd: cwd.to_string_lossy().to_string(), started_at: now_ms(), state: "working".into(), summary: None, reported_at: None };
    update(state, |list| list.push(record.clone()));

    // Give the prompt once the agent has started up: its output has been
    // quiet for a moment after it printed something (at most ~25s).
    if !prompt.trim().is_empty() {
        std::thread::spawn(move || {
            let mut last_len = 0usize;
            let mut quiet = 0u32;
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(250));
                let len = session.output_tail(1 << 20).len();
                if len > 0 && len == last_len { quiet += 1 } else { quiet = 0 }
                last_len = len;
                if quiet >= 6 && len > 0 {
                    break;
                }
            }
            let text = if prompt.contains('\n') { format!("\x1b[200~{prompt}\x1b[201~") } else { prompt };
            let _ = session.write(&text);
            std::thread::sleep(Duration::from_millis(150));
            let _ = session.write("\r");
        });
    }
    Ok(record)
}

/// Find an agent by name or id.
pub(crate) fn find(state: &ServerState, who: &str) -> Option<AgentRecord> {
    let list = update(state, |_| {});
    let who = who.trim();
    list.into_iter().find(|r| r.name.eq_ignore_ascii_case(who) || r.id.to_string() == who)
}

/// Record a worker's status.
pub(crate) fn report(state: &ServerState, agent: &str, status: &str, summary: Option<String>) -> Result<String, String> {
    if !["working", "needs_input", "done", "failed"].contains(&status) {
        return Err("state must be working, needs_input, done or failed.".into());
    }
    let mut found = false;
    update(state, |list| {
        if let Some(r) = list.iter_mut().find(|r| r.name.eq_ignore_ascii_case(agent.trim()) || r.id.to_string() == agent.trim()) {
            r.state = status.into();
            r.summary = summary.clone();
            r.reported_at = Some(now_ms());
            found = true;
        }
    });
    Ok(if found { format!("Recorded: {agent} is {status}.") } else { "Noted.".into() })
}

/// Wait for a worker to finish, block, fail or exit; returns its record.
pub(crate) fn wait(state: &ServerState, name: &str, seconds: u64) -> Result<(AgentRecord, bool), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds.min(MAX_WAIT_SECONDS));
    loop {
        let Some(rec) = find(state, name) else {
            return Err(format!("{name} is not running any more."));
        };
        let exited = state.pty.get(rec.id).is_none_or(|s| s.has_exited());
        if exited || ["done", "failed", "needs_input"].contains(&rec.state.as_str()) {
            return Ok((rec, exited));
        }
        if std::time::Instant::now() >= deadline {
            return Ok((rec, false));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// The wait time a tool call asked for.
pub(crate) fn wait_seconds(args: &Value) -> u64 {
    args.get("wait_seconds").and_then(|v| v.as_f64()).map(|v| v.max(0.0) as u64).unwrap_or(DEFAULT_WAIT_SECONDS).min(MAX_WAIT_SECONDS)
}

/// Clear a worker's last report (before sending it back for another round).
pub(crate) fn clear_report(state: &ServerState, name: &str) {
    update(state, |list| {
        if let Some(r) = list.iter_mut().find(|r| r.name.eq_ignore_ascii_case(name)) {
            r.state = "working".into();
            r.summary = None;
            r.reported_at = None;
        }
    });
}

/// The presets for tool descriptions.
pub(crate) fn preset_names(workspace: &Path) -> Vec<String> {
    config(workspace).presets.into_iter().map(|p| if p.name.is_empty() || p.name == p.command { p.command } else { format!("{} ({})", p.command, p.name) }).collect()
}

pub(crate) fn guide() -> &'static str {
    crate::mcp::PLUGIN_CREATOR_GUIDE
}

#[allow(dead_code)]
fn _assert_send(_: HashMap<u32, AgentRecord>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_lines_carry_each_agents_servers() {
        let line = launch_line("claude --verbose", Some(Path::new("/w/.spacron/agent-mcp/claude-1.json")), "", Some("http://x"));
        assert_eq!(line, "claude --verbose --mcp-config \"/w/.spacron/agent-mcp/claude-1.json\"");
        let codex = launch_line("codex", None, "-c 'mcp_servers.spacron-gmail.url=\"u\"'", Some("http://127.0.0.1:1/mcp?token=t&agent=codex-1"));
        assert_eq!(codex, "codex -c 'mcp_servers.spacron-gmail.url=\"u\"' -c 'mcp_servers.spacron-box.url=\"http://127.0.0.1:1/mcp?token=t&agent=codex-1\"'");
        assert_eq!(launch_line("gemini", None, "-c x", Some("u")), "gemini", "other CLIs read their config files");
        assert_eq!(program("C:\\tools\\codex.cmd --x"), "codex");
    }

    #[test]
    fn names_are_unique_and_safe() {
        let taken = vec![AgentRecord { name: "claude-1".into(), ..Default::default() }];
        assert_eq!(agent_name(None, "claude", &taken).unwrap(), "claude-2");
        assert_eq!(agent_name(Some("my worker!/../x"), "claude", &taken).unwrap(), "my-worker-----x");
        assert!(agent_name(Some("CLAUDE-1"), "claude", &taken).is_err());
        assert!(agent_name(Some("!!!"), "claude", &taken).is_err());
    }

    #[test]
    fn the_worker_is_told_how_to_report() {
        let text = worker_instructions("codex-2");
        assert!(text.contains("report_status") && text.contains("agent \"codex-2\"") && text.contains("\"done\""));
    }
}
