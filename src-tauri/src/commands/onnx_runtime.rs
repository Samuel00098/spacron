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
//! ## Where the URLs and hashes come from — and why not from pyke
//!
//! From **Microsoft's official ONNX Runtime GitHub release**, with the SHA-256
//! digests GitHub's own release API publishes for each asset. Nothing here was
//! invented, and nothing is hashed on first use.
//!
//! The obvious-looking source is the CDN `ort-sys` itself downloads from
//! (`build/download/dist.txt`), and it is the wrong one. Those archives are
//! built for **static linking**: the `x86_64-pc-windows-msvc` one was fetched
//! and unpacked while writing this, and it contains exactly two files — a 305 MB
//! `onnxruntime.lib` and `DirectML.dll`. There is no loadable `onnxruntime.dll`
//! in it, so it cannot satisfy `load-dynamic` no matter how it is unpacked.
//! Microsoft's release archives carry the real shared library under `lib/`.
//!
//! ## Version
//!
//! `ort` rc.12 requests API version 24 (its default `api-24` feature). ONNX
//! Runtime keeps its C API backward compatible — `GetApi(24)` is honoured by any
//! later runtime — so [`DIST_VERSION`] tracks a current release rather than
//! pinning 1.24 exactly. That claim is not taken on trust: the ignored
//! `installs_a_working_runtime` test loads the downloaded library through `ort`,
//! which is the only thing that actually proves the pairing works.
//!
//! The download is verified against the pinned SHA-256 **before** anything is
//! written into the models directory. That matters more here than for the model
//! weights: this is a native shared library the app then loads into its own
//! process, so an unverified one is arbitrary code execution. A hash mismatch
//! discards the download and reports an error.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The upstream release [`DIST`] points at. Bump the URLs and digests together
/// with this, and re-run the ignored `installs_a_working_runtime` test.
pub const DIST_VERSION: &str = "ONNX Runtime 1.29.0";

/// `(rust target triple, url, sha256)` for the plain CPU build of ONNX Runtime.
///
/// URLs and digests are Microsoft's published release assets; the digests come
/// from the GitHub release API's `digest` field for each asset, not from hashing
/// a download here.
///
/// `x86_64-apple-darwin` is deliberately absent: **Microsoft publishes no
/// Intel-Mac build** at this version — the macOS asset list is `osx-arm64` only.
/// An Intel Mac therefore gets an honest "unsupported" message rather than a
/// download that 404s. GPU variants (CUDA/DirectML) are omitted on purpose; this
/// is CPU inference in a desktop app, and they are 4-40× the size.
const DIST: &[(&str, &str, &str)] = &[
    (
        "x86_64-pc-windows-msvc",
        "https://github.com/microsoft/onnxruntime/releases/download/v1.29.0/onnxruntime-win-x64-1.29.0.zip",
        "c9b4b7086b529ad814f428c1bad028e20a25d7dc0699836775faace4ab5b78b2",
    ),
    (
        "aarch64-pc-windows-msvc",
        "https://github.com/microsoft/onnxruntime/releases/download/v1.29.0/onnxruntime-win-arm64-1.29.0.zip",
        "a094a49c3ced0f9fca554647cc7566ae99d93a63a8ce6bf47975561c2de7608e",
    ),
    (
        "x86_64-unknown-linux-gnu",
        "https://github.com/microsoft/onnxruntime/releases/download/v1.29.0/onnxruntime-linux-x64-1.29.0.tgz",
        "c3fddc4f139a045b0c4902c57410f0694f1c2fdf9b6939fbe38b1aeae7cd14ba",
    ),
    (
        "aarch64-unknown-linux-gnu",
        "https://github.com/microsoft/onnxruntime/releases/download/v1.29.0/onnxruntime-linux-aarch64-1.29.0.tgz",
        "e1799098ebc054b370f6176a450f158720f297818c613e5dc99b92e2ec82346f",
    ),
    (
        "aarch64-apple-darwin",
        "https://github.com/microsoft/onnxruntime/releases/download/v1.29.0/onnxruntime-osx-arm64-1.29.0.tgz",
        "d0706fc34f315d8c88639d0a8c81f2e09e815f282cabed3493c06a054352cf92",
    ),
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

/// The distribution entry for this build, if one exists.
fn dist_for_current_target() -> Option<(&'static str, &'static str)> {
    let target = current_target()?;
    DIST.iter()
        .find(|(triple, _, _)| *triple == target)
        .map(|(_, url, hash)| (*url, *hash))
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

/// Whether the ONNX Runtime library is already in place.
///
/// A zero-byte file counts as absent: an interrupted write should present as
/// "not installed" and be re-fetched, not as a library that fails to load.
#[tauri::command(async)]
pub async fn onnx_runtime_status() -> OnnxRuntimeStatus {
    let path = installed_path();
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    OnnxRuntimeStatus {
        installed: size > 0,
        supported: dist_for_current_target().is_some(),
        size_bytes: size,
        version: DIST_VERSION.to_string(),
    }
}

/// Download, verify and install the ONNX Runtime library for this platform.
///
/// Idempotent: returns immediately when one is already installed, so callers can
/// invoke it unconditionally before a transcription rather than tracking state.
///
/// The whole archive is read into memory before anything is written. It is tens
/// of megabytes, which is cheap next to the ~600 MB of weights this feature
/// already requires, and it means the SHA-256 is checked against the complete
/// bytes before a single one reaches disk — a streaming extract-then-verify
/// would have to unpack an unverified native library first.
#[tauri::command(async)]
pub async fn onnx_runtime_download() -> Result<OnnxRuntimeStatus, String> {
    if installed_path().metadata().map(|m| m.len()).unwrap_or(0) > 0 {
        return Ok(onnx_runtime_status().await);
    }

    let Some((url, expected_hash)) = dist_for_current_target() else {
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
    // ~80 MB on a slow line, but it is finite.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| format!("Could not create the download client: {e}"))?;

    // Retried, because an ~80 MB transfer from GitHub's asset CDN does not
    // reliably complete in one go: while building this, the same URL succeeded
    // once and then twice dropped mid-body ("error decoding response body"). A
    // user on a worse connection than a dev machine will see that more often,
    // and one dropped read should not mean "offline STT is broken".
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
        let response = match client.get(url).send().await {
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

    verify_sha256(&archive, expected_hash)?;

    let dir = models_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let library = extract_library(url, &archive)?;

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
fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    use sha2::Digest;

    let digest = sha2::Sha256::digest(bytes);
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

/// Whether a path inside the archive is the main ONNX Runtime library.
///
/// The archive holds its shared libraries flat at the root, and on Unix there
/// can be more than one — a versioned `libonnxruntime.so.1.24.2` alongside
/// provider libraries such as `libonnxruntime_providers_shared.so`. Only the
/// core library is wanted: an underscore after `onnxruntime` marks a provider,
/// which `ort` loads separately if ever asked to and which must not be mistaken
/// for the thing `dlopen` is pointed at.
fn is_core_library(name: &str) -> bool {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = name.strip_prefix("lib").unwrap_or(name);
    let Some(rest) = stem.strip_prefix("onnxruntime") else {
        return false;
    };
    if rest.starts_with('_') {
        return false;
    }
    name.contains(".dll") || name.contains(".dylib") || name.contains(".so")
}

/// Pull the ONNX Runtime library out of Microsoft's release archive.
///
/// Windows assets are `.zip`, macOS and Linux `.tgz`, so the format is chosen by
/// the URL rather than by the host — the two stay in step because both come from
/// the same [`DIST`] row.
fn extract_library(url: &str, archive: &[u8]) -> Result<Vec<u8>, String> {
    let found = if url.ends_with(".zip") {
        extract_from_zip(archive)?
    } else {
        extract_from_tgz(archive)?
    };
    found.ok_or_else(|| {
        "The ONNX Runtime archive did not contain a runtime library.".to_string()
    })
}

fn extract_from_zip(archive: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|e| format!("The ONNX Runtime archive could not be read: {e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| format!("The ONNX Runtime archive is corrupt: {e}"))?;
        if !entry.is_file() || !is_core_library(entry.name()) {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not unpack the ONNX Runtime library: {e}"))?;
        if !bytes.is_empty() {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

fn extract_from_tgz(archive: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let decompressed = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decompressed);
    let entries = tar
        .entries()
        .map_err(|e| format!("The ONNX Runtime archive could not be read: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("The ONNX Runtime archive is corrupt: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("The ONNX Runtime archive has an unreadable entry: {e}"))?
            .to_string_lossy()
            .to_string();
        if !is_core_library(&path) {
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not unpack the ONNX Runtime library: {e}"))?;
        // `lib/libonnxruntime.so` is a symlink to the versioned file and reads
        // as zero bytes; skipping empties lands on the real library instead.
        if !bytes.is_empty() {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
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

    /// Every pinned entry must be a well-formed, HTTPS, 64-hex-digit record.
    /// A typo in one of these is not a compile error and would only surface as
    /// a failed download or — worse — a checksum that can never match.
    #[test]
    fn the_pinned_distribution_list_is_well_formed() {
        for (target, url, hash) in DIST {
            assert!(url.starts_with("https://"), "{target} url is not https");
            assert!(
                url.starts_with("https://github.com/microsoft/onnxruntime/releases/download/"),
                "{target} url is not a Microsoft release asset"
            );
            // Windows ships zip, macOS/Linux gzipped tar. `extract_library`
            // picks its unpacker from this suffix, so an unexpected one would be
            // silently handed to the wrong reader.
            assert!(
                url.ends_with(".zip") || url.ends_with(".tgz"),
                "{target} url is neither a zip nor a tgz"
            );
            assert_eq!(
                url.ends_with(".zip"),
                target.contains("windows"),
                "{target} archive format does not match the platform"
            );
            assert!(url.contains("1.29.0"), "{target} url is not the pinned version");
            assert_eq!(hash.len(), 64, "{target} hash is not a sha256");
            assert!(
                hash.chars().all(|c| c.is_ascii_hexdigit()),
                "{target} hash is not hex"
            );
        }
    }

    /// The host this test runs on must resolve to a real entry — otherwise CI
    /// is silently shipping a platform that can never install the runtime.
    /// Intel macOS is the known, deliberate exception and has no CI runner.
    #[test]
    fn this_platform_resolves_to_a_distribution() {
        assert!(
            dist_for_current_target().is_some(),
            "no ONNX Runtime distribution for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
    }

    #[test]
    fn intel_macs_are_reported_as_unsupported_rather_than_guessed_at() {
        // pyke publishes no x86_64-apple-darwin build; inventing that URL would
        // produce a 404 at download time instead of an honest message.
        assert!(!DIST.iter().any(|(t, _, _)| *t == "x86_64-apple-darwin"));
    }

    #[test]
    fn the_core_library_is_told_apart_from_provider_libraries() {
        assert!(is_core_library("onnxruntime.dll"));
        assert!(is_core_library("libonnxruntime.so"));
        assert!(is_core_library("libonnxruntime.so.1.24.2"));
        assert!(is_core_library("libonnxruntime.dylib"));
        assert!(is_core_library("libonnxruntime.1.24.2.dylib"));
        // Provider libraries ship alongside it and must never be picked.
        assert!(!is_core_library("libonnxruntime_providers_shared.so"));
        assert!(!is_core_library("onnxruntime_providers_cuda.dll"));
        // Nor anything that merely sits in the archive.
        assert!(!is_core_library("LICENSE"));
        assert!(!is_core_library("headers/onnxruntime_c_api.h"));
    }

    /// The real thing: download, verify, extract, install, and confirm the
    /// result is a library `ort` will actually load.
    ///
    /// Ignored by default — it hits the network, writes into this machine's real
    /// models directory, and pulls tens of megabytes. It is the only check that
    /// covers the pinned URL, the pinned hash, the LZMA2/tar unpacking and the
    /// hand-off to `parakeet::ensure_ort_dylib` together, so run it after
    /// touching any of them:
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

        // The payoff: the library resolves and loads through the same path the
        // STT pipeline uses. This is what proves the archive yielded a real
        // runtime rather than, say, a provider stub or a text file.
        crate::commands::parakeet::ensure_ort_dylib().expect("ort loads the installed runtime");
    }

    /// Diagnostic: print the archive's contents. Ignored; run when the layout
    /// upstream ships appears to have changed.
    ///
    /// ```text
    /// cargo test --lib lists_the_archive_contents -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "downloads the real ONNX Runtime over the network"]
    fn lists_the_archive_contents() {
        let (url, hash) = dist_for_current_target().expect("a distribution for this platform");
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let bytes = runtime.block_on(async {
            reqwest::get(url)
                .await
                .expect("fetch")
                .bytes()
                .await
                .expect("body")
        });
        verify_sha256(&bytes, hash).expect("checksum");
        println!("archive bytes: {}", bytes.len());

        if url.ends_with(".zip") {
            let mut zip = zip::ZipArchive::new(Cursor::new(&bytes[..])).expect("zip");
            for index in 0..zip.len() {
                let entry = zip.by_index(index).expect("entry");
                println!(
                    "  {} size={} core={}",
                    entry.name(),
                    entry.size(),
                    is_core_library(entry.name())
                );
            }
        } else {
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..]));
            for entry in tar.entries().expect("entries") {
                let entry = entry.expect("entry");
                let path = entry.path().expect("path").to_string_lossy().to_string();
                println!(
                    "  {path} size={} core={}",
                    entry.header().size().unwrap_or(0),
                    is_core_library(&path)
                );
            }
        }
    }

    #[test]
    fn a_wrong_checksum_is_refused() {
        let expected = "0".repeat(64);
        let err = verify_sha256(b"not the real archive", &expected).unwrap_err();
        assert!(err.contains("did not match"), "{err}");
    }

    #[test]
    fn the_matching_checksum_is_accepted() {
        // sha256 of the empty string.
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert!(verify_sha256(b"", empty).is_ok());
        // Case-insensitively, since hex digests get pasted in either case.
        assert!(verify_sha256(b"", &empty.to_uppercase()).is_ok());
    }
}
