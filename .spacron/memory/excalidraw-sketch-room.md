# Sketch room = Excalidraw: theme truth and the two copies of a drawing

The Sketch room body is `components/sketch/ExcalidrawPanel.tsx` (lazy) →
`ExcalidrawCanvas.tsx` (the only module importing `@excalidraw/excalidraw`).
The old 5k-line canvas is still on disk as `SketchPanel.tsx`, imported by
nothing except its own test — it is the reference for the v4 conversion, not a
fallback.

Traps that no single file explains:

- **Excalidraw's `theme` prop restyles its chrome, not the canvas fill.** The
  fill is `appState.viewBackgroundColor`, so on a theme switch the canvas keeps
  the colour it was loaded with unless `updateScene({ appState,
  captureUpdate: CaptureUpdateAction.NEVER })` changes it. The room does that,
  but stops as soon as the user picks their own colour in Excalidraw's menu
  (`customBackgroundRef`) — that choice outranks the app theme.
- **The app's light/dark truth is the `light-theme` class on `<html>`**, set by
  `stores/theme.ts` for presets, custom themes and the system preference.
  `appearance` alone is wrong for custom themes; the room observes the class.
- **A drawing is written twice, from one debounce:** `<project>/.spacron/sketches/sketch.excalidraw`
  (a real Excalidraw document, what agents read/edit) and localStorage (cache,
  and the only copy when no project is open). Both carry `savedAt`; the newer
  wins on open. If the file write fails the cache still has the edits, so never
  make the file unconditionally authoritative.
- **Legacy conversion is one-way and one-time** (`legacySketchToScene.ts`):
  `soryq_sketch_state_v4_<projectId>`, plus the unscoped v3/v2 pair claimed via
  `soryq_sketch_legacy_owner_project`. Old keys are never removed, so a
  conversion can be re-run. Polygons/stars become rectangles (Excalidraw has no
  polygon primitive) and eraser strokes are skipped — those are the only
  deliberate losses.
- The room waits for the document (file read / conversion) before mounting the
  canvas; that is deliberate. Mounting early and swapping the scene later would
  need a remount key and a race guard against the first `onChange`.
