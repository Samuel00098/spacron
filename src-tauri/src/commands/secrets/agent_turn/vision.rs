//! Images for the chat's model: which models accept them, loading them from
//! disk, and putting them on the wire in each provider's own shape.
//!
//! The rule is simple and one-directional: a model that accepts images gets
//! them (screenshots from the browser, desktop and emulator tools, and images
//! the user attached); every other model gets exactly the text it got before.
//! Nothing downstream depends on images arriving — every screenshot tool also
//! returns text (a path, an accessibility tree) — so sending none is always
//! safe, and a provider that refuses images is retried without them.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Longest side of an image we send. Vision models downscale larger images
/// anyway (Anthropic's documented sweet spot is ≤1568 px); sending more only
/// costs tokens and upload time.
const MAX_SIDE: u32 = 1568;
/// Per-image payload ceiling before base64 (Anthropic rejects > 5 MB encoded).
const MAX_BYTES: usize = 3_500_000;
/// At most this many images per request: the user's attachments plus the
/// latest round's screenshots.
pub(super) const MAX_IMAGES: usize = 4;

pub(super) struct Image {
    pub mime: &'static str,
    pub data: String,
}

/// Endpoints (provider + base + model) that rejected an image. They get text
/// from then on, for the life of the app — same idea as `stream_refused`.
pub(super) fn images_refused() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

// --- what published catalogues say, by model name ---------------------------------

/// Bare model name → accepts images, from every catalogue that publishes input
/// modalities (OpenRouter, Kilo Code, Groq, and OpenRouter's public list).
/// Providers that publish nothing (OpenCode, NVIDIA, OpenAI, Google) serve the
/// same models under the same names, so this is data, not a guess.
fn by_name() -> &'static Mutex<std::collections::HashMap<String, bool>> {
    static MAP: OnceLock<Mutex<std::collections::HashMap<String, bool>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Lower-case, without the vendor prefix (`moonshotai/kimi-k3` → `kimi-k3`)
/// or a routing suffix (`:free`, `:thinking`).
fn bare_name(model: &str) -> String {
    let m = model.trim().to_ascii_lowercase();
    let m = m.rsplit('/').next().unwrap_or(&m);
    m.split(':').next().unwrap_or(m).to_string()
}

/// Record what a catalogue said about one model.
pub(super) fn learn(model: &str, accepts: bool) {
    let name = bare_name(model);
    if name.is_empty() {
        return;
    }
    let mut map = by_name().lock().unwrap_or_else(|e| e.into_inner());
    // Any catalogue saying "image" wins: a text-only variant of a vision model
    // is listed under its own name.
    let entry = map.entry(name).or_insert(accepts);
    *entry = *entry || accepts;
}

pub(super) fn catalogue_known() -> bool {
    !by_name().lock().unwrap_or_else(|e| e.into_inner()).is_empty()
}

/// What published catalogues say about `model`: an exact bare-name match, or
/// the longest published name that `model` extends at a `-` boundary
/// (`kimi-k2.7-code` → `kimi-k2.7`).
pub(super) fn from_catalogues(model: &str) -> Option<bool> {
    let name = bare_name(model);
    let map = by_name().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = map.get(&name) {
        return Some(*v);
    }
    map.iter()
        .filter(|(known, _)| known.len() >= 4 && name.len() > known.len() && name.starts_with(known.as_str()) && name.as_bytes()[known.len()] == b'-')
        .max_by_key(|(known, _)| known.len())
        .map(|(_, v)| *v)
}

/// Whether a model accepts image input. `catalogue` is what the provider's
/// model list said (OpenRouter publishes input modalities); without that, the
/// model's name decides. Unknown models count as text-only: a false "yes" costs
/// a refused request and a retry, a false "no" only costs the images.
pub(super) fn model_accepts_images(provider: &str, model: &str, catalogue: Option<bool>) -> bool {
    if let Some(known) = catalogue.or_else(|| from_catalogues(model)) {
        return known;
    }
    let full = model.to_ascii_lowercase();
    let m = full.rsplit('/').next().unwrap_or(&full).to_string();
    let has = |needle: &str| m.contains(needle) || (needle.starts_with('/') && full.contains(needle));
    // OpenAI's families, wherever they are served (OpenAI, the ChatGPT plan,
    // OpenRouter, other hosts). Decided by version number rather than a list
    // of names, so the next release (gpt-5.6, gpt-6, o5 …) is recognised
    // without anyone editing this file.
    if let Some(v) = openai_family(&m) {
        return v;
    }
    match provider {
        // The user's ChatGPT plan through Codex: its models are GPT-5-class
        // and newer, all multimodal. An unnamed model is the plan's default.
        "chatgpt" => true,
        "anthropic" => !(has("claude-instant") || has("claude-2")),
        "google" => (has("gemini") || has("nano-banana") || gemma_version(&m).is_some_and(|v| v >= 3)) && !has("embedding") && !has("aqa"),
        "openai" => false,
        "xai" => has("vision") || grok_version(&m).is_some_and(|v| v >= 4),
        "deepseek" => false,
        _ => {
            // OpenAI-compatible hosts and local servers: the name is all we have.
            [
                "vision", "-vl", "vl-", "llava", "gemma3", "gemma-3", "pixtral", "claude", "gemini", "minicpm-v",
                "moondream", "llama-4", "llama4", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl",
                "mistral-medium-3", "mistral-small-3.1", "mistral-small-3.2", "kimi-vl",
                // Older vision models that no published catalogue lists
                // (seen on NVIDIA's endpoint).
                "fuyu", "kosmos", "neva-", "/vila", "deplot", "cosmos-reason", "nemotron-parse", "paligemma",
                "florence", "phi-3-vision", "phi-3.5-vision", "-omni",
            ]
            .iter()
            .any(|n| has(n))
                || grok_version(&m).is_some_and(|v| v >= 4)
        }
    }
}

/// `Some(accepts)` when `m` names an OpenAI GPT or o-series model.
///
/// - `gpt-N…` with N ≥ 5, or 4o / 4.1 / 4-turbo / 4.5: images. `gpt-3.5`, the
///   original `gpt-4` and its dated snapshots: text only.
/// - `oN…` reasoning models accept images, except the two text-only minis that
///   shipped before multimodal ones (`o1-mini`, `o3-mini`).
/// - `codex-mini` (Codex's own small model) is GPT-5-class: images.
fn openai_family(m: &str) -> Option<bool> {
    if m.starts_with("codex-mini") || m.starts_with("chatgpt-4o") {
        return Some(true);
    }
    if let Some(rest) = m.split("gpt-").nth(1).filter(|_| m.starts_with("gpt-") || m.contains("/gpt-")) {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let major: u32 = digits.parse().ok()?;
        let after = &rest[digits.len()..];
        return Some(match major {
            0..=3 => false,
            4 => after.starts_with('o') || after.starts_with(".1") || after.starts_with(".5") || after.starts_with("-turbo"),
            _ => true,
        });
    }
    let bytes = m.as_bytes();
    if bytes.first() == Some(&b'o') && bytes.get(1).is_some_and(|b| b.is_ascii_digit()) {
        return Some(!(m.starts_with("o1-mini") || m.starts_with("o3-mini")));
    }
    None
}

/// The major version of a `gemma-N…` model name (Gemma 3 and later take images).
fn gemma_version(m: &str) -> Option<u32> {
    let rest = m.split("gemma-").nth(1).or_else(|| m.split("gemma").nth(1))?;
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

/// The major version of a `grok-N…` model name.
fn grok_version(m: &str) -> Option<u32> {
    let rest = m.split("grok-").nth(1)?;
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

/// The input modalities a model catalogue entry declares, when it declares
/// them (OpenRouter: `architecture.input_modalities`).
pub(super) fn catalogue_accepts_images(item: &Value) -> Option<bool> {
    let modalities = item["architecture"]["input_modalities"]
        .as_array()
        .or_else(|| item["input_modalities"].as_array())?;
    Some(modalities.iter().any(|m| m.as_str() == Some("image")))
}

/// Does this error body say the provider rejected image input?
pub(super) fn is_image_refusal(status: u16, body: &str) -> bool {
    if status != 400 && status != 422 && status != 415 {
        return false;
    }
    let b = body.to_lowercase();
    b.contains("image_url")
        || b.contains("inline_data")
        || b.contains("inlinedata")
        || (b.contains("image")
            && ["support", "not allowed", "invalid", "multimodal", "vision", "cannot", "unknown variant", "expected"]
                .iter()
                .any(|w| b.contains(w)))
}

/// The only places an image may be read from: Spacron's own screenshot and
/// pasted-image folders. The paths come from Spacron's tool executor, but the
/// image goes to a third-party API, so the reader does not trust the path.
fn allowed_roots() -> Vec<PathBuf> {
    let tmp = std::env::temp_dir();
    [
        tmp.join("spacron-screenshots"),
        tmp.join("spacron-playwright"),
        crate::commands::file_system::pasted_images_dir(),
    ]
    .into_iter()
    .filter_map(|p| p.canonicalize().ok())
    .collect()
}

fn is_allowed(path: &Path) -> bool {
    let Ok(real) = path.canonicalize() else { return false };
    allowed_roots().iter().any(|root| real.starts_with(root))
}

/// The canonical path of an image file the model may be shown, or `None`.
/// Used where the image goes out by path rather than as bytes (the ChatGPT
/// plan's Codex server reads the file itself).
pub(super) fn allowed_image_path(path: &str) -> Option<PathBuf> {
    let path = Path::new(path.trim());
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif"].contains(&ext.as_str()) || !is_allowed(path) {
        return None;
    }
    path.canonicalize().ok()
}

/// Read an image for a model: allowed folder, image extension, downscaled to
/// [`MAX_SIDE`], and re-encoded when that changed it. `None` for anything else
/// — the caller then simply sends no image.
pub(super) fn load(path: &str) -> Option<Image> {
    use base64::Engine as _;
    let path = Path::new(path.trim());
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    if !is_allowed(path) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 25_000_000 {
        return None;
    }
    let decoded = image::load_from_memory(&bytes).ok();
    let needs_resize = decoded.as_ref().is_some_and(|img| img.width().max(img.height()) > MAX_SIDE);
    if !needs_resize && bytes.len() <= MAX_BYTES && decoded.is_some() {
        return Some(Image { mime, data: base64::engine::general_purpose::STANDARD.encode(&bytes) });
    }
    let img = decoded?;
    let img = if needs_resize { img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle) } else { img };
    // Re-encode: PNG keeps UI text crisp; fall back to JPEG if that is still too big.
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
    let mut mime = "image/png";
    if out.len() > MAX_BYTES {
        out.clear();
        image::DynamicImage::ImageRgb8(img.to_rgb8())
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
            .ok()?;
        mime = "image/jpeg";
    }
    (out.len() <= MAX_BYTES).then(|| Image { mime, data: base64::engine::general_purpose::STANDARD.encode(&out) })
}

// --- wire shapes -------------------------------------------------------------

pub(super) fn anthropic_block(img: &Image) -> Value {
    json!({"type":"image","source":{"type":"base64","media_type":img.mime,"data":img.data}})
}

pub(super) fn google_part(img: &Image) -> Value {
    json!({"inlineData":{"mimeType":img.mime,"data":img.data}})
}

pub(super) fn openai_part(img: &Image) -> Value {
    json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}", img.mime, img.data)}})
}

/// A user message carrying text and images, in the provider's shape.
pub(super) fn user_message(provider: &str, text: &str, images: &[Image]) -> Value {
    match provider {
        "google" => {
            let mut parts = vec![json!({"text":text})];
            parts.extend(images.iter().map(google_part));
            json!({"role":"user","parts":parts})
        }
        "anthropic" if !images.is_empty() => {
            let mut content = vec![json!({"type":"text","text":text})];
            content.extend(images.iter().map(anthropic_block));
            json!({"role":"user","content":content})
        }
        "anthropic" => json!({"role":"user","content":text}),
        _ if !images.is_empty() => {
            let mut content = vec![json!({"type":"text","text":text})];
            content.extend(images.iter().map(openai_part));
            json!({"role":"user","content":content})
        }
        _ => json!({"role":"user","content":text}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vision_models_are_recognised_and_text_models_are_not() {
        for (p, m) in [
            ("anthropic", "claude-opus-4-1"),
            ("anthropic", "claude-3-5-sonnet-latest"),
            ("google", "gemini-2.5-pro"),
            ("openai", "gpt-4o-mini"),
            ("openai", "gpt-5"),
            ("openai", "o3"),
            ("xai", "grok-4"),
            ("ollama", "llava:13b"),
            ("ollama", "qwen2.5-vl:7b"),
            ("openrouter", "anthropic/claude-sonnet-4"),
            ("openai", "gpt-5.6"),
            ("openai", "gpt-6"),
            ("openai", "gpt-7-mini"),
            ("openai", "gpt-4.1-nano"),
            ("openai", "o5"),
            ("openai", "o4-mini"),
            ("chatgpt", "gpt-5.1-codex-max"),
            ("chatgpt", "gpt-6"),
            ("chatgpt", "default"),
            ("chatgpt", ""),
            ("openrouter", "openai/gpt-6"),
            ("together", "openai/gpt-oss-120b-vision"),
            ("xai", "grok-5"),
        ] {
            assert!(model_accepts_images(p, m, None), "{p}/{m} should accept images");
        }
        for (p, m) in [
            ("openai", "gpt-3.5-turbo"),
            ("openai", "o3-mini"),
            ("deepseek", "deepseek-chat"),
            ("ollama", "llama3.1:8b"),
            ("groq", "llama-3.3-70b-versatile"),
            ("xai", "grok-3"),
            ("openai", "gpt-4"),
            ("openai", "gpt-4-0613"),
            ("openai", "o1-mini"),
            ("openrouter", "openai/gpt-3.5-turbo"),
        ] {
            assert!(!model_accepts_images(p, m, None), "{p}/{m} should be text-only");
        }
    }

    #[test]
    fn published_catalogues_answer_for_providers_that_publish_nothing() {
        learn("moonshotai/kimi-k3", true);
        learn("z-ai/glm-5.3", false);
        learn("qwen/qwen3.6-plus:free", true);
        assert!(model_accepts_images("opencode", "kimi-k3", None));
        assert!(!model_accepts_images("opencode", "glm-5.3", None));
        assert!(model_accepts_images("opencode", "qwen3.6-plus", None));
        // A longer name extends a published one at a dash boundary…
        assert!(model_accepts_images("opencode", "kimi-k3-code", None));
        // …but not by accident of spelling.
        assert_eq!(from_catalogues("kimi-k30"), None);
        // The provider's own catalogue still wins.
        assert!(!model_accepts_images("opencode", "kimi-k3", Some(false)));
        assert!(model_accepts_images("google", "gemma-4-31b-it", None));
        for (p, m) in [("nvidia", "adept/fuyu-8b"), ("nvidia", "nvidia/vila"), ("nvidia", "nvidia/neva-22b"), ("nvidia", "microsoft/kosmos-2"), ("nvidia", "nvidia/cosmos-reason2-8b"), ("google", "nano-banana-pro-preview")] {
            assert!(model_accepts_images(p, m, None), "{p}/{m}");
        }
        assert!(!model_accepts_images("nvidia", "nvidia/riva-translate-4b-instruct", None));
        assert!(!model_accepts_images("google", "gemma-2-9b-it", None) || from_catalogues("gemma-2-9b-it") == Some(true));
    }

    #[test]
    fn the_catalogue_overrides_the_name() {
        assert!(!model_accepts_images("openrouter", "some/gpt-4o-clone", Some(false)));
        assert!(model_accepts_images("openrouter", "some/odd-name", Some(true)));
        assert_eq!(catalogue_accepts_images(&json!({"architecture":{"input_modalities":["text","image"]}})), Some(true));
        assert_eq!(catalogue_accepts_images(&json!({"architecture":{"input_modalities":["text"]}})), Some(false));
        assert_eq!(catalogue_accepts_images(&json!({"id":"x"})), None);
    }

    #[test]
    fn image_refusals_are_told_apart_from_other_400s() {
        assert!(is_image_refusal(400, r#"{"error":{"message":"Invalid content type. image_url is only supported by certain models."}}"#));
        assert!(is_image_refusal(400, "This model does not support image input"));
        assert!(!is_image_refusal(400, "max_tokens is too large"));
        assert!(!is_image_refusal(500, "image support unavailable"));
    }

    #[test]
    fn only_spacron_folders_are_read() {
        let dir = std::env::temp_dir().join("spacron-screenshots");
        std::fs::create_dir_all(&dir).unwrap();
        let inside = dir.join("vision-test.png");
        image::RgbaImage::from_pixel(2000, 1000, image::Rgba([10, 20, 30, 255])).save(&inside).unwrap();
        let loaded = load(inside.to_str().unwrap()).expect("allowed image loads");
        assert_eq!(loaded.mime, "image/png");
        // Downscaled to the ceiling.
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&loaded.data).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!(img.width(), MAX_SIDE);

        let outside = std::env::temp_dir().join("vision-test-outside.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 255])).save(&outside).unwrap();
        assert!(load(outside.to_str().unwrap()).is_none(), "outside the allowed folders");
        assert!(load(&format!("{}/../vision-test-outside.png", dir.display())).is_none(), "no climbing out");
        let _ = std::fs::remove_file(inside);
        let _ = std::fs::remove_file(outside);
    }

    #[test]
    fn user_messages_take_each_providers_shape() {
        let img = Image { mime: "image/png", data: "AAAA".into() };
        let a = user_message("anthropic", "hi", std::slice::from_ref(&img));
        assert_eq!(a["content"][1]["source"]["media_type"], "image/png");
        let g = user_message("google", "hi", std::slice::from_ref(&img));
        assert_eq!(g["parts"][1]["inlineData"]["data"], "AAAA");
        let o = user_message("openai", "hi", std::slice::from_ref(&img));
        assert_eq!(o["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA");
        // No images: exactly the old plain-text message.
        assert_eq!(user_message("openai", "hi", &[]), json!({"role":"user","content":"hi"}));
        assert_eq!(user_message("anthropic", "hi", &[]), json!({"role":"user","content":"hi"}));
    }
}
