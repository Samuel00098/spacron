# Per-project layout persistence

Each project remembers its own stage. Two layers, both in
`src/lib/stores/workspace.ts`:

- `projectStateCache` (in-memory, `ProjectWorkspaceState`) — the warm path used
  when you switch back to a project this session.
- `localStorage` under `spacron_project_<id>` (`PersistedProjectState`) — the
  cold-start path, read back through `sanitisePersistedProjectState`.

`switchToProject` saves the outgoing project, then `restoreProjectState` puts
the incoming one back. Both save functions and the sanitiser must be edited
together: **a field saved but not taught to the sanitiser is dropped without a
word** on the cold path, which looks exactly like "my layout didn't come back".
`__sanitisePersistedProjectState` is exported for `workspace.test.ts` for that
reason.

## Where a room's open/closed state actually lives

- Most rooms are a `LayoutState` boolean (`editorVisible`, `previewVisible`, …),
  saved in the `layout` sub-object and restored with a `layout.update` patch.
- The right-drawer tools (fleet / toolbox / http / db / containers / env /
  mobile) are saved as **one tool name** (`rightDrawerTool`), not as their
  booleans — see the note on the type and `rightDrawerToolOf` in
  `stores/zustand/layout.ts`.
- The **Terminal** room is neither: `terminalRoomOpen` is its own writable in
  `stores/layout.ts`. It has to be saved and restored by name.
- `sketchVisible` and `youtubeVisible` are still **not** per-project. They are
  app-global, so opening Sketch in one project leaves it open in the next.
  Closing them does survive a switch (nothing puts them back), so this shows up
  as leakage, not as lost state.

## Reading a *background* project's rooms

`layout` and `terminalRoomOpen` describe the ACTIVE project and nothing else, so
anything that wants to show what another project has open (the Projects panel
lists a project's rooms under it) cannot read them. `projectOpenRooms` in
`stores/workspace.ts` is the per-project mirror: `publishProjectRooms` rewrites
the active project's entry on every save, and a `projects` subscription seeds
every other project once from its persisted layout — without that seed a cold
start would leave every project but one listing nothing.

Two traps live there. `collectOpenRoomIds` reads the live stores, so publishing
under any id but the active one writes one project's rooms onto another. And a
room that is app-global rather than per-project (`sketch`) can only ever be
reported for the active project, so the seed does not claim it.

## The panel can be right and still show nothing (fixed 2026-08-28)

`projectOpenRooms` publishing correctly is only half of it. The Projects panel
resolves a card's path to a project id through a `useMemo` keyed on the
zustand-backed `projects` Map, and that Map used to be written in place
(`p.set(id, project); return p`). Same reference in, same reference out — so
`useWorkspaceStore((s) => s.projects)` never re-rendered, the memo never
recomputed, and it stayed frozen at the empty Map the panel mounted with. Every
project then resolved to a null id and listed neither rooms nor running
sessions, which reads exactly like the mirror being broken.

The tell that it is this and not the mirror: the **Active** badge still lands on
the right card, because that comparison hangs off `activeProjectId` (a string,
so its identity does change) and reads the mutated Map at render time.

`projects` writes now go through `setProjectIn`, which returns a new Map.
Anything else zustand-backed is under the same rule — mutate it and React simply
stops seeing it.

## The bug that made all of this look broken (fixed 2026-08-25)

`restoreProjectState` ended with an unconditional

    terminalRoomOpen.set(true);
    layout.update((l) => ({ ...l, activeView: 'terminal', editorVisible: true }));

*after* the restore above it. So closing the Editor (or the Terminal) never
survived leaving the project and coming back — the persisted `false` was read
correctly and then overwritten a few lines later. It is now gated on a
`restoredLayout` flag: a project that had a saved layout keeps it, and only a
project with none falls through to that default stage.

The lesson generalises — when a per-project value "doesn't persist", check for a
later unconditional write in the same function before suspecting the save.

Related: [[split-maximize-zoom-layout]]
[[preview-room-is-persistent]]
