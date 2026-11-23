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
//! in their headless mode (`claude -p`, `codex exec`, `gemini -p`,
//! `opencode run`).
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
    /// manual | schedule
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// Root-relative log path.
    #[serde(default)]
    pub log: Option<String>,
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

/// The MCP server keys in an `mcp.json` body, for Claude's allow list.
fn mcp_keys(config: &str) -> Vec<String> {
    serde_json::from_str::<Value>(config)
        .ok()
        .and_then(|v| v.get("mcpServers").and_then(|s| s.as_object()).map(|m| m.keys().cloned().collect()))
        .unwrap_or_default()
}

/// The full headless command for one run: the agent's own headless form plus
/// the flags for the bot's access level and connectors.
pub(crate) fn bot_command(bot: &BoxBot, mcp: Option<(&Path, &[String])>) -> Result<Vec<String>, String> {
    let mut argv = agent_command(&bot.agent, &bot_prompt(bot), bot.model.as_deref())?;
    let exe = argv[0].clone();
    let name = Path::new(&exe).file_stem().and_then(|s| s.to_str()).unwrap_or(&exe).to_ascii_lowercase();
    let mut flags: Vec<String> = Vec::new();
    match name.as_str() {
        "claude" => {
            // `--mcp-config` and `--allowedTools` each take a list, so each is
            // followed by another option rather than by the prompt.
            let mut allowed: Vec<String> = Vec::new();
            if let Some((path, keys)) = mcp {
                flags.extend(["--mcp-config".into(), path.to_string_lossy().to_string()]);
                allowed.extend(keys.iter().map(|k| format!("mcp__{k}")));
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
        "codex" => flags.extend(match bot.access {
            Access::Research => vec!["--sandbox".into(), "read-only".into()],
            Access::Folder => vec!["--sandbox".into(), "workspace-write".into()],
            Access::Full => vec!["--dangerously-bypass-approvals-and-sandbox".into()],
        }),
        "gemini" => flags.extend(match bot.access {
            Access::Research => vec![],
            Access::Folder => vec!["--approval-mode".into(), "auto_edit".into()],
            Access::Full => vec!["--yolo".into()],
        }),
        // opencode reads its permissions from its own config.
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
        agent_command(&b.agent, "check", b.model.as_deref())?;
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
fn restrict(path: &Path) {
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
    Ok(json!({ "runs": runs, "homeRoot": dir(root).join("home").to_string_lossy() }))
}

/// Start one bot immediately.
pub(crate) fn run_now(args: Value, root: &Path) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing bot id.")?;
    let config: BotsConfig = read_json(&dir(root).join("bots.json"));
    let bot = config.bots.iter().find(|b| b.id == id).cloned().ok_or("This bot has not been synced yet.")?;
    if is_running(root, id) {
        return Err("This bot is already running.".into());
    }
    let run_id = start_run(root.to_path_buf(), bot, "manual", max_run(&config));
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
                detail: Some("The scheduled time passed while this computer could not run it.".into()), log: None,
            }));
        } else if !is_running(root, &b.id) {
            start_run(root.to_path_buf(), b, "schedule", limit);
        }
    }
    if changed {
        let _guard = file_lock().lock();
        let _ = write_json(&fired_path, &fired);
    }
}

// ── running ─────────────────────────────────────────────────────────────────

fn start_run(root: PathBuf, bot: BoxBot, trigger: &str, limit: Duration) -> String {
    let run_id = uuid::Uuid::new_v4().to_string();
    let log_rel = format!(".spacron/bots/logs/{run_id}.log");
    let run = BotRun {
        id: run_id.clone(), bot_id: bot.id.clone(), name: bot.name.clone(), started_at: now_ms(), finished_at: None,
        status: "running".into(), trigger: trigger.into(), detail: None, log: Some(log_rel.clone()),
    };
    update_runs(&root, |runs| runs.insert(0, run));
    let signal = Arc::new(Notify::new());
    if let Ok(mut map) = running().lock() {
        map.insert(run_id.clone(), signal.clone());
    }
    let id = run_id.clone();
    tokio::spawn(async move {
        let (status, detail) = match execute(&root, &bot, &root.join(&log_rel), limit, signal).await {
            Ok(0) => ("completed", None),
            Ok(code) => ("failed", Some(format!("The agent exited with code {code}. See the output."))),
            Err(e) if e == STOPPED_BY_USER => ("stopped", Some(e)),
            Err(e) => ("failed", Some(e)),
        };
        if let Ok(mut map) = running().lock() {
            map.remove(&id);
        }
        finish(&root, &id, status, detail);
    });
    run_id
}

async fn execute(root: &Path, bot: &BoxBot, log_path: &Path, limit: Duration, signal: Arc<Notify>) -> Result<i32, String> {
    if !valid_id(&bot.id) {
        return Err("This bot's id is not valid.".into());
    }
    let cwd = home(root, &bot.id);
    std::fs::create_dir_all(&cwd).map_err(|e| format!("Could not create the bot's folder: {e}"))?;
    let mcp_path = dir(root).join("mcp.json");
    let keys = if bot.connectors { std::fs::read_to_string(&mcp_path).map(|c| mcp_keys(&c)).unwrap_or_default() } else { vec![] };
    let mcp = (!keys.is_empty()).then_some((mcp_path.as_path(), keys.as_slice()));
    let argv = bot_command(bot, mcp)?;
    spawn_headless(&argv, &cwd, log_path, ("SPACRON_BOT", &bot.name), limit, Some(signal)).await
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
    fn claude_flags_follow_the_access_level_and_keep_the_prompt_last() {
        let mut b = parsed(bot("a", vec![]));
        let research = bot_command(&b, None).unwrap();
        assert_eq!(&research[..2], ["claude", "-p"]);
        assert!(research.windows(2).any(|w| w == ["--permission-mode", "dontAsk"]));
        assert!(research.contains(&"WebSearch".to_string()) && !research.contains(&"Write".to_string()));
        assert!(research.last().unwrap().ends_with("Summarise the news."));

        b.access = Access::Folder;
        let keys = vec!["spacron-linear".to_string()];
        let folder = bot_command(&b, Some((Path::new("/m.json"), &keys))).unwrap();
        let at = |s: &str| folder.iter().position(|x| x == s).unwrap();
        assert!(folder.windows(2).any(|w| w == ["--mcp-config", "/m.json"]));
        assert!(folder.contains(&"mcp__spacron-linear".to_string()) && folder.contains(&"Write".to_string()));
        // Each list option is closed by the next option, never by the prompt.
        assert!(at("--mcp-config") < at("--allowedTools") && at("--allowedTools") < at("--permission-mode"));
        assert_eq!(at("--permission-mode") + 2, folder.len() - 1);

        b.access = Access::Full;
        let full = bot_command(&b, None).unwrap();
        assert!(full.windows(2).any(|w| w == ["--permission-mode", "bypassPermissions"]));
        assert!(!full.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn other_agents_get_their_own_flags_in_the_right_place() {
        let mut b = parsed(bot("a", vec![]));
        b.agent = "codex".into();
        b.access = Access::Folder;
        let codex = bot_command(&b, None).unwrap();
        assert_eq!(&codex[..4], ["codex", "exec", "--sandbox", "workspace-write"]);
        b.agent = "gemini".into();
        b.access = Access::Full;
        let gemini = bot_command(&b, None).unwrap();
        let n = gemini.len();
        assert_eq!(gemini[n - 3], "--yolo");
        assert_eq!(gemini[n - 2], "-p", "-p still sits right before its prompt");
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
            status: "completed".into(), trigger: "manual".into(), detail: None, log: Some(rel.into()),
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
            status: "running".into(), trigger: "manual".into(), detail: None, log: None,
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

    #[test]
    fn run_now_needs_a_synced_bot() {
        let dir = tempfile::tempdir().unwrap();
        assert!(run_now(json!({ "id": "nope" }), dir.path()).is_err());
    }
}
