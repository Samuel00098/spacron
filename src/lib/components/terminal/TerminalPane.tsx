import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { get } from '$lib/stores/storeCompat';
import { remoteTarget } from '$lib/stores/remoteWorkspace';
import { copyTextToClipboard, readImageFromClipboard, readTextFromClipboard } from '$lib/utils/clipboard';
import { isTauriRuntime, dropPositionToCss } from '$lib/utils/tauri';
import { isPointOverDropTarget } from '$lib/utils/drop-target';
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
  isOrchestratorTrackedSession,
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
import { showTerminal } from '$lib/stores/layout';
import { activeProject, projects } from '$lib/stores/workspace';
import { currentUrl, openUrlInPreviewPanel } from '$lib/stores/preview';
import { showToast } from '$lib/stores/notification';
import TerminalChatView from './TerminalChatView';
import ContextHandoffButton from './ContextHandoffButton';
import { canShowTerminalChat, setTerminalChatView, useTerminalChatView } from '$lib/services/terminal-chat';
import { appendRunOutput, finalizeRunEntry, activeRunIds } from '$lib/stores/runHistory';
import { attentionReason, containsAttentionRequest } from '$lib/services/orchestrator/agent-signals';
import { hasTurnSignalListener } from '$lib/services/orchestrator/agent-hook-signals';
import { useStore } from '$lib/react/useStore';
import { registerTerminalScreen } from '$lib/services/terminal-screen';
import { noteTerminalInput } from '$lib/services/terminal-chat-commands';
import { useStructuredChatPane, structuredChatPreset } from '$lib/services/structured-chat/panes';
import { startSessionStore } from '$lib/services/structured-chat/session-store';
import { canContinueInChat, continueInChat, continueInTerminal } from '$lib/services/structured-chat/switch';
import './TerminalPane.css';

// Durable records + event journal for structured chat panes.
startSessionStore();

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
// Quiet time after the last observed size change before the heavyweight settle
// pass runs. Every live frame re-arms it, so during a drag or a CSS layout
// transition it simply keeps sliding and lands once, at the end.
const SETTLE_FIT_MS = 350;
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

const openUrlInPreview = openUrlInPreviewPanel;

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
  // Zero-padding host INSIDE the styled container. xterm is opened into this,
  // not into the container itself: FitAddon measures the terminal element's
  // PARENT and subtracts only that element's own padding — it never subtracts
  // our container's 6/6/8px padding (and the container is box-sizing:
  // border-box, so its computed size includes it). Opening straight into the
  // container made fit believe there was ~12px more width and ~14px more
  // height than really existed: one phantom column + row beyond the padded
  // box, sheared away by the container's overflow:hidden — the "letters cut
  // off" artifact. Measuring against a padding-free host restores exact fit.
  const fitHostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const canvasAddonRef = useRef<CanvasAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const hoveredTerminalLinkRef = useRef<string | null>(null);
  const oscSequenceRemainderRef = useRef('');
  const fitRafRef = useRef<number | null>(null);
  // Set when a live frame resized the grid without flushing the glyph atlas.
  // The settle pass owes that flush even if it finds nothing left to resize.
  const liveFitDirtyRef = useRef(false);
  // Only the latest layout measurement may perform the delayed settled fit.
  // During a room/layer transition ResizeObserver can report several sizes;
  // keeping one timer prevents stale callbacks from competing with the newest
  // grid and making the terminal visibly jump between geometries.
  const settledFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A layout switch can leave the xterm grid at the same integer dimensions
  // even though the agent pane was hidden/revealed or moved between stage
  // arrangements. In that case xterm has nothing to emit through onResize, so
  // the child TUI may keep its old frame. Keep the repaint kick cancellable so
  // rapid layout changes cannot restore an obsolete PTY size after a newer fit.
  const ptyResizeKickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentShellRef = useRef<string | null>(null);
  const isActiveRef = useRef(isActive);
  const seenDevUrlsRef = useRef<Set<string>>(new Set());
  const seenBuildRef = useRef(false);
  const lastAgentAttentionAtRef = useRef(0);
  // The question last alerted for, so a TUI redrawing it never alerts again.
  const lastAgentAttentionTextRef = useRef('');

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
  const structuredChat = useStructuredChatPane(sessionId);
  const structuredPreset = structuredChat ? structuredChatPreset(sessionId) : null;
  const effectiveAgentPreset = sessionInfo?.agentPreset ?? structuredPreset;
  // The agent this pane runs, for the keystroke watcher set up once in the xterm effect.
  const agentPresetRef = useRef<string | null>(null);
  agentPresetRef.current = sessionInfo?.agentPreset ?? null;
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
    // A live turn watcher turns this same prompt into the durable completion
    // card/inbox entry. The terminal toast is only the safety net for an
    // unwatched follow-up; letting both paths run double-notifies one question.
    if (hasTurnSignalListener(sessionId)) return;
    // Same for any agent the orchestrator owns (adopted or dispatched, which
    // covers the spawn panel and a typed launch): its turn watcher files the
    // needs-input card and OS notification once per turn. This toast ran
    // beside it on every output chunk, so a CLI redrawing a question it had
    // already asked re-alerted every cooldown: the same notification again.
    if (isOrchestratorTrackedSession(sessionId)) return;
    // The strict matcher: a prose question counts only with a real choice on
    // screen, so a finished reply ending "Do you want to...?" is not a gate.
    if (!containsAttentionRequest(text)) return;
    // Once per question, however often the screen redraws it.
    const question = attentionReason(text);
    if (question === lastAgentAttentionTextRef.current) return;
    const now = Date.now();
    if (now - lastAgentAttentionAtRef.current < AGENT_ATTENTION_COOLDOWN) return;
    lastAgentAttentionAtRef.current = now;
    lastAgentAttentionTextRef.current = question;
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

  function forceRedraw(remeasureCell = false) {
    const term = termRef.current;
    if (!term) return;
    try {
      if (remeasureCell) {
        // xterm measures its cell before a late system/web font or a new Windows
        // display scale may have settled. A valid-but-stale cached value is more
        // dangerous than a zero one: fit succeeds, but the PTY wraps at columns
        // that no longer match the pixels being painted.
        ((term as any)._core as any)?._charSizeService?.measure?.();
      }
      (term as any).clearTextureAtlas?.();
      canvasAddonRef.current?.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    } catch {}
  }

  // The terminal stays dark in both app modes. Its dark-mode grey matches the
  // surrounding panels; light mode keeps the black content well for ANSI text.
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
  //
  // Every renderer carries the surface's real RGB, read from the same token that
  // paints the scrim (`--terminal-surface-rgb`). Canvas/DOM used to carry black
  // at alpha 0, so on the grey panel every CLI that shades its own chrome
  // against the reported background (Codex's input box, Claude Code's prompt
  // bar) blended toward black and landed on the panel's own grey: invisible.
  // A CLI reads this once at launch, so an agent started before a theme switch
  // keeps its old shade until it is restarted.
  function terminalBackground() {
    const fallback = isLightTheme ? '0, 0, 0' : '16, 16, 16';
    const rgb = typeof document === 'undefined'
      ? fallback
      : getComputedStyle(document.documentElement).getPropertyValue('--terminal-surface-rgb').trim() || fallback;
    return renderer === 'webgl' ? `rgb(${rgb})` : `rgba(${rgb}, 0)`;
  }

  // The terminal's palette is deliberately independent from the app theme.
  // Agent CLIs communicate their UI through ANSI (including truecolor), and
  // remapping the 16 ANSI slots to Spacron semantic/syntax colors makes Codex,
  // Claude, Gemini and any future agent look wrong. Keep xterm's native ANSI
  // palette so every agent's emitted color means what it meant in its own CLI.
  // The terminal surface itself remains dark and transparent; only the palette
  // is native.
  function buildTerminalTheme() {
    return {
      background: terminalBackground(),
      foreground: '#ffffff',
      cursor: '#ffffff',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255, 255, 255, 0.3)',
      // A standard dark-terminal palette (VS Code's), which is tuned for a
      // grey ~#1e1e1e surface like ours. xterm's Tango defaults were built for
      // black and read muddy on the grey panel. Do not replace these with app
      // theme tokens: ANSI color codes belong to the child process.
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5',
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

  function waitForOpenDimensions(target: HTMLDivElement, isCancelled: () => boolean) {
    return new Promise<boolean>((resolve) => {
      if (target.clientWidth > 0 && target.clientHeight > 0) {
        resolve(true);
        return;
      }
      let settled = false;
      const pollTimer = window.setInterval(() => {
        if (isCancelled()) cancel();
        else if (target.clientWidth > 0 && target.clientHeight > 0) finish(true);
      }, 100);
      const finish = (_ready: boolean) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        window.clearInterval(pollTimer);
        resolve(true);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        window.clearInterval(pollTimer);
        resolve(false);
      };
      const observer = new ResizeObserver(() => {
        if (isCancelled()) cancel();
        else if (target.clientWidth > 0 && target.clientHeight > 0) finish(true);
      });
      observer.observe(target);
      // Never open xterm into a zero-sized element. xterm measures its character
      // cell when open() runs and does not reliably recover if that measurement
      // happens against a collapsed split pane. The ResizeObserver handles the
      // normal layout transition; the short poll also catches a host whose
      // ancestor changed size without producing a child observer notification.
      if (isCancelled()) cancel();
    });
  }

  // FitAddon's proposal, pixel-proven against the fit host. The addon floors
  // cols/rows from cell size, but cell size itself is device pixels divided
  // back down by DPR — on fractional-DPR WebViews the CSS cell can round UP
  // past the host edge, so the last column/row gets sheared by overflow:hidden
  // while the PTY is told a grid wider/taller than the user can see (its line
  // wraps then land at invisible columns — text "in random places"). Walk
  // columns/rows back until cols*cellW and rows*cellH fit the host's real box.
  // Renderer-agnostic: this runs before any renderer draws, so DOM, canvas and
  // WebGL all inherit the same guarantee.
  // The CSS size of one character cell, re-measuring if xterm's cached value is
  // unusable.
  //
  // xterm measures the cell exactly once, off the element it was opened into.
  // If a pane is mounted behind a layout transition (a fresh split, a room that
  // is still animating in, or a project layer being revealed), opening xterm at
  // 0x0 measures a zero-wide character cell. Nothing in xterm reliably re-runs
  // that measurement, so the grid can remain at its 80x24 default while the
  // pane is much narrower and clips instead of wrapping. waitForOpenDimensions
  // prevents that poisoned initialization; measuredCell remains a recovery
  // guard for panes restored from older versions.
  function measuredCell(): { width: number; height: number } | null {
    const core = (termRef.current as any)?._core;
    const usable = (c: any) => !!c && c.width > 0 && c.height > 0;
    let cell = core?._renderService?.dimensions?.css?.cell;
    if (!usable(cell)) {
      try {
        core?._charSizeService?.measure?.();
      } catch {}
      cell = core?._renderService?.dimensions?.css?.cell;
    }
    return usable(cell) ? { width: cell.width, height: cell.height } : null;
  }

  function clampedProposal(
    fa: FitAddon,
    host: HTMLDivElement,
  ): { cols: number; rows: number } {
    const cell = measuredCell();
    let proposed: { cols?: number; rows?: number } | undefined;
    try {
      proposed = fa.proposeDimensions();
    } catch {
      proposed = undefined;
    }
    let { cols = 0, rows = 0 } = proposed ?? {};
    if (cell) {
      // The addon still declines to propose whenever it measured the cell as
      // zero before our re-measure above landed. Now that we have a real cell,
      // derive the grid ourselves rather than bailing and leaving the pane
      // stuck at the default 80x24.
      if (!cols || !rows) {
        cols = Math.floor(host.clientWidth / cell.width);
        rows = Math.floor(host.clientHeight / cell.height);
      }
      while (
        cols > MIN_COLS &&
        cols * cell.width > host.clientWidth + 0.5
      ) cols -= 1;
      while (
        rows > MIN_ROWS &&
        rows * cell.height > host.clientHeight + 0.5
      ) rows -= 1;
    }
    return { cols: Math.max(0, cols), rows: Math.max(0, rows) };
  }

  /**
   * Measure the host and resize the grid to match it.
   *
   * `live` marks one frame of a resize that is still in progress: another frame
   * is probably coming, so only the cheap half runs — measure, drop the stale
   * frame, `term.resize()`. The expensive half (glyph-atlas flush, full
   * refresh, geometry persistence) is left to the settle pass below.
   *
   * This used to be a single pass behind a trailing debounce, which meant no
   * fit ran at all while the user was actually dragging: ResizeObserver fires
   * every frame, each call re-armed the timer, and the grid kept its old pixel
   * size inside the moving box — a blank band while growing, clipped text while
   * shrinking, then a snap once the drag paused. Native terminals (Windows
   * Terminal, Terminal.app) reflow on every frame, so we do too. The stated
   * reason for the debounce — "running 60x/s corrupts xterm's render pipeline"
   * — was the texture-atlas flush being thrashed once per frame; that is now
   * settle-only, and the cell size never changes across a resize, so a mid-drag
   * frame can safely keep painting from the atlas it already has.
   */
  function applyFit(live: boolean) {
    const container = containerRef.current;
    const fitHost = fitHostRef.current;
    const fitAddon = fitAddonRef.current;
    const term = termRef.current;
    if (!container || !fitHost || !fitAddon || !term) return;
    // Measure the host (the box FitAddon actually uses), not the padded
    // container — a degenerate host must skip the same way the old
    // container guard did.
    if (fitHost.clientWidth <= 0 || fitHost.clientHeight <= 0) return;
    try {
      // Pixel-proofed proposal — see clampedProposal for why the raw addon
      // proposal can overshoot the visible box on fractional-DPR WebViews.
      // Checked BEFORE resizing, and the degenerate-atlas guard still skips
      // panes too small to produce a valid atlas.
      const { cols, rows } = clampedProposal(fitAddon, fitHost);
      // Validity guard, load-bearing on every pass and not just the settled
      // one: a pane that is hidden or mid-transition proposes nothing, and
      // resizing with 0x0 makes xterm silently clamp to its 2x1 minimum and
      // report that through onResize — shrinking the *PTY* to two columns and
      // scrambling everything the shell draws afterwards.
      if (!cols || !rows || cols < MIN_COLS || rows < MIN_ROWS) return;

      const sizeChanged = cols !== term.cols || rows !== term.rows;
      if (sizeChanged) {
        // FitAddon.fit() always clears the render service before resizing —
        // it drops the stale painted frame so the new grid renders from
        // scratch. Skipping it (as a plain term.resize does) leaves the old
        // frame in place; the resized pane then keeps painting from stale
        // state and text clips at the old grid edge on EVERY renderer, since
        // DOM/canvas/WebGL share the render service. The freshly-opened pane
        // has no stale frame, which is why only pre-existing panes clipped.
        ((term as any)._core as any)?._renderService?.clear?.();
        // xterm reflows its buffer here and fires onResize, which forwards the
        // new grid to the PTY — the SIGWINCH the shell re-wraps against.
        term.resize(cols, rows);
      }

      if (live) {
        if (sizeChanged) liveFitDirtyRef.current = true;
        return;
      }

      // One atlas flush per resize, owed on settle rather than per frame. The
      // atlas survives a grid resize on its own — the cell size does not change
      // — but a renderer whose atlas was evicted or left degenerate while the
      // pane was tiny or hidden repaints clean here.
      if (sizeChanged || liveFitDirtyRef.current) {
        liveFitDirtyRef.current = false;
        (term as any).clearTextureAtlas?.();
        canvasAddonRef.current?.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
      }

      // Teach the next spawn what a real pane measures, so a new PTY opens at
      // this grid instead of the 120x34 placeholder and never has to reflow.
      // Settled-only: mid-drag this would write localStorage once per column
      // crossed, and the steady-state size is the one worth remembering.
      recordTerminalGeometry(cols, rows);
    } catch {}
  }

  // Trailing pass, re-armed by every live frame so it lands exactly once: after
  // the drag stops, or after a CSS layout transition has finished emitting
  // sizes (vibe mode's grid transition runs 320ms and reports a box every
  // frame). It performs the atlas flush and records the steady-state geometry;
  // by the time it runs the grid is normally already correct, so it rarely
  // resizes anything — which is what removes the second, post-drag snap.
  function scheduleSettledFit() {
    if (settledFitTimerRef.current !== null) {
      clearTimeout(settledFitTimerRef.current);
    }
    settledFitTimerRef.current = setTimeout(() => {
      settledFitTimerRef.current = null;
      applyFit(false);
    }, SETTLE_FIT_MS);
  }

  // Fit now, at full weight, for a layout change that is already final.
  function doFit() {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
      fitRafRef.current = null;
    }
    applyFit(false);
    scheduleSettledFit();
  }

  // Live fit: one pass per animation frame for as long as the pane keeps
  // changing size, so the grid follows the drag instead of trailing it.
  // Coalesced rather than debounced — ResizeObserver can fire several times
  // between paints, and re-measuring twice in one frame cannot see a different
  // box anyway.
  function scheduleFit() {
    if (fitRafRef.current === null) {
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        applyFit(true);
      });
    }
    scheduleSettledFit();
  }

  async function fitAfterFonts() {
    try {
      await document.fonts.ready;
    } catch {}
    // `term.open()` necessarily ran before this await. Re-measure even when the
    // cached cell is non-zero: it may belong to the fallback font used while the
    // configured face was still loading.
    forceRedraw(true);
    doFit();
    setTimeout(() => {
      forceRedraw(true);
      doFit();
    }, 100);
  }

  // Force a running full-screen TUI (e.g. the Claude Code agent) to repaint when
  // this pane reattaches to a still-alive session. On a project switch the pane
  // unmounts and its xterm is disposed, but the PTY keeps running; coming back,
  // the fresh xterm fits to the SAME size the PTY already has, so no resize
  // reaches the app and it shows a stale frame until the user drags to resize.
  // We reproduce that manual resize: briefly shrink the PTY by one row, then
  // restore it — a genuine size change the TUI reacts to by redrawing. xterm
  // itself stays at its fitted size, so reverting immediately resyncs the two.
  function forcePtyRepaint() {
    const term = termRef.current;
    if (!term) return;
    const cols = term.cols;
    const rows = term.rows;
    if (!cols || !rows || rows < MIN_ROWS + 1) return;
    if (ptyResizeKickTimerRef.current !== null) {
      clearTimeout(ptyResizeKickTimerRef.current);
      ptyResizeKickTimerRef.current = null;
    }
    resizeSession(sessionId, rows - 1, cols);
    ptyResizeKickTimerRef.current = setTimeout(() => {
      ptyResizeKickTimerRef.current = null;
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
      pasteIntoTerminal(text);
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

  // Route every user-visible paste through xterm rather than writing directly
  // to the PTY. xterm normalizes line endings and, when the running program
  // enables it, wraps the payload in bracketed-paste markers. Direct PTY writes
  // make multiline clipboard text act like a stream of separate Enter presses
  // and can insert it at a surprising cursor position in a TUI composer.
  function pasteIntoTerminal(text: string) {
    if (!text) return;
    const term = termRef.current;
    if (!term) return;
    term.focus();
    term.paste(text);
  }

  // Quote only paths with spaces — agent TUIs resolve a quoted path to the
  // file, while always-quoting leaves literal quotes the CLI can't open.
  function quoteTerminalPath(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return normalized.includes(' ') ? `"${normalized}"` : normalized;
  }

  // Encode raw RGBA clipboard pixels into PNG bytes via a canvas. Used on the
  // Linux clipboard-image path, where the native plugin hands us raw pixels
  // rather than an encoded image.
  function rgbaToPngBytes(
    rgba: Uint8Array,
    width: number,
    height: number
  ): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        const imageData = new ImageData(
          new Uint8ClampedArray(rgba.buffer.slice(0, width * height * 4)),
          width,
          height
        );
        ctx.putImageData(imageData, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) {
            resolve(null);
            return;
          }
          void blob
            .arrayBuffer()
            .then((buffer) => resolve(new Uint8Array(buffer)))
            .catch(() => resolve(null));
        }, 'image/png');
      } catch {
        resolve(null);
      }
    });
  }

  // Save clipboard image bytes to the app scratch dir and paste the resulting
  // path through xterm (bracketed paste, no trailing Enter). This is the
  // standard "paste image into a terminal agent" flow — opencode, Claude Code
  // and similar TUIs read a pasted PNG/JPEG path as an image attachment. The
  // user presses Enter themselves to send it with their prompt.
  async function pasteImageBytesAsPath(
    bytes: Uint8Array,
    name: string
  ): Promise<boolean> {
    try {
      const savePath = await invoke<string>('save_pasted_image', {
        name,
        data: Array.from(bytes),
      });
      pasteIntoTerminal(quoteTerminalPath(savePath));
      return true;
    } catch (error) {
      console.error('Failed to paste image into terminal:', error);
      showToast('Could not paste the image', 'error');
      return false;
    }
  }

  // Clipboard paste that understands images. Text stays the fast path; when
  // the clipboard holds a bitmap (screenshot, copied picture) it is saved to
  // the scratch dir and its path is pasted instead, so TUI agents like
  // opencode receive it as an image attachment. Returns true when anything
  // was pasted.
  async function pasteClipboardWithImage(): Promise<boolean> {
    try {
      const image = await readImageFromClipboard();
      if (image) {
        const png = await rgbaToPngBytes(image.bytes, image.width, image.height);
        if (png) {
          await pasteImageBytesAsPath(png, `pasted-image-${Date.now()}.png`);
          return true;
        }
      }
    } catch {
      /* fall through to text */
    }
    try {
      const text = await readTextFromClipboard();
      if (text) {
        pasteIntoTerminal(text);
        return true;
      }
    } catch {}
    return false;
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
        await pasteClipboardWithImage();
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
    function handleDragMove(event: Event) {
      if (!explorerDragPathRef.current) return;
      const custom = event as CustomEvent<{ clientX?: number; clientY?: number }>;
      // Highlight follows the CURSOR. Hit-testing the pane's own centre instead
      // lit up whichever pane owned that point for the whole drag, no matter
      // where the pointer actually was.
      setIsDragOver(
        isPointOverDropTarget(containerRef.current, custom.detail?.clientX, custom.detail?.clientY),
      );
    }
    function handleDragEnd(event: Event) {
      const custom = event as CustomEvent<{ path?: string; clientX?: number; clientY?: number }>;
      const endedPath = custom.detail?.path?.trim() || explorerDragPathRef.current;
      const cx = custom.detail?.clientX;
      const cy = custom.detail?.clientY;
      // Hit-test, not a rect test: hidden rooms stay laid out at full stage
      // size, so a plain rect check made every mounted pane claim the drop and
      // the dragged path landed in every open agent terminal at once.
      const overPane = isPointOverDropTarget(containerRef.current, cx, cy);
      // Drop into this pane only if NOT also over the floating prompt bar
      let overBar = false;
      const barEl = document.querySelector('#floating-prompt-bar');
      if (barEl && typeof cx === 'number' && typeof cy === 'number') {
        const barRect = barEl.getBoundingClientRect();
        overBar = cx >= barRect.left && cx <= barRect.right && cy >= barRect.top && cy <= barRect.bottom;
      }
      const overChat = typeof cx === 'number' && typeof cy === 'number'
        && document.elementFromPoint(cx, cy)?.closest('.terminal-chat-view, .chat-mode-panel');
      if (endedPath && overPane && !overBar && !overChat) {
        const text = endedPath.replace(/\\/g, '/');
        pasteIntoTerminal(text);
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
    // FitAddon measures the element xterm is opened into and subtracts that
    // element's own padding — nothing else. The styled `.xterm-container`
    // carries the pane's 6/6/8px padding, so we open xterm into a dedicated
    // zero-padding host inside it; the host's full box IS the usable area.
    const fitHost = fitHostRef.current;
    if (!container || !fitHost) return;

    // Held outside the async open block below so the effect cleanup can
    // remove the DOM listeners even though registration happens after open.
    let domPasteHandler: ((event: ClipboardEvent) => void) | null = null;
    let htmlDragOverHandler: ((event: DragEvent) => void) | null = null;
    let htmlDropHandler: ((event: DragEvent) => void) | null = null;

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
      // Do not rewrite ANSI/truecolor output to satisfy a contrast ratio. That
      // changes the colors selected by agent CLIs and makes their normal UI
      // colors inconsistent with the same CLI in a native terminal.
      minimumContrastRatio: 1,
      windowsPty,
      theme: buildTerminalTheme(),
    });
    termRef.current = term;
    // Lets the chat and the agent cards read what this pane SHOWS rather than
    // the raw byte stream a full-screen TUI repaints (see terminal-screen.ts).
    const unregisterScreen = registerTerminalScreen(sessionId, term);

    // Don't answer OSC 10/11/12 color *queries* on a local Windows PTY. Codex
    // re-asks for the default colors every time its pane regains focus, and
    // ConPTY can't hand the reply back as a report: it re-encodes the bytes as
    // keystrokes, so the child reads `]10;rgb:ffff/ffff/ffff\` as typed input.
    // Unanswered, the CLI just keeps its default palette. Color *sets* (`10;#fff`)
    // still reach xterm's built-in handler, and a remote box's Unix PTY carries
    // the reply fine, so remote sessions keep answering.
    if (isWindowsHost && !get(remoteTarget)) {
      const swallowColorQuery = (data: string) => data.split(';').includes('?');
      for (const ident of [10, 11, 12]) term.parser.registerOscHandler(ident, swallowColorQuery);
    }

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
      void pasteClipboardWithImage();
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
      const hasOpenDimensions = await waitForOpenDimensions(fitHost, () => disposed);
      if (disposed || !hasOpenDimensions) return;

      term.open(fitHost);
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
      // Note this must stay a *client-side* repaint: forcePtyRepaint() would also
      // redraw, but it does so by round-tripping a real PTY resize, which would fire
      // SIGWINCH at the shell on every TUI enter/exit.
      term.buffer.onBufferChange(() => term.refresh(0, term.rows - 1));
      container.addEventListener('mousedown', handleTerminalLinkMouseDown, true);
      container.addEventListener('mouseup', handleTerminalLinkMouseUp, true);
      container.addEventListener('mouseup', handleTerminalCopyOnSelect);
      container.addEventListener('mousedown', handleTerminalMiddleClickPaste);

      // DOM paste: catches clipboard images (screenshots, copied pictures) that
      // the text-only key handler above can't see. Files come through
      // `clipboardData.files`, raw bitmaps through `clipboardData.items`.
      // Text is left to xterm's own paste path — handling it here too would
      // double-paste every Ctrl+V.
      const handleDomPaste = (event: ClipboardEvent) => {
        const clipboard = event.clipboardData;
        if (!clipboard) return;
        const files = Array.from(clipboard.files ?? []).filter((file) =>
          file.type.startsWith('image/')
        );
        const itemFile = !files.length
          ? Array.from(clipboard.items ?? [])
              .find((item) => item.type.startsWith('image/'))
              ?.getAsFile()
          : null;
        const imageFile = files[0] ?? itemFile;
        if (!imageFile) return;
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            const buffer = new Uint8Array(await imageFile.arrayBuffer());
            const ext = imageFile.type.includes('jpeg') || imageFile.type.includes('jpg')
              ? 'jpg'
              : imageFile.type.includes('gif')
                ? 'gif'
                : imageFile.type.includes('webp')
                  ? 'webp'
                  : 'png';
            await pasteImageBytesAsPath(buffer, `pasted-image-${Date.now()}.${ext}`);
          } catch (error) {
            console.error('Failed to paste image into terminal:', error);
          }
        })();
      };
      container.addEventListener('paste', handleDomPaste as EventListener);

      // HTML5 file drops: the fallback for non-Tauri runtimes (plain-browser
      // dev sessions) where `onDragDropEvent` never fires. In Tauri the OS
      // handler below owns drops, so this only acts when files are present.
      const handleHtmlFileDrop = (event: DragEvent) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const paths: string[] = [];
          for (const file of Array.from(files)) {
            try {
              // Real OS paths aren't exposed in the browser; persist the bytes
              // so the agent gets a real file it can read.
              const buffer = new Uint8Array(await file.arrayBuffer());
              const savePath = await invoke<string>('save_pasted_image', {
                name: (file as File).name || `dropped-file-${Date.now()}`,
                data: Array.from(buffer),
              });
              paths.push(quoteTerminalPath(savePath));
            } catch (error) {
              console.error('Failed to drop file into terminal:', error);
            }
          }
          if (paths.length) pasteIntoTerminal(paths.join(' '));
        })();
      };
      const handleHtmlDragOver = (event: DragEvent) => {
        if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
      };
      container.addEventListener('dragover', handleHtmlDragOver);
      container.addEventListener('drop', handleHtmlFileDrop);
      domPasteHandler = handleDomPaste as unknown as (event: ClipboardEvent) => void;
      htmlDragOverHandler = handleHtmlDragOver;
      htmlDropHandler = handleHtmlFileDrop;

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
          if (isReattach) forcePtyRepaint();
        }),
      );

      term.onData((data: string) => {
        // Drop xterm's synthetic query replies emitted while replaying history (see
        // the reattach buffer write above); genuine keystrokes still pass through.
        if (suppressReplayInput) return;
        // Slash commands typed here show in the chat view too (Claude Code
        // records its own; the other CLIs only draw them on screen).
        if (agentPresetRef.current) noteTerminalInput(sessionId, agentPresetRef.current, data);
        writeToSession(sessionId, data);
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => resizeSession(sessionId, rows, cols));
      term.onKey(() => {
        if (!isActiveRef.current) onActivate();
      });

      registerDataCallback(sessionId, (bytes: Uint8Array, text: string) => {
        term.write(bytes);
        // Input marks a session busy when a command/prompt is submitted, but a
        // quiet task can outlive the 800 ms output-idle window below. Codex's
        // spinner usually keeps emitting, which masked this for quieter agent
        // CLIs and ordinary shell commands. Any new live PTY output means the
        // session is active again, regardless of which program produced it.
        if (!isSessionExecutingNow(sessionId)) {
          setSessionExecuting(sessionId, true);
        }
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

      // Observe the fit host, not just the padded container: it is the exact
      // box FitAddon measures, so every resize it reports is one fit can honor.
      // The container is observed as a second signal because a parent grid or
      // visibility-layer transition can resize the flex chain without always
      // delivering a child-content notification in WebView2/WebKitGTK.
      resizeObserver = new ResizeObserver(scheduleFit);
      resizeObserver.observe(fitHost);
      resizeObserver.observe(container);
    })();

    // A layout change the pane cannot observe for itself (a room promoted into
    // focus, a pane revealed from `visibility: hidden`). Drop any live frame
    // still queued and fit at full weight against the final layout.
    function onResizeEnd(event: Event) {
      const forcePtyResize = Boolean(
        (event as CustomEvent<{ forcePtyResize?: boolean }>).detail?.forcePtyResize,
      );
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
        // xterm only emits onResize when its integer grid changes. A layout
        // switch can reveal the same-sized grid in a new arrangement, while a
        // full-screen child TUI still needs a SIGWINCH to redraw its viewport.
        // Do this only for explicit layout/retile signals, never for ordinary
        // font/DPI or container resize work.
        if (forcePtyResize) forcePtyRepaint();
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

    // Handle display DPI scaling / moving window across high-DPI monitors.
    // A resolution media query fires only when its own boolean result changes;
    // after leaving 1dppx it stays false at both 1.25 and 1.5, so a one-shot
    // listener misses the second monitor move. Re-arm for the new DPR each time.
    let dprMediaQuery: MediaQueryList | null = null;
    const handleDprChange = () => {
      armDprListener();
      requestAnimationFrame(() => {
        forceRedraw(true);
        scheduleFit();
      });
    };
    const armDprListener = () => {
      if (dprMediaQuery) {
        try {
          dprMediaQuery.removeEventListener('change', handleDprChange);
        } catch {}
      }
      dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMediaQuery.addEventListener('change', handleDprChange);
    };
    if (typeof window !== 'undefined') {
      try {
        armDprListener();
      } catch {}
    }

    // A configured font can finish loading after document.fonts.ready was first
    // observed (for example after a settings change). Re-fit every live pane at
    // the exact moment glyph metrics become authoritative.
    const handleFontsLoaded = () => {
      requestAnimationFrame(() => {
        forceRedraw(true);
        scheduleFit();
      });
    };
    document.fonts.addEventListener('loadingdone', handleFontsLoaded);

    // Paste element context from the web preview inspector into this terminal pane
    const unsubInput = terminalInputRequest.subscribe((req) => {
      if (req && req.sessionId === sessionId && termRef.current) {
        pasteIntoTerminal(req.text);
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

          // Only handle drops within this pane's container, and only while this
          // pane is the one on screen at that point — hidden rooms (parked
          // project layers, stage-hidden panes) stay laid out at full size, so
          // their rects contain every drop point.
          if (!isPointOverDropTarget(c, css.x, css.y)) return;
          if (document.elementFromPoint(css.x, css.y)?.closest('.terminal-chat-composer')) return;

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
          pasteIntoTerminal(text);
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
      document.fonts.removeEventListener('loadingdone', handleFontsLoaded);
      unsubInput();
      if (fitRafRef.current !== null) cancelAnimationFrame(fitRafRef.current);
      if (settledFitTimerRef.current !== null) clearTimeout(settledFitTimerRef.current);
      if (ptyResizeKickTimerRef.current !== null) clearTimeout(ptyResizeKickTimerRef.current);
      resizeObserver?.disconnect();
      container.removeEventListener('mousedown', handleTerminalLinkMouseDown, true);
      container.removeEventListener('mouseup', handleTerminalLinkMouseUp, true);
      container.removeEventListener('mouseup', handleTerminalCopyOnSelect);
      container.removeEventListener('mousedown', handleTerminalMiddleClickPaste);
      if (domPasteHandler) container.removeEventListener('paste', domPasteHandler as EventListener);
      if (htmlDragOverHandler) container.removeEventListener('dragover', htmlDragOverHandler);
      if (htmlDropHandler) container.removeEventListener('drop', htmlDropHandler);
      unregisterDataCallback(sessionId);
      unregisterExitCallback(sessionId);
      unregisterScreen();
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
      const effectiveFontSize = fontSize;
      const fontChanged = t.options.fontFamily !== fontFamily || t.options.fontSize !== effectiveFontSize;
      t.options.fontFamily = fontFamily;
      t.options.fontSize = effectiveFontSize;
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

  const chatCapable = canShowTerminalChat(sessionInfo?.agentPreset) || canContinueInChat(sessionInfo?.agentPreset) || Boolean(structuredChat);
  const chatViewOn = useTerminalChatView(sessionId);
  const showChat = !structuredChat && canShowTerminalChat(sessionInfo?.agentPreset) && chatViewOn && !!sessionInfo?.agentPreset;
  const chatActive = showChat || Boolean(structuredChat);

  // Leaving chat hands the keyboard back to the terminal.
  const wasChatRef = useRef(chatActive);
  useEffect(() => {
    if (wasChatRef.current && !chatActive) {
      requestAnimationFrame(() => {
        scheduleFit();
        termRef.current?.focus();
      });
    }
    wasChatRef.current = chatActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatActive]);

  const classNames = [
    'terminal-pane',
    chatActive && 'chat-view',
    structuredChat && 'structured-chat',
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

        {(sessionInfo?.agentPreset || structuredChat) && (
          <ContextHandoffButton
            sessionId={sessionId}
            sourceAgentName={agentName ?? sessionInfo?.agentPreset ?? structuredChatPreset(sessionId) ?? 'Agent'}
            sourcePreset={sessionInfo?.agentPreset ?? structuredChatPreset(sessionId)}
            chatActive={chatActive}
          />
        )}

        {chatCapable && (
          <div
            className="pane-view-switch"
            role="group"
            aria-label="Pane view"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={chatActive ? '' : 'active'}
              aria-pressed={!chatActive}
              aria-label="Terminal view"
              title={structuredChat ? 'Continue in the terminal, same conversation (Ctrl+Shift+J)' : 'Terminal (Ctrl+Shift+J)'}
              onClick={(e) => {
                e.stopPropagation();
                onActivate();
                if (structuredChat) void continueInTerminal(sessionId);
                else setTerminalChatView(sessionId, false);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <path d="m7.5 9.5 3 2.5-3 2.5M13 15h3.5" />
              </svg>
            </button>
            <button
              type="button"
              className={chatActive ? 'active' : ''}
              aria-pressed={chatActive}
              aria-label="Chat view"
              title="Chat, same session (Ctrl+Shift+J)"
              onClick={(e) => {
                e.stopPropagation();
                onActivate();
                if (structuredChat) return;
                void continueInChat(sessionId).then((handled) => {
                  if (!handled) setTerminalChatView(sessionId, true);
                });
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20.5l1.4-4.6A7.5 7.5 0 1 1 20 12.5z" />
              </svg>
            </button>
          </div>
        )}

      </div>

      {/* Command history blocks above the live terminal */}

      {/* xterm.js fills all remaining space — click and type directly.
          Bare container, matching the Svelte original: xterm handles its own
          mousedown→textarea focus internally, and pane activation comes from the
          outer div's onClick + term.onKey. An onFocus/onMouseDown handler here
          that both activates AND calls term.focus() created a focus→activate→
          refocus loop that repainted every frame (the flicker). */}
      {/* The body holds the terminal and, in chat view, the chat over it. The
          chat is a sibling rather than a child of .xterm-container: global.css
          treats everything inside that container as raw terminal output and
          drops the app's typography there. */}
      <div className="pane-body">
        <div className="xterm-container" ref={containerRef}>
          <div className="xterm-fit-host" ref={fitHostRef}></div>
        </div>
        {chatActive && effectiveAgentPreset && (
          <TerminalChatView
            key={`${effectiveAgentPreset}:${structuredChat ?? 'terminal'}`}
            sessionId={sessionId}
            agentPreset={effectiveAgentPreset}
            isRunning={Boolean(sessionInfo?.isRunning)}
            worktree={sessionInfo?.worktree ?? null}
            structuredAgent={structuredChat}
            onOpenTerminal={structuredChat ? () => void continueInTerminal(sessionId) : undefined}
          />
        )}
      </div>
    </div>
  );
}

// Memoized so a shell re-render for an unrelated reason (a toast, a layout flag
// the pane doesn't read) doesn't re-render the live xterm. The pane already
// subscribes to its own stores with narrow selectors, so it re-renders only for
// its own data changes plus actual prop changes (sessionId, isActive, callbacks).
export default memo(TerminalPane);
