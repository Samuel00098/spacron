use crate::state::AppState;
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::path::Path;
use tauri::State;

/// Skip files larger than this; project-wide text search has no business
/// scanning multi-megabyte blobs (usually generated or binary anyway).
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
/// Stop after this many matches total so a pathological query (e.g. `.`)
/// can't produce a gigantic payload or lock up the UI.
const MAX_TOTAL_MATCHES: usize = 5_000;
const MAX_MATCHES_PER_FILE: usize = 200;
/// Lines longer than this are truncated in the result (the match position is
/// still reported relative to the original line).
const MAX_LINE_LEN: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    /// 1-based line number.
    pub line: usize,
    /// 1-based column (in characters) where the match begins.
    pub column: usize,
    /// Match length in characters.
    pub length: usize,
    /// The full line of text (trailing newline stripped, possibly truncated).
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchFileResult {
    /// Absolute path, cleaned of Windows UNC prefixes.
    pub path: String,
    /// Path relative to the project root that contained it.
    pub rel_path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub files: Vec<SearchFileResult>,
    pub total_matches: usize,
    /// True when the result set was capped by one of the limits above.
    pub truncated: bool,
}

/// Search the explicitly selected project for `query`, honouring .gitignore.
///
/// `include_glob` is an optional comma-separated list of globs (e.g.
/// `*.rs, src/**/*.ts`); when present only matching files are scanned.
#[tauri::command]
pub async fn search_in_project(
    project_id: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    use_regex: bool,
    include_glob: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<SearchResponse, String> {
    if query.is_empty() {
        return Ok(SearchResponse {
            files: Vec::new(),
            total_matches: 0,
            truncated: false,
        });
    }

    // Resolve the request's project before starting I/O. The active project
    // may change while the search runs; never widen to all open roots.
    let projects: Vec<_> = state
        .workspace_manager
        .list_projects()
        .into_iter()
        .filter(|project| project.id == project_id)
        .collect();
    if projects.is_empty() {
        return Err("The selected project is no longer open.".to_string());
    }

    let roots: Vec<String> = projects.iter().map(|p| p.root_path.to_string_lossy().to_string()).collect();
    search_roots(roots, &query, case_sensitive, whole_word, use_regex, include_glob, offset, limit).await
}

/// The search itself, over explicit roots. Shared by the desktop command above
/// and the remote server, which searches its own workspace (`remote/mod.rs`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_roots(
    roots: Vec<String>,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    use_regex: bool,
    include_glob: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<SearchResponse, String> {
    if query.is_empty() {
        return Ok(SearchResponse { files: Vec::new(), total_matches: 0, truncated: false });
    }
    // Build the matcher: escape the query unless the user opted into regex,
    // then optionally anchor it to word boundaries.
    let mut pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    let matcher = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid search pattern: {e}"))?;

    // Offload all blocking I/O (filesystem walk + file reads) to a thread pool
    // so the main thread stays responsive.
    tokio::task::spawn_blocking(move || {
        let mut files: Vec<SearchFileResult> = Vec::new();
        let mut total_matches = 0usize;
        let mut skipped = 0usize;
        let page_limit = limit.unwrap_or(MAX_TOTAL_MATCHES).clamp(1, MAX_TOTAL_MATCHES);
        let mut truncated = false;

        'roots: for root in &roots {
            let root = Path::new(root);

            let mut builder = WalkBuilder::new(root);
            // Search dotfiles (.github, .env.example, …) but never descend into .git.
            builder
                .sort_by_file_path(|a, b| a.cmp(b))
                .hidden(false)
                .git_ignore(true)
                .git_global(true)
                .filter_entry(|entry| entry.file_name() != std::ffi::OsStr::new(".git"));

            // Apply include globs as a whitelist override scoped to this root.
            if let Some(globs) = include_glob
                .as_ref()
                .map(|g| g.trim())
                .filter(|g| !g.is_empty())
            {
                let mut ob = OverrideBuilder::new(root);
                for glob in globs.split(',').map(|g| g.trim()).filter(|g| !g.is_empty()) {
                    ob.add(glob)
                        .map_err(|e| format!("Invalid include glob '{glob}': {e}"))?;
                }
                let overrides = ob
                    .build()
                    .map_err(|e| format!("Invalid include globs: {e}"))?;
                builder.overrides(overrides);
            }

            for dent in builder.build() {
                let dent = match dent {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                if dent.file_type().map(|ft| ft.is_dir()).unwrap_or(true) {
                    continue;
                }
                let path = dent.path();
                if dent
                    .metadata()
                    .map(|m| m.len() > MAX_FILE_SIZE)
                    .unwrap_or(true)
                {
                    continue;
                }

                // read_to_string fails on non-UTF-8 (binary) content, which is the
                // behaviour we want — skip those files silently.
                let content = match std::fs::read_to_string(path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let mut file_matches: Vec<SearchMatch> = Vec::new();
                for (idx, line) in content.lines().enumerate() {
                    for m in matcher.find_iter(line) {
                        if skipped < offset.unwrap_or(0) { skipped += 1; continue; }
                        let column = line[..m.start()].chars().count() + 1;
                        let length = line[m.start()..m.end()].chars().count();
                        let text = if line.chars().count() > MAX_LINE_LEN {
                            line.chars().take(MAX_LINE_LEN).collect::<String>()
                        } else {
                            line.to_string()
                        };
                        file_matches.push(SearchMatch {
                            line: idx + 1,
                            column,
                            length,
                            text,
                        });
                        total_matches += 1;
                        if (offset.is_none() && file_matches.len() >= MAX_MATCHES_PER_FILE)
                            || total_matches >= page_limit
                        {
                            truncated = true;
                            break;
                        }
                    }
                    if truncated {
                        break;
                    }
                }

                if !file_matches.is_empty() {
                    let abs = crate::commands::clean_path_buf(path.to_path_buf());
                    let rel = relative_to(root, path);
                    files.push(SearchFileResult {
                        path: abs.to_string_lossy().to_string(),
                        rel_path: rel,
                        matches: file_matches,
                    });
                }

                if total_matches >= page_limit {
                    truncated = true;
                    break 'roots;
                }
            }
        }

        // Stable, predictable ordering by relative path.
        files.sort_by_key(|a| a.rel_path.to_lowercase());

        Ok(SearchResponse {
            files,
            total_matches,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("Search was cancelled: {e}"))?
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}
