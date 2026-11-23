//! Hands a bot run its connectors, whatever agent runs it.
//!
//! Claude Code takes `--mcp-config` and Codex takes `-c` overrides (both in
//! `bots.rs`). Every other CLI reads servers from a config file, so for those
//! the run writes the picked servers into the file that agent reads from its
//! working folder (the bot's own home), and puts the folder back as it was
//! when the run ends.
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

struct Dialect {
    /// Executable names (lower case, no extension) that read this file.
    exes: &'static [&'static str],
    /// Path relative to the agent's working folder.
    file: &'static str,
    /// The key the servers live under. Amp's really is the dotted string.
    section: &'static str,
    style: Style,
}

const DIALECTS: &[Dialect] = &[
    Dialect { exes: &["gemini"], file: ".gemini/settings.json", section: "mcpServers", style: Style::Standard },
    Dialect { exes: &["opencode"], file: "opencode.json", section: "mcp", style: Style::Opencode },
    Dialect { exes: &["cursor", "cursor-agent", "agent"], file: ".cursor/mcp.json", section: "mcpServers", style: Style::Standard },
    Dialect { exes: &["qwen"], file: ".qwen/settings.json", section: "mcpServers", style: Style::Qwen },
    Dialect { exes: &["kiro-cli"], file: ".kiro/settings/mcp.json", section: "mcpServers", style: Style::Untyped },
    Dialect { exes: &["amp"], file: ".amp/settings.json", section: "amp.mcpServers", style: Style::Untyped },
    Dialect { exes: &["devin"], file: ".devin/config.local.json", section: "mcpServers", style: Style::Devin },
];

/// For an agent with no row: the project `.mcp.json` several CLIs share.
const FALLBACK: Dialect = Dialect { exes: &[], file: ".mcp.json", section: "mcpServers", style: Style::Standard };

/// Agents whose connectors `bots.rs` already passes on the command line.
const HANDLED_ON_THE_COMMAND_LINE: &[&str] = &["claude", "codex"];

fn dialect_for(exe: &str) -> Option<&'static Dialect> {
    if HANDLED_ON_THE_COMMAND_LINE.contains(&exe) {
        return None;
    }
    Some(DIALECTS.iter().find(|d| d.exes.contains(&exe)).unwrap_or(&FALLBACK))
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
    let url = text("url")?;
    let headers = map("headers");
    // Spacron's own tools are served over SSE for Claude; the rest want the
    // streamable-HTTP twin (same port and token).
    let own = key == SPACRON_TOOLS_KEY;
    let url = if own { url.replacen("/sse?", "/mcp?", 1) } else { url.to_string() };
    let http = own || server.get("type").and_then(Value::as_str) != Some("sse");
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

/// Write the run's connectors where this agent will read them. Returns what to
/// undo afterwards, or `None` when the agent takes them another way or there
/// is nothing to write.
pub(crate) fn apply(cwd: &Path, exe: &str, run_file: Option<&Path>) -> Option<Guard> {
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
    let body = serde_json::to_string_pretty(&merged(original.as_deref(), dialect, &servers)).ok()?;
    std::fs::write(&file, body).ok()?;
    super::bots::restrict(&file);
    Some(Guard { file, original, created_under })
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
            let guard = apply(&work, exe, Some(&run)).unwrap_or_else(|| panic!("{exe}"));
            let v = read(file);
            assert!(v[section]["spacron-mcp"].to_string().contains("/mcp?token=t"), "{exe} gets the HTTP twin");
            guard.restore();
            assert!(!work.join(file).exists(), "{exe}: the file goes when the run ends");
        }
        assert!(!work.join(".gemini").exists(), "created folders go too");

        let g = apply(&work, "opencode", Some(&run)).unwrap();
        let v = read("opencode.json");
        assert_eq!(v["mcp"]["files"]["command"], json!(["npx", "-y", "pkg"]));
        assert_eq!(v["mcp"]["files"]["environment"]["K"], "v");
        assert_eq!(v["mcp"]["gmail"]["type"], "remote");
        g.restore();
        let g = apply(&work, "qwen", Some(&run)).unwrap();
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
        let g = apply(dir.path(), "gemini.exe", Some(&run)).unwrap();
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
        let g = apply(dir.path(), "some-new-agent", Some(&run)).unwrap();
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
}
