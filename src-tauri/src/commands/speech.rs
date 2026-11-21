//! Cloud speech for Read aloud and opt-in agent completion announcements.
//! Keys stay in the backend.

use super::secrets::{media_api_key, redact_secrets, safe_request_error, shared_http_client};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const OPENAI_SPEECH_URL: &str = "https://api.openai.com/v1/audio/speech";
const OPENAI_SPEECH_MODEL: &str = "gpt-4o-mini-tts";
const ELEVENLABS_URL: &str = "https://api.elevenlabs.io/v1";
const ELEVENLABS_MODEL: &str = "eleven_multilingual_v2";
const MINIMAX_URL: &str = "https://api.minimax.io/v1";
const MINIMAX_MODEL: &str = "speech-2.8-turbo";
const OPENROUTER_SPEECH_URL: &str = "https://openrouter.ai/api/v1/audio/speech";
const XAI_TTS_URL: &str = "https://api.x.ai/v1/tts";

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

#[derive(Serialize)]
pub struct SpeechModel {
    id: String,
    name: String,
    voices: Vec<String>,
}

fn voice_id_is_safe(voice: &str) -> bool {
    !voice.is_empty() && voice.len() <= 64 && voice.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn speech_model_id_is_safe(id: &str) -> bool {
    !id.is_empty() && id.len() <= 160 && id.bytes().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'/' | b':')
    })
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
pub async fn read_aloud_speak(
    provider: String,
    model: Option<String>,
    voice: String,
    text: String,
) -> Result<SpeechAudio, String> {
    let text: String = text.trim().chars().take(MAX_SPEECH_CHARS).collect();
    if text.is_empty() {
        return Err("Nothing to read.".into());
    }
    // Only ElevenLabs interpolates the voice into a URL. MiniMax and
    // OpenRouter allow IDs containing spaces, parentheses or colons.
    if voice.trim().is_empty() || voice.len() > 256 || voice.chars().any(char::is_control)
        || (provider == "elevenlabs" && !voice_id_is_safe(&voice))
    {
        return Err("Invalid voice.".into());
    }
    let model = model.as_deref().filter(|id| !id.is_empty());
    if model.is_some_and(|id| !speech_model_id_is_safe(id)) {
        return Err("Invalid speech model.".into());
    }
    let client = shared_http_client(Duration::from_secs(60))?;
    let (vendor, request) = match provider.as_str() {
        "openai" => ("OpenAI", client
            .post(OPENAI_SPEECH_URL)
            .bearer_auth(media_api_key("openai")?)
            .json(&json!({
                "model": OPENAI_SPEECH_MODEL,
                "input": text,
                "voice": voice,
                "instructions": OPENAI_DELIVERY,
                "response_format": "mp3",
            }))),
        "elevenlabs" => ("ElevenLabs", client
            .post(format!("{ELEVENLABS_URL}/text-to-speech/{voice}?output_format=mp3_44100_128"))
            .header("xi-api-key", media_api_key("elevenlabs")?)
            .json(&json!({
                "text": text,
                "model_id": model.unwrap_or(ELEVENLABS_MODEL),
                "voice_settings": { "stability": 0.45, "similarity_boost": 0.8, "style": 0.15, "use_speaker_boost": true },
            }))),
        "minimax" => ("MiniMax", client
            .post(format!("{MINIMAX_URL}/t2a_v2"))
            .bearer_auth(media_api_key("minimax")?)
            .json(&json!({
                "model": model.unwrap_or(MINIMAX_MODEL),
                "text": text,
                "stream": false,
                "language_boost": "auto",
                "output_format": "hex",
                "voice_setting": { "voice_id": voice },
                "audio_setting": { "format": "mp3" },
            }))),
        "openrouter" => ("OpenRouter", client
            .post(OPENROUTER_SPEECH_URL)
            .bearer_auth(media_api_key("openrouter")?)
            .json(&json!({
                "model": model.ok_or("Choose an OpenRouter speech model in Settings > Voice.")?,
                "input": text,
                "voice": voice,
                "response_format": "mp3",
            }))),
        "xai" => ("xAI", client
            .post(XAI_TTS_URL)
            .bearer_auth(media_api_key("xai")?)
            .json(&json!({ "text": text, "voice_id": voice, "language": "auto" }))),
        _ => return Err("Unknown read-aloud provider.".into()),
    };
    let response = request.send().await
        .map_err(|err| safe_request_error(&format!("Could not reach {vendor}"), err))?;
    if !response.status().is_success() {
        return Err(failure(vendor, response).await);
    }
    let audio = if provider == "minimax" {
        let payload: Value = response.json().await.map_err(|_| "MiniMax returned unreadable audio.")?;
        check_minimax_status(&payload)?;
        let hex = payload["data"]["audio"].as_str().ok_or("MiniMax returned no audio.")?;
        STANDARD.encode(decode_minimax_audio(hex)?)
    } else {
        if !response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|header| header.to_str().ok())
            .is_some_and(|mime| mime.starts_with("audio/") || mime.starts_with("application/octet-stream"))
        {
            return Err(format!("{vendor} returned a response without audio."));
        }
        let bytes = response.bytes().await.map_err(|err| format!("Could not read the audio: {err}"))?;
        if bytes.is_empty() {
            return Err(format!("{vendor} returned no audio."));
        }
        STANDARD.encode(bytes)
    };
    Ok(SpeechAudio { audio, mime_type: "audio/mpeg".into() })
}

fn check_minimax_status(payload: &Value) -> Result<(), String> {
    match payload["base_resp"]["status_code"].as_i64() {
        Some(0) => Ok(()),
        Some(code) => {
            let message = payload["base_resp"]["status_msg"].as_str().unwrap_or("Request failed");
            let preview = redact_secrets(&message.chars().take(240).collect::<String>());
            Err(format!("MiniMax rejected the request ({code}): {preview}"))
        }
        None => Err("MiniMax returned an unreadable response.".into()),
    }
}

fn decode_minimax_audio(hex: &str) -> Result<Vec<u8>, String> {
    if hex.is_empty() || hex.len() % 2 != 0 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("MiniMax returned invalid MP3 data.".into());
    }
    (0..hex.len()).step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16)
            .map_err(|_| "MiniMax returned invalid MP3 data.".into()))
        .collect()
}

/// Account voices from providers with a voice list endpoint.
#[tauri::command]
pub async fn read_aloud_voices(provider: String) -> Result<Vec<SpeechVoice>, String> {
    let client = shared_http_client(Duration::from_secs(20))?;
    let (vendor, request) = match provider.as_str() {
        "elevenlabs" => ("ElevenLabs", client.get(format!("{ELEVENLABS_URL}/voices"))
            .header("xi-api-key", media_api_key("elevenlabs")?)),
        "minimax" => ("MiniMax", client.post(format!("{MINIMAX_URL}/get_voice"))
            .bearer_auth(media_api_key("minimax")?)
            .json(&json!({ "voice_type": "all" }))),
        "xai" => ("xAI", client.get(format!("{XAI_TTS_URL}/voices"))
            .bearer_auth(media_api_key("xai")?)),
        _ => return Ok(Vec::new()),
    };
    let response = request.send().await
        .map_err(|err| safe_request_error(&format!("Could not reach {vendor}"), err))?;
    if !response.status().is_success() {
        return Err(failure(vendor, response).await);
    }
    let payload: Value = response.json().await.map_err(|_| format!("{vendor} returned an unreadable voice list."))?;
    if provider == "minimax" {
        check_minimax_status(&payload)?;
        return Ok(["system_voice", "voice_cloning", "voice_generation"].iter()
            .filter_map(|field| payload[*field].as_array()).flatten()
            .filter_map(|voice| catalog_voice(voice, "voice_name"))
            .collect());
    }
    if provider == "xai" {
        return Ok(payload["voices"].as_array().into_iter().flatten()
            .filter_map(|voice| catalog_voice(voice, "name")).collect());
    }
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

fn catalog_voice(voice: &Value, name_field: &str) -> Option<SpeechVoice> {
    let id = voice["voice_id"].as_str()?.to_owned();
    let name = voice[name_field].as_str().unwrap_or(&id).to_owned();
    Some(SpeechVoice { id, name, detail: None })
}

/// OpenRouter's public catalog includes format and voice support per model.
#[tauri::command]
pub async fn read_aloud_openrouter_models() -> Result<Vec<SpeechModel>, String> {
    let client = shared_http_client(Duration::from_secs(20))?;
    let response = client.get(format!("{OPENROUTER_SPEECH_URL}/models"))
        .send().await.map_err(|err| safe_request_error("Could not reach OpenRouter", err))?;
    if !response.status().is_success() {
        return Err(failure("OpenRouter", response).await);
    }
    let payload: Value = response.json().await.map_err(|_| "OpenRouter returned an unreadable model list.")?;
    let models = payload["data"].as_array().ok_or("OpenRouter returned no speech model list.")?;
    Ok(models.iter().filter_map(openrouter_mp3_model).collect())
}

fn openrouter_mp3_model(model: &Value) -> Option<SpeechModel> {
    let id = model["id"].as_str()?;
    let speech = model["output_modalities"].as_array()?.iter().find(|entry| entry["type"] == "speech")?;
    let parameters = &speech["supported_parameters"];
    if !parameters["response_format"]["values"].as_array()?.iter().any(|format| format == "mp3") {
        return None;
    }
    let voices: Vec<String> = parameters["voice"]["values"].as_array()?.iter()
        .filter_map(Value::as_str).map(str::to_owned).collect();
    if voices.is_empty() {
        return None;
    }
    Some(SpeechModel { id: id.into(), name: model["name"].as_str().unwrap_or(id).into(), voices })
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

    #[test]
    fn minimax_mp3_is_hex_and_failed_requests_can_return_http_200() {
        assert_eq!(decode_minimax_audio("494433").unwrap(), b"ID3");
        assert!(decode_minimax_audio("0").is_err());
        assert!(decode_minimax_audio("é").is_err());
        assert!(check_minimax_status(&json!({ "base_resp": { "status_code": 0 } })).is_ok());
        assert!(check_minimax_status(&json!({ "base_resp": { "status_code": 1004 } })).is_err());
    }

    #[test]
    fn openrouter_catalog_keeps_voices_for_models_that_can_play_as_mp3() {
        let mut model = json!({
            "id": "microsoft/mai-voice-2.1",
            "name": "MAI Voice",
            "output_modalities": [{
                "type": "speech",
                "supported_parameters": {
                    "voice": { "values": ["en-US-Harper:MAI-Voice-2.1"] },
                    "response_format": { "values": ["mp3", "pcm"] }
                }
            }]
        });
        let parsed = openrouter_mp3_model(&model).unwrap();
        assert_eq!(parsed.voices, ["en-US-Harper:MAI-Voice-2.1"]);
        model["output_modalities"][0]["supported_parameters"]["response_format"]["values"] = json!(["pcm"]);
        assert!(openrouter_mp3_model(&model).is_none());
    }
}
