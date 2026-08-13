//! Agent activity stats — "how much work have my agents done?"
//!
//! The third leg of the Stats tab, alongside the token ledger
//! (`usage_stats.rs`) and the live rate-limit meters (`usage.rs`). Those two
//! read files somebody else wrote; this one has nothing to read, because
//! Spacron keeps its agent sessions in memory and persists no history of them.
//! So, like Orca's `src/main/stats/collector.ts`, it is a **recorder**: the
//! webview reports the two events it already detects, and this module keeps the
//! running totals on disk.
//!
//! ## Why these four figures and not Orca's four
//!
//! Orca shows agents spawned / time agents worked / **PRs created** / tracking
//! since. Spacron has no PR creation anywhere — `commands/github.rs` can create
//! a *repo*, sign in, and list repos, but nothing opens a pull request — so a
//! "PRs created" card could only ever render 0. Turns completed replaces it:
//! it is the one number Spacron measures precisely, because a turn boundary is
//! exactly what `watchLeasedAgentTurn` already resolves on.
//!
//! ## Counting rules
//!
//! 1. **Only completed turns are counted.** A turn that is still running has no
//!    duration yet, and adding "time so far" would make the total drift upward
//!    while nobody is looking at it. `blocked` turns count their elapsed time —
//!    the agent really did work — but are tallied separately so the split stays
//!    visible.
//! 2. **The webview owns dedupe.** Session ids are unique per app run and
//!    `markSessionAgentPreset` fires more than once per session (re-brief,
//!    re-detect), so the store would double-count if it trusted every call.
//!    The caller sends a spawn once per session; see `activityStats.ts`.
//! 3. **Absence is not zero, again.** `trackingSinceMs` is `None` until the
//!    first event lands, and the pane renders the cards only once it is set.
//!    Four zeroes under a "tracking since today" label reads as "your agents
//!    did nothing", when the truth is "nothing has been recorded yet".

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::AppState;

/// Bump only for a shape change that makes old totals unreadable. Unlike the
/// token ledger a rebuild here is **unrecoverable** — the source events are
/// gone — so prefer an additive, `#[serde(default)]` field every time.
const SCHEMA_VERSION: u32 = 1;

/// A turn longer than this is treated as a stuck watcher rather than work.
///
/// The idle fallback in `agent-turn-watch.ts` bounds a signalled turn at 15
/// minutes, but a watcher whose session was suspended (laptop closed mid-turn)
/// can report a wall-clock gap of hours. Letting one of those into the total
/// silently adds a day of "work" nobody did.
const MAX_CREDITED_TURN_MS: i64 = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ProviderTotals {
    #[serde(default)]
    agents_spawned: u64,
    #[serde(default)]
    turns_completed: u64,
    #[serde(default)]
    turns_blocked: u64,
    #[serde(default)]
    worked_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    schema_version: u32,
    /// Instant of the first recorded event — the "Tracking since" figure.
    #[serde(default)]
    tracking_since_ms: Option<i64>,
    /// Keyed by agent preset command ("claude", "codex"), which is the same
    /// join key `PROVIDERS` and `AI_AGENT_PRESETS` use, so a row can resolve
    /// its brand mark on the frontend.
    #[serde(default)]
    providers: BTreeMap<String, ProviderTotals>,
}

impl Default for StoreFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            tracking_since_ms: None,
            providers: BTreeMap::new(),
        }
    }
}

static STORE: Mutex<Option<StoreFile>> = Mutex::new(None);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("usage-stats").join("activity.json")
}

fn load_store(config_dir: &Path) -> StoreFile {
    if let Some(store) = STORE.lock().ok().and_then(|g| g.clone()) {
        return store;
    }
    let mut store = StoreFile::default();
    if let Ok(text) = fs::read_to_string(store_path(config_dir)) {
        if let Ok(parsed) = serde_json::from_str::<StoreFile>(&text) {
            // A version mismatch keeps the totals rather than discarding them.
            // They are irreplaceable, and every field here is additive.
            store = StoreFile {
                schema_version: SCHEMA_VERSION,
                ..parsed
            };
        }
    }
    if let Ok(mut guard) = STORE.lock() {
        *guard = Some(store.clone());
    }
    store
}

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

/// Normalise a preset command into a store key. An empty or missing provider
/// becomes `unknown` rather than being dropped — the turn happened, and losing
/// it would make the totals disagree with the per-provider rows.
fn provider_key(provider: &str) -> String {
    let trimmed = provider.trim();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_lowercase()
    }
}

fn touch_tracking_since(store: &mut StoreFile) {
    if store.tracking_since_ms.is_none() {
        store.tracking_since_ms = Some(now_ms());
    }
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActivity {
    /// Agent preset command — the brand-mark join key.
    pub provider: String,
    pub agents_spawned: u64,
    pub turns_completed: u64,
    pub turns_blocked: u64,
    pub worked_ms: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    /// `None` until the first event is recorded — the pane's gate.
    pub tracking_since_ms: Option<i64>,
    pub agents_spawned: u64,
    pub turns_completed: u64,
    pub turns_blocked: u64,
    pub worked_ms: i64,
    /// Busiest provider first, so the list leads with what actually ran.
    pub providers: Vec<ProviderActivity>,
}

fn summarise(store: &StoreFile) -> ActivitySummary {
    let mut providers: Vec<ProviderActivity> = store
        .providers
        .iter()
        .map(|(provider, totals)| ProviderActivity {
            provider: provider.clone(),
            agents_spawned: totals.agents_spawned,
            turns_completed: totals.turns_completed,
            turns_blocked: totals.turns_blocked,
            worked_ms: totals.worked_ms,
        })
        .collect();
    providers.sort_by(|a, b| {
        b.worked_ms
            .cmp(&a.worked_ms)
            .then_with(|| b.turns_completed.cmp(&a.turns_completed))
            .then_with(|| a.provider.cmp(&b.provider))
    });

    ActivitySummary {
        tracking_since_ms: store.tracking_since_ms,
        agents_spawned: providers.iter().map(|p| p.agents_spawned).sum(),
        turns_completed: providers.iter().map(|p| p.turns_completed).sum(),
        turns_blocked: providers.iter().map(|p| p.turns_blocked).sum(),
        worked_ms: providers.iter().map(|p| p.worked_ms).sum(),
        providers,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Record one agent session starting. Called once per session by the webview.
#[tauri::command]
pub fn activity_record_spawn(state: tauri::State<'_, AppState>, provider: String) {
    let mut store = load_store(&state.config_dir);
    touch_tracking_since(&mut store);
    store
        .providers
        .entry(provider_key(&provider))
        .or_default()
        .agents_spawned += 1;
    save_store(&state.config_dir, &store);
}

/// Record one finished turn. `outcome` is the `AgentTurnOutcome` kind
/// (`finished` / `blocked` / `failed`); anything else counts as finished.
#[tauri::command]
pub fn activity_record_turn(
    state: tauri::State<'_, AppState>,
    provider: String,
    duration_ms: i64,
    outcome: Option<String>,
) {
    // A negative or absurd duration means a clock change or a suspended
    // watcher, not work. Drop the duration but still count the turn — it did
    // happen, and a turn count that skips them would disagree with the ledger.
    let credited = duration_ms.clamp(0, MAX_CREDITED_TURN_MS);

    let mut store = load_store(&state.config_dir);
    touch_tracking_since(&mut store);
    let totals = store.providers.entry(provider_key(&provider)).or_default();
    if outcome.as_deref() == Some("blocked") {
        totals.turns_blocked += 1;
    } else {
        totals.turns_completed += 1;
    }
    totals.worked_ms += credited;
    save_store(&state.config_dir, &store);
}

#[tauri::command]
pub fn activity_get_summary(state: tauri::State<'_, AppState>) -> ActivitySummary {
    summarise(&load_store(&state.config_dir))
}

/// Clear every recorded total. The one destructive command here, so it is
/// explicit and never called on a schema mismatch.
#[tauri::command]
pub fn activity_reset(state: tauri::State<'_, AppState>) -> ActivitySummary {
    let store = StoreFile::default();
    save_store(&state.config_dir, &store);
    summarise(&store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(rows: &[(&str, ProviderTotals)]) -> StoreFile {
        let mut store = StoreFile::default();
        store.tracking_since_ms = Some(1_000);
        for (key, totals) in rows {
            store.providers.insert((*key).to_string(), totals.clone());
        }
        store
    }

    #[test]
    fn totals_sum_across_providers_and_rank_by_time_worked() {
        let store = store_with(&[
            (
                "claude",
                ProviderTotals {
                    agents_spawned: 3,
                    turns_completed: 10,
                    turns_blocked: 1,
                    worked_ms: 5_000,
                },
            ),
            (
                "codex",
                ProviderTotals {
                    agents_spawned: 2,
                    turns_completed: 4,
                    turns_blocked: 0,
                    worked_ms: 9_000,
                },
            ),
        ]);
        let summary = summarise(&store);
        assert_eq!(summary.agents_spawned, 5);
        assert_eq!(summary.turns_completed, 14);
        assert_eq!(summary.turns_blocked, 1);
        assert_eq!(summary.worked_ms, 14_000);
        // Codex worked longer despite fewer turns, so it leads.
        assert_eq!(summary.providers[0].provider, "codex");
    }

    #[test]
    fn an_empty_store_reports_no_tracking_start() {
        // The pane's gate: no events means no cards, not four zeroes.
        let summary = summarise(&StoreFile::default());
        assert_eq!(summary.tracking_since_ms, None);
        assert_eq!(summary.agents_spawned, 0);
        assert!(summary.providers.is_empty());
    }

    #[test]
    fn provider_keys_normalise_and_never_drop_a_turn() {
        assert_eq!(provider_key("  Claude "), "claude");
        assert_eq!(provider_key(""), "unknown");
        assert_eq!(provider_key("   "), "unknown");
    }

    #[test]
    fn a_suspended_watchers_turn_is_capped_not_counted_whole() {
        // Six hours of wall clock across a closed laptop is not six hours of
        // work; crediting it would swamp every real turn in the total.
        let absurd: i64 = 6 * 60 * 60 * 1000;
        assert_eq!(absurd.clamp(0, MAX_CREDITED_TURN_MS), MAX_CREDITED_TURN_MS);
        // A backwards clock yields a negative gap, which must not subtract.
        assert_eq!((-5_000_i64).clamp(0, MAX_CREDITED_TURN_MS), 0);
    }

    #[test]
    fn a_version_mismatch_keeps_the_totals() {
        // Unlike the token ledger these events cannot be re-derived from disk,
        // so a schema bump must migrate rather than rebuild.
        let older = r#"{"schemaVersion":0,"trackingSinceMs":42,
                        "providers":{"claude":{"agentsSpawned":7}}}"#;
        let parsed: StoreFile = serde_json::from_str(older).unwrap();
        let migrated = StoreFile {
            schema_version: SCHEMA_VERSION,
            ..parsed
        };
        assert_eq!(migrated.tracking_since_ms, Some(42));
        assert_eq!(migrated.providers["claude"].agents_spawned, 7);
        // Fields absent from the old file default rather than failing the parse.
        assert_eq!(migrated.providers["claude"].worked_ms, 0);
    }
}
