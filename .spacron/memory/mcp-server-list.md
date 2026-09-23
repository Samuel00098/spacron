# User MCP servers: the namespace rule (2026-09-20)

Settings > MCP lets the user add MCP servers; they are written into all six
agent CLI configs. Spacron is an MCP **server** with a config *writer* — it is
still not an MCP *client*, and the orchestrator does not import these servers'
tools. That was a deliberate scope call, not an oversight: importing them needs
a per-tool risk class routed through the approval cards, or the confinement
work has a hole in it.

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
