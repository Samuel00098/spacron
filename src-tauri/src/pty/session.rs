use crate::pty::shell::ShellConfig;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use sysinfo::{Pid, ProcessesToUpdate, System};

/// Transport-agnostic sink for a PTY session's live output. Each attached
/// frontend (Tauri IPC channel, remote WebSocket, …) provides one. Returning
/// `false` marks the sink dead so the reader loop drops it. Keeping this trait
/// free of Tauri types is what lets `spacron-server` reuse the PTY core headless.
pub trait DataSink: Send + Sync {
    /// Deliver a chunk of terminal output. Returns `false` if the sink is gone.
    fn send_data(&self, bytes: &[u8]) -> bool;
}

/// Transport-agnostic sink for a PTY session's exit code. See [`DataSink`].
pub trait ExitSink: Send + Sync {
    /// Deliver the child's exit code. Returns `false` if the sink is gone.
    fn send_exit(&self, code: i32) -> bool;
}

#[derive(Clone)]
pub struct PtySession {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    /// OS process id of the spawned shell, when the backend exposes one. The
    /// resource monitor (commands/resource.rs) samples this process to report
    /// a session's live CPU/RAM. `None` when the platform/pty backend couldn't
    /// resolve a pid (e.g. some Windows conpty edge cases); the row then shows
    /// no numbers instead of a fabricated one.
    pub pid: Option<u32>,
    /// The folder the shell was started in. Lets a project folder rename find
    /// and close every session parked inside it, including ones the webview
    /// has lost track of.
    pub cwd: std::path::PathBuf,
    output_buffer: Arc<Mutex<Vec<u8>>>,
    data_subscribers: Arc<Mutex<Vec<Box<dyn DataSink>>>>,
    exit_code: Arc<Mutex<Option<i32>>>,
    exit_subscribers: Arc<Mutex<Vec<Box<dyn ExitSink>>>>,
}

const MAX_REPLAY_BUFFER_BYTES: usize = 1024 * 1024;

pub fn spawn(
    cols: u16,
    rows: u16,
    shell: ShellConfig,
    cwd: String,
    on_data: Box<dyn DataSink>,
    on_exit: Box<dyn ExitSink>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<PtySession, String> {
    let pty_system = NativePtySystem::default();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&shell.program);
    for arg in &shell.args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    let spawn_cwd = std::path::PathBuf::from(&cwd);
    // Agents run in this shell; see `PARENT_AGENT_SESSION_VARS`.
    for key in crate::acp::inherited_agent_session_vars() {
        cmd.env_remove(key);
    }
    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    // Capture the pid BEFORE `child` is moved into the waiter thread below —
    // `process_id()` borrows the child, and the waiter owns it from then on.
    let pid = child.process_id();

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let writer = Arc::new(Mutex::new(writer));
    let master = Arc::new(Mutex::new(pair.master));
    let killer = Arc::new(Mutex::new(child.clone_killer()));
    let output_buffer = Arc::new(Mutex::new(Vec::new()));
    let data_subscribers = Arc::new(Mutex::new(vec![on_data]));
    let exit_code = Arc::new(Mutex::new(None));
    let exit_subscribers = Arc::new(Mutex::new(vec![on_exit]));

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

    let reader_output_buffer = output_buffer.clone();
    let reader_data_subscribers = data_subscribers.clone();
    thread::Builder::new()
        .name("forge-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; 65536];
            let mut reader = reader;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| e.to_string())?;

    thread::Builder::new()
        .name("forge-pty-throttler".into())
        .spawn(move || {
            let mut local_buffer = Vec::new();
            let mut last_flush = std::time::Instant::now();
            let timeout = std::time::Duration::from_millis(15);

            let flush = |buffer: &[u8]| {
                if buffer.is_empty() {
                    return;
                }
                if let Ok(mut replay) = reader_output_buffer.lock() {
                    replay.extend_from_slice(buffer);
                    let excess = replay.len().saturating_sub(MAX_REPLAY_BUFFER_BYTES);
                    if excess > 0 {
                        replay.drain(..excess);
                    }
                }
                if let Ok(mut subscribers) = reader_data_subscribers.lock() {
                    subscribers.retain(|sink| sink.send_data(buffer));
                }
            };

            loop {
                if local_buffer.is_empty() {
                    match rx.recv() {
                        Ok(chunk) => {
                            local_buffer.extend(chunk);
                            last_flush = std::time::Instant::now();
                        }
                        Err(_) => break, // Channel closed
                    }
                } else {
                    match rx.recv_timeout(timeout) {
                        Ok(chunk) => {
                            local_buffer.extend(chunk);
                            if local_buffer.len() >= 8192 {
                                flush(&local_buffer);
                                local_buffer.clear();
                                last_flush = std::time::Instant::now();
                            } else if last_flush.elapsed() >= timeout {
                                flush(&local_buffer);
                                local_buffer.clear();
                                last_flush = std::time::Instant::now();
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            flush(&local_buffer);
                            local_buffer.clear();
                            last_flush = std::time::Instant::now();
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            flush(&local_buffer);
                            break;
                        }
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let waiter_exit_code = exit_code.clone();
    let waiter_exit_subscribers = exit_subscribers.clone();
    thread::Builder::new()
        .name("forge-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            if let Ok(mut stored_code) = waiter_exit_code.lock() {
                *stored_code = Some(code);
            }
            if let Ok(mut subscribers) = waiter_exit_subscribers.lock() {
                subscribers.retain(|sink| sink.send_exit(code));
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(PtySession {
        master,
        writer,
        killer,
        pid,
        cwd: spawn_cwd,
        output_buffer,
        data_subscribers,
        exit_code,
        exit_subscribers,
    })
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Only kill when this is the last Arc holder (i.e. the canonical copy stored
        // in PtyManager). Clones returned by PtyManager::get() share the same Arc, so
        // their Drop must not kill the process — strong_count > 1 means another copy
        // still holds the session alive.
        if Arc::strong_count(&self.killer) == 1 {
            if let Ok(mut killer) = self.killer.lock() {
                let _ = killer.kill();
            }
        }
    }
}

impl PtySession {
    /// Subscribes the channels to live output and returns the buffered history
    /// instead of sending it down `on_data`. The history contains the child's
    /// past terminal queries (e.g. Codex's OSC 10/11 color probes); the frontend
    /// must feed it to xterm through its gated replay path so the re-answered
    /// queries are dropped rather than written back to the live PTY, where the
    /// running child would render them as literal `]10;rgb:…` input.
    pub fn attach(
        &self,
        on_data: Box<dyn DataSink>,
        on_exit: Box<dyn ExitSink>,
    ) -> Result<Vec<u8>, String> {
        let replay = {
            let mut subscribers = self.data_subscribers.lock().map_err(|e| e.to_string())?;
            let replay = self
                .output_buffer
                .lock()
                .map_err(|e| e.to_string())?
                .clone();
            subscribers.push(on_data);
            replay
        };

        let maybe_exit_code = *self.exit_code.lock().map_err(|e| e.to_string())?;
        if let Some(code) = maybe_exit_code {
            let _ = on_exit.send_exit(code);
            return Ok(replay);
        }

        self.exit_subscribers
            .lock()
            .map_err(|e| e.to_string())?
            .push(on_exit);

        Ok(replay)
    }

    pub fn close(&self) -> Result<(), String> {
        {
            let mut killer = self.killer.lock().map_err(|e| e.to_string())?;
            // Best-effort direct kill; if the shell is already gone this errors
            // and the tree walk below still catches whatever survives.
            let _ = killer.kill();
        }
        if let Some(pid) = self.pid {
            Self::kill_process_tree(pid);
        }
        Ok(())
    }

    pub fn write(&self, data: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    }

    // ─── Process-tree teardown ────────────────────────────────────────────────

    /// Terminate the shell process AND every process in its descendant tree.
    ///
    /// portable-pty's `ChildKiller::kill()` only terminates the direct child —
    /// on Windows `TerminateProcess` never kills the child's children. An agent
    /// runs *inside* the shell, so closing a session used to leave the agent
    /// running as an orphan: the pane closed, but Claude/Codex kept burning CPU
    /// and RAM invisibly. This walks the whole tree via sysinfo and terminates
    /// every member, leaves first so a dying parent can't reparent a survivor
    /// out from under us.
    fn kill_process_tree(root_pid: u32) {
        // Never walk ourselves — a mis-read children map must not end the app.
        if root_pid == std::process::id() {
            return;
        }
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);

        // Parent → children once, from the (already snapshot) process list.
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, process) in sys.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent.as_u32()).or_default().push(pid.as_u32());
            }
        }

        // Discovery order guarantees every descendant appears after its parent
        // (a child is only pushed once its parent was popped), so reversing the
        // order kills leaves before their parents.
        let mut order: Vec<u32> = Vec::new();
        let mut stack = vec![root_pid];
        while let Some(current) = stack.pop() {
            order.push(current);
            if let Some(kids) = children.get(&current) {
                stack.extend(kids.iter().copied());
            }
        }
        for pid in order.iter().rev() {
            if let Some(process) = sys.process(Pid::from_u32(*pid)) {
                let _ = process.kill();
            }
        }
    }

    /// Read the terminal output buffer contents.
    pub fn read_output(&self) -> Vec<u8> {
        self.output_buffer
            .lock()
            .map(|buf| buf.clone())
            .unwrap_or_default()
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }
}

// Tauri IPC adapters: the local (in-app) transport delivers PTY output through a
// `Channel`. These let `commands::terminal` keep passing channels straight into
// the transport-agnostic PTY core — it just boxes them as sinks.
impl DataSink for tauri::ipc::Channel<tauri::ipc::Response> {
    fn send_data(&self, bytes: &[u8]) -> bool {
        self.send(tauri::ipc::Response::new(bytes.to_vec())).is_ok()
    }
}

impl ExitSink for tauri::ipc::Channel<i32> {
    fn send_exit(&self, code: i32) -> bool {
        self.send(code).is_ok()
    }
}
