/**
 * Hit-testing for file drops.
 *
 * Every drop surface — terminal panes, agent image trays, the prompt bar, the
 * chat composer — listens on a WINDOW-level stream: Tauri's `onDragDropEvent`
 * and the file explorer's `spacron-explorer-drag-*` pointer events are both
 * broadcast to every mounted listener, so each surface has to decide for itself
 * whether a drop was meant for it.
 *
 * Deciding that with a bare `getBoundingClientRect()` containment test is
 * wrong. Rooms that are merely hidden — `.stage-hidden` panes, parked project
 * layers, the CLI layer behind chat mode — stay mounted and laid out at full
 * stage size so their rect contains every point on the stage. A single dragged
 * file then lands in every open agent terminal at once.
 *
 * `document.elementsFromPoint` is the fix: hit testing skips `visibility:
 * hidden` and `pointer-events: none` subtrees, so only surfaces the user can
 * actually see and click at that point are candidates. The returned stack
 * includes elements *under* the topmost one, so an occluding overlay does not
 * by itself disqualify a target — callers that must not be stolen from (the
 * prompt bar over a pane) still check that explicitly.
 */
export function isPointOverDropTarget(
  el: Element | null | undefined,
  clientX: number | null | undefined,
  clientY: number | null | undefined,
): boolean {
  if (!el || typeof document === 'undefined') return false;
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return false;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return false;
  }

  // The rect says the point is inside this box; the hit test says whether that
  // box is the one on screen there. Hidden layers fail here — they are absent
  // from the stack entirely.
  const stack = document.elementsFromPoint(clientX, clientY);
  if (stack.length === 0) return false;
  return stack.some((hit) => hit === el || el.contains(hit));
}
