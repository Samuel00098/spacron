pub mod cookies;

use axum::{
    body::Body,
    extract::{FromRequestParts, Path, State, WebSocketUpgrade},
    http::{Request, Response, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use cookies::{PartitionedJars, PersistentJar};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::async_runtime;
use tokio::sync::oneshot;
use tokio_tungstenite::connect_async;
use url::form_urlencoded;

const INSPECTOR_FLAG: &str = "forge-inspect=1";
const INSPECTOR_SNIPPET: &str = r#"<script>
(() => {
    const active = () => location.hash.includes('forge-inspect=1');
    let state = { enabled: false, hovered: null, selected: null };
    let overlay = null;
    let label = null;
    const originalConsole = {};
    // Captured from the first forge-inspector:set handshake so replies go to the right origin.
    let parentOrigin = '*';

    const serializeValue = (value) => {
        try {
            if (value instanceof Error) {
                return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
            }
            if (typeof value === 'string') return value;
            if (value === undefined) return 'undefined';
            return JSON.stringify(value, (_key, nested) => {
                if (nested instanceof Element) return `<${nested.tagName.toLowerCase()}>`;
                if (nested instanceof Error) return `${nested.name}: ${nested.message}`;
                return nested;
            });
        } catch {
            return String(value);
        }
    };

    const postConsole = (level, args) => {
        // Post to '*' (not the handshake-captured parentOrigin): console output
        // starts during page load, before the parent's forge-inspector:set
        // handshake arrives, so gating on parentOrigin dropped all early logs and
        // left the console panel looking empty. The parent validates the message's
        // real event.origin against the proxy origin, so '*' is safe here.
        try {
            const safeUrl = (() => { try { const u = new URL(location.href); return u.origin + u.pathname; } catch { return ''; } })();
            parent.postMessage({
                type: 'forge-preview:console',
                payload: {
                    level,
                    message: Array.from(args).map(serializeValue).join(' '),
                    url: safeUrl,
                    timestamp: new Date().toISOString()
                }
            }, '*');
        } catch {}
    };

    ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
        const original = console[level];
        if (typeof original !== 'function') return;
        originalConsole[level] = original.bind(console);
        console[level] = (...args) => {
            postConsole(level, args);
            originalConsole[level](...args);
        };
    });

    window.addEventListener('error', (event) => {
        postConsole('error', [event.message || 'Uncaught error', event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '', event.error || '']);
    });

    window.addEventListener('unhandledrejection', (event) => {
        postConsole('error', ['Unhandled promise rejection', event.reason]);
    });

    const escapeCss = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    };

    const buildSelector = (element) => {
        if (!element || element.nodeType !== 1) return '';
        if (element.id) return `#${escapeCss(element.id)}`;

        const parts = [];
        let node = element;
        while (node && node.nodeType === 1 && node !== document.body) {
            let part = node.tagName.toLowerCase();
            if (node.classList && node.classList.length) {
                part += '.' + Array.from(node.classList).slice(0, 3).map(escapeCss).join('.');
            }
            const parent = node.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
                if (siblings.length > 1) {
                    part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
                }
            }
            parts.unshift(part);
            node = node.parentElement;
            if (parts.length >= 4) break;
        }
        return parts.join(' > ');
    };

    const getAttributes = (element) => {
        const attrs = {};
        for (const attr of Array.from(element.attributes || [])) {
            attrs[attr.name] = attr.value;
        }
        return attrs;
    };

    const getStyles = (element) => {
        const computed = window.getComputedStyle(element);
        return {
            display: computed.display,
            position: computed.position,
            color: computed.color,
            backgroundColor: computed.backgroundColor,
            font: computed.font,
            margin: computed.margin,
            padding: computed.padding,
            width: computed.width,
            height: computed.height
        };
    };

    const getAncestorPath = (element) => {
        const path = [];
        let node = element;
        while (node && node.nodeType === 1 && path.length < 6) {
            path.unshift(buildSelector(node));
            node = node.parentElement;
        }
        return path;
    };

    const ensureOverlay = () => {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '2147483646';
        overlay.style.border = '2px solid #7c6af7';
        overlay.style.background = 'rgba(124, 106, 247, 0.12)';
        overlay.style.borderRadius = '4px';
        overlay.style.boxSizing = 'border-box';
        overlay.style.display = 'none';

        label = document.createElement('div');
        label.style.position = 'fixed';
        label.style.zIndex = '2147483647';
        label.style.padding = '6px 8px';
        label.style.borderRadius = '999px';
        label.style.background = 'rgba(16, 16, 20, 0.92)';
        label.style.color = '#fff';
        label.style.font = '12px system-ui, sans-serif';
        label.style.pointerEvents = 'none';
        label.style.display = 'none';

        document.documentElement.appendChild(overlay);
        document.documentElement.appendChild(label);
    };

    const hidePreview = () => {
        if (overlay) overlay.style.display = 'none';
        if (label) label.style.display = 'none';
    };

    const renderPreview = (element) => {
        if (!overlay || !label || !element) return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) {
            hidePreview();
            return;
        }
        overlay.style.display = 'block';
        overlay.style.left = `${Math.max(0, rect.left)}px`;
        overlay.style.top = `${Math.max(0, rect.top)}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
        label.style.display = 'block';
        label.textContent = `${element.tagName.toLowerCase()} ${buildSelector(element)}`.trim();
        label.style.left = `${Math.max(8, rect.left)}px`;
        label.style.top = `${Math.max(8, rect.top - 30)}px`;
    };

    const setEnabled = (enabled) => {
        state.enabled = enabled;
        document.documentElement.style.cursor = enabled ? 'crosshair' : '';
        if (enabled) ensureOverlay(); else hidePreview();
    };

    document.addEventListener('mousemove', (event) => {
        if (!state.enabled) return;
        const element = event.target instanceof Element ? event.target : null;
        state.hovered = element;
        renderPreview(element);
    }, true);

    document.addEventListener('click', (event) => {
        if (!state.enabled) return;
        const element = event.target instanceof Element ? event.target : null;
        if (!element) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = element.getBoundingClientRect();
        const selector = buildSelector(element);
        state.selected = {
            selector,
            tag: element.tagName.toLowerCase(),
            text: (element.innerText || element.textContent || '').trim().slice(0, 500),
            html: (element.outerHTML || '').slice(0, 3000),
            attributes: getAttributes(element),
            classes: Array.from(element.classList || []),
            styles: getStyles(element),
            ancestorPath: getAncestorPath(element),
            page: { url: location.href, title: document.title },
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
        parent.postMessage({ type: 'forge-inspector:selected', payload: state.selected }, parentOrigin);
    }, true);

    window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const data = event.data || {};
        if (data.type !== 'forge-inspector:set') return;
        if (data.parentOrigin) parentOrigin = data.parentOrigin;
        setEnabled(Boolean(data.enabled));
    });

    window.addEventListener('hashchange', () => setEnabled(active()));
    setEnabled(active());
})();
</script>"#;

const SCROLL_FLAG: &str = "spacron-scroll-sync";
// Tiny, self-contained scroll-position bridge injected into *every* proxied HTML
// page (local dev and external alike). The preview iframe is cross-origin to the
// app, so the parent cannot read or set the document's scroll directly — this
// reports the offset to the parent (which persists it per-URL) and restores it
// on request after the page loads. Posts to the parent with '*' since the value
// is non-sensitive; the parent validates the message's real origin.
const SCROLL_SNIPPET: &str = r#"<script data-spacron-scroll-sync>
(() => {
    if (window.__spacronScrollSync) return;
    window.__spacronScrollSync = true;
    let raf = 0;
    const report = () => {
        raf = 0;
        try { parent.postMessage({ type: 'forge-preview:scroll', x: window.scrollX, y: window.scrollY }, '*'); } catch {}
    };
    window.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(report);
    }, { passive: true });
    window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const data = event.data || {};
        if (data.type !== 'forge-preview:scroll-restore') return;
        const x = Number(data.x) || 0;
        const y = Number(data.y) || 0;
        // Content can reflow for a moment after load, so re-apply a few times
        // until the target sticks (or we give up).
        let tries = 0;
        const attempt = () => {
            window.scrollTo(x, y);
            if (++tries < 10 && Math.abs(window.scrollY - y) > 2) setTimeout(attempt, 100);
        };
        attempt();
    });
    const ready = () => { try { parent.postMessage({ type: 'forge-preview:scroll-ready' }, '*'); } catch {} };
    if (document.readyState === 'complete') ready();
    else window.addEventListener('load', ready);
})();
</script>"#;

const NAV_FLAG: &str = "spacron-nav-rewrite";
// Navigation rewriter injected into *external* proxied pages only. The proxy
// serves external sites under its own loopback origin
// (http://127.0.0.1:{proxy_port}/proxy/{scheme}/{host}/...) and strips their
// X-Frame-Options/CSP so they can render inside the preview iframe. But the
// links *inside* those pages still point at absolute/protocol-relative URLs
// (e.g. DuckDuckGo results link to //duckduckgo.com/l/?uddg=<real-site>), so a
// plain click navigates the iframe straight out to the real internet — where the
// destination's X-Frame-Options then blocks it ("refused to connect"). This
// interceptor rewrites in-page link clicks and form submits back through the
// proxy so navigation stays on the proxy origin (where embedding guards are
// stripped). It also unwraps DuckDuckGo's /l/?uddg= redirect to land directly on
// the destination instead of chasing the tracker hop. Posts to '*'-free; it only
// rewrites same-document navigations and never touches the parent window.
const NAV_SNIPPET: &str = r#"<script data-spacron-nav-rewrite>
(() => {
    if (window.__spacronNavRewrite) return;
    window.__spacronNavRewrite = true;
    const proxyOrigin = location.origin;
    const unwrap = (u) => {
        // DuckDuckGo wraps each result in //duckduckgo.com/l/?uddg=<real-url>.
        // Decode it so we proxy the real destination directly (clean address bar,
        // one fewer redirect hop).
        if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname === '/l/') {
            const uddg = u.searchParams.get('uddg');
            if (uddg) { try { return new URL(uddg); } catch (e) {} }
        }
        return u;
    };
    const toProxy = (href) => {
        let u;
        try { u = new URL(href, location.href); } catch (e) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.origin === proxyOrigin) return null; // already proxied / same-origin
        u = unwrap(u);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        const scheme = u.protocol.replace(':', '');
        return proxyOrigin + '/proxy/' + scheme + '/' + u.host + u.pathname + u.search + u.hash;
    };
    document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        const proxied = toProxy(anchor.getAttribute('href'));
        if (!proxied) return;
        event.preventDefault();
        window.location.href = proxied;
    }, true);
    document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!form || typeof form.getAttribute !== 'function') return;
        let u;
        try { u = new URL(form.getAttribute('action') || location.href, location.href); } catch (e) { return; }
        if (u.origin === proxyOrigin) return; // already lands on the proxy
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        const scheme = u.protocol.replace(':', '');
        // GET forms ignore the action's query string (the browser rebuilds it from
        // the fields), so dropping u.search here is correct; the proxied path is
        // enough to keep the submission on the proxy origin.
        form.action = proxyOrigin + '/proxy/' + scheme + '/' + u.host + u.pathname;
    }, true);

    // Report the page's *real* (external) URL to the app shell so the address bar
    // and Back/Forward history track navigation like a real browser. The iframe is
    // cross-origin to the app shell, so the parent cannot read our location
    // directly — postMessage is the only channel. On the first load we trust the
    // server-injected <meta name="spacron-location"> (it holds the post-redirect
    // URL the proxy actually fetched); for in-page history changes we decode our
    // own proxy URL instead, since the meta only reflects the initial load.
    const decodeSelf = () => {
        const m = location.pathname.match(/^\/proxy\/(https?)\/([^/]+)(\/.*)?$/);
        if (!m) return '';
        return m[1] + '://' + m[2] + (m[3] || '') + location.search + location.hash;
    };
    const report = (url) => {
        if (!url) return;
        try { parent.postMessage({ type: 'forge-preview:location', url: url }, '*'); } catch (e) {}
    };
    const reportInitial = () => {
        const meta = document.querySelector('meta[name="spacron-location"]');
        report(meta && meta.content ? meta.content : decodeSelf());
    };
    const reportDynamic = () => report(decodeSelf());
    if (document.readyState !== 'loading') reportInitial();
    else document.addEventListener('DOMContentLoaded', reportInitial);
    window.addEventListener('popstate', reportDynamic);
    window.addEventListener('hashchange', reportDynamic);
})();
</script>"#;

const BRIDGE_FLAG: &str = "spacron-proxy-bridge";
// Universal request bridge, injected at the TOP of <head> of EVERY proxied
// external page (it must wrap fetch/XHR before the page's own scripts capture
// them). Generalized from the bridge that originally shipped YTM playback —
// the same two failure modes break most dynamic sites under the proxy:
//
// 1. Root-relative API calls (`fetch('/api/…')`). Under the proxy the page's
//    origin is the loopback proxy, so these resolve to the proxy root and only
//    work while the shared recorded-origin fallback happens to point at the
//    right host. The bridge pins them onto the explicit
//    `/proxy/{scheme}/{host}` form — deterministic routing per page.
// 2. Cross-origin fetch/XHR (CDNs, API subdomains, `googlevideo` streams).
//    From the loopback origin these are CORS-blocked outright. Rewritten
//    through the proxy they become same-origin, and the proxy's cookie jar
//    supplies the real site's cookies.
//
// It also bridges WebSocket (via the proxy's `/proxy-ws/{ws|wss}/{host}` route
// — chat/collab apps are dead without it), EventSource, and sendBeacon, and
// wraps history.pushState/replaceState so SPA route changes keep the
// `/proxy/{scheme}/{host}` prefix (a bare `history.pushState(0,'','/inbox')`
// would strand the iframe on the proxy root, breaking reload and the address
// bar) while reporting each change to the app shell's address bar.
const BRIDGE_SNIPPET: &str = r#"<script data-spacron-proxy-bridge>
(() => {
    if (window.__spacronProxyBridge) return;
    window.__spacronProxyBridge = true;
    const m = location.pathname.match(/^\/proxy\/(https?)\/([^/]+)/);
    if (!m) return;
    const realScheme = m[1], realHost = m[2];
    const proxyOrigin = location.origin;
    const prefix = '/proxy/' + realScheme + '/' + realHost;
    const rewrite = (raw) => {
        let u;
        try { u = new URL(String(raw), location.href); } catch (e) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.origin === proxyOrigin) {
            // Already an explicit proxy path — leave it alone. Anything else on
            // the proxy origin is a root-relative call the page meant for its
            // real host (e.g. /api/session) — pin it there explicitly instead
            // of relying on the shared recorded-origin fallback.
            if (u.pathname.startsWith('/proxy/') || u.pathname.startsWith('/proxy-ws/')) return null;
            return proxyOrigin + prefix + u.pathname + u.search;
        }
        return proxyOrigin + '/proxy/' + u.protocol.replace(':', '') + '/' + u.host + u.pathname + u.search;
    };
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            if (input instanceof Request) {
                const r = rewrite(input.url);
                if (r) input = new Request(r, input);
            } else {
                const r = rewrite(input);
                if (r) input = r;
            }
        } catch (e) { /* fall through with the original input */ }
        return origFetch.call(this, input, init);
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try { const r = rewrite(url); if (r) url = r; } catch (e) {}
        return origOpen.call(this, method, url, ...rest);
    };
    if (navigator.sendBeacon) {
        const origBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
            try { const r = rewrite(url); if (r) url = r; } catch (e) {}
            try { return origBeacon(url, data); } catch (e) { return false; }
        };
    }
    // WebSocket: route through the proxy's ws bridge. A root-relative
    // `new WebSocket('/socket')` resolves against the loopback proxy host, so
    // pin it to the page's real host; absolute ws(s) URLs to any host go
    // through the bridge too so wss handshakes carry the site's cookies.
    const wsRewrite = (raw) => {
        let u;
        try { u = new URL(String(raw), location.href); } catch (e) { return null; }
        if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
        if (u.host === location.host) {
            if (u.pathname.startsWith('/proxy-ws/')) return null;
            const scheme = realScheme === 'https' ? 'wss' : 'ws';
            return 'ws://' + location.host + '/proxy-ws/' + scheme + '/' + realHost + u.pathname + u.search;
        }
        return 'ws://' + location.host + '/proxy-ws/' + u.protocol.replace(':', '') + '/' + u.host + u.pathname + u.search;
    };
    if (window.WebSocket) {
        window.WebSocket = new Proxy(window.WebSocket, {
            construct(target, args) {
                try { const r = wsRewrite(args[0]); if (r) args[0] = r; } catch (e) {}
                return new target(...args);
            }
        });
    }
    if (window.EventSource) {
        window.EventSource = new Proxy(window.EventSource, {
            construct(target, args) {
                try { const r = rewrite(args[0]); if (r) args[0] = r; } catch (e) {}
                return new target(...args);
            }
        });
    }
    // SPA route changes: keep the URL on the /proxy path and tell the shell.
    const toProxyPath = (raw) => {
        if (raw === undefined || raw === null || raw === '') return null;
        let u;
        try { u = new URL(String(raw), location.href); } catch (e) { return null; }
        if (u.origin === proxyOrigin) {
            if (u.pathname.startsWith('/proxy/')) return null;
            return prefix + u.pathname + u.search + u.hash;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return '/proxy/' + u.protocol.replace(':', '') + '/' + u.host + u.pathname + u.search + u.hash;
    };
    const decodeSelf = () => {
        const mm = location.pathname.match(/^\/proxy\/(https?)\/([^/]+)(\/.*)?$/);
        if (!mm) return '';
        return mm[1] + '://' + mm[2] + (mm[3] || '') + location.search + location.hash;
    };
    const reportLocation = () => {
        const url = decodeSelf();
        if (!url) return;
        try { parent.postMessage({ type: 'forge-preview:location', url: url }, '*'); } catch (e) {}
    };
    ['pushState', 'replaceState'].forEach((fn) => {
        const orig = history[fn];
        if (typeof orig !== 'function') return;
        history[fn] = function (state, title, url) {
            try { const r = toProxyPath(url); if (r !== null) url = r; } catch (e) {}
            const out = orig.call(this, state, title, url);
            reportLocation();
            return out;
        };
    });
})();
</script>"#;

const YTM_FLAG: &str = "spacron-ytm-chrome";
// Injected ONLY into proxied music.youtube.com pages (the Music mode embed):
// hides YTM's site shell — left guide, logo, premium upsell banners — so the
// embed reads as a music player rather than a website in a box. Search box and
// player bar stay. Selectors are best-effort against YTM's current markup; if
// Google renames them the worst case is a hidden element reappearing, never
// broken playback. (YTM's request bridging is handled by the universal
// BRIDGE_SNIPPET above, which grew out of the YTM-specific bridge.)
const YTM_SNIPPET: &str = r#"<style data-spacron-ytm-chrome>
ytmusic-guide-renderer,
#mini-guide,
ytmusic-guide-mini-renderer,
ytmusic-mealbar-promo-renderer,
ytmusic-banner-promo-renderer,
ytmusic-nav-bar .left-content {
    display: none !important;
}
ytmusic-app-layout {
    --ytmusic-guide-width: 0px;
    --ytmusic-mini-guide-width: 0px;
}
</style>"#;


#[derive(Clone)]
pub struct ProxyState {
    pub target_port: Arc<Mutex<u16>>,
    pub preferred_local_host: Arc<Mutex<Option<String>>>,
    pub active_external_origins: Arc<Mutex<std::collections::HashMap<String, Option<String>>>>,
    pub active_project_id: Arc<std::sync::RwLock<Option<String>>>,
    pub project_root: Arc<std::sync::RwLock<Option<std::path::PathBuf>>>,
    pub external_origin_fallback: bool,
    /// Cookie jars keyed by the top-level origin the user is on. See
    /// [`cookies::PartitionedJars`] for why this is partitioned rather than
    /// shared, and `preview::proxy_origin_e2e` for the attack it stops.
    pub cookie_jars: Arc<PartitionedJars>,
    /// The committed top-level origin, set by the frontend before it points the
    /// preview iframe anywhere. `None` until the first real navigation.
    pub active_partition: Arc<std::sync::RwLock<Option<String>>>,
    /// One upstream client per partition, each bound to that partition's jar.
    /// reqwest resolves cookies through the client's own store and the trait
    /// gives us no request context to switch on, so the partition has to be
    /// chosen by picking the client.
    pub partition_clients: Arc<Mutex<HashMap<String, Client>>>,
    pub local_client: Client,
}

impl ProxyState {
    /// The partition key for requests arriving right now: whatever top-level
    /// origin the frontend last committed, or the default bucket before any.
    pub fn partition(&self) -> String {
        self.active_partition
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(|| cookies::DEFAULT_PARTITION.to_string())
    }

    /// The upstream client carrying the current partition's cookies.
    pub fn client(&self) -> Client {
        let partition = self.partition();
        let mut clients = self.partition_clients.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(client) = clients.get(&partition) {
            return client.clone();
        }
        let client = preview_http_client(self.cookie_jars.get(&partition));
        clients.insert(partition, client.clone());
        client
    }

    /// The current partition's jar, for the paths that bypass the reqwest client
    /// (the external WebSocket bridge builds its own `Cookie` header).
    pub fn cookie_jar(&self) -> Arc<PersistentJar> {
        self.cookie_jars.get(&self.partition())
    }
}

pub struct PreviewManager {
    target_port: Arc<Mutex<u16>>,
    preferred_local_host: Arc<Mutex<Option<String>>>,
    proxy_port: Arc<Mutex<Option<u16>>>,
    local_dev_proxy_ports: Arc<Mutex<HashMap<String, u16>>>,
    pub active_external_origins: Arc<Mutex<std::collections::HashMap<String, Option<String>>>>,
    pub active_project_id: Arc<std::sync::RwLock<Option<String>>>,
    pub project_root: Arc<std::sync::RwLock<Option<std::path::PathBuf>>>,
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    /// Disk-persisted cookie jars, partitioned by top-level origin and shared by
    /// every proxy instance, so logins on proxied external sites survive app
    /// restarts without leaking across sites (see cookies.rs).
    cookie_jars: Arc<PartitionedJars>,
    /// Committed top-level origin, published by the frontend.
    active_partition: Arc<std::sync::RwLock<Option<String>>>,
    partition_clients: Arc<Mutex<HashMap<String, Client>>>,
}

impl PreviewManager {
    pub fn new(
        active_project_id: Arc<std::sync::RwLock<Option<String>>>,
        config_dir: std::path::PathBuf,
    ) -> Self {
        PreviewManager {
            target_port: Arc::new(Mutex::new(5173)),
            preferred_local_host: Arc::new(Mutex::new(None)),
            proxy_port: Arc::new(Mutex::new(None)),
            local_dev_proxy_ports: Arc::new(Mutex::new(HashMap::new())),
            active_external_origins: Arc::new(Mutex::new(std::collections::HashMap::new())),
            active_project_id,
            project_root: Arc::new(std::sync::RwLock::new(None)),
            shutdown_tx: Arc::new(Mutex::new(None)),
            // Directory, not a single file: one jar per top-level origin. The
            // pre-partition `preview-cookies.json` is deliberately left alone
            // rather than migrated — its cookies have no recorded partition, so
            // there is no safe bucket to put them in, and guessing would
            // reintroduce the cross-site leak. Users re-log-in once on sites they
            // had signed into through the preview browser.
            cookie_jars: PartitionedJars::new(config_dir.join("preview-cookies")),
            active_partition: Arc::new(std::sync::RwLock::new(None)),
            partition_clients: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Record the top-level origin the preview has navigated to. Called by the
    /// frontend *before* it assigns `iframe.src`, so every request the resulting
    /// page makes — document, subresource, nested frame, or scripted fetch —
    /// resolves against the right cookie partition.
    pub fn set_active_partition(&self, origin: Option<String>) {
        let normalized = origin.and_then(|raw| {
            url::Url::parse(&raw).ok().and_then(|u| {
                u.host_str().map(|host| match u.port() {
                    Some(port) => format!("{}://{}:{}", u.scheme(), host, port),
                    None => format!("{}://{}", u.scheme(), host),
                })
            })
        });
        *self
            .active_partition
            .write()
            .unwrap_or_else(|e| e.into_inner()) = normalized;
    }

    pub fn start_proxy(&self) -> Result<u16, String> {
        let mut shutdown_tx_lock = self.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner());
        if shutdown_tx_lock.is_some() {
            if let Some(port) = *self.proxy_port.lock().unwrap_or_else(|e| e.into_inner()) {
                return Ok(port);
            }
        }

        let proxy_port = get_free_port().ok_or_else(|| "Could not find a free port".to_string())?;
        *self.proxy_port.lock().unwrap_or_else(|e| e.into_inner()) = Some(proxy_port);

        let (tx, rx) = oneshot::channel::<()>();
        *shutdown_tx_lock = Some(tx);

        let state = ProxyState {
            target_port: self.target_port.clone(),
            preferred_local_host: self.preferred_local_host.clone(),
            active_external_origins: self.active_external_origins.clone(),
            active_project_id: self.active_project_id.clone(),
            project_root: self.project_root.clone(),
            external_origin_fallback: true,
            cookie_jars: self.cookie_jars.clone(),
            active_partition: self.active_partition.clone(),
            partition_clients: self.partition_clients.clone(),
            local_client: preview_local_http_client(),
        };

        let app = Router::new()
            .route("/local-file", any(serve_local_file))
            .route("/local-file/{*file_path}", any(serve_local_file_path))
            .fallback(any(proxy_handler))
            .with_state(state);

        let addr = SocketAddr::from(([127, 0, 0, 1], proxy_port));

        async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Failed to bind preview server: {}", e);
                    return;
                }
            };

            let serve = axum::serve(NoDelayListener(listener), app);

            tokio::select! {
                res = serve => {
                    if let Err(e) = res {
                        eprintln!("Preview server error: {}", e);
                    }
                }
                _ = rx => {
                    println!("Preview server shutdown signal received");
                }
            }
        });

        Ok(proxy_port)
    }

    pub fn start_local_dev_proxy(&self, host: Option<String>, port: u16) -> Result<u16, String> {
        if port == 0 {
            return Err("Port 0 is not a valid target port".to_string());
        }

        let normalized_host = normalize_local_host(host.as_deref())?;
        let key = format!("{}:{}", normalized_host, port);

        {
            let local_ports = self
                .local_dev_proxy_ports
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(existing_port) = local_ports.get(&key) {
                return Ok(*existing_port);
            }
        }

        let proxy_port = get_free_port().ok_or_else(|| "Could not find a free port".to_string())?;
        self.local_dev_proxy_ports
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, proxy_port);

        let state = ProxyState {
            target_port: Arc::new(Mutex::new(port)),
            preferred_local_host: Arc::new(Mutex::new(Some(normalized_host))),
            active_external_origins: self.active_external_origins.clone(),
            active_project_id: self.active_project_id.clone(),
            project_root: self.project_root.clone(),
            external_origin_fallback: false,
            cookie_jars: self.cookie_jars.clone(),
            active_partition: self.active_partition.clone(),
            partition_clients: self.partition_clients.clone(),
            local_client: preview_local_http_client(),
        };

        let app = Router::new()
            .route("/local-file", any(serve_local_file))
            .route("/local-file/{*file_path}", any(serve_local_file_path))
            .fallback(any(proxy_handler))
            .with_state(state);
        let addr = SocketAddr::from(([127, 0, 0, 1], proxy_port));

        async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Failed to bind local dev preview server: {}", e);
                    return;
                }
            };

            if let Err(e) = axum::serve(NoDelayListener(listener), app).await {
                eprintln!("Local dev preview server error: {}", e);
            }
        });

        Ok(proxy_port)
    }

    pub fn stop_proxy(&self) -> Result<(), String> {
        let mut shutdown_tx = self.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = shutdown_tx.take() {
            let _ = tx.send(());
        }
        *self.proxy_port.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // Don't leave freshly-set login cookies riding on the 3s debounce.
        self.cookie_jars.flush_all();
        Ok(())
    }

    /// Drop every stored preview-proxy cookie (part of "clear browsing data").
    pub fn clear_cookies(&self) {
        self.cookie_jars.clear_all();
        // Drop the per-partition clients too; each holds a handle to a jar we just
        // emptied, and a stale client would keep serving its cached cookies.
        self.partition_clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    pub fn set_target_port(&self, port: u16) -> Result<(), String> {
        *self.target_port.lock().unwrap_or_else(|e| e.into_inner()) = port;
        Ok(())
    }

    pub fn get_target_port(&self) -> u16 {
        *self.target_port.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_preferred_local_host(&self, host: Option<String>) -> Result<(), String> {
        let normalized = host
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), "127.0.0.1" | "localhost" | "0.0.0.0"));
        *self
            .preferred_local_host
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = normalized;
        Ok(())
    }

    pub fn get_proxy_port(&self) -> Option<u16> {
        *self.proxy_port.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn clear_proxy_target(&self) -> Result<(), String> {
        let active_project = self
            .active_project_id
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(project_id) = active_project {
            let mut origins = self
                .active_external_origins
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            origins.insert(project_id, None);
        }
        Ok(())
    }

    pub fn set_project_root(&self, root: Option<std::path::PathBuf>) {
        if let Ok(mut guard) = self.project_root.write() {
            *guard = root;
        }
    }
}

fn normalize_local_host(host: Option<&str>) -> Result<String, String> {
    let normalized = host.unwrap_or("localhost").trim().to_ascii_lowercase();

    match normalized.as_str() {
        "127.0.0.1" | "localhost" | "0.0.0.0" => Ok(normalized),
        _ => Err("Only localhost, 127.0.0.1, or 0.0.0.0 can be previewed locally".to_string()),
    }
}

fn preview_http_client(jar: Arc<PersistentJar>) -> Client {
    preview_http_client_builder()
        // Server-side cookie jar for proxied *external* sites. The proxy serves
        // them under its loopback origin, so any Set-Cookie scoped to the real
        // site (e.g. `Domain=.youtube.com`) is rejected by the WebView as a
        // domain mismatch. Sites that gate content on a cookie round-trip —
        // YouTube Music's consent bounce is the canonical case — then redirect
        // forever and never play. The jar lives here instead: this client talks
        // to the real origin, so those cookies are valid for it. The jar is the
        // disk-persisted PersistentJar (shared across every proxy instance), so
        // logins on proxied sites survive app restarts.
        .cookie_provider(jar)
        .build()
        .unwrap_or_default()
}

fn preview_local_http_client() -> Client {
    preview_http_client_builder()
        // Local preview must always connect directly to the user's dev server.
        // If HTTP(S)_PROXY / ALL_PROXY is present, reqwest can otherwise send
        // loopback requests through a proxy/VPN TLS layer and surface misleading
        // TLS failures such as BadRecordMac for plain http://localhost URLs.
        .no_proxy()
        // Don't follow ANY redirect here — hand every 3xx back to the preview's
        // WebView so the browser performs the navigation itself. This is essential
        // for cookie-based auth (Clerk, Auth0, NextAuth, Supabase …): the dev
        // server bounces the first request through the provider's hosted Frontend
        // API to run a handshake, and each hop carries Set-Cookie headers that only
        // mean anything if they land in the *browser*. Following redirects here
        // instead would (a) drop those cookies (reqwest has no cookie jar), (b)
        // tunnel the outbound TLS hop through a system/VPN proxy → BadRecordMac,
        // and (c) strand the browser on the raw dev-server origin, whose
        // `frame-ancestors` CSP then blocks the preview iframe. Paired with the
        // Host rewrite in proxy_local_dev_request (which makes every redirect the
        // dev server emits point back at the proxy origin), this keeps the whole
        // flow on the proxy — where CSP/X-Frame-Options are stripped — while the
        // browser drives the redirects exactly as a real browser would.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
}

fn preview_http_client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .user_agent(concat!(
            "spacron/",
            env!("CARGO_PKG_VERSION"),
            " (preview-proxy)"
        ))
        .gzip(true)
        .brotli(true)
        // Disable Nagle on the upstream (proxy -> dev server) leg too, so request
        // writes aren't delayed. reqwest defaults this on, but we set it
        // explicitly to keep the no-Nagle guarantee independent of that default.
        .tcp_nodelay(true)
        // Cold DNS + TCP + TLS to an external host routinely takes longer than a
        // second, so a sub-second connect budget makes real sites fail with
        // "error sending request". Loopback connect failures (dev server not
        // listening) return ECONNREFUSED instantly regardless of this value, so a
        // generous timeout doesn't slow local-dev host failover.
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(false)
        // Never follow redirects server-side; hand every 3xx back to the preview
        // WebView (with Location rewritten to stay on the proxy) so the *browser*
        // drives the redirect chain. This matters for cookie-based auth
        // handshakes (Clerk, Auth0, …): each hop carries Set-Cookie headers that
        // only take effect if they land in the browser — reqwest has no cookie
        // jar, so following here silently drops them, and a dev-instance
        // handshake then loops between the provider and the app until the 30s
        // client timeout fires ("operation timed out"). Not following also
        // removes the risk of the client chasing a redirect into a private
        // range: the rewritten Location re-enters the proxy, where the
        // private-target and restricted-port gates run on every hop.
        .redirect(reqwest::redirect::Policy::none())
}

/// Format a reqwest error including its underlying source chain. reqwest's own
/// `Display` collapses transport failures to a generic "error sending request
/// for url (...)" and drops the cause (timeout vs DNS vs TLS vs refused), which
/// makes proxy failures undiagnosable. Walk the `source()` chain so the real
/// reason reaches the preview's error surface.
fn describe_request_error(err: &reqwest::Error) -> String {
    use std::error::Error;
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

fn get_free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .ok()
}

/// `axum::serve` wrapper that disables Nagle on every accepted connection.
///
/// The proxy writes a response as headers-then-body. With Nagle enabled (tokio's
/// default for accepted sockets) the body write is held back until the client
/// ACKs the headers, and the client's delayed-ACK timer (~200ms on Windows) fires
/// first — adding a fixed ~200ms stall to *every* proxied response. A dev page
/// pulls dozens of JS/CSS chunks, so that per-response stall compounds into the
/// multi-second gap between the in-app preview and a real browser. Setting
/// `TCP_NODELAY` lets the body flush immediately.
struct NoDelayListener(tokio::net::TcpListener);

impl axum::serve::Listener for NoDelayListener {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.0.accept().await {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    return (stream, addr);
                }
                // Mirror axum's own TcpListener handling: a transient accept error
                // must not tear the server down, so back off briefly and retry.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

fn get_target_url(query: &str) -> Option<String> {
    form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())
}

fn get_target_url_from_proxy_path(path: &str, query: Option<&str>) -> Option<String> {
    let proxy_path = path.strip_prefix("/proxy/")?;
    let mut segments = proxy_path.splitn(3, '/');
    let scheme = segments.next()?;
    let authority = segments.next()?;
    if scheme != "http" && scheme != "https" {
        return None;
    }

    let remainder = segments.next().unwrap_or("");
    let mut target = if remainder.is_empty() {
        format!("{scheme}://{authority}/")
    } else {
        format!("{scheme}://{authority}/{remainder}")
    };

    if let Some(query) = query.filter(|value| !value.is_empty()) {
        target.push('?');
        target.push_str(query);
    }

    Some(target)
}

fn is_private_target(url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            if host == "127.0.0.1" || host == "localhost" || host == "0.0.0.0" {
                return true;
            }
            if let Ok(addr) = host.parse::<std::net::IpAddr>() {
                return match addr {
                    std::net::IpAddr::V4(v4) => {
                        v4.is_loopback()
                            || v4.is_private()
                            || v4.is_link_local()
                            || v4.is_multicast()
                            || v4.octets()[0] == 169 && v4.octets()[1] == 254
                    }
                    std::net::IpAddr::V6(v6) => {
                        let segs = v6.segments();
                        v6.is_loopback()
                            || v6.is_multicast()
                            || v6.is_unspecified()
                            // ULA: fc00::/7
                            || (segs[0] & 0xfe00) == 0xfc00
                            // Link-local: fe80::/10
                            || (segs[0] & 0xffc0) == 0xfe80
                    }
                };
            }
        }
    }
    false
}

/// True when `host` resolves to an address in a blocked private range. Loopback
/// resolutions are deliberately NOT blocked: a hostname that maps to the user's
/// own machine (a hosts-file alias like `myapp.test`, or `lvh.me`-style wildcard
/// DNS) is just another loopback alias, and loopback targets are allowed through
/// the proxy by policy — blocking them here while allowing literal `localhost`
/// made local custom-domain setups fail with "private/internal resources".
/// What this check closes is the DNS-rebinding path where an innocuous-looking
/// public hostname resolves to a LAN, link-local, ULA, unspecified, or
/// cloud-metadata address. Resolution failures return false so the client
/// surfaces the real connection error instead of a misleading block.
async fn has_blocked_resolved_ip(host: &str, port: u16) -> bool {
    use std::net::IpAddr;
    let addr_str = format!("{}:{}", host, port);
    match tokio::net::lookup_host(addr_str).await {
        Ok(addrs) => addrs.into_iter().any(|sa| match sa.ip() {
            IpAddr::V4(v4) => {
                !v4.is_loopback()
                    && (v4.is_private()
                        || v4.is_link_local()
                        || v4.is_multicast()
                        || v4.is_unspecified())
            }
            IpAddr::V6(v6) => {
                let segs = v6.segments();
                !v6.is_loopback()
                    && (v6.is_multicast()
                        || v6.is_unspecified()
                        || (segs[0] & 0xfe00) == 0xfc00  // ULA fc00::/7
                        || (segs[0] & 0xffc0) == 0xfe80) // link-local fe80::/10
            }
        }),
        Err(_) => false,
    }
}

/// True when the URL's host is a loopback alias — `localhost`, an IPv4 loopback
/// address (127.0.0.0/8), or IPv6 `::1`. The preview proxy blocks *private*
/// targets as an SSRF guard, but loopback is the user's own machine and is
/// precisely what local-dev previewing targets: a dev app that redirects to
/// another local service (a second dev server, a local auth/API service) must be
/// reachable *through the proxy* so its framing headers get stripped. Genuinely
/// private LAN ranges (RFC1918, link-local, ULA, cloud metadata) stay blocked by
/// `is_private_target`, and `is_restricted_port` still blocks dangerous loopback
/// services (databases, Docker, Kubernetes, …), so relaxing loopback here does
/// not open the proxy to the wider network. `proxy_request_allowed` rejects
/// cross-origin fetch/XHR from pages in the user's normal browser; plain GET
/// navigations and img/script loads carry no Origin header, so their residual
/// reach is a blind GET to a non-restricted loopback port — and only if the
/// attacker first guesses the proxy's randomized ephemeral port.
fn is_loopback_host_target(url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            if host.eq_ignore_ascii_case("localhost") {
                return true;
            }
            // `host_str` wraps IPv6 literals in brackets (`[::1]`), which don't
            // parse as an `IpAddr` — strip them first.
            let bare = host.trim_start_matches('[').trim_end_matches(']');
            if let Ok(addr) = bare.parse::<std::net::IpAddr>() {
                return addr.is_loopback();
            }
        }
    }
    false
}

/// True for a host that belongs to the app itself: loopback literals or any
/// `*.localhost` name. Tauri serves the main webview from a custom-protocol
/// origin like `tauri.localhost` / `http://tauri.localhost`, and the embedded
/// preview is served from `127.0.0.1:{proxy_port}`, so requests originating from
/// either are first-party to us.
fn is_first_party_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "localhost"
        || host == "::1"
        || host.ends_with(".localhost")
}

/// CSRF/SSRF guard for the preview proxy. The proxy listens on a loopback port
/// with no per-request secret, so without this check any web page the user opens
/// in their *normal* browser could script requests at `http://127.0.0.1:{port}/`
/// and use the proxy to reach the user's dev server / other loopback services or
/// as a request-forwarding SSRF gadget.
///
/// A browser always attaches an `Origin` header to cross-origin requests (and to
/// same-origin non-GET requests). We allow a request only when it has no `Origin`
/// (top-level navigations the embedded preview performs, and most same-origin
/// GETs) or when the `Origin` is first-party — loopback or `*.localhost`, which
/// covers both the Spacron main webview and the proxied page's own subresources
/// (served from the proxy origin). A page on `https://evil.example` is rejected
/// because its `Origin` host is not first-party. `Origin: null` (sandboxed /
/// `data:` documents) is rejected too, since it is never something we emit.
fn proxy_request_allowed(headers: &axum::http::HeaderMap) -> bool {
    match headers.get("origin").and_then(|v| v.to_str().ok()) {
        None => true,
        Some(origin) => url::Url::parse(origin)
            .ok()
            .and_then(|u| u.host_str().map(is_first_party_host))
            .unwrap_or(false),
    }
}

fn is_restricted_port(port: u16) -> bool {
    matches!(
        port,
        22     // SSH
        | 23   // Telnet
        | 25   // SMTP
        | 53   // DNS
        | 110  // POP3
        | 135  // RPC
        | 139  // NetBIOS
        | 143  // IMAP
        | 445  // SMB
        | 993  // IMAPS
        | 995  // POP3S
        | 2375 // Docker daemon (unauthenticated)
        | 3306 // MySQL
        | 3389 // RDP
        | 5432 // PostgreSQL
        | 6379 // Redis
        | 6443 // Kubernetes API
        | 8500 // Consul
        | 9090 // Prometheus
        | 27017 // MongoDB
    )
}

fn local_dev_hosts(preferred_host: Option<&str>) -> Vec<&'static str> {
    let mut hosts = vec!["127.0.0.1", "localhost"];
    match preferred_host {
        Some("localhost") => hosts.swap(0, 1),
        Some("0.0.0.0") => {}
        Some("127.0.0.1") => {}
        _ => {}
    }
    hosts
}

/// Serve a local file from the project directory through the proxy.
/// Used for previewing HTML files (and their relative CSS/JS/image dependencies)
/// directly from the file system. The `path` query parameter specifies the
/// absolute file path. For HTML files, a `<base>` tag is injected so that
/// relative URLs in the document resolve correctly through this same route.
async fn serve_local_file(
    State(state): State<ProxyState>,
    req: Request<Body>,
) -> Response<Body> {
    let query = req.uri().query().unwrap_or("");
    let path: String = form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();

    if path.is_empty() {
        return local_file_error(
            StatusCode::BAD_REQUEST,
            "🔗",
            "No file specified",
            "The preview link didn't include a file to open.",
            None,
        );
    }

    // Validate the file path is within the project root.
    let project_root = state
        .project_root
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(root) = project_root else {
        return local_file_error(
            StatusCode::BAD_REQUEST,
            "📂",
            "No project open",
            "Open a project folder in Spacron first, then preview a file inside it.",
            Some("The preview can only serve files that live inside the currently open project."),
        );
    };

    let file_path = std::path::PathBuf::from(&path);
    let canonical = if file_path.exists() {
        std::fs::canonicalize(&file_path).unwrap_or_else(|_| file_path.clone())
    } else {
        return local_file_error(
            StatusCode::NOT_FOUND,
            "🔍",
            "File not found",
            "This file no longer exists on disk.",
            Some("It may have been moved, renamed, or deleted since the preview was opened."),
        );
    };
    // On Windows `canonicalize` yields a `\\?\` verbatim path, but the stored
    // project root was stripped via `clean_path_buf`. Normalize the same way so
    // the traversal check below compares like-for-like (see clean_path_buf).
    let canonical = crate::commands::clean_path_buf(canonical);

    // Ensure the resolved path stays inside the project root (path traversal guard).
    if !canonical.starts_with(&root) {
        return local_file_error(
            StatusCode::FORBIDDEN,
            "⛔",
            "Outside the project",
            "This file is outside the open project folder, so the preview won't serve it.",
            Some("Open the folder that contains this file as your project, then try again."),
        );
    }

    // Read the file.
    let content = match std::fs::read(&canonical) {
        Ok(c) => c,
        Err(e) => {
            return local_file_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "⚠️",
                "Couldn't read file",
                "Spacron couldn't read this file from disk.",
                Some(&e.to_string()),
            )
        }
    };

    // Enforce a 50 MB size limit to prevent memory exhaustion.
    if content.len() > 50 * 1024 * 1024 {
        return local_file_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "📦",
            "File too large",
            "This file is over the 50 MB preview limit.",
            None,
        );
    }

    let mime = guess_local_file_mime(&canonical);
    let is_html = mime.contains("text/html");

    if is_html {
        // Inject a <base> tag so relative URLs (CSS, JS, images) resolve through
        // this same /local-file route, preserving correct directory context.
        let html = String::from_utf8_lossy(&content);
        let dir = canonical
            .parent()
            .unwrap_or(&root)
            .to_string_lossy()
            .to_string();

        // Compute the base href from the request's Host header (the proxy origin).
        let proxy_host = req
            .headers()
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("127.0.0.1");
        let base_href = format!(
            "http://{}/local-file/{}/",
            proxy_host,
            encode_dir_for_base_href(&dir)
        );

        let base_tag = format!("<base href=\"{}\">", html_escape_attr(&base_href));
        // A <base> tag only applies to elements the parser encounters AFTER it,
        // so it must be the FIRST thing in <head> — injecting it before </head>
        // (after the document's <link rel="stylesheet"> tags) left every
        // relative stylesheet/script href resolving against the document URL
        // (/local-file?path=…) instead of the base. Those requests fell through
        // to the dev-server proxy and failed, so the page rendered as bare
        // unstyled HTML. Insert right after the <head> opening tag; fall back
        // to right after <html>, then to prepending for head-less fragments.
        let insert_at = find_opening_tag_end(&html, "head")
            .or_else(|| find_opening_tag_end(&html, "html"));
        let injected = match insert_at {
            Some(index) => {
                let mut output = String::with_capacity(html.len() + base_tag.len() + 16);
                output.push_str(&html[..index]);
                output.push_str("\n");
                output.push_str(&base_tag);
                output.push_str("\n");
                output.push_str(&html[index..]);
                output
            }
            None => format!("{}\n{}", base_tag, html),
        };

        return Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Cache-Control", "no-cache")
            .body(Body::from(injected))
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response").into_response()
            });
    }

    Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", "no-cache")
        .body(Body::from(content))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response").into_response()
        })
}

/// Serve a local file using the URL path component instead of a query parameter.
/// Used by the `<base>` tag injected into HTML previews so that relative URLs
/// (CSS, JS, images) resolve correctly through this route.
async fn serve_local_file_path(
    State(state): State<ProxyState>,
    Path(file_path): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response<Body> {
    // The Axum wildcard parameter includes a leading `/`, strip it.
    let decoded = match percent_encoding::percent_decode_str(&file_path).decode_utf8() {
        Ok(d) => d.into_owned(),
        Err(_) => {
            return local_file_error_for(
                &headers,
                StatusCode::BAD_REQUEST,
                "⚠️",
                "Invalid path",
                "The requested file path couldn't be decoded.",
                None,
            )
        }
    };

    if decoded.is_empty() {
        return local_file_error_for(
            &headers,
            StatusCode::BAD_REQUEST,
            "⚠️",
            "Empty path",
            "No file path was provided.",
            None,
        );
    }

    let project_root = state
        .project_root
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(root) = project_root else {
        return local_file_error_for(
            &headers,
            StatusCode::BAD_REQUEST,
            "📂",
            "No project open",
            "Open a project folder in Spacron first, then preview a file inside it.",
            Some("The preview can only serve files that live inside the currently open project."),
        );
    };

    let path = std::path::PathBuf::from(&decoded);
    let canonical = if path.exists() {
        std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone())
    } else {
        return local_file_error_for(
            &headers,
            StatusCode::NOT_FOUND,
            "🔍",
            "File not found",
            "This file no longer exists on disk.",
            Some("It may have been moved, renamed, or deleted since the preview was opened."),
        );
    };
    // Match the normalization applied to the stored project root (clean_path_buf)
    // so the Windows `\\?\` verbatim prefix doesn't break the traversal check.
    let canonical = crate::commands::clean_path_buf(canonical);

    if !canonical.starts_with(&root) {
        return local_file_error_for(
            &headers,
            StatusCode::FORBIDDEN,
            "⛔",
            "Outside the project",
            "This file is outside the open project folder, so the preview won't serve it.",
            Some("Open the folder that contains this file as your project, then try again."),
        );
    }

    let content = match std::fs::read(&canonical) {
        Ok(c) => c,
        Err(e) => {
            return local_file_error_for(
                &headers,
                StatusCode::INTERNAL_SERVER_ERROR,
                "⚠️",
                "Couldn't read file",
                "Spacron couldn't read this file from disk.",
                Some(&e.to_string()),
            )
        }
    };

    if content.len() > 50 * 1024 * 1024 {
        return local_file_error_for(
            &headers,
            StatusCode::PAYLOAD_TOO_LARGE,
            "📦",
            "File too large",
            "This file is over the 50 MB preview limit.",
            None,
        );
    }

    let mime = guess_local_file_mime(&canonical);

    Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", "no-cache")
        .body(Body::from(content))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response").into_response()
        })
}

/// Render a friendly, self-contained HTML page for a failed local-file preview
/// navigation, so the preview panel shows a styled message instead of raw
/// status text. The page is theme-aware (adapts to the webview's light/dark
/// preference) and has no external dependencies.
fn local_file_error(
    status: StatusCode,
    glyph: &str,
    title: &str,
    message: &str,
    hint: Option<&str>,
) -> Response<Body> {
    let hint_html = match hint {
        Some(h) if !h.is_empty() => {
            format!("<p class=\"hint\">{}</p>", html_escape_attr(h))
        }
        _ => String::new(),
    };
    let body = format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; margin: 0; }}
  body {{
    display: flex; align-items: center; justify-content: center;
    min-height: 100%; padding: 24px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0f1115; color: #e6e8ee;
  }}
  .card {{
    width: 100%; max-width: 440px; text-align: center; padding: 40px 32px;
    background: #171a21; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px;
  }}
  .glyph {{ font-size: 44px; line-height: 1; margin-bottom: 16px; }}
  h1 {{ font-size: 18px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.01em; }}
  .msg {{ font-size: 14px; line-height: 1.55; margin: 0; opacity: 0.85; }}
  .hint {{ font-size: 13px; line-height: 1.5; margin: 14px 0 0; color: #9aa1ad; }}
  .status {{
    display: inline-block; margin-top: 20px; padding: 3px 10px;
    font: 500 11px/1 ui-monospace, "JetBrains Mono", Menlo, monospace;
    letter-spacing: 0.04em; text-transform: uppercase;
    border-radius: 999px; background: rgba(255,255,255,0.06); color: #9aa1ad;
  }}
  @media (prefers-color-scheme: light) {{
    body {{ background: #f6f7f9; color: #1c2027; }}
    .card {{ background: #fff; border-color: rgba(0,0,0,0.08); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }}
    .hint {{ color: #5b616e; }}
    .status {{ background: rgba(0,0,0,0.05); color: #6b7280; }}
  }}
</style>
</head>
<body>
  <div class="card">
    <div class="glyph">{glyph}</div>
    <h1>{title}</h1>
    <p class="msg">{message}</p>
    {hint_html}
    <div class="status">{code} {reason}</div>
  </div>
</body>
</html>"##,
        title = html_escape_attr(title),
        glyph = glyph,
        message = html_escape_attr(message),
        hint_html = hint_html,
        code = status.as_u16(),
        reason = status.canonical_reason().unwrap_or(""),
    );

    Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .body(Body::from(body))
        .unwrap_or_else(|_| (status, message.to_string()).into_response())
}

/// Byte offset just past the `>` of the first `<tag …>` opening tag, matched
/// ASCII case-insensitively. Longer tag names sharing the prefix don't match
/// (`<header>` is not `<head>`), and closing tags (`</head>`) are skipped
/// because their name starts with `/`. Used to place the injected `<base>` at
/// the *top* of `<head>`, where it precedes every URL-bearing element.
fn find_opening_tag_end(html: &str, tag: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    let tag_bytes = tag.as_bytes();
    let mut i = 0;
    while i + 1 + tag_bytes.len() <= bytes.len() {
        if bytes[i] == b'<'
            && bytes[i + 1..].len() >= tag_bytes.len()
            && bytes[i + 1..i + 1 + tag_bytes.len()].eq_ignore_ascii_case(tag_bytes)
        {
            let after_name = i + 1 + tag_bytes.len();
            match bytes.get(after_name) {
                // `<head>` — done.
                Some(b'>') => return Some(after_name + 1),
                // `<head lang=…>` / `<head/>` — skip to the closing `>`.
                Some(c) if c.is_ascii_whitespace() || *c == b'/' => {
                    return html[after_name..].find('>').map(|j| after_name + j + 1);
                }
                // `<header…` or EOF — not our tag; keep scanning.
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// Decide whether a request expects an HTML error page. Sub-resource fetches
/// (CSS/JS/images) must keep their real status + plain body — an HTML page
/// mislabeled as CSS would just be noise — but top-level navigations should get
/// the styled page. Chromium webviews send `Sec-Fetch-Dest: document`; the
/// `Accept: text/html` check is a fallback for WebKit-based webviews.
fn wants_html_error(headers: &axum::http::HeaderMap) -> bool {
    let dest_is_document = headers
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .map(|d| d.eq_ignore_ascii_case("document"))
        .unwrap_or(false);
    if dest_is_document {
        return true;
    }
    headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .map(|a| a.contains("text/html"))
        .unwrap_or(false)
}

/// Like [`local_file_error`] but falls back to a plain status + text body for
/// non-document (sub-resource) requests.
fn local_file_error_for(
    headers: &axum::http::HeaderMap,
    status: StatusCode,
    glyph: &str,
    title: &str,
    message: &str,
    hint: Option<&str>,
) -> Response<Body> {
    if wants_html_error(headers) {
        local_file_error(status, glyph, title, message, hint)
    } else {
        (status, message.to_string()).into_response()
    }
}

/// Percent-encode an absolute directory path for use as the `<base href>` URL
/// in local-file previews.
///
/// Normalizes Windows `\` separators to `/` and encodes only the characters
/// that are unsafe in a URL path, while **preserving `/` as a real separator**
/// and `:` for the Windows drive letter. This matters for two reasons:
///
/// 1. Spaces become `%20` (not `+` as `form_urlencoded` would produce), so a
///    path like `.../Real Projects/...` round-trips through
///    `percent_decode_str` on the way back instead of staying a literal `+`.
/// 2. Keeping `/` as a separator means the directory is many URL segments, so
///    `../` references in the page (e.g. `../static/icon.png`) resolve to the
///    correct sibling directory instead of collapsing the whole path.
fn encode_dir_for_base_href(dir: &str) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    // Control chars plus the characters that would break URL-path parsing.
    // `/` and `:` are deliberately left un-encoded (see doc comment).
    const SET: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'`')
        .add(b'{')
        .add(b'}')
        .add(b'|')
        .add(b'^')
        .add(b'\\');
    let normalized = dir.replace('\\', "/");
    utf8_percent_encode(&normalized, SET).to_string()
}

/// Guess MIME type from file extension (no external crate needed).
fn guess_local_file_mime(path: &std::path::Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8".to_string(),
        "css" => "text/css; charset=utf-8".to_string(),
        "js" | "mjs" | "jsx" => "application/javascript; charset=utf-8".to_string(),
        "ts" | "tsx" => "application/javascript; charset=utf-8".to_string(),
        "json" => "application/json; charset=utf-8".to_string(),
        "xml" => "application/xml; charset=utf-8".to_string(),
        "svg" => "image/svg+xml".to_string(),
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" | "jpe" | "jfif" => "image/jpeg".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        "bmp" => "image/bmp".to_string(),
        "ico" | "cur" => "image/x-icon".to_string(),
        "avif" => "image/avif".to_string(),
        "tif" | "tiff" => "image/tiff".to_string(),
        "woff" => "font/woff".to_string(),
        "woff2" => "font/woff2".to_string(),
        "ttf" => "font/ttf".to_string(),
        "otf" => "font/otf".to_string(),
        "eot" => "application/vnd.ms-fontobject".to_string(),
        "mp3" => "audio/mpeg".to_string(),
        "mp4" => "video/mp4".to_string(),
        "webm" => "video/webm".to_string(),
        "ogg" => "audio/ogg".to_string(),
        "wasm" => "application/wasm".to_string(),
        "txt" | "md" | "markdown" => "text/plain; charset=utf-8".to_string(),
        "map" => "application/json; charset=utf-8".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

async fn proxy_handler(State(state): State<ProxyState>, req: Request<Body>) -> Response<Body> {
    let (mut parts, body) = req.into_parts();

    // Reject requests carrying a cross-origin `Origin` header before doing any
    // work — stops a page in the user's normal browser from driving the loopback
    // proxy (CSRF) or using it as an SSRF forwarder.
    if !proxy_request_allowed(&parts.headers) {
        return (
            StatusCode::FORBIDDEN,
            "Cross-origin requests to the preview proxy are not allowed",
        )
            .into_response();
    }

    let target_port = *state.target_port.lock().unwrap_or_else(|e| e.into_inner());
    let preferred_local_host = state
        .preferred_local_host
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let path = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();

    // If request contains upgrade websocket headers, handle as websocket connection
    let is_ws = parts
        .headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_lowercase())
        == Some("websocket".to_string());

    if is_ws {
        // Validate WebSocket origin. Browsers always attach an Origin to a WS
        // handshake, so we require one and demand it be first-party loopback. We
        // deliberately do NOT accept `Origin: null` — it's never something we emit,
        // and accepting it would let a sandboxed/`data:` document open a socket
        // through the proxy.
        let ws_origin_valid = parts
            .headers
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .map(|o| {
                o == "http://127.0.0.1"
                    || o.starts_with("http://127.0.0.1:")
                    || o == "http://localhost"
                    || o.starts_with("http://localhost:")
            })
            .unwrap_or(false);
        if !ws_origin_valid {
            return StatusCode::FORBIDDEN.into_response();
        }

        // External WebSocket bridge (`/proxy-ws/{ws|wss}/{host}/path`) —
        // injected pages rewrite their socket URLs onto this route (see
        // BRIDGE_SNIPPET) because the page itself lives on the loopback proxy
        // origin and could otherwise only reach the local dev forwarder.
        if parts.uri.path().starts_with("/proxy-ws/") {
            let Some(target_ws) =
                get_ws_target_from_proxy_path(parts.uri.path(), parts.uri.query())
            else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            // Same SSRF gates as the HTTP `/proxy` route, run on the http(s)
            // equivalent of the ws URL.
            let http_equiv = target_ws
                .replacen("ws://", "http://", 1)
                .replacen("wss://", "https://", 1);
            if is_private_target(&http_equiv) && !is_loopback_host_target(&http_equiv) {
                return StatusCode::FORBIDDEN.into_response();
            }
            if let Ok(parsed) = url::Url::parse(&http_equiv) {
                if let Some(port) = parsed.port() {
                    if is_restricted_port(port) {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                }
                if let Some(host) = parsed.host_str() {
                    if host.parse::<std::net::IpAddr>().is_err()
                        && !is_loopback_host_target(&http_equiv)
                    {
                        let port = parsed.port_or_known_default().unwrap_or(80);
                        if has_blocked_resolved_ip(host, port).await {
                            return StatusCode::FORBIDDEN.into_response();
                        }
                    }
                }
            }
            // The real site's cookies + a matching Origin, so authed sockets
            // (the normal case for logged-in web apps) complete their handshake.
            let target_url = url::Url::parse(&http_equiv).ok();
            let cookie_header =
                target_url.as_ref().and_then(|u| state.cookie_jar().cookie_header_for(u));
            let ws_origin = target_url
                .as_ref()
                .and_then(|u| u.host_str().map(|h| format!("{}://{}", u.scheme(), h)));
            match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
                Ok(ws) => {
                    return ws
                        .on_upgrade(move |socket| {
                            handle_external_websocket(socket, target_ws, cookie_header, ws_origin)
                        })
                        .into_response();
                }
                Err(_) => return StatusCode::BAD_REQUEST.into_response(),
            }
        }

        if path.starts_with("/proxy") {
            return StatusCode::BAD_REQUEST.into_response();
        }
        match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => {
                let ws_path = path.clone();
                let preferred_host = preferred_local_host.clone();
                return ws
                    .on_upgrade(move |socket| {
                        handle_websocket(socket, target_port, ws_path, preferred_host)
                    })
                    .into_response();
            }
            Err(_) => {
                return StatusCode::BAD_REQUEST.into_response();
            }
        }
    }

    // External URL proxy
    if path.starts_with("/proxy") {
        let query = parts.uri.query().unwrap_or("");
        let target_url = get_target_url_from_proxy_path(parts.uri.path(), parts.uri.query())
            .or_else(|| get_target_url(query));
        match target_url {
            Some(url) if !url.is_empty() => {
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    return (StatusCode::BAD_REQUEST, "Only HTTP(S) URLs are allowed")
                        .into_response();
                }
                // Loopback is the user's own machine (the local-dev redirect
                // rewriter routes app-to-app redirects here), so allow it; only
                // block genuinely private LAN/metadata ranges as SSRF targets.
                if is_private_target(&url) && !is_loopback_host_target(&url) {
                    return (
                        StatusCode::FORBIDDEN,
                        format!(
                            "Access to private/internal resources is not allowed (blocked target: {})",
                            url
                        ),
                    )
                        .into_response();
                }
                if let Ok(parsed) = url::Url::parse(&url) {
                    if let Some(port) = parsed.port() {
                        if is_restricted_port(port) {
                            return (
                                StatusCode::FORBIDDEN,
                                "Access to restricted ports is not allowed",
                            )
                                .into_response();
                        }
                    }
                }

                // Record the fallback origin only for *document* navigations
                // (wants_html_error = "this request is for a page"). The slot
                // resolves root-relative subresource/API requests that arrive
                // on the proxy root, so it must track the page the user is ON —
                // recording every explicit `/proxy/...` fetch let any CDN/API
                // subresource steal the slot and break the page's own
                // root-relative loads.
                if wants_html_error(&parts.headers) {
                    let mut origin_to_store = None;
                    if let Ok(target) = url.parse::<url::Url>() {
                        let scheme = target.scheme();
                        let host = target.host_str().unwrap_or("");
                        let origin = match target.port() {
                            Some(port) => format!("{}://{}:{}", scheme, host, port),
                            None => format!("{}://{}", scheme, host),
                        };
                        origin_to_store = Some(origin);
                    }

                    let active_project = state
                        .active_project_id
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    if let Some(ref project_id) = active_project {
                        let mut origins = state
                            .active_external_origins
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        origins.insert(project_id.clone(), origin_to_store.clone());
                    }
                }

                return proxy_external_url(
                    state.client(),
                    &url,
                    state.active_external_origins.clone(),
                    state.active_project_id.clone(),
                    parts,
                    body,
                )
                .await;
            }
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "Missing target URL. Use /proxy/{scheme}/{host}/path or provide a 'url' query parameter",
                )
                    .into_response();
            }
        }
    }

    // Check if we have active external origin
    let active_project = state
        .active_project_id
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let opt_origin = if state.external_origin_fallback {
        if let Some(ref project_id) = active_project {
            let origins = state
                .active_external_origins
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            origins.get(project_id).cloned().flatten()
        } else {
            None
        }
    } else {
        None
    };

    if let Some(origin) = opt_origin {
        let full_url = format!("{}{}", origin, path);
        return proxy_external_url(
            state.client(),
            &full_url,
            state.active_external_origins.clone(),
            state.active_project_id.clone(),
            parts,
            body,
        )
        .await;
    }

    // The Host the browser used to reach this proxy (127.0.0.1:{proxy_port}).
    // Captured before `parts` is moved into proxy_local_dev_request so a
    // same-dev-server redirect can be collapsed back onto *this* proxy origin.
    let proxy_origin = {
        let host = parts
            .headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("127.0.0.1");
        format!("http://{}", host)
    };

    // Retrieve request body
    let bytes = match axum::body::to_bytes(body, 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };

    match proxy_local_dev_request(
        &state.local_client,
        parts,
        bytes,
        target_port,
        preferred_local_host.as_deref(),
    )
    .await
    {
        Ok(res) => {
            build_preview_response(
                res,
                false,
                Some(RedirectRewrite::LocalDev {
                    proxy_origin,
                    dev_port: target_port,
                }),
            )
            .await
        }
        Err(message) => {
            (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", message)).into_response()
        }
    }
}

async fn proxy_local_dev_request(
    client: &Client,
    parts: axum::http::request::Parts,
    body: axum::body::Bytes,
    target_port: u16,
    preferred_host: Option<&str>,
) -> Result<reqwest::Response, String> {
    let path = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/")
        .to_string();

    // One entry per attempted host so the surfaced error names *every* failure,
    // not just the last one. Without this, a `localhost`-first failover reports
    // only the trailing `127.0.0.1` attempt and hides that `localhost` failed too.
    let mut errors: Vec<String> = Vec::new();

    for host in local_dev_hosts(preferred_host) {
        let url_str = format!("http://{}:{}{}", host, target_port, path);
        let url = match url_str.parse::<reqwest::Url>() {
            Ok(u) => u,
            Err(_) => continue,
        };

        let method = parts.method.clone();
        let mut reqwest_req = reqwest::Request::new(method, url.clone());
        *reqwest_req.headers_mut() = parts.headers.clone();

        // Override the client's 30s default for local dev: a cold first compile
        // (Next.js compiles middleware + the matched route on the first hit) can
        // legitimately take minutes, and the default budget surfaces it as a
        // misleading "operation timed out". The 10s connect_timeout still fails
        // fast against a dead port, so a generous read budget is safe here.
        *reqwest_req.timeout_mut() = Some(Duration::from_secs(300));

        // Make the forwarded request look first-party to the dev server. The
        // browser issues subresource requests (/_next/* chunks, CSS, modules)
        // against the proxy origin (127.0.0.1:{proxy_port}); dev servers like
        // Next.js 15 (allowedDevOrigins) block those as cross-origin, which makes
        // the page render unstyled. We advertise `localhost` (not the loopback IP
        // we actually connect to) because that is the host these dev servers trust
        // by default — Next.js, for example, allows `localhost` out of the box but
        // blocks `127.0.0.1`. The check only inspects the Origin/Referer host, not
        // the TCP target, so this is safe regardless of which host we connect to.
        // Origin is set unconditionally because many chunk/module requests omit it.
        let advertised_origin = format!("http://localhost:{}", target_port);
        reqwest_req.headers_mut().remove("accept-encoding");
        if let Ok(val) = advertised_origin.parse() {
            reqwest_req.headers_mut().insert("origin", val);
        }
        let proxy_host = parts
            .headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("127.0.0.1");
        let proxy_origin = format!("http://{}", proxy_host);
        let new_referer = match reqwest_req
            .headers()
            .get("referer")
            .and_then(|r| r.to_str().ok())
        {
            // Preserve the path the browser was actually on, just swap the host.
            Some(referer_str) => referer_str.replace(&proxy_origin, &advertised_origin),
            // Subresource request with no referer — point it at the dev root.
            None => format!("{}/", advertised_origin),
        };
        if let Ok(val) = new_referer.parse() {
            reqwest_req.headers_mut().insert("referer", val);
        }

        // Advertise the proxy's own origin as the Host to the dev server. Auth
        // frameworks (Clerk et al.) derive their redirect URLs from the request
        // Host, so this makes every redirect they emit come back to the proxy
        // origin instead of the raw http://localhost:{devport} — which would
        // escape the proxy and get blocked by the dev server's frame-ancestors
        // CSP. The Origin header stays advertised as localhost:{devport} above, so
        // Next.js `allowedDevOrigins` still trusts the page's subresource fetches.
        reqwest_req.headers_mut().remove("host");
        if let Ok(val) = proxy_host.parse() {
            reqwest_req.headers_mut().insert("host", val);
        }
        *reqwest_req.body_mut() = Some(reqwest::Body::from(body.clone()));

        match client.execute(reqwest_req).await {
            Ok(response) => return Ok(response),
            Err(err) => errors.push(describe_request_error(&err)),
        }
    }

    Err(if errors.is_empty() {
        "no local dev host could be attempted".to_string()
    } else {
        errors.join("; ")
    })
}

async fn proxy_external_url(
    client: Client,
    target_url: &str,
    active_external_origins: Arc<Mutex<std::collections::HashMap<String, Option<String>>>>,
    active_project_id: Arc<std::sync::RwLock<Option<String>>>,
    parts: axum::http::request::Parts,
    body: axum::body::Body,
) -> Response<Body> {
    let target = match target_url.parse::<url::Url>() {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid target URL").into_response(),
    };

    // Loopback (the user's own machine) is allowed — the local-dev redirect
    // rewriter deliberately routes app-to-app redirects through here. Only
    // genuinely private LAN/metadata ranges are blocked as SSRF targets.
    if is_private_target(target_url) && !is_loopback_host_target(target_url) {
        return (
            StatusCode::FORBIDDEN,
            format!(
                "Access to private/internal resources is not allowed (blocked target: {})",
                target_url
            ),
        )
            .into_response();
    }
    // DNS rebinding protection: resolve hostname and check resolved IPs. Skipped
    // for loopback hosts (e.g. `localhost`), which resolve to 127.0.0.1 by design
    // and are intentionally reachable per the check above.
    if let Some(host) = target.host_str() {
        if host.parse::<std::net::IpAddr>().is_err() && !is_loopback_host_target(target_url) {
            // Only do DNS check for domain names — IPs were already checked above
            let port = target.port_or_known_default().unwrap_or(80);
            if has_blocked_resolved_ip(host, port).await {
                return (
                    StatusCode::FORBIDDEN,
                    format!(
                        "Access to private/internal resources is not allowed ({} resolves to a private address)",
                        host
                    ),
                )
                    .into_response();
            }
        }
    }
    if let Some(port) = target.port() {
        if is_restricted_port(port) {
            return (
                StatusCode::FORBIDDEN,
                "Access to restricted ports is not allowed",
            )
                .into_response();
        }
    }

    // The Host the browser used to reach this proxy, kept so redirect Locations
    // from the external origin can be rewritten back onto this proxy origin.
    let proxy_origin = {
        let host = parts
            .headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("127.0.0.1");
        format!("http://{}", host)
    };

    // Whether this request is a page navigation (vs a subresource/API fetch) —
    // decided from the incoming headers BEFORE they're rewritten for upstream.
    let is_document = wants_html_error(&parts.headers);

    let method = parts.method.clone();
    let mut reqwest_req = reqwest::Request::new(method, target.clone());

    {
        let headers = reqwest_req.headers_mut();
        // Start with the incoming headers but strip proxy-revealing ones
        *headers = parts.headers.clone();
        headers.remove("host");
        headers.remove("origin");
        headers.remove("referer");
        // Fetch-metadata headers describe the *embedding* context (dest=iframe,
        // site=cross-site) — exactly what we're stripping X-Frame-Options to
        // hide. Sites that enforce them (Google login, some Cloudflare setups)
        // refuse the request outright, so drop them like the other
        // proxy-revealing headers; a plain top-level navigation omits nothing.
        headers.remove("sec-fetch-dest");
        headers.remove("sec-fetch-mode");
        headers.remove("sec-fetch-site");
        headers.remove("sec-fetch-user");
        headers.remove("sec-fetch-storage-access");
        // The browser's cookies are scoped to the loopback proxy origin, not the
        // real target — forwarding them both leaks unrelated proxied sites'
        // cookies upstream and, worse, disables the client's cookie jar (reqwest
        // only injects jar cookies when the request has no Cookie header). The
        // jar owns cookies for external targets; see preview_http_client().
        headers.remove("cookie");
        // Negotiate only encodings this client can decode. Forwarding the
        // browser's list (which includes zstd) lets the origin pick an encoding
        // reqwest passes through raw — and since Content-Encoding is stripped
        // from the re-served response, the WebView would receive undecodable
        // bytes. Pinning to gzip/br guarantees the proxy always re-serves
        // plaintext bodies.
        headers.insert(
            reqwest::header::ACCEPT_ENCODING,
            "gzip, br".parse().unwrap(),
        );
        headers.remove("x-forwarded-for");
        headers.remove("x-forwarded-host");
        headers.remove("x-forwarded-proto");
        headers.remove("via");
        headers.remove("forwarded");

        // Set Accept headers if not already present
        if !headers.contains_key("accept") {
            headers.insert(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
                    .parse().unwrap(),
            );
        }
        if !headers.contains_key("accept-language") {
            headers.insert(
                reqwest::header::ACCEPT_LANGUAGE,
                "en-US,en;q=0.9".parse().unwrap(),
            );
        }
    }

    let bytes = match axum::body::to_bytes(body, 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    *reqwest_req.body_mut() = Some(reqwest::Body::from(bytes));

    // Kept for a one-shot replay after the consent interstitial is resolved
    // server-side (body is Bytes, so the clone always succeeds).
    let retry_req = reqwest_req.try_clone();

    match client.execute(reqwest_req).await {
        Ok(res) => {
            // Never surface Google's consent interstitial in the preview/panel —
            // it cannot be completed from inside the iframe. Resolve it in the
            // proxy and carry on with the original request; see
            // maybe_resolve_youtube_consent.
            let res = maybe_resolve_youtube_consent(&client, res, retry_req).await;
            // Record the origin this response actually came from (the client does
            // not follow redirects, so this is the requested target's origin).
            let final_url = res.url();
            let scheme = final_url.scheme();
            let host = final_url.host_str().unwrap_or("");
            let origin = match final_url.port() {
                Some(port) => format!("{}://{}:{}", scheme, host, port),
                None => format!("{}://{}", scheme, host),
            };

            // Fallback-slot recording is document-only, same as the request-side
            // recording in proxy_handler (subresources must not steal the slot).
            if is_document {
                let active_project = active_project_id
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Some(project_id) = active_project {
                    let mut origins = active_external_origins
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    origins.insert(project_id, Some(origin));
                }
            }

            build_preview_response(
                res,
                true,
                Some(RedirectRewrite::External {
                    proxy_origin,
                    target: target.clone(),
                }),
            )
            .await
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            format!("Proxy error: {}", describe_request_error(&err)),
        )
            .into_response(),
    }
}

/// Hidden-input fields of Google's consent interstitial ("Before you
/// continue"), extracted so the proxy can replay the form server-side. Each
/// field is taken once (the page repeats them across its Accept/Reject forms)
/// and the per-form choice flags (`set_*`) are skipped — the caller appends
/// the choice it wants itself.
fn consent_form_params(html: &str) -> Vec<(String, String)> {
    let re = regex::Regex::new(r#"name="([^"]+)"\s+value="([^"]*)""#).unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut params = Vec::new();
    for cap in re.captures_iter(html) {
        let name = cap[1].to_string();
        if name.starts_with("set_") || !seen.insert(name.clone()) {
            continue;
        }
        params.push((name, cap[2].replace("&amp;", "&")));
    }
    params
}

/// Google gates youtube.com properties behind a consent interstitial: the
/// first request 302s to consent.youtube.com, and the real page only loads
/// after the consent form is submitted. Inside the preview iframe that page is
/// a dead end — its buttons submit the form *programmatically*, which fires no
/// `submit` event, so the injected nav rewriter never re-points the POST at
/// the proxy and the iframe escapes to the raw consent origin, whose
/// frame-ancestors headers then block it. Clicking Accept/Reject appears to do
/// nothing.
///
/// So the banner is never shown: when a proxied response redirects to
/// consent.youtube.com, fetch the consent page with the same cookie jar,
/// replay its form with the privacy-preserving "Reject all" choice
/// (`set_eom=true` — no additional cookies or personalization), and retry the
/// original request, which now sails through. Any failure along the way falls
/// back to returning the original redirect (the banner, exactly as before).
async fn maybe_resolve_youtube_consent(
    client: &Client,
    res: reqwest::Response,
    retry: Option<reqwest::Request>,
) -> reqwest::Response {
    if !res.status().is_redirection() {
        return res;
    }
    let consent_url = match res
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|loc| url::Url::parse(loc).ok())
    {
        Some(u) if u.host_str() == Some("consent.youtube.com") => u,
        _ => return res,
    };
    let Some(retry) = retry else {
        return res;
    };

    // Carry the original request's browser identity: the consent frontend
    // serves a formless "browser deprecated" page to unknown user agents.
    let ua = retry.headers().get(reqwest::header::USER_AGENT).cloned();
    let lang = retry
        .headers()
        .get(reqwest::header::ACCEPT_LANGUAGE)
        .cloned();
    let with_identity = |mut req: reqwest::RequestBuilder| {
        if let Some(ua) = &ua {
            req = req.header(reqwest::header::USER_AGENT, ua);
        }
        if let Some(lang) = &lang {
            req = req.header(reqwest::header::ACCEPT_LANGUAGE, lang);
        }
        req
    };

    let page = match with_identity(client.get(consent_url)).send().await {
        Ok(page_res) => match page_res.text().await {
            Ok(text) => text,
            Err(_) => return res,
        },
        Err(_) => return res,
    };
    let mut params = consent_form_params(&page);
    // `escs` is the consent form's one-time token; without it this isn't the
    // form we know how to replay — don't blind-fire a save request.
    if !params.iter().any(|(name, _)| name == "escs") {
        return res;
    }
    params.push(("set_eom".to_string(), "true".to_string()));

    // Hand-rolled application/x-www-form-urlencoded body — reqwest's .form()
    // helper is behind a cargo feature this build doesn't enable.
    let form_body = params
        .iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC),
                percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC),
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    if with_identity(client.post("https://consent.youtube.com/save"))
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(form_body)
        .send()
        .await
        .is_err()
    {
        return res;
    }

    // The jar now holds the SOCS consent cookie, so the replay should get the
    // real page. If consent didn't stick, the replay is just the same consent
    // redirect and the previous behavior (banner in the panel) remains.
    match client.execute(retry).await {
        Ok(retried) => retried,
        Err(_) => res,
    }
}

/// Headers that must be dropped before re-serving a proxied page inside the
/// preview iframe. The body is always re-framed by the proxy (length/encoding
/// change), and the security/embedding headers are authored for the target's
/// real origin — re-applying them under the proxy origin (127.0.0.1:{proxy_port})
/// blocks the page from embedding or, more subtly, blocks it from loading its own
/// stylesheets and scripts (the page renders but appears unstyled).
fn should_strip_preview_header(key_lower: &str) -> bool {
    matches!(
        key_lower,
        // Body framing — the proxy re-emits the (decompressed) body itself.
        "content-length"
            | "content-encoding"
            | "transfer-encoding"
            // Embedding guards — would prevent the iframe from rendering at all.
            | "x-frame-options"
            // HSTS is scoped to the host that receives this proxied response. If
            // a dev server sends it, the WebView can cache HTTPS-only state for
            // Spacron's plain-HTTP loopback proxy (127.0.0.1), breaking later
            // preview loads even though the target app works in a normal browser.
            | "strict-transport-security"
            // CSP authored for the dev origin breaks asset loading under the proxy
            // origin (this is the usual cause of "Dev: On" stripping the CSS).
            | "content-security-policy"
            | "content-security-policy-report-only"
            // COEP/CORP can block cross-origin subresources (fonts, CDN CSS).
            | "cross-origin-embedder-policy"
            | "cross-origin-opener-policy"
            | "cross-origin-resource-policy"
    )
}

/// Context for rewriting a redirect `Location` so the browser follows it
/// *through the proxy* instead of escaping to the raw origin (where framing
/// guards would block the preview iframe). Neither proxy client follows
/// redirects itself — every 3xx is handed back to the WebView so Set-Cookie
/// headers on each hop land in the browser — so every `Location` must be kept
/// on the proxy origin.
enum RedirectRewrite {
    /// Redirect emitted by the local dev server.
    LocalDev {
        /// The proxy origin the browser is talking to, e.g. `http://127.0.0.1:54321`.
        proxy_origin: String,
        /// The dev server's own port, used to recognise self-redirects.
        dev_port: u16,
    },
    /// Redirect emitted by an external origin fetched via the `/proxy/...` path
    /// (a hosted auth provider, or general external browsing).
    External {
        /// The proxy origin the browser is talking to.
        proxy_origin: String,
        /// The external URL this response came from; relative `Location`s
        /// resolve against it.
        target: url::Url,
    },
}

/// Rewrite a redirect `Location` from the local dev server so the browser
/// follows it *through the proxy* instead of navigating straight to the raw dev
/// origin. Without this, a dev server that redirects on load (e.g. `/` → `/login`
/// with an absolute URL, an `http`→`https` bounce, or a hosted auth provider)
/// sends the iframe off the proxy to an origin whose `X-Frame-Options` /
/// `frame-ancestors` then reach the WebView — which blocks the frame with
/// "content is blocked". `localhost:{devport}` isn't in the app's `frame-src`
/// allowlist either, so even a same-host escape fails.
///
/// Returns `Some(new_location)` when the header should be replaced, `None` to
/// leave it as-is (relative Locations already resolve against the proxy origin,
/// and non-http(s) schemes like `mailto:` must not be touched).
fn rewrite_local_redirect_location(
    location: &str,
    dev_port: u16,
    proxy_origin: &str,
) -> Option<String> {
    let trimmed = location.trim();
    if trimmed.is_empty() {
        return None;
    }
    // A relative Location (no scheme/host) already resolves against the proxy
    // origin, so it's already safe — leave it untouched. `Url::parse` only
    // succeeds on absolute URLs here, so a parse failure means "relative".
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str().unwrap_or("");
    let is_dev_host = matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0");
    let default_port = if parsed.scheme() == "https" { 443 } else { 80 };
    let port = parsed.port().unwrap_or(default_port);

    let path_and_rest = |p: &str| {
        let mut out = p.to_string();
        if let Some(q) = parsed.query() {
            out.push('?');
            out.push_str(q);
        }
        if let Some(f) = parsed.fragment() {
            out.push('#');
            out.push_str(f);
        }
        out
    };

    // Same dev server (any loopback alias on the dev port, either scheme):
    // collapse to a proxy-relative path so the follow-up stays on the proxy
    // origin where embedding guards are stripped.
    if is_dev_host && port == dev_port {
        return Some(path_and_rest(parsed.path()));
    }

    // A redirect to a genuinely different origin (hosted auth provider, an
    // upgrade to a different host, …). Route it through the proxy's external
    // `/proxy/{scheme}/{host}{path}` form so its embedding-block headers get
    // stripped too, instead of letting the iframe escape to the raw origin. This
    // keeps the top-level auth page rendering and cookies flowing; deep
    // *same-host root-relative* subresources on that page are best-effort (the
    // usual limitation of a path-rewriting proxy), but that's strictly better
    // than a hard "content is blocked".
    let authority = match parsed.port() {
        Some(p) => format!("{}:{}", host, p),
        None => host.to_string(),
    };
    Some(format!(
        "{}/proxy/{}/{}{}",
        proxy_origin,
        parsed.scheme(),
        authority,
        path_and_rest(parsed.path())
    ))
}

/// Rewrite a redirect `Location` emitted by an *external* origin (fetched via
/// the `/proxy/...` path) so the browser keeps following it through the proxy.
/// The external client does not follow redirects — a hosted auth handshake's
/// Set-Cookie headers must land in the browser — so each hop's `Location` comes
/// back through here.
///
/// Unlike the local-dev variant, relative `Location`s can NOT be left alone: a
/// root-relative `/login` must resolve against the *external* origin
/// (`/proxy/{scheme}/{host}/login`), but served as-is it would resolve against
/// the proxy origin and lose the `/proxy/...` prefix. So every shape (absolute,
/// protocol-relative `//host/x`, root-relative, path-relative) is first resolved
/// against the target URL — exactly as a browser sitting on the real origin
/// would — and then mapped onto the proxy.
///
/// Returns `None` to leave the header untouched (non-http(s) schemes, or an
/// unparseable value).
fn rewrite_external_redirect_location(
    location: &str,
    target: &url::Url,
    proxy_origin: &str,
) -> Option<String> {
    let trimmed = location.trim();
    if trimmed.is_empty() {
        return None;
    }
    let resolved = url::Url::options()
        .base_url(Some(target))
        .parse(trimmed)
        .ok()?;
    if resolved.scheme() != "http" && resolved.scheme() != "https" {
        return None;
    }

    let mut suffix = resolved.path().to_string();
    if let Some(q) = resolved.query() {
        suffix.push('?');
        suffix.push_str(q);
    }
    if let Some(f) = resolved.fragment() {
        suffix.push('#');
        suffix.push_str(f);
    }

    // A redirect straight back to the proxy's own origin — an auth provider
    // returning to the redirect_url it was handed, which the Host rewrite in
    // proxy_local_dev_request made point at the proxy (e.g. Clerk's
    // `Location: http://127.0.0.1:{proxy_port}/?__clerk_handshake=…`). Collapse
    // it to a root-relative path: the browser lands back on the proxy root (the
    // local dev server) carrying the handshake query with it.
    if let Ok(proxy_url) = url::Url::parse(proxy_origin) {
        if is_loopback_host_target(resolved.as_str())
            && resolved.port_or_known_default() == proxy_url.port_or_known_default()
        {
            return Some(suffix);
        }
    }

    let host = resolved.host_str().unwrap_or("");
    let authority = match resolved.port() {
        Some(p) => format!("{}:{}", host, p),
        None => host.to_string(),
    };
    Some(format!(
        "{}/proxy/{}/{}{}",
        proxy_origin,
        resolved.scheme(),
        authority,
        suffix
    ))
}

async fn build_preview_response(
    res: reqwest::Response,
    strip_embed_headers: bool,
    redirect_rewrite: Option<RedirectRewrite>,
) -> Response<Body> {
    let is_html = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/html") || value.contains("application/xhtml+xml"))
        .unwrap_or(false);

    let status = res.status();
    let headers = res.headers().clone();
    // The URL this response was fetched from (neither client follows redirects,
    // so it matches the requested target). For external pages this is the URL
    // the address bar should show; we hand it to the page via a meta tag so the
    // injected reporter can post it back to the app shell.
    let final_url = res.url().to_string();

    // For a redirect, compute the rewritten Location up front so both
    // header-copy paths (HTML and streamed) apply it identically.
    let rewritten_location = redirect_rewrite.as_ref().and_then(|ctx| {
        if !status.is_redirection() {
            return None;
        }
        let loc = headers.get(reqwest::header::LOCATION)?.to_str().ok()?;
        match ctx {
            RedirectRewrite::LocalDev {
                proxy_origin,
                dev_port,
            } => rewrite_local_redirect_location(loc, *dev_port, proxy_origin),
            RedirectRewrite::External {
                proxy_origin,
                target,
            } => rewrite_external_redirect_location(loc, target, proxy_origin),
        }
    });

    if is_html {
        let body_bytes = match res.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => {
                return (StatusCode::BAD_GATEWAY, format!("Proxy error: {}", err)).into_response()
            }
        };
        let html = String::from_utf8_lossy(&body_bytes);
        // Only inject inspector into local dev server responses, never external sites.
        let injected = if !strip_embed_headers {
            inject_inspector_script(html.as_ref())
        } else {
            html.into_owned()
        };
        // The scroll-position bridge is harmless and useful everywhere, so inject
        // it into both local dev and external pages.
        let injected = inject_scroll_script(&injected);
        // The navigation rewriter keeps in-page links/forms on the proxy origin so
        // clicked results (e.g. DuckDuckGo) actually load instead of escaping the
        // proxy and being blocked by the destination's X-Frame-Options, and it
        // reports the page's real URL back to the address bar. Only external pages
        // need it; local dev navigation is already same-origin. The location meta
        // carries the post-redirect URL so the address bar reflects the final site.
        let injected = if strip_embed_headers {
            let injected = inject_location_meta(&injected, &final_url);
            inject_nav_rewrite_script(&injected)
        } else {
            injected
        };
        // Universal request bridge for every external page: pins root-relative
        // fetch/XHR/WS calls onto the explicit /proxy form and makes
        // cross-origin API calls same-origin. Head-top so it wraps fetch/XHR
        // before the page's own scripts capture them; see BRIDGE_SNIPPET.
        let injected = if strip_embed_headers {
            inject_bridge_snippet(&injected)
        } else {
            injected
        };
        // YouTube Music embed: strip the site chrome (cosmetics only — its
        // request bridging is covered by the universal bridge above).
        let injected = if strip_embed_headers && is_ytm_host(&final_url) {
            inject_ytm_snippet(&injected)
        } else {
            injected
        };

        let mut builder = Response::builder().status(status);
        for (key, value) in headers.iter() {
            let key_lower = key.as_str().to_lowercase();
            // HTML is buffered and rewritten, so range/validator headers no longer apply.
            if matches!(key_lower.as_str(), "etag" | "content-md5" | "accept-ranges") {
                continue;
            }
            if should_strip_preview_header(&key_lower) {
                continue;
            }
            if key_lower == "location" {
                if let Some(ref loc) = rewritten_location {
                    builder = builder.header(key, loc.as_str());
                    continue;
                }
            }
            builder = builder.header(key, value);
        }

        return builder.body(Body::from(injected)).unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build response body",
            )
                .into_response()
        });
    }

    let mut builder = Response::builder().status(status);
    for (key, value) in headers.iter() {
        let key_lower = key.as_str().to_lowercase();
        if should_strip_preview_header(&key_lower) {
            continue;
        }
        if key_lower == "location" {
            if let Some(ref loc) = rewritten_location {
                builder = builder.header(key, loc.as_str());
                continue;
            }
        }
        builder = builder.header(key, value);
    }

    let body_stream = res.bytes_stream();
    let body = Body::from_stream(body_stream);
    builder.body(body).unwrap_or_else(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to build response body",
        )
            .into_response()
    })
}

fn inject_inspector_script(html: &str) -> String {
    let marker = INSPECTOR_SNIPPET;
    if html.contains(INSPECTOR_FLAG) || html.contains(marker) {
        return html.to_string();
    }

    let injection = format!("{}\n<!-- forge-inspector -->", marker);

    if let Some(index) = html.rfind("</head>") {
        let mut output = String::with_capacity(html.len() + injection.len() + 16);
        output.push_str(&html[..index]);
        output.push_str(&injection);
        output.push_str(&html[index..]);
        return output;
    }

    if let Some(index) = html.rfind("</body>") {
        let mut output = String::with_capacity(html.len() + injection.len() + 16);
        output.push_str(&html[..index]);
        output.push_str(&injection);
        output.push_str(&html[index..]);
        return output;
    }

    format!("{}{}", injection, html)
}

fn html_escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Embed the page's real (post-redirect) URL as a meta tag so the injected
/// reporter can hand it to the app shell's address bar. Inserting before
/// `</head>` keeps it in the head where it parses before any body script runs.
fn inject_location_meta(html: &str, final_url: &str) -> String {
    if html.contains("name=\"spacron-location\"") {
        return html.to_string();
    }
    let meta = format!(
        "<meta name=\"spacron-location\" content=\"{}\">",
        html_escape_attr(final_url)
    );

    if let Some(index) = html.rfind("</head>") {
        let mut output = String::with_capacity(html.len() + meta.len() + 8);
        output.push_str(&html[..index]);
        output.push_str(&meta);
        output.push_str(&html[index..]);
        return output;
    }

    if let Some(index) = html.find("</body>") {
        let mut output = String::with_capacity(html.len() + meta.len() + 8);
        output.push_str(&html[..index]);
        output.push_str(&meta);
        output.push_str(&html[index..]);
        return output;
    }

    format!("{}{}", meta, html)
}

fn inject_nav_rewrite_script(html: &str) -> String {
    if html.contains(NAV_FLAG) {
        return html.to_string();
    }

    if let Some(index) = html.rfind("</body>") {
        let mut output = String::with_capacity(html.len() + NAV_SNIPPET.len() + 8);
        output.push_str(&html[..index]);
        output.push_str(NAV_SNIPPET);
        output.push_str(&html[index..]);
        return output;
    }

    if let Some(index) = html.rfind("</head>") {
        let mut output = String::with_capacity(html.len() + NAV_SNIPPET.len() + 8);
        output.push_str(&html[..index]);
        output.push_str(NAV_SNIPPET);
        output.push_str(&html[index..]);
        return output;
    }

    format!("{}{}", html, NAV_SNIPPET)
}

/// True when a proxied external response came from the YouTube Music host —
/// the only host that gets the YTM bridge/chrome-strip injection.
fn is_ytm_host(final_url: &str) -> bool {
    url::Url::parse(final_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h == "music.youtube.com"))
        .unwrap_or(false)
}

/// Insert `snippet` at the top of <head>. Unlike the other injected scripts
/// (appended before </body>), anything that wraps browser APIs must run BEFORE
/// the page's own scripts, so it goes right after the opening <head> tag.
fn inject_at_head_top(html: &str, snippet: &str) -> String {
    // Find the opening <head> tag (with or without attributes), not <header>.
    let head_at = html.find("<head>").or_else(|| html.find("<head "));
    if let Some(pos) = head_at {
        if let Some(close) = html[pos..].find('>') {
            let insert_at = pos + close + 1;
            let mut output = String::with_capacity(html.len() + snippet.len());
            output.push_str(&html[..insert_at]);
            output.push_str(snippet);
            output.push_str(&html[insert_at..]);
            return output;
        }
    }
    format!("{}{}", snippet, html)
}

/// The universal request bridge for proxied external pages; see BRIDGE_SNIPPET.
fn inject_bridge_snippet(html: &str) -> String {
    if html.contains(BRIDGE_FLAG) {
        return html.to_string();
    }
    inject_at_head_top(html, BRIDGE_SNIPPET)
}

/// The YTM chrome-strip style; see YTM_SNIPPET.
fn inject_ytm_snippet(html: &str) -> String {
    if html.contains(YTM_FLAG) {
        return html.to_string();
    }
    inject_at_head_top(html, YTM_SNIPPET)
}

fn inject_scroll_script(html: &str) -> String {
    if html.contains(SCROLL_FLAG) {
        return html.to_string();
    }

    if let Some(index) = html.rfind("</body>") {
        let mut output = String::with_capacity(html.len() + SCROLL_SNIPPET.len() + 8);
        output.push_str(&html[..index]);
        output.push_str(SCROLL_SNIPPET);
        output.push_str(&html[index..]);
        return output;
    }

    if let Some(index) = html.rfind("</head>") {
        let mut output = String::with_capacity(html.len() + SCROLL_SNIPPET.len() + 8);
        output.push_str(&html[..index]);
        output.push_str(SCROLL_SNIPPET);
        output.push_str(&html[index..]);
        return output;
    }

    format!("{}{}", html, SCROLL_SNIPPET)
}

/// Parse `/proxy-ws/{ws|wss}/{host}{path}` (+ query) into the real socket URL.
fn get_ws_target_from_proxy_path(path: &str, query: Option<&str>) -> Option<String> {
    let rest = path.strip_prefix("/proxy-ws/")?;
    let mut segments = rest.splitn(3, '/');
    let scheme = segments.next()?;
    let authority = segments.next()?;
    if scheme != "ws" && scheme != "wss" {
        return None;
    }
    if authority.is_empty() {
        return None;
    }
    let remainder = segments.next().unwrap_or("");
    let mut target = format!("{scheme}://{authority}/{remainder}");
    if let Some(query) = query.filter(|value| !value.is_empty()) {
        target.push('?');
        target.push_str(query);
    }
    Some(target)
}

/// Bridge a proxied external page's WebSocket to its real remote endpoint
/// (`wss` included — rustls). The handshake carries the site's cookies from
/// the shared persistent jar plus a matching `Origin`, so sockets that require
/// an authenticated session (the normal case for logged-in web apps) connect.
async fn handle_external_websocket(
    client_ws: axum::extract::ws::WebSocket,
    target_ws_url: String,
    cookie_header: Option<String>,
    origin: Option<String>,
) {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let mut request = match target_ws_url.as_str().into_client_request() {
        Ok(req) => req,
        Err(err) => {
            eprintln!("Invalid external WS target {}: {}", target_ws_url, err);
            return;
        }
    };
    if let Some(cookies) = cookie_header {
        if let Ok(value) = cookies.parse() {
            request.headers_mut().insert("Cookie", value);
        }
    }
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            request.headers_mut().insert("Origin", value);
        }
    }

    let target_conn = match connect_async(request).await {
        Ok((conn, _)) => conn,
        Err(err) => {
            eprintln!(
                "Failed to connect to external WS server {}: {}",
                target_ws_url, err
            );
            return;
        }
    };

    bridge_ws_streams(client_ws, target_conn).await;
}

async fn handle_websocket(
    client_ws: axum::extract::ws::WebSocket,
    target_port: u16,
    path: String,
    preferred_host: Option<String>,
) {
    let mut target_conn = None;
    let mut last_error = None;
    for host in local_dev_hosts(preferred_host.as_deref()) {
        let target_ws_url = format!("ws://{}:{}{}", host, target_port, path);
        match connect_async(&target_ws_url).await {
            Ok((conn, _)) => {
                target_conn = Some(conn);
                break;
            }
            Err(err) => {
                last_error = Some((target_ws_url, err));
            }
        }
    }

    let target_conn = match target_conn {
        Some(conn) => conn,
        None => {
            if let Some((target_ws_url, err)) = last_error {
                eprintln!(
                    "Failed to connect to target WS server {}: {}",
                    target_ws_url, err
                );
            }
            return;
        }
    };

    bridge_ws_streams(client_ws, target_conn).await;
}

/// Pump messages in both directions between the preview WebView's socket and a
/// connected upstream socket until either side closes.
async fn bridge_ws_streams(
    client_ws: axum::extract::ws::WebSocket,
    target_conn: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let (mut client_write, mut client_read) = client_ws.split();
    let (mut target_write, mut target_read) = target_conn.split();

    let client_to_target = async {
        while let Some(msg) = client_read.next().await {
            if let Ok(msg) = msg {
                let tung_msg = match msg {
                    axum::extract::ws::Message::Text(t) => {
                        tokio_tungstenite::tungstenite::Message::Text(t.to_string().into())
                    }
                    axum::extract::ws::Message::Binary(b) => {
                        tokio_tungstenite::tungstenite::Message::Binary(b)
                    }
                    axum::extract::ws::Message::Ping(p) => {
                        tokio_tungstenite::tungstenite::Message::Ping(p)
                    }
                    axum::extract::ws::Message::Pong(p) => {
                        tokio_tungstenite::tungstenite::Message::Pong(p)
                    }
                    axum::extract::ws::Message::Close(c) => {
                        let cf =
                            c.map(
                                |frame| tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                    code: frame.code.into(),
                                    reason: frame.reason.to_string().into(),
                                },
                            );
                        tokio_tungstenite::tungstenite::Message::Close(cf)
                    }
                };
                if let Err(e) = target_write.send(tung_msg).await {
                    eprintln!("WS error forwarding client -> target: {}", e);
                    break;
                }
            } else {
                break;
            }
        }
    };

    let target_to_client = async {
        while let Some(msg) = target_read.next().await {
            if let Ok(msg) = msg {
                let axum_msg = match msg {
                    tokio_tungstenite::tungstenite::Message::Text(t) => {
                        axum::extract::ws::Message::Text(t.to_string().into())
                    }
                    tokio_tungstenite::tungstenite::Message::Binary(b) => {
                        axum::extract::ws::Message::Binary(b)
                    }
                    tokio_tungstenite::tungstenite::Message::Ping(p) => {
                        axum::extract::ws::Message::Ping(p)
                    }
                    tokio_tungstenite::tungstenite::Message::Pong(p) => {
                        axum::extract::ws::Message::Pong(p)
                    }
                    tokio_tungstenite::tungstenite::Message::Close(c) => {
                        let cf = c.map(|frame| axum::extract::ws::CloseFrame {
                            code: frame.code.into(),
                            reason: frame.reason.to_string().into(),
                        });
                        axum::extract::ws::Message::Close(cf)
                    }
                    _ => continue,
                };
                if let Err(e) = client_write.send(axum_msg).await {
                    eprintln!("WS error forwarding target -> client: {}", e);
                    break;
                }
            } else {
                break;
            }
        }
    };

    tokio::select! {
        _ = client_to_target => {},
        _ = target_to_client => {},
    }
}

#[cfg(test)]
mod tests {
    use super::{
        consent_form_params, encode_dir_for_base_href, get_ws_target_from_proxy_path,
        inject_bridge_snippet, inject_ytm_snippet, is_first_party_host, is_ytm_host,
        local_file_error, proxy_request_allowed, wants_html_error,
    };
    use axum::http::{HeaderMap, StatusCode};

    #[test]
    fn consent_form_params_dedupes_unescapes_and_skips_choice_flags() {
        // Shaped like Google's consent page: several <form>s repeating the same
        // hidden fields, each with its own set_* choice flag.
        let html = r#"
          <form action="https://consent.youtube.com/save" method="POST">
            <input type="hidden" name="gl" value="NG">
            <input type="hidden" name="continue" value="https://music.youtube.com/?cbrd=1&amp;x=1">
            <input type="hidden" name="escs" value="AZ8E49TOKEN">
            <input type="hidden" name="set_ytc" value="true">
          </form>
          <form action="https://consent.youtube.com/save" method="POST">
            <input type="hidden" name="gl" value="NG">
            <input type="hidden" name="escs" value="AZ8E49TOKEN">
            <input type="hidden" name="set_eom" value="true">
          </form>"#;
        let params = consent_form_params(html);
        assert_eq!(params.iter().filter(|(name, _)| name == "gl").count(), 1);
        assert!(params.contains(&(
            "continue".to_string(),
            "https://music.youtube.com/?cbrd=1&x=1".to_string()
        )));
        assert!(params.contains(&("escs".to_string(), "AZ8E49TOKEN".to_string())));
        // Choice flags are the caller's decision, never scraped from the page.
        assert!(!params.iter().any(|(name, _)| name.starts_with("set_")));
    }

    #[test]
    fn ytm_host_matches_only_music_youtube() {
        assert!(is_ytm_host("https://music.youtube.com/?cbrd=1"));
        assert!(!is_ytm_host("https://www.youtube.com/"));
        assert!(!is_ytm_host("https://consent.youtube.com/m?pc=ytm"));
        assert!(!is_ytm_host("https://evil-music.youtube.com.example.com/"));
        assert!(!is_ytm_host("not a url"));
    }

    #[test]
    fn bridge_snippet_lands_at_top_of_head_and_is_idempotent() {
        // The bridge must run before the page's own scripts, so it goes right
        // after the opening <head> tag — not before </body> like the others.
        let html = "<!doctype html><html><head><script>app</script></head><body></body></html>";
        let injected = inject_bridge_snippet(html);
        let head_end = injected.find("<head>").unwrap() + "<head>".len();
        assert!(injected[head_end..].starts_with("<script data-spacron-proxy-bridge>"));
        assert!(injected.find("spacron-proxy-bridge").unwrap() < injected.find("app").unwrap());
        // Re-injecting must not duplicate the snippet.
        assert_eq!(inject_bridge_snippet(&injected), injected);

        // <head lang="en"> variant still gets the snippet inside the tag.
        let with_attrs = "<html><head lang=\"en\"><title>t</title></head></html>";
        let injected = inject_bridge_snippet(with_attrs);
        assert!(injected.contains("<head lang=\"en\"><script data-spacron-proxy-bridge>"));

        // No <head> at all: snippet is prepended rather than dropped.
        let headless = "<body>hi</body>";
        assert!(inject_bridge_snippet(headless).starts_with("<script data-spacron-proxy-bridge>"));
    }

    #[test]
    fn ytm_style_injects_into_head_and_is_idempotent() {
        let html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
        let injected = inject_ytm_snippet(html);
        assert!(injected.contains("<style data-spacron-ytm-chrome>"));
        assert_eq!(inject_ytm_snippet(&injected), injected);
    }

    #[test]
    fn ws_proxy_path_parses_to_real_socket_url() {
        assert_eq!(
            get_ws_target_from_proxy_path("/proxy-ws/wss/chat.example.com/socket", None),
            Some("wss://chat.example.com/socket".to_string())
        );
        assert_eq!(
            get_ws_target_from_proxy_path("/proxy-ws/ws/host:8080/live", Some("v=2")),
            Some("ws://host:8080/live?v=2".to_string())
        );
        // Bare host, no path.
        assert_eq!(
            get_ws_target_from_proxy_path("/proxy-ws/wss/host.example", None),
            Some("wss://host.example/".to_string())
        );
        // Only ws/wss schemes; empty host rejected.
        assert_eq!(get_ws_target_from_proxy_path("/proxy-ws/http/host/x", None), None);
        assert_eq!(get_ws_target_from_proxy_path("/proxy-ws//host/x", None), None);
        assert_eq!(get_ws_target_from_proxy_path("/proxy/https/host/x", None), None);
    }

    #[test]
    fn error_page_is_html_with_status_and_escaped_message() {
        let resp = local_file_error(
            StatusCode::NOT_FOUND,
            "🔍",
            "File not found",
            "Missing <file> & gone",
            Some("try again"),
        );
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn wants_html_error_true_for_document_and_html_accept() {
        let mut doc = HeaderMap::new();
        doc.insert("sec-fetch-dest", "document".parse().unwrap());
        assert!(wants_html_error(&doc));

        let mut accept_html = HeaderMap::new();
        accept_html.insert("accept", "text/html,application/xhtml+xml".parse().unwrap());
        assert!(wants_html_error(&accept_html));
    }

    #[test]
    fn wants_html_error_false_for_subresource_fetch() {
        // A stylesheet request: not a document, Accept is text/css.
        let mut css = HeaderMap::new();
        css.insert("sec-fetch-dest", "style".parse().unwrap());
        css.insert("accept", "text/css,*/*;q=0.1".parse().unwrap());
        assert!(!wants_html_error(&css));

        // A script request typically sends Accept: */*.
        let mut js = HeaderMap::new();
        js.insert("sec-fetch-dest", "script".parse().unwrap());
        js.insert("accept", "*/*".parse().unwrap());
        assert!(!wants_html_error(&js));
    }

    #[test]
    fn opening_tag_end_finds_head_variants_and_rejects_lookalikes() {
        use super::find_opening_tag_end;
        // Plain <head>.
        let html = "<!DOCTYPE html><html><head><link href=\"a.css\"></head></html>";
        let idx = find_opening_tag_end(html, "head").unwrap();
        assert_eq!(&html[..idx], "<!DOCTYPE html><html><head>");
        // <head> with attributes; case-insensitive.
        let html = "<HTML><HEAD profile=\"x\"><title>t</title></HEAD></HTML>";
        let idx = find_opening_tag_end(html, "head").unwrap();
        assert_eq!(&html[..idx], "<HTML><HEAD profile=\"x\">");
        // <header> must NOT match "head"; </head> must not match either.
        assert_eq!(find_opening_tag_end("<body><header>x</header></body>", "head"), None);
        assert_eq!(find_opening_tag_end("</head>", "head"), None);
        // Fallback target: <html> without a <head>.
        let html = "<html><body>hi</body></html>";
        let idx = find_opening_tag_end(html, "html").unwrap();
        assert_eq!(&html[..idx], "<html>");
        // Nothing to find in a fragment.
        assert_eq!(find_opening_tag_end("<p>hi</p>", "head"), None);
    }

    #[test]
    fn base_href_encodes_spaces_as_percent20_not_plus() {
        // A Windows path containing a space (the real-world failure case).
        let dir = r"C:\Users\sam\Real Projects\spacron\website";
        let encoded = encode_dir_for_base_href(dir);
        // Space must be %20 so it survives percent_decode_str on the way back.
        assert!(encoded.contains("Real%20Projects"), "got: {encoded}");
        assert!(!encoded.contains('+'), "got: {encoded}");
        // Separators and drive-letter colon are preserved as real URL path parts.
        assert!(encoded.starts_with("C:/Users/sam/"), "got: {encoded}");
        assert!(!encoded.contains('\\'), "got: {encoded}");
    }

    #[test]
    fn base_href_resource_url_round_trips_through_percent_decode() {
        // Simulate the browser resolving `style.css` against the injected base
        // and the server decoding the captured wildcard path back to disk form.
        let dir = r"C:\Users\sam\Real Projects\spacron\website";
        let encoded = encode_dir_for_base_href(dir);
        let resource_path = format!("{encoded}/style.css");
        let decoded = percent_encoding::percent_decode_str(&resource_path)
            .decode_utf8()
            .unwrap()
            .into_owned();
        assert_eq!(
            decoded,
            "C:/Users/sam/Real Projects/spacron/website/style.css"
        );
    }

    #[test]
    fn base_href_keeps_separators_for_parent_references() {
        // `../` in the page must be able to escape into a sibling directory, so
        // the directory has to be many segments, not one opaque blob.
        let encoded = encode_dir_for_base_href(r"C:\a\b\website");
        assert_eq!(encoded.matches('/').count(), 3, "got: {encoded}");
    }

    fn headers_with_origin(origin: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(o) = origin {
            headers.insert("origin", o.parse().unwrap());
        }
        headers
    }

    #[test]
    fn first_party_hosts_are_recognised() {
        assert!(is_first_party_host("127.0.0.1"));
        assert!(is_first_party_host("0.0.0.0"));
        assert!(is_first_party_host("localhost"));
        assert!(is_first_party_host("::1"));
        // Tauri custom-protocol origins (main webview, asset protocol).
        assert!(is_first_party_host("tauri.localhost"));
        assert!(is_first_party_host("asset.localhost"));
        // Public hosts are not first-party.
        assert!(!is_first_party_host("evil.example"));
        assert!(!is_first_party_host("example.com"));
        // A look-alike that only contains "localhost" must not pass.
        assert!(!is_first_party_host("localhost.evil.com"));
        assert!(!is_first_party_host("notlocalhost"));
    }

    #[test]
    fn proxy_allows_missing_and_first_party_origins() {
        // Top-level navigations / most same-origin GETs carry no Origin.
        assert!(proxy_request_allowed(&headers_with_origin(None)));
        // The embedded preview and proxied subresources are served from loopback.
        assert!(proxy_request_allowed(&headers_with_origin(Some(
            "http://127.0.0.1:54321"
        ))));
        assert!(proxy_request_allowed(&headers_with_origin(Some(
            "http://localhost:5173"
        ))));
        // The Spacron main webview (Tauri custom protocol).
        assert!(proxy_request_allowed(&headers_with_origin(Some(
            "http://tauri.localhost"
        ))));
        assert!(proxy_request_allowed(&headers_with_origin(Some(
            "https://tauri.localhost"
        ))));
    }

    #[test]
    fn proxy_rejects_cross_origin_and_null() {
        // A page in the user's normal browser.
        assert!(!proxy_request_allowed(&headers_with_origin(Some(
            "https://evil.example"
        ))));
        assert!(!proxy_request_allowed(&headers_with_origin(Some(
            "http://attacker.test:8080"
        ))));
        // `null` (sandboxed / data: documents) is never something we emit.
        assert!(!proxy_request_allowed(&headers_with_origin(Some("null"))));
        // Garbage Origin values are rejected.
        assert!(!proxy_request_allowed(&headers_with_origin(Some(
            "not-a-url"
        ))));
    }

    #[test]
    fn loopback_hosts_are_allowed_through_the_proxy_gate() {
        use super::{is_loopback_host_target, is_private_target};
        // Loopback aliases must read as loopback so the SSRF gate lets them
        // through (the local-dev redirect rewriter routes app-to-app redirects
        // to these).
        assert!(is_loopback_host_target("http://localhost:4000/api"));
        assert!(is_loopback_host_target("http://127.0.0.1:8080/"));
        assert!(is_loopback_host_target("http://127.0.0.2:3000/")); // 127.0.0.0/8
        assert!(is_loopback_host_target("http://[::1]:5000/"));
        // Genuinely private LAN / metadata ranges are NOT loopback, so they stay
        // blocked (is_private_target still fires and the gate keeps rejecting).
        assert!(!is_loopback_host_target("http://192.168.1.10/"));
        assert!(is_private_target("http://192.168.1.10/"));
        assert!(!is_loopback_host_target("http://10.0.0.5/"));
        assert!(!is_loopback_host_target("http://169.254.169.254/")); // cloud metadata
        assert!(is_private_target("http://169.254.169.254/"));
        // 0.0.0.0 is unspecified, not loopback — remains blocked.
        assert!(!is_loopback_host_target("http://0.0.0.0:3000/"));
        // Public hosts are neither.
        assert!(!is_loopback_host_target("https://example.com/"));
    }

    #[test]
    fn resolved_ip_gate_blocks_private_but_allows_loopback() {
        use super::has_blocked_resolved_ip;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // IP literals resolve to themselves — deterministic, no real DNS needed.
        // LAN / metadata / unspecified stay blocked.
        assert!(rt.block_on(has_blocked_resolved_ip("192.168.1.10", 80)));
        assert!(rt.block_on(has_blocked_resolved_ip("10.0.0.5", 80)));
        assert!(rt.block_on(has_blocked_resolved_ip("169.254.169.254", 80)));
        assert!(rt.block_on(has_blocked_resolved_ip("0.0.0.0", 80)));
        // Loopback is the user's own machine — a hostname resolving here (e.g. a
        // hosts-file alias like myapp.test) must NOT be blocked.
        assert!(!rt.block_on(has_blocked_resolved_ip("127.0.0.1", 80)));
        assert!(!rt.block_on(has_blocked_resolved_ip("127.0.0.2", 80)));
        assert!(!rt.block_on(has_blocked_resolved_ip("::1", 80)));
        // Public addresses pass.
        assert!(!rt.block_on(has_blocked_resolved_ip("93.184.216.34", 80)));
        // Resolution failure defers to the client's real connection error.
        assert!(!rt.block_on(has_blocked_resolved_ip(
            "this-name-should-not-resolve.invalid",
            80
        )));
    }

    #[test]
    fn local_redirect_to_same_dev_server_becomes_relative() {
        use super::rewrite_local_redirect_location;
        let proxy = "http://127.0.0.1:54321";
        // Absolute redirect back to the dev server's own origin (any loopback
        // alias) collapses to a proxy-relative path so it stays on the proxy.
        assert_eq!(
            rewrite_local_redirect_location("http://localhost:3000/login", 3000, proxy),
            Some("/login".to_string())
        );
        assert_eq!(
            rewrite_local_redirect_location("http://127.0.0.1:3000/login?next=/", 3000, proxy),
            Some("/login?next=/".to_string())
        );
        // An https upgrade on the same host:port is still the dev server.
        assert_eq!(
            rewrite_local_redirect_location("https://localhost:3000/dashboard#top", 3000, proxy),
            Some("/dashboard#top".to_string())
        );
    }

    #[test]
    fn relative_and_non_http_locations_are_left_alone() {
        use super::rewrite_local_redirect_location;
        let proxy = "http://127.0.0.1:54321";
        // Relative Locations already resolve against the proxy origin.
        assert_eq!(rewrite_local_redirect_location("/login", 3000, proxy), None);
        assert_eq!(
            rewrite_local_redirect_location("./next?a=b", 3000, proxy),
            None
        );
        // Non-http(s) schemes must never be rewritten.
        assert_eq!(
            rewrite_local_redirect_location("mailto:hi@example.com", 3000, proxy),
            None
        );
        assert_eq!(rewrite_local_redirect_location("   ", 3000, proxy), None);
    }

    #[test]
    fn cross_origin_redirect_is_routed_through_proxy_path() {
        use super::rewrite_local_redirect_location;
        let proxy = "http://127.0.0.1:54321";
        // A hosted auth provider — keep it on the proxy so its framing guards get
        // stripped instead of blocking the iframe.
        assert_eq!(
            rewrite_local_redirect_location(
                "https://romantic-cat-12.clerk.accounts.dev/v1/client/handshake?redirect=/",
                3000,
                proxy
            ),
            Some(
                "http://127.0.0.1:54321/proxy/https/romantic-cat-12.clerk.accounts.dev/v1/client/handshake?redirect=/"
                    .to_string()
            )
        );
        // A different local service (not the dev port) is treated as external too.
        assert_eq!(
            rewrite_local_redirect_location("http://localhost:4000/api", 3000, proxy),
            Some("http://127.0.0.1:54321/proxy/http/localhost:4000/api".to_string())
        );
    }

    #[test]
    fn external_redirect_back_to_proxy_origin_collapses_to_relative() {
        use super::rewrite_external_redirect_location;
        // The exact Clerk dev-instance handshake shape: the provider 307s back
        // to the redirect_url it was handed, which the Host rewrite made the
        // proxy's own origin. The browser must land back on the proxy root (the
        // dev server) still carrying the handshake token.
        let target = url::Url::parse(
            "https://main-lizard-73.clerk.accounts.dev/v1/client/handshake?redirect_url=http%3A%2F%2F127.0.0.1%3A57532%2F",
        )
        .unwrap();
        assert_eq!(
            rewrite_external_redirect_location(
                "http://127.0.0.1:57532/?__clerk_handshake=abc",
                &target,
                "http://127.0.0.1:57532"
            ),
            Some("/?__clerk_handshake=abc".to_string())
        );
        // Any loopback alias on the proxy port is still the proxy itself.
        assert_eq!(
            rewrite_external_redirect_location(
                "http://localhost:57532/done",
                &target,
                "http://127.0.0.1:57532"
            ),
            Some("/done".to_string())
        );
    }

    #[test]
    fn external_redirects_stay_on_the_proxy() {
        use super::rewrite_external_redirect_location;
        let target = url::Url::parse("https://example.com/start/here").unwrap();
        let proxy = "http://127.0.0.1:54321";
        // Absolute redirect to another external origin (an OAuth hop).
        assert_eq!(
            rewrite_external_redirect_location(
                "https://accounts.google.com/o/oauth2/auth?client_id=1",
                &target,
                proxy
            ),
            Some(
                "http://127.0.0.1:54321/proxy/https/accounts.google.com/o/oauth2/auth?client_id=1"
                    .to_string()
            )
        );
        // Root-relative resolves against the *external* origin, not the proxy —
        // served untouched it would lose the /proxy/{scheme}/{host} prefix.
        assert_eq!(
            rewrite_external_redirect_location("/login", &target, proxy),
            Some("http://127.0.0.1:54321/proxy/https/example.com/login".to_string())
        );
        // Path-relative resolves against the target's directory.
        assert_eq!(
            rewrite_external_redirect_location("next?a=b", &target, proxy),
            Some("http://127.0.0.1:54321/proxy/https/example.com/start/next?a=b".to_string())
        );
        // Protocol-relative inherits the target's scheme.
        assert_eq!(
            rewrite_external_redirect_location("//cdn.example.net/x", &target, proxy),
            Some("http://127.0.0.1:54321/proxy/https/cdn.example.net/x".to_string())
        );
        // A loopback service on a NON-proxy port is routed through the proxy's
        // external form (the /proxy gate re-checks it on the next hop).
        assert_eq!(
            rewrite_external_redirect_location("http://localhost:3000/app", &target, proxy),
            Some("http://127.0.0.1:54321/proxy/http/localhost:3000/app".to_string())
        );
        // Non-http(s) schemes are never rewritten.
        assert_eq!(
            rewrite_external_redirect_location("mailto:hi@example.com", &target, proxy),
            None
        );
        assert_eq!(rewrite_external_redirect_location("  ", &target, proxy), None);
    }

    #[test]
    fn strips_headers_that_break_preview_origin() {
        assert!(super::should_strip_preview_header(
            "strict-transport-security"
        ));
        assert!(super::should_strip_preview_header("x-frame-options"));
        assert!(super::should_strip_preview_header(
            "content-security-policy"
        ));
        assert!(!super::should_strip_preview_header("cache-control"));
    }
}

/// End-to-end tests for the `/local-file` preview routes: build the same Router
/// the proxy serves, bind it on a real loopback port, and drive it with an HTTP
/// client exactly like the preview WebView does — HTML document via
/// `/local-file?path=…`, then its subresources via the injected `<base>` href.
#[cfg(test)]
mod local_file_e2e {
    use super::*;
    use axum::routing::any;
    use std::sync::RwLock;

    /// Mirror of `start_proxy`'s router, minus the Tauri runtime.
    async fn spawn_test_proxy(project_root: Option<std::path::PathBuf>) -> u16 {
        let cookie_jars = PartitionedJars::new(
            std::env::temp_dir().join(format!("spacron-test-cookies-{}", std::process::id())),
        );
        let state = ProxyState {
            target_port: Arc::new(Mutex::new(5173)),
            preferred_local_host: Arc::new(Mutex::new(None)),
            active_external_origins: Arc::new(Mutex::new(std::collections::HashMap::new())),
            active_project_id: Arc::new(RwLock::new(None)),
            project_root: Arc::new(RwLock::new(project_root)),
            external_origin_fallback: true,
            cookie_jars,
            active_partition: Arc::new(RwLock::new(None)),
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
            .expect("bind test proxy");
        let port = listener.local_addr().expect("local addr").port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        port
    }

    fn test_client() -> Client {
        // no_proxy: keep loopback requests off any system/env HTTP proxy.
        Client::builder().no_proxy().build().expect("client")
    }

    /// Canonicalize + clean the way `workspace_open_project` produces the root
    /// the frontend later hands to `preview_set_project_root`.
    fn canonical_root(path: &std::path::Path) -> std::path::PathBuf {
        crate::commands::clean_path_buf(std::fs::canonicalize(path).expect("canonicalize root"))
    }

    fn local_file_url(port: u16, file: &std::path::Path) -> String {
        let query: String = form_urlencoded::Serializer::new(String::new())
            .append_pair("path", file.to_string_lossy().as_ref())
            .finish();
        format!("http://127.0.0.1:{port}/local-file?{query}")
    }

    fn extract_base_href(html: &str) -> String {
        let start = html.find("<base href=\"").expect("base tag injected") + "<base href=\"".len();
        let end = html[start..].find('"').expect("closing quote") + start;
        html[start..end].to_string()
    }

    #[tokio::test]
    async fn serves_html_document_and_relative_subresources() {
        // Directory names include spaces to mirror real-world roots like
        // "Real Projects" — the encoding path this feature originally broke on.
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = canonical_root(tmp.path());
        let site = root.join("site pages");
        std::fs::create_dir_all(site.join("img")).unwrap();
        std::fs::write(
            site.join("index.html"),
            "<!DOCTYPE html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head>\
             <body><img src=\"img/logo.svg\"><script src=\"../shared.js\"></script></body></html>",
        )
        .unwrap();
        std::fs::write(site.join("styles.css"), "body { color: teal; }").unwrap();
        std::fs::write(site.join("img").join("logo.svg"), "<svg></svg>").unwrap();
        std::fs::write(root.join("shared.js"), "console.log('shared')").unwrap();

        let port = spawn_test_proxy(Some(root.clone())).await;
        let client = test_client();

        // 1. The HTML document, requested the way `previewLocalFile` builds it.
        let doc_url = local_file_url(port, &site.join("index.html"));
        let resp = client.get(&doc_url).send().await.expect("doc request");
        assert_eq!(resp.status(), 200, "document should serve");
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(content_type.contains("text/html"), "got: {content_type}");
        let body = resp.text().await.unwrap();
        assert!(body.contains("stylesheet"), "original HTML preserved");

        // The <base> must be parsed BEFORE the stylesheet <link>: browsers only
        // apply a base to elements that come after it, so a base injected at the
        // end of <head> leaves the CSS resolving against the document URL and
        // the page renders unstyled.
        let base_pos = body.find("<base href=").expect("base tag present");
        let link_pos = body.find("<link").expect("stylesheet link present");
        assert!(
            base_pos < link_pos,
            "<base> must precede the stylesheet <link> or the browser ignores it for that link"
        );

        // 2. The injected <base> must resolve this document's relative URLs.
        let base = extract_base_href(&body);
        let base_url = url::Url::parse(&base).expect("base href parses");

        // Same-directory stylesheet.
        let css = client
            .get(base_url.join("styles.css").unwrap())
            .header("sec-fetch-dest", "style")
            .send()
            .await
            .expect("css request");
        assert_eq!(css.status(), 200, "stylesheet should serve via base href");
        assert_eq!(css.text().await.unwrap(), "body { color: teal; }");

        // Nested image.
        let img = client
            .get(base_url.join("img/logo.svg").unwrap())
            .send()
            .await
            .expect("img request");
        assert_eq!(img.status(), 200, "nested image should serve");

        // Parent-directory reference (`../shared.js`) — needs the base href to
        // keep `/` as segment separators so `..` resolves to the real sibling.
        let js = client
            .get(base_url.join("../shared.js").unwrap())
            .send()
            .await
            .expect("js request");
        assert_eq!(js.status(), 200, "parent-relative script should serve");
        assert_eq!(js.text().await.unwrap(), "console.log('shared')");
    }

    #[tokio::test]
    async fn refuses_files_outside_the_project_root() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let outside = tempfile::TempDir::new().expect("outside tempdir");
        let root = canonical_root(tmp.path());
        let secret = outside.path().join("secret.html");
        std::fs::write(&secret, "<html>secret</html>").unwrap();

        let port = spawn_test_proxy(Some(root)).await;
        let client = test_client();

        // Query form.
        let resp = client
            .get(local_file_url(port, &secret))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 403, "outside-root file must be refused");

        // Wildcard (base-href) form.
        let encoded = encode_dir_for_base_href(&secret.to_string_lossy());
        let resp = client
            .get(format!("http://127.0.0.1:{port}/local-file/{encoded}"))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 403, "wildcard route must refuse too");
    }

    #[tokio::test]
    async fn requires_a_project_root_before_serving() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let file = tmp.path().join("index.html");
        std::fs::write(&file, "<html></html>").unwrap();

        let port = spawn_test_proxy(None).await;
        let client = test_client();
        let resp = client
            .get(local_file_url(port, &file))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 400, "no root set → refuse with 400");
        let body = resp.text().await.unwrap();
        assert!(body.contains("No project open"), "friendly error page");
    }

    #[tokio::test]
    async fn missing_file_gets_styled_not_found_page() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = canonical_root(tmp.path());
        let port = spawn_test_proxy(Some(root.clone())).await;
        let client = test_client();
        let resp = client
            .get(local_file_url(port, &root.join("gone.html")))
            .send()
            .await
            .expect("request");
        assert_eq!(resp.status(), 404);
        let body = resp.text().await.unwrap();
        assert!(body.contains("File not found"));
    }
}

#[cfg(test)]
mod proxy_origin_e2e;
