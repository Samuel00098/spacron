# Memory index

Every note in `.spacron/memory/`, one line each. **Read this file first, then open
only the notes your task touches** — the full set is ~230 KB, far too much to load
up front. When you add a note, add its line here in the matching section.

- [memory-index](memory-index.md) — how this index works, and why the notes are deliberately not merged into one file

## Agents, delegation & review

- [agent-spawn-picker](agent-spawn-picker.md) — the Spawn Agents modal; where the CLI presets live
- [agent-placement-gate](agent-placement-gate.md) — every spawn asks worktree-vs-main-repo first, and why it's a blocking dialog
- [agent-brand-marks](agent-brand-marks.md) — agent logos in room chrome; the `useAgentBrand` resolution layer
- [worker-naming](worker-naming.md) — who names an agent: pool in TypeScript, MCP decision in Rust
- [agent-work-staging-vocabulary](agent-work-staging-vocabulary.md) — "Stage" means two different things; keep them labelled apart
- [fleet-panel-placements](fleet-panel-placements.md) — Fleet rows come from agent sessions, not worktrees
- [review-loop-design](review-loop-design.md) — the orchestrator is the reviewer; no spawned Reviewer agent
- [reviewer-verdict-signals](reviewer-verdict-signals.md) — APPROVED / BOUNCE BACK parsing, and the transcript-echo trap
- [review-panel-diff-layout](review-panel-diff-layout.md) — two diff surfaces on purpose; don't add a third
- [completion-announcements](completion-announcements.md) — how a turn's end is detected and surfaced to the user
- [agent-inbox-unread](agent-inbox-unread.md) — the inbox behind the toasts; why "read" and "dismissed" must stay separate bits
- [agent-usage-meters](agent-usage-meters.md) — rate-limit meters + detection table: the verified endpoints, never-refresh rule, and the three keychain CLIs (Copilot probe, Gemini settings marker, Cody env) plus the provider list
- [tasks-kanban](tasks-kanban.md) — the tasks board: rich fields (priority/due/notes/order), drag & drop, and the task→agent "Run with agent" link
- [web-session-credentials](web-session-credentials.md) — OpenCode + MiniMax meter through a cookie lifted from a real login window; Tauri DOES have a cookie jar (the old "impossible" note was wrong), plus the MiniMax remaining-vs-used inversion
- [agent-account-switching](agent-account-switching.md) — several logins per CLI: switching sets `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, never writes a credential; where each CLI really records the account email; why Add Account must run the login itself
- [agent-install-links](agent-install-links.md) — where "Not installed" rows send you; every URL is fetched, never guessed, and unknown CLIs fall through to a search
- [antigravity-usage](antigravity-usage.md) — why Antigravity gets no meter: keychain-only creds, one quota RPC that lies and one that's API-key gated
- [bell-osc-false-positives](bell-osc-false-positives.md) — a BEL inside an OSC sequence is not a turn end
- [standing-brief-sources](standing-brief-sources.md) — the agent brief has TWO builders; editing one leaves half the presets stale
- [agent-rules-file-verification](agent-rules-file-verification.md) — 2026-08-11: which new registry agents really read AGENTS.md/CLAUDE.md (binary scans + docs); GEMINI.md gap; the .env non-question
- [terminal-agent-launches](terminal-agent-launches.md) — agents launch into a real PTY via `portable-pty`
- [agent-permission-mode](agent-permission-mode.md) — Yolo/Manual: the three override layers, the one spawn path that applies them, and why the per-row toggle must be idempotent
- [dev-tools-roadmap-priorities](dev-tools-roadmap-priorities.md) — read "## The plan", not the section numbering

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

## Workspace shell, rooms & visuals

- [split-room-slots](split-room-slots.md) — Split's ordered slot list; empty is the "unarranged" sentinel
- [split-transition-smoothness](split-transition-smoothness.md) — the five causes of Focus↔Split residue
- [view-transition-blend-contract](view-transition-blend-contract.md) — the `plus-lighter` contract; read before any `::view-transition` pair
- [motion-tokens](motion-tokens.md) — never hardcode a duration or bezier; pick a tier
- [glass-panel-recipe](glass-panel-recipe.md) — the canonical frosted-panel recipe
- [focus-rail-pile](focus-rail-pile.md) — the card-deck rail; geometry lives in two custom properties
- [editor-room-focus](editor-room-focus.md) — visible is not on stage; reveal goes through the room system
- [per-project-persistence](per-project-persistence.md) — `PersistedProjectState` and its two restore paths
- [background-precedence](background-precedence.md) — the user's wallpaper outranks the theme's
- [accent-and-icon-treatment](accent-and-icon-treatment.md) — the accent is graphite not a hue; the 4 files that define it, why `--on-accent` is mandatory, bump the brand migration, the blanket svg rule that overrides icon colour, and why solid themes (forge-dark/light) miss every wallpaper-gated rule
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
- [usage-stats-port](usage-stats-port.md) — the Stats tab implementation: six CLIs in one provider-keyed ledger (Claude, Codex, OpenCode, Pi, OMP, Command Code); which CLIs have no token data at all and why Copilot is the near miss, Codex's cumulative-total trap, and how a session's reported model is chosen
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
- [dead-code-cleanup](dead-code-cleanup.md) — ~50 files of confirmed-dead code removed, and what went
- [licensing-and-docs](licensing-and-docs.md) — closed source by design; don't flip the repo public
