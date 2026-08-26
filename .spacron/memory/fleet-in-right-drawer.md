# Agent Fleet lives in the right utility drawer

(2026-08-23) The Agent Fleet panel (`FleetDashboard.tsx`) used to be a **centre
room** — one of the tiled cards on the stage, launched from the Rooms group as
"Agent Changes". It is now a **right-drawer tool**, alongside
Toolbox/HTTP/DB/Containers/Env/Mobile. See [[tools-menu-launcher]] for where the
launchers themselves live.

## What that means mechanically

`fleet` is now in `RIGHT_DRAWER_TOOLS` (`src/lib/stores/zustand/layout.ts`), so:

- `AUX_DRAWER_FLAGS` maps `fleet -> fleetVisible`, and `showRightDrawerTool` /
  `setRightDrawerTool` clear it like any other tool.
- It is **removed from `visiblePanels`** in `AppShell.tsx`. That array feeds
  `openRooms`, so this is the single line that decides "centre room vs not".
  A panel can stay in `AuxPanelId` / `PANEL_VISIBILITY_KEYS` / `PanelHost` (it
  must, so the drawer body can render it) while not being a room at all —
  `mobile` is the other example.
- `toggleFleetVisible` no longer flips the flag itself; it delegates to
  `setRightDrawerTool`. Flipping `fleetVisible` directly now sets a flag that
  nothing paints.

## Gotcha: `rightDrawerToolOf` precedence

`fleet` is checked **LAST** in `rightDrawerToolOf`, unlike its first position in
`RIGHT_DRAWER_TOOLS` (that array is tab order, not precedence). Reason:
`fleetVisible` gets set by things outside the drawer's own tab strip — tiling all
agents opens it — so ranking it high would let a leftover flag shadow the tool the
user just clicked. The legacy per-tool toggles (`toggleDbVisible` etc.) were also
updated to clear `fleetVisible` in their open branch; they each clear only *some*
siblings, which is the pre-existing wart this precedence rule defends against.

## Tiling all agents opens it automatically

`switchAmbientLayout('vibe')` (the "Tile all agents" button, and any orchestrator
`ambient: vibe` command) now calls `applyRightDrawerTool('fleet')` after the
"no agents running" guard — **`applyRightDrawerTool`, not `setRightDrawerTool`**,
because the latter hijacks `activeView` and would steal focus from the agent the
switch is about to focus.

`toggleFleetArrangement` in `AppShell.tsx` records the previous drawer tool in
`preFleetLayoutRef.drawer` and restores it on the second press — but only if the
drawer is still showing Fleet, so switching the drawer to another tool mid-tiling
is not undone behind the user's back.
