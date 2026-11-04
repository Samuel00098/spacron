use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

struct PiProcess {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

#[derive(Default)]
pub struct PiManager {
    processes: Mutex<HashMap<u32, Arc<PiProcess>>>,
    next_id: Mutex<u32>,
}

#[derive(Debug, Deserialize)]
pub struct PiStartArgs {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
pub struct PiStartResult {
    pub id: u32,
}

impl PiManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn allocate_id(&self) -> u32 {
        let mut next = self.next_id.lock().expect("Pi id lock poisoned");
        *next = next.saturating_add(1).max(1);
        *next
    }

    pub fn start(self: &Arc<Self>, args: PiStartArgs, app: tauri::AppHandle) -> Result<PiStartResult, String> {
        let command = args.command.trim();
        if command.is_empty() || args.cwd.trim().is_empty() {
            return Err("Pi command and working directory are required".into());
        }
        let mut child = Command::new(command)
            .args(args.args)
            .current_dir(args.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start Pi RPC: {error}"))?;
        let stdin = child.stdin.take().ok_or("Pi stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Pi stderr unavailable")?;
        let id = self.allocate_id();
        let process = Arc::new(PiProcess {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
        });
        self.processes.lock().map_err(|_| "Pi manager unavailable")?.insert(id, Arc::clone(&process));

        let stderr_app = app.clone();
        thread::Builder::new().name(format!("spacron-pi-stderr-{id}")).spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                if !line.trim().is_empty() {
                    let _ = tauri::Emitter::emit(&stderr_app, &format!("pi://{id}/stderr"), json!({ "text": line }));
                }
            }
        }).map_err(|error| format!("Could not start Pi stderr reader: {error}"))?;

        let reader_app = app.clone();
        let manager = Arc::clone(self);
        thread::Builder::new().name(format!("spacron-pi-reader-{id}")).spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                if let Ok(record) = serde_json::from_str::<Value>(&line) {
                    let _ = tauri::Emitter::emit(&reader_app, &format!("pi://{id}/event"), record);
                }
            }
            if let Ok(mut processes) = manager.processes.lock() {
                processes.remove(&id);
            }
            let _ = tauri::Emitter::emit(&reader_app, &format!("pi://{id}/exit"), json!({}));
        }).map_err(|error| format!("Could not start Pi reader: {error}"))?;

        Ok(PiStartResult { id })
    }

    pub fn command(&self, id: u32, record: Value) -> Result<(), String> {
        let process = self.processes.lock().map_err(|_| "Pi manager unavailable")?
            .get(&id).cloned().ok_or("Pi session not found")?;
        let line = serde_json::to_string(&record).map_err(|error| error.to_string())?;
        process.stdin.lock().map_err(|_| "Pi stdin unavailable")?
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|error| format!("Could not write Pi command: {error}"))
    }

    pub fn close(&self, id: u32) -> Result<(), String> {
        let process = self.processes.lock().map_err(|_| "Pi manager unavailable")?
            .remove(&id).ok_or("Pi session not found")?;
        process.child.lock().map_err(|_| "Pi process unavailable")?
            .kill().map_err(|error| error.to_string())
    }
}
