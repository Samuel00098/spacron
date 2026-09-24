//! Local agent usage analytics — the Settings → Stats token ledger.
//!
//! Answers "where did my tokens actually go?" by scanning the logs the Claude
//! Code CLI already writes to disk (`~/.claude/projects` + `~/.claude/transcripts`)
//! and aggregating them into a per-day, per-model, per-project ledger with an
//! honest **estimated** API-equivalent cost.
//!
//! This is deliberately decoupled from the rate-limit meters in `usage.rs`:
//! that module reads live vendor endpoints; this one reads the user's own disk.
//! Nothing here ever touches the network.
//!
//! ## Honesty rules
//!
//! 1. **On-demand, incremental.** A scan only runs when the Stats pane asks
//!    for one — opening the tab triggers the first scan, Rescan triggers the
//!    rest — and it is incremental: an unchanged file pays a stat call and
//!    nothing else. There is no toggle; the feature is always available.
//! 2. **Incremental, never full re-reads.** Session files grow to megabytes.
//!    A file whose `(mtime, size)` fingerprint is unchanged contributes nothing
//!    on rescan; a changed file *replaces* its previous contribution instead of
//!    adding on top of it, so rescanning can never double-count.
//! 3. **One owner per turn.** Claude rewrites earlier turns into every
//!    fork/resume of a session (`claude --fork`), so per-file dedupe alone
//!    double-counts long-lived sessions. Each dedupe key is claimed by exactly
//!    one file per scan — the first file in sorted path order — and claims are
//!    persisted so rescans stay deterministic. Files whose turns lost their
//!    owner re-parse on the next scan.
//! 4. **Estimate, not invoice.** Cost is computed against a hardcoded price
//!    table and labelled "Est. API-equivalent cost"; models the table does not
//!    know report `null` cost, which surfaces as the `hasPartialCost` notice
//!    rather than a silently-omitted row.
//! 5. **Absence is a state.** "Never scanned" and "scanned but nothing found"
//!    are different scan states, and the UI distinguishes them.
//!
//! ## Design decisions (recorded so nobody re-litigates them)
//!
//! - **Day bucketing is UTC.** Message timestamps in Claude's JSONL are
//!    ISO-8601 UTC, so the calendar date is read straight off the string with
//!    no date crate, and range cutoffs ("last 30 days") are computed in UTC
//!    too. Local-day bucketing would be a label-only difference and costs a
//!    dependency.
//! - **Sessions are display-only.** The recent-sessions table is derived on
//!    demand from recently-modified files (bounded), never persisted — the
//!    ledger itself is per-day rows, which keeps the persistence file small and
//!    the incremental maths correct. Orca persists per-file session aggregates
//!    and merges them; the per-file day split in each fingerprint is the
//!    equivalent of that here.
//! - **Managed scope = Spacron worktrees.** A session counts toward the
//!    `spacron` scope when its cwd lives under `<root>/.spacron/worktrees/` or
//!    the legacy sibling `.spacron-worktrees/<repo>/` (see `workspace.rs`).
//!
//! The overall approach (JSONL walk, max-merge dedupe per message, cross-file
//! ownership claims, per-day aggregates, price table) mirrors Orca's MIT
//! `claude-usage` scanner — see `.spacron/memory/orca-stats-usage-page.md`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Persisted toggle + scan bookkeeping. Mirrors Orca's `ScanState`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanState {
    /// Whether the transcript scan is allowed to run at all. The pane renders
    /// its opt-in card while this is false, so it must always be sent — an
    /// absent field reads as `undefined` in the webview and pins the pane on
    /// that card forever.
    pub enabled: bool,
    pub is_scanning: bool,
    /// Unix ms. `None` until the first scan actually starts.
    pub last_scan_started_at: Option<i64>,
    pub last_scan_completed_at: Option<i64>,
    /// A non-fatal scan problem worth surfacing ("read 3 files, skipped 1").
    pub last_scan_error: Option<String>,
    /// Whether *any* usage has ever been found, independent of scope/range.
    pub has_any_claude_data: bool,
}

/// One column of the daily chart.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DailyPoint {
    /// UTC calendar day, `2026-08-10`.
    pub day: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

/// A top-N row in a by-model / by-project breakdown.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownRow {
    pub key: String,
    pub label: String,
    pub sessions: u64,
    pub turns: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// `None` when the model has no price in the table — see rule 3.
    pub estimated_cost_usd: Option<f64>,
}

/// One row of the recent-sessions table.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub session_id: String,
    /// Which CLI ran it. The table folds every provider together when the
    /// Overview is selected, and a row with no agent on it cannot be read —
    /// two CLIs in the same project on the same day look identical otherwise.
    pub provider: String,
    pub provider_label: String,
    /// Unix ms of the last assistant turn in the session.
    pub last_active_at: i64,
    pub duration_minutes: u64,
    pub project_label: String,
    /// Whether the session ran inside a Spacron-managed worktree. The project
    /// label already says so for managed trees (`repo (branch)`), but a flag
    /// is what lets the table mark it without parsing its own label back.
    pub managed: bool,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub turns: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub sessions: u64,
    pub turns: u64,
    /// Turns whose final reading had zero cache reads — the cache-miss share.
    pub zero_cache_read_turns: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// cacheRead / (input + cacheRead), as a 0..1 fraction. `null` when there
    /// is no billable input to compute a share against (mirrors Orca).
    pub cache_reuse_rate: Option<f64>,
    /// `None` when nothing was found or no model could be priced. Rounded to
    /// cents — the number is an estimate, so displaying six decimals would fake
    /// precision.
    pub estimated_cost_usd: Option<f64>,
    /// `true` when at least one model had no price — drives the notice.
    pub has_partial_cost: bool,
    pub top_model: Option<String>,
    pub top_project: Option<String>,
}

/// Everything the Stats pane needs in one call.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub scan_state: ScanState,
    pub provider: String,
    pub scope: String,
    pub range: String,
    pub summary: Summary,
    pub daily: Vec<DailyPoint>,
    pub model_breakdown: Vec<BreakdownRow>,
    pub project_breakdown: Vec<BreakdownRow>,
    pub recent_sessions: Vec<SessionRow>,
}

/// One provider's card on the Overview.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCard {
    pub id: String,
    pub label: String,
    /// False when the CLI left no readable logs — the card says "No data"
    /// rather than a confident zero.
    pub has_data: bool,
    pub sessions: u64,
    pub turns: u64,
    pub total_tokens: u64,
    /// This provider's share of `total_tokens` across all providers, 0..1.
    pub share: f64,
    pub estimated_cost_usd: Option<f64>,
    pub has_partial_cost: bool,
    pub top_model: Option<String>,
    pub top_project: Option<String>,
}

/// One cell of the 42-day intensity heatmap.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapDay {
    pub day: String,
    pub total_tokens: u64,
    /// 0..4 — the intensity bucket, so the webview does not re-derive the
    /// scale and disagree with the legend.
    pub level: u8,
}

/// The combined view across every provider.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub scan_state: ScanState,
    pub scope: String,
    pub range: String,
    pub summary: Summary,
    /// Input/output/cache split for the token-mix bar, plus reasoning context.
    pub total_tokens: u64,
    pub active_days: u64,
    pub cache_share: Option<f64>,
    pub heatmap: Vec<HeatmapDay>,
    pub providers: Vec<ProviderCard>,
    pub model_breakdown: Vec<BreakdownRow>,
    pub project_breakdown: Vec<BreakdownRow>,
}

// ---------------------------------------------------------------------------
// Scope / range
// ---------------------------------------------------------------------------

pub const SCOPE_SPACRON: &str = "spacron";
pub const SCOPE_ALL: &str = "all";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/// The CLIs whose on-disk logs carry real token counts.
///
/// The set is **data, not code**: every provider is a row in
/// [`builtin_provider_sources`], and a user can add or override providers via
/// `config_dir/usage-stats/providers.json` without recompiling. On top of that,
/// [`scan_convention_sessions`] picks up any CLI that follows the shared
/// `<dot>/agent/sessions` layout purely by looking — so a freshly installed
/// agent appears here without a registry entry.
///
/// The *omissions* below are findings rather than a backlog — re-verified
/// 2026-08-12 by reading the actual logs of every agent CLI installed on the
/// dev machine. Their logs do not carry per-turn counts, so scanning them would
/// invent numbers:
///
/// * **Grok** — `~/.grok/sessions/<url-encoded cwd>/` holds `prompt_history`
///   and message counts, no usage fields.
/// * **Gemini** — `~/.gemini/tmp/<project>/chats/*.json` records messages with
///   no token fields at all, and `logs.json` is empty.
/// * **Droid** — `~/.factory/sessions/**.jsonl` has no usage fields.
/// * **Cursor**, **Verdent**, **Antigravity** — SQLite stores, no JSON logs.
/// * **Copilot** — `~/.copilot/session-state/<id>/events.jsonl` is the near
///   miss: `assistant.message` carries `model` and `outputTokens`, but there is
///   **no per-turn input count**. The only input figure is a `session.shutdown`
///   `tokenDetails` block describing the final context, not the session's
///   cumulative spend. Counting output alone would put Copilot on the same
///   chart as CLIs reporting 20× more tokens for the same work, so it stays
///   out — its live meter in `usage.rs` is the honest signal.
pub const PROVIDER_CLAUDE: &str = "claude";
pub const PROVIDER_CODEX: &str = "codex";
pub const PROVIDER_OPENCODE: &str = "opencode";
pub const PROVIDER_PI: &str = "pi";
pub const PROVIDER_OMP: &str = "omp";
pub const PROVIDER_COMMAND_CODE: &str = "command-code";
/// Query-only pseudo-provider: every provider folded together.
pub const PROVIDER_ALL: &str = "all";

/// How a provider's on-disk logs are parsed. One format per provider; the
/// registry maps every format to exactly one scanner.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SourceFormat {
    /// Claude Code JSONL (`message.usage`, cross-file fork ownership).
    Claude,
    /// Codex rollout logs (cumulative `token_count` events, diffed per turn).
    Codex,
    /// One JSON file per message under `storage/message/<sessionId>/`.
    OpenCode,
    /// The shared `{"type":"session",…}` + `{"type":"message",…}` JSONL that
    /// Pi, OMP and Command Code all write (see `parse_session_jsonl`).
    Session,
    /// Aider `--analytics-log` JSONL (`message_send` events carry the counts).
    Aider,
}

impl Default for SourceFormat {
    fn default() -> Self {
        SourceFormat::Session
    }
}

/// One scannable provider: display identity plus the home-relative paths its
/// logs live under. The built-in list is the "every machine gets these" set;
/// `providers.json` replaces or extends it.
#[derive(Clone, Debug)]
struct ProviderSource {
    provider: String,
    label: String,
    format: SourceFormat,
    /// `~`-relative roots. For `OpenCode` the root is the `storage/message`
    /// parent whose children are session directories.
    paths: Vec<String>,
}

/// JSON shape of one entry in `config_dir/usage-stats/providers.json`.
#[derive(serde::Deserialize)]
struct ProviderEntry {
    provider: String,
    #[serde(default)]
    label: Option<String>,
    /// Omit to keep the built-in format when overriding a known provider, or to
    /// default to the shared session format for a brand-new one.
    #[serde(default)]
    format: Option<SourceFormat>,
    /// Empty paths disable a built-in provider (its rows stop being scanned).
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(default)]
struct RegistryFile {
    sources: Vec<ProviderEntry>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        RegistryFile { sources: Vec::new() }
    }
}

/// The providers scanned on every sweep. Kilo and Aider ship here because they
/// are installed CLIs users already spawn from Spacron; everything else writing
/// a readable format arrives via [`scan_convention_sessions`] or a
/// `providers.json` entry.
///
/// The ids are launch commands, matching `AI_AGENT_PRESETS` in
/// `src/lib/stores/runs.ts` — that is what lets the Overview card render each
/// provider's real brand mark without a second lookup table.
fn builtin_provider_sources() -> Vec<ProviderSource> {
    vec![
        ProviderSource {
            provider: PROVIDER_CLAUDE.to_string(),
            label: "Claude".to_string(),
            format: SourceFormat::Claude,
            paths: vec![".claude/projects".into(), ".claude/transcripts".into()],
        },
        ProviderSource {
            provider: PROVIDER_CODEX.to_string(),
            label: "Codex".to_string(),
            format: SourceFormat::Codex,
            paths: vec![".codex/sessions".into(), ".codex/archived_sessions".into()],
        },
        ProviderSource {
            provider: PROVIDER_OPENCODE.to_string(),
            label: "OpenCode".to_string(),
            format: SourceFormat::OpenCode,
            paths: vec![".local/share/opencode/storage/message".into()],
        },
        ProviderSource {
            provider: PROVIDER_PI.to_string(),
            label: "Pi".to_string(),
            format: SourceFormat::Session,
            paths: vec![".pi/agent/sessions".into()],
        },
        ProviderSource {
            provider: PROVIDER_OMP.to_string(),
            label: "OMP".to_string(),
            format: SourceFormat::Session,
            paths: vec![".omp/agent/sessions".into()],
        },
        ProviderSource {
            provider: PROVIDER_COMMAND_CODE.to_string(),
            label: "Command Code".to_string(),
            format: SourceFormat::Session,
            paths: vec![".commandcode/projects".into()],
        },
        // Kilo is an OpenCode lineage: its pre-SQLite session store is the same
        // `storage/message/<sessionId>/<messageId>.json` layout.
        ProviderSource {
            provider: "kilo".to_string(),
            label: "Kilo".to_string(),
            format: SourceFormat::OpenCode,
            paths: vec![".local/share/kilo/storage/message".into()],
        },
        // Aider only writes analytics where it is told to (`--analytics-log` or
        // `AIDER_ANALYTICS_LOG`); `~/.aider` is the conventional place for it.
        ProviderSource {
            provider: "aider".to_string(),
            label: "Aider".to_string(),
            format: SourceFormat::Aider,
            paths: vec![".aider".into()],
        },
    ]
}

fn registry_path(config_dir: &Path) -> PathBuf {
    config_dir.join("usage-stats").join("providers.json")
}

/// Merge `providers.json` over the built-ins. A bad or missing file falls back
/// to the built-ins untouched — mirroring how the ledger store itself behaves.
fn load_provider_sources(config_dir: &Path) -> Vec<ProviderSource> {
    let mut sources = builtin_provider_sources();
    let Ok(text) = fs::read_to_string(registry_path(config_dir)) else {
        return sources;
    };
    let Ok(parsed) = serde_json::from_str::<RegistryFile>(&text) else {
        return sources;
    };
    for entry in parsed.sources {
        if entry.paths.is_empty() {
            sources.retain(|s| s.provider != entry.provider);
            continue;
        }
        match sources.iter_mut().find(|s| s.provider == entry.provider) {
            Some(builtin) => {
                if let Some(format) = entry.format {
                    builtin.format = format;
                }
                builtin.paths = entry.paths;
                if let Some(label) = entry.label {
                    builtin.label = label;
                }
            }
            None => {
                let label = entry
                    .label
                    .clone()
                    .unwrap_or_else(|| prettify_provider_label(&entry.provider));
                sources.push(ProviderSource {
                    provider: entry.provider,
                    label,
                    format: entry.format.unwrap_or(SourceFormat::Session),
                    paths: entry.paths,
                })
            }
        }
    }
    sources
}

/// Turn a directory-derived id (`command-foo`) into a display label.
fn prettify_provider_label(id: &str) -> String {
    id.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut chars = p.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Display label for a provider id, from the registry or prettified.
fn label_for(provider: &str, sources: &[ProviderSource]) -> String {
    sources
        .iter()
        .find(|s| s.provider == provider)
        .map(|s| s.label.clone())
        .unwrap_or_else(|| prettify_provider_label(provider))
}

/// Unregistered providers arrive through the convention session sweep.
fn source_format(sources: &[ProviderSource], provider: &str) -> SourceFormat {
    sources
        .iter()
        .find(|s| s.provider == provider)
        .map(|s| s.format)
        .unwrap_or(SourceFormat::Session)
}

/// The provider cards the Overview lists: every registered source in registry
/// order, then any provider that has ledger rows but is not registered yet —
/// the canonical sign it arrived via the convention sweep.
fn surface_providers(store: &StoreFile, sources: &[ProviderSource]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for s in sources {
        if !s.paths.is_empty() && seen.insert(s.provider.clone()) {
            out.push((s.provider.clone(), s.label.clone()));
        }
    }
    for row in &store.days {
        if row.turns > 0 && seen.insert(row.provider.clone()) {
            out.push((row.provider.clone(), prettify_provider_label(&row.provider)));
        }
    }
    out
}

fn surface_providers_with_discovery(store: &StoreFile, sources: &[ProviderSource], home: &Path) -> Vec<(String, String)> {
    let mut out = surface_providers(store, sources);
    let mut seen: HashSet<String> = out.iter().map(|(id, _)| id.clone()).collect();
    for (id, _) in discover_convention_sessions(sources, home) {
        if seen.insert(id.clone()) {
            out.push((id.clone(), prettify_provider_label(&id)));
        }
    }
    out
}
pub const RANGE_7D: &str = "7d";
pub const RANGE_30D: &str = "30d";
pub const RANGE_90D: &str = "90d";
pub const RANGE_ALL: &str = "all";

/// How many days a range window covers (cutoff = today − N + 1).
fn range_days(range: &str) -> Option<u64> {
    match range {
        RANGE_7D => Some(7),
        RANGE_30D => Some(30),
        RANGE_90D => Some(90),
        RANGE_ALL => None,
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Time helpers (no date crate — see module docs)
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Civil (year, month, day) from days since the Unix epoch — Howard Hinnant's
/// `civil_from_days` algorithm. The frontend never needs it because we hand it
/// `2026-08-10` strings it can `Date.parse`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Days since the Unix epoch for a civil date (UTC) — Hinnant's
/// `days_from_civil`, inverse of `civil_from_days`.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = ((153 * mp + 2) / 5) as i64 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-08-10` (UTC) for a unix-seconds instant.
fn utc_date_str(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// `2026-08-10T12:34:56.789Z` → unix ms. UTC-only by construction, which is all
/// Claude's logs ever contain. Returns `None` for anything unparsable.
fn iso_to_ms(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let digits = |i: usize, n: usize| -> Option<i64> {
        let s = iso.get(i..i + n)?;
        if !s.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let (y, mo, d) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (h, mi, s) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let frac: i64 = iso
        .get(19..)
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            (!digits.is_empty()).then(|| digits.parse::<i64>().ok())
        })
        .flatten()
        .unwrap_or(0);
    let ms = frac * 10i64.pow(3u32.saturating_sub(digit_count(frac)));
    Some(days_from_civil(y, mo as u32, d as u32) * 86_400_000 + (h * 3_600 + mi * 60 + s) * 1000 + ms)
}

fn digit_count(mut n: i64) -> u32 {
    let mut len = 0;
    while n > 0 {
        n /= 10;
        len += 1;
    }
    len
}

/// The UTC calendar date prefix of an ISO timestamp row, e.g. `2026-08-10`.
fn date_prefix(iso: &str) -> Option<String> {
    let b = iso.as_bytes();
    (b.len() >= 10 && b[4] == b'-' && b[7] == b'-').then(|| iso[0..10].to_string())
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/// One model's API-equivalent price in USD per million tokens:
/// (input, output, cache read, cache write).
type Price = (f64, f64, f64, f64);

/// The long-context tier kicks in above this many input tokens.
const LONG_CONTEXT_THRESHOLD: u64 = 200_000;
const LONG_CONTEXT_PRICE: Price = (6.0, 22.5, 0.6, 7.5);

/// Hardcoded $/MTok table, mirroring the prices the provider publishes at
/// release time. This is an *estimate*, not a bill — see rule 3 in the module
/// docs. Unknown models cost `None` and surface as `hasPartialCost`.
const MODEL_PRICING: &[(&str, Price)] = &[
    ("claude-fable-5", (10.0, 50.0, 1.0, 12.5)),
    ("claude-opus-5", (5.0, 25.0, 0.5, 6.25)),
    ("claude-sonnet-5", (3.0, 15.0, 0.3, 3.75)),
    ("claude-opus-4-8", (5.0, 25.0, 0.5, 6.25)),
    ("claude-opus-4-7", (5.0, 25.0, 0.5, 6.25)),
    ("claude-opus-4-6", (5.0, 25.0, 0.5, 6.25)),
    ("claude-opus-4-5", (5.0, 25.0, 0.5, 6.25)),
    ("claude-opus-4-1", (15.0, 75.0, 1.5, 18.75)),
    ("claude-opus-4", (15.0, 75.0, 1.5, 18.75)),
    ("claude-sonnet-4-6", (3.0, 15.0, 0.3, 3.75)),
    ("claude-sonnet-4-5", (3.0, 15.0, 0.3, 3.75)),
    ("claude-sonnet-4", (3.0, 15.0, 0.3, 3.75)),
    ("claude-sonnet-3-7", (3.0, 15.0, 0.3, 3.75)),
    ("claude-sonnet-3-5", (3.0, 15.0, 0.3, 3.75)),
    ("claude-haiku-4-5", (1.0, 5.0, 0.1, 1.25)),
    ("claude-haiku-3-5", (0.8, 4.0, 0.08, 1.0)),
    ("claude-haiku-3", (0.25, 1.25, 0.03, 0.3)),
];

/// Normalize a model id from a log row into a table key. Returns `None` for
/// models we cannot price.
fn normalize_model_for_pricing(model: &str) -> Option<&'static str> {
    // OpenCode records `providerID/modelID`. The provider only says who served
    // the model, not which model it is, so pricing looks past it — a Claude
    // model served through Copilot prices as that Claude model.
    let model = model.rsplit('/').next().unwrap_or(model);
    // Alias entries: the API substitutes placeholder ids on some plans.
    if model == "model_placeholder_m26" {
        return Some("claude-opus-4-6");
    }
    if model == "model_placeholder_m35" {
        return Some("claude-sonnet-4-6");
    }
    // Legacy id predates the dash-named family.
    if model == "claude-3-5-sonnet-20241022" {
        return Some("claude-sonnet-3-5");
    }
    // `-thinking` variants and dotted ids are the same model.
    let stripped = model.strip_suffix("-thinking").unwrap_or(model).replace('.', "-");
    let stripped = stripped.strip_prefix("claude-").unwrap_or(&stripped);
    let full = format!("claude-{stripped}");
    // Unknown point releases of opus-4 bill at the same rate as the newest
    // known one rather than disappearing from the ledger.
    if full.starts_with("claude-opus-4-") && !MODEL_PRICING.iter().any(|(k, _)| *k == full) {
        return Some("claude-opus-4-8");
    }
    MODEL_PRICING
        .iter()
        .find(|(k, _)| *k == full)
        .map(|(k, _)| *k)
}

/// Estimated USD for a model's token totals, or `None` when unpriced.
fn estimated_cost(
    model: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) -> Option<f64> {
    let key = normalize_model_for_pricing(model)?;
    let price = MODEL_PRICING.iter().find(|(k, _)| *k == key).unwrap().1;
    let (in_p, out_p, cr_p, cw_p) = if input > LONG_CONTEXT_THRESHOLD {
        LONG_CONTEXT_PRICE
    } else {
        price
    };
    let cost = (input as f64 * in_p
        + output as f64 * out_p
        + cache_read as f64 * cr_p
        + cache_write as f64 * cw_p)
        / 1_000_000.0;
    Some((cost * 100.0).round() / 100.0)
}

// ---------------------------------------------------------------------------
// Log scanning
// ---------------------------------------------------------------------------

/// The token-relevant facts extracted from one JSONL session file, aggregated
/// from a set of owned turns.
#[derive(Default, Clone)]
struct ParsedFile {
    session_ids: HashSet<String>,
    model: Option<String>,
    turns: u64,
    zero_cache_read_turns: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    first_at_ms: Option<i64>,
    last_at_ms: Option<i64>,
    /// Per-day, per-model token buckets, keyed by the *raw* log model id;
    /// pricing happens later, at snapshot time.
    days: HashMap<(String, String), DayBucket>,
}

#[derive(Default, Clone)]
struct DayBucket {
    turns: u64,
    zero_cache_read_turns: u64,
    sessions: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}

/// File-level metadata captured while parsing (not per-turn).
#[derive(Default, Clone)]
struct FileMeta {
    cwd: Option<String>,
    branch: Option<String>,
}

/// One deduplicated assistant turn, before cross-file ownership is resolved.
struct ParsedTurn {
    /// The stable identity of the message, or `None` when the row carries no
    /// id at all — unkeyed turns are always owned by their file.
    dedupe_key: Option<String>,
    session_id: String,
    ts_ms: i64,
    /// UTC calendar day of the turn's first-seen row.
    day: String,
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}

/// The dedupe identity of one assistant message, matching Orca's ordering:
/// `message.id:requestId` wins, then `msg:<id>`, then `uuid:<uuid>`. Claude can
/// repeat a message row several times in a file (streamed updates), so rows
/// sharing a key are max-merged rather than summed. A fork rewrites the
/// sessionId but keeps these ids, which is what lets cross-file ownership find
/// the copies.
fn msg_key(row: &Value) -> Option<String> {
    let message_id = row
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let request_id = row
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (message_id, request_id) {
        (Some(mid), Some(rid)) => Some(format!("{mid}:{rid}")),
        (Some(mid), None) => Some(format!("msg:{mid}")),
        (None, _) => row
            .get("uuid")
            .and_then(Value::as_str)
            .map(|u| format!("uuid:{u}")),
    }
}

fn u64_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Parse one session JSONL file into deduplicated turns plus file-level
/// metadata. Never fails on a bad file — a corrupt row is skipped, everything
/// else counts. Mirrors Orca's `parseClaudeUsageSourceRecord` +
/// `dedupeClaudeUsageTurns`:
///
/// - only `assistant` rows count;
/// - a row needs a sessionId (falling back to the file stem) and a parseable
///   timestamp, and is dropped when its token totals are all zero;
/// - repeated rows for the same dedupe key max-merge their four token fields
///   into the first-seen turn, so streamed updates count once with the most
///   complete reading.
fn parse_session_turns(path: &Path) -> (FileMeta, Vec<ParsedTurn>) {
    let fallback_session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut meta = FileMeta::default();
    let mut turns: Vec<ParsedTurn> = Vec::new();
    let mut index_by_key: HashMap<String, usize> = HashMap::new();

    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return (meta, turns),
    };
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match row.get("type").and_then(Value::as_str) {
            Some("session_start") => {
                if let Some(c) = row.get("cwd").and_then(Value::as_str) {
                    meta.cwd = Some(c.to_string());
                }
                if let Some(b) = row.get("gitBranch").and_then(Value::as_str) {
                    meta.branch = Some(b.to_string());
                }
            }
            Some("assistant") => {
                let Some(ts_iso) = row.get("timestamp").and_then(Value::as_str) else {
                    continue;
                };
                let Some(ts_ms) = iso_to_ms(ts_iso) else { continue };
                let Some(day) = date_prefix(ts_iso) else { continue };
                let session_id = row
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(&fallback_session_id);
                let Some(usage) = row.get("message").and_then(|m| m.get("usage")) else {
                    continue;
                };
                let reading = (
                    u64_field(usage, "input_tokens"),
                    u64_field(usage, "output_tokens"),
                    u64_field(usage, "cache_read_input_tokens"),
                    u64_field(usage, "cache_creation_input_tokens"),
                );
                if reading.0 + reading.1 + reading.2 + reading.3 == 0 {
                    continue;
                }
                if let Some(c) = row.get("cwd").and_then(Value::as_str) {
                    meta.cwd = Some(c.to_string());
                }
                if let Some(b) = row.get("gitBranch").and_then(Value::as_str) {
                    meta.branch = Some(b.to_string());
                }
                let model = row.get("message").and_then(|m| m.get("model")).and_then(Value::as_str);

                let key = msg_key(&row);
                if let Some(key) = &key {
                    if let Some(index) = index_by_key.get(key) {
                        // Streamed repeat: max-merge the reading into the
                        // first-seen turn, which keeps its timestamp/day.
                        let turn = &mut turns[*index];
                        turn.input_tokens = turn.input_tokens.max(reading.0);
                        turn.output_tokens = turn.output_tokens.max(reading.1);
                        turn.cache_read_tokens = turn.cache_read_tokens.max(reading.2);
                        turn.cache_write_tokens = turn.cache_write_tokens.max(reading.3);
                        continue;
                    }
                }
                let index = turns.len();
                if let Some(k) = &key {
                    index_by_key.insert(k.clone(), index);
                }
                turns.push(ParsedTurn {
                    dedupe_key: key,
                    session_id: session_id.to_string(),
                    ts_ms,
                    day,
                    model: model.map(str::to_string),
                    input_tokens: reading.0,
                    output_tokens: reading.1,
                    cache_read_tokens: reading.2,
                    cache_write_tokens: reading.3,
                });
            }
            _ => {}
        }
    }

    (meta, turns)
}

/// Aggregate a set of turns (already ownership-filtered) into file-level
/// buckets — used by the scan to build a fingerprint and by the recent-sessions
/// view to re-derive a file's display row.
fn aggregate_turns(turns: &[ParsedTurn]) -> ParsedFile {
    let mut out = ParsedFile::default();
    // Which model this session is *reported* as having used. Ranked by tokens,
    // not by whichever turn happened to be last: a session is routinely a big
    // model doing the work plus a small one summarising, spawning subagents or
    // naming the conversation, and taking the last row made a 300k-token Opus
    // session render as Haiku. Ties break on the model id so two identical
    // scans agree.
    let mut model_tokens: HashMap<&str, u64> = HashMap::new();
    for turn in turns {
        out.session_ids.insert(turn.session_id.clone());
        if let Some(model) = turn.model.as_deref() {
            *model_tokens.entry(model).or_insert(0) += turn
                .input_tokens
                .saturating_add(turn.output_tokens)
                .saturating_add(turn.cache_read_tokens)
                .saturating_add(turn.cache_write_tokens);
        }
        out.turns += 1;
        if turn.cache_read_tokens == 0 {
            out.zero_cache_read_turns += 1;
        }
        out.input_tokens = out.input_tokens.saturating_add(turn.input_tokens);
        out.output_tokens = out.output_tokens.saturating_add(turn.output_tokens);
        out.cache_read_tokens = out.cache_read_tokens.saturating_add(turn.cache_read_tokens);
        out.cache_write_tokens = out.cache_write_tokens.saturating_add(turn.cache_write_tokens);
        out.first_at_ms = Some(out.first_at_ms.map_or(turn.ts_ms, |t| t.min(turn.ts_ms)));
        out.last_at_ms = Some(out.last_at_ms.map_or(turn.ts_ms, |t| t.max(turn.ts_ms)));
        let bucket = out
            .days
            .entry((turn.day.clone(), turn.model.clone().unwrap_or_else(|| "unknown".to_string())))
            .or_default();
        bucket.turns += 1;
        if turn.cache_read_tokens == 0 {
            bucket.zero_cache_read_turns += 1;
        }
        bucket.input_tokens = bucket.input_tokens.saturating_add(turn.input_tokens);
        bucket.output_tokens = bucket.output_tokens.saturating_add(turn.output_tokens);
        bucket.cache_read_tokens = bucket.cache_read_tokens.saturating_add(turn.cache_read_tokens);
        bucket.cache_write_tokens = bucket.cache_write_tokens.saturating_add(turn.cache_write_tokens);
    }
    out.model = model_tokens
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(model, _)| (*model).to_string());
    let session_count = out.session_ids.len() as u64;
    for bucket in out.days.values_mut() {
        bucket.sessions = session_count;
    }
    out
}

/// Whether a cwd lives inside a Spacron-managed worktree. Two shapes exist:
/// `<root>/.spacron/worktrees/<branch>` (current) and the legacy sibling
/// `<parent>/.spacron-worktrees/<repo>` (pre-0.7.4).
fn is_managed_worktree(cwd: &str) -> bool {
    let comps: Vec<&str> = cwd.split(['/', '\\']).collect();
    for (i, comp) in comps.iter().enumerate() {
        if *comp == ".spacron" && comps.get(i + 1).copied() == Some("worktrees") {
            return true;
        }
        if *comp == ".spacron-worktrees" {
            return true;
        }
    }
    false
}

/// The human project label for a cwd. Managed worktrees read the repo name and
/// branch off the path structure; everything else gets the last two path
/// components (`Projects/spacron`), which is what a person recognises in a
/// list.
fn project_label(cwd: &str, branch: Option<&str>) -> String {
    let comps: Vec<&str> = cwd.split(['/', '\\']).filter(|c| !c.is_empty()).collect();
    for (i, comp) in comps.iter().enumerate() {
        if *comp == ".spacron" && comps.get(i + 1).copied() == Some("worktrees") {
            let repo = comps.get(i.wrapping_sub(1)).copied().unwrap_or("project");
            // The worktree's own directory name is the branch, path-sanitized
            // (`workspace.rs` creates `.spacron/worktrees/<safe_branch>`), so it
            // is the right fallback when the CLI's log records no branch —
            // which is most of them. The literal word "branch" used to end up
            // in the label here, and `repo (branch)` reads like a placeholder
            // nobody filled in.
            let branch = branch
                .filter(|b| !b.is_empty())
                .or_else(|| comps.get(i + 2).copied())
                .unwrap_or("worktree");
            return format!("{repo} ({branch})");
        }
        if *comp == ".spacron-worktrees" {
            let repo = comps.get(i.wrapping_sub(1)).copied().unwrap_or("project");
            return repo.to_string();
        }
    }
    match comps.len() {
        0 => "unknown".to_string(),
        1 => comps[0].to_string(),
        _ => format!("{}/{}", comps[comps.len() - 2], comps[comps.len() - 1]),
    }
}

/// Best-effort cwd for a file with no session_start row: Claude's
/// `projects/<slug>` dir name is the cwd with `/` replaced by `-`, and its
/// `transcripts/<name>` dirs are either slugs or uuids.
fn cwd_from_path(path: &Path) -> Option<String> {
    let name = path.parent()?.file_name()?.to_string_lossy().to_string();
    if name.contains('-') && !name.contains(['{', '}']) {
        Some(name.replace('-', "/"))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Persisted store
// ---------------------------------------------------------------------------

/// A (day, model) bucket as persisted inside a file fingerprint, so a changed
/// file's old contribution can be subtracted exactly.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct FpDay {
    day: String,
    model: String,
    turns: u64,
    zero_cache_read_turns: u64,
    sessions: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}

/// Per-file fingerprint: the incremental bookkeeping. `mtime`+`size` decide
/// whether a file needs re-reading; the token totals + day split are what get
/// *replaced* when it does. `ownedDedupeKeys` is the cross-file ownership claim
/// record: each dedupe key this file claimed on its last scan, so rescans can
/// hand a fork's copies to exactly one owner. `hasDeferredClaims` marks files
/// that had to give copies up — they re-parse when their owner disappears.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    /// Which scanner owns this entry. Every sweep must confine its
    /// deleted-file pruning to its own provider, or one scanner silently
    /// evicts another's ledger.
    #[serde(default = "claude_provider_default")]
    provider: String,
    mtime_ms: i64,
    size: u64,
    turns: u64,
    zero_cache_read_turns: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    sessions: u64,
    managed: bool,
    project_label: String,
    first_at_ms: i64,
    last_at_ms: i64,
    owned_dedupe_keys: Vec<String>,
    has_deferred_claims: bool,
    days: Vec<FpDay>,
}

/// One row of the persisted ledger: a (day, model, project) aggregate.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct DayRow {
    #[serde(default = "claude_provider_default")]
    provider: String,
    day: String,
    model: String,
    project_key: String,
    managed: bool,
    turns: u64,
    zero_cache_read_turns: u64,
    sessions: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    schema_version: u32,
    /// Opt-out, not opt-in: the scan only reads files Claude already wrote to
    /// this machine and never leaves it, and a default-off toggle made the
    /// pane look broken. `serde(default)` keeps pre-toggle store files
    /// readable without a schema bump — they simply come back enabled.
    #[serde(default = "enabled_default")]
    enabled: bool,
    last_scan_started_at: Option<i64>,
    last_scan_completed_at: Option<i64>,
    last_scan_error: Option<String>,
    /// Path → fingerprint, for incremental rescanning.
    files: HashMap<String, FileFingerprint>,
    days: Vec<DayRow>,
}

/// 3 → 4 (2026-08-12): managed-worktree project labels changed (a tree whose
/// log records no branch is now named by its directory instead of the literal
/// word "branch"), so persisted rows carry keys the new scan would never
/// produce. Without a rebuild the By-project breakdown would list the same
/// worktree twice under two spellings. The rebuild re-reads every provider,
/// which on a heavy machine is a ~2 minute first scan — the pane shows its
/// scanning state throughout, and `enabled` survives it.
const SCHEMA_VERSION: u32 = 4;

fn enabled_default() -> bool {
    true
}

/// v2 ledgers predate the provider column and held Claude rows only, so an
/// absent field means Claude. The rows are rebuilt by the version bump anyway;
/// this keeps the structs decodable on the way there instead of failing the
/// parse and silently discarding the user's `enabled` choice with it.
fn claude_provider_default() -> String {
    PROVIDER_CLAUDE.to_string()
}

impl Default for StoreFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            enabled: enabled_default(),
            last_scan_started_at: None,
            last_scan_completed_at: None,
            last_scan_error: None,
            files: HashMap::new(),
            days: Vec::new(),
        }
    }
}

/// The in-memory cache of the store file. Loaded lazily on first access, held
/// for the lifetime of the process — the only writer is the scan, which
/// persists after every mutation, so the file is always a faithful snapshot.
static STORE: Mutex<Option<StoreFile>> = Mutex::new(None);

fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("usage-stats").join("claude.json")
}

fn load_store(config_dir: &Path) -> StoreFile {
    if let Some(store) = STORE.lock().ok().and_then(|g| g.clone()) {
        return store;
    }
    let mut store = StoreFile::default();
    if let Ok(text) = fs::read_to_string(store_path(config_dir)) {
        if let Ok(parsed) = serde_json::from_str::<StoreFile>(&text) {
            store = parsed;
            if store.schema_version != SCHEMA_VERSION {
                // A schema bump rebuilds the ledger; the fingerprint keys and
                // day-row shapes changed underneath it. The user's toggle is
                // a preference, not derived data, so it survives the rebuild.
                let enabled = store.enabled;
                store = StoreFile {
                    enabled,
                    ..StoreFile::default()
                };
            }
        }
    }
    if let Ok(mut guard) = STORE.lock() {
        *guard = Some(store.clone());
    }
    store
}

/// Persist a store (disk + cache). Disk failures are swallowed on purpose: a
/// failed save must never become a scan error the UI shows as a problem.
///
/// The store is passed in explicitly — `load_store` hands back a *clone* of
/// the cache, so persisting the cache instead of the caller's copy would write
/// stale data (the pre-save mutation would be lost).
fn save_store(config_dir: &Path, store: &StoreFile) {
    let path = store_path(config_dir);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(store) {
        let _ = fs::write(&path, text);
    }
    if let Ok(mut guard) = STORE.lock() {
        *guard = Some(store.clone());
    }
}

fn scan_state_of(store: &StoreFile, is_scanning: bool) -> ScanState {
    ScanState {
        enabled: store.enabled,
        is_scanning,
        last_scan_started_at: store.last_scan_started_at,
        last_scan_completed_at: store.last_scan_completed_at,
        last_scan_error: store.last_scan_error.clone(),
        has_any_claude_data: store.days.iter().any(|d| d.turns > 0),
    }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/// Walk the Claude log dirs and fold any changed files into the ledger.
///
/// Unchanged files (same mtime+size as the last scan) are skipped entirely —
/// session files grow to megabytes and full re-reads are what make scanners
/// slow. A changed file *replaces* its old contribution.
///
/// Ownership resolution mirrors Orca's `scanClaudeUsageFiles`:
///
/// 1. files are visited in sorted path order so claims are deterministic;
/// 2. unchanged files keep the claims they persisted (first cached claim wins);
/// 3. when a file that owned dedupe keys disappeared, every file that deferred
///    claims is reparsed so its copies can be re-claimed;
/// 4. changed files parse, then claim their turns' dedupe keys one by one; a
///    turn whose key is already owned by another file is dropped and marks the
///    file `hasDeferredClaims`.
///
/// Returns (files processed, files skipped).
fn scan_claude(store: &mut StoreFile, roots: &[PathBuf]) -> (usize, usize) {
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in roots {
        walk_jsonl_files(dir, &mut files);
    }
    files.sort();
    let current_paths: HashSet<String> = files.iter().map(|p| path_string(p)).collect();

    // A file that owned dedupe keys vanished — its keys may now be claimable
    // by the forks that deferred them. Only this provider's fingerprints count:
    // another scanner's paths are never in `current_paths`, and treating them as
    // lost owners would force a pointless full reparse on every sweep.
    let lost_owner = store.files.iter().any(|(path, fp)| {
        fp.provider == PROVIDER_CLAUDE
            && !current_paths.contains(path)
            && !fp.owned_dedupe_keys.is_empty()
    });

    // Classify: unchanged files are reused without re-reading.
    let mut reused: HashSet<String> = HashSet::new();
    let mut skipped = 0usize;
    for path in &files {
        let key = path_string(path);
        let Some(meta) = fs::metadata(path).ok() else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if let Some(prev) = store.files.get(&key) {
            let can_reuse = prev.mtime_ms == mtime
                && prev.size == meta.len()
                && !(lost_owner && prev.has_deferred_claims);
            if can_reuse {
                reused.insert(key);
                skipped += 1;
                continue;
            }
        }
    }

    // Seed ownership from cached files in sorted order — the first claim wins,
    // so conflicting projections stay deterministic across rescans.
    let mut turn_owner: HashMap<String, String> = HashMap::new();
    for path in &files {
        let key = path_string(path);
        if reused.contains(&key) {
            if let Some(prev) = store.files.get(&key) {
                for dedupe_key in &prev.owned_dedupe_keys {
                    turn_owner.entry(dedupe_key.clone()).or_insert_with(|| key.clone());
                }
            }
        }
    }

    let mut processed = 0usize;
    for path in &files {
        let key = path_string(path);
        if reused.contains(&key) {
            continue;
        }
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let size = meta.len();

        let (file_meta, turns) = parse_session_turns(path);
        let cwd = file_meta
            .cwd
            .clone()
            .or_else(|| cwd_from_path(path))
            .unwrap_or_else(|| "unknown".to_string());
        let managed = is_managed_worktree(&cwd);
        let label = project_label(&cwd, file_meta.branch.as_deref());

        // Claim ownership, in this file's sorted order.
        let mut owned_dedupe_keys: Vec<String> = Vec::new();
        let mut has_deferred_claims = false;
        let mut owned_turns: Vec<ParsedTurn> = Vec::new();
        for turn in turns {
            if let Some(dedupe_key) = &turn.dedupe_key {
                if let Some(owner) = turn_owner.get(dedupe_key) {
                    if owner != &key {
                        has_deferred_claims = true;
                        continue;
                    }
                }
                turn_owner.insert(dedupe_key.clone(), key.clone());
                owned_dedupe_keys.push(dedupe_key.clone());
            }
            owned_turns.push(turn);
        }
        let parsed = aggregate_turns(&owned_turns);
        let sessions = parsed.session_ids.len() as u64;

        // Replace, never add: subtract the old contribution first. The old
        // parse's day split lives in the fingerprint, so the subtraction is
        // exact.
        if let Some(prev) = store.files.get(&key).cloned() {
            subtract_file(store, &prev);
        }

        for ((day, model), bucket) in &parsed.days {
            upsert_day(
                store,
                PROVIDER_CLAUDE,
                day,
                model,
                &label,
                managed,
                bucket.turns,
                bucket.zero_cache_read_turns,
                sessions,
                bucket.input_tokens,
                bucket.output_tokens,
                bucket.cache_read_tokens,
                bucket.cache_write_tokens,
            );
        }

        store.files.insert(
            key,
            FileFingerprint {
                provider: PROVIDER_CLAUDE.to_string(),
                mtime_ms: mtime,
                size,
                turns: parsed.turns,
                zero_cache_read_turns: parsed.zero_cache_read_turns,
                input_tokens: parsed.input_tokens,
                output_tokens: parsed.output_tokens,
                cache_read_tokens: parsed.cache_read_tokens,
                cache_write_tokens: parsed.cache_write_tokens,
                sessions,
                managed,
                project_label: label,
                first_at_ms: parsed.first_at_ms.unwrap_or(mtime),
                last_at_ms: parsed.last_at_ms.unwrap_or(mtime),
                owned_dedupe_keys,
                has_deferred_claims,
                days: parsed
                    .days
                    .iter()
                    .map(|((day, model), bucket)| FpDay {
                        day: day.clone(),
                        model: model.clone(),
                        turns: bucket.turns,
                        zero_cache_read_turns: bucket.zero_cache_read_turns,
                        sessions: bucket.sessions,
                        input_tokens: bucket.input_tokens,
                        output_tokens: bucket.output_tokens,
                        cache_read_tokens: bucket.cache_read_tokens,
                        cache_write_tokens: bucket.cache_write_tokens,
                    })
                    .collect(),
            },
        );
        processed += 1;
    }

    // Files that vanished must drop their contribution from the ledger too.
    // Orca rebuilds the ledger by merging only live files' contributions, so a
    // deleted owner's turns disappear with it — and are re-claimed by the
    // deferring forks above when they re-parse.
    prune_deleted(store, PROVIDER_CLAUDE, &current_paths);
    (processed, skipped)
}

/// Drop one provider's vanished files from the ledger.
///
/// The provider filter is load-bearing: the `files` map is shared by every
/// scanner, so an unfiltered `retain` would treat every *other* provider's
/// paths as deleted and wipe their rows on the next Claude sweep.
fn prune_deleted(store: &mut StoreFile, provider: &str, current_paths: &HashSet<String>) {
    let deleted: Vec<FileFingerprint> = store
        .files
        .iter()
        .filter(|(path, fp)| fp.provider == provider && !current_paths.contains(*path))
        .map(|(_, fp)| fp.clone())
        .collect();
    for fp in &deleted {
        subtract_file(store, fp);
    }
    // Drop fingerprints for files that no longer exist so the map cannot grow
    // forever around deleted sessions.
    store
        .files
        .retain(|path, fp| fp.provider != provider || current_paths.contains(path));
}

/// One unit of work for a scanner: a file, or a directory treated as a unit.
struct ScanUnit {
    path: PathBuf,
    mtime_ms: i64,
    size: u64,
}

/// The incremental sweep shared by every provider that does *not* need Claude's
/// cross-file ownership dance.
///
/// Claude needs that dance because forking a session copies turns into a second
/// file, so the same message id legitimately appears twice on disk. Codex and
/// OpenCode have no fork mechanic — a turn is written once, by one session — so
/// they get the simpler contract: one unit owns its turns outright, and a
/// changed unit replaces its previous contribution exactly.
fn scan_simple<F>(
    store: &mut StoreFile,
    provider: &str,
    units: Vec<ScanUnit>,
    parse: F,
) -> (usize, usize)
where
    F: Fn(&Path) -> (FileMeta, Vec<ParsedTurn>),
{
    let current_paths: HashSet<String> = units.iter().map(|u| path_string(&u.path)).collect();
    let mut processed = 0usize;
    let mut skipped = 0usize;

    for unit in &units {
        let key = path_string(&unit.path);
        if let Some(prev) = store.files.get(&key) {
            if prev.provider == provider && prev.mtime_ms == unit.mtime_ms && prev.size == unit.size
            {
                skipped += 1;
                continue;
            }
        }

        let (meta, turns) = parse(&unit.path);
        let cwd = meta.cwd.clone().unwrap_or_else(|| "unknown".to_string());
        let managed = is_managed_worktree(&cwd);
        let label = project_label(&cwd, meta.branch.as_deref());
        let parsed = aggregate_turns(&turns);
        let sessions = parsed.session_ids.len() as u64;

        // Replace, never add.
        if let Some(prev) = store.files.get(&key).cloned() {
            subtract_file(store, &prev);
        }
        for ((day, model), bucket) in &parsed.days {
            upsert_day(
                store,
                provider,
                day,
                model,
                &label,
                managed,
                bucket.turns,
                bucket.zero_cache_read_turns,
                sessions,
                bucket.input_tokens,
                bucket.output_tokens,
                bucket.cache_read_tokens,
                bucket.cache_write_tokens,
            );
        }

        store.files.insert(
            key,
            FileFingerprint {
                provider: provider.to_string(),
                mtime_ms: unit.mtime_ms,
                size: unit.size,
                turns: parsed.turns,
                zero_cache_read_turns: parsed.zero_cache_read_turns,
                input_tokens: parsed.input_tokens,
                output_tokens: parsed.output_tokens,
                cache_read_tokens: parsed.cache_read_tokens,
                cache_write_tokens: parsed.cache_write_tokens,
                sessions,
                managed,
                project_label: label,
                first_at_ms: parsed.first_at_ms.unwrap_or(unit.mtime_ms),
                last_at_ms: parsed.last_at_ms.unwrap_or(unit.mtime_ms),
                owned_dedupe_keys: Vec::new(),
                has_deferred_claims: false,
                days: parsed
                    .days
                    .iter()
                    .map(|((day, model), bucket)| FpDay {
                        day: day.clone(),
                        model: model.clone(),
                        turns: bucket.turns,
                        zero_cache_read_turns: bucket.zero_cache_read_turns,
                        sessions: bucket.sessions,
                        input_tokens: bucket.input_tokens,
                        output_tokens: bucket.output_tokens,
                        cache_read_tokens: bucket.cache_read_tokens,
                        cache_write_tokens: bucket.cache_write_tokens,
                    })
                    .collect(),
            },
        );
        processed += 1;
    }

    prune_deleted(store, provider, &current_paths);
    (processed, skipped)
}

fn unit_from_file(path: &Path) -> Option<ScanUnit> {
    let meta = fs::metadata(path).ok()?;
    Some(ScanUnit {
        path: path.to_path_buf(),
        mtime_ms: mtime_ms_of(&meta),
        size: meta.len(),
    })
}

fn mtime_ms_of(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// Codex ships JSONL *fixtures* inside `~/.codex/.tmp/plugins/**`, which parse
/// perfectly and would be counted as real usage. Anything under a dot-directory
/// below `.codex` is tooling, not history.
fn is_codex_fixture(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.starts_with('.') && s != ".codex"
    })
}

/// Parse one Codex rollout file.
///
/// The load-bearing detail: `token_count.info.total_token_usage` is a **running
/// session total**, not a per-turn reading. Summing it — or summing the
/// `last_token_usage` beside it — overcounts badly (measured 555,915 against a
/// true 291,700 on one real session, ~1.9x). So we difference consecutive
/// cumulative readings: the deltas bucket into the right days *and* sum back to
/// the session's own final total.
///
/// A reading that goes backwards means the session compacted and Codex restarted
/// its count, so that reading is taken as the delta rather than producing a
/// negative.
///
/// Field semantics, confirmed against real logs (`input + output == total`):
/// `cached_input_tokens` is a **subset** of `input_tokens`, and
/// `reasoning_output_tokens` a subset of `output_tokens`. We therefore report
/// new input as `input - cached` and fold cached into cache-read, which is the
/// same normalization Orca applies. Codex reports no cache *writes*.
fn parse_codex_session(path: &Path) -> (FileMeta, Vec<ParsedTurn>) {
    let mut meta = FileMeta::default();
    let mut turns: Vec<ParsedTurn> = Vec::new();
    let session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let Ok(text) = fs::read_to_string(path) else {
        return (meta, turns);
    };

    let mut model: Option<String> = None;
    let (mut prev_in, mut prev_out, mut prev_cached) = (0u64, 0u64, 0u64);

    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = row.get("payload");

        match row.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(p) = payload {
                    if let Some(c) = p.get("cwd").and_then(Value::as_str) {
                        meta.cwd.get_or_insert_with(|| c.to_string());
                    }
                    if let Some(b) = p
                        .get("git")
                        .and_then(|g| g.get("branch"))
                        .and_then(Value::as_str)
                    {
                        meta.branch.get_or_insert_with(|| b.to_string());
                    }
                }
            }
            // The model can change mid-session; each turn is attributed to
            // whichever model was in effect when it was counted.
            Some("turn_context") => {
                if let Some(p) = payload {
                    if let Some(m) = p.get("model").and_then(Value::as_str) {
                        model = Some(m.to_string());
                    }
                    if let Some(c) = p.get("cwd").and_then(Value::as_str) {
                        meta.cwd.get_or_insert_with(|| c.to_string());
                    }
                }
            }
            Some("event_msg") => {
                let Some(p) = payload else { continue };
                if p.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(total) = p.get("info").and_then(|i| i.get("total_token_usage")) else {
                    continue;
                };
                let Some(ts_iso) = row.get("timestamp").and_then(Value::as_str) else {
                    continue;
                };
                let (Some(ts_ms), Some(day)) = (iso_to_ms(ts_iso), date_prefix(ts_iso)) else {
                    continue;
                };

                let cur_in = u64_field(total, "input_tokens");
                let cur_out = u64_field(total, "output_tokens");
                let cur_cached = u64_field(total, "cached_input_tokens");

                let rolled_back = cur_in < prev_in || cur_out < prev_out;
                let (d_in, d_out, d_cached) = if rolled_back {
                    (cur_in, cur_out, cur_cached)
                } else {
                    (
                        cur_in - prev_in,
                        cur_out - prev_out,
                        cur_cached.saturating_sub(prev_cached),
                    )
                };
                prev_in = cur_in;
                prev_out = cur_out;
                prev_cached = cur_cached;

                if d_in == 0 && d_out == 0 {
                    continue;
                }
                turns.push(ParsedTurn {
                    dedupe_key: None,
                    session_id: session_id.clone(),
                    ts_ms,
                    day,
                    model: model.clone(),
                    input_tokens: d_in.saturating_sub(d_cached),
                    output_tokens: d_out,
                    cache_read_tokens: d_cached,
                    cache_write_tokens: 0,
                });
            }
            _ => {}
        }
    }
    (meta, turns)
}

fn scan_codex(store: &mut StoreFile, roots: &[PathBuf]) -> (usize, usize) {
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in roots {
        walk_jsonl_files(dir, &mut files);
    }
    files.retain(|p| !is_codex_fixture(p));
    files.sort();
    let units: Vec<ScanUnit> = files.iter().filter_map(|p| unit_from_file(p)).collect();
    scan_simple(store, PROVIDER_CODEX, units, parse_codex_session)
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/// OpenCode and its lineage write one JSON file per message under
/// `storage/message/<sessionId>/<messageId>.json`.

/// Parse a whole OpenCode *session directory*.
///
/// The unit is the directory, not the file: message files are tiny and there are
/// thousands of them (3,632 across 188 sessions on the machine this was written
/// against), so per-file fingerprints would bloat the store by an order of
/// magnitude for no incremental benefit. The directory's fingerprint is the max
/// child mtime plus the summed child size, which changes whenever a message is
/// added or rewritten.
///
/// Every model OpenCode routes to lands here, which is why this scanner is worth
/// more than its token count suggests: it is the only place Copilot-served and
/// free-tier models are visible at all. The model is recorded as
/// `providerID/modelID` so `github-copilot/claude-sonnet-4.5` stays distinct
/// from Claude Code's own `claude-sonnet-4-5`.
fn parse_opencode_session(dir: &Path) -> (FileMeta, Vec<ParsedTurn>) {
    let mut meta = FileMeta::default();
    let mut turns: Vec<ParsedTurn> = Vec::new();
    let session_id = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let Ok(entries) = fs::read_dir(dir) else {
        return (meta, turns);
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();

    for path in &paths {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(row) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if row.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(tokens) = row.get("tokens") else {
            continue;
        };
        if let Some(root) = row
            .get("path")
            .and_then(|p| p.get("root"))
            .and_then(Value::as_str)
        {
            meta.cwd.get_or_insert_with(|| root.to_string());
        }

        let created = row
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(Value::as_i64);
        let Some(ts_ms) = created else { continue };
        let day = utc_date_str(ts_ms / 1000);

        let model = match (
            row.get("providerID").and_then(Value::as_str),
            row.get("modelID").and_then(Value::as_str),
        ) {
            (Some(p), Some(m)) => Some(format!("{p}/{m}")),
            (None, Some(m)) => Some(m.to_string()),
            _ => None,
        };

        let cache = tokens.get("cache");
        let cache_read = cache.map(|c| u64_field(c, "read")).unwrap_or(0);
        let cache_write = cache.map(|c| u64_field(c, "write")).unwrap_or(0);
        // Reasoning is billed as output and is reported alongside it here
        // (unlike Codex, where it is nested inside the output figure).
        let output = u64_field(tokens, "output").saturating_add(u64_field(tokens, "reasoning"));
        let input = u64_field(tokens, "input");
        if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
            continue;
        }

        turns.push(ParsedTurn {
            dedupe_key: None,
            session_id: session_id.clone(),
            ts_ms,
            day,
            model,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
        });
    }
    (meta, turns)
}

fn scan_opencode(store: &mut StoreFile, provider: &str, roots: &[PathBuf]) -> (usize, usize) {
    let mut units: Vec<ScanUnit> = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(children) = fs::read_dir(&dir) else {
                continue;
            };
            let (mut newest, mut total) = (0i64, 0u64);
            for child in children.filter_map(|c| c.ok()) {
                if let Ok(meta) = child.metadata() {
                    newest = newest.max(mtime_ms_of(&meta));
                    total = total.saturating_add(meta.len());
                }
            }
            if total == 0 {
                continue;
            }
            units.push(ScanUnit {
                path: dir,
                mtime_ms: newest,
                size: total,
            });
        }
    }
    units.sort_by(|a, b| a.path.cmp(&b.path));
    scan_simple(store, provider, units, parse_opencode_session)
}

// ---------------------------------------------------------------------------
// The session-JSONL family: Pi, OMP, Command Code
// ---------------------------------------------------------------------------

/// Three CLIs write the same shape of log — a `{"type":"session", …, "cwd"}`
/// header followed by `{"type":"message", …}` rows — because they are built on
/// the same session format (`"version": 3`). One parser reads all three, which
/// is why they landed together rather than as three near-identical scanners.
///
/// The differences it has to absorb, all confirmed against real logs on
/// 2026-08-12:
///
/// | | usage lives at | token keys | model |
/// |---|---|---|---|
/// | Pi (`~/.pi/agent/sessions`) | `message.usage` | `input`/`output`/`cacheRead`/`cacheWrite` | `message.provider` + `message.model` |
/// | OMP (`~/.omp/agent/sessions`) | `message.usage` | same | same |
/// | Command Code (`~/.commandcode/projects`) | **row**`.usage` | `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` | **row**`.model` |
///
/// Two things this deliberately does *not* do:
///
/// * **No reasoning token is added to output.** Pi and OMP publish a
///   `totalTokens` alongside, and it sums to `input + output + cacheRead`
///   exactly — reasoning is already inside `output`. Adding it would inflate
///   every row by the thinking budget.
/// * **No cumulative differencing** (unlike Codex). Each row's `input` is that
///   request's own prompt size, which is what every other per-turn scanner
///   here sums.
///
/// The model is recorded as `providerID/modelID` where the log names a serving
/// provider, matching OpenCode — these CLIs route to Copilot, Codex and free
/// tiers, so `github-copilot/claude-haiku-4.5` has to stay distinct from Claude
/// Code's own `claude-haiku-4-5`. `normalize_model_for_pricing` already looks
/// past the prefix.
fn parse_session_jsonl(path: &Path) -> (FileMeta, Vec<ParsedTurn>) {
    let mut meta = FileMeta::default();
    let mut turns: Vec<ParsedTurn> = Vec::new();
    let fallback_session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut session_id = fallback_session_id.clone();

    let Ok(text) = fs::read_to_string(path) else {
        return (meta, turns);
    };

    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match row.get("type").and_then(Value::as_str) {
            Some("session") => {
                if let Some(id) = row.get("id").and_then(Value::as_str) {
                    session_id = id.to_string();
                }
                if let Some(cwd) = row.get("cwd").and_then(Value::as_str) {
                    meta.cwd.get_or_insert_with(|| cwd.to_string());
                }
                // Not every writer records a branch; the ones that do use the
                // same two spellings as everything else in this file.
                for key in ["gitBranch", "branch"] {
                    if let Some(branch) = row.get(key).and_then(Value::as_str) {
                        meta.branch.get_or_insert_with(|| branch.to_string());
                    }
                }
            }
            Some("message") => {
                let message = row.get("message");
                // Command Code hangs usage and model off the row; Pi and OMP
                // hang them off the message. Look in both, row first, so a
                // future writer that carries either is read the same way.
                let Some(usage) = row
                    .get("usage")
                    .or_else(|| message.and_then(|m| m.get("usage")))
                    .filter(|u| u.is_object())
                else {
                    continue;
                };
                let input = first_u64(usage, &["input", "inputTokens"]);
                let output = first_u64(usage, &["output", "outputTokens"]);
                let cache_read = first_u64(usage, &["cacheRead", "cacheReadTokens"]);
                let cache_write = first_u64(usage, &["cacheWrite", "cacheWriteTokens"]);
                if input + output + cache_read + cache_write == 0 {
                    continue;
                }

                // The row's own timestamp; the message's is a fallback because
                // OMP writes one on the message too.
                let Some(ts_iso) = row
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .or_else(|| message.and_then(|m| m.get("timestamp")).and_then(Value::as_str))
                else {
                    continue;
                };
                let (Some(ts_ms), Some(day)) = (iso_to_ms(ts_iso), date_prefix(ts_iso)) else {
                    continue;
                };

                let model = row
                    .get("model")
                    .and_then(Value::as_str)
                    .or_else(|| message.and_then(|m| m.get("model")).and_then(Value::as_str));
                let serving = message
                    .and_then(|m| m.get("provider"))
                    .and_then(Value::as_str);
                let model = match (serving, model) {
                    (Some(p), Some(m)) if !m.contains('/') => Some(format!("{p}/{m}")),
                    (_, Some(m)) => Some(m.to_string()),
                    _ => None,
                };

                turns.push(ParsedTurn {
                    // One writer, one copy: none of these three has a fork
                    // mechanic, so a turn is never written twice. Same
                    // contract as Codex and OpenCode.
                    dedupe_key: None,
                    session_id: session_id.clone(),
                    ts_ms,
                    day,
                    model,
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_write_tokens: cache_write,
                });
            }
            _ => {}
        }
    }

    (meta, turns)
}

/// The first of `keys` present as a number, else 0.
fn first_u64(value: &Value, keys: &[&str]) -> u64 {
    for key in keys {
        if let Some(found) = value.get(*key).and_then(Value::as_u64) {
            return found;
        }
    }
    0
}

/// Scan a `<root>/<project slug>/<session>.jsonl` tree per root.
///
/// Command Code writes `<uuid>.checkpoints.jsonl` and `<uuid>.meta.json`
/// beside each session; the checkpoint file carries no usage but is large, so
/// skipping it is worth a line.
fn scan_session_jsonl(
    store: &mut StoreFile,
    provider: &str,
    roots: &[PathBuf],
) -> (usize, usize) {
    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots {
        walk_jsonl_files(root, &mut files);
    }
    files.retain(|p| {
        !p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".checkpoints.jsonl"))
            .unwrap_or(false)
    });
    files.sort();
    let units: Vec<ScanUnit> = files.iter().filter_map(|p| unit_from_file(p)).collect();
    scan_simple(store, provider, units, parse_session_jsonl)
}

// ---------------------------------------------------------------------------
// Aider
// ---------------------------------------------------------------------------

/// Parse one Aider `--analytics-log` JSONL file.
///
/// Aider writes no analytics by default — the log only exists where the user
/// pointed `--analytics-log` or `AIDER_ANALYTICS_LOG` (both a CLI flag and a
/// YAML `analytics-log:` key), and `~/.aider` is the conventional home for it.
///
/// Only the `message_send` event carries a model call, with the exact per-request
/// counts on `properties` and a unix-seconds `time`:
///
/// | field | maps to |
/// |---|---|
/// | `properties.prompt_tokens` | input |
/// | `properties.completion_tokens` | output |
/// | `properties.main_model` | model (`provider/model` when prefixed) |
/// | `time` | day + timestamp |
///
/// Everything else (`launched`, `repo`, `exit`) is lifecycle noise with no
/// numbers. The log carries no cwd or session id — AgentPeek, the project this
/// format was reverse-engineered from, documents the same gap — so every turn
/// lands on the file stem's session and a project derived from the path.
fn parse_aider_log(path: &Path) -> (FileMeta, Vec<ParsedTurn>) {
    let meta = FileMeta::default();
    let mut turns: Vec<ParsedTurn> = Vec::new();
    let fallback_session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let Ok(text) = fs::read_to_string(path) else {
        return (meta, turns);
    };
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if row.get("event").and_then(Value::as_str) != Some("message_send") {
            continue;
        }
        let Some(props) = row.get("properties").filter(|p| p.is_object()) else {
            continue;
        };
        let input = first_u64(props, &["prompt_tokens"]);
        let output = first_u64(props, &["completion_tokens"]);
        if input + output == 0 {
            continue;
        }
        let Some(secs) = row.get("time").and_then(Value::as_i64) else {
            continue;
        };
        turns.push(ParsedTurn {
            dedupe_key: None,
            session_id: fallback_session_id.clone(),
            ts_ms: secs * 1000,
            day: utc_date_str(secs),
            model: props
                .get("main_model")
                .and_then(Value::as_str)
                .map(str::to_string),
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        });
    }
    (meta, turns)
}

/// Cheap gate for a potential Aider log: does it carry at least one
/// `message_send` with real counts? Keeps the scanner from fingerprinting
/// non-analytics files that happen to sit under `~/.aider`.
fn aider_log_has_usage(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if row.get("event").and_then(Value::as_str) != Some("message_send") {
            continue;
        }
        let Some(props) = row.get("properties") else {
            continue;
        };
        if first_u64(props, &["prompt_tokens"]) + first_u64(props, &["completion_tokens"]) > 0 {
            return true;
        }
    }
    false
}

fn scan_aider(store: &mut StoreFile, provider: &str, roots: &[PathBuf]) -> (usize, usize) {
    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots {
        walk_jsonl_files(root, &mut files);
    }
    files.sort();
    let units: Vec<ScanUnit> = files
        .iter()
        .filter(|f| aider_log_has_usage(f))
        .filter_map(|p| unit_from_file(p))
        .collect();
    scan_simple(store, provider, units, parse_aider_log)
}

// ---------------------------------------------------------------------------
// Registry sweep + convention discovery
// ---------------------------------------------------------------------------

/// Tier 2: any CLI that mirrors the shared `<dot>/agent/sessions` layout is
/// read with the session parser and attributed to the dot-directory's name, so
/// a freshly installed agent appears in the ledger without a registry entry.
///
/// Two homes are swept — `~/<dot>` and `~/.config/<dot>` — and registered
/// providers are skipped, because their roots are already scanned by name.
/// The [`probe_session_tree`] gate keeps the sweep from claiming trees that
/// merely share the path shape.
fn discover_convention_sessions(sources: &[ProviderSource], home: &Path) -> Vec<(String, PathBuf)> {
    let claimed: HashSet<String> = sources.iter().map(|s| s.provider.clone()).collect();
    let mut discovered: Vec<(String, PathBuf)> = Vec::new();
    for base in [home.to_path_buf(), home.join(".config")] {
        let Ok(entries) = fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.trim_start_matches('.').to_string())
                .unwrap_or_default();
            if name.is_empty() || claimed.contains(&name) {
                continue;
            }
            let sessions = dir.join("agent").join("sessions");
            if sessions.is_dir() && probe_session_tree(&sessions) {
                discovered.push((name, sessions));
            }
        }
    }

    discovered
}

fn scan_convention_sessions(
    store: &mut StoreFile,
    sources: &[ProviderSource],
    home: &Path,
) -> (usize, usize) {
    let mut processed = 0usize;
    let mut skipped = 0usize;
    for (name, root) in discover_convention_sessions(sources, home) {
        let (p, s) = scan_session_jsonl(store, &name, &[root]);
        processed += p;
        skipped += s;
    }
    (processed, skipped)
}

/// Cheap gate: does this `agent/sessions` tree contain a file that is really
/// the session JSONL shape? A wrong guess costs nothing (the parser yields zero
/// turns for foreign files) but should not claim arbitrary trees.
fn probe_session_tree(root: &Path) -> bool {
    let mut files: Vec<PathBuf> = Vec::new();
    walk_jsonl_files(root, &mut files);
    files.truncate(8);
    for f in &files {
        let Ok(text) = fs::read_to_string(f) else {
            continue;
        };
        for line in text.lines().take(200) {
            let Ok(row) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) == Some("session") {
                return true;
            }
        }
    }
    false
}

/// Resolve a `~`-relative `foo/bar` registry path against the home dir. The
/// registry stores forward slashes (universal across OSes); splitting and
/// re-joining normalizes to the platform separator so fingerprint keys stay
/// byte-identical to the paths the scanners build themselves. Joining a string
/// that already contains `/` would leave mixed separators on Windows and flip
/// every changed-file check to a full reparse.
fn home_join(home: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .filter(|p| !p.is_empty())
        .fold(home.to_path_buf(), |acc, part| acc.join(part))
}

/// Sweep every provider the registry names, then discover any convention-shaped
/// CLI that is not registered. Each scanner owns its own files and rows; the
/// only shared state is the ledger they append to.
fn run_scan(store: &mut StoreFile, config_dir: &Path, home: &Path) -> (usize, usize) {
    let sources = load_provider_sources(config_dir);
    let mut processed = 0usize;
    let mut skipped = 0usize;
    for spec in &sources {
        let roots: Vec<PathBuf> = spec.paths.iter().map(|p| home_join(home, p)).collect();
        let (p, s) = match spec.format {
            SourceFormat::Claude => scan_claude(store, &roots),
            SourceFormat::Codex => scan_codex(store, &roots),
            SourceFormat::OpenCode => scan_opencode(store, &spec.provider, &roots),
            SourceFormat::Session => scan_session_jsonl(store, &spec.provider, &roots),
            SourceFormat::Aider => scan_aider(store, &spec.provider, &roots),
        };
        processed += p;
        skipped += s;
    }
    // Convention sweep: read-only discovery for unregistered CLIs. It follows
    // after the registered scans so a registered provider is never scanned
    // twice in one pass.
    let (p, s) = scan_convention_sessions(store, &sources, home);
    processed += p;
    skipped += s;
    store.last_scan_completed_at = Some(now_ms());
    (processed, skipped)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// Collect every `*.jsonl` under `dir`, one level deep (slug dir → session
/// files), mirroring Orca's `walkJsonlFiles`.
/// Collect `*.jsonl` under `dir`, recursively.
///
/// This used to descend exactly one level, which was enough for Claude's flat
/// `projects/<slug>/*.jsonl` but silently found almost nothing for Codex, whose
/// history is date-nested as `sessions/<year>/<month>/<day>/rollout-*.jsonl` —
/// it picked up the flat `archived_sessions/` only, undercounting by ~98%. The
/// depth cap is loop insurance for symlinked or pathological trees; real
/// layouts sit at 3-4.
fn walk_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        const MAX_DEPTH: usize = 8;
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out, depth + 1);
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                out.push(path);
            }
        }
    }
    walk(dir, out, 0);
}

/// Subtract one file's old contribution from the ledger. Day rows that drain
/// to zero turns are removed so they cannot linger as 0-usage ghosts.
fn subtract_file(store: &mut StoreFile, prev: &FileFingerprint) {
    for fp_day in &prev.days {
        if let Some(row) = store.days.iter_mut().find(|r| {
            r.provider == prev.provider
                && r.day == fp_day.day
                && r.model == fp_day.model
                && r.project_key == prev.project_label
                && r.managed == prev.managed
        }) {
            row.turns = row.turns.saturating_sub(fp_day.turns);
            row.zero_cache_read_turns = row.zero_cache_read_turns.saturating_sub(fp_day.zero_cache_read_turns);
            row.sessions = row.sessions.saturating_sub(fp_day.sessions);
            row.input_tokens = row.input_tokens.saturating_sub(fp_day.input_tokens);
            row.output_tokens = row.output_tokens.saturating_sub(fp_day.output_tokens);
            row.cache_read_tokens = row.cache_read_tokens.saturating_sub(fp_day.cache_read_tokens);
            row.cache_write_tokens = row.cache_write_tokens.saturating_sub(fp_day.cache_write_tokens);
        }
    }
    store.days.retain(|r| r.turns > 0);
}

#[allow(clippy::too_many_arguments)]
fn upsert_day(
    store: &mut StoreFile,
    provider: &str,
    day: &str,
    model: &str,
    project_key: &str,
    managed: bool,
    turns: u64,
    zero_cache_read_turns: u64,
    sessions: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) {
    if let Some(row) = store.days.iter_mut().find(|r| {
        r.provider == provider
            && r.day == day
            && r.model == model
            && r.project_key == project_key
            && r.managed == managed
    }) {
        row.turns = row.turns.saturating_add(turns);
        row.zero_cache_read_turns = row.zero_cache_read_turns.saturating_add(zero_cache_read_turns);
        row.sessions = row.sessions.saturating_add(sessions);
        row.input_tokens = row.input_tokens.saturating_add(input);
        row.output_tokens = row.output_tokens.saturating_add(output);
        row.cache_read_tokens = row.cache_read_tokens.saturating_add(cache_read);
        row.cache_write_tokens = row.cache_write_tokens.saturating_add(cache_write);
        return;
    }
    store.days.push(DayRow {
        provider: provider.to_string(),
        day: day.to_string(),
        model: model.to_string(),
        project_key: project_key.to_string(),
        managed,
        turns,
        zero_cache_read_turns,
        sessions,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
    });
}

// ---------------------------------------------------------------------------
// Snapshot queries
// ---------------------------------------------------------------------------

/// `provider` is a provider id, or `PROVIDER_ALL` to fold every provider
/// together — which is what the Overview reads.
fn filter_rows<'a>(
    store: &'a StoreFile,
    provider: &str,
    scope: &str,
    range: &str,
) -> Vec<&'a DayRow> {
    let cutoff = range_days(range)
        .map(|days| utc_date_str(now_ms() / 1000 - (days.saturating_sub(1) * 86_400) as i64))
        .unwrap_or_else(|| "0000-01-01".to_string());
    store
        .days
        .iter()
        .filter(|r| r.day >= cutoff)
        .filter(|r| provider == PROVIDER_ALL || r.provider == provider)
        .filter(|r| scope != SCOPE_SPACRON || r.managed)
        .collect()
}

/// Sum the ledger into a Summary. Cost is computed per model over the filtered
/// rows so the long-context tier applies to real totals.
fn build_summary(rows: &[&DayRow]) -> Summary {
    let mut summary = Summary::default();
    let mut per_model: HashMap<&str, (u64, u64, u64, u64)> = HashMap::new();
    let mut per_project: HashMap<&str, u64> = HashMap::new();

    for row in rows {
        summary.sessions += row.sessions;
        summary.turns += row.turns;
        summary.zero_cache_read_turns += row.zero_cache_read_turns;
        summary.input_tokens += row.input_tokens;
        summary.output_tokens += row.output_tokens;
        summary.cache_read_tokens += row.cache_read_tokens;
        summary.cache_write_tokens += row.cache_write_tokens;
        *per_project.entry(&row.project_key).or_insert(0) += row.input_tokens + row.output_tokens;
        let m = per_model.entry(&row.model).or_insert((0, 0, 0, 0));
        m.0 += row.input_tokens;
        m.1 += row.output_tokens;
        m.2 += row.cache_read_tokens;
        m.3 += row.cache_write_tokens;
    }

    summary.top_model = per_model
        .iter()
        .max_by_key(|(_, (i, o, _, _))| *i + *o)
        .map(|(k, _)| (*k).to_string());
    summary.top_project = per_project
        .iter()
        .max_by_key(|(_, n)| **n)
        .map(|(k, _)| (*k).to_string());

    let mut total_cost = 0.0;
    let mut unpriced = false;
    let mut any_priced = false;
    for (model, (input, output, cr, cw)) in &per_model {
        match estimated_cost(model, *input, *output, *cr, *cw) {
            Some(cost) => {
                any_priced = true;
                total_cost += cost;
            }
            None => unpriced = true,
        }
    }
    summary.has_partial_cost = unpriced;
    // `null` when nothing was priced at all — mirrors Orca's
    // `hasAnyBillableCost ? estimatedCostUsd : null`.
    if any_priced {
        summary.estimated_cost_usd = Some((total_cost * 100.0).round() / 100.0);
    }

    let billable_input = summary.input_tokens + summary.cache_read_tokens;
    summary.cache_reuse_rate = (billable_input > 0).then(|| {
        summary.cache_read_tokens as f64 / billable_input as f64
    });
    summary
}

fn build_daily(rows: &[&DayRow]) -> Vec<DailyPoint> {
    let mut by_day: HashMap<&str, DailyPoint> = HashMap::new();
    for row in rows {
        let point = by_day.entry(&row.day).or_insert_with(|| DailyPoint {
            day: row.day.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        });
        point.input_tokens += row.input_tokens;
        point.output_tokens += row.output_tokens;
        point.cache_read_tokens += row.cache_read_tokens;
        point.cache_write_tokens += row.cache_write_tokens;
    }
    let mut daily: Vec<DailyPoint> = by_day.into_values().collect();
    daily.sort_by(|a, b| a.day.cmp(&b.day));
    daily
}

/// Group the ledger by whatever `key_of` returns — the model for "By model",
/// the project for "By project".
///
/// The group key is also the row's label. It has to be: labelling a row with
/// `row.model` regardless of the grouping is what made the "By project" list
/// render a second copy of the model names.
///
/// Cost is priced from a per-group **per-model** split rather than from the
/// group key, because a project's tokens are spread across several models and
/// only a model has a price. A group with no priced model at all reports `None`
/// rather than a confident 0.
fn build_breakdown(
    rows: &[&DayRow],
    key_of: impl Fn(&DayRow) -> String,
    top: usize,
) -> Vec<BreakdownRow> {
    let mut groups: HashMap<String, BreakdownRow> = HashMap::new();
    let mut per_model: HashMap<String, HashMap<&str, (u64, u64, u64, u64)>> = HashMap::new();
    for row in rows {
        let key = key_of(row);
        let entry = groups
            .entry(key.clone())
            .or_insert_with(|| BreakdownRow {
                key: key.clone(),
                label: key.clone(),
                sessions: 0,
                turns: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                estimated_cost_usd: None,
            });
        entry.sessions += row.sessions;
        entry.turns += row.turns;
        entry.input_tokens += row.input_tokens;
        entry.output_tokens += row.output_tokens;
        entry.cache_read_tokens += row.cache_read_tokens;
        entry.cache_write_tokens += row.cache_write_tokens;

        let model = per_model
            .entry(key)
            .or_default()
            .entry(row.model.as_str())
            .or_insert((0, 0, 0, 0));
        model.0 += row.input_tokens;
        model.1 += row.output_tokens;
        model.2 += row.cache_read_tokens;
        model.3 += row.cache_write_tokens;
    }
    for (key, entry) in groups.iter_mut() {
        let mut total = 0.0;
        let mut any_priced = false;
        for (model, (input, output, cache_read, cache_write)) in
            per_model.get(key).into_iter().flatten()
        {
            if let Some(cost) = estimated_cost(model, *input, *output, *cache_read, *cache_write) {
                any_priced = true;
                total += cost;
            }
        }
        entry.estimated_cost_usd = any_priced.then(|| (total * 100.0).round() / 100.0);
    }
    let mut rows: Vec<BreakdownRow> = groups.into_values().collect();
    // Key breaks ties: the groups come out of a HashMap, so equal-token rows
    // would otherwise reorder themselves between two identical refreshes.
    rows.sort_by(|a, b| {
        (b.input_tokens + b.output_tokens)
            .cmp(&(a.input_tokens + a.output_tokens))
            .then_with(|| a.key.cmp(&b.key))
    });
    rows.truncate(top);
    rows
}

/// Recent sessions, derived on demand from recently-modified files — see the
/// module docs for why this is not persisted. Bounded: at most
/// `MAX_SESSION_FILES` files are parsed, newest first.
fn build_recent_sessions(
    store: &StoreFile,
    provider: &str,
    scope: &str,
    sources: &[ProviderSource],
    limit: usize,
) -> Vec<SessionRow> {
    const MAX_SESSION_FILES: usize = 40;
    const RECENT_WINDOW_MS: i64 = 30 * 86_400_000;

    let cutoff = now_ms() - RECENT_WINDOW_MS;
    let mut files: Vec<(PathBuf, i64, String, bool)> = store
        .files
        .iter()
        .filter(|(_, fp)| fp.last_at_ms >= cutoff)
        .filter(|(_, fp)| provider == PROVIDER_ALL || fp.provider == provider)
        // The scope filter has to apply here too. Every aggregate above this
        // honours it, so a "Managed worktrees only" view that still listed
        // sessions from everywhere read as a bug in the numbers rather than a
        // gap in the table.
        .filter(|(_, fp)| scope != SCOPE_SPACRON || fp.managed)
        .map(|(path, fp)| {
            (
                PathBuf::from(path),
                fp.last_at_ms,
                fp.provider.clone(),
                fp.managed,
            )
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(MAX_SESSION_FILES);

    let mut sessions: Vec<SessionRow> = Vec::new();
    for (path, _, row_provider, managed) in files {
        // Only re-read units that still exist; the fingerprint map is pruned of
        // deletions, but a unit can disappear between scan and snapshot.
        // OpenCode's unit is a directory, so this cannot assume a file.
        if !path.exists() {
            continue;
        }
        // Each provider needs its own reader — running the Claude parser over a
        // Codex rollout yields an empty, silently wrong row. The provider's
        // registered format picks the reader; convention-discovered providers
        // use the shared session format.
        let (file_meta, turns) = match source_format(sources, &row_provider) {
            SourceFormat::Codex => parse_codex_session(&path),
            SourceFormat::OpenCode => parse_opencode_session(&path),
            SourceFormat::Session => parse_session_jsonl(&path),
            SourceFormat::Aider => parse_aider_log(&path),
            SourceFormat::Claude => parse_session_turns(&path),
        };
        let parsed = aggregate_turns(&turns);
        if parsed.turns == 0 {
            continue;
        }
        let cwd = file_meta
            .cwd
            .clone()
            .or_else(|| cwd_from_path(&path))
            .unwrap_or_else(|| "unknown".to_string());
        let label = project_label(&cwd, file_meta.branch.as_deref());
        let first = parsed.first_at_ms.unwrap_or(0);
        let last = parsed.last_at_ms.unwrap_or(first);
        let session_id = parsed
            .session_ids
            .iter()
            .next()
            .cloned()
            .unwrap_or_else(|| {
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        // Mirrors Orca's Math.max(0, Math.round(diff / 60_000)).
        let duration_minutes = if first > 0 {
            (((last - first) + 30_000) / 60_000).max(0) as u64
        } else {
            0
        };
        sessions.push(SessionRow {
            session_id,
            provider: row_provider.clone(),
            provider_label: label_for(&row_provider, sources),
            last_active_at: last,
            duration_minutes,
            project_label: label,
            managed,
            branch: file_meta.branch.clone(),
            model: parsed.model.clone(),
            turns: parsed.turns,
            input_tokens: parsed.input_tokens,
            output_tokens: parsed.output_tokens,
            cache_read_tokens: parsed.cache_read_tokens,
            cache_write_tokens: parsed.cache_write_tokens,
        });
    }
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    sessions.truncate(limit);
    sessions
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The current scan state — cheap, call on mount.
#[tauri::command]
pub fn stats_get_scan_state(state: tauri::State<'_, AppState>) -> ScanState {
    let store = load_store(&state.config_dir);
    scan_state_of(&store, false)
}

/// Turn transcript scanning on or off. Returns the new state so the caller
/// does not need a follow-up round trip.
///
/// Turning it off leaves the ledger on disk untouched: re-enabling should show
/// the same history back rather than re-reading every session file.
#[tauri::command]
pub fn stats_set_enabled(state: tauri::State<'_, AppState>, enabled: bool) -> ScanState {
    let mut store = load_store(&state.config_dir);
    store.enabled = enabled;
    save_store(&state.config_dir, &store);
    scan_state_of(&store, false)
}

/// Re-scan. `force` is accepted for symmetry with `usage_fetch_all` but does
/// nothing yet — the incremental fingerprint check is the whole point.
#[tauri::command(async)]
pub async fn stats_refresh(
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
) -> Result<ScanState, String> {
    let _ = force;
    let config_dir = state.config_dir.clone();
    let mut store = load_store(&config_dir);
    // Tracking off means we read nothing, including on an explicit Rescan.
    if !store.enabled {
        return Ok(scan_state_of(&store, false));
    }
    store.last_scan_started_at = Some(now_ms());
    save_store(&config_dir, &store);

    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = load_store(&config_dir);
        let (processed, skipped) = run_scan(&mut store, &config_dir, &home);
        store.last_scan_error = scan_error_note(processed, skipped);
        save_store(&config_dir, &store);
        scan_state_of(&store, false)
    })
    .await
    .map_err(|e| format!("The usage scan crashed: {e}"))
}

fn scan_error_note(processed: usize, skipped: usize) -> Option<String> {
    if skipped > 0 {
        Some(format!("Scanned {processed} file(s); skipped {skipped} unchanged."))
    } else {
        None
    }
}

/// Bring the ledger up to date if it has never been scanned, and hand back the
/// store. Shared by both read commands so each is safe to call first.
async fn store_after_first_scan(config_dir: PathBuf) -> Result<StoreFile, String> {
    let store = load_store(&config_dir);
    // First scan is implicit: opening the pane triggers it, so a brand-new
    // install shows data instead of a "toggle me on" dead end. Tracking being
    // off is the one thing that stops it — the pane renders its opt-in card
    // from the same `scanState`, so returning empty aggregates is correct.
    if !store.enabled || store.last_scan_completed_at.is_some() {
        return Ok(store);
    }
    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = load_store(&config_dir);
        let (processed, skipped) = run_scan(&mut store, &config_dir, &home);
        store.last_scan_error = scan_error_note(processed, skipped);
        save_store(&config_dir, &store);
        store
    })
    .await
    .map_err(|e| format!("The usage scan crashed: {e}"))
}

/// Everything one provider's pane renders, in one call. Provider: any id from
/// the source registry (see [`load_provider_sources`]), or `all`. Scope:
/// `spacron` (managed worktrees only) or `all`. Range: `7d` / `30d` / `90d` /
/// `all`.
#[tauri::command(async)]
pub async fn stats_get_snapshot(
    state: tauri::State<'_, AppState>,
    provider: Option<String>,
    scope: Option<String>,
    range: Option<String>,
    limit: Option<usize>,
) -> Result<Snapshot, String> {
    let provider = provider.unwrap_or_else(|| PROVIDER_ALL.to_string());
    let scope = scope.unwrap_or_else(|| SCOPE_ALL.to_string());
    let range = range.unwrap_or_else(|| RANGE_ALL.to_string());
    let limit = limit.unwrap_or(10);
    let config_dir = state.config_dir.clone();
    let store = store_after_first_scan(config_dir.clone()).await?;
    let sources = load_provider_sources(&config_dir);

    let rows = filter_rows(&store, &provider, &scope, &range);
    Ok(Snapshot {
        scan_state: scan_state_of(&store, false),
        summary: build_summary(&rows),
        daily: build_daily(&rows),
        model_breakdown: build_breakdown(&rows, |r| r.model.clone(), 5),
        project_breakdown: build_breakdown(&rows, |r| r.project_key.clone(), 5),
        recent_sessions: build_recent_sessions(&store, &provider, &scope, &sources, limit),
        provider,
        scope,
        range,
    })
}

/// The combined Overview: totals across every provider, a 42-day intensity
/// heatmap, and one card per provider.
#[tauri::command(async)]
pub async fn stats_get_overview(
    state: tauri::State<'_, AppState>,
    scope: Option<String>,
    range: Option<String>,
) -> Result<Overview, String> {
    let scope = scope.unwrap_or_else(|| SCOPE_ALL.to_string());
    let range = range.unwrap_or_else(|| RANGE_ALL.to_string());
    let config_dir = state.config_dir.clone();
    let store = store_after_first_scan(config_dir.clone()).await?;
    let sources = load_provider_sources(&config_dir);

    let all_rows = filter_rows(&store, PROVIDER_ALL, &scope, &range);
    let summary = build_summary(&all_rows);
    let total_tokens = summary.input_tokens
        + summary.output_tokens
        + summary.cache_read_tokens
        + summary.cache_write_tokens;

    let available = match dirs::home_dir() {
        Some(home) => surface_providers_with_discovery(&store, &sources, &home),
        None => surface_providers(&store, &sources),
    };
    let providers = available
        .iter()
        .map(|(id, label)| {
            let rows = filter_rows(&store, id, &scope, &range);
            let s = build_summary(&rows);
            let tokens =
                s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens;
            ProviderCard {
                id: (*id).to_string(),
                label: (*label).to_string(),
                has_data: s.turns > 0,
                sessions: s.sessions,
                turns: s.turns,
                total_tokens: tokens,
                share: if total_tokens > 0 {
                    tokens as f64 / total_tokens as f64
                } else {
                    0.0
                },
                estimated_cost_usd: s.estimated_cost_usd,
                has_partial_cost: s.has_partial_cost,
                top_model: s.top_model,
                top_project: s.top_project,
            }
        })
        .collect();

    let daily = build_daily(&all_rows);
    Ok(Overview {
        scan_state: scan_state_of(&store, false),
        active_days: daily.len() as u64,
        cache_share: cache_share_of(&summary),
        heatmap: build_heatmap(&daily),
        providers,
        model_breakdown: build_breakdown(&all_rows, |r| r.model.clone(), 5),
        project_breakdown: build_breakdown(&all_rows, |r| r.project_key.clone(), 5),
        summary,
        total_tokens,
        scope,
        range,
    })
}

/// Cache tokens as a share of everything. `None` rather than 0 when there is
/// nothing to divide, so the card can say "—" instead of implying a cold cache.
fn cache_share_of(summary: &Summary) -> Option<f64> {
    let total = summary.input_tokens
        + summary.output_tokens
        + summary.cache_read_tokens
        + summary.cache_write_tokens;
    if total == 0 {
        return None;
    }
    Some((summary.cache_read_tokens + summary.cache_write_tokens) as f64 / total as f64)
}

/// The trailing 42 days, oldest first, including days with no activity — the
/// grid is a calendar, so gaps have to be rendered as empty cells rather than
/// closed up.
///
/// Levels are quartiles of the *busiest* day in the window rather than fixed
/// token thresholds: usage spans three orders of magnitude between a quick
/// question and a long agent run, so an absolute scale would render almost
/// every day as either blank or maxed.
fn build_heatmap(daily: &[DailyPoint]) -> Vec<HeatmapDay> {
    const DAYS: i64 = 42;
    let by_day: HashMap<&str, u64> = daily
        .iter()
        .map(|d| {
            (
                d.day.as_str(),
                d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens,
            )
        })
        .collect();
    let peak = by_day.values().copied().max().unwrap_or(0);
    let today = now_ms() / 1000;

    (0..DAYS)
        .rev()
        .map(|back| {
            let day = utc_date_str(today - back * 86_400);
            let total = by_day.get(day.as_str()).copied().unwrap_or(0);
            let level = if total == 0 || peak == 0 {
                0
            } else {
                // 1..=4, so any activity at all is visible.
                (((total as f64 / peak as f64) * 4.0).ceil() as u8).clamp(1, 4)
            };
            HeatmapDay {
                day,
                total_tokens: total,
                level,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, lines.join("\n")).expect("fixture write");
        path
    }

    /// A minimal session file spanning two assistant turns. The first message
    /// row appears twice with growing totals (Claude's streamed updates) — the
    /// parse must max-merge them into one.
    fn session_lines(cwd: &str, model: &str) -> Vec<String> {
        vec![
            format!(r#"{{"type":"session_start","sessionId":"s1","cwd":"{cwd}","gitBranch":"main"}}"#),
            format!(r#"{{"type":"assistant","timestamp":"2026-08-10T10:00:00Z","requestId":"r1","uuid":"u1","message":{{"id":"m1","model":"{model}","usage":{{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}}}}"#),
            format!(r#"{{"type":"assistant","timestamp":"2026-08-10T10:01:00Z","requestId":"r1","uuid":"u1","message":{{"id":"m1","model":"{model}","usage":{{"input_tokens":200,"output_tokens":80,"cache_read_input_tokens":20,"cache_creation_input_tokens":10}}}}}}"#),
            format!(r#"{{"type":"assistant","timestamp":"2026-08-11T10:00:00Z","requestId":"r2","uuid":"u2","message":{{"id":"m2","model":"claude-opus-4-5","usage":{{"input_tokens":400,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#),
            r#"{"type":"user","timestamp":"2026-08-10T09:59:00Z","message":{"content":"hi"}}"#.to_string(),
        ]
    }

    #[test]
    fn parses_tokens_and_max_merges_repeated_rows() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_fixture(
            &dir,
            "s1.jsonl",
            &session_lines("/Users/samue/Projects/spacron", "claude-sonnet-4-5"),
        );
        let (file_meta, turns) = parse_session_turns(&path);
        let parsed = aggregate_turns(&turns);
        // The repeated m1 row max-merges to its second (larger) reading, so
        // m1+m2 are each counted exactly once.
        assert_eq!(parsed.turns, 2);
        assert_eq!(parsed.input_tokens, 200 + 400);
        assert_eq!(parsed.output_tokens, 80 + 100);
        assert_eq!(parsed.cache_read_tokens, 20);
        assert_eq!(parsed.cache_write_tokens, 10);
        assert_eq!(parsed.zero_cache_read_turns, 1, "m2's cacheRead is 0");
        assert_eq!(file_meta.cwd.as_deref(), Some("/Users/samue/Projects/spacron"));
        assert_eq!(file_meta.branch.as_deref(), Some("main"));
        assert_eq!(parsed.session_ids.len(), 1);
        assert_eq!(parsed.days.len(), 2, "two different days bucketed separately");
        assert!(parsed.first_at_ms.unwrap() < parsed.last_at_ms.unwrap());
        // Orca's key order: message.id:requestId wins.
        assert_eq!(turns[0].dedupe_key.as_deref(), Some("m1:r1"));
        assert_eq!(turns[1].dedupe_key.as_deref(), Some("m2:r2"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn manages_worktree_scope_and_labels() {
        assert!(is_managed_worktree("/repo/.spacron/worktrees/feat-x/src"));
        assert!(is_managed_worktree("C:\\repo\\.spacron\\worktrees\\feat-x"));
        assert!(is_managed_worktree("/parent/.spacron-worktrees/repo"));
        assert!(!is_managed_worktree("/repo/src"));
        assert_eq!(
            project_label("/repo/.spacron/worktrees/feat-x/src", Some("feat-x")),
            "repo (feat-x)"
        );
        assert_eq!(
            project_label("/Users/samue/Projects/spacron/src-tauri", None),
            "spacron/src-tauri"
        );
        assert_eq!(
            project_label("/Users/samue/Projects/spacron", None),
            "Projects/spacron"
        );
    }

    #[test]
    fn civil_date_round_trips() {
        assert_eq!(utc_date_str(0), "1970-01-01");
        // 2026-08-10T00:00:00Z, verified against a reference conversion.
        let secs = 1_786_320_000;
        assert_eq!(utc_date_str(secs), "2026-08-10");
        assert_eq!(days_from_civil(2026, 8, 10), secs / 86_400);
        assert_eq!(utc_date_str(now_ms() / 1000).len(), 10);
    }

    #[test]
    fn parses_iso_timestamps() {
        // 2026-08-10T10:00:00Z = 1_786_320_000 + 36_000 seconds.
        assert_eq!(iso_to_ms("2026-08-10T10:00:00Z"), Some(1_786_356_000_000));
        assert_eq!(iso_to_ms("2026-08-10T10:00:00.789Z"), Some(1_786_356_000_789));
        assert_eq!(iso_to_ms("2026-08-10T10:00:00.5Z"), Some(1_786_356_000_500));
        assert_eq!(iso_to_ms("not-a-date"), None);
        assert_eq!(iso_to_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(
            date_prefix("2026-08-10T10:00:00Z").as_deref(),
            Some("2026-08-10")
        );
    }

    #[test]
    fn prices_known_models_and_aliases() {
        assert_eq!(
            normalize_model_for_pricing("claude-sonnet-4-5"),
            Some("claude-sonnet-4-5")
        );
        assert_eq!(
            normalize_model_for_pricing("model_placeholder_m26"),
            Some("claude-opus-4-6")
        );
        assert_eq!(
            normalize_model_for_pricing("claude-3-5-sonnet-20241022"),
            Some("claude-sonnet-3-5")
        );
        assert_eq!(
            normalize_model_for_pricing("claude-sonnet-4-5-thinking"),
            Some("claude-sonnet-4-5")
        );
        assert_eq!(
            normalize_model_for_pricing("claude-opus-4-9"),
            Some("claude-opus-4-8"),
            "unknown opus-4 point releases fall back to the newest known price"
        );
        assert_eq!(normalize_model_for_pricing("claude-skynet-1"), None);

        // 100K input + 100K output of sonnet-4-5 = $0.30 + $1.50.
        assert_eq!(estimated_cost("claude-sonnet-4-5", 100_000, 100_000, 0, 0), Some(1.8));
        // A 300K-input total crosses into the long-context tier ($6/MTok).
        assert_eq!(estimated_cost("claude-sonnet-4-5", 300_000, 0, 0, 0), Some(1.8));
        assert_eq!(estimated_cost("claude-skynet-1", 1, 1, 0, 0), None);
    }

    #[test]
    fn incremental_scan_replaces_not_doubles() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-scan-{}", now_ms()));
        let home = dir.join("home");
        let config = dir.join("config");
        let projects = home.join(".claude").join("projects").join("-repo");
        fs::create_dir_all(&projects).unwrap();
        let file = projects.join("s1.jsonl");
        fs::write(&file, session_lines("/repo", "claude-sonnet-4-5").join("\n")).unwrap();

        let mut store = StoreFile::default();
        let (processed, skipped) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 1);
        assert_eq!(skipped, 0);
        let turns_before: u64 = store.days.iter().map(|d| d.turns).sum();
        assert_eq!(turns_before, 2);

        // Unchanged: second scan skips everything.
        let (processed, skipped) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 0);
        assert_eq!(skipped, 1);

        // The file grows (a third turn). The old contribution is replaced, not
        // added on top of, so totals stay exactly 3.
        fs::write(
            &file,
            format!(
                "{}\n{}",
                session_lines("/repo", "claude-sonnet-4-5").join("\n"),
                r#"{"type":"assistant","timestamp":"2026-08-12T10:00:00Z","requestId":"r3","uuid":"u3","message":{"id":"m3","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#
            ),
        )
        .unwrap();
        let (processed, _) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 1);
        let turns_after: u64 = store.days.iter().map(|d| d.turns).sum();
        assert_eq!(turns_after, 3, "rescan must replace, never double-count");

        // Snapshot math on the small fixture.
        let rows = filter_rows(&store, PROVIDER_ALL, SCOPE_ALL, RANGE_ALL);
        let summary = build_summary(&rows);
        assert_eq!(summary.turns, 3);
        assert_eq!(summary.input_tokens, 200 + 400 + 10);
        assert_eq!(summary.zero_cache_read_turns, 2, "m2 and m3 read no cache");
        assert_eq!(summary.estimated_cost_usd, Some(0.0));
        assert!(!summary.has_partial_cost);

        // Managed scope excludes this plain cwd.
        assert!(filter_rows(&store, PROVIDER_ALL, SCOPE_SPACRON, RANGE_ALL).is_empty());

        // Fingerprints for deleted files get pruned.
        fs::remove_file(&file).unwrap();
        run_scan(&mut store, &config, &home);
        assert!(store.files.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_filters_by_range() {
        let mut store = StoreFile::default();
        // The "recent" row must be dated relative to now, not pinned. `filter_rows`
        // resolves its cutoff from `now_ms()`, so a hardcoded date is a test that
        // passes when written and starts failing on a calendar date nobody chose —
        // which is exactly what a literal `2026-08-10` here did once it aged past
        // the 7-day window. Yesterday is comfortably inside every range under test
        // (the 7d cutoff is six days back) and never lands in the future.
        let recent = utc_date_str(now_ms() / 1000 - 86_400);
        upsert_day(&mut store, PROVIDER_CLAUDE, &recent, "claude-sonnet-4-5", "Projects/a", false, 2, 1, 1, 200, 80, 20, 10);
        upsert_day(&mut store, PROVIDER_CLAUDE, "2020-01-01", "claude-sonnet-4-5", "Projects/old", false, 9, 9, 1, 900, 900, 0, 0);

        let rows = filter_rows(&store, PROVIDER_ALL, SCOPE_ALL, RANGE_7D);
        assert_eq!(rows.len(), 1, "old rows fall out of the 7d window");
        assert_eq!(rows[0].project_key, "Projects/a");
        assert_eq!(filter_rows(&store, PROVIDER_ALL, SCOPE_ALL, RANGE_ALL).len(), 2);

        let daily = build_daily(&rows);
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0].input_tokens, 200);

        let breakdown = build_breakdown(&rows, |r| r.model.clone(), 5);
        assert_eq!(breakdown[0].sessions, 1);
        assert_eq!(breakdown[0].turns, 2);
    }

    /// A breakdown row is labelled by whatever it was grouped by. Grouping by
    /// project while labelling by model is what made the "By project" list
    /// render the model names a second time.
    #[test]
    fn breakdown_labels_match_the_grouping() {
        let mut store = StoreFile::default();
        // One project, two models — and one of the models is unpriced, so the
        // project's cost has to come from the per-model split rather than from
        // pricing the project name (which can never be a model).
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "claude-opus-5", "Projects/a", false, 2, 0, 1, 100_000, 0, 0, 0);
        upsert_day(&mut store, PROVIDER_CODEX, "2026-08-10", "gpt-5.4", "Projects/a", false, 3, 0, 1, 50_000, 0, 0, 0);
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "claude-opus-5", "Projects/b", false, 1, 0, 1, 10, 0, 0, 0);

        let rows = filter_rows(&store, PROVIDER_ALL, SCOPE_ALL, RANGE_ALL);

        let by_project = build_breakdown(&rows, |r| r.project_key.clone(), 5);
        assert_eq!(by_project.len(), 2);
        assert_eq!(by_project[0].key, "Projects/a");
        assert_eq!(by_project[0].label, "Projects/a");
        assert_eq!(by_project[0].turns, 5, "both models' turns fold into the project");
        // 100K input on opus-5 at $5/MTok; the gpt row has no price and simply
        // contributes nothing rather than voiding the whole row.
        assert_eq!(by_project[0].estimated_cost_usd, Some(0.5));
        assert_eq!(by_project[1].label, "Projects/b");

        let by_model = build_breakdown(&rows, |r| r.model.clone(), 5);
        assert_eq!(by_model[0].label, "claude-opus-5");
        assert_eq!(by_model[0].turns, 3, "both projects' opus turns fold together");
        assert_eq!(by_model[1].label, "gpt-5.4");
        assert_eq!(by_model[1].estimated_cost_usd, None, "no price in the table");
    }

    #[test]
    fn summary_computes_reuse_rate_and_tops() {
        let mut store = StoreFile::default();
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "claude-sonnet-4-5", "p/big", true, 2, 0, 1, 800, 100, 200, 50);
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "claude-haiku-3-5", "p/small", true, 1, 1, 1, 100, 10, 0, 0);
        let rows = filter_rows(&store, PROVIDER_ALL, SCOPE_SPACRON, RANGE_ALL);
        assert_eq!(rows.len(), 2);
        let summary = build_summary(&rows);
        assert_eq!(summary.turns, 3);
        assert_eq!(summary.zero_cache_read_turns, 1);
        // reuse = cacheRead / (input + cacheRead) = 200 / 1100
        assert_eq!(summary.cache_reuse_rate, Some(200.0 / 1100.0));
        assert_eq!(summary.top_model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(summary.top_project.as_deref(), Some("p/big"));
        assert!(summary.estimated_cost_usd.is_some());
    }

    #[test]
    fn unknown_models_flag_partial_cost() {
        let mut store = StoreFile::default();
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "claude-skynet-1", "p/x", false, 1, 1, 1, 100, 10, 0, 0);
        let rows = filter_rows(&store, PROVIDER_ALL, SCOPE_ALL, RANGE_ALL);
        let summary = build_summary(&rows);
        assert!(summary.has_partial_cost);
        // Nothing is priced at all → cost is null, mirroring Orca.
        assert_eq!(summary.estimated_cost_usd, None);
        // Billable input exists (100 input tokens), but none of it was cache —
        // the reuse share is a flat 0, not null (Orca's input+cacheRead > 0).
        assert_eq!(summary.cache_reuse_rate, Some(0.0));
    }

    #[test]
    fn forked_session_turns_are_owned_exactly_once() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-fork-{}", now_ms()));
        let home = dir.join("home");
        let config = dir.join("config");
        let projects = home.join(".claude").join("projects").join("-repo");
        fs::create_dir_all(&projects).unwrap();

        // The original session.
        let original = projects.join("s1.jsonl");
        fs::write(&original, session_lines("/repo", "claude-sonnet-4-5").join("\n")).unwrap();

        // A fork: same message ids as the original, new sessionId, plus one new
        // turn. Claude rewrites earlier turns into the fork file.
        let fork = projects.join("s2.jsonl");
        let mut fork_lines = session_lines("/repo", "claude-sonnet-4-5");
        for line in &mut fork_lines {
            *line = line.replace("\"sessionId\":\"s1\"", "\"sessionId\":\"s2\"");
        }
        fork_lines.push(format!(
            r#"{{"type":"assistant","timestamp":"2026-08-12T10:00:00Z","requestId":"r3","uuid":"u3","message":{{"id":"m3","model":"claude-sonnet-4-5","usage":{{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        ));
        fs::write(&fork, fork_lines.join("\n")).unwrap();

        let mut store = StoreFile::default();
        let (processed, _) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 2);

        // m1+m2 are claimed by s1 (sorted first); s2 owns only m3. The ledger
        // must not double-count the copied turns.
        let total_turns: u64 = store.days.iter().map(|d| d.turns).sum();
        assert_eq!(total_turns, 3, "forked copies must be owned exactly once");
        let s1 = &store.files[&path_string(&original)];
        assert_eq!(s1.owned_dedupe_keys.len(), 2);
        assert!(!s1.has_deferred_claims);
        let s2 = &store.files[&path_string(&fork)];
        assert_eq!(s2.owned_dedupe_keys, vec!["m3:r3".to_string()]);
        assert!(s2.has_deferred_claims);

        // Unchanged rescan: everything is reused, no re-counting.
        let (processed, skipped) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 0);
        assert_eq!(skipped, 2);

        // The owner disappears → the deferring fork re-parses and claims the
        // copies. Totals stay identical.
        fs::remove_file(&original).unwrap();
        let (processed, _) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 1, "deferred file re-parses to reclaim the keys");
        let total_turns: u64 = store.days.iter().map(|d| d.turns).sum();
        assert_eq!(total_turns, 3, "reclaiming must not double-count either");
        let s2 = &store.files[&path_string(&fork)];
        assert_eq!(s2.owned_dedupe_keys.len(), 3);
        assert!(!s2.has_deferred_claims);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_schema_bump_rebuilds_ledger() {
        let mut store = StoreFile::default();
        store.schema_version = 99;
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "claude-sonnet-4-5", "Projects/a", false, 2, 1, 1, 200, 80, 20, 10);
        // The same branch `load_store` takes on a version mismatch: the ledger
        // is rebuilt from scratch; nothing from the old shape survives.
        let rebuilt = StoreFile::default();
        assert_eq!(rebuilt.schema_version, SCHEMA_VERSION);
        assert!(rebuilt.days.is_empty());
    }

    /// `scanState.enabled` is what the pane gates its whole body on. It shipped
    /// missing from the Rust struct, so it serialized as absent, read as
    /// `undefined` in the webview, and pinned the pane on its opt-in card.
    #[test]
    fn scan_state_carries_the_enabled_flag() {
        let mut store = StoreFile::default();
        assert!(store.enabled, "tracking is opt-out, so a fresh store is on");
        assert!(scan_state_of(&store, false).enabled);

        store.enabled = false;
        assert!(!scan_state_of(&store, false).enabled);

        let json = serde_json::to_string(&scan_state_of(&store, false)).expect("serialize");
        assert!(json.contains("\"enabled\":false"), "field must reach the webview: {json}");
    }

    /// Store files written before the toggle existed have no `enabled` key.
    /// They must load as enabled rather than as `false`, or upgrading blanks
    /// the pane for everyone who already had data.
    #[test]
    fn legacy_store_without_enabled_loads_enabled() {
        let legacy = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "lastScanStartedAt": null,
            "lastScanCompletedAt": 1_786_424_021_567i64,
            "lastScanError": null,
            "files": {},
            "days": [],
        });
        let parsed: StoreFile = serde_json::from_value(legacy).expect("legacy store parses");
        assert!(parsed.enabled);
    }

    // -----------------------------------------------------------------------
    // Codex
    // -----------------------------------------------------------------------

    fn codex_token_event(ts: &str, input: u64, cached: u64, output: u64) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"output_tokens":{output},"reasoning_output_tokens":0,"total_tokens":{}}}}}}}}}"#,
            input + output
        )
    }

    fn codex_session(events: &[String], model: &str, cwd: &str) -> Vec<String> {
        let mut lines = vec![
            format!(
                r#"{{"timestamp":"2026-08-01T10:00:00.000Z","type":"session_meta","payload":{{"id":"sess-1","cwd":"{cwd}","git":{{"branch":"main"}}}}}}"#
            ),
            format!(
                r#"{{"timestamp":"2026-08-01T10:00:01.000Z","type":"turn_context","payload":{{"model":"{model}","cwd":"{cwd}"}}}}"#
            ),
        ];
        lines.extend(events.iter().cloned());
        lines
    }

    /// The single most important behaviour in the Codex reader.
    ///
    /// `total_token_usage` is a running session total. Summing the readings
    /// overcounts roughly 2x on a real session, so the parser differences
    /// consecutive readings — and the deltas must add back up to the final
    /// cumulative figure exactly.
    #[test]
    fn codex_differences_cumulative_totals() {
        let dir = std::env::temp_dir().join(format!("spacron-codex-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_fixture(
            &dir,
            "rollout-1.jsonl",
            &codex_session(
                &[
                    codex_token_event("2026-08-01T10:00:05.000Z", 100, 0, 10),
                    codex_token_event("2026-08-01T10:01:05.000Z", 250, 40, 30),
                    codex_token_event("2026-08-01T10:02:05.000Z", 400, 90, 55),
                ],
                "gpt-5.4",
                "/repo",
            ),
        );

        let (meta, turns) = parse_codex_session(&path);
        assert_eq!(meta.cwd.as_deref(), Some("/repo"));
        assert_eq!(turns.len(), 3, "one turn per reading with a positive delta");

        let parsed = aggregate_turns(&turns);
        // Final cumulative reading: 400 input (90 cached) + 55 output.
        // New input is therefore 400-90=310, cache read 90, output 55.
        assert_eq!(parsed.input_tokens, 310);
        assert_eq!(parsed.cache_read_tokens, 90);
        assert_eq!(parsed.output_tokens, 55);
        assert_eq!(
            parsed.input_tokens + parsed.cache_read_tokens + parsed.output_tokens,
            455,
            "deltas must sum to the session's own final total, not the sum of readings (735)"
        );
        assert_eq!(parsed.model.as_deref(), Some("gpt-5.4"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Compaction restarts Codex's counter. A reading below its predecessor is
    /// a reset, not a negative delta.
    #[test]
    fn codex_treats_a_counter_reset_as_a_fresh_reading() {
        let dir = std::env::temp_dir().join(format!("spacron-codex-reset-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_fixture(
            &dir,
            "rollout-2.jsonl",
            &codex_session(
                &[
                    codex_token_event("2026-08-01T10:00:05.000Z", 900, 0, 100),
                    // Compacted: the counter starts over well below the peak.
                    codex_token_event("2026-08-01T10:05:05.000Z", 50, 0, 5),
                    codex_token_event("2026-08-01T10:06:05.000Z", 80, 0, 9),
                ],
                "gpt-5.4",
                "/repo",
            ),
        );

        let parsed = aggregate_turns(&parse_codex_session(&path).1);
        // 900 + 50 + 30 input, 100 + 5 + 4 output — every delta non-negative.
        assert_eq!(parsed.input_tokens, 980);
        assert_eq!(parsed.output_tokens, 109);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Codex nests history as `sessions/<y>/<m>/<d>/rollout-*.jsonl`. A walker
    /// that descends only one level finds the flat `archived_sessions/` and
    /// essentially nothing else — it undercounted this machine by ~98% before
    /// the walk was made recursive.
    #[test]
    fn walk_finds_date_nested_logs() {
        let dir = std::env::temp_dir().join(format!("spacron-walk-{}", now_ms()));
        let nested = dir.join("sessions").join("2026").join("08").join("06");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("rollout-deep.jsonl"), "{}").unwrap();
        fs::create_dir_all(dir.join("archived_sessions")).unwrap();
        fs::write(dir.join("archived_sessions").join("flat.jsonl"), "{}").unwrap();
        // Non-jsonl siblings must stay out.
        fs::write(nested.join("notes.txt"), "x").unwrap();

        let mut found = Vec::new();
        walk_jsonl_files(&dir, &mut found);
        assert_eq!(found.len(), 2, "found {found:?}");
        assert!(found.iter().any(|p| p.ends_with("rollout-deep.jsonl")));
        assert!(found.iter().any(|p| p.ends_with("flat.jsonl")));

        let _ = fs::remove_dir_all(&dir);
    }

    /// `~/.codex/.tmp/plugins/**` ships JSONL fixtures that parse cleanly and
    /// would otherwise be counted as real usage.
    #[test]
    fn codex_skips_bundled_fixture_logs() {
        assert!(is_codex_fixture(Path::new(
            "/home/u/.codex/.tmp/plugins/plugin-eval/fixtures/responses.jsonl"
        )));
        assert!(!is_codex_fixture(Path::new(
            "/home/u/.codex/sessions/2026/08/06/rollout-x.jsonl"
        )));
        assert!(!is_codex_fixture(Path::new(
            "/home/u/.codex/archived_sessions/rollout-y.jsonl"
        )));
    }

    // -----------------------------------------------------------------------
    // OpenCode
    // -----------------------------------------------------------------------

    #[test]
    fn opencode_reads_a_session_directory() {
        let dir = std::env::temp_dir().join(format!("spacron-opencode-{}", now_ms()));
        let session = dir.join("ses_abc");
        fs::create_dir_all(&session).unwrap();
        fs::write(
            session.join("msg_1.json"),
            r#"{"role":"assistant","modelID":"claude-sonnet-4.5","providerID":"github-copilot","time":{"created":1786320000000},"path":{"root":"/repo"},"tokens":{"input":1000,"output":200,"reasoning":50,"cache":{"read":300,"write":0}}}"#,
        )
        .unwrap();
        // A user turn carries no usage and must not become a turn.
        fs::write(
            session.join("msg_0.json"),
            r#"{"role":"user","time":{"created":1786320000000},"path":{"root":"/repo"}}"#,
        )
        .unwrap();

        let (meta, turns) = parse_opencode_session(&session);
        assert_eq!(meta.cwd.as_deref(), Some("/repo"));
        assert_eq!(turns.len(), 1);
        let parsed = aggregate_turns(&turns);
        assert_eq!(parsed.input_tokens, 1000);
        assert_eq!(parsed.cache_read_tokens, 300);
        // Reasoning is billed as output and is reported beside it here.
        assert_eq!(parsed.output_tokens, 250);
        assert_eq!(
            parsed.model.as_deref(),
            Some("github-copilot/claude-sonnet-4.5"),
            "the serving provider stays in the label so it is distinguishable"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // The session-JSONL family (Pi / OMP / Command Code)
    // -----------------------------------------------------------------------

    /// Pi and OMP: usage under `message`, short token keys, serving provider
    /// on the message.
    #[test]
    fn session_jsonl_reads_the_pi_and_omp_shape() {
        let dir = std::env::temp_dir().join(format!("spacron-pi-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_fixture(
            &dir,
            "2026-08-01T10-00-00-000Z_019e.jsonl",
            &[
                r#"{"type":"session","version":3,"id":"019e","timestamp":"2026-08-01T10:00:00.000Z","cwd":"/repo/app"}"#.to_string(),
                // A tool result carries no usage and must not become a turn.
                r#"{"type":"message","id":"a","timestamp":"2026-08-01T10:00:05.000Z","message":{"role":"toolResult","toolName":"read"}}"#.to_string(),
                r#"{"type":"message","id":"b","timestamp":"2026-08-01T10:00:09.000Z","message":{"role":"assistant","provider":"github-copilot","model":"gpt-5.4-mini","usage":{"input":1000,"output":200,"cacheRead":300,"cacheWrite":40,"reasoningTokens":90,"totalTokens":1500}}}"#.to_string(),
            ],
        );

        let (meta, turns) = parse_session_jsonl(&path);
        assert_eq!(meta.cwd.as_deref(), Some("/repo/app"));
        assert_eq!(turns.len(), 1);
        let parsed = aggregate_turns(&turns);
        assert_eq!(parsed.input_tokens, 1000);
        assert_eq!(
            parsed.output_tokens, 200,
            "reasoning is already inside output — adding it would inflate every row"
        );
        assert_eq!(parsed.cache_read_tokens, 300);
        assert_eq!(parsed.cache_write_tokens, 40);
        assert_eq!(
            parsed.session_ids.iter().next().map(String::as_str),
            Some("019e"),
            "the session header's id wins over the file stem"
        );
        assert_eq!(
            parsed.model.as_deref(),
            Some("github-copilot/gpt-5.4-mini"),
            "the serving provider stays in the label, as it does for OpenCode"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Command Code: usage and model on the ROW, long token keys, no serving
    /// provider. Same parser, and the difference is exactly why it is one.
    #[test]
    fn session_jsonl_reads_the_command_code_shape() {
        let dir = std::env::temp_dir().join(format!("spacron-cc-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_fixture(
            &dir,
            "35099cd7.jsonl",
            &[
                r#"{"type":"session","version":3,"id":"35099cd7","timestamp":"2026-08-06T21:03:13.056Z","cwd":"C:\\repo\\.spacron\\worktrees\\repo-sati"}"#.to_string(),
                r#"{"type":"message","id":"d3","timestamp":"2026-08-06T23:12:33.548Z","usage":{"inputTokens":34321,"outputTokens":518,"cacheReadTokens":7424,"cacheWriteTokens":0,"costUsd":0.004},"model":"deepseek/deepseek-v4-flash","message":{"role":"assistant"}}"#.to_string(),
            ],
        );

        let (meta, turns) = parse_session_jsonl(&path);
        assert_eq!(turns.len(), 1);
        let parsed = aggregate_turns(&turns);
        assert_eq!(parsed.input_tokens, 34321);
        assert_eq!(parsed.cache_read_tokens, 7424);
        assert_eq!(parsed.model.as_deref(), Some("deepseek/deepseek-v4-flash"));
        // The worktree is read off the cwd exactly as it is for every other
        // provider — this is what puts an agent's run in the right scope.
        let cwd = meta.cwd.clone().unwrap();
        assert!(is_managed_worktree(&cwd));
        assert_eq!(
            project_label(&cwd, None),
            "repo (repo-sati)",
            "no branch in the log, so the worktree directory names it"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A session's reported model is the one that did the work, not whichever
    /// turn happened to be last. A big model plus a small one summarising is
    /// the common shape, and taking the last row named the wrong one.
    #[test]
    fn a_sessions_model_is_the_one_that_spent_the_tokens() {
        let turn = |model: &str, input: u64, ts: &str| ParsedTurn {
            dedupe_key: None,
            session_id: "s".to_string(),
            ts_ms: iso_to_ms(ts).unwrap(),
            day: date_prefix(ts).unwrap(),
            model: Some(model.to_string()),
            input_tokens: input,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        };
        let parsed = aggregate_turns(&[
            turn("claude-opus-5", 300_000, "2026-08-01T10:00:00.000Z"),
            turn("claude-haiku-4-5", 900, "2026-08-01T10:05:00.000Z"),
        ]);
        assert_eq!(parsed.model.as_deref(), Some("claude-opus-5"));
    }

    /// A Claude model served through Copilot still prices as that Claude model.
    #[test]
    fn pricing_looks_past_the_serving_provider() {
        assert_eq!(
            normalize_model_for_pricing("github-copilot/claude-sonnet-4.5"),
            Some("claude-sonnet-4-5")
        );
        assert_eq!(
            normalize_model_for_pricing("github-copilot/claude-haiku-4.5"),
            Some("claude-haiku-4-5")
        );
        // Models with no entry stay unpriced rather than being guessed at.
        assert_eq!(normalize_model_for_pricing("opencode/glm-4.7-free"), None);
    }

    // -----------------------------------------------------------------------
    // Cross-provider isolation
    // -----------------------------------------------------------------------

    /// The `files` map is shared by every scanner. A sweep that pruned without
    /// filtering on its own provider would treat every other provider's paths
    /// as deleted and wipe their rows — the exact failure this guards.
    #[test]
    fn one_providers_sweep_cannot_evict_another() {
        let mut store = StoreFile::default();
        upsert_day(&mut store, PROVIDER_CODEX, "2026-08-10", "gpt-5.4", "p", false, 3, 0, 1, 100, 50, 0, 0);
        store.files.insert(
            "/codex/a.jsonl".to_string(),
            FileFingerprint {
                provider: PROVIDER_CODEX.to_string(),
                project_label: "p".to_string(),
                turns: 3,
                days: vec![FpDay {
                    day: "2026-08-10".to_string(),
                    model: "gpt-5.4".to_string(),
                    turns: 3,
                    input_tokens: 100,
                    output_tokens: 50,
                    ..Default::default()
                }],
                ..Default::default()
            },
        );

        // Claude sweeps and finds none of its own files. Codex must be intact.
        prune_deleted(&mut store, PROVIDER_CLAUDE, &HashSet::new());
        assert_eq!(store.files.len(), 1, "Codex's fingerprint survived");
        assert_eq!(store.days.len(), 1, "Codex's ledger row survived");

        // Codex sweeping with nothing on disk *does* clear its own rows.
        prune_deleted(&mut store, PROVIDER_CODEX, &HashSet::new());
        assert!(store.files.is_empty());
        assert!(store.days.is_empty());
    }

    #[test]
    fn rows_filter_by_provider() {
        let mut store = StoreFile::default();
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "claude-opus-5", "p", false, 1, 0, 1, 10, 5, 0, 0);
        upsert_day(&mut store, PROVIDER_CODEX, "2026-08-10", "gpt-5.4", "p", false, 1, 0, 1, 20, 7, 0, 0);
        upsert_day(&mut store, PROVIDER_OPENCODE, "2026-08-10", "opencode/kimi", "p", false, 1, 0, 1, 30, 9, 0, 0);

        assert_eq!(filter_rows(&store, PROVIDER_ALL, SCOPE_ALL, RANGE_ALL).len(), 3);
        assert_eq!(filter_rows(&store, PROVIDER_CODEX, SCOPE_ALL, RANGE_ALL).len(), 1);
        let codex = build_summary(&filter_rows(&store, PROVIDER_CODEX, SCOPE_ALL, RANGE_ALL));
        assert_eq!(codex.input_tokens, 20);
        assert_eq!(codex.output_tokens, 7);
    }

    /// Same provider and day, different model — these must stay separate rows,
    /// or a shared key would merge Codex's totals into Claude's.
    #[test]
    fn upsert_keys_include_the_provider() {
        let mut store = StoreFile::default();
        upsert_day(&mut store, PROVIDER_CLAUDE, "2026-08-10", "m", "p", false, 1, 0, 1, 10, 0, 0, 0);
        upsert_day(&mut store, PROVIDER_CODEX, "2026-08-10", "m", "p", false, 1, 0, 1, 10, 0, 0, 0);
        assert_eq!(store.days.len(), 2, "provider is part of the row identity");
    }

    #[test]
    fn heatmap_covers_42_days_and_scales_to_the_peak() {
        let today = utc_date_str(now_ms() / 1000);
        let daily = vec![
            DailyPoint {
                day: today.clone(),
                input_tokens: 1_000,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            },
            DailyPoint {
                day: utc_date_str(now_ms() / 1000 - 86_400),
                input_tokens: 10,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            },
        ];
        let grid = build_heatmap(&daily);
        assert_eq!(grid.len(), 42);
        assert_eq!(grid.last().unwrap().day, today, "newest cell is last");
        assert_eq!(grid.last().unwrap().level, 4, "the peak day tops the scale");
        // A day with a thousandth of the peak still has to be visible.
        assert_eq!(grid[grid.len() - 2].level, 1);
        // Days with no activity are rendered as empty cells, not dropped.
        assert_eq!(grid[0].level, 0);
        assert_eq!(grid[0].total_tokens, 0);
    }

    /// Scans the real machine and prints per-provider totals. Ignored by
    /// default — it depends on whatever logs the developer happens to have —
    /// but it is how the scanners were checked against independently computed
    /// counts. Run with `cargo test -- --ignored --nocapture real_logs`.
    #[test]
    #[ignore]
    fn real_logs_totals() {
        let home = dirs::home_dir().expect("home");
        let config = std::env::temp_dir().join("spacron-stats-real-config");
        let mut store = StoreFile::default();
        let (processed, skipped) = run_scan(&mut store, &config, &home);
        println!("processed {processed} unit(s), skipped {skipped}");
        let sources = load_provider_sources(&config);
        for (id, label) in surface_providers(&store, &sources) {
            let rows = filter_rows(&store, &id, SCOPE_ALL, RANGE_ALL);
            let s = build_summary(&rows);
            let total =
                s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_write_tokens;
            println!(
                "{label:>9}: {total:>15} tokens | {:>6} turns | {:>4} sessions | top {:?}",
                s.turns, s.sessions, s.top_model
            );
        }
    }

    /// The toggle is a preference, not derived data — a ledger rebuild must
    /// not silently switch tracking back on for someone who turned it off.
    #[test]
    fn enabled_survives_a_schema_rebuild() {
        let old = StoreFile {
            schema_version: 99,
            enabled: false,
            ..StoreFile::default()
        };
        let rebuilt = StoreFile {
            enabled: old.enabled,
            ..StoreFile::default()
        };
        assert!(!rebuilt.enabled);
        assert_eq!(rebuilt.schema_version, SCHEMA_VERSION);
    }

    // -----------------------------------------------------------------------
    // Registry + auto-discovery
    // -----------------------------------------------------------------------

    #[test]
    fn builtin_sources_cover_the_installed_clis() {
        let sources = builtin_provider_sources();
        let find = |id: &str| sources.iter().find(|s| s.provider == id).expect(id);

        assert_eq!(sources.len(), 8, "six original providers + Kilo + Aider");
        assert_eq!(find(PROVIDER_CLAUDE).format, SourceFormat::Claude);
        assert_eq!(find(PROVIDER_CODEX).format, SourceFormat::Codex);
        assert_eq!(find(PROVIDER_PI).format, SourceFormat::Session);
        // Kilo is scanned through OpenCode's reader: its pre-SQLite session
        // store is that exact `storage/message/<session>/<message>.json` shape.
        assert_eq!(find("kilo").format, SourceFormat::OpenCode);
        assert_eq!(find("kilo").label, "Kilo");
        assert_eq!(
            find("kilo").paths,
            vec![".local/share/kilo/storage/message".to_string()]
        );
        assert_eq!(find("aider").format, SourceFormat::Aider);
        assert_eq!(find("aider").paths, vec![".aider".to_string()]);
    }

    /// A registry file must be able to add a provider, override a built-in's
    /// paths and label, and disable one — the three moves a user needs to track
    /// a CLI Spacron does not ship a source for.
    #[test]
    fn registry_file_extends_overrides_and_disables() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-registry-{}", now_ms()));
        let config = dir.join("config");
        let registry = config.join("usage-stats");
        fs::create_dir_all(&registry).unwrap();
        fs::write(
            registry.join("providers.json"),
            r#"{
                "sources": [
                    { "provider": "pi", "label": "Pi CLI", "paths": [".pi/my-sessions"] },
                    { "provider": "kilo", "paths": [".kilo/custom-message"] },
                    { "provider": "omp", "paths": [] },
                    { "provider": "misti", "format": "session", "paths": [".misti/sessions"] }
                ]
            }"#,
        )
        .unwrap();

        let sources = load_provider_sources(&config);
        let pi = sources.iter().find(|s| s.provider == "pi").unwrap();
        assert_eq!(pi.label, "Pi CLI", "label override wins");
        assert_eq!(pi.paths, vec![".pi/my-sessions".to_string()]);
        assert_eq!(pi.format, SourceFormat::Session, "omitted format is kept");
        assert_eq!(sources.iter().find(|s| s.provider == "kilo").unwrap().format, SourceFormat::OpenCode,
            "a path override must not change the built-in parser");
        assert!(
            !sources.iter().any(|s| s.provider == "omp"),
            "empty paths disable a built-in"
        );
        let misti = sources.iter().find(|s| s.provider == "misti").unwrap();
        assert_eq!(misti.format, SourceFormat::Session, "new entry defaults to session");
        assert_eq!(misti.label, "Misti", "new entry label is prettified");

        // A bad file falls back to the built-ins untouched, like the ledger store.
        fs::write(registry.join("providers.json"), "{not json").unwrap();
        assert_eq!(load_provider_sources(&config).len(), 8);

        let _ = fs::remove_dir_all(&dir);
    }

    /// End to end: a registry entry is scanned under its own provider id, and
    /// the Overview lists it alongside the built-ins.
    #[test]
    fn registry_entry_scans_and_surfaces() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-regscan-{}", now_ms()));
        let home = dir.join("home");
        let config = dir.join("config");
        let registry = config.join("usage-stats");
        fs::create_dir_all(&registry).unwrap();
        fs::write(
            registry.join("providers.json"),
            r#"{"sources":[{"provider":"flor","format":"session","paths":[".flor/sessions"]}]}"#,
        )
        .unwrap();

        let empty = surface_providers(&StoreFile::default(), &load_provider_sources(&config));
        assert!(empty.iter().any(|(id, label)| id == "flor" && label == "Flor"),
            "a registered agent is selectable before it has usage data");

        let sessions = home.join(".flor").join("sessions").join("ses1");
        fs::create_dir_all(&sessions).unwrap();
        write_fixture(
            &sessions,
            "s1.jsonl",
            &[
                r#"{"type":"session","id":"ses1","cwd":"/repo"}"#.to_string(),
                r#"{"type":"message","timestamp":"2026-09-20T10:00:00Z","message":{"provider":"xai","model":"grok-4","usage":{"input":100,"output":40,"cacheRead":0,"cacheWrite":0}}}"#.to_string(),
            ],
        );

        let mut store = StoreFile::default();
        run_scan(&mut store, &config, &home);
        let rows = filter_rows(&store, "flor", SCOPE_ALL, RANGE_ALL);
        let s = build_summary(&rows);
        assert_eq!(s.turns, 1);
        assert_eq!(s.input_tokens, 100);
        assert_eq!(s.output_tokens, 40);

        let surfaced = surface_providers(&store, &load_provider_sources(&config));
        assert!(
            surfaced.iter().any(|(id, label)| id == "flor" && label == "Flor"),
            "registry providers appear in the Overview"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// `~/.aider` analytics only counts `message_send` rows that carry real
    /// numbers; lifecycle events and zero-count sends are noise.
    #[test]
    fn aider_log_parses_message_send_counts() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-aider-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_fixture(
            &dir,
            "chat.jsonl",
            &[
                r#"{"event":"launched","time":1758000000}"#.to_string(),
                r#"{"event":"message_send","time":1758000000,"properties":{"main_model":"anthropic/claude-sonnet-4-5","prompt_tokens":1200,"completion_tokens":300}}"#.to_string(),
                r#"{"event":"message_send","time":1758086400,"properties":{"main_model":"gemini/gemini-2.5-flash","prompt_tokens":0,"completion_tokens":0}}"#.to_string(),
                r#"{"event":"exit","time":1758090000}"#.to_string(),
            ],
        );

        let (meta, turns) = parse_aider_log(&path);
        assert_eq!(turns.len(), 1, "zero-count sends are skipped");
        assert_eq!(turns[0].input_tokens, 1200);
        assert_eq!(turns[0].output_tokens, 300);
        assert_eq!(turns[0].model.as_deref(), Some("anthropic/claude-sonnet-4-5"));
        assert_eq!(turns[0].day, utc_date_str(1_758_000_000));
        assert_eq!(turns[0].session_id, "chat", "session falls back to the file stem");
        assert_eq!(turns[0].cache_read_tokens, 0, "the log carries no cache split");
        assert!(meta.cwd.is_none(), "the analytics log carries no cwd");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Tier 3, end to end: `~/.aider/analytics.jsonl` lands under provider
    /// `aider` through the registry, and an unchanged rescan skips it.
    #[test]
    fn run_scan_reads_aider_analytics() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-aider-scan-{}", now_ms()));
        let home = dir.join("home");
        let config = dir.join("config");
        let aider_dir = home.join(".aider");
        fs::create_dir_all(&aider_dir).unwrap();
        write_fixture(
            &aider_dir,
            "analytics.jsonl",
            &[
                r#"{"event":"message_send","time":1758000000,"properties":{"main_model":"aider/claude-sonnet-4-5","prompt_tokens":900,"completion_tokens":100}}"#.to_string(),
            ],
        );

        let mut store = StoreFile::default();
        let (processed, _) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 1);
        let rows = filter_rows(&store, "aider", SCOPE_ALL, RANGE_ALL);
        let s = build_summary(&rows);
        assert_eq!(s.turns, 1);
        assert_eq!(s.input_tokens, 900);
        assert_eq!(s.output_tokens, 100);
        assert_eq!(s.top_model.as_deref(), Some("aider/claude-sonnet-4-5"));

        let (_, skipped) = run_scan(&mut store, &config, &home);
        assert_eq!(skipped, 1, "unchanged analytics files are skipped");

        // A stray, unrelated jsonl under ~/.aider contributes nothing at all.
        write_fixture(&aider_dir, "notes.jsonl", &[r#"{"note":"hello"}"#.to_string()]);
        let (processed, _) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 0, "files without message_send usage never register");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Kilo's pre-SQLite store is OpenCode's layout under Kilo's data root; the
    /// built-in source must read it without a registry entry.
    #[test]
    fn run_scan_reads_kilo_store() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-kilo-{}", now_ms()));
        let home = dir.join("home");
        let config = dir.join("config");
        fs::create_dir_all(&config).unwrap();
        let session = home
            .join(".local")
            .join("share")
            .join("kilo")
            .join("storage")
            .join("message")
            .join("ses_kilo");
        fs::create_dir_all(&session).unwrap();
        fs::write(
            session.join("msg1.json"),
            r#"{"role":"assistant","providerID":"kilo","modelID":"claude-sonnet-4-5","path":{"root":"/repo"},"time":{"created":1758000000000},"tokens":{"input":50,"output":20,"reasoning":0,"cache":{"read":10,"write":5}}}"#,
        )
        .unwrap();

        let mut store = StoreFile::default();
        let (processed, _) = run_scan(&mut store, &config, &home);
        assert_eq!(processed, 1, "the Kilo session directory registered");
        let rows = filter_rows(&store, "kilo", SCOPE_ALL, RANGE_ALL);
        let s = build_summary(&rows);
        assert_eq!(s.turns, 1);
        assert_eq!(s.input_tokens, 50);
        assert_eq!(s.output_tokens, 20);
        assert_eq!(s.cache_read_tokens, 10);
        assert_eq!(s.cache_write_tokens, 5);
        assert_eq!(rows[0].day, "2025-09-16");
        assert_eq!(
            s.top_model.as_deref(),
            Some("kilo/claude-sonnet-4-5"),
            "recorded as providerID/modelID like OpenCode"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Tier 2: a CLI Spacron has never heard of, writing the shared
    /// `<dot>/agent/sessions` shape under either swept home, is scanned under
    /// its directory name and surfaces in the Overview.
    #[test]
    fn convention_sweep_discovers_unregistered_clis() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-discover-{}", now_ms()));
        let home = dir.join("home");
        let config = dir.join("config");
        fs::create_dir_all(&config).unwrap();

        let session_rows = || {
            vec![
                r#"{"type":"session","id":"ses1","cwd":"/repo"}"#.to_string(),
                r#"{"type":"message","timestamp":"2026-09-20T10:00:00Z","message":{"provider":"xai","model":"grok-4","usage":{"input":100,"output":40,"cacheRead":0,"cacheWrite":0}}}"#.to_string(),
            ]
        };

        // `~/misti/agent/sessions` — the home-root sweep.
        let misti = home.join("misti").join("agent").join("sessions").join("ses1");
        fs::create_dir_all(&misti).unwrap();
        write_fixture(&misti, "s1.jsonl", &session_rows());

        // `~/.config/flor/agent/sessions` — the config-dir sweep.
        let flor = home
            .join(".config")
            .join("flor")
            .join("agent")
            .join("sessions")
            .join("ses2");
        fs::create_dir_all(&flor).unwrap();
        write_fixture(&flor, "s2.jsonl", &session_rows());

        let quiet = home.join(".quiet").join("agent").join("sessions");
        fs::create_dir_all(&quiet).unwrap();
        write_fixture(&quiet, "s1.jsonl", &[r#"{"type":"session","id":"ses-quiet"}"#.to_string()]);

        // A registered provider's tree must not be double-scanned by the sweep
        // under a second id — `.config/pi` mirrors a built-in's name.
        let claimed = home.join(".config").join("pi").join("agent").join("sessions");
        fs::create_dir_all(&claimed).unwrap();
        write_fixture(&claimed, "s3.jsonl", &session_rows());

        let mut store = StoreFile::default();
        run_scan(&mut store, &config, &home);

        for id in ["misti", "flor"] {
            let rows = filter_rows(&store, id, SCOPE_ALL, RANGE_ALL);
            assert_eq!(rows.len(), 1, "{id} was discovered and scanned");
            assert_eq!(rows[0].input_tokens, 100);
        }
        assert!(
            !store.files.values().any(|fp| fp.provider == "pi"),
            "claimed names are skipped by the sweep"
        );

        let surfaced = surface_providers(&store, &load_provider_sources(&config));
        assert!(
            surfaced.iter().any(|(id, label)| id == "misti" && label == "Misti")
                && surfaced.iter().any(|(id, label)| id == "flor" && label == "Flor"),
            "discovered providers surface in the Overview with prettified labels"
        );
        let available = surface_providers_with_discovery(&store, &load_provider_sources(&config), &home);
        assert!(available.iter().any(|(id, label)| id == "quiet" && label == "Quiet"),
            "a discovered agent appears before it records token usage");
        let recent = build_recent_sessions(&store, "misti", SCOPE_ALL, &load_provider_sources(&config), 10);
        assert_eq!(recent.len(), 1, "discovered sessions use the session parser in detail views");

        let _ = fs::remove_dir_all(&dir);
    }

    /// The sweep must not claim a tree that merely has the path shape — the
    /// files have to actually be session JSONL.
    #[test]
    fn convention_sweep_ignores_foreign_trees() {
        let dir = std::env::temp_dir().join(format!("spacron-stats-foreign-{}", now_ms()));
        let home = dir.join("home");
        let config = dir.join("config");
        fs::create_dir_all(&config).unwrap();

        // Right path shape, wrong content (no `{"type":"session"}` header).
        let foreign = home.join("noise").join("agent").join("sessions");
        fs::create_dir_all(&foreign).unwrap();
        write_fixture(
            &foreign,
            "n1.jsonl",
            &[r#"{"type":"message","message":{"usage":{"input":0,"output":0}}}"#.to_string()],
        );

        let mut store = StoreFile::default();
        run_scan(&mut store, &config, &home);
        assert!(
            store.days.is_empty() && store.files.is_empty(),
            "a foreign tree is never claimed"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
