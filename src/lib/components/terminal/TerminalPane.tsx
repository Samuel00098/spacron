import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { get } from '$lib/stores/storeCompat';
import { copyTextToClipboard, readTextFromClipboard } from '$lib/utils/clipboard';
import { isTauriRuntime, dropPositionToCss } from '$lib/utils/tauri';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  writeToSession,
  registerDataCallback,
  registerExitCallback,
  unregisterDataCallback,
  unregisterExitCallback,
  getSessionOutputBuffer,
  resizeSession,
  sessions as sessionsOrig,
  killSession,
  setSessionExecuting,
  setSessionRole,
  setSessionCwd,
  applyOscPaneTitle,
  appendToCommandBlock,
  finalizeCommandBlockWithExit,
  paneAssignments as paneAssignmentsOrig,
  createTerminalSession as createTerminalSessionOrig,
  recordTerminalGeometry,
  terminalInputRequest,
  getSessionLabel,
  getAgentDisplayName,
  getSessionPaneDisplayTitle,
  getSessionPaneSecondaryTitle,
  activateSessionInPane,
  devSessions,
  devPaneAssignments,
  allProjectSessions,
} from '$lib/stores/terminal';
import {
  terminalFontSize,
  terminalCursorStyle,
  terminalScrollback,
  resolvedFontFamily,
  terminalShell,
  terminalRenderer,
} from '$lib/stores/settings';
import { activeTheme } from '$lib/stores/theme';
import { setActiveView, showTerminal } from '$lib/stores/layout';
import { requestRoomControl } from '$lib/stores/layoutControl';
import { activeProject, projects } from '$lib/stores/workspace';
import { clearProxyTarget, currentUrl, ensureProxyRunning, setPreferredLocalHost, setTargetPort } from '$lib/stores/preview';
import { showToast } from '$lib/stores/notification';
import { appendRunOutput, finalizeRunEntry, activeRunIds } from '$lib/stores/runHistory';
import { AGENT_ATTENTION_PATTERN } from '$lib/services/orchestrator/agent-signals';
import { useStore } from '$lib/react/useStore';
import './TerminalPane.css';

const ROLE_PRESETS = [
  { label: 'Server', color: 'var(--role-server)' },
  { label: 'Tests', color: 'var(--role-tests)' },
  { label: 'Build', color: 'var(--role-build)' },
  { label: 'Agent', color: 'var(--role-agent)' },
  { label: 'Git', color: 'var(--role-git)' },
] as const;

function getRoleColor(role: string | null | undefined): string {
  if (!role) return 'transparent';
  const preset = ROLE_PRESETS.find((r) => r.label === role);
  return preset ? preset.color : 'var(--text-muted)';
}

// Minimum terminal dimensions — prevents degenerate atlas state when pane is dragged tiny.
// Below these values xterm bakes glyphs at wrong cell sizes, corrupting the atlas for future resizes.
const MIN_COLS = 10;
const MIN_ROWS = 3;
const isWindowsHost = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

// ConPTY gained correct line-wrapping at Windows build 21376. At or above it, xterm's
// `windowsPty` wrapping heuristic is unnecessary — and measurably harmful, see the
// note on `windowsPty` below.
const CONPTY_NATIVE_WRAP_BUILD = 21376;

let cachedWindowsBuild: number | null = null;
let hasCheckedPowerShell7 = false;

// Build process detection — fires once per pane session.
// Matches common build tool output across webpack, Vite, Rollup, esbuild, tsc,
// Cargo, Maven, Gradle, Next.js, and generic "compiling/bundling" messages.
const BUILD_PATTERN = /\b(compiling|bundling|transpiling)\b|creating an optimized production build|\bbuild success\b|compiled successfully|successfully compiled|\bwebpack\b.*\bcompi|\bbundled\b|\brollup\b/i;

// Agent attention detection rate limit — fires when an agent pauses waiting for the user.
const AGENT_ATTENTION_COOLDOWN = 12_000;

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Terminal *query* sequences a TUI emits once at startup to probe the emulator —
// OSC color/palette reports (OSC 10/11/12, OSC 4;n, …), each ending in `;?`. They
// render nothing. When one sits in replayed scrollback (reattaching to a live
// session on app open), xterm re-answers it and the reply lands in the
// already-running child's input as literal `]10;rgb:…` / `]11;rgb:…` junk (the
// Codex reload bug). Scrubbing them from the replay stream is lossless and kills
// the leak at its source, instead of relying on the timing-based
// suppressReplayInput gate below — which reopens after 1.5s and so misses
// answerbacks emitted by a slow or backgrounded replay parse.
const OSC_QUERY_SEQUENCE = /\x1b\]\d+(?:;[^\x07\x1b]*)*;\?(?:\x07|\x1b\\)/g;

function stripTerminalQueries(text: string): string {
  return text.replace(OSC_QUERY_SEQUENCE, '');
}

function normalizePaneTitle(title: string) {
  return title.replace(/\s+/g, ' ').trim();
}

function isLocalPreviewUrl(url: URL) {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '0.0.0.0' ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(url.hostname) ||
    /^(172\.(1[6-9]|2\d|3[0-1]))\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
  );
}

async function openUrlInPreview(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  if (isLocalPreviewUrl(parsed) && parsed.port) {
    await clearProxyTarget();
    const port = Number(parsed.port);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      await setPreferredLocalHost(parsed.hostname);
      await setTargetPort(port);
    }
  } else {
    await setPreferredLocalHost(null);
  }
  await ensureProxyRunning();
  currentUrl.set(parsed.toString());
  setActiveView('preview');
  requestRoomControl('focus', 'preview');
}

function TerminalPane({
  sessionId,
  paneIndex,
  isActive,
  isMaximized = false,
  onActivate,
  onClose,
  onMaximize,
  onPaneDragStart,
  onResizeLeft,
  onResizeRight,
  onResizeTop,
  onResizeBottom,
  devMode = false,
}: {
  sessionId: number;
  paneIndex: number;
  isActive: boolean;
  isMaximized?: boolean;
  onActivate: () => void;
  onClose: () => void;
  onMaximize?: () => void;
  onPaneDragStart?: (paneIndex: number, e: React.MouseEvent) => void;
  onResizeLeft?: (e: React.MouseEvent) => void;
  onResizeRight?: (e: React.MouseEvent) => void;
  onResizeTop?: (e: React.MouseEvent) => void;
  onResizeBottom?: (e: React.MouseEvent) => void;
  devMode?: boolean;
}) {
  const sessions = devMode ? devSessions : sessionsOrig;
  const paneAssignments = devMode ? devPaneAssignments : paneAssignmentsOrig;

  function isSessionExecutingNow(id: number) {
    return get(sessions).find((session) => session.id === id)?.isExecuting ?? false;
  }

  const createTerminalSession = (cwd?: string, targetPaneIndex?: number, projectId?: string, opts?: { assignPane?: boolean; agentPreset?: string | null; initialCols?: number; initialRows?: number }) => {
    return createTerminalSessionOrig(cwd, targetPaneIndex, projectId, { ...opts, isDev: devMode });
  };

  const allSessions = useStore(sessions);
  // `sessions` only holds the ACTIVE project. An agent pane belonging to a
  // project you've switched away from stays mounted (so its xterm and scrollback
  // survive), and must still resolve its own metadata — otherwise it would show
  // as dead/untitled the moment you leave its project.
  const crossProjectSessions = useStore(allProjectSessions);
  const activeThemeValue = useStore(activeTheme);
  const fontFamily = useStore(resolvedFontFamily);
  const fontSize = useStore(terminalFontSize);
  const cursorStyle = useStore(terminalCursorStyle);
  const scrollback = useStore(terminalScrollback);
  const configuredShell = useStore(terminalShell);
  const renderer = useStore(terminalRenderer);
  const activeProjectValue = useStore(activeProject);
  const openProjects = useStore(projects);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const canvasAddonRef = useRef<CanvasAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const hoveredTerminalLinkRef = useRef<string | null>(null);
  const oscSequenceRemainderRef = useRef('');
  const fitRafRef = useRef<number | null>(null);
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentShellRef = useRef<string | null>(null);
  const isActiveRef = useRef(isActive);
  const seenDevUrlsRef = useRef<Set<string>>(new Set());
  const seenBuildRef = useRef(false);
  const lastAgentAttentionAtRef = useRef(0);

  const [currentShellCwd, setCurrentShellCwd] = useState<string | null>(null);

  const [windowsBuild, setWindowsBuild] = useState<number | null>(cachedWindowsBuild);
  const [isDragOver, setIsDragOver] = useState(false);

  // Only declare ConPTY to xterm on builds that still need its wrapping heuristic.
  //
  // Setting `windowsPty` makes xterm stamp an explicit wrapped/not-wrapped state on
  // every line as it arrives. Ordinary short output is stamped NOT wrapped, which
  // disables reflow for it — so when a pane shrinks, those lines are pushed into
  // scrollback permanently, and when it grows back xterm cannot pull them down
  // again. The new rows stay blank. Measured on a 46-row pane, one 46->40->46
  // cycle: baseY 15 -> 21 and trailing blank rows 1 -> 7. Six dead rows (~99px)
  // that never fill, and every transient shrink during a layout settle spends more.
  // That is the empty band at the bottom of a pane. Without the option the same
  // cycle is a no-op: baseY 15 -> 15, blank rows 1 -> 1.
  //
  // What it buys in return, on a modern build: nothing measurable. Wrapped-line
  // rejoin on widen behaves identically with and without it (isWrapped flags match;
  // a 100-char line rejoins into one row either way), because ConPTY has emitted
  // proper wrap information natively since build 21376.
  const windowsPty = useMemo(() => {
    if (!isWindowsHost) return undefined;
    const buildNumber = windowsBuild ?? 22000;
    if (buildNumber >= CONPTY_NATIVE_WRAP_BUILD) return undefined;
    return {
      backend: 'conpty' as const,
      buildNumber,
    };
  }, [windowsBuild]);

  const isForeignSession = !allSessions.some((s) => s.id === sessionId);
  const sessionInfo = isForeignSession
    ? crossProjectSessions.find((s) => s.id === sessionId)
    : allSessions.find((s) => s.id === sessionId);
  // Label disambiguation ("Claude 2") compares against siblings, so a pane from
  // a background project has to be compared against ITS project's sessions.
  const siblingSessions = isForeignSession && sessionInfo
    ? crossProjectSessions.filter((s) => s.projectId === sessionInfo.projectId)
    : allSessions;
  // A pane kept alive for a background project must resolve paths and titles
  // against ITS project, not whichever one happens to be open.
  const project = isForeignSession && sessionInfo?.projectId
    ? openProjects.get(sessionInfo.projectId) ?? activeProjectValue
    : activeProjectValue;

  const promptPath = useMemo(() => {
    const activePath = currentShellCwd || project?.root_path;
    if (!activePath) return 'shell';
    const projectRoot = project?.root_path;
    if (projectRoot && activePath.startsWith(projectRoot)) {
      const relative = activePath.slice(projectRoot.length).replace(/^[/\\]+/, '');
      const rootName = projectRoot.split(/[/\\]/).pop() || 'shell';
      return relative ? `${rootName}/${relative.replace(/\\/g, '/')}` : rootName;
    }
    const parts = activePath.replace(/[/\\]$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || 'shell';
  }, [currentShellCwd, project?.root_path]);

  const sessionLabel = sessionInfo ? getSessionLabel(sessionInfo, siblingSessions) : promptPath;
  // Badge shows the orchestrator-assigned assistant name (e.g. "Trinity"), falling
  // back to the agent CLI's product name. The main title is driven by the CLI's
  // OSC title (what it reports it's doing) — the two no longer share a field, so
  // both stay visible at once.
  const agentName = sessionInfo?.agentName?.trim() || getAgentDisplayName(sessionInfo?.agentPreset);
  const paneTitleText = sessionInfo ? getSessionPaneDisplayTitle(sessionInfo, siblingSessions) : promptPath;
  const paneSecondaryText = sessionInfo ? getSessionPaneSecondaryTitle(sessionInfo) : '';
  const isDead = sessionInfo ? !sessionInfo.isRunning : false;
  const isLightTheme = activeThemeValue?.type === 'light';

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Pointer-based drag to reposition. Native HTML5 DnD is unreliable inside the
  // Tauri webview (it fights the OS file-drop handler), so the parent panel drives
  // the drag from a plain mousedown on the titlebar — matching the file explorer.
  function handleTitlebarMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || !onPaneDragStart) return;
    // Let the close / maximize buttons handle their own clicks.
    if ((e.target as HTMLElement).closest('button')) return;
    onPaneDragStart(paneIndex, e);
  }

  function detectBuildProcess(text: string) {
    if (seenBuildRef.current) return;
    const info = get(sessions).find((s) => s.id === sessionId);
    if (info?.role) return; // don't override an already-set role
    if (!BUILD_PATTERN.test(text)) return;
    seenBuildRef.current = true;
    setSessionRole(sessionId, 'Build');
  }

  function detectAgentNeedsAttention(text: string) {
    const info = get(sessions).find((s) => s.id === sessionId);
    if (!info?.agentPreset) return;
    if (!AGENT_ATTENTION_PATTERN.test(text)) return;
    const now = Date.now();
    if (now - lastAgentAttentionAtRef.current < AGENT_ATTENTION_COOLDOWN) return;
    lastAgentAttentionAtRef.current = now;
    const label = getSessionLabel(info, get(sessions));
    showToast(`${label} is waiting for your response`, 'warning', 10000, true, {
      label: 'Focus',
      onClick: () => {
        activateSessionInPane(sessionId);
        showTerminal();
      },
    });
  }

  function detectDevServerUrl(text: string) {
    const matches = text.match(/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g);
    if (!matches) return;
    for (const url of matches) {
      if (seenDevUrlsRef.current.has(url)) continue;
      if (url === get(currentUrl)) continue;
      seenDevUrlsRef.current.add(url);
      const portMatch = url.match(/:(\d+)$/);
      const port = portMatch ? Number(portMatch[1]) : 80;
      // Auto-label this pane as "Server" if it has no role yet
      const info = get(sessions).find((s) => s.id === sessionId);
      if (!info?.role) setSessionRole(sessionId, 'Server');
      showToast(`Dev server on port ${port}`, 'info', 8000, false, {
        label: 'Open Preview',
        onClick: () => openUrlInPreview(url),
      });
    }
  }

  function forceRedraw() {
    const term = termRef.current;
    if (!term) return;
    try {
      (term as any).clearTextureAtlas?.();
      canvasAddonRef.current?.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    } catch {}
  }

  // The terminal is a DARK content surface in both light and dark app modes, and
  // never follows the theme. See buildTerminalTheme() for the full reasoning.
  //
  // Alpha stays 0 so the frosted wallpaper still shows through; the darkness comes
  // from the scrim in TerminalPane.css (--terminal-surface-rgb). The RGB carried
  // here is what xterm reports in reply to a TUI's OSC 11 "what is your
  // background?" query, so it must match that scrim — it is how termenv-based apps
  // (opencode, Claude Code, and any agent CLI wired up later) pick their theme.
  //
  // EXCEPT on WebGL, which cannot draw an attributed cell over a transparent
  // surface. Its glyph atlas rasterises any cell carrying dim (SGR 2), italic,
  // underline or strikethrough onto a tile pre-filled with the background colour,
  // so at alpha 0 every such run lands as an opaque black slab. Measured
  // 2026-08-07 over a magenta backdrop at xterm 5.5.0 / addon-webgl 0.18.0: plain,
  // bold and colour-only runs stay correctly transparent; all four attributed ones
  // slab. Agent statuslines lean on dim constantly, so WebGL panes come out
  // striped with black boxes. It is not fixed upstream — xterm 6.0.0 +
  // addon-webgl 0.19.0 drops transparency for the entire surface instead.
  //
  // An opaque surface is therefore the only way WebGL renders correctly. The RGB
  // is deliberately unchanged, so the OSC 11 answer a TUI negotiates is identical
  // and only the see-through glass is traded away — and only for the user who
  // opted into WebGL. Canvas (the default) and DOM keep the wallpaper.
  function terminalBackground() {
    return renderer === 'webgl' ? 'rgb(17, 17, 22)' : 'rgba(17, 17, 22, 0)';
  }

  // The terminal's palette. Always dark, in both app modes, and deliberately
  // decoupled from light/dark — this is the one surface in the app that does not
  // follow the theme.
  //
  // WHY. A TUI asks "what colour is your background?" exactly once, over OSC 11,
  // at launch, and then paints its own surface from the answer. It is a separate
  // process; there is no signal that means "you were told light, it is dark now,
  // please re-theme". So while the answer tracked app mode, a TUI launched in
  // light mode kept its white surface forever — including after switching to dark,
  // where it became a glaring white slab. That is not a styling bug that can be
  // chased; it is a one-shot negotiation that already concluded. Pinning the
  // answer to dark is what makes the result deterministic.
  //
  // It also has to be the WHOLE palette, not just the reported background. The
  // xterm surface is transparent, so a plain shell's text lands on whatever shows
  // through. Report dark while leaving the foreground light-tuned and ordinary
  // shell output goes dark-on-dark. Background, foreground and ANSI slots move
  // together, and the scrim in TerminalPane.css darkens the surface to match.
  //
  // A dark PRESET may still colour the semantic and syntax slots, so each
  // wallpaper keeps its character. A light theme's tokens are tuned for a bright
  // page and are ignored outright — the canonical dark values below are used.
  function buildTerminalTheme() {
    const theme = get(activeTheme);
    const usable = theme?.type === 'light' ? undefined : theme;
    const colors = usable?.colors ?? {};
    const syntax = usable?.syntax ?? {};
    return {
      background: terminalBackground(),
      foreground: colors['text-primary'] || '#e6edf3',
      cursor: colors['accent'] || '#f1f5f9',
      cursorAccent: colors['bg-primary'] || '#111116',
      selectionBackground: colors['selection-bg'] || 'rgba(241, 245, 249, 0.28)',
      black: colors['bg-tertiary'] || '#21262d',
      red: colors['error'] || '#ff6b6b',
      green: colors['success'] || '#2ee06d',
      yellow: colors['warning'] || '#fbbf24',
      // NOT --accent. The accent is graphite now, so deriving ANSI blue from it
      // renders every blue token in shell output as near-white. --info is the
      // token that is actually a blue.
      blue: colors['info'] || '#58a6ff',
      magenta: syntax['function'] || '#d2a8ff',
      cyan: syntax['constant'] || '#39d2c0',
      white: colors['text-primary'] || '#e6edf3',
      // ANSI "bright black" is the dim slot agent CLIs use for secondary text
      // (Thinking lines, tips, hints). Over a see-through terminal it has to stay
      // legible, so it maps to text-secondary rather than the dimmer text-muted.
      brightBlack: colors['text-secondary'] || colors['text-muted'] || '#8b949e',
      brightRed: syntax['keyword'] || '#ff7b72',
      brightGreen: colors['success'] || '#4ade80',
      brightYellow: colors['warning'] || '#fbbf24',
      brightBlue: colors['info'] || '#79b8ff',
      brightMagenta: syntax['function'] || '#d2a8ff',
      brightCyan: syntax['constant'] || '#39d2c0',
      brightWhite: '#ffffff',
    };
  }

  function applyRendererBackground() {
    const term = termRef.current;
    if (!term) return;
    term.options.allowTransparency = true;
    term.options.theme = {
      ...term.options.theme,
      background: terminalBackground(),
    };
  }

  function applyTerminalRenderer() {
    const term = termRef.current;
    if (!term) return;

    // Only one GPU addon may be loaded at a time — tear down any that no longer
    // matches the requested renderer before loading the new one.
    if (renderer !== 'canvas' && canvasAddonRef.current) {
      canvasAddonRef.current.dispose();
      canvasAddonRef.current = null;
    }
    if (renderer !== 'webgl' && webglAddonRef.current) {
      webglAddonRef.current.dispose();
      webglAddonRef.current = null;
    }

    if (renderer === 'canvas' && !canvasAddonRef.current) {
      try {
        const canvasAddon = new CanvasAddon();
        canvasAddonRef.current = canvasAddon;
        term.loadAddon(canvasAddon);
      } catch (error) {
        console.error('Failed to enable canvas terminal renderer', error);
        canvasAddonRef.current?.dispose();
        canvasAddonRef.current = null;
        terminalRenderer.set('dom');
        showToast('Canvas renderer unavailable; using DOM renderer.', 'warning');
        return;
      }
    } else if (renderer === 'webgl' && !webglAddonRef.current) {
      try {
        const webglAddon = new WebglAddon();
        // The GPU context can be evicted by the OS/WebView; fall back to DOM
        // rather than leaving a dead, blank canvas behind.
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          webglAddonRef.current = null;
          terminalRenderer.set('canvas');
          showToast('Terminal GPU context lost; switched to canvas renderer.', 'warning');
        });
        webglAddonRef.current = webglAddon;
        term.loadAddon(webglAddon);
      } catch (error) {
        console.error('Failed to enable WebGL terminal renderer', error);
        webglAddonRef.current?.dispose();
        webglAddonRef.current = null;
        terminalRenderer.set('canvas');
        showToast('WebGL renderer unavailable; using canvas renderer.', 'warning');
        return;
      }
    }

    applyRendererBackground();
    scheduleFit();
    requestAnimationFrame(() => forceRedraw());
  }

  function waitForOpenDimensions(target: HTMLDivElement) {
    return new Promise<void>((resolve) => {
      if (target.clientWidth > 0 && target.clientHeight > 0) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve();
      };
      const observer = new ResizeObserver(() => {
        if (target.clientWidth > 0 && target.clientHeight > 0) finish();
      });
      observer.observe(target);
      setTimeout(finish, 250);
    });
  }

  function doFit() {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const term = termRef.current;
    if (!container || !fitAddon || !term) return;
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
    try {
      // Check proposed dimensions BEFORE resizing — skip if pane is too small to produce a
      // valid atlas. This prevents the degenerate small→large texture corruption.
      const dims = fitAddon.proposeDimensions();
      if (!dims || dims.cols < MIN_COLS || dims.rows < MIN_ROWS) return;

      const sizeChanged = dims.cols !== term.cols || dims.rows !== term.rows;
      if (sizeChanged) {
        fitAddon.fit();
        (term as any).clearTextureAtlas?.();
        canvasAddonRef.current?.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
      }

      // Teach the next spawn what a real pane measures, so a new PTY opens at
      // this grid instead of the 120x34 placeholder and never has to reflow.
      recordTerminalGeometry(dims.cols, dims.rows);

      // Second pass after layout settles — the first fit can run before the
      // pane's flex/grid layout has stabilised (especially in vibe mode where
      // the CSS grid transition is 320ms), latching a too-small row count
      // that leaves the viewport height wrong and scrolling broken. Wait long
      // enough that any CSS transition or layout reparenting has finished,
      // then re-fit if the settled dimensions differ.
      setTimeout(() => {
        const t = termRef.current;
        const fa = fitAddonRef.current;
        if (!t || !fa) return;
        const settled = fa.proposeDimensions();
        if (!settled || settled.cols < MIN_COLS || settled.rows < MIN_ROWS) return;
        // The settled pass is the authoritative measurement — record it even
        // when nothing changed, since that is the steady-state pane size.
        recordTerminalGeometry(settled.cols, settled.rows);
        if (settled.cols !== t.cols || settled.rows !== t.rows) {
          fa.fit();
          (t as any).clearTextureAtlas?.();
          canvasAddonRef.current?.clearTextureAtlas();
          t.refresh(0, t.rows - 1);
        }
      }, 350);
    } catch {}
  }

  // Debounced fit: waits 120 ms of silence before measuring.
  // Prevents doFit from running 60x/s during drag, which corrupts xterm's render pipeline.
  function scheduleFit() {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
      fitRafRef.current = null;
    }
    if (fitTimerRef.current !== null) clearTimeout(fitTimerRef.current);
    fitTimerRef.current = setTimeout(() => {
      fitTimerRef.current = null;
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        doFit();
      });
    }, 50);
  }

  async function fitAfterFonts() {
    try {
      await document.fonts.ready;
    } catch {}
    doFit();
    setTimeout(doFit, 100);
  }

  // Force a running full-screen TUI (e.g. the Claude Code agent) to repaint when
  // this pane reattaches to a still-alive session. On a project switch the pane
  // unmounts and its xterm is disposed, but the PTY keeps running; coming back,
  // the fresh xterm fits to the SAME size the PTY already has, so no resize
  // reaches the app and it shows a stale frame until the user drags to resize.
  // We reproduce that manual resize: briefly shrink the PTY by one row, then
  // restore it — a genuine size change the TUI reacts to by redrawing. xterm
  // itself stays at its fitted size, so reverting immediately resyncs the two.
  function forceReattachRepaint() {
    const term = termRef.current;
    if (!term) return;
    const cols = term.cols;
    const rows = term.rows;
    if (!cols || !rows || rows < MIN_ROWS + 1) return;
    resizeSession(sessionId, rows - 1, cols);
    setTimeout(() => {
      const t = termRef.current;
      if (!t) return;
      resizeSession(sessionId, t.rows, t.cols);
    }, 80);
  }

  function copyTerminalPath(e: React.MouseEvent) {
    e.stopPropagation();
    const activePath = currentShellCwd || project?.root_path;
    if (activePath) {
      copyTextToClipboard(activePath).then(() => {
        showToast(`Copied: ${activePath}`, 'success');
      });
    }
  }

  function handleTerminalLinkMouseDown(event: MouseEvent) {
    if (!hoveredTerminalLinkRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    termRef.current?.clearSelection();
  }

  function handleTerminalLinkMouseUp(event: MouseEvent) {
    if (!hoveredTerminalLinkRef.current || event.button !== 0) return;
    const uri = hoveredTerminalLinkRef.current;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    termRef.current?.clearSelection();
    openUrlInPreview(uri).catch(console.error);
  }

  // Touchpad-friendly copy/paste (Linux especially, where keyboard shortcuts and
  // corner right-clicks are awkward on a trackpad):
  //   • Copy-on-select — releasing a left-drag selection copies it to the clipboard,
  //     the way native Linux terminals behave. No selection (a plain click) is a
  //     no-op, so it never clobbers the clipboard on stray clicks.
  //   • Middle-click paste — the standard Linux paste gesture (three-finger tap).
  // Right-click still opens the copy/paste context menu.
  function handleTerminalCopyOnSelect(event: MouseEvent) {
    if (event.button !== 0) return;
    if (hoveredTerminalLinkRef.current) return; // a link click, not a selection
    const term = termRef.current;
    if (!term || !term.hasSelection()) return;
    const selection = term.getSelection();
    if (selection) void copyTextToClipboard(selection);
  }

  function handleTerminalMiddleClickPaste(event: MouseEvent) {
    if (event.button !== 1) return;
    event.preventDefault();
    const term = termRef.current;
    if (!term) return;
    void readTextFromClipboard().then((text) => {
      if (text) term.paste(text);
    });
  }

  function parseOsc7Path(value: string) {
    const rawValue = value.trim();
    if (!rawValue.startsWith('file://')) return;
    let rawPath = rawValue.replace(/^file:\/\/[^/]+/, '');
    if (!rawPath) return;
    if (rawPath.startsWith('/') && rawPath.charAt(2) === ':') rawPath = rawPath.slice(1);
    const decoded = decodeURIComponent(rawPath);
    setCurrentShellCwd(decoded);
    setSessionCwd(sessionId, decoded);
  }

  function parseOscTitle(value: string, shellCwd: string | null) {
    const info = sessionInfo;
    if (!info?.agentPreset) return;

    const displayName = getAgentDisplayName(info.agentPreset) ?? info.title;
    const activeProjectName = project?.name?.trim() || '';
    const activeProjectRootName =
      project?.root_path?.replace(/[/\\]+$/, '').split(/[/\\]/).pop()?.trim() || '';
    const cwdBaseName = shellCwd?.replace(/[/\\]+$/, '').split(/[/\\]/).pop()?.trim() || '';
    const cleaned = normalizePaneTitle(value)
      .replace(new RegExp(`\\s+[·|-]\\s+${escapeRegExp(displayName)}$`, 'i'), '')
      .trim();

    if (!cleaned) return;

    const genericTitles = new Set(
      [
        info.title,
        info.role,
        sessionLabel,
        agentName,
        displayName,
        promptPath,
        activeProjectName,
        activeProjectRootName,
        cwdBaseName,
      ]
        .filter((entry): entry is string => Boolean(entry?.trim()))
        .map((entry) => entry.trim().toLowerCase()),
    );
    const lowered = cleaned.toLowerCase();

    if (genericTitles.has(lowered)) return;
    if (/^[A-Z]:[\\/]|^\/|^~[\\/]|^file:\/\//i.test(cleaned)) return;
    if (/^(powershell|pwsh|bash|zsh|cmd|fish|nu|nushell)(\.exe)?$/i.test(cleaned)) return;

    applyOscPaneTitle(sessionId, cleaned);
  }

  function parseOscSequences(text: string, shellCwd: string | null) {
    const combined = `${oscSequenceRemainderRef.current}${text}`;
    const pattern = /\x1b\](\d+);(.*?)(?:\x07|\x1b\\)/gs;
    let lastConsumed = 0;

    for (const match of combined.matchAll(pattern)) {
      const full = match[0];
      const code = match[1];
      const value = match[2] ?? '';
      const idx = match.index ?? 0;
      lastConsumed = idx + full.length;

      if (code === '7') {
        parseOsc7Path(value);
      } else if (code === '0' || code === '1' || code === '2') {
        parseOscTitle(value, shellCwd);
      }
    }

    const pendingStart = combined.lastIndexOf('\x1b]');
    oscSequenceRemainderRef.current =
      pendingStart !== -1 && pendingStart >= lastConsumed ? combined.slice(pendingStart).slice(-1024) : '';
  }

  function clearTerminal() {
    termRef.current?.clear();
    termRef.current?.focus();
  }


  async function restartSession() {
    const paneIdx = get(paneAssignments).indexOf(sessionId);
    const cwd = currentShellCwd || project?.root_path;
    clearTerminal();
    if (paneIdx === -1) return;
    await killSession(sessionId);
    await createTerminalSession(cwd, paneIdx);
  }

  async function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const term = termRef.current;
    if (term?.hasSelection()) {
      try {
        await copyTextToClipboard(term.getSelection());
        term.clearSelection();
        showToast('Copied to clipboard', 'info');
      } catch {}
    } else {
      try {
        const text = await readTextFromClipboard();
        if (text) writeToSession(sessionId, text);
      } catch {}
    }
  }

  useEffect(() => {
    if (isWindowsHost) {
      if (!hasCheckedPowerShell7) {
        hasCheckedPowerShell7 = true;
        invoke<any[]>('terminal_list_shells')
          .then((shells) => {
            const hasPwsh = shells.some((s) =>
              s.program.toLowerCase().includes('pwsh')
            );
            if (!hasPwsh) {
              showToast(
                'PowerShell 7 (pwsh) is not installed. For the best terminal experience and to avoid resizing display bugs, please install PowerShell 7.',
                'warning',
                8000
              );
            }
          })
          .catch((err) => {
            console.error('Failed to query available shells on startup:', err);
          });
      }

      if (windowsBuild === null) {
        invoke<number>('terminal_get_windows_build')
          .then((build) => {
            cachedWindowsBuild = build;
            setWindowsBuild(build);
          })
          .catch((err) => {
            console.error('Failed to fetch Windows build number:', err);
            setWindowsBuild(22000);
          });
      }
    }
  }, [windowsBuild]);

  // In-app explorer file drag into this terminal pane. Dragging a file from the
  // app's own FileExplorer (left sidebar) and dropping directly onto this pane
  // writes its path as terminal input — the same as OS-level drops above.
  const explorerDragPathRef = useRef<string | null>(null);
  useEffect(() => {
    function handleDragStart(event: Event) {
      const custom = event as CustomEvent<{ path?: string }>;
      explorerDragPathRef.current = custom.detail?.path?.trim() || null;
      setIsDragOver(false);
    }
    function handleDragMove() {
      if (!explorerDragPathRef.current) return;
      const c = containerRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      // Check the last known mouse position via the on-screen cursor
      const els = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const over = els.some((el) => el === c || c.contains(el));
      setIsDragOver(over);
    }
    function handleDragEnd(event: Event) {
      const custom = event as CustomEvent<{ path?: string; clientX?: number; clientY?: number }>;
      const endedPath = custom.detail?.path?.trim() || explorerDragPathRef.current;
      const cx = custom.detail?.clientX;
      const cy = custom.detail?.clientY;
      let overPane = false;
      const c = containerRef.current;
      if (c && typeof cx === 'number' && typeof cy === 'number') {
        const rect = c.getBoundingClientRect();
        overPane = cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
      }
      // Drop into this pane only if NOT also over the floating prompt bar
      let overBar = false;
      const barEl = document.querySelector('#floating-prompt-bar');
      if (barEl && typeof cx === 'number' && typeof cy === 'number') {
        const barRect = barEl.getBoundingClientRect();
        overBar = cx >= barRect.left && cx <= barRect.right && cy >= barRect.top && cy <= barRect.bottom;
      }
      if (endedPath && overPane && !overBar) {
        const text = endedPath.replace(/\\/g, '/');
        writeToSession(sessionId, text);
      }
      explorerDragPathRef.current = null;
      setIsDragOver(false);
    }
    window.addEventListener('spacron-explorer-drag-start', handleDragStart);
    window.addEventListener('spacron-explorer-drag-move', handleDragMove);
    window.addEventListener('spacron-explorer-drag-end', handleDragEnd);
    return () => {
      window.removeEventListener('spacron-explorer-drag-start', handleDragStart);
      window.removeEventListener('spacron-explorer-drag-move', handleDragMove);
      window.removeEventListener('spacron-explorer-drag-end', handleDragEnd);
      explorerDragPathRef.current = null;
    };
  }, [sessionId]);

  // Mount xterm once per session. Mirrors mount/unmount lifecycle:
  // create the Terminal, wire PTY callbacks, observers and listeners, then tear
  // everything down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: get(terminalCursorStyle),
      allowTransparency: true,
      // Required by Unicode11Addon (loaded below): xterm gates its width
      // tables behind the proposed API, and `loadAddon` throws without this.
      allowProposedApi: true,
      scrollback: get(terminalScrollback),
      fontSize: get(terminalFontSize),
      fontFamily: get(resolvedFontFamily),
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1.12,
      letterSpacing: 0,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      // The terminal surface is fully transparent (glass), so any glyph a TUI
      // draws in a near-background tone (e.g. Antigravity's input text, which it
      // colors near-black) vanishes into the wallpaper — black-on-black. xterm's
      // minimumContrastRatio re-lightens/darkens only the glyphs that fail this
      // ratio against the theme background, rescuing that text regardless of how
      // the CLI colored it, while leaving already-legible output untouched.
      minimumContrastRatio: 4.5,
      windowsPty,
      theme: buildTerminalTheme(),
    });
    termRef.current = term;

    // Keyboard copy/paste. On WebKitGTK (Linux) xterm's rows never fall through to
    // the browser's native clipboard shortcuts, so it has to be wired explicitly
    // and routed through the native clipboard plugin (navigator.clipboard is
    // permission-blocked on WebKitGTK).
    //
    // Deliberately NOT Ctrl+Shift+C / Ctrl+Shift+V: those are already global app
    // shortcuts (Go to Containers / Go to Preview), so the terminal would fire them
    // too. Instead use bindings that collide with nothing on any platform:
    //   • Copy  — Ctrl/Cmd+C, but ONLY when text is selected (a bare Ctrl+C with no
    //             selection still sends SIGINT); also Ctrl+Insert.
    //   • Paste — Ctrl/Cmd+V; also Shift+Insert.
    // Handled keys call preventDefault + stopPropagation so they can never reach the
    // app-level shortcut handler. Returning false stops xterm from processing them.
    const copySelection = () => {
      const selection = term.getSelection();
      if (!selection) return false;
      void copyTextToClipboard(selection);
      return true;
    };
    const pasteClipboard = () => {
      void readTextFromClipboard().then((text) => {
        if (text) term.paste(text);
      });
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      // Classic terminal copy/paste (Ctrl+Insert / Shift+Insert) — no modifier
      // clash with the app's Ctrl+Shift+* navigation shortcuts.
      if (event.key === 'Insert' && event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (copySelection()) { event.preventDefault(); event.stopPropagation(); return false; }
        return true;
      }
      if (event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        pasteClipboard();
        return false;
      }

      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.shiftKey || event.altKey) return true;
      const key = event.key.toLowerCase();
      if (key === 'c') {
        // Only intercept when there's a selection; otherwise let Ctrl+C be SIGINT.
        if (copySelection()) { event.preventDefault(); event.stopPropagation(); return false; }
        return true;
      }
      if (key === 'v') {
        event.preventDefault();
        event.stopPropagation();
        pasteClipboard();
        return false;
      }
      return true;
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = '11';

    term.loadAddon(
      new WebLinksAddon(
        (event: MouseEvent, uri: string) => {
          event.preventDefault();
          event.stopPropagation();
          term.clearSelection();
          openUrlInPreview(uri).catch(console.error);
        },
        {
          hover: (_event: any, uri: string) => {
            hoveredTerminalLinkRef.current = uri;
          },
          leave: () => {
            hoveredTerminalLinkRef.current = null;
          },
        },
      ),
    );

    let disposed = false;
    let executingTimeout: ReturnType<typeof setTimeout> | null = null;
    // True only while the reattach buffer below is being parsed. Replayed history
    // re-feeds the agent's startup color/DA queries (e.g. Codex's ESC]10;?/ESC]11;?),
    // and xterm answers them again — those synthetic replies must NOT be written
    // back to the live PTY (they'd land as `]10;rgb:…` junk in the input box).
    let suppressReplayInput = false;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      await waitForOpenDimensions(container);
      if (disposed) return;

      term.open(container);
      applyTerminalRenderer();
      // Nudge a repaint whenever the shell enters/leaves a full-screen TUI
      // (alternate screen buffer).
      //
      // This used to call applyRendererBackground(), which assigns term.options.theme.
      // The background is identical in both buffers — it only varies with light/dark —
      // so the assignment changed nothing, but xterm treats any theme write as a theme
      // change and refreshes the renderer, which on canvas/webgl means discarding the
      // glyph atlas on every screen switch. A plain refresh gets the same repaint
      // without throwing away cached glyphs; the theme effect below owns the surface.
      //
      // Note this must stay a *client-side* repaint: forceReattachRepaint() would also
      // redraw, but it does so by round-tripping a real PTY resize, which would fire
      // SIGWINCH at the shell on every TUI enter/exit.
      term.buffer.onBufferChange(() => term.refresh(0, term.rows - 1));
      container.addEventListener('mousedown', handleTerminalLinkMouseDown, true);
      container.addEventListener('mouseup', handleTerminalLinkMouseUp, true);
      container.addEventListener('mouseup', handleTerminalCopyOnSelect);
      container.addEventListener('mousedown', handleTerminalMiddleClickPaste);

      const existingBuffer = getSessionOutputBuffer(sessionId);
      // A non-empty buffer means this pane is reattaching to a session that was
      // already running (e.g. after a project switch), so its TUI needs a resize
      // kick to repaint once the fit settles. A fresh session paints on its own.
      const isReattach = !!existingBuffer;
      if (existingBuffer) {
        // Gate outbound data until this historical write finishes parsing, so the
        // re-answered color/DA queries it contains don't leak into the live PTY.
        // The gate MUST never stay stuck `true` — while it is, every keystroke for
        // this session is silently dropped. xterm normally clears it via the write
        // callback once replay finishes parsing, but that callback can be deferred
        // indefinitely when the pane isn't visible/attached yet (a background tab,
        // or reattaching on app open), so a timeout guarantees input is re-enabled.
        suppressReplayInput = true;
        const clearReplayGate = () => {
          suppressReplayInput = false;
        };
        const replayGateTimer = setTimeout(clearReplayGate, 1500);
        // Scrub the child's startup color/palette *queries* out of the replayed
        // history first: they render nothing, but leaving them in makes xterm
        // re-answer them and the reply lands in the running child's input as
        // literal `]10;rgb:…` / `]11;rgb:…` junk. This removes the leak at its
        // source; the gate above is now only a backstop.
        term.write(stripTerminalQueries(existingBuffer), () => {
          clearTimeout(replayGateTimer);
          clearReplayGate();
        });
      }

      // Double rAF lets the flex mosaic settle (a sibling pane may still be tiling
      // in), THEN wait for fonts for accurate glyph metrics before the first fit.
      // Fitting before the layout settles latches a transient (narrow) size — the
      // bug where the 2nd/3rd agent panes render narrower than their pane.
      requestAnimationFrame(() =>
        requestAnimationFrame(async () => {
          await fitAfterFonts();
          if (isReattach) forceReattachRepaint();
        }),
      );

      term.onData((data: string) => {
        // Drop xterm's synthetic query replies emitted while replaying history (see
        // the reattach buffer write above); genuine keystrokes still pass through.
        if (suppressReplayInput) return;
        writeToSession(sessionId, data);
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => resizeSession(sessionId, rows, cols));
      term.onKey(() => {
        if (!isActiveRef.current) onActivate();
      });

      registerDataCallback(sessionId, (bytes: Uint8Array, text: string) => {
        term.write(bytes);
        try {
          parseOscSequences(text, currentShellCwd);
          detectDevServerUrl(text);
          detectBuildProcess(text);
          detectAgentNeedsAttention(text);
          if (isSessionExecutingNow(sessionId)) {
            appendToCommandBlock(sessionId, text);
            const runId = activeRunIds.get(sessionId);
            if (runId) appendRunOutput(runId, text);
          }
        } catch {}
        if (executingTimeout) clearTimeout(executingTimeout);
        executingTimeout = setTimeout(() => {
          if (isSessionExecutingNow(sessionId)) {
            setSessionExecuting(sessionId, false);
            finalizeCommandBlockWithExit(sessionId, 0);
            const runId = activeRunIds.get(sessionId);
            if (runId) {
              finalizeRunEntry(runId, 0);
              activeRunIds.delete(sessionId);
            }
          }
        }, 800);
      });

      registerExitCallback(sessionId, (code: number) => {
        if (executingTimeout) clearTimeout(executingTimeout);
        setSessionExecuting(sessionId, false);
        finalizeCommandBlockWithExit(sessionId, code);
        const runId = activeRunIds.get(sessionId);
        if (runId) {
          finalizeRunEntry(runId, code);
          activeRunIds.delete(sessionId);
        }
      });

      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(container);
    })();

    // After drag ends, cancel any pending debounce and fit immediately
    function onResizeEnd() {
      if (fitTimerRef.current !== null) {
        clearTimeout(fitTimerRef.current);
        fitTimerRef.current = null;
      }
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        doFit();
        // A layout switch (Focus ↔ Fleet) hides then re-shows this pane. While it
        // was hidden the WebGL/canvas glyph atlas can be evicted or left stale, and
        // doFit()'s refresh re-renders straight from that bad atlas — leaving the
        // off-screen scrollback rows garbled once you scroll back up. Flush the
        // atlas and repaint (twice, letting layout settle) so a round-trip through
        // Fleet comes back clean instead of corrupted.
        forceRedraw();
        setTimeout(forceRedraw, 80);
      });
    }
    document.addEventListener('pane-resize-end', onResizeEnd);

    // Recover from idle rendering corruption: when the window/tab regains visibility after
    // being hidden (e.g., user switches away and back), the WebView2 GPU scheduler may have
    // evicted canvas textures. Force a full atlas flush.
    //
    // Only for panes that are actually on screen. Every pane stays mounted for the
    // whole life of its session, and the ones that aren't on stage are hidden with
    // `visibility` at full size, never unmounted — panes behind the Home overlay,
    // and panes belonging to a project you've switched away from. So a busy
    // workspace holds far more panes than it shows, and this used to flush the
    // glyph atlas and repaint every one of them, twice, in the first 80 ms after
    // the window came back: exactly the moment the user is trying to interact
    // again. A hidden pane gains nothing from it either, since it is repainted by
    // the `pane-resize-end` pass that fires whenever it is shown again.
    function isPaneOnScreen() {
      const c = containerRef.current;
      if (!c) return false;
      if (typeof c.checkVisibility === 'function') {
        return c.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
      }
      // WebKitGTK below 17.4 has no checkVisibility; `visibility` inherits, so a
      // hidden ancestor still resolves to 'hidden' here.
      return c.offsetParent !== null && getComputedStyle(c).visibility !== 'hidden';
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      requestAnimationFrame(() => {
        if (!isPaneOnScreen()) return;
        forceRedraw();
        // Second pass after layout settles
        setTimeout(forceRedraw, 80);
      });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Handle display DPI scaling / moving window across high-DPI monitors
    let dprMediaQuery: MediaQueryList | null = null;
    const handleDprChange = () => {
      forceRedraw();
      scheduleFit();
    };
    if (typeof window !== 'undefined' && window.matchMedia) {
      try {
        dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dprMediaQuery.addEventListener('change', handleDprChange);
      } catch {}
    }

    // Paste element context from the web preview inspector into this terminal pane
    const unsubInput = terminalInputRequest.subscribe((req) => {
      if (req && req.sessionId === sessionId && termRef.current) {
        termRef.current.paste(req.text);
        terminalInputRequest.set(null);
      }
    });

    // OS file drops into this terminal pane. When a user drags a file from the
    // OS file manager onto this pane, write its path as terminal input — the
    // running agent (Claude Code, Codex, etc.) receives it as pasted text.
    // Registered once per mounted pane; the FloatingPromptBar handles drops on
    // itself separately, so they never conflict.
    let unlistenOsDrop: (() => void) | undefined;
    if (isTauriRuntime()) {
      getCurrentWindow().onDragDropEvent((event) => {
        if (disposed) return;
        if (event.payload.type !== 'drop') return;
        const payload = event.payload as any;
        const paths: string[] = payload.paths ?? [];
        if (!paths.length) return;
        const pos = payload.position as { x: number; y: number } | undefined;
        if (!pos) return;

        const c = containerRef.current;
        if (!c) return;

        void dropPositionToCss(pos).then((css) => {
          if (disposed || !css) return;

          // Hidden rooms (parked project layers, stage-hidden panes) stay laid
          // out at full size, so their rects contain every drop point. Hidden
          // layers are `visibility: hidden` + `pointer-events: none`, which the
          // container inherits — reject those before the rect test.
          const style = getComputedStyle(c);
          if (style.visibility === 'hidden' || style.pointerEvents === 'none') return;

          // Only handle drops within this pane's container
          const rect = c.getBoundingClientRect();
          if (
            css.x < rect.left || css.x > rect.right ||
            css.y < rect.top || css.y > rect.bottom
          ) return;

          // Don't steal drops from the floating prompt bar
          const barEl = document.querySelector('#floating-prompt-bar');
          if (barEl) {
            const barRect = barEl.getBoundingClientRect();
            if (
              css.x >= barRect.left && css.x <= barRect.right &&
              css.y >= barRect.top && css.y <= barRect.bottom
            ) return;
          }

          // Write each path as quoted text into the terminal
          const text = paths
            .map((p) => p.replace(/\\/g, '/'))
            .map((p) => (p.includes(' ') ? `"${p}"` : p))
            .join(' ');
          writeToSession(sessionId, text);
        });
      }).then((u) => {
        if (disposed) u();
        else unlistenOsDrop = u;
      });
    }

    return () => {
      disposed = true;
      unlistenOsDrop?.();
      if (executingTimeout) clearTimeout(executingTimeout);
      document.removeEventListener('pane-resize-end', onResizeEnd);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (dprMediaQuery) {
        try {
          dprMediaQuery.removeEventListener('change', handleDprChange);
        } catch {}
      }
      unsubInput();
      if (fitRafRef.current !== null) cancelAnimationFrame(fitRafRef.current);
      if (fitTimerRef.current !== null) clearTimeout(fitTimerRef.current);
      resizeObserver?.disconnect();
      container.removeEventListener('mousedown', handleTerminalLinkMouseDown, true);
      container.removeEventListener('mouseup', handleTerminalLinkMouseUp, true);
      container.removeEventListener('mouseup', handleTerminalCopyOnSelect);
      container.removeEventListener('mousedown', handleTerminalMiddleClickPaste);
      unregisterDataCallback(sessionId);
      unregisterExitCallback(sessionId);
      // Dispose the WebGL addon before the terminal so its GPU context is
      // released cleanly rather than leaked.
      webglAddonRef.current?.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      canvasAddonRef.current = null;
      webglAddonRef.current = null;
    };
    // Intentionally mirrors mount/unmount: this effect runs once
    // per mounted session and tears down fully on unmount. Reactive prop/store
    // changes (theme, font, renderer, shell) are applied through the separate
    // effects below instead of re-running this setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Restart the session when the configured default shell changes.
  useEffect(() => {
    const shellValue = configuredShell || '';
    if (currentShellRef.current === null) {
      currentShellRef.current = shellValue;
      return;
    }
    if (currentShellRef.current !== shellValue) {
      currentShellRef.current = shellValue;
      restartSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuredShell]);

  useEffect(() => {
    if (fitAddonRef.current) {
      scheduleFit();
      if (isActive || isMaximized) {
        requestAnimationFrame(() => termRef.current?.focus());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isMaximized]);

  // When this pane becomes active, flush any stale atlas state accumulated while idle.
  // Covers the case where an inactive pane's canvas drifts while another pane was focused.
  useEffect(() => {
    if (isActive && termRef.current) {
      requestAnimationFrame(() => forceRedraw());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    let cancelled = false;
    const applyFontOptions = async () => {
      try {
        await document.fonts.ready;
      } catch {}
      if (cancelled || !termRef.current) return;

      const t = termRef.current;
      const fontChanged = t.options.fontFamily !== fontFamily || t.options.fontSize !== fontSize;
      t.options.fontFamily = fontFamily;
      t.options.fontSize = fontSize;
      t.options.cursorStyle = cursorStyle;
      t.options.scrollback = scrollback;
      t.options.windowsPty = windowsPty;
      if (fontChanged && webglAddonRef.current) {
        // WebGL addon caches glyphs in a GPU texture atlas keyed by the font.
        // Just setting term.options.fontFamily doesn't reliably flush this
        // cache — the old glyph bitmaps stay on the GPU and the terminal keeps
        // displaying them. Recreating the addon is the only guaranteed way to
        // rebuild the atlas with the new font.
        webglAddonRef.current.dispose();
        webglAddonRef.current = null;
        applyTerminalRenderer();
      } else {
        forceRedraw();
        scheduleFit();
      }
    };

    void applyFontOptions();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontFamily, fontSize, cursorStyle, scrollback, windowsPty]);

  useEffect(() => {
    if (termRef.current) {
      applyTerminalRenderer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer]);

  useEffect(() => {
    const term = termRef.current;
    if (term && activeThemeValue) {
      term.options.allowTransparency = true;
      // Re-applied on every theme change. Note this only re-themes xterm itself —
      // a TUI already running keeps whatever palette it chose at launch, which is
      // exactly why buildTerminalTheme() no longer varies by mode.
      term.options.theme = buildTerminalTheme();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThemeValue]);

  const classNames = [
    'terminal-pane',
    isActive && 'active',
    isDead && 'dead',
    isMaximized && 'maximized',
    isDragOver && 'drag-over',
    sessionInfo?.agentPreset && 'agent-pane',
    sessionInfo?.agentPreset && `agent-${sessionInfo.agentPreset}`,
    sessionInfo?.isExecuting && 'agent-executing',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classNames}
      onClick={onActivate}
      onContextMenu={handleContextMenu}
      style={{ '--terminal-font-family': fontFamily } as React.CSSProperties}
    >
      {onResizeLeft && (
        <div
          className="pane-resize-handle pane-resize-left"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeLeft(e);
          }}
        ></div>
      )}
      {onResizeRight && (
        <div
          className="pane-resize-handle pane-resize-right"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeRight(e);
          }}
        ></div>
      )}
      {onResizeTop && (
        <div
          className="pane-resize-handle pane-resize-top"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeTop(e);
          }}
        ></div>
      )}
      {onResizeBottom && (
        <div
          className="pane-resize-handle pane-resize-bottom"
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeBottom(e);
          }}
        ></div>
      )}

      {/* Pane title bar with role picker */}
      <div
        className={`pane-titlebar${onPaneDragStart ? ' draggable' : ''}`}
        onMouseDown={handleTitlebarMouseDown}
      >
        {/* Close button on the left */}
        <button
          className="pane-close-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close pane"
        >
          <svg width="9" height="9" viewBox="0 0 9 9">
            <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>

        <span className="pane-title" title={paneTitleText}>
          {agentName && <span className="pane-agent-badge">{agentName}</span>}
          <span className="pane-title-copy">
            <span className="pane-title-main">
              {sessionInfo?.role && (
                <span className="role-dot" style={{ background: getRoleColor(sessionInfo.role) }}></span>
              )}
              {paneTitleText}
            </span>
            {paneSecondaryText && <span className="pane-title-summary">{paneSecondaryText}</span>}
          </span>
        </span>

      </div>

      {/* Command history blocks above the live terminal */}

      {/* xterm.js fills all remaining space — click and type directly.
          Bare container, matching the Svelte original: xterm handles its own
          mousedown→textarea focus internally, and pane activation comes from the
          outer div's onClick + term.onKey. An onFocus/onMouseDown handler here
          that both activates AND calls term.focus() created a focus→activate→
          refocus loop that repainted every frame (the flicker). */}
      <div className="xterm-container" ref={containerRef}></div>
    </div>
  );
}

// Memoized so a shell re-render for an unrelated reason (a toast, a layout flag
// the pane doesn't read) doesn't re-render the live xterm. The pane already
// subscribes to its own stores with narrow selectors, so it re-renders only for
// its own data changes plus actual prop changes (sessionId, isActive, callbacks).
export default memo(TerminalPane);
