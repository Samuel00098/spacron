/**
 * Bridge between the Rust MCP server's browser tools and the frontend
 * preview panel. Listens for "mcp:browser-request" Tauri events, executes
 * the requested browser tool, and responds via "mcp_browser_respond".
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { get } from '$lib/stores/storeCompat';
import {
  previewTabs,
  activePreviewTabId,
  navigatePreviewTab,
  ensureProxyRunning,
} from './preview';
import { previewConsoleLogs } from './previewConsole';
import { setActiveView } from './layout';

interface BrowserRequestPayload {
  request_id: string;
  tool: string;
  args: Record<string, unknown>;
}

let browserBridgeInitialized = false;

export function initMcpBrowserBridge(): void {
  if (browserBridgeInitialized) return;
  browserBridgeInitialized = true;

  listen<BrowserRequestPayload>('mcp:browser-request', async (event) => {
    const { request_id, tool, args } = event.payload;
    try {
      const result = await handleBrowserTool(tool, args);
      await invoke('mcp_browser_respond', {
        requestId: request_id,
        success: true,
        data: result,
      });
    } catch (err) {
      await invoke('mcp_browser_respond', {
        requestId: request_id,
        success: false,
        data: String(err instanceof Error ? err.message : err),
      }).catch(() => {});
    }
  }).catch((e) => {
    console.error('[mcp-browser] Failed to listen for browser-request events:', e);
  });

  console.log('[mcp-browser] Browser bridge initialized');
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function handleBrowserTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case 'browser_navigate':
      return handleNavigate(args);
    case 'browser_screenshot':
      return handleScreenshot(args);
    case 'browser_get_page_info':
      return handleGetPageInfo();
    case 'browser_read_dom':
      return handleReadDom(args);
    case 'browser_console_logs':
      return handleConsoleLogs(args);
    case 'browser_click':
      return handleInteract('click', args);
    case 'browser_type':
      return handleInteract('type', args);
    case 'browser_close_window':
      return handleCloseWindow();
    default:
      throw new Error(`Unknown browser tool: ${tool}`);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleNavigate(args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;
  if (!url) throw new Error('Missing required parameter: url');

  const mode = (args.mode as string) || 'auto';

  // Hand the URL to the host OS's default browser. Nothing is embedded, so none
  // of the other browser tools can act on the result — this is for "just open
  // this for the user", not for driving a page.
  if (mode === 'system') {
    await invoke('preview_open_in_browser', { url });
    return (
      `Opened "${url}" in the system default browser. It is outside the app, so ` +
      `browser_read_dom / browser_click / browser_type / browser_screenshot cannot ` +
      `act on it — use mode:"iframe" or mode:"window" if you need to drive the page.`
    );
  }

  // Standalone pop-up window: a real Tauri window, so it renders sites that refuse
  // iframe embedding. It stays in-app (screenshot and close work on it), but it has
  // no injected postMessage bridge, so the DOM/interaction tools cannot drive it.
  if (mode === 'window') {
    await invoke('browser_create_window', { url });
    return (
      `Opened "${url}" in a standalone browser window. browser_screenshot and ` +
      `browser_close_window act on it; browser_read_dom / browser_click / browser_type ` +
      `need the preview iframe and are unavailable while it is open.`
    );
  }

  await ensureProxyRunning();
  navigatePreviewTab(url);
  setActiveView('preview');

  if (mode === 'auto') {
    const loaded = await waitForPageResponse(5000);
    if (!loaded) {
      // A missing bridge response only means "refused embedding" for pages the
      // proxy actually injected MCP_SNIPPET into. Pages loaded outside the proxy
      // (about:blank, direct YouTube /embed/ URLs) have no bridge by design and
      // would otherwise false-negative here, spawning a pop-up window for a page
      // that was rendering perfectly well.
      if (!isBridgeCapableIframe()) {
        return (
          `Navigated preview to "${url}". The page is not served through the injecting ` +
          `proxy, so the DOM/interaction tools are unavailable for it; left it in the ` +
          `preview panel. Pass mode:"window" if you need to drive it.`
        );
      }
      await invoke('browser_create_window', { url });
      return `Page refused iframe embedding. Opened "${url}" in a standalone browser window instead.`;
    }
  }

  return `Navigated preview to "${url}".`;
}

async function handleScreenshot(args: Record<string, unknown>): Promise<unknown> {
  // A standalone window is what the agent is actually looking at, so capture it
  // rather than the iframe sitting behind it in the panel.
  if (await isBrowserWindowOpen()) {
    const pngBytes = await invoke<number[]>('browser_screenshot_window');
    const base64 = bytesToBase64(new Uint8Array(pngBytes));
    return { image_base64: base64, format: 'png', source: 'window' };
  }

  const iframe = getActiveIframe();
  if (!iframe) throw new Error('No active preview iframe found. Is the preview panel open?');

  const rect = iframe.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    throw new Error('Preview iframe has zero dimensions. Is the preview panel visible?');
  }

  const scale = window.devicePixelRatio || 1;
  const pngBytes = await invoke<number[]>('preview_capture_screenshot', {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    scale,
  });

  const base64 = bytesToBase64(new Uint8Array(pngBytes));
  return { image_base64: base64, format: 'png', width: Math.round(rect.width), height: Math.round(rect.height) };
}

async function handleGetPageInfo(): Promise<unknown> {
  const tabs = get(previewTabs);
  const activeId = get(activePreviewTabId);
  const activeTab = tabs.find((t) => t.id === activeId);

  if (!activeTab) throw new Error('No active preview tab found.');

  const iframe = getActiveIframe();
  let title = activeTab.title || '';
  let readyState = 'unknown';

  if (iframe?.contentWindow) {
    try {
      const info = await postMessageRoundTrip(iframe, {
        type: 'forge-mcp:page-info',
      }, 3000);
      title = (info?.title as string) || title;
      readyState = (info?.readyState as string) || 'unknown';
    } catch {
      readyState = 'unreachable';
    }
  }

  return { url: activeTab.url, title, readyState };
}

async function handleReadDom(args: Record<string, unknown>): Promise<unknown> {
  const selector = (args.selector as string) || 'body';
  const format = (args.format as string) || 'text';
  const limit = (args.limit as number) || 10;

  await assertNoStandaloneWindow('browser_read_dom');

  const iframe = getActiveIframe();
  if (!iframe) throw new Error('No active preview iframe found. Is the preview panel open?');

  const result = await postMessageRoundTrip(iframe, {
    type: 'forge-mcp:query',
    selector,
    format,
    limit,
  }, 5000);

  if (!result) throw new Error('No response from page. The page may not have the MCP bridge loaded.');
  return result;
}

function handleConsoleLogs(args: Record<string, unknown>): unknown {
  const level = (args.level as string) || 'all';
  const limit = (args.limit as number) || 50;

  let logs = get(previewConsoleLogs);

  if (level !== 'all') {
    logs = logs.filter((l) => l.level === level);
  }

  const entries = logs.slice(-limit).map((l) => ({
    level: l.level,
    message: l.message,
    url: l.url,
    timestamp: l.timestamp,
  }));

  return { count: entries.length, logs: entries };
}

async function handleInteract(
  action: 'click' | 'type',
  args: Record<string, unknown>,
): Promise<unknown> {
  const selector = args.selector as string;
  if (!selector) throw new Error('Missing required parameter: selector');

  await assertNoStandaloneWindow(`browser_${action}`);

  const iframe = getActiveIframe();
  if (!iframe) throw new Error('No active preview iframe found. Is the preview panel open?');

  const result = await postMessageRoundTrip(iframe, {
    type: 'forge-mcp:interact',
    action,
    selector,
    text: args.text as string | undefined,
    submit: args.submit as boolean | undefined,
  }, 5000);

  if (!result) throw new Error('No response from page. The element may not exist or the MCP bridge is not loaded.');
  return result;
}

async function handleCloseWindow(): Promise<string> {
  try {
    await invoke('browser_close_window');
    return 'Browser window closed.';
  } catch {
    return 'No browser window was open.';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getActiveIframe(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>('.preview-iframe.is-active');
}

/**
 * Refuse a page-driving tool while a standalone window is open.
 *
 * These tools only reach the preview iframe (they need the postMessage bridge the
 * proxy injects, which the standalone window has no equivalent of). With a window
 * open, the iframe is not what the agent is looking at, so running them anyway
 * would read — or worse, click — a page nobody asked about. Fail with a way out
 * instead of acting on the wrong document.
 */
async function assertNoStandaloneWindow(tool: string): Promise<void> {
  if (!(await isBrowserWindowOpen())) return;
  throw new Error(
    `A standalone browser window is open, and ${tool} can only act on the preview ` +
      `iframe — running it now would target a different page than the one on screen. ` +
      `Call browser_close_window first, or re-navigate with mode:"iframe".`,
  );
}

/** Whether the standalone pop-up browser window is currently open. */
async function isBrowserWindowOpen(): Promise<boolean> {
  try {
    return await invoke<boolean>('browser_window_is_open');
  } catch {
    return false;
  }
}

/**
 * Whether the active iframe is one the background proxy served, and therefore
 * one that should have MCP_SNIPPET injected. Everything the proxy serves is on
 * the loopback origin; anything else (about:blank, a direct YouTube embed, or an
 * empty src while the proxy is still starting) has no bridge and must not be
 * read as evidence that the site blocked embedding.
 */
function isBridgeCapableIframe(): boolean {
  const iframe = getActiveIframe();
  if (!iframe) return false;
  const src = iframe.getAttribute('src') || '';
  return src.startsWith('http://127.0.0.1:');
}

/**
 * Post a message into the iframe and wait for a matching response.
 * The injected MCP_SNIPPET in the proxied page handles these messages.
 */
function postMessageRoundTrip(
  iframe: HTMLIFrameElement,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const requestId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fullMessage = { ...message, requestId };

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, timeoutMs);

    function handler(event: MessageEvent) {
      // Only accept a reply from the exact frame we asked. The preview loads
      // arbitrary third-party pages, so without this any frame on the page (or a
      // nested ad iframe) could forge a response and feed the agent bogus DOM.
      if (event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (data?.type === 'forge-mcp:response' && data?.requestId === requestId) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(data.result ?? data);
      }
    }

    window.addEventListener('message', handler);
    // Pin the target origin to the proxy that injected the bridge. With '*' the
    // payload — which for browser_type carries whatever text the agent was told
    // to enter — would be delivered to whatever origin the frame happens to hold
    // by then, e.g. after a redirect off the proxy.
    iframe.contentWindow?.postMessage(fullMessage, bridgeTargetOrigin(iframe));
  });
}

/**
 * The origin the injected MCP bridge lives on: the loopback proxy that served
 * the page. Falls back to '*' only when the src isn't parseable, which means
 * there is no bridge to talk to and the round trip will time out anyway.
 */
function bridgeTargetOrigin(iframe: HTMLIFrameElement): string {
  try {
    return new URL(iframe.getAttribute('src') || '').origin;
  } catch {
    return '*';
  }
}

/**
 * After navigating in auto mode, wait for the page to respond to a
 * page-info query. If it doesn't respond, the page likely frame-busted.
 */
async function waitForPageResponse(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    const iframe = getActiveIframe();
    if (!iframe) continue;
    try {
      const info = await postMessageRoundTrip(iframe, { type: 'forge-mcp:page-info' }, 1000);
      if (info) return true;
    } catch {
      // Page not ready yet
    }
  }
  return false;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
