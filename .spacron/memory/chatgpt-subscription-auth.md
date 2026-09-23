# ChatGPT subscription as a brain provider

The `chatgpt` AI provider is not an HTTP provider: it is the user's own Codex
CLI driven over JSON-RPC (`codex app-server`), so their ChatGPT plan pays for
the turn and Spacron never handles a token. Backend `commands/chatgpt.rs`; UI
`ChatGptSignIn.tsx` in Settings → AI Connections. It is wired in by pretending
to be a key: `provider_api_key_exists("chatgpt")` answers from the Codex login,
so every "is this provider connected" call site works unchanged.

Traps, each one paid for once:

- **Never spawn `codex` through the npm shim.** The Windows `.cmd` needs `node`
  on PATH, which an app launched from the desktop often lacks ("'node' is not
  recognized"), and the extensionless sibling is an sh script CreateProcess
  cannot run. Resolve the native binary under the platform package's
  `vendor/<triple>/bin/` the way the package's own `bin/codex.js` does.
- **A plain start costs ~11s**, nearly all of it the user's hooks, apps,
  plugins and MCP servers. With `--disable hooks --disable apps --disable
  plugins -c mcp_servers={}` and the native binary, a start measured 0.4–1s
  (2026-09-22); the rest of a ~5s turn is the model. The server is kept warm
  between requests (`WARM` in chatgpt.rs), so only the first request, one after
  a Stop, or one after 10 idle minutes pays the start.
- **Rust's argument quoting is not `cmd.exe`'s.** `-c web_search="disabled"`
  arrives escaped and kills the server at startup; pass unquoted values.
- Codex's stderr is the only place startup failures are explained, so capture
  it — an exit with no stdout is otherwise a blank "exited unexpectedly".
- The brain replies in text, never native tool calls: `ai_agent_capabilities`
  reports `nativeTools: false` so the transport uses its text mode. See
  [[orchestrator-tool-calling]].

Anthropic does **not** allow a distributed product to offer Claude sign-in
without approval, so no equivalent Claude Code brain ships. OpenAI designed the
app server for third-party clients, which is why this one is fine.
