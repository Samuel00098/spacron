# Spacron Mobile Companion App — Plan

Status: **PLAN** — nothing implemented. Updated 2026-11-23 with the product
owner's requirements and decisions below. This is the "control Spacron from your
phone" feature (Orca gap #46 in `docs/orca-feature-gap.md`, explicitly deferred
from `docs/mobile-emulator-pane.md`).

## The Goal

A native iPhone and Android app that works like the Orca and T3 Code companions:
pair it with Spacron, then **chat with your agents from the phone** — send
messages, read replies as they stream, get an alert when an agent finishes or
needs you, see what every agent is doing, and change the settings that matter on
the go. Step away from the desk; the work keeps going and the phone keeps you in
the loop.

It must reach **both** places Spacron work runs:

1. **The desktop app on your laptop** (local projects) — the main case.
2. **A remote box** running `spacron-server` (remote workspaces).

Deliberately **not** a full Spacron clone. The desktop stays the primary
surface; the phone is for conversations, alerts, status and quick control.

## Requirements (from the product owner)

- **Send messages** to an agent thread, including follow-ups to a running agent.
- **Receive messages**: see agent replies live, plus the thread history.
- **Alerts**: a phone notification when an agent finishes a turn, asks a
  question / needs approval, or fails — also when the app is closed.
- **Useful information**: which agents are working / done / blocked, task
  progress (the plan checklist), the project and branch, usage limits, recent
  automation runs.
- **Settings**: paired computers and boxes, which alerts to get, default agent
  and model for new threads, sign out / unpair.
- **Connect to the local one**: pair with the desktop app on the laptop, not
  only with a remote box.

## Decisions (made 2026-11-23)

| Question | Decision | Why |
|---|---|---|
| App type | **Native app: Expo / React Native** for iOS and Android | Real alerts even when the app is closed, QR pairing with the camera, keychain storage. Publishing needs an Apple developer account ($99/yr) and Google Play ($25 once); development builds run on a phone before that. |
| How the phone reaches the laptop | **Same Wi-Fi, plus Tailscale for anywhere** | Works on home/office Wi-Fi with no setup; away from it, the user installs Tailscale (free) on laptop and phone and the same pairing works over the tailnet. No server of ours in the middle. A hosted relay is out of scope for now. |

## Architecture

### Why the laptop needs a "Phone link" gateway

Chat threads, tasks, agent status, the inbox and settings all live **in the
desktop app** (its stores, e.g. `stores/orchestrator.ts`, `services/orchestrator/inbox.ts`),
not in `spacron-server`. So a phone talking only to `spacron-server` could show
terminals but not conversations. The desktop app therefore hosts a small
**Phone link** endpoint the phone connects to:

- Off by default; turned on in Settings → Phone. Listens on the LAN (and on the
  Tailscale interface when present) on a fixed port.
- Speaks the same framing as the remote protocol (`docs/remote-workspace.md`):
  one authenticated WebSocket, JSON control frames, `token.<TOKEN>` subprotocol,
  constant-time token check.
- Exposes a **mobile API** over that socket, backed by the desktop's own stores:
  - `threads.list`, `thread.history`, `thread.send` (message or follow-up),
    `thread.stop`, `thread.new` (agent + model + project)
  - `agents.status` (the same done/working/blocked data the MCP `list_agents`
    returns), `tasks.list` / plan progress
  - `inbox.list`, `approval.answer` (reply to an agent's question / permission)
  - `usage.limits`, `automations.runs`
  - `settings.get` / `settings.set` (a phone-safe subset only)
  - live `event` frames: new message chunks, status changes, inbox items
- Works whether the active workspace is local or a remote box: the desktop is the
  one place that knows both, so the phone always talks to the desktop when it is
  running.

### When the laptop is off: direct to the box

If the workspace is on a box and the laptop is closed, the phone can connect
**directly to `spacron-server`** (the existing protocol, no new server code):
terminals, box automation runs and their logs. Chat threads on the box need the
thread records the desktop keeps, so a later phase moves the minimum thread
state onto the server (see Phase 5). Until then, the phone shows "Laptop
offline — showing the box's terminals and automations".

### Pairing (QR)

Settings → Phone → **Pair a phone** shows a QR code holding: the laptop's LAN
address(es) and Tailscale name if any, the port, a fresh per-phone token, and the
fingerprint of the Phone link's TLS certificate. The phone scans it, stores the
token in the Keychain / Keystore, and pins the certificate. Each paired phone
gets its own token so it can be revoked alone. Boxes pair the same way from the
remote connection's menu (URL + token).

### Transport security

- **TLS always.** The Phone link generates a self-signed certificate on first
  use; the phone pins its fingerprint from the QR code, so LAN connections are
  encrypted and authenticated without a public CA. Over Tailscale the tailnet
  adds its own encryption on top.
- Tokens live only in the OS keychain on the phone and in the desktop's secret
  store; never in URLs, logs or plain app storage.
- The gateway only accepts the mobile API, never arbitrary `invoke` commands, and
  settings writes are limited to a safe list.

### Alerts (push notifications)

- While the app is open, alerts arrive over the live socket.
- When the app is closed, the **desktop sends the push**: on pairing the phone
  registers its Expo push token with the desktop; when an agent finishes, asks
  for input or fails (the same moments the desktop inbox and Spacron's
  `report_status` already capture), the desktop calls the Expo Push service,
  which delivers through APNs / FCM. No server of ours; the notification text is
  kept short and never includes code or secrets.
- Per-phone alert settings: finished / needs input / failed, quiet hours.
- A box running automations with the laptop off cannot push yet (it has no
  phone registry); that comes with Phase 5.

## The app's screens

- **Home:** paired computers and boxes with live status (connected, laptop
  offline, reconnecting), and a summary — agents working, waiting on you, done.
- **Threads:** list grouped like the desktop sidebar (working, settled), with
  unread dots; tap into a thread.
- **Thread:** messages streaming live, plan checklist at the top, a composer to
  send a message or follow-up, stop button, approve/answer cards when the agent
  asks something.
- **Agents & tasks:** who is doing what, task progress, recent automation runs.
- **Terminal (later):** read-only scrollback first, typing later (xterm.js in a
  webview, reusing the desktop's terminal handling).
- **Settings:** paired devices (add, rename, unpair), alerts, default agent and
  model, appearance (light/dark follows the system), about/version.

## Build order (each phase shippable and testable)

| Phase | What | Depends on | Effort |
|---|---|---|---|
| **1. Phone link + pairing spike** | Desktop gateway (off by default, TLS + per-phone token), QR pairing screen, Expo app that scans it and shows "connected" with the agent status list. Proves LAN + Tailscale connectivity and cert pinning. | — | M |
| **2. Chat** | Threads list, thread view with live streaming replies, send message / follow-up, stop, new thread. | Phase 1 | L |
| **3. Alerts** | Expo push registration, desktop sends pushes on finished / needs input / failed, approve/answer from the phone, per-phone alert settings. | Phase 2 | M |
| **4. Info + settings** | Tasks and plan progress, usage limits, automation runs, phone settings screen, unpair/revoke. | Phase 2 | M |
| **5. Box without the laptop** | Direct-to-box mode (terminals, automation runs); then minimal thread state and a phone registry on `spacron-server` so box chats and box alerts work with the laptop off. | Phases 2–3 | L |
| **6. Store release** | App icons, privacy text, TestFlight and Play internal testing, then public listing. | Phases 1–4 | M |

Phase 1 carries the main risk — **can the phone reliably reach the laptop over
Wi-Fi and Tailscale, with pinned TLS, and reconnect cleanly?** — so it ships as a
small spike before any screen polish.

## Verification

- **Phase 1:** pair over Wi-Fi by QR; then switch the phone to cellular with
  Tailscale on and confirm it reconnects; a wrong token or wrong certificate is
  rejected cleanly (never a hang); unpairing one phone does not affect another.
- **Phase 2:** send a message from the phone and see it in the desktop thread;
  a reply typed on the desktop streams to the phone; airplane-mode toggle mid-reply
  resumes without duplicated text.
- **Phase 3:** with the app closed, an agent finishing produces one notification;
  answering an approval from the phone unblocks the agent on the desktop.

## What this does NOT include (deliberately)

- A full mobile editor or file browser.
- A hosted relay for reaching the laptop from anywhere without Tailscale.
- Camera injection / emulator control (that is the desktop Mobile panel's job,
  the opposite direction).
- Several workspaces open at once on the phone (one active connection at a time,
  like the desktop).

## Relationship to existing docs

- Wire protocol, auth, TLS, reconnect: `docs/remote-workspace.md`.
- Feature comparison with Orca and T3 Code: `docs/orca-and-t3code-features.md`,
  `docs/orca-feature-gap.md` (#46).
- Why the companion was out of scope for the mirror pane:
  `docs/mobile-emulator-pane.md` ("a whole second product"). The mirror pulls a
  phone *into* the desktop; the companion pushes the desktop *onto* the phone.
