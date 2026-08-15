import { describe, expect, it } from 'vitest';

import {
  desiredStreamLongSide,
  formatStreamSideChoice,
  MAX_REQUESTABLE_SIDE,
  MAX_STREAM_SIDE,
  MIN_REQUESTABLE_SIDE,
  MIN_STREAM_SIDE,
  parseStreamSideChoice,
  resolveStreamSide,
  STREAM_SIDE_CHOICES,
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
    // Past the ceiling the frame rate falls off a cliff (measured: 12.7 fps at
    // 1024 against 15.7 at 864) faster than the sharpness is worth.
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

/**
 * The switcher's job is to let someone override the automatic pick — including
 * *upward*, past the ceiling that exists to keep the automatic pick fast. These
 * pin that asymmetry, since getting it wrong would silently cap the one case
 * the control exists for.
 */
describe('resolveStreamSide', () => {
  it('follows the panel size on auto', () => {
    expect(resolveStreamSide('auto', 350, 900, 1)).toBe(desiredStreamLongSide(350, 900, 1));
  });

  it('honours an explicit pick regardless of the stage', () => {
    // The same 720 whether the stage is tiny or huge — that is the point of
    // taking manual control.
    expect(resolveStreamSide(720, 80, 100, 1)).toBe(720);
    expect(resolveStreamSide(720, 2000, 4000, 2)).toBe(720);
  });

  it('lets an explicit pick exceed the automatic ceiling', () => {
    // MAX_STREAM_SIDE bounds the *automatic* pick only. A user choosing 1440
    // has accepted the frame-rate cost and must actually get 1440.
    expect(1440).toBeGreaterThan(MAX_STREAM_SIDE);
    expect(resolveStreamSide(1440, 350, 900, 1)).toBe(1440);
  });

  it('clamps to what the backends accept', () => {
    // Both transports clamp to [240, 4096]; matching here keeps the number the
    // panel shows equal to the number the device is asked for.
    expect(resolveStreamSide(10, 350, 900, 1)).toBe(MIN_REQUESTABLE_SIDE);
    expect(resolveStreamSide(99_999, 350, 900, 1)).toBe(MAX_REQUESTABLE_SIDE);
  });

  it('falls back to auto for a nonsense number', () => {
    expect(resolveStreamSide(NaN, 350, 900, 1)).toBe(desiredStreamLongSide(350, 900, 1));
  });

  it('offers only rungs the backends will honour', () => {
    for (const { side } of STREAM_SIDE_CHOICES) {
      expect(resolveStreamSide(side, 350, 900, 1)).toBe(side);
    }
  });
});

describe('parseStreamSideChoice / formatStreamSideChoice', () => {
  it('round-trips every offered rung and auto', () => {
    expect(parseStreamSideChoice(formatStreamSideChoice('auto'))).toBe('auto');
    for (const { side } of STREAM_SIDE_CHOICES) {
      expect(parseStreamSideChoice(formatStreamSideChoice(side))).toBe(side);
    }
  });

  it('falls back to auto for anything unrecognised', () => {
    // A hand-edited localStorage value, or a rung dropped in a later build,
    // must not pin the stream to a number nothing offers any more.
    expect(parseStreamSideChoice(null)).toBe('auto');
    expect(parseStreamSideChoice('')).toBe('auto');
    expect(parseStreamSideChoice('banana')).toBe('auto');
    expect(parseStreamSideChoice('-720')).toBe('auto');
    expect(parseStreamSideChoice('0')).toBe('auto');
  });

  it('clamps an out-of-range stored value instead of trusting it', () => {
    expect(parseStreamSideChoice('99999')).toBe(MAX_REQUESTABLE_SIDE);
    expect(parseStreamSideChoice('12')).toBe(MIN_REQUESTABLE_SIDE);
  });
});
