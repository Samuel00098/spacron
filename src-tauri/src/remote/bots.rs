//! Bots: agents that live outside every project and work for you on a
//! schedule or on demand.
//!
//! The same runner serves two hosts:
//! - **a box** (`spacron-server`), so bots keep working while the laptop is
//!   closed — reached through the server's invoke dispatch (`box_bot*`);
//! - **this PC**, for people without a box yet — the desktop app runs the same
//!   loop in-process over its own folder (`commands/local_bots.rs`).
//!
//! A bot is an automation that is not tied to a project folder. Each bot gets
//! its own home folder, which persists between runs, so a bot can keep notes,
//! drafts and results from one run to the next. Agents are the installed CLIs
//! in their CLI's headless mode.
//!
//! Scheduling works exactly like automations (see `automations.rs`): the
//! desktop owns the schedule language and the time zone, so it sends each
//! bot's upcoming run times as epoch milliseconds and the runner only notices
//! that a time has passed.
//!
//! Files, all under `<root>/.spacron/bots/`:
//! - `bots.json`  — what the desktop last synced
//! - `mcp.json`   — the MCP servers bots may use (`--mcp-config`)
//! - `runs.json`  — run records, newest first
//! - `fired.json` — the last occurrence handled per bot
//! - `logs/<run id>.log`
//! - `home/<bot id>/` — the bot's own working folder

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;

use super::automations::{agent_command, due, now_ms, read_json, spawn_headless, write_json, STOPPED_BY_USER};

const TICK: Duration = Duration::from_secs(30);
const MAX_RUNS: usize = 300;
/// The most of a log `log` sends back; the start is trimmed.
const MAX_LOG_BYTES: usize = 64 * 1024;
const MAX_INSTRUCTIONS: usize = 20_000;
const MAX_MCP_CONFIG: usize = 256 * 1024;
const MAX_MESSAGE: usize = 8_000;
/// One attached file, after decoding.
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 10;
/// Images sent back for chat thumbnails.
const MAX_PREVIEW_BYTES: u64 = 3 * 1024 * 1024;
/// The box's own MCP server key (`box_mcp.rs`) and its tools.
pub(crate) const BOX_TOOLS_KEY: &str = "spacron-box";
/// Spacron's own MCP server on the desktop (`spacron-mcp`) and its desktop
/// tools (computer use on this PC, Windows; see docs/computer-use.md).
pub(crate) const SPACRON_TOOLS_KEY: &str = "spacron-mcp";
const PC_DESKTOP_TOOLS: [&str; 10] = [
    "desktop_list_windows", "desktop_ui_tree", "desktop_screenshot", "desktop_find", "desktop_click",
    "desktop_type", "desktop_key", "desktop_scroll", "desktop_drag", "desktop_focus_window",
];
const BOX_DESKTOP_TOOLS: [&str; 7] = [
    "desktop_screenshot", "desktop_list_windows", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll", "desktop_launch",
];
const BOX_TOOLS: &[&str] = &[
    "list_agents", "read_agent_output", "send_to_agent", "report_status", "plugin_creator_guide",
    "spawn_agent", "delegate_task", "check_task", "bounce_task",
    "desktop_screenshot", "desktop_list_windows", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll", "desktop_launch",
];
/// Box tools that start programs or agents, which could hold more access
/// than the bot itself: Full access only.
const FULL_ONLY_TOOLS: &[&str] = &["desktop_launch", "spawn_agent", "delegate_task", "check_task", "bounce_task"];
/// How much of the conversation each run sees: the last few exchanges, each
/// reply trimmed to its end.
const CONTEXT_RUNS: usize = 6;
const CONTEXT_REPLY_CHARS: usize = 1_500;
/// Bot Builder limits per run.
const MAX_PROPOSALS: usize = 10;
const MAX_PROPOSAL_BYTES: u64 = 32 * 1024;

/// What a bot may do on its own. Nobody is there to approve anything, so the
/// level is decided up front and turned into each CLI's own flags.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Access {
    /// Read, search the web and use connectors; never write files.
    #[default]
    Research,
    /// Also create and edit files, inside its own home folder.
    Folder,
    /// Everything, commands included. The CLI's "skip all permissions" mode.
    Full,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoxBot {
    pub id: String,
    pub name: String,
    pub instructions: String,
    /// The agent's launch command as the desktop knows it, e.g. `claude`.
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Whether the schedule fires. Run now works either way.
    pub enabled: bool,
    /// Upcoming run times, epoch ms, ascending. Empty for a manual-only bot.
    #[serde(default)]
    pub occurrences: Vec<u64>,
    #[serde(default)]
    pub access: Access,
    /// Give the agent the synced MCP servers (`mcp.json`).
    #[serde(default)]
    pub connectors: bool,
    /// Which of the synced MCP servers this bot gets (config keys). `None`
    /// means all of them when `connectors` is on (bots saved before the picker).
    #[serde(default)]
    pub mcp_keys: Option<Vec<String>>,
    /// May create other bots (see [`collect_proposals`]).
    #[serde(default)]
    pub can_create_bots: bool,
    /// May use the desktop tools (`desktop_*`): the box's virtual desktop,
    /// or this PC's screen through Spacron's own tools.
    #[serde(default)]
    pub computer_use: bool,
    /// Extra context the desktop adds to the prompt (the Bot Builder gets the
    /// connectors, agents and avatars it may choose from).
    #[serde(default)]
    pub extra_context: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BotsConfig {
    #[serde(default)]
    pub bots: Vec<BoxBot>,
    /// Master switch: when off, no schedule fires.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// How late a run may still start; 0 means only on time (one tick of slack).
    #[serde(default = "fifteen")]
    pub catch_up_minutes: u64,
    /// A run still going after this long is stopped.
    #[serde(default = "sixty")]
    pub max_run_minutes: u64,
    /// `{ "mcpServers": { … } }`, written to `mcp.json`. Not kept in `bots.json`.
    #[serde(default, skip_serializing)]
    pub mcp_config: Option<String>,
}

fn yes() -> bool { true }
fn fifteen() -> u64 { 15 }
fn sixty() -> u64 { 60 }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BotRun {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub started_at: u64,
    #[serde(default)]
    pub finished_at: Option<u64>,
    /// running | completed | failed | stopped | missed | interrupted
    pub status: String,
    /// manual | schedule | chat
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// Root-relative log path.
    #[serde(default)]
    pub log: Option<String>,
    /// The chat message that started this run, if the user sent one.
    #[serde(default)]
    pub message: Option<String>,
    /// Files the user attached to that message, relative to the bot's home.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
}

fn dir(root: &Path) -> PathBuf {
    root.join(".spacron").join("bots")
}

/// A bot's own working folder. Ids are checked by [`valid_id`] before they
/// reach a path, so this never escapes `home/`.
fn home(root: &Path, bot_id: &str) -> PathBuf {
    dir(root).join("home").join(bot_id)
}

/// Ids become folder names, so only plain characters are allowed.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// One writer at a time for the JSON files: the tick loop and `run now` both touch them.
fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Stop signals for runs in progress, by run id.
fn running() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

fn update_runs(root: &Path, f: impl FnOnce(&mut Vec<BotRun>)) {
    let _guard = file_lock().lock();
    let path = dir(root).join("runs.json");
    let mut runs: Vec<BotRun> = read_json(&path);
    f(&mut runs);
    runs.truncate(MAX_RUNS);
    let _ = write_json(&path, &runs);
}

fn finish(root: &Path, run_id: &str, status: &str, detail: Option<String>) {
    update_runs(root, |runs| {
        if let Some(r) = runs.iter_mut().find(|r| r.id == run_id && r.status == "running") {
            r.status = status.into();
            r.finished_at = Some(now_ms());
            r.detail = detail;
        }
    });
}

/// What the agent is told on every run: who it is, that its folder persists,
/// what it may do, and that nobody is there to answer questions.
pub(crate) fn bot_prompt(bot: &BoxBot) -> String {
    let access = match bot.access {
        Access::Research => "You may read, search the web and use your tools, but you cannot create or change files, \
so put the full result in your final answer.",
        Access::Folder => "You may create and edit files in your home folder; save results there as files.",
        Access::Full => "You have full access, including running commands. Stay inside your home folder unless the job says otherwise.",
    };
    format!(
        "You are \"{name}\", a Spacron bot running unattended. \
Your current folder is your own home folder and it persists between runs: anything kept there (for example a \
NOTES.md file) is still there next time. {access} Nobody is watching this run, so do not wait for input or ask \
questions; do the work and finish with a short summary of what you did.\n\nYour job:\n{instructions}",
        name = bot.name.trim(),
        instructions = bot.instructions.trim(),
    )
}

/// The end of a run's output, for the conversation the next run sees.
fn reply_tail(root: &Path, run: &BotRun) -> String {
    let text = run.log.as_deref().and_then(|l| std::fs::read(root.join(l)).ok())
        .map(|b| String::from_utf8_lossy(&b).trim().to_string()).unwrap_or_default();
    if text.chars().count() <= CONTEXT_REPLY_CHARS {
        return text;
    }
    let skip = text.chars().count() - CONTEXT_REPLY_CHARS;
    format!("…{}", text.chars().skip(skip).collect::<String>())
}

/// The recent conversation with this bot, oldest first: each finished run's
/// message (if the user sent one) and the end of what the bot answered.
fn conversation(root: &Path, bot_id: &str, skip_run: &str) -> String {
    let runs: Vec<BotRun> = read_json(&dir(root).join("runs.json"));
    let mut recent: Vec<&BotRun> = runs.iter()
        .filter(|r| r.bot_id == bot_id && r.id != skip_run && r.status == "completed")
        .take(CONTEXT_RUNS)
        .collect();
    recent.reverse();
    let mut out = String::new();
    for run in recent {
        match run.message.as_deref() {
            Some(m) => out.push_str(&format!("User: {}\n", m.trim())),
            None => out.push_str(&format!("({} run)\n", if run.trigger == "schedule" { "Scheduled" } else { "Manual" })),
        }
        let reply = reply_tail(root, run);
        if !reply.is_empty() {
            out.push_str(&format!("You: {reply}\n"));
        }
        out.push('\n');
    }
    out
}

/// Everything one run is told: who it is and its job, what it may do, what
/// has been said so far, and the user's new message if there is one.
#[cfg(test)]
pub(crate) fn run_prompt(bot: &BoxBot, history: &str, message: Option<&str>) -> String {
    run_prompt_with(bot, history, message, &[])
}

/// [`run_prompt`] plus the files the user attached to the message.
pub(crate) fn run_prompt_with(bot: &BoxBot, history: &str, message: Option<&str>, attachments: &[String]) -> String {
    let mut prompt = bot_prompt(bot);
    if bot.can_create_bots {
        prompt.push_str(BUILDER_PROMPT);
    }
    if let Some(extra) = bot.extra_context.as_deref().filter(|e| !e.trim().is_empty()) {
        prompt.push_str("\n\n");
        prompt.push_str(extra.trim());
    }
    if !history.trim().is_empty() {
        prompt.push_str("\n\nRecent conversation with the user, oldest first:\n");
        prompt.push_str(history.trim_end());
    }
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        prompt.push_str("\n\nThe user just sent you this message. Answer them directly, using your job and the conversation as context:\n");
        prompt.push_str(m.trim());
    }
    if !attachments.is_empty() {
        prompt.push_str("\n\nThe user attached these files, saved in your folder (paths relative to it). Open them with your tools; images can be read directly:\n");
        for a in attachments {
            prompt.push_str(&format!("- {a}\n"));
        }
    }
    prompt
}

const BUILDER_PROMPT: &str = "\n\nYou can create new bots for the user. To create one, write a JSON file in the \
new-bots folder of your home folder (for example new-bots/morning-digest.json), one file per bot, with these fields: \
\"name\" (short), \"instructions\" (that bot's standing job, written as instructions to it), \"schedule\" \
(\"manual\", \"hourly\", \"daily\", \"weekdays\" or \"weekly\"), \"time\" (\"HH:MM\"), \"day\" (0 = Sunday, for weekly), \
\"access\" (\"research\", \"folder\" or \"full\"; never more than your own access), \"browser\" (true if it needs to open \
and use web pages), \"connectors\" (a list of connector names it needs, from the ones listed below), \"avatar\" \
(one of the avatar names listed below) and \"agent\" (optional, one of the agents listed below). Spacron adds each \
bot for the user right after this run, with its schedule off until the user turns it on. Ask the user a question \
instead if you do not know enough to write a good bot, and tell them which bots you created.";

/// The MCP server keys in an `mcp.json` body.
#[cfg(test)]
fn mcp_keys(config: &str) -> Vec<String> {
    serde_json::from_str::<Value>(config)
        .ok()
        .and_then(|v| v.get("mcpServers").and_then(|s| s.as_object()).map(|m| m.keys().cloned().collect()))
        .unwrap_or_default()
}

/// Bot-only launch modes. Box Automations keep their existing supported agents.
fn bot_agent_command(agent: &str, prompt: &str, model: Option<&str>) -> Result<Vec<String>, String> {
    let mut parts = agent.split_whitespace();
    let exe = parts.next().ok_or("No agent chosen.")?;
    let name = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    let name = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_ascii_lowercase();
    let (mode, model_flag, prompt_flag) = match name.as_str() {
        "agy" => (None, Some("--model"), Some("--print")),
        "pi" | "cursor-agent" => (Some("--print"), Some("--model"), None),
        "grok" => (None, Some("--model"), Some("--single")),
        "dsh" => (Some("headless"), None, None),
        "kilo" => (Some("run"), Some("--model"), None),
        _ => return agent_command(agent, prompt, model),
    };
    let mut argv = vec![exe.to_owned()];
    argv.extend(parts.map(str::to_owned));
    argv.extend(mode.map(str::to_owned));
    if let (Some(flag), Some(model)) = (model_flag, model.filter(|m| !m.is_empty() && *m != "default")) {
        argv.extend([flag.to_owned(), model.to_owned()]);
    }
    argv.extend(prompt_flag.map(str::to_owned));
    argv.push(prompt.to_owned());
    Ok(argv)
}

/// The run's connectors as Codex `-c mcp_servers.<key>.…` overrides. Codex has
/// no `--mcp-config`; it reads servers from `~/.codex/config.toml`, but accepts
/// the same keys per launch. Args are passed as argv, so no shell quoting.
///
/// Codex speaks only streamable HTTP, so Spacron's own SSE address is swapped
/// for its `/mcp` twin (same port and token), and a server that needs custom
/// headers is skipped: Codex cannot carry them (the desktop's agent launcher
/// skips the same ones).
fn codex_mcp_flags(path: &Path) -> Vec<String> {
    let Some(servers) = std::fs::read_to_string(path).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("mcpServers").and_then(|s| s.as_object()).cloned()) else { return Vec::new() };
    let toml = |v: &str| serde_json::to_string(v).unwrap_or_default();
    let mut flags: Vec<String> = Vec::new();
    let mut add = |key: &str, field: &str, value: String| {
        flags.extend(["-c".to_string(), format!("mcp_servers.{key}.{field}={value}")]);
    };
    for (key, server) in &servers {
        // A key outside bare-TOML characters would need quoting; skip it.
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            continue;
        }
        if let Some(command) = server.get("command").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) {
            add(key, "command", toml(command.trim()));
            let args: Vec<String> = server.get("args").and_then(Value::as_array).into_iter().flatten()
                .filter_map(Value::as_str).map(toml).collect();
            if !args.is_empty() {
                add(key, "args", format!("[{}]", args.join(", ")));
            }
            let env: Vec<String> = server.get("env").and_then(Value::as_object).into_iter().flatten()
                .filter_map(|(k, v)| v.as_str().map(|v| format!("{} = {}", toml(k), toml(v)))).collect();
            if !env.is_empty() {
                add(key, "env", format!("{{ {} }}", env.join(", ")));
            }
        } else if let Some(url) = server.get("url").and_then(Value::as_str).filter(|u| !u.trim().is_empty()) {
            if server.get("headers").and_then(Value::as_object).is_some_and(|h| !h.is_empty()) {
                continue;
            }
            let url = if key == SPACRON_TOOLS_KEY { url.replacen("/sse?", "/mcp?", 1) } else { url.to_string() };
            add(key, "url", toml(url.trim()));
        }
    }
    flags
}

/// The full headless command for one run: the agent's own headless form plus
/// the flags for the bot's access level and connectors.
pub(crate) fn bot_command(bot: &BoxBot, prompt: &str, mcp: Option<(&Path, &[String])>) -> Result<Vec<String>, String> {
    let mut argv = bot_agent_command(&bot.agent, prompt, bot.model.as_deref())?;
    let exe = argv[0].clone();
    let name = Path::new(&exe).file_stem().and_then(|s| s.to_str()).unwrap_or(&exe).to_ascii_lowercase();
    let mut flags: Vec<String> = Vec::new();
    match name.as_str() {
        "claude" => {
            // `--mcp-config`, `--allowedTools` and `--disallowedTools` each take
            // a list, so each is followed by another option, never the prompt.
            let mut allowed: Vec<String> = Vec::new();
            let mut denied: Vec<String> = Vec::new();
            if let Some((path, keys)) = mcp {
                flags.extend(["--mcp-config".into(), path.to_string_lossy().to_string()]);
                for key in keys {
                    let desktop: &[&str] = match key.as_str() {
                        BOX_TOOLS_KEY => &BOX_DESKTOP_TOOLS,
                        SPACRON_TOOLS_KEY => &PC_DESKTOP_TOOLS,
                        _ => &[],
                    };
                    if !bot.computer_use {
                        denied.extend(desktop.iter().map(|t| format!("mcp__{key}__{t}")));
                    }
                    if key == BOX_TOOLS_KEY && bot.access != Access::Full {
                        // Starting programs is running commands: full access only.
                        allowed.extend(BOX_TOOLS.iter()
                            .filter(|t| bot.computer_use || !t.starts_with("desktop_"))
                            .filter(|t| !FULL_ONLY_TOOLS.contains(t))
                            .map(|t| format!("mcp__{key}__{t}")));
                    } else {
                        allowed.push(format!("mcp__{key}"));
                    }
                }
            }
            if !denied.is_empty() {
                flags.push("--disallowedTools".into());
                flags.extend(denied);
            }
            match bot.access {
                Access::Research => {
                    allowed.extend(["WebSearch", "WebFetch", "Read", "Glob", "Grep"].map(String::from));
                    flags.push("--allowedTools".into());
                    flags.extend(allowed);
                    flags.extend(["--permission-mode".into(), "dontAsk".into()]);
                }
                Access::Folder => {
                    allowed.extend(["WebSearch", "WebFetch", "Read", "Glob", "Grep", "Write", "Edit"].map(String::from));
                    flags.push("--allowedTools".into());
                    flags.extend(allowed);
                    flags.extend(["--permission-mode".into(), "acceptEdits".into()]);
                }
                Access::Full => flags.extend(["--permission-mode".into(), "bypassPermissions".into()]),
            }
        }
        "codex" => {
            flags.extend(match bot.access {
                Access::Research => vec!["--sandbox".into(), "read-only".into()],
                Access::Folder => vec!["--sandbox".into(), "workspace-write".into()],
                Access::Full => vec!["--dangerously-bypass-approvals-and-sandbox".into()],
            });
            if let Some((path, _)) = mcp {
                flags.extend(codex_mcp_flags(path));
            }
        }
        "gemini" => flags.extend(match bot.access {
            Access::Research => vec![],
            Access::Folder => vec!["--approval-mode".into(), "auto_edit".into()],
            Access::Full => vec!["--yolo".into()],
        }),
        // Other agents use their own permission settings.
        _ => {}
    }
    // The prompt is the last argument; Gemini's `-p` takes it as its value, so
    // flags go before `-p` there and before the prompt everywhere else.
    let at = if name == "gemini" { argv.len() - 2 } else { argv.len() - 1 };
    argv.splice(at..at, flags);
    Ok(argv)
}

// ── invoke handlers ─────────────────────────────────────────────────────────

/// Replace the bots with the desktop's list (bots are not project-scoped).
pub(crate) fn sync(args: Value, root: &Path) -> Result<Value, String> {
    let incoming: BotsConfig = serde_json::from_value(args).map_err(|e| format!("Invalid bot sync: {e}"))?;
    for b in &incoming.bots {
        if !valid_id(&b.id) {
            return Err(format!("Bot id '{}' is not valid.", b.id));
        }
        if b.name.trim().is_empty() || b.instructions.trim().is_empty() {
            return Err("Every bot needs a name and instructions.".into());
        }
        if b.instructions.len() > MAX_INSTRUCTIONS {
            return Err(format!("Bot '{}' has instructions longer than {MAX_INSTRUCTIONS} characters.", b.name));
        }
        bot_agent_command(&b.agent, "check", b.model.as_deref())?;
    }
    let mcp = incoming.mcp_config.as_deref().filter(|c| !c.trim().is_empty());
    if let Some(c) = mcp {
        if c.len() > MAX_MCP_CONFIG {
            return Err("The MCP connector list is too large.".into());
        }
        serde_json::from_str::<Value>(c).map_err(|e| format!("Invalid MCP config: {e}"))?;
    }
    let count = incoming.bots.len();
    let _guard = file_lock().lock();
    let mcp_path = dir(root).join("mcp.json");
    match mcp {
        Some(c) => {
            write_json(&mcp_path, &serde_json::from_str::<Value>(c).unwrap_or_default())?;
            restrict(&mcp_path);
        }
        None => { let _ = std::fs::remove_file(&mcp_path); }
    }
    write_json(&dir(root).join("bots.json"), &incoming)?;
    Ok(json!({ "ok": true, "count": count }))
}

/// `mcp.json` can carry connector API keys: only the owner may read it.
pub(crate) fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Run records, newest first, plus where bot homes live.
pub(crate) fn state(root: &Path) -> Result<Value, String> {
    let runs: Vec<BotRun> = read_json(&dir(root).join("runs.json"));
    Ok(json!({ "runs": runs, "homeRoot": dir(root).join("home").to_string_lossy(), "proposals": proposals(root) }))
}

/// Start one bot immediately.
pub(crate) fn run_now(args: Value, root: &Path) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing bot id.")?;
    let config: BotsConfig = read_json(&dir(root).join("bots.json"));
    let bot = config.bots.iter().find(|b| b.id == id).cloned().ok_or("This bot has not been synced yet.")?;
    let message = args.get("message").and_then(|v| v.as_str()).map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
    if message.as_ref().is_some_and(|m| m.len() > MAX_MESSAGE) {
        return Err(format!("Keep the message under {MAX_MESSAGE} characters."));
    }
    if is_running(root, id) {
        return Err("This bot is already running. Stop it or wait for its answer.".into());
    }
    let attachments = checked_attachments(root, id, &args)?;
    let message = message.or_else(|| (!attachments.is_empty()).then(|| "(sent files)".to_string()));
    let trigger = if message.is_some() { "chat" } else { "manual" };
    let run_id = start_run(root.to_path_buf(), bot, trigger, max_run(&config), message, attachments);
    Ok(json!({ "runId": run_id }))
}

/// Stop a run in progress. A run this process does not own (left over from
/// a restart) is marked interrupted so it stops showing as running.
pub(crate) fn stop(args: Value, root: &Path) -> Result<Value, String> {
    let run_id = args.get("runId").and_then(|v| v.as_str()).ok_or("Missing run id.")?;
    let signal = running().lock().map_err(|e| e.to_string())?.get(run_id).cloned();
    match signal {
        Some(s) => s.notify_one(),
        None => finish(root, run_id, "interrupted", Some("This run was no longer active.".into())),
    }
    Ok(json!({ "ok": true }))
}

/// The tail of one run's log. Looked up by run id rather than by path, so
/// the desktop can only read logs this runner wrote.
pub(crate) fn log(args: Value, root: &Path) -> Result<Value, String> {
    let run_id = args.get("runId").and_then(|v| v.as_str()).ok_or("Missing run id.")?;
    let runs: Vec<BotRun> = read_json(&dir(root).join("runs.json"));
    let run = runs.iter().find(|r| r.id == run_id).ok_or("No such run.")?;
    let Some(rel) = run.log.as_deref() else { return Ok(json!({ "text": "", "truncated": false })) };
    let bytes = std::fs::read(root.join(rel)).unwrap_or_default();
    let truncated = bytes.len() > MAX_LOG_BYTES;
    let tail = if truncated { &bytes[bytes.len() - MAX_LOG_BYTES..] } else { &bytes[..] };
    Ok(json!({ "text": String::from_utf8_lossy(tail), "truncated": truncated }))
}

// ── attachments ─────────────────────────────────────────────────────────────

/// A file name safe to keep: its last path part, plain characters only.
fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._- ".contains(c) { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    let cleaned: String = cleaned.chars().rev().take(100).collect::<Vec<_>>().into_iter().rev().collect();
    if cleaned.is_empty() { "file".into() } else { cleaned }
}

/// Save one attached file into the bot's home (`attachments/`), returning its
/// path relative to that home, to send with the next message.
pub(crate) fn attach(args: Value, root: &Path) -> Result<Value, String> {
    use base64::Engine;
    let bot_id = args.get("botId").and_then(|v| v.as_str()).ok_or("Missing bot id.")?;
    if !valid_id(bot_id) {
        return Err("This bot's id is not valid.".into());
    }
    let name = safe_file_name(args.get("name").and_then(|v| v.as_str()).unwrap_or("file"));
    let data = args.get("data").and_then(|v| v.as_str()).ok_or("Missing file data.")?;
    if data.len() > MAX_ATTACHMENT_BYTES / 3 * 4 + 8 {
        return Err(format!("Attach files up to {} MB.", MAX_ATTACHMENT_BYTES / 1024 / 1024));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "The file could not be read.".to_string())?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!("Attach files up to {} MB.", MAX_ATTACHMENT_BYTES / 1024 / 1024));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let rel = format!("attachments/{}-{name}", &id[..8]);
    let path = home(root, bot_id).join(&rel);
    std::fs::create_dir_all(path.parent().ok_or("Bad path.")?).map_err(|e| format!("Could not save the file: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(json!({ "path": rel, "bytes": bytes.len() }))
}

/// Attachment paths from a run request, each a file this bot's `attachments/`
/// really holds. Anything else (a path out of the folder, a missing file) is refused.
fn checked_attachments(root: &Path, bot_id: &str, args: &Value) -> Result<Vec<String>, String> {
    let list: Vec<String> = args.get("attachments").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    if list.len() > MAX_ATTACHMENTS {
        return Err(format!("Attach at most {MAX_ATTACHMENTS} files to one message."));
    }
    let base = home(root, bot_id).join("attachments");
    list.into_iter().map(|rel| {
        let file = rel.strip_prefix("attachments/").filter(|f| !f.is_empty() && *f == safe_file_name(f) && !f.contains(".."))
            .ok_or_else(|| format!("Not an attachment of this bot: {rel}"))?;
        if !base.join(file).is_file() {
            return Err(format!("The attached file is gone: {rel}"));
        }
        Ok(rel)
    }).collect()
}

/// An attached image's bytes, for the chat's thumbnails. Only files in the
/// bot's `attachments/`, only images, only small ones.
pub(crate) fn file(args: Value, root: &Path) -> Result<Value, String> {
    use base64::Engine;
    let bot_id = args.get("botId").and_then(|v| v.as_str()).ok_or("Missing bot id.")?;
    if !valid_id(bot_id) {
        return Err("This bot's id is not valid.".into());
    }
    let rel = args.get("path").and_then(|v| v.as_str()).ok_or("Missing path.")?;
    let [path] = checked_attachments(root, bot_id, &json!({ "attachments": [rel] }))?.try_into().map_err(|_| "Bad path.".to_string())?;
    let lower = path.to_ascii_lowercase();
    let mime = [("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"), ("webp", "image/webp")]
        .iter().find(|(ext, _)| lower.ends_with(&format!(".{ext}"))).map(|(_, m)| *m).ok_or("Only images can be previewed.")?;
    let full = home(root, bot_id).join(&path);
    if std::fs::metadata(&full).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_PREVIEW_BYTES {
        return Err("Too large to preview.".into());
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    Ok(json!({ "mime": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

// ── scheduling ──────────────────────────────────────────────────────────────

fn max_run(config: &BotsConfig) -> Duration {
    Duration::from_secs(config.max_run_minutes.clamp(1, 12 * 60) * 60)
}

fn is_running(root: &Path, bot_id: &str) -> bool {
    let runs: Vec<BotRun> = read_json(&dir(root).join("runs.json"));
    runs.iter().any(|r| r.bot_id == bot_id && r.status == "running")
}

/// The tick loop, started once per host.
pub(crate) async fn run_loop(root: PathBuf) {
    // A run that was going when the runner stopped can never report.
    update_runs(&root, |runs| {
        for r in runs.iter_mut().filter(|r| r.status == "running") {
            r.status = "interrupted".into();
            r.finished_at = Some(now_ms());
            r.detail = Some("The runner restarted during this run.".into());
        }
    });
    loop {
        tick(&root);
        tokio::time::sleep(TICK).await;
    }
}

fn tick(root: &Path) {
    let config: BotsConfig = read_json(&dir(root).join("bots.json"));
    if !config.enabled {
        return;
    }
    let limit = max_run(&config);
    let fired_path = dir(root).join("fired.json");
    let mut fired: HashMap<String, u64> = read_json(&fired_path);
    let now = now_ms();
    let mut changed = false;
    for b in config.bots.into_iter().filter(|b| b.enabled) {
        let last = fired.get(&b.id).copied().unwrap_or(0);
        let Some((occurrence, in_reach)) = due(&b.occurrences, last, now, config.catch_up_minutes) else { continue };
        fired.insert(b.id.clone(), occurrence);
        changed = true;
        if !in_reach {
            let (id, name) = (b.id.clone(), b.name.clone());
            update_runs(root, |runs| runs.insert(0, BotRun {
                id: uuid::Uuid::new_v4().to_string(), bot_id: id, name, started_at: now, finished_at: Some(now),
                status: "missed".into(), trigger: "schedule".into(),
                detail: Some("The scheduled time passed while this computer could not run it.".into()), log: None, message: None, attachments: Vec::new(),
            }));
        } else if !is_running(root, &b.id) {
            start_run(root.to_path_buf(), b, "schedule", limit, None, Vec::new());
        }
    }
    if changed {
        let _guard = file_lock().lock();
        let _ = write_json(&fired_path, &fired);
    }
}

// ── running ─────────────────────────────────────────────────────────────────

fn start_run(root: PathBuf, bot: BoxBot, trigger: &str, limit: Duration, message: Option<String>, attachments: Vec<String>) -> String {
    let run_id = uuid::Uuid::new_v4().to_string();
    let log_rel = format!(".spacron/bots/logs/{run_id}.log");
    // The conversation is read before this run is recorded, so it never sees itself.
    let history = conversation(&root, &bot.id, &run_id);
    let prompt = run_prompt_with(&bot, &history, message.as_deref(), &attachments);
    let run = BotRun {
        id: run_id.clone(), bot_id: bot.id.clone(), name: bot.name.clone(), started_at: now_ms(), finished_at: None,
        status: "running".into(), trigger: trigger.into(), detail: None, log: Some(log_rel.clone()), message, attachments,
    };
    update_runs(&root, |runs| runs.insert(0, run));
    let signal = Arc::new(Notify::new());
    if let Ok(mut map) = running().lock() {
        map.insert(run_id.clone(), signal.clone());
    }
    let id = run_id.clone();
    tokio::spawn(async move {
        let (status, detail) = match execute(&root, &bot, &id, &prompt, &root.join(&log_rel), limit, signal).await {
            Ok(0) => ("completed", None),
            Ok(code) => ("failed", Some(format!("The agent exited with code {code}. See the output."))),
            Err(e) if e == STOPPED_BY_USER => ("stopped", Some(e)),
            Err(e) => ("failed", Some(e)),
        };
        if let Ok(mut map) = running().lock() {
            map.remove(&id);
        }
        if bot.can_create_bots {
            collect_proposals(&root, &bot);
        }
        finish(&root, &id, status, detail);
    });
    run_id
}

async fn execute(root: &Path, bot: &BoxBot, run_id: &str, prompt: &str, log_path: &Path, limit: Duration, signal: Arc<Notify>) -> Result<i32, String> {
    if !valid_id(&bot.id) {
        return Err("This bot's id is not valid.".into());
    }
    let cwd = home(root, &bot.id);
    std::fs::create_dir_all(&cwd).map_err(|e| format!("Could not create the bot's folder: {e}"))?;
    if bot.can_create_bots {
        let _ = std::fs::create_dir_all(cwd.join("new-bots"));
    }
    let run_config = run_mcp_config(root, bot, run_id);
    let mcp = run_config.as_ref().map(|(path, keys)| (path.as_path(), keys.as_slice()));
    let argv = bot_command(bot, prompt, mcp)?;
    // Agents that read servers from a config file get one in their folder for
    // the run (see `bot_mcp`); Claude and Codex took theirs on the command line.
    let mut argv = argv;
    let config_guard = super::bot_mcp::apply(&cwd, &argv[0], mcp.map(|(path, _)| path)).map(|applied| {
        // The prompt is the last argument; the flags go just before it.
        let at = argv.len() - 1;
        argv.splice(at..at, applied.flags);
        applied.guard
    });
    // A browser server (Playwright via npx) can take far longer to start than
    // Claude Code's default MCP wait; the app gives its own agents the same budget.
    let env = [("SPACRON_BOT", bot.name.as_str()), ("MCP_TIMEOUT", "120000")];
    let result = spawn_headless(&argv, &cwd, log_path, &env, limit, Some(signal)).await;
    if let Some(guard) = config_guard {
        guard.restore();
    }
    if let Some((path, _)) = run_config {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// The MCP servers this bot gets for one run: the synced set narrowed to the
/// bot's own picks, with a box's shared sign-ins resolved to its proxy.
/// Written owner-only for the run and removed after.
fn run_mcp_config(root: &Path, bot: &BoxBot, run_id: &str) -> Option<(PathBuf, Vec<String>)> {
    if !bot.connectors {
        return None;
    }
    let text = std::fs::read_to_string(dir(root).join("mcp.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let servers = value.get("mcpServers")?.as_object()?;
    let picked: serde_json::Map<String, Value> = servers.iter()
        .filter(|(key, _)| bot.mcp_keys.as_ref().is_none_or(|keys| keys.iter().any(|k| k == *key)))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if picked.is_empty() {
        return None;
    }
    let keys: Vec<String> = picked.keys().cloned().collect();
    let body = super::box_proxy::resolve(&json!({ "mcpServers": picked }).to_string());
    let path = dir(root).join("run-mcp").join(format!("{run_id}.json"));
    std::fs::create_dir_all(path.parent()?).ok()?;
    std::fs::write(&path, body).ok()?;
    restrict(&path);
    Some((path, keys))
}

// ── Bot Builder ─────────────────────────────────────────────────────────────

fn proposals_dir(root: &Path) -> PathBuf {
    dir(root).join("proposals")
}

/// After a run of a bot that may create bots: move the specs it wrote to
/// `new-bots/` into the proposal queue, where the desktop picks them up,
/// checks them and adds the bots (`proposals`, `proposals_ack`).
fn collect_proposals(root: &Path, bot: &BoxBot) {
    let source = home(root, &bot.id).join("new-bots");
    let Ok(entries) = std::fs::read_dir(&source) else { return };
    let queue = proposals_dir(root);
    if std::fs::create_dir_all(&queue).is_err() {
        return;
    }
    let mut taken = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let small = entry.metadata().map(|m| m.is_file() && m.len() <= MAX_PROPOSAL_BYTES).unwrap_or(false);
        let spec = small.then(|| std::fs::read_to_string(&path).ok()).flatten()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .filter(|v| v.is_object());
        let _ = std::fs::remove_file(&path);
        let Some(spec) = spec else { continue };
        if taken >= MAX_PROPOSALS {
            continue;
        }
        taken += 1;
        let id = uuid::Uuid::new_v4().to_string();
        let proposal = json!({
            "id": id, "createdBy": bot.id, "createdByName": bot.name, "creatorAccess": bot.access,
            "createdAt": now_ms(), "spec": spec,
        });
        let _ = write_json(&queue.join(format!("{id}.json")), &proposal);
    }
}

/// Bots waiting to be added by the desktop.
fn proposals(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(proposals_dir(root)).into_iter().flatten().flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str(&t).ok())
        .collect();
    out.sort_by_key(|p: &Value| p["createdAt"].as_u64().unwrap_or(0));
    out
}

/// The desktop added (or rejected) these proposals: drop them from the queue.
pub(crate) fn proposals_ack(args: Value, root: &Path) -> Result<Value, String> {
    let ids: Vec<String> = serde_json::from_value(args.get("ids").cloned().unwrap_or(json!([]))).map_err(|e| e.to_string())?;
    for id in ids.iter().filter(|id| valid_id(id)) {
        let _ = std::fs::remove_file(proposals_dir(root).join(format!("{id}.json")));
    }
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: &str, occurrences: Vec<u64>) -> Value {
        json!({ "id": id, "name": "Digest", "instructions": "Summarise the news.", "agent": "claude", "enabled": true, "occurrences": occurrences })
    }

    fn parsed(v: Value) -> BoxBot { serde_json::from_value(v).unwrap() }

    #[test]
    fn ids_that_could_escape_the_home_folder_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["../x", "a/b", "", "a b", "..", "a\\b"] {
            assert!(sync(json!({ "bots": [bot(id, vec![])] }), dir.path()).is_err(), "{id:?}");
        }
        assert!(sync(json!({ "bots": [bot("ok-1_A", vec![])] }), dir.path()).is_ok());
    }

    #[test]
    fn sync_needs_a_headless_agent_and_instructions() {
        let dir = tempfile::tempdir().unwrap();
        let aider = json!({ "bots": [{ "id": "a", "name": "x", "instructions": "p", "agent": "aider", "enabled": true }] });
        assert!(sync(aider, dir.path()).is_err());
        let empty = json!({ "bots": [{ "id": "a", "name": "x", "instructions": "  ", "agent": "claude", "enabled": true }] });
        assert!(sync(empty, dir.path()).is_err());
    }

    #[test]
    fn sync_replaces_the_whole_list_and_keeps_settings() {
        let dir = tempfile::tempdir().unwrap();
        sync(json!({ "bots": [bot("a", vec![1]), bot("b", vec![])] }), dir.path()).unwrap();
        sync(json!({ "bots": [bot("c", vec![])], "enabled": false, "catchUpMinutes": 5, "maxRunMinutes": 20 }), dir.path()).unwrap();
        let saved: BotsConfig = read_json(&super::dir(dir.path()).join("bots.json"));
        assert_eq!(saved.bots.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["c"]);
        assert!(!saved.enabled);
        assert_eq!((saved.catch_up_minutes, saved.max_run_minutes), (5, 20));
        assert_eq!(max_run(&saved), Duration::from_secs(20 * 60));
    }

    #[test]
    fn mcp_config_is_written_apart_private_and_removed_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = r#"{"mcpServers":{"spacron-linear":{"type":"http","url":"https://x"}}}"#;
        sync(json!({ "bots": [], "mcpConfig": cfg }), dir.path()).unwrap();
        let path = super::dir(dir.path()).join("mcp.json");
        assert_eq!(mcp_keys(&std::fs::read_to_string(&path).unwrap()), ["spacron-linear"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let saved = std::fs::read_to_string(super::dir(dir.path()).join("bots.json")).unwrap();
        assert!(!saved.contains("spacron-linear"), "the config is not duplicated into bots.json");
        assert!(sync(json!({ "bots": [], "mcpConfig": "{not json" }), dir.path()).is_err());
        sync(json!({ "bots": [] }), dir.path()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn additional_bot_agents_launch_with_their_headless_modes() {
        let prompt = "Summarise the news.\nKeep the prompt together.";
        for (agent, expected) in [
            ("agy", vec!["agy", "--model", "example", "--print", prompt]),
            ("pi", vec!["pi", "--print", "--model", "example", prompt]),
            ("cursor-agent", vec!["cursor-agent", "--print", "--model", "example", prompt]),
            ("grok", vec!["grok", "--model", "example", "--single", prompt]),
            ("dsh", vec!["dsh", "headless", prompt]),
            ("kilo", vec!["kilo", "run", "--model", "example", prompt]),
        ] {
            assert_eq!(bot_agent_command(agent, prompt, Some("example")).unwrap(), expected);
        }
        assert!(bot_agent_command("freebuff", prompt, None).is_err());
    }

    #[test]
    fn claude_flags_follow_the_access_level_and_keep_the_prompt_last() {
        let mut b = parsed(bot("a", vec![]));
        let research = bot_command(&b, "Summarise the news.", None).unwrap();
        assert_eq!(&research[..2], ["claude", "-p"]);
        assert!(research.windows(2).any(|w| w == ["--permission-mode", "dontAsk"]));
        assert!(research.contains(&"WebSearch".to_string()) && !research.contains(&"Write".to_string()));
        assert!(research.last().unwrap().ends_with("Summarise the news."));

        b.access = Access::Folder;
        let keys = vec!["spacron-linear".to_string()];
        let folder = bot_command(&b, "Summarise the news.", Some((Path::new("/m.json"), &keys))).unwrap();
        let at = |s: &str| folder.iter().position(|x| x == s).unwrap();
        assert!(folder.windows(2).any(|w| w == ["--mcp-config", "/m.json"]));
        assert!(folder.contains(&"mcp__spacron-linear".to_string()) && folder.contains(&"Write".to_string()));
        // Each list option is closed by the next option, never by the prompt.
        assert!(at("--mcp-config") < at("--allowedTools") && at("--allowedTools") < at("--permission-mode"));
        assert_eq!(at("--permission-mode") + 2, folder.len() - 1);

        b.access = Access::Full;
        let full = bot_command(&b, "Summarise the news.", None).unwrap();
        assert!(full.windows(2).any(|w| w == ["--permission-mode", "bypassPermissions"]));
        assert!(!full.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn box_tools_never_let_a_limited_bot_launch_programs() {
        let mut b = parsed(bot("a", vec![]));
        b.access = Access::Folder;
        let keys = vec!["spacron-box".to_string()];
        let no_desktop = bot_command(&b, "p", Some((Path::new("/m.json"), &keys))).unwrap();
        assert!(no_desktop.contains(&"mcp__spacron-box__list_agents".to_string()));
        let allow_at = no_desktop.iter().position(|a| a == "--allowedTools").unwrap();
        let deny_at = no_desktop.iter().position(|a| a == "--disallowedTools").unwrap();
        assert!(!no_desktop[allow_at..].iter().any(|a| a.contains("desktop_")), "computer use off: no desktop tool is allowed");
        assert!(no_desktop[deny_at..allow_at].iter().any(|a| a == "mcp__spacron-box__desktop_click"), "and they are denied outright");
        b.computer_use = true;
        let argv = bot_command(&b, "p", Some((Path::new("/m.json"), &keys))).unwrap();
        assert!(argv.contains(&"mcp__spacron-box__desktop_click".to_string()));
        assert!(argv.contains(&"mcp__spacron-box__list_agents".to_string()));
        assert!(!argv.iter().any(|a| a == "mcp__spacron-box" || a.ends_with("desktop_launch")));
        assert!(!argv.iter().any(|a| a.ends_with("__spawn_agent") || a.ends_with("__delegate_task")), "limited bots cannot start agents");
        assert!(argv.contains(&"mcp__spacron-box__report_status".to_string()));
        b.access = Access::Full;
        assert!(bot_command(&b, "p", Some((Path::new("/m.json"), &keys))).unwrap().iter().all(|a| !a.starts_with("mcp__")), "full access needs no allow list");
        // Full access still keeps the desktop off unless computer use is on.
        b.computer_use = false;
        let full = bot_command(&b, "p", Some((Path::new("/m.json"), &keys))).unwrap();
        assert!(full.contains(&"--disallowedTools".to_string()) && full.iter().any(|a| a == "mcp__spacron-box__desktop_click"));
        // On this PC, Spacron's own desktop tools follow the same switch.
        let pc = vec!["spacron-mcp".to_string()];
        b.access = Access::Folder;
        let off = bot_command(&b, "p", Some((Path::new("/m.json"), &pc))).unwrap();
        assert!(off.iter().any(|a| a == "mcp__spacron-mcp__desktop_click") && off.contains(&"mcp__spacron-mcp".to_string()));
        b.computer_use = true;
        assert!(!bot_command(&b, "p", Some((Path::new("/m.json"), &pc))).unwrap().contains(&"--disallowedTools".to_string()));
    }

    #[test]
    fn other_agents_get_their_own_flags_in_the_right_place() {
        let mut b = parsed(bot("a", vec![]));
        b.agent = "codex".into();
        b.access = Access::Folder;
        let codex = bot_command(&b, "Summarise the news.", None).unwrap();
        assert_eq!(&codex[..4], ["codex", "exec", "--sandbox", "workspace-write"]);
        b.agent = "gemini".into();
        b.access = Access::Full;
        let gemini = bot_command(&b, "Summarise the news.", None).unwrap();
        let n = gemini.len();
        assert_eq!(gemini[n - 3], "--yolo");
        assert_eq!(gemini[n - 2], "-p", "-p still sits right before its prompt");
    }

    #[test]
    fn codex_bots_get_their_connectors_as_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        std::fs::write(&path, json!({ "mcpServers": {
            "spacron-mcp": { "type": "sse", "url": "http://127.0.0.1:9/sse?token=t" },
            "gmail": { "type": "http", "url": "https://x/mcp" },
            "keyed": { "type": "http", "url": "https://y/mcp", "headers": { "Authorization": "k" } },
            "files": { "command": "npx", "args": ["-y", "pkg"], "env": { "A": "b" } },
        } }).to_string()).unwrap();
        let flags = codex_mcp_flags(&path);
        assert!(flags.contains(&"mcp_servers.spacron-mcp.url=\"http://127.0.0.1:9/mcp?token=t\"".to_string()));
        assert!(flags.contains(&"mcp_servers.gmail.url=\"https://x/mcp\"".to_string()));
        assert!(flags.contains(&"mcp_servers.files.args=[\"-y\", \"pkg\"]".to_string()));
        assert!(flags.contains(&"mcp_servers.files.env={ \"A\" = \"b\" }".to_string()));
        assert!(flags.iter().all(|f| !f.contains("keyed")), "headers cannot reach Codex");
        let mut b = parsed(bot("a", vec![]));
        b.agent = "codex".into();
        let argv = bot_command(&b, "p", Some((&path, &["gmail".to_string()]))).unwrap();
        assert_eq!(argv.last().unwrap(), "p", "the prompt stays last");
        assert!(argv.contains(&"-c".to_string()));
    }

    #[test]
    fn the_prompt_names_the_bot_and_says_what_it_may_do() {
        let mut b = parsed(bot("a", vec![]));
        assert!(bot_prompt(&b).contains("cannot create or change files"));
        b.access = Access::Folder;
        let p = bot_prompt(&b);
        assert!(p.contains("\"Digest\"") && p.contains("save results there"));
        assert!(p.ends_with("Your job:\nSummarise the news."));
    }

    #[test]
    fn a_missed_occurrence_is_recorded_once_and_not_run() {
        let dir = tempfile::tempdir().unwrap();
        let old = now_ms() - 2 * 60 * 60_000;
        sync(json!({ "bots": [bot("a", vec![old])], "enabled": true, "catchUpMinutes": 15 }), dir.path()).unwrap();
        tick(dir.path());
        tick(dir.path());
        let runs: Vec<BotRun> = read_json(&super::dir(dir.path()).join("runs.json"));
        assert_eq!(runs.len(), 1);
        assert_eq!((runs[0].status.as_str(), runs[0].trigger.as_str()), ("missed", "schedule"));
    }

    #[test]
    fn a_paused_schedule_or_master_switch_fires_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let old = now_ms() - 2 * 60 * 60_000;
        let mut paused = bot("a", vec![old]);
        paused["enabled"] = json!(false);
        sync(json!({ "bots": [paused] }), dir.path()).unwrap();
        tick(dir.path());
        sync(json!({ "bots": [bot("b", vec![old])], "enabled": false }), dir.path()).unwrap();
        tick(dir.path());
        let runs: Vec<BotRun> = read_json(&super::dir(dir.path()).join("runs.json"));
        assert!(runs.is_empty());
    }

    #[test]
    fn logs_are_read_by_run_id_only_and_trimmed_to_the_tail() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        let rel = ".spacron/bots/logs/r1.log";
        std::fs::create_dir_all(ws.join(".spacron/bots/logs")).unwrap();
        let mut body = "x".repeat(MAX_LOG_BYTES);
        body.push_str("END");
        std::fs::write(ws.join(rel), &body).unwrap();
        update_runs(ws, |runs| runs.push(BotRun {
            id: "r1".into(), bot_id: "a".into(), name: "n".into(), started_at: 1, finished_at: Some(2),
            status: "completed".into(), trigger: "manual".into(), detail: None, log: Some(rel.into()), message: None, attachments: Vec::new(),
        }));
        let out = log(json!({ "runId": "r1" }), ws).unwrap();
        assert_eq!(out["truncated"], json!(true));
        assert!(out["text"].as_str().unwrap().ends_with("END"));
        assert!(log(json!({ "runId": "../../etc/passwd" }), ws).is_err());
    }

    #[test]
    fn stopping_a_run_this_process_does_not_own_marks_it_interrupted() {
        let dir = tempfile::tempdir().unwrap();
        update_runs(dir.path(), |runs| runs.push(BotRun {
            id: "ghost".into(), bot_id: "a".into(), name: "n".into(), started_at: 1, finished_at: None,
            status: "running".into(), trigger: "manual".into(), detail: None, log: None, message: None, attachments: Vec::new(),
        }));
        stop(json!({ "runId": "ghost" }), dir.path()).unwrap();
        let runs: Vec<BotRun> = read_json(&super::dir(dir.path()).join("runs.json"));
        assert_eq!(runs[0].status, "interrupted");
    }

    /// A real agent process, stopped mid-run: it must end quickly as
    /// "stopped", and its own child (the `sleep`) must die with it.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn stop_ends_a_real_run_and_its_children() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let agent = bin.join("claude");
        let marker = dir.path().join("child.pid");
        std::fs::write(&agent, format!("#!/bin/sh\nsleep 30 &\necho $! > {}\nwait\n", marker.display())).unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut b = bot("slow", vec![]);
        b["agent"] = json!(agent.to_string_lossy());
        sync(json!({ "bots": [b] }), dir.path()).unwrap();
        let run_id = run_now(json!({ "id": "slow" }), dir.path()).unwrap()["runId"].as_str().unwrap().to_string();
        for _ in 0..50 { if marker.exists() { break; } tokio::time::sleep(Duration::from_millis(100)).await; }
        let child_pid = std::fs::read_to_string(&marker).unwrap().trim().to_string();
        let started = std::time::Instant::now();
        stop(json!({ "runId": run_id }), dir.path()).unwrap();
        let mut status = String::new();
        for _ in 0..100 {
            let runs: Vec<BotRun> = read_json(&super::dir(dir.path()).join("runs.json"));
            status = runs[0].status.clone();
            if status != "running" { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(status, "stopped");
        assert!(started.elapsed() < Duration::from_secs(8));
        // Gone, or a zombie (dead, waiting for this container's init to reap it).
        #[cfg(target_os = "linux")]
        {
            let mut alive = true;
            for _ in 0..30 {
                let stat = std::fs::read_to_string(format!("/proc/{child_pid}/stat")).unwrap_or_default();
                let state = stat.rsplit(')').next().and_then(|rest| rest.split_whitespace().next()).unwrap_or("");
                alive = !stat.is_empty() && state != "Z" && state != "X";
                if !alive { break; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(!alive, "the agent's child ({child_pid}) was left running");
        }
    }

    #[cfg(unix)]
    fn fake_agent(dir: &Path, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let agent = bin.join("claude");
        std::fs::write(&agent, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        agent.to_string_lossy().to_string()
    }

    #[cfg(unix)]
    async fn wait_run(root: &Path, run_id: &str) -> BotRun {
        for _ in 0..100 {
            let runs: Vec<BotRun> = read_json(&super::dir(root).join("runs.json"));
            if let Some(r) = runs.iter().find(|r| r.id == run_id && r.status != "running") {
                return r.clone();
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("run {run_id} did not finish");
    }

    /// A chat: the second message's run sees the first exchange, and the
    /// message itself is recorded on the run.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn chat_messages_carry_the_conversation() {
        let dir = tempfile::tempdir().unwrap();
        // Answers with the last line of its prompt, and says whether it saw history.
        let agent = fake_agent(dir.path(), r#"for a; do last="$a"; done
case "$last" in *"User: hello"*) echo "SAW-HISTORY";; esac
printf '%s\n' "$last" | tail -n 1"#);
        let mut b = bot("chat", vec![]);
        b["agent"] = json!(agent);
        sync(json!({ "bots": [b] }), dir.path()).unwrap();
        let first = run_now(json!({ "id": "chat", "message": "hello" }), dir.path()).unwrap()["runId"].as_str().unwrap().to_string();
        let r1 = wait_run(dir.path(), &first).await;
        assert_eq!((r1.status.as_str(), r1.trigger.as_str(), r1.message.as_deref()), ("completed", "chat", Some("hello")));
        assert!(log(json!({ "runId": first }), dir.path()).unwrap()["text"].as_str().unwrap().trim().ends_with("hello"));
        let second = run_now(json!({ "id": "chat", "message": "and again" }), dir.path()).unwrap()["runId"].as_str().unwrap().to_string();
        wait_run(dir.path(), &second).await;
        let text = log(json!({ "runId": second }), dir.path()).unwrap()["text"].as_str().unwrap().to_string();
        assert!(text.contains("SAW-HISTORY"), "{text}");
        assert!(run_now(json!({ "id": "chat", "message": "x".repeat(MAX_MESSAGE + 1) }), dir.path()).is_err());
    }

    #[test]
    fn the_run_prompt_layers_job_history_and_message() {
        let mut b = parsed(bot("a", vec![]));
        b.extra_context = Some("Connectors you can use: Gmail".into());
        let p = run_prompt(&b, "User: hi\nYou: hello\n", Some("what's new?"));
        let job = p.find("Your job:").unwrap();
        let extra = p.find("Connectors you can use").unwrap();
        let history = p.find("User: hi").unwrap();
        let message = p.find("what's new?").unwrap();
        assert!(job < extra && extra < history && history < message);
        assert!(!p.contains("new-bots"), "only builder bots are told how to create bots");
        b.can_create_bots = true;
        assert!(run_prompt(&b, "", None).contains("new-bots"));
    }

    /// The Bot Builder: specs it writes become proposals (bad ones are
    /// dropped, at most MAX_PROPOSALS), and acked ones leave the queue.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_builder_bot_proposes_bots_and_the_desktop_acks_them() {
        let dir = tempfile::tempdir().unwrap();
        let agent = fake_agent(dir.path(), r#"i=0; while [ $i -lt 12 ]; do echo "{\"name\":\"Bot $i\",\"instructions\":\"Do $i\"}" > "new-bots/b$i.json"; i=$((i+1)); done
echo 'not json' > new-bots/broken.json; echo '[1,2]' > new-bots/array.json; echo ok"#);
        let mut b = bot("builder", vec![]);
        b["agent"] = json!(agent);
        b["canCreateBots"] = json!(true);
        b["access"] = json!("folder");
        sync(json!({ "bots": [b] }), dir.path()).unwrap();
        let id = run_now(json!({ "id": "builder", "message": "make me bots" }), dir.path()).unwrap()["runId"].as_str().unwrap().to_string();
        assert_eq!(wait_run(dir.path(), &id).await.status, "completed");
        let st = state(dir.path()).unwrap();
        let list = st["proposals"].as_array().unwrap();
        assert_eq!(list.len(), MAX_PROPOSALS);
        assert!(list.iter().all(|p| p["createdBy"] == "builder" && p["creatorAccess"] == "folder" && p["spec"]["name"].is_string()));
        assert_eq!(std::fs::read_dir(home(dir.path(), "builder").join("new-bots")).unwrap().count(), 0, "specs are consumed");
        let ids: Vec<String> = list.iter().take(3).map(|p| p["id"].as_str().unwrap().to_string()).collect();
        proposals_ack(json!({ "ids": ids }), dir.path()).unwrap();
        assert_eq!(state(dir.path()).unwrap()["proposals"].as_array().unwrap().len(), MAX_PROPOSALS - 3);
    }

    #[test]
    fn each_bot_gets_only_its_own_connectors() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = r#"{"mcpServers":{"spacron-gmail":{"type":"http","url":"spacron-box-proxy://spacron-gmail"},"spacron-playwright":{"command":"npx","args":[]},"spacron-linear":{"type":"http","url":"https://l"}}}"#;
        sync(json!({ "bots": [], "mcpConfig": cfg }), dir.path()).unwrap();
        let mut b = parsed(bot("a", vec![]));
        b.connectors = true;
        b.mcp_keys = Some(vec!["spacron-gmail".into(), "spacron-playwright".into(), "spacron-missing".into()]);
        let (path, mut keys) = run_mcp_config(dir.path(), &b, "run1").unwrap();
        keys.sort();
        assert_eq!(keys, ["spacron-gmail", "spacron-playwright"]);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("spacron-linear"));
        b.mcp_keys = Some(vec![]);
        assert!(run_mcp_config(dir.path(), &b, "run2").is_none());
        b.mcp_keys = None;
        assert_eq!(run_mcp_config(dir.path(), &b, "run3").unwrap().1.len(), 3, "older bots keep every connector");
        b.connectors = false;
        assert!(run_mcp_config(dir.path(), &b, "run4").is_none());
    }

    #[test]
    fn attachments_are_saved_in_the_bot_folder_and_only_those_can_be_sent() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G', 1, 2, 3]);
        let saved = attach(json!({ "botId": "a", "name": "../../etc/My Photo!.png", "data": png }), dir.path()).unwrap();
        let rel = saved["path"].as_str().unwrap().to_string();
        assert!(rel.starts_with("attachments/") && rel.ends_with("-My Photo_.png"), "{rel}");
        assert!(home(dir.path(), "a").join(&rel).is_file());
        assert_eq!(checked_attachments(dir.path(), "a", &json!({ "attachments": [rel] })).unwrap().len(), 1);
        for bad in ["../../etc/passwd", "attachments/../../x", "attachments/", "notes.md", "attachments/missing.png"] {
            assert!(checked_attachments(dir.path(), "a", &json!({ "attachments": [bad] })).is_err(), "{bad}");
        }
        assert!(checked_attachments(dir.path(), "b", &json!({ "attachments": [rel] })).is_err(), "another bot's file");
        let preview = file(json!({ "botId": "a", "path": rel }), dir.path()).unwrap();
        assert_eq!(preview["mime"], "image/png");
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_ATTACHMENT_BYTES + 1]);
        assert!(attach(json!({ "botId": "a", "name": "big.bin", "data": big }), dir.path()).is_err());
        assert!(attach(json!({ "botId": "../x", "name": "a", "data": png }), dir.path()).is_err());
    }

    #[test]
    fn the_prompt_lists_attached_files() {
        let b = parsed(bot("a", vec![]));
        let p = run_prompt_with(&b, "", Some("what is in this?"), &["attachments/1234abcd-photo.png".into()]);
        assert!(p.ends_with("- attachments/1234abcd-photo.png\n"));
        assert!(p.find("what is in this?").unwrap() < p.find("attachments/1234abcd").unwrap());
    }

    #[test]
    fn run_now_needs_a_synced_bot() {
        let dir = tempfile::tempdir().unwrap();
        assert!(run_now(json!({ "id": "nope" }), dir.path()).is_err());
    }
}
