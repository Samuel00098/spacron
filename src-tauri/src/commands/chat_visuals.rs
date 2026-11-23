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
/// (initially in the URL fragment, with live updates over the bridge), and a height
/// report so the chat can size the frame to the content.
const SHELL_HEAD: &str = r#"<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html{color-scheme:light dark}
html,body{margin:0;background:var(--background,light-dark(#efefef,#101010));color:var(--foreground,light-dark(#171717,#e5e7eb))}
/* Keep scrolling inside the visual and match the quiet chat scrollbar. */
:where(html,body,body *){
  overscroll-behavior:none!important;
  scrollbar-width:thin;
  scrollbar-color:color-mix(in srgb,var(--foreground,light-dark(#171717,#f4f4f5)) 22%,transparent) transparent;
}
::-webkit-scrollbar{width:6px;height:6px;background:transparent}
::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--foreground,light-dark(#171717,#f4f4f5)) 22%,transparent);border-radius:999px}
body{font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;line-height:1.55;padding:16px}
html[data-spacron-layout=inline] body{padding:10px 4px}
button,input,select,textarea{box-sizing:border-box;max-width:100%;font:inherit;color:var(--foreground,light-dark(#171717,#e5e7eb));accent-color:var(--accent,light-dark(#5345c7,#a49aff));background:var(--card,light-dark(#f8f8f8,#191919));border:1px solid var(--border,light-dark(#d2d2d2,#3a3a3a));border-radius:var(--radius,10px)}
button,select{padding:.4em .7em}
button{cursor:pointer}
:where(button:hover:not(:disabled)){background:var(--muted,light-dark(#e4e4e7,#29292d))}
button:disabled{cursor:default;opacity:.55}
:where(button,input,textarea,select,a):focus-visible{outline:2px solid var(--ring,light-dark(#5345c7,#a49aff));outline-offset:2px}
input::placeholder,textarea::placeholder{color:var(--muted-foreground,light-dark(#495467,#b0bac9))}
a{color:var(--accent,light-dark(#5345c7,#a49aff))}
</style>
<script>(function(){
var params=new URLSearchParams(location.search);
var channel=params.get('c')||'';
if(params.get('layout')==='inline')document.documentElement.dataset.spacronLayout='inline';
var currentTheme={}, lastTheme='';
function applyTheme(t){
  if(!t||typeof t!=='object')return;
  var next=JSON.stringify(t);if(next===lastTheme)return;lastTheme=next;
  var r=document.documentElement;
  Object.keys(t).forEach(function(k){if(/^--[a-z0-9-]+$/.test(k)&&typeof t[k]==='string')r.style.setProperty(k,t[k].replace(/[;{}<>]/g,''))});
  var scheme=t['color-scheme'];
  if(scheme==='light'||scheme==='dark'){r.style.colorScheme=scheme;r.dataset.theme=scheme}
  currentTheme=t;
  window.dispatchEvent(new CustomEvent('spacron:theme',{detail:t}));
}
function applyFragment(){try{applyTheme(JSON.parse(decodeURIComponent(location.hash.slice(1)||'%7B%7D')))}catch(e){}}
var botList=[];
function findBot(q){q=String(q==null?'':q).trim().toLowerCase();if(!q)return null;for(var i=0;i<botList.length;i++){var b=botList[i];if(b.id.toLowerCase()===q||b.name.toLowerCase()===q)return b}return null}
var avatarList=[];
function findAvatar(q){q=String(q==null?'':q).trim().toLowerCase();for(var i=0;i<avatarList.length;i++){if(avatarList[i].id===q||avatarList[i].label.toLowerCase()===q)return avatarList[i]}return null}
function fillBotIcons(){var els=document.querySelectorAll('img[data-spacron-bot-icon]');for(var i=0;i<els.length;i++){var b=findBot(els[i].getAttribute('data-spacron-bot-icon'));if(b&&els[i].getAttribute('src')!==b.icon)els[i].setAttribute('src',b.icon)}
els=document.querySelectorAll('img[data-spacron-avatar]');for(i=0;i<els.length;i++){var a=findAvatar(els[i].getAttribute('data-spacron-avatar'));if(a&&els[i].getAttribute('src')!==a.icon)els[i].setAttribute('src',a.icon)}}
function cleanIcons(list,named){return Array.isArray(list)?list.filter(function(b){return b&&typeof b.id==='string'&&typeof b[named]==='string'&&typeof b.icon==='string'&&b.icon.indexOf('data:image/')===0}):[]}
function applyAvatars(list){avatarList=cleanIcons(list,'label').map(function(a){return{id:a.id,label:a.label,icon:a.icon}});fillBotIcons();window.dispatchEvent(new CustomEvent('spacron:avatars',{detail:avatarList.slice()}))}
function applyBots(list){if(!Array.isArray(list))return;botList=list.filter(function(b){return b&&typeof b.id==='string'&&typeof b.name==='string'&&typeof b.icon==='string'&&b.icon.indexOf('data:image/')===0}).map(function(b){return{id:b.id,name:b.name,icon:b.icon}});fillBotIcons();window.dispatchEvent(new CustomEvent('spacron:bots',{detail:botList.slice()}))}
function go(target){parent.postMessage({spacronVisual:channel,action:'open',target:target},'*')}
window.spacron={get theme(){return Object.assign({},currentTheme)},compose:function(t){parent.postMessage({spacronVisual:channel,action:'compose',text:String(t==null?'':t).slice(0,4000)},'*')},
get bots(){return botList.slice()},get avatars(){return avatarList.slice()},avatar:function(q){var a=findAvatar(q);return a?Object.assign({},a):null},
sendToBot:function(q,t){var b=findBot(q);parent.postMessage({spacronVisual:channel,action:'send-to-bot',bot:b?b.id:String(q==null?'':q).slice(0,200),text:String(t==null?'':t).slice(0,4000)},'*')},bot:function(q){var b=findBot(q);return b?Object.assign({},b):null},
openBot:function(q){var b=findBot(q);go({kind:'bot',id:b?b.id:String(q==null?'':q).slice(0,200)})},
openBots:function(){go({kind:'bots'})},newBot:function(){go({kind:'new-bot'})}};
if(window.MutationObserver)new MutationObserver(fillBotIcons).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-spacron-bot-icon']});
applyFragment();window.addEventListener('hashchange',applyFragment);
window.addEventListener('message',function(e){var d=e.data;if(!(channel&&e.source===parent&&d&&d.spacronVisual===channel))return;if(d.action==='theme')applyTheme(d.theme);else if(d.action==='bots'){applyAvatars(d.avatars);applyBots(d.bots)}});
window.addEventListener('keydown',function(e){if(channel&&e.key==='Escape'&&!e.defaultPrevented)parent.postMessage({spacronVisual:channel,action:'escape'},'*')});
var last=0;function report(){var b=document.body;if(!b)return;var h=Math.ceil(b.getBoundingClientRect().height+parseFloat(getComputedStyle(b).marginTop||0)+parseFloat(getComputedStyle(b).marginBottom||0));if(Math.abs(h-last)>1){last=h;parent.postMessage({spacronVisual:channel,height:h},'*')}}
var ro=new ResizeObserver(report);ro.observe(document.documentElement);document.addEventListener('DOMContentLoaded',function(){ro.observe(document.body);report()});window.addEventListener('load',report);setInterval(report,1000);
})();</script>"#;

const CONTRAST_SCRIPT: &str = include_str!("chat_visual_contrast.js");

/// Put the shell right after `<head>` (or first, for a fragment) so it applies before the page's own markup.
fn wrap_page(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(head) = lower.find("<head") {
        if let Some(close) = lower[head..].find('>') {
            let at = head + close + 1;
            return format!("{}{SHELL_HEAD}<script>{CONTRAST_SCRIPT}</script>{}", &html[..at], &html[at..]);
        }
    }
    format!("<!doctype html><html><head>{SHELL_HEAD}<script>{CONTRAST_SCRIPT}</script></head><body>{html}</body></html>")
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

/// Put one page into a chat's folder, for chats whose agent runs somewhere the
/// page cannot be written directly (a bot's reply is fetched from its home, which
/// may be on a box). Same name rules and size cap as a page the agent writes.
#[tauri::command]
pub async fn chat_visuals_write(key: String, file: String, content: String) -> Result<(), String> {
    if !is_safe_key(&key) || !is_safe_visual_file(&file) {
        return Err("Invalid visual".into());
    }
    if content.len() as u64 > MAX_VISUAL_BYTES {
        return Err("Visual too large".into());
    }
    let dir = visuals_root().join(&key);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    tokio::fs::write(dir.join(&file), content).await.map_err(|e| e.to_string())
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
        assert!(body.contains("data-spacron-readable-ink"));

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
