//! Update checks and one-click updates for agent CLIs installed through npm.
//!
//! Only npm installs are handled, because only there can Spacron say both what
//! is installed and what a newer version is without guessing. A CLI counts as
//! npm-installed when the file on PATH is an npm bin shim whose package really
//! lists that command in `bin`:
//!
//! - **Windows:** the shim (`codex.cmd`) sits in the global prefix, beside
//!   `node_modules`, so the package is found by scanning that folder.
//! - **macOS/Linux:** the shim is a symlink into
//!   `<prefix>/lib/node_modules/<pkg>/…`, so the package is the nearest
//!   `package.json` above the link's target.
//!
//! A CLI installed any other way (winget, a Volta shim) is skipped rather than
//! "updated" through npm into a second copy the PATH never reaches. The one
//! exception is a CLI in [`SELF_UPDATERS`]: a native build that ships its own
//! update command (Claude Code's `claude update`). Spacron reads its version
//! from `--version`, compares it with the same release on npm, and runs that
//! command instead of npm. The install runs with `--prefix` set to the prefix the
//! shim was found in for the same reason: npm's configured prefix can differ
//! from the one on PATH (nvm, a moved `prefix`), and updating the other one
//! would report success while the agent kept its old version.
//!
//! One package serves both DeepSeek Harness modes: the web panel and the
//! headless worker both resolve the global `dsh` (see `deepseek_harness.rs`),
//! so updating it updates both. Its web panels are stopped first, because a
//! running `node` holds dsh's native modules open on Windows and npm then fails
//! half way with EBUSY.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

/// npm's own default. `NPM_CONFIG_REGISTRY` wins when the user exported one.
const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

/// Long enough for dsh (~600 packages, measured at ~3 minutes on a cold cache).
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Commands whose update is running, so a second click cannot start another
/// `npm install` into the same prefix.
static IN_FLIGHT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateInfo {
    pub command: String,
    pub package: String,
    pub installed: String,
    /// The version an update would install; `None` when the check failed.
    pub latest: Option<String>,
    pub update_available: bool,
}

/// Where an npm-installed CLI lives.
#[derive(Debug, Clone)]
struct NpmInstall {
    package: String,
    version: String,
    /// The global prefix the shim was found in, passed to `npm --prefix`.
    prefix: PathBuf,
}

/// A native CLI that updates itself. `package` is the npm package that
/// publishes the same version numbers, used only to learn the newest version.
#[derive(Debug)]
struct SelfUpdater {
    command: &'static str,
    package: &'static str,
    update_args: &'static [&'static str],
}

/// Checked 2026-09-24: `claude update` exists ("Check for updates and install
/// if available"), `claude --version` prints `2.1.281 (Claude Code)`, and the
/// npm tags carry the same numbers (`latest`, and `stable` for the stable
/// channel).
const SELF_UPDATERS: &[SelfUpdater] = &[SelfUpdater {
    command: "claude",
    package: "@anthropic-ai/claude-code",
    update_args: &["update"],
}];

/// A native install found through [`SELF_UPDATERS`].
#[derive(Debug, Clone)]
struct NativeInstall {
    exe: PathBuf,
    version: String,
    updater: &'static SelfUpdater,
}

#[derive(Debug, Clone)]
enum Install {
    Npm(NpmInstall),
    Native(NativeInstall),
}

impl Install {
    fn package(&self) -> &str {
        match self {
            Install::Npm(i) => &i.package,
            Install::Native(i) => i.updater.package,
        }
    }

    fn version(&self) -> &str {
        match self {
            Install::Npm(i) => &i.version,
            Install::Native(i) => &i.version,
        }
    }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim().trim_start_matches('v');
    let text = text.split('+').next()?; // build metadata never affects order
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, pre.split('.').map(str::to_string).collect()),
        None => (text, Vec::new()),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let version = Version {
        core: [parts.next()??, parts.next()??, parts.next()??],
        pre,
    };
    parts.next().is_none().then_some(version)
}

/// SemVer 2.0 precedence: a release outranks its prereleases; prerelease
/// identifiers compare numerically when both are numbers, a number sorts below
/// a word, and a longer list wins a tie.
fn compare_versions(a: &Version, b: &Version) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    a.core.cmp(&b.core).then_with(|| match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in a.pre.iter().zip(&b.pre) {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
            a.pre.len().cmp(&b.pre.len())
        }
    })
}

/// The version to offer, given the installed one and the package's dist-tags.
///
/// Someone on a stable release is only ever offered `latest`: a newer beta is
/// not an update they asked for. Someone already on a prerelease follows the
/// highest tagged version instead, because for them `latest` can be *older* —
/// DeepSeek Harness had `latest` at 0.1.5-rc.3 while 0.1.7-alpha.1 was the only
/// installable build. Tags with a `-` in the name are skipped: Codex publishes
/// per-platform tags (`win32-x64` → `0.156.1-win32-x64`) that out-rank the real
/// version under SemVer and are not meant to be installed by hand.
///
/// Returns `None` unless the choice is strictly newer, so this never downgrades.
fn pick_update(installed: &str, tags: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    let current = parse_version(installed)?;
    let candidates: Vec<&str> = if current.pre.is_empty() {
        tags.get("latest").and_then(|v| v.as_str()).into_iter().collect()
    } else {
        tags.iter()
            .filter(|(name, _)| !name.contains('-'))
            .filter_map(|(_, v)| v.as_str())
            .collect()
    };
    let best = candidates
        .into_iter()
        .filter_map(|text| parse_version(text).map(|v| (text, v)))
        .max_by(|(_, a), (_, b)| compare_versions(a, b))?;
    (compare_versions(&best.1, &current) == std::cmp::Ordering::Greater).then(|| best.0.to_string())
}

/// The version to offer a self-updating CLI: the tag its own channel follows,
/// when that is newer. Claude Code's `autoUpdatesChannel: "stable"` makes
/// `claude update` install the `stable` tag, so offering `latest` there would
/// promise a version the update never delivers.
fn pick_native_update(
    installed: &str,
    tags: &serde_json::Map<String, serde_json::Value>,
    channel: &str,
) -> Option<String> {
    let current = parse_version(installed)?;
    let text = tags.get(channel).or_else(|| tags.get("latest"))?.as_str()?;
    let target = parse_version(text)?;
    (compare_versions(&target, &current) == std::cmp::Ordering::Greater).then(|| text.to_string())
}

/// The release channel Claude Code updates from: `stable` or `latest`.
fn claude_channel() -> String {
    dirs::home_dir()
        .map(|home| home.join(".claude").join("settings.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("autoUpdatesChannel")?.as_str().map(str::to_string))
        .filter(|channel| channel == "stable")
        .unwrap_or_else(|| "latest".to_string())
}

fn channel_for(updater: &SelfUpdater) -> String {
    if updater.command == "claude" {
        claude_channel()
    } else {
        "latest".to_string()
    }
}

/// How long a child's PATH may be. cmd.exe stops resolving commands once PATH
/// passes 8191 characters, and npm runs install scripts through cmd.exe after
/// prepending a `node_modules\.bin` for every ancestor of the package plus
/// node-gyp-bin — about 700 characters for dsh's `koffi` build. At the 8000
/// `search_path` allows, that build failed with "'node' is not recognized".
const CHILD_PATH_LIMIT: usize = 4000;

/// The PATH for a child: `node`'s own directory first, so install scripts run
/// the node npm itself runs on, then what a fresh terminal would have (a
/// desktop app's PATH is frozen at launch), cut to [`CHILD_PATH_LIMIT`].
fn child_path() -> Option<std::ffi::OsString> {
    let node_dir = crate::commands::agent_probe::which("node").and_then(|n| n.parent().map(Path::to_path_buf));
    let full = crate::commands::agent_probe::search_path();
    let mut seen = HashSet::new();
    let mut length = 0usize;
    let kept: Vec<PathBuf> = node_dir
        .into_iter()
        .chain(full.iter().flat_map(std::env::split_paths))
        .filter(|dir| seen.insert(dir.clone()))
        .take_while(|dir| {
            length += dir.as_os_str().len() + 1;
            length <= CHILD_PATH_LIMIT
        })
        .collect();
    std::env::join_paths(kept).ok()
}

/// A child with no window, piped output, and a PATH install scripts can shell
/// out to `node` from ([`child_path`]).
fn hidden_command(program: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = child_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The version a CLI prints for `--version`: its first token that parses.
async fn cli_version(exe: &Path) -> Option<String> {
    let mut cmd = hidden_command(exe);
    cmd.arg("--version");
    let output = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.split_whitespace()
        .map(|t| t.trim_start_matches('v'))
        .find(|t| parse_version(t).is_some())
        .map(str::to_string)
}

async fn find_native_install(command: &str) -> Option<NativeInstall> {
    let updater = SELF_UPDATERS.iter().find(|u| u.command == command)?;
    let exe = crate::commands::agent_probe::which(command)?;
    let version = cli_version(&exe).await?;
    Some(NativeInstall { exe, version, updater })
}

/// npm first (it says exactly which package and prefix), then a native
/// self-updater.
async fn find_install(command: &str) -> Option<Install> {
    let lookup = command.to_string();
    if let Some(npm) = tokio::task::spawn_blocking(move || find_npm_install(&lookup)).await.ok().flatten() {
        return Some(Install::Npm(npm));
    }
    find_native_install(command).await.map(Install::Native)
}

fn pick_for(install: &Install, tags: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    match install {
        Install::Npm(i) => pick_update(&i.version, tags),
        Install::Native(i) => pick_native_update(&i.version, tags, &channel_for(i.updater)),
    }
}

// ---------------------------------------------------------------------------
// Finding the install
// ---------------------------------------------------------------------------

fn read_manifest(dir: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Whether a package.json's `bin` provides `command`. A string `bin` is named
/// after the package (without its scope), which is npm's own rule.
fn manifest_provides(manifest: &serde_json::Value, command: &str) -> bool {
    match manifest.get("bin") {
        Some(serde_json::Value::Object(map)) => map.contains_key(command),
        Some(serde_json::Value::String(_)) => manifest
            .get("name")
            .and_then(|n| n.as_str())
            .map(|name| name.rsplit('/').next() == Some(command))
            .unwrap_or(false),
        _ => false,
    }
}

fn install_from_manifest(manifest: &serde_json::Value, prefix: PathBuf) -> Option<NpmInstall> {
    Some(NpmInstall {
        package: manifest.get("name")?.as_str()?.to_string(),
        version: manifest.get("version")?.as_str()?.to_string(),
        prefix,
    })
}

/// Scan `<node_modules>` (and its `@scope` folders) for the package that
/// provides `command`.
fn scan_node_modules(node_modules: &Path, command: &str) -> Option<serde_json::Value> {
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(node_modules).ok()?.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('@') {
            if let Ok(scoped) = std::fs::read_dir(&path) {
                dirs.extend(scoped.flatten().map(|e| e.path()));
            }
        } else if !name.starts_with('.') {
            dirs.push(path);
        }
    }
    dirs.into_iter()
        .filter_map(|dir| read_manifest(&dir))
        .find(|manifest| manifest_provides(manifest, command))
}

fn find_npm_install(command: &str) -> Option<NpmInstall> {
    let shim = crate::commands::agent_probe::which(command)?;
    let shim_dir = shim.parent()?.to_path_buf();

    // Windows layout: the prefix holds the shims and `node_modules` side by side.
    let beside = shim_dir.join("node_modules");
    if beside.is_dir() {
        if let Some(manifest) = scan_node_modules(&beside, command) {
            return install_from_manifest(&manifest, shim_dir);
        }
    }

    // Unix layout: `<prefix>/bin/<cmd>` links into `<prefix>/lib/node_modules`.
    let target = std::fs::canonicalize(&shim).ok()?;
    let mut dir = target.parent();
    while let Some(current) = dir {
        if let Some(manifest) = read_manifest(current) {
            if !manifest_provides(&manifest, command) {
                return None;
            }
            // `<prefix>/lib/node_modules/<pkg>` or `…/@scope/<pkg>`.
            let node_modules = current
                .ancestors()
                .find(|p| p.file_name().is_some_and(|n| n == "node_modules"))?;
            let lib = node_modules.parent()?;
            if lib.file_name().is_none_or(|n| n != "lib") {
                return None;
            }
            return install_from_manifest(&manifest, lib.parent()?.to_path_buf());
        }
        dir = current.parent();
    }
    None
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

fn registry_base() -> String {
    std::env::var("NPM_CONFIG_REGISTRY")
        .or_else(|_| std::env::var("npm_config_registry"))
        .ok()
        .filter(|r| r.starts_with("http"))
        .unwrap_or_else(|| DEFAULT_REGISTRY.to_string())
        .trim_end_matches('/')
        .to_string()
}

async fn fetch_dist_tags(
    client: &reqwest::Client,
    package: &str,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let url = format!("{}/-/package/{}/dist-tags", registry_base(), package.replace('/', "%2f"));
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    match response.json::<serde_json::Value>().await.ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Check each command. Commands Spacron cannot update are left out of the
/// answer entirely, so "no row" means "Spacron cannot update this one".
#[tauri::command]
pub async fn agent_updates_check(commands: Vec<String>) -> Vec<AgentUpdateInfo> {
    let mut seen = HashSet::new();
    let commands: Vec<String> = commands.into_iter().filter(|c| seen.insert(c.clone())).collect();
    let installs: Vec<(String, Install)> = futures_util::future::join_all(
        commands.into_iter().map(|c| async move { find_install(&c).await.map(|i| (c, i)) }),
    )
    .await
    .into_iter()
    .flatten()
    .collect();

    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("spacron-agent-updates")
        .build()
    else {
        return Vec::new();
    };

    let checks = installs.into_iter().map(|(command, install)| {
        let client = client.clone();
        async move {
            let latest = fetch_dist_tags(&client, install.package()).await;
            let target = latest.as_ref().and_then(|tags| pick_for(&install, tags));
            AgentUpdateInfo {
                command,
                package: install.package().to_string(),
                update_available: target.is_some(),
                latest: target.or_else(|| latest.map(|_| install.version().to_string())),
                installed: install.version().to_string(),
            }
        }
    });
    futures_util::future::join_all(checks).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateResult {
    pub package: String,
    pub from: String,
    pub to: String,
    /// Something the user should know about a successful update, such as a
    /// companion process that could not be brought along.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

struct InFlightGuard(String);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(set) = guard.as_mut() {
            set.remove(&self.0);
        }
    }
}

/// npm's JS entry beside the `npm` shim, run with `node` directly. Spawning the
/// `.cmd` shim on Windows needs cmd.exe (see [[windows-pathext-shims]]); `node`
/// plus `npm-cli.js` needs nothing but the two paths.
fn npm_invocation() -> Result<(PathBuf, Vec<PathBuf>), String> {
    let missing = || "npm was not found on this machine, so Spacron cannot update this agent.".to_string();
    let npm = crate::commands::agent_probe::which("npm").ok_or_else(missing)?;
    let npm_dir = std::fs::canonicalize(&npm)
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| npm.parent().map(Path::to_path_buf).unwrap_or_default());
    let candidates = [
        npm.parent().map(|d| d.join("node_modules").join("npm").join("bin").join("npm-cli.js")),
        Some(npm_dir.join("npm-cli.js")),
    ];
    let node = crate::commands::agent_probe::which("node");
    if let (Some(node), Some(cli)) = (node, candidates.into_iter().flatten().find(|p| p.is_file())) {
        return Ok((node, vec![cli]));
    }
    #[cfg(windows)]
    {
        Err(missing())
    }
    #[cfg(not(windows))]
    {
        Ok((npm, Vec::new()))
    }
}

/// Install the newest version of the CLI behind `command`, in a process with no
/// window: `npm install -g` for an npm install, the CLI's own update command
/// for a native one. Everything is re-derived here from the command, so the
/// frontend cannot steer which package or version gets installed.
#[tauri::command]
pub async fn agent_update_install(command: String) -> Result<AgentUpdateResult, String> {
    let install = find_install(&command)
        .await
        .ok_or_else(|| format!("`{command}` is not an install Spacron can update."))?;
    let package = install.package().to_string();
    let from = install.version().to_string();

    {
        let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if !guard.get_or_insert_with(HashSet::new).insert(command.clone()) {
            return Err(format!("{package} is already updating."));
        }
    }
    let _in_flight = InFlightGuard(command.clone());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("spacron-agent-updates")
        .build()
        .map_err(|e| e.to_string())?;
    let tags = fetch_dist_tags(&client, &package)
        .await
        .ok_or_else(|| format!("Could not reach the npm registry for {package}."))?;
    let target =
        pick_for(&install, &tags).ok_or_else(|| format!("{package} {from} is already the newest version."))?;

    match install {
        Install::Npm(npm) => install_npm(&command, npm, target).await,
        Install::Native(native) => install_native(native, target).await,
    }
}

async fn run_hidden(mut cmd: tokio::process::Command, what: &str) -> Result<std::process::Output, String> {
    let child = cmd.spawn().map_err(|e| format!("Could not start {what}: {e}"))?;
    tokio::time::timeout(INSTALL_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("The update took longer than 15 minutes, so {what} was stopped."))?
        .map_err(|e| format!("{what} did not finish: {e}"))
}

async fn install_native(native: NativeInstall, target: String) -> Result<AgentUpdateResult, String> {
    let mut cmd = hidden_command(&native.exe);
    cmd.args(native.updater.update_args);
    let what = format!("`{} {}`", native.updater.command, native.updater.update_args.join(" "));
    let output = run_hidden(cmd, &what).await?;

    // The CLI's own report is not the answer; its version afterwards is.
    let now = cli_version(&native.exe).await;
    let moved = now
        .as_deref()
        .and_then(parse_version)
        .zip(parse_version(&native.version))
        .is_some_and(|(now, before)| compare_versions(&now, &before) == std::cmp::Ordering::Greater);
    if moved {
        return Ok(AgentUpdateResult {
            package: native.updater.package.to_string(),
            from: native.version,
            to: now.unwrap_or(target),
            warning: None,
        });
    }
    let said = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let said: Vec<&str> = said.lines().map(str::trim).filter(|l| !l.is_empty()).take(6).collect();
    let mut message = format!("{what} finished, but {} is still at {}.", native.updater.command, native.version);
    if !said.is_empty() {
        message.push('\n');
        message.push_str(&said.join("\n"));
    }
    Err(message)
}

/// A CLI that runs a long-lived daemon of its own. The daemon is the same
/// installed binary, so while it runs it keeps serving the old version and, on
/// Windows, keeps the files locked, which fails `npm install` with EBUSY.
/// Stopped before the update and started again after it.
///
/// Codex is not here: its daemon is a separate, self-managed copy with its own
/// updater, handled by `chatgpt::sync_daemon`.
struct CompanionDaemon {
    command: &'static str,
    status: &'static [&'static str],
    /// Printed by `status` when no daemon is running.
    not_running: &'static str,
    stop: &'static [&'static str],
    start: &'static [&'static str],
}

/// Checked 2026-09-26 with kilo 7.7.9: `daemon start` detaches and returns,
/// `daemon status` prints `version: <v>` while running and
/// `kilo daemon not running` otherwise.
const COMPANION_DAEMONS: &[CompanionDaemon] = &[CompanionDaemon {
    command: "kilo",
    status: &["daemon", "status"],
    not_running: "not running",
    stop: &["daemon", "stop"],
    start: &["daemon", "start"],
}];

const DAEMON_CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// The npm shim for `command` under `prefix`, as a runnable command: on
/// Windows the `.cmd` must go through `cmd.exe` (see windows-pathext-shims).
fn npm_shim_command(prefix: &Path, command: &str, args: &[&str]) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let shim = prefix.join(format!("{command}.cmd"));
        let mut cmd = hidden_command(Path::new("cmd.exe"));
        // Every argument is compile-time fixed; `/S` plus one outer pair of
        // quotes keeps a prefix with spaces intact.
        cmd.raw_arg(format!("/D /S /C \"\"{}\" {}\"", shim.display(), args.join(" ")));
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = hidden_command(&prefix.join("bin").join(command));
        cmd.args(args);
        cmd
    }
}

async fn run_daemon_call(prefix: &Path, command: &str, args: &[&str]) -> Option<String> {
    let mut cmd = npm_shim_command(prefix, command, args);
    let out = tokio::time::timeout(DAEMON_CALL_TIMEOUT, cmd.output()).await.ok()?.ok()?;
    Some(format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// Stop the CLI's daemon if one is running. True when it was running, so the
/// caller starts it again after the update.
async fn stop_companion_daemon(prefix: &Path, command: &str) -> bool {
    let Some(daemon) = COMPANION_DAEMONS.iter().find(|d| d.command == command) else { return false };
    let Some(status) = run_daemon_call(prefix, command, daemon.status).await else { return false };
    if status.contains(daemon.not_running) {
        return false;
    }
    run_daemon_call(prefix, command, daemon.stop).await;
    true
}

/// Start the daemon again and confirm it came back on `target`. A warning for
/// the user when it did not.
async fn restart_companion_daemon(prefix: &Path, command: &str, target: &str) -> Option<String> {
    let daemon = COMPANION_DAEMONS.iter().find(|d| d.command == command)?;
    run_daemon_call(prefix, command, daemon.start).await;
    let status = run_daemon_call(prefix, command, daemon.status).await.unwrap_or_default();
    let fix = format!("Run `{command} {}` in a terminal.", daemon.start.join(" "));
    if status.contains(daemon.not_running) || status.trim().is_empty() {
        return Some(format!("{command} was updated to {target}, but its background daemon did not start again.\n{fix}"));
    }
    let running = status.lines().find_map(|l| l.trim().strip_prefix("version:").map(|v| v.trim().to_string()));
    match running {
        Some(v) if v != target => Some(format!(
            "{command} was updated to {target}, but its background daemon is still on {v}.\nRun `{command} {}` then `{command} {}` in a terminal.",
            daemon.stop.join(" "),
            daemon.start.join(" ")
        )),
        _ => None,
    }
}

async fn install_npm(command: &str, install: NpmInstall, target: String) -> Result<AgentUpdateResult, String> {
    if command == "dsh" {
        crate::commands::deepseek_harness::shutdown_all();
    }
    // Spacron's own ChatGPT brain runs this codex.exe and would hold it locked.
    if command == "codex" {
        crate::commands::chatgpt::release_for_update();
    }

    let restart_daemon = stop_companion_daemon(&install.prefix, command).await;

    let (program, lead) = npm_invocation()?;
    let mut cmd = hidden_command(&program);
    cmd.args(&lead)
        .args(["install", "--global", "--no-audit", "--no-fund", "--prefix"])
        .arg(&install.prefix)
        .arg(format!("{}@{}", install.package, target));
    let output = run_hidden(cmd, "npm").await?;

    if !output.status.success() {
        // Put the daemon back as it was: a failed update must not leave it off.
        if restart_daemon {
            restart_companion_daemon(&install.prefix, command, &install.version).await;
        }
        return Err(npm_failure(&output.stderr, &output.stdout));
    }

    // Trust the manifest on disk over npm's exit code: a zero exit that left
    // the old version in place is still a failed update.
    let lookup = command.to_string();
    let now = tokio::task::spawn_blocking(move || find_npm_install(&lookup))
        .await
        .ok()
        .flatten()
        .map(|i| i.version);
    match now {
        Some(version) if version == target => {
            // Codex keeps a second, self-managed copy of itself running as a
            // daemon that npm does not touch; bring it along.
            let warning = if command == "codex" {
                crate::commands::chatgpt::sync_daemon(&target).await.err()
            } else if restart_daemon {
                restart_companion_daemon(&install.prefix, command, &target).await
            } else {
                None
            };
            Ok(AgentUpdateResult { package: install.package, from: install.version, to: target, warning })
        }
        Some(version) => {
            if restart_daemon {
                restart_companion_daemon(&install.prefix, command, &version).await;
            }
            Err(format!("npm finished, but {} is still at {version} instead of {target}.", install.package))
        }
        None => Err(format!("npm finished, but {} is no longer found on PATH.", install.package)),
    }
}

/// The part of npm's output worth showing: its `npm error` lines, with the log
/// path and blank lines dropped, capped so a card stays readable.
fn npm_failure(stderr: &[u8], stdout: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = if text.trim().is_empty() { String::from_utf8_lossy(stdout) } else { text };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains("A complete log of this run"))
        .filter(|l| l.starts_with("npm error") || l.starts_with("npm ERR!"))
        .take(6)
        .collect();
    let detail = if lines.is_empty() {
        text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("npm failed").trim().to_string()
    } else {
        lines.join("\n")
    };
    if detail.contains("EBUSY") || detail.contains("EPERM") {
        format!("{detail}\nA running copy of the agent is probably holding its files open. Close its terminals and try again.")
    } else {
        detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(pairs: &[(&str, &str)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
            .collect()
    }

    #[test]
    fn prerelease_orders_below_release_and_by_identifier() {
        let order = ["0.1.5-rc.3", "0.1.7-alpha.1", "0.1.7-alpha.2", "0.1.7-alpha.10", "0.1.7-rc.1", "0.1.7"];
        for pair in order.windows(2) {
            let a = parse_version(pair[0]).unwrap();
            let b = parse_version(pair[1]).unwrap();
            assert_eq!(compare_versions(&a, &b), std::cmp::Ordering::Less, "{} < {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn stable_install_only_follows_latest() {
        let t = tags(&[("latest", "0.156.1"), ("alpha", "0.158.0-alpha.8")]);
        assert_eq!(pick_update("0.150.0", &t).as_deref(), Some("0.156.1"));
        assert_eq!(pick_update("0.156.1", &t), None);
    }

    #[test]
    fn prerelease_install_takes_highest_tag_and_skips_platform_tags() {
        // The real DeepSeek Harness tags on 2026-09-24: `latest` is older.
        let dsh = tags(&[("latest", "0.1.5-rc.3"), ("next", "0.1.7-rc.1"), ("alpha", "0.1.7-alpha.2")]);
        assert_eq!(pick_update("0.1.7-alpha.1", &dsh).as_deref(), Some("0.1.7-rc.1"));
        assert_eq!(pick_update("0.1.7-rc.1", &dsh), None);

        let codex = tags(&[
            ("latest", "0.156.1"),
            ("alpha", "0.158.0-alpha.8"),
            ("alpha-win32-x64", "0.158.0-alpha.8-win32-x64"),
        ]);
        assert_eq!(pick_update("0.158.0-alpha.1", &codex).as_deref(), Some("0.158.0-alpha.8"));
    }

    #[test]
    fn native_update_follows_its_channel() {
        let claude = tags(&[("stable", "2.1.273"), ("next", "2.1.281"), ("latest", "2.1.281")]);
        assert_eq!(pick_native_update("2.1.270", &claude, "latest").as_deref(), Some("2.1.281"));
        assert_eq!(pick_native_update("2.1.270", &claude, "stable").as_deref(), Some("2.1.273"));
        assert_eq!(pick_native_update("2.1.273", &claude, "stable"), None);
        assert_eq!(pick_native_update("2.1.281", &claude, "latest"), None);
    }

    #[test]
    fn never_downgrades_or_accepts_garbage() {
        assert_eq!(pick_update("2.0.0", &tags(&[("latest", "1.9.9")])), None);
        assert_eq!(pick_update("not-a-version", &tags(&[("latest", "1.0.0")])), None);
        assert_eq!(pick_update("1.0.0", &tags(&[("latest", "1.0")])), None);
    }

    #[test]
    fn bin_matching_follows_npm_rules() {
        let object = serde_json::json!({ "name": "@openai/codex", "bin": { "codex": "bin/codex.js" } });
        assert!(manifest_provides(&object, "codex"));
        assert!(!manifest_provides(&object, "claude"));
        let string = serde_json::json!({ "name": "@scope/tool", "bin": "cli.js" });
        assert!(manifest_provides(&string, "tool"));
        assert!(!manifest_provides(&serde_json::json!({ "name": "x" }), "x"));
    }

    #[test]
    fn child_path_leaves_npm_room_and_leads_with_node() {
        let path = child_path().expect("a PATH");
        assert!(path.len() <= CHILD_PATH_LIMIT, "PATH is {} characters", path.len());
        if let Some(node) = crate::commands::agent_probe::which("node") {
            assert_eq!(std::env::split_paths(&path).next().as_deref(), node.parent());
        }
    }

    #[test]
    fn npm_failure_keeps_error_lines_and_explains_locks() {
        let err = b"npm warn deprecated foo\nnpm error code EBUSY\nnpm error path C:\\x\nnpm error A complete log of this run can be found in: C:\\log\n";
        let msg = npm_failure(err, b"");
        assert!(msg.starts_with("npm error code EBUSY\nnpm error path"));
        assert!(!msg.contains("complete log"));
        assert!(msg.contains("Close its terminals"));
    }
}
