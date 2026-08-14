# Changelog

All notable changes to Spacron will be documented here.


## [v0.9.2] - 2026-08-14

The complaint this release answers is "it's fine when I start, and then after the agents have been running a while everything lags." That turned out not to be one thing degrading, but four independent costs that all happen to grow with how long a workspace has been open — and none of them was in rendering, which is where the symptom pointed. Each session's output buffer was being copied twice per PTY chunk once it reached its cap; the resource poll was walking the whole process table on the window's own message-pump thread, every two seconds, whether or not anyone was looking at it; and the glyph-atlas repaint that recovers from a hidden window was firing on every pane the app holds rather than the handful on screen. All four are measured in the notes below, because a performance claim without a number is a guess. Separately, remote workspaces stopped depending on Tailscale for their encryption: `spacron-server` serves `wss://` when given a cert, and the desktop's relay terminates TLS itself and verifies against the OS trust store. And there is now a runbook for the other way to work remotely — installing the whole app on a cloud VM and remote-desktopping into it — with a provisioning script for Ubuntu.

### Added

- **`wss://` remote workspaces** — `spacron-server --cert <pem> --key <pem>` serves TLS instead of plaintext, so a remote box can be reached over the internet rather than only across a tailnet. Without the pair it still serves `ws://` and still prints the plaintext warning, because that is the right default for a link something else is already encrypting. The client half is the part that could not be skipped: the WebView is CSP-limited to plaintext loopback, so the desktop app relays its WebSocket through a local port, and a **raw byte relay cannot extend past an encrypted link** — it would hand the WebView ciphertext and call it a frame. The relay therefore terminates TLS itself, dialling the upstream with rustls and shovelling decrypted bytes to loopback, which leaves the WebView speaking `ws://127.0.0.1:*` exactly as before. Upstream certificates are verified against the **OS trust store** rather than a bundled root list, so a self-signed CA works the moment the operator installs it on the client machine — the ordinary "trust my own server" flow, and the common case for a box you own — while Let's Encrypt and Tailscale certs work with no setup at all. Three details are load-bearing and none is guessable: relays are keyed by `scheme://host:port` rather than authority, or a `ws://` and a `wss://` remote on the same host would share one relay and one of them would be wrong; the TLS accept loop logs and continues on a failed `accept` instead of propagating, since TLS mode is precisely the mode facing a public network and one bad client must not end the server; and handshakes are bounded at 10 seconds, because a client that connects and then says nothing would otherwise hold a task and an fd forever. rustls' crypto provider is installed explicitly as `ring`, once, process-wide — the dependency graph enables both `ring` and `aws-lc-rs`, and rustls 0.23 responds to that ambiguity by panicking inside `ClientConfig::builder()`.
- **A runbook for running Spacron on a cloud VM** — the other remote model, and the one that needs no thin-client plumbing at all: install the desktop app on a VM, remote-desktop in, and the workspace, terminals, LSP and agents all run there because they are simply running where the app is. `docs/cloud-vm.md` covers both platforms with the trade named — Windows for the least setup (WebView2 is already there, RDP is built in), Ubuntu 22.04 for the cheaper box that also happens to match the platform the Linux builds are tested on — and `scripts/vm-setup-linux.sh` provisions the Ubuntu side in one run: desktop, xrdp, and every runtime dependency the app actually needs. That list is the part worth having written down, since a missing one fails at runtime rather than at install: no `gnome-keyring`/`libsecret` means the secret-service daemon is absent and token storage fails, no `librsvg2` means icons and wallpapers do not render. Both docs say the same thing about exposure: never put 3389 on the internet — Tailscale, or a security group scoped to one address.

### Changed

- **The resource poll slows down when nobody is watching** — a sample is not cheap, and the panel is closed almost all the time. While it is, the only consumers are the titlebar chip and the heavy-load watchdog, neither of which resolves anything at two-second granularity, so the cadence drops to six seconds and returns to two the moment the panel opens. At ~100 ms a sample that is the difference between ~5% of a core burning all day and under 2% — spent competing with the agents for the same machine the panel exists to report on. The timer is a self-rescheduling `setTimeout` rather than an interval, since the cadence is now a value read fresh on each hop, and it re-arms immediately on open or close instead of letting the pending tick run down: without that, closing the panel still spends one more sample at the fast rate and opening it leaves you looking at a reading up to six seconds stale. Opening also samples at once, because opening a panel is a deliberate "tell me now". A skipped tick — the window is hidden — skips the *sample* and keeps the *schedule*; returning early there would have ended the chain and stopped polling for the rest of the session. The one behaviour that genuinely changes is the watchdog: "project under heavy load" needs two consecutive hot samples, so it now arrives ~12 s after load starts rather than ~4 s, which is the right trade for an ambient nudge.
- **The terminal pane stops pulsing while an agent works** — a 2 s brightness-and-saturation animation ran on the whole pane, background included, for as long as the agent was executing. Whatever it added as a status cue it took back as text that never quite settles, and the pane already says what it is doing in the places a status belongs.
- **The remote-connection helpers are imported statically** — they were behind `await import(...)` as if that were splitting a chunk, but two modules in the same graph already import that file statically, so nothing was ever split; all the dynamic form bought was an async hop and a `try` around a module load that cannot fail. The connect path is shorter by exactly that.
- **The bundle-size warning is set where it means something** — Monaco is the largest thing the app ships and cannot be split with `manualChunks`, because its workers are constructed from blob URLs over its own module graph and a vendor chunk breaks that bootstrap. The threshold moves to 800 kB so the warning stops firing on a known, deliberate, irrelevant-for-a-desktop-app size and starts being a signal about genuine regressions again.

### Fixed

- **The output buffer got more expensive the longer a session ran** — every session keeps a 250k-character window of its own output, and the append was `buffer = (buffer + chunk).slice(-MAX)`: two full copies of the entire window per chunk. The PTY layer coalesces at 15 ms or 8 KB, so a busy agent delivers up to ~66 chunks a second, and while the buffer is still filling this is genuinely cheap. Once it reaches the cap — a couple of minutes of a working agent — every later chunk pays the full price, forever, because the window never shrinks back below the cap again. Measured, for one second of streaming output: **0.5 ms with a fresh buffer, 32 ms for a single session at the cap, 184 ms across six sessions at the cap**, all of it on the main thread and ahead of rendering. That is the shape of the "fine at first, then everything lags once the agents have been running a while" report, and it is why nothing looked wrong in a short session. The buffer is now the list of chunks it arrived in: appending pushes and then drops whole chunks that have fallen out of the window, so only the oldest surviving chunk is ever sliced and it is one PTY chunk rather than 250k characters. Two consequences are deliberate. The joined string is memoised until the next append, and the several polling loops that only compare *growth* — prompt echo, submit confirmation, agent-ready detection, the turn watcher — now read a maintained length instead of joining a quarter-megabyte string to take `.length` of it, which they were doing every 60–120 ms. And the decoded text is handed to the pane's data callback rather than left for it to decode again, since a second stateful `TextDecoder` over every byte of every session bought nothing.
- **A two-second freeze of the whole window, every two seconds** — a plain `#[tauri::command]` runs on the main thread, which on Windows is the window's *message pump*, so blocking work there is not jank but a literal stall of input and painting. `resource_snapshot` enumerates every process on the machine and the frontend polls it for as long as a workspace is open: **~100 ms per call measured on Windows at 347 processes, warm and idle** — a 5% duty cycle of frozen window, which is the constant low-grade stutter this produced even when nothing was wrong. Ordinarily it reads as jank; **after the machine resumes from sleep it does not**, because every process on the box is paging back in off disk at once, the per-process queries block on that I/O, and the poll landing right after a resume can hold the main thread for seconds — exactly when the user has come back and is trying to scroll. It now runs on the async runtime, so a slow sample costs a late reading instead of a frozen app. The four `project_state` commands moved for the same reason and had been missed for the same reason: all four touch the disk, and `project_state_clear`'s `remove_dir_all` is the obvious candidate for a stall. Narrowing the process refresh to just CPU and memory looks like the cheaper fix and is not one — measured at the same 347 processes it was 116 ms against 101 ms for the full refresh, because the cost is walking the process table at all, not the per-process extras; it is recorded in the code so it is not re-attempted without re-measuring.
- **Returning to the window repainted every pane the app holds, not the ones on screen** — WebView2's GPU scheduler can evict canvas textures while the window is hidden, so panes flush their glyph atlas and repaint when the window comes back, twice, 80 ms apart. Every pane stays mounted for the whole life of its session and the ones not on stage are hidden with `visibility` at full size — panes behind the Home overlay, panes belonging to a project you switched away from — so a busy workspace holds far more panes than it shows, and all of them were repainting, in the first 80 ms after the window returned: precisely the moment the user is trying to interact again. Panes now check they are actually on screen first, with a `getComputedStyle` fallback for WebKitGTK below 17.4, which has no `checkVisibility`. A hidden pane loses nothing by skipping it, because it is repainted by the resize pass that fires whenever it is shown — with one exception that had to be closed by hand: Home layers *over* the still-mounted workspace, so closing it puts every pane back on screen without changing a single box, no ResizeObserver fires, and nothing else in the layout is keyed on it. That path now emits the resize notification itself.

## [v0.9.1] - 2026-08-13

v0.9.0 shipped a mobile pane that mirrors a live Android emulator, and it worked — it just never felt live. The cause turned out to be the transport rather than anything in the app: every frame was being compressed by the *guest's* software H.264 encoder, because an emulator has no hardware one, and that encoder is the whole bottleneck. This release stops using it. The Android Emulator already runs a gRPC Emulator Controller in the **host** process, which reads the screen without the guest encoding anything at all, and moving the emulator path onto it takes the p90 frame gap from 272 ms to 46 ms. The tail is what read as broken; the average never was. Resolution stopped being a constant in the same move — the pane now asks for the pixels it can actually paint — and physical phones stopped inheriting a budget that only ever applied to emulators. Elsewhere, the right utility drawer became project-scoped, so a tool you opened over one project is no longer open over the next.

### Changed

- **The Android emulator's screen comes from the host now** — same AVD, same scene, same 15-second window: 7.1 fps and a 272 ms p90 frame gap over scrcpy, against 28.0 fps and 46 ms over the emulator's own gRPC endpoint. The guest's software encoder is skipped entirely, which is why the gain is this size and why no amount of tuning on the old path could have found it. Frames arrive as PNG rather than raw pixels — that costs ~7% of the frame rate for 9x less data (81 KB against 683 KB a frame), which is what keeps the existing base64 Tauri channel viable and makes the whole WebCodecs, Annex-B-versus-AVCC decoder layer unnecessary on this path; the frontend decodes with `createImageBitmap` and paints. `seq` is load-bearing there: `createImageBitmap` is async, so two frames can finish out of order and the stale one has to be dropped rather than drawn over the newer one, and the bitmaps are closed by hand because they hold pixels off-heap and leak about a megabyte a frame if they aren't. No new crates — gRPC is HTTP/2 with a five-byte length prefix, and `reqwest` was already a direct dependency; tonic would have added a `protoc` build requirement and forced vendoring a `.proto` that ships next to the user's own emulator. Discovery is a per-emulator ini file the running process writes, carrying the port and a bearer token that works directly over an insecure local channel. **Nothing about the pane or the MCP tools changed**: the backend picks the transport, and a device with no reachable endpoint — a physical phone, an older emulator, gRPC switched off — falls through to scrcpy exactly as before rather than failing.
- **Taps go over the same endpoint as the frames** — this is the part that makes the transport switch safe rather than a trade. v0.9.0's input win came from scrcpy's control socket, and an emulator on the gRPC path has no scrcpy server and therefore no control socket at all, so taps would have quietly reverted to `adb shell input` at 600–1300 ms each: four times the frame rate and fifty times the input latency is not an upgrade. The emulator serves `sendTouch` and `sendKey` on the same port with the same token, so input rides the transport that is already open. Two differences from the control socket are load-bearing and neither is guessable. Coordinates are **device pixels** rather than frame coordinates — scrcpy sends the frame size and lets the device scale, while here the frame is whatever box the emulator downscaled to, so the scaling is ours; and `wm size` keeps reporting the physical *portrait* size after a rotation, so a landscape frame has to be scaled against swapped dimensions or every tap in landscape lands somewhere else entirely. Keys are **w3c key names**, not Android keycodes — `keyCode` is interpreted as USB, evdev or XKB, none of which is Android's numbering — so the panel's keycodes map to the names the emulator's own proto documents for the phone buttons (`GoHome`, `GoBack`, `AppSwitch`, `Power`), and a keycode with no known name reports itself unhandled and takes the adb path rather than pressing an approximation of the key you asked for. The device's pixel size is resolved once when the stream starts rather than on the first touch, so that touch pays gRPC latency instead of an adb round trip. Every step degrades rather than fails: no gRPC stream, an unmapped key or a rejected call all fall through to the control socket and then to adb, so input gets slower and never stops working. Field numbers throughout were read from the `emulator_controller.proto` that ships beside the user's own emulator, and verified by sending real events to a running one — synthetic round-trip tests would pass just as happily with the wrong numbers.
- **Stream resolution is measured, not assumed** — 720 on the long side was pixel-perfect in a default-width drawer on a standard display and visibly soft on a Retina Mac, where the same CSS box is twice the real pixels; a fixed number is wrong for somebody either way. The request is now derived from the stage's own size times the device pixel ratio (capped at 2, past which the pixels are beyond what the eye resolves at this size but the encoder cost is real and quadratic), clamped to 480–1024. 1024 is the ceiling because it is the last measured point that still comfortably beats the old path — 15.2 fps and a 65 ms median against scrcpy's 7.1 and 125 ms — while being sharp on HiDPI; past it the frame rate falls away faster than the sharpness is worth. Three things are easy to get wrong here and are deliberate: the **stage** is measured rather than the device shell, which is content-sized until a frame gives it an aspect ratio and so reads as garbage before the stream starts; the long side is bounded by the stage's **width** as well as its height, since a portrait device in a narrow drawer is width-limited and its rendered height never reaches the full stage; and the number is computed at stream **start** only, because re-negotiating mid-drag would restart the stream on every frame of a drawer resize.
- **Physical devices are off the emulator's budget** — 720 was a software-encoder ceiling applied to everything with a screen. A real phone has a hardware H.264 encoder and streams 1080p without effort, so it had been losing clarity to a constraint that never applied to it. The scrcpy default is now chosen by device kind — 1080 for real hardware, and the measured 720 only for the fallback case of an emulator whose gRPC endpoint could not be reached — and an explicit request from the panel outranks both, because that request is derived from pixels the panel can actually display.

- **The stage stops painting a surface when there is nothing on it** — with every room minimized to a chip, the stage still has to render at full size, because it holds every hidden pane; what it must not do is keep drawing a frosted slab with a border and a shadow over the user's wallpaper. An empty frame framing nothing is the one state where the panel treatment has nothing to justify it.
- **The mobile pane says which AVD it was tuned for** — the stream and the tap mapping are developed and tested against Android Studio's default phone, so the picker says so, rather than leaving someone to infer it from a tablet AVD behaving oddly. Shown only when there is an AVD picker to act on.

### Fixed

- **The resource monitor was measuring the wrong memory on Windows** — sysinfo's `memory()` is `WorkingSetSize`, and that is wrong for this panel twice over. Working sets **include shared pages**, so summing a session's process tree counts the same physical memory once per process in it; and a working set is only what is resident *right now*, so an idle agent that has been paged out reads as almost nothing. That second half is precisely the trap already on record — orphaned Codex trees showing ~0 MB while very much still costing the machine. Windows now reports private commit (`PrivateUsage`, the same number Task Manager's "Commit size" column shows) and everything else keeps RSS, because `virtual_memory()` on Linux and macOS is the virtual address space — tens of gigabytes for an idle process — and using it there would be far more wrong than what it fixes on Windows.
- **Session CPU was on a different scale from the chip beside it** — `Process::cpu_usage()` ends in `* nb_cpus` on every platform, so a process saturating one core of a 12-thread machine reports 100, not 8.3, while `global_cpu_usage()` behind the titlebar chip is a plain 0–100 average. The two were being drawn with the same bars and judged against the same warn and critical thresholds, so one busy agent could paint a row critical red on a machine that was 92% idle. Per-process figures are now divided by the CPU count before they leave the backend, so a row and the chip mean the same thing. The core count is published alongside, because a share of the whole machine is the right default but hides whether 8% is one core pinned or eight idling — the tooltip converts it back to core-equivalents.
- **A recycled PID could wedge the monitor** — Windows reuses process ids, and a recycled pid whose recorded parent is one of its own descendants closes a loop in the parent→child map, so the tree walk never terminates. It holds the sampler's mutex while it spins, which turns a wrong reading into a hung monitor. The walk now refuses to visit a pid twice.
- **The RAM gauge cried wolf** — the machine-wide RAM gauge was using the *CPU* thresholds, 70 and 90, so an ordinary desktop sitting at 82% painted critical red all day and taught you to ignore the one colour that is supposed to mean something. An OS that leaves RAM unused is wasting it; pressure starts when what is *left* runs out. It warns at 85% and goes critical at 95% — at 85% of 16 GB there is about 2.4 GB free, which is where an agent spawning a toolchain starts to hurt. A project's *share* of RAM keeps its own separate thresholds, because 40% of the machine is a lot for one project and unremarkable as a total.
- **A tool opened over one project was still open over the next** — the right utility drawer was app-global state, so switching projects carried Toolbox, HTTP, DB, Containers, Env or Mobile across with you. Only *some* of the six leaked, which is why the bug looked intermittent: three of them happened to be saved per project already and three were not. Adding the missing booleans one at a time is the obvious fix and the wrong one — `env` carries two flags that have to move together, and one of them is not part of the persisted layout shape at all — so a project now stores the tool's **name**, and `rightDrawerToolOf` is the single definition of which tool is showing, read by the drawer itself and by the save path alike so a tool can never be persisted as closed while the drawer still paints it. Restore goes through a separate action that deliberately leaves `activeView` alone: the click handler moves the stage to the tool's room, which is right for a click and wrong for a project switch, where the stage comes from the project's own saved arrangement. It applies unconditionally on the cold-start path too, so a project with no saved state lands with the drawer closed rather than inheriting the last one's. Persisted names are validated against the known tool list, so a hand-edited project entry cannot push an arbitrary string into the drawer.

## [v0.9.0] - 2026-08-13

Spacron could already run a fleet of agents. This release is about knowing what they are doing, what they are spending, and what they are costing the machine underneath them — three questions that were previously answered by guessing. Live rate-limit gauges, read from each CLI's own usage endpoint, say *why an agent stopped*; a Stats tab reads the token ledgers those CLIs leave on disk and says *what the work cost*; and a titlebar CPU/RAM chip says *which project is eating the machine*, summing each session's whole process tree rather than the shell you can see. Agents also became manageable rather than merely launchable: several logins per CLI without ever copying a credential, a Yolo/Manual permission mode per agent, one-click sign-in, and install links for the roster's ~40 CLIs. A new mobile pane streams a live Android emulator over an in-process scrcpy client, and an iOS simulator on Apple Silicon. Offline speech-to-text, which had never once run on a machine that didn't happen to have ONNX Runtime on its loader path, now fetches the runtime it needs.

### Added

- **Rate-limit meters — the answer to "why did my agent stop?"** — a titlebar counter and popover showing each signed-in CLI's quota, read from the same authenticated endpoint the CLI's own `/status` screen renders. Every endpoint was verified live before the code was written, because they disagree in ways that silently invert a meter: Anthropic reports `utilization`, OpenAI `used_percent`, xAI `creditUsagePercent` — all *used* — while Google reports `remainingFraction`, which is *remaining*, so a full tank arrives as `1` and reading it as used renders it exhausted. It is converted at the boundary so one thing means one thing everywhere. Reset instants are ISO-8601 for three providers and unix seconds for the fourth. Credentials are read and never written: rotation belongs to the CLI that owns the file, and two processes racing one rotating refresh token logs you out of your own CLI. Gemini is the single deliberate exception — its tokens last an hour, so expiry is the normal case, and its installed-app refresh tokens are reusable rather than rotating; the minted token lives in memory for one request and is never written back. `NotInstalled`, `SignedOut`, `Expired`, `Unsupported`, `Error` and `Ok` stay six distinct states, because an empty bar meaning "we couldn't check" is worse than no bar at all. Nine providers report live numbers; three more are detection-only, and say so.
- **Stats — what the tokens actually cost** — a Settings tab that scans the session transcripts six CLIs leave on disk (Claude, Codex, OpenCode, Pi, OMP, Command Code) into one provider-keyed ledger: daily totals, model and project breakdowns, cache-reuse rate and an estimated cost. The counting rules are the fiddly part. Repeated rows for one turn are max-merged into the first sighting rather than summed as deltas, which over-counts. Each dedupe key is owned by exactly one file per scan, because forks copy turns between files and both would otherwise be counted; when a file that owned keys disappears, the files that deferred to it re-parse to reclaim. Per-file fingerprints decide reuse, and a changed or deleted file's old contribution is subtracted exactly, or a re-claimed fork double-counts. Cost is `null` rather than `0` when nothing on the ledger is priced, since a confident zero is a lie. Droid and Kimi were checked and carry no token data at all.
- **Agent activity: spawned, time worked, turns completed** — the third figure on that tab, and a recorder rather than a scanner: Spacron persists no history of its agent sessions, so there is nothing on disk to derive it from. The webview reports two events and Rust keeps the totals. Spawn is counted at the one point every agent passes through, whether it came from the picker or was adopted after you typed `claude` into a shell — it fires more than once per session, so a dedupe set keyed by session id keeps it honest. A turn is counted where the turn watcher already resolves one, so it is measured rather than estimated, and an *aborted* watch is deliberately not recorded, since its elapsed time measures how long the watch lived rather than how long the agent worked. Orca's fourth card is "PRs created"; Spacron opens no pull requests anywhere, so that card could only ever render 0 and turns replaced it.
- **A resource monitor in the titlebar** — `CPU% · RAM%` in tabular digits with a live session count, opening a panel that groups every terminal and agent by project with per-project CPU, RAM share and disk footprint. The load-bearing detail: the PTY child is the *shell*, and the agent runs inside it, so sampling the session's own pid reads ~0% for an agent at full tilt. Each row therefore sums a whole process tree built from a parent→child map. CPU percentages are deltas between refreshes, so one persistent sampler outlives the calls — a fresh instance per call reports garbage — and the first poll returns no CPU figure at all, because a baseline needs one refresh to exist. A watchdog toasts once per episode when a project crosses 30% of machine RAM or the CPU equivalent, debounced to two consecutive hot polls so a newly spawned process's one-poll spike can't raise a false alarm. Bulk actions: per-project **Close all** behind a four-second inline confirm, and a **Clear exited** sweep.
- **Several logins per CLI** — switch between accounts for Claude Code and Codex from the usage panel. The obvious implementation is to copy one credential file aside and another in, and it is wrong in the most damaging way available: a copy that loses a race with the CLI's own token refresh logs you out of an account you never touched. Instead a managed account is a whole config directory under Spacron's app data, relocated by the environment variable each CLI already honours, and *the CLI writes its own credential there* during a login you perform. Spacron creates an empty directory, sets one variable at spawn, and reads. The account in your home directory is never touched — it appears as a reserved `default` entry that a managed directory is explicitly forbidden from shadowing. Only those two CLIs qualify: the others have no config-dir override honoured *at login*, and one that reads the variable but writes to `~` anyway would silently overwrite your default account.
- **A mobile pane with a live emulator** — Android streams through an in-process scrcpy client that pushes raw H.264 to a WebCodecs decoder on a canvas, with input over scrcpy's control socket at ~23 ms end-to-end, against 600–2100 ms for `adb shell input tap`. iOS streams MJPEG from a `serve-sim` sidecar on Apple Silicon, with tap, type, button and rotate. Both fall back to ~1 s screencap polling automatically, and a frame-recency watchdog deliberately does not kill a silent stream on silence alone — Android encoders go quiet on a static screen — but probes for the device and only tears down when it is genuinely gone. Stream resolution is capped at 720px on the long side because measurement showed emulators have no hardware H.264 *encoder*: the software encoder is bound by pixel rate, so a smaller frame buys frame rate while bit rate buys nothing at all. Throughput peaked at ~0.48 Mbps against scrcpy's 8 Mbps cap; bandwidth is never the constraint here.
- **Yolo or Manual, per agent** — a global default plus a per-agent override, resolved against the preset's launch command so `npx claude`, `claude --resume` and a custom `claude --foo` all land on the same row. Env-only CLIs like Goose get theirs through the environment, which must be set at PTY creation rather than injected later.
- **One-click sign-in, and somewhere to go when a CLI isn't installed** — the roster lists ~40 CLIs and a typical machine has a handful, so "Not installed" is the most common row in that pane and it used to be a dead end: a grey badge naming a tool with no hint of where it came from. Each of the 22 install links was fetched and answered on 2026-08-12, not assembled from a vendor name; anything without a verified home falls through to a web search, and the button says which it is — **How to install** versus **Find install steps** — because a wrong URL sends someone to a parked domain while calling it the install page. Sign-in is offered only where credentials are provably missing; keychain and API-key CLIs report "unknown" rather than "signed out", and offering to sign those in would launch a CLI that is probably already signed in.
- **Agent logos for CLIs we don't bundle** — 30 bundled marks, then a favicon lookup for anything else, then a letter glyph. The lookup treats a 404 as a miss, and also catches the 16×16 globe placeholder that comes back as a 200 on some domains, since accepting it paints a globe on the tile instead of falling through. The request host is fixed and the only user-derived input is a bare alphanumeric slug.
- **An agent inbox behind the notifications** — a queue so a finished agent can't be missed by looking away. **Read and dismissed are two separate bits**, and conflating them re-breaks the feature: dismissed drops a card from the floating stack and is set by the 10s auto-clear timer, while read is set only by a deliberate act — closing a card by hand, clicking the row, "Mark all read", or acting on a mailbox card. The auto-dismiss timer must never mark read, because that timer firing is precisely the "user was looking elsewhere" case the inbox exists for. It stores read/dismissed ids and no message content: the mailbox log and completion cards are already the sources of truth, and a third copy would drift.
- **A per-worktree review pane** — the fleet cards can list an agent's changed files, but a card is a summary; this is where the work gets read. Master-detail, diffed against the commit the worktree forked from so committed and uncommitted work appear together — the question is "has the main checkout seen this?", not "what is staged over there?". The diff is read-only, because partial staging of someone else's finished work has no meaning. Merge and Discard close the pane; Bring in leaves it open, since the worktree still holds the work.
- **Tasks got a real board** — priority, due date, notes and durable ordering, native drag and drop between columns, and an editor modal that writes straight to the store so nothing is left unsaved. All fields are optional, so an existing `tasks.json` loads unchanged. The signature link is **Run with agent**: pick one of the project's dispatchable agents and the task's title and notes become its goal, and the card moves to In Progress. Assignee was deliberately skipped — the fleet has no concept of a user.
- **A shareable usage card** — your stats drawn to a canvas as a 480×300 image. Orca rasterises a React node with `html-to-image`; that would add a dependency for one card, and it is the fragile kind — it inlines computed styles and re-fetches every font and image through the page's CSP. This draws the same card with the 2D context: no dependency, no style cloning, and identical output on every platform because nothing about it touches the DOM.
- **The window opens maximized the first time it ever runs**, and remembers that it has.

### Changed

- **Refresh buttons are gone; the panels are simply live** — four surfaces lost a manual Refresh or Rescan in favour of a shared ticker showing a pulsing dot and a countdown. Cadences are matched to the cost of the work behind them: the usage panel every 2 minutes while open (15 minutes for the background dock), the resource panel every 2 seconds for readings but only every 60 seconds for the disk walk, the Stats tab every 60 seconds, guarded against firing while the window is hidden or a scan is already in flight. The Stats tick also runs once on mount, chained onto the first load rather than fired beside it — the `enabled` flag only arrives with that load — because without it the tab opened on figures up to a minute stale. The ticker's dot is a state-carrying loop, so it is on the reduced-motion allowlist and slows rather than freezing.
- **The focus rail's cards are the real panes, not pictures of them** — the rail used to draw ~250 lines of mock-ups: a fake terminal, a fake editor, a fake browser. It now shrinks the actual mounted pane into each card, which is possible because Focus and Split already re-flow the same mounted panes by swapping CSS. There is never a second copy of a room, and there cannot be: the terminal store holds one data callback per session id, so a second pane for one session hijacks the live feed on mount. Two constraints follow and both are easy to undo by accident — no pane may change DOM position (React would `insertBefore`, detaching the node and losing the xterm's WebGL context), and the panel is *scaled*, never reflowed, since a reflow would refit the terminal to card width and resize the PTY.
- **Panels are tinted, with a light traveling their edge** — you could not tell where one panel ended and the next began. The tint settles a panel's field and the light settles its edge; removing either leaves the other doing half a job. Both are defined once, in the one stylesheet that reaches both the shell's rooms and the surfaces mounted as siblings of it — the first pass lived in the shell's own CSS and silently missed every floating panel. The titlebar takes the tint at about half weight, because a full-strength tint across the whole window against a wallpaper reads as a heavy black band.
- **The standing brief reaches nearly every CLI now** — agents that read a rules file receive their guardrails in a file rather than through a paste, and the file is now the one each CLI actually reads: `GEMINI.md` for Gemini, which ignores `AGENTS.md` entirely, plus `CONVENTIONS.md` for aider, `.continue/rules/` for cn and `.kiro/steering/` for kiro-cli, where those are the *only* files the CLI reads. Cursor, Copilot, hermes, goose and cline get a second surface on top of the universal three. Which agents read what was established by scanning each program's own bytes and by testing, not from documentation — it is what catches Grok, Cursor and Codex, none of which mention rules files in their help. Only two presets are still on the paste channel, both verified to read no file at all.
- **Closing a session closes what was running inside it** — `kill()` terminates the direct child only, and on Windows `TerminateProcess` never touches the child's children, so closing a terminal left the agent running inside that shell as an orphan. Close now walks the whole tree, leaves first, with a self-pid guard. This also fires on a natural shell exit, so backgrounded children die on Windows too — intentional, and consistent with closing meaning closed.
- **Disk scans are confined to registered projects** — the disk-usage command accepted any path. Unscoped, it is an arbitrary recursive walk: `C:\` hangs a poll for minutes, a size answers little more than "does this path exist", and its TTL cache, keyed by the caller's own string, grows without bound. Roots outside a known project are now dropped from the response rather than scanned or reported as `0`, so the panel can distinguish "not measured" from "empty". The panel only ever sent project roots, so nothing legitimate changes.
- **Unmaximizing sizes the window to your monitor** — restoring from maximized now lands at 65% of the work area's width and 85% of its height, centred, computed in logical pixels from the current monitor rather than from a remembered pixel size that may have come from a different display.
- **`dompurify` moved to 3.4.13 and `nanoid` is pinned forward** past their advisories.

### Fixed

- **Offline speech-to-text had never actually run** — the ONNX dependency is built with `load-dynamic`, which enables `disable-linking`, which makes its build script return immediately: nothing in the build produces an ONNX Runtime library, on any platform, not in `target/`, not beside the binary, not in a bundle. So Parakeet was dead everywhere, dev included, unless the host happened to have the runtime on its loader path — and it did not fail politely, because the library load ends in an `expect`, so the first touch of any ONNX API *panicked*. `load-dynamic` still earns its place: it is what avoids an Abseil static-link failure on Linux. The library is now fetched at runtime from Microsoft's official release, verified against the SHA-256 digests GitHub's release API publishes, and lands beside the Parakeet weights. Not bundled, for the same reason the weights aren't: the feature already needs a ~600 MB download before it does anything, and an installer carrying tens of megabytes of runtime for everyone who never enables it buys nothing. When there is no library, the failure is an ordinary error naming the file and the paths searched, and the panic line is never reached. The comment on the dependency claiming the default features still fetched and copied a dylib was wrong, and is corrected in place.
- **The Android live stream had never worked either** — the pane had always silently fallen back to ~1 s screencap mirroring, because of five independent bugs, each sufficient on its own: the stream id was sent in decimal where the server parses hex, the codec id was compared against `0` rather than its fourcc, the dummy-byte handshake was disabled on one side only, Annex-B chunks were fed to a decoder configured for AVCC, and a per-start stream id let one start tear down its own successor. All five are fixed and verified in the running app.
- **Design Mode sent a screenshot and a twenty-character label** — both inspector scripts already collected `outerHTML`, computed styles, attributes, classes and the page URL, and the formatter threw all of it away, emitting something like `<button.primary> "Save"`. The agent got a picture of the element and almost no text. There are two inspector scripts — one injected by the preview proxy, one injected into the iframe as a fallback — and a field only one of them sends is a prompt that silently changes shape depending on which page you are on, so both now send the same nine computed styles and the same attribute map.
- **The Yolo/Manual toggle flipped the row you clicked** — clicking the already-active segment was treated as "unpin", which moved the row to the *opposite* mode: pressing **Yolo** on a row showing Yolo left it on Manual, which is indistinguishable from a broken control. The clicked segment now always ends up active. Unpinning still happens, it just rides on the mode that is already global — choosing the global mode clears the override rather than writing one that merely restates it, which keeps the "some agents customized" note honest and lets a later flip of the global toggle still move that row.
- **Tooltips froze at whatever they said on first hover** — suppressing the native OS tooltip means moving `title` into a data attribute, and the hook read that cache before the live attribute. So a button whose label depends on state never updated — the dock's Focus and Split buttons swap their tooltip when active — and renaming a room left the old name in place until a full reload.
- **Floating panels drifted, rubber-banded and outgrew themselves** — which reads as the panel being dragged or resized. Every popover is now a rigid frame with exactly one scroller: `overflow: hidden` and `touch-action: pan-y` on the frame, pinned header and footer, and `min-height: 0` on the body. That last part is load-bearing — the spawn picker's hard `min-height: 200px` could not shrink, so on a short window it pushed the footer, Spawn button included, out through the card's own clip.

## [v0.8.1] - 2026-08-07

This release is mostly about how Spacron looks and moves. The theme system was rebuilt around one wallpaper set and a single accent per appearance mode instead of six unrelated hues, surfaces stopped sliding around when they appear, and a long list of transition defects — the white flash on every stage switch, the old tiling ghosting over the new one, panels leaving residue, the card deck rendering flat — turned out to have five distinct causes and are fixed at each. Split absorbed Fleet and now tiles up to twelve rooms instead of exactly two, with the arrangement remembered per project. The terminal stopped following light/dark, because a TUI asks what colour the background is exactly once and can never be told the answer changed. GitHub is reachable by signing in rather than by pasting a token, agents are told plainly that a task handed to them is theirs to do, and startup dropped ~2.7 MB that was being loaded for a command most sessions never run.

### Added

- **Sign in with GitHub instead of pasting a token** — the clone dialog and the publish form now offer OAuth device flow, plus a one-click import of an existing `gh` CLI session. Device flow rather than the redirect flow for two reasons that both follow from shipping a closed-source binary: no client secret can ship in an `.exe` anybody can unpack, and the loopback-PKCE alternative would open another listening socket. The token lands in the same OS keychain entry the PAT path always used, so the git layer is untouched — it reaches git through `GIT_CONFIG_*` headers and never transits `.git/config`, argv or a process listing. Scopes are exactly `repo read:user workflow`; `workflow` is there because this app spawns agents that edit CI files, and without it such a push fails with an error that never mentions scopes. PAT entry stays reachable under Advanced, since an org that gates third-party OAuth apps leaves its repos silently invisible until an owner approves, and GitHub Enterprise Server can't use the app at all.
- **Clone from GitHub** — a home-screen action and dialog. URL parsing is strict: github.com only, and it rejects other hosts, deep links, traversal in the repo name, and option lookalikes. Public clones need no token at all. A partial clone is cleaned up so a retry isn't blocked by the debris of the last one.
- **Split tiles up to twelve rooms** — Split held `[primary | secondary]`, where the second was derived and drifted whenever the primary changed. It is now an explicit ordered slot list, which removes the drift at its source and lifts the two-pane cap in the same move: add, remove and reorder panes by slot number, wrapping past three, with equal rows and a 180px floor so a short window scrolls rather than crushing the terminals. Past six panes the grid switches to an auto-fill track. Each room header gains a promote-to-Focus button, which finally wires up a function that had been written and never called.
- **Tile all agents is a toggle** — pressing it used to gather every agent with no way back except rearranging the stage by hand. It now snapshots the ambient, the slots and the focused room on the way in and restores them on the second press. Only the button toggles: the orchestrator and restored workspace layouts send the same request, and a command meaning "show me all agents" must not mean "hide them" on the next call.
- **Each project remembers its own tiling** — the ambient was already per-project, but the slot list and the primary room were plain component state, so switching projects carried the previous project's arrangement across instead of restoring the one you left. Both now travel through the layout bus and into the project autosave, which also covers the case a restart is actually meant to cover: rearranging panes and then quitting.
- **Agent branches are swept** — removing a worktree deliberately keeps its branch, because until you commit that branch is the only durable copy of the agent's work. Nothing ever came back for them: 157 had accumulated in this checkout, 156 of them holding zero commits, since an agent that never commits leaves a branch pointing at its fork. The sweep deletes only branches git itself lists under `--merged`, guarded by the `spacron/` prefix and a skip list of every branch a live session or task still claims, measured against HEAD *and* main/master so it doesn't silently stop working on a feature branch. Branches whose work landed by patch rather than merge come back reported as retained and are never auto-deleted, since a patch applied with `--3way` and then edited no longer matches.
- **Ten dual-mode wallpaper pairs** — cloudtops, arch hall, coastline, library, conservatory, terrace, oasis, zen garden, alpine meadow and reading room, each as a day and a night render, WebP at 1672×941.

### Changed

- **One wallpaper set and one accent per mode** — every preset used to carry its own hue, so the app's identity changed with the picture behind it. All presets now share a single indigo accent per appearance mode, pitched for its own background; dark mode keeps a deeper fill because the lifted dark accent cannot carry white label text at 4.5:1. The bundled Forge Dark/Light themes and the pre-theme CSS defaults move onto the same two accents, with a v3 brand migration so themes already on disk follow — the chain now carries a theme amber → teal → grey → indigo in one pass. Replacing 31 wallpapers with the new renders also took ~17 MB of assets down to ~560 KB.
- **Surfaces no longer travel when they appear** — 32 entry and exit keyframes across 18 files lose their translate and scale and keep only the fade, along with the Stage Manager view transition and the `@starting-style` offsets on the room stack and split switcher. Spinners, loaders and ambient motion are untouched. Things that slide in from somewhere read as a demo; things that simply arrive read as an app.
- **The terminal is always dark, and never follows the theme** — a TUI asks "what colour is your background?" exactly once, over OSC 11, at launch, and then paints its own surface from the answer. It is a separate process, and there is no signal that means "you were told light, it is dark now, please re-theme". So while the answer tracked app mode, a TUI launched in light mode kept its white surface forever, including after a switch to dark, where it became a glaring white slab. That is not a styling bug to chase; it is a one-shot negotiation that already concluded. The whole palette moves together — background, foreground and the ANSI slots — because the xterm surface is transparent, so reporting dark while leaving the foreground light-tuned puts ordinary shell output dark-on-dark. A dark preset still colours the semantic and syntax slots, so each wallpaper keeps its character.
- **Fleet is an arrangement, not a mode** — its only differences from Split were automatic membership and a wrapping grid, and Split does both now. The old mode identifier is still accepted, because persisted layouts and orchestrator ambient commands still send it.
- **~2.7 MB moved off the startup path** — chasing a 1.69 MB "editor" chunk turned up prettier, not the CodeMirror grammars: the formatter statically imported prettier plus all seven parser plugins, and a chain of ordinary imports pulled that into every session for a command most never run. Formatting was already async and only fires on an explicit action, so nothing needed it early. Prettier and only the parsers the file at hand needs are now dynamic, taking that chunk from 1,690 kB to 10 kB. The grammars were a real problem too, just a different one: `manualChunks` swept every `@codemirror/*` into one vendor chunk, so lazy-loading them alone would have achieved nothing. Both halves are fixed, and each grammar now gets its own chunk.
- **An agent's task is the agent's to do** — the standing brief described only *how* to delegate, so agents read it as encouragement and handed off work the user meant them to do. Both channels of the brief now lead with the task being yours, and allow delegation in exactly two cases: the user asked, or an orchestrator role was assigned. The case that actually happens — an agent handed a perfectly clear task deciding on its own that it is big enough to fan out — is named directly, including when the agent is convinced parallelising would be faster, and "begin immediately" is called out by name since an agent looking for licence to spawn would otherwise find it there.
- **Custom backgrounds are images, and yours outranks the theme's** — two code paths could own the background and both ran at boot with no ordering between them, so every theme apply, including the one at startup, silently replaced a background you had chosen. Both now ask the same question. Video wallpapers are removed: a looping 2560×1440 video holds the GPU awake for a whole session on top of the panels' own backdrop blur, which is the least premium thing the app could do on a machine someone is compiling on. The picker takes png/jpg/jpeg/webp/avif — svg is an active document format aimed at the app's own chrome, and heic/heif/tiff/ico/bmp decode inconsistently enough that users reported the failures as bugs. A wallpaper stored by an older version is detected and cleared rather than handed to `background-image`, which renders nothing and reads as "my wallpaper vanished".
- **Text contrast fixed for the themes that ship** — the light and dark text ramps are pinned in CSS under a wallpaper class, so with no wallpaper — Forge Dark and Forge Light, which is what ships — nothing overrode the older washed-out values, and the bundled themes looked flat next to every preset. Both ramps now run from a true endpoint, and the lower steps come up with them: muted was the worst offender at about 3.2:1 in both modes, under the 4.5:1 body text needs, which is what read as "greyed out".
- **Remote-workspace tokens live in the OS keychain** — the token unlocks a shell on a remote box and was being kept in localStorage alongside the connection list. It moves to the keychain, read into session memory only and never written back.
- **CI is pinned and validates its own tag** — every GitHub Action is pinned to a full commit SHA rather than a mutable tag, so a compromise of an action's repository cannot change what the release workflow runs. The release tag is validated against a strict semver pattern before it reaches a shell, and it crosses into bash only through an environment variable, never by interpolation — the job holding it also holds the release token and the updater signing key.
- **Git status is read with `-z`** — the default porcelain format runs paths through git's quoting, which wraps anything containing a space in double quotes. Those quotes are part of the output, not the filename, and they travelled into `git add -- <path>` as part of the pathspec and matched nothing, so a file with a space in its name could not be staged.

### Removed

- **Import Theme and the Custom Theme Editor** — both wrote into a backend list no picker renders, so anything created or imported became unreachable the moment you switched to a preset, and neither could set a wallpaper.
- **The last of the Canvas feature** — the view was already gone, but Alt+=, Alt+- and Alt+0 were still bound to canvas zoom actions nothing handled, still listed under a Canvas group in the shortcut map, and still parsed by the orchestrator, which reported success for a zoom that never happened. Since shortcut defaults merge additively, deleting them would have left them in every existing install forever, so retired ids are now pruned on load.
- **Video wallpapers**, per the background change above.

### Fixed

- **WebGL painted black slabs behind dim and underlined text** — xterm's WebGL glyph atlas rasterises any cell carrying an extended attribute (dim, italic, underline, strikethrough) onto a tile pre-filled with the background colour, and against an alpha-0 surface that tile is opaque black. Agent statuslines use dim on nearly every line, so a WebGL pane came out striped. Measured at xterm 5.5.0 and addon-webgl 0.18.0: plain, bold and colour-only runs stay transparent, all four attributed ones slab, on WebGL only. Upstream is no escape — 6.0.0 drops transparency for the whole surface instead. So WebGL gets an opaque surface, the only configuration in which it renders correctly. The RGB is unchanged, so the background a TUI negotiates is identical; only the glass is traded away, and only for someone who explicitly chose WebGL. Canvas and DOM are untouched.
- **Merge silently merged nothing and announced that it had** — `git merge` sees only commits, and the merge path never snapshotted the worktree first, so for an agent that hadn't committed — the normal state mid-task — the merge was a no-op. Three failures then stacked: the "did nothing" check read stderr, but git prints "Already up to date." to stdout, so the backend reported success; the Fleet card toasted "Merged X into Y" on success alone, a green notification firing precisely when the press had no effect; and the merge-and-clean-up callers took that success as licence to force-remove the worktree and delete the branch still holding the agent's work. Merge now snapshots onto the agent's branch first, and callers check whether anything actually moved before saying so. Bring in had the smaller version of the same bug and now says "Nothing new to bring in" quietly.
- **The flash of light on every view transition** — the View Transitions UA stylesheet blends both snapshots with `plus-lighter`, which is additive and only correct while the two opacities sum to 1 at every instant. Every custom pair here broke that in one direction or the other: the root pair summed to about 1.55 from first frame to last, and an additive blend of two nearly-opaque copies of the whole screen is a bright wash over everything for the duration — including on a stage switch that changes nothing. The generic morph pair ran two different durations and eases against each other and summed to about 0.7 through the middle, which is a panel going see-through halfway through its own move; the stage pair drifted a few percent under and flickered wallpaper through the frosted stage on every room change. All are on one clock now, and the deliberate partial fade opts out of the additive blend rather than fighting it.
- **The old tiling ghosted over the new one** — opening a panel while in Split re-tiles the stage, and the View Transition API freezes a bitmap of the *old* arrangement and stretches it into each new cell while it cross-fades, so the previous tiling sat visibly over panels that had already moved. Retiles now update directly; plain focus changes keep the transition, since they move nothing and so have no bitmap to stretch.
- **Panes held stale, wrongly-fitted pixels after a layout change** — the resize notification fired synchronously against a view transition's update callback, which runs asynchronously, so the measurement regularly read the *old* DOM and each pane refit to the size it was leaving. Switching modes had its own version: panes snap to final geometry on the first frame, but each terminal only re-measured through a debounced observer and only flushed its glyph atlas at the end of a 360ms settle window, leaving about 400ms of previous-layout pixels actively redrawn from a stale atlas.
- **Entering Split left ghosted panels, jumped sideways, and gave the tiles no entrance** — five separate causes. The stage panel entrance was keyed to mount, but stage panels are never unmounted, so it fired once in the app's life and Split had to blank it. `animation-fill-mode: both` pinned opacity for an element's whole life, so the transition beside it could never run — which also silently killed the card deck's depth ladder, leaving the pile flat. Off-stage panes are full-stage boxes over the tiles and `visibility: hidden` is overridable by any descendant, so they are clipped as well. Only Focus was inset from the drawer, so the stage lurched 16px on every switch. And the gutter gap animated on a faster tier than the panels, so it kept creeping after the move looked finished.
- **A Split pane click flashed, and the label was wrong** — clicking the pill for a pane that is already tiled ran a full-document view transition for a change that moves nothing; every pane is on screen either way, and the frosted surfaces and live terminal canvases don't survive that round trip cleanly, so a change you can't see arrived as a flash you can. The label was misleading for the same reason: "focused" on a pane that is fully visible, so it says "primary", matching what the code has always called it.
- **The card deck's motion never played** — the deck drives opacity, scale and translate for its depth cue, its hover pop and the fan that moves following cards aside, and none of the three was transitioned, so every one of them snapped.
- **Two command palette entries did nothing** — "Go to Settings" and "Customize Theme…" both set a view that nothing reads, because Settings is a modal. Both now open it, and "Customize Theme…" deep-links the section that actually holds the theme picker.
- **Primary buttons had near-black labels** — `.nf-btn.primary` paired the accent with a contrast token no theme defines.

## [v0.7.5] - 2026-08-04

Spacron could already put a fleet of agents to work in isolated worktrees; this release is about judging what they produced — and about letting an agent run the fleet itself. A new Agent Changes view puts every agent's diff on one screen with merge and discard per agent, the review surface gained hunk- and line-level staging, and language-server problems collect into a Problems panel instead of being visible only in the file you happen to have open. Agents are now asked *where* to run before they start rather than inheriting a toggle, Claude Code reports its own turn endings instead of being watched through its screen, and a long list of unreachable UI has been taken out. An agent in a pane can now delegate work to workers it spawns, wait for their reports and send them back for another round — over a set of cross-agent tools that no CLI had ever actually been able to reach, because the transport serving them was answering on the wrong connection.

### Added

- **An agent can run a team of agents** — three MCP tools turn a CLI agent in a pane into an orchestrator: `delegate_task` hands a piece of work to a brand-new worker and returns its report, `bounce_task` sends that worker back with specific fixes and waits for the redone work, and `check_task` resumes a wait that returned early. Each worker is a real pane on its own git branch, so you can watch it, steer it mid-flight and review its diff — none of which is possible for an agent's own in-process sub-agents, which is why those kept being reached for and kept running invisibly. Completion is a file the worker writes (`.spacron/reports/<name>.md`) rather than an inference from terminal silence: deterministic, carrying a real summary instead of redraw noise, and needing no per-CLI turn detection, so any agent that can write a file can be a worker. Spacron deliberately does not drive the iteration — the agent already has a loop; what it lacked was reliable tools and truthful state. A wait returns `working` with a handle after 25 seconds by default rather than holding a connection open indefinitely.
- **The orchestration protocol ships with the app** — a new Orchestrator role writes a full protocol to `.spacron/orchestrator-brief.md` and points the agent at it, with the same body offered to Claude Code as a native `orchestrate-fleet` skill. Every rule in it exists because its absence is a repeatable failure: workers get disjoint file ownership because two on one file clobber each other silently; a deterministic check decides *done* because an LLM reviewing an LLM does not converge on taste alone, and self-correction without external feedback can make output worse (Huang et al., ICLR 2024); rounds are capped and stagnation escalates, because a loop that ends quietly is invisible. It is a file rather than a pasted charter for a mechanical reason — a long multi-line paste does not commit reliably into Ink-based REPLs, which is why the per-role briefs are one line each, and a 70-line protocol cannot go through that channel at all. Orchestrator is a role conferred by a prompt, never an agent type, so a Codex can orchestrate Claude Code workers or the reverse.
- **Every agent is told where its sub-work belongs** — the standing brief handed to each launched agent gained a delegation rule: in-process sub-agents are fine for read-only research, work that writes code goes through `delegate_task` (or `spawn_agent` + `send_to_agent`), and never by launching a CLI from a shell. An agent that finds those tools missing is told to say so rather than fall back silently.
- **Drop a file onto a terminal pane** — dragging a file from the OS file manager, or from Spacron's own explorer, onto an agent's pane types its path in as input. Drops landing on the floating prompt bar still belong to the bar, so the two never fight over the same gesture.
- **Agent Changes — every agent's work on one screen** — reviewing a fleet used to mean visiting each agent's room, reading its terminal, then switching to Source Control, which is scoped to the open project rather than to that agent's worktree, and repeating for the next one. The new view (Ctrl+Shift+G) gives one card per agent: live turn status, its branch, `+N/−M` against the commit it forked from, and its changed files expanding into a diff viewer pointed at that agent's worktree. Merge and discard act on real git state, so each asks for confirmation naming the branch, and discard refuses outright while the agent's session is still alive.
- **Stage individual hunks and lines** — the review panel now shows a file's diff with per-hunk and per-line staging controls, replacing the older whole-file sidebar. Staging works by synthesising a patch containing only the parts you picked and handing it to `git apply --cached`, so partial staging composes across turns and across agents. The same diff surface serves both your own changes and an agent's, since it takes a repository path rather than assuming the open project.
- **Problems panel** — diagnostics from the running language servers now collect into one list, grouped by file, with counts and click-to-jump. Previously the editor consumed `publishDiagnostics` privately as inline markers, so a problem existed only while you were looking at the file that had it. Servers report on documents they've been told about, so this lists files opened this session rather than a cold whole-project analysis — the empty state says so rather than implying the project is clean.
- **Spacron asks where each agent should run** — spawning now opens a placement dialog instead of relying on an isolation toggle you had to remember to set. The question is asked per agent, so a batch can be mixed: one in the main repo, the rest in their own worktrees. Saying it in the prompt works too — "open two agents in the main repo", "isolate them" — and phrasing that only ambiguously refers to placement ("fix the failing test on the main branch") deliberately falls through to the dialog rather than being guessed at, since an agent silently editing your real working tree is the damaging direction and a miss only costs one click.
- **Agents report their own turn endings** — for CLIs that support hooks (Claude Code today), Spacron launches the agent with a session-scoped settings file containing `Stop` and `Notification` hooks that append a nonce-carrying line to a private channel. Turn ends are then facts rather than inferences. The screen-scraping path remains for everything else, but it is brittle per-CLI and per-version: a missed phrase left an agent stuck until an idle fallback false-completed it and released the lease, losing the real answer, and a quiet compile looked like completion. Nothing is written into your repo or your global agent config, which matters when several agents share one working tree.
- **Custom agents are asked whether they read a rules file** — adding a custom agent used to present a "reads a rules file" checkbox you had to know the answer to, and guessing wrong is silent: a CLI that ignores `AGENTS.md`/`CLAUDE.md` simply never receives its brief. Spacron now checks, in two passes — `<exe> --help`, then a scan of the program's own bytes for the filenames, which is what catches Grok, Cursor and Codex, none of which mention rules files in their help. The result pre-fills the checkbox and states its reasoning, and your own tick always wins. The probe runs only the executable (never your arguments), without a shell, resolved on PATH, with stdin closed and a hard timeout.
- **Agents can drive the preview browser** — eight MCP tools (navigate, screenshot, page info, read DOM, console logs, click, type, close) let a CLI agent operate and observe Spacron's embedded preview. The preview panel also gained a native-webview toggle that bypasses embedding restrictions for sites that refuse to be framed.
- **Multi-cursor above and below** — Ctrl+Alt+Up/Down stacks a cursor onto the adjacent line. The geometry is column-based rather than offset-based, so cursors stay visually aligned through indented code and lines of differing length.
- **Preview logins survive a restart** — the preview proxy's cookie jar is now persisted to disk, so a site you signed into inside the preview is still signed in next session. Only cookies with a real expiry are written; session cookies evaporate on restart, as they do in a browser.
- **Stage Manager effects in the focus sidebar** — overlapping cards with depth-based dimming and hover lift, shrink-out/expand-in transitions via the View Transitions API, and live miniature previews whose size adapts to how many rooms are open, in both light and dark themes.

### Changed

- **Each CLI now gets the MCP config file it actually reads** — Spacron wrote `.mcp.json` and nothing else. That is a Claude Code convention the other CLIs do not read, so every non-Claude agent booted with zero cross-agent tools and no error explaining why. Each one now gets its own file in the transport it actually supports — Claude Code `.mcp.json` over SSE, Codex `~/.codex/config.toml`, Gemini `.gemini/settings.json`, opencode `opencode.json`, droid `~/.factory/mcp.json` and Cursor `.cursor/mcp.json` over streamable HTTP — every format read back off disk after running that CLI's own `mcp add` rather than taken from its docs, which disagree in places (Gemini wants `url` with `type: "http"`, not `httpUrl`). The configs are written on project open too, so an agent you start by typing `codex` yourself finds the server just as one spawned from the picker does. The server now claims a fixed port when it can and remembers its token between runs, which is what makes the two CLIs with global-only config safe to write at all — before, such an entry went stale the moment the app restarted. Every file carrying the token is added to `.git/info/exclude`, so the local server secret cannot be committed into whatever project you opened.
- **Workers spawned over MCP get their own worktree and branch** — an MCP spawn used to land in the main checkout with no task record, no worktree and no file claim, so three workers edited one working tree at once: precisely what the isolation exists to prevent, and it corrupts the loop's own inputs. Isolation is unconditional on this path rather than asking, since the placement dialog needs a user and the request arrives from a background agent process. `list_agents` now reports each agent's branch, so an orchestrator reviews a real `git diff` instead of judging code from scrollback.
- **Messages to an agent are typed and submitted, not written to its PTY** — a raw write puts text in a TUI's composer and never sends Enter, and because it is not a bracketed paste every newline reads as a submit, so a multi-line message (a bounce always has several) sent a fragment and scattered the rest. Both paths now use the readiness-aware delivery that already fixed this for the floating bar: wait for the prompt, paste, let the composer settle, submit, then confirm the agent actually started and retry if it did not. The call waits until the text has landed, so an error means the agent did not receive it rather than that it was merely slow. The initial prompt for a spawned worker went the same way — it was sent on a three-second timer, which a slower-booting CLI simply missed.
- **The spawn tools describe the agents this install really has** — their schemas named `claude`, `codex`, `gemini` and `cursor`, a list that was never accurate: `gemini` is not a preset while `pi`, `agy`, `hermes`, `grok`, `opencode` and `cursor-agent` are, and custom agents were invisible entirely, so an orchestrator could not discover a real agent and had no way to reach one you added yourself. The roster is pushed from the app and connected clients are pinged to re-read the tool list when it changes. Worker names come from the app's own name pool rather than a second list, a generic label like `worker-2` or `claude-1` is replaced with a real name, and a name handed out is reserved until the pane registers, so two delegations milliseconds apart cannot pick the same one.
- **Source Control keeps itself current** — the panel refreshed only when you opened or reloaded it, so an agent committing in the background left it showing a stale tree. It now reacts to filesystem-change events and re-reads every 15 seconds, without the loading spinner, so the update arrives quietly rather than flickering the panel.
- **A URL opened from a terminal brings the preview room forward** — the view switched but the room did not, so on a split layout the page loaded somewhere you could not see.
- **Terminal renderer defaults to canvas** — the previous DOM default rested on a claim that canvas and WebGL ghost against Spacron's transparent background, on the theory that they clear a frame by painting the background over it and so erase nothing when it is fully transparent. Measured at the current xterm and addon versions, that is simply not true: both renderers clear transparent cells to bare wallpaper and survive heavy streaming, alt-screen switches and a DPR-2 resize without residue. Canvas rather than WebGL because a different limit *is* real — a page gets 16 WebGL contexts and silently evicts the oldest past that, and since panes stay mounted for the life of their session a busy workspace would start killing its longest-running agents' contexts. WebGL stays selectable; DOM remains the no-GPU escape hatch.
- **The Cursor preset launches `cursor-agent`** — it previously launched the bare `agent`, which the Grok CLI also installs, so whichever came first on your PATH won. Settings now shows the full command with a note explaining why it isn't the shorter alias. Sessions stored under the old id still resolve.
- **Agent work stages itself, and is never deleted unstaged** — agent changes used to reach Source Control only through a one-shot toast raised at turn end, which lost work in ordinary situations: a completed task is terminal so later turns could never re-raise it, a cleared thread left nobody watching the worktree, and a missed 12-second toast had no recovery path. A git-driven reconciler replaces the event trigger, staging is by patch rather than `git merge --no-commit` (which leaves `MERGE_HEAD` and hard-blocks every later stage until you commit), uncommitted edits are snapshotted onto the agent's own branch first so filesystem-only work is durable, and every removal is gated behind a stage-then-re-read-git check. Anything outstanding appears in a standing Agent changes list in Source Control with a per-agent Stage button and conflict recovery. Both the worktree and auto-stage settings now have controls in the Agents tab, which they were missing.
- **Remote workspaces reach non-loopback hosts** — the remote-workspace WebSocket is opened by the WebView and so is bound by the app's `connect-src`, which lists only loopback. Every documented remote form (a Tailscale host on port 9000) was therefore blocked outright. Rather than widen the policy, the connection is relayed through the backend the same way the HTTP client is: Rust binds an ephemeral loopback listener and shovels bytes to the real host.
- **File operations no longer freeze the window** — every command in the filesystem module did blocking disk I/O on the main thread, where one large read, a recursive copy, or a `remove_dir_all` over `node_modules` locked up the whole window, dragging included, until it finished. They now run on the async runtime, matching the git commands that were moved off the main thread earlier.
- **Agent role picker collapsed, and reviewer charters act on their own** — the four-pill role picker became a compact toggle and dropdown with per-role colours and a remembered selection, Coordinator and Scout joined the spawn list, and the Reviewer charter now runs its own `git diff` and tests rather than waiting to be told.
- **Remote status chip and spawn modal restyled** — both adopt the HUD trigger's design language: glass surface, rim highlight, lift on hover, and a segmented control in place of the old checkbox.

### Removed

- **A large clear-out of unreachable UI** — the dashboard showcase, activity bar, status bar, ambient switcher, theme customizer, notes panel, project and workspace switchers, agent command centre, command block strip, terminal tab, sticky container, agent activity list, voice conversation overlay, the rough-sketch renderer and the daily-note store, along with the separate pilot entry point. Roughly 5,000 lines of components that nothing routed to any more.

### Fixed

- **No agent CLI could connect to the cross-agent server at all** — in the HTTP+SSE transport the two halves of a call travel on different connections: the request arrives on `POST /message`, and the response has to go back down the client's own `GET /sse` stream. Spacron answered in the POST body, which an SSE client never reads, so every agent sat waiting on the stream until it timed out. `claude mcp list` reported a connection timeout; other CLIs surface the same failure as an authentication problem, which sends you hunting through the token code for a bug that was never there. It stayed hidden because probing the two endpoints separately with `curl` shows both perfectly healthy. Responses now go to the stream the requesting client is listening on, the POST returns `202` with no body, a notification gets no reply at all (an unsolicited response is a protocol error to a client), and a second endpoint answers in-body for the CLIs that speak only streamable HTTP. Seven tests drive a real bound server the way a CLI does.
- **A delegated worker was a bare shell wearing an agent's name** — the MCP spawn path created a terminal session directly, which opens a shell and only *records* the agent preset as metadata; the launch command is typed by a separate step it skipped. So the worker showed up as an agent in every list and pane header while its task prompt went to a shell prompt that had no idea what to do with it. The same call also omitted the flag that keeps an agent out of the terminal mosaic, so each worker claimed a cell that could never mount a second view of its session and rendered a dead placeholder. Every launch now goes through the one sequence that does the whole job — rules-file brief, orchestrator brief, display title, MCP flags, detection suppression, typed command — each part of which failed silently when skipped.
- **Window-title sequences were counted as agents finishing** — CLI agents terminate OSC sequences with a BEL, so `\x1b]0;some title\x07` ends in the same byte the turn watcher treats as a completion bell, and setting a title read as ending a turn. The scan compounded it by re-counting the entire session buffer on every poll: that buffer is capped and slides, so each poll started at a different offset, and one landing inside an OSC string turned that string's terminator into a standalone bell that was never rung. Only newly appended output is scanned now, with escape state carried across chunks so a sequence split by a chunk boundary is still read whole.
- **A question from a finished turn kept reporting the agent as blocked** — attention scanning read the tail of the shared session buffer, and agents habitually close a turn with a question ("Would you like me to also run the tests?"). That text sits in the tail long after the turn it belongs to ended, so the next watch matched it on the very first byte of new output and declared the agent blocked on a prompt it was not showing — repeatedly, on the watcher that re-arms for adopted agents. Only output produced since the watch armed is scanned.
- **The completion chime played twice for one completion** — the ending reaches the notifier from two paths, the turn watcher resolving and the CLI process exiting a beat later. The toast layer already dropped the duplicate card, so the chime was the only part that doubled, which is what made the cue feel unreliable rather than merely chatty. Identical cues inside 1.2 seconds now count as one event.
- **A restored agent relaunched against last session's config** — reopening a project relaunches its agent panes, and each CLI's MCP config is now rewritten before its process starts rather than alongside it, so a restored agent never attaches to a file left by a previous run.
- **Reviews approved and rejected the same work at once** — the APPROVED / BOUNCE BACK regexes were unanchored and case-insensitive across the whole transcript, and the reviewer's own charter contains both tokens verbatim. Every review therefore matched its own instructions, auto-merging the branch *and* telling the builder to redo the work. Verdict parsing is now line-anchored, case-sensitive and confined to the tail of the transcript, with tests asserting the charter itself is not a verdict, and a merge is refused unless the approved branch matches the handoff worktree.
- **An agent that committed inside its worktree never surfaced for review** — the check built its `rev-list` range as three separate arguments, so git read the bare `..` as end-of-revisions and the rest as a pathspec. The command always failed, and both callers swallowed the failure into "no changes". A git failure is now treated as "may have changes" rather than hiding work.
- **Committing one agent's work force-deleted the others' branches** — stale-worktree cleanup removed the worktree of every finished task in the project with branch deletion on, so committing a single agent's staged changes destroyed every other finished agent's branch. Removal is now gated on an explicit staged flag, and the post-commit sweep skips worktrees whose agent is still live.
- **Ordinary prompts silently disabled worktree isolation** — the admin-keyword pattern matched bare `tag`, `ship`, `deploy`, `publish` and `release`, so a task like "add an alt tag" turned isolation off without saying so.
- **Agents spawned from the plain picker were invisible to the reconciler** — worktree tracking read only the normal ambient's state, so every agent started into the Development ambient — which is what the Spawn Agents picker uses, the most common way to start one outside the orchestrator — had its changes never staged and its baseline never written back. Both ambients are scanned now.
- **An empty band at the bottom of terminal panes** — declaring ConPTY to xterm makes it stamp an explicit wrapped/not-wrapped state on every line, and ordinary short output is stamped not-wrapped, which disables reflow for it. Shrinking a pane pushed those lines permanently into scrollback and growing it back could not pull them down, leaving dead rows that never fill — measured at six dead rows after a single 46→40→46 cycle, with every transient shrink during a layout settle spending more. ConPTY has emitted proper wrap information natively since Windows build 21376, so the option is now set only below that build, where it is still needed.
- **Terminal repaints stopped throwing away cached glyphs** — entering or leaving a full-screen TUI reassigned the terminal theme purely to force a repaint. The background is identical in both buffers so the assignment changed nothing, but xterm treats any theme write as a theme change and rebuilds the renderer, discarding the glyph atlas on every screen switch. A plain refresh gets the same repaint.
- **Tooltips froze at whatever they said on first hover** — the tooltip layer stashes an element's `title` and reads the stash thereafter, but React re-applies `title` when the prop changes. A live title now wins over the cache, so dock buttons whose label depends on state and rooms that get renamed no longer show stale text until a reload.
- **Opening a file left the editor off stage** — clicking a file in Source Control, the explorer, search results or the Problems panel while another room held the stage played the stage transition and went nowhere, so the only visible result was a flash. Making the editor *visible* is not the same as putting it on stage: the visibility flag only adds the editor to the room list, and the effect meant to focus it could not do the job. It ran off state changes, so re-opening the file that was already active never fired it at all; it assigned room focus directly, which cannot show a minimized room — such a room is absent from the visible set, so focus falls straight back to another one, and it then stays pinned to a room that never reaches the stage, wedging every later attempt too; and it bypassed the guard that stops a room claim from evicting the pane you are working in. Revealing the editor now asks the room system to bring it forward, exactly as a URL opened from a terminal already does for the preview room.
- **The commit message box refilled itself while you were clearing it** — Source Control suggests a message whenever the box is empty, and now that it re-reads on every filesystem change as well as on a 15-second tick, that suggestion landed again the moment you deleted it, before you had typed a word. In a workspace where several agents share one working tree those events arrive more or less continuously, so the box could look like it was reloading on its own. Touching it now claims it for two minutes, during which nothing auto-fills and every keystroke pushes the window out again; if it is still empty when the window lapses, the message that was there is reattached with a note, so an abandoned box ends up holding a usable suggestion rather than nothing.
- **Fetched agent logos are kept across restarts** — the logo cache was memory-only, so every session re-fetched the same icons from the web, and its key used only the launch command, so two agents whose commands normalised to the same slug shared one cache slot and could show each other's logo. The cache is persisted and keyed on both command and name, and stale in-flight entries from a crashed session no longer block fresh fetches forever.
- **A dangling symlink could write outside the project** — the path guards resolve symlinks only when the whole chain exists, so a link pointing at a missing target was invisible to them: the path fell through as a new file, read as inside the project, and the subsequent write or `create_dir_all` followed the link out. Every component of a path is now inspected as a link in its own right and resolved lexically before being confined to the project roots.
- **Logo fetches are guarded like every other outbound request** — the icon-catalogue client followed redirects without re-checking the destination, the one way that path could be steered at a link-local or cloud-metadata address, and filenames taken from the fetched catalogue were spliced into the CDN URL unvalidated. Redirects are now checked on every hop and catalogue names must be plain filename stems.
- **A failed worktree removal is reported instead of swallowed** — `git worktree remove` failures were discarded, so a checkout that survived the call looked successfully removed.
- **Native preview corrections** — bounds were multiplied by the device pixel ratio and then passed as logical units, double-applying the scale factor and so being correct only at 100% DPI; the toggle handed a raw URL to a strict parser and swallowed every failure, making it look dead for `localhost:3000`, bare hostnames and empty tabs; and because the native webview is an OS-level overlay while the preview panel unmounts on view switch, it was left floating above the editor with no way to dismiss it.


## [v0.7.4] - 2026-07-24

Agents running side by side in Spacron can now find and talk to each other, the spawn picker wears each tool's real logo, and the local music player holds more than one folder. Under the hood, agent worktrees moved inside the project, pasted screenshots stop piling up in your repo, and project search no longer freezes the window.

### Added

- **Agents can talk to each other** — Spacron now runs a small in-app server that every agent it launches is pointed at automatically, so a running agent can list the others, read another agent's terminal output, send it a message, or ask for a new agent to be spawned — without you copying anything between windows. Configuration is injected per tool at launch (an environment variable for Claude Code and Aider, a config file for Cursor and Codex CLI, and a generic `SPACRON_MCP_URL` for anything else), and agents register and unregister themselves as their terminals open and close, so the roster always reflects what's actually running.
- **Real logos in the agent spawn picker** — each agent tile now shows its tool's actual brand mark instead of a letter. Known CLIs (Claude, Codex, Gemini, Cursor, Aider, Grok, …) use bundled marks matched by launch command; a custom agent whose command isn't one Spacron ships a mark for has its logo discovered off the web (the dashboard-icons catalogue first, then LobeHub's AI-brand set, then the tool's own site favicon) and cached, falling back to a letter glyph only when nothing is found. Matching is exact-on-slug so a custom agent never grabs an unrelated logo.
- **Multiple folders in the local music library** — the "Local" media source is no longer limited to one folder. Add several, switch between them from a folder menu, and remove ones you no longer want; the active folder's tracks are what plays. Switching folders mid-song keeps the current track playing until you pick something new, and an existing single-folder setup is migrated into the new list automatically.

### Changed

- **Agent worktrees live inside the project** — the isolated checkouts Spacron creates for parallel agents moved from a sibling `.spacron-worktrees/` directory next to the project into `.spacron/worktrees/<branch>` inside it. Terminals, file operations and LSP are all confined to the open project roots, so a worktree outside the project could be created but never actually used; keeping them inside fixes that. They're excluded via `.git/info/exclude` (local-only, never committed) so they stay out of your git status, and the old sibling location is still recognised for cleanup of worktrees created before the move. The remote-workspace server got the same move.
- **Changelog and agent-opened links open in the preview panel** — opening the changelog from inside the app, and URLs an agent asks to open, now load in Spacron's built-in preview browser instead of handing off to your system browser, so they stay in the workspace.
- **Theme names match their backgrounds, and every wallpaper is sharper** — two themes were renamed to describe what you actually see ("Chicago Shoreline" → "Architectural Curves", "Manhattan Skyline Night" → "Cyber Neon Rooftop"), and the entire background set is now served as higher-resolution WebP (the remaining PNGs were removed), so wallpapers look crisper on large and high-DPI displays.
- **Spawn picker and panel surfaces restyled** — the agent spawn picker was rebuilt around logo tiles with a step control that reveals on hover or selection, and the shell's panels now frost their own patch of wallpaper (see-through with a backdrop blur) rather than leaning on a single global wash, so text stays readable without hiding the background.

### Fixed

- **Pasted screenshots stop cluttering your repo** — pasting an image into the prompt used to write it into `<project>/.spacron/paste`, leaving screenshots accumulating inside the working tree. Pasted images now go to an app-owned scratch directory in the OS temp folder (the same way terminal agents like Claude Code and Cursor treat a paste — ephemeral, out of the codebase) and are wiped when the app exits. Images you pick from a file or drag in are unaffected.
- **Project search no longer freezes the window** — searching across a project ran its filesystem walk and file reads on the main thread, so a large search could lock up the UI until it finished. The work now runs off-thread and the window stays responsive.
- **Workspace tools hide on the Home screen** — the switcher, quick-capture, search and settings buttons in the title bar stayed visible over the Home overlay and welcome screen even though they had nothing to act on. They now hide until you're back in a workspace.


## [v0.7.3] - 2026-07-22

Media player search stopped returning a single screen of results.

### Fixed

- **Search returns hundreds of results instead of 20** — every search fetched exactly one page and then cut it off at 24, so a query returned about 20 rows no matter what was available. Search now follows YouTube's continuation tokens the way the site itself does when you scroll, up to 500 results or 25 pages, whichever comes first. In practice a video search returns ~350 and a music search ~430, and searches that run out of results earlier simply stop. Results appear page by page as they arrive, so the first rows show up as fast as they used to and the rest fill in behind them; starting a new search abandons the one in flight rather than letting it finish in the background.
- **Video search no longer dead-ends after two pages** — paging through video results followed the wrong continuation token. Search responses also carry a token per filter chip ("Shorts", "Under 4 minutes", …), and on continuation responses those are emitted before the results list's own token, so following the first one silently re-ran the search as a filtered query and returned rows already seen. The results list's token is now selected explicitly.

### Changed

- **Data API searches take 50 results in one request** — for users who supply their own YouTube Data API key, the page size goes from 24 to the endpoint's maximum of 50. This path deliberately does *not* page like the keyless one: each Data API search costs 100 units of a 10,000/day quota, and paging to the same depth would cut a user to roughly 16 searches a day.


## [v0.7.2] - 2026-07-22

The stream-safe music idea from v0.7.1 is replaced with one that actually holds up: point Spacron at your own folder of royalty-free tracks and it plays them straight off disk. Source control also stops fighting you when you scroll.

### Added

- **Local music library** — the media player gains a third source, "Local", alongside YouTube and YouTube Music. Point it at a folder and Spacron scans it (recursively, capped at 5000 tracks) and plays the files off disk with its own queue, shuffle and repeat. Track and artist names come from filenames. Licence sidecars sitting next to your downloads — certificates, terms, credits — are surfaced in the UI rather than buried, since those are the proof used to clear a Content ID claim. Spacron ships no audio of its own; it is a player, never a distributor.

### Fixed

- **Source control sections scroll in their own space** — Changes and Commits (Graph) shared one scroll container, so a long list of changed files pushed the commit graph out of view and the entire panel scrolled as a single strip. Each section now owns its scroll area and the two divide the panel's height between them, so neither can shove the other off-screen and the section headers stay put while their contents scroll.

### Removed

- **Stream-Safe YouTube preset catalog** — the "Stream Safe" music filter and its grid of curated playlists, added in v0.7.1, are gone. The premise didn't survive contact: tracks labelled "no copyright" on YouTube are largely re-uploads whose real rights holder's Content ID fingerprint still matches, and crediting a track satisfies its licence without having any effect on the automated claim. The local library replaces it.


## [v0.7.1] - 2026-07-22

A small release for anyone who codes on stream: the music panel can now put on a playlist that won't get a VOD claimed or a broadcast muted.

### Added

- **Stream-Safe music catalog** — YouTube Music search gains a fourth filter, "Stream Safe", which shows a grid of curated DMCA-free playlists (StreamBeats Lofi, Synthwave and Chill, NoCopyrightSounds, Lofi Girl creator-safe, and the YouTube Audio Library) instead of search results. Picking one plays the whole playlist, and the now-playing card carries a "Stream-Safe Certified" badge so you can tell at a glance that what's playing is cleared.


## [v0.7.0] - 2026-07-21

Terminals and agents now stay alive wherever you go. Previously, leaving a room — visiting Home, switching layout, minimizing, or moving to another project — unmounted its terminal and rebuilt it by replaying scrollback into a fresh one, which left full-screen agent TUIs rendering garbage or nothing at all. Every one of those paths now keeps the pane mounted, so a running agent is exactly where you left it when you come back. Agent completions also stop talking at you: the cue is now a soft chime plus a recap card in the chat.

### Fixed

- **Panes survive Home and layout switches** — Home is now an overlay instead of a screen that tears down the workspace, `openWorkspace()` no-ops when you're already in the target workspace, and the stage mounts from every open room rather than only the visible ones. Minimizing a room, switching layout, or opening the Fleet/empty states hides the terminal instead of disposing it.
- **Agent panes survive project switches** — agent rooms were derived from a store that only ever reflects the active project, so leaving a project disposed its agents' terminals. Panes are now mounted from sessions across all open projects and hidden when out of view, and they still resolve their title, preset and owning project while in the background.
- **Personal terminal panes survive project switches** — the terminal room mounted a single panel bound to the active project, so switching re-mapped its cells onto the incoming project's sessions and rebuilt every terminal. Each open project now gets its own panel, with inactive ones parked and display-only.
- **A shell promoted to an agent no longer starves one of its terminals** — typing `claude` in a mosaic shell kept its grid slot while also opening an agent room, and only one of the two terminals received output. The mosaic cell now links to the agent's room instead of mounting a duplicate pane.
- **The agent worktree badge stays visible** — the badge resolved its session from the active project's list only, so it vanished on a project switch even while the agent kept working. The worktree is also persisted now, so a restart no longer leaves the badge blank and orphans the worktree on close.
- **Side panels no longer re-tile the layout** — opening or closing Toolbox, HTTP, DB, Containers or Env forced a layout change, pulling you out of Split or Fleet. The right drawer works in every layout and now leaves it alone.

### Changed

- **Agent completions nudge instead of announce** — when an agent finishes, blocks, or fails, Spacron now plays a short synthesized two-note chime (rising = done, repeated = blocked, falling = failed) instead of speaking a status line aloud. The chime is Web Audio, so it needs no TTS provider or API key, and the AI recap of what the agent actually did still lands in the chat completion card. During a live realtime voice call the model keeps dropping a spoken one-liner rather than a chime. The setting is now "Agent result nudge".
- **Agent recaps are generated in every mode** — the completion summary used to be produced only in voice mode, and the announcement itself was silently skipped whenever the reply-TTS provider had no API key, so outside voice mode you got nothing and no explanation. The recap is now generated regardless of mode and surfaced with the cue.
- **Focus stage inset from the left drawer** — the focused panel is separated from the drawer by the same gap the stage uses elsewhere, so the two raised cards no longer read as one merged slab.


## [v0.6.10] - 2026-07-20

A release that makes proxied sites in the preview browser behave like real tabs — logins persist across restarts and most web apps now load and work correctly — plus a redesigned Focus layout and an app-wide pass of 3D depth styling.

### Added

- **Persistent logins in the preview browser** — the proxy's upstream client now keeps a cookie jar on disk (cleared by "clear browsing data", flushed on stop, and saved periodically), so signing into a proxied site survives an app restart instead of starting over every session. The jar file is created owner-only (0600 on Unix; Windows keeps the user-profile DACL of the config directory) since it holds live session tokens.
- **Universal request bridge for proxied sites** — fetch/XHR/sendBeacon/EventSource and WebSocket traffic from a proxied page is now routed through the proxy automatically (generalized from the old YouTube-Music-only bridge), fixing CORS failures and broken relative-URL resolution that previously made most external SPAs unusable inside the preview browser. `history.pushState`/`replaceState` is wrapped too, so client-side route changes keep the address bar in sync.
- **Dedicated Focus toggle** — Focus is now its own dock button instead of sharing one with Split, so switching layouts is unambiguous.

### Changed

- **Focus layout redesigned** — the focused panel now sits beside a vertical rail of the other open rooms as full-width raised cards (Stage Manager–style) instead of a horizontal strip underneath it, with a scroll mask and taller card content.
- **App-wide 3D depth pass** — panels, dock chrome, cards, chips, and buttons across the shell now share one consistent lit-edge-and-shadow language (bevel highlight, contact shadow, ambient shadow, pressed state) in place of the previous per-component shadows.


## [v0.6.9] - 2026-07-12

A patch release that removes the voice-mode confirmation gate entirely. The assistant no longer performs an action and then asks "want me to go ahead?" — every action executes immediately, and spoken replies state what's happening instead of asking permission for something that already ran.

### Fixed

- **Actions no longer run before their confirmation** — the old confirmation hold only ever covered spawn/send/close, so app-control actions (navigate, open a file, preview, run, settings) always executed immediately while the voice assistant was instructed to reply with a confirmation question — "open X" opened X and *then* asked. On the realtime engines the hold couldn't resolve at all, since the voice model rephrases speech and a literal "yes" never arrives. The gate is removed on every path, so the app never again asks you to approve something it already did.

### Changed

- **Voice assistant acts immediately and speaks declaratively** — the orchestrator brain is now told that every action it returns executes the moment it's returned; when it genuinely needs permission or clarification, it asks first with no actions attached and acts on the next turn. A code-side backstop rewrites any leftover "want me to go ahead?"-style reply into a declarative acknowledgement ("On it — launching Claude.") so what you hear can never contradict what happened.


## [v0.6.8] - 2026-07-12

A patch release that makes realtime voice mode actually usable — spoken commands now execute instead of being swallowed by a confirmation gate, and OpenAI Realtime calls no longer fail to connect — plus persistent file-explorer selection across app restarts.

### Fixed

- **Realtime voice commands execute** — spoken commands through the GPT/Grok Realtime engines ("open Claude Code") were acknowledged but never ran: the voice model rephrases everything before it reaches the orchestrator, so the confirmation gate waited for a literal "yes" that could never arrive. The realtime bridge now executes tool calls immediately, and the voice model is instructed to confirm ambiguous or destructive requests verbally first; the classic voice pipeline keeps the orchestrator-side gate.
- **OpenAI Realtime calls connect again** — every realtime call was rejected with `400 invalid_offer` because trimming the SDP offer stripped the trailing newline OpenAI's parser requires. The terminator is restored after validation, with added SDP plausibility checks on both the renderer and Rust sides.
- **Explorer selection survives restarts** — the file you last clicked in the explorer and your expanded folders are now saved with the rest of the per-project state, so reopening the app restores exactly what you had selected (previously the selection only survived project switches within a session).


## [v0.6.7] - 2026-07-11

A release focused on the YouTube Music experience and custom shortcut rework: the embedded music.youtube.com site is gone in favor of a refined keyless player, the side-by-side responsive tracklist, and persistent playback state. Custom shortcuts shift from terminal commands to app actions, dropdowns gain modal-safe boundary detection, and various UI polish rounds out the release.

### Added

- **Side-by-side tracklist in landscape panels** — when the YouTube Music panel is wider than it is tall, the album/playlist tracklist moves beside the now-playing block instead of below it, with responsive breakpoints that react to narrow, short, and mini viewports — every panel size gets a tailored layout.
- **Custom shortcuts drive app actions** — custom keyboard shortcuts now bind to app actions (toggle a panel, open settings, switch layout) via a Dropdown picker instead of typing a shell command, making custom shortcuts useful for navigation without needing a terminal.
- **Dropdown boundary detection** — the custom Dropdown component gains a `boundarySelector` prop that keeps the menu inside modal boundaries, preventing clipping in Settings and other overflow-hidden containers.
- **Playlist index & paused state persistence** — the YouTube player now saves which track was playing in an album/playlist and whether it was paused, restoring the exact playback state across app restarts and mode switches.
- **Scroll-edge fade on dropdown menus** — the dropdown overlay gets a vertical mask-image gradient so items fade into the panel edge instead of cutting off sharply.

### Changed

- **YouTube Music: removed the embedded site** — the toolbar toggle for the real music.youtube.com site (loaded through the proxy) is removed. The keyless InnerTube player is now the only music surface, which eliminates the audio-fighting and complexity of maintaining both surfaces.
- **Grok CLI now reads the rules file** — the built-in Grok CLI preset (`grok`) now sets `readsRulesFile: true`, matching the other built-in CLI agents.
- **Shortcut editor category renamed** — custom shortcuts now appear under "Custom Shortcuts" instead of "Custom Commands", and the add-form section is titled "Add custom navigation shortcut".
- **Responsive CSS refinements** — narrow-width breakpoints now scale play/prev/next button sizes, toolbar padding, grid layout, and track-row density, ensuring the YouTube panel is usable at every size from a narrow sidebar to a full-width panel.

### Fixed

- **Video ID validation before IFrame load** — invalid or malformed video IDs are caught early instead of producing an opaque "Invalid video id" error from the YouTube IFrame API.
- **Playlist/album loading with mixed videoId** — album search results that include a first-track `videoId` alongside the `playlistId` no longer cause the IFrame API to throw "Invalid video id", because the two are never passed together.
- **Paused state restores correctly on remount** — the player now remembers whether playback was paused (not just the position), so switching modes and back doesn't auto-resume a paused track.
- **Improved InnerTube data extraction** — `findWatchVideoId` and `findPlaylistId` now check `musicResponsiveListItemRenderer`'s `navigationEndpoint` before the blind deep search, so album/playlist tracks parsed from InnerTube `next` responses resolve correctly.


## [v0.6.6] - 2026-07-11

A release featuring agent team roles with a shared mailbox, the Grok CLI as a new built-in agent, opt-in remote auto-reconnect, local HTML preview, TTS pacing controls, a downloadable website, and a proprietary license.

### Added

- **Agent team roles & shared mailbox** — When the orchestrator breaks a goal into a plan it can now assign each agent a team role (coordinator, builder, scout, reviewer), delivered as a compact charter on top of the standing brief. Agents post their turn outcomes to a shared mailbox so the whole team sees what happened without you relaying it, a Builder that finishes hands its work directly to a Reviewer for gating, and actionable "needs you" cards (report / handoff / ask) let you reply or approve from the mailbox strip — your answer is recorded on the board and delivered straight into the agent's live REPL.
- **Grok CLI built-in agent** — Grok CLI (`grok`) joins the built-in agent presets. Spawn it from the agent picker or by voice ("open grok"), and manually-typed `grok` launches are detected and adopted by the orchestrator like any other agent, with its own pane border and prompt-bar accent.
- **Remote auto-reconnect on startup** — Each saved remote workspace can carry an opt-in "reconnect on startup" flag (toggled from the Remote status popover; at most one remote holds it). On boot Spacron dials the flagged remote so a workspace whose agents are still running on the box comes back on its own; if the box is offline it fails fast and falls back to Local.
- **Start a project from nothing** — You can now create a brand-new empty folder and open it as a project in one step, from the welcome screen, empty workspace, and Project HUD — no need to make the folder outside the app first.
- **Local HTML file preview** — The preview panel can open an HTML file straight off disk through the background proxy's `/local-file` route, with the proxy port rebuilt on restore so persisted preview tabs survive app restarts.
- **TTS pacing & tone controls** — Voice replies gain per-model pacing: a playback speed for `tts-1`/`tts-1-hd` and free-text pacing/emotion instructions for `gpt-4o-mini-tts`, gated per model in Rust so unsupported providers never receive a bad field.
- **Website download route** — New `/download` route on the website that detects your OS and redirects straight to the right installer from the latest GitHub release, falling back to the releases page when no matching asset exists.

### Changed — License

- **Relicensed to proprietary** — Spacron is now closed-source, proprietary software (© Samuel Solesi, all rights reserved), replacing Apache-2.0. The `LICENSE` file, README, CONTRIBUTING, `package.json`, `Cargo.toml`, and website footer are updated to match. Versions published under earlier licenses remain available under those terms.

### Changed

- **Removed the terminal layout picker** — The preset layout dropdown in the terminal toolbar is gone; pane arrangements are now built directly by splitting (right/below) and dragging panes.
- **Rebuilt website** — The landing page under `website/` was rebuilt as a Next.js app: first with a minimal cnvs.dev-style dark theme, then restyled with the app's own colors and a full-width layout. The in-app changelog link now points at the new deployment.
- **Prompt bar input** — The floating prompt bar's input and voice transcript now grow up to three lines and then scroll, keeping the newest words in view while you speak.

### Fixed

- **Website metadata** — Removed a stray `<head/>` tag that broke Next.js metadata rendering, and corrected the Linux download asset name.
- **Connectivity probe hardening** — The remote "is it online?" probe now refuses link-local and cloud-metadata hosts, matching the guard already applied to authenticated AI requests, so a tampered base URL can't be used as a reachability oracle for internal hosts.


## [v0.6.5] - 2026-07-11

A release featuring new preset themes, background customization, YouTube Music enhancements, and automatic Vercel domain detection.

### Added

- **Preset themes & 4K backgrounds** — Added 4 new preset themes with corresponding 4K background images (including 2 light and 2 dark 4K WebP backgrounds) to provide rich, visual aesthetics.
- **Embedded YouTube Music playback** — Made embedded YouTube Music playable by implementing a cookie jar, request bridge, and server-side consent resolution. A keyless player is now the default for Music mode.
- **YouTube search improvements** — Updated the InnerTube search parameters so that album and playlist searches return actual albums and playlists.

### Changed

- **Vercel domain detection** — Removed the manual `siteUrl` setting UI in favor of automatic Vercel domain detection.
- **Project cleanup** — Removed the legacy `site/` directory to deploy the `website/` directory directly, and added `.vercelignore`.
- **Rebranded website landing page** — Rebranded the landing page under `website/` to a minimal cnvs.dev-style design.


## [v0.6.4] - 2026-07-09

An orchestration release: the voice/orchestrator brain can now plan a large task and fan the sub-tasks out to your already-running agents, the prompt bar shows live agent task cards, voice replies can speak through xAI, and the conversational brain confirms before it acts.

### Added

- **xAI TTS voice** — voice replies can now be spoken by xAI's text-to-speech (`https://api.x.ai/v1/tts`), alongside the existing OpenAI, Groq, and local providers. The request is made from Rust so the xAI key never reaches the renderer, and the returned audio is decoded and played back like any other TTS provider.

- **Agent task cards** — the floating prompt bar now shows CNVS-style cards for your agents, with running / blocked / recently-finished states and animated indicators, so you can see at a glance what each agent is doing and which ones just finished.

- **Plan-and-delegate workflow** — for a large multi-part task, the orchestrator brain can now work in two phases: first it spawns an agent to write a numbered implementation plan, then on a later turn it reads the completed plan back out of that agent's terminal output and dispatches the sub-tasks — one per available running agent, several at once — sending to agents that are already open (and spawning only when none are running). To support this, a completed planning agent's output is now passed to the brain in full (up to 80 lines) instead of the usual 10-line tail.

### Changed

- **Confirmation gate in voice mode** — the conversational brain now acknowledges what you asked and asks for confirmation before it spawns, sends, or closes anything; the action is only taken after you explicitly agree ("yes", "go ahead", "do it"). Saying no just continues the conversation.

- **Cleaner spoken status** — when reporting what an agent did, the voice brain now paraphrases (which files changed, what ran, whether tests passed, what state it ended in) instead of ever reading raw terminal output aloud.


## [v0.6.3] - 2026-07-09

A voice release: two new realtime speech-to-speech engines alongside the existing pipeline (VAD → STT → brain → TTS), plus barge-in, completion announcements, and a steadier pipeline mode.

### Added

- **GPT Realtime engine** — a live WebRTC call to OpenAI's Realtime API that replaces the whole VAD → STT → brain → TTS chain with sub-second, speech-to-speech replies and server-side (semantic) turn detection. The model delegates real work to the existing orchestrator brain via a function tool and speaks the result back; the SDP handshake happens in Rust so the OpenAI API key never reaches the renderer. Model and voice are selectable from Settings → Voice.

- **Grok Realtime (xAI) engine** — a second speech-to-speech engine, this one over a WebSocket to xAI (`wss://api.x.ai/v1/realtime`), sharing the same session API and event core as GPT Realtime. The client secret is minted in Rust and presented as a subprotocol, so the xAI key never reaches the renderer or a URL. Model and voice are selectable from Settings → Voice.

- **Barge-in for the pipeline engine** — speaking over a reply now cuts playback and starts the next turn, gated by playback-aware VAD so echo from the assistant's own voice doesn't falsely trigger an interruption.

- **Agent completion announcements in Realtime mode** — background agent completions ("Codex finished: ...") are now spoken in the model's own voice during a live Realtime call, queued until the call is idle so they never talk over the user or the model.

- **Live realtime model lists** — the Realtime model picker for GPT Realtime and Grok Realtime now fetches the provider's actual model catalogue (filtered to realtime/voice models) once a key is configured, with a manual "Refresh models" button, instead of only ever showing the curated static list.

### Changed

- **Faster pipeline capture** — mic audio is downsampled to 16 kHz mono before encoding, cutting the IPC payload and STT upload to about a third of its previous size with no loss (local Whisper/Parakeet resample to 16 kHz anyway).

### Fixed

- **Replies stay visible while listening** — since barge-in leaves the mic open during playback, the transcript no longer blanks to "Listening…" the instant a reply starts; it now shows the live draft only when there is one, and otherwise keeps the last reply on screen until you actually speak.

- **VAD rejects transient noise** — speech onset now needs ~250ms of sustained energy at 2x the ambient noise floor (plus an absolute RMS floor), so keyboard clicks, coughs, and door slams no longer start a turn or cut off a reply mid-sentence.


## [v0.6.2] - 2026-07-08

A new Split view layout. Alongside Focus (the single terminal/agent screen) and Fleet (the grid), you can now open Split — two rooms side by side — from the dock or by cycling layouts with the shortcut.

### Added

- **Split view layout** — a two-panel, side-by-side arrangement of rooms. Open it from the new Split toggle in the dock, and the layout-cycle shortcut now steps Focus → Split → Fleet. Split is only ever entered by an explicit action, so opening a tool never re-tiles into it and the terminal is never unmounted underneath you.


## [v0.6.1] - 2026-07-08

A preview reliability release. Local previews of apps that redirect on load — a `/` → `/login` bounce, an `http`→`https` upgrade, or a hosted auth handshake (Clerk, Auth0, NextAuth, Supabase) — now stay inside the preview instead of failing with "content is blocked" or hanging. Only the in-app preview proxy is affected; nothing else changes.

### Fixed

- **Local previews survive redirects to other origins** — a dev app that redirects on load now keeps rendering in the preview. The proxy rewrites the redirect so the browser follows it *through* the proxy (where framing headers are stripped) instead of escaping to the raw origin, whose `X-Frame-Options` / CSP would otherwise block the iframe with "content is blocked".

- **Cookie-based auth handshakes no longer time out** — a hosted auth provider's redirect chain (e.g. Clerk's dev-instance `handshake`) previously looped between the provider and the app until it failed with "operation timed out", because the proxy followed the redirects itself and dropped the `Set-Cookie` headers each hop depends on. The proxy now hands every redirect back to the preview so cookies land in the browser and the handshake completes.

- **Local custom domains stop being wrongly blocked** — a hostname that resolves to your own machine (a hosts-file alias like `myapp.test`, or `lvh.me`-style wildcard DNS) is no longer rejected with "Access to private/internal resources is not allowed". The DNS-rebinding guard now blocks only genuinely private ranges (LAN, link-local, ULA, cloud metadata), matching the rest of the proxy. Blocked-target errors now name the URL that was blocked.


## [v0.6.0] - 2026-07-07

Remote workspaces. Your workspace — files, terminals, LSP, git, and agents — can now live on a box you own (a VPS, cloud VM, or home server), with the Spacron app acting as a thin client that attaches to it. Open Spacron, connect to a remote, and your terminal, editor, and language servers are all operating on the remote machine; close the laptop and reconnect from anywhere and the workspace is still there, mid-state. The desktop app is unchanged when no remote is connected.

### Added

- **Remote workspaces** — connect to a machine you own and run your whole workspace there. The file tree, editor, terminals, language servers, and agents all operate on the remote box, so language servers run next to the code (real types, no project sync) and long-running work doesn't need your laptop awake. It's the interactive remote model (like VS Code Server / Cursor Remote-SSH), not an ephemeral cloud agent.

- **Headless `spacron-server`** — a standalone binary you run on the remote box (`spacron-server --workspace <dir> --port 9000 --token <token>`). It reuses the desktop app's terminal, file, watch, and LSP cores and serves them over a single WebSocket, confined to the workspace directory you point it at.

- **Connection manager in the status/title bar** — a chip shows the active workspace and live connection status (connecting / connected / reconnecting / error). Its popover lets you add, edit, and switch between "Local" and saved remotes in one click. Saved remotes persist; the app always boots Local and you connect explicitly.

- **Auto-reconnect** — a dropped link (laptop sleep, network blip) reconnects automatically with exponential backoff, re-attaching your still-live terminal sessions and re-arming file watches. Terminal sessions and their scrollback survive the disconnect on the server, so output simply resumes.

- **Optional durability auto-commit** — pass `--auto-commit-ms <interval>` to `spacron-server` to periodically stage and commit uncommitted changes as a safety net against losing work if the remote VM dies. Disabled by default.

### Changed

- **Fully see-through panels on Windows and macOS** — the rooms (editor, terminal, preview, …), both utility sidebars, the activity bar, and the terminal scrim now drop their frosted tint entirely so the wallpaper shows straight through. Content that paints its own surface (a preview, a video) is unaffected, and the solid overlays (settings, model switcher, search, quick capture) stay solid. Linux (WebKitGTK) keeps its original frosted look.

- **Backend calls route through a transport seam** — workspace operations (file read/write, search, git, LSP) now go through a single `BackendClient` seam instead of calling the Tauri backend directly. When no remote is active this is a transparent pass-through with identical local behavior; when a remote is connected the same calls travel over the WebSocket to `spacron-server`.

### Security

- **Pre-shared token over a WebSocket subprotocol** — the client authenticates with a token presented as a `token.<TOKEN>` subprotocol (kept out of the URL, so it can't leak into logs or history) and validated in constant time. LSP connections use single-use, short-TTL ephemeral tokens so the pre-shared secret never lands in a URL. The transport is plaintext `ws://` and is meant to run behind Tailscale/VPN (which encrypts the link); the server prints a startup warning and must never be exposed on a public network. TLS (`wss://`) is a planned hardening step.


## [v0.5.0] - 2026-07-03

A Linux reliability release. It fixes the WebKitGTK rendering bugs that made the dock and floating prompt bar go invisible, left a "ghost" of a closed room behind, and spammed internal WebKit errors — and makes copy, paste, and drag-and-drop work properly across the terminal and prompt bar on Linux. It also adds clear, per-platform guidance for missing system dependencies, and a full-panel transparency fade for the floating YouTube player. Windows and macOS are unaffected by the Linux-specific fixes.

### Added

- **Per-platform dependency guidance** — a central catalog now surfaces a clear, OS-specific "here's exactly what to install" message when a required system dependency is missing (Git, the Android SDK tools, Xcode, …), replacing cryptic or Windows-only errors.

- **Drag-and-drop into the prompt bar** — drag a file from the OS file manager or the in-app explorer onto the floating prompt bar to attach its path (and it no longer duplicates the path several times).

- **Clipboard image paste on Linux** — pasting an image such as a screenshot into the prompt bar now works on WebKitGTK, which never exposed clipboard images through the web paste event.

### Changed

- **Terminal opens straight to a live shell** — the terminal room now auto-starts a shell instead of landing on the empty "Open Shell" placeholder.

- **Groq is the default voice-reply provider** — voice replies default to Groq's Orpheus TTS instead of inheriting whatever general "brain" provider was configured, which could be one that can't speak.

- **Conflict-free terminal copy/paste** — copy/paste moved off Ctrl+Shift+C / Ctrl+Shift+V (which collided with Go to Containers / Go to Preview). Copy with Ctrl/Cmd+C when text is selected (a bare Ctrl+C still interrupts), paste with Ctrl/Cmd+V, plus Ctrl+Insert / Shift+Insert. Selecting text also copies it automatically, and middle-click pastes.

- **Floating YouTube transparency** — the opacity slider now fades the entire player panel, header included, rather than just the video body.

- **Leaner terminal pane header** — the per-pane role picker and the status-dot / maximize control were removed.

### Fixed

- **Dock and floating prompt bar going invisible on Linux** — WebKitGTK's DMABUF GPU renderer is disabled on Linux, and the overlays' fragile entrance animations and GPU-layer hints are neutralised there, so both paint reliably from the first frame and after layout changes.

- **Ghost residue after closing a room/panel on Linux** — closing a room now forces a repaint of the rooms grid so stale compositor pixels are cleared.

- **"WebKit encountered an internal error" spam on Linux** — resolved by disabling the broken DMABUF renderer.

- **Vanishing overlays on layout/agent switches** — the CSS View Transitions used on those switches are buggy on WebKitGTK and could leave elements hidden; they now fall back to an instant update on Linux while Windows/macOS keep the animation.

- **Copy/paste on Linux** — terminal and prompt-bar copy/paste route through the native clipboard, since WebKitGTK blocks the web clipboard API; the prompt box also gains a right-click copy/paste menu on Linux.

- **Cross-platform "install Git" guidance** — a missing Git binary now shows OS-appropriate install instructions instead of a Windows-only hint.

- **Compiler warning** — removed a dead-code / unused-import warning in the notification command on non-Windows builds.


## [v0.4.9] - 2026-07-02

A large workspace-shell release: a new Project Launcher, a dedicated Development page with a morphing dock, several new layout modes (Jarvis HUD Cockpit, vibe-coding canvas, redesigned focus), a Playbooks-driven terminal, and a top-to-bottom liquid-glass polish pass.

### Added

- **Project Launcher HUD & Hybrid Collections** — the entry screen is now a Project Launcher built from spacious vertical cards with glowing folder-icon avatars, backed by a "Hybrid Collections" model for grouping workspaces. The workspace naming/creation modals were rebranded to match, and an "add folder" button is always visible in the launcher.

- **Dedicated Development page with a morphing dock** — the old split layout is now a dedicated development page whose dock morphs dynamically to the active task, with a dockable terminal. In development mode the page tools, keyboard shortcuts, the global prompt bar, embedded panel tools, and terminal snippet commands all route to an isolated dev-terminal so they never leak into your real project sessions.

- **Playbooks** — a new tmux/warp-inspired Playbooks panel for saved, repeatable agent workflows. Each playbook can override which agent executes it (via a premium custom Dropdown selector), and an inline markdown hint card guides you through authoring them.

- **tmux / warp-style terminal** — detached PTY sessions, per-agent visual glows so you can see at a glance which pane an agent owns, and inline block diagnostics.

- **Glassmorphic agent spawn modal** — agent spawning moved out of the prompt bar into a dedicated, dock-triggered glassmorphic modal dialog.

- **New layout modes** — a **Jarvis HUD Cockpit** side-by-side layout (with its own theme/layout style mode), a **vibe-coding canvas** layout tuned for agents and CLIs, and a redesigned **focus** layout that stacks panels horizontally below a larger rectangular stage with a Spotlight-style floating search bar.

### Changed

- **Premium liquid-glass pass** — Apple-like translucency and smooth spring transitions across modals, search, and the floating YouTube panel; global tactile button physics, liquid range inputs, toggle spring sliders, and icon micro-animations. Light mode gains its own liquid-glass treatment with a minimum opacity threshold so text stays readable at full transparency.

- **Quick Capture animation** — replaced the page-wide View Transitions with a sleeker, self-contained spring scale animation.

- **ProjectHUD card redesign** — cards use a spacious vertical layout with folder-icon avatars (circular avatar backgrounds and hardcoded blue accents removed) and larger folder icons.

- **Roomier default sidebar** — the default layout `sidebarWidth` was raised to 310px for better responsiveness.

- **Cleaner welcome screen** — the Settings button is hidden from the TitleBar while the welcome screen is active.

### Fixed

- **UI fills the window under the global zoom** — `#app` is now sized at a plain 100% under the global zoom, and viewport-unit sizing inside the zoomed shell was corrected, so the layout no longer overflows or under-fills the window.

- **Overlay clearance on workspace mount** — the AppShell ResizeObserver effect now runs on `workspaceId` mount so overlay clearance is calculated correctly from the first paint.

- **Agent spawn modal flicker** — the spawn modal now closes immediately on confirm (no background flash), agent-name assignment is restored, and the layout view-transition flash on toggle is bypassed.

- **Dev-mode focus & routing leaks** — fixed prompt-bar room focus and agent-run targeting leaking into the standard terminal in development mode.

- **Tab strip clashes** — agent sessions are excluded from the top tab strip so they no longer clash with active tabs.

- **Layout scroll & overlap** — fixed left-side scroll cut-off in the room-cards row (now centered safely), focus-panel overlap, and minimized panels now sit at the bottom-left corner with horizontal scrolling.

- **Factory reset dialog** — added the missing `dialog:allow-ask` capability so the factory-reset confirmation dialog can open.

## [v0.4.8] - 2026-06-27

### Changed

- **Onboarding walkthrough redesign** — replaced generic checkmarks with 15 custom theme-aware feature icons, refined copywriting across all slides to make them benefit-focused, and replaced simplified illustrations with high-fidelity, interactive dashboard visuals (representing editors, terminals, LSP diagnostics, git graphs, and a command palette simulator).
- **Theme picker spacing** — re-organized the starting theme picker into a clean, spacious 2-row, 3-column swatch grid.

## [v0.4.7] - 2026-06-27

### Added

- **Notification store tests** — added unit tests covering toast queue limits, desktop notification triggers, and Web/Browser Notification fallback behavior
- **Updater store tests** — added unit tests covering update check status, progress tracking, and relaunch state

### Fixed

- **Notification wrapper refactor** — consolidated duplicate permission check state, window focus handlers, and fallback code between the Zustand store and Svelte compatibility wrapper
- **Updater sync pop-up** — refactored the compatibility updater store to sync directly with the Zustand store, correcting the issue where update check triggers in the Settings Modal failed to propagate to the application's update banner

## [v0.4.6] - 2026-06-26

### Added

- **Go to YouTube shortcut** — assigned a default key binding of `Ctrl+Shift+Y` to toggle the YouTube panel
- **Missing shortcut handlers** — keyboard shortcuts for `openDailyNote` (`Ctrl+Shift+D`), `toggleSketch` (`Ctrl+Shift+N`), `canvasZoomIn` (`Alt+=`), `canvasZoomOut` (`Alt+-`), and `canvasResetZoom` (`Alt+0`) are now correctly hooked up and executed
- **Default shortcuts configuration** — added the missing `cycleAmbientLayout` shortcut mapping (`Ctrl+Alt+L`) to the initialized user shortcuts list

## [v0.4.5] - 2026-06-26

### Fixed

- **Spawn list reactivity** — the spawn picker now updates live when preset agents are hidden or restored in Settings (removedPresetAgents was missing from the dependency array)
- **Worktree isolation diagnostics** — the Rust backend now checks that `git` is on the system PATH before attempting worktree creation, producing a clear error instead of a cryptic failure when it's not found; unexpected worktree failures are logged at `error` level in the frontend
- **Worktree creation robustness** — `workspace_git_create_worktree` validates git availability upfront with `check_git_available()`, so the error surfaces immediately rather than deep into git plumbing

## [v0.4.4] - 2026-06-26

This release is a large rebuild of the Spacron interface on React, with a new infinite-canvas workspace, on-device voice, and a substantially upgraded Sketch Canvas and Settings experience.

### Added

- **Infinite-canvas workspace** — the workspace is now an interactive, pan-and-zoom infinite canvas (the "gallery" layout) where editor, terminal, preview, and tool panels live as cards you arrange spatially rather than in fixed slots. It's the default layout and your choice persists. The canvas supports camera zoom/pan controls, cluster-based panel sizing, a 3-row grid auto-arrange that fits both dimensions, and a centred "reset layout" that re-fits everything in the viewport. `Ctrl+Alt+L` cycles the ambient layout mode.

- **Left utility drawer & right tool drawer** — the file explorer and Source Control now live in a slide-out left utility drawer, and the secondary tools (Toolbox, HTTP Client, Database, Containers) live in a right slide-over drawer instead of taking over the main view. DevPet and the YouTube panel are now free-floating overlays you can position over the workspace.

- **On-device offline voice** — local Kokoro (text-to-speech) and Parakeet (speech-to-text) models now run fully on your machine as in-browser WASM, no cloud round-trip required. The model downloader moved into the AI Models settings tab, and Cross-Origin Isolation headers are enabled to unlock multi-threaded WASM for fast local synthesis.

- **Voice personalities** — choose a customizable voice personality in Settings that's injected into the assistant's system prompt, with a voice preview button to hear each option before committing.

- **Custom terminal command shortcuts** — create your own named terminal command shortcuts in Settings and run them on demand.

- **Sketch Canvas overhaul** — multi-selection, grouping, deep selection, and proportional resizing; copy, paste, and duplicate for elements and whole drawings; image import (with high-quality smoothing and aspect-ratio lock during corner resize); multiple fonts and font-size selection; brush and eraser size presets; toggleable sharp/curved rectangle edges with an edge-radius slider; and a fixed custom stroke-colour picker. The renderer now matches the Excalidraw-style hand-drawn look across every shape.

- **Preview remembers more** — preview tabs, plus video and audio playback positions, now persist across project and workspace switches, and the preview panel stays mounted across layout changes so it doesn't reload.

- **Smarter Settings** — model dropdowns gain an interactive search/filter input and live catalog loading (including for the inline-completion provider), agents moved to a dedicated Settings tab with live model fetching, and you can hide preset agents you don't use while keeping your custom CLI agents.

- **Spatial canvas connections** — the infinite canvas now supports absolute staggered node placement with active connection paths drawn between related panels, plus a subtle flow animation that makes workspace topology visible at a glance.

- **Sketch (Excalidraw) launcher in dock** — a new Sketch button in the dock bottom items launches the drawing canvas directly from the dock, and the preview layout panel is now centred for a cleaner workspace arrangement.

- **DashboardShowcase design skeleton** — a new design system showcase that highlights the CNVS and BridgeSpace layout configurations, giving a visual overview of available workspace modes.

- **Enlarged preview stage with terminal toggle** — the preview stage dimensions have been increased for a roomier browsing experience, and the terminal now initialises closed by default with an inline toggle to expand it when needed.

- **YouTube music player enhancements** — the floating YouTube player now includes an album/playlist tracklist UI, adjusts short video height thresholds, adds full album playback support, and responsive breakpoints for the music player.

- **External browsing feels native** — the preview panel now handles external URLs more naturally, making the embedded browsing experience behave closer to a real browser with proper navigation flows.

### Changed

- **React interface rebuild** — the UI has been ported from Svelte to React, with a redesigned glassmorphic Settings modal (custom Dropdown components in place of native selects, interactive tab accents), a redesigned, centralized Welcome screen, a redesigned Assistant Orchestrator panel, and smooth global CSS View Transitions for layout and modal animations.

- **Voice mode lives in the prompt bar** — speaking/listening indicators are integrated directly into the floating prompt bar instead of a separate overlay, and the left-Alt key toggles voice mode.

- **Cleaner title bar** — the search bar and brand text were removed from the TitleBar, and the Settings icon now lives there.

- **Default local STT is Parakeet** — the default offline speech-to-text model is now Parakeet; the unimplemented Whisper path returns a clear error instead of failing silently.

- **Diff views consolidated** — inline and split diff views are now unified in the Review panel.

- **Workspace Snapshots hidden by default** — the Snapshots tab is off by default and can be re-enabled with a settings toggle; the sidebar room title now renames itself to match the active tab.

- **Version bumped to 0.4.4** — app metadata and native package metadata now point at v0.4.4.

- **Preview layout shows running agents** — the preview layout now displays running agents alongside the preview stage and terminal panel, keeping you informed of agent activity without switching views.

- **Terminal minimizes by default in preview mode** — the workspace terminal now starts minimized when entering the preview layout, reducing visual clutter and keeping focus on what you're previewing.

- **Unused components removed** — cleaned up legacy components (SketchCanvas, FloatingNotepad, RunHistoryPanel) that were superseded by newer implementations, reducing bundle size and maintenance surface.

### Fixed

- **Voice agent audio glitches** — fixed the VAD startup click/pop, inline-code being dropped from TTS, and `flushSync` lifecycle warnings; VAD speech detection was refined with a 0.025 RMS threshold and consecutive-frame validation to cut false triggers.

- **Terminal on Windows** — fixed resize truncation, optimised the fit debounce, corrected the canvas-addon loading lifecycle order, synced `windowsPty` options, and added a warning notification when PowerShell 7 is missing.

- **Layout & canvas stability** — resolved view-transition residue and layout-switch animation flicker via a global transition guard, fixed database tab switching, DevPet height queries, YouTube PIP resizing, duplicate-image double-rendering on the canvas, and a DevPet animation glitch on rapid clicks.

- **Settings scrolling** — contained Settings scrolling and disabled the elastic overscroll bounce, and the settings modal now positions correctly below the title bar.

- **Canvas panel gaps when count exceeds 4** — fixed spatial gaps and overlapping panels that appeared in the canvas layout when more than 4 panels were present.

- **YouTube window positioning** — minimized YouTube windows now snap to the bottom-right corner automatically, and window position is restored correctly within the viewport when restoring from the dock.

- **Terminal and agent panels only show with live preview** — these panels no longer persist when the preview is inactive, keeping the layout clean.

- **Mobile device shell quoting** — the `android_text` input is now safely escaped before being passed to the device shell, preventing shell injection on Android targets.

### Added

- **Terminal WebGL renderer** — a new three-way renderer selector (DOM / Canvas / WebGL) replaces the old toggle. WebGL is now the default for reliable GPU-accelerated rendering on Windows WebView2. Existing users are migrated automatically from the broken `'dom'` default.
- **Auto-focus fresh agents** — newly spawned agent sessions are automatically focused in the main room so you see agent activity immediately.
- **Layout transition terminal refit** — layout transitions dispatch a `pane-resize-end` event so xterm instances re-measure after promotion from small cards to full-screen, fixing a blank-band gap.
- **Project switching spinner** — a loading overlay appears during project switches for clear visual feedback.
- **YouTube album tracklist** — the floating YouTube player now renders an interactive tracklist with a now-playing indicator and click-to-navigate tracks for albums and playlists.
- **Empty workspace entrance animation** — the empty workspace view fades and slides in with staggered timing for a smoother first-open feel.
- **Restore-project toast** — a brief toast now indicates whether a workspace was restored from a previous session or started fresh.

### Changed

- **Liquid glass redesign** — the UI glass aesthetic has been deepened across all surfaces: backdrop blur raised to 35px and saturation to 180% (Apple visionOS-style). Glass CSS variables are now centralized (`--glass-blur`, `--glass-saturate`, `--glass-glow`, `--glass-shadow`) and consistently applied across AppShell chips, command palette, settings modal, dropdowns, and workspace switcher. The frost curve was updated for richer opacity at high transparency.
- **Removed DevPet** — the virtual pet feature has been removed entirely (editor, status bar, source control, command palette, orchestrator context, settings, layout). You no longer need to feed a pixel creature to type.
- **Default terminal renderer switched to WebGL** — the fallback `'dom'` renderer left terminals blank on Windows; the default is now `'webgl'` with an automatic one-time migration for existing settings.
- **File explorer auto-collapses on open** — opening a file from the explorer now collapses the left sidebar, giving the editor full room.
- **Preview panel cleaned up** — removed the inline terminal toggle from the preview panel; the browser "Web" button now uses `navigateTo` to ensure the background proxy starts before navigation.
- **Clean slate for fresh projects** — new projects no longer auto-create an editor or terminal session; you get a clean blank workspace.
- **Removed redundant views** — pet, android, and iOS views removed from the orchestrator's navigable views list and from the layout type system.

### Fixed

- **Terminal blank on Windows** — fixed transparent terminal rendering on Windows WebView2 by defaulting the renderer to WebGL, which composites reliably over the pane's backdrop-filter blur.
- **Sketch proxy race** — Excalidraw tab creation now waits for `ensureProxyRunning()` before navigating, preventing a blank iframe.

## [v0.4.3] - 2026-06-16

### Fixed

- **Local dev previews no longer fail behind a VPN or system proxy** — previewing `http://localhost:…` could error with a TLS `BadRecordMac` or "localhost refused to connect" when a corporate/VPN proxy was active, because the loopback request was being routed through that proxy (your normal browser bypasses proxies for localhost, which is why it worked there). The preview now connects straight to your dev server.

- **Authentication-gated apps now load and let you sign in inside the preview** — apps that hand off to a hosted auth provider (Clerk, Auth0, NextAuth, Supabase, and similar) previously broke with a blocked frame or a connection error, because the provider's sign-in handshake bounced the page off the proxy to your raw dev origin, whose embedding policy then refused the frame. The preview now lets the browser perform the handshake itself and keeps the whole flow on the proxy origin (where embedding restrictions are stripped), so the app renders and the login round-trip completes.

- **Copy buttons work inside previewed apps** — clipboard access (used by things like the Next.js dev overlay) was blocked by the preview frame's permissions policy. The preview iframe now grants clipboard read/write, so in-app copy actions succeed instead of throwing.

### Changed

- **Version bumped to 0.4.3** — app metadata and native package metadata now point at v0.4.3.

## [v0.4.2] - 2026-06-15

### Added

- **New "Cream" light theme** — a warm, paper-like light theme that swaps the stark white background for a soft cream, so dark text reads with less glare and better contrast than on pure white. Available in Settings → Themes.

- **Preview remembers where you were** — the web preview now restores your per-page scroll position when you return to a page, and a new history dropdown (clock icon in the preview toolbar) lets you jump back to pages you've visited. Scroll positions and browsing history persist across sessions.

- **"Local & development previews work best" indicator** — the Web Preview empty state now makes clear it's built primarily for previewing your local dev server. External pages still open, but the copy sets expectations up front (many full websites block embedding and won't load in an embedded view), so trying to browse a normal site isn't a surprise.

### Changed

- **Graphite-grey brand refresh** — the accent palette moved from teal/sky to a calmer light graphite grey across the app's default light/dark themes, logo and icons, and the marketing site. On-disk custom themes built on the previous defaults are migrated once to the new palette (key-aware, so any colour you customised and the semantic `warning` colour are left untouched).

- **Voice refinement is now off by default** — the AI voice-refinement step starts disabled on fresh installs and after "Reset to default"; enable it in Settings if you want it.

- **App window icon follows the installed version** — the in-app logo's cache-buster is now tied to the app version, so the window/About icon refreshes correctly after an update instead of showing a stale image.

- **Faster marketing site** — removed per-frame shape re-rasterisation on the landing page's blurred background orbs (transform-only animation stays on the GPU) and batched the scroll-progress handler into a single rAF, smoothing out scroll lag.

### Fixed

- **Onboarding no longer re-appears after an abrupt shutdown** — the "onboarding completed" flag is now mirrored to a durable backend file (`app_flags.json`), because WebView2 flushes `localStorage` to disk lazily and could lose the write when the machine was switched off. On startup the flag is reconciled from the durable store, so the walkthrough stays dismissed once you've finished it.

- **Preview Back/Forward returns to the previous page, not the main menu** — in-page navigations (a site's own search box, pagination, local-dev route changes) are now recorded without reloading the iframe, so Back returns to the page you were actually on instead of jumping to the last typed URL or the blank placeholder. `PreviewTab` tracks the displayed `url` and the committed `loadUrl` separately.

- **DuckDuckGo search returns results again** — the preview's search and "Browse Web" button now use the server-rendered `html.duckduckgo.com/html/` endpoint. The main DuckDuckGo SPA fetches results over a cross-origin request the preview proxy can't serve, which left the results page blank.

- **Preview console panel captures local-dev logs from the first call** — the injected console hook no longer waits for a parent handshake before forwarding messages, so logs emitted during page load are captured instead of being dropped (which made the panel look empty). Console capture remains scoped to local-dev pages.

- **Terminal text stays readable in light mode** — in light themes the ANSI `white` and `bright-white` colors were mapped to near-white, so shell output drawn in those colors (e.g. command tokens like `cd`) rendered white-on-light and was invisible. They now map to dark, readable tones in light mode (dark themes are unchanged).

- **Settings no longer rubber-bands when scrolling** — taller Settings tabs used to overscroll past the top/bottom with an elastic "over-pull" bounce (and could chain the scroll to the page behind). The Settings body now contains its own scroll, so it stops cleanly at each edge.

- **Sketch Canvas rectangles honor the hand-drawn roughness** — rounded rectangles ignored the Pencil/Loose roughness and always rendered CAD-clean (the rounded-rect path used a no-op jitter hook), while circles, diamonds, and arrows were correctly sketchy. Rectangles now draw with the same perturbed double-stroke edges (keeping smooth rounded corners), so the Pencil style is consistent across every shape.

## [v0.4.1] - 2026-06-14

### Changed

- **Faster release-site experience** - optimized the landing page load path and runtime responsiveness.

- **Version bumped to 0.4.1** - app metadata, native package metadata, and release-site version references now point at v0.4.1.

### Fixed

- **Linux release build** - corrected the WebKitGTK `WebViewExt` import so the Linux AppImage build can compile preview screenshots successfully.

## [v0.4.0] - 2026-06-14

### Added

- **Update banner changelog link** - the signed update banner now includes a "View Changelog" action next to the inline "What's new" notes, opening the same public changelog page used by Settings.

### Changed

- **Apple Silicon-only macOS builds** - release and CI workflows now build macOS artifacts for Apple Silicon (`aarch64-apple-darwin`) only, alongside Windows and Linux.

- **Version bumped to 0.4.0** - app metadata, native package metadata, and release-site version references now point at v0.4.0.

### Fixed

- **Cross-platform CI typecheck script** - added the missing `npm run check` script expected by the Windows/macOS/Linux build workflow.

## [v0.3.9] - 2026-06-14

### Added

- **Type-aware code intelligence (LSP)** — the editor now offers real completion, diagnostics, and hover backed by language servers (rust-analyzer, typescript-language-server, pyright, gopls), bridged to CodeMirror over a single-use-token-authed loopback WebSocket. Servers are detected on PATH, with one-click install for the ones you're missing. On by default, per language.

- **AI ghost text ("Cursor Tab")** — faded inline code predictions you accept with Tab, powered by a dedicated fast completion provider/model (default Groq) chosen independently of your main AI provider. Opt-in (off by default) since it streams the surrounding code to the provider on each typing pause.

- **Custom CLI agents** — add your own coding-agent commands under Settings → Terminal and they become first-class citizens: they show up in the spawn picker, can be dispatched by the orchestrator (and get a friendly assistant name to address), are auto-detected and adopted when you type them into a plain shell, and receive the standing brief via CLAUDE.md / AGENTS.md when they read a rules file.

- **Language badges on editor tabs** — each tab shows a short, colour-coded language badge instead of a generic "TXT".

### Changed

- **Much faster startup** — the app used to ship as one ~4.5 MB JavaScript bundle. The editor (CodeMirror plus ~20 language packs), Settings, the Sketch Canvas, the preview, and every auxiliary panel now load on demand, cutting the startup bundle by ~40% so the shell and terminal paint sooner. The largest third-party libraries are split into their own vendor chunks.

- **Built-in browser searches with DuckDuckGo** — the preview's "Browse Web" button and the address-bar search fallback now use DuckDuckGo instead of Google, which serves a CAPTCHA wall through the local preview proxy and was effectively unusable in the embedded browser.

- **Cool teal/sky brand carries to saved themes** — on-disk custom themes built on the old amber defaults are migrated once to the new teal/sky palette. The migration is key-aware, so any value you customised is left untouched, and the semantic amber `warning` colour is deliberately preserved.

- **Cross-platform preview screenshots** — capturing the preview region now works via WKWebView (macOS) and WebKitGTK (Linux) in addition to WebView2 (Windows).

### Fixed

- **Terminal input is no longer silently dropped** — a stuck input gate on panes that weren't yet visible/attached (a background tab, or reattaching on app open) could swallow every keystroke. A timeout now guarantees input is re-enabled.

### Security

- **The preview proxy rejects cross-origin requests** — the loopback proxy now requires each request to carry no `Origin`, or a first-party one (loopback / `*.localhost`), so a page open in your normal browser can't drive the proxy to reach your dev server and other loopback services or use it as an SSRF request-forwarder. `Origin: null` (sandboxed / `data:` documents) is rejected too.

## [v0.3.8] - 2026-06-13

### Added

- **The orchestrator is now a full in-app assistant** — beyond dispatching coding agents, it can see and answer questions about the whole application (the active page, open editor files and cursor, unsaved changes, every terminal and what it's running, the preview URL, the git branch, and your run presets) and act on it directly: switch pages/panels, open files and jump to a line, point the preview at a route, run commands, and manage the task board. Actual code changes are still delegated to spawned agents.

- **Live content awareness** — the assistant also sees the contents of the file you're viewing, your current editor selection, and the recent output of every terminal (not just agents), so it can reason about the real code and what your processes are printing. File contents and selection are only shared while the editor is the focused view.

- **Manually-launched agents are adopted automatically** — when you start an agent CLI yourself by typing it into a terminal (e.g. `claude`, `codex`), the orchestrator now recognises it, tracks it as a running agent you can address by name, reads its output, and can send it follow-ups or close it — exactly like agents it spawned itself.

- **Clear preview cookies & cache** — a new preview-toolbar button (backed by the `preview_clear_browsing_data` command) clears the embedded preview's cookies, disk cache, cache storage, and service workers — handy when stale auth (e.g. a clock-skewed JWT) or cached assets break a local app. The app's own persisted state (settings, sketches) is deliberately left untouched. (Windows / WebView2.)

### Changed

- **Sketch Canvas grid and background follow the app theme** — in transparent and grid background modes the canvas grid, dots, and backdrop now read the active Spacron theme palette (and match it on export), and the canvas no longer stacks an opaque slab over the frosted wallpaper.

- **Embedded commands open their own terminal** — Arduino / PlatformIO / Raspberry Pi commands now run in a fresh, project-scoped terminal session instead of reusing whatever pane is focused, so they can't interrupt something you're already running.

- **Orchestrator memory tracks freshness** — remembered task summaries now carry an age / last-confirmed label and mark themselves stale once old, so the assistant weights recent work over old context.

- **About tab cleanup** — removed the redundant descriptive "Updates" note from the updater section.

### Fixed

- **Agents no longer spawn on top of a busy terminal** — clicking "+" to launch an agent (and orchestrator dispatch) now skips any pane running a detected dev server or build, opening a new pane instead of clobbering the running process. The reuse check previously relied only on an output-quiescence flag, so a server that had gone quiet read as an idle shell and got overwritten.

## [v0.3.7] - 2026-06-12

### Security

- **Provider keys never leave the OS keychain** — the frontend no longer reads or caches full AI provider API keys. The `provider_api_key_get` command is removed entirely; the UI now tracks only a configured / not-configured flag (`provider_api_key_exists`), and every AI request (orchestration, commit messages, voice input/refinement, TTS, model listing) sends an empty key while the backend resolves the real key from the keychain at call time. Settings copy is updated to say keys are kept in the OS keychain and never displayed back.

- **Write queries in the Database Explorer require explicit confirmation** — `db_execute_query` now takes an `allow_write` flag and rejects any non-`SELECT`/`PRAGMA`/`EXPLAIN` statement unless the user confirms it in the UI, so an accidental or injected `UPDATE`/`DELETE`/`DROP` can't run silently.

- **"Discard all changes" requires a confirmation token** — `workspace_git_discard_all` now only runs its `git reset --hard` + clean when the caller passes the literal `discard all changes` confirmation string, guarding the most destructive Source Control action against a stray invocation.

- **Terminals are confined to the open project** — new terminal sessions resolve their working directory through `resolve_terminal_cwd`, which canonicalises the path and requires it to live inside an open project folder. The old fallback that spawned shells in an arbitrary process-current directory is gone.

### Changed

- **Trust and scope cues across the workspace** — the Source Control, Review, Database Explorer, and Containers panels now show a "Project" scope note clarifying that their actions apply to the currently open project; the Preview toolbar gains a "Sandboxed preview" pill, the update banner shows a "signed release" badge, and Settings gains key-storage, active-project, secrets, network, and update security notes so it's clear what each surface can touch.

## [v0.3.6] - 2026-06-12

### Added

- **Containers panel** — a new Docker / Compose toolbox panel (its own activity-bar view) with one-click actions that run straight into a terminal session: check Docker & Compose availability, `compose up --build`, `compose down`, list running containers, and tail compose logs.

- **Orchestrator memory** — the agent orchestrator now keeps a per-project memory of completed work in `.spacron/orchestrator-memory.json`. Finished task summaries are remembered (capped at 40 entries, deduplicated), loaded when a project opens, and folded into the brain's context so follow-up requests build on what's already been done instead of starting cold.

- **Task-panel awareness for the orchestrator** — the brain now reads your Kanban board (In progress / To do / Done) as project truth. When you ask "what should I do next?" it recommends what to tackle and what can wait, prioritising in-progress work over the backlog, and dispatched agents receive a compact task-panel context block so they share the same picture without you re-explaining it.

- **Hand-drawn sketch rendering** — the Sketch Canvas gains a dependency-free "rough" renderer (`roughSketch`) for the Excalidraw-style sketchy look: perturbed double-stroke outlines and jittered hachure / cross-hatch fills, deterministic per shape so a drawing looks identical across redraws, zoom, and export.

### Changed

- **Sketch Canvas small-screen polish** — the canvas toolbar and controls reflow more gracefully on narrow windows, the native font picker is replaced with a custom styled font dropdown, and the settings popover z-index is fixed so it no longer renders behind other canvas chrome.

- **Tab strips no longer over-scroll** — a new `clampHorizontalScroll` action keeps horizontally scrollable strips (editor tabs and panel headers) pinned within their content bounds instead of drifting past the last item.

## [v0.3.5] - 2026-06-12

### Added

- **Dev Pet companion** — a gamified workspace companion (cat, slime, or robo) that levels up as you code. It earns XP and coins from characters typed and commits made, tracks your WPM, and reacts with status animations (typing, sleeping, committing, eating). State persists locally, and a new pet panel surfaces its level, inventory, and skins.

- **Custom backgrounds and live wallpapers** — set a workspace background image or a looping video wallpaper. The backend validates and stores a single background file with format allowlists (PNG/JPG/WebP/GIF/AVIF/etc. up to 10 MB, MP4/WebM/MOV/etc. up to 100 MB), and the new `BackgroundMedia` layer honours `prefers-reduced-motion` and pauses video when the window is hidden.

- **Embedded hardware panel** — a new toolbox panel for embedded workflows (Arduino, PlatformIO, Raspberry Pi) that runs common board commands straight into a terminal session.

- **Native agent rules-file delivery** — the standing agent brief is now written into the rules file each CLI reads on startup (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex / Cursor / OpenCode / Antigravity) inside a delimited managed block, instead of racing a bracketed paste into the live REPL. This removes the readiness heuristics and paste races that left the brief unregistered on Ink-style and first-run/trust-screen CLIs. Agents that don't read a rules file still fall back to the paste path.

### Changed

- **Settings overhaul** — the settings modal gains substantial new configuration surface across backgrounds, the dev pet, and workspace preferences.

- **Native desktop notifications** — notifications now route through a dedicated backend command for reliable click-to-focus behaviour.

## [v0.3.4] - 2026-06-11

### Added

- **Svelte, TOML, and C# syntax highlighting** — the editor now highlights `.svelte` files (via `@replit/codemirror-lang-svelte`), `.toml`, and `.cs`. C# files previously fell back to the C/C++ grammar; they now use a dedicated C# mode and are detected as their own language.

- **Format-on-save for more file types** — Prettier now handles `.svelte`, `.yaml`/`.yml`, `.scss`, `.less`, `.mjs`/`.cjs`, and `.htm` in addition to the existing JS/TS/JSON/CSS/HTML/Markdown set. The Svelte path loads the browser build of `prettier-plugin-svelte` alongside the embedded JS and CSS parsers.

### Fixed

- **Preview leaked the previous project's content on switch** — the shared preview proxy's target port is process-global, so mounting a project's preview iframes while the backend still pointed at the prior project's dev server piped the wrong app into the panel (and it stuck, because the iframe never re-requested once the port caught up). The proxy is now repointed at the incoming project's dev server *before* its tabs are restored or the panel is shown.

- **Agent TUI showed a stale frame after a project switch** — when a terminal pane reattaches to a still-running session, its fresh xterm fits to the size the PTY already has, so no resize event reaches the running full-screen TUI (e.g. the Claude Code agent) and it renders a stale frame until you manually drag to resize. The pane now reproduces that resize — briefly shrinking the PTY by one row and restoring it — to force an immediate repaint on reattach.

- **Saved pane layout clobbered when closing a project** — closing a project now switches the visible terminal state to the fallback project synchronously, before `restoreProjectState`, so `gridLayout` and `activeProject` update in the same effect flush and the fallback project's saved pane layout isn't overwritten by a stale preset re-apply. This mirrors the existing `switchToProject` / `openProjectByPath` ordering.

## [v0.3.3] - 2026-06-11

### Fixed

- **Preview screenshots came out blank on Windows** — capture now uses WebView2's native `CapturePreview` API instead of GDI `BitBlt`. GDI read the hardware-composited WebView2 surface as an all-black frame, so both full-preview screenshots and per-element captures produced empty images. The native path grabs the real rendered pixels and crops to the requested DOM rectangle.

- **"Add Element to Chat" closed the preview** — selecting an element in the preview (and the screenshot-to-prompt fallback) no longer switches to the terminal view, which was hiding the preview panel. The floating prompt bar overlays every view, so it is now simply focused while the preview stays open.

- **Deleting a folder didn't close its open files on Windows** — `onFileDeleted` now normalises path separators before matching, so editor tabs for files inside a removed directory are detected and closed regardless of `\` vs `/`.

- **Desktop notification clicks** — notifications now use the Web Notifications API with an `onclick` that shows and focuses the window, replacing the previous plugin `sendNotification`/`onAction` path.

### Changed

- **Agent charter prompt-injection hardening** — a spawned agent's task text is now wrapped in tamper-evident `<<<SORYQ_TASK … SORYQ_TASK>>>` delimiters, escaped so embedded text can't forge them, and explicitly labelled untrusted. A new "Injection Safety" rule instructs the agent to ignore any instruction inside the task that tries to override the brief, reveal secrets, change scope, or weaken the git/file safety rules.

- **New preview tab opens blank** — opening a new preview browser tab now starts at `about:blank` instead of the dev root, and `about:blank` is handled cleanly throughout URL normalisation and the iframe sandbox.

- **Charter delivery simplified** — removed the single-line compact-paste special case for Claude / OpenCode / Antigravity. Every agent now receives the charter through the standard bracketed-paste path.

- **Per-tab iframe registration** — preview iframes register through a Svelte action (`registerIframe`) instead of `bind:this` into a record, so each tab's element is tracked correctly as tabs are created, switched, and closed.

### Internal

- Backend-wide `cargo fmt` and Clippy cleanup across the command, preview proxy, PTY, theme, and workspace modules — formatting and lint fixes only, no behaviour change.

- Expanded unit-test coverage for the editor, preview, terminal, and agent-charter stores.

## [v0.3.2] - 2026-06-11

### Added

- **Agent Charter** — every spawned agent now receives a standing operating brief the moment it starts. The brief enforces scope (do only the assigned task, note unrelated issues rather than fixing them), git safety rules (no destructive commands, no branch-switching, no force-push, commit only your own files), and execution discipline (begin immediately, verify before done, end with a summary). This prevents agents sharing a workspace from clobbering each other's edits or wandering outside their task.

- **Voice overlay compact mode** — `VoiceConversationOverlay` gains a `compact` prop that renders it as a small docked panel above the floating bar rather than a full-screen takeover, so the workspace stays visible while you talk.

- **Voice conversation mode in the orchestrator brain** — `routeOrchestratorRequest` now accepts a `conversational` flag. When set, the brain defaults to chatting (empty actions) and only dispatches agents when you explicitly say so ("open an agent and…", "spawn Claude to fix…"). Running agents' recent terminal output is surfaced in replies so status questions get useful answers. The LLM system prompt gains a dedicated voice-mode section reinforcing the same bias.

- **Idle agent spawn** — saying "open Claude" or "spawn an agent" without a real task now opens a ready terminal without inventing a meaningless task prompt for the agent. `EXPLICIT_SPAWN_RE` distinguishes idle-open from task-dispatch intents.

- **Background-project session exit tracking** — a new `onSessionExit` broadcast in `terminal.ts` fires for every session exit in every project, not just the active one. The orchestrator subscribes to it so an agent that exits while its project is in the background is reconciled immediately, instead of being stranded in-progress until the user reopens that project.

- **TTS chunked streaming** — `speak()` splits text into sentence-level chunks and plays them in a pipeline: the first chunk (≤140 chars) begins playing the moment it is synthesised, while the rest are synthesised in the background. This dramatically reduces time-to-first-audio on long replies. A per-call `speakToken` ensures a superseded or cancelled pipeline tears down cleanly without lingering audio.

### Changed

- **Agent mode on by default** — the floating prompt bar now opens in agent mode (`isAgentMode` defaults to `true`), so it is always ready for an orchestrator message without an extra click.

- **Voice overlay positioning and appearance** — the overlay now uses `position: fixed` (was `position: absolute`) and sits below the title bar so window controls remain reachable. The background switches to a translucent glass effect (`backdrop-filter: blur`) so the workspace stays faintly visible behind it.

- **Agent Command Center simplified** — the task management panels (running / blocked / in-review task lists, approve/reject controls, agent picker) are removed from the Agent Command Center. It now focuses purely on the conversational chat interface.

- **Prompt delivery timeout extended** — `PASTE_SUBMIT_MAX_WAIT_MS` raised from 2 500 ms to 6 000 ms so slow-starting TUI agents (Ink/React REPLs) are not short-circuited. Test-environment timing constants stay fast.

- **Spawn UI reset on project switch** — `spawnOpen` and `spawnCounts` are reset when the active project changes so stale spawn state from a previous project never leaks into the new one.

### Removed

- **Per-task git worktrees** — `workspace_git_worktree_create` and `workspace_git_worktree_remove` Rust commands removed; `worktree-manager.ts` and its tests deleted. The Agent Charter's scope and git rules replace isolation at the filesystem level: agents coordinate by convention rather than by being locked to separate trees.

- **`in-review` task status** — the intermediate review gate is gone. Tasks transition directly from `in-progress` to `complete`, `failed`, or `blocked`. Legacy persisted `in-review` tasks are normalised to `todo` on load.

- **`ExecutionMode` (`direct` / `worktree`)** — removed from task records, `createTaskRecord`, and `createOrchestratorTask`. `inferExecutionMode()` removed along with it.

- **`approveTask()` / `requestTaskChanges()`** — task review/approval functions and their UI controls removed.

- **`OrchestratorWorktree` / `OrchestratorReviewState` types** — removed from the task model.

- **Broadcast-to-all-agents mode** — the floating bar's "broadcast" toggle (send one message to every running agent at once) removed.

## [v0.3.1] - 2026-06-09

### Added

- **Project-wide search (Ctrl+Shift+F)** — a new `Search` tab in the sidebar (`SearchPanel`) finds text across every open project root. Searches honour `.gitignore` (but never descend into `.git`), support case-sensitive, whole-word, and regular-expression modes, and take an optional comma-separated include-glob filter (e.g. `*.rs, src/**/*.ts`). Results are grouped by file with line/column positions. Backed by a new Rust `search_in_project` command built on the `ignore` walker, with caps on file size (2 MB), per-file matches (200), total matches (5 000), and line length (500 chars) so a pathological query can't lock up the UI.

- **Environment variable manager (Ctrl+Shift+E)** — a new `EnvManager` overlay stores per-project environment variables in the OS keychain (namespaced by project id under the same `com.samue.spacron` service as the AI and GitHub secrets). Variables can be added, edited, removed, or imported in bulk from the project's root `.env` file. Backed by new Rust commands `env_vault_get`, `env_vault_set`, and `env_vault_import_dotenv`, with variable-name validation and a minimal `.env` parser (handles `export`, `#` comments, and quoted values).

- **HTTP Client variable substitution** — requests now expand `{{VAR}}` placeholders from the active project's environment vault in the URL, headers, and body before sending. Unknown placeholders are left intact so a typo is visible rather than silently blanked.

- **Inline diff viewer in Source Control** — every changed file in the Source Control panel gains a hover "View diff" button that opens a `DiffViewer` overlay for that file, instead of having to open it in the editor.

- **Merge-conflict resolution** — `workspace_git_status` now reports a separate `conflicted` list (unmerged paths: any `U` state plus the both-added/both-deleted cases), shown in Source Control with a `!` badge. A new `workspace_resolve_conflict` command collapses each conflict block in a file to a single side — "ours", "theirs", or "both" — then stages the result so Git treats the conflict as handled.

### Changed

- **Responsive Welcome screen** — the welcome screen's three-column layout now narrows its side rails before collapsing, uses fluid `clamp()`-based padding/gaps/heights, and progressively reflows to two columns, then one, then a compact phone layout (with the daily-notes and shortcuts rails sitting side by side at intermediate widths). The whole page scrolls instead of clipping on small windows.

- **Responsive HTTP Client panel** — the panel now drives its internal layout off its own width (`container-type: inline-size`) rather than the viewport, shrinking the saved-request rail in steps and collapsing it entirely below ~340 px so the request editor is never clipped inside a narrow aux panel.

- **Command palette height** — capped at `min(400px, 70vh)` so it never overflows short windows.

### Fixed

- **Aux panel no longer clipped on smaller windows** — the auxiliary-panel max-width clamp under-reserved horizontal space, cutting the panel off on the right at smaller window sizes. The calculation now reserves the terminal's minimum width plus the surrounding chrome (app-body padding, inter-panel gaps, and resize handles) through a single shared `auxMaxWidth()` helper used by both the clamp effect and the drag handler. The width effects also bail out for very narrow or hidden windows to avoid spurious reclamps.

- **API-key cache isn't poisoned by a startup read error** — `initApiKeyCache` no longer caches `null` for a provider whose key failed to read at startup. The provider is left absent from the cache so `providerApiKeyExists` falls through to a live keychain query instead of incorrectly reporting "no key".

### Security

- **HTTP Client blocks SSRF to link-local and cloud-metadata addresses** — `http_send_request` now rejects requests whose host is, or resolves to, a link-local or cloud-metadata address (notably the `169.254.169.254` IMDS endpoint and the `metadata.google.internal` / `metadata.goog` hostnames), including IPv6 link-local and IPv4-mapped forms. The check runs on the initial URL and is re-evaluated on every redirect hop, so a redirect can't smuggle the request to a blocked address. Loopback and private ranges stay allowed on purpose (hitting your own dev server is the point).

- **HTTP Client caps response size** — response bodies are now streamed in chunks and aborted once they exceed 50 MB, so an oversized or never-ending response can't exhaust memory.

- **Destructive SQL queries require confirmation** — the Database Explorer now warns and asks for confirmation before running a `DROP`, `TRUNCATE`, or a `DELETE`/`UPDATE` with no `WHERE` clause. Line comments are stripped before the check so a commented-out `WHERE` can't mask a full-table mutation.

- **Environment vault is keychain-only** — project environment variables are stored exclusively in the OS keychain, never written to `localStorage` or the project folder, and variable names are validated (letters, digits, underscores, not starting with a digit) before being saved.

## [v0.3.0] - 2026-06-08

### Added

- **Agent Command Center** — a new conversational AI panel (the Agents tab) powers project-wide chat with AI agents. Messages go through the orchestrator and replies stream back in a thread view. The floating prompt bar gains an "Agent mode" button that switches it from a terminal-command dispatcher to a conversational input for the command center, with its own send/cancel flow and a live preview of the last assistant reply.

- **Voice conversation loop** — activating voice mode in Agent mode opens a full conversational loop: voice is captured and transcribed (Google or OpenRouter), sent to the active agent, and the response is read back via TTS. The loop auto-continues after each reply. A new animated overlay shows the speaking/listening state, and stop controls halt both TTS playback and the mic.

- **TTS backend** — `tts_speak` synthesises speech from text using the selected provider (OpenRouter, Groq, OpenAI, Google, or any local OpenAI-compatible server). Google audio is decoded from raw PCM and re-wrapped into a standard WAV container server-side; all other providers return their native format. A 4 096-character cap prevents accidental large requests.

- **Audio transcription backend** — `ai_transcribe_audio` transcribes recorded audio using Google or OpenRouter's transcription APIs, with per-provider validation and secret redaction before errors reach the frontend.

- **Database Explorer** — a new `db` panel in the right rail lists every SQLite database detected in the open project, lets you browse tables, and run arbitrary SQL queries with a full column/row results viewer. Backed by new Rust commands (`db_list_tables`, `db_execute_query`) using the bundled `rusqlite` dependency.

- **Dev Toolbox** — a new `toolbox` panel in the activity bar, grouping developer utility tools in one place.

- **Terminal Snippets sidebar** — a new `Snippets` tab in the left sidebar (`TerminalSnippetsPanel`) for managing and inserting reusable shell snippets.

- **Sketch Canvas** — a freehand drawing overlay toggled from the bottom of the activity bar, for quick scratch diagrams alongside the workspace.

- **Activity Bar** — the left rail is now a permanent activity bar with icon buttons for every sidebar tab (Files, Source Control, Snapshots, Snippets) and every right-panel view (Editor, Terminal, Preview, Code Review, HTTP Client, Tasks, Database, Toolbox). Clicking an already-active sidebar tab closes it. Clicking an active aux view toggles it off and returns to terminal.

- **Git worktrees** — two new Rust commands (`workspace_git_worktree_create`, `workspace_git_worktree_remove`) for creating and pruning Git worktrees from within the app.

- **Recent Daily Notes** — `workspace_get_recent_daily_notes` surfaces recently edited per-project daily note files for display in the welcome screen and navigation.

- **`check_local_provider_online`** — probes local AI provider servers (Ollama, LM Studio) with a 500 ms timeout; Ollama falls back from the `/v1/models` path to the native `/api/tags` endpoint when the OpenAI-compatible route isn't reachable.

- **`provider_api_key_get` command** — complements `provider_api_key_exists` with an actual key-read command, used by the keychain cache system.

- **`ai_complete` command** — generic Tauri command for direct prompt completions outside the voice and commit-message flows.

- **HTTP Client requests moved to Rust** — the HTTP Client panel now sends requests through `http_send_request` in the Rust backend instead of `fetch()` in the WebView, eliminating CORS errors and allowing requests to any URL regardless of the app's Content-Security-Policy.

- **Navigation history store** — `initNavigationHistory` initialises browser-style back/forward history for the preview panel.

- **`VoiceInputProviderId` type** — `'webspeech' | 'google' | 'openrouter'` for the voice-input provider setting.

### Changed

- **AI API keys moved from localStorage to OS keychain** — `ai-keychain.ts` is fully rewritten around an in-memory cache backed by the OS keychain. On startup the app migrates any keys still in `localStorage` to the keychain and populates the cache; all subsequent reads are synchronous Map lookups with no IPC round-trip. The old pattern — localStorage as primary store, keychain as mirror — is reversed. Keychain is now authoritative.

- **Background images served via asset protocol** — background images are no longer base64-encoded over IPC. The Rust backend now returns the stored file path; the frontend converts it to a webview-safe URL using `convertFileSrc`. This removes large IPC payloads, drops the base64 encode/decode overhead, and makes image loads faster.

- **`setSidebarTab` opens the sidebar** — calling `setSidebarTab` now also sets `sidebarVisible: true`, so switching tabs programmatically always makes the result visible.

- **`toggleSidebarTab` added** — closes the sidebar when the given tab is already active, or switches to and opens it otherwise. The activity bar uses this for all sidebar-tab buttons.

- **Layout state extended** — `LayoutState` gains `orchestratorVisible`, `dbVisible`, and `toolboxVisible` booleans. All existing toggle functions (`setActiveView`, `showTerminal`, `toggleTerminal`, `toggleEditorVisible`, etc.) are updated to clear the new flags when switching views so only one aux panel is ever visible.

- **Provider definitions carry `ttsSupport`** — `AiProviderDef` now includes an optional `ttsSupport` field (`'native' | 'self-hosted' | 'none'`) indicating TTS support. OpenRouter is marked `'native'`.

- **App startup hardening** — the config-directory creation now uses `expect` to surface failures immediately instead of silently ignoring them, and the main webview window retrieval uses a proper `None` guard that returns an error rather than an unwrap panic.

### Fixed

- **Interface transparency migration** — users whose transparency was silently reset to `0` by the opaque-default change in v0.2.5 have it automatically restored to `50` on next launch, gated by a one-time `forge_setting_interfaceTransparency_migrated_v1` marker in `localStorage`.

### Security

- **API keys are keychain-only** — keys are never written to `localStorage` as a primary store. The in-memory cache is populated from the OS keychain at startup; `localStorage` is only touched during the one-time migration and is cleared afterward.

- **HTTP Client bypasses WebView CSP safely** — routing HTTP Client requests through the Rust backend keeps the app's Content-Security-Policy tight (no wildcard `connect-src`) without blocking any developer tool requests.

- **Database queries are project-scoped** — `db_list_tables` and `db_execute_query` call `require_in_project` before opening any SQLite connection, preventing the panel from accessing databases outside the open project roots.

## [v0.2.5] - 2026-06-04

### Changed

- **Interface starts opaque by default** — the `interfaceTransparency` default (used by fresh installs and "Reset to default") is now `0` instead of `50`, so Spacron launches in the solid-background, blur-disabled performance mode out of the box. Existing users keep whatever transparency level they've already set; only new profiles and explicit resets are affected.
- **Release builds publish on tag push** — the release workflow now triggers automatically on a tag push and is pinned to npm. `bun.lock` was removed so `tauri-action` no longer auto-detects Bun (which the CI runners don't install), and `tauriScript` explicitly invokes npm so the release build matches the `npm ci` / `npm run build` path used everywhere else.

### Fixed

- **Agent detection keys off the executable, not any word in the line** — terminal agent-preset detection no longer regex-scans the whole command for an agent keyword. It now extracts the basename of the executable actually being launched — skipping a leading PowerShell call operator (`&`), env-var assignments (`FOO=bar codex`), and launcher prefixes (`npx`, `bunx`, `pnpx`, `sudo`, `command`, `exec`, `time`, `nice`), then stripping any path and Windows extension (`.exe`/`.cmd`/`.bat`/`.ps1`) — and matches that against each preset's known executable names. This fixes commands like `omp agent …` being misattributed to Cursor's bare `agent` CLI, and adds recognition for the `agy` (Antigravity) and `cursor-agent`/`cursor` executables.

## [v0.2.4] - 2026-06-03

### Added

- **Publish a project to GitHub from Source Control** — a new "Publish to GitHub" flow turns an un-versioned folder, or a local repo with no remote, into a GitHub repository without leaving the app. When the active project has no `origin`, the Source Control panel offers a Publish button that opens an inline form: a one-time personal-access-token field (with a deep link to GitHub's token page pre-scoped to `repo`), the repository name (pre-filled from the folder name and sanitised to GitHub's allowed characters), an optional description, and a Private/public toggle. Creating the repo runs the whole sequence end-to-end — it calls the GitHub API to create the repository under your account, runs `git init` if needed, makes an `Initial commit` when the project has no commits yet, wires up `origin`, pushes the first commit, and opens the new repo in your browser. Backed by a new Rust `github` command module (`workspace_github_create_repo`) and a `src/lib/services/github.ts` client.
- **Unpushed-commit visibility** — Source Control now shows when you have local commits that haven't reached GitHub. The branch bar carries a sync badge (`↑N` ahead / `↓N` behind, or an `unpublished` pill when the branch has no upstream), and the Push button shows the outstanding count (e.g. `Push (2)`) and highlights in the accent colour whenever there's something to push. `workspace_git_branches` now also returns `ahead`, `behind`, `upstream`, and `has_remote` (computed via `git rev-list --left-right --count @{u}...HEAD`), and these counts refresh after every commit, push, and fetch.
- **Frontend unit tests (Vitest)** — the project now has a Vitest setup (`vitest.config.ts`, `npm test` / `npm run test:watch`) with the first suites covering the preview store's navigation/history (including the Back/Forward localhost regression below), the terminal store's command-block lifecycle, and the new proxy-URL extraction helper.

### Changed

- **Push is clearer and harder to get wrong** — `git push` now sets the upstream (`-u`) on the first push so the branch tracks `origin/<branch>` afterward (which is what powers the new ahead/behind counts), reports a friendly "Already up to date — nothing new to push" for no-op pushes, and translates failures into actionable messages instead of a raw git blob. The common silent-failure case — where the app disables interactive credential prompts (`GIT_TERMINAL_PROMPT=0`) and a push fails authentication without surfacing a login dialog — now reports "Authentication failed — your changes were NOT pushed. Sign in to GitHub…", with similarly specific guidance for rejected (fetch-first), missing-remote, and offline cases.
- **Model picker search bar stays pinned** — in Settings → Models, the model-list dropdown is now its own scroll container so its height hugs the available options up to the cap, and the filter input sticks to the top while you scroll, sitting on a translucent blurred backdrop that preserves the glass aesthetic instead of an opaque strip.
- **Simpler, more reliable agent pane titles** — the heuristic `summarizeAgentResponse` routine, which tried to guess a one-line summary by regex-scanning the tail of an agent's terminal output, has been removed along with the summarisation step in `finalizeCommandBlockWithExit`. Pane titles now come from the agent-emitted terminal title and task summary (the helpers added in v0.2.2), avoiding mislabelled panes built from noisy shell output.

### Fixed

- **Proxied dev-server pages render with their styles** — pages served through the Preview proxy could appear completely unstyled (the "Dev: On strips the CSS" problem), most visibly with Next.js 15. The proxy now advertises a `localhost` Origin/Referer to the dev server so its cross-origin guard (e.g. Next.js `allowedDevOrigins`, which trusts `localhost` but blocks `127.0.0.1`) accepts the subresource requests for chunks, modules, and stylesheets, and it strips the target's embedding/security headers (`Content-Security-Policy`, `X-Frame-Options`, the `Cross-Origin-*` policies) before re-serving inside the iframe, since those were authored for the dev origin and otherwise block the page from loading its own assets under the proxy origin.
- **Preview address bar shows the real URL** — when viewing an external site through the background proxy, the address bar now displays the actual external URL instead of the internal `http://127.0.0.1:<port>/proxy/…` form, via a new `extractExternalUrlFromProxyUrl` helper that decodes both the structured (`/proxy/<scheme>/<authority>/…`) and `?url=`-fallback proxy formats.
- **Back/Forward no longer truncates preview history** — returning to a typed-in `http://localhost:PORT/...` history entry no longer rewrote that entry to a bare relative path and discarded the forward history. When the iframe re-loads the page you're already on, the app now only syncs the address bar instead of pushing a new navigation entry.
- **Preview proxy is ready before the iframe loads** — entering a URL that routes through the proxy now starts the background proxy before the store update and iframe `src` binding fire, so the first load no longer races an unset proxy port.

### Security

- **GitHub token is keychain-only** — the personal access token used to create repositories is stored exclusively in the OS keychain via the `keyring` crate and read directly by the Rust backend. Unlike the AI provider keys (which live in `localStorage`), the GitHub token is never passed through the frontend, persisted to `localStorage`, or returned to the WebView.
- **No token leakage during the initial push** — the first push to a freshly created repo authenticates with the token injected through per-invocation `GIT_CONFIG_*` environment variables rather than the command line or `.git/config`. The credential never persists to the repository config and never appears in a process listing, while still guaranteeing the push succeeds even when no git credential helper is configured.
- **Hardened repo-creation inputs and errors** — repository names are validated against GitHub's character rules before any request, the publish flow refuses to act when an `origin` remote already exists (so it can't silently repoint an existing repo at a new empty one), and GitHub API failures are mapped to safe, specific messages (invalid token → 401, missing `repo` scope → 403, name already taken → 422) without echoing raw response bodies.

## [v0.2.3] - 2026-06-03

### Fixed

- **Release version metadata is now kept in sync** — the Tauri app version used by the native About screen and packaged release asset names is now aligned with the npm package version again. This resolves the bad `v0.2.2` release state where GitHub showed the `v0.2.2` tag but the generated installers and updater metadata were still stamped as `0.2.1`.
- **Version sync hook accepts this repo's changelog format** — the release helper now recognises changelog headings written as `[vX.Y.Z]` as well as `[X.Y.Z]`, preventing `npm version` from leaving `src-tauri/tauri.conf.json` behind when preparing a release.

## [v0.2.2] - 2026-06-03

### Added

- **Terminal pane display-title helpers** — three new exported functions in the terminal store:
  `getSessionPaneDisplayTitle` returns the agent-emitted pane title, falling back to the task summary and then to the role-based session label;
  `getSessionPaneSecondaryTitle` returns the task summary only when a distinct pane title is already shown, avoiding duplicate text;
  `getSessionDisplayName` combines the agent display name with the pane display title for use in pane headers and target labels.
- **Prompt-target label for agent sessions** — `getSessionPromptTargetLabel` shows the agent display name (e.g. `Claude Code`) for agent sessions, numbered when multiple instances of the same agent are running, giving clearer labels in the prompt bar's target picker and sent-toast messages.

### Changed

- **Terminal pane title area refactored** — the pane header now uses the dedicated `getSessionPaneDisplayTitle` and `getSessionPaneSecondaryTitle` helpers instead of inline `$derived` logic. The agent badge is rendered as a separate pill (`.pane-agent-badge`) before the main title, styled with a rounded accent-tinted background and a `132px` max-width. The old `.pane-title-main` class has been replaced.
- **Prompt bar target labels use the new helpers** — the floating prompt bar's target picker, target pill, and sent-toast messages now call `getSessionPromptTargetLabel` instead of `getSessionLabel`, so active agent sessions show the agent name instead of a generic session title.

## [v0.2.1] - 2026-06-03

### Added

- **CI build workflow** — the repository now includes `.github/workflows/build.yml` that runs on push and pull-request to `main` across Windows, macOS, and Linux. The pipeline typechecks the Svelte frontend, builds the Vite bundle, runs `cargo check` on the Tauri/Rust backend, and produces a debug build on every supported platform, keeping cross-platform regressions out of main.

### Changed

- **Preview toolbar reorganised into nav groups** — the device-toolbar controls have been split from a single flat `.nav-controls` into three logical groups: main navigation, utility actions, and viewport controls. The viewport divider that previously separated navigation from proxy/device controls has been removed, and the proxy button text is now wrapped in styled `<span>` elements so labels stay readable in cramped layouts. An obsolete `@container (max-width: 480px)` media query for `.preview-tabs` that conflicted with the restructured toolbar has also been removed.
- **Auxiliary panel default width increased** — the default `auxPanelWidth` has been raised from 500 px to 550 px for a more spacious right-panel experience. The new default is applied consistently across the layout store initial state, sanitisation/clamp bounds in the workspace store, and the project-restore fallback path.
- **Editor panel markdown toggle responsive layout** — the markdown preview toggle button now uses `white-space: nowrap` to keep its label on one line, and the editor panel has `container-type: inline-size` so a `@container (max-width: 480px)` query hides the button's text label and compacts its padding when the panel is narrow, preventing the toggle from overflowing the toolbar.
## [0.2.0] - 2026-06-03

### Added

- **Multi-provider AI model support** — the old OpenRouter-only AI flow has been replaced with a provider-based setup that supports OpenRouter, Anthropic, OpenAI, Google Gemini, Groq, Ollama, and LM Studio. Each provider now has its own configuration card in Settings, its own remembered model choice, and its own API-key or local-server configuration path.
- **Live model catalogues** — Settings can now fetch the live model list exposed by the selected provider instead of relying on a fixed allowlist. Cloud providers load the models your key actually unlocks, while local providers query their own OpenAI-compatible `/models` endpoint.
- **Local AI providers** — Ollama and LM Studio can now power voice refinement and AI commit-message generation through user-configurable local server URLs, without requiring a cloud API key.
- **File explorer multi-select** — the tree now supports standard explorer-style multi-selection: plain click selects one item, `Ctrl`/`Cmd` toggles individual items, and `Shift` selects a visible range. Delete actions deduplicate nested selections and remove the whole selection in one pass.
- **More built-in agent presets** — the prompt bar's spawn list now recognises `Oh My Pi` (`omp`) and `Cursor` (`agent`) alongside the existing agent commands.

### Changed

- **Settings → Models overhauled** — the AI & Voice settings area has been redesigned around provider cards, per-provider readiness states, live/curated catalog status pills, provider-specific key labels, and local-provider server URL management.
- **Voice refinement and AI commit messages now follow the selected provider** — both features use the active provider/model pair from Settings, retry other curated models from the same provider when appropriate, and no longer silently depend on OpenRouter.
- **AI key handling generalized** — provider keys are now stored per provider in `localStorage` as the app's primary store, with a best-effort mirror into the OS keychain. Existing OpenRouter keys migrate forward automatically.
- **Terminal pane titles are smarter** — agent panes now track a dedicated pane title, parse terminal-title escape sequences, and prefer actual response summaries over generic labels when deciding what to show in the floating pill header.
- **Aux panel sizing relaxed** — the right-hand auxiliary panel now defaults to `500px` wide instead of `700px`, and restored layouts are clamped with a much lower minimum width so compact layouts survive reopen/restore more gracefully.
- **Agent focus actions are more reliable** — terminal attention/focus actions now use an unconditional terminal-view helper, so jumping back to a waiting agent always lands on the terminal instead of toggling the previous aux panel back open.

### Fixed

- **File explorer click-away dismissal** — inline new-file/new-folder inputs, inline rename inputs, and the file-explorer context menu now dismiss cleanly when you click elsewhere. They no longer linger onscreen or implicitly confirm from a blur.
- **Agent conversation summaries in pane headers** — when an agent run completes, Spacron now flushes any buffered terminal output before finalizing the command block, summarizes the completed response, and writes that summary back into session state. This fixes panes getting stuck on generic project-folder titles like `Freedom` instead of the agent's actual conversation summary.
- **Pasted and injected image attachments under CSP** — prompt-bar image chips now decode `data:` URLs locally instead of trying to `fetch(dataUrl)`, which Chromium routed through `connect-src` and blocked. Images inserted from paste or preview capture now attach reliably under the app's CSP.
- **Source Control AI actions now respect provider configuration** — commit-message generation now shows the correct setup guidance for the selected provider, including missing local server URLs for Ollama and LM Studio.
- **Explorer selection state is cleaned up correctly across restores/resets** — workspace restore and full-store resets now rebuild and clear the multi-selection set consistently instead of only tracking the single active path.

### Security

- **Provider-aware request validation** — the Rust AI backend now validates provider IDs, local server URLs, and model IDs before sending requests, including stricter safeguards for URL-based local providers and Google models whose IDs are embedded in request paths.
- **Broader secret redaction** — backend error handling now redacts `sk-`, `sk-ant-`, `AIza`, and `gsk_` style credentials, and provider request errors are stripped of sensitive request URLs before they reach the frontend.
- **Safer Google provider requests** — Google API keys are now sent via headers instead of query-string URLs, reducing the chance of accidental key leakage through logs or surfaced transport errors.

## [0.1.9] - 2026-06-02

### Added

- **Attach images from the file picker** — picking an image through the prompt bar's attach-files dialog now adds it as a preview chip (the same thumbnails you get from pasting or drag-and-drop) instead of inserting a raw path string. The chip references the exact file on disk, so the agent reads the original image rather than a re-saved copy, and images can be attached even with no project open (only pasted images, which must be written to `.spacron/attachments`, still require one). Non-image files are still inserted as plain paths, now routed through the shared quoting helper so they're only quoted when the path contains spaces. Backed by `img-src blob:` in the Content-Security-Policy so the in-memory preview can render.
- **Wider image-format coverage** — the image detector and MIME mapping now recognise APNG, SVG, the `.jpe`/`.jfif` JPEG aliases, and `.cur` cursors, and pasted clipboard images map their MIME type to a clean file extension (so `image/svg+xml` saves as `.svg` instead of a mangled `svgxml`).

### Changed

- **Responsive title bar** — the centre breadcrumb is now a real flex item that shrinks and truncates with an ellipsis between the navigation and the right-hand controls, instead of being absolutely centred where it overlapped the search bar at medium window widths. As the window narrows the bar progressively condenses: the brand label and search hint trim first, then the note-taking trio (daily note, quick capture, scratchpad), then back/forward navigation and source control, leaving the essentials (home, sidebar toggle, search, settings, window controls) visible the longest. Every hidden action still has a keyboard shortcut, so nothing becomes unreachable.

## [0.1.8] - 2026-06-01

### Added

- **Image viewer in the editor** — opening an image file (PNG, JPG, GIF, WebP, BMP, ICO, AVIF, TIFF) now renders it in a dedicated viewer instead of loading raw bytes into the code editor. A metadata bar shows the file name, format, pixel dimensions, and file size, and the image sits on a checkerboard stage so transparency is visible. Backed by a new `fs_read_binary` Tauri command (capped at 50 MB) that streams the file into an in-memory object URL; editor files now carry a `kind` (`text` | `image`) and those URLs are revoked when the tab closes or the editor reloads so nothing leaks. Markdown preview, formatting, save, and the cursor/encoding readouts in the status bar are all suppressed for image tabs.

### Changed

- **Drag a terminal pane to split, not just swap** — dragging a pane by its title bar now drops it onto an edge (left, right, top, or bottom) of the pane under the cursor and inserts it there, rather than only swapping the two panes' positions. The drop target is chosen from where the cursor sits within the hovered pane, and column/cell percentages are renormalised so the grid stays balanced.
- **Layout picker fills every pane** — choosing a split layout now opens a live terminal in each newly revealed pane (using the project's starting directory) instead of leaving empty "Open terminal" placeholders; panes that already hold a session keep it.
- **Editor tab icons** — file-type tabs now show compact text badges (IMG / RS / TXT) in place of the previous emoji glyphs.

### Fixed

- **Closing a pane reclaims its space** — closing a terminal pane now removes its cell from the mosaic so the surrounding panes expand to fill the gap, instead of leaving a dead "Open terminal" placeholder behind. Emptied columns are dropped and the remaining panes rebalanced; the very last pane is always kept (reset to an empty placeholder) so the grid can never end up with zero panes.
- **Ghost panes when closing several terminals quickly** — `killSession` now updates the authoritative project state synchronously, before the asynchronous PTY teardown. Previously the slower teardown let a stale pane-assignment array re-broadcast, and the add-only mosaic reconcile would resurrect undismissable "Open terminal" placeholders when several panes were closed in quick succession.
- **Pasted image attachments** — images pasted into the prompt bar now get a unique name (timestamp plus a random suffix) with their real file extension, so simultaneous pastes can't collide or be misread by the agent. Saved paths are only quoted when they contain spaces (cleaner for agent TUIs than always single-quoting), and failures now surface an error toast — plus a warning when no project is open — instead of silently dropping the image.

## [0.1.7] - 2026-05-31

### Added

- **File explorer — inline new file / folder** — creating a file or folder now shows a focused inline input nested directly beneath the target folder, rather than a single input pinned to the workspace root. The target folder auto-expands so the input is visible, and the create state now lives in the explorer store so it behaves identically from the header buttons, the right-click context menu, and the keyboard. Confirm with Enter or by clicking away; cancel with Escape.
- **Native desktop notifications** — background notifications now go through the Tauri notification plugin (`@tauri-apps/plugin-notification`) instead of the WebView's `Notification` API, with the matching `notification:default` capability and Rust plugin registration. OS notifications are raised only when the app window is unfocused — when Spacron is in the foreground the in-app toast already covers it — and the granted permission is cached so the OS isn't re-queried on every toast.

### Fixed

- **File explorer — new files and folders appear instantly** — creating a file or folder no longer requires a manual refresh before it shows up in the tree. `refreshParent` and its path helpers normalised paths to forward slashes in some places but compared them against the OS's native backslash paths in others, so on Windows the in-place tree update silently matched nothing and the entry stayed hidden until a reload. Path comparisons are now separator-insensitive, and the parent folder is rebuilt in place (preserving the expansion state of any nested folders), so the new entry appears immediately.

## [0.1.6] - 2026-05-31

### Added

- **Frosted glass transparency (Warp-style)** — implemented a premium semi-transparent frosted glass aesthetic throughout the application. Users can adjust interface transparency using the global slider. All panels (Scratchpad, HTTP Client, Tasks, Run History, Merge/Review, Snapshots) and popups/menus (Workspace and Project Switchers, File Explorer context menu, Microphone Permission dialog, Command Palette, and Terminal panes/title bars) are now fully styled and aligned with this transparent aesthetic.
- **Opaque performance mode** — when the transparency slider is set to 0, transparency is completely disabled (using solid backgrounds and disabling all backdrop blurs) for maximum performance and legibility.
- **High-contrast readability tweaks** — automatically boosted secondary and muted text/icon color contrast and added a subtle readability-enhancing drop shadow to non-code text elements when transparency is enabled (excluding CodeMirror editors, xterm terminals, and Markdown code blocks to ensure text remain pixel-sharp).

## [0.1.5] - 2026-05-30

### Added

- **Choose which files go into a commit** — the Source Control panel now shows a checkbox beside every changed file. Uncheck the ones you want to leave out of the next commit; a header checkbox toggles all of them (with an indeterminate state when only some are selected). Newly-appeared changes default to selected and your choices persist as the status refreshes, and the commit button stays disabled until at least one file is selected. Under the hood, `workspace_git_commit` now takes an optional list of paths and stages/commits only those (using a `--` separator so paths beginning with `-` aren't read as flags, plus per-path validation); passing no list keeps the previous "commit everything" behaviour.

### Changed

- **Prompt bar follows the focused terminal** — the floating prompt bar now targets whichever terminal you last clicked or focused, rather than tracking its own separate selection. The "pinned" indicator only shows when you deliberately aim the bar at a different terminal via the target picker; otherwise it auto-follows the active pane and falls back to the most recently used agent when no pane is focused.
- **Multi-line prompts to every agent** — the bracketed-paste send path, which keeps multi-line prompts intact and stops the agent REPL from swallowing the Enter key, now applies to all agent presets instead of only Codex.

### Fixed

- **Pane rearrangement persists per project** — swapping two terminal panes is now written to the active project's saved state, so the new arrangement survives switching workspaces and reopening the project instead of living only in transient state.

## [0.1.4] - 2026-05-30

### Added

- **Multiple workspaces** — a workspace switcher now lives in the sidebar header. Click it to switch between your workspaces (the active one is marked with a coloured dot and a check), rename the current workspace inline with the pencil button, or create a new one. Each workspace keeps its own set of project folders.
- **Named workspace creation** — creating a workspace now opens a dialog to name it (Enter to create, Esc to cancel) instead of generating a placeholder name. Reachable from the welcome screen, the switcher, the command palette, and the `Ctrl+N` shortcut.
- **Spawn agents from the prompt bar** — a new spawn button in the floating prompt bar opens a panel of AI-agent presets. Dial in how many of each agent you want, and they launch together — each into its own available terminal pane — with a count badge while you queue them up.
- **Drag to rearrange terminal panes** — grab a pane's title bar to reposition it within the grid. Uses a pointer-based drag (not native HTML5 drag-and-drop, which is unreliable inside the Tauri webview).
- **Agent name in pane titles** — a terminal running a detected agent CLI now shows the agent's display name (e.g. `· Claude Code`) next to its label.
- **"What is a workspace?" card** — the welcome screen now explains the workspace-groups-projects model with a small diagram.

### Changed

- **Quick Run moved out of the sidebar** — the dedicated Quick Run sidebar tab and panel have been removed; launching agents now flows through the prompt bar's spawn panel. Persisted layouts that still pointed at the `runs` tab fall back to the file explorer.
- **Terminal pane allocation** — when no empty pane is available, opening a terminal now appends a new pane slot instead of overwriting the active pane, which previously orphaned the session already running there.
- **Trimmed agent preset list** — removed the Gemini, Aider, and Cursor entries from the built-in agent presets, keeping the actively used set (Codex, Claude Code, Antigravity, OpenCode, Pi, Dev Server, GitHub Copilot).

### Changed — License

- **Relicensed to AGPL-3.0-only** — Spacron is now licensed under the GNU Affero General Public License v3.0 (reverting the brief Apache-2.0 switch). The `LICENSE` file, README, `package.json`, and `Cargo.toml` are updated to match.

## [0.1.3] - 2026-05-29

### Fixed

- **Workspace persistence — state lost on reopen (root cause)** — every time a folder was opened the backend assigned it a brand-new random project ID, but all per-project state (terminal sessions, layout, open files) is keyed by that ID. So reopening a workspace — whether after switching to another workspace or restarting the app — produced a new ID that could never be matched back to the saved state, leaving you with a fresh, empty workspace. Project IDs are now derived deterministically from the canonicalized folder path, so the same folder always maps to the same ID. Coming back to a workspace now restores its terminals, layout, and open files; within the same app session the live terminal (PTY) processes are still running and are reattached.
- **Workspace persistence — terminals restored into wrong slots** — restored sessions are now recreated only for panes that actually held one and are placed back in their original pane slot, leaving previously-empty panes empty (legacy saved state is treated as occupied for backward compatibility).
- **Workspace persistence — closing via Home** — the Home button now explicitly saves the active project's state before returning to the welcome screen, so nothing captured in the last moment before closing is lost.
- **Quick Run — clicking Run toggled the right panel** — launching an agent from the Run tab called the terminal-view toggle, which closed the right-hand auxiliary panel (or reopened it on a second click). The terminal is always visible, so running a command now focuses the target pane without disturbing the auxiliary panel.
- **Quick Run — agents launched into busy/active terminals** — agent runs now target a terminal that is genuinely idle and not the active/focused one, preferring empty or idle non-active panes. When every pane is busy or already running an agent, a brand-new terminal is opened instead of hijacking one that's in use. The confirmation toast now names the terminal the agent actually launched in.
- **Terminal "in use" detection for manual commands** — a non-empty command typed directly into a terminal now flags that session as busy (previously only prompt-bar/agent runs did). Agent runs no longer target a terminal that is actively running a hand-started command such as a dev server or test watcher.

## [0.1.2] - 2026-05-29

### Added

- **Microphone permission dialog** — replaced the WebView2 browser-bar permission prompt with a native-feeling in-app dialog. The dialog appears before `getUserMedia` is called when microphone access hasn't been granted yet, then remembers the decision so it never interrupts again.
- **File explorer — inline rename** — right-clicking a file or folder and choosing Rename now shows an inline focused input directly in the tree, pre-filled with the current name. Confirm with Enter or by clicking away; cancel with Escape.
- **File explorer — editor tab integration** — renaming a file that is open in the editor silently updates its tab path and cache entry so work isn't lost. Deleting a file (or a folder) closes any open editor tabs for that path automatically.
- **File explorer — operation feedback** — rename and delete now show success and error toast notifications instead of failing silently.

### Fixed

- **Workspace switching — state loss on return** — switching to a different workspace no longer wipes the previous workspace's state. Terminal sessions, open editor files, layout, and preview state are all saved before the switch and fully restored when you return. Live PTY processes continue running in the background throughout.
- **Workspace switching — duplicate terminal sessions** — returning to a project that still had live sessions in memory no longer spawns a second set of sessions on top of the existing ones.
- **Snapshot restore — wrong view** — loading a snapshot saved while in terminal view incorrectly toggled to the last aux panel instead of staying on terminal. The restore path now writes directly to the layout store, bypassing the toggle logic in `setActiveView`.
- **Snapshot restore — sidebar width ignored** — `sidebarWidth` was captured in every snapshot but never applied on restore. It is now restored correctly.

### Security

- **Input validation for file rename** — the rename input now rejects filenames containing path separators (`/`, `\`) or null bytes, and enforces the 255-character POSIX limit, preventing path traversal attempts from reaching the Rust layer.
- **Persisted state sanitisation** — `loadProjectStateFromStorage` now validates all fields before they flow to Tauri invoke calls: file paths reject null bytes and control characters (`\x00–\x1f`), terminal role values are restricted to `/^[\w\-. ]{0,63}$/` (blocking terminal escape-code injection), and the layout sub-object has its numeric fields range-clamped (`sidebarWidth` 100–600, `auxPanelWidth` 700–2000, `auxEditorHeight` 10–90).
- **Snapshot value validation** — `sidebarWidth` clamped to `[100, 600]`; `targetPort` validated to `[1024, 65535]`; `previewUrl` restricted to relative paths or `localhost`/`127.0.0.1` URLs, preventing a crafted snapshot from redirecting the preview proxy to an unintended port.
- **Layout store allowlists** — `sanitiseActiveView()` and `sanitiseSidebarTab()` added as explicit Set-based allowlist validators, applied at all three restore paths (snapshot restore, cached project restore, persisted project restore). Unknown values fall back to safe defaults rather than being applied as-is.
- **Scoped localStorage clear** — "Reset App Data" now removes only `spacron_*` and `forge_*` prefixed keys instead of calling `localStorage.clear()`, which would have wiped any other data stored under the same WebView origin.
- **Snapshot IDs** — replaced `Math.random()` with `crypto.randomUUID()` for cryptographically random snapshot identifiers.
- **Error messages** — rename and delete error toasts now use `err?.message` instead of the raw error object, preventing potential path disclosure in error strings.
- **Permission request race condition** — calling `requestPermission` a second time before the user responds to the first no longer leaves the original promise permanently unresolved; the in-flight request is now auto-denied before the new one is shown.

## [0.1.1] - 2026-05-29

### Added

- **AI commit message generation** — sparkle button in the Source Control panel generates a conventional commits message (subject line + body) from the current diff and untracked file list using OpenRouter. Uses the same model selected for voice refinement.
- **Quick Capture** — Ctrl+Shift+Space opens a modal to rapidly capture notes into the current project without switching panels.
- **Daily Notes** — Ctrl+Shift+D opens a per-project daily note. Notes are stored in `.spacron/` alongside other project data.
- **Onboarding walkthrough** — first-time users see an interactive guide covering the key panels and shortcuts.
- **Tasks panel — Kanban layout** — Tasks moved from the sidebar into a full right-panel Kanban board with three columns (To Do, In Progress, Done), colour-coded badges, and drag-and-drop support. Tasks are persisted per-project in `.spacron/tasks.json`.
- **Voice refinement** — AI-powered cleanup of dictated voice transcripts using OpenRouter. Strips filler words, converts spoken symbols to their character equivalents (`fat arrow` → `=>`, `double equals` → `==`, etc.), preserves technical identifiers verbatim, and structures multi-step instructions into lists. Falls back to local cleanup when no API key is set.
- **OpenRouter API key management** — new AI & Voice section in Settings for saving the OpenRouter key, picking the preferred model, and toggling voice refinement on/off.
- **Voice refinement feedback** — mic button shows a teal spinner while the AI is processing (distinct from the red recording state). A "Prompt refined by AI" toast confirms when the AI call succeeded vs fell back to local cleanup.
- **Preview → prompt bar image injection** — clicking the inspector's screenshot button in the Preview panel inserts the captured element image directly as an image chip in the floating prompt bar.

### Changed

- **Auxiliary panel architecture** — right panel now supports three concurrent views (editor, preview, tasks, HTTP client, review) with tabbed switching and animated pill-style active indicator. Default panel width increased from 400 px to 700 px.
- **Sidebar navigation** — active tab now has an animated pill indicator.
- **OpenRouter key storage** — moved from OS keychain (unreliable on Windows) to `localStorage`, which is sandboxed to the app and works consistently. The key migrates automatically from the old `forge_openrouter_api_key` key to `spacron_openrouter_api_key` on first launch.
- **Voice refinement prompt** — completely rewritten for developer context: understands prompts directed at AI coding agents, terminal commands, and technical notes. Tone is direct and friendly.
- **Commit message prompt** — generates a proper subject line + blank line + detailed body instead of a single line. Token limit raised to 512.
- **Settings — AI & Voice** — key description updated to reflect localStorage storage. Status text updated ("Key saved. AI features are ready." / "No key saved yet."). Key input now accepts Enter to save.
- **Source control empty states** — animated SVG illustrations for clean working tree and no commit history.
- **Source control loading** — shimmer skeleton loaders while status and history are fetching.
- **Floating prompt bar** — text injected programmatically is now appended to existing input rather than replacing it.
- **Vite config port parsing** — block comments on single lines no longer confuse the port extractor.

### Fixed

- Floating prompt bar inflated to the wrong height on first app launch because `scrollHeight` was measured before the custom editor font loaded. Height is now pinned to the minimum when the input is empty.
- `git add` stderr was not sanitised before reaching the frontend, leaking absolute repository paths in commit error messages.
- OpenRouter error response bodies are now scrubbed for `sk-...` shaped strings before being shown to the user.
- Voice prompt length check used byte count (`str.len()`) instead of character count, incorrectly handling multi-byte UTF-8 input near the 32 000 limit.
- `TasksPanel`, `NotesPanel`, and `FloatingNotepad` were not updated when `refineVoicePrompt` return type changed from `string` to `RefinementResult`.

### Security

- **Path traversal protection** — new `validate_relative_path()` in the file system command module rejects `../`, null bytes, and `--` prefix patterns.
- **Branch name validation** — `validate_branch_name()` rejects empty names, special characters, and double-dot patterns before any git subprocess is spawned.
- **Secrets module** — dedicated Rust module for OpenRouter API key operations. Keys are never logged or returned to the frontend; error bodies are scrubbed before surfacing.
- **`git add` stderr sanitisation** — absolute paths in staging errors are now redacted consistently with all other git error paths.

## [0.1.0] - 2026-05-28

### Initial public release

**Terminal**
- Full PTY terminal with xterm.js — real shell, not a simulated one
- Multi-pane layouts: 1, 2, 3, 4, and 9-pane grids with split-right and split-below
- Pane role labels (Server, Tests, Build, Agent, Git, Custom)
- Floating prompt bar with drag-and-drop and paste-image file attachment
- Command output blocks (Warp-style history strip per pane)
- Smart dev server detection — auto-offers to open in Preview
- Run history with search, filter, replay, and output capture
- Session persistence — terminal roles and layouts restored on reopen
- Per-project terminal isolation — switching projects restores the correct shell state without destroying live sessions or leaking another project's panes

**Editor**
- CodeMirror 6 with syntax highlighting for 15+ languages
- Vim mode, minimap, format-on-save, word wrap
- Codebase full-text search with 200 ms debounce

**Preview**
- Built-in HTTP/WebSocket proxy — routes local dev server through a managed port
- DOM inspector — click any element to inspect styles, attributes, and ancestors
- Markdown preview with syntax highlighting

**Git**
- Status, staged/unstaged diffs, commit history with graph
- Commit, push, fetch, discard changes
- Branch management — create, checkout, delete local and remote branches
- Branch display in status bar

**HTTP Client**
- Save and replay HTTP requests per project
- Full headers, body (JSON/text/form), method selection
- Response viewer with pretty-print and copy

**Workspace**
- Named workspaces with multiple open projects
- Multi-root file explorer with immediate folder-expand repainting
- Workspace snapshots — save and restore layout state
- Floating scratchpad (Markdown, per-project)
- Customisable keyboard shortcuts
- Per-project layout isolation — panel visibility, active view, sidebar state, and dimensions are fully scoped per project
- Home navigation preserves project state — clicking the home button no longer clears open project data

**Settings**
- Theme persistence — selected theme correctly restored on restart
- Reset App Data button in Settings → About with two-click confirmation to prevent accidental resets
- UI zoom (keyboard-driven, persisted)
- Multiple built-in themes + custom theme editor with import/export

**Auto-updater**
- In-app update check with correct Tauri v2 capability configuration
- Signed update verification via minisign
- App relaunches automatically after update installs

**Notifications**
- Toast notifications with slide-in / slide-out animations
- System desktop notifications (opt-in)
- Duplicate suppression — same message+type won't stack
- Maximum of 5 visible toasts to prevent viewport overflow

**Security**
- Path traversal prevention via canonicalization throughout all filesystem commands
- Null-byte path injection blocked in git file operations
- Shell path quoting hardened — attached file paths use single-quote escaping to prevent terminal injection
- HTTP client confirms before sending requests to private/loopback addresses
- Preview proxy inspector script only injected into local dev server responses, never external sites
- PTY write rate limiting — 1 MB/s per session
- All `{@html}` output sanitised with DOMPurify
- Signed auto-updates with minisign public key verification

**App**
- Tauri v2 (Rust + Svelte 5) — no Electron, no Node.js runtime
