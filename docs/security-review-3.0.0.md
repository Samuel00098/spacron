# Security review for Spacron 3.0.0

Review date: 2026-09-05. Scope: the current shared Windows checkout. This is a focused code/dependency review with local network probes and regression tests, not a certification that the application has no vulnerabilities.

## Findings addressed

1. **AI provider redirects crossed credential boundaries.** `commands/secrets.rs` checked the configured base URL but used reqwest's default redirect policy. Provider-specific headers such as `x-api-key` and request bodies are not safe to forward to an arbitrary redirect destination. The pooled client now rejects any change of URL origin (scheme, host, or port), including HTTPS downgrades, and caps same-origin redirects. A local two-server regression test verifies that a 307 cannot send a dummy key or prompt to the other server, while a same-origin redirect preserves the request.
2. **Preview private-address validation missed IPv6 forms.** `preview/mod.rs` parsed bracketed URL hosts directly as IP addresses and did not classify IPv4-mapped IPv6 using the IPv4 rules. The literal and resolved-address paths now share address classification; DNS lookup accepts bracketed and unbracketed IPv6 correctly. Tests cover ULA, link-local, multicast, unspecified and mapped private/metadata addresses, with ordinary IPv6 loopback remaining allowed.
3. **HTTP metadata-host validation missed equivalent forms.** `commands/http.rs` now recognizes fully qualified metadata names with a trailing dot and applies all blocked IPv4 checks to mapped addresses, including unspecified and broadcast addresses. Existing localhost and private LAN access remains available to the developer HTTP client.

## Other boundaries inspected

- Tauri CSP is enabled, remote capability access is not declared, and the main capability is scoped to the main window. Markdown rendering uses DOMPurify.
- Preview messages identify their source iframe and validate the expected proxy origin. Existing proxy cookie-partitioning regression tests exercise isolation between authenticated sites.
- File operations resolve paths before checking project roots and check escaping symlinks. This does not make a user-authorized shell or agent a sandbox.
- MCP authorization rejects browser Origin headers and requires a token. Remote WebSocket authentication uses a token subprotocol and constant-time comparison.

## Verification

- `npm audit --json`: zero reported vulnerabilities, including development dependencies.
- `cargo audit --json`: zero reported vulnerabilities or warnings under the existing repository policy. The policy suppresses 18 previously triaged advisories, predominantly the Linux GTK3 stack and unmaintained transitive crates, including glib unsoundness; this is not an exception-free result.
- A second Rust audit run outside the repository, without any ignored advisory IDs, also reported zero entries classified as vulnerabilities; it exposed the expected unmaintained-crate and glib unsoundness warnings. Those upstream constraints remain.
- `npm run check`: passed.
- `npm test -- --reporter=dot`: 83 files / 1,321 tests passed. Existing mock/environment diagnostics appear on stderr.
- `npm run build`: passed for 3.0.0, with a non-fatal mixed static/dynamic theme import warning.
- Live, read-only probes of the already-running app: all three observed listeners bound to `127.0.0.1`; both preview listeners rejected foreign-origin requests with 403; MCP initialization rejected missing credentials with 401 and a foreign Origin with 403. These probes are not a live verification of the new Rust fixes.
- `cargo test --lib --no-default-features --offline`: 543 passed, 10 intentionally ignored; includes the new redirect/IP tests and existing MCP, preview cookie-isolation, filesystem and TLS tests. Used an isolated temporary target directory to preserve the running app. Compilation reported the existing unused `initial_prompt` warning with voice features disabled. The invocation started before the version bump, so its Cargo package label was 2.0.0; the tests compiled the security changes. Version 3.0.0 metadata was checked separately.

## Remaining limits

No full native UI walkthrough, real provider account requests, signed installer build, Linux/macOS execution, or remote TLS deployment was performed. Preflight DNS checks are still separate from connection-time DNS resolution; a controlled DNS-rebinding test and connection-time address enforcement remain follow-up work. Local agents and terminals intentionally execute with the user's privileges. The review does not claim confinement of malicious code already running under that account.

## Release metadata

Desktop, server and opener manifests, npm metadata, Cargo.lock and Tauri configuration use 3.0.0. Settings reads the version from package.json. The version synchronization script now includes both bundled helper manifests. CHANGELOG.md starts with the 3.0.0 entry. No release tag, publication or installer build is implied.
