# Agent browser: the pinned install and its traps (2026-09-23)

Design and as-built notes: `docs/agent-browser.md`.

- **Two constants, one version.** `PLAYWRIGHT_MCP_VERSION` exists in
  `mcpBridge.ts` (agent configs) and `commands/browser_tools.rs` (install, chat
  browser). A vitest reads the Rust line to keep them equal. Bumping it also
  means re-recording `KNOWN_TOOLS` from the new server (the ignored
  `real_server_answers_and_navigates` test fails when the count changes) and
  re-checking the chat schemas in `agent-transport.ts`: upstream renames
  arguments (0.0.82 uses `target`, not `ref`) and the chat's strict validation
  then rejects every call.
- **Long PATH breaks npx only in some shells.** `cmd.exe` stops resolving
  commands once PATH passes ~8191 chars; `where npx` still works, which makes it
  look fine. npx then starts the package through its own shell after
  prepending a `.bin` dir, so trimming to 8000 was not enough — children get
  6000 (`child_path`). Seen from `cargo test` (cargo prepends many entries); a
  user with a long PATH hits it in the app too.
- **Playwright writes into the cwd by default** (`.playwright-mcp/`): always pass
  `--output-dir`, or agents litter the user's repo.
- `browser_run_code_unsafe` is RCE-equivalent upstream; it must never be added
  to the chat's allowlist, approval or not.

Related: [[computer-use-grants]] (the taint rule is shared).
