use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

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
    if let Some((url, model)) = builtin_source(&provider) {
        return classify(url, model, &provider, &state, &question, &labels).await;
    }
    if !super::custom_providers::is_custom_provider(&provider) || known_without_systemone(&provider) {
        return Ok(None);
    }
    let Some(base) = super::custom_providers::base_url(&provider) else { return Ok(None) };
    match classify(&format!("{base}/systemone"), "jev-latest", &provider, &state, &question, &labels).await {
        Err(error) if error.contains("HTTP 404") || error.contains("HTTP 405") => {
            remember_no_systemone(&provider);
            Ok(None)
        }
        other => other,
    }
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

/// Ask the real Jev at `url`, authenticated with `key_provider`'s saved key.
async fn classify(
    url: &str,
    model: &str,
    key_provider: &str,
    state: &str,
    question: &str,
    labels: &HashMap<String, String>,
) -> Result<Option<Value>, String> {
    let Some(api_key) = super::secrets::provider_api_key_get(key_provider.to_string())? else {
        return Ok(None);
    };
    // TypeSafe answers in 70-500 ms; a router in front of it adds a hop.
    let timeout = if key_provider == TYPESAFE { 2_000 } else { 4_000 };
    let client = super::secrets::shared_http_client(Duration::from_millis(timeout))?;
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&json!({
            "state": state,
            "model": model,
            "questions": {
                "classification": {
                    "type": "choice",
                    "instructions": question,
                    "criteria": labels,
                }
            }
        }))
        .send()
        .await
        .map_err(|err| format!("Jev request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Jev returned HTTP {}", response.status()));
    }
    let body: Value = response.json().await.map_err(|err| format!("Invalid Jev response: {err}"))?;
    let answer = body
        .get("answers")
        .and_then(|answers| answers.get("classification"))
        .ok_or_else(|| "Jev response omitted the classification".to_string())?;
    Ok(Some(answer.clone()))
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
}
