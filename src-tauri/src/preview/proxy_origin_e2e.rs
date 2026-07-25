//! Security regression tests for the preview proxy's **origin model**.
//!
//! Every external site the preview browser renders is served from the *same*
//! loopback origin (`http://127.0.0.1:{proxy_port}`), so the browser's
//! same-origin policy cannot keep two proxied sites apart: script on page A can
//! `fetch()` page B's proxy URL — or simply frame it — and read the response.
//!
//! What used to make that catastrophic was the cookie jar. It was shared across
//! every site, so the proxy attached B's real session cookies to A's request and
//! handed A the authenticated page. These tests pin the fix: cookies are now
//! partitioned by the **top-level origin the user is actually on**
//! ([`cookies::PartitionedJars`]), so a request made while browsing A never
//! carries B's credentials, however it was issued.

use super::*;
use axum::http::HeaderMap;
use axum::routing::any;
use reqwest::cookie::CookieStore as _;
use std::sync::RwLock;

/// The value the mock "logged-in site" only reveals to a request carrying its
/// session cookie.
const SECRET: &str = "ACCOUNT_BALANCE_4242_PRIVATE";

/// Mock third-party site. `/account` is cookie-gated, exactly like any real
/// authenticated page the user might have logged into inside the preview
/// browser.
async fn victim_account(headers: HeaderMap) -> Response<Body> {
    let cookie = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if cookie.contains("session=s3cr3t-session-token") {
        (StatusCode::OK, SECRET).into_response()
    } else {
        (StatusCode::UNAUTHORIZED, "login required").into_response()
    }
}

/// Bind the victim site on an ephemeral loopback port.
async fn spawn_victim_site() -> u16 {
    let app = Router::new().route("/account", any(victim_account));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind victim site");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

/// A running proxy plus the handles a test needs to drive its partitioning.
struct TestProxy {
    port: u16,
    jars: Arc<PartitionedJars>,
    active_partition: Arc<RwLock<Option<String>>>,
}

impl TestProxy {
    /// Stand in for the frontend committing a top-level navigation. In the real
    /// app this is `preview_set_active_origin`, called before `iframe.src` is
    /// assigned.
    fn browse_to(&self, origin: &str) {
        *self
            .active_partition
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(origin.to_string());
    }
}

/// The preview proxy router, with an isolated on-disk jar directory so the test
/// never touches the user's real cookies.
async fn spawn_proxy(dir: std::path::PathBuf) -> TestProxy {
    let cookie_jars = PartitionedJars::new(dir);
    let active_partition = Arc::new(RwLock::new(None));
    let state = ProxyState {
        target_port: Arc::new(Mutex::new(5173)),
        preferred_local_host: Arc::new(Mutex::new(None)),
        active_external_origins: Arc::new(Mutex::new(std::collections::HashMap::new())),
        active_project_id: Arc::new(RwLock::new(None)),
        project_root: Arc::new(RwLock::new(None)),
        // Mirrors production (`start_proxy`).
        external_origin_fallback: true,
        cookie_jars: cookie_jars.clone(),
        active_partition: active_partition.clone(),
        partition_clients: Arc::new(Mutex::new(HashMap::new())),
        local_client: preview_local_http_client(),
    };
    let app = Router::new()
        .route("/local-file", any(serve_local_file))
        .route("/local-file/{*file_path}", any(serve_local_file_path))
        .fallback(any(proxy_handler))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind proxy");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    TestProxy {
        port,
        jars: cookie_jars,
        active_partition,
    }
}

fn test_client() -> Client {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

/// Seed a login for `site_origin` as it would have been stored while the user
/// was browsing `partition` — i.e. a first-party login on that site.
fn seed_login(proxy: &TestProxy, partition: &str, site_origin: &str) {
    let jar = proxy.jars.get(partition);
    let url = url::Url::parse(site_origin).unwrap();
    let header = reqwest::header::HeaderValue::from_static(
        "session=s3cr3t-session-token; Path=/; Max-Age=86400",
    );
    jar.set_cookies(&mut [header].iter(), &url);
    assert!(
        jar.cookies(&url).is_some(),
        "precondition: the session cookie is in the {partition} partition"
    );
}

/// **The fix.** A page served from the shared proxy origin can still *reach*
/// another proxied site — that is inherent to a single-origin proxy browser —
/// but it no longer gets that site's credentials, so there is nothing
/// confidential to steal.
///
/// Scenario: the user logs into `victim` inside the preview browser, so the
/// session cookie lands in the `victim` partition. They later browse to
/// `https://evil.example`. Script on that page fetches the victim's proxy URL.
/// The request is same-origin to the WebView and passes the CSRF gate, but the
/// active partition is `evil.example`, whose jar has never seen the victim — so
/// the upstream request goes out unauthenticated and comes back 401.
#[tokio::test]
async fn cross_site_read_gets_no_credentials() {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let victim_port = spawn_victim_site().await;
    let proxy = spawn_proxy(tmp.path().to_path_buf()).await;
    let victim_origin = format!("http://127.0.0.1:{victim_port}");

    // The user's earlier first-party login on the victim site.
    seed_login(&proxy, &victim_origin, &victim_origin);

    // Now they are on the attacker's page.
    proxy.browse_to("https://evil.example");

    let client = test_client();
    let proxy_origin = format!("http://127.0.0.1:{}", proxy.port);
    let resp = client
        .get(format!(
            "{proxy_origin}/proxy/http/127.0.0.1:{victim_port}/account"
        ))
        .header("Origin", &proxy_origin)
        .header("Accept", "*/*")
        .send()
        .await
        .expect("attack request");

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    assert_eq!(
        status, 401,
        "cross-partition request must not be credentialed (body: {body})"
    );
    assert!(
        !body.contains(SECRET),
        "another site's authenticated content leaked: {body}"
    );
}

/// Framing instead of fetching must not help. A nested
/// `<iframe src="/proxy/…/victim">` is also a document load, which is exactly
/// why the partition is set by the app rather than inferred from request shape:
/// the request below looks like a page navigation in every respect.
#[tokio::test]
async fn framing_the_victim_gets_no_credentials_either() {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let victim_port = spawn_victim_site().await;
    let proxy = spawn_proxy(tmp.path().to_path_buf()).await;
    let victim_origin = format!("http://127.0.0.1:{victim_port}");

    seed_login(&proxy, &victim_origin, &victim_origin);
    proxy.browse_to("https://evil.example");

    let client = test_client();
    let proxy_origin = format!("http://127.0.0.1:{}", proxy.port);
    let resp = client
        .get(format!(
            "{proxy_origin}/proxy/http/127.0.0.1:{victim_port}/account"
        ))
        .header("Origin", &proxy_origin)
        // A document request, the shape a nested iframe produces.
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Sec-Fetch-Dest", "iframe")
        .send()
        .await
        .expect("framing request");

    assert_eq!(resp.status(), 401);
    let body = resp.text().await.unwrap_or_default();
    assert!(!body.contains(SECRET), "leaked via framing: {body}");
}

/// The other half of the contract: partitioning must not break normal browsing.
/// When the victim site *is* the page the user is on, its own cookies are sent
/// and the authenticated page loads.
#[tokio::test]
async fn first_party_browsing_still_sends_cookies() {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let victim_port = spawn_victim_site().await;
    let proxy = spawn_proxy(tmp.path().to_path_buf()).await;
    let victim_origin = format!("http://127.0.0.1:{victim_port}");

    seed_login(&proxy, &victim_origin, &victim_origin);
    // The user navigates to the site itself — first-party.
    proxy.browse_to(&victim_origin);

    let client = test_client();
    let proxy_origin = format!("http://127.0.0.1:{}", proxy.port);
    let resp = client
        .get(format!(
            "{proxy_origin}/proxy/http/127.0.0.1:{victim_port}/account"
        ))
        .header("Origin", &proxy_origin)
        .send()
        .await
        .expect("first-party request");

    assert_eq!(resp.status(), 200, "first-party browsing must still work");
    let body = resp.text().await.unwrap_or_default();
    assert!(
        body.contains(SECRET),
        "the user's own session should load their page: {body}"
    );
}

/// Partitions are independent stores: a login recorded under one top-level
/// origin is invisible from another.
#[tokio::test]
async fn partitions_do_not_share_cookies() {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let jars = PartitionedJars::new(tmp.path().to_path_buf());
    let site = url::Url::parse("https://mail.example/").unwrap();

    let good = jars.get("https://mail.example");
    good.set_cookies(
        &mut [reqwest::header::HeaderValue::from_static(
            "session=abc; Path=/; Max-Age=3600",
        )]
        .iter(),
        &site,
    );

    assert!(good.cookies(&site).is_some(), "own partition sees it");
    assert!(
        jars.get("https://evil.example").cookies(&site).is_none(),
        "another top-level origin must not see it"
    );
    assert!(
        jars.get(cookies::DEFAULT_PARTITION).cookies(&site).is_none(),
        "the default partition must not see it either"
    );
}

/// Distinct origins must never collide onto one jar file — a collision would
/// silently merge two sites' cookies and undo the partitioning.
#[tokio::test]
async fn similar_origins_get_distinct_partitions() {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let jars = PartitionedJars::new(tmp.path().to_path_buf());
    let site = url::Url::parse("https://target.example/").unwrap();

    jars.get("https://a-b.com").set_cookies(
        &mut [reqwest::header::HeaderValue::from_static(
            "session=abc; Path=/; Max-Age=3600",
        )]
        .iter(),
        &site,
    );
    assert!(
        jars.get("https://a_b.com").cookies(&site).is_none(),
        "a-b.com and a_b.com must not share a jar"
    );
}

/// The control case, and proof the pre-existing CSRF gate still works: a page in
/// the user's *normal* browser cannot drive the proxy at all, because its
/// `Origin` is not loopback.
#[tokio::test]
async fn external_origin_is_still_rejected() {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let victim_port = spawn_victim_site().await;
    let proxy = spawn_proxy(tmp.path().to_path_buf()).await;

    let client = test_client();
    let resp = client
        .get(format!(
            "http://127.0.0.1:{}/proxy/http/127.0.0.1:{victim_port}/account",
            proxy.port
        ))
        .header("Origin", "https://evil.example")
        .send()
        .await
        .expect("request");

    assert_eq!(
        resp.status(),
        StatusCode::FORBIDDEN,
        "a genuinely cross-origin page must not be able to drive the proxy"
    );
}
