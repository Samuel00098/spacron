# Spacron Mobile Companion App — Plan

Status: **PLAN** — nothing implemented. This is the starting point for the
"control Spacron from your phone" feature (Orca gap #46 in
`docs/orca-feature-gap.md`, explicitly deferred from `docs/mobile-emulator-pane.md`).

## The Goal

An iOS/Android app that attaches to the **same headless `spacron-server`** the
desktop app already connects to, so the workspace on the VPS is reachable from a
phone: watch terminals live, see agent/task status, get a ping when an agent
finishes a turn, and send follow-up instructions. Close the laptop, continue on
the phone — same workspace, mid-state.

Deliberately **not** a full Spacron clone on mobile. The desktop app stays the
primary surface; the phone is for watching and quick follow-ups, with real
terminal interaction as the stretch goal.

## The good news: the protocol already exists

The desktop remote-workspace transport (`docs/remote-workspace.md`) is exactly
what a phone client needs, and it is already shipped:

- `spacron-server` serves `GET /pty` over a **WebSocket** — JSON control frames,
  binary terminal data. One connection multiplexes many sessions; sessions
  **survive a disconnect** for re-attach (the property auto-reconnect depends on).
- Auth is a **pre-shared token** offered as the `token.<TOKEN>` WebSocket
  subprotocol, verified in constant time. No query params, so no token in URLs.
- TLS (`wss://`) is supported via `--cert/--key`; certs verify against the **OS
  trust store**, so public CAs (Let's Encrypt, Tailscale certs) work with zero
  client setup.
- File ops, fs-watch, LSP (`/lsp`), and git/worktree commands ride the same
  socket through the generic `invoke` seam (`ClientMsg::Invoke`).
- The desktop relay (`src-tauri/src/commands/remote_relay.rs`) documents the exact
  connection contract and the CSP/loopback constraints that only apply to the
  desktop webview — a native phone client has no such constraint and can dial the
  remote directly.

A phone app therefore needs **no new server code** — it speaks the same wire
protocol the Windows thin client already speaks. Everything below is client-side.

## What the app is (first cut)

- **Connection screen:** a saved list of remotes (`name`, `wss://` URL, token),
  QR-import (the desktop StatusBar popover can render a QR of the connection),
  and a status indicator (`disconnected | connecting | connected | reconnecting`)
  mirroring the desktop's `RemoteStatus` chip model.
- **Terminal view:** attach to live PTY sessions on the server; render with
  **xterm.js** (runs on mobile webviews; the desktop already uses it, and the
  wire protocol's JSON+binary frames map 1:1 onto it). Scrollback replay on
  attach, live output, basic keyboard. Sending text is a follow-up-grade action.
- **Agents/tasks view:** the orchestrator task list + agent status, and turn-end
  notifications. This is where "phone companion" earns its name — the desktop
  inbox/completion-card logic (`services/orchestrator/inbox.ts`) is the model.
- **Follow-ups:** send a text instruction to a running agent's session.

## Decisions

- **Native shell, webview terminal.** A React Native / Expo (or Flutter) shell
  hosting a webview for xterm.js keeps the terminal work identical to the desktop
  (same xterm, same escape handling) while the app shell stays native (push,
  offline banner, QR camera).
- **Direct connection, not through the desktop relay.** The relay exists because
  the desktop webview's CSP forbids non-loopback sockets. A native app has no
  CSP, so it dials `wss://host:9000/pty` directly with the `token.<TOKEN>`
  subprotocol — simpler and one fewer hop.
- **Reconnect mirrors the desktop:** exponential backoff (500 ms → capped 15 s),
  re-attach every live session on reconnect, drop the replay on a reconnect
  re-attach (it was already painted) — port the logic from
  `services/pty-bridge-remote.ts`.
- **Notifications need a bridge (later phase).** The server is pull-based: it
  cannot push to a sleeping phone. Options, in order of preference:
  1. Keep the socket alive while the app is foregrounded; rely on OS push only
     for the "agent finished" event.
  2. A tiny push relay (FCM/APNs) fed by a server-side hook — new server surface,
     deliberately deferred.
  3. Start with in-app activity + background polling while the socket is down.
- **One remote at a time**, matching the desktop's "one active workspace" rule.

## Build order (each phase shippable and testable)

| Phase | What | Depends on | Effort |
|---|---|---|---|
| **1. Proof of concept** | App connects to `spacron-server` over `wss://` with the token subprotocol; lists sessions (`list_shells`/attach); streams one terminal's output to the screen; sends one line of input. Proves the wire protocol works from mobile. | A running `spacron-server` (dev on the same Wi-Fi, then the VPS) | M |
| **2. Terminal UX** | xterm.js rendering, resize, scrollback, hardware keyboard, reconnect with backoff, connection status chip | Phase 1 | M |
| **3. Agents view + notifications** | Task/agent list from the orchestrator data the desktop persists; turn-end "finished" pings; follow-up input | Phase 1; desktop already emits completion cards (`inbox.ts`) | M–L |
| **4. Push relay (optional)** | FCM/APNs bridge for background notifications | Phase 3 | L |

Phase 1 is the whole risk: **can a phone reliably attach to `spacron-server`
and carry terminal traffic over mobile networks?** That is a small, honest spike
before any product polish.

## Verification (Phase 1)

- Connect to a local dev `spacron-server` from a phone on the same network:
  `ls` / `htop` render, resize reflows, `exit` reports a clean code.
- Same against the real VPS over `wss://` (Tailscale cert or public CA), from
  cellular (not just Wi-Fi): attach, reconnect after the network drops
  (airplane-mode toggle), confirm live output resumes and replay is not doubled.
- Wrong/absent token → clean rejection (matches the server's constant-time
  compare), never a hang.

## Security notes

- The phone holds the pre-shared token; store it in the OS keychain
  (Keychain / Keystore), never plaintext in app storage.
- TLS is mandatory on the phone: refuse `ws://` connections except for a clearly
  marked local-dev mode (same rule the server's startup warning pushes).
- No new server surface in Phases 1–3: the phone is just another authenticated
  client, confined to the `--workspace` root like every other connection.

## What this does NOT include (deliberately)

- A full mobile editor or file browser (the `invoke` seam makes them possible,
  but they are desktop-grade surfaces — later, if at all).
- Camera injection / emulator control (that is the desktop Mobile panel's job,
  opposite direction).
- Multi-remote simultaneous connections.

## Relationship to existing docs

- Wire protocol, auth, TLS, reconnect: `docs/remote-workspace.md`.
- Why the companion was out of scope for the mirror pane:
  `docs/mobile-emulator-pane.md` ("a whole second product").
- Where it sits vs. the mirror feature: the mirror pulls a phone *into* the
  desktop; the companion pushes the desktop *onto* the phone.
