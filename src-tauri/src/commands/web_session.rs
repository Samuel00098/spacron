//! Web-session credentials for the usage meters.
//!
//! Most coding CLIs write a credential file at login and [`super::usage`] reads
//! it. Three providers don't: **OpenCode**, **MiniMax** and **Cursor** meter
//! their plans on a website and authenticate with a browser session cookie,
//! with no CLI-readable token and no API-key route to the same numbers. Orca —
//! which is Electron, and therefore already owns a cookie jar — asks the user
//! to paste a `Cookie` header copied out of DevTools. That works, but it hands
//! a long-lived credential around as plain text and gives the user no way to
//! tell a typo from an expiry.
//!
//! This module does the same job the way a desktop app should: it opens the
//! vendor's **real login page** in a Spacron window, the user signs in there
//! against the vendor's own form, and we lift only the session cookie back out
//! of that webview. Tauri 2.11 exposes `cookies_for_url` on a webview, which is
//! what makes this possible without an embedded browser of our own.
//!
//! ## Rules, which mirror [`super::usage`]'s
//!
//! 1. **Allowlist, never the whole jar.** Only the cookie names in a spec's
//!    `auth_cookies`/`extra_cookies` are ever copied out. A login page sets
//!    analytics and bot-detection cookies too; those are none of our business,
//!    and sending them upstream would leak browsing state the user never offered.
//! 2. **The cookie never crosses into the webview.** Same as rule 2 over there:
//!    the frontend learns *whether* a provider is connected and to which
//!    account, never the credential. Every command here returns a bool, a label,
//!    or unit — never a cookie.
//! 3. **We never type the user's password.** The login page is the vendor's own,
//!    rendered as-is. Spacron watches for the resulting cookie and nothing else;
//!    it does not read, fill, or script the form.
//! 4. **Expiry is reported, not repaired.** A session cookie dies on the
//!    vendor's schedule. When it does, the meter says "Reconnect" — it does not
//!    try to refresh, and it does not fall back to showing a stale number as if
//!    it were current.

use std::time::Duration;

use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Same service name the API keys and remote tokens use (`commands::secrets`).
const KEYCHAIN_SERVICE: &str = "com.samue.spacron";

/// How long the connect window stays open waiting for a sign-in before giving
/// up. Long enough for a password manager, an email code and a 2FA prompt;
/// short enough that a forgotten window doesn't poll forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Gap between cookie checks while the login window is open. The cookie appears
/// the instant the vendor's redirect lands, so this only bounds how long the
/// window lingers after a successful sign-in.
const POLL_INTERVAL: Duration = Duration::from_millis(700);

/// A provider whose usage lives behind a website session rather than a CLI
/// credential file.
pub struct WebSessionSpec {
    /// Matches `ProviderSpec::provider` in [`super::usage`].
    pub provider: &'static str,
    pub name: &'static str,
    /// The vendor's own sign-in page. Opened as-is; never scripted.
    pub login_url: &'static str,
    /// Origin whose cookie jar is read, and the origin the meter calls.
    pub origin: &'static str,
    /// Any one of these present means "signed in". OpenCode sets `auth` or
    /// `__Host-auth` depending on how the session was minted, so presence of
    /// *either* counts.
    pub auth_cookies: &'static [&'static str],
    /// Copied when present, but never sufficient on their own — MiniMax's
    /// group id is routing metadata the usage call needs, not a credential.
    pub extra_cookies: &'static [&'static str],
}

impl WebSessionSpec {
    /// Every cookie name this provider is allowed to take out of the webview.
    /// Anything not named here is left in the jar (rule 1).
    fn allows(&self, name: &str) -> bool {
        self.auth_cookies.contains(&name) || self.extra_cookies.contains(&name)
    }

    fn is_auth_cookie(&self, name: &str) -> bool {
        self.auth_cookies.contains(&name)
    }
}

pub const WEB_SESSIONS: &[WebSessionSpec] = &[
    WebSessionSpec {
        provider: "opencode",
        name: "OpenCode",
        login_url: "https://opencode.ai/auth",
        origin: "https://opencode.ai",
        // Iron Session seals, which arrive as `Fe26.2**…`. `__Host-auth` is the
        // cookie-prefixed form the site sets over HTTPS; both carry the session.
        auth_cookies: &["auth", "__Host-auth"],
        extra_cookies: &[],
    },
    WebSessionSpec {
        provider: "minimax",
        name: "MiniMax",
        login_url: "https://platform.minimax.io/login",
        origin: "https://platform.minimax.io",
        auth_cookies: &["_token"],
        // The usage endpoint routes by group; without it MiniMax answers for
        // the default group, which is the wrong plan for anyone in two orgs.
        extra_cookies: &["minimax_group_id_v2"],
    },
    WebSessionSpec {
        provider: "cursor",
        name: "Cursor",
        // Cursor's auth is WorkOS-backed; the authenticator is the login entry
        // the vendor's own account flows land on, and it redirects back to
        // cursor.com (setting the session cookies there) on success.
        login_url: "https://authenticator.cursor.sh/",
        origin: "https://cursor.com",
        // The WorkOS session token is the account credential. The next-auth
        // pair are the alternative shapes Cursor has shipped across the years
        // (CodexBar treats any one of the three as "signed in"); accepting all
        // three keeps an older session readable until the vendor retires it.
        auth_cookies: &[
            "WorkosCursorSessionToken",
            "__Secure-next-auth.session-token",
            "next-auth.session-token",
        ],
        extra_cookies: &[],
    },
];

pub fn spec_for(provider: &str) -> Option<&'static WebSessionSpec> {
    WEB_SESSIONS.iter().find(|spec| spec.provider == provider)
}

// ---------------------------------------------------------------------------
// Cookie header handling
// ---------------------------------------------------------------------------

/// Split a `Cookie` header into name/value pairs.
///
/// Deliberately tolerant of a trailing `;` and of surrounding whitespace, and
/// deliberately *not* tolerant of anything else — this only ever parses headers
/// we built ourselves in [`build_cookie_header`], so accepting more shapes than
/// that would only widen what a corrupted keychain entry can do.
pub fn parse_cookie_header(header: &str) -> Vec<(String, String)> {
    header
        .split(';')
        .filter_map(|part| {
            let part = part.trim();
            let eq = part.find('=')?;
            let name = part[..eq].trim();
            let value = part[eq + 1..].trim();
            if name.is_empty() || value.is_empty() {
                return None;
            }
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

/// Build the `Cookie` header we store and later send. Order is preserved so a
/// re-connect that yields the same cookies produces the same string.
pub fn build_cookie_header(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Read one cookie's value out of a stored header.
pub fn cookie_value(header: &str, name: &str) -> Option<String> {
    parse_cookie_header(header)
        .into_iter()
        .find(|(candidate, _)| candidate == name)
        .map(|(_, value)| value)
}

/// True when the header carries a credential this provider accepts — not merely
/// some cookie. A header holding only MiniMax's group id is not a session.
pub fn has_auth_cookie(spec: &WebSessionSpec, header: &str) -> bool {
    parse_cookie_header(header)
        .iter()
        .any(|(name, _)| spec.is_auth_cookie(name))
}

/// Keep only the cookies this provider is allowed to take (rule 1).
fn retain_allowed(spec: &WebSessionSpec, pairs: Vec<(String, String)>) -> Vec<(String, String)> {
    pairs
        .into_iter()
        .filter(|(name, _)| spec.allows(name))
        .collect()
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

fn entry_for(provider: &str) -> Result<Entry, String> {
    // `provider` always comes from `WEB_SESSIONS`, never from the caller, but
    // resolve through the table anyway so a future caller can't smuggle an
    // arbitrary string into a keychain account name.
    let spec = spec_for(provider).ok_or_else(|| "Unknown provider".to_string())?;
    Entry::new(KEYCHAIN_SERVICE, &format!("web_session_{}", spec.provider))
        .map_err(|err| format!("Failed to access the system keychain: {err}"))
}

/// Read a stored session header.
///
/// Deliberately **not** a `#[tauri::command]` and deliberately not reachable
/// from the webview — it returns the raw credential. `commands::secrets`'
/// `provider_api_key_get` carries the same warning and for the same reason: one
/// `invoke` away from handing every session cookie to anything running in the
/// WebView. The meters call this from Rust; the frontend gets
/// [`web_session_status`].
pub(crate) fn stored_cookie(provider: &str) -> Option<String> {
    let entry = entry_for(provider).ok()?;
    match entry.get_password() {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        Err(_) => None,
    }
}

fn store_cookie(provider: &str, header: &str) -> Result<(), String> {
    entry_for(provider)?
        .set_password(header)
        .map_err(|err| format!("Failed to save the session: {err}"))
}

fn clear_cookie(provider: &str) -> Result<(), String> {
    match entry_for(provider)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("Failed to remove the session: {err}")),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionStatus {
    pub provider: String,
    pub name: String,
    /// Whether a usable session cookie is stored. Never the cookie itself.
    pub connected: bool,
}

/// Which web-linked providers exist and whether each is connected.
#[tauri::command(async)]
pub async fn web_session_list() -> Vec<WebSessionStatus> {
    WEB_SESSIONS
        .iter()
        .map(|spec| WebSessionStatus {
            provider: spec.provider.to_string(),
            name: spec.name.to_string(),
            connected: stored_cookie(spec.provider)
                .map(|header| has_auth_cookie(spec, &header))
                .unwrap_or(false),
        })
        .collect()
}

/// Open the vendor's login page and wait for a session cookie to appear.
///
/// Returns `true` once a credential was captured and stored, `false` if the user
/// closed the window or the wait timed out. Both are ordinary outcomes — closing
/// the window is how you cancel — so neither is an error.
#[tauri::command(async)]
pub async fn web_session_connect(app: AppHandle, provider: String) -> Result<bool, String> {
    let spec = spec_for(&provider).ok_or_else(|| "Unknown provider".to_string())?;

    let label = format!("spacron-connect-{}", spec.provider);
    // A second click while the first window is open should focus it, not stack
    // another login window on top of it.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(false);
    }

    let url: tauri::Url = spec
        .login_url
        .parse()
        .map_err(|_| "Invalid login URL".to_string())?;

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title(format!("Sign in to {}", spec.name))
        .inner_size(520.0, 720.0)
        .resizable(true)
        .build()
        .map_err(|err| format!("Could not open the sign-in window: {err}"))?;

    let captured = wait_for_session(&app, spec, &label).await;

    // Close the window whichever way this ended. A left-open login window after
    // a successful connect reads as "it didn't work".
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    } else {
        let _ = window.close();
    }

    match captured {
        Some(header) => {
            store_cookie(&provider, &header)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Poll the login window's cookie jar until a credential shows up, the user
/// closes the window, or [`CONNECT_TIMEOUT`] elapses.
async fn wait_for_session(
    app: &AppHandle,
    spec: &'static WebSessionSpec,
    label: &str,
) -> Option<String> {
    let origin: tauri::Url = spec.origin.parse().ok()?;
    let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;

    while std::time::Instant::now() < deadline {
        tokio::time::sleep(POLL_INTERVAL).await;

        // The user closing the window is a cancel, and it is the only way to
        // cancel — so check for it before anything else.
        let Some(window) = app.get_webview_window(label) else {
            return None;
        };

        let origin = origin.clone();
        // Off the calling thread on purpose: reading cookies from a webview
        // deadlocks on Windows when done synchronously on the wrong thread
        // (wry#583). The documented fix is an async command plus a separate
        // thread, which is exactly this.
        let cookies = tauri::async_runtime::spawn_blocking(move || {
            window
                .cookies_for_url(origin)
                .map(|cookies| {
                    cookies
                        .into_iter()
                        .map(|cookie| {
                            (cookie.name().to_string(), cookie.value().to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .await
        .unwrap_or_default();

        let allowed = retain_allowed(spec, cookies);
        if allowed.is_empty() {
            continue;
        }
        let header = build_cookie_header(&allowed);
        // Only stop once a real credential is present. The site sets its
        // routing and analytics cookies well before the user has signed in, so
        // "any allowed cookie" would capture a logged-out session and then
        // report a puzzling 401 later.
        if has_auth_cookie(spec, &header) {
            return Some(header);
        }
    }

    None
}

/// Forget a stored session. The vendor's own session is untouched — this only
/// removes Spacron's copy.
#[tauri::command(async)]
pub async fn web_session_disconnect(provider: String) -> Result<(), String> {
    clear_cookie(&provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opencode() -> &'static WebSessionSpec {
        spec_for("opencode").expect("opencode spec")
    }

    fn minimax() -> &'static WebSessionSpec {
        spec_for("minimax").expect("minimax spec")
    }

    fn cursor() -> &'static WebSessionSpec {
        spec_for("cursor").expect("cursor spec")
    }

    #[test]
    fn a_cookie_header_round_trips() {
        let pairs = vec![
            ("auth".to_string(), "Fe26.2**abc".to_string()),
            ("other".to_string(), "1".to_string()),
        ];
        let header = build_cookie_header(&pairs);
        assert_eq!(header, "auth=Fe26.2**abc; other=1");
        assert_eq!(parse_cookie_header(&header), pairs);
    }

    #[test]
    fn parsing_survives_stray_separators_and_spacing() {
        let parsed = parse_cookie_header("  auth = abc ;; _token=xyz;  ");
        assert_eq!(
            parsed,
            vec![
                ("auth".to_string(), "abc".to_string()),
                ("_token".to_string(), "xyz".to_string()),
            ]
        );
    }

    #[test]
    fn only_allowlisted_cookies_are_taken_out_of_the_jar() {
        // A real login page hands back analytics and bot-detection cookies
        // alongside the session. Rule 1: they stay in the jar.
        let jar = vec![
            ("_abck".to_string(), "bot-detection".to_string()),
            ("_token".to_string(), "the-session".to_string()),
            ("ga_tracking".to_string(), "nope".to_string()),
            ("minimax_group_id_v2".to_string(), "grp_1".to_string()),
        ];
        let kept = retain_allowed(minimax(), jar);
        assert_eq!(
            kept,
            vec![
                ("_token".to_string(), "the-session".to_string()),
                ("minimax_group_id_v2".to_string(), "grp_1".to_string()),
            ]
        );
    }

    #[test]
    fn either_opencode_cookie_name_counts_as_a_session() {
        assert!(has_auth_cookie(opencode(), "auth=Fe26.2**abc"));
        assert!(has_auth_cookie(opencode(), "__Host-auth=Fe26.2**abc"));
    }

    #[test]
    fn any_cursor_session_cookie_shape_counts_as_a_session() {
        // Cursor has shipped three session cookie names; each alone is a real
        // credential, and none is a routing/analytics cookie.
        assert!(has_auth_cookie(
            cursor(),
            "WorkosCursorSessionToken=user%3A%3Ajwt"
        ));
        assert!(has_auth_cookie(
            cursor(),
            "__Secure-next-auth.session-token=abc"
        ));
        assert!(has_auth_cookie(cursor(), "next-auth.session-token=abc"));
        // A stray analytics cookie is not a session.
        assert!(!has_auth_cookie(cursor(), "_abck=bot-detection"));
    }

    #[test]
    fn a_group_id_alone_is_not_a_session() {
        // MiniMax sets the group cookie before sign-in completes. Treating it
        // as a credential would close the login window too early and store a
        // header that 401s on first use.
        assert!(!has_auth_cookie(minimax(), "minimax_group_id_v2=grp_1"));
        assert!(has_auth_cookie(
            minimax(),
            "_token=abc; minimax_group_id_v2=grp_1"
        ));
    }

    #[test]
    fn a_named_cookie_can_be_read_back_out() {
        let header = "_token=abc; minimax_group_id_v2=grp_9";
        assert_eq!(cookie_value(header, "_token").as_deref(), Some("abc"));
        assert_eq!(
            cookie_value(header, "minimax_group_id_v2").as_deref(),
            Some("grp_9")
        );
        assert_eq!(cookie_value(header, "absent"), None);
    }

    #[test]
    fn an_unknown_provider_has_no_spec_and_no_keychain_entry() {
        assert!(spec_for("claude").is_none());
        assert!(entry_for("../../etc/passwd").is_err());
    }
}
