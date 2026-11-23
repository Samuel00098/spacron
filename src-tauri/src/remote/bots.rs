//! Bots: agents that live on the box, outside every project, and work for you
//! on a schedule or on demand while the laptop is closed.
//!
//! A bot is an automation that is not tied to a project folder. Each bot gets
//! its own home folder on the box, which persists between runs, so a bot can
//! keep notes, drafts and results from one run to the next.
//!
//! Scheduling works exactly like automations (see `automations.rs`): the
//! desktop owns the schedule language and the time zone, so it sends each
//! bot's upcoming run times as epoch milliseconds and the box only notices
//! that a time has passed. Agents run through the same headless spawner.
//!
//! Files, all under `<workspace>/.spacron/bots/` (git-excluded with the rest
//! of `.spacron/`):
//! - `bots.json`  — what the desktop last synced
//! - `runs.json`  — run records, newest first
//! - `fired.json` — the last occurrence handled per bot
//! - `logs/<run id>.log`
//! - `home/<bot id>/` — the bot's own working folder

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::automations::{agent_command, due, now_ms, read_json, spawn_headless, write_json};

const TICK: Duration = Duration::from_secs(30);
const MAX_RUNS: usize = 300;
/// The most of a log `box_bot_log` sends back; the start is trimmed.
const MAX_LOG_BYTES: usize = 64 * 1024;
const MAX_INSTRUCTIONS: usize = 20_000;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BoxBot {
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
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BotsConfig {
    #[serde(default)]
    pub bots: Vec<BoxBot>,
    /// Master switch: when off, no schedule fires.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// How late a run may still start; 0 means only on time (one tick of slack).
    #[serde(default = "fifteen")]
    pub catch_up_minutes: u64,
}

fn yes() -> bool { true }
fn fifteen() -> u64 { 15 }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct BotRun {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub started_at: u64,
    #[serde(default)]
    pub finished_at: Option<u64>,
    /// running | completed | failed | missed | interrupted
    pub status: String,
    /// manual | schedule
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// Workspace-relative log path.
    #[serde(default)]
    pub log: Option<String>,
}

fn dir(workspace: &Path) -> PathBuf {
    workspace.join(".spacron").join("bots")
}

/// A bot's own working folder. Ids are checked by [`valid_id`] before they
/// reach a path, so this never escapes `home/`.
fn home(workspace: &Path, bot_id: &str) -> PathBuf {
    dir(workspace).join("home").join(bot_id)
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

fn update_runs(workspace: &Path, f: impl FnOnce(&mut Vec<BotRun>)) {
    let _guard = file_lock().lock();
    let path = dir(workspace).join("runs.json");
    let mut runs: Vec<BotRun> = read_json(&path);
    f(&mut runs);
    runs.truncate(MAX_RUNS);
    let _ = write_json(&path, &runs);
}

/// What the agent is told on every run: who it is, that its folder persists,
/// and that nobody is there to answer questions.
pub(super) fn bot_prompt(bot: &BoxBot) -> String {
    format!(
        "You are \"{name}\", a Spacron bot running unattended on a server. \
Your current folder is your own home folder and it persists between runs: keep anything you want \
to remember next time there (for example a NOTES.md file), and save results there as files. \
Nobody is watching this run, so do not wait for input or ask questions; do the work and finish \
with a short summary of what you did.\n\nYour job:\n{instructions}",
        name = bot.name.trim(),
        instructions = bot.instructions.trim(),
    )
}

// ── invoke handlers (called from the server's dispatch) ─────────────────────

/// `box_bots_sync`: replace the box's bots with the desktop's list. Bots are
/// not scoped to a project, so a sync always covers all of them.
pub(super) fn sync(args: Value, workspace: &Path) -> Result<Value, String> {
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
    let count = incoming.bots.len();
    let _guard = file_lock().lock();
    write_json(&dir(workspace).join("bots.json"), &incoming)?;
    Ok(json!({ "ok": true, "count": count }))
}

/// `box_bots_state`: run records, newest first, plus where bot homes live.
pub(super) fn state(workspace: &Path) -> Result<Value, String> {
    let runs: Vec<BotRun> = read_json(&dir(workspace).join("runs.json"));
    Ok(json!({
        "runs": runs,
        "homeRoot": dir(workspace).join("home").to_string_lossy(),
    }))
}

/// `box_bot_run_now`: start one bot immediately.
pub(super) fn run_now(args: Value, workspace: &Path) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing bot id.")?;
    let config: BotsConfig = read_json(&dir(workspace).join("bots.json"));
    let bot = config.bots.into_iter().find(|b| b.id == id).ok_or("This bot has not been synced to the box yet.")?;
    if is_running(workspace, id) {
        return Err("This bot is already running.".into());
    }
    let run_id = start_run(workspace.to_path_buf(), bot, "manual");
    Ok(json!({ "runId": run_id }))
}

/// `box_bot_log`: the tail of one run's log. Looked up by run id rather than
/// by path, so the desktop can only read logs this runner wrote.
pub(super) fn log(args: Value, workspace: &Path) -> Result<Value, String> {
    let run_id = args.get("runId").and_then(|v| v.as_str()).ok_or("Missing run id.")?;
    let runs: Vec<BotRun> = read_json(&dir(workspace).join("runs.json"));
    let run = runs.iter().find(|r| r.id == run_id).ok_or("No such run.")?;
    let Some(rel) = run.log.as_deref() else { return Ok(json!({ "text": "", "truncated": false })) };
    let bytes = std::fs::read(workspace.join(rel)).unwrap_or_default();
    let truncated = bytes.len() > MAX_LOG_BYTES;
    let tail = if truncated { &bytes[bytes.len() - MAX_LOG_BYTES..] } else { &bytes[..] };
    Ok(json!({ "text": String::from_utf8_lossy(tail), "truncated": truncated }))
}

// ── scheduling ──────────────────────────────────────────────────────────────

fn is_running(workspace: &Path, bot_id: &str) -> bool {
    let runs: Vec<BotRun> = read_json(&dir(workspace).join("runs.json"));
    runs.iter().any(|r| r.bot_id == bot_id && r.status == "running")
}

/// The tick loop. Started once by `serve`.
pub(super) async fn run_loop(workspace: PathBuf) {
    // A run that was going when the server stopped can never report.
    update_runs(&workspace, |runs| {
        for r in runs.iter_mut().filter(|r| r.status == "running") {
            r.status = "interrupted".into();
            r.finished_at = Some(now_ms());
            r.detail = Some("The server restarted during this run.".into());
        }
    });
    loop {
        tick(&workspace);
        tokio::time::sleep(TICK).await;
    }
}

fn tick(workspace: &Path) {
    let config: BotsConfig = read_json(&dir(workspace).join("bots.json"));
    if !config.enabled {
        return;
    }
    let fired_path = dir(workspace).join("fired.json");
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
            update_runs(workspace, |runs| runs.insert(0, BotRun {
                id: uuid::Uuid::new_v4().to_string(), bot_id: id, name, started_at: now, finished_at: Some(now),
                status: "missed".into(), trigger: "schedule".into(),
                detail: Some("The scheduled time passed while the box could not run it.".into()), log: None,
            }));
        } else if !is_running(workspace, &b.id) {
            start_run(workspace.to_path_buf(), b, "schedule");
        }
    }
    if changed {
        let _guard = file_lock().lock();
        let _ = write_json(&fired_path, &fired);
    }
}

// ── running ─────────────────────────────────────────────────────────────────

fn start_run(workspace: PathBuf, bot: BoxBot, trigger: &str) -> String {
    let run_id = uuid::Uuid::new_v4().to_string();
    let log_rel = format!(".spacron/bots/logs/{run_id}.log");
    let run = BotRun {
        id: run_id.clone(), bot_id: bot.id.clone(), name: bot.name.clone(), started_at: now_ms(), finished_at: None,
        status: "running".into(), trigger: trigger.into(), detail: None, log: Some(log_rel.clone()),
    };
    update_runs(&workspace, |runs| runs.insert(0, run));
    let id = run_id.clone();
    tokio::spawn(async move {
        let (status, detail) = match execute(&workspace, &bot, &workspace.join(&log_rel)).await {
            Ok(0) => ("completed", None),
            Ok(code) => ("failed", Some(format!("The agent exited with code {code}. See the log."))),
            Err(e) => ("failed", Some(e)),
        };
        update_runs(&workspace, |runs| {
            if let Some(r) = runs.iter_mut().find(|r| r.id == id) {
                r.status = status.into();
                r.finished_at = Some(now_ms());
                r.detail = detail;
            }
        });
    });
    run_id
}

async fn execute(workspace: &Path, bot: &BoxBot, log_path: &Path) -> Result<i32, String> {
    if !valid_id(&bot.id) {
        return Err("This bot's id is not valid.".into());
    }
    let cwd = home(workspace, &bot.id);
    std::fs::create_dir_all(&cwd).map_err(|e| format!("Could not create the bot's folder: {e}"))?;
    let argv = agent_command(&bot.agent, &bot_prompt(bot), bot.model.as_deref())?;
    spawn_headless(&argv, &cwd, log_path, ("SPACRON_BOT", &bot.name)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: &str, occurrences: Vec<u64>) -> Value {
        json!({ "id": id, "name": "Digest", "instructions": "Summarise the news.", "agent": "claude", "enabled": true, "occurrences": occurrences })
    }

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
    fn sync_replaces_the_whole_list() {
        let dir = tempfile::tempdir().unwrap();
        sync(json!({ "bots": [bot("a", vec![1]), bot("b", vec![])] }), dir.path()).unwrap();
        sync(json!({ "bots": [bot("c", vec![])], "enabled": false, "catchUpMinutes": 5 }), dir.path()).unwrap();
        let saved: BotsConfig = read_json(&super::dir(dir.path()).join("bots.json"));
        assert_eq!(saved.bots.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["c"]);
        assert!(!saved.enabled);
        assert_eq!(saved.catch_up_minutes, 5);
    }

    #[test]
    fn the_prompt_names_the_bot_and_carries_its_job() {
        let b: BoxBot = serde_json::from_value(bot("a", vec![])).unwrap();
        let p = bot_prompt(&b);
        assert!(p.contains("\"Digest\""));
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
        assert_eq!(runs[0].status, "missed");
        assert_eq!(runs[0].trigger, "schedule");
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
    fn run_now_needs_a_synced_bot() {
        let dir = tempfile::tempdir().unwrap();
        assert!(run_now(json!({ "id": "nope" }), dir.path()).is_err());
    }
}
