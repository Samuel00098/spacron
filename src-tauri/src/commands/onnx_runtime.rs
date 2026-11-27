//! Fetching the ONNX Runtime shared library that offline Parakeet STT needs.
//!
//! ## Why the app has to do this at all
//!
//! `ort` is built with `load-dynamic`, which enables `ort-sys/disable-linking`,
//! which makes ort-sys's build script return before doing anything — its own
//! comment reads "we don't need to download anything because we don't provide
//! DLLs anymore". So the build produces no ONNX Runtime library anywhere, and
//! Parakeet STT cannot run without one. (`load-dynamic` still earns its place:
//! it is what avoids the Linux Abseil static-link failure documented on the
//! `ort` dependency in `Cargo.toml`.)
//!
//! The library is fetched at runtime rather than bundled, for the same reason
//! the Parakeet weights are: this feature already requires a ~600 MB download
//! before it works at all, so an installer carrying tens of megabytes of runtime
//! for users who never enable STT buys nothing. It lands beside those weights in
//! the models directory, which is exactly where
//! `commands/parakeet.rs::ensure_ort_dylib` looks.
//!
//! ## Where the library comes from
//!
//! From Microsoft's own `Microsoft.ML.OnnxRuntime` package on nuget.org, with
//! the SHA-512 nuget.org's catalog publishes for that exact version. It used to
//! be Microsoft's GitHub release assets; `github.com/microsoft/onnxruntime`
//! answered 404 on 2026-11-27, which left users with the speech model and no
//! runtime. Third-party mirrors are not used: what is downloaded here is loaded
//! into this process.
//!
//! The package carries every platform's library under
//! `runtimes/<rid>/native/`, so one URL and one digest serve all of them.
//!
//! The obvious-looking source is the CDN `ort-sys` itself downloads from, and
//! it is the wrong one: those archives are built for static linking and hold no
//! loadable library.
//!
//! ## Version
//!
//! `ort` rc.12 requests API version 24 (its default `api-24` feature). ONNX
//! Runtime keeps its C API backward compatible, so [`DIST_VERSION`] tracks a
//! current release rather than pinning 1.24 exactly. That claim is not taken on
//! trust: the ignored `installs_a_working_runtime` test loads the downloaded
//! library through `ort`.
//!
//! The download is verified against the pinned SHA-512 **before** anything is
//! written into the models directory: an unverified native library would be
//! arbitrary code execution.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The upstream release [`PACKAGE_URL`] points at. Bump the URL and digest
/// together with this, and re-run the ignored `installs_a_working_runtime` test.
pub const DIST_VERSION: &str = "ONNX Runtime 1.31.1";

const PACKAGE_URL: &str = "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.1/microsoft.ml.onnxruntime.1.31.1.nupkg";

/// nuget.org's published `packageHash` for [`PACKAGE_URL`], as hex.
const PACKAGE_SHA512: &str = "42f13cf89ca111c71f38bececf59be7125d919877840aeff06db1da026a7d1e685daaaa039254357f1fb84de43e492467ac279bc83420cb0d57472e73b4c6327";

/// `(rust target triple, path of the library inside the package)`.
///
/// `x86_64-apple-darwin` is deliberately absent: Microsoft publishes no
/// Intel-Mac build, so an Intel Mac gets an honest "unsupported" message.
const DIST: &[(&str, &str)] = &[
    ("x86_64-pc-windows-msvc", "runtimes/win-x64/native/onnxruntime.dll"),
    ("aarch64-pc-windows-msvc", "runtimes/win-arm64/native/onnxruntime.dll"),
    ("x86_64-unknown-linux-gnu", "runtimes/linux-x64/native/libonnxruntime.so"),
    ("aarch64-unknown-linux-gnu", "runtimes/linux-arm64/native/libonnxruntime.so"),
    ("aarch64-apple-darwin", "runtimes/osx-arm64/native/libonnxruntime.dylib"),
];

/// This build's Rust target triple, assembled from `cfg`.
///
/// `std::env::consts` gives OS and architecture but not the ABI, and the triples
/// differ by it (`-msvc`, `-gnu`, `-darwin`), so it is spelled out rather than
/// guessed. Anything not listed returns `None` and is reported as unsupported.
fn current_target() -> Option<&'static str> {
    Some(match (std::env::consts::ARCH, std::env::consts::OS) {
        ("x86_64", "windows") => "x86_64-pc-windows-msvc",
        ("aarch64", "windows") => "aarch64-pc-windows-msvc",
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu",
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu",
        ("aarch64", "macos") => "aarch64-apple-darwin",
        _ => return None,
    })
}

/// Where this build's library sits inside the package, if it has one.
fn entry_for_current_target() -> Option<&'static str> {
    let target = current_target()?;
    DIST.iter()
        .find(|(triple, _)| *triple == target)
        .map(|(_, entry)| *entry)
}

/// The library file name `parakeet::ensure_ort_dylib` looks for. Kept identical
/// to the name `ort` itself would `dlopen` by default, so a user who installs
/// ONNX Runtime by hand and one who lets the app fetch it end up with the same
/// layout.
fn dylib_name() -> &'static str {
    if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    }
}

/// Same directory the Parakeet weights live in (`commands/models.rs`).
fn models_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("spacron")
        .join("models")
}

fn installed_path() -> PathBuf {
    models_dir().join(dylib_name())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnnxRuntimeStatus {
    /// Whether a library is present and usable.
    pub installed: bool,
    /// Whether this platform has a distribution at all — false on Intel Macs.
    pub supported: bool,
    /// Bytes on disk when installed.
    pub size_bytes: u64,
    /// Which upstream release the pinned distribution comes from.
    pub version: String,
}

/// Whether the ONNX Runtime library is already in place: the one installed
/// here, or one the user supplied where `ensure_ort_dylib` also looks.
///
/// A zero-byte file counts as absent: an interrupted write should present as
/// "not installed" and be re-fetched, not as a library that fails to load.
#[tauri::command(async)]
pub async fn onnx_runtime_status() -> OnnxRuntimeStatus {
    let path = installed_path();
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    OnnxRuntimeStatus {
        installed: size > 0 || crate::commands::parakeet::ensure_ort_dylib().is_ok(),
        supported: entry_for_current_target().is_some(),
        size_bytes: size,
        version: DIST_VERSION.to_string(),
    }
}

/// Download, verify and install the ONNX Runtime library for this platform.
///
/// Idempotent: returns immediately when one is already installed, so callers can
/// invoke it unconditionally before a transcription rather than tracking state.
///
/// The whole package (about 160 MB) is read into memory before anything is
/// written. That is cheap next to the ~600 MB of weights this feature already
/// requires, and it means the SHA-512 is checked against the complete
/// bytes before a single one reaches disk — a streaming extract-then-verify
/// would have to unpack an unverified native library first.
#[tauri::command(async)]
pub async fn onnx_runtime_download() -> Result<OnnxRuntimeStatus, String> {
    // A model download and a first dictation can both ask at once.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = ONE_AT_A_TIME.lock().await;

    if installed_path().metadata().map(|m| m.len()).unwrap_or(0) > 0 {
        return Ok(onnx_runtime_status().await);
    }

    let Some(entry) = entry_for_current_target() else {
        return Err(format!(
            "There is no prebuilt ONNX Runtime for this platform ({} {}), so offline \
             speech-to-text is unavailable. Build ONNX Runtime yourself and set \
             ORT_DYLIB_PATH to it if you need it here.",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    };

    // A bounded client, not the bare `reqwest::get`. That helper applies no
    // timeout at all, and a stalled connection to the CDN then hangs the command
    // indefinitely — observed here as a 22-minute wait before the transport gave
    // up on its own. The whole-request budget is generous because the archive is
    // ~160 MB on a slow line, but it is finite.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| format!("Could not create the download client: {e}"))?;

    // Retried, because a transfer this size does not reliably complete in one
    // go, and one dropped read should not mean "offline STT is broken".
    //
    // Each attempt restarts from zero rather than resuming: the digest is over
    // the whole archive, and a resumed transfer that silently stitched two
    // partial bodies together is exactly the sort of thing the digest exists to
    // catch — better to spend the bandwidth than to invent range-request
    // bookkeeping that could hand a corrupt library to `dlopen`.
    const ATTEMPTS: u32 = 3;
    let mut last_error = String::new();
    let mut archive = None;
    for attempt in 1..=ATTEMPTS {
        if attempt > 1 {
            tokio::time::sleep(std::time::Duration::from_secs(2 * attempt as u64)).await;
        }
        let response = match client.get(PACKAGE_URL).send().await {
            Ok(response) => response,
            Err(e) => {
                last_error = format!("could not reach the download ({e})");
                continue;
            }
        };
        if !response.status().is_success() {
            // A bad status is not transient — a 404 means the pinned URL is
            // wrong and retrying only wastes the user's time.
            return Err(format!(
                "The ONNX Runtime download failed with HTTP {}.",
                response.status()
            ));
        }
        match response.bytes().await {
            Ok(bytes) => {
                archive = Some(bytes);
                break;
            }
            Err(e) => last_error = format!("the transfer was interrupted ({e})"),
        }
    }
    let Some(archive) = archive else {
        return Err(format!(
            "Could not download ONNX Runtime after {ATTEMPTS} attempts: {last_error}."
        ));
    };

    verify_sha512(&archive, PACKAGE_SHA512)?;

    let dir = models_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let library = extract_library(&archive, entry)?;

    // Write to a temp name and rename into place, so an interrupted install
    // never leaves a half-written library that would be loaded as if complete.
    let staged = dir.join(format!("{}.part", dylib_name()));
    fs::write(&staged, &library)
        .map_err(|e| format!("Could not write the ONNX Runtime library: {e}"))?;
    let final_path = installed_path();
    fs::rename(&staged, &final_path).map_err(|e| {
        let _ = fs::remove_file(&staged);
        format!("Could not install the ONNX Runtime library: {e}")
    })?;

    Ok(onnx_runtime_status().await)
}

/// Reject anything whose digest is not exactly `expected`.
///
/// This is the gate that makes downloading a native library acceptable at all:
/// what comes back is loaded into this process, so a hijacked CDN, a proxy that
/// rewrites payloads, or a MITM must not be able to substitute one.
fn verify_sha512(bytes: &[u8], expected: &str) -> Result<(), String> {
    use sha2::Digest;

    let digest = sha2::Sha512::digest(bytes);
    let actual = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "The downloaded ONNX Runtime did not match its expected checksum \
             (got {actual}, expected {expected}). It has been discarded."
        ))
    }
}

/// Pull one platform's library out of the package, which is a zip.
fn extract_library(archive: &[u8], wanted: &str) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|e| format!("The ONNX Runtime package could not be read: {e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("The ONNX Runtime package is corrupt: {e}"))?;
        let name = entry
            .name()
            .map_err(|e| format!("The ONNX Runtime package is corrupt: {e}"))?
            .into_owned();
        if name != wanted {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not unpack the ONNX Runtime library: {e}"))?;
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    Err("The ONNX Runtime package did not contain a runtime library.".to_string())
}

/// Remove an installed library, so a corrupt one can be re-fetched.
#[tauri::command(async)]
pub async fn onnx_runtime_remove() -> Result<OnnxRuntimeStatus, String> {
    let path = installed_path();
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Could not remove the ONNX Runtime library: {e}"))?;
    }
    Ok(onnx_runtime_status().await)
}

/// Whether `dir` holds an installed runtime — used by the Parakeet download
/// flow to decide whether it still needs fetching.
pub(crate) fn runtime_present_in(dir: &Path) -> bool {
    dir.join(dylib_name())
        .metadata()
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A typo here is not a compile error and would only surface as a failed
    /// download or a checksum that can never match.
    #[test]
    fn the_pinned_package_is_well_formed() {
        assert!(PACKAGE_URL.starts_with("https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/"));
        let version = DIST_VERSION.rsplit(' ').next().unwrap();
        assert!(PACKAGE_URL.contains(version), "url is not the pinned version");
        assert_eq!(PACKAGE_SHA512.len(), 128, "not a sha512");
        assert!(PACKAGE_SHA512.chars().all(|c| c.is_ascii_hexdigit()));
        for (target, entry) in DIST {
            assert!(entry.starts_with("runtimes/"), "{target}");
            assert_eq!(entry.ends_with(".dll"), target.contains("windows"), "{target}");
        }
    }

    /// The host this test runs on must resolve to a real entry. Intel macOS is
    /// the known, deliberate exception and has no CI runner.
    #[test]
    fn this_platform_resolves_to_a_library() {
        assert!(
            entry_for_current_target().is_some_and(|entry| entry.ends_with(dylib_name())),
            "no ONNX Runtime library for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        assert!(!DIST.iter().any(|(t, _)| *t == "x86_64-apple-darwin"));
    }

    #[test]
    fn only_the_wanted_library_is_unpacked() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in [
            ("runtimes/win-x64/native/onnxruntime_providers_shared.dll", "providers"),
            ("runtimes/win-x64/native/onnxruntime.dll", "core"),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let found = extract_library(&bytes, "runtimes/win-x64/native/onnxruntime.dll").unwrap();
        assert_eq!(found, b"core");
        assert!(extract_library(&bytes, "runtimes/linux-x64/native/libonnxruntime.so").is_err());
    }

    /// The real thing: download, verify, unpack, install, and confirm `ort` will
    /// load the result. Ignored by default: it pulls about 160 MB and writes into
    /// this machine's real models directory.
    ///
    /// ```text
    /// cargo test --lib installs_a_working_runtime -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "downloads the real ONNX Runtime over the network"]
    fn installs_a_working_runtime() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

        let status = runtime
            .block_on(onnx_runtime_download())
            .expect("download + verify + extract");
        println!("installed={} bytes={}", status.installed, status.size_bytes);
        assert!(status.installed);
        assert!(status.size_bytes > 1_000_000, "suspiciously small library");

        let path = installed_path();
        assert!(path.is_file(), "{} was not created", path.display());
        crate::commands::parakeet::ensure_ort_dylib().expect("ort loads the installed runtime");
    }

    #[test]
    fn a_wrong_checksum_is_refused() {
        let expected = "0".repeat(128);
        let err = verify_sha512(b"not the real package", &expected).unwrap_err();
        assert!(err.contains("did not match"), "{err}");
    }

    #[test]
    fn the_matching_checksum_is_accepted() {
        // sha512 of the empty string.
        let empty = "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e";
        assert!(verify_sha512(b"", empty).is_ok());
        assert!(verify_sha512(b"", &empty.to_uppercase()).is_ok());
    }
}
