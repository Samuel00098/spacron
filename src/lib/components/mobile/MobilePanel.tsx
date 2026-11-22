import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import Dropdown from '$lib/components/shared/Dropdown.tsx';
import './MobilePanel.css';
import { meshScreenPoint } from './meshScreen';
import { resolveDeviceProfile } from './deviceProfile';
import { nextSelectedSerial } from './deviceSelection';
import DeviceToolsPanel from './DeviceToolsPanel';
import { showToast } from '$lib/stores/notification';
import { useMjpegStream } from './useMjpegStream';
import { useScrcpyStream } from './useScrcpyStream';
import {
  formatStreamSideChoice,
  parseStreamSideChoice,
  resolveStreamSide,
  STREAM_SIDE_CHOICES,
  type StreamSideChoice,
} from './streamResolution';
import { sendStreamKey, sendStreamText, useStreamTouch, type FrameDims } from './useStreamInput';
import { useProjectPanelState } from '$lib/react/useProjectPanelState';
import { openMobileSidebar, releaseMobileSidebar, closeRightSidebar, setRightDrawerTool, toggleMobileVisible } from '$lib/stores/layout';
import { MobilePhone3D } from './MobilePhone3D';
import { unproject3dPoint } from './unproject3d';
import {
  advanceScroll,
  createWheelGestures,
  mouseButtonIntent,
  scrollAnchor,
  type GestureIntent,
} from './gestures';

interface AndroidDevice {
  serial: string;
  state: string;
  label: string;
  model?: string;
}

interface AndroidFrame {
  /** Base64 JPEG of the (downscaled) screen — no data-URL prefix. */
  image: string;
  /** Original device pixel dimensions, so taps can map to real coordinates. */
  width: number;
  height: number;
}

interface AndroidTools {
  adb: boolean;
  emulator: boolean;
}

interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

type MobileTab = 'android' | 'ios';

// Android keycodes for the hardware row (`adb shell input keyevent`).
const KEY_POWER = 26;
const KEY_HOME = 3;
const KEY_BACK = 4;
const KEY_RECENTS = 187;
const KEY_MENU = 82;
const KEY_VOL_UP = 24;
const KEY_VOL_DOWN = 25;

/** iOS orientations cycled by the rotate button, in serve-sim's vocabulary. */
const IOS_ORIENTATIONS = ['portrait', 'landscape_right', 'portrait_upside_down', 'landscape_left'] as const;

/** Live-mirror poll cadence for the Android screencap. */
const POLL_MS = 1000;
/**
 * How often to re-scan for devices while no live stream is up.
 *
 * Without this the device list was refreshed only when the tab changed, so an
 * emulator booted *outside* the panel (Android Studio, `emulator -avd`, or one
 * still booting when the pane opened) went unnoticed until someone pressed
 * Refresh — the pane sat on snapshots next to a perfectly streamable device.
 * Polling stops the moment a stream is live, because every adb call then
 * competes with the stream and with injected input for the same connection.
 */
const DEVICE_POLL_MS = 2000;
/**
 * How many times a failed live stream is retried before the panel settles for
 * snapshots. The common failure is a race, not a fault — an emulator that is
 * listed by adb but has not yet published its gRPC endpoint — so retrying a
 * few times converts "stuck in Snapshot forever" into a short delay.
 */
const STREAM_RETRY_LIMIT = 4;
/** First retry delay. Doubles per attempt: 1.5s, 3s, 6s, 12s. */
const STREAM_RETRY_BASE_MS = 1500;
/** iOS screenshot poll cadence (view-only mirror). */
const IOS_POLL_MS = 1500;

/**
 * How long the scrolling finger stays down after the last wheel event. Long
 * enough to keep one continuous scroll as one gesture (so the device flings
 * rather than stuttering), short enough that the finger lifts before the user
 * reaches for anything else.
 */
const SCROLL_IDLE_MS = 130;
/**
 * Wheel events are collected for this long before the snapshot fallback replays
 * them as a single `adb shell input swipe`. Each of those costs the better part
 * of a second, so sending one per wheel notch would queue up a scroll the user
 * stopped asking for ten notches ago.
 */
const POLL_SCROLL_FLUSH_MS = 140;

function Ico({ children, size = 15 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function isBooted(state: string | undefined) {
  return Boolean(state && state.toLowerCase().includes('booted'));
}

/**
 * Inline `aspect-ratio` for the device shell, taken from the live frame
 * dimensions. Without it the shell is content-sized (it wraps the canvas at
 * its natural size), so the canvas's own `max-height: 100%` resolves against
 * an `auto`-height parent and never shrinks — the phone then overflows the
 * stage and you have to scroll to see it all. A definite ratio lets the
 * stage's `max-width/max-height: 100%` scale the whole shell to fit.
 */
function aspectStyle(dims: { width: number; height: number } | null | undefined) {
  if (dims && dims.width > 0 && dims.height > 0) {
    return { aspectRatio: `${dims.width} / ${dims.height}` } as const;
  }
  // Standard phone ratio fallback so the phone chassis NEVER collapses into a squashed rectangle
  return { aspectRatio: '9 / 19.5' } as const;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mobile-empty">
      <div className="mobile-empty-icon">
        <Ico size={34}>
          <rect x="7" y="2" width="10" height="20" rx="2.5" />
          <line x1="10.5" y1="18.5" x2="13.5" y2="18.5" />
        </Ico>
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}


const phoneIcon = (
  <Ico size={16}>
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <line x1="10.5" y1="18.5" x2="13.5" y2="18.5" />
  </Ico>
);

const openIcon = (
  <Ico size={13}>
    <path d="M7 17 17 7" />
    <path d="M8 7h9v9" />
  </Ico>
);

function DeviceCard({
  name,
  detail,
  information = [],
  action,
  actionLabel,
  disabled,
}: {
  name: string;
  detail: string;
  information?: string[];
  action: () => void;
  actionLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="mobile-device-card">
      <span className="mobile-device-card-icon" aria-hidden="true">{phoneIcon}</span>
      <span className="mobile-device-card-text">
        <span className="mobile-device-card-name">{name}</span>
        <span className="mobile-device-card-detail">{detail}</span>
        {information.length > 0 && (
          <details className="mobile-device-specs">
            <summary>Show details</summary>
            <dl>
              {information.map((value) => {
                const separator = value.indexOf(':');
                return <div key={value}>
                  <dt>{separator < 0 ? 'Device' : value.slice(0, separator)}</dt>
                  <dd>{separator < 0 ? value : value.slice(separator + 1).trim()}</dd>
                </div>;
              })}
            </dl>
          </details>
        )}
      </span>
      <button type="button" className="mobile-device-card-open" onClick={action} disabled={disabled}>
        {openIcon}
        <span>{actionLabel}</span>
      </button>
    </div>
  );
}

const DOCK_GAP = 14; // phone edge (incl. its painted rims) → toolbar
const DOCK_WIDTH = 42; // .mobile-side-toolbar: 30px buttons + 2×6px padding
const DOCK_EDGE = 8; // never closer than this to the panel's sides
const TOOLS_WIDTH = 300;

/**
 * Docks the side toolbar against the phone's right edge instead of the panel's.
 *
 * The phone has to keep sizing itself against the full-width stage (its
 * `max-width: 100%` and the stream-size measurement both read the stage), so the
 * toolbar cannot sit in a shrink-wrapped row with it. Instead it is positioned
 * absolutely, and this measures where the phone actually ends. Writes
 * `--dock-left` (toolbar) and `--tools-right` (Tools panel, which overlays the
 * toolbar and the phone) onto the device body.
 *
 * The phone element is swapped between branches (stream / snapshot / empty),
 * so the observed node is re-picked on every DOM change in the body.
 */
function useDockedToolbar() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((body: HTMLDivElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!body) return;
    let shell: Element | null = null;
    const place = () => {
      // In 3D the flat shell stays mounted as a 2px `source-only` stream source
      // centred in the stage; docking to it would park the toolbar over the
      // middle of the model. With no visible shell, fall back to the right edge
      // (the 3D stage reserves that column, see T3DeviceView.css).
      const next = body.querySelector(
        '.mobile-device-shell:not(.source-only), .mobile-ios-shell:not(.source-only)',
      );
      if (next !== shell) {
        if (shell) ro.unobserve(shell);
        shell = next;
        if (next) ro.observe(next);
      }
      const box = body.getBoundingClientRect();
      const phoneRight = next ? next.getBoundingClientRect().right - box.left : box.width;
      const dockLeft = Math.max(
        DOCK_EDGE,
        Math.min(phoneRight + DOCK_GAP, box.width - DOCK_WIDTH - DOCK_EDGE),
      );
      const toolsWidth = Math.min(TOOLS_WIDTH, box.width - 2 * DOCK_EDGE);
      const toolsRight = Math.max(
        DOCK_EDGE,
        Math.min(box.width - dockLeft - DOCK_WIDTH, box.width - DOCK_EDGE - toolsWidth),
      );
      body.style.setProperty('--dock-left', `${Math.round(dockLeft)}px`);
      body.style.setProperty('--tools-right', `${Math.round(toolsRight)}px`);
    };
    const ro = new ResizeObserver(place);
    ro.observe(body);
    const mo = new MutationObserver(place);
    // `class` too: the 2D↔3D switch flips `source-only` on the same shell node.
    mo.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    place();
    cleanup.current = () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
}

/** One button on the device's floating side toolbar. */
function SideBtn({
  title,
  onClick,
  active,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`mobile-side-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export const FLOAT_DEVICE_EVENT = 'spacron:mobile-float-device';
export const CLOSE_FLOAT_DEVICE_EVENT = 'spacron:mobile-close-floating-device';

type DeviceWindow = { platform: MobileTab; target: string };

/**
 * Hand-off from a floating device window to the sidebar panel: the floating
 * "Devices" button writes the device here, then opens the sidebar. A sidebar
 * panel that is already mounted takes it via DOCK_DEVICE_EVENT; one that mounts
 * because the sidebar was closed takes it on mount. Whichever takes it clears it.
 */
const DOCK_DEVICE_KEY = 'spacron.mobile.dockDevice';
const DOCK_DEVICE_EVENT = 'spacron:mobile-dock-device';

function takeDockedDevice(): DeviceWindow | null {
  const raw = localStorage.getItem(DOCK_DEVICE_KEY);
  localStorage.removeItem(DOCK_DEVICE_KEY);
  try {
    const parsed = raw ? JSON.parse(raw) as DeviceWindow : null;
    return parsed && (parsed.platform === 'android' || parsed.platform === 'ios') && parsed.target ? parsed : null;
  } catch {
    return null;
  }
}

export function MobilePanelFloatingHost() {
  const [windows, setWindows] = useState<DeviceWindow[]>([]);
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<DeviceWindow>).detail;
      const device = detail?.target ? detail : {
        platform: (localStorage.getItem('spacron.mobile.tab') === 'ios' ? 'ios' : 'android') as MobileTab,
        target: localStorage.getItem('spacron.mobile.serial') ?? '',
      };
      if (!device.target) return;
      setWindows((current) => [...current.filter((item) => item.platform !== device.platform || item.target !== device.target), device]);
    };
    window.addEventListener(FLOAT_DEVICE_EVENT, show);
    return () => window.removeEventListener(FLOAT_DEVICE_EVENT, show);
  }, []);
  return <>{windows.map((device, index) => <MobilePanel
    key={`${device.platform}:${device.target}`} floatingHost pinnedDevice={device} windowIndex={index}
    onFloatingClose={() => setWindows((current) => current.filter((item) => item !== device))}
  />)}</>;
}

export default function MobilePanel({ floatingHost = false, onFloatingClose, pinnedDevice, windowIndex = 0 }: {
  floatingHost?: boolean; onFloatingClose?: () => void; pinnedDevice?: DeviceWindow; windowIndex?: number;
} = {}) {
  // Taken once, before the tab / device / view state below reads it.
  const [dockedDevice] = useState(() => floatingHost ? null : takeDockedDevice());
  const [tab, setTab] = useState<MobileTab>(pinnedDevice?.platform ?? dockedDevice?.platform ?? 'android');
  // The panel opens on the device list; "Open" on a device shows its screen.
  const [view, setView] = useState<'list' | 'device'>(() => {
    const openDevice = floatingHost || !!dockedDevice || localStorage.getItem('spacron.mobile.openDeviceOnMount') === '1';
    localStorage.removeItem('spacron.mobile.openDeviceOnMount');
    return openDevice ? 'device' : 'list';
  });
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [floating, setFloating] = useState(floatingHost);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [floatingPosition, setFloatingPosition] = useState<{ left: number; top: number } | null>(null);
  const [floatingSize, setFloatingSize] = useState<{ width: number; height: number } | null>(null);
  const floatingDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const floatingResizeRef = useRef<{
    pointerId: number;
    dir: 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);
  // The platform whose screen is being mirrored, or null on the device list —
  // every stream / screenshot loop keys off this, so the list never streams.
  const mirrorTab: MobileTab | null = view === 'device' ? tab : null;
  const [showText, setShowText] = useState(false);
  // The Tools panel (app, appearance, location, permissions, stream).
  const [showSettings, setShowSettings] = useState(false);
  // Bumped after the toolbar's sun button so an open Tools panel re-reads.
  const [toolsKey, setToolsKey] = useState(0);
  // The device's current appearance, so the toolbar shows a sun (light) or moon (dark).
  const [deviceDark, setDeviceDark] = useState<boolean | null>(null);
  const [bootingName, setBootingName] = useState<string | null>(null);
  const [platform, setPlatform] = useState('');

  // ── Android ────────────────────────────────────────────────────────────
  const [tools, setTools] = useState<AndroidTools | null>(null);
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [avdDetails, setAvdDetails] = useState<Record<string, string[]>>({});
  const [avds, setAvds] = useState<string[]>([]);
  const [selectedSerial, setSelectedSerial] = useState(
    () => pinnedDevice?.platform === 'android' ? pinnedDevice.target
      : dockedDevice?.platform === 'android' ? dockedDevice.target
      : localStorage.getItem('spacron.mobile.serial') ?? '',
  );
  const [frame, setFrame] = useState<AndroidFrame | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [rotation, setRotation] = useProjectPanelState('mobile.rotation', 0);
  const [text, setText] = useProjectPanelState('mobile.androidText', '');
  // Bumping this restarts the poll loop and forces an immediate capture —
  // used to redraw right after an input injection instead of waiting a tick.
  const [refreshKey, setRefreshKey] = useState(0);
  // Streaming vs snapshot-polling mirror. Live streaming (scrcpy on Android,
  // serve-sim on iOS) is the default when the platform supports it; a stream
  // failure auto-falls back to polling with the reason surfaced.
  // What the *user* asked for. A stream failure must never overwrite this —
  // otherwise one early error (a stale serial from localStorage, an emulator
  // still coming up) silently demoted the panel to snapshots for the rest of
  // the session and only a manual click brought it back.
  const [streamMode, setStreamMode] = useState<'stream' | 'poll'>('stream');
  // The *forced* fallback: set when a stream errors, cleared on retry. Snapshot
  // polling runs while this is set even though `streamMode` still says 'stream'.
  const [streamFallback, setStreamFallback] = useState<string | null>(null);
  /** Retries spent on the current device. Reset when the target changes. */
  const streamRetryRef = useRef(0);
  /** The last failure was unfixable by retrying — see `StreamState.fatal`. */
  const streamFatalRef = useRef(false);
  // Stream resolution. 'auto' follows the panel size; a number is the long side
  // the user asked for and overrides the automatic ceiling.
  const [streamSide, setStreamSide] = useState<StreamSideChoice>(() =>
    parseStreamSideChoice(localStorage.getItem('spacron.mobile.streamSide')),
  );
  const [iosStreamMode, setIosStreamMode] = useState<'stream' | 'poll'>('stream');
  const [iosText, setIosText] = useProjectPanelState('mobile.iosText', '');
  const [iosOrientation, setIosOrientation] = useProjectPanelState('mobile.iosOrientation', 0);

  // ── iOS ────────────────────────────────────────────────────────────────
  const [sims, setSims] = useState<IosSimulator[]>([]);
  const [iosUdid, setIosUdid] = useState(
    pinnedDevice?.platform === 'ios' ? pinnedDevice.target : dockedDevice?.platform === 'ios' ? dockedDevice.target : '',
  );
  const [iosShot, setIosShot] = useState<string | null>(null);
  const [iosShotDims, setIosShotDims] = useState<{ width: number; height: number } | null>(null);
  const [iosError, setIosError] = useState<string | null>(null);
  const [iosActionKey, setIosActionKey] = useState(0);

  // Keep the sun/moon icon in step with the device. Polling also catches changes
  // made from the Tools panel or inside the device's own settings.
  useEffect(() => {
    const target = mirrorTab === 'android' ? (selectedSerial ? { platform: 'android', target: selectedSerial } : null)
      : mirrorTab === 'ios' ? (iosUdid ? { platform: 'ios', target: iosUdid } : null) : null;
    setDeviceDark(null);
    if (!target) return;
    let alive = true;
    const read = () => invoke<{ appearance: string | null }>('device_tools_state', target)
      .then((state) => { if (alive) setDeviceDark(state.appearance === 'dark' ? true : state.appearance === 'light' ? false : null); })
      .catch(() => { /* a booting device has no appearance yet */ });
    void read();
    const timer = window.setInterval(read, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [mirrorTab, selectedSerial, iosUdid, toolsKey]);

  useEffect(() => {
    if (!deviceMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!deviceMenuRef.current?.contains(event.target as Node)) setDeviceMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDeviceMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [deviceMenuOpen]);

  const [hingeMotion, setHingeMotion] = useState<{ angle: number; revision: number } | null>(null);
  const [hingeBusy, setHingeBusy] = useState(false);
  const [hingeRevision, setHingeRevision] = useState(0);
  const [androidDisplay, setAndroidDisplay] = useState<{ physical_id: string | null; port: number; width: number; height: number; posture: string | null } | null>(null);
  useEffect(() => {
    if (mirrorTab !== 'android' || !selectedSerial.startsWith('emulator-')) { setAndroidDisplay(null); return; }
    let cancelled = false;
    let inFlight = false;
    let signature: string | null = null;
    setAndroidDisplay(null);
    const read = async () => {
      if (inFlight || cancelled || document.hidden) return;
      inFlight = true;
      try {
        const state = await invoke<{ physical_id: string | null; port: number; width: number; height: number; posture: string | null }>('android_display_state', { serial: selectedSerial });
        if (cancelled) return;
        // Display handoff can briefly expose no powered panel. Preserve the
        // last valid preview until the replacement panel is available.
        if (!state.physical_id || !state.width || !state.height) return;
        const next = `${state.physical_id}:${state.width}:${state.height}`;
        if (signature !== null && signature !== next) {
          stopStream(); setHingeRevision((key) => key + 1);
        }
        signature = next;
        setAndroidDisplay(state);
      } catch { /* Discovery errors do not replace the stream's own diagnostics. */ }
      finally { inFlight = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [mirrorTab, selectedSerial]);
  // 3D perspective phone view
  const [is3D, setIs3D] = useState(() => {
    try {
      const stored = localStorage.getItem('spacron:mobile:3d');
      return stored === null ? true : stored === 'true';
    } catch {
      return true; // default 3D enabled for rich experience
    }
  });
  // Default to 0°/0°: straight forward upright "perfect state", never bent or edge-angled
  const [rotX, setRotX] = useState(() => {
    try {
      const stored = localStorage.getItem('spacron:mobile:rotX');
      if (stored !== null) return Number(stored) || 0;
    } catch {}
    return 0;
  });
  const [rotY, setRotY] = useState(() => {
    try {
      const stored = localStorage.getItem('spacron:mobile:rotY');
      if (stored !== null) return Number(stored) || 0;
    } catch {}
    return 0;
  });

  useEffect(() => { setRotX(0); setRotY(0); }, [view, tab]);
  const resetToPerfect3D = useCallback(() => {
    setView('device');
    setIs3D(true);
    setRotX(0);
    setRotY(0);
    try {
      localStorage.setItem('spacron:mobile:3d', 'true');
      localStorage.setItem('spacron:mobile:rotX', '0');
      localStorage.setItem('spacron:mobile:rotY', '0');
    } catch {}
  }, []);

  useEffect(() => {
    const onReset = () => {
      resetToPerfect3D();
    };
    window.addEventListener('spacron:mobile:reset-perfect-3d', onReset);
    return () => window.removeEventListener('spacron:mobile:reset-perfect-3d', onReset);
  }, [resetToPerfect3D]);

  useEffect(() => {
    if (localStorage.getItem('spacron.mobile.openDeviceOnMount') === '1') {
      localStorage.removeItem('spacron.mobile.openDeviceOnMount');
      resetToPerfect3D();
    }
  }, [resetToPerfect3D]);

  useEffect(() => {
    try {
      localStorage.setItem('spacron:mobile:3d', String(is3D));
    } catch {
      // ignore
    }
  }, [is3D]);

  useEffect(() => {
    try {
      localStorage.setItem('spacron:mobile:rotX', String(rotX));
      localStorage.setItem('spacron:mobile:rotY', String(rotY));
    } catch {
      // ignore
    }
  }, [rotX, rotY]);

  // In floating popup mode, the phone stays in clean 2D flat mode
  const isFloating = floating || floatingHost;
  const effective3D = !isFloating && is3D;

  // The Android stage. Measured (not the device shell, which is content-sized
  // until a frame gives it an aspect ratio) to decide what resolution to ask
  // the device for — see `streamResolution.ts`.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useDockedToolbar();
  const screenRef = useRef<HTMLImageElement | null>(null);
  const iosImgRef = useRef<HTMLImageElement | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = useRef(false);
  // True while a gesture is being streamed to the device live (control channel).
  // When it is false the gesture is replayed as one adb tap/swipe on release.
  const liveGestureRef = useRef(false);
  const touch = useStreamTouch();

  // ── Gesture plumbing ───────────────────────────────────────────────────
  // Closed-fist cursor while a drag is in flight, so the hand reads as holding
  // the screen rather than hovering over it.
  const [dragging, setDragging] = useState(false);
  const wheelGesturesRef = useRef(createWheelGestures());
  // The wheel's finger: pressed on the first notch, walked by each one after
  // it, lifted once the wheel goes quiet. Carries its own serial and dims so a
  // lift scheduled before a device switch cannot land on the new device.
  const scrollSessionRef = useRef<{
    serial: string;
    x: number;
    y: number;
    dims: FrameDims;
    idle: number;
  } | null>(null);
  // Snapshot-mode accumulator: wheel deltas coalesced into one adb swipe.
  const pollScrollRef = useRef<{ serial: string; dy: number; dims: FrameDims; timer: number } | null>(
    null,
  );
  // The wheel listener has to be registered natively (see the effect below), so
  // it reads the current handler through a ref instead of capturing a render.
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});

  // Live-stream hooks: one for the Android scrcpy H.264 stream (WebCodecs), one
  // for the iOS serve-sim MJPEG stream. Each owns its canvas, its Tauri
  // channel, and its decode loop; the panel decides when to start/stop them.
  const {
    canvasRef: streamCanvasRef,
    state: streamState,
    start: startStream,
    stop: stopStream,
  } = useScrcpyStream();
  const {
    canvasRef: mjpegCanvasRef,
    state: mjpegState,
    start: startMjpeg,
    stop: stopMjpeg,
  } = useMjpegStream();
  // Only true once frames are actually flowing — while a stream is *starting*
  // (jar download, encoder boot) the polling mirror keeps showing snapshots.
  const androidStreaming = streamMode === 'stream' && streamState.phase === 'streaming';
  const iosStreaming = iosStreamMode === 'stream' && mjpegState.phase === 'streaming';

  // Remember the last device across panel opens.
  useEffect(() => {
    if (selectedSerial) localStorage.setItem('spacron.mobile.serial', selectedSerial);
  }, [selectedSerial]);

  // …and the resolution pick, which is a preference about this machine (how
  // much it can push) rather than about any one device.
  useEffect(() => {
    localStorage.setItem('spacron.mobile.streamSide', formatStreamSideChoice(streamSide));
  }, [streamSide]);

  // Host OS — gates the iOS tab.
  useEffect(() => {
    void (async () => {
      try {
        setPlatform(await invoke<string>('mobile_platform'));
      } catch {
        // The panel may be previewed in a plain browser where invoke is absent.
      }
    })();
  }, []);

  // Derived up here rather than next to the markup because the stream retry
  // effects below key off it: a device coming online is the signal to try the
  // live stream again.
  const selectedDevice = devices.find((d) => d.serial === selectedSerial);
  const deviceOnline = selectedDevice?.state === 'device';
  const deviceOffline = Boolean(selectedDevice && !deviceOnline);

  // ── Android: list devices + AVDs + tool presence ───────────────────────
  const refreshAndroid = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const [devs, avdList, toolsInfo, metadata] = await Promise.all([
        invoke<AndroidDevice[]>('android_list_devices'),
        invoke<string[]>('android_list_avds'),
        invoke<AndroidTools>('android_check'),
        invoke<Record<string, string[]>>('android_avd_details').catch(() => ({})),
      ]);
      setDevices(devs);
      setAvds(avdList);
      setAvdDetails(metadata);
      setTools(toolsInfo);
      // Keep the current pick while it still exists; otherwise jump to the
      // first online device, or clear the stale serial entirely.
      setSelectedSerial((prev) => {
        if (pinnedDevice?.platform === 'android') return pinnedDevice.target;
        if (prev && devs.some((d) => d.serial === prev)) return prev;
        const online = devs.find((d) => d.state === 'device');
        return online?.serial ?? '';
      });
    } catch (e) {
      setFrameError(String(e));
    } finally {
      setDevicesLoading(false);
    }
  }, [pinnedDevice]);

  useEffect(() => {
    if (view === 'list' || tab === 'android') void refreshAndroid();
  }, [view, tab, refreshAndroid]);

  // Keep watching for devices while nothing is streaming, so an emulator that
  // boots (or finishes booting) after the pane opened is picked up on its own
  // rather than waiting for a manual Refresh. `androidStreaming` in the deps is
  // what stops the scan once a stream is live — see DEVICE_POLL_MS.
  //
  // Deliberately NOT `refreshAndroid`: that also re-lists AVDs and re-checks the
  // toolchain (neither changes while the pane is open) and drives
  // `devicesLoading`, which would flicker the Refresh button disabled every two
  // seconds. This is the one call that can actually report something new.
  useEffect(() => {
    if ((view === 'device' && tab !== 'android') || androidStreaming) return;
    let cancelled = false;
    let inFlight = false;
    const scan = async () => {
      if (inFlight || cancelled || document.hidden) return;
      inFlight = true;
      try {
        const devs = await invoke<AndroidDevice[]>('android_list_devices');
        if (cancelled) return;
        setDevices(devs);
        setSelectedSerial((prev) => pinnedDevice?.platform === 'android' ? pinnedDevice.target : nextSelectedSerial(prev, devs));
      } catch {
        // A transient adb hiccup is not worth surfacing here — the screencap
        // poll and the stream both report their own failures.
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(scan, DEVICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [view, tab, androidStreaming]);

  // ── Android: live H.264 stream (scrcpy) when supported + enabled ─────
  useEffect(() => {
    // Deliberately not gated on WebCodecs: an emulator streams PNG over the
    // host-side gRPC endpoint and needs no video decoder at all. If the backend
    // does pick H.264 and this webview cannot decode it, the stream reports a
    // fatal error on the first frame and the panel falls back to snapshots.
    if (mirrorTab !== 'android' || !selectedSerial || streamMode !== 'stream' || streamFallback) {
      stopStream();
      return;
    }
    // On 'auto', ask for the pixels this panel can actually paint rather than a
    // fixed constant: a HiDPI screen needs ~2x a standard one for the same CSS
    // box, and a narrow drawer needs far less than either. Measured at stream
    // START only — re-negotiating mid-drag would restart the stream on every
    // frame of a drawer resize. Widening the panel and wanting it sharper means
    // toggling Live off/on (or switching device), which restarts it anyway.
    //
    // An explicit pick from the switcher skips the measurement entirely, so the
    // stage size stops mattering; changing it restarts the stream, because the
    // size is fixed in the stream's opening request.
    const stage = stageRef.current?.getBoundingClientRect();
    const maxSide = resolveStreamSide(
      streamSide,
      stage?.width ?? 0,
      stage?.height ?? 0,
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    );
    void startStream(selectedSerial, maxSide);
  }, [
    mirrorTab,
    selectedSerial,
    hingeRevision,
    streamMode,
    streamSide,
    streamFallback,
    startStream,
    stopStream,
  ]);

  // A stream failure falls back to snapshot polling and surfaces the reason —
  // without touching `streamMode`, so the user's own choice survives it.
  useEffect(() => {
    if (streamState.phase === 'error') {
      const message = streamState.message ?? 'Screen stream failed.';
      // A fatal failure (this webview cannot decode what the device sends)
      // spends the whole retry budget up front: retrying cannot change the
      // answer, and 22s of futile reconnects would just delay the snapshots.
      streamFatalRef.current = Boolean(streamState.fatal);
      setStreamFallback(message);
      setFrameError(message);
    }
  }, [streamState.phase, streamState.message, streamState.fatal]);

  // A new target gets a clean slate: clear the forced fallback and the retry
  // budget, so switching device (or one finally coming online) tries the live
  // stream again instead of inheriting the previous device's failure.
  useEffect(() => {
    streamRetryRef.current = 0;
    streamFatalRef.current = false;
    setStreamFallback(null);
  }, [selectedSerial, deviceOnline]);

  // Retry a forced fallback with a widening delay. This is what turns "the
  // emulator was not quite ready" from a dead end into a couple of seconds:
  // the panel keeps showing snapshots meanwhile, then upgrades itself to live.
  useEffect(() => {
    if (!streamFallback || streamMode !== 'stream' || mirrorTab !== 'android') return;
    if (!selectedSerial || !deviceOnline || streamFatalRef.current) return;
    if (streamRetryRef.current >= STREAM_RETRY_LIMIT) return;
    const attempt = streamRetryRef.current;
    const id = window.setTimeout(
      () => {
        streamRetryRef.current = attempt + 1;
        setStreamFallback(null);
      },
      STREAM_RETRY_BASE_MS * 2 ** attempt,
    );
    return () => window.clearTimeout(id);
  }, [streamFallback, streamMode, mirrorTab, selectedSerial, deviceOnline]);

  // ── Android: live mirror — poll screencap while a device is selected ───
  //
  // `androidStreaming` must stay in the dependency list: the guard below runs
  // once per effect, so leaving it out kept the interval alive after the stream
  // came up. A capture costs seconds of adb time on a local emulator, and it
  // was competing with the stream and with every injected tap for the same adb
  // connection — the single worst thing for how responsive the panel feels.
  useEffect(() => {
    if (mirrorTab !== 'android' || !selectedSerial || androidStreaming) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const f = await invoke<AndroidFrame>('android_screencap', { serial: selectedSerial });
        if (!cancelled) {
          setFrame(f);
          setFrameError(null);
        }
      } catch (e) {
        if (!cancelled) setFrameError(String(e));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [mirrorTab, selectedSerial, refreshKey, androidStreaming]);

  // ── iOS: list simulators on tab open / after boot actions ─────────────
  useEffect(() => {
    if (!(view === 'list' ? platform === 'macos' : tab === 'ios')) return;
    void (async () => {
      try {
        const list = await invoke<IosSimulator[]>('ios_list_simulators');
        setSims(list);
        setIosError(null);
        setIosUdid((prev) => {
          if (pinnedDevice?.platform === 'ios') return pinnedDevice.target;
          if (prev && list.some((s) => s.udid === prev)) return prev;
          return list.find((s) => isBooted(s.state))?.udid ?? list[0]?.udid ?? '';
        });
      } catch (e) {
        setIosError(String(e));
      }
    })();
  }, [view, tab, platform, iosActionKey]);

  // ── iOS: serve-sim live stream when enabled + booted ─────────────────
  useEffect(() => {
    if (mirrorTab !== 'ios' || !iosUdid || iosStreamMode !== 'stream') {
      stopMjpeg();
      return;
    }
    const sim = sims.find((s) => s.udid === iosUdid);
    if (!sim || !isBooted(sim.state)) {
      stopMjpeg();
      return;
    }
    void startMjpeg(iosUdid);
  }, [mirrorTab, iosUdid, iosStreamMode, sims, startMjpeg, stopMjpeg]);

  // A serve-sim stream failure falls back to screenshot polling.
  useEffect(() => {
    if (mjpegState.phase === 'error') {
      setIosStreamMode('poll');
      setIosError(mjpegState.message ?? 'Simulator stream failed.');
    }
  }, [mjpegState.phase, mjpegState.message]);

  // ── iOS: screenshot mirror of the selected booted sim (polling) ───────
  useEffect(() => {
    if (mirrorTab !== 'ios' || !iosUdid || iosStreaming) return;
    const sim = sims.find((s) => s.udid === iosUdid);
    if (!sim || !isBooted(sim.state)) {
      setIosShot(null);
      setIosShotDims(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const png = await invoke<string>('ios_screenshot', { udid: iosUdid });
        if (!cancelled) {
          setIosShot(png);
          // The new screenshot's dims land via the img onLoad; the old ratio
          // would otherwise mis-fit the shell in the meantime.
          setIosShotDims(null);
          setIosError(null);
        }
      } catch (e) {
        if (!cancelled) setIosError(String(e));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(tick, IOS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // `iosStreaming` for the same reason as the Android poll above: without it
    // the screenshot loop outlives the stream that replaced it.
  }, [mirrorTab, iosUdid, sims, iosStreaming]);

  // ── Input injection helpers ────────────────────────────────────────────

  /**
   * Map a client-space point to device pixels using the displayed frame.
   *
   * The rect is the `<img>` itself, not the chassis shell: the shell carries
   * ~7–12px of padding and rim, which at typical display scales would push
   * every tap ~30 device px off target.
   */
  /**
   * Map a client-space point to device pixels against whichever display is
   * live: the stream canvas (with the stream's dimensions) or the polling
   * `<img>` (with the last frame's dimensions).
   */
  function clientToDevice(clientX: number, clientY: number) {
    const el = (androidStreaming ? streamCanvasRef.current : screenRef.current) as HTMLElement | null;
    const dims = androidStreaming ? streamState.dims : frame;
    if (!el || !dims) return null;
    if (effective3D) {
      const point = meshScreenPoint(stageRef.current, clientX, clientY);
      if (point !== undefined) return point ? { x: Math.round(point.x * (dims.width - 1)), y: Math.round(point.y * (dims.height - 1)) } : null;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    if (effective3D && (Math.abs(rotX) > 0.05 || Math.abs(rotY) > 0.05) && stageRef.current) {
      const stageRect = stageRef.current.getBoundingClientRect();
      const unprojected = unproject3dPoint({
        clientX,
        clientY,
        screenRect: rect,
        stageRect,
        rotXDeg: rotX,
        rotYDeg: rotY,
        dims,
      });
      if (unprojected) return unprojected;
    }

    return {
      x: Math.max(0, Math.min(dims.width - 1, Math.round(((clientX - rect.left) / rect.width) * dims.width))),
      y: Math.max(0, Math.min(dims.height - 1, Math.round(((clientY - rect.top) / rect.height) * dims.height))),
    };
  }

  /**
   * Run an adb injection, then force an immediate recapture so the mirror feels
   * live. Only the snapshot mirror needs the nudge — while the stream is up it
   * would restart the poll effect (and, before the dependency fix above, fire a
   * multi-second screen capture) for nothing.
   */
  async function inject(action: () => Promise<void>) {
    try {
      await action();
      if (!androidStreaming) setRefreshKey((k) => k + 1);
    } catch (e) {
      setFrameError(String(e));
    }
  }

  /** The frame the live stream is painting, when there is one to map against. */
  function liveDims() {
    return androidStreaming ? streamState.dims : undefined;
  }

  // ── Gestures: wheel scrolling and navigation ───────────────────────────

  /** Lift the wheel's finger, if one is down. Safe to call at any time. */
  function endLiveScroll() {
    const session = scrollSessionRef.current;
    scrollSessionRef.current = null;
    if (!session) return;
    window.clearTimeout(session.idle);
    void touch
      .up(session.serial, session.x, session.y, session.dims)
      .catch((err) => setFrameError(String(err)));
  }

  /**
   * Scroll by dragging a finger over the control channel.
   *
   * The device has no notion of a wheel — a scroll is a finger that presses,
   * travels and lifts — so a burst of wheel events becomes one long drag. When
   * the finger runs into the edge of the screen the drag ends immediately
   * (`exhausted`), which both lets the device fling and puts the next notch at
   * a fresh anchor instead of pushing against the frame border.
   */
  function liveScroll(deviceDy: number, anchor: { x: number; y: number }, dims: FrameDims) {
    let session = scrollSessionRef.current;
    if (session && (session.serial !== selectedSerial || session.dims !== dims)) {
      // Device switched or the stream resized: the old finger belongs to a
      // frame the server no longer accepts coordinates in.
      endLiveScroll();
      session = null;
    }
    if (!session) {
      session = { serial: selectedSerial, x: anchor.x, y: anchor.y, dims, idle: 0 };
      scrollSessionRef.current = session;
      const started = session;
      void touch
        .down(selectedSerial, anchor.x, anchor.y, dims)
        .then((delivered) => {
          // No control channel after all — drop the session rather than leave a
          // phantom finger, and let the next notch take the adb path.
          if (!delivered && scrollSessionRef.current === started) scrollSessionRef.current = null;
        })
        .catch((err) => {
          if (scrollSessionRef.current === started) scrollSessionRef.current = null;
          setFrameError(String(err));
        });
    }

    const next = advanceScroll(session, 0, deviceDy, dims);
    session.x = next.x;
    session.y = next.y;
    touch.move(selectedSerial, session.x, session.y, dims);

    window.clearTimeout(session.idle);
    session.idle = window.setTimeout(endLiveScroll, next.exhausted ? 0 : SCROLL_IDLE_MS);
  }

  /**
   * Snapshot-mode scrolling: collect the wheel deltas and replay them as one
   * `adb shell input swipe` down the middle of the screen once the wheel stops.
   */
  function pollScroll(deviceDy: number, dims: FrameDims) {
    const acc = pollScrollRef.current ?? { serial: selectedSerial, dy: 0, dims, timer: 0 };
    // A device switch mid-flush would otherwise replay this scroll on the phone
    // the user just navigated away from.
    if (acc.serial !== selectedSerial) {
      acc.serial = selectedSerial;
      acc.dy = 0;
    }
    acc.dy += deviceDy;
    acc.dims = dims;
    window.clearTimeout(acc.timer);
    acc.timer = window.setTimeout(flushPollScroll, POLL_SCROLL_FLUSH_MS);
    pollScrollRef.current = acc;
  }

  function flushPollScroll() {
    const acc = pollScrollRef.current;
    pollScrollRef.current = null;
    if (!acc || !acc.dy || !acc.serial) return;
    const { dims, dy, serial } = acc;
    const x = Math.round(dims.width / 2);
    const middle = Math.round(dims.height / 2);
    const clampY = (value: number) => Math.max(0, Math.min(dims.height - 1, Math.round(value)));
    const y1 = clampY(middle - dy / 2);
    const y2 = clampY(middle + dy / 2);
    if (y1 === y2) return;
    const durationMs = Math.min(500, Math.max(80, Math.round(Math.abs(y2 - y1) * 0.4)));
    void inject(() => invoke('android_swipe', { serial, x1: x, y1, x2: x, y2, durationMs }));
  }

  /**
   * Wheel → scroll, in whichever mode the mirror is running.
   *
   * `deltaY` is in CSS pixels of the *displayed* screen, which is scaled down
   * from the device's own pixels; without converting through the element rect a
   * notch would travel a third as far on a big phone as on a small one.
   * A wheel *down* scrolls the content down, which a finger does by moving up —
   * hence the sign flip.
   */
  function scrollDevice(deltaY: number, client: { x: number; y: number } | null) {
    const el = (androidStreaming ? streamCanvasRef.current : screenRef.current) as HTMLElement | null;
    const dims = androidStreaming ? streamState.dims : frame;
    if (!el || !dims) return;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return;
    const renderedHeight = effective3D && stageRef.current ? stageRef.current.getBoundingClientRect().height : rect.height;
    const deviceDy = -Math.round(deltaY * (dims.height / Math.max(1, renderedHeight)));
    if (deviceDy === 0) return;
    if (androidStreaming) {
      const anchor = (client && clientToDevice(client.x, client.y)) || scrollAnchor(dims);
      liveScroll(deviceDy, anchor, dims);
    } else {
      pollScroll(deviceDy, dims);
    }
  }

  /** Run a recognized gesture. Navigation keys reuse the hardware-key path. */
  function runGesture(intent: GestureIntent, client: { x: number; y: number } | null) {
    if (intent.kind === 'key') {
      endLiveScroll();
      sendKey(intent.keycode);
      return;
    }
    scrollDevice(intent.dy, client);
  }

  wheelHandlerRef.current = (e: WheelEvent) => {
    // Only the mirrored screen consumes the wheel; over the empty stage the
    // event belongs to whatever the drawer wants to do with it.
    if (!selectedSerial || !(e.target as HTMLElement | null)?.closest?.('.mobile-device-shell, .mobile-3d-screen-wrap, .mobile-device-screen')) return;
    if (effective3D && meshScreenPoint(stageRef.current, e.clientX, e.clientY) === null) return;
    e.preventDefault();
    const intent = wheelGesturesRef.current.handle(e, e.timeStamp);
    if (intent) runGesture(intent, { x: e.clientX, y: e.clientY });
  };

  // React registers `wheel` as a passive listener on its root, so an `onWheel`
  // prop could never call `preventDefault` — and without that, scrolling the
  // phone would scroll the drawer behind it as well. Hence a native listener.
  useEffect(() => {
    const stage = stageRef.current?.closest<HTMLElement>('.mobile-device-body') ?? stageRef.current;
    if (mirrorTab !== 'android' || !stage) return;
    const listener = (e: WheelEvent) => wheelHandlerRef.current(e);
    stage.addEventListener('wheel', listener, { passive: false });
    return () => stage.removeEventListener('wheel', listener);
  }, [mirrorTab]);

  // Never leave a finger down — or a queued swipe — on a device the panel is no
  // longer driving.
  useEffect(() => {
    return () => {
      endLiveScroll();
      if (pollScrollRef.current) window.clearTimeout(pollScrollRef.current.timer);
      pollScrollRef.current = null;
      wheelGesturesRef.current.reset();
    };
    // Deliberately not listing the helpers: this effect exists only for its
    // cleanup, and re-running it on every render would lift the finger between
    // two wheel notches of the same scroll.
  }, [selectedSerial, androidStreaming, mirrorTab]);

  function onPointerDown(e: React.PointerEvent) {
    if (!selectedSerial || (streamMode === 'stream' && !streamFallback && !androidStreaming)) return;

    // Non-primary buttons are navigation gestures, not fingers: right for Back,
    // middle for Home, the side buttons for Back/Forward. Suppressing the
    // default also stops the side buttons from navigating the webview itself.
    const buttonGesture = mouseButtonIntent(e.button);
    if (buttonGesture) {
      e.preventDefault();
      runGesture(buttonGesture, null);
      return;
    }
    if (e.button !== 0) return;

    // A drag takes over from the wheel's finger; two of them at once would be
    // read as a pinch the panel never meant to send.
    endLiveScroll();
    wheelGesturesRef.current.reset();
    setDragging(true);

    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    pointerMovedRef.current = false;
    liveGestureRef.current = false;

    // While streaming, the gesture is played to the device as it happens:
    // press now, drag with the cursor, lift on release. That is what makes
    // scrolling and dragging work at all — the adb path can only replay a
    // finished gesture as one canned swipe, seconds later.
    const dims = liveDims();
    const p = dims ? clientToDevice(e.clientX, e.clientY) : null;
    if (!dims || !p) return;
    // Capture, so a drag that leaves the canvas still delivers move and up.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not fatal; the gesture just ends if the pointer leaves the element.
    }
    liveGestureRef.current = true;
    void touch
      .down(selectedSerial, p.x, p.y, dims)
      .then((delivered) => {
        // No control channel (older server, snapshot mode): give the gesture
        // back to the adb path, which onPointerUp will replay on release.
        if (!delivered) liveGestureRef.current = false;
      })
      .catch((err) => {
        liveGestureRef.current = false;
        setFrameError(String(err));
      });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointerStartRef.current) return;
    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    if (Math.hypot(dx, dy) > 8) pointerMovedRef.current = true;

    if (!liveGestureRef.current || !selectedSerial) return;
    const dims = liveDims();
    const p = dims ? clientToDevice(e.clientX, e.clientY) : null;
    if (dims && p) touch.move(selectedSerial, p.x, p.y, dims);
  }

  function onPointerUp(e: React.PointerEvent) {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    setDragging(false);
    if (!start || !selectedSerial) return;

    if (liveGestureRef.current) {
      liveGestureRef.current = false;
      const dims = liveDims();
      const p = dims ? clientToDevice(e.clientX, e.clientY) : null;
      if (dims && p) {
        const cancelled = e.type === 'pointercancel';
        void touch.up(selectedSerial, p.x, p.y, dims, cancelled).catch((err) => setFrameError(String(err)));
        return;
      }
      // Dimensions vanished mid-gesture (the stream dropped): fall through and
      // replay the gesture over adb rather than leaving a finger down.
    }

    if (!pointerMovedRef.current) {
      const p = clientToDevice(e.clientX, e.clientY);
      if (p) void inject(() => invoke('android_tap', { serial: selectedSerial, x: p.x, y: p.y }));
      return;
    }

    // Drag → swipe. Duration scales with the on-screen distance so a short
    // flick feels quick and a long drag has time to register.
    const from = clientToDevice(start.x, start.y);
    const to = clientToDevice(e.clientX, e.clientY);
    if (!from || !to) return;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const durationMs = Math.min(600, Math.max(100, Math.round(dist * 0.5)));
    void inject(() =>
      invoke('android_swipe', {
        serial: selectedSerial,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        durationMs,
      }),
    );
  }

  function sendKey(keycode: number) {
    if (!selectedSerial) return;
    void (async () => {
      try {
        if (androidStreaming && (await sendStreamKey(selectedSerial, keycode))) return;
        await inject(() => invoke('android_key', { serial: selectedSerial, keycode }));
      } catch (e) {
        setFrameError(String(e));
      }
    })();
  }

  function cycleRotation() {
    if (!selectedSerial) return;
    const next = (rotation + 1) % 4;
    setRotation(next);
    void inject(() => invoke('android_rotate', { serial: selectedSerial, rotation: next }));
  }

  function toggleStreamMode() {
    setFrameError(null);
    // Asking for Live by hand also forgives whatever made it fall back and
    // hands back a full retry budget — otherwise the click would be swallowed
    // by a fallback the user is explicitly overriding.
    streamRetryRef.current = 0;
    streamFatalRef.current = false;
    setStreamFallback(null);
    setStreamMode((m) => (m === 'stream' ? 'poll' : 'stream'));
  }

  function toggleIosStreamMode() {
    setIosError(null);
    setIosStreamMode((m) => (m === 'stream' ? 'poll' : 'stream'));
  }

  // ── iOS input (serve-sim CLI) ─────────────────────────────────────────

  /** Tap at the point of the click, normalized to the displayed element. */
  async function iosTap(e: React.PointerEvent) {
    if (!iosUdid || !isBooted(iosSelectedSim?.state)) return;
    const el = (iosStreaming ? mjpegCanvasRef.current : iosImgRef.current) as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let x = (e.clientX - rect.left) / rect.width;
    let y = (e.clientY - rect.top) / rect.height;
    const meshPoint = effective3D ? meshScreenPoint(stageRef.current, e.clientX, e.clientY) : undefined;
    if (meshPoint === null) return;
    if (meshPoint) { x = meshPoint.x; y = meshPoint.y; }


    if (meshPoint === undefined && effective3D && (Math.abs(rotX) > 0.05 || Math.abs(rotY) > 0.05) && stageRef.current) {
      const stageRect = stageRef.current.getBoundingClientRect();
      const unprojected = unproject3dPoint({
        clientX: e.clientX,
        clientY: e.clientY,
        screenRect: rect,
        stageRect,
        rotXDeg: rotX,
        rotYDeg: rotY,
        dims: { width: 1000, height: 1000 },
      });
      if (unprojected) {
        x = unprojected.x / 999;
        y = unprojected.y / 999;
      }
    }

    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
    try {
      await invoke('ios_sim_tap', { udid: iosUdid, x, y });
    } catch (err) {
      setIosError(String(err));
    }
  }

  function iosButton(name: string) {
    if (!iosUdid) return;
    void (async () => {
      try {
        await invoke('ios_sim_button', { udid: iosUdid, name });
      } catch (err) {
        setIosError(String(err));
      }
    })();
  }

  function cycleIosOrientation() {
    if (!iosUdid) return;
    const next = (iosOrientation + 1) % IOS_ORIENTATIONS.length;
    setIosOrientation(next);
    void (async () => {
      try {
        await invoke('ios_sim_rotate', { udid: iosUdid, orientation: IOS_ORIENTATIONS[next] });
      } catch (err) {
        setIosError(String(err));
      }
    })();
  }

  async function iosSendText() {
    if (!iosUdid || !iosText.trim()) return;
    const value = iosText;
    setIosText('');
    try {
      await invoke('ios_sim_type', { udid: iosUdid, text: value });
    } catch (err) {
      setIosError(String(err));
    }
  }

  async function sendText() {
    if (!selectedSerial || !text.trim()) return;
    const value = text;
    setText('');
    try {
      if (androidStreaming && (await sendStreamText(selectedSerial, value))) return;
    } catch (e) {
      setFrameError(String(e));
      return;
    }
    await inject(() => invoke('android_text', { serial: selectedSerial, text: value }));
  }

  async function launchAvd(name: string) {
    if (!name || booting) return;
    setBooting(true);
    setFrameError(null);
    try {
      await invoke('android_launch_avd', { name });
      // Emulators take a while to boot; poll until the new emulator is online.
      let ready = false;
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const list = await invoke<AndroidDevice[]>('android_list_devices');
        setDevices(list);
        const emu = list.find((d) => d.serial.startsWith('emulator-') && d.label === name && d.state === 'device');
        if (emu && await invoke<boolean>('android_boot_ready', { serial: emu.serial }).catch(() => false)) {
          ready = true;
          setSelectedSerial(emu.serial);
          break;
        }
      }
      if (!ready) throw new Error('The emulator has not finished booting after four minutes. It may still be starting. Refresh devices to reconnect.');
    } catch (e) {
      setFrameError(String(e));
    } finally {
      setBooting(false);
      setBootingName(null);
    }
  }

  async function iosAction(udid: string, action: 'boot' | 'shutdown') {
    if (!udid) return;
    try {
      await invoke(action === 'boot' ? 'ios_boot' : 'ios_shutdown', { udid });
      setIosShot(null);
      setIosShotDims(null);
      setIosActionKey((k) => k + 1);
    } catch (e) {
      setIosError(String(e));
    }
  }

  const iosSelectedSim = sims.find((s) => s.udid === iosUdid);
  // Whether the panel is between live-stream attempts, so the status line can
  // say "this is temporary" instead of showing a bare failure the panel is in
  // fact already recovering from. Reading the retry ref during render is fine
  // for a hint: it is accurate as of this paint, and the next attempt repaints.
  const streamRetrying =
    Boolean(streamFallback) &&
    streamMode === 'stream' &&
    deviceOnline &&
    !streamFatalRef.current &&
    streamRetryRef.current < STREAM_RETRY_LIMIT;

  // ── Device list rows ───────────────────────────────────────────────────
  // Running devices first (an emulator's label is its AVD name), then every
  // AVD that is not running, so the list shows each phone exactly once.
  const runningAvdNames = new Set(devices.filter((d) => d.serial.startsWith('emulator-')).map((d) => d.label));
  const stoppedAvds = avds.filter((name) => !runningAvdNames.has(name));
  const emulatorDevices = devices.filter((d) => d.serial.startsWith('emulator-'));
  const usbDevices = devices.filter((d) => !d.serial.startsWith('emulator-'));
  const showIos = platform === 'macos';

  function androidStateText(state: string) {
    if (state === 'device') return 'Running';
    if (state === 'unauthorized') return 'Waiting for USB authorization';
    return state.charAt(0).toUpperCase() + state.slice(1);
  }

  function openAndroidDevice(serial: string) {
    setTab('android');
    if (serial !== selectedSerial) {
      setSelectedSerial(serial);
      setFrame(null);
    }
    setFrameError(null);
    setView('device');
  }

  // A sidebar panel that is already mounted takes a device docked from a
  // floating window (a closed sidebar mounts a fresh panel that takes it on mount).
  const openDockedRef = useRef<(device: DeviceWindow) => void>(() => {});
  openDockedRef.current = (device) => device.platform === 'android' ? openAndroidDevice(device.target) : openSim(device.target);
  useEffect(() => {
    if (floatingHost) return;
    const onDock = () => {
      const device = takeDockedDevice();
      if (device) openDockedRef.current(device);
    };
    window.addEventListener(DOCK_DEVICE_EVENT, onDock);
    return () => window.removeEventListener(DOCK_DEVICE_EVENT, onDock);
  }, [floatingHost]);

  function openAvd(name: string) {
    setTab('android');
    setSelectedSerial('');
    setFrame(null);
    setBootingName(name);
    setView('device');
    void launchAvd(name);
  }

  function openSim(udid: string) {
    setTab('ios');
    if (udid !== iosUdid) {
      setIosUdid(udid);
      setIosShot(null);
      setIosShotDims(null);
    }
    setIosError(null);
    setView('device');
    const sim = sims.find((s) => s.udid === udid);
    if (sim && !isBooted(sim.state)) void iosAction(udid, 'boot');
  }

  function refreshAll() {
    void refreshAndroid();
    if (showIos) setIosActionKey((k) => k + 1);
  }



  function renderDeviceList() {
    const androidUnavailable = tools && !tools.adb;
    return (
      <div className="mobile-devices">
        <section className="mobile-devices-section">
          <h3 className="mobile-devices-heading">
            {phoneIcon}
            <span>Android Emulators</span>
          </h3>
          {!tools ? (
            <p className="mobile-devices-note">{frameError ?? 'Looking for adb and the emulator…'}</p>
          ) : androidUnavailable ? (
            <p className="mobile-devices-note">
              Android SDK not found. Install Android Studio (or platform-tools) so adb is on PATH, then restart Spacron.
            </p>
          ) : emulatorDevices.length === 0 && stoppedAvds.length === 0 ? (
            <p className="mobile-devices-note">No emulators yet. Create one in Android Studio's Device Manager.</p>
          ) : (
            <div className="mobile-devices-cards">
              {emulatorDevices.map((d) => (
                <DeviceCard
                  key={d.serial}
                  name={d.label}
                  information={[`Serial: ${d.serial}`, ...(avdDetails[d.label] ?? [])]}
                  detail={`This machine · ${androidStateText(d.state)}`}
                  actionLabel="Open"
                  action={() => openAndroidDevice(d.serial)}
                />
              ))}
              {stoppedAvds.map((name) => (
                <DeviceCard
                  key={`avd:${name}`}
                  name={name}
                  information={avdDetails[name] ?? []}
                  detail={bootingName === name && booting ? 'This machine · Starting…' : 'This machine · Stopped'}
                  actionLabel="Open"
                  action={() => openAvd(name)}
                  disabled={booting || !tools.emulator}
                />
              ))}
            </div>
          )}
        </section>

        {usbDevices.length > 0 && (
          <section className="mobile-devices-section">
            <h3 className="mobile-devices-heading">
              {phoneIcon}
              <span>Android Devices</span>
            </h3>
            <div className="mobile-devices-cards">
              {usbDevices.map((d) => (
                <DeviceCard
                  key={d.serial}
                  name={d.label}
                  information={[`Serial: ${d.serial}`, ...(avdDetails[d.label] ?? [])]}
                  detail={`USB · ${androidStateText(d.state)}`}
                  actionLabel="Open"
                  action={() => openAndroidDevice(d.serial)}
                />
              ))}
            </div>
          </section>
        )}

        {showIos && (
          <section className="mobile-devices-section">
            <h3 className="mobile-devices-heading">
              {phoneIcon}
              <span>iOS Simulators</span>
            </h3>
            {sims.length === 0 ? (
              <p className="mobile-devices-note">
                {iosError ?? 'No simulators installed. Add a runtime in Xcode → Settings → Components.'}
              </p>
            ) : (
              <div className="mobile-devices-cards">
                {sims.map((s) => (
                  <DeviceCard
                    key={s.udid}
                    name={s.name}
                    detail={`This machine · ${s.runtime} · ${isBooted(s.state) ? 'Running' : 'Stopped'}`}
                    actionLabel="Open"
                    action={() => openSim(s.udid)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <button type="button" className="mobile-devices-refresh" onClick={refreshAll} disabled={devicesLoading}>
          {devicesLoading ? 'Refreshing…' : 'Refresh devices'}
        </button>
      </div>
    );
  }


  const icoHome = <Ico><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></Ico>;
  const icoBack = <Ico><path d="m15 18-6-6 6-6" /></Ico>;
  const icoRecents = <Ico><rect x="5" y="5" width="14" height="14" rx="2" /></Ico>;
  const icoRotate = <Ico><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Ico>;
  const icoPower = <Ico><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" /></Ico>;
  const icoVolUp = <Ico><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="15.5" y1="9" x2="15.5" y2="15" /><line x1="18.5" y1="7" x2="18.5" y2="17" /></Ico>;
  const icoVolDown = <Ico><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="15.5" y1="12" x2="18.5" y2="12" /></Ico>;
  const icoText = <Ico><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></Ico>;
  const icoSettings = <Ico><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></Ico>;
  const icoSun = <Ico><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></Ico>;
  const icoMoon = <Ico><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Ico>;
  const appearanceTitle = deviceDark === null ? 'Switch light / dark appearance' : deviceDark ? 'Dark appearance — switch to light' : 'Light appearance — switch to dark';
  const icoAppearance = deviceDark ? icoMoon : icoSun;
  const icoCamera = <Ico><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></Ico>;

  /** The device on screen, as the tools commands address it. */
  function toolsTarget(): { platform: 'android' | 'ios'; target: string } | null {
    if (tab === 'android') return selectedSerial ? { platform: 'android', target: selectedSerial } : null;
    return iosUdid ? { platform: 'ios', target: iosUdid } : null;
  }

  function reportError(message: string) {
    if (tab === 'android') setFrameError(message);
    else setIosError(message);
  }

  /** Sun button: flip the device between light and dark appearance. */
  async function toggleAppearance() {
    const t = toolsTarget();
    if (!t) return;
    try {
      const state = await invoke<{ appearance: string | null }>('device_tools_state', t);
      const dark = state.appearance !== 'dark';
      await invoke('device_set_appearance', { ...t, dark });
      setDeviceDark(dark);
      showToast(dark ? 'Dark appearance' : 'Light appearance', 'success');
      setToolsKey((k) => k + 1);
    } catch (e) {
      reportError(String(e));
    }
  }

  /** Camera button: save a full-resolution PNG of the device screen. */
  async function saveScreenshot() {
    const t = toolsTarget();
    if (!t) return;
    try {
      const path = await invoke<string>('device_save_screenshot', { ...t, name: deviceName });
      showToast(`Screenshot saved to ${path}`, 'success');
    } catch (e) {
      reportError(String(e));
    }
  }

  function rotateAndroidTo(index: number) {
    if (!selectedSerial) return;
    setRotation(index);
    void inject(() => invoke('android_rotate', { serial: selectedSerial, rotation: index }));
  }

  function rotateIosTo(index: number) {
    if (!iosUdid) return;
    setIosOrientation(index);
    void (async () => {
      try {
        await invoke('ios_sim_rotate', { udid: iosUdid, orientation: IOS_ORIENTATIONS[index] });
      } catch (err) {
        setIosError(String(err));
      }
    })();
  }
  const icoMenu = <Ico><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Ico>;

  const canPowerOff = tab === 'android'
    ? selectedSerial.startsWith('emulator-')
    : Boolean(iosUdid);

  async function powerOffDevice() {
    setDeviceMenuOpen(false);
    setShowSettings(false);
    if (tab === 'android') {
      if (!selectedSerial.startsWith('emulator-')) return;
      try {
        stopStream();
        await invoke('android_emu_kill', { serial: selectedSerial });
        setFrame(null);
        setFrameError(null);
        setSelectedSerial('');
        localStorage.removeItem('spacron.mobile.serial');
        setView('list');
        await refreshAndroid();
        if (floatingHost) onFloatingClose?.();
      } catch (error) {
        setFrameError(String(error));
      }
      return;
    }
    if (!iosUdid) return;
    try {
      stopMjpeg();
      await invoke('ios_shutdown', { udid: iosUdid });
      setIosShot(null);
      setIosShotDims(null);
      setIosActionKey((key) => key + 1);
      setView('list');
      if (floatingHost) onFloatingClose?.();
    } catch (error) {
      setIosError(String(error));
    }
  }

  function renderViewButtons() {
    if (isFloating) return null;
    return <>
      <span className="mobile-toolbar-separator" />
      <SideBtn title="3D view" active={is3D} onClick={() => {
        setIs3D(true); setRotX(0); setRotY(0);
      }}><Ico size={16}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></Ico></SideBtn>
      <SideBtn title="Flat view" active={!is3D} onClick={() => setIs3D(false)}>
        <Ico size={16}><rect x="5" y="3" width="14" height="18" rx="2" /></Ico>
      </SideBtn>
    </>;
  }

  function renderFoldButtons() {
    const supported = tab === 'android' ? androidDisplay?.posture != null : selectedSkin === 'duo';
    if (!supported || isFloating) return null;
    return <>
      <span className="mobile-toolbar-separator" />
      <SideBtn title="Fold device" disabled={hingeBusy} active={tab === 'android' ? androidDisplay?.posture === 'closed' : hingeMotion?.angle === 0} onClick={() => void changeHinge(true)}>
        <Ico size={16}><rect x="8" y="3" width="9" height="18" rx="2" /><path d="M6 5H4v14h2M12 8l-2 4 2 4" /></Ico>
      </SideBtn>
      <SideBtn title="Unfold device" disabled={hingeBusy} active={tab === 'android' ? androidDisplay?.posture === 'opened' : hingeMotion?.angle === 180} onClick={() => void changeHinge(false)}>
        <Ico size={16}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16M8 9l-2 3 2 3M16 9l2 3-2 3" /></Ico>
      </SideBtn>
    </>;
  }

  function renderDeviceMenu() {
    return (
      <div className="mobile-device-menu-wrap" ref={deviceMenuRef}>
        <SideBtn title="Device actions" onClick={() => setDeviceMenuOpen((open) => !open)} active={deviceMenuOpen}>
          {icoMenu}
        </SideBtn>
        {deviceMenuOpen && (
          <div className="mobile-device-menu" role="menu" aria-label="Device actions">
            {!isFloating && <>
              {is3D && <button type="button" role="menuitem" onClick={() => {
                setRotX(0); setRotY(0); setDeviceMenuOpen(false);
              }}>{icoRotate}<span>Restore front view</span></button>}
              <span className="mobile-device-menu-separator" />
            </>}
            {!isFloating && (
              <button type="button" role="menuitem" onClick={() => {
                setDeviceMenuOpen(false);
                localStorage.setItem('spacron.mobile.openDeviceOnMount', '1');
                window.dispatchEvent(new CustomEvent(FLOAT_DEVICE_EVENT, { detail: { platform: tab, target: tab === 'android' ? selectedSerial : iosUdid } }));
                releaseMobileSidebar();
              }}>
                Float device over chat
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => {
              setDeviceMenuOpen(false);
              if (isFloating) {
                setFloating(false);
                onFloatingClose?.();
                window.dispatchEvent(new CustomEvent(CLOSE_FLOAT_DEVICE_EVENT));
              } else {
                sessionStorage.setItem('spacron:mobile:explicitly-closed', '1');
                closeRightSidebar();
              }
            }}>
              {isFloating ? 'Close floating phone' : 'Close device panel'}
            </button>
            {tab === 'ios' && selectedSkin === 'duo' && <button type="button" role="menuitem" disabled={hingeBusy} onClick={() => { setDeviceMenuOpen(false); void changeIosHinge(130); }}>Book posture</button>}

            <span className="mobile-device-menu-separator" />
            <button type="button" role="menuitem" className="danger" disabled={!canPowerOff} onClick={() => void powerOffDevice()}>
              {icoPower}<span>Power off device</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  function startFloatingDrag(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('button, .mobile-device-shell, .mobile-ios-shell, .mobile-device-menu, .mobile-resize-handle')) return;
    const panel = panelRef.current ?? event.currentTarget.closest<HTMLElement>('.mobile-panel-floating');
    const bounds = panel?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    floatingDragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top,
    };
    setFloatingPosition({ left: bounds.left, top: bounds.top });
    if (!floatingSize) {
      setFloatingSize({ width: bounds.width, height: bounds.height });
    }
  }

  function moveFloatingPanel(event: React.PointerEvent<HTMLDivElement>) {
    const drag = floatingDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const panel = panelRef.current ?? event.currentTarget.closest<HTMLElement>('.mobile-panel-floating');
    if (!panel) return;
    const left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, drag.left + event.clientX - drag.x));
    const top = Math.max(0, Math.min(window.innerHeight - 48, drag.top + event.clientY - drag.y));
    setFloatingPosition({ left, top });
  }

  function endFloatingDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (floatingDragRef.current?.pointerId === event.pointerId) floatingDragRef.current = null;
  }

  type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

  function startResize(e: React.PointerEvent, dir: ResizeDirection) {
    e.preventDefault();
    e.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    floatingResizeRef.current = {
      pointerId: e.pointerId,
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: bounds.left,
      startTop: bounds.top,
      startWidth: bounds.width,
      startHeight: bounds.height,
    };
    setFloatingPosition({ left: bounds.left, top: bounds.top });
    setFloatingSize({ width: bounds.width, height: bounds.height });
  }

  function handleResizeMove(e: React.PointerEvent) {
    const resize = floatingResizeRef.current;
    if (!resize || resize.pointerId !== e.pointerId) return;

    const dx = e.clientX - resize.startX;
    const dy = e.clientY - resize.startY;
    const minW = Math.min(320, window.innerWidth - 32);
    const minH = Math.min(420, window.innerHeight - 32);
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;

    let newLeft = resize.startLeft;
    let newTop = resize.startTop;
    let newWidth = resize.startWidth;
    let newHeight = resize.startHeight;

    if (resize.dir.includes('e')) {
      newWidth = Math.max(minW, Math.min(maxW, resize.startWidth + dx));
    } else if (resize.dir.includes('w')) {
      const desiredWidth = resize.startWidth - dx;
      newWidth = Math.max(minW, Math.min(maxW, desiredWidth));
      newLeft = resize.startLeft + (resize.startWidth - newWidth);
    }

    if (resize.dir.includes('s')) {
      newHeight = Math.max(minH, Math.min(maxH, resize.startHeight + dy));
    } else if (resize.dir.includes('n')) {
      const desiredHeight = resize.startHeight - dy;
      newHeight = Math.max(minH, Math.min(maxH, desiredHeight));
      newTop = resize.startTop + (resize.startHeight - newHeight);
    }

    newLeft = Math.max(0, Math.min(window.innerWidth - newWidth, newLeft));
    newTop = Math.max(0, Math.min(window.innerHeight - newHeight, newTop));

    setFloatingPosition({ left: newLeft, top: newTop });
    setFloatingSize({ width: newWidth, height: newHeight });
  }

  function handleResizeEnd(e: React.PointerEvent) {
    if (floatingResizeRef.current?.pointerId === e.pointerId) {
      floatingResizeRef.current = null;
    }
  }

  async function changeIosHinge(angle: number) {
    setHingeBusy(true);
    setIosError(null);
    try {
      await invoke('ios_sim_fold', { udid: iosUdid, angle });
      setHingeMotion((previous) => ({ angle, revision: (previous?.revision ?? 0) + 1 }));
      setRotX(0); setRotY(0);
    } catch (error) { setIosError(`Unable to change hinge posture: ${String(error)}. Requires a compatible serve-sim and Xcode Duo runtime.`); }
    finally { setHingeBusy(false); }
  }
  async function changeHinge(folded: boolean) {
    if (tab === 'ios') { await changeIosHinge(folded ? 0 : 180); return; }
    setHingeBusy(true);
    setFrameError(null);
    try {
      // Resolution overrides mask the AVD's real outer/inner display sizes.
      await invoke('android_preview_resolution', { serial: selectedSerial, width: 0, height: 0 });
      await invoke('android_fold', { serial: selectedSerial, folded });
      const desired = folded ? 'closed' : 'opened';
      let confirmed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = await invoke<typeof androidDisplay>('android_display_state', { serial: selectedSerial });
        if (state?.posture === desired) { setAndroidDisplay(state); confirmed = true; break; }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      }
      if (!confirmed) throw new Error('The emulator has not confirmed the requested hinge posture.');

      setHingeMotion((previous) => ({ angle: folded ? 0 : 180, revision: (previous?.revision ?? 0) + 1 }));
      // Keep the current stream mounted while its chassis folds, then reconnect
      // to the AVD's new inner/outer display dimensions.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 850));
      setRotX(0); setRotY(0);
      setRefreshKey((key) => key + 1);
      stopStream();
      setHingeRevision((key) => key + 1);
    } catch (error) { setFrameError(String(error)); }
    finally { setHingeBusy(false); }
  }
  const deviceProfile = resolveDeviceProfile(tab, tab === 'android' ? [selectedDevice?.model ?? '', ...(avdDetails[selectedDevice?.label ?? ''] ?? []).filter((line) => /^(model|manufacturer):/i.test(line))].join(' ') : '', tab === 'android' ? selectedDevice?.label ?? '' : iosSelectedSim?.name ?? '');
  const selectedSkin = deviceProfile.appearance;
  const detectedBrand = deviceProfile.brand;
  const deviceName = tab === 'android'
    ? selectedDevice?.label ?? (booting && bootingName ? bootingName : 'Android device')
    : iosSelectedSim?.name ?? 'iOS Simulator';

  function renderDeviceHeader() {
    const live = tab === 'android' ? androidStreaming : iosStreaming;
    return (
      <div className="mobile-device-header">
        <button
          type="button"
          className="mobile-device-back"
          onClick={() => {
            setView('list');
            setShowText(false);
            setShowSettings(false);
          }}
          title="All devices"
        >
          <Ico size={14}><path d="m15 18-6-6 6-6" /></Ico>
          <span>Devices</span>
        </button>
        <span className="mobile-device-title" title={`Detected: ${deviceName}${selectedSkin === 'generic' ? ' ? generic chassis' : ''}`}>{deviceName}</span>
        {live && <span className="mobile-live-dot" title="Live stream" />}

      </div>
    );
  }

  function renderAndroidDevice() {
    return (
      <>
        <div className="mobile-device-body" ref={dockRef}>
          <div className="mobile-stage" data-device-skin={selectedSkin} data-device-brand={detectedBrand} data-view={effective3D ? '3d' : '2d'} ref={stageRef}>
            {booting && !selectedSerial ? (
              <EmptyState title={`Starting ${bootingName ?? 'emulator'}…`} body="Emulators take a little while to boot. The screen appears as soon as it is up." />
            ) : !selectedSerial ? (
              <EmptyState title={frameError ? 'Could not start the device' : 'No device selected'} body={frameError ?? 'Go back to Devices and open one.'} />
            ) : streamMode === 'stream' && !streamFallback ? (
              <MobilePhone3D
                key={`android-stream:${selectedSerial}`}
                profile={deviceProfile}
                deviceModel={deviceName}
                foldAngle={tab === 'android' ? androidDisplay?.posture === 'closed' ? 0 : androidDisplay?.posture === 'opened' ? 180 : androidDisplay?.posture === 'half_opened' ? 90 : null : hingeMotion?.angle ?? null}
                hingeMotion={hingeMotion}
                is3D={effective3D}
                rotX={rotX}
                rotY={rotY}
                onRotate={(x, y) => { setRotX(x); setRotY(y); }}
                onResetView={() => { setRotX(0); setRotY(0); }}
                isDraggingDevice={dragging}
                isIos={false}
                aspectStyle={aspectStyle(streamState.dims || frame)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                ariaLabel="Live mobile stream"
                stageRef={stageRef}
                screenContainerRef={screenRef}
              >
                <canvas ref={streamCanvasRef} width={1} height={1} className="mobile-device-screen mobile-stream-canvas" />
              </MobilePhone3D>
            ) : !frame ? (
              <EmptyState
                title={frameError ? 'Cannot reach device' : 'Waiting for screen…'}
                body={frameError ?? 'Connecting to the device.'}
              />
            ) : (
              <MobilePhone3D
                profile={deviceProfile}
                deviceModel={deviceName}
                foldAngle={tab === 'android' ? androidDisplay?.posture === 'closed' ? 0 : androidDisplay?.posture === 'opened' ? 180 : androidDisplay?.posture === 'half_opened' ? 90 : null : hingeMotion?.angle ?? null}
                hingeMotion={hingeMotion}
                is3D={effective3D}
                rotX={rotX}
                rotY={rotY}
                onRotate={(x, y) => { setRotX(x); setRotY(y); }}
                onResetView={() => { setRotX(0); setRotY(0); }}
                isDraggingDevice={dragging}
                isIos={false}
                aspectStyle={aspectStyle(frame)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                ariaLabel="Device screen"
                stageRef={stageRef}
                screenContainerRef={screenRef}
              >
                <img
                  ref={screenRef}
                  className="mobile-device-screen"
                  src={`data:image/jpeg;base64,${frame.image}`}
                  alt="Device screen"
                  draggable={false}
                />
              </MobilePhone3D>
            )}
          </div>

          {!isFloating && <div className="mobile-side-toolbar" role="toolbar" aria-label="Device controls" aria-orientation="vertical">
            <SideBtn title="Home" onClick={() => sendKey(KEY_HOME)} disabled={!selectedSerial}>{icoHome}</SideBtn>
            <SideBtn title="Back" onClick={() => sendKey(KEY_BACK)} disabled={!selectedSerial}>{icoBack}</SideBtn>
            <SideBtn title="Recents" onClick={() => sendKey(KEY_RECENTS)} disabled={!selectedSerial}>{icoRecents}</SideBtn>
            <SideBtn title="Rotate 90° clockwise" onClick={cycleRotation} disabled={!selectedSerial}>{icoRotate}</SideBtn>
            <span className="mobile-side-sep" />
            <SideBtn title={appearanceTitle} onClick={() => void toggleAppearance()} disabled={!selectedSerial}>{icoAppearance}</SideBtn>
            <SideBtn title="Type text" onClick={() => setShowText((v) => !v)} active={showText} disabled={!selectedSerial}>{icoText}</SideBtn>
            <SideBtn title="Tools" onClick={() => setShowSettings((v) => !v)} active={showSettings} disabled={!selectedSerial}>{icoSettings}</SideBtn>
            <SideBtn title="Save screenshot" onClick={() => void saveScreenshot()} disabled={!selectedSerial}>{icoCamera}</SideBtn>
            {renderViewButtons()}
            {renderFoldButtons()}
            {renderDeviceMenu()}
            <span className="mobile-side-sep" />
            <SideBtn title="Power" onClick={() => sendKey(KEY_POWER)} disabled={!selectedSerial}>{icoPower}</SideBtn>
            <SideBtn title="Volume up" onClick={() => sendKey(KEY_VOL_UP)} disabled={!selectedSerial}>{icoVolUp}</SideBtn>
            <SideBtn title="Volume down" onClick={() => sendKey(KEY_VOL_DOWN)} disabled={!selectedSerial}>{icoVolDown}</SideBtn>
          </div>}

          {!isFloating && showSettings && selectedSerial && (
            <DeviceToolsPanel
              key={`android:${selectedSerial}:${toolsKey}`}
              platform="android"
              target={selectedSerial}
              isEmulator={selectedSerial.startsWith('emulator-')}
              orientation={rotation}
              onRotateTo={rotateAndroidTo}
              onClose={() => setShowSettings(false)}
              onError={setFrameError}
              onNotice={(message) => showToast(message, 'success')}
              streamSettings={
                <div className="mobile-toolbar device-tools-stream">
            <span
              className="mobile-quality"
              title={
                streamMode !== 'stream'
                  ? 'Resolution applies to the live stream. Switch back from Snapshot to change it.'
                  : 'Stream resolution. Smaller is smoother, larger is sharper; changing it restarts the stream.'
              }
            >
              <span className="mobile-tool-label">Size</span>
              <Dropdown
                options={[
                  { value: 'auto', label: 'Auto', sublabel: 'Fits the panel' },
                  ...STREAM_SIDE_CHOICES.map((c) => ({
                    value: String(c.side),
                    label: `${c.side}p`,
                    sublabel: c.sublabel,
                  })),
                ]}
                value={formatStreamSideChoice(streamSide)}
                onChange={(value) => setStreamSide(parseStreamSideChoice(value))}
                disabled={!selectedSerial || streamMode !== 'stream'}
                ariaLabel="Stream resolution"
              />
            </span>
            <button
              className={`mobile-stream-toggle${streamMode === 'stream' ? ' active' : ''}`}
              onClick={toggleStreamMode}
              disabled={!selectedSerial}
              title={
                streamMode === 'stream'
                  ? 'Live streaming is on. Click to switch to snapshot polling.'
                  : 'Live streaming is off. Click to switch to the live stream.'
              }
            >
              {streamMode === 'stream' ? 'Live' : 'Snapshot'}
            </button>
                </div>
              }
            />
          )}
        </div>

        {!isFloating && showText && selectedSerial && (
          <div className="mobile-input-row">
            <input
              className="mobile-text-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendText();
              }}
              placeholder="Type into the focused field on the device…"
              autoFocus
            />
            <button className="mobile-send-btn" onClick={() => void sendText()} disabled={!text.trim()}>
              Send
            </button>
          </div>
        )}

        {!isFloating && (frameError || deviceOffline) && (
          <div className={`mobile-status${frameError ? ' error' : ''}`}>
            <span className="mobile-status-text">
              {frameError
                ? streamRetrying
                  ? `${frameError} · retrying the live stream…`
                  : frameError
                : deviceOffline
                  ? `${selectedDevice?.label} is ${selectedDevice?.state}. Unlock the device and authorize USB debugging.`
                  : `${selectedDevice?.label ?? 'Device'} · ${streamState.message ?? 'starting stream…'}`}
            </span>
          </div>
        )}
      </>
    );
  }

  function renderIosDevice() {
    const booted = isBooted(iosSelectedSim?.state);
    return (
      <>
        <div className="mobile-device-body" ref={dockRef}>
          <div className="mobile-stage" data-device-skin={selectedSkin} data-device-brand={detectedBrand} data-view={effective3D ? '3d' : '2d'} ref={stageRef}>
            {booted ? (
              iosStreamMode === 'stream' && mjpegState.phase !== 'error' ? (
                <MobilePhone3D
                  key={`ios-stream:${iosUdid}`}
                  profile={deviceProfile}
                deviceModel={deviceName}
                foldAngle={tab === 'android' ? androidDisplay?.posture === 'closed' ? 0 : androidDisplay?.posture === 'opened' ? 180 : androidDisplay?.posture === 'half_opened' ? 90 : null : hingeMotion?.angle ?? null}
                hingeMotion={hingeMotion}
                is3D={effective3D}
                  rotX={rotX}
                  rotY={rotY}
                  onRotate={(x, y) => { setRotX(x); setRotY(y); }}
                  onResetView={() => { setRotX(0); setRotY(0); }}
                  isDraggingDevice={false}
                  isIos={true}
                  aspectStyle={aspectStyle(mjpegState.dims)}
                  onPointerUp={iosTap}
                  ariaLabel="iOS Simulator live stream"
                  stageRef={stageRef}
                  screenContainerRef={screenRef}
                >
                  <canvas ref={mjpegCanvasRef} width={1} height={1} className="mobile-device-screen mobile-stream-canvas" />
                </MobilePhone3D>
              ) : iosShot ? (
                <MobilePhone3D
                  profile={deviceProfile}
                deviceModel={deviceName}
                foldAngle={tab === 'android' ? androidDisplay?.posture === 'closed' ? 0 : androidDisplay?.posture === 'opened' ? 180 : androidDisplay?.posture === 'half_opened' ? 90 : null : hingeMotion?.angle ?? null}
                hingeMotion={hingeMotion}
                is3D={effective3D}
                  rotX={rotX}
                  rotY={rotY}
                  onRotate={(x, y) => { setRotX(x); setRotY(y); }}
                  onResetView={() => { setRotX(0); setRotY(0); }}
                  isDraggingDevice={false}
                  isIos={true}
                  aspectStyle={aspectStyle(iosShotDims)}
                  onPointerUp={iosTap}
                  ariaLabel="iOS Simulator screen"
                  stageRef={stageRef}
                  screenContainerRef={screenRef}
                >
                  <img
                    ref={iosImgRef}
                    className="mobile-device-screen"
                    src={`data:image/png;base64,${iosShot}`}
                    alt="Simulator screen"
                    draggable={false}
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      if (el.naturalWidth && el.naturalHeight) {
                        const dims = { width: el.naturalWidth, height: el.naturalHeight };
                        setIosShotDims(dims);
                      }
                    }}
                  />
                </MobilePhone3D>
              ) : (
                <EmptyState title="Capturing screen…" body="Waiting for the first screenshot from the simulator." />
              )
            ) : (
              <EmptyState
                title={iosError ? 'Could not start the simulator' : 'Starting simulator…'}
                body={iosError ?? 'The screen appears as soon as the simulator has booted.'}
              />
            )}
          </div>

          {!isFloating && <div className="mobile-side-toolbar" role="toolbar" aria-label="Simulator controls" aria-orientation="vertical">
            <SideBtn title="Home" onClick={() => iosButton('home')} disabled={!booted}>{icoHome}</SideBtn>
            <SideBtn title="Rotate" onClick={cycleIosOrientation} disabled={!booted}>{icoRotate}</SideBtn>
            <span className="mobile-side-sep" />
            <SideBtn title={appearanceTitle} onClick={() => void toggleAppearance()} disabled={!booted}>{icoAppearance}</SideBtn>
            <SideBtn title="Type text" onClick={() => setShowText((v) => !v)} active={showText} disabled={!booted}>{icoText}</SideBtn>
            <SideBtn title="Tools" onClick={() => setShowSettings((v) => !v)} active={showSettings} disabled={!booted}>{icoSettings}</SideBtn>
            <SideBtn title="Save screenshot" onClick={() => void saveScreenshot()} disabled={!booted}>{icoCamera}</SideBtn>
            {renderViewButtons()}
            {renderFoldButtons()}
            {renderDeviceMenu()}
            <span className="mobile-side-sep" />
            <SideBtn
              title={booted ? 'Shut down simulator' : 'Boot simulator'}
              onClick={() => void iosAction(iosUdid, booted ? 'shutdown' : 'boot')}
              disabled={!iosUdid}
            >
              {icoPower}
            </SideBtn>
          </div>}

          {!isFloating && showSettings && booted && (
            <DeviceToolsPanel
              key={`ios:${iosUdid}:${toolsKey}`}
              platform="ios"
              target={iosUdid}
              isEmulator
              orientation={iosOrientation}
              onRotateTo={rotateIosTo}
              onClose={() => setShowSettings(false)}
              onError={setIosError}
              onNotice={(message) => showToast(message, 'success')}
              streamSettings={
                <div className="mobile-toolbar device-tools-stream">
            <button
              className={`mobile-stream-toggle${iosStreamMode === 'stream' ? ' active' : ''}`}
              onClick={toggleIosStreamMode}
              title={
                iosStreamMode === 'stream'
                  ? 'Live streaming is on. Click to switch to snapshot polling.'
                  : 'Live streaming is off. Click to switch to the live stream.'
              }
            >
              {iosStreamMode === 'stream' ? 'Live' : 'Snapshot'}
            </button>
                </div>
              }
            />
          )}
        </div>

        {!isFloating && showText && booted && (
          <div className="mobile-input-row">
            <input
              className="mobile-text-input"
              value={iosText}
              onChange={(e) => setIosText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void iosSendText();
              }}
              placeholder="Type into the focused field on the simulator…"
              autoFocus
            />
            <button className="mobile-send-btn" onClick={() => void iosSendText()} disabled={!iosText.trim()}>
              Send
            </button>
          </div>
        )}

        {!isFloating && iosError && booted && (
          <div className="mobile-status error">
            <span className="mobile-status-text">{iosError}</span>
          </div>
        )}
      </>
    );
  }

  const panel = (
    <div
      ref={panelRef}
      className={`mobile-panel${isFloating ? ' mobile-panel-floating' : ''}`}
      style={
        isFloating
          ? {
              left: floatingPosition ? `${floatingPosition.left}px` : `${80 + windowIndex * 36}px`,
              top: floatingPosition ? `${floatingPosition.top}px` : `${80 + windowIndex * 28}px`,
              right: floatingPosition ? 'auto' : undefined,
              bottom: floatingPosition ? 'auto' : undefined,
              width: floatingSize ? `${floatingSize.width}px` : undefined,
              height: floatingSize ? `${floatingSize.height}px` : undefined,
            }
          : undefined
      }
      onPointerDown={isFloating ? startFloatingDrag : undefined}
      onPointerMove={isFloating ? moveFloatingPanel : undefined}
      onPointerUp={isFloating ? endFloatingDrag : undefined}
      onPointerCancel={isFloating ? endFloatingDrag : undefined}
    >
      {isFloating && (
        <>
          {/* 8-Direction Resize Handles: resize smoothly from any angle */}
          <div className="mobile-resize-handle handle-n" onPointerDown={(e) => startResize(e, 'n')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
          <div className="mobile-resize-handle handle-s" onPointerDown={(e) => startResize(e, 's')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
          <div className="mobile-resize-handle handle-e" onPointerDown={(e) => startResize(e, 'e')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
          <div className="mobile-resize-handle handle-w" onPointerDown={(e) => startResize(e, 'w')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
          <div className="mobile-resize-handle handle-nw" onPointerDown={(e) => startResize(e, 'nw')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
          <div className="mobile-resize-handle handle-ne" onPointerDown={(e) => startResize(e, 'ne')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
          <div className="mobile-resize-handle handle-sw" onPointerDown={(e) => startResize(e, 'sw')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
          <div className="mobile-resize-handle handle-se" onPointerDown={(e) => startResize(e, 'se')} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} />
        </>
      )}
      {isFloating && (
        <div className="mobile-floating-header">
          <span title={deviceName}>{deviceName}</span>
          <button type="button" onClick={() => {
            localStorage.removeItem('spacron.mobile.openDeviceOnMount');
            // Open this device itself in the sidebar, not the device list.
            const target = tab === 'android' ? selectedSerial : iosUdid;
            if (target) {
              localStorage.setItem(DOCK_DEVICE_KEY, JSON.stringify({ platform: tab, target } satisfies DeviceWindow));
              window.dispatchEvent(new CustomEvent(DOCK_DEVICE_EVENT));
            }
            setFloating(false);
            onFloatingClose?.();
            window.dispatchEvent(new CustomEvent(CLOSE_FLOAT_DEVICE_EVENT));
            window.dispatchEvent(new CustomEvent('spacron:mobile:reset-perfect-3d'));
            openMobileSidebar();
          }}>Devices</button>
          <button
            type="button"
            className="mobile-floating-close-btn"
            onClick={() => {
              setFloating(false);
              onFloatingClose?.();
              window.dispatchEvent(new CustomEvent(CLOSE_FLOAT_DEVICE_EVENT));
            }}
            title="Close floating window"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      )}
      {view === 'list' ? (
        renderDeviceList()
      ) : (
        <div className="mobile-device-view">
          {!isFloating && renderDeviceHeader()}
          {tab === 'android' ? renderAndroidDevice() : renderIosDevice()}
        </div>
      )}
    </div>
  );
  return isFloating ? createPortal(panel, document.body) : panel;
}
