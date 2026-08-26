//! Silero VAD v5 — neural voice-activity detection, native via ONNX Runtime.
//!
//! The renderer's level-gate VAD (`voice-input.ts`) is a hand-tuned RMS
//! threshold with hysteresis. It works, but it fundamentally measures LOUDNESS:
//! fans, keyboard clatter and background chatter that sit above the noise floor
//! look like speech. Silero measures SPEECH-NESS — a tiny RNN trained to say
//! "this 32 ms window contains human voice", robust to exactly the noise the
//! gate trips on.
//!
//! Streaming shape: the renderer keeps its capture graph (and RMS pipeline) as
//!-is and periodically feeds raw PCM here; each feed returns the max speech
//! probability across the windows it completed. State (the RNN hidden tensors)
//! lives in `SESSIONS` between feeds, so probability stays context-aware across
//! the whole utterance rather than per-chunk.
//!
//! The model file (~2 MB `silero_vad.onnx`) comes through the normal model
//! download flow (`models.rs`); without it every command errors and the
//! renderer silently falls back to the level gate.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

use crate::commands::parakeet::{ensure_ort_dylib, resample_to_16k};

pub const SILERO_VAD_FILENAME: &str = "silero_vad.onnx";

/// Silero v5 consumes fixed 512-sample windows at 16 kHz (32 ms).
const WINDOW: usize = 512;
/// The streaming state tensor: [2, 1, 128] f32.
const STATE_LEN: usize = 2 * 1 * 128;

struct VadSession {
    session: Session,
    state: Vec<f32>,
    /// Samples resampled to 16 kHz but not yet filling a complete window.
    pending: Vec<f32>,
}

static SESSIONS: Mutex<Option<HashMap<i64, VadSession>>> = Mutex::new(None);
static NEXT_ID: AtomicI64 = AtomicI64::new(1);

fn vad_model_path() -> PathBuf {
    crate::commands::models::get_models_dir().join(SILERO_VAD_FILENAME)
}

fn build_session(path: &PathBuf) -> Result<Session, String> {
    ensure_ort_dylib()?;
    Session::builder()
        .map_err(|e| format!("ORT session builder failed: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level1)
        .map_err(|e| format!("ORT optimization level failed: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("Failed to load VAD model {}: {e}", path.display()))
}

/// Forget all live VAD sessions (model deleted/re-downloaded).
pub fn reset_vad() {
    if let Ok(mut guard) = SESSIONS.lock() {
        *guard = None;
    }
}

fn with_sessions<T>(
    f: impl FnOnce(&mut HashMap<i64, VadSession>) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = SESSIONS
        .lock()
        .map_err(|_| "VAD session lock poisoned".to_string())?;
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

#[tauri::command]
pub fn vad_session_start() -> Result<i64, String> {
    let path = vad_model_path();
    if !path.exists() {
        return Err("Smart VAD model is not downloaded. Get it in Settings → Local Speech-to-Text.".to_string());
    }
    let session = build_session(&path)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    with_sessions(|map| {
        map.insert(id, VadSession { session, state: vec![0.0; STATE_LEN], pending: Vec::new() });
        Ok(id)
    })
}

/// Feed raw mono PCM (any rate we can resample) and get back the highest speech
/// probability across the 32 ms windows this feed completed. Fewer than 512
/// samples of new audio returns the neutral 0.0 — the caller keeps its previous
/// reading.
#[tauri::command]
pub fn vad_session_feed(
    session_id: i64,
    samples: Vec<i16>,
    sample_rate: i64,
) -> Result<f64, String> {
    if samples.is_empty() {
        return Ok(0.0);
    }
    let pcm_f32: Vec<f32> = samples.iter().map(|s| *s as f32 / 32768.0).collect();
    let mut audio = resample_to_16k(&pcm_f32, sample_rate.max(1) as usize);

    with_sessions(|map| {
        let vad = map
            .get_mut(&session_id)
            .ok_or("Unknown VAD session".to_string())?;
        vad.pending.append(&mut audio);

        let windows = vad.pending.len() / WINDOW;
        if windows == 0 {
            return Ok(0.0);
        }

        // Batch every complete window into one run: input [N, 512].
        let mut input = Vec::with_capacity(windows * WINDOW);
        input.extend(vad.pending.drain(..windows * WINDOW));

        let input_tensor = Tensor::from_array(([windows as usize, WINDOW], input))
            .map_err(|e| format!("vad input tensor: {e}"))?;
        let state_tensor = Tensor::from_array(([2usize, 1usize, 128usize], vad.state.clone()))
            .map_err(|e| format!("vad state tensor: {e}"))?;
        let sr_tensor = Tensor::from_array(([1usize], vec![16_000i64]))
            .map_err(|e| format!("vad sr tensor: {e}"))?;

        let outputs = vad
            .session
            .run(
                ort::inputs![
                    "input" => input_tensor,
                    "state" => state_tensor,
                    "sr" => sr_tensor,
                ],
            )
            .map_err(|e| format!("vad run: {e}"))?;

        let (_, probs) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("extract vad output: {e}"))?;
        let max_prob = probs.iter().copied().fold(0.0f32, f32::max);

        let (_, new_state) = outputs["stateN"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("extract vad state: {e}"))?;
        if new_state.len() == STATE_LEN {
            vad.state.copy_from_slice(new_state);
        }

        Ok(max_prob as f64)
    })
}

#[tauri::command]
pub fn vad_session_end(session_id: i64) -> Result<(), String> {
    with_sessions(|map| {
        map.remove(&session_id);
        Ok(())
    })
}
