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
- [agent-background-poll-budget](agent-background-poll-budget.md) — what each running agent costs at rest, and the rules for anything that polls per agent
- [agent-turn-detection](agent-turn-detection.md) — how a turn is judged to have ended, and why a guess may not say "finished"
- [agent-report-status](agent-report-status.md) — the `report_status` tool and per-launch agent tokens; only a declared end may interrupt
- [blocked-reason-is-raw-pty](blocked-reason-is-raw-pty.md) — "needs input" text is raw PTY; strip ANSI before rendering it
- [agent-inbox-unread](agent-inbox-unread.md) — why "read" and "dismissed" have to stay separate bits
- [notification-card-design](notification-card-design.md) — colour rules for the agent notification card; never tint a whole surface
- [transcription-hotkey](transcription-hotkey.md) — F9 dictation: pause/end semantics and its lifecycle ordering traps
- [voice-is-realtime-only](voice-is-realtime-only.md) — TTS is deleted app-wide; speech-to-speech is realtime-engine only
- [transcript-quality](transcript-quality.md) — the two cleanup stages for dictated text, and why the deterministic one stays conservative
- [voice-history](voice-history.md) — the two durable voice logs, and where retention lives
- [prompt-bar-is-voice-only](prompt-bar-is-voice-only.md) — the floating bar has no text input; staged prompts replace it
- [chat-mode-voice-and-dictation](chat-mode-voice-and-dictation.md) — Alt gesture and dictation capture are single-owner; `transcriptionTarget` picks which surface reports

## Workspace shell, rooms & visuals

- [image-attach-delivery](image-attach-delivery.md) — how pasted/dropped images reach TUI agents and composers, and why preview URLs stay ephemeral

- [html5-dnd-dead-in-tauri](html5-dnd-dead-in-tauri.md) — HTML5 drag-and-drop never fires in the Tauri window; use pointer events
- [modal-containing-block-gotcha](modal-containing-block-gotcha.md) — `backdrop-filter` breaks `position: fixed`; which modals must portal to body
- [modal-open-count-gate](modal-open-count-gate.md) — `modalOpenCount` gates app-wide keydowns; a stale bump kills every shortcut
- [modal-focus-restore-gotcha](modal-focus-restore-gotcha.md) — restore focus from the trigger side, not from inside the dialog
- [shortcut-key-matching](shortcut-key-matching.md) — `matchShortcut` compares produced characters, not key codes
- [dropdown-menu-sizing](dropdown-menu-sizing.md) — the shared `Dropdown` sizes to content, then clamps in a second layout pass
- [command-palette-registry](command-palette-registry.md) — the palette auto-registers menu, layout and settings actions; merge, never replace
- [room-liveness-invariant](room-liveness-invariant.md) — why closing a terminal room ends its shells, and the single close gate that keeps it true
- [split-maximize-zoom-layout](split-maximize-zoom-layout.md) — the `expandedRoom` invariants, and why Split must switch `ambientLayout`
- [per-project-persistence](per-project-persistence.md) — how a project remembers its stage, and what the sanitiser must learn
- [preview-iframe-bridge](preview-iframe-bridge.md) — the preview iframe is cross-origin; the postMessage contract
- [preview-room-is-persistent](preview-room-is-persistent.md) — preview is hidden, not unmounted, so the page survives a room switch
- [preview-responsive-viewport](preview-responsive-viewport.md) — phone/tablet preview is a scaled viewport, with no device chassis
- [terminal-cell-measure-stuck](terminal-cell-measure-stuck.md) — a pane opened at 0x0 wedges the grid at 80x24 for its whole life
- [terminal-fit-host-padding](terminal-fit-host-padding.md) — FitAddon cannot see container padding; open xterm into a zero-padding host
- [session-close-label](session-close-label.md) — name a closed terminal from a snapshot, never from its process-wide id
- [edge-light-gating](edge-light-gating.md) — the traveling edge light runs only while a room is working
- [background-wallpapers](background-wallpapers.md) — adding a wallpaper pair; dimming is two scrims, not `backgroundOpacity`
- [resource-monitor-removed](resource-monitor-removed.md) — the CPU/RAM chip and its Rust side are deleted; `sysinfo` stays
- [embedded-command-sentinel](embedded-command-sentinel.md) — completion sentinel is on a fresh line, per-run token, shell-dialect aware; interactive runs are unwrapped
- [hidden-background-sessions](hidden-background-sessions.md) — hidden terminal sessions must be filtered from every user-facing surface; the one entry point and the one kill path

## Remote workspace & mobile

- [remote-invoke-seam-gap](remote-invoke-seam-gap.md) — how to decide whether a command routes to the box or stays local, and what the allowlist covers
- [server-artifact-download](server-artifact-download.md) — how the wizard downloads a server build for another OS
- [vps-deploy-cross-platform](vps-deploy-cross-platform.md) — how a matching `spacron-server` build is resolved for the target OS
- [mobile-companion-plan](mobile-companion-plan.md) — where the phone app goes, and why not a Tauri mobile target

## AI providers & model requests

- [chatgpt-subscription-auth](chatgpt-subscription-auth.md) — ChatGPT sign-in drives `codex login`; tokens stay the CLI's business
- [live-model-list-refresh](live-model-list-refresh.md) — why failed model fetches must never be cached as empty lists
- [model-request-param-dialects](model-request-param-dialects.md) — why `run_completion` negotiates request shape from the provider's own error
- [orchestrator-bare-ack-net](orchestrator-bare-ack-net.md) — the two-layer guard (brain prompt rule + round-0 auto-read re-route) that stops the assistant replying with a promise and doing nothing; extended for deferral replies and follow-up ("okay") turns
- [orchestrator-tool-calling](orchestrator-tool-calling.md) — the provider-agnostic FINAL vs tool_calls loop and where the executor lives; recovery-flag inventory and turn-completion contract; update_todos 5-state plan tool and its honesty invariants

## Security & confinement

- [path-confinement-layers](path-confinement-layers.md) — the two confinement steps, and which one does not normalize `..`

## Build, release & repo hygiene

- [release-flow](release-flow.md) — cutting a release, including the `cargo metadata` step everybody forgets
- [sidecar-externalbin-deadlock](sidecar-externalbin-deadlock.md) — why `build.rs` stamps a placeholder sidecar; never revert it
- [build-scripts-are-esm](build-scripts-are-esm.md) — `scripts/*.js` are ESM; a `require` slip is red only in the release matrix
- [msi-ice30-duplicate-sidecar](msi-ice30-duplicate-sidecar.md) — WiX ICE30 when a bin target and a sidecar share a filename
- [windows-pathext-shims](windows-pathext-shims.md) — PATHEXT variants must outrank a bare bash script; `.cmd` needs `cmd /c`
