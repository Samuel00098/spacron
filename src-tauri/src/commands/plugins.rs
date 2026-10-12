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
    /// The manifest's icon as a data URL, when it ships one.
    pub icon: Option<String>,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `---\nname: x\ndescription: y\n---` front matter of a SKILL.md.
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
            name = Some(v.trim().trim_matches('"').to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(v.trim().trim_matches('"').to_string());
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

    let mut claude_only = Vec::new();
    for (dir, label) in [("commands", "slash commands"), ("agents", "sub-agents"), ("hooks", "hooks")] {
        if root.join(dir).is_dir() || manifest.get(dir).is_some() {
            claude_only.push(label.to_string());
        }
    }
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

/// The user-level skill folders of agents that read `SKILL.md` folders.
fn agent_skill_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    vec![home.join(".claude").join("skills"), home.join(".codex").join("skills")]
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
    let skill = skill_dir.file_name().and_then(|n| n.to_str()).map(slug).unwrap_or_else(|| "skill".into());
    format!("{SKILL_PREFIX}{}-{skill}", slug(plugin_id))
}

/// Copy a plugin's skills into Claude Code's and Codex's skill folders, under
/// `spacron-<plugin>-<skill>`. Replaces any earlier copy. Returns the folders written.
#[tauri::command]
pub fn plugin_enable_skills(plugin_id: String, path: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&path);
    let manifest = MANIFESTS.iter().find_map(|m| read_json(&root.join(m))).unwrap_or_default();
    plugin_disable_skills(plugin_id.clone())?;
    let mut written = Vec::new();
    for dir in skill_dirs(&root, &manifest) {
        let folder = skill_folder(&plugin_id, &dir);
        for base in agent_skill_roots() {
            copy_dir(&dir, &base.join(&folder)).map_err(|e| format!("could not install skill {folder}: {e}"))?;
        }
        written.push(folder);
    }
    Ok(written)
}

/// Remove every skill folder Spacron wrote for this plugin.
#[tauri::command]
pub fn plugin_disable_skills(plugin_id: String) -> Result<(), String> {
    let prefix = format!("{SKILL_PREFIX}{}-", slug(&plugin_id));
    for base in agent_skill_roots() {
        let Ok(entries) = std::fs::read_dir(&base) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}

/// The icon on a plugin's homepage, as a data URL (the webview cannot load
/// remote images).
#[tauri::command]
pub async fn plugin_site_icon(homepage: String) -> Option<String> {
    let host = url::Url::parse(&homepage).ok()?.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    crate::commands::custom_providers::fetch_icon(&host).await
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
    fn reads_skill_front_matter() {
        let (n, d) = skill_front_matter("---\nname: pdf\ndescription: \"Fill PDFs\"\n---\nbody");
        assert_eq!((n.as_deref(), d.as_deref()), (Some("pdf"), Some("Fill PDFs")));
        assert_eq!(skill_front_matter("no front matter"), (None, None));
    }

    #[test]
    fn scaffolds_and_reads_a_plugin() {
        let dir = std::env::temp_dir().join(format!("spacron-plugin-test-{}", uuid::Uuid::new_v4().simple()));
        let summary = plugin_create(Some(dir.to_string_lossy().into()), "My Tool".into(), "Does a thing".into()).unwrap();
        assert_eq!(summary.name, "my-tool");
        assert_eq!(summary.title, "My Tool");
        assert_eq!(summary.skills.len(), 1);
        assert!(summary.mcp_servers.as_object().unwrap().is_empty());
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
    }
}
