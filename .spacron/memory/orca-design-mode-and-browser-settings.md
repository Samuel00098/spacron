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
       - **Prompt Agent**: User instructions input, 6 quick-action chips (Styling & Colors, Layout & Spacing, Responsive, Copy & Typography, States & Animation, Refactor), screenshot/styles/HTML toggles, and "Send to Agent" button.
       - **Computed Styles**: Filterable CSS properties with "Copy CSS Block".
       - **HTML**: Formatted raw outerHTML snippet with "Copy HTML".
       - **Attributes**: Element DOM attributes with "Copy Selector".
     - Actions:
       - "Send to Agent" sends formatted prompt with screenshot to active agent terminal (`requestTerminalInput` + `promptBarImage`).
       - "Copy Full Context" copies markdown prompt with all context to clipboard.
       - "Reselect" allows picking another element without closing.

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
