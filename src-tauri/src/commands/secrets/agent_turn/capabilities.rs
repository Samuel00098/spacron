//! What each model can do — text, vision, reasoning, tools — learned from the
//! providers' own model lists, remembered on disk, and refreshed in the
//! background.
//!
//! Nothing here is per provider. Every model list Spacron already fetches goes
//! through `remember_metadata`, which reads the capability fields providers
//! publish under the handful of names in use (below). A provider added later
//! that uses any of those names is understood with no code change; one that
//! publishes nothing falls back to other catalogues' answers for the same
//! model and then to the name rules in `vision`.
//!
//! Refreshes: at startup (each configured provider at most once a day), and
//! right away when an API key is saved. The frontend hears
//! `model-capabilities-updated` and redraws the picker's icons.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const REFRESH_EVERY_MS: u64 = 24 * 60 * 60 * 1000;
pub(super) const UPDATED_EVENT: &str = "model-capabilities-updated";

// --- reading capability fields ---------------------------------------------------

fn params(item: &Value) -> Option<Vec<String>> {
    item["supported_parameters"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_ascii_lowercase)).collect())
}

fn flag(item: &Value, paths: &[&[&str]]) -> Option<bool> {
    paths.iter().find_map(|path| {
        let mut v = item;
        for key in *path {
            v = &v[*key];
        }
        v.as_bool()
    })
}

/// Does the model think before answering? OpenRouter/Kilo list a `reasoning`
/// parameter, Google says `thinking: true`, others use `capabilities.reasoning`
/// or `supports_reasoning`. A list of supported parameters without any
/// reasoning one means "no".
pub(super) fn catalogue_reasoning(item: &Value) -> Option<bool> {
    if let Some(explicit) = flag(
        item,
        &[&["thinking"], &["capabilities", "reasoning"], &["capabilities", "thinking"], &["supports_reasoning"], &["reasoning"]],
    ) {
        return Some(explicit);
    }
    params(item).map(|p| p.iter().any(|x| x == "reasoning" || x == "include_reasoning" || x == "reasoning_effort"))
}

/// Can the reasoning amount be chosen through a request parameter? Only then
/// does the composer offer levels for a model it has no built-in rule for.
pub(super) fn catalogue_reasoning_effort(item: &Value) -> Option<bool> {
    if let Some(explicit) = flag(item, &[&["capabilities", "reasoning_effort"], &["supports_reasoning_effort"]]) {
        return Some(explicit);
    }
    params(item).map(|p| p.iter().any(|x| x == "reasoning_effort" || x == "reasoning"))
}

/// Native tool calling.
pub(super) fn catalogue_tools(item: &Value) -> Option<bool> {
    if let Some(explicit) = flag(
        item,
        &[&["capabilities", "function_calling"], &["capabilities", "tools"], &["supports_tools"], &["supports_function_calling"]],
    ) {
        return Some(explicit);
    }
    params(item).map(|p| p.iter().any(|x| x == "tools"))
}

// --- reasoning by model name, across catalogues ----------------------------------

/// Bare model name → reasons, from every list that says so. Lets a provider
/// that publishes nothing (OpenCode, NVIDIA, OpenAI) show the reasoning icon
/// for a model another catalogue describes under the same name. Only the icon
/// uses it: whether a *level* can be requested depends on the provider, so the
/// reasoning menu still needs that provider's own list (`reasoningEffort`).
fn reasoning_names() -> &'static Mutex<HashMap<String, bool>> {
    static MAP: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bare(model: &str) -> String {
    let m = model.trim().to_ascii_lowercase();
    let m = m.rsplit('/').next().unwrap_or(&m);
    m.split(':').next().unwrap_or(m).to_string()
}

pub(super) fn learn_reasoning(model: &str, reasons: bool) {
    let name = bare(model);
    if name.is_empty() {
        return;
    }
    let mut map = reasoning_names().lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.entry(name).or_insert(reasons);
    *entry = *entry || reasons;
}

/// What any catalogue says about this model's reasoning, by exact bare name.
pub(super) fn reasoning_from_catalogues(model: &str) -> Option<bool> {
    reasoning_names().lock().unwrap_or_else(|e| e.into_inner()).get(&bare(model)).copied()
}

// --- tool calling by model name, across catalogues --------------------------------

/// Bare model name → can call tools, from every list that says so. Same idea
/// as `reasoning_names`: lets the picker's tool-calls icon show for a model a
/// provider lists without saying, when another catalogue describes it under the
/// same name. Icon only — the chat's own `nativeTools` still comes from the
/// provider's list, so this never changes how a turn is sent.
fn tool_names() -> &'static Mutex<HashMap<String, bool>> {
    static MAP: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn learn_tools(model: &str, calls_tools: bool) {
    let name = bare(model);
    if name.is_empty() {
        return;
    }
    let mut map = tool_names().lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.entry(name).or_insert(calls_tools);
    *entry = *entry || calls_tools;
}

/// What any catalogue says about this model's tool calling, by exact bare name.
pub(super) fn tools_from_catalogues(model: &str) -> Option<bool> {
    tool_names().lock().unwrap_or_else(|e| e.into_inner()).get(&bare(model)).copied()
}

// --- remembered on disk -------------------------------------------------------------

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Stored {
    version: u32,
    /// `chat_shape_key` → the metadata object `remember_metadata` builds.
    models: HashMap<String, Value>,
    /// Bare model name → accepts images (see `vision::learn`).
    names: HashMap<String, bool>,
    /// Bare model name → reasons (see `learn_reasoning`).
    #[serde(default)]
    reasoning_names: HashMap<String, bool>,
    /// Bare model name → calls tools (see `learn_tools`).
    #[serde(default)]
    tool_names: HashMap<String, bool>,
    /// Provider → when its list was last fetched (ms since epoch).
    refreshed: HashMap<String, u64>,
}

fn file() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("spacron").join("model-capabilities.json"))
}

fn refreshed() -> &'static Mutex<HashMap<String, u64>> {
    static MAP: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What was saved last run: model metadata (returned for `metadata()` to start
/// from) and the name map (put straight into `vision`).
pub(super) fn load() -> HashMap<String, Value> {
    let Some(path) = file() else { return HashMap::new() };
    let Ok(text) = std::fs::read_to_string(path) else { return HashMap::new() };
    let Ok(stored) = serde_json::from_str::<Stored>(&text) else { return HashMap::new() };
    for (name, accepts) in &stored.names {
        super::vision::learn(name, *accepts);
    }
    for (name, reasons) in &stored.reasoning_names {
        learn_reasoning(name, *reasons);
    }
    for (name, calls_tools) in &stored.tool_names {
        learn_tools(name, *calls_tools);
    }
    *refreshed().lock().unwrap_or_else(|e| e.into_inner()) = stored.refreshed;
    stored.models
}

/// Write everything known now. Best-effort: a failed write only means the
/// next launch starts from the name rules until the lists are fetched again.
pub(super) fn save(models: &HashMap<String, Value>) {
    // Tests feed made-up model lists through `remember_metadata`; they must
    // never land in the user's real capability file.
    if cfg!(test) {
        return;
    }
    let Some(path) = file() else { return };
    let stored = Stored {
        version: 1,
        models: models.clone(),
        names: super::vision::known_names(),
        reasoning_names: reasoning_names().lock().unwrap_or_else(|e| e.into_inner()).clone(),
        tool_names: tool_names().lock().unwrap_or_else(|e| e.into_inner()).clone(),
        refreshed: refreshed().lock().unwrap_or_else(|e| e.into_inner()).clone(),
    };
    let Ok(text) = serde_json::to_string(&stored) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

// --- background refresh -----------------------------------------------------------

fn app() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

/// Called once from app setup: remember the handle for events, and refresh
/// every configured provider that is due, a little after startup so the first
/// seconds belong to the UI.
pub fn start(handle: AppHandle) {
    let _ = app().set(handle);
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(15)).await;
        refresh(None, false).await;
    });
}

/// Tell the frontend every provider's answers may have changed (the public
/// catalogue arrived): it drops its cache and asks again.
pub(super) fn announce_all() {
    if let Some(handle) = app().get() {
        let _ = handle.emit(UPDATED_EVENT, json!({}));
    }
}

/// A key was just saved: learn that provider's models now.
pub fn refresh_soon(provider: &str) {
    if app().get().is_none() {
        return;
    }
    let provider = provider.to_string();
    tauri::async_runtime::spawn(async move {
        refresh(Some(provider), true).await;
    });
}

/// Fetch the model lists of `only` (or every configured provider), skipping
/// any fetched within a day unless `force`. Listing models costs nothing; no
/// model is called.
pub(super) async fn refresh(only: Option<String>, force: bool) -> Vec<String> {
    if super::ensure_public_catalogue().await {
        announce_all();
    }
    let mut done = Vec::new();
    for provider in super::super::KNOWN_PROVIDERS {
        if only.as_deref().is_some_and(|p| p != *provider) {
            continue;
        }
        // Local servers need a URL only the frontend knows; they are listed
        // when the user opens them.
        if super::super::is_local_provider(provider) {
            continue;
        }
        if !super::super::provider_api_key_exists(provider.to_string()).unwrap_or(false) {
            continue;
        }
        let last = refreshed().lock().unwrap_or_else(|e| e.into_inner()).get(*provider).copied().unwrap_or(0);
        if !force && now_ms().saturating_sub(last) < REFRESH_EVERY_MS {
            continue;
        }
        let listed = super::super::list_provider_models(
            provider.to_string(),
            String::new(),
            None,
            Some(super::super::ModelPurpose::Chat),
        )
        .await;
        if listed.is_ok() {
            refreshed().lock().unwrap_or_else(|e| e.into_inner()).insert(provider.to_string(), now_ms());
            save(&super::metadata().lock().unwrap_or_else(|e| e.into_inner()));
            if let Some(handle) = app().get() {
                let _ = handle.emit(UPDATED_EVENT, json!({ "provider": provider }));
            }
            done.push(provider.to_string());
        }
        // Be gentle with rate limits when many providers are configured.
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_is_read_from_every_published_shape() {
        let openrouter = json!({"supported_parameters":["tools","reasoning","max_tokens"]});
        assert_eq!(catalogue_reasoning(&openrouter), Some(true));
        assert_eq!(catalogue_reasoning_effort(&openrouter), Some(true));
        let plain = json!({"supported_parameters":["tools","max_tokens"]});
        assert_eq!(catalogue_reasoning(&plain), Some(false));
        assert_eq!(catalogue_reasoning_effort(&plain), Some(false));
        assert_eq!(catalogue_reasoning(&json!({"thinking": true})), Some(true));
        assert_eq!(catalogue_reasoning_effort(&json!({"thinking": true})), None);
        assert_eq!(catalogue_reasoning(&json!({"capabilities": {"reasoning": true}})), Some(true));
        assert_eq!(catalogue_reasoning(&json!({"id": "x"})), None);
    }

    /// Live but free: runs the real background refresh over every configured
    /// provider and reports what it learned. Nothing is saved (test build).
    /// `cargo test --lib live_background_refresh -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "Uses configured API keys to list models (free); run explicitly"]
    async fn live_background_refresh() {
        let done = refresh(None, true).await;
        println!("REFRESHED {done:?}");
        let meta = super::super::metadata().lock().unwrap().clone();
        for provider in &done {
            let prefix = format!("{provider}\u{1}");
            let rows: Vec<&Value> = meta.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, v)| v).collect();
            let listed = rows.iter().filter(|v| !v["reasoning"].is_null()).count();
            let reasoning = rows.iter().filter(|v| v["reasoning"] == true).count();
            let effort = rows.iter().filter(|v| v["reasoningEffort"] == true).count();
            let vision = rows.iter().filter(|v| v["images"] == true).count();
            println!("LEARNED {provider}: {} models; list says vision for {vision}; says reasoning for {listed} ({reasoning} yes, {effort} with a level)", rows.len());
        }
        assert!(!done.is_empty());
    }

    #[test]
    fn reasoning_carries_across_catalogues_by_model_name() {
        learn_reasoning("moonshotai/kimi-k3-thinker", true);
        assert_eq!(reasoning_from_catalogues("kimi-k3-thinker"), Some(true));
        assert_eq!(reasoning_from_catalogues("KIMI-K3-THINKER:free"), Some(true));
        assert_eq!(reasoning_from_catalogues("never-listed-model"), None);
    }

    #[test]
    fn tools_are_read_from_every_published_shape() {
        assert_eq!(catalogue_tools(&json!({"supported_parameters":["tools"]})), Some(true));
        assert_eq!(catalogue_tools(&json!({"capabilities":{"function_calling":false}})), Some(false));
        assert_eq!(catalogue_tools(&json!({"id":"x"})), None);
    }

    #[test]
    fn tools_carry_across_catalogues_by_model_name() {
        learn_tools("qwen/qwen9-tool-tester", true);
        assert_eq!(tools_from_catalogues("qwen9-tool-tester"), Some(true));
        assert_eq!(tools_from_catalogues("QWEN9-TOOL-TESTER:free"), Some(true));
        assert_eq!(tools_from_catalogues("never-listed-tool-model"), None);
    }
}
