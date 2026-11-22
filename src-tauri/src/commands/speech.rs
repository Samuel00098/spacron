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
const FISH_URL: &str = "https://api.fish.audio";
/// Fish Audio's default engine when no `model` header is sent.
const FISH_MODEL: &str = "s2.1-pro";
/// Fish Audio picks its engine with a `model` header and publishes no engine
/// catalogue, so this documented list is returned once the key is verified.
const FISH_MODELS: &[(&str, &str)] = &[
    ("s2.1-pro", "S2.1 Pro"),
    ("s2-pro", "S2 Pro"),
    ("drama-3", "Drama 3 (expressive)"),
    ("s1", "S1"),
    ("s2.1-pro-free", "S2.1 Pro (free tier)"),
];

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
        "groq" => ("Groq", client
            .post("https://api.groq.com/openai/v1/audio/speech")
            .bearer_auth(media_api_key("groq")?)
            .json(&json!({ "model": model.unwrap_or("canopylabs/orpheus-v1-english"), "input": text, "voice": voice, "response_format": "wav" }))),
        "google" => {
            let selected = model.unwrap_or("gemini-3.8-flash-tts");
            if selected.starts_with("gemini-3.8-") {
                ("Gemini", client.post("https://generativelanguage.googleapis.com/v1beta/interactions")
                    .header("x-goog-api-key", media_api_key("google")?)
                    .json(&json!({ "model": selected,
                        "input": [{ "type": "user_input", "content": [{ "type": "text", "text": text }] }],
                        "response_format": { "type": "audio" },
                        "generation_config": { "speech_config": [{ "voice": voice }] }
                    })))
            } else {
                ("Gemini", client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{selected}:generateContent"))
                    .header("x-goog-api-key", media_api_key("google")?)
                    .json(&json!({
                        "contents": [{ "parts": [{ "text": text }] }],
                        "generationConfig": { "responseModalities": ["AUDIO"],
                            "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } }
                        }
                    })))
            }
        },
        "openai" => {
            let selected = model.unwrap_or(OPENAI_SPEECH_MODEL);
            let mut body = json!({ "model": selected, "input": text, "voice": voice, "response_format": "mp3" });
            if selected.starts_with("gpt-4o-mini-tts") { body["instructions"] = json!(OPENAI_DELIVERY); }
            ("OpenAI", client
            .post(OPENAI_SPEECH_URL)
            .bearer_auth(media_api_key("openai")?)
            .json(&body))
        },
        "elevenlabs" => {
            let model = model.unwrap_or(ELEVENLABS_MODEL);
            let mut body = json!({
                "text": text,
                "model_id": model,
            });
            if matches!(model, ELEVENLABS_MODEL | "eleven_flash_v2_5" | "eleven_turbo_v2_5") {
                body["voice_settings"] = json!({
                    "stability": 0.45, "similarity_boost": 0.8, "style": 0.15, "use_speaker_boost": true
                });
            }
            ("ElevenLabs", client
                .post(format!("{ELEVENLABS_URL}/text-to-speech/{voice}?output_format=mp3_44100_128"))
                .header("xi-api-key", media_api_key("elevenlabs")?)
                .json(&body))
        }
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
        "fish" => {
            let mut body = json!({ "text": text, "format": "mp3", "normalize": true });
            // "default" means no voice model: Fish then reads in its own voice.
            if voice != "default" {
                body["reference_id"] = json!(voice);
            }
            ("Fish Audio", client
                .post(format!("{FISH_URL}/v1/tts"))
                .bearer_auth(media_api_key("fish")?)
                .header("model", model.unwrap_or(FISH_MODEL))
                .json(&body))
        }
        _ => return Err("Unknown read-aloud provider.".into()),
    };
    let response = request.send().await
        .map_err(|err| safe_request_error(&format!("Could not reach {vendor}"), err))?;
    if !response.status().is_success() {
        return Err(failure(vendor, response).await);
    }
    let audio = if provider == "google" {
        let payload: Value = response.json().await.map_err(|_| "Gemini returned unreadable audio.")?;
        gemini_speech_audio(&payload)?
    } else if provider == "minimax" {
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
    Ok(SpeechAudio { audio, mime_type: if provider == "groq" || provider == "google" { "audio/wav" } else { "audio/mpeg" }.into() })
}

fn gemini_speech_audio(payload: &Value) -> Result<String, String> {
    if let Some(parts) = payload["candidates"][0]["content"]["parts"].as_array() {
        let audio = parts.iter().find_map(|part| part.get("inlineData")).ok_or("Gemini returned no audio.")?;
        let bytes = STANDARD.decode(audio["data"].as_str().ok_or("Gemini returned no audio data.")?)
            .map_err(|_| "Gemini returned invalid audio.")?;
        if bytes.is_empty() { return Err("Gemini returned empty audio.".into()); }
        if bytes.starts_with(b"RIFF") { return Ok(STANDARD.encode(bytes)); }
        let mime = audio["mimeType"].as_str().unwrap_or_default();
        if !mime.starts_with("audio/L16") && !mime.starts_with("audio/pcm") { return Err("Gemini returned unsupported audio.".into()); }
        let rate = mime.split(';').find_map(|part| part.trim().strip_prefix("rate=").and_then(|rate| rate.parse::<u32>().ok())).unwrap_or(24000);
        if !(8000..=96000).contains(&rate) { return Err("Gemini returned an invalid sample rate.".into()); }
        let size = u32::try_from(bytes.len()).map_err(|_| "Gemini audio is too large.")?;
        let mut wav = Vec::with_capacity(bytes.len() + 44);
        wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(size + 36).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt "); wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes()); wav.extend_from_slice(&(rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes()); wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data"); wav.extend_from_slice(&size.to_le_bytes()); wav.extend_from_slice(&bytes);
        return Ok(STANDARD.encode(wav));
    }

    let audio = payload["steps"].as_array().into_iter().flatten()
        .filter(|step| step["type"] == "model_output")
        .flat_map(|step| step["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "audio")
        .last().ok_or("Gemini returned no audio.")?;
    let data = audio["data"].as_str().filter(|value| !value.is_empty()).ok_or("Gemini returned empty audio.")?;
    let bytes = STANDARD.decode(data).map_err(|_| "Gemini returned invalid audio.")?;
    if !bytes.starts_with(b"RIFF") || bytes.get(8..12) != Some(b"WAVE".as_slice()) {
        return Err("Gemini returned an unsupported audio format; expected WAV.".into());
    }
    Ok(data.to_owned())
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
    if provider == "fish" {
        return fish_voices(&client).await;
    }
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

/// Fish Audio calls voices "models": the account's own first, then popular
/// public ones, so a new account still has something to pick.
async fn fish_voices(client: &reqwest::Client) -> Result<Vec<SpeechVoice>, String> {
    let key = media_api_key("fish")?;
    let mut voices = vec![SpeechVoice { id: "default".into(), name: "Fish default voice".into(), detail: None }];
    for (query, detail) in [("page_size=50&self=true", "your voice"), ("page_size=40&sort_by=task_count", "popular")] {
        let response = client
            .get(format!("{FISH_URL}/model?{query}"))
            .bearer_auth(&key)
            .send()
            .await
            .map_err(|err| safe_request_error("Could not reach Fish Audio", err))?;
        if !response.status().is_success() {
            return Err(failure("Fish Audio", response).await);
        }
        let payload: Value = response.json().await.map_err(|_| "Fish Audio returned an unreadable voice list.")?;
        for voice in fish_catalog_voices(&payload, detail) {
            if !voices.iter().any(|v| v.id == voice.id) {
                voices.push(voice);
            }
        }
    }
    Ok(voices)
}

fn fish_catalog_voices(payload: &Value, detail: &str) -> Vec<SpeechVoice> {
    payload["items"].as_array().into_iter().flatten().filter_map(|item| {
        let id = item["_id"].as_str()?.to_owned();
        if !voice_id_is_safe(&id) {
            return None;
        }
        let name = item["title"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or(&id).to_owned();
        Some(SpeechVoice { id, name, detail: Some(detail.to_owned()) })
    }).collect()
}

/// List Fish Audio's engines, each carrying the voices it can read with, so the
/// Voice list follows the chosen model. Fetching the voices also verifies the
/// key. Fish documents no per-engine voice restriction, so every engine gets the
/// account's voices plus the popular public ones.
async fn fish_speech_models(client: &reqwest::Client) -> Result<Vec<SpeechModel>, String> {
    let voices: Vec<String> = fish_voices(client).await?.into_iter().map(|v| v.id).collect();
    Ok(FISH_MODELS.iter().map(|(id, name)| SpeechModel { id: (*id).into(), name: (*name).into(), voices: voices.clone() }).collect())
}

fn catalog_voice(voice: &Value, name_field: &str) -> Option<SpeechVoice> {
    let id = voice["voice_id"].as_str()?.to_owned();
    let name = voice[name_field].as_str().unwrap_or(&id).to_owned();
    Some(SpeechVoice { id, name, detail: None })
}

/// Discover text-to-speech models using the provider's stored credential.
#[tauri::command]
pub async fn read_aloud_provider_models(provider: String) -> Result<Vec<SpeechModel>, String> {
    let client = shared_http_client(Duration::from_secs(20))?;
    let (vendor, request) = match provider.as_str() {
        "openai" => ("OpenAI", client.get("https://api.openai.com/v1/models")
            .bearer_auth(media_api_key("openai")?)),
        "groq" => ("Groq", client.get("https://api.groq.com/openai/v1/models")
            .bearer_auth(media_api_key("groq")?)),
        "google" => return google_speech_models(&client).await,
        "fish" => return fish_speech_models(&client).await,
        "elevenlabs" => ("ElevenLabs", client.get(format!("{ELEVENLABS_URL}/models"))
            .header("xi-api-key", media_api_key("elevenlabs")?)),
        "minimax" => ("MiniMax", client.get(format!("{MINIMAX_URL}/models"))
            .bearer_auth(media_api_key("minimax")?)),
        _ => return Err("Unsupported speech model catalog.".into()),
    };
    let payload: Value = request
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|err| safe_request_error(&format!("Could not load {vendor} speech models"), err))?
        .json()
        .await
        .map_err(|_| format!("{vendor} returned an unreadable model list."))?;
    if provider == "openai" || provider == "groq" {
        let models = payload["data"].as_array().ok_or("Provider returned no model list.")?;
        return Ok(models.iter().filter_map(|model| named_speech_model(&provider, model)).collect());
    }
    if provider == "minimax" {
        let models = payload["data"].as_array().ok_or("MiniMax returned no model list.")?;
        return Ok(models.iter().filter_map(minimax_speech_model).collect());
    }
    let models = payload.as_array().ok_or("ElevenLabs returned no model list.")?;
    Ok(models.iter().filter_map(elevenlabs_speech_model).collect())
}

fn named_speech_model(provider: &str, model: &Value) -> Option<SpeechModel> {
    let id = model["id"].as_str().or_else(|| model["name"].as_str())?.trim_start_matches("models/");
    let supported = match provider {
        "openai" => id.starts_with("tts-1") || id.starts_with("gpt-4o-mini-tts"),
        "groq" => id.starts_with("canopylabs/orpheus-"),
        "google" => id.starts_with("gemini-") && id.contains("tts"),
        _ => false,
    };
    if !supported || !speech_model_id_is_safe(id) { return None; }
    Some(SpeechModel { id: id.into(), name: model["displayName"].as_str().unwrap_or(id).into(), voices: Vec::new() })
}

async fn google_speech_models(client: &reqwest::Client) -> Result<Vec<SpeechModel>, String> {
    let key = media_api_key("google")?;
    let mut token = String::new();
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    loop {
        let mut request = client.get("https://generativelanguage.googleapis.com/v1beta/models")
            .header("x-goog-api-key", &key).query(&[("pageSize", "1000")]);
        if !token.is_empty() { request = request.query(&[("pageToken", &token)]); }
        let response = request.send().await.map_err(|err| safe_request_error("Could not load Gemini speech models", err))?;
        if !response.status().is_success() { return Err(failure("Gemini", response).await); }
        let payload: Value = response.json().await.map_err(|_| "Gemini returned an unreadable model list.")?;
        let page = payload["models"].as_array().ok_or("Gemini returned no model list.")?;
        models.extend(page.iter().filter_map(|model| named_speech_model("google", model)));
        token = payload["nextPageToken"].as_str().unwrap_or_default().to_owned();
        if token.is_empty() { break; }
        if !seen.insert(token.clone()) { return Err("Gemini repeated a model-list page token.".into()); }
    }
    Ok(models)
}

fn minimax_speech_model(model: &Value) -> Option<SpeechModel> {
    let id = model["id"].as_str()?;
    if !id.starts_with("speech-") || !speech_model_id_is_safe(id) {
        return None;
    }
    Some(SpeechModel { id: id.into(), name: id.into(), voices: Vec::new() })
}

fn elevenlabs_speech_model(model: &Value) -> Option<SpeechModel> {
    let id = model["model_id"].as_str()?;
    if model["can_do_text_to_speech"].as_bool() != Some(true) || !speech_model_id_is_safe(id) {
        return None;
    }
    Some(SpeechModel {
        id: id.into(),
        name: model["name"].as_str().unwrap_or(id).into(),
        voices: Vec::new(),
    })
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
    fn discovered_speech_models_exclude_chat_and_transcription() {
        assert!(named_speech_model("openai", &json!({"id": "tts-1-hd"})).is_some());
        assert!(named_speech_model("openai", &json!({"id": "whisper-1"})).is_none());
        assert!(named_speech_model("groq", &json!({"id": "canopylabs/orpheus-arabic-saudi"})).is_some());
        assert!(named_speech_model("groq", &json!({"id": "llama-3.3-70b-versatile"})).is_none());
        let google = named_speech_model("google", &json!({"name": "models/gemini-2.5-flash-preview-tts"})).unwrap();
        assert_eq!(google.id, "gemini-2.5-flash-preview-tts");
        assert!(named_speech_model("google", &json!({"name": "models/gemini-2.5-flash"})).is_none());
    }

    #[test]
    fn legacy_gemini_audio_gets_a_playable_wav_header() {
        let pcm = STANDARD.encode([0u8, 1, 2, 3]);
        let audio = gemini_speech_audio(&json!({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "audio/L16;codec=pcm;rate=24000", "data": pcm}}]}}]})).unwrap();
        let wav = STANDARD.decode(audio).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[44..], &[0, 1, 2, 3]);
    }

    #[test]
    fn gemini_audio_requires_a_wav_model_output() {
        let wav = STANDARD.encode(b"RIFF0000WAVEdata");
        let payload = json!({"steps": [{"type": "model_output", "content": [{"type": "audio", "data": wav}]}]});
        assert_eq!(gemini_speech_audio(&payload).unwrap(), wav);
        assert!(gemini_speech_audio(&json!({"steps": []})).is_err());
        assert!(gemini_speech_audio(&json!({"steps": [{"type": "model_output", "content": [{"type": "audio", "data": "bad"}]}]})).is_err());
    }


    #[test]
    fn fish_catalog_reads_ids_and_titles_and_skips_unsafe_ids() {
        let voices = fish_catalog_voices(&json!({ "items": [
            { "_id": "abc123", "title": "Narrator" },
            { "_id": "../bad", "title": "Bad" },
            { "_id": "def456", "title": "" },
        ] }), "popular");
        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].name, "Narrator");
        assert_eq!(voices[1].name, "def456");
    }

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

    #[test]
    fn elevenlabs_catalog_only_includes_speech_models() {
        let model = json!({
            "model_id": "eleven_v3",
            "name": "Eleven v3",
            "can_do_text_to_speech": true,
        });
        let parsed = elevenlabs_speech_model(&model).unwrap();
        assert_eq!(parsed.id, "eleven_v3");
        assert_eq!(parsed.name, "Eleven v3");
        assert!(elevenlabs_speech_model(&json!({
            "model_id": "scribe_v2",
            "can_do_text_to_speech": false,
        })).is_none());
    }

    #[test]
    fn minimax_catalog_excludes_text_and_media_models() {
        assert!(minimax_speech_model(&json!({ "id": "MiniMax-M3" })).is_none());
        assert!(minimax_speech_model(&json!({ "id": "MiniMax-H3" })).is_none());
        assert_eq!(
            minimax_speech_model(&json!({ "id": "speech-2.8-turbo" })).unwrap().id,
            "speech-2.8-turbo",
        );
    }
}
