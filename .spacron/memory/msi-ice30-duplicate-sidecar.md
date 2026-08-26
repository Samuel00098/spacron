# The Windows MSI breaks if the sidecar is also a bin target

Learned 2026-08-24 diagnosing the v1.0.0 release failure.

## The symptom

The Windows release job dies with nothing useful in the log:

    Running light to produce ...\bundle\msi\Spacron_1.0.0_x64_en-US.msi
    failed to bundle project `failed to run ...\WixTools314\light.exe`

**The real error is hidden.** tauri-bundler runs light.exe through
`execute_with_verbosity`, which only forwards the child's output when the build
is verbose. To see it, either build with `--verbose` or — much faster, since the
wix intermediates survive a failed build — re-run the linker by hand:

    cd src-tauri/target/release/wix/x64
    "$LOCALAPPDATA/tauri/WixTools314/light.exe" -ext WixUIExtension -ext WixUtilExtension \
      -loc locale.wxl -cultures:en-US -o /tmp/repro.msi main.wixobj

Another tell that it is a *validation* failure and not a link failure:
`wix/x64/output.msi` exists and is full-size while `bundle/msi/` is empty. light
writes the MSI first, then runs ICE validation and exits non-zero.

## The cause

    error LGHT0204 : ICE30: The target file 'spacron-server.exe' is installed in
    '[ProgramFiles64Folder]\Spacron\' by two different components on an LFN
    system: 'spacron_server.exe' and 'spacron_server'.

Tauri bundles **every bin target of the app package** *and* **every
`bundle.externalBin` entry**. `src-tauri/src/bin/spacron-server.rs` was a bin
target of the `spacron` package, and `binaries/spacron-server` was a sidecar, so
the same filename landed in the installer twice from two sources — the lean
sidecar out of `binaries/`, and the fat default-features build out of
`target/release/`.

The fix is the `src-tauri/server` crate (see its Cargo.toml header): as a
separate workspace member it is no longer a bin of the app package, so
`externalBin` is the single source. Verify in one second, without a build:

    cd src-tauri && cargo metadata --format-version 1 --no-deps

The `spacron` package must list exactly one bin. If a second one ever appears
with the same name as a sidecar, the MSI is already broken.

## Why this bit so late

**Only WiX checks.** The `.deb`/`.rpm`/`.AppImage`/`.app` bundlers have no ICE
equivalent — they silently ship whichever copy is written last. So the same bug
that hard-fails Windows quietly shipped a possibly-wrong `spacron-server` on mac
and Linux for every release that had this layout, including v1.0.0's published
assets. When auditing an old release, do not assume the sidecar in it is the
lean build.

Related: [[sidecar-externalbin-deadlock]], [[release-flow]],
[[vps-deploy-cross-platform]]
