import { describe, it, expect, afterEach } from 'vitest';
import { isPointOverDropTarget } from './drop-target';

/**
 * The helper only touches `getBoundingClientRect`, `Element.contains` and
 * `document.elementsFromPoint`, so a handful of stand-ins model the real cases
 * exactly — and without jsdom, which does not implement `elementsFromPoint`.
 */
type Rect = { left: number; top: number; right: number; bottom: number };

function makeElement(rect: Rect, children: unknown[] = []): Element {
  const el = {
    getBoundingClientRect: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }),
    contains: (other: unknown) => other === el || children.includes(other),
  };
  return el as unknown as Element;
}

/** What the browser would report at the point — hidden layers are absent. */
function setHitStack(stack: unknown[]) {
  (globalThis as { document?: unknown }).document = {
    elementsFromPoint: () => stack,
  };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

const STAGE: Rect = { left: 0, top: 0, right: 1000, bottom: 800 };

describe('isPointOverDropTarget', () => {
  it('claims a drop over the pane that is actually on screen', () => {
    const pane = makeElement(STAGE);
    setHitStack([pane]);
    expect(isPointOverDropTarget(pane, 500, 400)).toBe(true);
  });

  it('claims a drop landing on a child of the target', () => {
    const row = {} as Element;
    const pane = makeElement(STAGE, [row]);
    setHitStack([row, pane]);
    expect(isPointOverDropTarget(pane, 500, 400)).toBe(true);
  });

  it('rejects a hidden room whose rect still covers the whole stage', () => {
    // The regression: `.stage-hidden` panes and parked project layers stay
    // mounted at full size, so a rect test let every one of them claim the same
    // drop and the dragged file landed in every open terminal.
    const visiblePane = makeElement(STAGE);
    const hiddenPane = makeElement(STAGE);
    setHitStack([visiblePane]);
    expect(isPointOverDropTarget(hiddenPane, 500, 400)).toBe(false);
    expect(isPointOverDropTarget(visiblePane, 500, 400)).toBe(true);
  });

  it('rejects a point outside the target rect', () => {
    const pane = makeElement({ left: 0, top: 0, right: 400, bottom: 800 });
    setHitStack([pane]);
    expect(isPointOverDropTarget(pane, 600, 400)).toBe(false);
  });

  it('rejects a zero-sized target', () => {
    const collapsed = makeElement({ left: 0, top: 0, right: 0, bottom: 0 });
    setHitStack([collapsed]);
    expect(isPointOverDropTarget(collapsed, 0, 0)).toBe(false);
  });

  it('rejects missing elements and non-numeric coordinates', () => {
    const pane = makeElement(STAGE);
    setHitStack([pane]);
    expect(isPointOverDropTarget(null, 500, 400)).toBe(false);
    expect(isPointOverDropTarget(pane, undefined, 400)).toBe(false);
    expect(isPointOverDropTarget(pane, 500, Number.NaN)).toBe(false);
  });

  it('rejects everything when nothing is hit-testable at the point', () => {
    const pane = makeElement(STAGE);
    setHitStack([]);
    expect(isPointOverDropTarget(pane, 500, 400)).toBe(false);
  });
});
