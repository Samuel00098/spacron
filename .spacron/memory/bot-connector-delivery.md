# How a bot run gets its connectors

Claude: `--mcp-config` (`bots.rs`). Codex: `-c mcp_servers.*` overrides
(`codex_mcp_flags`). Everyone else: `remote/bot_mcp.rs` writes the agent's
project config file into the bot's home for the run and restores it after.

- Adding an agent = one row in `DIALECTS`; an agent with no row gets `.mcp.json`
  (best effort, unverified per agent). The entry shapes mirror the `inject*Config`
  functions in `mcpBridge.ts` -- change one, check the other.
- Spacron's own SSE address is rewritten to its `/mcp` twin for non-Claude agents.
- Not verified live: Gemini/opencode/cursor actually loading the file headless
  (workspace-trust and approval prompts are each CLI's own). droid and agy only
  read global config, so they get nothing useful.
