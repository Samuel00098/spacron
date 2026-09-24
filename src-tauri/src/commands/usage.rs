//! Agent usage & rate-limit meters.
//!
//! Answers the most common mystery in agent work — *why did my agent stop?* —
//! before it gets asked, by reading each signed-in CLI's own usage endpoint and
//! reporting the same windows the CLI itself would show you.
//!
//! ## Where the numbers come from
//!
//! Every coding CLI that sells a subscription already ships an authenticated
//! usage endpoint, because its own `/status` screen has to render one. We reuse
//! the credentials the CLI wrote at login and call the same endpoint:
//!
//! | Provider | Credentials | Endpoint |
//! |---|---|---|
//! | Claude Code | `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` | `api.anthropic.com/api/oauth/usage` |
//! | Codex | `~/.codex/auth.json` → `tokens.access_token` + `tokens.account_id` | `chatgpt.com/backend-api/wham/usage` |
//!
//! Both were verified live against real accounts before this file was written.
//!
//! ## Three rules this module holds to
//!
//! 1. **Read-only, never refresh.** We read the credential file and never write
//!    it, and we never exchange a refresh token. Token rotation belongs to the
//!    CLI that owns the file: two processes racing to rotate one refresh token
//!    is how you log the user out of their own CLI. An expired token is reported
//!    as expired, with the fix ("run the CLI once"), not silently repaired.
//! 2. **Tokens never leave their issuer.** Each token is sent to the host that
//!    minted it and nowhere else, and never logged, never surfaced in an error
//!    string, and never returned to the frontend.
//! 3. **Absence is not zero.** "Not installed", "installed but signed out",
//!    "signed in but the token expired" and "0% used" are four different states
//!    and the UI has to be able to tell them apart — a meter that renders an
//!    empty bar for "we couldn't check" is worse than no meter.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::commands::agent_probe::which;

/// Network timeout per provider. These are status endpoints; a slow one must
/// never hold up the whole panel.
const FETCH_TIMEOUT: Duration = Duration::from_secs(12);

/// How long a successful reading stays fresh. A manual refresh bypasses this;
/// background polling does not, so several panels opening in a row cost one
/// request rather than one each.
///
/// Kept at or below the frontend's panel-open cadence
/// (`PANEL_POLL_INTERVAL_MS` in `stores/usage.ts`). A TTL longer than that
/// cadence silently swallows every other tick: the poll fires, this cache
/// answers, and the meter sits still while appearing to refresh.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// Upper bound for a sign-in probe run (e.g. `copilot auth status`). A status
/// command is quick when healthy; anything past this is hung or doing far more
/// than reading a token, and must not stall the scan.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// How long a probe result stays memoized. The probe is the one part of a
/// detection scan that spawns a subprocess, so a burst of panel opens must not
/// each re-run `copilot auth status` — but the answer also must not go stale,
/// so this is kept well under the background poll cadence. File and PATH
/// checks are cheap enough to run fresh on every scan; only the probe is
/// cached. A forced scan (the panel's Refresh / Rescan buttons) bypasses it.
const PROBE_TTL: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// One usage window — a session window, a weekly window, an opus-only window.
///
/// `resets_at` is deliberately carried in whichever form the provider gave it:
/// Anthropic returns an ISO-8601 string, OpenAI returns unix seconds. Rather
/// than pull in a date crate to unify them here, both are passed through and
/// the frontend — where `Date.parse` already exists and is correct — resolves
/// them into one number.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Short human label: "Session", "Weekly", "Opus weekly".
    pub label: String,
    /// 0–100, clamped. Providers occasionally return >100 when over a cap.
    pub used_percent: f64,
    /// Nominal length of the window, when the provider states it.
    pub window_minutes: Option<u64>,
    /// ISO-8601 reset instant, when the provider gives one in that form.
    pub resets_at_iso: Option<String>,
    /// Unix-epoch-seconds reset instant, when the provider gives a number.
    pub resets_at_epoch_secs: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    pub id: String,
    pub reset_type: Option<String>,
    pub expires_at_iso: Option<String>,
}

impl UsageWindow {
    fn new(label: &str, used_percent: f64) -> Self {
        Self {
            label: label.to_string(),
            used_percent: used_percent.clamp(0.0, 100.0),
            window_minutes: None,
            resets_at_iso: None,
            resets_at_epoch_secs: None,
        }
    }

    fn with_window(mut self, minutes: u64) -> Self {
        self.window_minutes = Some(minutes);
        self
    }

    /// Accept a reset instant in whichever shape the provider used.
    fn with_reset(mut self, raw: Option<&Value>) -> Self {
        match raw {
            Some(Value::String(s)) if !s.is_empty() => self.resets_at_iso = Some(s.clone()),
            Some(Value::Number(n)) => {
                if let Some(secs) = n.as_i64() {
                    // Some payloads use milliseconds. Anything past this bound
                    // cannot be seconds without being ~300 years in the future,
                    // which distinguishes the two units without extra metadata.
                    self.resets_at_epoch_secs =
                        Some(if secs > 10_000_000_000 { secs / 1000 } else { secs });
                }
            }
            _ => {}
        }
        self
    }
}

/// Why a provider has no numbers. Distinguishing these is the whole point —
/// see rule 3 in the module docs.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UsageStatus {
    /// The CLI is not on PATH at all.
    NotInstalled,
    /// Installed, but no credentials on disk — the user has not logged in.
    SignedOut,
    /// Credentials exist but the access token is past its expiry. The CLI
    /// refreshes these itself on next run; we deliberately do not.
    Expired,
    /// Installed, and possibly signed in to the CLI, but this provider meters
    /// its plan on the web and no browser session has been linked yet. Distinct
    /// from `SignedOut` on purpose: the user may well be signed in to the CLI
    /// and still see this, and the fix is "connect the account", not "log in".
    /// See `commands::web_session`.
    NotConnected,
    /// Installed and signed in, but this provider has no usage endpoint we read.
    Unsupported,
    /// We tried and failed. `error` carries the reason.
    Error,
    /// Real numbers in `windows`.
    Ok,
}

/// One row in the usage panel.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    /// Stable provider key: "claude", "codex".
    pub provider: String,
    /// Launch command — ties a row back to `AI_AGENT_PRESETS` on the frontend
    /// so the row can render the agent's real brand mark.
    pub command: String,
    /// Display name: "Claude Code".
    pub name: String,
    pub status: UsageStatus,
    /// Subscription tier as the provider names it ("max", "free", "pro").
    pub plan: Option<String>,
    /// Which account these numbers belong to, for the account-switch case.
    /// An email or an opaque id — whatever the provider exposes.
    pub account: Option<String>,
    pub windows: Vec<UsageWindow>,
    /// OpenAI-issued credits that can reset an eligible Codex limit.
    pub reset_credits_available: Option<u32>,
    pub reset_credits: Vec<ResetCredit>,
    /// Human-readable failure reason. Never contains a token.
    pub error: Option<String>,
    /// A non-failure explanation for an empty or unusual reading — "this plan
    /// has no metered limit". Distinct from `error` so the UI can state a fact
    /// without dressing it as a problem.
    pub note: Option<String>,
    /// When this reading was taken, unix epoch seconds.
    pub fetched_at: i64,
}

impl ProviderUsage {
    fn blank(spec: &ProviderSpec, status: UsageStatus) -> Self {
        Self {
            provider: spec.provider.to_string(),
            command: spec.command.to_string(),
            name: spec.name.to_string(),
            status,
            plan: None,
            account: None,
            windows: Vec::new(),
            reset_credits_available: None,
            reset_credits: Vec::new(),
            error: None,
            note: None,
            fetched_at: now_secs(),
        }
    }

    fn failed(spec: &ProviderSpec, error: impl Into<String>) -> Self {
        let mut usage = Self::blank(spec, UsageStatus::Error);
        usage.error = Some(error.into());
        usage
    }
}

// ---------------------------------------------------------------------------
// The provider table
// ---------------------------------------------------------------------------

/// A known coding CLI: how to detect it, and whether we can read its usage.
///
/// `command` must match the launch command in `AI_AGENT_PRESETS`
/// (`src/lib/stores/runs.ts`) — that string is the join key between this table
/// and the frontend's brand marks and spawn picker.
pub struct ProviderSpec {
    pub provider: &'static str,
    pub command: &'static str,
    /// Other executable names that identify the same CLI on PATH, checked
    /// alongside `command` so an install under a non-obvious binary name is
    /// still detected. The reported and launched command stays `command`.
    pub aliases: &'static [&'static str],
    pub name: &'static str,
    /// Path under `$HOME` holding credentials, if this CLI writes one.
    pub auth_path: Option<&'static [&'static str]>,
    /// A read-only sign-in check command ("copilot auth status"), run once per
    /// scan only when the CLI is installed and no credential file exists.
    /// Used by keychain-backed CLIs whose token never touches disk.
    pub probe: Option<&'static str>,
    /// Whether a fetcher exists below. When false the row still reports
    /// installed/signed-in state, which is useful on its own.
    pub supports_usage: bool,
}

/// Every CLI Spacron knows how to look for.
///
/// Detection is cheap for all of them; only the first two currently report
/// live numbers. The rest are here because "installed and signed in" is worth
/// showing even without a meter — it is what drives auto-detection in the
/// spawn picker.
pub const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        provider: "claude",
        command: "claude",
        aliases: &[],
        name: "Claude Code",
        auth_path: Some(&[".claude", ".credentials.json"]),
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "codex",
        command: "codex",
        aliases: &[],
        name: "Codex CLI",
        auth_path: Some(&[".codex", "auth.json"]),
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "gemini",
        command: "gemini",
        aliases: &[],
        name: "Gemini CLI",
        auth_path: Some(&[".gemini", "oauth_creds.json"]),
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "grok",
        command: "grok",
        aliases: &[],
        name: "Grok CLI",
        auth_path: Some(&[".grok", "auth.json"]),
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "droid",
        command: "droid",
        aliases: &[],
        name: "Factory Droid",
        auth_path: Some(&[".factory", "auth.json"]),
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "opencode",
        command: "opencode",
        aliases: &[],
        name: "OpenCode",
        auth_path: Some(&[".local", "share", "opencode", "auth.json"]),
        probe: None,
        // Reads through a linked browser session, not through the file above —
        // that one holds a Zen API key which authenticates the model endpoints
        // and nothing account-shaped. See `fetch_opencode`.
        supports_usage: true,
    },
    ProviderSpec {
        provider: "cursor",
        command: "cursor-agent",
        aliases: &[],
        name: "Cursor",
        // Not a credential — `cli-config.json` holds permissions and model
        // settings, and Cursor's real auth lives in the IDE's `state.vscdb`
        // plus a web session cookie. Keeping it here means "this file exists",
        // which is a weaker signal than "signed in", but it is the closest
        // thing Cursor writes that is stable; the meter itself reads through
        // the linked browser session (see `fetch_cursor`).
        auth_path: Some(&[".cursor", "cli-config.json"]),
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "copilot",
        command: "copilot",
        aliases: &[],
        name: "GitHub Copilot CLI",
        // Deliberately None. Copilot CLI keeps its token in the OS keychain —
        // `~/.copilot/` holds no credential file. Sign-in is read from the
        // login record it keeps in `~/.copilot/config.json` instead (see
        // `copilot_login_marker`). There is no probe: Copilot CLI 1.x has no
        // `auth` subcommand, so the old `copilot auth status` probe never
        // exited, timed out, and reported every signed-in user as signed out.
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "antigravity",
        command: "agy",
        aliases: &[],
        name: "Antigravity",
        // Deliberately None, for the same reason as Copilot above: Antigravity
        // keeps its OAuth tokens in the OS keychain (Windows Credential Manager
        // holds them under the generic target `gemini:antigravity`), not in a
        // file. `~/.gemini/antigravity-cli/` carries logs, history and settings
        // but no credential, and the `~/.gemini/*.json` files next door belong
        // to the **Gemini CLI**, not to Antigravity — pointing here at
        // `google_accounts.json` (as this entry used to) reported Antigravity as
        // signed in whenever the Gemini CLI had ever logged in, which is a
        // different tool and often a stale file.
        //
        // `auth_path` stays None, but the login is not unknowable: the item's
        // presence in the OS credential store is a marker of its own, read by
        // `antigravity_credential_present` (Windows). That is what lets the
        // badge say "Signed in" here instead of the keychain-blind
        // "Installed" it used to fall back to.
        auth_path: None,
        // No usable usage endpoint — this was checked live, so don't re-derive
        // it from the fact that Antigravity is a Google product:
        //   * `v1internal:retrieveUserQuota` (the Gemini CLI meter below) DOES
        //     answer 200 for an Antigravity token, but it reports the legacy
        //     Code Assist model buckets. Running a real `agy` prompt moved none
        //     of them, so wiring it up here would render a meter that is always
        //     "0% used" — precisely the empty-bar lie rule 3 exists to prevent.
        //   * `v1internal:retrieveUserQuotaSummary` is the RPC behind
        //     Antigravity's own quota UI (groups → buckets, each with a window,
        //     a remaining fraction and a reset time). It is gated on a Google
        //     API key issued from Antigravity's own project: without one it is
        //     403 PERMISSION_DENIED, and with a key from any other project it is
        //     400 "The API Key and the authentication credential are from
        //     different projects". No such key ships in `agy` or in the IDE.
        //   * The CLI's own `quota_manager` never calls it for a consumer login
        //     — a full session logs `doRefreshQuota` three times and issues no
        //     quota request at all.
        // Revisit if Antigravity starts shipping a key, not before.
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "cody",
        command: "cody",
        aliases: &[],
        name: "Cody",
        // No credential file: Cody authenticates through Sourcegraph access
        // tokens handed to the CLI via the documented `SRC_ACCESS_TOKEN` /
        // `CODY_ACCESS_TOKEN` environment variables (see `cody_env_or_marker`
        // below). Spacron launches agents with this same environment, so a set
        // variable is the honest signal — and env-variable auth means there is
        // nothing to read on disk.
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // The remaining presets have no OAuth credential file and no keychain
    // probe either — they take API keys from the environment or from
    // provider-specific configs (Anthropic/OpenAI keys, Goose's
    // `GOOSE_MODE=auto` runtime, API-key logins), which Spacron cannot
    // attribute to a "signed in" state without minting requests. `auth_path:
    // None` + no probe keeps `detects_sign_in` false, so the badge honestly
    // says "Installed" instead of guessing. Amp is the one exception: it
    // writes a plaintext `secrets.json` in the XDG-style path it joins on all
    // three platforms.
    ProviderSpec {
        provider: "pi",
        command: "pi",
        aliases: &[],
        name: "Pi AI Agent",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "hermes",
        command: "hermes",
        aliases: &[],
        name: "Hermes Agent",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "qwen",
        command: "qwen",
        aliases: &[],
        name: "Qwen Code",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "cline",
        command: "cline",
        aliases: &[],
        name: "Cline",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // DeepSeek Harness has no terminal UI: the tile opens a web panel and
    // delegation runs it headless (see `commands/deepseek_harness.rs`). Its key
    // is the DeepSeek one from AI Connections, so there is no auth file.
    ProviderSpec {
        provider: "deepseek-harness",
        command: "dsh",
        aliases: &[],
        name: "DeepSeek Harness",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "amp",
        command: "amp",
        aliases: &[],
        name: "Amp",
        // The one credential file among the API-key/env CLIs: Amp writes its
        // access token (`apiKey@https://ampcode.com/`) to this file, which is
        // what `fetch_amp` reads. See the comment on the neighbouring group.
        auth_path: Some(&[".local", "share", "amp", "secrets.json"]),
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "goose",
        command: "goose",
        aliases: &[],
        name: "Goose",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "kimi",
        command: "kimi",
        aliases: &[],
        name: "Kimi CLI",
        // `~/.kimi/` also holds config.toml, device_id, kimi.json (work dirs),
        // logs and sessions — none of which are credentials. Only the
        // credentials directory means signed in, and it is absent until the
        // user completes a `kimi` login.
        auth_path: Some(&[".kimi", "credentials", "kimi-code.json"]),
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "minimax",
        // No CLI of its own: a MiniMax coding plan is spent through another
        // agent pointed at MiniMax's base URL, so there is no binary to detect
        // and `command` exists only as the brand-mark join key. Listed in
        // `WEB_ONLY_PROVIDERS`, which is what exempts it from the PATH check.
        command: "minimax",
        aliases: &[],
        name: "MiniMax",
        auth_path: None,
        probe: None,
        supports_usage: true,
    },
    ProviderSpec {
        provider: "crush",
        command: "crush",
        aliases: &[],
        name: "Crush",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "aider",
        command: "aider",
        aliases: &[],
        name: "Aider",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // The wider registry, continued — the agent CLIs Orca knows about that
    // Spacron didn't. Detection commands (and the aliases, where the binary a
    // user actually installs differs from the obvious name) are ported from
    // Orca's `TUI_AGENT_CONFIG`, which maintains them against each tool's
    // real installer. None write a credential file Spacron can read and none
    // expose a read-only status probe, so they report "Installed" only — the
    // same honest unknown as pi/hermes above.
    ProviderSpec {
        provider: "openclaude",
        command: "openclaude",
        aliases: &[],
        name: "OpenClaude",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "autohand",
        command: "autohand",
        aliases: &[],
        name: "Autohand",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "ante",
        command: "ante",
        aliases: &[],
        name: "Ante",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // TRAE CN ships `traecli`; the unrelated bytedance/trae-agent also installs
    // a `trae-cli`, so detecting on the unambiguous `traecli` is deliberate.
    ProviderSpec {
        provider: "trae",
        command: "traecli",
        aliases: &[],
        name: "TRAE",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // Qoder (Alibaba) installs `qodercli` from `@qoder-ai/qodercli`. Detecting
    // on `qoder` would miss it — that name belongs to the desktop IDE, not the
    // CLI. Verified against a real 1.1.7 install.
    ProviderSpec {
        provider: "qoder",
        command: "qodercli",
        aliases: &[],
        name: "Qoder",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "mimo",
        command: "mimo",
        aliases: &[],
        name: "Mimo",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "omp",
        command: "omp",
        aliases: &[],
        name: "OMP",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "prime-agent",
        command: "prime-agent",
        aliases: &[],
        name: "Prime Agent",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "kilo",
        command: "kilo",
        aliases: &[],
        name: "Kilo",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // Kiro's installer (cli.kiro.dev) ships `kiro-cli`, not `kiro`.
    ProviderSpec {
        provider: "kiro",
        command: "kiro-cli",
        aliases: &[],
        name: "Kiro",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // Augment ships `auggie`; `aug` is a different tool's name.
    ProviderSpec {
        provider: "aug",
        command: "auggie",
        aliases: &[],
        name: "Augment",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "codebuff",
        command: "codebuff",
        aliases: &[],
        name: "Codebuff",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "freebuff",
        command: "freebuff",
        aliases: &[],
        name: "Freebuff",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // Command Code ships the full name; its `cmd` alias collides with Windows'
    // built-in cmd.exe, so the full name is the detection command.
    ProviderSpec {
        provider: "command-code",
        command: "command-code",
        aliases: &[],
        name: "Command Code",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // Continue's CLI binary is `cn`; `continue` is a shell builtin.
    ProviderSpec {
        provider: "continue",
        command: "cn",
        aliases: &[],
        name: "Continue",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    // Mistral Vibe installs `vibe`; keep the package name as an alias for
    // wrapped installs.
    ProviderSpec {
        provider: "mistral-vibe",
        command: "vibe",
        aliases: &["mistral-vibe"],
        name: "Mistral Vibe",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "rovo",
        command: "rovo",
        aliases: &[],
        name: "Rovo",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "openclaw",
        command: "openclaw",
        aliases: &[],
        name: "OpenClaw",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
    ProviderSpec {
        provider: "devin",
        command: "devin",
        aliases: &[],
        name: "Devin",
        auth_path: None,
        probe: None,
        supports_usage: false,
    },
];

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Parse a UTC ISO-8601 instant (`2026-08-10T23:49:28.867702500Z`) to epoch
/// seconds.
///
/// Deliberately narrow, and deliberately not a date crate. The only thing that
/// reads this is an expiry check, the only producer is a credential file whose
/// format the CLI controls, and the failure mode is "treat as fresh and let the
/// server answer" — none of which justifies a dependency. Sub-second precision
/// is discarded and a non-UTC offset is refused rather than guessed at, because
/// a silently mis-parsed expiry is worse than an unparsed one.
fn iso8601_to_epoch_secs(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once('T')?;
    // Only UTC. Anything carrying an offset would need real timezone handling.
    if !(rest.ends_with('Z') || rest.ends_with('z')) {
        return None;
    }
    let time = &rest[..rest.len() - 1];
    let time = time.split_once('.').map(|(head, _)| head).unwrap_or(time);

    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next().unwrap_or("0").parse().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    // Days since the Unix epoch, via the standard civil-date algorithm (Howard
    // Hinnant's `days_from_civil`), which is exact for any proleptic Gregorian
    // date and needs no lookup tables.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Resolve a spec's credential file, if it declares one and it exists.
///
/// For a provider that supports account switching this resolves the **selected**
/// account rather than unconditionally the one in `$HOME` — otherwise the meter
/// would keep describing the default account after the user switched away from
/// it, which is a worse failure than showing nothing. Everything else, and the
/// default account itself, resolves to the home path exactly as before.
fn auth_file(spec: &ProviderSpec) -> Option<PathBuf> {
    auth_file_for(spec, None)
}

/// As [`auth_file`], but for a *named* account rather than the selected one.
///
/// `None` keeps the existing behaviour exactly — the selected account, falling
/// back to `$HOME` for providers that don't switch. `Some(id)` is what failover
/// uses to ask "how much headroom does that *other* account have", which has to
/// be answerable before a handover rather than after it.
fn auth_file_for(spec: &ProviderSpec, account: Option<&str>) -> Option<PathBuf> {
    if crate::commands::agent_accounts::supports_accounts(spec.provider) {
        let resolved = match account {
            Some(id) => id.to_string(),
            None => crate::commands::agent_accounts::selected_account(spec.provider),
        };
        if let Some(path) =
            crate::commands::agent_accounts::account_credential_path(spec.provider, &resolved)
        {
            return Some(path);
        }
        // An account with no credential yet (directory created, login not
        // finished) is genuinely signed out; falling back to the default
        // account's file here would report the wrong account's numbers.
        if resolved != crate::commands::agent_accounts::DEFAULT_ACCOUNT_ID {
            return None;
        }
        if spec.provider == "codex" && std::env::var_os("CODEX_HOME").is_some_and(|value| !value.is_empty()) {
            return None;
        }
    }
    let segments = spec.auth_path?;
    let mut path = home_dir()?;
    for segment in segments {
        path.push(segment);
    }
    path.is_file().then_some(path)
}

/// Read and parse a credential file. The bytes never leave this function in
/// any form other than the specific fields a fetcher asks for.
fn read_auth_json(path: &PathBuf) -> Result<Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Could not read the credentials file: {e}"))?;
    serde_json::from_str(&text).map_err(|_| "The credentials file is not valid JSON".to_string())
}

/// Where a provider's credential JSON was found, or why it wasn't.
///
/// `Missing` and `Unreadable` are deliberately different: a CLI that was never
/// logged in is *signed out* (a fact worth stating plainly), while a credential
/// we cannot parse is a *failure* the user can act on. Collapsing the two into
/// "signed out" is how a corrupt file turns into a silent wrong answer.
enum Credential {
    Json(Value),
    Missing,
    Unreadable(String),
}

/// OS keychain service holding a CLI's credential JSON, for the CLIs that store
/// it there instead of on disk.
///
/// Claude Code is the one that matters: on macOS it writes its OAuth
/// credentials to the login Keychain, and `~/.claude/.credentials.json` — the
/// only place [`auth_file`] looks — simply never appears. The result was that
/// the flagship meter reported "signed out" on macOS for a user who was signed
/// in, with no way to tell the difference from the UI. On Windows and Linux the
/// same CLI writes the file, which is why the file stays the first thing tried.
///
/// Deliberately **not** `#[cfg(target_os = "macos")]`. Gating it would mean the
/// only compiler that ever sees this code is one nobody here is running, and
/// the cost of not gating it is nil: on Windows and Linux the file lookup
/// answers first for a signed-in user, and for a signed-out one the keychain
/// query finds no such item and returns the same "missing" it would have
/// returned anyway. It also means the day a CLI starts using Credential Manager
/// or secret-service, this already works.
///
/// Handled as a `match` on the provider rather than a `ProviderSpec` field
/// because it is the same shape as the Gemini and Cody markers above: one CLI's
/// quirk, not a dimension every spec needs to answer.
fn keychain_service(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("Claude Code-credentials"),
        _ => None,
    }
}

/// The account name a CLI files its keychain item under: the current user's
/// short name. `USER` is the POSIX spelling, `USERNAME` the Windows one.
fn keychain_account() -> Option<String> {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|user| !user.is_empty())
}

/// Read a provider's credential JSON out of the OS keychain.
///
/// ## The consent prompt, and why failures are memoized
///
/// On macOS the keychain item belongs to Claude Code, not to us, so the first
/// read raises the system's "Spacron wants to use your confidential information
/// stored in Claude Code-credentials" dialog. That is correct and unavoidable —
/// it is macOS asking whether one app may read another's secret, and the honest
/// answer has to come from the user. But the meters poll on a timer, and a
/// dialog that reappears every fifteen minutes because the user said no once is
/// its own bug. So a *failure* (denied, or no such item) is remembered for the
/// life of the process and never retried; a *success* is not cached, so a token
/// the CLI refreshes is picked up on the next poll and a user who chose "Always
/// Allow" sees no further prompts.
///
/// The value read is the same JSON the file holds on other platforms, so every
/// fetcher below parses it identically. It is never logged and never returned
/// to the webview — see this module's rule 2.
fn keychain_credential(provider: &str) -> Credential {
    use std::collections::HashSet;
    use std::sync::Mutex;

    static REFUSED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    let refused_before = |provider: &str| {
        REFUSED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|set| set.contains(provider))
    };
    let refuse = |provider: &str| {
        REFUSED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(HashSet::new)
            .insert(provider.to_string());
    };

    let Some(service) = keychain_service(provider) else {
        return Credential::Missing;
    };
    let Some(account) = keychain_account() else {
        return Credential::Missing;
    };
    if refused_before(provider) {
        return Credential::Missing;
    }

    let read = keyring::Entry::new(service, &account).and_then(|entry| entry.get_password());
    let Ok(secret) = read else {
        refuse(provider);
        return Credential::Missing;
    };

    match serde_json::from_str(&secret) {
        Ok(json) => Credential::Json(json),
        // Present but unparseable is a real failure, not a signed-out state —
        // but it must not re-prompt on every poll either.
        Err(_) => {
            refuse(provider);
            Credential::Unreadable("The keychain credential is not valid JSON".to_string())
        }
    }
}

/// The credential-store target Antigravity files its OAuth tokens under.
///
/// Verified against a signed-in install: `cmdkey /list` reports
/// `LegacyGeneric:target=gemini:antigravity`. That is the Electron `keytar`
/// convention (`service:account`), which is *not* the name `keyring` would
/// build for the same pair — see [`antigravity_credential_present`].
const ANTIGRAVITY_CREDENTIAL_TARGET: &str = "gemini:antigravity";

/// Whether Antigravity has a credential in the OS store.
///
/// Antigravity is the one CLI whose login Spacron can *see* but whose token it
/// deliberately never reads: existence is the whole question a badge asks, so
/// only existence is checked — `CredentialBlob` is never touched, and nothing
/// read here is logged or returned to the webview (rule 2).
///
/// Read straight from the credential store rather than through the `keyring`
/// crate, which cannot address this item: on Windows `keyring` names its
/// entries `{user}.{service}` (Spacron's own stores appear as
/// `github_token.com.samue.spacron`), and `gemini:antigravity` belongs to the
/// colon-joined convention `keytar` writes. Asking `keyring` for it would fail
/// to find a credential that is plainly there.
#[cfg(windows)]
fn antigravity_credential_present() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target: Vec<u16> = ANTIGRAVITY_CREDENTIAL_TARGET
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `target` is NUL-terminated and outlives the call, and `credential`
    // is the out-pointer the API writes on success. A failure leaves it null,
    // which is checked before anything is freed.
    let read = unsafe {
        CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut credential)
    };
    if read.is_err() || credential.is_null() {
        return false;
    }
    // SAFETY: the call succeeded, so this is the allocation it handed back.
    unsafe { CredFree(credential as *const std::ffi::c_void) };
    true
}

/// Everywhere else the token sits in a platform keychain whose item name has not
/// been identified, so the honest answer is "cannot tell" — which the badge
/// renders as its middle state, never as a false "signed out".
#[cfg(not(windows))]
fn antigravity_credential_present() -> bool {
    false
}

/// Whether the OS keychain holds a credential for this provider — the question
/// the accounts list asks, without ever seeing the credential itself.
///
/// Shares [`keychain_credential`]'s memo, so the accounts list and the meters
/// between them raise at most one consent prompt rather than one each.
pub(crate) fn keychain_has_credential(provider: &str) -> bool {
    matches!(keychain_credential(provider), Credential::Json(_))
}

/// A provider's credential JSON, from whichever store actually holds it.
///
/// The file is always tried first — it is the only store on Windows and Linux,
/// it costs no consent prompt, and on macOS a user who migrated from an older
/// install still has one. The keychain is the macOS fallback.
///
/// The fallback is deliberately confined to the **default** account: a managed
/// account (one Spacron created under `CLAUDE_CONFIG_DIR`) that has no
/// credential of its own is genuinely signed out, and answering with the
/// keychain there would report the default account's numbers under a different
/// account's name — the exact confusion [`auth_file`]'s early return exists to
/// prevent. Note the consequence, which is a real macOS limitation rather than
/// something this function can fix: the login Keychain holds one item per CLI,
/// so relocating the config dir does not give a second account its own
/// credential. Claude account switching on macOS therefore moves settings but
/// not the login.
fn credential_json(spec: &ProviderSpec, account: Option<&str>) -> Credential {
    if let Some(path) = auth_file_for(spec, account) {
        return match read_auth_json(&path) {
            Ok(json) => Credential::Json(json),
            Err(e) => Credential::Unreadable(e),
        };
    }
    let resolved = match account {
        Some(id) => id.to_string(),
        None => crate::commands::agent_accounts::selected_account(spec.provider),
    };
    if crate::commands::agent_accounts::supports_accounts(spec.provider)
        && resolved != crate::commands::agent_accounts::DEFAULT_ACCOUNT_ID
    {
        return Credential::Missing;
    }
    keychain_credential(spec.provider)
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// What auto-detection found for one CLI.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub provider: String,
    pub command: String,
    pub name: String,
    /// Resolved on PATH.
    pub installed: bool,
    /// A credentials file exists — the user has logged this CLI in.
    ///
    /// Only meaningful when `detects_sign_in` is true. When that is false this
    /// is always false and means "unknown", not "signed out".
    pub signed_in: bool,
    /// Whether sign-in state is knowable at all for this CLI. False for tools
    /// that keep their token in the OS keychain rather than a file.
    pub detects_sign_in: bool,
    /// A usage fetcher exists for this provider.
    pub supports_usage: bool,
}

/// Auto-detect which agent CLIs are installed, and which are signed in.
///
/// This is what turns "Add core agents" from a list the user has to curate into
/// something the app already knows: a CLI that is both on PATH and holding
/// credentials is one the user has already committed to, and it should appear
/// ready to spawn without being added by hand.
///
/// Sign-in is resolved per provider — credential file, a settings marker, an
/// environment variable, or (for keychain-backed CLIs like Copilot) a bounded
/// run of the CLI's own read-only status command. Probes only run for CLIs that
/// are actually installed, and never on the critical path of anything but a
/// scan.
///
/// `force` bypasses the probe memo (see [`PROBE_TTL`]) — the panel's manual
/// Refresh/Rescan buttons pass it so a just-fixed sign-in is reflected
/// immediately rather than up to a minute later.
#[tauri::command(async)]
pub async fn usage_detect_agents(force: Option<bool>) -> Vec<DetectedAgent> {
    let force = force.unwrap_or(false);
    let detections = PROVIDERS.iter().map(|spec| detect_one(spec, force));
    futures_util::future::join_all(detections).await
}

async fn detect_one(spec: &'static ProviderSpec, force: bool) -> DetectedAgent {
    let installed = which(spec.command).is_some()
        || spec.aliases.iter().any(|alias| which(alias).is_some());
    let signed_in = installed && signed_in_by_file_or_marker(spec, force).await;
    build_detected(spec, installed, signed_in)
}

/// The pure half of detection — what a row reports for a given install/sign-in
/// answer. Kept separate so tests can cover every provider without touching
/// disk or spawning a CLI.
fn build_detected(spec: &ProviderSpec, installed: bool, signed_in: bool) -> DetectedAgent {
    DetectedAgent {
        provider: spec.provider.to_string(),
        command: spec.command.to_string(),
        name: spec.name.to_string(),
        installed,
        signed_in,
        detects_sign_in: spec.auth_path.is_some()
            || spec.probe.is_some()
            || marker_sign_in_detectable(spec.provider),
        supports_usage: spec.supports_usage,
    }
}

/// Resolve one provider's sign-in state, in order of preference:
///
///  1. a credential file exists on disk (the fast, offline check);
///  2. a per-provider marker — Gemini's settings file records the login method
///     (its OAuth token itself lives in the OS keychain), Cody is
///     authenticated through documented environment variables, Copilot
///     records its login in `~/.copilot/config.json`, Antigravity holds a
///     credential item in the OS store;
///  3. a bounded runtime probe of the CLI's own status command, for a
///     provider that declares one.
///
/// Absence is always "not signed in" here, never "unknown" — whether
/// sign-in is knowable at all is `detects_sign_in`, which the UI reads to
/// phrase the badge honestly.
async fn signed_in_by_file_or_marker(spec: &ProviderSpec, force: bool) -> bool {
    if auth_file(spec).is_some() {
        return true;
    }
    // macOS keeps some credentials in the login Keychain instead (Claude Code
    // writes no file there at all). Detection has to agree with the meter, or
    // the spawn picker calls a signed-in CLI signed-out on every Mac.
    if matches!(keychain_credential(spec.provider), Credential::Json(_)) {
        return true;
    }
    match spec.provider {
        "gemini" if gemini_settings_marker() => return true,
        "cody" if cody_env_or_marker() => return true,
        "copilot" if copilot_login_marker() => return true,
        "antigravity" if antigravity_credential_present() => return true,
        _ => {}
    }
    if let Some(probe) = spec.probe {
        return probe_signs_in(probe, force).await;
    }
    false
}

/// Gemini's OAuth token moved into the OS keychain (`gemini-cli-oauth`), so
/// the old `~/.gemini/oauth_creds.json` only exists for migrated or
/// pre-keychain installs — a fresh login leaves nothing on disk. The current
/// CLI still records the chosen auth method in `~/.gemini/settings.json` under
/// `security.auth.selectedType`, and clears it on `/auth logout`, so a
/// Google-login value there is the honest "signed in" marker for modern
/// installs. API-key (`USE_GEMINI`) and Vertex selections don't count — those
/// aren't Google OAuth logins.
fn gemini_settings_marker_from(home: &std::path::Path) -> bool {
    let mut path = home.to_path_buf();
    path.push(".gemini");
    path.push("settings.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let selected = json
        .get("security")
        .and_then(|s| s.get("auth"))
        .and_then(|a| a.get("selectedType"))
        .and_then(Value::as_str)
        .unwrap_or("");
    selected.ends_with("LOGIN_WITH_GOOGLE") || selected.ends_with("COMPUTE_ADC")
}

fn gemini_settings_marker() -> bool {
    home_dir()
        .map(|home| gemini_settings_marker_from(&home))
        .unwrap_or(false)
}

/// Copilot CLI stores its OAuth token in the OS credential store, but records
/// who signed in under `loggedInUsers` in `~/.copilot/config.json` (a JSON file
/// that starts with `//` comment lines). A non-empty list is the on-disk
/// "signed in" marker. The CLI also authenticates from the documented
/// `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` variables, which
/// spawned agents inherit, so those count too.
fn copilot_login_marker_from(home: &std::path::Path) -> bool {
    let mut path = home.to_path_buf();
    path.push(".copilot");
    path.push("config.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let body: String = text
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("
");
    let Ok(json) = serde_json::from_str::<Value>(&body) else {
        return false;
    };
    json.get("loggedInUsers")
        .and_then(Value::as_array)
        .is_some_and(|users| !users.is_empty())
}

fn copilot_login_marker() -> bool {
    ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .any(|name| std::env::var(name).is_ok_and(|v| !v.trim().is_empty()))
        || home_dir()
            .map(|home| copilot_login_marker_from(&home))
            .unwrap_or(false)
}

/// Cody authenticates through Sourcegraph access tokens, which the CLI reads
/// from the documented `SRC_ACCESS_TOKEN` / `CODY_ACCESS_TOKEN` environment
/// variables. Spacron launches agents with this same environment, so a set
/// variable is the honest signal — and, conveniently, it is the same signal a
/// terminal would see, so "signed in here" and "signed in when spawned" can
/// never disagree.
fn cody_env_or_marker() -> bool {
    std::env::var("SRC_ACCESS_TOKEN").is_ok() || std::env::var("CODY_ACCESS_TOKEN").is_ok()
}

/// Providers whose sign-in is knowable through a per-OS marker rather than a
/// credential file or a CLI probe.
///
/// This is the single source of truth for that set: [`build_detected`] derives
/// `detects_sign_in` from it and the mechanism test below asserts the two agree,
/// so a provider that gains a marker cannot end up reporting one without the
/// other.
fn marker_sign_in_detectable(provider: &str) -> bool {
    match provider {
        "gemini" | "cody" | "copilot" => true,
        // Antigravity is only knowable where its credential-store item can be
        // read. Claiming detectability on another platform would turn "we
        // cannot tell" into a wrong "signed out".
        "antigravity" => cfg!(windows),
        _ => false,
    }
}

/// Bounded run of a read-only sign-in check (e.g. `copilot auth status`); a
/// zero exit reads as signed in. The timeout keeps a hung CLI from ever
/// holding up the panel, and any failure is a false "not signed in", which is
/// the safe direction — the badge then reads "Installed" and points at the
/// CLI to fix it rather than claiming a login that isn't there.
/// Last probe outcome per command, each with the time *it* was recorded. `None`
/// until anything is cached. Keyed by the full command string so two probes
/// never share a slot by accident.
static PROBE_CACHE: Mutex<Option<HashMap<String, (SystemTime, bool)>>> = Mutex::new(None);

fn cached_probe(command: &str) -> Option<bool> {
    let guard = PROBE_CACHE.lock().ok()?;
    let (at, signed_in) = guard.as_ref()?.get(command)?;
    at.elapsed()
        .map(|age| age < PROBE_TTL)
        .unwrap_or(false)
        .then_some(*signed_in)
}

fn remember_probe(command: &str, signed_in: bool) {
    if let Ok(mut guard) = PROBE_CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(command.to_string(), (SystemTime::now(), signed_in));
    }
}

async fn probe_signs_in(command: &str, force: bool) -> bool {
    if !force {
        if let Some(cached) = cached_probe(command) {
            return cached;
        }
    }

    let mut parts = command.split_whitespace();
    let Some(program) = parts.next() else {
        return false;
    };
    let Some(path) = which(program) else {
        return false;
    };
    let args: Vec<&str> = parts.collect();
    let Ok(output) = tokio::time::timeout(PROBE_TIMEOUT, async {
        spawn_probe(&path, &args).await
    })
    .await
    else {
        return false;
    };
    let result = output.map(|o| o.status.success()).unwrap_or(false);
    remember_probe(command, result);
    result
}

/// Spawn the probe, wrapping `.cmd`/`.bat` shims in `cmd /C` on Windows.
///
/// `which` resolves an npm-installed CLI (Copilot included) to its `.cmd`
/// shim via `PATHEXT`, and `CreateProcess` cannot execute a `.cmd` directly —
/// without the wrapper the probe would silently always fail on the very
/// platform where it matters most. Other platforms spawn the binary directly.
#[cfg(windows)]
async fn spawn_probe(
    path: &std::path::Path,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    let lower = path.to_string_lossy().to_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        return tokio::process::Command::new("cmd")
            .arg("/C")
            .arg(path)
            .args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output()
            .await;
    }
    tokio::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
}

#[cfg(not(windows))]
async fn spawn_probe(
    path: &std::path::Path,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    // A timed-out probe drops this future; without kill_on_drop the CLI it
    // spawned would keep running in the background.
    tokio::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/// Anthropic's OAuth usage endpoint — the same one Claude Code's own `/usage`
/// screen renders from.
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The endpoint is gated behind this beta header; without it the request 404s.
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";

async fn fetch_claude(
    client: &reqwest::Client,
    spec: &ProviderSpec,
    account: Option<&str>,
) -> ProviderUsage {
    // File first, then the macOS Keychain — see `credential_json`. On macOS the
    // file does not exist at all for a normal install, so without the keychain
    // arm this returned SignedOut for every signed-in Mac user.
    let json = match credential_json(spec, account) {
        Credential::Json(json) => json,
        Credential::Missing => return ProviderUsage::blank(spec, UsageStatus::SignedOut),
        Credential::Unreadable(e) => return ProviderUsage::failed(spec, e),
    };

    let Some(oauth) = json.get("claudeAiOauth") else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };
    let Some(token) = oauth.get("accessToken").and_then(Value::as_str) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };

    // `expiresAt` is unix milliseconds. Report expiry rather than refreshing —
    // rotating a token the CLI owns is how you log the user out of it.
    if let Some(expires_ms) = oauth.get("expiresAt").and_then(Value::as_i64) {
        if expires_ms / 1000 <= now_secs() {
            let mut usage = ProviderUsage::blank(spec, UsageStatus::Expired);
            usage.plan = oauth
                .get("subscriptionType")
                .and_then(Value::as_str)
                .map(str::to_string);
            return usage;
        }
    }

    let response = client
        .get(CLAUDE_USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", CLAUDE_OAUTH_BETA)
        // The endpoint is Claude Code's; it rejects unrecognised clients.
        .header("User-Agent", "claude-code/2.1.0")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return ProviderUsage::blank(spec, UsageStatus::Expired);
    }
    if !response.status().is_success() {
        return ProviderUsage::failed(spec, format!("Anthropic returned {}", response.status()));
    }
    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return ProviderUsage::failed(spec, "Anthropic returned an unreadable response"),
    };

    let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
    usage.plan = oauth
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(str::to_string);
    usage.windows = parse_claude_windows(&body);
    if usage.windows.is_empty() {
        usage.status = UsageStatus::Error;
        usage.error = Some("Anthropic reported no usage windows".to_string());
    }
    usage.note = claude_spend_note(&body);
    usage
}

/// Say so when extra-usage credits are spent.
///
/// Anthropic reports a second allowance next to the plan windows: pay-as-you-go
/// credits that cover you *after* the plan limits are hit. It is deliberately
/// **not** rendered as a third bar — it is not a rate-limit window, and a 100%
/// bar next to "34% session" would read as "you are blocked" when you are not.
/// But once the cap is reached it is exactly the answer to "why did my agent
/// stop", so it earns a one-line note. Silent below the cap.
fn claude_spend_note(body: &Value) -> Option<String> {
    let spend = body.get("spend")?;
    if !spend.get("reached").and_then(Value::as_bool).unwrap_or(false)
        && !body
            .get("extra_usage")
            .and_then(|extra| extra.get("spend_limit_reached"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return None;
    }

    // `amount_minor` + `exponent` is a minor-unit money encoding: 1757 with
    // exponent 2 is 17.57. Formatting it by hand keeps this free of a money
    // crate for one sentence.
    let money = |field: &str| -> Option<String> {
        let node = spend.get(field)?;
        let minor = node.get("amount_minor").and_then(Value::as_i64)?;
        let exponent = node.get("exponent").and_then(Value::as_i64).unwrap_or(2);
        let currency = node
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("USD");
        let divisor = 10i64.checked_pow(exponent.clamp(0, 9) as u32)?;
        Some(format!(
            "{currency} {:.*}",
            exponent.clamp(0, 9) as usize,
            minor as f64 / divisor as f64
        ))
    };

    match (money("used"), money("limit")) {
        (Some(used), Some(limit)) => {
            Some(format!("Extra usage credits spent ({used} of {limit})"))
        }
        _ => Some("Extra usage credits spent".to_string()),
    }
}

/// Pull the windows out of Anthropic's payload.
///
/// Two shapes coexist: named top-level windows (`five_hour`, `seven_day`, and a
/// rotating set of model-scoped ones) and a flat `limits` array. The named ones
/// are read first because their meaning is stable; `limits` then contributes
/// anything model-scoped that the named set does not already cover.
fn parse_claude_windows(body: &Value) -> Vec<UsageWindow> {
    let mut windows = Vec::new();

    let named: [(&str, &str, u64); 2] = [
        ("five_hour", "Session", 300),
        ("seven_day", "Weekly", 10_080),
    ];
    for (key, label, minutes) in named {
        let Some(entry) = body.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        // Newer payloads use `utilization`, older ones `used_percentage`.
        let Some(percent) = entry
            .get("utilization")
            .or_else(|| entry.get("used_percentage"))
            .and_then(Value::as_f64)
        else {
            continue;
        };
        windows.push(
            UsageWindow::new(label, percent)
                .with_window(minutes)
                .with_reset(entry.get("resets_at")),
        );
    }

    // Model-scoped limits (`seven_day_opus` and friends) surface through the
    // `limits` array with a display name attached. Only add ones that carry a
    // scope, so this cannot duplicate the two named windows above.
    if let Some(limits) = body.get("limits").and_then(Value::as_array) {
        for limit in limits {
            let Some(display) = limit
                .get("scope")
                .and_then(|s| s.get("model"))
                .and_then(|m| m.get("display_name"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Some(percent) = limit.get("percent").and_then(Value::as_f64) else {
                continue;
            };
            windows.push(
                UsageWindow::new(display, percent).with_reset(limit.get("resets_at")),
            );
        }
    }

    windows
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

async fn fetch_codex(
    client: &reqwest::Client,
    spec: &ProviderSpec,
    account: Option<&str>,
) -> ProviderUsage {
    let Some(path) = auth_file_for(spec, account) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };
    let json = match read_auth_json(&path) {
        Ok(json) => json,
        Err(e) => return ProviderUsage::failed(spec, e),
    };

    let tokens = json.get("tokens");
    let Some(token) = tokens
        .and_then(|t| t.get("access_token"))
        .and_then(Value::as_str)
    else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };
    let account_id = tokens
        .and_then(|t| t.get("account_id"))
        .and_then(Value::as_str);

    let mut request = client
        .get(CODEX_USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "codex-cli");
    if let Some(id) = account_id {
        request = request.header("chatgpt-account-id", id);
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return ProviderUsage::blank(spec, UsageStatus::Expired);
    }
    if !response.status().is_success() {
        return ProviderUsage::failed(spec, format!("OpenAI returned {}", response.status()));
    }
    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return ProviderUsage::failed(spec, "OpenAI returned an unreadable response"),
    };

    let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
    usage.plan = body.get("plan_type").and_then(Value::as_str).map(str::to_string);
    usage.account = body.get("email").and_then(Value::as_str).map(str::to_string);
    usage.windows = parse_codex_windows(&body);
    usage.reset_credits_available = body
        .get("rate_limit_reset_credits")
        .and_then(|credits| credits.get("available_count"))
        .and_then(Value::as_u64)
        .map(|count| count.min(u32::MAX as u64) as u32);
    if usage.reset_credits_available.unwrap_or(0) > 0 {
        if let Some(credits) = fetch_codex_reset_credits(client, token, account_id).await {
            usage.reset_credits = credits;
        }
    }
    if usage.windows.is_empty() {
        usage.status = UsageStatus::Error;
        usage.error = Some("OpenAI reported no rate-limit windows".to_string());
    }
    usage
}

async fn fetch_codex_reset_credits(
    client: &reqwest::Client,
    token: &str,
    account_id: Option<&str>,
) -> Option<Vec<ResetCredit>> {
    let mut request = client
        .get(CODEX_RESET_CREDITS_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "codex-cli");
    if let Some(id) = account_id {
        request = request.header("chatgpt-account-id", id);
    }

    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    Some(parse_codex_reset_credits(&body))
}

fn parse_codex_reset_credits(body: &Value) -> Vec<ResetCredit> {
    let Some(credits) = body.get("credits").and_then(Value::as_array) else {
        return Vec::new();
    };
    credits
        .iter()
        .filter(|credit| {
            credit
                .get("status")
                .and_then(Value::as_str)
                .map(|status| status == "available")
                .unwrap_or(false)
        })
        .filter_map(|credit| {
            Some(ResetCredit {
                id: credit.get("id")?.as_str()?.to_string(),
                reset_type: credit
                    .get("reset_type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                expires_at_iso: credit
                    .get("expires_at")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

/// Codex names its windows only by length, so the label is derived from
/// `limit_window_seconds` rather than from the key — a "primary window" is five
/// hours on one plan and thirty days on another, and calling both "Session"
/// would be a lie on the second.
fn parse_codex_windows(body: &Value) -> Vec<UsageWindow> {
    let Some(rate_limit) = body.get("rate_limit").filter(|v| !v.is_null()) else {
        return Vec::new();
    };

    ["primary_window", "secondary_window"]
        .iter()
        .filter_map(|key| rate_limit.get(*key).filter(|v| !v.is_null()))
        .filter_map(|window| {
            let percent = window.get("used_percent").and_then(Value::as_f64)?;
            let seconds = window
                .get("limit_window_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let mut entry = UsageWindow::new(&describe_window(seconds), percent)
                .with_reset(window.get("reset_at"));
            if seconds > 0 {
                entry = entry.with_window(seconds / 60);
            }
            Some(entry)
        })
        .collect()
}

/// A window length in seconds as a label a person reads at a glance.
fn describe_window(seconds: u64) -> String {
    match seconds {
        0 => "Usage".to_string(),
        s if s <= 3_600 => "Hourly".to_string(),
        s if s <= 6 * 3_600 => "Session".to_string(),
        s if s <= 36 * 3_600 => "Daily".to_string(),
        s if s <= 10 * 24 * 3_600 => "Weekly".to_string(),
        _ => "Monthly".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

/// xAI's CLI billing endpoint. `?format=credits` returns the credit-shaped
/// payload; the bare URL returns the monthly limit/used pair. Accounts answer
/// one or the other depending on plan, so both are tried.
const GROK_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing";

/// Grok's auth file is keyed by OAuth issuer, and the key carries a per-login
/// suffix (`https://auth.x.ai::<uuid>`), so it has to be matched by prefix.
const GROK_ISSUER_PREFIX: &str = "https://auth.x.ai";

/// Pull the freshest `https://auth.x.ai*` entry out of Grok's auth file.
///
/// Returns `(access_token, user_id)`. Entries are ranked so a live token always
/// beats an expired one — a machine that has logged in twice keeps both.
fn grok_session(json: &Value) -> Option<(String, Option<String>)> {
    let entries = json.as_object()?;
    let now = now_secs();

    let mut best: Option<(bool, &Value)> = None;
    for (issuer, entry) in entries {
        if !issuer.starts_with(GROK_ISSUER_PREFIX) {
            continue;
        }
        // `expires_at` is an ISO-8601 string. This used to compare only the
        // **year**, which cannot tell a live token from one that expired in
        // January of the same year — with one account that merely cost a
        // wasted request (the 401 corrected it), but with two it picks the
        // wrong session and reports the wrong account's numbers. Parsed
        // properly now; an unparseable or missing expiry is still treated as
        // fresh so a format change degrades to "ask and find out".
        let fresh = entry
            .get("expires_at")
            .and_then(Value::as_str)
            .and_then(iso8601_to_epoch_secs)
            .map(|expires| expires > now)
            .unwrap_or(true);
        if best.is_none() || (fresh && !best.as_ref().unwrap().0) {
            best = Some((fresh, entry));
        }
    }

    let entry = best?.1;
    let token = entry.get("key").and_then(Value::as_str)?.to_string();
    let user_id = entry
        .get("user_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((token, user_id))
}

async fn fetch_grok(client: &reqwest::Client, spec: &ProviderSpec) -> ProviderUsage {
    let Some(path) = auth_file(spec) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };
    let json = match read_auth_json(&path) {
        Ok(json) => json,
        Err(e) => return ProviderUsage::failed(spec, e),
    };
    let Some((token, user_id)) = grok_session(&json) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };

    // Credits first, then the plain form. An account answers one shape or the
    // other depending on plan.
    let mut last_status = None;
    for url in [
        format!("{GROK_BILLING_URL}?format=credits"),
        GROK_BILLING_URL.to_string(),
    ] {
        let mut request = client
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("X-XAI-Token-Auth", "xai-grok-cli")
            .header("Accept", "application/json");
        if let Some(id) = &user_id {
            request = request.header("x-userid", id);
        }

        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
        };
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return ProviderUsage::blank(spec, UsageStatus::Expired);
        }
        if !response.status().is_success() {
            last_status = Some(response.status());
            continue;
        }
        let Ok(body) = response.json::<Value>().await else {
            continue;
        };

        let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
        usage.plan = grok_field(&body, "subscriptionTier")
            .and_then(Value::as_str)
            .map(str::to_string);
        usage.windows = parse_grok_windows(&body);
        if usage.windows.is_empty() {
            // A 200 with no percentage is not a failure: it is an account with
            // no metered allowance (`monthlyLimit: 0`). Saying so beats an
            // empty bar that reads as "0% used".
            usage.note = Some("No metered credit limit on this account".to_string());
        }
        return usage;
    }

    match last_status {
        Some(status) => ProviderUsage::failed(spec, format!("xAI returned {status}")),
        None => ProviderUsage::failed(spec, "xAI returned an unreadable response"),
    }
}

/// Grok nests its payload under `config` on some plans and returns it flat on
/// others, so every lookup has to check both.
fn grok_field<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    body.get(key)
        .filter(|v| !v.is_null())
        .or_else(|| body.get("config").and_then(|c| c.get(key)).filter(|v| !v.is_null()))
}

fn parse_grok_windows(body: &Value) -> Vec<UsageWindow> {
    // A period gives the window its label and its reset instant.
    let period = grok_field(body, "currentPeriod");
    let label = period
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .map(|t| match t {
            t if t.ends_with("WEEKLY") => "Weekly",
            t if t.ends_with("DAILY") => "Daily",
            t if t.ends_with("MONTHLY") => "Monthly",
            _ => "Usage",
        })
        .unwrap_or("Billing period");
    let reset = period
        .and_then(|p| p.get("end"))
        .or_else(|| grok_field(body, "billingPeriodEnd"));

    // Preferred: an explicit percentage.
    if let Some(percent) = grok_field(body, "creditUsagePercent").and_then(Value::as_f64) {
        return vec![UsageWindow::new(label, percent).with_reset(reset)];
    }

    // Otherwise derive it from used/limit — but only when there is a real
    // limit. Dividing by a zero allowance would render 0% or NaN and imply a
    // healthy quota where none is configured.
    let used = grok_amount(grok_field(body, "used"));
    let limit = grok_amount(grok_field(body, "monthlyLimit"));
    if let (Some(used), Some(limit)) = (used, limit) {
        if limit > 0.0 {
            return vec![UsageWindow::new(label, used / limit * 100.0).with_reset(reset)];
        }
    }

    Vec::new()
}

/// xAI wraps money/credit amounts as `{ "val": <number|string> }`.
fn grok_amount(value: Option<&Value>) -> Option<f64> {
    let val = value?.get("val")?;
    val.as_f64()
        .or_else(|| val.as_str().and_then(|s| s.parse::<f64>().ok()))
}

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------

const KIMI_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";

/// Moonshot's coding CLI. The plainest of the four: a bearer token in its own
/// credentials file and a single GET that returns both windows.
///
/// Unlike the other three fetchers this one was **not** verified against a live
/// account — the dev machine has `~/.kimi/` but has never completed a login, so
/// no `credentials/` directory exists to read. The endpoint, header set and
/// field names below are taken from a known-working implementation rather than
/// invented, and every parse is optional: a payload that does not match yields
/// no windows and a `note`, never a fabricated bar. If you do have a Kimi
/// subscription, this is the first thing to check against a real response.
async fn fetch_kimi(client: &reqwest::Client, spec: &ProviderSpec) -> ProviderUsage {
    let Some(path) = auth_file(spec) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };
    let json = match read_auth_json(&path) {
        Ok(json) => json,
        Err(e) => return ProviderUsage::failed(spec, e),
    };
    let Some(token) = json.get("access_token").and_then(Value::as_str) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };

    // Same rule as Claude/Codex/Grok: report expiry, never refresh. Rotating
    // someone else's refresh token logs them out of their own CLI.
    if let Some(expires_at) = json.get("expires_at").and_then(Value::as_i64) {
        let secs = if expires_at > 10_000_000_000 { expires_at / 1000 } else { expires_at };
        if secs > 0 && secs <= now_secs() {
            return ProviderUsage::blank(spec, UsageStatus::Expired);
        }
    }

    let response = match client
        .get(KIMI_USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return ProviderUsage::blank(spec, UsageStatus::Expired);
    }
    if !response.status().is_success() {
        let status = response.status();
        return ProviderUsage::failed(spec, format!("Kimi returned {status}"));
    }
    let Ok(body) = response.json::<Value>().await else {
        return ProviderUsage::failed(spec, "Kimi returned an unreadable response");
    };

    let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
    usage.plan = body
        .get("plan")
        .and_then(Value::as_str)
        .map(str::to_string);
    usage.windows = parse_kimi_windows(&body);
    if usage.windows.is_empty() {
        usage.note = Some("Kimi reported no metered limits on this account".to_string());
    }
    usage
}

/// Kimi states a quota twice over: a top-level `usage` object for the long
/// window, and a `limits` array whose entries carry their own `window`
/// description. Both are optional and either can be absent on a given plan.
fn parse_kimi_windows(body: &Value) -> Vec<UsageWindow> {
    let mut windows = Vec::new();

    if let Some(detail) = body.get("usage") {
        if let Some(percent) = kimi_used_percent(detail) {
            windows.push(
                UsageWindow::new("Weekly", percent)
                    .with_window(7 * 24 * 60)
                    .with_reset(kimi_reset(detail)),
            );
        }
    }

    if let Some(entries) = body.get("limits").and_then(Value::as_array) {
        for entry in entries {
            // `detail` holds the counters; the entry itself describes the window.
            let detail = entry.get("detail").unwrap_or(entry);
            let Some(percent) = kimi_used_percent(detail) else {
                continue;
            };
            let minutes = kimi_window_minutes(entry.get("window"));
            let label = match minutes {
                Some(m) if m <= 60 * 6 => "Session",
                Some(m) if m <= 60 * 24 => "Daily",
                Some(_) => "Weekly",
                None => "Limit",
            };
            // The top-level `usage` object already covers the long window; a
            // duplicate row for the same span would read as two separate caps.
            if windows.iter().any(|w: &UsageWindow| w.label == label) {
                continue;
            }
            let mut window = UsageWindow::new(label, percent).with_reset(kimi_reset(detail));
            if let Some(m) = minutes {
                window = window.with_window(m);
            }
            windows.push(window);
        }
    }

    // Most-constrained first, matching every other provider's ordering.
    windows.sort_by(|a, b| b.used_percent.total_cmp(&a.used_percent));
    windows
}

/// `used` when given, otherwise derived from `limit - remaining`. A zero or
/// missing limit yields nothing rather than a 0% bar — "0% of no allowance"
/// reads as a full tank, which is the inversion rule 3 exists to prevent.
fn kimi_used_percent(detail: &Value) -> Option<f64> {
    let limit = detail.get("limit").and_then(Value::as_f64)?;
    if limit <= 0.0 {
        return None;
    }
    let used = match detail.get("used").and_then(Value::as_f64) {
        Some(used) => used,
        None => limit - detail.get("remaining").and_then(Value::as_f64)?,
    };
    Some((used / limit * 100.0).clamp(0.0, 100.0))
}

fn kimi_reset(detail: &Value) -> Option<&Value> {
    detail
        .get("resetTime")
        .or_else(|| detail.get("resetAt"))
        .filter(|v| !v.is_null())
}

/// `{ "duration": 5, "timeUnit": "hour" }` → minutes.
fn kimi_window_minutes(window: Option<&Value>) -> Option<u64> {
    let window = window?;
    let duration = window.get("duration").and_then(Value::as_u64)?;
    let unit = window.get("timeUnit").and_then(Value::as_str)?.to_lowercase();
    let per = match unit.trim_end_matches('s') {
        "minute" | "min" => 1,
        "hour" | "hr" => 60,
        "day" => 60 * 24,
        "week" => 60 * 24 * 7,
        "month" => 60 * 24 * 30,
        _ => return None,
    };
    Some(duration * per)
}

// ---------------------------------------------------------------------------
// Amp
// ---------------------------------------------------------------------------

/// Amp's account-balance RPC — the same endpoint its own CLI's `/usage` screen
/// renders from. JSON-RPC over POST, method `userDisplayBalanceInfo`; the
/// `result` is `BalanceInfoRaw { display_text: String }` (per the ampcode Rust
/// crate's wire types), a formatted string like
/// `Amp Free: $4.30/$10.00 remaining (replenishes +$0.50/hour)`.
const AMP_BALANCE_URL: &str = "https://ampcode.com/api/internal";

/// Amp's meter.
///
/// Amp authenticates with an access token stored in `~/.local/share/amp/
/// secrets.json` under the `apiKey@https://ampcode.com/` key (the same file
/// `auth_path` already points at), so this is a plain credential-file fetch —
/// no keychain, no web session.
///
/// **2026-08-12 caveat, stated like Kimi's:** Amp is not installed on the dev
/// machine, so this could not be exercised against a real account here. The
/// endpoint, the JSON-RPC shape and the display-string formats below come from
/// CodexBar's documented Amp provider and the `ampcode` Rust crate's
/// `BalanceInfoRaw` — both known-working. Every parse is optional: a payload
/// that does not match yields no windows and a `note`, never a fabricated bar.
async fn fetch_amp(client: &reqwest::Client, spec: &ProviderSpec) -> ProviderUsage {
    let Some(path) = auth_file(spec) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };
    let json = match read_auth_json(&path) {
        Ok(json) => json,
        Err(e) => return ProviderUsage::failed(spec, e),
    };
    let token = json
        .as_object()
        .and_then(|map| {
            map.get("apiKey@https://ampcode.com/")
                .or_else(|| map.iter().find(|(k, _)| k.contains("ampcode.com")).map(|(_, v)| v))
        })
        .and_then(Value::as_str);
    let Some(token) = token else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };

    let response = match client
        .post(AMP_BALANCE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"method":"userDisplayBalanceInfo","params":{}}"#)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return ProviderUsage::blank(spec, UsageStatus::Expired);
    }
    if !response.status().is_success() {
        let status = response.status();
        return ProviderUsage::failed(spec, format!("Amp returned {status}"));
    }
    let Ok(body) = response.json::<Value>().await else {
        return ProviderUsage::failed(spec, "Amp returned an unreadable response");
    };
    // JSON-RPC error member on a 200 (e.g. unknown method) is a failure, not
    // an empty balance.
    if let Some(err) = body.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("JSON-RPC error");
        return ProviderUsage::failed(spec, msg.to_string());
    }

    let display = body
        .get("result")
        .and_then(|r| r.get("display_text"))
        .and_then(Value::as_str);
    let Some(display) = display else {
        return ProviderUsage::failed(spec, "Amp returned no balance payload");
    };

    let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
    usage.windows = parse_amp_display_text(display);
    if usage.windows.is_empty() {
        // A signed-in account with no metered balance (e.g. only workspace
        // credits) is a fact, not a failure.
        usage.note = Some("No metered free balance on this account".to_string());
    }
    usage
}

/// Pull usage windows out of Amp's `display_text`.
///
/// The only countable line is the Amp Free meter — it carries both a remaining
/// and a total, so a used-percent exists (`1 - remaining/total`). The hourly
/// replenishment rate, when present, is turned into a reset instant: the free
/// balance refills to full at that rate, so time-to-full is
/// `(total - remaining) / rate` from now. Individual and workspace credit
/// lines are balances without limits — no percent is derivable, so they are
/// deliberately not rendered as bars (a 0% bar next to "$5 left" would lie).
fn parse_amp_display_text(display: &str) -> Vec<UsageWindow> {
    let mut windows = Vec::new();

    // `Amp Free: $4.30/$10.00 remaining (replenishes +$0.50/hour)`
    let free = parse_amp_free_line(display);
    if let Some((remaining, total, rate_per_hour)) = free {
        if total > 0.0 {
            let percent = (1.0 - remaining / total) * 100.0;
            let mut window = UsageWindow::new("Amp Free", percent);
            if rate_per_hour > 0.0 {
                let hours_to_full = (total - remaining) / rate_per_hour;
                window.resets_at_epoch_secs = Some(now_secs() + (hours_to_full * 3600.0) as i64);
            }
            windows.push(window);
        }
    }

    windows
}

/// Parse one `Amp Free: $4.30/$10.00 remaining (replenishes +$0.50/hour)` line.
/// Returns `None` when the shape is not present or a number is missing.
fn parse_amp_free_line(display: &str) -> Option<(f64, f64, f64)> {
    let line = display.lines().find(|l| l.contains("Amp Free:"))?;
    // Every `$<number>` on the line, in order: remaining then total. Reading
    // the amounts straight off the `$` markers is tolerant of the `$` between
    // the slash and the total (and of spacing) in a way marker-slicing never
    // is.
    let amounts: Vec<f64> = line
        .split('$')
        .skip(1)
        .filter_map(amp_leading_number)
        .collect();
    let remaining = *amounts.first()?;
    let total = *amounts.get(1)?;
    let rate = line
        .split("replenishes +")
        .nth(1)
        // The rate arrives as `+$0.50/hour`; strip the `$` the way the amounts
        // above are stripped, then take the leading number.
        .and_then(|rest| amp_leading_number(rest.trim_start_matches('$')))
        .unwrap_or(0.0);
    Some((remaining, total, rate))
}

/// The number that opens `text` (e.g. `0.50/hour` → 0.50).
fn amp_leading_number(text: &str) -> Option<f64> {
    let end = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    text[..end].parse::<f64>().ok()
}

// ---------------------------------------------------------------------------
// OpenCode and MiniMax — the two web-session providers
// ---------------------------------------------------------------------------
//
// Neither of these writes a token we can read. OpenCode's CLI credential
// (`~/.local/share/opencode/auth.json`) is a Zen API key that authenticates
// `zen/v1/responses` and `zen/v1/models` and no account or balance endpoint;
// MiniMax has no Spacron-launched CLI at all — its plan is consumed *through*
// other CLIs pointed at a MiniMax base URL. Both meter on the web, behind a
// session cookie, which `commands::web_session` captures from a real sign-in.
//
// Everything below therefore reads its credential from the keychain rather than
// from disk, and reports `NotConnected` (not `SignedOut`) when there isn't one:
// the user may be perfectly well signed in to the CLI and still need to link a
// browser session, and telling them to "log in" would send them somewhere that
// cannot fix it.

/// Providers with no CLI of their own. `fetch_one` skips its PATH check for
/// these, because there is no binary to find and the row would be dropped as
/// "not installed" forever.
const WEB_ONLY_PROVIDERS: &[&str] = &["minimax"];

fn is_web_only(provider: &str) -> bool {
    WEB_ONLY_PROVIDERS.contains(&provider)
}

/// MiniMax rejects non-browser clients outright, so the usage call presents a
/// real browser UA rather than reqwest's default. Per-platform, matching the
/// machine actually making the request — deliberate, not cargo-culted.
fn browser_user_agent() -> &'static str {
    if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0"
    } else if cfg!(target_os = "macos") {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0"
    } else {
        "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0"
    }
}

const MINIMAX_USAGE_URL: &str =
    "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains";
const MINIMAX_REFERER: &str = "https://platform.minimax.io/console/usage";

/// MiniMax's coding-plan meter.
///
/// Two quirks worth knowing before editing. First, the percentage is
/// **remaining**, not used — `current_interval_remaining_percent` — so it is
/// inverted here at the boundary, the same treatment Google's
/// `remainingFraction` gets. Getting this backwards renders a nearly-spent plan
/// as nearly-full, which is the worst failure this panel has. Second, the API's
/// own `end_time - start_time` drifts below the contracted window (4h, 295min),
/// so the label is pinned to the real 5-hour session rather than recomputed —
/// Codex's fetcher pins 300/10080 for the same reason.
async fn fetch_minimax(client: &reqwest::Client, spec: &ProviderSpec) -> ProviderUsage {
    let Some(cookie) = crate::commands::web_session::stored_cookie(spec.provider) else {
        return ProviderUsage::blank(spec, UsageStatus::NotConnected);
    };

    let group_id = crate::commands::web_session::cookie_value(&cookie, "minimax_group_id_v2");

    let mut request = client
        .get(MINIMAX_USAGE_URL)
        .header("Cookie", &cookie)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", MINIMAX_REFERER)
        .header("User-Agent", browser_user_agent());
    if let Some(group_id) = group_id {
        request = request.header("X-Group-Id", group_id);
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
    };
    // A dead session is an expiry, not a fault — it tells the UI to offer
    // "Reconnect" rather than a retry that will fail the same way.
    if matches!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return ProviderUsage::blank(spec, UsageStatus::Expired);
    }
    if !response.status().is_success() {
        let status = response.status();
        return ProviderUsage::failed(spec, format!("MiniMax returned {status}"));
    }
    let Ok(body) = response.json::<Value>().await else {
        return ProviderUsage::failed(spec, "MiniMax returned an unreadable response");
    };

    // MiniMax answers 200 with the real failure in the envelope, so a non-zero
    // status_code here is an error even though the HTTP call succeeded. An
    // expired cookie sometimes arrives this way rather than as a 401.
    if let Some(code) = body
        .get("base_resp")
        .and_then(|resp| resp.get("status_code"))
        .and_then(Value::as_i64)
    {
        if code != 0 {
            return ProviderUsage::failed(spec, format!("MiniMax returned error {code}"));
        }
    }

    let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
    usage.windows = parse_minimax_windows(&body);
    if usage.windows.is_empty() {
        usage.note = Some("MiniMax reported no coding-plan allowance on this account".to_string());
    }
    usage
}

/// MiniMax's session window, as the plan contracts it rather than as the API
/// reports it. See [`fetch_minimax`].
const MINIMAX_SESSION_MINUTES: u64 = 300;

fn parse_minimax_windows(body: &Value) -> Vec<UsageWindow> {
    let Some(entries) = body.get("model_remains").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut windows: Vec<UsageWindow> = entries
        .iter()
        .filter_map(|entry| {
            let remaining = entry
                .get("current_interval_remaining_percent")
                .and_then(number_like)?;
            // One row per model, labelled by model — an account with a plan on
            // two models has two genuinely different allowances, and collapsing
            // them would hide whichever one is about to run out.
            let label = entry
                .get("model_name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or("Session");
            Some(
                UsageWindow::new(label, 100.0 - remaining)
                    .with_window(MINIMAX_SESSION_MINUTES)
                    .with_reset(entry.get("end_time")),
            )
        })
        .collect();

    windows.sort_by(|a, b| b.used_percent.total_cmp(&a.used_percent));
    windows
}

/// MiniMax returns its percentages as numbers on some plans and as numeric
/// strings on others. Accept both rather than silently dropping a window.
fn number_like(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

const OPENCODE_ORIGIN: &str = "https://opencode.ai";
const OPENCODE_SERVER_URL: &str = "https://opencode.ai/_server";

/// The server-function id for opencode.ai's workspace list. Opaque and
/// hardcoded because the site's RPC layer addresses functions by content hash;
/// there is no discovery endpoint to derive it from. If the workspace lookup
/// starts 404ing, this hash rotating is the first thing to suspect — hence the
/// workspace-id override, which skips this call entirely.
const OPENCODE_WORKSPACES_FN: &str =
    "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";

/// OpenCode's subscription meter.
///
/// The least pleasant fetcher in this file, and worth saying why: opencode.ai
/// publishes no usage API. The numbers exist only inside the rendered
/// `/workspace/{id}/go` page, embedded in React Flight wire format, so this
/// resolves a workspace id and then **scrapes** the page. That is fragile by
/// construction — a rendering change upstream breaks it — so every step fails
/// into a `note` or an `Error`, never into a fabricated number, and the whole
/// thing is skipped when no session is linked.
async fn fetch_opencode(client: &reqwest::Client, spec: &ProviderSpec) -> ProviderUsage {
    let Some(cookie) = crate::commands::web_session::stored_cookie(spec.provider) else {
        return ProviderUsage::blank(spec, UsageStatus::NotConnected);
    };

    let ids = match opencode_workspace_ids(client, &cookie).await {
        Ok(ids) => ids,
        Err(usage) => return usage(spec),
    };
    if ids.is_empty() {
        let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
        usage.note = Some("No OpenCode workspace found on this account".to_string());
        return usage;
    }

    // Try each workspace until one renders usage. An account can hold a
    // workspace it has no plan on, which answers 200 with nothing to parse.
    let mut last_error: Option<String> = None;
    for id in &ids {
        let url = format!("{OPENCODE_ORIGIN}/workspace/{id}/go");
        let response = match client
            .get(&url)
            .header("Cookie", &cookie)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("Referer", OPENCODE_ORIGIN)
            .header("User-Agent", browser_user_agent())
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(describe_network_error(&e));
                continue;
            }
        };
        if matches!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
        ) {
            return ProviderUsage::blank(spec, UsageStatus::Expired);
        }
        if !response.status().is_success() {
            last_error = Some(format!("OpenCode returned {}", response.status()));
            continue;
        }
        let Ok(page) = response.text().await else {
            last_error = Some("OpenCode returned an unreadable page".to_string());
            continue;
        };

        let windows = parse_opencode_windows(&page);
        if !windows.is_empty() {
            let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
            usage.account = Some(id.clone());
            usage.windows = windows;
            return usage;
        }
        last_error = Some("Could not read usage from the OpenCode page".to_string());
    }

    ProviderUsage::failed(
        spec,
        last_error.unwrap_or_else(|| "OpenCode reported no usage".to_string()),
    )
}

/// Ask opencode.ai which workspaces this session can see.
///
/// The error arm returns a constructor rather than a `ProviderUsage` because the
/// caller owns the `spec` — this keeps the RPC details out of `fetch_opencode`
/// without threading the spec through a second function.
async fn opencode_workspace_ids(
    client: &reqwest::Client,
    cookie: &str,
) -> Result<Vec<String>, fn(&ProviderSpec) -> ProviderUsage> {
    let url = format!("{OPENCODE_SERVER_URL}?id={OPENCODE_WORKSPACES_FN}");
    let response = client
        .get(&url)
        .header("Cookie", cookie)
        .header("X-Server-Id", OPENCODE_WORKSPACES_FN)
        .header(
            "Accept",
            "text/javascript, application/json;q=0.9, */*;q=0.8",
        )
        .header("Origin", OPENCODE_ORIGIN)
        .header("Referer", OPENCODE_ORIGIN)
        .header("User-Agent", browser_user_agent())
        .send()
        .await
        .map_err(|_| {
            (|spec: &ProviderSpec| ProviderUsage::failed(spec, "Could not reach OpenCode"))
                as fn(&ProviderSpec) -> ProviderUsage
        })?;

    if matches!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Err(|spec| ProviderUsage::blank(spec, UsageStatus::Expired));
    }
    // Verified against a real linked session on 2026-08-12: an account with no
    // OpenCode subscription gets **500**, not 404 or an empty list — the RPC
    // fails rather than answering "no workspaces". Reporting that as a generic
    // error told the user their meter was broken when the truth is that there
    // is no plan to meter, so it is called out by name. A different 5xx really
    // is a fault and still reads as one.
    if response.status() == reqwest::StatusCode::INTERNAL_SERVER_ERROR {
        return Err(|spec| {
            let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
            usage.note = Some(
                "No OpenCode plan on this account. Usage is only metered for Zen and Go subscribers."
                    .to_string(),
            );
            usage
        });
    }
    if !response.status().is_success() {
        return Err(|spec| ProviderUsage::failed(spec, "OpenCode would not list workspaces"));
    }
    let Ok(text) = response.text().await else {
        return Err(|spec| ProviderUsage::failed(spec, "OpenCode returned an unreadable list"));
    };
    Ok(parse_opencode_workspace_ids(&text))
}

/// Pull `wrk_…` / `wk_…` ids out of the serialised RPC response, in order and
/// deduped. Anchored on an `id:` key so unrelated identifiers in the same
/// payload don't get mistaken for workspaces.
fn parse_opencode_workspace_ids(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let mut cursor = 0usize;

    while let Some(found) = text[cursor..].find("id") {
        let start = cursor + found;
        cursor = start + 2;
        // Require a word boundary before `id` so `uuid:` / `grid:` don't match.
        if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
            continue;
        }
        let rest = text[start + 2..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = match rest.strip_prefix('"').or_else(|| rest.strip_prefix('\'')) {
            Some(rest) => rest,
            None => continue,
        };
        let end = rest.find(['"', '\'']).unwrap_or(0);
        let value = &rest[..end];
        if (value.starts_with("wrk_") || value.starts_with("wk_"))
            && value.len() > 4
            && value
                .trim_start_matches("wrk_")
                .trim_start_matches("wk_")
                .chars()
                .all(|c| c.is_ascii_alphanumeric())
            && !ids.iter().any(|existing| existing == value)
        {
            ids.push(value.to_string());
        }
    }

    ids
}

/// The three windows OpenCode renders, if the page carries them.
///
/// `monthly` is optional — it only appears on plans that have one — while a
/// missing rolling or weekly block means the parse failed and the caller should
/// treat the page as unreadable rather than report a partial meter.
fn parse_opencode_windows(page: &str) -> Vec<UsageWindow> {
    // Defensive bound: this parses a document we don't control, and a runaway
    // payload should cost nothing rather than scan for seconds.
    if page.is_empty() || page.len() > 10_000_000 {
        return Vec::new();
    }

    let rolling = opencode_usage_block(page, "rollingUsage");
    let weekly = opencode_usage_block(page, "weeklyUsage");
    let (Some(rolling), Some(weekly)) = (rolling, weekly) else {
        return Vec::new();
    };

    let mut windows = vec![
        UsageWindow::new("Session", rolling.0)
            .with_window(300)
            .with_reset(Some(&Value::from(now_secs() + rolling.1))),
        UsageWindow::new("Weekly", weekly.0)
            .with_window(7 * 24 * 60)
            .with_reset(Some(&Value::from(now_secs() + weekly.1))),
    ];
    if let Some(monthly) = opencode_usage_block(page, "monthlyUsage") {
        windows.push(
            UsageWindow::new("Monthly", monthly.0)
                .with_window(30 * 24 * 60)
                .with_reset(Some(&Value::from(now_secs() + monthly.1))),
        );
    }

    windows.sort_by(|a, b| b.used_percent.total_cmp(&a.used_percent));
    windows
}

/// Find `key: { … usagePercent: N … resetInSec: N … }` in the page and return
/// both numbers.
///
/// Three things make this harder than a regex. The wire format inserts a
/// reference token between the colon and the brace (`key:$R[28]={…}`), so the
/// opening brace has to be *searched for* rather than assumed. The same key
/// appears more than once — usually with the real object in one place and
/// `null` in another component's props — so every occurrence is tried until one
/// carries both fields. And the fields must be read at the object's own depth,
/// since a nested sub-object can repeat the name with a different value.
fn opencode_usage_block(page: &str, key: &str) -> Option<(f64, i64)> {
    let mut cursor = 0usize;

    while let Some(found) = page[cursor..].find(key) {
        let start = cursor + found;
        cursor = start + key.len();

        // Everything between the key and its value, absolute-indexed so no
        // pointer arithmetic is needed to get back to the page.
        let tail = &page[cursor..];
        let Some(colon) = tail.find(':').filter(|at| tail[..*at].trim().is_empty()) else {
            continue;
        };
        // Skip over a `$R[28]=` style reference token to reach the brace. The
        // window is deliberately short so a `key:null` occurrence can't reach
        // forward into an unrelated object further down the page.
        let after_colon = cursor + colon + 1;
        // Byte-count the lookahead by characters: this is arbitrary UTF-8 from
        // a page we don't control, and slicing to a fixed byte offset would
        // panic the moment a multi-byte character straddles it.
        let Some(brace_offset) = page[after_colon..]
            .char_indices()
            .take(30)
            .find(|(_, ch)| *ch == '{')
            .map(|(offset, _)| offset)
        else {
            continue;
        };

        let Some(block) = balanced_block(page, after_colon + brace_offset) else {
            continue;
        };
        let percent = top_level_number(block, "usagePercent");
        let reset = top_level_number(block, "resetInSec");
        if let (Some(percent), Some(reset)) = (percent, reset) {
            return Some((percent.clamp(0.0, 100.0), reset as i64));
        }
    }

    None
}

/// The brace-balanced slice starting at `open`, or None if it never closes.
fn balanced_block(text: &str, open: usize) -> Option<&str> {
    let mut depth = 0i32;
    for (offset, ch) in text[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[open..open + offset + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Read a numeric field that belongs to this object rather than to one nested
/// inside it. Depth is tracked explicitly because the same field name recurs in
/// sub-objects with different values, and a plain search would take whichever
/// came first.
fn top_level_number(block: &str, field: &str) -> Option<f64> {
    let mut depth = 0i32;
    let bytes = block.as_bytes();

    for (index, ch) in block.char_indices() {
        match ch {
            '{' => {
                depth += 1;
                continue;
            }
            '}' => {
                depth -= 1;
                continue;
            }
            _ => {}
        }
        if depth != 1 || !block[index..].starts_with(field) {
            continue;
        }
        // Word boundary, so `usagePercentile` never satisfies `usagePercent`.
        if index > 0 && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_') {
            continue;
        }
        let rest = block[index + field.len()..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
            .unwrap_or(rest.len());
        if let Ok(value) = rest[..end].parse::<f64>() {
            return Some(value);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/// Cursor's dashboard usage endpoint — the one the "Models" page draws its
/// bars from. Undocumented; the shape below is the field set ai-usagebar and
/// CodexBar (both confirmed against real accounts) read, and every parse here
/// is optional so a changed payload yields a `note`, never a fabricated bar.
const CURSOR_USAGE_URL: &str = "https://cursor.com/api/usage-summary";

/// Cursor's meter.
///
/// Cursor has no CLI credential file we can read — its auth lives in the IDE's
/// `state.vscdb` and, for the web, in a session cookie — so this reads through
/// a linked browser session (`commands::web_session`), exactly like OpenCode
/// and MiniMax. No cookie, no numbers: the row says `NotConnected` and offers
/// the connect button, not a guessed bar.
///
/// **2026-08-12 caveat, stated like Kimi's:** the endpoint and wire shape come
/// from known-working third-party implementations, not from a live probe on
/// this machine — cursor.com is unreachable from the dev network (DNS blocked
/// at the resolver), so the fetcher could not be exercised against a real
/// account here. Every parse is optional and the payload's own display strings
/// are the fallback, so a mismatch degrades to a `note` rather than a wrong
/// number. If you have a Cursor plan on an unblocked network, this is the
/// first thing to check against a real response.
async fn fetch_cursor(client: &reqwest::Client, spec: &ProviderSpec) -> ProviderUsage {
    let Some(cookie) = crate::commands::web_session::stored_cookie(spec.provider) else {
        return ProviderUsage::blank(spec, UsageStatus::NotConnected);
    };

    let response = match client
        .get(CURSOR_USAGE_URL)
        .header("Cookie", &cookie)
        // The endpoint is the dashboard's; it rejects non-browser clients the
        // way MiniMax's does, so present a browser UA rather than reqwest's.
        .header("User-Agent", browser_user_agent())
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
    };
    // A dead session is an expiry, not a fault — it tells the UI to offer
    // "Reconnect" rather than a retry that will fail the same way.
    if matches!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return ProviderUsage::blank(spec, UsageStatus::Expired);
    }
    if !response.status().is_success() {
        let status = response.status();
        return ProviderUsage::failed(spec, format!("Cursor returned {status}"));
    }
    let Ok(body) = response.json::<Value>().await else {
        return ProviderUsage::failed(spec, "Cursor returned an unreadable response");
    };

    let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
    usage.plan = body
        .get("membershipType")
        .and_then(Value::as_str)
        .map(str::to_string);
    usage.windows = parse_cursor_windows(&body);
    if usage.windows.is_empty() {
        // An unlimited plan is a real 200 with nothing to meter; saying so
        // beats an empty bar that reads as "0% used".
        usage.note = Some(
            if body.get("isUnlimited").and_then(Value::as_bool).unwrap_or(false) {
                "This plan has no metered limit".to_string()
            } else {
                "Cursor reported no usage windows on this account".to_string()
            },
        );
    }
    usage
}

/// Pull the usage windows out of Cursor's payload.
///
/// Personal accounts carry the percentages directly on
/// `individualUsage.plan`: `totalPercentUsed` is the included plan allowance
/// (CodexBar's primary), `autoPercentUsed` the Auto/Composer pool, and
/// `apiPercentUsed` the named-model pool — three genuinely different caps on
/// plans that meter them separately, so each becomes its own window. Reset is
/// the billing-cycle end the payload states in ISO-8601.
///
/// Team and token-based enterprise accounts publish **no** percentages at all
/// (the field `individualUsage.overall.limit` arrives null), only the two
/// human-readable display messages — "You've used 42% of your included total
/// usage" — which line up with the auto and named pools respectively. They are
/// accepted **only when both parse**: one stray message is schema drift, not a
/// half-guessed snapshot. A payload with neither shape yields nothing.
fn parse_cursor_windows(body: &Value) -> Vec<UsageWindow> {
    let reset = body.get("billingCycleEnd").filter(|v| !v.is_null());
    let mut windows = Vec::new();

    // No early return here on purpose: a `plan` that exists but is empty (or
    // carries none of the three fields) must still fall through to the display
    // message branch below, or a reshaped payload would lose its only numbers.
    if let Some(plan) = body.get("individualUsage").and_then(|u| u.get("plan")) {
        for (field, label) in [
            ("totalPercentUsed", "Monthly"),
            ("autoPercentUsed", "Auto"),
            ("apiPercentUsed", "API"),
        ] {
            if let Some(percent) = plan.get(field).and_then(Value::as_f64) {
                windows.push(UsageWindow::new(label, percent).with_reset(reset));
            }
        }
    }

    if !windows.is_empty() {
        return windows;
    }

    let auto = body
        .get("autoModelSelectedDisplayMessage")
        .and_then(Value::as_str)
        .and_then(cursor_percent_from_message);
    let named = body
        .get("namedModelSelectedDisplayMessage")
        .and_then(Value::as_str)
        .and_then(cursor_percent_from_message);
    if let (Some(auto), Some(named)) = (auto, named) {
        windows.push(UsageWindow::new("Auto", auto).with_reset(reset));
        windows.push(UsageWindow::new("API", named).with_reset(reset));
    }

    windows
}

/// "You've used 42% of your included total usage" → 42.0. Takes the number
/// immediately before the first `%`; anything without one yields nothing.
fn cursor_percent_from_message(text: &str) -> Option<f64> {
    let head = text.split('%').next()?;
    let number = head
        .rsplit(|c: char| !c.is_ascii_digit() && c != '.')
        .next()?;
    number.parse::<f64>().ok()
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/// Note on the state of this one: Google now answers `loadCodeAssist` for a
/// consumer account with `UNSUPPORTED_CLIENT` — "migrate to the Antigravity
/// suite" — so the Gemini CLI's free tier is on its way out. The quota endpoint
/// below still answers 200 with real buckets, so the meter stays; if it ever
/// starts 403ing, that is the reason, and Antigravity is not a substitute for it
/// (see the `antigravity` entry in `PROVIDERS`).
const GEMINI_QUOTA_URL: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// The Gemini CLI's own OAuth client.
///
/// Not a secret in any meaningful sense: this is an *installed-application*
/// client, which Google documents as being unable to keep a secret, and both
/// values ship in cleartext inside the open-source `@google/gemini-cli` npm
/// package already sitting on the user's disk. They are constants here only so
/// the refresh below can be attributed to the same client that minted the
/// token — using a different client id would simply be rejected.
const GEMINI_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET: &str = "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";

async fn fetch_gemini(client: &reqwest::Client, spec: &ProviderSpec) -> ProviderUsage {
    let Some(path) = auth_file(spec) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };
    let json = match read_auth_json(&path) {
        Ok(json) => json,
        Err(e) => return ProviderUsage::failed(spec, e),
    };
    let Some(access) = json.get("access_token").and_then(Value::as_str) else {
        return ProviderUsage::blank(spec, UsageStatus::SignedOut);
    };

    // Gemini's access tokens last an hour, so an expired one is the *normal*
    // case rather than an edge case, and reporting "expired, go run the CLI"
    // would leave this meter blank almost always.
    //
    // This is the one place we mint a token, and it is safe here specifically
    // because Google's installed-app refresh tokens are REUSABLE — refreshing
    // does not rotate or invalidate the CLI's copy, unlike Anthropic's and
    // OpenAI's. Two further rules keep it honest:
    //   * the new access token is held in memory for this one request and is
    //     NEVER written back to `oauth_creds.json`, so the file stays exactly
    //     as the CLI left it;
    //   * we only refresh when the stored token has actually expired.
    // Do not copy this branch to another provider without checking that its
    // refresh tokens are reusable too — see rule 1 in the module docs.
    let expired = json
        .get("expiry_date")
        .and_then(Value::as_i64)
        .map(|ms| ms / 1000 <= now_secs())
        .unwrap_or(false);

    let token = if expired {
        let Some(refresh) = json.get("refresh_token").and_then(Value::as_str) else {
            return ProviderUsage::blank(spec, UsageStatus::Expired);
        };
        match refresh_google_token(client, refresh).await {
            Some(fresh) => fresh,
            None => return ProviderUsage::blank(spec, UsageStatus::Expired),
        }
    } else {
        access.to_string()
    };

    let response = client
        .post(GEMINI_QUOTA_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(e) => return ProviderUsage::failed(spec, describe_network_error(&e)),
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return ProviderUsage::blank(spec, UsageStatus::Expired);
    }
    if !response.status().is_success() {
        return ProviderUsage::failed(spec, format!("Google returned {}", response.status()));
    }
    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return ProviderUsage::failed(spec, "Google returned an unreadable response"),
    };

    let mut usage = ProviderUsage::blank(spec, UsageStatus::Ok);
    usage.windows = parse_gemini_windows(&body);
    if usage.windows.is_empty() {
        usage.note = Some("No quota buckets reported".to_string());
    }
    usage
}

/// Exchange a refresh token for a short-lived access token. Returns `None` on
/// any failure — the caller reports `Expired`, which is the honest outcome.
async fn refresh_google_token(client: &reqwest::Client, refresh_token: &str) -> Option<String> {
    let response = client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", GEMINI_CLIENT_ID),
            ("client_secret", GEMINI_CLIENT_SECRET),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    body.get("access_token")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Google reports quota per model as a **remaining** fraction, which is the
/// inverse of every other provider here. Converting it at the boundary is what
/// keeps `UsageWindow::used_percent` meaning one thing everywhere — get this
/// backwards and a full tank renders as an exhausted one.
fn parse_gemini_windows(body: &Value) -> Vec<UsageWindow> {
    let buckets = body
        .get("buckets")
        .and_then(Value::as_array)
        .or_else(|| body.as_array());
    let Some(buckets) = buckets else {
        return Vec::new();
    };

    let mut windows = Vec::new();
    for bucket in buckets {
        let Some(remaining) = bucket.get("remainingFraction").and_then(Value::as_f64) else {
            continue;
        };
        let label = bucket
            .get("modelId")
            .and_then(Value::as_str)
            .unwrap_or("Requests");
        // Skip duplicate model rows — the endpoint repeats a model when it has
        // more than one token type, and two identical bars help nobody.
        if windows.iter().any(|w: &UsageWindow| w.label == label) {
            continue;
        }
        windows.push(
            UsageWindow::new(label, (1.0 - remaining) * 100.0)
                .with_reset(bucket.get("resetTime")),
        );
    }
    windows
}

/// Turn a transport failure into something a user can act on, without leaking
/// the request URL (which carries no secret today, but would if a future
/// provider used a query-string token).
fn describe_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The usage request timed out".to_string()
    } else if error.is_connect() {
        "Could not reach the provider. Check your connection.".to_string()
    } else {
        "The usage request failed".to_string()
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

struct CachedUsage {
    usage: ProviderUsage,
    at: SystemTime,
}

/// Last good reading per provider.
///
/// Two jobs: it keeps a burst of panel opens down to one request, and it lets a
/// transient network failure fall back to the previous numbers with their own
/// timestamp instead of blanking the meter. A meter that flickers to empty
/// whenever the wifi hiccups trains the user to distrust it.
static CACHE: Mutex<Option<HashMap<String, CachedUsage>>> = Mutex::new(None);

/// The cache key for one reading.
///
/// Keyed by provider *and* account, not provider alone. Failover reads a
/// non-selected account's headroom through the same fetchers, and a shared key
/// would let the work account's numbers be served for the personal one — a
/// handover decided on the wrong meter, which is the specific mistake this
/// feature exists to avoid.
fn cache_key(provider: &str, account: Option<&str>) -> String {
    let selected = if crate::commands::agent_accounts::supports_accounts(provider) {
        Some(account.map(str::to_string).unwrap_or_else(|| crate::commands::agent_accounts::selected_account(provider)))
    } else {
        account.map(str::to_string)
    };
    match selected {
        Some(id) => format!("{provider}@{id}"),
        None => provider.to_string(),
    }
}

fn cached(provider: &str, account: Option<&str>, ttl: Duration) -> Option<ProviderUsage> {
    let guard = CACHE.lock().ok()?;
    let entry = guard.as_ref()?.get(&cache_key(provider, account))?;
    let fresh = entry.at.elapsed().map(|e| e < ttl).unwrap_or(false);
    fresh.then(|| entry.usage.clone())
}

fn remember(usage: &ProviderUsage, account: Option<&str>) {
    if let Ok(mut guard) = CACHE.lock() {
        guard.get_or_insert_with(HashMap::new).insert(
            cache_key(&usage.provider, account),
            CachedUsage {
                usage: usage.clone(),
                at: SystemTime::now(),
            },
        );
    }
}

/// The previous reading regardless of age, used to survive a transient failure.
fn last_good(provider: &str, account: Option<&str>) -> Option<ProviderUsage> {
    let guard = CACHE.lock().ok()?;
    let entry = guard.as_ref()?.get(&cache_key(provider, account))?;
    (entry.usage.status == UsageStatus::Ok).then(|| entry.usage.clone())
}

/// Read usage for every provider that has a fetcher, concurrently.
///
/// `force` skips the freshness cache — it backs the panel's manual refresh, so
/// a user who just hit a limit can see it immediately rather than up to a
/// minute later.
#[tauri::command(async)]
pub async fn usage_fetch_all(force: Option<bool>) -> Vec<ProviderUsage> {
    let force = force.unwrap_or(false);
    let ttl = if force { Duration::ZERO } else { CACHE_TTL };

    let client = match reqwest::Client::builder().timeout(FETCH_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => {
            return PROVIDERS
                .iter()
                .filter(|spec| spec.supports_usage)
                .map(|spec| ProviderUsage::failed(spec, "Could not start the usage client"))
                .collect()
        }
    };

    let fetches = PROVIDERS
        .iter()
        .filter(|spec| spec.supports_usage)
        .map(|spec| fetch_one(&client, spec, ttl, None));

    futures_util::future::join_all(fetches).await
}

/// One account's headroom, for the failover ladder.
///
/// The panel shows the *selected* account. This shows every account, which is a
/// different question and only failover asks it: before moving unfinished work
/// to another login, Spacron has to know that login has room — "same plan, same
/// limit" is otherwise a handoff straight into a second stop.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub provider: String,
    pub account_id: String,
    /// Email where the CLI records one, else the account id. Never a token.
    pub label: String,
    /// Whether this account is the user's current selection for that CLI.
    pub active: bool,
    /// Whether this account resolves to a login that is genuinely its own.
    ///
    /// False for a managed Claude account on macOS, where the login Keychain
    /// holds one item per CLI and a relocated config dir shares the default
    /// account's credential. Handing work to such an account would hand it back
    /// to the login that just ran out, so the ladder skips it rather than
    /// hopping into the same limit under a different name.
    pub distinct_login: bool,
    pub usage: ProviderUsage,
}

/// Read usage for **every** account of every account-capable CLI.
///
/// Concurrent across accounts, and it shares [`fetch_one`]'s per-account cache,
/// so the failover watch adds no extra network traffic over the panel's own
/// poll for whichever account happens to be selected.
#[tauri::command(async)]
pub async fn usage_fetch_accounts(force: Option<bool>) -> Vec<AccountUsage> {
    use crate::commands::agent_accounts as accounts;

    let force = force.unwrap_or(false);
    let ttl = if force { Duration::ZERO } else { CACHE_TTL };

    let Ok(client) = reqwest::Client::builder().timeout(FETCH_TIMEOUT).build() else {
        return Vec::new();
    };

    let mut jobs = Vec::new();
    for spec in PROVIDERS.iter().filter(|spec| spec.supports_usage) {
        if !accounts::supports_accounts(spec.provider) {
            continue;
        }
        let selected = accounts::selected_account(spec.provider);
        for id in accounts::account_ids(spec.provider) {
            let distinct_login = accounts::has_own_login(spec.provider, &id);
            let label = accounts::account_label(spec.provider, &id);
            let active = id == selected;
            let client = &client;
            jobs.push(async move {
                // An account with no login of its own is never read. On macOS
                // that read would return the *default* account's numbers under
                // this account's name, which is worse than no reading at all.
                let usage = if distinct_login {
                    fetch_one(client, spec, ttl, Some(&id)).await
                } else {
                    let mut blank = ProviderUsage::blank(spec, UsageStatus::SignedOut);
                    blank.note = Some(
                        "This account shares the CLI's system-keychain login, so it has no                          headroom of its own."
                            .to_string(),
                    );
                    blank
                };
                AccountUsage {
                    provider: spec.provider.to_string(),
                    account_id: id,
                    label,
                    active,
                    distinct_login,
                    usage,
                }
            });
        }
    }

    futures_util::future::join_all(jobs).await
}

async fn fetch_one(
    client: &reqwest::Client,
    spec: &'static ProviderSpec,
    ttl: Duration,
    // `account`: which account to read. `None` means the selected one — the
    // ordinary panel path, unchanged.
    account: Option<&str>,
) -> ProviderUsage {
    // A CLI that is not installed cannot be signed in; skip the disk and the
    // network entirely. Checked BEFORE the freshness cache so an uninstall
    // clears immediately — the cached reading (and its `remember`ed blank)
    // must never serve a CLI that no longer exists, or "I uninstalled it and
    // it's still there" becomes a one-minute lie. Likewise a fresh install
    // skips the stale NotInstalled cache entry and fetches for real.
    // Web-only providers have no binary to find — MiniMax's plan is consumed
    // through whichever CLI you point at it — so a PATH check would drop the
    // row permanently. They gate on a linked session instead, below.
    if !is_web_only(spec.provider) && which(spec.command).is_none() {
        let usage = ProviderUsage::blank(spec, UsageStatus::NotInstalled);
        remember(&usage, account);
        return usage;
    }
    // An unconnected web-only provider is reported as not installed so the
    // frontend's existing filter drops it: a MiniMax row is noise to everyone
    // who doesn't have a MiniMax plan, and Settings is where you go to link one.
    // An unconnected provider that *does* have a CLI (OpenCode) stays visible
    // and says `NotConnected`, because there the row is the discoverable place
    // to connect from.
    if is_web_only(spec.provider)
        && crate::commands::web_session::stored_cookie(spec.provider).is_none()
    {
        let usage = ProviderUsage::blank(spec, UsageStatus::NotInstalled);
        remember(&usage, account);
        return usage;
    }

    if !ttl.is_zero() {
        if let Some(hit) = cached(spec.provider, account, ttl) {
            return hit;
        }
    }

    let usage = match spec.provider {
        "claude" => fetch_claude(client, spec, account).await,
        "codex" => fetch_codex(client, spec, account).await,
        "grok" => fetch_grok(client, spec).await,
        "gemini" => fetch_gemini(client, spec).await,
        "kimi" => fetch_kimi(client, spec).await,
        "amp" => fetch_amp(client, spec).await,
        "opencode" => fetch_opencode(client, spec).await,
        "minimax" => fetch_minimax(client, spec).await,
        "cursor" => fetch_cursor(client, spec).await,
        _ => ProviderUsage::blank(spec, UsageStatus::Unsupported),
    };

    // A failed poll keeps the last real numbers on screen, marked with their own
    // (older) timestamp, rather than replacing them with an error state.
    if usage.status == UsageStatus::Error {
        if let Some(previous) = last_good(spec.provider, account) {
            return previous;
        }
    }

    remember(&usage, account);
    usage
}

#[cfg(test)]
mod web_provider_tests {
    use super::*;

    // -----------------------------------------------------------------------
    // MiniMax
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Expiry parsing (Grok)
    // -----------------------------------------------------------------------

    #[test]
    fn iso_instants_parse_to_the_right_epoch_second() {
        assert_eq!(iso8601_to_epoch_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso8601_to_epoch_secs("2000-01-01T00:00:00Z"), Some(946_684_800));
        // A real value out of this machine's ~/.grok/auth.json, with the
        // nine-digit fractional seconds the CLI writes.
        assert_eq!(
            iso8601_to_epoch_secs("2026-08-10T23:49:28.867702500Z"),
            // Cross-checked against `Date.parse`, not derived from this parser.
            Some(1_786_405_768)
        );
        // Leap day, to prove the civil-date maths rather than assume it.
        assert_eq!(iso8601_to_epoch_secs("2024-02-29T12:00:00Z"), Some(1_709_208_000));
    }

    #[test]
    fn an_expiry_earlier_in_the_same_year_is_not_fresh() {
        // The whole point of replacing the old year-only compare: these two
        // differ, and the previous implementation called both fresh.
        let january = iso8601_to_epoch_secs("2026-01-01T00:00:00Z").unwrap();
        let december = iso8601_to_epoch_secs("2026-12-31T23:59:59Z").unwrap();
        assert!(january < december);
        assert!(january < now_secs(), "January 2026 should be in the past");
        assert!(december > now_secs(), "December 2026 should be in the future");
    }

    #[test]
    fn an_unparseable_expiry_is_refused_rather_than_guessed() {
        // Callers treat None as "fresh, ask the server" — but a wrong number
        // would silently select the wrong account, so nothing is invented.
        assert_eq!(iso8601_to_epoch_secs(""), None);
        assert_eq!(iso8601_to_epoch_secs("2026-08-10"), None);
        assert_eq!(iso8601_to_epoch_secs("not a date"), None);
        // A non-UTC offset needs real timezone handling; refused, not assumed.
        assert_eq!(iso8601_to_epoch_secs("2026-08-10T23:49:28+02:00"), None);
        assert_eq!(iso8601_to_epoch_secs("2026-13-10T00:00:00Z"), None);
        assert_eq!(iso8601_to_epoch_secs("2026-08-10T25:00:00Z"), None);
    }

    // -----------------------------------------------------------------------
    // Claude overage note
    // -----------------------------------------------------------------------

    #[test]
    fn spent_overage_credits_are_called_out_with_real_amounts() {
        // Trimmed from a real 200 response on a plan that had exhausted them.
        let body: Value = serde_json::from_str(
            r#"{ "spend": {
                    "used":  { "amount_minor": 1757, "currency": "USD", "exponent": 2 },
                    "limit": { "amount_minor": 1700, "currency": "USD", "exponent": 2 },
                    "reached": true } }"#,
        )
        .unwrap();
        assert_eq!(
            claude_spend_note(&body).as_deref(),
            Some("Extra usage credits spent (USD 17.57 of USD 17.00)")
        );
    }

    #[test]
    fn an_untouched_overage_allowance_says_nothing_at_all() {
        // Silent below the cap: this is not a rate-limit window, and a note on
        // every reading would train the user to ignore the one that matters.
        let body: Value = serde_json::from_str(
            r#"{ "spend": { "reached": false,
                    "used":  { "amount_minor": 0, "exponent": 2 },
                    "limit": { "amount_minor": 1700, "exponent": 2 } } }"#,
        )
        .unwrap();
        assert_eq!(claude_spend_note(&body), None);
        assert_eq!(claude_spend_note(&serde_json::json!({})), None);
    }

    #[test]
    fn the_extra_usage_flag_alone_is_enough_to_warn() {
        // The two flags disagree on some accounts; either one being set means
        // the credits are gone.
        let body: Value = serde_json::from_str(
            r#"{ "spend": { "reached": false },
                 "extra_usage": { "spend_limit_reached": true } }"#,
        )
        .unwrap();
        assert_eq!(
            claude_spend_note(&body).as_deref(),
            Some("Extra usage credits spent")
        );
    }

    #[test]
    fn minimax_percentages_are_inverted_because_the_api_reports_whats_left() {
        // The single most dangerous field in this file. MiniMax reports
        // `current_interval_remaining_percent`; reading it as "used" would show
        // an almost-spent plan as almost-full.
        let body: Value = serde_json::from_str(
            r#"{
                "base_resp": { "status_code": 0, "status_msg": "success" },
                "model_remains": [
                    {
                        "model_name": "MiniMax-M2",
                        "current_interval_remaining_percent": 12,
                        "start_time": 1786000000,
                        "end_time": 1786018000
                    }
                ]
            }"#,
        )
        .unwrap();

        let windows = parse_minimax_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label, "MiniMax-M2");
        assert_eq!(windows[0].used_percent, 88.0);
        assert_eq!(windows[0].resets_at_epoch_secs, Some(1786018000));
    }

    #[test]
    fn the_minimax_session_window_is_the_contracted_five_hours() {
        // The API's own start/end span drifts below the plan's window, so the
        // label is pinned rather than recomputed — same treatment as Codex.
        let body: Value = serde_json::from_str(
            r#"{ "model_remains": [
                { "model_name": "m", "current_interval_remaining_percent": 50,
                  "start_time": 100, "end_time": 200 } ] }"#,
        )
        .unwrap();
        assert_eq!(parse_minimax_windows(&body)[0].window_minutes, Some(300));
    }

    #[test]
    fn minimax_accepts_percentages_sent_as_strings() {
        let body: Value = serde_json::from_str(
            r#"{ "model_remains": [
                { "model_name": "m", "current_interval_remaining_percent": "25.5",
                  "start_time": 1, "end_time": 2 } ] }"#,
        )
        .unwrap();
        let windows = parse_minimax_windows(&body);
        assert_eq!(windows.len(), 1);
        assert!((windows[0].used_percent - 74.5).abs() < 0.001);
    }

    #[test]
    fn a_minimax_account_with_no_plan_yields_no_windows() {
        let empty: Value = serde_json::from_str(r#"{ "model_remains": [] }"#).unwrap();
        assert!(parse_minimax_windows(&empty).is_empty());
        let missing: Value = serde_json::from_str(r#"{ "base_resp": {} }"#).unwrap();
        assert!(parse_minimax_windows(&missing).is_empty());
    }

    #[test]
    fn minimax_orders_models_most_constrained_first() {
        let body: Value = serde_json::from_str(
            r#"{ "model_remains": [
                { "model_name": "roomy", "current_interval_remaining_percent": 90,
                  "start_time": 1, "end_time": 2 },
                { "model_name": "tight", "current_interval_remaining_percent": 5,
                  "start_time": 1, "end_time": 2 } ] }"#,
        )
        .unwrap();
        let windows = parse_minimax_windows(&body);
        assert_eq!(windows[0].label, "tight");
        assert_eq!(windows[0].used_percent, 95.0);
    }

    // -----------------------------------------------------------------------
    // Cursor
    // -----------------------------------------------------------------------

    #[test]
    fn cursor_personal_plan_exposes_the_three_pools_and_the_cycle_reset() {
        // Trimmed from the payload ai-usagebar confirms against a live Ultra
        // account (see its `cursor::types` docs).
        let body: Value = serde_json::from_str(
            r#"{
                "billingCycleStart": "2026-07-04T00:35:51.000Z",
                "billingCycleEnd": "2026-08-04T00:35:51.000Z",
                "membershipType": "ultra",
                "isUnlimited": false,
                "individualUsage": {
                    "plan": { "autoPercentUsed": 98.1, "apiPercentUsed": 100, "totalPercentUsed": 98.5 },
                    "onDemand": { "enabled": false }
                }
            }"#,
        )
        .unwrap();

        let windows = parse_cursor_windows(&body);
        assert_eq!(windows.len(), 3);
        let labels: Vec<&str> = windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["Monthly", "Auto", "API"]);
        assert!((windows[0].used_percent - 98.5).abs() < 0.001);
        assert!((windows[1].used_percent - 98.1).abs() < 0.001);
        assert_eq!(windows[2].used_percent, 100.0);
        // Reset is ISO-8601; the fetch attaches `billingCycleEnd` to each.
        assert_eq!(
            windows[0].resets_at_iso.as_deref(),
            Some("2026-08-04T00:35:51.000Z")
        );
    }

    #[test]
    fn cursor_team_accounts_fall_back_to_the_display_messages() {
        // Team/token-enterprise accounts publish no percentages, only the two
        // human-readable strings. Accepted only when BOTH parse.
        let body: Value = serde_json::from_str(
            r#"{
                "membershipType": "teams",
                "isUnlimited": false,
                "individualUsage": { "onDemand": { "enabled": false } },
                "autoModelSelectedDisplayMessage": "You've used 42% of your included total usage",
                "namedModelSelectedDisplayMessage": "You've used 100% of your included API usage"
            }"#,
        )
        .unwrap();

        let windows = parse_cursor_windows(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "Auto");
        assert!((windows[0].used_percent - 42.0).abs() < 0.001);
        assert_eq!(windows[1].label, "API");
        assert_eq!(windows[1].used_percent, 100.0);
    }

    #[test]
    fn an_empty_plan_object_still_falls_through_to_the_display_messages() {
        // A `plan` key that exists but holds none of the three percent fields
        // (reshaped payload) must not block the team-message fallback.
        let body: Value = serde_json::from_str(
            r#"{
                "membershipType": "teams",
                "individualUsage": { "plan": {} },
                "autoModelSelectedDisplayMessage": "You've used 42% of your included total usage",
                "namedModelSelectedDisplayMessage": "You've used 100% of your included API usage"
            }"#,
        )
        .unwrap();
        let windows = parse_cursor_windows(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "Auto");
    }

    #[test]
    fn a_single_stray_cursor_message_is_schema_drift_not_a_half_snapshot() {
        // One message present, the other missing: refuse both rather than
        // guessing a percentage for the missing pool.
        let body: Value = serde_json::from_str(
            r#"{ "membershipType": "teams", "individualUsage": {},
                "autoModelSelectedDisplayMessage": "You've used 42% of your included total usage" }"#,
        )
        .unwrap();
        assert!(parse_cursor_windows(&body).is_empty());
    }

    #[test]
    fn cursor_payload_with_no_usage_shape_yields_nothing() {
        let drift: Value = serde_json::from_str(r#"{ "membershipType": "ultra" }"#).unwrap();
        assert!(parse_cursor_windows(&drift).is_empty());
        let unlimited: Value =
            serde_json::from_str(r#"{ "isUnlimited": true, "individualUsage": {} }"#).unwrap();
        assert!(parse_cursor_windows(&unlimited).is_empty());
    }

    #[test]
    fn cursor_percent_is_taken_from_the_number_before_the_sign() {
        assert_eq!(cursor_percent_from_message("You've used 42% of your included"), Some(42.0));
        assert_eq!(cursor_percent_from_message("100% of included API usage"), Some(100.0));
        assert_eq!(cursor_percent_from_message("No usage info"), None);
        assert_eq!(cursor_percent_from_message(""), None);
    }

    // -----------------------------------------------------------------------
    // Amp
    // -----------------------------------------------------------------------

    #[test]
    fn amp_free_meter_becomes_one_window_with_time_to_full() {
        // Format from CodexBar's documented Amp provider: remaining/total with
        // an hourly replenishment rate.
        let display = "Amp Free: $4.30/$10.00 remaining (replenishes +$0.50/hour)\nIndividual credits: $12.00 remaining";
        let windows = parse_amp_display_text(display);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label, "Amp Free");
        // 1 - 4.30/10 = 57% used.
        assert!((windows[0].used_percent - 57.0).abs() < 0.001);
        // (10 - 4.30) / 0.50 = 11.4 hours to full.
        let reset = windows[0].resets_at_epoch_secs.expect("time-to-full reset");
        let hours = (reset - now_secs()) as f64 / 3600.0;
        assert!((hours - 11.4).abs() < 0.01);
    }

    #[test]
    fn amp_without_a_replenish_rate_still_counts_the_meter() {
        let display = "Amp Free: $8.00/$20.00 remaining\nIndividual credits: $5.00 remaining";
        let windows = parse_amp_display_text(display);
        assert_eq!(windows.len(), 1);
        assert!((windows[0].used_percent - 60.0).abs() < 0.001);
        assert_eq!(windows[0].resets_at_epoch_secs, None);
    }

    #[test]
    fn amp_with_no_free_line_yields_nothing() {
        // Workspace/individual credits are balances without limits — no
        // percent exists, so no bar.
        let display = "Individual credits: $12.00 remaining\nWorkspace credits (Acme): $40.00 remaining";
        assert!(parse_amp_display_text(display).is_empty());
        assert!(parse_amp_display_text("").is_empty());
    }

    #[test]
    fn amp_free_line_parses_remaining_total_and_rate() {
        let (remaining, total, rate) =
            parse_amp_free_line("Amp Free: $4.30/$10.00 remaining (replenishes +$0.50/hour)")
                .expect("parseable free line");
        assert!((remaining - 4.3).abs() < 0.001);
        assert!((total - 10.0).abs() < 0.001);
        assert!((rate - 0.5).abs() < 0.001);
    }

    #[test]
    fn amp_free_line_tolerates_spacing_around_the_slash() {
        let (remaining, total, _) = parse_amp_free_line("Amp Free: $8.00 / $20.00 remaining")
            .expect("parseable free line");
        assert!((remaining - 8.0).abs() < 0.001);
        assert!((total - 20.0).abs() < 0.001);
    }

    #[test]
    fn amp_leading_number_extracts_the_opening_number() {
        assert_eq!(amp_leading_number("0.50/hour"), Some(0.5));
        // The pieces fed in are post-`$` splits, so they start with a digit;
        // a leading `$` is exactly what the split removes, and is refused.
        assert_eq!(amp_leading_number("$10.00"), None);
        assert_eq!(amp_leading_number("10.00 remaining"), Some(10.0));
        assert_eq!(amp_leading_number("no rate"), None);
    }

    // -----------------------------------------------------------------------
    // OpenCode
    // -----------------------------------------------------------------------

    /// Shaped like the real page: React Flight reference tokens between the key
    /// and its object, a `null` decoy for the same key, and a nested object that
    /// repeats `usagePercent` with a different value.
    const OPENCODE_PAGE: &str = r#"
        <script>self.__flight.push({billing:{monthlyUsage:null,rollingUsage:null},
        panel:$R[12]={rollingUsage:$R[28]={usagePercent:42.5,resetInSec:3600,
        detail:{usagePercent:999,label:"nested"}},
        weeklyUsage:$R[29]={usagePercent:71,resetInSec:172800},
        monthlyUsage:$R[30]={usagePercent:8,resetInSec:1209600}}})</script>
    "#;

    #[test]
    fn opencode_reads_all_three_windows_off_the_rendered_page() {
        let windows = parse_opencode_windows(OPENCODE_PAGE);
        assert_eq!(windows.len(), 3);
        // Most-constrained first, like every other provider.
        assert_eq!(windows[0].label, "Weekly");
        assert_eq!(windows[0].used_percent, 71.0);
        assert_eq!(windows[1].label, "Session");
        assert_eq!(windows[1].used_percent, 42.5);
        assert_eq!(windows[2].label, "Monthly");
        assert_eq!(windows[2].used_percent, 8.0);
    }

    #[test]
    fn opencode_skips_the_null_decoy_and_the_nested_duplicate() {
        // `rollingUsage:null` appears first in the payload and a nested
        // `usagePercent:999` sits inside the real block. Taking either would
        // render a wrong meter rather than no meter.
        let block = opencode_usage_block(OPENCODE_PAGE, "rollingUsage");
        assert_eq!(block, Some((42.5, 3600)));
    }

    #[test]
    fn opencode_window_lengths_describe_the_right_spans() {
        let windows = parse_opencode_windows(OPENCODE_PAGE);
        let session = windows.iter().find(|w| w.label == "Session").unwrap();
        let weekly = windows.iter().find(|w| w.label == "Weekly").unwrap();
        let monthly = windows.iter().find(|w| w.label == "Monthly").unwrap();
        assert_eq!(session.window_minutes, Some(300));
        assert_eq!(weekly.window_minutes, Some(7 * 24 * 60));
        assert_eq!(monthly.window_minutes, Some(30 * 24 * 60));
    }

    #[test]
    fn a_page_missing_a_required_window_reads_as_unparseable_not_as_zero() {
        // A partial parse must not become a meter — half the windows silently
        // absent reads as "you've used nothing on the others".
        let page = "rollingUsage:{usagePercent:10,resetInSec:60}";
        assert!(parse_opencode_windows(page).is_empty());
        assert!(parse_opencode_windows("").is_empty());
        assert!(parse_opencode_windows("nothing to see").is_empty());
    }

    #[test]
    fn opencode_page_parsing_survives_multibyte_characters() {
        // The page is arbitrary UTF-8 from a site we don't control; a fixed
        // byte-offset lookahead would panic mid-character.
        let page = "héllo… rollingUsage:{usagePercent:1,resetInSec:2} \
                    wéekly… weeklyUsage:{usagePercent:3,resetInSec:4}";
        let windows = parse_opencode_windows(page);
        assert_eq!(windows.len(), 2);
    }

    #[test]
    fn opencode_workspace_ids_are_extracted_in_order_and_deduped() {
        let text = r#"{uuid:"wrk_notthis",id:"wrk_abc123",name:"a"},{id:"wk_def456"},{id:"wrk_abc123"}"#;
        assert_eq!(
            parse_opencode_workspace_ids(text),
            vec!["wrk_abc123".to_string(), "wk_def456".to_string()]
        );
    }

    #[test]
    fn unrelated_identifiers_are_not_mistaken_for_workspaces() {
        let text = r#"{id:"usr_abc"},{id:"proj_1"},{gridId:"wrk_nope"}"#;
        assert!(parse_opencode_workspace_ids(text).is_empty());
    }

    #[test]
    fn a_nested_field_never_shadows_the_one_at_the_objects_own_depth() {
        let block = r#"{usagePercent:5,inner:{usagePercent:99},resetInSec:7}"#;
        assert_eq!(top_level_number(block, "usagePercent"), Some(5.0));
        assert_eq!(top_level_number(block, "resetInSec"), Some(7.0));
    }

    #[test]
    fn a_longer_field_name_does_not_satisfy_a_shorter_one() {
        let block = r#"{usagePercentile:88,usagePercent:4}"#;
        assert_eq!(top_level_number(block, "usagePercent"), Some(4.0));
    }

    // -----------------------------------------------------------------------
    // Table wiring
    // -----------------------------------------------------------------------

    #[test]
    fn all_web_providers_are_wired_into_the_table() {
        for provider in ["opencode", "minimax", "cursor"] {
            let spec = PROVIDERS
                .iter()
                .find(|spec| spec.provider == provider)
                .unwrap_or_else(|| panic!("{provider} missing from PROVIDERS"));
            assert!(
                spec.supports_usage,
                "{provider} has a fetcher but supports_usage is false"
            );
            assert!(
                crate::commands::web_session::spec_for(provider).is_some(),
                "{provider} has no web-session spec to get a cookie from"
            );
        }
    }

    #[test]
    fn only_minimax_skips_the_path_check() {
        // OpenCode and Cursor are real CLIs and must still disappear when
        // uninstalled; only web-only MiniMax has no binary to find.
        assert!(is_web_only("minimax"));
        assert!(!is_web_only("opencode"));
        assert!(!is_web_only("cursor"));
        assert!(!is_web_only("claude"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The service string is the whole fix — a typo here is indistinguishable
    /// from "not signed in" on macOS, which is exactly the failure this path
    /// was added to end. Pin it, and pin that nothing else claims a keychain.
    #[test]
    fn only_claude_reads_a_credential_out_of_the_keychain() {
        assert_eq!(keychain_service("claude"), Some("Claude Code-credentials"));
        // Antigravity is in this list on purpose, and it is not the same thing
        // as "antigravity is unreadable": its item's name (`gemini:antigravity`)
        // is the colon-joined one `keytar` writes, which this crate's own
        // `{user}.{service}` naming can never address. It is read directly from
        // the store instead (see `antigravity_credential_present`).
        for provider in ["codex", "gemini", "copilot", "cody", "opencode", "amp", "antigravity"] {
            assert_eq!(keychain_service(provider), None, "{provider}");
        }
    }

    /// The keychain lookup is compiled and run on every platform (see
    /// `keychain_service`), so this also proves the non-macOS path is a plain
    /// miss rather than an error, a panic, or a consent prompt: no CLI files a
    /// `Claude Code-credentials` item in Credential Manager or secret-service.
    #[test]
    fn an_absent_keychain_item_reads_as_missing_not_as_a_failure() {
        assert!(matches!(
            keychain_credential("codex"),
            Credential::Missing
        ));
        #[cfg(not(target_os = "macos"))]
        assert!(matches!(
            keychain_credential("claude"),
            Credential::Missing
        ));
    }

    #[test]
    fn the_keychain_account_is_the_current_user() {
        // POSIX spells it USER, Windows USERNAME; one of the two is always set
        // on a machine a person is logged into.
        assert!(keychain_account().is_some());
    }

    #[test]
    fn parses_the_named_claude_windows() {
        // Trimmed from a real 200 response.
        let body: Value = serde_json::from_str(
            r#"{
                "five_hour": { "utilization": 27.0, "resets_at": "2026-08-10T21:30:00.907209+00:00" },
                "seven_day": { "utilization": 6.0, "resets_at": "2026-08-16T21:00:00.907240+00:00" },
                "seven_day_opus": null,
                "limits": [
                    { "kind": "session", "percent": 27, "resets_at": "2026-08-10T21:30:00.907209+00:00", "scope": null }
                ]
            }"#,
        )
        .unwrap();

        let windows = parse_claude_windows(&body);
        assert_eq!(windows.len(), 2, "a scope-less limits entry must not duplicate a named window");
        assert_eq!(windows[0].label, "Session");
        assert_eq!(windows[0].used_percent, 27.0);
        assert_eq!(windows[0].window_minutes, Some(300));
        assert_eq!(
            windows[0].resets_at_iso.as_deref(),
            Some("2026-08-10T21:30:00.907209+00:00")
        );
        assert_eq!(windows[1].label, "Weekly");
        assert_eq!(windows[1].used_percent, 6.0);
    }

    #[test]
    fn adds_model_scoped_claude_limits() {
        let body: Value = serde_json::from_str(
            r#"{
                "five_hour": { "utilization": 10.0 },
                "limits": [
                    { "percent": 80, "scope": { "model": { "display_name": "Opus" } } }
                ]
            }"#,
        )
        .unwrap();

        let windows = parse_claude_windows(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[1].label, "Opus");
        assert_eq!(windows[1].used_percent, 80.0);
    }

    #[test]
    fn accepts_the_older_used_percentage_key() {
        let body: Value =
            serde_json::from_str(r#"{ "five_hour": { "used_percentage": 42.0 } }"#).unwrap();
        let windows = parse_claude_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 42.0);
    }

    #[test]
    fn parses_a_real_codex_payload() {
        // Trimmed from a real 200 response for a rate-limited free account.
        let body: Value = serde_json::from_str(
            r#"{
                "plan_type": "free",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 100,
                        "limit_window_seconds": 2592000,
                        "reset_at": 1787080318
                    },
                    "secondary_window": null
                }
            }"#,
        )
        .unwrap();

        let windows = parse_codex_windows(&body);
        assert_eq!(windows.len(), 1, "a null secondary window must be skipped");
        assert_eq!(windows[0].label, "Monthly", "2592000s is 30 days, not a session");
        assert_eq!(windows[0].used_percent, 100.0);
        assert_eq!(windows[0].window_minutes, Some(43_200));
        assert_eq!(windows[0].resets_at_epoch_secs, Some(1_787_080_318));
    }

    #[test]
    fn parses_available_codex_reset_credits_and_ignores_redeemed_ones() {
        let body: Value = serde_json::from_str(
            r#"{
                "credits": [
                    {
                        "id": "RateLimitResetCredit_one",
                        "reset_type": "weekly",
                        "status": "available",
                        "expires_at": "2026-09-30T12:00:00Z"
                    },
                    {
                        "id": "RateLimitResetCredit_two",
                        "reset_type": "weekly",
                        "status": "redeemed",
                        "expires_at": null
                    }
                ]
            }"#,
        )
        .unwrap();

        let credits = parse_codex_reset_credits(&body);
        assert_eq!(credits.len(), 1);
        assert_eq!(credits[0].id, "RateLimitResetCredit_one");
        assert_eq!(credits[0].reset_type.as_deref(), Some("weekly"));
        assert_eq!(
            credits[0].expires_at_iso.as_deref(),
            Some("2026-09-30T12:00:00Z")
        );
    }

    #[test]
    fn treats_a_null_rate_limit_as_no_windows() {
        let body: Value = serde_json::from_str(r#"{ "rate_limit": null }"#).unwrap();
        assert!(parse_codex_windows(&body).is_empty());
    }

    #[test]
    fn labels_windows_by_real_length() {
        assert_eq!(describe_window(5 * 3_600), "Session");
        assert_eq!(describe_window(7 * 24 * 3_600), "Weekly");
        assert_eq!(describe_window(30 * 24 * 3_600), "Monthly");
        assert_eq!(describe_window(0), "Usage");
    }

    #[test]
    fn clamps_a_percentage_over_a_hundred() {
        assert_eq!(UsageWindow::new("Session", 137.5).used_percent, 100.0);
        assert_eq!(UsageWindow::new("Session", -4.0).used_percent, 0.0);
    }

    #[test]
    fn reads_a_reset_in_milliseconds_as_seconds() {
        let ms = Value::Number(serde_json::Number::from(1_787_080_318_000i64));
        let window = UsageWindow::new("Session", 1.0).with_reset(Some(&ms));
        assert_eq!(window.resets_at_epoch_secs, Some(1_787_080_318));
    }

    #[test]
    fn parses_a_real_grok_credits_payload() {
        // Captured verbatim from a live 200. Note everything is nested under
        // `config` — the flat shape exists too, hence `grok_field`.
        let body: Value = serde_json::from_str(
            r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY",
                "start":"2026-08-05T00:00:00+00:00","end":"2026-08-12T00:00:00+00:00"},
                "onDemandCap":{"val":0},"prepaidBalance":{"val":0},
                "billingPeriodEnd":"2026-08-12T00:00:00+00:00"}}"#,
        )
        .unwrap();

        // No percentage and no limit — this must yield NO window rather than a
        // 0% bar implying a healthy untouched quota.
        assert!(parse_grok_windows(&body).is_empty());
    }

    #[test]
    fn derives_a_grok_percentage_from_used_over_limit() {
        let body: Value = serde_json::from_str(
            r#"{"config":{"monthlyLimit":{"val":200},"used":{"val":50},
                "billingPeriodEnd":"2026-09-01T00:00:00+00:00"}}"#,
        )
        .unwrap();
        let windows = parse_grok_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 25.0);
        assert_eq!(windows[0].label, "Billing period");
    }

    #[test]
    fn never_divides_by_a_zero_grok_allowance() {
        let body: Value =
            serde_json::from_str(r#"{"monthlyLimit":{"val":0},"used":{"val":0}}"#).unwrap();
        assert!(
            parse_grok_windows(&body).is_empty(),
            "a zero allowance must not render as 0% used"
        );
    }

    #[test]
    fn prefers_an_explicit_grok_percentage_and_labels_the_period() {
        let body: Value = serde_json::from_str(
            r#"{"creditUsagePercent":42.5,"monthlyLimit":{"val":100},"used":{"val":90},
                "currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-08-12T00:00:00+00:00"}}"#,
        )
        .unwrap();
        let windows = parse_grok_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 42.5, "explicit percent beats used/limit");
        assert_eq!(windows[0].label, "Weekly");
        assert_eq!(
            windows[0].resets_at_iso.as_deref(),
            Some("2026-08-12T00:00:00+00:00")
        );
    }

    #[test]
    fn reads_both_kimi_windows_and_orders_them_by_pressure() {
        let body: Value = serde_json::from_str(
            r#"{"usage":{"limit":1000,"used":100,"resetTime":"2026-08-18T00:00:00Z"},
                "limits":[{"window":{"duration":5,"timeUnit":"hour"},
                           "detail":{"limit":200,"remaining":50,
                                     "resetAt":"2026-08-11T18:00:00Z"}}]}"#,
        )
        .unwrap();
        let windows = parse_kimi_windows(&body);
        assert_eq!(windows.len(), 2);
        // 75% session beats 10% weekly.
        assert_eq!(windows[0].label, "Session");
        assert_eq!(windows[0].used_percent, 75.0, "derived from limit - remaining");
        assert_eq!(windows[0].window_minutes, Some(300));
        assert_eq!(
            windows[0].resets_at_iso.as_deref(),
            Some("2026-08-11T18:00:00Z")
        );
        assert_eq!(windows[1].label, "Weekly");
        assert_eq!(windows[1].used_percent, 10.0);
    }

    #[test]
    fn a_kimi_account_with_no_allowance_yields_no_window() {
        // Same rule as Grok's `monthlyLimit: 0`: a 0% bar over a zero limit
        // reads as an untouched quota, which is the opposite of the truth.
        let body: Value =
            serde_json::from_str(r#"{"usage":{"limit":0,"used":0}}"#).unwrap();
        assert!(parse_kimi_windows(&body).is_empty());
    }

    #[test]
    fn kimi_window_units_convert_to_minutes() {
        let hour: Value =
            serde_json::from_str(r#"{"duration":5,"timeUnit":"hours"}"#).unwrap();
        assert_eq!(kimi_window_minutes(Some(&hour)), Some(300));
        let week: Value =
            serde_json::from_str(r#"{"duration":1,"timeUnit":"week"}"#).unwrap();
        assert_eq!(kimi_window_minutes(Some(&week)), Some(10_080));
        // An unfamiliar unit is left unstated rather than guessed at.
        let odd: Value =
            serde_json::from_str(r#"{"duration":3,"timeUnit":"fortnight"}"#).unwrap();
        assert_eq!(kimi_window_minutes(Some(&odd)), None);
    }

    #[test]
    fn reads_a_string_wrapped_grok_amount() {
        let body: Value = serde_json::from_str(
            r#"{"monthlyLimit":{"val":"400"},"used":{"val":"100"}}"#,
        )
        .unwrap();
        assert_eq!(parse_grok_windows(&body)[0].used_percent, 25.0);
    }

    #[test]
    fn inverts_geminis_remaining_fraction() {
        // Captured verbatim from a live 200. `remainingFraction: 1` means
        // FULLY AVAILABLE, so it must render as 0% used — inverting this
        // wrongly would show an untouched quota as exhausted.
        let body: Value = serde_json::from_str(
            r#"{"buckets":[
                {"resetTime":"2026-08-11T17:54:15Z","tokenType":"REQUESTS","modelId":"gemini-2.5-flash","remainingFraction":1},
                {"resetTime":"2026-08-11T17:54:15Z","tokenType":"REQUESTS","modelId":"gemini-2.5-pro","remainingFraction":0.25}
            ]}"#,
        )
        .unwrap();

        let windows = parse_gemini_windows(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "gemini-2.5-flash");
        assert_eq!(windows[0].used_percent, 0.0, "remaining 1.0 == 0% used");
        assert_eq!(windows[1].used_percent, 75.0, "remaining 0.25 == 75% used");
        assert_eq!(windows[0].resets_at_iso.as_deref(), Some("2026-08-11T17:54:15Z"));
    }

    #[test]
    fn collapses_repeated_gemini_model_rows() {
        // The endpoint repeats a model when it has more than one token type.
        let body: Value = serde_json::from_str(
            r#"{"buckets":[
                {"modelId":"gemini-2.5-pro","tokenType":"REQUESTS","remainingFraction":0.5},
                {"modelId":"gemini-2.5-pro","tokenType":"TOKENS","remainingFraction":0.9}
            ]}"#,
        )
        .unwrap();
        assert_eq!(parse_gemini_windows(&body).len(), 1);
    }

    #[test]
    fn accepts_a_bare_gemini_bucket_array() {
        let body: Value =
            serde_json::from_str(r#"[{"modelId":"gemini-2.5-pro","remainingFraction":0}]"#)
                .unwrap();
        let windows = parse_gemini_windows(&body);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 100.0);
    }

    #[test]
    fn picks_the_grok_session_out_of_an_issuer_keyed_file() {
        // The issuer key carries a per-login uuid suffix, so it must be matched
        // by prefix, not equality.
        let json: Value = serde_json::from_str(
            r#"{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":
                {"key":"tok_abc","user_id":"u_123","expires_at":"2026-08-10T23:49:28Z"}}"#,
        )
        .unwrap();
        let (token, user) = grok_session(&json).expect("session");
        assert_eq!(token, "tok_abc");
        assert_eq!(user.as_deref(), Some("u_123"));
    }

    #[test]
    fn reports_no_grok_session_for_an_unrelated_issuer() {
        let json: Value =
            serde_json::from_str(r#"{"https://example.com":{"key":"nope"}}"#).unwrap();
        assert!(grok_session(&json).is_none());
    }

    #[test]
    fn every_provider_command_is_unique() {
        // The command is the join key to AI_AGENT_PRESETS on the frontend; a
        // duplicate would silently make one row unreachable.
        let mut commands: Vec<&str> = PROVIDERS.iter().map(|p| p.command).collect();
        commands.sort_unstable();
        let before = commands.len();
        commands.dedup();
        assert_eq!(before, commands.len());
    }

    #[test]
    fn detection_never_panics_and_covers_every_provider() {
        // `build_detected` is the pure half of detection; exercising it for
        // every provider covers the whole table without touching disk or
        // spawning a CLI.
        let detected: Vec<DetectedAgent> =
            PROVIDERS.iter().map(|spec| build_detected(spec, false, false)).collect();
        assert_eq!(detected.len(), PROVIDERS.len());
    }

    #[test]
    fn sign_in_mechanism_and_detects_sign_in_always_agree() {
        // A provider can only report sign-in through one of three mechanisms:
        // a credential file, a settings/env/credential-store marker (gemini,
        // cody, copilot, antigravity), or a runtime probe (copilot). If the
        // mechanism set and `detects_sign_in` disagree, the badge lies in one
        // direction or the other.
        for spec in PROVIDERS {
            let has_mechanism = spec.auth_path.is_some()
                || spec.probe.is_some()
                || marker_sign_in_detectable(spec.provider);
            let agent = build_detected(spec, true, false);
            assert_eq!(
                agent.detects_sign_in, has_mechanism,
                "{}: mechanism set and detects_sign_in disagree",
                spec.command
            );
            if !agent.detects_sign_in {
                assert!(!agent.signed_in, "{} cannot detect sign-in yet reported it", spec.command);
            }
        }
    }

    #[tokio::test]
    async fn no_mechanism_means_unknown_not_signed_in() {
        // An API-key CLI (pi) has no file, no probe and no marker: the honest
        // answer is "unknown", never "signed in".
        let spec = ProviderSpec {
            provider: "pi",
            command: "pi",
            aliases: &[],
            name: "Pi AI Agent",
            auth_path: None,
            probe: None,
            supports_usage: false,
        };
        assert!(!signed_in_by_file_or_marker(&spec, false).await);
    }

    #[test]
    fn antigravity_sign_in_is_claimed_only_where_it_can_be_read() {
        // The credential-store target is the Windows one. On any other platform
        // the badge has to stay in its middle state instead of guessing.
        assert_eq!(marker_sign_in_detectable("antigravity"), cfg!(windows));
        assert!(marker_sign_in_detectable("gemini"));
        assert!(!marker_sign_in_detectable("pi"));
        // The probe itself answers with a bool on every platform, and a missing
        // item is the ordinary "not signed in", never a panic.
        let _ = antigravity_credential_present();
    }

    #[test]
    fn copilot_marker_reads_logged_in_users_past_comment_lines() {
        let dir = std::env::temp_dir().join(format!("spacron-copilot-marker-{}", std::process::id()));
        let cfg = dir.join(".copilot");
        std::fs::create_dir_all(&cfg).unwrap();
        let file = cfg.join("config.json");
        std::fs::write(&file, "// managed automatically
{ \"loggedInUsers\": [{ \"host\": \"https://github.com\", \"login\": \"someone\" }] }").unwrap();
        assert!(copilot_login_marker_from(&dir));
        std::fs::write(&file, "// managed automatically
{ \"loggedInUsers\": [] }").unwrap();
        assert!(!copilot_login_marker_from(&dir));
        std::fs::remove_file(&file).unwrap();
        assert!(!copilot_login_marker_from(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn probe_is_not_signed_in_when_the_cli_is_missing() {
        // A probe whose executable is not on PATH must read as false without
        // running anything (and without hanging).
        let probe = "spacron-definitely-not-a-real-command status";
        assert!(!probe_signs_in(probe, false).await);
    }

    #[test]
    fn probe_results_are_memoized_per_command() {
        // The cache is keyed by the full command string, so two probes never
        // share a slot by accident. (Force bypass is exercised only through
        // the real probe path, which would spawn a CLI here; memoization is
        // the pure half and what this covers.)
        remember_probe("spacron-probe-a status", true);
        assert_eq!(cached_probe("spacron-probe-a status"), Some(true));
        assert_eq!(cached_probe("spacron-probe-b status"), None);
    }

    #[test]
    fn gemini_settings_marker_reads_the_selected_auth_type() {
        // Temp dir so the test never touches the developer's real `~/.gemini`.
        let dir = std::env::temp_dir().join(format!("spacron-gemini-marker-{}", std::process::id()));
        let settings = dir.join(".gemini").join("settings.json");
        let write = |body: &str| {
            std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
            std::fs::write(&settings, body).unwrap();
        };

        // A Google login is a sign-in marker; the file also being absent is not.
        write(r#"{"security":{"auth":{"selectedType":"LOGIN_WITH_GOOGLE"}}}"#);
        assert!(gemini_settings_marker_from(&dir));

        // An API-key selection is NOT a Google login, and a missing file is
        // not a sign-in at all.
        write(r#"{"security":{"auth":{"selectedType":"USE_GEMINI"}}}"#);
        assert!(!gemini_settings_marker_from(&dir));
        write(r#"{"security":{}}"#);
        assert!(!gemini_settings_marker_from(&dir));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Run every fetcher against this machine's real credentials and print what
    /// came back.
    ///
    /// Ignored by default because it needs the network and a signed-in CLI, and
    /// its result depends on the machine it runs on — but it is the only thing
    /// that answers "do the meters show real numbers?", which no amount of
    /// fixture parsing can. Run with:
    ///
    /// ```text
    /// cargo test --lib real_usage_readings -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "hits the network with this machine's real credentials"]
    fn real_usage_readings() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let readings = runtime.block_on(usage_fetch_all(Some(true)));

        println!("\n--- live usage readings ---");
        for usage in &readings {
            println!(
                "{:<12} {:?}{}{}",
                usage.provider,
                usage.status,
                usage
                    .plan
                    .as_ref()
                    .map(|plan| format!(" plan={plan}"))
                    .unwrap_or_default(),
                usage
                    .error
                    .as_ref()
                    .or(usage.note.as_ref())
                    .map(|reason| format!("  ({reason})"))
                    .unwrap_or_default(),
            );
            for window in &usage.windows {
                println!(
                    "               {:<16} {:>6.1}% used   window={:?}m",
                    window.label, window.used_percent, window.window_minutes
                );
            }
        }
        println!("--- end ---\n");

        // The invariant worth asserting is the one rule 3 exists for: a reading
        // that claims to be Ok must actually carry numbers or say why not.
        for usage in &readings {
            if usage.status == UsageStatus::Ok {
                assert!(
                    !usage.windows.is_empty() || usage.note.is_some(),
                    "{} reported Ok with no windows and no explanation",
                    usage.provider
                );
            }
        }
    }

    /// Report what opencode.ai actually answers, so a failing meter can be
    /// diagnosed without guessing. Prints statuses and a short body preview;
    /// never the cookie.
    ///
    /// ```text
    /// cargo test --lib real_opencode_probe -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "hits opencode.ai with this machine's linked session"]
    fn real_opencode_probe() {
        let Some(cookie) = crate::commands::web_session::stored_cookie("opencode") else {
            println!("\nno OpenCode session linked — click Connect in the usage panel first\n");
            return;
        };
        let names: Vec<String> = crate::commands::web_session::parse_cookie_header(&cookie)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        println!("\n--- opencode probe ---");
        println!("cookie names present: {names:?}");

        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .expect("client");

        runtime.block_on(async {
            let extra = std::env::var("SPACRON_PROBE_URLS").unwrap_or_default();
            let mut targets: Vec<(String, String)> = vec![
                (
                    "workspaces rpc".to_string(),
                    format!("{OPENCODE_SERVER_URL}?id={OPENCODE_WORKSPACES_FN}"),
                ),
                ("go".to_string(), format!("{OPENCODE_ORIGIN}/go")),
                ("root".to_string(), OPENCODE_ORIGIN.to_string()),
            ];
            for path in extra.split(',').filter(|p| !p.trim().is_empty()) {
                targets.push((path.trim().to_string(), format!("{OPENCODE_ORIGIN}{path}")));
            }
            for (label, url) in targets {
                let result = client
                    .get(&url)
                    .header("Cookie", &cookie)
                    .header("X-Server-Id", OPENCODE_WORKSPACES_FN)
                    .header("Accept", "text/javascript, application/json;q=0.9, */*;q=0.8")
                    .header("Origin", OPENCODE_ORIGIN)
                    .header("Referer", OPENCODE_ORIGIN)
                    .header("User-Agent", browser_user_agent())
                    .send()
                    .await;
                match result {
                    Ok(response) => {
                        let status = response.status();
                        let landed = response.url().to_string();
                        if landed != url {
                            println!("{label:<16} redirected -> {landed}");
                        }
                        let body = response.text().await.unwrap_or_default();
                        let ids = parse_opencode_workspace_ids(&body);
                        println!(
                            "{label:<16} {status}  {} bytes  workspace ids={ids:?}",
                            body.len()
                        );
                        println!("    {}", body.chars().take(180).collect::<String>());
                        for marker in [
                            "wrk_", "wk_", "workspace", "rollingUsage", "weeklyUsage",
                            "signin", "Sign in", "billing", "subscription", "@",
                        ] {
                            if body.contains(marker) {
                                println!("    contains {marker:?}");
                            }
                        }
                        if let Ok(dir) = std::env::var("SPACRON_PROBE_DUMP") {
                            let file = std::path::Path::new(&dir)
                                .join(format!("{}.txt", label.replace(' ', "-")));
                            let _ = std::fs::write(file, &body);
                        }
                    }
                    Err(e) => println!("{label:<16} network error: {e}"),
                }
            }
        });
        println!("--- end ---\n");
    }

    /// Print the raw usage payloads Claude and Codex return, so the parsed
    /// meters can be checked against the source rather than trusted.
    ///
    /// Usage numbers are not secrets; the tokens used to fetch them never
    /// appear here.
    ///
    /// ```text
    /// cargo test --lib real_payload_dump -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "hits provider usage endpoints with this machine's credentials"]
    fn real_payload_dump() {
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .expect("client");

        runtime.block_on(async {
            // Claude
            if let Some(spec) = PROVIDERS.iter().find(|s| s.provider == "claude") {
                if let Some(path) = auth_file(spec) {
                    if let Ok(json) = read_auth_json(&path) {
                        if let Some(token) = json
                            .get("claudeAiOauth")
                            .and_then(|o| o.get("accessToken"))
                            .and_then(Value::as_str)
                        {
                            let body = client
                                .get(CLAUDE_USAGE_URL)
                                .header("Authorization", format!("Bearer {token}"))
                                .header("anthropic-beta", CLAUDE_OAUTH_BETA)
                                .send()
                                .await
                                .ok();
                            if let Some(response) = body {
                                let status = response.status();
                                let text = response.text().await.unwrap_or_default();
                                println!("\n--- claude {status} ---\n{text}");
                            }
                        }
                    }
                }
            }

            // Codex
            if let Some(spec) = PROVIDERS.iter().find(|s| s.provider == "codex") {
                if let Some(path) = auth_file(spec) {
                    if let Ok(json) = read_auth_json(&path) {
                        let token = json
                            .get("tokens")
                            .and_then(|t| t.get("access_token"))
                            .and_then(Value::as_str);
                        let account = json
                            .get("tokens")
                            .and_then(|t| t.get("account_id"))
                            .and_then(Value::as_str);
                        if let (Some(token), Some(account)) = (token, account) {
                            let body = client
                                .get(CODEX_USAGE_URL)
                                .header("Authorization", format!("Bearer {token}"))
                                .header("chatgpt-account-id", account)
                                .send()
                                .await
                                .ok();
                            if let Some(response) = body {
                                let status = response.status();
                                let text = response.text().await.unwrap_or_default();
                                println!("\n--- codex {status} ---\n{text}");
                            }
                        }
                    }
                }
            }
        });
        println!("\n--- end ---\n");
    }

    #[test]
    fn a_provider_with_a_usage_fetcher_can_always_check_sign_in() {
        // Fetching usage requires a credential, so any provider claiming
        // `supports_usage` must declare where one comes from. There are exactly
        // two sources: a file the CLI wrote, or a linked browser session
        // (`commands::web_session`) for the providers that publish no
        // CLI-readable token at all. Declaring neither means the fetcher has
        // nothing to authenticate with.
        for spec in PROVIDERS.iter().filter(|s| s.supports_usage) {
            let has_web_session = crate::commands::web_session::spec_for(spec.provider).is_some();
            assert!(
                spec.auth_path.is_some() || has_web_session,
                "{} fetches usage but declares neither a credential path nor a web session",
                spec.command
            );
        }
    }
}
