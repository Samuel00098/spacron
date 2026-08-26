# Preview: responsive viewport (no device mockup)

`PreviewPanel` used to render phone/tablet mode inside a CSS iPhone/iPad
chassis (`.device-shell`, notch, home bar, fixed 750/960px screen heights).
That is gone. The model now matches what every browser's responsive mode does:

- **The frame *is* the viewport.** `.viewport-frame` is laid out at the exact
  CSS-pixel size (`viewportSize`) and then `transform: scale()`d. The page
  inside therefore always reports the emulated width — media queries, `vh` and
  `vw` are real, and the number in the toolbar is the number the page gets. A
  bezel could only shrink the usable frame; nothing in the page can observe it.
- Presets live in `src/lib/components/preview/viewportPresets.ts` (Chrome's
  logical sizes). The selected preset is **derived** from the size via
  `matchPreset` (either orientation) — there is no `presetId` state to keep in
  sync, and a hand-resize just falls through to "Custom".
- Zoom is `'fit' | number`. Fit is computed from the stage's **content box** —
  `clientWidth/Height` minus padding. The stage is padded so the drag handles
  can sit outside the frame; fitting against the padded box lets the frame
  overhang by exactly that padding.
- Centring is `margin: auto` on `.viewport-sizer`, **not**
  `justify-content: center` on the scroll container: a centred flex item that
  outgrows its scroller has its leading edge clipped and unreachable.
- A resize drag freezes the scale (`dragScale`) for its duration. With Fit
  active, re-fitting on every pointer move makes the frame fight the pointer.
- Both modes render **one** iframe stack at the same tree position, so toggling
  device mode re-lays-out the page instead of remounting (reloading) every tab.

Anything that maps page coordinates to screen coordinates must divide/multiply
by the applied scale — `captureElementScreenshot` derives it as
`iframeRect.width / iframe.offsetWidth` (post-transform over pre-transform).

## Console panel

Capture itself is unchanged (`INSPECTOR_SNIPPET`, local dev only — see
[[preview-iframe-bridge]]). Behaviour was brought in line with a browser
console: identical consecutive messages collapse into a repeat count
(`pushConsoleLog` in `stores/previewConsole.ts`), the body sticks to the bottom
only while the user is already at the bottom, there are level/text filters, and
output is cleared on a top-level navigation and on a tab switch unless
"Preserve log" is on (only the *active* tab's output is ever captured, so
anything on screen belongs to the tab being left). The panel no longer yanks
itself open on every warning — the toolbar button carries an error/warning
badge instead.

Related: [[preview-iframe-bridge]], [[preview-room-is-persistent]]
