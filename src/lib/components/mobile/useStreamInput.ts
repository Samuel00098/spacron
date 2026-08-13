import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * Input injection over the live stream's scrcpy control channel.
 *
 * The adb path (`android_tap` and friends) spawns a host process *and* boots an
 * ART VM on the device for every event — measured at 600–1300 ms per tap on a
 * local emulator, which is why the mirror feels like it is ignoring you. The
 * scrcpy server we already run for video accepts a second socket carrying
 * binary control messages; injecting through it is a socket write into a
 * running process, so a tap lands in single-digit milliseconds.
 *
 * Every call resolves to `false` when there is no control channel (snapshot
 * mode, a server that refused the socket, an older device) — the panel then
 * falls back to the adb commands, which still work, just slowly.
 */

/** `AMOTION_EVENT_ACTION_*`, as the backend expects them. */
export const TOUCH_DOWN = 0;
export const TOUCH_UP = 1;
export const TOUCH_MOVE = 2;
export const TOUCH_CANCEL = 3;

export interface FrameDims {
  width: number;
  height: number;
}

/** Send a key press (down + up). Resolves false if there is no control channel. */
export async function sendStreamKey(serial: string, keycode: number): Promise<boolean> {
  return invoke<boolean>('mobile_input_key', { serial, keycode });
}

/** Type text into the focused field. Resolves false if there is no control channel. */
export async function sendStreamText(serial: string, text: string): Promise<boolean> {
  return invoke<boolean>('mobile_input_text', { serial, text });
}

/**
 * Touch injection with ordering guaranteed and moves coalesced.
 *
 * Ordering: the IPC gives no cross-call ordering guarantee, and a MOVE that
 * overtook its DOWN would be dropped by the device as a stray pointer, so every
 * event is chained onto the previous one's promise.
 *
 * Coalescing: a drag produces pointer events faster than the chain drains, and
 * a queue of stale positions would make the finger lag behind the cursor. Only
 * the newest MOVE is ever queued — intermediate ones are discarded, which is
 * what a touchscreen does anyway when it batches samples.
 */
export function useStreamTouch() {
  const chainRef = useRef<Promise<boolean>>(Promise.resolve(false));
  const pendingMoveRef = useRef<{ x: number; y: number; dims: FrameDims } | null>(null);
  const moveQueuedRef = useRef(false);

  const enqueue = useCallback((work: () => Promise<boolean>) => {
    const next = chainRef.current.then(work, work);
    chainRef.current = next.catch(() => false);
    return next;
  }, []);

  const send = useCallback(
    (serial: string, action: number, x: number, y: number, dims: FrameDims) =>
      invoke<boolean>('mobile_input_touch', {
        serial,
        action,
        x,
        y,
        width: dims.width,
        height: dims.height,
      }),
    [],
  );

  /** Press down. `false` means no control channel — use the adb fallback. */
  const down = useCallback(
    (serial: string, x: number, y: number, dims: FrameDims) =>
      enqueue(() => send(serial, TOUCH_DOWN, x, y, dims)),
    [enqueue, send],
  );

  /** Drag. Fire-and-forget: the caller already knows the gesture is live. */
  const move = useCallback(
    (serial: string, x: number, y: number, dims: FrameDims) => {
      pendingMoveRef.current = { x, y, dims };
      if (moveQueuedRef.current) return;
      moveQueuedRef.current = true;
      // Swallowed on purpose: a dropped intermediate MOVE is invisible, and the
      // UP that ends the gesture reports any real failure to the caller.
      void enqueue(() => {
        const pending = pendingMoveRef.current;
        pendingMoveRef.current = null;
        moveQueuedRef.current = false;
        if (!pending) return Promise.resolve(true);
        return send(serial, TOUCH_MOVE, pending.x, pending.y, pending.dims);
      }).catch(() => false);
    },
    [enqueue, send],
  );

  /** Lift (or cancel). Resolves false if the gesture never reached the device. */
  const up = useCallback(
    (serial: string, x: number, y: number, dims: FrameDims, cancelled = false) => {
      // Drop a queued MOVE: its position is already superseded by this lift,
      // and sending it after the UP would leave a stray pointer down.
      pendingMoveRef.current = null;
      return enqueue(() => send(serial, cancelled ? TOUCH_CANCEL : TOUCH_UP, x, y, dims));
    },
    [enqueue, send],
  );

  return { down, move, up };
}
