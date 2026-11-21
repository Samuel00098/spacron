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
use std::io::Write;
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
        .filter(|w| !w.is_empty() && !["a", "an", "the", "of", "please", "create", "generate", "draw", "make", "image", "picture", "edit", "this", "attached", "video", "clip"].contains(&w.to_ascii_lowercase().as_str()))
        .take(6)
        .map(|w| w.to_ascii_lowercase())
        .collect();
    let stem: String = if words.is_empty() { "image".into() } else { words.join("-").chars().take(64).collect() };
    if ["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"].contains(&stem.as_str()) {
        format!("image-{stem}")
    } else { stem }
}

/// Allocate a descriptive filename without replacing another agent's generation.
fn save_named_media(dir: &Path, stem: &str, extension: &str, bytes: &[u8]) -> Result<(PathBuf, String), String> {
    if extension.is_empty() || !extension.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid generated media extension".into());
    }
    for number in 1..=10_000 {
        let name = if number == 1 { format!("{stem}.{extension}") } else { format!("{stem}-{number}.{extension}") };
        let path = dir.join(&name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("could not save the generated media: {error}"));
                }
                return Ok((path, name));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("could not save the generated media: {error}")),
        }
    }
    Err("too many generated files with the same name".into())
}

struct NamingImage(PathBuf);

impl Drop for NamingImage {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

async fn name_generated_image(provider: &str, made: &media::Media) -> Option<String> {
    if made.bytes.len() as u64 > MAX_REFERENCE_BYTES { return None; }
    let naming_provider = match provider {
        "openai" | "google" | "openrouter" | "vercel" => provider,
        _ if crate::commands::chatgpt::signed_in() => "chatgpt",
        _ => return None,
    };
    // Reuse vision's narrow temp-folder scope rather than widening what it may read.
    let dir = crate::commands::file_system::pasted_images_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let stem = format!("image-name-{}", uuid::Uuid::new_v4().simple());
    let (path, _) = save_named_media(&dir, &stem, &made.extension, &made.bytes).ok()?;
    let scratch = NamingImage(path);
    tokio::time::timeout(
        std::time::Duration::from_secs(25),
        crate::commands::secrets::agent_turn::generated_media_name(naming_provider, Some(scratch.0.to_str()?), ""),
    ).await.ok()?.ok()
}

async fn name_generated_video(provider: &str, description: &str) -> Option<String> {
    let naming_provider = match provider {
        "openai" | "google" | "openrouter" | "vercel" => provider,
        _ if crate::commands::chatgpt::signed_in() => "chatgpt",
        _ => return None,
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(25),
        crate::commands::secrets::agent_turn::generated_media_name(naming_provider, None, description),
    ).await.ok()?.ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedImageFile {
    pub path: String,
    pub name: String,
}

fn rename_image_file(path: &str, name: &str, roots: &[PathBuf]) -> Result<RenamedImageFile, String> {
    let source = confine_image(path, roots)?;
    let extension = source.extension().and_then(|e| e.to_str()).ok_or("image has no extension")?;
    let input = name.trim();
    let stem = input.rsplit_once('.').filter(|(stem, suffix)| !stem.is_empty() && suffix.eq_ignore_ascii_case(extension))
        .map(|(stem, _)| stem).unwrap_or(input);
    let reserved = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if stem.is_empty() || stem.chars().count() > 120 || stem.ends_with('.')
        || stem.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || ["CON", "PRN", "AUX", "NUL"].contains(&reserved.as_str())
        || (reserved.len() == 4 && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && matches!(reserved.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("Use an image name without path separators or reserved filename characters".into());
    }
    let name = format!("{stem}.{extension}");
    let destination = source.with_file_name(&name);
    if destination != source && cfg!(windows) && source.file_name().is_some_and(|old| old.to_string_lossy().eq_ignore_ascii_case(&name)) {
        // Windows identifies these as the same file; permit a casing-only rename.
        std::fs::rename(&source, &destination).map_err(|e| format!("could not rename the image: {e}"))?;
    } else if destination != source {
        // Both paths are in the same directory. A hard link atomically refuses
        // an existing destination; unlike rename on Unix, it cannot overwrite it.
        std::fs::hard_link(&source, &destination).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists { "An image with that name already exists".into() }
            else { format!("could not rename the image: {e}") }
        })?;
        if let Err(error) = std::fs::remove_file(&source) {
            let _ = std::fs::remove_file(&destination);
            return Err(format!("could not rename the image: {error}"));
        }
    }
    Ok(RenamedImageFile { path: destination.to_string_lossy().into_owned(), name })
}

#[tauri::command]
pub fn rename_image(state: State<'_, AppState>, path: String, name: String, project_root: Option<String>) -> Result<RenamedImageFile, String> {
    rename_image_file(&path, &name, &allowed_roots(&state.config_dir, project_root.as_deref()))
}

fn cancellations() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImageFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub revised_prompt: Option<String>,
    /// The provider that made it.
    pub provider: String,
    /// One line per provider that was tried first and could not do it, so the
    /// chat can say why a fallback was used (a spent ChatGPT limit, say).
    pub skipped: Vec<String>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Last write, in milliseconds since the epoch.
    pub modified: u64,
}

/// Every image in a project's `generations` folder, newest first, for the
/// Library room. Also grants the folder to the asset protocol so the
/// thumbnails load. Videos are left out: the Library edits images.
#[tauri::command]
pub fn list_generations(app: AppHandle, project_root: String) -> Result<Vec<GenerationEntry>, String> {
    if project_root.trim().is_empty() { return Ok(Vec::new()); }
    let dir = PathBuf::from(project_root).join("generations");
    let Ok(read) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let _ = app.asset_protocol_scope().allow_directory(&dir, false);
    let mut entries: Vec<GenerationEntry> = read
        .filter_map(Result::ok)
        .filter(|entry| is_image_path(&entry.path()))
        .filter_map(|entry| {
            let meta = entry.metadata().ok().filter(|m| m.is_file())?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some(GenerationEntry {
                path: entry.path().to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
                size: meta.len(),
                modified,
            })
        })
        .collect();
    entries.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
    Ok(entries)
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

async fn generate_on(provider: &str, kind: Kind, model: &str, prompt: &str, references: &[PathBuf]) -> Result<(media::Media, Option<String>), String> {
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
        return Ok((media::Media { bytes, extension: "png".into(), revised_prompt: image.revised_prompt }, image.suggested_name));
    }
    let key = crate::commands::secrets::media_api_key(provider)?;
    media::generate(provider, kind, model, prompt, references, &key).await.map(|made| (made, None))
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
    let made = generate_and_save(
        &state.config_dir, request_id, &kind, provider, models.unwrap_or_default(), prompt, reference_images, project_root.as_deref(),
    )
    .await?;
    if let Some(dir) = Path::new(&made.path).parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, false);
    }
    Ok(made)
}

/// The body of `generate_media` without the webview: also what agents reach
/// through the MCP server's `generate_image` / `generate_video` tools.
#[allow(clippy::too_many_arguments)]
pub async fn generate_and_save(
    config_dir: &Path,
    request_id: String,
    kind: &str,
    provider: Option<String>,
    models: HashMap<String, String>,
    prompt: String,
    reference_images: Vec<String>,
    project_root: Option<&str>,
) -> Result<GeneratedImageFile, String> {
    let kind = Kind::parse(kind)?;
    let noun = if kind == Kind::Video { "video" } else { "image" };
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() { return Err("a prompt is required".into()); }
    if reference_images.len() > MAX_REFERENCES { return Err(format!("at most {MAX_REFERENCES} reference images")); }
    let roots = allowed_roots(config_dir, project_root);
    let mut references = Vec::new();
    for raw in &reference_images {
        let path = confine_image(raw, &roots)?;
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_REFERENCE_BYTES {
            return Err(format!("reference image is larger than 20 MB: {raw}"));
        }
        references.push(path);
    }
    let preferred = provider.as_deref().filter(|p| !p.is_empty() && *p != "auto");

    let work = async {
        let mut skipped: Vec<String> = Vec::new();
        let mut quota_hit = false;
        for provider in provider_order(kind, preferred) {
            let model = models.get(&provider).map(String::as_str).unwrap_or("");
            match generate_on(&provider, kind, model, &prompt, &references).await {
                Ok((made, suggested_name)) => {
                    // Naming is best effort: a successful generation still arrives
                    // if its naming model is offline or out of quota.
                    let name = match (kind, suggested_name) {
                        (Kind::Image, None) => name_generated_image(&provider, &made).await,
                        (Kind::Video, None) => name_generated_video(&provider, made.revised_prompt.as_deref().unwrap_or(&prompt)).await,
                        (_, name) => name,
                    };
                    return Ok((provider, made, skipped, name));
                }
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
            "{prefix}: No provider could make the {noun}. Add a key for another provider in Settings > AI Providers, or wait for your limit to reset.\n{}",
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
    let (provider, made, skipped, suggested_name) = result?;

    let dir = output_dir(config_dir, project_root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let title = suggested_name.as_deref().filter(|s| !s.trim().is_empty())
        .or(made.revised_prompt.as_deref()).unwrap_or(&prompt);
    let stem = slug(title);
    let stem = if kind == Kind::Video && stem == "image" { "video" } else { &stem };
    let (dest, name) = save_named_media(&dir, stem, &made.extension, &made.bytes)?;
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
        assert_eq!(slug("A flat, blue circle on white!"), "flat-blue-circle-on-white");
        assert_eq!(slug("Please generate a video of ocean waves at sunset"), "ocean-waves-at-sunset");
        assert_eq!(slug("CON"), "image-con");
        assert_eq!(slug("..//\\"), "image");
    }

    #[test]
    fn descriptive_image_and_video_names_never_overwrite_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        for extension in ["png", "mp4"] {
            let (first, name) = save_named_media(dir.path(), "ocean-waves-at-sunset", extension, b"first").unwrap();
            assert_eq!(name, format!("ocean-waves-at-sunset.{extension}"));
            let (second, name) = save_named_media(dir.path(), "ocean-waves-at-sunset", extension, b"second").unwrap();
            assert_eq!(name, format!("ocean-waves-at-sunset-2.{extension}"));
            assert_eq!(std::fs::read(first).unwrap(), b"first");
            assert_eq!(std::fs::read(second).unwrap(), b"second");
        }
    }

    #[test]
    fn concurrent_generations_receive_distinct_names() {
        let dir = tempfile::tempdir().unwrap();
        let saves: Vec<_> = (0..8).map(|number| {
            let root = dir.path().to_path_buf();
            std::thread::spawn(move || save_named_media(&root, "red-fox-in-snow", "png", &[number]).unwrap())
        }).collect();
        let paths: std::collections::HashSet<_> = saves.into_iter().map(|save| save.join().unwrap().0).collect();
        assert_eq!(paths.len(), 8);
    }

    #[test]
    fn rename_preserves_the_image_and_refuses_collisions_or_unsafe_names() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("old.png");
        std::fs::write(&source, b"original image").unwrap();
        let roots = vec![dir.path().to_path_buf()];
        for name in ["", "../escape", "bad:name", "NUL", "COM1", "trailing.", "bad\nname"] {
            assert!(rename_image_file(source.to_str().unwrap(), name, &roots).is_err());
            assert_eq!(std::fs::read(&source).unwrap(), b"original image");
        }
        std::fs::write(dir.path().join("taken.png"), b"other image").unwrap();
        assert!(rename_image_file(source.to_str().unwrap(), "taken", &roots).is_err());
        assert_eq!(std::fs::read(dir.path().join("taken.png")).unwrap(), b"other image");
        let renamed = rename_image_file(source.to_str().unwrap(), "Golden sunset.png", &roots).unwrap();
        assert_eq!(renamed.name, "Golden sunset.png");
        assert!(!source.exists());
        assert_eq!(std::fs::read(&renamed.path).unwrap(), b"original image");
        assert!(rename_image_file(&renamed.path, "Golden sunset", &roots).is_ok());
        if cfg!(windows) {
            let case_rename = rename_image_file(&renamed.path, "golden sunset", &roots).unwrap();
            assert_eq!(case_rename.name, "golden sunset.png");
            assert_eq!(std::fs::read(case_rename.path).unwrap(), b"original image");
        }
        assert!(rename_image_file(&renamed.path, "escape", &[]).is_err());
    }

    #[test]
    fn naming_scratch_files_are_removed_when_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("naming.png");
        std::fs::write(&path, b"preview").unwrap();
        let scratch = NamingImage(path.clone());
        drop(scratch);
        assert!(!path.exists());
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
