# Spacron Remote Workspace — Design

## The Goal

Work from anywhere. The **workspace** (files, terminals, LSP, git, agents) lives on a
remote box you own. The **Spacron app on your laptop is a thin client** that attaches to
it. Open Spacron → connect to remote → your terminal, editor, and agents are now operating
on the remote machine. Close the laptop, reopen from anywhere, reconnect — the workspace is
still there, mid-state.

Same app. The backend just points at the cloud instead of `localhost`.

This is the **interactive remote model** (VS Code Server / Cursor Remote-SSH), *not* the
async cloud-agent model (work in an ephemeral VM, hand back a PR).

---

## Decisions

- **Who provides the box:** You do. Spacron connects to a VPS / cloud VM / home server you
  already own. It does not provision or bill for machines.
- **Sync model:** **Live connection, remote is the source of truth.** Files and processes
  live on the box full-time, so any client that reconnects sees the exact same state — the
  "close laptop, continue anywhere" property. Git stays in the picture as a *durability*
  safety net (commit often so a dead VM doesn't lose work), **not** as the sync mechanism.
- **Networking:** **Tailscale.** Laptop and box join a tailnet; the client reaches the
  daemon at a stable hostname over WSS. No port-forwarding, no exposing the daemon publicly.
  (Fallback for users who won't run Tailscale: tunnel the WS over SSH, `ssh -L`.)

---

## Core Idea: Swappable Transport

Today everything is one process: the frontend talks to the Rust core through a single
chokepoint — Tauri `invoke()` + events.

```
  Frontend ──invoke()──► Tauri command ──► Rust core   (all local, one process)
```

We split on that chokepoint and make the backend pluggable:

```
  Frontend ──► BackendClient ─┬─ LocalTransport  (Tauri invoke/events) ──► in-process core
                              │
                              └─ RemoteTransport (WebSocket + token) ────► spacron-server
                                                                          (headless, on your box)
```

Two new pieces:

- **`BackendClient`** (frontend) — one interface every store/service calls instead of
  `invoke()` directly. Routes to Local or Remote transport based on the active workspace.
  This is the main frontend change: replace scattered `invoke()` calls with `backend.call(...)`.
- **`spacron-server`** (Rust) — a headless binary that reuses the existing command handlers
  but exposes them over the axum WebSocket instead of Tauri IPC. The PTY manager, LSP bridge,
  file ops, search, and fs-watch move here essentially unchanged — they already don't care
  whether the caller is local or remote.

We already have the transport primitives: the backend runs `axum` with WebSockets
(`preview/mod.rs`, the LSP bridge) and uses `tokio-tungstenite` as a WS client.

---

## What Runs Where

**Moves to the remote** (`spacron-server`):

| Subsystem   | Files                              | Notes |
|-------------|------------------------------------|-------|
| Terminal    | `pty/`, `commands/terminal.rs`     | PTY I/O is already a byte stream → pipe over WS. Cleanest case. |
| File ops    | `commands/file_system.rs`          | Paths resolve on the server. |
| File watch  | `commands/fs_watch.rs`             | `notify` runs remotely; events push down the WS. |
| LSP         | `lsp/`                             | Biggest win — language servers run next to the code, no project sync. |
| Search      | `commands/search.rs`               | Runs where the files are. |
| Git/GitHub  | `commands/github.rs`               | The repo lives on the box. |
| Agents      | orchestrator services              | Act on real files; don't need the laptop awake. |

**Stays local** (native UI / OS bits): window & vibrancy, notifications, theme, clipboard,
audio + STT (whisper/parakeet), secrets keychain.

Same split Cursor uses: UI local, dev tools remote.

---

## Auth & transport security

- **Networking boundary:** The server binds `0.0.0.0` (so it's reachable over the
  tailnet — loopback-only would defeat the feature). With plain `ws://` it must never be
  exposed on a public network; the startup warning says so as a reminder.
- **Token:** a **pre-shared token** (same idea as VS Code Server's random key), presented as the
  `token.<TOKEN>` WebSocket subprotocol and validated in constant time — kept out of the URL so it
  can't leak via logs/history. Token must be a valid subprotocol token (alphanumeric / base64url).
- **TLS (`wss://`) — shipped 2026-08-13.** `spacron-server --cert <pem> --key <pem>` serves
  wss:// via tokio-rustls + hyper-util (TlsAcceptor accept loop feeding the
  axum router; see src/remote/mod.rs serve_tls). The desktop relay (`remote_relay.rs`) terminates TLS
  itself and verifies the upstream certificate against the **OS trust store**
  (`rustls-platform-verifier`) — so a self-signed CA works once the operator installs it in
  the client's OS store, and public CAs (Let's Encrypt, Tailscale certs) work with no setup.
  Without `--cert/--key` the server still serves plaintext `ws://` and prints the warning —
  only safe behind Tailscale/VPN. The two transport options are what the "wire is encrypted"
  claim rests on: `wss://` for direct internet exposure, `ws://` for a tailnet/VPN link.

---

## Build Order

1. **Spike — remote PTY.** Headless `spacron-server` serving *only* the PTY over WS, on your
   box behind Tailscale. Get a working remote terminal in the Spacron UI. Proves the two hard
   unknowns: the Rust core runs headless, and the frontend can drive it remotely.
2. **`BackendClient` seam.** Introduce the frontend interface; move file ops + fs-watch behind
   it. File tree now works against the remote.
3. **LSP over the transport.** Highest-value subsystem.
4. **Connection UX.** A "workspaces" concept (local + saved remotes), reconnect logic, status
   indicator.
5. **Agents remote**, then **durability** (auto-commit / git safety net).

Everything hinges on Step 2's `BackendClient` seam. Once that exists, remote is "just another
transport."

---

## Step 1 Scope — Remote PTY Spike

The whole terminal stack consumes exactly one abstraction: `pty-bridge.ts`'s `PtySession`
(`{ id, write, resize, close }` + `onData` / `onExit` / `onReplay` callbacks). Nothing above
it knows it's Tauri `invoke` underneath. So the spike is: **build a second implementation of
that interface that speaks WebSocket, plus a headless server on the other end.** The store,
panes, and ~40 call sites don't change.

### The one backend refactor: decouple `PtySession` from Tauri

`pty/session.rs` hard-codes its subscribers to `tauri::ipc::Channel<Response>`. That's the
only thing tying the PTY core to Tauri. Generalize to sink traits:

```rust
pub trait DataSink: Send + Sync { fn send_data(&self, bytes: &[u8]) -> bool; } // false = dead
pub trait ExitSink: Send + Sync { fn send_exit(&self, code: i32) -> bool; }
// data_subscribers: Vec<Box<dyn DataSink>>, exit_subscribers: Vec<Box<dyn ExitSink>>
```

- Tauri path: a thin `impl DataSink for Channel<Response>` adapter. `commands/terminal.rs`
  just boxes the channels (`Box::new(on_data)`); otherwise untouched.
- WS path: an adapter that pushes onto a `tokio::sync::mpsc` feeding the socket.
- `pty/{manager,shell}.rs` don't change — already transport-agnostic.

### New headless binary: `spacron-server`

Reuses `spacron_lib` (`src-tauri/src/bin/spacron-server.rs` + a `pty_ws` module). Owns its own
`PtyManager` + write rate-limiter, serves one axum WebSocket route `GET /pty`. Args:
`--workspace <root>`, `--port`, `--token` (or `SPACRON_TOKEN`). cwd resolution simplified to
"must be inside `--workspace`".

### Wire protocol (dumb on purpose)

One WS connection, multiplexed by session id. JSON control, **binary** for terminal data
(the throttler already batches — prefix a 4-byte session id, don't base64):

| Direction | Frames |
|---|---|
| client → server | `{type:"create",cols,rows,cwd,shell,env}` · `{type:"write",id,data}` · `{type:"resize",id,cols,rows}` · `{type:"close",id}` · `{type:"attach",id}` · `{type:"list_shells"}` |
| server → client | `{type:"created",id}` · `{type:"exit",id,code}` · `{type:"replay",id}`+binary · `{type:"shells",list}` · **binary** `[id:u32][bytes]` for live data |

- Auth: the client offers `token.<TOKEN>` as a WebSocket **subprotocol**
  (`Sec-WebSocket-Protocol`); the server validates it with a constant-time compare and echoes
  back the non-secret `spacron.v1`. **Not** a `?token=` query param — that leaks the token into
  URLs/logs/history, and the browser WebSocket API can't set an `Authorization` header anyway.
- TLS: the wire is plaintext `ws://` — run behind Tailscale/VPN, which encrypts the link. The
  server prints a plaintext-transport warning on startup. `wss://` is a later hardening step
  (see Security below).

### Frontend: a remote twin of the bridge

- New `src/lib/services/pty-bridge-remote.ts` — same `openPty` / `attachPty` /
  `getAvailableShells` signatures, same `PtySession` shape, backed by a `WebSocket`. The
  "queue live chunks until replay is handed off" logic ports directly.
- `pty-bridge.ts` becomes a facade picking local vs. remote by an active-workspace flag.
  `terminal.ts` keeps importing `openPty` / `attachPty` — zero store changes.
- Dev-only config for the target (URL + token). No workspaces UI yet.

### Out of scope (keep the spike a spike)

File ops, LSP, fs-watch, search, git, agents, workspaces/reconnect UI, TLS, multi-project cwd.
Those are Steps 2–5.

### Verification

Run `spacron-server --workspace ~/repo --port 9000 --token dev` on the box (behind Tailscale),
point the app at `ws://<host>:9000/pty`, open a terminal, run `ls` / `htop`, resize, `exit`.
Success = live output, correct resize reflow, clean exit code — and the local terminal still
works unchanged with the flag off.

---

## Step 2 Scope — File ops + fs-watch (the BackendClient seam)

File ops are request/response (unlike PTY streaming), so the seam is a **generic RPC over the
same WebSocket** plus extracting each command's logic out of its Tauri wrapper. Reuses the Step 1
connection — one socket carries terminals, file ops, and watch events.

### Backend: transport-agnostic file-system core

`commands/file_system.rs` split so every op has a `roots: &[PathBuf]` core function plus a thin
`#[tauri::command]` wrapper. `require_in_project(path, state)` now delegates to
`require_in_roots(path, roots)`; the desktop path passes the open project roots, the server
passes its single `--workspace` root. `commands/fs_watch.rs` grew a reusable `spawn_watch(path,
on_change)` shared by the Tauri command (emits `fs-change`) and the server (pushes `fsChange`).

### Server: generic invoke + watch

New `ClientMsg` variants: `invoke { reqId, cmd, args }` (dispatched to the fs core, returns
`invokeOk`/`invokeErr`), and `start_watch` / `stop_watch` (watchers owned per-connection, dropped
on disconnect; bursts arrive as `{ t: "fsChange", path }`). **Gotcha:** serde snake-cases enum
tags, so the wire names are `start_watch` / `stop_watch`. **Gotcha:** the workspace root must be
`clean_path_buf`'d (strip Windows `\\?\`) to match the cleaned paths the fs core checks —
otherwise every op reads as "outside project".

### Frontend: the seam

- `services/backend.ts` — `backendInvoke<T>(cmd, args)`: routes to the WS when a remote is
  active, else passes through to Tauri `invoke` (identical local behavior). Use it only for
  *workspace* commands (file ops, git, search) — not OS/UI-local or local-app-data commands.
- `pty-bridge-remote.ts` gained `invoke` / `startWatch` / `stopWatch` / `onFsChange` on the
  shared connection, exported as `backendInvokeRemote` etc.
- Migrated by aliasing the import (`backendInvoke as invoke`) in the three files whose every
  `invoke` is a workspace file op: `stores/explorer.ts`, `stores/editor.ts`,
  `utils/projectFiles.ts`. So the file tree + editor read/write follow the remote workspace.

### Deferred (still local, or later steps)

- Orchestrator `.spacron` reads/writes (orchestrator.ts, evolve/memory/recon, agent-rules-file)
  and app-data stores (notes, snippets, tasks, dailyNote) still call Tauri `invoke` directly.
  The `.spacron` ones are project files and should move to `backendInvoke`; app-data stays local.
- The frontend has **no** fs-change consumer today, so the remote watch plumbing is wired but
  unused until a consumer exists.
- Opening a project *by remote path* (so the tree points at the remote root) is Step 4
  (connection UX). Until then, remote file ops are exercised via explicit remote paths.

### Verification (headless)

Node WS smoke test against a running server: `fs_create_dir` → `fs_write_file` → `fs_read_file`
(content match) → `fs_read_dir` (entry present) → `fs_get_file_info` → outside-workspace read
**rejected** → `start_watch` + mutate fires `fsChange` → `fs_delete`. All green. Plus `cargo
check`, `tsc`, and 243 vitest (local path unchanged).

---

## Step 3 Scope — LSP over the transport

Autocomplete's whole value on a remote box is that the language server runs *next to the
code* — no project sync, real types. LSP is a **streaming** JSON-RPC socket, not
request/response, and the desktop app already runs it over its *own* dedicated WebSocket
(`lsp/bridge.rs`), separate from Tauri IPC. So the remote design is a faithful mirror: a
second route on `spacron-server`, `GET /lsp`, reusing the existing `LspServer` + `registry`
unchanged. Cross-platform falls out for free — the same registry resolves `rust-analyzer` /
`gopls` / `typescript-language-server` / `pyright` on whatever OS the box runs, with the
Windows `.cmd`/`.bat` shim handling already in `registry.rs`.

### Backend: second route + two RPCs

- **`GET /lsp`** consumes a single-use ephemeral token and pumps LSP messages between the
  socket and a freshly spawned server (`lsp_pump`, a mirror of `bridge_socket`). The server
  runs with the (workspace-confined) root as its cwd.
- Two request/response commands ride the existing generic `invoke` seam:
  - `lsp_check_server` → probes the **server's** PATH (reuses `commands::lsp::lsp_check_server`),
    so the client checks the machine the code lives on.
  - `lsp_start` → resolves `(root, language)` to a launchable server, confines the root, and
    **mints the ephemeral `/lsp` token**. Returns `{ token, root_uri }`.
- **Why the ephemeral token:** CodeMirror's `WebSocketTransport` only accepts a URL (no
  header/subprotocol hook), so the token has to be in the URL. Exactly as the desktop bridge
  does, `lsp_start` runs over the already-authenticated main socket and hands back a
  throwaway, single-use, 30s-TTL token — the pre-shared workspace secret never lands in a URL.

### Frontend: one resolver, transport-agnostic client

`services/lsp/client.ts` unchanged except at the connection seam:
- `checkServer` now goes through `backendInvoke` (probes remote PATH when a remote is active).
- New `resolveLspConnection(root, lang)` calls `lsp_start` via `backendInvoke` and returns
  `{ uri, rootUri }`. Local → `ws://127.0.0.1:{port}/lsp?token=`; remote → the `/lsp` route
  on the remote target's own host (`new URL(target.url)` with `pathname = '/lsp'`). The
  `LanguageServerClient` / `WebSocketTransport` wiring is otherwise identical.
- `installServer` short-circuits under a remote workspace: the installer streams over Tauri
  channels and would install to the *wrong machine*, so it points the user at their remote
  terminal (Step 1) instead. Auto-install over the transport is deferred.

### Deferred

- Streaming `lsp_install_server` over the transport (currently: install manually in the
  remote terminal).
- `root_uri` for remote is computed from the confined cwd on the server; symlinked workspace
  roots on exotic setups could differ from a client-side guess, but the server value is used.

### Verification

`cargo check` (lib + `spacron-server` bin) and `tsc --noEmit` both clean. End-to-end:
`spacron-server --workspace ~/repo`, point the app at it, open a `.rs`/`.ts` file → completions,
hover, and diagnostics come from the server running on the box; local LSP unchanged with no
remote target set.

---

## Step 4 Scope — Connection UX

Steps 1–3 built the transport; the target was still a single object set from the
devtools console. Step 4 makes it a product: a **"workspaces" model** (Local + a
saved list of remotes), **auto-reconnect**, a **status indicator**, and pointing
the file tree at the **remote root** on connect.

### Frontend: the connection model

`stores/remoteWorkspace.ts` grew from one writable target into a small store:
- `remoteConnections` — a persisted list of `{ id, name, url, token }` (migrates
  the Step 1 spike's single `spacron_remote_workspace` key on first load).
- `activeRemoteId` — which one is live, or null for Local. **Not** persisted: the
  app always boots Local and the user connects explicitly (a box may be offline;
  we don't want a broken half-connected startup).
- `connectionStatus` — `disconnected | connecting | connected | reconnecting |
  error`, published by the socket lifecycle.
- `remoteTarget` is now a **derived** store (was a writable). Every existing
  consumer (backend.ts, pty-bridge(-remote).ts, lsp/client.ts) is unchanged —
  both `get()` and `subscribe()` behave identically.
- `connectRemote(id)` flips `remoteTarget`, dials fail-fast (`ensureRemoteConnected`,
  10s timeout so a down box surfaces an error instead of hanging), then opens the
  remote root. On failure it rolls all the way back to Local. `disconnectRemote()`
  tears the socket down and restores the local project.

### Reconnect: `pty-bridge-remote` owns the lifecycle

The server already keeps PTY sessions + their output buffers alive across a
disconnect (Step 1), so a dropped link is recoverable. `RemotePtyConnection` now:
- On an unexpected socket close, publishes `reconnecting` and **retries with
  exponential backoff** (500 ms → capped 15 s) for as long as the remote stays
  selected. An explicit `close()` (user disconnect) stops the loop → `disconnected`.
- On reconnect, **re-attaches every live session** and **re-arms every fs-watch**
  (server watchers are per-connection and die with the socket).
- **Drops the replay buffer on a reconnect re-attach.** `attach` returns the full
  scrollback (up to 1 MB), which is already painted — re-feeding it would double
  the pane. Live output simply resumes; a brief gap is dropped rather than
  duplicated. (A fresh, first-time attach still replays, as before.)

### Backend: one new command

`workspace_info` (over the generic `invoke` seam) returns `{ root, name }` for the
server's `--workspace`, so the client can open a project pointed at it.

### Open the remote root

`stores/workspace.ts` gained `openRemoteRoot(conn)` / `leaveRemoteRoot()`. A remote
project uses a `remote:<id>` project id and is kept **out of the local project
machinery**: file ops/editor/terminal already route over the seam, so it needs no
local Tauri registration, and its state stays out of localStorage. This is kept
deliberately separate from the local `restoreProjectState` (which does local-only
work: port detection, preview proxy, persisted-pane reattach) rather than threading
remote-awareness through it. Disconnect drops the `remote:` project and restores the
local one that was active before connecting.

### Status indicator

`components/layout/RemoteStatus.tsx` — a StatusBar chip (status dot + active name)
opening a popover to add / edit / remove / pick between Local and saved remotes.

### Deferred

- **Auto-reconnect on startup** ✅ *shipped (opt-in).* Each saved remote carries a
  `reconnectOnStartup` flag (toggled from the RemoteStatus popover; at most one set).
  On boot, `maybeAutoReconnectRemote()` dials the flagged remote so a workspace whose
  agents are still running on the box comes back on its own — "close the laptop, reopen,
  they're still there." Safe because `connectRemote` fails fast (10 s) and rolls back to
  Local if the box is offline, so it can never hang boot or leave a half-connected state.
  It stays **opt-in** (default Local) precisely to honor that original caution.
  *Remaining refinement:* re-linking orchestrator **task↔session** state after a cold
  start — the PTY sessions re-attach and the agents keep running, but the task cards that
  owned them (frontend state lost on close) don't yet re-bind to the re-attached sessions.
- **Preview stays local.** The preview proxy still targets `localhost`; a remote
  dev server isn't proxied yet.
- Multiple simultaneous remote roots / mixing local + remote projects in one
  window — one active workspace at a time.

### Verification

`cargo check` (lib + `spacron-server` bin), `tsc --noEmit`, and 243 vitest all green
(local path unchanged). A headless Node WS smoke test against a running server
confirms `workspace_info` returns the confined root + leaf name, a PTY session
**survives a socket drop and re-attaches** on a fresh socket (the property the
client's auto-reconnect depends on), and an outside-workspace read is still rejected.
End-to-end: add a remote in the StatusBar chip, Connect → the tree/editor/terminal
follow the box's `--workspace`; pull the network → `reconnecting` → restore → live
output resumes; Disconnect → back to the local project.
