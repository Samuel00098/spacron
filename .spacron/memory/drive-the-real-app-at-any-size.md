# Driving the real app (with a project open) at an exact window size

The plain browser build at `localhost:1420` cannot open a project, so the
workspace (rooms, drawers, terminals) cannot be checked there. What works:

- Debug builds skip the single-instance plugin (`lib.rs`), so a second
  `src-tauri/target/debug/spacron.exe` can run beside the user's windows.
- Launch it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`
  AND `WEBVIEW2_USER_DATA_FOLDER=<scratch dir>`. Without its own data folder it
  collides with the running dev window's WebView2 profile.
- Pass the repo path as the first argument; it opens as the active project.
- Drive it over CDP: `Emulation.setDeviceMetricsOverride` for the size,
  `Page.captureScreenshot`, `Runtime.evaluate`. HMR reloads reset the open rooms,
  so re-open them after each edit before measuring.
- Stop only that PID when done. The installed app may be hosting the agent.

Trap: the window minimum is 960x640 (`tauri.conf.json`), so viewport
`@media (max-width: <960px)` rules never fire in the app. Size inner layouts by
container or by the element's own width instead.
