# Relative Window Sizing on Minimize / Restore

When bringing down or restoring the main app window from maximized state (or clicking minimize/unmaximize), the window is sized dynamically relative to the current display work area (`currentMonitor()`).

## Details

- Implemented in `src/lib/utils/tauri.ts` via `restoreWindowToRelativeSize(widthPercent, heightPercent)`.
- Default target scale is 65% of screen width and 85% of screen height (`0.65` and `0.85`), left-aligned with vertical centering to match user screen proportion preferences.
- Scaled dynamically using logical pixels computed from `monitor.workArea` and `monitor.scaleFactor`.
- Hooked into `TitleBar.tsx` window action buttons (`minimize` and `toggleMaximize`).
