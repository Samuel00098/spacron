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
        name: "Codex CLI",
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
        let exists = provider_spec(provider)
            .and_then(|spec| config_dir_for(spec, &selected))
            .map(|dir| dir.is_dir())
            .unwrap_or(false);
        if !exists {
            return DEFAULT_ACCOUNT_ID.to_string();
        }
    }
    selected
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

/// Read a human label for an account without touching the token.
///
/// Deliberately reads the *label* file rather than the credential where one
/// exists: `.credentials.json` is the secret, `oauth-account.json` is the
/// address on the envelope, and there is no reason to open the former to render
/// a row.
fn label_for(spec: &AccountProvider, account_id: &str) -> Option<String> {
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

    accounts
}

/// Switch which account a provider uses. Takes effect for the next agent
/// launched and for the next meter reading; running sessions keep the account
/// they started with, because their environment was fixed at spawn.
#[tauri::command(async)]
pub async fn usage_select_account(provider: String, account_id: String) -> Result<(), String> {
    let spec = provider_spec(&provider).ok_or_else(|| "Unknown provider".to_string())?;
    if account_id != DEFAULT_ACCOUNT_ID && !account_id_is_safe(&account_id) {
        return Err("Invalid account id".to_string());
    }
    let dir = config_dir_for(spec, &account_id).ok_or_else(|| "Unknown account".to_string())?;
    if !dir.is_dir() {
        return Err("That account no longer exists".to_string());
    }

    let mut selected = load_selection();
    selected.insert(provider, account_id);
    save_selection(&selected)
}

/// Create an empty managed account directory and return its id.
///
/// This creates a *directory*, nothing more. The account becomes real when the
/// user runs the CLI's own login with [`usage_account_env`] applied and the CLI
/// writes its credential there.
#[tauri::command(async)]
pub async fn usage_add_account(provider: String, label: String) -> Result<String, String> {
    let spec = provider_spec(&provider).ok_or_else(|| "Unknown provider".to_string())?;

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
        .join(spec.provider);
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
    Ok(id)
}

/// Remove a managed account: deletes the directory the CLI wrote its credential
/// into. The default account is refused — that is the user's own `~` and not
/// ours to delete.
#[tauri::command(async)]
pub async fn usage_remove_account(provider: String, account_id: String) -> Result<(), String> {
    let spec = provider_spec(&provider).ok_or_else(|| "Unknown provider".to_string())?;
    if account_id == DEFAULT_ACCOUNT_ID {
        return Err("The default account belongs to your home directory".to_string());
    }
    if !account_id_is_safe(&account_id) {
        return Err("Invalid account id".to_string());
    }
    let dir = config_dir_for(spec, &account_id).ok_or_else(|| "Unknown account".to_string())?;
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

    let mut selected = load_selection();
    if selected.get(&provider).map(String::as_str) == Some(account_id.as_str()) {
        selected.remove(&provider);
        save_selection(&selected)?;
    }
    Ok(())
}

/// The environment a launched agent needs to use the selected account.
///
/// Empty for the default account — the CLI's own default behaviour is already
/// correct there, and setting the variable to `~/.claude` would only add a way
/// for it to be wrong.
#[tauri::command(async)]
pub async fn usage_account_env(provider: String) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let Some(spec) = provider_spec(&provider) else {
        return env;
    };
    let account_id = selected_account(&provider);
    if account_id == DEFAULT_ACCOUNT_ID {
        return env;
    }
    if let Some(dir) = config_dir_for(spec, &account_id) {
        if dir.is_dir() {
            env.insert(
                spec.config_env.to_string(),
                dir.to_string_lossy().to_string(),
            );
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

/// Resolve the credential file the meter should read for a provider — the
/// selected account's, not unconditionally the home one.
pub(crate) fn active_credential_path(provider: &str) -> Option<PathBuf> {
    let spec = provider_spec(provider)?;
    let path = credential_path(spec, &selected_account(provider))?;
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// True when this provider participates in account switching at all.
pub(crate) fn supports_accounts(provider: &str) -> bool {
    provider_spec(provider).is_some()
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
            let env = runtime.block_on(usage_account_env(spec.provider.to_string()));
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
    fn only_the_two_verified_clis_support_switching() {
        assert!(supports_accounts("claude"));
        assert!(supports_accounts("codex"));
        // Gemini and Grok have no documented config-dir override that is
        // honoured on login, so they are deliberately absent rather than
        // half-supported.
        assert!(!supports_accounts("gemini"));
        assert!(!supports_accounts("grok"));
    }
}
