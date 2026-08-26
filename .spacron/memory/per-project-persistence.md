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
