# Relative Window Sizing on Restore / Unmaximize

When bringing down or restoring the main app window from maximized state via the window toggle control (`toggleMaximize`), the window is sized dynamically relative to the current display work area (`currentMonitor()`). Standard minimize (`minimize()`) only minimizes the window to the taskbar without altering its size or state.

## Details

- Implemented in `src/lib/utils/tauri.ts` via `restoreWindowToRelativeSize(widthPercent, heightPercent)`.
- Default target scale is 65% of screen width and 85% of screen height (`0.65` and `0.85`), horizontally and vertically centered to match user screen proportion preferences.
- Scaled dynamically using logical pixels computed from `monitor.workArea` and `monitor.scaleFactor`.
- Hooked into `TitleBar.tsx` window action button (`toggleMaximize`).

