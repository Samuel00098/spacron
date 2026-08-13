//! Android live video streaming for the mobile panel.
//!
//! Implements a *video-only* scrcpy client in-process: push `scrcpy-server.jar`
//! to the device, start the server over `adb shell app_process`, open an adb
//! forward tunnel, and stream the device's H.264 output to the frontend over a
//! Tauri channel. The frontend decodes with WebCodecs and paints a `<canvas>` —
//! no scrcpy binary, no native decoder, no bundled codecs.
//!
//! Wire protocol (scrcpy 2.x, `doc/develop.md`): the server writes a single
//! dummy byte the moment it accepts the video socket, then — with
//! `send_device_meta=false` — the 12-byte codec meta: codec id, width, height,
//! three big-endian `u32`. The codec id is a fourcc ("h264"), not an enum
//! ordinal. After that comes a stream of frames, each a 12-byte header: a `u64` whose bit
//! 63 marks a codec-config packet and bit 62 a key frame, followed by a `u32`
//! *payload* size in bytes, then exactly that many payload bytes of raw
//! Annex-B H.264. The frontend owns NAL splitting and access-unit assembly
//! (see `src/lib/services/scrcpy.ts`), because the config packet's payload
//! format varies subtly between encoder implementations while in-band SPS/PPS
//! before every IDR frame is guaranteed by Android's MediaCodec defaults.
//!
//! A blocking std thread owns each stream: it reads the socket with no timeout
//! (a static screen produces no frames), and stop closes the socket from
//! another thread so the read fails and the thread unwinds. The adb `shell`
//! child and the forward redirection are torn down on both stop and thread
//! exit, so a wedged stream never leaks an adb forward.
//!
//! The server is started with `control=true`, so a *second* socket on the same
//! tunnel carries scrcpy control messages back to the device. Injecting through
//! it is what makes the mirror feel live: `adb shell input tap` costs a host
//! process spawn plus a whole ART VM boot on the device (~300 ms–1 s per event),
//! while a control message is a 32-byte write into an already-running server
//! (~1–5 ms). `mobile_input_touch` / `_key` / `_text` return `false` when no
//! stream is live so the panel can fall back to the adb path.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::commands::mobile::{adb_program, quiet_command};
use crate::state::AppState;

/// The scrcpy server version we drive. The server refuses to run if the client
/// version argument does not match its own `VERSION_NAME`, so this must track
/// the jar exactly — bump both together.
pub const SCRCYPY_VERSION: &str = "2.7";
const JAR_FILENAME: &str = "scrcpy-server-v2.7";
const JAR_URL: &str =
    "https://github.com/Genymobile/scrcpy/releases/download/v2.7/scrcpy-server-v2.7";

/// SHA-256 of `scrcpy-server-v2.7` (71 200 bytes), as published by Genymobile.
///
/// This jar is pushed to the device and executed with `app_process`, so a
/// substituted file is arbitrary code execution on whatever device is attached.
/// TLS covers the transit case, but a redirect to another host, a replaced
/// release asset, or a poisoned on-disk cache all bypass that — hence the pin.
/// **Bump this together with `SCRCYPY_VERSION`, `JAR_FILENAME` and `JAR_URL`;
/// a mismatched hash refuses to run rather than falling back.**
const JAR_SHA256: &str = "a23c5659f36c260f105c022d27bcb3eafffa26070e7baa9eda66d01377a1adba";

/// Lowercase hex SHA-256 of `bytes`.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Longest screen side (px) requested from the encoder. The mirror is a
/// sidebar-sized panel; a full 1440p stream would be several megabits of
/// pointless IPC. (Android encoders honour `max_size` via `MediaFormat`.)
///
/// **This value buys frame rate, not bandwidth.** An emulator has no hardware
/// H.264 encoder — Android's emulator images advertise `avcdec` but no
/// `avcenc`, so encoding runs in software and is bound by pixel rate. Measured
/// on a Medium_Phone AVD under continuous full-screen motion, the same scene
/// encodes at ~2.7–5.2 fps at 1024 (464×1024) but ~8.2 fps at 720 (328×720),
/// for the *same* ~0.5 Mbps — nowhere near scrcpy's 8 Mbps default cap, which
/// is why raising the bit rate does nothing and lowering the size does a lot.
/// 720 keeps a phone-shaped panel comfortably sharp at the widths the drawer
/// actually renders. Raise it only with a measurement to back it up.
const MAX_SIDE: u32 = 720;

// Frame-header flags, from scrcpy's `Streamer`: the PTS is a u62 and the two
// most significant bits of the u64 header are config / key-frame markers.
const PACKET_FLAG_CONFIG: u64 = 1 << 63;
const PACKET_FLAG_KEY_FRAME: u64 = 1 << 62;

/// Codec id for H.264 in the codec-meta header. scrcpy 2.x sends a **fourcc**
/// (`VideoCodec.H264` is `0x68323634`, i.e. the ASCII "h264"), not the enum
/// ordinal that scrcpy 1.x used — comparing against 0 rejects every real
/// device. H.265 is "h265" and AV1 is "av1"; the frontend decodes H.264 only.
const CODEC_ID_H264: u32 = 0x6832_3634;

/// Adb serial allowlist — the only characters a real device serial/emulator
/// port name can contain. Defence in depth: the serial is passed to adb as a
/// raw argv element (no shell), but every value that reaches a subprocess
/// should still be validated.
pub(crate) fn valid_serial(serial: &str) -> bool {
    !serial.is_empty()
        && serial.len() <= 64
        && serial.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// One event pushed to the frontend over the stream channel.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    /// Progress while setting the stream up (download, push, boot).
    Status { message: String },
    /// Handshake done; the encoder is running and `width`/`height` are the
    /// device pixels the stream will carry (they change on rotation — the
    /// frontend re-reads dimensions from decoded frames, so these are only the
    /// initial values).
    Ready { width: u32, height: u32 },
    /// One raw Annex-B H.264 packet (payload of one scrcpy frame). `data` is
    /// base64. `config` marks a codec-config packet (SPS/PPS), `keyframe` an
    /// IDR; `pts` is the 62-bit presentation timestamp in microseconds (0 for
    /// config packets — scrcpy replaces the whole field there).
    Frame { data: String, keyframe: bool, config: bool, pts: u64 },
    /// The stream died. The frontend falls back to screenshot polling.
    Error { message: String },
}

/// Parse a 12-byte scrcpy frame header into `(pts, config, key_frame, size)`.
/// `size` is the *payload* length in bytes (the header is separate).
fn parse_frame_header(header: &[u8]) -> Option<(u64, bool, bool, usize)> {
    if header.len() < 12 {
        return None;
    }
    let pts_flags = u64::from_be_bytes(header[0..8].try_into().ok()?);
    let size = u32::from_be_bytes(header[8..12].try_into().ok()?);
    let config = pts_flags & PACKET_FLAG_CONFIG != 0;
    let key_frame = pts_flags & PACKET_FLAG_KEY_FRAME != 0;
    let pts = pts_flags & !(PACKET_FLAG_CONFIG | PACKET_FLAG_KEY_FRAME);
    Some((pts, config, key_frame, size as usize))
}

/// A running stream: the knobs `mobile_stream_stop` needs to tear it down.
/// The reader thread owns its own socket handle; the registry holds a
/// `try_clone` so dropping it from stop() makes the blocked read fail.
struct ActiveStream {
    serial: String,
    /// The forwarded host port, published by the reader thread once it has one
    /// (0 until then). Stop paths need it to remove the adb forward.
    port: AtomicU16,
    /// Clone of the video socket. Closing it unblocks the reader thread.
    socket: Mutex<Option<TcpStream>>,
    /// The control socket — scrcpy's second connection on the same tunnel.
    /// `None` when the device refused it; input then falls back to adb.
    control: Mutex<Option<TcpStream>>,
    /// The `adb shell app_process …` child. Killed (then reaped) on stop.
    child: Mutex<Option<Child>>,
    stop: AtomicBool,
}

impl ActiveStream {
    /// Close every handle and reap the adb child. Idempotent.
    fn teardown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        drop(self.socket.lock().unwrap().take());
        drop(self.control.lock().unwrap().take());
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let port = self.port.load(Ordering::SeqCst);
        if port != 0 {
            remove_forward(&self.serial, port);
        }
    }
}

static STREAMS: OnceLock<Mutex<HashMap<String, Arc<ActiveStream>>>> = OnceLock::new();

fn streams() -> &'static Mutex<HashMap<String, Arc<ActiveStream>>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serial number for stream ids. Ids **must not** be derived from the device
/// serial alone: the panel legitimately starts a stream while a previous start
/// for the same device is still in flight (a React remount, a mode toggle), and
/// the loser of that race stops the stream it started *by id*. With one id per
/// device that stop lands on the winner instead, tearing down the stream that
/// just replaced it — the panel then waits at "Starting screen stream…" for a
/// stream that was quietly killed, with no error to fall back from.
static NEXT_STREAM_SEQ: AtomicU64 = AtomicU64::new(1);

/// Take every registered stream for `serial` out of the registry.
fn take_streams_for(serial: &str) -> Vec<Arc<ActiveStream>> {
    let mut map = streams().lock().unwrap();
    let keys: Vec<String> = map
        .iter()
        .filter(|(_, stream)| stream.serial == serial)
        .map(|(key, _)| key.clone())
        .collect();
    keys.iter().filter_map(|key| map.remove(key)).collect()
}

/// The live stream for `serial`, if one is registered.
fn stream_for(serial: &str) -> Option<Arc<ActiveStream>> {
    streams()
        .lock()
        .unwrap()
        .values()
        .find(|stream| stream.serial == serial && !stream.stop.load(Ordering::SeqCst))
        .cloned()
}

/// The scrcpy server jar, downloaded once and cached under the app config dir.
async fn ensure_server_jar(config_dir: PathBuf) -> Result<PathBuf, String> {
    let dir = config_dir.join("scrcpy");
    let path = dir.join(JAR_FILENAME);
    // The cache is re-verified on every start, not just after downloading: the
    // file lives in a user-writable directory, and it is about to be executed
    // on a device. A hash mismatch means re-download rather than fail, so a
    // corrupted (or tampered) cache heals itself instead of bricking the pane.
    if path.is_file() {
        match std::fs::read(&path) {
            Ok(cached) if sha256_hex(&cached) == JAR_SHA256 => return Ok(path),
            _ => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    // `JAR_URL` is a constant, so there is no SSRF surface here — but reqwest
    // follows up to 10 redirects by default, and a redirect chain is exactly
    // how a pinned URL stops pointing at the pinned bytes. The hash check below
    // is the real guarantee; capping redirects keeps the request boring.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let resp = client
        .get(JAR_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to download scrcpy server: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Failed to download scrcpy server (HTTP {}). Check your connection and try again.",
            resp.status()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read scrcpy server download: {e}"))?;
    // Verify BEFORE anything touches the disk: an unverified jar never becomes
    // a file that a later run could mistake for a good cache.
    let digest = sha256_hex(&bytes);
    if digest != JAR_SHA256 {
        return Err(format!(
            "The downloaded scrcpy server does not match its expected checksum \
             (got {digest}, expected {JAR_SHA256}). Refusing to run it on your device."
        ));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;
    // Write to a temp name then rename so a crash mid-write can't leave a
    // truncated file that passes the size check.
    let tmp = dir.join(format!("{JAR_FILENAME}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Failed to cache scrcpy server: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to cache scrcpy server: {e}"))?;
    Ok(path)
}

/// Ask the OS for a free port, then release it immediately. The retry loop in
/// the connect phase absorbs the tiny race this creates.
fn pick_free_port() -> u16 {
    match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener.local_addr().map(|a| a.port()).unwrap_or(27183),
        Err(_) => 27183,
    }
}

/// Non-cryptographic 31-bit id for the abstract socket name (scrcpy uses it to
/// tell concurrent clients apart on one device).
fn fresh_scid() -> u32 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u32)
        .unwrap_or(0x1234_5678);
    nanos & 0x7FFF_FFFF
}

/// The `scid=` argument for the server, and the abstract socket name that
/// follows from it.
///
/// **The server parses `scid` as hexadecimal** (`Integer.parseInt(value, 0x10)`),
/// and names its socket `scrcpy_%08x` of the parsed value — scrcpy's own client
/// sends `%08x` for exactly that reason. Sending the decimal digits instead is
/// not a cosmetic difference: a 9- or 10-digit decimal overflows `parseInt` and
/// the server dies before it logs anything, and a shorter one parses to a
/// *different* number, so the server listens on a socket the forward does not
/// point at. Either way the client connects to an empty tunnel and gives up
/// after its retry window. Keep these two derived from one value.
fn scid_args(scid: u32) -> (String, String) {
    (format!("scid={scid:08x}"), format!("scrcpy_{scid:08x}"))
}

/// `adb -s <serial> forward --remove tcp:<port>` — best effort; the registry
/// entry is already gone by the time this is called.
fn remove_forward(serial: &str, port: u16) {
    let _ = quiet_command(&adb_program())
        .args(["-s", serial, "forward", "--remove", &format!("tcp:{port}")])
        .output();
}

/// Thread body: run one stream to completion, then tear everything down.
///
/// Every failure inside `stream_session` returns an `Err`, so the cleanup here
/// is the single exit path — an early return can no longer strand an adb
/// forward or an `app_process` child on the device.
fn run_stream(
    active: Arc<ActiveStream>,
    stream_id: String,
    serial: String,
    jar: PathBuf,
    channel: Channel<StreamEvent>,
) {
    let outcome = stream_session(&active, &serial, &jar, &channel);

    let was_stopped = active.stop.load(Ordering::SeqCst);
    active.teardown();

    // Drop only *our* registry entry. Ids are unique per start, so this is
    // belt and braces — but a stream must never remove an entry it does not
    // own, or `mobile_stream_stop` would find nothing to stop and the other
    // stream's thread would run on forever.
    {
        let mut map = streams().lock().unwrap();
        if map.get(&stream_id).map(|s| Arc::ptr_eq(s, &active)).unwrap_or(false) {
            map.remove(&stream_id);
        }
    }

    if !was_stopped {
        let _ = channel.send(StreamEvent::Error {
            message: outcome.err().unwrap_or_else(|| "Screen stream ended.".to_string()),
        });
    }
}

/// Push the server, start it, handshake, then pump frames to the frontend
/// until the stream is stopped or dies. All teardown is the caller's job.
fn stream_session(
    active: &Arc<ActiveStream>,
    serial: &str,
    jar: &PathBuf,
    channel: &Channel<StreamEvent>,
) -> Result<(), String> {
    let send = |event: StreamEvent| {
        let _ = channel.send(event);
    };

    // ── Push + start the server ─────────────────────────────────────────
    send(StreamEvent::Status { message: "Pushing scrcpy server to device…".into() });
    match quiet_command(&adb_program())
        .args(["-s", serial, "push", &jar.to_string_lossy(), "/data/local/tmp/scrcpy-server.jar"])
        .output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            return Err(format!(
                "Failed to push scrcpy server: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
        Err(e) => return Err(format!("Failed to push scrcpy server: {e}")),
    }

    let port = pick_free_port();
    let (scid_arg, socket_name) = scid_args(fresh_scid());
    // Publish the port before the forward exists: every teardown path from here
    // on must be able to remove the redirection, including one that races the
    // `adb forward` call itself (removing a forward that was never created is a
    // harmless no-op, leaking one is not).
    active.port.store(port, Ordering::SeqCst);

    send(StreamEvent::Status { message: "Starting screen stream…".into() });
    match quiet_command(&adb_program())
        .args(["-s", serial, "forward", &format!("tcp:{port}"), &format!("localabstract:{socket_name}")])
        .output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            return Err(format!(
                "Failed to open adb forward: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
        Err(e) => return Err(format!("Failed to open adb forward: {e}")),
    }

    // Detached: the server keeps running after this command returns. Options
    // mirror `doc/develop.md`'s standalone-server example, video + control:
    // `audio=false control=true` over a forward tunnel, with the 64-byte device
    // name suppressed so the socket carries only the dummy byte and then the
    // 12-byte codec meta.
    let child = quiet_command(&adb_program())
        .args([
            "-s", serial, "shell",
            "CLASSPATH=/data/local/tmp/scrcpy-server.jar", "app_process", "/",
            "com.genymobile.scrcpy.Server", SCRCYPY_VERSION,
            "log_level=info",
            "audio=false",
            "control=true",
            "tunnel_forward=true",
            "send_device_meta=false",
            // Kept ON: it is the only way to tell a live connection from an
            // empty tunnel — see the connect loop below.
            "send_dummy_byte=true",
            &scid_arg,
            &format!("max_size={MAX_SIDE}"),
            "cleanup=true",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match child {
        Ok(child) => *active.child.lock().unwrap() = Some(child),
        Err(e) => return Err(format!("Failed to start scrcpy server: {e}")),
    }

    // The server needs a moment (measured: 15–20 s on a cold emulator) to boot
    // the encoder before it listens on the abstract socket. A successful
    // `connect` proves nothing on its own: adb accepts the TCP connection on
    // the forwarded port and only *then* tries to reach the device socket,
    // closing the connection when nothing is there. So the handshake is the
    // dummy byte the server writes the instant it accepts — read it, and treat
    // a failed read as "not up yet" and try again. This is exactly why scrcpy's
    // own client keeps `send_dummy_byte` on for forward tunnels.
    let mut socket = None;
    for _ in 0..120 {
        if active.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        if let Ok(candidate) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = candidate.set_read_timeout(Some(Duration::from_millis(1000)));
            let mut dummy = [0u8; 1];
            if (&candidate).read_exact(&mut dummy).is_ok() {
                socket = Some(candidate);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let Some(mut reader) = socket else {
        return Err("Device did not start the screen stream in time.".to_string());
    };

    // The control socket, *before* the codec meta is read. With a forward
    // tunnel the server accepts its sockets in order (video, audio, control)
    // inside `DesktopConnection.open()` and only starts streaming once all of
    // them are up — so reading the meta first would deadlock: the server would
    // still be blocked in `accept()` waiting for this second connection.
    // Its absence is not fatal; input just falls back to the adb path.
    let mut control = None;
    for _ in 0..40 {
        if active.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => {
                // Injection is latency-critical and every message is a few
                // dozen bytes: Nagle would sit on them waiting for company.
                let _ = s.set_nodelay(true);
                // A device that stops draining its control socket must not
                // block forever: `send_control` writes from inside an async
                // command while holding the socket mutex, so an untimed write
                // would pin a tokio worker *and* every queued input behind it.
                // On timeout the socket is dropped and input falls back to adb.
                let _ = s.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT));
                control = Some(s);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    *active.control.lock().unwrap() = control;

    // A handshake timeout catches an adb forward with nothing behind it (the
    // connect succeeds but no device socket ever answers). Cleared once the
    // codec meta lands, because a static screen legitimately sends no frames.
    let _ = reader.set_read_timeout(Some(Duration::from_secs(15)));

    // ── Handshake: codec meta (12 bytes: id, width, height) ─────────────
    let mut meta = [0u8; 12];
    if reader.read_exact(&mut meta).is_err() {
        return Err("No answer from the screen stream (is the device still connected?).".to_string());
    }
    let codec_id = u32::from_be_bytes([meta[0], meta[1], meta[2], meta[3]]);
    let width = u32::from_be_bytes([meta[4], meta[5], meta[6], meta[7]]);
    let height = u32::from_be_bytes([meta[8], meta[9], meta[10], meta[11]]);
    if codec_id != CODEC_ID_H264 {
        let name = String::from_utf8_lossy(&meta[0..4]).trim_end_matches('\0').to_string();
        return Err(format!("Device encoder is not H.264 (codec '{name}')."));
    }
    let _ = reader.set_read_timeout(None);

    // Publish the socket clone so stop() can close it, then pump frames.
    *active.socket.lock().unwrap() = reader.try_clone().ok();
    send(StreamEvent::Ready { width, height });

    loop {
        if active.stop.load(Ordering::SeqCst) {
            break;
        }
        let mut header = [0u8; 12];
        let read = reader.read_exact(&mut header);
        if read.is_err() {
            break;
        }
        let Some((pts, config, key_frame, size)) = parse_frame_header(&header) else {
            break;
        };
        // Sanity cap: at max_size=1024 an H.264 packet is a few KB. A
        // desynced stream would otherwise allocate unboundedly.
        if size == 0 || size > 16 * 1024 * 1024 {
            break;
        }
        let mut payload = vec![0u8; size];
        if reader.read_exact(&mut payload).is_err() {
            break;
        }
        let _ = channel.send(StreamEvent::Frame {
            data: base64::engine::general_purpose::STANDARD.encode(&payload),
            keyframe: key_frame,
            config,
            pts,
        });
    }

    Ok(())
}

/// Start a live H.264 stream for `serial`. Returns the stream id immediately;
/// progress and the first frames arrive over `on_frame`. One stream per
/// device — starting again replaces the previous one.
#[tauri::command]
pub async fn mobile_stream_start(
    serial: String,
    on_frame: Channel<StreamEvent>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !valid_serial(&serial) {
        return Err("Invalid device serial.".to_string());
    }
    // One stream per device, but a *unique id per start* — see NEXT_STREAM_SEQ.
    let seq = NEXT_STREAM_SEQ.fetch_add(1, Ordering::Relaxed);
    let stream_id = format!("android:{serial}:{seq}");
    for previous in take_streams_for(&serial) {
        // Blocking: killing and reaping the adb child spawns a subprocess.
        let _ = tauri::async_runtime::spawn_blocking(move || previous.teardown()).await;
    }

    // Download happens on the async command (first run only) so the thread
    // below is pure blocking I/O. An update in the jar needs the URL bumped.
    let jar = ensure_server_jar(state.config_dir.clone()).await?;

    let active = Arc::new(ActiveStream {
        serial: serial.clone(),
        port: AtomicU16::new(0),
        socket: Mutex::new(None),
        control: Mutex::new(None),
        child: Mutex::new(None),
        stop: AtomicBool::new(false),
    });
    streams().lock().unwrap().insert(stream_id.clone(), active.clone());
    let thread_id = stream_id.clone();
    std::thread::spawn(move || run_stream(active, thread_id, serial, jar, on_frame));
    Ok(stream_id)
}

/// Stop a running stream: close the sockets (unblocking the reader), kill the
/// adb child, and remove the forward redirection.
///
/// `async` on purpose — the teardown kills and reaps a child and shells out to
/// `adb forward --remove`, which on a synchronous command would run on the UI
/// thread and freeze the window for as long as adb takes to answer.
#[tauri::command]
pub async fn mobile_stream_stop(stream_id: String) -> Result<(), String> {
    let active = streams().lock().unwrap().remove(&stream_id);
    if let Some(active) = active {
        let _ = tauri::async_runtime::spawn_blocking(move || active.teardown()).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Control channel — input injection over the live stream
// ---------------------------------------------------------------------------

/// Control-message type ids (scrcpy 2.x, `app/src/control_msg.h`).
const MSG_INJECT_KEYCODE: u8 = 0;
const MSG_INJECT_TEXT: u8 = 1;
const MSG_INJECT_TOUCH_EVENT: u8 = 2;

/// `AKEY_EVENT_ACTION_DOWN` / `_UP`.
const KEY_ACTION_DOWN: u8 = 0;
const KEY_ACTION_UP: u8 = 1;

/// `AMOTION_EVENT_ACTION_*` values the panel sends. Anything else is rejected
/// before it reaches the device.
const TOUCH_ACTION_DOWN: u8 = 0;
const TOUCH_ACTION_UP: u8 = 1;
const TOUCH_ACTION_MOVE: u8 = 2;
const TOUCH_ACTION_CANCEL: u8 = 3;

/// scrcpy's own per-message cap for injected text; longer strings are split.
const INJECT_TEXT_MAX: usize = 300;

/// Pointer id of the single virtual finger the panel drives. scrcpy reserves
/// the negative ids for mouse pointers; any other value is a touchscreen one.
const POINTER_ID_FINGER: u64 = 0;

/// How long a control-message write may block before the channel is declared
/// dead. Generous next to the 0.18 ms a healthy write costs — this is a
/// deadlock guard, not a latency budget.
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// scrcpy's `sc_float_to_u16fp`: a 0–1 float as 16-bit fixed point.
fn float_to_u16fp(value: f32) -> u16 {
    let scaled = (value.clamp(0.0, 1.0) as f64) * 65536.0;
    if scaled >= 65535.0 {
        u16::MAX
    } else {
        scaled as u16
    }
}

/// Encode an `INJECT_TOUCH_EVENT` message (32 bytes).
///
/// `width`/`height` are the dimensions of the frame the coordinates were taken
/// from: the server drops the event outright when they don't match its current
/// video size, which is how a tap generated just before a rotation is
/// discarded rather than landing in the wrong place.
fn encode_touch(action: u8, x: i32, y: i32, width: u16, height: u16, pressure: f32) -> [u8; 32] {
    let mut buf = [0u8; 32];
    buf[0] = MSG_INJECT_TOUCH_EVENT;
    buf[1] = action;
    buf[2..10].copy_from_slice(&POINTER_ID_FINGER.to_be_bytes());
    buf[10..14].copy_from_slice(&x.to_be_bytes());
    buf[14..18].copy_from_slice(&y.to_be_bytes());
    buf[18..20].copy_from_slice(&width.to_be_bytes());
    buf[20..22].copy_from_slice(&height.to_be_bytes());
    buf[22..24].copy_from_slice(&float_to_u16fp(pressure).to_be_bytes());
    // buf[24..32] stays zero: action_button and buttons are both 0 for a
    // touchscreen pointer (they only carry mouse button state).
    buf
}

/// Encode an `INJECT_KEYCODE` message (14 bytes).
fn encode_keycode(action: u8, keycode: i32, repeat: u32, metastate: u32) -> [u8; 14] {
    let mut buf = [0u8; 14];
    buf[0] = MSG_INJECT_KEYCODE;
    buf[1] = action;
    buf[2..6].copy_from_slice(&keycode.to_be_bytes());
    buf[6..10].copy_from_slice(&repeat.to_be_bytes());
    buf[10..14].copy_from_slice(&metastate.to_be_bytes());
    buf
}

/// Encode `INJECT_TEXT` messages: a type byte, a big-endian `u32` length, then
/// UTF-8. Split at `INJECT_TEXT_MAX` bytes on a character boundary, so a long
/// paste never produces a message the server refuses or a torn code point.
fn encode_text(text: &str) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut cut = rest.len().min(INJECT_TEXT_MAX);
        while cut > 0 && !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        if cut == 0 {
            // A single code point longer than the cap cannot happen (4 bytes
            // max), but never loop forever if the cap is ever lowered.
            break;
        }
        let (chunk, tail) = rest.split_at(cut);
        let bytes = chunk.as_bytes();
        let mut msg = Vec::with_capacity(5 + bytes.len());
        msg.push(MSG_INJECT_TEXT);
        msg.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        msg.extend_from_slice(bytes);
        out.push(msg);
        rest = tail;
    }
    out
}

/// Write control messages to a device's live stream.
///
/// `Ok(false)` means there is no control channel for this device — no stream,
/// or a server that refused the second socket — and the caller should fall
/// back to `adb shell input`. A failed write drops the socket so every later
/// call reports the same thing instead of retrying a dead handle.
fn send_control(serial: &str, messages: &[Vec<u8>]) -> Result<bool, String> {
    let Some(active) = stream_for(serial) else { return Ok(false) };
    let mut guard = active.control.lock().unwrap();
    let Some(socket) = guard.as_mut() else { return Ok(false) };
    for message in messages {
        if let Err(e) = socket.write_all(message) {
            *guard = None;
            return Err(format!("Lost the device input channel: {e}"));
        }
    }
    Ok(true)
}

/// Inject a touch event through the live stream. `action` is 0 = down, 1 = up,
/// 2 = move, 3 = cancel; `x`/`y` are in the coordinate space of a `width` ×
/// `height` frame. Returns `false` when no control channel is available.
#[tauri::command]
pub async fn mobile_input_touch(
    serial: String,
    action: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<bool, String> {
    if !valid_serial(&serial) {
        return Err("Invalid device serial.".to_string());
    }
    if !matches!(
        action,
        TOUCH_ACTION_DOWN | TOUCH_ACTION_UP | TOUCH_ACTION_MOVE | TOUCH_ACTION_CANCEL
    ) {
        return Err(format!("Unsupported touch action {action}."));
    }
    if width == 0 || height == 0 || width > u16::MAX as u32 || height > u16::MAX as u32 {
        return Err("Invalid frame dimensions for a touch event.".to_string());
    }
    // A lifted finger reports no pressure; everything else is a full press.
    let pressure = if action == TOUCH_ACTION_UP || action == TOUCH_ACTION_CANCEL { 0.0 } else { 1.0 };
    let message = encode_touch(action, x, y, width as u16, height as u16, pressure);
    send_control(&serial, &[message.to_vec()])
}

/// Inject a key press (down then up) through the live stream.
#[tauri::command]
pub async fn mobile_input_key(serial: String, keycode: i32, metastate: Option<u32>) -> Result<bool, String> {
    if !valid_serial(&serial) {
        return Err("Invalid device serial.".to_string());
    }
    let meta = metastate.unwrap_or(0);
    send_control(
        &serial,
        &[
            encode_keycode(KEY_ACTION_DOWN, keycode, 0, meta).to_vec(),
            encode_keycode(KEY_ACTION_UP, keycode, 0, meta).to_vec(),
        ],
    )
}

/// Type text into the focused field through the live stream.
#[tauri::command]
pub async fn mobile_input_text(serial: String, text: String) -> Result<bool, String> {
    if !valid_serial(&serial) {
        return Err("Invalid device serial.".to_string());
    }
    if text.is_empty() {
        return Ok(true);
    }
    send_control(&serial, &encode_text(&text))
}

#[cfg(test)]
mod tests {
    use super::{
        encode_keycode, encode_text, encode_touch, float_to_u16fp, parse_frame_header, scid_args,
        valid_serial, INJECT_TEXT_MAX, KEY_ACTION_DOWN, MSG_INJECT_KEYCODE, MSG_INJECT_TEXT,
        MSG_INJECT_TOUCH_EVENT, PACKET_FLAG_CONFIG, PACKET_FLAG_KEY_FRAME, TOUCH_ACTION_DOWN,
        TOUCH_ACTION_UP,
    };

    #[test]
    fn parses_a_plain_frame_header() {
        // PTS = 1_000_000 µs, payload 512 bytes.
        let mut header = [0u8; 12];
        header[0..8].copy_from_slice(&1_000_000u64.to_be_bytes());
        header[8..12].copy_from_slice(&512u32.to_be_bytes());
        let (pts, config, keyframe, size) = parse_frame_header(&header).unwrap();
        assert_eq!(pts, 1_000_000);
        assert!(!config);
        assert!(!keyframe);
        assert_eq!(size, 512);
    }

    #[test]
    fn parses_config_and_keyframe_flags() {
        // Config packet: the whole PTS field is replaced by the config flag.
        let mut header = [0u8; 12];
        header[0..8].copy_from_slice(&PACKET_FLAG_CONFIG.to_be_bytes());
        header[8..12].copy_from_slice(&40u32.to_be_bytes());
        let (pts, config, keyframe, size) = parse_frame_header(&header).unwrap();
        assert!(config);
        assert!(!keyframe);
        assert_eq!(pts, 0);
        assert_eq!(size, 40);

        // Key frame with a real PTS: the key-frame flag sits in bit 62 and the
        // PTS keeps its 62 low bits.
        let mut header = [0u8; 12];
        let flags = PACKET_FLAG_KEY_FRAME | 1_000_000u64;
        header[0..8].copy_from_slice(&flags.to_be_bytes());
        header[8..12].copy_from_slice(&1200u32.to_be_bytes());
        let (pts, config, keyframe, size) = parse_frame_header(&header).unwrap();
        assert!(!config);
        assert!(keyframe);
        assert_eq!(pts, 1_000_000);
        assert_eq!(size, 1200);
    }

    #[test]
    fn rejects_short_headers() {
        assert!(parse_frame_header(&[0; 11]).is_none());
    }

    #[test]
    fn scid_argument_and_socket_name_agree_in_hex() {
        // The server reads `scid` as hex and names its socket from the parsed
        // value, so the two strings must be the same digits.
        let (arg, name) = scid_args(0x00bc_614e);
        assert_eq!(arg, "scid=00bc614e");
        assert_eq!(name, "scrcpy_00bc614e");
        assert_eq!(arg.trim_start_matches("scid="), name.trim_start_matches("scrcpy_"));

        // Every 31-bit id is 8 hex digits, which is what `Integer.parseInt`
        // accepts — a decimal rendering would be up to 10 and would overflow.
        let (arg, _) = scid_args(0x7fff_ffff);
        assert_eq!(arg.len(), "scid=".len() + 8);
    }

    #[test]
    fn encodes_a_touch_event_in_scrcpy_wire_order() {
        // type, action, pointer id (u64), x (i32), y (i32), w (u16), h (u16),
        // pressure (u16 fixed point), action_button (u32), buttons (u32).
        let msg = encode_touch(TOUCH_ACTION_DOWN, 100, 250, 1024, 2048, 1.0);
        assert_eq!(msg.len(), 32);
        assert_eq!(msg[0], MSG_INJECT_TOUCH_EVENT);
        assert_eq!(msg[1], TOUCH_ACTION_DOWN);
        assert_eq!(u64::from_be_bytes(msg[2..10].try_into().unwrap()), 0);
        assert_eq!(i32::from_be_bytes(msg[10..14].try_into().unwrap()), 100);
        assert_eq!(i32::from_be_bytes(msg[14..18].try_into().unwrap()), 250);
        assert_eq!(u16::from_be_bytes(msg[18..20].try_into().unwrap()), 1024);
        assert_eq!(u16::from_be_bytes(msg[20..22].try_into().unwrap()), 2048);
        assert_eq!(u16::from_be_bytes(msg[22..24].try_into().unwrap()), 0xffff);
        assert_eq!(&msg[24..32], &[0u8; 8]);

        // A lifted finger reports no pressure.
        let up = encode_touch(TOUCH_ACTION_UP, 100, 250, 1024, 2048, 0.0);
        assert_eq!(u16::from_be_bytes(up[22..24].try_into().unwrap()), 0);
    }

    #[test]
    fn converts_pressure_to_fixed_point() {
        assert_eq!(float_to_u16fp(0.0), 0);
        assert_eq!(float_to_u16fp(0.5), 0x8000);
        assert_eq!(float_to_u16fp(1.0), 0xffff);
        // Out-of-range values are clamped rather than wrapping.
        assert_eq!(float_to_u16fp(-1.0), 0);
        assert_eq!(float_to_u16fp(4.0), 0xffff);
    }

    #[test]
    fn encodes_a_keycode_event() {
        let msg = encode_keycode(KEY_ACTION_DOWN, 4, 0, 0);
        assert_eq!(msg.len(), 14);
        assert_eq!(msg[0], MSG_INJECT_KEYCODE);
        assert_eq!(msg[1], KEY_ACTION_DOWN);
        assert_eq!(i32::from_be_bytes(msg[2..6].try_into().unwrap()), 4);
        assert_eq!(u32::from_be_bytes(msg[6..10].try_into().unwrap()), 0);
        assert_eq!(u32::from_be_bytes(msg[10..14].try_into().unwrap()), 0);
    }

    #[test]
    fn encodes_text_as_length_prefixed_utf8() {
        let msgs = encode_text("hi ✓");
        assert_eq!(msgs.len(), 1);
        let msg = &msgs[0];
        assert_eq!(msg[0], MSG_INJECT_TEXT);
        let len = u32::from_be_bytes(msg[1..5].try_into().unwrap()) as usize;
        assert_eq!(len, "hi ✓".len());
        assert_eq!(std::str::from_utf8(&msg[5..]).unwrap(), "hi ✓");
    }

    #[test]
    fn splits_long_text_on_character_boundaries() {
        // 200 three-byte characters = 600 bytes, over the 300-byte cap. Every
        // chunk must still be valid UTF-8 and they must concatenate back.
        let text = "✓".repeat(200);
        let msgs = encode_text(&text);
        assert!(msgs.len() > 1);
        let mut rebuilt = String::new();
        for msg in &msgs {
            let len = u32::from_be_bytes(msg[1..5].try_into().unwrap()) as usize;
            assert!(len <= INJECT_TEXT_MAX);
            assert_eq!(msg.len(), 5 + len);
            rebuilt.push_str(std::str::from_utf8(&msg[5..]).expect("chunk is valid UTF-8"));
        }
        assert_eq!(rebuilt, text);
    }

    #[test]
    fn sha256_hex_matches_known_vectors() {
        // NIST/RFC 6234 vectors — proves the hex rendering is not, say,
        // dropping a leading zero on a byte, which would make every real
        // comparison fail in a way that looks like a bad download.
        assert_eq!(
            super::sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            super::sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(super::sha256_hex(b"").len(), 64);
    }

    #[test]
    fn pinned_jar_digest_is_well_formed() {
        // A typo here fails closed (the download is rejected and the pane never
        // starts), so catch a malformed pin at build time instead. The value
        // itself is scrcpy-server-v2.7's published digest, verified against two
        // independent downloads.
        assert_eq!(super::JAR_SHA256.len(), 64);
        assert!(super::JAR_SHA256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // The filename, URL and version must all describe the same release.
        assert!(super::JAR_URL.ends_with(super::JAR_FILENAME));
        assert!(super::JAR_URL.contains(super::SCRCYPY_VERSION));
        assert!(super::JAR_FILENAME.contains(super::SCRCYPY_VERSION));
    }

    #[test]
    fn serial_allowlist_accepts_real_names_and_rejects_attacks() {
        assert!(valid_serial("emulator-5554"));
        assert!(valid_serial("R58M23ABCZ"));
        assert!(valid_serial("192.168.0.5:5555"));
        assert!(!valid_serial(""));
        assert!(!valid_serial("foo; rm -rf /"));
        assert!(!valid_serial("$(id)"));
        assert!(!valid_serial(&"a".repeat(65)));
    }
}
