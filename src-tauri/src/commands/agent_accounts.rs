//! Several signed-in accounts per agent CLI, and switching between them.
//!
//! The last gap against Orca's usage panel. A user with a personal plan and a
//! work plan had to log their CLI out and back in to move between them, and the
//! meter could only ever describe whichever one was current.
//!
//! ## The one design decision that matters
//!
//! **No credential file is ever written by Spacron.** That is [`super::usage`]'s
//! rule 1, and the obvious implementation — copy `auth.json` aside, copy another
//! one in — breaks it in the most damaging way available: a copy that loses a
//! race with the CLI's own token refresh logs the user out of an account they
//! never touched.
//!
//! Instead, every CLI here supports relocating its **whole config directory**
//! through an environment variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). A
//! managed account is just such a directory under Spacron's app data, and it is
//! *the CLI itself* that writes the credential into it, during a normal login
//! the user performs. Spacron only ever:
//!
//! - creates an empty directory,
//! - sets one environment variable when launching the agent,
//! - and **reads** the credential the CLI wrote there, exactly as it reads the
//!   one in `~`.
//!
//! Which means switching accounts cannot corrupt one, and the account in the
//! user's home directory — the one their own terminal uses — is never touched
//! at all. It appears here as the "Default" account and is read-only to us.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A CLI that can hold more than one account.
///
/// Adding one means finding its config-dir environment variable and confirming
/// the CLI honours it for *login* as well as for reads — a CLI that reads the
/// variable but writes to `~` anyway would silently overwrite the default
/// account, which is the exact failure this module exists to avoid.
pub struct AccountProvider {
    pub provider: &'static str,
    pub name: &'static str,
    /// Relocates the CLI's entire config directory.
    pub config_env: &'static str,
    /// The default config directory, relative to `$HOME`.
    pub home_dir: &'static [&'static str],
    /// The credential file, relative to the config directory.
    pub credential: &'static [&'static str],
    /// Where a human-readable account label lives, relative to the config
    /// directory. `None` means the credential file itself carries it.
    pub label_file: Option<&'static [&'static str]>,
    /// Where that same label lives for the **default** account, relative to
    /// `$HOME`.
    ///
    /// These differ for Claude Code, and the difference is not cosmetic:
    /// `.claude.json` sits *beside* `~/.claude/`, not inside it, but moves
    /// inside a relocated config directory when `CLAUDE_CONFIG_DIR` is set.
    /// Resolving the default account against the config dir finds nothing and
    /// every row renders as "Default account" — which is what happened before
    /// this field existed.
    pub label_file_home: Option<&'static [&'static str]>,
    pub label_keys: &'static [&'static str],
    /// A JWT field whose payload carries the label, for CLIs that record the
    /// account only inside an id token.
    pub label_jwt: Option<&'static str>,
}

pub const ACCOUNT_PROVIDERS: &[AccountProvider] = &[
    AccountProvider {
        provider: "claude",
        name: "Claude Code",
        config_env: "CLAUDE_CONFIG_DIR",
        home_dir: &[".claude"],
        credential: &[".credentials.json"],
        // The credential file holds only the token; the address lives in
        // `.claude.json`, under `oauthAccount.emailAddress`.
        label_file: Some(&[".claude.json"]),
        label_file_home: Some(&[".claude.json"]),
        label_keys: &["emailAddress", "email"],
        label_jwt: None,
    },
    AccountProvider {
        provider: "codex",
        name: "Codex",
        config_env: "CODEX_HOME",
        home_dir: &[".codex"],
        credential: &["auth.json"],
        // Codex records the account only inside its id token, so the label
        // comes from that token's payload — see `label_from_jwt`.
        label_file: None,
        label_file_home: None,
        label_keys: &["email"],
        label_jwt: Some("id_token"),
    },
    AccountProvider {
        provider: "grok",
        name: "Grok",
        // Documented in Grok CLI's own README ("Override config directory").
        config_env: "GROK_HOME",
        home_dir: &[".grok"],
        credential: &["auth.json"],
        // `auth.json` is keyed by issuer + client id, with the profile one
        // level down — the depth `find_label` already looks at.
        label_file: None,
        label_file_home: None,
        label_keys: &["email"],
        label_jwt: None,
    },
    AccountProvider {
        provider: "antigravity",
        name: "Antigravity",
        config_env: "GEMINI_HOME",
        home_dir: &[".gemini"],
        credential: &["antigravity-cli", "antigravity-oauth-token"],
        label_file: None,
        label_file_home: None,
        label_keys: &["id_token_email", "email"],
        label_jwt: Some("id_token"),
    },
];

pub fn provider_spec(provider: &str) -> Option<&'static AccountProvider> {
    ACCOUNT_PROVIDERS
        .iter()
        .find(|spec| spec.provider == provider)
}

/// The id of the account that lives in the user's own home directory. Reserved
/// — a managed account can never be created with this id, so the default can
/// never be shadowed.
pub const DEFAULT_ACCOUNT_ID: &str = "default";

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Root for managed account directories: `<app config>/agent-accounts/`.
fn managed_root() -> Option<PathBuf> {
    dirs_config_dir().map(|dir| dir.join("agent-accounts"))
}

fn dirs_config_dir() -> Option<PathBuf> {
    // Matches the directory `usage_stats` and `activity_stats` already use, so
    // everything Spacron stores per-user stays in one place.
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|dir| dir.join("spacron"))
    }
    #[cfg(target_os = "macos")]
    {
        home_dir().map(|dir| dir.join("Library").join("Application Support").join("spacron"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|dir| dir.join(".config")))
            .map(|dir| dir.join("spacron"))
    }
}

/// An account id is used as a directory name, so it is restricted to a charset
/// that cannot escape the managed root or collide with the reserved default.
fn account_id_is_safe(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != DEFAULT_ACCOUNT_ID
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The config directory backing an account: the user's own for `default`, a
/// managed one otherwise.
pub fn config_dir_for(spec: &AccountProvider, account_id: &str) -> Option<PathBuf> {
    if account_id == DEFAULT_ACCOUNT_ID {
        if spec.provider == "codex" {
            if let Some(home) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
                return Some(PathBuf::from(home));
            }
        }
        let mut path = home_dir()?;
        path.extend(spec.home_dir);
        return Some(path);
    }
    if !account_id_is_safe(account_id) {
        return None;
    }
    Some(managed_root()?.join(spec.provider).join(account_id))
}

/// The credential file for an account, whichever directory backs it.
pub fn credential_path(spec: &AccountProvider, account_id: &str) -> Option<PathBuf> {
    let mut path = config_dir_for(spec, account_id)?;
    path.extend(spec.credential);
    Some(path)
}

// ---------------------------------------------------------------------------
// Selection store
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct SelectionFile {
    #[serde(default)]
    selected: HashMap<String, String>,
}

fn selection_path() -> Option<PathBuf> {
    Some(managed_root()?.join("selection.json"))
}

fn selection_cache() -> &'static Mutex<Option<HashMap<String, String>>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<HashMap<String, String>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn load_selection() -> HashMap<String, String> {
    let cache = selection_cache();
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return hit;
    }
    let loaded = selection_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<SelectionFile>(&text).ok())
        .map(|file| file.selected)
        .unwrap_or_default();
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(loaded.clone());
    loaded
}

fn save_selection(selected: &HashMap<String, String>) -> Result<(), String> {
    let path = selection_path().ok_or_else(|| "No config directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {parent:?}: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&SelectionFile {
        selected: selected.clone(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Could not save the account selection: {e}"))?;
    *selection_cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(selected.clone());
    Ok(())
}

/// Which account a provider is currently using. Falls back to the user's own —
/// an unset or dangling selection must never leave a provider with no account.
pub fn selected_account(provider: &str) -> String {
    let selected = load_selection()
        .get(provider)
        .cloned()
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string());
    // A selection pointing at a directory the user has since deleted resolves
    // back to the default rather than reporting an account that isn't there.
    if selected != DEFAULT_ACCOUNT_ID {
        let exists = account_dir(provider, &selected)
            .map(|dir| dir.is_dir())
            .unwrap_or(false);
        if !exists {
            return DEFAULT_ACCOUNT_ID.to_string();
        }
    }
    selected
}

/// Config directory for the selected Codex account, including the default.
pub(crate) fn selected_codex_home() -> Option<PathBuf> {
    let spec = provider_spec("codex")?;
    config_dir_for(spec, &selected_account("codex"))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub provider: String,
    /// Display name for the provider, so the frontend can group rows without
    /// re-deriving it from the key.
    pub provider_name: String,
    pub id: String,
    /// Email when the CLI records one, else the id. Never a token.
    pub label: String,
    /// Whether a credential is actually present — a directory created for a
    /// login the user then abandoned is listed, but honestly.
    pub signed_in: bool,
    pub active: bool,
}

// ---------------------------------------------------------------------------
// Cursor: accounts are API keys
// ---------------------------------------------------------------------------
//
// `CURSOR_CONFIG_DIR` moves Cursor's settings but not its login, which stays in
// one per-user place (`%APPDATA%\Cursor` on Windows), so Cursor is not in
// [`ACCOUNT_PROVIDERS`]. An added account is a user API key held in the system
// keychain, plus a config directory of its own.
//
// The key must never be launched without `AGENT_CLI_CREDENTIAL_STORE=memory`:
// Cursor otherwise exchanges it for tokens and saves them over the user's own
// login.

const CURSOR: &str = "cursor";
const CURSOR_STORE_VAR: &str = "AGENT_CLI_CREDENTIAL_STORE";
const CURSOR_KEY_VAR: &str = "CURSOR_API_KEY";
const KEYCHAIN_SERVICE: &str = "com.samue.spacron";

fn cursor_default_dir() -> Option<PathBuf> {
    std::env::var_os("CURSOR_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".cursor")))
}

/// The email Cursor's CLI says it is signed in as.
pub(crate) fn cursor_account_email() -> Option<String> {
    let text = std::fs::read_to_string(cursor_default_dir()?.join("cli-config.json")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json.pointer("/authInfo/email")?
        .as_str()
        .filter(|email| !email.is_empty())
        .map(str::to_string)
}

fn cursor_key_entry(account_id: &str) -> Result<keyring::Entry, String> {
    if !account_id_is_safe(account_id) {
        return Err("Invalid account id".to_string());
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("cursor_account_{account_id}"))
        .map_err(|e| format!("Could not open the system keychain: {e}"))
}

fn cursor_key(account_id: &str) -> Option<String> {
    cursor_key_entry(account_id).ok()?.get_password().ok().filter(|key| !key.is_empty())
}

fn managed_ids(provider: &str) -> Vec<String> {
    let mut ids: Vec<String> = managed_root()
        .and_then(|root| std::fs::read_dir(root.join(provider)).ok())
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| account_id_is_safe(name))
        .collect();
    ids.sort();
    ids
}

/// The directory behind an account, Cursor included.
fn account_dir(provider: &str, account_id: &str) -> Option<PathBuf> {
    if provider != CURSOR {
        return config_dir_for(provider_spec(provider)?, account_id);
    }
    if account_id == DEFAULT_ACCOUNT_ID {
        return cursor_default_dir();
    }
    account_id_is_safe(account_id).then_some(())?;
    Some(managed_root()?.join(CURSOR).join(account_id))
}

fn cursor_accounts() -> Vec<AgentAccount> {
    let managed = managed_ids(CURSOR);
    if managed.is_empty() && !cursor_default_dir().is_some_and(|dir| dir.is_dir()) {
        return Vec::new();
    }
    let active = selected_account(CURSOR);
    let email = cursor_account_email();
    let row = |id: String, label: String, signed_in: bool| AgentAccount {
        provider: CURSOR.to_string(),
        provider_name: "Cursor".to_string(),
        active: id == active,
        id,
        label,
        signed_in,
    };
    let mut accounts = vec![row(
        DEFAULT_ACCOUNT_ID.to_string(),
        email.clone().unwrap_or_else(|| "Default account".to_string()),
        email.is_some(),
    )];
    for id in managed {
        let has_key = cursor_key(&id).is_some();
        accounts.push(row(id.clone(), id, has_key));
    }
    accounts
}

/// Store the API key behind an added Cursor account.
#[tauri::command(async)]
pub async fn usage_set_account_key(provider: String, account_id: String, key: String) -> Result<(), String> {
    if provider != CURSOR {
        return Err("Only Cursor accounts take an API key".to_string());
    }
    let key = key.trim();
    if key.is_empty() {
        return Err("Paste the API key first".to_string());
    }
    if !account_dir(&provider, &account_id).is_some_and(|dir| dir.is_dir()) {
        return Err("That account no longer exists".to_string());
    }
    cursor_key_entry(&account_id)?
        .set_password(key)
        .map_err(|e| format!("Could not save the key to the system keychain: {e}"))
}

/// Add the secret an account's environment refers to, just before a process is
/// started. [`usage_account_env`] leaves it out on purpose: that answer goes to
/// the webview, and the key never should.
pub(crate) fn add_account_secrets(env: &mut HashMap<String, String>) {
    if env.get(CURSOR_STORE_VAR).map(String::as_str) != Some("memory") || env.contains_key(CURSOR_KEY_VAR) {
        return;
    }
    let Some(root) = managed_root().map(|root| root.join(CURSOR)) else { return };
    let key = env
        .get("CURSOR_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.parent() == Some(root.as_path()))
        .and_then(|dir| cursor_key(dir.file_name()?.to_str()?));
    if let Some(key) = key {
        env.insert(CURSOR_KEY_VAR.to_string(), key);
    }
}

/// Read a human label for an account without touching the token.
///
/// Deliberately reads the *label* file rather than the credential where one
/// exists: `.credentials.json` is the secret, `oauth-account.json` is the
/// address on the envelope, and there is no reason to open the former to render
/// a row.
fn label_for(spec: &AccountProvider, account_id: &str) -> Option<String> {
    if spec.provider == "antigravity" && account_id == DEFAULT_ACCOUNT_ID {
        if let Some(json) = crate::commands::usage::antigravity_credential_json() {
            if let Some(found) = find_label(&json, spec.label_keys) {
                return Some(found);
            }
            if let Some(field) = spec.label_jwt {
                if let Some(token) = find_string(&json, field) {
                    if let Some(lbl) = label_from_jwt(&token, spec.label_keys) {
                        return Some(lbl);
                    }
                }
            }
        }
    }
    let path = label_path(spec, account_id)?;
    let text = std::fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;

    if let Some(found) = find_label(&json, spec.label_keys) {
        return Some(found);
    }
    // Nothing readable in the clear — try the id token, for CLIs that record
    // the account only there.
    let field = spec.label_jwt?;
    let token = find_string(&json, field)?;
    label_from_jwt(&token, spec.label_keys)
}

/// Where a provider's label file lives for this account. The default account
/// can resolve somewhere other than the config directory — see
/// [`AccountProvider::label_file_home`].
fn label_path(spec: &AccountProvider, account_id: &str) -> Option<PathBuf> {
    if account_id == DEFAULT_ACCOUNT_ID {
        if let Some(segments) = spec.label_file_home {
            let mut path = home_dir()?;
            path.extend(segments);
            return Some(path);
        }
    }
    let mut path = config_dir_for(spec, account_id)?;
    path.extend(spec.label_file.unwrap_or(spec.credential));
    Some(path)
}

/// Read one of `keys` out of a JWT's payload.
///
/// The payload of a signed token is plain base64url — this reads it, it does not
/// verify it, and it must never be used to make a trust decision. It is used for
/// exactly one thing: rendering the account's own email in a menu, which is the
/// same string the CLI prints. The token itself is never logged, never returned,
/// and never leaves this function.
fn label_from_jwt(token: &str, keys: &[&str]) -> Option<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let json: Value = serde_json::from_slice(&decoded).ok()?;
    find_label(&json, keys)
}

/// Find a string field at the top level or one level down, same shape tolerance
/// as [`find_label`].
fn find_string(json: &Value, key: &str) -> Option<String> {
    if let Some(found) = json.get(key).and_then(Value::as_str) {
        return Some(found.to_string());
    }
    json.as_object()?
        .values()
        .filter_map(|nested| nested.get(key).and_then(Value::as_str))
        .next()
        .map(str::to_string)
}

/// Look for any of `keys` at the top level or one level down. Codex nests its
/// account details under `tokens`, Claude keeps them flat; rather than encode
/// both shapes, take the first match at either depth.
fn find_label(json: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(found) = json.get(*key).and_then(Value::as_str) {
            if !found.is_empty() {
                return Some(found.to_string());
            }
        }
    }
    let object = json.as_object()?;
    for (_, nested) in object {
        if !nested.is_object() {
            continue;
        }
        for key in keys {
            if let Some(found) = nested.get(*key).and_then(Value::as_str) {
                if !found.is_empty() {
                    return Some(found.to_string());
                }
            }
        }
    }
    None
}

/// Every account Spacron knows about, per provider.
#[tauri::command(async)]
pub async fn usage_list_accounts() -> Vec<AgentAccount> {
    let mut accounts = Vec::new();

    for spec in ACCOUNT_PROVIDERS {
        let active = selected_account(spec.provider);

        let mut ids = vec![DEFAULT_ACCOUNT_ID.to_string()];
        if let Some(root) = managed_root().map(|root| root.join(spec.provider)) {
            if let Ok(entries) = std::fs::read_dir(&root) {
                let mut managed: Vec<String> = entries
                    .flatten()
                    .filter(|entry| entry.path().is_dir())
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .filter(|name| account_id_is_safe(name))
                    .collect();
                // Stable order, so rows don't shuffle between refreshes.
                managed.sort();
                ids.extend(managed);
            }
        }

        for id in ids {
            // The default account on macOS usually has no credential *file* —
            // Claude Code puts its OAuth credentials in the login Keychain — so
            // the file check alone rendered a signed-in user as signed out.
            // Managed accounts are deliberately not given the same fallback:
            // the Keychain holds one item per CLI, so answering yes for a
            // relocated config dir would claim a login it does not have.
            let signed_in = credential_path(spec, &id)
                .map(|path| path.is_file())
                .unwrap_or(false)
                || (id == DEFAULT_ACCOUNT_ID
                    && crate::commands::usage::keychain_has_credential(spec.provider));
            let label = label_for(spec, &id).unwrap_or_else(|| {
                if id == DEFAULT_ACCOUNT_ID {
                    "Default account".to_string()
                } else {
                    id.clone()
                }
            });
            accounts.push(AgentAccount {
                provider: spec.provider.to_string(),
                provider_name: spec.name.to_string(),
                active: id == active,
                id,
                label,
                signed_in,
            });
        }
    }

    accounts.extend(cursor_accounts());
    accounts
}

/// Switch which account a provider uses. Takes effect for the next agent
/// launched and for the next meter reading; running sessions keep the account
/// they started with, because their environment was fixed at spawn.
#[tauri::command(async)]
pub async fn usage_select_account(provider: String, account_id: String) -> Result<(), String> {
    if provider != CURSOR && provider_spec(&provider).is_none() {
        return Err("Unknown provider".to_string());
    }
    if account_id != DEFAULT_ACCOUNT_ID && !account_id_is_safe(&account_id) {
        return Err("Invalid account id".to_string());
    }
    let dir = account_dir(&provider, &account_id).ok_or_else(|| "Unknown account".to_string())?;
    if !dir.is_dir() {
        return Err("That account no longer exists".to_string());
    }

    let mut selected = load_selection();
    selected.insert(provider.clone(), account_id);
    save_selection(&selected)?;
    if provider == "codex" {
        crate::commands::chatgpt::account_changed();
    }
    Ok(())
}

/// Create an empty managed account directory and return its id.
///
/// This creates a *directory*, nothing more. The account becomes real when the
/// user runs the CLI's own login with [`usage_account_env`] applied and the CLI
/// writes its credential there.
#[tauri::command(async)]
pub async fn usage_add_account(provider: String, label: String) -> Result<String, String> {
    if provider != CURSOR && provider_spec(&provider).is_none() {
        return Err("Unknown provider".to_string());
    }

    // Derive an id from the user's label so the directory is recognisable on
    // disk, then uniquify it. A label of pure punctuation yields no usable id,
    // so fall back to a timestamp rather than rejecting the input.
    let base: String = label
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(40)
        .collect();
    let base = if base.is_empty() || base == DEFAULT_ACCOUNT_ID {
        format!("account-{}", now_secs())
    } else {
        base
    };

    let root = managed_root()
        .ok_or_else(|| "No config directory".to_string())?
        .join(&provider);
    let mut id = base.clone();
    let mut suffix = 2;
    while root.join(&id).exists() {
        id = format!("{base}-{suffix}");
        suffix += 1;
        if suffix > 100 {
            return Err("Too many accounts with that name".to_string());
        }
    }
    if !account_id_is_safe(&id) {
        return Err("Invalid account name".to_string());
    }

    std::fs::create_dir_all(root.join(&id))
        .map_err(|e| format!("Could not create the account directory: {e}"))?;
    if provider == "antigravity" {
        let _ = std::fs::create_dir_all(root.join(&id).join("antigravity-cli"));
        let _ = std::fs::create_dir_all(root.join(&id).join("config"));
    }
    Ok(id)
}

/// Remove a managed account: deletes the directory the CLI wrote its credential
/// into. The default account is refused — that is the user's own `~` and not
/// ours to delete.
#[tauri::command(async)]
pub async fn usage_remove_account(provider: String, account_id: String) -> Result<(), String> {
    if provider != CURSOR && provider_spec(&provider).is_none() {
        return Err("Unknown provider".to_string());
    }
    if account_id == DEFAULT_ACCOUNT_ID {
        return Err("The default account belongs to your home directory".to_string());
    }
    if !account_id_is_safe(&account_id) {
        return Err("Invalid account id".to_string());
    }
    let dir = account_dir(&provider, &account_id).ok_or_else(|| "Unknown account".to_string())?;
    // Belt and braces: `account_id_is_safe` already blocks traversal, but this
    // is a recursive delete, so confirm the path really is inside the managed
    // root before removing it.
    let root = managed_root().ok_or_else(|| "No config directory".to_string())?;
    if !dir.starts_with(&root) {
        return Err("Refusing to remove a directory outside the managed root".to_string());
    }
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Could not remove the account: {e}"))?;
    }

    if provider == CURSOR {
        // Gone already is fine.
        let _ = cursor_key_entry(&account_id)?.delete_credential();
    }

    let mut selected = load_selection();
    if selected.get(&provider).map(String::as_str) == Some(account_id.as_str()) {
        selected.remove(&provider);
        save_selection(&selected)?;
    }
    Ok(())
}

/// The environment a launched agent needs to use an account.
///
/// Empty for the default account — the CLI's own default behaviour is already
/// correct there, and setting the variable to `~/.claude` would only add a way
/// for it to be wrong.
///
/// `account_id` is normally omitted, which means "whichever account the user
/// selected". Failover passes one explicitly: a successor has to launch under a
/// *different* account from the one that ran out, and it must do that without
/// moving the user's global selection — the picker in Settings says which
/// account the user works as, and a handover is not the user changing their
/// mind. An unknown or credential-less id falls back to the selection rather
/// than failing the launch, because a launch must never be blocked by this.
#[tauri::command(async)]
pub async fn usage_account_env(
    provider: String,
    account_id: Option<String>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if provider != CURSOR && provider_spec(&provider).is_none() {
        return env;
    }
    let account_id = match account_id.as_deref() {
        Some(requested) if requested == DEFAULT_ACCOUNT_ID => return env,
        Some(requested) if account_id_is_safe(requested) => requested.to_string(),
        _ => selected_account(&provider),
    };
    if account_id == DEFAULT_ACCOUNT_ID {
        return env;
    }
    if provider == CURSOR {
        let dir = account_dir(CURSOR, &account_id).filter(|dir| dir.is_dir());
        if let Some(dir) = dir.filter(|_| cursor_key(&account_id).is_some()) {
            env.insert("CURSOR_CONFIG_DIR".to_string(), dir.to_string_lossy().to_string());
            env.insert(CURSOR_STORE_VAR.to_string(), "memory".to_string());
        }
        return env;
    }
    if let Some((spec, dir)) = provider_spec(&provider).and_then(|spec| Some((spec, config_dir_for(spec, &account_id)?))) {
        if dir.is_dir() {
            env.insert(
                spec.config_env.to_string(),
                dir.to_string_lossy().to_string(),
            );
            if spec.provider == "antigravity" {
                env.insert("AGY_ACP_FORCE_FILE_STORAGE".to_string(), "1".to_string());
                env.insert("AGY_CLI_DISABLE_AUTO_UPDATE".to_string(), "1".to_string());
            }
        }
    }
    env
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// True when this provider participates in account switching at all.
pub(crate) fn supports_accounts(provider: &str) -> bool {
    provider_spec(provider).is_some()
}

/// The credential file for one *named* account, whether or not it is selected.
///
/// [`active_credential_path`] answers "what should the meter read right now";
/// this answers "what would this other account read", which is the question
/// failover asks before handing work to it. Returns `None` when the account has
/// no credential of its own — see [`has_own_login`] for why that is not the
/// same as "signed out".
pub(crate) fn account_credential_path(provider: &str, account_id: &str) -> Option<PathBuf> {
    let spec = provider_spec(provider)?;
    let path = credential_path(spec, account_id)?;
    path.is_file().then_some(path)
}

/// Whether this account has a login that is genuinely its own.
///
/// The default account always does. A *managed* account only does when the CLI
/// wrote a credential file into its relocated config directory — which is the
/// normal case on Windows and Linux, and never the case on macOS for Claude
/// Code, whose OAuth credentials live in the login Keychain as one item per
/// CLI. A managed macOS Claude account therefore resolves to the *same* login
/// as the default one, and handing work to it would be a handover into the
/// account that just ran out. Callers use this to skip it.
pub(crate) fn has_own_login(provider: &str, account_id: &str) -> bool {
    if account_id == DEFAULT_ACCOUNT_ID {
        return true;
    }
    account_credential_path(provider, account_id).is_some()
}

/// Every account id Spacron knows for a provider, default first.
///
/// Shares [`usage_list_accounts`]'s directory scan without its label reads, so
/// a caller that only needs the ids does not open a credential-adjacent file
/// per account on every poll.
pub(crate) fn account_ids(provider: &str) -> Vec<String> {
    let mut ids = vec![DEFAULT_ACCOUNT_ID.to_string()];
    let Some(spec) = provider_spec(provider) else {
        return ids;
    };
    if let Some(root) = managed_root().map(|root| root.join(spec.provider)) {
        if let Ok(entries) = std::fs::read_dir(&root) {
            let mut managed: Vec<String> = entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| account_id_is_safe(name))
                .collect();
            managed.sort();
            ids.extend(managed);
        }
    }
    ids
}

/// A human label for an account, for the failover roster. Never a token.
pub(crate) fn account_label(provider: &str, account_id: &str) -> String {
    provider_spec(provider)
        .and_then(|spec| label_for(spec, account_id))
        .unwrap_or_else(|| {
            if account_id == DEFAULT_ACCOUNT_ID {
                "Default account".to_string()
            } else {
                account_id.to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Print what this machine's account list actually resolves to.
    ///
    /// Ignored by default — it reads the real home directory, so its output is
    /// machine-specific. Run with:
    ///
    /// ```text
    /// cargo test --lib real_account_listing -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "reads this machine's real home directory"]
    fn real_account_listing() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let accounts = runtime.block_on(usage_list_accounts());

        println!("\n--- accounts ---");
        for account in &accounts {
            println!(
                "{:<8} {:<22} id={:<18} signed_in={} active={}",
                account.provider, account.label, account.id, account.signed_in, account.active
            );
        }
        for spec in ACCOUNT_PROVIDERS {
            let env = runtime.block_on(usage_account_env(spec.provider.to_string(), None));
            println!("{:<8} launch env: {env:?}", spec.provider);
        }
        println!("--- end ---\n");

        // Every provider must offer at least the default account, always — a
        // provider with an empty list would render no switcher and no way back.
        for spec in ACCOUNT_PROVIDERS {
            assert!(
                accounts
                    .iter()
                    .any(|a| a.provider == spec.provider && a.id == DEFAULT_ACCOUNT_ID),
                "{} is missing its default account",
                spec.provider
            );
        }
    }

    #[test]
    fn the_default_account_id_can_never_be_claimed_by_a_managed_one() {
        // Otherwise a managed directory named "default" would shadow the user's
        // own home config and quietly redirect their real account.
        assert!(!account_id_is_safe(DEFAULT_ACCOUNT_ID));
    }

    #[test]
    fn account_ids_cannot_escape_the_managed_root() {
        assert!(!account_id_is_safe("../../etc"));
        assert!(!account_id_is_safe("a/b"));
        assert!(!account_id_is_safe("a\\b"));
        assert!(!account_id_is_safe(""));
        assert!(!account_id_is_safe(&"x".repeat(65)));
        assert!(account_id_is_safe("work-2"));
        assert!(account_id_is_safe("personal_main"));
    }

    #[test]
    fn a_label_is_found_flat_or_one_level_down() {
        // Claude keeps the address flat; Codex nests it under `tokens`.
        let flat = serde_json::json!({ "emailAddress": "me@example.com" });
        assert_eq!(
            find_label(&flat, &["emailAddress", "email"]).as_deref(),
            Some("me@example.com")
        );

        let nested = serde_json::json!({ "tokens": { "email": "work@example.com" } });
        assert_eq!(
            find_label(&nested, &["email"]).as_deref(),
            Some("work@example.com")
        );

        let absent = serde_json::json!({ "tokens": { "access_token": "secret" } });
        assert_eq!(find_label(&absent, &["email"]), None);
    }

    #[test]
    fn an_email_is_read_out_of_an_id_tokens_payload() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let payload = URL_SAFE_NO_PAD.encode(br#"{"email":"me@example.com","sub":"123"}"#);
        let token = format!("header.{payload}.signature");
        assert_eq!(
            label_from_jwt(&token, &["email"]).as_deref(),
            Some("me@example.com")
        );
    }

    #[test]
    fn a_malformed_token_yields_no_label_rather_than_panicking() {
        // The credential file is written by another tool and can be anything.
        assert_eq!(label_from_jwt("", &["email"]), None);
        assert_eq!(label_from_jwt("only-one-part", &["email"]), None);
        assert_eq!(label_from_jwt("a.!!!not-base64!!!.c", &["email"]), None);
        assert_eq!(label_from_jwt("a.aGVsbG8.c", &["email"]), None);
    }

    #[test]
    fn claudes_label_file_sits_beside_the_config_dir_for_the_default_account() {
        // `.claude.json` is a sibling of `~/.claude/`, but moves inside a
        // relocated config dir. Resolving the default against the config dir
        // finds nothing and every account renders as "Default account".
        let spec = provider_spec("claude").expect("claude");
        let default_label = label_path(spec, DEFAULT_ACCOUNT_ID).expect("default label path");
        assert!(default_label.ends_with(".claude.json"));
        assert!(!default_label.ends_with(PathBuf::from(".claude").join(".claude.json")));

        let managed_label = label_path(spec, "work").expect("managed label path");
        assert!(managed_label.ends_with(PathBuf::from("work").join(".claude.json")));
    }

    #[test]
    fn an_empty_label_is_not_a_label() {
        // An empty string would render as a blank row rather than falling back
        // to the account id.
        let json = serde_json::json!({ "email": "" });
        assert_eq!(find_label(&json, &["email"]), None);
    }

    #[test]
    fn the_default_account_maps_to_the_users_own_config_directory() {
        let spec = provider_spec("claude").expect("claude");
        let dir = config_dir_for(spec, DEFAULT_ACCOUNT_ID).expect("home dir");
        assert!(dir.ends_with(".claude"));

        let managed = config_dir_for(spec, "work").expect("managed dir");
        assert!(managed.ends_with(PathBuf::from("claude").join("work")));
    }

    #[test]
    fn a_traversal_id_resolves_to_no_directory_at_all() {
        let spec = provider_spec("codex").expect("codex");
        assert!(config_dir_for(spec, "../escape").is_none());
    }

    #[test]
    fn the_default_account_always_counts_as_its_own_login() {
        // It is the user's home config, and on macOS it is the account the
        // login Keychain item belongs to. A managed id that has no credential
        // file is the case failover must skip.
        assert!(has_own_login("claude", DEFAULT_ACCOUNT_ID));
        assert!(!has_own_login("claude", "an-account-that-does-not-exist"));
    }

    #[test]
    fn an_explicit_account_env_does_not_consult_the_users_selection() {
        // The whole point: a successor launches under another account without
        // moving the picker the user set.
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let env = runtime.block_on(usage_account_env(
            "claude".to_string(),
            Some(DEFAULT_ACCOUNT_ID.to_string()),
        ));
        assert!(
            env.is_empty(),
            "the default account needs no config-dir override"
        );

        // A traversal id must not reach `config_dir_for` as itself; it falls
        // back to the selection, which is at worst the default account.
        let escaped = runtime.block_on(usage_account_env(
            "claude".to_string(),
            Some("../../etc".to_string()),
        ));
        assert!(!escaped
            .values()
            .any(|value| value.contains("..")));
    }

    #[test]
    fn every_provider_lists_its_default_account_id() {
        for spec in ACCOUNT_PROVIDERS {
            let ids = account_ids(spec.provider);
            assert_eq!(ids.first().map(String::as_str), Some(DEFAULT_ACCOUNT_ID));
        }
        // An unknown provider still answers with the default rather than an
        // empty list, so a caller never sees "this CLI has no accounts at all".
        assert_eq!(account_ids("nope"), vec![DEFAULT_ACCOUNT_ID.to_string()]);
    }

    #[test]
    fn only_clis_with_a_config_dir_override_support_switching() {
        assert!(supports_accounts("claude"));
        assert!(supports_accounts("codex"));
        assert!(supports_accounts("antigravity"));
        // Grok CLI 1.0.89 documents `GROK_HOME` ("Override config directory",
        // default `~/.grok`, where `auth.json` lives), and `grok login` under
        // an empty `GROK_HOME` wrote its files there, not into `~/.grok`.
        assert!(supports_accounts("grok"));
        // Gemini has no documented config-dir override honoured on login, so
        // it stays absent rather than half-supported.
        assert!(!supports_accounts("gemini"));
    }
}
