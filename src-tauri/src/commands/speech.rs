//! Read aloud: one chat reply spoken by a cloud voice, on request.
//!
//! This is not the reply-TTS pipeline that was deleted with realtime-only voice
//! (see .spacron/memory/voice-is-realtime-only.md): nothing here ever speaks on
//! its own. The chat's Read aloud button sends one short piece of text at a
//! time and plays what comes back. Keys are read from the OS keychain here and
//! never reach the webview.

use super::secrets::{media_api_key, redact_secrets, safe_request_error, shared_http_client};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::json;
use std::time::Duration;

const OPENAI_SPEECH_URL: &str = "https://api.openai.com/v1/audio/speech";
const OPENAI_SPEECH_MODEL: &str = "gpt-4o-mini-tts";
const ELEVENLABS_URL: &str = "https://api.elevenlabs.io/v1";
const ELEVENLABS_MODEL: &str = "eleven_multilingual_v2";

/// One request's worth of text. The frontend splits longer replies into
/// sentence-sized pieces well under this, so it is a backstop, not a limit
/// anybody should meet (OpenAI accepts 4,096 characters).
const MAX_SPEECH_CHARS: usize = 4_000;

/// Delivery the OpenAI model is asked for. `gpt-4o-mini-tts` reads free-text
/// instructions; this is what makes it sound like a person reading to you
/// rather than an announcer.
const OPENAI_DELIVERY: &str = "Read this like a friendly, articulate person explaining something to a colleague: natural pace, warm and conversational, with the small pauses and intonation of real speech. Do not sound like an announcer or read punctuation aloud.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechAudio {
    /// Base64 audio; a JSON number array would be ~4x the size over IPC.
    pub audio: String,
    pub mime_type: String,
}

#[derive(Serialize)]
pub struct SpeechVoice {
    pub id: String,
    pub name: String,
    pub detail: Option<String>,
}

fn voice_id_is_safe(voice: &str) -> bool {
    !voice.is_empty() && voice.len() <= 64 && voice.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

async fn failure(provider: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let preview = redact_secrets(&body.chars().take(240).collect::<String>());
    match status.as_u16() {
        401 | 403 => format!("{provider} rejected the key ({status}). Check it in Settings > Voice > Read aloud."),
        429 => format!("{provider} is rate limiting or out of credit ({status}): {preview}"),
        _ => format!("{provider} could not read this aloud ({status}): {preview}"),
    }
}

/// Speak `text` with `provider`'s `voice`, returning the audio to play.
#[tauri::command]
pub async fn read_aloud_speak(provider: String, voice: String, text: String) -> Result<SpeechAudio, String> {
    let text: String = text.trim().chars().take(MAX_SPEECH_CHARS).collect();
    if text.is_empty() {
        return Err("Nothing to read.".into());
    }
    if !voice_id_is_safe(&voice) {
        return Err("Invalid voice.".into());
    }
    let client = shared_http_client(Duration::from_secs(60))?;
    let (bytes, mime) = match provider.as_str() {
        "openai" => {
            let key = media_api_key("openai")?;
            let response = client
                .post(OPENAI_SPEECH_URL)
                .bearer_auth(key)
                .json(&json!({
                    "model": OPENAI_SPEECH_MODEL,
                    "input": text,
                    "voice": voice,
                    "instructions": OPENAI_DELIVERY,
                    "response_format": "mp3",
                }))
                .send()
                .await
                .map_err(|err| safe_request_error("Could not reach OpenAI", err))?;
            if !response.status().is_success() {
                return Err(failure("OpenAI", response).await);
            }
            (response.bytes().await.map_err(|err| format!("Could not read the audio: {err}"))?, "audio/mpeg")
        }
        "elevenlabs" => {
            let key = media_api_key("elevenlabs")?;
            let response = client
                .post(format!("{ELEVENLABS_URL}/text-to-speech/{voice}?output_format=mp3_44100_128"))
                .header("xi-api-key", key)
                .json(&json!({
                    "text": text,
                    "model_id": ELEVENLABS_MODEL,
                    "voice_settings": { "stability": 0.45, "similarity_boost": 0.8, "style": 0.15, "use_speaker_boost": true },
                }))
                .send()
                .await
                .map_err(|err| safe_request_error("Could not reach ElevenLabs", err))?;
            if !response.status().is_success() {
                return Err(failure("ElevenLabs", response).await);
            }
            (response.bytes().await.map_err(|err| format!("Could not read the audio: {err}"))?, "audio/mpeg")
        }
        other => return Err(format!("{other} does not offer read-aloud voices.")),
    };
    Ok(SpeechAudio { audio: STANDARD.encode(&bytes), mime_type: mime.into() })
}

/// The voices the account behind `provider`'s key can use (ElevenLabs lists
/// the user's own and library voices; OpenAI's are a fixed set the UI knows).
#[tauri::command]
pub async fn read_aloud_voices(provider: String) -> Result<Vec<SpeechVoice>, String> {
    if provider != "elevenlabs" {
        return Ok(Vec::new());
    }
    let key = media_api_key("elevenlabs")?;
    let client = shared_http_client(Duration::from_secs(20))?;
    let response = client
        .get(format!("{ELEVENLABS_URL}/voices"))
        .header("xi-api-key", key)
        .send()
        .await
        .map_err(|err| safe_request_error("Could not reach ElevenLabs", err))?;
    if !response.status().is_success() {
        return Err(failure("ElevenLabs", response).await);
    }
    let payload: serde_json::Value = response.json().await.map_err(|err| format!("ElevenLabs returned an unreadable voice list: {err}"))?;
    let voices = payload
        .get("voices")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|voice| {
                    let id = voice.get("voice_id")?.as_str()?.to_string();
                    if !voice_id_is_safe(&id) {
                        return None;
                    }
                    let name = voice.get("name").and_then(|n| n.as_str()).unwrap_or(&id).to_string();
                    let labels = voice.get("labels");
                    let detail = ["accent", "gender", "description"]
                        .iter()
                        .filter_map(|field| labels.and_then(|l| l.get(*field)).and_then(|v| v.as_str()))
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                        .join(", ");
                    Some(SpeechVoice { id, name, detail: (!detail.is_empty()).then_some(detail) })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(voices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_ids_are_path_safe() {
        assert!(voice_id_is_safe("21m00Tcm4TlvDq8ikWAM"));
        assert!(voice_id_is_safe("marin"));
        assert!(!voice_id_is_safe("../voices"));
        assert!(!voice_id_is_safe("a?b=c"));
        assert!(!voice_id_is_safe(""));
    }
}
