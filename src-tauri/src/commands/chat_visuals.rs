//! Inline interactive visuals in the terminal chat view (Orca's model, see
//! `.spacron/memory/orca-chat-view.md`).
//!
//! An agent writes one self-contained HTML page into its chat's scratch folder
//! (`$SPACRON_CHAT_VISUALS_DIR`) and puts `::spacron-visual{file="x.html"}` on
//! a line of its reply. The chat shows that page inline, live and interactive.
//!
//! Why a local server instead of an `iframe srcdoc`: a srcdoc document inherits
//! the app's CSP (`script-src 'self'`), so the page's own scripts could never
//! run. Served from `http://127.0.0.1:<port>` (which the app CSP allows as a
//! frame) the page gets its own origin and its own, stricter policy below, and
//! the iframe is sandboxed without `allow-same-origin` on top.

use axum::extract::Path as AxumPath;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Largest visual page served, as in Orca.
const MAX_VISUAL_BYTES: u64 = 512 * 1024;

/// Scripts, styles and fonts may load only from these (Orca's allowlist).
/// `connect-src 'none'`: a visual cannot call out; data must be inline.
const CSP: &str = "default-src 'none'; \
script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh; \
style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://fonts.googleapis.com; \
font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; \
img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src blob:; \
form-action 'none'; base-uri 'none'";

struct Server {
    port: u16,
    secret: String,
}

static SERVER: OnceLock<Server> = OnceLock::new();

fn visuals_root() -> PathBuf {
    std::env::temp_dir().join("spacron").join("chat-visuals")
}

/// `[A-Za-z0-9-]{1,64}`: a chat key, one folder under the visuals root.
fn is_safe_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// One bare `.html` file name (Orca's rule): no directories, traversal, or Windows device names.
pub fn is_safe_visual_file(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 || name.contains("..") || !name.ends_with(".html") {
        return false;
    }
    let mut chars = name.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return false;
    }
    let base = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    let device = matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || ((base.starts_with("com") || base.starts_with("lpt")) && base.len() == 4 && base.as_bytes()[3].is_ascii_digit());
    !device
}

/// Added to every page, ahead of its own markup: base styles, the app theme
/// (passed in the URL fragment so it updates without a reload), and a height
/// report so the chat can size the frame to the content.
const SHELL_HEAD: &str = r#"<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:0;background:transparent}body{color:var(--foreground,#e5e7eb);font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;line-height:1.5;padding:12px}</style>
<script>(function(){
var channel=new URLSearchParams(location.search).get('c')||'';
function applyTheme(){try{var t=JSON.parse(decodeURIComponent(location.hash.slice(1)||'%7B%7D'));var r=document.documentElement;for(var k in t){if(/^--[a-z0-9-]+$/.test(k))r.style.setProperty(k,String(t[k]).replace(/[;{}<>]/g,''))}if(t['color-scheme'])r.style.colorScheme=t['color-scheme']}catch(e){}}
applyTheme();window.addEventListener('hashchange',applyTheme);
window.spacron={compose:function(t){parent.postMessage({spacronVisual:channel,action:'compose',text:String(t==null?'':t).slice(0,4000)},'*')}};
var last=0;function report(){var b=document.body;if(!b)return;var h=Math.ceil(b.getBoundingClientRect().height+parseFloat(getComputedStyle(b).marginTop||0)+parseFloat(getComputedStyle(b).marginBottom||0));if(Math.abs(h-last)>1){last=h;parent.postMessage({spacronVisual:channel,height:h},'*')}}
var ro=new ResizeObserver(report);ro.observe(document.documentElement);document.addEventListener('DOMContentLoaded',function(){ro.observe(document.body);report()});window.addEventListener('load',report);setInterval(report,1000);
})();</script>"#;

/// Put the shell right after `<head>` (or first, for a fragment) so it applies before the page's own markup.
fn wrap_page(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(head) = lower.find("<head") {
        if let Some(close) = lower[head..].find('>') {
            let at = head + close + 1;
            return format!("{}{}{}", &html[..at], SHELL_HEAD, &html[at..]);
        }
    }
    format!("<!doctype html><html><head>{SHELL_HEAD}</head><body>{html}</body></html>")
}

async fn serve_visual(AxumPath((secret, key, file)): AxumPath<(String, String, String)>) -> Response {
    let Some(server) = SERVER.get() else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    if secret != server.secret || !is_safe_key(&key) || !is_safe_visual_file(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = visuals_root().join(&key).join(&file);
    let Ok(meta) = tokio::fs::metadata(&path).await else { return StatusCode::NOT_FOUND.into_response() };
    if !meta.is_file() || meta.len() > MAX_VISUAL_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Visual too large (512 KB max)").into_response();
    }
    let Ok(html) = tokio::fs::read_to_string(&path).await else { return StatusCode::NOT_FOUND.into_response() };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    (headers, wrap_page(&html)).into_response()
}

async fn ensure_server() -> Result<&'static Server, String> {
    if let Some(server) = SERVER.get() {
        return Ok(server);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let secret = uuid::Uuid::new_v4().simple().to_string();
    if SERVER.set(Server { port, secret }).is_err() {
        // Another call won the race; its server is the one in use.
        return SERVER.get().ok_or_else(|| "visuals server unavailable".to_string());
    }
    let app = Router::new().route("/v/{secret}/{key}/{file}", get(serve_visual));
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    SERVER.get().ok_or_else(|| "visuals server unavailable".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatVisualsSpot {
    /// The folder the agent writes pages into (`$SPACRON_CHAT_VISUALS_DIR`).
    pub dir: String,
    /// The URL prefix a page in that folder is served under.
    pub base_url: String,
}

/// Make (or reuse) the scratch folder for one chat and return where its pages are served.
#[tauri::command]
pub async fn chat_visuals_prepare(key: String) -> Result<ChatVisualsSpot, String> {
    if !is_safe_key(&key) {
        return Err("Invalid chat key".into());
    }
    let server = ensure_server().await?;
    let dir = visuals_root().join(&key);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    Ok(ChatVisualsSpot {
        dir: dir.to_string_lossy().to_string(),
        base_url: format!("http://127.0.0.1:{}/v/{}/{}/", server.port, server.secret, key),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bare_html_names() {
        assert!(is_safe_visual_file("latency-by-region-7c1e.html"));
        assert!(is_safe_visual_file("chart_1.v2.html"));
        assert!(!is_safe_visual_file("../secret.html"));
        assert!(!is_safe_visual_file("dir/chart.html"));
        assert!(!is_safe_visual_file("C:chart.html"));
        assert!(!is_safe_visual_file(".hidden.html"));
        assert!(!is_safe_visual_file("chart.js"));
        assert!(!is_safe_visual_file("con.html"));
        assert!(!is_safe_visual_file("COM1.html"));
    }

    #[test]
    fn keys_are_single_safe_segments() {
        assert!(is_safe_key("3f2c-91aa"));
        assert!(!is_safe_key("../x"));
        assert!(!is_safe_key(""));
    }

    #[tokio::test]
    async fn serves_a_page_with_its_policy_and_refuses_others() {
        let key = format!("test-{}", uuid::Uuid::new_v4().simple());
        let spot = chat_visuals_prepare(key.clone()).await.expect("prepare");
        std::fs::write(PathBuf::from(&spot.dir).join("chart.html"), "<div id=x>hello</div>").unwrap();

        let page = reqwest::get(format!("{}chart.html?c=abc", spot.base_url)).await.unwrap();
        assert_eq!(page.status(), 200);
        let csp = page.headers().get("content-security-policy").unwrap().to_str().unwrap().to_string();
        assert!(csp.contains("connect-src 'none'"));
        let body = page.text().await.unwrap();
        assert!(body.contains("<div id=x>hello</div>") && body.contains("spacronVisual"));

        let missing = reqwest::get(format!("{}nope.html", spot.base_url)).await.unwrap();
        assert_eq!(missing.status(), 404);
        let wrong_secret = spot.base_url.replace("/v/", "/v/x");
        assert_eq!(reqwest::get(format!("{wrong_secret}chart.html")).await.unwrap().status(), 404);
        let _ = std::fs::remove_dir_all(&spot.dir);
    }

    #[test]
    fn shell_goes_inside_head_or_wraps_a_fragment() {
        let page = wrap_page("<html><head><title>x</title></head><body>hi</body></html>");
        assert!(page.find("spacronVisual").unwrap() < page.find("<title>").unwrap());
        let fragment = wrap_page("<div>hi</div>");
        assert!(fragment.starts_with("<!doctype html>") && fragment.contains("<div>hi</div>"));
    }
}
