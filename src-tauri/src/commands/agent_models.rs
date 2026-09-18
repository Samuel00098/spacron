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

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: u64 = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelProbe {
    pub output: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

impl AgentModelProbe {
    fn failed(error: impl Into<String>) -> Self {
        Self {
            output: String::new(),
            exit_code: None,
            error: Some(error.into()),
        }
    }
}

fn provider_command(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new("cmd.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command.args(["/D", "/S", "/C"]);
        command.arg(
            std::iter::once(program)
                .chain(args.iter().copied())
                .collect::<Vec<_>>()
                .join(" "),
        );
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new(program);
        command.args(args);
        command
    }
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

fn capture(program: &str, args: &[&str]) -> AgentModelProbe {
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

    let deadline = Instant::now() + PROBE_TIMEOUT;
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
    }
}

fn codex_models() -> AgentModelProbe {
    let mut child = match provider_command("codex", &["app-server", "--stdio"])
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

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut model_output = String::new();
    let mut protocol_error: Option<String> = None;
    while Instant::now() < deadline {
        let wait = (deadline - Instant::now()).min(Duration::from_millis(250));
        let Ok(line) = rx.recv_timeout(wait) else {
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
    }
}

fn probe(command: &str) -> AgentModelProbe {
    match command.trim() {
        "codex" => codex_models(),
        "cursor-agent" => capture("cursor-agent", &["models"]),
        "grok" => capture("grok", &["models"]),
        _ => AgentModelProbe::failed("This agent does not expose a live model catalogue"),
    }
}

#[tauri::command]
pub async fn agent_list_models(command: String) -> AgentModelProbe {
    tauri::async_runtime::spawn_blocking(move || probe(&command))
        .await
        .unwrap_or_else(|error| AgentModelProbe::failed(format!("Model probe failed: {error}")))
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
}
