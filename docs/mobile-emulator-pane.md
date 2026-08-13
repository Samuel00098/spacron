# Spacron Mobile Emulator Pane — Design

Status: **DESIGN** — approved to plan, nothing implemented yet. Companion to
`docs/orca-feature-gap.md` (#47, the emulator pane, currently marked ✅-but-half-built:
the backend commands exist, the pane does not).

## The Goal

An in-app pane where the user can **run, watch, and interact with Android emulators
(AVDs / tethered devices) and iOS simulators**, plus let **coding agents drive them**
through the existing in-process MCP server — the loop that makes Orca's version a
product: the agent builds, installs, taps through the app, reads logcat, fixes, repeats.

The user chose **full Orca-style parity** (not the minimal screencap-polling cut):
- Android: scrcpy H.264 streaming, WebCodecs decode on a canvas.
- iOS: `serve-sim` (MJPEG stream + native touch injection), macOS-only.
- Agent-drivable via MCP tools.

This is a large feature. It is deliberately built in phases, each independently
shippable and testable, because most of it cannot be tested on Windows (iOS entirely,
scrcpy only with an Android device/AVD) and the phases share almost no code.

---

## Reference — how Orca actually does it

Researched from `stablyai/orca` (MIT, public) `src/main/emulator/` and
`src/renderer/src/components/emulator-pane/`, August 2026.

1. **One `EmulatorBridge`, two backends.** `ios-emulator-backend.ts` +
   `android-emulator-backend.ts` implement the same interface (list/boot/shutdown,
   tap, gesture, type, button, rotate, exec, install, accessibility-tree, logcat).
   The bridge routes each command to the backend that owns the target device.
2. **Per-worktree session registry.** One active emulator per worktree; switching
   back reuses it. Android emulators are kept alive on switch (slow to boot);
   other backends' devices are shut down.
3. **Android display = scrcpy.** Push `scrcpy-server.jar` to the device, run it via
   `app_process`, read the **raw H.264** over an adb tunnel, feed a pub/sub registry
   (caches codec meta + SPS/PPS + current GOP so a late subscriber decodes from a
   keyframe immediately), and decode in the renderer with **WebCodecs `VideoDecoder`**
   onto a `<canvas>`. Input goes through plain `adb shell input` — deliberately NOT
   the scrcpy control socket.
4. **iOS display + input = serve-sim.** Evan Bacon's open-source tool (npm
   `serve-sim`, Swift helper + Node CLI). Captures the simulator framebuffer via
   CoreSimulator, serves **MJPEG at `/stream.mjpeg`**, and injects taps/types/
   gestures/hardware buttons. Orca spawns it detached (`serve-sim --detach` prints
   pid + stream URL), waits for the endpoint, streams MJPEG frames into the renderer
   (an `<img>` per frame), and hides the native Simulator.app via an `open` shim.
5. **Renderer pane.** Device frame (bezel), hardware-button row, toolbar (attach
   target, rotate, install), stream-size reporting, rotation handling, keyboard/paste,
   and an "agent setup guide" layer. Touch input uses **normalized 0–1 coordinates**
   mapped to real pixels via the known screen size.

## What Spacron already has

Do not rebuild any of this — it is live code today:

| Piece | Where | State |
|---|---|---|
| Android command surface | `src-tauri/src/commands/mobile.rs` | ✅ list devices / AVDs, launch AVD, screencap, tap, swipe, key, text (adb); SDK discovery incl. default Android Studio paths |
| iOS command surface | `src-tauri/src/commands/mobile.rs` | ✅ platform-gated list simulators, boot, shutdown, open Simulator.app, view-only screenshot |
| Registration | `src-tauri/src/lib.rs` | ✅ all `mobile_*` commands in `invoke_handler` |
| Toolchain guidance | `src-tauri/src/commands/deps.rs` | ✅ `ANDROID_SDK`, `XCODE` with per-OS install hints, used by `mobile.rs` errors |
| Device-frame CSS | `src/lib/components/preview/PreviewPanel.{tsx,css}` | ✅ `.device-shell`, notch, home button (375px iPhone / 768px iPad) — reusable |
| Room/panel wiring pattern | `src/lib/types/layout.ts`, `zustand/layout.ts`, `AppShell.tsx` | ✅ mechanical (db/containers/toolbox/youtube/env all did it) |
| Agent-facing server | `src-tauri/src/mcp/mod.rs` | ✅ tools/list + tools/call dispatch; adding tools is additive |
| The brain already knows the views | `src/lib/services/orchestrator-brain.ts` | ⚠️ prompt lists `android`/`ios` as navigable views, but they are NOT in `VALID_ACTIVE_VIEWS` — navigating there silently falls back to terminal today |

## The gap (what the phases build)

1. **No frontend pane at all.** The `mobile_*` commands are registered and then
   unused. (There is no `MobilePanel`; a code search finds zero consumers.)
2. **No streaming** — only on-demand `android_screencap` / `ios_screenshot` polling.
3. **No iOS input** — `simctl` cannot inject touches by itself.
4. **No agent access** — the MCP server has no emulator tools.
5. **The `android`/`ios` view names are lies** until a real view is wired.

---

## Decisions

- **The pane is a room** (like preview/editor), reachable via the room dock and
  `navigate { view }` — not a right-drawer tool. An emulator is something you work
  in alongside the terminal and diff, not a summoned utility.
- **One view, not two.** A single `mobile` view with Android / iOS tabs. Keeps the
  view registry smaller; the backend already reports platform availability
  (`mobile_platform`, `ios_available`, `android_check`).
- **Android input stays `adb shell input`** even after scrcpy lands. Orca makes the
  same choice — input via adb works without opening the scrcpy control socket.
- **scrcpy via `raw_stream=true`.** The server option that emits a pure H.264
  elementary stream (no proprietary 12-byte framing, no metadata), so the Rust side
  never implements the scrcpy packet protocol. The cost is losing the control
  socket — irrelevant, since input is adb anyway.
- **Frames travel to the webview over a binary Tauri channel.** Video over
  JSON/base64 would die on throughput; a `Channel<Vec<u8>>` (raw IPC) keeps it fast.
  Spike confirms this before Phase 2 — the alternative is a tiny local WebSocket,
  which the app already knows how to do (LSP bridge, preview proxy).
- **iOS ships only on macOS** and is gated by the existing `ios_available()` check.
  `serve-sim` must be bundled as a sidecar (Node runtime or `bun build --compile`
  single binary) because we are Tauri, not Electron — Orca runs it via
  `ELECTRON_RUN_AS_NODE`, which we do not have.
- **Agent access rides the MCP server**, not a new CLI. Orca built `orca emulator`
  CLI + skills; Spacron's agents already reach tools through `spacron-mcp`, so tools
  are the same feature with no new transport. The Rust MCP server and the emulator
  commands share one process, so tools can call them directly.

## Build order (each phase shippable, testable, reversible)

| Phase | What | Testable on Windows? | Effort |
|---|---|---|---|
| **1. Android interactive pane** | Room wiring + device/AVD picker + live screencap polling + tap/swipe/key/text/rotate/hardware buttons via existing `mobile.rs` | ✅ yes (needs Android SDK + an AVD) | M |
| **2. scrcpy H.264 streaming** | Push/launch scrcpy server, adb tunnel, raw H.264 → binary channel → WebCodecs canvas; replaces Phase 1's polling | ✅ yes (same device) | L |
| **3. MCP emulator tools** | `emulator_list/boot/screenshot/tap/type/button/logcat` for agents | ✅ yes (backend + vitest) | S–M |
| **4. iOS via serve-sim** | Bundle serve-sim sidecar, MJPEG stream pane, touch/gesture injection, hide Simulator.app | ❌ macOS-only | L |

Phase 3 is isolated and can land before or after Phase 2.

---

## Phase 1 — Android interactive pane

### Backend: nothing new required

`commands/mobile.rs` already covers everything Phase 1 needs. One small addition:
`android_rotate` (via `adb shell settings put system user_rotation`) if we want
rotation before Phase 2. Everything else is frontend.

### Frontend

**New files:**
- `src/lib/components/mobile/MobilePanel.tsx` + `MobilePanel.css` — the pane.
- `src/lib/components/mobile/MobilePanelLazy.tsx` — lazy wrapper (pattern: every
  other panel).

**Room wiring (mechanical, 6 edits — follow `db`/`containers` exactly):**
1. `src/lib/types/layout.ts` — add `'mobile'` to `ActiveView`.
2. `src/lib/stores/zustand/layout.ts` — add `'mobile'` to `VALID_ACTIVE_VIEWS`,
   add `mobileVisible` to `LayoutState` + `setActiveView` arm +
   `AuxViewVisibility`-style flag map.
3. `src/lib/stores/layout.ts` — export `toggleMobileVisible`.
4. `src/lib/services/orchestrator/app-context.ts` — add `'mobile'` to
   `NAVIGABLE_VIEWS`.
5. `src/App.tsx` — no change needed (panels render in AppShell).
6. `src/lib/components/layout/AppShell.tsx` — add `'mobile'` to `AuxPanelId`,
   `PANEL_VISIBILITY_KEYS`, `ROOM_TITLES`, `ShellLayoutKeys` selector, and a
   `PanelHost` branch. Dock icon via the existing `Icon`/`DRAWER_TOOL_META` pattern.

**Pane anatomy** (Orca's `emulator-pane` minus the streaming):
- **Toolbar:** platform chip (Android / iOS — iOS tab renders only when
  `ios_available()`), Android device `<select>` (`android_list_devices` +
  `android_list_avds`), launch-AVD button, refresh.
- **Screen:** poll `android_screencap` at ~2–3 fps for the active serial; render the
  JPEG in a phone-frame (reuse `.device-shell` anatomy from PreviewPanel). Map clicks
  to device pixels using the returned `width`/`height` (normalized coords → real px).
  Pointer-down + move = `android_swipe`; click = `android_tap`.
- **Hardware row:** Back (keycode 4), Home (3), Recents (187), rotate, keyboard
  (`android_text`), screenshot.
- **Empty states:** "Android SDK not found" → `deps` missing-message; "no devices"
  → point at AVD creation; iOS on non-mac → the existing "macOS only" error.

**Also fix the lie:** after wiring, the brain's existing `navigate` to `android`/`ios`
should map to `mobile` (update `app-context.ts` synonyms + brain prompt's view list).

### Verification (Phase 1)

- `cargo check`, `tsc --noEmit`, `vitest` (layout + app-context tests).
- Manual on this machine: open Mobile → pick an AVD → launch → watch it boot →
  tap/swipe/keyboard land on the device → rotate → close pane → reopen (state).

---

## Phase 2 — scrcpy H.264 streaming

### Backend: `src-tauri/src/commands/mobile.rs` (or a new `scrcpy.rs`)

1. **Bundle `scrcpy-server.jar`.** Download a pinned release at build time (or check
   it in `src-tauri/resources/`) via Tauri's `resources` config. Verify checksum.
2. **Launch sequence per serial** (the documented scrcpy dance):
   - `adb push scrcpy-server.jar /data/local/tmp/scrcpy-server.jar`
   - `adb reverse localabstract:scrcpy_<SCID> tcp:<local_port>` (host listens,
     device connects back — avoids the forward-race)
   - `adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process /
     com.genymobile.scrcpy.Server <version> scid=<SCID> audio=false control=false
     raw_stream=true max_size=1280`
   - `<version>` must **exactly match** the server jar's version (protocol has no
     compat layer).
3. **Stream.** Accept the device's connection, read the raw H.264, cut into
   Annex-B NAL chunks at frame boundaries (config/keyframe flags matter for the
   decoder), and push `Vec<u8>` frames through a binary `Channel` (spike first, see
   Decisions). Track screen size from `adb shell wm size` for coordinate mapping.
4. **Lifecycle.** One stream per serial; `stop` kills the server (`adb shell` kill
   or `emu kill`), removes the reverse. Keep the emulator itself booted on pane
   close (cheap to reattach), matching Orca.

### Frontend: `MobilePanel` gains a stream path

- Replace polling with a `VideoDecoder` (`codec: 'avc1.…'`, `prefer-hardware`),
  feeding `EncodedVideoChunk`s from the channel and painting `VideoFrame`s to a
  canvas. WebCodecs is supported in **all three** Tauri webviews (WebView2, WKWebView,
  WebKitGTK ≥2.44), so no per-OS fallback needed for a while.
- Keep the Phase 1 polling path as the fallback when scrcpy fails (old adb, jar
  mismatch) — "stream" button vs "mirror" button.
- Input code is unchanged (adb).

### Verification (Phase 2)

`cargo check` + `tsc`. Manual: boot AVD, start stream, expect smooth low-latency
frames (vs polling), tap/swipe still land, rotate updates stream geometry, close
pane and reattach without restarting the stream, unplug device → clean teardown.

---

## Phase 3 — MCP emulator tools

### Backend: `src-tauri/src/mcp/mod.rs` (additive)

New tool definitions + `handle_tool_call` arms, calling the existing
`commands::mobile::*` functions directly (same process, no state to thread):

| Tool | Calls | Notes |
|---|---|---|
| `emulator_list` | `mobile_platform`, `android_check`, `android_list_devices`, `android_list_avds`, `ios_available`, `ios_list_simulators` | one call, both platforms, `available` flags |
| `emulator_boot` | `android_launch_avd` / `ios_boot` | by name/UDID; returns the target serial/UDID |
| `emulator_screenshot` | `android_screencap` / `ios_screenshot` | PNG/JPEG (base64) for the agent to read |
| `emulator_tap` / `emulator_swipe` | `android_tap` / `android_swipe` | **normalized 0–1 coords**, mapped in Rust using the screencap dims — matches Orca's skill convention and keeps agents resolution-independent |
| `emulator_type` | `android_text` | |
| `emulator_button` | `android_key` | names → keycodes (home/back/recents) |
| `emulator_logcat` | new `android_logcat` command | adb logcat tail; Orca ships this as an agent capability, it's cheap |

`emulator_tap` etc. take `serial`/`udid` as an optional explicit target and otherwise
use the **active emulator for the current worktree** — but Phase 3 ships without the
session registry (see below), so for now they require an explicit target and the
frontend tracks "last selected" in the store. Agents will pass the serial/UDID they
got from `emulator_list`.

**Deferred (not this phase):** per-worktree session registry à la Orca
(`emulator-session-registry.ts`). Only matters once agents boot and drive emulators
concurrently, and it needs frontend state to scope. Note it in the pane's store so
the shape isn't painted into a corner (store the active `{platform, target}` per
project, keyed like other persisted project state).

### Frontend: none required, one courtesy

Agents use these tools without any UI. The courtesy is updating the brain's
tool-description docs (`orchestrator-brain.ts`) so an agent *knows* it can drive the
emulator ("build the app, install it on the booted emulator, tap through the flow").

### Verification (Phase 3)

`cargo check`. Unit-test the tool dispatch arms (the file already has a test seam for
`resolve_preset` style pure fns). Manual: point any MCP-connected agent at a booted
AVD, have it list → screenshot → tap. Also confirm `tools/list` shows the new tools
and the vitest suites still pass.

---

## Phase 4 — iOS via serve-sim (macOS only)

### Packaging

- Add `serve-sim` (npm) as a bundled sidecar. On macOS: `bun build --compile` (or
  bundle a node runtime) → a single executable under `src-tauri/resources/serve-sim/`,
  shipped via Tauri `externalBin`/`resources`, spawned by `std::process::Command`.
- Orca's Gatekeeper dance (materializing out of the quarantined bundle) is Electron-
  specific; Tauri sidecars are already handled correctly by the build. The camera-
  injection dylib stays **out of scope** — screenshots/streams don't need it.

### Backend

- `commands/mobile.rs`: `serve_sim_available` (file exists + `--help`), spawn
  `serve-sim --detach -q <udid>` on boot, parse the JSON (pid/port/url), wait for
  `/stream.mjpeg` readiness (retry ~10s, mirroring `serve-sim-endpoint-readiness`),
  stream MJPEG frames (reuse a Rust MJPEG parser — multipart boundary split) over the
  same binary channel. `ios_tap/type/button/rotate` map to
  `serve-sim tap 0.5 0.5 -d <udid>` etc. (`tap` is normalized 0–1, matching Android).
- Multi-touch gestures via serve-sim's WebSocket (`gesture` JSON) — **defer** unless
  the basic verbs prove insufficient.
- Hide the native Simulator window: `serve-sim` already runs the capture headless-ish
  on macOS 14+; if it surfaces, the `open -gj` background trick is a two-line shim.

### Frontend: iOS tab in the pane

Same device-frame + toolbar, fed by MJPEG frames (`<img>` with blob URLs — no
decoder needed, unlike H.264). Input verbs reuse the same normalized-coordinate
mapping and hardware-button row (home/lock/rotate).

### Verification (Phase 4)

macOS machine required: boot a simulator, stream it, tap/type/button land, rotate
works, stream survives pane close/reopen. Windows/Linux: the tab hides behind
`ios_available() === false` and shows the existing macOS-only message.

---

## Security & trust notes

- **adb/scrcpy are local-device tooling, as they already are today.** No new network
  surface: the reverse tunnel is device→localhost; the stream channel is in-process
  Tauri IPC.
- **MCP tools run as the user** on their own machine — same trust boundary as the
  existing `spawn_agent`/file tools. Coordinate inputs are numbers; targets are
  validated against the live device list (no free-form shell).
- `serve-sim` binds loopback only. The stream URL carries no token but is local;
  do not log it.
- The scrcpy server jar is pinned + checksummed at build time.

## What this does NOT include (deliberately)

- **Orca's mobile companion app** (#46, the iOS/Android phone app paired by QR) —
  a whole second product; out of scope here.
- **Camera injection / CoreAnimation debugging** via serve-sim (macOS dylib
  territory).
- **Per-worktree session registry** until concurrent agent use actually needs it
  (Phase 3's store shape keeps the door open).
- **accessibility-tree / install-app tools** (Android `pm install`, `uiautomator
  dump`) — cheap later; not needed for the first agent loop.
