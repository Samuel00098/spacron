/**
 * Desktop gestures for the Android mirror.
 *
 * A pointer drag is already a finger on the device, which covers tapping,
 * dragging and flicking. What the pane had no answer for was the two inputs a
 * desktop user reaches for without thinking: the scroll wheel, and the sideways
 * swipe / side buttons that mean "back" everywhere else on their machine.
 *
 * Everything here is pure — it turns raw wheel and button events into an
 * *intent*, and the panel decides how to deliver it (control-channel touches
 * while streaming, an adb swipe while polling). Keeping the recognition
 * separate is what makes the fiddly parts — axis locking, the one-navigation-
 * per-swipe latch, momentum tails — testable without a device.
 */

/** Android keycodes the navigation gestures press. */
export const KEYCODE_HOME = 3;
export const KEYCODE_BACK = 4;
export const KEYCODE_FORWARD = 125;

/**
 * How much horizontal travel (in normalized CSS px) counts as a navigation
 * swipe. One shift+wheel notch is ~100px, so a single notch navigates; stray
 * sideways drift inside a vertical trackpad scroll never gets close.
 */
export const NAV_THRESHOLD = 90;

/**
 * Idle gap that ends a wheel "burst". Trackpad momentum keeps emitting events
 * for up to a second after the fingers lift, and every one of those is part of
 * the same physical swipe — the gap has to be short enough to separate two
 * deliberate swipes and long enough not to split one.
 */
export const BURST_GAP_MS = 180;

/** Keep the scrolling finger this far inside the frame edges. */
export const SCROLL_EDGE_MARGIN = 8;

/** `deltaMode` units, as CSS pixels. */
const LINE_PX = 16;
const PAGE_PX = 400;

export interface Dims {
  width: number;
  height: number;
}

/** Drag the device's content by `dy` CSS pixels (positive = wheel down). */
export interface ScrollIntent {
  kind: 'scroll';
  dy: number;
}

/** Press a hardware/navigation key. `label` is for status text only. */
export interface KeyIntent {
  kind: 'key';
  keycode: number;
  label: string;
}

export type GestureIntent = ScrollIntent | KeyIntent;

/** The parts of a `WheelEvent` the recognizer reads. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/**
 * Wheel deltas as CSS pixels, with shift folded into the horizontal axis.
 *
 * `deltaMode` is not decoration: Firefox and some Windows mice report lines or
 * pages, and treating "3" (three lines) as three pixels makes the wheel look
 * broken rather than slow. Shift+wheel is the mouse-only way to swipe sideways,
 * and only counts when the device isn't already reporting a horizontal axis.
 */
export function normalizeWheel(e: WheelLike): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.shiftKey && dx === 0) return { dx: dy, dy: 0 };
  return { dx, dy };
}

/**
 * Which navigation a horizontal swipe means.
 *
 * Negative `dx` is the content moving right — two fingers swiped right — which
 * is "back" in every browser on every platform. The mirrored case is forward.
 */
export function navIntentFor(dx: number): KeyIntent {
  return dx > 0
    ? { kind: 'key', keycode: KEYCODE_FORWARD, label: 'Forward' }
    : { kind: 'key', keycode: KEYCODE_BACK, label: 'Back' };
}

/**
 * Mouse buttons that mean something on a phone, following scrcpy's mapping so
 * anyone who has mirrored a device before already knows them. `button` is the
 * pointer-event numbering: 1 middle, 2 right, 3/4 the side buttons.
 */
export function mouseButtonIntent(button: number): KeyIntent | null {
  switch (button) {
    case 1:
      return { kind: 'key', keycode: KEYCODE_HOME, label: 'Home' };
    case 2:
    case 3:
      return { kind: 'key', keycode: KEYCODE_BACK, label: 'Back' };
    case 4:
      return navIntentFor(1);
    default:
      return null;
  }
}

export interface WheelGestures {
  /** Classify one wheel event. `now` is a monotonic timestamp in ms. */
  handle(e: WheelLike, now: number): GestureIntent | null;
  /** Forget the current burst — call when the pointer takes over. */
  reset(): void;
}

/**
 * Turn a stream of wheel events into scroll and navigation intents.
 *
 * Two pieces of state carry the whole design:
 *
 * - **Axis lock.** A trackpad reports both axes at once, so a vertical scroll
 *   with a few pixels of sideways drift would eventually accumulate its way
 *   into a navigation. The first event of a burst picks the axis and the rest
 *   of the burst is stuck with it.
 * - **The nav latch.** One swipe must navigate once. Momentum keeps events
 *   flowing long after the fingers lift, so after firing, the burst is spent —
 *   only a real pause re-arms it.
 */
export function createWheelGestures(options: { navThreshold?: number; burstGapMs?: number } = {}): WheelGestures {
  const navThreshold = options.navThreshold ?? NAV_THRESHOLD;
  const burstGapMs = options.burstGapMs ?? BURST_GAP_MS;

  let lastAt = Number.NEGATIVE_INFINITY;
  let axis: 'x' | 'y' | null = null;
  let navAccum = 0;
  let navLatched = false;

  const reset = () => {
    axis = null;
    navAccum = 0;
    navLatched = false;
    lastAt = Number.NEGATIVE_INFINITY;
  };

  return {
    reset,
    handle(e, now) {
      if (now - lastAt > burstGapMs) {
        axis = null;
        navAccum = 0;
        navLatched = false;
      }
      lastAt = now;

      const { dx, dy } = normalizeWheel(e);
      if (axis === null) {
        if (dx === 0 && dy === 0) return null;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }

      if (axis === 'y') return dy === 0 ? null : { kind: 'scroll', dy };

      if (navLatched) return null;
      navAccum += dx;
      if (Math.abs(navAccum) < navThreshold) return null;
      navLatched = true;
      return navIntentFor(navAccum);
    },
  };
}

/**
 * Walk the scrolling finger by a device-space delta, kept inside the frame.
 *
 * `exhausted` means the clamp ate the movement — the finger has reached the
 * edge of the screen and the caller should lift it and press again rather than
 * keep sending moves that no longer travel anywhere.
 */
export function advanceScroll(
  from: { x: number; y: number },
  dx: number,
  dy: number,
  dims: Dims,
): { x: number; y: number; exhausted: boolean } {
  // On a tiny frame the two margins can overlap; collapsing them to the middle
  // keeps the clamp well-ordered instead of producing min > max.
  const margin = Math.min(SCROLL_EDGE_MARGIN, Math.floor((Math.min(dims.width, dims.height) - 1) / 2));
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(max - 1 - margin, value));
  const x = Math.round(clamp(from.x + dx, dims.width));
  const y = Math.round(clamp(from.y + dy, dims.height));
  const exhausted = (dx !== 0 && x === from.x) || (dy !== 0 && y === from.y);
  return { x, y, exhausted };
}

/** Where a scroll starts when the pointer position isn't usable — the middle. */
export function scrollAnchor(dims: Dims) {
  return { x: Math.round(dims.width / 2), y: Math.round(dims.height / 2) };
}
