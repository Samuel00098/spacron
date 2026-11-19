use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

struct PendingResponse {
    value: Mutex<Option<Value>>,
    ready: Condvar,
}

struct AcpProcess {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, Arc<PendingResponse>>>,
}

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
        let command = args.command.trim();
        if command.is_empty() || args.cwd.trim().is_empty() {
            return Err("ACP command and working directory are required".into());
        }
        let mut child = Command::new(command)
            .args(args.args)
            .current_dir(args.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start ACP agent: {error}"))?;
        let stdin = child.stdin.take().ok_or("ACP agent stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("ACP agent stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("ACP agent stderr unavailable")?;
        let id = self.allocate_id();
        let process = Arc::new(AcpProcess {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
        });
        let reader_process = Arc::clone(&process);
        let manager = Arc::clone(self);
        let stderr_app = app.clone();
        thread::Builder::new()
            .name(format!("spacron-acp-stderr-{id}"))
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        let _ = tauri::Emitter::emit(
                            &stderr_app,
                            &format!("acp://{id}/stderr"),
                            json!({ "text": line }),
                        );
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
                        continue;
                    };
                    if message.get("method").is_some() && message.get("id").is_some() {
                        let request_id = message.get("id").cloned().unwrap_or(Value::Null);
                        let method = message
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let _ = tauri::Emitter::emit(
                            &app,
                            &format!("acp://{id}/request"),
                            json!({
                                "requestId": request_id,
                                "method": method,
                                "params": message.get("params").cloned().unwrap_or(Value::Null)
                            }),
                        );
                    } else if let Some(request_id) = message.get("id").and_then(Self::response_key)
                    {
                        if let Some(waiter) = reader_process
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut p| p.remove(&request_id))
                        {
                            if let Ok(mut value) = waiter.value.lock() {
                                *value = Some(message);
                                waiter.ready.notify_one();
                            }
                        }
                    } else {
                        let _ = tauri::Emitter::emit(
                            &app,
                            &format!("acp://{id}/notification"),
                            message,
                        );
                    }
                }
                if let Ok(mut pending) = reader_process.pending.lock() {
                    for (_, waiter) in pending.drain() {
                        if let Ok(mut value) = waiter.value.lock() {
                            *value = Some(json!({
                                "jsonrpc": "2.0",
                                "error": {
                                    "code": -32000,
                                    "message": "ACP agent exited before responding"
                                }
                            }));
                            waiter.ready.notify_one();
                        }
                    }
                }
                if let Ok(mut processes) = manager.processes.lock() {
                    processes.remove(&id);
                }
                let _ = tauri::Emitter::emit(&app, &format!("acp://{id}/exit"), json!({}));
            })
            .map_err(|error| format!("Could not start ACP reader: {error}"))?;
        self.processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .insert(id, process);
        Ok(AcpStartResult { id })
    }

    pub fn request(
        &self,
        id: u32,
        request_id: String,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let process = self
            .processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .get(&id)
            .cloned()
            .ok_or("ACP session not found")?;
        let waiter = Arc::new(PendingResponse {
            value: Mutex::new(None),
            ready: Condvar::new(),
        });
        process
            .pending
            .lock()
            .map_err(|_| "ACP process unavailable")?
            .insert(request_id.clone(), Arc::clone(&waiter));
        let payload =
            json!({ "jsonrpc": "2.0", "id": request_id, "method": method, "params": params });
        let line = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
        if let Err(error) = process
            .stdin
            .lock()
            .map_err(|_| "ACP stdin unavailable")?
            .write_all(format!("{line}\n").as_bytes())
        {
            process
                .pending
                .lock()
                .ok()
                .map(|mut pending| pending.remove(&request_id));
            return Err(format!("Could not write ACP request: {error}"));
        }
        let mut value = waiter
            .value
            .lock()
            .map_err(|_| "ACP response unavailable")?;
        let (guard, timeout) = waiter
            .ready
            .wait_timeout(value, std::time::Duration::from_secs(120))
            .map_err(|_| "ACP response wait failed")?;
        value = guard;
        if timeout.timed_out() {
            process
                .pending
                .lock()
                .ok()
                .map(|mut pending| pending.remove(&request_id));
            return Err("ACP request timed out".into());
        }
        value.take().ok_or("ACP response was empty".into())
    }

    pub fn close(&self, id: u32) -> Result<(), String> {
        let process = self
            .processes
            .lock()
            .map_err(|_| "ACP manager unavailable")?
            .remove(&id)
            .ok_or("ACP session not found")?;
        let result = process
            .child
            .lock()
            .map_err(|_| "ACP process unavailable")?
            .kill()
            .map_err(|error| error.to_string());
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
}
