# Memory index

Every note in `.spacron/memory/`, one line each. **Read this file first, then open
only the notes your task touches** — the full set is ~230 KB, far too much to load
up front. When you add a note, add its line here in the matching section.

- [memory-index](memory-index.md) — how this index works, and why the notes are deliberately not merged into one file

## Agents, delegation & review

- [agent-spawn-picker](agent-spawn-picker.md) — the Spawn Agents modal; where the CLI presets live
- [agent-placement-gate](agent-placement-gate.md) — every spawn asks worktree-vs-main-repo first, and why it's a blocking dialog
- [agent-brand-marks](agent-brand-marks.md) — agent logos in room chrome; the `useAgentBrand` resolution layer; codebuff/freebuff share one official sparkle mark (`freebuff.png`)
- [worker-naming](worker-naming.md) — who names an agent: pool in TypeScript, MCP decision in Rust
- [agent-work-staging-vocabulary](agent-work-staging-vocabulary.md) — "Stage" means two different things; keep them labelled apart
- [fleet-panel-placements](fleet-panel-placements.md) — Fleet rows come from agent sessions, not worktrees
- [review-loop-design](review-loop-design.md) — the orchestrator is the reviewer; no spawned Reviewer agent
- [reviewer-verdict-signals](reviewer-verdict-signals.md) — APPROVED / BOUNCE BACK parsing, and the transcript-echo trap
- [review-panel-diff-layout](review-panel-diff-layout.md) — two diff surfaces on purpose; don't add a third
- [completion-announcements](completion-announcements.md) — how a turn's end is detected and surfaced to the user
- [agent-inbox-unread](agent-inbox-unread.md) — the inbox behind the toasts; why "read" and "dismissed" must stay separate bits
- [agent-usage-meters](agent-usage-meters.md) — rate-limit meters + detection table: the verified endpoints, never-refresh rule, the three keychain CLIs (Copilot probe, Gemini settings marker, Cody env), the 9 live providers (Cursor via web session + Amp via secrets.json, both 2026-08-12), and why Copilot/Droid/Antigravity stay detection-only
- [tasks-kanban](tasks-kanban.md) — the tasks board: rich fields (priority/due/notes/order), drag & drop, and the task→agent "Run with agent" link
- [web-session-credentials](web-session-credentials.md) — OpenCode + MiniMax + Cursor meter through a cookie lifted from a real login window; Tauri DOES have a cookie jar (the old "impossible" note was wrong), plus the MiniMax remaining-vs-used inversion
- [agent-account-switching](agent-account-switching.md) — several logins per CLI: switching sets `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, never writes a credential; where each CLI really records the account email; why Add Account must run the login itself
- [agent-install-links](agent-install-links.md) — where "Not installed" rows send you; every URL is fetched, never guessed, and unknown CLIs fall through to a search
- [antigravity-usage](antigravity-usage.md) — why Antigravity gets no meter: keychain-only creds, one quota RPC that lies and one that's API-key gated; re-verified 2026-08-12 (still closed)
- [bell-osc-false-positives](bell-osc-false-positives.md) — a BEL inside an OSC sequence is not a turn end
- [standing-brief-sources](standing-brief-sources.md) — the agent brief has TWO builders; editing one leaves half the presets stale; since 2026-08-12 a THIRD surface: `AGENT_EXTRA_RULES_FILES` native files for aider/cn/kiro-cli, leaving only traecli/cody on the paste channel
- [agent-rules-file-verification](agent-rules-file-verification.md) — 2026-08-12: which new registry agents really read AGENTS.md/CLAUDE.md (binary scans + docs); GEMINI.md gap; the .env non-question; pi/omp/prime-agent/vibe/autohand/ante moved to the file channel; the omp Bun-shim probe gap; native-extra tier (aider→CONVENTIONS.md+.aider.conf.yml, cn→.continue/rules/, kiro-cli→.kiro/steering/) + rovo/mimo/openclaude/openclaw/hermes moved; bonus surfaces (cursor→.cursorrules+.mdc, copilot→copilot-instructions.md, hermes→.hermes.md, goose→.goosehints, cline→.clinerules), traecli bonus .trae/rules write but stays on paste, no project .continue/config.yaml
- [terminal-agent-launches](terminal-agent-launches.md) — agents launch into a real PTY via `portable-pty`
- [agent-permission-mode](agent-permission-mode.md) — Yolo/Manual: the three override layers, the one spawn path that applies them, and why the per-row toggle must be idempotent
- [dev-tools-roadmap-priorities](dev-tools-roadmap-priorities.md) — read "## The plan", not the section numbering
- [orphaned-agent-processes](orphaned-agent-processes.md) — killing a pane leaves the whole Codex tree running (sandbox bypass + live file handles, dead parent PID); they read as ~0 MB because they're paged out, so measure commit charge not working set

## Git, worktrees & source control

- [agent-worktrees](agent-worktrees.md) — the two creation paths, and who owns a worktree
- [agent-worktree-staging](agent-worktree-staging.md) — getting worktree work into the main checkout; never `merge --no-commit`
- [git-command-threading](git-command-threading.md) — every git command must be `#[tauri::command(async)]`
- [porcelain-path-quoting](porcelain-path-quoting.md) — always read `git status` with `-z`; the default format quotes paths with spaces and breaks staging
- [github-auth](github-auth.md) — device flow + gh-CLI import alongside PAT, and what must not change
- [commit-message-grace-window](commit-message-grace-window.md) — the commit box belongs to the user for 2 minutes
- [source-control-panel-layout](source-control-panel-layout.md) — Changes and Commits each own their scroll area
- [project-footprint](project-footprint.md) — what Spacron is allowed to write into a user's project

## MCP & agent transport

- [mcp-architecture](mcp-architecture.md) — the in-process HTTP+SSE server for agent-to-agent messaging
- [mcp-agent-loop-gaps](mcp-agent-loop-gaps.md) — Spacron provides tools; the CLI agent owns the loop
- [mcp-sse-response-routing](mcp-sse-response-routing.md) — responses must return over the stream; the "auth failure" is a red herring
- [mcp-project-root-wiring](mcp-project-root-wiring.md) — how the server learns the project root, and its single writer
- [mcp-prompt-delivery](mcp-prompt-delivery.md) — never write to the PTY; the bracketed-paste sequence
- [mcp-integration](mcp-integration.md) — the old internal MCP glue was removed; do not re-add it
- [agent-browser-tools](agent-browser-tools.md) — agents get a browser from Playwright MCP, not from us
- [browser-window-and-mcp-control](browser-window-and-mcp-control.md) — the MCP browser tools are gone; what outlived them
- [security-trust-boundaries](security-trust-boundaries.md) — trust boundaries, and the guard every external-URL webview needs
- [security-audit](security-audit.md) — 2026-08-07 audit: both mediums FIXED (remote token → keychain, CI tag validation + SHA-pinned actions); 9 lows still open; report in project root

## Terminal

- [terminal-pane-lifetime](terminal-pane-lifetime.md) — a `TerminalPane` must never unmount while its session is alive
- [terminal-renderers](terminal-renderers.md) — default is `canvas`; the "transparent background ghost" claim is false; WebGL slabs dim/italic/underline text over a transparent surface, so it gets an opaque one
- [terminal-is-always-dark](terminal-is-always-dark.md) — the terminal never follows light/dark, because OSC 11 theme detection is a one-shot negotiation a running TUI can't redo; the four places that must agree
- [terminal-startup-and-agent-split](terminal-startup-and-agent-split.md) — startup shell, cwd, and shells vs agents in one session list
- [os-drag-drop-routing](os-drag-drop-routing.md) — OS file drops hit every mounted pane; `dropPositionToCss` + hidden-rect guard, and why raw position comparisons stay banned
- [running-two-instances](running-two-instances.md) — why a dev build starts but never opens a window

## Editor

- [save-shortcut](save-shortcut.md) — Ctrl+S is AppShell's keybinding (Settings-rebindable); never add a second handler in EditorPanel; zustand `saveActiveFile` mirrors compat `saveFile` via `fs_write_file`; `formatCode` takes a path, and `formatActiveFile` still passes a language; auto-save setting (1s debounce, silent) reuses `saveFile` and must be declared in both settings stores

## Workspace shell, rooms & visuals

- [floating-prompt-bar-alt-voice](floating-prompt-bar-alt-voice.md) — Alt→voice is CLICK-armed (pointer-down in the shell only); never arm on focus, `focusInput()` fires programmatically in a dozen places
- [split-room-slots](split-room-slots.md) — Split's ordered slot list; empty is the "unarranged" sentinel
- [split-transition-smoothness](split-transition-smoothness.md) — the five causes of Focus↔Split residue
- [view-transition-blend-contract](view-transition-blend-contract.md) — the `plus-lighter` contract; read before any `::view-transition` pair
- [motion-tokens](motion-tokens.md) — never hardcode a duration or bezier; pick a tier
- [glass-panel-recipe](glass-panel-recipe.md) — the canonical frosted-panel recipe
- [floating-panel-scroll-contract](floating-panel-scroll-contract.md) — popovers are a rigid frame with ONE scroller; pinned chrome, `min-height: 0` bodies, size caps on the card, and the three global.css scroll lists every scroller must be registered in
- [panel-edge-and-tint](panel-edge-and-tint.md) — 2026-08-12: panels are TINTED now, not see-through (the `background: transparent` other notes quote is gone); the tint + traveling edge light are defined ONCE in global.css "Panel surfaces" and cover the floating panels too (incl. the resource panel, same day), plus the room-header icons
- [focus-rail-pile](focus-rail-pile.md) — the card-deck rail; since 2026-08-12 the cards ARE the live panes (scaled, never reflowed — a reflow would resize the PTY), why nothing above a panel may carry a transform, and the per-card glass rule
- [editor-room-focus](editor-room-focus.md) — visible is not on stage; reveal goes through the room system
- [per-project-persistence](per-project-persistence.md) — `PersistedProjectState` and its two restore paths
- [right-drawer-per-project](right-drawer-per-project.md) — the right drawer is project-scoped now; `rightDrawerToolOf` is the one precedence definition, and why restore uses `applyRightDrawerTool` not `setRightDrawerTool`
- [background-precedence](background-precedence.md) — the user's wallpaper outranks the theme's
- [accent-and-icon-treatment](accent-and-icon-treatment.md) — the accent is graphite not a hue; the 4 files that define it, why `--on-accent` is mandatory, bump the brand migration, the blanket svg rule that overrides icon colour, and why solid themes (forge-dark/light) miss every wallpaper-gated rule
- [badge-tone-tokens](badge-tone-tokens.md) — badge tones ("Signed in"/"Installed") use `var(--success)`/`var(--warning)`, never hardcoded hex; the three still-hardcoded `#34d399`/`#fbbf24` spots
- [background-wallpapers](background-wallpapers.md) — the wallpaper pairs, and how to add one (ffmpeg recipe; presetThemes.ts is the only file to touch)
- [background-prompts](background-prompts.md) — the prompt source file and the final 22-prompt set
- [editor-font-vars](editor-font-vars.md) — `--editor-font-size`/`--editor-font-family` are published on the root in App.tsx; derive code-surface sizes from them instead of hardcoding px
- [global-tooltips](global-tooltips.md) — one delegated listener replaces native tooltips app-wide
- [diagnostics-and-problems-panel](diagnostics-and-problems-panel.md) — where diagnostics come from and why the panel exists
- [native-preview-overlay](native-preview-overlay.md) — the in-panel native webview was removed; don't reintroduce it
- [preview-proxy](preview-proxy.md) — the preview "browser" is a loopback proxy
- [design-mode-element-prompt](design-mode-element-prompt.md) — "Add Element to Chat" is already Design Mode; the two inspector scripts that must stay in step
- [premium-feel-fixes](premium-feel-fixes.md) — notifications, shell jank, project-switch cost, modal key leaks
- [premium-theming-spec](premium-theming-spec.md) — CNVS deep-dive + the theming plan: aura tokens, wallpaper crossfade, elevation tokens, Studio pair
- [orca-competitor](orca-competitor.md) — Orca (MIT, onorca.dev): its published style guide + tokens, and why its "recede and frame" thesis contradicts Nightglass
- [orca-stats-usage-page](orca-stats-usage-page.md) — Orca Settings → Stats page: token/cost analytics, the scanner→store→IPC→pane flow, pricing table, and the minimal Spacron cut
- [agent-activity-stats](agent-activity-stats.md) — agents spawned / time worked / turns: a recorder, not a scanner (Spacron persists no session history); the two call sites, the dedupe set, and why there is no "PRs created" card
- [usage-stats-port](usage-stats-port.md) — the Stats tab implementation: six CLIs in one provider-keyed ledger (Claude, Codex, OpenCode, Pi, OMP, Command Code); which CLIs have no token data at all (Droid/Kimi verified empty 2026-08-12) and why Copilot is the near miss, Codex's cumulative-total trap, and how a session's reported model is chosen
- [resource-monitor](resource-monitor.md) — titlebar CPU/RAM chip + dropdown (2026-08-12): persistent sysinfo sampler (CPU deltas), the shell-vs-agent process-TREE gotcha, 2s polling, `sessionId` join to the terminal store, kill via `killSession`; round 2 groups rows by project with per-project disk footprint (`project_disk_usage` walkdir TTL cache, `groupSessionRowsByProject`); round 4 per-project RAM share + watchdog toasts; round 3 Orca close-all/clear-exited ports and the tree-kill fix; rows show name + CPU/RAM bars, no pid/proc (live-tickers)
- [live-tickers](live-tickers.md) — shared LiveTicker replaces every manual Refresh/Rescan button (usage panel 2m while open, resource 2s + disk 60s while open, stats tab 60s auto-rescan, agents pane 2m); the cadences, the guards (enabled/hidden/in-flight), and what CSS died with the buttons; resource rows slimmed to name-only
- [mobile-emulator-pane](mobile-emulator-pane.md) — full design in docs/mobile-emulator-pane.md: backend (mobile.rs) already exists unbuilt-frontend; `android`/`ios` views are currently lies; scrcpy raw H.264 + serve-sim sidecar + MCP tools
- [emulator-encoder-is-the-bottleneck](emulator-encoder-is-the-bottleneck.md) — 2026-08-12 measurements: emulators have no hardware H.264 *encoder*, so `max_size` buys frame rate and bit rate buys nothing; MAX_SIDE 1024→720; why IPC/decode micro-optimisation is second-order; how to measure without fooling yourself. Re-measured 2026-08-13 with frame-gap percentiles
- [emulator-grpc-stream](emulator-grpc-stream.md) — 2026-08-13 spike: the emulator's HOST-side gRPC `streamScreenshot` is 4x scrcpy (p90 gap 272ms→46ms) because it skips the guest encoder; PNG format makes the raw IPC channel unnecessary; emulators only, scrcpy stays for physical devices
- [scrcpy-wire-protocol](scrcpy-wire-protocol.md) — the six things that silently break the Android stream (hex `scid`, fourcc codec id, dummy-byte handshake, control-socket ordering, AVCC-vs-Annex-B, per-start stream ids) + control-message layouts and measured injection costs
- [first-launch-maximized](first-launch-maximized.md) — app window opens maximized on first launch ever and persists `has_launched` flag
- [relative-window-minimize-size](relative-window-minimize-size.md) — unmaximizing or bringing window down resizes dynamically relative to monitor screensize (65% width x 85% height)

## Voice & realtime

- [voice-turn-taking](voice-turn-taking.md) — four causes of dropped and interrupted turns
- [voice-read-aloud](voice-read-aloud.md) — on-demand "read out what X said", resolved by agent name
- [realtime-voice-orchestrator-bridge](realtime-voice-orchestrator-bridge.md) — the voice model sends a rephrased instruction, not your literal words
- [openai-realtime-sdp](openai-realtime-sdp.md) — the SDP handoff and the pion `EOF` bug
- [grok-realtime-flow](grok-realtime-flow.md) — Grok is websocket + client secret, not SDP/WebRTC

## Media player

- [local-music-library](local-music-library.md) — the on-disk audio source and why it beat playlists
- [innertube-search-pagination](innertube-search-pagination.md) — continuation tokens; no Rust side to it
- [stream-safe-music-catalog](stream-safe-music-catalog.md) — removed; do not re-add

## Platform, build & housekeeping

- [electron-conversion-assessment](electron-conversion-assessment.md) — 2026-08-10: Tauri→Electron feasibility; Rust sidecar path reuses spacron-server; full rewrite is large (recommendation not taken)
- [stack-decision-tauri](stack-decision-tauri.md) — 2026-08-10 DECISION: staying on Tauri; what a re-litigation has to beat, and why agents get an external browser instead
- [release-process](release-process.md) — the five files carrying the version (Cargo.lock is tool-denied; regenerate it), and why `git push` 408s
- [cross-platform-status](cross-platform-status.md) — Windows / macOS / Linux audit against v0.7.5
- [bundle-chunking](bundle-chunking.md) — `manualChunks` silently defeats dynamic imports
- [test-suite-timing-sensitivity](test-suite-timing-sensitivity.md) — a test that fails in the full suite but passes alone is CPU contention, not a regression; why vitest is capped at 6 workers and `waitForAgentReady`'s 40ms test windows are the reason
- [dead-code-cleanup](dead-code-cleanup.md) — ~50 files of confirmed-dead code removed, and what went
- [licensing-and-docs](licensing-and-docs.md) — closed source by design; don't flip the repo public
