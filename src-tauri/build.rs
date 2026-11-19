use std::path::PathBuf;

/// Stamp an empty `binaries/<name>-<triple>[.exe]` when none is there.
///
/// `bundle.externalBin` in `tauri.conf.json` names `binaries/spacron-server`
/// and `binaries/spacron-open`, and tauri-build resolves each to a
/// triple-suffixed path on **every** cargo
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
fn ensure_sidecar_placeholder(name: &str) {
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
        .join(format!("{name}-{target}{ext}"));

    if path.exists() {
        return;
    }

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::File::create(&path).is_ok() {
        println!(
            "cargo:warning=staged an empty sidecar placeholder at {}; \
             run `npm run server:build` to put the real binary there",
            path.display()
        );
    }
}

/// Keep tauri-build from copying the sidecars into cargo's own build directory.
///
/// tauri-build copies every `bundle.externalBin` sidecar out of `binaries/` on
/// each cargo invocation of this package, into the directory it resolves as
/// `OUT_DIR.parent().parent().parent()`. That assumes cargo's older flat layout
/// (`target/<profile>/build/<pkg>-<hash>/out`). Cargo now nests it as
/// `target/<profile>/build/<pkg>/<hash>/out`, so three parents up is
/// `target/<profile>/build` rather than the profile directory — and the copy
/// lands inside cargo's per-package build directories.
///
/// On Windows that is invisible: `target/<profile>/build/spacron-server.exe`
/// sits next to cargo's `target/<profile>/build/spacron-server/` directory and
/// nothing opens either. On every other target there is no `.exe`, so the copy
/// is named exactly `spacron-server` — the name of a *workspace package*, so
/// cargo already owns that path as a directory. tauri-build clears whatever is
/// there with an unchecked `fs::remove_file(&dest).unwrap()`
/// (tauri-build/src/lib.rs:80); unlinking a directory is `EISDIR` on Linux and
/// `EPERM` on macOS, which Rust shows as `PermissionDenied: "Operation not
/// permitted"`. The panic takes the whole build down inside the
/// `cargo build -p spacron-server` that `scripts/build-server-sidecar.js` runs
/// from `beforeBuildCommand`, before a line of our code compiles. When it does
/// get past that, the copy is a *file* at the path cargo needs as a directory,
/// and cargo fails writing `.../build/spacron-server/<hash>/fingerprint/`.
///
/// There is nothing to preserve by letting it copy: nothing reads a sidecar out
/// of `target/<profile>/build/`. So remove `externalBin` from the config the
/// build script sees. `tauri.conf.json` keeps it — the bundler and
/// `tauri::generate_context!` read that, not this — and an existing
/// `TAURI_CONFIG` (the CLI sets one when it has overrides) is merged, not
/// replaced. `scripts/build-server-sidecar.js` still stages the real binaries in
/// `binaries/`, which is what the bundle packages.
///
/// Delete this — and the `serde_json` build-dependency it needs — once
/// tauri-build resolves the profile directory from the target directory instead
/// of counting parents up from `OUT_DIR`.
fn skip_sidecar_copy() {
    // Anything the CLI already handed us must survive: it can carry capability
    // and bundle overrides this build needs.
    let mut config = std::env::var("TAURI_CONFIG")
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));

    let Some(config) = config.as_object_mut() else {
        return;
    };
    let bundle = config
        .entry("bundle")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(bundle) = bundle.as_object_mut() {
        bundle.insert("externalBin".into(), serde_json::json!([]));
        if let Ok(text) = serde_json::to_string(config) {
            std::env::set_var("TAURI_CONFIG", text);
        }
    }
}

fn main() {
    // Both sidecars named by `bundle.externalBin`. `spacron-open` is the browser
    // shim agents get as their `BROWSER`; it is a separate crate for the same
    // reason the server is — see the note atop `opener/Cargo.toml`.
    ensure_sidecar_placeholder("spacron-server");
    ensure_sidecar_placeholder("spacron-open");
    skip_sidecar_copy();
    tauri_build::build()
}
