# Terminal fit host — why letters were cut off at pane edges

## Symptom

Terminal text clipped at the right/bottom edge of a pane — letters sliced
mid-glyph, unlike native terminals (Windows Terminal, iTerm) which always
fit exactly.

## Root cause

FitAddon (verified against `@xterm/addon-fit` 0.10 source in node_modules)
measures the element `term.open()` was called into as follows:

- takes the **parent element's** computed width/height
- subtracts only **that parent's own** padding (plus scrollbar)

It never subtracts anyone else's padding. Our `.xterm-container`
(TerminalPane.css) is `box-sizing: border-box` with `padding: 6px 6px 8px 6px`
and `overflow: hidden`. xterm was opened directly into it, so fit believed
there was ~12px more width and ~14px more height than actually existed inside
the padded box → one phantom column + row → sheared off by overflow:hidden.

## Fix

A dedicated zero-padding `.xterm-fit-host` div inside the container;
xterm opens into the host, FitAddon measures the container as its parent but
the host has no padding of its own, so the measured box IS the usable area.
ResizeObserver and waitForOpenDimensions also target the host.

A second, independent overshoot path is closed by `clampedProposal()` in
TerminalPane.tsx: FitAddon floors cols/rows but cell size is device pixels
divided back down by DPR — on fractional-DPR WebViews the CSS cell can round
UP past the host edge, shearing the last column/row AND desyncing the PTY's
wrap columns from the visible grid (text "in random places"). doFit now
pixel-proves the proposal (cols*cellW / rows*cellH vs host.clientWidth/
clientHeight) and walks cols/rows back before resizing. Renderer-agnostic:
runs before any renderer draws, so DOM/canvas/WebGL all inherit it.

Files: `src/lib/components/terminal/TerminalPane.tsx` (fitHostRef, open/observe/doFit),
`src/lib/components/terminal/TerminalPane.css` (`.xterm-fit-host`).

## Things checked and NOT the problem

- `lineHeight: 1.12` — xterm computes cell height as
  `floor(charHeight * lineHeight)` (charHeight already includes ascent+descent
  from its measure span), so 1.12 ADDS padding; it cannot clip vertically.
- CSS `font-family: ... !important` on `.xterm`/`.xterm-rows` — redundant but
  consistent: it resolves to the same `resolvedFontFamily` string xterm measures
  with, so no measure/render mismatch. Left alone deliberately.
- The `max-width/max-height: 100%` clamp on `.xterm`/`.xterm-screen` — with a
  correctly-fitted grid this never engages; do not remove.

## Related notes

- [[terminal-rendering-stability]] — atlas eviction gating, Unicode 11 widths,
  DPI rescale: the other half of native-parity rendering.
