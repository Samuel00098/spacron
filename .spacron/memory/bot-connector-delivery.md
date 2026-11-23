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
