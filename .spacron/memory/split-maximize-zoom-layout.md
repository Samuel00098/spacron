# Split mode 100% Zoom / Maximize

## Overview
The old Focus mode icon in the prompt bar trailing controls has been removed. The shell operates primarily in Split mode (`ambientLayout === 'gallery'`), with on-demand 100% zoom/maximize for any open pane.

## Behavior
1. **Expanding a pane**:
   - Clicking the expand button (`⤢`) on any pane header sets `expandedRoom = id`.
   - The expanded pane fills 100% of the stage area (`inset: 0`) on top of all other cards.
   - Off-stage panes remain mounted in `.stage-hidden` (`visibility: hidden; pointer-events: none; clip-path: inset(50%)`), preserving all running xterm instances, scrollback buffers, and PTY processes without reflow or WebGL context recreation.
2. **Split Switcher visibility**:
   - The card selection bar below the stage (`renderSplitSwitcher()`) remains visible while a room is expanded.
   - Clicking the currently expanded room or clicking the restore button (`⤡`) on the pane header restores the multi-pane split grid.
   - Clicking any other card in the switcher switches the full-screen view directly to that card.
3. **Trailing Prompt Bar controls**:
   - The standalone `focus` icon is removed.
   - Trailing controls now cleanly contain:
     - `spawnAgentItem`: Spawn agent modal trigger
     - `split`: Toggles back to grid if expanded (`setExpandedRoom(null)`), or adds a pane to the split
     - `fleet`: Tiles all active agents
     - `ToolsMenu`: Launcher popover for rooms, workspace drawers, and utilities


## The Split button must switch the mode (regression fixed 2026-08-24)

`ambientLayout` still has two real values — `focus` (one room fills the stage)
and `gallery` (Split). Only `gallery` reads `splitSlots`; Focus renders
`[activeRoom]` and ignores the tiling entirely.

When the bottom room dock became the Tools menu (511762f) the dock's Focus
toggle went away and the Split button lost its mode switch — it kept only
`addNextRoomToSplit()`, which edits `splitSlots`. So in Focus mode, pressing
Split re-tiled a stage nobody was looking at and **the screen did not move**.
Nothing else in the UI entered `gallery` either; the only survivors were
`Ctrl+Alt+A` (`cycleAmbientLayout`), a Fleet tile, and workspace restore — and
restore defaults to `'focus'`, so a project with no saved arrangement came up in
a mode whose Split button was inert. The button now has three branches:
expanded → restore grid; not in Split → `switchAmbientLayout('gallery')`;
in Split → add a pane.

## Invariants around `expandedRoom`

- **Every** zoom/restore goes through `setStageExpansion`, which wraps
  `withStageRetile` so `pane-resize-end` fires. Bare `setExpandedRoom` left the
  refit to each xterm's debounced ResizeObserver, and that fit re-renders from a
  stale glyph atlas (see `onResizeEnd` in TerminalPane) — the pane came back
  from full stage still painting the size it used to be. See
  [[terminal-cell-measure-stuck]] and [[terminal-fit-host-padding]].
- A mode change clears the zoom (`switchAmbientLayout`), so returning to Split
  lands on the grid rather than full-screen on a pane.
  `restoreRoomArrangement` therefore applies a project's saved zoom **after**
  its `switchAmbientLayout` call, never before.
- `focusRoom` carries the zoom to whatever took focus. The stage shows exactly
  one room while zoomed, so without this a focus (a spawning agent, an
  orchestrator `focus` command, a switcher pill) changed nothing visible.
- `addRoomToSplit` clears the zoom — "show this too" means two panes.
- `stageExpandedRoom` is the single derived read (`expandedRoom` still on
  stage); four render paths were each spelling that test out by hand.

## `expandedRoom` is no longer the only thing that fills the stage (2026-09-04)

Tasks and Sketch are **full-stage-only** rooms: being the active room *is* being
expanded for them. That fact is derived in `fullscreenRooms.ts`
(`resolveStageExpansion`), never stored — writing it into `expandedRoom` was the
tempting version and it is wrong, because every path that legitimately clears the
zoom (`switchAmbientLayout`, `addRoomToSplit`, the restore button) would then
drop a canvas or a board into a third of a grid, where it renders fine and is
unusable. Deriving it means none of those paths need an exception.

So `stageExpandedRoom` now has two sources, and the difference matters wherever
an expansion can be **left**:

- `zoomedRoom` — the user's own zoom. Dismissable, and `focusRoom` carries it
  onto whatever takes focus next. That carry must read `zoomedRoom`, not
  `stageExpandedRoom`: carrying a *forced* expansion would silently zoom the
  terminal when you left Sketch for it.
- `forcedFullscreenRoom` — Tasks/Sketch. Not dismissable, not carried. The pane
  header hides its zoom control entirely (a restore that restores nothing reads
  as broken), and the way out is focusing another room, minimizing, or closing.

The trap this creates is the one the section above is already about: anything
that "un-expands" by calling `setStageExpansion(null)` is a **no-op** against a
forced room, so the screen does not move. The prompt-bar Split button therefore
tests `forcedFullscreenRoom` *first* and leaves by focusing a room that tiles.
Any new "back to the grid" affordance needs the same fourth branch.

These rooms also never enter `splitSlots` — `claimSplitSlot` refuses them and
`splitRooms` filters them out of every slot but the active one, so they cannot
be tiled behind whatever is active, and cannot evict a real pane at the cap.
