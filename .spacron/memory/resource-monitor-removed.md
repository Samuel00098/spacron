# Resource monitor removed (2026-08-23)

The machine-load feature — titlebar CPU/RAM chip, its dropdown panel, the
per-session rows with kill actions, the per-project disk footprints, and the
"project under heavy load" watchdog toast — is **gone**. Do not re-add it
without asking; it was removed deliberately, not lost.

## What was deleted

Frontend
- `src/lib/components/resource/` (whole directory: `ResourceChip.tsx/.css`,
  `ResourcePanel.tsx/.css`)
- `src/lib/stores/resource.ts` + `resource.test.ts`
- mount sites: `<ResourcePanel />` in `src/App.tsx`, `<ResourceChip />` in
  `src/lib/components/layout/TitleBar.tsx`
- the `.resource-panel` entries in the five edge-light / glass selector lists in
  `src/styles/global.css` (see [[edge-light-gating]] — that ring is shared, so
  removing a surface means editing every one of those lists)

Backend
- `src-tauri/src/commands/resource.rs`
- `pub mod resource;` in `commands/mod.rs`
- `resource_snapshot` + `project_disk_usage` from the `invoke_handler` in `lib.rs`
- `resource_sampler` / `disk_usage_cache` fields on `AppState` (`state.rs`)

## Dependency notes

- `walkdir` was dropped from `Cargo.toml` — resource.rs was its only user.
- **`sysinfo` stays.** It is *not* only the resource monitor's:
  `pty/session.rs` uses it to walk and kill an agent's whole child process tree.
  Its Cargo.toml comment was retargeted to say so.

## Why

`resource_snapshot` walked the entire process table on every poll (~100 ms on
Windows at ~350 processes) and ran every 6 s even with the panel closed, purely
to drive a chip in the titlebar. That is continuous main-thread + IPC cost
competing with the agents for the machine, for a reading nobody was watching.

`workspace.rs::is_under` was shared with the old resource module; it stays
(worktree containment still needs it), only its doc comment changed.
