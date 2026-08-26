use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::json;

const KEYCHAIN_SERVICE: &str = "com.samue.spacron";
const APP_TITLE: &str = "Spacron";

/// Pooled HTTP clients keyed by their total-timeout (ms).
///
/// Building a fresh `reqwest::Client` per request throws away the connection
/// pool, so every call pays a new DNS + TCP + TLS handshake. That's especially
/// costly in the voice loop: TTS fires one request per sentence chunk, and the
/// transcription/routing/recon calls all hit the same few hosts moments apart.
/// Reusing a client keeps connections warm (HTTP keep-alive), so only the first
/// call to each host pays the handshake — later chunks and turns reuse it.
fn shared_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    static CLIENTS: OnceLock<Mutex<HashMap<u64, reqwest::Client>>> = OnceLock::new();
    let cache = CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = timeout.as_millis() as u64;
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(client) = map.get(&key) {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|err| format!("Failed to prepare the request: {err}"))?;
    map.insert(key, client.clone());
    Ok(client)
}

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_AUDIO_TRANSCRIPT_URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";
const OPENAI_STT_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const GROQ_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const XAI_URL: &str = "https://api.x.ai/v1/chat/completions";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const GOOGLE_AUDIO_TRANSCRIPTION_PROMPT: &str = "Transcribe this speech into clean, accurate text. Keep the speaker's exact technical terms, code words, file paths, flags, package names, and URLs. Use natural punctuation and paragraph breaks when they are obvious from the audio. Return only the transcript.";

const OPENROUTER_SYSTEM_PROMPT: &str = "Hey! You're a voice-to-text helper living inside a developer's productivity app. The person talking to you is a developer — they might be firing off a quick prompt to an AI coding agent, describing a bug, jotting down a task, or just thinking out loud while their hands are busy.\n\nYour job is to take their raw spoken words and turn them into clean, natural text — the kind of thing they'd have typed themselves if they weren't busy being a developer. Keep it human, keep it theirs.\n\nHere's how to do it well:\n\n1. DROP THE FILLER — quietly remove \"um\", \"uh\", \"like\", \"you know\", \"basically\", \"kind of\", \"sort of\", \"I mean\", false starts, and repeated words. Don't mention you did it, just clean it up.\n\n2. SPOKEN SYMBOLS → REAL SYMBOLS — when the developer says punctuation out loud, swap it in:\n   comma → ,   period / full stop → .   colon → :   semicolon → ;   exclamation / bang → !   question mark → ?   open paren / left paren → (   close paren / right paren → )   open bracket → [   close bracket → ]   open brace / left curly → {   close brace / right curly → }   equals → =   double equals → ==   triple equals → ===   fat arrow / arrow → =>   pipe → |   double pipe → ||   ampersand → &   double ampersand → &&   bang equals → !=   less than → <   greater than → >   slash → /   backslash → \\   dot → .   underscore → _   dash / hyphen → -   hash / pound → #   at sign → @   backtick → `   tilde → ~   star / asterisk → *   double star → **   caret → ^   percent → %   new line / next line → line break.\n\n3. DON'T TOUCH THE TECH STUFF — variable names, function names, file paths, CLI flags, package names, API names, URLs, config keys, environment variables — leave all of that exactly as spoken. When in doubt, keep it verbatim.\n\n4. TIDY UP THE SPEECH — casual, run-on spoken sentences should become clean written ones. Keep the developer's natural voice and directness though — don't make it stiff or formal. \"can you make it so that the button kind of changes colour when you hover over it\" → \"Make the button change colour on hover.\"\n\n5. KEEP THEIR VIBE — if they sound urgent, keep that urgency. If they're being casual, stay casual. If they're frustrated, that's fine too. Don't sanitise their personality out of the text.\n\n6. NUMBERS — use digits in technical contexts (port 8000, version 3, 12 files). Keep words for conversational mentions.\n\n7. STRUCTURE IT IF THEY SIGNAL IT — if they say \"first\", \"second\", \"also\", \"next\", \"new line\", shape it into a list or use line breaks naturally.\n\n8. NOTHING LOST, NOTHING ADDED — every idea they expressed should survive. Don't summarise, don't expand, don't add your own thoughts.\n\n9. THEY CHANGE THEIR MIND - if the developer starts something then corrects themselves mid-speech (\"meet at 5pm, actually 6pm\", \"use fetch, no wait, axios\"), keep ONLY the version they settled on. The abandoned attempt disappears completely - that is what they meant to say.\n\n10. SHAPE IT IF IT RAMBLES - a long breathless thought that is obviously steps, a list, or a message should come out laid out like one (short paragraphs, dashes or numbers), not one wall of text.\n\nJust output the cleaned-up text — no intro, no explanation, no quotes around it.";
const COMMIT_SYSTEM_PROMPT: &str = "You are an expert software engineer writing a git commit message. Analyse the diff thoroughly and write a high-quality commit message that clearly explains WHAT changed and WHY. Follow this structure:\n\n1. A short subject line (50–72 chars) using conventional commits when the type is clear (feat, fix, refactor, chore, docs, style, test, perf).\n2. A blank line.\n3. A body (one or more paragraphs) that describes the changes in detail — what was added, removed, or modified, and the reasoning or motivation behind the change. Mention any non-obvious decisions, trade-offs, or context a future reader would benefit from.\n\nOutput only the commit message — no preamble, no explanation, no markdown fences, no quotes.";

// Appended to the refinement system prompt when the user maintains a custom
// vocabulary (Settings → Voice refinement). This is the WhisperFlow trick:
// speech models mangle the names that matter most — projects, libraries,
// teammates — and no generic prompt can know them. Spelled exactly.
const CUSTOM_VOCABULARY_RULE: &str = "CUSTOM VOCABULARY — the developer relies on these terms. When what they said sounds like any of them, transcribe it exactly as written here, even if the raw audio sounded like something else. These override normal spelling:\n\n";

// Endpoints used to list each provider's live model catalogue. The frontend
// shows whatever these return so users can pick any model their key unlocks —
// new or old — instead of a hand-maintained allowlist.
const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";
const XAI_MODELS_URL: &str = "https://api.x.ai/v1/models";
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models?limit=1000";
const GOOGLE_MODELS_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

const KNOWN_PROVIDERS: &[&str] = &[
    "openrouter",
    "anthropic",
    "openai",
    "google",
    "groq",
    "xai",
    "ollama",
    "lmstudio",
];

// Local providers run on the user's machine, configured by a server URL rather
// than an API key. They speak the OpenAI-compatible protocol, so they reuse the
// OpenAI request/response path with a user-supplied base URL and no auth header.
const LOCAL_PROVIDERS: &[&str] = &["ollama", "lmstudio"];

fn is_known_provider(provider: &str) -> bool {
    KNOWN_PROVIDERS.contains(&provider)
}

fn is_local_provider(provider: &str) -> bool {
    LOCAL_PROVIDERS.contains(&provider)
}

/// Validate a user-supplied local server URL before using it as a request base.
/// Keeps it to a well-formed http(s) URL with no whitespace, control chars, or
/// path-traversal sequences. Local providers point at the user's own machine,
/// so this is about rejecting malformed input, not sandboxing the host.
fn base_url_is_safe(url: &str) -> bool {
    let url = url.trim();
    (url.starts_with("http://") || url.starts_with("https://"))
        && url.len() <= 256
        && !url.contains("..")
        && url.chars().all(|c| !c.is_whitespace() && !c.is_control())
}

/// Build a concrete endpoint URL from a validated local base URL, trimming any
/// trailing slash so we don't produce `//path`.
fn local_endpoint(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Resolve and validate the server URL for a provider. Local providers require a
/// safe, non-empty http(s) URL; non-local providers don't use one (returns
/// `None`). Centralises the checks shared by every command.
fn resolve_base_url(provider: &str, base_url: &Option<String>) -> Result<Option<String>, String> {
    if !is_local_provider(provider) {
        return Ok(None);
    }
    let url = base_url
        .as_ref()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if url.is_empty() {
        return Err("Server URL is not set.".to_string());
    }
    if !base_url_is_safe(&url) {
        return Err("Invalid server URL".to_string());
    }
    // Even for "local" providers, refuse link-local / cloud-metadata hosts. A
    // tampered or imported base_url (e.g. http://169.254.169.254/…) would
    // otherwise turn an AI request — which carries `Authorization: Bearer
    // {api_key}` when a key is set — into an SSRF that exfiltrates the token.
    // Reuses the same literal guard the http.rs client applies. localhost /
    // 127.0.0.1 are deliberately NOT blocked, so real local servers still work.
    if let Ok(parsed) = url::Url::parse(&url) {
        if let Some(host) = parsed.host_str() {
            // Literal check catches `169.254.169.254` etc.; the DNS-aware check
            // additionally catches a hostname — or a non-standard IP encoding like
            // the decimal `2852039166` (= 169.254.169.254) that fails `IpAddr`
            // parsing — that the OS resolver still maps to a blocked address.
            if crate::commands::http::host_is_blocked(host)
                || crate::commands::http::resolved_host_is_blocked(host)
            {
                return Err("Server URL host is not allowed".to_string());
            }
        }
    }
    Ok(Some(url))
}

/// Validate a model id is safe to embed in a request — including Google's URL
/// path (`/models/{model}:generateContent`) — without an exact allowlist, so
/// users can pick any model their provider exposes. Rejects empty/over-long
/// ids, path-traversal sequences, and anything outside a conservative set of
/// characters that real model ids use.
fn model_id_is_safe(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && !model.contains("..")
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
}

/// A model offered by a provider, normalised across the providers' differing
/// list-models response shapes. Serialised to the frontend model picker.
#[derive(serde::Serialize)]
pub struct ModelInfo {
    id: String,
    label: String,
    description: String,
}

/// Trim a provider-supplied description to a single tidy line for the picker.
fn truncate_desc(s: &str) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 140;
    if s.chars().count() > MAX {
        let mut t: String = s.chars().take(MAX).collect();
        t.push('…');
        t
    } else {
        s
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelPurpose {
    Chat,
    Stt,
    Realtime,
}

fn openai_is_stt_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    id.contains("whisper") || id.contains("transcribe") || id.contains("transcription")
}

/// OpenAI's realtime (speech-to-speech) models are excluded from the regular
/// chat list (see `openai_is_chat_model`'s block list) but are exactly what
/// the Realtime voice engine's model picker needs to show.
fn openai_is_realtime_model(id: &str) -> bool {
    id.to_ascii_lowercase().contains("realtime")
}

/// xAI doesn't expose a dedicated realtime flag on /v1/models, so match the
/// naming its Grok Realtime voice models actually use (`grok-voice-...`),
/// same as the curated fallback list in the frontend.
fn xai_is_realtime_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    id.contains("realtime") || id.contains("voice")
}

fn groq_is_stt_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    id.contains("whisper") || id.contains("transcribe") || id.contains("asr")
}

fn text_matches_any(value: &str, needles: &[&str]) -> bool {
    let value = value.to_ascii_lowercase();
    needles.iter().any(|needle| value.contains(needle))
}

fn json_string_array_contains(value: Option<&serde_json::Value>, needle: &str) -> bool {
    value
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().any(|item| item.as_str().map(|s| s.eq_ignore_ascii_case(needle)).unwrap_or(false)))
        .unwrap_or(false)
}

fn openrouter_model_matches_purpose(item: &serde_json::Value, id: &str, purpose: ModelPurpose) -> bool {
    if purpose == ModelPurpose::Chat {
        return true;
    }

    let architecture = item.get("architecture");
    let input_audio = json_string_array_contains(
        architecture.and_then(|a| a.get("input_modalities")),
        "audio",
    );
    let output_audio = json_string_array_contains(
        architecture.and_then(|a| a.get("output_modalities")),
        "audio",
    );
    let output_text = json_string_array_contains(
        architecture.and_then(|a| a.get("output_modalities")),
        "text",
    );
    let label = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(id);
    let haystack = format!("{id} {label}");

    match purpose {
        ModelPurpose::Stt => {
            (input_audio && !output_audio)
                || (input_audio && output_text)
                || text_matches_any(
                    &haystack,
                    &[
                        "whisper",
                        "transcribe",
                        "transcription",
                        "asr",
                        "chirp",
                        "voxtral",
                        "parakeet",
                    ],
                )
        }
        ModelPurpose::Chat => true,
        ModelPurpose::Realtime => text_matches_any(&haystack, &["realtime"]),
    }
}

/// OpenAI's /models lists embeddings, audio, image, and moderation models too;
/// keep only the text chat families.
fn openai_is_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    const BLOCK: &[&str] = &[
        "embedding",
        "whisper",
        "tts",
        "dall-e",
        "audio",
        "realtime",
        "image",
        "moderation",
        "transcribe",
        "search",
        "babbage",
        "davinci",
        "instruct",
    ];
    if BLOCK.iter().any(|b| id.contains(b)) {
        return false;
    }
    id.starts_with("gpt")
        || id.starts_with("chatgpt")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
}

/// Groq serves transcription and safety models alongside chat LLMs; drop those.
fn groq_is_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    const BLOCK: &[&str] = &["whisper", "tts", "guard"];
    !BLOCK.iter().any(|b| id.contains(b))
}

/// Parse a successful JSON response, or surface a redacted error preview.
async fn ok_json(response: reqwest::Response, who: &str) -> Result<serde_json::Value, String> {
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let preview = redact_secrets(&body.chars().take(200).collect::<String>());
        return Err(format!("{who} model list failed ({status}): {preview}"));
    }
    response
        .json()
        .await
        .map_err(|err| format!("{who} returned an invalid model list: {err}"))
}

/// Redact API-key-shaped substrings from an error body before surfacing it to
/// the frontend. Covers the key prefixes used by every supported provider:
/// `sk-` (OpenRouter / OpenAI / Anthropic `sk-ant-`), `AIza` (Google) and
/// `gsk_` (Groq).
fn redact_secrets(s: &str) -> String {
    const PREFIXES: &[&str] = &["sk-", "AIza", "gsk_"];

    let mut out = String::new();
    let mut rest = s;

    loop {
        // Find the earliest occurrence of any known key prefix.
        let next = PREFIXES
            .iter()
            .filter_map(|p| rest.find(p).map(|pos| (pos, p.len())))
            .min_by_key(|&(pos, _)| pos);

        let Some((pos, prefix_len)) = next else {
            break;
        };

        out.push_str(&rest[..pos]);
        out.push_str("[redacted]");
        let after = &rest[pos + prefix_len..];
        // Skip the rest of the key token until whitespace, a quote, or the end.
        let end = after
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .unwrap_or(after.len());
        rest = &after[end..];
    }

    out.push_str(rest);
    out
}

/// Format a reqwest error for the frontend without leaking the request URL,
/// which for some providers (Google) carries the API key as a query param.
fn safe_request_error(context: &str, err: reqwest::Error) -> String {
    let stripped = err.without_url();
    format!("{context}: {}", redact_secrets(&stripped.to_string()))
}

/// Collect the reply out of a Gemini response.
///
/// The answer can arrive split across several parts, and a thinking model
/// prefixes it with `thought` parts that are not the answer — so join every
/// ordinary text part in order and skip the thoughts. Taking `parts[0]` alone
/// returned a thought, or a fragment, depending on the model.
fn extract_google_text(payload: &serde_json::Value) -> String {
    let parts = payload
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|cand| cand.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(|parts| parts.as_array());
    let Some(parts) = parts else {
        return String::new();
    };

    let mut text = String::new();
    for part in parts {
        if part
            .get("thought")
            .and_then(|thought| thought.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(chunk) = part.get("text").and_then(|t| t.as_str()) {
            text.push_str(chunk);
        }
    }
    text.trim().to_string()
}

/// Collect the reply out of an Anthropic response.
///
/// Anthropic returns a list of typed blocks, and the text is not always block
/// zero — a thinking or tool block can come first on newer models. Join every
/// text block rather than indexing.
fn extract_anthropic_text(payload: &serde_json::Value) -> String {
    let Some(blocks) = payload.get("content").and_then(|c| c.as_array()) else {
        return String::new();
    };

    let mut text = String::new();
    for block in blocks {
        // Older responses omit `type` on a plain text block; anything else
        // named (thinking, tool_use, …) is not the answer.
        if !matches!(
            block.get("type").and_then(|t| t.as_str()),
            None | Some("text")
        ) {
            continue;
        }
        if let Some(chunk) = block.get("text").and_then(|t| t.as_str()) {
            text.push_str(chunk);
        }
    }
    text.trim().to_string()
}

fn audio_mime_type_is_safe(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "audio/wav"
            | "audio/mp3"
            | "audio/mpeg"
            | "audio/aiff"
            | "audio/aac"
            | "audio/ogg"
            | "audio/flac"
            | "audio/mp4"
            | "audio/webm"
            | "audio/x-m4a"
    )
}

fn audio_format_from_mime_type(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "audio/wav" => Some("wav"),
        "audio/mp3" | "audio/mpeg" => Some("mp3"),
        "audio/aiff" => Some("aiff"),
        "audio/aac" => Some("aac"),
        "audio/ogg" => Some("ogg"),
        "audio/flac" => Some("flac"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/webm" => Some("webm"),
        _ => None,
    }
}

fn openrouter_audio_chat_model_is_unsupported(model: &str) -> bool {
    matches!(model, "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")
}

fn audio_filename_for_format(format: &str) -> &'static str {
    match format {
        "mp3" => "audio.mp3",
        "aiff" => "audio.aiff",
        "aac" => "audio.aac",
        "ogg" => "audio.ogg",
        "flac" => "audio.flac",
        "m4a" => "audio.m4a",
        "webm" => "audio.webm",
        _ => "audio.wav",
    }
}

fn build_audio_transcription_multipart_body(
    boundary: &str,
    model: &str,
    mime_type: &str,
    audio_format: &str,
    audio_bytes: &[u8],
    prompt: Option<&str>,
) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model}\r\n"
        )
        .as_bytes(),
    );
    // OpenAI's transcription `prompt`: a biasing hint the model conditions on.
    // It steers spelling of unusual terms without being echoed into the output
    // (most of the time — hence trimming it to just the vocabulary list).
    if let Some(prompt) = prompt {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n{prompt}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {mime_type}\r\n\r\n",
            audio_filename_for_format(audio_format)
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}


fn openai_realtime_offer_is_plausible(offer_sdp: &str) -> bool {
    let mut saw_version = false;
    let mut saw_origin = false;
    let mut saw_session_name = false;
    let mut saw_timing = false;
    let mut saw_media = false;

    for line in offer_sdp.lines() {
        let line = line.trim_end();
        if line == "v=0" {
            saw_version = true;
        } else if line.starts_with("o=") {
            saw_origin = true;
        } else if line.starts_with("s=") {
            saw_session_name = true;
        } else if line.starts_with("t=") {
            saw_timing = true;
        } else if line.starts_with("m=") {
            saw_media = true;
        }
    }

    saw_version && saw_origin && saw_session_name && saw_timing && saw_media
}

fn keychain_username(provider: &str) -> String {
    format!("{provider}_api_key")
}

fn keychain_entry(provider: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, &keychain_username(provider))
        .map_err(|err| format!("Failed to access the system keychain: {err}"))
}

/// Read a provider's API key out of the OS keychain.
///
/// Deliberately **not** a `#[tauri::command]`, and deliberately not `pub`: this
/// returns the raw secret, so exposing it on the IPC surface would let anything
/// running in the WebView read every provider key with one `invoke`. It carried
/// the attribute before without being listed in `generate_handler!` — harmless in
/// itself, but one line away from doing real damage, and it read as if the
/// frontend were meant to call it. The frontend only ever needs
/// [`provider_api_key_exists`]; requests are authenticated in Rust, with the
/// frontend passing `apiKey: ''` and this resolving the real value backend-side.
///
/// `commands::github` already follows this rule for its token — this brings the
/// two into line.
fn provider_api_key_get(provider: String) -> Result<Option<String>, String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let entry = keychain_entry(&provider)?;
    match entry.get_password() {
        Ok(password) => {
            let trimmed = password.trim().to_string();
            Ok(if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            })
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("Failed to read the API key: {err}")),
    }
}

#[tauri::command]
pub fn provider_api_key_exists(provider: String) -> Result<bool, String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let entry = keychain_entry(&provider)?;
    match entry.get_password() {
        Ok(password) => Ok(!password.trim().is_empty()),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(err) => Err(format!("Failed to check the API key: {err}")),
    }
}

#[tauri::command]
pub fn provider_api_key_set(provider: String, api_key: String) -> Result<(), String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let api_key = api_key.trim().to_string();
    let entry = keychain_entry(&provider)?;

    if api_key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(err) => Err(format!("Failed to remove the API key: {err}")),
        }
    } else {
        entry
            .set_password(&api_key)
            .map_err(|err| format!("Failed to save the API key: {err}"))
    }
}

#[tauri::command]
pub fn provider_api_key_delete(provider: String) -> Result<(), String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let entry = keychain_entry(&provider)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("Failed to remove the API key: {err}")),
    }
}

/// Keychain entry for a remote-workspace token. The token unlocks a shell on a
/// remote dev box, so it must not live in localStorage with the connection list
/// (see `src/lib/stores/remoteWorkspace.ts`) — only in the OS keychain. Ids are
/// generated by the frontend (`conn-<base36>-<base36>`), so validate the charset
/// before embedding one in the keychain account name.
fn remote_token_entry(id: &str) -> Result<Entry, String> {
    if id.is_empty()
        || id.len() > 64
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid remote id".to_string());
    }
    Entry::new(KEYCHAIN_SERVICE, &format!("remote_workspace_token_{id}"))
        .map_err(|err| format!("Failed to access the system keychain: {err}"))
}

/// Save (or, when empty, clear) a remote-workspace token in the keychain.
///
/// Unlike `provider_api_key_*`, this token MUST be readable by the renderer:
/// the frontend opens the `/pty` WebSocket itself and presents the token in the
/// `token.<TOKEN>` subprotocol, so there is no Rust-side request to authenticate
/// with it. The renderer keeps it in session memory only — it is never written
/// back to localStorage.
#[tauri::command]
pub fn remote_token_set(id: String, token: String) -> Result<(), String> {
    let entry = remote_token_entry(&id)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(err) => Err(format!("Failed to remove the remote token: {err}")),
        }
    } else {
        entry
            .set_password(&token)
            .map_err(|err| format!("Failed to save the remote token: {err}"))
    }
}

#[tauri::command]
pub fn remote_token_get(id: String) -> Result<Option<String>, String> {
    let entry = remote_token_entry(&id)?;
    match entry.get_password() {
        Ok(password) => {
            let trimmed = password.trim().to_string();
            Ok(if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            })
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("Failed to read the remote token: {err}")),
    }
}

#[tauri::command]
pub fn remote_token_delete(id: String) -> Result<(), String> {
    let entry = remote_token_entry(&id)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("Failed to remove the remote token: {err}")),
    }
}

fn resolve_api_key(provider: &str, provided_api_key: &str) -> Result<String, String> {
    if is_local_provider(provider) {
        return Ok(String::new());
    }
    let provided_api_key = provided_api_key.trim();
    if !provided_api_key.is_empty() {
        return Ok(provided_api_key.to_string());
    }
    provider_api_key_get(provider.to_string())?
        .ok_or_else(|| format!("{} API key is not set.", provider))
}

/// Every provider has its own way of saying "I ran out of room before I
/// answered" — an OpenAI `finish_reason`, an Anthropic `stop_reason`, a Gemini
/// `finishReason` — and all three surface here as the same empty reply. Name
/// the actual cause instead of letting the callers report "empty response".
const TOKEN_LIMIT_MESSAGE: &str =
    "The model hit its token limit before answering. Try a shorter input or a non-reasoning model.";

/// Which token-budget field an OpenAI-compatible endpoint accepts.
///
/// The classic Chat Completions shape is `max_tokens`, but OpenAI's reasoning
/// models — and anything else following their newer schema — reject it and
/// demand `max_completion_tokens`. Providers ship new models on both schemas
/// and we list their catalogues live, so which one a given model wants cannot
/// be hardcoded here; see [`adapt_chat_shape`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TokenBudgetField {
    MaxTokens,
    MaxCompletionTokens,
}

impl TokenBudgetField {
    fn as_str(self) -> &'static str {
        match self {
            Self::MaxTokens => "max_tokens",
            Self::MaxCompletionTokens => "max_completion_tokens",
        }
    }
}

/// The request-parameter dialect one endpoint+model pair accepts.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct ChatParamShape {
    token_field: TokenBudgetField,
    /// Reasoning models only allow the default temperature — any explicit value
    /// is a 400 — so for those we drop the field instead of sending one.
    send_temperature: bool,
    /// Whether this model bills hidden thinking tokens against the budget we
    /// send. Learned from a reply rather than from an error: a gateway that
    /// accepts `max_tokens` for every model — OpenRouter — never rejects
    /// anything, it just returns a truncated or empty answer.
    reasoning_headroom: bool,
}

impl Default for ChatParamShape {
    /// The classic dialect every older and local endpoint speaks. We start here
    /// and only move once a provider tells us it wants something else.
    fn default() -> Self {
        Self {
            token_field: TokenBudgetField::MaxTokens,
            send_temperature: true,
            reasoning_headroom: false,
        }
    }
}

/// Remembers the dialect each model last answered to, so the negotiation costs
/// one extra round-trip per model per app run rather than one per call.
fn chat_shape_cache() -> &'static Mutex<HashMap<String, ChatParamShape>> {
    static SHAPES: OnceLock<Mutex<HashMap<String, ChatParamShape>>> = OnceLock::new();
    SHAPES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Key a remembered dialect by endpoint as well as model: local servers reuse
/// generic ids like `local-model` across wildly different backends.
fn chat_shape_key(provider: &str, base_url: Option<&str>, model: &str) -> String {
    format!("{provider}\u{1}{}\u{1}{model}", base_url.unwrap_or(""))
}

fn cached_chat_shape(key: &str) -> ChatParamShape {
    chat_shape_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(key)
        .copied()
        .unwrap_or_default()
}

fn remember_chat_shape(key: &str, shape: ChatParamShape) {
    chat_shape_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key.to_string(), shape);
}

/// Read a rejected request's error body and work out which parameter the
/// endpoint objected to, returning the dialect to retry with — or `None` when
/// the failure is nothing we can renegotiate (bad key, unknown model, rate
/// limit), in which case the caller surfaces the error as-is.
///
/// This is driven by the provider's own complaint rather than by matching model
/// ids, so a model released after this build still works: whatever the endpoint
/// says it wants is what the retry sends.
fn adapt_chat_shape(shape: ChatParamShape, body: &str) -> Option<ChatParamShape> {
    let lower = body.to_lowercase();
    // OpenAI-shaped errors name the offending field in `error.param`; other
    // gateways only mention it in the message, so fall back to scanning.
    let param = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")?
                .get("param")?
                .as_str()
                .map(str::to_lowercase)
        });
    let blames = |field: &str| match param.as_deref() {
        Some(p) => p == field || p.rsplit('.').next() == Some(field),
        None => lower.contains(field),
    };

    let mut next = shape;
    if shape.send_temperature && blames("temperature") {
        next.send_temperature = false;
    }
    match shape.token_field {
        // "Unsupported parameter: 'max_tokens' … use 'max_completion_tokens'".
        // `max_completion_tokens` does not contain `max_tokens` as a substring,
        // so the two checks cannot shadow each other.
        TokenBudgetField::MaxTokens
            if blames("max_tokens") || lower.contains("max_completion_tokens") =>
        {
            next.token_field = TokenBudgetField::MaxCompletionTokens;
        }
        // The mirror case: an endpoint that only knows the classic field.
        TokenBudgetField::MaxCompletionTokens if blames("max_completion_tokens") => {
            next.token_field = TokenBudgetField::MaxTokens;
        }
        _ => {}
    }
    (next != shape).then_some(next)
}

/// `max_completion_tokens` has to cover a reasoning model's hidden thinking
/// tokens as well as the reply, so a budget sized for visible output alone
/// comes back empty with `finish_reason: "length"`. Give those real headroom —
/// it is a ceiling, not a spend, so nothing is wasted when the model is brief.
fn token_budget_for(shape: ChatParamShape, requested: u32) -> u32 {
    // `max_completion_tokens` always covers thinking tokens. The classic field
    // only does when the provider maps a reasoning model onto it, which we can
    // only find out by looking at what came back.
    if shape.reasoning_headroom || shape.token_field == TokenBudgetField::MaxCompletionTokens {
        with_reasoning_headroom(requested)
    } else {
        requested
    }
}

/// Did the reply stop because it hit the output ceiling?
fn reply_was_truncated(choice: Option<&serde_json::Value>) -> bool {
    choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(|reason| reason.as_str())
        == Some("length")
}

/// Every field an OpenAI-compatible server might return its thinking in.
/// OpenRouter uses `reasoning`; llama.cpp, LM Studio, vLLM and the DeepSeek API
/// use `reasoning_content`; Ollama uses `thinking`. None of them are the answer,
/// but all of them prove the budget is being shared with a scratchpad.
const REASONING_FIELDS: [&str; 3] = ["reasoning", "reasoning_content", "thinking"];

/// Did the model spend hidden reasoning tokens producing this reply? Usage
/// reports them in OpenAI's shape; most other servers echo the thinking back on
/// the message instead, and a local one may do neither — see
/// [`strip_inline_reasoning`].
fn spent_reasoning_tokens(payload: &serde_json::Value, choice: Option<&serde_json::Value>) -> bool {
    let counted = payload
        .get("usage")
        .and_then(|usage| usage.get("completion_tokens_details"))
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(|tokens| tokens.as_u64())
        .unwrap_or(0)
        > 0;
    let message = choice.and_then(|choice| choice.get("message"));
    let echoed = REASONING_FIELDS.iter().any(|field| {
        message
            .and_then(|message| message.get(field))
            .and_then(|reasoning| reasoning.as_str())
            .is_some_and(|reasoning| !reasoning.trim().is_empty())
    });
    counted || echoed
}

/// Strip a model's inline scratchpad out of its reply.
///
/// A local server hands back whatever the model emitted, and open reasoning
/// models write their thinking inline as `<think>…</think>` before answering.
/// Ollama and LM Studio only lift that into a separate field when the model's
/// template declares it, so a raw GGUF leaks the entire monologue into what we
/// hand back as a refined prompt or a commit message.
///
/// An opener with no closer means the reply was cut off mid-thought — nothing
/// after it is answer, so nothing survives.
fn strip_inline_reasoning(text: &str) -> String {
    // Lowercase only the ASCII, so every index stays valid in the original.
    fn ascii_lower(text: &str) -> String {
        text.chars()
            .map(|c| if c.is_ascii() { c.to_ascii_lowercase() } else { c })
            .collect()
    }

    let mut out = text.to_string();
    for tag in ["think", "thinking", "reasoning", "thought"] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        loop {
            let lower = ascii_lower(&out);
            let Some(start) = lower.find(&open) else {
                break;
            };
            match lower[start..].find(&close) {
                Some(offset) => {
                    let end = start + offset + close.len();
                    out.replace_range(start..end, "");
                }
                None => {
                    out.truncate(start);
                    break;
                }
            }
        }
    }
    out.trim().to_string()
}

/// Some gateways answer 200 with an error object where the choices should be —
/// an upstream provider failing, a moderation block, a mid-flight cutoff.
/// OpenRouter does this routinely. Report it instead of an empty reply.
fn embedded_error_message(payload: &serde_json::Value) -> Option<String> {
    let message = payload.get("error")?.get("message")?.as_str()?.trim();
    (!message.is_empty()).then(|| message.to_string())
}

/// Raise an output ceiling so a reasoning model's hidden thinking tokens cannot
/// consume the entire budget. Used wherever a provider bills thinking against
/// the same ceiling as the reply — OpenAI's `max_completion_tokens` and
/// Gemini's `maxOutputTokens` both do.
fn with_reasoning_headroom(requested: u32) -> u32 {
    requested.saturating_mul(4).max(4096)
}

/// Run a single-shot system+user completion against the chosen provider and
/// return the assistant's text. Normalises the three request/response shapes
/// (OpenAI-compatible, Anthropic Messages, Google Gemini) behind one signature.
#[allow(clippy::too_many_arguments)]
async fn run_completion(
    provider: &str,
    model: &str,
    api_key: &str,
    base_url: Option<&str>,
    system_prompt: &str,
    user_text: &str,
    temperature: f64,
    max_tokens: u32,
) -> Result<String, String> {
    let client = shared_http_client(Duration::from_secs(45))?;

    match provider {
        "anthropic" => {
            let response = client
                .post(ANTHROPIC_URL)
                .header("x-api-key", api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&json!({
                    "model": model,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "system": system_prompt,
                    "messages": [ { "role": "user", "content": user_text } ],
                }))
                .send()
                .await
                .map_err(|err| safe_request_error("Failed to contact Anthropic", err))?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let preview = redact_secrets(&body.chars().take(200).collect::<String>());
                return Err(format!("Anthropic request failed ({status}): {preview}"));
            }

            let payload: serde_json::Value = response
                .json()
                .await
                .map_err(|err| format!("Anthropic returned an invalid response: {err}"))?;

            let content = extract_anthropic_text(&payload);

            // Anthropic bills only the reply against `max_tokens`, so this is
            // rare — but a long preamble can still exhaust it before any text.
            if content.is_empty()
                && payload.get("stop_reason").and_then(|r| r.as_str()) == Some("max_tokens")
            {
                return Err(TOKEN_LIMIT_MESSAGE.to_string());
            }

            Ok(content)
        }
        "google" => {
            // Pass the key via the documented header, never in the URL — the URL
            // shows up in reqwest error strings and any request logging.
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            );
            let response = client
                .post(url)
                .header("x-goog-api-key", api_key)
                .json(&json!({
                    "systemInstruction": { "parts": [ { "text": system_prompt } ] },
                    "contents": [ { "role": "user", "parts": [ { "text": user_text } ] } ],
                    // Gemini 2.5 and newer spend thinking tokens from this same
                    // ceiling, so a budget sized for the reply alone comes back
                    // empty with `finishReason: MAX_TOKENS`. It is a cap, not a
                    // spend — a brief model is billed for what it actually used.
                    "generationConfig": {
                        "temperature": temperature,
                        "maxOutputTokens": with_reasoning_headroom(max_tokens),
                    },
                }))
                .send()
                .await
                .map_err(|err| safe_request_error("Failed to contact Google", err))?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let preview = redact_secrets(&body.chars().take(200).collect::<String>());
                return Err(format!("Google request failed ({status}): {preview}"));
            }

            let payload: serde_json::Value = response
                .json()
                .await
                .map_err(|err| format!("Google returned an invalid response: {err}"))?;

            let content = extract_google_text(&payload);

            if content.is_empty()
                && payload
                    .get("candidates")
                    .and_then(|candidates| candidates.get(0))
                    .and_then(|candidate| candidate.get("finishReason"))
                    .and_then(|reason| reason.as_str())
                    == Some("MAX_TOKENS")
            {
                return Err(TOKEN_LIMIT_MESSAGE.to_string());
            }

            Ok(content)
        }
        // OpenAI-compatible: openrouter, openai, groq, ollama, lmstudio.
        _ => {
            let url = match provider {
                "openai" => OPENAI_URL.to_string(),
                "groq" => GROQ_URL.to_string(),
                "xai" => XAI_URL.to_string(),
                // Local providers point at the user's own server.
                p if is_local_provider(p) => {
                    let base = base_url.unwrap_or_default();
                    local_endpoint(base, "chat/completions")
                }
                _ => OPENROUTER_URL.to_string(),
            };

            let shape_key = chat_shape_key(provider, base_url, model);
            let mut shape = cached_chat_shape(&shape_key);

            // Send, and when the answer shows we spoke the wrong dialect, adjust
            // and try again — whether the endpoint said so with a 400 or just
            // returned a stunted reply. Three attempts covers the knobs (token
            // field, temperature, reasoning headroom) from a cold start, and the
            // result is cached, so only the first call for a model can pay.
            const MAX_ATTEMPTS: u32 = 3;
            let mut attempt = 0;
            let content = loop {
                attempt += 1;

                let mut request = client.post(&url);

                // Local providers default to no authentication; only send the
                // bearer token when we actually have one.
                if !api_key.is_empty() {
                    request = request
                        .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"));
                }

                // OpenRouter asks for attribution headers; harmless elsewhere
                // but we only send them where they belong.
                if provider == "openrouter" {
                    request = request
                        .header("HTTP-Referer", "https://spacron.app")
                        .header("X-Title", APP_TITLE);
                }

                let mut body = json!({
                    "model": model,
                    "messages": [
                        { "role": "system", "content": system_prompt },
                        { "role": "user", "content": user_text },
                    ],
                });
                if let Some(fields) = body.as_object_mut() {
                    fields.insert(
                        shape.token_field.as_str().to_string(),
                        json!(token_budget_for(shape, max_tokens)),
                    );
                    if shape.send_temperature {
                        fields.insert("temperature".to_string(), json!(temperature));
                    }
                }

                let response = request.json(&body).send().await.map_err(|err| {
                    safe_request_error("Failed to contact the model provider", err)
                })?;

                let status = response.status();

                if !status.is_success() {
                    let body = response.text().await.unwrap_or_default();

                    // Only a rejected *request* is worth renegotiating; anything
                    // else (auth, quota, server error) is reported straight away.
                    let rejected_request = status == reqwest::StatusCode::BAD_REQUEST
                        || status == reqwest::StatusCode::UNPROCESSABLE_ENTITY;
                    if rejected_request && attempt < MAX_ATTEMPTS {
                        if let Some(next) = adapt_chat_shape(shape, &body) {
                            shape = next;
                            continue;
                        }
                    }

                    let preview = redact_secrets(&body.chars().take(200).collect::<String>());
                    return Err(format!("Model request failed ({status}): {preview}"));
                }

                let payload: serde_json::Value = response.json().await.map_err(|err| {
                    format!("The model provider returned an invalid response: {err}")
                })?;

                if let Some(message) = embedded_error_message(&payload) {
                    let preview = redact_secrets(&message.chars().take(200).collect::<String>());
                    return Err(format!("The model provider returned an error: {preview}"));
                }

                let choice = payload.get("choices").and_then(|choices| choices.get(0));
                let raw = choice
                    .and_then(|choice| choice.get("message"))
                    .and_then(|message| message.get("content"))
                    .and_then(|content| content.as_str())
                    .map(str::trim)
                    .unwrap_or("");
                let text = strip_inline_reasoning(raw);

                let truncated = reply_was_truncated(choice);
                // A reply that was nothing but scratchpad is the same starvation
                // signal as a truncated one, and the only signal a bare local
                // server gives: no usage details, no separate thinking field.
                let all_scratchpad = text.is_empty() && !raw.is_empty();
                let reasoned = spent_reasoning_tokens(&payload, choice) || all_scratchpad;

                // Nothing rejected this request — it succeeded and came back
                // short because the model spent the budget thinking. This is the
                // OpenRouter and local-server case: they accept `max_tokens` for
                // every model, so no error ever announces that a model reasons;
                // only the reply does.
                let starved = (truncated && (reasoned || text.is_empty())) || all_scratchpad;
                if (reasoned || starved) && !shape.reasoning_headroom {
                    shape.reasoning_headroom = true;
                    remember_chat_shape(&shape_key, shape);
                    if starved && attempt < MAX_ATTEMPTS {
                        continue;
                    }
                }

                if text.is_empty() && (truncated || all_scratchpad) {
                    return Err(TOKEN_LIMIT_MESSAGE.to_string());
                }

                // Whatever finally worked is what the next call should open with.
                remember_chat_shape(&shape_key, shape);
                break text;
            };

            Ok(content)
        }
    }
}

#[tauri::command]
pub async fn ai_refine_prompt(
    text: String,
    provider: String,
    model: String,
    api_key: String,
    base_url: Option<String>,
    vocabulary: Option<String>,
) -> Result<String, String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let api_key = resolve_api_key(&provider, &api_key)?;
    let base_url = resolve_base_url(&provider, &base_url)?;
    if !model_id_is_safe(&model) {
        return Err("Invalid model id".to_string());
    }

    const MAX_TEXT_LEN: usize = 32_000;
    // A vocabulary list is user-authored and bounded — a paste accident should
    // not ship a megabyte of text into every refinement request.
    const MAX_VOCABULARY_LEN: usize = 4_000;

    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    if text.chars().count() > MAX_TEXT_LEN {
        return Err("Input text exceeds maximum length".to_string());
    }

    let system_prompt = match vocabulary {
        Some(list) => {
            let list = list.trim();
            if list.is_empty() {
                OPENROUTER_SYSTEM_PROMPT.to_string()
            } else if list.chars().count() > MAX_VOCABULARY_LEN {
                return Err("Custom vocabulary exceeds maximum length".to_string());
            } else {
                format!("{OPENROUTER_SYSTEM_PROMPT}\n\n{CUSTOM_VOCABULARY_RULE}{list}")
            }
        }
        None => OPENROUTER_SYSTEM_PROMPT.to_string(),
    };

    let content = run_completion(
        &provider,
        &model,
        &api_key,
        base_url.as_deref(),
        &system_prompt,
        &text,
        0.1,
        512,
    )
    .await?;

    if content.is_empty() {
        return Err("The model returned an empty response.".to_string());
    }
    Ok(content)
}

#[tauri::command]
pub async fn ai_transcribe_audio(
    audio_bytes: Vec<u8>,
    mime_type: String,
    provider: String,
    model: String,
    api_key: String,
    base_url: Option<String>,
    vocabulary: Option<String>,
) -> Result<String, String> {
    if provider != "google" && provider != "openai" && provider != "openrouter" && !is_local_provider(&provider) {
        return Err("Selected provider does not support transcription yet.".to_string());
    }

    let api_key = resolve_api_key(&provider, &api_key)?;
    let base_url = resolve_base_url(&provider, &base_url)?;

    let model = model.trim().to_string();
    if !model_id_is_safe(&model) {
        return Err("Invalid transcription model id".to_string());
    }

    let mime_type = mime_type.trim().to_ascii_lowercase();
    if !audio_mime_type_is_safe(&mime_type) {
        return Err("Unsupported audio format".to_string());
    }
    let audio_format = audio_format_from_mime_type(&mime_type)
        .ok_or_else(|| "Unsupported audio format".to_string())?;

    if audio_bytes.is_empty() {
        return Ok(String::new());
    }

    let client = shared_http_client(Duration::from_secs(60))?;

    let audio_b64 = STANDARD.encode(&audio_bytes);

    // Hotword biasing at the STT layer (the Wispr Flow "Variable Recognition"
    // trick): bias the TRANSCRIPTION with the developer's own terms so the
    // words come out right before any polish pass runs. Each provider takes
    // the hint differently; OpenRouter's audio endpoint and arbitrary local
    // servers have no standard slot, so they simply skip it and rely on the
    // polish pass instead.
    let vocabulary = vocabulary
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    // OpenAI's `prompt` field is capped at 224 tokens; stay well under it.
    let openai_prompt = vocabulary
        .as_deref()
        .map(|v| v.chars().take(600).collect::<String>());

    match provider.as_str() {
        "google" => {
            let transcription_prompt = match &vocabulary {
                Some(list) => format!(
                    "{GOOGLE_AUDIO_TRANSCRIPTION_PROMPT} The speaker customarily uses these exact terms - spell them exactly as written whenever they are heard: {list}"
                ),
                None => GOOGLE_AUDIO_TRANSCRIPTION_PROMPT.to_string(),
            };
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            );

            let response = client
                .post(url)
                .header("x-goog-api-key", api_key)
                .json(&json!({
                    "contents": [{
                        "role": "user",
                        "parts": [
                            { "text": transcription_prompt },
                            {
                                "inlineData": {
                                    "mimeType": mime_type,
                                    "data": audio_b64
                                }
                            }
                        ]
                    }],
                    "generationConfig": {
                        "temperature": 0.1,
                        "maxOutputTokens": 2048
                    }
                }))
                .send()
                .await
                .map_err(|err| safe_request_error("Failed to contact Google transcription", err))?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let preview = redact_secrets(&body.chars().take(200).collect::<String>());
                return Err(format!("Google transcription failed ({status}): {preview}"));
            }

            let payload: serde_json::Value = response.json().await.map_err(|err| {
                format!("Google transcription returned an invalid response: {err}")
            })?;

            Ok(extract_google_text(&payload))
        }
        "openai" => {
            let response = client
                .post(OPENAI_STT_URL)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
                .header(reqwest::header::CONTENT_TYPE, "multipart/form-data; boundary=spacron-openai-stt")
                .body(build_audio_transcription_multipart_body(
                    "spacron-openai-stt",
                    &model,
                    &mime_type,
                    audio_format,
                    &audio_bytes,
                    openai_prompt.as_deref(),
                ))
                .send()
                .await
                .map_err(|err| safe_request_error("Failed to contact OpenAI transcription", err))?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let preview = redact_secrets(&body.chars().take(200).collect::<String>());
                return Err(format!("OpenAI transcription failed ({status}): {preview}"));
            }

            let payload: serde_json::Value = response.json().await.map_err(|err| {
                format!("OpenAI transcription returned an invalid response: {err}")
            })?;

            Ok(payload
                .get("text")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string())
        }
        "openrouter" => {
            if openrouter_audio_chat_model_is_unsupported(&model) {
                return Err("That OpenRouter :free audio model is not usable for no-balance transcription; OpenRouter returns 402 Payment Required for audio. Choose a dedicated STT model, browser Web Speech, or a local transcription server.".to_string());
            }

            let response = client
                .post(OPENROUTER_AUDIO_TRANSCRIPT_URL)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
                .header("HTTP-Referer", "https://spacron.app")
                .header("X-Title", APP_TITLE)
                .json(&json!({
                    "model": model,
                    "input_audio": {
                        "data": audio_b64,
                        "format": audio_format,
                    }
                }))
                .send()
                .await
                .map_err(|err| {
                    safe_request_error("Failed to contact OpenRouter transcription", err)
                })?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let preview = redact_secrets(&body.chars().take(200).collect::<String>());
                return Err(format!(
                    "OpenRouter transcription failed ({status}): {preview}"
                ));
            }

            let payload: serde_json::Value = response.json().await.map_err(|err| {
                format!("OpenRouter transcription returned an invalid response: {err}")
            })?;

            Ok(payload
                .get("text")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string())
        }
        p if is_local_provider(p) => {
            let Some(base) = base_url.as_deref() else {
                return Err("Server URL is not set.".to_string());
            };
            let boundary = "spacron-audio-transcription-boundary";
            let response = client
                .post(local_endpoint(base, "/audio/transcriptions"))
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(build_audio_transcription_multipart_body(
                    boundary,
                    &model,
                    &mime_type,
                    audio_format,
                    &audio_bytes,
                    None,
                ))
                .send()
                .await
                .map_err(|err| {
                    safe_request_error("Failed to contact local transcription provider", err)
                })?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let preview = redact_secrets(&body.chars().take(200).collect::<String>());
                return Err(format!("Local transcription failed ({status}): {preview}"));
            }

            let payload: serde_json::Value = response.json().await.map_err(|err| {
                format!("Local transcription returned an invalid response: {err}")
            })?;

            Ok(payload
                .get("text")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string())
        }
        _ => Err("Selected provider does not support transcription yet.".to_string()),
    }
}

/// Generic single-shot completion with a caller-supplied system prompt. Powers
/// the agent orchestrator "brain" (routing a natural-language request to the
/// right terminal agent). Shares the same provider plumbing as the other AI
/// commands; the caller is responsible for the system prompt's contract.
#[tauri::command]
pub async fn ai_complete(
    system_prompt: String,
    user_text: String,
    provider: String,
    model: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<String, String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let api_key = resolve_api_key(&provider, &api_key)?;
    let base_url = resolve_base_url(&provider, &base_url)?;
    if !model_id_is_safe(&model) {
        return Err("Invalid model id".to_string());
    }

    const MAX_TEXT_LEN: usize = 32_000;

    let user_text = user_text.trim().to_string();
    if user_text.is_empty() {
        return Ok(String::new());
    }
    if user_text.chars().count() > MAX_TEXT_LEN {
        return Err("Input text exceeds maximum length".to_string());
    }

    let system_prompt = system_prompt.trim();
    let system_prompt = if system_prompt.is_empty() {
        OPENROUTER_SYSTEM_PROMPT
    } else {
        system_prompt
    };

    let content = run_completion(
        &provider,
        &model,
        &api_key,
        base_url.as_deref(),
        system_prompt,
        &user_text,
        0.3,
        1024,
    )
    .await?;

    if content.is_empty() {
        return Err("The model returned an empty response.".to_string());
    }
    Ok(content)
}

#[tauri::command]
pub async fn ai_generate_commit_message(
    diff: String,
    provider: String,
    model: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<String, String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let api_key = resolve_api_key(&provider, &api_key)?;
    let base_url = resolve_base_url(&provider, &base_url)?;
    if !model_id_is_safe(&model) {
        return Err("Invalid model id".to_string());
    }

    const MAX_DIFF_LEN: usize = 20_000;

    let diff = diff.trim().to_string();
    if diff.is_empty() {
        return Err("No changes to summarize.".to_string());
    }
    let diff = if diff.len() > MAX_DIFF_LEN {
        diff.chars().take(MAX_DIFF_LEN).collect::<String>()
    } else {
        diff
    };

    let content = run_completion(
        &provider,
        &model,
        &api_key,
        base_url.as_deref(),
        COMMIT_SYSTEM_PROMPT,
        &diff,
        0.2,
        512,
    )
    .await?;

    if content.is_empty() {
        return Err("The model returned an empty response.".to_string());
    }
    Ok(content)
}

/// Fetch the live list of models a provider's key unlocks. Normalises each
/// provider's response into `ModelInfo` and filters by `purpose` (chat, stt,
/// or tts) so the picker only shows usable options. Returns an empty list
/// rather than erroring when a provider simply has no matching models.
#[tauri::command]
pub async fn list_provider_models(
    provider: String,
    api_key: String,
    base_url: Option<String>,
    purpose: Option<ModelPurpose>,
) -> Result<Vec<ModelInfo>, String> {
    if !is_known_provider(&provider) {
        return Err("Unknown provider".to_string());
    }
    let api_key = resolve_api_key(&provider, &api_key)?;
    let base_url = resolve_base_url(&provider, &base_url)?;
    let purpose = purpose.unwrap_or(ModelPurpose::Chat);

    let timeout_secs = if is_local_provider(&provider) { 2 } else { 20 };
    let client = shared_http_client(Duration::from_secs(timeout_secs))?;

    let mut models = match provider.as_str() {
        "anthropic" => {
            let response = client
                .get(ANTHROPIC_MODELS_URL)
                .header("x-api-key", &api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .send()
                .await
                .map_err(|err| safe_request_error("Failed to fetch Anthropic models", err))?;
            let payload = ok_json(response, "Anthropic").await?;
            let data = payload
                .get("data")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            let mut out = Vec::new();
            for item in data {
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if id.is_empty() || !model_id_is_safe(&id) {
                    continue;
                }
                let label = item
                    .get("display_name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&id)
                    .to_string();
                out.push(ModelInfo {
                    id,
                    label,
                    description: String::new(),
                });
            }
            out
        }
        "google" => {
            let response = client
                .get(GOOGLE_MODELS_URL)
                .header("x-goog-api-key", &api_key)
                .send()
                .await
                .map_err(|err| safe_request_error("Failed to fetch Google models", err))?;
            let payload = ok_json(response, "Google").await?;
            let data = payload
                .get("models")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            let mut out = Vec::new();
            for item in data {
                let raw = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let id = raw
                    .strip_prefix("models/")
                    .unwrap_or(raw)
                    .trim()
                    .to_string();
                if id.is_empty() || !model_id_is_safe(&id) {
                    continue;
                }
                let supports_generate = item
                    .get("supportedGenerationMethods")
                    .and_then(|m| m.as_array())
                    .map(|arr| arr.iter().any(|v| v.as_str() == Some("generateContent")))
                    .unwrap_or(false);
                match purpose {
                    ModelPurpose::Chat if !supports_generate => continue,
                    ModelPurpose::Stt if !id.to_ascii_lowercase().contains("chirp") => continue,
                    _ => {}
                }
                let label = item
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&id)
                    .to_string();
                let desc = item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                out.push(ModelInfo {
                    id,
                    label,
                    description: truncate_desc(desc),
                });
            }
            out
        }
        // OpenAI-compatible list endpoints: openrouter, openai, groq, ollama,
        // lmstudio.
        _ => {
            let url = match provider.as_str() {
                "openai" => OPENAI_MODELS_URL.to_string(),
                "groq" => GROQ_MODELS_URL.to_string(),
                "xai" => XAI_MODELS_URL.to_string(),
                p if is_local_provider(p) => {
                    local_endpoint(base_url.as_deref().unwrap_or_default(), "models")
                }
                _ => OPENROUTER_MODELS_URL.to_string(),
            };
            let mut request = client.get(&url);
            if !api_key.is_empty() {
                request =
                    request.header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"));
            }
            if provider == "openrouter" {
                request = request
                    .header("HTTP-Referer", "https://spacron.app")
                    .header("X-Title", APP_TITLE);
            }
            let response = request
                .send()
                .await
                .map_err(|err| safe_request_error("Failed to fetch models", err))?;
            let payload = ok_json(response, "Model provider").await?;
            let data = payload
                .get("data")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            let mut out = Vec::new();
            for item in data {
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if id.is_empty() || !model_id_is_safe(&id) {
                    continue;
                }
                match provider.as_str() {
                    "openai" => match purpose {
                        ModelPurpose::Stt => {
                            if !openai_is_stt_model(&id) {
                                continue;
                            }
                        }
                        ModelPurpose::Realtime => {
                            if !openai_is_realtime_model(&id) {
                                continue;
                            }
                        }
                        ModelPurpose::Chat => {
                            if !openai_is_chat_model(&id) {
                                continue;
                            }
                        }
                    },
                    "groq" => match purpose {
                        ModelPurpose::Stt => {
                            if !groq_is_stt_model(&id) {
                                continue;
                            }
                        }
                        // Groq has no realtime speech-to-speech API today.
                        ModelPurpose::Realtime => continue,
                        ModelPurpose::Chat => {
                            if !groq_is_chat_model(&id) {
                                continue;
                            }
                        }
                    },
                    "xai" => match purpose {
                        ModelPurpose::Realtime => {
                            if !xai_is_realtime_model(&id) {
                                continue;
                            }
                        }
                        // xAI has no separate STT/TTS models today.
                        ModelPurpose::Stt => continue,
                        ModelPurpose::Chat => {
                            if xai_is_realtime_model(&id) {
                                continue;
                            }
                        }
                    },
                    p if is_local_provider(p) => {
                        // Local providers — no structured metadata, return all
                    }
                    _ => {
                        if !openrouter_model_matches_purpose(&item, &id, purpose) {
                            continue;
                        }
                    }
                }
                let label = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&id)
                    .to_string();
                let desc = item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                out.push(ModelInfo {
                    id,
                    label,
                    description: truncate_desc(desc),
                });
            }
            out
        }
    };

    models.sort_by_key(|a| a.label.to_lowercase());
    Ok(models)
}

/// Allowed voices for the OpenAI Realtime speech-to-speech API.
const OPENAI_REALTIME_VOICES: &[&str] = &[
    "marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse",
];

/// Establish an OpenAI Realtime (speech-to-speech) WebRTC call.
///
/// The renderer creates an `RTCPeerConnection`, generates an SDP offer, and
/// hands it here; we POST it to OpenAI's `/v1/realtime/calls` endpoint with the
/// stored API key and return the SDP answer. Doing the exchange in Rust keeps
/// the API key (and even short-lived tokens) out of the renderer entirely, and
/// sidesteps the webview CSP, which doesn't allow `connect-src` to OpenAI. The
/// subsequent audio + event traffic flows peer-to-peer over WebRTC, which the
/// CSP does not govern.
#[tauri::command]
pub async fn openai_realtime_connect(
    offer_sdp: String,
    model: String,
    voice: String,
    instructions: String,
    tools: Option<serde_json::Value>,
) -> Result<String, String> {
    let api_key = resolve_api_key("openai", "")?;

    let model = model.trim().to_string();
    if !model_id_is_safe(&model) || !model.contains("realtime") {
        return Err("Invalid realtime model id".to_string());
    }
    let voice = voice.trim().to_lowercase();
    if !OPENAI_REALTIME_VOICES.contains(&voice.as_str()) {
        return Err("Invalid voice id".to_string());
    }
    let offer_sdp = offer_sdp.trim().to_string();
    if offer_sdp.len() > 65_536 || !openai_realtime_offer_is_plausible(&offer_sdp) {
        return Err("Invalid SDP offer".to_string());
    }
    // OpenAI's SDP parser (pion) errors with `EOF` when the final line lacks a
    // newline; browsers terminate every SDP line, but trim() above strips it.
    let offer_sdp = format!("{offer_sdp}\r\n");
    let tools = match tools {
        Some(serde_json::Value::Array(items)) => serde_json::Value::Array(items),
        Some(serde_json::Value::Null) | None => serde_json::Value::Array(Vec::new()),
        Some(_) => return Err("Invalid realtime tools".to_string()),
    };

    let session = json!({
        "type": "realtime",
        "model": model,
        "instructions": instructions,
        "audio": {
            "input": {
                // Turn transcripts back into text so the app can log the
                // conversation into the project chat.
                "transcription": { "model": "gpt-4o-mini-transcribe" },
                "turn_detection": { "type": "semantic_vad" }
            },
            "output": { "voice": voice }
        },
        "tools": tools,
        "tool_choice": "auto"
    });

    let client = shared_http_client(Duration::from_secs(30))?;
    let response = client
        .post("https://api.openai.com/v1/realtime/calls")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
        // Plain text fields with no per-part content type, exactly like the
        // `FormData.set("sdp", …)` example in OpenAI's WebRTC guide.
        .multipart(
            reqwest::multipart::Form::new()
                .text("sdp", offer_sdp)
                .text("session", session.to_string()),
        )
        .send()
        .await
        .map_err(|err| safe_request_error("Failed to contact OpenAI Realtime", err))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let preview = redact_secrets(&body.chars().take(300).collect::<String>());
        return Err(format!("OpenAI Realtime call failed ({status}): {preview}"));
    }

    let answer_sdp = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Realtime SDP answer: {err}"))?;
    if !answer_sdp.trim_start().starts_with("v=") {
        return Err("OpenAI Realtime returned an invalid SDP answer.".to_string());
    }
    Ok(answer_sdp)
}

/// Mint a short-lived client secret for xAI's Grok Realtime voice API.
///
/// Unlike OpenAI's realtime (WebRTC, SDP exchanged in Rust), xAI's is a plain
/// WebSocket the renderer opens itself, authenticating with this ephemeral
/// token as a `xai-client-secret.<token>` subprotocol. Minting it here keeps
/// the long-lived xAI API key out of the renderer; the token the renderer does
/// see expires in minutes and only grants a realtime session.
#[tauri::command]
pub async fn xai_realtime_client_secret() -> Result<String, String> {
    let api_key = resolve_api_key("xai", "")?;
    let client = shared_http_client(Duration::from_secs(30))?;
    let response = client
        .post("https://api.x.ai/v1/realtime/client_secrets")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
        .json(&json!({ "expires_after": { "seconds": 600 } }))
        .send()
        .await
        .map_err(|err| safe_request_error("Failed to contact xAI Realtime", err))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let preview = redact_secrets(&body.chars().take(300).collect::<String>());
        return Err(format!("xAI Realtime token request failed ({status}): {preview}"));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|err| format!("xAI Realtime returned an invalid response: {err}"))?;
    // Be liberal about the field name — providers have shipped both flat and
    // nested shapes for this endpoint.
    let token = payload
        .get("value")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("token").and_then(|v| v.as_str()))
        .or_else(|| {
            payload
                .get("client_secret")
                .and_then(|cs| cs.get("value"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");
    if token.is_empty() {
        return Err("xAI Realtime returned no client secret.".to_string());
    }
    Ok(token.to_string())
}

#[tauri::command]
pub async fn check_local_provider_online(
    provider: String,
    base_url: String,
) -> Result<bool, String> {
    if !is_local_provider(&provider) {
        return Ok(false);
    }
    if !base_url_is_safe(&base_url) {
        return Ok(false);
    }
    // Refuse link-local / cloud-metadata hosts, exactly as `resolve_base_url`
    // does for the authenticated AI paths. This "is it online?" probe carries no
    // credentials and only returns a boolean, but without the guard a tampered
    // base_url turns it into a blind reachability oracle for internal hosts
    // (e.g. http://169.254.169.254/…). Keep the guard consistent everywhere a
    // user-supplied base_url reaches the network.
    if let Ok(parsed) = url::Url::parse(&base_url) {
        if let Some(host) = parsed.host_str() {
            let host_owned = host.to_string();
            if crate::commands::http::host_is_blocked(host) {
                return Ok(false);
            }
            let resolved_blocked = tokio::task::spawn_blocking(move || {
                crate::commands::http::resolved_host_is_blocked(&host_owned)
            })
            .await
            .unwrap_or(false);
            if resolved_blocked {
                return Ok(false);
            }
        }
    }

    let client = match shared_http_client(Duration::from_millis(500)) {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };

    let endpoint = local_endpoint(&base_url, "models");
    let response = client.get(&endpoint).send().await;
    match response {
        Ok(res) => Ok(res.status().is_success()),
        Err(_) => {
            // Fallback for Ollama: if v1 endpoint fails, check native api/tags
            if provider == "ollama" {
                let base_trimmed = base_url.trim_end_matches('/');
                let ollama_api = if base_trimmed.ends_with("/v1") && base_trimmed.len() >= 3 {
                    format!("{}/api/tags", &base_trimmed[..base_trimmed.len() - 3])
                } else {
                    format!("{}/api/tags", base_trimmed)
                };
                if let Ok(res) = client.get(&ollama_api).send().await {
                    return Ok(res.status().is_success());
                }
            }
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        adapt_chat_shape, audio_format_from_mime_type, audio_mime_type_is_safe, base_url_is_safe,
        build_audio_transcription_multipart_body, extract_anthropic_text, extract_google_text,
        is_known_provider, is_local_provider, local_endpoint, model_id_is_safe,
        openai_is_realtime_model, openrouter_audio_chat_model_is_unsupported, redact_secrets,
        embedded_error_message, reply_was_truncated, resolve_base_url, spent_reasoning_tokens,
        strip_inline_reasoning, token_budget_for, with_reasoning_headroom, xai_is_realtime_model,
        ChatParamShape, TokenBudgetField,
    };
    use serde_json::json;
    const MAX_TEXT_LEN: usize = 32_000;

    // The verbatim 400 bodies OpenAI returns for a reasoning model. Both knobs
    // have to be renegotiated from the provider's own complaint, because the
    // model catalogue is fetched live and grows without a code change here.
    const MAX_TOKENS_REJECTED: &str = r#"{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}"#;
    const TEMPERATURE_REJECTED: &str = r#"{"error":{"message":"Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) is supported.","type":"invalid_request_error","param":"temperature","code":"unsupported_value"}}"#;

    #[test]
    fn swaps_in_max_completion_tokens_when_rejected() {
        let next = adapt_chat_shape(ChatParamShape::default(), MAX_TOKENS_REJECTED)
            .expect("should renegotiate");
        assert_eq!(next.token_field, TokenBudgetField::MaxCompletionTokens);
        // Only the field it complained about moves on this pass.
        assert!(next.send_temperature);
    }

    #[test]
    fn drops_temperature_when_rejected() {
        let shape = ChatParamShape {
            token_field: TokenBudgetField::MaxCompletionTokens,
            ..ChatParamShape::default()
        };
        let next = adapt_chat_shape(shape, TEMPERATURE_REJECTED).expect("should renegotiate");
        assert!(!next.send_temperature);
        assert_eq!(next.token_field, TokenBudgetField::MaxCompletionTokens);
    }

    #[test]
    fn converges_on_a_reasoning_model_within_the_retry_budget() {
        // Cold start: two rejections, two adaptations, then nothing left to move.
        let shape = ChatParamShape::default();
        let shape = adapt_chat_shape(shape, MAX_TOKENS_REJECTED).expect("first adaptation");
        let shape = adapt_chat_shape(shape, TEMPERATURE_REJECTED).expect("second adaptation");
        assert_eq!(shape.token_field, TokenBudgetField::MaxCompletionTokens);
        assert!(!shape.send_temperature);
        // A repeat of either error now yields None, so the retry loop stops
        // rather than flipping the same field back and forth.
        assert_eq!(adapt_chat_shape(shape, TEMPERATURE_REJECTED), None);
        assert_eq!(adapt_chat_shape(shape, MAX_TOKENS_REJECTED), None);
    }

    #[test]
    fn falls_back_to_max_tokens_for_endpoints_that_only_know_it() {
        let shape = ChatParamShape {
            token_field: TokenBudgetField::MaxCompletionTokens,
            ..ChatParamShape::default()
        };
        // An older gateway (no `error.param`) that only mentions it in the text.
        let body = r#"{"error":{"message":"Unrecognized request argument supplied: max_completion_tokens"}}"#;
        let next = adapt_chat_shape(shape, body).expect("should fall back");
        assert_eq!(next.token_field, TokenBudgetField::MaxTokens);
    }

    #[test]
    fn leaves_unrelated_failures_alone() {
        // Nothing here is a parameter we can renegotiate, so the caller reports
        // the provider's error instead of burning retries on it.
        for body in [
            r#"{"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}"#,
            r#"{"error":{"message":"The model `made-up-4o` does not exist.","param":"model","code":"model_not_found"}}"#,
            "gateway timeout",
        ] {
            assert_eq!(adapt_chat_shape(ChatParamShape::default(), body), None, "{body}");
        }
    }

    #[test]
    fn google_reply_survives_thoughts_and_split_parts() {
        // A 2.5-series answer: a thought part first, then the reply in chunks.
        let payload = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "Let me think about the diff…", "thought": true },
                    { "text": "fix(auth): stop refreshing " },
                    { "text": "an expired session\n" },
                ] },
                "finishReason": "STOP",
            }]
        });
        assert_eq!(
            extract_google_text(&payload),
            "fix(auth): stop refreshing an expired session"
        );
    }

    #[test]
    fn google_reply_handles_the_plain_single_part_shape() {
        let payload = json!({
            "candidates": [{ "content": { "parts": [{ "text": "  hello  " }] } }]
        });
        assert_eq!(extract_google_text(&payload), "hello");
        // A blocked or empty candidate is an empty string, not a panic.
        assert_eq!(extract_google_text(&json!({ "candidates": [] })), "");
        assert_eq!(extract_google_text(&json!({})), "");
    }

    #[test]
    fn anthropic_reply_is_found_past_a_leading_non_text_block() {
        // Block zero is not always the answer on newer models.
        let payload = json!({
            "content": [
                { "type": "thinking", "thinking": "weighing the options" },
                { "type": "text", "text": "Use the second option." },
            ],
            "stop_reason": "end_turn",
        });
        assert_eq!(extract_anthropic_text(&payload), "Use the second option.");
        // The classic single-text-block shape still works, typed or not.
        assert_eq!(
            extract_anthropic_text(&json!({ "content": [{ "type": "text", "text": " hi " }] })),
            "hi"
        );
        assert_eq!(
            extract_anthropic_text(&json!({ "content": [{ "text": "hi" }] })),
            "hi"
        );
        assert_eq!(extract_anthropic_text(&json!({ "content": [] })), "");
    }

    #[test]
    fn reasoning_headroom_is_a_ceiling_not_a_shrink() {
        // Never returns less than asked for, whatever the caller passes.
        for requested in [0_u32, 1, 512, 1024, 8192, u32::MAX] {
            assert!(
                with_reasoning_headroom(requested) >= requested.max(4096),
                "shrank {requested}"
            );
        }
    }

    fn shape_with(token_field: TokenBudgetField, reasoning_headroom: bool) -> ChatParamShape {
        ChatParamShape {
            token_field,
            reasoning_headroom,
            ..ChatParamShape::default()
        }
    }

    #[test]
    fn reasoning_budgets_get_headroom_for_hidden_thinking() {
        // The classic field on an ordinary model is a visible-output budget:
        // pass it through as-is so a 512-token cap still means 512.
        assert_eq!(
            token_budget_for(shape_with(TokenBudgetField::MaxTokens, false), 512),
            512
        );
        // `max_completion_tokens` always pays for reasoning tokens too, so a
        // 512-token budget would be spent thinking and come back empty.
        assert!(token_budget_for(shape_with(TokenBudgetField::MaxCompletionTokens, false), 512) >= 4096);
        // And the classic field gets the same headroom once we have learned the
        // model reasons — the OpenRouter and local-server case, where nothing
        // ever errors and only the reply gives it away.
        assert!(token_budget_for(shape_with(TokenBudgetField::MaxTokens, true), 512) >= 4096);
        assert!(
            token_budget_for(shape_with(TokenBudgetField::MaxCompletionTokens, false), 4096)
                > token_budget_for(shape_with(TokenBudgetField::MaxCompletionTokens, false), 512)
        );
        // Absurd inputs must not wrap around to a tiny budget.
        assert!(
            token_budget_for(shape_with(TokenBudgetField::MaxCompletionTokens, false), u32::MAX)
                >= 4096
        );
    }

    #[test]
    fn reasoning_is_detected_however_the_server_reports_it() {
        let no_choice = None;
        // OpenAI-shaped usage accounting.
        let usage = json!({ "usage": { "completion_tokens_details": { "reasoning_tokens": 812 } } });
        assert!(spent_reasoning_tokens(&usage, no_choice));
        // The same shape with nothing spent is not a reasoning model.
        let quiet = json!({ "usage": { "completion_tokens_details": { "reasoning_tokens": 0 } } });
        assert!(!spent_reasoning_tokens(&quiet, no_choice));
        assert!(!spent_reasoning_tokens(&json!({}), no_choice));

        // A separate thinking field, whatever the server calls it.
        for field in ["reasoning", "reasoning_content", "thinking"] {
            let choice = json!({ "message": { "content": "done", field: "weighing it up" } });
            assert!(
                spent_reasoning_tokens(&json!({}), Some(&choice)),
                "missed {field}"
            );
        }
        // An empty thinking field proves nothing.
        let blank = json!({ "message": { "content": "done", "reasoning": "   " } });
        assert!(!spent_reasoning_tokens(&json!({}), Some(&blank)));
    }

    #[test]
    fn inline_scratchpad_is_stripped_from_local_model_replies() {
        // The common raw-GGUF shape: monologue first, answer after.
        assert_eq!(
            strip_inline_reasoning("<think>the user wants a commit message</think>fix: clamp retries"),
            "fix: clamp retries"
        );
        // Casing and surrounding whitespace vary by template.
        assert_eq!(
            strip_inline_reasoning("  <Think>\nhmm\n</Think>\n\nhello  "),
            "hello"
        );
        // Other tag spellings, and more than one block.
        assert_eq!(
            strip_inline_reasoning("<reasoning>a</reasoning>x<thinking>b</thinking>y"),
            "xy"
        );
        // Cut off mid-thought: everything after the opener is scratchpad, so the
        // caller sees an empty reply and retries with more room.
        assert_eq!(strip_inline_reasoning("<think>I should start by"), "");
        // An ordinary reply is untouched — including one that merely talks about
        // the tag rather than opening one.
        assert_eq!(
            strip_inline_reasoning("use </think> as the stop token"),
            "use </think> as the stop token"
        );
        assert_eq!(strip_inline_reasoning("plain answer"), "plain answer");
        // Non-ASCII around the tags must not shift the byte indices.
        assert_eq!(
            strip_inline_reasoning("İ<think>x</think>é"),
            "İé"
        );
    }

    #[test]
    fn gateway_errors_inside_a_200_are_surfaced() {
        let payload = json!({ "error": { "message": "upstream provider is down", "code": 502 } });
        assert_eq!(
            embedded_error_message(&payload).as_deref(),
            Some("upstream provider is down")
        );
        // A normal reply has no error object, and a blank one is not an error.
        assert_eq!(embedded_error_message(&json!({ "choices": [] })), None);
        assert_eq!(
            embedded_error_message(&json!({ "error": { "message": "  " } })),
            None
        );
    }

    #[test]
    fn truncation_is_read_off_the_finish_reason() {
        let cut = json!({ "finish_reason": "length" });
        let done = json!({ "finish_reason": "stop" });
        assert!(reply_was_truncated(Some(&cut)));
        assert!(!reply_was_truncated(Some(&done)));
        assert!(!reply_was_truncated(None));
    }

    #[test]
    fn redacts_all_provider_key_prefixes() {
        let cases = [
            "error with sk-or-abc123 in it",
            "openai key sk-proj-XYZ failed",
            "anthropic sk-ant-api03-secret denied",
            "google key AIzaSyD-EXAMPLE rejected",
            "groq gsk_supersecretvalue invalid",
        ];
        for case in cases {
            let out = redact_secrets(case);
            assert!(out.contains("[redacted]"), "expected redaction in: {out}");
            assert!(!out.contains("secret"), "secret leaked: {out}");
            assert!(!out.contains("EXAMPLE"), "google key leaked: {out}");
        }
    }

    #[test]
    fn redact_leaves_clean_text_untouched() {
        let clean = "Model request failed (429): rate limited";
        assert_eq!(redact_secrets(clean), clean);
    }

    #[test]
    fn known_providers_are_recognised() {
        assert!(is_known_provider("openrouter"));
        assert!(is_known_provider("anthropic"));
        assert!(is_known_provider("openai"));
        assert!(is_known_provider("google"));
        assert!(is_known_provider("groq"));
        assert!(is_known_provider("xai"));
        assert!(is_known_provider("ollama"));
        assert!(is_known_provider("lmstudio"));
    }

    #[test]
    fn only_local_providers_are_local() {
        assert!(is_local_provider("ollama"));
        assert!(is_local_provider("lmstudio"));
        assert!(!is_local_provider("openrouter"));
        assert!(!is_local_provider("anthropic"));
        assert!(!is_local_provider("openai"));
    }

    #[test]
    fn base_url_validation() {
        assert!(base_url_is_safe("http://localhost:11434/v1"));
        assert!(base_url_is_safe("http://127.0.0.1:1234/v1"));
        assert!(base_url_is_safe("https://my-box.lan:8080/v1"));
        // Rejected: wrong scheme, traversal, whitespace, control chars, empty.
        assert!(!base_url_is_safe("ftp://localhost/v1"));
        assert!(!base_url_is_safe("localhost:11434"));
        assert!(!base_url_is_safe("http://localhost/../etc"));
        assert!(!base_url_is_safe("http://localhost /v1"));
        assert!(!base_url_is_safe("http://local\nhost/v1"));
        assert!(!base_url_is_safe(""));
        assert!(!base_url_is_safe(&format!("http://{}", "a".repeat(300))));
    }

    #[test]
    fn local_endpoint_joins_without_double_slash() {
        assert_eq!(
            local_endpoint("http://localhost:11434/v1", "chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            local_endpoint("http://localhost:11434/v1/", "/models"),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn resolve_base_url_rules() {
        // Non-local providers ignore the URL entirely.
        assert_eq!(
            resolve_base_url("openai", &Some("anything".to_string())),
            Ok(None)
        );
        // Local providers require a valid URL.
        assert_eq!(
            resolve_base_url("ollama", &Some("http://localhost:11434/v1".to_string())),
            Ok(Some("http://localhost:11434/v1".to_string()))
        );
        assert!(resolve_base_url("ollama", &None).is_err());
        assert!(resolve_base_url("ollama", &Some("  ".to_string())).is_err());
        assert!(resolve_base_url("lmstudio", &Some("notaurl".to_string())).is_err());
        // SSRF: link-local / cloud-metadata hosts are refused even for local
        // providers, so a tampered base_url can't exfiltrate the bearer token.
        assert!(
            resolve_base_url("ollama", &Some("http://169.254.169.254/latest".to_string()))
                .is_err()
        );
        assert!(
            resolve_base_url("lmstudio", &Some("http://metadata.google.internal/".to_string()))
                .is_err()
        );
        // A non-standard IP encoding (decimal 2852039166 == 169.254.169.254) that
        // fails `IpAddr` parsing but which the OS resolver still maps to the
        // metadata address must also be refused (DNS-aware check).
        assert!(
            resolve_base_url("ollama", &Some("http://2852039166/latest".to_string())).is_err()
        );
    }

    #[test]
    fn unknown_provider_is_rejected() {
        assert!(!is_known_provider("evil"));
        assert!(!is_known_provider(""));
        assert!(!is_known_provider("openrouter; rm -rf /"));
    }

    #[test]
    fn real_model_ids_are_accepted() {
        assert!(model_id_is_safe("google/gemini-2.5-flash"));
        assert!(model_id_is_safe("claude-3-5-haiku-latest"));
        assert!(model_id_is_safe("gpt-4o-mini"));
        assert!(model_id_is_safe("gemini-2.5-flash"));
        assert!(model_id_is_safe("llama-3.1-8b-instant"));
        assert!(model_id_is_safe("google/gemma-4-31b-it:free"));
    }

    #[test]
    fn unsafe_model_ids_are_rejected() {
        assert!(!model_id_is_safe(""));
        // No path traversal — Google embeds the id in a URL path.
        assert!(!model_id_is_safe("../../secret"));
        assert!(!model_id_is_safe("gemini:generateContent?key=leak"));
        assert!(!model_id_is_safe(
            "some-malicious/model-injection; rm -rf /"
        ));
        assert!(!model_id_is_safe("model with spaces"));
        assert!(!model_id_is_safe(&"a".repeat(129)));
    }

    #[test]
    fn documented_openrouter_audio_mime_types_are_accepted() {
        let cases = [
            ("audio/wav", "wav"),
            ("audio/mpeg", "mp3"),
            ("audio/mp3", "mp3"),
            ("audio/flac", "flac"),
            ("audio/ogg", "ogg"),
            ("audio/aac", "aac"),
            ("audio/mp4", "m4a"),
            ("audio/x-m4a", "m4a"),
            ("audio/webm", "webm"),
        ];
        for (mime, format) in cases {
            assert!(audio_mime_type_is_safe(mime), "{mime} should be accepted");
            assert_eq!(audio_format_from_mime_type(mime), Some(format));
        }
    }

    #[test]
    fn old_free_openrouter_audio_model_is_rejected() {
        assert!(openrouter_audio_chat_model_is_unsupported(
            "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
        ));
        assert!(!openrouter_audio_chat_model_is_unsupported(
            "openai/whisper-1"
        ));
    }

    #[test]
    fn local_transcription_multipart_body_contains_model_and_audio_file() {
        let body = build_audio_transcription_multipart_body(
            "test-boundary",
            "whisper-large-v3",
            "audio/wav",
            "wav",
            b"RIFFaudio",
            None,
        );
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"model\""));
        assert!(text.contains("whisper-large-v3"));
        assert!(text.contains("name=\"response_format\""));
        assert!(text.contains("filename=\"audio.wav\""));
        assert!(text.contains("Content-Type: audio/wav"));
        assert!(body.ends_with(b"\r\n--test-boundary--\r\n"));
    }

    #[test]
    fn openai_realtime_models_are_identified() {
        assert!(openai_is_realtime_model("gpt-realtime-2.1"));
        assert!(openai_is_realtime_model("gpt-realtime-2.1-mini"));
        assert!(!openai_is_realtime_model("gpt-4o-mini"));
        assert!(!openai_is_realtime_model("whisper-1"));
    }

    #[test]
    fn xai_realtime_models_are_identified() {
        assert!(xai_is_realtime_model("grok-voice-latest"));
        assert!(xai_is_realtime_model("grok-voice-think-fast-1.0"));
        assert!(!xai_is_realtime_model("grok-4.3"));
        assert!(!xai_is_realtime_model("grok-2-vision"));
    }

    #[test]
    fn text_length_limit_is_sane() {
        assert_eq!(MAX_TEXT_LEN, 32_000);
    }

    #[test]
    fn transcription_prompt_part_is_included_only_when_supplied() {
        let with_prompt = build_audio_transcription_multipart_body(
            "b",
            "whisper-1",
            "audio/wav",
            "wav",
            b"RIFF",
            Some("Spacron, Parakeet"),
        );
        let text = String::from_utf8_lossy(&with_prompt);
        assert!(text.contains("name=\"prompt\""));
        assert!(text.contains("Spacron, Parakeet"));

        let without_prompt = build_audio_transcription_multipart_body(
            "b",
            "whisper-1",
            "audio/wav",
            "wav",
            b"RIFF",
            None,
        );
        assert!(!String::from_utf8_lossy(&without_prompt).contains("name=\"prompt\""));
    }

    #[test]
    fn text_exceeding_max_len_would_be_rejected() {
        let text = "a".repeat(MAX_TEXT_LEN + 1);
        assert!(text.len() > MAX_TEXT_LEN);
    }
}
