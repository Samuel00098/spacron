use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::{Duration, Instant};
use url::Url;

/// Largest response body we'll buffer into memory. The client reads the body in
/// chunks and aborts once this is exceeded, so a huge or endless response can't
/// exhaust memory.
const MAX_RESPONSE_BYTES: usize = 50 * 1024 * 1024;

/// True for a concrete IP in a range the in-app HTTP client must never reach.
/// Loopback and private ranges stay allowed on purpose — hitting your own dev
/// server is the whole point — but link-local addresses (notably the
/// 169.254.169.254 cloud-metadata endpoint) have no legitimate use from a
/// desktop app and are a classic credential-theft SSRF target.
fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local() || v4.is_broadcast() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            // fe80::/10 link-local, the unspecified address, and any
            // IPv4-mapped link-local address (e.g. ::ffff:169.254.x.x).
            v6.is_unspecified()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4().map(|m| m.is_link_local()).unwrap_or(false)
        }
    }
}

/// Fast, no-DNS reject: blocks the well-known metadata hostnames and any host
/// that is itself a blocked IP literal. Cheap enough to run on every redirect
/// hop without a network round-trip. Shared with the AI local-provider path
/// (`secrets::resolve_base_url`) so a tampered `base_url` can't point an
/// authenticated request at the cloud-metadata endpoint.
pub(crate) fn host_is_blocked(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');

    const BLOCKED_HOSTS: &[&str] = &["metadata.google.internal", "metadata.goog"];
    if BLOCKED_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h)) {
        return true;
    }

    host.parse::<IpAddr>().map(ip_is_blocked).unwrap_or(false)
}

/// DNS-aware reject: resolves `host` and blocks it if ANY resolved address is in
/// a protected range. This closes the gap where an innocuous-looking hostname
/// (or a redirect target) resolves to the cloud-metadata endpoint — something
/// the literal `host_is_blocked` check alone would miss. A residual
/// DNS-rebinding TOCTOU remains (reqwest re-resolves at connect time and could
/// in theory get a different answer), but this stops the straightforward
/// "hostname → 169.254.169.254" bypass. Resolution failures return false so
/// reqwest surfaces the real connection error.
pub(crate) fn resolved_host_is_blocked(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    match (host, 80u16).to_socket_addrs() {
        Ok(addrs) => addrs.into_iter().any(|sa| ip_is_blocked(sa.ip())),
        Err(_) => false,
    }
}

/// Redirect policy shared by every outbound client in this module: cap at 10
/// hops AND re-check the host on every hop — literal and DNS-aware — so a
/// redirect can't smuggle the request to a blocked link-local or cloud-metadata
/// address, even via a hostname that resolves there.
fn guarded_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        if attempt
            .url()
            .host_str()
            .map(|h| host_is_blocked(h) || resolved_host_is_blocked(h))
            .unwrap_or(false)
        {
            return attempt.error("redirect to a blocked link-local or metadata address");
        }
        attempt.follow()
    })
}

#[derive(Serialize, Deserialize)]
pub struct HttpResponsePayload {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    headers: HashMap<String, String>,
    body: String,
    duration: u32,
    size: usize,
    ok: bool,
}

#[tauri::command]
pub async fn http_send_request(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResponsePayload, String> {
    // Restrict to http/https — file://, ftp://, etc. have no place in an HTTP client.
    let parsed_url = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Unsupported URL scheme '{scheme}': only http and https are allowed"
            ))
        }
    }
    if let Some(host) = parsed_url.host_str() {
        // Fast literal/hostname reject first, then a DNS-aware reject that catches
        // a hostname pointing at a blocked address. The resolve is blocking, so
        // run it off the async runtime thread.
        if host_is_blocked(host) {
            return Err(
                "Requests to link-local or cloud-metadata addresses are blocked".to_string(),
            );
        }
        let host_owned = host.to_string();
        let resolved_blocked =
            tokio::task::spawn_blocking(move || resolved_host_is_blocked(&host_owned))
                .await
                .unwrap_or(false);
        if resolved_blocked {
            return Err(
                "Host resolves to a blocked link-local or cloud-metadata address".to_string(),
            );
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(guarded_redirect_policy())
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;

    let method = match method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => return Err(format!("Unsupported HTTP method: {method}")),
    };

    let mut builder = client.request(method, &url);

    for (k, v) in headers {
        builder = builder.header(k, v);
    }

    if let Some(b) = body {
        builder = builder.body(b);
    }

    let start = Instant::now();
    let mut response = builder
        .send()
        .await
        .map_err(|err| format!("Request failed: {err}"))?;

    let duration = start.elapsed().as_millis() as u32;

    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();

    let ok = response.status().is_success();

    let mut res_headers = HashMap::new();
    for (k, v) in response.headers().iter() {
        if let Ok(val_str) = v.to_str() {
            res_headers.insert(k.to_string(), val_str.to_string());
        }
    }

    // Stream the body in chunks and stop once it exceeds the cap, so an oversized
    // or never-ending response can't blow up memory.
    let mut body_bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("Failed to read response body: {err}"))?
    {
        if body_bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "Response body exceeds the {} MB limit",
                MAX_RESPONSE_BYTES / (1024 * 1024)
            ));
        }
        body_bytes.extend_from_slice(&chunk);
    }

    let size = body_bytes.len();
    let body_str = String::from_utf8_lossy(&body_bytes).to_string();

    Ok(HttpResponsePayload {
        status,
        status_text,
        headers: res_headers,
        body: body_str,
        duration,
        size,
        ok,
    })
}

// ── Agent logo discovery via dashboardicons.com ─────────────────────────────
//
// dashboardicons.com is the homarr-labs/dashboard-icons project — a large,
// consistently-named catalogue of app/tool logos, and the same source the
// bundled agent marks came from. For an agent whose CLI we don't ship a bundled
// mark for, we look its command/name up in that catalogue and return the SVG as
// a `data:` URI (the webview CSP forbids arbitrary remote `img-src`, but allows
// `data:`). Matching is exact-on-slug so a custom agent never grabs an unrelated
// logo. When the curated catalogue has nothing (e.g. a newer agent it hasn't
// added yet), we try LobeHub's AI-brand icon set next, then fall back to the
// tool's own site favicon before finally giving up; only then does the UI keep
// its letter glyph.

// dashboardicons.com is a static front-end over this same repo (its own pages
// load every icon from this CDN), and its search runs over `metadata.json` —
// which carries each icon's aliases and its light/dark theme variants. We use
// that file (not the bare `tree.json` filename list) so our lookup matches the
// site's search and themes icons the way the site does.
const DASHBOARD_ICONS_META: &str =
    "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/metadata.json";
const DASHBOARD_ICONS_SVG_BASE: &str =
    "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/";

// LobeHub Icons (`@lobehub/icons`) — a large, AI-brand-focused icon set (Claude,
// Gemini, Mistral, DeepSeek, Qwen, …) published as static SVGs. Used as the
// second logo tier: its slugs are clean brand names, so we guess the icon file
// straight from the agent's command/name slug. Each brand ships a monochrome
// `<slug>.svg` (fill `currentColor`) and often a self-colored `<slug>-color.svg`.
const LOBEHUB_SVG_BASE: &str =
    "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/";
/// Foreground inks baked into a LobeHub monochrome (`currentColor`) icon so it
/// stays visible against each theme's background: dark ink on a light UI, light
/// ink on a dark UI. Color-variant icons carry their own fills and ignore these.
const LOBEHUB_INK_LIGHT: &str = "#1a1a1a";
const LOBEHUB_INK_DARK: &str = "#e8e8e8";

/// Favicon-lookup service used as the third logo tier — Google's `s2/favicons`
/// endpoint, the same source Orca uses for its agent icons. It answers with a
/// 301 to a `t*.gstatic.com/faviconV2` URL (our redirect policy follows it and
/// re-checks the host on the way), returns the site's real favicon as a PNG at
/// the requested size, and — the property that makes a miss fall through to the
/// letter glyph — answers **404** for a domain with no favicon. A 200 carrying
/// the 16×16 globe placeholder is possible on some domains, so the 404 alone is
/// not relied on; [`png_is_placeholder`] catches that. Verified live 2026-08:
/// every curated domain in [`FAVICON_DOMAINS`] answers 200 with an icon, while
/// example.com and nonexistent domains answer 404. `sz=64` fits the ~26px agent
/// tiles.
const FAVICON_SERVICE: &str = "https://www.google.com/s2/favicons?domain=";
/// Common TLDs to guess a tool's domain from its slug, tried in this order.
const FAVICON_TLDS: [&str; 5] = ["com", "ai", "dev", "app", "io"];

/// Curated agent→domain map, ported from Orca's agent catalog (its per-agent
/// `faviconDomain` field — the same table that feeds their Google favicon tier).
/// Keys are the normalized slugs [`logo_slug_candidates`] produces — launch
/// command, display name, then name words — so both a preset command like
/// `cursor-agent` and its display name match. Every domain was verified against
/// [`FAVICON_SERVICE`] before it was added. Agents Orca renders by hand (claude,
/// codex, kilo, copilot, droid, aider, pi, opencode, omp) have no entry here;
/// an agent without one falls through to the TLD guess below.
const FAVICON_DOMAINS: &[(&str, &str)] = &[
    ("amp", "ampcode.com"),
    ("ante", "antigma.ai"),
    ("agy", "antigravity.google"),
    ("antigravity", "antigravity.google"),
    ("aug", "augmentcode.com"),
    ("auggie", "augmentcode.com"),
    ("augmentcode", "augmentcode.com"),
    ("autohand", "autohand.ai"),
    ("cline", "cline.bot"),
    ("codebuff", "codebuff.com"),
    ("freebuff", "freebuff.dev"),
    ("commandcode", "commandcode.ai"),
    ("continue", "continue.dev"),
    ("cursor", "cursor.com"),
    ("cursoragent", "cursor.com"),
    ("devin", "devin.ai"),
    ("gemini", "gemini.google.com"),
    ("goose", "goose-docs.ai"),
    ("grok", "x.ai"),
    ("hermes", "nousresearch.com"),
    ("kimi", "moonshot.cn"),
    ("kiro", "kiro.dev"),
    ("kirocli", "kiro.dev"),
    ("mimo", "mimo.xiaomi.com"),
    ("mistral", "mistral.ai"),
    ("mistralvibe", "mistral.ai"),
    ("openclaw", "openclaw.ai"),
    ("primeagent", "primeintellect.ai"),
    ("qwen", "qwenlm.github.io"),
    ("qwencode", "qwenlm.github.io"),
    ("rovo", "atlassian.com"),
    ("trae", "www.trae.cn"),
    ("traecli", "www.trae.cn"),
    ("vibe", "mistral.ai"),
];

/// The `metadata.json` a single icon entry: the theme→variant mapping and the
/// search aliases. Extra fields in the file (categories, update info, …) are
/// ignored.
#[derive(Deserialize)]
struct IconColors {
    #[serde(default)]
    light: Option<String>,
    #[serde(default)]
    dark: Option<String>,
}

#[derive(Deserialize)]
struct IconMeta {
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    colors: Option<IconColors>,
}

/// The whole catalogue keyed by icon id ("claude-ai", "github-copilot", …).
type IconCatalogue = HashMap<String, IconMeta>;

/// The dashboard-icons catalogue, fetched once per process (it changes rarely and
/// an app restart re-reads it).
static ICON_MANIFEST: tokio::sync::OnceCell<IconCatalogue> = tokio::sync::OnceCell::const_new();

async fn icon_manifest(client: &reqwest::Client) -> Result<&'static IconCatalogue, String> {
    ICON_MANIFEST
        .get_or_try_init(|| async {
            let catalogue: IconCatalogue = client
                .get(DASHBOARD_ICONS_META)
                .send()
                .await
                .map_err(|e| format!("icon manifest fetch failed: {e}"))?
                .json()
                .await
                .map_err(|e| format!("icon manifest parse failed: {e}"))?;
            Ok(catalogue)
        })
        .await
}

/// True for a catalogue-supplied icon filename stem that is safe to splice into
/// the CDN URL: bare alphanumerics, hyphens and underscores only.
///
/// Everything `variant_files` and `match_icon` work with comes from the fetched
/// `metadata.json`, not from us. Unlike the user-derived slugs (which already go
/// through [`normalize_slug`]), those strings are otherwise unconstrained, so a
/// compromised or simply malformed catalogue could introduce a `/`, a `..` or a
/// scheme and steer the fetch off its intended path on the CDN. Nothing legitimate
/// in the catalogue needs anything outside this charset.
fn icon_file_stem_is_safe(stem: &str) -> bool {
    !stem.is_empty()
        && stem.len() <= 128
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Lowercase, alphanumerics only — so "Open-Code", "open_code" and "opencode" all
/// compare equal, matching dashboard-icons' hyphenated filenames slug-for-slug.
fn normalize_slug(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Score one search term (an icon id or an alias) against the queries. The
/// catalogue names things as composite slugs ("claude-ai", "google-gemini") and
/// aliases can be free text ("Gemini CLI"), so a plain equality check misses most
/// agents. Instead:
///   - an exact full-slug match (query == whole term) scores best (0);
///   - else a whole-TOKEN match (query == one '-'/'_'/space-delimited part),
///     preferring the token nearer the front and terms with fewer tokens.
/// Whole-token (not substring) matching is what keeps "pi" out of "activepieces".
/// Returns None when the term matches no query.
fn score_term(term: &str, norm_queries: &[String]) -> Option<i32> {
    let full = normalize_slug(term);
    let tokens: Vec<String> = term
        .split(['-', '_', ' '])
        .map(normalize_slug)
        .filter(|t| !t.is_empty())
        .collect();
    let mut best: Option<i32> = None;
    for q in norm_queries {
        let s = if full == *q {
            Some(0)
        } else if let Some(pos) = tokens.iter().position(|t| t == q) {
            Some(10 + (pos as i32) * 2 + (tokens.len() as i32 - 1))
        } else {
            None
        };
        if let Some(s) = s {
            best = Some(best.map_or(s, |b| b.min(s)));
        }
    }
    best
}

/// Best icon id for any of `queries`, or None. Searches each icon's canonical id
/// AND its metadata aliases — the same fields dashboardicons.com's own search
/// covers — so, e.g., an "OpenAI" agent still finds the "codex" icon via alias.
/// An alias hit takes a small penalty so an exact id match always wins. Lower
/// score wins; ties break on the shorter, then lexicographically-smaller id so
/// the result is deterministic despite the map's arbitrary iteration order. None
/// means nothing matched and the UI keeps its glyph.
fn match_icon<'a>(catalogue: &'a IconCatalogue, queries: &[String]) -> Option<&'a str> {
    const ALIAS_PENALTY: i32 = 3;
    let norm_queries: Vec<String> = queries
        .iter()
        .map(|q| normalize_slug(q))
        .filter(|q| q.len() >= 2)
        .collect();
    if norm_queries.is_empty() {
        return None;
    }

    let mut best: Option<(&str, i32)> = None;
    for (id, meta) in catalogue {
        // Ids come from the fetched catalogue and end up spliced into the CDN
        // URL, so an unsafe one is never a candidate in the first place.
        if !icon_file_stem_is_safe(id) {
            continue;
        }
        let mut icon_score = score_term(id, &norm_queries);
        for alias in &meta.aliases {
            if let Some(s) = score_term(alias, &norm_queries) {
                let s = s + ALIAS_PENALTY;
                icon_score = Some(icon_score.map_or(s, |c| c.min(s)));
            }
        }
        if let Some(s) = icon_score {
            let better = match best {
                None => true,
                Some((bid, bs)) => s < bs || (s == bs && (id.len(), id.as_str()) < (bid.len(), bid)),
            };
            if better {
                best = Some((id.as_str(), s));
            }
        }
    }
    best.map(|(id, _)| id)
}

/// A resolved agent logo, with a version for each UI theme. When the source only
/// offers one asset (a favicon, or a catalogue icon with no theme variant), both
/// fields hold the same `data:` URI.
#[derive(Serialize)]
pub struct AgentLogo {
    /// Logo to show on a light background (light-mode UI).
    pub light: String,
    /// Logo to show on a dark background (dark-mode UI).
    pub dark: String,
}

/// Generic words that make poor domain guesses on their own — a bare "agent" or
/// "ai" would pull some unrelated company's favicon, which is worse than the
/// letter fallback. The tool token and the full-name slug are never filtered.
const FAVICON_STOPWORDS: [&str; 11] = [
    "ai", "cli", "code", "coder", "agent", "assistant", "bot", "app", "dev",
    "tool", "the",
];

/// Discover a tool's real logo from its own site favicon when the curated
/// catalogue has no match. We guess the tool's domain from its command/name slug
/// across a few common TLDs and return the first real image the favicon service
/// hands back, as a `data:` URI. `None` means nothing was found, so the caller
/// falls back to a letter glyph.
///
/// The request host is a fixed, trusted service and the only thing derived from
/// user input is the bare alphanumeric domain slug, so there is no SSRF surface.
/// Candidate slug stems for an agent, most-specific first: the command's tool
/// token, the FULL display name collapsed to a slug, then each individual word of
/// the name (skipping generic stopwords). Each is reduced to bare alphanumerics
/// ("Qoder" → "qoder", "Qoder AI" → "qoderai" then "qoder"). Shared by the
/// LobeHub and favicon tiers so both guess the same identifiers. Only individual
/// words are stopword-filtered; the tool token and full-name slug are always kept.
fn logo_slug_candidates(tool: &str, name: &str) -> Vec<String> {
    let mut candidates: Vec<(String, bool)> = vec![
        (normalize_slug(tool), false),
        (normalize_slug(name), false),
    ];
    for word in name.split_whitespace() {
        candidates.push((normalize_slug(word), true));
    }
    let mut stems: Vec<String> = Vec::new();
    for (slug, is_word) in candidates {
        if slug.len() < 2 || stems.contains(&slug) {
            continue;
        }
        if is_word && FAVICON_STOPWORDS.contains(&slug.as_str()) {
            continue;
        }
        stems.push(slug);
    }
    stems
}

/// First curated domain for any of `stems`, preserving their most-specific-first
/// order (launch command, display name, then name words). The table is tiny, so
/// a linear scan per stem is fine.
fn curated_favicon_domain(stems: &[String]) -> Option<&'static str> {
    stems.iter().find_map(|stem| {
        FAVICON_DOMAINS
            .iter()
            .find(|(key, _)| key == stem)
            .map(|(_, domain)| *domain)
    })
}

/// True when `bytes` is Google's no-favicon placeholder: a 16×16 PNG. The
/// service normally signals a miss with the HTTP 404 we already reject, but on
/// some domains the globe can come back as a 200 — accepting it would paint a
/// globe on the agent tile instead of falling through to the letter glyph.
/// Real favicons return at their native size (≥32px at `sz=64`), so 16×16 is a
/// reliable signature. Returns false for anything that is not a PNG, so a
/// corrupted or non-image payload is left to the caller's other checks.
fn png_is_placeholder(bytes: &[u8]) -> bool {
    if bytes.len() < 24
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        // IHDR must be the first chunk; anything else means the dims we read
        // below are not dims at all.
        || !bytes[12..16].starts_with(b"IHDR")
    {
        return false;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    width == 16 && height == 16
}

/// Outcome of one favicon fetch: `Found` (a real icon, base64 `data:` URI),
/// `Missing` (the domain has no favicon — keep trying the next candidate), or
/// `Unreachable` (the service itself failed — every further request would fail
/// the same way, so the caller should stop rather than grind through the whole
/// candidate list at the per-request timeout).
enum FaviconFetch {
    Found(String),
    Missing,
    Unreachable,
}

/// Fetch one domain's favicon through [`FAVICON_SERVICE`] and classify the
/// result. `Missing` covers a non-2xx status (including the 404 Google answers
/// with for a favicon-less domain), a non-image body, the 16×16 globe
/// placeholder, and an empty/oversized payload. `Unreachable` covers transport
/// failures only. The request host is fixed and the only user-derived input is
/// the bare alphanumeric domain slug, so there is no SSRF surface.
async fn fetch_favicon_icon(client: &reqwest::Client, domain: &str) -> FaviconFetch {
    let url = format!("{FAVICON_SERVICE}{domain}&sz=64");
    let Ok(resp) = client.get(&url).send().await else {
        return FaviconFetch::Unreachable;
    };
    if !resp.status().is_success() {
        return FaviconFetch::Missing;
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Only accept an actual image; skip HTML error pages served as 200.
    if !content_type.starts_with("image/") {
        return FaviconFetch::Missing;
    }
    let Some(bytes) = resp.bytes().await.ok() else {
        return FaviconFetch::Missing;
    };
    if bytes.is_empty() || bytes.len() > 512 * 1024 || png_is_placeholder(&bytes) {
        return FaviconFetch::Missing;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    FaviconFetch::Found(format!("data:{content_type};base64,{encoded}"))
}

/// Discover a tool's real logo from its own site favicon when the curated
/// catalogues have no match. The curated agent→domain table
/// ([`FAVICON_DOMAINS`], ported from Orca's agent catalog) is tried first; for
/// agents without an entry it guesses the domain from the command/name slug
/// across a few common TLDs. Either way the lookup runs against Google's
/// favicon service ([`FAVICON_SERVICE`]) and the first real icon wins, as a
/// `data:` URI. A transport failure aborts the whole lookup — the service is
/// unreachable, so no later candidate would succeed — while a plain miss moves
/// to the next candidate. `None` means nothing was found, so the caller falls
/// back to a letter glyph.
///
/// The request host is a fixed, trusted service and the only thing derived from
/// user input is the bare alphanumeric domain slug, so there is no SSRF surface.
/// Candidate slug stems for an agent, most-specific first: the command's tool
/// token, the FULL display name collapsed to a slug, then each individual word
/// of the name (skipping generic stopwords) — see [`logo_slug_candidates`].
async fn fetch_favicon_logo(client: &reqwest::Client, tool: &str, name: &str) -> Option<String> {
    let stems = logo_slug_candidates(tool, name);

    // Curated first: a hand-picked domain is more reliable than any guess.
    if let Some(domain) = curated_favicon_domain(&stems) {
        match fetch_favicon_icon(client, domain).await {
            FaviconFetch::Found(uri) => return Some(uri),
            // If the service itself is down, guessing won't bring it back.
            FaviconFetch::Unreachable => return None,
            FaviconFetch::Missing => {}
        }
    }

    // Guessed: the same slug candidates across common TLDs, for agents the
    // curated table doesn't cover yet (e.g. Qoder). A wrong guess is a 404, so
    // the loop just moves on to the next candidate.
    for stem in &stems {
        for tld in FAVICON_TLDS {
            match fetch_favicon_icon(client, &format!("{stem}.{tld}")).await {
                FaviconFetch::Found(uri) => return Some(uri),
                FaviconFetch::Unreachable => return None,
                FaviconFetch::Missing => {}
            }
        }
    }
    None
}

/// Base64 `data:` URI for a raw SVG string (the webview CSP allows `data:` but
/// not arbitrary remote `img-src`).
fn svg_data_uri(svg: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
    format!("data:image/svg+xml;base64,{encoded}")
}

/// Fetch one LobeHub icon by filename, returning its SVG text. `None` on any miss
/// (404, non-SVG body, empty/oversize) so the caller falls through to the next
/// candidate. The request host is the fixed LobeHub CDN and the only user-derived
/// input is the bare alphanumeric slug, so there is no SSRF surface.
async fn fetch_lobehub_svg(client: &reqwest::Client, file: &str) -> Option<String> {
    let url = format!("{LOBEHUB_SVG_BASE}{file}");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > 512 * 1024 {
        return None;
    }
    let text = String::from_utf8(bytes.to_vec()).ok()?;
    if !text.contains("<svg") {
        return None;
    }
    Some(text)
}

/// Discover a tool's logo from LobeHub's AI-brand icon set, used as the second
/// tier when the dashboard-icons catalogue has no match. LobeHub's slugs are
/// clean brand names, so we guess the icon file straight from the agent's
/// command/name slug (via [`logo_slug_candidates`]). For each candidate we prefer
/// the self-colored `-color.svg` (used verbatim for both themes); otherwise we
/// take the monochrome icon and bake its `currentColor` fill into a per-theme ink
/// so it stays visible. `None` falls through to the favicon tier.
async fn fetch_lobehub_logo(
    client: &reqwest::Client,
    tool: &str,
    name: &str,
) -> Option<AgentLogo> {
    for stem in logo_slug_candidates(tool, name) {
        // Brand-colored variant: carries its own fills, works on both themes.
        if let Some(svg) = fetch_lobehub_svg(client, &format!("{stem}-color.svg")).await {
            let uri = svg_data_uri(&svg);
            return Some(AgentLogo { light: uri.clone(), dark: uri });
        }
        // Monochrome variant: substitute `currentColor` for a legible theme ink,
        // since a `data:` <img> can't inherit the container's CSS color.
        if let Some(svg) = fetch_lobehub_svg(client, &format!("{stem}.svg")).await {
            let light = svg_data_uri(&svg.replace("currentColor", LOBEHUB_INK_LIGHT));
            let dark = svg_data_uri(&svg.replace("currentColor", LOBEHUB_INK_DARK));
            return Some(AgentLogo { light, dark });
        }
    }
    None
}

/// Resolve the `(light_file, dark_file)` SVG filenames for a matched icon id,
/// using dashboard-icons' own `colors.light`/`colors.dark` metadata — the same
/// mapping the site uses to theme its icons. When a theme variant isn't declared
/// (or the icon has no `colors` block), both sides fall back to the base id, so
/// they always resolve to a real file.
fn variant_files(catalogue: &IconCatalogue, id: &str) -> (String, String) {
    let colors = catalogue.get(id).and_then(|m| m.colors.as_ref());
    // A declared variant is used only when it is a safe filename stem; anything
    // else falls back to the (already validated) base id rather than reaching a
    // path we didn't intend.
    let pick = |declared: Option<String>| -> String {
        declared
            .filter(|s| icon_file_stem_is_safe(s))
            .unwrap_or_else(|| id.to_string())
    };
    let light = pick(colors.and_then(|c| c.light.clone()));
    let dark = pick(colors.and_then(|c| c.dark.clone()));
    (format!("{light}.svg"), format!("{dark}.svg"))
}

/// Fetch one catalogue SVG by filename and return it as a `data:` URI.
async fn fetch_catalogue_svg(client: &reqwest::Client, file: &str) -> Result<String, String> {
    let url = format!("{DASHBOARD_ICONS_SVG_BASE}{file}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("icon fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("icon fetch returned {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("icon read failed: {e}"))?;
    // Guard against an unexpectedly huge asset.
    if bytes.is_empty() || bytes.len() > 512 * 1024 {
        return Err("icon payload out of bounds".to_string());
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/svg+xml;base64,{encoded}"))
}

/// Resolve an agent's logo. Given the launch command and display name, returns a
/// light + dark logo pair as `data:` URIs, trying the curated dashboard-icons
/// catalogue first, LobeHub's AI-brand icon set second, and the tool's own site
/// favicon third. Errors only when all tiers come up empty (the UI then keeps its
/// letter glyph).
#[tauri::command]
pub async fn fetch_agent_logo(command: String, name: String) -> Result<AgentLogo, String> {
    // The tool name is the command's first token, path stripped ("/usr/bin/aider
    // --flag" → "aider"); pair it with the FULL display name as a second query.
    let first = command.split_whitespace().next().unwrap_or("");
    let tool = first.rsplit(['/', '\\']).next().unwrap_or(first);
    let queries = vec![tool.to_string(), name.clone()];

    // Same redirect guard as the general HTTP client. The hosts here are fixed,
    // trusted CDNs and no credentials are attached, but a redirect off one of
    // them is the one way this path could be steered at a link-local or
    // cloud-metadata address — so it gets checked on every hop like everything
    // else that leaves the app.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(guarded_redirect_policy())
        .build()
        .map_err(|err| format!("Failed to create HTTP client: {err}"))?;

    // Tier 1: the curated dashboard-icons catalogue (clean, theme-friendly SVGs),
    // resolving the light and dark theme variants from the icon's metadata. A
    // fetch failure here (e.g. a rare png-only icon) falls through to the favicon
    // tier rather than failing the whole lookup.
    //
    // Failing to fetch the CATALOGUE ITSELF must fall through too, and that is
    // the whole reason this is an `.ok()` and not a `?`. The manifest is one
    // request to one CDN, and when it fails — CDN blip, offline start, a
    // corporate proxy that blocks jsdelivr — a `?` here abandoned the lookup
    // before the LobeHub and favicon tiers ever ran. The user-visible result was
    // an agent stuck on its letter glyph even though its own site had a perfectly
    // good favicon waiting, which reads as "the fallback doesn't work".
    let catalogue = icon_manifest(&client).await.ok();
    if let Some(catalogue) = catalogue {
        if let Some(id) = match_icon(catalogue, &queries) {
            let (light_file, dark_file) = variant_files(catalogue, id);
            if let Ok(light) = fetch_catalogue_svg(&client, &light_file).await {
                let dark = if dark_file == light_file {
                    light.clone()
                } else {
                    fetch_catalogue_svg(&client, &dark_file)
                        .await
                        .unwrap_or_else(|_| light.clone())
                };
                return Ok(AgentLogo { light, dark });
            }
        }
    }

    // Tier 2: LobeHub's AI-brand icon set, for agents dashboard-icons hasn't
    // curated but whose brand LobeHub ships — a clean, theme-friendly vector
    // beats a raster favicon.
    if let Some(logo) = fetch_lobehub_logo(&client, tool, &name).await {
        return Ok(logo);
    }

    // Tier 3: the tool's own site favicon via Google's favicon service — the
    // curated agent→domain table first (ported from Orca), then a TLD guess for
    // agents neither catalogue has added yet (e.g. Qoder). Favicons have no
    // theme variants, so both sides share it.
    if let Some(uri) = fetch_favicon_logo(&client, tool, &name).await {
        return Ok(AgentLogo {
            light: uri.clone(),
            dark: uri,
        });
    }

    Err(format!("no icon for '{command}' / '{name}'"))
}

#[cfg(test)]
mod tests {
    use super::{
        curated_favicon_domain, host_is_blocked, icon_file_stem_is_safe, logo_slug_candidates,
        match_icon, png_is_placeholder, resolved_host_is_blocked, variant_files, IconCatalogue,
        IconColors, IconMeta,
    };

    fn meta(aliases: &[&str], light: Option<&str>, dark: Option<&str>) -> IconMeta {
        IconMeta {
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            colors: if light.is_some() || dark.is_some() {
                Some(IconColors {
                    light: light.map(|s| s.to_string()),
                    dark: dark.map(|s| s.to_string()),
                })
            } else {
                None
            },
        }
    }

    fn catalogue() -> IconCatalogue {
        [
            ("claude-ai", meta(&[], Some("claude-ai-light"), Some("claude-ai-dark"))),
            ("google-gemini", meta(&["Gemini CLI"], None, None)),
            ("github-copilot", meta(&["copilot"], Some("github-copilot"), Some("github-copilot-dark"))),
            ("microsoft-copilot", meta(&[], None, None)),
            ("grok", meta(&[], None, None)),
            ("codex", meta(&["OpenAI"], None, None)),
            ("opencode", meta(&[], None, Some("opencode-dark"))),
            ("activepieces", meta(&[], None, None)),
            ("ollama", meta(&["LLM Server"], None, Some("ollama-dark"))),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
    }

    fn matched<'a>(cat: &'a IconCatalogue, name: &str, command: &str) -> Option<&'a str> {
        match_icon(cat, &[command.to_string(), name.to_string()])
    }

    #[test]
    fn matches_composite_and_exact_slugs() {
        let cat = catalogue();
        // Query hits a token inside a composite slug id.
        assert_eq!(matched(&cat, "Claude", "claude"), Some("claude-ai"));
        // Alias ("Gemini CLI") carries the match to the canonical id.
        assert_eq!(matched(&cat, "Gemini CLI", "gemini"), Some("google-gemini"));
        assert_eq!(matched(&cat, "Copilot", "copilot"), Some("github-copilot"));
        // Exact whole-slug id match wins outright.
        assert_eq!(matched(&cat, "Grok", "grok"), Some("grok"));
        assert_eq!(matched(&cat, "OpenCode", "opencode"), Some("opencode"));
        // First token of the command ("ollama run …") drives the match.
        assert_eq!(matched(&cat, "Ollama", "ollama run llama3"), Some("ollama"));
        // An agent named for the vendor finds the tool via its alias ("OpenAI").
        assert_eq!(matched(&cat, "OpenAI", "openai"), Some("codex"));
    }

    #[test]
    fn rejects_substring_and_unknown() {
        let cat = catalogue();
        // "pi" must NOT pull in "activepieces" — whole-token match only.
        assert_eq!(matched(&cat, "Pi", "pi"), None);
        // A genuinely absent agent yields nothing (UI falls back to a glyph).
        assert_eq!(matched(&cat, "Aider", "aider"), None);
        // Too-short queries are ignored.
        assert_eq!(matched(&cat, "", "x"), None);
    }

    #[test]
    fn unsafe_catalogue_names_never_reach_the_url() {
        // Only bare alphanumerics, '-' and '_' are usable as a filename stem.
        assert!(icon_file_stem_is_safe("claude-ai-light"));
        assert!(icon_file_stem_is_safe("github_copilot"));
        // Traversal, absolute paths, schemes and separators are all rejected.
        assert!(!icon_file_stem_is_safe(".."));
        assert!(!icon_file_stem_is_safe("../../other-repo/evil"));
        assert!(!icon_file_stem_is_safe("a/b"));
        assert!(!icon_file_stem_is_safe("https://evil.test/x"));
        assert!(!icon_file_stem_is_safe("icon.svg"));
        assert!(!icon_file_stem_is_safe(""));
        assert!(!icon_file_stem_is_safe(&"a".repeat(129)));

        // A hostile `colors` entry falls back to the base id instead of
        // traversing off the catalogue's path on the CDN.
        let mut cat = catalogue();
        cat.insert(
            "tampered".to_string(),
            meta(&[], Some("../../../../evil"), Some("also/evil")),
        );
        assert_eq!(
            variant_files(&cat, "tampered"),
            ("tampered.svg".to_string(), "tampered.svg".to_string())
        );

        // An unsafe id is not even a match candidate, so it can never become the
        // fallback either.
        let mut cat = catalogue();
        cat.insert("../../evil".to_string(), meta(&["aider"], None, None));
        assert_eq!(matched(&cat, "Aider", "aider"), None);
    }

    #[test]
    fn variant_files_resolve_light_and_dark() {
        let cat = catalogue();
        // Both theme variants declared in metadata.
        assert_eq!(
            variant_files(&cat, "claude-ai"),
            ("claude-ai-light.svg".to_string(), "claude-ai-dark.svg".to_string())
        );
        // light maps to the base icon, dark to a variant.
        assert_eq!(
            variant_files(&cat, "github-copilot"),
            ("github-copilot.svg".to_string(), "github-copilot-dark.svg".to_string())
        );
        // No `colors` block — both themes share the base id.
        assert_eq!(
            variant_files(&cat, "grok"),
            ("grok.svg".to_string(), "grok.svg".to_string())
        );
        // Only a dark variant present; light falls back to the base id.
        assert_eq!(
            variant_files(&cat, "opencode"),
            ("opencode.svg".to_string(), "opencode-dark.svg".to_string())
        );
    }

    #[test]
    fn logo_slug_candidates_order_and_stopwords() {
        // Tool token first, then the full-name slug, then individual name words.
        // "code" is a stopword so the "Code" word is dropped, but the tool token
        // and full-name slug are always kept.
        assert_eq!(
            logo_slug_candidates("gemini", "Gemini Code"),
            vec!["gemini".to_string(), "geminicode".to_string()],
        );
        // Duplicate slugs collapse; a distinct trailing word survives.
        assert_eq!(
            logo_slug_candidates("qoder", "Qoder AI"),
            vec!["qoder".to_string(), "qoderai".to_string()],
        );
        // Even when every individual name word is a stopword, the full-name slug
        // survives (only per-word candidates are stopword-filtered).
        assert_eq!(
            logo_slug_candidates("", "AI Agent"),
            vec!["aiagent".to_string()],
        );
    }

    #[test]
    fn curated_domains_resolve_from_commands_and_names() {
        // Preset commands — the exact form AI_AGENT_PRESETS stores.
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("cursor-agent", "Cursor")),
            Some("cursor.com")
        );
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("traecli", "TRAE")),
            Some("www.trae.cn")
        );
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("agy", "Antigravity")),
            Some("antigravity.google")
        );
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("qwen", "Qwen Code")),
            Some("qwenlm.github.io")
        );
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("cn", "Continue")),
            Some("continue.dev")
        );
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("vibe", "Mistral Vibe")),
            Some("mistral.ai")
        );
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("auggie", "Augment")),
            Some("augmentcode.com")
        );
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("kiro-cli", "Kiro")),
            Some("kiro.dev")
        );
        // A full display name alone (custom agent, command unknown) still hits.
        assert_eq!(
            curated_favicon_domain(&logo_slug_candidates("", "Gemini CLI")),
            Some("gemini.google.com")
        );
    }

    #[test]
    fn curated_domains_leave_unknown_and_handdrawn_agents_alone() {
        // An agent neither table covers — falls through to the TLD guess.
        assert_eq!(curated_favicon_domain(&logo_slug_candidates("qoder", "Qoder")), None);
        // Orca renders these by hand, so they get no curated domain either.
        assert_eq!(curated_favicon_domain(&logo_slug_candidates("aider", "Aider")), None);
        assert_eq!(curated_favicon_domain(&logo_slug_candidates("claude", "Claude")), None);
    }

    /// A minimal PNG header with the given width/height — enough for
    /// `png_is_placeholder`, which only reads the signature and the IHDR dims.
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 13]); // IHDR length
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn detects_the_google_globe_placeholder() {
        // The 16×16 placeholder is the miss signature.
        assert!(png_is_placeholder(&png_header(16, 16)));
        // Real favicons come back at their native size — never 16×16 at sz=64.
        assert!(!png_is_placeholder(&png_header(64, 64)));
        assert!(!png_is_placeholder(&png_header(32, 32)));
        // Non-PNG and truncated payloads are left for the other checks.
        assert!(!png_is_placeholder(b"not a png at all"));
        assert!(!png_is_placeholder(&[]));
    }

    #[test]
    fn blocks_cloud_metadata_and_link_local() {
        // IMDS endpoint and link-local range.
        assert!(host_is_blocked("169.254.169.254"));
        assert!(host_is_blocked("169.254.1.1"));
        // Metadata hostnames (case-insensitive).
        assert!(host_is_blocked("metadata.google.internal"));
        assert!(host_is_blocked("Metadata.Google.Internal"));
        // IPv6 link-local and IPv4-mapped link-local.
        assert!(host_is_blocked("fe80::1"));
        assert!(host_is_blocked("[fe80::1]"));
        assert!(host_is_blocked("::ffff:169.254.169.254"));
        // Unspecified addresses.
        assert!(host_is_blocked("0.0.0.0"));
        assert!(host_is_blocked("::"));
    }

    #[test]
    fn allows_loopback_private_and_public() {
        // Devs need to hit their own services — these stay allowed.
        assert!(!host_is_blocked("127.0.0.1"));
        assert!(!host_is_blocked("localhost"));
        assert!(!host_is_blocked("192.168.1.10"));
        assert!(!host_is_blocked("10.0.0.5"));
        assert!(!host_is_blocked("::1"));
        // Ordinary public hosts.
        assert!(!host_is_blocked("api.github.com"));
        assert!(!host_is_blocked("93.184.216.34"));
    }

    #[test]
    fn resolved_check_blocks_metadata_and_allows_loopback() {
        // IP literals resolve to themselves — deterministic, no real DNS needed.
        assert!(resolved_host_is_blocked("169.254.169.254"));
        assert!(resolved_host_is_blocked("169.254.1.1"));
        // Loopback / private must stay reachable.
        assert!(!resolved_host_is_blocked("127.0.0.1"));
        assert!(!resolved_host_is_blocked("192.168.1.10"));
        // A name that fails to resolve returns false so reqwest reports the error.
        assert!(!resolved_host_is_blocked(
            "this-name-should-not-resolve.invalid"
        ));
    }
}
