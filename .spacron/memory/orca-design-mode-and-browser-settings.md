# Orca Design Mode & Browser Settings

## Design Mode
Orca Design Mode bridges web preview inspection with AI coding agents:
1. Toggle: `Alt+D` or toolbar button "Design Mode".
2. In-iframe inspector highlights hovered elements with dimensions & selector.
3. On element click:
   - Captures cropped visual snapshot (`captureElementScreenshot`), selector, tag, text, raw HTML, computed styles, and attributes.
   - Opens `DesignModePanel`:
     - Visual snapshot preview with click-to-enlarge.
     - Breadcrumbs hierarchy (`div.container > main > button.primary`).
     - Tabs:
       - **Prompt Agent**: User instructions input, 6 quick-action chips (Styling & Colors, Layout & Spacing, Responsive, Copy & Typography, States & Animation, Refactor), screenshot/styles/HTML toggles, target agent selection, and "Send to Agent" button.
       - **Computed Styles**: Filterable CSS properties with "Copy CSS Block".
       - **HTML**: Formatted raw outerHTML snippet with "Copy HTML".
       - **Attributes**: Element DOM attributes with "Copy Selector".
     - Actions:
       - "Send to Agent" sends formatted prompt with screenshot to selected or auto-targeted agent in Chat UI or Terminal UI (`dispatchPromptToAgent`).
       - "Copy Full Context" copies markdown prompt with all context to clipboard.
       - "Reselect" allows picking another element without closing.

## Annotation & Drawing Mode
Orca-style in-browser annotation (`PreviewAnnotationOverlay`):
1. Toggle: toolbar button "Draw" next to "Design Mode".
2. Direct canvas overlay over `.viewport-frame` (scales automatically with device emulation).
3. Tools:
   - **Freehand Pen**: Smooth stroke drawing.
   - **Arrow**: Drag-to-point arrow with arrowhead geometry.
   - **Rectangle / Box**: Drag-to-highlight bounding box.
   - **Text Note**: Click anywhere on the preview to write an inline callout badge.
4. Colors & Widths:
   - 5 colors: Red (`#ef4444`), Spacron Indigo (`#6366f1`), Amber (`#f59e0b`), Emerald (`#10b981`), White (`#f8fafc`).
   - 3 stroke widths: Fine (2px), Medium (4px), Bold (8px).
   - Undo and Clear all actions.
5. "Send to Agent":
   - Merges underlying viewport screenshot (via `preview_capture_screenshot`) with drawn canvas onto an offscreen canvas.
   - Opens prompt modal with composite image preview, instructions input, suggestion chips, and target agent selector.

## Agent Targeting (Terminal & Chat UI)
`agent-target.ts`:
1. `getActiveAgentTargets()` filters running sessions (`isAgentSession(s) && s.isRunning && !s.hidden`).
2. Identifies UI kind:
   - **Chat UI**: `isTerminalChatView(s.id)` or `structuredChatPanes[s.id]`.
   - **Terminal UI**: raw xterm PTY.
3. Auto-targeting:
   - If **only 1 agent is open**, it is automatically selected without requiring user interaction.
   - If **multiple agents are open**, a styled dropdown selector allows switching between them.
4. Delivery:
   - If target is **Chat UI**: `requestTerminalChatInput` sets `TerminalChatView`'s `draft` and adds image as composer attachment.
   - If target is **Terminal UI**: saves image via `save_pasted_image`, sets `promptBarImage`, and delivers prompt with quoted path through `requestTerminalInput`.
   - Automatically activates target agent session pane.

## Browser Settings
Located in `SettingsModal` under the `browser` tab (`Settings -> Browser`):
- Dev server default port & preferred host (`localhost` vs `127.0.0.1`).
- Independent preview theme mode (`system`, `light`, `dark`), decoupling preview pages from the app theme.
- Default device emulation viewport & zoom level.
- Design Mode preferences: auto-capture screenshot, include styles, include HTML, max HTML length.
- Link routing (open in preview vs system browser, background tabs).
- Console auto-open on error and preserve logs.
- Clear preview cookies, localStorage, cache, and history.

Related: [[preview-iframe-bridge]], [[preview-room-is-persistent]]
