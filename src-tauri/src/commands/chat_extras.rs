//! Lookups the terminal chat view makes around an agent's conversation:
//! files for `@` mentions, link preview cards, and the state and CI checks of
//! pull requests a turn opened. All read-only and bounded.

use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

const MAX_WALK_FILES: usize = 40_000;
const MAX_FILE_RESULTS: usize = 50;

/// Project files for the composer's `@` menu, relative to `root` with forward
/// slashes, best matches first. Honours .gitignore; hidden folders are skipped.
#[tauri::command]
pub async fn chat_list_files(root: String, query: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = Path::new(&root);
        if !base.is_dir() {
            return Err("Folder not found".to_string());
        }
        let needle = query.trim().to_lowercase().replace('\\', "/");
        let limit = limit.unwrap_or(20).clamp(1, MAX_FILE_RESULTS);
        let mut scored: Vec<(i64, String)> = Vec::new();
        let walker = ignore::WalkBuilder::new(base).hidden(true).git_ignore(true).parents(true).build();
        for entry in walker.filter_map(Result::ok).take(MAX_WALK_FILES) {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(base) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if let Some(score) = file_match_score(&rel, &needle) {
                scored.push((score, rel));
            }
        }
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(&b.1)));
        Ok(scored.into_iter().take(limit).map(|(_, p)| p).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Higher is better; None when `needle` is not a subsequence of the path.
fn file_match_score(path: &str, needle: &str) -> Option<i64> {
    if needle.is_empty() {
        // Shallow files first when nothing is typed yet.
        return Some(-(path.matches('/').count() as i64) * 10);
    }
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name == needle {
        return Some(10_000);
    }
    if name.starts_with(needle) {
        return Some(5_000 - name.len() as i64);
    }
    if name.contains(needle) {
        return Some(3_000 - name.len() as i64);
    }
    if lower.contains(needle) {
        return Some(2_000 - lower.len() as i64);
    }
    // Subsequence: every character in order, scored by how tight the match is.
    let mut chars = needle.chars().peekable();
    let mut gaps = 0i64;
    let mut started = false;
    for c in lower.chars() {
        match chars.peek() {
            Some(&want) if want == c => {
                chars.next();
                started = true;
            }
            Some(_) if started => gaps += 1,
            Some(_) => {}
            None => break,
        }
    }
    chars.peek().is_none().then(|| 1_000 - gaps - lower.len() as i64)
}

// ---------------------------------------------------------------------------
// Skills and custom commands for the `/` menu
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSkill {
    /// What the menu shows and filters on, e.g. `/review-pr` or `$imagegen`.
    pub name: String,
    pub description: String,
    /// `skill` | `command`
    pub kind: String,
    /// `project` | `user` | `system` | a plugin's name
    pub source: String,
    /// Text the composer puts in when it is picked.
    pub insert: String,
}

/// The skills and custom slash commands an agent CLI loads for `cwd`, read
/// from the same folders the CLI reads (Claude Code: `.claude/skills`,
/// `.claude/commands`, enabled plugins; Codex: `.codex/skills`, `.agents/skills`,
/// `prompts`; OpenCode: `command` folders).
#[tauri::command]
pub async fn chat_list_skills(agent: String, cwd: String) -> Result<Vec<ChatSkill>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(list_skills(&agent, Path::new(&cwd))))
        .await
        .map_err(|e| e.to_string())?
}

fn env_path(var: &str) -> Option<std::path::PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(std::path::PathBuf::from)
}

/// How an agent invokes a skill: the sigil before its name, and any name prefix
/// (Pi expands only `/skill:<name>`). Orca's per-agent profiles.
fn skill_invocation(agent: &str) -> (&'static str, &'static str) {
    match agent {
        "codex" => ("$", ""),
        "pi" => ("/", "skill:"),
        _ => ("/", ""),
    }
}

/// The skill folders an agent reads, project first (a project skill shadows a
/// personal one of the same name). Mirrors Orca's skill discovery: each agent's
/// own folders, the shared `.agents/skills` every agent reads, and the folders
/// of other agents it also reads (OpenCode and Cursor read Claude's, Copilot
/// reads Claude's project skills).
fn skill_roots(agent: &str, cwd: &Path) -> Vec<(std::path::PathBuf, &'static str)> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let claude_home = env_path("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
    let codex_home = env_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    let config = env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
    let project = |parts: &[&str]| parts.iter().fold(cwd.to_path_buf(), |p, s| p.join(s));
    let personal = |parts: &[&str]| parts.iter().fold(home.clone(), |p, s| p.join(s));
    let mut roots: Vec<(std::path::PathBuf, &'static str)> = vec![(project(&[".agents", "skills"]), "project")];
    let claude_project = (project(&[".claude", "skills"]), "project");
    let claude_personal = (claude_home.join("skills"), "user");
    match agent {
        "claude" => roots.extend([claude_project, claude_personal]),
        "openclaude" => roots.extend([
            (project(&[".openclaude", "skills"]), "project"),
            claude_project,
            (personal(&[".openclaude", "skills"]), "user"),
            claude_personal,
        ]),
        "codex" => roots.extend([(project(&[".codex", "skills"]), "project"), (codex_home.join("skills"), "user")]),
        "grok" => roots.extend([(project(&[".grok", "skills"]), "project"), (personal(&[".grok", "skills"]), "user")]),
        "opencode" => roots.extend([
            (project(&[".opencode", "skills"]), "project"),
            (project(&[".opencode", "skill"]), "project"),
            claude_project,
            (config.join("opencode").join("skills"), "user"),
            (config.join("opencode").join("skill"), "user"),
            claude_personal,
        ]),
        "cursor" => roots.extend([
            (project(&[".cursor", "skills"]), "project"),
            claude_project,
            (project(&[".codex", "skills"]), "project"),
            (project(&[".grok", "skills"]), "project"),
            (personal(&[".cursor", "skills"]), "user"),
            (personal(&[".cursor", "skills-cursor"]), "system"),
            claude_personal,
            (codex_home.join("skills"), "user"),
            (personal(&[".grok", "skills"]), "user"),
        ]),
        "copilot" => roots.extend([
            (project(&[".github", "skills"]), "project"),
            claude_project,
            (personal(&[".copilot", "skills"]), "user"),
        ]),
        "antigravity" => roots.extend([
            (personal(&[".gemini", "config", "skills"]), "user"),
            (personal(&[".gemini", "antigravity-cli", "skills"]), "user"),
        ]),
        "pi" => roots.push((personal(&[".pi", "agent", "skills"]), "user")),
        "omp" => roots.push((personal(&[".omp", "agent", "skills"]), "user")),
        _ => {}
    }
    // Shared personal skills every agent reads.
    roots.push((home.join(".agents").join("skills"), "user"));
    roots
}

fn list_skills(agent: &str, cwd: &Path) -> Vec<ChatSkill> {
    let home = dirs::home_dir();
    let (sigil, name_prefix) = skill_invocation(agent);
    let mut out: Vec<ChatSkill> = Vec::new();
    for (root, source) in skill_roots(agent, cwd) {
        collect_skill_dirs(&root, source, sigil, name_prefix, &mut out);
    }
    match agent {
        "claude" | "openclaude" => {
            let base = env_path("CLAUDE_CONFIG_DIR").or_else(|| home.as_ref().map(|h| h.join(".claude")));
            collect_commands(&cwd.join(".claude").join("commands"), "project", "/", "", &mut out);
            if let Some(base) = &base {
                collect_commands(&base.join("commands"), "user", "/", "", &mut out);
                for (plugin, path) in enabled_claude_plugins(base) {
                    let prefix = format!("{plugin}:");
                    collect_skill_dirs(&path.join("skills"), &plugin, "/", &prefix, &mut out);
                    collect_commands(&path.join("commands"), &plugin, "/", &prefix, &mut out);
                }
            }
        }
        "codex" => {
            let base = env_path("CODEX_HOME").or_else(|| home.as_ref().map(|h| h.join(".codex")));
            if let Some(base) = &base {
                collect_commands(&base.join("prompts"), "user", "/", "prompts:", &mut out);
            }
        }
        "opencode" => {
            let config = env_path("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|h| h.join(".config")));
            for folder in ["command", "commands"] {
                collect_commands(&cwd.join(".opencode").join(folder), "project", "/", "", &mut out);
                if let Some(c) = &config {
                    collect_commands(&c.join("opencode").join(folder), "user", "/", "", &mut out);
                }
            }
        }
        _ => {}
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.name.to_lowercase()));
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.truncate(400);
    out
}

// ---------------------------------------------------------------------------
// Claude Code's own command list
// ---------------------------------------------------------------------------

/// Claude Code's live slash-command list for `cwd`: built-ins, skills (personal,
/// project, plugin) and custom commands, exactly as its `/` menu has them.
/// Asked the way Orca asks: an `initialize` control request over stream-json,
/// which lists commands without a model turn and, with
/// `--no-session-persistence`, leaves no conversation behind.
#[tauri::command]
pub async fn chat_claude_commands(cwd: String, command: Option<String>) -> Result<Vec<ChatSkill>, String> {
    let program = command.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "claude".into());
    tauri::async_runtime::spawn_blocking(move || claude_command_probe(&program, &cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn claude_command_probe(program: &str, cwd: &str) -> Result<Vec<ChatSkill>, String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let resolved = resolve_program(program);
    let is_script = resolved.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if is_script {
        // npm installs `claude` as a .cmd shim, which only cmd can start.
        let mut c = Command::new("cmd");
        c.arg("/d").arg("/c").arg(&resolved);
        c
    } else {
        Command::new(&resolved)
    };
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let request = r#"{"type":"control_request","request_id":"spacron-commands","request":{"subtype":"initialize"}}"#;
        let _ = stdin.write_all(format!("{request}\n").as_bytes());
        // Dropping stdin ends the session once it has answered.
    }
    let mut stdout = child.stdout.take().ok_or("no output")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // Lossy: one odd byte in a skill description must not drop the whole list.
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    let text = match rx.recv_timeout(std::time::Duration::from_secs(45)) {
        Ok(text) => text,
        Err(_) => {
            let _ = child.kill();
            return Err("Claude Code took too long to list its commands".into());
        }
    };
    let _ = child.wait();
    let response = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("control_response"))
        .ok_or("Claude Code did not list its commands")?;
    let commands = response.pointer("/response/response/commands").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(claude_commands_from(&commands))
}

/// The program's full path, as a new terminal would find it. On Windows an npm
/// install leaves an extension-less shell script beside the `.cmd`; the `.exe`
/// or `.cmd` is the one Windows can run.
fn resolve_program(program: &str) -> std::path::PathBuf {
    let found = crate::commands::agent_probe::which(program).unwrap_or_else(|| std::path::PathBuf::from(program));
    if cfg!(windows) && found.extension().is_none() {
        for ext in ["exe", "cmd", "bat"] {
            let sibling = found.with_extension(ext);
            if sibling.is_file() {
                return sibling;
            }
        }
    }
    found
}

/// Claude's descriptors as menu rows. Its descriptions end in `(user)` or
/// `(project)` for skills from those folders; a `plugin:` name is a plugin's.
fn claude_commands_from(commands: &[Value]) -> Vec<ChatSkill> {
    let mut out = Vec::new();
    for entry in commands.iter().take(600) {
        let Some(name) = entry.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty() && !n.contains(' ')) else {
            continue;
        };
        let mut description = entry.get("description").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let builtin = entry.get("builtin").and_then(Value::as_bool) == Some(true);
        let mut source = if builtin { "builtin".to_string() } else { "user".to_string() };
        for (tag, src) in [("(user)", "user"), ("(project)", "project")] {
            if let Some(stripped) = description.strip_suffix(tag) {
                description = stripped.trim().to_string();
                source = src.into();
            }
        }
        if !builtin {
            if let Some((plugin, _)) = name.split_once(':') {
                source = plugin.to_string();
            }
        }
        let full = format!("/{name}");
        out.push(ChatSkill {
            kind: if builtin { "builtin".into() } else { "skill".into() },
            source,
            insert: format!("{full} "),
            description,
            name: full,
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Installed fonts
// ---------------------------------------------------------------------------

/// Font families installed on this machine, for the chat's font picker.
#[tauri::command]
pub async fn system_font_families() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(font_families()))
        .await
        .map_err(|e| e.to_string())?
}

const FONT_STYLE_WORDS: &[&str] = &[
    "thin", "hairline", "extralight", "ultralight", "light", "semilight", "demilight", "book", "regular", "normal",
    "medium", "semibold", "demibold", "bold", "extrabold", "ultrabold", "black", "heavy", "italic", "oblique",
    "condensed", "semicondensed", "extracondensed", "expanded", "variable", "retina", "nf", "mono nf",
];

/// "Segoe UI Semibold Italic (TrueType)" → "Segoe UI".
fn font_family_from(name: &str) -> Option<String> {
    let base = name.split(" (").next()?.trim();
    let mut words: Vec<&str> = base.split_whitespace().collect();
    while words.len() > 1 {
        let last = words[words.len() - 1].to_lowercase();
        let pair = if words.len() > 2 { format!("{} {}", words[words.len() - 2].to_lowercase(), last) } else { String::new() };
        if FONT_STYLE_WORDS.contains(&last.as_str()) || FONT_STYLE_WORDS.contains(&pair.as_str()) {
            words.pop();
        } else {
            break;
        }
    }
    let family = words.join(" ");
    (!family.is_empty() && !family.starts_with('@')).then_some(family)
}

fn font_families() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        for key in [
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
            r"HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        ] {
            let Ok(out) = std::process::Command::new("reg").args(["query", key]).creation_flags(CREATE_NO_WINDOW).output() else { continue };
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some((name, _)) = line.trim().split_once("    REG_") {
                    // One entry can name several faces: "Cambria & Cambria Math (TrueType)".
                    let tail = name.find(" (").map(|i| &name[i..]).unwrap_or("");
                    for part in name.trim_end_matches(tail).split(" & ") {
                        names.extend(font_family_from(part));
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(out) = std::process::Command::new("fc-list").args([":", "family"]).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                names.extend(line.split(',').next().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()));
            }
        }
        let mut dirs_to_scan = vec![std::path::PathBuf::from("/System/Library/Fonts"), std::path::PathBuf::from("/Library/Fonts")];
        if let Some(h) = dirs::home_dir() {
            dirs_to_scan.push(h.join("Library").join("Fonts"));
        }
        for dir in dirs_to_scan {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for entry in entries.filter_map(Result::ok) {
                let stem = entry.path().file_stem().map(|s| s.to_string_lossy().replace(['-', '_'], " ")).unwrap_or_default();
                names.extend(font_family_from(&stem));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    names.retain(|n| seen.insert(n.to_lowercase()));
    names.sort_by_key(|n| n.to_lowercase());
    names
}

/// `(plugin name, install path)` for each plugin enabled in Claude Code's settings.
fn enabled_claude_plugins(base: &Path) -> Vec<(String, std::path::PathBuf)> {
    let read = |p: std::path::PathBuf| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let enabled = read(base.join("settings.json"))
        .and_then(|v| v.get("enabledPlugins").cloned())
        .unwrap_or(Value::Null);
    let Some(installed) = read(base.join("plugins").join("installed_plugins.json")) else { return Vec::new() };
    let mut out = Vec::new();
    for (key, entries) in installed.get("plugins").and_then(Value::as_object).into_iter().flatten() {
        if enabled.get(key).and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let name = key.split('@').next().unwrap_or(key).to_string();
        if let Some(path) = entries.as_array().and_then(|a| a.last()).and_then(|e| e.get("installPath")).and_then(Value::as_str) {
            out.push((name, std::path::PathBuf::from(path)));
        }
    }
    out
}

/// Every `<dir>/<skill>/SKILL.md` (one level of grouping folders allowed).
fn collect_skill_dirs(dir: &Path, source: &str, sigil: &str, prefix: &str, out: &mut Vec<ChatSkill>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok).take(500) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill = path.join("SKILL.md");
        if skill.is_file() {
            push_skill(&skill, &entry.file_name().to_string_lossy(), source, sigil, prefix, out);
            continue;
        }
        // A grouping folder (Codex's `.system`, synced skill sets) holds skills one level down.
        let group = entry.file_name().to_string_lossy().to_string();
        let source = if group == ".system" { "system".to_string() } else { source.to_string() };
        let Ok(inner) = std::fs::read_dir(&path) else { continue };
        for child in inner.filter_map(Result::ok).take(500) {
            let skill = child.path().join("SKILL.md");
            if skill.is_file() {
                push_skill(&skill, &child.file_name().to_string_lossy(), &source, sigil, prefix, out);
            }
        }
    }
}

fn push_skill(file: &Path, folder: &str, source: &str, sigil: &str, prefix: &str, out: &mut Vec<ChatSkill>) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let meta = frontmatter(&text);
    // Claude Code hides `user-invocable: false` skills from its slash menu.
    if meta.get("user-invocable").is_some_and(|v| v.eq_ignore_ascii_case("false")) {
        return;
    }
    let name = meta.get("name").cloned().filter(|n| !n.is_empty()).unwrap_or_else(|| folder.to_string());
    let full = format!("{sigil}{prefix}{name}");
    out.push(ChatSkill {
        description: meta.get("description").cloned().unwrap_or_default(),
        kind: "skill".into(),
        source: source.to_string(),
        insert: format!("{full} "),
        name: full,
    });
}

/// Every `<dir>/**/*.md` as a command; subfolders become `folder:name`.
fn collect_commands(dir: &Path, source: &str, sigil: &str, prefix: &str, out: &mut Vec<ChatSkill>) {
    fn walk(root: &Path, dir: &Path, depth: usize, files: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.filter_map(Result::ok).take(500) {
            let path = entry.path();
            if path.is_dir() && depth < 3 {
                walk(root, &path, depth + 1, files);
            } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
                files.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, dir, 0, &mut files);
    for file in files {
        let Ok(rel) = file.strip_prefix(dir) else { continue };
        let stem = rel.with_extension("").to_string_lossy().replace(['\\', '/'], ":");
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let meta = frontmatter(&text);
        let description = meta.get("description").cloned().unwrap_or_else(|| {
            body_after_frontmatter(&text)
                .lines()
                .map(|l| l.trim().trim_start_matches('#').trim())
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .chars()
                .take(160)
                .collect()
        });
        let full = format!("{sigil}{prefix}{stem}");
        out.push(ChatSkill { description, kind: "command".into(), source: source.to_string(), insert: format!("{full} "), name: full });
    }
}

fn body_after_frontmatter(text: &str) -> &str {
    let t = text.trim_start_matches('\u{feff}');
    if let Some(rest) = t.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            return rest[end + 4..].trim_start_matches(['-', '\r', '\n']);
        }
    }
    t
}

/// The top-level scalar keys of a Markdown file's YAML frontmatter, including
/// folded (`>-`) and literal (`|`) blocks and quoted values. Enough for
/// `name` and `description`; nested structures are skipped.
fn frontmatter(text: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let t = text.trim_start_matches('\u{feff}');
    let Some(rest) = t.strip_prefix("---") else { return map };
    let Some(end) = rest.find("\n---") else { return map };
    let lines: Vec<&str> = rest[..end].lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.starts_with([' ', '\t']) || line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_string();
        let value = value.trim();
        let parsed = if value.starts_with('>') || value.starts_with('|') {
            let folded = value.starts_with('>');
            let mut parts = Vec::new();
            while i < lines.len() && (lines[i].starts_with([' ', '\t']) || lines[i].trim().is_empty()) {
                parts.push(lines[i].trim());
                i += 1;
            }
            if folded { parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ") } else { parts.join("\n").trim().to_string() }
        } else {
            let unquoted = if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
                || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
            {
                value[1..value.len() - 1].replace("\\\"", "\"").replace("''", "'")
            } else {
                value.to_string()
            };
            // A plain scalar may continue on indented lines.
            let mut text = unquoted;
            while i < lines.len() && lines[i].starts_with([' ', '\t']) && !lines[i].trim().is_empty() {
                text.push(' ');
                text.push_str(lines[i].trim());
                i += 1;
            }
            text
        };
        map.insert(key, parsed);
    }
    map
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image: Option<String>,
}

const MAX_PREVIEW_HTML: usize = 384 * 1024;

/// Title, description and image of a web page linked in a reply, from its
/// `<meta>` tags. Only public http(s) hosts; loopback and private addresses are
/// refused so a reply can't make the app probe the local network.
#[tauri::command]
pub async fn chat_link_preview(url: String) -> Result<LinkPreview, String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Not a link".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web links have previews".to_string());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if is_private_host(&host) {
        return Err("Local addresses have no preview".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(4))
        .user_agent("Mozilla/5.0 (compatible; link-preview)")
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(parsed.clone()).send().await.map_err(|e| e.to_string())?;
    let final_host = response.url().host_str().unwrap_or("").to_ascii_lowercase();
    if is_private_host(&final_host) {
        return Err("Local addresses have no preview".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("The page answered {}", response.status()));
    }
    let is_html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("html"));
    if !is_html {
        return Ok(LinkPreview { url, site_name: Some(host), ..Default::default() });
    }
    let mut body = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_PREVIEW_HTML {
            break;
        }
    }
    let html = String::from_utf8_lossy(&body);
    let base = parsed;
    let mut preview = parse_link_preview(&html);
    preview.image = preview
        .image
        .and_then(|src| base.join(&src).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.to_string());
    preview.site_name = preview.site_name.or(Some(host));
    preview.url = url;
    Ok(preview)
}

fn is_private_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
        Err(_) => false,
    }
}

fn parse_link_preview(html: &str) -> LinkPreview {
    let head = match html.to_ascii_lowercase().find("</head>") {
        Some(end) => &html[..end],
        None => html,
    };
    let mut preview = LinkPreview::default();
    let meta = regex::Regex::new(r#"(?is)<meta\s+[^>]*>"#).expect("meta regex");
    let attr = regex::Regex::new(r#"(?is)([a-z:_-]+)\s*=\s*("([^"]*)"|'([^']*)')"#).expect("attr regex");
    for tag in meta.find_iter(head) {
        let mut key = None;
        let mut content = None;
        for cap in attr.captures_iter(tag.as_str()) {
            let name = cap[1].to_ascii_lowercase();
            let value = cap.get(3).or_else(|| cap.get(4)).map(|m| decode_entities(m.as_str().trim()));
            match name.as_str() {
                "property" | "name" => key = value.map(|v| v.to_ascii_lowercase()),
                "content" => content = value,
                _ => {}
            }
        }
        let (Some(key), Some(content)) = (key, content) else { continue };
        if content.is_empty() {
            continue;
        }
        match key.as_str() {
            "og:title" | "twitter:title" => preview.title = preview.title.or(Some(content)),
            "og:description" | "twitter:description" | "description" => preview.description = preview.description.or(Some(content)),
            "og:site_name" => preview.site_name = preview.site_name.or(Some(content)),
            "og:image" | "og:image:url" | "twitter:image" => preview.image = preview.image.or(Some(content)),
            _ => {}
        }
    }
    if preview.title.is_none() {
        let title = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title regex");
        preview.title = title.captures(head).map(|c| decode_entities(c[1].trim())).filter(|t| !t.is_empty());
    }
    let shorten = |s: String, n: usize| if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s };
    preview.title = preview.title.map(|t| shorten(t, 160));
    preview.description = preview.description.map(|d| shorten(d, 300));
    preview
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestStatus {
    pub number: Option<u64>,
    pub title: Option<String>,
    /// `OPEN` | `CLOSED` | `MERGED`
    pub state: Option<String>,
    pub draft: bool,
    pub checks_total: u32,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
}

/// A pull request's state and CI checks through the GitHub CLI (`gh pr view`),
/// using the user's own gh sign-in. Errors when gh is missing or signed out.
#[tauri::command]
pub async fn chat_pr_status(url: String) -> Result<PullRequestStatus, String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Not a pull request link".to_string())?;
    if parsed.host_str() != Some("github.com") || !parsed.path().contains("/pull/") {
        return Err("Not a GitHub pull request".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("gh");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd
            .args(["pr", "view", &url, "--json", "number,title,state,isDraft,statusCheckRollup"])
            .output()
            .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "GitHub CLI (gh) is not installed".to_string() } else { e.to_string() })?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() { "gh could not read the pull request".to_string() } else { err });
        }
        let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        Ok(pr_status_from(&v))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pr_status_from(v: &Value) -> PullRequestStatus {
    let mut status = PullRequestStatus {
        number: v.get("number").and_then(Value::as_u64),
        title: v.get("title").and_then(Value::as_str).map(str::to_string),
        state: v.get("state").and_then(Value::as_str).map(str::to_string),
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        ..Default::default()
    };
    for check in v.get("statusCheckRollup").and_then(Value::as_array).into_iter().flatten() {
        status.checks_total += 1;
        // CheckRun: status + conclusion. StatusContext: state.
        let conclusion = check
            .get("conclusion")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| check.get("state").and_then(Value::as_str))
            .unwrap_or("")
            .to_ascii_uppercase();
        match conclusion.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => status.checks_passed += 1,
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => status.checks_failed += 1,
            _ => status.checks_pending += 1,
        }
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_file_matches() {
        assert!(file_match_score("src/lib/App.tsx", "app.tsx").unwrap() > file_match_score("src/lib/AppShell.tsx", "app.tsx").unwrap_or(i64::MIN));
        assert!(file_match_score("src/lib/AppShell.tsx", "apsh").is_some());
        assert!(file_match_score("src/lib/AppShell.tsx", "zzz").is_none());
    }

    #[test]
    fn reads_skill_frontmatter() {
        let folded = "---\nname: orca-cli\ndescription: >-\n  Operate worktrees\n  and terminals.\nuser-invocable: false\n---\nbody";
        let m = frontmatter(folded);
        assert_eq!(m.get("name").map(String::as_str), Some("orca-cli"));
        assert_eq!(m.get("description").map(String::as_str), Some("Operate worktrees and terminals."));
        assert_eq!(m.get("user-invocable").map(String::as_str), Some("false"));
        let quoted = frontmatter("---\nname: \"imagegen\"\ndescription: \"Make images\"\n---\n");
        assert_eq!(quoted.get("name").map(String::as_str), Some("imagegen"));
        assert_eq!(quoted.get("description").map(String::as_str), Some("Make images"));
        assert!(frontmatter("no frontmatter").is_empty());
    }

    #[test]
    fn lists_project_skills_and_commands() {
        let dir = std::env::temp_dir().join(format!("spacron-skills-{}", std::process::id()));
        let skill = dir.join(".claude").join("skills").join("ship");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: ship\ndescription: Ship it\n---\n").unwrap();
        let hidden = dir.join(".claude").join("skills").join("quiet");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("SKILL.md"), "---\nname: quiet\nuser-invocable: false\n---\n").unwrap();
        let commands = dir.join(".claude").join("commands").join("git");
        std::fs::create_dir_all(&commands).unwrap();
        std::fs::write(commands.join("pr.md"), "# Open a pull request\nDo it.").unwrap();
        let found = list_skills("claude", &dir);
        let ship = found.iter().find(|s| s.name == "/ship").expect("project skill");
        assert_eq!((ship.kind.as_str(), ship.source.as_str(), ship.description.as_str()), ("skill", "project", "Ship it"));
        assert!(!found.iter().any(|s| s.name == "/quiet"));
        let pr = found.iter().find(|s| s.name == "/git:pr").expect("nested command");
        assert_eq!(pr.description, "Open a pull request");
        let codex_dir = dir.join(".agents").join("skills").join("lint");
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("SKILL.md"), "---\nname: lint\ndescription: Lint\n---\n").unwrap();
        assert!(list_skills("codex", &dir).iter().any(|s| s.name == "$lint" && s.insert == "$lint "));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_claude_command_descriptors() {
        let commands = vec![
            serde_json::json!({"name": "orca-cli", "description": "Operate Orca. (user)"}),
            serde_json::json!({"name": "ship", "description": "Ship it (project)"}),
            serde_json::json!({"name": "design:ux-copy", "description": "Write copy", "aliases": ["ux-copy"]}),
            serde_json::json!({"name": "compact", "description": "Compact", "builtin": true}),
        ];
        let rows = claude_commands_from(&commands);
        let view: Vec<_> = rows.iter().map(|r| (r.name.as_str(), r.kind.as_str(), r.source.as_str(), r.description.as_str())).collect();
        assert_eq!(view, [
            ("/orca-cli", "skill", "user", "Operate Orca."),
            ("/ship", "skill", "project", "Ship it"),
            ("/design:ux-copy", "skill", "design", "Write copy"),
            ("/compact", "builtin", "builtin", "Compact"),
        ]);
    }

    #[test]
    fn names_font_families() {
        assert_eq!(font_family_from("Segoe UI Semibold Italic (TrueType)").as_deref(), Some("Segoe UI"));
        assert_eq!(font_family_from("Arial Black (TrueType)").as_deref(), Some("Arial"));
        assert_eq!(font_family_from("Cascadia Code").as_deref(), Some("Cascadia Code"));
        assert_eq!(font_family_from("Bold"), Some("Bold".into()));
    }

    #[test]
    fn every_agent_reads_shared_skills_and_pi_uses_its_prefix() {
        let dir = std::env::temp_dir().join(format!("spacron-shared-skills-{}", std::process::id()));
        let skill = dir.join(".agents").join("skills").join("lint");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: lint\ndescription: Lint\n---\n").unwrap();
        let grok_skill = dir.join(".grok").join("skills").join("deploy");
        std::fs::create_dir_all(&grok_skill).unwrap();
        std::fs::write(grok_skill.join("SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\n").unwrap();
        assert!(list_skills("grok", &dir).iter().any(|s| s.name == "/deploy"));
        assert!(list_skills("grok", &dir).iter().any(|s| s.name == "/lint"));
        assert!(list_skills("pi", &dir).iter().any(|s| s.name == "/skill:lint" && s.insert == "/skill:lint "));
        assert!(list_skills("copilot", &dir).iter().any(|s| s.name == "/lint"));
        assert!(list_skills("codex", &dir).iter().any(|s| s.name == "$lint"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `cargo test chat_extras::tests::smoke -- --ignored --nocapture`: real fonts and Claude commands.
    #[test]
    #[ignore]
    fn smoke_lists_fonts_and_claude_commands() {
        let fonts = font_families();
        println!("{} fonts, e.g. {:?}", fonts.len(), fonts.iter().take(12).collect::<Vec<_>>());
        let cwd = std::env::var("TRANSCRIPT_SMOKE_CWD").unwrap_or_else(|_| ".".into());
        match claude_command_probe("claude", &cwd) {
            Ok(rows) => println!("claude: {} rows, {} skills", rows.len(), rows.iter().filter(|r| r.kind == "skill").count()),
            Err(e) => println!("claude probe failed: {e}"),
        }
        for agent in ["codex", "grok", "opencode", "pi", "cursor", "copilot", "antigravity"] {
            println!("{agent}: {} skills", list_skills(agent, std::path::Path::new(&cwd)).len());
        }
    }

    #[test]
    fn refuses_private_hosts() {
        for host in ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "[::1]", "printer.local"] {
            assert!(is_private_host(host), "{host}");
        }
        assert!(!is_private_host("github.com"));
        assert!(!is_private_host("8.8.8.8"));
    }

    #[test]
    fn reads_meta_tags() {
        let html = r#"<html><head><title>Fallback</title><meta property="og:title" content="Hello &amp; welcome"><meta name='description' content='About it'><meta property="og:image" content="/i.png"></head><body></body></html>"#;
        let p = parse_link_preview(html);
        assert_eq!(p.title.as_deref(), Some("Hello & welcome"));
        assert_eq!(p.description.as_deref(), Some("About it"));
        assert_eq!(p.image.as_deref(), Some("/i.png"));
    }

    #[test]
    fn counts_checks() {
        let v = serde_json::json!({"number": 7, "state": "OPEN", "isDraft": false, "statusCheckRollup": [
            {"status": "COMPLETED", "conclusion": "SUCCESS"},
            {"status": "COMPLETED", "conclusion": "FAILURE"},
            {"status": "IN_PROGRESS", "conclusion": ""},
            {"state": "SUCCESS"}
        ]});
        let s = pr_status_from(&v);
        assert_eq!((s.checks_total, s.checks_passed, s.checks_failed, s.checks_pending), (4, 2, 1, 1));
    }
}
