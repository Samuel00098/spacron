# Phone companion: where it lives and what it can reach

Plan doc: `docs/mobile-companion-app.md`. Decisions settled 2026-08-22.

**Location: a new top-level `mobile/` folder in this repo**, with its own
`package.json` + lockfile and no monorepo tooling — the exact pattern `website/`
already uses. This is safe because every desktop-side config is scoped to
`src/**`: `tsconfig.json` `include`, `vitest.config.ts` `test.include`, and the
Vite build. A sibling folder is invisible to `npm run check|test|build`.
Remember to add `mobile/` to `.vercelignore` (the website build sandbox) and the
Expo artifacts (`mobile/.expo/`, `mobile/ios/`, `mobile/android/`) to
`.gitignore`.

**Do not build it as a Tauri mobile target.** `tauri android init` inside
`src-tauri/` would drag the whole desktop frontend and the Rust core (PTY spawn,
LSP, sysinfo) onto the phone, and would edit `Cargo.toml` / `tauri.conf.json` —
the two files the desktop release pipeline depends on (`bundle.externalBin`
sidecar, updater artifacts). High blast radius on a shared tree for no gain.
Expo + `react-native-webview` hosting xterm.js keeps terminal rendering
identical to the desktop with none of that coupling.

**What the phone can actually reach.** The `/pty` WebSocket protocol is
complete: create/attach/write/resize/close/list_shells, sessions survive a
disconnect, `token.<TOKEN>` subprotocol auth, `wss://` via `--cert/--key`. So
terminals need **zero** new server code. Agents/tasks do not — see
[[remote-invoke-seam-gap]]. Treat the plan doc's blanket "no new server code in
Phases 1-3" as true for 1-2 only.

**Copy the protocol client, don't share it.** `services/pty-bridge-remote.ts` is
the reference implementation, but ~half of it exists to route through the
desktop's loopback relay (`remote_relay.rs`) because the WebView's CSP forbids
non-loopback sockets. A native app dials `wss://` directly and needs none of
that. Sharing it would mean npm workspaces and a root-level dependency change;
duplicating the ~200 lines of stable wire protocol is the cheaper trade.

**QR pairing does not exist yet.** The plan doc talks as if the desktop can
render a pairing QR; `RemoteStatus.tsx` and `RemoteSetupWizard.tsx` have no QR
code. That is a small desktop-side task, not something to assume.
