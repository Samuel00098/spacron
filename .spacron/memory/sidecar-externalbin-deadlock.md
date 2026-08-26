# The externalBin / sidecar chicken-and-egg

`src-tauri/tauri.conf.json` declares:

```json
"externalBin": ["binaries/spacron-server"]
```

tauri-build resolves that to `binaries/spacron-server-<target-triple>[.exe]`
**on every cargo invocation of the `spacron` package** — `cargo check` and
`cargo test` too, not only at bundle time — and hard-errors when it is missing:

    resource path `binaries/spacron-server-<triple>` doesn't exist

The deadlock: that file is produced by `scripts/build-server-sidecar.js`, which
produces it by running `cargo build --bin spacron-server`. That bin is a target
of the *same* package, so it runs the same `build.rs`, which fails because the
file is not there yet.

`binaries/` is gitignored, so **every CI checkout is a clean one** and hit this.
It never reproduced locally because a stale binary from an earlier
`npm run server:build` sat in `binaries/` and satisfied the check forever after.
To reproduce, move that file away first.

## The fix

`src-tauri/build.rs` stamps an empty placeholder at that path when nothing is
there, before calling `tauri_build::build()`, and emits a `cargo:warning`.

It cannot ship: `tauri build` runs the sidecar script in `beforeBuildCommand`,
before the cargo build that bundles, so the real binary always overwrites the
placeholder first. Only a bare `cargo check` / `cargo test` leaves it in place,
and neither bundles.

**Do not "clean up" `build.rs` back to a bare `tauri_build::build()`** — that
re-breaks every workflow on a clean checkout, and it is green on any machine
that has built the server once, so you will not notice.

Related: [[build-scripts-are-esm]], [[release-flow]]
