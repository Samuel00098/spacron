//! Sign-in (OAuth 2.1) for remote MCP servers, and the grant store that
//! Spacron's MCP proxy reads.
//!
//! Most hosted MCP servers (Linear, Notion, Figma, Vercel, …) take no API key:
//! the client signs the user in through the browser. Agent CLIs each do that
//! on their own, at first use, and Spacron's chat could not do it at all. This
//! module does it once, up front, from Settings > MCP:
//!
//! 1. Discover the authorization server — the MCP authorization spec's
//!    protected-resource metadata (RFC 9728), from the server's 401
//!    `WWW-Authenticate` or its well-known path, then RFC 8414 metadata.
//! 2. Register Spacron as a public client (RFC 7591 dynamic registration).
//! 3. Open the user's own browser on the authorize URL (PKCE S256), and catch
//!    the redirect on a one-shot loopback listener (RFC 8252).
//! 4. Exchange the code and keep the grant in `<config>/mcp-oauth/<key>.json`,
//!    owner-only.
//!
//! Agents never see the token. Their config points at
//! `http://127.0.0.1:<port>/proxy/<key>`, and the MCP server forwards each
//! request to the signed-in URL with a fresh access token (see
//! `mcp::proxy_handler`). That is the only arrangement that survives tokens
//! expiring under a long-running agent: a token written into a config file
//! would die an hour later with no way to tell the agent.
//!
//! The proxy forwards only to the URL the user signed in to, stored in the
//! grant — never to anything a request names.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

/// How long the browser step may take before the sign-in is abandoned.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Refresh this long before the access token actually expires.
const REFRESH_MARGIN_SECS: u64 = 60;

#[derive(Clone, Serialize, Deserialize)]
pub struct Grant {
    /// The MCP server URL the user signed in to. The proxy's only target.
    pub resource: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds; `None` when the server did not say.
    #[serde(default)]
    pub expires_at: Option<u64>,
    pub token_endpoint: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Grant keys are config keys (`spacron-linear`); anything else could name a
/// path outside the store.
fn valid_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 100 || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("invalid MCP server key: {key}"));
    }
    Ok(())
}

fn store_dir() -> PathBuf {
    crate::mcp::config_dir().join("mcp-oauth")
}

fn grant_path(key: &str) -> PathBuf {
    store_dir().join(format!("{key}.json"))
}

pub fn load_grant(key: &str) -> Option<Grant> {
    valid_key(key).ok()?;
    let text = std::fs::read_to_string(grant_path(key)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_grant(key: &str, grant: &Grant) -> Result<(), String> {
    valid_key(key)?;
    std::fs::create_dir_all(store_dir()).map_err(|e| format!("could not create the sign-in store: {e}"))?;
    let text = serde_json::to_string(grant).map_err(|e| e.to_string())?;
    crate::mcp::write_private_file(&grant_path(key), &text).map_err(|e| format!("could not save the sign-in: {e}"))
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap_or_default()
    })
}

fn cancellations() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One refresh at a time per process, so two proxied requests that both find
/// the token stale do not both spend the (often single-use) refresh token.
fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct AuthServerMeta {
    authorization_endpoint: Option<String>,
    token_endpoint: Option<String>,
    registration_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

/// `resource_metadata="…"` from a `WWW-Authenticate: Bearer …` header.
fn resource_metadata_from_challenge(header: &str) -> Option<String> {
    let at = header.find("resource_metadata=")?;
    let rest = &header[at + "resource_metadata=".len()..];
    let value = if let Some(stripped) = rest.strip_prefix('"') {
        stripped.split('"').next()?
    } else {
        rest.split([',', ' ']).next()?
    };
    Some(value.to_string()).filter(|v| !v.is_empty())
}

/// RFC 8615 well-known URLs for `base`: with the path inserted after the
/// well-known segment first, then at the origin root.
fn well_known(base: &url::Url, suffix: &str) -> Vec<String> {
    let origin = base.origin().ascii_serialization();
    let path = base.path().trim_end_matches('/');
    let mut out = Vec::new();
    if !path.is_empty() {
        out.push(format!("{origin}/.well-known/{suffix}{path}"));
    }
    out.push(format!("{origin}/.well-known/{suffix}"));
    out
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Option<T> {
    let res = http().get(url).header("Accept", "application/json").send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<T>().await.ok()
}

/// The authorization server for `resource` and the scopes it advertises.
async fn discover(resource: &url::Url) -> Result<(AuthServerMeta, Vec<String>), String> {
    #[derive(Deserialize, Default)]
    struct ResourceMeta {
        #[serde(default)]
        authorization_servers: Vec<String>,
        #[serde(default)]
        scopes_supported: Vec<String>,
    }

    // An unauthenticated initialize is the probe the spec describes: the 401
    // names the metadata document.
    let probe = http()
        .post(resource.as_str())
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "Spacron", "version": env!("CARGO_PKG_VERSION") } }
        }))
        .send()
        .await
        .map_err(|e| format!("could not reach {}: {e}", resource))?;
    let challenge = probe
        .headers()
        .get(reqwest::header::WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok())
        .and_then(resource_metadata_from_challenge);

    let mut candidates: Vec<String> = challenge.into_iter().collect();
    candidates.extend(well_known(resource, "oauth-protected-resource"));
    let mut resource_meta = ResourceMeta::default();
    for url in candidates {
        if let Some(meta) = get_json::<ResourceMeta>(&url).await {
            if !meta.authorization_servers.is_empty() {
                resource_meta = meta;
                break;
            }
        }
    }

    // Servers from before RFC 9728 was adopted act as their own
    // authorization server.
    let issuer = match resource_meta.authorization_servers.first() {
        Some(issuer) => url::Url::parse(issuer).map_err(|_| format!("bad authorization server URL: {issuer}"))?,
        None => url::Url::parse(&resource.origin().ascii_serialization()).map_err(|e| e.to_string())?,
    };
    let mut urls = well_known(&issuer, "oauth-authorization-server");
    urls.extend(well_known(&issuer, "openid-configuration"));
    let issuer_text = issuer.as_str().trim_end_matches('/').to_string();
    urls.push(format!("{issuer_text}/.well-known/openid-configuration"));
    for url in urls {
        if let Some(meta) = get_json::<AuthServerMeta>(&url).await {
            if meta.authorization_endpoint.is_some() && meta.token_endpoint.is_some() {
                return Ok((meta, resource_meta.scopes_supported));
            }
        }
    }
    Err(format!("{} does not publish how to sign in (no OAuth metadata found).", resource.host_str().unwrap_or("The server")))
}

// ---------------------------------------------------------------------------
// The browser round trip
// ---------------------------------------------------------------------------

fn pkce_pair() -> (String, String) {
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn page(title: &str, body: &str) -> String {
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title>\
         <body style=\"font:15px system-ui;background:#101010;color:#eee;display:grid;place-items:center;height:90vh\">\
         <div style=\"text-align:center\"><h2 style=\"font-weight:600\">{title}</h2><p style=\"color:#aaa\">{body}</p></div>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    )
}

/// Wait for the browser to come back to the loopback redirect, and return the
/// authorization code. Requests for anything but `/callback` (a favicon) are
/// answered and ignored.
async fn await_redirect(listener: tokio::net::TcpListener, state: &str, server_name: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = socket.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let Ok(parsed) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { continue };
        if parsed.path() != "/callback" {
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        if params.get("state").map(String::as_str) != Some(state) {
            let _ = socket.write_all(page("Sign-in did not match", "Start the sign-in again from Spacron.").as_bytes()).await;
            return Err("the sign-in reply did not match this request".into());
        }
        if let Some(error) = params.get("error") {
            let detail = params.get("error_description").cloned().unwrap_or_else(|| error.clone());
            let _ = socket.write_all(page("Sign-in was not completed", &html_escape(&detail)).as_bytes()).await;
            return Err(if error == "access_denied" { "cancelled: sign-in was declined".into() } else { format!("sign-in failed: {detail}") });
        }
        let Some(code) = params.get("code").cloned() else {
            let _ = socket.write_all(page("Sign-in failed", "No authorization code came back.").as_bytes()).await;
            return Err("no authorization code came back".into());
        };
        let message = format!("You are signed in to {}. You can close this tab and go back to Spacron.", html_escape(server_name));
        let _ = socket.write_all(page("Signed in", &message).as_bytes()).await;
        return Ok(code);
    }
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

async fn token_request(endpoint: &str, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let res = http()
        .post(endpoint)
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| format!("could not reach the token endpoint: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("the server refused the token request ({status}): {}", text.chars().take(240).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|_| "the token response was not understood".to_string())
}

async fn sign_in_flow(app: &tauri::AppHandle, key: &str, resource_text: &str, server_name: &str) -> Result<(), String> {
    let resource = url::Url::parse(resource_text).map_err(|_| "that is not a valid URL".to_string())?;
    if resource.scheme() != "https" {
        return Err("only https servers can be signed in to".into());
    }
    let (meta, resource_scopes) = discover(&resource).await?;
    let authorization_endpoint = meta.authorization_endpoint.clone().unwrap_or_default();
    let token_endpoint = meta.token_endpoint.clone().unwrap_or_default();
    let registration_endpoint = meta.registration_endpoint.clone().ok_or_else(|| {
        format!("{server_name} does not let new apps register, so Spacron cannot sign in to it. Agents that have their own sign-in for it (Claude Code, Codex) still can.")
    })?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    #[derive(Deserialize)]
    struct Registration {
        client_id: String,
        #[serde(default)]
        client_secret: Option<String>,
    }
    let registration: Registration = {
        let res = http()
            .post(&registration_endpoint)
            .json(&serde_json::json!({
                "client_name": "Spacron",
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            }))
            .send()
            .await
            .map_err(|e| format!("could not register with {server_name}: {e}"))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("{server_name} refused to register Spacron ({status}): {}", text.chars().take(200).collect::<String>()));
        }
        serde_json::from_str(&text).map_err(|_| "the registration response was not understood".to_string())?
    };

    let (verifier, challenge) = pkce_pair();
    let state = uuid::Uuid::new_v4().simple().to_string();
    let scopes = if !resource_scopes.is_empty() { resource_scopes } else { meta.scopes_supported.clone() };
    let mut authorize = url::Url::parse(&authorization_endpoint).map_err(|_| "bad authorization endpoint".to_string())?;
    {
        let mut q = authorize.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &registration.client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", resource.as_str());
        if !scopes.is_empty() {
            q.append_pair("scope", &scopes.join(" "));
        }
    }

    {
        use tauri_plugin_shell::ShellExt;
        #[allow(deprecated)]
        app.shell()
            .open(authorize.as_str(), None)
            .map_err(|e| format!("could not open your browser: {e}"))?;
    }

    let (tx, mut rx) = watch::channel(false);
    cancellations().lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_string(), tx);
    let outcome = tokio::select! {
        code = await_redirect(listener, &state, server_name) => code,
        _ = rx.changed() => Err("cancelled: sign-in was cancelled".into()),
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err("timeout: the browser sign-in was not finished within 5 minutes".into()),
    };
    cancellations().lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    let code = outcome?;

    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", registration.client_id.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", resource.as_str()),
    ];
    if let Some(secret) = registration.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let tokens = token_request(&token_endpoint, &form).await?;
    save_grant(
        key,
        &Grant {
            resource: resource.as_str().to_string(),
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: tokens.expires_in.map(|s| now() + s),
            token_endpoint,
            client_id: registration.client_id,
            client_secret: registration.client_secret,
        },
    )
}

// ---------------------------------------------------------------------------
// Tokens for the proxy
// ---------------------------------------------------------------------------

async fn refresh(key: &str, grant: &Grant) -> Result<Grant, String> {
    let refresh_token = grant.refresh_token.clone().ok_or("signed_out: the sign-in expired")?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", grant.client_id.as_str()),
        ("resource", grant.resource.as_str()),
    ];
    if let Some(secret) = grant.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let tokens = token_request(&grant.token_endpoint, &form)
        .await
        .map_err(|e| format!("signed_out: {e}"))?;
    let next = Grant {
        access_token: tokens.access_token,
        // Servers that rotate refresh tokens send a new one; others expect the
        // old one to keep working.
        refresh_token: tokens.refresh_token.or(Some(refresh_token)),
        expires_at: tokens.expires_in.map(|s| now() + s),
        ..grant.clone()
    };
    save_grant(key, &next)?;
    Ok(next)
}

/// A usable grant for `key`, refreshed first when it is about to expire (or
/// unconditionally with `force`, after the server rejected the token).
pub async fn fresh_grant(key: &str, force: bool) -> Result<Grant, String> {
    let _guard = refresh_lock().lock().await;
    let grant = load_grant(key).ok_or("signed_out: not signed in")?;
    let stale = grant.expires_at.is_some_and(|at| at <= now() + REFRESH_MARGIN_SECS);
    if force || stale {
        return refresh(key, &grant).await;
    }
    Ok(grant)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Sign in to an MCP server in the user's browser. Resolves once the grant is
/// saved, or with an error (`cancelled:` / `timeout:` prefixes are the user's
/// doing and need no alarm).
#[tauri::command]
pub async fn mcp_oauth_sign_in(app: tauri::AppHandle, key: String, url: String, name: String) -> Result<(), String> {
    valid_key(&key)?;
    sign_in_flow(&app, &key, url.trim(), &name).await
}

/// Whether a hosted MCP server wants a sign-in: it answers an unauthenticated
/// initialize with 401. Used when installing a plugin's servers, which carry
/// no auth hint of their own.
#[tauri::command]
pub async fn mcp_oauth_needs_sign_in(url: String) -> Result<bool, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "that is not a valid URL".to_string())?;
    if parsed.scheme() != "https" {
        return Ok(false);
    }
    let res = http()
        .post(parsed.as_str())
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "Spacron", "version": env!("CARGO_PKG_VERSION") } }
        }))
        .send()
        .await
        .map_err(|e| format!("could not reach {parsed}: {e}"))?;
    Ok(res.status() == reqwest::StatusCode::UNAUTHORIZED)
}

#[tauri::command]
pub fn mcp_oauth_cancel(key: String) {
    if let Some(tx) = cancellations().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        let _ = tx.send(true);
    }
}

/// Which of `keys` have a saved sign-in. A grant whose access token expired
/// but can still be refreshed counts as signed in.
#[tauri::command]
pub fn mcp_oauth_status(keys: Vec<String>) -> HashMap<String, bool> {
    keys.into_iter()
        .map(|key| {
            let signed_in = load_grant(&key).is_some_and(|g| {
                g.refresh_token.is_some() || g.expires_at.is_none_or(|at| at > now())
            });
            (key, signed_in)
        })
        .collect()
}

#[tauri::command]
pub fn mcp_oauth_sign_out(key: String) -> Result<(), String> {
    valid_key(&key)?;
    match std::fs::remove_file(grant_path(&key)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not sign out: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_resource_metadata_from_a_challenge() {
        let h = r#"Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp""#;
        assert_eq!(
            resource_metadata_from_challenge(h).as_deref(),
            Some("https://mcp.example.com/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(resource_metadata_from_challenge("Bearer realm=\"x\""), None);
    }

    #[test]
    fn builds_path_aware_well_known_urls_first() {
        let u = url::Url::parse("https://mcp.linear.app/mcp").unwrap();
        assert_eq!(
            well_known(&u, "oauth-protected-resource"),
            vec![
                "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp".to_string(),
                "https://mcp.linear.app/.well-known/oauth-protected-resource".to_string(),
            ]
        );
        let root = url::Url::parse("https://mcp.stripe.com").unwrap();
        assert_eq!(well_known(&root, "x"), vec!["https://mcp.stripe.com/.well-known/x".to_string()]);
    }

    #[test]
    fn pkce_challenge_is_the_s256_of_the_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert!(verifier.len() >= 43);
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
    }

    #[test]
    fn rejects_keys_that_could_escape_the_store() {
        assert!(valid_key("spacron-linear").is_ok());
        assert!(valid_key("../x").is_err());
        assert!(valid_key("a/b").is_err());
        assert!(valid_key("").is_err());
    }
}
