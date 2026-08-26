# Sketch room (the in-app drawing canvas)

The dock/Tools "Sketch" button used to open **excalidraw.com** in a Preview browser
tab through the embedding proxy. Since 2026-08-23 it opens a native centre room
instead — `SketchPanel` — and the app no longer touches excalidraw.com anywhere.

## Where it came from

The canvas is not new code. A 4.5k-line `SketchCanvas.tsx` was written, matured
(multi-select, grouping, image import, hand-drawn "rough" rendering, 6 fonts) and
then deleted in `38946e1` as an "unused component". It was restored from
`38946e1^` rather than rewritten. If you need history for a canvas behaviour,
look **before** that commit — `git log --all -- src/lib/components/workspace/SketchCanvas.tsx`.

Its old sibling files (`stores/sketch.ts`, `stores/zustand/sketch.ts`,
`utils/roughSketch.ts`) were deliberately **not** restored: the stores only
tracked an open/closed flag that the room's own visibility now owns, and the
component inlines its own sketchy renderer, so `roughSketch.ts` was always dead
next to it.

## Where things are

- `src/lib/components/sketch/SketchPanel.tsx` / `.css` — the panel. Lazy-loaded
  in `AppShell` (~75 kB chunk), so it stays out of the initial bundle.
- Registered as an ordinary aux room: `AuxPanelId` + `ROOM_TITLES` +
  `PANEL_VISIBILITY_KEYS` + `roomIcon` in `AppShell.tsx`, `sketchVisible` in
  `types/layout.ts` and `zustand/layout.ts` (incl. `AUX_VIEW_FLAGS`), and a line
  in `visiblePanels` — see [[fleet-in-right-drawer]] for why `visiblePanels` is
  the room/not-room switch.
- The launcher is `sketchItem` in `AppShell.tsx`, appended to the Rooms group of
  the Tools menu ([[tools-menu-launcher]]).

## Gotchas

- **It is not an overlay any more.** `.sketch-overlay` was `position: absolute;
  inset: 0`, which worked when it covered the whole stage. `.room-content` is not
  a positioned element, so absolute would escape the room and cover its header —
  it is now `position: relative; flex: 1` and fills whatever pane hosts it. It
  also drops its own border/radius/shadow, because the hosting
  `.room-panel.bento-card` already draws the card.
- **Its key handler is on `window`.** As a full-screen overlay that was safe;
  as a room sharing the stage it is not. The handler now bails unless focus is
  inside the panel or on `<body>`. The original `isTyping` check only looked at
  `INPUT`/`TEXTAREA`, so CodeMirror's *contenteditable* slipped through and
  Delete would wipe a shape while you typed in the editor.
- Sizing is driven by a `ResizeObserver` on its own viewport, so Split/resize
  need no extra wiring.
- The 6 hand-drawn font families are **self-hosted** in `static/fonts/`. They
  used to come from an `@import url(https://fonts.googleapis.com/...)`, which the
  app CSP (`font-src 'self'`) blocks outright — every family silently fell back
  to generic cursive. Caveat and Playfair Display are variable fonts, so one file
  covers each one's weight range.
- Sketches save to `<project>/.spacron/sketches/`. The restored file wrote to
  `.soryq/` — a pre-rename project directory that survived only in that file.
