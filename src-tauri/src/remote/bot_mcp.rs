//! Hands a bot run its connectors, whatever agent runs it.
//!
//! Claude Code takes `--mcp-config` and Codex takes `-c` overrides (both in
//! `bots.rs`). Every other CLI reads servers from a config file, so for those
//! the run writes the picked servers into the file that agent reads from its
//! working folder (the bot's own home), and puts the folder back as it was
//! when the run ends.
//!
//! Not every file is JSON: grok reads a TOML table, and DeepSeek Harness takes a
//! YAML patch handed over with `--patch`. pi also needs `--approve` before it
//! will read a project's MCP file. Those are [`Kind`]s and extra launch flags.
//!
//! This is the one place that knows how agents differ. Supporting an agent that
//! is installed later is one row in [`DIALECTS`]; an agent with no row still
//! gets the shared `.mcp.json` convention ([`FALLBACK`]) rather than nothing.
//! The shapes are the ones the desktop already writes for its own agent panes
//! (`injectGeminiConfig` and friends in `mcpBridge.ts`) — keep the two in step.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::bots::SPACRON_TOOLS_KEY;

/// How one agent spells a server entry.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Style {
    /// `{command,args,env}` or `{type,url,headers}` — Claude's own shape.
    Standard,
    /// opencode: `type: local|remote`, argv as one array, explicit `enabled`.
    Opencode,
    /// Qwen Code: streamable HTTP is `httpUrl`, SSE is `url`.
    Qwen,
    /// Kiro and Amp: a bare `url`, no transport field.
    Untyped,
    /// Devin: the transport is named `transport`, not `type`.
    Devin,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    /// A JSON file with the servers under `section`.
    Json,
    /// grok: `[mcp_servers.<key>]` tables in `.grok/config.toml`.
    Toml,
    /// DeepSeek Harness: a patch file, passed with `--patch`.
    DshPatch,
}

struct Dialect {
    /// Executable names (lower case, no extension) that read this file.
    exes: &'static [&'static str],
    /// Path relative to the agent's working folder.
    file: &'static str,
    /// The key the servers live under. Amp's really is the dotted string.
    section: &'static str,
    style: Style,
    kind: Kind,
    /// Flags the agent needs before it will read the file, put before the prompt.
    flags: &'static [&'static str],
}

const fn json(exes: &'static [&'static str], file: &'static str, section: &'static str, style: Style) -> Dialect {
    Dialect { exes, file, section, style, kind: Kind::Json, flags: &[] }
}

const DIALECTS: &[Dialect] = &[
    json(&["gemini"], ".gemini/settings.json", "mcpServers", Style::Standard),
    json(&["opencode", "kilo"], "opencode.json", "mcp", Style::Opencode),
    json(&["cursor", "cursor-agent", "agent"], ".cursor/mcp.json", "mcpServers", Style::Standard),
    json(&["qwen"], ".qwen/settings.json", "mcpServers", Style::Qwen),
    json(&["kiro-cli"], ".kiro/settings/mcp.json", "mcpServers", Style::Untyped),
    json(&["amp"], ".amp/settings.json", "amp.mcpServers", Style::Untyped),
    json(&["devin"], ".devin/config.local.json", "mcpServers", Style::Devin),
    // pi ignores a project's MCP file until the project is trusted; `--approve`
    // trusts it for this run only.
    Dialect { exes: &["pi"], file: ".pi/mcp.json", section: "mcpServers", style: Style::Untyped, kind: Kind::Json, flags: &["--approve"] },
    Dialect { exes: &["grok"], file: ".grok/config.toml", section: "", style: Style::Standard, kind: Kind::Toml, flags: &[] },
    // The patch is passed as `--patch <file>`; see `apply`.
    Dialect { exes: &["dsh"], file: ".spacron-bot-mcp.yml", section: "", style: Style::Standard, kind: Kind::DshPatch, flags: &[] },
];

/// For an agent with no row: the project `.mcp.json` several CLIs share.
const FALLBACK: Dialect = json(&[], ".mcp.json", "mcpServers", Style::Standard);

/// Agents that only read a global config file (`~/.factory/mcp.json`,
/// `~/.gemini/config/mcp_config.json`). Writing a project file would do nothing,
/// and a per-run edit of the user's global file is not ours to make: the desktop
/// keeps those in sync with Settings > MCP, so they get every connector there,
/// not the bot's picks.
const GLOBAL_ONLY: &[&str] = &["droid", "agy"];

/// Agents whose connectors `bots.rs` already passes on the command line.
const HANDLED_ON_THE_COMMAND_LINE: &[&str] = &["claude", "codex"];

fn dialect_for(exe: &str) -> Option<&'static Dialect> {
    if HANDLED_ON_THE_COMMAND_LINE.contains(&exe) || GLOBAL_ONLY.contains(&exe) {
        return None;
    }
    Some(DIALECTS.iter().find(|d| d.exes.contains(&exe)).unwrap_or(&FALLBACK))
}

/// A remote server's address and whether it speaks streamable HTTP (else SSE).
/// Spacron's own tools are served over SSE for Claude; the rest want the HTTP
/// twin (same port and token).
fn remote(key: &str, server: &Value) -> Option<(String, bool)> {
    let url = server.get("url").and_then(Value::as_str).map(str::trim).filter(|u| !u.is_empty())?;
    let own = key == SPACRON_TOOLS_KEY;
    let url = if own { url.replacen("/sse?", "/mcp?", 1) } else { url.to_string() };
    let http = own || server.get("type").and_then(Value::as_str) != Some("sse");
    Some((url, http))
}

/// A string as a TOML basic string (JSON's escapes are valid TOML).
fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Bare names only; anything else is skipped rather than escaped.
fn plain_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// grok's `.grok/config.toml`: the file's own text with a table per run server
/// appended. There is no TOML parser here, so a name the file already defines
/// is left alone rather than redefined (a duplicate table is a parse error).
fn grok_toml(existing: Option<&str>, servers: &Map<String, Value>) -> String {
    let mut out = existing.unwrap_or("").to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for (key, server) in servers {
        if !plain_key(key) || out.contains(&format!("[mcp_servers.{key}]")) {
            continue;
        }
        let pairs = |name: &str| -> Vec<String> {
            server.get(name).and_then(Value::as_object).into_iter().flatten()
                .filter_map(|(k, v)| v.as_str().map(|v| format!("{} = {}\n", quoted(k), quoted(v)))).collect()
        };
        let mut block = format!("[mcp_servers.{key}]\n");
        if let Some(command) = server.get("command").and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()) {
            let args: Vec<String> = server.get("args").and_then(Value::as_array).into_iter().flatten()
                .filter_map(Value::as_str).map(quoted).collect();
            block += &format!("command = {}\nargs = [{}]\nenabled = true\n", quoted(command), args.join(", "));
            let env = pairs("env");
            if !env.is_empty() {
                block += &format!("\n[mcp_servers.{key}.env]\n{}", env.concat());
            }
        } else if let Some((url, true)) = remote(key, server) {
            block += &format!("url = {}\nenabled = true\n", quoted(&url));
            let headers = pairs("headers");
            if !headers.is_empty() {
                block += &format!("\n[mcp_servers.{key}.headers]\n{}", headers.concat());
            }
        } else {
            continue;
        }
        out.push('\n');
        out.push_str(&block);
    }
    out
}

/// A DeepSeek Harness patch that inserts one MCP client per run server. Each
/// config is a JSON flow mapping, which YAML reads as-is. A failed connection
/// must not stop an unattended run.
fn dsh_patch(servers: &Map<String, Value>) -> String {
    let mut out = String::from("# Written by Spacron for one bot run; removed afterwards.\n- insert:\n");
    for (key, server) in servers {
        if !plain_key(key) {
            continue;
        }
        let mut config = Map::new();
        config.insert("serverName".into(), json!(key));
        config.insert("failOnStartupError".into(), json!(false));
        if let Some(command) = server.get("command").and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()) {
            config.insert("transport".into(), json!("stdio"));
            config.insert("command".into(), json!(command));
            config.insert("args".into(), server.get("args").cloned().unwrap_or_else(|| json!([])));
            if let Some(env) = server.get("env").filter(|e| e.as_object().is_some_and(|m| !m.is_empty())) {
                config.insert("env".into(), env.clone());
            }
        } else if let Some((url, true)) = remote(key, server) {
            config.insert("transport".into(), json!("streamable-http"));
            config.insert("url".into(), json!(url));
            if let Some(h) = server.get("headers").filter(|h| h.as_object().is_some_and(|m| !m.is_empty())) {
                config.insert("headers".into(), h.clone());
            }
        } else {
            continue;
        }
        out += &format!("    - id: spacron-bot-{key}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: {}\n", Value::Object(config));
    }
    out
}

/// One server in the run file (Claude's shape) as this agent spells it, or
/// `None` when it has neither a command nor a URL.
fn entry(key: &str, server: &Value, style: Style) -> Option<Value> {
    let text = |name: &str| server.get(name).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let map = |name: &str| server.get(name).and_then(Value::as_object).filter(|m| !m.is_empty()).cloned();
    if let Some(command) = text("command") {
        let args: Vec<Value> = server.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
        let env = map("env");
        return Some(match style {
            Style::Opencode => {
                let mut argv = vec![json!(command)];
                argv.extend(args);
                let mut e = json!({ "type": "local", "command": argv, "enabled": true });
                if let Some(env) = env {
                    e["environment"] = Value::Object(env);
                }
                e
            }
            _ => {
                let mut e = json!({ "command": command, "args": args });
                if let Some(env) = env {
                    e["env"] = Value::Object(env);
                }
                if style == Style::Devin {
                    e["transport"] = json!("stdio");
                }
                e
            }
        });
    }
    let headers = map("headers");
    let (url, http) = remote(key, server)?;
    let mut e = match style {
        Style::Standard => json!({ "type": if http { "http" } else { "sse" }, "url": url }),
        Style::Opencode => json!({ "type": "remote", "url": url, "enabled": true }),
        Style::Qwen => {
            let mut m = Map::new();
            m.insert((if http { "httpUrl" } else { "url" }).to_string(), json!(url));
            Value::Object(m)
        }
        Style::Untyped => json!({ "url": url }),
        Style::Devin => json!({ "url": url, "transport": if http { "http" } else { "sse" } }),
    };
    if let Some(headers) = headers {
        e["headers"] = Value::Object(headers);
    }
    Some(e)
}

/// What to undo when the run ends.
pub(crate) struct Guard {
    file: PathBuf,
    /// The file's content before the run, or `None` if there was none.
    original: Option<String>,
    /// The folder this run created (the topmost one), so an empty `.gemini/` goes.
    created_under: Option<PathBuf>,
}

impl Guard {
    pub(crate) fn restore(self) {
        match &self.original {
            Some(text) => {
                let _ = std::fs::write(&self.file, text);
            }
            None => {
                let _ = std::fs::remove_file(&self.file);
                if let Some(top) = &self.created_under {
                    // `remove_dir` only removes a folder that is now empty.
                    let mut dir = self.file.parent();
                    while let Some(d) = dir {
                        if std::fs::remove_dir(d).is_err() || d == top {
                            break;
                        }
                        dir = d.parent();
                    }
                }
            }
        }
    }
}

/// The agent's config body: its existing file with the run's servers set over
/// the section, so the user's own entries in that file survive.
fn merged(existing: Option<&str>, dialect: &Dialect, servers: &Map<String, Value>) -> Value {
    let mut root = existing
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let mut section = root.get(dialect.section).and_then(Value::as_object).cloned().unwrap_or_default();
    for (key, server) in servers {
        if let Some(e) = entry(key, server, dialect.style) {
            section.insert(key.clone(), e);
        }
    }
    root[dialect.section] = Value::Object(section);
    root
}

/// What `apply` did: what to undo afterwards, and the launch flags to add
/// before the prompt.
pub(crate) struct Applied {
    pub(crate) guard: Guard,
    pub(crate) flags: Vec<String>,
}

/// Write the run's connectors where this agent will read them. `None` when the
/// agent takes them another way or there is nothing to write.
pub(crate) fn apply(cwd: &Path, exe: &str, run_file: Option<&Path>) -> Option<Applied> {
    let exe = Path::new(exe).file_stem()?.to_str()?.to_ascii_lowercase();
    let dialect = dialect_for(&exe)?;
    let servers = std::fs::read_to_string(run_file?).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())?
        .get("mcpServers")?.as_object()?.clone();
    if servers.is_empty() {
        return None;
    }
    let file = cwd.join(dialect.file);
    let original = std::fs::read_to_string(&file).ok();
    let created_under = {
        let mut top = None;
        let mut dir = file.parent();
        while let Some(d) = dir {
            if d.exists() || d == cwd {
                break;
            }
            top = Some(d.to_path_buf());
            dir = d.parent();
        }
        top
    };
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    let body = match dialect.kind {
        Kind::Json => serde_json::to_string_pretty(&merged(original.as_deref(), dialect, &servers)).ok()?,
        Kind::Toml => grok_toml(original.as_deref(), &servers),
        Kind::DshPatch => dsh_patch(&servers),
    };
    std::fs::write(&file, body).ok()?;
    super::bots::restrict(&file);
    let mut flags: Vec<String> = dialect.flags.iter().map(|f| f.to_string()).collect();
    if dialect.kind == Kind::DshPatch {
        flags.extend(["--patch".to_string(), file.to_string_lossy().to_string()]);
    }
    Some(Applied { guard: Guard { file, original, created_under }, flags })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_file(dir: &Path) -> PathBuf {
        let path = dir.join("run.json");
        std::fs::write(&path, json!({ "mcpServers": {
            "spacron-mcp": { "type": "sse", "url": "http://127.0.0.1:9/sse?token=t" },
            "gmail": { "type": "http", "url": "https://x/mcp", "headers": { "A": "b" } },
            "files": { "command": "npx", "args": ["-y", "pkg"], "env": { "K": "v" } },
        } }).to_string()).unwrap();
        path
    }

    #[test]
    fn each_dialect_spells_servers_its_own_way() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_file(dir.path());
        let work = dir.path().join("home");
        std::fs::create_dir_all(&work).unwrap();
        let read = |f: &str| serde_json::from_str::<Value>(&std::fs::read_to_string(work.join(f)).unwrap()).unwrap();

        for (exe, file, section) in [("gemini", ".gemini/settings.json", "mcpServers"), ("opencode", "opencode.json", "mcp"),
                                     ("qwen", ".qwen/settings.json", "mcpServers"), ("amp", ".amp/settings.json", "amp.mcpServers")] {
            let guard = apply(&work, exe, Some(&run)).unwrap_or_else(|| panic!("{exe}")).guard;
            let v = read(file);
            assert!(v[section]["spacron-mcp"].to_string().contains("/mcp?token=t"), "{exe} gets the HTTP twin");
            guard.restore();
            assert!(!work.join(file).exists(), "{exe}: the file goes when the run ends");
        }
        assert!(!work.join(".gemini").exists(), "created folders go too");

        let g = apply(&work, "opencode", Some(&run)).unwrap().guard;
        let v = read("opencode.json");
        assert_eq!(v["mcp"]["files"]["command"], json!(["npx", "-y", "pkg"]));
        assert_eq!(v["mcp"]["files"]["environment"]["K"], "v");
        assert_eq!(v["mcp"]["gmail"]["type"], "remote");
        g.restore();
        let g = apply(&work, "qwen", Some(&run)).unwrap().guard;
        assert!(read(".qwen/settings.json")["mcpServers"]["spacron-mcp"].get("httpUrl").is_some());
        g.restore();
    }

    #[test]
    fn an_existing_file_is_merged_and_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_file(dir.path());
        let file = dir.path().join(".gemini/settings.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let before = r#"{"theme":"dark","mcpServers":{"mine":{"command":"x"}}}"#;
        std::fs::write(&file, before).unwrap();
        let g = apply(dir.path(), "gemini.exe", Some(&run)).unwrap().guard;
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert!(v["mcpServers"]["mine"].is_object() && v["mcpServers"]["gmail"].is_object());
        g.restore();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
    }

    #[test]
    fn an_agent_with_no_row_gets_the_shared_mcp_json() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_file(dir.path());
        let g = apply(dir.path(), "some-new-agent", Some(&run)).unwrap().guard;
        assert!(dir.path().join(".mcp.json").exists());
        g.restore();
        assert!(!dir.path().join(".mcp.json").exists());
    }

    #[test]
    fn claude_and_codex_take_theirs_on_the_command_line() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_file(dir.path());
        assert!(apply(dir.path(), "claude", Some(&run)).is_none());
        assert!(apply(dir.path(), "codex", Some(&run)).is_none());
        assert!(apply(dir.path(), "gemini", None).is_none(), "no connectors, nothing written");
    }

    #[test]
    fn grok_gets_toml_tables_and_keeps_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_file(dir.path());
        let file = dir.path().join(".grok/config.toml");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "[mcp_servers.gmail]\nurl = \"mine\"\n").unwrap();
        let a = apply(dir.path(), "grok", Some(&run)).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("url = \"mine\"") && !text.contains("https://x/mcp"), "a name the file defines is left alone");
        assert!(text.contains("[mcp_servers.files]\ncommand = \"npx\"\nargs = [\"-y\", \"pkg\"]"));
        assert!(text.contains("[mcp_servers.files.env]\n\"K\" = \"v\""));
        assert!(text.contains("url = \"http://127.0.0.1:9/mcp?token=t\""));
        assert!(a.flags.is_empty());
        a.guard.restore();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[mcp_servers.gmail]\nurl = \"mine\"\n");
    }

    #[test]
    fn pi_is_told_to_trust_the_project_file_and_dsh_gets_a_patch() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_file(dir.path());
        let pi = apply(dir.path(), "pi", Some(&run)).unwrap();
        assert_eq!(pi.flags, ["--approve"]);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join(".pi/mcp.json")).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["gmail"]["url"], "https://x/mcp");
        pi.guard.restore();
        let dsh = apply(dir.path(), "dsh", Some(&run)).unwrap();
        assert_eq!(dsh.flags[0], "--patch");
        let yml = std::fs::read_to_string(&dsh.flags[1]).unwrap();
        assert!(yml.contains("id: spacron-bot-gmail") && yml.contains("\"transport\":\"streamable-http\""));
        assert!(yml.contains("\"transport\":\"stdio\"") && yml.contains("\"failOnStartupError\":false"));
        dsh.guard.restore();
        assert!(!dir.path().join(".spacron-bot-mcp.yml").exists());
    }

    #[test]
    fn agents_that_only_read_global_config_get_no_project_file() {
        let dir = tempfile::tempdir().unwrap();
        let run = run_file(dir.path());
        assert!(apply(dir.path(), "agy", Some(&run)).is_none());
        assert!(apply(dir.path(), "droid", Some(&run)).is_none());
    }
}
