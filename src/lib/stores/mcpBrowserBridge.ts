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
import {
  nativePreviewActive,
  nativePreviewUrl,
  activateNativePreview,
  deactivateNativePreview,
  nativePreviewEval,
} from './nativePreview';

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

  if (mode === 'window') {
    const el = getPreviewContentEl();
    if (!el) throw new Error('Preview panel is not mounted.');
    setActiveView('preview');
    await activateNativePreview(url, el);
    return `Opened "${url}" in native webview mode.`;
  }

  await ensureProxyRunning();
  navigatePreviewTab(url);
  setActiveView('preview');

  if (mode === 'auto') {
    const loaded = await waitForPageResponse(5000);
    if (!loaded) {
      const el = getPreviewContentEl();
      if (!el) throw new Error('Preview panel is not mounted.');
      await activateNativePreview(url, el);
      return `Page refused iframe embedding. Switched to native webview for "${url}".`;
    }
  }

  return `Navigated preview to "${url}".`;
}

async function handleScreenshot(args: Record<string, unknown>): Promise<unknown> {
  if (get(nativePreviewActive)) {
    const pngBytes = await invoke<number[]>('native_preview_screenshot');
    const base64 = bytesToBase64(new Uint8Array(pngBytes));
    return { image_base64: base64, format: 'png' };
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
  if (get(nativePreviewActive)) {
    const url = get(nativePreviewUrl);
    return { url, title: '', readyState: 'native' };
  }

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

  if (get(nativePreviewActive)) {
    const script = `(function(){var els=document.querySelectorAll(${JSON.stringify(selector)});var out=[];for(var i=0;i<Math.min(els.length,${limit});i++){var el=els[i];out.push(${format === 'html' ? 'el.outerHTML' : 'el.innerText||el.textContent||""'});}return JSON.stringify({count:els.length,results:out});})()`;
    await nativePreviewEval(script);
    return { note: 'DOM query executed in native webview. Results emitted via console capture.' };
  }

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

  if (get(nativePreviewActive)) {
    if (action === 'click') {
      const script = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'not found';el.click();return 'clicked';})()`;
      await nativePreviewEval(script);
    } else {
      const text = (args.text as string) || '';
      const script = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'not found';el.focus();el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));${args.submit ? "el.closest('form')&&el.closest('form').requestSubmit();" : ''}return 'typed';})()`;
      await nativePreviewEval(script);
    }
    return { action, selector, status: 'executed' };
  }

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
  if (get(nativePreviewActive)) {
    await deactivateNativePreview();
    return 'Native webview hidden. Preview reverted to iframe mode.';
  }
  return 'No native webview was active.';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPreviewContentEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.preview-content');
}

function getActiveIframe(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>('.preview-iframe.is-active');
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
      const data = event.data;
      if (data?.type === 'forge-mcp:response' && data?.requestId === requestId) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(data.result ?? data);
      }
    }

    window.addEventListener('message', handler);
    iframe.contentWindow?.postMessage(fullMessage, '*');
  });
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
