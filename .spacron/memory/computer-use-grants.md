# Computer-use grants: the Rust ↔ frontend handshake (2026-09-23)

Design: `docs/computer-use.md`. This note is the cross-file contract that no
single file owns.

- A `desktop_*` MCP call **blocks** inside `DesktopState::ensure` (Rust) until
  `mcp_desktop_grant_respond` answers or 120 s pass. So every
  `mcp:desktop-grant-request` event must end in a response. `DesktopGrantHost`
  answers `false` on Escape, outside click and "Don't allow"; anything new that
  can dismiss the dialog must answer too, or the agent hangs for two minutes
  and then reports a timeout the user never saw coming.
- The server boots with the switch **off**. `initComputerUse` pushes the saved
  value on subscribe; if that push is ever skipped the tools stay unlisted and
  the Settings toggle lies.
- `set_enabled(false)` clears grants AND declines pending requests on the Rust
  side; the store also empties its queue. Both halves are needed: Rust alone
  leaves a dead dialog on screen, the store alone leaves grants alive.
- Grants are keyed by PTY session and dropped in `unregister_agent`. An
  anonymous caller (app-wide token, no `agent_token` arg) is refused, never
  granted — there would be no session to revoke it from.

Related: [[agent-report-status]] (same identity resolution),
[[modal-open-count-gate]] (why the dialog is rendered conditionally).
