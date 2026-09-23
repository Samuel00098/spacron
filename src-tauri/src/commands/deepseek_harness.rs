//! DeepSeek Harness (`dsh`, npm `@deepseek-ai/dsh`) as a Spacron agent.
//!
//! dsh ships no terminal UI (DeepSeek deleted it in 2026-08), so it cannot be a
//! PTY agent like `claude` or `codex`. It reaches Spacron two ways instead:
//!
//! - **Web panel.** Rust owns a `dsh --profile web` process per project and
//!   serves it to the DeepSeek room through a small loopback gateway (below).
//!   It opens on that project as its workspace ([`PROJECT_PLUGIN`]).
//! - **Headless worker.** An orchestrator dispatch opens an ordinary terminal
//!   and, once it has the goal, types a [`WORKER_SCRIPT`] launch that runs
//!   `dsh --profile headless` on it. The task travels as a file (see
//!   [`deepseek_harness_write_task`]), the key through [`resolve_env_markers`].
//!
//! Any provider key saved in AI Connections that dsh's catalog supports is
//! usable, not only DeepSeek's: see [`EXTRA_ROUTES`] and [`providers_patch`].
//!
//! Both launches carry [`MCP_PATCH`], which gives dsh Spacron's MCP tools
//! (`report_status`, `delegate_task`, …). The MCP URL — token included — comes
//! from the launch environment, so no file on disk ever holds it.
//!
//! Why a gateway rather than the preview proxy: dsh authenticates a browser by
//! swapping a one-time `?token=` for a `SameSite=Strict` cookie and then checks
//! both that cookie and the `Origin` on its WebSocket. Inside Spacron the page
//! is a cross-site iframe, so the browser never sends the cookie, and the
//! preview proxy's local-dev WebSocket bridge forwards neither cookie nor
//! Origin. The gateway does the token exchange itself, holds the cookie, and
//! adds both headers on every hop. It is reachable only under a random path
//! prefix; dsh's frontend resolves every URL against `document.baseURI`, so the
//! prefix survives all of its requests.

use crate::state::AppState;
use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State as AxumState, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

/// The release Spacron was verified against. Both `0.1.5` release candidates
/// on npm fail to install (they depend on an unpublished
/// `dsh-client-ui-sidebar-documentpreview@^0.1.5-rc.3`), so the install hint
/// names this version explicitly rather than trusting a dist-tag.
pub const PINNED_VERSION: &str = "0.1.7-alpha.1";

/// Env marker a terminal launch sets to ask for the provider keys. The frontend
/// never holds provider keys; `terminal_create` swaps this for the real values.
pub const KEY_MARKER_ENV: &str = "SPACRON_WITH_DSH_KEYS";

/// Spacron AI-Connections providers dsh can use besides DeepSeek, through its
/// `dsh-llm-pi-ai` adapter. `route` is the adapter's catalog provider name and
/// `default_model` a model that catalog ships (checked against pi-ai 0.85.1 as
/// bundled with dsh 0.1.7-alpha.1). Listed in the order a default is chosen
/// when no DeepSeek key is saved. Each key travels in a Spacron-named env var,
/// so two routes that share pi-ai's own name (`OPENCODE_API_KEY`) cannot
/// clobber each other, and nothing the user exported is overridden.
struct Route {
    spacron: &'static str,
    route: &'static str,
    default_model: &'static str,
    /// Set for a provider pi-ai's catalog does not ship, which dsh then needs
    /// described in full: protocol, endpoint and models.
    custom: Option<CustomRoute>,
}

struct CustomRoute {
    display_name: &'static str,
    api: &'static str,
    base_url: &'static str,
    /// `(id, name)` pairs.
    models: &'static [(&'static str, &'static str)],
}

const fn catalog(spacron: &'static str, route: &'static str, default_model: &'static str) -> Route {
    Route { spacron, route, default_model, custom: None }
}

const EXTRA_ROUTES: &[Route] = &[
    catalog("anthropic", "anthropic", "claude-sonnet-5"),
    catalog("openai", "openai", "gpt-5.5"),
    catalog("google", "google", "gemini-3.1-pro-preview"),
    catalog("openrouter", "openrouter", "deepseek/deepseek-v4-flash"),
    catalog("xai", "xai", "grok-4.6"),
    catalog("opencode", "opencode", "claude-sonnet-5"),
    catalog("moonshot", "moonshotai", "kimi-k2.5"),
    catalog("mistral", "mistral", "devstral-latest"),
    catalog("together", "together", "Qwen/Qwen3.7-Max"),
    catalog("fireworks", "fireworks", "accounts/fireworks/models/deepseek-v4-flash-0731"),
    catalog("groq", "groq", "openai/gpt-oss-120b"),
    catalog("cerebras", "cerebras", "gpt-oss-120b"),
    catalog("nvidia", "nvidia", "deepseek-ai/deepseek-v4-flash-0731"),
    catalog("opencode-go", "opencode-go", "deepseek-v4-flash"),
    // Kilo Gateway is OpenAI-compatible and absent from pi-ai's catalog. The
    // endpoint is `KILOCODE_URL` in secrets.rs minus `/chat/completions`, which
    // pi-ai appends; the models mirror the Kilo entry in settings.ts. Verified
    // 2026-09-22: a fake key reaches Kilo and gets its own INVALID_TOKEN.
    Route {
        spacron: "kilocode",
        route: "kilocode",
        default_model: "kilo-auto/free",
        custom: Some(CustomRoute {
            display_name: "Kilo Code",
            api: "openai-completions",
            base_url: "https://api.kilo.ai/api/gateway",
            models: &[
                ("kilo-auto/free", "Kilo Auto (free)"),
                ("nvidia/nemotron-3-super-120b-a12b:free", "Nemotron 3 Super 120B (free)"),
                ("deepseek/deepseek-v4-flash-0731:free", "DeepSeek V4 Flash (free)"),
                ("qwen/qwen3.8-27b:free", "Qwen 3.8 27B (free)"),
            ],
        }),
    },
];

fn route_env(route: &Route) -> String {
    format!("SPACRON_DSH_KEY_{}", route.spacron.to_ascii_uppercase().replace('-', "_"))
}

/// Every saved key dsh can use, as `(env var, value)`, plus the routes they
/// unlock. DeepSeek keeps dsh's own `DEEPSEEK_API_KEY` for its native adapter.
struct Keys {
    env: Vec<(String, String)>,
    has_deepseek: bool,
    routes: Vec<&'static Route>,
}

fn saved_keys() -> Keys {
    let mut keys = Keys { env: Vec::new(), has_deepseek: false, routes: Vec::new() };
    if let Ok(key) = deepseek_key() {
        keys.env.push(("DEEPSEEK_API_KEY".to_string(), key));
        keys.has_deepseek = true;
    }
    for route in EXTRA_ROUTES {
        if let Ok(key) = crate::commands::secrets::media_api_key(route.spacron) {
            keys.env.push((route_env(route), key));
            keys.routes.push(route);
        }
    }
    keys
}

fn yaml_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Everything the providers patch is built from.
struct PatchInput<'a> {
    routes: &'a [&'static Route],
    /// Each route's live model list, by `Route::spacron`. Missing or empty
    /// means: a catalog route keeps pi-ai's bundled catalog, a custom route
    /// its built-in list.
    live_models: &'a HashMap<&'static str, Vec<(String, String)>>,
    /// The default-model row the user saved in dsh, appended verbatim. Only
    /// the headless worker needs it: the web profile already reads it.
    saved_default: Option<&'a str>,
    /// Write a first-route default as an overlay. Only for the very first web
    /// launch, before dsh's profile exists to hold a seeded default (see
    /// [`seed_default_model`]) — an overlay would lock dsh's own "default model"
    /// setting, since dsh refuses a UI write that an overlay covers.
    choose_default: bool,
}

/// A route's default model: its preferred one when the provider still serves
/// it (or when no live list was fetched), else the first live model.
fn default_model_for(route: &Route, live: Option<&Vec<(String, String)>>) -> String {
    match live {
        Some(models) if !models.is_empty() && !models.iter().any(|(id, _)| id == route.default_model) => {
            models[0].0.clone()
        }
        _ => route.default_model.to_string(),
    }
}

fn default_model_row(route: &Route, live: Option<&Vec<(String, String)>>) -> String {
    format!(
        "- id: agent-default-model\n  config:\n    provider: {}\n    model: {}\n",
        yaml_quote(route.route),
        yaml_quote(&default_model_for(route, live))
    )
}

/// The patch registering the saved providers with `dsh-llm-pi-ai`, or `None`
/// when there is nothing to register.
fn providers_patch(input: &PatchInput) -> Option<String> {
    if input.routes.is_empty() && input.saved_default.is_none() {
        return None;
    }
    let mut out = String::from(
        "# Written by Spacron on each launch from the keys in AI Connections.\n\
         # Keys arrive through the launch environment; none is stored here.\n",
    );
    if !input.routes.is_empty() {
        out.push_str("- id: llm-pi-ai\n  config:\n    providers:\n");
    }
    for route in input.routes {
        out.push_str(&format!(
            "      {}:\n        apiKeyEnv: {}\n",
            yaml_quote(route.route),
            route_env(route)
        ));
        if let Some(custom) = &route.custom {
            out.push_str(&format!(
                "        displayName: {}\n        api: {}\n        baseURL: {}\n",
                yaml_quote(custom.display_name),
                custom.api,
                yaml_quote(custom.base_url)
            ));
        }
        let fallback: Vec<(String, String)>;
        let models = match (input.live_models.get(route.spacron), &route.custom) {
            (Some(live), _) if !live.is_empty() => Some(live),
            (_, Some(custom)) => {
                fallback = custom.models.iter().map(|(i, n)| (i.to_string(), n.to_string())).collect();
                Some(&fallback)
            }
            // A catalog route with no live list keeps pi-ai's bundled catalog.
            _ => None,
        };
        if let Some(models) = models {
            // Entries sharing a catalog id inherit its capacities; newer models
            // take the route's default sizes (checked against dsh 0.1.7-alpha.1).
            out.push_str("        models:\n");
            for (id, name) in models {
                out.push_str(&format!(
                    "          - id: {}\n            name: {}\n",
                    yaml_quote(id),
                    yaml_quote(name)
                ));
            }
        }
    }
    if let Some(saved) = input.saved_default {
        out.push_str(saved.trim_end());
        out.push('\n');
    } else if input.choose_default {
        if let Some(first) = input.routes.first() {
            out.push_str(&default_model_row(first, input.live_models.get(first.spacron)));
        }
    }
    Some(out)
}

/// The most a launch waits for any one provider's model list.
const LIVE_MODELS_TIMEOUT: Duration = Duration::from_secs(8);

/// A provider's live model catalogue, fetched with the saved key through the
/// same code Spacron's own model picker uses. Empty on any failure or timeout,
/// which makes [`providers_patch`] fall back.
async fn live_models(route: &Route) -> Vec<(String, String)> {
    let fetch = crate::commands::secrets::list_provider_models(route.spacron.to_string(), String::new(), None, None);
    let Ok(Ok(models)) = tokio::time::timeout(LIVE_MODELS_TIMEOUT, fetch).await else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| {
            let value = serde_json::to_value(model).ok()?;
            // Models Spacron's own picker cannot send through this provider
            // are unlikely to work through dsh's single-protocol route either.
            if value.get("supported").and_then(|v| v.as_bool()) == Some(false) {
                return None;
            }
            let id = value.get("id")?.as_str()?.to_string();
            let name = value.get("label").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(&id).to_string();
            Some((id, name))
        })
        .collect()
}

/// Every saved provider's live models, fetched in parallel so a launch waits
/// at most one timeout rather than one per provider.
async fn all_live_models(routes: &[&'static Route]) -> HashMap<&'static str, Vec<(String, String)>> {
    let lists = futures_util::future::join_all(routes.iter().map(|route| live_models(route))).await;
    routes.iter().map(|route| route.spacron).zip(lists).collect()
}

fn dsh_home() -> PathBuf {
    std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".dsh"))
}

fn web_profile_dir() -> PathBuf {
    dsh_home().join("profiles").join("web")
}

/// The top-level row with `id` in a dsh patch file, verbatim, or `None`.
fn patch_row(yaml: &str, id: &str) -> Option<String> {
    let mut lines = yaml.lines();
    let start = lines.by_ref().find(|line| {
        line.strip_prefix("- id:")
            .map(|rest| rest.trim().trim_matches(|c| c == '\'' || c == '"') == id)
            .unwrap_or(false)
    })?;
    let mut row = String::from(start);
    row.push('\n');
    for line in lines {
        if line.starts_with("- ") || (!line.is_empty() && !line.starts_with(' ') && !line.starts_with('#')) {
            break;
        }
        row.push_str(line);
        row.push('\n');
    }
    Some(row)
}

/// The default model saved in dsh's web profile — by the user in dsh's
/// settings, or seeded once by [`seed_default_model`].
fn saved_default_row() -> Option<String> {
    let text = std::fs::read_to_string(web_profile_dir().join("cordis.patch.yml")).ok()?;
    patch_row(&text, "agent-default-model")
}

/// With no DeepSeek key and no saved default, write the first saved provider's
/// model into dsh's own profile file, exactly as dsh's settings would. Unlike an
/// overlay, the user can then change it inside dsh. Only once the profile
/// exists (`package.json`), since dsh creates the web profile on first use and
/// would find a half-made one. Returns whether a default is now saved.
fn seed_default_model(keys: &Keys, live: &HashMap<&'static str, Vec<(String, String)>>) -> bool {
    if saved_default_row().is_some() {
        return true;
    }
    let Some(first) = keys.routes.first() else { return false };
    if keys.has_deepseek || !web_profile_dir().join("package.json").is_file() {
        return false;
    }
    let path = web_profile_dir().join("cordis.patch.yml");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&default_model_row(first, live.get(first.spacron)));
    std::fs::write(&path, text).is_ok()
}

const NO_KEY: &str = "no_key: Add a DeepSeek key, or a key for another provider DeepSeek Harness supports (Anthropic, OpenAI, Google, OpenRouter, xAI, OpenCode, Moonshot, Mistral, Together, Fireworks, Groq, Cerebras, NVIDIA or Kilo Code), in Settings > AI Connections.";

/// How long the first `dsh web` start may take. The first run on a machine
/// initialises the profile from its template and measured ~60s; later starts
/// take ~8s.
const WEB_READY_TIMEOUT: Duration = Duration::from_secs(180);

/// What dsh logs when the Spacron MCP row cannot connect. dsh keeps running
/// without the tools, so this line is the only sign that report_status and
/// delegation will not work from this session.
const MCP_FAILURE_MARKER: &str = "mcp-client(spacron)";

/// Inserts Spacron's MCP server. `failOnStartupError` stays false on purpose:
/// with it true a failed connection makes the web profile withhold its
/// readiness line forever instead of exiting, which reads as a hang.
const MCP_PATCH: &str = r#"# Written by Spacron. Gives DeepSeek Harness Spacron's MCP tools.
# The URL (and its token) comes from the launch environment.
- insert:
    - id: spacron-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: spacron
        transport: streamable-http
        url: !!js process.env.SPACRON_MCP_URL
"#;

/// Replaces the headless runner's config so the task comes from
/// `SPACRON_DSH_TASK`, which [`WORKER_SCRIPT`] sets from the task file. A task
/// typed on the command line would need quoting for every shell dialect a
/// terminal can run; a file path needs none. The launch still passes a
/// positional placeholder, because the headless startup parser rejects a
/// missing task outright when stdin is a terminal.
const HEADLESS_TASK_PATCH: &str = r#"# Written by Spacron. The delegated task arrives through SPACRON_DSH_TASK.
- id: headless-runner
  config:
    task: !!js process.env.SPACRON_DSH_TASK || ctx.headlessStartup.task
    sessionId: !!js ctx.headlessStartup.sessionId
    json: !!js ctx.headlessStartup.json
"#;

/// Opens the web UI on the project: registers `SPACRON_DSH_PROJECT` as a dsh
/// Workspace (idempotent — an existing one is returned) and moves it to the top.
///
/// Registering alone is not enough when the list holds several Workspaces: the
/// UI then starts on "Choose workspace". So [`DATA_PATCH`] gives every project
/// its own dsh data, where this project is the only Workspace, and the UI opens
/// straight into it. Verified in a browser against dsh 0.1.7-alpha.1, first
/// launch and relaunch. dsh has no URL or config for choosing the startup
/// Workspace; `ctx.uiWorkspace.openWorkspace` exists only to browser plugins.
const PROJECT_PLUGIN: &str = r#"// Written by Spacron: registers the open project as a dsh Workspace.
export const name = 'spacron-open-project'
export const inject = ['workspaceRegistry']
export async function apply(ctx, config) {
  const registry = ctx.workspaceRegistry
  const project = await registry.create(config.path)
  const first = registry.list()[0]
  if (first && first.id !== project.id) await registry.insertBefore(project.id, first.id)
}
"#;

/// Full access in every project, for the web panel and workers alike: fresh
/// sessions start on the Full access preset (`defaultPreset`), and the sandbox
/// and approval defaults follow `DSH_PERMISSION_MODE`, which both launches set
/// (see [`FULL_ACCESS_MODE`]). The preset table restates dsh's shipped one,
/// because a patch replaces a row's whole config. Being a command-line overlay,
/// it also locks dsh's own "default permission" setting — intended here.
const FULL_ACCESS_PATCH: &str = r#"# Written by Spacron: DeepSeek Harness always starts with full access.
- id: permission
  config:
    defaultPreset: danger-full-access
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
"#;

/// dsh's own switch for the sandbox and approval defaults.
const FULL_ACCESS_MODE: (&str, &str) = ("DSH_PERMISSION_MODE", "danger-full-access");

/// Points dsh's session history and app state at `SPACRON_DSH_DATA`, one
/// folder per project. Profile, plugins and credentials stay shared in the
/// user's dsh home, so no project pays the first-run setup again.
const DATA_PATCH: &str = r#"# Written by Spacron: this project's own dsh history and state.
- id: session-persistence-jsonl
  config:
    root: !!js process.env.SPACRON_DSH_DATA + '/sessions'
- id: storage-json
  config:
    root: !!js process.env.SPACRON_DSH_DATA + '/storages'
"#;

/// The patch loading [`PROJECT_PLUGIN`] from its file. dsh's loader imports a
/// row's `name` as a module specifier, so a `file:` URL works.
fn project_patch(plugin: &Path) -> Result<String, String> {
    let url = url::Url::from_file_path(plugin)
        .map_err(|_| format!("Invalid plugin path: {}", plugin.display()))?;
    Ok(format!(
        "# Written by Spacron: opens DeepSeek Harness on the project.\n\
         - insert:\n    - id: spacron-open-project\n      name: {}\n      config:\n        path: !!js process.env.SPACRON_DSH_PROJECT\n",
        yaml_quote(url.as_str())
    ))
}

/// This project's dsh data folder. A name-based UUID keeps it stable across
/// launches without the path's characters reaching the file system.
fn project_data_dir(root: &Path) -> PathBuf {
    let id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, root.to_string_lossy().as_bytes());
    patch_dir().join("projects").join(id.simple().to_string())
}

/// Runs one headless task and reports its end.
///
/// dsh exits when its task is done, 0 for success and 1 otherwise. That exit is
/// a certain turn end, so the wrapper turns it into a declared one on the
/// session's status channel (`SPACRON_TURN_FILE`, see [[agent-turn-reporting]])
/// rather than leaving the watcher to infer it from a quiet pane. Doing it in
/// Node keeps it out of shell syntax, which differs across the shells a
/// terminal can run.
const WORKER_SCRIPT: &str = r#"// Written by Spacron: runs one DeepSeek Harness headless task, then reports.
// Usage: node spacron-dsh-worker.mjs <task-file> <dsh bin.js> [dsh args...]
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';

const [taskFile, bin, ...args] = process.argv.slice(2);

function report(ok, detail) {
  const file = process.env.SPACRON_TURN_FILE;
  const token = process.env.SPACRON_TURN_TOKEN;
  if (!file || !token) return;
  const kind = ok ? 'SPACRON-TURN-DONE' : 'SPACRON-TURN-FAILED';
  try { appendFileSync(file, `${kind}:${token} ${detail}\n`); } catch {}
}

let task;
try {
  task = readFileSync(taskFile, 'utf8');
  rmSync(taskFile, { force: true });
} catch {
  report(false, 'DeepSeek Harness could not read its task.');
  process.exit(1);
}

const child = spawn(process.execPath, [bin, ...args], {
  stdio: 'inherit',
  env: { ...process.env, SPACRON_DSH_TASK: task },
});
child.on('error', (err) => {
  report(false, `DeepSeek Harness did not start: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => {
  report(code === 0, code === 0
    ? 'DeepSeek Harness finished its task.'
    : 'DeepSeek Harness stopped with an error; its terminal shows why.');
  process.exit(code ?? 1);
});
"#;

// ---------------------------------------------------------------------------
// Install resolution
// ---------------------------------------------------------------------------

struct DshInstall {
    node: PathBuf,
    bin_js: PathBuf,
}

/// Find the Node entry point and a `node` to run it with.
///
/// Never the npm shim: on Windows `dsh.cmd` needs `node` on PATH, which an app
/// launched from the desktop often lacks, and the extensionless sibling is an
/// sh script CreateProcess cannot run (see [[windows-pathext-shims]]).
fn resolve_install() -> Result<DshInstall, String> {
    let found = crate::commands::agent_probe::which("dsh").ok_or_else(not_installed)?;
    let resolved = std::fs::canonicalize(&found).unwrap_or_else(|_| found.clone());
    // A unix bin symlink resolves straight into `<pkg>/lib/bin.js`; a Windows
    // npm shim sits beside `node_modules/@deepseek-ai/dsh`.
    let bin_js = if resolved.file_name().is_some_and(|n| n == "bin.js") {
        resolved
    } else {
        found
            .parent()
            .ok_or_else(not_installed)?
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js")
    };
    if !bin_js.is_file() {
        return Err(not_installed());
    }
    let beside_shim = found
        .parent()
        .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .filter(|p| p.is_file());
    let node = crate::commands::agent_probe::which("node")
        .or(beside_shim)
        .ok_or_else(|| "not_installed: DeepSeek Harness needs Node.js, and `node` was not found.".to_string())?;
    Ok(DshInstall { node, bin_js })
}

fn not_installed() -> String {
    format!(
        "not_installed: DeepSeek Harness is not installed. Install it with `npm install -g @deepseek-ai/dsh@{PINNED_VERSION}`."
    )
}

fn installed_version(bin_js: &Path) -> Option<String> {
    let manifest = bin_js.parent()?.parent()?.join("package.json");
    let text = std::fs::read_to_string(manifest).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

fn patch_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("spacron")
        .join("deepseek-harness")
}

struct SupportFiles {
    mcp_patch: PathBuf,
    task_patch: PathBuf,
    worker_script: PathBuf,
    project_patch: PathBuf,
    data_patch: PathBuf,
    access_patch: PathBuf,
    /// Only when a key for a non-DeepSeek provider is saved.
    providers_patch: Option<PathBuf>,
}

fn write_if_changed(path: &Path, body: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() != Some(body) {
        std::fs::write(path, body).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Which dsh profile a launch boots; they differ in who reads the saved model.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Profile {
    Web,
    Headless,
}

/// Write the patches and the worker script. The providers patch follows the
/// keys and model choice of right now, so it is rewritten on every launch.
async fn write_support_files(keys: &Keys, profile: Profile) -> Result<SupportFiles, String> {
    let dir = patch_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let live = all_live_models(&keys.routes).await;
    // The web launch seeds a default into dsh's own profile file when it needs
    // one; the headless worker has no UI, so it takes the saved row, or an
    // overlay default when there is none.
    let seeded = profile == Profile::Web && seed_default_model(keys, &live);
    let saved = saved_default_row();
    let input = PatchInput {
        routes: &keys.routes,
        live_models: &live,
        saved_default: if profile == Profile::Headless { saved.as_deref() } else { None },
        choose_default: !keys.has_deepseek && !seeded && saved.is_none(),
    };
    let providers_name = match profile {
        Profile::Web => "spacron-providers-web.patch.yml",
        Profile::Headless => "spacron-providers-headless.patch.yml",
    };

    let files = SupportFiles {
        mcp_patch: dir.join("spacron-mcp.patch.yml"),
        task_patch: dir.join("headless-task.patch.yml"),
        worker_script: dir.join("spacron-dsh-worker.mjs"),
        project_patch: dir.join("spacron-project.patch.yml"),
        data_patch: dir.join("spacron-data.patch.yml"),
        access_patch: dir.join("spacron-full-access.patch.yml"),
        providers_patch: providers_patch(&input)
            .map(|body| {
                let path = dir.join(providers_name);
                write_if_changed(&path, &body).map(|_| path)
            })
            .transpose()?,
    };
    write_if_changed(&files.mcp_patch, MCP_PATCH)?;
    write_if_changed(&files.task_patch, HEADLESS_TASK_PATCH)?;
    write_if_changed(&files.worker_script, WORKER_SCRIPT)?;
    let plugin = dir.join("spacron-open-project.mjs");
    write_if_changed(&plugin, PROJECT_PLUGIN)?;
    write_if_changed(&files.project_patch, &project_patch(&plugin)?)?;
    write_if_changed(&files.data_patch, DATA_PATCH)?;
    write_if_changed(&files.access_patch, FULL_ACCESS_PATCH)?;
    Ok(files)
}

fn deepseek_key() -> Result<String, String> {
    crate::commands::secrets::media_api_key("deepseek")
}

/// Swap [`KEY_MARKER_ENV`] for every saved key dsh can use.
///
/// No keys leaves the env without them rather than failing the terminal: dsh
/// then prints its own "no API key" error in the pane.
pub fn resolve_env_markers(env: &mut HashMap<String, String>) {
    if env.remove(KEY_MARKER_ENV).is_none() {
        return;
    }
    env.extend(saved_keys().env);
    env.insert(FULL_ACCESS_MODE.0.to_string(), FULL_ACCESS_MODE.1.to_string());
}

// ---------------------------------------------------------------------------
// Status + worker launch
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekHarnessStatus {
    installed: bool,
    version: Option<String>,
    pinned_version: &'static str,
    has_key: bool,
    /// Why it cannot run, worded for the user; `None` when it can.
    problem: Option<String>,
}

#[tauri::command]
pub fn deepseek_harness_status() -> DeepSeekHarnessStatus {
    let install = resolve_install();
    let has_key = !saved_keys().env.is_empty();
    let problem = match (&install, has_key) {
        (Err(e), _) => Some(strip_kind(e)),
        (Ok(_), false) => Some(strip_kind(NO_KEY)),
        _ => None,
    };
    DeepSeekHarnessStatus {
        installed: install.is_ok(),
        version: install.as_ref().ok().and_then(|i| installed_version(&i.bin_js)),
        pinned_version: PINNED_VERSION,
        has_key,
        problem,
    }
}

/// The paths a headless worker's command line needs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekWorkerFiles {
    worker_script: String,
    bin_js: String,
    mcp_patch: String,
    task_patch: String,
    access_patch: String,
    providers_patch: Option<String>,
}

#[tauri::command]
pub async fn deepseek_harness_worker_files() -> Result<DeepSeekWorkerFiles, String> {
    let install = resolve_install()?;
    let files = write_support_files(&saved_keys(), Profile::Headless).await?;
    let text = |p: &Path| p.to_string_lossy().into_owned();
    Ok(DeepSeekWorkerFiles {
        worker_script: text(&files.worker_script),
        bin_js: text(&install.bin_js),
        mcp_patch: text(&files.mcp_patch),
        task_patch: text(&files.task_patch),
        access_patch: text(&files.access_patch),
        providers_patch: files.providers_patch.as_deref().map(text),
    })
}

/// Save one task for a worker and return its path. The worker script deletes
/// the file once it has read it.
#[tauri::command]
pub fn deepseek_harness_write_task(text: String) -> Result<String, String> {
    let dir = patch_dir().join("tasks");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.md", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, text).map_err(|e| format!("Could not save the DeepSeek task: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn strip_kind(message: &str) -> String {
    match message.split_once(": ") {
        Some((kind, rest)) if !kind.contains(' ') => rest.to_string(),
        _ => message.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Web panel
// ---------------------------------------------------------------------------

struct WebInstance {
    child: Child,
    url: String,
    mcp_failed: Arc<AtomicBool>,
    stop_gateway: Option<oneshot::Sender<()>>,
}

impl WebInstance {
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for WebInstance {
    fn drop(&mut self) {
        if let Some(stop) = self.stop_gateway.take() {
            let _ = stop.send(());
        }
        // dsh runs tools (bash, MCP servers) as child processes; take the tree.
        #[cfg(windows)]
        if let Some(pid) = self.child.id() {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("taskkill")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
        let _ = self.child.start_kill();
    }
}

/// One `dsh web` per project root: its working directory is the workspace.
static WEB: Mutex<Option<HashMap<String, WebInstance>>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekWebPanel {
    url: String,
    /// Set when dsh could not reach Spacron's MCP server, so completion cards
    /// and delegation will not work from this panel.
    mcp_warning: Option<String>,
}

fn mcp_warning(failed: &AtomicBool) -> Option<String> {
    failed.load(Ordering::Relaxed).then(|| {
        "DeepSeek Harness could not connect to Spacron's tools, so it cannot send completion cards. Restart the panel to retry.".to_string()
    })
}

#[tauri::command]
pub async fn deepseek_harness_web_open(
    root: String,
    mcp_url: String,
    state: State<'_, AppState>,
) -> Result<DeepSeekWebPanel, String> {
    // Without Windows' verbatim `\\?\` prefix: dsh would register that
    // spelling as a different folder from the one the user knows.
    let root_path = std::fs::canonicalize(&root)
        .map(crate::commands::clean_path_buf)
        .map_err(|_| "The project folder was not found.".to_string())?;
    crate::commands::file_system::require_in_project(&root_path, &state)?;
    let key = root_path.to_string_lossy().into_owned();

    {
        let mut guard = WEB.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(existing) = map.get_mut(&key) {
            if existing.alive() {
                return Ok(DeepSeekWebPanel {
                    url: existing.url.clone(),
                    mcp_warning: mcp_warning(&existing.mcp_failed),
                });
            }
            map.remove(&key);
        }
    }

    let instance = start_web(&root_path, &mcp_url).await?;
    let panel = DeepSeekWebPanel {
        url: instance.url.clone(),
        mcp_warning: mcp_warning(&instance.mcp_failed),
    };
    let mut guard = WEB.lock().unwrap_or_else(|e| e.into_inner());
    // A concurrent open for the same root may have won the race; keep one.
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(existing) = map.get_mut(&key) {
        if existing.alive() {
            return Ok(DeepSeekWebPanel {
                url: existing.url.clone(),
                mcp_warning: mcp_warning(&existing.mcp_failed),
            });
        }
    }
    map.insert(key, instance);
    Ok(panel)
}

#[tauri::command]
pub fn deepseek_harness_web_stop(root: String) {
    let key = std::fs::canonicalize(&root)
        .map(|p| crate::commands::clean_path_buf(p).to_string_lossy().into_owned())
        .unwrap_or(root);
    let mut guard = WEB.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(&key);
    }
}

/// Stop every dsh web process. Called on app exit so none outlives Spacron.
pub fn shutdown_all() {
    let mut guard = WEB.lock().unwrap_or_else(|e| e.into_inner());
    guard.take();
}

async fn start_web(root: &Path, mcp_url: &str) -> Result<WebInstance, String> {
    let install = resolve_install()?;
    let keys = saved_keys();
    if keys.env.is_empty() {
        return Err(strip_kind(NO_KEY));
    }
    let files = write_support_files(&keys, Profile::Web).await?;
    let dsh_port = free_port()?;

    let mut command = Command::new(&install.node);
    command
        .arg(&install.bin_js)
        .args(["--profile", "web"])
        .arg("--patch")
        .arg(&files.mcp_patch)
        .arg("--patch")
        .arg(&files.project_patch)
        .arg("--patch")
        .arg(&files.data_patch)
        .arg("--patch")
        .arg(&files.access_patch);
    if let Some(providers) = &files.providers_patch {
        command.arg("--patch").arg(providers);
    }
    command
        .args(["--port", &dsh_port.to_string(), "--no-open"])
        .current_dir(root)
        .envs(keys.env)
        .env("SPACRON_MCP_URL", mcp_url)
        .env("SPACRON_DSH_PROJECT", root)
        .env("SPACRON_DSH_DATA", project_data_dir(root))
        .env(FULL_ACCESS_MODE.0, FULL_ACCESS_MODE.1)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start DeepSeek Harness: {e}"))?;

    // Both pipes are drained for the life of the process — a full pipe would
    // stall dsh — and scanned for the readiness line and the MCP failure.
    let mcp_failed = Arc::new(AtomicBool::new(false));
    let tail = Arc::new(Mutex::new(String::new()));
    let (ready_tx, ready_rx) = oneshot::channel::<String>();
    let ready_tx = Arc::new(Mutex::new(Some(ready_tx)));
    if let Some(out) = child.stdout.take() {
        drain(out, mcp_failed.clone(), tail.clone(), Some(ready_tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        drain(err, mcp_failed.clone(), tail.clone(), Some(ready_tx));
    }

    let startup_url = tokio::select! {
        url = ready_rx => url.ok(),
        _ = tokio::time::sleep(WEB_READY_TIMEOUT) => None,
        _ = child.wait() => None,
    };
    let Some(startup_url) = startup_url else {
        let _ = child.start_kill();
        let detail = tail.lock().unwrap_or_else(|e| e.into_inner()).trim().to_string();
        return Err(if detail.is_empty() {
            "DeepSeek Harness did not start.".to_string()
        } else {
            format!("DeepSeek Harness did not start:\n{detail}")
        });
    };

    let cookie = exchange_token(&startup_url).await?;
    let secret = uuid::Uuid::new_v4().simple().to_string();
    let (gateway_port, stop_gateway) = start_gateway(dsh_port, cookie, secret.clone()).await?;

    Ok(WebInstance {
        child,
        url: format!("http://127.0.0.1:{gateway_port}/{secret}/"),
        mcp_failed,
        stop_gateway: Some(stop_gateway),
    })
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("No free port: {e}"))?;
    listener.local_addr().map(|a| a.port()).map_err(|e| format!("No free port: {e}"))
}

/// Keep at most this much output for error messages.
const TAIL_BYTES: usize = 4000;

fn drain<R: AsyncRead + Unpin + Send + 'static>(
    pipe: R,
    mcp_failed: Arc<AtomicBool>,
    tail: Arc<Mutex<String>>,
    ready: Option<Arc<Mutex<Option<oneshot::Sender<String>>>>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains(MCP_FAILURE_MARKER) {
                mcp_failed.store(true, Ordering::Relaxed);
            }
            if let Some(url) = line.strip_prefix("dsh web: ") {
                if let Some(tx) = ready.as_ref().and_then(|r| r.lock().ok()?.take()) {
                    let _ = tx.send(url.trim().to_string());
                }
                // The line carries the login token; keep it out of the tail.
                continue;
            }
            let mut buf = tail.lock().unwrap_or_else(|e| e.into_inner());
            buf.push_str(&line);
            buf.push('\n');
            if buf.len() > TAIL_BYTES {
                let cut = buf.len() - TAIL_BYTES;
                let cut = (cut..buf.len()).find(|&i| buf.is_char_boundary(i)).unwrap_or(0);
                buf.drain(..cut);
            }
        }
    });
}

/// Trade the startup URL's one-time token for dsh's session cookie.
async fn exchange_token(startup_url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(startup_url)
        .send()
        .await
        .map_err(|e| format!("Could not sign in to DeepSeek Harness: {e}"))?;
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| v.split(';').next().filter(|pair| pair.starts_with("dsh-auth")))
        .map(str::to_string)
        .ok_or_else(|| "DeepSeek Harness did not issue a sign-in cookie.".to_string())
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

struct Gateway {
    dsh_port: u16,
    cookie: String,
    prefix: String,
    client: reqwest::Client,
}

async fn start_gateway(
    dsh_port: u16,
    cookie: String,
    secret: String,
) -> Result<(u16, oneshot::Sender<()>), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let gateway = Arc::new(Gateway {
        dsh_port,
        cookie,
        prefix: format!("/{secret}"),
        client,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start the DeepSeek panel gateway: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let router = Router::new().fallback(gateway_handler).with_state(gateway);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
    });
    Ok((port, stop_tx))
}

/// Loopback names only. A DNS-rebound hostname pointing at 127.0.0.1 arrives
/// with its own name in `Host`, and is refused here.
fn host_is_loopback(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

/// Map a gateway path onto dsh's, or `None` when it lacks the secret prefix.
fn upstream_path(prefix: &str, path: &str) -> Option<String> {
    let rest = path.strip_prefix(prefix)?;
    if rest.is_empty() {
        return Some(String::new());
    }
    rest.starts_with('/').then(|| rest.to_string())
}

/// Point an upstream redirect back through the gateway.
fn rewrite_location(location: &str, dsh_port: u16, prefix: &str) -> String {
    let origin = format!("http://127.0.0.1:{dsh_port}");
    if let Some(path) = location.strip_prefix(&origin) {
        return format!("{prefix}{}", if path.is_empty() { "/" } else { path });
    }
    if location.starts_with('/') && !location.starts_with("//") {
        return format!("{prefix}{location}");
    }
    location.to_string()
}

const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

async fn gateway_handler(AxumState(gw): AxumState<Arc<Gateway>>, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    if !host_is_loopback(&parts.headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(path) = upstream_path(&gw.prefix, parts.uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if path.is_empty() {
        // Without the trailing slash, dsh's relative URLs would resolve one
        // level up and lose the secret.
        return (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, format!("{}/", gw.prefix))]).into_response();
    }
    let path_and_query = match parts.uri.query() {
        Some(q) => format!("{path}?{q}"),
        None => path,
    };
    let origin = format!("http://127.0.0.1:{}", gw.dsh_port);

    let wants_ws = parts
        .headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if wants_ws {
        return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => {
                let target = format!("ws://127.0.0.1:{}{}", gw.dsh_port, path_and_query);
                let cookie = gw.cookie.clone();
                ws.on_upgrade(move |socket| {
                    crate::preview::handle_external_websocket(socket, target, Some(cookie), Some(origin))
                })
                .into_response()
            }
            Err(_) => StatusCode::BAD_REQUEST.into_response(),
        };
    }

    let mut headers = parts.headers.clone();
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
    headers.remove(header::HOST);
    headers.remove(header::REFERER);
    // reqwest decompresses on its own only when it chose the encoding.
    headers.remove(header::ACCEPT_ENCODING);
    if let Ok(cookie) = HeaderValue::from_str(&gw.cookie) {
        headers.insert(header::COOKIE, cookie);
    }
    if headers.contains_key(header::ORIGIN) {
        if let Ok(value) = HeaderValue::from_str(&origin) {
            headers.insert(header::ORIGIN, value);
        }
    }

    let upstream = gw
        .client
        .request(parts.method.clone(), format!("{origin}{path_and_query}"))
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await;
    let upstream = match upstream {
        Ok(response) => response,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("DeepSeek Harness is not responding: {e}")).into_response();
        }
    };

    let status = upstream.status();
    let mut out_headers = HeaderMap::new();
    for (name, value) in upstream.headers() {
        let lower = name.as_str();
        if HOP_BY_HOP.contains(&lower) || name == header::SET_COOKIE || name == header::CONTENT_LENGTH {
            continue;
        }
        if name == header::LOCATION {
            if let Ok(loc) = value.to_str() {
                if let Ok(v) = HeaderValue::from_str(&rewrite_location(loc, gw.dsh_port, &gw.prefix)) {
                    out_headers.insert(header::LOCATION, v);
                }
            }
            continue;
        }
        out_headers.append(name.clone(), value.clone());
    }
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_path_requires_the_secret_prefix() {
        assert_eq!(upstream_path("/abc", "/abc/api/remote.mux").as_deref(), Some("/api/remote.mux"));
        assert_eq!(upstream_path("/abc", "/abc/").as_deref(), Some("/"));
        assert_eq!(upstream_path("/abc", "/abc").as_deref(), Some(""));
        assert_eq!(upstream_path("/abc", "/api/remote.mux"), None);
        // A longer segment that merely starts with the secret is not the secret.
        assert_eq!(upstream_path("/abc", "/abcd/"), None);
    }

    #[test]
    fn redirects_stay_behind_the_prefix() {
        assert_eq!(rewrite_location("./", 4000, "/s"), "./");
        assert_eq!(rewrite_location("/login", 4000, "/s"), "/s/login");
        assert_eq!(rewrite_location("http://127.0.0.1:4000/x?y=1", 4000, "/s"), "/s/x?y=1");
        assert_eq!(rewrite_location("http://127.0.0.1:4000", 4000, "/s"), "/s/");
        assert_eq!(rewrite_location("//evil.example/", 4000, "/s"), "//evil.example/");
        assert_eq!(rewrite_location("https://example.com/", 4000, "/s"), "https://example.com/");
    }

    #[test]
    fn only_loopback_hosts_pass() {
        let mut h = HeaderMap::new();
        for (host, ok) in [
            ("127.0.0.1:5000", true),
            ("localhost:5000", true),
            ("[::1]:5000", true),
            ("localhost", true),
            ("rebound.example:5000", false),
        ] {
            h.insert(header::HOST, HeaderValue::from_static(host));
            assert_eq!(host_is_loopback(&h), ok, "{host}");
        }
        h.remove(header::HOST);
        assert!(!host_is_loopback(&h));
    }

    #[test]
    fn key_marker_is_always_removed() {
        let mut env = HashMap::from([(KEY_MARKER_ENV.to_string(), "1".to_string())]);
        resolve_env_markers(&mut env);
        assert!(!env.contains_key(KEY_MARKER_ENV));
        let mut untouched = HashMap::from([("A".to_string(), "b".to_string())]);
        resolve_env_markers(&mut untouched);
        assert_eq!(untouched.len(), 1);
        assert!(!untouched.contains_key("DEEPSEEK_API_KEY"));
    }

    fn patch(routes: &[&'static Route], choose_default: bool) -> Option<String> {
        providers_patch(&PatchInput {
            routes,
            live_models: &HashMap::new(),
            saved_default: None,
            choose_default,
        })
    }

    #[test]
    fn providers_patch_registers_saved_routes_by_env_reference() {
        let anthropic = &EXTRA_ROUTES[0];
        let together = EXTRA_ROUTES.iter().find(|r| r.spacron == "together").unwrap();
        let out = patch(&[anthropic, together], false).unwrap();
        assert!(out.contains("- id: llm-pi-ai"));
        assert!(out.contains("'anthropic':\n        apiKeyEnv: SPACRON_DSH_KEY_ANTHROPIC"));
        assert!(out.contains("'together':\n        apiKeyEnv: SPACRON_DSH_KEY_TOGETHER"));
        // With a DeepSeek key or a saved choice, no default is written.
        assert!(!out.contains("agent-default-model"));

        let out = patch(&[together], true).unwrap();
        assert!(out.contains("- id: agent-default-model"));
        assert!(out.contains("provider: 'together'\n    model: 'Qwen/Qwen3.7-Max'"));

        assert!(patch(&[], true).is_none());
    }

    #[test]
    fn kilo_code_is_described_as_a_custom_route() {
        let kilo = EXTRA_ROUTES.iter().find(|r| r.spacron == "kilocode").unwrap();
        let out = patch(&[kilo], true).unwrap();
        // Exactly the shape verified against dsh 0.1.7-alpha.1.
        assert!(out.contains(
            "      'kilocode':\n        apiKeyEnv: SPACRON_DSH_KEY_KILOCODE\n        displayName: 'Kilo Code'\n        api: openai-completions\n        baseURL: 'https://api.kilo.ai/api/gateway'\n        models:\n          - id: 'kilo-auto/free'\n            name: 'Kilo Auto (free)'\n"
        ));
        assert!(out.contains("provider: 'kilocode'\n    model: 'kilo-auto/free'"));
        // A catalog route gets no custom fields.
        assert!(!patch(&[&EXTRA_ROUTES[0]], false).unwrap().contains("baseURL"));
    }

    #[test]
    fn kilo_uses_its_live_catalogue_when_one_was_fetched() {
        let kilo = EXTRA_ROUTES.iter().find(|r| r.spacron == "kilocode").unwrap();
        let live = HashMap::from([(
            "kilocode",
            vec![("anthropic/claude-sonnet-5".to_string(), "Claude Sonnet 5".to_string())],
        )]);
        let out = providers_patch(&PatchInput {
            routes: &[kilo],
            live_models: &live,
            saved_default: None,
            choose_default: false,
        })
        .unwrap();
        assert!(out.contains("- id: 'anthropic/claude-sonnet-5'\n            name: 'Claude Sonnet 5'"));
        assert!(!out.contains("kilo-auto/free"));
    }

    #[test]
    fn catalog_providers_use_live_models_when_fetched_and_their_catalog_otherwise() {
        let openai = EXTRA_ROUTES.iter().find(|r| r.spacron == "openai").unwrap();
        let live = HashMap::from([(
            "openai",
            vec![("gpt-9".to_string(), "GPT-9".to_string()), ("gpt-5.5".to_string(), "GPT-5.5".to_string())],
        )]);
        let routes = [openai];
        let input = |live| PatchInput { routes: &routes, live_models: live, saved_default: None, choose_default: true };
        let with_live = providers_patch(&input(&live)).unwrap();
        assert!(with_live.contains("        models:\n          - id: 'gpt-9'\n            name: 'GPT-9'\n"));
        // The preferred default is kept while the provider still serves it…
        assert!(with_live.contains("model: 'gpt-5.5'"));
        // …and a failed fetch leaves pi-ai's bundled catalog in charge.
        let without = providers_patch(&input(&HashMap::new())).unwrap();
        assert!(!without.contains("models:"));
        assert!(without.contains("model: 'gpt-5.5'"));
    }

    #[test]
    fn the_default_moves_to_a_live_model_when_the_preferred_one_is_gone() {
        let openai = EXTRA_ROUTES.iter().find(|r| r.spacron == "openai").unwrap();
        let live = vec![("gpt-9".to_string(), "GPT-9".to_string())];
        assert_eq!(default_model_for(openai, Some(&live)), "gpt-9");
        assert_eq!(default_model_for(openai, Some(&Vec::new())), "gpt-5.5");
        assert_eq!(default_model_for(openai, None), "gpt-5.5");
    }

    #[test]
    fn full_access_is_the_default_preset() {
        assert!(FULL_ACCESS_PATCH.contains("- id: permission\n  config:\n    defaultPreset: danger-full-access\n"));
        // The whole shipped table is restated, since a patch replaces the config.
        for preset in ["read-only:", "workspace-write:", "danger-full-access:"] {
            assert!(FULL_ACCESS_PATCH.contains(preset), "{preset}");
        }
        let mut env = HashMap::from([(KEY_MARKER_ENV.to_string(), "1".to_string())]);
        resolve_env_markers(&mut env);
        assert_eq!(env.get("DSH_PERMISSION_MODE").map(String::as_str), Some("danger-full-access"));
    }

    #[test]
    fn a_saved_model_choice_is_kept_and_passed_to_workers() {
        let profile = "- id: hmr\n  disabled: true\n- id: agent-default-model\n  config:\n    provider: kilocode\n    model: anthropic/claude-sonnet-5\n- id: other\n";
        let row = patch_row(profile, "agent-default-model").unwrap();
        assert_eq!(row, "- id: agent-default-model\n  config:\n    provider: kilocode\n    model: anthropic/claude-sonnet-5\n");
        assert_eq!(patch_row("- id: 'agent-default-model'\n  config: {}\n", "agent-default-model").as_deref(), Some("- id: 'agent-default-model'\n  config: {}\n"));
        assert!(patch_row(profile, "missing").is_none());

        // The worker gets the saved row verbatim and no chosen default.
        let kilo = EXTRA_ROUTES.iter().find(|r| r.spacron == "kilocode").unwrap();
        let out = providers_patch(&PatchInput {
            routes: &[kilo],
            live_models: &HashMap::new(),
            saved_default: Some(&row),
            choose_default: false,
        })
        .unwrap();
        assert!(out.ends_with(&row));
        assert_eq!(out.matches("agent-default-model").count(), 1);
        // Even with no extra providers, a saved choice still reaches the worker.
        let only_saved = providers_patch(&PatchInput {
            routes: &[],
            live_models: &HashMap::new(),
            saved_default: Some(&row),
            choose_default: false,
        })
        .unwrap();
        assert!(!only_saved.contains("llm-pi-ai"));
        assert!(only_saved.contains("model: anthropic/claude-sonnet-5"));
    }

    #[test]
    fn project_patch_loads_the_plugin_by_file_url() {
        let plugin = if cfg!(windows) {
            PathBuf::from(r"C:\Users\me\AppData\Roaming\spacron\deepseek-harness\spacron-open-project.mjs")
        } else {
            PathBuf::from("/home/me/.config/spacron/deepseek-harness/spacron-open-project.mjs")
        };
        let patch = project_patch(&plugin).unwrap();
        assert!(patch.contains("- id: spacron-open-project"));
        assert!(patch.contains("name: 'file:///"));
        assert!(patch.contains("spacron-open-project.mjs'"));
        assert!(patch.contains("path: !!js process.env.SPACRON_DSH_PROJECT"));
    }

    #[test]
    fn each_project_gets_its_own_stable_data_folder() {
        let a = project_data_dir(Path::new("/work/a"));
        assert_eq!(a, project_data_dir(Path::new("/work/a")));
        assert_ne!(a, project_data_dir(Path::new("/work/b")));
        assert!(a.starts_with(patch_dir().join("projects")));
    }

    #[test]
    fn route_env_names_never_collide() {
        let mut names: Vec<String> = EXTRA_ROUTES.iter().map(route_env).collect();
        assert!(names.contains(&"SPACRON_DSH_KEY_OPENCODE_GO".to_string()));
        names.sort();
        names.dedup();
        assert_eq!(names.len(), EXTRA_ROUTES.len());
    }

    #[test]
    fn problem_messages_drop_the_error_kind() {
        assert_eq!(strip_kind("no_key: Add your key."), "Add your key.");
        assert_eq!(strip_kind("Plain message: with colon"), "Plain message: with colon");
    }
}
