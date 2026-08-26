# Terminal Rendering Stability & Native Parity

## Core Architecture

Spacron's terminal rendering pipeline bridges Tauri Rust PTYs (`portable-pty`, ConPTY on Windows, Unix PTY on macOS/Linux) with an xterm.js canvas/WebGL renderer inside glass-frosted bento panes.

To match native terminal emulators (Windows Terminal, iTerm2, Alacritty, Ghostty), the following safeguards are implemented:

1. **Initial PTY Dimensions**: `createTerminalSession` passes `initialCols` (default `120`) and `initialRows` (default `34`) to `openPty` instead of hardcoding `80x24`. This prevents ConPTY and readline from re-wrapping startup prompts and welcome banners when wide panes mount.
2. **Unicode 11 Addon (`@xterm/addon-unicode11`)**: Loaded on all xterm instances (`term.unicode.activeVersion = '11'`). Ensures emojis (🚀, 💡, ⚠️, 📦), Nerd Font icons, and wide CJK characters occupy 2 cells, preventing cursor drift, ghost backspacing artifacts, and right-edge clipping.
3. **Pixel-Perfect TUI Box-Drawing**: `customGlyphs: true` and `rescaleOverlappingGlyphs: true` with `lineHeight: 1.12` render seamless, continuous borders for TUIs (Claude Code, Codex, htop, lazygit) without 1px horizontal/vertical gaps or descender clipping.
4. **Targeted Texture Atlas Invalidation**: `doFit()` avoids redundant `clearTextureAtlas()` calls when proposed dimensions match current terminal dimensions. The GPU atlas is only flushed when font family/size, DPI resolution, or cell pixel sizes actually change.
5. **DPI & Window Scale Awareness**: `window.matchMedia('(resolution: ...)')` listens for device pixel ratio shifts across multi-monitor setups, triggering clean redraws.
6. **Container & Viewport CSS**: `.xterm-container` specifies `box-sizing: border-box`, `min-width: 0`, `min-height: 0`, and custom thin overlay scrollbars so that scrollbar appearances never occlude the rightmost character column.
