//! Automations that run on the box, so they fire while the laptop is closed.
//!
//! The desktop owns the schedule language and the user's time zone, so it does
//! not send rules — it sends each automation's upcoming run times as epoch
//! milliseconds (`occurrences`, about two weeks' worth), recomputed every time
//! it connects. The box only has to notice that a time has passed. A laptop that
//! stays away longer than the window simply stops scheduling new runs, which is
//! visible in Run history rather than silently wrong.
//!
//! Each run starts the agent CLI in its headless mode (`claude -p`, `codex
//! exec`, `gemini -p`, `opencode run`) in the workspace, through a login shell
//! on Unix so a server started from cron still finds CLIs installed under the
//! user's PATH, and writes everything it prints to a log the desktop reads back.
//!
//! Files, all under `<workspace>/.spacron/automations/` (git-excluded with the
//! rest of `.spacron/`):
//! - `box.json`   — what the desktop last synced
//! - `runs.json`  — run records, newest first
//! - `fired.json` — the last occurrence handled per automation
//! - `logs/<run id>.log`

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A run that has not finished after this long is stopped.
const RUN_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const TICK: Duration = Duration::from_secs(30);

/// The program to spawn for an agent CLI given by bare name on this box.
///
/// On a Windows box most agent CLIs are npm `.cmd` shims, and
/// `Command::new("claude")` only looks for `claude.exe`, so the run failed with
/// "program not found". Resolving through PATH/PATHEXT gives the shim's full
/// path, which Rust's std then starts through cmd.exe with its own safe
/// argument escaping (it refuses arguments it cannot escape rather than
/// passing them through). Paths and non-Windows boxes are left alone: there a
/// login shell or the OS does the lookup.
pub(crate) fn resolve_agent_program(program: &str) -> String {
    if cfg!(windows) && !program.contains(['/', '\\']) {
        if let Some(path) = crate::commands::agent_probe::which(program) {
            return path.to_string_lossy().to_string();
        }
    }
    program.to_string()
}
const MAX_RUNS: usize = 200;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BoxAutomation {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// The agent's launch command as the desktop knows it, e.g. `claude`.
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    pub enabled: bool,
    /// Upcoming run times, epoch ms, ascending.
    #[serde(default)]
    pub occurrences: Vec<u64>,
    /// The project folder it runs in (inside the box folder). `None` is the
    /// box folder itself, for automations saved before folders could be opened.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BoxConfig {
    #[serde(default)]
    pub automations: Vec<BoxAutomation>,
    /// Master switch from Settings > Automations.
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
pub(super) struct BoxRun {
    pub id: String,
    pub automation_id: String,
    pub name: String,
    pub started_at: u64,
    #[serde(default)]
    pub finished_at: Option<u64>,
    /// running | completed | failed | missed | interrupted
    pub status: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// Workspace-relative log path.
    #[serde(default)]
    pub log: Option<String>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn dir(workspace: &Path) -> PathBuf {
    workspace.join(".spacron").join("automations")
}

/// One writer at a time for the JSON files: the tick loop and `run now` both touch them.
fn file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn update_runs(workspace: &Path, f: impl FnOnce(&mut Vec<BoxRun>)) {
    let _guard = file_lock().lock();
    let path = dir(workspace).join("runs.json");
    let mut runs: Vec<BoxRun> = read_json(&path);
    f(&mut runs);
    runs.truncate(MAX_RUNS);
    let _ = write_json(&path, &runs);
}

// ── invoke handlers (called from the server's dispatch) ─────────────────────

/// The folder an automation runs in: its own project folder when that is still
/// a folder inside the box folder, else the box folder.
fn run_dir(workspace: &Path, cwd: Option<&str>) -> PathBuf {
    cwd.and_then(|c| std::fs::canonicalize(c).ok())
        .map(crate::commands::clean_path_buf)
        .filter(|c| c.starts_with(workspace) && c.is_dir())
        .unwrap_or_else(|| workspace.to_path_buf())
}

/// `box_automations_sync`: replace one project folder's automations. Each
/// desktop sync covers only the project it has open (`projectRoot`), so the
/// other folders' automations on this box are kept as they are.
pub(super) fn sync(args: Value, workspace: &Path) -> Result<Value, String> {
    let project = args.get("projectRoot").and_then(|v| v.as_str()).map(|p| run_dir(workspace, Some(p)));
    let incoming: BoxConfig = serde_json::from_value(args).map_err(|e| format!("Invalid automation sync: {e}"))?;
    for a in &incoming.automations {
        if a.id.trim().is_empty() || a.prompt.trim().is_empty() {
            return Err("Every automation needs an id and a prompt.".into());
        }
        agent_command(&a.agent, &a.prompt, a.model.as_deref())?;
    }
    let project = project.unwrap_or_else(|| workspace.to_path_buf());
    let _guard = file_lock().lock();
    let path = dir(workspace).join("box.json");
    let existing: BoxConfig = read_json(&path);
    let mut automations: Vec<BoxAutomation> = existing
        .automations
        .into_iter()
        .filter(|a| run_dir(workspace, a.cwd.as_deref()) != project)
        .collect();
    let count = incoming.automations.len();
    automations.extend(incoming.automations.into_iter().map(|mut a| {
        a.cwd = Some(project.to_string_lossy().to_string());
        a
    }));
    write_json(&path, &BoxConfig { automations, enabled: incoming.enabled, catch_up_minutes: incoming.catch_up_minutes })?;
    Ok(json!({ "ok": true, "count": count }))
}

/// `box_automations_state`: run records, newest first, each with the absolute
/// `logPath` so a desktop with a sub-folder open can still read it.
pub(super) fn state(workspace: &Path) -> Result<Value, String> {
    let runs: Vec<BoxRun> = read_json(&dir(workspace).join("runs.json"));
    let mut value = serde_json::to_value(runs).map_err(|e| e.to_string())?;
    for run in value.as_array_mut().into_iter().flatten() {
        if let Some(log) = run["log"].as_str() {
            run["logPath"] = json!(workspace.join(log).to_string_lossy());
        }
    }
    Ok(value)
}

/// `box_automation_run_now`: start one automation immediately.
pub(super) fn run_now(args: Value, workspace: &Path) -> Result<Value, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing automation id.")?;
    let config: BoxConfig = read_json(&dir(workspace).join("box.json"));
    let automation = config.automations.into_iter().find(|a| a.id == id)
        .ok_or("This automation has not been synced to the box yet.")?;
    if is_running(workspace, id) {
        return Err("This automation already has an active run.".into());
    }
    let run_id = start_run(workspace.to_path_buf(), automation);
    Ok(json!({ "runId": run_id }))
}

// ── scheduling ──────────────────────────────────────────────────────────────

fn is_running(workspace: &Path, automation_id: &str) -> bool {
    let runs: Vec<BoxRun> = read_json(&dir(workspace).join("runs.json"));
    runs.iter().any(|r| r.automation_id == automation_id && r.status == "running")
}

/// What one tick should do for one automation: the latest occurrence that has
/// passed since the last one handled, and whether it is still within reach.
pub(crate) fn due(occurrences: &[u64], last_fired: u64, now: u64, catch_up_minutes: u64) -> Option<(u64, bool)> {
    let latest = occurrences.iter().copied().filter(|&o| o > last_fired && o <= now).max()?;
    let window = catch_up_minutes.max(1) * 60_000;
    Some((latest, now - latest <= window))
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
    let config: BoxConfig = read_json(&dir(workspace).join("box.json"));
    if !config.enabled {
        return;
    }
    let fired_path = dir(workspace).join("fired.json");
    let mut fired: HashMap<String, u64> = read_json(&fired_path);
    let now = now_ms();
    let mut changed = false;
    for a in config.automations.into_iter().filter(|a| a.enabled) {
        let last = fired.get(&a.id).copied().unwrap_or(0);
        let Some((occurrence, in_reach)) = due(&a.occurrences, last, now, config.catch_up_minutes) else { continue };
        fired.insert(a.id.clone(), occurrence);
        changed = true;
        if !in_reach {
            let (id, name) = (a.id.clone(), a.name.clone());
            update_runs(workspace, |runs| runs.insert(0, BoxRun {
                id: uuid::Uuid::new_v4().to_string(), automation_id: id, name, started_at: now, finished_at: Some(now),
                status: "missed".into(), detail: Some("The scheduled time passed while the box could not run it.".into()), log: None,
            }));
        } else if !is_running(workspace, &a.id) {
            start_run(workspace.to_path_buf(), a);
        }
    }
    if changed {
        let _guard = file_lock().lock();
        let _ = write_json(&fired_path, &fired);
    }
}

// ── running ─────────────────────────────────────────────────────────────────

/// The headless invocation for an agent, or why it cannot run unattended.
pub(crate) fn agent_command(agent: &str, prompt: &str, model: Option<&str>) -> Result<Vec<String>, String> {
    let mut parts = agent.split_whitespace().map(str::to_string);
    let exe = parts.next().ok_or("No agent chosen.")?;
    let extra: Vec<String> = parts.collect();
    let name = Path::new(&exe).file_stem().and_then(|s| s.to_str()).unwrap_or(&exe).to_ascii_lowercase();
    let model = model.filter(|m| !m.is_empty() && *m != "default");
    let mut cmd = vec![exe.clone()];
    cmd.extend(extra);
    match name.as_str() {
        "claude" => { cmd.push("-p".into()); if let Some(m) = model { cmd.extend(["--model".into(), m.into()]); } }
        "codex" => { cmd.push("exec".into()); if let Some(m) = model { cmd.extend(["-m".into(), m.into()]); } }
        "gemini" => { if let Some(m) = model { cmd.extend(["-m".into(), m.into()]); } cmd.push("-p".into()); }
        "opencode" => { cmd.push("run".into()); if let Some(m) = model { cmd.extend(["-m".into(), m.into()]); } }
        _ => return Err(format!("'{exe}' has no headless mode Spacron knows, so it cannot run on the box unattended. Use Claude Code, Codex, Gemini CLI or opencode.")),
    }
    cmd.push(prompt.to_string());
    Ok(cmd)
}

fn start_run(workspace: PathBuf, automation: BoxAutomation) -> String {
    let run_id = uuid::Uuid::new_v4().to_string();
    let log_rel = format!(".spacron/automations/logs/{run_id}.log");
    let run = BoxRun {
        id: run_id.clone(), automation_id: automation.id.clone(), name: automation.name.clone(),
        started_at: now_ms(), finished_at: None, status: "running".into(), detail: None, log: Some(log_rel.clone()),
    };
    update_runs(&workspace, |runs| runs.insert(0, run));
    let id = run_id.clone();
    tokio::spawn(async move {
        let (status, detail) = match execute(&workspace, &automation, &workspace.join(&log_rel)).await {
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

async fn execute(workspace: &Path, a: &BoxAutomation, log_path: &Path) -> Result<i32, String> {
    let argv = agent_command(&a.agent, &a.prompt, a.model.as_deref())?;
    spawn_headless(&argv, &run_dir(workspace, a.cwd.as_deref()), log_path, ("SPACRON_AUTOMATION", &a.name), RUN_TIMEOUT, None).await
}

/// What `spawn_headless` reports when a run was stopped through its cancel signal.
pub(crate) const STOPPED_BY_USER: &str = "Stopped by you.";

/// Run one headless agent invocation in `cwd`, writing everything it prints to
/// `log_path`, and wait for it. It is stopped after `limit`, or as soon as
/// `cancel` is notified. Shared by automations and bots so both start agents
/// the same way.
///
/// The agent gets its own process group (Unix) so stopping it also stops what
/// it started (MCP servers, node workers); on Windows the tree is killed.
pub(crate) async fn spawn_headless(
    argv: &[String],
    cwd: &Path,
    log_path: &Path,
    env: (&str, &str),
    limit: Duration,
    cancel: Option<std::sync::Arc<tokio::sync::Notify>>,
) -> Result<i32, String> {
    if argv.is_empty() {
        return Err("No agent command.".into());
    }
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let log = std::fs::File::create(log_path).map_err(|e| format!("Could not create the run log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new(resolve_agent_program(&argv[0]));
        c.args(&argv[1..]);
        c
    } else {
        // A login shell, so a server started at boot finds CLIs on the user's PATH.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = tokio::process::Command::new(shell);
        c.arg("-lc").arg("exec \"$0\" \"$@\"").args(argv);
        c
    };
    #[cfg(unix)]
    command.process_group(0);
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .env(env.0, env.1)
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Could not start {}: {e}", argv[0]))?;
    let cancelled = async {
        match &cancel {
            Some(signal) => signal.notified().await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        status = child.wait() => Ok(status.map_err(|e| e.to_string())?.code().unwrap_or(-1)),
        _ = tokio::time::sleep(limit) => {
            kill_tree(&mut child).await;
            let minutes = (limit.as_secs() / 60).max(1);
            Err(format!("Stopped after {minutes} minute{} without finishing.", if minutes == 1 { "" } else { "s" }))
        }
        _ = cancelled => {
            kill_tree(&mut child).await;
            Err(STOPPED_BY_USER.into())
        }
    }
}

/// Stop an agent and everything it started.
async fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        let _ = tokio::process::Command::new("kill").args(["-TERM", "--"]).arg(format!("-{pid}")).status().await;
        #[cfg(windows)]
        let _ = tokio::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).status().await;
        // A moment to exit cleanly before the hard kill below.
        if tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_ok() {
            return;
        }
        #[cfg(unix)]
        let _ = tokio::process::Command::new("kill").args(["-KILL", "--"]).arg(format!("-{pid}")).status().await;
    }
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_unknown_programs_pass_through() {
        assert_eq!(resolve_agent_program("/usr/local/bin/claude"), "/usr/local/bin/claude");
        assert_eq!(resolve_agent_program(r"C:\tools\claude.cmd"), r"C:\tools\claude.cmd");
        assert_eq!(resolve_agent_program("spacron-no-such-agent-xyz"), "spacron-no-such-agent-xyz");
    }

    /// The Windows-box case: an npm-style `.cmd` shim found by bare name, run
    /// with a prompt full of cmd metacharacters that must arrive as one intact
    /// argument rather than being split or executed.
    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_is_found_by_bare_name_and_gets_its_arguments_intact() {
        let dir = std::env::temp_dir().join(format!("spacron-shim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spacron-fake-agent.cmd"), "@echo ARG=%1\r\n").unwrap();
        let old = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![dir.clone()];
        paths.extend(std::env::split_paths(&old));
        std::env::set_var("PATH", std::env::join_paths(paths).unwrap());

        let program = resolve_agent_program("spacron-fake-agent");
        assert!(program.to_ascii_lowercase().ends_with("spacron-fake-agent.cmd"), "{program}");
        let out = std::process::Command::new(&program)
            .arg("fix this & that | now")
            .output()
            .expect("the shim starts");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("ARG=\"fix this & that | now\""), "{text}");

        std::env::set_var("PATH", old);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn due_picks_the_latest_passed_occurrence_and_checks_reach() {
        let occ = [1_000, 2_000, 3_000, 10_000_000];
        assert_eq!(due(&occ, 0, 3_500, 15), Some((3_000, true)));
        assert_eq!(due(&occ, 3_000, 3_500, 15), None);
        assert_eq!(due(&occ, 0, 3_000 + 16 * 60_000, 15), Some((3_000, false)));
        assert_eq!(due(&occ, 0, 500, 15), None);
    }

    #[test]
    fn headless_commands_per_agent() {
        assert_eq!(agent_command("claude", "hi", None).unwrap(), ["claude", "-p", "hi"]);
        assert_eq!(agent_command("codex", "hi", Some("gpt-5")).unwrap(), ["codex", "exec", "-m", "gpt-5", "hi"]);
        assert_eq!(agent_command("gemini", "hi", None).unwrap(), ["gemini", "-p", "hi"]);
        assert_eq!(agent_command("claude --verbose", "hi", Some("default")).unwrap(), ["claude", "--verbose", "-p", "hi"]);
        assert!(agent_command("aider", "hi", None).is_err());
    }

    #[test]
    fn sync_rejects_agents_without_a_headless_mode_and_saves_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let bad = json!({ "automations": [{ "id": "a", "name": "x", "prompt": "p", "agent": "aider", "enabled": true }] });
        assert!(sync(bad, dir.path()).is_err());
        let good = json!({ "automations": [{ "id": "a", "name": "x", "prompt": "p", "agent": "claude", "enabled": true, "occurrences": [1] }], "enabled": true, "catchUpMinutes": 15 });
        sync(good, dir.path()).unwrap();
        let saved: BoxConfig = read_json(&super::dir(dir.path()).join("box.json"));
        assert_eq!(saved.automations[0].occurrences, vec![1]);
    }

    #[test]
    fn syncing_one_folder_keeps_the_other_folders_automations() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = crate::commands::clean_path_buf(std::fs::canonicalize(tmp.path()).unwrap());
        for name in ["app", "api"] { std::fs::create_dir(ws.join(name)).unwrap(); }
        let one = |id: &str, folder: &str| json!({ "projectRoot": ws.join(folder).to_string_lossy(),
            "automations": [{ "id": id, "name": id, "prompt": "p", "agent": "claude", "enabled": true }] });
        sync(one("a", "app"), &ws).unwrap();
        sync(one("b", "api"), &ws).unwrap();
        sync(one("a2", "app"), &ws).unwrap();
        let saved: BoxConfig = read_json(&super::dir(&ws).join("box.json"));
        let mut ids: Vec<_> = saved.automations.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["a2", "b"]);
        assert!(saved.automations.iter().all(|a| a.cwd.as_deref().is_some_and(|c| c.starts_with(&*ws.to_string_lossy()))));
    }

    #[test]
    fn a_missed_occurrence_is_recorded_and_not_run() {
        let dir = tempfile::tempdir().unwrap();
        let old = now_ms() - 2 * 60 * 60_000;
        sync(json!({ "automations": [{ "id": "a", "name": "Review", "prompt": "p", "agent": "claude", "enabled": true, "occurrences": [old] }], "enabled": true, "catchUpMinutes": 15 }), dir.path()).unwrap();
        tick(dir.path());
        let runs: Vec<BoxRun> = read_json(&super::dir(dir.path()).join("runs.json"));
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "missed");
        tick(dir.path());
        let runs: Vec<BoxRun> = read_json(&super::dir(dir.path()).join("runs.json"));
        assert_eq!(runs.len(), 1, "the same occurrence is handled once");
    }
}
