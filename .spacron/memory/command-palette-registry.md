# Command palette registry: Tools menu parity + no backdrop veil

The palette (`CommandPalette.tsx` + `src/lib/stores/commandpalette.ts`) is not
hand-maintained any more. Two sources feed it:

1. `initDefaultCommands()` — file/workspace/view/editor/preview/theme basics.
   It **merges** into the store (defaults win on id collisions) rather than
   replacing, so anything registered elsewhere survives a palette remount.
2. AppShell registers every Tools-menu item, layout action, and Settings
   section on mount (search `paletteBridgeRef` in `AppShell.tsx`).

## The bridge-ref pattern (why two effects)

Tools-menu onClicks read "is it open" from **render scope** (e.g.
`toggleLeftTool` compares against `leftActiveTool`). Registering those closures
once would freeze a stale answer into the palette. So:

- Effect A runs **every render**, copying the current render's onClicks into
  `paletteBridgeRef` keyed `tools.<group>.<item>` / `layout.<id>`.
- Effect B runs only when a signature of id+title+category changes, registering
  commands whose `action()` calls through the ref. Without the signature gate
  the store would be rewritten every render and churn all subscribers.

When adding a tool to the Tools menu, nothing else to do — it appears in the
palette automatically under its group label ('Workspace' / 'Rooms' /
'Utilities'). Layout actions land under 'Layout', settings deep-links
(`openSettings(tab)` for each `SettingsTab`) under 'Settings'. Themes are
registered dynamically in `CommandPalette.tsx` (`theme.activate.<id>`).

## Overlay styling

`.command-palette-overlay` is deliberately a transparent click-catcher — no
background tint, no `backdrop-filter`. The user asked for the blur veil behind
the card to go; do not reintroduce `--bg-glass`/blur there. The card itself
keeps its frost.

## Execution & keyboard contract

- `executeCommand` closes the palette **first**, then runs the action inside
  try/catch (async failures toast). Reason: the palette overlay sits above the
  surfaces it launches (`SettingsModal` and friends), so if one raced the
  unmount it would open *underneath* the palette and look like nothing
  happened. Never reorder this.
- Keys: ArrowUp/Down wrap, PageUp/Down ±5, Home/End, Enter runs, Esc closes;
  selection follows via `scrollIntoView(block:'nearest')`; empty result set
  guards the modulo-NaN trap; typing clamps the selection into the shrunk list.

## The Memory Graph is gone (v2.0.0)

This note used to document a "Memory Graph" room that visualised the wikilinked
notes under `.spacron/memory/`. It was **removed in v2.0.0** — the overlay, its
palette command, `memoryGraphVisible`, `toggleMemoryGraphVisible` and
`knowledgeGraphOpen` no longer exist anywhere. The knowledge store it drew from
is untouched and still backs the orchestrator's memory; only the visualisation
went. Do not resurrect it from this note or from an older copy of it.

## Palette arrow-key scrolling gotchas

Two bugs made arrows feel broken, both fixed — don't regress them:
1. `scrollIntoView()` also scrolls other ancestors and loses to CSS smooth
   scroll → the effect adjusts `resultsEl.scrollTop` from bounding rects.
2. `onMouseEnter` row-select fought keyboard nav: keypress scrolls rows under
   a stationary cursor, mouseenter yanks selection back. Guarded by
   `pointerMovedRef` (set on window pointermove, cleared by any nav key).

