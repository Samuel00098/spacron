/// Probes whether the system has the GStreamer audio bridge that WebKitGTK
/// needs for getUserMedia. On Linux, calling getUserMedia without the
/// PulseAudio (or PipeWire) GStreamer plugin segfaults the web process.
/// This check lets the frontend decide whether it's safe to use the mic.
#[tauri::command]
pub fn check_audio_safe() -> bool {
    gstreamer_plugin_exists(&AUDIO_BRIDGE_PLUGINS)
}

/// Probes whether the system has the GStreamer video codec plugins that
/// WebKitGTK needs for MSE/EME playback (e.g. YouTube).  On Linux the
/// webview delegates all decoding to GStreamer — without the right plugins
/// the video element shows a "no compatible source" error even when MSE
/// and EME are enabled in WebKit settings.
#[tauri::command]
pub fn check_gstreamer_codecs() -> bool {
    gstreamer_plugin_exists(&VIDEO_CODEC_PLUGINS)
}

// ── plugin paths ──────────────────────────────────────────────────────

/// GStreamer PulseAudio / PipeWire bridge plugin file names needed for
/// microphone capture on Linux (WebKitGTK). Bare file names — the containing
/// directory is resolved at runtime (see `gstreamer_plugin_dirs`) so this works
/// on any CPU arch, not just x86_64.
const AUDIO_BRIDGE_PLUGINS: &[&str] = &[
    "libgstpulseaudio.so", // PulseAudio
    "libgstpulsewire.so",
    "libgstpipewire.so", // PipeWire
];

/// Key GStreamer video-codec plugin file names needed for YouTube / MSE
/// playback through WebKitGTK.
///
///   libgstlibav     – gstreamer1.0-libav  (ffmpeg: H.264, AAC, …)
///   libgstvpx       – gstreamer1.0-plugins-good (VP8 / VP9)
///   libgstdav1d     – gstreamer1.0-plugins-bad  (AV1)
///   libgstisomp4    – gstreamer1.0-plugins-good (MSE/fragmented MP4)
///   libgstopus      – gstreamer1.0-plugins-base (Opus audio)
///   libgstvorbis    – gstreamer1.0-plugins-base (Vorbis audio)
const VIDEO_CODEC_PLUGINS: &[&str] = &[
    "libgstlibav.so",
    "libgstvpx.so",
    "libgstdav1d.so",
    "libgstisomp4.so",
    "libgstopus.so",
    "libgstvorbis.so",
];

/// Candidate directories that may hold GStreamer 1.0 plugins on this machine.
/// GStreamer's own search path plus every multiarch lib dir (`x86_64-linux-gnu`,
/// `aarch64-linux-gnu`, `arm-linux-gnueabihf`, …), resolved at runtime so the
/// probe isn't pinned to a single CPU architecture.
#[cfg(target_os = "linux")]
fn gstreamer_plugin_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut dirs: Vec<PathBuf> = Vec::new();

    // 1. Honour the same env vars GStreamer itself consults.
    for var in [
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_PATH_1_0",
        "GST_PLUGIN_PATH",
    ] {
        if let Ok(val) = std::env::var(var) {
            for p in val.split(':').filter(|s| !s.is_empty()) {
                dirs.push(PathBuf::from(p));
            }
        }
    }

    // 2. Well-known fixed locations (non-multiarch distros, /usr/local installs).
    for base in [
        "/usr/lib64/gstreamer-1.0",
        "/usr/lib/gstreamer-1.0",
        "/usr/local/lib64/gstreamer-1.0",
        "/usr/local/lib/gstreamer-1.0",
    ] {
        dirs.push(PathBuf::from(base));
    }

    // 3. Every `<triplet>/gstreamer-1.0` under the multiarch lib roots.
    for libroot in ["/usr/lib", "/usr/local/lib"] {
        if let Ok(entries) = std::fs::read_dir(libroot) {
            for entry in entries.flatten() {
                let dir = entry.path().join("gstreamer-1.0");
                if dir.is_dir() {
                    dirs.push(dir);
                }
            }
        }
    }

    dirs
}

#[cfg(target_os = "linux")]
fn gstreamer_plugin_exists(plugins: &[&str]) -> bool {
    let dirs = gstreamer_plugin_dirs();
    plugins
        .iter()
        .any(|name| dirs.iter().any(|dir| dir.join(name).exists()))
}

#[cfg(not(target_os = "linux"))]
fn gstreamer_plugin_exists(_plugins: &[&str]) -> bool {
    // macOS/Windows don't use GStreamer
    true
}
