//! Plugins: folders in the Claude Code / Codex plugin layout, installed from a
//! marketplace, an archive, a folder, or created from scratch.
//!
//! ```text
//! my-plugin/
//! ├── .claude-plugin/plugin.json   (or .codex-plugin/plugin.json)
//! ├── .mcp.json                    MCP servers   -> every agent + the chat
//! ├── skills/<name>/SKILL.md       skills        -> Claude Code + Codex skill dirs
//! ├── commands/ agents/ hooks/     Claude Code-only parts, reported, not run
//! ```
//!
//! This module only moves files and reads manifests. Turning a plugin's MCP
//! servers into rows of the user's server list (and signing in to them) is the
//! frontend's job (`services/plugins.ts`), so it goes through the same writers
//! as every other server.
//!
//! Marketplaces are GitHub repositories carrying `.claude-plugin/marketplace.json`
//! (Claude) or `.agents/plugins/marketplace.json` (Codex). Downloads come only
//! from github.com's own hosts, and archives are extracted with a zip-slip guard
//! and size caps.

use serde::Serialize;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const MAX_ARCHIVE_BYTES: u64 = 80 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 5000;
const MANIFESTS: &[&str] = &[".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
/// Prefix of every skill folder Spacron writes into an agent's skill dir, so a
/// removal only ever deletes folders Spacron owns.
const SKILL_PREFIX: &str = "spacron-";

fn plugins_root() -> PathBuf {
    crate::mcp::config_dir().join("plugins")
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent("Spacron")
        .build()
        .map_err(|e| e.to_string())
}

/// A plugin or marketplace name as a safe folder name.
fn slug(text: &str) -> String {
    let s: String = text
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "plugin".into() } else { s.chars().take(64).collect() }
}

// ---------------------------------------------------------------------------
// GitHub sources
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct GitHubRef {
    owner: String,
    repo: String,
    /// Commit, branch or tag; `HEAD` when unspecified.
    rev: String,
    /// Folder inside the repo, `""` for the root.
    path: String,
}

/// `owner/repo`, `owner/repo#ref`, or a github.com URL (with or without `.git`).
fn parse_github(source: &str) -> Result<GitHubRef, String> {
    let (main, rev) = match source.trim().split_once('#') {
        Some((m, r)) => (m.trim(), r.trim().to_string()),
        None => (source.trim(), String::new()),
    };
    let rest = main
        .strip_prefix("https://github.com/")
        .or_else(|| main.strip_prefix("http://github.com/"))
        .or_else(|| main.strip_prefix("github.com/"))
        .unwrap_or(main);
    let mut parts = rest.trim_end_matches('/').split('/');
    let owner = parts.next().unwrap_or("").to_string();
    let repo = parts.next().unwrap_or("").trim_end_matches(".git").to_string();
    let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && s != "." && s != "..";
    if !valid(&owner) || !valid(&repo) {
        return Err("Give a GitHub repository as owner/repo or a github.com link.".into());
    }
    let mut path = String::new();
    // github.com/o/r/tree/<rev>/<path>
    if parts.next() == Some("tree") {
        if let Some(r) = parts.next() {
            if rev.is_empty() {
                return Ok(GitHubRef { owner, repo, rev: r.to_string(), path: parts.collect::<Vec<_>>().join("/") });
            }
        }
        path = parts.collect::<Vec<_>>().join("/");
    }
    Ok(GitHubRef { owner, repo, rev: if rev.is_empty() { "HEAD".into() } else { rev }, path })
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let res = client.get(url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.text().await.ok()
}

fn raw_url(r: &GitHubRef, file: &str) -> String {
    let base = if r.path.is_empty() { String::new() } else { format!("{}/", r.path.trim_matches('/')) };
    format!("https://raw.githubusercontent.com/{}/{}/{}/{}{}", r.owner, r.repo, r.rev, base, file)
}

// ---------------------------------------------------------------------------
// Marketplaces
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePlugin {
    pub name: String,
    pub title: String,
    pub description: String,
    pub category: Option<String>,
    pub homepage: Option<String>,
    pub author: Option<String>,
    /// False for sources Spacron cannot download (npm, non-GitHub git).
    pub installable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    pub owner: Option<String>,
    pub plugins: Vec<MarketplacePlugin>,
}

async fn load_marketplace(source: &str) -> Result<(GitHubRef, serde_json::Value), String> {
    let r = parse_github(source)?;
    let client = http()?;
    for file in [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"] {
        if let Some(text) = fetch_text(&client, &raw_url(&r, file)).await {
            let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("{file} in {}/{} is not valid JSON", r.owner, r.repo))?;
            return Ok((r, json));
        }
    }
    Err(format!(
        "{}/{} has no plugin marketplace (looked for .claude-plugin/marketplace.json and .agents/plugins/marketplace.json).",
        r.owner, r.repo
    ))
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string).filter(|s| !s.trim().is_empty())
}

/// Where a marketplace entry's files live, or `None` when Spacron cannot fetch them.
fn entry_location(market: &GitHubRef, entry: &serde_json::Value) -> Option<GitHubRef> {
    let source = entry.get("source")?;
    if let Some(local) = source.as_str() {
        return Some(GitHubRef { path: join_repo_path(&market.path, local), ..market.clone() });
    }
    let kind = source.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let rev = str_field(source, "sha").or_else(|| str_field(source, "ref"));
    match kind {
        "local" => Some(GitHubRef { path: join_repo_path(&market.path, &str_field(source, "path")?), ..market.clone() }),
        "github" => {
            let mut r = parse_github(&str_field(source, "repo")?).ok()?;
            if let Some(rev) = rev { r.rev = rev; }
            r.path = str_field(source, "path").unwrap_or_default();
            Some(r)
        }
        "url" | "git-subdir" => {
            let mut r = parse_github(&str_field(source, "url")?).ok()?;
            if let Some(rev) = rev { r.rev = rev; }
            r.path = str_field(source, "path").unwrap_or_default();
            Some(r)
        }
        _ => None,
    }
}

fn join_repo_path(base: &str, rel: &str) -> String {
    let rel = rel.trim_start_matches("./").trim_matches('/');
    if base.is_empty() { rel.to_string() } else { format!("{}/{}", base.trim_matches('/'), rel) }
}

/// Read a marketplace's plugin list.
#[tauri::command]
pub async fn plugin_marketplace_fetch(source: String) -> Result<Marketplace, String> {
    let (market, json) = load_marketplace(&source).await?;
    let plugins = json
        .get("plugins")
        .and_then(|p| p.as_array())
        .ok_or("The marketplace lists no plugins.")?
        .iter()
        .filter_map(|entry| {
            let name = str_field(entry, "name")?;
            let interface = entry.get("interface").cloned().unwrap_or_default();
            Some(MarketplacePlugin {
                title: str_field(entry, "displayName").or_else(|| str_field(&interface, "displayName")).unwrap_or_else(|| name.clone()),
                description: str_field(entry, "description").or_else(|| str_field(&interface, "shortDescription")).unwrap_or_default(),
                category: str_field(entry, "category"),
                homepage: str_field(entry, "homepage"),
                author: entry.get("author").and_then(|a| str_field(a, "name")),
                installable: entry_location(&market, entry).is_some(),
                name,
            })
        })
        .collect();
    Ok(Marketplace {
        name: str_field(&json, "name").unwrap_or_else(|| format!("{}/{}", market.owner, market.repo)),
        owner: json.get("owner").and_then(|o| str_field(o, "name")),
        plugins,
    })
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/// A relative path from an archive, or `None` if it would escape the target.
fn safe_relative(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

/// Extract the entries of `zip` under `prefix` (a folder inside the archive,
/// `""` for everything) into `dest`, which is replaced.
fn extract_subtree(bytes: &[u8], prefix: &str, dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("not a zip archive: {e}"))?;
    if archive.len() > MAX_FILES * 4 {
        return Err("the archive has too many files".into());
    }
    let prefix = prefix.trim_matches('/');
    let tmp = dest.with_extension("installing");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let (mut files, mut total) = (0usize, 0u64);
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let rel = if prefix.is_empty() {
            name.as_str()
        } else if let Some(rest) = name.strip_prefix(prefix).and_then(|r| r.strip_prefix('/')) {
            rest
        } else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let Some(rel) = safe_relative(rel) else {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("the archive contains an unsafe path: {name}"));
        };
        let out = tmp.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        files += 1;
        total += entry.size();
        if files > MAX_FILES || total > MAX_EXTRACTED_BYTES {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("the plugin is too large to install".into());
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
        std::fs::write(&out, data).map_err(|e| e.to_string())?;
    }
    if files == 0 {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("nothing to install at that location".into());
    }
    let _ = std::fs::remove_dir_all(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// The top folder GitHub puts every entry of a repository zip under.
fn zip_root(bytes: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let first = archive.by_index(0).map_err(|e| e.to_string())?.name().to_string();
    Ok(first.split('/').next().unwrap_or("").to_string())
}

/// The folder inside an archive that holds a plugin manifest (the shallowest).
fn manifest_dir_in_zip(bytes: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("not a zip archive: {e}"))?;
    let mut best: Option<String> = None;
    for i in 0..archive.len() {
        let name = archive.by_index(i).map_err(|e| e.to_string())?.name().replace('\\', "/");
        for manifest in MANIFESTS {
            if let Some(dir) = name.strip_suffix(manifest) {
                let dir = dir.trim_end_matches('/').to_string();
                if best.as_ref().is_none_or(|b| dir.len() < b.len()) {
                    best = Some(dir);
                }
            }
        }
    }
    best.ok_or_else(|| "no plugin manifest (.claude-plugin/plugin.json or .codex-plugin/plugin.json) in the archive".into())
}

// ---------------------------------------------------------------------------
// Reading a plugin
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSkill {
    pub name: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    /// Folder name; the plugin's identity in Spacron.
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub version: Option<String>,
    pub homepage: Option<String>,
    pub author: Option<String>,
    pub path: String,
    /// The plugin's MCP servers (its `mcpServers` object), with the plugin's
    /// own folder already substituted for `${CLAUDE_PLUGIN_ROOT}`.
    pub mcp_servers: serde_json::Value,
    /// `${NAME}` placeholders left in those servers, for the user to fill in.
    pub variables: Vec<String>,
    pub skills: Vec<PluginSkill>,
    /// Parts Spacron does not run (commands, agents, hooks, LSP servers).
    pub claude_only: Vec<String>,
    /// Slash commands (`commands/**/*.md`), shared with every agent as skills.
    pub commands: Vec<String>,
    /// Sub-agents (`agents/*.md`), shared with every agent as skills.
    pub agents: Vec<String>,
    /// The manifest's icon as a data URL, when it ships one.
    pub icon: Option<String>,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `---\nname: x\ndescription: y\n---` front matter of a SKILL.md.
/// A YAML scalar without the quotes that wrap it (only when they wrap all of it).
fn unquote(value: &str) -> String {
    let v = value.trim();
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return v[1..v.len() - 1].replace("\\\"", "\"");
        }
    }
    v.to_string()
}

fn skill_front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(unquote(v));
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(unquote(v));
        }
    }
    (name, description)
}

fn skill_dirs(root: &Path, manifest: &serde_json::Value) -> Vec<PathBuf> {
    let mut bases = vec![root.join("skills")];
    if let Some(custom) = manifest.get("skills").and_then(|s| s.as_str()) {
        if let Some(rel) = safe_relative(custom.trim_start_matches("./")) {
            bases.insert(0, root.join(rel));
        }
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for base in bases {
        let Ok(entries) = std::fs::read_dir(&base) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.join("SKILL.md").is_file() && seen.insert(path.clone()) {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn placeholders(value: &serde_json::Value, out: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::String(s) => {
            let mut rest = s.as_str();
            while let Some(start) = rest.find("${") {
                let after = &rest[start + 2..];
                let Some(end) = after.find('}') else { break };
                let inner = &after[..end];
                // `${VAR:-default}` has a default and needs nothing from the user.
                if !inner.contains(":-") {
                    let name = inner.trim_start_matches("env:").trim_start_matches("user_config.");
                    if !name.is_empty() {
                        out.insert(name.to_string());
                    }
                }
                rest = &after[end + 1..];
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|v| placeholders(v, out)),
        serde_json::Value::Object(map) => map.values().for_each(|v| placeholders(v, out)),
        _ => {}
    }
}

/// Substitute the plugin's folder and `${VAR:-default}` defaults.
fn resolve_strings(value: &mut serde_json::Value, root: &str) {
    match value {
        serde_json::Value::String(s) => {
            let mut out = s
                .replace("${CLAUDE_PLUGIN_ROOT}", root)
                .replace("${PLUGIN_ROOT}", root);
            while let Some(start) = out.find("${") {
                let Some(end) = out[start..].find('}').map(|e| start + e) else { break };
                let inner = out[start + 2..end].to_string();
                match inner.split_once(":-") {
                    Some((_, default)) => out.replace_range(start..=end, default),
                    None => break,
                }
            }
            *s = out;
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(|v| resolve_strings(v, root)),
        serde_json::Value::Object(map) => map.values_mut().for_each(|v| resolve_strings(v, root)),
        _ => {}
    }
}

fn icon_data_url(root: &Path, manifest: &serde_json::Value) -> Option<String> {
    use base64::Engine;
    let interface = manifest.get("interface")?;
    let rel = interface.get("composerIcon").or_else(|| interface.get("logo"))?.as_str()?;
    let path = root.join(safe_relative(rel.trim_start_matches("./"))?);
    let bytes = std::fs::read(&path).ok().filter(|b| b.len() < 256 * 1024)?;
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

fn summarize(root: &Path) -> Result<PluginSummary, String> {
    let manifest = MANIFESTS
        .iter()
        .find_map(|m| read_json(&root.join(m)))
        .ok_or("this folder has no plugin manifest (.claude-plugin/plugin.json or .codex-plugin/plugin.json)")?;
    let id = root.file_name().and_then(|n| n.to_str()).map(slug).unwrap_or_else(|| "plugin".into());
    let name = str_field(&manifest, "name").unwrap_or_else(|| id.clone());
    let interface = manifest.get("interface").cloned().unwrap_or_default();
    let root_text = root.to_string_lossy().to_string();

    let mut servers = match manifest.get("mcpServers") {
        Some(serde_json::Value::String(rel)) => safe_relative(rel.trim_start_matches("./")).and_then(|r| read_json(&root.join(r))),
        Some(v @ serde_json::Value::Object(_)) => Some(v.clone()),
        _ => read_json(&root.join(".mcp.json")),
    }
    .unwrap_or_else(|| serde_json::json!({}));
    if let Some(inner) = servers.get("mcpServers").cloned() {
        servers = inner;
    }
    if !servers.is_object() {
        servers = serde_json::json!({});
    }
    resolve_strings(&mut servers, &root_text);
    let mut vars = BTreeSet::new();
    placeholders(&servers, &mut vars);

    let skills = skill_dirs(root, &manifest)
        .into_iter()
        .map(|dir| {
            let text = std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
            let (name, description) = skill_front_matter(&text);
            PluginSkill {
                name: name.unwrap_or_else(|| dir.file_name().and_then(|n| n.to_str()).unwrap_or("skill").to_string()),
                description: description.unwrap_or_default(),
            }
        })
        .collect();

    // Commands and sub-agents are markdown instructions, so they are shared
    // as skills (see `plugin_enable_skills`); hooks run Claude Code's own
    // lifecycle events and cannot be.
    let mut claude_only = Vec::new();
    if root.join("hooks").is_dir() || manifest.get("hooks").is_some() {
        claude_only.push("hooks".to_string());
    }
    let commands: Vec<String> = markdown_files(&root.join("commands")).into_iter().map(|(name, _)| name).collect();
    let agents: Vec<String> = markdown_files(&root.join("agents")).into_iter().map(|(name, _)| name).collect();
    if manifest.get("lspServers").is_some() || root.join(".lsp.json").is_file() {
        claude_only.push("language servers".into());
    }

    Ok(PluginSummary {
        title: str_field(&manifest, "displayName").or_else(|| str_field(&interface, "displayName")).unwrap_or_else(|| name.clone()),
        description: str_field(&manifest, "description").or_else(|| str_field(&interface, "shortDescription")).unwrap_or_default(),
        version: str_field(&manifest, "version"),
        homepage: str_field(&manifest, "homepage").or_else(|| str_field(&interface, "websiteURL")),
        author: manifest.get("author").and_then(|a| str_field(a, "name")),
        path: root_text,
        mcp_servers: servers,
        variables: vars.into_iter().collect(),
        skills,
        claude_only,
        commands,
        agents,
        icon: icon_data_url(root, &manifest),
        id,
        name,
    })
}

// ---------------------------------------------------------------------------
// Install commands
// ---------------------------------------------------------------------------

/// Fetch just one folder of a GitHub repo: list it with the git trees API (one
/// call), then download each file from raw.githubusercontent.com. Far lighter
/// than the repository archive when a marketplace keeps hundreds of plugins in
/// one repo. `fallback:` errors mean "use the archive instead".
async fn download_folder(location: &GitHubRef, dest: &Path) -> Result<(), String> {
    use futures_util::stream::{self, StreamExt};
    #[derive(serde::Deserialize)]
    struct Entry { path: String, #[serde(rename = "type")] kind: String, #[serde(default)] size: u64 }
    #[derive(serde::Deserialize)]
    struct Tree { #[serde(default)] tree: Vec<Entry>, #[serde(default)] truncated: bool }

    let client = http()?;
    let api = format!("https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1", location.owner, location.repo, location.rev);
    let res = client.get(&api).header("Accept", "application/vnd.github+json").send().await.map_err(|e| format!("fallback: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("fallback: GitHub API answered {}", res.status()));
    }
    let tree: Tree = res.json().await.map_err(|e| format!("fallback: {e}"))?;
    if tree.truncated {
        return Err("fallback: tree listing truncated".into());
    }
    let prefix = location.path.trim_matches('/');
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for entry in tree.tree.into_iter().filter(|e| e.kind == "blob") {
        let rel = if prefix.is_empty() {
            Some(entry.path.as_str())
        } else {
            entry.path.strip_prefix(prefix).and_then(|r| r.strip_prefix('/'))
        };
        let Some(rel) = rel.and_then(safe_relative) else { continue };
        total += entry.size;
        if total > MAX_EXTRACTED_BYTES {
            return Err("the plugin is too large to install".into());
        }
        files.push((entry.path.clone(), rel));
    }
    if files.is_empty() {
        return Err(format!("nothing found at {}/{}/{}", location.owner, location.repo, prefix));
    }
    if files.len() > MAX_FILES {
        return Err("the plugin is too large to install".into());
    }

    let tmp = dest.with_extension("installing");
    let _ = std::fs::remove_dir_all(&tmp);
    let base = GitHubRef { path: String::new(), ..location.clone() };
    let results: Vec<Result<(), String>> = stream::iter(files)
        .map(|(path, rel)| {
            let (client, url, out) = (client.clone(), raw_url(&base, &path), tmp.join(rel));
            async move {
                let res = client.get(&url).send().await.map_err(|e| format!("could not download {path}: {e}"))?;
                if !res.status().is_success() {
                    return Err(format!("could not download {path}: {}", res.status()));
                }
                let bytes = res.bytes().await.map_err(|e| e.to_string())?;
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&out, &bytes).map_err(|e| e.to_string())
            }
        })
        .buffer_unordered(8)
        .collect()
        .await;
    if let Some(Err(e)) = results.into_iter().find(|r| r.is_err()) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// Download one plugin from a marketplace into `<config>/plugins/<marketplace>/<plugin>`.
#[tauri::command]
pub async fn plugin_install_from_marketplace(source: String, plugin: String) -> Result<PluginSummary, String> {
    let (market, json) = load_marketplace(&source).await?;
    let entry = json
        .get("plugins")
        .and_then(|p| p.as_array())
        .and_then(|list| list.iter().find(|e| str_field(e, "name").as_deref() == Some(plugin.as_str())))
        .ok_or_else(|| format!("{plugin} is not in this marketplace"))?;
    let location = entry_location(&market, entry).ok_or("this plugin is not hosted on GitHub, so Spacron cannot download it")?;

    let dest = plugins_root().join(slug(&format!("{}-{}", market.owner, market.repo))).join(slug(&plugin));
    match download_folder(&location, &dest).await {
        Ok(()) => return summarize(&dest),
        // Too many files for the tree listing, or the API is rate limited:
        // fall back to the repository archive.
        Err(e) if e.starts_with("fallback:") => {}
        Err(e) => return Err(e),
    }
    let client = http()?;
    let url = format!("https://codeload.github.com/{}/{}/zip/{}", location.owner, location.repo, location.rev);
    let res = client.get(&url).send().await.map_err(|e| format!("could not download the plugin: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GitHub answered {} for {}/{}", res.status(), location.owner, location.repo));
    }
    if res.content_length().is_some_and(|n| n > MAX_ARCHIVE_BYTES) {
        return Err("the plugin's repository is too large to download".into());
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("the plugin's repository is too large to download".into());
    }
    let root = zip_root(&bytes)?;
    let prefix = if location.path.is_empty() { root } else { format!("{root}/{}", location.path.trim_matches('/')) };
    extract_subtree(&bytes, &prefix, &dest)?;
    summarize(&dest)
}

/// Install a plugin from a `.zip` archive the user picked.
#[tauri::command]
pub fn plugin_install_archive(path: String) -> Result<PluginSummary, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("could not open {path}: {e}"))?;
    if meta.len() > MAX_ARCHIVE_BYTES {
        return Err("the archive is too large".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let dir = manifest_dir_in_zip(&bytes)?;
    let probe_name = Path::new(&path).file_stem().and_then(|n| n.to_str()).unwrap_or("plugin").to_string();
    let tmp = plugins_root().join("personal").join(format!(".unpack-{}", uuid::Uuid::new_v4().simple()));
    extract_subtree(&bytes, &dir, &tmp)?;
    let summary = summarize(&tmp);
    let name = summary.as_ref().map(|s| s.name.clone()).unwrap_or(probe_name);
    let dest = plugins_root().join("personal").join(slug(&name));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    summarize(&dest)
}

/// Read a plugin folder in place (a folder the user picked, or one being built).
#[tauri::command]
pub fn plugin_read_folder(path: String) -> Result<PluginSummary, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    summarize(&root)
}

/// Scaffold a new plugin at `<parent>/<name>/` and return its summary. `parent`
/// is the open project's `plugins/` folder, or Spacron's personal store.
#[tauri::command]
pub fn plugin_create(parent: Option<String>, name: String, description: String) -> Result<PluginSummary, String> {
    let id = slug(&name);
    let parent = parent.map(PathBuf::from).unwrap_or_else(|| plugins_root().join("personal"));
    let root = parent.join(&id);
    if root.exists() {
        return Err(format!("{} already exists", root.display()));
    }
    std::fs::create_dir_all(root.join(".claude-plugin")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("skills").join(&id)).map_err(|e| e.to_string())?;
    let manifest = serde_json::json!({
        "name": id,
        "displayName": name.trim(),
        "version": "0.1.0",
        "description": description.trim(),
        "mcpServers": "./.mcp.json",
        "skills": "./skills/",
    });
    std::fs::write(root.join(".claude-plugin/plugin.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default() + "\n").map_err(|e| e.to_string())?;
    std::fs::write(root.join(".mcp.json"), "{\n  \"mcpServers\": {}\n}\n").map_err(|e| e.to_string())?;
    let skill = format!(
        "---\nname: {id}\ndescription: {}\n---\n\n# {}\n\nDescribe here, step by step, how an agent should do this job.\n",
        if description.trim().is_empty() { format!("Use when the user asks for {}.", name.trim()) } else { description.trim().to_string() },
        name.trim()
    );
    std::fs::write(root.join("skills").join(&id).join("SKILL.md"), skill).map_err(|e| e.to_string())?;
    std::fs::write(root.join("README.md"), format!("# {}\n\n{}\n", name.trim(), description.trim())).map_err(|e| e.to_string())?;
    summarize(&root)
}

/// Write one of Spacron's own plugins (the Plugin Creator) into
/// `<config>/plugins/builtin/<id>/` from files the frontend ships, and read it.
#[tauri::command]
pub fn plugin_write_builtin(id: String, files: std::collections::HashMap<String, String>) -> Result<PluginSummary, String> {
    let root = plugins_root().join("builtin").join(slug(&id));
    let _ = std::fs::remove_dir_all(&root);
    for (rel, content) in files {
        let rel = safe_relative(&rel).ok_or_else(|| format!("unsafe path: {rel}"))?;
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
    }
    summarize(&root)
}

/// Delete a plugin Spacron downloaded or unpacked. Folders outside Spacron's
/// own store (a plugin the user created in their project) are never deleted.
#[tauri::command]
pub fn plugin_delete_files(path: String) -> Result<(), String> {
    let root = plugins_root();
    let target = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let store = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if !target.starts_with(&store) || target == store {
        return Ok(());
    }
    std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Skills into agents
// ---------------------------------------------------------------------------

/// The user-level skill folders a plugin's skills are copied into (checked
/// 2026-10-12):
///
/// - `~/.agents/skills`: the shared folder. Codex, Copilot CLI
///   (`copilot skill --help`), Devin (`devin skills paths`), Qoder (a probe
///   skill showed in `qodercli skills list`), opencode (`opencode debug skill`
///   lists Spacron's skills from it), DeepSeek Harness (dsh-skill-filesystem's
///   README), Amp (ampcode.com/docs/customize/skills) and Cursor (its skills
///   docs) all read it.
/// - `~/.claude/skills`: Claude Code.
/// - `~/.kiro/skills`: Kiro (kiro.dev/docs/skills), which reads no shared folder.
/// - `~/.gemini/config/skills` (Antigravity 2.0 and IDE) and
///   `~/.gemini/antigravity-cli/skills` (Antigravity CLI), from
///   antigravity.google/docs/skills.
/// - `~/.factory/skills` (droid) and `~/.gemini/skills` (Gemini CLI).
///
/// Agent-specific folders are written only when that agent's own folder
/// exists, so a CLI the user never installed leaves no trace; Spacron re-syncs
/// installed plugins at startup, which covers an agent installed later.
///
/// Not `~/.codex/skills`: Codex reads `~/.agents/skills` too. Agents that read
/// several of these folders (Cursor, Amp, opencode) see the same skill name
/// twice and keep one, which is why every copy carries the same `name`.
fn agent_skill_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let mut roots = vec![home.join(".agents").join("skills"), home.join(".claude").join("skills")];
    let when = |agent: &str, rel: &[&str]| -> Option<PathBuf> {
        home.join(agent).is_dir().then(|| rel.iter().fold(home.join(agent), |p, part| p.join(part)))
    };
    for root in [
        when(".kiro", &["skills"]),
        when(".gemini", &["config", "skills"]),
        when(".gemini", &["antigravity-cli", "skills"]),
        when(".gemini", &["skills"]),
        when(".factory", &["skills"]),
    ]
    .into_iter()
    .flatten()
    {
        roots.push(root);
    }
    roots
}

/// Everywhere a Spacron skill folder may exist, including `~/.codex/skills`
/// from builds that wrote there, so a removal also cleans those up.
fn agent_skill_cleanup_roots() -> Vec<PathBuf> {
    let mut roots = agent_skill_roots();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".codex").join("skills"));
        roots.push(home.join(".factory").join("skills"));
        roots.push(home.join(".gemini").join("skills"));
        roots.push(home.join(".gemini").join("config").join("skills"));
        roots.push(home.join(".gemini").join("antigravity-cli").join("skills"));
        roots.push(home.join(".kiro").join("skills"));
    }
    roots.sort();
    roots.dedup();
    roots
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Folder name for a plugin's skill in an agent's skill dir.
fn skill_folder(plugin_id: &str, skill_dir: &Path) -> String {
    let skill = skill_dir.file_name().and_then(|n| n.to_str()).unwrap_or("skill");
    kebab(&format!("{SKILL_PREFIX}{}-{skill}", slug(plugin_id)))
}

/// Lowercase letters, digits and single hyphens: the Agent Skills name rule
/// (Cursor and DeepSeek reject anything else).
fn kebab(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_ascii_lowercase().chars() {
        let c = if c.is_ascii_alphanumeric() { c } else { '-' };
        if !(c == '-' && out.ends_with('-')) {
            out.push(c);
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "skill".into() } else { out.chars().take(64).collect::<String>().trim_end_matches('-').to_string() }
}

/// The SKILL.md text with its front-matter `name` set to `name`. The Agent
/// Skills standard (and Cursor, which enforces it) requires the name to match
/// the folder, and Spacron's folders are `spacron-<plugin>-<skill>`. A file
/// with no front matter gets one, its description taken from its first line.
fn with_skill_name(text: &str, name: &str) -> String {
    let trimmed = text.trim_start_matches('\u{feff}');
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let header = &rest[..end];
            let after = &rest[end..];
            let mut lines: Vec<String> = header
                .lines()
                .filter(|l| !l.trim_start().starts_with("name:"))
                .map(str::to_string)
                .collect();
            let insert_at = usize::from(lines.first().is_some_and(|l| l.trim().is_empty()));
            lines.insert(insert_at, format!("name: {name}"));
            return format!("---{}{after}", lines.join("\n"));
        }
    }
    let first = trimmed
        .lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .unwrap_or("A skill from a Spacron plugin.");
    format!("---\nname: {name}\ndescription: {}\n---\n\n{trimmed}", yaml_string(first))
}

/// `*.md` files under `dir` (recursively), named the way Claude Code names a
/// nested command: `git/commit.md` is `git-commit`.
fn markdown_files(dir: &Path) -> Vec<(String, PathBuf)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>, depth: usize) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && depth < 3 {
                walk(base, &path, out, depth + 1);
            } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md")) {
                let rel = path.strip_prefix(base).unwrap_or(&path).with_extension("");
                let name = rel.to_string_lossy().replace(['/', '\\'], "-");
                if !name.eq_ignore_ascii_case("readme") {
                    out.push((slug(&name), path));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out, 0);
    out.sort();
    out
}

/// The text after a `---` front matter block, or all of it.
fn body_after_front_matter(text: &str) -> &str {
    let trimmed = text.trim_start_matches('\u{feff}');
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + 4..];
            return after.split_once('\n').map(|(_, b)| b).unwrap_or("");
        }
    }
    trimmed
}

/// A YAML double-quoted scalar on one line.
fn yaml_string(text: &str) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("\"{}\"", one_line.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A Claude Code command or sub-agent rewritten as a skill, so agents that
/// read skill folders (but have no slash commands or sub-agents of their own)
/// can use the same instructions.
fn converted_skill(kind: &str, plugin: &str, name: &str, source: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(source).ok()?;
    let (_, description) = skill_front_matter(&text);
    let body = body_after_front_matter(&text).trim();
    if body.is_empty() {
        return None;
    }
    let skill_name = slug(&format!("{plugin}-{name}"));
    let (description, preface) = if kind == "command" {
        (
            format!(
                "{} Use when the user asks for /{name} from the {plugin} plugin, or for this task.",
                description.unwrap_or_else(|| format!("The /{name} command from the {plugin} plugin."))
            ),
            format!(
                "This is the `/{name}` command from the {plugin} plugin. Where it says $ARGUMENTS (or $1, $2, ...), use what the user asked for."
            ),
        )
    } else {
        (
            format!(
                "Work as the {name} specialist from the {plugin} plugin. {}",
                description.unwrap_or_default()
            ),
            format!("Act as the `{name}` specialist from the {plugin} plugin and follow these instructions."),
        )
    };
    let content = format!("---\nname: {skill_name}\ndescription: {}\n---\n\n{preface}\n\n{body}\n", yaml_string(&description));
    Some((skill_name, content))
}

/// Claude Code's own user folders for commands and sub-agents.
fn claude_native_dirs() -> Option<(PathBuf, PathBuf)> {
    let home = dirs::home_dir()?;
    Some((home.join(".claude").join("commands"), home.join(".claude").join("agents")))
}

/// Install a plugin's skills, commands and sub-agents for every agent:
///
/// - skills go to every skill folder (`agent_skill_roots`);
/// - commands and sub-agents go natively to Claude Code (`~/.claude/commands`,
///   `~/.claude/agents`), and as converted skills to every other skill folder,
///   so Codex, Copilot, Devin, Qoder, DeepSeek and the rest can use them too.
///
/// Everything is named `spacron-<plugin>-…`, which is what makes removal safe.
/// Replaces any earlier copy. Returns the skill folders written.
#[tauri::command]
pub fn plugin_enable_skills(plugin_id: String, path: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&path);
    let manifest = MANIFESTS.iter().find_map(|m| read_json(&root.join(m))).unwrap_or_default();
    let plugin = slug(&plugin_id);
    plugin_disable_skills(plugin_id.clone())?;
    let roots = agent_skill_roots();
    let claude_skills = dirs::home_dir().map(|h| h.join(".claude").join("skills"));
    let mut written = Vec::new();
    for dir in skill_dirs(&root, &manifest) {
        let folder = skill_folder(&plugin_id, &dir);
        let skill_md = std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
        let named = with_skill_name(&skill_md, &folder);
        for base in &roots {
            let target = base.join(&folder);
            copy_dir(&dir, &target).map_err(|e| format!("could not install skill {folder}: {e}"))?;
            std::fs::write(target.join("SKILL.md"), &named).map_err(|e| format!("could not install skill {folder}: {e}"))?;
        }
        written.push(folder);
    }

    let (commands_dir, agents_dir) = claude_native_dirs().ok_or("no home folder")?;
    for (kind, source_dir, native_dir) in [("command", root.join("commands"), commands_dir), ("agent", root.join("agents"), agents_dir)] {
        for (name, file) in markdown_files(&source_dir) {
            // Claude Code: the original file, natively.
            std::fs::create_dir_all(&native_dir).map_err(|e| e.to_string())?;
            std::fs::copy(&file, native_dir.join(format!("{SKILL_PREFIX}{plugin}-{name}.md")))
                .map_err(|e| format!("could not install {kind} {name}: {e}"))?;
            // Everyone else: the same instructions as a skill.
            let Some((skill_name, content)) = converted_skill(kind, &plugin, &name, &file) else { continue };
            let folder = kebab(&format!("{SKILL_PREFIX}{plugin}-{kind}-{name}"));
            let content = with_skill_name(&content, &folder);
            for base in roots.iter().filter(|b| Some(*b) != claude_skills.as_ref()) {
                let target = base.join(&folder);
                std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                std::fs::write(target.join("SKILL.md"), &content).map_err(|e| format!("could not install {skill_name}: {e}"))?;
            }
            written.push(folder);
        }
    }
    Ok(written)
}

/// Remove every skill folder Spacron wrote for this plugin.
#[tauri::command]
pub fn plugin_disable_skills(plugin_id: String) -> Result<(), String> {
    let prefix = format!("{SKILL_PREFIX}{}-", slug(&plugin_id));
    let mut bases = agent_skill_cleanup_roots();
    if let Some((commands, agents)) = claude_native_dirs() {
        bases.push(commands);
        bases.push(agents);
    }
    for base in bases {
        let Ok(entries) = std::fs::read_dir(&base) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Icons for marketplace listings
// ---------------------------------------------------------------------------

const ICON_MAX_BYTES: usize = 512 * 1024;

fn image_mime(bytes: &[u8], content_type: &str, url: &str) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") { return Some("image/png"); }
    if bytes.starts_with(&[0, 0, 1, 0]) { return Some("image/x-icon"); }
    if bytes.starts_with(b"\xFF\xD8\xFF") { return Some("image/jpeg"); }
    if bytes.starts_with(b"GIF8") { return Some("image/gif"); }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return Some("image/webp"); }
    // An <img> never runs an SVG's scripts, so an SVG is safe to show.
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(600)]).to_ascii_lowercase();
    let svg_url = url.to_ascii_lowercase().split('?').next().is_some_and(|u| u.ends_with(".svg"));
    if content_type.contains("svg") || svg_url || head.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

/// Fetch an image as a data URL. Refuses private and metadata hosts: these
/// URLs come from third-party marketplace files.
async fn fetch_image(client: &reqwest::Client, url: &str) -> Option<String> {
    use base64::Engine;
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "https" || crate::commands::http::host_is_blocked(parsed.host_str()?) {
        return None;
    }
    let res = client.get(url).send().await.ok()?;
    if !res.status().is_success() || res.content_length().is_some_and(|n| n as usize > ICON_MAX_BYTES) {
        return None;
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = res.bytes().await.ok()?;
    if bytes.len() < 64 || bytes.len() > ICON_MAX_BYTES {
        return None;
    }
    let mime = image_mime(&bytes, &content_type, url)?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// One attribute of an HTML tag, quoted either way or bare.
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=");
    let i = lower.find(&key)? + key.len();
    let rest = &tag[i..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        rest[1..].split(quote).next().map(str::to_string)
    } else {
        rest.split([' ', '>', '/']).next().map(str::to_string)
    }
}

/// A page's icon links: `apple-touch-icon` first (a square app icon), then
/// other `rel="icon"` links, largest first. Mask icons are one-colour
/// silhouettes and are skipped.
fn icon_links(base: &url::Url, html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<link") {
        let start = at + i;
        let end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
        let tag = &html[start..end];
        at = end;
        let rel = tag_attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.contains("icon") || rel.contains("mask-icon") {
            continue;
        }
        let Some(href) = tag_attr(tag, "href") else { continue };
        let Ok(url) = base.join(&href.replace("&amp;", "&")) else { continue };
        let size = tag_attr(tag, "sizes")
            .and_then(|s| s.split('x').next().and_then(|n| n.parse::<u32>().ok()))
            .unwrap_or(0);
        let rank = if rel.contains("apple-touch-icon") { 10_000 } else { 0 } + size;
        found.push((rank, url.to_string()));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, u)| u).collect()
}

/// The icon a website shows for itself.
async fn website_icon(client: &reqwest::Client, homepage: &str) -> Option<String> {
    let page = url::Url::parse(homepage).ok()?;
    let host = page.host_str()?.to_ascii_lowercase();
    // A GitHub repo or org link: the owner's avatar is the vendor's logo,
    // where github.com's own favicon would be the same cat for every plugin.
    if host == "github.com" || host == "www.github.com" {
        let owner = page.path_segments()?.next().filter(|o| !o.is_empty())?.to_string();
        return fetch_image(client, &format!("https://github.com/{owner}.png?size=96")).await;
    }
    if page.scheme() != "https" || crate::commands::http::host_is_blocked(&host) {
        return None;
    }
    if let Ok(res) = client.get(page.as_str()).send().await {
        if res.status().is_success() {
            let final_url = res.url().clone();
            if let Ok(html) = res.text().await {
                for link in icon_links(&final_url, &html).into_iter().take(4) {
                    if let Some(icon) = fetch_image(client, &link).await {
                        return Some(icon);
                    }
                }
            }
        }
    }
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    crate::commands::custom_providers::fetch_icon(&host).await
}

type IconCache = std::sync::Mutex<Option<std::collections::HashMap<String, Option<String>>>>;
static LISTING_ICONS: IconCache = std::sync::Mutex::new(None);

/// The icon for one plugin in a marketplace listing, as a data URL: the
/// plugin's own icon file (a Codex manifest's `interface.composerIcon` or
/// `logo`), else its website's icon, else its GitHub owner's avatar when the
/// plugin lives outside the marketplace's own repo. Cached for the session.
#[tauri::command]
pub async fn plugin_listing_icon(source: String, plugin: String, homepage: Option<String>) -> Option<String> {
    let cache_key = format!("{source}\u{0}{plugin}");
    let cached = LISTING_ICONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(&cache_key).cloned());
    if let Some(hit) = cached {
        return hit;
    }
    let found = listing_icon(&source, &plugin, homepage).await;
    LISTING_ICONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(Default::default)
        .insert(cache_key, found.clone());
    found
}

async fn listing_icon(source: &str, plugin: &str, homepage: Option<String>) -> Option<String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Spacron)")
        .build()
        .ok()?;
    let (market, json) = load_marketplace(source).await.ok()?;
    let entry = json
        .get("plugins")?
        .as_array()?
        .iter()
        .find(|e| str_field(e, "name").as_deref() == Some(plugin))?
        .clone();
    let location = entry_location(&market, &entry);
    let mut site = homepage.filter(|h| !h.trim().is_empty());
    if let Some(location) = &location {
        for manifest in MANIFESTS {
            let Some(text) = fetch_text(&client, &raw_url(location, manifest)).await else { continue };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let interface = json.get("interface").cloned().unwrap_or_default();
            for key in ["composerIcon", "logo"] {
                let rel = interface
                    .get(key)
                    .and_then(|v| v.as_str())
                    .and_then(|r| safe_relative(r.trim_start_matches("./")));
                if let Some(rel) = rel {
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if let Some(icon) = fetch_image(&client, &raw_url(location, &rel)).await {
                        return Some(icon);
                    }
                }
            }
            if site.is_none() {
                site = str_field(&json, "homepage").or_else(|| str_field(&interface, "websiteURL"));
            }
            break;
        }
    }
    if let Some(site) = &site {
        if let Some(icon) = website_icon(&client, site).await {
            return Some(icon);
        }
    }
    // Last resort: whoever hosts the plugin. For a plugin in its vendor's own
    // repo that is the vendor; for one in the marketplace's repo it is the
    // marketplace owner, who made it (Anthropic's or OpenAI's own plugins).
    let owner = location.map(|l| l.owner).unwrap_or(market.owner);
    fetch_image(&client, &format!("https://github.com/{owner}.png?size=96")).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_sources() {
        assert_eq!(
            parse_github("anthropics/claude-plugins-official").unwrap(),
            GitHubRef { owner: "anthropics".into(), repo: "claude-plugins-official".into(), rev: "HEAD".into(), path: "".into() }
        );
        let r = parse_github("https://github.com/stripe/ai.git#v2").unwrap();
        assert_eq!((r.repo.as_str(), r.rev.as_str()), ("ai", "v2"));
        let t = parse_github("https://github.com/o/r/tree/main/plugins/x").unwrap();
        assert_eq!((t.rev.as_str(), t.path.as_str()), ("main", "plugins/x"));
        assert!(parse_github("not a repo").is_err());
        assert!(parse_github("../x/y").is_err());
    }

    #[test]
    fn resolves_marketplace_entry_sources() {
        let m = GitHubRef { owner: "a".into(), repo: "m".into(), rev: "HEAD".into(), path: "".into() };
        let local = entry_location(&m, &serde_json::json!({ "source": "./plugins/x" })).unwrap();
        assert_eq!((local.repo.as_str(), local.path.as_str()), ("m", "plugins/x"));
        let sub = entry_location(&m, &serde_json::json!({ "source": { "source": "git-subdir", "url": "https://github.com/s/ai.git", "path": "p/c", "sha": "abc" } })).unwrap();
        assert_eq!((sub.owner.as_str(), sub.rev.as_str(), sub.path.as_str()), ("s", "abc", "p/c"));
        let codex = entry_location(&m, &serde_json::json!({ "source": { "source": "local", "path": "./plugins/linear" } })).unwrap();
        assert_eq!(codex.path, "plugins/linear");
        assert!(entry_location(&m, &serde_json::json!({ "source": { "source": "npm", "package": "x" } })).is_none());
    }

    #[test]
    fn rejects_paths_that_escape() {
        assert!(safe_relative("../evil").is_none());
        assert!(safe_relative("/abs").is_none());
        assert_eq!(safe_relative("a/./b").unwrap(), PathBuf::from("a/b"));
    }

    #[test]
    fn finds_placeholders_and_applies_defaults() {
        let mut v = serde_json::json!({ "a": { "url": "${HOST:-https://x}/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" }, "args": ["${CLAUDE_PLUGIN_ROOT}/run"] } });
        resolve_strings(&mut v, "/p");
        assert_eq!(v["a"]["url"], "https://x/mcp");
        assert_eq!(v["a"]["args"][0], "/p/run");
        let mut vars = BTreeSet::new();
        placeholders(&v, &mut vars);
        assert_eq!(vars.into_iter().collect::<Vec<_>>(), vec!["TOKEN".to_string()]);
    }

    #[test]
    fn turns_commands_and_sub_agents_into_skills() {
        let dir = std::env::temp_dir().join(format!("spacron-cmd-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("commands/git")).unwrap();
        std::fs::write(dir.join("commands/git/ship.md"), "---\ndescription: Ship \"it\"\n---\nCommit $ARGUMENTS and push.\n").unwrap();
        std::fs::write(dir.join("reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\n---\nYou review code.\n").unwrap();
        let names: Vec<String> = markdown_files(&dir.join("commands")).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec!["git-ship".to_string()]);
        let (name, text) = converted_skill("command", "vercel", "git-ship", &dir.join("commands/git/ship.md")).unwrap();
        assert_eq!(name, "vercel-git-ship");
        assert!(text.starts_with("---\nname: vercel-git-ship\ndescription: \"Ship \\\"it\\\" Use when"));
        assert!(text.contains("Commit $ARGUMENTS and push."));
        assert!(!text.contains("description: Ship \"it\"\n---\nCommit"));
        let (_, agent) = converted_skill("agent", "vercel", "reviewer", &dir.join("reviewer.md")).unwrap();
        assert!(agent.contains("Work as the reviewer specialist from the vercel plugin. Reviews code"));
        assert!(agent.trim_end().ends_with("You review code."));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_every_skill_after_its_folder() {
        let named = with_skill_name("---\nname: vercel-firewall\ndescription: x\n---\nbody\n", "spacron-vercel-vercel-firewall");
        assert_eq!(named, "---\nname: spacron-vercel-vercel-firewall\ndescription: x\n---\nbody\n");
        let missing = with_skill_name("---\ndescription: y\n---\nb", "spacron-p-s");
        assert!(missing.starts_with("---\nname: spacron-p-s\ndescription: y\n---"));
        let bare = with_skill_name("# Do the thing\nsteps", "spacron-p-s");
        assert!(bare.starts_with("---\nname: spacron-p-s\ndescription: \"Do the thing\"\n---\n\n# Do the thing"));
        assert_eq!(kebab("spacron-My_Plugin--x"), "spacron-my-plugin-x");
        assert_eq!(skill_folder("vercel", Path::new("/p/skills/Deploy_Now")), "spacron-vercel-deploy-now");
    }

    #[test]
    fn reads_skill_front_matter() {
        let (n, d) = skill_front_matter("---\nname: pdf\ndescription: \"Fill PDFs\"\n---\nbody");
        assert_eq!((n.as_deref(), d.as_deref()), (Some("pdf"), Some("Fill PDFs")));
        assert_eq!(skill_front_matter("no front matter"), (None, None));
    }

    #[test]
    fn prefers_apple_touch_icons_and_resolves_relative_links() {
        let base = url::Url::parse("https://example.com/docs/").unwrap();
        let html = r#"<link rel="icon" href="/favicon-32.png" sizes="32x32"><link rel="mask-icon" href="/pin.svg"><link rel='apple-touch-icon' href="touch.png">"#;
        assert_eq!(
            icon_links(&base, html),
            vec!["https://example.com/docs/touch.png".to_string(), "https://example.com/favicon-32.png".to_string()]
        );
    }

    #[test]
    fn scaffolds_and_reads_a_plugin() {
        let dir = std::env::temp_dir().join(format!("spacron-plugin-test-{}", uuid::Uuid::new_v4().simple()));
        let summary = plugin_create(Some(dir.to_string_lossy().into()), "My Tool".into(), "Does a thing".into()).unwrap();
        assert_eq!(summary.name, "my-tool");
        assert_eq!(summary.title, "My Tool");
        assert_eq!(summary.skills.len(), 1);
        assert!(summary.mcp_servers.as_object().unwrap().is_empty());
        assert!(summary.commands.is_empty() && summary.agents.is_empty() && summary.claude_only.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Hits github.com: `cargo test --lib plugins::live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn reads_real_marketplaces_and_installs_a_plugin_from_each() {
        for (market, plugin) in [("anthropics/claude-plugins-official", "context7"), ("openai/plugins", "linear")] {
            let listing = plugin_marketplace_fetch(market.into()).await.unwrap();
            let installable = listing.plugins.iter().filter(|p| p.installable).count();
            println!("{market}: {} plugins, {installable} installable", listing.plugins.len());
            let summary = plugin_install_from_marketplace(market.into(), plugin.into()).await.unwrap();
            println!(
                "  {plugin}: servers={} skills={:?} vars={:?} claude_only={:?} icon={}",
                summary.mcp_servers,
                summary.skills.iter().map(|s| &s.name).collect::<Vec<_>>(),
                summary.variables,
                summary.claude_only,
                summary.icon.is_some()
            );
            assert!(summary.mcp_servers.as_object().is_some_and(|m| !m.is_empty()));
            plugin_delete_files(summary.path).unwrap();
        }
        // Codex's linear ships an icon file; Claude's stripe lives in Stripe's repo.
        for (market, plugin) in [
            ("openai/plugins", "linear"),
            ("anthropics/claude-plugins-official", "stripe"),
            ("anthropics/claude-plugins-official", "context7"),
            ("anthropics/claude-plugins-official", "code-review"),
        ] {
            let icon = plugin_listing_icon(market.into(), plugin.into(), None).await;
            println!("  icon {plugin}: {}", icon.as_deref().map(|i| &i[..i.len().min(40)]).unwrap_or("none"));
        }
    }
}
