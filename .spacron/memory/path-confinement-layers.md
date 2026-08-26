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

**Asymmetry worth knowing:** the remote `StartWatch` confines the watch root to
the workspace, but the local `start_fs_watch` command
(`src-tauri/src/commands/fs_watch.rs`) takes no `AppState` and confines nothing —
it will recursively watch any path it is handed. Low impact today (the emitted
`fs-change` payload is the watch root, not the changed file, and reaching the
command needs script execution inside the shell), but it is the one place where
the two transports disagree about confinement.

Related: [[remote-invoke-seam-gap]]
