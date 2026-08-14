//! Keep the machine awake while agents are working.
//!
//! Agents routinely run for tens of minutes with nobody touching the keyboard —
//! exactly the conditions under which the OS decides the machine is idle and
//! suspends it, killing every agent mid-turn. This module holds an OS-level
//! sleep inhibitor for as long as the webview says at least one agent is mid-turn
//! (see `services/keep-awake.ts`, which owns the refcount and the setting gate).
//!
//! **Idle sleep only.** Every platform arm below inhibits *system* sleep and
//! leaves the display alone, so an overnight run keeps working with the screen
//! off. Keeping the panel lit for a headless task would be a worse default than
//! the one it replaces. Explicitly requested sleep (lid close, "Sleep" in the
//! menu) is deliberately still honoured on every platform: refusing the user's
//! own instruction is not ours to do.
//!
//! Three implementations, one shape — acquire returns a guard whose `Drop`
//! releases the inhibitor, so the "release" path is the same code as the
//! "process died" path:
//!
//! - **Windows** — `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
//!   That flag is *per-thread* and lapses when the thread exits, which is why the
//!   guard owns a dedicated parked thread rather than calling it inline from a
//!   command (a command runs on a tokio worker that will be handed to somebody
//!   else the moment it returns).
//! - **macOS** — a `caffeinate -i -m -s -w <our pid>` child. `-w` makes it exit
//!   with Spacron, so a crash cannot strand a process holding the machine awake.
//! - **Linux** — `systemd-inhibit --what=idle:sleep ... sleep infinity`, killed
//!   on release. Absent systemd, the command reports the failure rather than
//!   claiming a hold it does not have.

use serde::Serialize;
use std::sync::Mutex;

/// What the frontend renders in the settings row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    /// True while an inhibitor is actually held.
    pub active: bool,
    /// The mechanism this platform uses, for the settings detail line.
    pub mechanism: &'static str,
    /// True when this platform has no implementation at all.
    pub supported: bool,
}

static HOLD: Mutex<Option<platform::Inhibitor>> = Mutex::new(None);

fn status_of(active: bool) -> KeepAwakeStatus {
    KeepAwakeStatus {
        active,
        mechanism: platform::MECHANISM,
        supported: platform::SUPPORTED,
    }
}

/// Take or release the sleep inhibitor. Idempotent: asking for the state it is
/// already in does nothing and reports success, because the caller reconciles a
/// desired state rather than issuing paired acquire/release calls.
///
/// `async` so the acquire — which spawns a thread on Windows and a child process
/// elsewhere — never runs on the window's message pump. See
/// `.spacron/memory/main-thread-tauri-commands.md`.
#[tauri::command(async)]
pub fn keep_awake_set(active: bool) -> Result<KeepAwakeStatus, String> {
    let mut hold = HOLD.lock().map_err(|_| "keep-awake lock poisoned".to_string())?;
    if active == hold.is_some() {
        return Ok(status_of(hold.is_some()));
    }
    if active {
        if !platform::SUPPORTED {
            return Err(format!("Keeping the system awake is not supported on this platform ({})", std::env::consts::OS));
        }
        *hold = Some(platform::acquire()?);
    } else {
        // Drop releases; done explicitly so the guard is gone before the lock is.
        hold.take();
    }
    Ok(status_of(hold.is_some()))
}

/// Whether an inhibitor is currently held, and how this platform holds one.
#[tauri::command(async)]
pub fn keep_awake_status() -> KeepAwakeStatus {
    let active = HOLD.lock().map(|h| h.is_some()).unwrap_or(false);
    status_of(active)
}

#[cfg(windows)]
mod platform {
    use std::sync::mpsc::{channel, Sender};
    use std::thread::{self, JoinHandle};
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

    pub const MECHANISM: &str = "SetThreadExecutionState";
    pub const SUPPORTED: bool = true;

    pub struct Inhibitor {
        release: Option<Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    pub fn acquire() -> Result<Inhibitor, String> {
        let (release_tx, release_rx) = channel::<()>();
        let (ready_tx, ready_rx) = channel::<Result<(), String>>();

        let thread = thread::Builder::new()
            .name("spacron-keep-awake".into())
            .spawn(move || {
                // The execution state belongs to *this* thread and is cleared by
                // the OS when it exits, so the thread must outlive the hold —
                // hence the park below rather than a set-and-return.
                let previous =
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
                if previous.0 == 0 {
                    let _ = ready_tx.send(Err("SetThreadExecutionState failed".to_string()));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                // Blocks until the guard drops (or the sender is dropped outright,
                // which a panicking caller would do — either way we clear the state).
                let _ = release_rx.recv();
                unsafe {
                    SetThreadExecutionState(ES_CONTINUOUS);
                }
            })
            .map_err(|e| format!("Failed to start keep-awake thread: {e}"))?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Inhibitor {
                release: Some(release_tx),
                thread: Some(thread),
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Keep-awake thread exited before taking the hold".to_string()),
        }
    }

    impl Drop for Inhibitor {
        fn drop(&mut self) {
            if let Some(tx) = self.release.take() {
                let _ = tx.send(());
            }
            // Join so the state is provably cleared before we report released;
            // the thread only has one unsafe call left to make.
            if let Some(handle) = self.thread.take() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    use std::process::{Child, Command, Stdio};

    #[cfg(target_os = "macos")]
    pub const MECHANISM: &str = "caffeinate";
    #[cfg(target_os = "linux")]
    pub const MECHANISM: &str = "systemd-inhibit";
    pub const SUPPORTED: bool = true;

    pub struct Inhibitor {
        child: Child,
    }

    #[cfg(target_os = "macos")]
    fn spawn_helper() -> std::io::Result<Child> {
        // -i idle sleep, -m disk idle sleep, -s system sleep on AC power.
        // -w <pid> ties the helper's lifetime to ours so a crash cannot leave a
        // stray caffeinate holding the machine awake forever.
        Command::new("caffeinate")
            .args(["-i", "-m", "-s", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }

    #[cfg(target_os = "linux")]
    fn spawn_helper() -> std::io::Result<Child> {
        // `--mode=block` refuses automatic idle/sleep transitions; a user who
        // explicitly asks to suspend still gets it. The inhibitor lives as long
        // as the `sleep infinity` it wraps, which we kill on release.
        Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=Spacron",
                "--why=Agents are working",
                "--mode=block",
                "sleep",
                "infinity",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }

    pub fn acquire() -> Result<Inhibitor, String> {
        let mut child = spawn_helper()
            .map_err(|e| format!("Failed to start {MECHANISM}: {e}"))?;
        // A helper that is missing its own dependencies (no systemd, say) exits
        // immediately; report that instead of claiming a hold we do not have.
        std::thread::sleep(std::time::Duration::from_millis(80));
        match child.try_wait() {
            Ok(Some(status)) => Err(format!("{MECHANISM} exited immediately ({status})")),
            Ok(None) => Ok(Inhibitor { child }),
            Err(e) => Err(format!("Failed to check {MECHANISM}: {e}")),
        }
    }

    impl Drop for Inhibitor {
        fn drop(&mut self) {
            let _ = self.child.kill();
            // Reap it, so releasing the hold does not leave a zombie behind.
            let _ = self.child.wait();
        }
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    pub const MECHANISM: &str = "unsupported";
    pub const SUPPORTED: bool = false;

    pub struct Inhibitor;

    pub fn acquire() -> Result<Inhibitor, String> {
        Err("No sleep inhibitor is available on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `HOLD` is process-wide and cargo runs tests in parallel threads, so a
    /// test that takes the hold would see another one release it. Every test
    /// below claims this first and leaves the hold released.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _ = keep_awake_set(false);
        guard
    }

    #[test]
    fn reports_the_platform_mechanism() {
        let _serial = serial();
        let status = keep_awake_status();
        assert_eq!(status.mechanism, platform::MECHANISM);
        assert_eq!(status.supported, platform::SUPPORTED);
    }

    #[test]
    fn acquire_and_release_round_trip() {
        let _serial = serial();
        let taken = keep_awake_set(true).expect("acquire");
        assert!(taken.active);
        assert!(keep_awake_status().active);

        let released = keep_awake_set(false).expect("release");
        assert!(!released.active);
        assert!(!keep_awake_status().active);
    }

    #[test]
    fn repeating_the_current_state_is_a_no_op() {
        let _serial = serial();
        // Releasing when nothing is held must succeed rather than error — the
        // frontend reconciles a desired state and will ask for this on boot.
        assert!(!keep_awake_set(false).expect("idempotent release").active);

        assert!(keep_awake_set(true).expect("acquire").active);
        assert!(keep_awake_set(true).expect("second acquire").active);
        assert!(!keep_awake_set(false).expect("release").active);
    }
}
