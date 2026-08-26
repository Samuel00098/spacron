# The VPS wizard downloads the server build it needs

Shipped 2026-08-25. Closes the gap [[vps-deploy-cross-platform]] left open: the
wizard could deploy cross-OS, but only if you had already cross-built the
binary. A packaged install had no way to get one, so "deploy from Windows to a
Linux VPS" required a Rust toolchain and a zig linker.

## What changed

**CI publishes one server per platform.** `release.yml` gained a step per matrix
leg that uploads `spacron-server-<host triple>[.exe]` plus a `.sha256` sidecar
to the `spacron-releases` release. It does **not** build anything: tauri's
`beforeBuildCommand` already produced that artifact for the host triple during
the installer build, so the step only names, hashes and uploads it.

**The app downloads it on demand.** `remote_download_server(platform)` fetches
the asset for this app's version tag, falling back to `latest`, verifies it
against the `.sha256`, and caches it in `<config>/spacron/servers/` — which
`artifact_dirs()` now searches, so `resolve_server_binary_for` finds it by name
with no other change. `remote_server_binary_status(platform)` is the pure query
behind the wizard's notice; it never touches the network.

## Two decisions worth not re-litigating

- **The published Linux triple is `gnu`, not `musl`**, even though
  `DeployPlatform::triples()` still prefers musl. The server links the same
  GTK/WebKit stack as the desktop app, so it cannot be statically linked. The
  install script already installs those runtime libraries over passwordless
  sudo, which is the actual fix. Consequence: the published build is glibc-2.35
  (ubuntu-22.04), so a much older distro needs its own build.
- **The checksum is a published sidecar, not a pinned constant** (unlike
  `JAR_SHA256` in `mobile_stream.rs`) because the artifact changes every
  release. It proves the bytes arrived intact from that release; it does not
  prove the release is trustworthy. Same TLS origin as the installer the user
  already ran, which is the same trust boundary — but do not describe it as
  more than that.

Verify-before-write, temp-then-rename, and self-healing on a corrupt cache are
copied deliberately from `ensure_server_jar`; keep them.

## UI

`binaryNotice()` in `remoteSetup.ts` is the pure four-state decision (none /
ready / download / blocked) — test it there, not through the component. Deploy
is disabled only on a **definite** `available === false`; a null status (never
checked, or the check itself failed) must stay deployable, because the resolver
runs again inside the deploy and reports properly.

Related: [[vps-deploy-cross-platform]], [[release-flow]],
[[remote-invoke-seam-gap]]
