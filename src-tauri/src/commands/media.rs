//! Image and video generation on API-key providers: OpenAI, Google, OpenRouter,
//! Vercel AI Gateway, fal and Replicate. The ChatGPT-plan path lives in `chatgpt::generate_image`;
//! `images::generate_media` picks between them and saves the result.
//!
//! Every function returns the finished file's bytes. Errors carry the same
//! `kind: message` prefixes as the brain providers, and a spent balance or
//! plan limit is always `quota:` so the chat can tell the user plainly.

use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

pub const PROVIDERS: &[&str] = &["chatgpt", "openai", "google", "openrouter", "vercel", "fal", "replicate"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Image,
    Video,
}

impl Kind {
    pub fn parse(raw: &str) -> Result<Kind, String> {
        match raw {
            "image" => Ok(Kind::Image),
            "video" => Ok(Kind::Video),
            _ => Err(format!("unknown media kind: {raw}")),
        }
    }
}

pub struct Media {
    pub bytes: Vec<u8>,
    /// File extension without the dot (`png`, `jpg`, `webp`, `mp4`).
    pub extension: String,
    pub revised_prompt: Option<String>,
}

/// A video render routinely takes minutes; polling stops after this.
const VIDEO_DEADLINE: Duration = Duration::from_secs(15 * 60);
const IMAGE_DEADLINE: Duration = Duration::from_secs(5 * 60);
const POLL_EVERY: Duration = Duration::from_secs(4);

/// The model used when the user has not picked one in Settings.
pub fn default_model(provider: &str, kind: Kind) -> Option<&'static str> {
    Some(match (provider, kind) {
        ("openai", Kind::Image) => "gpt-image-1",
        ("openai", Kind::Video) => "sora-2",
        ("google", Kind::Image) => "gemini-2.5-flash-image",
        ("google", Kind::Video) => "veo-3.0-fast-generate-001",
        ("openrouter", Kind::Image) => "google/gemini-2.5-flash-image",
        ("vercel", Kind::Image) => "openai/gpt-image-2",
        ("vercel", Kind::Video) => "google/veo-3.1-fast-generate-001",
        ("fal", Kind::Image) => "fal-ai/nano-banana",
        ("fal", Kind::Video) => "fal-ai/veo3/fast",
        ("replicate", Kind::Image) => "black-forest-labs/flux-schnell",
        ("replicate", Kind::Video) => "google/veo-3-fast",
        _ => return None,
    })
}

fn provider_label(provider: &str) -> String {
    match provider {
        "openai" => "OpenAI",
        "google" => "Google",
        "openrouter" => "OpenRouter",
        "vercel" => "Vercel AI Gateway",
        "fal" => "fal",
        "replicate" => "Replicate",
        custom => {
            return crate::commands::custom_providers::display_name(custom)
                .unwrap_or_else(|| "The provider".to_string())
        }
    }
    .to_string()
}

const OPENAI_BASE: &str = "https://api.openai.com/v1";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(|e| format!("network: {e}"))
}

/// Classify a failed HTTP response into the app's error prefixes. Balance and
/// rate-limit wording differs per provider, so it is matched loosely.
fn http_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
    let label = provider_label(provider);
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["message"].as_str().map(str::to_string)
                .or_else(|| v["error"].as_str().map(str::to_string))
                .or_else(|| v["detail"].as_str().map(str::to_string))
                .or_else(|| v["detail"][0]["msg"].as_str().map(str::to_string))
                .or_else(|| v["message"].as_str().map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let lower = message.to_lowercase();
    let quota = status.as_u16() == 402
        || ["insufficient_quota", "quota", "credit", "balance", "billing", "exhausted", "payment", "spend limit"]
            .iter()
            .any(|word| lower.contains(word));
    let kind = if quota {
        "quota"
    } else if status.as_u16() == 401 || status.as_u16() == 403 {
        "auth"
    } else if status.as_u16() == 429 {
        "rate_limit"
    } else if status.as_u16() == 404 {
        "model_not_found"
    } else {
        "provider_error"
    };
    let message = if message.trim().is_empty() { format!("HTTP {status}") } else { message };
    if kind == "quota" {
        format!("quota: {label}: your credit or plan limit for generation is used up ({message})")
    } else {
        format!("{kind}: {label}: {message}")
    }
}

async fn send_json(provider: &str, request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| format!("network: {}: {e}", provider_label(provider)))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("network: {e}"))?;
    if !status.is_success() {
        return Err(http_error(provider, status, &body));
    }
    serde_json::from_str(&body).map_err(|_| format!("protocol: {} returned an unreadable reply", provider_label(provider)))
}

async fn download(provider: &str, request: reqwest::RequestBuilder) -> Result<Vec<u8>, String> {
    let response = request.send().await.map_err(|e| format!("network: {}: {e}", provider_label(provider)))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(http_error(provider, status, &body));
    }
    response.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("network: {e}"))
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    }
}

struct Reference {
    mime: &'static str,
    base64: String,
    bytes: Vec<u8>,
    name: String,
}

impl Reference {
    fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, self.base64)
    }
}

fn load_references(paths: &[PathBuf]) -> Result<Vec<Reference>, String> {
    paths
        .iter()
        .map(|path| {
            let bytes = std::fs::read(path).map_err(|e| format!("could not read reference image {}: {e}", path.display()))?;
            Ok(Reference {
                mime: mime_for(path),
                base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                name: path.file_name().and_then(|n| n.to_str()).unwrap_or("reference.png").to_string(),
                bytes,
            })
        })
        .collect()
}

fn decode_b64(provider: &str, data: &str) -> Result<Vec<u8>, String> {
    let data = data.split_once(";base64,").map(|(_, d)| d).unwrap_or(data);
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| format!("protocol: {} returned an image that was not valid base64", provider_label(provider)))
}

fn extension_from_mime(mime: &str, fallback: &str) -> String {
    match mime {
        m if m.contains("jpeg") || m.contains("jpg") => "jpg",
        m if m.contains("webp") => "webp",
        m if m.contains("png") => "png",
        m if m.contains("mp4") => "mp4",
        m if m.contains("webm") => "webm",
        _ => fallback,
    }
    .to_string()
}

fn extension_from_url(url: &str, fallback: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()) {
        Some(e) if ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov"].contains(&e.as_str()) => {
            if e == "jpeg" { "jpg".into() } else { e }
        }
        _ => fallback.to_string(),
    }
}

/// Generate one image or video. `model` empty means the provider's default.
pub async fn generate(
    provider: &str,
    kind: Kind,
    model: &str,
    prompt: &str,
    references: &[PathBuf],
    api_key: &str,
) -> Result<Media, String> {
    let custom_base = crate::commands::custom_providers::base_url(provider);
    let model = if model.trim().is_empty() {
        if custom_base.is_some() {
            // A custom provider has no model we could safely guess.
            return Err(format!(
                "not_configured: pick {} model for {} in Settings > AI Connections",
                if kind == Kind::Video { "a video" } else { "an image" },
                provider_label(provider)
            ));
        }
        default_model(provider, kind).ok_or_else(|| unsupported(provider, kind))?.to_string()
    } else {
        model.trim().to_string()
    };
    let refs = load_references(references)?;
    let deadline = if kind == Kind::Video { VIDEO_DEADLINE } else { IMAGE_DEADLINE };
    let work = async {
        match (provider, kind) {
            // A custom provider speaks OpenAI's image and video routes at its own base URL.
            (p, Kind::Image) if custom_base.is_some() => {
                openai_image(custom_base.as_deref().unwrap_or_default(), p, api_key, &model, prompt, &refs).await
            }
            (p, Kind::Video) if custom_base.is_some() => {
                openai_video(custom_base.as_deref().unwrap_or_default(), p, api_key, &model, prompt, &refs).await
            }
            ("openai", Kind::Image) => openai_image(OPENAI_BASE, "openai", api_key, &model, prompt, &refs).await,
            ("openai", Kind::Video) => openai_video(OPENAI_BASE, "openai", api_key, &model, prompt, &refs).await,
            ("google", Kind::Image) => google_image(api_key, &model, prompt, &refs).await,
            ("google", Kind::Video) => google_video(api_key, &model, prompt, &refs).await,
            ("openrouter", Kind::Image) => openrouter_image(api_key, &model, prompt, &refs).await,
            ("vercel", Kind::Image) => vercel_image(api_key, &model, prompt, &refs).await,
            ("vercel", Kind::Video) => vercel_video(api_key, &model, prompt, &refs).await,
            ("fal", _) => fal(api_key, &model, kind, prompt, &refs).await,
            ("replicate", _) => replicate(api_key, &model, kind, prompt, &refs).await,
            _ => Err(unsupported(provider, kind)),
        }
    };
    tokio::time::timeout(deadline, work)
        .await
        .map_err(|_| format!("timeout: {} did not finish the {} in time", provider_label(provider), if kind == Kind::Video { "video" } else { "image" }))?
}

fn unsupported(provider: &str, kind: Kind) -> String {
    match kind {
        Kind::Video => format!("unsupported: {} cannot generate videos. Pick Google, OpenAI, Vercel AI Gateway, fal or Replicate for video in Settings > AI Connections.", provider_label(provider)),
        Kind::Image => format!("unsupported: {} cannot generate images.", provider_label(provider)),
    }
}

// ---------------------------------------------------------------------------
// OpenAI: gpt-image for images, Sora for video.
// ---------------------------------------------------------------------------

async fn openai_image(base: &str, who: &str, key: &str, model: &str, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let reply = if refs.is_empty() {
        send_json(who, http
            .post(format!("{base}/images/generations"))
            .bearer_auth(key)
            .json(&json!({"model": model, "prompt": prompt, "n": 1}))).await?
    } else {
        let mut form = reqwest::multipart::Form::new()
            .text("model", model.to_string())
            .text("prompt", prompt.to_string());
        for r in refs {
            let part = reqwest::multipart::Part::bytes(r.bytes.clone())
                .file_name(r.name.clone())
                .mime_str(r.mime)
                .map_err(|e| e.to_string())?;
            form = form.part("image[]", part);
        }
        send_json(who, http.post(format!("{base}/images/edits")).bearer_auth(key).multipart(form)).await?
    };
    let item = &reply["data"][0];
    let bytes = if let Some(b64) = item["b64_json"].as_str() {
        decode_b64(who, b64)?
    } else if let Some(url) = item["url"].as_str() {
        download(who, http.get(url)).await?
    } else {
        return Err(format!("provider_error: {} returned no image", provider_label(who)));
    };
    Ok(Media { bytes, extension: "png".into(), revised_prompt: item["revised_prompt"].as_str().map(str::to_string) })
}

async fn openai_video(base: &str, who: &str, key: &str, model: &str, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .text("prompt", prompt.to_string());
    if let Some(r) = refs.first() {
        let part = reqwest::multipart::Part::bytes(r.bytes.clone())
            .file_name(r.name.clone())
            .mime_str(r.mime)
            .map_err(|e| e.to_string())?;
        form = form.part("input_reference", part);
    }
    let job = send_json(who, http.post(format!("{base}/videos")).bearer_auth(key).multipart(form)).await?;
    let id = job["id"]
        .as_str()
        .ok_or_else(|| format!("protocol: {} returned no video id", provider_label(who)))?
        .to_string();
    // The id goes into a URL path, so only a plain token is accepted.
    if id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("protocol: {} returned an unexpected video id", provider_label(who)));
    }
    loop {
        let status = send_json(who, http.get(format!("{base}/videos/{id}")).bearer_auth(key)).await?;
        match status["status"].as_str().unwrap_or("") {
            "completed" => break,
            "failed" | "cancelled" => {
                let message = status["error"]["message"].as_str().unwrap_or("the video failed");
                return Err(format!("provider_error: {}: {message}", provider_label(who)));
            }
            _ => tokio::time::sleep(POLL_EVERY).await,
        }
    }
    let bytes = download(who, http.get(format!("{base}/videos/{id}/content")).bearer_auth(key)).await?;
    Ok(Media { bytes, extension: "mp4".into(), revised_prompt: None })
}

// ---------------------------------------------------------------------------
// Google: Gemini image models or Imagen for images, Veo for video.
// ---------------------------------------------------------------------------

const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

async fn google_image(key: &str, model: &str, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    if model.starts_with("imagen") {
        if !refs.is_empty() {
            return Err("unsupported: Imagen models cannot take reference images; pick a Gemini image model such as gemini-2.5-flash-image".into());
        }
        let reply = send_json("google", http
            .post(format!("{GEMINI_BASE}/models/{model}:predict"))
            .header("x-goog-api-key", key)
            .json(&json!({"instances": [{"prompt": prompt}], "parameters": {"sampleCount": 1}}))).await?;
        let prediction = &reply["predictions"][0];
        let data = prediction["bytesBase64Encoded"].as_str().ok_or("provider_error: Google returned no image (the prompt may have been blocked)")?;
        let mime = prediction["mimeType"].as_str().unwrap_or("image/png");
        return Ok(Media { bytes: decode_b64("google", data)?, extension: extension_from_mime(mime, "png"), revised_prompt: None });
    }
    let mut parts = vec![json!({"text": prompt})];
    for r in refs {
        parts.push(json!({"inline_data": {"mime_type": r.mime, "data": r.base64}}));
    }
    let reply = send_json("google", http
        .post(format!("{GEMINI_BASE}/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&json!({"contents": [{"role": "user", "parts": parts}], "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}}))).await?;
    let found = reply["candidates"][0]["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|part| {
            let inline = part.get("inlineData").or_else(|| part.get("inline_data"))?;
            Some((inline["data"].as_str()?.to_string(), inline.get("mimeType").or_else(|| inline.get("mime_type")).and_then(Value::as_str).unwrap_or("image/png").to_string()))
        });
    let Some((data, mime)) = found else {
        let reason = reply["candidates"][0]["finishReason"].as_str().or(reply["promptFeedback"]["blockReason"].as_str()).unwrap_or("no image in the reply");
        return Err(format!("provider_error: Google did not return an image ({reason})"));
    };
    Ok(Media { bytes: decode_b64("google", &data)?, extension: extension_from_mime(&mime, "png"), revised_prompt: None })
}

async fn google_video(key: &str, model: &str, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let mut instance = json!({"prompt": prompt});
    if let Some(r) = refs.first() {
        instance["image"] = json!({"bytesBase64Encoded": r.base64, "mimeType": r.mime});
    }
    let op = send_json("google", http
        .post(format!("{GEMINI_BASE}/models/{model}:predictLongRunning"))
        .header("x-goog-api-key", key)
        .json(&json!({"instances": [instance]}))).await?;
    let name = op["name"].as_str().ok_or("protocol: Google returned no operation name")?.to_string();
    let done = loop {
        let status = send_json("google", http.get(format!("{GEMINI_BASE}/{name}")).header("x-goog-api-key", key)).await?;
        if status["done"].as_bool().unwrap_or(false) {
            break status;
        }
        tokio::time::sleep(POLL_EVERY).await;
    };
    if let Some(message) = done["error"]["message"].as_str() {
        return Err(if message.to_lowercase().contains("quota") { format!("quota: Google: {message}") } else { format!("provider_error: Google: {message}") });
    }
    let sample = &done["response"]["generateVideoResponse"]["generatedSamples"][0]["video"];
    if let Some(data) = sample["bytesBase64Encoded"].as_str() {
        return Ok(Media { bytes: decode_b64("google", data)?, extension: "mp4".into(), revised_prompt: None });
    }
    let uri = sample["uri"].as_str().ok_or("provider_error: Google finished but returned no video (the prompt may have been filtered)")?;
    let bytes = download("google", http.get(uri).header("x-goog-api-key", key)).await?;
    Ok(Media { bytes, extension: "mp4".into(), revised_prompt: None })
}

// ---------------------------------------------------------------------------
// OpenRouter: image-output chat models (no video models).
// ---------------------------------------------------------------------------

async fn openrouter_image(key: &str, model: &str, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let mut content = vec![json!({"type": "text", "text": prompt})];
    for r in refs {
        content.push(json!({"type": "image_url", "image_url": {"url": r.data_url()}}));
    }
    let reply = send_json("openrouter", http
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(key)
        .header("X-Title", "Spacron")
        .json(&json!({"model": model, "messages": [{"role": "user", "content": content}], "modalities": ["image", "text"]}))).await?;
    let message = &reply["choices"][0]["message"];
    let url = message["images"][0]["image_url"]["url"].as_str().ok_or_else(|| {
        let said = message["content"].as_str().unwrap_or("").trim();
        if said.is_empty() { "provider_error: OpenRouter returned no image; pick a model with image output".to_string() }
        else { format!("provider_error: OpenRouter returned no image. The model said: {}", said.chars().take(300).collect::<String>()) }
    })?;
    if url.starts_with("data:") {
        let mime = url.trim_start_matches("data:").split(';').next().unwrap_or("image/png");
        Ok(Media { extension: extension_from_mime(mime, "png"), bytes: decode_b64("openrouter", url)?, revised_prompt: None })
    } else {
        Ok(Media { extension: extension_from_url(url, "png"), bytes: download("openrouter", http.get(url)).await?, revised_prompt: None })
    }
}

// ---------------------------------------------------------------------------
// Vercel AI Gateway: its own /v4/ai image and video routes, any gateway model
// id (`openai/gpt-image-2`, `bfl/flux-2-pro`, `google/veo-3.1-...`). The model
// rides the `ai-model-id` header, as the gateway's SDK sends it.
// ---------------------------------------------------------------------------

fn vercel_post(http: &reqwest::Client, key: &str, path: &str, spec_header: &str, model: &str) -> reqwest::RequestBuilder {
    use super::secrets::{VERCEL_AI_BASE_URL, VERCEL_PROTOCOL_VERSION};
    http.post(format!("{VERCEL_AI_BASE_URL}/{path}"))
        .bearer_auth(key)
        .header("ai-gateway-protocol-version", VERCEL_PROTOCOL_VERSION)
        .header(spec_header, "4")
        .header("ai-model-id", model)
}

/// The gateway hands images back as bare base64 with no media type, so the
/// extension comes from the file's own magic bytes.
fn image_extension_from_bytes(bytes: &[u8]) -> &'static str {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => "jpg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        [b'G', b'I', b'F', b'8', ..] => "gif",
        _ => "png",
    }
}

async fn vercel_image(key: &str, model: &str, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let mut body = json!({"prompt": prompt, "n": 1});
    if !refs.is_empty() {
        body["files"] = refs
            .iter()
            .map(|r| json!({"type": "file", "mediaType": r.mime, "data": r.base64}))
            .collect();
    }
    let reply = send_json("vercel", vercel_post(&http, key, "image-model", "ai-image-model-specification-version", model).json(&body)).await?;
    let data = reply["images"][0].as_str().ok_or("provider_error: Vercel AI Gateway returned no image; pick a model of type image")?;
    let bytes = decode_b64("vercel", data)?;
    Ok(Media { extension: image_extension_from_bytes(&bytes).into(), bytes, revised_prompt: None })
}

async fn vercel_video(key: &str, model: &str, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let mut body = json!({"prompt": prompt, "n": 1});
    if let Some(r) = refs.first() {
        body["image"] = json!({"type": "file", "mediaType": r.mime, "data": r.base64});
    }
    let started = send_json("vercel", vercel_post(&http, key, "video-model/start", "ai-video-model-specification-version", model).json(&body)).await?;
    let operation = started.get("operation").cloned().ok_or("protocol: Vercel AI Gateway returned no video operation")?;
    let video = loop {
        let status = send_json("vercel", vercel_post(&http, key, "video-model/status", "ai-video-model-specification-version", model)
            .json(&json!({"operation": operation}))).await?;
        match status["status"].as_str().unwrap_or("") {
            "completed" => break status["videos"][0].clone(),
            "error" => {
                let message = status["error"].as_str().unwrap_or("the video failed");
                return Err(if message.to_lowercase().contains("quota") { format!("quota: Vercel AI Gateway: {message}") } else { format!("provider_error: Vercel AI Gateway: {message}") });
            }
            "cancelled" => return Err("provider_error: Vercel AI Gateway: the video was cancelled".into()),
            _ => tokio::time::sleep(POLL_EVERY).await,
        }
    };
    let mime = video["mediaType"].as_str().unwrap_or("video/mp4");
    let bytes = match video["type"].as_str() {
        Some("base64") => decode_b64("vercel", video["data"].as_str().unwrap_or(""))?,
        Some("url") => download("vercel", http.get(video["url"].as_str().unwrap_or(""))).await?,
        _ => return Err("provider_error: Vercel AI Gateway finished but returned no video".into()),
    };
    Ok(Media { bytes, extension: extension_from_mime(mime, "mp4"), revised_prompt: None })
}

// ---------------------------------------------------------------------------
// fal: queue API, any model id (`fal-ai/...`).
// ---------------------------------------------------------------------------

/// First media URL in a fal or Replicate result, whatever its shape.
fn find_media_url(value: &Value, kind: Kind) -> Option<String> {
    let keys: &[&str] = match kind {
        Kind::Video => &["video", "videos", "output", "url"],
        Kind::Image => &["images", "image", "output", "url"],
    };
    for key in keys {
        let found = &value[*key];
        let url = found.as_str()
            .or_else(|| found["url"].as_str())
            .or_else(|| found[0].as_str())
            .or_else(|| found[0]["url"].as_str());
        if let Some(url) = url.filter(|u| u.starts_with("http") || u.starts_with("data:")) {
            return Some(url.to_string());
        }
    }
    None
}

async fn fetch_media(provider: &str, http: &reqwest::Client, url: &str, kind: Kind) -> Result<(Vec<u8>, String), String> {
    let fallback = if kind == Kind::Video { "mp4" } else { "png" };
    if url.starts_with("data:") {
        let mime = url.trim_start_matches("data:").split(';').next().unwrap_or("");
        return Ok((decode_b64(provider, url)?, extension_from_mime(mime, fallback)));
    }
    Ok((download(provider, http.get(url)).await?, extension_from_url(url, fallback)))
}

async fn fal(key: &str, model: &str, kind: Kind, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let mut model = model.to_string();
    let mut input = json!({"prompt": prompt});
    if !refs.is_empty() {
        // The defaults are text-only endpoints; their reference-taking siblings
        // have their own ids.
        if Some(model.as_str()) == default_model("fal", kind) {
            model = match kind { Kind::Image => "fal-ai/nano-banana/edit".into(), Kind::Video => "fal-ai/veo3/fast/image-to-video".into() };
        }
        match kind {
            Kind::Image => input["image_urls"] = json!(refs.iter().map(Reference::data_url).collect::<Vec<_>>()),
            Kind::Video => input["image_url"] = json!(refs[0].data_url()),
        }
    }
    let auth = format!("Key {key}");
    let job = send_json("fal", http.post(format!("https://queue.fal.run/{model}")).header("Authorization", &auth).json(&input)).await?;
    let status_url = job["status_url"].as_str().ok_or("protocol: fal returned no status URL")?.to_string();
    let response_url = job["response_url"].as_str().ok_or("protocol: fal returned no result URL")?.to_string();
    loop {
        let status = send_json("fal", http.get(&status_url).header("Authorization", &auth)).await?;
        match status["status"].as_str().unwrap_or("") {
            "COMPLETED" => break,
            "FAILED" | "ERROR" => return Err(format!("provider_error: fal: {}", status["error"].as_str().unwrap_or("the job failed"))),
            _ => tokio::time::sleep(POLL_EVERY).await,
        }
    }
    let result = send_json("fal", http.get(&response_url).header("Authorization", &auth)).await?;
    let url = find_media_url(&result, kind).ok_or_else(|| format!("provider_error: fal finished but returned no {}", if kind == Kind::Video { "video" } else { "image" }))?;
    let (bytes, extension) = fetch_media("fal", &http, &url, kind).await?;
    Ok(Media { bytes, extension, revised_prompt: result["prompt"].as_str().filter(|p| *p != prompt).map(str::to_string) })
}

// ---------------------------------------------------------------------------
// Replicate: `owner/name` (latest version) or `owner/name:version`.
// ---------------------------------------------------------------------------

async fn replicate(key: &str, model: &str, kind: Kind, prompt: &str, refs: &[Reference]) -> Result<Media, String> {
    let http = client()?;
    let mut model = model.to_string();
    let mut input = json!({"prompt": prompt});
    if !refs.is_empty() {
        if kind == Kind::Image && Some(model.as_str()) == default_model("replicate", kind) {
            // flux-schnell cannot take references; nano-banana can.
            model = "google/nano-banana".into();
        }
        match kind {
            Kind::Image => input["image_input"] = json!(refs.iter().map(Reference::data_url).collect::<Vec<_>>()),
            Kind::Video => input["image"] = json!(refs[0].data_url()),
        }
    }
    let request = match model.split_once(':') {
        Some((_, version)) => http.post("https://api.replicate.com/v1/predictions").json(&json!({"version": version, "input": input})),
        None => http.post(format!("https://api.replicate.com/v1/models/{model}/predictions")).json(&json!({"input": input})),
    };
    let mut prediction = send_json("replicate", request.bearer_auth(key)).await?;
    loop {
        match prediction["status"].as_str().unwrap_or("") {
            "succeeded" => break,
            "failed" | "canceled" => {
                let message = prediction["error"].as_str().unwrap_or("the prediction failed");
                return Err(format!("provider_error: Replicate: {message}"));
            }
            _ => {}
        }
        tokio::time::sleep(POLL_EVERY).await;
        let url = prediction["urls"]["get"].as_str().ok_or("protocol: Replicate returned no status URL")?.to_string();
        prediction = send_json("replicate", http.get(url).bearer_auth(key)).await?;
    }
    let url = find_media_url(&prediction, kind).ok_or_else(|| format!("provider_error: Replicate finished but returned no {}", if kind == Kind::Video { "video" } else { "image" }))?;
    let (bytes, extension) = fetch_media("replicate", &http, &url, kind).await?;
    Ok(Media { bytes, extension, revised_prompt: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spent_balance_is_always_quota() {
        let status = reqwest::StatusCode::PAYMENT_REQUIRED;
        assert!(http_error("fal", status, r#"{"detail":"User is locked. Reason: Exhausted balance."}"#).starts_with("quota: fal:"));
        let status = reqwest::StatusCode::TOO_MANY_REQUESTS;
        assert!(http_error("openai", status, r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}"#).starts_with("quota: OpenAI:"));
        assert!(http_error("openai", status, r#"{"error":{"message":"Rate limit reached"}}"#).starts_with("rate_limit:"));
    }

    #[test]
    fn media_urls_are_found_in_any_result_shape() {
        assert_eq!(find_media_url(&json!({"images": [{"url": "https://x/a.png"}]}), Kind::Image).as_deref(), Some("https://x/a.png"));
        assert_eq!(find_media_url(&json!({"video": {"url": "https://x/v.mp4"}}), Kind::Video).as_deref(), Some("https://x/v.mp4"));
        assert_eq!(find_media_url(&json!({"output": "https://x/v.mp4"}), Kind::Video).as_deref(), Some("https://x/v.mp4"));
        assert_eq!(find_media_url(&json!({"output": ["https://x/a.webp"]}), Kind::Image).as_deref(), Some("https://x/a.webp"));
        assert_eq!(extension_from_url("https://x/a.webp?sig=1", "png"), "webp");
    }
}
