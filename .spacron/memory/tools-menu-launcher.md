# Tools menu (the old room dock)

The bottom `.room-dock` strip is **gone** (2026-08-23). Every launcher it held now
lives in a "Tools" dropdown at the **right end of the floating prompt bar**, with the
layout actions inline beside it.

## Where things are

- `src/lib/components/layout/ToolsMenu.tsx` / `.css` — the popover. Grouped
  (Workspace / Rooms / Utilities), 2-column grid, portaled to `<body>` and
  positioned `fixed` from the trigger rect. It opens *upward* and hangs from the
  trigger's **right** edge, so `transform-origin` is `bottom right`.
- `AppShell.tsx` still owns all the wiring: `leftNavDockItems`, `roomLauncherItems`,
  `drawerToolItems`, `sketchItem` → `toolMenuGroups`; `spawnAgentItem` + Focus /
  Split / Tile Agents → `layoutActionItems`.
- Both are handed to `FloatingPromptBar` through one `trailingControls` prop
  (`<div class="prompt-trailing">`), rendered between the input and Send and hidden
  in voice mode. The prompt bar stays dumb — it never imports the room stores.

## Gotchas

- The popover **must** portal to `<body>`. The prompt bar has a `backdrop-filter`,
  which makes it the containing block for `position: fixed` children — same trap as
  [[modal-containing-block-gotcha]].
- `ActivityButton` / `.svt-btn` survived the dock's removal; they are now only used
  by the inline layout actions, and `.composer-strip .prompt-trailing .svt-btn`
  resizes them 34px → 36px and drops the dock's active-state underline.
- `--overlay-clear` (AppShell.css) dropped 128px → 84px now that only the composer
  floats at the bottom. It is the pad Focus/Split use to clear the bottom chrome —
  adding chrome back there means raising it again.
- The WebKitGTK "force a repaint" guard in `AppShell.tsx` used to query
  `.room-dock, .composer-strip`; it now queries `.composer-strip` alone.
