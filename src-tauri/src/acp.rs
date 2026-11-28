use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio::sync::oneshot;

struct AcpProcess {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    // None once stdout has closed, so new requests cannot register after EOF.
    pending: Mutex<Option<HashMap<String, oneshot::Sender<Value>>>>,
}

pub(crate) struct AcpRequest {
    process: Arc<AcpProcess>,
    id: String,
    response: oneshot::Receiver<Value>,
    is_prompt: bool,
}

impl AcpRequest {
    pub(crate) async fn wait(mut self) -> Result<Value, String> {
        // A prompt owns the whole turn, including tool work and approvals.
        // Cancellation is sent separately and the agent answers the prompt.
        let result = if self.is_prompt {
            (&mut self.response).await
        } else {
            tokio::time::timeout(Duration::from_secs(120), &mut self.response)
                .await
                .map_err(|_| "ACP request timed out")?
        };
        result.map_err(|_| "ACP agent exited before responding".into())
    }
}

impl Drop for AcpRequest {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.process.pending.lock() {
            if let Some(pending) = pending.as_mut() {
                pending.remove(&self.id);
            }
        }
    }
}

/// Where an agent process's events go: `(event name, payload)`.
pub type AcpEmit = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Default)]
pub struct AcpManager {
    processes: Mutex<HashMap<u32, Arc<AcpProcess>>>,
    next_id: Mutex<u32>,
}

#[derive(Debug, Deserialize)]
pub struct AcpStartArgs {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    /// Extra environment for the process (provider config directories, etc.).
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// An already-quoted Windows command line after `command`. This is used
    /// for npm `.cmd` shims because CreateProcess quoting is not cmd.exe's.
    #[serde(default)]
    pub raw_args: Option<String>,
}

/// Variables a running Claude Code session puts in its children's environment.
/// When Spacron itself was started from inside one (a dev build run from a
/// Claude Code terminal), every agent it spawns inherits them and Claude Code
/// treats itself as a child session: it turns transcript saving off ("Transcript
/// saving is off — inherited CLAUDE…"), so `--resume` finds nothing and the
/// transcript-backed chat view stays empty. Only these session-identity
/// variables are dropped; user configuration such as `CLAUDE_CODE_USE_BEDROCK`
/// or `CLAUDE_CODE_GIT_BASH_PATH` is left alone.
pub const PARENT_AGENT_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_DESKTOP_APP_VERSION",
    "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_CODE_DISABLE_CRON",
    "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
    "CLAUDE_CODE_EMIT_STARTUP_TIMING",
    "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
    "CLAUDE_CODE_EAGER_FLUSH",
    "CLAUDE_CODE_REPORT_FINDINGS",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_HOST_SHORT_TEMP_DIRS",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
    "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

/// The parent-session variables to drop from a child's environment: all of
/// them when Spacron runs inside a Claude Code session, none otherwise.
pub fn inherited_agent_session_vars() -> Vec<&'static str> {
    if std::env::var_os("CLAUDECODE").is_none() {
        return Vec::new();
    }
    PARENT_AGENT_SESSION_VARS
        .iter()
        .copied()
        .filter(|key| std::env::var_os(key).is_some())
        .collect()
}

#[derive(Debug, Serialize)]
pub struct AcpStartResult {
    pub id: u32,
}

impl AcpManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn allocate_id(&self) -> u32 {
        let mut next = self.next_id.lock().expect("ACP id lock poisoned");
        *next = next.saturating_add(1).max(1);
        *next
    }

    fn response_key(value: &Value) -> Option<String> {
        match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        }
    }

    pub fn start(
        self: &Arc<Self>,
        args: AcpStartArgs,
        app: tauri::AppHandle,
    ) -> Result<AcpStartResult, String> {
        self.start_with(
            args,
            Arc::new(move |name: &str, payload: Value| {
                drop(tauri::Emitter::emit(&app, name, payload));
            }),
        )
    }

    /// Start an agent process, delivering its events through `emit` as
    /// `(event name, payload)`. The desktop emits Tauri events; the remote
    /// server forwards them over its WebSocket (`remote/acp_bridge.rs`).
    pub fn start_with(
        self: &Arc<Self>,
        args: AcpStartArgs,
        emit: AcpEmit,
    ) -> Result<AcpStartResult, String> {
        let command = args.command.trim();
        if command.is_empty() || args.cwd.trim().is_empty() {
            return Err("ACP command and working directory are required".into());
        }
        let mut builder = Command::new(command);
        if let Some(raw_args) = args.raw_args.as_deref() {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                builder.raw_arg(raw_args);
            }
            #[cfg(not(windows))]
            {
                builder.args(args.args);
            }
        } else {
            builder.args(args.args);
        }
        // Agents start through `cmd.exe` on Windows (npm `.cmd` shims), and
        // cmd stops resolving commands once PATH passes its 8191-character
        // line limit: `'claude' is not recognized…` although a terminal finds
        // it. A dev build's PATH easily exceeds that. `search_path` is the
        // registry PATH first, bounded, the same one other agent spawns use.
        // Set before `envs`, so an explicit PATH from the caller still wins.
        if let Some(path) = crate::commands::agent_probe::search_path() {
            builder.env("PATH", path);
        }
        for key in inherited_agent_session_vars() {
            builder.env_remove(key);
        }
        let mut env = args.env.clone();
        crate::commands::agent_accounts::add_account_secrets(&mut env);
        builder
            .envs(&env)
            .current_dir(args.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            builder.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = builder
            .spawn()
            .map_err(|error| format!("Could not start ACP agent: {error}"))?;
        let stdin = child.stdin.take().ok_or("ACP agent stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("ACP agent stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("ACP agent stderr unavailable")?;
        let id = self.allocate_id();
        let process = Arc::new(AcpProcess {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(Some(HashMap::new())),
        });
        let reader_process = Arc::clone(&process);
        let manager = Arc::clone(self);
        let stderr_emit = Arc::clone(&emit);
        thread::Builder::new()
            .name(format!("spacron-acp-stderr-{id}"))
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        stderr_emit(&format!("acp://{id}/stderr"), json!({ "text": line }));
                    }
                }
            })
            .map_err(|error| format!("Could not start ACP stderr reader: {error}"))?;
        thread::Builder::new()
            .name(format!("spacron-acp-reader-{id}"))
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        if !line.trim().is_empty() {
                            emit(&format!("acp://{id}/raw"),
                                json!({ "text": line }),
                            );
                        }
                        continue;
                    };
                    if message.get("method").is_some() && message.get("id").is_some() {
                        let request_id = message.get("id").cloned().unwrap_or(Value::Null);
                        let method = message
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        emit(&format!("acp://{id}/request"),
                            json!({
                                "requestId": request_id,
                                "method": method,
                                "params": message.get("params").cloned().unwrap_or(Value::Null)
                            }),
                        );
                    } else if let Some(request_id) = message.get("id").and_then(Self::response_key)
                    {
                        let waiter = reader_process
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut pending| pending.as_mut()?.remove(&request_id));
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(message);
                        } else {
                            // Not an answer to one of our JSON-RPC requests:
                            // protocols with their own ids (Pi's RPC answers
                            // `{type: "response", id, …}` to commands written
                            // with `acp_write_raw`) would otherwise be dropped
                            // here silently ("Pi did not answer get_state").
                            emit(&format!("acp://{id}/notification"),
                                message,
                            );
                        }
                    } else {
                        emit(&format!("acp://{id}/notification"),
                            message,
                        );
                    }
                }
                if let Ok(mut pending) = reader_process.pending.lock() {
                    pending.take();
                }
                if let Ok(mut processes) = manager.processes.lock() {
                    processes.remove(&id);
                }
                emit(&format!("acp://{id}/exit"), json!({}));
            })
            .map_err(|error| format!("Could not start ACP reader: {error}"))?;
        self.processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .insert(id, process);
        Ok(AcpStartResult { id })
    }

    pub(crate) fn start_request(
        &self,
        id: u32,
        request_id: String,
        method: String,
        params: Value,
    ) -> Result<AcpRequest, String> {
        let process = self
            .processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .get(&id)
            .cloned()
            .ok_or("ACP session not found")?;
        let is_prompt = method == "session/prompt";
        let payload =
            json!({ "jsonrpc": "2.0", "id": request_id, "method": method, "params": params });
        let line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
        let (sender, response) = oneshot::channel();
        {
            let mut pending = process
                .pending
                .lock()
                .map_err(|_| "ACP process unavailable")?;
            let pending = pending.as_mut().ok_or("ACP agent already exited")?;
            if pending.contains_key(&request_id) {
                return Err("ACP request ID already pending".into());
            }
            pending.insert(request_id.clone(), sender);
        }
        let request = AcpRequest {
            process,
            id: request_id,
            response,
            is_prompt,
        };
        request
            .process
            .stdin
            .lock()
            .map_err(|_| "ACP stdin unavailable")?
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|error| format!("Could not write ACP request: {error}"))?;
        Ok(request)
    }

    pub fn close(&self, id: u32) -> Result<(), String> {
        let process = self
            .processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .remove(&id)
            .ok_or("ACP session not found")?;
        let mut child = process
            .child
            .lock()
            .map_err(|_| "ACP process unavailable")?;
        // On Windows most agents run as `cmd.exe /c <shim>` -> node -> agent.
        // Killing only the direct child leaves the agent running (it still
        // holds the pipes), so end the whole tree first.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &child.id().to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let result = match child.kill() {
            Ok(()) => Ok(()),
            // Already ended by the tree kill above.
            Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
            Err(error) => Err(error.to_string()),
        };
        let _ = child.try_wait();
        if result.is_ok() {
            if let Ok(mut pending) = process.pending.lock() {
                pending.take();
            }
        }
        result
    }

    pub fn respond(
        &self,
        id: u32,
        request_id: Value,
        result: Value,
        error: Option<Value>,
    ) -> Result<(), String> {
        let process = self
            .processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .get(&id)
            .cloned()
            .ok_or("ACP session not found")?;
        let payload = if let Some(error) = error {
            json!({ "jsonrpc": "2.0", "id": request_id, "error": error })
        } else {
            json!({ "jsonrpc": "2.0", "id": request_id, "result": result })
        };
        let line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
        let result = process
            .stdin
            .lock()
            .map_err(|_| "ACP stdin unavailable")?
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|error| format!("Could not write ACP response: {error}"));
        result
    }

    pub fn notify(&self, id: u32, method: String, params: Value) -> Result<(), String> {
        let process = self
            .processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .get(&id)
            .cloned()
            .ok_or("ACP session not found")?;
        let payload = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
        let result = process
            .stdin
            .lock()
            .map_err(|_| "ACP stdin unavailable")?
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|error| format!("Could not write ACP notification: {error}"));
        result
    }

    pub fn write_raw(&self, id: u32, text: String) -> Result<(), String> {
        let process = self
            .processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .get(&id)
            .cloned()
            .ok_or("ACP session not found")?;
        // Bound to a local: as the block's tail expression the stdin guard
        // would outlive `process` (E0597).
        let result = process
            .stdin
            .lock()
            .map_err(|_| "ACP stdin unavailable")?
            .write_all(text.as_bytes())
            .map_err(|error| format!("Could not write ACP raw input: {error}"));
        result
    }
}
