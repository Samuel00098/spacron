# How a bot run gets its connectors

Claude: `--mcp-config` (`bots.rs`). Codex: `-c mcp_servers.*` overrides
(`codex_mcp_flags`). Everyone else: `remote/bot_mcp.rs` writes the agent's
project config file into the bot's home for the run and restores it after.

- Adding an agent = one row in `DIALECTS`; an agent with no row gets `.mcp.json`
  (best effort, unverified per agent). The entry shapes mirror the `inject*Config`
  functions in `mcpBridge.ts` -- change one, check the other.
- Spacron's own SSE address is rewritten to its `/mcp` twin for non-Claude agents.
- Checked against the real CLIs (2026-11-23): grok loads `.grok/config.toml`
  (`grok mcp list`), kilo resolves `opencode.json` (`kilo debug config`), dsh
  composes our `--patch` (`--dump-config`), pi ignores `.pi/mcp.json` until
  trusted and `--approve` is its trust override. Not run end to end: any model
  call actually using a connector. opencode's `mcp list` shows nothing outside a
  git repo, but `opencode debug config` does resolve the file.
- droid and agy read only a global file (the desktop syncs those), so a bot's
  picks do not apply to them; `GLOBAL_ONLY` in `bot_mcp.rs`, `GLOBAL_MCP_ONLY` in
  `BotsPanel.tsx`. Gemini/Cursor loading their file headless is unverified.
- Headless agy auto-denies anything not pre-approved (`agy_permission_flags` in
  `bots.rs`). Checked on agy 1.5.18 (2026-11-26): `--settings` with
  `mcp(server/*)` lets the call through. Deny rules, `read_url(*)` and
  `accept-edits` were not run live. Automations do not get these flags.
- Access levels per agent live in `bot_command` (`bots.rs`). Seen live
  (2026-11-26): opencode 2.4.1 and kilo 7.8.32 honour the env-defined agent
  (v1 `agent.permission` shape works on both); grok 1.0.92 `dontAsk` refuses
  writes. dsh and pi flags are from their help only (no key / no credit).
- Grok ignores a bot home's `.grok/config.toml` servers headless while the
  folder is untrusted. `--trust` would also run hooks found there, which a
  bot with folder access could write; not added.
- Gemini gets no connector pre-approval yet (not installed to verify).
