# Path confinement is two layers — don't call `require_in_roots` alone

`src-tauri/src/commands/file_system.rs` confines file ops in **two** steps, and
only the pair is safe:

1. `resolve_path(path)` — canonicalizes when the path exists; when the path *and
   its parent* do not exist it **lexically resolves `..`** and rejects a climb
   past the start. This is the step that closes traversal through non-existent
   intermediate directories.
2. `require_in_roots(path, roots)` — `starts_with` against the open project
   roots, then `require_no_escaping_symlink` walks every component with
   `symlink_metadata` to catch *dangling* symlinks (which `canonicalize` cannot
   see, because `Path::exists` follows the link and reports false).

**The gotcha:** `require_in_roots` on its own does *not* normalize `..`.
`clean_path_buf` only strips Windows `\\?\` prefixes. Since `Path::starts_with`
is component-wise, a raw `<root>/../../elsewhere/newdir/f` *passes*
`require_in_roots` — it is `resolve_path` upstream that stops it. Every
`fs_*` command calls `resolve_path`/`require_path` first, which is why they are
safe. Any new call site that reaches `require_in_roots` directly with a
client-supplied string needs its own normalization.

Known direct caller: `ClientMsg::StartWatch` in `src-tauri/src/remote/mod.rs`
passes the raw path. It is safe in practice only because a watch target must
exist (so `canonicalize` resolves the `..`), not because the check normalizes.

**The transports agree again (2026-08-26).** The local `start_fs_watch`
(`src-tauri/src/commands/fs_watch.rs`) used to take no `AppState` and confine
nothing, while the remote `StartWatch` confined its root — the one place the two
disagreed. It now takes `State<AppState>` and goes through `require_watchable`,
which is `require_path` (canonicalize) then `require_in_roots`.

`require_path` rather than `resolve_path` is deliberate and is the part to keep:
a watch target has to exist for the OS to watch it, so canonicalizing is both
available and stronger — it resolves `..` and symlinks *before* the
component-wise `starts_with`, which normalizes neither. `require_path` is
`pub(crate)` for this.

`require_watchable` is split out from the command so it can be tested against
explicit roots without a Tauri `State`, the same shape as `read_dir` vs
`fs_read_dir`. Its tests are the regression guard; the command itself is still
untestable here.

Related: [[remote-invoke-seam-gap]]
