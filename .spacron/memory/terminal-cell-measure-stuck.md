# Terminal stuck at 80x24 — a zero-sized open() poisons xterm's cell measurement

## Symptom

Some panes render the shell prompt **clipped at the pane's right edge instead of
wrapping** — the tail of the line is simply gone, no second row. Other panes in
the very same split, at the same width, wrap correctly. The correct ones are
always the most recently created; the broken ones were created earlier.

This is NOT the sub-pixel shear described in [[terminal-fit-host-padding]].
Clipped-instead-of-wrapped means xterm's **grid is wider than its visible box**
(~80 columns in a ~59-column pane), not one column over.

## Root cause

xterm measures the character cell exactly **once**, off the element `term.open()`
was called into, and nothing in xterm ever re-runs that measurement.

`waitForOpenDimensions(fitHost)` gives up after a 250 ms timeout and opens
anyway. A pane that mounts behind a layout transition — a fresh split, a room
still animating in, a project layer being revealed — is therefore opened while
its host is still 0x0. A zero-sized element measures a **zero-wide cell**, and
`FitAddon.proposeDimensions()` returns `undefined` for any zero cell.

From then on the pane is permanently wedged: every later `doFit()` (including the
ones the ResizeObserver correctly fires once the pane *does* have size) bails at
the `cols < MIN_COLS` guard, so `term.resize()` is never called and the grid
stays at xterm's **80x24 default**. The PTY is sized to match, so the shell emits
lines wider than the pane can display and they are sheared by `overflow: hidden`.

## Fix

`measuredCell()` in `TerminalPane.tsx`: when the cached
`_renderService.dimensions.css.cell` is missing or zero, call
`_core._charSizeService.measure()` to re-measure against the now-real host, then
re-read. `clampedProposal()` uses it both to un-stick the addon and — when the
addon still declines to propose — to derive cols/rows directly from
`host.clientWidth / cell.width` rather than bailing.

Also restored in the same pass: the 350 ms "settled" re-fit had **lost** its
`MIN_COLS`/`MIN_ROWS` validity guard. With it gone, a pane hidden at that instant
proposed `{0,0}` and `term.resize(0,0)` ran — xterm silently clamps that to its
2x1 minimum and reports it through `onResize`, shrinking the **PTY to two
columns** and scrambling everything the shell drew after. That is a likely source
of past "text in random places" reports.

## Correction to a neighbouring note

[[terminal-fit-host-padding]] attributes the original clipping to FitAddon not
subtracting `.xterm-container`'s padding. Treat that as unconfirmed:
`getComputedStyle(el).width` returns the **content-box** width in Chromium, so
the container's `6/6/8px` padding was already excluded before the
`.xterm-fit-host` indirection was added. The host is harmless and worth keeping
(it makes the measured box unambiguous), but it was not the cure — this note is.

`node_modules/` is unreadable under the default permission settings, so the
addon-fit source could not be re-verified directly; verify before relying on
either account.

## Related notes

- [[terminal-fit-host-padding]] — the `.xterm-fit-host` indirection and the
  fractional-DPR overshoot clamp.
