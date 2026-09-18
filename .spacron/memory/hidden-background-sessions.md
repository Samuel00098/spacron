# Hidden background terminal sessions

`TerminalSessionInfo.hidden` marks internal background sessions (currently only
the Embedded panel's connection probe). They never take a pane or room, never
show in the session-tab bar or project sidebar, exit silently, and are killed
as soon as the probe settles.

The field must be threaded through **every** user-facing surface — that is the
mistake waiting to happen, because each surface filters sessions for a
different reason:

- `TerminalPanel` `shellSessions` filter — the tab bar and attach menu
- `ensureIdleOrCreateTerminal` reuse filter — a hidden shell must never be
  reused for a user command
- `handlePtyExit` — hidden exits must not toast/chime
- `registerPtySession` — must not set `activeSessionId` to a hidden id, and
  hidden sessions count toward no "Terminal N" numbering
- AppShell `liveShellsOf` and ProjectHUD `sessionsByProject` — sidebar/room
  counts and close gates
- `workspace.ts` `saveProjectState` — hidden sessions are filtered out of
  persisted state

Entry point is `embeddedRun.ts`: `background: true` in options creates a
dedicated hidden session via `createTerminalSession(..., { assignPane: false,
hidden: true })` and kills it in `settle`. `background` implies `quiet` (no
focus/room steering).

Related: [[embedded-command-sentinel]]