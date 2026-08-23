# Cutting a release

Reconstructed from git history on 2026-08-23 while tagging v1.0.0; there is no
checklist doc, so this is it.

## Shape of the history

Feature commits land first (`feat(...)`, `fix(...)`, `perf: ...`), then a
**separate `Release vX.Y.Z` commit** touching exactly six files:

    CHANGELOG.md  package.json  package-lock.json
    src-tauri/Cargo.lock  src-tauri/Cargo.toml  src-tauri/tauri.conf.json

The annotated tag `vX.Y.Z` points at that commit. Don't fold the release commit
into a feature commit — every prior release keeps them apart.

## The steps

1. Write the CHANGELOG entry **first**. `scripts/sync-version.js` hard-fails if
   `CHANGELOG.md` has no `[vX.Y.Z]` (or `[X.Y.Z]`) heading, which is the gate
   that stops a version bump with no notes.
2. `npm version X.Y.Z --no-git-tag-version`. The `--no-git-tag-version` matters:
   plain `npm version` wants a clean tree and makes its own commit+tag with the
   wrong message shape. The `version` lifecycle script still runs, syncing
   `tauri.conf.json` and `Cargo.toml`.
3. **`cd src-tauri && cargo metadata --format-version 1 --offline > /dev/null`**
   to refresh `Cargo.lock`. This is the easy one to miss — `sync-version.js`
   does not touch the lock and CI does not build `--locked`, so nothing fails
   and the release ships a lock disagreeing with its own manifest. That is
   exactly what happened through the whole of v0.9.3 (see the v0.9.4 notes).
4. Commit the six files as `Release vX.Y.Z`, `git tag -a vX.Y.Z`, push the
   branch and the tag separately.

## Before you tag

`npm run check`, `npm test`, and **`cargo test --lib`** — the Rust suite is the
one nothing else runs for you, and it has been red on `main` before without
anyone noticing (a fixture pinned to a literal date aged out of a 7-day filter).
`cargo check --all-targets` should be warning-free too.

Also run **`npm run server:build`** once. It is the only thing that exercises
Tauri's `beforeBuildCommand`, which no other check touches — a broken script
there passes every local and CI check and then kills all three release jobs
after the tag is pushed. See [[build-scripts-are-esm]].

## Changelog voice

Look at the file, not at generic keep-a-changelog advice. Each release opens
with a narrative paragraph naming what the release is *about*, then
Added/Changed/Removed/Fixed (and Security where it applies) with a **bolded
lead-in** per bullet and a dense paragraph of real rationale — the numbers
behind a perf claim, why the obvious alternative was rejected, what is
load-bearing. Internal-only items are in scope (`Cargo.lock` bookkeeping, a
rotted test) when they explain something.

Note: the marketing site's `/changelog` renders this exact file, so it is
release notes and public copy at once.
