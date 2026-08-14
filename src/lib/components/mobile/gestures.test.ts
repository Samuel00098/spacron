import { describe, expect, it } from 'vitest';

import {
  advanceScroll,
  BURST_GAP_MS,
  createWheelGestures,
  KEYCODE_BACK,
  KEYCODE_FORWARD,
  KEYCODE_HOME,
  mouseButtonIntent,
  navIntentFor,
  NAV_THRESHOLD,
  normalizeWheel,
  scrollAnchor,
} from './gestures';

function wheel(partial: Partial<Parameters<typeof normalizeWheel>[0]>) {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ...partial };
}

describe('normalizeWheel', () => {
  it('scales line and page deltas to pixels', () => {
    // Firefox reports lines; treating 3 lines as 3px is what makes the wheel
    // look broken rather than slow.
    expect(normalizeWheel(wheel({ deltaY: 3, deltaMode: 1 })).dy).toBe(48);
    expect(normalizeWheel(wheel({ deltaY: 1, deltaMode: 2 })).dy).toBe(400);
    expect(normalizeWheel(wheel({ deltaY: 100 })).dy).toBe(100);
  });

  it('folds shift+wheel into the horizontal axis', () => {
    expect(normalizeWheel(wheel({ deltaY: 100, shiftKey: true }))).toEqual({ dx: 100, dy: 0 });
  });

  it('leaves a real horizontal delta alone even with shift held', () => {
    // A tilt wheel already reports deltaX; re-mapping deltaY on top would
    // double-count the same physical gesture.
    expect(normalizeWheel(wheel({ deltaX: -40, deltaY: 10, shiftKey: true }))).toEqual({ dx: -40, dy: 10 });
  });
});

describe('navIntentFor', () => {
  it('maps a rightward two-finger swipe (negative dx) to Back', () => {
    expect(navIntentFor(-200)).toEqual({ kind: 'key', keycode: KEYCODE_BACK, label: 'Back' });
    expect(navIntentFor(200)).toEqual({ kind: 'key', keycode: KEYCODE_FORWARD, label: 'Forward' });
  });
});

describe('mouseButtonIntent', () => {
  it('follows scrcpy: right = Back, middle = Home, side buttons = Back/Forward', () => {
    expect(mouseButtonIntent(1)?.keycode).toBe(KEYCODE_HOME);
    expect(mouseButtonIntent(2)?.keycode).toBe(KEYCODE_BACK);
    expect(mouseButtonIntent(3)?.keycode).toBe(KEYCODE_BACK);
    expect(mouseButtonIntent(4)?.keycode).toBe(KEYCODE_FORWARD);
  });

  it('leaves the primary button to the touch path', () => {
    expect(mouseButtonIntent(0)).toBeNull();
  });
});

describe('createWheelGestures', () => {
  it('turns vertical wheel events into scroll intents', () => {
    const g = createWheelGestures();
    expect(g.handle(wheel({ deltaY: 120 }), 0)).toEqual({ kind: 'scroll', dy: 120 });
    expect(g.handle(wheel({ deltaY: -120 }), 16)).toEqual({ kind: 'scroll', dy: -120 });
  });

  it('navigates once a horizontal swipe passes the threshold', () => {
    const g = createWheelGestures();
    expect(g.handle(wheel({ deltaX: -40 }), 0)).toBeNull();
    expect(g.handle(wheel({ deltaX: -40 }), 16)).toBeNull();
    expect(g.handle(wheel({ deltaX: -40 }), 32)).toEqual({
      kind: 'key',
      keycode: KEYCODE_BACK,
      label: 'Back',
    });
  });

  it('navigates exactly once per swipe, however long the momentum tail runs', () => {
    // The real failure this guards: a trackpad keeps emitting for ~1s after
    // the fingers lift, so an unlatched recognizer fires Back four or five
    // times and the app ends up somewhere the user never asked to be.
    const g = createWheelGestures();
    let fired = 0;
    for (let t = 0; t < 1000; t += 16) {
      if (g.handle(wheel({ deltaX: -60 }), t)) fired++;
    }
    expect(fired).toBe(1);
  });

  it('re-arms after a pause between swipes', () => {
    const g = createWheelGestures();
    expect(g.handle(wheel({ deltaX: -NAV_THRESHOLD }), 0)?.kind).toBe('key');
    expect(g.handle(wheel({ deltaX: -NAV_THRESHOLD }), 50)).toBeNull();
    const after = g.handle(wheel({ deltaX: -NAV_THRESHOLD }), 50 + BURST_GAP_MS + 1);
    expect(after).toEqual({ kind: 'key', keycode: KEYCODE_BACK, label: 'Back' });
  });

  it('locks the axis, so sideways drift in a long scroll never navigates', () => {
    // A trackpad reports both axes at once; 60 events of 5px drift is 300px of
    // accumulated dx, well past the threshold, from a gesture the user
    // performed entirely vertically.
    const g = createWheelGestures();
    const intents = [];
    for (let t = 0; t < 60 * 16; t += 16) {
      const intent = g.handle(wheel({ deltaX: -5, deltaY: 40 }), t);
      if (intent) intents.push(intent);
    }
    expect(intents).toHaveLength(60);
    expect(intents.every((i) => i.kind === 'scroll')).toBe(true);
  });

  it('ignores an empty event without claiming an axis', () => {
    const g = createWheelGestures();
    expect(g.handle(wheel({}), 0)).toBeNull();
    // The burst has no axis yet, so the next real event still gets to pick one.
    expect(g.handle(wheel({ deltaX: -NAV_THRESHOLD }), 16)?.kind).toBe('key');
  });

  it('starts a fresh burst after reset', () => {
    const g = createWheelGestures();
    g.handle(wheel({ deltaY: 100 }), 0);
    g.reset();
    expect(g.handle(wheel({ deltaX: -NAV_THRESHOLD }), 16)?.kind).toBe('key');
  });
});

describe('advanceScroll', () => {
  const dims = { width: 720, height: 1600 };

  it('walks the finger by the delta', () => {
    expect(advanceScroll({ x: 360, y: 800 }, 0, -250, dims)).toEqual({ x: 360, y: 550, exhausted: false });
  });

  it('reports exhaustion when the clamp eats the movement', () => {
    const atEdge = advanceScroll({ x: 360, y: 8 }, 0, -250, dims);
    expect(atEdge).toEqual({ x: 360, y: 8, exhausted: true });
  });

  it('keeps the finger inside the frame margins', () => {
    const low = advanceScroll({ x: 360, y: 800 }, 0, -5000, dims);
    const high = advanceScroll({ x: 360, y: 800 }, 0, 5000, dims);
    expect(low.y).toBe(8);
    expect(high.y).toBe(1591);
  });

  it('survives a frame smaller than two margins', () => {
    // Degenerate, but a stream that reports 10x10 during a rotation must not
    // produce a clamp whose min exceeds its max.
    const tiny = advanceScroll({ x: 5, y: 5 }, 0, -100, { width: 10, height: 10 });
    expect(tiny.y).toBeGreaterThanOrEqual(0);
    expect(tiny.y).toBeLessThan(10);
  });
});

describe('scrollAnchor', () => {
  it('is the middle of the frame', () => {
    expect(scrollAnchor({ width: 720, height: 1600 })).toEqual({ x: 360, y: 800 });
  });
});
