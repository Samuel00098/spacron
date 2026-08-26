//! GitHub integration: store a personal access token in the OS keychain and use
//! it to create a new repository on the user's account, then publish the current
//! project to it. The token lives only in the keychain — it is never passed
//! through the frontend or written to `.git/config`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use keyring::{Entry, Error as KeyringError};
use tauri::State;

use crate::commands::workspace::{classify_push_error, git_base, sanitize_git_error};
use crate::state::AppState;
use crate::workspace::project::Project;

const KEYCHAIN_SERVICE: &str = "com.samue.spacron";
const GITHUB_TOKEN_USERNAME: &str = "github_token";
const GITHUB_META_USERNAME: &str = "github_token_meta";
const GITHUB_API: &str = "https://api.github.com";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
/// Scopes requested for OAuth sign-in. `workflow` is required or any push that
/// touches `.github/workflows/` fails with a confusing error; `repo read:user`
/// is the minimum for cloning/creating private repos. Do not widen this set.
const GITHUB_OAUTH_SCOPES: &str = "repo read:user workflow";
/// Shown whenever GitHub rejects our credentials with a 401 — the keychain
/// entries are cleared and the user signs in again.
const SIGN_IN_EXPIRED: &str = "Your GitHub sign-in has expired. Sign in again.";

/// OAuth App client id for "Sign in with GitHub" (device flow).
///
/// The user registers their own OAuth App at
/// https://github.com/settings/developers (Settings → Developer settings →
/// OAuth Apps → New OAuth App) and must tick **"Enable Device Flow"** in the
/// app's settings, or the device endpoint 404s. A client id is public by
/// design and device flow needs no client secret, so nothing sensitive ships
/// in the binary. Configure it via the `SPACRON_GITHUB_CLIENT_ID` env var;
/// when unset or still a placeholder, sign-in is unavailable and the PAT path
/// stays the only option (the frontend hides the sign-in button entirely).
fn github_client_id() -> Option<String> {
    let raw = std::env::var("SPACRON_GITHUB_CLIENT_ID").unwrap_or_default();
    let id = raw.trim().to_string();
    let lower = id.to_lowercase();
    if id.len() < 10
        || lower.contains("your")
        || lower.contains("replace")
        || lower.contains("xxx")
        || lower.contains("placeholder")
    {
        return None;
    }
    Some(id)
}

fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, GITHUB_TOKEN_USERNAME)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))
}

/// Save (or, when empty, clear) the GitHub personal access token in the keychain.
#[tauri::command]
pub fn github_token_set(token: String) -> Result<(), String> {
    let token = token.trim().to_string();
    let entry = token_entry()?;
    if token.is_empty() {
        let _ = clear_github_meta();
        return match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(format!("Failed to remove the token: {e}")),
        };
    }
    if token.len() > 512 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like a valid token.".to_string());
    }
    entry
        .set_password(&token)
        .map_err(|e| format!("Failed to save the token: {e}"))?;
    let _ = write_github_meta(&GithubMeta {
        source: "pat".to_string(),
        login: String::new(),
        scopes: Vec::new(),
    });
    Ok(())
}

#[tauri::command]
pub fn github_token_exists() -> Result<bool, String> {
    let entry = token_entry()?;
    match entry.get_password() {
        Ok(p) => Ok(!p.trim().is_empty()),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(e) => Err(format!("Failed to check the token: {e}")),
    }
}

#[tauri::command]
pub fn github_token_delete() -> Result<(), String> {
    let _ = clear_github_meta();
    let entry = token_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to remove the token: {e}")),
    }
}

fn read_token() -> Result<String, String> {
    let entry = token_entry()?;
    match entry.get_password() {
        Ok(p) if !p.trim().is_empty() => Ok(p.trim().to_string()),
        Ok(_) | Err(KeyringError::NoEntry) => Err(
            "No GitHub token saved. Add a personal access token in Settings to create repositories."
                .to_string(),
        ),
        Err(e) => Err(format!("Failed to read the token: {e}")),
    }
}

/// Non-secret metadata stored next to the token so errors can say "your GitHub
/// sign-in has expired" instead of "check your personal access token". Lives
/// in the keychain so it is always removed together with the token.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct GithubMeta {
    /// "oauth" | "pat" | "gh-cli"
    pub source: String,
    pub login: String,
    pub scopes: Vec<String>,
}

fn meta_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, GITHUB_META_USERNAME)
        .map_err(|e| format!("Failed to access the system keychain: {e}"))
}

fn write_github_meta(meta: &GithubMeta) -> Result<(), String> {
    let json =
        serde_json::to_string(meta).map_err(|e| format!("Failed to encode metadata: {e}"))?;
    meta_entry()?
        .set_password(&json)
        .map_err(|e| format!("Failed to save metadata: {e}"))
}

fn read_github_meta() -> Option<GithubMeta> {
    let entry = meta_entry().ok()?;
    let raw = entry.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

fn clear_github_meta() -> Result<(), String> {
    match meta_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to remove metadata: {e}")),
    }
}

/// Drop both the token and its metadata — the "sign out" and 401 cleanup.
fn clear_github_credentials() {
    let _ = token_entry().and_then(|e| e.delete_credential().map_err(|err| err.to_string()));
    let _ = clear_github_meta();
}

/// What the frontend shows for a signed-in user: login + granted scopes.
#[derive(serde::Serialize, Clone, Debug)]
pub struct GithubIdentity {
    pub login: String,
    pub scopes: Vec<String>,
    /// "oauth" | "pat" | "gh-cli"
    pub source: String,
}

/// Which sign-in entry points are available right now.
#[derive(serde::Serialize)]
pub struct GithubAuthOptions {
    /// Device-flow sign-in is available (a real client id is configured).
    pub oauth_available: bool,
    /// The `gh` CLI is installed and authenticated (`gh auth token` works).
    pub gh_cli_available: bool,
}

#[tauri::command]
pub fn github_auth_options() -> GithubAuthOptions {
    GithubAuthOptions {
        oauth_available: github_client_id().is_some(),
        gh_cli_available: gh_auth_token().map(|t| t.is_some()).unwrap_or(false),
    }
}

/// The start of a device-flow sign-in, as returned by GitHub.
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct OAuthStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Parse and validate GitHub's device-code response. Pure so it is
/// unit-testable without a network.
fn parse_device_code_response(body: &serde_json::Value) -> Result<OAuthStart, String> {
    if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
        return Err(format!("GitHub couldn't start sign-in: {err}."));
    }
    let start: OAuthStart = serde_json::from_value(body.clone())
        .map_err(|_| "GitHub returned an unexpected response.".to_string())?;
    if start.device_code.is_empty()
        || start.user_code.is_empty()
        || start.verification_uri.is_empty()
    {
        return Err("GitHub returned an incomplete device code response.".to_string());
    }
    Ok(start)
}

/// Begin "Sign in with GitHub": ask GitHub for a device code and show it to the
/// user, who approves it in their browser. The frontend then polls
/// `github_oauth_poll` until approval.
#[tauri::command]
pub async fn github_oauth_start() -> Result<OAuthStart, String> {
    let client_id = github_client_id().ok_or_else(|| {
        "GitHub sign-in isn't configured. Register an OAuth App with Device Flow enabled and set SPACRON_GITHUB_CLIENT_ID."
            .to_string()
    })?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Spacron")
        .build()
        .map_err(|e| format!("Failed to prepare the request: {e}"))?;
    let resp = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", GITHUB_OAUTH_SCOPES)])
        .send()
        .await
        .map_err(|e| format!("Failed to contact GitHub: {}", e.without_url()))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => "GitHub rejected the sign-in request (404). The OAuth App must have 'Enable Device Flow' ticked in its settings."
                .to_string(),
            422 => "GitHub rejected the requested scopes (422). Check the OAuth App's settings."
                .to_string(),
            _ => format!("GitHub returned an error ({status}) while starting sign-in."),
        });
    }
    parse_device_code_response(&body)
}

/// Result of one poll of the device-flow token endpoint.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OAuthPollOutcome {
    /// The user hasn't approved yet — keep polling.
    Pending,
    /// GitHub is rate-limiting us — poll 5s later than scheduled.
    SlowDown,
    /// The user approved; the token is already saved in the keychain.
    SignedIn { identity: GithubIdentity },
}

#[derive(Debug)]
enum PollStatus {
    Pending,
    SlowDown,
    Token(String),
}

/// Classify the body of a `/login/oauth/access_token` poll response. Pure so it
/// is unit-testable. `authorization_pending` → keep polling, `slow_down` → back
/// off, `expired_token`/`access_denied` → stop with a clear error.
fn classify_poll_body(body: &serde_json::Value) -> Result<PollStatus, String> {
    if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
        return match err {
            "authorization_pending" => Ok(PollStatus::Pending),
            "slow_down" => Ok(PollStatus::SlowDown),
            "expired_token" => Err("The sign-in request expired. Start again.".to_string()),
            "access_denied" => Err("You declined the sign-in request.".to_string()),
            _ => Err(format!("GitHub returned an unexpected error: {err}")),
        };
    }
    if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
        return Ok(PollStatus::Token(token.to_string()));
    }
    Err("GitHub returned an unrecognized response.".to_string())
}

/// Poll for approval of an in-progress device-flow sign-in. On approval the
/// token is written straight into the existing keychain entry, so everything
/// downstream (`push_with_token`, `workspace_clone_repo`) picks it up without
/// change. The frontend drives the polling cadence and must respect
/// `expires_in` from `github_oauth_start` — it must never poll forever.
#[tauri::command]
pub async fn github_oauth_poll(device_code: String) -> Result<OAuthPollOutcome, String> {
    let client_id = github_client_id().ok_or_else(|| {
        "GitHub sign-in isn't configured. Register an OAuth App with Device Flow enabled and set SPACRON_GITHUB_CLIENT_ID."
            .to_string()
    })?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Spacron")
        .build()
        .map_err(|e| format!("Failed to prepare the request: {e}"))?;
    let resp = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to contact GitHub: {}", e.without_url()))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(format!(
            "GitHub returned an error ({status}) while checking the sign-in."
        ));
    }
    match classify_poll_body(&body)? {
        PollStatus::Pending => Ok(OAuthPollOutcome::Pending),
        PollStatus::SlowDown => Ok(OAuthPollOutcome::SlowDown),
        PollStatus::Token(token) => {
            let token = token.trim().to_string();
            if token.is_empty() || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err("GitHub returned an invalid access token.".to_string());
            }
            token_entry()?
                .set_password(&token)
                .map_err(|e| format!("Failed to save the token: {e}"))?;

            // Backfill login + scopes from the API. The token already works
            // even if this extra round trip fails.
            let mut meta = GithubMeta {
                source: "oauth".to_string(),
                login: String::new(),
                scopes: body
                    .get("scope")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .split_whitespace()
                    .map(|s| s.to_string())
                    .collect(),
            };
            let identity = match fetch_user_identity(&token).await {
                Ok((login, scopes)) => {
                    meta.login = login.clone();
                    meta.scopes = scopes;
                    GithubIdentity {
                        login,
                        scopes: meta.scopes.clone(),
                        source: "oauth".to_string(),
                    }
                }
                Err(_) => GithubIdentity {
                    login: meta.login.clone(),
                    scopes: meta.scopes.clone(),
                    source: "oauth".to_string(),
                },
            };
            let _ = write_github_meta(&meta);
            Ok(OAuthPollOutcome::SignedIn { identity })
        }
    }
}

/// Look up the login and granted scopes for a token. A 401 returns
/// Err(SIGN_IN_EXPIRED) so callers can clear the keychain.
async fn fetch_user_identity(token: &str) -> Result<(String, Vec<String>), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Spacron")
        .build()
        .map_err(|e| format!("Failed to prepare the request: {e}"))?;
    let resp = client
        .get(format!("{GITHUB_API}/user"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Failed to contact GitHub: {}", e.without_url()))?;
    let status = resp.status();
    let scopes = resp
        .headers()
        .get("x-oauth-scopes")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if status.as_u16() == 401 {
        return Err(SIGN_IN_EXPIRED.to_string());
    }
    if !status.is_success() {
        return Err(format!(
            "GitHub returned an error ({status}) while checking the sign-in."
        ));
    }
    let login = body
        .get("login")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((login, scopes))
}

/// The currently signed-in user, if any. Tokens saved before metadata existed
/// (older PAT installs) are backfilled with login + scopes on first call.
#[tauri::command]
pub async fn github_signed_in_user() -> Result<Option<GithubIdentity>, String> {
    // A stored identity (OAuth / gh-cli) is authoritative.
    if let Some(meta) = read_github_meta() {
        if !meta.login.is_empty() {
            return Ok(Some(GithubIdentity {
                login: meta.login,
                scopes: meta.scopes,
                source: meta.source,
            }));
        }
    }
    // A bare token with no metadata gets backfilled.
    let token = match read_token() {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };
    match fetch_user_identity(&token).await {
        Ok((login, scopes)) => {
            let meta = GithubMeta {
                source: read_github_meta()
                    .map(|m| m.source)
                    .unwrap_or_else(|| "pat".to_string()),
                login: login.clone(),
                scopes: scopes.clone(),
            };
            let _ = write_github_meta(&meta);
            Ok(Some(GithubIdentity {
                login,
                scopes,
                source: meta.source,
            }))
        }
        // A dead token must not linger: once cleared, public clones work again
        // and the UI drops back to the signed-out view.
        Err(e) if e == SIGN_IN_EXPIRED => {
            clear_github_credentials();
            Ok(None)
        }
        Err(_) => Ok(None),
    }
}

/// One row of the user's own-repo picker.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct GithubRepo {
    pub full_name: String,
    pub clone_url: String,
    pub private: bool,
    pub updated_at: String,
    pub description: Option<String>,
}

/// The signed-in user's repositories, most recently updated first, following
/// at most two pages (~200 repos).
#[tauri::command]
pub async fn github_list_repos() -> Result<Vec<GithubRepo>, String> {
    let token = read_token()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Spacron")
        .build()
        .map_err(|e| format!("Failed to prepare the request: {e}"))?;

    let mut repos = Vec::new();
    for page in 1..=2u32 {
        let resp = client
            .get(format!("{GITHUB_API}/user/repos"))
            .query(&[
                ("sort", "updated"),
                ("per_page", "100"),
                ("affiliation", "owner,collaborator,organization_member"),
                ("page", &page.to_string()),
            ])
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("Failed to contact GitHub: {}", e.without_url()))?;
        let status = resp.status();
        let has_next = resp
            .headers()
            .get("link")
            .and_then(|v| v.to_str().ok())
            .map(|l| l.contains("rel=\"next\""))
            .unwrap_or(false);
        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if status.as_u16() == 401 {
            clear_github_credentials();
            return Err(SIGN_IN_EXPIRED.to_string());
        }
        if !status.is_success() {
            let msg = body
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(format!(
                "GitHub returned an error ({status}) while listing repositories: {msg}"
            ));
        }
        let page_repos: Vec<GithubRepo> = serde_json::from_value(body.clone())
            .map_err(|_| "GitHub returned an unexpected response.".to_string())?;
        let count = page_repos.len();
        repos.extend(page_repos);
        if count < 100 || !has_next {
            break;
        }
    }
    Ok(repos)
}

fn gh_command() -> Command {
    let mut cmd = Command::new("gh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The token from `gh auth token`, if gh is installed and signed in. The token
/// never leaves the backend — it only ever lands in the keychain.
fn gh_auth_token() -> Result<Option<String>, String> {
    let out = match gh_command().args(["auth", "token"]).output() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to run gh: {e}")),
        Ok(out) => out,
    };
    if !out.status.success() {
        return Ok(None);
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!token.is_empty()).then_some(token))
}

fn gh_user_login() -> Option<String> {
    let out = gh_command()
        .args(["api", "user", "--jq", ".login"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let login = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!login.is_empty()).then_some(login)
}

/// One-click sign-in that pulls the token from the user's existing `gh auth`
/// session straight into the keychain.
#[tauri::command]
pub async fn github_cli_sign_in() -> Result<GithubIdentity, String> {
    let token = gh_auth_token()?.ok_or_else(|| {
        "No GitHub CLI sign-in found. Run `gh auth login` in a terminal first.".to_string()
    })?;
    if token.len() > 512 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like a valid token.".to_string());
    }
    token_entry()?
        .set_password(&token)
        .map_err(|e| format!("Failed to save the token: {e}"))?;

    let gh_login = gh_user_login().unwrap_or_default();
    let (login, scopes) = match fetch_user_identity(&token).await {
        Ok((login, scopes)) => (login, scopes),
        Err(e) if e == SIGN_IN_EXPIRED => {
            clear_github_credentials();
            return Err(
                "Your GitHub CLI sign-in is no longer valid. Run `gh auth login` again.".to_string(),
            );
        }
        Err(_) => (gh_login.clone(), Vec::new()),
    };
    let login = if login.is_empty() { gh_login } else { login };
    let identity = GithubIdentity {
        login: login.clone(),
        scopes: scopes.clone(),
        source: "gh-cli".to_string(),
    };
    let _ = write_github_meta(&GithubMeta {
        source: "gh-cli".to_string(),
        login,
        scopes,
    });
    Ok(identity)
}

/// GitHub repository names allow letters, digits, '-', '_', and '.'.
fn validate_repo_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 100 {
        return Err("Repository name must be 1–100 characters.".to_string());
    }
    if name == "." || name == ".." {
        return Err("Invalid repository name.".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(
            "Repository name may only contain letters, numbers, '-', '_', and '.'.".to_string(),
        );
    }
    Ok(())
}

/// Run a git command, mapping failure to a sanitized error string.
fn run_git(root: &Path, args: &[&str]) -> Result<(), String> {
    let out = git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(sanitize_git_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// True when the git command exits 0 (used as a predicate, output ignored).
fn git_ok(root: &Path, args: &[&str]) -> bool {
    git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Trimmed stdout of a successful git command, else None.
fn git_capture(root: &Path, args: &[&str]) -> Option<String> {
    let out = git_base()
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Push `branch` to origin authenticated with the token. The credential is
/// injected via per-invocation config env vars (GIT_CONFIG_*) rather than the
/// command line or `.git/config`, so it never persists and never appears in a
/// process listing. This guarantees the first push works even when no git
/// credential helper is configured.
fn push_with_token(root: &Path, token: &str, branch: &str) -> Result<(), String> {
    let cred = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let out = git_base()
        .args(["push", "-u", "origin", "--", branch])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {cred}"))
        .output()
        .map_err(|e| format!("Failed to run git push: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(classify_push_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

fn github_api_error(status: reqwest::StatusCode, body: &serde_json::Value, name: &str) -> String {
    let msg = body.get("message").and_then(|v| v.as_str()).unwrap_or("");
    match status.as_u16() {
        401 => {
            // Whatever produced this, the stored credential is dead — clear
            // it so the user is prompted to sign in again instead of being
            // stuck with a token GitHub will never accept.
            clear_github_credentials();
            SIGN_IN_EXPIRED.to_string()
        }
        403 => "GitHub denied the request (403). Your token may lack the 'repo' scope needed to create repositories.".to_string(),
        422 if body.to_string().contains("already exists") => {
            format!("A repository named '{name}' already exists on your account.")
        }
        422 => format!(
            "GitHub couldn't create the repository: {}",
            if msg.is_empty() { "validation failed" } else { msg }
        ),
        _ => format!(
            "GitHub returned an error ({status}): {}",
            if msg.is_empty() { "unknown error" } else { msg }
        ),
    }
}

#[derive(serde::Serialize)]
pub struct CreateRepoResult {
    pub html_url: String,
    pub full_name: String,
    /// Whether an initial commit was pushed (false for an empty project — the
    /// remote is wired up but there was nothing to push yet).
    pub pushed: bool,
}

/// Create a new repository on the authenticated user's GitHub account, wire it up
/// as `origin` for the project, and push the current branch (creating an initial
/// commit if the project has none yet).
#[tauri::command]
pub async fn workspace_github_create_repo(
    project_id: String,
    name: String,
    description: Option<String>,
    private: bool,
    state: State<'_, AppState>,
) -> Result<CreateRepoResult, String> {
    let name = name.trim().to_string();
    validate_repo_name(&name)?;
    let description = description.unwrap_or_default();
    if description.len() > 1000 {
        return Err("Description is too long (limit 1000 characters).".to_string());
    }

    let root_path = {
        let projects = state.workspace_manager.list_projects();
        let project = projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| "Project not found".to_string())?;
        project.root_path.clone()
    };

    let token = read_token()?;

    // Refuse to hijack a project that already points somewhere — avoids
    // silently repointing an existing origin to a brand-new empty repo.
    if git_ok(&root_path, &["remote", "get-url", "origin"]) {
        return Err("This project already has an 'origin' remote. Remove it first if you want to publish to a new repository.".to_string());
    }

    // 1. Create the repository on GitHub.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Spacron")
        .build()
        .map_err(|e| format!("Failed to prepare the request: {e}"))?;

    let resp = client
        .post(format!("{GITHUB_API}/user/repos"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "name": name,
            "description": description,
            "private": private,
            "auto_init": false,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to contact GitHub: {}", e.without_url()))?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(github_api_error(status, &body, &name));
    }

    let clone_url = body
        .get("clone_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let full_name = body
        .get("full_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if clone_url.is_empty() {
        return Err("GitHub created the repository but returned no clone URL.".to_string());
    }

    // 2. Ensure a local git repository exists (default branch: main).
    if !root_path.join(".git").exists() {
        run_git(&root_path, &["init", "-b", "main"])?;
    }

    // 3. Ensure there is at least one commit so there's something to push. Only
    //    commit when files actually staged (an empty folder stays empty).
    if !git_ok(&root_path, &["rev-parse", "--verify", "HEAD"]) {
        run_git(&root_path, &["add", "-A"])?;
        // `diff --cached --quiet` exits non-zero when something is staged.
        if !git_ok(&root_path, &["diff", "--cached", "--quiet"]) {
            run_git(&root_path, &["commit", "-m", "Initial commit"])?;
        }
    }

    // 4. Point origin at the new repository.
    run_git(&root_path, &["remote", "add", "origin", &clone_url])?;

    // 5. Push the initial commit, if there is one.
    let branch = git_capture(&root_path, &["branch", "--show-current"]).unwrap_or_default();
    let mut pushed = false;
    if git_ok(&root_path, &["rev-parse", "--verify", "HEAD"]) && !branch.is_empty() {
        if let Err(e) = push_with_token(&root_path, &token, &branch) {
            // The repo was created and origin wired up; report the push problem
            // without losing that context so the user can retry the push.
            return Err(format!(
                "Repository '{full_name}' was created, but the initial push failed: {e}"
            ));
        }
        pushed = true;
    }

    Ok(CreateRepoResult {
        html_url,
        full_name,
        pushed,
    })
}

/// A GitHub repository reference parsed out of whatever the user pasted.
struct RepoRef {
    /// The URL handed to `git clone` — always normalized to HTTPS so the token
    /// header below is the only credential path and we never touch SSH keys.
    url: String,
    /// Repository name, used as the folder name for the clone.
    name: String,
}

/// Accept the forms people actually paste — the browser URL, the "clone with
/// HTTPS" string, an SSH remote, or bare `owner/repo` — and normalize them all
/// to an HTTPS github.com URL.
///
/// Deliberately strict: the host must be github.com and owner/repo must look
/// like real GitHub identifiers. That keeps this from becoming a "clone any URL"
/// primitive, which would let a pasted string reach an arbitrary host (or, via a
/// leading dash, be read by git as an option rather than a URL).
fn parse_repo_ref(input: &str) -> Result<RepoRef, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter a GitHub repository URL.".to_string());
    }
    if raw.len() > 300 {
        return Err("That URL is too long.".to_string());
    }
    if raw.starts_with('-') {
        return Err("That doesn't look like a GitHub repository URL.".to_string());
    }

    // Strip the transport prefix, leaving `owner/repo` in every accepted form.
    let rest = if let Some(r) = raw.strip_prefix("git@github.com:") {
        r
    } else if let Some(r) = raw.strip_prefix("ssh://git@github.com/") {
        r
    } else if let Some(r) = raw.strip_prefix("https://github.com/") {
        r
    } else if let Some(r) = raw.strip_prefix("http://github.com/") {
        r
    } else if let Some(r) = raw.strip_prefix("github.com/") {
        r
    } else if raw.contains("://") || raw.contains('@') {
        // Some other host, or a userinfo@host form pointing off github.com.
        return Err("Only github.com repositories can be cloned here.".to_string());
    } else {
        raw
    };

    // Drop a trailing `.git`, any fragment/query, and trailing slashes.
    let rest = rest
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);

    let mut parts = rest.split('/');
    let owner = parts.next().unwrap_or("").trim();
    let name = parts.next().unwrap_or("").trim();
    if parts.next().is_some() {
        // A deep link like /owner/repo/tree/main — the repo is still the first
        // two segments, but refuse rather than guess at what the user meant.
        return Err(
            "Use the repository's main URL, not a link to a file or branch inside it.".to_string(),
        );
    }
    if owner.is_empty() || name.is_empty() {
        return Err("That doesn't look like a GitHub repository URL.".to_string());
    }

    // GitHub owners: alphanumeric and single hyphens. Repos additionally allow
    // '_' and '.'. `validate_repo_name` already covers the repo half.
    if owner.len() > 39
        || !owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("That doesn't look like a GitHub repository URL.".to_string());
    }
    validate_repo_name(name)?;

    Ok(RepoRef {
        url: format!("https://github.com/{owner}/{name}.git"),
        name: name.to_string(),
    })
}

/// Clone a GitHub repository into `parent` and open it as a project.
///
/// Auth mirrors `push_with_token`: when a token is saved we inject it as a
/// per-invocation HTTP header via `GIT_CONFIG_*`, so private repos work without
/// the credential ever reaching `.git/config`, the command line, or a process
/// listing. Without a token this still clones public repos.
#[tauri::command(async)]
pub fn workspace_clone_repo(
    url: String,
    parent: String,
    state: State<AppState>,
) -> Result<Project, String> {
    let repo = parse_repo_ref(&url)?;

    let parent_path = std::fs::canonicalize(PathBuf::from(&parent))
        .map(crate::commands::clean_path_buf)
        .map_err(|_| "The selected location does not exist.".to_string())?;
    if !parent_path.is_dir() {
        return Err("The selected location is not a folder.".to_string());
    }

    let target = crate::commands::clean_path_buf(parent_path.join(&repo.name));
    if target.exists() {
        return Err(format!(
            "A folder named \"{}\" already exists here.",
            repo.name
        ));
    }

    // A saved token is a convenience, not a requirement — public clones work
    // without one, so a missing token must not fail the whole operation.
    let token = read_token().ok();

    let mut cmd = git_base();
    cmd.args(["clone", "--progress", "--", &repo.url])
        .arg(&repo.name)
        .current_dir(&parent_path)
        // Fail fast instead of blocking forever on a credential prompt for a
        // private repo we have no token for.
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(token) = &token {
        let cred =
            base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
        cmd.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
            .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {cred}"));
    }

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // git leaves a partial directory behind when a clone dies midway; clear
        // it so a retry doesn't trip the "already exists" check above.
        let _ = std::fs::remove_dir_all(&target);
        return Err(classify_clone_error(&stderr, token.is_some()));
    }

    let root_path = std::fs::canonicalize(&target)
        .map(crate::commands::clean_path_buf)
        .unwrap_or(target);

    state
        .workspace_manager
        .open_project(root_path)
        .map_err(|e| e.to_string())
}

/// Turn git's clone failure into something actionable. The "not found" case is
/// the one worth special-casing: GitHub returns 404 for a private repo you can't
/// see, so the real cause is usually a missing or under-scoped token rather than
/// a typo.
fn classify_clone_error(stderr: &str, had_token: bool) -> String {
    let s = stderr.to_lowercase();
    if s.contains("repository not found") || s.contains("could not read from remote repository") {
        return if had_token {
            "Repository not found. Check the URL, and make sure your GitHub token has access to it (private repos need the 'repo' scope).".to_string()
        } else {
            "Repository not found. If it's private, add a GitHub token in Settings first.".to_string()
        };
    }
    if s.contains("authentication failed") || s.contains("invalid username or password") {
        return "GitHub rejected the saved credentials. Sign in to GitHub again, or update the token in Settings.".to_string();
    }
    if s.contains("could not resolve host") || s.contains("failed to connect") {
        return "Couldn't reach github.com. Check your internet connection.".to_string();
    }
    sanitize_git_error(stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(input: &str) -> RepoRef {
        parse_repo_ref(input).unwrap_or_else(|e| panic!("expected {input:?} to parse, got: {e}"))
    }

    #[test]
    fn accepts_the_forms_people_paste() {
        for input in [
            "https://github.com/anthropics/claude-code",
            "https://github.com/anthropics/claude-code.git",
            "https://github.com/anthropics/claude-code/",
            "http://github.com/anthropics/claude-code",
            "github.com/anthropics/claude-code",
            "git@github.com:anthropics/claude-code.git",
            "ssh://git@github.com/anthropics/claude-code.git",
            "anthropics/claude-code",
            "  https://github.com/anthropics/claude-code  ",
        ] {
            let r = parsed(input);
            assert_eq!(r.url, "https://github.com/anthropics/claude-code.git", "{input}");
            assert_eq!(r.name, "claude-code", "{input}");
        }
    }

    #[test]
    fn strips_query_and_fragment() {
        let r = parsed("https://github.com/owner/repo?tab=readme#install");
        assert_eq!(r.url, "https://github.com/owner/repo.git");
    }

    #[test]
    fn rejects_other_hosts() {
        for input in [
            "https://gitlab.com/owner/repo",
            "https://evil.example/owner/repo",
            "https://github.com.evil.example/owner/repo",
            "git@gitlab.com:owner/repo.git",
            "file:///etc/passwd",
        ] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input}");
        }
    }

    #[test]
    fn rejects_option_lookalikes() {
        // A leading dash would be read by git as a flag rather than a URL.
        for input in ["--upload-pack=touch /tmp/pwned", "-u", "--config=x"] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input}");
        }
    }

    #[test]
    fn rejects_traversal_in_the_repo_name() {
        // The repo name becomes the clone directory, so it must never escape.
        for input in ["owner/..", "owner/.", "../../etc", "owner/sub/dir"] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input}");
        }
    }

    #[test]
    fn rejects_deep_links_rather_than_guessing() {
        assert!(parse_repo_ref("https://github.com/owner/repo/tree/main/src").is_err());
    }

    #[test]
    fn rejects_incomplete_references() {
        for input in ["", "   ", "owner", "https://github.com/", "https://github.com/owner"] {
            assert!(parse_repo_ref(input).is_err(), "should reject {input:?}");
        }
    }

    #[test]
    fn clone_error_points_at_the_token_when_one_is_saved() {
        let with = classify_clone_error("ERROR: Repository not found.", true);
        assert!(with.contains("token has access"), "{with}");
        let without = classify_clone_error("ERROR: Repository not found.", false);
        assert!(without.contains("add a GitHub token"), "{without}");
    }

    #[test]
    fn parses_the_device_code_response() {
        let start = parse_device_code_response(&serde_json::json!({
            "device_code": "dc-123",
            "user_code": "ABCD-EFGH",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5,
        }))
        .unwrap();
        assert_eq!(start.device_code, "dc-123");
        assert_eq!(start.user_code, "ABCD-EFGH");
        assert_eq!(start.verification_uri, "https://github.com/login/device");
        assert_eq!(start.expires_in, 900);
        assert_eq!(start.interval, 5);
    }

    #[test]
    fn rejects_incomplete_device_code_responses() {
        for body in [
            serde_json::Value::Null,
            serde_json::json!({ "device_code": "dc-123" }),
            serde_json::json!({
                "device_code": "dc-123",
                "user_code": "",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 5,
            }),
        ] {
            assert!(
                parse_device_code_response(&body).is_err(),
                "should reject {body:?}"
            );
        }
    }

    #[test]
    fn surfaces_the_device_code_error() {
        let err = parse_device_code_response(&serde_json::json!({
            "error": "invalid_scope",
            "error_description": "The requested scope is invalid.",
        }))
        .unwrap_err();
        assert!(err.contains("invalid_scope"), "{err}");
    }

    #[test]
    fn classifies_poll_authorization_pending_as_wait() {
        assert!(matches!(
            classify_poll_body(&serde_json::json!({ "error": "authorization_pending" })),
            Ok(PollStatus::Pending)
        ));
    }

    #[test]
    fn classifies_poll_slow_down_as_backoff() {
        assert!(matches!(
            classify_poll_body(&serde_json::json!({ "error": "slow_down" })),
            Ok(PollStatus::SlowDown)
        ));
    }

    #[test]
    fn classifies_poll_expired_token_as_fatal() {
        let err = classify_poll_body(&serde_json::json!({ "error": "expired_token" })).unwrap_err();
        assert!(err.contains("expired"), "{err}");
    }

    #[test]
    fn classifies_poll_access_denied_as_fatal() {
        let err = classify_poll_body(&serde_json::json!({ "error": "access_denied" })).unwrap_err();
        assert!(err.contains("declined"), "{err}");
    }

    #[test]
    fn classifies_unknown_poll_error_as_fatal() {
        assert!(classify_poll_body(&serde_json::json!({ "error": "whoknows" })).is_err());
    }

    #[test]
    fn extracts_the_token_from_a_successful_poll() {
        match classify_poll_body(&serde_json::json!({
            "access_token": "gho_abc123",
            "token_type": "bearer",
            "scope": "repo read:user workflow",
        })) {
            Ok(PollStatus::Token(t)) => assert_eq!(t, "gho_abc123"),
            other => panic!("expected a token, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unrecognized_poll_responses() {
        for body in [
            serde_json::Value::Null,
            serde_json::json!({}),
            serde_json::json!({ "foo": "bar" }),
        ] {
            assert!(classify_poll_body(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn client_id_placeholders_are_rejected() {
        // Env vars are process-global; only set and restore the ones we own.
        std::env::remove_var("SPACRON_GITHUB_CLIENT_ID");
        assert_eq!(github_client_id(), None);
        for placeholder in [
            "your_client_id_here",
            "REPLACE_WITH_YOUR_ID",
            "xxx-client-id-xxx",
            "placeholder_client_id",
            "short",
        ] {
            std::env::set_var("SPACRON_GITHUB_CLIENT_ID", placeholder);
            assert_eq!(github_client_id(), None, "{placeholder} must not pass");
        }
        std::env::set_var("SPACRON_GITHUB_CLIENT_ID", "Iv1.a1b2c3d4e5f6a7b8");
        assert_eq!(
            github_client_id().as_deref(),
            Some("Iv1.a1b2c3d4e5f6a7b8")
        );
        std::env::remove_var("SPACRON_GITHUB_CLIENT_ID");
    }
}
