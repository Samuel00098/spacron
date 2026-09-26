//! Generated images: making them, keeping them, and the viewer's file actions.
//!
//! Generation runs on the user's ChatGPT plan through Codex (see
//! `chatgpt::generate_image`) or on an API-key provider (`commands::media`),
//! for images and videos alike. Results are copied into
//! `<config>/generated-images`, which outlives Codex's own folder and the
//! pasted-image scratch dir, so a chat transcript can still show them later.
//!
//! Every path the frontend hands in is confined: reference images and file
//! actions accept only images inside the generated folder, the pasted-image
//! scratch folder, or the active project. A model chooses the reference paths,
//! and those bytes leave the machine, so this check is not optional.

use crate::commands::media::{self, Kind};
use crate::state::AppState;
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;

const MAX_REFERENCES: usize = 4;
const MAX_REFERENCE_BYTES: u64 = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
/// Generated videos share the folder; only the viewer's file actions accept them.
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "mov"];

pub fn generated_images_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("generated-images")
}

/// Let the webview display generated and pasted images through the asset
/// protocol. Granted at startup instead of in `tauri.conf.json` because the
/// generated folder lives under the runtime config dir.
pub fn allow_image_dirs(app: &AppHandle, config_dir: &Path) {
    let generated = generated_images_dir(config_dir);
    let _ = std::fs::create_dir_all(&generated);
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(&generated, false);
    let _ = scope.allow_directory(crate::commands::file_system::pasted_images_dir(), false);
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Windows canonical paths carry a `\\?\` prefix that Explorer and some
/// tools reject; drop it (the path stays absolute and resolved).
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest.to_string()),
        _ => path,
    }
}

fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Canonicalize `raw` and accept it only if it is an image file inside one of `roots`.
fn confine_image(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    confine(raw, roots, false)
}

/// Like `confine_image`, but also accepts generated videos (file actions only).
fn confine_media(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    confine(raw, roots, true)
}

fn confine(raw: &str, roots: &[PathBuf], videos: bool) -> Result<PathBuf, String> {
    let path = plain_path(std::fs::canonicalize(raw).map_err(|_| format!("image not found: {raw}"))?);
    if !path.is_file() || !(is_image_path(&path) || (videos && is_video_path(&path))) {
        return Err(format!("not an image file: {raw}"));
    }
    let inside = roots.iter().filter_map(|root| std::fs::canonicalize(root).ok()).map(plain_path).any(|root| path.starts_with(&root));
    if !inside {
        return Err(format!("image is outside the project and Spacron's image folders: {raw}"));
    }
    Ok(path)
}

fn allowed_roots(config_dir: &Path, project_root: Option<&str>) -> Vec<PathBuf> {
    let mut roots = vec![generated_images_dir(config_dir), crate::commands::file_system::pasted_images_dir()];
    if let Some(root) = project_root.filter(|r| !r.trim().is_empty()) {
        roots.push(PathBuf::from(root));
    }
    roots
}

/// A readable, filesystem-safe name stem from the prompt.
fn slug(prompt: &str) -> String {
    let words: Vec<String> = prompt
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(6)
        .map(|w| w.to_ascii_lowercase())
        .collect();
    if words.is_empty() { "image".into() } else { words.join("-").chars().take(48).collect() }
}

fn cancellations() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImageFile {
    path: String,
    name: String,
    size: u64,
    revised_prompt: Option<String>,
    /// The provider that made it.
    provider: String,
    /// One line per provider that was tried first and could not do it, so the
    /// chat can say why a fallback was used (a spent ChatGPT limit, say).
    skipped: Vec<String>,
}

/// Where a generation is saved: `<project>/generations` when a project is
/// open, so it sits with the work; otherwise Spacron's own folder.
fn output_dir(config_dir: &Path, project_root: Option<&str>) -> PathBuf {
    match project_root.filter(|r| !r.trim().is_empty()) {
        Some(root) => PathBuf::from(root).join("generations"),
        None => generated_images_dir(config_dir),
    }
}

/// Let the webview load a project's `generations` folder. Called when a chat
/// opens on a project, because the asset scope does not survive a restart.
#[tauri::command]
pub fn allow_generations_dir(app: AppHandle, project_root: String) -> Result<(), String> {
    if project_root.trim().is_empty() { return Ok(()); }
    let dir = PathBuf::from(project_root).join("generations");
    app.asset_protocol_scope().allow_directory(&dir, false).map_err(|e| e.to_string())
}

/// The order providers are tried in. ChatGPT (the user's plan) comes first
/// for images; a provider the user picked in Settings goes to the front.
fn provider_order(kind: Kind, preferred: Option<&str>) -> Vec<String> {
    let mut order: Vec<String> = media::PROVIDERS
        .iter()
        .copied()
        .filter(|p| media::default_model(p, kind).is_some() || (*p == "chatgpt" && kind == Kind::Image))
        .map(str::to_string)
        .collect();
    if let Some(pos) = preferred.and_then(|want| order.iter().position(|p| p == want)) {
        let chosen = order.remove(pos);
        order.insert(0, chosen);
    } else if let Some(custom) = preferred.filter(|p| crate::commands::custom_providers::is_custom_provider(p)) {
        // A custom provider is only ever tried when it was picked.
        order.insert(0, custom.to_string());
    }
    order
}

/// Errors that mean "this provider cannot do it right now, try the next one".
/// A content refusal or a cancel is the answer and is not retried elsewhere.
fn should_fall_back(error: &str) -> bool {
    ["quota:", "not_signed_in:", "not_configured:", "auth:", "unsupported:", "rate_limit:", "model_not_found:", "timeout:", "network:"]
        .iter()
        .any(|prefix| error.starts_with(prefix))
}

fn provider_name(provider: &str) -> String {
    if let Some(name) = crate::commands::custom_providers::display_name(provider) {
        return name;
    }
    match provider {
        "chatgpt" => "ChatGPT plan",
        "openai" => "OpenAI",
        "google" => "Google",
        "openrouter" => "OpenRouter",
        "vercel" => "Vercel AI Gateway",
        "fal" => "fal",
        "replicate" => "Replicate",
        _ => "provider",
    }
    .to_string()
}

/// The error without its `kind:` prefix, short enough for a report line.
fn short_reason(error: &str) -> String {
    let rest = error.split_once(": ").map(|(_, r)| r).unwrap_or(error);
    rest.chars().take(220).collect()
}

async fn generate_on(provider: &str, kind: Kind, model: &str, prompt: &str, references: &[PathBuf]) -> Result<media::Media, String> {
    if provider == "chatgpt" {
        if kind == Kind::Video {
            return Err("unsupported: the ChatGPT plan cannot make videos".into());
        }
        if !crate::commands::chatgpt::signed_in() {
            return Err("not_signed_in: not signed in with ChatGPT".into());
        }
        let image = crate::commands::chatgpt::generate_image(prompt, references).await?;
        let bytes = match image.saved_path.as_deref().and_then(|src| std::fs::read(src).ok()) {
            Some(bytes) => bytes,
            None => base64::engine::general_purpose::STANDARD
                .decode(image.base64.trim())
                .map_err(|_| "protocol: the generated image was not valid base64".to_string())?,
        };
        return Ok(media::Media { bytes, extension: "png".into(), revised_prompt: image.revised_prompt });
    }
    let key = crate::commands::secrets::media_api_key(provider)?;
    media::generate(provider, kind, model, prompt, references, &key).await
}

/// Generate an image or a video and save it (see `output_dir`).
///
/// Providers are tried in `provider_order`: ChatGPT first for images, then
/// every API-key provider, skipping ones with no key or a spent balance. When
/// none can do it the error lists each provider and why, for the chat to show.
/// `models` maps a provider id to the model the user picked; absent means the
/// provider's default.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_media(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    kind: String,
    provider: Option<String>,
    models: Option<HashMap<String, String>>,
    prompt: String,
    reference_images: Vec<String>,
    project_root: Option<String>,
) -> Result<GeneratedImageFile, String> {
    let kind = Kind::parse(&kind)?;
    let noun = if kind == Kind::Video { "video" } else { "image" };
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() { return Err("a prompt is required".into()); }
    if reference_images.len() > MAX_REFERENCES { return Err(format!("at most {MAX_REFERENCES} reference images")); }
    let config_dir = state.config_dir.clone();
    let roots = allowed_roots(&config_dir, project_root.as_deref());
    let mut references = Vec::new();
    for raw in &reference_images {
        let path = confine_image(raw, &roots)?;
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_REFERENCE_BYTES {
            return Err(format!("reference image is larger than 20 MB: {raw}"));
        }
        references.push(path);
    }
    let models = models.unwrap_or_default();
    let preferred = provider.as_deref().filter(|p| !p.is_empty() && *p != "auto");

    let work = async {
        let mut skipped: Vec<String> = Vec::new();
        let mut quota_hit = false;
        for provider in provider_order(kind, preferred) {
            let model = models.get(&provider).map(String::as_str).unwrap_or("");
            match generate_on(&provider, kind, model, &prompt, &references).await {
                Ok(made) => return Ok((provider, made, skipped)),
                Err(error) if should_fall_back(&error) => {
                    quota_hit |= error.starts_with("quota:");
                    let reason = if error.starts_with("not_configured:") { "no API key saved".to_string() }
                        else if error.starts_with("not_signed_in:") { "not signed in".to_string() }
                        else { short_reason(&error) };
                    skipped.push(format!("{}: {reason}", provider_name(&provider)));
                }
                Err(error) => return Err(error),
            }
        }
        let prefix = if quota_hit { "quota" } else { "none_available" };
        Err(format!(
            "{prefix}: No provider could make the {noun}. Add a key for another provider in Settings > AI Connections, or wait for your limit to reset.\n{}",
            skipped.iter().map(|line| format!("- {line}")).collect::<Vec<_>>().join("\n")
        ))
    };

    let (tx, mut rx) = watch::channel(false);
    cancellations().lock().unwrap_or_else(|e| e.into_inner()).insert(request_id.clone(), tx);
    let result = tokio::select! {
        result = work => result,
        _ = rx.changed() => Err("cancelled: stopped by user".into()),
    };
    cancellations().lock().unwrap_or_else(|e| e.into_inner()).remove(&request_id);
    let (provider, made, skipped) = result?;

    let dir = output_dir(&config_dir, project_root.as_deref());
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let _ = app.asset_protocol_scope().allow_directory(&dir, false);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let name = format!("{stamp}-{}.{}", slug(&prompt), made.extension);
    let dest = dir.join(&name);
    std::fs::write(&dest, &made.bytes).map_err(|e| format!("could not save the {noun}: {e}"))?;
    Ok(GeneratedImageFile {
        path: dest.to_string_lossy().into_owned(),
        name,
        size: made.bytes.len() as u64,
        revised_prompt: made.revised_prompt,
        provider: provider.to_string(),
        skipped,
    })
}

/// Save the picture the viewer's edit mode drew (the image with the user's
/// selection painted on) so it can go to the provider as a reference. It stays
/// in the temp paste folder on purpose: it is a throwaway copy of an image the
/// user already has, so it should not pile up next to the generated ones.
#[tauri::command]
pub fn save_edit_mark(png_base64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|_| "the marked image was not valid base64".to_string())?;
    if bytes.len() as u64 > MAX_REFERENCE_BYTES { return Err("the marked image is too large".into()); }
    let dir = crate::commands::file_system::pasted_images_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("edit-selection-{stamp}.png"));
    std::fs::write(&path, bytes).map_err(|e| format!("could not save the selection: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn generate_image_cancel(request_id: String) {
    if let Some(tx) = cancellations().lock().unwrap_or_else(|e| e.into_inner()).get(&request_id) {
        let _ = tx.send(true);
    }
}

/// Copy an image the viewer shows to a location the user picked in a save dialog.
#[tauri::command]
pub fn save_image_copy(state: State<'_, AppState>, source: String, destination: String, project_root: Option<String>) -> Result<(), String> {
    let source = confine_media(&source, &allowed_roots(&state.config_dir, project_root.as_deref()))?;
    std::fs::copy(&source, &destination).map(|_| ()).map_err(|e| format!("could not save the image: {e}"))
}

/// Show an image in the system file manager, selected.
#[tauri::command]
pub fn reveal_image(state: State<'_, AppState>, path: String, project_root: Option<String>) -> Result<(), String> {
    let path = confine_media(&path, &allowed_roots(&state.config_dir, project_root.as_deref()))?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Explorer parses its own command line: `/select,` and the quoted path
        // must reach it as one raw argument.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(&path);
        std::process::Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// The folder generated images are kept in, for the viewer's labels.
#[tauri::command]
pub fn generated_images_folder(app: AppHandle) -> String {
    let state = app.state::<AppState>();
    generated_images_dir(&state.config_dir).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chatgpt_goes_first_for_images_and_a_pick_jumps_the_queue() {
        assert_eq!(provider_order(Kind::Image, None)[0], "chatgpt");
        assert!(!provider_order(Kind::Video, None).contains(&"chatgpt".to_string()));
        assert!(!provider_order(Kind::Video, None).contains(&"openrouter".to_string()));
        assert_eq!(&provider_order(Kind::Image, Some("fal"))[..2], &["fal", "chatgpt"]);
        assert!(should_fall_back("quota: ChatGPT: limit"));
        assert!(!should_fall_back("provider_error: blocked by safety"));
        assert!(!should_fall_back("cancelled: stopped by user"));
    }

    #[test]
    fn slug_is_short_and_safe() {
        assert_eq!(slug("A flat, blue circle on white!"), "a-flat-blue-circle-on-white");
        assert_eq!(slug("..//\\"), "image");
    }

    #[test]
    fn confinement_accepts_only_images_inside_roots() {
        let base = std::env::temp_dir().join(format!("spacron-images-test-{}", std::process::id()));
        let inside = base.join("inside");
        let outside = base.join("outside");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(inside.join("a.png"), b"x").unwrap();
        std::fs::write(inside.join("notes.txt"), b"x").unwrap();
        std::fs::write(outside.join("b.png"), b"x").unwrap();
        let roots = vec![inside.clone()];
        assert!(confine_image(inside.join("a.png").to_str().unwrap(), &roots).is_ok());
        assert!(confine_image(inside.join("notes.txt").to_str().unwrap(), &roots).is_err());
        assert!(confine_image(outside.join("b.png").to_str().unwrap(), &roots).is_err());
        // `..` cannot walk out: the path is canonicalized before the check.
        let escape = inside.join("..").join("outside").join("b.png");
        assert!(confine_image(escape.to_str().unwrap(), &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
