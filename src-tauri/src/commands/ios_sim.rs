//! iOS Simulator streaming and input for the mobile panel.
//!
//! macOS-only (the whole module compiles everywhere but every command returns a
//! clear error off-Mac). Uses [serve-sim](https://github.com/EvanBacon/serve-sim)
//! — `npx serve-sim --detach` spawns a per-device Swift helper that captures
//! the simulator framebuffer and serves it as MJPEG; the CLI subcommands drive
//! input. This module:
//!
//! * boots the target simulator via simctl (reusing `mobile::ios_boot`),
//! * starts/attaches the serve-sim helper (`--detach -q`, then `--list -q` to
//!   discover the actual port — the defaults 3200/3100 are only defaults),
//! * reads the helper's `/stream.mjpeg?raw=1` endpoint in a blocking thread
//!   and forwards each complete JPEG over a Tauri channel (raw framing plus a
//!   tolerant SOI/EOI splitter handles multipart and chunked responses too),
//! * exposes `serve-sim tap/button/type/rotate` as Tauri commands with
//!   allowlisted values (normalized 0–1 coordinates, the six hardware buttons,
//!   the four orientations).
//!
//! serve-sim's helper ships as an arm64 binary, so streaming is gated to
//! Apple Silicon Macs; Intel Macs and non-Mac hosts keep the screenshot
//! polling mirror the panel already ships.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::commands::mobile::{ios_boot, ios_list_simulators, quiet_command};

const ORIENTATIONS: [&str; 4] = ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"];
const BUTTONS: [&str; 6] = ["home", "swipe_home", "app_switcher", "lock", "siri", "side_button"];
/// Longest string `ios_sim_type` will hand to serve-sim, in **characters**.
/// Counted in chars rather than bytes because the cap is enforced by
/// truncation, and a byte cut lands mid-codepoint on any multi-byte character.
const MAX_TEXT_LEN: usize = 4096;

/// One event pushed to the frontend over the serve-sim stream channel.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SimEvent {
    Status { message: String },
    /// MJPEG stream is live. `width`/`height` come from the helper's `/config`
    /// endpoint when it answers (best-effort — the frontend re-reads the
    /// dimensions from decoded frames either way).
    Ready { width: Option<u32>, height: Option<u32> },
    /// One complete JPEG frame, base64 (no data-URL prefix).
    Frame { data: String },
    /// The stream died; the frontend falls back to screenshot polling.
    Error { message: String },
}

/// A running serve-sim stream. `stop` flips the flag AND drops a `try_clone`d
/// handle to the MJPEG socket — that close is what actually unblocks the
/// reader thread's blocking read (the helper would otherwise keep the
/// connection open forever, leaking a thread per restart).
struct ActiveSim {
    stop: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
}

static SIMS: OnceLock<Mutex<HashMap<String, Arc<ActiveSim>>>> = OnceLock::new();

fn sims() -> &'static Mutex<HashMap<String, Arc<ActiveSim>>> {
    SIMS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn require_macos() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn require_macos() -> Result<(), String> {
    Err("The iOS Simulator is only available on macOS.".to_string())
}

/// The serve-sim Swift helper is bundled as an arm64 binary only.
///
/// Cached: the host CPU does not change while the app runs, and this used to
/// fork `uname` on every gated call.
fn is_apple_silicon() -> bool {
    static ARM64: OnceLock<bool> = OnceLock::new();
    *ARM64.get_or_init(|| {
        quiet_command("uname")
            .args(["-m"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "arm64")
            .unwrap_or(false)
    })
}

/// Whether `npx` answers at all.
///
/// Cached for the same reason as [`is_apple_silicon`], and it matters more:
/// this gate runs on *every* injected tap, so an uncached probe meant each tap
/// paid two `npx` process spawns instead of one. A false result is cached too —
/// a machine without npx will not grow one mid-session, and retrying the probe
/// per tap only makes the failure slower.
fn ensure_npx() -> Result<(), String> {
    static OK: OnceLock<bool> = OnceLock::new();
    let ok = *OK.get_or_init(|| {
        quiet_command("npx")
            .args(["--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    });
    if ok {
        Ok(())
    } else {
        Err("npx was not found (it ships with Node.js). Install Node and restart Spacron.".to_string())
    }
}

fn gate_input(udid: &str) -> Result<(), String> {
    require_macos()?;
    ensure_npx()?;
    if !crate::commands::mobile_stream::valid_serial(udid) {
        return Err("Invalid simulator UDID.".to_string());
    }
    Ok(())
}

/// Full gate for the streaming path: macOS + Apple Silicon + npx.
fn gate_stream() -> Result<(), String> {
    require_macos()?;
    if !is_apple_silicon() {
        return Err("serve-sim streaming requires Apple Silicon (the bundled helper is arm64-only). The snapshot mirror still works.".to_string());
    }
    ensure_npx()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// serve-sim CLI helpers
// ---------------------------------------------------------------------------

/// How to invoke serve-sim: the program plus any leading arguments.
///
/// `npx --yes serve-sim` re-resolves the package on *every* call — a registry
/// check plus a Node boot, measured elsewhere at 0.5–1.5 s, and every injected
/// tap pays it. When serve-sim is directly executable (a global install, or
/// anything else that puts it on PATH) we can skip npm's resolution entirely
/// and spawn it straight, which leaves only the Node boot.
///
/// Probed once, and **falls back to the exact previous behaviour** when there
/// is no directly-runnable serve-sim — so the worst case is what shipped
/// before, not a broken iOS pane.
fn serve_sim_argv() -> &'static (String, Vec<String>) {
    static ARGV: OnceLock<(String, Vec<String>)> = OnceLock::new();
    ARGV.get_or_init(|| {
        let direct = quiet_command("serve-sim")
            .args(["--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if direct {
            ("serve-sim".to_string(), Vec::new())
        } else {
            ("npx".to_string(), vec!["--yes".to_string(), "serve-sim".to_string()])
        }
    })
}

fn run_npx(args: &[&str]) -> Result<String, String> {
    let (program, leading) = serve_sim_argv();
    let out = quiet_command(program)
        .args(leading)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run serve-sim: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "serve-sim exited with an error.".to_string()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Resolve a UDID to the simulator's display name (what `serve-sim [device]`
/// targets). Returns `None` when the sim has disappeared.
async fn sim_name(udid: &str) -> Option<String> {
    ios_list_simulators()
        .await
        .ok()
        .and_then(|sims| sims.into_iter().find(|s| s.udid == udid).map(|s| s.name))
}

/// The port of the running helper for `udid`, from `serve-sim --list -q`.
/// Matches on the `udid` field or the device name.
fn discover_port(udid: &str, name: &str) -> Result<u16, String> {
    let list = run_npx(&["--list", "-q"])?;
    let parsed: serde_json::Value = serde_json::from_str(&list)
        .map_err(|e| format!("serve-sim --list returned unreadable output: {e}"))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| "serve-sim --list did not return a stream list.".to_string())?;
    let udid_l = udid.to_lowercase();
    let name_l = name.to_lowercase();
    for entry in arr {
        let device = entry.get("device").and_then(|v| v.as_str()).unwrap_or("");
        let entry_udid = entry.get("udid").and_then(|v| v.as_str()).unwrap_or("");
        let matches = entry_udid.eq_ignore_ascii_case(udid)
            || device.to_lowercase().contains(&udid_l)
            || device.to_lowercase().contains(&name_l);
        if matches {
            let port = entry.get("port").and_then(|v| v.as_u64()).unwrap_or(3100) as u16;
            if port == 0 {
                continue;
            }
            return Ok(port);
        }
    }
    Err(format!("No serve-sim stream found for {name}."))
}

/// Start (or attach to) the serve-sim helper for this simulator and return the
/// helper's port. `--detach` spawns the helper and exits; `--list -q` then
/// reports the real port. Retried because the state file lags the spawn.
async fn ensure_helper(udid: &str, name: &str) -> Result<u16, String> {
    // Already running? Attach rather than double-spawn.
    if let Ok(port) = discover_port(udid, name) {
        return Ok(port);
    }
    let _ = run_npx(&["--detach", "-q", name])?;
    for _ in 0..10 {
        match discover_port(udid, name) {
            Ok(port) => return Ok(port),
            Err(_) => std::thread::sleep(Duration::from_millis(500)),
        }
    }
    Err(format!("serve-sim started but never reported a stream for {name}."))
}

// ---------------------------------------------------------------------------
// MJPEG reader
// ---------------------------------------------------------------------------

/// Split a byte buffer on JPEG frame boundaries: each frame runs from a SOI
/// marker (FF D8) to the following EOI marker (FF D9). Bytes before the first
/// SOI, between frames, and after the last EOI are discarded (they hold
/// multipart boundaries and HTTP chunk framing). The trailing partial frame is
/// kept in `buf` for the next read. JPEG entropy data never contains a raw
/// FF D9 (byte-stuffing guarantees it), so the scan is safe.
fn split_jpegs(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut start: Option<usize> = None;
    let len = buf.len();
    let mut i = 0;
    while i + 1 < len {
        if buf[i] == 0xFF && buf[i + 1] == 0xD8 && start.is_none() {
            start = Some(i);
            i += 2;
        } else if buf[i] == 0xFF && buf[i + 1] == 0xD9 {
            if let Some(s) = start.take() {
                frames.push(buf[s..=i + 1].to_vec());
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    // Keep only the bytes from the last SOI onward — an incomplete frame.
    let keep_from = start.unwrap_or(len);
    buf.drain(..keep_from);
    frames
}

/// Incremental HTTP/1.1 chunked-transfer decoder. `feed` accepts arbitrary
/// byte slices and appends decoded bytes to `out`. Tolerant of malformed size
/// lines (drops the chunk rather than failing the whole stream).
#[derive(Default)]
struct Dechunker {
    /// Reading a chunk-size line (ends with CRLF; may carry `;extensions`).
    size_line: Vec<u8>,
    /// Bytes left in the current chunk's data.
    remaining: usize,
    /// True after the final 0-size chunk, while trailers drain.
    trailers: bool,
}

impl Dechunker {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) {
        let mut i = 0;
        while i < input.len() {
            if self.trailers {
                // Drain until a blank line; some servers send a bare CRLF.
                if input[i] == b'\n' && self.size_line.last() == Some(&b'\r') {
                    self.trailers = false;
                    self.size_line.clear();
                } else if input[i] == b'\n' {
                    self.size_line.clear();
                } else {
                    self.size_line.push(input[i]);
                }
                i += 1;
            } else if self.remaining > 0 {
                let take = self.remaining.min(input.len() - i);
                out.extend_from_slice(&input[i..i + take]);
                self.remaining -= take;
                i += take;
            } else {
                // Reading the size line. The CRLF that terminates a chunk's
                // data arrives here and simply yields an empty line, which
                // parses as size 0 and moves us into trailers — exactly right.
                self.size_line.push(input[i]);
                if input[i] == b'\n' {
                    let line = String::from_utf8_lossy(&self.size_line).into_owned();
                    self.size_line.clear();
                    let hex = line.trim().split(';').next().unwrap_or("").trim();
                    self.remaining = usize::from_str_radix(hex, 16).unwrap_or(0);
                    if self.remaining == 0 {
                        self.trailers = true;
                    }
                }
                i += 1;
            }
        }
    }
}

/// Best-effort GET of `/config` (or any path) on the helper's port, parsed as
/// JSON. Used once to learn the stream's initial dimensions.
fn fetch_config(port: u16) -> Option<serde_json::Value> {
    let addr = format!("127.0.0.1:{port}");
    let mut stream = TcpStream::connect(&addr).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = format!(
        "GET /config HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&raw);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or(&text);
    serde_json::from_str(body).ok()
}

/// Feed one read's bytes into the accumulation buffers and collect any
/// complete frames. Kept as a pure function so the read loop's integration is
/// testable: a JPEG split across two reads must survive in `decoded` between
/// calls (the classic bug is clearing/replacing `decoded` per read, which
/// silently discards every partial frame).
fn pump_mjpeg(
    bytes: &[u8],
    chunked: bool,
    buf: &mut Vec<u8>,
    decoded: &mut Vec<u8>,
    dechunker: &mut Dechunker,
) -> Vec<Vec<u8>> {
    if chunked {
        buf.extend_from_slice(bytes);
        dechunker.feed(buf, decoded);
        buf.clear();
    } else {
        decoded.extend_from_slice(bytes);
    }
    split_jpegs(decoded)
}

/// The reader thread: GET the MJPEG stream, split frames, forward them.
fn run_mjpeg(port: u16, channel: Channel<SimEvent>, active: Arc<ActiveSim>) {
    let send = |event: SimEvent| {
        let _ = channel.send(event);
    };

    let addr = format!("127.0.0.1:{port}");
    let mut stream = match TcpStream::connect(&addr) {
        Ok(s) => s,
        Err(e) => {
            send(SimEvent::Error { message: format!("Could not reach the serve-sim stream: {e}") });
            return;
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    // Publish a clone so stop() can close the socket and unblock this read.
    *active.socket.lock().unwrap() = stream.try_clone().ok();

    let request = format!(
        "GET /stream.mjpeg?raw=1 HTTP/1.1\r\nHost: {addr}\r\nAccept: application/octet-stream\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        send(SimEvent::Error { message: "Failed to request the serve-sim stream.".into() });
        return;
    }

    // Response head: read until CRLFCRLF (capped) so the body starts clean.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while head.len() < 64 * 1024 {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                head.push(byte[0]);
                if head.len() >= 4 && &head[head.len() - 4..] == b"\r\n\r\n" {
                    break;
                }
            }
            Err(_) => {
                send(SimEvent::Error { message: "serve-sim did not answer the stream request.".into() });
                return;
            }
        }
    }
    let head_text = String::from_utf8_lossy(&head).to_ascii_lowercase();
    if !head_text.starts_with("http/1.1 200") && !head_text.contains(" 200 ") {
        send(SimEvent::Error { message: "serve-sim refused the stream request.".into() });
        return;
    }
    let chunked = head_text.contains("transfer-encoding: chunked");
    let _ = stream.set_read_timeout(None);

    let dims = fetch_config(port);
    let width = dims.as_ref().and_then(|d| d.get("width").and_then(|v| v.as_u64()).map(|v| v as u32));
    let height = dims.as_ref().and_then(|d| d.get("height").and_then(|v| v.as_u64()).map(|v| v as u32));
    send(SimEvent::Ready { width, height });

    let mut buf = Vec::new();
    let mut decoded = Vec::new();
    let mut dechunker = Dechunker::default();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if active.stop.load(Ordering::SeqCst) {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                for frame in pump_mjpeg(&chunk[..n], chunked, &mut buf, &mut decoded, &mut dechunker) {
                    let _ = channel.send(SimEvent::Frame {
                        data: base64::engine::general_purpose::STANDARD.encode(&frame),
                    });
                }
            }
            Err(_) => break,
        }
    }

    *active.socket.lock().unwrap() = None;
    sims().lock().unwrap().remove(&format!("ios:{port}"));
    if !active.stop.load(Ordering::SeqCst) {
        send(SimEvent::Error { message: "Simulator stream ended.".into() });
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start streaming a booted simulator's screen via serve-sim. Boots the sim
/// first (idempotent), then starts/attaches the helper and pumps MJPEG frames
/// over `on_frame`.
#[tauri::command]
pub async fn ios_sim_stream_start(udid: String, on_frame: Channel<SimEvent>) -> Result<String, String> {
    gate_stream()?;
    if !crate::commands::mobile_stream::valid_serial(&udid) {
        return Err("Invalid simulator UDID.".to_string());
    }

    // Booting and the first serve-sim spawn can take tens of seconds; tell the
    // frontend so its overlay can say something useful instead of spinning
    // silently.
    let _ = on_frame.send(SimEvent::Status {
        message: "Booting simulator and starting the stream helper…".into(),
    });

    // Boot (or attach to the already-booted sim) and wait for it to come up.
    let _ = ios_boot(udid.clone()).await;
    let name = match sim_name(&udid).await {
        Some(name) => name,
        None => return Err("Simulator not found.".to_string()),
    };
    for _ in 0..120 {
        let booted = ios_list_simulators()
            .await
            .ok()
            .and_then(|sims| sims.into_iter().find(|s| s.udid == udid).map(|s| s.state))
            .map(|s| s.to_lowercase().contains("booted"))
            .unwrap_or(false);
        if booted {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let port = ensure_helper(&udid, &name).await?;
    let stream_id = format!("ios:{port}");
    if let Some(previous) = sims().lock().unwrap().remove(&stream_id) {
        previous.stop.store(true, Ordering::SeqCst);
        if let Some(sock) = previous.socket.lock().unwrap().take() {
            drop(sock);
        }
    }
    let active = Arc::new(ActiveSim { stop: AtomicBool::new(false), socket: Mutex::new(None) });
    sims().lock().unwrap().insert(stream_id.clone(), active.clone());
    std::thread::spawn(move || run_mjpeg(port, on_frame, active));
    Ok(stream_id)
}

#[tauri::command]
pub fn ios_sim_stream_stop(stream_id: String) -> Result<(), String> {
    if let Some(active) = sims().lock().unwrap().remove(&stream_id) {
        active.stop.store(true, Ordering::SeqCst);
        // Closing the socket is what unblocks the reader thread's blocking
        // read — the flag alone would leave it waiting forever.
        if let Some(sock) = active.socket.lock().unwrap().take() {
            drop(sock);
        }
    }
    Ok(())
}

/// Tap at normalized (0–1) screen coordinates. The frontend maps its own
/// pointer position to normalized space, so the panel works at any display
/// size and rotation.
#[tauri::command]
pub async fn ios_sim_tap(udid: String, x: f32, y: f32) -> Result<(), String> {
    gate_input(&udid)?;
    let x = x.clamp(0.0, 1.0);
    let y = y.clamp(0.0, 1.0);
    run_npx(&["tap", &format!("{x:.4}"), &format!("{y:.4}"), "-d", &udid]).map(|_| ())
}

/// Press one of the six simulator hardware buttons.
#[tauri::command]
pub async fn ios_sim_button(udid: String, name: String) -> Result<(), String> {
    gate_input(&udid)?;
    if !BUTTONS.contains(&name.as_str()) {
        return Err(format!("Unknown button '{name}'. Valid: {}", BUTTONS.join(", ")));
    }
    run_npx(&["button", &name, "-d", &udid]).map(|_| ())
}

/// Type text via the simulator keyboard (US layout; the on-screen field must
/// have focus, as with serve-sim itself).
#[tauri::command]
pub async fn ios_sim_type(udid: String, text: String) -> Result<(), String> {
    gate_input(&udid)?;
    // Truncate by characters, not bytes: `text[..MAX_TEXT_LEN]` panics when the
    // byte cut falls inside a multi-byte codepoint, so pasting a long string
    // with an emoji or any accented text in it would take the command down
    // rather than typing a shortened version of it.
    let text = if text.chars().count() > MAX_TEXT_LEN {
        text.chars().take(MAX_TEXT_LEN).collect()
    } else {
        text
    };
    if text.trim().is_empty() {
        return Err("Nothing to type.".to_string());
    }
    run_npx(&["type", &text, "-d", &udid]).map(|_| ())
}

/// Rotate the simulator display.
#[tauri::command]
pub async fn ios_sim_rotate(udid: String, orientation: String) -> Result<(), String> {
    gate_input(&udid)?;
    if !ORIENTATIONS.contains(&orientation.as_str()) {
        return Err(format!(
            "Unknown orientation '{orientation}'. Valid: {}",
            ORIENTATIONS.join(", ")
        ));
    }
    run_npx(&["rotate", &orientation, "-d", &udid]).map(|_| ())
}

// `adb_program` lives in `mobile`; this module's transport is serve-sim.

#[cfg(test)]
mod tests {
    use super::{pump_mjpeg, split_jpegs, BUTTONS, ORIENTATIONS, Dechunker};

    /// Two minimal JPEGs: SOI + a few bytes + EOI.
    fn jpeg(tag: u8) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, tag];
        v.extend_from_slice(&[0x42, 0x42]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    #[test]
    fn splits_back_to_back_jpegs() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&jpeg(0x01));
        buf.extend_from_slice(&jpeg(0x02));
        let frames = split_jpegs(&mut buf);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], jpeg(0x01));
        assert_eq!(frames[1], jpeg(0x02));
        assert!(buf.is_empty());
    }

    #[test]
    fn skips_garbage_between_frames() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n");
        buf.extend_from_slice(&jpeg(0x07));
        buf.extend_from_slice(b"\r\n--frame\r\n");
        buf.extend_from_slice(&jpeg(0x08));
        let frames = split_jpegs(&mut buf);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], jpeg(0x07));
        assert_eq!(frames[1], jpeg(0x08));
    }

    #[test]
    fn keeps_partial_trailing_frame_for_the_next_read() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&jpeg(0x01));
        buf.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0]); // SOI only
        let frames = split_jpegs(&mut buf);
        assert_eq!(frames.len(), 1);
        assert_eq!(buf, vec![0xFF, 0xD8, 0xFF, 0xE0]);

        // Finish the frame with a second read.
        buf.extend_from_slice(&[0x00, 0x10, 0x99, 0xFF, 0xD9]);
        let frames = split_jpegs(&mut buf);
        assert_eq!(frames.len(), 1);
        assert!(buf.is_empty());
    }

    #[test]
    fn read_loop_keeps_a_partial_frame_across_reads() {
        // The regression that broke iOS streaming: the per-read pump must not
        // discard the trailing partial JPEG a previous read left behind.
        let body = jpeg(0x21);
        let cut = body.len() / 2;
        let mut buf = Vec::new();
        let mut decoded = Vec::new();
        let mut dechunker = Dechunker::default();

        // Read 1: only half the JPEG arrives.
        let frames = pump_mjpeg(&body[..cut], false, &mut buf, &mut decoded, &mut dechunker);
        assert!(frames.is_empty(), "half a JPEG is not a frame yet");

        // Read 2: the rest arrives; the retained half must complete it.
        let frames = pump_mjpeg(&body[cut..], false, &mut buf, &mut decoded, &mut dechunker);
        assert_eq!(frames, vec![body], "a JPEG split across reads must survive");
        assert!(decoded.is_empty());
    }

    #[test]
    fn read_loop_keeps_partials_across_chunked_reads_too() {
        let body = jpeg(0x22);
        let cut = body.len() / 3;
        let mut wire = format!("{:x}\r\n", body.len()).into_bytes();
        wire.extend_from_slice(&body);
        wire.extend_from_slice(b"\r\n0\r\n\r\n");

        let mut buf = Vec::new();
        let mut decoded = Vec::new();
        let mut dechunker = Dechunker::default();
        let mut frames = Vec::new();
        // Feed the chunk-size header plus one third of the body first.
        frames.extend(pump_mjpeg(&wire[..cut + 9], true, &mut buf, &mut decoded, &mut dechunker));
        frames.extend(pump_mjpeg(&wire[cut + 9..], true, &mut buf, &mut decoded, &mut dechunker));
        assert_eq!(frames, vec![body]);
    }

    #[test]
    fn decodes_chunked_framing_across_boundaries() {
        let body: Vec<u8> = {
            let mut b = Vec::new();
            b.extend_from_slice(&jpeg(0x11));
            b.extend_from_slice(&jpeg(0x12));
            b
        };
        let chunked = format!("{:x}\r\n", body.len()).into_bytes();
        let mut wire = Vec::new();
        wire.extend_from_slice(&chunked);
        wire.extend_from_slice(&body);
        wire.extend_from_slice(b"\r\n0\r\n\r\n");

        let mut d = Dechunker::default();
        let mut out = Vec::new();
        // Feed one byte at a time — the state machine must survive arbitrary
        // TCP segmentation.
        for b in wire {
            d.feed(&[b], &mut out);
        }
        assert_eq!(out, body);
    }

    #[test]
    fn allowlists_are_stable() {
        assert_eq!(BUTTONS, ["home", "swipe_home", "app_switcher", "lock", "siri", "side_button"]);
        assert_eq!(
            ORIENTATIONS,
            ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"]
        );
    }
}
