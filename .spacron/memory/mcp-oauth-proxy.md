# MCP sign-in (OAuth) and the agent proxy (2026-10-12)

Catalog "Sign-in" servers are signed in once from Settings > MCP
(`commands/mcp_oauth.rs`); agents and the chat then reach them through
`/proxy/<key>` on Spacron's MCP server, which adds a fresh token.

Invariants that span files:

- **One key everywhere.** The grant file name, the proxy path segment and the
  config key are all `serverKey(server)` (`spacron-<name>`). Renaming a signed-in
  server orphans its grant; the row then shows "Not signed in".
- **The proxy target comes from the grant, never the request.** The grant stores
  the URL the user signed in to; `/proxy/<key>` forwards only there.
- **403, not 401, when not signed in.** A 401 makes Claude Code/Codex start their
  own OAuth discovery against 127.0.0.1, which has nothing to offer.
- Tokens are never written into agent configs: they expire in ~1h and a running
  agent would keep a dead one. That is the whole reason for the proxy.

Verified live 2026-10-12: all 20 sign-in catalog servers answer 401 with RFC 9728
metadata and offer dynamic registration; Linear accepted a registration with a
`127.0.0.1` loopback redirect and served its authorize page. A full browser
sign-in and a proxied tool call have NOT been run end to end yet — suspect the
proxy's header forwarding first if one fails.

Related: [[mcp-server-list]].
