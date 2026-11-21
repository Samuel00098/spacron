use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Jev's own service, and the default.
const TYPESAFE: &str = "typesafe";

/// Where the real Jev is served, all on TypeSafe's own `/systemone` request
/// shape, each billed to that provider's saved key. Checked 2026-09-26:
/// OpenRouter `/api/v1/systemone` (401 without a key, `jev-latest` routed to
/// its newest-Jev alias); Vercel AI Gateway `/typesafe/v1/systemone` with the
/// gateway's own id for the model.
fn builtin_source(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        TYPESAFE => Some(("https://api.typesafe.ai/v1/systemone", "jev-latest")),
        "openrouter" => Some(("https://openrouter.ai/api/v1/systemone", "jev-latest")),
        "vercel" => Some(("https://ai-gateway.vercel.sh/typesafe/v1/systemone", "typesafe-ai/jev")),
        _ => None,
    }
}

/// Custom providers found NOT to serve `/systemone` (a LiteLLM proxy may; most
/// OpenAI-compatible APIs do not), so each decision does not pay a failed call.
static NO_SYSTEMONE: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn remember_no_systemone(provider: &str) {
    NO_SYSTEMONE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default).insert(provider.to_string());
}

fn known_without_systemone(provider: &str) -> bool {
    NO_SYSTEMONE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|set| set.contains(provider))
}

/// One Jev answer plus what it cost, as the source reported it.
struct Decision {
    answer: Value,
    input_tokens: u64,
    /// Only OpenRouter and the Vercel gateway put a price on the response.
    cost_usd: Option<f64>,
}

/// One bounded, optional Choice decision. The renderer never receives the key.
///
/// `provider` picks where the real Jev is reached: TypeSafe (the default),
/// OpenRouter, Vercel AI Gateway, or a custom provider that serves
/// `/systemone`. No key saved, or a source that does not serve Jev, means Jev
/// is off (`None`) and the caller uses its existing path.
#[tauri::command]
pub async fn jev_classify(
    state: String,
    question: String,
    labels: HashMap<String, String>,
    provider: Option<String>,
) -> Result<Option<Value>, String> {
    if state.trim().is_empty() || question.trim().is_empty() || labels.len() < 2 || labels.len() > 255 {
        return Err("Jev needs state, a question, and 2–255 labels".to_string());
    }
    let provider = provider.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| TYPESAFE.to_string());
    Ok(decide(&provider, &state, &question, &labels).await?.map(|d| d.answer))
}

/// The `/systemone` endpoint and model id for a Jev source, or `None` when the
/// provider does not serve Jev.
fn source_endpoint(provider: &str) -> Option<(String, &'static str)> {
    if let Some((url, model)) = builtin_source(provider) {
        return Some((url.to_string(), model));
    }
    if !super::custom_providers::is_custom_provider(provider) || known_without_systemone(provider) {
        return None;
    }
    super::custom_providers::base_url(provider).map(|base| (format!("{base}/systemone"), "jev-latest"))
}

/// One `/systemone` request with any set of questions; the whole response
/// body back. `None` = this source does not serve Jev or has no key.
async fn call_source(provider: &str, state: &str, questions: Value, timeout_ms: u64) -> Result<Option<Value>, String> {
    let Some((url, model)) = source_endpoint(provider) else { return Ok(None) };
    match systemone(&url, model, provider, state, questions, timeout_ms).await {
        Err(error) if builtin_source(provider).is_none() && (error.contains("HTTP 404") || error.contains("HTTP 405")) => {
            remember_no_systemone(provider);
            Ok(None)
        }
        other => other,
    }
}

/// One Choice decision about one piece of state.
async fn decide(
    provider: &str,
    state: &str,
    question: &str,
    labels: &HashMap<String, String>,
) -> Result<Option<Decision>, String> {
    let questions = json!({ "classification": { "type": "choice", "instructions": question, "criteria": labels } });
    // TypeSafe answers in 70-500 ms; a router in front of it adds a hop.
    let timeout = if provider == TYPESAFE { 2_000 } else { 4_000 };
    let Some(body) = call_source(provider, state, questions, timeout).await? else { return Ok(None) };
    let answer = body
        .get("answers")
        .and_then(|answers| answers.get("classification"))
        .ok_or_else(|| "Jev response omitted the classification".to_string())?
        .clone();
    Ok(Some(Decision { answer, input_tokens: input_tokens(&body), cost_usd: reported_cost(&body) }))
}

/// Answers for a batch of items, by item index, plus what the request cost.
struct BatchDecision {
    answers: HashMap<usize, Value>,
    input_tokens: u64,
    cost_usd: Option<f64>,
}

/// The shared state for a batch: every item, numbered. Jev answers each
/// question against the same state (Vercel's evaluation docs: "Several
/// questions can be answered in parallel within a single request, against the
/// same state"), so each question names the one item it is about.
fn batch_state(items: &[(usize, String)]) -> String {
    items
        .iter()
        .map(|(i, text)| format!("<item id=\"{}\">\n{}\n</item>", i + 1, text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn batch_questions(items: &[(usize, String)], question: &str, labels: &HashMap<String, String>) -> Value {
    let mut questions = Map::new();
    for (i, _) in items {
        questions.insert(
            format!("item_{}", i + 1),
            json!({
                "type": "choice",
                "instructions": format!("{question}\nJudge ONLY the item with id=\"{}\"; ignore the other items.", i + 1),
                "criteria": labels,
            }),
        );
    }
    Value::Object(questions)
}

/// Several items in one request: one question per item.
async fn decide_batch(
    provider: &str,
    items: &[(usize, String)],
    question: &str,
    labels: &HashMap<String, String>,
) -> Result<Option<BatchDecision>, String> {
    let questions = batch_questions(items, question, labels);
    let Some(body) = call_source(provider, &batch_state(items), questions, 20_000).await? else { return Ok(None) };
    let mut answers = HashMap::new();
    for (i, _) in items {
        if let Some(answer) = body["answers"].get(format!("item_{}", i + 1)) {
            answers.insert(*i, answer.clone());
        }
    }
    Ok(Some(BatchDecision { answers, input_tokens: input_tokens(&body), cost_usd: reported_cost(&body) }))
}

/// Whether `provider` can be offered as a Jev source: the three built-in ones
/// always; a custom provider only when its `/systemone` route exists. Settings
/// lists only the sources this says yes to.
#[tauri::command]
pub async fn jev_source_supported(provider: String) -> bool {
    if builtin_source(&provider).is_some() {
        return true;
    }
    if !super::custom_providers::is_custom_provider(&provider) || known_without_systemone(&provider) {
        return false;
    }
    let Some(base) = super::custom_providers::base_url(&provider) else { return false };
    let Ok(Some(api_key)) = super::secrets::provider_api_key_get(provider.clone()) else { return false };
    let Ok(client) = super::secrets::shared_http_client(Duration::from_secs(6)) else { return false };
    // An empty body: a server with the route rejects it as invalid (400/422)
    // or unauthorized, one without it answers 404/405.
    let Ok(response) = client.post(format!("{base}/systemone")).bearer_auth(api_key).json(&json!({})).send().await else {
        return false;
    };
    let status = response.status().as_u16();
    let served = status != 404 && status != 405 && status < 500;
    if !served {
        remember_no_systemone(&provider);
    }
    served
}

/// POST to a `/systemone` endpoint, authenticated with `key_provider`'s saved
/// key. `None` when no key is saved: Jev is simply off.
async fn systemone(
    url: &str,
    model: &str,
    key_provider: &str,
    state: &str,
    questions: Value,
    timeout_ms: u64,
) -> Result<Option<Value>, String> {
    let Some(api_key) = super::secrets::provider_api_key_get(key_provider.to_string())? else {
        return Ok(None);
    };
    let client = super::secrets::shared_http_client(Duration::from_millis(timeout_ms))?;
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({ "state": state, "model": model, "questions": questions }))
        .send()
        .await
        .map_err(|err| format!("Jev request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Jev returned HTTP {}", response.status()));
    }
    response.json::<Value>().await.map(Some).map_err(|err| format!("Invalid Jev response: {err}"))
}

fn input_tokens(body: &Value) -> u64 {
    body["usage"]["input_tokens"].as_u64().unwrap_or(0)
}

/// OpenRouter puts `usage.cost` (a number); the Vercel gateway puts
/// `provider_metadata.gateway.cost` (a decimal string).
fn reported_cost(body: &Value) -> Option<f64> {
    let cost = &body["usage"]["cost"];
    if let Some(n) = cost.as_f64() {
        return Some(n);
    }
    body["provider_metadata"]["gateway"]["cost"].as_str().and_then(|s| s.parse().ok())
}

// ---------------------------------------------------------------------------
// The `jev_classify` MCP tool: Jev for the CLI agents Spacron runs.
//
// Off by default. While off it is not even listed, so agents carry none of its
// schema; the Settings switch pushes on/off and the source here, and connected
// agents are told to re-read `tools/list`. It is shaped for bulk work on
// references (a file inside the project), because the saving comes from the
// agent NOT reading or re-typing the items: a single inline decision costs the
// agent more in tool-call output than it would spend thinking.
// ---------------------------------------------------------------------------

/// `Some(source)` while the agent tool is on.
static AGENT_TOOL: RwLock<Option<String>> = RwLock::new(None);

/// Switch the agent tool on (with the Jev source to use) or off.
pub fn set_agent_tool(enabled: bool, provider: String) {
    let provider = if provider.trim().is_empty() { TYPESAFE.to_string() } else { provider };
    *AGENT_TOOL.write().unwrap_or_else(|e| e.into_inner()) = enabled.then_some(provider);
}

pub fn agent_tool_enabled() -> bool {
    AGENT_TOOL.read().unwrap_or_else(|e| e.into_inner()).is_some()
}

const MAX_ITEMS: usize = 1_000;
const MAX_INLINE_ITEMS: usize = 200;
const MAX_ITEM_CHARS: usize = 4_000;
const MAX_LABELS: usize = 32;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Items per `/systemone` request, and the most text one request carries. No
/// limit is published; these stay well inside what one request should hold.
const BATCH_SIZE: usize = 25;
const BATCH_CHARS: usize = 20_000;
/// Requests in flight at once, for batches and for the per-item fallback.
const BATCH_CONCURRENCY: usize = 4;
/// Past this many items only the uncertain ones are itemized.
const ITEMIZE_ALL_UP_TO: usize = 100;
const CONFIDENT: f64 = 0.75;

pub fn mcp_tool_schema() -> Value {
    json!({
        "name": "jev_classify",
        "description": "Classify many items at once with Jev, a fast, cheap decision model (about $0.04 per million input tokens, no output cost). Use it for BULK sorting you would otherwise read through yourself: e.g. which of 500 test failures are flaky vs real, which files touch auth, which log lines are errors. Point it at a file with `file` (one item per line, or the whole file as one item) instead of pasting text, so you never read or re-type the items. Returns counts per label and each item's label with its probability. Not worth it for a single small decision; just decide that yourself.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": { "type": "string", "description": "What to decide about each item, e.g. 'Is this test failure caused by a flaky timeout?'" },
                "labels": {
                    "type": "object",
                    "description": "2-32 possible answers: label name -> what it means. E.g. {\"flaky\": \"Timing or network, passes on retry\", \"real\": \"A genuine bug in the code under test\"}",
                    "additionalProperties": { "type": "string" }
                },
                "file": { "type": "string", "description": "A text file inside the project (path relative to the project root, or absolute inside it). Write command output to a file first to classify it." },
                "split": { "type": "string", "enum": ["lines", "whole"], "description": "How to cut `file` into items: one per non-empty line (default) or the whole file as one item." },
                "items": { "type": "array", "items": { "type": "string" }, "description": "Items given inline, up to 200. Prefer `file` for anything long." }
            },
            "required": ["question", "labels"]
        }
    })
}

#[derive(Debug, Deserialize)]
struct ToolArgs {
    question: String,
    labels: HashMap<String, String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    split: Option<String>,
    #[serde(default)]
    items: Option<Vec<String>>,
}

/// Where a `file` may be read from: the project, and the legacy sibling
/// worktree folder (`<parent>/.spacron-worktrees/<repo>`). Current worktrees
/// live inside the project (`.spacron/worktrees`).
fn allowed_roots(project_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![project_root.to_path_buf()];
    if let (Some(parent), Some(name)) = (project_root.parent(), project_root.file_name()) {
        roots.push(parent.join(".spacron-worktrees").join(name));
    }
    roots.into_iter().filter_map(|r| std::fs::canonicalize(r).ok()).collect()
}

/// Resolve `raw` to an existing file inside the roots. Canonicalizing an
/// existing path resolves `..` and symlinks, so the prefix check after it
/// cannot be escaped (see path-confinement-layers).
fn confine_file(raw: &str, project_root: &Path) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("`file` is empty.".to_string());
    }
    let candidate = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { project_root.join(raw) };
    let resolved = std::fs::canonicalize(&candidate).map_err(|_| format!("No file at {raw}."))?;
    if !allowed_roots(project_root).iter().any(|root| resolved.starts_with(root)) {
        return Err("`file` must be inside the project.".to_string());
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{raw} is not a file."));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{raw} is larger than 4 MB; split it or pass a smaller file."));
    }
    Ok(resolved)
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}

fn collect_items(args: &ToolArgs, project_root: Option<&Path>) -> Result<Vec<String>, String> {
    let mut items: Vec<String> = Vec::new();
    if let Some(file) = args.file.as_deref() {
        let root = project_root.ok_or("No project is open in Spacron, so `file` cannot be resolved.")?;
        let path = confine_file(file, root)?;
        let text = std::fs::read_to_string(&path).map_err(|_| format!("{file} is not a UTF-8 text file."))?;
        match args.split.as_deref().unwrap_or("lines") {
            "whole" => items.push(text),
            "lines" => items.extend(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string)),
            other => return Err(format!("`split` must be \"lines\" or \"whole\", not \"{other}\".")),
        }
    }
    if let Some(inline) = &args.items {
        if inline.len() > MAX_INLINE_ITEMS {
            return Err(format!("At most {MAX_INLINE_ITEMS} inline items; put the rest in a file and pass `file`."));
        }
        items.extend(inline.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()));
    }
    if items.is_empty() {
        return Err("Nothing to classify: pass `file` or `items`.".to_string());
    }
    if items.len() > MAX_ITEMS {
        return Err(format!("{} items is more than the {MAX_ITEMS} one call takes; split the work.", items.len()));
    }
    Ok(items.into_iter().map(|item| clip(&item, MAX_ITEM_CHARS)).collect())
}

/// The top label and its probability from one Jev answer.
fn top_choice(answer: &Value) -> Option<(String, f64)> {
    answer["probabilities"]
        .as_object()?
        .iter()
        .filter_map(|(label, p)| p.as_f64().map(|p| (label.clone(), p)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// Run the agent tool. Errors are for the agent to read.
pub async fn run_agent_tool(args: Option<&Map<String, Value>>, project_root: Option<String>) -> Result<String, String> {
    let Some(source) = AGENT_TOOL.read().unwrap_or_else(|e| e.into_inner()).clone() else {
        return Err("Jev for agents is switched off in Spacron (Settings > AI Providers > Jev decisions).".to_string());
    };
    let args: ToolArgs = serde_json::from_value(Value::Object(args.cloned().unwrap_or_default()))
        .map_err(|e| format!("Invalid arguments: {e}"))?;
    if args.question.trim().is_empty() {
        return Err("`question` is empty.".to_string());
    }
    if args.labels.len() < 2 || args.labels.len() > MAX_LABELS {
        return Err(format!("Give 2-{MAX_LABELS} labels."));
    }
    let root = project_root.map(PathBuf::from);
    let items = collect_items(&args, root.as_deref())?;

    use futures_util::stream::{self, StreamExt};
    // Owned chunks: the server runs this on a spawned task, which cannot hold
    // borrows of `items` across the awaits.
    let outcomes: Vec<ChunkOutcome> = stream::iter(chunk_items(&items))
        .map(|chunk| {
            let source = source.clone();
            let question = args.question.clone();
            let labels = args.labels.clone();
            async move { run_chunk(&source, chunk, &question, &labels).await }
        })
        .buffer_unordered(BATCH_CONCURRENCY)
        .collect()
        .await;

    let mut rows: Vec<(usize, Option<(String, f64)>)> = Vec::with_capacity(items.len());
    let mut failed = 0usize;
    let mut first_error: Option<String> = None;
    let mut tokens = 0u64;
    let mut cost = 0.0f64;
    let mut priced = false;
    let mut requests = 0usize;
    for outcome in outcomes {
        if outcome.not_configured {
            return Err("Jev is not set up: the chosen Jev source has no saved key in Spacron.".to_string());
        }
        tokens += outcome.input_tokens;
        requests += outcome.requests;
        if let Some(c) = outcome.cost_usd {
            cost += c;
            priced = true;
        }
        for (i, result) in outcome.results {
            match result {
                Ok(answer) => rows.push((i, top_choice(&answer))),
                Err(error) => {
                    failed += 1;
                    first_error.get_or_insert(error);
                    rows.push((i, None));
                }
            }
        }
    }
    rows.sort_by_key(|(i, _)| *i);
    record_usage(rows.len() - failed, tokens, priced.then_some(cost));

    let spend = Spend { tokens, cost: priced.then_some(cost), requests };
    Ok(render_report(&items, &rows, &args.labels, failed, first_error.as_deref(), &spend))
}

/// Cut items into request-sized batches: at most `BATCH_SIZE` items and about
/// `BATCH_CHARS` of text each (a single item is never split).
fn chunk_items(items: &[String]) -> Vec<Vec<(usize, String)>> {
    let mut chunks: Vec<Vec<(usize, String)>> = Vec::new();
    let mut current: Vec<(usize, String)> = Vec::new();
    let mut chars = 0usize;
    for (i, item) in items.iter().enumerate() {
        let len = item.chars().count();
        if !current.is_empty() && (current.len() >= BATCH_SIZE || chars + len > BATCH_CHARS) {
            chunks.push(std::mem::take(&mut current));
            chars = 0;
        }
        chars += len;
        current.push((i, item.clone()));
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// What one batch produced: an answer or an error per item.
#[derive(Default)]
struct ChunkOutcome {
    results: Vec<(usize, Result<Value, String>)>,
    input_tokens: u64,
    cost_usd: Option<f64>,
    requests: usize,
    not_configured: bool,
}

fn add_cost(total: &mut Option<f64>, cost: Option<f64>) {
    if let Some(c) = cost {
        *total = Some(total.unwrap_or(0.0) + c);
    }
}

/// Batch errors that mean "this request's shape or size", not "the service is
/// down": the items are retried one per request.
fn batch_rejected(error: &str) -> bool {
    ["HTTP 400", "HTTP 413", "HTTP 422"].iter().any(|code| error.contains(code))
}

async fn run_chunk(source: &str, chunk: Vec<(usize, String)>, question: &str, labels: &HashMap<String, String>) -> ChunkOutcome {
    let mut outcome = ChunkOutcome { requests: 1, ..Default::default() };
    match decide_batch(source, &chunk, question, labels).await {
        Ok(Some(batch)) => {
            outcome.input_tokens = batch.input_tokens;
            outcome.cost_usd = batch.cost_usd;
            for (i, _) in &chunk {
                let result = batch.answers.get(i).cloned().ok_or_else(|| "Jev gave no answer for this item".to_string());
                outcome.results.push((*i, result));
            }
        }
        Ok(None) => outcome.not_configured = true,
        Err(error) if chunk.len() > 1 && batch_rejected(&error) => {
            use futures_util::stream::{self, StreamExt};
            let singles: Vec<(usize, Result<Option<Decision>, String>)> = stream::iter(chunk)
                .map(|(i, item)| async move { (i, decide(source, &item, question, labels).await) })
                .buffer_unordered(BATCH_CONCURRENCY)
                .collect()
                .await;
            for (i, result) in singles {
                outcome.requests += 1;
                match result {
                    Ok(Some(decision)) => {
                        outcome.input_tokens += decision.input_tokens;
                        add_cost(&mut outcome.cost_usd, decision.cost_usd);
                        outcome.results.push((i, Ok(decision.answer)));
                    }
                    Ok(None) => outcome.not_configured = true,
                    Err(e) => outcome.results.push((i, Err(e))),
                }
            }
        }
        Err(error) => {
            for (i, _) in &chunk {
                outcome.results.push((*i, Err(error.clone())));
            }
        }
    }
    outcome
}

/// What a tool call spent, for the last line of its report.
struct Spend {
    tokens: u64,
    cost: Option<f64>,
    requests: usize,
}

fn render_report(
    items: &[String],
    rows: &[(usize, Option<(String, f64)>)],
    labels: &HashMap<String, String>,
    failed: usize,
    first_error: Option<&str>,
    spend: &Spend,
) -> String {
    let mut counts: Vec<(String, usize)> = labels.keys().map(|l| (l.clone(), 0)).collect();
    counts.sort();
    let mut uncertain = 0usize;
    for (_, choice) in rows {
        if let Some((label, p)) = choice {
            if let Some(entry) = counts.iter_mut().find(|(l, _)| l == label) {
                entry.1 += 1;
            }
            if *p < CONFIDENT {
                uncertain += 1;
            }
        }
    }
    let mut out = format!("Classified {} of {} items with Jev.\n\nCounts:\n", rows.len() - failed, items.len());
    for (label, n) in &counts {
        out.push_str(&format!("- {label}: {n}\n"));
    }
    if failed > 0 {
        out.push_str(&format!("- (failed): {failed}; first error: {}\n", first_error.unwrap_or("unknown")));
    }

    let itemize_all = items.len() <= ITEMIZE_ALL_UP_TO;
    out.push_str(if itemize_all {
        "\nItems (#, label, probability, start of item):\n"
    } else {
        "\nUncertain items only (probability below 0.75), (#, label, probability, start of item):\n"
    });
    let mut listed = 0usize;
    for (i, choice) in rows {
        let Some((label, p)) = choice else { continue };
        if !itemize_all && *p >= CONFIDENT {
            continue;
        }
        out.push_str(&format!("{}\t{label}\t{p:.2}\t{}\n", i + 1, clip(&items[*i].replace(['\n', '\t'], " "), 80)));
        listed += 1;
    }
    if listed == 0 {
        out.push_str("(none)\n");
    }
    if !itemize_all {
        out.push_str(&format!("\n{uncertain} of {} items were uncertain.\n", rows.len() - failed));
    }
    out.push_str(&format!(
        "\nJev read {} input tokens in {} request{}{}.",
        spend.tokens,
        spend.requests,
        if spend.requests == 1 { "" } else { "s" },
        spend.cost.map(|c| format!(", cost ${c:.5}")).unwrap_or_default()
    ));
    out
}

// ---------------------------------------------------------------------------
// Usage tally for the agent tool, shown in Settings.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JevUsage {
    pub calls: u64,
    pub items: u64,
    pub input_tokens: u64,
    /// Summed from sources that price their responses (OpenRouter, Vercel).
    pub reported_cost_usd: f64,
}

static USAGE_LOCK: Mutex<()> = Mutex::new(());

fn usage_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("spacron").join("jev-agent-usage.json"))
}

fn record_usage(items: usize, tokens: u64, cost: Option<f64>) {
    let _guard = USAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = usage_path() else { return };
    let mut usage: JevUsage = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    usage.calls += 1;
    usage.items += items as u64;
    usage.input_tokens += tokens;
    usage.reported_cost_usd += cost.unwrap_or(0.0);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&usage) {
        let _ = std::fs::write(&path, text);
    }
}

#[tauri::command]
pub fn jev_agent_usage() -> JevUsage {
    usage_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_jev_sources_are_built_in() {
        assert_eq!(builtin_source("typesafe").map(|s| s.1), Some("jev-latest"));
        assert_eq!(builtin_source("openrouter").map(|s| s.1), Some("jev-latest"));
        assert_eq!(builtin_source("vercel"), Some(("https://ai-gateway.vercel.sh/typesafe/v1/systemone", "typesafe-ai/jev")));
        assert!(builtin_source("openai").is_none());
        assert!(builtin_source("anthropic").is_none());
    }

    #[test]
    fn costs_are_read_from_either_router_shape() {
        assert_eq!(reported_cost(&json!({"usage": {"cost": 0.00003}})), Some(0.00003));
        assert_eq!(reported_cost(&json!({"provider_metadata": {"gateway": {"cost": "0.00001155"}}})), Some(0.00001155));
        assert_eq!(reported_cost(&json!({"usage": {"input_tokens": 5}})), None);
    }

    fn labels() -> HashMap<String, String> {
        [("flaky", "Timing"), ("real", "A bug")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn files_must_exist_inside_the_project() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("fails.txt"), "a\n\n b \nc\n").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        let root = project.path();

        let args = ToolArgs { question: "q".into(), labels: labels(), file: Some("fails.txt".into()), split: None, items: None };
        assert_eq!(collect_items(&args, Some(root)).unwrap(), vec!["a", "b", "c"]);

        let whole = ToolArgs { split: Some("whole".into()), ..args };
        assert_eq!(collect_items(&whole, Some(root)).unwrap().len(), 1);

        let escape = ToolArgs { question: "q".into(), labels: labels(), file: Some("../x/secret.txt".into()), split: None, items: None };
        assert!(collect_items(&escape, Some(root)).is_err());
        let absolute = ToolArgs {
            file: Some(outside.path().join("secret.txt").to_string_lossy().into_owned()),
            ..escape
        };
        assert!(collect_items(&absolute, Some(root)).unwrap_err().contains("inside the project"));
    }

    #[test]
    fn inline_items_are_capped_and_required() {
        let none = ToolArgs { question: "q".into(), labels: labels(), file: None, split: None, items: None };
        assert!(collect_items(&none, None).is_err());
        let many = ToolArgs { items: Some(vec!["x".into(); MAX_INLINE_ITEMS + 1]), ..none };
        assert!(collect_items(&many, None).unwrap_err().contains("in a file"));
    }

    #[test]
    fn report_counts_and_lists_items() {
        let items = vec!["timeout in test_a".to_string(), "assert failed".to_string()];
        let rows = vec![(0, Some(("flaky".to_string(), 0.9))), (1, Some(("real".to_string(), 0.6)))];
        let report = render_report(&items, &rows, &labels(), 0, None, &Spend { tokens: 42, cost: Some(0.00001), requests: 1 });
        assert!(report.contains("- flaky: 1"));
        assert!(report.contains("- real: 1"));
        assert!(report.contains("1\tflaky\t0.90\ttimeout in test_a"));
        assert!(report.contains("42 input tokens in 1 request, cost $0.00001"));
    }

    #[test]
    fn items_are_batched_by_count_and_size() {
        let small: Vec<String> = (0..60).map(|i| format!("item {i}")).collect();
        let chunks = chunk_items(&small);
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), vec![25, 25, 10]);
        assert_eq!(chunks[1][0].0, 25, "indexes stay global across batches");

        let big: Vec<String> = (0..10).map(|_| "x".repeat(4_000)).collect();
        assert!(chunk_items(&big).iter().all(|c| c.iter().map(|(_, t)| t.len()).sum::<usize>() <= BATCH_CHARS));
    }

    #[test]
    fn a_batch_asks_one_question_per_item_against_shared_state() {
        let chunk = vec![(0, "timeout".to_string()), (7, "assert".to_string())];
        let state = batch_state(&chunk);
        assert!(state.contains("<item id=\"1\">\ntimeout\n</item>"));
        assert!(state.contains("<item id=\"8\">\nassert\n</item>"));
        let questions = batch_questions(&chunk, "Flaky?", &labels());
        assert_eq!(questions.as_object().unwrap().len(), 2);
        assert!(questions["item_8"]["instructions"].as_str().unwrap().contains("id=\"8\""));
        assert_eq!(questions["item_1"]["type"], "choice");
    }

    #[test]
    fn only_shape_or_size_errors_fall_back_to_single_requests() {
        assert!(batch_rejected("Jev returned HTTP 400 Bad Request"));
        assert!(batch_rejected("Jev returned HTTP 413 Payload Too Large"));
        assert!(!batch_rejected("Jev returned HTTP 401 Unauthorized"));
        assert!(!batch_rejected("Jev request failed: timed out"));
    }
}
