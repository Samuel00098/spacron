use std::path::{Path, PathBuf};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, Mutex, Arc};
use std::collections::{HashMap, HashSet};
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Emitter};
use futures_util::StreamExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub category: String, // "stt" | "tts"
    pub size: String,
    pub description: String,
    pub url: String,
    pub filename: String,
    pub downloaded: bool,
    /// Actual total bytes on disk once downloaded (sum of all files for
    /// multi-file models). `None` when the model isn't fully downloaded.
    #[serde(default)]
    pub downloaded_size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct DownloadProgressPayload {
    pub model_id: String,
    pub progress: f64,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub phase: String, // "main" | "voices" | "done"
}

#[derive(Clone, Serialize)]
pub struct DownloadErrorPayload {
    pub model_id: String,
    pub error: String,
}

static ACTIVE_DOWNLOADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// Track active download `AbortHandle`s so the frontend can cancel mid-download.
static ACTIVE_CANCEL_TOKENS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn active_downloads() -> &'static Mutex<HashSet<String>> {
    ACTIVE_DOWNLOADS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn active_cancel_tokens() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    ACTIVE_CANCEL_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn get_models_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("spacron")
        .join("models")
}

// Parakeet ships as a set of ONNX files (encoder + decoder/joint + tokenizer +
// mel preprocessor) rather than a single weight file. The first entry is the
// "main" file used by the generic single-file plumbing; the rest are fetched
// alongside it. (url, local filename, progress phase).
const PARAKEET_FILES: &[(&str, &str, &str)] = &[
    (
        "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx",
        "parakeet-encoder.int8.onnx",
        "main",
    ),
    (
        "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.int8.onnx",
        "parakeet-decoder.int8.onnx",
        "decoder",
    ),
    (
        "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/vocab.txt",
        "parakeet-vocab.txt",
        "tokenizer",
    ),
    (
        "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx",
        "parakeet-preprocessor.onnx",
        "preprocessor",
    ),
];

/// Expected SHA-256 of every model file we download, keyed by its on-disk file
/// name. Pinned from the upstream HuggingFace repos (an LFS file's `oid` *is* its
/// SHA-256; the non-LFS `vocab.txt` was hashed directly). Every completed
/// download is verified against this before being moved into place, so a
/// compromised, hijacked, or MITM'd upstream can't deliver a poisoned model that
/// the native ONNX / whisper runtimes would then parse and execute. To add a
/// model, pin its digest here too — files without an entry are downloaded but
/// not integrity-checked.
const MODEL_SHA256: &[(&str, &str)] = &[
    // Whisper — ggerganov/whisper.cpp
    ("ggml-tiny.en.bin", "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f"),
    ("ggml-base.en.bin", "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"),
    ("ggml-small.en.bin", "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d"),
    ("ggml-large-v3-turbo-q5_0.bin", "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
    ("ggml-large-v3-turbo.bin", "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"),
    // Parakeet — istupakov/parakeet-tdt-0.6b-v3-onnx
    ("parakeet-encoder.int8.onnx", "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
    ("parakeet-decoder.int8.onnx", "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
    ("parakeet-vocab.txt", "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
    ("parakeet-preprocessor.onnx", "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
];

/// The expected SHA-256 for a given on-disk model file name, if one is pinned.
fn expected_sha256(filename: &str) -> Option<&'static str> {
    MODEL_SHA256
        .iter()
        .find(|(name, _)| *name == filename)
        .map(|(_, hash)| *hash)
}

fn file_present(path: &Path) -> bool {
    path.exists() && path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

#[tauri::command]
pub async fn list_downloadable_models() -> Result<Vec<ModelInfo>, String> {
    let models_dir = get_models_dir();
    let mut list = vec![
        ModelInfo {
            id: "whisper-tiny-en".to_string(),
            name: "Whisper Tiny (English)".to_string(),
            category: "stt".to_string(),
            size: "74 MB".to_string(),
            description: "Super fast, lightweight English transcription. Runs well on any CPU.".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin".to_string(),
            filename: "ggml-tiny.en.bin".to_string(),
            downloaded: false,
            downloaded_size_bytes: None,
        },
        ModelInfo {
            id: "whisper-base-en".to_string(),
            name: "Whisper Base (English)".to_string(),
            category: "stt".to_string(),
            size: "141 MB".to_string(),
            description: "Balanced speed and accuracy English transcription.".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin".to_string(),
            filename: "ggml-base.en.bin".to_string(),
            downloaded: false,
            downloaded_size_bytes: None,
        },
        ModelInfo {
            id: "whisper-small-en".to_string(),
            name: "Whisper Small (English)".to_string(),
            category: "stt".to_string(),
            size: "465 MB".to_string(),
            description: "Higher-accuracy English transcription. A solid step up from Base on capable machines.".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin".to_string(),
            filename: "ggml-small.en.bin".to_string(),
            downloaded: false,
            downloaded_size_bytes: None,
        },
        ModelInfo {
            id: "whisper-large-v3-turbo-q5".to_string(),
            name: "Whisper Large v3 Turbo (Quantized)".to_string(),
            category: "stt".to_string(),
            size: "547 MB".to_string(),
            description: "Latest Whisper Turbo, quantized. Near large-v3 accuracy, multilingual, at a fraction of the size.".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin".to_string(),
            filename: "ggml-large-v3-turbo-q5_0.bin".to_string(),
            downloaded: false,
            downloaded_size_bytes: None,
        },
        ModelInfo {
            id: "whisper-large-v3-turbo".to_string(),
            name: "Whisper Large v3 Turbo (Full)".to_string(),
            category: "stt".to_string(),
            size: "1.5 GB".to_string(),
            description: "Highest-accuracy multilingual transcription. Best on machines with ample RAM and CPU.".to_string(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin".to_string(),
            filename: "ggml-large-v3-turbo.bin".to_string(),
            downloaded: false,
            downloaded_size_bytes: None,
        },
        ModelInfo {
            id: "parakeet-tdt-v3".to_string(),
            name: "NVIDIA Parakeet TDT v3 (Multilingual)".to_string(),
            category: "stt".to_string(),
            size: "640 MB".to_string(),
            description: "Latest NVIDIA Parakeet, with top-tier accuracy, very fast, ~25 languages. Runs locally via native ONNX. Needs ample RAM.".to_string(),
            url: PARAKEET_FILES[0].0.to_string(),
            filename: PARAKEET_FILES[0].1.to_string(),
            downloaded: false,
            downloaded_size_bytes: None,
        },
        ModelInfo {
            id: "silero-vad".to_string(),
            name: "Silero VAD (Smart voice detection)".to_string(),
            category: "stt".to_string(),
            size: "~2 MB".to_string(),
            description: "Neural voice-activity detector. Powers the optional Smart VAD mode: far better speech vs. noise separation than the built-in level gate, with fewer false turns from clicks, fans and background chatter. Tiny download.".to_string(),
            url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx".to_string(),
            filename: crate::commands::vad::SILERO_VAD_FILENAME.to_string(),
            downloaded: false,
            downloaded_size_bytes: None,
        },
    ];

    for model in &mut list {
        // Collect the on-disk files that make up this model so we can report the
        // real total size (some models ship as several files).
        let files: Vec<PathBuf> = if model.id == "parakeet-tdt-v3" {
            PARAKEET_FILES
                .iter()
                .map(|(_, filename, _)| models_dir.join(filename))
                .collect()
        } else {
            vec![models_dir.join(&model.filename)]
        };

        model.downloaded = files.iter().all(|p| file_present(p));
        model.downloaded_size_bytes = if model.downloaded {
            Some(
                files
                    .iter()
                    .filter_map(|p| fs::metadata(p).ok().map(|m| m.len()))
                    .sum(),
            )
        } else {
            None
        };
    }

    Ok(list)
}

#[tauri::command]
pub async fn download_model(app_handle: AppHandle, model_id: String) -> Result<(), String> {
    // 1. Guard against duplicate active downloads
    {
        let mut active = active_downloads().lock().map_err(|_| "Failed to lock active downloads")?;
        if active.contains(&model_id) {
            return Err("Model is already downloading".to_string());
        }
        active.insert(model_id.clone());
    }

    // 2. Resolve URLs and filenames
    let models_dir = get_models_dir();
    fs::create_dir_all(&models_dir).map_err(|e| format!("Failed to create models directory: {}", e))?;

    let (url, filename) = match model_id.as_str() {
        "whisper-tiny-en" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin".to_string(),
            "ggml-tiny.en.bin".to_string()
        ),
        "whisper-base-en" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin".to_string(),
            "ggml-base.en.bin".to_string()
        ),
        "whisper-small-en" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin".to_string(),
            "ggml-small.en.bin".to_string()
        ),
        "whisper-large-v3-turbo-q5" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin".to_string(),
            "ggml-large-v3-turbo-q5_0.bin".to_string()
        ),
        "whisper-large-v3-turbo" => (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin".to_string(),
            "ggml-large-v3-turbo.bin".to_string()
        ),
        "parakeet-tdt-v3" => (PARAKEET_FILES[0].0.to_string(), PARAKEET_FILES[0].1.to_string()),
        "silero-vad" => (
            "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx".to_string(),
            crate::commands::vad::SILERO_VAD_FILENAME.to_string()
        ),
        _ => {
            active_downloads().lock().unwrap().remove(&model_id);
            return Err("Unknown model ID".to_string());
        }
    };

    // 2b. Create a cancel token so the frontend can abort mid-download
    let cancel_token = Arc::new(AtomicBool::new(false));
    {
        if let Ok(mut tokens) = active_cancel_tokens().lock() {
            // Clean up stale tokens for completed/failed downloads
            tokens.retain(|id, _| active_downloads().lock().map(|a| a.contains(id)).unwrap_or(false));
            tokens.insert(model_id.clone(), cancel_token.clone());
        }
    }

    let app_handle_clone = app_handle.clone();
    let model_id_clone = model_id.clone();

    // Snapshot which of this model's FINAL files already exist on disk. On
    // cancel we only remove files THIS session created — deleting a pre-existing
    // complete copy would wipe a working install when a re-download is aborted.
    let preexisting_finals: std::collections::HashSet<std::path::PathBuf> = {
        let mut paths = vec![models_dir.join(&filename)];
        if model_id == "parakeet-tdt-v3" {
            for (_, fname, _) in PARAKEET_FILES.iter() {
                paths.push(models_dir.join(fname));
            }
        }
        paths.into_iter().filter(|p| p.exists()).collect()
    };

    // 3. Run download loop in a background thread
    tokio::spawn(async move {
        let result = async {
            // Check cancellation before starting
            if cancel_token.load(Ordering::Relaxed) {
                return Err("Download cancelled".to_string());
            }

            // Download the main file
            download_file_inner(&app_handle_clone, &model_id_clone, &cancel_token, &url, &models_dir.join(&filename), "main").await?;

            // Check cancellation before Parakeet's remaining files
            if cancel_token.load(Ordering::Relaxed) {
                return Err("Download cancelled".to_string());
            }

            // Parakeet's remaining ONNX files (the encoder is the "main" file above).
            if model_id_clone == "parakeet-tdt-v3" {
                for (url, filename, phase) in PARAKEET_FILES.iter().skip(1) {
                    download_file_inner(&app_handle_clone, &model_id_clone, &cancel_token, url, &models_dir.join(filename), phase).await?;
                }

                // The weights are useless without the ONNX Runtime that executes
                // them, and nothing in the build ships one — see
                // `commands/onnx_runtime.rs`. Fetching it here is what makes
                // "download Parakeet" mean "Parakeet works": the alternative is a
                // completed download that still cannot transcribe, failing later
                // with a message about a library the user never asked for.
                //
                // Deliberately not fatal. It is tens of megabytes against ~600 MB
                // of weights already on disk, and a platform with no prebuilt
                // runtime (Intel macOS) would otherwise be unable to finish a
                // download whose model files are all perfectly valid. The weights
                // stay, and transcription reports what is missing if it is tried.
                if !crate::commands::onnx_runtime::runtime_present_in(&models_dir) {
                    let _ = app_handle_clone.emit("download-progress", DownloadProgressPayload {
                        model_id: model_id_clone.clone(),
                        progress: 99.0,
                        bytes_downloaded: 0,
                        total_bytes: None,
                        phase: "runtime".to_string(),
                    });
                    if let Err(e) = crate::commands::onnx_runtime::onnx_runtime_download().await {
                        eprintln!("[onnx] Could not install the ONNX Runtime library: {e}");
                    }
                }
            }

            Ok::<(), String>(())
        }.await;

        // Clean up active download list
        if let Ok(mut active) = active_downloads().lock() {
            active.remove(&model_id_clone);
        }
        // Clean up cancel token
        if let Ok(mut tokens) = active_cancel_tokens().lock() {
            tokens.remove(&model_id_clone);
        }

        // Remove partial files on cancellation
        let was_cancelled = result.as_ref().is_err_and(|e| e == "Download cancelled");
        let model_id_for_cleanup = model_id_clone.clone();

        // Notify final status
        match &result {
            Ok(_) => {
                let _ = app_handle_clone.emit("download-progress", DownloadProgressPayload {
                    model_id: model_id_clone,
                    progress: 100.0,
                    bytes_downloaded: 0,
                    total_bytes: None,
                    phase: "done".to_string(),
                });
            }
            Err(err) => {
                if was_cancelled {
                    let _ = app_handle_clone.emit("download-cancelled", DownloadErrorPayload {
                        model_id: model_id_clone.clone(),
                        error: "Download cancelled by user".to_string(),
                    });
                } else {
                    let _ = app_handle_clone.emit("download-error", DownloadErrorPayload {
                        model_id: model_id_clone,
                        error: err.clone(),
                    });
                }
            }
        }

        // Clean up any partial download files after cancellation
        if was_cancelled {
            // Always drop the in-flight `.downloading` temp. Only drop a FINAL
            // file if this session created it (not in `preexisting_finals`), so a
            // cancelled re-download can never delete a previously installed,
            // complete copy. Partner files this session freshly renamed to their
            // final name are still cleaned up (they weren't pre-existing),
            // avoiding complete-but-orphaned leftovers of a partial download.
            let main_final = models_dir.join(&filename);
            let _ = fs::remove_file(main_final.with_extension("downloading"));
            if !preexisting_finals.contains(&main_final) {
                let _ = fs::remove_file(&main_final);
            }
            if model_id_for_cleanup == "parakeet-tdt-v3" {
                for (_, filename, _) in PARAKEET_FILES.iter() {
                    let p = models_dir.join(filename);
                    let _ = fs::remove_file(p.with_extension("downloading"));
                    if !preexisting_finals.contains(&p) {
                        let _ = fs::remove_file(&p);
                    }
                }
            }
        }
    });

    Ok(())
}

async fn download_file_inner(
    app_handle: &AppHandle,
    model_id: &str,
    cancel_token: &AtomicBool,
    url: &str,
    dest_path: &Path,
    phase: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to download server: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Server returned error code: {}", response.status()));
    }

    let total_size = response.content_length();

    // If this file has a pinned digest, hash it incrementally as it streams in
    // (no second pass over multi-GB files) and verify before we move it into
    // place. `None` means the file isn't integrity-pinned and is accepted as-is.
    let expected_hash = dest_path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(expected_sha256);
    let mut hasher = expected_hash.map(|_| <sha2::Sha256 as sha2::Digest>::new());

    // Download to a temporary file, then rename to prevent partial/corrupt files
    let temp_path = dest_path.with_extension("downloading");
    let mut file = fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create temporary file: {}", e))?;

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_progress_emit = std::time::Instant::now();

    while let Some(chunk_result) = stream.next().await {
        // Check cancellation before processing each chunk
        if cancel_token.load(Ordering::Relaxed) {
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err("Download cancelled".to_string());
        }

        let chunk = chunk_result.map_err(|e| format!("Error while downloading stream: {}", e))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("Failed to write chunk to disk: {}", e))?;
        if let Some(h) = hasher.as_mut() {
            sha2::Digest::update(h, &chunk);
        }
        downloaded += chunk.len() as u64;

        // Throttle progress updates to avoid flooding the IPC channel
        if last_progress_emit.elapsed().as_millis() > 100 {
            let progress = if let Some(total) = total_size {
                (downloaded as f64 / total as f64) * 100.0
            } else {
                0.0
            };

            let _ = app_handle.emit("download-progress", DownloadProgressPayload {
                model_id: model_id.to_string(),
                progress,
                bytes_downloaded: downloaded,
                total_bytes: total_size,
                phase: phase.to_string(),
            });
            last_progress_emit = std::time::Instant::now();
        }
    }

    // Flush and rename
    std::io::Write::flush(&mut file).map_err(|e| format!("Failed to flush file: {}", e))?;
    drop(file);

    // Integrity gate: reject a file whose SHA-256 doesn't match the pinned value
    // and discard it, so a tampered download never reaches its final path (and is
    // never loaded by the ONNX / whisper runtimes).
    if let (Some(expected_hex), Some(h)) = (expected_hash, hasher) {
        let digest = sha2::Digest::finalize(h);
        let actual_hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
        if !actual_hex.eq_ignore_ascii_case(expected_hex) {
            let _ = fs::remove_file(&temp_path);
            let name = dest_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");
            return Err(format!(
                "Integrity check failed for {name}: the downloaded file's SHA-256 did not match the expected value. The file was discarded. Please try again."
            ));
        }
    }

    if dest_path.exists() {
        fs::remove_file(dest_path).map_err(|e| format!("Failed to replace old file: {}", e))?;
    }
    fs::rename(&temp_path, dest_path)
        .map_err(|e| format!("Failed to finalize model download: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn cancel_download(model_id: String) -> Result<(), String> {
    // Signal cancellation by setting the cancel token
    if let Ok(tokens) = active_cancel_tokens().lock() {
        if let Some(token) = tokens.get(&model_id) {
            token.store(true, Ordering::Relaxed);
            return Ok(());
        }
    }
    Err("No active download found for this model".to_string())
}

#[tauri::command]
pub async fn delete_model(model_id: String) -> Result<(), String> {
    // Drop any cached whisper context so a re-download reloads fresh weights.
    #[cfg(feature = "whisper-stt")]
    if model_id.starts_with("whisper") {
        crate::commands::whisper::reset_whisper();
    }
    let models_dir = get_models_dir();
    let filename = match model_id.as_str() {
        "whisper-tiny-en" => "ggml-tiny.en.bin",
        "whisper-base-en" => "ggml-base.en.bin",
        "whisper-small-en" => "ggml-small.en.bin",
        "whisper-large-v3-turbo-q5" => "ggml-large-v3-turbo-q5_0.bin",
        "whisper-large-v3-turbo" => "ggml-large-v3-turbo.bin",
        "parakeet-tdt-v3" => {
            // Drop cached ONNX sessions so re-download reloads fresh files.
            crate::commands::parakeet::reset_parakeet();
            for (_, filename, _) in PARAKEET_FILES.iter() {
                let p = models_dir.join(filename);
                if p.exists() {
                    let _ = fs::remove_file(p);
                }
            }
            return Ok(());
        }
        "silero-vad" => {
            // Drop live VAD sessions — the model file they were built from is going away.
            crate::commands::vad::reset_vad();
            let p = models_dir.join(crate::commands::vad::SILERO_VAD_FILENAME);
            if p.exists() {
                fs::remove_file(p).map_err(|e| format!("Failed to remove model file: {}", e))?;
            }
            return Ok(());
        }
        _ => return Err("Unknown model ID".to_string()),
    };

    let path = models_dir.join(filename);
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Failed to remove model file: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_model_path(model_id: String) -> Result<String, String> {
    let models_dir = get_models_dir();
    let filename = match model_id.as_str() {
        "whisper-tiny-en" => "ggml-tiny.en.bin",
        "whisper-base-en" => "ggml-base.en.bin",
        "whisper-small-en" => "ggml-small.en.bin",
        "whisper-large-v3-turbo-q5" => "ggml-large-v3-turbo-q5_0.bin",
        "whisper-large-v3-turbo" => "ggml-large-v3-turbo.bin",
        "parakeet-tdt-v3" => PARAKEET_FILES[0].1,
        _ => return Err("Unknown model ID".to_string()),
    };

    let path = models_dir.join(filename);
    if !path.exists() {
        return Err("Model is not downloaded".to_string());
    }

    Ok(path.to_string_lossy().to_string())
}


#[allow(dead_code)]
fn wav_to_f32_pcm(wav_bytes: &[u8]) -> Result<Vec<f32>, String> {
    if wav_bytes.len() < 44 {
        return Err("WAV file is too short".to_string());
    }
    
    if &wav_bytes[0..4] != b"RIFF" || &wav_bytes[8..12] != b"WAVE" {
        return Err("Not a valid WAV file".to_string());
    }

    // Skip the 44-byte WAV header and parse s16le PCM samples
    let pcm_data = &wav_bytes[44..];
    let num_samples = pcm_data.len() / 2;
    let mut f32_samples = Vec::with_capacity(num_samples);

    for i in 0..num_samples {
        let sample_bytes = [pcm_data[i * 2], pcm_data[i * 2 + 1]];
        let sample_i16 = i16::from_le_bytes(sample_bytes);
        f32_samples.push(sample_i16 as f32 / 32768.0);
    }

    Ok(f32_samples)
}

#[tauri::command]
pub async fn local_stt_transcribe(
    audio_bytes: Vec<u8>,
    model_id: String,
    // Hotword biasing: the developer's custom vocabulary as one line. Whisper
    // conditions its decoding on it, so project names/API terms come out
    // spelled right. Parakeet has no conditioning input and ignores it.
    initial_prompt: Option<String>,
) -> Result<String, String> {
    if model_id.starts_with("parakeet") {
        let models_dir = get_models_dir();
        let encoder = models_dir.join(PARAKEET_FILES[0].1);
        let decoder = models_dir.join(PARAKEET_FILES[1].1);
        let vocab = models_dir.join(PARAKEET_FILES[2].1);
        let preprocessor = models_dir.join(PARAKEET_FILES[3].1);
        for p in [&encoder, &decoder, &vocab, &preprocessor] {
            if !p.exists() {
                return Err(format!(
                    "Parakeet model file missing: {}. Re-download the model in Settings.",
                    p.file_name().and_then(|n| n.to_str()).unwrap_or("?")
                ));
            }
        }
        // ONNX inference is blocking CPU work; keep it off the async runtime threads.
        return tokio::task::spawn_blocking(move || {
            crate::commands::parakeet::transcribe_wav(
                &audio_bytes,
                encoder,
                decoder,
                preprocessor,
                vocab,
            )
        })
        .await
        .map_err(|e| format!("Transcription task failed: {e}"))?;
    }

    if model_id.starts_with("whisper") {
        #[cfg(feature = "whisper-stt")]
        {
            let model_path = PathBuf::from(get_model_path(model_id).await?);
            return tokio::task::spawn_blocking(move || {
                crate::commands::whisper::transcribe_wav(&audio_bytes, model_path, initial_prompt.as_deref())
            })
            .await
            .map_err(|e| format!("Transcription task failed: {e}"))?;
        }
        #[cfg(not(feature = "whisper-stt"))]
        {
            return Err(
                "This build was compiled without Whisper support. Select NVIDIA Parakeet TDT v3, or rebuild with the `whisper-stt` feature.".to_string(),
            );
        }
    }

    Err(format!("Unsupported local STT model: {model_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every downloadable model file must carry a pinned SHA-256 so a future
    /// model addition can't silently ship without integrity verification.
    #[test]
    fn every_model_file_has_a_pinned_digest() {
        // Whisper single-file models (names must match list_downloadable_models
        // and get_model_path).
        for name in [
            "ggml-tiny.en.bin",
            "ggml-base.en.bin",
            "ggml-small.en.bin",
            "ggml-large-v3-turbo-q5_0.bin",
            "ggml-large-v3-turbo.bin",
        ] {
            assert!(
                expected_sha256(name).is_some(),
                "missing pinned digest for {name}"
            );
        }
        // Parakeet multi-file set.
        for (_, filename, _) in PARAKEET_FILES.iter() {
            assert!(
                expected_sha256(filename).is_some(),
                "missing pinned digest for {filename}"
            );
        }
    }

    /// Guard against typos: each pinned digest is a 64-char lowercase hex string.
    #[test]
    fn pinned_digests_are_well_formed() {
        for (name, hash) in MODEL_SHA256.iter() {
            assert_eq!(hash.len(), 64, "{name} digest is not 64 hex chars");
            assert!(
                hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                "{name} digest is not lowercase hex"
            );
        }
    }

    #[test]
    fn unknown_file_is_not_pinned() {
        assert!(expected_sha256("totally-unknown.bin").is_none());
    }
}

