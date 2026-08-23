use std::path::PathBuf;

/// Stamp an empty `binaries/spacron-server-<triple>[.exe]` when none is there.
///
/// `bundle.externalBin` in `tauri.conf.json` names `binaries/spacron-server`,
/// and tauri-build resolves that to a triple-suffixed path on **every** cargo
/// invocation of this package — `cargo check` and `cargo test` included, not
/// just at bundle time. It hard-errors when the file is missing.
///
/// The real binary is produced by `scripts/build-server-sidecar.js`, which
/// itself runs `cargo build --bin spacron-server`. That is a target of *this*
/// package, so it runs this build script too. On a clean checkout — `binaries/`
/// is gitignored, so every CI checkout is one — that is a deadlock: the build
/// that creates the sidecar cannot start until the sidecar already exists.
///
/// A placeholder breaks it. It cannot be packaged by accident: `tauri build`
/// runs the sidecar script in `beforeBuildCommand`, before the cargo build that
/// bundles, so a real binary always overwrites this first. The placeholder only
/// survives a bare `cargo check` / `cargo test`, neither of which bundles.
fn ensure_sidecar_placeholder() {
    let (Ok(target), Ok(manifest_dir)) = (
        std::env::var("TARGET"),
        std::env::var("CARGO_MANIFEST_DIR"),
    ) else {
        return;
    };

    // The `.exe` follows the TARGET os, not the machine building it.
    let ext = if target.contains("windows") { ".exe" } else { "" };
    let path = PathBuf::from(manifest_dir)
        .join("binaries")
        .join(format!("spacron-server-{target}{ext}"));

    if path.exists() {
        return;
    }

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::File::create(&path).is_ok() {
        println!(
            "cargo:warning=staged an empty sidecar placeholder at {}; \
             run `npm run server:build` to put the real spacron-server there",
            path.display()
        );
    }
}

fn main() {
    ensure_sidecar_placeholder();
    tauri_build::build()
}
