import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { arraysEqual, base64ToBytes, buildAvcC, h264CodecString, parseFrame } from '$lib/services/scrcpy';

// Frame-recency watchdog. A disconnected device can leave the adb forward
// tunnel half-open: the backend's reader thread blocks forever (it reads with
// no timeout, because a static screen legitimately produces no frames) and no
// error event ever arrives — the canvas would freeze on its last frame. The
// watchdog trips when no frame has arrived for a while, but it does not kill
// the stream on silence alone: Android's encoder goes quiet on a static
// screen, so it first asks adb whether the device is still attached.
const STALE_FRAME_MS = 6000;
const WATCHDOG_TICK_MS = 2000;

/** Minimal shape of `android_list_devices` entries, for the liveness probe. */
interface AdbDevice {
  serial: string;
  state: string;
}

export interface StreamDims {
  width: number;
  height: number;
}

export type StreamPhase = 'idle' | 'starting' | 'streaming' | 'error';

export interface StreamState {
  phase: StreamPhase;
  message?: string;
  dims?: StreamDims;
  /**
   * The failure cannot be fixed by trying again (this webview simply cannot
   * decode what this device sends). The panel uses it to fall back to
   * snapshots immediately instead of spending its retry budget.
   */
  fatal?: boolean;
}

/** One message from the backend's `mobile_stream_start` channel. */
interface ScrcpyStreamEvent {
  kind: 'status' | 'ready' | 'frame' | 'png_frame' | 'error';
  message?: string;
  width?: number;
  height?: number;
  data?: string;
  keyframe?: boolean;
  config?: boolean;
  pts?: number;
  /** `png_frame` only: the emulator's frame counter. Skips on dropped frames. */
  seq?: number;
}

// Minimal local shapes for the WebCodecs APIs, so this file does not depend on
// the TS DOM lib exposing them. The globals are resolved via `window` casts.
interface VideoDecoderLike {
  readonly state: string;
  configure(config: { codec: string; description?: Uint8Array; optimizeForLatency?: boolean }): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
}
interface VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

function makeChunk(type: 'key' | 'delta', timestamp: number, data: Uint8Array): unknown {
  const Ctor = (window as unknown as { EncodedVideoChunk?: new (init: unknown) => unknown }).EncodedVideoChunk;
  if (!Ctor) return null;
  return new Ctor({ type, timestamp, data });
}

/**
 * Runs the backend scrcpy stream (see `src-tauri/src/commands/mobile_stream.rs`)
 * and decodes its H.264 packets with WebCodecs onto the returned `<canvas>`.
 *
 * Responsibilities that live here rather than in the panel:
 * - creating the Tauri channel and wiring `mobile_stream_start` / `_stop`,
 * - building the avcC description from in-band SPS/PPS and rebuilding the
 *   `VideoDecoder` when the SPS changes (device rotation restarts the encoder
 *   with a new SPS — same buffer dimensions story as the polling mirror),
 * - painting decoded frames to the canvas and reporting the live dimensions.
 *
 * The panel owns when to start/stop (device pick, tab, mode toggle) and what
 * to do on `state.phase === 'error'` (fall back to screenshot polling).
 *
 * A monotonic generation guards against a stale `start` resolving late (its
 * first-run jar download can take tens of seconds, during which the panel may
 * have switched devices or toggled modes): each start/stop bumps it, channel
 * events and the invoke result are ignored when their generation is no longer
 * current, and an abandoned stream is stopped before it can orphan a backend
 * thread.
 */
let lastKnownStreamDims: StreamDims | null = null;

export function useScrcpyStream() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<StreamState>(() => ({
    phase: 'idle',
    dims: lastKnownStreamDims ?? undefined,
  }));
  const streamIdRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const decoderRef = useRef<VideoDecoderLike | null>(null);
  const descriptionRef = useRef<Uint8Array | null>(null);
  const serialRef = useRef<string | null>(null);
  /** The `maxSide` the live stream was opened with, to detect a resolution change. */
  const maxSideRef = useRef<number | undefined>(undefined);
  const lastFrameAtRef = useRef(0);
  const probeInFlightRef = useRef(false);
  // Highest emulator frame `seq` already painted, so an out-of-order
  // `createImageBitmap` result never overwrites a newer frame. Reset per start.
  const pngSeqRef = useRef(-1);
  // The canvas 2D context, cached per canvas element. `desynchronized` lets the
  // compositor skip a frame of latency, and `alpha: false` drops the per-frame
  // blend — the device screen is fully opaque anyway.
  const ctxRef = useRef<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);

  const contextFor = useCallback((canvas: HTMLCanvasElement) => {
    const cached = ctxRef.current;
    if (cached && cached.canvas === canvas) return cached.ctx;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) as CanvasRenderingContext2D | null;
    ctxRef.current = ctx ? { canvas, ctx } : null;
    return ctx;
  }, []);

  const supported =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder === 'function' &&
    typeof (window as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk === 'function';

  const closeDecoder = useCallback(() => {
    descriptionRef.current = null;
    const decoder = decoderRef.current;
    decoderRef.current = null;
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {
        // Already torn down.
      }
    }
  }, []);

  const createDecoder = useCallback(
    (description?: Uint8Array) => {
      const Ctor = (window as unknown as { VideoDecoder?: new (init: unknown) => VideoDecoderLike }).VideoDecoder;
      if (!Ctor) return;
      const decoder = new Ctor({
        output: (frame: VideoFrameLike) => {
          const canvas = canvasRef.current;
          const w = frame.displayWidth;
          const h = frame.displayHeight;
          if (canvas && w > 0 && h > 0) {
            if (canvas.width !== w || canvas.height !== h) {
              canvas.width = w;
              canvas.height = h;
            }
            const ctx = contextFor(canvas);
            if (ctx) {
              ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
              // Returning the previous state object makes React bail out of the
              // re-render. Without that this fires 30–60 times a second and
              // re-renders the whole panel — which is exactly the work that
              // makes pointer events feel late.
              setState((s) =>
                s.phase === 'streaming' && s.dims?.width === w && s.dims?.height === h
                  ? s
                  : { ...s, phase: 'streaming', dims: { width: w, height: h } },
              );
            }
          }
          frame.close();
        },
        error: (e: unknown) => {
          closeDecoder();
          setState({ phase: 'error', message: `Video decode failed: ${String((e as Error)?.message ?? e)}` });
        },
      });
      try {
        decoder.configure({
          codec: description ? h264CodecString(description) : 'avc1.42001f',
          description,
          optimizeForLatency: true,
        });
        decoderRef.current = decoder;
        descriptionRef.current = description ?? null;
      } catch (e) {
        setState({ phase: 'error', message: `Could not start the H.264 decoder: ${String(e)}` });
      }
    },
    [closeDecoder, contextFor],
  );

  const handleFrame = useCallback(
    (ev: ScrcpyStreamEvent) => {
      if (!ev.data) return;
      // Only this transport needs WebCodecs — the emulator's PNG path decodes
      // with `createImageBitmap`, which every webview has. Which transport the
      // backend picks is not known until the first frame arrives, so the check
      // belongs here and not at `start()`: gating the whole live stream on
      // WebCodecs would strand an emulator on 1 fps snapshots (WebKitGTK below
      // 2.44 has no WebCodecs) for a codec it was never going to use.
      if (!supported) {
        setState((s) =>
          s.phase === 'error' && s.fatal
            ? s
            : {
                phase: 'error',
                fatal: true,
                message:
                  'This device streams H.264, which this webview cannot decode (WebCodecs unavailable), so it is falling back to snapshots.',
              },
        );
        return;
      }
      // A frame arriving at all means the device is alive and the tunnel is
      // carrying data — feed the watchdog regardless of what the NALs hold.
      lastFrameAtRef.current = Date.now();
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(ev.data);
      } catch {
        return;
      }
      // One pass over the packet yields both the parameter sets and the
      // decodable access units, already converted to the AVCC form the decoder
      // is configured for (scrcpy sends Annex-B).
      const { sps, pps, units } = parseFrame(bytes);

      // New SPS → new encoder configuration (rotation, resolution change).
      // Rebuild the decoder before decoding anything with the old one.
      if (sps && pps) {
        const desc = buildAvcC(sps, pps);
        const current = descriptionRef.current;
        if (!current || !arraysEqual(current, desc)) {
          // No need to set `descriptionRef` here: `closeDecoder` clears it and
          // `createDecoder` sets it to this exact description.
          closeDecoder();
          createDecoder(desc);
        }
      }

      const decoder = decoderRef.current;
      if (!decoder || decoder.state !== 'configured') return;
      for (const unit of units) {
        const chunk = makeChunk(ev.keyframe ? 'key' : 'delta', ev.pts ?? 0, unit);
        if (!chunk) return;
        try {
          decoder.decode(chunk);
        } catch {
          // A single bad access unit must not kill the stream; the next IDR
          // (with fresh SPS/PPS) resynchronises.
        }
      }
    },
    [closeDecoder, createDecoder, supported],
  );

  /**
   * Paint one whole PNG frame from an emulator's host-side gRPC stream.
   *
   * No codec state to carry: unlike the H.264 path there is no keyframe/delta
   * distinction, no SPS/PPS and nothing to reconfigure on rotation — a rotated
   * frame simply arrives with new dimensions and the canvas follows.
   *
   * `createImageBitmap` is async, so two frames CAN finish decoding out of
   * order and the later one would be painted over by the earlier. The
   * emulator's monotonic `seq` is the guard: a bitmap that resolves behind one
   * already painted is dropped rather than drawn.
   */
  const handlePngFrame = useCallback(
    (ev: ScrcpyStreamEvent) => {
      if (!ev.data) return;
      // A frame arriving at all means the emulator is alive — feed the watchdog
      // before any of the decode work, exactly as the H.264 path does.
      lastFrameAtRef.current = Date.now();
      const seq = ev.seq ?? 0;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(ev.data);
      } catch {
        return;
      }
      const generation = generationRef.current;
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
      void createImageBitmap(blob)
        .then((bitmap) => {
          const stale =
            generation !== generationRef.current || !activeRef.current || seq < pngSeqRef.current;
          const canvas = canvasRef.current;
          const w = bitmap.width;
          const h = bitmap.height;
          if (stale || !canvas || w <= 0 || h <= 0) {
            bitmap.close();
            return;
          }
          pngSeqRef.current = seq;
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          const ctx = contextFor(canvas);
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0, w, h);
            // Same React bail-out as the decoder path: this fires ~26 times a
            // second and re-rendering the panel each time is exactly the work
            // that makes pointer events feel late.
            setState((s) =>
              s.phase === 'streaming' && s.dims?.width === w && s.dims?.height === h
                ? s
                : { ...s, phase: 'streaming', dims: { width: w, height: h } },
            );
          }
          // Bitmaps hold decoded pixels outside the JS heap; not closing them
          // leaks ~1 MB per frame and the GC will not save you.
          bitmap.close();
        })
        .catch(() => {
          // One undecodable frame is not fatal — the next one repaints.
        });
    },
    [contextFor],
  );

  const cleanup = useCallback(async () => {
    generationRef.current += 1;
    activeRef.current = false;
    const id = streamIdRef.current;
    streamIdRef.current = null;
    // Decoder first, then the stop-await: closing synchronously guarantees no
    // queued output callback can paint over an error state this hook just set
    // (a live decoder drains within a frame, but ordering removes the race).
    closeDecoder();
    // A probe's invoke may never settle (hung adb) — resetting the flag here
    // lets a successor stream's watchdog probe again instead of wedging on it.
    probeInFlightRef.current = false;
    if (id) {
      try {
        await invoke('mobile_stream_stop', { streamId: id });
      } catch {
        // Already gone.
      }
    }
  }, [closeDecoder]);

  const start = useCallback(
    /**
     * `maxSide` is the longest edge to ask for, and reaches **both** transports
     * — the gRPC path's requested box and scrcpy's `max_size`. Omitted means
     * the backend's own default for the device kind (720 for an emulator that
     * fell back to scrcpy, 1080 for a physical device). Larger works and stays
     * usable on the emulator path — 1024 ≈ 15 fps, 1200 ≈ 13 fps, both still
     * well ahead of scrcpy — but the frame rate falls off steeply past that.
     */
    async (serial: string, maxSide?: number) => {
      // Already streaming this device at this resolution: nothing to do.
      // Streaming a *different* one means the panel switched devices — tear the
      // old stream down first, or the canvas keeps painting the previous device
      // while taps are mapped against the new one. A changed `maxSide` (the
      // user moved the resolution switcher) also has to restart: the size is
      // negotiated in the stream's opening request and cannot be renegotiated
      // in place, so without this the new pick would be silently ignored.
      if (streamIdRef.current) {
        if (serialRef.current === serial && maxSideRef.current === maxSide) return;
        await cleanup();
      }
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeRef.current = true;
      serialRef.current = serial;
      maxSideRef.current = maxSide;
      // A stale timestamp from a previous stream must not trip this one's
      // watchdog before its first frame lands.
      lastFrameAtRef.current = 0;
      // Each stream restarts the emulator's frame counter at 0, so a carried
      // -over high-water mark would reject every frame of the new stream.
      pngSeqRef.current = -1;
      setState({ phase: 'starting', message: 'Starting screen stream…' });
      const channel = new Channel<ScrcpyStreamEvent>();
      channel.onmessage = (event) => {
        // Events from a stream that was superseded mid-start must not paint.
        if (generation !== generationRef.current || !activeRef.current) return;
        const ev = event as ScrcpyStreamEvent;
        if (ev.kind === 'status') {
          setState({ phase: 'starting', message: ev.message });
        } else if (ev.kind === 'ready') {
          // Handshake completed — the device answered, so it was alive at the
          // moment the stream opened. Keep starting phase until the first frame paints
          // to avoid flickering a blank canvas over the placeholder frame.
          lastFrameAtRef.current = Date.now();
          const dims = ev.width && ev.height ? { width: ev.width, height: ev.height } : lastKnownStreamDims ?? undefined;
          if (dims) lastKnownStreamDims = dims;
          setState((s) => ({
            ...s,
            message: 'Stream connected, decoding first frame…',
            dims: dims ?? s.dims,
          }));
        } else if (ev.kind === 'frame') {
          handleFrame(ev);
        } else if (ev.kind === 'png_frame') {
          // Emulator (host-side gRPC) path. Which kind arrives is the
          // backend's choice, not ours — it sends PNG when the device is an
          // emulator with a reachable gRPC endpoint and H.264 otherwise.
          handlePngFrame(ev);
        } else if (ev.kind === 'error') {
          setState({ phase: 'error', message: ev.message });
          void cleanup();
        }
      };
      try {
        const id = await invoke<string>('mobile_stream_start', { serial, onFrame: channel, maxSide });
        if (generation !== generationRef.current) {
          // Superseded while the invoke was in flight: the backend registered
          // a stream we no longer want — stop it so no thread is orphaned.
          if (id) {
            try {
              await invoke('mobile_stream_stop', { streamId: id });
            } catch {
              // Already gone.
            }
          }
          return;
        }
        streamIdRef.current = id;
      } catch (e) {
        if (generation !== generationRef.current) return;
        activeRef.current = false;
        setState({ phase: 'error', message: String(e) });
      }
    },
    [cleanup, handleFrame, handlePngFrame],
  );

  const stop = useCallback(() => {
    void cleanup();
    setState({ phase: 'idle' });
  }, [cleanup]);

  // Frame-recency watchdog. Runs while the stream is live; a device that stops
  // answering frames trips it, but silence alone never declares the stream
  // dead — adb is asked first, so an idle screen (which legitimately sends no
  // frames) keeps streaming while a vanished device falls back to snapshots.
  useEffect(() => {
    if (state.phase !== 'streaming') return;
    const id = window.setInterval(() => {
      if (!activeRef.current || probeInFlightRef.current) return;
      if (Date.now() - lastFrameAtRef.current < STALE_FRAME_MS) return;
      // Generation-guarded like the rest of the hook: a probe that resolves
      // after the stream was stopped or replaced must not kill its successor.
      const probeGeneration = generationRef.current;
      probeInFlightRef.current = true;
      void invoke<AdbDevice[]>('android_list_devices')
        .then((list) => {
          if (probeGeneration !== generationRef.current || !activeRef.current) return;
          const serial = serialRef.current;
          if (serial && list.some((d) => d.serial === serial && d.state === 'device')) {
            // Device still attached — the screen is just static and the
            // encoder is quiet. Re-arm the timer rather than drop the stream.
            lastFrameAtRef.current = Date.now();
          } else {
            setState({ phase: 'error', message: 'The device disconnected, so it is falling back to snapshots.' });
            void cleanup();
          }
        })
        .catch(() => {
          if (probeGeneration !== generationRef.current || !activeRef.current) return;
          setState({ phase: 'error', message: 'Lost contact with adb, so it is falling back to snapshots.' });
          void cleanup();
        })
        .finally(() => {
          probeInFlightRef.current = false;
        });
    }, WATCHDOG_TICK_MS);
    return () => window.clearInterval(id);
  }, [state.phase, cleanup]);

  // If the consumer unmounts mid-stream, tear everything down.
  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, [cleanup]);

  return { canvasRef, state, start, stop, supported };
}
