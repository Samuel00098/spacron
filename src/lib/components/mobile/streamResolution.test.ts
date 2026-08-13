import { describe, expect, it } from 'vitest';

import {
  desiredStreamLongSide,
  MAX_STREAM_SIDE,
  MIN_STREAM_SIDE,
} from './streamResolution';

/**
 * The reason this function exists is that a fixed 720 is soft on a HiDPI
 * display and wasteful in a narrow drawer. These cases pin both ends of that,
 * plus the degenerate inputs a real layout hands you before it has settled.
 */
describe('desiredStreamLongSide', () => {
  it('asks for roughly the CSS pixels a default-width drawer paints', () => {
    // Default drawer (380px) leaves ~350px for the device; a portrait phone is
    // width-limited there, so the long side comes from width x aspect.
    const side = desiredStreamLongSide(350, 900, 1);
    expect(side).toBe(770); // 350 * 2.2
    expect(side).toBeGreaterThan(MIN_STREAM_SIDE);
    expect(side).toBeLessThan(MAX_STREAM_SIDE);
  });

  it('doubles the request on a HiDPI display — the whole point of the change', () => {
    // Same panel as above on a Retina Mac: 2x the real pixels, so a 720-ish
    // request would be stretched ~2x and look soft.
    const standard = desiredStreamLongSide(350, 900, 1);
    const retina = desiredStreamLongSide(350, 900, 2);
    expect(retina).toBeGreaterThan(standard);
    expect(retina).toBe(MAX_STREAM_SIDE); // 770 * 2 clamps to the ceiling
  });

  it('is bounded by the stage height when the drawer is wide', () => {
    // A wide drawer makes the device height-limited instead: 2.2 * 690 is far
    // more than the stage can show, so asking for it would over-shoot badly.
    expect(desiredStreamLongSide(690, 800, 1)).toBe(800);
  });

  it('never exceeds the measured ceiling', () => {
    // Past 1024 the frame rate falls away faster than the sharpness is worth.
    expect(desiredStreamLongSide(2000, 4000, 2)).toBe(MAX_STREAM_SIDE);
  });

  it('never drops below the floor', () => {
    // A collapsed drawer must not request a postage stamp.
    expect(desiredStreamLongSide(80, 100, 1)).toBe(MIN_STREAM_SIDE);
  });

  it('caps DPR at 2 so a 3x display does not blow past the ceiling on cost', () => {
    expect(desiredStreamLongSide(300, 700, 3)).toBe(desiredStreamLongSide(300, 700, 2));
  });

  it('falls back to the floor for a stage that has not been laid out', () => {
    // getBoundingClientRect returns zeroes before layout settles; a stream
    // started in that window must get the floor, not NaN or 0.
    expect(desiredStreamLongSide(0, 0, 2)).toBe(MIN_STREAM_SIDE);
    expect(desiredStreamLongSide(NaN, 900, 2)).toBe(MIN_STREAM_SIDE);
    expect(desiredStreamLongSide(350, Infinity, 2)).toBe(MIN_STREAM_SIDE);
    // A nonsense DPR must not poison the result either.
    expect(desiredStreamLongSide(350, 900, 0)).toBe(770);
  });
});
