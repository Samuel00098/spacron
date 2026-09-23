# What crosses the remote `invoke` seam, and what must not

`src/lib/services/backend.ts` routes every `backendInvoke(cmd)` to
`spacron-server` whenever a remote workspace is active. The server's allowlist
(`dispatch_invoke` in `src-tauri/src/remote/mod.rs`, plus the special cases just
above it) covers only:

- `fs_*` (read/write/dir/rename/copy/delete)
- `workspace_git_*` (log, status, diff, worktree ops)
- `lsp_check_server`, `lsp_start`, `workspace_info`

Anything else routed here returns `unsupported remote command: <name>`.

## The rule for deciding a transport

`backendInvoke` is for work that belongs to the **workspace** — the things that
move when the workspace moves. App data and OS/UI-local state call Tauri
`invoke` directly. When a command is on the wrong side, the failure is silent,
because callers on this path overwhelmingly catch-and-log.

`backendInvoke` now logs a pointed error when the server answers `unsupported
remote command`, naming both fixes. If you are reading that line, the question
to answer first is which side the command belongs on, not how to make the error
go away.

## 2026-08-26: `project_state_*` was on the wrong side, and is fixed

`project_state_read | _write | _path | _clear` used to go through
`backendInvoke`, so with a remote active every read hit the server, missed, and
came back through a `catch` that returned `null`; every write failed the same
way. The whole orchestrator — `orchestrator.json`, `tasks.json`, `inbox.json`,
`mailbox.json`, `orchestrator-memory.json`, `orchestrator-profile.json` — came
up empty against a remote and could not save, with nothing shown to the user.

They are bare `invoke` now. The deciding argument, if it ever comes up again:
these files live in *this machine's* config dir and the orchestrator that owns
them is entirely frontend TypeScript, so nothing on the box ever opens them.
The legacy migration inside `readProjectState` is the deliberate exception — it
reads and deletes a file **inside the repo**, which really is workspace state,
so those two calls stay routed. `project-state.test.ts` pins both halves.

`project_state_path` was dead (the MCP config went back to `<root>/.mcp.json`),
so it is gone from the frontend, from `commands/project_state.rs` and from the
`lib.rs` registration.

## 2026-08-26: turn signals decline to open rather than open uselessly

`prepareTurnSignals` / `prepareStatusChannel` mixed transports: the channel was
opened with a bare `invoke` (so the file and its watcher are on the laptop)
while the Claude settings file was written with `backendInvoke` (so it landed on
the box, carrying a laptop path). The agent's hooks appended their sentinel over
there and the watcher here never saw a line — and because `hasTurnSignalChannel`
was true, `agent-turn-watch` treated the session as `signalled`, skipped the
BEL/regex path and sat on the 15-minute `SIGNALLED_IDLE_MS` backstop. Strictly
worse than the heuristic it displaced.

Both now return `null` when `get(remoteTarget)` is set, which puts those sessions
back on the heuristic fallback at its normal window.

**`agentCanReport` had to move with it**, and this is the non-obvious half. It
answered true for `claude`/`codex`/etc. off `MCP_CONFIGURABLE_EXECUTABLES`, which
would have silenced their inferred *pauses* — "an agent that could report and
didn't gets silence". But MCP does not cross the seam either: agents are handed
`http://127.0.0.1:<port>`, and from the box that is the box's own loopback, not
the laptop's MCP server. So **no** channel reaches an agent on a remote, and
`agentCanReport` returns false there, so a guessed "needs input" still reaches
the user instead of vanishing. `remote-turn-signals.test.ts` covers both.

(Since 2026-09-21 this only affects `blocked`. A guessed *finish* is inbox-only
everywhere and never consults `agentCanReport` — see [[agent-report-status]].)

## Still open

Making hooks genuinely work remotely means giving the server its own
`agent_signal_channel_open`/`_close` and streaming the tail back over the
existing WebSocket. Until then hooks-plus-remote is *declined*, which is at
least honest, rather than silently broken.

Also still true: nothing drives agents server-side — the orchestrator is 100%
frontend TypeScript — so a client that is not the desktop app sees no agents at
all. The phone companion's agents view is blocked on that, not on this seam
(see [[mobile-companion-plan]]). Terminals are unaffected; the PTY protocol is
complete and needs no server change.

Related: [[agent-turn-detection]], [[path-confinement-layers]]
