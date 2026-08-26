# Spacron Security Model

This document explains what Spacron can and cannot do on your system, how it isolates operations, what data it stores locally, and how the preview proxy is protected against abuse.

---

## Table of Contents

1. [Capability Model](#1-capability-model)
2. [File System Access](#2-file-system-access)
3. [Terminal Security Model](#3-terminal-security-model)
4. [Preview Proxy Security](#4-preview-proxy-security)
5. [No Telemetry](#5-no-telemetry)
6. [Local Data Storage](#6-local-data-storage)
7. [Network Access](#7-network-access)
8. [Content Security Policy](#8-content-security-policy)
9. [Remote Workspaces](#9-remote-workspaces)
10. [The MCP Server](#10-the-mcp-server)
11. [Auditing a Release](#11-auditing-a-release)

---

## 1. Capability Model

Spacron is built on **Tauri 2**, which uses a capability-based permission system. All communication between the React frontend (running in a sandboxed WebView) and the Rust backend goes through Tauri's IPC channel. The frontend cannot call arbitrary OS APIs directly.

The plugins loaded at runtime are:

| Plugin | Purpose |
|---|---|
| `tauri-plugin-shell` | Open URLs in the system browser (`preview_open_in_browser`) |
| `tauri-plugin-dialog` | File/folder picker dialogs for opening projects and saving screenshots |
| `tauri-plugin-updater` | Signed update checks against the releases repo |
| `tauri-plugin-process` | Restart after applying an update |
| `tauri-plugin-notification` | Native desktop notifications |
| `tauri-plugin-clipboard-manager` | Copy/paste of text and images |

What a plugin is *loaded* with is not what the frontend can *call*. The window's
capability set (`src-tauri/capabilities/default.json`) is the authority, and it
grants no `shell:` or `fs:` permissions at all — `tauri-plugin-shell` is reachable
only from Rust, and there is no filesystem plugin. Every project file operation
goes through a custom command instead.

Custom Tauri commands (the `invoke_handler` list in `lib.rs`) are therefore the only surface through which the frontend can trigger backend actions. Each command independently validates its inputs before acting.

---

## 2. File System Access

### Project Root Scoping

All file-system operations — `read_dir`, `read_file`, `write_file`, `create_file`, `create_dir`, `rename`, `delete`, `copy` — are **gated behind a path validation step** implemented in `commands/file_system.rs`:

```rust
fn require_in_project(path: &Path, state: &AppState) -> Result<(), String> {
    // ...
    if !projects.iter().any(|p| canonical.starts_with(&p.root_path)) {
        return Err("Access denied: path is outside any open project".to_string());
    }
    Ok(())
}
```

The resolved canonical path of every requested path must begin with the canonical root path of at least one open project. If no project is open, all file operations are rejected immediately.

### Path Traversal Protection

An existing path is canonicalized with `std::fs::canonicalize`, which resolves
symlinks and `..` against the real filesystem. The interesting case is a path
that does **not** exist yet — `create_file`, `write_file`, `rename` — where
`canonicalize` fails outright and cannot be relied on. Those are resolved
against the nearest existing ancestor and then normalized **lexically**: `..`
components are folded away with no filesystem access, and a `..` that would
climb above the path root is dropped rather than allowed to escape. Paths
beginning with `--`, which git and other tools could read as flags, are rejected.

### Symlink Handling

Confinement is re-checked against the links themselves, because a *dangling*
symlink is invisible to the checks above: `Path::exists` follows the link and
reports false, so the path takes the "new file" branch, reads as inside the
root, and the caller's `fs::write` or `create_dir_all` then follows the link and
lands outside it. Every component of a path is therefore walked with
`symlink_metadata` (which does not follow), and any link resolving outside the
project roots is rejected — up to a 16-hop chain limit. Intermediate components
matter as much as the final one, since `write_file` calls `create_dir_all` on the
parent and `create_dir_all` will happily materialize the target of a dangling
directory symlink.

When copying directories, symlinks are **skipped entirely**. Following a symlink during a copy could escape the project root (e.g., a symlink pointing to `/etc`).

### Error Message Redaction

IO error messages returned to the frontend have absolute path information removed:

```rust
fn redact_path(path: &str) -> String {
    let p = Path::new(path);
    p.file_name()
        .map(|n| format!("[redacted]/{}", n.to_string_lossy()))
        .unwrap_or_else(|| "[redacted]".to_string())
}
```

This prevents local directory structure from leaking through error messages displayed in the UI.

### File Size Limits

| Operation | Limit |
|---|---|
| Read file | 50 MB maximum |
| Write file (text) | 100 MB maximum |
| Write file (binary) | 100 MB maximum |
| Codebase search (per file) | 10 MB maximum (larger files skipped) |

---

## 3. Terminal Security Model

### Full Shell Access — by Design

The terminal provides a genuine PTY session running your configured shell (`bash`, `zsh`, `pwsh`, `cmd.exe`, etc.). **This is intentional** — Spacron is a developer tool, and the terminal is its most important surface. The shell process runs with the same permissions as the user who launched Spacron.

**What this means in practice:**
- The user can run any command the OS permits, including `sudo`, `rm -rf`, network tools, etc.
- Spacron does not attempt to sandbox or filter shell commands
- No command history or output is sent to any remote server

### Shell Selection

When a user specifies a shell program in Settings, the backend validates the program name against the list returned by `available_shells()`. Unrecognized shell programs are rejected with an error:

```
Unrecognized shell program: <name>. Available shells: pwsh, powershell, cmd.exe, ...
```

This prevents the frontend from passing arbitrary executable paths to the PTY spawner.

### PTY Cleanup

When a terminal session is closed or when the app window is closing, all PTY child processes are killed via `ChildKiller::kill()`. This prevents orphaned processes from persisting after Spacron exits. The `Drop` implementation on `PtySession` ensures cleanup even in error paths.

### Working Directory

Terminal sessions start in the current project root (if a project is open) or the OS default working directory. The working directory passed to the PTY is canonicalized and path-cleaned before use.

---

## 4. Preview Proxy Security

The preview proxy is an Axum HTTP server that listens on `127.0.0.1` only. It is never exposed on a public interface.

### SSRF Protections

The proxy differentiates between two types of requests:

1. **Local dev server requests** — forwarded to `127.0.0.1:<target-port>` or `localhost:<target-port>`
2. **External URL requests** — triggered via `/proxy/{scheme}/{host}/path` or `?url=...` query params

For external URL requests, the following protections apply:

**Private IP blocking:** The proxy refuses to forward requests to private IP ranges:
- IPv4: `127.0.0.0/8` (loopback), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918), `169.254.0.0/16` (link-local)
- IPv6: loopback (`::1`), ULA (`fc00::/7`), link-local (`fe80::/10`), multicast, unspecified

```
HTTP/1.1 403 Forbidden
Access to private/internal resources is not allowed
```

**Restricted port blocking:** The proxy refuses to connect to ports associated with sensitive services:

| Port | Service |
|---|---|
| 22 | SSH |
| 23 | Telnet |
| 25 | SMTP |
| 53 | DNS |
| 110 | POP3 |
| 135 | RPC |
| 139 | NetBIOS |
| 143 | IMAP |
| 445 | SMB |
| 993 | IMAPS |
| 995 | POP3S |
| 2375 | Docker daemon (unauthenticated) |
| 3306 | MySQL |
| 3389 | RDP |
| 5432 | PostgreSQL |
| 6379 | Redis |
| 6443 | Kubernetes API |
| 8500 | Consul |
| 9090 | Prometheus |
| 27017 | MongoDB |

**Redirect following:** The proxy follows redirects but re-checks each redirected URL against the private-IP and restricted-port rules. A redirect that would land on a private resource is blocked mid-chain.

### CSP and Frame-Header Stripping

When proxying **external** URLs, the proxy strips the following response headers to allow the page to render in the Spacron iframe:
- `X-Frame-Options`
- `Content-Security-Policy`
- `Content-Security-Policy-Report-Only`

This stripping only happens for external URLs routed via the `/proxy/` path. Local dev server responses have their headers passed through unchanged (except for headers that break chunked streaming).

### WebSocket Proxy

WebSocket connections are only proxied for local dev server traffic (not external URLs). Origin validation is enforced:

```rust
let ws_origin_valid = parts.headers.get("origin")
    .and_then(|v| v.to_str().ok())
    .map(|o| {
        o == "null" || o == "http://127.0.0.1" || o.starts_with("http://127.0.0.1:")
        || o == "http://localhost" || o.starts_with("http://localhost:")
    })
    .unwrap_or(false);
```

Only connections originating from `127.0.0.1` or `localhost` are accepted.

### Inspector Script Injection

The inspector script injected into HTML responses:
- Posts messages to `window.parent` only via `parent.postMessage(...)` targeting `window.location.origin` — it cannot communicate with arbitrary origins
- Never reads or modifies files
- Never makes network requests of its own
- Captures and forwards only console output and click-selection data to the Spacron UI
- Sanitizes values before JSON serialization to avoid prototype pollution

The injected script is idempotent: if it detects it has already been injected (by checking for its own marker), it does not inject again.

### Proxy Request Body Limit

Incoming request bodies are capped at **10 MB** before being forwarded. Larger bodies receive a `400 Bad Request` response.

### Proxy TLS

The reqwest client used by the proxy does **not** use `danger_accept_invalid_certs` for loopback destinations — that option is explicitly set to `false`. Connections to local servers (which typically serve over plain HTTP) are made over plain HTTP.

---

## 5. No Telemetry

Spacron collects **no telemetry, analytics, or crash reports**, and has no
account system. Nothing is sent anywhere to describe how you use the app.

That is a narrower claim than "makes no network connections", and the difference
matters, so every outbound call the app can make is listed below. All of them are
either explicitly triggered by you or gated on a feature you turned on; none of
them carries usage data.

**Always available, no credential required**

- Your own dev server, via the preview proxy, and external URLs you type into the preview URL bar.
- `git fetch` / `push` / `pull`, delegated to the system `git` binary rather than Spacron's network stack.
- `preview_open_in_browser` — hands a URL to the OS shell opener; your browser makes the request.
- **Update checks** against the releases repo. Updates are signed with a minisign key pinned in `tauri.conf.json`; an artifact that does not verify is refused.
- **Agent logo lookups** (jsDelivr / a favicon service) the first time an unknown agent CLI is shown, cached afterwards.

**Only when you configure them**

- **AI providers** — OpenRouter, OpenAI, Anthropic, Google, Groq, xAI, or a local Ollama/LM Studio endpoint. Requests go out only when you use a feature that needs one (voice transcription, commit messages, the orchestrator), and only to the provider whose key you supplied. Keys live in the OS keychain and are never written to disk in the clear.
- **GitHub** — OAuth device flow and API calls for the source-control panel. The token lives in the OS keychain and is never returned to the frontend.
- **Usage meters** — each agent CLI's own quota endpoint, for the providers you have signed into.
- **ONNX Runtime download** — fetched from Microsoft's official release, once, if you enable offline Parakeet speech-to-text.

**Servers Spacron itself can run**

These listen for connections rather than making them. All three are covered in
their own sections below:

- The **preview proxy** — loopback only.
- The **MCP server** — loopback only, token-gated, and refuses any request carrying an `Origin` header.
- The **remote-workspace server** (`spacron-server`) — the one component that deliberately binds `0.0.0.0`, because its whole purpose is to be reached from your desktop. It is a separate binary you deploy to a box you own, it requires a pre-shared token, and it is **not** running unless you started it. See [Remote workspaces](#9-remote-workspaces).

---

## 6. Local Data Storage

### Configuration Directory

App configuration is stored in the platform-standard config directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\spacron\` |
| macOS | `~/Library/Application Support/spacron/` |
| Linux | `~/.config/spacron/` |

The config directory is created on first launch. Contents include custom theme JSON files and saved app state.

### localStorage

User settings, workspace state, and layout preferences are stored in the WebView's `localStorage`. This data lives inside the Tauri WebView data directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\com.samue.spacron\` (WebView2 profile) |
| macOS | `~/Library/WebKit/com.samue.spacron/` |
| Linux | `~/.local/share/com.samue.spacron/` |

**What is stored in localStorage:**
- All settings values (font, tab size, shortcuts, zoom, etc.)
- Workspace list and active workspace ID
- Layout state (sidebar width, active view, split mode)
- Editor open files and cursor positions (per project)
- Terminal command history (last 100 entries)
- Preview proxy state (target port, current URL)
- File explorer expanded paths

### No Cloud Sync

None of the above data leaves your machine. There is no account system, no sync service, and no remote backup.

---

## 7. Network Access

Section 5 lists every destination. This section covers the two controls that
apply to outbound requests regardless of destination.

### SSRF Guards on the HTTP Client

The HTTP client behind `http_send_request` (the HTTP Client panel, and the
provider calls) refuses **link-local and cloud-metadata** addresses — most
importantly `169.254.169.254`, the endpoint that hands out cloud instance
credentials, along with its IPv4-mapped IPv6 form and the well-known metadata
hostnames. The check is DNS-aware: a hostname is resolved and rejected if *any*
resolved address is in a blocked range, closing the "attacker-controlled DNS name
→ 169.254.169.254" bypass that a literal-only check misses. The same check runs
again on every redirect hop, so a redirect cannot smuggle a request somewhere the
original URL could not reach.

Loopback and RFC 1918 private ranges are deliberately **allowed** here — reaching
your own dev server, a container, or a service on your LAN is the ordinary use of
a developer HTTP client, and blocking it would break the panel's main purpose.
The preview proxy, which handles untrusted remote content rather than requests you
typed, applies the stricter private-IP policy described in section 4.

### Browser Handoff

`preview_open_in_browser` parses the URL and requires an `http` or `https` scheme
before passing it to the OS shell opener. `file://`, `javascript:` and every other
scheme are rejected.

---

## 8. Content Security Policy

`tauri.conf.json` holds the authoritative policy; it is reproduced here in
shortened form, and if the two ever disagree, the config is right.

```
default-src 'self';
script-src  'self' https://www.youtube.com https://s.ytimg.com;
style-src   'self' 'unsafe-inline';
img-src     'self' data: blob: asset: <asset.localhost> http://127.0.0.1:*
            <youtube thumbnail hosts>;
font-src    'self';
media-src   'self' blob: asset: <asset.localhost> <youtube media hosts>;
connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*
            wss://api.x.ai https://www.googleapis.com <youtube hosts>;
frame-src   'self' http://127.0.0.1:* https://www.youtube.com
            https://www.youtube-nocookie.com;
object-src  'none';
worker-src  'self' blob:;
```

Key points:

- **The app's own scripts come only from the bundle.** The `youtube.com` /
  `ytimg.com` entries exist for the embedded player, which is the one third-party
  surface the shell hosts directly.
- **`connect-src` is a deliberate allowlist, not a wildcard**, and it is why the
  HTTP Client and every AI-provider call live in Rust rather than in the WebView:
  widening this directive to reach arbitrary hosts would hand the same reach to
  any script that ever ran in the shell. The two non-loopback entries are the
  ones that must be spoken by the WebView itself.
- **The same rule shapes the remote-workspace client.** `ws://127.0.0.1:*` is the
  only WebSocket origin permitted, so a remote server — which is not on loopback,
  and may be `wss://` — is reached through a loopback relay in Rust instead of by
  widening the policy. See section 9.
- **External web content is never loaded into the shell's own origin.** It renders
  inside an iframe served from `http://127.0.0.1:<proxy-port>`, so the proxy's
  protections apply to it.
- **`object-src 'none'`** — no plugin content, ever.
- **Inline styles are permitted** (`'unsafe-inline'`) to support dynamic theming
  via CSS custom properties. Inline *scripts* are not.

The `asset:` protocol is scoped in `tauri.conf.json` to the wallpaper
directories only, so it cannot be used to read arbitrary files off disk.

---

## 9. Remote Workspaces

`spacron-server` is a separate binary that runs the PTY core on a machine you
own and serves it over a WebSocket, so the desktop app can attach terminals that
execute there. It is not part of the app process and does not run unless you
deploy and start it.

### Authentication

Every connection presents a pre-shared token as a WebSocket subprotocol offer
(`token.<TOKEN>`) rather than a `?token=` query parameter, which would land in
proxy logs and shell history. The comparison is constant-time. Language-server
connections, which CodeMirror can only open by URL, use a **single-use ephemeral
token** minted over the already-authenticated main socket and expiring in 30
seconds — the pre-shared secret never reaches a URL. The launch parameters are
fixed at mint time, so a socket client cannot inject a command of its own.

### Confinement

The server is started with a `--workspace` root and every file operation is
confined to it by the same code path the desktop app uses (section 2) — the only
difference is that the root set is that single directory instead of your open
projects.

### Transport — read this before exposing a server

The server binds `0.0.0.0` and defaults to **plaintext `ws://`**. The token
authenticates but does not encrypt, and a token that reaches an eavesdropper is
shell access on that box.

- **Behind Tailscale, a VPN, or an SSH tunnel**, plaintext is fine — the tunnel
  provides the encryption. This is the intended setup and what the in-app deploy
  wizard tells you to use.
- **On a public network, it is not.** Start the server with `--cert <pem>
  --key <pem>` to serve `wss://` and save the remote with a `wss://` URL.

The server prints a warning on startup whenever it is running in plaintext mode,
and the deploy wizard says the same thing at the point where you decide.

Certificates are verified against the **OS trust store**, so a private CA you
install on the client machine works alongside public ones — the ordinary "trust
my own server" flow for a box you control. TLS handshakes are bounded at ten
seconds so idle sockets cannot accumulate.

### Tokens at rest

A deployed server's token is generated on your machine, not the remote, written
there into a file created under `umask 077`, and carried by an install script
that deletes itself once it has run. On the client it goes into the **OS
keychain**; the saved-connection list in `localStorage` is persisted with the
token stripped out, and any plaintext token left behind by a pre-1.0 build is
migrated into the keychain and removed on startup.

---

## 10. The MCP Server

Spacron can expose an MCP server on loopback so agent CLIs can drive it. Two
independent gates gate every request:

1. **No `Origin` header.** MCP CLI clients never send one; browsers always do.
   Rejecting any request that carries one is what defeats DNS rebinding, where a
   hostile page re-resolves its own domain to `127.0.0.1` to become same-origin
   with the server.
2. **A matching token**, from `?token=` (for SSE, which cannot set headers) or
   `Authorization: Bearer`, compared in constant time. This is what stops a local
   process that can reach the port but cannot read your config — another account
   on a shared machine.

The token is persisted under the config directory and created **owner-only**
(`0o600` on Unix; on Windows the config directory's DACL is already scoped to
your profile). A token file left world-readable by a pre-1.0 build is tightened
in place on first read.

There is deliberately **no "write raw bytes to a PTY" tool.** Every tool that
puts text into an agent goes through the delivery path that submits it, because
a raw write lands unsubmitted in a TUI's composer.

---

## 11. Auditing a Release

Everything in this section runs in CI on every push and pull request (the
`security` job in `.github/workflows/build.yml`), so the normal case is that it
is already green before a release. The commands are here so they can be run
locally, and so the parts that CI *cannot* check have somewhere to live.

### Automated — enforced by CI

| Check | Command | Fails on |
|---|---|---|
| JS/TS dependencies | `npm audit --omit=dev --audit-level=high` | any high/critical advisory in shipped deps |
| Rust dependencies | `cargo audit --deny warnings` (from `src-tauri/`) | any advisory — vulnerability, unmaintained, unsound, or yanked |
| Licences & crate bans | `cargo deny check` (from `src-tauri/`) | a copyleft licence, an unknown licence, or a crate from an unvetted source |
| Types | `npm run check` | — |
| Tests | `npm test`, `cargo test` | — |

`cargo audit` runs with `--deny warnings` rather than the default, so a crate
merely going unmaintained trips the build. The already-triaged exceptions live in
`src-tauri/.cargo/audit.toml`, each with the reason it cannot be fixed from here.
**An advisory is only allowed onto that list if it is reached transitively and no
available version bump resolves it** — anything we depend on directly gets
migrated instead. Re-triage the list on every Tauri upgrade; most of it is the
GTK3 stack and disappears when wry moves to GTK4.

`cargo deny check` exists mainly for licences: Spacron ships closed-source under
a paid licence, so a GPL/AGPL crate entering the tree is a legal problem, not
just a style one. The policy is in `src-tauri/deny.toml`.

### Manual — the parts tooling cannot answer

Run these when the surface they cover has changed, and at minimum before a
release that touches the backend.

1. **The IPC boundary.** `lib.rs` exposes ~216 commands through
   `generate_handler!`. For each one added or changed since the last release, ask:
   *if the WebView were fully attacker-controlled, what does this let it do?*
   The ones that matter take a path or spawn a process — `file_system`,
   `workspace`, `terminal`/`pty`, `remote_deploy`, `github`, `mcp`. A new command
   taking a path must go through `require_in_project` (section 2); there is no
   second confinement layer behind it.

2. **`capabilities/default.json`.** Confirm it still grants no `fs:` or `shell:`
   permissions. Tauri plugins being *loaded* is not the same as the frontend
   being able to *call* them, and this file is the only thing keeping that true.

3. **Local listeners.** The app binds several loopback sockets — the MCP server,
   the LSP bridge, the preview proxy, the remote relay, the mobile stream. Each
   new one needs all three of: bound to `127.0.0.1` (never `0.0.0.0`),
   authenticated, and rejecting requests that carry an `Origin` header
   (section 10). The preview proxy is the largest and most exposed of these.

4. **Secrets.** API keys, the GitHub token and remote-workspace tokens all belong
   in the OS keychain, with no plaintext fallback path. Check that no new error
   string or log line carries a token — errors returned to the frontend are
   rendered in the UI.

5. **The update channel.** This is the highest-severity single point in the
   product: whoever holds `TAURI_SIGNING_PRIVATE_KEY` can ship arbitrary code to
   every install. Confirm the key exists only as a GitHub Actions secret, that
   `RELEASE_TOKEN` is fine-grained and scoped to the releases repo alone, and
   that the repo still requires review on `main`.

6. **Secret history.** `gitleaks detect` over the full history, plus
   `gitleaks detect --no-git` on the working tree. Not in CI because it needs the
   full clone; worth a run whenever the release process changes.

### Known accepted risks

- **The GTK3 dependency stack** (Linux only) is unmaintained upstream and cannot
  be replaced until Tauri moves to GTK4. Tracked in `src-tauri/.cargo/audit.toml`.
- **`script-src` trusts `https://www.youtube.com` and `https://s.ytimg.com`.**
  The music panel loads YouTube's IFrame Player API into the app's own document,
  which is the realm that can reach Tauri IPC. This is a deliberate trust
  delegation to Google, not a defect, but it is the only remote origin permitted
  to execute code in the privileged realm — so it belongs on this list rather
  than being invisible.
