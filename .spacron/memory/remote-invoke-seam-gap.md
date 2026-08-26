# The remote `invoke` seam does not carry project state

`src/lib/services/backend.ts` routes every `backendInvoke(cmd)` to
`spacron-server` whenever a remote workspace is active. The server's allowlist
(`dispatch_invoke` in `src-tauri/src/remote/mod.rs`, plus the special cases just
above it) covers only:

- `fs_*` (read/write/dir/rename/copy/delete)
- `workspace_git_*` (log, status, diff, worktree ops)
- `lsp_check_server`, `lsp_start`, `workspace_info`

**Not covered: `project_state_read | _write | _path | _clear`.**

That matters because `src/lib/services/project-state.ts` — which owns the
orchestrator's durable state (`orchestrator.json`, `tasks.json`, `inbox.json`,
`mailbox.json`, `orchestrator-memory.json`, `orchestrator-profile.json`) — calls
those four through `backendInvoke`. In remote mode they hit the server, get
"unknown command", and `readProjectState` swallows the error (`catch` →
`console.error` → returns `null`). **The failure is silent:** the orchestrator
just comes up empty against a remote, as if the project had never been used.

Consequences to know before you touch this area:

- Fixing it means adding `project_state_*` to the server's dispatch (the state
  dir derivation lives in `src-tauri/src/commands/project_state.rs`) **or**
  deciding project state is client-local and routing it past `backendInvoke` to
  a bare Tauri `invoke`. Those are opposite answers — pick deliberately: whose
  machine owns the task list, the box or the laptop?
- Anything that wants agent/task state *from the server* (the phone companion's
  agents view, see [[mobile-companion-plan]]) is blocked on this. Terminals are
  not — the PTY protocol is complete and needs no server change.
- The orchestrator itself is 100% frontend TypeScript
  (`src/lib/services/orchestrator/`). Nothing drives agents server-side, so a
  client that is not the desktop app sees no agents at all today.

## 2026-08-25: `agent_signal_*` is on the wrong side of the same seam

`prepareTurnSignals` (`services/orchestrator/agent-hook-signals.ts`) mixes the
two transports in one function:

- `invoke('agent_signal_channel_open')` — a **bare Tauri invoke**, so the
  append-only file and its `notify` watcher are always opened on the *laptop*
  (`commands/agent_signals.rs`; the server's `dispatch_invoke` has no
  `agent_signal_*` arm).
- `backendInvoke('fs_write_file', { path: `${path}.settings.json` })` — routed,
  so with a remote workspace active the Claude settings file is written on the
  **box**, carrying a path that only exists on the laptop.

With a remote workspace, the agent then runs on the box, its `Stop` /
`Notification` hooks append the sentinel to that path *there*, and the local
watcher never sees a line. Nothing errors: `hasTurnSignalChannel` is true, so
`agent-turn-watch` treats the session as `signalled`, skips the bell path, and
sits on the 15-minute `SIGNALLED_IDLE_MS` backstop. **Remote turns silently lose
the one deterministic signal we have and get worse than the heuristic path.**

Fixing it means picking a side, same choice as `project_state_*` above: either
add `agent_signal_channel_open/close` to the server dispatch and stream the
tail back over the WS, or write the settings file locally too (which only works
when the agent also runs locally). Until then, treat "hooks + remote" as
unsupported rather than working.

Related: [[agent-turn-detection]], [[t3code-turn-signals]]
