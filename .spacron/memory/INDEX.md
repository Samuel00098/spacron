# Memory index

Every note in `.spacron/memory/`, one line each. **Read this file first, then open
only the notes your task touches.** When you add a note, add its line here in the
matching section.

> Housekeeping (2026-08-16): most of the notes this index used to list were
> deleted from the tree (including the old `memory-index.md` explainer). The index
> was rebuilt to reference only the notes that actually exist. If a topic you need
> has no note here, it was pruned — write a fresh note rather than hunting for the
> old one.

## Agents, delegation & review

- [agent-turn-detection](agent-turn-detection.md) — how `watchLeasedAgentTurn` ends a turn: only Claude gets hooks, all other CLIs share one heuristic config, bell is corroborated-by-quiescence (not instant), attention-phrase misses
- [blocked-reason-is-raw-pty](blocked-reason-is-raw-pty.md) — the "needs input" card text is a slice of the raw PTY buffer; strip it with `stripTerminalOutput` or it renders ANSI escape codes
- [agent-inbox-unread](agent-inbox-unread.md) — the inbox behind the toasts; why "read" and "dismissed" must stay separate bits, the cold-start seeding, and why every dismiss path must acknowledge
- [transcription-hotkey](transcription-hotkey.md) — the Ctrl+Alt+M speak-into-terminal feature: single-shot phase machine, the two delivery seams (sendAgentPromptDirect / requestTerminalInput), and why cleanup stays mechanical (never AI-refine shell commands)
- [prompt-bar-is-voice-only](prompt-bar-is-voice-only.md) — the floating bar has no text input: typing and the pick-a-terminal path are gone; `promptBarInput` now lands in the read-only "staged prompt" strip that a spoken turn merges onto

## Workspace shell, rooms & visuals

- [resource-monitor-removed](resource-monitor-removed.md) — the titlebar CPU/RAM chip, its panel, the store and the Rust `resource.rs` are all deleted; `walkdir` went with them but `sysinfo` stays (the PTY kill-tree needs it)
- [background-wallpapers](background-wallpapers.md) — the wallpaper pairs and how to add one (ffmpeg recipe; `presetThemes.ts` is the only file to touch); the `backgroundOpacity` field is dead — dimming is two stacked scrims in global.css
- [relative-window-minimize-size](relative-window-minimize-size.md) — unmaximizing or bringing the window down resizes it dynamically relative to the monitor work area (65% width x 85% height, via `restoreWindowToRelativeSize` in `src/lib/utils/tauri.ts`)
- [dropdown-menu-sizing](dropdown-menu-sizing.md) — the shared `Dropdown`'s portaled menu sizes to its content with the trigger width as a floor, then clamps back inside the window in a second layout pass; it used to be pinned to the trigger, which clipped every option of a narrow picker
- [edge-light-gating](edge-light-gating.md) — room panels' traveling edge light is paused unless the room has `is-working` (agent `isExecuting`); motion means "work is happening", other surfaces keep the ambient lap
- [modal-focus-restore-gotcha](modal-focus-restore-gotcha.md) — a dialog with `autoFocus` can't capture prior focus from inside itself (commit order); restore from the trigger side, and reload before trusting focus tests under HMR
- [modal-open-count-gate](modal-open-count-gate.md) — `useModalFocus` bumps a global `modalOpenCount` that both app-wide keydown listeners bail on; a host mounted while closed pins it and kills **every** shortcut (pass the new `active` arg)
- [shortcut-key-matching](shortcut-key-matching.md) — `matchShortcut` compares produced characters, so shifted punctuation (`Ctrl+Shift+\``) needs the unshifted-key-cap fold; `event.code` is a macOS-only fallback, never the primary compare
- [modal-containing-block-gotcha](modal-containing-block-gotcha.md) — the title bar's `backdrop-filter` is the containing block for `position: fixed`, so modals mounted from `RemoteStatus`/`TitleBar` must portal to `<body>`; native `<select>` popups also detach under CSS zoom — use the shared `Dropdown`
- [markdown-preview-default](markdown-preview-default.md) — markdown files (`.md`, `.markdown`) default to opening in Markdown Preview mode rather than the code editor; toggling to code mode persists per-file while open and cleans up on close
- [text-editor-styling](text-editor-styling.md) — the editor is transformed into a clean, distraction-free document canvas (no line numbers, no fold gutters, centered readable width, relaxed line height, word wrap, and clean pill tabs)
- [preview-iframe-bridge](preview-iframe-bridge.md) — the preview iframe is cross-origin to the app shell, so `contentDocument`/`location` reaches always throw; the full postMessage message table, the per-tab origin check, and why `iframeError` is not cleared on load
- [preview-room-is-persistent](preview-room-is-persistent.md) — `preview` is a persistent stage room, hidden not unmounted, so switching rooms no longer reloads the page in the iframe
- [preview-responsive-viewport](preview-responsive-viewport.md) — phone/tablet preview is a plain scaled viewport now (no device chassis); where the fit/centring/drag rules live, and the browser-parity console behaviour
- [fleet-in-right-drawer](fleet-in-right-drawer.md) — Agent Fleet is a right-drawer tool, not a centre room; `visiblePanels` is the room/not-room switch, `rightDrawerToolOf` checks fleet LAST on purpose, and tiling all agents auto-opens it via `applyRightDrawerTool`
- [tools-menu-launcher](tools-menu-launcher.md) — the bottom room dock is gone; every launcher is now the "Tools" dropdown at the right end of the floating prompt bar (`ToolsMenu.tsx`), with Spawn/Split/Tile inline beside it
- [command-palette-registry](command-palette-registry.md) — the palette auto-registers every Tools-menu item/layout action/settings tab via a per-render bridge ref (stale-closure guard); `initDefaultCommands` merges, never replaces; overlay is a transparent click-catcher — no blur veil; Memory Graph is a FloatingYouTube-style room (`memoryGraphVisible`), `knowledgeGraphOpen` deleted; arrow-scroll fixes: rect-based scrollTop + pointerMoved guard on hover-select
- [project-hud-in-left-sidebar](project-hud-in-left-sidebar.md) — Project HUD is moved from a center modal overlay to a dedicated Projects tab in the left utility drawer, toggled via TitleBar or Ctrl+K
- [sketch-room](sketch-room.md) — the Sketch button opens a native drawing room, not excalidraw.com; the canvas was restored from a deleted 4.5k-line component, and stops being an overlay / stops eating other panes' keys
- [split-maximize-zoom-layout](split-maximize-zoom-layout.md) — the separate Focus mode icon is removed; Split mode panes can be zoomed 100% full-stage on top of other cards while keeping the card selection strip below; also why the Split button must switch `ambientLayout` (Focus ignores `splitSlots`) and the `expandedRoom` invariants — always retile, clear on mode change, follow focus
- [terminal-rendering-stability](terminal-rendering-stability.md) — safeguards for zero-jitter, native-parity terminal rendering (Unicode 11 widths, 120x34 initial PTY spawn, custom box glyphs, atlas eviction gating, and DPI scaling)
- [terminal-fit-host-padding](terminal-fit-host-padding.md) — letters clipped at pane edges: FitAddon can't see the container's 6/6/8px padding, so xterm fit a phantom column+row that overflow:hidden sheared; fixed by opening xterm into a zero-padding `.xterm-fit-host`
- [terminal-cell-measure-stuck](terminal-cell-measure-stuck.md) — panes clipped instead of wrapping: a pane opened at 0x0 measures a zero-wide cell, `proposeDimensions()` then returns undefined forever and the grid stays wedged at xterm's 80x24 default; also why the settled re-fit must keep its MIN_COLS guard
- [session-close-label](session-close-label.md) — the "Terminal N closed" toast is named from a snapshot taken in `killSession`, because the session is gone from state before the pty exit fires; never name a session from its (process-wide) `id`; the same map's `delete` boolean separates user-closed (info) from self-died (error) toasts

## Remote workspace & mobile

- [remote-invoke-seam-gap](remote-invoke-seam-gap.md) — the server's `invoke` allowlist covers `fs_*`/`workspace_git_*`/`lsp_*` but **not** `project_state_*`, so the orchestrator silently reads empty against a remote
- [vps-deploy-cross-platform](vps-deploy-cross-platform.md) — the VPS wizard now detects the server's OS over SSH and resolves a matching `spacron-server` build (SPACRON_SERVER_PATH → triple artifact → host sidecar); musl cross-builds via `server:build --target`, macOS needs Mac/CI; no release-download yet
- [mobile-companion-plan](mobile-companion-plan.md) — the phone app goes in a top-level `mobile/` folder (Expo, `website/`-style sibling); why not a Tauri mobile target; terminals need no server change, agents do

## AI providers & model requests

- [model-request-param-dialects](model-request-param-dialects.md) — one function (run_completion) owns every AI text request; why it negotiates max_tokens/max_completion_tokens/temperature from the provider error instead of matching model ids, the reasoning-budget trap, and the xAI misrouting

## Security & confinement

- [path-confinement-layers](path-confinement-layers.md) — file ops are confined in two steps (`resolve_path` normalizes `..`, `require_in_roots` confines + catches dangling symlinks); `require_in_roots` alone does **not** normalize `..`, and local `start_fs_watch` confines nothing while its remote twin does

## Build, release & repo hygiene

- [sidecar-externalbin-deadlock](sidecar-externalbin-deadlock.md) — `externalBin` is resolved on every cargo invocation, so a clean checkout cannot build the sidecar that the check demands; `build.rs` stamps a placeholder — never revert it to a bare `tauri_build::build()`
- [build-scripts-are-esm](build-scripts-are-esm.md) — `scripts/*.js` are ESM (`"type": "module"`); `build-server-sidecar.js` runs only as Tauri's `beforeBuildCommand`, so a `require` slip is green in every check and red only in the release matrix
- [msi-ice30-duplicate-sidecar](msi-ice30-duplicate-sidecar.md) - light.exe fails with no visible error when a bin target and an `externalBin` sidecar share a filename (WiX ICE30); how to surface the hidden error, and why only Windows catches it
- [release-flow](release-flow.md) — cutting a release: CHANGELOG entry first (it gates the version bump), `npm version --no-git-tag-version`, then the `cargo metadata` step that refreshes `Cargo.lock` and is the one everybody forgets; separate `Release vX.Y.Z` commit, then the tag
- [windows-pathext-shims](windows-pathext-shims.md) — npm ships both a bare bash script and a `.cmd` for the same tool; spawning the bare one is os error 193, so PATHEXT variants must outrank it across the *whole* PATH, and `.cmd` needs `cmd /c`
