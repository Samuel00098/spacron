//! Offline Whisper speech-to-text via native whisper.cpp (`whisper-rs`).
//!
//! Runs in the app process (not the WebKit renderer), using the GGML models the
//! app already downloads. whisper.cpp mmaps the weights, so RAM stays modest even
//! for the larger models. The context is cached and reused across calls.
//!
//! Audio comes in as the same s16le WAV bytes the renderer sends for every local
//! STT provider; we decode + resample to the 16 kHz mono f32 Whisper expects
//! (reusing the helpers in `parakeet`).

use std::path::PathBuf;
use std::sync::Mutex;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::commands::parakeet::{resample_to_16k, wav_to_f32};

const TARGET_SAMPLE_RATE: usize = 16_000;

/// Cached whisper context, keyed by the model file it was loaded from. Loading a
/// context is expensive, so we keep the last one warm and only reload when the
/// selected model changes.
struct CachedWhisper {
    model_path: String,
    ctx: WhisperContext,
}

static CONTEXT: Mutex<Option<CachedWhisper>> = Mutex::new(None);

/// Drop the cached context (e.g. after the model is deleted/re-downloaded).
pub fn reset_whisper() {
    if let Ok(mut guard) = CONTEXT.lock() {
        *guard = None;
    }
}

/// Transcribe s16le WAV bytes with a Whisper GGML model.
///
/// `initial_prompt` is the hotword-biasing hint (the developer's custom
/// vocabulary, one comma-separated line): whisper.cpp conditions its decoding
/// on it, which steers the spelling of unusual names and API terms. Capped —
/// the prompt shares the model's context window with the actual audio.
pub fn transcribe_wav(
    wav_bytes: &[u8],
    model_path: PathBuf,
    initial_prompt: Option<&str>,
) -> Result<String, String> {
    let (pcm, rate) = wav_to_f32(wav_bytes)?;
    let audio = resample_to_16k(&pcm, rate);
    // Guard against near-empty capture (< 200 ms) — whisper hallucinates on it.
    if audio.len() < TARGET_SAMPLE_RATE / 5 {
        return Ok(String::new());
    }

    let model_str = model_path.to_string_lossy().to_string();

    let mut guard = CONTEXT
        .lock()
        .map_err(|_| "Whisper context lock poisoned".to_string())?;
    if guard.as_ref().map(|c| c.model_path.as_str()) != Some(model_str.as_str()) {
        let ctx = WhisperContext::new_with_params(&model_str, WhisperContextParameters::default())
            .map_err(|e| format!("Failed to load Whisper model: {e}"))?;
        *guard = Some(CachedWhisper {
            model_path: model_str.clone(),
            ctx,
        });
    }
    let cached = guard.as_ref().unwrap();

    let mut state = cached
        .ctx
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // English-only models (…-en) must stay on "en"; multilingual models
    // auto-detect. The GGML filename encodes this, so key off the model path.
    if model_str.contains(".en.") || model_str.contains("-en") {
        params.set_language(Some("en"));
    } else {
        params.set_language(Some("auto"));
    }
    if let Some(prompt) = initial_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        params.set_initial_prompt(&prompt.chars().take(600).collect::<String>());
    }

    state
        .full(params, &audio)
        .map_err(|e| format!("Whisper transcription failed: {e}"))?;

    let mut text = String::new();
    for segment in state.as_iter() {
        if let Ok(s) = segment.to_str_lossy() {
            text.push_str(&s);
        }
    }
    Ok(text.trim().to_string())
}
