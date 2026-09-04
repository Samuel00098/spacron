/**
 * The rule that Tasks and Sketch only ever appear full-stage.
 *
 * Lives outside `AppShell.tsx` purely so it can be tested: the component is a
 * 3k-line shell with no test harness, and this rule is the kind that breaks
 * silently — a room quietly tiled at a third of the stage still renders, it is
 * just unusable, so nothing fails loudly when a later change lets one through.
 *
 * Deliberately typed on a bare string rather than AppShell's `RoomId`. Importing
 * that type back out of the component would be a circular import, and this
 * module has no need to know the full room vocabulary — only which ids are in
 * the set.
 */

/**
 * Rooms that only ever show full-stage — never as a tile in a Split grid.
 *
 * Tasks is a board and Sketch is a canvas: both are whole surfaces the user
 * works *in* rather than glances at beside a terminal, and at a third of the
 * stage neither is usable. So rather than asking the user to zoom them by hand
 * every time, being the active room IS being expanded for these two.
 */
export const FULLSCREEN_ROOM_IDS: ReadonlySet<string> = new Set(['tasks', 'sketch']);

export function isFullscreenRoom(id: string): boolean {
  return FULLSCREEN_ROOM_IDS.has(id);
}

/**
 * Which room fills the stage, and whether that is the user's doing.
 *
 * The two cases have to stay distinguishable, because they behave differently
 * on the way out. A `zoom` is dismissable (the restore button, the switcher's
 * primary pill) and is carried onto whatever takes focus next. A `forced`
 * full-stage room is neither: leaving it means focusing another room, and the
 * stage should then land on that room's normal tiling rather than inherit a
 * full-stage zoom the user never asked for.
 *
 * Crucially the forced case is *derived* here, never stored in `expandedRoom`.
 * Every existing path that clears the zoom (`switchAmbientLayout`,
 * `addRoomToSplit`, the restore button) would otherwise quietly drop Tasks or
 * Sketch into a grid it cannot be read in; deriving it means none of those paths
 * need an exception.
 */
export function resolveStageExpansion(
  activeRoom: string | null,
  zoomedRoom: string | null,
): { room: string | null; forced: boolean } {
  if (activeRoom !== null && isFullscreenRoom(activeRoom)) {
    return { room: activeRoom, forced: true };
  }
  return { room: zoomedRoom, forced: false };
}
