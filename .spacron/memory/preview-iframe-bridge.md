# Preview panel: the iframe bridge is postMessage-only

The app shell runs on `tauri.localhost`; every preview iframe is served from the
embedded proxy on `http://127.0.0.1:{port}` — external sites through the shared
background proxy, local dev servers through a *per-dev-port* proxy started by
`ensureLocalDevProxy` (see `buildIframeSrc` in `PreviewPanel.tsx`). Those are all
different origins from the shell, so **any direct DOM reach into the iframe
throws SecurityError**. `allow-same-origin` in the sandbox makes the document
same-origin with the *proxy*, not with the app.

So everything the panel knows about a page arrives by `postMessage`, from scripts
the Rust proxy injects (`src-tauri/src/preview/mod.rs`, applied in
`build_preview_response`):

| message | injected by | pages |
| --- | --- | --- |
| `forge-preview:console` | `INSPECTOR_SNIPPET` | local dev |
| `forge-inspector:selected` | `INSPECTOR_SNIPPET` | local dev |
| `forge-preview:scroll` / `:scroll-ready` | `SCROLL_SNIPPET` | all |
| `forge-preview:media` / `:media-ready` | `MEDIA_SNIPPET` | all |
| `forge-preview:location` | `NAV_SNIPPET` (external), `LOCAL_LOCATION_SNIPPET` (local dev) | all |
| `forge-preview:error` | `preview_error_response` | proxy failures only |

Two rules when touching this:

1. **Never add code that reads `contentDocument` / `contentWindow.location`.**
   It will silently land in a `catch` and look like a feature that "sometimes
   doesn't work". Both the media-position sync and the local-dev address-bar sync
   were originally written that way and did nothing at all.
2. **Validate every inbound message against `expectedOriginForTab(tabId)`**, which
   resolves to the tab's own dev proxy origin for a local dev tab and the shared
   proxy origin otherwise. A local-dev tab does *not* arrive on the main proxy
   port.

## Gotcha: the message listener must not be pinned to mount

`handleInspectorMessage` closes over `localDevProxyPortsValue`, which is `{}` on
first render and only fills in once `ensureLocalDevProxy` resolves. It used to be
registered from the `[]` mount effect, so the local-dev origin check compared
against `null` forever and console output, scroll restore and element picking
silently did nothing — until an unrelated remount happened to recapture a
populated map, which made it look intermittent. It now has its own effect keyed on
the callback. Keep it that way.

## Errors: an iframe fires `load`, not `error`, for a served error body

`onError` on the iframe is effectively unreachable, so a dead dev server used to
render the proxy's plain-text 502 in the frame with no banner. The proxy now
returns an HTML error page (`preview_error_response`) that posts
`forge-preview:error`. Consequently `handleIframeLoad` must **not** clear
`iframeError` — it is cleared when a new load starts and when a page reports its
own location (an error page never does).

Related: [[preview-room-is-persistent]]
