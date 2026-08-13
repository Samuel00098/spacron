//! Host-side screen streaming for Android **emulators**, over the emulator's
//! own gRPC Emulator Controller.
//!
//! # Why this exists
//!
//! The scrcpy path in [`super::mobile_stream`] makes the *guest* Android OS
//! encode H.264 in software — emulator system images ship an `avcdec` but no
//! `avcenc` — and that encode is the entire reason the mirror feels sluggish.
//! The emulator also runs a gRPC service **in the host process**, so
//! `streamScreenshot` never touches the guest encoder at all.
//!
//! Measured 2026-08-13, same AVD / scene / motion / 15 s window as the scrcpy
//! run (see `.spacron/memory/emulator-grpc-stream.md`):
//!
//! | path                         | fps   | median gap | p90 gap |
//! |------------------------------|-------|-----------|---------|
//! | scrcpy H.264 @720 (guest)    |  7.12 |   125 ms  |  272 ms |
//! | **gRPC PNG @720 (host)**     | 25.66 |    36 ms  |   52 ms |
//!
//! The p90 is the point: 272 ms → 52 ms. The tail is what read as broken.
//!
//! # Scope
//!
//! **Emulators only.** Physical devices have no such endpoint and keep using
//! scrcpy, which is already fine there (they have hardware encoders). If
//! anything here fails to resolve, the caller falls back to scrcpy rather than
//! erroring — a missing gRPC port is a normal condition, not a fault.
//!
//! # Why there is no gRPC crate here
//!
//! gRPC is HTTP/2 plus a 5-byte length prefix. `reqwest` (already a direct
//! dependency) speaks HTTP/2 with prior knowledge and streams response bodies,
//! and the two messages we need have four scalar fields between them. Pulling
//! in tonic+prost would add a `protoc` build-time requirement and force us to
//! vendor a copy of a `.proto` that ships next to the user's own emulator.

use base64::Engine;
use futures_util::StreamExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::collections::HashMap;

use super::mobile_stream::StreamEvent;
use tauri::ipc::Channel;

/// `ImageFormat.ImgFormat.PNG`. PNG is the shipped choice: it costs ~7% of the
/// frame rate versus raw RGB888 at 720 but is ~9x smaller on the wire (81 KB
/// vs 683 KB per frame), which keeps the existing base64 IPC channel viable
/// and means no raw-binary transport work is needed. Above ~1024 the host-side
/// PNG compression starts to bite (15.2 fps vs 22.1 for RGB888) — if a larger
/// default is ever wanted, re-measure both formats before switching.
const IMG_FORMAT_PNG: u32 = 0;

/// Longest side requested from the emulator by default.
///
/// The emulator scales **host-side**, aspect preserved, and never exceeds the
/// requested box. Measured fps against the long side (PNG, 2026-08-13):
///
/// | long side | fps   | median gap |
/// |-----------|-------|-----------|
/// | 480       | 27.55 |    35 ms  |
/// | **720**   | 25.66 |    36 ms  |
/// | 1024      | 15.15 |    65 ms  |
/// | 1200      | 12.74 |    75 ms  |
/// | 1800      |  6.25 |   156 ms  |
/// | 2400      |  3.83 |   251 ms  |
///
/// 720 is the knee: 480 buys almost nothing over it, and 1024 costs 40% of the
/// frame rate. Note even 1200 still beats scrcpy@720 comfortably, so a caller
/// asking for more is degrading gracefully rather than falling off a cliff.
pub const DEFAULT_MAX_SIDE: u32 = 720;

/// Bounds on a caller-supplied `max_side`. The ceiling is a sanity bound, not
/// a capability limit — the emulator will happily serve its native resolution,
/// it is just slow (3.8 fps at 2400).
const MIN_MAX_SIDE: u32 = 240;
const MAX_MAX_SIDE: u32 = 4096;

/// A discovered emulator gRPC endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrpcEndpoint {
    pub port: u16,
    /// Bearer token from the discovery file. The emulator accepts it directly
    /// as `authorization: Bearer <token>` — no JWT minting, no JWKS handling.
    pub token: Option<String>,
}

/// A running gRPC stream. Far simpler than scrcpy's `ActiveStream`: there is no
/// child process, no adb forward and no socket to close — stopping is a flag
/// the pump loop observes, after which dropping the response body closes the
/// HTTP/2 stream.
pub struct ActiveGrpcStream {
    pub serial: String,
    pub stop: AtomicBool,
    /// Kept so input can reach the same emulator the frames come from, without
    /// re-reading the discovery file on every tap.
    pub endpoint: GrpcEndpoint,
    /// The device's real pixel size, resolved once (see [`device_size`]).
    /// `None` until the first lookup completes; a failed lookup is retried
    /// rather than cached, since it is usually a transient adb hiccup.
    device_size: Mutex<Option<(u32, u32)>>,
}

impl ActiveGrpcStream {
    pub fn new(serial: String, endpoint: GrpcEndpoint) -> Self {
        Self { serial, stop: AtomicBool::new(false), endpoint, device_size: Mutex::new(None) }
    }
}

static GRPC_STREAMS: OnceLock<Mutex<HashMap<String, Arc<ActiveGrpcStream>>>> = OnceLock::new();

fn grpc_streams() -> &'static Mutex<HashMap<String, Arc<ActiveGrpcStream>>> {
    GRPC_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_stream(id: String, stream: Arc<ActiveGrpcStream>) {
    grpc_streams().lock().unwrap().insert(id, stream);
}

/// Remove and flag a stream by id. Returns whether one was registered — the
/// caller uses that to decide whether the id belonged to scrcpy instead.
pub fn stop_stream(id: &str) -> bool {
    let taken = grpc_streams().lock().unwrap().remove(id);
    match taken {
        Some(stream) => {
            stream.stop.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// The live stream for a device, if this transport owns one. Input uses it to
/// decide whether it can inject over gRPC or must leave the job to scrcpy.
pub fn stream_for_serial(serial: &str) -> Option<Arc<ActiveGrpcStream>> {
    grpc_streams().lock().unwrap().values().find(|s| s.serial == serial).cloned()
}

/// Flag every registered stream for `serial` and drop it from the registry.
pub fn stop_streams_for(serial: &str) {
    let mut map = grpc_streams().lock().unwrap();
    let keys: Vec<String> = map
        .iter()
        .filter(|(_, s)| s.serial == serial)
        .map(|(k, _)| k.clone())
        .collect();
    for key in keys {
        if let Some(stream) = map.remove(&key) {
            stream.stop.store(true, Ordering::SeqCst);
        }
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Directories the emulator may write its `pid_<pid>.ini` discovery files into.
///
/// **This is OS-specific and the ordering matters.** Windows uses the process
/// temp dir; on macOS/Linux the emulator prefers `$XDG_RUNTIME_DIR` when it is
/// set and falls back to the temp dir. `/tmp` is listed last because it is a
/// real fallback on Linux but is *not* the temp dir on macOS.
fn discovery_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
        if !runtime.is_empty() {
            dirs.push(PathBuf::from(runtime).join("avd").join("running"));
        }
    }
    dirs.push(std::env::temp_dir().join("avd").join("running"));
    if cfg!(unix) {
        dirs.push(PathBuf::from("/tmp").join("avd").join("running"));
    }
    dirs
}

/// Read `key=value` out of a discovery ini. Values are taken verbatim to the
/// end of the line: `grpc.token` is base64 and can contain `=`, so splitting on
/// every `=` would truncate it.
pub(crate) fn ini_value(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(value) = rest.strip_prefix('=') {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// The console port encoded in an adb serial (`emulator-5554` → `5554`).
/// Returns `None` for a physical device, which is what gates this whole path.
pub(crate) fn emulator_console_port(serial: &str) -> Option<u32> {
    serial.strip_prefix("emulator-")?.parse().ok()
}

/// Find the gRPC endpoint for `serial`, or `None` when there isn't one.
///
/// `None` is an ordinary outcome — a physical device, an emulator too old to
/// publish a discovery file, or one started with gRPC disabled. The caller
/// falls back to scrcpy.
pub fn discover_endpoint(serial: &str) -> Option<GrpcEndpoint> {
    let console_port = emulator_console_port(serial)?;
    for dir in discovery_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("pid_") || !name.ends_with(".ini") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            // Match the file to the device before trusting anything in it —
            // several emulators can be running at once.
            let matches = ini_value(&text, "port.serial")
                .and_then(|p| p.parse::<u32>().ok())
                .map(|p| p == console_port)
                .unwrap_or(false);
            if !matches {
                continue;
            }
            let port = ini_value(&text, "grpc.port").and_then(|p| p.parse::<u16>().ok())?;
            let token = ini_value(&text, "grpc.token").filter(|t| !t.is_empty());
            return Some(GrpcEndpoint { port, token });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Minimal protobuf + gRPC framing
// ---------------------------------------------------------------------------

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// Read a varint at `pos`, returning `(value, next_pos)`.
fn read_varint(buf: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    let mut shift = 0;
    loop {
        let byte = *buf.get(pos)?;
        pos += 1;
        // 10 groups of 7 bits covers a u64; more than that is a malformed
        // stream and must not shift out of range.
        if shift > 63 {
            return None;
        }
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some((value, pos));
        }
        shift += 7;
    }
}

/// Encode an `ImageFormat` request: `format` (1), `width` (3), `height` (4).
/// `display` (5) is left at its default 0 — the main display.
pub(crate) fn encode_image_format(format: u32, width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    out.push(0x08); // field 1, varint
    put_varint(&mut out, format as u64);
    out.push(0x18); // field 3, varint
    put_varint(&mut out, width as u64);
    out.push(0x20); // field 4, varint
    put_varint(&mut out, height as u64);
    out
}

/// The parts of an `Image` message the panel needs.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DecodedImage {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub seq: u32,
}

/// Skip one field's payload given its wire type, returning the next position.
fn skip_field(buf: &[u8], pos: usize, wire: u8) -> Option<usize> {
    match wire {
        0 => read_varint(buf, pos).map(|(_, p)| p),
        1 => pos.checked_add(8).filter(|p| *p <= buf.len()),
        2 => {
            let (len, p) = read_varint(buf, pos)?;
            let end = p.checked_add(len as usize)?;
            if end <= buf.len() { Some(end) } else { None }
        }
        5 => pos.checked_add(4).filter(|p| *p <= buf.len()),
        _ => None,
    }
}

/// Decode the `Image` fields we care about: the embedded `ImageFormat` (1) for
/// the real dimensions, the PNG bytes (4), and the sequence number (5).
///
/// Dimensions come from the nested format, not `Image.width`/`height` — those
/// are marked deprecated in the proto and the emulator does not fill them.
pub(crate) fn decode_image(buf: &[u8]) -> Option<DecodedImage> {
    let mut out = DecodedImage::default();
    let mut pos = 0usize;
    while pos < buf.len() {
        let (key, next) = read_varint(buf, pos)?;
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        pos = next;
        match (field, wire) {
            // ImageFormat: read width (3) / height (4) out of the submessage.
            (1, 2) => {
                let (len, p) = read_varint(buf, pos)?;
                let end = p.checked_add(len as usize)?;
                let sub = buf.get(p..end)?;
                let (w, h) = decode_format_dims(sub)?;
                out.width = w;
                out.height = h;
                pos = end;
            }
            (4, 2) => {
                let (len, p) = read_varint(buf, pos)?;
                let end = p.checked_add(len as usize)?;
                out.png = buf.get(p..end)?.to_vec();
                pos = end;
            }
            (5, 0) => {
                let (seq, p) = read_varint(buf, pos)?;
                out.seq = seq as u32;
                pos = p;
            }
            _ => pos = skip_field(buf, pos, wire)?,
        }
    }
    Some(out)
}

/// Pull `width` (3) and `height` (4) out of a nested `ImageFormat`.
fn decode_format_dims(buf: &[u8]) -> Option<(u32, u32)> {
    let (mut width, mut height) = (0u32, 0u32);
    let mut pos = 0usize;
    while pos < buf.len() {
        let (key, next) = read_varint(buf, pos)?;
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        pos = next;
        match (field, wire) {
            (3, 0) => {
                let (v, p) = read_varint(buf, pos)?;
                width = v as u32;
                pos = p;
            }
            (4, 0) => {
                let (v, p) = read_varint(buf, pos)?;
                height = v as u32;
                pos = p;
            }
            _ => pos = skip_field(buf, pos, wire)?,
        }
    }
    Some((width, height))
}

/// Wrap a protobuf message in gRPC's length-prefixed frame: one compression
/// flag byte (0 = uncompressed) then a big-endian u32 length.
pub(crate) fn frame_message(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(0);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Reassembles gRPC frames from an HTTP/2 body that arrives in arbitrary
/// chunks — a frame routinely spans several, and several can share one.
#[derive(Default)]
pub(crate) struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// Pop the next complete message, or `None` while one is still arriving.
    pub fn next_message(&mut self) -> Option<Vec<u8>> {
        if self.buf.len() < 5 {
            return None;
        }
        let len = u32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
        let total = 5 + len;
        if self.buf.len() < total {
            return None;
        }
        let message = self.buf[5..total].to_vec();
        self.buf.drain(..total);
        Some(message)
    }
}

// ---------------------------------------------------------------------------
// The stream itself
// ---------------------------------------------------------------------------

/// Clamp a caller-supplied long side into something sane, defaulting when absent.
pub fn resolve_max_side(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_MAX_SIDE)
        .clamp(MIN_MAX_SIDE, MAX_MAX_SIDE)
}

/// Pump `streamScreenshot` into `channel` until stopped or the stream ends.
///
/// Returns `Err` only for a failure the caller should surface; a clean stop is
/// `Ok`. The caller decides whether to emit `StreamEvent::Error` (it must not
/// when the stop was deliberate — the panel would fall back to snapshots).
pub async fn run_grpc_stream(
    active: Arc<ActiveGrpcStream>,
    endpoint: GrpcEndpoint,
    max_side: u32,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let send = |event: StreamEvent| {
        let _ = channel.send(event);
    };
    send(StreamEvent::Status { message: "Connecting to the emulator…".into() });

    // `http2_prior_knowledge` is required: the endpoint is cleartext HTTP/2 with
    // no upgrade dance, and gRPC is HTTP/2-only.
    let client = reqwest::Client::builder()
        .http2_prior_knowledge()
        // No overall timeout: this response body is a long-lived stream, and a
        // request timeout would guillotine it mid-flight.
        .build()
        .map_err(|e| format!("Failed to build the emulator gRPC client: {e}"))?;

    // A square box: the emulator fits the device's aspect inside it and never
    // exceeds either side, so one number controls the long edge whatever the
    // orientation is.
    let request = frame_message(&encode_image_format(IMG_FORMAT_PNG, max_side, max_side));

    let url = format!(
        "http://127.0.0.1:{}/android.emulation.control.EmulatorController/streamScreenshot",
        endpoint.port
    );
    let mut builder = client
        .post(&url)
        .header("content-type", "application/grpc+proto")
        .header("te", "trailers")
        // We do not implement gRPC's compressed-frame path, so make sure the
        // server never sends one.
        .header("grpc-accept-encoding", "identity")
        .header("grpc-encoding", "identity");
    if let Some(token) = &endpoint.token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }

    let response = builder
        .body(request)
        .send()
        .await
        .map_err(|e| format!("Could not reach the emulator's gRPC endpoint: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "The emulator's gRPC endpoint refused the stream (HTTP {}).",
            response.status()
        ));
    }
    // gRPC reports application errors in a header/trailer, not the HTTP status.
    if let Some(status) = response.headers().get("grpc-status") {
        if status.to_str().ok().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0) != 0 {
            let message = response
                .headers()
                .get("grpc-message")
                .and_then(|m| m.to_str().ok())
                .unwrap_or("unknown error")
                .to_string();
            return Err(format!("The emulator rejected the screen stream: {message}"));
        }
    }

    let mut body = response.bytes_stream();
    let mut reader = FrameReader::default();
    let mut announced = false;

    while let Some(chunk) = body.next().await {
        if active.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let chunk = chunk.map_err(|e| format!("The emulator screen stream dropped: {e}"))?;
        reader.push(&chunk);
        while let Some(message) = reader.next_message() {
            if active.stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            let Some(image) = decode_image(&message) else { continue };
            if image.png.is_empty() {
                continue;
            }
            if !announced {
                announced = true;
                send(StreamEvent::Ready { width: image.width, height: image.height });
            }
            send(StreamEvent::PngFrame {
                data: base64::engine::general_purpose::STANDARD.encode(&image.png),
                width: image.width,
                height: image.height,
                seq: image.seq,
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
//
// The emulator serves `sendTouch` / `sendKey` on the same endpoint, with the
// same token, as the screen stream — so taking the streaming win must not cost
// the input win. Without this, an emulator on the gRPC path has no scrcpy
// server and therefore no control socket, and every tap silently falls back to
// `adb shell input` at 600–1300 ms.
//
// Two differences from the scrcpy control socket are load-bearing:
//
// - **Coordinates are device pixels.** scrcpy's control message carries the
//   frame size and the *device* scales; here the frame is whatever box the
//   emulator downscaled to, so the scaling is ours to do (see [`scale_to_device`]).
// - **Keys are w3c key *names*, not Android keycodes.** `KeyboardEvent.keyCode`
//   is interpreted as USB/evdev/XKB, none of which are Android's numbering, so
//   the panel's keycodes are mapped to the `key` strings the emulator documents
//   for the phone buttons ([`w3c_key_for`]). Anything unmapped reports "not
//   handled" and takes the adb path rather than pressing the wrong key.

/// One pooled HTTP/2 client for input. Rebuilding it per tap would mean a fresh
/// connection per event, which is most of what this path exists to avoid.
static INPUT_CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();

fn input_client() -> Option<&'static reqwest::Client> {
    INPUT_CLIENT
        .get_or_init(|| reqwest::Client::builder().http2_prior_knowledge().build().ok())
        .as_ref()
}

/// `Touch` (x=1, y=2, identifier=3, pressure=4) wrapped in a `TouchEvent`
/// (touches=1). `display` (2) stays at its default 0, the main display.
///
/// Field numbers are from the `emulator_controller.proto` that ships next to
/// the running emulator, not from a vendored copy.
pub(crate) fn encode_touch_event(x: i32, y: i32, pressure: i32, identifier: i32) -> Vec<u8> {
    let mut touch = Vec::with_capacity(12);
    touch.push(0x08); // x, field 1 varint
    put_varint(&mut touch, x.max(0) as u64);
    touch.push(0x10); // y, field 2 varint
    put_varint(&mut touch, y.max(0) as u64);
    touch.push(0x18); // identifier, field 3 varint
    put_varint(&mut touch, identifier.max(0) as u64);
    touch.push(0x20); // pressure, field 4 varint
    put_varint(&mut touch, pressure.max(0) as u64);

    let mut event = Vec::with_capacity(touch.len() + 2);
    event.push(0x0A); // touches, field 1, length-delimited
    put_varint(&mut event, touch.len() as u64);
    event.extend_from_slice(&touch);
    event
}

/// `KeyboardEvent { eventType: keypress, key: <w3c name> }`.
///
/// `eventType` must be set explicitly: its default is `keydown`, so leaving it
/// out holds the key down forever instead of pressing it.
pub(crate) fn encode_key_press(key: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(key.len() + 4);
    out.push(0x10); // eventType, field 2 varint
    put_varint(&mut out, 2); // keypress
    out.push(0x22); // key, field 4, length-delimited
    put_varint(&mut out, key.len() as u64);
    out.extend_from_slice(key.as_bytes());
    out
}

/// `KeyboardEvent { text }` — field 5. The emulator translates each character
/// and ignores every other field, which is why this is separate from
/// [`encode_key_press`].
pub(crate) fn encode_key_text(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3);
    out.push(0x2A); // text, field 5, length-delimited
    put_varint(&mut out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
    out
}

/// Android keycode → the w3c `key` value the emulator understands.
///
/// The four phone buttons have documented names in the proto (`GoHome`,
/// `GoBack`, `AppSwitch`, `Power`); the rest are ordinary w3c names that
/// Chromium's translation tables carry. `None` means "we don't know this one" —
/// the caller falls back to adb rather than guessing, because a wrong guess
/// presses a real key on the user's device.
pub(crate) fn w3c_key_for(keycode: i32) -> Option<&'static str> {
    Some(match keycode {
        3 => "GoHome",
        4 => "GoBack",
        187 => "AppSwitch",
        26 => "Power",
        82 => "ContextMenu",
        24 => "AudioVolumeUp",
        25 => "AudioVolumeDown",
        66 => "Enter",
        67 => "Backspace",
        61 => "Tab",
        111 => "Escape",
        19 => "ArrowUp",
        20 => "ArrowDown",
        21 => "ArrowLeft",
        22 => "ArrowRight",
        _ => return None,
    })
}

/// Map a point on the streamed frame to a point on the real screen.
///
/// The frame is a downscaled box (say 324x720) and the emulator wants device
/// pixels (1080x2400). **Orientation is the trap**: `wm size` keeps reporting
/// the physical portrait size after a rotation, while the frame arrives
/// landscape, so the device dimensions are swapped to match the frame's
/// orientation before scaling — otherwise a tap in landscape lands somewhere
/// else entirely.
pub(crate) fn scale_to_device(
    x: i32,
    y: i32,
    frame: (u32, u32),
    device: (u32, u32),
) -> (i32, i32) {
    let (fw, fh) = frame;
    let (mut dw, mut dh) = device;
    if (fw > fh) != (dw > dh) {
        std::mem::swap(&mut dw, &mut dh);
    }
    if fw == 0 || fh == 0 {
        return (x, y);
    }
    let sx = (x as f64) * (dw as f64) / (fw as f64);
    let sy = (y as f64) * (dh as f64) / (fh as f64);
    // Clamp inside the screen: a tap on the very last column rounds to `dw`,
    // which is one pixel outside and is dropped by the input stack.
    (
        (sx.round() as i32).clamp(0, dw.saturating_sub(1) as i32),
        (sy.round() as i32).clamp(0, dh.saturating_sub(1) as i32),
    )
}

/// The device's pixel size, resolved once per stream and cached.
///
/// One `adb shell wm size` per stream rather than per tap. A failure is not
/// cached — it is usually adb still coming up — and yields `None`, which sends
/// the caller to the adb fallback for that event.
async fn device_size(active: &Arc<ActiveGrpcStream>) -> Option<(u32, u32)> {
    // Scoped so the std guard is dropped before the await below.
    if let Some(size) = *active.device_size.lock().unwrap() {
        return Some(size);
    }
    let size = crate::commands::mobile::android_screen_size(&active.serial).await.ok()?;
    if size.0 == 0 || size.1 == 0 {
        return None;
    }
    *active.device_size.lock().unwrap() = Some(size);
    Some(size)
}

/// Resolve and cache the device size ahead of the first tap, so that tap pays
/// gRPC latency rather than adb's. Fire-and-forget: if it fails the first
/// input event simply resolves it then.
pub fn prime_device_size(active: Arc<ActiveGrpcStream>) {
    tauri::async_runtime::spawn(async move {
        let _ = device_size(&active).await;
    });
}

/// One unary gRPC call. `Ok(())` means the emulator accepted it.
///
/// gRPC reports application errors in a trailer, which `reqwest` does not
/// expose — but an emulator that rejects a call answers Trailers-Only, putting
/// `grpc-status` in the *headers*, which is the case worth catching. A
/// mis-encoded message that the emulator merely ignores would look like success
/// here, so correctness of the encoders is carried by tests, not by this check.
async fn unary_call(endpoint: &GrpcEndpoint, method: &str, payload: Vec<u8>) -> Result<(), String> {
    let client = input_client().ok_or_else(|| "No HTTP/2 client for emulator input.".to_string())?;
    let url = format!(
        "http://127.0.0.1:{}/android.emulation.control.EmulatorController/{method}",
        endpoint.port
    );
    let mut builder = client
        .post(&url)
        .header("content-type", "application/grpc+proto")
        .header("te", "trailers")
        .header("grpc-accept-encoding", "identity")
        .header("grpc-encoding", "identity");
    if let Some(token) = &endpoint.token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = builder
        .body(frame_message(&payload))
        .send()
        .await
        .map_err(|e| format!("The emulator refused an input event: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The emulator refused an input event (HTTP {}).", response.status()));
    }
    if let Some(status) = response.headers().get("grpc-status") {
        if status.to_str().ok().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0) != 0 {
            let message = response
                .headers()
                .get("grpc-message")
                .and_then(|m| m.to_str().ok())
                .unwrap_or("unknown error")
                .to_string();
            return Err(format!("The emulator rejected an input event: {message}"));
        }
    }
    Ok(())
}

/// Every input entry point answers `false` for "this transport did not handle
/// it" — no gRPC stream for the device, an unmapped key, or a call that failed.
/// The caller then tries scrcpy's control socket and finally adb, so input
/// degrades in speed but never stops working. A failure is deliberately not an
/// `Err`: surfacing it would abort the panel's fallback and leave the tap
/// undelivered.
fn handled(result: Result<(), String>) -> bool {
    if let Err(e) = &result {
        // Worth a line in the log: the tap still lands via adb, so the only
        // symptom the user sees is that it got slow.
        eprintln!("emulator gRPC input fell back: {e}");
    }
    result.is_ok()
}

/// Inject a touch. `touching` is false for lift and cancel, which must report
/// zero pressure or the emulator keeps tracking a finger that is no longer down.
pub async fn send_touch(
    serial: &str,
    x: i32,
    y: i32,
    frame_width: u32,
    frame_height: u32,
    touching: bool,
) -> bool {
    let Some(active) = stream_for_serial(serial) else { return false };
    let Some(device) = device_size(&active).await else { return false };
    let (dx, dy) = scale_to_device(x, y, (frame_width, frame_height), device);
    let payload = encode_touch_event(dx, dy, if touching { 1 } else { 0 }, 0);
    handled(unary_call(&active.endpoint, "sendTouch", payload).await)
}

/// Press a key by Android keycode. Unmapped keycodes report `false` untouched.
pub async fn send_key(serial: &str, keycode: i32) -> bool {
    let Some(active) = stream_for_serial(serial) else { return false };
    let Some(key) = w3c_key_for(keycode) else { return false };
    handled(unary_call(&active.endpoint, "sendKey", encode_key_press(key)).await)
}

/// Type text into the focused field.
pub async fn send_text(serial: &str, text: &str) -> bool {
    let Some(active) = stream_for_serial(serial) else { return false };
    handled(unary_call(&active.endpoint, "sendKey", encode_key_text(text)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ini_values_survive_base64_padding() {
        // The real failure this guards: `grpc.token` is base64 and ends in `=`,
        // so a naive `split('=')` truncates the token and every call 401s.
        let ini = "port.serial=5554\ngrpc.token=SbTwlUv+0qQ3d/fJ5u1O==\ngrpc.port=8554\n";
        assert_eq!(ini_value(ini, "grpc.token").as_deref(), Some("SbTwlUv+0qQ3d/fJ5u1O=="));
        assert_eq!(ini_value(ini, "grpc.port").as_deref(), Some("8554"));
        assert_eq!(ini_value(ini, "nope"), None);
    }

    #[test]
    fn only_emulator_serials_have_a_console_port() {
        assert_eq!(emulator_console_port("emulator-5554"), Some(5554));
        // A physical device must not resolve, or we would try to stream a
        // gRPC endpoint that belongs to some unrelated emulator.
        assert_eq!(emulator_console_port("39affe1a"), None);
        assert_eq!(emulator_console_port("emulator-abc"), None);
    }

    #[test]
    fn image_format_round_trips_through_the_decoder() {
        let encoded = encode_image_format(IMG_FORMAT_PNG, 328, 720);
        let (w, h) = decode_format_dims(&encoded).expect("dims");
        assert_eq!((w, h), (328, 720));
    }

    #[test]
    fn decodes_an_image_message() {
        // Image { format { width=324, height=720 }, image=<png>, seq=7 }
        let format = encode_image_format(IMG_FORMAT_PNG, 324, 720);
        let png = b"\x89PNG\r\n\x1a\nfake".to_vec();
        let mut msg = Vec::new();
        msg.push(0x0A); // field 1, length-delimited
        put_varint(&mut msg, format.len() as u64);
        msg.extend_from_slice(&format);
        msg.push(0x22); // field 4, length-delimited
        put_varint(&mut msg, png.len() as u64);
        msg.extend_from_slice(&png);
        msg.push(0x28); // field 5, varint
        put_varint(&mut msg, 7);

        let decoded = decode_image(&msg).expect("decode");
        assert_eq!(decoded.width, 324);
        assert_eq!(decoded.height, 720);
        assert_eq!(decoded.seq, 7);
        assert_eq!(decoded.png, png);
    }

    #[test]
    fn decoding_tolerates_unknown_fields() {
        // `timestampUs` (field 6) is present on every real frame and we do not
        // read it — an unknown field must be skipped, not abort the parse.
        let png = b"png".to_vec();
        let mut msg = Vec::new();
        msg.push(0x30); // field 6, varint
        put_varint(&mut msg, 1_700_000_000_000_000);
        msg.push(0x22); // field 4, bytes
        put_varint(&mut msg, png.len() as u64);
        msg.extend_from_slice(&png);
        let decoded = decode_image(&msg).expect("decode");
        assert_eq!(decoded.png, png);
    }

    #[test]
    fn malformed_messages_do_not_panic() {
        // A truncated length-delimited field must return None rather than
        // slicing out of range.
        assert!(decode_image(&[0x22, 0xFF, 0xFF, 0x01]).is_none());
        assert!(decode_image(&[0x08]).is_none());
        // An unsupported wire type (3/4 are the removed group markers).
        assert!(decode_image(&[0x0B, 0x00]).is_none());
    }

    #[test]
    fn frame_reader_reassembles_split_and_coalesced_frames() {
        let a = frame_message(b"hello");
        let b = frame_message(b"world");
        let mut reader = FrameReader::default();

        // One frame split across chunks: nothing until it is complete.
        reader.push(&a[..3]);
        assert!(reader.next_message().is_none());
        reader.push(&a[3..]);
        assert_eq!(reader.next_message().as_deref(), Some(&b"hello"[..]));
        assert!(reader.next_message().is_none());

        // Two frames arriving in one chunk.
        let mut both = b.clone();
        both.extend_from_slice(&frame_message(b"again"));
        reader.push(&both);
        assert_eq!(reader.next_message().as_deref(), Some(&b"world"[..]));
        assert_eq!(reader.next_message().as_deref(), Some(&b"again"[..]));
        assert!(reader.next_message().is_none());
    }

    /// End-to-end against a **live emulator**. Ignored by default because it
    /// needs one running; run with:
    ///
    /// ```text
    /// cargo test --lib emulator_grpc -- --ignored --nocapture
    /// ```
    ///
    /// This is the test that matters for the hand-rolled protobuf: the
    /// synthetic cases above prove the decoder is self-consistent, which is
    /// exactly what a wrong field number would also be. Only real emulator
    /// bytes prove the field numbers are right.
    #[tokio::test]
    #[ignore]
    async fn streams_real_frames_from_a_live_emulator() {
        let endpoint = discover_endpoint("emulator-5554")
            .expect("no emulator-5554 with a gRPC endpoint — is one running?");
        println!("endpoint: port={} token={}", endpoint.port, endpoint.token.is_some());

        let client = reqwest::Client::builder()
            .http2_prior_knowledge()
            .build()
            .expect("client");
        let request = frame_message(&encode_image_format(IMG_FORMAT_PNG, 720, 720));
        let url = format!(
            "http://127.0.0.1:{}/android.emulation.control.EmulatorController/streamScreenshot",
            endpoint.port
        );
        let mut builder = client
            .post(&url)
            .header("content-type", "application/grpc+proto")
            .header("te", "trailers")
            .header("grpc-accept-encoding", "identity");
        if let Some(token) = &endpoint.token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let response = builder.body(request).send().await.expect("send");
        assert!(response.status().is_success(), "HTTP {}", response.status());

        let mut body = response.bytes_stream();
        let mut reader = FrameReader::default();
        let mut frames = 0;
        let mut dims = (0u32, 0u32);
        while let Some(chunk) = body.next().await {
            reader.push(&chunk.expect("chunk"));
            while let Some(message) = reader.next_message() {
                let image = decode_image(&message).expect("decode a real frame");
                // The PNG signature is the proof the `image` field number (4)
                // is right — a wrong one yields plausible-looking garbage.
                assert_eq!(&image.png[..8], b"\x89PNG\r\n\x1a\n", "not a PNG payload");
                assert!(image.width > 0 && image.height > 0, "no dims in the nested format");
                assert!(image.width <= 720 && image.height <= 720, "exceeded requested box");
                dims = (image.width, image.height);
                frames += 1;
            }
            if frames >= 5 {
                break;
            }
        }
        println!("decoded {frames} real frames at {}x{}", dims.0, dims.1);
        assert!(frames >= 5, "only {frames} frames arrived");
    }

    #[test]
    fn max_side_is_clamped_and_defaulted() {
        assert_eq!(resolve_max_side(None), DEFAULT_MAX_SIDE);
        assert_eq!(resolve_max_side(Some(1024)), 1024);
        assert_eq!(resolve_max_side(Some(0)), MIN_MAX_SIDE);
        assert_eq!(resolve_max_side(Some(99_999)), MAX_MAX_SIDE);
    }

    /// Read `(field, varint)` pairs out of a flat message, for the input tests.
    fn varint_fields(buf: &[u8]) -> Vec<(u32, u64)> {
        let mut out = Vec::new();
        let mut pos = 0usize;
        while pos < buf.len() {
            let (key, next) = read_varint(buf, pos).expect("key");
            let field = (key >> 3) as u32;
            let wire = (key & 7) as u8;
            pos = next;
            if wire == 0 {
                let (v, p) = read_varint(buf, pos).expect("value");
                out.push((field, v));
                pos = p;
            } else {
                pos = skip_field(buf, pos, wire).expect("skip");
            }
        }
        out
    }

    /// Unwrap the single `Touch` out of a `TouchEvent` (touches = field 1).
    fn first_touch(event: &[u8]) -> Vec<u8> {
        assert_eq!(event[0], 0x0A, "touches must be field 1, length-delimited");
        let (len, p) = read_varint(event, 1).expect("len");
        event[p..p + len as usize].to_vec()
    }

    #[test]
    fn touch_carries_coordinates_pressure_and_identifier() {
        let touch = first_touch(&encode_touch_event(120, 340, 1, 0));
        let fields = varint_fields(&touch);
        // x=1, y=2, identifier=3, pressure=4 — the numbering from the SDK's own
        // emulator_controller.proto.
        assert_eq!(fields, vec![(1, 120), (2, 340), (3, 0), (4, 1)]);
    }

    #[test]
    fn a_lift_reports_zero_pressure() {
        // Non-zero pressure means "still touching": an UP that kept pressure
        // leaves the emulator tracking a finger that is no longer down, and the
        // identifier is never unregistered.
        let touch = first_touch(&encode_touch_event(10, 20, 0, 0));
        assert!(varint_fields(&touch).contains(&(4, 0)));
    }

    #[test]
    fn a_key_press_sets_the_event_type() {
        // eventType defaults to `keydown`, so omitting it holds the key down
        // forever instead of pressing it. 2 is `keypress`.
        let encoded = encode_key_press("GoHome");
        assert!(varint_fields(&encoded).contains(&(2, 2)), "eventType must be keypress");
        assert!(encoded.windows(6).any(|w| w == b"GoHome"), "key name must be carried");
    }

    #[test]
    fn text_goes_in_its_own_field() {
        // Field 5, and deliberately *not* alongside a key: the emulator ignores
        // every other field when `text` is set.
        let encoded = encode_key_text("hi");
        assert_eq!(encoded[0], 0x2A);
        assert!(encoded.ends_with(b"hi"));
    }

    #[test]
    fn the_phone_buttons_map_to_the_documented_names() {
        // These four names are given in the proto itself; the rest are ordinary
        // w3c values.
        assert_eq!(w3c_key_for(3), Some("GoHome"));
        assert_eq!(w3c_key_for(4), Some("GoBack"));
        assert_eq!(w3c_key_for(187), Some("AppSwitch"));
        assert_eq!(w3c_key_for(26), Some("Power"));
        // An unmapped keycode must NOT be approximated — the caller falls back
        // to adb, which speaks Android keycodes natively.
        assert_eq!(w3c_key_for(999), None);
    }

    #[test]
    fn frame_coordinates_scale_up_to_device_pixels() {
        // The frame is a downscaled box; the emulator wants real screen pixels.
        let (x, y) = scale_to_device(162, 360, (324, 720), (1080, 2400));
        assert_eq!((x, y), (540, 1200));
    }

    #[test]
    fn landscape_frames_swap_the_reported_device_size() {
        // `wm size` keeps reporting the physical portrait size after a
        // rotation, so a landscape frame must be scaled against swapped
        // dimensions or every tap lands somewhere else entirely.
        let (x, y) = scale_to_device(360, 162, (720, 324), (1080, 2400));
        assert_eq!((x, y), (1200, 540));
    }

    #[test]
    fn taps_stay_inside_the_screen() {
        // The last column rounds to exactly `width`, which is one pixel outside
        // and gets dropped by the input stack.
        let (x, y) = scale_to_device(324, 720, (324, 720), (1080, 2400));
        assert_eq!((x, y), (1079, 2399));
    }

    /// Sends a real tap to a **live emulator**, for the same reason as the
    /// streaming test above: the synthetic cases prove the encoder is
    /// self-consistent, which a wrong field number would also be. Run with
    /// `cargo test --lib emulator_grpc -- --ignored --nocapture` and watch the
    /// device — this presses HOME.
    #[tokio::test]
    #[ignore]
    async fn sends_real_input_to_a_live_emulator() {
        let endpoint = discover_endpoint("emulator-5554")
            .expect("no emulator-5554 with a gRPC endpoint — is one running?");
        // Deliberately lopsided coordinates: x == y would pass even if the two
        // field numbers were swapped. Verify against
        // `adb shell getevent -lc 10 /dev/input/event2`, which must report
        // ABS_MT_POSITION_X 0000012c (300) and ABS_MT_POSITION_Y 00000384 (900).
        unary_call(&endpoint, "sendTouch", encode_touch_event(300, 900, 1, 0))
            .await
            .expect("touch down");
        unary_call(&endpoint, "sendTouch", encode_touch_event(300, 900, 0, 0))
            .await
            .expect("touch up");
        unary_call(&endpoint, "sendKey", encode_key_press("GoHome")).await.expect("home");
    }
}
