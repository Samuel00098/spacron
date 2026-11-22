# Memory index

One line per note. **Read this file, open only the notes your task touches, and
treat every note as a lead rather than as truth.** A note records what was true
when it was written; the code is what is true now. Where the two disagree the
code wins and the note is the thing that needs fixing — never conclude a bug is
understood because a note describes it.

When you add a note, add its line here under the matching heading. Keep the line
short enough that it says what the note is *about*, never what it says.

## Agents, delegation & review

- [agent-history-persistence](agent-history-persistence.md) — spacron persists agent structure not content; Orca indexer model + two viable approaches
- [agent-history-index](agent-history-index.md) — the read-only Fleet History index over Claude/Codex/OpenCode transcripts, and the traps in their file formats
- [orca-chat-view](orca-chat-view.md) — how Orca's per-terminal chat toggle reads transcripts and writes the PTY, vs our chat mode
- [structured-chat](structured-chat.md) — Orca-style structured chat tabs (agent over its own protocol, no terminal): how a pane hosts one, the bridge, what was verified live
- [structured-chat-attachments](structured-chat-attachments.md) — attachments cross as paths and each adapter inlines or not; the visuals folder for chats with no PTY
- [agent-background-poll-budget](agent-background-poll-budget.md) — what each running agent costs at rest, and the rules for anything that polls per agent
- [agent-failover](agent-failover.md) — moving unfinished work off an agent that is running out of usage: the invariants it spans, and two traps
- [project-worktrees](project-worktrees.md) — sidebar worktree rows vs agent worktrees, the sweep trap, and where the selected row applies
- [agent-turn-detection](agent-turn-detection.md) — how a turn is judged to have ended, and why a guess may not say "finished"
- [agent-turn-reporting](agent-turn-reporting.md) — who owns a session's watcher, and which turn ends may release the lease
- [agent-report-status](agent-report-status.md) — the `report_status` tool and per-launch agent tokens; only a declared end may interrupt
- [blocked-reason-is-raw-pty](blocked-reason-is-raw-pty.md) — "needs input" text is raw PTY; strip ANSI before rendering it
- [agent-inbox-unread](agent-inbox-unread.md) — why "read" and "dismissed" have to stay separate bits
- [notification-card-design](notification-card-design.md) — colour rules for the agent notification card; never tint a whole surface
- [transcription-hotkey](transcription-hotkey.md) — F9 dictation: pause/end semantics and its lifecycle ordering traps
- [voice-is-realtime-only](voice-is-realtime-only.md) — reply TTS is deleted; speech-to-speech is realtime-only; the one exception is the user-pressed Read aloud button
- [transcript-quality](transcript-quality.md) — the two cleanup stages for dictated text, and why the deterministic one stays conservative
- [voice-history](voice-history.md) — the two durable voice logs, and where retention lives
- [prompt-bar-is-voice-only](prompt-bar-is-voice-only.md) — the floating bar has no text input; staged prompts replace it
- [chat-mode-voice-and-dictation](chat-mode-voice-and-dictation.md) — Alt gesture and dictation capture are single-owner; `transcriptionTarget` picks which surface reports

## Workspace shell, rooms & visuals

- [global-css-overrides](global-css-overrides.md) — which global.css rules override component CSS (type, borders, shadows), and the overscroll trap
- [image-attach-delivery](image-attach-delivery.md) — how pasted/dropped images reach TUI agents and composers, and why preview URLs stay ephemeral
- [image-generation](image-generation.md) — image/video generation: provider fallback order, what was verified live and what was not, where results live, and the scope/persistence traps

- [html5-dnd-dead-in-tauri](html5-dnd-dead-in-tauri.md) — HTML5 drag-and-drop never fires in the Tauri window; use pointer events, and how a surface decides a broadcast drop is its own
- [modal-containing-block-gotcha](modal-containing-block-gotcha.md) — `backdrop-filter` breaks `position: fixed`; which modals must portal to body
- [modal-open-count-gate](modal-open-count-gate.md) — `modalOpenCount` gates app-wide keydowns; a stale bump kills every shortcut
- [modal-focus-restore-gotcha](modal-focus-restore-gotcha.md) — restore focus from the trigger side, not from inside the dialog
- [shortcut-key-matching](shortcut-key-matching.md) — `matchShortcut` compares produced characters, not key codes
- [dropdown-menu-sizing](dropdown-menu-sizing.md) — the shared `Dropdown` sizes to content, then clamps in a second layout pass
- [command-palette-registry](command-palette-registry.md) — the palette auto-registers menu, layout and settings actions; merge, never replace
- [agent-pane-survival](agent-pane-survival.md) — what keeps a running agent's pane alive across project/workspace switches and relaunches
- [room-liveness-invariant](room-liveness-invariant.md) — why closing a terminal room ends its shells, and the single close gate that keeps it true
- [split-maximize-zoom-layout](split-maximize-zoom-layout.md) — the `expandedRoom` invariants, and why Split must switch `ambientLayout`
- [per-project-persistence](per-project-persistence.md) — how a project remembers its stage, and what the sanitiser must learn
- [excalidraw-sketch-room](excalidraw-sketch-room.md) — Sketch room's Excalidraw body: theme truth, canvas fill, and the file/cache ordering
- [preview-iframe-bridge](preview-iframe-bridge.md) — the preview iframe is cross-origin; the postMessage contract
- [preview-room-is-persistent](preview-room-is-persistent.md) — preview is hidden, not unmounted, so the page survives a room switch
- [preview-responsive-viewport](preview-responsive-viewport.md) — phone/tablet preview is a scaled viewport, with no device chassis
- [orca-design-mode-and-browser-settings](orca-design-mode-and-browser-settings.md) — Orca Design Mode inspection, visual prompt packaging, and dedicated browser settings
- [terminal-cell-measure-stuck](terminal-cell-measure-stuck.md) — a pane opened at 0x0 wedges the grid at 80x24 for its whole life
- [onboarding-walkthrough-removed](onboarding-walkthrough-removed.md) — the walkthrough is deleted; leftover `onboardingCompleted` keys are dead, and `app_flags` now has no callers
- [quick-capture-removed](quick-capture-removed.md) — the Quick Capture modal, its `quickCaptureOpen` plumbing and the Ctrl+Shift+Space shortcut are deleted
- [terminal-fit-host-padding](terminal-fit-host-padding.md) — FitAddon cannot see container padding; open xterm into a zero-padding host
- [session-close-label](session-close-label.md) — name a closed terminal from a snapshot, never from its process-wide id
- [edge-light-gating](edge-light-gating.md) — the traveling edge light runs only while a room is working
- [background-wallpapers](background-wallpapers.md) — adding a wallpaper pair; dimming is two scrims, not `backgroundOpacity`; how a custom image turns panels to glass
- [website-logo-sync](website-logo-sync.md) — website/public copies the app icon and website/lib copies agentBrands; re-stamp both when the app side changes
- [pricing-license-model](pricing-license-model.md) — $49 one-time license; Lemon Squeezy checkout + key-gated downloads wired (env vars pending); app-side activation not built yet
- [website-motion-layer](website-motion-layer.md) — the html.js pre-paint gate behind the site's scroll reveals, and why every data-reveal page must mount ScrollFX
- [website-em-dash-convention](website-em-dash-convention.md) — no em dashes in visible copy: `·` for separators, `:` / `,` / `.` for prose breaks
- [resource-monitor-removed](resource-monitor-removed.md) — the CPU/RAM chip and its Rust side are deleted; `sysinfo` stays
- [embedded-command-sentinel](embedded-command-sentinel.md) — completion sentinel is on a fresh line, per-run token, shell-dialect aware; interactive runs are unwrapped
- [hidden-background-sessions](hidden-background-sessions.md) — hidden terminal sessions must be filtered from every user-facing surface; the one entry point and the one kill path
- [source-control-tasks](source-control-tasks.md) — tabbed tasks panel (board, issues, prs), keychain and gh token fallback, and head SHA merge safety

## Remote workspace & mobile

- [remote-invoke-seam-gap](remote-invoke-seam-gap.md) — how to decide whether a command routes to the box or stays local, and what the allowlist covers
- [server-artifact-download](server-artifact-download.md) — how the wizard downloads a server build for another OS
- [vps-deploy-cross-platform](vps-deploy-cross-platform.md) — how a matching `spacron-server` build is resolved for the target OS
- [mobile-companion-plan](mobile-companion-plan.md) — where the phone app goes, and why not a Tauri mobile target

## AI providers & model requests

- [deepseek-harness-agent](deepseek-harness-agent.md) — DeepSeek Harness as a web-panel + headless agent: npm version trap, approaches ruled out, what is still unverified
- [chatgpt-subscription-auth](chatgpt-subscription-auth.md) — the `chatgpt` brain provider is the user's Codex CLI over JSON-RPC, and what spawning it on Windows costs
- [live-model-list-refresh](live-model-list-refresh.md) — why failed model fetches must never be cached as empty lists
- [model-request-param-dialects](model-request-param-dialects.md) — why `run_completion` negotiates request shape from the provider's own error
- [orchestrator-bare-ack-net](orchestrator-bare-ack-net.md) — the two-layer guard (brain prompt rule + round-0 auto-read re-route) that stops the assistant replying with a promise and doing nothing; extended for deferral replies and follow-up ("okay") turns
- [orchestrator-file-visibility](orchestrator-file-visibility.md) — listed vs read: git-ignored and secret files, and the Rust/TS pieces that must agree
- [orchestrator-approval-cards](orchestrator-approval-cards.md) — what asks in Default access, and the card/activity-row contract between the store and ChatModePanel
- [orchestrator-edit-scope-and-delegation](orchestrator-edit-scope-and-delegation.md) — the 3-file direct-edit limit and the ask-before-delegating gate; which three files must agree
- [orchestrator-tool-calling](orchestrator-tool-calling.md) — the provider-agnostic FINAL vs tool_calls loop and where the executor lives; recovery-flag inventory and turn-completion contract; update_todos 5-state plan tool and its honesty invariants
- [orchestrator-emulator-tools](orchestrator-emulator-tools.md) - how the orchestrator reaches the emulator, and the four lists that must agree
- [orchestrator-vision](orchestrator-vision.md) — which models get images (Rust decides), the folder allowlist, and the per-provider wire shapes
- [model-capabilities](model-capabilities.md) — where model vision/reasoning/tools come from, where they are saved, and what triggers the background refresh
- [mcp-server-list](mcp-server-list.md) - user-managed MCP servers: the key-namespace rule that makes deleting one safe, and the rules that keep the chat's MCP client safe
- [mcp-oauth-proxy](mcp-oauth-proxy.md) — signing in to MCP servers from Settings, and the proxy agents reach them through: the cross-file key rule, own OAuth clients for Google, and what was verified live
- [vercel-ai-gateway](vercel-ai-gateway.md) — the `vercel` provider across chat, dictation, media and realtime voice: what was verified live, what still needs a key
- [orchestrator-skills-and-app-commands](orchestrator-skills-and-app-commands.md) — where brain skills and palette-command control live, and the three pieces that keep risky commands behind an approval click

## Security & confinement

- [path-confinement-layers](path-confinement-layers.md) — the two confinement steps, and which one does not normalize `..`
- [computer-use-grants](computer-use-grants.md) — the blocking grant handshake between the desktop MCP tools and the permission dialog
- [agent-browser-install](agent-browser-install.md) — the pinned Playwright MCP install, its PATH trap, and what must change together on a version bump

## Build, release & repo hygiene

- [lost-uncommitted-work](lost-uncommitted-work.md) — recovering uncommitted work wiped by a dropped stash (dangling commit → patch)

- [drive-the-real-app-at-any-size](drive-the-real-app-at-any-size.md) — how to screenshot the desktop app with a project open at a chosen size, and why viewport breakpoints under 960px are dead
- [release-flow](release-flow.md) — cutting a release, including the `cargo metadata` step everybody forgets
- [npm-audit-fix-edgesout-bug](npm-audit-fix-edgesout-bug.md) — npm 10.9.7 aborts every dependency bump; the legacy-peer-deps workaround and how to check it
- [sidecar-externalbin-deadlock](sidecar-externalbin-deadlock.md) — why `build.rs` stamps a placeholder sidecar; never revert it
- [build-scripts-are-esm](build-scripts-are-esm.md) — `scripts/*.js` are ESM; a `require` slip is red only in the release matrix
- [msi-ice30-duplicate-sidecar](msi-ice30-duplicate-sidecar.md) — WiX ICE30 when a bin target and a sidecar share a filename
- [windows-pathext-shims](windows-pathext-shims.md) — PATHEXT variants must outrank a bare bash script; `.cmd` needs `cmd /c`
- [cargo-check-in-agent-shell](cargo-check-in-agent-shell.md) — why whisper-rs-sys fails to build in a sandboxed agent shell, and the env var that fixes it
- [windows-arm64-whisper-build](windows-arm64-whisper-build.md) — why whisper needs clang-cl for Windows ARM64, and the env recipe that builds it
- [tauri-dev-restarts](tauri-dev-restarts.md) — why the dev app seems to close itself, and the no-watch script / ignore file that stop it
