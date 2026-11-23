import { registerPreviewBrowser } from '$lib/services/preview-browser-control';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '$lib/stores/storeCompat';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '$lib/react/useStore';
import { useAction } from '$lib/react/useAction';
import { clampHorizontalScroll } from '$lib/actions/clampHorizontalScroll';
import { copyPngToClipboard, copyTextToClipboard } from '$lib/utils/clipboard';
import {
  targetPort,
  proxyPort,
  proxyStarted,
  preferredLocalHost,
  localDevProxyPorts,
  currentUrl,
  previewTabs,
  activePreviewTabId,
  isConnecting,
  loadProxyState,
  startProxy,
  stopProxy,
  setTargetPort,
  ensureProxyRunning,
  ensureLocalDevProxy,
  setPreferredLocalHost,
  clearProxyTarget,
  clearPreviewData,
  localDevProxyKey,
  parseLocalFilePreviewUrl,
  navigatePreviewTab,
  commitInternalNavigation,
  replaceCurrentNavigation,
  goBackPreviewTab,
  goForwardPreviewTab,
  createPreviewBrowserTab,
  previewAddressBarValue,
  selectPreviewBrowserTab,
  closePreviewBrowserTab,
} from '$lib/stores/preview';
import { previewConsoleLogs, pushConsoleLog, clearConsoleLogs as clearConsoleLogsStore } from '$lib/stores/previewConsole';
import Dropdown, { type DropdownOption } from '$lib/components/shared/Dropdown.tsx';
import {
  VIEWPORT_PRESETS,
  CUSTOM_PRESET_ID,
  DEFAULT_PHONE_PRESET,
  DEFAULT_TABLET_PRESET,
  ZOOM_LEVELS,
  MIN_VIEWPORT,
  MAX_VIEWPORT,
  clampViewportEdge,
  findPreset,
  matchPreset,
} from './viewportPresets';
import { showToast } from '$lib/stores/notification';
import {
  browsingHistory,
  recordHistoryVisit,
  removeHistoryEntry,
  clearBrowsingHistory,
  saveScrollPosition,
  getScrollPosition,
} from '$lib/stores/previewHistory';
import { promptBarImage, focusPromptBar, getActiveAgentSessionId, requestTerminalInput } from '$lib/stores/terminal';
import { buildElementPrompt, type SelectedElementInfo } from '$lib/services/element-prompt';
import DesignModePanel from './DesignModePanel';
import PreviewAnnotationOverlay from './PreviewAnnotationOverlay';
import { dispatchPromptToAgent } from '$lib/services/agent-target';
import {
  browserDefaultPort,
  browserThemeMode,
  browserDesignModeAutoScreenshot,
  browserDesignModeIncludeStyles,
  browserDesignModeIncludeHtml,
  browserDesignModeMaxHtmlLength,
  browserConsoleAutoOpenOnError,
  browserConsolePreserveLog,
  browserDefaultZoom,
  browserDefaultViewport,
} from '$lib/stores/settings';
import { activeProject } from '$lib/stores/workspace';
import { activeTheme } from '$lib/stores/theme';
import { useProjectPanelState } from '$lib/react/useProjectPanelState';

import { useLayoutStore } from '$lib/stores/zustand/layout';
import { setPreviewDocked, openSettings } from '$lib/stores/layout';
import './PreviewPanel.css';

/** Explicit percentage, or 'fit' to auto-scale the viewport into the pane. */
type ViewportZoom = 'fit' | number;

/** Which rows the console shows. 'log' means "everything that isn't an issue". */
type ConsoleFilter = 'all' | 'error' | 'warn' | 'log';
type PreviewThemeMode = 'system' | 'light' | 'dark';

const DEFAULT_VIEWPORT = findPreset(DEFAULT_PHONE_PRESET) ?? VIEWPORT_PRESETS[0];

/** How close to the bottom the console must be scrolled to keep auto-following. */
const CONSOLE_STICK_SLACK = 24;

type PreviewConsoleLog = {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  url?: string;
  timestamp: string;
};

type TabLoadState = { isLoading: boolean; slowLoad: boolean; iframeError: boolean };

const DEFAULT_TAB_LOAD_STATE: TabLoadState = {
  isLoading: false,
  slowLoad: false,
  iframeError: false,
};

const commonPorts = [
  3000, 3001, 4173, 4200, 5000, 5173, 6006, 7000, 8000, 8080, 8081, 8888, 9000, 9229, 1234,
];

function transformYouTubeUrl(url: string): string {
  const trimmed = url.trim();
  if (!/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(trimmed)) {
    return url;
  }

  let videoId = '';

  // 1. Check youtu.be/ID
  const youtubeBeMatch = trimmed.match(/youtu\.be\/([^"&?\/\s]{11})/i);
  if (youtubeBeMatch && youtubeBeMatch[1]) {
    videoId = youtubeBeMatch[1];
  }

  // 2. Check youtube.com/shorts/ID
  if (!videoId) {
    const shortsMatch = trimmed.match(/youtube\.com\/shorts\/([^"&?\/\s]{11})/i);
    if (shortsMatch && shortsMatch[1]) {
      videoId = shortsMatch[1];
    }
  }

  // 3. Check youtube.com/live/ID
  if (!videoId) {
    const liveMatch = trimmed.match(/youtube\.com\/live\/([^"&?\/\s]{11})/i);
    if (liveMatch && liveMatch[1]) {
      videoId = liveMatch[1];
    }
  }

  // 4. Check standard v=ID query param
  if (!videoId) {
    const vQueryMatch = trimmed.match(/[?&]v=([^"&?\/\s]{11})/i);
    if (vQueryMatch && vQueryMatch[1]) {
      videoId = vQueryMatch[1];
    }
  }

  // 5. Check paths like /v/ID or /embed/ID or /e/ID
  if (!videoId) {
    const pathMatch = trimmed.match(/(?:\/v\/|\/embed\/|\/e\/)([^"&?\/\s]{11})/i);
    if (pathMatch && pathMatch[1]) {
      videoId = pathMatch[1];
    }
  }

  if (videoId) {
    return `https://www.youtube.com/embed/${videoId}`;
  }

  return url;
}

function normalizeUrl(url: string): string {
  let trimmed = url.trim();
  if (!trimmed) return 'about:blank';
  if (trimmed.toLowerCase() === 'about:blank') return 'about:blank';

  // Auto-transform YouTube watch links to embed format to allow loading in iframe
  trimmed = transformYouTubeUrl(trimmed);

  // If it has a protocol already, return it
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // If it starts with a slash, it's relative to the proxy
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  // Check if it looks like an absolute domain/IP
  const firstSegment = trimmed.split('/')[0];
  const isLocal = /^(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:|\/|$)/i.test(
    firstSegment,
  );
  const hasDot = firstSegment.includes('.');

  if (isLocal) {
    return 'http://' + trimmed;
  } else if (hasDot || firstSegment === 'localhost') {
    return 'https://' + trimmed;
  }

  // Search if it doesn't look like a URL. Use Brave Search's server-rendered
  // results page so the preview gets useful content without depending on a
  // client-side search app or cross-origin result requests.
  return 'https://search.brave.com/search?q=' + encodeURIComponent(trimmed);
}

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isLocalFileBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
      (Boolean(parseLocalFilePreviewUrl(url)) || parsed.pathname.startsWith('/local-file/'));
  } catch { return false; }
}

function parseLocalDevUrl(url: string): { host: string; port: number; path: string } | null {
  try {
    const parsed = new URL(url);
    const isLocalHost =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0';

    if (!isLocalHost || !parsed.port) {
      return null;
    }

    const port = Number(parsed.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return null;
    }

    return {
      host: parsed.hostname,
      port,
      path: `${parsed.pathname}${parsed.search}${parsed.hash}` || '/',
    };
  } catch {
    return null;
  }
}

function isYouTubeUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(url);
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clipCaptureRect(rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>, clip: DOMRectReadOnly) {
  const x = Math.ceil(Math.max(0, rect.left, clip.left));
  const y = Math.ceil(Math.max(0, rect.top, clip.top));
  const right = Math.floor(Math.min(rect.right, clip.right, window.innerWidth));
  const bottom = Math.floor(Math.min(rect.bottom, clip.bottom, window.innerHeight));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function afterPreviewPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function pngBytesToDataUrl(pngBytes: number[]): string {
  const uint8 = new Uint8Array(pngBytes);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}

// Minimal inline inspector that mirrors what the Rust proxy injects,
// used as a direct fallback when the proxy hasn't injected it yet.
function getInspectorScript(): string {
  return `(function(){
  if (window.__forgeInspectorLoaded) return;
  window.__forgeInspectorLoaded = true;
  const state = { enabled: false, hovered: null, selected: null };
  let overlay, label;
  const buildSelector = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel += '#' + node.id; parts.unshift(sel); break; }
      const cls = Array.from(node.classList || []).filter(c => c && !/^(ng-|v-|svelte-)/.test(c)).slice(0,2).join('.');
      if (cls) sel += '.' + cls;
      parts.unshift(sel);
      node = node.parentElement;
      if (parts.length >= 4) break;
    }
    return parts.join(' > ');
  };
  const ensureOverlay = () => {
    if (overlay) return;
    overlay = document.createElement('div');
    Object.assign(overlay.style, { position:'fixed', pointerEvents:'none', zIndex:'2147483646', border:'2px solid var(--accent)', background:'color-mix(in srgb, var(--accent) 12%, transparent)', borderRadius:'4px', boxSizing:'border-box', display:'none' });
    label = document.createElement('div');
    Object.assign(label.style, { position:'fixed', zIndex:'2147483647', padding:'6px 8px', borderRadius:'999px', background:'rgba(16,16,20,0.92)', color:'#fff', font:'12px system-ui,sans-serif', pointerEvents:'none', display:'none' });
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(label);
  };
  const hide = () => { if(overlay) overlay.style.display='none'; if(label) label.style.display='none'; };
  const show = (el) => {
    if (!overlay||!el) return;
    const r = el.getBoundingClientRect();
    if (r.width<2||r.height<2){hide();return;}
    overlay.style.display='block'; overlay.style.left=r.left+'px'; overlay.style.top=r.top+'px'; overlay.style.width=r.width+'px'; overlay.style.height=r.height+'px';
    label.style.display='block'; label.textContent=el.tagName.toLowerCase()+' '+buildSelector(el); label.style.left=Math.max(8,r.left)+'px'; label.style.top=Math.max(8,r.top-30)+'px';
  };
  const setEnabled = (v) => { state.enabled=v; document.documentElement.style.cursor=v?'crosshair':''; if(v)ensureOverlay(); else hide(); };
  document.addEventListener('mousemove', e => { if(!state.enabled)return; show(e.target instanceof Element?e.target:null); }, true);
  document.addEventListener('click', e => {
    if(!state.enabled)return;
    const el = e.target instanceof Element ? e.target : null;
    if(!el)return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);
    state.selected = {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText||el.textContent||'').trim().slice(0,500),
      html: (el.outerHTML||'').slice(0,3000),
      attributes: Object.fromEntries(Array.from(el.attributes||[]).map(a => [a.name, a.value])),
      classes: Array.from(el.classList||[]),
      // Keep this set in step with getStyles() in INSPECTOR_SNIPPET
      // (src-tauri/src/preview/mod.rs) — the prompt formatter reads whichever
      // inspector happened to inject, so a field only one of them sends is a
      // prompt that silently changes shape depending on the page.
      styles: { display:computed.display, position:computed.position, color:computed.color, backgroundColor:computed.backgroundColor, font:computed.font, margin:computed.margin, padding:computed.padding, width:computed.width, height:computed.height },
      page: { url: location.href, title: document.title },
      rect: { x:Math.round(r.x), y:Math.round(r.y), width:Math.round(r.width), height:Math.round(r.height) }
    };
    setEnabled(false);
    parent.postMessage({ type:'forge-inspector:selected', payload:state.selected }, '*');
  }, true);
  window.addEventListener('message', e => {
    if(e.source!==window.parent)return;
    const data = e.data || {};
    if(data.type==='forge-preview:theme'){
      const mode = data.theme==='light' ? 'light' : 'dark';
      const root = document.documentElement;
      root.dataset.spacronPreviewTheme = mode;
      root.classList.toggle('spacron-preview-theme-light', mode === 'light');
      root.classList.toggle('spacron-preview-theme-dark', mode === 'dark');
      root.style.colorScheme = mode;
      root.style.setProperty('--spacron-preview-theme', mode);
      if (document.body) document.body.style.colorScheme = mode;
      (window as Window & { spacronPreviewTheme?: 'light' | 'dark' }).spacronPreviewTheme = mode;
      window.dispatchEvent(new CustomEvent('spacron-preview-theme-change', { detail: { theme: mode } }));
      return;
    }
    if(data.type!=='forge-inspector:set')return;
    setEnabled(Boolean(data.enabled));
  });
  setEnabled(false);
})();`;
}

export default function PreviewPanel() {
  const previewDocked = useLayoutStore((s) => s.previewDocked);
  const tabs = useStore(previewTabs);
  const activeTabId = useStore(activePreviewTabId);
  const currentUrlValue = useStore(currentUrl);
  const port = useStore(targetPort);
  const proxyPortValue = useStore(proxyPort);
  const proxyStartedValue = useStore(proxyStarted);
  const preferredLocalHostValue = useStore(preferredLocalHost);
  const browserPortDefault = useStore(browserDefaultPort);
  const browserZoomDefault = useStore(browserDefaultZoom);
  const browserViewportDefault = useStore(browserDefaultViewport);
  const localDevProxyPortsValue = useStore(localDevProxyPorts);
  const isConnectingValue = useStore(isConnecting);
  const browsingHistoryValue = useStore(browsingHistory);
  const project = useStore(activeProject);
  const appThemeValue = useStore(activeTheme);
  const browserThemeModeValue = useStore(browserThemeMode);

  const iframeElementsRef = useRef<Record<string, HTMLIFrameElement | undefined>>({});
  const previewContentRef = useRef<HTMLDivElement>(null);
  const elementCaptureRef = useRef(0);
  const viewportFrameRef = useRef<HTMLDivElement>(null);
  const consoleBodyRef = useRef<HTMLDivElement>(null);
  const [screenshotting, setScreenshotting] = useState(false);
  const [clearingData, setClearingData] = useState(false);
  // Held as text while typing so the field can be cleared and retyped; it only
  // becomes a port when committed (Enter or blur).
  const [tempPort, setTempPort] = useState(String(port));
  const [inputUrl, setInputUrl] = useState(() => previewAddressBarValue(currentUrlValue));
  const [inspectMode, setInspectMode] = useState(false);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showPreviewThemeMenu, setShowPreviewThemeMenu] = useState(false);
  const [showBrowserToolsMenu, setShowBrowserToolsMenu] = useState(false);
  const [previewThemeMode, setPreviewThemeMode] = useProjectPanelState<PreviewThemeMode>('preview.themeMode', browserThemeModeValue);
  useEffect(() => {
    setPreviewThemeMode(browserThemeModeValue);
  }, [browserThemeModeValue]);

  // Responsive/device mode. The viewport is a plain rectangle of an exact
  // CSS-pixel size (what every browser's responsive mode does) — the page sees a
  // real 390px-wide viewport, so its media queries and vh units behave for real.
  const [deviceMode, setDeviceMode] = useProjectPanelState('preview.deviceMode', false);
  const defaultDeviceSize = browserViewportDefault === 'phone'
    ? (findPreset(DEFAULT_PHONE_PRESET) ?? DEFAULT_VIEWPORT)
    : browserViewportDefault === 'tablet'
      ? (findPreset(DEFAULT_TABLET_PRESET) ?? DEFAULT_VIEWPORT)
      : DEFAULT_VIEWPORT;
  const [viewportSize, setViewportSize] = useProjectPanelState('preview.viewportSize', { width: defaultDeviceSize.width, height: defaultDeviceSize.height });
  const [zoomMode, setZoomMode] = useProjectPanelState<ViewportZoom>('preview.zoomMode', browserZoomDefault === 'fit' ? 'fit' : Number(browserZoomDefault) / 100);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  // Scale is frozen for the duration of a hand-resize: with 'fit' active,
  // re-fitting on every pointer move makes the frame fight the pointer.
  const [dragScale, setDragScale] = useState<number | null>(null);
  // The size boxes are edited as text and committed on Enter/blur; clamping
  // every keystroke turns a half-typed "3" into the 200px minimum.
  const [widthDraft, setWidthDraft] = useState<string | null>(null);
  const [heightDraft, setHeightDraft] = useState<string | null>(null);
  const [viewportPreferencesSeeded, setViewportPreferencesSeeded] = useProjectPanelState('preview.browserDefaultsSeeded', false);
  const [selectedElementInfo, setSelectedElementInfo] = useState<SelectedElementInfo | null>(null);
  const [selectedElementScreenshot, setSelectedElementScreenshot] = useState<string | null>(null);
  const autoScreenshotSetting = useStore(browserDesignModeAutoScreenshot);
  const includeStylesSetting = useStore(browserDesignModeIncludeStyles);
  const includeHtmlSetting = useStore(browserDesignModeIncludeHtml);
  const maxHtmlLengthSetting = useStore(browserDesignModeMaxHtmlLength);
  const consoleAutoOpenSetting = useStore(browserConsoleAutoOpenOnError);
  const preserveConsoleSetting = useStore(browserConsolePreserveLog);
  const globalBrowserTheme = useStore(browserThemeMode);
  const consoleLogs = useStore(previewConsoleLogs);
  const [showConsole, setShowConsole] = useProjectPanelState('preview.showConsole', false);
  const [consoleFilter, setConsoleFilter] = useProjectPanelState<ConsoleFilter>('preview.consoleFilter', 'all');
  const [consoleQuery, setConsoleQuery] = useProjectPanelState('preview.consoleQuery', '');
  const [preserveConsoleLog, setPreserveConsoleLog] = useProjectPanelState('preview.preserveConsoleLog', preserveConsoleSetting);
  useEffect(() => setPreserveConsoleLog(preserveConsoleSetting), [preserveConsoleSetting, setPreserveConsoleLog]);
  const [tabLoadState, setTabLoadState] = useState<Record<string, TabLoadState>>({});

  useEffect(() => {
    if (viewportPreferencesSeeded) return;
    setDeviceMode(browserViewportDefault !== 'desktop');
    if (browserViewportDefault !== 'desktop') setViewportSize({ width: defaultDeviceSize.width, height: defaultDeviceSize.height });
    setZoomMode(browserZoomDefault === 'fit' ? 'fit' : Number(browserZoomDefault) / 100);
    setViewportPreferencesSeeded(true);
  }, [viewportPreferencesSeeded, browserViewportDefault, browserZoomDefault, defaultDeviceSize, setDeviceMode, setViewportSize, setZoomMode, setViewportPreferencesSeeded]);

  const appThemeMode: 'light' | 'dark' =
    appThemeValue?.type ??
    (typeof document !== 'undefined' && document.documentElement.classList.contains('light-theme') ? 'light' : 'dark');
  const effectivePreviewTheme: 'light' | 'dark' =
    previewThemeMode === 'system'
      ? (globalBrowserTheme === 'system' ? appThemeMode : globalBrowserTheme)
      : previewThemeMode;
  const previewThemeLabel = previewThemeMode === 'system' ? `Follow app (${effectivePreviewTheme})` : previewThemeMode;

  // One slow-load timer per tab: a single shared timer meant navigating in one
  // tab cancelled another tab's pending "still loading" feedback.
  const loadFeedbackTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const tabListRef = useAction<HTMLDivElement>(clampHorizontalScroll);

  const activeTab = useMemo(() => (tabs || []).find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);
  const canGoBack = (activeTab?.historyIndex ?? 0) > 0;
  const canGoForward = activeTab ? activeTab.historyIndex < activeTab.history.length - 1 : false;

  // Keep latest mutable snapshots available to stable callbacks without
  // re-creating those callbacks on every render (mirrors the Svelte version's
  // direct closure access to component-scope `let` bindings).
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const inspectModeRef = useRef(inspectMode);
  inspectModeRef.current = inspectMode;
  const proxyPortRef = useRef(proxyPortValue);
  proxyPortRef.current = proxyPortValue;
  const portRef = useRef(port);
  portRef.current = port;

  // Tabs whose current load was driven by us (typed URL, Back/Forward, refresh)
  // rather than by an in-page link click. The next location report for such a tab
  // *replaces* the current history entry (so a server redirect collapses into the
  // entry we drove, like a real browser) instead of pushing a new one.
  const drivenLoadTabsRef = useRef<Set<string>>(new Set());
  const markDrivenLoad = useCallback(() => {
    const id = activeTabRef.current?.id;
    if (id) drivenLoadTabsRef.current.add(id);
  }, []);

  const ensureTabLoadState = useCallback(
    (tabId: string) => tabLoadState[tabId] ?? DEFAULT_TAB_LOAD_STATE,
    [tabLoadState],
  );

  const updateTabLoadState = useCallback((tabId: string, patch: Partial<TabLoadState>) => {
    setTabLoadState((prev) => ({
      ...prev,
      [tabId]: {
        ...(prev[tabId] ?? DEFAULT_TAB_LOAD_STATE),
        ...patch,
      },
    }));
  }, []);

  const getActiveTabLoadState = useCallback((): TabLoadState => {
    const tab = activeTabRef.current;
    return tab ? tabLoadState[tab.id] ?? DEFAULT_TAB_LOAD_STATE : DEFAULT_TAB_LOAD_STATE;
  }, [tabLoadState]);

  const setIframeElement = useCallback((tabId: string, element: HTMLIFrameElement | null) => {
    iframeElementsRef.current = {
      ...iframeElementsRef.current,
      [tabId]: element ?? undefined,
    };
  }, []);

  const getActiveIframeElement = useCallback(() => {
    const tab = activeTabRef.current;
    return tab ? iframeElementsRef.current[tab.id] : undefined;
  }, []);

  const buildLocalProxyUrl = useCallback(
    (path: string, localDev?: { host: string; port: number }) => {
      const proxyPortForPath = localDev
        ? localDevProxyPortsValue[localDevProxyKey(localDev.host, localDev.port)]
        : proxyPortValue;
      if (!proxyPortForPath) return '';
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      return `http://127.0.0.1:${proxyPortForPath}${normalizedPath}`;
    },
    [localDevProxyPortsValue, proxyPortValue],
  );

  const buildExternalProxyUrl = useCallback(
    (url: string) => {
      try {
        const parsed = new URL(url);
        const scheme = parsed.protocol.replace(':', '');
        const authority = parsed.host;
        const path = parsed.pathname || '/';
        const search = parsed.search || '';
        return `http://127.0.0.1:${proxyPortValue}/proxy/${scheme}/${authority}${path}${search}`;
      } catch {
        return `http://127.0.0.1:${proxyPortValue}/proxy?url=${encodeURIComponent(url)}`;
      }
    },
    [proxyPortValue],
  );

  const getLocalDevProxyOrigin = useCallback(
    (localDev: { host: string; port: number }) => {
      const proxyPortForOrigin = localDevProxyPortsValue[localDevProxyKey(localDev.host, localDev.port)];
      return proxyPortForOrigin ? `http://127.0.0.1:${proxyPortForOrigin}` : null;
    },
    [localDevProxyPortsValue],
  );

  const getPreviewTargetOrigin = useCallback(
    (tab: { url: string }): string | null => {
      const normalized = normalizeUrl(tab.url);
      if (normalized === 'about:blank') return null;
      const localDev = isLocalFileBrowserUrl(normalized) ? null : parseLocalDevUrl(normalized);
      if (localDev) return getLocalDevProxyOrigin(localDev);
      return proxyPortRef.current ? `http://127.0.0.1:${proxyPortRef.current}` : null;
    },
    [getLocalDevProxyOrigin],
  );

  const buildIframeSrc = useCallback(
    (url: string) => {
      const norm = normalizeUrl(url);
      if (norm === 'about:blank') {
        return norm;
      }
      // Local file preview URLs — serve directly from the background proxy,
      // bypassing the local dev proxy pipeline (no double-proxying). Rebuild
      // against the *current* proxy port instead of trusting the one embedded
      // in the URL: persisted tabs carry the port from a previous app run, and
      // the proxy binds a fresh ephemeral port each launch. If the proxy isn't
      // up yet, stay blank — PreviewPanel starts it on mount and this re-runs.
      const localFile = parseLocalFilePreviewUrl(norm);
      if (localFile) {
        return proxyPortValue
          ? `http://127.0.0.1:${proxyPortValue}/local-file${localFile.search}`
          : '';
      }
      if (isLocalFileBrowserUrl(norm)) {
        const fileUrl = new URL(norm);
        return proxyPortValue ? `http://127.0.0.1:${proxyPortValue}${fileUrl.pathname}${fileUrl.search}${fileUrl.hash}` : '';
      }
      const localDev = parseLocalDevUrl(norm);
      if (localDev) {
        return buildLocalProxyUrl(localDev.path, localDev);
      }
      // YouTube embeds are more reliable when loaded directly instead of through the local proxy.
      if (isYouTubeUrl(norm) && norm.includes('/embed/')) {
        return norm;
      }
      // External/absolute URLs: always proxy through background server (needed for iframe embedding)
      if (isAbsoluteUrl(norm)) {
        if (proxyPortValue) {
          return buildExternalProxyUrl(norm);
        }
        // Background proxy server not yet ready — show blank
        return '';
      }
      // For local/relative URLs, route directly to the local dev server when dev mode is active.
      if (proxyStartedValue) {
        return buildLocalProxyUrl(norm);
      }
      // Not in dev mode and no external URL — show placeholder
      return '';
    },
    [buildLocalProxyUrl, buildExternalProxyUrl, proxyPortValue, proxyStartedValue],
  );

  // ── Cookie-partition handshake ──────────────────────────────────────────
  //
  // The proxy partitions its cookie jars by the top-level origin the user is on,
  // so a page can never borrow another site's session (see
  // `preview::cookies::PartitionedJars`). We are the only party that knows which
  // navigation is top-level, so we publish it — and we must do so *before* the
  // iframe starts loading, or the document request (and any Set-Cookie on it)
  // lands in the previous site's partition.
  //
  // Hence the handshake: `committedUrl` trails `desiredUrl` by exactly one
  // backend round-trip. The active iframe keeps rendering the previous URL for
  // that instant rather than blanking, so nothing flickers or reloads.
  const desiredUrl = activeTab ? (activeTab.loadUrl ?? activeTab.url) : '';
  const [committedUrl, setCommittedUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Absolute http(s) URLs carry a real origin; about:blank, local-file
      // previews and relative dev-server paths have none and use the default
      // partition.
      let origin: string | null = null;
      try {
        const parsed = new URL(normalizeUrl(desiredUrl));
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          origin = parsed.origin;
        }
      } catch {
        /* not an absolute URL — default partition */
      }
      try {
        await invoke('preview_set_active_origin', { origin });
      } catch (err) {
        // Never strand the preview on a failed IPC: fall through and load. The
        // worst case is a request served from the default partition, which holds
        // no other site's credentials.
        console.error('Failed to set preview cookie partition:', err);
      }
      if (!cancelled) setCommittedUrl(desiredUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [desiredUrl]);

  // Background tabs keep their own URL: their src never changes here, so they
  // are not reloaded by a partition switch. They do share the foreground
  // partition while they are in the background, which can only ever *withhold*
  // their cookies, never hand them someone else's — safe, but it means a
  // background tab's polling requests go out uncredentialed until you focus it.
  // Fully per-tab partitioning needs a per-tab path prefix on the proxy; see the
  // note in cookies.rs.
  const srcForTab = useCallback(
    (tab: { id: string; url: string; loadUrl?: string }) =>
      buildIframeSrc(
        tab.id === activeTabId ? committedUrl || (tab.loadUrl ?? tab.url) : (tab.loadUrl ?? tab.url),
      ),
    [buildIframeSrc, activeTabId, committedUrl],
  );

  const activeIframeSrc = activeTab ? buildIframeSrc(committedUrl || desiredUrl) : '';

  const showYoutubeHomepageWarning =
    !proxyStartedValue &&
    (currentUrlValue.includes('youtube.com') || currentUrlValue.includes('youtu.be')) &&
    !currentUrlValue.includes('/embed/');

  const protocolBadge = useMemo(() => {
    const norm = normalizeUrl(currentUrlValue);
    if (norm.startsWith('https://')) return 'HTTPS';
    if (norm.startsWith('http://')) return 'HTTP';
    return 'DEV';
  }, [currentUrlValue]);

  /** Clear one tab's slow-load timer, or every tab's when called with no id. */
  const clearLoadFeedbackTimer = useCallback((tabId?: string) => {
    const timers = loadFeedbackTimersRef.current;
    for (const id of tabId ? [tabId] : Object.keys(timers)) {
      const timer = timers[id];
      if (timer) {
        clearTimeout(timer);
        delete timers[id];
      }
    }
  }, []);

  const startLoadFeedback = useCallback(
    (tabId: string | undefined = activeTabRef.current?.id) => {
      if (!tabId) return;
      // Browsers drop console output on a document navigation unless "preserve
      // log" is on; without this the panel mixes the old page's errors into the
      // new one's. Only the active tab's output is ever captured, so only its
      // navigations clear.
      if (tabId === activeTabRef.current?.id && !preserveConsoleLogRef.current) {
        clearConsoleLogsStore();
      }
      updateTabLoadState(tabId, { isLoading: true, iframeError: false, slowLoad: false });
      clearLoadFeedbackTimer(tabId);
      loadFeedbackTimersRef.current[tabId] = setTimeout(() => {
        delete loadFeedbackTimersRef.current[tabId];
        setTabLoadState((prev) => {
          const state = prev[tabId] ?? DEFAULT_TAB_LOAD_STATE;
          if (!state.isLoading) return prev;
          return { ...prev, [tabId]: { ...state, slowLoad: true } };
        });
      }, 1800);
    },
    [updateTabLoadState, clearLoadFeedbackTimer],
  );

  useEffect(() => {
    // Back/Forward starts load feedback even when returning to the start
    // screen. That screen has no iframe, so no load event can finish it.
    // Do not clear real page loads that are still waiting for their proxy.
    if (!activeTabId || proxyStartedValue || !normalizeUrl(desiredUrl).startsWith('/')) return;
    clearLoadFeedbackTimer(activeTabId);
    drivenLoadTabsRef.current.delete(activeTabId);
    const state = tabLoadState[activeTabId];
    if (state && (state.isLoading || state.slowLoad || state.iframeError)) {
      updateTabLoadState(activeTabId, { ...DEFAULT_TAB_LOAD_STATE });
    }
  }, [activeTabId, desiredUrl, proxyStartedValue, tabLoadState, clearLoadFeedbackTimer, updateTabLoadState]);

  const handlePortChange = useCallback(() => {
    const next = Number(tempPort);
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      setTargetPort(next);
      setTempPort(String(next));
    } else {
      // Empty or out of range: put the port that is actually in use back.
      setTempPort(String(portRef.current));
    }
  }, [tempPort]);

  const openInBrowser = useCallback(async () => {
    // Get the real URL (not the proxied version)
    const url = currentUrlValue;
    const norm = normalizeUrl(url);
    if (!norm || norm === 'about:blank' || norm === '/') return;
    try {
      await invoke('preview_open_in_browser', { url: norm });
    } catch (err) {
      showToast(`Could not open browser: ${err}`, 'error');
    }
  }, [currentUrlValue]);

  const toggleProxy = useCallback(async () => {
    if (proxyStartedValue) {
      // Stop dev mode — go back to a blank local path so the web panel stays clean
      stopProxy();
      if (!isAbsoluteUrl(currentUrlValue) || parseLocalDevUrl(normalizeUrl(currentUrlValue))) {
        navigatePreviewTab('/');
      }
    } else {
      // Start dev mode — navigate to the root of the local dev server
      await clearProxyTarget();
      await startProxy();
      const host = preferredLocalHostValue || 'localhost';
      await ensureLocalDevProxy(portRef.current, host);
      navigatePreviewTab(`http://${host}:${portRef.current}/`);
    }
  }, [proxyStartedValue, currentUrlValue, preferredLocalHostValue]);

  const autoDetectPort = useCallback(async () => {
    const projectPath = project?.root_path;
    if (!projectPath) {
      showToast('No active project. Open a project folder first.', 'info');
      return;
    }
    try {
      const detected = await invoke<number>('workspace_detect_port', { path: projectPath, fallbackPort: browserPortDefault });
      await setTargetPort(detected);
    } catch {
      showToast('Could not detect dev server port', 'error');
    }
  }, [project, browserPortDefault]);

  const navigateTo = useCallback(
    async (rawUrl: string) => {
      const normalized = normalizeUrl(rawUrl);
      const localDev = parseLocalDevUrl(normalized);
      if (localDev) {
        await clearProxyTarget();
        await setPreferredLocalHost(localDev.host);
        await ensureLocalDevProxy(localDev.port, localDev.host);
        if (portRef.current !== localDev.port) {
          await setTargetPort(localDev.port);
        }
      } else {
        await setPreferredLocalHost(null);
        // Ensure the background proxy is running BEFORE updating the store and
        // triggering the iframe src binding, so buildIframeSrc sees the port set.
        await ensureProxyRunning();
      }
      markDrivenLoad();
      navigatePreviewTab(normalized);
      setInputUrl(previewAddressBarValue(normalized));
      startLoadFeedback();
    },
    [startLoadFeedback, markDrivenLoad],
  );

  const handleNavigate = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void navigateTo(inputUrl);
    },
    [navigateTo, inputUrl],
  );

  const openHistoryEntry = useCallback(
    (url: string) => {
      setShowHistory(false);
      void navigateTo(url);
    },
    [navigateTo],
  );

  const goBack = useCallback(() => {
    if (!canGoBack) return;
    markDrivenLoad();
    goBackPreviewTab();
    // The address bar is mirrored from `currentUrlValue` by the sync effect
    // below; setting it here is redundant (and previously wrote the store
    // object itself into the field).
    startLoadFeedback();
  }, [canGoBack, startLoadFeedback, markDrivenLoad]);

  const goForward = useCallback(() => {
    if (!canGoForward) return;
    markDrivenLoad();
    goForwardPreviewTab();
    startLoadFeedback();
  }, [canGoForward, startLoadFeedback, markDrivenLoad]);

  const refresh = useCallback(() => {
    const activeIframe = getActiveIframeElement();
    if (activeIframe) {
      markDrivenLoad();
      startLoadFeedback(activeTabRef.current?.id);
      activeIframe.src = activeIframe.src;
    }
  }, [getActiveIframeElement, startLoadFeedback, markDrivenLoad]);

  const hardReload = useCallback(() => {
    const activeIframe = getActiveIframeElement();
    if (!activeIframe) return;
    markDrivenLoad();
    startLoadFeedback(activeTabRef.current?.id);
    try {
      const frameWindow = activeIframe.contentWindow;
      if (frameWindow) {
        frameWindow.location.reload();
        return;
      }
    } catch {
      // Cross-origin pages fall back to reloading the iframe URL below.
    }
    const url = new URL(activeIframe.src);
    url.searchParams.set('__spacron_hard_reload', String(Date.now()));
    activeIframe.src = url.toString();
  }, [getActiveIframeElement, startLoadFeedback, markDrivenLoad]);

  const clearBrowsingData = useCallback(async () => {
    if (clearingData) return;
    setClearingData(true);
    try {
      const ok = await clearPreviewData();
      // Reload so the cleared cookies/cache take effect immediately and the page
      // re-authenticates with a fresh session.
      if (ok) refresh();
    } finally {
      setClearingData(false);
    }
  }, [clearingData, refresh]);

  const postInspectorState = useCallback(() => {
    const activeIframe = getActiveIframeElement();
    if (!activeIframe?.contentWindow) return;
    const tab = activeTabRef.current;
    if (!tab) return;
    const targetOrigin = getPreviewTargetOrigin(tab);
    if (!targetOrigin) return;
    // Include parentOrigin so the iframe script can use it as the postMessage target
    // when replying, avoiding the need for '*' in the reverse direction.
    activeIframe.contentWindow.postMessage(
      { type: 'forge-inspector:set', enabled: inspectModeRef.current, parentOrigin: window.location.origin },
      targetOrigin,
    );
  }, [getActiveIframeElement, getPreviewTargetOrigin]);

  const postPreviewTheme = useCallback(
    (tabId?: string) => {
      const id = tabId ?? activeTabRef.current?.id;
      const tab = (tabsRef.current || []).find((item) => item.id === id);
      const iframe = id ? iframeElementsRef.current[id] : undefined;
      if (!tab || !iframe?.contentWindow) return;
      const targetOrigin = getPreviewTargetOrigin(tab);
      if (!targetOrigin) return;
      iframe.contentWindow.postMessage(
        {
          type: 'forge-preview:theme',
          theme: effectivePreviewTheme,
          parentOrigin: window.location.origin,
        },
        targetOrigin,
      );
    },
    [effectivePreviewTheme, getPreviewTargetOrigin],
  );

  useEffect(() => {
    for (const tab of tabs || []) postPreviewTheme(tab.id);
  }, [tabs, postPreviewTheme]);

  const toggleAnnotateMode = useCallback(() => {
    elementCaptureRef.current += 1;
    setAnnotateMode((prev) => {
      const next = !prev;
      if (next && inspectModeRef.current) {
        setInspectMode(false);
        inspectModeRef.current = false;
        postInspectorState();
      }
      return next;
    });
  }, [postInspectorState]);

  const toggleInspectMode = useCallback(() => {
    elementCaptureRef.current += 1;
    const next = !inspectModeRef.current;
    inspectModeRef.current = next;
    setInspectMode(next);
    setSelectedElementInfo(null);
    setSelectedElementScreenshot(null);
    if (next) {
      setAnnotateMode(false);
      void ensureProxyRunning();
    }
    postInspectorState();
  }, [postInspectorState]);

  // Alt+D shortcut to toggle Design Mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'd') {
        const active = document.activeElement;
        const inInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
        if (!inInput) {
          e.preventDefault();
          toggleInspectMode();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleInspectMode]);

  const revealPromptBar = useCallback(() => {
    // The floating prompt bar overlays every aux view, so just focus it.
    // We must NOT switch to the terminal view here: that hides the preview
    // panel the user is actively inspecting (e.g. right after "Add Element
    // to Chat"), which looked like the preview closing unexpectedly.
    requestAnimationFrame(() => focusPromptBar());
  }, []);

  const addImageToPrompt = useCallback((dataUrl: string, name: string) => {
    promptBarImage.set({ dataUrl, name });
  }, []);

  // Captures a screenshot of the selected element's bounding box.
  // Returns a data URL string, or null if capture fails.
  const captureElementScreenshot = useCallback(
    async (info: SelectedElementInfo): Promise<string | null> => {
      try {
        // Find the iframe that is showing the active tab
        const activeIframe = getActiveIframeElement();
        if (!activeIframe) return null;

        const iframeRect = activeIframe.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;

        // In device mode the frame is CSS-scaled to fit the pane, so a rect the
        // page reports in its own pixels is not the size it occupies on screen.
        // getBoundingClientRect() is post-transform while offsetWidth is not, so
        // their ratio is exactly the applied scale (1 outside device mode).
        const frameScale = activeIframe.offsetWidth > 0 ? iframeRect.width / activeIframe.offsetWidth : 1;

        // The element rect from the inspector is relative to the iframe's viewport.
        // Offset it by the iframe's position on screen to get absolute screen coords.
        const left = iframeRect.left + info.rect.x * frameScale;
        const top = iframeRect.top + info.rect.y * frameScale;
        const clip = previewContentRef.current?.getBoundingClientRect() ?? iframeRect;
        const crop = clipCaptureRect({
          left: Math.max(iframeRect.left, left),
          top: Math.max(iframeRect.top, top),
          right: Math.min(iframeRect.right, left + info.rect.width * frameScale),
          bottom: Math.min(iframeRect.bottom, top + info.rect.height * frameScale),
        }, clip);
        if (!crop) return null;
        const pngBytes = await invoke<number[]>('preview_capture_screenshot', {
          ...crop,
          scale,
        });

        // Convert raw PNG bytes → base64 data URL
        return pngBytesToDataUrl(pngBytes);
      } catch {
        return null;
      }
    },
    [getActiveIframeElement],
  );

  const captureViewportScreenshot = useCallback(async () => {
    try {
      const target = getActiveIframeElement();
      const frame = viewportFrameRef.current?.getBoundingClientRect();
      if (!target || !frame || !frame.width || !frame.height) return null;
      const rect = target.getBoundingClientRect();
      const crop = clipCaptureRect(rect, previewContentRef.current?.getBoundingClientRect() ?? rect);
      if (!crop) return null;
      const pngBytes = await invoke<number[]>('preview_capture_screenshot', { ...crop, scale: window.devicePixelRatio || 1 });
      return {
        dataUrl: pngBytesToDataUrl(pngBytes),
        // The annotation canvas covers the full viewport even when its frame is clipped.
        x: (crop.x - frame.left) / frame.width,
        y: (crop.y - frame.top) / frame.height,
        width: crop.width / frame.width,
        height: crop.height / frame.height,
      };
    } catch {
      return null;
    }
  }, [getActiveIframeElement]);

  const addElementToAgent = useCallback((info: SelectedElementInfo) => {
    const text = buildElementPrompt(info, {
      includeStyles: includeStylesSetting,
      includeHtml: includeHtmlSetting,
      maxHtml: maxHtmlLengthSetting,
    }).trim();
    const sessionId = getActiveAgentSessionId();
    if (!text) return;
    if (sessionId === null) {
      showToast('No active agent input is available', 'warning');
      return;
    }

    // This deliberately sends only text to the focused agent's xterm input.
    // It does not submit the message, create a screenshot attachment, or stage
    // anything in the voice-only floating prompt bar.
    requestTerminalInput(sessionId, text);
    setSelectedElementInfo(null);
    showToast('Element added to the active agent input', 'success');
  }, [includeStylesSetting, includeHtmlSetting, maxHtmlLengthSetting]);

  const handleIframeLoad = useCallback(
    (tabId: string) => {
      // `iframeError` is deliberately not cleared here: a proxy error page is a
      // served 200-ish body, so it fires `load` like any other page. It is
      // cleared when a new load starts (startLoadFeedback) and when a page
      // reports its own location, which an error page never does.
      updateTabLoadState(tabId, { isLoading: false, slowLoad: false });
      clearLoadFeedbackTimer(tabId);

      // Everything else this handler could want — the page's real URL, its
      // scroll offset, its media position — has to arrive by postMessage. The
      // iframe is served from the loopback proxy while the app shell runs on
      // tauri.localhost, so touching `contentWindow.location`/`contentDocument`
      // throws SecurityError. See handleInspectorMessage for the live paths.
      if (activeTabRef.current?.id === tabId) {
        postInspectorState();
      }
      postPreviewTheme(tabId);
    },
    [updateTabLoadState, clearLoadFeedbackTimer, postInspectorState, postPreviewTheme],
  );

  const handleIframeError = useCallback(
    (tabId: string) => {
      clearLoadFeedbackTimer(tabId);
      drivenLoadTabsRef.current.delete(tabId);
      updateTabLoadState(tabId, { isLoading: false, slowLoad: false, iframeError: true });
    },
    [clearLoadFeedbackTimer, updateTabLoadState],
  );

  // Which loopback origin a given tab's page is legitimately served from: its
  // own local dev proxy when the tab points at a dev server, otherwise the
  // shared background proxy. Every inbound postMessage is checked against this.
  const expectedOriginForTab = useCallback(
    (tabId: string): string | null => {
      const sourceTab = (tabsRef.current || []).find((t) => t.id === tabId);
      const sourceLocalDev = sourceTab && !isLocalFileBrowserUrl(normalizeUrl(sourceTab.url)) ? parseLocalDevUrl(normalizeUrl(sourceTab.url)) : null;
      if (sourceLocalDev) return getLocalDevProxyOrigin(sourceLocalDev);
      return proxyPortRef.current ? `http://127.0.0.1:${proxyPortRef.current}` : null;
    },
    [getLocalDevProxyOrigin],
  );

  useEffect(() => registerPreviewBrowser(async (action, signal) => {
    signal.throwIfAborted();
    const tab = activeTabRef.current;
    const frame = tab && iframeElementsRef.current[tab.id]?.contentWindow;
    const origin = tab && expectedOriginForTab(tab.id);
    if (!tab || !frame || !origin) throw new Error('Open a page in Preview first.');

    return new Promise<string>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener('message', receive);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const receive = (event: MessageEvent) => {
        if (event.source !== frame || event.origin !== origin) return;
        const data = event.data;
        if (data?.type !== 'forge-preview:agent-result' || data.requestId !== requestId || typeof data.output !== 'string') return;
        cleanup();
        const current = activeTabRef.current;
        if (action.action === 'snapshot' && (current?.id !== tab.id || current.url !== tab.url)) {
          reject(new Error('The active Preview page changed. Try again.'));
        } else {
          resolve(action.action === 'snapshot'
            ? `URL: ${tab.url}\n${data.output.slice(0, 16_000)}`
            : data.output.slice(0, 16_000));
        }
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Preview did not respond. Wait for the page to finish loading and try again.'));
      }, 4000);
      window.addEventListener('message', receive);
      signal.addEventListener('abort', abort, { once: true });
      frame.postMessage({ ...action, type: 'forge-preview:agent', requestId }, origin);
    });
  }), [expectedOriginForTab]);

  const handleInspectorMessage = useCallback(
    (event: MessageEvent) => {
      if (!event.data) return;

      // Identify which iframe sent the message
      const sourceTabId = Object.entries(iframeElementsRef.current).find(
        ([, iframe]) => iframe?.contentWindow === event.source,
      )?.[0];

      // Editable-page bridge: the proxied document owns its inputs, so it
      // reports focus and performs insertion through postMessage. Validate the
      // proxy origin before exposing either event to the transcription service.
      if (event.data.type === 'forge-preview:focus') {
        if (!sourceTabId) return;
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
        if (activeTabRef.current?.id !== sourceTabId) return;
        const iframe = iframeElementsRef.current[sourceTabId];
        if (!iframe) return;
        window.dispatchEvent(
          new CustomEvent('spacron-preview-focus', {
            detail: {
              iframe,
              origin: expectedOrigin,
              editable: Boolean(event.data.editable),
            },
          }),
        );
        return;
      }

      if (event.data.type === 'forge-preview:insert-text-result') {
        if (!sourceTabId) return;
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
        const iframe = iframeElementsRef.current[sourceTabId];
        if (!iframe) return;
        window.dispatchEvent(
          new CustomEvent('spacron-preview-insert-text-result', {
            detail: {
              iframe,
              origin: expectedOrigin,
              requestId: event.data.requestId,
              ok: Boolean(event.data.ok),
            },
          }),
        );
        return;
      }

      // Address-bar / history bridge: external pages (served from the background
      // proxy) post their real URL on every load and in-page history change.
      // Because the iframe is cross-origin to the app shell, this postMessage is
      // the only reliable way to keep the address bar and Back/Forward in sync
      // with where the page has actually navigated.
      if (event.data.type === 'forge-preview:location') {
        if (!sourceTabId) return;
        // Local dev pages report through their own dev proxy origin, external
        // pages through the shared one — both are legitimate here.
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
        const reported = typeof event.data.url === 'string' ? event.data.url : '';
        if (!/^https?:\/\//i.test(reported)) return;
        // Only the active tab owns the visible address bar.
        if (activeTabRef.current?.id !== sourceTabId) return;
        // A link click or form submit inside the page moved the top-level
        // document to a new origin, so the cookie partition has to follow it —
        // otherwise the new site's own requests would keep resolving against the
        // origin the user arrived from. This runs after the document has loaded
        // (that is the earliest the page can report itself), so it corrects the
        // partition for everything the page does from here on. Only the
        // top-level frame reaches this handler: a nested iframe's `event.source`
        // does not match any tab's `contentWindow`, so `sourceTabId` is undefined
        // above and we have already returned — which is what keeps a framed
        // victim from claiming the partition.
        try {
          const reportedOrigin = new URL(reported).origin;
          void invoke('preview_set_active_origin', { origin: reportedOrigin }).catch((err) =>
            console.error('Failed to update preview cookie partition:', err),
          );
        } catch {
          /* unparseable URL — leave the partition as it is */
        }

        // A page that can report itself is a page that loaded, so retire any
        // error banner left over from a previous failed load of this tab.
        updateTabLoadState(sourceTabId, { iframeError: false });

        const wasDriven = drivenLoadTabsRef.current.delete(sourceTabId);
        if (reported === activeTabRef.current?.url) return; // already accurate
        if (wasDriven) {
          // A load we initiated (typed URL, Back/Forward, refresh) landed on a
          // redirected URL — collapse it into the current entry instead of
          // pushing a duplicate, the way a real browser hides redirect sources.
          replaceCurrentNavigation(reported);
        } else {
          // An in-page navigation (clicked link / submitted form) — push a new
          // history entry so Back returns to the page the user came from.
          commitInternalNavigation(reported);
        }
        setInputUrl(previewAddressBarValue(reported));
        return;
      }

      // Scroll-position bridge: the iframe is cross-origin, so the page itself
      // reports its scroll offset (and asks to have it restored on load) via the
      // proxy origin, which we validate the same way as console/inspector traffic.
      if (event.data.type === 'forge-preview:scroll' || event.data.type === 'forge-preview:scroll-ready') {
        if (!sourceTabId) return;
        const sourceTab = (tabsRef.current || []).find((t) => t.id === sourceTabId);
        if (!sourceTab) return;
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;

        if (event.data.type === 'forge-preview:scroll') {
          saveScrollPosition(sourceTab.url, {
            x: Number(event.data.x) || 0,
            y: Number(event.data.y) || 0,
          });
        } else {
          // Page is ready — restore its last known scroll position, if any.
          const saved = getScrollPosition(sourceTab.url);
          if (saved && (saved.x !== 0 || saved.y !== 0)) {
            iframeElementsRef.current[sourceTabId]?.contentWindow?.postMessage(
              { type: 'forge-preview:scroll-restore', x: saved.x, y: saved.y },
              expectedOrigin,
            );
          }
        }
        return;
      }

      // Console log events: only accept from our proxy origin
      if (event.data.type === 'forge-preview:console') {
        if (!sourceTabId) return;
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
        const payload = event.data.payload || {};
        const level = ['log', 'info', 'warn', 'error', 'debug'].includes(payload.level) ? payload.level : 'log';
        if (activeTabRef.current?.id === sourceTabId) {
          pushConsoleLog({
            level,
            message: String(payload.message || ''),
            url: payload.url,
            timestamp: payload.timestamp || new Date().toISOString(),
          });
          if (level === 'error' && consoleAutoOpenSetting) {
            setShowConsole(true);
          }
        }
        // Deliberately no auto-open: a single warning used to yank the console
        // panel back over the page every time, even right after the user closed
        // it. The toolbar button carries an error/warning badge instead, which
        // is what a browser does.
        return;
      }

      // Media playback bridge: the page reports its <video>/<audio> position and
      // asks for it back after a reload. This used to be done by polling
      // `iframe.contentDocument` from here, which silently threw on every tick —
      // the iframe is cross-origin to the app shell.
      if (event.data.type === 'forge-preview:media' || event.data.type === 'forge-preview:media-ready') {
        if (!sourceTabId) return;
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;

        if (event.data.type === 'forge-preview:media') {
          const currentTime = Number(event.data.currentTime) || 0;
          const paused = Boolean(event.data.paused);
          previewTabs.update((list) =>
            list.map((tab) =>
              tab.id === sourceTabId ? { ...tab, mediaPlaybackState: { currentTime, paused } } : tab,
            ),
          );
        } else {
          const saved = (tabsRef.current || []).find((t) => t.id === sourceTabId)?.mediaPlaybackState;
          if (saved) {
            iframeElementsRef.current[sourceTabId]?.contentWindow?.postMessage(
              { type: 'forge-preview:media-restore', currentTime: saved.currentTime, paused: saved.paused },
              expectedOrigin,
            );
          }
        }
        return;
      }

      // The proxy's own error page announcing that it could not reach the target.
      // An iframe fires `load`, not `error`, for a served error body, so this is
      // the only signal that distinguishes a failure from a real page.
      if (event.data.type === 'forge-preview:error') {
        if (!sourceTabId) return;
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
        clearLoadFeedbackTimer(sourceTabId);
        drivenLoadTabsRef.current.delete(sourceTabId);
        updateTabLoadState(sourceTabId, { isLoading: false, slowLoad: false, iframeError: true });
        return;
      }

      // Inspector selections must come from the active proxied iframe.
      if (event.data.type !== 'forge-inspector:selected') return;
      if (!inspectModeRef.current || sourceTabId !== get(activePreviewTabId)) return;
      if (!sourceTabId) return;
      {
        const expectedOrigin = expectedOriginForTab(sourceTabId);
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
      }
      const info = event.data.payload;
      const captureId = ++elementCaptureRef.current;
      setSelectedElementScreenshot(null);
      setInspectMode(false);
      inspectModeRef.current = false;
      postInspectorState();
      if (!autoScreenshotSetting) {
        setSelectedElementInfo(info);
        return;
      }
      // Let the page paint with the inspector highlight removed before capture.
      // Keep the dialog off the page until the screenshot has been acquired.
      void afterPreviewPaint().then(async () => {
        if (elementCaptureRef.current !== captureId || get(activePreviewTabId) !== sourceTabId) return;
        const dataUrl = await captureElementScreenshot(info);
        if (elementCaptureRef.current !== captureId || get(activePreviewTabId) !== sourceTabId) return;
        setSelectedElementScreenshot(dataUrl);
        setSelectedElementInfo(info);
      });
    },
    [expectedOriginForTab, postInspectorState, autoScreenshotSetting, captureElementScreenshot, updateTabLoadState, clearLoadFeedbackTimer],
  );

  const handleInputKeydown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setInputUrl(previewAddressBarValue(currentUrlValue));
        (e.target as HTMLInputElement).blur();
      }
    },
    [currentUrlValue],
  );

  const clearConsoleLogs = useCallback(() => {
    clearConsoleLogsStore();
  }, []);

  const copyConsoleText = useCallback(async (text: string, done: string) => {
    try {
      await copyTextToClipboard(text);
      showToast(done, 'success');
    } catch {
      showToast('Could not copy to clipboard', 'error');
    }
  }, []);

  const takeScreenshot = useCallback(async () => {
    if (screenshotting) return;
    const target = deviceMode ? viewportFrameRef.current : previewContentRef.current;
    if (!target) return;
    setScreenshotting(true);
    try {
      const rect = target.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;

      const pngBytes = await invoke<number[]>('preview_capture_screenshot', {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scale,
      });

      const dataUrl = pngBytesToDataUrl(pngBytes);
      const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });

      try {
        await copyPngToClipboard(pngBytes);
        showToast('Screenshot copied to clipboard', 'success');
      } catch {
        const label = deviceMode ? `${viewportSize.width}x${viewportSize.height}` : 'preview';
        const name = `spacron-${label}-${Date.now()}.png`;
        try {
          const link = document.createElement('a');
          link.download = name;
          link.href = URL.createObjectURL(blob);
          link.click();
          URL.revokeObjectURL(link.href);
          showToast('Screenshot saved as PNG', 'success');
        } catch {
          addImageToPrompt(dataUrl, name);
          revealPromptBar();
          showToast('Screenshot added to prompt bar', 'success');
        }
      }
    } catch {
      showToast('Screenshot failed', 'error');
    } finally {
      setScreenshotting(false);
    }
  }, [screenshotting, deviceMode, viewportSize, addImageToPrompt, revealPromptBar]);


  // -------------------------------------------------------------------------
  // Responsive viewport
  //
  // Modelled on Chrome/Edge device mode, Firefox's Responsive Design Mode and
  // Safari's: pick a size (or drag the edges) and the page is rendered into a
  // bare rectangle of exactly that many CSS pixels, scaled to fit the pane when
  // it does not fit. There is no device chassis - a bezel only steals room from
  // the frame, and nothing inside the page can observe it.
  // -------------------------------------------------------------------------

  const activePreset = useMemo(
    () => matchPreset(viewportSize.width, viewportSize.height),
    [viewportSize],
  );
  const presetValue = activePreset?.id ?? CUSTOM_PRESET_ID;

  const presetOptions = useMemo<DropdownOption[]>(() => {
    const options: DropdownOption[] = VIEWPORT_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.label,
      sublabel: `${preset.width} x ${preset.height}`,
    }));
    if (!activePreset) {
      options.unshift({
        value: CUSTOM_PRESET_ID,
        label: 'Custom',
        sublabel: `${viewportSize.width} x ${viewportSize.height}`,
      });
    }
    return options;
  }, [activePreset, viewportSize]);

  const zoomOptions = useMemo<DropdownOption[]>(
    () => [
      { value: 'fit', label: 'Fit' },
      ...ZOOM_LEVELS.map((level) => ({ value: String(level), label: `${Math.round(level * 100)}%` })),
    ],
    [],
  );

  /** Apply a preset, keeping the orientation the user is currently in. */
  const applyPreset = useCallback(
    (id: string) => {
      const preset = findPreset(id);
      if (!preset) return;
      const landscape = viewportSize.width > viewportSize.height;
      setViewportSize(
        landscape
          ? { width: preset.height, height: preset.width }
          : { width: preset.width, height: preset.height },
      );
      setDeviceMode(true);
    },
    [viewportSize],
  );

  const setViewportEdge = useCallback((edge: 'width' | 'height', raw: number) => {
    const value = clampViewportEdge(raw);
    setViewportSize((prev) => (prev[edge] === value ? prev : { ...prev, [edge]: value }));
  }, []);

  /** Phone/tablet quick-pick. Clicking the category you are already in exits,
   *  the way a browser's device-mode button toggles. */
  const chooseViewportCategory = useCallback(
    (category: 'phone' | 'tablet') => {
      if (deviceMode && activePreset?.category === category) {
        setDeviceMode(false);
        return;
      }
      applyPreset(category === 'phone' ? DEFAULT_PHONE_PRESET : DEFAULT_TABLET_PRESET);
    },
    [deviceMode, activePreset, applyPreset],
  );

  const commitSizeDraft = useCallback(
    (edge: 'width' | 'height', draft: string | null) => {
      if (draft === null) return;
      const parsed = Number(draft);
      if (Number.isFinite(parsed) && parsed > 0) setViewportEdge(edge, parsed);
      if (edge === 'width') setWidthDraft(null);
      else setHeightDraft(null);
    },
    [setViewportEdge],
  );

  const rotateViewport = useCallback(() => {
    setViewportSize((prev) => ({ width: prev.height, height: prev.width }));
  }, []);

  // Auto-fit: the largest scale (never above 1:1) that keeps the whole frame in
  // the pane. Driven by a ResizeObserver so splitting or resizing the panel
  // re-fits without reloading the page.
  const fitScale = useMemo(() => {
    if (!deviceMode || stageSize.width <= 0 || stageSize.height <= 0) return 1;
    return Math.min(1, stageSize.width / viewportSize.width, stageSize.height / viewportSize.height);
  }, [deviceMode, stageSize, viewportSize]);

  const viewportScale = dragScale ?? (zoomMode === 'fit' ? fitScale : zoomMode);

  // Fixed stage padding is useful while a viewport fits, but it becomes real
  // scrollable content once the viewport is larger than the pane. Remove it
  // on only the overflowing axes so the first and last page pixels can sit on
  // the pane edges instead of leaving an unreachable/empty gutter.
  const viewportOverflowsX = deviceMode && viewportSize.width * viewportScale > stageSize.width;
  const viewportOverflowsY = deviceMode && viewportSize.height * viewportScale > stageSize.height;

  useEffect(() => {
    if (!stageEl) return;
    const measure = () => {
      // clientWidth/Height include padding, and the stage is padded so the drag
      // handles have room to sit outside the frame. Fitting against the padded
      // box would let the frame overhang by exactly that padding.
      const style = window.getComputedStyle(stageEl);
      const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
      const padY = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
      setStageSize({
        width: Math.max(0, stageEl.clientWidth - padX),
        height: Math.max(0, stageEl.clientHeight - padY),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stageEl);
    return () => observer.disconnect();
  }, [stageEl]);

  // Edge/corner drag, in the page's own pixels: the pointer moves in screen
  // pixels, so the delta is divided by the scale the frame is drawn at.
  const resizeDragRef = useRef<{
    axis: 'x' | 'y' | 'xy';
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    scale: number;
  } | null>(null);
  const [resizingViewport, setResizingViewport] = useState(false);

  const beginViewportResize = useCallback(
    (axis: 'x' | 'y' | 'xy') => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeDragRef.current = {
        axis,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: viewportSize.width,
        startHeight: viewportSize.height,
        scale: viewportScale || 1,
      };
      // Freeze the scale for the drag: with Fit active, re-fitting on every
      // pointer move makes the frame fight the pointer instead of following it.
      setDragScale(viewportScale || 1);
      setResizingViewport(true);
    },
    [viewportSize, viewportScale],
  );

  const handleViewportResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    const next = { width: drag.startWidth, height: drag.startHeight };
    if (drag.axis !== 'y') {
      next.width = clampViewportEdge(drag.startWidth + (event.clientX - drag.startX) / drag.scale);
    }
    if (drag.axis !== 'x') {
      next.height = clampViewportEdge(drag.startHeight + (event.clientY - drag.startY) / drag.scale);
    }
    setViewportSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
  }, []);

  const endViewportResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    setResizingViewport(false);
    // Release the frozen scale so Fit re-fits to whatever size we ended on.
    setDragScale(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // -- Console ---------------------------------------------------------------

  const consoleCounts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const log of consoleLogs) {
      if (log.level === 'error') errors += log.count;
      else if (log.level === 'warn') warnings += log.count;
    }
    return { errors, warnings };
  }, [consoleLogs]);

  const filteredConsoleLogs = useMemo(() => {
    const query = consoleQuery.trim().toLowerCase();
    return consoleLogs.filter((log) => {
      if (consoleFilter === 'error' && log.level !== 'error') return false;
      if (consoleFilter === 'warn' && log.level !== 'warn') return false;
      if (consoleFilter === 'log' && (log.level === 'error' || log.level === 'warn')) return false;
      if (query && !log.message.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [consoleLogs, consoleFilter, consoleQuery]);

  // Follow new output while the user is at the bottom; scrolling up to read
  // something pins the view there, exactly like a browser console.
  const consoleStickRef = useRef(true);
  const handleConsoleScroll = useCallback(() => {
    const el = consoleBodyRef.current;
    if (!el) return;
    consoleStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= CONSOLE_STICK_SLACK;
  }, []);

  useEffect(() => {
    if (!showConsole) return;
    const el = consoleBodyRef.current;
    if (!el || !consoleStickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filteredConsoleLogs, showConsole]);

  const preserveConsoleLogRef = useRef(preserveConsoleLog);
  useEffect(() => {
    preserveConsoleLogRef.current = preserveConsoleLog;
  }, [preserveConsoleLog]);

  const openNewTab = useCallback(() => {
    createPreviewBrowserTab('/');
    setInputUrl('');
  }, []);

  const activateTab = useCallback((tabId: string) => {
    if (tabId === activeTabRef.current?.id) return;
    elementCaptureRef.current += 1;
    selectPreviewBrowserTab(tabId);
    setSelectedElementInfo(null);
    // Only the active tab's output is captured, so anything still on screen
    // belongs to the tab being left.
    clearConsoleLogsStore();
  }, []);

  const closeTab = useCallback((event: React.MouseEvent, tabId: string) => {
    event.stopPropagation();
    closePreviewBrowserTab(tabId);
  }, []);

  const handleCloseTabKeydown = useCallback((event: React.KeyboardEvent, tabId: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    closePreviewBrowserTab(tabId);
  }, []);

  // Sync the address bar whenever the active tab/current URL changes from a
  // store-driven action (activateTab/closeTab call store setters that update
  // currentUrl, which this mirrors back into the local inputUrl field).
  useEffect(() => {
    setInputUrl(previewAddressBarValue(currentUrlValue));
  }, [currentUrlValue]);

  // onMount
  useEffect(() => {
    let unsubscribePort: () => void;
    let unsubscribeUrl: () => void;

    (async () => {
      await loadProxyState();
      setTempPort(String(portRef.current));
      // Always silently ensure the background proxy server is running.
      // This is needed for both external web browsing AND local dev proxying.
      // We do NOT auto-start proxyStarted (dev mode) — user can toggle that manually.
      await ensureProxyRunning();

      unsubscribePort = targetPort.subscribe((val) => {
        setTempPort(String(val));
      });

      unsubscribeUrl = currentUrl.subscribe((val) => {
        setInputUrl(previewAddressBarValue(val));
      });
    })();

    return () => {
      unsubscribePort?.();
      unsubscribeUrl?.();
      clearLoadFeedbackTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The iframe bridge (console, scroll, address bar, inspector) must be
  // re-registered whenever handleInspectorMessage changes. It closes over
  // `localDevProxyPortsValue`, which is empty on the first render and only
  // fills in once a local dev proxy has been started — pinning the listener to
  // the mount-time closure made every local-dev message fail its origin check,
  // so console output, scroll restore and element picking silently did nothing
  // until the panel happened to remount.
  useEffect(() => {
    window.addEventListener('message', handleInspectorMessage);
    return () => window.removeEventListener('message', handleInspectorMessage);
  }, [handleInspectorMessage]);

  // Window click handler for dismissing history popup
  useEffect(() => {
    const handleWindowClickForHistory = (e: MouseEvent) => {
      if (!showHistory) return;
      const target = e.target as HTMLElement;
      if (!target.closest('.history-wrap')) setShowHistory(false);
    };
    window.addEventListener('click', handleWindowClickForHistory);
    return () => window.removeEventListener('click', handleWindowClickForHistory);
  }, [showHistory]);

  useEffect(() => {
    const handleWindowClickForPreviewTheme = (e: MouseEvent) => {
      if (!showPreviewThemeMenu) return;
      const target = e.target as HTMLElement;
      if (!target.closest('.preview-theme-wrap')) setShowPreviewThemeMenu(false);
    };
    window.addEventListener('click', handleWindowClickForPreviewTheme);
    return () => window.removeEventListener('click', handleWindowClickForPreviewTheme);
  }, [showPreviewThemeMenu]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!showBrowserToolsMenu) return;
      if (!(event.target instanceof Element) || !event.target.closest('.browser-tools-wrap')) setShowBrowserToolsMenu(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [showBrowserToolsMenu]);

  // When the user navigates to an external absolute URL, ensure the background
  // proxy server is running (for iframe embedding) but do NOT change proxyStarted.
  // proxyStarted only controls local dev server forwarding.
  useEffect(() => {
    if (isAbsoluteUrl(currentUrlValue) && !proxyPortValue) {
      ensureProxyRunning();
    }
  }, [currentUrlValue, proxyPortValue]);

  useEffect(() => {
    const localDev = parseLocalDevUrl(currentUrlValue);
    if (!localDev) {
      setPreferredLocalHost(null);
      return;
    }
    setPreferredLocalHost(localDev.host);
    ensureLocalDevProxy(localDev.port, localDev.host);
    if (portRef.current !== localDev.port) {
      setTargetPort(localDev.port);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUrlValue]);

  useEffect(() => {
    for (const tab of tabs || []) {
      const localDev = parseLocalDevUrl(normalizeUrl(tab.url));
      if (localDev) {
        ensureLocalDevProxy(localDev.port, localDev.host);
      }
    }
  }, [tabs]);

  // Log every real navigation into the persistent browsing history so the
  // history dropdown can recall any prior page (beyond a single tab's linear
  // back/forward stack). recordHistoryVisit ignores about:blank / "/" and
  // collapses immediately repeated URLs.
  useEffect(() => {
    const title = activeTab?.title ?? '';
    recordHistoryVisit(currentUrlValue, title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUrlValue]);

  return (
    <div
      className="preview-panel"
      data-preview-theme-mode={effectivePreviewTheme}
      data-preview-theme-source={previewThemeMode}
    >
      <div className="preview-tabs">
        <div className="preview-tab-list" ref={tabListRef}>
          {(tabs || []).map((tab) => (
            <button
              key={tab.id}
              className={`preview-tab${tab.id === activeTabId ? ' active' : ''}`}
              onClick={() => activateTab(tab.id)}
              title={tab.url}
            >
              <span className="preview-tab-title">{tab.title}</span>
              <span
                className="preview-tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => closeTab(event, tab.id)}
                onKeyDown={(event) => handleCloseTabKeydown(event, tab.id)}
                aria-label={`Close ${tab.title}`}
              >
                ×
              </span>
            </button>
          ))}
          <button className="preview-tab-add" onClick={openNewTab} title="New preview tab" aria-label="New preview tab">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>
        {/* Moves this Preview between the right sidebar and a stage room. */}
        <button
          className="preview-placement-btn"
          onClick={() => setPreviewDocked(!previewDocked)}
          title={previewDocked ? 'Open Browser as a room' : 'Back to right sidebar'}
          aria-label={previewDocked ? 'Open Browser as a room' : 'Back to right sidebar'}
        >
          {previewDocked ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          )}
          <span className="preview-placement-label">{previewDocked ? 'Open as room' : 'Back to right sidebar'}</span>
        </button>
      </div>

      <div className="browser-bar">
        <div className="nav-group main-nav">
          <button className="nav-btn" onClick={goBack} disabled={!canGoBack} title="Back">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button className="nav-btn" onClick={goForward} disabled={!canGoForward} title="Forward">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button className={`nav-btn ${getActiveTabLoadState().isLoading ? 'spinning' : ''}`} onClick={refresh} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 019-9 9.75 9.75 0 016.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          </button>

        {/* Open in system browser button */}
        {isAbsoluteUrl(currentUrlValue) && (
          <button className="nav-btn open-external-btn" onClick={openInBrowser} title="Open in system browser" aria-label="Open in system browser">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}

        </div>

      <div className="preview-address-row">
        <form className="address-bar" onSubmit={handleNavigate}>
          <span className={`protocol-badge ${protocolBadge.toLowerCase()}`}>{protocolBadge}</span>
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="Enter URL or search…"
            className="address-input"
            onKeyDown={handleInputKeydown}
            onClick={(e) => (e.target as HTMLInputElement).select()}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="go-btn" title="Navigate">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </form>
      </div>


          <div className="history-wrap">
            <button
              className={`nav-btn history-btn${showHistory ? ' active' : ''}`}
              onClick={() => { setShowHistory((prev) => !prev); setShowBrowserToolsMenu(false); }}
              title="Browsing history"
              aria-label="Browsing history"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <polyline points="3 3 3 9 9 9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </button>
            {showHistory && (
              <div className="history-dropdown">
                <div className="history-header">
                  <span>History</span>
                  {browsingHistoryValue.length > 0 && (
                    <button className="history-clear" onClick={clearBrowsingHistory}>
                      Clear all
                    </button>
                  )}
                </div>
                <div className="history-list">
                  {browsingHistoryValue.length === 0 ? (
                    <div className="history-empty">No history yet.</div>
                  ) : (
                    browsingHistoryValue.map((entry) => (
                      <div className="history-row" key={entry.url + entry.ts}>
                        <button className="history-entry" onClick={() => openHistoryEntry(entry.url)} title={entry.url}>
                          <span className="history-title">{entry.title}</span>
                          <span className="history-url">{entry.url}</span>
                        </button>
                        <span className="history-time">{relativeTime(entry.ts)}</span>
                        <button
                          className="history-remove"
                          onClick={() => removeHistoryEntry(entry.url)}
                          aria-label="Remove from history"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        <div className="browser-tools-wrap">
          <button type="button" className={`nav-btn${annotateMode ? ' active' : ''}`}
            aria-label="Annotate page" title="Annotate page" aria-pressed={annotateMode} disabled={!activeIframeSrc && !annotateMode}
            onClick={() => { toggleAnnotateMode(); setShowBrowserToolsMenu(false); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m4 16 12-12 4 4L8 20H4zM14 6l4 4" />
            </svg>
          </button>
          <button
            className={`nav-btn browser-tools-trigger${showBrowserToolsMenu ? ' active' : ''}${inspectMode || annotateMode || showConsole ? ' has-active-tool' : ''}`}
            onClick={() => { setShowBrowserToolsMenu((open) => !open); setShowHistory(false); }}
            aria-label="Browser tools"
            aria-haspopup="menu"
            aria-expanded={showBrowserToolsMenu}
            title="Browser tools"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
            </svg>
            <span className="browser-tools-label">Tools</span>
            <svg className="browser-tools-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {showBrowserToolsMenu && (
            <div className="browser-tools-menu" role="menu" aria-label="Browser tools">
<div className="browser-tools-subhead">Browser</div>
              <button className="browser-tools-item" role="menuitem" onClick={() => { hardReload(); setShowBrowserToolsMenu(false); }}>
                <span aria-hidden="true" /><span>Hard reload<small>Reload the page and bypass its cache</small></span>
              </button>

<div className="browser-tools-divider" />
              <div className="preview-theme-menu-title">Page tools</div>
              <button className={`browser-tools-item${inspectMode ? ' active' : ''}`} role="menuitemcheckbox" aria-checked={inspectMode} onClick={() => { toggleInspectMode(); setShowBrowserToolsMenu(false); }}><span>⌖</span><span>Design Mode<small>Pick an element and describe what to change</small></span>{inspectMode && <span className="preview-theme-check">✓</span>}</button>
              <button className={`browser-tools-item${showConsole ? ' active' : ''}`} role="menuitemcheckbox" aria-checked={showConsole} onClick={() => { setShowConsole((open) => !open); setShowBrowserToolsMenu(false); }}><span>›_</span><span>Developer console<small>{consoleCounts.errors} errors · {consoleCounts.warnings} warnings</small></span>{showConsole && <span className="preview-theme-check">✓</span>}</button>
<div className="browser-tools-divider" /><div className="browser-tools-subhead">Viewport</div>
        <div className="nav-group viewport-nav">
          {/* Fill the pane (no viewport emulation) */}
          <button
            className={`nav-btn viewport-btn${!deviceMode ? ' active' : ''}`}
            onClick={() => setDeviceMode(false)}
            title="Responsive: fill the pane"
            aria-pressed={!deviceMode}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="14" rx="2" />
              <path d="M8 20h8M12 18v2" />
            </svg>
          </button>

          {/* Phone */}
          <button
            className={`nav-btn viewport-btn${deviceMode && activePreset?.category === 'phone' ? ' active' : ''}`}
            onClick={() => chooseViewportCategory('phone')}
            title="Phone viewport"
            aria-pressed={deviceMode && activePreset?.category === 'phone'}
          >
            <svg width="10" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <line x1="9" y1="6" x2="15" y2="6" />
            </svg>
          </button>

          {/* Tablet */}
          <button
            className={`nav-btn viewport-btn${deviceMode && activePreset?.category === 'tablet' ? ' active' : ''}`}
            onClick={() => chooseViewportCategory('tablet')}
            title="Tablet viewport"
            aria-pressed={deviceMode && activePreset?.category === 'tablet'}
          >
            <svg width="13" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="2" />
              <line x1="9" y1="5" x2="15" y2="5" />
            </svg>
          </button>
        </div>

      {deviceMode && (
        <div className="device-bar">
          <div className="device-bar-preset">
            <Dropdown
              options={presetOptions}
              value={presetValue}
              onChange={(id) => {
                if (id !== CUSTOM_PRESET_ID) applyPreset(id);
              }}
              ariaLabel="Device preset"
              boundarySelector=".preview-panel"
            />
          </div>

          <div className="device-size">
            <input
              type="number"
              className="device-size-input"
              value={widthDraft ?? String(viewportSize.width)}
              min={MIN_VIEWPORT}
              max={MAX_VIEWPORT}
              onChange={(event) => setWidthDraft(event.target.value)}
              onBlur={() => commitSizeDraft('width', widthDraft)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSizeDraft('width', widthDraft);
                  (event.target as HTMLInputElement).blur();
                } else if (event.key === 'Escape') {
                  setWidthDraft(null);
                }
              }}
              aria-label="Viewport width in CSS pixels"
              title="Viewport width (CSS px)"
            />
            <span className="device-size-x">x</span>
            <input
              type="number"
              className="device-size-input"
              value={heightDraft ?? String(viewportSize.height)}
              min={MIN_VIEWPORT}
              max={MAX_VIEWPORT}
              onChange={(event) => setHeightDraft(event.target.value)}
              onBlur={() => commitSizeDraft('height', heightDraft)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSizeDraft('height', heightDraft);
                  (event.target as HTMLInputElement).blur();
                } else if (event.key === 'Escape') {
                  setHeightDraft(null);
                }
              }}
              aria-label="Viewport height in CSS pixels"
              title="Viewport height (CSS px)"
            />
          </div>

          <button className="nav-btn device-rotate" onClick={rotateViewport} title="Rotate" aria-label="Rotate viewport">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.5 3.5a9 9 0 0 1 6 6" />
              <polyline points="20.5 4.5 20.5 9.5 15.5 9.5" />
              <rect x="3" y="9" width="12" height="12" rx="2" />
            </svg>
          </button>

          <div className="device-zoom">
            <Dropdown
              options={zoomOptions}
              value={zoomMode === 'fit' ? 'fit' : String(zoomMode)}
              onChange={(value) => setZoomMode(value === 'fit' ? 'fit' : Number(value))}
              ariaLabel="Viewport zoom"
              boundarySelector=".preview-panel"
            />
          </div>

          <span className="device-scale-readout" title="Scale the viewport is drawn at">
            {Math.round(viewportScale * 100)}%
          </span>

          <button className="device-bar-exit" onClick={() => setDeviceMode(false)} title="Back to full-pane preview">
            Exit
          </button>
        </div>
      )}


<div className="browser-tools-subhead">Dev server</div>
        <div className="proxy-settings">
          <span className="label">Port:</span>
          <div className="port-combo">
            <input
              type="text"
              inputMode="numeric"
              list="common-ports"
              className="port-input"
              value={tempPort}
              onChange={(e) => setTempPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={handlePortChange}
              onKeyDown={(e) => e.key === 'Enter' && handlePortChange()}
              maxLength={5}
              title="Dev server port (type custom or pick common)"
            />
            <datalist id="common-ports">
              {commonPorts.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </datalist>
            <button className="nav-btn detect-btn" onClick={autoDetectPort} title="Auto-detect dev server port from project config">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </button>
          </div>

          <button
            className={`proxy-btn${proxyStartedValue ? ' running' : ''}`}
            onClick={toggleProxy}
            disabled={isConnectingValue}
            title={proxyStartedValue ? 'Stop local dev preview' : 'Start local dev preview on this port'}
          >
            {isConnectingValue ? (
              <>
                <svg className="spin-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
                </svg>
                <span className="proxy-btn-text">Connecting</span>
              </>
            ) : proxyStartedValue ? (
              <>
                <svg width="8" height="8" viewBox="0 0 8 8">
                  <circle cx="4" cy="4" r="4" fill="currentColor" />
                </svg>
                <span className="proxy-btn-text">Dev: On</span>
              </>
            ) : (
              <>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
                </svg>
                <span className="proxy-btn-text">Dev: Off</span>
              </>
            )}
          </button>
        </div>
              <div className="browser-tools-divider" /><div className="browser-tools-subhead">Appearance</div>
              <button className="browser-tools-item" role="menuitem" onClick={() => { setPreviewThemeMode(previewThemeMode === 'system' ? (effectivePreviewTheme === 'dark' ? 'light' : 'dark') : previewThemeMode === 'dark' ? 'light' : 'dark'); setShowBrowserToolsMenu(false); }}><span>◐</span><span>Switch page theme<small>Currently {previewThemeLabel}</small></span></button>
              {(['system', 'light', 'dark'] as const).map((mode) => (
                <button key={mode} className="browser-tools-item" role="menuitemradio" aria-checked={previewThemeMode === mode} onClick={() => { setPreviewThemeMode(mode); setShowBrowserToolsMenu(false); }}>
                  <span aria-hidden="true">{previewThemeMode === mode ? '\u2713' : ''}</span><span>{mode === 'system' ? 'Follow app theme' : mode === 'light' ? 'Light theme' : 'Dark theme'}</span>
                </button>
              ))}
              <div className="browser-tools-divider" />
              <button className="browser-tools-item" role="menuitem" disabled={screenshotting} onClick={() => { void takeScreenshot(); setShowBrowserToolsMenu(false); }}><span>▣</span><span>Capture screenshot<small>Save the current browser view</small></span></button>
              <button className="browser-tools-item" role="menuitem" disabled={clearingData} onClick={() => { void clearBrowsingData(); setShowBrowserToolsMenu(false); }}><span>◌</span><span>Clear cookies & cache<small>Clear preview data and reload the page</small></span></button>
              <button className="browser-tools-item" role="menuitem" onClick={() => { openSettings('browser'); setShowBrowserToolsMenu(false); }}><span>⚙</span><span>Browser settings<small>Connection, appearance, and behavior</small></span></button>
            </div>
          )}
        </div>


      </div>

      {getActiveTabLoadState().isLoading && (
        <div className="loading-bar">
          <div className="loading-progress"></div>
        </div>
      )}

      {getActiveTabLoadState().slowLoad && (
        <div className="preview-status-banner">
          <span>
            {currentUrlValue.startsWith('http://localhost') ||
            currentUrlValue.startsWith('http://127.0.0.1') ||
            currentUrlValue.startsWith('http://0.0.0.0')
              ? `Waiting for your local dev server on port ${port} to finish responding.`
              : 'The preview is still loading through the embedded proxy.'}
          </span>
        </div>
      )}

      {getActiveTabLoadState().iframeError && (
        <div className="preview-status-banner error">
          <span>Browser failed to load. Check that the local dev server is running and reachable on port {port}.</span>
        </div>
      )}

      {inspectMode && !selectedElementInfo && (
        <div className="design-mode-status-bar">
          <span className="design-mode-live-pill">
            <span className="design-mode-dot-live" />
            <span>Inspect mode</span>
          </span>
          <span className="design-mode-instruction">
            Hover to highlight an element, then click it to capture its layout, styles, HTML, and screenshot for an agent prompt.
          </span>
          <button
            type="button"
            className="design-mode-cancel-btn"
            onClick={toggleInspectMode}
          >
            Exit inspect
          </button>
        </div>
      )}

      {annotateMode && (
        <div className="design-mode-status-bar annotate-mode-status-bar">
          <span className="design-mode-live-pill">
            <span className="design-mode-dot-live" />
            <span>Draw mode</span>
          </span>
          <span className="design-mode-instruction">
            Mark up the page to show the changes you want, then send the annotated screenshot to an agent.
          </span>
          <button type="button" className="design-mode-cancel-btn" onClick={toggleAnnotateMode}>
            Exit draw
          </button>
        </div>
      )}

      {selectedElementInfo && (
        <DesignModePanel
          elementInfo={selectedElementInfo}
          screenshotUrl={selectedElementScreenshot}
          onClose={() => {
            setSelectedElementInfo(null);
            setSelectedElementScreenshot(null);
          }}
          onReselect={() => {
            setSelectedElementInfo(null);
            setSelectedElementScreenshot(null);
            if (!inspectMode) {
              toggleInspectMode();
            }
          }}
          onSendToAgent={async (promptText, screenshot, target) => {
            if (target) {
              await dispatchPromptToAgent(target, promptText, {
                imageDataUrl: screenshot,
                imageName: `${selectedElementInfo.tag.toLowerCase()}-snapshot.png`,
              });
              setSelectedElementInfo(null);
              setSelectedElementScreenshot(null);
              showToast(`Element context sent to ${target.displayName}`, 'success');
            } else {
              throw new Error('Choose an available agent before sending.');
            }
          }}
        />
      )}

      {showYoutubeHomepageWarning && (
        <div className="youtube-warning-banner">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="warning-icon">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            YouTube's homepage/search cannot be embedded. Please enter a specific video URL (e.g., <code>youtube.com/watch?v=...</code>) to
            preview it here.
          </span>
          <button className="banner-open-btn" onClick={openInBrowser} title="Open in system browser">
            Open in browser
          </button>
        </div>
      )}

      {!showYoutubeHomepageWarning &&
        isAbsoluteUrl(currentUrlValue) &&
        (currentUrlValue.includes('google.com') || currentUrlValue.includes('google.co')) && (
          <div className="google-warning-banner">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="warning-icon">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>
              Google may show a CAPTCHA in the built-in browser. Use the <strong>↗ button</strong> in the toolbar to open in your system
              browser for the best experience.
            </span>
            <button className="banner-open-btn" onClick={openInBrowser} title="Open Google in system browser">
              Open in browser
            </button>
          </div>
        )}

      <div className={`preview-content${deviceMode ? ' is-device' : ''}`} ref={previewContentRef}>
        {activeIframeSrc ? (
          // One tree for both modes: keeping the iframe stack at the same
          // position means switching in and out of device mode re-lays-out the
          // page instead of remounting (and reloading) every tab.
          <div
            className={`viewport-stage${viewportOverflowsX ? ' is-overflowing-x' : ''}${viewportOverflowsY ? ' is-overflowing-y' : ''}`}
            ref={setStageEl}
          >
            <div
              className={`viewport-sizer${resizingViewport ? ' is-resizing' : ''}`}
              style={
                deviceMode
                  ? { width: viewportSize.width * viewportScale, height: viewportSize.height * viewportScale }
                  : undefined
              }
            >
              <div
                className="viewport-frame"
                ref={viewportFrameRef}
                style={
                  deviceMode
                    ? {
                        width: viewportSize.width,
                        height: viewportSize.height,
                        transform: `scale(${viewportScale})`,
                      }
                    : undefined
                }
              >
                <div className="preview-frame-stack">
                  {(tabs || []).map((tab) => {
                    const tabSrc = srcForTab(tab);
                    if (!tabSrc) return null;
                    return (
                      <iframe
                        key={tab.id}
                        ref={(node) => setIframeElement(tab.id, node)}
                        src={tabSrc}
                        aria-label="Browser"
                        className={`preview-iframe${tab.id === activeTabId ? ' is-active' : ''}`}
                        onLoad={() => handleIframeLoad(tab.id)}
                        onError={() => handleIframeError(tab.id)}
                        allow="accelerometer; camera; clipboard-read; clipboard-write; encrypted-media; geolocation; gyroscope; microphone; payment; usb"
                        sandbox={buildIframeSandbox(tab.url)}
                        allowFullScreen
                      ></iframe>
                    );
                  })}
                </div>

                {annotateMode && (
                  <PreviewAnnotationOverlay
                    viewportWidth={deviceMode ? viewportSize.width : (viewportFrameRef.current?.clientWidth || 800)}
                    viewportHeight={deviceMode ? viewportSize.height : (viewportFrameRef.current?.clientHeight || 600)}
                    captureUnderlyingScreenshot={captureViewportScreenshot}
                    onClose={() => setAnnotateMode(false)}
                  />
                )}
              </div>

              {deviceMode && (
                <>
                  <div
                    className="viewport-handle handle-e"
                    onPointerDown={beginViewportResize('x')}
                    onPointerMove={handleViewportResizeMove}
                    onPointerUp={endViewportResize}
                    onPointerCancel={endViewportResize}
                    role="separator"
                    aria-label="Drag to resize viewport width"
                  />
                  <div
                    className="viewport-handle handle-s"
                    onPointerDown={beginViewportResize('y')}
                    onPointerMove={handleViewportResizeMove}
                    onPointerUp={endViewportResize}
                    onPointerCancel={endViewportResize}
                    role="separator"
                    aria-label="Drag to resize viewport height"
                  />
                  <div
                    className="viewport-handle handle-se"
                    onPointerDown={beginViewportResize('xy')}
                    onPointerMove={handleViewportResizeMove}
                    onPointerUp={endViewportResize}
                    onPointerCancel={endViewportResize}
                    role="separator"
                    aria-label="Drag to resize viewport"
                  />
                </>
              )}
            </div>

            {deviceMode && resizingViewport && (
              <div className="viewport-size-chip">
                {viewportSize.width} x {viewportSize.height}
              </div>
            )}
          </div>
        ) : (
          <div className="proxy-placeholder">
            <div className="placeholder-globe">
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity={0.3}>
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 014-10z" />
              </svg>
            </div>
            <h3>Browser</h3>
            <p>
              Built for previewing your <strong>local dev server</strong> (port {port}). You can also open external pages, but many full
              websites block embedding and won't load here, because this isn't a full web browser.
            </p>
            <div className="placeholder-actions">
              <button
                className="action-btn web-btn"
                onClick={() => {
                  // Route through navigateTo (not raw navigatePreviewTab) so the
                  // background proxy is started BEFORE the URL is set. External
                  // pages only render through the proxy; without this the page
                  // stays blank until a later effect happens to start it.
                  void navigateTo('https://search.brave.com/');
                }}
                title="Open browser"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                </svg>
                Browse Web
              </button>
              <button className="action-btn" onClick={toggleProxy} title="Browse local dev server">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
                </svg>
                Local Dev ({port})
              </button>
            </div>
            <p className="placeholder-note">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              Local &amp; development previews work best
            </p>
          </div>
        )}

        {showConsole && (
          <div className="preview-console">
            <div className="console-header">
              <span className="console-title">Console</span>

              <div className="console-filters" role="group" aria-label="Filter console output">
                {(
                  [
                    ['all', 'All', consoleLogs.length],
                    ['error', 'Errors', consoleCounts.errors],
                    ['warn', 'Warnings', consoleCounts.warnings],
                    ['log', 'Logs', consoleLogs.length - consoleCounts.errors - consoleCounts.warnings],
                  ] as [ConsoleFilter, string, number][]
                ).map(([value, label, count]) => (
                  <button
                    key={value}
                    className={`console-filter${consoleFilter === value ? ' active' : ''}${
                      value === 'error' && count > 0 ? ' has-errors' : ''
                    }`}
                    onClick={() => setConsoleFilter(value)}
                    aria-pressed={consoleFilter === value}
                  >
                    {label}
                    {count > 0 && <span className="console-filter-count">{count}</span>}
                  </button>
                ))}
              </div>

              <input
                className="console-search"
                value={consoleQuery}
                onChange={(event) => setConsoleQuery(event.target.value)}
                placeholder="Filter"
                aria-label="Filter console messages"
                spellCheck={false}
              />

              <div className="console-actions">
                <label className="console-preserve" title="Keep output across page loads (browsers clear it by default)">
                  <input
                    type="checkbox"
                    checked={preserveConsoleLog}
                    onChange={(event) => setPreserveConsoleLog(event.target.checked)}
                  />
                  Preserve log
                </label>
                <button
                  onClick={() => void copyConsoleText(filteredConsoleLogs.map(formatConsoleLine).join('\n'), 'Console output copied')}
                  disabled={filteredConsoleLogs.length === 0}
                  title="Copy the messages shown below"
                >
                  Copy
                </button>
                <button onClick={clearConsoleLogs}>Clear</button>
                <button onClick={() => setShowConsole(false)} aria-label="Close console">
                  Close
                </button>
              </div>
            </div>
            <div className="console-body" ref={consoleBodyRef} onScroll={handleConsoleScroll}>
              {filteredConsoleLogs.length === 0 ? (
                <div className="console-empty">
                  {consoleLogs.length === 0
                    ? 'No console output yet. Pages served from your local dev server report here; external sites do not.'
                    : 'Nothing matches this filter.'}
                </div>
              ) : (
                filteredConsoleLogs.map((log) => (
                  <div className={`console-row ${log.level}`} key={log.id}>
                    <span className="console-level">{log.level}</span>
                    <span className="console-message">{log.message}</span>
                    {log.count > 1 && (
                      <span className="console-count" title={`Repeated ${log.count} times`}>
                        {log.count}
                      </span>
                    )}
                    {log.url && (
                      <span className="console-source" title={`${log.url}: ${log.timestamp}`}>
                        {shortConsoleSource(log.url)}
                      </span>
                    )}
                    <button
                      className="console-row-copy"
                      onClick={() => void copyConsoleText(log.message, 'Message copied')}
                      title="Copy message"
                      aria-label="Copy message"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One console entry as a plain-text line, the way a browser console copies it. */
function formatConsoleLine(log: { level: string; message: string; url?: string; count: number }): string {
  const repeat = log.count > 1 ? ` (x${log.count})` : '';
  const source = log.url ? `  ${log.url}` : '';
  return `[${log.level}] ${log.message}${repeat}${source}`;
}

/** Last path segment of a console entry's source URL, or its host. */
function shortConsoleSource(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last || parsed.host;
  } catch {
    return url;
  }
}

function buildIframeSandbox(url: string) {
  const norm = normalizeUrl(url);
  // `allow-same-origin` is required for *all* preview content, not just local
  // dev. Everything (external sites included) is served through the loopback
  // proxy at http://127.0.0.1:{port}. Without `allow-same-origin` the iframe
  // document gets an opaque origin, so its navigation/subresource requests
  // carry `Origin: null` — which the proxy's CSRF/SSRF guard
  // (proxy_request_allowed) rejects with 403, leaving the page blank. Granting
  // it makes the document's origin the proxy origin (first-party to the guard)
  // while the parent app stays isolated by being a different origin
  // (tauri.localhost), so this does not expose the app to proxied pages.
  const base = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin';
  if (isYouTubeUrl(norm)) {
    return `${base} allow-presentation`;
  }
  return base;
}
