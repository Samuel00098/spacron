use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

/// One bounded, optional Choice decision. The renderer never receives the key.
#[tauri::command]
pub async fn jev_classify(
    state: String,
    question: String,
    labels: HashMap<String, String>,
) -> Result<Option<Value>, String> {
    let Some(api_key) = super::secrets::provider_api_key_get("typesafe".to_string())? else {
        return Ok(None);
    };
    if state.trim().is_empty() || question.trim().is_empty() || labels.len() < 2 || labels.len() > 255 {
        return Err("Jev needs state, a question, and 2–255 labels".to_string());
    }

    let client = super::secrets::shared_http_client(Duration::from_millis(2_000))?;
    let response = client
        .post("https://api.typesafe.ai/v1/systemone")
        .bearer_auth(api_key)
        .json(&json!({
            "state": state,
            "model": "jev-latest",
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
