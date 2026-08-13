import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { base64ToBytes } from '$lib/services/scrcpy';
import type { StreamState } from './useScrcpyStream';

/** One message from the backend's `ios_sim_stream_start` channel. */
interface MjpegStreamEvent {
  kind: 'status' | 'ready' | 'frame' | 'error';
  message?: string;
  width?: number;
  height?: number;
  data?: string;
}

/**
 * Consumes the serve-sim MJPEG stream the backend pumps (see
 * `src-tauri/src/commands/ios_sim.rs`) and paints each frame onto the
 * returned `<canvas>` via `createImageBitmap`.
 *
 * Frames arrive faster than `createImageBitmap` decodes, so a latest-wins
 * queue drops intermediate frames instead of piling up bitmaps — the canvas
 * always shows the freshest image, which is exactly right for a live mirror.
 */
export function useMjpegStream() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<StreamState>({ phase: 'idle' });
  const streamIdRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const decodingRef = useRef(false);

  const draw = useCallback(
    (data: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      pendingRef.current = data;
      if (decodingRef.current) return; // a decode is in flight; latest wins
      decodingRef.current = true;
      void (async () => {
        while (pendingRef.current) {
          const payload = pendingRef.current;
          pendingRef.current = null;
          try {
            const bytes = base64ToBytes(payload);
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            if (bitmap.width > 0 && bitmap.height > 0) {
              if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                setState((s) => ({
                  ...s,
                  phase: 'streaming',
                  dims: { width: bitmap.width, height: bitmap.height },
                }));
              }
              const ctx = canvas.getContext('2d');
              if (ctx) ctx.drawImage(bitmap, 0, 0);
            }
            bitmap.close();
          } catch {
            // Skip a corrupt/truncated frame.
          }
        }
        decodingRef.current = false;
      })();
    },
    [setState],
  );

  const cleanup = useCallback(async () => {
    generationRef.current += 1;
    activeRef.current = false;
    const id = streamIdRef.current;
    streamIdRef.current = null;
    if (id) {
      try {
        await invoke('ios_sim_stream_stop', { streamId: id });
      } catch {
        // Already gone.
      }
    }
    pendingRef.current = null;
  }, []);

  const start = useCallback(
    async (udid: string) => {
      if (streamIdRef.current) return;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeRef.current = true;
      setState({ phase: 'starting', message: 'Starting simulator stream…' });
      const channel = new Channel<MjpegStreamEvent>();
      channel.onmessage = (event) => {
        // Events from a stream superseded mid-start must not paint.
        if (generation !== generationRef.current || !activeRef.current) return;
        const ev = event as MjpegStreamEvent;
        if (ev.kind === 'status') {
          setState({ phase: 'starting', message: ev.message });
        } else if (ev.kind === 'ready') {
          setState({
            phase: 'streaming',
            dims: ev.width && ev.height ? { width: ev.width, height: ev.height } : undefined,
          });
        } else if (ev.kind === 'frame' && ev.data) {
          draw(ev.data);
        } else if (ev.kind === 'error') {
          setState({ phase: 'error', message: ev.message });
          void cleanup();
        }
      };
      try {
        const id = await invoke<string>('ios_sim_stream_start', { udid, onFrame: channel });
        if (generation !== generationRef.current) {
          // Superseded while the invoke was in flight — stop the stream the
          // backend just registered so no reader thread is orphaned.
          if (id) {
            try {
              await invoke('ios_sim_stream_stop', { streamId: id });
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
    [cleanup, draw],
  );

  const stop = useCallback(() => {
    void cleanup();
    setState({ phase: 'idle' });
  }, [cleanup]);

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, [cleanup]);

  return { canvasRef, state, start, stop };
}
