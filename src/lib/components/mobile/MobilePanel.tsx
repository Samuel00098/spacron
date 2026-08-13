import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Dropdown from '$lib/components/shared/Dropdown.tsx';
import './MobilePanel.css';
import { useMjpegStream } from './useMjpegStream';
import { useScrcpyStream } from './useScrcpyStream';
import { desiredStreamLongSide } from './streamResolution';
import { sendStreamKey, sendStreamText, useStreamTouch } from './useStreamInput';

interface AndroidDevice {
  serial: string;
  state: string;
  label: string;
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
/** iOS screenshot poll cadence (view-only mirror). */
const IOS_POLL_MS = 1500;

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
  return dims && dims.width > 0 && dims.height > 0
    ? ({ aspectRatio: `${dims.width} / ${dims.height}` } as const)
    : undefined;
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

export default function MobilePanel() {
  const [tab, setTab] = useState<MobileTab>('android');
  const [platform, setPlatform] = useState('');

  // ── Android ────────────────────────────────────────────────────────────
  const [tools, setTools] = useState<AndroidTools | null>(null);
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [avds, setAvds] = useState<string[]>([]);
  const [selectedSerial, setSelectedSerial] = useState(
    () => localStorage.getItem('spacron.mobile.serial') ?? '',
  );
  const [avdName, setAvdName] = useState('');
  const [frame, setFrame] = useState<AndroidFrame | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [text, setText] = useState('');
  // Bumping this restarts the poll loop and forces an immediate capture —
  // used to redraw right after an input injection instead of waiting a tick.
  const [refreshKey, setRefreshKey] = useState(0);
  // Streaming vs snapshot-polling mirror. Live streaming (scrcpy on Android,
  // serve-sim on iOS) is the default when the platform supports it; a stream
  // failure auto-falls back to polling with the reason surfaced.
  const [streamMode, setStreamMode] = useState<'stream' | 'poll'>('stream');
  const [iosStreamMode, setIosStreamMode] = useState<'stream' | 'poll'>('stream');
  const [iosText, setIosText] = useState('');
  const [iosOrientation, setIosOrientation] = useState(0);

  // ── iOS ────────────────────────────────────────────────────────────────
  const [sims, setSims] = useState<IosSimulator[]>([]);
  const [iosUdid, setIosUdid] = useState('');
  const [iosShot, setIosShot] = useState<string | null>(null);
  const [iosShotDims, setIosShotDims] = useState<{ width: number; height: number } | null>(null);
  const [iosError, setIosError] = useState<string | null>(null);
  const [iosActionKey, setIosActionKey] = useState(0);

  // The Android stage. Measured (not the device shell, which is content-sized
  // until a frame gives it an aspect ratio) to decide what resolution to ask
  // the device for — see `streamResolution.ts`.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLImageElement | null>(null);
  const iosImgRef = useRef<HTMLImageElement | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointerMovedRef = useRef(false);
  // True while a gesture is being streamed to the device live (control channel).
  // When it is false the gesture is replayed as one adb tap/swipe on release.
  const liveGestureRef = useRef(false);
  const touch = useStreamTouch();

  // Live-stream hooks: one for the Android scrcpy H.264 stream (WebCodecs), one
  // for the iOS serve-sim MJPEG stream. Each owns its canvas, its Tauri
  // channel, and its decode loop; the panel decides when to start/stop them.
  const {
    canvasRef: streamCanvasRef,
    state: streamState,
    start: startStream,
    stop: stopStream,
    supported: streamSupported,
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

  // ── Android: list devices + AVDs + tool presence ───────────────────────
  const refreshAndroid = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const [devs, avdList, toolsInfo] = await Promise.all([
        invoke<AndroidDevice[]>('android_list_devices'),
        invoke<string[]>('android_list_avds'),
        invoke<AndroidTools>('android_check'),
      ]);
      setDevices(devs);
      setAvds(avdList);
      setTools(toolsInfo);
      // Keep the current pick while it still exists; otherwise jump to the
      // first online device, or clear the stale serial entirely.
      setSelectedSerial((prev) => {
        if (prev && devs.some((d) => d.serial === prev)) return prev;
        const online = devs.find((d) => d.state === 'device');
        return online?.serial ?? '';
      });
    } catch (e) {
      setFrameError(String(e));
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'android') void refreshAndroid();
  }, [tab, refreshAndroid]);

  // ── Android: live H.264 stream (scrcpy) when supported + enabled ─────
  useEffect(() => {
    if (tab !== 'android' || !selectedSerial || !streamSupported || streamMode !== 'stream') {
      stopStream();
      return;
    }
    // Ask for the pixels this panel can actually paint, rather than a fixed
    // constant: a HiDPI screen needs ~2x a standard one for the same CSS box,
    // and a narrow drawer needs far less than either. Measured at stream START
    // only — re-negotiating mid-drag would restart the stream on every frame of
    // a drawer resize. Widening the panel and wanting it sharper means toggling
    // Live off/on (or switching device), which restarts it anyway.
    const stage = stageRef.current?.getBoundingClientRect();
    const maxSide = desiredStreamLongSide(
      stage?.width ?? 0,
      stage?.height ?? 0,
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    );
    void startStream(selectedSerial, maxSide);
  }, [tab, selectedSerial, streamMode, streamSupported, startStream, stopStream]);

  // A stream failure falls back to snapshot polling and surfaces the reason.
  useEffect(() => {
    if (streamState.phase === 'error') {
      setStreamMode('poll');
      setFrameError(streamState.message ?? 'Screen stream failed.');
    }
  }, [streamState.phase, streamState.message]);

  // ── Android: live mirror — poll screencap while a device is selected ───
  //
  // `androidStreaming` must stay in the dependency list: the guard below runs
  // once per effect, so leaving it out kept the interval alive after the stream
  // came up. A capture costs seconds of adb time on a local emulator, and it
  // was competing with the stream and with every injected tap for the same adb
  // connection — the single worst thing for how responsive the panel feels.
  useEffect(() => {
    if (tab !== 'android' || !selectedSerial || androidStreaming) return;
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
  }, [tab, selectedSerial, refreshKey, androidStreaming]);

  // ── iOS: list simulators on tab open / after boot actions ─────────────
  useEffect(() => {
    if (tab !== 'ios') return;
    void (async () => {
      try {
        const list = await invoke<IosSimulator[]>('ios_list_simulators');
        setSims(list);
        setIosError(null);
        setIosUdid((prev) => {
          if (prev && list.some((s) => s.udid === prev)) return prev;
          return list.find((s) => isBooted(s.state))?.udid ?? list[0]?.udid ?? '';
        });
      } catch (e) {
        setIosError(String(e));
      }
    })();
  }, [tab, iosActionKey]);

  // ── iOS: serve-sim live stream when enabled + booted ─────────────────
  useEffect(() => {
    if (tab !== 'ios' || !iosUdid || iosStreamMode !== 'stream') {
      stopMjpeg();
      return;
    }
    const sim = sims.find((s) => s.udid === iosUdid);
    if (!sim || !isBooted(sim.state)) {
      stopMjpeg();
      return;
    }
    void startMjpeg(iosUdid);
  }, [tab, iosUdid, iosStreamMode, sims, startMjpeg, stopMjpeg]);

  // A serve-sim stream failure falls back to screenshot polling.
  useEffect(() => {
    if (mjpegState.phase === 'error') {
      setIosStreamMode('poll');
      setIosError(mjpegState.message ?? 'Simulator stream failed.');
    }
  }, [mjpegState.phase, mjpegState.message]);

  // ── iOS: screenshot mirror of the selected booted sim (polling) ───────
  useEffect(() => {
    if (tab !== 'ios' || !iosUdid || iosStreaming) return;
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
  }, [tab, iosUdid, sims, iosStreaming]);

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
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
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

  function onPointerDown(e: React.PointerEvent) {
    if (!selectedSerial) return;
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
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
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
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const list = await invoke<AndroidDevice[]>('android_list_devices');
        setDevices(list);
        const emu = list.find((d) => d.serial.startsWith('emulator-') && d.state === 'device');
        if (emu) {
          setSelectedSerial(emu.serial);
          break;
        }
      }
    } catch (e) {
      setFrameError(String(e));
    } finally {
      setBooting(false);
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

  const selectedDevice = devices.find((d) => d.serial === selectedSerial);
  const deviceOffline = Boolean(selectedDevice && selectedDevice.state !== 'device');
  const iosSelectedSim = sims.find((s) => s.udid === iosUdid);

  return (
    <div className="mobile-panel">
      <div className="mobile-tabs">
        <button
          className={`mobile-tab${tab === 'android' ? ' active' : ''}`}
          onClick={() => setTab('android')}
        >
          Android
        </button>
        <button
          className={`mobile-tab${tab === 'ios' ? ' active' : ''}`}
          onClick={() => setTab('ios')}
        >
          iOS {platform && platform !== 'macos' ? <span className="mobile-tab-note">macOS only</span> : null}
        </button>
      </div>

      {tab === 'android' ? (
        <>
          <div className="mobile-toolbar">
            <span className="mobile-tool-label">Device</span>
            <Dropdown
              // The leading empty option preserves the native select's ability
              // to clear the pick: it prompts while nothing is chosen and
              // reads "No device" once a device is selected.
              options={[
                {
                  value: '',
                  label: devices.length === 0 ? 'No devices found' : selectedSerial ? 'No device' : 'Select a device…',
                },
                ...devices.map((d) => ({ value: d.serial, label: d.label, sublabel: d.state })),
              ]}
              value={selectedSerial}
              onChange={(serial) => {
                setSelectedSerial(serial);
                // Drop the previous device's frame so a stale screen never
                // lingers (and stale dimensions never skew tap mapping).
                setFrame(null);
                setFrameError(null);
              }}
              disabled={devices.length === 0}
              ariaLabel="Select a device"
            />
            <button
              className="mobile-icon-btn"
              onClick={() => void refreshAndroid()}
              title="Refresh devices"
              disabled={devicesLoading}
            >
              <Ico>
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </Ico>
            </button>

            {tools?.emulator && avds.length > 0 && (
              <span className="mobile-avd">
                <span className="mobile-tool-label">AVD</span>
                <Dropdown
                  options={[{ value: '', label: avdName ? 'No AVD' : 'Select AVD…' }, ...avds.map((a) => ({ value: a, label: a }))]}
                  value={avdName}
                  onChange={setAvdName}
                  ariaLabel="Select an Android Virtual Device"
                />
                <button
                  className="mobile-launch-btn"
                  onClick={() => void launchAvd(avdName)}
                  disabled={!avdName || booting}
                >
                  {booting ? 'Booting…' : 'Launch'}
                </button>
              </span>
            )}

            <button
              className="mobile-icon-btn"
              onClick={cycleRotation}
              disabled={!selectedSerial}
              title="Rotate 90° clockwise"
            >
              <Ico>
                <path d="M23 4v6h-6" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </Ico>
            </button>

            {streamSupported && (
              <button
                className={`mobile-stream-toggle${streamMode === 'stream' ? ' active' : ''}`}
                onClick={toggleStreamMode}
                disabled={!selectedSerial}
                title={
                  streamMode === 'stream'
                    ? 'Live streaming is on — switch to snapshot polling'
                    : 'Live streaming is off — switch to the live stream'
                }
              >
                {streamMode === 'stream' ? 'Live' : 'Snapshot'}
              </button>
            )}
          </div>

          <div className="mobile-stage" ref={stageRef}>
            {!tools ? (
              <EmptyState
                title={frameError ? 'Could not reach the Android tooling' : 'Checking for Android SDK…'}
                body={frameError ?? 'Looking for adb and the emulator on PATH.'}
              />
            ) : !tools.adb ? (
              <EmptyState
                title="Android SDK not found"
                body="Install Android Studio (or the platform-tools package) so adb is on PATH, then restart Spacron."
              />
            ) : devices.length === 0 ? (
              <EmptyState
                title="No devices connected"
                body={
                  tools.emulator && avds.length > 0
                    ? 'Start an emulator from the AVD picker above, or plug in a device with USB debugging enabled.'
                    : 'Plug in a device with USB debugging enabled, or install an emulator image so one can be launched here.'
                }
              />
            ) : androidStreaming ? (
              <div
                className="mobile-device-shell"
                style={aspectStyle(streamState.dims)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                title="Click to tap · drag to swipe"
              >
                <canvas ref={streamCanvasRef} className="mobile-device-screen mobile-stream-canvas" />
              </div>
            ) : !frame ? (
              <EmptyState
                title={frameError ? 'Cannot reach device' : 'Waiting for screen…'}
                body={frameError ?? 'Select a device above to start the live mirror.'}
              />
            ) : (
              <div
                className="mobile-device-shell"
                style={aspectStyle(frame)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                title="Click to tap · drag to swipe"
              >
                <img
                  ref={screenRef}
                  className="mobile-device-screen"
                  src={`data:image/jpeg;base64,${frame.image}`}
                  alt="Device screen"
                  draggable={false}
                />
              </div>
            )}
          </div>

          {selectedSerial && (
            <>
              <div className="mobile-controls">
                <button className="mobile-key-btn" onClick={() => sendKey(KEY_POWER)} title="Power">
                  <Ico><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" /></Ico>
                </button>
                <button className="mobile-key-btn" onClick={() => sendKey(KEY_VOL_UP)} title="Volume up">
                  <Ico><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="15.5" y1="9" x2="15.5" y2="15" /><line x1="18.5" y1="7" x2="18.5" y2="17" /></Ico>
                </button>
                <button className="mobile-key-btn" onClick={() => sendKey(KEY_VOL_DOWN)} title="Volume down">
                  <Ico><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="15.5" y1="12" x2="18.5" y2="12" /></Ico>
                </button>
                <span className="mobile-controls-sep" />
                <button className="mobile-key-btn" onClick={() => sendKey(KEY_BACK)} title="Back">
                  <Ico><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></Ico>
                </button>
                <button className="mobile-key-btn" onClick={() => sendKey(KEY_HOME)} title="Home">
                  <Ico><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></Ico>
                </button>
                <button className="mobile-key-btn" onClick={() => sendKey(KEY_RECENTS)} title="Recents">
                  <Ico><rect x="8" y="8" width="8" height="8" rx="1.5" /><line x1="3.5" y1="12" x2="5.5" y2="12" /><line x1="18.5" y1="12" x2="20.5" y2="12" /></Ico>
                </button>
                <button className="mobile-key-btn" onClick={() => sendKey(KEY_MENU)} title="Menu">
                  <Ico><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></Ico>
                </button>
              </div>
              <div className="mobile-input-row">
                <input
                  className="mobile-text-input"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendText();
                  }}
                  placeholder="Type into the focused field on the device…"
                />
                <button className="mobile-send-btn" onClick={() => void sendText()} disabled={!text.trim()}>
                  Send text
                </button>
              </div>
            </>
          )}

          <div className={`mobile-status${frameError ? ' error' : ''}`}>
            <span className="mobile-status-text">
              {frameError
                ? frameError
                : deviceOffline
                  ? `${selectedDevice?.label} is ${selectedDevice?.state} — unlock the device and authorize USB debugging.`
                  : streamMode === 'stream' && streamState.phase === 'starting'
                    ? `${selectedDevice?.label ?? 'Device'} · ${streamState.message ?? 'starting stream…'}`
                    : androidStreaming
                      ? `${selectedDevice?.label ?? 'Device'}${
                          streamState.dims ? ` · ${streamState.dims.width}×${streamState.dims.height}px` : ''
                        } · live stream`
                      : selectedDevice
                        ? `${selectedDevice.label}${frame ? ` · ${frame.width}×${frame.height}px` : ' · connecting…'}`
                        : 'No device selected.'}
            </span>
            {(frame || androidStreaming) && !frameError && (
              <span className="mobile-live-dot" title={androidStreaming ? 'Live stream' : 'Live mirror'} />
            )}
          </div>
        </>
      ) : (
        <div className="mobile-ios">
          {!platform ? (
            <div className="mobile-stage">
              <EmptyState
                title="Checking platform…"
                body="Detecting whether iOS simulator tooling can run on this machine."
              />
            </div>
          ) : platform !== 'macos' ? (
            <div className="mobile-stage">
              <EmptyState
                title="iOS Simulator requires macOS"
                body="Apple's simctl tooling only runs on a Mac. The interactive Android mirror works on every platform."
              />
            </div>
          ) : sims.length === 0 ? (
            <div className="mobile-stage">
              <EmptyState
                title={iosError ? 'iOS unavailable' : 'No simulators installed'}
                body={iosError ?? 'Install an iOS simulator runtime from Xcode → Settings → Components, then return here.'}
              />
            </div>
          ) : (
            <>
              <div className="mobile-toolbar">
                <span className="mobile-tool-label">Simulator</span>
                <Dropdown
                  options={sims.map((s) => ({ value: s.udid, label: s.name, sublabel: s.runtime }))}
                  value={iosUdid}
                  onChange={(udid) => {
                    setIosUdid(udid);
                    setIosShot(null);
                    setIosShotDims(null);
                    setIosError(null);
                  }}
                  placeholder="Select a simulator…"
                  ariaLabel="Select an iOS simulator"
                />
                <button
                  className="mobile-launch-btn"
                  onClick={() => void iosAction(iosUdid, isBooted(iosSelectedSim?.state) ? 'shutdown' : 'boot')}
                  disabled={!iosUdid}
                >
                  {isBooted(iosSelectedSim?.state) ? 'Shutdown' : 'Boot'}
                </button>
              </div>

              <div className="mobile-stage">
                {isBooted(iosSelectedSim?.state) ? (
                  iosStreaming ? (
                    <div
                      className="mobile-ios-shell mobile-ios-shell--stream"
                      style={aspectStyle(mjpegState.dims)}
                      onPointerUp={iosTap}
                      title="Click to tap"
                    >
                      <canvas ref={mjpegCanvasRef} className="mobile-device-screen mobile-stream-canvas" />
                    </div>
                  ) : iosShot ? (
                    <div
                      className="mobile-ios-shell"
                      style={aspectStyle(iosShotDims)}
                      onPointerUp={iosTap}
                      title="Click to tap"
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
                            setIosShotDims({ width: el.naturalWidth, height: el.naturalHeight });
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <EmptyState title="Capturing screen…" body="Waiting for the first screenshot from the simulator." />
                  )
                ) : (
                  <EmptyState
                    title="Simulator not booted"
                    body="Press Boot to start this simulator. The screen and touch input need a booted device."
                  />
                )}
              </div>

              {isBooted(iosSelectedSim?.state) && (
                <>
                  <div className="mobile-controls">
                    <button
                      className={`mobile-stream-toggle${iosStreamMode === 'stream' ? ' active' : ''}`}
                      onClick={toggleIosStreamMode}
                      title={
                        iosStreamMode === 'stream'
                          ? 'Live streaming is on — switch to snapshot polling'
                          : 'Live streaming is off — switch to the live stream'
                      }
                    >
                      {iosStreamMode === 'stream' ? 'Live' : 'Snapshot'}
                    </button>
                    <span className="mobile-controls-sep" />
                    <button className="mobile-key-btn" onClick={() => iosButton('home')} title="Home">
                      <Ico><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></Ico>
                    </button>
                    <button className="mobile-key-btn" onClick={cycleIosOrientation} title="Rotate">
                      <Ico><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></Ico>
                    </button>
                  </div>
                  <div className="mobile-input-row">
                    <input
                      className="mobile-text-input"
                      value={iosText}
                      onChange={(e) => setIosText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void iosSendText();
                      }}
                      placeholder="Type into the focused field on the simulator…"
                    />
                    <button className="mobile-send-btn" onClick={() => void iosSendText()} disabled={!iosText.trim()}>
                      Send
                    </button>
                  </div>
                </>
              )}

              <div className={`mobile-status${iosError ? ' error' : ''}`}>
                <span className="mobile-status-text">
                  {iosError ??
                    (isBooted(iosSelectedSim?.state)
                      ? iosStreaming
                        ? `${iosSelectedSim?.name} · live stream`
                        : `${iosSelectedSim?.name} · ${iosShot ? 'mirror' : 'connecting…'}`
                      : 'Simulator is powered off.')}
                </span>
                {(iosShot || iosStreaming) && !iosError && (
                  <span className="mobile-live-dot" title={iosStreaming ? 'Live stream' : 'View-only mirror'} />
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
