//! User-added OpenAI-compatible providers ("custom providers").
//!
//! Each one is a name, a base URL that owns the OpenAI routes
//! (`/chat/completions`, `/models`, `/images/generations`, `/videos`,
//! `/audio/transcriptions`, `/realtime/calls`) and an API key. The key lives in
//! the OS keychain like every other provider key (`secrets.rs`); the name and
//! base URL live in `<config>/spacron/custom-providers.json`.
//!
//! The base URL is resolved HERE, from the stored record, never from what the
//! renderer sends with a request. A request carries the provider's key, so
//! trusting a renderer-supplied URL would let a tampered call send that key to
//! any host.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

/// Every custom provider id starts with this, so the rest of the backend can
/// tell one apart from a built-in id without a lookup.
pub const ID_PREFIX: &str = "custom-";
const MAX_PROVIDERS: usize = 32;
const MAX_NAME_CHARS: usize = 48;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
}

static CACHE: RwLock<Option<Vec<CustomProvider>>> = RwLock::new(None);

fn store_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("spacron").join("custom-providers.json"))
}

fn load() -> Vec<CustomProvider> {
    if let Some(list) = CACHE.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
        return list.clone();
    }
    let list: Vec<CustomProvider> = store_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    // A hand-edited file is re-validated rather than trusted.
    let list: Vec<CustomProvider> = list
        .into_iter()
        .filter(|p| id_is_valid(&p.id) && validate_base_url(&p.base_url).is_ok())
        .take(MAX_PROVIDERS)
        .collect();
    *CACHE.write().unwrap_or_else(|e| e.into_inner()) = Some(list.clone());
    list
}

fn save(list: &[CustomProvider]) -> Result<(), String> {
    let path = store_path().ok_or("Could not find the settings folder.")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the settings folder: {e}"))?;
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash mid-write never leaves a half file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Could not save custom providers: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save custom providers: {e}"))?;
    *CACHE.write().unwrap_or_else(|e| e.into_inner()) = Some(list.to_vec());
    Ok(())
}

fn id_is_valid(id: &str) -> bool {
    id.strip_prefix(ID_PREFIX).is_some_and(|slug| {
        !slug.is_empty() && slug.len() <= 40 && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

/// True for the id of a custom provider that exists.
pub fn is_custom_provider(id: &str) -> bool {
    id_is_valid(id) && load().iter().any(|p| p.id == id)
}

/// The stored base URL for a custom provider.
pub fn base_url(id: &str) -> Option<String> {
    load().into_iter().find(|p| p.id == id).map(|p| p.base_url)
}

/// The provider's display name, for error messages.
pub fn display_name(id: &str) -> Option<String> {
    load().into_iter().find(|p| p.id == id).map(|p| p.name)
}

/// A base URL a key may be sent to: https (plain http only for this machine),
/// no credentials or query, and not a link-local / cloud-metadata host. Returns
/// the normalized URL (no trailing slash).
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("Enter the provider's API address, e.g. https://api.example.com/v1".to_string());
    }
    if raw.len() > 256 || raw.contains("..") || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That API address is not valid.".to_string());
    }
    let url = url::Url::parse(raw).map_err(|_| "That API address is not a valid URL.".to_string())?;
    let host = url.host_str().ok_or("That API address has no host.")?.to_ascii_lowercase();
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1";
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        "http" => return Err("Use an https:// address. Plain http is only allowed for localhost, so your key is never sent unencrypted.".to_string()),
        _ => return Err("The API address must start with https://".to_string()),
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("Put only the API address here, without a key, query or #fragment.".to_string());
    }
    if crate::commands::http::host_is_blocked(&host) {
        return Err("That host is not allowed.".to_string());
    }
    Ok(raw.to_string())
}

/// A fresh id from the name: `custom-<slug>`, made unique against `taken`.
fn new_id(name: &str, taken: &[CustomProvider]) -> String {
    let mut slug: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    slug = slug.split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    slug.truncate(30);
    let slug = slug.trim_end_matches('-').to_string();
    let base = format!("{ID_PREFIX}{}", if slug.is_empty() { "provider" } else { &slug });
    let mut id = base.clone();
    let mut n = 2;
    while taken.iter().any(|p| p.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

#[tauri::command]
pub fn custom_providers_list() -> Vec<CustomProvider> {
    load()
}

/// Add a provider (no `id`) or update one. An `api_key` of `None` keeps the
/// saved key; an empty one is refused on add, since every custom provider is
/// key-authenticated.
#[tauri::command]
pub fn custom_provider_save(
    id: Option<String>,
    name: String,
    base_url: String,
    api_key: Option<String>,
) -> Result<CustomProvider, String> {
    let name: String = name.trim().chars().take(MAX_NAME_CHARS).collect();
    if name.is_empty() {
        return Err("Give the provider a name.".to_string());
    }
    let base_url = validate_base_url(&base_url)?;
    let mut list = load();
    let key = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());

    let provider = match id {
        Some(id) => {
            let existing = list.iter_mut().find(|p| p.id == id).ok_or("That custom provider no longer exists.")?;
            existing.name = name;
            existing.base_url = base_url;
            existing.clone()
        }
        None => {
            if list.len() >= MAX_PROVIDERS {
                return Err(format!("You can add up to {MAX_PROVIDERS} custom providers."));
            }
            if key.is_none() {
                return Err("Paste the provider's API key.".to_string());
            }
            let provider = CustomProvider { id: new_id(&name, &list), name, base_url };
            list.push(provider.clone());
            provider
        }
    };
    save(&list)?;
    if let Some(key) = key {
        crate::commands::secrets::provider_api_key_set(provider.id.clone(), key)?;
    }
    Ok(provider)
}

#[tauri::command]
pub fn custom_provider_delete(id: String) -> Result<(), String> {
    let mut list = load();
    let before = list.len();
    list.retain(|p| p.id != id);
    if list.len() == before {
        return Ok(());
    }
    // The key goes first: a provider must never outlive its removal as a key
    // nobody can see in Settings.
    let _ = crate::commands::secrets::provider_api_key_delete(id);
    save(&list)
}

const ICON_MAX_BYTES: usize = 256 * 1024;

static ICONS: std::sync::Mutex<Option<std::collections::HashMap<String, Option<String>>>> = std::sync::Mutex::new(None);

/// The hosts worth asking for an icon: the API host, then its site
/// (`api.example.com` → `example.com`), where the brand icon usually lives.
fn icon_hosts(host: &str) -> Vec<String> {
    let mut hosts = vec![host.to_string()];
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() > 2 {
        hosts.push(labels[labels.len() - 2..].join("."));
    }
    hosts
}

fn looks_like_image(bytes: &[u8], content_type: &str) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") { return Some("image/png"); }
    if bytes.starts_with(&[0, 0, 1, 0]) { return Some("image/x-icon"); }
    if bytes.starts_with(b"\xFF\xD8\xFF") { return Some("image/jpeg"); }
    if bytes.starts_with(b"GIF8") { return Some("image/gif"); }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return Some("image/webp"); }
    // SVG is only trusted when the server says so; an <img> never runs its scripts.
    if content_type.contains("image/svg") { return Some("image/svg+xml"); }
    None
}

/// The provider's own icon as a `data:` URL, for Settings and the pickers. The
/// webview's CSP rightly forbids remote images, so the backend fetches the
/// site's favicon (no key is sent) and hands it over inline. `None` when the
/// site has none, or for a localhost server; the UI then shows a letter mark.
#[tauri::command]
pub async fn custom_provider_icon(id: String) -> Option<String> {
    if let Some(hit) = ICONS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(&id).cloned()) {
        return hit;
    }
    let base = base_url(&id)?;
    let host = url::Url::parse(&base).ok()?.host_str()?.to_ascii_lowercase();
    let found = if host == "localhost" || host == "127.0.0.1" || host.contains(':') {
        None
    } else {
        fetch_icon(&host).await
    };
    ICONS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default).insert(id, found.clone());
    found
}

pub(crate) async fn fetch_icon(host: &str) -> Option<String> {
    use base64::Engine;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("Spacron")
        .build()
        .ok()?;
    for site in icon_hosts(host) {
        if crate::commands::http::host_is_blocked(&site) {
            continue;
        }
        for path in ["/favicon.ico", "/apple-touch-icon.png", "/favicon.png", "/favicon.svg"] {
            let Ok(response) = client.get(format!("https://{site}{path}")).send().await else { continue };
            if !response.status().is_success() {
                continue;
            }
            if response.content_length().is_some_and(|n| n as usize > ICON_MAX_BYTES) {
                continue;
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();
            let Ok(bytes) = response.bytes().await else { continue };
            if bytes.is_empty() || bytes.len() > ICON_MAX_BYTES {
                continue;
            }
            if let Some(mime) = looks_like_image(&bytes, &content_type) {
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                return Some(format!("data:{mime};base64,{data}"));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_must_be_https_except_on_this_machine() {
        assert_eq!(validate_base_url("https://api.example.com/v1/").unwrap(), "https://api.example.com/v1");
        assert!(validate_base_url("http://localhost:8080/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:4000/v1").is_ok());
        assert!(validate_base_url("http://api.example.com/v1").is_err());
        assert!(validate_base_url("ftp://api.example.com").is_err());
        assert!(validate_base_url("https://user:pw@api.example.com/v1").is_err());
        assert!(validate_base_url("https://api.example.com/v1?key=1").is_err());
        assert!(validate_base_url("https://169.254.169.254/latest").is_err());
        assert!(validate_base_url("https://api.example.com/../v1").is_err());
        assert!(validate_base_url("").is_err());
    }

    #[test]
    fn icons_are_sniffed_not_trusted() {
        assert_eq!(looks_like_image(b"\x89PNG\r\n", "text/html"), Some("image/png"));
        assert_eq!(looks_like_image(&[0, 0, 1, 0, 1], ""), Some("image/x-icon"));
        assert_eq!(looks_like_image(b"<svg></svg>", "image/svg+xml"), Some("image/svg+xml"));
        assert_eq!(looks_like_image(b"<html>not found</html>", "text/html"), None);
        assert_eq!(icon_hosts("api.example.com"), vec!["api.example.com", "example.com"]);
        assert_eq!(icon_hosts("example.com"), vec!["example.com"]);
    }

    #[test]
    fn ids_are_slugged_prefixed_and_unique() {
        let taken = vec![CustomProvider { id: "custom-my-proxy".into(), name: "x".into(), base_url: "https://a".into() }];
        assert_eq!(new_id("My Proxy!", &[]), "custom-my-proxy");
        assert_eq!(new_id("My Proxy", &taken), "custom-my-proxy-2");
        assert_eq!(new_id("***", &[]), "custom-provider");
        assert!(id_is_valid("custom-abc-1"));
        assert!(!id_is_valid("custom-"));
        assert!(!id_is_valid("custom-ABC"));
        assert!(!id_is_valid("openai"));
    }
}
