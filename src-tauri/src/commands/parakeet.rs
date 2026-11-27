//! Fully-offline NVIDIA Parakeet TDT v3 speech-to-text, run natively via ONNX
//! Runtime (the `ort` crate) in the app process.
//!
//! This is a faithful port of the renderer-side `parakeet.js` pipeline that
//! previously ran in the WebKit web process via onnxruntime-web (WASM). That WASM
//! path grew a CPU memory arena that never shrank and OOM-killed the WebKitGTK web
//! process on long utterances (the "app dies when loading text into the box"
//! crash). Running the exact same three ONNX files (preprocessor / encoder /
//! decoder-joint) through native ONNX Runtime keeps the heavy inference out of the
//! renderer entirely, and native OS memory has far more headroom.
//!
//! The model math is unchanged: all DSP (log-mel + CMVN normalisation) lives
//! inside `parakeet-preprocessor.onnx`, so quality is identical to the JS path.
//! What is ported here is the glue: WAV decode + resample, silence trimming, the
//! greedy TDT decode loop, SentencePiece detokenisation, and repetition collapse.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

const TARGET_SAMPLE_RATE: usize = 16_000;

// Decoder (prediction network) shape constants, matching parakeet.js.
const PRED_LAYERS: usize = 2;
const PRED_HIDDEN: usize = 640;
const MAX_TOKENS_PER_STEP: usize = 10;

// Minimum voiced audio (after trimming) worth running the model on. Shorter is
// treated as silence/noise and returns empty rather than risking a hallucinated
// filler word. 200 ms @ 16 kHz.
const MIN_VOICED_SAMPLES: usize = TARGET_SAMPLE_RATE / 5;

// Longest audio (seconds) fed to the encoder in a single pass. The Conformer
// encoder's self-attention is O(T^2) in audio length; splitting long audio into
// bounded windows caps peak memory and latency regardless of how long the user
// talks. Short utterances (the overwhelming majority) stay single-pass.
const MAX_WINDOW_SECONDS: usize = 30;
// When a window has to be cut, search this far back from the hard edge for the
// quietest 20 ms frame and cut there, so the split lands in a pause, not mid-word.
const CUT_SEARCH_SECONDS: usize = 4;

/// Cached ONNX sessions + tokenizer. Loading the encoder (~600 MB) is expensive,
/// so we keep the sessions warm across transcription calls.
struct ParakeetSessions {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    id2token: Vec<String>,
    blank_id: usize,
}

static SESSIONS: Mutex<Option<ParakeetSessions>> = Mutex::new(None);

/// Drop the cached sessions (e.g. after the model is deleted/re-downloaded).
pub fn reset_parakeet() {
    if let Ok(mut guard) = SESSIONS.lock() {
        *guard = None;
    }
}

/// The ONNX Runtime shared library's file name on this platform.
///
/// This is what `dlopen`/`LoadLibrary` is asked for, and it is also the name a
/// user dropping the library in by hand has to use.
const ORT_DYLIB_NAME: &str = if cfg!(windows) {
    "onnxruntime.dll"
} else if cfg!(target_os = "macos") {
    "libonnxruntime.dylib"
} else {
    "libonnxruntime.so"
};

/// Point `ort` at an ONNX Runtime shared library, once per process, and refuse
/// cleanly when there isn't one.
///
/// ## Why this has to exist
///
/// The `ort` dependency uses the `load-dynamic` feature, which pulls in
/// `ort-sys/disable-linking`. That makes `ort-sys`'s build script return
/// immediately — its own comment says it "doesn't need to download anything
/// because we don't provide DLLs anymore". So **nothing in this build produces
/// an ONNX Runtime library**, on any platform: not in `target/`, not next to
/// the binary, not in a bundle. Parakeet STT is therefore dead everywhere,
/// dev included, unless the host happens to have ONNX Runtime on its loader
/// search path.
///
/// And it does not fail politely. `ort`'s lazy API setup ends in
/// `load_dylib_from_path(&path).expect("Failed to load ONNX Runtime dylib")`, so
/// the first touch of any `ort` API on a machine without the library **panics**.
/// This function's real job is to make sure that line is never reached: it
/// returns an ordinary `Err` naming the exact file and the paths searched, which
/// the caller surfaces as a normal STT error.
///
/// ## Search order
///
/// 1. `ORT_DYLIB_PATH` already set — the user or a packager has spoken. Left
///    exactly alone; `ort` reads that variable itself.
/// 2. The models directory, beside the Parakeet `.onnx` files it pairs with —
///    the writable, no-admin location the app already owns, and where an in-app
///    download would land.
/// 3. Next to the executable — where `copy-dylibs` would put it if the link
///    strategy ever changes, and where an installer would naturally place it.
///
/// The Tauri resource directory is not consulted: reaching it needs an
/// `AppHandle` this module does not have, and a bundled copy would be staged
/// into one of the two locations above anyway.
///
/// Note the mechanism is the environment variable rather than a builder call:
/// rc.12 exposes no `with_dylib_path`, and `ORT_DYLIB_PATH` is the only lever it
/// reads. Setting it here is safe because it happens under a lock, before
/// this process has made any `ort` call — nothing else in the tree reads or
/// writes that variable.
pub(crate) fn ensure_ort_dylib() -> Result<(), String> {
    // Only success is remembered: the library can arrive while the app runs.
    static FOUND: OnceLock<()> = OnceLock::new();
    static LOOKING: Mutex<()> = Mutex::new(());

    if FOUND.get().is_some() {
        return Ok(());
    }
    let _looking = LOOKING.lock().map_err(|_| "ONNX Runtime lock poisoned".to_string())?;
    let result = (|| {
        if std::env::var_os("ORT_DYLIB_PATH").is_some_and(|value| !value.is_empty()) {
            return Ok(());
        }

        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(dir) = dirs::config_dir() {
            candidates.push(dir.join("spacron").join("models").join(ORT_DYLIB_NAME));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join(ORT_DYLIB_NAME));
            }
        }

        if let Some(found) = candidates.iter().find(|path| path.is_file()) {
            std::env::set_var("ORT_DYLIB_PATH", found);
            return Ok(());
        }

        Err(format!(
            "ONNX Runtime is not installed. Spacron downloads it the first time you \
             dictate, so check your connection and try again. To add it by hand, put \
             {ORT_DYLIB_NAME} in {} or set ORT_DYLIB_PATH to it.",
            candidates
                .first()
                .and_then(|path| path.parent())
                .map(|dir| dir.display().to_string())
                .unwrap_or_default()
        ))
    })();
    if result.is_ok() {
        let _ = FOUND.set(());
    }
    result
}

fn build_session(path: &PathBuf) -> Result<Session, String> {
    ensure_ort_dylib()?;
    Session::builder()
        .map_err(|e| format!("ORT session builder failed: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("ORT optimization level failed: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("Failed to load ONNX model {}: {e}", path.display()))
}

/// Parse a `vocab.txt`/`tokens.txt` file: each line is "<token> <id>".
/// Returns `id2token` (indexed by id) and the id of the `<blk>` blank token.
fn parse_vocab(text: &str) -> (Vec<String>, usize) {
    let mut id2token: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            continue;
        }
        // Split on the first run of whitespace: "<tok> <id>".
        let mut parts = line.splitn(2, char::is_whitespace);
        let tok = match parts.next() {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        let id_str = match parts.next() {
            Some(s) => s.trim(),
            None => continue,
        };
        let id: usize = match id_str.trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if id >= id2token.len() {
            id2token.resize(id + 1, String::new());
        }
        id2token[id] = tok.to_string();
    }
    let blank_id = id2token
        .iter()
        .position(|t| t == "<blk>")
        .unwrap_or(1024);
    (id2token, blank_id)
}

/// Decode token ids to text using the SentencePiece rule (leading `▁` = space).
/// Mirrors ParakeetTokenizer.decode in parakeet.js.
fn decode_tokens(ids: &[usize], id2token: &[String], blank_id: usize) -> String {
    let mut text = String::new();
    for &id in ids {
        if id == blank_id {
            continue;
        }
        if let Some(tok) = id2token.get(id) {
            // U+2581 (▁) marks a leading space in SentencePiece.
            text.push_str(&tok.replace('\u{2581}', " "));
        }
    }
    // Trim leading whitespace, drop spaces before punctuation, collapse runs.
    let text = text.trim_start();
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space {
            // Drop the space if the next char is punctuation (non-word, non-space),
            // matching the JS `\s+(?=[^\w\s])` rule.
            let is_word = ch.is_alphanumeric() || ch == '_';
            if is_word && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

/// Decode a mono s16le WAV (as produced by the renderer's pcmToWavBytes) into
/// float PCM in [-1, 1] plus its sample rate. Also tolerates extra header chunks
/// by scanning for the `data` sub-chunk.
pub(crate) fn wav_to_f32(wav: &[u8]) -> Result<(Vec<f32>, usize), String> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("Not a valid WAV file".to_string());
    }
    let sample_rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]) as usize;

    // Locate the `data` chunk (usually right after the 16-byte fmt chunk at 36).
    let mut pos = 12usize;
    let mut data_start = 44usize;
    let mut data_len = wav.len().saturating_sub(44);
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size = u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]) as usize;
        let body = pos + 8;
        if id == b"data" {
            data_start = body;
            data_len = size.min(wav.len().saturating_sub(body));
            break;
        }
        // Chunks are word-aligned (padded to even length).
        pos = body + size + (size & 1);
    }

    let pcm = &wav[data_start..data_start + data_len];
    let n = pcm.len() / 2;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let s = i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]);
        out.push(s as f32 / 32768.0);
    }
    let rate = if sample_rate == 0 { TARGET_SAMPLE_RATE } else { sample_rate };
    Ok((out, rate))
}

/// Linear-interpolation resample to 16 kHz. Mirrors resampleTo16k in parakeet-local.ts.
pub(crate) fn resample_to_16k(input: &[f32], src_rate: usize) -> Vec<f32> {
    if src_rate == TARGET_SAMPLE_RATE || input.is_empty() {
        return input.to_vec();
    }
    let ratio = src_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let out_len = ((input.len() as f64 / ratio).round() as usize).max(1);
    let mut out = vec![0.0f32; out_len];
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let i0 = src_pos.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let frac = (src_pos - i0 as f64) as f32;
        out[i] = input[i0] * (1.0 - frac) + input[i1] * frac;
    }
    out
}

/// Trim leading/trailing near-silence (mono 16 kHz). Mirrors trimSilence in
/// parakeet-local.ts — a peak-relative RMS gate over 20 ms frames.
fn trim_silence(pcm: &[f32], sample_rate: usize) -> &[f32] {
    if pcm.is_empty() {
        return pcm;
    }
    let frame = ((sample_rate as f64 * 0.02).round() as usize).max(1);
    let frame_count = pcm.len().div_ceil(frame);
    let mut rms = vec![0.0f32; frame_count];
    let mut peak = 0.0f32;
    for f in 0..frame_count {
        let start = f * frame;
        let end = pcm.len().min(start + frame);
        let mut sum = 0.0f32;
        for &s in &pcm[start..end] {
            sum += s * s;
        }
        let r = (sum / (end - start).max(1) as f32).sqrt();
        rms[f] = r;
        if r > peak {
            peak = r;
        }
    }
    let gate = f32::max(0.0075, peak * 0.15);
    let mut first_f = 0usize;
    while first_f < frame_count && rms[first_f] < gate {
        first_f += 1;
    }
    if first_f >= frame_count {
        return &[];
    }
    let mut last_f = frame_count - 1;
    while last_f > first_f && rms[last_f] < gate {
        last_f -= 1;
    }
    if first_f >= last_f {
        return &[];
    }
    let margin_f = ((sample_rate as f64 * 0.08) / frame as f64).round() as usize;
    let start_f = first_f.saturating_sub(margin_f);
    let end_f = (last_f + margin_f).min(frame_count - 1);
    let start = start_f * frame;
    let end = pcm.len().min((end_f + 1) * frame);
    &pcm[start..end]
}

/// Split PCM into windows no longer than MAX_WINDOW_SECONDS, cutting at
/// low-energy points. Mirrors splitForInference in parakeet-local.ts.
fn split_for_inference(pcm: &[f32], sample_rate: usize) -> Vec<&[f32]> {
    let max_len = (sample_rate * MAX_WINDOW_SECONDS).max(1);
    if pcm.len() <= max_len {
        return vec![pcm];
    }
    let frame = ((sample_rate as f64 * 0.02).round() as usize).max(1);
    let search_len = sample_rate * CUT_SEARCH_SECONDS;
    let mut windows = Vec::new();
    let mut start = 0usize;
    while start < pcm.len() {
        if pcm.len() - start <= max_len {
            windows.push(&pcm[start..]);
            break;
        }
        let hard_end = start + max_len;
        let search_start = (start + frame).max(hard_end - search_len);
        let mut best_cut = hard_end;
        let mut best_energy = f32::INFINITY;
        let mut f = search_start;
        while f + frame <= hard_end {
            let mut sum = 0.0f32;
            for &s in &pcm[f..f + frame] {
                sum += s * s;
            }
            if sum < best_energy {
                best_energy = sum;
                best_cut = f;
            }
            f += frame;
        }
        if best_cut <= start {
            best_cut = hard_end;
        }
        windows.push(&pcm[start..best_cut]);
        start = best_cut;
    }
    windows
}

fn argmax(slice: &[f32]) -> (usize, f32) {
    let mut max_id = 0usize;
    let mut max_val = f32::NEG_INFINITY;
    for (i, &v) in slice.iter().enumerate() {
        if v > max_val {
            max_val = v;
            max_id = i;
        }
    }
    (max_id, max_val)
}

/// Collapse runaway repetition in a transcript. Mirrors collapseRepetitions in
/// parakeet-local.ts — the greedy TDT decoder can loop a word/phrase on silence.
fn collapse_repetitions(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let mut words: Vec<String> = text.split_whitespace().map(|s| s.to_string()).collect();
    if words.len() < 4 {
        return text.to_string();
    }
    let window_equal = |words: &[String], a: usize, b: usize, w: usize| -> bool {
        for k in 0..w {
            if words[a + k].to_lowercase() != words[b + k].to_lowercase() {
                return false;
            }
        }
        true
    };
    for w in 1..=6usize {
        let min_repeats = if w == 1 { 5 } else { 3 };
        let mut out: Vec<String> = Vec::new();
        let mut i = 0usize;
        while i < words.len() {
            let mut repeats = 1usize;
            while i + (repeats + 1) * w <= words.len() && window_equal(&words, i, i + repeats * w, w) {
                repeats += 1;
            }
            if repeats >= min_repeats {
                for k in 0..w {
                    out.push(words[i + k].clone());
                }
                i += repeats * w;
            } else {
                out.push(words[i].clone());
                i += 1;
            }
        }
        words = out;
    }
    words.join(" ")
}

/// Run the preprocessor -> encoder -> greedy TDT decode over one PCM window and
/// return decoded token ids.
fn transcribe_window(sessions: &mut ParakeetSessions, pcm: &[f32]) -> Result<Vec<usize>, String> {
    // --- 1. Preprocess: raw PCM -> log-mel features [1, mel, T] ------------
    let wav_len = pcm.len();
    let waveforms = Tensor::from_array(([1usize, wav_len], pcm.to_vec()))
        .map_err(|e| format!("waveforms tensor: {e}"))?;
    let waveforms_lens = Tensor::from_array(([1usize], vec![wav_len as i64]))
        .map_err(|e| format!("waveforms_lens tensor: {e}"))?;

    let pre_out = sessions
        .preprocessor
        .run(ort::inputs![
            "waveforms" => waveforms,
            "waveforms_lens" => waveforms_lens,
        ])
        .map_err(|e| format!("preprocessor run: {e}"))?;

    let (feat_shape, feat_data) = pre_out["features"]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("extract features: {e}"))?;
    let mel_bins = feat_shape[1] as usize;
    let n_frames = feat_shape[2] as usize;
    let valid_length = {
        let (_, lens) = pre_out["features_lens"]
            .try_extract_tensor::<i64>()
            .map_err(|e| format!("extract features_lens: {e}"))?;
        lens.first().copied().unwrap_or(n_frames as i64)
    };
    if feat_data.is_empty() || n_frames == 0 || mel_bins == 0 {
        return Ok(Vec::new());
    }
    let features: Vec<f32> = feat_data.to_vec();

    // --- 2. Encode: features -> encoder outputs [1, D, Tenc] ---------------
    let audio_signal = Tensor::from_array(([1usize, mel_bins, n_frames], features))
        .map_err(|e| format!("audio_signal tensor: {e}"))?;
    let length = Tensor::from_array(([1usize], vec![valid_length]))
        .map_err(|e| format!("length tensor: {e}"))?;

    let enc_out = sessions
        .encoder
        .run(ort::inputs![
            "audio_signal" => audio_signal,
            "length" => length,
        ])
        .map_err(|e| format!("encoder run: {e}"))?;

    let (enc_shape, enc_data) = enc_out["outputs"]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("extract encoder outputs: {e}"))?;
    let d = enc_shape[1] as usize;
    let t_enc = enc_shape[2] as usize;

    // Transpose [1, D, T] -> [T, D] (row-major).
    let mut transposed = vec![0.0f32; t_enc * d];
    for t in 0..t_enc {
        for k in 0..d {
            transposed[t * d + k] = enc_data[k * t_enc + t];
        }
    }
    drop(enc_out);

    // --- 3. Greedy TDT decode ---------------------------------------------
    // Token-logit count = the size of the token region of the joint output,
    // which must include the blank at `blank_id`. When vocab.txt omits an
    // explicit `<blk>` line, `blank_id` falls back to 1024 while id2token.len()
    // is only 1024 — using the raw length would slice the blank logit out of the
    // token region (into the durations), so argmax could never pick blank and the
    // decoder would emit a token every frame. Take blank_id + 1 into account.
    let blank_id = sessions.blank_id;
    let vocab = sessions.id2token.len().max(blank_id + 1);
    let state_size = PRED_LAYERS * PRED_HIDDEN; // [2,1,640]

    let mut ids: Vec<usize> = Vec::new();
    let mut state1 = vec![0.0f32; state_size];
    let mut state2 = vec![0.0f32; state_size];
    let mut emitted_tokens = 0usize;

    let mut t = 0usize;
    while t < t_enc {
        let frame = &transposed[t * d..(t + 1) * d];
        let prev_tok = ids.last().copied().unwrap_or(blank_id);

        let enc_frame = Tensor::from_array(([1usize, d, 1usize], frame.to_vec()))
            .map_err(|e| format!("enc_frame tensor: {e}"))?;
        let targets = Tensor::from_array(([1usize, 1usize], vec![prev_tok as i32]))
            .map_err(|e| format!("targets tensor: {e}"))?;
        let target_length = Tensor::from_array(([1usize], vec![1i32]))
            .map_err(|e| format!("target_length tensor: {e}"))?;
        let in_state1 = Tensor::from_array(([PRED_LAYERS, 1usize, PRED_HIDDEN], state1.clone()))
            .map_err(|e| format!("input_states_1 tensor: {e}"))?;
        let in_state2 = Tensor::from_array(([PRED_LAYERS, 1usize, PRED_HIDDEN], state2.clone()))
            .map_err(|e| format!("input_states_2 tensor: {e}"))?;

        let dec_out = sessions
            .decoder
            .run(ort::inputs![
                "encoder_outputs" => enc_frame,
                "targets" => targets,
                "target_length" => target_length,
                "input_states_1" => in_state1,
                "input_states_2" => in_state2,
            ])
            .map_err(|e| format!("decoder run: {e}"))?;

        let (_, logits) = dec_out["outputs"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("extract decoder outputs: {e}"))?;
        if logits.len() < vocab {
            return Err(format!(
                "decoder output too small ({}) for vocab {}",
                logits.len(),
                vocab
            ));
        }
        let token_logits = &logits[0..vocab];
        let dur_logits = &logits[vocab..];

        let (max_id, _) = argmax(token_logits);
        let step = if dur_logits.is_empty() {
            0usize
        } else {
            argmax(dur_logits).0
        };

        if max_id != blank_id {
            // Non-blank: adopt the new decoder state and emit the token.
            let (ns1, ns2) = {
                let s1 = dec_out["output_states_1"]
                    .try_extract_tensor::<f32>()
                    .map(|(_, d)| d.to_vec())
                    .unwrap_or_else(|_| state1.clone());
                let s2 = dec_out["output_states_2"]
                    .try_extract_tensor::<f32>()
                    .map(|(_, d)| d.to_vec())
                    .unwrap_or_else(|_| state2.clone());
                (s1, s2)
            };
            state1 = ns1;
            state2 = ns2;
            ids.push(max_id);
            emitted_tokens += 1;
        }
        drop(dec_out);

        // Frame advancement (matches onnx-asr / parakeet.js exactly).
        if step > 0 {
            t += step;
            emitted_tokens = 0;
        } else if max_id == blank_id || emitted_tokens >= MAX_TOKENS_PER_STEP {
            t += 1;
            emitted_tokens = 0;
        }
        // else: stay on the same frame to emit another token.
    }

    Ok(ids)
}

/// Transcribe s16le WAV bytes with the native Parakeet pipeline.
pub fn transcribe_wav(
    wav_bytes: &[u8],
    encoder_path: PathBuf,
    decoder_path: PathBuf,
    preprocessor_path: PathBuf,
    vocab_path: PathBuf,
) -> Result<String, String> {
    let (pcm, rate) = wav_to_f32(wav_bytes)?;
    let pcm16k = resample_to_16k(&pcm, rate);
    let trimmed = trim_silence(&pcm16k, TARGET_SAMPLE_RATE);
    if trimmed.len() < MIN_VOICED_SAMPLES {
        return Ok(String::new());
    }

    let mut guard = SESSIONS
        .lock()
        .map_err(|_| "Parakeet session lock poisoned".to_string())?;
    if guard.is_none() {
        let vocab_text =
            std::fs::read_to_string(&vocab_path).map_err(|e| format!("read vocab: {e}"))?;
        let (id2token, blank_id) = parse_vocab(&vocab_text);
        *guard = Some(ParakeetSessions {
            preprocessor: build_session(&preprocessor_path)?,
            encoder: build_session(&encoder_path)?,
            decoder: build_session(&decoder_path)?,
            id2token,
            blank_id,
        });
    }
    let sessions = guard.as_mut().unwrap();

    let mut parts: Vec<String> = Vec::new();
    for window in split_for_inference(trimmed, TARGET_SAMPLE_RATE) {
        if window.len() < MIN_VOICED_SAMPLES {
            continue;
        }
        let ids = transcribe_window(sessions, window)?;
        let text = decode_tokens(&ids, &sessions.id2token, sessions.blank_id);
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }

    Ok(collapse_repetitions(&parts.join(" ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The library name must match what the platform's loader expects, and it
    /// is also the name told to the user in the "not installed" error — a wrong
    /// one sends them looking for a file that does not exist.
    #[test]
    fn the_dylib_name_matches_the_platform() {
        #[cfg(windows)]
        assert_eq!(ORT_DYLIB_NAME, "onnxruntime.dll");
        #[cfg(target_os = "macos")]
        assert_eq!(ORT_DYLIB_NAME, "libonnxruntime.dylib");
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(ORT_DYLIB_NAME, "libonnxruntime.so");
    }

    /// Absent ONNX Runtime must be an ordinary error, never a panic.
    ///
    /// This is the whole point of `ensure_ort_dylib`: ort rc.12's lazy setup
    /// ends in `.expect("Failed to load ONNX Runtime dylib")`, so any code path
    /// that reaches an ort API without the library takes the process down. On a
    /// machine that has ONNX Runtime installed this passes trivially (Ok); on
    /// one that doesn't it proves the failure is a message, not a crash.
    #[test]
    fn a_missing_runtime_is_reported_rather_than_panicking() {
        match ensure_ort_dylib() {
            Ok(()) => {}
            Err(message) => {
                assert!(message.contains(ORT_DYLIB_NAME), "{message}");
                assert!(message.contains("ORT_DYLIB_PATH"), "{message}");
            }
        }
    }

    #[test]
    fn parse_vocab_finds_blank() {
        let (id2token, blank) = parse_vocab("a 0\nb 1\n<blk> 2\n");
        assert_eq!(id2token, vec!["a", "b", "<blk>"]);
        assert_eq!(blank, 2);
    }

    #[test]
    fn decode_tokens_sentencepiece() {
        // ▁ marks a leading space; blanks are skipped.
        let vocab: Vec<String> = vec![
            "\u{2581}hello".into(),
            "\u{2581}world".into(),
            "<blk>".into(),
            "'s".into(),
        ];
        let out = decode_tokens(&[0, 1, 2, 3], &vocab, 2);
        assert_eq!(out, "hello world's");
    }

    #[test]
    fn collapse_repetitions_trims_runs() {
        let out = collapse_repetitions("go to the store go to the store go to the store go");
        assert_eq!(out, "go to the store go");
    }

    #[test]
    fn resample_identity_when_already_16k() {
        let s = vec![0.1f32, 0.2, 0.3];
        assert_eq!(resample_to_16k(&s, 16_000), s);
    }

    #[test]
    fn wav_roundtrip_reads_rate() {
        // Minimal 16 kHz mono s16le WAV with two samples.
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + 4).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(&16_384i16.to_le_bytes()); // 0.5
        wav.extend_from_slice(&(-16_384i16).to_le_bytes()); // -0.5
        let (pcm, rate) = wav_to_f32(&wav).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(pcm.len(), 2);
        assert!((pcm[0] - 0.5).abs() < 1e-3);
        assert!((pcm[1] + 0.5).abs() < 1e-3);
    }
}
