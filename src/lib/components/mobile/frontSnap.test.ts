import { describe, expect, it } from 'vitest';
import { frontSnap } from './frontSnap';
describe('front snap', () => {
  it('accepts a useful front-facing range', () => {
    expect(frontSnap(15, -17)).toEqual({ x: 0, y: -0 });
    expect(frontSnap(19, 0)).toBeNull();
  });
  it('preserves the nearest revolution instead of spinning back to zero', () => {
    expect(frontSnap(3, 354)).toEqual({ x: 0, y: 360 });
    expect(frontSnap(-3, -365)).toEqual({ x: 0, y: -360 });
    expect(frontSnap(0, 1084)).toEqual({ x: 0, y: 1080 });
  });
  it('never snaps the back or side to the front', () => {
    expect(frontSnap(0, 180)).toBeNull();
    expect(frontSnap(0, 90)).toBeNull();
  });
  it('ignores invalid coordinates', () => {
    expect(frontSnap(NaN, 0)).toBeNull();
  });
});

it('allows a visible front screen to snap on pointer entry, but never the back', () => {
  expect(frontSnap(40, 65, 85)).toEqual({ x: 0, y: 0 });
  expect(frontSnap(0, 180, 85)).toBeNull();
  expect(frontSnap(20, 30, 35)).toEqual({ x: 0, y: 0 });
});
