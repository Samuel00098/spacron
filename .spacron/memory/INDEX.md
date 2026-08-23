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

- [agent-inbox-unread](agent-inbox-unread.md) — the inbox behind the toasts; why "read" and "dismissed" must stay separate bits, the cold-start seeding, and why every dismiss path must acknowledge
- [transcription-hotkey](transcription-hotkey.md) — the Ctrl+Alt+M speak-into-terminal feature: single-shot phase machine, the two delivery seams (sendAgentPromptDirect / requestTerminalInput), and why cleanup stays mechanical (never AI-refine shell commands)

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
- [fleet-in-right-drawer](fleet-in-right-drawer.md) — Agent Fleet is a right-drawer tool, not a centre room; `visiblePanels` is the room/not-room switch, `rightDrawerToolOf` checks fleet LAST on purpose, and tiling all agents auto-opens it via `applyRightDrawerTool`
- [tools-menu-launcher](tools-menu-launcher.md) — the bottom room dock is gone; every launcher is now the "Tools" dropdown at the right end of the floating prompt bar (`ToolsMenu.tsx`), with Spawn/Split/Tile inline beside it
- [split-maximize-zoom-layout](split-maximize-zoom-layout.md) — the separate Focus mode icon is removed; Split mode panes can be zoomed 100% full-stage on top of other cards while keeping the card selection strip below
- [terminal-rendering-stability](terminal-rendering-stability.md) — safeguards for zero-jitter, native-parity terminal rendering (Unicode 11 widths, 120x34 initial PTY spawn, custom box glyphs, atlas eviction gating, and DPI scaling)

## Remote workspace & mobile

- [remote-invoke-seam-gap](remote-invoke-seam-gap.md) — the server's `invoke` allowlist covers `fs_*`/`workspace_git_*`/`lsp_*` but **not** `project_state_*`, so the orchestrator silently reads empty against a remote
- [vps-deploy-cross-platform](vps-deploy-cross-platform.md) — the VPS wizard now detects the server's OS over SSH and resolves a matching `spacron-server` build (SPACRON_SERVER_PATH → triple artifact → host sidecar); musl cross-builds via `server:build --target`, macOS needs Mac/CI; no release-download yet
- [mobile-companion-plan](mobile-companion-plan.md) — the phone app goes in a top-level `mobile/` folder (Expo, `website/`-style sibling); why not a Tauri mobile target; terminals need no server change, agents do

## Build, release & repo hygiene

- [release-flow](release-flow.md) — cutting a release: CHANGELOG entry first (it gates the version bump), `npm version --no-git-tag-version`, then the `cargo metadata` step that refreshes `Cargo.lock` and is the one everybody forgets; separate `Release vX.Y.Z` commit, then the tag
