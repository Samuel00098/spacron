# Agent panes must survive switches and relaunches

"The agent terminal went off" has regressed more than once. Two things it spans:

- **Switching project is often a workspace switch.** A standalone project in the
  Projects sidebar is its own recents entry, so clicking it runs `openWorkspace`,
  which empties `openProjectIds`. Anything in AppShell that decides which agent
  panes stay mounted must NOT filter by `openProjectIds`, or leaving a project
  unmounts its running agents' xterms and the return trip replays the TUI into a
  fresh one (blank or garbled). `mountedAgentRoomIds` reads `allProjectSessions`
  unbounded for this reason. The personal terminal room's `terminalHostProjectIds`
  likewise adds every project with a live shell, and the room itself stays mounted
  (hidden) while any other project has one — even when the active project has it
  closed. In that case the active project's panel is passed `isActiveProject=false`
  so a closed room never auto-opens a shell.
- **Backend PTY ids restart at 1 on every launch.** A saved `backendSessionId` is
  only meaningful under the same backend run; `terminal_instance_id` names the run
  and is saved as `ptyInstance`. Restore re-attaches only on a match (webview
  reload) and otherwise relaunches the CLI. Attaching blind after a relaunch hands
  a project's agent some other session with the same number.

Related: [[per-project-persistence]] [[room-liveness-invariant]]
