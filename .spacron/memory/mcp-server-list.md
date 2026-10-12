# User MCP servers: the namespace rule (2026-09-20)

Settings > MCP lets the user add MCP servers; they are written into every
agent CLI config Spacron knows (the table in `injectMcpConfigForAgent`), and
rewritten on any change to the list (`scheduleMcpConfigResync`), not only on
project open. Coverage widened 2026-10-12 to Qwen, Kiro, Amp, Devin and
Antigravity; Copilot and Qoder read the project `.mcp.json`. Devin and agy
shapes were taken from what their own `mcp add` wrote; Qwen/Kiro/Amp from
vendor docs only (not installed here) — suspect those first. Crush (moved to
a non-JSON `crushrc`) and Kimi (no documented path) are deliberately absent. Since 2026-09-24 the chat is also an MCP *client* for them
(`commands/mcp_client.rs`, `services/orchestrator/mcp-client.ts`), through two
generic brain tools, `mcp_list_tools` and `mcp_call_tool`, rather than one per
server tool (the brain's tool set is static). The rules that make that safe,
and must stay together:

- The model names a server; the spec (command/URL/headers) always comes from
  the user's list, never from the model.
- A tool's `readOnlyHint` from its server is the only thing that skips the
  approval card; every other call asks per `server/tool` unless Full access.
  Read-only turns (voice) refuse non-read-only tools outright.
- MCP output sets the turn's taint (`readForeignWindow`), like a website or
  another app's window, so later writes/commands ask even in Full access.

Two invariants hold the whole thing up. Break either and you corrupt files the
user also edits by hand.

1. **Every key we write starts with `spacron-`** (`serverKey`). We delete keys
   we no longer want, and owning a namespace is the only thing that makes a
   delete safe — a user's hand-written `linear` must survive us dropping our
   `spacron-linear`. `RESERVED_KEYS` additionally stops a user server named
   "mcp" rendering as `spacron-mcp` and overwriting the app's own entry, which
   would silently take every agent's cross-agent tools with it.
2. **Writes reconcile the namespace, they do not just add.** A renamed,
   disabled or deleted server leaves a stale key that nothing in the desired
   set names, and no bookkeeping of "what did we write last time" survives a
   reinstall. `mergeMap` diffs the wanted set against the keys actually in the
   file; Codex's TOML does the same through `stripTomlTablesWhere` over a
   `[mcp_servers.spacron-*]` predicate. Both need the file read first, which is
   why `mergeJsonMcpConfig` takes a callback form.

Gotchas worth keeping:

- **Codex cannot express request headers.** There is no verified key for them
  in its TOML, so a header-authenticated server is written to Codex
  unauthenticated and works everywhere else. `headersLostOnCodex` drives both a
  console warning and a line in the UI — do not "fix" this by inventing a key.
- Headers/env/args are parsed **one entry per line, never split on
  whitespace**. Header values and command arguments legitimately contain
  spaces, and halving one produces a server that fails to start with nothing on
  screen to say why.
- opencode is the odd dialect throughout: section `mcp` not `mcpServers`,
  transport named `remote`/`local`, argv as one flat array, explicit `enabled`.
- The Playwright server is still owned by the `agentBrowserTools` boolean, not
  by this list. The MCP tab shows it as a built-in row wired to that same
  setting, so there is one place to see everything without migrating a working
  feature.

Related: [[orchestrator-emulator-tools]].
