//! Provider-native model catalogue probes used by Chat mode.
//!
//! The provider name is matched against a fixed allow-list and never becomes a
//! shell command. On Windows `cmd.exe` is used only so npm `.cmd` shims resolve
//! correctly; every program and argument below is compile-time controlled.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::State;
use crate::state::AppState;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// `opencode models` refreshes its provider registry before printing, which
/// routinely takes ~15s on Windows, and a cold `codex app-server` start takes
/// up to ~10s — the normal budget cut both off.
const SLOW_PROBE_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_OUTPUT_BYTES: u64 = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
    pub is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelProbe {
    pub output: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub models: Option<Vec<AgentModel>>,
}

impl AgentModelProbe {
    fn failed(error: impl Into<String>) -> Self {
        Self {
            output: String::new(),
            exit_code: None,
            error: Some(error.into()),
            models: None,
        }
    }
}

/// Build the probe command. The program is resolved with the same search the
/// agent detector uses, and the child gets that merged PATH: a GUI-launched
/// app's own PATH is frozen at launch and often lacks the npm global dir, so a
/// bare `codex` failed with "'codex' is not recognized" even though every
/// terminal found it — and the picker only ever showed "CLI default".
fn provider_command(program: &str, args: &[&str]) -> Command {
    let resolved = super::agent_probe::which(program);
    let search_path = super::agent_probe::search_path();
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let program_text = resolved
            .as_ref()
            .map(|path| format!("\"{}\"", path.display()))
            .unwrap_or_else(|| program.to_string());
        let mut command = Command::new("cmd.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        // `/S` strips exactly one pair of outer quotes, which keeps the quoted
        // program path intact. `raw_arg` stops Rust from backslash-escaping
        // those quotes, which cmd.exe does not understand.
        command.args(["/D", "/S", "/C"]);
        command.raw_arg(format!(
            "\"{}\"",
            std::iter::once(program_text.as_str())
                .chain(args.iter().copied())
                .collect::<Vec<_>>()
                .join(" ")
        ));
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(resolved.as_deref().unwrap_or(std::path::Path::new(program)));
        command.args(args);
        command
    };
    if let Some(path) = search_path {
        command.env("PATH", path);
    }
    command
}

fn terminate(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn capture(program: &str, args: &[&str], timeout: Duration) -> AgentModelProbe {
    let mut child = match provider_command(program, args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return AgentModelProbe::failed(format!("Could not start {program}: {error}"))
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stdout {
            let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
        }
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stderr {
            let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
        }
        bytes
    });

    let deadline = Instant::now() + timeout;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            Ok(None) => {
                terminate(&mut child);
                return AgentModelProbe::failed(format!(
                    "{program} did not return a model list in time"
                ));
            }
            Err(error) => {
                terminate(&mut child);
                return AgentModelProbe::failed(format!("Could not read {program}: {error}"));
            }
        }
    };

    let mut output = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    output.push_str(&String::from_utf8_lossy(&err.join().unwrap_or_default()));
    AgentModelProbe {
        output,
        exit_code,
        error: None,
        models: None,
    }
}

/// Fall back to the selected account's own cache if a live model request fails.
fn codex_cached_models() -> Option<AgentModelProbe> {
    let codex_home = super::agent_accounts::selected_codex_home()?;
    let text = std::fs::read_to_string(codex_home.join("models_cache.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let configured = std::fs::read_to_string(codex_home.join("config.toml"))
        .ok()
        .and_then(|config| codex_configured_model(&config));
    parse_codex_cache(&value, configured.as_deref())
}

/// The top-level `model = "..."` from Codex's config.toml — the model a bare
/// `codex` launch runs. Keys inside `[tables]` belong to profiles/providers.
fn codex_configured_model(config: &str) -> Option<String> {
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            return None;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "model" {
            let value = value.split('#').next().unwrap_or_default().trim();
            let value = value.trim_matches(|c| c == '"' || c == '\'');
            return (!value.is_empty()).then(|| value.to_owned());
        }
    }
    None
}

fn parse_codex_cache(value: &serde_json::Value, configured: Option<&str>) -> Option<AgentModelProbe> {
    let mut entries: Vec<&serde_json::Value> = value
        .get("models")?
        .as_array()?
        .iter()
        // Mirrors `model/list` with `includeHidden: false`.
        .filter(|model| model.get("visibility").and_then(|v| v.as_str()) == Some("list"))
        .collect();
    entries.sort_by_key(|model| model.get("priority").and_then(|v| v.as_i64()).unwrap_or(i64::MAX));

    let mut output = String::new();
    let mut model_list = Vec::new();
    for model in entries {
        let Some(id) = model.get("slug").and_then(|v| v.as_str()) else {
            continue;
        };
        let label = model.get("display_name").and_then(|v| v.as_str()).unwrap_or(id);
        let reasoning_efforts = model
            .get("supported_reasoning_levels")
            .and_then(|v| v.as_array())
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|level| level.get("effort").and_then(|v| v.as_str()).map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        model_list.push(AgentModel {
            id: id.to_owned(),
            label: label.to_owned(),
            description: model.get("description").and_then(|v| v.as_str()).map(str::to_owned),
            reasoning_efforts,
            default_reasoning_effort: model
                .get("default_reasoning_level")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            is_default: configured == Some(id),
        });
        output.push_str(id);
        output.push_str(" - ");
        output.push_str(label);
        output.push('\n');
    }
    if model_list.is_empty() {
        return None;
    }
    // No configured model (or one the cache does not list): Codex falls back
    // to its highest-priority model.
    if !model_list.iter().any(|model| model.is_default) {
        model_list[0].is_default = true;
    }
    Some(AgentModelProbe {
        output,
        exit_code: Some(0),
        error: None,
        models: Some(model_list),
    })
}

fn codex_models() -> AgentModelProbe {
    let live = codex_live_models();
    if live.exit_code == Some(0) {
        return live;
    }
    codex_cached_models().unwrap_or(live)
}

fn codex_live_models() -> AgentModelProbe {
    let mut command = provider_command("codex", &["app-server", "--stdio"]);
    if let Some(home) = super::agent_accounts::selected_codex_home() {
        command.env("CODEX_HOME", home);
    }
    let mut child = match command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return AgentModelProbe::failed(format!("Could not start Codex app server: {error}"))
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        terminate(&mut child);
        return AgentModelProbe::failed("Codex app server stdin was unavailable");
    };
    let Some(stdout) = child.stdout.take() else {
        terminate(&mut child);
        return AgentModelProbe::failed("Codex app server stdout was unavailable");
    };
    let stderr = child.stderr.take();
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stderr {
            let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
        }
        bytes
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let requests = [
        r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"spacron","version":"5.0.0"},"capabilities":{"experimentalApi":true}}}"#,
        r#"{"method":"initialized","params":{}}"#,
        r#"{"id":2,"method":"model/list","params":{"limit":100,"includeHidden":false}}"#,
    ];
    for request in requests {
        if writeln!(stdin, "{request}").is_err() {
            terminate(&mut child);
            return AgentModelProbe::failed("Could not write to Codex app server");
        }
    }
    let _ = stdin.flush();

    // A cold `codex app-server` start measured 4-10s, right at the normal
    // budget; the loop returns the moment model/list answers, so the longer
    // ceiling only costs time when Codex is genuinely stuck.
    let deadline = Instant::now() + SLOW_PROBE_TIMEOUT;
    let mut model_output = String::new();
    let mut model_list = Vec::new();
    let mut protocol_error: Option<String> = None;
    while Instant::now() < deadline {
        let wait = (deadline - Instant::now()).min(Duration::from_millis(250));
        let Ok(line) = rx.recv_timeout(wait) else {
            // A server that already exited (not installed, crashed on start)
            // will never answer; fail now rather than at the deadline.
            if matches!(child.try_wait(), Ok(Some(_))) && rx.try_recv().is_err() {
                break;
            }
            continue;
        };
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(|id| id.as_i64()) != Some(2) {
            continue;
        }
        if let Some(error) = message.get("error") {
            protocol_error = Some(error.to_string());
            break;
        }
        if let Some(models) = message
            .pointer("/result/data")
            .and_then(|data| data.as_array())
        {
            for model in models {
                let Some(id) = model.get("id").and_then(|value| value.as_str()) else {
                    continue;
                };
                let label = model
                    .get("displayName")
                    .and_then(|value| value.as_str())
                    .unwrap_or(id);
                let reasoning_efforts = model
                    .get("supportedReasoningEfforts")
                    .and_then(|value| value.as_array())
                    .map(|efforts| {
                        efforts
                            .iter()
                            .filter_map(|effort| {
                                effort
                                    .get("reasoningEffort")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_owned)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let default_reasoning_effort = model
                    .get("defaultReasoningEffort")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned);
                model_list.push(AgentModel {
                    id: id.to_owned(),
                    label: label.to_owned(),
                    description: model
                        .get("description")
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                    reasoning_efforts,
                    default_reasoning_effort,
                    is_default: model
                        .get("isDefault")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false),
                });
                model_output.push_str(id);
                model_output.push_str(" - ");
                model_output.push_str(label);
                model_output.push('\n');
            }
        }
        break;
    }

    drop(stdin);
    terminate(&mut child);
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    if let Some(error) = protocol_error {
        return AgentModelProbe::failed(format!("Codex model/list failed: {error}"));
    }
    if model_output.is_empty() {
        return AgentModelProbe::failed(if stderr.trim().is_empty() {
            "Codex app server returned no models".to_string()
        } else {
            stderr
        });
    }
    AgentModelProbe {
        output: model_output,
        exit_code: Some(0),
        error: None,
        models: Some(model_list),
    }
}

fn claude_models() -> AgentModelProbe {
    let Some(cache_dir) =
        dirs::home_dir().map(|home| home.join(".claude").join("cache").join("model-catalog"))
    else {
        return AgentModelProbe::failed("Could not find the Claude Code model catalogue directory");
    };

    let Ok(entries) = std::fs::read_dir(&cache_dir) else {
        return AgentModelProbe::failed("Claude Code has no local model catalogue yet");
    };
    // The directory mixes per-account catalogues (`tok-*`, `*-cc.json`) with
    // unrelated caches (`published-*.json`) that carry no model list, and the
    // per-account files for other signed-in accounts go stale. Take the most
    // recently written file that actually has models, not merely the newest.
    let mut candidates: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .map(|path| {
            let modified = path
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, path)
        })
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let value = candidates.iter().find_map(|(_, path)| {
        let text = std::fs::read_to_string(path).ok()?;
        let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
        value
            .pointer("/catalog/config/models")
            .and_then(|models| models.as_array())
            .is_some_and(|models| !models.is_empty())
            .then_some(value)
    });
    let Some(value) = value else {
        return AgentModelProbe::failed("Claude Code has no local model catalogue yet");
    };
    parse_claude_catalogue(&value)
}

fn parse_claude_catalogue(value: &serde_json::Value) -> AgentModelProbe {
    // The user's current selection lives under `catalog.state`; older
    // catalogue versions kept it at the top level.
    let state = value
        .pointer("/catalog/state")
        .or_else(|| value.get("state"));
    let default_model = state
        .and_then(|state| state.get("model"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let Some(models) = value
        .pointer("/catalog/config/models")
        .and_then(|value| value.as_array())
    else {
        return AgentModelProbe::failed("Claude Code model catalogue did not contain models");
    };

    let mut output = String::new();
    let mut model_list = Vec::new();
    for model in models {
        let Some(id) = model.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let label = model
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or(id);
        let reasoning_efforts = model
            .pointer("/thinking/effort_options")
            .and_then(|value| value.as_array())
            .map(|efforts| {
                efforts
                    .iter()
                    .filter_map(|effort| {
                        effort
                            .get("id")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // What the user last picked for this model, else the option the
        // catalogue badges as "Default".
        let default_reasoning_effort = state
            .and_then(|state| state.get("thinking_by_model"))
            .and_then(|entries| entries.as_array())
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.get("id").and_then(|value| value.as_str()) == Some(id))
            })
            .and_then(|entry| entry.pointer("/thinking/effort"))
            .and_then(|value| value.as_str())
            .or_else(|| {
                model
                    .pointer("/thinking/effort_options")
                    .and_then(|value| value.as_array())?
                    .iter()
                    .find(|effort| {
                        effort.pointer("/badge/message").and_then(|value| value.as_str())
                            == Some("Default")
                    })?
                    .get("id")?
                    .as_str()
            })
            .filter(|effort| reasoning_efforts.iter().any(|known| known == effort))
            .map(str::to_owned);
        model_list.push(AgentModel {
            id: id.to_owned(),
            label: label.to_owned(),
            description: model
                .get("description")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
            reasoning_efforts,
            default_reasoning_effort,
            is_default: id == default_model,
        });
        output.push_str(id);
        output.push_str(" - ");
        output.push_str(label);
        output.push('\n');
    }
    if model_list.is_empty() {
        return AgentModelProbe::failed("Claude Code model catalogue returned no models");
    }
    AgentModelProbe {
        output,
        exit_code: Some(0),
        error: None,
        models: Some(model_list),
    }
}

fn probe(command: &str) -> AgentModelProbe {
    match command.trim() {
        "codex" => codex_models(),
        "claude" => claude_models(),
        "cursor-agent" => capture("cursor-agent", &["models"], PROBE_TIMEOUT),
        "grok" => capture("grok", &["models"], PROBE_TIMEOUT),
        "opencode" => capture("opencode", &["models"], SLOW_PROBE_TIMEOUT),
        "kilo" => capture("kilo", &["models"], SLOW_PROBE_TIMEOUT),
        "pi" => capture("pi", &["--list-models"], PROBE_TIMEOUT),
        "agy" => capture("agy", &["models"], PROBE_TIMEOUT),
        _ => AgentModelProbe::failed("This agent does not expose a live model catalogue"),
    }
}

#[tauri::command]
pub async fn agent_list_models(command: String) -> AgentModelProbe {
    tauri::async_runtime::spawn_blocking(move || probe(&command))
        .await
        .unwrap_or_else(|error| AgentModelProbe::failed(format!("Model probe failed: {error}")))
}

fn clean_commit_output(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    // Strip <think>...</think> reasoning blocks if present
    while let Some(start) = text.find("<think>") {
        if let Some(end) = text.find("</think>") {
            let before = text[..start].trim().to_string();
            let after = text[end + 8..].trim().to_string();
            text = format!("{before}\n{after}").trim().to_string();
        } else {
            break;
        }
    }
    // Strip markdown code fences if wrapped in ```git, ```diff, or ```
    if text.starts_with("```") {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() >= 2 && lines.last().map(|l| l.trim() == "```").unwrap_or(false) {
            text = lines[1..lines.len() - 1].join("\n").trim().to_string();
        }
    }
    // Strip common leading chatter prefixes
    let lower = text.to_lowercase();
    if lower.starts_with("here is a suggested commit message:")
        || lower.starts_with("here is the commit message:")
        || lower.starts_with("here's a suggested commit message:")
        || lower.starts_with("here's the commit message:")
        || lower.starts_with("suggested commit message:")
        || lower.starts_with("commit message:")
    {
        if let Some(idx) = text.find('\n') {
            text = text[idx + 1..].trim().to_string();
        }
    }
    text
}

#[tauri::command]
pub async fn agent_cli_generate_commit_message(
    project_id: Option<String>,
    worktree_path: Option<String>,
    agent: String,
    model: Option<String>,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root_path = if let Some(ref wp) = worktree_path {
        let p = std::path::PathBuf::from(wp);
        if p.exists() {
            Some(p)
        } else {
            None
        }
    } else if let Some(ref pid) = project_id {
        state
            .workspace_manager
            .list_projects()
            .iter()
            .find(|p| &p.id == pid)
            .map(|p| p.root_path.clone())
    } else {
        None
    };

    tauri::async_runtime::spawn_blocking(move || {
        let norm_agent = agent.trim().to_lowercase();
        let program = match norm_agent.as_str() {
            "antigravity" | "agy" => "agy",
            "cursor" | "cursor-agent" => "cursor-agent",
            "deepseek" | "dsh" => "dsh",
            "copilot" | "github-copilot" => "copilot",
            other => other,
        };

        let (args, use_stdin): (Vec<String>, bool) = match program {
            "claude" => {
                let mut a = vec!["-p".to_string(), "--output-format".to_string(), "text".to_string()];
                if let Some(ref m) = model.as_ref().filter(|s| !s.trim().is_empty()) {
                    a.push("--model".to_string());
                    a.push(m.to_string());
                }
                (a, true)
            }
            "codex" => {
                let mut a = vec![
                    "exec".to_string(),
                    "--ephemeral".to_string(),
                    "--skip-git-repo-check".to_string(),
                    "-s".to_string(),
                    "read-only".to_string(),
                ];
                if let Some(ref m) = model.as_ref().filter(|s| !s.trim().is_empty()) {
                    a.push("--model".to_string());
                    a.push(m.to_string());
                }
                (a, true)
            }
            "agy" => {
                let mut a = vec!["--print=".to_string(), "--sandbox".to_string()];
                if let Some(ref m) = model.as_ref().filter(|s| !s.trim().is_empty() && s.as_str() != "default") {
                    a.push("--model".to_string());
                    a.push(m.to_string());
                }
                (a, true)
            }
            "opencode" => {
                let mut a = vec!["run".to_string()];
                if let Some(ref m) = model.as_ref().filter(|s| !s.trim().is_empty()) {
                    a.push("--model".to_string());
                    a.push(m.to_string());
                }
                (a, true)
            }
            "cursor-agent" => {
                let mut a = vec![
                    "--print".to_string(),
                    "--mode".to_string(),
                    "ask".to_string(),
                    "--trust".to_string(),
                    "--output-format".to_string(),
                    "text".to_string(),
                ];
                if let Some(ref m) = model.as_ref().filter(|s| !s.trim().is_empty()) {
                    a.push("--model".to_string());
                    a.push(m.to_string());
                }
                (a, true)
            }
            _ => {
                let mut a = vec!["-p".to_string()];
                if let Some(ref m) = model.as_ref().filter(|s| !s.trim().is_empty()) {
                    a.push("--model".to_string());
                    a.push(m.to_string());
                }
                (a, true)
            }
        };

        let arg_slices: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let mut cmd = provider_command(program, &arg_slices);
        if let Some(ref dir) = root_path {
            cmd.current_dir(dir);
        }

        if use_stdin {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Could not start {program}: {e}"))?;

        if use_stdin {
            if let Some(mut stdin) = child.stdin.take() {
                let prompt_bytes = prompt.as_bytes().to_vec();
                std::thread::spawn(move || {
                    let _ = stdin.write_all(&prompt_bytes);
                });
            }
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out_handle = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = stdout {
                let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
            }
            bytes
        });
        let err_handle = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = stderr {
                let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut bytes);
            }
            bytes
        });

        let deadline = Instant::now() + Duration::from_secs(60);
        let exit_code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                Ok(None) => {
                    terminate(&mut child);
                    return Err(format!("{program} did not return a commit message within 60s"));
                }
                Err(e) => {
                    terminate(&mut child);
                    return Err(format!("Error waiting for {program}: {e}"));
                }
            }
        };

        let raw_stdout = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
        let raw_stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();

        if exit_code == Some(0) && !raw_stdout.trim().is_empty() {
            Ok(clean_commit_output(&raw_stdout))
        } else if !raw_stdout.trim().is_empty() {
            Ok(clean_commit_output(&raw_stdout))
        } else {
            Err(if !raw_stderr.trim().is_empty() {
                format!("{program} failed: {}", raw_stderr.trim())
            } else {
                format!("{program} produced no output (exit code: {:?})", exit_code)
            })
        }
    })
    .await
    .map_err(|e| format!("Task execution failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_providers_fail_without_becoming_commands() {
        let result = probe("codex & echo unsafe");
        assert!(result.error.is_some());
        assert!(result.output.is_empty());
    }

    #[test]
    fn codex_cache_lists_visible_models_in_priority_order() {
        let cache = serde_json::json!({ "models": [
            { "slug": "gpt-b", "display_name": "B", "visibility": "list", "priority": 2,
              "default_reasoning_level": "medium",
              "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "medium" }] },
            { "slug": "gpt-hidden", "display_name": "Hidden", "visibility": "hide", "priority": 0 },
            { "slug": "gpt-a", "display_name": "A", "visibility": "list", "priority": 1 }
        ] });
        let models = parse_codex_cache(&cache, Some("gpt-b")).unwrap().models.unwrap();
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-a", "gpt-b"]);
        assert!(models[1].is_default);
        assert_eq!(models[1].reasoning_efforts, ["low", "medium"]);
        assert_eq!(models[1].default_reasoning_effort.as_deref(), Some("medium"));

        // No configured model: the top-priority one is Codex's default.
        let models = parse_codex_cache(&cache, None).unwrap().models.unwrap();
        assert!(models[0].is_default);
    }

    #[test]
    fn codex_config_model_ignores_table_keys() {
        assert_eq!(
            codex_configured_model("# c\nmodel = \"gpt-x\" # pick\n[profiles.a]\nmodel = \"y\"\n").as_deref(),
            Some("gpt-x")
        );
        assert_eq!(codex_configured_model("[profiles.a]\nmodel = \"y\"\n"), None);
    }

    #[test]
    fn claude_catalogue_reads_selection_from_catalog_state() {
        let catalogue = serde_json::json!({
            "catalog": {
                "config": { "models": [
                    { "id": "claude-opus-5-5", "name": "Opus 5.5", "thinking": { "effort_options": [
                        { "id": "low" }, { "id": "medium", "badge": { "message": "Default" } }, { "id": "high" }
                    ] } },
                    { "id": "claude-opus-5", "name": "Opus 5", "thinking": { "effort_options": [
                        { "id": "low" }, { "id": "high" }
                    ] } },
                    { "id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5", "thinking": { "type": "none" } }
                ] },
                "state": {
                    "model": "claude-opus-5",
                    "thinking_by_model": [
                        { "id": "claude-opus-5", "thinking": { "effort": "high" } }
                    ]
                }
            }
        });
        let models = parse_claude_catalogue(&catalogue).models.unwrap();
        let by_id = |id: &str| models.iter().find(|m| m.id == id).unwrap();

        assert!(by_id("claude-opus-5").is_default);
        assert!(!by_id("claude-opus-5-5").is_default);
        // The user's own pick wins; the "Default" badge is the fallback.
        assert_eq!(by_id("claude-opus-5").default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(by_id("claude-opus-5-5").default_reasoning_effort.as_deref(), Some("medium"));
        let haiku = by_id("claude-haiku-4-5-20251001");
        assert!(haiku.reasoning_efforts.is_empty());
        assert!(haiku.default_reasoning_effort.is_none());
    }
}

