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

/// Beam width. whisper.cpp's own default, and the single biggest accuracy lever
/// available here: greedy decoding commits to the first plausible token, which
/// is exactly how proper nouns, library names and API terms come out as the
/// nearest common word. Beam search costs roughly twice the CPU time, which on
/// a dictation-length utterance is tens of milliseconds.
const BEAM_SIZE: i32 = 5;

/// Ceiling on the initial-prompt hint. Whisper's prompt shares a 448-token
/// context with the decode itself and the reference implementation allows half
/// of it, so ~224 tokens; at roughly four characters per token that is 880.
const MAX_INITIAL_PROMPT_CHARS: usize = 880;

/// Amplitude below which a sample counts as silence when trimming the edges.
const SILENCE_PEAK: f32 = 0.01;

/// Keep this much silence around the speech. Whisper is trained on 30-second
/// windows and needs a little air at the edges; cutting flush to the first
/// sample clips onsets and costs the first phoneme.
const SILENCE_PAD_SAMPLES: usize = TARGET_SAMPLE_RATE / 10;

/// Phrases Whisper emits when it is handed audio with no speech in it.
///
/// These come from the subtitle corpora in its training data, and they are the
/// single most visible failure of a local dictation setup: a stray keyboard
/// click ends an utterance, the near-silent buffer goes to the model, and the
/// user's document receives "Thank you." out of nowhere. Compared
/// lowercase, punctuation stripped, and only when they are the ENTIRE output —
/// somebody dictating an actual "thank you" into a message must still get it.
const HALLUCINATED_ON_SILENCE: &[&str] = &[
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "thanks for watching!",
    "you",
    "bye",
    "bye bye",
    "please subscribe",
    "subscribe to my channel",
    "like and subscribe",
    "the end",
    "silence",
    "music",
    "applause",
    "blank audio",
    "outro music",
    "background music",
    "transcription by castingwords",
    "subtitles by the amara.org community",
    "subs by www.zeoranger.co.uk",
];

/// Is `text` nothing but one of Whisper's silence hallucinations?
fn is_silence_hallucination(text: &str) -> bool {
    let stripped: String = text
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '.' || *c == '\'')
        .collect();
    let normalized = stripped
        .trim()
        .trim_matches(|c: char| c == '.' || c == '!' || c == '?')
        .trim()
        .to_lowercase();
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return true;
    }
    // Bracketed stage directions - [BLANK_AUDIO], (upbeat music), *sighs* - are
    // never dictation, whatever is inside them.
    if (text.trim().starts_with('[') && text.trim().ends_with(']'))
        || (text.trim().starts_with('(') && text.trim().ends_with(')'))
        || (text.trim().starts_with('*') && text.trim().ends_with('*'))
    {
        return true;
    }
    HALLUCINATED_ON_SILENCE.contains(&normalized.as_str())
}

/// Trim leading and trailing silence, keeping a short pad.
///
/// Whisper's decoder is far more likely to invent text over a long silent tail
/// than over speech, so handing it the tightest window that still contains the
/// utterance removes the opportunity rather than filtering the result.
fn trim_silence(audio: &[f32]) -> &[f32] {
    let first = audio.iter().position(|s| s.abs() >= SILENCE_PEAK);
    let Some(first) = first else { return &[] };
    let last = audio
        .iter()
        .rposition(|s| s.abs() >= SILENCE_PEAK)
        .unwrap_or(audio.len() - 1);
    let start = first.saturating_sub(SILENCE_PAD_SAMPLES);
    let end = (last + SILENCE_PAD_SAMPLES).min(audio.len());
    &audio[start..end]
}

/// Cut a comma-separated vocabulary list to `max` characters ON A TERM
/// BOUNDARY.
///
/// A hard character truncation leaves a half-word at the end of the prompt, and
/// the model conditions on that fragment as readily as on a real term - so the
/// cap meant to protect the context window ends up biasing the decode toward a
/// word that does not exist.
fn clamp_vocabulary(list: &str, max: usize) -> String {
    if list.chars().count() <= max {
        return list.trim().to_string();
    }
    let mut out = String::new();
    for term in list.split(',') {
        let term = term.trim();
        if term.is_empty() {
            continue;
        }
        let addition = if out.is_empty() { term.chars().count() } else { term.chars().count() + 2 };
        if out.chars().count() + addition > max {
            break;
        }
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str(term);
    }
    out
}

/// Worker threads for the decode. whisper.cpp defaults to 4 regardless of the
/// machine; on a developer's laptop that leaves most of the CPU idle while the
/// user waits for their words.
fn decode_threads() -> i32 {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    // Leave a core for the UI and the audio graph, and stop scaling past 8 -
    // whisper.cpp gets very little from more than that and contention costs.
    cores.saturating_sub(1).clamp(2, 8) as i32
}

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
    let resampled = resample_to_16k(&pcm, rate);
    // Silence at the edges is where the decoder invents subtitle credits, so
    // narrow the window to the speech before it ever sees it.
    let audio = trim_silence(&resampled);
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

    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: BEAM_SIZE,
        patience: -1.0,
    });
    params.set_n_threads(decode_threads());
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // One dictated utterance is one segment; splitting it invites the decoder
    // to start a fresh "sentence" over the trailing silence.
    params.set_single_segment(true);
    params.set_no_timestamps(true);
    // Each utterance is decoded independently — carrying tokens across calls
    // lets one bad decode seed the next, which is how a single hallucination
    // turns into a run of them.
    params.set_no_context(true);
    // Anti-hallucination triad, all whisper.cpp defaults that FullParams does
    // not apply on its own:
    //   suppress_blank  — no empty/whitespace-only token at the start
    //   suppress_nst    — no non-speech tokens: [BLANK_AUDIO], (music), ♪
    //   no_speech_thold — abandon a segment the model itself scores as silence
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_no_speech_thold(0.6);
    // Start deterministic and only fall back to sampling when a decode comes
    // out degenerate (high entropy = the repetition loop). Temperature 0 keeps
    // technical terms stable across repeats of the same phrase.
    params.set_temperature(0.0);
    params.set_temperature_inc(0.2);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    // English-only models (…-en) must stay on "en"; multilingual models
    // auto-detect. The GGML filename encodes this, so key off the model path.
    if model_str.contains(".en.") || model_str.contains("-en") {
        params.set_language(Some("en"));
    } else {
        params.set_language(Some("auto"));
    }
    if let Some(prompt) = initial_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        let clamped = clamp_vocabulary(prompt, MAX_INITIAL_PROMPT_CHARS);
        if !clamped.is_empty() {
            // Presented as a sentence rather than a bare list. whisper.cpp
            // conditions on this as text that PRECEDES the audio, so prose
            // primes the decoder into the right register as well as the right
            // spellings; a naked comma list primes it to emit comma lists.
            params.set_initial_prompt(&format!("Technical dictation mentioning {clamped}."));
        }
    }

    state
        .full(params, audio)
        .map_err(|e| format!("Whisper transcription failed: {e}"))?;

    let mut text = String::new();
    for segment in state.as_iter() {
        if let Ok(s) = segment.to_str_lossy() {
            text.push_str(&s);
        }
    }
    let text = text.trim();
    // Last line of defence: the decoder still occasionally produces one of its
    // training-corpus stock phrases over audio that held no speech.
    if is_silence_hallucination(text) {
        return Ok(String::new());
    }
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_stock_silence_phrases() {
        for phrase in ["Thank you.", "thanks for watching!", "  You  ", "Bye."] {
            assert!(is_silence_hallucination(phrase), "expected {phrase:?} to be flagged");
        }
    }

    #[test]
    fn flags_bracketed_stage_directions() {
        assert!(is_silence_hallucination("[BLANK_AUDIO]"));
        assert!(is_silence_hallucination("(upbeat music)"));
        assert!(is_silence_hallucination("*sighs*"));
    }

    #[test]
    fn keeps_real_dictation_that_merely_contains_a_stock_phrase() {
        assert!(!is_silence_hallucination("Thank you for reviewing the pull request."));
        assert!(!is_silence_hallucination("You should retry the request."));
    }

    #[test]
    fn trims_silence_but_keeps_a_pad() {
        let mut audio = vec![0.0f32; TARGET_SAMPLE_RATE];
        for sample in audio.iter_mut().skip(8_000).take(1_000) {
            *sample = 0.5;
        }
        let trimmed = trim_silence(&audio);
        assert!(trimmed.len() >= 1_000);
        assert!(trimmed.len() < audio.len());
    }

    #[test]
    fn trims_pure_silence_to_nothing() {
        assert!(trim_silence(&[0.0f32; 16_000]).is_empty());
    }

    #[test]
    fn clamps_vocabulary_on_a_term_boundary() {
        let list = "createSession, resolveTargetSession, refineVoiceTranscript";
        let clamped = clamp_vocabulary(list, 30);
        assert!(clamped.chars().count() <= 30);
        // Every surviving term is whole - no half-word left to bias the decode.
        for term in clamped.split(',') {
            assert!(list.contains(term.trim()));
        }
        assert!(!clamped.ends_with(','));
    }

    #[test]
    fn leaves_a_short_vocabulary_alone() {
        assert_eq!(clamp_vocabulary("useEffect, onClick", 880), "useEffect, onClick");
    }
}
