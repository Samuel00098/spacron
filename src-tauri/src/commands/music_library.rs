use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Audio formats the local library will index. Kept to what the WebView's
/// HTML5 audio element can actually decode on all three platforms — adding an
/// extension here that the WebView can't play would surface as a track that
/// silently fails at play time.
const AUDIO_EXT: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "webm"];

/// Sidecar files treated as proof-of-licence for the track/folder they sit in
/// (Pixabay ships a per-track "License Certificate"; StreamBeats ships a
/// blanket terms file). Surfaced in the UI so a Content ID dispute has the
/// paperwork one click away rather than buried in a downloads folder.
const LICENSE_HINTS: &[&str] = &["license", "licence", "certificate", "terms", "credit", "readme"];

/// How deep to walk below the chosen folder. Music libraries are organised by
/// artist/album at most, so this is plenty while stopping a mis-selected home
/// directory from turning into an unbounded crawl.
const MAX_DEPTH: usize = 4;

/// Hard cap on indexed tracks so a mis-selected folder can't lock up the UI.
const MAX_TRACKS: usize = 5000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    /// Absolute path — also the stable identity used by the frontend.
    pub path: String,
    /// Display title, from the filename with any leading track number and the
    /// "Artist - " prefix stripped.
    pub title: String,
    /// Best-effort artist, from the "Artist - Title" filename convention.
    pub artist: String,
    /// Parent folder name, used as the album/collection grouping.
    pub album: String,
    pub ext: String,
    pub size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicLibrary {
    pub folder: String,
    pub tracks: Vec<LocalTrack>,
    /// Licence/certificate files found anywhere in the tree.
    pub license_files: Vec<String>,
    /// True when the walk stopped at MAX_TRACKS, so the UI can say so.
    pub truncated: bool,
}

fn is_audio(ext: &str) -> bool {
    AUDIO_EXT.contains(&ext)
}

/// Split "01 - Artist - Title.mp3" into its artist and title parts.
///
/// Filenames are the only metadata source here — reading real ID3/Vorbis tags
/// would mean pulling in a tag-parsing crate, and both StreamBeats and Pixabay
/// name their downloads well enough that the filename is accurate.
fn parse_title_artist(stem: &str) -> (String, String) {
    // Drop a leading track number ("01 ", "01. ", "01 - ").
    let without_index = {
        let trimmed = stem.trim_start();
        let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 1 && digits.len() <= 3 && digits.len() < trimmed.len() {
            trimmed[digits.len()..]
                .trim_start_matches([' ', '.', '-', '_'])
                .to_string()
        } else {
            trimmed.to_string()
        }
    };

    // "Artist - Title" → split on the first hyphen that is surrounded by spaces,
    // so hyphenated words inside a title survive.
    if let Some(idx) = without_index.find(" - ") {
        let artist = without_index[..idx].trim().to_string();
        let title = without_index[idx + 3..].trim().to_string();
        if !artist.is_empty() && !title.is_empty() {
            return (title, artist);
        }
    }
    (without_index.trim().to_string(), String::new())
}

fn looks_like_license(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    LICENSE_HINTS.iter().any(|hint| lower.contains(hint))
}

/// Recursive directory walk. Depth-limited and count-limited; unreadable
/// entries are skipped rather than failing the whole scan, so one permission
/// error deep in the tree doesn't cost the user their whole library.
fn walk(dir: &Path, depth: usize, out: &mut Vec<LocalTrack>, licenses: &mut Vec<String>) {
    if depth > MAX_DEPTH || out.len() >= MAX_TRACKS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= MAX_TRACKS {
            return;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };

        if meta.is_dir() {
            // Skip hidden/system folders, which are never a user's music.
            let hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'));
            if !hidden {
                dirs.push(path);
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();

        if is_audio(&ext) {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
            let (title, artist) = parse_title_artist(stem);
            let album = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            out.push(LocalTrack {
                path: path.to_string_lossy().to_string(),
                title: if title.is_empty() { stem.to_string() } else { title },
                artist,
                album,
                ext,
                size_bytes: meta.len(),
            });
        } else if looks_like_license(file_name) {
            licenses.push(path.to_string_lossy().to_string());
        }
    }

    // Files before sub-folders keeps the top level of the library first in the
    // list, which is what the user sees on open.
    for sub in dirs {
        walk(&sub, depth + 1, out, licenses);
    }
}

/// Index a user-chosen folder of audio files and grant the WebView permission
/// to stream them.
///
/// The asset-protocol scope is widened at runtime to exactly the folder the
/// user picked, rather than baking a broad glob into tauri.conf.json — nothing
/// outside a folder they explicitly chose is ever readable through `asset:`.
#[tauri::command]
pub fn music_library_scan(app: AppHandle, folder: String) -> Result<MusicLibrary, String> {
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err("That folder no longer exists.".to_string());
    }

    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| format!("Could not grant playback access to that folder: {e}"))?;

    let mut tracks: Vec<LocalTrack> = Vec::new();
    let mut license_files: Vec<String> = Vec::new();
    walk(&root, 0, &mut tracks, &mut license_files);

    let truncated = tracks.len() >= MAX_TRACKS;

    // Album then title gives a stable, predictable order across rescans;
    // read_dir order is filesystem-dependent and would otherwise shuffle.
    tracks.sort_by(|a, b| {
        a.album
            .to_lowercase()
            .cmp(&b.album.to_lowercase())
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    Ok(MusicLibrary {
        folder: root.to_string_lossy().to_string(),
        tracks,
        license_files,
        truncated,
    })
}

/// Reveal a track (or its licence certificate) in the OS file manager, so a
/// Content ID dispute can get at the paperwork without a manual folder hunt.
#[tauri::command]
pub fn music_library_reveal(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("That file no longer exists.".to_string());
    }

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&target)
        .spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&target)
        .spawn();

    #[cfg(target_os = "linux")]
    let result = {
        let dir = target.parent().unwrap_or(&target);
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };

    result
        .map(|_| ())
        .map_err(|e| format!("Could not open the file manager: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_artist_and_title() {
        let (title, artist) = parse_title_artist("Harris Heller - Neon Rain");
        assert_eq!(title, "Neon Rain");
        assert_eq!(artist, "Harris Heller");
    }

    #[test]
    fn strips_leading_track_number() {
        let (title, artist) = parse_title_artist("04 - Harris Heller - Slow Burn");
        assert_eq!(title, "Slow Burn");
        assert_eq!(artist, "Harris Heller");
    }

    #[test]
    fn keeps_hyphenated_titles_intact() {
        let (title, artist) = parse_title_artist("Lo-Fi Dreams");
        assert_eq!(title, "Lo-Fi Dreams");
        assert_eq!(artist, "");
    }

    #[test]
    fn bare_title_has_no_artist() {
        let (title, artist) = parse_title_artist("07 Ambient Loop");
        assert_eq!(title, "Ambient Loop");
        assert_eq!(artist, "");
    }

    #[test]
    fn recognises_license_sidecars() {
        assert!(looks_like_license("Pixabay License Certificate.pdf"));
        assert!(looks_like_license("LICENSE.txt"));
        assert!(!looks_like_license("track.mp3"));
    }

    #[test]
    fn audio_extensions_are_matched_lowercase() {
        assert!(is_audio("mp3"));
        assert!(is_audio("flac"));
        assert!(!is_audio("txt"));
    }
}
