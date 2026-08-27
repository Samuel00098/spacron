import { describe, expect, it } from 'vitest';
import { createAltTapGesture, KEY_LOCATION_LEFT, type AltTapEvent } from './alt-tap-gesture';

const LEFT = KEY_LOCATION_LEFT;
const RIGHT = 2;

function ev(key: string, extra: Partial<AltTapEvent> = {}): AltTapEvent {
  return { key, location: key === 'Alt' ? LEFT : 0, ...extra };
}

describe('alt-tap gesture', () => {
  it('completes on a bare left-Alt press and release', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt'));
    expect(g.keyup(ev('Alt'))).toBe(true);
  });

  /**
   * The regression, end to end: Ctrl+Alt+M must transcribe, not open voice mode.
   *
   * Two rules independently save this one — Alt arrives with Ctrl already
   * held, and the later `m` cancels the tap regardless — which is why the
   * narrower cases below and in 'recovers for the next tap' exist to pin each
   * rule on its own. What no rule can substitute for is completing on keyup:
   * on the Alt keydown alone there is nothing yet to distinguish this from a
   * bare tap.
   */
  it('does not fire for Ctrl+Alt+M pressed in the usual order', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Control'));
    g.keydown(ev('Alt', { ctrlKey: true }));
    g.keydown(ev('m', { ctrlKey: true, altKey: true } as Partial<AltTapEvent>));
    expect(g.keyup(ev('Alt', { ctrlKey: true }))).toBe(false);
  });

  /**
   * The non-obvious half: here the Alt keydown IS bare, so a modifier check at
   * keydown alone would have armed the gesture. The later `m` has to cancel it.
   */
  it('does not fire when Alt is held first and the chord completes after', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt'));
    g.keydown(ev('Control', { altKey: true } as Partial<AltTapEvent>));
    g.keydown(ev('m', { ctrlKey: true, altKey: true } as Partial<AltTapEvent>));
    expect(g.keyup(ev('Alt'))).toBe(false);
  });

  it('does not fire for Alt+Tab', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt'));
    g.keydown(ev('Tab', { altKey: true } as Partial<AltTapEvent>));
    expect(g.keyup(ev('Alt'))).toBe(false);
  });

  it('does not fire for a plain Alt+letter chord', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt'));
    g.keydown(ev('m', { altKey: true } as Partial<AltTapEvent>));
    expect(g.keyup(ev('Alt'))).toBe(false);
  });

  it('ignores right Alt (AltGr) entirely', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt', { location: RIGHT }));
    expect(g.keyup(ev('Alt', { location: RIGHT }))).toBe(false);
  });

  it('ignores an auto-repeating held Alt', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt', { repeat: true }));
    expect(g.keyup(ev('Alt'))).toBe(false);
  });

  it('only reports the tap once', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt'));
    expect(g.keyup(ev('Alt'))).toBe(true);
    expect(g.keyup(ev('Alt'))).toBe(false);
  });

  it('ignores a keyup for some other key', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt'));
    expect(g.keyup(ev('m'))).toBe(false);
    // ...and the pending tap survives it, since `m` never went down.
    expect(g.keyup(ev('Alt'))).toBe(true);
  });

  it('forgets a pending tap on reset', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Alt'));
    g.reset();
    expect(g.keyup(ev('Alt'))).toBe(false);
  });

  it('recovers for the next tap after a cancelled chord', () => {
    const g = createAltTapGesture();
    g.keydown(ev('Control'));
    g.keydown(ev('Alt', { ctrlKey: true }));
    expect(g.keyup(ev('Alt', { ctrlKey: true }))).toBe(false);

    g.keydown(ev('Alt'));
    expect(g.keyup(ev('Alt'))).toBe(true);
  });
});
