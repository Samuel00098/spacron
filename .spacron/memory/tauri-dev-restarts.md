# `tauri dev` restarts look like the app closing itself

`tauri dev` watches every crate under `src-tauri/` and kills + relaunches the
app on any change it sees. While dogfooding (agents running inside Spacron,
editing Spacron), every agent save of a `.rs` file restarts the host app and
ends its terminals; a save mid-edit that does not compile leaves the app DOWN
until the next good save. That is the "it just closes" report (2026-09-24).
The Windows event log showed no crash for `spacron.exe` then, which is how to
tell a watcher restart from a real crash.

- `npm run dev:app` = `tauri dev --no-watch`: frontend HMR still works, Rust
  changes wait for a manual restart. Use it when agents edit Rust.
- `src-tauri/.taurignore` keeps runtime/generated paths (`.spacron/`, `gen/`,
  `binaries/`, logs) from triggering restarts. Add any new runtime-written
  path under `src-tauri/` there.
- The repo lives in OneDrive; sync touching files can also fire the watcher.
- A full C: drive turns every restart into "down for good": the rebuild fails
  (`No space left on device`, or `LNK1102: out of memory` because the page
  file can't grow). `src-tauri/target` reached 37 GB on 2026-09-24 and filled
  the disk; check free space before blaming the code.

Related: [[sidecar-externalbin-deadlock]], [[release-flow]]
